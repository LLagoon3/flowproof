import { lstat, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { CandidateFile } from '../editing/capture.js'
import { CaptureStopError, captureGitEnvironment, createCaptureBudget, runCaptureGit } from '../editing/captureGit.js'
import type { CaptureGitOptions, CaptureGitResult } from '../editing/captureGit.js'
import { gitEnvironment } from '../git/repositoryState.js'

// Exact application of one captured candidate (specs/004-verify-captured-changes) to an owned
// worktree that is checked out at the candidate's recorded baseline. Every metadata write goes to
// an owned private bare Git directory, index, and object store outside the candidate content; the
// original object directory is read only as an alternate, so no candidate blob, tree, index entry,
// or ref reaches the original repository. The private index is seeded from the pinned baseline
// and its stat information refreshed before Git's full `--check --index --binary` precheck; the
// exact patch bytes are then applied once. Default Git path and link safety stays on: no
// `--unsafe-paths`, `--reject`, 3-way merge, whitespace repair, hooks, filters, or partial
// continuation. Afterwards the raw NUL-delimited private-index diff against the baseline must
// equal the candidate's file summary (raw path bytes, operation, modes, object IDs) and the
// worktree files must equal the private index. Gitlinks stay commit references: nothing is
// checked out, read, or fetched inside them. Results carry fixed facts only, never Git output,
// paths, or content.

export const CANDIDATE_APPLICATION_FAILURES = ['BASELINE_UNAVAILABLE', 'APPLICATION_REJECTED', 'APPLICATION_FIDELITY_MISMATCH'] as const
export type CandidateApplicationFailure = (typeof CANDIDATE_APPLICATION_FAILURES)[number]

export type CandidateApplicationOutcome =
  | { readonly applied: true; readonly tree: string; readonly files: number }
  | { readonly applied: false; readonly reason: CandidateApplicationFailure }

/** The parts of an owned candidate snapshot that application reads. */
export interface CandidateApplicationInput {
  readonly baselineCommit: string
  readonly patch: Uint8Array
  readonly files: readonly CandidateFile[]
}

export type CandidateApplicationErrorCode = 'APPLICATION_OPTIONS_INVALID' | 'APPLICATION_REPEATED' | 'APPLICATION_DISPOSED' | 'APPLICATION_INTERRUPTED' | 'APPLICATION_IO_FAILED'

/** Application could not run; the message never carries Git output, paths, or content. */
export class CandidateApplicationError extends Error {
  readonly code: CandidateApplicationErrorCode

  constructor(code: CandidateApplicationErrorCode) {
    super(`${code}: the captured candidate application could not run.`)
    this.name = 'CandidateApplicationError'
    this.code = code
  }
}

export interface PrivateCandidateApplicationOptions {
  /** The owned worktree, already checked out detached at the candidate baseline. */
  readonly worktreePath: string
  /** A not-yet-existing owned path outside the worktree for the private Git state. */
  readonly privateGitDir: string
  readonly objectFormat: 'sha1' | 'sha256'
  /** The trusted original object directory, read only as an alternate. */
  readonly originalObjectDirectory: string
}

export interface PrivateCandidateApplication {
  /** Applies the exact candidate bytes at most once. */
  apply(candidate: CandidateApplicationInput, options?: { readonly signal?: AbortSignal }): Promise<CandidateApplicationOutcome>
  /** Removes the private Git state; idempotent. True when nothing of it remains. */
  dispose(): Promise<boolean>
}

const NULL_MODE = '000000'
const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ADMT])$/
const OBJECT_ID = { sha1: /^[a-f0-9]{40}$/, sha256: /^[a-f0-9]{64}$/ } as const
const OPERATION_STATUS: Readonly<Record<CandidateFile['operation'], readonly string[]>> = { added: ['A'], deleted: ['D'], modified: ['M', 'T'] }
/** Shared by the precheck and the single application; Git's default path and link safety stays on. */
const APPLY_FLAGS = ['--index', '--binary', '--whitespace=nowarn', '-'] as const

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`)

interface RawIndexChange {
  readonly status: string
  readonly oldMode: string
  readonly newMode: string
  readonly oldObjectId: string
  readonly newObjectId: string
  readonly path: Buffer
}

/** `diff-index --cached -z --raw`: alternating metadata and raw path records; null when malformed. */
function parseRaw(stdout: Buffer): RawIndexChange[] | null {
  const records: Buffer[] = []
  let start = 0
  for (let end = stdout.indexOf(0, start); end !== -1; end = stdout.indexOf(0, start)) {
    records.push(stdout.subarray(start, end))
    start = end + 1
  }
  if (start !== stdout.length || records.length % 2 !== 0) return null
  const changes: RawIndexChange[] = []
  for (let index = 0; index < records.length; index += 2) {
    const match = RAW_RECORD.exec((records[index] as Buffer).toString('latin1'))
    const rawPath = records[index + 1] as Buffer
    if (match === null || rawPath.length === 0) return null
    const [, oldMode, newMode, oldObjectId, newObjectId, status] = match as unknown as [string, string, string, string, string, string]
    changes.push({ status, oldMode, newMode, oldObjectId, newObjectId, path: Buffer.from(rawPath) })
  }
  return changes
}

/** True when the private-index changes are exactly the candidate's summary. */
function matchesSummary(changes: readonly RawIndexChange[], files: readonly CandidateFile[], format: 'sha1' | 'sha256'): boolean {
  if (changes.length !== files.length) return false
  const zero = '0'.repeat(format === 'sha1' ? 40 : 64)
  const byPath = new Map(changes.map((change) => [change.path.toString('hex'), change]))
  if (byPath.size !== changes.length) return false
  return files.every((file) => {
    const change = byPath.get(file.path.toString('hex'))
    return (
      change !== undefined &&
      OPERATION_STATUS[file.operation].includes(change.status) &&
      change.oldMode === (file.oldMode ?? NULL_MODE) &&
      change.newMode === (file.newMode ?? NULL_MODE) &&
      change.oldObjectId === (file.oldObjectId ?? zero) &&
      change.newObjectId === (file.newObjectId ?? zero)
    )
  })
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

export function createPrivateCandidateApplication(options: PrivateCandidateApplicationOptions): PrivateCandidateApplication {
  const { worktreePath, privateGitDir, objectFormat, originalObjectDirectory } = options
  if (
    ![worktreePath, privateGitDir, originalObjectDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value)) ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256') ||
    isInside(worktreePath, privateGitDir) ||
    isInside(privateGitDir, worktreePath)
  ) {
    throw new CandidateApplicationError('APPLICATION_OPTIONS_INVALID')
  }
  let started = false
  let created = false
  let running: Promise<unknown> | null = null
  let disposing: Promise<boolean> | null = null
  // Disposal stops a running application itself instead of waiting for its caller's signal.
  const disposed = new AbortController()

  const run = async (candidate: CandidateApplicationInput, signal: AbortSignal | undefined): Promise<CandidateApplicationOutcome> => {
    const baseline = candidate.baselineCommit
    // Owned copies: nothing the caller holds can change the bytes between precheck and apply.
    const patch = Buffer.from(candidate.patch)
    const files = [...candidate.files]
    if (typeof baseline !== 'string' || !OBJECT_ID[objectFormat].test(baseline)) return { applied: false, reason: 'BASELINE_UNAVAILABLE' }
    if (patch.length === 0 || files.length === 0) return { applied: false, reason: 'APPLICATION_REJECTED' }
    const budget = createCaptureBudget({ signal: signal === undefined ? disposed.signal : AbortSignal.any([signal, disposed.signal]) })
    try {
      try {
        await mkdir(privateGitDir, { mode: 0o700 })
      } catch {
        throw new CaptureStopError('io')
      }
      created = true
      await runCaptureGit(budget, ['init', '--bare', '--quiet', '--template=', `--object-format=${objectFormat}`, '--', privateGitDir], {
        cwd: path.dirname(privateGitDir),
        env: gitEnvironment(),
      })
      const env = captureGitEnvironment({
        gitDir: privateGitDir,
        workTree: worktreePath,
        indexFile: path.join(privateGitDir, 'index'),
        alternateObjectDirectory: originalObjectDirectory,
      })
      const git = (args: readonly string[], extra: Partial<CaptureGitOptions> = {}): Promise<CaptureGitResult> =>
        runCaptureGit(budget, args, { cwd: worktreePath, env, ...extra })

      // The recorded full commit, through the read-only alternate; never a branch or HEAD.
      const resolved = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseline}^{commit}`], { okCodes: [0, 1, 128] })
      if (resolved.code !== 0 || resolved.stdout.toString('latin1').trim() !== baseline) return { applied: false, reason: 'BASELINE_UNAVAILABLE' }
      await git(['read-tree', baseline])
      // `read-tree` leaves empty stat information; refresh it so `--index` compares real files.
      await git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] })

      const precheck = await git(['apply', '--check', ...APPLY_FLAGS], { input: patch, okCodes: [0, 1, 128] })
      if (precheck.code !== 0) return { applied: false, reason: 'APPLICATION_REJECTED' }
      const applied = await git(['apply', ...APPLY_FLAGS], { input: patch, okCodes: [0, 1, 128] })
      if (applied.code !== 0) return { applied: false, reason: 'APPLICATION_REJECTED' }

      const diff = await git(['diff-index', '--cached', '-z', '--raw', '--no-abbrev', '--no-renames', '--ignore-submodules=none', baseline])
      const changes = parseRaw(diff.stdout)
      if (changes === null) throw new CaptureStopError('io')
      if (!matchesSummary(changes, files, objectFormat)) return { applied: false, reason: 'APPLICATION_FIDELITY_MISMATCH' }
      // The worktree files equal the private index; gitlinks are references and never inspected.
      await git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] })
      const worktree = await git(['diff-files', '--quiet', '--ignore-submodules=all'], { okCodes: [0, 1] })
      if (worktree.code !== 0) return { applied: false, reason: 'APPLICATION_FIDELITY_MISMATCH' }
      const tree = (await git(['write-tree'])).stdout.toString('latin1').trim()
      if (!OBJECT_ID[objectFormat].test(tree)) throw new CaptureStopError('io')
      return Object.freeze({ applied: true, tree, files: files.length })
    } catch (error) {
      const kind = budget.stopped ?? (error instanceof CaptureStopError ? error.kind : 'io')
      throw new CandidateApplicationError(kind === 'interrupted' ? 'APPLICATION_INTERRUPTED' : 'APPLICATION_IO_FAILED')
    } finally {
      budget.dispose()
    }
  }

  return Object.freeze({
    apply(candidate: CandidateApplicationInput, applyOptions: { readonly signal?: AbortSignal } = {}): Promise<CandidateApplicationOutcome> {
      if (disposing !== null) return Promise.reject(new CandidateApplicationError('APPLICATION_DISPOSED'))
      if (started) return Promise.reject(new CandidateApplicationError('APPLICATION_REPEATED'))
      started = true
      const current = run(candidate, applyOptions.signal)
      running = current.catch(() => undefined)
      return current
    },

    dispose(): Promise<boolean> {
      disposing ??= (async () => {
        // A running application is stopped; every Git process group of it is joined (the capture
        // Git runner joins each group) before its state is removed.
        disposed.abort()
        await running
        if (created) await rm(privateGitDir, { recursive: true, force: true }).catch(() => undefined)
        return !(await exists(privateGitDir))
      })()
      return disposing
    },
  })
}
