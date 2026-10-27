import type { CapturedPhase } from './capture/browserCapture.js'
import {
  CONTRACT_SCHEMA_VERSION,
  GATE_IDS,
  GateOutcomeSchema,
  META_MODEL_ID,
  gitOidSchema,
  isLegalFinalStatus,
  isLegalRunTransition,
  parseChatRequest,
  parseDiagnosis,
  parseEvidenceBundle,
  parseRunResult,
  sha256Schema,
} from './contracts/index.js'
import type {
  ChatRequest,
  EvidenceBundle,
  EvidencePhase,
  EvidenceType,
  GateId,
  GateOutcome,
  PhaseDurations,
  RunResult,
  RunState,
} from './contracts/index.js'
import type { EvidenceIdAllocator } from './evidence/ids.js'
import { sanitizeText } from './evidence/sanitize.js'
import { createSecretScanner } from './evidence/secretScan.js'
import type { SecretScanner } from './evidence/secretScan.js'
import { ArtifactStoreError } from './evidence/store.js'
import type { RunArtifactStore } from './evidence/store.js'
import type { CandidateValidation, ValidatedCandidate } from './patch/validateDiff.js'
import type { LoadedScenario } from './scenario/loadScenario.js'
import type { RunEventStream, StudioEventInput } from './studio/events.js'
import { failGate, passGate, reduceGates, unevaluableGate } from './verify/gates.js'
import { evaluateOracles } from './verify/oracle.js'
import type { WorktreeIntegrityReport } from './worktree/session.js'

// The run state machine: `initialized → reproducing → failure_captured → diagnosing →
// candidate_validated → applying → replaying → finalized`. Stages arrive as ports, so capture,
// the model call, the guards, and the worktree stay with their owners, while the run owns the
// transitions, the failure and replay oracles, the whole-run secret scan, the nine-gate reduction,
// stage-aware result paths, the scenario stage and total timeouts, phase durations, and
// `result.json`. A stage failure, rejection, timeout, or interrupt finalizes directly as
// `Unverified` with its gate failed or unevaluable and every later gate unevaluable; an interrupt
// (the Studio page or browser closing, or the process being interrupted) cancels the running
// stage at once but never the finalization. Cleanup runs exactly once on every exit, and the
// run's own gate, event, and error text never echoes stage errors, prompts, model output, or
// diffs. When a committed evaluation fixture stands in for the model, the run labels that
// injected fault in its activity as well as in the result's provider.

export interface DiagnosisExchange {
  /** The sanitized prompt actually sent; part of the whole-run secret scan. */
  readonly prompt: unknown
  /** Raw, untrusted transport output. */
  readonly output: unknown
}

export interface RunStageContext {
  readonly runId: string
  readonly scenario: LoadedScenario
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  /** Aborted when the stage's scenario timeout or the total run timeout elapses, or the run is interrupted. */
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

/** The original repository state recorded before any worktree operation. */
export interface RunBaseline {
  readonly original_head: string
  readonly original_status_digest: string
}

export interface ExecuteRunOptions {
  readonly request: ChatRequest
  readonly scenario: LoadedScenario
  readonly baseline: RunBaseline
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  readonly allocator: EvidenceIdAllocator
  readonly ports: RunStagePorts
  /** Seeded markers that must not appear in any artifact, event, prompt, or the result. */
  readonly secretMarkers: readonly string[]
  /** Aborted when the Studio page or browser closes or the process is interrupted. */
  readonly interrupt?: AbortSignal
  /** Clock for timestamps and phase durations; stage timeouts always run on real time. */
  readonly now?: () => Date
}

export type RunErrorCode = 'RUN_OPTIONS_INVALID' | 'RUN_TRANSITION_ILLEGAL' | 'RUN_RESULT_INVALID'

/** A failure that prevents safe finalization; messages never echo run content. */
export class RunError extends Error {
  readonly code: RunErrorCode

  constructor(code: RunErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RunError'
    this.code = code
  }
}

// Paths relative to the run directory.
const DIAGNOSIS_PATH = 'diagnosis/diagnosis.json'
const CANDIDATE_DIFF_PATH = 'candidate/candidate.diff'
const RESULT_PATH = 'result.json'
/** Fixed artifacts that the whole-run secret scan reads back besides every Evidence ID. */
const SCANNED_ARTIFACTS = ['failure-manifest', 'replay-manifest', 'diagnosis', 'candidate-diff'] as const
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const ORACLE_GATES = ['dataset_matches', 'canvas_matches'] as const

const PHASE_MESSAGES: Readonly<Record<Exclude<RunState, 'initialized' | 'finalized'>, string>> = {
  reproducing: 'Reproducing the known-bad scenario in the target app.',
  failure_captured: 'Captured the failure evidence.',
  diagnosing: 'Requesting one evidence-cited diagnosis and checking its candidate.',
  candidate_validated: 'The candidate passed the citation and patch-scope guards.',
  applying: 'Applying the candidate in the isolated worktree and rebuilding the app.',
  replaying: 'Replaying the same scenario against the patched app.',
}

const FIXTURE_DIAGNOSING = 'Reading the labeled injected evaluation fixture in place of a model diagnosis and checking its candidate.'
const REJECTED_BEFORE_APPLY = 'The candidate was rejected before patch application, so nothing was applied or replayed.'

const STAGE_FAILURE_MESSAGES = {
  FAILURE_CAPTURE_FAILED: 'The failure capture did not complete, so reproduction could not be evaluated.',
  FAILURE_CAPTURE_TIMEOUT: 'The failure capture exceeded the scenario capture timeout and was cancelled.',
  PROVIDER_FAILED: 'The diagnosis request failed, so no citation could be checked.',
  PROVIDER_TIMEOUT: 'The diagnosis request exceeded the scenario model timeout and was cancelled.',
  GUARD_FAILED: 'The candidate guards did not complete, so the candidate was not evaluated.',
  PATCH_APPLY_FAILED: 'The candidate did not apply, or the patched app did not rebuild, in the isolated worktree.',
  PATCH_APPLY_TIMEOUT: 'Applying and rebuilding exceeded the scenario replay timeout and was cancelled.',
  REPLAY_CAPTURE_FAILED: 'The replay capture did not complete, so the oracles could not be evaluated.',
  REPLAY_TIMEOUT: 'The replay exceeded the scenario replay timeout and was cancelled.',
  RUN_TIMEOUT: 'The run exceeded the scenario total timeout and was cancelled.',
  RUN_INTERRUPTED: 'The Studio closed or the process was interrupted during this stage, so the stage was cancelled.',
} as const

type StageFailureCode = keyof typeof STAGE_FAILURE_MESSAGES
type StageFailure = 'error' | 'stage-timeout' | 'run-timeout' | 'interrupted'
type StageOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: StageFailure }

const EVIDENCE_INCOMPLETE = 'The failure Evidence Bundle is missing, invalid, or not fully persisted.'
const INTERRUPTED = 'The run was interrupted, so it stops here and finalizes as Unverified.'

const failureCode = (failure: StageFailure, failed: StageFailureCode, timedOut: StageFailureCode = failed): StageFailureCode =>
  failure === 'interrupted' ? 'RUN_INTERRUPTED' : failure === 'run-timeout' ? 'RUN_TIMEOUT' : failure === 'stage-timeout' ? timedOut : failed

const stageFailed = (gateId: GateId, code: StageFailureCode): GateOutcome =>
  unevaluableGate(gateId, code, { message: STAGE_FAILURE_MESSAGES[code] })

const notEvaluated = (gateId: GateId): GateOutcome =>
  unevaluableGate(gateId, 'GATE_NOT_EVALUATED', { message: 'The run finalized before this gate was evaluated.' })

const asObject = <T>(value: unknown): Partial<T> => (typeof value === 'object' && value !== null ? (value as Partial<T>) : {})

const elapsedMs = (from: Date, to: Date): number => Math.max(0, to.getTime() - from.getTime())

/** The real-time end of a stage window that starts now. */
const windowOf = (budgetMs: number): number => performance.now() + budgetMs

const idsOf = (bundle: EvidenceBundle, type: EvidenceType): string[] =>
  bundle.items.filter((item) => item.type === type).map((item) => item.evidence_id)

/**
 * Runs one stage port until it settles, its window ends, the run times out, or the run is
 * interrupted. A timed-out or interrupted stage has its signal aborted and its late settlement
 * ignored, and no stage outcome rejects the run.
 */
function runStage<T>(
  run: AbortSignal,
  interrupt: AbortSignal | undefined,
  windowEnd: number | null,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<StageOutcome<T>> {
  if (interrupt?.aborted) return Promise.resolve({ ok: false, failure: 'interrupted' })
  if (run.aborted) return Promise.resolve({ ok: false, failure: 'run-timeout' })
  const controller = new AbortController()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (outcome: StageOutcome<T>): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      run.removeEventListener('abort', onRunTimeout)
      interrupt?.removeEventListener('abort', onInterrupt)
      if (!outcome.ok && outcome.failure !== 'error') controller.abort()
      resolve(outcome)
    }
    const onRunTimeout = (): void => settle({ ok: false, failure: 'run-timeout' })
    const onInterrupt = (): void => settle({ ok: false, failure: 'interrupted' })
    run.addEventListener('abort', onRunTimeout, { once: true })
    interrupt?.addEventListener('abort', onInterrupt, { once: true })
    if (windowEnd !== null) {
      timer = setTimeout(() => settle({ ok: false, failure: 'stage-timeout' }), Math.max(0, windowEnd - performance.now()))
    }
    let pending: Promise<T>
    try {
      pending = Promise.resolve(call(controller.signal))
    } catch (error) {
      pending = Promise.reject(error)
    }
    void pending.then(
      (value) => settle({ ok: true, value }),
      () => settle({ ok: false, failure: 'error' }),
    )
  })
}

/** True when every option describes the same run and the baseline is contract-shaped. */
function isWiredForOneRun(options: ExecuteRunOptions): boolean {
  try {
    const { request, scenario, baseline, store, events, allocator } = options
    return (
      parseChatRequest(request).ok &&
      request.scenario_id === scenario.scenario.scenario_id &&
      [store.runId, events.runId, allocator.runId].every((id) => id === request.run_id) &&
      gitOidSchema.safeParse(baseline.original_head).success &&
      sha256Schema.safeParse(baseline.original_status_digest).success
    )
  } catch {
    return false
  }
}

type CheckedCapture =
  | { readonly complete: false; readonly screenshotPath: string | null }
  | {
      readonly complete: true
      readonly screenshotPath: string
      readonly bundle: EvidenceBundle
      readonly manifestPath: string
      readonly observed: { readonly dataset: unknown; readonly chart: unknown }
    }

/**
 * A capture is complete only when its bundle satisfies the contract for this run, scenario, and
 * phase, and the manifest, the screenshot, and every item are persisted and registered here.
 */
function checkCapture(captured: unknown, phase: EvidencePhase, store: RunArtifactStore, runId: string, scenarioId: string): CheckedCapture {
  const value = asObject<CapturedPhase>(captured)
  const screenshotPath = typeof value.screenshotPath === 'string' && store.hasArtifact(value.screenshotPath) ? value.screenshotPath : null
  const parsed = parseEvidenceBundle(value.bundle)
  if (!parsed.ok || screenshotPath === null || typeof value.manifestPath !== 'string') return { complete: false, screenshotPath }
  const bundle = parsed.value
  const complete =
    value.phase === phase &&
    bundle.phase === phase &&
    bundle.run_id === runId &&
    bundle.scenario_id === scenarioId &&
    store.hasArtifact(value.manifestPath) &&
    bundle.items.find((item) => item.type === 'screenshot')?.artifact_path === screenshotPath &&
    bundle.items.every((item) => store.hasEvidence(item.evidence_id) && store.hasArtifact(item.artifact_path))
  if (!complete) return { complete: false, screenshotPath }
  const observed = asObject<CapturedPhase['observed']>(value.observed)
  return {
    complete: true,
    screenshotPath,
    bundle,
    manifestPath: value.manifestPath,
    observed: { dataset: observed.dataset, chart: observed.chart },
  }
}

/** The defect reproduces when the known-bad observation differs from a committed oracle. */
function reproductionGate(scenario: LoadedScenario, capture: Extract<CheckedCapture, { complete: true }>): GateOutcome {
  const evidence = { dataset: idsOf(capture.bundle, 'dataset'), chart: idsOf(capture.bundle, 'chart') }
  const oracles = evaluateOracles({ expected: scenario.oracle, observed: capture.observed, evidence })
  const statuses = [oracles.dataset_matches.status, oracles.canvas_matches.status]
  const evidenceIds = [...evidence.dataset, ...evidence.chart]
  if (statuses.includes('unevaluable')) {
    return unevaluableGate('failure_reproduced', 'FAILURE_OBSERVATION_INVALID', {
      evidence_ids: evidenceIds,
      message: 'The known-bad observation is malformed, so reproduction cannot be evaluated.',
    })
  }
  if (statuses.every((status) => status === 'pass')) {
    return failGate('failure_reproduced', 'FAILURE_NOT_REPRODUCED', {
      evidence_ids: evidenceIds,
      message: 'The known-bad run already matches the committed oracles, so the defect did not reproduce.',
    })
  }
  return passGate('failure_reproduced', {
    reason_code: 'FAILURE_REPRODUCED',
    evidence_ids: evidenceIds,
    metrics: { dataset_differs: statuses[0] === 'fail', canvas_differs: statuses[1] === 'fail' },
    message: 'The known-bad run differs from the committed oracles, so the defect reproduced.',
  })
}

/**
 * Accepts the guards' candidate only in the exact form the run persists and applies: a permitted
 * target and a text diff that persists without redaction, so the stored diff is the applied diff.
 */
function usableCandidate(value: unknown, permittedSourcePaths: readonly string[]): ValidatedCandidate | null {
  const { target_path: targetPath, unified_diff: diff, evidence_ids: evidenceIds } = asObject<ValidatedCandidate>(value)
  if (typeof targetPath !== 'string' || !permittedSourcePaths.includes(targetPath)) return null
  if (typeof diff !== 'string' || diff === '' || sanitizeText(diff).redactions.length > 0) return null
  if (!Array.isArray(evidenceIds) || !evidenceIds.every((id) => typeof id === 'string')) return null
  return Object.freeze({ target_path: targetPath, unified_diff: diff, evidence_ids: Object.freeze([...evidenceIds]) })
}

async function integrityGate(cleanup: () => Promise<WorktreeIntegrityReport>): Promise<GateOutcome> {
  let report: Partial<WorktreeIntegrityReport>
  try {
    report = asObject<WorktreeIntegrityReport>(await cleanup())
  } catch {
    return unevaluableGate('original_worktree_unchanged', 'CLEANUP_FAILED', {
      message: 'Cleanup failed, so the original repository could not be compared with its pre-run snapshot.',
    })
  }
  const { unchanged, mismatches } = report
  if (typeof unchanged !== 'boolean' || !Array.isArray(mismatches)) {
    return unevaluableGate('original_worktree_unchanged', 'INTEGRITY_REPORT_INVALID', {
      message: 'Cleanup returned a malformed integrity report.',
    })
  }
  if (unchanged && mismatches.length === 0) {
    return passGate('original_worktree_unchanged', {
      reason_code: 'ORIGINAL_WORKTREE_UNCHANGED',
      message: 'After cleanup the original repository equals its pre-run snapshot.',
    })
  }
  return failGate('original_worktree_unchanged', 'ORIGINAL_WORKTREE_CHANGED', {
    metrics: { mismatched_facets: mismatches.length },
    message: 'After cleanup the original repository differs from its pre-run snapshot.',
  })
}

/** PNG bytes are scanned for seeded markers; JSON and text artifacts as their content. */
function decodeArtifact(bytes: Buffer): unknown {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return bytes
  const text = bytes.toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function providerOf(scenario: LoadedScenario): RunResult['provider'] {
  const { provider } = scenario.scenario
  return provider.mode === 'meta'
    ? { mode: 'meta', model: META_MODEL_ID, injected_fault_label: null }
    : { mode: 'fixture', model: null, injected_fault_label: provider.injected_fault_label }
}

/**
 * Executes one run through every stage it can reach and finalizes it: cleanup once, the integrity
 * and whole-run secret gates, the nine-gate reduction, and a contract-valid `result.json`, which
 * is also the returned result. Throws `RunError` only when the options describe different runs or
 * the result cannot be finalized safely.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<RunResult> {
  const { request, scenario, store, events, allocator, ports } = options
  const now = options.now ?? ((): Date => new Date())
  const startedAt = now()
  if (!isWiredForOneRun(options)) {
    try {
      await ports.cleanup()
    } catch {
      // The run cannot finalize either way; the caller reports the wiring error.
    }
    throw new RunError('RUN_OPTIONS_INVALID', 'The request, scenario, baseline, store, events, and allocator must describe one run.')
  }

  const runId = request.run_id
  const scenarioId = scenario.scenario.scenario_id
  const { timeouts, provider } = scenario.scenario
  /** The injected-fault label when a committed evaluation fixture answers instead of the model. */
  const injectedFault = provider.mode === 'fixture' ? provider.injected_fault_label : null
  const gates = new Map<GateId, GateOutcome>()
  const published = new Map<GateId, string>()
  const announcedIds = new Set<string>()
  const durations: PhaseDurations = { capture: 0, model: 0, apply: 0, replay: 0, finalize: 0 }
  const paths = {
    diagnosis: null as string | null,
    candidateDiff: null as string | null,
    failureScreenshot: null as string | null,
    replayScreenshot: null as string | null,
  }
  let state: RunState = 'initialized'
  let prompt: unknown = null

  const emit = (input: Omit<StudioEventInput, 'phase'>): boolean => {
    try {
      events.emit({ ...input, phase: state })
      return true
    } catch {
      // Activity is advisory: a rejected event never changes the authoritative result.
      return false
    }
  }

  const enter = (next: Exclude<RunState, 'initialized'>): void => {
    if (!isLegalRunTransition(state, next)) throw new RunError('RUN_TRANSITION_ILLEGAL', 'The run attempted an illegal state transition.')
    state = next
    if (next === 'finalized') return
    emit({ type: 'phase_started', message: next === 'diagnosing' && injectedFault !== null ? FIXTURE_DIAGNOSING : PHASE_MESSAGES[next] })
  }

  const record = (outcome: GateOutcome): void => {
    gates.set(outcome.gate_id, outcome)
    const summary = `${outcome.status}:${outcome.reason_code}`
    if (published.get(outcome.gate_id) === summary) return
    const sent = emit({
      type: 'gate_updated',
      message: `Gate ${outcome.gate_id} reported ${outcome.status}.`,
      gate: { gate_id: outcome.gate_id, status: outcome.status, reason_code: outcome.reason_code },
    })
    if (sent) published.set(outcome.gate_id, summary)
  }

  const announce = (bundle: EvidenceBundle, manifestPath: string): void => {
    for (const item of bundle.items) announcedIds.add(item.evidence_id)
    emit({
      type: 'evidence_added',
      message: `Captured ${bundle.items.length} sanitized ${bundle.phase} evidence items.`,
      evidence_ids: bundle.items.map((item) => item.evidence_id),
      artifact_refs: [manifestPath],
    })
  }

  /** A guard outcome counts only for its own gate and only when it cites this run's evidence. */
  const guardGate = (gateId: 'citations_valid' | 'patch_scope_valid', outcome: unknown): GateOutcome => {
    const parsed = GateOutcomeSchema.safeParse(outcome)
    if (parsed.success && parsed.data.gate_id === gateId && parsed.data.evidence_ids.every((id) => store.hasEvidence(id))) {
      return parsed.data
    }
    return unevaluableGate(gateId, 'GUARD_OUTCOME_INVALID', { message: 'The candidate guard returned a malformed outcome.' })
  }

  const runTimeout = new AbortController()
  let interrupted = false
  const stage = async <T>(windowEnd: number | null, call: (context: RunStageContext) => Promise<T>): Promise<StageOutcome<T>> => {
    const outcome = await runStage(runTimeout.signal, options.interrupt, windowEnd, (signal) =>
      call(Object.freeze({ runId, scenario, store, allocator, signal })),
    )
    if (!outcome.ok && outcome.failure === 'interrupted') interrupted = true
    return outcome
  }

  /** `reproducing` → `failure_captured`; returns the capture only when the defect reproduced with complete evidence. */
  const reproduce = async (): Promise<CapturedPhase | null> => {
    enter('reproducing')
    const mark = now()
    try {
      const captured = await stage(windowOf(timeouts.capture_ms), (context) => ports.reproduce(context))
      if (!captured.ok) {
        record(stageFailed('failure_reproduced', failureCode(captured.failure, 'FAILURE_CAPTURE_FAILED', 'FAILURE_CAPTURE_TIMEOUT')))
        record(failGate('evidence_complete', 'FAILURE_EVIDENCE_INCOMPLETE', { message: EVIDENCE_INCOMPLETE }))
        return null
      }
      const capture = checkCapture(captured.value, 'failure', store, runId, scenarioId)
      paths.failureScreenshot = capture.screenshotPath
      if (!capture.complete) {
        record(
          unevaluableGate('failure_reproduced', 'FAILURE_EVIDENCE_INVALID', {
            message: 'Reproduction cannot be evaluated without complete failure evidence.',
          }),
        )
        record(failGate('evidence_complete', 'FAILURE_EVIDENCE_INCOMPLETE', { message: EVIDENCE_INCOMPLETE }))
        return null
      }
      enter('failure_captured')
      announce(capture.bundle, capture.manifestPath)
      const reproduced = reproductionGate(scenario, capture)
      record(reproduced)
      record(
        passGate('evidence_complete', {
          reason_code: 'EVIDENCE_COMPLETE',
          evidence_ids: capture.bundle.items.map((item) => item.evidence_id),
          message: 'The failure Evidence Bundle holds every required evidence type, each persisted for this run.',
        }),
      )
      return reproduced.status === 'pass' ? captured.value : null
    } finally {
      durations.capture = elapsedMs(mark, now())
    }
  }

  /** `diagnosing` → `candidate_validated`; returns the candidate only when both guards pass and its diff is persisted. */
  const diagnose = async (failure: CapturedPhase): Promise<ValidatedCandidate | null> => {
    enter('diagnosing')
    if (injectedFault !== null) {
      emit({
        type: 'agent_message',
        message: `The diagnosis comes from a committed evaluation fixture, not from Meta Model API. Injected fault label: ${injectedFault}`,
      })
    }
    const mark = now()
    try {
      const exchanged = await stage(windowOf(timeouts.model_ms), (context) => ports.diagnose(context, failure))
      if (!exchanged.ok) {
        record(stageFailed('citations_valid', failureCode(exchanged.failure, 'PROVIDER_FAILED', 'PROVIDER_TIMEOUT')))
        return null
      }
      const exchange = asObject<DiagnosisExchange>(exchanged.value)
      prompt = exchange.prompt ?? null
      // The guards bound their own `git apply --check` and have no scenario budget of their own,
      // so only the total run timeout limits them.
      const validated = await stage(null, (context) => ports.validate(context, { diagnosis: exchange.output, failure }))
      if (!validated.ok) {
        const code = failureCode(validated.failure, 'GUARD_FAILED')
        record(stageFailed('citations_valid', code))
        record(stageFailed('patch_scope_valid', code))
        return null
      }
      const validation = asObject<CandidateValidation>(validated.value)
      const diagnosis = parseDiagnosis(validation.diagnosis)
      if (diagnosis.ok) {
        store.register('diagnosis', await store.writeJson(DIAGNOSIS_PATH, diagnosis.value))
        paths.diagnosis = DIAGNOSIS_PATH
        const message = injectedFault === null ? 'Received a strict-schema diagnosis.' : 'Received a strict-schema diagnosis from the injected evaluation fixture.'
        emit({ type: 'diagnosis_ready', message, artifact_refs: [DIAGNOSIS_PATH] })
      }
      const citations = guardGate('citations_valid', validation.citations)
      const scope = guardGate('patch_scope_valid', validation.scope)
      record(citations)
      record(scope)
      if (citations.status !== 'pass' || scope.status !== 'pass') {
        emit({ type: 'agent_message', message: REJECTED_BEFORE_APPLY })
        return null
      }
      const candidate = paths.diagnosis === null ? null : usableCandidate(validation.candidate, scenario.scenario.permitted_source_paths)
      if (candidate === null) {
        record(
          unevaluableGate('patch_applied', 'CANDIDATE_UNUSABLE', {
            message: 'The validated candidate is missing, outside the permitted source, or not persistable without redaction.',
          }),
        )
        return null
      }
      store.register('candidate-diff', await store.writeText(CANDIDATE_DIFF_PATH, candidate.unified_diff))
      paths.candidateDiff = CANDIDATE_DIFF_PATH
      enter('candidate_validated')
      emit({ type: 'candidate_ready', message: 'The validated candidate diff is ready for isolated application.', artifact_refs: [CANDIDATE_DIFF_PATH] })
      return candidate
    } finally {
      durations.model = elapsedMs(mark, now())
    }
  }

  /** `applying`; returns the end of the shared apply-and-replay window when the candidate applied. */
  const apply = async (candidate: ValidatedCandidate): Promise<number | null> => {
    enter('applying')
    // `replay_ms` budgets the worktree apply, the patched rebuild, and the replay together.
    const windowEnd = windowOf(timeouts.replay_ms)
    const mark = now()
    try {
      const applied = await stage(windowEnd, (context) => ports.apply(context, candidate))
      if (!applied.ok) {
        const code = failureCode(applied.failure, 'PATCH_APPLY_FAILED', 'PATCH_APPLY_TIMEOUT')
        record(failGate('patch_applied', code, { message: STAGE_FAILURE_MESSAGES[code] }))
        return null
      }
      record(
        passGate('patch_applied', {
          reason_code: 'PATCH_APPLIED',
          message: 'The validated candidate applied in the isolated worktree and the patched app rebuilt.',
        }),
      )
      return windowEnd
    } finally {
      durations.apply = elapsedMs(mark, now())
    }
  }

  /** `replaying`: evaluates the dataset and Canvas oracles on complete replay evidence. */
  const replay = async (windowEnd: number): Promise<void> => {
    enter('replaying')
    const mark = now()
    try {
      const replayed = await stage(windowEnd, (context) => ports.replay(context))
      if (!replayed.ok) {
        const code = failureCode(replayed.failure, 'REPLAY_CAPTURE_FAILED', 'REPLAY_TIMEOUT')
        for (const gateId of ORACLE_GATES) record(stageFailed(gateId, code))
        return
      }
      const capture = checkCapture(replayed.value, 'replay', store, runId, scenarioId)
      paths.replayScreenshot = capture.screenshotPath
      if (!capture.complete) {
        for (const gateId of ORACLE_GATES) {
          record(
            unevaluableGate(gateId, 'REPLAY_EVIDENCE_INCOMPLETE', {
              message: 'The replay Evidence Bundle is missing, invalid, or not fully persisted, so the oracle cannot be evaluated.',
            }),
          )
        }
        return
      }
      announce(capture.bundle, capture.manifestPath)
      const oracles = evaluateOracles({
        expected: scenario.oracle,
        observed: capture.observed,
        evidence: { dataset: idsOf(capture.bundle, 'dataset'), chart: idsOf(capture.bundle, 'chart') },
      })
      record(oracles.dataset_matches)
      record(oracles.canvas_matches)
    } finally {
      durations.replay = elapsedMs(mark, now())
    }
  }

  /** Reads back every persisted artifact and scans it with the events, the prompt, and the draft result. */
  const secretScanGate = async (draft: RunResult): Promise<GateOutcome> => {
    let scanner: SecretScanner
    try {
      scanner = createSecretScanner({ markers: options.secretMarkers })
    } catch {
      return unevaluableGate('secret_scan_clean', 'SECRET_SCAN_UNAVAILABLE', {
        message: 'The whole-run secret scan cannot run without valid seeded markers.',
      })
    }
    const evidenceIds = [...new Set([...allocator.issued(), ...announcedIds])].filter((id) => store.hasEvidence(id))
    const artifacts: Record<string, unknown> = {}
    for (const id of [...evidenceIds, ...SCANNED_ARTIFACTS]) {
      try {
        artifacts[id] = decodeArtifact(await store.read(id))
      } catch (error) {
        // A fixed artifact of a phase the run never reached is absent; any other failure leaves
        // the scan incomplete.
        if (error instanceof ArtifactStoreError && error.code === 'ARTIFACT_UNKNOWN_ID') continue
        return unevaluableGate('secret_scan_clean', 'SECRET_SCAN_INCOMPLETE', {
          message: 'A persisted artifact could not be read back for the whole-run secret scan.',
        })
      }
    }
    const report = scanner.scanRun({ artifacts, events: events.events(), provider_request: prompt, result: draft })
    const metrics = { artifacts: Object.keys(artifacts).length, findings: report.findings.length }
    if (report.clean) {
      return passGate('secret_scan_clean', {
        reason_code: 'SECRET_SCAN_CLEAN',
        metrics,
        message: 'The whole-run secret scan found no seeded marker or credential.',
      })
    }
    return failGate('secret_scan_clean', 'SECRET_SCAN_FINDINGS', {
      metrics,
      message: 'The whole-run secret scan found potential secrets; their values are not reported.',
    })
  }

  const resultWith = (secretScan: GateOutcome, completedAt: Date): RunResult => {
    const reduction = reduceGates(GATE_IDS.map((gateId) => (gateId === 'secret_scan_clean' ? secretScan : (gates.get(gateId) ?? notEvaluated(gateId)))))
    return {
      schema_version: CONTRACT_SCHEMA_VERSION,
      run_id: runId,
      request_id: request.request_id,
      scenario_id: scenarioId,
      case: scenario.scenario.case,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      original_head: options.baseline.original_head,
      original_status_digest: options.baseline.original_status_digest,
      phase_durations_ms: { ...durations },
      provider: providerOf(scenario),
      status: reduction.status,
      gates: [...reduction.gates],
      failed_gate_ids: [...reduction.failed_gate_ids],
      diagnosis_path: paths.diagnosis,
      candidate_diff_path: paths.candidateDiff,
      failure_screenshot_path: paths.failureScreenshot,
      replay_screenshot_path: paths.replayScreenshot,
      total_duration_ms: elapsedMs(startedAt, completedAt),
    }
  }

  const runTimer = setTimeout(() => runTimeout.abort(), timeouts.total_ms)
  try {
    const failure = await reproduce()
    const candidate = failure === null ? null : await diagnose(failure)
    const windowEnd = candidate === null ? null : await apply(candidate)
    if (windowEnd !== null) await replay(windowEnd)
  } catch {
    // An engine-side failure, such as an artifact write, stops the run; every gate it did not
    // reach finalizes as unevaluable.
    emit({ type: 'agent_message', message: 'An internal error stopped the run before every gate was evaluated.' })
  } finally {
    clearTimeout(runTimer)
  }
  if (interrupted) emit({ type: 'agent_message', message: INTERRUPTED })

  const finalizeMark = now()
  record(await integrityGate(() => ports.cleanup()))
  for (const gateId of GATE_IDS) {
    if (gateId !== 'secret_scan_clean' && !gates.has(gateId)) record(notEvaluated(gateId))
  }
  const secretScan = await secretScanGate(resultWith(unevaluableGate('secret_scan_clean', 'SECRET_SCAN_PENDING'), finalizeMark))
  record(secretScan)
  const completedAt = now()
  durations.finalize = elapsedMs(finalizeMark, completedAt)
  const result = resultWith(secretScan, completedAt)
  if (!parseRunResult(result).ok || !isLegalFinalStatus(state, result.status)) {
    throw new RunError('RUN_RESULT_INVALID', 'The finalized result violates the run-result contract.')
  }
  store.register('result', await store.writeJson(RESULT_PATH, result))
  // The authoritative result is exactly what was persisted.
  const persisted = parseRunResult(JSON.parse((await store.read('result')).toString('utf8')) as unknown)
  if (!persisted.ok) throw new RunError('RUN_RESULT_INVALID', 'The persisted result violates the run-result contract.')
  enter('finalized')
  emit({ type: 'run_finalized', message: `Run finalized as ${persisted.value.status}.`, artifact_refs: [RESULT_PATH] })
  return persisted.value
}
