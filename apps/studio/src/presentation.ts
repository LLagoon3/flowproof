import { selectCapturedOutcome, selectCapturedTarget, selectStudioMode } from './state.js'
import type { RunState, StudioEvent } from './api.js'
import type { CapturedOutcomeView, CapturedRunView, RunView, StreamStatus, StudioMode, StudioState } from './state.js'

// The local presentation of the Studio workspace (Spec 005). It holds only layout choices of this
// page: the work panel's width and whether it is collapsed. They never reach the run reducer, the
// client, a stored preference or the network, so choosing a width or collapsing the panel cannot
// start, cancel, reload or refetch anything.
//
// While the target is being measured, a layout change would move the frame between the engine's
// reading of the Canvas box and its clipped page screenshot. `selectMeasuringTarget` names the
// phases in which the engine may be measuring, from the observed run, and the shell keeps layout
// requests until such a phase ends. Lost live activity ends only what the page can see, not the
// engine's work, so it never ends a phase by itself.
//
// The run presentation (slice 3) is the one projection of the accepted, run-bound events and the
// authoritative result that both the work panel and the compact status outside a collapsed panel
// show. It keeps three dimensions apart: what execution was observed, whether live activity is
// connected, and the verdict. Live activity is advisory: a stream that ended, disconnected or was
// rejected is at most a separate notice, never a verdict. A verdict appears only with a valid bound
// final result, and it is that family's exact label; afterwards no late event revises it.

/** The seven work-panel width choices, in rem; the CSS backs each with a class-like attribute rule. */
export const PANEL_WIDTHS_REM = Object.freeze([20, 22, 24, 26, 28, 30, 32] as const)

/** An index into `PANEL_WIDTHS_REM`. */
export type PanelWidthStep = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** The 24rem choice. */
export const DEFAULT_PANEL_WIDTH_STEP: PanelWidthStep = 2

const LAST_STEP: PanelWidthStep = 6

export interface WorkspacePresentation {
  /** One of seven integer width choices; the default is the 24rem choice. */
  readonly panelWidthStep: PanelWidthStep
  /** Whether the work panel is hidden; never run cancellation or event unsubscription. */
  readonly panelCollapsed: boolean
}

export const initialWorkspacePresentation: WorkspacePresentation = Object.freeze({
  panelWidthStep: DEFAULT_PANEL_WIDTH_STEP,
  panelCollapsed: false,
})

export type WorkspaceAction =
  | { readonly type: 'panel/width'; readonly step: number }
  | { readonly type: 'panel/collapse' }
  | { readonly type: 'panel/restore' }

/** The width choice nearest to `step`; a value that is not a number keeps the default. */
function toStep(step: number): PanelWidthStep {
  if (!Number.isFinite(step)) return DEFAULT_PANEL_WIDTH_STEP
  return Math.min(LAST_STEP, Math.max(0, Math.round(step))) as PanelWidthStep
}

/** Applies one layout choice; an unchanged choice returns the same object. */
export function workspaceReducer(state: WorkspacePresentation, action: WorkspaceAction): WorkspacePresentation {
  switch (action.type) {
    case 'panel/width': {
      const panelWidthStep = toStep(action.step)
      return panelWidthStep === state.panelWidthStep ? state : { ...state, panelWidthStep }
    }
    case 'panel/collapse':
      return state.panelCollapsed ? state : { ...state, panelCollapsed: true }
    case 'panel/restore':
      return state.panelCollapsed ? { ...state, panelCollapsed: false } : state
  }
}

/** The width of a choice, in rem. */
export const panelWidthRem = (step: PanelWidthStep): number => PANEL_WIDTHS_REM[step]

const KEY_STEPS: Readonly<Record<string, (step: PanelWidthStep) => number>> = {
  ArrowLeft: (step) => step - 1,
  ArrowDown: (step) => step - 1,
  ArrowRight: (step) => step + 1,
  ArrowUp: (step) => step + 1,
  Home: () => 0,
  End: () => LAST_STEP,
}

/** The width choice a separator key selects from `step`; null for a key the separator ignores. */
export function panelWidthStepForKey(step: PanelWidthStep, key: string): PanelWidthStep | null {
  const next = Object.hasOwn(KEY_STEPS, key) ? KEY_STEPS[key] : undefined
  return next === undefined ? null : toStep(next(step))
}

/** The width choice nearest to a dragged panel width, in CSS pixels at the page's root font size. */
export function panelWidthStepAt(widthPx: number, rootFontSizePx: number): PanelWidthStep {
  const widthRem = widthPx / rootFontSizePx
  return toStep((widthRem - PANEL_WIDTHS_REM[0]) / 2)
}

// ---------------------------------------------------------------------------------------
// Observed work
// ---------------------------------------------------------------------------------------

/**
 * The fixed captured producer copy that opens finalization: the whole-run secret scan, then the
 * release of the target, operations and owned worktree (`verify/capturedRun.ts`). The engine has no
 * finalizing phase and exports no such signal, so these exact strings are copied here and nowhere
 * else; the real captured E2E checks the coupling against actual producer events. Any other text,
 * however similar, is ordinary activity of the phase it carries.
 */
const CAPTURED_FINALIZING_MARKERS: ReadonlySet<string> = new Set([
  'Scanning the candidate, the evidence, and the run activity for secrets.',
  'Releasing the target, operations, and owned worktree, then comparing the original repository.',
])

/** The legacy gate the engine records first when it finalizes: cleanup and the original-integrity comparison. */
const LEGACY_FINALIZING_GATE = 'original_worktree_unchanged'

/** Whether an accepted event shows that the run reached its finalization, by the exact observed signal of its family. */
const isFinalizingMarker = (mode: StudioMode, event: StudioEvent): boolean =>
  mode === 'captured'
    ? event.type === 'agent_message' && CAPTURED_FINALIZING_MARKERS.has(event.message)
    : event.type === 'gate_updated' && event.gate?.gate_id === LEGACY_FINALIZING_GATE

/**
 * A readable group of already observed activity: a contiguous run of accepted events of one phase,
 * or everything from the first observed finalization signal on. It is neither a separate task nor
 * evidence that unobserved work happened, and it never states a check outcome.
 */
export interface WorkCardView {
  /** Stable for the session: the run and the sequence of the group's first accepted event. */
  readonly id: string
  readonly runId: string
  readonly firstSequence: number
  readonly lastSequence: number
  /** `finalizing` from the exact observed finalization signal; otherwise the group of one phase. */
  readonly kind: 'phase' | 'finalizing'
  /** The existing phase of the group's first event; null when it carried none. Never invented. */
  readonly phase: RunState | null
  readonly title: string
  /** One local sentence about the observed group; no verdict or check outcome. */
  readonly statusText: string
  /** The accepted events of the group, unchanged and in their original order. */
  readonly events: readonly StudioEvent[]
  /** The group most relevant to the pending run: the last one while no result is bound. */
  readonly isCurrent: boolean
}

const WORK_TITLES: Readonly<Record<StudioMode, Readonly<Record<RunState, string>>>> = {
  legacy: {
    initialized: 'Request received',
    reproducing: 'Reproducing the failure',
    failure_captured: 'Failure captured',
    diagnosing: 'Diagnosing',
    candidate_validated: 'Validating the candidate',
    applying: 'Applying the candidate',
    replaying: 'Replaying the scenario',
    finalized: 'Final event',
  },
  captured: {
    initialized: 'Preparing the recorded baseline',
    reproducing: 'Reproducing the prepared defect',
    failure_captured: 'Baseline failure captured',
    // The reducer refuses these legacy-only phases in a captured run before they are displayed.
    diagnosing: 'Activity',
    candidate_validated: 'Activity',
    applying: 'Preparing the candidate',
    replaying: 'Replaying on the candidate build',
    finalized: 'Final event',
  },
}

const FINALIZING_TITLE = 'Finalizing'

const FINALIZING_TEXT: Readonly<Record<StudioMode, string>> = {
  legacy: 'The original-worktree check was observed; the run is finishing. Only the final result decides each gate.',
  captured: 'Secret-scan and cleanup activity was observed; the run is finishing. Checks are reported only in the final result.',
}

/** The final event carries the producer's wording of the outcome, so its group never repeats it. */
const FINAL_EVENT_TEXT = 'The final event arrived; only the authoritative result decides the outcome.'

interface WorkGroup {
  readonly finalizing: boolean
  readonly phase: RunState | null
  readonly events: StudioEvent[]
}

/**
 * Contiguous groups of the accepted events, in order. A phase-less event stays in the group it
 * follows; a phase that recurs after another phase starts a new group. From the first finalization
 * signal on, every event belongs to the one finalizing group. Appending events only extends the last
 * group or adds groups, so earlier groups keep their identity.
 */
function groupWork(mode: StudioMode, activity: readonly StudioEvent[]): WorkGroup[] {
  const groups: WorkGroup[] = []
  let finalizing = false
  for (const event of activity) {
    finalizing ||= isFinalizingMarker(mode, event)
    const last = groups.at(-1)
    const joins = last !== undefined && (finalizing ? last.finalizing : !last.finalizing && (event.phase === null || event.phase === last.phase))
    if (joins) last.events.push(event)
    else groups.push({ finalizing, phase: event.phase, events: [event] })
  }
  return groups
}

function statusTextOf(mode: StudioMode, group: WorkGroup): string {
  if (group.finalizing) return FINALIZING_TEXT[mode]
  if (group.events.some((event) => event.type === 'run_finalized')) return FINAL_EVENT_TEXT
  // The latest progress message of the group, else its phase start: observed engine copy only.
  const message = group.events.findLast((event) => event.type === 'agent_message') ?? group.events.find((event) => event.type === 'phase_started')
  if (message !== undefined) return message.message
  const count = group.events.length
  return `${count} observed ${count === 1 ? 'event' : 'events'}.`
}

function workCards(mode: StudioMode, runId: string, activity: readonly StudioEvent[], pending: boolean): WorkCardView[] {
  const groups = groupWork(mode, activity)
  return groups.map((group, index) => {
    const first = group.events[0] as StudioEvent
    const last = group.events.at(-1) as StudioEvent
    return {
      id: `${runId}:${first.sequence}`,
      runId,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      kind: group.finalizing ? 'finalizing' : 'phase',
      phase: group.phase,
      title: group.finalizing ? FINALIZING_TITLE : group.phase === null ? 'Activity' : WORK_TITLES[mode][group.phase],
      statusText: statusTextOf(mode, group),
      events: group.events,
      isCurrent: pending && index === groups.length - 1,
    }
  })
}

// ---------------------------------------------------------------------------------------
// Run presentation and compact status
// ---------------------------------------------------------------------------------------

export type CompactStatusTone = 'neutral' | 'progress' | 'success' | 'danger' | 'warning'

/**
 * What execution was observed, in precedence order once a run exists: a valid bound final result,
 * a result that could not be read (no verdict), observed finalization, the final event without an
 * observed finalization signal (result pending), or an observed active phase. There is no
 * finalizing execution phase; `finalizing` is shown only from the exact observed signal.
 */
export type ExecutionView = 'loading' | 'unavailable' | 'ready' | 'starting' | 'active' | 'finalizing' | 'result-pending' | 'result-unavailable' | 'final'

export interface RunPresentation {
  readonly mode: StudioMode
  /** The run whose work is shown; null before the first run of this launch. */
  readonly runId: string | null
  readonly execution: ExecutionView
  /** The existing accepted phase of the run; null when none was reported. Never invented. */
  readonly phase: RunState | null
  /** The current state in a few words; a verdict only from a valid bound final result. */
  readonly label: string
  readonly tone: CompactStatusTone
  /** One sentence about the observed current work; null when there is nothing to add. */
  readonly detail: string | null
  /** The supported next action: wait, start, close or relaunch. Never cancel, retry or resume. */
  readonly nextAction: string | null
  /** The exact family verdict; null until a valid bound final result exists. */
  readonly verdict: string | null
  /** The existing live-activity state of the run; null before a run. */
  readonly stream: StreamStatus | null
  /** A live-activity problem, kept apart from execution and result status; null otherwise. */
  readonly activityNotice: string | null
  /** Every accepted event of the run, in readable contiguous groups. */
  readonly cards: readonly WorkCardView[]
}

export interface CompactStatusView {
  /** The current state in a few words; a verdict only from a valid bound final result. */
  readonly label: string
  readonly tone: CompactStatusTone
  /** True only while that final result is shown in the panel, so the restore entry can focus it. */
  readonly hasResult: boolean
  /** A live-activity problem, kept apart from execution and result status; null otherwise. */
  readonly activityNotice: string | null
}

/** The stream states that stop live activity before a result, as the panels word them. */
const ACTIVITY_NOTICES: Readonly<Partial<Record<StreamStatus, string>>> = {
  disconnected: 'Live activity disconnected',
  rejected: 'Live activity stopped',
}

const ACTIVE_LABELS: Readonly<Record<StudioMode, string>> = {
  legacy: 'Run in progress',
  captured: 'Verification in progress',
}

const WAIT_FOR_RESULT: Readonly<Record<StudioMode, string>> = {
  legacy: 'Wait for the result. Closing Studio interrupts the run.',
  captured: 'Wait for the result. Closing Studio interrupts the verification.',
}

const WAIT_WITHOUT_ACTIVITY = 'Wait for the result here; if none arrives, close Studio and launch it again.'

const NO_RESULT_NEXT: Readonly<Record<StudioMode, string>> = {
  legacy: 'You can start another run, or close Studio.',
  captured: 'Close Studio; to verify the candidate again, launch it again.',
}

const READY_NEXT: Readonly<Record<StudioMode, string>> = {
  legacy: 'Review the request, then start the run.',
  captured: 'Start the candidate verification when ready.',
}

const CAPTURED_TONES: Readonly<Record<CapturedOutcomeView['status'], CompactStatusTone>> = {
  passed: 'success',
  failed: 'danger',
  error: 'danger',
  interrupted: 'warning',
}

interface SessionView {
  readonly execution: ExecutionView
  readonly label: string
  readonly tone: CompactStatusTone
  readonly detail: string | null
  readonly nextAction: string | null
}

/** The session states before a run, or before the next one: loading, unavailable, ready, or starting. */
function sessionView(state: StudioState, mode: StudioMode): SessionView {
  if (state.pendingStart !== null) return { execution: 'starting', label: 'Starting', tone: 'progress', detail: 'Waiting for the run to be admitted.', nextAction: null }
  if (state.catalog.status === 'loading') return { execution: 'loading', label: 'Loading', tone: 'neutral', detail: 'Loading the prepared case.', nextAction: null }
  if (state.catalog.status === 'failed' || state.selectedScenarioId === null) {
    return { execution: 'unavailable', label: 'Not ready', tone: 'warning', detail: 'The prepared case is not available.', nextAction: 'Close Studio and launch it again.' }
  }
  return { execution: 'ready', label: 'Ready', tone: 'neutral', detail: 'Nothing runs until you start.', nextAction: READY_NEXT[mode] }
}

const NO_RUN = { runId: null, phase: null, verdict: null, stream: null, activityNotice: null, cards: [] } as const

type AnyRun = RunView | CapturedRunView

/** The verdict and tone of a finalized run's bound result; null when no valid outcome exists. */
function verdictOf(mode: StudioMode, run: AnyRun): { readonly verdict: string; readonly tone: CompactStatusTone } | null {
  if (run.status !== 'finalized') return null
  if (mode === 'captured') {
    const outcome = selectCapturedOutcome(run as CapturedRunView)
    return outcome === null ? null : { verdict: outcome.label, tone: CAPTURED_TONES[outcome.status] }
  }
  const { status } = (run as RunView & { readonly status: 'finalized' }).result
  return { verdict: status, tone: status === 'Verified Fix' ? 'success' : 'danger' }
}

function runView(mode: StudioMode, run: AnyRun): RunPresentation {
  const pending = run.status === 'running'
  const cards = workCards(mode, run.runId, run.activity, pending)
  const base = { mode, runId: run.runId, phase: run.phase, stream: run.stream.status, cards }
  const decided = verdictOf(mode, run)
  if (decided !== null) {
    return { ...base, execution: 'final', label: decided.verdict, tone: decided.tone, detail: null, nextAction: null, verdict: decided.verdict, activityNotice: null }
  }
  const activityNotice = ACTIVITY_NOTICES[run.stream.status] ?? null
  if (!pending) {
    return {
      ...base,
      execution: 'result-unavailable',
      label: 'No final status',
      tone: 'warning',
      detail: 'No valid final result could be read for this run.',
      nextAction: NO_RESULT_NEXT[mode],
      verdict: null,
      activityNotice,
    }
  }
  const nextAction = activityNotice === null ? WAIT_FOR_RESULT[mode] : WAIT_WITHOUT_ACTIVITY
  const current = cards.at(-1)
  const pendingView = { ...base, tone: 'progress', nextAction, verdict: null, activityNotice } as const
  if (current?.kind === 'finalizing') {
    const ended = run.stream.status === 'ended'
    const detail = ended ? `${FINALIZING_TEXT[mode]} The final event arrived; waiting for the authoritative result.` : FINALIZING_TEXT[mode]
    return { ...pendingView, execution: 'finalizing', label: 'Finalizing · verdict pending', detail }
  }
  if (run.activity.some((event) => event.type === 'run_finalized')) {
    return { ...pendingView, execution: 'result-pending', label: 'Result pending', detail: FINAL_EVENT_TEXT }
  }
  const detail = current === undefined ? (activityNotice === null ? 'Waiting for live activity.' : 'No live activity was received.') : currentWorkText(current)
  return { ...pendingView, execution: 'active', label: ACTIVE_LABELS[mode], detail }
}

/** The current group's title and observed text, naming the work once when the text already starts with it. */
function currentWorkText(card: WorkCardView): string {
  return card.statusText.toLowerCase().startsWith(card.title.toLowerCase()) ? card.statusText : `${card.title}: ${card.statusText}`
}

/**
 * The presentation of the current session and its run, from the authoritative Studio state only.
 * Precedence once a run exists: a valid bound final result, then a result that could not be read,
 * then observed finalization, the final event, or the observed phase. A pending legacy start
 * supersedes the previous run's result; that run's work stays inspectable until the next run starts.
 */
export function selectRunPresentation(state: StudioState): RunPresentation {
  const mode = selectStudioMode(state)
  const run: AnyRun | null = mode === 'captured' ? (state.capturedRun ?? null) : state.run
  if (run === null) return { mode, ...NO_RUN, ...sessionView(state, mode) }
  if (mode === 'legacy' && state.pendingStart !== null) {
    const previous = runView(mode, run)
    // The next run reported nothing yet; the previous run's phase and stream are not its own.
    return { ...previous, ...sessionView(state, mode), phase: null, stream: null, verdict: null, activityNotice: null, cards: previous.cards.map((card) => ({ ...card, isCurrent: false })) }
  }
  return runView(mode, run)
}

/** The compact status outside a collapsed panel: the same run presentation, in a few words. */
export const compactStatusOf = (presentation: RunPresentation): CompactStatusView => ({
  label: presentation.label,
  tone: presentation.tone,
  hasResult: presentation.verdict !== null,
  activityNotice: presentation.activityNotice,
})

/** The compact current state of the session, from the authoritative Studio state only. */
export const selectCompactStatus = (state: StudioState): CompactStatusView => compactStatusOf(selectRunPresentation(state))

// ---------------------------------------------------------------------------------------
// Measurement hold
// ---------------------------------------------------------------------------------------

/**
 * The legacy phases in which the engine drives and captures the target frame. Reproduction follows
 * admission at once, so no observed phase yet, and the initial request phase, count as measured too.
 */
const LEGACY_MEASURED_PHASES: ReadonlySet<string> = new Set(['initialized', 'reproducing', 'replaying'])

const isLiveStream = (status: StreamStatus): boolean => status === 'connecting' || status === 'open'

/**
 * Live activity that stopped before the final event: the stream disconnected or was rejected. The
 * engine runs independently of the page's stream, so its later measurements go unseen.
 */
const isLostStream = (status: StreamStatus): boolean => status === 'disconnected' || status === 'rejected'

/** Whether connected captured activity shows a measured phase, read as for a running run. */
function capturedActivityMeasures(run: CapturedRunView): boolean {
  // The live label needs a running run; an unreadable result says nothing about the engine, so the
  // activity of a run whose result could not be read is read the same way. The label is unchanged.
  const target = selectCapturedTarget(run.status === 'running' ? run : { ...run, status: 'running', result: null, error: null })
  return target === 'baseline-live' || target === 'candidate-live'
}

/**
 * Whether the target frame may be being measured now, so the workspace keeps layout requests until
 * the measurement ends. Only the bound result, or the run's final event on its connected live
 * activity, proves the run will measure nothing more. Until then:
 *
 * - With connected live activity, a captured run holds while its activity shows a measured phase,
 *   which the existing target selector derives; its first measurement follows the baseline build,
 *   long after its activity is attached. A legacy run reproduces the defect as soon as it is
 *   admitted, often before its live activity is attached, so it holds from the start request until
 *   a later phase is observed, and again during replay.
 * - Once live activity disconnected or was rejected, the engine measures on unseen, in either mode
 *   and wherever the activity stopped, so the run holds until its bound result. An unreadable
 *   result does not end the run either: connected activity still decides the hold, and without it
 *   the hold stays. None of this presents the frame as live or states a verdict.
 */
export function selectMeasuringTarget(state: StudioState): boolean {
  if (selectStudioMode(state) === 'captured') {
    const run = state.capturedRun
    if (run === undefined || run.status === 'finalized') return false
    if (isLostStream(run.stream.status)) return true
    return isLiveStream(run.stream.status) && capturedActivityMeasures(run)
  }
  if (state.pendingStart !== null) return true
  const { run } = state
  if (run === null || run.status === 'finalized') return false
  if (isLostStream(run.stream.status)) return true
  if (!isLiveStream(run.stream.status)) return false
  return run.phase === null || LEGACY_MEASURED_PHASES.has(run.phase)
}
