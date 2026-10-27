import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_TYPES,
  GATE_IDS,
  META_MODEL_ID,
  isLegalRunTransition,
  parseRunResult,
  parseStudioEvent,
} from '../../packages/flowproof/src/contracts/index.js'
import type {
  ChatRequest,
  Diagnosis,
  EvidenceBundle,
  EvidenceItem,
  EvidencePhase,
  GateId,
  GateOutcome,
  RunResult,
  RunState,
  StudioEvent,
} from '../../packages/flowproof/src/contracts/index.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import type { EvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { buildEvidenceBundle, createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { RunEventStream } from '../../packages/flowproof/src/studio/events.js'
import { failGate, passGate } from '../../packages/flowproof/src/verify/gates.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempDirectory, git, listTree } from '../support/repoFixture.js'

// T031: the run state machine that T042 implements in `packages/flowproof/src/run.ts`. The
// orchestrator receives its stages as ports (capture, model call, guards, apply/rebuild,
// replay, cleanup), so these tests drive every exit path with in-process fakes that persist
// real sanitized artifacts. The run owns the transitions, the dataset/Canvas oracles, the
// whole-run secret scan, the nine-gate reduction, stage-aware result paths, scenario
// timeouts, phase and total durations, `result.json`, and exactly one cleanup on every exit.

export interface CapturedPhase {
  readonly phase: EvidencePhase
  readonly bundle: EvidenceBundle
  readonly manifestPath: string
  readonly screenshotPath: string
  readonly observed: { readonly dataset: unknown; readonly chart: unknown }
}

export interface ValidatedCandidate {
  readonly target_path: string
  readonly unified_diff: string
  readonly evidence_ids: readonly string[]
}

export interface CandidateValidation {
  readonly diagnosis: Diagnosis | null
  readonly citations: GateOutcome
  readonly scope: GateOutcome
  readonly candidate: ValidatedCandidate | null
}

export interface DiagnosisExchange {
  /** The sanitized prompt actually sent; part of the whole-run secret scan. */
  readonly prompt: unknown
  /** Raw, untrusted transport output. */
  readonly output: unknown
}

export interface WorktreeIntegrityReport {
  readonly unchanged: boolean
  readonly mismatches: readonly string[]
}

export interface RunStageContext {
  readonly runId: string
  readonly scenario: LoadedScenario
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  /** Aborted when the stage's scenario timeout or the total run timeout elapses. */
  readonly signal: AbortSignal
}

export interface RunStagePorts {
  /** `reproducing`: drive the known-bad target and capture the seven-item failure bundle. */
  reproduce(context: RunStageContext): Promise<CapturedPhase>
  /** `diagnosing`: build the prompt and make the single model call. */
  diagnose(context: RunStageContext, failure: CapturedPhase): Promise<DiagnosisExchange>
  /** Citation and patch-scope guards; never applies anything. */
  validate(context: RunStageContext, input: { readonly diagnosis: unknown; readonly failure: CapturedPhase }): Promise<CandidateValidation>
  /** `applying`: apply the validated diff in the worktree and rebuild the patched app. */
  apply(context: RunStageContext, candidate: ValidatedCandidate): Promise<void>
  /** `replaying`: reconnect the target and capture the six-item replay bundle. */
  replay(context: RunStageContext): Promise<CapturedPhase>
  /** Worktree remove/prune, app release, and original-snapshot comparison. Runs once on every exit. */
  cleanup(): Promise<WorktreeIntegrityReport>
}

export interface ExecuteRunOptions {
  readonly request: ChatRequest
  readonly scenario: LoadedScenario
  readonly baseline: { readonly original_head: string; readonly original_status_digest: string }
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  readonly allocator: EvidenceIdAllocator
  readonly ports: RunStagePorts
  /** Seeded markers that must not appear in any artifact, event, prompt, or the result. */
  readonly secretMarkers: readonly string[]
  readonly now?: () => Date
}

export interface RunModule {
  executeRun(options: ExecuteRunOptions): Promise<RunResult>
}

const runModule = (): Promise<RunModule> => loadPendingModule<RunModule>('packages/flowproof/src/run.ts', 'T042', ['executeRun'])

type Stage = 'reproduce' | 'diagnose' | 'validate' | 'apply' | 'replay' | 'cleanup'

const MARKER = 'FLOWPROOF-RUN-MARKER-5d0c2a9e'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const HAPPY_PHASES: readonly RunState[] = ['reproducing', 'failure_captured', 'diagnosing', 'candidate_validated', 'applying', 'replaying']
const RECORDED = loadRecordedHeroResponse() as Diagnosis
const HERO = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })
const EXPECTED_ROWS = HERO.oracle.dataset
const EXPECTED_CHART = HERO.oracle.chart
const KNOWN_BAD_ROWS = [
  ...EXPECTED_ROWS,
  ...EXPECTED_ROWS.map((row) => ({ ...row, region: 'Northeast' })),
]
const KNOWN_BAD_CHART = {
  bar_count: 8,
  labels: [...EXPECTED_CHART.labels, ...EXPECTED_CHART.labels],
  values: [...EXPECTED_CHART.values, ...EXPECTED_CHART.values],
}
const BASELINE = { original_head: 'b'.repeat(40), original_status_digest: 'c'.repeat(64) }

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function withTimeouts(overrides: Partial<LoadedScenario['scenario']['timeouts']>): LoadedScenario {
  return { ...HERO, scenario: { ...HERO.scenario, timeouts: { ...HERO.scenario.timeouts, ...overrides } } }
}

/** Persists a contract-valid phase bundle exactly as the capture stage would. */
async function capturePhase(
  context: RunStageContext,
  phase: EvidencePhase,
  observed: CapturedPhase['observed'],
  consoleText = 'No console errors.',
): Promise<CapturedPhase> {
  const items: EvidenceItem[] = []
  let screenshotPath = ''
  for (const type of EVIDENCE_TYPES.filter((candidate) => phase === 'failure' || candidate !== 'source')) {
    const id = context.allocator.allocate(phase, type)
    const artifactPath = `evidence/${phase}/${type}.${type === 'screenshot' ? 'png' : 'json'}`
    const content =
      type === 'dataset'
        ? { expected: EXPECTED_ROWS, observed: observed.dataset }
        : type === 'chart'
          ? { observed: observed.chart }
          : type === 'console'
            ? { entries: [{ level: 'error', text: consoleText }] }
            : { type }
    const persisted = type === 'screenshot' ? await context.store.writePng(artifactPath, PNG) : await context.store.writeJson(artifactPath, content)
    context.store.register(id, persisted)
    if (type === 'screenshot') screenshotPath = artifactPath
    items.push({
      evidence_id: id,
      run_id: context.runId,
      phase,
      type,
      captured_at: '2026-10-28T00:00:00.000Z',
      artifact_path: artifactPath,
      sha256: persisted.sha256,
      summary: `Sanitized ${type} evidence.`,
      provenance: {
        mechanism: 'test-double',
        origin: type === 'actions' ? 'scenario' : type === 'source' ? 'repository' : 'browser',
        trusted: true,
        source_path: type === 'source' ? 'apps/demo-chart/src/filterData.ts' : null,
      },
      redactions: [...persisted.redactions],
    })
  }
  const bundle = buildEvidenceBundle({ runId: context.runId, scenarioId: HERO.scenario.scenario_id, phase, items })
  const manifestPath = `evidence/${phase}/manifest.json`
  context.store.register(phase === 'failure' ? 'failure-manifest' : 'replay-manifest', await context.store.writeJson(manifestPath, bundle))
  return { phase, bundle, manifestPath, screenshotPath, observed }
}

const CANDIDATE: ValidatedCandidate = {
  target_path: 'apps/demo-chart/src/filterData.ts',
  unified_diff: RECORDED.candidate.unified_diff,
  evidence_ids: RECORDED.candidate.evidence_ids,
}

const validValidation = (): CandidateValidation => ({
  diagnosis: structuredClone(RECORDED),
  citations: passGate('citations_valid', { evidence_ids: ['ev_failure_dataset_001', 'ev_failure_chart_001', 'ev_failure_source_001'] }),
  scope: passGate('patch_scope_valid', { evidence_ids: ['ev_failure_source_001'] }),
  candidate: CANDIDATE,
})

/** Waits until the stage is cancelled, then rejects, as a cooperative hung stage does. */
const hangUntilAborted = (context: RunStageContext): Promise<never> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new Error('stage aborted'))
    if (context.signal.aborted) abort()
    else context.signal.addEventListener('abort', abort, { once: true })
  })

interface Harness {
  readonly calls: Stage[]
  readonly contexts: Partial<Record<Stage, RunStageContext>>
  readonly runRoot: string
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  readonly request: ChatRequest
  clock: number
}

type PortOverrides = { [K in Stage]?: (harness: Harness, ...args: Parameters<RunStagePorts[K]>) => ReturnType<RunStagePorts[K]> }

interface RunOutcome {
  readonly result: RunResult
  readonly harness: Harness
  readonly events: readonly StudioEvent[]
}

async function execute(
  options: { readonly ports?: PortOverrides; readonly scenario?: LoadedScenario; readonly fakeClock?: boolean } = {},
): Promise<RunOutcome> {
  const { executeRun } = await runModule()
  const repo = await createTempDirectory('flowproof-run-')
  cleanups.push(repo.remove)
  git(repo.path, 'init', '--quiet')
  await writeFile(path.join(repo.path, '.gitignore'), '.flowproof/\n')
  const runId = randomUUID()
  const store = await createRunArtifactStore({ repoRoot: repo.path, runId })
  const events = createRunEventStream({ runId, registry: store })
  const request: ChatRequest = {
    request_id: randomUUID(),
    session_id: randomUUID(),
    run_id: runId,
    created_at: '2026-10-28T00:00:00.000Z',
    text: 'Find the incorrect Canvas filtering behavior and verify the fix.',
    scenario_id: HERO.scenario.scenario_id,
  }
  const harness: Harness = {
    calls: [],
    contexts: {},
    runRoot: path.join(repo.path, '.flowproof', 'runs', runId),
    store,
    events,
    request,
    clock: Date.parse('2026-10-28T00:00:00.000Z'),
  }
  const overrides = options.ports ?? {}
  const advance = (ms: number): void => {
    if (options.fakeClock) harness.clock += ms
  }
  const ports: RunStagePorts = {
    async reproduce(context) {
      harness.calls.push('reproduce')
      harness.contexts.reproduce = context
      if (overrides.reproduce) return overrides.reproduce(harness, context)
      advance(1_000)
      return capturePhase(context, 'failure', { dataset: KNOWN_BAD_ROWS, chart: KNOWN_BAD_CHART })
    },
    async diagnose(context, failure) {
      harness.calls.push('diagnose')
      harness.contexts.diagnose = context
      if (overrides.diagnose) return overrides.diagnose(harness, context, failure)
      advance(2_000)
      return { prompt: { goal: request.text, evidence: failure.bundle.items.map((item) => item.evidence_id) }, output: structuredClone(RECORDED) }
    },
    async validate(context, input) {
      harness.calls.push('validate')
      harness.contexts.validate = context
      if (overrides.validate) return overrides.validate(harness, context, input)
      return validValidation()
    },
    async apply(context, candidate) {
      harness.calls.push('apply')
      harness.contexts.apply = context
      if (overrides.apply) return overrides.apply(harness, context, candidate)
      expect(candidate).toEqual(CANDIDATE)
      advance(3_000)
    },
    async replay(context) {
      harness.calls.push('replay')
      harness.contexts.replay = context
      if (overrides.replay) return overrides.replay(harness, context)
      advance(4_000)
      return capturePhase(context, 'replay', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) })
    },
    async cleanup() {
      harness.calls.push('cleanup')
      if (overrides.cleanup) return overrides.cleanup(harness)
      advance(500)
      return { unchanged: true, mismatches: [] }
    },
  }

  const run = executeRun({
    request,
    scenario: options.scenario ?? HERO,
    baseline: BASELINE,
    store,
    events,
    allocator: createEvidenceIdAllocator(runId),
    ports,
    secretMarkers: [MARKER],
    ...(options.fakeClock ? { now: () => new Date(harness.clock) } : {}),
  })
  // A run that ignores its own timeouts fails here with a clear message instead of hanging.
  const result = await Promise.race([
    run,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('executeRun did not finalize within 10 seconds.')), 10_000).unref(),
    ),
  ])
  return { result, harness, events: events.events() }
}

const gate = (result: RunResult, gateId: GateId): GateOutcome => {
  const found = result.gates.find((candidate) => candidate.gate_id === gateId)
  if (!found) throw new Error(`The result has no ${gateId} gate.`)
  return found
}

const phaseTrace = (events: readonly StudioEvent[]): RunState[] =>
  events.filter((event) => event.type === 'phase_started').map((event) => event.phase as RunState)

/** Invariants every finalized run satisfies, whatever its exit path. */
async function expectFinalized(outcome: RunOutcome): Promise<void> {
  const { result, harness, events } = outcome

  // A contract-valid result with all nine outcomes in canonical order.
  const parsed = parseRunResult(result)
  expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error.issues)).toBe(true)
  expect(result.schema_version).toBe(CONTRACT_SCHEMA_VERSION)
  expect(result.gates.map((outcome_) => outcome_.gate_id)).toEqual([...GATE_IDS])
  expect(result.failed_gate_ids).toEqual(result.gates.filter((entry) => entry.status !== 'pass').map((entry) => entry.gate_id))
  expect(result).toMatchObject({
    run_id: harness.request.run_id,
    request_id: harness.request.request_id,
    scenario_id: 'canvas-filter-hero',
    case: 'hero',
    ...BASELINE,
    provider: { mode: 'meta', model: META_MODEL_ID, injected_fault_label: null },
  })

  // Exactly one cleanup, after every other stage.
  expect(harness.calls.filter((stage) => stage === 'cleanup')).toHaveLength(1)
  expect(harness.calls.at(-1)).toBe('cleanup')

  // result.json is always written and is the returned result.
  const resultBytes = await readFile(path.join(harness.runRoot, 'result.json'))
  expect(JSON.parse(resultBytes.toString('utf8'))).toEqual(result)
  await expect(harness.store.read('result')).resolves.toEqual(resultBytes)

  // Ordered, legal, contract-valid activity that ends with one final event.
  for (const event of events) expect(parseStudioEvent(event).ok).toBe(true)
  expect(events.filter((event) => event.type === 'run_finalized')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: 'run_finalized', phase: 'finalized' })
  const trace: RunState[] = ['initialized', ...phaseTrace(events), 'finalized']
  for (let index = 1; index < trace.length; index += 1) {
    const from = trace[index - 1] as RunState
    const to = trace[index] as RunState
    expect(isLegalRunTransition(from, to), `${from} -> ${to}`).toBe(true)
  }
  if (result.status === 'Verified Fix') expect(trace.at(-2)).toBe('replaying')

  // Every gate update the Studio saw agrees with the authoritative result.
  for (const outcome_ of result.gates) {
    const updates = events.filter((event) => event.type === 'gate_updated' && event.gate?.gate_id === outcome_.gate_id)
    expect(updates.length, outcome_.gate_id).toBeGreaterThan(0)
    expect(updates.at(-1)?.gate).toEqual({ gate_id: outcome_.gate_id, status: outcome_.status, reason_code: outcome_.reason_code })
  }

  // Paths are relative to the run directory and exist exactly for the phases reached.
  for (const field of ['diagnosis_path', 'candidate_diff_path', 'failure_screenshot_path', 'replay_screenshot_path'] as const) {
    const relative = result[field]
    if (relative !== null) await expect(readFile(path.join(harness.runRoot, relative))).resolves.toBeInstanceOf(Buffer)
  }
  // The total spans the whole run and covers every phase.
  expect(Math.abs(result.total_duration_ms - (Date.parse(result.completed_at) - Date.parse(result.started_at)))).toBeLessThanOrEqual(5)
  const phases = result.phase_durations_ms
  expect(result.total_duration_ms).toBeGreaterThanOrEqual(phases.capture + phases.model + phases.apply + phases.replay + phases.finalize)
}

const expectUnevaluable = (result: RunResult, gateIds: readonly GateId[]): void => {
  for (const gateId of gateIds) expect(gate(result, gateId).status, gateId).toBe('unevaluable')
}

const expectNonPass = (result: RunResult, gateId: GateId): GateOutcome => {
  const outcome = gate(result, gateId)
  expect(['fail', 'unevaluable'], gateId).toContain(outcome.status)
  return outcome
}

describe('run state machine: the closed loop', () => {
  it('walks every legal state in order and grants Verified Fix only when all nine gates pass', async () => {
    const outcome = await execute()
    await expectFinalized(outcome)
    const { result, harness, events } = outcome

    expect(harness.calls).toEqual(['reproduce', 'diagnose', 'validate', 'apply', 'replay', 'cleanup'])
    expect(phaseTrace(events)).toEqual(HAPPY_PHASES)
    expect(result.status).toBe('Verified Fix')
    expect(result.failed_gate_ids).toEqual([])
    expect(result.gates.every((entry) => entry.status === 'pass')).toBe(true)
    expect(result.failure_screenshot_path).toBe('evidence/failure/screenshot.png')
    expect(result.replay_screenshot_path).toBe('evidence/replay/screenshot.png')
    // The validated candidate and the strict-schema diagnosis are persisted for the Proof Trail.
    expect(await readFile(path.join(harness.runRoot, result.candidate_diff_path ?? ''), 'utf8')).toBe(CANDIDATE.unified_diff)
    expect(JSON.parse(await readFile(path.join(harness.runRoot, result.diagnosis_path ?? ''), 'utf8'))).toEqual(RECORDED)
  })

  it('announces every captured Evidence ID exactly once', async () => {
    const { events, harness } = await execute()
    const announced = events.filter((event) => event.type === 'evidence_added').flatMap((event) => event.evidence_ids)
    const failure = EVIDENCE_TYPES.map((type) => `ev_failure_${type}_001`)
    const replay = EVIDENCE_TYPES.filter((type) => type !== 'source').map((type) => `ev_replay_${type}_001`)

    expect([...announced].sort()).toEqual([...failure, ...replay].sort())
    for (const id of announced) expect(harness.store.hasEvidence(id)).toBe(true)
  })

  it('records exact phase durations and the total duration from its clock', async () => {
    const { result } = await execute({ fakeClock: true })

    expect(result.phase_durations_ms).toMatchObject({ capture: 1_000, model: 2_000, apply: 3_000, replay: 4_000 })
    expect(result.phase_durations_ms.finalize).toBeGreaterThanOrEqual(500)
    expect(result.started_at).toBe('2026-10-28T00:00:00.000Z')
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(10_500)
  })

  it('hands every stage the run, scenario, store, and allocator it owns', async () => {
    const { harness } = await execute()

    for (const stage of ['reproduce', 'diagnose', 'validate', 'apply', 'replay'] as const) {
      const context = harness.contexts[stage]
      expect(context, stage).toBeDefined()
      expect(context?.runId).toBe(harness.request.run_id)
      expect(context?.scenario.scenario.scenario_id).toBe('canvas-filter-hero')
      expect(context?.store).toBe(harness.store)
      expect(context?.signal).toBeInstanceOf(AbortSignal)
    }
  })
})

describe('run state machine: direct fail-closed finalization', () => {
  it('finalizes from reproducing without inventing failure artifacts when capture fails', async () => {
    const outcome = await execute({
      ports: {
        reproduce: async () => {
          throw new Error('The target frame did not load.')
        },
      },
    })
    await expectFinalized(outcome)
    const { result, harness, events } = outcome

    expect(harness.calls).toEqual(['reproduce', 'cleanup'])
    expect(phaseTrace(events)).toEqual(['reproducing'])
    expect(result.status).toBe('Unverified')
    expectNonPass(result, 'failure_reproduced')
    expectNonPass(result, 'evidence_complete')
    expectUnevaluable(result, ['citations_valid', 'patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches'])
    expect(gate(result, 'secret_scan_clean').status).toBe('pass')
    expect(gate(result, 'original_worktree_unchanged').status).toBe('pass')
    expect(result).toMatchObject({
      diagnosis_path: null,
      candidate_diff_path: null,
      failure_screenshot_path: null,
      replay_screenshot_path: null,
    })
    // Nothing from a phase that was never reached: no evidence, diagnosis, or candidate files.
    expect((await listTree(harness.runRoot)).filter((entry) => entry !== 'result.json' && !entry.startsWith('.'))).not.toContainEqual(
      expect.stringMatching(/^evidence|diagnosis|candidate|screenshot/),
    )
    expect(result.phase_durations_ms).toMatchObject({ model: 0, apply: 0, replay: 0 })
  })

  it('stops before the model when the known-bad defect does not reproduce', async () => {
    const outcome = await execute({
      ports: {
        reproduce: async (_harness, context) =>
          capturePhase(context, 'failure', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) }),
      },
    })
    await expectFinalized(outcome)
    const { result, harness } = outcome

    expect(harness.calls).toEqual(['reproduce', 'cleanup'])
    expect(gate(result, 'failure_reproduced')).toMatchObject({ status: 'fail', reason_code: 'FAILURE_NOT_REPRODUCED' })
    expectUnevaluable(result, ['citations_valid', 'patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches'])
    expect(result.failure_screenshot_path).toBe('evidence/failure/screenshot.png')
    expect(result).toMatchObject({ diagnosis_path: null, candidate_diff_path: null, replay_screenshot_path: null })
  })

  it('finalizes from diagnosing when the provider fails', async () => {
    const outcome = await execute({
      ports: {
        diagnose: async () => {
          throw new Error('PROVIDER_HTTP_ERROR: 503')
        },
      },
    })
    await expectFinalized(outcome)
    const { result, harness, events } = outcome

    expect(harness.calls).toEqual(['reproduce', 'diagnose', 'cleanup'])
    expect(phaseTrace(events)).toEqual(['reproducing', 'failure_captured', 'diagnosing'])
    expect(gate(result, 'failure_reproduced').status).toBe('pass')
    expect(gate(result, 'evidence_complete').status).toBe('pass')
    expectNonPass(result, 'citations_valid')
    expectUnevaluable(result, ['patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches'])
    expect(result.failure_screenshot_path).toBe('evidence/failure/screenshot.png')
    expect(result).toMatchObject({ diagnosis_path: null, candidate_diff_path: null, replay_screenshot_path: null })
  })

  it.each([
    [
      'an invalid citation',
      (): CandidateValidation => ({
        ...validValidation(),
        citations: failGate('citations_valid', 'CITATION_UNKNOWN_EVIDENCE_ID'),
        candidate: null,
      }),
    ],
    [
      'an unsafe patch',
      (): CandidateValidation => ({
        ...validValidation(),
        scope: failGate('patch_scope_valid', 'PATCH_TARGET_NOT_PERMITTED'),
        candidate: null,
      }),
    ],
  ])('rejects %s before any apply', async (_label, validation) => {
    const rejected = validation()
    const outcome = await execute({ ports: { validate: async () => rejected } })
    await expectFinalized(outcome)
    const { result, harness, events } = outcome

    expect(harness.calls).toEqual(['reproduce', 'diagnose', 'validate', 'cleanup'])
    expect(phaseTrace(events)).toEqual(['reproducing', 'failure_captured', 'diagnosing'])
    expect(gate(result, 'citations_valid')).toMatchObject({ status: rejected.citations.status, reason_code: rejected.citations.reason_code })
    expect(gate(result, 'patch_scope_valid')).toMatchObject({ status: rejected.scope.status, reason_code: rejected.scope.reason_code })
    expectUnevaluable(result, ['patch_applied', 'dataset_matches', 'canvas_matches'])
    // The schema-valid diagnosis was obtained and is kept; no candidate passed validation.
    expect(result.diagnosis_path).not.toBeNull()
    expect(result).toMatchObject({ candidate_diff_path: null, replay_screenshot_path: null })
  })

  it('finalizes from applying when the candidate does not apply or rebuild', async () => {
    const outcome = await execute({
      ports: {
        apply: async () => {
          throw new Error('WORKTREE_BUILD_FAILED')
        },
      },
    })
    await expectFinalized(outcome)
    const { result, harness, events } = outcome

    expect(harness.calls).toEqual(['reproduce', 'diagnose', 'validate', 'apply', 'cleanup'])
    expect(phaseTrace(events)).toEqual(['reproducing', 'failure_captured', 'diagnosing', 'candidate_validated', 'applying'])
    expect(gate(result, 'patch_applied').status).toBe('fail')
    expectUnevaluable(result, ['dataset_matches', 'canvas_matches'])
    expect(result.candidate_diff_path).not.toBeNull()
    expect(result.replay_screenshot_path).toBeNull()
  })

  it('finalizes from replaying when the replay cannot be captured', async () => {
    const outcome = await execute({
      ports: {
        replay: async () => {
          throw new Error('The patched target frame did not reconnect.')
        },
      },
    })
    await expectFinalized(outcome)
    const { result, harness } = outcome

    expect(harness.calls).toEqual(['reproduce', 'diagnose', 'validate', 'apply', 'replay', 'cleanup'])
    expect(gate(result, 'patch_applied').status).toBe('pass')
    expectNonPass(result, 'dataset_matches')
    expectNonPass(result, 'canvas_matches')
    expect(result.replay_screenshot_path).toBeNull()
    expect(result.status).toBe('Unverified')
  })

  it('keeps a replay that still shows the defect Unverified with the failed oracle gates', async () => {
    const outcome = await execute({
      ports: { replay: async (_harness, context) => capturePhase(context, 'replay', { dataset: KNOWN_BAD_ROWS, chart: KNOWN_BAD_CHART }) },
    })
    await expectFinalized(outcome)
    const { result } = outcome

    expect(result.status).toBe('Unverified')
    expect(gate(result, 'dataset_matches')).toMatchObject({ status: 'fail', reason_code: 'DATASET_MISMATCH' })
    expect(gate(result, 'canvas_matches')).toMatchObject({ status: 'fail', reason_code: 'CANVAS_BAR_COUNT_MISMATCH' })
    expect(result.replay_screenshot_path).toBe('evidence/replay/screenshot.png')
  })

  it('fails closed when a stage throws a non-Error value', async () => {
    const outcome = await execute({
      ports: {
        validate: async () => {
          throw 'guard crashed' as unknown as Error
        },
      },
    })
    await expectFinalized(outcome)
    const { result } = outcome

    expect(result.status).toBe('Unverified')
    expectNonPass(result, 'citations_valid')
    expectNonPass(result, 'patch_scope_valid')
    expectUnevaluable(result, ['patch_applied', 'dataset_matches', 'canvas_matches'])
  })
})

describe('run state machine: integrity and secret gates', () => {
  it('reports an original-worktree mismatch found at cleanup even after every other gate passed', async () => {
    const outcome = await execute({ ports: { cleanup: async () => ({ unchanged: false, mismatches: ['status'] }) } })
    await expectFinalized(outcome)
    const { result } = outcome

    expect(result.status).toBe('Unverified')
    expect(result.failed_gate_ids).toEqual(['original_worktree_unchanged'])
    expect(gate(result, 'original_worktree_unchanged').status).toBe('fail')
  })

  it('still writes a result when cleanup itself fails', async () => {
    const outcome = await execute({
      ports: {
        cleanup: async () => {
          throw new Error('git worktree remove failed')
        },
      },
    })
    await expectFinalized(outcome)
    const { result } = outcome

    expect(result.status).toBe('Unverified')
    expectNonPass(result, 'original_worktree_unchanged')
  })

  it('fails the secret-scan gate when a seeded marker reaches a persisted artifact', async () => {
    const outcome = await execute({
      ports: {
        reproduce: async (_harness, context) =>
          capturePhase(context, 'failure', { dataset: KNOWN_BAD_ROWS, chart: KNOWN_BAD_CHART }, `leaked ${MARKER}`),
      },
    })
    await expectFinalized(outcome)
    const { result, events } = outcome

    expect(result.status).toBe('Unverified')
    expect(gate(result, 'secret_scan_clean').status).toBe('fail')
    // The scan reports the leak without repeating it.
    expect(JSON.stringify(result)).not.toContain(MARKER)
    expect(JSON.stringify(events)).not.toContain(MARKER)
  })

  it('fails the secret-scan gate when a seeded marker reaches the model prompt', async () => {
    const outcome = await execute({
      ports: { diagnose: async () => ({ prompt: { goal: `goal ${MARKER}` }, output: structuredClone(RECORDED) }) },
    })
    await expectFinalized(outcome)

    expect(outcome.result.status).toBe('Unverified')
    expect(gate(outcome.result, 'secret_scan_clean').status).toBe('fail')
  })
})

describe('run state machine: scenario timeouts', () => {
  it.each([
    ['capture_ms', 'reproduce', ['failure_reproduced'], ['citations_valid', 'patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches']],
    ['model_ms', 'diagnose', ['citations_valid'], ['patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches']],
    ['replay_ms', 'apply', ['patch_applied'], ['dataset_matches', 'canvas_matches']],
    ['replay_ms', 'replay', ['dataset_matches', 'canvas_matches'], []],
  ] as const)('enforces %s on the %s stage and cancels it', async (timeout, stage, affected, downstream) => {
    const startedAt = Date.now()
    const outcome = await execute({
      scenario: withTimeouts({ [timeout]: 40 }),
      ports: { [stage]: (_harness: Harness, context: RunStageContext) => hangUntilAborted(context) } as PortOverrides,
    })
    await expectFinalized(outcome)
    const { result, harness } = outcome

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(harness.contexts[stage]?.signal.aborted).toBe(true)
    expect(result.status).toBe('Unverified')
    // The timed-out stage's gate reports the timeout; nothing downstream ran or was evaluated.
    const reasons = affected.map((gateId) => expectNonPass(result, gateId).reason_code)
    expect(reasons.some((reason) => /TIMEOUT/.test(reason)), reasons.join(', ')).toBe(true)
    expectUnevaluable(result, downstream)
    expect(harness.calls.slice(harness.calls.indexOf(stage) + 1)).toEqual(['cleanup'])
  })

  it('enforces the total run timeout across stages', async () => {
    const pause = (context: RunStageContext, ms: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('stage aborted'))
        })
      })
    const outcome = await execute({
      scenario: withTimeouts({ total_ms: 60 }),
      ports: {
        reproduce: async (_harness, context) => {
          await pause(context, 40)
          return capturePhase(context, 'failure', { dataset: KNOWN_BAD_ROWS, chart: KNOWN_BAD_CHART })
        },
        diagnose: async (_harness, context) => {
          await pause(context, 40)
          return { prompt: {}, output: structuredClone(RECORDED) }
        },
        apply: async (_harness, context) => pause(context, 40),
      },
    })
    await expectFinalized(outcome)
    const { result } = outcome

    expect(result.status).toBe('Unverified')
    expect(result.gates.some((entry) => /TIMEOUT/.test(entry.reason_code))).toBe(true)
    expect(outcome.harness.calls).not.toContain('replay')
  })
})
