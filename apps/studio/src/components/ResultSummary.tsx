import type { ResultSummaryView } from '../presentation.js'

// The concise final result of the work panel (Spec 005 slice 4), shared by both Studio modes: the
// exact family verdict as the one heading, one short explanation, the names of every failed or
// unevaluable gate or check, and one quiet entry to the stored before/after evidence. Everything
// else (all gates or checks, provenance and diff, or the candidate identity and cleanup) stays in
// the closed Details on demand. The view comes from `selectResultSummary` only, so a verdict exists
// only with a valid bound final result; a captured summary carries the strict result's own fixed
// message and reason, and no diagnosis or provenance. The verdict block keeps each family's status
// marker and carries `data-workspace-result`, so the collapsed workspace's result entry focuses it.
// The component renders text only; it reads nothing and changes no run.

export interface ResultSummaryProps {
  readonly view: ResultSummaryView
  /** The readable name of a gate (legacy) or check (captured). */
  readonly labelOf: (id: string) => string
  /** Shows the stored before/after evidence of this run in the canvas. */
  readonly onCompare: () => void
}

const OUTCOME_LABELS = { fail: 'Fail', unevaluable: 'Unevaluable' } as const

const ICON_PATHS: Readonly<Record<ResultSummaryView['tone'], string>> = {
  success: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  danger: 'M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5',
  warning: 'M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.25v.25',
  progress: 'M8 4.5v4l2.5 1.5',
  neutral: 'M4 8h8',
}

function VerdictIcon({ tone }: { readonly tone: ResultSummaryView['tone'] }) {
  return (
    <svg className="icon result-summary__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[tone]} />
    </svg>
  )
}

export function ResultSummary({ view, labelOf, onCompare }: ResultSummaryProps) {
  const legacy = view.mode === 'legacy'
  // A captured non-passing result explains itself with its own fixed message, next to its reason.
  const reasoned = view.mode === 'captured' && view.reasonCode !== null
  const statusMarker = legacy
    ? { className: 'agent-status__final', 'data-status': view.verdict === 'Verified Fix' ? 'verified' : 'unverified' }
    : { className: 'captured-status__final', 'data-captured-status': view.status }

  return (
    <div className="result-summary" data-result-mode={view.mode} data-run-id={view.runId} data-tone={view.tone}>
      <div {...statusMarker} role="status" data-workspace-result="" tabIndex={-1}>
        <h3 className={`result-summary__verdict ${legacy ? 'agent-status__verdict' : 'captured-status__verdict'}`}>
          <VerdictIcon tone={view.tone} />
          <span>{view.verdict}</span>
        </h3>
        {reasoned && (
          <p className="result-summary__explanation captured-status__reason">
            <code className="visually-hidden">{view.reasonCode}</code> {view.explanation}
          </p>
        )}
      </div>
      {!reasoned && <p className="result-summary__explanation">{view.explanation}</p>}
      {view.unsuccessful.length > 0 && (
        <p className={`result-summary__unsuccessful${legacy ? ' agent-status__failed' : ''}`} data-unsuccessful={view.unsuccessful.map((item) => item.id).join(' ')}>
          <span className="visually-hidden">{legacy ? 'Failed or unevaluable gates: ' : 'Failed or unevaluable checks: '}</span>
          {view.unsuccessful.map((item, index) => (
            <span key={item.id} className="result-summary__outcome" data-outcome={item.status}>
              {index > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="visually-hidden">, </span>
                </>
              )}
              {labelOf(item.id)}: {OUTCOME_LABELS[item.status]}
            </span>
          ))}
        </p>
      )}
      <button type="button" className="button button--quiet result-summary__compare" onClick={onCompare}>
        Compare before and after
      </button>
    </div>
  )
}
