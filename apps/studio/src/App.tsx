import { useEffect, useId, useReducer, useState } from 'react'
import type { ChangeEvent } from 'react'

import { createStudioClient, toStudioError } from './api.js'
import type { RunEventSubscription, StudioClient, StudioError } from './api.js'
import { AgentPanel } from './components/AgentPanel.js'
import { ProofTrail } from './components/ProofTrail.js'
import { TargetPane } from './components/TargetPane.js'
import { canStartRun, initialStudioState, runEventHandlers, studioReducer } from './state.js'
import type { StudioState } from './state.js'

// The split Studio workspace: the prepared application framed on the left, the agent pane and the
// finalized run's Proof Trail on the right, and the prepared-case selector above them.
// `studioReducer` alone decides what the session may do; the effects below only keep network work
// in step with its state. Each request owns an AbortController that its effect aborts on change or
// unmount, and an aborted request never dispatches, so a stale or post-unmount response cannot
// change the visible session. The live stream is advisory and the result poll is authoritative:
// they run independently, so a stream that disconnects or is rejected leaves the poll running.
// Errors shown are client-authored by code.

export interface AppProps {
  /** The same-origin Studio client; one is created when omitted. */
  readonly client?: StudioClient
}

/** The chat draft and the case it was written for. */
interface Draft {
  readonly scenarioId: string | null
  readonly text: string
}

/** Starts one abortable request and delivers its outcome only while it has not been aborted. */
function track<T>(
  request: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: StudioError) => void,
): () => void {
  const controller = new AbortController()
  // The executor turns a synchronous throw into a rejection.
  new Promise<T>((resolve) => resolve(request(controller.signal))).then(
    (value) => {
      if (!controller.signal.aborted) onValue(value)
    },
    (error: unknown) => {
      if (!controller.signal.aborted) onError(toStudioError(error))
    },
  )
  return () => controller.abort()
}

function casePickerNote(state: StudioState, locked: boolean): string {
  if (state.catalog.status === 'loading') return 'Loading the prepared cases.'
  if (state.catalog.status === 'failed') return 'The prepared cases are not available.'
  if (state.catalog.scenarios.length === 0) return 'No prepared case is registered.'
  if (locked) return 'The case stays fixed while a run is starting or in progress.'
  return 'Choosing a case resets the chat to its prepared goal.'
}

function CasePicker({ state, onSelect }: { readonly state: StudioState; readonly onSelect: (scenarioId: string) => void }) {
  const selectId = useId()
  const noteId = useId()
  const { status, scenarios } = state.catalog
  // Selection follows the start rule: cases loaded and no start or run active.
  const locked = !canStartRun(state)
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => onSelect(event.currentTarget.value)

  return (
    <div className="case-picker">
      <label className="case-picker__label" htmlFor={selectId}>
        Prepared case
      </label>
      <select
        id={selectId}
        className="case-picker__select"
        value={state.selectedScenarioId ?? ''}
        disabled={locked}
        aria-describedby={noteId}
        onChange={handleChange}
      >
        {scenarios.length === 0 ? (
          <option value="">{status === 'loading' ? 'Loading' : 'Unavailable'}</option>
        ) : (
          scenarios.map((scenario) => (
            <option key={scenario.scenario_id} value={scenario.scenario_id} data-case={scenario.case}>
              {scenario.title}
            </option>
          ))
        )}
      </select>
      <p id={noteId} className="case-picker__note">
        {casePickerNote(state, locked)}
      </p>
    </div>
  )
}

export function App({ client: providedClient }: AppProps) {
  const [client] = useState(() => providedClient ?? createStudioClient())
  const [state, dispatch] = useReducer(studioReducer, initialStudioState)
  const [draft, setDraft] = useState<Draft | null>(null)

  const selected = state.catalog.scenarios.find((scenario) => scenario.scenario_id === state.selectedScenarioId) ?? null
  // Until it is edited for the selected case, the chat holds that case's committed default request.
  const requestText = draft !== null && draft.scenarioId === state.selectedScenarioId ? draft.text : (selected?.default_request ?? '')

  // Load the prepared cases once; the reducer selects the first case.
  useEffect(
    () =>
      track(
        (signal) => client.listScenarios(signal),
        (scenarios) => dispatch({ type: 'catalog/loaded', scenarios }),
        (error) => dispatch({ type: 'catalog/failed', error }),
      ),
    [client],
  )

  // Send each start the reducer accepted, exactly once, with only the case ID and request text.
  const { pendingStart } = state
  useEffect(() => {
    if (pendingStart === null) return
    const { scenarioId, requestText: text } = pendingStart
    return track(
      (signal) => client.startRun({ scenarioId, requestText: text }, signal),
      (start) => dispatch({ type: 'run/started', start }),
      (error) => dispatch({ type: 'run/rejected', error }),
    )
  }, [client, pendingStart])

  // Attach one live stream and one result poll to each started run until a new run or unmount.
  const runId = state.run?.runId ?? null
  useEffect(() => {
    if (runId === null) return
    let subscription: RunEventSubscription | null = null
    try {
      subscription = client.openRunEvents(runId, runEventHandlers(runId, dispatch))
    } catch (error) {
      dispatch({ type: 'stream/failed', runId, error: toStudioError(error) })
    }
    const stopPolling = track(
      (signal) => client.pollResult(runId, { signal }),
      (result) => dispatch({ type: 'result/received', runId, result }),
      (error) => dispatch({ type: 'result/failed', runId, error }),
    )
    return () => {
      stopPolling()
      subscription?.close()
    }
  }, [client, runId])

  const selectScenario = (scenarioId: string): void => {
    if (!canStartRun(state) || scenarioId === state.selectedScenarioId) return
    dispatch({ type: 'scenario/selected', scenarioId })
    setDraft(null)
  }
  const changeRequestText = (text: string): void => setDraft({ scenarioId: state.selectedScenarioId, text })
  const startRun = (text: string): void => dispatch({ type: 'run/requested', requestText: text })

  return (
    <div className="studio">
      <header className="studio__header">
        <h1 className="studio__title">FlowProof Studio</h1>
        <CasePicker state={state} onSelect={selectScenario} />
      </header>
      <main className="studio__workspace">
        <TargetPane />
        <div className="studio__side">
          <AgentPanel state={state} requestText={requestText} onRequestTextChange={changeRequestText} onStartRun={startRun} />
          <ProofTrail run={state.run} client={client} />
        </div>
      </main>
    </div>
  )
}
