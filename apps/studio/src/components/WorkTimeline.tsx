import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { StudioEvent } from '../api.js'
import type { RunPresentation, WorkCardView } from '../presentation.js'

// The observed work of the work panel (Spec 005 slice 3), shared by both Studio modes. Its default
// view is a short summary of the current observed work, the supported next action and, apart from
// them, any live-activity warning. One Details disclosure, closed until the reader opens it, holds
// flat chronological rows: each row is one contiguous group of accepted events from the run
// presentation, with a nested Events disclosure of the raw records in their original order. No
// event is dropped, so a row the reader is using never disappears as work arrives.
//
// Disclosure choices are keyed by stable run/first-sequence identities and kept for the run while
// the component stays mounted, also through panel collapse and result arrival; they reset only for
// another run. New work never moves focus or scroll: when the reader is away from the latest work,
// an explicit control returns there, to its newest event when the latest row's Events are open.
// Only concise state changes are announced, never the log.
// The component renders the presentation it is given; it reads nothing and changes no run.

export interface ActivityWarning {
  /** The stable error code of the live-activity problem. */
  readonly code: string
  /** Its client-authored message; text carried by an error is never shown. */
  readonly message: string
}

export interface WorkTimelineProps {
  /** The run presentation from `selectRunPresentation`; the timeline never changes it. */
  readonly presentation: RunPresentation
  /** The mode's label of a raw event type. */
  readonly eventLabel: (event: StudioEvent) => string
  /** The mode's supporting detail of a raw event (a gate summary, Evidence IDs), rendered as text. */
  readonly eventDetail: (event: StudioEvent) => ReactNode
  /** The live-activity problem of a pending run, kept apart from its execution; null when none. */
  readonly activityWarning: ActivityWarning | null
}

/** The disclosure key of the outer Details; rows use their stable work identities. */
const DETAILS = 'details'

const NOTHING_OPEN: ReadonlySet<string> = new Set()

const FINALIZING_NOTES: Readonly<Record<RunPresentation['mode'], string>> = {
  legacy: 'Shown as Finalizing from the observed original-worktree gate update; its events keep the phase',
  captured: 'Shown as Finalizing from observed secret-scan or cleanup activity; its events keep the phase',
}

const rangeOf = (card: WorkCardView): string => (card.firstSequence === card.lastSequence ? `#${card.firstSequence}` : `#${card.firstSequence}–#${card.lastSequence}`)

function Chevron() {
  return (
    <svg className="icon disclosure__chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 3.75 10.25 8 6 12.25" />
    </svg>
  )
}

/** The visible part of the nearest scrolling ancestor, within the window. */
function readingViewport(node: HTMLElement): { readonly top: number; readonly bottom: number } {
  let top = 0
  let bottom = window.innerHeight
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const box = parent.getBoundingClientRect()
      top = Math.max(top, box.top)
      bottom = Math.min(bottom, box.bottom)
      break
    }
  }
  return { top, bottom }
}

interface WorkRowProps {
  readonly card: WorkCardView
  readonly mode: RunPresentation['mode']
  readonly open: boolean
  readonly onToggle: (key: string) => void
  readonly eventLabel: WorkTimelineProps['eventLabel']
  readonly eventDetail: WorkTimelineProps['eventDetail']
}

function WorkRow({ card, mode, open, onToggle, eventLabel, eventDetail }: WorkRowProps) {
  const eventsId = useId()
  const range = rangeOf(card)
  return (
    <li className="work-row" data-work-id={card.id} data-kind={card.kind} data-current={card.isCurrent ? 'true' : undefined}>
      <h4 className="work-row__title" tabIndex={-1}>
        {card.title}
        {card.isCurrent && <span className="visually-hidden"> (current work)</span>}
      </h4>
      <p className="work-row__status">{card.statusText}</p>
      {card.kind === 'finalizing' && (
        <p className="work-row__note">
          {FINALIZING_NOTES[mode]} <code>{card.phase ?? 'none'}</code>.
        </p>
      )}
      <button
        type="button"
        className="disclosure__toggle disclosure__toggle--nested"
        data-disclosure="events"
        aria-expanded={open}
        aria-controls={eventsId}
        onClick={() => onToggle(card.id)}
      >
        <Chevron />
        <span>Events</span>
        <span className="disclosure__meta">{range}</span>
      </button>
      <ol id={eventsId} className="agent-activity__list work-row__events" aria-label={`Events ${range}`} hidden={!open}>
        {card.events.map((event) => (
          // The raw accepted records, unchanged and in their original order. Each is focusable by
          // script only (never in the tab order), so the latest-work control can land on the newest.
          <li
            key={event.event_id}
            tabIndex={-1}
            className="agent-activity__item"
            data-type={event.type}
            data-phase={event.phase ?? 'none'}
            data-sequence={event.sequence}
            data-event-id={event.event_id}
          >
            <p className="agent-activity__meta">
              <span className="agent-activity__sequence">#{event.sequence}</span> <span className="agent-activity__type">{eventLabel(event)}</span>
              {event.phase !== null && (
                <>
                  {' · '}
                  <code className="agent-activity__phase">{event.phase}</code>
                </>
              )}
            </p>
            <p className="agent-activity__message">{event.message}</p>
            {eventDetail(event)}
          </li>
        ))}
      </ol>
    </li>
  )
}

/** The observed work of the current run: a summary, then one Details disclosure of chronological rows. */
export function WorkTimeline({ presentation, eventLabel, eventDetail, activityWarning }: WorkTimelineProps) {
  const headingId = useId()
  const detailsId = useId()
  const { runId, cards, execution } = presentation
  const final = execution === 'final'

  // Disclosure choices of this run only; another run starts with everything closed.
  const [disclosures, setDisclosures] = useState<{ readonly runId: string | null; readonly open: ReadonlySet<string> }>({ runId, open: NOTHING_OPEN })
  const open = disclosures.runId === runId ? disclosures.open : NOTHING_OPEN
  const toggle = useCallback(
    (key: string): void =>
      setDisclosures((current) => {
        const next = new Set(current.runId === runId ? current.open : NOTHING_OPEN)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return { runId, open: next }
      }),
    [runId],
  )
  const detailsOpen = open.has(DETAILS)

  // Reading position: whether the latest work is below what the reader sees, and the sequence of
  // the latest event the reader has been at. New events never scroll or move focus by themselves.
  const sectionRef = useRef<HTMLElement>(null)
  const [away, setAway] = useState(false)
  const [seenSequence, setSeenSequence] = useState<number | null>(null)
  const latest = cards.at(-1)
  const latestSequence = latest?.lastSequence ?? null
  const latestEventsOpen = latest !== undefined && open.has(latest.id)

  // The concrete end of the latest work: the newest event while the latest row's Events are open (a
  // row taller than the view can span it with that event still below), else that row, else the summary.
  const latestElement = useCallback((): HTMLElement | null => {
    const section = sectionRef.current
    if (section === null) return null
    if (detailsOpen && latest !== undefined) {
      const row = section.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(latest.id)}"]`)
      return (latestEventsOpen ? row?.querySelector<HTMLElement>('.work-row__events > .agent-activity__item:last-child') : null) ?? row
    }
    return section.querySelector<HTMLElement>('.work-summary') ?? section.querySelector<HTMLElement>('.work-timeline__details')
  }, [detailsOpen, latest, latestEventsOpen])

  const measure = useCallback((): void => {
    const section = sectionRef.current
    // A collapsed panel is hidden: the reader is nowhere, so nothing is seen or unseen.
    if (section === null || section.getClientRects().length === 0) return
    const element = latestElement()
    const isAway = element !== null && element.getBoundingClientRect().bottom > readingViewport(section).bottom + 2
    setAway(isAway)
    if (!isAway) setSeenSequence(latestSequence)
  }, [latestElement, latestSequence])

  useLayoutEffect(measure)
  useEffect(() => {
    const onChange = (): void => measure()
    // Scroll events do not bubble; capturing them at the document covers the panel and the page.
    document.addEventListener('scroll', onChange, { capture: true, passive: true })
    window.addEventListener('resize', onChange, { passive: true })
    return () => {
      document.removeEventListener('scroll', onChange, { capture: true })
      window.removeEventListener('resize', onChange)
    }
  }, [measure])

  const unseen = away && seenSequence !== null && latestSequence !== null ? Math.max(0, latestSequence - seenSequence) : 0
  const showLatest = away && !final && cards.length > 0

  const jumpToLatest = (): void => {
    const element = latestElement()
    if (element === null) return
    // The newest event is its own focus target, aligned to the bottom of the view; a row or the
    // summary is brought into view and focused on its heading.
    const isEvent = element.matches('.agent-activity__item')
    element.scrollIntoView({ block: isEvent ? 'end' : 'nearest' })
    const target = isEvent ? element : element.matches('.work-row') ? element.querySelector<HTMLElement>('.work-row__title') : document.getElementById(headingId)
    target?.focus({ preventScroll: true })
    measure()
  }

  // One short announcement per state change; the log itself is never a live region.
  const announcement = final ? '' : [presentation.label, presentation.activityNotice].filter((part) => part !== null).join('. ')

  return (
    <section
      ref={sectionRef}
      className="agent-panel__section work-timeline"
      aria-labelledby={final ? undefined : headingId}
      aria-label={final ? 'Observed work' : undefined}
      data-run-id={runId ?? 'none'}
    >
      {!final && (
        <div className="work-summary" data-execution={execution} data-phase={presentation.phase ?? 'none'} data-stream={presentation.stream ?? 'none'} data-tone={presentation.tone}>
          <h3 id={headingId} className="work-summary__heading" tabIndex={-1}>
            {presentation.label}
          </h3>
          {presentation.detail !== null && <p className="work-summary__detail">{presentation.detail}</p>}
          {presentation.nextAction !== null && <p className="work-summary__next">{presentation.nextAction}</p>}
          {activityWarning !== null && presentation.activityNotice !== null && (
            <p className="work-summary__warning" data-code={activityWarning.code}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.25v.25" />
              </svg>
              <span>{activityWarning.message}</span>
            </p>
          )}
        </div>
      )}
      {cards.length > 0 ? (
        <div className="work-timeline__details">
          <button
            type="button"
            className="disclosure__toggle"
            data-disclosure="details"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => toggle(DETAILS)}
          >
            <Chevron />
            <span>Details</span>
          </button>
          <div id={detailsId} className="work-timeline__panel" data-disclosure-panel="details" hidden={!detailsOpen}>
            <ol className="work-rows" aria-label="Observed work, oldest first">
              {cards.map((card) => (
                <WorkRow key={card.id} card={card} mode={presentation.mode} open={open.has(card.id)} onToggle={toggle} eventLabel={eventLabel} eventDetail={eventDetail} />
              ))}
            </ol>
          </div>
        </div>
      ) : (
        final && <p className="work-timeline__empty">No live activity was observed for this run.</p>
      )}
      {showLatest && (
        <button type="button" className="button button--secondary work-timeline__latest" onClick={jumpToLatest}>
          Jump to latest work{unseen > 0 && ` · ${unseen} new`}
        </button>
      )}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </section>
  )
}
