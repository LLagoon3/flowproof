import { useEffect, useId, useMemo, useReducer, useState } from 'react'
import type { ChangeEvent } from 'react'

import { createStudioClient, toStudioError } from './api.js'
import type { RunEventSubscription, StudioClient, StudioError } from './api.js'
import { AgentPanel, RequestComposer } from './components/AgentPanel.js'
import { CapturedStart } from './components/CapturedVerification.js'
import { ProofTrail } from './components/ProofTrail.js'
import { TargetPane } from './components/TargetPane.js'
import { WorkspaceShell } from './components/WorkspaceShell.js'
import { compactStatusOf, selectMeasuringTarget, selectRunPresentation } from './presentation.js'
import { canStartRun, initialStudioState, runEventHandlers, selectCapturedEvidence, selectCapturedTarget, selectStudioMode, studioReducer } from './state.js'
import type { StudioState } from './state.js'
import type { CapturedPaneLabel } from './components/TargetPane.js'

// The Studio workspace: a work panel on the left with the prepared case or the fixed candidate,
// the agent work and the finalized run's Proof Trail, and the request composer or the candidate
// verification action as its entry; the larger canvas on the right frames the prepared application
// (in a captured verification Studio, replaced by the finalized run's captured evidence once the
// target was released). `WorkspaceShell` owns only the panel's width and collapse; each slot keeps
// one stable position, so no layout choice remounts the target pane, the work or its reads, and a
// layout request made while the target is measured waits until that measurement ends.
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
  if (selectStudioMode(state) === 'captured') return 'The host fixed this prepared case for one candidate verification.'
  if (locked) return 'The case stays fixed while a run is starting or in progress.'
  return 'Choosing a case resets the chat to its prepared goal.'
}

/**
 * The captured frame label and guard. The label comes only from actual run activity; from the start
 * request on, the frame is guarded for the whole run, so preparation and measurement leave no gap.
 */
function capturedTarget(state: StudioState): { readonly label: CapturedPaneLabel | undefined; readonly guarded: boolean } {
  if (selectStudioMode(state) !== 'captured') return { label: undefined, guarded: false }
  const guarded = state.pendingStart !== null || state.capturedRun !== undefined
  return { label: selectCapturedTarget(state.capturedRun) ?? (guarded ? 'not-live' : 'preview'), guarded }
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
      <p id={noteId} className="case-picker__note visually-hidden">
        {casePickerNote(state, locked)}
      </p>
    </div>
  )
}

/** The host-fixed candidate of a captured verification Studio; it cannot be changed or edited. */
function CapturedContext({ state }: { readonly state: StudioState }) {
  const selected = state.catalog.scenarios.find((scenario) => scenario.scenario_id === state.selectedScenarioId) ?? null
  return (
    <div className="work-panel__title-group">
      <h2 className="work-panel__title">Candidate verification</h2>
      {selected !== null && (
        <p className="work-panel__subtitle" data-case={selected.case}>
          {selected.title}
        </p>
      )}
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

  // Attach one live stream and one result poll to each started run until a new run or unmount. A
  // captured verification Studio has its one run in `capturedRun`; the reducer routes its actions.
  const runId = state.run?.runId ?? state.capturedRun?.runId ?? null
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
  const target = capturedTarget(state)
  // The finalized captured run's evidence replaces the released target; kept stable for the memoized pane.
  const completedEvidence = useMemo(() => selectCapturedEvidence(state.capturedRun), [state.capturedRun])
  const mode = selectStudioMode(state)
  // One run presentation for the panel's observed work and the collapsed workspace status.
  const presentation = selectRunPresentation(state)

  return (
    <div className="studio">
      <header className="studio__header">
        <h1 className="studio__title">
          FlowProof <span className="studio__product">Studio</span>
        </h1>
      </header>
      <WorkspaceShell
        status={compactStatusOf(presentation)}
        holdLayout={selectMeasuringTarget(state)}
        context={mode === 'captured' ? <CapturedContext state={state} /> : <CasePicker state={state} onSelect={selectScenario} />}
        work={
          <>
            <AgentPanel state={state} presentation={presentation} />
            <ProofTrail run={state.run} client={client} mode={mode} />
          </>
        }
        entry={
          mode === 'captured' ? (
            <CapturedStart state={state} requestText={requestText} onStart={startRun} />
          ) : (
            <RequestComposer state={state} requestText={requestText} onRequestTextChange={changeRequestText} onStartRun={startRun} />
          )
        }
        canvas={<TargetPane capturedLabel={target.label} guarded={target.guarded} completedEvidence={target.label === 'completed-evidence' ? completedEvidence : null} />}
      />
    </div>
  )
}
