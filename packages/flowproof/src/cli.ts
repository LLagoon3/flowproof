#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { Command, CommanderError } from 'commander'
import type { Page } from 'playwright'

import { ArtifactStoreError, assertArtifactRootSafe } from './evidence/store.js'
import { selectTransport } from './model/transport.js'
import { ScenarioLoadError, loadScenario } from './scenario/loadScenario.js'
import { SCENARIO_REGISTRY } from './scenario/registry.js'
import { StudioLaunchError, startStudio } from './studio/launch.js'
import type { StudioClosure, StudioInstance } from './studio/launch.js'
import { WorktreeError } from './worktree/session.js'

// `flowproof studio [--scenario <scenario-id>]`, the only MVP command (contracts/cli.md). Every
// precondition runs read-only before the Studio starts: the canonical Git checkout, its HEAD and
// clean tracked baseline, the registered case and its committed paths, the artifact root, and,
// for an explicit case, provider readiness. Without `--scenario` no credential is required until
// a run is requested. The launch object is printed once the browser is ready, and the process
// stays up until the Studio closes or an interrupt arrives; either one during a run finalizes
// that run as `Unverified` and exits `2`. Diagnostics are one `CODE: message` line on stderr built
// from fixed messages; argv, paths, and environment values are never echoed. The command runs
// only when this module is the process entry point, so tests can supervise an in-process Studio
// with the same interrupt lifecycle.

/**
 * `0` normal close, `2` the Studio closed or was interrupted during a run that then finalized as
 * `Unverified`, `3` precondition or usage failure, `4` internal startup, finalization, or shutdown failure.
 */
export type ExitCode = 0 | 2 | 3 | 4

const USAGE_INVALID = 'CLI_USAGE_INVALID: Usage: flowproof studio [--scenario <scenario-id>].'
const PRECONDITION_CHECK_FAILED = 'PRECONDITION_CHECK_FAILED: The launch preconditions could not be checked.'
const STUDIO_START_FAILED = 'STUDIO_START_FAILED: The Studio could not be started.'
const STUDIO_CLOSE_FAILED = 'STUDIO_CLEANUP_INCOMPLETE: Some Studio resources could not be released.'
const RUN_INTERRUPTED = 'RUN_INTERRUPTED: The Studio closed or was interrupted during a run; the run was finalized as Unverified.'
// The launcher owns shutdown, so Playwright installs no handlers of its own (see launch.ts).
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** A failed precondition without a typed error of its own; its message is fixed and safe. */
class PreconditionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'PreconditionError'
    this.code = code
  }
}

const diagnose = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

// ---------------------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------------------

const runFile = promisify(execFile)

// The same isolation as the worktree session: no `GIT_*` overrides, credentials, global or
// system configuration, hooks, filesystem monitor, or optional index locks.
async function readGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runFile('git', ['--no-optional-locks', '-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  })
  return stdout
}

/** The canonical top level of the Git checkout that holds the working directory. */
async function resolveRepository(): Promise<string> {
  try {
    return await realpath((await readGit(await realpath(process.cwd()), ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    throw new WorktreeError('REPOSITORY_UNAVAILABLE', 'The working directory is not a readable Git checkout.')
  }
}

/** A HEAD commit and no tracked change; untracked and ignored files are allowed. */
async function assertCleanBaseline(repoRoot: string): Promise<void> {
  const head = await readGit(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')
  if (head.trim() === '') throw new WorktreeError('HEAD_MISSING', 'The repository has no HEAD commit.')
  let status: string
  try {
    status = await readGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  } catch {
    throw new WorktreeError('REPOSITORY_UNAVAILABLE', 'The original repository state could not be recorded.')
  }
  if (status !== '') throw new WorktreeError('WORKING_TREE_DIRTY', 'The tracked working tree has uncommitted changes.')
}

/**
 * Runs every launch precondition in contract order without a side effect and returns the
 * canonical repository root. Without `scenarioId` the first registered case, which the Studio
 * opens with, is validated and the provider credential stays deferred to `POST /api/runs`.
 */
async function checkPreconditions(scenarioId: string | null): Promise<string> {
  const repoRoot = await resolveRepository()
  await assertCleanBaseline(repoRoot)
  const loaded = await loadScenario(scenarioId ?? SCENARIO_REGISTRY[0]?.scenario_id ?? '', { repoRoot })
  await assertArtifactRootSafe(repoRoot)
  if (scenarioId !== null) {
    // The live transport reads only `MODEL_API_KEY` from the environment it is given and keeps nothing.
    const readiness = selectTransport(loaded.scenario).checkReadiness(process.env)
    if (!readiness.ready) throw new PreconditionError(readiness.code, readiness.message)
  }
  return repoRoot
}

const isPreconditionFailure = (error: unknown): error is Error =>
  error instanceof PreconditionError || error instanceof WorktreeError || error instanceof ScenarioLoadError || error instanceof ArtifactStoreError

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

interface Subscription {
  /** Resolves on the first occurrence; never rejects. */
  readonly event: Promise<void>
  /** Removes every listener the subscription installed. */
  dispose(): void
}

export interface ShutdownSignals extends Subscription {
  received(): boolean
}

/** Turns the first shutdown signal into an event; later signals change nothing while cleanup runs. */
export function watchShutdownSignals(): ShutdownSignals {
  let received = false
  let notify: () => void = () => undefined
  const event = new Promise<void>((resolve) => {
    notify = resolve
  })
  const onSignal = (): void => {
    received = true
    notify()
  }
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal)
  return {
    event,
    received: () => received,
    dispose: () => {
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal)
    },
  }
}

/** Fires when the Studio page closes or crashes or its browser disconnects; the Studio closes itself on each. */
function watchStudioEnd(page: Page): Subscription {
  const browser = page.context().browser()
  let notify: () => void = () => undefined
  const event = new Promise<void>((resolve) => {
    notify = resolve
  })
  const onEnd = (): void => notify()
  page.on('close', onEnd)
  page.on('crash', onEnd)
  browser?.on('disconnected', onEnd)
  if (page.isClosed() || browser?.isConnected() === false) onEnd()
  return {
    event,
    dispose: () => {
      page.off('close', onEnd)
      page.off('crash', onEnd)
      browser?.off('disconnected', onEnd)
    },
  }
}

/** Prints the launch object, then waits for an interrupt or for the Studio to end on its own. */
async function serveUntilClosed(instance: StudioInstance, signals: ShutdownSignals): Promise<void> {
  const studioEnd = watchStudioEnd(instance.page)
  try {
    // Ready but already interrupted: close without advertising an origin that is going away.
    if (!signals.received()) process.stdout.write(`${JSON.stringify(instance.toJSON())}\n`)
    await Promise.race([signals.event, studioEnd.event])
  } finally {
    studioEnd.dispose()
  }
}

/**
 * Serves a started Studio until an interrupt or its own end, closes it, and maps how it ended to
 * the exit code: `2` when the close interrupted a run, which then finalized as `Unverified`.
 */
export async function superviseStudio(instance: StudioInstance, signals: ShutdownSignals): Promise<ExitCode> {
  const served = await serveUntilClosed(instance, signals).then(
    () => true,
    () => false,
  )
  // Idempotent: also settles a close the Studio already began when its page or browser went away.
  let closure: StudioClosure
  try {
    closure = await instance.close()
  } catch (error) {
    diagnose(error instanceof StudioLaunchError ? error.message : STUDIO_CLOSE_FAILED)
    return 4
  }
  if (!served) {
    diagnose(STUDIO_START_FAILED)
    return 4
  }
  if (closure.interruptedRun) {
    diagnose(RUN_INTERRUPTED)
    return 2
  }
  return 0
}

async function runStudio(scenarioId: string | null): Promise<ExitCode> {
  let repoRoot: string
  try {
    repoRoot = await checkPreconditions(scenarioId)
  } catch (error) {
    diagnose(isPreconditionFailure(error) ? error.message : PRECONDITION_CHECK_FAILED)
    return isPreconditionFailure(error) ? 3 : 4
  }

  // Installed before startup, so an early interrupt still releases everything the Studio acquires.
  const signals = watchShutdownSignals()
  try {
    let instance: StudioInstance
    try {
      instance = await startStudio({ repoRoot, scenarioId })
    } catch (error) {
      diagnose(error instanceof StudioLaunchError ? error.message : STUDIO_START_FAILED)
      return 4
    }
    return await superviseStudio(instance, signals)
  } finally {
    signals.dispose()
  }
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<ExitCode> {
  let exitCode: ExitCode = 0
  const program = new Command()
  // Commander's own error text can echo argv, so parse errors surface only as a fixed diagnostic.
  program
    .name('flowproof')
    .description('Local evidence-grounded fix verification')
    .version('0.1.0')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })

  program
    .command('studio')
    .description('Open the local split-view FlowProof Studio')
    .option('--scenario <scenario-id>', 'committed scenario identifier')
    .action(async (options: { readonly scenario?: string }) => {
      exitCode = await runStudio(options.scenario ?? null)
    })

  try {
    await program.parseAsync(argv)
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` exit successfully; every other parse error is a usage failure.
      if (error.exitCode === 0) return 0
      diagnose(USAGE_INVALID)
      return 3
    }
    diagnose(STUDIO_START_FAILED)
    return 4
  }
  return exitCode
}

if (import.meta.main) process.exitCode = await main(process.argv)
