import { useId } from 'react'

import { isValidRequestText, studioError } from '../api.js'
import type { CapturedCheckId, CapturedCheckStatus, CapturedVerificationResult, RunState, StudioError, StudioEventType } from '../api.js'
import { canStartRun, selectCapturedCheckSummary, selectCapturedChecks, selectCapturedCleanup, selectCapturedIdentity, selectCapturedOutcome } from '../state.js'
import type { CapturedRunView, StreamStatus, StudioState } from '../state.js'

// The candidate-verification surface of a host-fixed captured verification Studio. It takes the
// place of the Meta chat and the nine legacy gates in the work panel: one action, the panel's entry,
// starts this launch's one verification run with the case's committed goal, the current stage and
// the bounded activity come from accepted live events, and the ten check rows, the final status,
// the short candidate digest and baseline, the coverage note, and the cleanup and original-integrity
// facts come only from the strict result bound to this run. Every value is rendered as text, errors
// show only the client-authored message for their stable code, and the surface never claims more
// than candidate verification. Its captured before/after screenshots replace the released target
// pane. The final status carries `data-workspace-result` for the collapsed workspace's result entry.

export interface CapturedVerificationProps {
  /** The Studio state from `studioReducer`; the surface never changes it. */
  readonly state: StudioState
}

export interface CapturedStartProps {
  /** The Studio state from `studioReducer`; the action never changes it. */
  readonly state: StudioState
  /** The committed goal of the prepared case, sent with the start. */
  readonly requestText: string
  /** Called only while this launch's one run may start. */
  readonly onStart: (requestText: string) => void
}

/** The captured flow's stages; the legacy-only phases are refused by the reducer before display. */
const STAGE_LABELS: Readonly<Record<RunState, string>> = {
  initialized: 'Admitted the candidate; preparing the recorded baseline',
  reproducing: 'Reproducing the prepared defect on the recorded baseline',
  failure_captured: 'Baseline failure captured',
  applying: 'Preparing the candidate: application, build, and functional check',
  replaying: 'Replaying the prepared scenario on the candidate build',
  finalized: 'Finalized',
  diagnosing: 'Not part of candidate verification',
  candidate_validated: 'Not part of candidate verification',
}

export const CAPTURED_CHECK_LABELS: Readonly<Record<CapturedCheckId, string>> = {
  input_valid: 'Input valid',
  baseline_reproduced: 'Baseline defect reproduced',
  application_complete: 'Candidate applied completely',
  build_passed: 'Registered build passed',
  tests_passed: 'Trusted functional check passed',
  dataset_matches: 'Replay dataset matches',
  canvas_matches: 'Replay canvas matches',
  secret_scan_clean: 'Secret scan clean',
  cleanup_complete: 'Cleanup complete',
  original_unchanged: 'Original repository unchanged',
}

const CHECK_STATUS_LABELS: Readonly<Record<CapturedCheckStatus, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  unevaluable: 'Unevaluable',
}

/** The owned resources a cleanup could leave behind, as the strict result names them. */
const CLEANUP_RESOURCE_LABELS: Readonly<Record<CapturedVerificationResult['cleanup']['remaining_owned_resources'][number], string>> = {
  target_runtime: 'Target app and frame',
  browser_capture: 'Browser capture',
  operation: 'Running operation',
  worktree: 'Owned worktree',
  private_git_state: 'Private Git state',
}

const EVENT_LABELS: Readonly<Record<StudioEventType, string>> = {
  chat_received: 'Request received',
  phase_started: 'Stage',
  phase_completed: 'Stage completed',
  evidence_added: 'Evidence',
  diagnosis_ready: 'Diagnosis ready',
  candidate_ready: 'Candidate ready',
  gate_updated: 'Gate updated',
  run_finalized: 'Finalized',
  agent_message: 'Activity',
}

const STREAM_LABELS: Readonly<Record<StreamStatus, string>> = {
  connecting: 'Connecting to live activity',
  open: 'Live activity connected',
  ended: 'Live activity ended',
  disconnected: 'Live activity disconnected',
  rejected: 'Live activity stopped',
}

/** Only the most recent activity is listed; the stream itself is bounded by the engine. */
const MAX_LISTED_ACTIVITY = 40

const NO_MODEL_STATEMENT = 'No model diagnosis or citations were evaluated in this verification.'

/** The client-authored message for an error's stable code; text carried by the error is never shown. */
const safeError = (error: StudioError): StudioError => studioError(error.code)

function ErrorNotice({ error }: { readonly error: StudioError }) {
  const safe = safeError(error)
  return (
    <p className="captured__error" role="alert" data-code={safe.code}>
      {safe.message}
    </p>
  )
}

function startHint(state: StudioState): string {
  const run = state.capturedRun
  if (state.catalog.status === 'loading') return 'Loading the prepared case.'
  if (state.catalog.status === 'failed') return studioError('SESSION_NOT_READY').message
  if (state.pendingStart !== null) return 'Starting the candidate verification.'
  if (run?.status === 'running') return 'The candidate verification is in progress.'
  if (run !== undefined) return 'This Studio ran its one candidate verification. Close the Studio to finish.'
  return 'Verifies the captured candidate at its recorded baseline with the trusted build, functional check, and replay.'
}

/** The fixed candidate's one verification action; no request field, chat or model choice. */
export function CapturedStart({ state, requestText, onStart }: CapturedStartProps) {
  const hintId = useId()
  const canStart = canStartRun(state) && isValidRequestText(requestText)
  const start = (): void => {
    // Re-checked at click time, so a duplicate or second start never reaches the workspace.
    if (canStartRun(state) && isValidRequestText(requestText)) onStart(requestText)
  }
  return (
    <section className="agent-panel__section captured-start" aria-label="Start">
      <p id={hintId} className="captured-start__hint" role="status">
        {startHint(state)}
      </p>
      {state.error !== null && <ErrorNotice error={state.error} />}
      <button className="captured-start__button button button--primary" type="button" disabled={!canStart} aria-describedby={hintId} onClick={start}>
        {state.pendingStart === null ? 'Start candidate verification' : 'Starting'}
      </button>
    </section>
  )
}

function FinalStatus({ run }: { readonly run: CapturedRunView | undefined }) {
  if (run === undefined) {
    return (
      <p className="captured-status__final" role="status" data-captured-status="none">
        No candidate verification yet.
      </p>
    )
  }
  if (run.status === 'running') {
    return (
      <p className="captured-status__final" role="status" data-captured-status="pending">
        Final status pending until the strict verification result is available.
      </p>
    )
  }
  if (run.status === 'failed') {
    const safe = safeError(run.error)
    return (
      <p className="captured-status__final" role="status" data-captured-status="unavailable" data-code={safe.code}>
        No final status. {safe.message}
      </p>
    )
  }
  const outcome = selectCapturedOutcome(run)
  if (outcome === null) return null
  return (
    <div className="captured-status__final" role="status" data-captured-status={outcome.status} data-workspace-result="" tabIndex={-1}>
      <p className="captured-status__verdict">{outcome.label}</p>
      {outcome.reasonCode !== null && (
        <p className="captured-status__reason">
          <code>{outcome.reasonCode}</code> {outcome.message}
        </p>
      )}
    </div>
  )
}

function RunStatus({ run }: { readonly run: CapturedRunView | undefined }) {
  const identity = selectCapturedIdentity(run)
  return (
    <section className="agent-panel__section captured-status" aria-label="Verification status">
      <h3 className="agent-panel__heading">Status</h3>
      <FinalStatus run={run} />
      {run !== undefined && (
        <dl className="captured-status__details">
          <div className="captured-status__row">
            <dt>Stage</dt>
            <dd data-phase={run.phase ?? 'none'}>{run.phase === null ? 'Not reported yet' : STAGE_LABELS[run.phase]}</dd>
          </div>
          <div className="captured-status__row">
            <dt>Live activity</dt>
            <dd data-stream={run.stream.status}>{STREAM_LABELS[run.stream.status]}</dd>
          </div>
          {identity !== null && (
            <>
              <div className="captured-status__row">
                <dt>Candidate patch SHA-256</dt>
                <dd>
                  <code data-candidate-digest={identity.candidateDigest}>{identity.candidateDigestShort}</code>
                </dd>
              </div>
              <div className="captured-status__row">
                <dt>Recorded baseline</dt>
                <dd>
                  <code data-baseline-commit={identity.baselineCommit}>{identity.baselineCommitShort}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
      )}
      {identity?.coverageNote != null && <p className="captured-status__coverage">{identity.coverageNote}</p>}
      <p className="captured-status__scope">{NO_MODEL_STATEMENT}</p>
      {run !== undefined && run.stream.error !== null && <ErrorNotice error={run.stream.error} />}
    </section>
  )
}

function ActivityLog({ run }: { readonly run: CapturedRunView | undefined }) {
  const activity = (run?.activity ?? []).slice(-MAX_LISTED_ACTIVITY)
  return (
    <section className="agent-panel__section agent-activity" aria-label="Verification activity">
      <h3 className="agent-panel__heading">Activity</h3>
      {activity.length === 0 ? (
        <p className="agent-panel__empty">{run === undefined ? 'No activity yet.' : 'Waiting for live activity.'}</p>
      ) : (
        // Rendered in the accepted order; missed events are neither inferred nor reordered.
        <div className="agent-activity__log" role="log" aria-label="Ordered verification activity">
          <ol className="agent-activity__list">
            {activity.map((event) => (
              <li key={event.event_id} className="agent-activity__item" data-type={event.type} data-phase={event.phase ?? 'none'}>
                <p className="agent-activity__meta">
                  <span className="agent-activity__sequence">#{event.sequence}</span> <span className="agent-activity__type">{EVENT_LABELS[event.type]}</span>
                </p>
                <p className="agent-activity__message">{event.message}</p>
                {event.evidence_ids.length > 0 && <p className="agent-activity__detail">{event.evidence_ids.length} Evidence IDs announced.</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function CheckTable({ run }: { readonly run: CapturedRunView | undefined }) {
  const checks = selectCapturedChecks(run)
  const summary = selectCapturedCheckSummary(run)
  return (
    <section className="agent-panel__section captured-checks" aria-label="Verification checks">
      <h3 className="agent-panel__heading">Checks</h3>
      {checks.length === 0 ? (
        <p className="agent-panel__empty">The ten check outcomes appear only with the strict verification result.</p>
      ) : (
        <table className="captured-checks__table">
          <caption className="captured-checks__caption">
            Outcomes from the strict verification result
            {summary !== null && `: ${summary.pass} passed, ${summary.fail} failed, ${summary.unevaluable} not evaluated`}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Status</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.check_id} className="captured-check" data-check={check.check_id} data-status={check.status}>
                <th scope="row">{CAPTURED_CHECK_LABELS[check.check_id]}</th>
                <td>{CHECK_STATUS_LABELS[check.status]}</td>
                <td>
                  <code>{check.reason_code}</code> {check.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const yesNo = (value: boolean): string => (value ? 'Yes' : 'No')

/** The release and original-integrity facts the strict result records; none before it exists. */
function CleanupFacts({ run }: { readonly run: CapturedRunView | undefined }) {
  const cleanup = selectCapturedCleanup(run)
  if (cleanup === null) return null
  return (
    <section
      className="agent-panel__section captured-cleanup"
      aria-label="Cleanup and original integrity"
      data-cleanup-complete={String(cleanup.complete)}
      data-original-unchanged={String(cleanup.originalUnchanged)}
    >
      <h3 className="agent-panel__heading">Cleanup and original integrity</h3>
      <dl className="captured-status__details">
        <div className="captured-status__row">
          <dt>Owned resources released</dt>
          <dd>{yesNo(cleanup.complete)}</dd>
        </div>
        {cleanup.remainingOwnedResources.length > 0 && (
          <div className="captured-status__row">
            <dt>Not released</dt>
            <dd>{cleanup.remainingOwnedResources.map((resource) => CLEANUP_RESOURCE_LABELS[resource]).join(', ')}</dd>
          </div>
        )}
        <div className="captured-status__row">
          <dt>Original repository unchanged</dt>
          <dd>{yesNo(cleanup.originalUnchanged)}</dd>
        </div>
        {cleanup.originalMismatches.length > 0 && (
          <div className="captured-status__row">
            <dt>Changed or unverified</dt>
            <dd>
              <code>{cleanup.originalMismatches.join(', ')}</code>
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

/** The candidate-verification stage, activity, checks, cleanup facts, and final status. */
export function CapturedVerification({ state }: CapturedVerificationProps) {
  const run = state.capturedRun
  return (
    <div className="captured" data-run-id={run?.runId ?? 'none'}>
      <RunStatus run={run} />
      <ActivityLog run={run} />
      <CheckTable run={run} />
      <CleanupFacts run={run} />
    </div>
  )
}
