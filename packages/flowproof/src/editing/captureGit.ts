import { spawn } from 'node:child_process'
import { lstat, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { GIT_SAFETY, GIT_TIMEOUT_MS, MAX_GIT_OUTPUT_BYTES, gitEnvironment } from '../git/repositoryState.js'
import type { CaptureWorkspace } from './workspace.js'

// The binary-safe, shell-free Git runner for change capture (specs/003-capture-editing-candidate).
// The existing helper decodes UTF-8 and collapses every failure; capture needs lossless bytes in
// both directions and distinguishes interruption, budget exhaustion, and operational failure.
// One budget object carries the whole capture phase: a single deadline and a cumulative byte
// count across Git stdout/stderr and raw payload reads. Each Git process runs in its own process
// group. On deadline, abort, or overflow the group is killed, and a call settles only after the
// group is gone, so no capture process can outlive the workspace it reads.

/** One deadline for the entire capture phase, reusing the existing Git-helper timeout. */
export const CAPTURE_DEADLINE_MS = GIT_TIMEOUT_MS
/** One cumulative materialization budget, reusing the existing Git-helper output bound. */
export const CAPTURE_BYTE_BUDGET = MAX_GIT_OUTPUT_BYTES

/** How long a killed process group may take to disappear before capture reports a failure. */
const GROUP_JOIN_MS = 10_000
const GROUP_POLL_MS = 10

/** Why capture stopped: budget or deadline, caller interruption, unrepresentable entry, or I/O. */
export type CaptureStopKind = 'limit' | 'interrupted' | 'unrepresentable' | 'io'

/** A stopped capture step; the message is fixed and never carries Git output or a path. */
export class CaptureStopError extends Error {
  constructor(readonly kind: CaptureStopKind) {
    super(`CAPTURE_STOPPED: ${kind}`)
    this.name = 'CaptureStopError'
  }
}

export interface CaptureBudget {
  readonly deadlineMs: number
  readonly byteLimit: number
  /** Bytes consumed so far across every Git stream and raw payload read. */
  readonly consumed: number
  /** The recorded stop, or null while the budget is usable. */
  readonly stopped: CaptureStopKind | null
  /** Aborted once the deadline passes, the budget overflows, or the caller aborts. */
  readonly signal: AbortSignal
  /** Throws the recorded stop when the budget can no longer be used. */
  check(): void
  /** Accounts `bytes`; past the limit it stops every running capture process and throws. */
  consume(bytes: number): void
  /** Clears the deadline timer and caller listener. */
  dispose(): void
}

export interface CaptureBudgetOptions {
  /** Caller cancellation; reported as `interrupted`. */
  readonly signal?: AbortSignal
  /** Test-only narrower values; capture itself always uses the fixed defaults. */
  readonly deadlineMs?: number
  readonly byteLimit?: number
}

export function createCaptureBudget(options: CaptureBudgetOptions = {}): CaptureBudget {
  const deadlineMs = options.deadlineMs ?? CAPTURE_DEADLINE_MS
  const byteLimit = options.byteLimit ?? CAPTURE_BYTE_BUDGET
  const controller = new AbortController()
  let consumed = 0
  let stopped: CaptureStopKind | null = null
  const stop = (kind: CaptureStopKind): void => {
    if (stopped !== null) return
    stopped = kind
    controller.abort()
  }
  const timer = setTimeout(() => stop('limit'), deadlineMs)
  const onAbort = (): void => stop('interrupted')
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    deadlineMs,
    byteLimit,
    get consumed() {
      return consumed
    },
    get stopped() {
      return stopped
    },
    signal: controller.signal,
    check(): void {
      if (stopped !== null) throw new CaptureStopError(stopped)
    },
    consume(bytes: number): void {
      if (stopped !== null) throw new CaptureStopError(stopped)
      consumed += bytes
      if (consumed > byteLimit) {
        stop('limit')
        throw new CaptureStopError('limit')
      }
    },
    dispose(): void {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    },
  }
}

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

export interface CaptureGitPaths {
  /** The private capture Git directory; never the editor's `.git`. */
  readonly gitDir: string
  readonly workTree: string
  readonly indexFile: string
  /** The trusted original object directory, read as an alternate. */
  readonly alternateObjectDirectory?: string
}

/** Git splits alternates on `:`; a path containing it, a quote, or a backslash is C-quoted. */
const quoteAlternate = (directory: string): string =>
  /[:"\\\n]/.test(directory) ? `"${directory.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"` : directory

/**
 * The complete capture environment: the existing sanitized Git environment, trusted session
 * paths, and no system attributes, replace objects, pager, or advice. Commands that take
 * pathspecs pass `--literal-pathspecs` themselves; `check-ignore` rejects that global mode.
 */
export function captureGitEnvironment(paths: CaptureGitPaths): NodeJS.ProcessEnv {
  return {
    ...gitEnvironment(),
    GIT_DIR: paths.gitDir,
    GIT_WORK_TREE: paths.workTree,
    GIT_INDEX_FILE: paths.indexFile,
    ...(paths.alternateObjectDirectory === undefined ? {} : { GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(paths.alternateObjectDirectory) }),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ADVICE: '0',
  }
}

/**
 * Existing hook and monitor safety plus host-side defaults: no user attributes or excludes file,
 * no untracked cache or split index, no automatic maintenance, and no CRLF safety warnings.
 */
export const CAPTURE_GIT_SAFETY = [
  ...GIT_SAFETY,
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
] as const

// ---------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------

export interface CaptureGitOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly input?: Uint8Array
  /** Exit codes that are not failures; defaults to `[0]`. */
  readonly okCodes?: readonly number[]
}

export interface CaptureGitResult {
  readonly code: number
  readonly stdout: Buffer
}

const groupSignalable = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * True while a live (non-zombie) member of the group exists. A killed descendant is reparented
 * to the nearest reaper, which may reap it late; a zombie can no longer run or touch files, so
 * Linux `/proc` state decides. Elsewhere the signal probe alone decides.
 */
async function groupAlive(pgid: number): Promise<boolean> {
  if (!groupSignalable(pgid)) return false
  if (process.platform !== 'linux') return true
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'latin1')
      // `pid (comm) state ppid pgrp ...`; comm may contain spaces or parentheses.
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(pgrp) === pgid && state !== 'Z' && state !== 'X') return true
    } catch {
      // The process exited while it was being inspected.
    }
  }
  return false
}

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Kills any remaining member of the capture-owned group and waits until none remains. */
async function joinGroup(pgid: number): Promise<boolean> {
  const deadline = Date.now() + GROUP_JOIN_MS
  while (await groupAlive(pgid)) {
    killGroup(pgid)
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS))
  }
  return true
}

/**
 * Runs one Git command in a new process group and returns its exact stdout bytes. Raw stderr is
 * counted against the budget and discarded. Settles only after the whole group has exited.
 */
export async function runCaptureGit(budget: CaptureBudget, args: readonly string[], options: CaptureGitOptions): Promise<CaptureGitResult> {
  budget.check()
  const okCodes = options.okCodes ?? [0]
  const child = spawn('git', [...CAPTURE_GIT_SAFETY, ...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    shell: false,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  let stop: CaptureStopKind | null = null
  const halt = (kind: CaptureStopKind): void => {
    stop ??= kind
    if (child.pid !== undefined) killGroup(child.pid)
  }
  const chunks: Buffer[] = []
  const account = (chunk: Buffer, keep: boolean): void => {
    if (stop !== null) return
    try {
      budget.consume(chunk.length)
      if (keep) chunks.push(chunk)
    } catch (error) {
      halt(error instanceof CaptureStopError ? error.kind : 'limit')
    }
  }
  const onAbort = (): void => {
    try {
      budget.check()
    } catch (error) {
      halt(error instanceof CaptureStopError ? error.kind : 'interrupted')
    }
  }
  budget.signal.addEventListener('abort', onAbort, { once: true })

  const exit = await new Promise<{ readonly code: number | null; readonly spawnFailed: boolean }>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => account(chunk, true))
    child.stderr?.on('data', (chunk: Buffer) => account(chunk, false))
    child.once('error', () => resolve({ code: null, spawnFailed: true }))
    child.once('close', (code) => resolve({ code, spawnFailed: false }))
    if (child.stdin !== null) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input))
    }
    // A pre-existing stop (for example an abort racing spawn) still terminates the group.
    if (budget.signal.aborted) onAbort()
  })
  budget.signal.removeEventListener('abort', onAbort)

  // Join every member of the capture-owned group, including a descendant that closed its streams.
  const joined = child.pid === undefined ? true : await joinGroup(child.pid)
  if (stop !== null) throw new CaptureStopError(stop)
  if (!joined || exit.spawnFailed || exit.code === null || !okCodes.includes(exit.code)) throw new CaptureStopError('io')
  return Object.freeze({ code: exit.code, stdout: Buffer.concat(chunks) })
}

// ---------------------------------------------------------------------------------------
// Final-state extraction
// ---------------------------------------------------------------------------------------
//
// The private index is seeded from the pinned baseline. The editor's final index contributes
// path metadata only, so newly force-tracked ignored files stay tracked; staged blob contents and
// the editor HEAD are never trusted. A narrow no-follow walk proves every non-ignored entry is
// representable and every nested Git-directory pointer is contained before any Git command reads
// worktree entries. Git then refreshes and adds the final filesystem under ordinary ignore rules,
// writes one tree, and diffs it against the baseline. Paths stay raw bytes throughout; inside this
// module they are latin1 strings, a byte-exact mapping.

const GITLINK_MODE = '160000'
const MODE_PATTERN = /^[0-7]{6}$/
const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ADMT])$/
/** Upper bound for a nested `.git` pointer file or `commondir` file. */
const MAX_POINTER_BYTES = 4_096

/** One raw `diff-tree` record between the baseline and the captured tree. */
export interface RawChange {
  readonly status: 'A' | 'D' | 'M' | 'T'
  readonly oldMode: string
  readonly newMode: string
  readonly oldObjectId: string
  readonly newObjectId: string
  /** Raw relative path bytes. */
  readonly path: Buffer
}

export interface ExtractedChanges {
  readonly tree: string
  readonly changes: readonly RawChange[]
  /** Empty when there are no changes. */
  readonly patch: Buffer
  /** True when the baseline or the captured tree has a gitlink. */
  readonly hasGitlinks: boolean
}

/** What extraction learned so far, so a later stop can still report known coverage. */
export interface ExtractionProgress {
  gitlinks: 'unknown' | 'present' | 'absent'
}

const fromKey = (key: string): Buffer => Buffer.from(key, 'latin1')
const unrepresentable = (): CaptureStopError => new CaptureStopError('unrepresentable')
const malformed = (): CaptureStopError => new CaptureStopError('io')

async function lstatOrNull(target: string | Buffer): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw error
  }
}

/** Splits NUL-terminated records without decoding them. */
function splitNul(buffer: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let end = buffer.indexOf(0, start); end !== -1; end = buffer.indexOf(0, start)) {
    records.push(buffer.subarray(start, end))
    start = end + 1
  }
  if (start !== buffer.length) throw malformed()
  return records
}

const joinNul = (keys: readonly string[]): Buffer => Buffer.concat(keys.map((key) => Buffer.concat([fromKey(key), Buffer.from([0])])))

/** `ls-files --stage -z`: mode and raw path of every entry. */
function parseStage(stdout: Buffer): Array<{ readonly mode: string; readonly key: string }> {
  return splitNul(stdout).map((record) => {
    const tab = record.indexOf(0x09)
    const mode = tab < 0 ? '' : (record.subarray(0, tab).toString('latin1').split(' ')[0] ?? '')
    if (!MODE_PATTERN.test(mode) || tab + 1 >= record.length) throw malformed()
    return { mode, key: record.subarray(tab + 1).toString('latin1') }
  })
}

/** `diff-tree -r -z --raw`: alternating metadata and raw path records. */
function parseRaw(stdout: Buffer): RawChange[] {
  const records = splitNul(stdout)
  if (records.length % 2 !== 0) throw malformed()
  const changes: RawChange[] = []
  for (let index = 0; index < records.length; index += 2) {
    const match = RAW_RECORD.exec((records[index] as Buffer).toString('latin1'))
    const rawPath = records[index + 1] as Buffer
    if (match === null || rawPath.length === 0) throw malformed()
    const [, oldMode, newMode, oldObjectId, newObjectId, status] = match as unknown as [string, string, string, string, string, RawChange['status']]
    changes.push(Object.freeze({ status, oldMode, newMode, oldObjectId, newObjectId, path: Buffer.from(rawPath) }))
  }
  return changes
}

/** The capture environment for one pinned workspace. */
export function workspaceEnvironment(workspace: CaptureWorkspace): NodeJS.ProcessEnv {
  return captureGitEnvironment({
    gitDir: workspace.gitDir,
    workTree: workspace.workspacePath,
    indexFile: path.join(workspace.gitDir, 'index'),
    alternateObjectDirectory: workspace.objectDirectory,
  })
}

/** Reads a small pointer file without following a final symlink; null when absent. */
async function readPointer(budget: CaptureBudget, target: string | Buffer): Promise<string | null> {
  const info = await lstatOrNull(target)
  if (info === null) return null
  if (!info.isFile() || info.size > MAX_POINTER_BYTES) throw unrepresentable()
  const handle = await open(target, 'r')
  try {
    const content = await handle.readFile()
    budget.consume(content.length)
    return content.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Resolves `target` (relative to `base`) and requires its real location inside the workspace.
 * An external, missing, or linked-out location is never followed.
 */
const slash = Buffer.from('/')

/** Joins a raw filesystem path without decoding workspace-relative Git path bytes. */
const appendPath = (base: Buffer, name: string | Buffer): Buffer =>
  Buffer.concat([base, base.at(-1) === 0x2f ? Buffer.alloc(0) : slash, typeof name === 'string' ? Buffer.from(name) : name])

/** Normalizes an absolute Linux path bytewise, preserving non-UTF-8 path components. */
function normalizeAbsolutePath(value: Buffer): Buffer {
  if (value[0] !== 0x2f) throw unrepresentable()
  const parts: Buffer[] = []
  let start = 1
  for (let end = value.indexOf(0x2f, start); ; end = value.indexOf(0x2f, start)) {
    const part = value.subarray(start, end === -1 ? value.length : end)
    if (part.length === 0 || part.equals(Buffer.from('.'))) {
      // Empty and current-directory components do not change the path.
    } else if (part.equals(Buffer.from('..'))) {
      if (parts.length > 0) parts.pop()
    } else {
      parts.push(Buffer.from(part))
    }
    if (end === -1) break
    start = end + 1
  }
  const normalized: Buffer[] = [slash]
  parts.forEach((part, index) => {
    if (index > 0) normalized.push(slash)
    normalized.push(part)
  })
  return Buffer.concat(normalized)
}

/** Resolves `target` relative to a raw-byte base and requires its real location inside the workspace. */
async function containedRealPath(rootReal: Buffer, base: Buffer, target: string): Promise<Buffer> {
  let resolved: Buffer
  try {
    const targetBytes = Buffer.from(target)
    const combined = targetBytes[0] === 0x2f ? targetBytes : appendPath(base, targetBytes)
    resolved = await realpath(normalizeAbsolutePath(combined), { encoding: 'buffer' })
  } catch {
    throw unrepresentable()
  }
  const contained = resolved.equals(rootReal) ||
    (resolved.length > rootReal.length && resolved.subarray(0, rootReal.length).equals(rootReal) && resolved[rootReal.length] === 0x2f)
  if (!contained) throw unrepresentable()
  return resolved
}

/** Rejects symlinks and special entries in the reference tree Git may read to resolve `HEAD`. */
async function validateReferenceTree(budget: CaptureBudget, directory: Buffer): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'buffer' })
  for (const entry of entries) {
    budget.consume(entry.name.length + 1)
    const child = appendPath(directory, entry.name)
    if (entry.isSymbolicLink()) throw unrepresentable()
    if (entry.isDirectory()) await validateReferenceTree(budget, child)
    else if (!entry.isFile()) throw unrepresentable()
  }
}

/** True when `gitDir` looks like a Git directory; its metadata links must not escape the clone. */
async function isGitDirectory(budget: CaptureBudget, rootReal: Buffer, gitDir: Buffer): Promise<boolean> {
  const headPath = appendPath(gitDir, 'HEAD')
  const refsPath = appendPath(gitDir, 'refs')
  const head = await lstatOrNull(headPath)
  const objects = await lstatOrNull(appendPath(gitDir, 'objects'))
  const refs = await lstatOrNull(refsPath)
  if (head === null || objects === null || refs === null) return false
  // Git may resolve these entries while discovering a nested repository. Do not allow it to
  // follow a host-controlled symlink, including a linked HEAD or object/ref directory.
  if (head.isSymbolicLink() || objects.isSymbolicLink() || refs.isSymbolicLink()) throw unrepresentable()
  if (!head.isFile() || !objects.isDirectory() || !refs.isDirectory()) throw unrepresentable()
  const packedRefs = await lstatOrNull(appendPath(gitDir, 'packed-refs'))
  if (packedRefs !== null && (packedRefs.isSymbolicLink() || !packedRefs.isFile())) throw unrepresentable()
  await validateReferenceTree(budget, refsPath)
  const common = await readPointer(budget, appendPath(gitDir, 'commondir'))
  if (common !== null) await containedRealPath(rootReal, gitDir, common.trim())
  return true
}

/**
 * Classifies the `.git` entry of a workspace directory: absent or not a repository (`false`), a
 * contained nested repository (`true`), or a pointer that would be followed outside (`throw`).
 */
async function nestedRepository(budget: CaptureBudget, rootReal: Buffer, directory: Buffer): Promise<boolean> {
  const marker = appendPath(directory, '.git')
  const info = await lstatOrNull(marker)
  if (info === null) return false
  if (info.isDirectory()) return isGitDirectory(budget, rootReal, marker)
  if (!info.isFile()) throw unrepresentable()
  const pointer = /^gitdir: (.+?)\r?\n?$/.exec((await readPointer(budget, marker)) ?? '')
  if (pointer === null) throw unrepresentable()
  const target = await containedRealPath(rootReal, directory, pointer[1] as string)
  if (!(await isGitDirectory(budget, rootReal, target))) throw unrepresentable()
  return true
}

/** The subset of `keys` that ordinary repository ignore rules exclude, in one batched call. */
async function ignoredKeys(budget: CaptureBudget, root: string, env: NodeJS.ProcessEnv, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  // A leading `./` keeps a name that starts with `:` from being parsed as pathspec magic. Records
  // keep input order; a negated (`!`) last match means not ignored.
  const input = joinNul(keys.map((key) => `./${key}`))
  const { stdout } = await runCaptureGit(budget, ['check-ignore', '--stdin', '-z', '--verbose', '--non-matching', '--no-index'], {
    cwd: root,
    env,
    input,
    okCodes: [0, 1],
  })
  const records = splitNul(stdout)
  if (records.length !== keys.length * 4) throw malformed()
  const ignored = new Set<string>()
  keys.forEach((key, index) => {
    const pattern = records[index * 4 + 2] as Buffer
    if (pattern.length > 0 && pattern[0] !== 0x21) ignored.add(key)
  })
  return ignored
}

type EntryKind = 'file' | 'link' | 'directory' | 'special'
type WorktreeLeafKind = 'file' | 'link' | 'gitlink'

interface WorkspaceWalk {
  readonly entries: ReadonlyMap<string, WorktreeLeafKind>
  /** Directories in the final filesystem, including the roots of nested repositories. */
  readonly directories: ReadonlySet<string>
  /** Directories with at least one filesystem child, including ignored entries. */
  readonly nonEmptyDirectories: ReadonlySet<string>
}

/**
 * Breadth-first no-follow walk. Returns every observed file, link, and nested-repository path.
 * Ignored untracked entries are pruned (one `check-ignore` call per depth); tracked paths and
 * their directories never are. Actual nested repositories are references only: their pointers
 * are checked but their working trees are not entered, regardless of the baseline or index type.
 * A non-ignored entry Git cannot represent stops capture rather than being silently dropped.
 */
async function walkWorkspace(input: {
  readonly budget: CaptureBudget
  readonly root: string
  readonly rootReal: Buffer
  readonly env: NodeJS.ProcessEnv
  readonly tracked: ReadonlySet<string>
  readonly trackedDirectories: ReadonlySet<string>
}): Promise<WorkspaceWalk> {
  const { budget, root, rootReal, env, tracked, trackedDirectories } = input
  const rootBytes = Buffer.from(root)
  const absolute = (key: string): Buffer => (key === '' ? rootBytes : appendPath(rootBytes, fromKey(key)))
  const entries = new Map<string, WorktreeLeafKind>()
  const directories = new Set<string>()
  const nonEmptyDirectories = new Set<string>()
  let level: string[] = ['']
  while (level.length > 0) {
    budget.check()
    const kept: Array<{ readonly key: string; readonly kind: EntryKind }> = []
    const pending: Array<{ readonly key: string; readonly kind: EntryKind }> = []
    for (const directory of level) {
      const entries = await readdir(absolute(directory), { withFileTypes: true, encoding: 'buffer' })
      if (entries.length > 0) nonEmptyDirectories.add(directory)
      for (const entry of entries) {
        const name = entry.name
        budget.consume(name.length + 1)
        // Repository control metadata and nested-repository markers are never content.
        if (name.equals(DOT_GIT)) continue
        const key = directory === '' ? name.toString('latin1') : `${directory}/${name.toString('latin1')}`
        const kind: EntryKind = entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'special'
        if (tracked.has(key) || trackedDirectories.has(key)) kept.push({ key, kind })
        else pending.push({ key, kind })
      }
    }
    const ignored = await ignoredKeys(budget, root, env, pending.map((entry) => entry.key))
    const next: string[] = []
    for (const { key, kind } of [...kept, ...pending.filter((entry) => !ignored.has(entry.key))]) {
      if (kind === 'special') throw unrepresentable()
      if (kind !== 'directory') {
        entries.set(key, kind)
        continue
      }
      const directory = absolute(key)
      directories.add(key)
      if (await nestedRepository(budget, rootReal, directory)) {
        entries.set(key, 'gitlink')
      } else {
        next.push(key)
      }
    }
    level = next
  }
  return { entries, directories, nonEmptyDirectories }
}

const DOT_GIT = Buffer.from('.git')

/** Every proper parent directory of every tracked path. */
function parentDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>()
  for (const key of paths) {
    for (let slash = key.lastIndexOf('/'); slash > 0; slash = key.lastIndexOf('/', slash - 1)) {
      const parent = key.slice(0, slash)
      if (directories.has(parent)) break
      directories.add(parent)
    }
  }
  return directories
}

/**
 * Baseline index entries that cannot coexist with the observed final filesystem shape.
 * Remove them before refreshing or adding so Git cannot preserve a stale gitlink/blob when a
 * directory boundary changed (or treat a nested repository's contents as ordinary files).
 */
function structuralIndexRemovals(
  baseline: readonly { readonly mode: string; readonly key: string }[],
  worktree: WorkspaceWalk,
): string[] {
  return baseline
    .filter((entry) => {
      const finalKind = worktree.entries.get(entry.key)
      if (finalKind !== undefined) {
        const baselineKind: WorktreeLeafKind = entry.mode === GITLINK_MODE ? 'gitlink' : entry.mode === '120000' ? 'link' : 'file'
        if (finalKind !== baselineKind) return true
      } else if (worktree.directories.has(entry.key)) {
        // An empty uninitialized submodule checkout is indistinguishable from a no-op path and
        // remains a reference. Nonempty ordinary contents are an actual gitlink-to-directory
        // transition, even if those children are ignored and therefore not exported.
        if (entry.mode !== GITLINK_MODE || worktree.nonEmptyDirectories.has(entry.key)) return true
      }

      for (let slash = entry.key.lastIndexOf('/'); slash > 0; slash = entry.key.lastIndexOf('/', slash - 1)) {
        if (worktree.entries.has(entry.key.slice(0, slash))) return true
      }
      return false
    })
    .map((entry) => entry.key)
}

/** Builds the private final tree and its raw summary and full-index binary patch. */
export async function extractChanges(budget: CaptureBudget, workspace: CaptureWorkspace, progress: ExtractionProgress): Promise<ExtractedChanges> {
  const root = workspace.workspacePath
  const env = workspaceEnvironment(workspace)
  const git = (args: readonly string[], options: Partial<CaptureGitOptions> = {}): Promise<CaptureGitResult> =>
    runCaptureGit(budget, args, { cwd: root, env, ...options })
  const rootReal = await realpath(root, { encoding: 'buffer' })

  // Only a real `.git` directory and a regular index file inside the clone are read, and only
  // for path metadata. A replaced pointer to elsewhere is never followed.
  const control = await lstatOrNull(path.join(root, '.git'))
  if (control === null || !control.isDirectory()) throw unrepresentable()
  const editorIndex = path.join(root, '.git', 'index')
  const indexInfo = await lstatOrNull(editorIndex)
  if (indexInfo !== null && !indexInfo.isFile()) throw unrepresentable()

  await rm(path.join(workspace.gitDir, 'index'), { force: true })
  await git(['read-tree', workspace.baselineCommit])
  const baseline = parseStage((await git(['ls-files', '--stage', '-z'])).stdout)
  const baselineHasGitlinks = baseline.some((entry) => entry.mode === GITLINK_MODE)
  if (baselineHasGitlinks) progress.gitlinks = 'present'
  const final = indexInfo === null ? [] : parseStage((await git(['ls-files', '--stage', '-z'], { env: { ...env, GIT_INDEX_FILE: editorIndex } })).stdout)

  const baselinePaths = new Set(baseline.map((entry) => entry.key))
  const tracked = new Set([...baselinePaths, ...final.map((entry) => entry.key)])
  const worktree = await walkWorkspace({ budget, root, rootReal, env, tracked, trackedDirectories: parentDirectories(tracked) })

  // Index metadata only identifies explicitly staged ignored additions. Structural transitions
  // come from the real filesystem: remove incompatible baseline entries before any force-add or
  // refresh, while leaving same-shaped tracked entries for Git to refresh from final contents.
  const stale = structuralIndexRemovals(baseline, worktree)
  if (stale.length > 0) await git(['update-index', '--force-remove', '-z', '--stdin'], { input: joinNul(stale) })

  // Newly tracked final-index paths that still exist are added even when ignored; their staged
  // blobs are not used. Every baseline path is refreshed from the filesystem, then ordinary
  // add semantics apply to untracked paths. Missing baseline paths remain deletions.
  const forced = [...new Set(final.map((entry) => entry.key))].filter((key) => !baselinePaths.has(key) && worktree.entries.has(key))
  if (forced.length > 0) {
    await git(['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: joinNul(forced) })
  }
  await git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] })
  await git(['--literal-pathspecs', 'add', '--all'])
  const tree = (await git(['write-tree'])).stdout.toString('latin1').trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw malformed()

  const diff = ['-r', '--no-renames', '--no-commit-id', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv']
  const changes = parseRaw((await git(['diff-tree', ...diff, '-z', '--raw', '--no-abbrev', workspace.baselineCommit, tree])).stdout)
  const hasGitlinks = baselineHasGitlinks || changes.some((change) => change.newMode === GITLINK_MODE)
  progress.gitlinks = hasGitlinks ? 'present' : 'absent'
  const patch =
    changes.length === 0
      ? Buffer.alloc(0)
      : (await git(['diff-tree', ...diff, '--patch', '--binary', '--full-index', '--submodule=short', workspace.baselineCommit, tree])).stdout
  return Object.freeze({ tree, changes: Object.freeze(changes), patch, hasGitlinks })
}

/** Raw bytes of each requested blob, read through the private store and its alternate. */
export async function readBlobs(budget: CaptureBudget, workspace: CaptureWorkspace, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return blobs
  const { stdout } = await runCaptureGit(budget, ['cat-file', '--batch'], {
    cwd: workspace.workspacePath,
    env: workspaceEnvironment(workspace),
    input: Buffer.from(`${unique.join('\n')}\n`, 'latin1'),
  })
  let offset = 0
  for (const id of unique) {
    const newline = stdout.indexOf(0x0a, offset)
    if (newline < 0) throw malformed()
    const [headerId, type, size] = stdout.subarray(offset, newline).toString('latin1').split(' ')
    const length = Number(size)
    if (headerId !== id || type !== 'blob' || !Number.isSafeInteger(length) || length < 0) throw malformed()
    const start = newline + 1
    if (stdout[start + length] !== 0x0a) throw malformed()
    blobs.set(id, Buffer.from(stdout.subarray(start, start + length)))
    offset = start + length + 1
  }
  if (offset !== stdout.length) throw malformed()
  return blobs
}
