import { useId } from 'react'
import type { ChangeEvent, FormEvent } from 'react'

import { MAX_REQUEST_TEXT_LENGTH, isValidRequestText, studioError } from '../api.js'
import type { GateId, GateStatus, GateSummary, RunState, StudioError, StudioEventType } from '../api.js'
import { canStartRun, selectGateRows } from '../state.js'
import type { CandidateAvailability, RunView, StreamStatus, StudioState } from '../state.js'

// The agent pane of the Studio workspace: bounded chat, ordered Agent Activity, announced Evidence
// IDs, candidate status, the nine verification gates, and the final status. It only renders the
// state it is given and reports chat intent through callbacks; the workspace owns the client and
// the run. Every value is rendered as text, errors show only the client-authored message for their
// stable code, and the final status comes only from the authoritative run result.

export interface AgentPanelProps {
  /** The Studio state from `studioReducer`; the panel never changes it. */
  readonly state: StudioState
  /** The controlled chat draft. */
  readonly requestText: string
  readonly onRequestTextChange: (requestText: string) => void
  /** Called only with a valid request while a new run may start. */
  readonly onStartRun: (requestText: string) => void
}

const PHASE_LABELS: Readonly<Record<RunState, string>> = {
  initialized: 'Initialized',
  reproducing: 'Reproducing',
  failure_captured: 'Failure captured',
  diagnosing: 'Diagnosing',
  candidate_validated: 'Candidate validated',
  applying: 'Applying',
  replaying: 'Replaying',
  finalized: 'Finalized',
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

const GATE_LABELS: Readonly<Record<GateId, string>> = {
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

const GATE_STATUS_LABELS: Readonly<Record<GateStatus | 'pending', string>> = {
  pending: 'Pending',
  pass: 'Pass',
  fail: 'Fail',
  unevaluable: 'Unevaluable',
}

const STREAM_LABELS: Readonly<Record<StreamStatus, string>> = {
  connecting: 'Connecting to live activity',
  open: 'Live activity connected',
  ended: 'Live activity ended',
  disconnected: 'Live activity disconnected',
  rejected: 'Live activity stopped',
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

function ChatForm({ state, requestText, onRequestTextChange, onStartRun }: AgentPanelProps) {
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
    <form className="agent-chat" aria-label="Chat" onSubmit={handleSubmit}>
      <label className="agent-chat__label" htmlFor={inputId}>
        Request
      </label>
      <textarea
        id={inputId}
        className="agent-chat__input"
        value={requestText}
        maxLength={MAX_REQUEST_TEXT_LENGTH}
        rows={3}
        required
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? `${hintId} ${counterId}` : `${problemId} ${hintId} ${counterId}`}
        onChange={handleChange}
      />
      <p id={hintId} className="agent-chat__hint">
        Describe the goal in up to {MAX_REQUEST_TEXT_LENGTH} characters. The prepared case fixes the scenario, source scope, and gates.
      </p>
      <p id={counterId} className="agent-chat__counter" data-over-limit={requestText.length > MAX_REQUEST_TEXT_LENGTH}>
        {requestText.length} of {MAX_REQUEST_TEXT_LENGTH} characters
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
      <button className="agent-chat__submit" type="submit" disabled={!canSubmit}>
        {state.pendingStart === null ? 'Start run' : 'Starting'}
      </button>
    </form>
  )
}

function FinalStatus({ run }: { readonly run: RunView | null }) {
  if (run === null) {
    return (
      <p className="agent-status__final" role="status" data-status="none">
        No run yet.
      </p>
    )
  }
  if (run.status === 'running') {
    return (
      <p className="agent-status__final" role="status" data-status="pending">
        Final status pending until the run result is available.
      </p>
    )
  }
  if (run.status === 'failed') {
    const safe = safeError(run.error)
    return (
      <p className="agent-status__final" role="status" data-status="unavailable" data-code={safe.code}>
        No final status. {safe.message}
      </p>
    )
  }
  const { result } = run
  return (
    <div className="agent-status__final" role="status" data-status={result.status === 'Verified Fix' ? 'verified' : 'unverified'}>
      <p className="agent-status__verdict">{result.status}</p>
      {result.failed_gate_ids.length > 0 && (
        <p className="agent-status__failed">
          Failed or unevaluable gates: {result.failed_gate_ids.map((gateId) => GATE_LABELS[gateId]).join(', ')}
        </p>
      )}
    </div>
  )
}

function RunStatus({ state }: { readonly state: StudioState }) {
  const { run } = state
  return (
    <section className="agent-panel__section agent-status" aria-label="Run status">
      <h3 className="agent-panel__heading">Status</h3>
      <FinalStatus run={run} />
      {run !== null && (
        <dl className="agent-status__details">
          <div className="agent-status__row">
            <dt>Phase</dt>
            <dd data-phase={run.phase ?? 'none'}>{run.phase === null ? 'Not reported yet' : PHASE_LABELS[run.phase]}</dd>
          </div>
          <div className="agent-status__row">
            <dt>Live activity</dt>
            <dd data-stream={run.stream.status}>{STREAM_LABELS[run.stream.status]}</dd>
          </div>
        </dl>
      )}
      {run !== null && run.stream.error !== null && <ErrorNotice error={run.stream.error} />}
    </section>
  )
}

function ActivityLog({ run }: { readonly run: RunView | null }) {
  const activity = run?.activity ?? []
  return (
    <section className="agent-panel__section agent-activity" aria-label="Agent Activity">
      <h3 className="agent-panel__heading">Agent Activity</h3>
      {activity.length === 0 ? (
        <p className="agent-panel__empty">{run === null ? 'No activity yet.' : 'Waiting for live activity.'}</p>
      ) : (
        // Rendered in the accepted order; missed events are neither inferred nor reordered.
        <div className="agent-activity__log" role="log" aria-label="Ordered run activity">
          <ol className="agent-activity__list">
            {activity.map((event) => (
              <li key={event.event_id} className="agent-activity__item" data-type={event.type} data-phase={event.phase ?? 'none'}>
                <p className="agent-activity__meta">
                  <span className="agent-activity__sequence">#{event.sequence}</span>{' '}
                  <span className="agent-activity__type">{EVENT_LABELS[event.type]}</span>
                  {event.phase !== null && <span className="agent-activity__phase"> · {PHASE_LABELS[event.phase]}</span>}
                </p>
                <p className="agent-activity__message">{event.message}</p>
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
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
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

export function AgentPanel(props: AgentPanelProps) {
  const titleId = useId()
  const { state } = props
  return (
    <section className="agent-panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="agent-panel__title">
        FlowProof agent
      </h2>
      <ChatForm {...props} />
      <RunStatus state={state} />
      <ActivityLog run={state.run} />
      <EvidenceList run={state.run} />
      <CandidateStatus run={state.run} />
      <GateTable run={state.run} />
    </section>
  )
}
