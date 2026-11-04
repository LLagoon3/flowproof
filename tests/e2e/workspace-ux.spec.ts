import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Frame, Locator, Page, Request, Route } from '@playwright/test'

import { CONTRACT_SCHEMA_VERSION, GATE_IDS, parseEvidenceBundle, parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { CAPTURED_CHECK_IDS } from '../../packages/flowproof/src/verify/capturedContracts.js'
import type { CapturedVerificationResult } from '../../packages/flowproof/src/verify/capturedContracts.js'
import { produceCanvasCandidate } from '../support/capturedCanvasCandidate.js'
import { removeFixtureImage } from '../support/editingRuntime.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'
import { CAPTURED_SCENARIO_ID, openCapturedVerificationHarness, openStudioHarness } from '../support/studioHarness.js'
import type { CapturedStudioHarness, CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T010 for T011-T015 (Spec 005 slice 2): the real Studio workspace in the headed launcher-owned
// browser, through the existing harnesses only. The work panel sits left of the larger canvas, its
// width is one of seven bounded choices chosen by dragging or with the separator keys, and it
// collapses and restores without unmounting anything: the request draft, the one target iframe
// element and Playwright frame, the one accepted start, pending artifact reads and open details
// all survive, and no layout change navigates the frame, starts a run or repeats a read. Outside
// the collapsed panel a compact status follows the authoritative result only, and its result entry
// restores the panel and focuses that result. Below 64rem the panes stack and the separator leaves
// the layout and the focus order.
//
// The captured case changes the width and collapses the panel while the guarded target is being
// measured, and compares the run with a matched unresized control: the same outcome and checks,
// 640 x 360 screenshots, and screenshot evidence bound to each run's own manifests, with the guard
// intact and the same frame until release. Result reads are held by a test-local route, so the
// collapsed status is observed before and after the bound result reaches the page. A third run
// loses its live activity through a test-local route at once: the engine measures both phases
// unseen, the layout requests made meanwhile stay pending with no live label or verdict, and only
// the bound result applies them, with the same outcome and persisted evidence as the control. Its
// evidence pane names the screenshots the page never received rather than guessing their IDs.
//
// Screenshots, layout, contrast and focus measurements are kept for review under the ignored
// `.flowproof/review/005-studio-workspace-ux/<tested-sha>/slice2/<case>/<stamp>/` of this checkout,
// outside Playwright's cleared output. The opt-in `native-zoom-review` case keeps the same
// launcher-owned page at 1280 x 720 while an operator applies actual native 200% browser zoom and
// acknowledges it, and the reset, through bounded marker files (quickstart.md, slice 2).

const HERO = 'canvas-filter-hero'
const RUN_BUDGET_MS = 300_000
const PANEL_WIDTHS = [20, 22, 24, 26, 28, 30, 32] as const
/** The applied width choice of the default 24rem panel. */
const DEFAULT_STEP = PANEL_WIDTHS.indexOf(24)
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
const TARGET_DOCUMENT = scenario.scenario.app.url
const CANVAS = scenario.scenario.app.canvas

const TESTED_SHA = git(REPO_ROOT, 'rev-parse', 'HEAD').trim()
const WORKTREE_DIRTY = git(REPO_ROOT, 'status', '--porcelain', '--untracked-files=no').trim() !== ''
const REVIEW_BASE = path.join(REPO_ROOT, '.flowproof', 'review', '005-studio-workspace-ux', TESTED_SHA)
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-')

/** Bounds every read of an element that may be missing; the launcher's contexts set no action timeout. */
const ELEMENT_TIMEOUT_MS = 10_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const pngSize = (bytes: Buffer): { readonly width: number; readonly height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

test.afterAll(async () => {
  await removeFixtureImage()
})

// ---------------------------------------------------------------------------------------
// Review evidence kept outside Playwright output
// ---------------------------------------------------------------------------------------

interface ReviewCase {
  readonly dir: string
  shot(page: Page, name: string): Promise<void>
  record(key: string, value: unknown): void
  finish(error?: unknown): Promise<void>
}

async function reviewCase(name: string, slice = 'slice2'): Promise<ReviewCase> {
  const dir = path.join(REVIEW_BASE, slice, name, RUN_STAMP)
  await mkdir(dir, { recursive: true })
  const screenshots: string[] = []
  const records: Record<string, unknown> = {}
  const startedAt = new Date().toISOString()
  return {
    dir,
    async shot(page, file) {
      await page.screenshot({ path: path.join(dir, file), fullPage: true })
      screenshots.push(file)
    },
    record(key, value) {
      records[key] = value
    },
    async finish(error) {
      const manifest = {
        case: name,
        slice,
        testedSha: TESTED_SHA,
        worktreeDirty: WORKTREE_DIRTY,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: error === undefined ? 'passed' : 'failed',
        failure: error === undefined ? null : { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? (error.stack ?? null) : null },
        screenshots,
        records,
      }
      await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    },
  }
}

// ---------------------------------------------------------------------------------------
// Workspace locators and layout
// ---------------------------------------------------------------------------------------

interface Workspace {
  readonly root: Locator
  readonly panel: Locator
  readonly separator: Locator
  readonly collapse: Locator
  readonly restore: Locator
  readonly status: Locator
  readonly viewResult: Locator
}

const workspaceOf = (page: Page): Workspace => ({
  root: page.locator('main.workspace'),
  panel: page.locator('aside.work-panel'),
  separator: page.getByRole('separator', { name: 'Work panel width', includeHidden: true }),
  collapse: page.getByRole('button', { name: 'Collapse work panel', includeHidden: true }),
  restore: page.getByRole('button', { name: 'Show work panel', includeHidden: true }),
  status: page.locator('[data-workspace-status]'),
  viewResult: page.getByRole('button', { name: 'View result' }),
})

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface LayoutSample {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly devicePixelRatio: number
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly rootFontSize: number
  readonly panel: Box | null
  readonly canvas: Box | null
  readonly frame: Box | null
  readonly separator: Box | null
  readonly step: string | null
  readonly collapsed: string | null
}

async function layoutOf(page: Page): Promise<LayoutSample> {
  return page.evaluate(() => {
    const box = (selector: string): Box | null => {
      const element = document.querySelector(selector)
      if (element === null || element.getClientRects().length === 0) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const workspace = document.querySelector('main.workspace')
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      panel: box('aside.work-panel'),
      canvas: box('.workspace__canvas'),
      frame: box('.target-pane__viewport'),
      separator: box('.workspace__separator'),
      step: workspace?.getAttribute('data-panel-step') ?? null,
      collapsed: workspace?.getAttribute('data-collapsed') ?? null,
    }
  })
}

/** Side by side: the panel at its chosen width left of the larger canvas, no page-wide horizontal scroll. */
function expectSideBySide(layout: LayoutSample, widthRem: number): void {
  expect(layout.scrollWidth, 'no page-wide horizontal overflow').toBeLessThanOrEqual(layout.clientWidth)
  if (layout.panel === null || layout.canvas === null || layout.separator === null) throw new Error(`The side-by-side workspace is incomplete: ${JSON.stringify(layout)}`)
  expect(Math.abs(layout.panel.width - widthRem * layout.rootFontSize)).toBeLessThanOrEqual(1)
  expect(layout.panel.x + layout.panel.width).toBeLessThanOrEqual(layout.separator.x + 0.5)
  expect(layout.separator.x + layout.separator.width).toBeLessThanOrEqual(layout.canvas.x + 0.5)
  expect(layout.canvas.width).toBeGreaterThan(layout.panel.width)
  expect(Math.abs(layout.panel.y - layout.canvas.y)).toBeLessThanOrEqual(1)
}

/** Stacked below 64rem: the panel above the canvas, no separator, no page-wide horizontal scroll. */
function expectStacked(layout: LayoutSample): void {
  expect(layout.scrollWidth, 'no page-wide horizontal overflow').toBeLessThanOrEqual(layout.clientWidth)
  expect(layout.separator).toBeNull()
  if (layout.panel === null || layout.canvas === null) throw new Error(`The stacked workspace is incomplete: ${JSON.stringify(layout)}`)
  expect(layout.panel.y + layout.panel.height).toBeLessThanOrEqual(layout.canvas.y + 0.5)
  expect(Math.abs(layout.panel.x - layout.canvas.x)).toBeLessThanOrEqual(1)
}

/** Presses Tab up to `limit` times from the page start and returns what took focus, by role and name. */
async function tabOrder(page: Page, limit = 30): Promise<string[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.locator('h1').click()
  const seen: string[] = []
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab')
    const entry = await page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active === document.body) return 'body'
      const name = active.getAttribute('aria-label') ?? (active instanceof HTMLSelectElement ? 'select' : (active.textContent ?? '').trim().slice(0, 40))
      return `${active.getAttribute('role') ?? active.tagName.toLowerCase()}:${name}${active.closest('aside.work-panel') === null ? '' : ' (panel)'}`
    })
    seen.push(entry)
    // Focus inside the target frame continues in the target app, which is not the Studio's.
    if (entry.startsWith('iframe')) break
  }
  return seen
}

// ---------------------------------------------------------------------------------------
// Contrast and focus measured from the rendered page
// ---------------------------------------------------------------------------------------

interface ContrastFailure {
  readonly kind: 'text' | 'control' | 'focus'
  readonly element: string
  readonly ratio: number
  readonly required: number
  readonly detail: string
}

interface ContrastReport {
  readonly textSamples: number
  readonly controlSamples: number
  readonly minimumText: number
  readonly minimumControl: number
  readonly failures: readonly ContrastFailure[]
}

/**
 * Rendered contrast of every visible Studio text run and every control boundary, icon or fill, on
 * the background actually composited behind it (translucent layers included). Text is large only at
 * >= 24px, or >= 18.67px when bold. Disabled controls are exempt and not counted. The target app
 * inside the frame is not part of the Studio and is not measured.
 */
async function auditContrast(page: Page): Promise<ContrastReport> {
  return page.evaluate(() => {
    type Rgba = readonly [number, number, number, number]
    const parse = (value: string): Rgba | null => {
      const match = /rgba?\(([^)]+)\)/.exec(value)
      if (match === null) return null
      const parts = (match[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number)
      const [r = 0, g = 0, b = 0, a = 1] = parts
      return [r, g, b, a]
    }
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3])
      if (a === 0) return [0, 0, 0, 0]
      const mix = (i: 0 | 1 | 2): number => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a
      return [mix(0), mix(1), mix(2), a]
    }
    const background = (element: Element | null): Rgba => {
      const layers: Rgba[] = []
      for (let node = element; node !== null; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color !== null && color[3] > 0) {
          layers.push(color)
          if (color[3] >= 1) break
        }
      }
      let result: Rgba = [255, 255, 255, 1]
      for (const layer of layers.reverse()) result = over(layer, result)
      return result
    }
    const luminance = (color: Rgba): number => {
      const channel = (value: number): number => {
        const s = value / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
    }
    const ratio = (a: Rgba, b: Rgba): number => {
      const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
      return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
    }
    const visible = (element: Element): boolean => {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 1 && rect.height > 1
    }
    const describe = (element: Element): string => {
      const cls = typeof element.className === 'string' && element.className !== '' ? `.${element.className.trim().split(/\s+/).join('.')}` : ''
      return `${element.tagName.toLowerCase()}${cls} "${(element.textContent ?? '').trim().slice(0, 40)}"`
    }
    const disabled = (element: Element): boolean => element.closest(':disabled, [aria-disabled="true"]') !== null
    const failures: ContrastFailure[] = []
    let textSamples = 0
    let controlSamples = 0
    let minimumText = Number.POSITIVE_INFINITY
    let minimumControl = Number.POSITIVE_INFINITY

    for (const element of document.querySelectorAll('body *')) {
      if (element.closest('iframe, svg, script, style') !== null && !(element instanceof SVGSVGElement)) continue
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
      if (!ownText || !visible(element) || disabled(element)) continue
      const style = getComputedStyle(element)
      const size = Number.parseFloat(style.fontSize)
      const bold = Number.parseInt(style.fontWeight, 10) >= 700
      const required = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
      const back = background(element)
      const fore = parse(style.color)
      if (fore === null) continue
      const value = ratio(over(fore, back), back)
      textSamples += 1
      minimumText = Math.min(minimumText, value)
      if (value < required) failures.push({ kind: 'text', element: describe(element), ratio: value, required, detail: `${style.color} on ${back.join(',')}` })
    }

    const controls = document.querySelectorAll('button, select, textarea, input, [role="separator"], form.composer')
    for (const control of controls) {
      if (!visible(control) || disabled(control)) continue
      const style = getComputedStyle(control)
      const around = background(control.parentElement)
      const fill = parse(style.backgroundColor)
      const border = parse(style.borderTopColor)
      const borderWidth = Number.parseFloat(style.borderTopWidth)
      const values: number[] = []
      if (fill !== null && fill[3] > 0) values.push(ratio(over(fill, around), around))
      if (border !== null && border[3] > 0 && borderWidth > 0) values.push(ratio(over(border, around), around))
      const icon = control.querySelector('svg')
      const iconOnly = icon !== null && (control.textContent ?? '').trim() === ''
      if (iconOnly) values.push(ratio(over(parse(style.color) ?? [0, 0, 0, 1], background(control)), background(control)))
      if (control.getAttribute('role') === 'separator') {
        const grip = parse(getComputedStyle(control, '::after').backgroundColor)
        if (grip !== null && grip[3] > 0) values.push(ratio(over(grip, around), around))
      }
      // A text-only control is identified by its text, which the text check above covers.
      if (values.length === 0) continue
      const best = Math.max(...values)
      controlSamples += 1
      minimumControl = Math.min(minimumControl, best)
      if (best < 3) failures.push({ kind: 'control', element: describe(control), ratio: best, required: 3, detail: values.join(' / ') })
    }
    return { textSamples, controlSamples, minimumText, minimumControl, failures }
  })
}

interface FocusStop {
  readonly element: string
  readonly outline: string
  readonly ratio: number
}

/** Tabs through the Studio and measures each focused control's visible indicator against its background. */
async function auditFocus(page: Page, limit = 24): Promise<{ readonly stops: readonly FocusStop[]; readonly failures: readonly ContrastFailure[] }> {
  await page.locator('h1').click()
  const stops: FocusStop[] = []
  const failures: ContrastFailure[] = []
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active === document.body || active.tagName === 'IFRAME') return null
      type Rgba = readonly [number, number, number, number]
      const parse = (value: string): Rgba => {
        const parts = (/rgba?\(([^)]+)\)/.exec(value)?.[1] ?? '0,0,0,0').split(/[\s,/]+/).filter(Boolean).map(Number)
        const [r = 0, g = 0, b = 0, a = 1] = parts
        return [r, g, b, a]
      }
      const opaqueBehind = (element: Element | null): Rgba => {
        for (let node = element; node !== null; node = node.parentElement) {
          const color = parse(getComputedStyle(node).backgroundColor)
          if (color[3] >= 1) return color
        }
        return [255, 255, 255, 1]
      }
      const luminance = (c: Rgba): number =>
        [c[0], c[1], c[2]].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
      // The request field shows focus on its composer boundary.
      const ring = active.matches('textarea') ? (active.closest('.composer') ?? active) : active
      const style = getComputedStyle(ring)
      const width = Number.parseFloat(style.outlineWidth)
      const color = parse(style.outlineColor)
      const behind = opaqueBehind(ring.parentElement)
      const [l1, l2] = [luminance(color), luminance(behind)].sort((a, b) => b - a) as [number, number]
      const value = style.outlineStyle === 'none' || width < 2 ? 0 : Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100
      return {
        element: `${active.tagName.toLowerCase()}[${active.getAttribute('aria-label') ?? (active.textContent ?? '').trim().slice(0, 30)}]`,
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        ratio: value,
      }
    })
    if (stop === null) continue
    if (stops.some((seen) => seen.element === stop.element)) break
    stops.push(stop)
    if (stop.ratio < 3) failures.push({ kind: 'focus', element: stop.element, ratio: stop.ratio, required: 3, detail: stop.outline })
  }
  return { stops, failures }
}

async function expectAccessible(page: Page, review: ReviewCase, label: string): Promise<void> {
  const contrast = await auditContrast(page)
  const focus = await auditFocus(page)
  review.record(`contrast:${label}`, contrast)
  review.record(`focus:${label}`, focus)
  expect(contrast.textSamples, label).toBeGreaterThan(0)
  expect(contrast.failures, label).toEqual([])
  expect(focus.stops.length, label).toBeGreaterThan(0)
  expect(focus.failures, label).toEqual([])
}

// ---------------------------------------------------------------------------------------
// Target frame identity and request accounting
// ---------------------------------------------------------------------------------------

interface FrameTracker {
  readonly frame: Frame
  navigations(): number
  /** The URLs exactly this frame navigated to, in order. */
  navigationUrls(): readonly string[]
  frameChanges(): number
  detached(): boolean
  /** The Studio still holds the very iframe element and frame tracked at the start. */
  expectSameFrame(): Promise<void>
}

async function trackFrame(page: Page): Promise<FrameTracker> {
  const iframes = page.locator('iframe')
  await expect(iframes).toHaveCount(1)
  const element = await iframes.elementHandle()
  const frame = await element?.contentFrame()
  if (!element || !frame) throw new Error('The Studio has no target frame.')
  const token = randomUUID()
  await element.evaluate((node, value) => Object.defineProperty(node, '__flowproofWorkspaceFrame', { value, enumerable: false }), token)
  await element.dispose()
  const urls: string[] = []
  let changes = 0
  page.on('framenavigated', (navigated) => {
    if (navigated === frame) urls.push(navigated.url())
  })
  page.on('frameattached', () => (changes += 1))
  page.on('framedetached', () => (changes += 1))
  return {
    frame,
    navigations: () => urls.length,
    navigationUrls: () => [...urls],
    frameChanges: () => changes,
    detached: () => frame.isDetached(),
    async expectSameFrame() {
      const current = page.locator('iframe')
      await expect(current).toHaveCount(1)
      const handle = await current.elementHandle()
      expect(await handle?.evaluate((node) => (node as unknown as Record<string, unknown>).__flowproofWorkspaceFrame)).toBe(token)
      expect(await handle?.contentFrame()).toBe(frame)
      await handle?.dispose()
      expect(frame.isDetached()).toBe(false)
      expect(page.frames()).toHaveLength(2)
    },
  }
}

interface RequestLog {
  readonly starts: () => number
  readonly evidenceReads: () => readonly string[]
}

function logRequests(page: Page): RequestLog {
  const starts: string[] = []
  const evidence: string[] = []
  page.on('request', (request: Request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/runs' && request.method() === 'POST') starts.push(url.pathname)
    if (/^\/api\/runs\/[^/]+\/evidence\//.test(url.pathname)) evidence.push(url.pathname)
  })
  return { starts: () => starts.length, evidenceReads: () => [...evidence] }
}

interface Barrier {
  release(): void
  /** Requests that reached the barrier. */
  held(): number
}

/** Holds every matching request until released; held requests then continue to the real server. */
async function holdRequests(page: Page, matches: (url: URL) => boolean): Promise<Barrier> {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => (release = resolve))
  let held = 0
  await page.route(
    (url) => matches(url),
    async (route: Route) => {
      held += 1
      await released
      await route.continue().catch(() => undefined)
    },
  )
  return { release: () => release(), held: () => held }
}

const isResultRead = (url: URL): boolean => /^\/api\/runs\/[^/]+\/result$/.test(url.pathname)

/** Width choice the separator currently reports, in rem. */
const separatorWidth = async (workspace: Workspace): Promise<number> => Number(await workspace.separator.getAttribute('aria-valuenow', { timeout: ELEMENT_TIMEOUT_MS }))

/** The element the restore entry focused, by its result marker. */
const focusedIsResult = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.hasAttribute('data-workspace-result') === true)

/** Drags the separator so that the panel's right edge lands at `widthRem`. */
async function dragPanelTo(page: Page, workspace: Workspace, widthRem: number): Promise<void> {
  const separator = await workspace.separator.boundingBox()
  const panel = await workspace.panel.boundingBox()
  if (separator === null || panel === null) throw new Error('The separator or panel has no box.')
  const rootFontSize = (await layoutOf(page)).rootFontSize
  const y = separator.y + separator.height / 2
  await page.mouse.move(separator.x + separator.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(panel.x + widthRem * rootFontSize, y, { steps: 8 })
  await page.mouse.up()
}

function expectNothingLeft(cleanup: CleanupReport | undefined, baseline: unknown): void {
  expect(cleanup).toBeDefined()
  if (!cleanup) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(baseline)
}

// ---------------------------------------------------------------------------------------
// Legacy prepared case
// ---------------------------------------------------------------------------------------

test('the legacy workspace keeps the draft, the target frame, one run and pending reads through resizing, collapse and the result', async () => {
  test.setTimeout(RUN_BUDGET_MS + 240_000)
  const review = await reviewCase('legacy-workspace')
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    const workspace = workspaceOf(page)
    const requests = logRequests(page)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    review.record('browserVersion', page.context().browser()?.version() ?? null)

    await page.setViewportSize({ width: 1280, height: 720 })
    const request = page.getByLabel(/request/i)
    await expect(request).toHaveValue(scenario.scenario.default_request)
    const start = page.getByRole('button', { name: /^(start|send|run)\b/i })
    await expect(start).toBeVisible()
    await expect(start).toBeEnabled()
    await expect(page.getByLabel('Prepared case')).toHaveValue(HERO)
    const tracker = await trackFrame(page)

    // Ready at 1280 x 720: the 24rem default panel beside the larger canvas.
    await expect(workspace.separator).toHaveAttribute('aria-valuenow', '24')
    await expect(workspace.separator).toHaveAttribute('aria-valuemin', '20')
    await expect(workspace.separator).toHaveAttribute('aria-valuemax', '32')
    expectSideBySide(await layoutOf(page), 24)
    review.record('layout:ready-1280x720', await layoutOf(page))
    await review.shot(page, 'ready-1280x720.png')
    await expectAccessible(page, review, 'ready-1280x720')

    // The draft is the user's own text from here on.
    const draft = `${scenario.scenario.default_request} Keep this draft through layout changes.`
    await request.fill(draft)

    // Keyboard resizing through every bound, on the same width choice the drag uses.
    await workspace.separator.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    expect(await separatorWidth(workspace)).toBe(28)
    expectSideBySide(await layoutOf(page), 28)
    await page.keyboard.press('End')
    expect(await separatorWidth(workspace)).toBe(32)
    await page.keyboard.press('ArrowUp')
    expect(await separatorWidth(workspace)).toBe(32)
    expectSideBySide(await layoutOf(page), 32)
    await page.keyboard.press('Home')
    expect(await separatorWidth(workspace)).toBe(20)
    await page.keyboard.press('ArrowLeft')
    expect(await separatorWidth(workspace)).toBe(20)
    expectSideBySide(await layoutOf(page), 20)
    for (const width of PANEL_WIDTHS.slice(1)) {
      await page.keyboard.press('ArrowRight')
      expect(await separatorWidth(workspace)).toBe(width)
    }
    await workspace.separator.press('Home')
    await workspace.separator.press('ArrowRight')
    await workspace.separator.press('ArrowRight')
    expect(await separatorWidth(workspace)).toBe(24)

    // Dragging snaps to the nearest choice.
    await dragPanelTo(page, workspace, 30.4)
    expect(await separatorWidth(workspace)).toBe(30)
    expectSideBySide(await layoutOf(page), 30)
    await dragPanelTo(page, workspace, 23.8)
    expect(await separatorWidth(workspace)).toBe(24)
    await expect(request).toHaveValue(draft)

    // Collapse with the keyboard: focus moves to the restore control, the panel is hidden and inert.
    await workspace.collapse.focus()
    await page.keyboard.press('Enter')
    await expect(workspace.panel).toBeHidden()
    await expect(workspace.separator).toBeHidden()
    await expect(workspace.restore).toBeFocused()
    await expect(workspace.status).toHaveText('Ready')
    await expect(workspace.viewResult).toHaveCount(0)
    expect(await workspace.panel.evaluate((node) => node.hasAttribute('inert'))).toBe(true)
    const collapsedLayout = await layoutOf(page)
    expect(collapsedLayout.scrollWidth).toBeLessThanOrEqual(collapsedLayout.clientWidth)
    expect(collapsedLayout.panel).toBeNull()
    expect(collapsedLayout.canvas?.width ?? 0).toBeGreaterThan(1280 - 2 * 16 - 8)
    const collapsedTabs = await tabOrder(page, 8)
    review.record('tabOrder:collapsed', collapsedTabs)
    expect(collapsedTabs.some((entry) => entry.endsWith('(panel)') || entry.startsWith('separator'))).toBe(false)
    await review.shot(page, 'collapsed-ready-1280x720.png')

    // Restore with the keyboard: focus returns to the panel control that had it.
    await workspace.restore.focus()
    await page.keyboard.press('Enter')
    await expect(workspace.panel).toBeVisible()
    await expect(workspace.collapse).toBeFocused()
    await expect(request).toHaveValue(draft)
    expect(await separatorWidth(workspace)).toBe(24)
    expectSideBySide(await layoutOf(page), 24)

    // A pointer collapse also moves focus out of the hidden panel, and a pointer restore returns it.
    await request.focus()
    await workspace.collapse.click()
    await expect(workspace.restore).toBeFocused()
    await workspace.restore.click()
    await expect(workspace.panel).toBeVisible()
    await expect(workspace.collapse).toBeFocused()
    await expect(request).toHaveValue(draft)

    // 100% viewport reflow: stacked below 64rem with no separator in layout or focus order.
    await page.setViewportSize({ width: 900, height: 720 })
    const stacked = await layoutOf(page)
    expectStacked(stacked)
    await expect(workspace.separator).toBeHidden()
    expect(await separatorWidth(workspace)).toBe(24)
    const stackedTabs = await tabOrder(page, 12)
    review.record('tabOrder:stacked-900x720', stackedTabs)
    expect(stackedTabs.some((entry) => entry.startsWith('separator'))).toBe(false)
    await review.shot(page, 'stacked-900x720.png')
    await workspace.collapse.click()
    await expect(workspace.restore).toBeFocused()
    await expect(workspace.panel).toBeHidden()
    await workspace.restore.click()
    await expect(workspace.panel).toBeVisible()
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(size)
      const compact = await layoutOf(page)
      expectStacked(compact)
      review.record(`layout:compact-${size.width}x${size.height}`, compact)
      await start.scrollIntoViewIfNeeded()
      await expect(start).toBeVisible()
      await workspace.collapse.scrollIntoViewIfNeeded()
      await expect(workspace.collapse).toBeVisible()
      await review.shot(page, `compact-${size.width}x${size.height}.png`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expectAccessible(page, review, 'compact-390x844')
    await page.setViewportSize({ width: 1920, height: 1080 })
    expectSideBySide(await layoutOf(page), 24)
    await review.shot(page, 'ready-1920x1080.png')
    await expectAccessible(page, review, 'ready-1920x1080')
    await page.setViewportSize({ width: 1280, height: 720 })
    expectSideBySide(await layoutOf(page), 24)
    await expect(request).toHaveValue(draft)

    // Nothing so far navigated the frame, started a run, or replaced the frame element.
    await tracker.expectSameFrame()
    expect(tracker.navigations()).toBe(0)
    expect(tracker.frameChanges()).toBe(0)
    expect(requests.starts()).toBe(0)

    // Hold result reads in the page and one JSON evidence read, so their arrival is observable.
    const results = await holdRequests(page, isResultRead)
    const consoleRead = await holdRequests(page, (url) => /\/evidence\/ev_failure_console_[0-9]{3}$/.test(url.pathname))

    // The one start, then layout changes while the run is in progress. A change requested while the
    // target is measured is applied when that measurement ends, so these waits allow for the hold.
    await recordWorkspace(page, false)
    await start.click()
    await expect.poll(() => requests.starts()).toBe(1)
    await workspace.collapse.click()
    await expect(workspace.panel).toBeHidden({ timeout: RUN_BUDGET_MS })
    await expect(workspace.status).toContainText('Run in progress')
    await review.shot(page, 'running-collapsed.png')
    await workspace.restore.click({ timeout: RUN_BUDGET_MS })
    await expect(workspace.panel).toBeVisible({ timeout: RUN_BUDGET_MS })
    await workspace.separator.focus()
    await page.keyboard.press('ArrowRight')
    expect(await separatorWidth(workspace)).toBe(26)
    await workspace.collapse.click()
    await expect(workspace.panel).toBeHidden({ timeout: RUN_BUDGET_MS })

    // The run finalizes while the panel is collapsed; the page has not read the result yet.
    const finished = await harness.waitForResult(RUN_BUDGET_MS)
    expect(finished.result.status).toBe('Verified Fix')
    // Reproduction and replay each held the layout, and nothing was applied while held.
    await expect(workspace.root).not.toHaveAttribute('data-layout-held', 'true')
    const layoutSamples = await recordedSamples(page)
    review.record('layoutSamples', layoutSamples)
    expectHeldDuringMeasurement(layoutSamples, 2)
    // The page observed the integrity gate and the final event, but holds no result: finalizing,
    // with no verdict (the same run presentation as the panel, slice 3).
    await expect(workspace.status).toHaveText('Finalizing · verdict pending')
    await expect(workspace.viewResult).toHaveCount(0)
    expect(await workspace.status.innerText()).not.toMatch(/Verified Fix|Unverified/)
    await review.shot(page, 'result-pending-collapsed.png')

    // The authoritative result arrives while collapsed and updates the compact status.
    results.release()
    await expect(workspace.status).toHaveText('Verified Fix')
    await expect(workspace.status).toHaveAttribute('data-workspace-status', 'success')
    await expect(workspace.viewResult).toBeVisible()
    // The mounted, hidden Proof Trail already started its reads; one of them is still held.
    await expect.poll(() => consoleRead.held()).toBe(1)
    await expect(workspace.panel).toBeHidden()
    await review.shot(page, 'final-collapsed.png')

    // The result entry restores the panel and focuses the retained result.
    await workspace.viewResult.focus()
    await page.keyboard.press('Enter')
    await expect(workspace.panel).toBeVisible()
    await expect.poll(() => focusedIsResult(page)).toBe(true)
    await expect(page.locator(':focus')).toContainText('Verified Fix')
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Verified Fix', { exact: true })).toBeVisible()
    expect(await separatorWidth(workspace)).toBe(26)
    await expect(request).toHaveValue(draft)

    // The held read is still pending, and survives another collapse until it is released.
    const proofTrail = page.getByRole('region', { name: 'Proof Trail', exact: true })
    await expect(proofTrail).toHaveAttribute('data-run-id', finished.runId)
    const failureSection = proofTrail.getByRole('region', { name: 'Failure evidence', exact: true })
    const consoleItem = failureSection.locator('li[data-type="console"]')
    await expect(consoleItem).toContainText('Loading the evidence.')
    const datasetDetails = failureSection.locator('li[data-type="dataset"] details')
    const consoleDetails = consoleItem.locator('details')
    await expect(datasetDetails).toHaveAttribute('open', '')
    await datasetDetails.locator('summary').click()
    await consoleDetails.locator('summary').click()
    await workspace.collapse.click()
    consoleRead.release()
    await sleep(500)
    await workspace.restore.click()
    await expect(workspace.panel).toBeVisible()
    await expect(datasetDetails).not.toHaveAttribute('open', '')
    await expect(consoleDetails).toHaveAttribute('open', '')
    const failureBundle = parseEvidenceBundle(await harness.readJson(finished.runId, 'evidence/failure/manifest.json'))
    if (!failureBundle.ok) throw new Error('The failure manifest violates the evidence-bundle contract.')
    const consoleEvidence = failureBundle.value.items.find((item) => item.type === 'console')
    if (consoleEvidence === undefined) throw new Error('The failure bundle has no console evidence.')
    expect(JSON.parse((await consoleDetails.locator('pre').textContent()) ?? '')).toEqual(await harness.readJson(finished.runId, consoleEvidence.artifact_path))

    // Every artifact was read once: layout changes repeated no read.
    const reads = requests.evidenceReads()
    expect(reads.length).toBeGreaterThan(0)
    expect(new Set(reads).size).toBe(reads.length)
    expect(reads.filter((read) => read.endsWith(`/${consoleEvidence.evidence_id}`))).toHaveLength(1)
    review.record('evidenceReads', reads)

    // Layout changes after the result navigate nothing and read nothing again.
    const navigationsAfterRun = tracker.navigations()
    expect(navigationsAfterRun).toBeGreaterThanOrEqual(2)
    await workspace.separator.focus()
    await page.keyboard.press('ArrowLeft')
    await workspace.collapse.click()
    await workspace.restore.click()
    await page.setViewportSize({ width: 900, height: 720 })
    expectStacked(await layoutOf(page))
    await page.setViewportSize({ width: 1280, height: 720 })
    expectSideBySide(await layoutOf(page), 24)
    await review.shot(page, 'final-1280x720.png')
    await expectAccessible(page, review, 'final-1280x720')
    await tracker.expectSameFrame()
    expect(tracker.navigations()).toBe(navigationsAfterRun)
    expect(tracker.frameChanges()).toBe(0)
    expect(requests.evidenceReads()).toEqual(reads)
    expect(requests.starts()).toBe(1)
    await expect(page.locator('tr.agent-gate')).toHaveCount(GATE_IDS.length)
    expect(pageErrors).toEqual([])
    review.record('targetNavigations', tracker.navigations())
  } catch (error) {
    failure = error
    throw error
  } finally {
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
})

// ---------------------------------------------------------------------------------------
// Captured candidate: resizing and collapse during guarded measurement vs a matched control
// ---------------------------------------------------------------------------------------

/** One recorded workspace or target-pane state, from the Studio document only. */
interface PaneSample {
  /** A layout attribute changed, the hold changed, the target label changed, or the driver requested a change. */
  readonly cause: 'start' | 'layout' | 'hold' | 'label' | 'request'
  readonly label: string
  /** Applied width choice and collapse, as rendered. */
  readonly step: string | null
  readonly collapsed: string | null
  /** The requested width, as the separator reports it. */
  readonly requested: string | null
  readonly held: string | null
  /** The last observed phase start and the live-activity state, as the work panel shows them. */
  readonly phase: string | null
  readonly stream: string | null
  readonly frameAttached: boolean
  readonly cover: boolean
  readonly coverHit: boolean
  readonly frameTabIndex: string | null
  readonly focusInFrame: boolean
}

/**
 * Records every applied workspace layout change, every change of the measurement hold and of the
 * target label in the page. With `drive`, at the moment a measured phase goes live it also requests
 * width changes and a collapse and restore of the panel while that phase stays live. It reads only
 * Studio DOM state, never the target frame.
 */
async function recordWorkspace(page: Page, drive: boolean): Promise<void> {
  await page.evaluate((driving) => {
    const scope = window as unknown as Record<string, unknown>
    const samples: unknown[] = []
    scope.__flowproofWorkspace = { samples }
    const workspace = document.querySelector('main.workspace') as HTMLElement
    const pane = document.querySelector('.target-pane') as HTMLElement
    const frame = pane.querySelector('iframe') as HTMLIFrameElement
    const label = (): string => pane.querySelector('[data-target-presentation]')?.getAttribute('data-target-presentation') ?? 'none'
    const sample = (cause: string): void => {
      const cover = pane.querySelector('.target-pane__cover')
      const box = frame.getBoundingClientRect()
      const hit = frame.isConnected ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null
      samples.push({
        cause,
        label: label(),
        step: workspace.getAttribute('data-panel-step'),
        collapsed: workspace.getAttribute('data-collapsed'),
        requested: document.querySelector('.workspace__separator')?.getAttribute('aria-valuenow') ?? null,
        held: workspace.getAttribute('data-layout-held'),
        phase: [...document.querySelectorAll('[data-phase]')].map((node) => node.getAttribute('data-phase')).filter((value) => value !== 'none').at(-1) ?? null,
        stream: document.querySelector('[data-stream]')?.getAttribute('data-stream') ?? null,
        frameAttached: frame.isConnected,
        cover: cover !== null,
        coverHit: cover !== null && hit === cover,
        frameTabIndex: frame.getAttribute('tabindex'),
        focusInFrame: document.activeElement === frame,
      })
    }
    const button = (name: string): HTMLButtonElement | null =>
      [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name) ?? null
    const burst = (live: string): void => {
      let tick = 0
      const step = (): void => {
        if (label() !== live || !frame.isConnected || tick >= 16) return
        tick += 1
        const collapse = button('Collapse work panel')
        if (workspace.getAttribute('data-collapsed') === 'true') button('Show work panel')?.click()
        else if (tick % 3 === 0 && collapse !== null && collapse.getClientRects().length > 0) collapse.click()
        else document.querySelector('.workspace__separator')?.dispatchEvent(new KeyboardEvent('keydown', { key: tick % 2 === 0 ? 'ArrowLeft' : 'ArrowRight', bubbles: true }))
        sample('request')
        setTimeout(step, 25)
      }
      step()
    }
    new MutationObserver((records) => {
      for (const record of records) sample(record.attributeName === 'data-layout-held' ? 'hold' : 'layout')
    }).observe(workspace, { attributes: true, attributeFilter: ['data-panel-step', 'data-collapsed', 'data-layout-held'] })
    let lastLabel = label()
    new MutationObserver(() => {
      const current = label()
      if (current === lastLabel) return
      lastLabel = current
      sample('label')
      if (driving && (current === 'baseline-live' || current === 'candidate-live')) burst(current)
    }).observe(pane, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-target-presentation'] })
    sample('start')
  }, drive)
}

const recordedSamples = (page: Page): Promise<PaneSample[]> =>
  page.evaluate(() => [...((window as unknown as Record<string, { samples: PaneSample[] }>).__flowproofWorkspace?.samples ?? [])])

/** The measurement hold opened and closed at least `windows` times, and no layout change was applied while it was held. */
function expectHeldDuringMeasurement(samples: readonly PaneSample[], windows: number): void {
  const opened = samples.filter((sample) => sample.cause === 'hold' && sample.held === 'true')
  expect(opened.length, 'measurement holds observed').toBeGreaterThanOrEqual(windows)
  expect(samples.filter((sample) => sample.cause === 'layout' && sample.held === 'true')).toEqual([])
}

interface CapturedRunRecord {
  readonly result: CapturedVerificationResult
  readonly runId: string
  /** For each phase, the screenshot Evidence ID its persisted manifest lists. */
  readonly manifestScreenshots: Readonly<Record<'failure' | 'replay', string | null>>
  /** For each side, the Evidence ID and state the completed evidence pane shows. */
  readonly shown: Readonly<Record<'before' | 'after', { readonly state: string | null; readonly evidenceId: string | null }>>
  readonly screenshotSizes: Readonly<Record<'failure' | 'replay', { readonly width: number; readonly height: number } | null>>
  /** SHA-256 of each persisted phase screenshot. */
  readonly screenshotHashes: Readonly<Record<'failure' | 'replay', string | null>>
  readonly evidenceTypes: Readonly<Record<'failure' | 'replay', readonly string[]>>
  readonly navigationUrls: readonly string[]
}

async function manifestOf(harness: CapturedStudioHarness, runId: string, phase: 'failure' | 'replay'): Promise<EvidenceBundle> {
  const parsed = parseEvidenceBundle(await harness.readJson(runId, `evidence/${phase}/manifest.json`))
  if (!parsed.ok) throw new Error(`The ${phase} manifest violates the evidence-bundle contract.`)
  expect(parsed.value).toMatchObject({ run_id: runId, scenario_id: CAPTURED_SCENARIO_ID, phase })
  return parsed.value
}

/**
 * The run's outcome, its persisted screenshot evidence and what the completed evidence pane shows:
 * each shown screenshot is the one its own run's manifest lists for that phase, read through the
 * closed evidence route as exactly the persisted bytes, at the committed Canvas size.
 */
async function recordCapturedRun(harness: CapturedStudioHarness, runId: string, result: CapturedVerificationResult, navigationUrls: readonly string[]): Promise<CapturedRunRecord> {
  const { page } = harness
  const phases = { failure: result.before_evidence, replay: result.after_evidence } as const
  const manifestScreenshots: Record<'failure' | 'replay', string | null> = { failure: null, replay: null }
  const screenshotSizes: Record<'failure' | 'replay', { width: number; height: number } | null> = { failure: null, replay: null }
  const screenshotHashes: Record<'failure' | 'replay', string | null> = { failure: null, replay: null }
  const evidenceTypes: Record<'failure' | 'replay', string[]> = { failure: [], replay: [] }
  for (const phase of ['failure', 'replay'] as const) {
    const reference = phases[phase]
    if (reference === null) continue
    const bundle = await manifestOf(harness, runId, phase)
    evidenceTypes[phase] = bundle.items.map((item) => item.type)
    const screenshot = bundle.items.find((item) => item.type === 'screenshot')
    manifestScreenshots[phase] = screenshot?.evidence_id ?? null
    const bytes = await readFile(path.join(harness.runRoot(runId), reference.screenshot_path))
    screenshotSizes[phase] = pngSize(bytes)
    screenshotHashes[phase] = sha256(bytes)
    if (screenshot !== undefined) {
      const served = await page.evaluate(
        async ({ id, evidence }) => {
          const response = await fetch(`/api/runs/${id}/evidence/${evidence}`)
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))
          return { status: response.status, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
        },
        { id: runId, evidence: screenshot.evidence_id },
      )
      expect(served).toEqual({ status: 200, sha256: sha256(bytes) })
    }
  }
  const shown: Record<'before' | 'after', { state: string | null; evidenceId: string | null }> = { before: { state: null, evidenceId: null }, after: { state: null, evidenceId: null } }
  const pane = page.locator('[data-captured-evidence]')
  await expect(pane).toHaveAttribute('data-run-id', runId)
  for (const side of ['before', 'after'] as const) {
    const figure = pane.locator(`[data-evidence-side="${side}"]`)
    const image = figure.locator('img')
    shown[side] = {
      state: await figure.getAttribute('data-evidence-state', { timeout: ELEMENT_TIMEOUT_MS }),
      evidenceId: (await image.count()) === 1 ? await image.getAttribute('data-evidence-id', { timeout: ELEMENT_TIMEOUT_MS }) : null,
    }
  }
  return { result, runId, manifestScreenshots, shown, screenshotSizes, screenshotHashes, evidenceTypes, navigationUrls }
}

/**
 * Within one run: each shown side is exactly its own phase's manifest screenshot, at the Canvas size.
 * A page that received none of the run's evidence events shows each side as not received instead.
 */
function expectBoundEvidence(record: CapturedRunRecord, received = true): void {
  const side = (evidenceId: string | null): unknown => (received ? { state: 'shown', evidenceId } : { state: 'not-received', evidenceId: null })
  expect(record.shown.before).toEqual(side(record.manifestScreenshots.failure))
  expect(record.shown.after).toEqual(side(record.manifestScreenshots.replay))
  expect(record.manifestScreenshots.failure).toMatch(/^ev_failure_screenshot_[0-9]{3}$/)
  expect(record.manifestScreenshots.replay).toMatch(/^ev_replay_screenshot_[0-9]{3}$/)
  expect(record.screenshotSizes).toEqual({ failure: CANVAS, replay: CANVAS })
}

const outcomeOf = (result: CapturedVerificationResult): unknown => ({
  status: result.status,
  reason_code: result.reason_code,
  checks: result.checks.map((check) => [check.check_id, check.status, check.reason_code]),
  cleanup: result.cleanup,
  before_evidence: result.before_evidence,
  after_evidence: result.after_evidence,
})

interface CapturedCase {
  readonly name: string
  readonly resize: boolean
  /** Abort the run's live activity stream and request layout changes while the engine runs unseen. */
  readonly loseActivity?: boolean
}

const isEventStream = (url: URL): boolean => /^\/api\/runs\/[^/]+\/events$/.test(url.pathname)

async function runCapturedCase({ name, resize, loseActivity = false }: CapturedCase): Promise<CapturedRunRecord> {
  const review = await reviewCase(name)
  let harness: CapturedStudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let record: CapturedRunRecord | undefined
  let failure: unknown
  try {
    harness = await openCapturedVerificationHarness({
      capture: async ({ repoRoot, tmpRoot }) => {
        const canvas = await produceCanvasCandidate({ caseName: 'canvas-fix', repositoryRoot: repoRoot, tmpRoot })
        expect(canvas.result.capture.status).toBe('captured')
        return canvas.result
      },
    })
    const { page } = harness
    const workspace = workspaceOf(page)
    const requests = logRequests(page)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    // The fixed candidate and its one verification action; no request field or chat.
    const action = page.getByRole('button', { name: 'Start candidate verification' })
    await expect(action).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'Candidate verification', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.locator('form')).toHaveCount(0)
    await expect(workspace.separator).toHaveAttribute('aria-valuenow', '24')
    expectSideBySide(await layoutOf(page), 24)
    const tracker = await trackFrame(page)
    await review.shot(page, 'ready.png')
    if (resize) await expectAccessible(page, review, 'captured-ready-1280x800')

    // The control keeps the default layout throughout; the other runs hold their result reads.
    const results = resize || loseActivity ? await holdRequests(page, isResultRead) : null
    // A controlled disconnection: the page's live activity fails, the engine and result poll do not.
    let abortedStreams = 0
    if (loseActivity) {
      await page.route(
        (url) => isEventStream(url),
        async (route: Route) => {
          abortedStreams += 1
          await route.abort('connectionreset')
        },
      )
    }
    if (resize) {
      // Trusted layout changes before the start, then the in-page driver during each measured phase.
      await workspace.separator.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowLeft')
    }
    await recordWorkspace(page, resize)
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST')
    await action.click()
    expect((await accepted).status()).toBe(202)
    await expect(action).toBeDisabled()

    // Trusted collapse and restore while the run is guarded, until the target is released.
    let trusted = 0
    if (resize) {
      for (let attempt = 0; attempt < 400 && !tracker.detached(); attempt += 1) {
        const collapsed = (await workspace.root.getAttribute('data-collapsed', { timeout: ELEMENT_TIMEOUT_MS })) === 'true'
        const control = collapsed ? workspace.restore : workspace.collapse
        if (await control.isVisible()) {
          await control.click({ timeout: 2_000 }).then(
            () => (trusted += 1),
            () => undefined,
          )
        }
        await sleep(150)
      }
    }
    if (loseActivity) {
      // The activity is lost before any measurement is seen, so the layout holds from here on.
      await expect(page.locator('[data-stream]')).toHaveAttribute('data-stream', 'disconnected')
      await expect(workspace.root).toHaveAttribute('data-layout-held', 'true')
      // Trusted width and collapse requests while the engine prepares and measures, unseen.
      const deadline = Date.now() + RUN_BUDGET_MS
      for (let attempt = 0; !tracker.detached() && Date.now() < deadline; attempt += 1) {
        if (attempt % 4 === 3) {
          if (await workspace.collapse.isVisible()) await workspace.collapse.click({ timeout: 2_000 }).then(() => (trusted += 1), () => undefined)
        } else {
          await workspace.separator.focus({ timeout: 2_000 })
          await page.keyboard.press(attempt % 2 === 0 ? 'ArrowRight' : 'ArrowLeft')
          trusted += 1
        }
        await sleep(150)
      }
    }
    const { runId, result } = await harness.waitForCapturedResult(RUN_BUDGET_MS)
    expect(tracker.detached()).toBe(true)
    expect(requests.starts()).toBe(1)

    if (results !== null && loseActivity) {
      // The engine finished both measurements and released the frame; the page still has no result.
      expect(tracker.navigationUrls()).toEqual([TARGET_DOCUMENT, TARGET_DOCUMENT])
      await workspace.separator.focus()
      await page.keyboard.press('End')
      await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
      await expect(workspace.separator).toHaveAttribute('aria-valuenow', '32')
      // Requested, not applied: the layout the run started with, held, without a verdict or live label.
      await expect(workspace.root).toHaveAttribute('data-layout-held', 'true')
      await expect(workspace.root).toHaveAttribute('data-panel-step', String(DEFAULT_STEP))
      await expect(workspace.root).toHaveAttribute('data-collapsed', 'false')
      await expect(workspace.panel).toBeVisible()
      await expect(workspace.status.locator('.workspace__status-label')).toHaveText('Verification in progress')
      await expect(workspace.status.locator('.workspace__status-notice')).toHaveText('Live activity disconnected')
      await expect(workspace.viewResult).toHaveCount(0)
      await expect(page.locator('.captured-status__final')).toHaveAttribute('data-captured-status', 'pending')
      await review.shot(page, 'result-pending-activity-lost.png')
      results.release()
      // The bound result decides the run, and only then is the pending layout applied.
      await expect(workspace.status.locator('.workspace__status-label')).toHaveText('Candidate verification passed')
      await expect(workspace.root).not.toHaveAttribute('data-layout-held', 'true')
      await expect(workspace.root).toHaveAttribute('data-panel-step', String(PANEL_WIDTHS.indexOf(32)))
      await expect(workspace.root).toHaveAttribute('data-collapsed', 'true')
      await expect(workspace.panel).toBeHidden()
      await review.shot(page, 'final-collapsed.png')
      await workspace.viewResult.focus()
      await page.keyboard.press('Enter')
      await expect(workspace.panel).toBeVisible()
      await expect(page.locator('.captured-status__final')).toBeFocused()
    } else if (results !== null) {
      // Before the page reads the bound result, the collapsed status still shows no verdict.
      if ((await workspace.root.getAttribute('data-collapsed', { timeout: ELEMENT_TIMEOUT_MS })) !== 'true') await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
      await expect(workspace.panel).toBeHidden()
      // Scan and cleanup activity was observed, but no result reached the page: no verdict yet.
      await expect(workspace.status).toHaveText('Finalizing · verdict pending')
      await expect(workspace.viewResult).toHaveCount(0)
      await review.shot(page, 'result-pending-collapsed.png')
      results.release()
      await expect(workspace.status).toHaveText('Candidate verification passed')
      await expect(workspace.status).toHaveAttribute('data-workspace-status', 'success')
      await review.shot(page, 'final-collapsed.png')
      await workspace.viewResult.focus()
      await page.keyboard.press('Enter')
      await expect(workspace.panel).toBeVisible()
      await expect.poll(() => focusedIsResult(page)).toBe(true)
      await expect(page.locator('.captured-status__final')).toBeFocused()
    }
    await expect(page.locator('.captured-status__final')).toHaveText('Candidate verification passed')
    await expect(workspace.panel).toBeVisible()
    await expect(page.locator('tr.captured-check')).toHaveCount(CAPTURED_CHECK_IDS.length)
    expect(await page.locator('body').innerText()).not.toMatch(/Verified Fix/)
    await review.shot(page, 'final.png')

    record = await recordCapturedRun(harness, runId, result, tracker.navigationUrls())
    review.record('outcome', outcomeOf(result))
    review.record('evidence', { manifestScreenshots: record.manifestScreenshots, shown: record.shown, screenshotSizes: record.screenshotSizes, screenshotHashes: record.screenshotHashes })
    review.record('trustedLayoutClicks', trusted)
    expect(pageErrors).toEqual([])
    expect(tracker.frameChanges()).toBe(1)

    const samples = await recordedSamples(page)
    review.record('paneSamples', samples)
    if (!resize && !loseActivity) expectHeldDuringMeasurement(samples, 2)
    if (loseActivity) {
      review.record('abortedStreams', abortedStreams)
      expect(abortedStreams).toBeGreaterThan(0)
      expect(trusted).toBeGreaterThan(0)
      // Nothing presented the frame as live once its activity was lost.
      expect(samples.filter((sample) => sample.label === 'baseline-live' || sample.label === 'candidate-live')).toEqual([])
      const guarded = samples.filter((sample) => sample.frameAttached && sample.label !== 'preview' && sample.label !== 'none')
      expect(guarded.length).toBeGreaterThan(0)
      for (const sample of guarded) expect(sample).toMatchObject({ cover: true, coverHit: true, frameTabIndex: '-1', focusInFrame: false })
      // One hold, opened by the lost activity before any request and closed by the bound result.
      const holds = samples.filter((sample) => sample.cause === 'hold')
      expect(holds.map((sample) => sample.held)).toEqual(['true', null])
      expect(holds[0]).toMatchObject({ stream: 'disconnected', step: String(DEFAULT_STEP), collapsed: 'false' })
      expectHeldDuringMeasurement(samples, 1)
      // No intermediate width or collapse was applied: only the final pending request, after the hold.
      const applied = samples.filter((sample) => sample.cause === 'layout')
      expect(applied.length).toBeGreaterThan(0)
      for (const sample of applied) expect(sample).toMatchObject({ held: null, step: String(PANEL_WIDTHS.indexOf(32)) })
    }
    if (resize) {
      // The guard held through every recorded state while the frame existed.
      const guarded = samples.filter((sample) => sample.frameAttached && sample.label !== 'preview' && sample.label !== 'none')
      expect(guarded.length).toBeGreaterThan(0)
      for (const sample of guarded) expect(sample).toMatchObject({ cover: true, coverHit: true, frameTabIndex: '-1', focusInFrame: false })
      // Width and collapse were requested while each measured phase was live, but none was applied
      // until it ended: the measured frame never moved under the engine's screenshot clip.
      for (const live of ['baseline-live', 'candidate-live']) {
        expect(samples.filter((sample) => sample.cause === 'request' && sample.label === live).length, live).toBeGreaterThanOrEqual(2)
        expect(samples.filter((sample) => sample.cause === 'layout' && sample.label === live), live).toEqual([])
      }
      expectHeldDuringMeasurement(samples, 2)
      // The kept requests were applied once the measurement ended.
      expect(samples.filter((sample) => sample.cause === 'layout' && sample.label === 'not-live').length).toBeGreaterThan(0)
      await expect(workspace.root).toHaveAttribute('data-panel-step', String(PANEL_WIDTHS.indexOf((await separatorWidth(workspace)) as (typeof PANEL_WIDTHS)[number])))
      expect(trusted).toBeGreaterThan(0)
      await expectAccessible(page, review, 'captured-final-1280x800')
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
  expect(harness?.blockedRequests).toEqual([])
  if (record === undefined) throw new Error('The captured run was not recorded.')
  return record
}

test('captured verification keeps its guarded frame, outcome and evidence bindings through resizing and collapse during measurement, like an unresized control', async () => {
  test.setTimeout(RUN_BUDGET_MS * 4)
  const control = await runCapturedCase({ name: 'captured-control', resize: false })
  const resized = await runCapturedCase({ name: 'captured-resized-during-measurement', resize: true })
  const lost = await runCapturedCase({ name: 'captured-activity-lost-during-run', resize: false, loseActivity: true })
  for (const record of [control, resized, lost]) {
    expect(record.result).toMatchObject({ status: 'passed', reason_code: null })
    expectBoundEvidence(record, record !== lost)
    // Exactly the baseline and the candidate reconnect of the same frame; no layout reload.
    expect(record.navigationUrls).toEqual([TARGET_DOCUMENT, TARGET_DOCUMENT])
  }
  expect(outcomeOf(resized.result)).toEqual(outcomeOf(control.result))
  expect(resized.evidenceTypes).toEqual(control.evidenceTypes)
  expect(resized.screenshotSizes).toEqual(control.screenshotSizes)
  // The same baseline and candidate were captured at the same Canvas position: identical images.
  expect(resized.screenshotHashes).toEqual(control.screenshotHashes)
  expect(resized.runId).not.toBe(control.runId)
  // Activity lost while the engine ran: the same outcome, evidence and Canvas position as the control.
  expect(outcomeOf(lost.result)).toEqual(outcomeOf(control.result))
  expect(lost.evidenceTypes).toEqual(control.evidenceTypes)
  expect(lost.screenshotSizes).toEqual(control.screenshotSizes)
  expect(lost.screenshotHashes).toEqual(control.screenshotHashes)
  expect(new Set([control.runId, resized.runId, lost.runId]).size).toBe(3)
})

// ---------------------------------------------------------------------------------------
// Opt-in native 200% browser zoom review (quickstart.md, slice 2)
// ---------------------------------------------------------------------------------------

const ACK_TIMEOUT_MS = 120_000

/** Waits for a fresh acknowledgement marker; a missing one leaves the review pending, never passed. */
async function waitForAck(marker: string, promptedAt: number, what: string): Promise<void> {
  const deadline = Date.now() + ACK_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(marker) && (await stat(marker)).mtimeMs >= promptedAt) return
    await sleep(250)
  }
  throw new Error(`NATIVE_ZOOM_ACK_MISSING: no ${what} acknowledgement within ${ACK_TIMEOUT_MS / 1000}s; the native zoom review is pending, not passed.`)
}

interface WindowMetrics {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly outerWidth: number
  readonly outerHeight: number
  readonly devicePixelRatio: number
}

const windowMetrics = (page: Page): Promise<WindowMetrics> =>
  page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, devicePixelRatio: window.devicePixelRatio }))

test('native-zoom-review: the real Studio reflows at actual native 200% browser zoom on the same page', async () => {
  test.skip(process.env.FLOWPROOF_ZOOM_REVIEW !== '1', 'Opt-in operator review: set FLOWPROOF_ZOOM_REVIEW=1 and follow quickstart.md.')
  test.setTimeout(900_000)
  const review = await reviewCase('native-zoom-review')
  const zoomedMarker = path.join(review.dir, 'zoomed.ack')
  const resetMarker = path.join(review.dir, 'reset.ack')
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    const workspace = workspaceOf(page)
    const original = page.viewportSize()
    review.record('browserVersion', page.context().browser()?.version() ?? null)
    await expect(page.getByLabel(/request/i)).toHaveValue(scenario.scenario.default_request)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.bringToFront()
    const tracker = await trackFrame(page)
    const before = await windowMetrics(page)
    review.record('metrics:before', before)
    expect(before).toMatchObject({ innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 })
    await review.shot(page, 'native-100-before.png')

    // Before admission, at actual native 200% zoom of this same page and window.
    await rm(zoomedMarker, { force: true })
    await rm(resetMarker, { force: true })
    const zoomPrompt = Date.now()
    const zoomInstruction = `In the visible Studio browser window, press Ctrl+0 and then Ctrl+= until the zoom indicator reads 200%. Do not resize the window. Then run:\n  touch '${zoomedMarker}'`
    await writeFile(path.join(review.dir, 'INSTRUCTIONS.txt'), `${zoomInstruction}\n`)
    console.log(`\n[native-zoom-review] ${zoomInstruction}\n`)
    await waitForAck(zoomedMarker, zoomPrompt, 'zoom')

    const zoomed = await windowMetrics(page)
    review.record('metrics:zoomed', zoomed)
    expect(zoomed.devicePixelRatio).toBe(2)
    expect(Math.abs(zoomed.innerWidth - 640)).toBeLessThanOrEqual(1)
    expect(Math.abs(zoomed.innerHeight - 360)).toBeLessThanOrEqual(1)
    expect({ outerWidth: zoomed.outerWidth, outerHeight: zoomed.outerHeight }).toEqual({ outerWidth: before.outerWidth, outerHeight: before.outerHeight })
    const layout = await layoutOf(page)
    review.record('layout:zoomed', layout)
    expectStacked(layout)
    await expect(workspace.separator).toBeHidden()
    const start = page.getByRole('button', { name: /^(start|send|run)\b/i })
    await start.scrollIntoViewIfNeeded()
    await expect(start).toBeVisible()
    await expect(start).toBeEnabled()
    await review.shot(page, 'native-200-ready.png')
    const tabs = await tabOrder(page, 12)
    review.record('tabOrder:zoomed', tabs)
    expect(tabs.some((entry) => entry.startsWith('separator'))).toBe(false)
    await expectAccessible(page, review, 'native-200-ready')
    await workspace.collapse.scrollIntoViewIfNeeded()
    await workspace.collapse.focus()
    await page.keyboard.press('Enter')
    await expect(workspace.restore).toBeFocused()
    await expect(workspace.status).toHaveText('Ready')
    expect((await layoutOf(page)).scrollWidth).toBeLessThanOrEqual((await layoutOf(page)).clientWidth)
    await review.shot(page, 'native-200-collapsed.png')
    await page.keyboard.press('Enter')
    await expect(workspace.collapse).toBeFocused()
    await tracker.expectSameFrame()
    expect(tracker.navigations()).toBe(0)

    // The operator restores native 100% zoom; the page returns to its 1280 x 720 metrics.
    const resetPrompt = Date.now()
    const resetInstruction = `Reset the Studio browser zoom with Ctrl+0, then run:\n  touch '${resetMarker}'`
    await writeFile(path.join(review.dir, 'INSTRUCTIONS.txt'), `${resetInstruction}\n`)
    console.log(`\n[native-zoom-review] ${resetInstruction}\n`)
    await waitForAck(resetMarker, resetPrompt, 'reset')
    const reset = await windowMetrics(page)
    review.record('metrics:reset', reset)
    expect(reset).toEqual(before)
    expectSideBySide(await layoutOf(page), 24)
    await review.shot(page, 'native-100-after.png')
    if (original !== null) await page.setViewportSize(original)
  } catch (error) {
    failure = error
    throw error
  } finally {
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
})

// ---------------------------------------------------------------------------------------
// Slice 3: observed work in the work panel (T017, T021-T023)
// ---------------------------------------------------------------------------------------
//
// The work panel shows a short summary of the current observed work and one initially closed
// Details disclosure of flat chronological rows, each a contiguous group of accepted events with a
// nested Events disclosure of the raw records. These cases drive the real Studio through the
// existing harnesses. Test-local barriers stand only between the real server and the page: result
// reads are held by a route, and an in-page wrapper around the browser's event source holds already
// produced live events in order and delivers them later (`installEventBarrier`). Nothing changes
// the engine, its timing or budgets, the server or any product option, and every barrier is
// released in `finally`. The captured case asserts the Finalizing presentation from the actual
// producer scan and cleanup events before the bound result reaches the page. A test-controlled
// transport, labelled synthetic, supplies more than forty contract-valid events, which no real run
// produces. Unaltered screenshots of the six SC-002 states in both modes, with their run, event and
// result references and the expected answers, form the review manifest under
// `.flowproof/review/005-studio-workspace-ux/<tested-sha>/slice3/six-state/<stamp>/`; owner answers
// are recorded separately and are never produced here.

const FAILURE = 'canvas-filter-failure-invalid-citation'
const FINALIZING_LABEL = 'Finalizing · verdict pending'
/** Every family verdict label; none may appear before a bound final result. */
const VERDICT_TEXT = /Verified Fix|Unverified|Candidate verification (passed|failed|error|interrupted)/

interface WorkLog {
  readonly section: Locator
  readonly summary: Locator
  readonly heading: Locator
  readonly detail: Locator
  readonly warning: Locator
  /** The one Details disclosure toggle. */
  readonly details: Locator
  readonly rows: Locator
  /** The raw accepted event records inside the rows. */
  readonly items: Locator
  readonly jump: Locator
}

const workLogOf = (page: Page): WorkLog => {
  const section = page.locator('section.work-timeline')
  return {
    section,
    summary: section.locator('.work-summary'),
    heading: section.locator('.work-summary__heading'),
    detail: section.locator('.work-summary__detail'),
    warning: section.locator('.work-summary__warning'),
    details: section.locator('button[data-disclosure="details"]'),
    rows: section.locator('li.work-row'),
    items: section.locator('li.agent-activity__item'),
    jump: section.locator('button.work-timeline__latest'),
  }
}

const eventsToggleOf = (row: Locator): Locator => row.locator('button[data-disclosure="events"]')

/** Where a control sits in the scrolled work panel body, and whether it holds focus. */
async function readingPosition(target: Locator): Promise<{ readonly scrollTop: number; readonly top: number; readonly focused: boolean }> {
  return target.evaluate((node) => {
    const body = node.closest('.work-panel__body') as HTMLElement
    return { scrollTop: body.scrollTop, top: node.getBoundingClientRect().top - body.getBoundingClientRect().top, focused: document.activeElement === node }
  })
}

/** Scrolls the work panel body so `target` sits near its top, as a reader of earlier work would. */
async function scrollToTop(target: Locator): Promise<void> {
  await target.evaluate((node) => {
    const body = node.closest('.work-panel__body') as HTMLElement
    body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 8
  })
}

/** Whether `target` is inside the visible part of the work panel body. */
const visibleInPanel = (target: Locator): Promise<boolean> =>
  target.evaluate((node) => {
    const body = (node.closest('.work-panel__body') as HTMLElement).getBoundingClientRect()
    const box = node.getBoundingClientRect()
    return box.bottom > body.top && box.top < body.bottom
  })

/** Page-level overflow beyond the viewport, in CSS pixels; the side-by-side workspace scrolls only inside its panes. */
const pageOverflow = (page: Page): Promise<{ readonly x: number; readonly y: number }> =>
  page.evaluate(() => {
    const root = document.documentElement
    return { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight }
  })

function watchPage(page: Page): { readonly errors: string[]; readonly csp: string[] } {
  const errors: string[] = []
  const csp: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) csp.push(message.text())
  })
  return { errors, csp }
}

// ---------------------------------------------------------------------------------------
// Test-local delivery barrier for actual producer events
// ---------------------------------------------------------------------------------------

/** One live event as the real server sent it, read from its SSE payload. */
interface ObservedEvent {
  readonly sequence: number
  readonly eventId: string
  readonly runId: string
  readonly type: string
  readonly phase: string | null
  readonly message: string
  readonly gate: string | null
}

/**
 * Where delivery stops: after the `nth` (default first) delivered event of `type`, with `phase` or
 * `gate` when given, counted from the release and, with `after`, only once an event of that type
 * and phase was delivered. Rules name structure only, never producer copy.
 */
interface HoldRule {
  readonly type: string
  readonly phase?: string
  readonly gate?: string
  readonly after?: { readonly type: string; readonly phase?: string }
  readonly nth?: number
}

interface EventBarrier {
  /** Waits until delivery stopped at the current rule and returns the event it stopped after. */
  held(timeoutMs?: number): Promise<ObservedEvent>
  /** Delivers held events in order; holds again after `rule`, or never again with null. */
  release(rule: HoldRule | null): Promise<void>
  delivered(): Promise<ObservedEvent[]>
}

interface BarrierState {
  readonly holding: boolean
  readonly heldAt: ObservedEvent | null
  readonly queued: number
  readonly delivered: ObservedEvent[]
}

type BarrierScope = { __flowproofEventBarrier: { state(): BarrierState; release(rule: HoldRule | null): void } }

/**
 * Wraps the page's event source before the start: the real server stream is opened unchanged and
 * its events are passed to the Studio client in arrival order, except that from the event the rule
 * names on, delivery waits for `release`. A connection end that arrives while events are held stops
 * the reconnect and is passed on after them. The engine and the server never wait for the page.
 */
async function installEventBarrier(page: Page, rule: HoldRule): Promise<EventBarrier> {
  await page.evaluate((initial) => {
    const scope = window as unknown as Record<string, unknown>
    if (scope.__flowproofEventBarrier !== undefined) throw new Error('The event barrier is already installed.')
    const RealEventSource = window.EventSource
    type Rule = { type: string; phase?: string; gate?: string; after?: { type: string; phase?: string }; nth?: number }
    type Observed = { sequence: number; eventId: string; runId: string; type: string; phase: string | null; message: string; gate: string | null }
    type Listener = (event: Event) => void
    type Item = { source: { closed: boolean; listeners: Map<string, Listener[]> }; type: string; event: Event; observed: Observed | null }
    const control = { rule: initial as Rule | null, afterSeen: false, count: 0, holding: false, heldAt: null as Observed | null, queue: [] as Item[], delivered: [] as Observed[] }
    const observe = (event: Event): Observed | null => {
      try {
        const data = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>
        const gate = data.gate as Record<string, unknown> | null | undefined
        return {
          sequence: Number(data.sequence),
          eventId: String(data.event_id),
          runId: String(data.run_id),
          type: String(data.type),
          phase: typeof data.phase === 'string' ? data.phase : null,
          message: String(data.message),
          gate: gate === null || gate === undefined ? null : String(gate.gate_id),
        }
      } catch {
        return null
      }
    }
    const stopsAt = (observed: Observed): boolean => {
      const current = control.rule
      if (current === null) return false
      if (current.after !== undefined && !control.afterSeen) {
        if (observed.type === current.after.type && (current.after.phase === undefined || observed.phase === current.after.phase)) control.afterSeen = true
        return false
      }
      if (observed.type !== current.type) return false
      if (current.phase !== undefined && observed.phase !== current.phase) return false
      if (current.gate !== undefined && observed.gate !== current.gate) return false
      control.count += 1
      return control.count >= (current.nth ?? 1)
    }
    const deliver = (item: Item): void => {
      if (item.source.closed) return
      for (const listener of item.source.listeners.get(item.type) ?? []) listener(item.event)
      if (item.observed === null) return
      control.delivered.push(item.observed)
      if (stopsAt(item.observed)) {
        control.holding = true
        control.heldAt = item.observed
        control.rule = null
      }
    }
    const pump = (): void => {
      while (!control.holding && control.queue.length > 0) deliver(control.queue.shift() as Item)
    }
    // A plain constructor function: `new` returns the wrapper object, and no class helper is needed.
    function HeldEventSource(url: string | URL): object {
      const real = new RealEventSource(url)
      const source = { closed: false, listeners: new Map<string, Listener[]>() }
      const arrive = (type: string, event: Event): void => {
        if (source.closed) return
        const busy = control.holding || control.queue.length > 0
        if (type === 'open' || (type === 'error' && !busy)) {
          deliver({ source, type, event, observed: null })
          return
        }
        if (type === 'error') {
          // Held events are still to come: no reconnect, and the end follows them.
          real.close()
          control.queue.push({ source, type, event, observed: null })
          return
        }
        const item: Item = { source, type, event, observed: observe(event) }
        if (busy) control.queue.push(item)
        else deliver(item)
      }
      return Object.assign(source, {
        addEventListener(type: string, listener: Listener): void {
          let list = source.listeners.get(type)
          if (list === undefined) {
            list = []
            source.listeners.set(type, list)
            real.addEventListener(type, (event) => arrive(type, event))
          }
          list.push(listener)
        },
        close(): void {
          source.closed = true
          real.close()
        },
      })
    }
    window.EventSource = HeldEventSource as unknown as typeof EventSource
    scope.__flowproofEventBarrier = {
      state: () => ({ holding: control.holding, heldAt: control.heldAt, queued: control.queue.length, delivered: [...control.delivered] }),
      release: (next: Rule | null) => {
        control.rule = next
        control.afterSeen = false
        control.count = 0
        control.holding = false
        control.heldAt = null
        pump()
      },
    }
  }, rule)
  const state = (): Promise<BarrierState> => page.evaluate(() => (window as unknown as BarrierScope).__flowproofEventBarrier.state())
  return {
    async held(timeoutMs = RUN_BUDGET_MS) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await state()
        if (current.holding && current.heldAt !== null) return current.heldAt
        await sleep(100)
      }
      throw new Error('EVENT_BARRIER_NOT_REACHED: the expected producer event was not delivered in time.')
    },
    async release(next) {
      await page.evaluate((value) => (window as unknown as BarrierScope).__flowproofEventBarrier.release(value), next)
    },
    async delivered() {
      return (await state()).delivered
    },
  }
}

/** Releases a barrier that may already be gone with its page; used in `finally`. */
async function releaseAll(barrier: EventBarrier | undefined): Promise<void> {
  await barrier?.release(null).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------
// Six-state real-UI review manifest (SC-002)
// ---------------------------------------------------------------------------------------

const SIX_STATES = ['ready', 'active', 'finalizing', 'disconnected-without-result', 'unsuccessful-final', 'successful-final'] as const
type SixState = (typeof SIX_STATES)[number]
type StudioModeName = 'legacy' | 'captured'

/** The contributor's expected answers; the owner's answers are recorded separately. */
const EXPECTED_ANSWERS: Readonly<Record<SixState, Readonly<Record<StudioModeName, { readonly happening: string; readonly nextAction: string }>>>> = {
  ready: {
    legacy: { happening: 'The prepared case is loaded and nothing is running yet.', nextAction: 'Review or edit the request, then start the run.' },
    captured: { happening: 'The fixed captured candidate is loaded and nothing is running yet.', nextAction: 'Start the candidate verification.' },
  },
  active: {
    legacy: { happening: 'A run is in progress; the panel names the observed phase and no verdict exists yet.', nextAction: 'Wait for the result; closing Studio interrupts the run.' },
    captured: { happening: 'The candidate verification is in progress; the panel names the observed stage and no verdict exists yet.', nextAction: 'Wait for the result; closing Studio interrupts the verification.' },
  },
  finalizing: {
    legacy: { happening: 'The run is finalizing (the original-worktree check was observed); the verdict is still pending.', nextAction: 'Wait for the authoritative result.' },
    captured: { happening: 'The verification is finalizing (secret scan and cleanup were observed); the verdict is still pending.', nextAction: 'Wait for the authoritative result.' },
  },
  'disconnected-without-result': {
    legacy: { happening: 'Live activity disconnected and no final result has arrived; this is not a run failure.', nextAction: 'Wait for the result; if none arrives, close Studio and launch it again.' },
    captured: { happening: 'Live activity disconnected and no final result has arrived; this is not a verification failure.', nextAction: 'Wait for the result; if none arrives, close Studio and launch it again.' },
  },
  'unsuccessful-final': {
    legacy: { happening: 'The run finished Unverified; the failed or unevaluable gates are named.', nextAction: 'Review the failed gates and evidence; start another run or close Studio.' },
    captured: { happening: 'The candidate verification did not pass; the unsuccessful checks are named.', nextAction: 'Review the checks and evidence, then close Studio.' },
  },
  'successful-final': {
    legacy: { happening: 'The run finished as Verified Fix from its bound result.', nextAction: 'Review the gates and evidence; start another run or close Studio.' },
    captured: { happening: 'The candidate verification passed from its bound strict result.', nextAction: 'Review the checks and evidence, then close Studio.' },
  },
}

interface StateCapture {
  readonly state: SixState
  readonly mode: StudioModeName
  readonly case: string
  /** Test conditions that produced the state, such as held result reads; never product options. */
  readonly conditions: readonly string[]
  readonly screenshot: string
  readonly caseManifest: string
  readonly runId: string | null
  readonly observedEvents: number
  readonly lastEvent: Readonly<Record<string, string | null>> | null
  readonly eventIds: readonly string[]
  readonly result: { readonly exposedToPage: boolean; readonly runId: string | null; readonly status: string | null }
  readonly shown: Readonly<Record<string, string | null>>
  readonly expected: { readonly happening: string; readonly nextAction: string }
}

const STATE_CAPTURES: StateCapture[] = []

interface CaptureInput {
  readonly state: SixState
  readonly mode: StudioModeName
  readonly conditions: readonly string[]
  readonly runId: string | null
  readonly result: StateCapture['result']
}

/** Saves an unaltered full-page screenshot of the real Studio with its run, event and result references. */
async function captureState(review: ReviewCase, page: Page, caseName: string, input: CaptureInput): Promise<void> {
  const file = `state-${input.state}.png`
  await review.shot(page, file)
  const events = await page.locator('section.work-timeline li.agent-activity__item').evaluateAll((nodes) =>
    nodes.map((node) => ({
      sequence: node.getAttribute('data-sequence'),
      eventId: node.getAttribute('data-event-id'),
      type: node.getAttribute('data-type'),
      phase: node.getAttribute('data-phase'),
    })),
  )
  const shown = await page.evaluate(() => ({
    summary: document.querySelector('.work-summary__heading')?.textContent ?? null,
    execution: document.querySelector('.work-summary')?.getAttribute('data-execution') ?? null,
    stream: document.querySelector('[data-stream]')?.getAttribute('data-stream') ?? null,
    finalStatus: document.querySelector('[data-workspace-result]')?.textContent ?? null,
  }))
  const capture: StateCapture = {
    state: input.state,
    mode: input.mode,
    case: caseName,
    conditions: input.conditions,
    screenshot: path.relative(REPO_ROOT, path.join(review.dir, file)),
    caseManifest: path.relative(REPO_ROOT, path.join(review.dir, 'manifest.json')),
    runId: input.runId,
    observedEvents: events.length,
    lastEvent: events.at(-1) ?? null,
    eventIds: events.map((event) => event.eventId ?? ''),
    result: input.result,
    shown,
    expected: EXPECTED_ANSWERS[input.state][input.mode],
  }
  STATE_CAPTURES.push(capture)
  review.record(`state:${input.state}`, capture)
}

test.afterAll(async () => {
  if (STATE_CAPTURES.length === 0) return
  const dir = path.join(REVIEW_BASE, 'slice3', 'six-state', RUN_STAMP)
  await mkdir(dir, { recursive: true })
  const states = SIX_STATES.map((state) => ({ state, captures: STATE_CAPTURES.filter((capture) => capture.state === state) }))
  const modes = [...new Set(STATE_CAPTURES.map((capture) => capture.mode))].sort()
  const missing = states.filter((entry) => entry.captures.length === 0).map((entry) => entry.state)
  const manifest = {
    kind: 'flowproof-sc002-six-state-real-ui',
    testedSha: TESTED_SHA,
    worktreeDirty: WORKTREE_DIRTY,
    generatedAt: new Date().toISOString(),
    source: 'tests/e2e/workspace-ux.spec.ts',
    complete: missing.length === 0 && modes.length === 2,
    missing,
    modes,
    note: 'Unaltered full-page screenshots of the real Studio from reproducible test runs. Test conditions such as held result reads, held live-event delivery or an aborted event stream are named per capture. Expected answers are the contributor\'s; owner answers and timings are recorded separately and are pending.',
    states,
  }
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const pending = { status: 'pending', note: 'Owner answers, next actions and elapsed seconds per state; not collected by any automated test.', answers: SIX_STATES.map((state) => ({ state, answer: null, nextAction: null, elapsedSeconds: null })) }
  await writeFile(path.join(dir, 'owner-responses.pending.json'), `${JSON.stringify(pending, null, 2)}\n`)
})

// ---------------------------------------------------------------------------------------
// Captured: finalization from the actual producer scan and cleanup events
// ---------------------------------------------------------------------------------------

const produceCanvasFix = async ({ repoRoot, tmpRoot }: { readonly repoRoot: string; readonly tmpRoot: string }): Promise<unknown> => {
  const canvas = await produceCanvasCandidate({ caseName: 'canvas-fix', repositoryRoot: repoRoot, tmpRoot })
  expect(canvas.result.capture.status).toBe('captured')
  return canvas.result
}

test('captured finalization: the actual producer scan and cleanup events show as Finalizing before the bound result, in the panel and the collapsed status', async () => {
  test.setTimeout(RUN_BUDGET_MS + 240_000)
  const caseName = 'captured-finalizing-producer'
  const review = await reviewCase(caseName, 'slice3')
  let harness: CapturedStudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  let barrier: EventBarrier | undefined
  let results: Barrier | undefined
  try {
    harness = await openCapturedVerificationHarness({ capture: produceCanvasFix })
    const { page } = harness
    const workspace = workspaceOf(page)
    const work = workLogOf(page)
    const requests = logRequests(page)
    const watched = watchPage(page)
    const tracker = await trackFrame(page)

    const action = page.getByRole('button', { name: 'Start candidate verification' })
    await expect(action).toBeEnabled()
    await expect.soft(work.heading).toHaveText('Ready')
    await expect(work.details).toHaveCount(0)
    await captureState(review, page, caseName, { state: 'ready', mode: 'captured', conditions: [], runId: null, result: { exposedToPage: false, runId: null, status: null } })

    results = await holdRequests(page, isResultRead)
    barrier = await installEventBarrier(page, { type: 'agent_message', phase: 'applying' })
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST')
    await action.click()
    const startResponse = await accepted
    expect(startResponse.status()).toBe(202)
    const runId = String(((await startResponse.json()) as Record<string, unknown>).run_id)

    // Active: delivery waits while the candidate is prepared; the engine keeps running.
    const applying = await barrier.held()
    expect(applying).toMatchObject({ type: 'agent_message', phase: 'applying', runId })
    await expect.soft(work.heading).toHaveText('Verification in progress')
    await expect.soft(work.summary).toHaveAttribute('data-phase', 'applying')
    await expect.soft(work.detail).toContainText('Preparing the candidate')
    await expect.soft(work.details).toHaveAttribute('aria-expanded', 'false')
    await captureState(review, page, caseName, {
      state: 'active',
      mode: 'captured',
      conditions: ['live-event delivery held after the first candidate-preparation activity', 'result reads held'],
      runId,
      result: { exposedToPage: false, runId: null, status: null },
    })

    // Deliver through the first activity after the replay evidence: the producer's actual scan event.
    await barrier.release({ type: 'agent_message', after: { type: 'evidence_added', phase: 'replaying' } })
    const scan = await barrier.held()
    expect(scan).toMatchObject({ type: 'agent_message', phase: 'replaying', runId })
    review.record('producer:scan', scan)
    // The collapsed status is the same projection (soft, so a RED run also reports the panel).
    await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeHidden({ timeout: RUN_BUDGET_MS })
    await expect.soft(workspace.status.locator('.workspace__status-label')).toHaveText(FINALIZING_LABEL)
    await expect(workspace.viewResult).toHaveCount(0)
    expect(await workspace.status.innerText()).not.toMatch(VERDICT_TEXT)
    await review.shot(page, 'finalizing-collapsed.png')
    await workspace.restore.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeVisible()

    // The panel: a Finalizing summary with no verdict, before any result reached the page.
    await expect(work.heading).toHaveText(FINALIZING_LABEL)
    await expect(work.summary).toHaveAttribute('data-execution', 'finalizing')
    await expect(page.locator('.captured-status__final')).toHaveAttribute('data-captured-status', 'pending')
    expect(await work.summary.innerText()).not.toMatch(VERDICT_TEXT)
    await captureState(review, page, caseName, {
      state: 'finalizing',
      mode: 'captured',
      conditions: ['live-event delivery held after the actual producer scan event', 'result reads held'],
      runId,
      result: { exposedToPage: false, runId: null, status: null },
    })

    // Inside Details: one Finalizing row holding the producer's own event, with its raw phase kept.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    const finalizing = work.rows.and(page.locator('[data-kind="finalizing"]'))
    await expect(finalizing).toHaveCount(1)
    await expect(finalizing).toHaveAttribute('data-work-id', `${runId}:${scan.sequence}`)
    await expect(finalizing.locator('.work-row__title')).toContainText('Finalizing')
    await expect(finalizing.locator('.work-row__note code')).toHaveText(scan.phase ?? '')
    const records = finalizing.locator('li.agent-activity__item')
    await expect(records).toHaveCount(1)
    await expect(records.first()).toHaveAttribute('data-phase', 'replaying')
    await expect(records.first()).toHaveAttribute('data-event-id', scan.eventId)
    await expect(records.first().locator('.agent-activity__message')).toHaveText(scan.message)
    const finalizingEvents = eventsToggleOf(finalizing)
    await finalizingEvents.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(finalizingEvents).toHaveAttribute('aria-expanded', 'true')
    expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 })
    await review.shot(page, 'finalizing-details.png')

    // The next activity is the producer's cleanup event; the same Finalizing row grows in place.
    await barrier.release({ type: 'agent_message' })
    const release = await barrier.held()
    expect(release).toMatchObject({ type: 'agent_message', phase: 'replaying', runId, sequence: scan.sequence + 1 })
    review.record('producer:cleanup', release)
    await expect(records).toHaveCount(2)
    await expect(records.nth(1).locator('.agent-activity__message')).toHaveText(release.message)
    await expect(finalizing).toHaveAttribute('data-work-id', `${runId}:${scan.sequence}`)
    await expect(work.heading).toHaveText(FINALIZING_LABEL)
    await expect(finalizingEvents).toHaveAttribute('aria-expanded', 'true')

    // The engine finishes and releases the target; its result is persisted but not exposed.
    const finished = await harness.waitForCapturedResult(RUN_BUDGET_MS)
    expect(finished.runId).toBe(runId)
    expect(finished.result).toMatchObject({ status: 'passed', reason_code: null })
    expect(tracker.detached()).toBe(true)
    await barrier.release(null)
    await expect(work.summary).toHaveAttribute('data-stream', 'ended')
    await expect(records).toHaveCount(3)
    await expect(records.nth(2)).toHaveAttribute('data-type', 'run_finalized')
    // A stream that ended is not a verdict.
    await expect(work.heading).toHaveText(FINALIZING_LABEL)
    await expect(page.locator('.captured-status__final')).toHaveAttribute('data-captured-status', 'pending')
    await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeHidden()
    await expect(workspace.status.locator('.workspace__status-label')).toHaveText(FINALIZING_LABEL)
    await expect(workspace.viewResult).toHaveCount(0)
    await workspace.restore.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeVisible()

    // The bound result arrives while the reader's focus is on the Finalizing row's events.
    await finalizingEvents.focus()
    const before = await readingPosition(finalizingEvents)
    results.release()
    await expect(page.locator('.captured-status__final')).toHaveText('Candidate verification passed')
    const after = await readingPosition(finalizingEvents)
    expect(after.focused).toBe(true)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await expect(finalizingEvents).toHaveAttribute('aria-expanded', 'true')
    await expect(work.summary).toHaveCount(0)
    await expect(records).toHaveCount(3)
    await expect(page.locator('tr.captured-check')).toHaveCount(CAPTURED_CHECK_IDS.length)
    expect(await page.locator('body').innerText()).not.toMatch(/Verified Fix/)
    // The default view of the final state: Details closed again by the reader.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(work.details).toHaveAttribute('aria-expanded', 'false')
    await page.locator('.work-panel__body').evaluate((node) => (node.scrollTop = 0))
    await captureState(review, page, caseName, {
      state: 'successful-final',
      mode: 'captured',
      conditions: ['result reads were held until after finalization was observed'],
      runId,
      result: { exposedToPage: true, runId: finished.runId, status: finished.result.status },
    })
    // The disclosure inside keeps its own choice while Details is closed and reopened.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(finalizingEvents).toHaveAttribute('aria-expanded', 'true')
    // The target was released: rendered contrast and visible focus with the work log open, measured
    // at rest (a transient hover fill under the pointer is not how a control is identified).
    await page.mouse.move(1, 1)
    await expectAccessible(page, review, 'captured-final-work-log-open')

    // Every delivered producer event is in the log, in order, exactly once.
    const delivered = await barrier.delivered()
    review.record('deliveredEvents', delivered)
    expect(await work.items.evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-sequence'))))).toEqual(delivered.map((event) => event.sequence))
    expect(requests.starts()).toBe(1)
    expect(watched.errors).toEqual([])
    expect(watched.csp).toEqual([])
  } catch (error) {
    failure = error
    throw error
  } finally {
    await releaseAll(barrier)
    results?.release()
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
  expect(harness?.blockedRequests).toEqual([])
})

// ---------------------------------------------------------------------------------------
// Captured: more than forty events through a test-controlled transport (synthetic)
// ---------------------------------------------------------------------------------------

type TransportScope = { __flowproofTestTransport: (records: readonly Record<string, unknown>[]) => boolean }

/**
 * Replaces the page's event source with a test-controlled transport that opens no connection and
 * dispatches contract-valid records pushed by the test. Used only where no real run produces the
 * needed amount of activity; such records are synthetic test conditions, never producer evidence.
 */
async function installTestTransport(page: Page): Promise<(records: readonly Record<string, unknown>[]) => Promise<void>> {
  await page.evaluate(() => {
    type Listener = (event: Event) => void
    type Source = { closed: boolean; listeners: Map<string, Listener[]> }
    const sources: Source[] = []
    const emit = (source: Source, type: string, event: Event): void => {
      if (source.closed) return
      for (const listener of source.listeners.get(type) ?? []) listener(event)
    }
    // A plain constructor function: `new` returns the transport object, and no class helper is needed.
    function TestTransportSource(): object {
      const source: Source = { closed: false, listeners: new Map<string, Listener[]>() }
      sources.push(source)
      setTimeout(() => emit(source, 'open', new Event('open')), 0)
      return Object.assign(source, {
        addEventListener(type: string, listener: Listener): void {
          const list = source.listeners.get(type) ?? []
          list.push(listener)
          source.listeners.set(type, list)
        },
        close(): void {
          source.closed = true
        },
      })
    }
    window.EventSource = TestTransportSource as unknown as typeof EventSource
    ;(window as unknown as Record<string, unknown>).__flowproofTestTransport = (records: readonly Record<string, unknown>[]): boolean => {
      const source = sources.at(-1)
      if (source === undefined) return false
      for (const record of records) emit(source, String(record.type), new MessageEvent(String(record.type), { data: JSON.stringify(record), lastEventId: String(record.event_id) }))
      return true
    }
  })
  return async (records) => {
    // The subscription exists once the accepted start reached the page; wait for it, bounded.
    await expect.poll(() => page.evaluate((list) => (window as unknown as TransportScope).__flowproofTestTransport(list), records), { timeout: ELEMENT_TIMEOUT_MS }).toBe(true)
  }
}

const SYNTHETIC_PHASES = ['initialized', 'applying', 'failure_captured'] as const

/** Contract-valid synthetic captured activity, four events per phase group, clearly labelled. */
function syntheticEvents(runId: string, from: number, to: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (let sequence = from; sequence <= to; sequence += 1) {
    const record = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_id: `${runId}:${sequence}`,
      run_id: runId,
      sequence,
      occurred_at: new Date(Date.UTC(2026, 10, 4, 9, 0, sequence)).toISOString(),
      type: 'agent_message',
      phase: SYNTHETIC_PHASES[Math.floor((sequence - 1) / 4) % SYNTHETIC_PHASES.length],
      message: `Synthetic test-transport activity ${sequence}; not produced by the engine.`,
      evidence_ids: [],
      gate: null,
      artifact_refs: [],
    }
    expect(parseStudioEvent(record).ok).toBe(true)
    records.push(record)
  }
  return records
}

test('captured work log keeps an earlier focused row, its open events and the reading position through more than forty events (synthetic test transport)', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  const review = await reviewCase('captured-long-history-synthetic', 'slice3')
  let harness: CapturedStudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  let results: Barrier | undefined
  try {
    harness = await openCapturedVerificationHarness({ capture: produceCanvasFix })
    const { page } = harness
    const workspace = workspaceOf(page)
    const work = workLogOf(page)
    const watched = watchPage(page)
    const push = await installTestTransport(page)
    const runId = randomUUID()
    const requestId = randomUUID()
    // The start never reaches the server: no run, engine or target change; the activity is synthetic.
    let starts = 0
    await page.route(
      (url) => url.pathname === '/api/runs',
      async (route: Route) => {
        if (route.request().method() !== 'POST') return route.continue()
        starts += 1
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ request_id: requestId, run_id: runId, events_url: `/api/runs/${runId}/events` }) })
      },
    )
    results = await holdRequests(page, isResultRead)
    review.record('conditions', ['synthetic start response', 'synthetic contract-valid events through a test-controlled transport', 'result reads held'])
    await page.getByRole('button', { name: 'Start candidate verification' }).click()
    await expect.poll(() => starts).toBe(1)

    // Forty-five accepted events: every one stays listed, including the first (the old panel kept forty).
    await push(syntheticEvents(runId, 1, 45))
    await expect.soft(page.locator('li.agent-activity__item')).toHaveCount(45)
    await expect.soft(page.locator('li.agent-activity__item').first()).toContainText('Synthetic test-transport activity 1;')

    // An earlier row: its events opened with the keyboard, focused and scrolled to the top of the panel.
    await expect(work.heading).toHaveText('Verification in progress')
    await expect(work.details).toHaveAttribute('aria-expanded', 'false')
    await work.details.focus()
    await page.keyboard.press('Enter')
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await expect(work.rows).toHaveCount(12)
    const earlier = work.rows.nth(1)
    await expect(earlier).toHaveAttribute('data-work-id', `${runId}:5`)
    const earlierEvents = eventsToggleOf(earlier)
    await earlierEvents.focus()
    await page.keyboard.press('Space')
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    await expect(earlierEvents).toBeFocused()
    await scrollToTop(earlierEvents)
    const before = await readingPosition(earlierEvents)
    expect(before.focused).toBe(true)
    expect(await visibleInPanel(work.rows.last())).toBe(false)
    await review.shot(page, 'earlier-row-focused.png')

    // More work arrives in batches: nothing removed, no scroll or focus moved, latest work offered.
    for (const [from, to] of [
      [46, 50],
      [51, 55],
      [56, 60],
    ] as const) {
      await push(syntheticEvents(runId, from, to))
      await expect(work.items).toHaveCount(to)
      const now = await readingPosition(earlierEvents)
      expect(now.focused).toBe(true)
      expect(Math.abs(now.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
      expect(Math.abs(now.top - before.top)).toBeLessThanOrEqual(1)
      await expect(earlier).toHaveAttribute('data-work-id', `${runId}:5`)
      await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(work.rows).toHaveCount(15)
    await expect(work.jump).toBeVisible()
    await expect(work.jump).toContainText('Jump to latest work')
    await expect(work.jump).toContainText('new')
    // Long open Details scroll inside the panel; the page itself never gains a scrollbar.
    expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 })
    await review.shot(page, 'appended-reading-kept.png')

    // Returning to the latest work is explicit (here with the keyboard) and moves focus there.
    await work.jump.focus()
    await page.keyboard.press('Enter')
    const latest = work.rows.last()
    await expect.poll(() => visibleInPanel(latest)).toBe(true)
    await expect(latest.locator('.work-row__title')).toBeFocused()
    await expect(work.jump).toBeHidden()

    // Collapse and restore keep every disclosure choice.
    await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeHidden()
    await expect(workspace.status.locator('.workspace__status-label')).toHaveText('Verification in progress')
    await workspace.restore.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    await expect(work.items).toHaveCount(60)
    expect(await work.items.evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-sequence'))))).toEqual(Array.from({ length: 60 }, (_, index) => index + 1))
    // Rendered contrast and the visible focus of the open work log's controls (guarded frame, no run).
    await page.locator('.work-panel__body').evaluate((node) => (node.scrollTop = 0))
    await expectAccessible(page, review, 'captured-work-log-open')
    // Reflow at a compact and a large viewport: the open log wraps, with no page-wide horizontal scroll.
    for (const size of [
      { width: 390, height: 844 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(size)
      expect((await pageOverflow(page)).x, `${size.width}x${size.height}`).toBe(0)
      await expect(work.details).toHaveAttribute('aria-expanded', 'true')
      await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
      await review.shot(page, `work-log-open-${size.width}x${size.height}.png`)
    }
    expect(watched.errors).toEqual([])
    expect(watched.csp).toEqual([])
  } catch (error) {
    failure = error
    throw error
  } finally {
    results?.release()
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
})

// ---------------------------------------------------------------------------------------
// Legacy: real appended work, finalization, pending reads and the result
// ---------------------------------------------------------------------------------------

test('legacy work log: an earlier focused row, its open events, reading position and Details survive real appended work, finalization, the result, collapse and pending reads', async () => {
  test.setTimeout(RUN_BUDGET_MS + 240_000)
  const caseName = 'legacy-work-log'
  const review = await reviewCase(caseName, 'slice3')
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  let barrier: EventBarrier | undefined
  let results: Barrier | undefined
  let consoleRead: Barrier | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    const workspace = workspaceOf(page)
    const work = workLogOf(page)
    const requests = logRequests(page)
    const watched = watchPage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    const start = page.getByRole('button', { name: /^(start|send|run)\b/i })
    await expect(start).toBeEnabled()
    await expect(work.heading).toHaveText('Ready')
    const tracker = await trackFrame(page)
    await captureState(review, page, caseName, { state: 'ready', mode: 'legacy', conditions: [], runId: null, result: { exposedToPage: false, runId: null, status: null } })

    results = await holdRequests(page, isResultRead)
    consoleRead = await holdRequests(page, (url) => /\/evidence\/ev_failure_console_[0-9]{3}$/.test(url.pathname))
    barrier = await installEventBarrier(page, { type: 'phase_started', phase: 'applying' })
    await start.click()
    await expect.poll(() => requests.starts()).toBe(1)
    const applying = await barrier.held()
    const runId = applying.runId
    await expect(work.heading).toHaveText('Run in progress')
    await expect(work.summary).toHaveAttribute('data-phase', 'applying')
    await expect(work.details).toHaveAttribute('aria-expanded', 'false')
    expect(await work.summary.innerText()).not.toMatch(VERDICT_TEXT)
    await captureState(review, page, caseName, {
      state: 'active',
      mode: 'legacy',
      conditions: ['live-event delivery held after the applying phase started', 'result reads held', 'recorded model transport'],
      runId,
      result: { exposedToPage: false, runId: null, status: null },
    })

    // Only content inside the panel changes from here until the engine finalizes, never its layout.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    // The first received group: live events emitted before the subscription are never replayed.
    const earlier = work.rows.first()
    const earlierEvents = eventsToggleOf(earlier)
    await earlierEvents.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    await earlierEvents.focus()
    await scrollToTop(earlierEvents)
    const before = await readingPosition(earlierEvents)
    expect(before.focused).toBe(true)

    // Real work is appended through the original-worktree gate: legacy finalization was observed.
    await barrier.release({ type: 'gate_updated', gate: 'original_worktree_unchanged' })
    const integrity = await barrier.held()
    review.record('producer:integrityGate', integrity)
    await expect(work.heading).toHaveText(FINALIZING_LABEL)
    const appended = await readingPosition(earlierEvents)
    expect(appended.focused).toBe(true)
    expect(Math.abs(appended.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(appended.top - before.top)).toBeLessThanOrEqual(1)
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    const finalizing = work.rows.and(page.locator('[data-kind="finalizing"]'))
    await expect(finalizing).toHaveAttribute('data-work-id', `${runId}:${integrity.sequence}`)
    await expect(finalizing.locator('.work-row__note code')).toHaveText(integrity.phase ?? '')
    if (!(await visibleInPanel(finalizing))) await expect(work.jump).toBeVisible()
    expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 })
    await review.shot(page, 'appended-reading-kept.png')

    // The engine's measurements are over: the default finalizing view, then explicit return to latest.
    await scrollToTop(work.heading)
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await captureState(review, page, caseName, {
      state: 'finalizing',
      mode: 'legacy',
      conditions: ['live-event delivery held after the original-worktree gate update', 'result reads held', 'recorded model transport'],
      runId,
      result: { exposedToPage: false, runId: null, status: null },
    })
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    await earlierEvents.focus()
    await scrollToTop(earlierEvents)
    if (await visibleInPanel(finalizing)) {
      review.record('jumpToLatest', 'latest row already visible at this viewport; affordance not offered')
    } else {
      await work.jump.click({ timeout: ELEMENT_TIMEOUT_MS })
      await expect.poll(() => visibleInPanel(finalizing)).toBe(true)
      await expect(finalizing.locator('.work-row__title')).toBeFocused()
      await expect(work.jump).toBeHidden()
    }

    // The final event and then the bound result arrive while the reader is on the earlier row.
    const finished = await harness.waitForResult(RUN_BUDGET_MS)
    expect(finished.runId).toBe(runId)
    expect(finished.result.status).toBe('Verified Fix')
    await earlierEvents.focus()
    await scrollToTop(earlierEvents)
    const reading = await readingPosition(earlierEvents)
    await barrier.release(null)
    await expect(work.summary).toHaveAttribute('data-stream', 'ended')
    await expect(work.heading).toHaveText(FINALIZING_LABEL)
    await expect(page.locator('.agent-status__final')).toHaveAttribute('data-status', 'pending')
    results.release()
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Verified Fix', { exact: true })).toBeVisible()
    const decided = await readingPosition(earlierEvents)
    expect(decided.focused).toBe(true)
    expect(Math.abs(decided.top - reading.top)).toBeLessThanOrEqual(2)
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    await review.shot(page, 'result-reading-kept.png')

    // The mounted Proof Trail's held read survives a collapse; disclosures survive it too.
    await expect.poll(() => consoleRead?.held() ?? 0).toBe(1)
    await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeHidden()
    await expect(workspace.status).toHaveText('Verified Fix')
    consoleRead.release()
    await sleep(500)
    await workspace.restore.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeVisible()
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await expect(earlierEvents).toHaveAttribute('aria-expanded', 'true')
    const consoleItem = page.getByRole('region', { name: 'Failure evidence', exact: true }).locator('li[data-type="console"]')
    await expect(consoleItem).not.toContainText('Loading the evidence.')
    const reads = requests.evidenceReads()
    expect(new Set(reads).size).toBe(reads.length)

    // The default final view: Details closed by the reader, scrolled to the top.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await page.locator('.work-panel__body').evaluate((node) => (node.scrollTop = 0))
    await captureState(review, page, caseName, {
      state: 'successful-final',
      mode: 'legacy',
      conditions: ['recorded model transport', 'result reads were held until after finalization was observed'],
      runId,
      result: { exposedToPage: true, runId: finished.runId, status: finished.result.status },
    })

    // Every delivered event is in the log, in order, exactly once.
    const delivered = await barrier.delivered()
    review.record('deliveredEvents', delivered)
    expect(await work.items.evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-sequence'))))).toEqual(delivered.map((event) => event.sequence))
    // After the result: rendered contrast and visible focus with the work log open.
    await work.details.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(work.details).toHaveAttribute('aria-expanded', 'true')
    await page.mouse.move(1, 1)
    await expectAccessible(page, review, 'legacy-final-work-log-open')
    await tracker.expectSameFrame()
    expect(requests.starts()).toBe(1)
    await expect(page.locator('tr.agent-gate')).toHaveCount(GATE_IDS.length)
    expect(watched.errors).toEqual([])
    expect(watched.csp).toEqual([])
  } catch (error) {
    failure = error
    throw error
  } finally {
    await releaseAll(barrier)
    results?.release()
    consoleRead?.release()
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
})

// ---------------------------------------------------------------------------------------
// Legacy: live activity lost before the result, then an unsuccessful bound result
// ---------------------------------------------------------------------------------------

test('legacy activity lost before the result shows a separate warning and no verdict, then the bound unsuccessful result', async () => {
  test.setTimeout(RUN_BUDGET_MS + 120_000)
  const caseName = 'legacy-activity-lost-unsuccessful'
  const review = await reviewCase(caseName, 'slice3')
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let failure: unknown
  let results: Barrier | undefined
  try {
    harness = await openStudioHarness({ scenarioId: FAILURE, recordedTransport: false })
    const { page } = harness
    const workspace = workspaceOf(page)
    const work = workLogOf(page)
    const requests = logRequests(page)
    const watched = watchPage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(page.getByLabel('Prepared case')).toHaveValue(FAILURE)
    results = await holdRequests(page, isResultRead)
    // The existing route pattern of browser-close.spec.ts: the page's live activity is refused.
    let aborted = 0
    await page.route(
      (url) => isEventStream(url),
      async (route: Route) => {
        aborted += 1
        await route.abort('connectionreset')
      },
    )
    await page.getByRole('button', { name: /^(start|send|run)\b/i }).click()
    await expect.poll(() => requests.starts()).toBe(1)

    // A separate activity warning; the execution stays as last observed and nothing is a verdict.
    await expect(work.summary).toHaveAttribute('data-stream', 'disconnected')
    await expect(work.warning).toBeVisible()
    await expect(work.warning).toContainText('Live activity disconnected')
    await expect(work.heading).toHaveText('Run in progress')
    await expect(page.locator('.agent-status__final')).toHaveAttribute('data-status', 'pending')
    expect(await work.summary.innerText()).not.toMatch(VERDICT_TEXT)
    // Rendered contrast of the warning (no focus traversal while the engine may measure the target).
    const contrast = await auditContrast(page)
    review.record('contrast:legacy-disconnected', contrast)
    expect(contrast.failures).toEqual([])
    await captureState(review, page, caseName, {
      state: 'disconnected-without-result',
      mode: 'legacy',
      conditions: ['live-event request aborted by a test route', 'result reads held', 'committed fixture provider'],
      runId: null,
      result: { exposedToPage: false, runId: null, status: null },
    })

    // The engine finished unseen; until the page reads the result, still no verdict.
    const finished = await harness.waitForResult(RUN_BUDGET_MS)
    expect(finished.result.status).toBe('Unverified')
    await expect(work.heading).toHaveText('Run in progress')
    await expect(page.locator('.agent-status__final')).toHaveAttribute('data-status', 'pending')
    await workspace.collapse.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.status.locator('.workspace__status-notice')).toHaveText('Live activity disconnected')
    await expect(workspace.status.locator('.workspace__status-label')).toHaveText('Run in progress')
    await review.shot(page, 'disconnected-collapsed-request.png')
    results.release()
    // The bound result decides; the held layout request is applied only now.
    await expect(workspace.status.locator('.workspace__status-label')).toHaveText('Unverified')
    await expect(workspace.panel).toBeHidden()
    await workspace.viewResult.click({ timeout: ELEMENT_TIMEOUT_MS })
    await expect(workspace.panel).toBeVisible()
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Unverified', { exact: true })).toBeVisible()
    await expect(page.locator('.agent-status__failed')).toContainText('Citations valid')
    await expect(work.summary).toHaveCount(0)
    await page.locator('.work-panel__body').evaluate((node) => (node.scrollTop = 0))
    await captureState(review, page, caseName, {
      state: 'unsuccessful-final',
      mode: 'legacy',
      conditions: ['live-event request aborted by a test route', 'result reads were held until the engine finished', 'committed fixture provider'],
      runId: finished.runId,
      result: { exposedToPage: true, runId: finished.runId, status: finished.result.status },
    })
    review.record('abortedStreams', aborted)
    expect(aborted).toBeGreaterThan(0)
    await expect(page.locator('tr.agent-gate')).toHaveCount(GATE_IDS.length)
    expect(watched.errors).toEqual([])
    expect(watched.csp).toEqual([])
  } catch (error) {
    failure = error
    throw error
  } finally {
    results?.release()
    cleanup = await harness?.close()
    review.record('cleanup', cleanup ?? null)
    await review.finish(failure)
  }
  expectNothingLeft(cleanup, harness?.baseline)
})

// ---------------------------------------------------------------------------------------
// Opt-in owner review on the real Studio (quickstart.md, real-UI owner acceptance material)
// ---------------------------------------------------------------------------------------

const OWNER_START_TIMEOUT_MS = 120_000
const OWNER_ACK_TIMEOUT_MS = 180_000

/** Waits for a fresh marker file; a missing one leaves the review pending, never passed. */
async function waitForMarker(marker: string, promptedAt: number, timeoutMs: number, code: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(marker) && (await stat(marker)).mtimeMs >= promptedAt) return
    await sleep(250)
  }
  throw new Error(`${code}: no acknowledgement within ${timeoutMs / 1000}s; the owner review is pending, not passed.`)
}

/** Prints and records one bounded instruction for the owner, outside any product control. */
async function instruct(review: ReviewCase, text: string): Promise<number> {
  await writeFile(path.join(review.dir, 'INSTRUCTIONS.txt'), `${text}\n`)
  console.log(`\n[owner-review] ${text}\n`)
  return Date.now()
}

for (const mode of ['legacy', 'captured'] as const) {
  test(`owner-review: ${mode} start, observed work and final shell on the real Studio (opt-in, bounded)`, async () => {
    test.skip(process.env.FLOWPROOF_OWNER_REVIEW !== '1', 'Opt-in owner review: set FLOWPROOF_OWNER_REVIEW=1 on a visible desktop and follow quickstart.md.')
    test.setTimeout(900_000)
    const review = await reviewCase(`owner-review-${mode}`, 'slice3')
    const finalMarker = path.join(review.dir, 'final-reviewed.ack')
    let legacy: StudioHarness | undefined
    let captured: CapturedStudioHarness | undefined
    let cleanup: CleanupReport | undefined
    let failure: unknown
    try {
      if (mode === 'legacy') legacy = await openStudioHarness({ scenarioId: HERO })
      else captured = await openCapturedVerificationHarness({ capture: produceCanvasFix })
      const page = (legacy ?? captured)?.page
      if (page === undefined) throw new Error('The Studio did not open.')
      const requests = logRequests(page)
      const work = workLogOf(page)
      await page.bringToFront()
      await expect(work.heading).toHaveText('Ready')
      await rm(finalMarker, { force: true })

      // SC-001: the owner's own start, timed from the prompt to the observed admission request.
      const prompted = await instruct(review, 'Without coaching: identify the prepared case or fixed candidate in the visible Studio window and start it.')
      const startDeadline = Date.now() + OWNER_START_TIMEOUT_MS
      while (requests.starts() === 0 && Date.now() < startDeadline) await sleep(100)
      if (requests.starts() === 0) throw new Error(`OWNER_START_MISSING: no start within ${OWNER_START_TIMEOUT_MS / 1000}s; SC-001 is pending, not passed.`)
      review.record('sc001:startSeconds', (Date.now() - prompted) / 1000)

      // The ordinary bounded run; captured target disposal completes before the final shell review.
      const finished = legacy !== undefined ? await legacy.waitForResult(RUN_BUDGET_MS) : await (captured as CapturedStudioHarness).waitForCapturedResult(RUN_BUDGET_MS)
      review.record('result', { runId: finished.runId, status: finished.result.status })
      await expect(page.locator('[data-workspace-result]')).toBeVisible({ timeout: RUN_BUDGET_MS })

      // The final shell stays open for the owner's own walkthrough, then a terminal acknowledgement.
      const reviewPrompt = await instruct(review, `Review the observed work and the result in the Studio window, then run:\n  touch '${finalMarker}'`)
      await waitForMarker(finalMarker, reviewPrompt, OWNER_ACK_TIMEOUT_MS, 'OWNER_REVIEW_ACK_MISSING')
      review.record('finalReviewSeconds', (Date.now() - reviewPrompt) / 1000)
      review.record('ownerAnswers', 'recorded separately by the owner; not collected by this test')
    } catch (error) {
      failure = error
      throw error
    } finally {
      cleanup = await (legacy ?? captured)?.close()
      review.record('cleanup', cleanup ?? null)
      await review.finish(failure)
    }
    expectNothingLeft(cleanup, (legacy ?? captured)?.baseline)
  })
}
