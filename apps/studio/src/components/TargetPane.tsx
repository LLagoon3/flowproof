import { memo, useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'

import type { CanvasView, EvidenceComparisonView, SelectedEvidence } from '../presentation.js'
import type { CapturedTargetPresentation } from '../state.js'
import { EvidenceComparison } from './EvidenceComparison.js'

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
// available the pane replaces that wrapper as a whole with the run's stored before/after evidence
// (`EvidenceComparison`), labelled as captured and not live. React thus removes only the
// still-attached wrapper, never the element the launcher already removed, and no final review
// recreates a target. A side the result records no evidence for, or whose Evidence ID this session
// did not receive, is stated, never guessed.
//
// A legacy Studio keeps its target lifetime as it is. Once its run finalized, the header offers
// Target and Evidence tabs; the Evidence tab shows the run's stored evidence over the same frame,
// whose wrapper is then hidden and inert but never unmounted, replaced or moved, so selecting Target
// returns to the same element and frame. The tabs are never offered while a run starts or measures.

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

export type CanvasTab = CanvasView['tab']

export interface TargetPaneProps {
  /** Captured verification only: the frame label; absent in the legacy Studio, which has none. */
  readonly capturedLabel?: CapturedPaneLabel | undefined
  /** Captured verification only: true while the run is starting, active, or finalized. */
  readonly guarded?: boolean | undefined
  /**
   * The finalized run's stored before/after evidence: in a captured Studio, once the target was
   * released, it replaces the live wrapper; in the legacy Studio it is the content of the Evidence tab.
   */
  readonly evidence?: EvidenceComparisonView | null | undefined
  /** Legacy only: whether the Target and Evidence tabs are offered (`selectCanvasView`). */
  readonly tabs?: boolean | undefined
  /** Legacy only: the selected tab. */
  readonly tab?: CanvasTab | undefined
  /** The reader's still-valid evidence selection. */
  readonly selected?: SelectedEvidence | null | undefined
  /** Legacy only: called with the tab the reader chose. */
  readonly onSelectTab?: ((tab: CanvasTab) => void) | undefined
  /** A new value moves focus to the evidence: the Evidence tab (legacy) or the evidence title (captured). */
  readonly focusEvidence?: number | undefined
}

const TAB_ORDER: readonly CanvasTab[] = ['target', 'evidence']
const TAB_KEYS: Readonly<Record<string, (index: number) => number>> = {
  ArrowLeft: (index) => index - 1,
  ArrowRight: (index) => index + 1,
  Home: () => 0,
  End: () => TAB_ORDER.length - 1,
}

export const TargetPane = memo(function TargetPane({
  capturedLabel,
  guarded = false,
  evidence = null,
  tabs = false,
  tab = 'target',
  selected = null,
  onSelectTab,
  focusEvidence = 0,
}: TargetPaneProps) {
  const titleId = useId()
  const hostId = useId()
  const liveId = useId()
  const evidenceId = useId()
  const targetTabId = useId()
  const evidenceTabId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const tabRefs = useRef<Partial<Record<CanvasTab, HTMLButtonElement | null>>>({})
  const evidenceTitleRef = useRef<HTMLHeadingElement>(null)
  const focusHandled = useRef(focusEvidence)

  // The captured evidence replaces the released target; legacy evidence is a tab over the kept frame.
  const capturedEvidence = capturedLabel === 'completed-evidence' && evidence?.mode === 'captured' ? evidence : null
  const legacyEvidence = tabs && evidence?.mode === 'legacy' ? evidence : null
  const concealed = legacyEvidence !== null && tab === 'evidence'

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

  // A compare request moves focus once, after the evidence is shown.
  useEffect(() => {
    if (focusEvidence === focusHandled.current) return
    focusHandled.current = focusEvidence
    if (legacyEvidence !== null) tabRefs.current.evidence?.focus()
    else evidenceTitleRef.current?.focus()
  }, [focusEvidence, legacyEvidence])

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = Object.hasOwn(TAB_KEYS, event.key) ? TAB_KEYS[event.key] : undefined
    if (step === undefined || onSelectTab === undefined) return
    event.preventDefault()
    const next = TAB_ORDER[(step(TAB_ORDER.indexOf(tab)) + TAB_ORDER.length) % TAB_ORDER.length] ?? 'target'
    onSelectTab(next)
    tabRefs.current[next]?.focus()
  }

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
        {concealed && (
          <p className="target-pane__state" data-target-presentation="stored-evidence">
            Stored evidence (not live)
          </p>
        )}
        {legacyEvidence !== null && (
          <div className="canvas-tabs" role="tablist" aria-label="Canvas view" onKeyDown={onTabKey}>
            {TAB_ORDER.map((name) => (
              <button
                key={name}
                ref={(node) => {
                  tabRefs.current[name] = node
                }}
                id={name === 'target' ? targetTabId : evidenceTabId}
                type="button"
                role="tab"
                className="canvas-tabs__tab"
                aria-selected={tab === name}
                aria-controls={name === 'target' ? liveId : evidenceId}
                tabIndex={tab === name ? 0 : -1}
                data-tab={name}
                onClick={() => onSelectTab?.(name)}
              >
                {name === 'target' ? 'Target' : 'Evidence'}
              </button>
            ))}
          </div>
        )}
        <p id={hostId} className="target-pane__host">
          <code>{TARGET_APP_HOST}</code>
        </p>
      </header>
      <div ref={viewportRef} className="target-pane__viewport" tabIndex={guarded ? -1 : undefined} data-guarded={guarded ? 'true' : undefined}>
        {capturedEvidence === null ? (
          // The legacy Evidence tab hides and inerts this wrapper; it is never replaced or moved.
          <div
            key="live-target"
            id={liveId}
            className="target-pane__live"
            role={legacyEvidence === null ? undefined : 'tabpanel'}
            aria-labelledby={legacyEvidence === null ? undefined : targetTabId}
            data-concealed={concealed ? 'true' : undefined}
            inert={concealed}
          >
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
          <EvidenceComparison key="captured-evidence" view={capturedEvidence} selected={selected} titleRef={evidenceTitleRef} />
        )}
        {legacyEvidence !== null && (
          <EvidenceComparison
            key={`legacy-evidence:${legacyEvidence.runId}`}
            view={legacyEvidence}
            selected={selected}
            id={evidenceId}
            labelledBy={evidenceTabId}
            hidden={!concealed}
            titleRef={evidenceTitleRef}
          />
        )}
        {guarded && capturedEvidence === null && <div className="target-pane__cover" aria-hidden="true" />}
      </div>
    </section>
  )
})
