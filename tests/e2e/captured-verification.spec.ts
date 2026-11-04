import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Frame, Page } from '@playwright/test'

import { STUDIO_EVENT_TYPES, parseEvidenceBundle, parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, StudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { DEFAULT_RECONNECT_TIMEOUT_MS, callTrustedProbe } from '../../packages/flowproof/src/studio/targetApp.js'
import { CAPTURED_CHECK_IDS, parseCapturedVerificationResult } from '../../packages/flowproof/src/verify/capturedContracts.js'
import type { CapturedVerificationResult } from '../../packages/flowproof/src/verify/capturedContracts.js'
import { produceCanvasCandidate } from '../support/capturedCanvasCandidate.js'
import type { CanvasCandidate, CanvasCase } from '../support/capturedCanvasCandidate.js'
import { removeFixtureImage } from '../support/editingRuntime.js'
import { REPO_ROOT, listTree } from '../support/repoFixture.js'
import { CAPTURED_SCENARIO_ID, DEMO_PORT, openCapturedVerificationHarness } from '../support/studioHarness.js'
import type { CapturedStudioHarness, CleanupReport } from '../support/studioHarness.js'

/**
 * Opens the work panel's Details, where the run details stay on demand (Spec 005 slice 4). The
 * pane recording counts every real pointer press and key press as an input attempt on the target,
 * so the disclosure is activated by its click event alone, which adds neither.
 */
async function openWorkDetails(page: Page): Promise<void> {
  const toggle = page.locator('section.work-timeline button[data-disclosure="details"]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.dispatchEvent('click')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

// T020 for T022 and T025-T027: the captured verification launched through
// `startCapturedVerificationStudio` in the real headed Studio. Each case produces a prepared
// Canvas candidate through the real Docker-backed capturing session against the harness clone,
// launches the captured Studio for it, and starts the host-fixed run with the Studio's own
// candidate-verification action. The run must drive and observe the one Studio target iframe: the
// same iframe element and the same Playwright frame show the recorded baseline and then the
// candidate build, the prepared select action runs there, and the strict result and its evidence
// are bound to this run and candidate. The captured surface renders that strict result, with no
// chat, legacy gate, Proof Trail, provider or candidate-diff section. The target pane labels the
// frame only from actual run activity (preview, preparation, the live measured phases, not live
// after finalization) and, from the start on, keeps a transparent cover over the frame, the frame
// out of the tab order and focus outside it while real clicks and Tab presses are attempted; the
// programmatic select still drives the real frame. Final and held-preparation screenshots are
// saved as test evidence. No model, key or external request is involved, and closing the Studio
// leaves nothing behind.
//
// T030 for T033: finalization releases the target before the result is published. After the last
// evidence, that same iframe element is removed and its frame detached (its document and runtime
// end, rather than a stale last document behind a not-live label), and the target app no longer
// serves or listens, while the guarded result shell, its closed result and evidence routes and the
// Studio browser stay available until the user closes the Studio. The pane then shows this run's
// captured before/after screenshots, labelled as captured and not live, by exactly the Evidence IDs
// the run announced with the result's manifests, and states evidence the result does not record as
// not produced; the Studio page raises no error while React replaces the released frame. Closing
// the Studio mid-run while the target load is held aborts that load, finalizes the run as
// interrupted locally, and still releases everything.

const RUN_BUDGET_MS = 300_000
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'
const scenario = await loadScenario(CAPTURED_SCENARIO_ID, { repoRoot: REPO_ROOT })
const TARGET_DOCUMENT = scenario.scenario.app.url
const [SELECT_ACTION] = scenario.scenario.actions
if (SELECT_ACTION === undefined || SELECT_ACTION.type !== 'select') throw new Error('The prepared scenario commits one select action.')

test.afterAll(async () => {
  await removeFixtureImage()
})

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** How often the independent observer reads the tracked frame's trusted probe. */
const POLL_INTERVAL_MS = 10

interface TargetFrameTracker {
  readonly frame: Frame
  /** Navigations of exactly this frame, as URLs, since tracking started. */
  readonly navigations: readonly string[]
  /** When each of those navigations was observed, in epoch milliseconds of this process. */
  readonly navigatedAt: readonly number[]
  /** Frames attached to or detached from the Studio page since tracking started. */
  frameChanges(): number
  /** When exactly this frame detached, in epoch milliseconds of this process; null while attached. */
  detachedAt(): number | null
  /** Whether the Studio page was still open when exactly this frame detached. */
  detachedWhilePageOpen(): boolean
  /** Distinct trusted-probe datasets this frame showed, in order. */
  readonly datasets: readonly string[]
  /** Distinct trusted-probe states this frame showed, in order. */
  readonly states: readonly string[]
  /** Proves the Studio still holds the very iframe element and frame tracked at the start. */
  expectSameFrame(): Promise<void>
  /**
   * Proves the run released exactly that iframe and frame: the tracked element was removed from the
   * still-open Studio page, its frame detached, no other frame came or went, and no iframe is left.
   */
  expectReleased(): Promise<void>
  stop(): Promise<void>
}

/** Tags the Studio's one target iframe and follows exactly that element and frame through the run. */
async function trackTargetFrame(page: Page): Promise<TargetFrameTracker> {
  const iframes = page.locator('iframe')
  await expect(iframes).toHaveCount(1)
  const element = await iframes.elementHandle()
  const frame = await element?.contentFrame()
  if (!element || !frame) throw new Error('The Studio has no target frame.')
  const token = randomUUID()
  await element.evaluate((node, value) => Object.defineProperty(node, '__flowproofTrackedFrame', { value, enumerable: false }), token)
  // Kept until `stop()`, so the element can still be identified after the run removed it.
  const tracked = element

  const navigations: string[] = []
  const navigatedAt: number[] = []
  let frameChanges = 0
  let detachedAt: number | null = null
  let detachedWhilePageOpen = false
  page.on('framenavigated', (navigated) => {
    if (navigated !== frame) return
    navigations.push(navigated.url())
    navigatedAt.push(Date.now())
  })
  page.on('frameattached', () => (frameChanges += 1))
  page.on('framedetached', (detached) => {
    frameChanges += 1
    if (detached !== frame) return
    detachedAt = Date.now()
    detachedWhilePageOpen = !page.isClosed()
  })

  const datasets: string[] = []
  const states: string[] = []
  const record = async (method: 'readDataset' | 'readState', shown: string[]): Promise<void> => {
    const reply = await callTrustedProbe(frame, method)
    const value = reply.ok ? JSON.stringify(reply.value) : null
    if (value !== null && shown.at(-1) !== value) shown.push(value)
  }
  let polling = true
  const poller = (async () => {
    while (polling) {
      try {
        await record('readDataset', datasets)
        await record('readState', states)
      } catch {
        // The frame is navigating or was released; the next poll reads the new document, if any.
      }
      // Finalization releases the frame shortly after its replay capture, so the frame shows its
      // final selected state only briefly; sampling this often still observes it several times.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  })()

  return {
    frame,
    navigations,
    navigatedAt,
    datasets,
    states,
    frameChanges: () => frameChanges,
    detachedAt: () => detachedAt,
    detachedWhilePageOpen: () => detachedWhilePageOpen,
    async expectSameFrame() {
      const current = page.locator('iframe')
      await expect(current).toHaveCount(1)
      const handle = await current.elementHandle()
      expect(await handle?.evaluate((node) => (node as unknown as Record<string, unknown>).__flowproofTrackedFrame)).toBe(token)
      expect(await handle?.contentFrame()).toBe(frame)
      await handle?.dispose()
      expect(frame.isDetached()).toBe(false)
      expect(frame.parentFrame()).toBe(page.mainFrame())
      expect(page.frames()).toHaveLength(2)
    },
    async expectReleased() {
      expect(page.isClosed()).toBe(false)
      await expect(page.locator('iframe')).toHaveCount(0)
      expect(await tracked.evaluate((node) => ({ token: (node as unknown as Record<string, unknown>).__flowproofTrackedFrame, connected: node.isConnected }))).toEqual({
        token,
        connected: false,
      })
      expect(frame.isDetached()).toBe(true)
      expect(detachedAt).not.toBeNull()
      expect(detachedWhilePageOpen).toBe(true)
      // Exactly one frame change: the detachment of the tracked frame; none attached.
      expect(frameChanges).toBe(1)
      expect(page.frames()).toEqual([page.mainFrame()])
    },
    async stop() {
      polling = false
      await poller
      await tracked.dispose().catch(() => undefined)
    },
  }
}

/** Whether anything accepts an HTTP request on the committed demo port, as the harness checks it. */
function demoPortListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host: 'localhost', port: DEMO_PORT, path: '/', timeout: 1_000 }, (response) => {
      response.resume()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
    probe.on('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.end()
  })
}

interface StartedRun {
  readonly run_id: string
  readonly request_id: string
  readonly events_url: string
}

/** One recorded state of the target pane, taken whenever it changed between animation frames. */
interface PaneSample {
  readonly label: string
  readonly text: string
  readonly cover: boolean
  /** The element a pointer at the frame's center would hit is the cover. */
  readonly coverHit: boolean
  readonly frameTabIndex: string | null
  readonly focusInFrame: boolean
  /** The tracked target iframe is still in the Studio document. */
  readonly frameAttached: boolean
}

/** One pointer or key event that reached the Studio document. */
interface PaneInput {
  readonly type: string
  readonly onCover: boolean
  readonly label: string
  /** The tracked target iframe was still in the Studio document when the event arrived. */
  readonly frameAttached: boolean
}

const PANE_LABELS: Readonly<Record<string, string>> = {
  preview: 'Prepared preview (not under verification)',
  'not-live': 'Preparation (not live)',
  'baseline-live': 'Live: recorded baseline',
  'candidate-live': 'Live: candidate build',
  'completed-evidence': 'Captured evidence (not live): the verification finalized and the target was released',
}

/**
 * Records the actual target pane in the Studio page on every animation frame (changes only), and
 * every pointer and key event that reaches the Studio document. The Studio page never navigates,
 * so the recorder sees the whole run; it reads only Studio DOM state, never the target frame.
 */
async function recordTargetPane(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as Record<string, unknown>
    const samples: unknown[] = []
    const inputs: unknown[] = []
    scope.__flowproofPane = { samples, inputs, recording: true }
    const pane = document.querySelector('.target-pane') as HTMLElement
    const frame = pane.querySelector('iframe') as HTMLIFrameElement
    const labelOf = (): string => pane.querySelector('[data-target-presentation]')?.getAttribute('data-target-presentation') ?? 'none'
    let last = ''
    const sample = (): void => {
      const label = pane.querySelector('[data-target-presentation]')
      const cover = pane.querySelector('.target-pane__cover')
      const box = frame.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      const entry = {
        label: labelOf(),
        text: label?.textContent ?? '',
        cover: cover !== null,
        coverHit: cover !== null && hit === cover,
        frameTabIndex: frame.getAttribute('tabindex'),
        focusInFrame: document.activeElement === frame,
        frameAttached: frame.isConnected,
      }
      const key = JSON.stringify(entry)
      if (key !== last) samples.push(entry)
      last = key
      if ((scope.__flowproofPane as { recording: boolean }).recording) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    for (const type of ['pointerdown', 'keydown']) {
      window.addEventListener(
        type,
        (event) =>
          inputs.push({ type, onCover: (event.target as Element | null)?.classList?.contains('target-pane__cover') === true, label: labelOf(), frameAttached: frame.isConnected }),
        true,
      )
    }
  })
}

async function paneRecording(page: Page): Promise<{ readonly samples: PaneSample[]; readonly inputs: PaneInput[] }> {
  return page.evaluate(() => {
    const pane = (window as unknown as Record<string, { samples: PaneSample[]; inputs: PaneInput[]; recording: boolean }>).__flowproofPane
    if (!pane) throw new Error('The target pane is not being recorded.')
    pane.recording = false
    return { samples: [...pane.samples], inputs: [...pane.inputs] }
  })
}

interface InputAttempts {
  /** Real pointer clicks sent at the target frame's center while the run was active. */
  readonly clicks: number
  /** Tab presses sent, and whether the Studio's active element was ever the frame after one. */
  readonly tabs: number
  readonly focusReachedFrame: boolean
  stop(): Promise<void>
}

/**
 * Sends real user input, as a person at the Studio would, until stopped: a pointer click at the
 * target frame's center and a Tab press, repeatedly, checking after each Tab whether focus reached
 * the frame. A cover that failed would let a click reach the target and change the measurement.
 */
async function attemptUserInput(page: Page): Promise<InputAttempts> {
  const box = await page.locator('iframe').boundingBox()
  if (box === null) throw new Error('The target frame has no box.')
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const attempts = { clicks: 0, tabs: 0, focusReachedFrame: false }
  let active = true
  const loop = (async () => {
    while (active) {
      await page.mouse.click(center.x, center.y)
      attempts.clicks += 1
      await page.keyboard.press('Tab')
      attempts.tabs += 1
      // Focus inside the frame makes the frame element the Studio's active element. The frame's own
      // document is never read here: its navigation may be held, which would stall the attempt.
      if (await page.evaluate(() => document.activeElement?.tagName === 'IFRAME')) attempts.focusReachedFrame = true
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  })()
  return {
    get clicks() {
      return attempts.clicks
    },
    get tabs() {
      return attempts.tabs
    },
    get focusReachedFrame() {
      return attempts.focusReachedFrame
    },
    async stop() {
      active = false
      await loop
    },
  }
}

/**
 * The pane told the truth and guarded the target for the whole run: the labels follow the actual
 * run (preview, preparation, the live measured phases, then not live after finalization), every
 * label reads its fixed text, and from the start on every recorded state with the target frame in
 * the Studio has the transparent cover on top of it, the frame out of the tab order and focus
 * outside it. The run released that frame only after its last live state, while the pane was not
 * live, and it never came back. Every real click sent while the frame existed reached the cover, so
 * none reached the target; after its release there is no target to reach.
 */
function expectGuardedPane(recording: { readonly samples: readonly PaneSample[]; readonly inputs: readonly PaneInput[] }, attempts: InputAttempts, live: readonly string[]): void {
  const { samples, inputs } = recording
  for (const sample of samples) expect(sample.text, sample.label).toBe(PANE_LABELS[sample.label])
  const labels = samples.map((sample) => sample.label).filter((label, index, all) => index === 0 || all[index - 1] !== label)
  expect(labels.filter((label) => label !== 'not-live')).toEqual(['preview', ...live, 'completed-evidence'])
  // Preparation precedes the first live phase and separates the baseline from the candidate.
  expect(labels.slice(0, 3)).toEqual(['preview', 'not-live', 'baseline-live'])
  if (live.includes('candidate-live')) expect(labels.slice(labels.indexOf('baseline-live') + 1, labels.indexOf('candidate-live'))).toEqual(['not-live'])

  const [preview] = samples
  expect(preview).toMatchObject({ label: 'preview', cover: false, frameTabIndex: null, frameAttached: true })
  const notLive = (label: string): boolean => label === 'not-live' || label === 'completed-evidence'
  // The frame stays in the Studio through every live state and is released only afterwards, for good.
  const released = samples.findIndex((sample) => !sample.frameAttached)
  const lastLive = samples.findLastIndex((sample) => (live as readonly string[]).includes(sample.label))
  expect(released, 'the run released the target frame').toBeGreaterThan(lastLive)
  expect(lastLive).toBeGreaterThan(0)
  for (const sample of samples.slice(released)) expect({ label: sample.label, notLive: notLive(sample.label), frameAttached: sample.frameAttached }).toEqual({ label: sample.label, notLive: true, frameAttached: false })
  const guarded = samples.slice(samples.findIndex((sample) => sample.label !== 'preview'), released)
  expect(guarded.length).toBeGreaterThan(0)
  for (const sample of guarded) expect(sample, sample.label).toMatchObject({ cover: true, coverHit: true, frameTabIndex: '-1', focusInFrame: false, frameAttached: true })
  for (const label of live) expect(guarded.some((sample) => sample.label === label), label).toBe(true)

  // The start click lands on the action before the run exists; every later click is user input on the target.
  const pointers = inputs.filter((input) => input.type === 'pointerdown' && input.label !== 'preview')
  expect(attempts.clicks).toBeGreaterThan(0)
  expect(pointers).toHaveLength(attempts.clicks)
  expect(pointers.filter((input) => input.frameAttached).every((input) => input.onCover)).toBe(true)
  expect(pointers.filter((input) => !input.frameAttached).every((input) => notLive(input.label))).toBe(true)
  expect(attempts.tabs).toBeGreaterThan(0)
  expect(attempts.focusReachedFrame).toBe(false)
}

/** Saves a full Studio screenshot as test evidence and returns its path. */
async function saveScreenshot(page: Page, name: string): Promise<string> {
  const file = test.info().outputPath(name)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

/** Legacy model-flow surfaces that the captured verification Studio never renders. */
const LEGACY_SECTIONS = /^(Chat|Request|Candidate|Evidence|Verification gates|Proof Trail|Provenance|Diagnosis|Candidate diff|Failure evidence|Replay evidence)$/

/**
 * Starts the host-fixed run with the Studio's own candidate-verification action, as the user does,
 * and reads the accepted start from the guarded API response. The UI sends only the case and its
 * committed goal.
 */
async function startWithStudioAction(page: Page): Promise<StartedRun> {
  const action = page.getByRole('button', { name: 'Start candidate verification' })
  await expect(action).toBeEnabled()
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST')
  await action.click()
  const reply = await accepted
  expect(reply.status()).toBe(202)
  expect(reply.request().postDataJSON()).toEqual({ scenario_id: CAPTURED_SCENARIO_ID, request_text: GOAL })
  const body = (await reply.json()) as StartedRun
  expect(Object.keys(body).sort()).toEqual(['events_url', 'request_id', 'run_id'])
  // One verification per launch: the action stays unavailable from now on.
  await expect(action).toBeDisabled()
  return body
}

/**
 * The captured surface shows the strict result bound to this run: its final status, the ten check
 * rows with their reasons, the short candidate digest and baseline, and the no-diagnosis statement;
 * there is no Meta chat, legacy gate, Proof Trail, provider or candidate-diff section, and no
 * Verified Fix claim anywhere in the Studio.
 */
async function expectCapturedSurface(page: Page, result: CapturedVerificationResult): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Candidate verification', exact: true })).toBeVisible()
  const final = page.locator('.captured-status__final')
  await expect(final).toHaveAttribute('data-captured-status', result.status)
  // The concise result names every failed or unevaluable check; everything else is in the Details.
  const unsuccessful = page.locator('.result-summary__unsuccessful')
  if (result.status === 'passed') {
    await expect(final).toHaveText('Candidate verification passed')
    await expect(unsuccessful).toHaveCount(0)
  } else {
    await expect(final.locator('.captured-status__verdict')).toHaveText(`Candidate verification ${result.status}`)
    await expect(final.locator('.captured-status__reason')).toHaveText(`${result.reason_code} ${result.message}`)
    await expect(final.locator('.captured-status__reason')).toBeVisible()
    const named = result.checks.filter((check) => check.status !== 'pass')
    if (named.length === 0) await expect(unsuccessful).toHaveCount(0)
    else await expect(unsuccessful).toHaveAttribute('data-unsuccessful', named.map((check) => check.check_id).join(' '))
  }
  await openWorkDetails(page)
  const rows = page.locator('tr.captured-check')
  await expect(rows).toHaveCount(10)
  expect(await rows.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.check))).toEqual([...CAPTURED_CHECK_IDS])
  for (const check of result.checks) {
    const row = page.locator(`tr.captured-check[data-check="${check.check_id}"]`)
    await expect(row).toHaveAttribute('data-status', check.status)
    await expect(row.locator('td').nth(1)).toHaveText(`${check.reason_code} ${check.message}`)
  }
  await expect(page.locator(`[data-candidate-digest="${result.candidate_patch_sha256}"]`)).toHaveText(result.candidate_patch_sha256.slice(0, 12))
  await expect(page.locator(`[data-baseline-commit="${result.baseline_commit}"]`)).toHaveText(result.baseline_commit.slice(0, 12))
  await expect(page.getByText('No model diagnosis or citations were evaluated in this verification.')).toBeVisible()

  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('form, .agent-gates, .agent-candidate, .agent-evidence, .proof-trail')).toHaveCount(0)
  const headings = await page.getByRole('heading').allInnerTexts()
  expect(headings.filter((heading) => LEGACY_SECTIONS.test(heading.trim()))).toEqual([])
  expect(await page.locator('body').innerText()).not.toMatch(/Verified Fix|Meta model|Fixture provider/i)
}

/** Subscribes the page to the run's live event stream right after the start. */
async function listenToRunEvents(page: Page, eventsUrl: string): Promise<void> {
  await page.evaluate(
    ({ url, types }) => {
      const scope = window as unknown as Record<string, unknown>
      const received: unknown[] = []
      scope.__flowproofCapturedEvents = received
      const source = new EventSource(url)
      scope.__flowproofCapturedSource = source
      for (const type of types) source.addEventListener(type, (event) => received.push(JSON.parse((event as MessageEvent<string>).data)))
    },
    { url: eventsUrl, types: [...STUDIO_EVENT_TYPES] },
  )
}

/** The live events the page received, once the run's final event arrived. */
async function receivedRunEvents(page: Page): Promise<StudioEvent[]> {
  const read = (): Promise<unknown[]> => page.evaluate(() => [...((window as unknown as Record<string, unknown[]>).__flowproofCapturedEvents ?? [])])
  await expect.poll(async () => (await read()).some((event) => (event as { type?: unknown }).type === 'run_finalized'), { timeout: 15_000 }).toBe(true)
  await page.evaluate(() => ((window as unknown as Record<string, EventSource>).__flowproofCapturedSource as EventSource).close())
  return (await read()).map((event) => {
    const parsed = parseStudioEvent(event)
    if (!parsed.ok) throw new Error('A live event violates the Studio event contract.')
    return parsed.value
  })
}

/** Only supported captured phases and non-model event types, bound to this run, with bounded messages. */
function expectCapturedEventDiscipline(events: readonly StudioEvent[], runId: string): void {
  expect(events.length).toBeGreaterThan(0)
  for (const event of events) {
    expect(event.run_id).toBe(runId)
    expect(['phase_started', 'agent_message', 'evidence_added', 'run_finalized']).toContain(event.type)
    expect(['initialized', 'reproducing', 'failure_captured', 'applying', 'replaying', 'finalized']).toContain(event.phase)
    expect(event.message.length).toBeLessThanOrEqual(500)
    for (const leak of ['/tmp', REPO_ROOT, 'diff --git']) expect(event.message).not.toContain(leak)
  }
  expect(events.at(-1)).toMatchObject({ type: 'run_finalized', phase: 'finalized' })
}

type MeasuredPhase = 'reproducing' | 'replaying'
const PRIOR_PHASE: Readonly<Record<MeasuredPhase, string>> = { reproducing: 'initialized', replaying: 'applying' }

/**
 * Each measured phase is announced only after the tracked frame navigated to that stage's build,
 * and its not-live preparation activity was reported before that navigation. The frame commits a
 * navigation before its load and trusted-probe readiness, which the launcher awaits before it
 * attests readiness, so the announcement can never precede the observed navigation. The stream is
 * live-only and the page subscribes after the start, so the run's first activity (the baseline
 * preparation) may precede the subscription; the candidate preparation is always delivered.
 */
function expectMeasuredPhasesAfterFrameLoad(events: readonly StudioEvent[], tracker: TargetFrameTracker, measured: readonly MeasuredPhase[]): void {
  const starts = events.filter((event) => event.type === 'phase_started' && (event.phase === 'reproducing' || event.phase === 'replaying'))
  expect(starts.map((event) => event.phase)).toEqual(measured)
  measured.forEach((phase, index) => {
    const start = events.findIndex((event) => event.type === 'phase_started' && event.phase === phase)
    const preparation = events[start - 1]
    const announced = events[start]
    const navigated = tracker.navigatedAt[index]
    if (announced === undefined || navigated === undefined) throw new Error(`The ${phase} phase has no announcement or frame navigation.`)
    expect(navigated).toBeLessThanOrEqual(Date.parse(announced.occurred_at))
    if (preparation === undefined && phase === 'reproducing' && start === 0) return
    expect(preparation).toMatchObject({ type: 'agent_message', phase: PRIOR_PHASE[phase], message: expect.stringMatching(/not live/i) })
    expect(Date.parse(preparation?.occurred_at ?? '')).toBeLessThanOrEqual(navigated)
  })
}

/** The result as the guarded Studio route serves it to the page. */
async function resultThroughStudioPage(page: Page, runId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/runs/${id}/result`)
    return { status: response.status, body: (await response.json()) as unknown }
  }, runId)
}

async function bundleAt(harness: CapturedStudioHarness, runId: string, phase: 'failure' | 'replay'): Promise<EvidenceBundle> {
  const parsed = parseEvidenceBundle(await harness.readJson(runId, `evidence/${phase}/manifest.json`))
  if (!parsed.ok) throw new Error(`The ${phase} manifest violates the evidence-bundle contract.`)
  expect(parsed.value).toMatchObject({ run_id: runId, scenario_id: CAPTURED_SCENARIO_ID, phase })
  return parsed.value
}

async function evidenceJson(harness: CapturedStudioHarness, runId: string, bundle: EvidenceBundle, type: string): Promise<Record<string, unknown>> {
  const item = bundle.items.find((candidate) => candidate.type === type)
  if (!item) throw new Error(`The ${bundle.phase} bundle has no ${type} evidence.`)
  return (await harness.readJson(runId, item.artifact_path)) as Record<string, unknown>
}

const checkRows = (result: CapturedVerificationResult): Array<[string, string, string]> => result.checks.map((check) => [check.check_id, check.status, check.reason_code])

/** The run identity: this run, this request, the prepared case and exactly the admitted candidate. */
function expectIdentity(result: CapturedVerificationResult, started: StartedRun, canvas: CanvasCandidate): void {
  const { capture, session } = canvas.result
  if (capture.status !== 'captured') throw new Error('The prepared case was not captured.')
  expect(result).toMatchObject({
    kind: 'captured-verification',
    run_id: started.run_id,
    request_id: started.request_id,
    scenario_id: CAPTURED_SCENARIO_ID,
    editing_session_id: capture.candidate.sessionId,
    baseline_commit: canvas.baselineCommit,
    candidate_patch_sha256: sha256(capture.candidate.patch),
  })
  expect(capture.candidate.sessionId).toBe(session.sessionId)
  expect(new Set([result.run_id, result.request_id, result.editing_session_id]).size).toBe(3)
  expect(result.checks.map((check) => check.check_id)).toEqual([...CAPTURED_CHECK_IDS])
}

/** Only the strict result and same-run evidence exist: no diagnosis, provider, prompt or diff artifact. */
async function expectNoModelArtifacts(harness: CapturedStudioHarness, runId: string): Promise<readonly string[]> {
  const entries = await listTree(harness.runRoot(runId))
  expect(entries.filter((entry) => entry !== 'result.json' && entry !== 'evidence' && !entry.startsWith('evidence/'))).toEqual([])
  return entries
}

/** The SHA-256 of what the still-open Studio page reads through one closed evidence route of the run. */
async function evidenceThroughStudioPage(page: Page, runId: string, evidenceId: string): Promise<{ readonly status: number; readonly type: string | null; readonly sha256: string }> {
  return page.evaluate(
    async ({ id, evidence }) => {
      const response = await fetch(`/api/runs/${id}/evidence/${evidence}`)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))
      return { status: response.status, type: response.headers.get('content-type'), sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
    },
    { id: runId, evidence: evidenceId },
  )
}

/**
 * Finalization released the target before it published the result and kept only the result shell:
 * exactly the tracked iframe element and frame were removed from the still-open Studio page after
 * the last evidence and the release activity and before the run finalized; the target app neither
 * serves nor listens; and the Studio page still reads every Evidence ID it was announced, through
 * the closed evidence route, as exactly the persisted artifact bytes.
 */
async function expectTargetReleased(harness: CapturedStudioHarness, tracker: TargetFrameTracker, events: readonly StudioEvent[], runId: string): Promise<void> {
  await tracker.expectReleased()
  const detachedAt = tracker.detachedAt() ?? Number.NaN
  const lastEvidence = events.filter((event) => event.type === 'evidence_added').at(-1)
  const release = events.find((event) => event.type === 'agent_message' && event.message.startsWith('Releasing the target'))
  const finalized = events.at(-1)
  if (lastEvidence === undefined || release === undefined || finalized?.type !== 'run_finalized') throw new Error('The run activity has no evidence, release or final event.')
  expect(Date.parse(lastEvidence.occurred_at)).toBeLessThanOrEqual(detachedAt)
  expect(Date.parse(release.occurred_at)).toBeLessThanOrEqual(detachedAt)
  expect(detachedAt).toBeLessThanOrEqual(Date.parse(finalized.occurred_at))
  expect(await demoPortListening()).toBe(false)

  const bundles = await Promise.all(
    (['failure', 'replay'] as const)
      .filter((phase) => events.some((event) => event.evidence_ids.some((id) => id.startsWith(`ev_${phase}_`))))
      .map((phase) => bundleAt(harness, runId, phase)),
  )
  const announced = events.flatMap((event) => event.evidence_ids)
  expect(announced.length).toBeGreaterThan(0)
  for (const evidenceId of announced) {
    const item = bundles.flatMap((bundle) => bundle.items).find((candidate) => candidate.evidence_id === evidenceId)
    if (item === undefined) throw new Error(`${evidenceId} is not in a persisted manifest of the run.`)
    const stored = sha256(await readFile(path.join(harness.runRoot(runId), item.artifact_path)))
    expect(await evidenceThroughStudioPage(harness.page, runId, evidenceId), evidenceId).toEqual({
      status: 200,
      type: item.type === 'screenshot' ? 'image/png' : 'application/json; charset=utf-8',
      sha256: stored,
    })
  }
}

/** The width and height a PNG declares in its IHDR chunk. */
const pngSize = (bytes: Buffer): { readonly width: number; readonly height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

/**
 * The target pane replaced the released frame with this run's captured evidence, labelled as
 * captured and not live. For each side the strict result records, it shows exactly the screenshot
 * Evidence ID that the run announced with that phase's manifest, loaded through the closed evidence
 * route as the persisted image; for a side the result does not record, it states that no evidence
 * was produced. Nothing in the pane is a frame, link, control or editable region, and the captured
 * surface restates the result's cleanup and original-integrity facts.
 */
async function expectCapturedEvidencePane(harness: CapturedStudioHarness, result: CapturedVerificationResult, events: readonly StudioEvent[], runId: string): Promise<void> {
  const pane = harness.page.locator('.target-pane')
  await expect(pane.locator('[data-target-presentation]')).toHaveText(PANE_LABELS['completed-evidence'] ?? '')
  const evidence = pane.locator('[data-captured-evidence]')
  await expect(evidence).toHaveAttribute('data-run-id', runId)
  const sides = [
    ['before', 'failure', result.before_evidence, 'No baseline evidence was produced in this run'],
    ['after', 'replay', result.after_evidence, 'No candidate replay evidence was produced in this run'],
  ] as const
  for (const [side, phase, reference, absent] of sides) {
    const figure = evidence.locator(`[data-evidence-side="${side}"]`)
    if (reference === null) {
      await expect(figure).toHaveAttribute('data-evidence-state', 'not-produced')
      await expect(figure).toContainText(absent)
      await expect(figure.locator('img')).toHaveCount(0)
      continue
    }
    const announced = [
      ...new Set(
        events
          .filter((event) => event.type === 'evidence_added' && event.artifact_refs.includes(reference.manifest_path))
          .flatMap((event) => event.evidence_ids)
          .filter((id) => id.startsWith(`ev_${phase}_screenshot_`)),
      ),
    ]
    expect(announced).toHaveLength(1)
    const evidenceId = announced[0] ?? ''
    await expect(figure).toHaveAttribute('data-evidence-state', 'available')
    await expect(figure).toContainText('Captured screenshot, not live')
    await expect(figure).toContainText(evidenceId)
    const image = figure.locator('img')
    await expect(image).toHaveCount(1)
    await expect(image).toHaveAttribute('src', `/api/runs/${runId}/evidence/${evidenceId}`)
    await expect(image).toHaveAttribute('data-evidence-id', evidenceId)
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    const stored = await readFile(path.join(harness.runRoot(runId), reference.screenshot_path))
    expect(await image.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, height: node.naturalHeight }))).toEqual(pngSize(stored))
  }
  await expect(pane.locator('iframe, a[href], input, select, textarea, button, [contenteditable], [tabindex="0"]')).toHaveCount(0)

  const cleanup = harness.page.locator('.captured-cleanup')
  await expect(cleanup).toHaveAttribute('data-cleanup-complete', String(result.cleanup.complete))
  await expect(cleanup).toHaveAttribute('data-original-unchanged', String(result.cleanup.original_unchanged))
}

function expectNothingLeft(harness: CapturedStudioHarness, cleanup: CleanupReport | undefined): void {
  expect(cleanup).toBeDefined()
  if (!cleanup) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
  expect(harness.blockedRequests).toEqual([])
}

interface CaseRun {
  readonly harness: CapturedStudioHarness
  readonly canvas: CanvasCandidate
  readonly tracker: TargetFrameTracker
  readonly started: StartedRun
  readonly result: CapturedVerificationResult
  /** The live events the Studio page received for this run. */
  readonly events: readonly StudioEvent[]
}

/** What the case's target pane must show live, and the name of its final Studio screenshot. */
interface PaneExpectation {
  readonly live: readonly ('baseline-live' | 'candidate-live')[]
  readonly screenshot: string
}

/** Lets the pane recorder take at least one more animation-frame sample. */
const nextFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/**
 * Produces the case's capture against the harness clone, launches the captured Studio, starts the
 * run with the Studio's own action while real user input is attempted on the target, and waits for
 * its strict result. `onPage` runs before the start, for example to route target loads. The pane is
 * checked against the recorded run, a final screenshot is saved as evidence, and the Studio is
 * always closed and its cleanup report returned.
 */
async function runCase(
  caseName: CanvasCase,
  expectation: PaneExpectation,
  check: (run: CaseRun) => Promise<void>,
  onPage: (page: Page) => Promise<void> = async () => undefined,
): Promise<{ readonly harness: CapturedStudioHarness; readonly cleanup: CleanupReport | undefined }> {
  let canvas: CanvasCandidate | undefined
  const harness = await openCapturedVerificationHarness({
    capture: async ({ repoRoot, tmpRoot }) => {
      canvas = await produceCanvasCandidate({ caseName, repositoryRoot: repoRoot, tmpRoot })
      expect(canvas.result.capture.status, JSON.stringify(canvas.result.capture)).toBe('captured')
      return canvas.result
    },
  })
  let cleanup: CleanupReport | undefined
  let tracker: TargetFrameTracker | undefined
  try {
    if (!canvas) throw new Error('The capture was not produced.')
    const { page } = harness
    // An uncaught Studio page error, for example a DOM operation on the released frame, fails the case.
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    tracker = await trackTargetFrame(page)
    await onPage(page)
    await recordTargetPane(page)
    const started = await startWithStudioAction(page)
    await listenToRunEvents(page, started.events_url)
    const attempts = await attemptUserInput(page)
    let finished: Awaited<ReturnType<CapturedStudioHarness['waitForCapturedResult']>>
    try {
      finished = await harness.waitForCapturedResult(RUN_BUDGET_MS)
    } finally {
      await attempts.stop()
    }
    const { runId, result } = finished
    expect(runId).toBe(started.run_id)
    const events = await receivedRunEvents(page)
    expectCapturedEventDiscipline(events, runId)
    // The guarded route serves exactly the persisted strict result, bound to this run.
    const served = (await resultThroughStudioPage(page, runId)) as { status: number; body: unknown }
    expect(served.status).toBe(200)
    expect(served.body).toEqual(result)
    expect(parseCapturedVerificationResult(served.body).ok).toBe(true)
    // The visible surface renders exactly that strict result.
    await expectCapturedSurface(page, result)
    // The pane is honestly not live once the run finalized: the live target was released.
    await expect(page.locator('[data-target-presentation]')).toHaveAttribute('data-target-presentation', 'completed-evidence')
    // Released before the result was published; only the guarded result shell is left until close.
    await expectTargetReleased(harness, tracker, events, runId)
    // The released frame was replaced by this run's captured evidence, with no Studio page error.
    await expectCapturedEvidencePane(harness, result, events, runId)
    expect(pageErrors).toEqual([])
    await nextFrames(page)
    expectGuardedPane(await paneRecording(page), attempts, expectation.live)
    await saveScreenshot(page, expectation.screenshot)
    // The ten check rows sit below the status in the scrolling side pane.
    await openWorkDetails(page)
    await page.locator('.captured-checks').scrollIntoViewIfNeeded()
    await saveScreenshot(page, expectation.screenshot.replace(/\.png$/, '-checks.png'))
    await check({ harness, canvas, tracker, started, result, events })
  } finally {
    await tracker?.stop()
    cleanup = await harness.close()
  }
  return { harness, cleanup }
}

test('canvas-fix is verified in the same Studio iframe and frame from the recorded baseline to the candidate', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  const live = { live: ['baseline-live', 'candidate-live'], screenshot: 'captured-verification-passed.png' } as const
  const { harness, cleanup } = await runCase('canvas-fix', live, async ({ harness: h, canvas, tracker, started, result, events }) => {
    expectIdentity(result, started, canvas)
    expect(result).toMatchObject({ status: 'passed', reason_code: null })
    expectMeasuredPhasesAfterFrameLoad(events, tracker, ['reproducing', 'replaying'])
    expect(checkRows(result).every(([, status]) => status === 'pass')).toBe(true)
    expect(result.cleanup).toEqual({ complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] })
    expect(result.before_evidence).toEqual({ manifest_path: 'evidence/failure/manifest.json', screenshot_path: 'evidence/failure/screenshot.png' })
    expect(result.after_evidence).toEqual({ manifest_path: 'evidence/replay/manifest.json', screenshot_path: 'evidence/replay/screenshot.png' })

    // The baseline evidence shows the prepared defect; the replay evidence matches the oracle.
    const failure = await bundleAt(h, started.run_id, 'failure')
    const replay = await bundleAt(h, started.run_id, 'replay')
    const failureDataset = (await evidenceJson(h, started.run_id, failure, 'dataset')).observed
    const replayDataset = (await evidenceJson(h, started.run_id, replay, 'dataset')).observed
    expect(failureDataset).not.toEqual(scenario.oracle.dataset)
    expect(replayDataset).toEqual(scenario.oracle.dataset)
    expect((await evidenceJson(h, started.run_id, replay, 'chart')).observed).toEqual(scenario.oracle.chart)
    for (const bundle of [failure, replay]) {
      expect(JSON.stringify((await evidenceJson(h, started.run_id, bundle, 'actions')).actions)).toContain(JSON.stringify(SELECT_ACTION.value))
    }

    // Exactly this iframe element and frame were driven, the baseline reconnect then the candidate,
    // until the run released them (no other frame came or went: see `expectTargetReleased`).
    expect(tracker.navigations).toEqual([TARGET_DOCUMENT, TARGET_DOCUMENT])
    // The observations in the result are what that frame showed, with the prepared select applied there before its release.
    expect(tracker.datasets).toContain(JSON.stringify(failureDataset))
    expect(tracker.datasets.at(-1)).toBe(JSON.stringify(replayDataset))
    expect(tracker.datasets.indexOf(JSON.stringify(failureDataset))).toBeLessThan(tracker.datasets.lastIndexOf(JSON.stringify(replayDataset)))
    expect((JSON.parse(tracker.states.at(-1) ?? 'null') as { selected_region?: unknown } | null)?.selected_region).toBe(SELECT_ACTION.value)

    await expectNoModelArtifacts(h, started.run_id)
  })
  expectNothingLeft(harness, cleanup)
})

test('canvas-plausible-wrong passes its build and check but fails the replay oracle in the same frame', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  const live = { live: ['baseline-live', 'candidate-live'], screenshot: 'captured-verification-failed-plausible-wrong.png' } as const
  const { harness, cleanup } = await runCase('canvas-plausible-wrong', live, async ({ harness: h, canvas, tracker, started, result, events }) => {
    expectIdentity(result, started, canvas)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED' })
    expectMeasuredPhasesAfterFrameLoad(events, tracker, ['reproducing', 'replaying'])
    const rows = Object.fromEntries(checkRows(result).map(([id, status, reason]) => [id, [status, reason]]))
    for (const id of ['input_valid', 'baseline_reproduced', 'application_complete', 'build_passed', 'tests_passed', 'secret_scan_clean', 'cleanup_complete', 'original_unchanged']) {
      expect(rows[id]?.[0], id).toBe('pass')
    }
    expect(rows.dataset_matches?.[0]).toBe('fail')
    expect(result.after_evidence).not.toBeNull()

    // A normal-looking chart was drawn from the wrong rows, in the tracked frame.
    const replay = await bundleAt(h, started.run_id, 'replay')
    const replayDataset = (await evidenceJson(h, started.run_id, replay, 'dataset')).observed
    expect(replayDataset).not.toEqual(scenario.oracle.dataset)
    expect(tracker.navigations).toEqual([TARGET_DOCUMENT, TARGET_DOCUMENT])
    expect(tracker.datasets.at(-1)).toBe(JSON.stringify(replayDataset))
    await expectNoModelArtifacts(h, started.run_id)
  })
  expectNothingLeft(harness, cleanup)
})

/** A fixed in-order delay of the Studio's own run-event deliveries; the release itself is not delayed. */
const STUDIO_EVENT_DELAY_MS = 300

/**
 * Delays every event the Studio's own run-event stream delivers by a fixed time, in order, while the
 * test listener's stream (opened from an evaluated script) stays native. The host still emits its
 * not-live activity before it removes the iframe; only the Studio learns it late, which is exactly
 * the delivery/release interleaving a slow SSE path produces.
 */
async function delayStudioRunEvents(page: Page): Promise<void> {
  await page.evaluate((delay) => {
    const Native = window.EventSource
    function Delayed(url: string | URL, init?: EventSourceInit): EventSource {
      const source = new Native(url, init)
      if (String(new Error().stack).includes('__playwright_evaluation_script__')) return source
      const wrapped = new WeakMap<object, EventListener>()
      const wrap = (listener: EventListenerOrEventListenerObject): EventListener => {
        let delayed = wrapped.get(listener)
        if (delayed === undefined) {
          delayed = (event: Event) => {
            setTimeout(() => (typeof listener === 'function' ? listener.call(source, event) : listener.handleEvent(event)), delay)
          }
          wrapped.set(listener, delayed)
        }
        return delayed
      }
      const add = source.addEventListener.bind(source)
      const remove = source.removeEventListener.bind(source)
      source.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => add(type, wrap(listener), options)) as EventSource['addEventListener']
      source.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) =>
        remove(type, wrapped.get(listener) ?? listener, options)) as EventSource['removeEventListener']
      for (const name of ['onmessage', 'onerror', 'onopen'] as const) {
        let current: EventListener | null = null
        Object.defineProperty(source, name, {
          get: () => current,
          set: (handler: EventListener | null) => {
            if (current !== null) remove(name.slice(2), wrap(current))
            current = handler
            if (handler !== null) add(name.slice(2), wrap(handler))
          },
        })
      }
      return source
    }
    Object.assign(Delayed, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
    Delayed.prototype = Native.prototype
    ;(window as unknown as { EventSource: unknown }).EventSource = Delayed
  }, STUDIO_EVENT_DELAY_MS)
}

test('a delayed Studio run-event stream never presents the physically released target frame as live', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  const live = { live: ['baseline-live', 'candidate-live'], screenshot: 'captured-verification-delayed-events.png' } as const
  const { cleanup } = await runCase(
    'canvas-plausible-wrong',
    live,
    async ({ result }) => {
      expect(result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED' })
    },
    delayStudioRunEvents,
  )
  expect(cleanup).toBeDefined()
})

test('canvas-build-fail stops before replay and never serves a candidate build to the frame', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  const live = { live: ['baseline-live'], screenshot: 'captured-verification-failed-build.png' } as const
  const { harness, cleanup } = await runCase('canvas-build-fail', live, async ({ harness: h, canvas, tracker, started, result, events }) => {
    expectIdentity(result, started, canvas)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED', after_evidence: null })
    // Only the baseline was ever announced live; no candidate build was loaded.
    expectMeasuredPhasesAfterFrameLoad(events, tracker, ['reproducing'])
    expect(events.some((event) => /candidate build into/i.test(event.message))).toBe(false)
    expect(checkRows(result)).toEqual([
      ['input_valid', 'pass', 'INPUT_ADMITTED'],
      ['baseline_reproduced', 'pass', 'BASELINE_REPRODUCED'],
      ['application_complete', 'pass', 'APPLICATION_COMPLETE'],
      ['build_passed', 'fail', 'BUILD_FAILED'],
      ['tests_passed', 'unevaluable', 'CHECK_NOT_EVALUATED'],
      ['dataset_matches', 'unevaluable', 'CHECK_NOT_EVALUATED'],
      ['canvas_matches', 'unevaluable', 'CHECK_NOT_EVALUATED'],
      ['secret_scan_clean', 'pass', 'SECRET_SCAN_CLEAN'],
      ['cleanup_complete', 'pass', 'CLEANUP_COMPLETE'],
      ['original_unchanged', 'pass', 'ORIGINAL_UNCHANGED'],
    ])
    // Only the baseline reached the frame; it still shows the recorded baseline observation.
    const failure = await bundleAt(h, started.run_id, 'failure')
    const failureDataset = (await evidenceJson(h, started.run_id, failure, 'dataset')).observed
    expect(tracker.navigations).toEqual([TARGET_DOCUMENT])
    expect(tracker.datasets.at(-1)).toBe(JSON.stringify(failureDataset))
    const entries = await expectNoModelArtifacts(h, started.run_id)
    expect(entries.some((entry) => entry.startsWith('evidence/replay'))).toBe(false)
  })
  expectNothingLeft(harness, cleanup)
})

test('a candidate frame that cannot load never yields a hidden replay or a passing result', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  let loads = 0
  const { harness, cleanup } = await runCase(
    'canvas-fix',
    { live: ['baseline-live'], screenshot: 'captured-verification-error-candidate-load.png' },
    async ({ harness: h, canvas, tracker, started, result, events }) => {
      expectIdentity(result, started, canvas)
      // The baseline loaded; the candidate reconnect was refused, as an unreachable target would be.
      expect(loads).toBe(2)
      // The candidate load was attempted as preparation, but its replay was never announced live.
      expectMeasuredPhasesAfterFrameLoad(events, tracker, ['reproducing'])
      expect(events.some((event) => event.type === 'agent_message' && event.phase === 'applying' && /not live/i.test(event.message))).toBe(true)
      expect(events.some((event) => event.phase === 'replaying')).toBe(false)
      expect(result).toMatchObject({ status: 'error', reason_code: 'VERIFICATION_ERROR', after_evidence: null })
      const rows = Object.fromEntries(checkRows(result).map(([id, status, reason]) => [id, [status, reason]]))
      expect(rows.tests_passed).toEqual(['pass', 'TESTS_PASSED'])
      expect(rows.dataset_matches).toEqual(['unevaluable', 'STAGE_ERROR'])
      expect(rows.canvas_matches).toEqual(['unevaluable', 'STAGE_ERROR'])
      expect(result.cleanup).toMatchObject({ complete: true, original_unchanged: true })
      const entries = await expectNoModelArtifacts(h, started.run_id)
      expect(entries.some((entry) => entry.startsWith('evidence/replay'))).toBe(false)
    },
    async (page) => {
      await page.route(
        (url) => url.href === TARGET_DOCUMENT,
        async (route) => {
          loads += 1
          if (loads === 1) await route.continue()
          else await route.abort('connectionrefused')
        },
      )
    },
  )
  expectNothingLeft(harness, cleanup)
})

test('closing the Studio while the candidate replay is held interrupts the run, which still finalizes and releases everything', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  let canvas: CanvasCandidate | undefined
  const harness = await openCapturedVerificationHarness({
    capture: async ({ repoRoot, tmpRoot }) => {
      canvas = await produceCanvasCandidate({ caseName: 'canvas-fix', repositoryRoot: repoRoot, tmpRoot })
      return canvas.result
    },
  })
  let cleanup: CleanupReport | undefined
  try {
    if (!canvas) throw new Error('The capture was not produced.')
    const { page } = harness
    const tracker = await trackTargetFrame(page)
    let loads = 0
    let markHeld: () => void = () => undefined
    const held = new Promise<void>((resolve) => (markHeld = resolve))
    // The baseline load passes; the candidate load never answers, holding the replay stage.
    await page.route(
      (url) => url.href === TARGET_DOCUMENT,
      async (route) => {
        loads += 1
        if (loads === 1) return route.continue()
        markHeld()
        await new Promise<never>(() => undefined)
      },
    )
    await recordTargetPane(page)
    const started = await startWithStudioAction(page)
    await held
    // The candidate load is held, so the run deterministically stays in its not-live preparation
    // while real user input is attempted on the target, which still shows the old baseline.
    const label = page.locator('[data-target-presentation]')
    await expect(label).toHaveAttribute('data-target-presentation', 'not-live')
    await expect(label).toHaveText('Preparation (not live)')
    await expect(page.locator('.target-pane__cover')).toHaveCount(1)
    await expect(page.locator('iframe')).toHaveAttribute('tabindex', '-1')
    const attempts = await attemptUserInput(page)
    await expect.poll(() => attempts.clicks, { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
    await attempts.stop()
    const recording = await paneRecording(page)
    const pointers = recording.inputs.filter((input) => input.type === 'pointerdown' && input.label !== 'preview')
    expect(pointers).toHaveLength(attempts.clicks)
    expect(pointers.every((input) => input.onCover && input.label === 'not-live')).toBe(true)
    expect(attempts.focusReachedFrame).toBe(false)
    await expect(label).toHaveAttribute('data-target-presentation', 'not-live')
    await saveScreenshot(page, 'captured-verification-preparation-held.png')
    // Closing first settles the tracker's probe call, which is waiting on the held navigation.
    await page.close()
    await tracker.stop()

    const { runId, result } = await harness.waitForCapturedResult(RUN_BUDGET_MS)
    expect(runId).toBe(started.run_id)
    expectIdentity(result, started, canvas)
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED', after_evidence: null })
    const rows = Object.fromEntries(checkRows(result).map(([id, status, reason]) => [id, [status, reason]]))
    for (const id of ['input_valid', 'baseline_reproduced', 'application_complete', 'build_passed', 'tests_passed']) expect(rows[id]?.[0], id).toBe('pass')
    expect(rows.dataset_matches).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
    expect(rows.canvas_matches).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
    expect(result.cleanup).toEqual({ complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] })
    const entries = await expectNoModelArtifacts(harness, runId)
    expect(entries.some((entry) => entry.startsWith('evidence/replay'))).toBe(false)
  } finally {
    cleanup = await harness.close()
  }
  expectNothingLeft(harness, cleanup)
})

test('closing the Studio itself while the candidate target load is held aborts that load, finalizes interrupted locally and releases everything', async () => {
  test.setTimeout(RUN_BUDGET_MS * 2)
  let canvas: CanvasCandidate | undefined
  const harness = await openCapturedVerificationHarness({
    capture: async ({ repoRoot, tmpRoot }) => {
      canvas = await produceCanvasCandidate({ caseName: 'canvas-fix', repositoryRoot: repoRoot, tmpRoot })
      return canvas.result
    },
  })
  let cleanup: CleanupReport | undefined
  let tracker: TargetFrameTracker | undefined
  try {
    if (!canvas) throw new Error('The capture was not produced.')
    const { page } = harness
    tracker = await trackTargetFrame(page)
    let loads = 0
    let markHeld: () => void = () => undefined
    const held = new Promise<void>((resolve) => (markHeld = resolve))
    // The baseline load passes; the candidate load never answers, so only an abort can end it early.
    await page.route(
      (url) => url.href === TARGET_DOCUMENT,
      async (route) => {
        loads += 1
        if (loads === 1) return route.continue()
        markHeld()
        await new Promise<never>(() => undefined)
      },
    )
    const started = await startWithStudioAction(page)
    await held
    await expect(page.locator('[data-target-presentation]')).toHaveAttribute('data-target-presentation', 'not-live')
    await tracker.expectSameFrame()

    // The existing close path, with the Studio page still open: the launcher closes it, not the user.
    const closing = Date.now()
    const closure = await harness.studio.close()
    const closedInMs = Date.now() - closing
    expect(closure).toEqual({ interruptedRun: true })
    // The abort released the frame, which ended the held load, while the Studio page was still open,
    // instead of waiting out the target reconnect's own bound.
    expect(tracker.detachedWhilePageOpen()).toBe(true)
    expect(tracker.detachedAt()).toBeGreaterThanOrEqual(closing)
    expect(closedInMs).toBeLessThan(DEFAULT_RECONNECT_TIMEOUT_MS / 2)
    // The candidate document never committed in the frame.
    expect(tracker.navigations).toEqual([TARGET_DOCUMENT])
    expect(loads).toBe(2)
    await tracker.stop()

    // The run had finalized locally before the close returned.
    const { runId, result } = await harness.waitForCapturedResult(1_000)
    expect(runId).toBe(started.run_id)
    expectIdentity(result, started, canvas)
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED', after_evidence: null })
    const rows = Object.fromEntries(checkRows(result).map(([id, status, reason]) => [id, [status, reason]]))
    for (const id of ['input_valid', 'baseline_reproduced', 'application_complete', 'build_passed', 'tests_passed']) expect(rows[id]?.[0], id).toBe('pass')
    expect(rows.dataset_matches).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
    expect(rows.canvas_matches).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
    expect(result.cleanup).toEqual({ complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] })
    const entries = await expectNoModelArtifacts(harness, runId)
    expect(entries.some((entry) => entry.startsWith('evidence/replay'))).toBe(false)
  } finally {
    await tracker?.stop()
    cleanup = await harness.close()
  }
  expectNothingLeft(harness, cleanup)
})
