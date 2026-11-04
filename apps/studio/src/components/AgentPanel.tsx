import { useId } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'

import { MAX_REQUEST_TEXT_LENGTH, isValidRequestText, studioError } from '../api.js'
import type { GateId, GateStatus, GateSummary, StudioError, StudioEvent, StudioEventType } from '../api.js'
import type { ResultSummaryView, RunPresentation } from '../presentation.js'
import { canStartRun, selectGateRows, selectStudioMode } from '../state.js'
import type { CandidateAvailability, RunView, StudioState } from '../state.js'
import { CapturedVerification } from './CapturedVerification.js'
import { ResultSummary } from './ResultSummary.js'
import { WorkTimeline } from './WorkTimeline.js'
import type { ActivityWarning } from './WorkTimeline.js'

// The agent work of the Studio's work panel: the observed work (a short summary and the Details
// of every accepted event, in `WorkTimeline`) and, once the authoritative run result is bound, its
// concise result (`ResultSummary`): the exact verdict, a short explanation and every failed or
// unevaluable gate by name. The rest stays in the closed Details on demand: the nine verification
// gates, announced Evidence IDs, candidate status and the run's Proof Trail. The panel also exports
// the bounded request composer that the work panel shows as its entry. They only render the state
// they are given and report request intent through callbacks; the workspace owns the client and
// the run. Every value is rendered as text, errors show only the client-authored message for their
// stable code, and the final status comes only from the authoritative run result. A host-fixed
// captured verification Studio shows its candidate-verification work instead: no chat, legacy
// gates, diagnosis, provider or candidate-diff section. A final status carries
// `data-workspace-result`, so the collapsed workspace can return focus to it.

export interface AgentPanelProps {
  /** The Studio state from `studioReducer`; the panel never changes it. */
  readonly state: StudioState
  /** The run presentation of that state, the same one the collapsed workspace status shows. */
  readonly presentation: RunPresentation
  /** The concise final result of the current run (`selectResultSummary`); null without a bound result. */
  readonly summary: ResultSummaryView | null
  /** Shows the stored before/after evidence of the finalized run in the canvas. */
  readonly onCompare: () => void
  /** The legacy run's Proof Trail, kept mounted inside the Details once they exist. */
  readonly resultDetails?: ReactNode
}

export interface RequestComposerProps {
  /** The Studio state from `studioReducer`; the composer never changes it. */
  readonly state: StudioState
  /** The controlled chat draft. */
  readonly requestText: string
  readonly onRequestTextChange: (requestText: string) => void
  /** Called only with a valid request while a new run may start. */
  readonly onStartRun: (requestText: string) => void
}

const EVENT_LABELS: Readonly<Record<StudioEventType, string>> = {
  chat_received: 'Request received',
  phase_started: 'Phase started',
  phase_completed: 'Phase completed',
  evidence_added: 'Evidence added',
  diagnosis_ready: 'Diagnosis ready',
  candidate_ready: 'Candidate ready',
  gate_updated: 'Gate updated',
  run_finalized: 'Run finalized',
  agent_message: 'Agent',
}

export const GATE_LABELS: Readonly<Record<GateId, string>> = {
  failure_reproduced: 'Failure reproduced',
  evidence_complete: 'Evidence complete',
  citations_valid: 'Citations valid',
  patch_scope_valid: 'Patch scope valid',
  patch_applied: 'Patch applied',
  dataset_matches: 'Dataset matches',
  canvas_matches: 'Canvas matches',
  secret_scan_clean: 'Secret scan clean',
  original_worktree_unchanged: 'Original worktree unchanged',
}

export const GATE_STATUS_LABELS: Readonly<Record<GateStatus | 'pending', string>> = {
  pending: 'Pending',
  pass: 'Pass',
  fail: 'Fail',
  unevaluable: 'Unevaluable',
}

const CANDIDATE_LABELS: Readonly<Record<CandidateAvailability, string>> = {
  pending: 'No candidate announced yet.',
  ready: 'A candidate was announced; it is provisional until the run result arrives.',
  available: 'The run result includes a validated candidate diff.',
  absent: 'No candidate passed validation in this run.',
}

/** The client-authored message for an error's stable code; text carried by the error is never shown. */
const safeError = (error: StudioError): StudioError => studioError(error.code)

function ErrorNotice({ error }: { readonly error: StudioError }) {
  const safe = safeError(error)
  return (
    <p className="agent-panel__error" role="alert" data-code={safe.code}>
      {safe.message}
    </p>
  )
}

function GateSummaryText({ gate }: { readonly gate: GateSummary }) {
  return (
    <span className="agent-activity__gate" data-gate={gate.gate_id} data-status={gate.status}>
      {GATE_LABELS[gate.gate_id]}: {GATE_STATUS_LABELS[gate.status]} <code>{gate.reason_code}</code>
    </span>
  )
}

function startHint(state: StudioState): string | null {
  if (state.catalog.status === 'loading') return 'Loading the prepared cases.'
  if (state.catalog.status === 'failed') return state.error === null ? studioError('SESSION_NOT_READY').message : null
  if (state.pendingStart !== null) return 'Starting the run.'
  if (state.run?.status === 'running') return 'A run is in progress; wait for its final status before starting another.'
  if (state.selectedScenarioId === null) return studioError('SCENARIO_NOT_SELECTED').message
  return null
}

function draftProblem(requestText: string): string | null {
  if (requestText.length > MAX_REQUEST_TEXT_LENGTH) return studioError('REQUEST_TEXT_TOO_LONG').message
  if (requestText.length > 0 && requestText.trim().length === 0) return studioError('REQUEST_TEXT_EMPTY').message
  return null
}

/** The bounded legacy request and its one start action; there is no multi-turn conversation. */
export function RequestComposer({ state, requestText, onRequestTextChange, onStartRun }: RequestComposerProps) {
  const inputId = useId()
  const hintId = useId()
  const counterId = useId()
  const problemId = useId()
  const problem = draftProblem(requestText)
  const hint = startHint(state)
  const canSubmit = canStartRun(state) && isValidRequestText(requestText)

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => onRequestTextChange(event.currentTarget.value)
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    // Re-checked at submit time, so a blank, oversized, or duplicate start never reaches the workspace.
    if (canStartRun(state) && isValidRequestText(requestText)) onStartRun(requestText)
  }

  return (
    <form className="agent-chat composer" aria-label="Chat" onSubmit={handleSubmit}>
      <label className="visually-hidden" htmlFor={inputId}>
        Request
      </label>
      <textarea
        id={inputId}
        className="agent-chat__input composer__field"
        value={requestText}
        maxLength={MAX_REQUEST_TEXT_LENGTH}
        rows={3}
        required
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? `${hintId} ${counterId}` : `${problemId} ${hintId} ${counterId}`}
        onChange={handleChange}
      />
      <p id={hintId} className="visually-hidden">
        Describe the goal in up to {MAX_REQUEST_TEXT_LENGTH} characters. The prepared case fixes the scenario, source scope, and gates.
      </p>
      {problem !== null && (
        <p id={problemId} className="agent-chat__problem">
          {problem}
        </p>
      )}
      {hint !== null && (
        <p className="agent-chat__status" role="status">
          {hint}
        </p>
      )}
      {state.error !== null && <ErrorNotice error={state.error} />}
      <div className="composer__foot">
        <p id={counterId} className="agent-chat__counter" data-over-limit={requestText.length > MAX_REQUEST_TEXT_LENGTH}>
          {requestText.length} of {MAX_REQUEST_TEXT_LENGTH} characters
        </p>
        <button className="agent-chat__submit composer__send" type="submit" disabled={!canSubmit} aria-label={state.pendingStart === null ? 'Start run' : 'Starting'}>
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" />
          </svg>
        </button>
      </div>
    </form>
  )
}

/**
 * The non-final status, kept for assistive technology and the run's status marker but not shown:
 * the work summary already states it, and a verdict comes only from the result summary.
 */
function PendingStatus({ run, starting }: { readonly run: RunView | null; readonly starting: boolean }) {
  if (run === null) {
    return (
      <p className="agent-status__final" data-status="none">
        No run yet.
      </p>
    )
  }
  if (starting) {
    return (
      <p className="agent-status__final" data-status="starting">
        Starting the next run.
      </p>
    )
  }
  if (run.status === 'failed') {
    const safe = safeError(run.error)
    return (
      <p className="agent-status__final" data-status="unavailable" data-code={safe.code}>
        No final status. {safe.message}
      </p>
    )
  }
  return (
    <p className="agent-status__final" data-status="pending">
      Final status pending until the run result is available.
    </p>
  )
}

const gateLabel = (id: string): string => GATE_LABELS[id as GateId]

function RunStatus({ state, summary, onCompare }: { readonly state: StudioState; readonly summary: ResultSummaryView | null; readonly onCompare: () => void }) {
  return (
    <section className={`agent-panel__section agent-status${summary === null ? ' visually-hidden' : ''}`} aria-label="Run status" data-final={summary !== null}>
      {summary === null ? <PendingStatus run={state.run} starting={state.pendingStart !== null} /> : <ResultSummary view={summary} labelOf={gateLabel} onCompare={onCompare} />}
    </section>
  )
}

const eventLabel = (event: StudioEvent): string => EVENT_LABELS[event.type]

/** A raw legacy event's provisional gate summary and announced Evidence IDs, as text. */
function eventDetail(event: StudioEvent) {
  return (
    <>
      {event.gate !== null && (
        <p className="agent-activity__detail">
          <GateSummaryText gate={event.gate} />
        </p>
      )}
      {event.evidence_ids.length > 0 && (
        <ul className="agent-activity__evidence" aria-label="Evidence IDs">
          {event.evidence_ids.map((evidenceId) => (
            <li key={evidenceId}>
              <code>{evidenceId}</code>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The client-authored message of a pending run's live-activity problem; text carried by the error is never shown. */
function activityWarning(run: RunView | null): ActivityWarning | null {
  if (run === null || run.stream.error === null) return null
  const safe = safeError(run.stream.error)
  return { code: safe.code, message: safe.message }
}

function EvidenceList({ run }: { readonly run: RunView | null }) {
  const evidenceIds = run?.evidenceIds ?? []
  return (
    <section className="agent-panel__section agent-evidence" aria-label="Evidence">
      <h3 className="agent-panel__heading">Evidence</h3>
      {evidenceIds.length === 0 ? (
        <p className="agent-panel__empty">No Evidence IDs announced yet.</p>
      ) : (
        <ul className="agent-evidence__list">
          {evidenceIds.map((evidenceId) => (
            <li key={evidenceId} className="agent-evidence__item">
              <code>{evidenceId}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CandidateStatus({ run }: { readonly run: RunView | null }) {
  return (
    <section className="agent-panel__section agent-candidate" aria-label="Candidate">
      <h3 className="agent-panel__heading">Candidate</h3>
      <p className="agent-candidate__status" data-candidate={run?.candidate ?? 'none'}>
        {run === null ? 'No run yet.' : CANDIDATE_LABELS[run.candidate]}
      </p>
    </section>
  )
}

function gateSource(run: RunView | null): string {
  if (run === null) return 'No run yet.'
  if (run.status === 'finalized') return 'Final outcomes from the run result.'
  if (run.status === 'failed') return 'Provisional updates from live activity; no final outcomes are available.'
  return 'Provisional updates from live activity.'
}

function GateTable({ run }: { readonly run: RunView | null }) {
  const rows = selectGateRows(run)
  const source = gateSource(run)
  return (
    <section className="agent-panel__section agent-gates" aria-label="Verification gates">
      <h3 className="agent-panel__heading">Verification gates</h3>
      <table className="agent-gates__table">
        <caption className="agent-gates__caption">{source}</caption>
        <thead>
          <tr>
            <th scope="col">Gate</th>
            <th scope="col">Status</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.gateId} className="agent-gate" data-gate={row.gateId} data-status={row.status}>
              <th scope="row">{GATE_LABELS[row.gateId]}</th>
              <td>{GATE_STATUS_LABELS[row.status]}</td>
              <td>{row.reasonCode === null ? 'None yet' : <code>{row.reasonCode}</code>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function AgentPanel({ state, presentation, summary, onCompare, resultDetails }: AgentPanelProps) {
  const titleId = useId()
  if (selectStudioMode(state) === 'captured') {
    // The work panel's context names the candidate verification; there is no chat to edit its goal.
    return (
      <div className="agent-panel agent-panel--captured">
        <CapturedVerification state={state} presentation={presentation} summary={summary} onCompare={onCompare} />
      </div>
    )
  }
  return (
    <section className="agent-panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="agent-panel__title visually-hidden">
        FlowProof agent
      </h2>
      <RunStatus state={state} summary={summary} onCompare={onCompare} />
      <WorkTimeline
        presentation={presentation}
        eventLabel={eventLabel}
        eventDetail={eventDetail}
        activityWarning={activityWarning(state.run)}
        details={
          <>
            <GateTable run={state.run} />
            <EvidenceList run={state.run} />
            <CandidateStatus run={state.run} />
            {resultDetails}
          </>
        }
      />
    </section>
  )
}
