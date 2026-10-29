import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { PendingModuleError, loadPendingModule } from './pendingModule.js'
import { REPO_ROOT } from './repoFixture.js'
import type { StudioInstance } from './studioHarness.js'

// The interrupt lifecycle of `flowproof studio` from `packages/flowproof/src/cli.ts` (T064): the
// shutdown-signal watch and the supervision that serves a started Studio until an interrupt or its
// own end, closes it, and maps how it ended to the CLI exit code. Only an in-process test
// transport can drive a run to a chosen stage, so tests load this lifecycle in-process to deliver
// a real SIGINT or close the Studio page around such a run. The CLI must run its command only as
// the process entry point; until it does, importing it would run the command inside the test
// worker, so the loader refuses before importing.

const CLI_SOURCE = 'packages/flowproof/src/cli.ts'

export interface ShutdownSignals {
  /** Resolves on the first shutdown signal. */
  readonly event: Promise<void>
  received(): boolean
  dispose(): void
}

export interface CliLifecycle {
  watchShutdownSignals(): ShutdownSignals
  /** Resolves with the exit code: `0` normal close, `2` a run interrupted and finalized Unverified, `4` unsafe close. */
  superviseStudio(instance: StudioInstance, signals: ShutdownSignals): Promise<number>
}

export async function loadCliLifecycle(): Promise<CliLifecycle> {
  const source = await readFile(path.join(REPO_ROOT, CLI_SOURCE), 'utf8')
  if (!source.includes('import.meta.main')) {
    throw new PendingModuleError(`${CLI_SOURCE} still runs its command on import; T064 exposes its interrupt lifecycle.`)
  }
  return loadPendingModule<CliLifecycle>(CLI_SOURCE, 'T064', ['watchShutdownSignals', 'superviseStudio'])
}

/**
 * Supervises a started Studio exactly as `flowproof studio` does and resolves with its exit code.
 * The returned promise is awaited by the caller; a pending lifecycle never surfaces earlier as an
 * unhandled rejection.
 */
export function superviseExitCode(studio: StudioInstance): Promise<number> {
  const exit = loadCliLifecycle().then(async (cli) => {
    const signals = cli.watchShutdownSignals()
    try {
      return await cli.superviseStudio(studio, signals)
    } finally {
      signals.dispose()
    }
  })
  exit.catch(() => undefined)
  return exit
}
