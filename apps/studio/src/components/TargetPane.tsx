import { memo, useEffect, useId, useRef, useState } from 'react'

import { evidenceUrl } from '../api.js'
import type { CapturedCompletedEvidence, CapturedEvidenceSide, CapturedTargetPresentation } from '../state.js'

// The prepared-application pane of the Studio workspace: one frame that always loads the one
// committed target URL. The engine drives that frame through Playwright and repoints it to each
// rebuilt target, so the Studio only hosts it. The pane never reads the frame's document, listens
// for its messages, or navigates it; a re-render never reloads or replaces the frame, whose element
// stays mounted in the same place with the same URL.
//
// In a captured verification Studio the pane also labels what the frame may be presented as, from
// actual run activity only, and guards the measured target while the run is active: a transparent
// cover over the frame takes accidental pointer input, focus is kept in the outer Studio, and the
// frame is out of the tab order. The prepared programmatic select still runs in the real frame. The
// guard covers the whole active run, so there is no input gap between preparation and measurement.
// It is not an automation broker or a defense against arbitrary page behavior.
//
// The captured run's finalization ends the observed frame before it publishes its result: the
// launcher removes that iframe element from the page. The iframe is therefore the only child of its
// own keyed live wrapper, which React never updates around it, and once the bound strict result is
// available the pane replaces that wrapper as a whole with the run's captured before/after
// screenshots, labelled as captured and not live. React thus removes only the still-attached
// wrapper, never the element the launcher already removed. The screenshots are same-origin images
// read by their announced Evidence IDs through the closed evidence route; a side the result records
// no evidence for, or whose Evidence ID this session did not receive, is stated, never guessed.

/** The committed `app.url` of the prepared application; the Studio CSP frames only its origin. */
export const TARGET_APP_URL = 'http://localhost:43119/'
const TARGET_APP_HOST = new URL(TARGET_APP_URL).host

/** What a captured verification Studio may present the frame as; `preview` before its run starts. */
export type CapturedPaneLabel = CapturedTargetPresentation | 'preview'

const LABELS: Readonly<Record<CapturedPaneLabel, string>> = {
  preview: 'Prepared preview (not under verification)',
  'not-live': 'Preparation (not live)',
  'baseline-live': 'Live: recorded baseline',
  'candidate-live': 'Live: candidate build',
  'completed-evidence': 'Captured evidence (not live): the verification finalized and the target was released',
}

const SIDE_TITLES: Readonly<Record<CapturedEvidenceSide['side'], string>> = {
  before: 'Before: recorded baseline',
  after: 'After: candidate build',
}

const SIDE_ABSENT: Readonly<Record<CapturedEvidenceSide['side'], string>> = {
  before: 'No baseline evidence was produced in this run, so there is no before screenshot.',
  after: 'No candidate replay evidence was produced in this run, so there is no after screenshot.',
}

const NOT_RECEIVED = 'The screenshot was recorded, but its Evidence ID was not received in this session, so it is not shown.'
const UNREADABLE = 'The captured screenshot could not be read through the closed evidence route.'

export interface TargetPaneProps {
  /** Captured verification only: the frame label; absent in the legacy Studio, which has none. */
  readonly capturedLabel?: CapturedPaneLabel | undefined
  /** Captured verification only: true while the run is starting, active, or finalized. */
  readonly guarded?: boolean | undefined
  /** Captured verification only: the finalized run's evidence, which replaces the released target. */
  readonly completedEvidence?: CapturedCompletedEvidence | null | undefined
}

/** One captured screenshot of the finalized run, or the statement of why there is none. */
function CapturedScreenshot({ runId, side }: { readonly runId: string; readonly side: CapturedEvidenceSide }) {
  const [unreadable, setUnreadable] = useState(false)
  const title = SIDE_TITLES[side.side]
  const shown = side.state === 'shown' && side.evidenceId !== null
  return (
    <figure className="target-pane__evidence-side" data-evidence-side={side.side} data-evidence-state={side.state} data-evidence-load={unreadable ? 'failed' : undefined}>
      <h3 className="target-pane__evidence-title">{title}</h3>
      {shown && !unreadable && (
        <img
          className="target-pane__evidence-image"
          src={evidenceUrl(runId, side.evidenceId ?? '')}
          alt={`${title}, captured screenshot (not live)`}
          data-evidence-id={side.evidenceId}
          draggable={false}
          onError={() => setUnreadable(true)}
        />
      )}
      {shown && unreadable && (
        <p className="target-pane__evidence-note" role="alert">
          {UNREADABLE}
        </p>
      )}
      {!shown && <p className="target-pane__evidence-note">{side.state === 'not-produced' ? SIDE_ABSENT[side.side] : NOT_RECEIVED}</p>}
      <figcaption className="target-pane__evidence-caption">
        {shown ? (
          <>
            Captured screenshot, not live <code>{side.evidenceId}</code>
          </>
        ) : (
          'No captured screenshot'
        )}
      </figcaption>
    </figure>
  )
}

export const TargetPane = memo(function TargetPane({ capturedLabel, guarded = false, completedEvidence = null }: TargetPaneProps) {
  const titleId = useId()
  const hostId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // While guarded, focus never stays in the frame: it moves to the outer viewport now and whenever
  // it reaches the frame, for example through a click that landed before the cover existed.
  useEffect(() => {
    if (!guarded) return
    const viewport = viewportRef.current
    const frame = frameRef.current
    if (viewport === null || frame === null) return
    const keepOutside = (): void => {
      if (document.activeElement === frame) viewport.focus({ preventScroll: true })
    }
    // Focus enters a frame without bubbling an event in this document, so the window blur is checked
    // once the move has completed.
    const onWindowBlur = (): void => {
      queueMicrotask(keepOutside)
    }
    keepOutside()
    frame.addEventListener('focus', keepOutside)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      frame.removeEventListener('focus', keepOutside)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [guarded])

  return (
    <section className="target-pane" aria-labelledby={titleId}>
      <header className="target-pane__header">
        <h2 id={titleId} className="target-pane__title">
          Prepared application
        </h2>
        {capturedLabel !== undefined && (
          <p className="target-pane__state" role="status" data-target-presentation={capturedLabel}>
            {LABELS[capturedLabel]}
          </p>
        )}
        <p id={hostId} className="target-pane__host">
          <code>{TARGET_APP_HOST}</code>
        </p>
      </header>
      <div ref={viewportRef} className="target-pane__viewport" tabIndex={guarded ? -1 : undefined} data-guarded={guarded ? 'true' : undefined}>
        {completedEvidence === null ? (
          <div key="live-target" className="target-pane__live">
            <iframe
              ref={frameRef}
              className="target-pane__frame"
              src={TARGET_APP_URL}
              title="Prepared application"
              aria-describedby={hostId}
              referrerPolicy="no-referrer"
              tabIndex={guarded ? -1 : undefined}
            />
          </div>
        ) : (
          <div key="captured-evidence" className="target-pane__evidence" data-captured-evidence="completed" data-run-id={completedEvidence.runId}>
            <CapturedScreenshot key={`before:${completedEvidence.before.evidenceId ?? completedEvidence.before.state}`} runId={completedEvidence.runId} side={completedEvidence.before} />
            <CapturedScreenshot key={`after:${completedEvidence.after.evidenceId ?? completedEvidence.after.state}`} runId={completedEvidence.runId} side={completedEvidence.after} />
          </div>
        )}
        {guarded && completedEvidence === null && <div className="target-pane__cover" aria-hidden="true" />}
      </div>
    </section>
  )
})
