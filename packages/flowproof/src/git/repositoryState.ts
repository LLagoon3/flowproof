import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { canonicalJson } from '../evidence/store.js'

// The shell-free Git runner and the complete original-repository snapshot shared by the
// detached replay worktree and the standalone editing clone. Git runs without a shell, inherited
// `GIT_*` overrides, credentials, global or system configuration, hooks, or filesystem monitor,
// and every call is bounded in time and output.

export const GIT_TIMEOUT_MS = 60_000
export const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024

const runFile = promisify(execFile)

// Git sees no `GIT_*` overrides, credentials, global or system configuration, hooks, or
// filesystem monitor; only the repository's own configuration applies.
export const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
})

export const GIT_SAFETY = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const

/** A Git failure; it never carries Git's output, which can contain paths or configuration. */
export class GitFailure extends Error {
  constructor() {
    super('git failed')
  }
}

/** Runs Git without a shell; read-only callers pass `optionalLocks: false` to avoid index refreshes. */
export async function git(cwd: string, args: readonly string[], options: { readonly optionalLocks?: boolean } = {}): Promise<string> {
  const lockArgs = options.optionalLocks === false ? ['--no-optional-locks'] : []
  try {
    const { stdout } = await runFile('git', [...lockArgs, '-C', cwd, ...GIT_SAFETY, ...args], {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
    })
    return stdout
  } catch {
    throw new GitFailure()
  }
}

export const readGit = (cwd: string, args: readonly string[]): Promise<string> => git(cwd, args, { optionalLocks: false })

export async function optionalGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await readGit(cwd, args)).trim()
  } catch {
    return null
  }
}

/** Runs Git with `input` on stdin; resolves with the exit code and bounded stdout. */
export function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...GIT_SAFETY, ...args], {
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_GIT_OUTPUT_BYTES) chunks.push(chunk)
    })
    child.on('error', () => resolve({ code: null, stdout: '' }))
    child.on('close', (code) => resolve({ code: size <= MAX_GIT_OUTPUT_BYTES ? code : null, stdout: Buffer.concat(chunks).toString('utf8') }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

// ---------------------------------------------------------------------------------------
// Original-repository snapshot
// ---------------------------------------------------------------------------------------

/** Snapshot facets compared after cleanup, in reporting order. */
export const SNAPSHOT_FACETS = [
  'gitCommonDir',
  'head',
  'branch',
  'status',
  'index',
  'refs',
  'history',
  'localConfig',
  'worktreeList',
  'worktreeAdminEntries',
  'trackedFiles',
] as const
export type SnapshotFacet = (typeof SNAPSHOT_FACETS)[number]

export interface RepositorySnapshot {
  readonly gitCommonDir: string
  readonly head: string | null
  readonly branch: string | null
  readonly status: string
  readonly index: string
  readonly refs: string
  readonly history: string
  readonly localConfig: string
  readonly worktreeList: string
  readonly worktreeAdminEntries: readonly string[]
  readonly trackedFiles: Readonly<Record<string, string>>
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function trackedFileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const file of (await readGit(root, ['ls-files', '-z'])).split('\0').filter(Boolean)) {
    const absolute = path.join(root, file)
    try {
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) hashes[file] = `symlink:${await readlink(absolute)}`
      else if (info.isFile()) hashes[file] = sha256(await readFile(absolute))
      else hashes[file] = info.isDirectory() ? 'directory' : 'other'
    } catch {
      hashes[file] = 'missing'
    }
  }
  return hashes
}

/** Administrative worktree entries under the common directory, sorted; empty when absent. */
export async function adminEntries(gitCommonDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(gitCommonDir, 'worktrees'))).sort()
  } catch {
    return []
  }
}

/**
 * Tracked contents, status, index, branch, HEAD, refs and history, local configuration, the
 * complete `git worktree list --porcelain` output, and the administrative worktree entries
 * under the common directory. Ignored files, such as `.flowproof/runs/`, are not part of it.
 */
export async function snapshotRepository(root: string, gitCommonDir: string): Promise<RepositorySnapshot> {
  const head = await optionalGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return {
    gitCommonDir,
    head,
    branch: await optionalGit(root, ['symbolic-ref', '-q', 'HEAD']),
    status: await readGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    index: await readGit(root, ['ls-files', '--stage', '-z']),
    refs: await readGit(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    history: head === null ? '' : await readGit(root, ['rev-list', '--all']),
    localConfig: (await optionalGit(root, ['config', '--local', '--list'])) ?? '',
    worktreeList: await readGit(root, ['worktree', 'list', '--porcelain']),
    worktreeAdminEntries: await adminEntries(gitCommonDir),
    trackedFiles: head === null ? {} : await trackedFileHashes(root),
  }
}

/** Snapshot facets that differ, in `SNAPSHOT_FACETS` order. */
export function compareSnapshots(before: RepositorySnapshot, after: RepositorySnapshot): string[] {
  return SNAPSHOT_FACETS.filter((facet) => canonicalJson(before[facet]) !== canonicalJson(after[facet]))
}
