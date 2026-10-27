import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Frame, Page } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'

import { EVIDENCE_TYPES, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, EvidenceItem, EvidencePhase } from '../../packages/flowproof/src/contracts/index.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import type { EvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { canonicalJson, createRunArtifactStore, sha256Hex } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { acquireProcessLock, demoPortLockName } from '../support/processLock.js'
import type { ProcessLock } from '../support/processLock.js'
import { createTempClone, createTempDirectory, git, listTree } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T026: the seven-item failure and six-item replay capture contract that T037 implements in
// `packages/flowproof/src/capture/browserCapture.ts`. The trusted demo app is built into OS
// temporary output and served on its committed fixed `localhost` port, framed like the Studio
// target pane, and driven through Playwright. Seeded secrets are planted in console output and
// in a request query string; none may reach a persisted artifact.

export interface CapturedPhase {
  readonly phase: EvidencePhase
  /** The persisted, contract-valid bundle whose items are registered in the run store. */
  readonly bundle: EvidenceBundle
  /** `evidence/<phase>/manifest.json`, relative to the run directory. */
  readonly manifestPath: string
  /** The phase's Canvas screenshot, relative to the run directory. */
  readonly screenshotPath: string
  /** What the trusted probe observed after the scenario actions. */
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
}

export interface BrowserCapture {
  capturePhase(input: CapturePhaseInput): Promise<CapturedPhase>
  /** Detaches the console and network listeners. */
  dispose(): void
}

export interface BrowserCaptureModule {
  /** Attaches phase-scoped console and network recording to the Studio page and its frames. */
  createBrowserCapture(page: Page): BrowserCapture
}

const MODULE_PATH = 'packages/flowproof/src/capture/browserCapture.ts'
const captureModule = (): Promise<BrowserCaptureModule> =>
  loadPendingModule<BrowserCaptureModule>(MODULE_PATH, 'T037', ['createBrowserCapture'])

const SEEDED_CONSOLE = 'sk-flowproofseededcapture00001'
const SEEDED_QUERY = 'sk-flowproofseededcapture00002'
const SEEDED_REPLAY = 'sk-flowproofseededcapture00003'
const SEEDS = [SEEDED_CONSOLE, SEEDED_QUERY, SEEDED_REPLAY]
const PERMITTED_SOURCE = 'apps/demo-chart/src/filterData.ts'
const NETWORK_KEYS = ['duration_ms', 'method', 'mime_type', 'origin', 'path', 'status']
const CAPTURE_TIMEOUT = 180_000

interface Environment {
  readonly scenario: LoadedScenario
  readonly origin: string
  readonly browser: Browser
  readonly page: Page
  readonly frame: Frame
  readonly repo: TempDirectory
  readonly store: RunArtifactStore
  readonly runId: string
  readonly allocator: EvidenceIdAllocator
  readonly capture: BrowserCapture
}

let environment: Promise<Environment> | undefined
const teardown: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined)
})

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function serveStatic(root: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
      if (!file.startsWith(`${root}${path.sep}`)) return res.writeHead(400).end()
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      }
    })()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', () => resolve(server))
  })
}

/** Builds and serves the known-bad app, then frames it in a page like the Studio target pane. */
async function setUp(): Promise<Environment> {
  const capture = await captureModule()
  // The committed HEAD in a disposable clone supplies the app, scenario, source, and the run
  // artifact root; nothing is built or written in the developer's checkout.
  const repo = await createTempClone({ withDependencies: true })
  teardown.push(repo.remove)
  const scenario = await loadScenario('canvas-filter-hero', { repoRoot: repo.path })
  const appUrl = new URL(scenario.scenario.app.url)
  const port = Number(appUrl.port)

  const output = await createTempDirectory('flowproof-capture-build-')
  teardown.push(output.remove)
  execFileSync('pnpm', ['--filter', '@flowproof/demo-chart', 'exec', 'vite', 'build', '--outDir', output.path, '--emptyOutDir'], {
    cwd: repo.path,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const lock: ProcessLock = await acquireProcessLock(demoPortLockName(port))
  teardown.push(() => lock.release())
  const server = await serveStatic(output.path, port)
  teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const runId = randomUUID()
  const store = await createRunArtifactStore({ repoRoot: repo.path, runId })

  const browser = await chromium.launch()
  teardown.push(() => browser.close())
  const { viewport } = scenario.scenario.app
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.device_scale_factor,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  const recorder = capture.createBrowserCapture(page)
  teardown.push(async () => recorder.dispose())

  await page.setContent(
    `<!doctype html><html><body style="margin:0"><iframe id="target" src="${appUrl.href}" width="${viewport.width}" height="${viewport.height}"></iframe></body></html>`,
  )
  const frame = await (await page.waitForSelector('#target')).contentFrame()
  if (!frame) throw new Error('The target frame did not attach.')
  await frame.waitForFunction(() => (window as { __flowproofProbe?: { isReady(): boolean } }).__flowproofProbe?.isReady() === true)

  return {
    scenario,
    origin: appUrl.origin,
    browser,
    page,
    frame,
    repo,
    store,
    runId,
    allocator: createEvidenceIdAllocator(runId),
    capture: recorder,
  }
}

const env = (): Promise<Environment> => (environment ??= setUp())

const runRoot = (e: Environment): string => path.join(e.repo.path, '.flowproof', 'runs', e.runId)

const readJson = async (e: Environment, relative: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(runRoot(e), relative), 'utf8')) as unknown

const itemOf = (bundle: EvidenceBundle, type: string): EvidenceItem => {
  const item = bundle.items.find((candidate) => candidate.type === type)
  if (!item) throw new Error(`The ${bundle.phase} bundle has no ${type} item.`)
  return item
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function expectPersistedBundle(e: Environment, captured: CapturedPhase, phase: EvidencePhase): Promise<void> {
  expect(captured.phase).toBe(phase)
  expect(parseEvidenceBundle(captured.bundle).ok).toBe(true)
  expect(captured.bundle.run_id).toBe(e.runId)
  expect(captured.bundle.scenario_id).toBe('canvas-filter-hero')

  // Deterministic item order and identifiers: one item per type, ordinal 001.
  const expectedTypes = EVIDENCE_TYPES.filter((type) => phase === 'failure' || type !== 'source')
  expect(captured.bundle.items.map((item) => item.type)).toEqual(expectedTypes)
  expect(captured.bundle.items.map((item) => item.evidence_id)).toEqual(expectedTypes.map((type) => `ev_${phase}_${type}_001`))

  // The manifest is persisted, registered, and hashes canonical item metadata.
  expect(captured.manifestPath).toBe(`evidence/${phase}/manifest.json`)
  expect(await readJson(e, captured.manifestPath)).toEqual(captured.bundle)
  expect(captured.bundle.manifest_sha256).toBe(sha256Hex(canonicalJson(captured.bundle.items)))
  const manifestName = phase === 'failure' ? 'failure-manifest' : 'replay-manifest'
  await expect(e.store.read(manifestName)).resolves.toEqual(await readFile(path.join(runRoot(e), captured.manifestPath)))

  for (const item of captured.bundle.items) {
    expect(item.run_id).toBe(e.runId)
    expect(item.phase).toBe(phase)
    expect(item.artifact_path.startsWith(`evidence/${phase}/`)).toBe(true)
    // Persisted, registered, and hashed over the exact sanitized bytes on disk.
    expect(e.store.hasEvidence(item.evidence_id)).toBe(true)
    const bytes = await readFile(path.join(runRoot(e), item.artifact_path))
    expect(item.sha256).toBe(sha256Hex(bytes))
    await expect(e.store.read(item.evidence_id)).resolves.toEqual(bytes)
    expect(item.provenance.origin).toBe(item.type === 'actions' ? 'scenario' : item.type === 'source' ? 'repository' : 'browser')
    expect(item.provenance.source_path).toBe(item.type === 'source' ? PERMITTED_SOURCE : null)
  }

  const shot = await readFile(path.join(runRoot(e), captured.screenshotPath))
  expect(captured.screenshotPath).toBe(itemOf(captured.bundle, 'screenshot').artifact_path)
  // Exactly the committed Canvas size for both phases; the screenshot is review evidence only.
  // The framed canvas sits at a fractional offset, so an unclipped element screenshot can gain a row.
  expect(pngSize(shot)).toEqual(e.scenario.scenario.app.canvas)
}

async function expectNoSeededSecrets(e: Environment): Promise<void> {
  for (const relative of await listTree(runRoot(e))) {
    const bytes = await readFile(path.join(runRoot(e), relative)).catch(() => null)
    if (bytes === null) continue
    for (const seed of SEEDS) expect(bytes.includes(seed), `${relative} leaks a seeded secret`).toBe(false)
  }
}

let failure: CapturedPhase | undefined

describe('browser capture against the built demo app', () => {
  it(
    'captures the seven-item failure bundle from the framed known-bad app',
    async () => {
      const e = await env()
      // Seeded runtime noise inside the target: a credential in console output and a query string.
      await e.frame.evaluate(
        ([consoleSeed, querySeed]) => {
          console.error(`Authorization: Bearer ${consoleSeed}`)
          return fetch(`/flowproof-seeded-probe?token=${querySeed}`).then(async (response) => (await response.text(), response.status))
        },
        [SEEDED_CONSOLE, SEEDED_QUERY],
      )

      failure = await e.capture.capturePhase({
        phase: 'failure',
        frame: e.frame,
        scenario: e.scenario,
        runId: e.runId,
        store: e.store,
        allocator: e.allocator,
        sourceRoot: e.repo.path,
      })

      await expectPersistedBundle(e, failure, 'failure')
      expect(failure.bundle.items).toHaveLength(7)

      // Reproduction actions are the committed scenario actions, verbatim.
      expect(await readJson(e, itemOf(failure.bundle, 'actions').artifact_path)).toMatchObject({
        actions: e.scenario.scenario.actions,
      })

      // Expected and observed filtered data; the known-bad filter keeps Northeast rows.
      const dataset = (await readJson(e, itemOf(failure.bundle, 'dataset').artifact_path)) as {
        expected: unknown
        observed: Array<{ region: string }>
      }
      expect(dataset.expected).toEqual(e.scenario.oracle.dataset)
      expect(dataset.observed).toHaveLength(8)
      expect(new Set(dataset.observed.map((row) => row.region))).toEqual(new Set(['North', 'Northeast']))
      expect(failure.observed.dataset).toEqual(dataset.observed)

      // Rendered chart series from the trusted probe, not from the patchable source.
      const probeSeries = await e.frame.evaluate(() =>
        (window as { __flowproofProbe?: { readChartSeries(): unknown } }).__flowproofProbe?.readChartSeries(),
      )
      const chart = (await readJson(e, itemOf(failure.bundle, 'chart').artifact_path)) as { observed: unknown }
      expect(chart.observed).toEqual(probeSeries)
      expect(chart.observed).toMatchObject({ bar_count: 8 })
      expect(failure.observed.chart).toEqual(probeSeries)

      // Console evidence keeps the entry but redacts the credential and counts the redaction.
      const consoleItem = itemOf(failure.bundle, 'console')
      expect(JSON.stringify(await readJson(e, consoleItem.artifact_path))).toContain('Authorization')
      expect(consoleItem.redactions.some((redaction) => redaction.category === 'credential')).toBe(true)

      // Network evidence is metadata-only, from the target origin, and query-free.
      const networkItem = itemOf(failure.bundle, 'network')
      const network = (await readJson(e, networkItem.artifact_path)) as { requests: Array<Record<string, unknown>> }
      expect(network.requests.length).toBeGreaterThan(0)
      for (const request of network.requests) {
        expect(Object.keys(request).sort()).toEqual(NETWORK_KEYS)
        expect(request.origin).toBe(e.origin)
        expect(String(request.path)).not.toContain('?')
      }
      expect(network.requests).toContainEqual(expect.objectContaining({ method: 'GET', path: '/flowproof-seeded-probe', status: 404 }))
      expect(networkItem.redactions.some((redaction) => redaction.category === 'query')).toBe(true)

      // Exactly the permitted source file at the original HEAD, with its captured blob hash.
      const source = (await readJson(e, itemOf(failure.bundle, 'source').artifact_path)) as Record<string, unknown>
      expect(source).toMatchObject({
        path: PERMITTED_SOURCE,
        blob_oid: git(e.repo.path, 'rev-parse', `HEAD:${PERMITTED_SOURCE}`).trim(),
        content: await readFile(path.join(e.repo.path, PERMITTED_SOURCE), 'utf8'),
      })

      await expectNoSeededSecrets(e)
    },
    CAPTURE_TIMEOUT,
  )

  it(
    'captures the six-item replay bundle with the identical actions after the frame reconnects',
    async () => {
      const e = await env()
      if (!failure) throw new Error('The failure capture did not complete.')
      // Reconnect the target frame, as the Studio does after swapping the served build.
      await e.frame.goto(e.scenario.scenario.app.url)
      await e.frame.waitForFunction(() => (window as { __flowproofProbe?: { isReady(): boolean } }).__flowproofProbe?.isReady() === true)
      await e.frame.evaluate((seed) => console.error(`replay token=${seed}`), SEEDED_REPLAY)

      const replay = await e.capture.capturePhase({
        phase: 'replay',
        frame: e.frame,
        scenario: e.scenario,
        runId: e.runId,
        store: e.store,
        allocator: e.allocator,
        sourceRoot: e.repo.path,
      })

      await expectPersistedBundle(e, replay, 'replay')
      expect(replay.bundle.items).toHaveLength(6)
      expect(replay.bundle.items.some((item) => item.type === 'source')).toBe(false)

      // Failure and replay use the identical committed actions.
      expect(await readJson(e, itemOf(replay.bundle, 'actions').artifact_path)).toEqual(
        await readJson(e, itemOf(failure.bundle, 'actions').artifact_path),
      )

      // Console evidence is scoped to its phase.
      const replayConsole = JSON.stringify(await readJson(e, itemOf(replay.bundle, 'console').artifact_path))
      expect(replayConsole).toContain('replay token=')
      expect(replayConsole).not.toContain('Authorization')

      // Failure evidence stays registered and readable after the replay capture.
      for (const item of failure.bundle.items) expect(e.store.hasEvidence(item.evidence_id)).toBe(true)
      expect(replay.screenshotPath).not.toBe(failure.screenshotPath)
      await expectNoSeededSecrets(e)
    },
    CAPTURE_TIMEOUT,
  )
})
