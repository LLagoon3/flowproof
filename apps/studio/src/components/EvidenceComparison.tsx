import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'

import { evidenceUrl } from '../api.js'
import type { EvidenceComparisonView, EvidenceSideView, SelectedEvidence } from '../presentation.js'

// The stored before/after evidence of a finalized run (Spec 005 slice 4), shared by both Studio
// modes and shown in the canvas: in a captured verification Studio in place of the released target,
// in the legacy Studio in its Evidence tab beside the kept target frame. Each side names its phase
// and states exactly one of: the screenshot is available, still loading, unreadable, the phase
// produced no screenshot, or its Evidence ID was not received in this session. The view comes from
// `selectEvidenceComparison`, which applies each family's own authorization; this component only
// requests the one authorized Evidence ID of its run through the closed evidence route, as a
// same-origin image, and never reads a path, keeps a cache or mixes runs. A failed side never
// changes the verdict. The images stay mounted while the comparison exists, so switching tabs or
// panels reads nothing again. Nothing here is a control: the pane holds no frame, link or button.

export interface EvidenceComparisonProps {
  readonly view: EvidenceComparisonView
  /** The reader's still-valid selection, marked on its side; null when nothing is selected. */
  readonly selected: SelectedEvidence | null
  /** The panel id that a tab controls (legacy). */
  readonly id?: string | undefined
  /** The tab that labels this panel (legacy); absent in a captured Studio, which has no tabs. */
  readonly labelledBy?: string | undefined
  /** Legacy: hidden, but still mounted, while the Target tab is selected. */
  readonly hidden?: boolean | undefined
  /** The title, which takes focus when the reader asks to compare. */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined
}

type Load = 'loading' | 'loaded' | 'failed'

const TITLES: Readonly<Record<EvidenceComparisonView['mode'], Readonly<Record<EvidenceSideView['side'], string>>>> = {
  legacy: { before: 'Before: failure reproduction', after: 'After: replay on the candidate' },
  captured: { before: 'Before: recorded baseline', after: 'After: candidate build' },
}

const NOT_PRODUCED: Readonly<Record<EvidenceComparisonView['mode'], Readonly<Record<EvidenceSideView['side'], string>>>> = {
  legacy: {
    before: 'No failure screenshot was recorded in this run, so there is no before screenshot.',
    after: 'No replay screenshot was recorded in this run, so there is no after screenshot.',
  },
  captured: {
    before: 'No baseline evidence was produced in this run, so there is no before screenshot.',
    after: 'No candidate replay evidence was produced in this run, so there is no after screenshot.',
  },
}

const NOT_RECEIVED = 'The screenshot was recorded, but its Evidence ID was not received in this session, so it is not shown.'
const LOADING = 'Loading the stored screenshot.'

const UNREADABLE: Readonly<Record<EvidenceComparisonView['mode'], string>> = {
  legacy: 'The stored screenshot could not be read through the closed evidence route.',
  captured: 'The captured screenshot could not be read through the closed evidence route.',
}

/** The non-visual identity of a side: what it is and, when shown, its Evidence ID. */
const CAPTIONS: Readonly<Record<EvidenceComparisonView['mode'], { readonly shown: string; readonly none: string }>> = {
  legacy: { shown: 'Stored screenshot, not live', none: 'No stored screenshot' },
  captured: { shown: 'Captured screenshot, not live', none: 'No captured screenshot' },
}

interface SideProps {
  readonly mode: EvidenceComparisonView['mode']
  readonly runId: string
  readonly side: EvidenceSideView
  readonly selected: boolean
}

function EvidenceSide({ mode, runId, side, selected }: SideProps) {
  const titleId = useId()
  const imageRef = useRef<HTMLImageElement>(null)
  const [load, setLoad] = useState<Load>('loading')
  const title = TITLES[mode][side.side]
  const available = side.state === 'available' && side.evidenceId !== null

  // An image that completed before its load listener could report it is still loaded.
  useLayoutEffect(() => {
    const image = imageRef.current
    if (image !== null && image.complete) setLoad(image.naturalWidth > 0 ? 'loaded' : 'failed')
  }, [])

  return (
    <figure
      className="evidence-side target-pane__evidence-side"
      aria-labelledby={titleId}
      data-evidence-side={side.side}
      data-evidence-phase={side.phase}
      data-evidence-state={side.state}
      data-evidence-load={available ? load : undefined}
      data-selected={selected ? 'true' : undefined}
    >
      <h4 id={titleId} className="evidence-side__title target-pane__evidence-title">
        {title}
      </h4>
      <div className="evidence-side__media" data-state={available ? load : side.state}>
        {available && load !== 'failed' && (
          <img
            ref={imageRef}
            className="evidence-side__image target-pane__evidence-image"
            src={evidenceUrl(runId, side.evidenceId ?? '')}
            alt={`${title}, ${CAPTIONS[mode].shown.toLowerCase()}`}
            data-evidence-id={side.evidenceId}
            draggable={false}
            onLoad={() => setLoad('loaded')}
            onError={() => setLoad('failed')}
          />
        )}
        {available && load === 'loading' && (
          <p className="evidence-side__note" role="status">
            {LOADING}
          </p>
        )}
        {available && load === 'failed' && (
          <p className="evidence-side__note evidence-side__note--problem" role="alert">
            {UNREADABLE[mode]}
          </p>
        )}
        {!available && <p className="evidence-side__note">{side.state === 'not-produced' ? NOT_PRODUCED[mode][side.side] : NOT_RECEIVED}</p>}
      </div>
      <figcaption className="visually-hidden">
        {available ? (
          <>
            {CAPTIONS[mode].shown} <code>{side.evidenceId}</code>
          </>
        ) : (
          CAPTIONS[mode].none
        )}
      </figcaption>
    </figure>
  )
}

/** The before/after sides of one finalized run; the title takes focus when the reader asks to compare. */
export function EvidenceComparison({ view, selected, id, labelledBy, hidden = false, titleRef }: EvidenceComparisonProps) {
  const selectedPhase = selected?.runId === view.runId ? selected.phase : null
  const captured = view.mode === 'captured'
  return (
    <div
      id={id}
      className="evidence-view target-pane__evidence"
      role={labelledBy === undefined ? undefined : 'tabpanel'}
      aria-labelledby={labelledBy}
      hidden={hidden}
      data-evidence-view={view.mode}
      data-captured-evidence={captured ? 'completed' : undefined}
      data-run-id={view.runId}
    >
      <h3 ref={titleRef} className="evidence-view__title" tabIndex={-1}>
        Before and after
      </h3>
      <div className="evidence-view__grid">
        {[view.before, view.after].map((side) => (
          // A side remounts only when its authorized Evidence ID or state changes, so its image state is its own.
          <EvidenceSide key={`${side.side}:${side.evidenceId ?? side.state}`} mode={view.mode} runId={view.runId} side={side} selected={selectedPhase === side.phase} />
        ))}
      </div>
    </div>
  )
}
