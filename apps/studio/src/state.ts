import { GATE_IDS, eventOrderViolation, isValidRequestText, studioError } from './api.js'
import type {
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  RunEventHandlers,
  RunResult,
  RunStart,
  RunState,
  ScenarioSummary,
  StudioError,
  StudioEvent,
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
}

export interface StudioState {
  readonly catalog: { readonly status: CatalogStatus; readonly scenarios: readonly ScenarioSummary[] }
  readonly selectedScenarioId: string | null
  /** A start request in flight; it blocks another start until accepted or rejected. */
  readonly pendingStart: PendingStart | null
  /** The current or most recent run. */
  readonly run: RunView | null
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
  | { readonly type: 'result/received'; readonly runId: string; readonly result: RunResult }
  | { readonly type: 'result/failed'; readonly runId: string; readonly error: StudioError }

export const initialStudioState: StudioState = Object.freeze({
  catalog: Object.freeze({ status: 'loading', scenarios: Object.freeze([]) }),
  selectedScenarioId: null,
  pendingStart: null,
  run: null,
  error: null,
})

const isRunActive = (state: StudioState): boolean => state.pendingStart !== null || state.run?.status === 'running'
const isLive = (stream: StreamView): boolean => stream.status === 'connecting' || stream.status === 'open'

/** True when a new run may be requested: cases loaded, one selected, and no run active. */
export const canStartRun = (state: StudioState): boolean =>
  state.catalog.status === 'ready' && state.selectedScenarioId !== null && !isRunActive(state)

function startBlocker(state: StudioState, requestText: string): string | null {
  if (state.catalog.status !== 'ready') return 'SESSION_NOT_READY'
  if (isRunActive(state)) return 'RUN_ALREADY_ACTIVE'
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

function acceptResult(run: RunView, result: RunResult): RunView {
  if (run.status === 'finalized') return run
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

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
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
      return { ...state, pendingStart: { scenarioId: state.selectedScenarioId as string, requestText: action.requestText }, error: null }
    }
    case 'run/started':
      if (state.pendingStart === null) return state
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
