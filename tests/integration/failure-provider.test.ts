import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CapturedPhase } from '../../packages/flowproof/src/capture/browserCapture.js'
import { EVIDENCE_TYPES, GATE_IDS, parseDiagnosis, parseRunResult, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import type { ChatRequest, Diagnosis, EvidenceItem, EvidencePhase, GateId, StudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { buildEvidenceBundle, createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { DiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import { ModelTransportError, TransportSelectionError, selectTransport } from '../../packages/flowproof/src/model/transport.js'
import type { ModelTransport } from '../../packages/flowproof/src/model/transport.js'
import { validateCandidate } from '../../packages/flowproof/src/patch/validateDiff.js'
import { executeRun } from '../../packages/flowproof/src/run.js'
import type { RunStageContext, RunStagePorts } from '../../packages/flowproof/src/run.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { LAUNCH_COOKIE_NAME } from '../../packages/flowproof/src/studio/auth.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import { startStudioServer } from '../../packages/flowproof/src/studio/server.js'
import type { StudioRunHandle, StudioRunStart } from '../../packages/flowproof/src/studio/server.js'
import { REPO_ROOT, createTempClone, createTempDirectory, git, listTree } from '../support/repoFixture.js'

// T056: the labeled fixture provider of the Failure case. Ordinary selection resolves the committed
// `canvas-filter-failure-invalid-citation` scenario to a fixture transport that replays the
// committed evaluation fixture: it never selects or calls the live Meta transport, needs no
// MODEL_API_KEY, and is labeled as an injected fault in the run's events and result. Its output is
// untrusted: the existing strict parse and citation guard reject the nonexistent Evidence ID at
// `citations_valid` before any patch application, so the run finalizes `Unverified` without apply
// or replay artifacts and without echoing the fixture's text.

const FAILURE_ID = 'canvas-filter-failure-invalid-citation'
const SOURCE = 'apps/demo-chart/src/filterData.ts'
const FIXTURE_PATH = 'scenarios/canvas-filter/provider-fixtures/invalid-citation.json'
const FAULT_LABEL = 'Injected evaluation fixture: nonexistent Evidence ID'
const NONEXISTENT_ID = 'ev_failure_chart_999'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'
const MARKER = 'FLOWPROOF-FAILURE-MARKER-7c1e04b2'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const BASELINE = { original_head: 'b'.repeat(40), original_status_digest: 'c'.repeat(64) }

const FAILURE = await loadScenario(FAILURE_ID, { repoRoot: REPO_ROOT })
const COMMITTED_FIXTURE = JSON.parse(await readFile(path.join(REPO_ROOT, FIXTURE_PATH), 'utf8')) as Diagnosis
const PROMPT: DiagnosisPrompt = {
  instructions: 'synthetic',
  input: { developer_goal: GOAL, failure_evidence: [], permitted_source: { path: SOURCE, evidence_id: 'ev_failure_source_001', content: '' } },
}
/** Every free-text value of the fixture: none may surface in an event or the result. */
const FIXTURE_TEXTS = [
  COMMITTED_FIXTURE.summary,
  COMMITTED_FIXTURE.root_cause,
  ...COMMITTED_FIXTURE.claims.map((claim) => claim.text),
  COMMITTED_FIXTURE.candidate.unified_diff,
  NONEXISTENT_ID,
]

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

/** Runs `work` while `process.env` answers MODEL_API_KEY as absent; the real value is never read. */
async function withoutModelKey<T>(work: () => Promise<T>): Promise<T> {
  const realEnv = process.env
  process.env = new Proxy(realEnv, {
    get: (target, name) => (name === 'MODEL_API_KEY' ? undefined : Reflect.get(target, name)),
    has: (target, name) => name !== 'MODEL_API_KEY' && Reflect.has(target, name),
    getOwnPropertyDescriptor: (target, name) => (name === 'MODEL_API_KEY' ? undefined : Reflect.getOwnPropertyDescriptor(target, name)),
    ownKeys: (target) => Reflect.ownKeys(target).filter((name) => name !== 'MODEL_API_KEY'),
  })
  try {
    return await work()
  } finally {
    process.env = realEnv
  }
}

function selectionError(select: () => unknown): TransportSelectionError {
  let caught: unknown
  try {
    select()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(TransportSelectionError)
  return caught as TransportSelectionError
}

const forbidNetwork = () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The fixture provider must make no network request.'))

describe('fixture provider selection', () => {
  it('resolves the committed Failure case to a credential-free fixture transport instead of Meta', () => {
    const transport = selectTransport(FAILURE.scenario)

    expect(transport.model).toBeNull()
    expect(Object.isFrozen(transport)).toBe(true)
    for (const env of [{}, { MODEL_API_KEY: '' }, { MODEL_API_KEY: undefined }]) {
      expect(transport.checkReadiness(env)).toEqual({ ready: true })
    }
  })

  it('replays a detached copy of the committed fixture with no key and no network request', async () => {
    const fetchSpy = forbidNetwork()
    const transport = await withoutModelKey(async () => selectTransport(FAILURE.scenario))
    const diagnose = (): Promise<unknown> =>
      withoutModelKey(() => transport.diagnose(PROMPT, { signal: new AbortController().signal, timeoutMs: FAILURE.scenario.timeouts.model_ms }))

    const first = await diagnose()
    expect(first).toEqual(COMMITTED_FIXTURE)
    ;(first as { summary: string }).summary = 'mutated by the engine'
    expect(await diagnose()).toEqual(COMMITTED_FIXTURE)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honors cancellation before answering', async () => {
    const transport = selectTransport(FAILURE.scenario)
    const controller = new AbortController()
    controller.abort()

    const attempt = transport.diagnose(PROMPT, { signal: controller.signal, timeoutMs: 1 })
    await expect(attempt).rejects.toBeInstanceOf(ModelTransportError)
    await expect(attempt).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' })
  })

  it('serves only the fixture of a scenario loaded from the committed registry', async () => {
    // Contract-valid copies carry the same fixture path as data, but no loaded committed fixture.
    const parsedCopy = parseScenario(JSON.parse(await readFile(path.join(REPO_ROOT, FAILURE.scenarioPath), 'utf8')))
    if (!parsedCopy.ok) throw new Error('The committed Failure scenario is invalid.')

    for (const copy of [parsedCopy.value, structuredClone(FAILURE.scenario)]) {
      expect(selectionError(() => selectTransport(copy)).code).toBe('TRANSPORT_PROVIDER_UNAVAILABLE')
    }
  })
})

// ---------------------------------------------------------------------------------------
// The Failure run: fixture diagnosis, real guards, no apply or replay
// ---------------------------------------------------------------------------------------

/** Persists the contract-valid seven-item known-bad failure bundle, as the capture stage does. */
async function captureFailure(context: RunStageContext): Promise<CapturedPhase> {
  const phase: EvidencePhase = 'failure'
  const { dataset: expected, chart } = FAILURE.oracle
  const observed = {
    dataset: [...expected, ...expected.map((row) => ({ ...row, region: 'Northeast' }))],
    chart: { bar_count: chart.bar_count * 2, labels: [...chart.labels, ...chart.labels], values: [...chart.values, ...chart.values] },
  }
  const items: EvidenceItem[] = []
  let screenshotPath = ''
  for (const type of EVIDENCE_TYPES) {
    const id = context.allocator.allocate(phase, type)
    const artifactPath = `evidence/${phase}/${type}.${type === 'screenshot' ? 'png' : 'json'}`
    const content = type === 'dataset' ? { expected, observed: observed.dataset } : type === 'chart' ? { observed: observed.chart } : { type }
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
        source_path: type === 'source' ? SOURCE : null,
      },
      redactions: [...persisted.redactions],
    })
  }
  const bundle = buildEvidenceBundle({ runId: context.runId, scenarioId: FAILURE_ID, phase, items })
  const manifestPath = `evidence/${phase}/manifest.json`
  context.store.register('failure-manifest', await context.store.writeJson(manifestPath, bundle))
  return { phase, bundle, manifestPath, screenshotPath, observed }
}

interface FailureRun {
  readonly calls: readonly string[]
  readonly checkout: string
  readonly runRoot: string
  readonly events: readonly StudioEvent[]
  readonly result: Awaited<ReturnType<typeof executeRun>>
}

/**
 * Runs the Failure case through `executeRun` with the ordinarily selected transport and the real
 * candidate guards against a checkout of the committed permitted source. Apply and replay throw
 * if they are ever reached.
 */
async function runFailureCase(transport: ModelTransport): Promise<FailureRun> {
  const checkout = await createTempDirectory('flowproof-failure-run-')
  cleanups.push(checkout.remove)
  git(checkout.path, 'init', '--quiet')
  await writeFile(path.join(checkout.path, '.gitignore'), '.flowproof/\n')
  await mkdir(path.dirname(path.join(checkout.path, SOURCE)), { recursive: true })
  await writeFile(path.join(checkout.path, SOURCE), git(REPO_ROOT, 'show', `HEAD:${SOURCE}`))

  const runId = randomUUID()
  const store = await createRunArtifactStore({ repoRoot: checkout.path, runId })
  const events = createRunEventStream({ runId, registry: store })
  const request: ChatRequest = {
    request_id: randomUUID(),
    session_id: randomUUID(),
    run_id: runId,
    created_at: '2026-10-28T00:00:00.000Z',
    text: GOAL,
    scenario_id: FAILURE_ID,
  }
  const calls: string[] = []
  const ports: RunStagePorts = {
    async reproduce(context) {
      calls.push('reproduce')
      return captureFailure(context)
    },
    async diagnose(context, failure) {
      calls.push('diagnose')
      const prompt = { goal: request.text, evidence: failure.bundle.items.map((item) => item.evidence_id) }
      return { prompt, output: await transport.diagnose(PROMPT, { signal: context.signal, timeoutMs: context.scenario.scenario.timeouts.model_ms }) }
    },
    async validate(context, { diagnosis, failure }) {
      calls.push('validate')
      return validateCandidate({
        runId: context.runId,
        diagnosis,
        failureBundle: failure.bundle,
        permittedSourcePaths: context.scenario.scenario.permitted_source_paths,
        checkoutRoot: checkout.path,
      })
    },
    async apply() {
      calls.push('apply')
      throw new Error('A rejected candidate must never reach patch application.')
    },
    async replay() {
      calls.push('replay')
      throw new Error('A rejected candidate must never reach replay.')
    },
    async cleanup() {
      calls.push('cleanup')
      return { unchanged: true, mismatches: [] }
    },
  }
  const result = await executeRun({
    request,
    scenario: FAILURE,
    baseline: BASELINE,
    store,
    events,
    allocator: createEvidenceIdAllocator(runId),
    ports,
    secretMarkers: [MARKER],
  })
  return { calls, checkout: checkout.path, runRoot: path.join(checkout.path, '.flowproof', 'runs', runId), events: events.events(), result }
}

const gateOf = (run: FailureRun, gateId: GateId) => run.result.gates.find((gate) => gate.gate_id === gateId)

describe('the Failure run with the fixture provider', () => {
  it('rejects the invalid citation before patch application and finalizes Unverified', async () => {
    const fetchSpy = forbidNetwork()
    const run = await withoutModelKey(() => runFailureCase(selectTransport(FAILURE.scenario)))
    const { result } = run

    // Apply and replay were never reached; the run only reproduced, diagnosed, checked, and cleaned up.
    expect(run.calls).toEqual(['reproduce', 'diagnose', 'validate', 'cleanup'])
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(parseRunResult(result).ok).toBe(true)
    expect(result.status).toBe('Unverified')
    expect(result.provider).toEqual({ mode: 'fixture', model: null, injected_fault_label: FAULT_LABEL })
    expect(result.gates.map((gate) => [gate.gate_id, gate.status, gate.reason_code])).toEqual(
      GATE_IDS.map((gateId) => {
        if (gateId === 'citations_valid') return [gateId, 'fail', 'CITATION_UNKNOWN_EVIDENCE_ID']
        if (['patch_applied', 'dataset_matches', 'canvas_matches'].includes(gateId)) return [gateId, 'unevaluable', 'GATE_NOT_EVALUATED']
        return [gateId, 'pass', expect.any(String)]
      }),
    )
    expect(gateOf(run, 'citations_valid')?.metrics).toMatchObject({ rejected: 1 })
    expect(gateOf(run, 'patch_scope_valid')?.reason_code).toBe('PATCH_SCOPE_VALID')
    expect(result.failed_gate_ids).toEqual(['citations_valid', 'patch_applied', 'dataset_matches', 'canvas_matches'])

    // Stage-aware artifacts: the failure capture and the diagnosis exist; no candidate or replay.
    expect(result.diagnosis_path).toBe('diagnosis/diagnosis.json')
    expect(result.failure_screenshot_path).toBe('evidence/failure/screenshot.png')
    expect(result.candidate_diff_path).toBeNull()
    expect(result.replay_screenshot_path).toBeNull()
    expect(result.phase_durations_ms).toMatchObject({ apply: 0, replay: 0 })
    const tree = await listTree(run.runRoot)
    expect(tree.filter((entry) => entry.startsWith('candidate') || entry.startsWith('evidence/replay'))).toEqual([])
    expect(tree).toEqual(expect.arrayContaining(['result.json', 'diagnosis/diagnosis.json', 'evidence/failure/manifest.json']))
    // The persisted diagnosis is the fixture output after the strict diagnosis parse.
    const persisted = parseDiagnosis(JSON.parse(await readFile(path.join(run.runRoot, 'diagnosis/diagnosis.json'), 'utf8')))
    expect(persisted.ok && persisted.value).toEqual(COMMITTED_FIXTURE)
    // The checked-out permitted source still holds the committed known-bad filter.
    expect(await readFile(path.join(run.checkout, SOURCE), 'utf8')).toBe(git(REPO_ROOT, 'show', `HEAD:${SOURCE}`))
  })

  it('labels the injected fixture in the events and never echoes its content', async () => {
    const run = await withoutModelKey(() => runFailureCase(selectTransport(FAILURE.scenario)))
    const { events, result } = run

    const phases = events.filter((event) => event.type === 'phase_started').map((event) => event.phase)
    expect(phases).toEqual(['reproducing', 'failure_captured', 'diagnosing'])
    expect(events.some((event) => event.type === 'candidate_ready')).toBe(false)

    const labeled = events.filter((event) => event.message.includes(FAULT_LABEL))
    expect(labeled.length).toBeGreaterThan(0)
    expect(labeled[0]).toMatchObject({ type: 'agent_message', phase: 'diagnosing' })
    expect(labeled[0]?.message).toMatch(/not .*Meta Model API/)
    const diagnosisReady = events.find((event) => event.type === 'diagnosis_ready')
    expect(diagnosisReady?.message).toMatch(/injected evaluation fixture/i)

    // The citation gate fails while diagnosing, and the run then says nothing was applied.
    const citationIndex = events.findIndex((event) => event.gate?.gate_id === 'citations_valid')
    expect(events[citationIndex]).toMatchObject({ phase: 'diagnosing', gate: { status: 'fail', reason_code: 'CITATION_UNKNOWN_EVIDENCE_ID' } })
    const rejection = events.findIndex((event) => event.type === 'agent_message' && /rejected before patch application/i.test(event.message))
    expect(rejection).toBeGreaterThan(citationIndex)
    expect(events[rejection]?.phase).toBe('diagnosing')

    const shown = JSON.stringify({ events, result })
    for (const text of FIXTURE_TEXTS) expect(shown).not.toContain(text)
  })
})

// ---------------------------------------------------------------------------------------
// Starting the Failure case through the Studio API
// ---------------------------------------------------------------------------------------

describe('starting the Failure case through the Studio API', () => {
  it('needs no MODEL_API_KEY and hands the run the fixture transport', async () => {
    const clone = await createTempClone()
    cleanups.push(clone.remove)
    const started: StudioRunStart[] = []
    const server = await startStudioServer({
      repoRoot: clone.path,
      targetOrigin: 'http://localhost:43119',
      env: {},
      startRun: async (start) => {
        started.push(start)
        const store = await createRunArtifactStore({ repoRoot: clone.path, runId: start.request.run_id })
        const events = createRunEventStream({ runId: start.request.run_id, registry: store })
        return { runId: start.request.run_id, events, artifacts: store, result: () => null } satisfies StudioRunHandle
      },
    })
    cleanups.push(() => server.close())

    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port: server.address.port,
          method: 'POST',
          path: '/api/runs',
          headers: {
            host: server.session.authority,
            origin: server.session.origin,
            cookie: `${LAUNCH_COOKIE_NAME}=${server.session.launchCookie().value}`,
            'content-type': 'application/json',
          },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (text += chunk))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
        },
      )
      outgoing.on('error', reject)
      outgoing.end(JSON.stringify({ scenario_id: FAILURE_ID, request_text: GOAL }))
    })

    expect(reply.status, reply.body).toBe(202)
    expect(started).toHaveLength(1)
    const [start] = started
    expect(start?.scenario.scenario.provider).toEqual({ mode: 'fixture', fixture_path: FIXTURE_PATH, injected_fault_label: FAULT_LABEL })
    expect(start?.transport.model).toBeNull()
    expect(start?.transport.checkReadiness({})).toEqual({ ready: true })
  })
})
