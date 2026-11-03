import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { createOsTempOutput } from '../evidence/store.js'
import type { TempOutput } from '../evidence/store.js'
import {
  GIT_SAFETY,
  GIT_TIMEOUT_MS,
  adminEntries,
  compareSnapshots,
  git,
  gitEnvironment,
  gitWithInput,
  optionalGit,
  readGit,
  sha256,
  snapshotRepository,
} from '../git/repositoryState.js'
import type { RepositorySnapshot } from '../git/repositoryState.js'
import { MAX_DIFF_BYTES } from '../patch/validateDiff.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'
import { findRegisteredScenario } from '../scenario/registry.js'
import { CandidateApplicationError, createPrivateCandidateApplication } from './capturedCandidate.js'
import type { CandidateApplicationInput, CandidateApplicationOutcome } from './capturedCandidate.js'

// The FlowProof-owned detached worktree. Creation snapshots the complete original repository
// state first, refuses a dirty tracked baseline before any Git metadata exists, and checks out
// the original HEAD detached in OS temporary output with the installed dependencies linked
// entry by entry, so builds never write through into the original checkout. Only the committed
// scenario build argv runs there, and only an already validated one-file diff is applied, to the
// worktree files alone. Disposal removes and prunes nothing but FlowProof's own entry and then
// compares every snapshot facet with the baseline, reporting any mismatch instead of hiding it.

/** Vite's committed output directory, relative to the scenario's `app.root`. */
export const APP_BUILD_OUTPUT_DIR = 'dist'

const MAX_LINKED_ENTRIES = 10_000
// Variables the committed build may see; nothing else, and never a credential, is inherited.
const BUILD_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'COREPACK_HOME', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'] as const

export type WorktreeErrorCode =
  | 'WORKTREE_OPTIONS_INVALID'
  | 'REPOSITORY_UNAVAILABLE'
  | 'WORKTREE_SCENARIO_MISMATCH'
  | 'WORKTREE_COMMAND_NOT_ALLOWED'
  | 'HEAD_MISSING'
  | 'WORKING_TREE_DIRTY'
  | 'WORKTREE_CREATE_FAILED'
  | 'WORKTREE_BUILD_FAILED'
  | 'WORKTREE_BUILD_TIMEOUT'
  | 'WORKTREE_BUILD_ABORTED'
  | 'WORKTREE_BUILD_OUTPUT_INVALID'
  | 'WORKTREE_DIFF_INVALID'
  | 'WORKTREE_DIFF_OUT_OF_SCOPE'
  | 'WORKTREE_APPLY_REPEATED'
  | 'WORKTREE_APPLY_FAILED'
  | 'WORKTREE_APPLY_ABORTED'
  | 'WORKTREE_BASELINE_UNAVAILABLE'
  | 'WORKTREE_HEAD_MOVED'
  | 'WORKTREE_BUSY'
  | 'WORKTREE_DISPOSED'

/** A worktree failure with a stable code; messages never echo paths, commands, diffs, or output. */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode
  /** The post-cleanup comparison when the failure already removed the worktree, else null. */
  readonly integrity: WorktreeIntegrityReport | null

  constructor(code: WorktreeErrorCode, message: string, integrity: WorktreeIntegrityReport | null = null) {
    super(`${code}: ${message}`)
    this.name = 'WorktreeError'
    this.code = code
    this.integrity = integrity
  }
}

/** Snapshot facets compared after cleanup, in reporting order. */
export { SNAPSHOT_FACETS } from '../git/repositoryState.js'
export type { SnapshotFacet } from '../git/repositoryState.js'

export interface WorktreeIntegrityReport {
  readonly unchanged: boolean
  /** Snapshot facets that differ from the pre-run baseline, for example `status`. */
  readonly mismatches: readonly string[]
}

export interface BuildOptions {
  /** Kills the build's whole process group when aborted. */
  readonly signal?: AbortSignal
}

export interface WorktreeSession {
  /** Canonical original repository root. */
  readonly repoRoot: string
  /** Absolute canonical `git rev-parse --git-common-dir` of the original repository. */
  readonly gitCommonDir: string
  readonly originalHead: string
  /** SHA-256 of the pre-run `git status --porcelain=v1 -z --untracked-files=all` output. */
  readonly originalStatusDigest: string
  /** The complete pre-run `git worktree list --porcelain` output. */
  readonly worktreeListBaseline: string
  /** SHA-256 of `worktreeListBaseline`. */
  readonly worktreeListDigest: string
  /** Absolute path of the FlowProof-owned detached worktree under the OS temporary directory. */
  readonly path: string
  /** Runs the committed `app.start_command` inside the worktree; returns the built document root. */
  build(options?: BuildOptions): Promise<{ readonly documentRoot: string }>
  /** Applies an already validated unified diff to the worktree only. */
  applyDiff(unifiedDiff: string): Promise<void>
  /** `git worktree remove --force`, `git worktree prune`, then full snapshot comparison. Idempotent. */
  dispose(): Promise<WorktreeIntegrityReport>
}

export interface CreateWorktreeSessionOptions {
  readonly repoRoot: string
  readonly scenario: LoadedScenario
}

// The shell-free Git runner and the original-repository snapshot live in
// `../git/repositoryState.ts`, shared with the editing runtime's standalone clone.

const runFile = promisify(execFile)

/** True when `git status --porcelain=v1 -z` lists any tracked change; untracked files are allowed. */
const hasTrackedChanges = (status: string): boolean => status.split('\0').some((record) => record !== '' && !record.startsWith('?? '))

// ---------------------------------------------------------------------------------------
// Dependency linking
// ---------------------------------------------------------------------------------------

/**
 * Recreates `node_modules` as a real directory in the worktree whose entries link to the
 * original's installed packages. Tool caches such as Vite's `.vite-temp` then land in the
 * worktree instead of writing through a directory link into the original checkout.
 */
async function linkDependencies(originalDir: string, worktreeDir: string): Promise<void> {
  const source = await realpath(path.join(originalDir, 'node_modules'))
  const target = path.join(worktreeDir, 'node_modules')
  await mkdir(target)
  const entries = (await readdir(source)).filter((name) => !name.startsWith('.') || name === '.bin').sort()
  if (entries.length > MAX_LINKED_ENTRIES) throw new Error('too many dependency entries')
  for (const name of entries) {
    let resolved: string
    try {
      resolved = await realpath(path.join(source, name))
    } catch {
      continue
    }
    await symlink(resolved, path.join(target, name))
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------

const isInside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${path.sep}`)

function readOptions(options: unknown): CreateWorktreeSessionOptions {
  const invalid = (): WorktreeError => new WorktreeError('WORKTREE_OPTIONS_INVALID', 'A repository root and loaded scenario are required.')
  if (typeof options !== 'object' || options === null) throw invalid()
  const { repoRoot, scenario } = options as Partial<CreateWorktreeSessionOptions>
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) throw invalid()
  if (typeof scenario?.scenario?.app?.root !== 'string' || !Array.isArray(scenario.scenario.app.start_command)) throw invalid()
  if (typeof scenario.resolved?.repoRoot !== 'string') throw invalid()
  return { repoRoot, scenario }
}

/** The owned detached worktree shared by the legacy and the captured entry points. */
interface OwnedWorktree {
  readonly repoRoot: string
  readonly gitCommonDir: string
  readonly originalHead: string
  readonly baseline: RepositorySnapshot
  /** The checked-out commit: the original HEAD, or the captured candidate's recorded baseline. */
  readonly checkout: string
  readonly worktreePath: string
  /** The owned temporary root; equals the worktree for the legacy layout. */
  readonly ownedRoot: string
  /** Object format and canonical object directory of a pinned checkout; null for the legacy HEAD. */
  readonly objectFormat: 'sha1' | 'sha256' | null
  readonly objectDirectory: string | null
  /** Runs one build or apply at a time, never after disposal started. */
  exclusive<T>(run: () => Promise<T>): Promise<T>
  /** The committed build; callers run it inside `exclusive`. */
  build(options: BuildOptions): Promise<{ readonly documentRoot: string }>
  readonly disposing: boolean
  /**
   * Idempotent release: stops the build and joins the running operation, runs `afterOperations`,
   * removes and prunes only this worktree, removes the owned output, and compares the baseline.
   */
  release(afterOperations?: () => Promise<void>): Promise<{ readonly report: WorktreeIntegrityReport; readonly worktreeRemoved: boolean }>
}

interface OpenOwnedWorktreeOptions extends CreateWorktreeSessionOptions {
  /** A full commit object ID to check out, or null for the original HEAD. */
  readonly checkout: string | null
  /** Places the worktree in a subdirectory of the owned output, beside other owned state. */
  readonly nested: boolean
}

const FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target)
  } catch {
    return null
  }
}

/** Snapshots the original repository and creates the owned detached worktree at the checkout. */
async function openOwnedWorktree(options: OpenOwnedWorktreeOptions): Promise<OwnedWorktree> {
  const { repoRoot: requestedRoot, scenario } = options
  const app = scenario.scenario.app
  const command = [...app.start_command]
  const buildTimeoutMs = scenario.scenario.timeouts.replay_ms
  const registered = findRegisteredScenario(scenario.scenario.scenario_id)?.build_command
  if (registered === undefined || registered.length !== command.length || registered.some((token, index) => token !== command[index])) {
    throw new WorktreeError('WORKTREE_COMMAND_NOT_ALLOWED', 'Only the registered build command runs in the worktree.')
  }

  // 1. Canonical repository root and Git common directory, also from a linked worktree.
  let repoRoot: string
  let gitCommonDir: string
  try {
    repoRoot = await realpath((await readGit(await realpath(requestedRoot), ['rev-parse', '--show-toplevel'])).trim())
    gitCommonDir = await realpath((await readGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
  } catch {
    throw new WorktreeError('REPOSITORY_UNAVAILABLE', 'The repository root is not a readable Git checkout.')
  }
  if (scenario.resolved.repoRoot !== repoRoot) {
    throw new WorktreeError('WORKTREE_SCENARIO_MISMATCH', 'The scenario was not loaded from this repository root.')
  }

  // A pinned checkout must be the exact recorded full commit in the original object store, in
  // the repository's own object format; it is never inferred from HEAD or a branch. The legacy
  // HEAD checkout performs no additional repository read here.
  let objectFormat: 'sha1' | 'sha256' | null = null
  let objectDirectory: string | null = null
  if (options.checkout !== null) {
    objectFormat = (await optionalGit(repoRoot, ['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1'
    const resolved = await optionalGit(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.checkout}^{commit}`])
    if (resolved !== options.checkout || options.checkout.length !== (objectFormat === 'sha1' ? 40 : 64)) {
      throw new WorktreeError('WORKTREE_BASELINE_UNAVAILABLE', 'The recorded baseline commit is not available in the repository.')
    }
    try {
      objectDirectory = await realpath((await readGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim())
    } catch {
      throw new WorktreeError('REPOSITORY_UNAVAILABLE', 'The repository object store is not readable.')
    }
  }

  // 2. The complete baseline, before any side effect.
  let baseline: RepositorySnapshot
  try {
    baseline = await snapshotRepository(repoRoot, gitCommonDir)
  } catch {
    throw new WorktreeError('REPOSITORY_UNAVAILABLE', 'The original repository state could not be recorded.')
  }
  if (baseline.head === null) throw new WorktreeError('HEAD_MISSING', 'The repository has no HEAD commit.')
  const originalHead = baseline.head
  const checkout = options.checkout ?? originalHead
  if (hasTrackedChanges(baseline.status)) {
    throw new WorktreeError('WORKING_TREE_DIRTY', 'The tracked working tree has uncommitted changes.')
  }
  const appDir = path.join(repoRoot, app.root)
  if (!isInside(repoRoot, appDir) && appDir !== repoRoot) {
    throw new WorktreeError('WORKTREE_SCENARIO_MISMATCH', 'The application root is outside the repository.')
  }

  // 3. The detached worktree at the checkout, with linked offline dependencies.
  let output: TempOutput
  try {
    output = await createOsTempOutput({ purpose: 'worktree', repoRoot })
  } catch {
    throw new WorktreeError('WORKTREE_CREATE_FAILED', 'The temporary worktree location could not be created.')
  }
  const ownedRoot = await realpath(output.path)
  const worktreePath = options.nested ? path.join(ownedRoot, 'worktree') : ownedRoot
  let adminEntry: string | null = null

  let activeBuild: ChildProcess | null = null
  let operation: Promise<unknown> | null = null
  let disposing: Promise<{ readonly report: WorktreeIntegrityReport; readonly worktreeRemoved: boolean }> | null = null

  /** Removes and prunes only this session's worktree, then compares the full baseline. */
  const cleanUp = async (afterOperations?: () => Promise<void>): Promise<{ readonly report: WorktreeIntegrityReport; readonly worktreeRemoved: boolean }> => {
    // A running build is killed, and any operation finishes, before its files are removed.
    if (activeBuild?.pid !== undefined) killGroup(activeBuild.pid)
    await operation?.catch(() => undefined)
    await afterOperations?.().catch(() => undefined)
    await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    await pruneOwnEntry()
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    const worktreeRemoved = (await lstatOrNull(worktreePath)) === null && (adminEntry === null || !(await adminEntries(gitCommonDir)).includes(adminEntry))
    let mismatches: string[]
    try {
      mismatches = compareSnapshots(baseline, await snapshotRepository(repoRoot, gitCommonDir))
    } catch {
      mismatches = ['snapshot']
    }
    return { report: Object.freeze({ unchanged: mismatches.length === 0, mismatches: Object.freeze(mismatches) }), worktreeRemoved }
  }

  /**
   * `git worktree prune` runs only when it would prune nothing but this session's entry; an
   * unrelated prunable entry is left for its owner and only this session's entry is removed.
   */
  const pruneOwnEntry = async (): Promise<void> => {
    const entries = await adminEntries(gitCommonDir)
    const own = adminEntry !== null && entries.includes(adminEntry) ? adminEntry : null
    let candidates: string[] = []
    try {
      const { stdout, stderr } = await runFile('git', ['-C', repoRoot, ...GIT_SAFETY, 'worktree', 'prune', '--dry-run', '--verbose'], {
        encoding: 'utf8',
        env: gitEnvironment(),
        timeout: GIT_TIMEOUT_MS,
      })
      candidates = [...`${stdout}\n${stderr}`.matchAll(/^Removing worktrees\/([^:\n]+):/gm)].map((match) => match[1] ?? '')
    } catch {
      candidates = []
    }
    const onlyOwn = candidates.length > 0 && candidates.every((name) => name === adminEntry)
    if (onlyOwn) await git(repoRoot, ['worktree', 'prune']).catch(() => undefined)
    if (own !== null && (await adminEntries(gitCommonDir)).includes(own) && (await ownsAdminEntry(own))) {
      await rm(path.join(gitCommonDir, 'worktrees', own), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** True when the administrative entry still points at this session's worktree. */
  const ownsAdminEntry = async (name: string): Promise<boolean> => {
    try {
      const gitdir = (await readFile(path.join(gitCommonDir, 'worktrees', name, 'gitdir'), 'utf8')).trim()
      return path.resolve(gitdir) === path.join(worktreePath, '.git')
    } catch {
      return false
    }
  }

  try {
    await git(repoRoot, ['worktree', 'add', '--detach', '--quiet', worktreePath, checkout])
    const created = (await adminEntries(gitCommonDir)).filter((name) => !baseline.worktreeAdminEntries.includes(name))
    for (const name of created) if (await ownsAdminEntry(name)) adminEntry = name
    if (adminEntry === null) throw new Error('the administrative entry is not identifiable')
    if ((await readGit(worktreePath, ['rev-parse', 'HEAD'])).trim() !== checkout) throw new Error('unexpected HEAD')
    const appWorktreeDir = path.join(worktreePath, app.root)
    if (!isInside(worktreePath, await realpath(appWorktreeDir))) throw new Error('application root escapes the worktree')
    // Installed dependencies are linked where present; a build without them fails safely.
    for (const [original, linked] of new Map([
      [repoRoot, worktreePath],
      [appDir, appWorktreeDir],
    ])) {
      if (await isDirectory(path.join(original, 'node_modules'))) await linkDependencies(original, linked)
    }
  } catch {
    const { report: integrity } = await cleanUp()
    await output.remove().catch(() => undefined)
    throw new WorktreeError('WORKTREE_CREATE_FAILED', 'The detached worktree could not be prepared.', integrity)
  }

  /** Runs one build or apply at a time, never after disposal started. */
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    if (disposing !== null) return Promise.reject(new WorktreeError('WORKTREE_DISPOSED', 'The worktree session was disposed.'))
    if (operation !== null) return Promise.reject(new WorktreeError('WORKTREE_BUSY', 'Another worktree operation is running.'))
    const current = run().finally(() => {
      operation = null
    })
    operation = current
    return current
  }

  const runBuild = (signal: AbortSignal | undefined): Promise<'ok' | 'failed' | 'timeout' | 'aborted'> =>
    new Promise((resolve) => {
      const [executable, ...args] = command
      if (signal?.aborted) {
        resolve('aborted')
        return
      }
      if (executable === undefined) {
        resolve('failed')
        return
      }
      // pnpm's Node processes otherwise create `node-compile-cache` under TMPDIR, outside the
      // owned worktree output. Disable it so disposing the session restores the temporary root.
      const env: NodeJS.ProcessEnv = { NO_COLOR: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
      for (const key of BUILD_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
      // Its own process group, so a timeout or abort reaches every process the build started.
      const child = spawn(executable, args, { cwd: worktreePath, env, stdio: 'ignore', detached: true, shell: false })
      activeBuild = child
      let outcome: 'failed' | 'timeout' | 'aborted' | null = null
      const stop = (reason: 'timeout' | 'aborted'): void => {
        outcome ??= reason
        if (child.pid !== undefined) killGroup(child.pid)
      }
      const timer = setTimeout(() => stop('timeout'), buildTimeoutMs)
      const onAbort = (): void => stop('aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
      child.once('error', () => {
        outcome ??= 'failed'
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        activeBuild = null
        resolve(outcome ?? (code === 0 ? 'ok' : 'failed'))
      })
    })

  const build = async (buildOptions: BuildOptions): Promise<{ readonly documentRoot: string }> => {
    const outputDir = path.join(worktreePath, app.root, APP_BUILD_OUTPUT_DIR)
    // A previous build's output never stands in for this one.
    await rm(outputDir, { recursive: true, force: true })
    const outcome = await runBuild(buildOptions.signal)
    if (disposing !== null) throw new WorktreeError('WORKTREE_DISPOSED', 'The worktree session was disposed.')
    if (outcome === 'timeout') throw new WorktreeError('WORKTREE_BUILD_TIMEOUT', 'The committed build command timed out.')
    if (outcome === 'aborted') throw new WorktreeError('WORKTREE_BUILD_ABORTED', 'The committed build command was aborted.')
    if (outcome !== 'ok') throw new WorktreeError('WORKTREE_BUILD_FAILED', 'The committed build command failed.')
    let documentRoot: string
    try {
      documentRoot = await realpath(outputDir)
      if (!isInside(worktreePath, documentRoot) || !(await lstat(path.join(documentRoot, 'index.html'))).isFile()) throw new Error()
    } catch {
      throw new WorktreeError('WORKTREE_BUILD_OUTPUT_INVALID', 'The committed build produced no servable output.')
    }
    return Object.freeze({ documentRoot })
  }

  return Object.freeze({
    repoRoot,
    gitCommonDir,
    originalHead,
    baseline,
    checkout,
    worktreePath,
    ownedRoot,
    objectFormat,
    objectDirectory,
    exclusive,
    build,
    get disposing(): boolean {
      return disposing !== null
    },
    release(afterOperations?: () => Promise<void>) {
      disposing ??= (async () => {
        try {
          return await cleanUp(afterOperations)
        } finally {
          await output.remove().catch(() => undefined)
        }
      })()
      return disposing
    },
  })
}

/** Snapshots the original repository and creates the detached worktree at its HEAD. */
export async function createWorktreeSession(options: CreateWorktreeSessionOptions): Promise<WorktreeSession> {
  const { repoRoot: requestedRoot, scenario } = readOptions(options)
  const permittedSources = [...scenario.scenario.permitted_source_paths]
  const owned = await openOwnedWorktree({ repoRoot: requestedRoot, scenario, checkout: null, nested: false })
  const { originalHead, worktreePath, baseline } = owned
  let applied = false

  return Object.freeze({
    repoRoot: owned.repoRoot,
    gitCommonDir: owned.gitCommonDir,
    originalHead,
    originalStatusDigest: sha256(baseline.status),
    worktreeListBaseline: baseline.worktreeList,
    worktreeListDigest: sha256(baseline.worktreeList),
    path: worktreePath,

    build(buildOptions: BuildOptions = {}): Promise<{ readonly documentRoot: string }> {
      return owned.exclusive(() => owned.build(buildOptions))
    },

    applyDiff(unifiedDiff: string): Promise<void> {
      return owned.exclusive(async () => {
        if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0 || Buffer.byteLength(unifiedDiff, 'utf8') > MAX_DIFF_BYTES) {
          throw new WorktreeError('WORKTREE_DIFF_INVALID', 'The candidate diff must be a bounded, non-empty text patch.')
        }
        if (applied) throw new WorktreeError('WORKTREE_APPLY_REPEATED', 'A candidate diff is applied at most once per worktree.')
        applied = true
        if ((await optionalGit(worktreePath, ['rev-parse', 'HEAD'])) !== originalHead) {
          throw new WorktreeError('WORKTREE_HEAD_MOVED', 'The worktree is no longer at the original HEAD.')
        }
        // Defense in depth: the patch may name only one permitted source file.
        const numstat = await gitWithInput(worktreePath, ['apply', '--numstat', '-z', '-'], unifiedDiff)
        if (numstat.code !== 0) throw new WorktreeError('WORKTREE_APPLY_FAILED', 'The candidate diff could not be read as a patch.')
        const records = numstat.stdout.split('\0').filter(Boolean)
        const target = records.length === 1 ? /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(records[0] ?? '')?.[1] : undefined
        if (target === undefined || !permittedSources.includes(target)) {
          throw new WorktreeError('WORKTREE_DIFF_OUT_OF_SCOPE', 'The candidate diff must change exactly one permitted source file.')
        }
        // Working-tree files only: no index, stage, commit, or shell.
        const applyResult = await gitWithInput(worktreePath, ['apply', '-'], unifiedDiff)
        if (applyResult.code !== 0) throw new WorktreeError('WORKTREE_APPLY_FAILED', 'The candidate diff does not apply to the worktree.')
      })
    },

    async dispose(): Promise<WorktreeIntegrityReport> {
      return (await owned.release()).report
    },
  })
}

// ---------------------------------------------------------------------------------------
// Captured candidate sibling (specs/004-verify-captured-changes)
// ---------------------------------------------------------------------------------------

export interface CreateCapturedWorktreeSessionOptions extends CreateWorktreeSessionOptions {
  /** The candidate's recorded full baseline commit; it may differ from the original HEAD. */
  readonly baselineCommit: string
}

export interface CapturedWorktreeDisposal extends WorktreeIntegrityReport {
  /** The owned worktree directory and its registration are gone. */
  readonly worktreeRemoved: boolean
  /** The private Git directory, index, and object store are gone. */
  readonly privateStateRemoved: boolean
}

export interface CapturedWorktreeSession {
  readonly repoRoot: string
  readonly gitCommonDir: string
  /** The original HEAD when the session was created, recorded independently of the baseline. */
  readonly originalHead: string
  readonly baselineCommit: string
  readonly objectFormat: 'sha1' | 'sha256'
  /** Absolute path of the owned detached worktree at the baseline. */
  readonly path: string
  /** Applies the exact captured candidate once through private Git state. */
  applyCandidate(candidate: CandidateApplicationInput, options?: { readonly signal?: AbortSignal }): Promise<CandidateApplicationOutcome>
  /** Runs the committed build, only after a complete application. */
  build(options?: BuildOptions): Promise<{ readonly documentRoot: string }>
  /** Removes the private state, this worktree, and the owned output, then compares the baseline. Idempotent. */
  dispose(): Promise<CapturedWorktreeDisposal>
}

/**
 * Creates the owned detached worktree at the candidate's recorded baseline. It reuses the
 * clean-tracked-checkout preflight, snapshot, dependency linking, build, and disposal ownership of
 * the legacy session; candidate application goes through private Git state beside the worktree.
 */
export async function createCapturedWorktreeSession(options: CreateCapturedWorktreeSessionOptions): Promise<CapturedWorktreeSession> {
  const { repoRoot: requestedRoot, scenario } = readOptions(options)
  const baselineCommit = (options as Partial<CreateCapturedWorktreeSessionOptions>).baselineCommit
  if (typeof baselineCommit !== 'string' || !FULL_OBJECT_ID.test(baselineCommit)) {
    throw new WorktreeError('WORKTREE_BASELINE_UNAVAILABLE', 'The recorded baseline commit is not available in the repository.')
  }
  const owned = await openOwnedWorktree({ repoRoot: requestedRoot, scenario, checkout: baselineCommit, nested: true })
  const { objectFormat, objectDirectory } = owned
  const privateGitDir = path.join(owned.ownedRoot, 'candidate-git')
  if (objectFormat === null || objectDirectory === null) {
    await owned.release()
    throw new WorktreeError('WORKTREE_CREATE_FAILED', 'The pinned worktree could not be prepared.')
  }
  let application: ReturnType<typeof createPrivateCandidateApplication>
  try {
    application = createPrivateCandidateApplication({ worktreePath: owned.worktreePath, privateGitDir, objectFormat, originalObjectDirectory: objectDirectory })
  } catch {
    await owned.release()
    throw new WorktreeError('WORKTREE_CREATE_FAILED', 'The pinned worktree could not be prepared.')
  }
  let state: 'pending' | 'applied' | 'failed' = 'pending'
  let disposal: Promise<CapturedWorktreeDisposal> | null = null

  return Object.freeze({
    repoRoot: owned.repoRoot,
    gitCommonDir: owned.gitCommonDir,
    originalHead: owned.originalHead,
    baselineCommit,
    objectFormat,
    path: owned.worktreePath,

    applyCandidate(candidate: CandidateApplicationInput, applyOptions: { readonly signal?: AbortSignal } = {}): Promise<CandidateApplicationOutcome> {
      return owned.exclusive(async () => {
        if (typeof candidate !== 'object' || candidate === null || candidate.baselineCommit !== baselineCommit) {
          throw new WorktreeError('WORKTREE_OPTIONS_INVALID', 'The candidate was recorded for a different baseline.')
        }
        if (state !== 'pending') throw new WorktreeError('WORKTREE_APPLY_REPEATED', 'A captured candidate is applied at most once per worktree.')
        state = 'failed'
        if ((await optionalGit(owned.worktreePath, ['rev-parse', 'HEAD'])) !== baselineCommit) {
          throw new WorktreeError('WORKTREE_HEAD_MOVED', 'The worktree is no longer at the recorded baseline.')
        }
        let outcome: CandidateApplicationOutcome
        try {
          outcome = await application.apply(candidate, applyOptions.signal === undefined ? {} : { signal: applyOptions.signal })
        } catch (error) {
          const aborted = error instanceof CandidateApplicationError && error.code === 'APPLICATION_INTERRUPTED'
          throw new WorktreeError(aborted ? 'WORKTREE_APPLY_ABORTED' : 'WORKTREE_APPLY_FAILED', 'The captured candidate application could not run.')
        }
        if (owned.disposing) throw new WorktreeError('WORKTREE_DISPOSED', 'The worktree session was disposed.')
        if (outcome.applied) state = 'applied'
        return outcome
      })
    },

    build(buildOptions: BuildOptions = {}): Promise<{ readonly documentRoot: string }> {
      return owned.exclusive(async () => {
        // An unapplied or partially applied target is never built or presented as tested.
        if (state !== 'applied') throw new WorktreeError('WORKTREE_APPLY_FAILED', 'The captured candidate was not applied completely.')
        return owned.build(buildOptions)
      })
    },

    dispose(): Promise<CapturedWorktreeDisposal> {
      disposal ??= (async () => {
        let privateStateRemoved = false
        const { report, worktreeRemoved } = await owned.release(async () => {
          privateStateRemoved = await application.dispose()
        })
        privateStateRemoved = privateStateRemoved && (await lstatOrNull(privateGitDir)) === null
        return Object.freeze({ ...report, worktreeRemoved, privateStateRemoved })
      })()
      return disposal
    },
  })
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The process group already exited.
  }
}
