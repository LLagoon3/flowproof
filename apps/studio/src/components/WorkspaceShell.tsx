import { useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'

import { PANEL_WIDTHS_REM, initialWorkspacePresentation, panelWidthRem, panelWidthStepAt, panelWidthStepForKey, workspaceReducer } from '../presentation.js'
import type { CompactStatusView } from '../presentation.js'

// The Studio workspace shell (Spec 005): a work panel on the left and the larger canvas on the
// right. It owns only layout choices, kept in `presentation.ts`: the panel width, chosen by dragging
// or with the separator keys, and whether the panel is collapsed. Every slot it receives is rendered
// once, in one stable position, so a layout change never remounts, reparents or reloads anything:
// the canvas keeps the one target frame where it is, and a collapsed panel stays mounted, with its
// reads and subscriptions, but hidden and inert. Below 64rem the CSS stacks the panes and removes
// the separator, which keeps its width choice for the side-by-side layout.
//
// While the panel is collapsed, the canvas column shows a compact status derived by the caller from
// the authoritative state, the control that restores the panel, and, once a final result exists,
// an entry that restores the panel and focuses that retained result (the element marked
// `data-workspace-result`). Focus moves out of the panel to the restore control when the panel
// collapses, and back to the retained panel control when it is restored.

export interface WorkspaceShellProps {
  /** The compact current state, shown outside the collapsed panel. */
  readonly status: CompactStatusView
  /** The session context at the top of the panel: the prepared case or the fixed candidate. */
  readonly context: ReactNode
  /** The panel's work and result content. */
  readonly work: ReactNode
  /** The panel's primary entry: the request composer or the fixed-candidate start. */
  readonly entry: ReactNode
  /** The canvas: the one target pane. */
  readonly canvas: ReactNode
}

/** Where focus goes once a collapse or restore has been committed. */
type FocusIntent = 'restore-control' | 'retained' | 'result'

/** The selector of the retained final result that the restore entry focuses. */
const RESULT_SELECTOR = '[data-workspace-result]'

const MIN_WIDTH = PANEL_WIDTHS_REM[0]
const MAX_WIDTH = PANEL_WIDTHS_REM[PANEL_WIDTHS_REM.length - 1]

const isFocusable = (element: Element | null | undefined): element is HTMLElement =>
  element instanceof HTMLElement &&
  element.isConnected &&
  element.closest('[inert]') === null &&
  !(element instanceof HTMLButtonElement && element.disabled) &&
  element.getClientRects().length > 0

export function WorkspaceShell({ status, context, work, entry, canvas }: WorkspaceShellProps) {
  const panelId = useId()
  const statusId = useId()
  const [presentation, dispatch] = useReducer(workspaceReducer, initialWorkspacePresentation)
  const [resizing, setResizing] = useState(false)
  const { panelWidthStep: step, panelCollapsed: collapsed } = presentation
  const width = panelWidthRem(step)

  const panelRef = useRef<HTMLElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const restoreRef = useRef<HTMLButtonElement>(null)
  const dragPointer = useRef<number | null>(null)
  const retainedFocus = useRef<HTMLElement | null>(null)
  const focusIntent = useRef<FocusIntent | null>(null)

  // Runs after the collapse or restore is in the DOM, so the panel is already inert or available.
  useLayoutEffect(() => {
    const intent = focusIntent.current
    focusIntent.current = null
    if (intent === null) return
    if (intent === 'restore-control') {
      restoreRef.current?.focus()
      return
    }
    if (intent === 'result') {
      const result = panelRef.current?.querySelector(RESULT_SELECTOR)
      if (isFocusable(result)) {
        result.scrollIntoView({ block: 'nearest' })
        result.focus({ preventScroll: true })
        return
      }
    }
    const retained = retainedFocus.current
    if (isFocusable(retained)) retained.focus({ preventScroll: true })
    else collapseRef.current?.focus()
  }, [collapsed])

  const collapse = (): void => {
    if (collapsed) return
    const panel = panelRef.current
    const active = document.activeElement
    const inPanel = panel !== null && active !== null && panel.contains(active)
    retainedFocus.current = inPanel && active instanceof HTMLElement ? active : null
    // Focus never stays on a control that becomes hidden.
    focusIntent.current = inPanel || active === separatorRef.current ? 'restore-control' : null
    dispatch({ type: 'panel/collapse' })
  }

  const restore = (target: Exclude<FocusIntent, 'restore-control'>): void => {
    if (!collapsed) return
    focusIntent.current = target
    dispatch({ type: 'panel/restore' })
  }

  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = panelWidthStepForKey(step, event.key)
    if (next === null) return
    event.preventDefault()
    dispatch({ type: 'panel/width', step: next })
  }

  const onSeparatorPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    dragPointer.current = event.pointerId
    setResizing(true)
  }

  const onSeparatorPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    if (dragPointer.current !== event.pointerId || panel === null) return
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    dispatch({ type: 'panel/width', step: panelWidthStepAt(event.clientX - panel.getBoundingClientRect().left, rootFontSize) })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragPointer.current !== event.pointerId) return
    dragPointer.current = null
    setResizing(false)
  }

  return (
    <main className="workspace" data-panel-step={step} data-collapsed={collapsed} data-resizing={resizing ? 'true' : undefined}>
      <aside ref={panelRef} id={panelId} className="work-panel" aria-label="Work panel" hidden={collapsed} inert={collapsed}>
        <div className="work-panel__head">
          <div className="work-panel__context">{context}</div>
          <button
            ref={collapseRef}
            type="button"
            className="icon-button"
            aria-label="Collapse work panel"
            aria-controls={panelId}
            aria-expanded="true"
            onClick={collapse}
          >
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
              <path d="M6 2.75v10.5M10.75 6.25 9 8l1.75 1.75" />
            </svg>
          </button>
        </div>
        <div className="work-panel__body">{work}</div>
        <div className="work-panel__entry">{entry}</div>
      </aside>
      <div
        ref={separatorRef}
        className="workspace__separator"
        role="separator"
        hidden={collapsed}
        tabIndex={0}
        aria-orientation="vertical"
        aria-controls={panelId}
        aria-label="Work panel width"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        aria-valuetext={`${width}rem`}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onSeparatorPointerDown}
        onPointerMove={onSeparatorPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="workspace__canvas">
        <div className="workspace__collapsed" hidden={!collapsed}>
          <button
            ref={restoreRef}
            type="button"
            className="button button--secondary"
            aria-controls={panelId}
            aria-expanded="false"
            aria-describedby={statusId}
            onClick={() => restore('retained')}
          >
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
              <path d="M6 2.75v10.5M9 6.25 10.75 8 9 9.75" />
            </svg>
            Show work panel
          </button>
          <p id={statusId} className="workspace__status" role="status" data-workspace-status={status.tone}>
            <span className="workspace__status-label">{status.label}</span>
            {status.activityNotice !== null && <span className="workspace__status-notice">{status.activityNotice}</span>}
          </p>
          {status.hasResult && (
            <button type="button" className="button button--quiet" aria-controls={panelId} onClick={() => restore('result')}>
              View result
            </button>
          )}
        </div>
        {canvas}
      </div>
    </main>
  )
}
