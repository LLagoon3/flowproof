import {
  CAPTURED_EXECUTION_KIND,
  EVIDENCE_TYPES,
  GATE_IDS,
  evidenceIdParts,
  eventOrderViolation,
  isCapturedScenario,
  isCapturedVerificationResult,
  isValidRequestText,
  studioError,
} from './api.js'
import type {
  CapturedCheck,
  CapturedStatus,
  CapturedVerificationResult,
  EvidencePhase,
  EvidenceType,
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  PhaseDurations,
  RunEventHandlers,
  RunResult,
  RunStart,
  RunState,
  RunStatus,
  ScenarioSummary,
  StudioError,
  StudioEvent,
  StudioEventType,
  StudioRunResult,
} from './api.js'

// The deterministic Studio state: prepared-case readiness, at most one active run, its ordered
// live activity, announced Evidence IDs, provisional gate and candidate status, and the final
// result. Transitions are pure. Live events are advisory: once the authoritative result arrives
// it alone decides the final status, every gate outcome, and candidate availability.

export type CatalogStatus = 'loading' | 'ready' | 'failed'
/** `ended` follows the final event; `disconnected` and `rejected` stop live activity for good. */
export type StreamStatus = 'connecting' | 'open' | 'ended' | 'disconnected' | 'rejected'
/** `ready` is announced by an event; `available` and `absent` come from the final result. */
export type CandidateAvailability = 'pending' | 'ready' | 'available' | 'absent'

export interface StreamView {
  readonly status: StreamStatus
  /** Sequence of the last accepted event; null until the first live event arrives. */
  readonly lastSequence: number | null
  readonly error: StudioError | null
}

interface RunViewBase {
  readonly runId: string
  readonly requestId: string
  readonly scenarioId: string
  readonly requestText: string
  readonly stream: StreamView
  readonly phase: RunState | null
  /** Accepted events in sequence order. */
  readonly activity: readonly StudioEvent[]
  /** Evidence IDs announced by accepted events, in first-announced order. */
  readonly evidenceIds: readonly string[]
  /** Latest summary per gate: provisional from events, then replaced by the final result. */
  readonly gates: Readonly<Partial<Record<GateId, GateSummary>>>
  readonly candidate: CandidateAvailability
}

/** `failed` means no valid authoritative result could be read, so no final status is shown. */
export type RunView =
  | (RunViewBase & { readonly status: 'running'; readonly result: null; readonly error: null })
  | (RunViewBase & { readonly status: 'finalized'; readonly result: RunResult; readonly error: null })
  | (RunViewBase & { readonly status: 'failed'; readonly result: null; readonly error: StudioError })

export interface PendingStart {
  readonly scenarioId: string
  readonly requestText: string
  /** Present only when the selected case is the host-fixed captured verification case. */
  readonly executionKind?: typeof CAPTURED_EXECUTION_KIND
}

interface CapturedRunViewBase {
  readonly mode: 'captured'
  readonly runId: string
  readonly requestId: string
  readonly scenarioId: string
  readonly stream: StreamView
  readonly phase: RunState | null
  /** Accepted events in sequence order. */
  readonly activity: readonly StudioEvent[]
  /** Evidence IDs announced by accepted events, in first-announced order. */
  readonly evidenceIds: readonly string[]
}

/**
 * The run of a host-fixed captured verification Studio. It has no chat, no legacy gates and no
 * candidate diff: its check rows and outcome exist only once the strict captured result arrives.
 */
export type CapturedRunView =
  | (CapturedRunViewBase & { readonly status: 'running'; readonly result: null; readonly error: null })
  | (CapturedRunViewBase & { readonly status: 'finalized'; readonly result: CapturedVerificationResult; readonly error: null })
  | (CapturedRunViewBase & { readonly status: 'failed'; readonly result: null; readonly error: StudioError })

export interface StudioState {
  readonly catalog: { readonly status: CatalogStatus; readonly scenarios: readonly ScenarioSummary[] }
  readonly selectedScenarioId: string | null
  /** A start request in flight; it blocks another start until accepted or rejected. */
  readonly pendingStart: PendingStart | null
  /** The current or most recent run. */
  readonly run: RunView | null
  /** The one run of a captured verification Studio; absent in the legacy mode, where `run` is used. */
  readonly capturedRun?: CapturedRunView
  /** The latest session-level error: case loading or a refused start. */
  readonly error: StudioError | null
}

export type StudioAction =
  | { readonly type: 'catalog/loaded'; readonly scenarios: readonly ScenarioSummary[] }
  | { readonly type: 'catalog/failed'; readonly error: StudioError }
  | { readonly type: 'scenario/selected'; readonly scenarioId: string }
  | { readonly type: 'run/requested'; readonly requestText: string }
  | { readonly type: 'run/started'; readonly start: RunStart }
  | { readonly type: 'run/rejected'; readonly error: StudioError }
  // `runId` names the run whose connection or result read produced the action; actions for a
  // run that is no longer current are ignored.
  | { readonly type: 'stream/opened'; readonly runId: string }
  | { readonly type: 'stream/event'; readonly runId: string; readonly event: StudioEvent }
  | { readonly type: 'stream/failed'; readonly runId: string; readonly error: StudioError }
  | { readonly type: 'stream/disconnected'; readonly runId: string }
  | { readonly type: 'result/received'; readonly runId: string; readonly result: StudioRunResult }
  | { readonly type: 'result/failed'; readonly runId: string; readonly error: StudioError }

export const initialStudioState: StudioState = Object.freeze({
  catalog: Object.freeze({ status: 'loading', scenarios: Object.freeze([]) }),
  selectedScenarioId: null,
  pendingStart: null,
  run: null,
  error: null,
})

const isRunActive = (state: StudioState): boolean =>
  state.pendingStart !== null || state.run?.status === 'running' || state.capturedRun?.status === 'running'
const isLive = (stream: StreamView): boolean => stream.status === 'connecting' || stream.status === 'open'

/**
 * True when a new run may be requested: cases loaded, one selected, and no run active. A captured
 * verification Studio allows its one run per launch, even after that run finalized.
 */
export const canStartRun = (state: StudioState): boolean =>
  state.catalog.status === 'ready' && state.selectedScenarioId !== null && !isRunActive(state) && state.capturedRun === undefined

function startBlocker(state: StudioState, requestText: string): string | null {
  if (state.catalog.status !== 'ready') return 'SESSION_NOT_READY'
  if (isRunActive(state)) return 'RUN_ALREADY_ACTIVE'
  if (state.capturedRun !== undefined) return 'RUN_LIMIT_REACHED'
  if (state.selectedScenarioId === null) return 'SCENARIO_NOT_SELECTED'
  return isValidRequestText(requestText) ? null : 'REQUEST_TEXT_INVALID'
}

function createRun(pending: PendingStart, start: RunStart): RunView {
  return {
    runId: start.run_id,
    requestId: start.request_id,
    scenarioId: pending.scenarioId,
    requestText: pending.requestText,
    stream: { status: 'connecting', lastSequence: null, error: null },
    phase: null,
    activity: [],
    evidenceIds: [],
    gates: {},
    candidate: 'pending',
    status: 'running',
    result: null,
    error: null,
  }
}

function acceptEvent(run: RunView, event: StudioEvent): RunView {
  if (!isLive(run.stream)) return run
  const violation = eventOrderViolation(run.runId, run.stream.lastSequence, event)
  if (violation !== null) return { ...run, stream: { ...run.stream, status: 'rejected', error: studioError(violation) } }
  const announced = event.evidence_ids.filter((id) => !run.evidenceIds.includes(id))
  const next = {
    ...run,
    stream: { status: event.type === 'run_finalized' ? 'ended' : 'open', lastSequence: event.sequence, error: null },
    activity: [...run.activity, event],
    evidenceIds: announced.length === 0 ? run.evidenceIds : [...run.evidenceIds, ...announced],
  } satisfies RunView
  // Activity after the authoritative result never revises its phase, gates, or candidate.
  if (next.status === 'finalized') return next
  return {
    ...next,
    phase: event.phase ?? run.phase,
    gates: event.gate === null ? run.gates : { ...run.gates, [event.gate.gate_id]: event.gate },
    candidate: event.type === 'candidate_ready' ? 'ready' : run.candidate,
  }
}

function acceptResult(run: RunView, result: StudioRunResult): RunView {
  if (run.status === 'finalized') return run
  if (isCapturedVerificationResult(result)) return { ...run, status: 'failed', result: null, error: studioError('RESULT_FAMILY_MISMATCH') }
  if (result.run_id !== run.runId || result.request_id !== run.requestId) {
    return { ...run, status: 'failed', result: null, error: studioError('RESULT_RUN_MISMATCH') }
  }
  const gates: Partial<Record<GateId, GateSummary>> = {}
  for (const gate of result.gates) gates[gate.gate_id] = { gate_id: gate.gate_id, status: gate.status, reason_code: gate.reason_code }
  return {
    ...run,
    status: 'finalized',
    result,
    error: null,
    phase: 'finalized',
    gates,
    candidate: result.candidate_diff_path === null ? 'absent' : 'available',
  }
}

function updateRun(state: StudioState, runId: string, update: (run: RunView) => RunView): StudioState {
  if (state.run === null || state.run.runId !== runId) return state
  const run = update(state.run)
  return run === state.run ? state : { ...state, run }
}

// ---------------------------------------------------------------------------------------
// Captured verification run
// ---------------------------------------------------------------------------------------

/** Event types and phases of the legacy model flow, which the captured flow never emits. */
const LEGACY_ONLY_EVENT_TYPES: readonly StudioEventType[] = ['chat_received', 'diagnosis_ready', 'candidate_ready', 'gate_updated']
const LEGACY_ONLY_PHASES: readonly RunState[] = ['diagnosing', 'candidate_validated']

const isCapturedFlowEvent = (event: StudioEvent): boolean =>
  !LEGACY_ONLY_EVENT_TYPES.includes(event.type) && (event.phase === null || !LEGACY_ONLY_PHASES.includes(event.phase))

function createCapturedRun(pending: PendingStart, start: RunStart): CapturedRunView {
  return {
    mode: 'captured',
    runId: start.run_id,
    requestId: start.request_id,
    scenarioId: pending.scenarioId,
    stream: { status: 'connecting', lastSequence: null, error: null },
    phase: null,
    activity: [],
    evidenceIds: [],
    status: 'running',
    result: null,
    error: null,
  }
}

function acceptCapturedEvent(run: CapturedRunView, event: StudioEvent): CapturedRunView {
  if (!isLive(run.stream)) return run
  // A model, chat or legacy gate event is outside the captured flow, so live activity stops.
  const violation = eventOrderViolation(run.runId, run.stream.lastSequence, event) ?? (isCapturedFlowEvent(event) ? null : 'EVENT_INVALID')
  if (violation !== null) return { ...run, stream: { ...run.stream, status: 'rejected', error: studioError(violation) } }
  const announced = event.evidence_ids.filter((id) => !run.evidenceIds.includes(id))
  const next = {
    ...run,
    stream: { status: event.type === 'run_finalized' ? 'ended' : 'open', lastSequence: event.sequence, error: null },
    activity: [...run.activity, event],
    evidenceIds: announced.length === 0 ? run.evidenceIds : [...run.evidenceIds, ...announced],
  } satisfies CapturedRunView
  // Activity after the authoritative result never revises its phase.
  return next.status === 'finalized' ? next : { ...next, phase: event.phase ?? run.phase }
}

/** Only the strict captured family, bound to this run, its request and its case, finalizes it. */
function acceptCapturedResult(run: CapturedRunView, result: StudioRunResult): CapturedRunView {
  if (run.status === 'finalized') return run
  if (!isCapturedVerificationResult(result)) return { ...run, status: 'failed', result: null, error: studioError('RESULT_FAMILY_MISMATCH') }
  if (result.run_id !== run.runId || result.request_id !== run.requestId || result.scenario_id !== run.scenarioId) {
    return { ...run, status: 'failed', result: null, error: studioError('RESULT_RUN_MISMATCH') }
  }
  return { ...run, status: 'finalized', result, error: null, phase: 'finalized' }
}

function updateCapturedRun(run: CapturedRunView, action: StudioAction): CapturedRunView {
  switch (action.type) {
    case 'stream/opened':
      return run.stream.status === 'connecting' ? { ...run, stream: { ...run.stream, status: 'open' } } : run
    case 'stream/event':
      return acceptCapturedEvent(run, action.event)
    case 'stream/failed':
      return isLive(run.stream) ? { ...run, stream: { ...run.stream, status: 'rejected', error: action.error } } : run
    case 'stream/disconnected':
      return isLive(run.stream) ? { ...run, stream: { ...run.stream, status: 'disconnected', error: studioError('STREAM_DISCONNECTED') } } : run
    case 'result/received':
      return acceptCapturedResult(run, action.result)
    case 'result/failed':
      return run.status === 'finalized' ? run : { ...run, status: 'failed', result: null, error: action.error }
    default:
      return run
  }
}

/** Applies a run-scoped action to the captured run it names; null when the action is not one. */
function reduceCapturedRun(state: StudioState, action: StudioAction): StudioState | null {
  const run = state.capturedRun
  if (run === undefined || !('runId' in action) || action.runId !== run.runId) return null
  const next = updateCapturedRun(run, action)
  return next === run ? state : { ...state, capturedRun: next }
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  const captured = reduceCapturedRun(state, action)
  if (captured !== null) return captured
  switch (action.type) {
    case 'catalog/loaded': {
      const { scenarios } = action
      const keep = scenarios.some((scenario) => scenario.scenario_id === state.selectedScenarioId)
      const selectedScenarioId = keep ? state.selectedScenarioId : (scenarios[0]?.scenario_id ?? null)
      return { ...state, catalog: { status: 'ready', scenarios }, selectedScenarioId }
    }
    case 'catalog/failed':
      return { ...state, catalog: { status: 'failed', scenarios: [] }, selectedScenarioId: null, error: action.error }
    case 'scenario/selected': {
      const known = state.catalog.scenarios.some((scenario) => scenario.scenario_id === action.scenarioId)
      if (!known || isRunActive(state) || action.scenarioId === state.selectedScenarioId) return state
      return { ...state, selectedScenarioId: action.scenarioId }
    }
    case 'run/requested': {
      const blocker = startBlocker(state, action.requestText)
      if (blocker !== null) return { ...state, error: studioError(blocker) }
      const scenarioId = state.selectedScenarioId as string
      const selected = state.catalog.scenarios.find((scenario) => scenario.scenario_id === scenarioId)
      // The start binds the execution family of its case; a legacy start keeps its exact shape.
      const pendingStart: PendingStart =
        selected !== undefined && isCapturedScenario(selected)
          ? { scenarioId, requestText: action.requestText, executionKind: CAPTURED_EXECUTION_KIND }
          : { scenarioId, requestText: action.requestText }
      return { ...state, pendingStart, error: null }
    }
    case 'run/started':
      if (state.pendingStart === null) return state
      if (state.pendingStart.executionKind === CAPTURED_EXECUTION_KIND) {
        return { ...state, pendingStart: null, capturedRun: createCapturedRun(state.pendingStart, action.start), error: null }
      }
      return { ...state, pendingStart: null, run: createRun(state.pendingStart, action.start), error: null }
    case 'run/rejected':
      if (state.pendingStart === null) return state
      return { ...state, pendingStart: null, error: action.error }
    case 'stream/opened':
      return updateRun(state, action.runId, (run) =>
        run.stream.status === 'connecting' ? { ...run, stream: { ...run.stream, status: 'open' } } : run,
      )
    case 'stream/event':
      return updateRun(state, action.runId, (run) => acceptEvent(run, action.event))
    case 'stream/failed':
      return updateRun(state, action.runId, (run) =>
        isLive(run.stream) ? { ...run, stream: { ...run.stream, status: 'rejected', error: action.error } } : run,
      )
    case 'stream/disconnected':
      return updateRun(state, action.runId, (run) =>
        isLive(run.stream) ? { ...run, stream: { ...run.stream, status: 'disconnected', error: studioError('STREAM_DISCONNECTED') } } : run,
      )
    case 'result/received':
      return updateRun(state, action.runId, (run) => acceptResult(run, action.result))
    case 'result/failed':
      return updateRun(state, action.runId, (run) =>
        run.status === 'finalized' ? run : { ...run, status: 'failed', result: null, error: action.error },
      )
  }
}

/** Maps one run's live stream callbacks onto actions tagged with that run. */
export function runEventHandlers(runId: string, dispatch: (action: StudioAction) => void): RunEventHandlers {
  return {
    onOpen: () => dispatch({ type: 'stream/opened', runId }),
    onEvent: (event) => dispatch({ type: 'stream/event', runId, event }),
    onError: (error) => dispatch({ type: 'stream/failed', runId, error }),
    onDisconnect: () => dispatch({ type: 'stream/disconnected', runId }),
  }
}

export interface GateRow {
  readonly gateId: GateId
  readonly status: GateStatus | 'pending'
  readonly reasonCode: string | null
  /** The complete outcome once the authoritative result exists; null while provisional. */
  readonly outcome: GateOutcome | null
}

/** All nine gates in contract order: final outcomes when finalized, otherwise event summaries. */
export function selectGateRows(run: RunView | null): readonly GateRow[] {
  return GATE_IDS.map((gateId) => {
    const summary = run?.gates[gateId]
    const outcome = run?.status === 'finalized' ? (run.result.gates.find((gate) => gate.gate_id === gateId) ?? null) : null
    return { gateId, status: summary?.status ?? 'pending', reasonCode: summary?.reason_code ?? null, outcome }
  })
}

export interface ProofTrailEvidence {
  readonly evidenceId: string
  readonly type: EvidenceType
}

export interface ProofTrailCapture {
  readonly phase: EvidencePhase
  /** This phase's Evidence IDs that the session received or a final gate cites, in contract type order. */
  readonly evidence: readonly ProofTrailEvidence[]
  /** The phase screenshot the result records; null when the run never took one. */
  readonly screenshotPath: string | null
  /** The screenshot's Evidence ID; null unless the session received it. */
  readonly screenshotEvidenceId: string | null
}

/** Who produced the diagnosis: the live Meta model or a clearly labeled injected fixture. */
export type ProofTrailProvenance =
  | { readonly kind: 'meta'; readonly model: string }
  | { readonly kind: 'fixture'; readonly label: string }

export interface ProofTrailView {
  readonly runId: string
  readonly status: RunStatus
  readonly failedGateIds: readonly GateId[]
  readonly provenance: ProofTrailProvenance
  readonly failure: ProofTrailCapture
  readonly replay: ProofTrailCapture
  /** True when the result records a validated candidate diff. */
  readonly candidateDiff: boolean
  /** All nine final outcomes in contract order. */
  readonly gates: readonly GateOutcome[]
  readonly durations: PhaseDurations
  readonly totalDurationMs: number
}

function captureOf(phase: EvidencePhase, evidenceIds: ReadonlySet<string>, screenshotPath: string | null): ProofTrailCapture {
  const evidence: ProofTrailEvidence[] = []
  for (const evidenceId of evidenceIds) {
    const parts = evidenceIdParts(evidenceId)
    if (parts !== null && parts.phase === phase) evidence.push({ evidenceId, type: parts.type })
  }
  evidence.sort((a, b) => EVIDENCE_TYPES.indexOf(a.type) - EVIDENCE_TYPES.indexOf(b.type) || a.evidenceId.localeCompare(b.evidenceId))
  // A screenshot ID counts only when the result also records that the screenshot was persisted.
  const screenshot = screenshotPath === null ? undefined : evidence.find((item) => item.type === 'screenshot')
  return { phase, evidence, screenshotPath, screenshotEvidenceId: screenshot?.evidenceId ?? null }
}

/**
 * The in-workspace Proof Trail of a finalized run, built only from its authoritative result and the
 * Evidence IDs the session already holds: those announced live and those the final gates cite. Phases
 * the run never reached have no evidence, screenshot, or diff; nothing is inferred from artifact paths.
 */
export function selectProofTrail(run: RunView | null): ProofTrailView | null {
  if (run === null || run.status !== 'finalized') return null
  const { result } = run
  const known = new Set([...run.evidenceIds, ...result.gates.flatMap((gate) => gate.evidence_ids)])
  const gates = GATE_IDS.map((gateId) => result.gates.find((gate) => gate.gate_id === gateId)).filter((gate) => gate !== undefined)
  return {
    runId: run.runId,
    status: result.status,
    failedGateIds: result.failed_gate_ids,
    provenance:
      result.provider.mode === 'fixture'
        ? { kind: 'fixture', label: result.provider.injected_fault_label ?? '' }
        : { kind: 'meta', model: result.provider.model ?? '' },
    failure: captureOf('failure', known, result.failure_screenshot_path),
    replay: captureOf('replay', known, result.replay_screenshot_path),
    candidateDiff: result.candidate_diff_path !== null,
    gates,
    durations: result.phase_durations_ms,
    totalDurationMs: result.total_duration_ms,
  }
}

// ---------------------------------------------------------------------------------------
// Captured verification selectors
// ---------------------------------------------------------------------------------------

export type StudioMode = 'legacy' | 'captured'

/** The host-selected mode, read from the catalog discriminator only; never chosen by the browser. */
export const selectStudioMode = (state: StudioState): StudioMode => (state.catalog.scenarios.some(isCapturedScenario) ? 'captured' : 'legacy')

/**
 * What the target frame may be presented as: the data model's baseline live, candidate live,
 * preparation/non-live (`not-live`), or completed captured evidence.
 */
export type CapturedTargetPresentation = 'baseline-live' | 'not-live' | 'candidate-live' | 'completed-evidence'

/** The evidence phase each measured phase captures from the frame it shows. */
const MEASURED_PHASE_EVIDENCE: Partial<Readonly<Record<RunState, EvidencePhase>>> = { reproducing: 'failure', replaying: 'replay' }

/**
 * The target presentation, derived only from actual activity and the strict result. The engine
 * starts a measured phase only after the actual frame was reconnected to that phase's build and
 * its trusted probe reported it ready; building, serving and reconnecting are not-live activity of
 * the prior phase, while the frame may still show the launch preview or the baseline. So the frame
 * is live from that measured phase start for as long as only that phase's own evidence follows it;
 * any other activity (the failure captured, scanning, releasing the target, finalizing) means the
 * run moved on, and evidence without its delivered phase start proves nothing. Without a live
 * stream, or once no valid result can be read, nothing vouches for the frame. Completed evidence
 * needs the bound strict result.
 */
export function selectCapturedTarget(run: CapturedRunView | undefined): CapturedTargetPresentation | null {
  if (run === undefined) return null
  if (run.status === 'finalized') return 'completed-evidence'
  if (run.status !== 'running' || !isLive(run.stream)) return 'not-live'
  let start = run.activity.length - 1
  while (start >= 0 && run.activity[start]?.type === 'evidence_added') start -= 1
  const announced = run.activity[start]
  if (announced?.type !== 'phase_started' || announced.phase === null) return 'not-live'
  const phase = MEASURED_PHASE_EVIDENCE[announced.phase]
  if (phase === undefined) return 'not-live'
  const ownEvidence = run.activity
    .slice(start + 1)
    .every((event) => event.phase === announced.phase && event.evidence_ids.every((id) => evidenceIdParts(id)?.phase === phase))
  if (!ownEvidence) return 'not-live'
  return phase === 'failure' ? 'baseline-live' : 'candidate-live'
}

/** The ten check rows, only from the strict final result; none while running or without one. */
export const selectCapturedChecks = (run: CapturedRunView | undefined): readonly CapturedCheck[] =>
  run?.status === 'finalized' ? run.result.checks : []

/** Final labels; only `passed` is a Candidate verification passed claim, and none is Verified Fix. */
export const CAPTURED_STATUS_LABELS: Readonly<Record<CapturedStatus, string>> = {
  passed: 'Candidate verification passed',
  failed: 'Candidate verification failed',
  error: 'Candidate verification error',
  interrupted: 'Candidate verification interrupted',
}

export interface CapturedOutcomeView {
  readonly status: CapturedStatus
  readonly label: string
  /** The fixed outcome reason of a non-passing result; null when it passed. */
  readonly reasonCode: string | null
  /** The fixed bounded message of that reason; null when it passed. */
  readonly message: string | null
}

/** Hex digits shown of the candidate patch digest and the recorded baseline commit. */
export const CAPTURED_SHORT_ID_LENGTH = 12

export interface CapturedIdentityView {
  readonly candidateDigest: string
  readonly candidateDigestShort: string
  readonly baselineCommit: string
  readonly baselineCommitShort: string
  /** The inherited coverage note; null when the candidate's coverage has none. */
  readonly coverageNote: string | null
}

/** The executed candidate identity and coverage of a finalized captured run, from its strict result only. */
export function selectCapturedIdentity(run: CapturedRunView | undefined): CapturedIdentityView | null {
  if (run?.status !== 'finalized') return null
  const { candidate_patch_sha256: candidateDigest, baseline_commit: baselineCommit, coverage } = run.result
  return {
    candidateDigest,
    candidateDigestShort: candidateDigest.slice(0, CAPTURED_SHORT_ID_LENGTH),
    baselineCommit,
    baselineCommitShort: baselineCommit.slice(0, CAPTURED_SHORT_ID_LENGTH),
    coverageNote: coverage.note,
  }
}

/** The final outcome of a finalized captured run, from its strict result only. */
export function selectCapturedOutcome(run: CapturedRunView | undefined): CapturedOutcomeView | null {
  if (run?.status !== 'finalized') return null
  const { status, reason_code: reasonCode, message } = run.result
  return { status, label: CAPTURED_STATUS_LABELS[status], reasonCode, message }
}

/**
 * One side of the completed captured evidence. `shown` names the one screenshot Evidence ID to show;
 * `not-produced` means the strict result records no evidence for the side; `not-received` means it
 * records the evidence, but this session did not receive exactly one screenshot Evidence ID for it
 * with that phase's manifest, so nothing is shown rather than an ID being guessed.
 */
export interface CapturedEvidenceSide {
  readonly side: 'before' | 'after'
  readonly phase: EvidencePhase
  readonly state: 'shown' | 'not-produced' | 'not-received'
  readonly evidenceId: string | null
}

/** The captured before/after evidence that replaces the released target once the run finalized. */
export interface CapturedCompletedEvidence {
  readonly runId: string
  /** The recorded baseline, from the failure capture. */
  readonly before: CapturedEvidenceSide
  /** The candidate build, from the replay capture. */
  readonly after: CapturedEvidenceSide
}

function evidenceSide(run: Extract<CapturedRunView, { status: 'finalized' }>, side: 'before' | 'after'): CapturedEvidenceSide {
  const phase: EvidencePhase = side === 'before' ? 'failure' : 'replay'
  const reference = side === 'before' ? run.result.before_evidence : run.result.after_evidence
  if (reference === null) return { side, phase, state: 'not-produced', evidenceId: null }
  // Only screenshots of this phase, announced by this run's accepted events together with exactly
  // the manifest the strict result records for the phase.
  const screenshots = new Set<string>()
  for (const event of run.activity) {
    if (event.type !== 'evidence_added' || !event.artifact_refs.includes(reference.manifest_path)) continue
    for (const id of event.evidence_ids) {
      const parts = evidenceIdParts(id)
      if (parts?.phase === phase && parts.type === 'screenshot') screenshots.add(id)
    }
  }
  const [evidenceId] = screenshots
  return screenshots.size === 1 && evidenceId !== undefined ? { side, phase, state: 'shown', evidenceId } : { side, phase, state: 'not-received', evidenceId: null }
}

/**
 * The completed captured evidence of a finalized captured run: for each side the strict result
 * records, the one screenshot Evidence ID its run announced with that phase's manifest. It is read
 * only through the closed evidence route of that run; nothing is derived from artifact paths or
 * Evidence ID numbering. None exists before the bound strict result or without one.
 */
export function selectCapturedEvidence(run: CapturedRunView | undefined): CapturedCompletedEvidence | null {
  if (run?.status !== 'finalized') return null
  return { runId: run.runId, before: evidenceSide(run, 'before'), after: evidenceSide(run, 'after') }
}

export interface CapturedCleanupView {
  readonly complete: boolean
  readonly remainingOwnedResources: CapturedVerificationResult['cleanup']['remaining_owned_resources']
  readonly originalUnchanged: boolean
  readonly originalMismatches: CapturedVerificationResult['cleanup']['original_mismatches']
}

/** The cleanup and original-integrity facts of a finalized captured run, from its strict result only. */
export function selectCapturedCleanup(run: CapturedRunView | undefined): CapturedCleanupView | null {
  if (run?.status !== 'finalized') return null
  const { cleanup } = run.result
  return {
    complete: cleanup.complete,
    remainingOwnedResources: cleanup.remaining_owned_resources,
    originalUnchanged: cleanup.original_unchanged,
    originalMismatches: cleanup.original_mismatches,
  }
}

/** How many of the ten checks passed, failed, or were not evaluated, from the strict result only. */
export function selectCapturedCheckSummary(run: CapturedRunView | undefined): Readonly<Record<CapturedCheck['status'], number>> | null {
  if (run?.status !== 'finalized') return null
  const summary = { pass: 0, fail: 0, unevaluable: 0 }
  for (const check of run.result.checks) summary[check.status] += 1
  return summary
}
