import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import type { Page } from '@playwright/test'

import { parseRunResult } from '../../packages/flowproof/src/contracts/index.js'
import type { RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadPendingModule } from './pendingModule.js'
import { acquireProcessLock, demoPortLockName } from './processLock.js'
import type { ProcessLock } from './processLock.js'
import { createRecordedTransport } from './recordedTransport.js'
import type { ModelTransportContract, RecordedTransport } from './recordedTransport.js'
import { createTempClone, createTempDirectory, listTree, processesMentioning, snapshotRepository } from './repoFixture.js'
import type { RepositorySnapshot, TempDirectory } from './repoFixture.js'

// The in-process Studio harness for deterministic end-to-end runs. It launches the real Studio
// through `startStudio` from `packages/flowproof/src/studio/launch.ts` (T047): the same build,
// servers, launch cookie, and headed Chromium as the CLI, with only the Hero model transport
// replaced by the recorded test transport; a fixture-provider case keeps its committed labeled
// fixture. The harness runs against a temporary clone, keeps MODEL_API_KEY unset, gives the
// engine a private TMPDIR, blocks every non-loopback HTTP request from this process, and reports
// anything the Studio leaves behind after it closes.

export interface StartStudioOptions {
  readonly repoRoot: string
  readonly scenarioId?: string | null
  /** The only way to replace the model transport; never reachable from the CLI or the API. */
  readonly testTransport?: ModelTransportContract
}

export interface StudioInstance {
  readonly origin: string
  readonly sessionId: string
  /** The single Studio page, with the target iframe and the agent pane. */
  readonly page: Page
  close(): Promise<void>
}

export interface LaunchModule {
  startStudio(options: StartStudioOptions): Promise<StudioInstance>
}

export const DEMO_PORT = 43119
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`

export interface CleanupReport {
  /** Entries left in the engine's private TMPDIR: builds, worktrees, browser profiles. */
  readonly tmpLeftovers: readonly string[]
  /** Processes still running with the private TMPDIR on their command line. */
  readonly processes: readonly number[]
  readonly demoPortListening: boolean
  readonly snapshot: RepositorySnapshot
  /** MODEL_API_KEY as observed right before the environment was restored. */
  readonly modelApiKeyPresent: boolean
}

export interface StudioHarness {
  readonly repoRoot: string
  readonly baseline: RepositorySnapshot
  readonly studio: StudioInstance
  readonly page: Page
  /** The test transport replacing Meta; null when the case keeps its committed fixture provider. */
  readonly transport: RecordedTransport | null
  /** Non-loopback HTTP requests this process attempted (and the harness refused). */
  readonly blockedRequests: readonly string[]
  /** Navigations of the target frame to the demo origin since the Studio opened. */
  targetNavigations(): number
  runRoot(runId: string): string
  /** Waits for exactly one finalized run and returns its persisted, contract-valid result. */
  waitForResult(timeoutMs: number): Promise<{ readonly runId: string; readonly result: RunResult }>
  readJson(runId: string, relative: string): Promise<unknown>
  close(): Promise<CleanupReport>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host: 'localhost', port, path: '/', timeout: 1_000 }, (response) => {
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface StudioHarnessOptions {
  readonly scenarioId: string
  /** Replaces the live Meta transport with the recorded one; `false` for a fixture-provider case. */
  readonly recordedTransport?: boolean
  /** Replaces the live Meta transport with this test transport instead of the recorded one. */
  readonly testTransport?: RecordedTransport
  /** Runs against the fresh clone before its baseline snapshot, for example to add an unrelated worktree. */
  readonly prepareClone?: (repoRoot: string) => Promise<void> | void
}

export async function openStudioHarness(options: StudioHarnessOptions): Promise<StudioHarness> {
  // Fail before any side effect while the launcher does not exist yet.
  const { startStudio } = await loadPendingModule<LaunchModule>('packages/flowproof/src/studio/launch.ts', 'T047', ['startStudio'])

  const undo: Array<() => Promise<void> | void> = []
  const rollback = async (): Promise<void> => {
    for (const step of undo.splice(0).reverse()) await step()
  }
  try {
    const savedKey = process.env.MODEL_API_KEY
    delete process.env.MODEL_API_KEY
    undo.push(() => {
      if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey
    })

    const lock: ProcessLock = await acquireProcessLock(demoPortLockName(DEMO_PORT))
    undo.push(() => lock.release())

    const clone: TempDirectory = await createTempClone({ withDependencies: true })
    undo.push(clone.remove)
    await options.prepareClone?.(clone.path)
    const baseline = await snapshotRepository(clone.path)

    const tmp = await createTempDirectory('flowproof-e2e-tmp-')
    undo.push(tmp.remove)
    const savedTmp = process.env.TMPDIR
    process.env.TMPDIR = tmp.path
    undo.push(() => {
      if (savedTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmp
    })

    const blockedRequests: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        blockedRequests.push(`${url.protocol}//${url.host}`)
        throw new Error('E2E_NETWORK_BLOCKED: deterministic end-to-end runs make no external requests.')
      }
      return realFetch(input, init)
    }) as typeof fetch
    undo.push(() => {
      globalThis.fetch = realFetch
    })

    const transport = options.testTransport ?? (options.recordedTransport === false ? null : createRecordedTransport())
    const studio = await startStudio({
      repoRoot: clone.path,
      scenarioId: options.scenarioId,
      ...(transport === null ? {} : { testTransport: transport }),
    })
    let closed = false
    undo.push(async () => {
      if (!closed) await studio.close()
    })

    let navigations = 0
    studio.page.on('framenavigated', (frame) => {
      if (frame !== studio.page.mainFrame() && frame.url().startsWith(DEMO_ORIGIN)) navigations += 1
    })

    const runsDir = path.join(clone.path, '.flowproof', 'runs')
    const runRoot = (runId: string): string => path.join(runsDir, runId)

    return {
      repoRoot: clone.path,
      baseline,
      studio,
      page: studio.page,
      transport,
      blockedRequests,
      targetNavigations: () => navigations,
      runRoot,
      async readJson(runId, relative) {
        return JSON.parse(await readFile(path.join(runRoot(runId), relative), 'utf8')) as unknown
      },
      async waitForResult(timeoutMs) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const runs = (await listTree(runsDir)).filter((entry) => !entry.includes('/'))
          if (runs.length > 1) throw new Error('More than one run was started.')
          const [runId] = runs
          if (runId) {
            try {
              const parsed = parseRunResult(JSON.parse(await readFile(path.join(runRoot(runId), 'result.json'), 'utf8')))
              if (!parsed.ok) throw new Error(`result.json violates the run-result contract: ${JSON.stringify(parsed.error.issues)}`)
              return { runId, result: parsed.value }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
            }
          }
          if (Date.now() > deadline) throw new Error('The run did not finalize in time.')
          await sleep(250)
        }
      },
      async close() {
        closed = true
        await studio.close()
        // Give exiting browser processes a moment before inspecting what is left.
        await sleep(250)
        const report: CleanupReport = {
          tmpLeftovers: await listTree(tmp.path),
          processes: await processesMentioning(tmp.path),
          demoPortListening: await listening(DEMO_PORT),
          snapshot: await snapshotRepository(clone.path),
          modelApiKeyPresent: process.env.MODEL_API_KEY !== undefined,
        }
        // Reported above; never left running for the next test.
        for (const pid of report.processes) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
        await rollback()
        return report
      },
    }
  } catch (error) {
    await rollback()
    throw error
  }
}
