import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Test-first suites load the production module they specify through this loader instead
// of a static import. Until the owning task creates the module, every test that needs it
// fails with a named NOT_IMPLEMENTED diagnostic, the rest of the suite still type-checks,
// and no browser, server, clone, or worktree is started for a subject that does not exist.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export class PendingModuleError extends Error {
  constructor(message: string) {
    super(`NOT_IMPLEMENTED: ${message}`)
    this.name = 'PendingModuleError'
  }
}

/**
 * Imports a repository-relative TypeScript module and requires the named exports. `T` is
 * the contract the calling suite specifies for the module; the suite's own assertions check
 * the behavior behind it.
 */
export async function loadPendingModule<T extends object>(
  relativePath: string,
  task: string,
  exportNames: readonly (keyof T & string)[],
): Promise<T> {
  const absolute = path.join(REPO_ROOT, relativePath)
  if (!existsSync(absolute)) throw new PendingModuleError(`${relativePath} does not exist yet; ${task} implements it.`)
  const module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
  const missing = exportNames.filter((name) => module[name] === undefined)
  if (missing.length > 0) {
    throw new PendingModuleError(`${relativePath} does not export ${missing.join(', ')} yet; ${task} implements it.`)
  }
  return module as T
}
