import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

import { GIT_SAFETY, GIT_TIMEOUT_MS, MAX_GIT_OUTPUT_BYTES, gitEnvironment } from '../git/repositoryState.js'

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
