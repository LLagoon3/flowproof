import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { chromium } from 'playwright'
import type { Frame, Page } from 'playwright'

import { createBrowserCapture } from '../capture/browserCapture.js'
import type { BrowserCapture } from '../capture/browserCapture.js'
import type { ChatRequest, EvidenceBundle, EvidenceType, RunResult } from '../contracts/index.js'
import { createEvidenceIdAllocator } from '../evidence/ids.js'
import { createOsTempOutput, createRunArtifactStore } from '../evidence/store.js'
import type { RunArtifactStore, TempOutput, TempOutputPurpose } from '../evidence/store.js'
import { buildDiagnosisPrompt } from '../model/prompt.js'
import type { DiagnosisPromptInput } from '../model/prompt.js'
import { selectTransport } from '../model/transport.js'
import type { ModelTransport } from '../model/transport.js'
import { validateCandidate } from '../patch/validateDiff.js'
import { executeRun } from '../run.js'
import type { RunStagePorts } from '../run.js'
import { ScenarioLoadError, loadScenario } from '../scenario/loadScenario.js'
import type { LoadedScenario, ScenarioLoadErrorCode } from '../scenario/loadScenario.js'
import { SCENARIO_REGISTRY } from '../scenario/registry.js'
import { createWorktreeSession } from '../worktree/session.js'
import type { WorktreeSession } from '../worktree/session.js'
import { createRunEventStream } from './events.js'
import { startStudioServer } from './server.js'
import type { StudioRunHandle, StudioRunStart } from './server.js'
import { DEFAULT_RECONNECT_TIMEOUT_MS, TargetAppError, startTargetApp, trustedProbeReady } from './targetApp.js'
import type { TargetApp, TargetAppErrorCode, TargetBuilder } from './targetApp.js'

// The in-process Studio launcher behind `flowproof studio` and the end-to-end harness. It loads the
// selected (or first registered) committed case, binds the fixed-port `localhost` target app,
// builds the Studio bundle and the prepared preview through their package build scripts into OS
// temporary output, serves the bundle from the guarded `127.0.0.1` Studio server, and opens one
// page in the pinned headed Chromium with the launch cookie injected before navigation. Accepted
// start requests run the engine against that page's target iframe and a detached worktree. Every
// owned resource is released in reverse order on close or on a failed startup. Closing the Studio
// page or browser, or an interrupt that closes the Studio, interrupts an active run: its running
// stage is cancelled, and it finalizes as `Unverified` with its worktree removed and pruned before
// anything is released; the close reports that it interrupted the run. An event-stream
// disconnect alone never closes the Studio. `testTransport` reaches only the server's transport
// selection in this process and is never serialized or logged.

export interface StartStudioOptions {
  readonly repoRoot: string
  /** A committed case to load at launch; omitted or null loads the first registered case for the prepared app. */
  readonly scenarioId?: string | null
  /** The only way to replace the model transport; never reachable from the CLI or the API. */
  readonly testTransport?: ModelTransport
}

/** The machine-readable launch object; the launch credential is never part of it. */
export interface StudioLaunchJson {
  readonly mode: 'studio'
  readonly origin: string
  readonly session_id: string
}

/** How the Studio closed. */
export interface StudioClosure {
  /** True when closing interrupted a run that had not finalized; that run then finalized as `Unverified`. */
  readonly interruptedRun: boolean
}

export interface StudioInstance {
  /** Exact Studio origin, `http://127.0.0.1:<ephemeral port>`. */
  readonly origin: string
  readonly sessionId: string
  /** The single Studio page, with the target iframe and the agent pane. */
  readonly page: Page
  /**
   * Interrupts an active run, waits for it to finalize, then releases every owned resource.
   * Idempotent: every call shares the first close and its closure. Rejects when a run could not
   * be finalized safely or a resource could not be released.
   */
  close(): Promise<StudioClosure>
  toJSON(): StudioLaunchJson
}

export type StudioLaunchErrorCode =
  | 'STUDIO_OPTIONS_INVALID'
  | 'STUDIO_START_FAILED'
  | 'SCENARIO_UNAVAILABLE'
  | 'TARGET_APP_FAILED'
  | 'STUDIO_BUILD_FAILED'
  | 'PREVIEW_BUILD_FAILED'
  | 'STUDIO_SERVER_FAILED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'STUDIO_PAGE_FAILED'
  | 'STUDIO_RUN_UNAVAILABLE'
  | 'STUDIO_RUN_INPUT_INVALID'
  | 'STUDIO_CLOSED'
  | 'STUDIO_RUN_FINALIZE_FAILED'
  | 'STUDIO_CLEANUP_INCOMPLETE'
  | ScenarioLoadErrorCode
  | TargetAppErrorCode

/** A launch or lifecycle failure with a stable code; messages never echo paths, values, or foreign errors. */
export class StudioLaunchError extends Error {
  readonly code: StudioLaunchErrorCode

  constructor(code: StudioLaunchErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'StudioLaunchError'
    this.code = code
  }
}

const OPTION_KEYS = new Set(['repoRoot', 'scenarioId', 'testTransport'])
const READY_TIMEOUT_MS = DEFAULT_RECONNECT_TIMEOUT_MS
const BUILD_TIMEOUT_MS = 120_000
const PROBE_POLLING_MS = 50
// The same allowlist as the worktree build: no credential reaches a build.
const BUILD_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'COREPACK_HOME', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'] as const

interface LaunchOptions {
  readonly repoRoot: string
  readonly scenarioId: string | null
  readonly testTransport: ModelTransport | undefined
}

function readOptions(options: unknown): LaunchOptions {
  const invalid = (message: string): StudioLaunchError => new StudioLaunchError('STUDIO_OPTIONS_INVALID', message)
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw invalid('Launch options are required.')
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !OPTION_KEYS.has(key))) {
    throw invalid('The Studio accepts only repoRoot, scenarioId, and testTransport.')
  }
  const { repoRoot, scenarioId, testTransport } = options as Readonly<Record<string, unknown>>
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) throw invalid('The repository root must be an absolute path.')
  if (scenarioId !== undefined && scenarioId !== null && typeof scenarioId !== 'string') {
    throw invalid('scenarioId must name a committed case.')
  }
  return { repoRoot, scenarioId: scenarioId ?? null, testTransport: testTransport as ModelTransport | undefined }
}

/** Maps a failure to its stable code: coded scenario and target errors keep theirs, anything else gets the step's. */
function launchError(error: unknown, code: StudioLaunchErrorCode, message: string): StudioLaunchError {
  if (error instanceof StudioLaunchError) return error
  if (error instanceof ScenarioLoadError) return new StudioLaunchError(error.code, 'The committed case could not be loaded.')
  if (error instanceof TargetAppError) return new StudioLaunchError(error.code, 'The prepared application could not be served.')
  return new StudioLaunchError(code, message)
}

async function step<T>(code: StudioLaunchErrorCode, message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw launchError(error, code, message)
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The process group already exited.
  }
}

/**
 * Runs the package's own `build` script into `outDir` without a shell, in its own process group,
 * with an allowlisted environment and discarded output. The `runner` config loader keeps Vite from
 * writing a bundled config file into the original checkout's `node_modules`, and a disabled Node
 * compile cache keeps the build from leaving a cache directory in the temporary root.
 */
function buildPackage(repoRoot: string, packageName: '@flowproof/studio' | '@flowproof/demo-chart', outDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
    for (const key of BUILD_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
    const args = ['--filter', packageName, 'run', 'build', '--outDir', outDir, '--emptyOutDir', '--configLoader', 'runner']
    const child = spawn('pnpm', args, { cwd: repoRoot, env, stdio: 'ignore', detached: true, shell: false })
    let failed = false
    const timer = setTimeout(() => {
      failed = true
      killGroup(child.pid)
    }, BUILD_TIMEOUT_MS)
    child.once('error', () => {
      failed = true
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(!failed && code === 0)
    })
  })
}

/** The Studio page's one target iframe: the frame every run stage drives and observes. */
async function studioTargetFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const invalid = (): StudioLaunchError => new StudioLaunchError('STUDIO_PAGE_FAILED', 'The Studio page must hold exactly one target frame.')
  const iframes = page.locator('iframe')
  await iframes.first().waitFor({ state: 'attached', timeout: timeoutMs })
  if ((await iframes.count()) !== 1) throw invalid()
  const element = await iframes.elementHandle({ timeout: timeoutMs })
  try {
    const frame = await element.contentFrame()
    if (frame === null || frame.parentFrame() !== page.mainFrame()) throw invalid()
    return frame
  } finally {
    await element.dispose()
  }
}

/** Ready when the target iframe shows the served preview and its trusted probe reports a chart. */
async function waitForPreview(page: Page, target: TargetApp, deadline: number): Promise<void> {
  const remaining = (): number => Math.max(1, deadline - Date.now())
  const frame = await studioTargetFrame(page, remaining())
  await frame.waitForURL((url) => url.origin === target.origin, { waitUntil: 'load', timeout: remaining() })
  const handle = await frame.waitForFunction(trustedProbeReady, undefined, { timeout: remaining(), polling: PROBE_POLLING_MS })
  const ready = await handle.jsonValue()
  await handle.dispose()
  if (ready !== true) throw new StudioLaunchError('STUDIO_PAGE_FAILED', 'The prepared preview did not become ready.')
}

/** One persisted failure artifact, read back through the run store, as a JSON object. */
async function readFailureJson(store: RunArtifactStore, bundle: EvidenceBundle, type: EvidenceType): Promise<Readonly<Record<string, unknown>>> {
  const invalid = (): StudioLaunchError => new StudioLaunchError('STUDIO_RUN_INPUT_INVALID', 'The failure evidence is not readable.')
  const item = bundle.items.find((candidate) => candidate.type === type)
  if (item === undefined) throw invalid()
  const value: unknown = JSON.parse((await store.read(item.evidence_id)).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  return value as Readonly<Record<string, unknown>>
}

/** The observed failure values (never the dataset artifact's expected rows) and the permitted source. */
async function readDiagnosisInputs(
  store: RunArtifactStore,
  bundle: EvidenceBundle,
): Promise<Pick<DiagnosisPromptInput, 'observations' | 'source'>> {
  const read = (type: EvidenceType): Promise<Readonly<Record<string, unknown>>> => readFailureJson(store, bundle, type)
  const source = await read('source')
  if (typeof source.path !== 'string' || typeof source.content !== 'string') {
    throw new StudioLaunchError('STUDIO_RUN_INPUT_INVALID', 'The failure evidence is not readable.')
  }
  return {
    observations: {
      actions: (await read('actions')).actions,
      dataset: (await read('dataset')).observed,
      chart: (await read('chart')).observed,
      console: await read('console'),
      network: await read('network'),
    },
    source: { path: source.path, content: source.content },
  }
}

interface RunWiring {
  readonly page: Page
  readonly target: TargetApp
  readonly worktree: WorktreeSession
  readonly capture: BrowserCapture
  readonly request: ChatRequest
  readonly transport: ModelTransport
}

/**
 * The run engine's stages, bound to the Studio page's target iframe, the target app, and the
 * worktree. Each stage's signal also aborts when the run is interrupted, which stops a worktree
 * build, the capture, and the model call.
 */
function createRunPorts({ page, target, worktree, capture, request, transport }: RunWiring): RunStagePorts {
  const builder = (signal: AbortSignal): TargetBuilder => ({ build: () => worktree.build({ signal }) })
  return {
    reproduce: async (context) => {
      await target.serveBuild('known-bad', builder(context.signal))
      const frame = await studioTargetFrame(page, READY_TIMEOUT_MS)
      await target.reconnect(frame)
      const { scenario, runId, store, allocator, signal } = context
      return capture.capturePhase({ phase: 'failure', frame, scenario, runId, store, allocator, sourceRoot: worktree.path, signal })
    },
    diagnose: async (context, failure) => {
      const { scenario } = context.scenario
      const prompt = buildDiagnosisPrompt({
        runId: context.runId,
        goal: request.text,
        failureBundle: failure.bundle,
        permittedSourcePaths: scenario.permitted_source_paths,
        ...(await readDiagnosisInputs(context.store, failure.bundle)),
      })
      const output = await transport.diagnose(prompt, { signal: context.signal, timeoutMs: scenario.timeouts.model_ms })
      return { prompt, output }
    },
    validate: (context, { diagnosis, failure }) =>
      validateCandidate({
        runId: context.runId,
        diagnosis,
        failureBundle: failure.bundle,
        permittedSourcePaths: context.scenario.scenario.permitted_source_paths,
        checkoutRoot: worktree.path,
      }),
    apply: async (context, candidate) => {
      await worktree.applyDiff(candidate.unified_diff)
      await target.serveBuild('patched', builder(context.signal))
    },
    replay: async (context) => {
      const frame = await studioTargetFrame(page, READY_TIMEOUT_MS)
      await target.reconnect(frame)
      const { scenario, runId, store, allocator, signal } = context
      return capture.capturePhase({ phase: 'replay', frame, scenario, runId, store, allocator, sourceRoot: worktree.path, signal })
    },
    // Never cancelled: the worktree is removed, pruned, and compared on every exit.
    cleanup: async () => {
      capture.dispose()
      return worktree.dispose()
    },
  }
}

async function tempBuild(
  repoRoot: string,
  purpose: Extract<TempOutputPurpose, 'studio-build' | 'preview-build'>,
  owned: Array<() => Promise<void>>,
): Promise<TempOutput> {
  const output = await createOsTempOutput({ purpose, repoRoot })
  owned.push(() => output.remove())
  const packageName = purpose === 'studio-build' ? '@flowproof/studio' : '@flowproof/demo-chart'
  if (!(await buildPackage(repoRoot, packageName, output.path))) throw new Error('build failed')
  return output
}

/**
 * Launches the Studio for one repository: the guarded `127.0.0.1` server, the fixed-port target
 * app serving the prepared preview, and one headed Chromium page holding the target iframe and the
 * agent pane. A failed startup releases everything it acquired and throws `StudioLaunchError`.
 */
export async function startStudio(options: StartStudioOptions): Promise<StudioInstance> {
  const { repoRoot: requestedRoot, scenarioId, testTransport } = readOptions(options)
  const owned: Array<() => Promise<void>> = []
  /** Releases owned resources newest first; every step runs even when an earlier one fails. */
  const release = async (): Promise<boolean> => {
    let complete = true
    for (const releaseStep of owned.splice(0).reverse()) {
      try {
        await releaseStep()
      } catch {
        complete = false
      }
    }
    return complete
  }

  const closingController = new AbortController()
  const closing = closingController.signal
  const runs = new Set<Promise<void>>()
  let studioPage: Page | null = null
  let target: TargetApp | null = null
  let runLaunched = false
  /** True from the run's launch until it finalized or failed to. */
  let runActive = false
  let runFinalizeFailed = false
  let repoRoot = requestedRoot

  // One run per Studio session: the target app advances preview → known-bad → patched only once.
  const startRun = async ({ request, scenario, transport }: StudioRunStart): Promise<StudioRunHandle> => {
    const page = studioPage
    const app = target
    if (page === null || app === null || closing.aborted || runLaunched) {
      throw new StudioLaunchError('STUDIO_RUN_UNAVAILABLE', 'This Studio session cannot start a run.')
    }
    let settle: () => void = () => undefined
    runs.add(
      new Promise<void>((resolve) => {
        settle = () => resolve()
      }),
    )
    let worktree: WorktreeSession | null = null
    try {
      // The clean-baseline check and the snapshot precede any Git metadata or run artifact.
      worktree = await createWorktreeSession({ repoRoot, scenario })
      if (closing.aborted) throw new StudioLaunchError('STUDIO_CLOSED', 'The Studio closed before the run started.')
      const store = await createRunArtifactStore({ repoRoot, runId: request.run_id })
      const events = createRunEventStream({ runId: request.run_id, registry: store })
      const capture = createBrowserCapture(page)
      const session = worktree
      let result: RunResult | null = null
      runLaunched = true
      runActive = true
      void executeRun({
        request,
        scenario,
        baseline: { original_head: session.originalHead, original_status_digest: session.originalStatusDigest },
        store,
        events,
        allocator: createEvidenceIdAllocator(request.run_id),
        ports: createRunPorts({ page, target: app, worktree: session, capture, request, transport }),
        // A fresh per-run canary: nothing seeds it, so any finding is a credential shape or secret key.
        secretMarkers: [`flowproof-canary-${randomBytes(16).toString('hex')}`],
        // Closing the Studio interrupts the run; it still finalizes before anything is released.
        interrupt: closing,
      })
        .then(
          (finalized) => {
            result = finalized
          },
          () => {
            runFinalizeFailed = true
          },
        )
        .finally(async () => {
          runActive = false
          capture.dispose()
          await session.dispose().catch(() => undefined)
          settle()
        })
      return Object.freeze({ runId: request.run_id, events, artifacts: store, result: () => result })
    } catch (error) {
      await worktree?.dispose().catch(() => undefined)
      settle()
      throw error
    }
  }

  try {
    const [defaultCase] = SCENARIO_REGISTRY
    const scenario: LoadedScenario = await step('SCENARIO_UNAVAILABLE', 'The committed case could not be loaded.', () =>
      loadScenario(scenarioId ?? defaultCase?.scenario_id ?? '', { repoRoot: requestedRoot }),
    )
    repoRoot = scenario.resolved.repoRoot
    if (testTransport !== undefined) {
      let selected: ModelTransport | null = null
      try {
        selected = selectTransport(scenario.scenario, { testTransport })
      } catch {
        selected = null
      }
      if (selected !== testTransport) {
        throw new StudioLaunchError('STUDIO_OPTIONS_INVALID', 'testTransport must be a frozen in-process transport for a Meta case.')
      }
    }

    const app = await step('TARGET_APP_FAILED', 'The prepared application could not be served.', () => startTargetApp({ scenario }))
    owned.push(() => app.close())
    const studioBuild = await step('STUDIO_BUILD_FAILED', 'The Studio bundle could not be built.', () => tempBuild(repoRoot, 'studio-build', owned))
    const preview = await step('PREVIEW_BUILD_FAILED', 'The prepared preview could not be built.', () => tempBuild(repoRoot, 'preview-build', owned))
    await step('TARGET_APP_FAILED', 'The prepared application could not be served.', () => app.serve('preview', preview.path))
    target = app

    const server = await step('STUDIO_SERVER_FAILED', 'The Studio server could not start.', () =>
      startStudioServer({
        repoRoot,
        targetOrigin: app.origin,
        env: process.env,
        startRun,
        studioRoot: studioBuild.path,
        ...(scenarioId === null ? {} : { scenarioId }),
        ...(testTransport === undefined ? {} : { testTransport }),
      }),
    )
    owned.push(() => server.close())

    // The launcher owns shutdown order, so Playwright installs no signal handlers of its own.
    const browser = await step('BROWSER_LAUNCH_FAILED', 'The pinned headed Chromium could not be launched.', () =>
      chromium.launch({ headless: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }),
    )
    owned.push(() => browser.close())

    const page = await step('STUDIO_PAGE_FAILED', 'The Studio page could not be opened.', async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS
      const { viewport } = scenario.scenario.app
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.device_scale_factor,
        locale: 'en-US',
        timezoneId: 'UTC',
      })
      await context.addCookies([server.session.launchCookie()])
      const opened = await context.newPage()
      const response = await opened.goto(`${server.origin}/`, { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
      if (response?.status() !== 200) throw new StudioLaunchError('STUDIO_PAGE_FAILED', 'The Studio page did not load.')
      await waitForPreview(opened, app, deadline)
      return opened
    })
    studioPage = page

    let closed: Promise<StudioClosure> | null = null
    const close = (): Promise<StudioClosure> => {
      closed ??= (async () => {
        // Only a run that has not finalized yet is interrupted by this close.
        const interruptedRun = runActive
        closingController.abort()
        await Promise.allSettled([...runs])
        const released = await release()
        if (runFinalizeFailed) throw new StudioLaunchError('STUDIO_RUN_FINALIZE_FAILED', 'A run could not be finalized safely.')
        if (!released) throw new StudioLaunchError('STUDIO_CLEANUP_INCOMPLETE', 'Some Studio resources could not be released.')
        return Object.freeze({ interruptedRun })
      })()
      return closed
    }
    // Closing the Studio page or browser, or a page crash, closes the Studio and interrupts its run.
    const closeQuietly = (): void => {
      close().catch(() => undefined)
    }
    page.once('close', closeQuietly)
    page.once('crash', closeQuietly)
    browser.once('disconnected', closeQuietly)
    if (page.isClosed() || !browser.isConnected()) closeQuietly()

    const { origin, sessionId } = server.session
    return Object.freeze({
      origin,
      sessionId,
      page,
      close,
      toJSON: (): StudioLaunchJson => ({ mode: 'studio', origin, session_id: sessionId }),
    })
  } catch (error) {
    closingController.abort()
    await release()
    throw launchError(error, 'STUDIO_START_FAILED', 'The Studio could not be started.')
  }
}
