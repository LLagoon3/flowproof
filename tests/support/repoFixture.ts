import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Temporary repositories and the complete original-repository integrity snapshot shared by
// the Slice 3A suites. Suites never run FlowProof against the developer's checkout: they
// clone its committed HEAD into the operating-system temporary directory instead.

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/** Runs Git and returns its exit status instead of throwing. */
export function gitStatus(cwd: string, ...args: string[]): number {
  try {
    git(cwd, ...args)
    return 0
  } catch (error) {
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' ? status : -1
  }
}

export interface TempDirectory {
  readonly path: string
  remove(): Promise<void>
}

export async function createTempDirectory(prefix: string): Promise<TempDirectory> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  return { path: directory, remove: () => rm(directory, { recursive: true, force: true }) }
}

const WORKSPACE_PACKAGES = ['.', 'apps/demo-chart', 'apps/studio', 'packages/flowproof'] as const

export interface CloneOptions {
  /**
   * Links the installed dependency trees of the original checkout into the clone, which
   * models the prepared environment where `pnpm install` already ran. The links are
   * excluded through the clone's `info/exclude`, so the clone's status stays clean.
   */
  readonly withDependencies?: boolean
}

/** Clones the committed HEAD of this repository into a fresh temporary directory. */
export async function createTempClone(options: CloneOptions = {}): Promise<TempDirectory> {
  const parent = await createTempDirectory('flowproof-clone-')
  const root = path.join(parent.path, 'repo')
  execFileSync('git', ['clone', '--quiet', REPO_ROOT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(root, 'config', 'user.email', 'flowproof@example.invalid')
  git(root, 'config', 'user.name', 'FlowProof Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  if (options.withDependencies) {
    await appendFile(path.join(root, '.git', 'info', 'exclude'), '\nnode_modules\n')
    for (const pkg of WORKSPACE_PACKAGES) {
      const installed = path.join(REPO_ROOT, pkg, 'node_modules')
      if (existsSync(installed) && existsSync(path.join(root, pkg))) await symlink(installed, path.join(root, pkg, 'node_modules'), 'dir')
    }
  }
  return { path: root, remove: parent.remove }
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

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

function optional(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args).trim()
  } catch {
    return null
  }
}

async function trackedFileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const file of git(root, 'ls-files', '-z').split('\0').filter(Boolean)) {
    const absolute = path.join(root, file)
    try {
      const info = await lstat(absolute)
      hashes[file] = info.isSymbolicLink() ? `symlink:${await readlink(absolute)}` : sha256(await readFile(absolute))
    } catch {
      hashes[file] = 'missing'
    }
  }
  return hashes
}

/**
 * The complete original-repository integrity snapshot: tracked contents and status, index,
 * checked-out branch, HEAD, refs and history, local config, the complete
 * `git worktree list --porcelain` output, and the Git administrative worktree entries under
 * the resolved common directory. Ignored files such as `.flowproof/runs/` are excluded.
 */
export async function snapshotRepository(root: string): Promise<RepositorySnapshot> {
  const gitCommonDir = await realpath(path.resolve(root, git(root, 'rev-parse', '--git-common-dir').trim()))
  const head = optional(root, 'rev-parse', '--verify', '-q', 'HEAD')
  const adminDir = path.join(gitCommonDir, 'worktrees')
  return {
    gitCommonDir,
    head,
    branch: optional(root, 'symbolic-ref', '-q', 'HEAD'),
    status: git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    index: git(root, 'ls-files', '--stage', '-z'),
    refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    history: head === null ? '' : git(root, 'rev-list', '--all'),
    localConfig: git(root, 'config', '--local', '--list'),
    worktreeList: git(root, 'worktree', 'list', '--porcelain'),
    worktreeAdminEntries: existsSync(adminDir) ? (await readdir(adminDir)).sort() : [],
    trackedFiles: head === null ? {} : await trackedFileHashes(root),
  }
}

/** Lists every file and directory below `root`, relative and sorted; empty when absent. */
export async function listTree(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      found.push(child)
      if (entry.isDirectory()) await walk(child)
    }
  }
  await walk('')
  return found.sort()
}

/** PIDs (other than this process) whose command line mentions `needle`, from Linux `/proc`. */
export async function processesMentioning(needle: string): Promise<number[]> {
  const pids: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ')
      if (cmdline.includes(needle)) pids.push(Number(entry))
    } catch {
      // The process exited while it was being inspected.
    }
  }
  return pids
}
