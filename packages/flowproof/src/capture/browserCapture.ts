import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ConsoleMessage, Frame, Page, Request } from 'playwright'

import { EVIDENCE_PHASES, REDACTION_CATEGORIES } from '../contracts/index.js'
import type { EvidenceBundle, EvidenceItem, EvidencePhase, EvidenceType, Redaction } from '../contracts/index.js'
import type { EvidenceIdAllocator } from '../evidence/ids.js'
import { sanitizeArtifact, sanitizeConsoleEntries, sanitizeNetworkObservation, sanitizeSourceContent } from '../evidence/sanitize.js'
import type { RawNetworkObservation } from '../evidence/sanitize.js'
import { buildEvidenceBundle } from '../evidence/store.js'
import type { PersistedArtifact, RunArtifactStore } from '../evidence/store.js'
import { MAX_PROMPT_SOURCE_BYTES } from '../model/prompt.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'
import { callTrustedProbe } from '../studio/targetApp.js'
import type { TrustedProbeMethod } from '../studio/targetApp.js'

// Failure and replay capture from the visible Studio target frame. Each phase drives that frame
// with the committed scenario action, reads the dataset, chart series, and Canvas size from the
// trusted probe, takes a fixed-size Canvas screenshot, and drains the console and target-origin
// network observations recorded since the previous phase. The failure phase also reads the one
// permitted source file from the original HEAD. Page-controlled strings are bounded before they
// are sanitized, everything is sanitized before it is persisted, and Evidence IDs are issued and
// registered only for persisted sanitized artifacts. Network evidence keeps metadata only: no
// headers, cookies, bodies, query strings, or other origins.

const MAX_CONSOLE_ENTRIES = 200
const MAX_NETWORK_REQUESTS = 500
const MAX_PROBE_ITEMS = 1000
const MAX_PROBE_ROW_FIELDS = 32
/** The longest string the trusted probe may report: a region, dataset cell, or chart label. */
export const MAX_PROBE_STRING_LENGTH = 256
const NETWORK_SETTLE_MS = 2_000
const POLL_MS = 50
const GIT_TIMEOUT_MS = 10_000
const CANVAS_SELECTOR = 'canvas'
const ROW_KEY = /^[a-z][a-z0-9_]{0,63}$/

export type CaptureErrorCode =
  | 'CAPTURE_INPUT_INVALID'
  | 'CAPTURE_PHASE_REPEATED'
  | 'CAPTURE_BUSY'
  | 'CAPTURE_DISPOSED'
  | 'CAPTURE_FRAME_INVALID'
  | 'CAPTURE_ACTION_FAILED'
  | 'CAPTURE_PROBE_UNAVAILABLE'
  | 'CAPTURE_PROBE_INVALID'
  | 'CAPTURE_CANVAS_SIZE_MISMATCH'
  | 'CAPTURE_SCREENSHOT_FAILED'
  | 'CAPTURE_SOURCE_UNAVAILABLE'
  | 'CAPTURE_TIMEOUT'
  | 'CAPTURE_ABORTED'

/** A capture failure with a stable code; messages never echo page, network, or source content. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode

  constructor(code: CaptureErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'CaptureError'
    this.code = code
  }
}

export interface CapturedPhase {
  readonly phase: EvidencePhase
  /** The persisted, contract-valid bundle whose items are registered in the run store. */
  readonly bundle: EvidenceBundle
  /** `evidence/<phase>/manifest.json`, relative to the run directory. */
  readonly manifestPath: string
  /** The phase's Canvas screenshot, relative to the run directory. */
  readonly screenshotPath: string
  /** The sanitized values the trusted probe observed after the scenario actions. */
  readonly observed: { readonly dataset: unknown; readonly chart: unknown }
}

export interface CapturePhaseInput {
  readonly phase: EvidencePhase
  /** The target frame inside the Studio page; the same frame is driven and observed. */
  readonly frame: Frame
  readonly scenario: LoadedScenario
  readonly runId: string
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  /** Checkout holding the permitted source at the original HEAD (the detached worktree). */
  readonly sourceRoot: string
  /** Aborts the capture between steps, for example on a stage timeout. */
  readonly signal?: AbortSignal
}

export interface BrowserCapture {
  capturePhase(input: CapturePhaseInput): Promise<CapturedPhase>
  /** Detaches the console and network listeners. */
  dispose(): void
}

interface RecordedConsole {
  readonly level: string
  readonly text: string
  /** Origin of the emitting script; empty for evaluated code without a script URL. */
  readonly origin: string
}

interface ProbeState {
  readonly ready: boolean
  readonly selected_region: string
  readonly render_count: number
}

interface ChartObservation {
  readonly bar_count: number
  readonly labels: readonly string[]
  readonly values: readonly number[]
}

type ObservedRow = Readonly<Record<string, string | number>>

interface PhaseRecordings {
  readonly console: readonly RecordedConsole[]
  readonly consoleDropped: number
  readonly network: readonly RawNetworkObservation[]
  readonly networkDropped: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function originOf(url: string): string {
  if (url === '') return ''
  try {
    return new URL(url).origin
  } catch {
    return 'null'
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Sums counts per category in the contract's category order. */
function mergeRedactions(...lists: ReadonlyArray<readonly Redaction[]>): Redaction[] {
  const counts = new Map<string, number>()
  for (const list of lists) for (const { category, count } of list) counts.set(category, (counts.get(category) ?? 0) + count)
  return REDACTION_CATEGORIES.filter((category) => counts.has(category)).map((category) => ({ category, count: counts.get(category) ?? 0 }))
}

// ---------------------------------------------------------------------------------------
// Trusted probe reads (untrusted values, validated by shape and size before sanitization)
// ---------------------------------------------------------------------------------------

const probeString = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_PROBE_STRING_LENGTH

async function probe(frame: Frame, method: TrustedProbeMethod): Promise<unknown> {
  let reply
  try {
    reply = await callTrustedProbe(frame, method)
  } catch {
    throw new CaptureError('CAPTURE_PROBE_UNAVAILABLE', 'The trusted probe could not be read in the target frame.')
  }
  if (!reply.ok) throw new CaptureError('CAPTURE_PROBE_UNAVAILABLE', 'The trusted probe is missing or not ready.')
  return reply.value
}

const probeInvalid = (): CaptureError => new CaptureError('CAPTURE_PROBE_INVALID', 'The trusted probe returned an unexpected shape.')

function readState(value: unknown): ProbeState {
  if (!isPlainObject(value) || typeof value.ready !== 'boolean' || !probeString(value.selected_region)) throw probeInvalid()
  if (!Number.isInteger(value.render_count) || (value.render_count as number) < 0) throw probeInvalid()
  return { ready: value.ready, selected_region: value.selected_region, render_count: value.render_count as number }
}

function readDataset(value: unknown): ObservedRow[] {
  if (!Array.isArray(value) || value.length > MAX_PROBE_ITEMS) throw probeInvalid()
  return value.map((row: unknown) => {
    if (!isPlainObject(row)) throw probeInvalid()
    const entries = Object.entries(row)
    const scalar = (cell: unknown): boolean => probeString(cell) || (typeof cell === 'number' && Number.isFinite(cell))
    if (entries.length === 0 || entries.length > MAX_PROBE_ROW_FIELDS) throw probeInvalid()
    if (!entries.every(([key, cell]) => ROW_KEY.test(key) && scalar(cell))) throw probeInvalid()
    return Object.fromEntries(entries) as ObservedRow
  })
}

function readChart(value: unknown): ChartObservation {
  if (!isPlainObject(value)) throw probeInvalid()
  const { bar_count: barCount, labels, values } = value
  const valid =
    Number.isInteger(barCount) &&
    (barCount as number) >= 0 &&
    (barCount as number) <= MAX_PROBE_ITEMS &&
    Array.isArray(labels) &&
    labels.length <= MAX_PROBE_ITEMS &&
    labels.every(probeString) &&
    Array.isArray(values) &&
    values.length <= MAX_PROBE_ITEMS &&
    values.every((item) => typeof item === 'number' && Number.isFinite(item))
  if (!valid) throw probeInvalid()
  return { bar_count: barCount as number, labels: [...(labels as string[])], values: [...(values as number[])] }
}

function readCanvasSize(value: unknown): { readonly width: number; readonly height: number } {
  if (!isPlainObject(value) || !Number.isInteger(value.width) || !Number.isInteger(value.height)) throw probeInvalid()
  return { width: value.width as number, height: value.height as number }
}

// ---------------------------------------------------------------------------------------
// Original-HEAD source
// ---------------------------------------------------------------------------------------

const runGit = promisify(execFile)

// Git inherits no `GIT_*` overrides, credentials, or system configuration.
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
})

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await runGit('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'buffer',
    env: gitEnvironment(),
    maxBuffer: MAX_PROMPT_SOURCE_BYTES + 4096,
    timeout: GIT_TIMEOUT_MS,
  })
  return stdout
}

/** Reads the one permitted file from the checkout's HEAD commit, never from the working tree. */
async function readOriginalSource(sourceRoot: string, relative: string): Promise<{ readonly blobOid: string; readonly content: string }> {
  const unavailable = (): CaptureError =>
    new CaptureError('CAPTURE_SOURCE_UNAVAILABLE', 'The permitted source is not a text blob at the original HEAD.')
  let records: string[]
  try {
    records = (await gitBytes(sourceRoot, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', relative])).toString('utf8').split('\0').filter(Boolean)
  } catch {
    throw unavailable()
  }
  const match = records.length === 1 ? /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(records[0] ?? '') : null
  if (!match || match[3] !== relative) throw unavailable()
  const blobOid = match[2] ?? ''
  let bytes: Buffer
  try {
    bytes = await gitBytes(sourceRoot, ['cat-file', 'blob', blobOid])
  } catch {
    throw unavailable()
  }
  if (bytes.length > MAX_PROMPT_SOURCE_BYTES) throw unavailable()
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw unavailable()
  }
  return { blobOid, content }
}

// ---------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------

interface CollectedItem {
  readonly type: EvidenceType
  readonly capturedAt: string
  readonly summary: string
  readonly provenance: EvidenceItem['provenance']
  /** Redactions the type-specific sanitizer already applied before persistence. */
  readonly redactions: readonly Redaction[]
  readonly content: { readonly json: unknown } | { readonly png: Uint8Array }
}

const provenance = (
  mechanism: string,
  origin: EvidenceItem['provenance']['origin'],
  trusted: boolean,
  sourcePath: string | null = null,
): EvidenceItem['provenance'] => ({ mechanism, origin, trusted, source_path: sourcePath })

/** Attaches phase-scoped console and network recording to the Studio page and its frames. */
export function createBrowserCapture(page: Page): BrowserCapture {
  let consoleEntries: RecordedConsole[] = []
  let consoleDropped = 0
  let requests: RawNetworkObservation[] = []
  let requestsDropped = 0
  const inFlight = new Set<Request>()
  const recording = new Set<Promise<void>>()
  const capturedPhases = new Set<EvidencePhase>()
  let disposed = false
  let busy = false

  const onConsole = (message: ConsoleMessage): void => {
    if (consoleEntries.length >= MAX_CONSOLE_ENTRIES) {
      consoleDropped += 1
      return
    }
    consoleEntries.push({ level: message.type(), text: message.text(), origin: originOf(message.location().url) })
  }

  // Only the method, URL (reduced to origin and path when sanitized), status, MIME type, and
  // timing are ever read; request and response headers, cookies, and bodies are never touched.
  const record = async (request: Request, failed: boolean): Promise<void> => {
    try {
      let status = 0
      let mimeType: string | null = null
      if (!failed) {
        const response = await request.response()
        status = response?.status() ?? 0
        mimeType = (await response?.headerValue('content-type')) ?? null
      }
      const { responseEnd } = request.timing()
      if (requests.length >= MAX_NETWORK_REQUESTS) {
        requestsDropped += 1
        return
      }
      requests.push({ method: request.method(), url: request.url(), status, mime_type: mimeType, duration_ms: responseEnd >= 0 ? responseEnd : null })
    } catch {
      // The page or request went away while it was being recorded.
    } finally {
      inFlight.delete(request)
    }
  }

  const settle = (request: Request, failed: boolean): void => {
    const task: Promise<void> = record(request, failed).finally(() => recording.delete(task))
    recording.add(task)
  }
  const onRequest = (request: Request): void => {
    inFlight.add(request)
  }
  const onRequestFinished = (request: Request): void => settle(request, false)
  const onRequestFailed = (request: Request): void => settle(request, true)

  page.on('console', onConsole)
  page.on('request', onRequest)
  page.on('requestfinished', onRequestFinished)
  page.on('requestfailed', onRequestFailed)

  /** Lets target-origin requests settle, then hands over and resets the phase's recordings. */
  const drain = async (targetOrigin: string): Promise<PhaseRecordings> => {
    const settleBy = Date.now() + NETWORK_SETTLE_MS
    while ([...inFlight].some((request) => originOf(request.url()) === targetOrigin) && Date.now() < settleBy) await sleep(POLL_MS)
    await Promise.allSettled([...recording])
    const drained = { console: consoleEntries, consoleDropped, network: requests, networkDropped: requestsDropped }
    consoleEntries = []
    consoleDropped = 0
    requests = []
    requestsDropped = 0
    return drained
  }

  const capture = async (input: CapturePhaseInput): Promise<CapturedPhase> => {
    const { phase, frame, scenario, runId, store, allocator, sourceRoot, signal } = input
    const app = scenario.scenario.app
    const targetOrigin = new URL(app.url).origin
    const deadline = Date.now() + (phase === 'failure' ? scenario.scenario.timeouts.capture_ms : scenario.scenario.timeouts.replay_ms)
    const remaining = (): number => {
      if (signal?.aborted) throw new CaptureError('CAPTURE_ABORTED', 'The capture was aborted.')
      const left = deadline - Date.now()
      if (left <= 0) throw new CaptureError('CAPTURE_TIMEOUT', 'The capture exceeded its scenario timeout.')
      return left
    }
    const onTarget = (): void => {
      if (frame.isDetached() || originOf(frame.url()) !== targetOrigin) {
        throw new CaptureError('CAPTURE_FRAME_INVALID', 'The target frame is not showing the demo app.')
      }
    }
    const now = (): string => new Date().toISOString()
    const items: CollectedItem[] = []
    onTarget()

    // 1. The committed single action, driven in the visible target frame.
    const actions = scenario.actionsFor(phase)
    const [action] = actions
    if (actions.length !== 1 || action === undefined || action.type !== 'select') {
      throw new CaptureError('CAPTURE_INPUT_INVALID', 'The scenario must commit exactly one select action.')
    }
    const before = readState(await probe(frame, 'readState'))
    let selected: string[]
    try {
      selected = await frame.locator(action.selector).selectOption(action.value, { timeout: remaining() })
    } catch (error) {
      if (error instanceof CaptureError) throw error
      throw new CaptureError('CAPTURE_ACTION_FAILED', 'The committed scenario action could not be performed.')
    }
    if (selected.length !== 1 || selected[0] !== action.value) {
      throw new CaptureError('CAPTURE_ACTION_FAILED', 'The committed scenario action selected an unexpected option.')
    }
    for (;;) {
      const state = readState(await probe(frame, 'readState'))
      const rendered = before.selected_region === action.value || state.render_count > before.render_count
      if (state.ready && state.selected_region === action.value && rendered) break
      remaining()
      await sleep(POLL_MS)
    }
    onTarget()
    items.push({
      type: 'actions',
      capturedAt: now(),
      summary: `Performed ${actions.length} committed scenario action (${action.action_id}) in the target frame.`,
      provenance: provenance('committed-scenario-actions', 'scenario', true),
      redactions: [],
      content: { json: { actions } },
    })

    // 2-3. Observed rows and rendered chart series from the trusted probe.
    const rows = readDataset(await probe(frame, 'readDataset'))
    const observedRows = sanitizeArtifact(rows)
    items.push({
      type: 'dataset',
      capturedAt: now(),
      summary: `The trusted probe observed ${rows.length} filtered rows; the oracle lists ${scenario.oracle.dataset.length}.`,
      provenance: provenance('trusted-probe', 'browser', true),
      redactions: observedRows.redactions,
      content: { json: { expected: scenario.oracle.dataset, observed: observedRows.value } },
    })
    const chart = readChart(await probe(frame, 'readChartSeries'))
    const observedChart = sanitizeArtifact(chart)
    items.push({
      type: 'chart',
      capturedAt: now(),
      summary: `The trusted probe observed ${chart.bar_count} rendered bars.`,
      provenance: provenance('trusted-probe', 'browser', true),
      redactions: observedChart.redactions,
      content: { json: { observed: observedChart.value } },
    })

    // 4. The fixed-size Canvas screenshot, clipped to exactly the committed dimensions.
    const size = readCanvasSize(await probe(frame, 'readCanvasSize'))
    if (size.width !== app.canvas.width || size.height !== app.canvas.height) {
      throw new CaptureError('CAPTURE_CANVAS_SIZE_MISMATCH', 'The rendered Canvas does not have the committed size.')
    }
    let png: Buffer
    try {
      const canvas = frame.locator(CANVAS_SELECTOR)
      if ((await canvas.count()) !== 1) throw new CaptureError('CAPTURE_SCREENSHOT_FAILED', 'The target must render exactly one Canvas.')
      await canvas.scrollIntoViewIfNeeded({ timeout: remaining() })
      const box = await canvas.boundingBox({ timeout: remaining() })
      if (box === null || Math.abs(box.width - app.canvas.width) > 1 || Math.abs(box.height - app.canvas.height) > 1) {
        throw new CaptureError('CAPTURE_CANVAS_SIZE_MISMATCH', 'The framed Canvas does not have the committed size.')
      }
      // Rounded integer offsets keep the image at the committed size despite fractional layout.
      png = await page.screenshot({
        clip: { x: Math.round(box.x), y: Math.round(box.y), width: app.canvas.width, height: app.canvas.height },
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        type: 'png',
        timeout: remaining(),
      })
    } catch (error) {
      if (error instanceof CaptureError) throw error
      throw new CaptureError('CAPTURE_SCREENSHOT_FAILED', 'The Canvas screenshot could not be taken.')
    }
    onTarget()
    items.push({
      type: 'screenshot',
      capturedAt: now(),
      summary: `Fixed ${app.canvas.width}x${app.canvas.height} Canvas screenshot of the target frame.`,
      provenance: provenance('playwright-screenshot', 'browser', true),
      redactions: [],
      content: { png },
    })

    // 5-6. Console and target-origin network observations recorded since the previous phase.
    remaining()
    const drained = await drain(targetOrigin)
    const consoleSanitized = sanitizeConsoleEntries(
      drained.console.filter((entry) => entry.origin === '' || entry.origin === targetOrigin).map(({ level, text }) => ({ level, text })),
    )
    const errors = consoleSanitized.value.filter((entry) => entry.level === 'error').length
    items.push({
      type: 'console',
      capturedAt: now(),
      summary: `${consoleSanitized.value.length} target console entries (${errors} ${errors === 1 ? 'error' : 'errors'}), sanitized.`,
      provenance: provenance('playwright-console', 'browser', false),
      redactions: consoleSanitized.redactions,
      content: { json: { entries: consoleSanitized.value, dropped: drained.consoleDropped } },
    })
    const network = drained.network.filter((observation) => originOf(observation.url) === targetOrigin).map(sanitizeNetworkObservation)
    items.push({
      type: 'network',
      capturedAt: now(),
      summary: `${network.length} target-origin requests, metadata only.`,
      provenance: provenance('playwright-network-metadata', 'browser', true),
      redactions: mergeRedactions(...network.map((observation) => observation.redactions)),
      content: { json: { requests: network.map((observation) => observation.value), dropped: drained.networkDropped } },
    })

    // 7. Failure only: the one permitted source file from the original HEAD.
    if (phase === 'failure') {
      const [permitted] = scenario.scenario.permitted_source_paths
      if (permitted === undefined || scenario.scenario.permitted_source_paths.length !== 1) {
        throw new CaptureError('CAPTURE_INPUT_INVALID', 'The scenario must permit exactly one source file.')
      }
      remaining()
      const source = await readOriginalSource(sourceRoot, permitted)
      const content = sanitizeSourceContent(source.content)
      items.push({
        type: 'source',
        capturedAt: now(),
        summary: `The permitted source file at the original HEAD, blob ${source.blobOid}.`,
        provenance: provenance('git-object', 'repository', true, permitted),
        redactions: content.redactions,
        content: { json: { path: permitted, blob_oid: source.blobOid, content: content.value } },
      })
    }
    remaining()

    // Persist every sanitized artifact, then issue and register Evidence IDs in contract order.
    const persisted: Array<{ readonly item: CollectedItem; readonly artifact: PersistedArtifact }> = []
    for (const item of items) {
      const artifactPath = `evidence/${phase}/${item.type}.${'png' in item.content ? 'png' : 'json'}`
      const artifact =
        'png' in item.content ? await store.writePng(artifactPath, item.content.png) : await store.writeJson(artifactPath, item.content.json)
      persisted.push({ item, artifact })
    }
    const evidenceItems: EvidenceItem[] = persisted.map(({ item, artifact }) => {
      const evidenceId = allocator.allocate(phase, item.type)
      store.register(evidenceId, artifact)
      return {
        evidence_id: evidenceId,
        run_id: runId,
        phase,
        type: item.type,
        captured_at: item.capturedAt,
        artifact_path: artifact.artifact_path,
        sha256: artifact.sha256,
        summary: item.summary,
        provenance: item.provenance,
        redactions: mergeRedactions(item.redactions, artifact.redactions),
      }
    })
    const bundle = buildEvidenceBundle({ runId, scenarioId: scenario.scenario.scenario_id, phase, items: evidenceItems })
    const manifestPath = `evidence/${phase}/manifest.json`
    store.register(phase === 'failure' ? 'failure-manifest' : 'replay-manifest', await store.writeJson(manifestPath, bundle))
    const screenshot = evidenceItems.find((item) => item.type === 'screenshot')

    return Object.freeze({
      phase,
      bundle,
      manifestPath,
      screenshotPath: screenshot?.artifact_path ?? '',
      observed: Object.freeze({ dataset: observedRows.value, chart: observedChart.value }),
    })
  }

  return Object.freeze({
    async capturePhase(input: CapturePhaseInput): Promise<CapturedPhase> {
      if (disposed) throw new CaptureError('CAPTURE_DISPOSED', 'The browser capture was disposed.')
      validateInput(input, page)
      if (busy) throw new CaptureError('CAPTURE_BUSY', 'Another phase is being captured.')
      if (capturedPhases.has(input.phase)) throw new CaptureError('CAPTURE_PHASE_REPEATED', 'Each phase is captured once per run.')
      busy = true
      capturedPhases.add(input.phase)
      try {
        return await capture(input)
      } finally {
        busy = false
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      page.off('console', onConsole)
      page.off('request', onRequest)
      page.off('requestfinished', onRequestFinished)
      page.off('requestfailed', onRequestFailed)
      consoleEntries = []
      requests = []
      inFlight.clear()
    },
  })
}

function validateInput(input: CapturePhaseInput, page: Page): void {
  const invalid = (message: string): CaptureError => new CaptureError('CAPTURE_INPUT_INVALID', message)
  if (typeof input !== 'object' || input === null) throw invalid('Capture input is required.')
  const { phase, frame, scenario, runId, store, allocator, sourceRoot } = input
  if (!(EVIDENCE_PHASES as readonly unknown[]).includes(phase)) throw invalid('Unknown evidence phase.')
  if (typeof runId !== 'string' || store?.runId !== runId || allocator?.runId !== runId) {
    throw invalid('The store and Evidence ID allocator must belong to the run.')
  }
  if (typeof scenario?.actionsFor !== 'function') throw invalid('A loaded scenario is required.')
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw invalid('The source checkout must be an absolute path.')
  // Only the Studio page's target iframe is driven and observed.
  if (frame?.page() !== page || frame.isDetached() || frame.parentFrame() === null) {
    throw new CaptureError('CAPTURE_FRAME_INVALID', "Capture drives only the Studio page's attached target iframe.")
  }
}
