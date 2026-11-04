import { selectCapturedOutcome, selectCapturedTarget, selectStudioMode } from './state.js'
import type { CapturedOutcomeView, StreamStatus, StudioState } from './state.js'

// The local presentation of the Studio workspace (Spec 005). It holds only layout choices of this
// page: the work panel's width and whether it is collapsed. They never reach the run reducer, the
// client, a stored preference or the network, so choosing a width or collapsing the panel cannot
// start, cancel, reload or refetch anything.
//
// While the target is being measured, a layout change would move the frame between the engine's
// reading of the Canvas box and its clipped page screenshot. `selectMeasuringTarget` names those
// phases from the observed run, and the shell keeps layout requests until the phase ends.
//
// The compact status shown outside a collapsed work panel is derived from the existing
// authoritative state and selectors only. Live activity is advisory: a stream that ended,
// disconnected or was rejected is at most a separate notice, never a verdict. A verdict appears only
// with a valid bound final result, and it is that family's exact label.

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
// Compact status
// ---------------------------------------------------------------------------------------

export type CompactStatusTone = 'neutral' | 'progress' | 'success' | 'danger' | 'warning'

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

const NO_FINAL_STATUS = 'No final status'

const view = (label: string, tone: CompactStatusTone, hasResult = false, activityNotice: string | null = null): CompactStatusView => ({
  label,
  tone,
  hasResult,
  activityNotice,
})

const CAPTURED_TONES: Readonly<Record<CapturedOutcomeView['status'], CompactStatusTone>> = {
  passed: 'success',
  failed: 'danger',
  error: 'danger',
  interrupted: 'warning',
}

/** The session states before any run of this launch: loading, unavailable, ready, or starting. */
function sessionStatus(state: StudioState): CompactStatusView {
  if (state.pendingStart !== null) return view('Starting', 'progress')
  if (state.catalog.status === 'loading') return view('Loading', 'neutral')
  if (state.catalog.status === 'failed' || state.selectedScenarioId === null) return view('Not ready', 'warning')
  return view('Ready', 'neutral')
}

/** The compact current state of the session, from the authoritative Studio state only. */
export function selectCompactStatus(state: StudioState): CompactStatusView {
  if (selectStudioMode(state) === 'captured') {
    const run = state.capturedRun
    if (run === undefined) return sessionStatus(state)
    if (run.status === 'running') return view('Verification in progress', 'progress', false, ACTIVITY_NOTICES[run.stream.status] ?? null)
    if (run.status === 'failed') return view(NO_FINAL_STATUS, 'warning', false, ACTIVITY_NOTICES[run.stream.status] ?? null)
    const outcome = selectCapturedOutcome(run)
    return outcome === null ? view(NO_FINAL_STATUS, 'warning') : view(outcome.label, CAPTURED_TONES[outcome.status], true)
  }
  // A pending start supersedes the previous run, whose result is no longer the current one.
  const { run } = state
  if (state.pendingStart !== null || run === null) return sessionStatus(state)
  if (run.status === 'running') return view('Run in progress', 'progress', false, ACTIVITY_NOTICES[run.stream.status] ?? null)
  if (run.status === 'failed') return view(NO_FINAL_STATUS, 'warning', false, ACTIVITY_NOTICES[run.stream.status] ?? null)
  return view(run.result.status, run.result.status === 'Verified Fix' ? 'success' : 'danger', true)
}

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
 * Whether the target frame may be being measured now, so the workspace keeps layout requests until
 * the measurement ends. A captured run is measured while its target is presented as live, which the
 * existing selector derives from the observed measured phase; its first measurement follows the
 * baseline build, long after its activity is attached. A legacy run reproduces the defect as soon
 * as it is admitted, often before its live activity is attached, so it holds from the start request
 * until a later phase is observed, and again during replay. Without live activity, or once a result
 * decided the run, nothing holds.
 */
export function selectMeasuringTarget(state: StudioState): boolean {
  if (selectStudioMode(state) === 'captured') {
    const target = selectCapturedTarget(state.capturedRun)
    return target === 'baseline-live' || target === 'candidate-live'
  }
  if (state.pendingStart !== null) return true
  const { run } = state
  if (run === null || run.status !== 'running' || !isLiveStream(run.stream.status)) return false
  return run.phase === null || LEGACY_MEASURED_PHASES.has(run.phase)
}
