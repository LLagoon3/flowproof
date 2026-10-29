import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'

import { PendingModuleError } from './pendingModule.js'
import { withProcessLock } from './processLock.js'
import { REPO_ROOT, createTempDirectory } from './repoFixture.js'
import type { TempDirectory } from './repoFixture.js'

// Runs the compiled `flowproof` launcher exactly as the root `pnpm flowproof` script does:
// `node --env-file-if-exists=.env packages/flowproof/dist/cli.js`, with the working
// directory set to the repository under test. Every invocation gets its own empty TMPDIR,
// so a suite can prove that nothing (builds, browser profiles, worktrees) is left behind,
// and MODEL_API_KEY is always removed from the child environment.

export const CLI_ENTRY = path.join(REPO_ROOT, 'packages/flowproof/dist/cli.js')

let built = false

/** Compiles the engine once per test process; concurrent suites serialize on a lock. */
export async function buildFlowproofCli(): Promise<void> {
  if (built) return
  await withProcessLock('flowproof-engine-build', async () => {
    execFileSync('pnpm', ['--filter', 'flowproof', 'run', 'build'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  })
  built = true
}

export interface CliOptions {
  readonly cwd: string
  /** Extra variables for the child; MODEL_API_KEY can never be supplied. */
  readonly env?: Readonly<Record<string, string>>
}

export interface CliResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** The child's private TMPDIR, still present so the caller can inspect it. */
  readonly tmp: TempDirectory
}

function childEnvironment(tmpPath: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, TMPDIR: tmpPath, NO_COLOR: '1' }
  delete env.MODEL_API_KEY
  delete env.FORCE_COLOR
  return env
}

const STUB_SIGNATURE = 'STUDIO_NOT_IMPLEMENTED'

/** The pre-T048 launcher stub fails every invocation with a fixed code; report it as pending. */
export function assertLauncherImplemented(result: { readonly code: number | null; readonly stderr: string }): void {
  if (result.code === 4 && result.stderr.includes(STUB_SIGNATURE)) {
    throw new PendingModuleError('`flowproof studio` is still the launcher stub; T048 implements it.')
  }
}

function spawnCli(args: readonly string[], options: CliOptions, tmpPath: string): ChildProcess {
  return spawn(process.execPath, ['--env-file-if-exists=.env', CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: childEnvironment(tmpPath, options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so cleanup can reach any browser the launcher left behind.
    detached: true,
  })
}

// Signals the whole group even after the launcher itself exited, so orphaned browser
// processes it started are still reached.
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone.
  }
}

/** Runs one launcher invocation that is expected to exit on its own. */
export async function runFlowproof(args: readonly string[], options: CliOptions, timeoutMs = 120_000): Promise<CliResult> {
  const tmp = await createTempDirectory('flowproof-cli-tmp-')
  const child = spawnCli(args, options, tmp.path)
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
  )
  clearTimeout(timer)
  return { code, signal, stdout, stderr, tmp }
}

export interface LaunchJson {
  readonly mode: string
  readonly origin: string
  readonly session_id: string
}

export interface RunningStudio {
  readonly tmp: TempDirectory
  readonly pid: number
  stdout(): string
  stderr(): string
  /** Resolves with the machine-readable launch object once the browser is ready. */
  waitForLaunch(timeoutMs?: number): Promise<LaunchJson>
  /** Sends SIGINT to the launcher and resolves with its exit status. */
  interrupt(timeoutMs?: number): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  /** Last-resort cleanup: kills the launcher's whole process group. */
  kill(): void
}

/** Starts a launcher invocation that is expected to keep the Studio open. */
export async function startFlowproof(args: readonly string[], options: CliOptions): Promise<RunningStudio> {
  const tmp = await createTempDirectory('flowproof-cli-tmp-')
  const child = spawnCli(args, options, tmp.path)
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )

  const parseLaunch = (): LaunchJson | null => {
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsed = JSON.parse(trimmed) as LaunchJson
        if (parsed.mode === 'studio') return parsed
      } catch {
        // Not the launch line.
      }
    }
    return null
  }

  return {
    tmp,
    pid: child.pid ?? -1,
    stdout: () => stdout,
    stderr: () => stderr,
    async waitForLaunch(timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const launch = parseLaunch()
        if (launch) return launch
        if (child.exitCode !== null || child.signalCode !== null) {
          const status = await exited
          assertLauncherImplemented({ code: status.code, stderr })
          throw new Error(`The launcher exited with ${status.code ?? status.signal} before reporting a ready Studio.`)
        }
        if (Date.now() > deadline) throw new Error('The launcher did not report a ready Studio in time.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    },
    async interrupt(timeoutMs = 60_000) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) process.kill(child.pid, 'SIGINT')
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs)
      const status = await exited
      clearTimeout(timer)
      return status
    },
    kill: () => killGroup(child, 'SIGKILL'),
  }
}
