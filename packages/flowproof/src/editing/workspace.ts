import { lstat, mkdtemp, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { git, optionalGit, readGit, compareSnapshots, snapshotRepository } from '../git/repositoryState.js'
import type { RepositorySnapshot } from '../git/repositoryState.js'
import type { TaskDocument } from './contracts.js'

// The disposable editing workspace: a session root in operating-system temporary storage holding
// a standalone `--no-hardlinks` clone detached at the exact selected commit and the read-only task
// document. Nothing is linked back to the source: the clone has no remote, alternates, worktree
// registration, or Git file naming the source path. Disposal removes only paths this session
// recorded in its manifest and never enumerates or reads what the agent wrote.

export const SESSION_ROOT_PREFIX = 'flowproof-editing-'
const WORKSPACE_DIR = 'workspace'
const TASK_DOCUMENT_FILE = 'task.json'
// Session paths become Docker bind-mount sources; this charset keeps them free of mount syntax.
const SAFE_HOST_PATH = /^\/[A-Za-z0-9._/-]+$/
// Diagnostic placeholders for host paths that must never reach a result.
export const SESSION_ROOT_PLACEHOLDER = '<session-root>'
export const SOURCE_REPOSITORY_PLACEHOLDER = '<source-repository>'

export type WorkspaceErrorCode =
  | 'REPOSITORY_UNAVAILABLE'
  | 'REVISION_UNAVAILABLE'
  | 'SESSION_ROOT_INSIDE_REPOSITORY'
  | 'SESSION_ROOT_UNSAFE'
  | 'WORKSPACE_PREPARE_FAILED'
  | 'WORKSPACE_STATE_INVALID'

/** A workspace failure with a stable code; messages never echo paths or Git output. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode

  constructor(code: WorkspaceErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

export interface PreparedWorkspace {
  /** The standalone clone, mounted read-write at `/workspace`. */
  readonly workspacePath: string
  /** The session-owned task document, mounted read-only at `/run/flowproof/task.json`. */
  readonly taskDocumentPath: string
  readonly baselineCommit: string
}

export interface WorkspaceDisposal {
  readonly taskDocumentRemoved: boolean
  readonly workspaceRemoved: boolean
  readonly sessionRootRemoved: boolean
}

export interface OriginalIntegrity {
  /** False when the post-session snapshot could not be recorded. */
  readonly verified: boolean
  readonly unchanged: boolean
  /** Snapshot facets that differ from the pre-session baseline. */
  readonly mismatches: readonly string[]
}

export interface PathPlaceholder {
  readonly value: string
  readonly placeholder: string
}

export interface SessionWorkspace {
  /**
   * Canonicalizes the repository root, resolves the exact commit, and records the complete
   * original-repository snapshot. Creates nothing.
   */
  resolve(repositoryRoot: string, revision: string): Promise<void>
  /** Creates the session root, the standalone clone, and the task document. */
  create(document: TaskDocument): Promise<PreparedWorkspace>
  /** The exact paths eligible for cleanup, in creation order. */
  readonly createdPaths: readonly string[]
  /** Host paths known to this session that diagnostics must replace, longest first. */
  pathPlaceholders(): readonly PathPlaceholder[]
  /** Removes the manifest paths; idempotent and safe after partial initialization. */
  dispose(): Promise<WorkspaceDisposal>
  /** Compares the original repository with its pre-session snapshot. */
  verifyOriginal(): Promise<OriginalIntegrity>
}

export interface WorkspaceManager {
  open(): SessionWorkspace
}

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`)

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target)
  } catch {
    return null
  }
}

/** Creates session workspaces under `tmpRoot`, the operating-system temporary directory by default. */
export function createWorkspaceManager(options: { readonly tmpRoot?: string } = {}): WorkspaceManager {
  return Object.freeze({ open: () => openWorkspace(options.tmpRoot ?? tmpdir()) })
}

function openWorkspace(requestedTmpRoot: string): SessionWorkspace {
  let requestedRoot: string | null = null
  let repoRoot: string | null = null
  let gitCommonDir: string | null = null
  let tmpRoot: string | null = null
  let revision: string | null = null
  let baseline: RepositorySnapshot | null = null
  let sessionRoot: string | null = null
  let workspacePath: string | null = null
  let taskDocumentPath: string | null = null
  let creating = false
  const createdPaths: string[] = []

  const resolve = async (repositoryRoot: string, selected: string): Promise<void> => {
    if (baseline !== null) throw new WorkspaceError('WORKSPACE_STATE_INVALID', 'The workspace is already resolved.')
    let root: string
    let common: string
    try {
      const canonical = await realpath(repositoryRoot)
      root = await realpath((await readGit(canonical, ['rev-parse', '--show-toplevel'])).trim())
      if (root !== canonical) throw new Error('not the top level')
      common = await realpath((await readGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    } catch {
      throw new WorkspaceError('REPOSITORY_UNAVAILABLE', 'The repository root is not the top level of a readable Git worktree.')
    }
    // `^{commit}` peels only to a commit, so a blob, tree, or unknown object is refused.
    const resolved = await optionalGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${selected}^{commit}`])
    if (resolved !== selected) throw new WorkspaceError('REVISION_UNAVAILABLE', 'The selected revision is not a commit in this repository.')
    let temporary: string
    try {
      temporary = await realpath(requestedTmpRoot)
    } catch {
      throw new WorkspaceError('SESSION_ROOT_UNSAFE', 'The temporary root is unavailable.')
    }
    if (isInside(root, temporary) || isInside(common, temporary)) {
      throw new WorkspaceError('SESSION_ROOT_INSIDE_REPOSITORY', 'Session state must live outside the original repository.')
    }
    if (!SAFE_HOST_PATH.test(temporary)) throw new WorkspaceError('SESSION_ROOT_UNSAFE', 'The temporary root path cannot be mounted safely.')
    let snapshot: RepositorySnapshot
    try {
      snapshot = await snapshotRepository(root, common)
    } catch {
      throw new WorkspaceError('REPOSITORY_UNAVAILABLE', 'The original repository state could not be recorded.')
    }
    requestedRoot = repositoryRoot
    repoRoot = root
    gitCommonDir = common
    tmpRoot = temporary
    revision = selected
    baseline = snapshot
  }

  /** Fails unless the clone is a standalone, detached, source-free copy of the exact commit. */
  const verifyScrubbed = async (clone: string, source: string, common: string, commit: string): Promise<void> => {
    if ((await readGit(clone, ['rev-parse', 'HEAD'])).trim() !== commit) throw new Error('unexpected HEAD')
    if ((await optionalGit(clone, ['symbolic-ref', '-q', 'HEAD'])) !== null) throw new Error('HEAD is not detached')
    if (!(await lstat(path.join(clone, '.git'))).isDirectory()) throw new Error('the clone uses a gitfile')
    if ((await lstatOrNull(path.join(clone, '.git', 'objects', 'info', 'alternates'))) !== null) throw new Error('alternates remain')
    if ((await readGit(clone, ['remote'])).trim() !== '') throw new Error('a remote remains')
    const config = (await optionalGit(clone, ['config', '--local', '--list'])) ?? ''
    if (config.includes(source) || config.includes(common) || /^remote\./m.test(config)) throw new Error('configuration names the source')
  }

  const create = async (document: TaskDocument): Promise<PreparedWorkspace> => {
    if (repoRoot === null || gitCommonDir === null || tmpRoot === null || revision === null || creating) {
      throw new WorkspaceError('WORKSPACE_STATE_INVALID', 'The workspace must be resolved once before it is created.')
    }
    creating = true
    const source = repoRoot
    const common = gitCommonDir
    const temporary = tmpRoot
    const commit = revision
    try {
      const root = await realpath(await mkdtemp(path.join(temporary, SESSION_ROOT_PREFIX)))
      sessionRoot = root
      createdPaths.push(root)
      if (!SAFE_HOST_PATH.test(root) || path.dirname(root) !== temporary) throw new Error('unsafe session root')

      const clone = path.join(root, WORKSPACE_DIR)
      workspacePath = clone
      createdPaths.push(clone)
      // Standalone copy: no hardlinks, templates, hooks, checkout of the source HEAD, or alternates.
      await git(root, ['clone', '--no-hardlinks', '--no-checkout', '--quiet', '--template=', '--', source, clone])
      await git(clone, ['checkout', '--detach', '--quiet', commit])
      await git(clone, ['remote', 'remove', 'origin'])
      await git(clone, ['reflog', 'expire', '--expire=all', '--all'])
      await verifyScrubbed(clone, source, common, commit)

      const taskFile = path.join(root, TASK_DOCUMENT_FILE)
      taskDocumentPath = taskFile
      createdPaths.push(taskFile)
      const content = `${JSON.stringify({ task: document.task, declaredProjectCommands: [...document.declaredProjectCommands] })}\n`
      await writeFile(taskFile, content, { flag: 'wx', mode: 0o444 })
      return Object.freeze({ workspacePath: clone, taskDocumentPath: taskFile, baselineCommit: commit })
    } catch {
      throw new WorkspaceError('WORKSPACE_PREPARE_FAILED', 'The disposable editing workspace could not be prepared.')
    }
  }

  /** Removes one manifest path beneath the session root; true when it no longer exists. */
  const removeOwned = async (target: string | null, kind: 'file' | 'tree' | 'directory'): Promise<boolean> => {
    if (target === null) return true
    if (sessionRoot === null || !isInside(sessionRoot, target) || !createdPaths.includes(target)) return false
    const before = await lstatOrNull(target)
    if (before === null) return true
    try {
      if (kind === 'file') await unlink(target)
      else if (kind === 'tree') await rm(target, { recursive: true, force: true })
      // The session root itself is removed only once empty, so nothing unrecorded is deleted.
      else await rmdir(target)
    } catch {
      // Reported through the existence check below.
    }
    return (await lstatOrNull(target)) === null
  }

  const dispose = async (): Promise<WorkspaceDisposal> => {
    const taskDocumentRemoved = await removeOwned(taskDocumentPath, 'file')
    const workspaceRemoved = await removeOwned(workspacePath, 'tree')
    const rootInfo = sessionRoot === null ? null : await lstatOrNull(sessionRoot)
    const sessionRootRemoved =
      rootInfo === null || (rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && (await removeOwned(sessionRoot, 'directory')))
    return Object.freeze({ taskDocumentRemoved, workspaceRemoved, sessionRootRemoved })
  }

  const verifyOriginal = async (): Promise<OriginalIntegrity> => {
    // Without a baseline the session never created anything that could change the original.
    if (baseline === null || repoRoot === null || gitCommonDir === null) return Object.freeze({ verified: true, unchanged: true, mismatches: Object.freeze([]) })
    try {
      const mismatches = compareSnapshots(baseline, await snapshotRepository(repoRoot, gitCommonDir))
      return Object.freeze({ verified: true, unchanged: mismatches.length === 0, mismatches: Object.freeze(mismatches) })
    } catch {
      return Object.freeze({ verified: false, unchanged: false, mismatches: Object.freeze(['snapshot']) })
    }
  }

  const pathPlaceholders = (): readonly PathPlaceholder[] => {
    const entries: PathPlaceholder[] = []
    if (sessionRoot !== null) {
      entries.push({ value: sessionRoot, placeholder: SESSION_ROOT_PLACEHOLDER })
      // The unique directory name alone also identifies the host location.
      entries.push({ value: path.basename(sessionRoot), placeholder: SESSION_ROOT_PLACEHOLDER })
    }
    for (const source of [gitCommonDir, repoRoot, requestedRoot]) {
      if (source !== null && source !== path.sep) entries.push({ value: source, placeholder: SOURCE_REPOSITORY_PLACEHOLDER })
    }
    return Object.freeze(entries.sort((left, right) => right.value.length - left.value.length))
  }

  return {
    resolve,
    create,
    get createdPaths(): readonly string[] {
      return Object.freeze([...createdPaths])
    },
    pathPlaceholders,
    dispose,
    verifyOriginal,
  }
}
