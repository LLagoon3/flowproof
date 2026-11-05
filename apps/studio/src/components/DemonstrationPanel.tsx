import { useCallback, useEffect, useRef, useState } from 'react'

import { DemonstrationRequestError, demonstrationApi } from '../api.js'
import type { DemonstrationRunView } from '../api.js'
import { demonstrationConditionText, demonstrationMessage, demonstrationModelText } from '../presentation.js'
import { classifyDemonstrationRefusal, isDemonstrationRunStopped } from '../state.js'

// T030: capture, sealed report, explicit Analyze and one focused clarification, wired to the
// guarded host routes. Every stage waits for the person; nothing is timed, retried or sent before
// the explicit Analyze. A reply that arrives after its request was superseded is ignored, so a
// stale response can never revive a discarded or revoked report.

type Phase = 'idle' | 'starting' | 'recording' | 'finishing' | 'ready' | 'unusable' | 'discarding' | 'analyzing' | 'interpreted' | 'clarify' | 'answering' | 'stopped' | 'verifying' | 'verified'

export interface DemonstrationPanelProps {
  readonly configurationId: string
  readonly outputSha256: string
  readonly modelConfigured: boolean
  /** Re-reads the host context after the host revoked or replaced the prepared target. */
  readonly onHostChanged: () => unknown
}

export function DemonstrationPanel({ configurationId, outputSha256, modelConfigured, onHostChanged }: DemonstrationPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [runId, setRunId] = useState<string | null>(null)
  const [captureId, setCaptureId] = useState<string | null>(null)
  const [reportSha, setReportSha] = useState<string | null>(null)
  const [unusableState, setUnusableState] = useState<string | null>(null)
  const [view, setView] = useState<DemonstrationRunView | null>(null)
  const [description, setDescription] = useState('')
  const [answer, setAnswer] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    return () => {
      generation.current += 1
    }
  }, [])

  const begin = (next: Phase): number => {
    generation.current += 1
    setMessage(null)
    setPhase(next)
    return generation.current
  }
  const current = (gen: number): boolean => gen === generation.current

  const resetCapture = () => {
    setCaptureId(null)
    setReportSha(null)
    setUnusableState(null)
    setDescription('')
    setAnswer('')
  }

  const refuse = useCallback(
    async (gen: number, error: unknown, fallback: Phase, run: string | null) => {
      if (!current(gen)) return
      const code = error instanceof DemonstrationRequestError ? error.code : 'REQUEST_FAILED'
      const kind = classifyDemonstrationRefusal(code)
      setMessage(demonstrationMessage(code))
      if (kind === 'host-changed') {
        generation.current += 1
        resetCapture()
        setRunId(null)
        setView(null)
        setPhase('idle')
        await onHostChanged()
        return
      }
      if (kind === 'stopped') {
        setPhase('stopped')
        if (run !== null) {
          try {
            const next = await demonstrationApi.view(run)
            if (current(gen)) setView(next)
          } catch {
            // The stopped state is already shown; the view is informational only.
          }
        }
        return
      }
      setPhase(fallback)
    },
    [onHostChanged],
  )

  const showView = (next: DemonstrationRunView) => {
    setView(next)
    if (isDemonstrationRunStopped(next.state) && next.result?.status !== 'unsupported') setPhase('stopped')
    else if (next.result?.status === 'clarify') setPhase('clarify')
    else if (next.result !== null) setPhase('interpreted')
  }

  const start = async () => {
    const gen = begin('starting')
    try {
      const started = await demonstrationApi.start(configurationId, outputSha256)
      if (!current(gen)) return
      resetCapture()
      setView(null)
      setRunId(started.runId)
      setCaptureId(started.captureId)
      setPhase('recording')
    } catch (error) {
      await refuse(gen, error, 'idle', runId)
    }
  }

  const finish = async () => {
    if (captureId === null) return
    const gen = begin('finishing')
    try {
      const finished = await demonstrationApi.finish(captureId)
      if (!current(gen)) return
      if (finished.state === 'ready' && finished.reportSha256 !== null) {
        setReportSha(finished.reportSha256)
        setPhase('ready')
      } else {
        setUnusableState(finished.state)
        setPhase('unusable')
      }
    } catch (error) {
      await refuse(gen, error, 'recording', runId)
    }
  }

  const discard = async (from: Phase) => {
    if (captureId === null) return
    const gen = begin('discarding')
    try {
      await demonstrationApi.discard(captureId)
      if (!current(gen)) return
      resetCapture()
      setPhase('idle')
    } catch (error) {
      await refuse(gen, error, from, runId)
    }
  }

  const analyze = async () => {
    if (captureId === null || runId === null) return
    const gen = begin('analyzing')
    try {
      await demonstrationApi.analyze(captureId, description)
      const next = await demonstrationApi.view(runId)
      if (!current(gen)) return
      showView(next)
    } catch (error) {
      await refuse(gen, error, 'ready', runId)
    }
  }

  const submitAnswer = async () => {
    const questionId = view?.result?.status === 'clarify' ? view.result.question.question_id : null
    if (runId === null || questionId === null || answer.trim() === '') return
    const gen = begin('answering')
    try {
      await demonstrationApi.clarify(runId, questionId, answer.trim())
      const next = await demonstrationApi.view(runId)
      if (!current(gen)) return
      showView(next)
    } catch (error) {
      await refuse(gen, error, 'clarify', runId)
    }
  }

  const cancelRun = async () => {
    if (runId === null) return
    const gen = begin('stopped')
    try {
      await demonstrationApi.cancel(runId)
      const next = await demonstrationApi.view(runId)
      if (current(gen)) setView(next)
    } catch (error) {
      await refuse(gen, error, 'stopped', runId)
    }
  }

  const verify = async () => {
    if (runId === null) return
    const gen = begin('verifying')
    try {
      await demonstrationApi.verify(runId)
      const next = await demonstrationApi.view(runId)
      if (!current(gen)) return
      setView(next)
      setPhase('verified')
    } catch (error) {
      await refuse(gen, error, 'interpreted', runId)
    }
  }

  // Host-owned progress of the automatic stages; a display refresh only, never an outcome.
  useEffect(() => {
    if (phase !== 'verifying' || runId === null) return
    const timer = setInterval(() => {
      void demonstrationApi
        .view(runId)
        .then((next) => setView(next))
        .catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [phase, runId])

  const result = view?.result ?? null
  const busy = phase === 'starting' || phase === 'finishing' || phase === 'discarding' || phase === 'analyzing' || phase === 'answering'

  return (
    <section className="demonstration" aria-labelledby="demonstration-title" data-testid="demonstration-panel" data-phase={phase}>
      <h2 id="demonstration-title">Demonstrate the problem</h2>

      {(phase === 'idle' || phase === 'starting') && (
        <>
          <p>Start recording, then reproduce the problem in the project on the left. Recording keeps everything on this computer.</p>
          <div className="demonstration__actions">
            <button type="button" data-testid="demonstration-start" onClick={() => void start()} disabled={busy}>
              Start recording
            </button>
          </div>
        </>
      )}

      {(phase === 'recording' || phase === 'finishing') && (
        <>
          <p role="status">Recording your actions in the project frame only. Nothing has been sent.</p>
          <div className="demonstration__actions">
            <button type="button" data-testid="demonstration-finish" onClick={() => void finish()} disabled={busy}>
              Finish recording
            </button>
            <button type="button" data-testid="demonstration-discard" onClick={() => void discard('recording')} disabled={busy}>
              Discard
            </button>
          </div>
        </>
      )}

      {(phase === 'ready' || phase === 'analyzing' || (phase === 'discarding' && reportSha !== null)) && (
        <>
          <p data-testid="demonstration-report">
            {phase === 'analyzing'
              ? `Report sealed (${reportSha?.slice(0, 12)}). Analyzing: the report and your description are being sent to the configured model.`
              : `Report sealed (${reportSha?.slice(0, 12)}). Nothing has been sent yet.`}
          </p>
          {phase !== 'analyzing' && (
            <p data-testid="demonstration-disclosure">
              Analyze sends this sealed report to the configured model: your recorded actions with typed and selected values redacted, screenshots of the
              project frame only, relevant errors, the admitted project source files and your optional description. If the model asks one clarifying question,
              your answer is sent with this report context for one re-analysis. Nothing else is sent, and nothing is sent until you choose Analyze.
            </p>
          )}
          <label>
            Describe the problem (optional)
            <textarea data-testid="demonstration-description" maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
          </label>
          {!modelConfigured && <p>No model is configured, so this report cannot be analyzed.</p>}
          {phase === 'analyzing' && <p role="status">Sending the sealed report for interpretation.</p>}
          <div className="demonstration__actions">
            <button type="button" data-testid="demonstration-analyze" onClick={() => void analyze()} disabled={busy || !modelConfigured}>
              Analyze
            </button>
            <button type="button" data-testid="demonstration-discard" onClick={() => void discard('ready')} disabled={busy}>
              Discard report
            </button>
            {phase === 'analyzing' && (
              <button type="button" data-testid="demonstration-cancel" onClick={() => void cancelRun()}>
                Cancel run
              </button>
            )}
          </div>
        </>
      )}

      {(phase === 'unusable' || (phase === 'discarding' && reportSha === null)) && (
        <>
          <p data-testid="demonstration-unusable">
            This capture is {unusableState ?? 'incomplete'} and cannot be analyzed. Discard it and record again.
          </p>
          <div className="demonstration__actions">
            <button type="button" data-testid="demonstration-discard" onClick={() => void discard('unusable')} disabled={busy}>
              Discard
            </button>
          </div>
        </>
      )}

      {(phase === 'clarify' || phase === 'answering') && result?.status === 'clarify' && (
        <div data-testid="demonstration-clarify">
          <p>{result.observed_facts}</p>
          <p>
            <strong>{result.question.text}</strong>
          </p>
          <p>{result.question.missing_intent}</p>
          {result.question.alternatives.length > 0 && (
            <ul>
              {result.question.alternatives.map((alternative) => (
                <li key={alternative}>{alternative}</li>
              ))}
            </ul>
          )}
          <label>
            Your answer (one answer; FlowProof re-analyzes once)
            <textarea data-testid="demonstration-answer" maxLength={1000} value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} />
          </label>
          {phase === 'answering' && <p role="status">Sending your answer with the report context for one re-analysis.</p>}
          <div className="demonstration__actions">
            <button type="button" data-testid="demonstration-answer-submit" onClick={() => void submitAnswer()} disabled={busy || answer.trim() === ''}>
              Send answer
            </button>
            {phase === 'answering' && (
              <button type="button" data-testid="demonstration-cancel" onClick={() => void cancelRun()}>
                Cancel run
              </button>
            )}
          </div>
        </div>
      )}

      {(phase === 'interpreted' || phase === 'stopped' || phase === 'verifying' || phase === 'verified') && result !== null && result.status !== 'clarify' && (
        <div data-testid="demonstration-interpretation">
          {result.status === 'ready' ? (
            <>
              <p>{result.observed_problem}</p>
              <p>
                <strong>Intended behavior:</strong> {result.intent_summary}
              </p>
              <ol className="demonstration__conditions" aria-label="Expected conditions">
                {result.expected_conditions.map((condition, index) => (
                  <li key={index} data-task-condition={index === result.task_condition_index ? 'true' : 'false'}>
                    {demonstrationConditionText(condition)}
                  </li>
                ))}
              </ol>
              <p>{result.support_explanation}</p>
            </>
          ) : (
            <p>{result.explanation}</p>
          )}
        </div>
      )}

      {view?.model && <p data-testid="demonstration-model">{demonstrationModelText(view.model)}</p>}

      {phase === 'interpreted' && result?.status === 'ready' && (
        <div className="demonstration__actions">
          <button type="button" data-testid="demonstration-verify" onClick={() => void verify()} aria-describedby="demonstration-verify-note">
            Verify and fix
          </button>
          <p id="demonstration-verify-note">
            FlowProof replays your demonstration on a fresh copy of the project. Only if the problem reproduces does it ask the model once for a
            change, then builds, checks and replays the changed copy. Your project is never modified.
          </p>
        </div>
      )}

      {(phase === 'verifying' || phase === 'verified') && (
        <div data-testid="demonstration-verification">
          {phase === 'verifying' && <p role="status">Verifying automatically. You can cancel at any time.</p>}
          <ol aria-label="Verification stages">
            {(view?.verification?.events ?? []).map((event, index) => (
              <li key={index}>
                {event.stage}: {event.status}
                {event.reason !== null ? ` (${event.reason})` : ''}
              </li>
            ))}
          </ol>
          {view?.verification?.status === 'finished' && (
            <p data-testid="demonstration-outcome">
              Result: {view.verification.outcome}
              {view.verification.primary_reason !== null ? ` (${view.verification.primary_reason})` : ''}
            </p>
          )}
          {view?.verification?.patch && (
            <p data-testid="demonstration-patch">
              Proposed change to {view.verification.patch.target_paths.join(', ')}: {view.verification.patch.summary}
            </p>
          )}
          {phase === 'verifying' && (
            <div className="demonstration__actions">
              <button type="button" data-testid="demonstration-cancel" onClick={() => void cancelRun()}>
                Cancel run
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'stopped' && <p data-testid="demonstration-stopped">This demonstration run has stopped. Start a new session to try again.</p>}

      {message !== null && (
        <p role="alert" data-testid="demonstration-message">
          {message}
        </p>
      )}
    </section>
  )
}
