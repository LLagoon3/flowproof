import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import type { BrowserContext, Frame, Page } from 'playwright'

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
import { optionalGit } from '../git/repositoryState.js'
import type { CapturedCleanupResource, CapturedVerificationResult } from '../verify/capturedContracts.js'
import { CAPTURED_ADMISSION_ERRORS, PREPARED_FUNCTIONAL_CHECKS, admitCapturedCandidate, createPreparedCandidatePorts, executeCapturedRun } from '../verify/capturedRun.js'
import type { AdmittedCandidate, CapturedAdmission, CapturedRunPorts, PreparedBaseline, PreparedCandidatePorts } from '../verify/capturedRun.js'
import { createWorktreeSession } from '../worktree/session.js'
import type { WorktreeSession } from '../worktree/session.js'
import { checkProjectBaseline } from '../project/admission.js'
import type { AdmittedProject } from '../project/admission.js'
import { PROJECT_LIMITS, ViewportSchema } from '../project/contracts.js'
import type { ExecutionConfiguration } from '../project/contracts.js'
import { admissionProfileOf, createExecutionConfiguration, suggestProjectSettings, verifyRuntimeImage } from '../project/profile.js'
import type { ProjectSettings, RuntimeProfile } from '../project/profile.js'
import { createProjectRuntime } from '../project/runtime.js'
import type { ImmutableOutput, ProjectRuntime } from '../project/runtime.js'
import { exportProjectSnapshot } from '../project/snapshot.js'
import type { ProjectSnapshot } from '../project/snapshot.js'
import { startProjectRecorder } from '../capture/projectRecorder.js'
import type { CaptureBinding } from '../capture/projectRecorder.js'
import { createProjectModelSession } from '../model/projectClient.js'
import type { ProjectModelFake, ProjectModelSession } from '../model/projectClient.js'
import type { PromptSourceFile } from '../model/projectPrompt.js'
import { MODEL_API_KEY_ENV } from '../model/transport.js'
import { demonstrationRecorderOf } from '../project/run.js'
import { createRunEventStream } from './events.js'
import { ProjectPreparationError, startStudioServer } from './server.js'
import type { CapturedStudioRunStart, ProjectPreparation, StudioRunHandle, StudioRunStart } from './server.js'
import { DEFAULT_RECONNECT_TIMEOUT_MS, TargetAppError, startProjectTargetApp, startTargetApp, trustedProbeReady } from './targetApp.js'
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

/** Browser defaults for project mode: no downloads, workers, permissions, or CSP bypass. */
export const PROJECT_BROWSER_CONTEXT_OPTIONS = Object.freeze({
  acceptDownloads: false,
  bypassCSP: false,
  serviceWorkers: 'block' as const,
  permissions: [] as string[],
  javaScriptEnabled: true,
})

export interface ProjectBrowserPolicy {
  blocked(): readonly { readonly kind: 'request' | 'navigation'; readonly origin: string; readonly url: string }[]
}

/** Allows only the Studio document and its direct target frame at their exact origins. */
export async function installProjectBrowserPolicy(
  context: BrowserContext,
  options: { readonly studioOrigin: string; readonly targetOrigin: string; readonly studioPage: () => Page | null },
): Promise<ProjectBrowserPolicy> {
  const blocked: Array<{ readonly kind: 'request' | 'navigation'; readonly origin: string; readonly url: string }> = []
  const studioOrigin = options.studioOrigin
  const targetOrigin = options.targetOrigin
  const recordBlocked = (raw: string, kind: 'request' | 'navigation'): void => {
    let origin = 'null'
    try {
      origin = new URL(raw).origin
    } catch {
      // Keep opaque and malformed origins as an explicit blocked entry.
    }
    blocked.push(Object.freeze({ kind, origin, url: raw.slice(0, 2_048) }))
  }
  await context.route('**/*', async (route) => {
    const raw = route.request().url()
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      recordBlocked(raw, route.request().isNavigationRequest() ? 'navigation' : 'request')
      await route.abort('blockedbyclient')
      return
    }
    const page = options.studioPage()
    let frame: Frame | null = null
    try {
      frame = route.request().frame()
    } catch {
      frame = null
    }
    let allowed = false
    if (page !== null && frame !== null && frame.page() === page) {
      const mainFrame = page.mainFrame()
      if (frame === mainFrame) allowed = url.origin === studioOrigin
      else if (frame.parentFrame() === mainFrame) {
        allowed = url.origin === targetOrigin || (!route.request().isNavigationRequest() && url.protocol === 'data:')
      }
    }
    if (allowed) {
      await route.continue()
      return
    }
    recordBlocked(raw, route.request().isNavigationRequest() ? 'navigation' : 'request')
    await route.abort('blockedbyclient')
  })
  // The static project profile has no socket authority. BrowserContext.route() does not cover
  // WebSocket handshakes, so close them through Playwright's dedicated route before they connect.
  await context.routeWebSocket(() => true, async (socket) => {
    recordBlocked(socket.url(), 'request')
    await socket.close({ code: 1008, reason: 'WebSockets are disabled for project targets.' })
  })
  context.on('page', (page) => {
    if (page !== options.studioPage()) void page.close().catch(() => undefined)
  })
  return Object.freeze({ blocked: () => Object.freeze([...blocked]) })
}

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

// ---------------------------------------------------------------------------------------
// Captured verification launch (specs/004-verify-captured-changes, T022)
// ---------------------------------------------------------------------------------------
//
// The sibling launcher for the host-fixed captured verification mode. It admits the completed
// Spec 003 capture result into an owned frozen snapshot synchronously, before any asynchronous
// work, refuses anything but the prepared scenario, and checks the repository object format and
// the recorded baseline commit before any browser, server, build, or artifact exists. It then opens
// the same Studio as `startStudio()`: the fixed-port target app with the prepared preview, the
// Studio bundle, the guarded server (in its captured mode, with no credential or transport), and
// one headed Chromium page with the launch cookie. The one accepted start runs `executeCapturedRun`
// against that page's one target iframe: the recorded baseline is built in the owned pinned
// worktree, served and captured in that frame; the same worktree applies, builds, and checks the
// candidate; then the candidate build is served and replayed in the same frame. Finalization ends
// that frame and stops target serving before the result is published; afterwards only the guarded
// result shell, its evidence server and the Studio browser remain until the user closes the Studio.
// Closing the Studio interrupts an active run, which still finalizes before anything is released.

export interface StartCapturedVerificationStudioOptions {
  /** The original repository the candidate was captured from. */
  readonly repoRoot: string
  /** The completed Spec 003 `{ session, capture }` result; admitted or refused here. */
  readonly captureResult: unknown
  /** The exact prepared scenario ID. */
  readonly scenarioId: string
}

/** Fixed refusals of captured launch input; each is raised before any browser, server, or artifact. */
export const CAPTURED_LAUNCH_REFUSALS = {
  ...CAPTURED_ADMISSION_ERRORS,
  CAPTURED_OPTIONS_INVALID: 'The captured verification launch accepts only repoRoot, captureResult, and scenarioId.',
  SCENARIO_NOT_PREPARED: 'The scenario is not the prepared captured verification case.',
  BASELINE_UNAVAILABLE: 'The recorded baseline commit is not available in the original repository.',
} as const
export type CapturedLaunchRefusalCode = keyof typeof CAPTURED_LAUNCH_REFUSALS

/** A refused captured launch; its message is the fixed sentence for its code, never input values or paths. */
export class CapturedLaunchRefusedError extends Error {
  readonly code: CapturedLaunchRefusalCode

  constructor(code: CapturedLaunchRefusalCode) {
    super(CAPTURED_LAUNCH_REFUSALS[code])
    this.name = 'CapturedLaunchRefusedError'
    this.code = code
  }
}

const CAPTURED_OPTION_KEYS = new Set(['repoRoot', 'captureResult', 'scenarioId'])

interface CapturedLaunchInput {
  readonly repoRoot: string
  readonly scenarioId: string
  readonly candidate: AdmittedCandidate
}

/** Admits with the object format the baseline length claims; the repository's format is checked after. */
function admitOwned(captureResult: unknown): CapturedAdmission {
  const sha1 = admitCapturedCandidate(captureResult, { objectFormat: 'sha1' })
  if (sha1.admitted || sha1.error.code !== 'BASELINE_FORMAT_MISMATCH') return sha1
  return admitCapturedCandidate(captureResult, { objectFormat: 'sha256' })
}

/** Reads every option once, admits the candidate, and checks the prepared scenario, all synchronously. */
function readCapturedLaunch(options: unknown): CapturedLaunchInput {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new CapturedLaunchRefusedError('CAPTURED_OPTIONS_INVALID')
  if (Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !CAPTURED_OPTION_KEYS.has(key))) {
    throw new CapturedLaunchRefusedError('CAPTURED_OPTIONS_INVALID')
  }
  const { repoRoot, captureResult, scenarioId } = options as Readonly<Record<string, unknown>>
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || typeof scenarioId !== 'string') throw new CapturedLaunchRefusedError('CAPTURED_OPTIONS_INVALID')
  const admission = admitOwned(captureResult)
  if (!admission.admitted) throw new CapturedLaunchRefusedError(admission.error.code)
  const prepared = Object.hasOwn(PREPARED_FUNCTIONAL_CHECKS, scenarioId) && SCENARIO_REGISTRY.some((entry) => entry.scenario_id === scenarioId)
  if (!prepared) throw new CapturedLaunchRefusedError('SCENARIO_NOT_PREPARED')
  return { repoRoot, scenarioId, candidate: admission.candidate }
}

/** The candidate's baseline must be a full commit of the repository's own object format in its object store. */
async function assertRecordedBaseline(repoRoot: string, candidate: AdmittedCandidate): Promise<void> {
  const format = (await optionalGit(repoRoot, ['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1'
  if (candidate.baselineCommit.length !== (format === 'sha256' ? 64 : 40)) throw new CapturedLaunchRefusedError('BASELINE_FORMAT_MISMATCH')
  const resolved = await optionalGit(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${candidate.baselineCommit}^{commit}`])
  if (resolved !== candidate.baselineCommit) throw new CapturedLaunchRefusedError('BASELINE_UNAVAILABLE')
}

interface CapturedRunWiring {
  readonly page: Page
  /** The Studio's one target frame, as it was when the Studio opened. */
  readonly frame: Frame
  readonly target: TargetApp
  readonly capture: BrowserCapture
  readonly prepared: PreparedCandidatePorts
}

/** How long the Studio page may take to report the removed target frame as detached. */
const FRAME_RELEASE_TIMEOUT_MS = 5_000

/**
 * Ends the observed target frame: removes exactly its iframe element from the Studio page, which
 * ends its document, scripts and any pending navigation, and waits until Playwright reports that
 * frame detached. A closed page has no frame left. True only when the frame is gone; never throws.
 *
 * React still holds the removed element in its tree, but it is the only child of the target pane's
 * keyed live wrapper, which the pane never updates around it once its run is active and replaces as
 * a whole with the completed evidence (see `TargetPane`), so no DOM operation of the Studio depends
 * on the element removed here.
 */
async function releaseTargetFrame(page: Page, frame: Frame): Promise<boolean> {
  if (frame.isDetached() || page.isClosed()) return true
  const detached = page.waitForEvent('framedetached', { predicate: (gone) => gone === frame, timeout: FRAME_RELEASE_TIMEOUT_MS }).then(
    () => true,
    () => frame.isDetached() || page.isClosed(),
  )
  try {
    const element = await frame.frameElement()
    try {
      // Runs in the Studio page, where the node is the target iframe element.
      await element.evaluate((node) => (node as unknown as { remove(): void }).remove())
    } finally {
      await element.dispose().catch(() => undefined)
    }
  } catch {
    // A frame or page that went away meanwhile is gone too; the wait below decides.
  }
  // Joined either way, so no wait for the detachment outlives this release.
  return (await detached) || frame.isDetached() || page.isClosed()
}

/**
 * The captured engine's stages, bound to the Studio page's one target frame, the target app, and
 * the prepared pinned worktree. Reproduction serves and captures the recorded baseline built in that
 * worktree; replay serves and captures the candidate build of the same worktree in the same frame.
 * A changed or detached frame, or a target that cannot load, fails its stage; there is no fallback.
 *
 * Finalization releases the target before the result is published: after the last evidence,
 * `disposeCapture` stops the capture, ends the observed frame and stops target serving, so only the
 * guarded result shell, its evidence server and the Studio browser remain until the user closes the
 * Studio. A run aborted during a measured stage (timeout or close) ends the frame at once: that
 * cancels a pending target load or capture step in it, which would otherwise hold the stage until
 * the reconnect or capture bound, and the engine still joins the stage before cleanup.
 */
function createCapturedRunPorts({ page, frame, target, capture, prepared }: CapturedRunWiring): CapturedRunPorts {
  const sameFrame = async (): Promise<Frame> => {
    const current = await studioTargetFrame(page, READY_TIMEOUT_MS)
    if (current !== frame || frame.isDetached()) throw new StudioLaunchError('STUDIO_PAGE_FAILED', 'The Studio target frame changed during the run.')
    return frame
  }
  // One release, shared by an abort during a measured stage and by the final disposal, which joins it.
  let frameRelease: Promise<boolean> | null = null
  const releaseFrame = (): Promise<boolean> => (frameRelease ??= releaseTargetFrame(page, frame))
  /** Runs a measured stage whose abort ends the frame it drives; the listener never outlives the stage. */
  const measured = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    const onAbort = (): void => {
      void releaseFrame()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await run()
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  return {
    reproduceBaseline: (context) => measured(context.signal, async () => {
      const baseline: { prepared: PreparedBaseline | null } = { prepared: null }
      await target.serveBuild('known-bad', {
        build: async () => {
          baseline.prepared = await prepared.prepareBaseline(context)
          return { documentRoot: baseline.prepared.documentRoot }
        },
      })
      const sourceRoot = baseline.prepared?.sourceRoot
      if (sourceRoot === undefined) throw new StudioLaunchError('STUDIO_RUN_INPUT_INVALID', 'The recorded baseline was not prepared.')
      const observed = await sameFrame()
      await target.reconnect(observed)
      // The recorded baseline build is now served and ready in the Studio frame; only once that
      // same attached frame is confirmed again (a changed frame throws) is the measured phase announced live.
      await sameFrame()
      context.frameReady()
      const { scenario, runId, store, allocator, signal } = context
      return capture.capturePhase({ phase: 'failure', frame: observed, scenario, runId, store, allocator, sourceRoot, signal })
    }),
    applyCandidate: (context) => prepared.applyCandidate(context),
    build: (context) => prepared.build(context),
    functionalCheck: (context) => prepared.functionalCheck(context),
    replay: (context) => measured(context.signal, async () => {
      const documentRoot = prepared.documentRoot()
      const sourceRoot = prepared.worktreePath()
      if (documentRoot === null || sourceRoot === null) throw new StudioLaunchError('STUDIO_RUN_INPUT_INVALID', 'The candidate build is not available.')
      // The exact build output the trusted check ran against; nothing is rebuilt here.
      await target.serveBuild('patched', { build: async () => ({ documentRoot }) })
      const observed = await sameFrame()
      await target.reconnect(observed)
      // The candidate build is now served and ready in the same Studio frame; only once that same
      // attached frame is confirmed again (a changed frame throws) is the measured phase announced live.
      await sameFrame()
      context.frameReady()
      const { scenario, runId, store, allocator, signal } = context
      return capture.capturePhase({ phase: 'replay', frame: observed, scenario, runId, store, allocator, sourceRoot, signal })
    }),
    // Called once every stage settled: stops the capture, ends the observed frame and its document,
    // then stops target serving and releases its port, all before the result is reduced. A frame
    // that is still attached or a target that still serves is reported, never assumed released.
    disposeCapture: async () => {
      const remaining = new Set<CapturedCleanupResource>()
      capture.dispose()
      if (!(await releaseFrame())) remaining.add('target_runtime')
      try {
        await target.close()
      } catch {
        remaining.add('target_runtime')
      }
      if (target.stage !== null) remaining.add('target_runtime')
      return { remaining: [...remaining] }
    },
    disposeWorktree: () => prepared.disposeWorktree(),
  }
}

/**
 * Launches the Studio in its host-fixed captured verification mode for one completed capture
 * result and the prepared scenario. Invalid input is refused with `CapturedLaunchRefusedError`
 * before any browser, server, build, or artifact exists; a failed startup releases everything it
 * acquired and throws `StudioLaunchError`. The returned handle has the `startStudio()` shape.
 */
export async function startCapturedVerificationStudio(options: StartCapturedVerificationStudioOptions): Promise<StudioInstance> {
  // Admission and its owned snapshot happen before any asynchronous work.
  const { repoRoot: requestedRoot, scenarioId, candidate } = readCapturedLaunch(options)
  const scenario: LoadedScenario = await step('SCENARIO_UNAVAILABLE', 'The committed case could not be loaded.', () => loadScenario(scenarioId, { repoRoot: requestedRoot }))
  const repoRoot = scenario.resolved.repoRoot
  await assertRecordedBaseline(repoRoot, candidate)

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
  let targetFrame: Frame | null = null
  let target: TargetApp | null = null
  let runLaunched = false
  let runActive = false
  let runFinalizeFailed = false

  // One verification run per launch, against the Studio page's one target frame.
  const startRun = async ({ request, scenario: runScenario }: CapturedStudioRunStart): Promise<StudioRunHandle> => {
    const page = studioPage
    const frame = targetFrame
    const app = target
    if (page === null || frame === null || app === null || closing.aborted || runLaunched) {
      throw new StudioLaunchError('STUDIO_RUN_UNAVAILABLE', 'This Studio session cannot start a run.')
    }
    let settle: () => void = () => undefined
    runs.add(
      new Promise<void>((resolve) => {
        settle = () => resolve()
      }),
    )
    let prepared: PreparedCandidatePorts | null = null
    try {
      // The trusted check and the original snapshot precede any Git metadata or run artifact.
      prepared = await createPreparedCandidatePorts({ repoRoot, scenario: runScenario, candidate })
      if (closing.aborted) throw new StudioLaunchError('STUDIO_CLOSED', 'The Studio closed before the run started.')
      const store = await createRunArtifactStore({ repoRoot, runId: request.run_id })
      const events = createRunEventStream({ runId: request.run_id, registry: store })
      const capture = createBrowserCapture(page)
      const ports = prepared
      let result: CapturedVerificationResult | null = null
      runLaunched = true
      runActive = true
      void executeCapturedRun({
        runId: request.run_id,
        requestId: request.request_id,
        scenario: runScenario,
        candidate,
        store,
        events,
        allocator: createEvidenceIdAllocator(request.run_id),
        ports: createCapturedRunPorts({ page, frame, target: app, capture, prepared: ports }),
        // A fresh per-run canary: nothing seeds it, so any finding is a credential shape or secret key.
        secretMarkers: [`flowproof-canary-${randomBytes(16).toString('hex')}`],
        // Closing the Studio interrupts the run; it still finalizes before anything is released.
        signal: closing,
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
          await ports.disposeWorktree().catch(() => undefined)
          settle()
        })
      return Object.freeze({ runId: request.run_id, events, artifacts: store, result: () => result })
    } catch (error) {
      await prepared?.disposeWorktree().catch(() => undefined)
      settle()
      throw error
    }
  }

  try {
    const app = await step('TARGET_APP_FAILED', 'The prepared application could not be served.', () => startTargetApp({ scenario }))
    owned.push(() => app.close())
    const studioBuild = await step('STUDIO_BUILD_FAILED', 'The Studio bundle could not be built.', () => tempBuild(repoRoot, 'studio-build', owned))
    const preview = await step('PREVIEW_BUILD_FAILED', 'The prepared preview could not be built.', () => tempBuild(repoRoot, 'preview-build', owned))
    await step('TARGET_APP_FAILED', 'The prepared application could not be served.', () => app.serve('preview', preview.path))
    target = app

    // The captured mode reads no credential and selects no model transport.
    const server = await step('STUDIO_SERVER_FAILED', 'The Studio server could not start.', () =>
      startStudioServer({ repoRoot, targetOrigin: app.origin, studioRoot: studioBuild.path, captured: { scenarioId, startRun } }),
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
      // The frame every run stage must drive and observe.
      targetFrame = await studioTargetFrame(opened, Math.max(1, deadline - Date.now()))
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

// ---------------------------------------------------------------------------------------
// Project demonstration ports (T029): launcher-owned frame, frozen sources, host-keyed model
// ---------------------------------------------------------------------------------------

export type ProjectDemonstrationPortErrorCode =
  | 'PROJECT_BASELINE_STALE'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_SNAPSHOT_INVALID'
  | 'TARGET_FRAME_UNAVAILABLE'
  | 'TARGET_VIEWPORT_UNSUPPORTED'
  | 'TARGET_ORIGIN_MISMATCH'

/** A coded refusal of a demonstration port; it carries no path, source text or credential. */
export class ProjectDemonstrationPortError extends Error {
  constructor(readonly code: ProjectDemonstrationPortErrorCode) {
    super(`The project demonstration is unavailable: ${code}.`)
    this.name = 'ProjectDemonstrationPortError'
  }
}

async function readAdmittedBytes(root: string, relative: string): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null
  } finally {
    await handle.close()
  }
}

/**
 * The admitted committed UTF-8 `src/` text of the baseline, read from a fresh verified admission
 * snapshot (never the working tree, a runtime workspace or project environment files) and checked
 * against the admitted blob digests. The baseline must be unchanged before and after. All admitted
 * sources are returned or none: beyond the 32-file/256-KiB request bound this fails closed, since
 * no relevance selection is defined.
 */
export async function loadAdmittedProjectSources(
  project: AdmittedProject,
  profile: RuntimeProfile,
): Promise<{ readonly sources: readonly PromptSourceFile[]; readonly admitted: ReadonlySet<string> }> {
  const admission = admissionProfileOf(profile)
  if ((await checkProjectBaseline(project, admission)).state !== 'ready') throw new ProjectDemonstrationPortError('PROJECT_BASELINE_STALE')
  const files = project.files.filter((file) => file.path.startsWith('src/') && file.text).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  if (files.length > PROJECT_LIMITS.maxRequestSourceFiles || bytes > PROJECT_LIMITS.maxRequestSourceBytes) throw new ProjectDemonstrationPortError('SOURCE_LIMIT_EXCEEDED')
  const snapshot = await exportProjectSnapshot({ project, purpose: 'admission-snapshot' })
  const sources: PromptSourceFile[] = []
  try {
    if (snapshot.baselineCommit !== project.context.baseline_commit || !(await snapshot.verify()).ok) throw new ProjectDemonstrationPortError('SOURCE_SNAPSHOT_INVALID')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const file of files) {
      const content = await readAdmittedBytes(snapshot.workspace, file.path)
      if (content === null || content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) {
        throw new ProjectDemonstrationPortError('SOURCE_SNAPSHOT_INVALID')
      }
      let text: string
      try {
        text = decoder.decode(content)
      } catch {
        throw new ProjectDemonstrationPortError('SOURCE_SNAPSHOT_INVALID')
      }
      sources.push(Object.freeze({ path: file.path, content: text }))
    }
  } finally {
    await snapshot.remove()
  }
  if ((await checkProjectBaseline(project, admission)).state !== 'ready') throw new ProjectDemonstrationPortError('PROJECT_BASELINE_STALE')
  return Object.freeze({ sources: Object.freeze(sources), admitted: new Set(sources.map((source) => source.path)) })
}

/**
 * The recorder binding from host-owned identities only: the admitted project, the confirmed
 * configuration, the ready output digest and the host-measured CSS viewport of the target frame.
 */
export function projectCaptureBinding(input: {
  readonly runId: string
  readonly project: AdmittedProject
  readonly configuration: ExecutionConfiguration
  readonly preparation: ProjectPreparation
  readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number }
}): CaptureBinding {
  const { runId, project, configuration, preparation, viewport } = input
  let origin = 'null'
  try {
    origin = new URL(preparation.target_url).origin
  } catch {
    // An unparsable target URL is a mismatch below.
  }
  if (origin !== configuration.target_origin) throw new ProjectDemonstrationPortError('TARGET_ORIGIN_MISMATCH')
  const measured = ViewportSchema.safeParse({ width: viewport.width, height: viewport.height, device_scale_factor: viewport.devicePixelRatio })
  if (!measured.success) throw new ProjectDemonstrationPortError('TARGET_VIEWPORT_UNSUPPORTED')
  return Object.freeze({
    run_id: runId,
    project_id: project.context.project_id,
    baseline_commit: project.context.baseline_commit,
    configuration_id: configuration.configuration_id,
    configuration_digest: configuration.configuration_digest,
    target_origin: configuration.target_origin,
    viewport: Object.freeze({ width: measured.data.width, height: measured.data.height, device_scale_factor: 1 as const }),
    build_sha256: preparation.output_sha256,
  })
}

/** The per-run S5 session: only `MODEL_API_KEY` of the explicit host environment, never `process.env`. */
export function projectDemonstrationModel(
  runId: string,
  options: { readonly modelEnv?: Readonly<Record<string, string | undefined>>; readonly modelFake?: ProjectModelFake },
): ProjectModelSession {
  const key = options.modelEnv?.[MODEL_API_KEY_ENV]
  return createProjectModelSession({
    run_id: runId,
    env: Object.freeze({ [MODEL_API_KEY_ENV]: typeof key === 'string' ? key : undefined }),
    ...(options.modelFake === undefined ? {} : { fake: options.modelFake }),
  })
}

/**
 * The Studio page's one direct prepared-target frame and its CSS viewport, measured on the iframe
 * element in the Studio document (host side), never reported by the target document.
 */
async function projectTargetFrame(page: Page, targetOrigin: string): Promise<{ readonly frame: Frame; readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number } }> {
  const unavailable = (): ProjectDemonstrationPortError => new ProjectDemonstrationPortError('TARGET_FRAME_UNAVAILABLE')
  if (page.isClosed()) throw unavailable()
  const targets = page.locator('[data-testid="project-target"]')
  if ((await targets.count()) !== 1 || (await page.locator('iframe').count()) !== 1) throw unavailable()
  const element = await targets.elementHandle({ timeout: READY_TIMEOUT_MS })
  try {
    const frame = await element.contentFrame()
    if (frame === null || frame.parentFrame() !== page.mainFrame()) throw unavailable()
    let origin = 'null'
    try {
      origin = new URL(frame.url()).origin
    } catch {
      // A frame without a URL is not the prepared target.
    }
    if (origin !== targetOrigin) throw unavailable()
    const viewport = await element.evaluate((node) => {
      const box = node as unknown as { clientWidth: number; clientHeight: number; ownerDocument: { defaultView: { devicePixelRatio: number } | null } }
      return { width: box.clientWidth, height: box.clientHeight, devicePixelRatio: box.ownerDocument.defaultView?.devicePixelRatio ?? 0 }
    })
    return { frame, viewport }
  } finally {
    await element.dispose()
  }
}

export interface StartProjectStudioOptions {
  readonly repoRoot: string
  readonly project: AdmittedProject
  readonly profile: RuntimeProfile
  readonly initialSettings: ProjectSettings | null
  readonly modelConfigured: boolean
  /** The established host controller environment; only `MODEL_API_KEY` is read, per run. */
  readonly modelEnv?: Readonly<Record<string, string | undefined>>
  /** Deterministic tests only: an explicitly labelled in-process provider fake. The CLI never sets it. */
  readonly modelFake?: ProjectModelFake
}

/** Opens the isolated, project-only setup journey. It has no run, capture, or model capability. */
export async function startProjectStudio(options: StartProjectStudioOptions): Promise<StudioInstance> {
  const { repoRoot, project, profile, initialSettings, modelConfigured, modelEnv, modelFake } = options
  if (
    project.context.profile.image_id !== profile.imageId ||
    project.context.profile.lock_sha256 !== profile.lockSha256 ||
    project.context.profile.manifest_sha256 !== profile.manifestSha256
  ) {
    throw new StudioLaunchError('STUDIO_OPTIONS_INVALID', 'The admitted project does not match the runtime profile.')
  }
  const initialBaseline = await checkProjectBaseline(project, admissionProfileOf(profile))
  if (initialBaseline.state !== 'ready') {
    throw new ProjectPreparationError('PROJECT_BASELINE_STALE', initialBaseline.reasons)
  }
  await verifyRuntimeImage(profile)

  let target: Awaited<ReturnType<typeof startProjectTargetApp>> | null = null
  for (let port = 43_150; port <= 43_159; port += 1) {
    try {
      target = await startProjectTargetApp({ port })
      break
    } catch (error) {
      if (!(error instanceof TargetAppError) || error.code !== 'TARGET_PORT_UNAVAILABLE') throw error
    }
  }
  if (target === null) throw new StudioLaunchError('TARGET_APP_FAILED', 'No reserved project target port is available.')

  const runtime: ProjectRuntime = createProjectRuntime({ profile })
  let studioBuild: TempOutput | null = null
  let server: Awaited<ReturnType<typeof startStudioServer>> | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  let browserContext: BrowserContext | null = null
  let page: Page | null = null
  let activeOutput: ImmutableOutput | null = null
  let releaseOutputWork: Promise<void> | null = null
  const preparationJobs = new Set<Promise<ProjectPreparation>>()

  const releaseProjectOutput = async (): Promise<void> => {
    if (releaseOutputWork !== null) return releaseOutputWork
    releaseOutputWork = (async () => {
      target?.unserve()
      const output = activeOutput
      activeOutput = null
      await output?.remove()
    })()
    try {
      await releaseOutputWork
    } finally {
      releaseOutputWork = null
    }
  }

  const prepare = async (configuration: ExecutionConfiguration, signal: AbortSignal): Promise<ProjectPreparation> => {
    const job = (async (): Promise<ProjectPreparation> => {
      // Defense in depth behind the server guard: a retained output is released before any new
      // preparation, so a later success never overwrites (and orphans) the previous output.
      if (activeOutput !== null || releaseOutputWork !== null) await releaseProjectOutput()
      const current = await checkProjectBaseline(project, admissionProfileOf(profile))
      if (current.state !== 'ready') throw new ProjectPreparationError('PROJECT_BASELINE_STALE', current.reasons)
      if (signal.aborted) throw new ProjectPreparationError('RUNTIME_CANCELLED')
      const snapshot: ProjectSnapshot = await exportProjectSnapshot({ project, purpose: 'admission-snapshot' })
      let output: ImmutableOutput | null = null
      let retained = false
      try {
        const build = await runtime.build({ snapshot, configuration, signal })
        if (build.status !== 'passed' || build.output === null) {
          throw new ProjectPreparationError(build.status === 'failed' ? build.reason : 'RUNTIME_BUILD_FAILED')
        }
        output = build.output
        const checks: Array<{ readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }> = []
        for (const check of configuration.required_project_checks) {
          if (signal.aborted) throw new ProjectPreparationError('RUNTIME_CANCELLED')
          const result = await runtime.check({ snapshot, configuration, signal, checkId: check.id, output })
          checks.push({ id: check.id, status: result.status })
          if (result.status !== 'passed') {
            throw new ProjectPreparationError(result.status === 'failed' ? result.reason : 'RUNTIME_CHECK_FAILED')
          }
        }
        const finalBaseline = await checkProjectBaseline(project, admissionProfileOf(profile))
        if (finalBaseline.state !== 'ready') throw new ProjectPreparationError('PROJECT_BASELINE_STALE', finalBaseline.reasons)
        if (signal.aborted) throw new ProjectPreparationError('RUNTIME_CANCELLED')
        const app = target
        if (app === null) throw new ProjectPreparationError('PROJECT_PREPARE_FAILED')
        await app.serve(output, { entryPath: configuration.entry_path })
        activeOutput = output
        retained = true
        return Object.freeze({
          target_url: `${app.origin}${configuration.entry_path}`,
          output_sha256: output.sha256,
          checks: Object.freeze(checks.map((check) => Object.freeze(check))),
        })
      } finally {
        await snapshot.remove()
        if (!retained) await output?.remove()
      }
    })()
    preparationJobs.add(job)
    try {
      return await job
    } finally {
      preparationJobs.delete(job)
    }
  }

  const release = async (): Promise<void> => releaseProjectOutput()

  try {
    studioBuild = await tempBuild(repoRoot, 'studio-build', [])
    server = await startStudioServer({
      targetOrigin: target.origin,
      studioRoot: studioBuild.path,
      project: {
        context: project.context,
        modelConfigured,
        suggestion: suggestProjectSettings(project),
        initialSettings,
        configure: (settings, confirmedAt) =>
          createExecutionConfiguration({
            project,
            profile,
            settings,
            targetOrigin: target!.origin,
            confirmedAt,
          }),
        prepare,
        release,
        openDemonstration: ({ runId, configuration, preparation }) => ({
          startRecorder: async () => {
            const current = page
            if (current === null) throw new ProjectDemonstrationPortError('TARGET_FRAME_UNAVAILABLE')
            const { frame, viewport } = await projectTargetFrame(current, configuration.target_origin)
            const binding = projectCaptureBinding({ runId, project, configuration, preparation, viewport })
            return demonstrationRecorderOf(await startProjectRecorder({ page: current, frame, binding, entryPath: configuration.entry_path }))
          },
          loadSources: () => loadAdmittedProjectSources(project, profile),
          model: projectDemonstrationModel(runId, { ...(modelEnv === undefined ? {} : { modelEnv }), ...(modelFake === undefined ? {} : { modelFake }) }),
        }),
      },
    })
    // The policy requires the actual ephemeral Studio origin; install it after the guarded server binds.
    target.setFrameAncestor(server.origin)
    browser = await chromium.launch({ headless: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
    browserContext = await browser.newContext(PROJECT_BROWSER_CONTEXT_OPTIONS)
    await browserContext.addCookies([server.session.launchCookie()])
    page = await browserContext.newPage()
    await installProjectBrowserPolicy(browserContext, {
      studioOrigin: server.origin,
      targetOrigin: target.origin,
      studioPage: () => page,
    })
    const response = await page.goto(`${server.origin}/?mode=project`, { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
    if (response?.status() !== 200) throw new StudioLaunchError('STUDIO_PAGE_FAILED', 'The project setup page did not load.')
    await page.getByTestId('project-setup').waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })

    let closed: Promise<StudioClosure> | null = null
    const close = (): Promise<StudioClosure> => {
      closed ??= (async () => {
        let complete = true
        if (server !== null) await server.close().catch(() => { complete = false })
        await Promise.allSettled([...preparationJobs])
        await releaseProjectOutput().catch(() => { complete = false })
        await browser?.close().catch(() => { complete = false })
        await target?.close().catch(() => { complete = false })
        if (!(await runtime.dispose().catch(() => false))) complete = false
        await studioBuild?.remove().catch(() => { complete = false })
        if (!complete) throw new StudioLaunchError('STUDIO_CLEANUP_INCOMPLETE', 'Some project Studio resources could not be released.')
        return Object.freeze({ interruptedRun: false })
      })()
      return closed
    }
    const closeQuietly = (): void => { close().catch(() => undefined) }
    page.once('close', closeQuietly)
    page.once('crash', closeQuietly)
    browser.once('disconnected', closeQuietly)
    if (page.isClosed() || !browser.isConnected()) closeQuietly()
    const origin = server.origin
    const sessionId = server.session.sessionId
    return Object.freeze({
      origin,
      sessionId,
      page,
      close,
      toJSON: (): StudioLaunchJson => ({ mode: 'studio', origin, session_id: sessionId }),
    })
  } catch (error) {
    await server?.close().catch(() => undefined)
    await Promise.allSettled([...preparationJobs])
    await releaseProjectOutput().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    await runtime.dispose().catch(() => false)
    await studioBuild?.remove().catch(() => undefined)
    throw launchError(error, 'STUDIO_START_FAILED', 'The project Studio could not be started.')
  }
}
