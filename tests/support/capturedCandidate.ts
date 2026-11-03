import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { captureChanges, validateCapturingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureResult, CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import type { CleanupResult, EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import { createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import type { CaptureWorkspace } from '../../packages/flowproof/src/editing/workspace.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import { createTempDirectory } from './repoFixture.js'
import type { TempDirectory } from './repoFixture.js'

// Docker-free producers for the captured-verification suites (specs/004-verify-captured-changes).
// A synthetic "editor" changes a real disposable editing clone with ordinary file operations, the
// existing Spec 003 `captureChanges` extracts the candidate, and the workspace is disposed through
// its own manifest, so the returned `{ session, capture }` value is a real, complete capture
// result with a completed session and a complete cleanup record. Expected final trees are staged
// independently in scratch repositories and read back as raw `ls-tree` entries. The original
// repository inventory covers what candidate application must never touch.

export type ObjectFormat = 'sha1' | 'sha256'
export type EntryMode = '100644' | '100755' | '120000' | '160000'

/** File bytes, link target text, or a gitlink commit ID. */
export interface StateEntry {
  readonly mode: EntryMode
  readonly data: Buffer
}

/** Versioned state keyed by raw path bytes read as latin1, a byte-exact string mapping. */
export type VersionedState = Map<string, StateEntry>

export const file = (content: string | Buffer, mode: '100644' | '100755' = '100644'): StateEntry => ({
  mode,
  data: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8'),
})
export const link = (target: string): StateEntry => ({ mode: '120000', data: Buffer.from(target, 'utf8') })
export const gitlink = (commit: string): StateEntry => ({ mode: '160000', data: Buffer.from(commit, 'utf8') })
/** The state key of raw path bytes. */
export const rawKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')

const COMMIT_IDENTITY = ['-c', 'user.email=captured@example.invalid', '-c', 'user.name=Captured Fixture', '-c', 'commit.gpgsign=false'] as const

/** Runs Git against a scratch repository; throws on failure. */
export function scratchGit(cwd: string, args: readonly string[], input?: Uint8Array): Buffer {
  return execFileSync('git', ['-C', cwd, ...args], {
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

const gitText = (cwd: string, ...args: string[]): string => scratchGit(cwd, args).toString('utf8').trim()

/** Git blob ID of `data`, computed without Git. */
export const blobId = (data: Uint8Array, format: ObjectFormat): string =>
  createHash(format).update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex')

const absoluteKey = (root: string, key: string): Buffer => Buffer.concat([Buffer.from(`${root}/`), Buffer.from(key, 'latin1')])

/** Writes `state` into an empty work tree and stages exactly it, including gitlinks. */
async function stageState(root: string, state: VersionedState): Promise<void> {
  for (const [key, entry] of state) {
    const target = absoluteKey(root, key)
    // A gitlink is an uninitialized submodule: an empty directory, never a nested checkout.
    if (entry.mode === '160000') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(Buffer.from(path.dirname(target.toString('latin1')), 'latin1'), { recursive: true })
    if (entry.mode === '120000') await symlink(entry.data, target)
    else await writeFile(target, entry.data, { mode: entry.mode === '100755' ? 0o755 : 0o644 })
  }
  scratchGit(root, ['add', '--all', '--force'])
  for (const [key, entry] of state) {
    if (entry.mode === '160000') scratchGit(root, ['update-index', '--add', '--cacheinfo', `160000,${entry.data.toString('utf8')},${key}`])
  }
}

export interface StateRepository extends TempDirectory {
  /** The repository root inside the temporary directory. */
  readonly root: string
  /** The commit holding exactly the given state. */
  readonly commit: string
  readonly objectFormat: ObjectFormat
}

/** A new repository whose only commit holds exactly `state`. */
export async function createStateRepository(state: VersionedState, options: { readonly objectFormat?: ObjectFormat } = {}): Promise<StateRepository> {
  const objectFormat = options.objectFormat ?? 'sha1'
  const parent = await createTempDirectory('flowproof-captured-repo-')
  const root = path.join(parent.path, 'repo')
  scratchGit(parent.path, ['init', '--quiet', `--object-format=${objectFormat}`, '--initial-branch=main', 'repo'])
  await stageState(root, state)
  scratchGit(root, [...COMMIT_IDENTITY, 'commit', '--quiet', '--message', 'baseline'])
  return { path: parent.path, root, commit: gitText(root, 'rev-parse', 'HEAD'), objectFormat, remove: parent.remove }
}

/** Commits further ordinary changes, so the original HEAD moves past the candidate baseline. */
export async function advanceHead(root: string, files: Readonly<Record<string, string>>): Promise<string> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), content)
    scratchGit(root, ['add', '--', relative])
  }
  scratchGit(root, [...COMMIT_IDENTITY, 'commit', '--quiet', '--message', 'later change'])
  return gitText(root, 'rev-parse', 'HEAD')
}

export interface RawTreeEntry {
  readonly mode: string
  readonly type: string
  readonly objectId: string
  /** Raw path bytes. */
  readonly path: Buffer
}

/** `git ls-tree -r -z --full-tree` raw entries of a tree-ish, in Git order. */
export function readTreeEntries(root: string, treeish: string): RawTreeEntry[] {
  const out = scratchGit(root, ['ls-tree', '-r', '-z', '--full-tree', treeish])
  const entries: RawTreeEntry[] = []
  let start = 0
  for (let end = out.indexOf(0, start); end !== -1; end = out.indexOf(0, start)) {
    const record = out.subarray(start, end)
    const tab = record.indexOf(0x09)
    const [mode = '', type = '', objectId = ''] = record.subarray(0, tab).toString('latin1').split(' ')
    entries.push(Object.freeze({ mode, type, objectId, path: Buffer.from(record.subarray(tab + 1)) }))
    start = end + 1
  }
  return entries
}

export interface ExpectedTree {
  /** The tree object ID: equal only for byte-identical paths, modes, and object IDs. */
  readonly tree: string
  readonly entries: readonly RawTreeEntry[]
}

/** Independently stages `state` in a scratch repository of `objectFormat` and reads its tree back. */
export async function stageExpectedTree(state: VersionedState, objectFormat: ObjectFormat): Promise<ExpectedTree> {
  const scratch = await createStateRepository(state, { objectFormat })
  try {
    return { tree: gitText(scratch.root, 'rev-parse', 'HEAD^{tree}'), entries: readTreeEntries(scratch.root, 'HEAD') }
  } finally {
    await scratch.remove()
  }
}

// ---------------------------------------------------------------------------------------
// Real capture results
// ---------------------------------------------------------------------------------------

/** Fixed, credential-free session facts of a completed synthetic editor. */
export const SYNTHETIC_RUNTIME: EditingSessionResult['runtime'] = Object.freeze({
  profileId: 'fixture-editing-agent',
  imageReference: `sha256:${'5'.repeat(64)}`,
  isolation: null,
})

export const COMPLETE_CLEANUP: CleanupResult = Object.freeze({
  status: 'complete',
  containerRemoved: true,
  workspaceRemoved: true,
  originalRepositoryUnchanged: true,
  reasonCode: null,
  remainingOwnedResources: Object.freeze([]),
})

/** A contract-valid completed session; `overrides` produce the other upstream outcomes. */
export function sessionResult(sessionId: string, overrides: Partial<EditingSessionResult> = {}): EditingSessionResult {
  return {
    sessionId,
    executionOutcome: 'completed',
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    diagnostic: 'completed: the agent exited with code 0.',
    cleanup: COMPLETE_CLEANUP,
    runtime: SYNTHETIC_RUNTIME,
    ...overrides,
  }
}

export interface ProduceCaptureOptions {
  readonly repositoryRoot: string
  /** The full commit the editing clone starts from; it may differ from the original HEAD. */
  readonly baselineCommit: string
  /** Private temporary root for the editing session state. */
  readonly tmpRoot: string
  /** Changes the editing clone with ordinary file operations; Git metadata is never edited. */
  readonly edit: (workspacePath: string) => Promise<void>
  readonly markers?: readonly string[]
}

const DEFAULT_MARKERS = ['FPCAPTUREDVERIFYNEVERPRESENT01'] as const

/**
 * Runs a real editing workspace and `captureChanges` without Docker, disposes the workspace, and
 * returns the validated `{ session, capture }` composition with an honest cleanup record.
 */
export async function produceCapturingResult(options: ProduceCaptureOptions): Promise<CapturingEditingSessionResult> {
  const workspace = createWorkspaceManager({ tmpRoot: options.tmpRoot }).open()
  const sessionId = randomUUID()
  const started = performance.now()
  let capture: CaptureResult | null = null
  let failure: unknown = null
  try {
    await workspace.resolve(options.repositoryRoot, options.baselineCommit)
    const prepared = await workspace.create({ task: 'Synthetic captured-verification edit.', declaredProjectCommands: [] })
    const pinned = await (workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
    await options.edit(prepared.workspacePath)
    capture = await captureChanges({ sessionId, workspace: pinned, scanner: createSecretScanner({ markers: [...(options.markers ?? DEFAULT_MARKERS)] }) })
  } catch (error) {
    failure = error
  }
  // Disposal and the original comparison run even when the edit failed.
  const disposal = await workspace.dispose()
  const integrity = await workspace.verifyOriginal()
  if (capture === null) throw failure instanceof Error ? failure : new Error('The synthetic capture did not complete.')
  const removed = disposal.taskDocumentRemoved && disposal.workspaceRemoved && disposal.sessionRootRemoved
  const cleanup: CleanupResult =
    removed && integrity.unchanged
      ? COMPLETE_CLEANUP
      : {
          status: 'failed',
          containerRemoved: true,
          workspaceRemoved: removed,
          originalRepositoryUnchanged: integrity.unchanged,
          reasonCode: removed ? 'ORIGINAL_REPOSITORY_CHANGED' : 'WORKSPACE_NOT_REMOVED',
          remainingOwnedResources: [...(removed ? [] : (['workspace'] as const)), ...(integrity.unchanged ? [] : (['original_repository'] as const))],
        }
  const result = { session: sessionResult(sessionId, { durationMs: Math.round(performance.now() - started), cleanup }), capture }
  const validated = validateCapturingSessionResult(result)
  if (!validated.ok) throw new Error(`The synthetic capture composition is invalid at ${validated.issues.join(', ')}.`)
  return validated.value
}

// ---------------------------------------------------------------------------------------
// Original-repository inventory
// ---------------------------------------------------------------------------------------

export interface RepositoryInventory {
  /** Every object-store file (loose objects, packs, info), relative path to content digest. */
  readonly objects: Readonly<Record<string, string>>
  readonly refs: string
  /** SHA-256 of the raw index file bytes, or `absent`. */
  readonly indexDigest: string
  readonly config: string
  readonly trackedFiles: Readonly<Record<string, string>>
  readonly worktreeList: string
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Read-only Git: no optional locks, so inventory never refreshes the index it digests. */
const readOnlyGit = (root: string, ...args: string[]): Buffer => scratchGit(root, ['--no-optional-locks', ...args])

async function digestTree(root: string): Promise<Record<string, string>> {
  const digest: Record<string, string> = {}
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else if (entry.isSymbolicLink()) digest[child] = `symlink:${await readlink(path.join(root, child))}`
      else digest[child] = sha256(await readFile(path.join(root, child)))
    }
  }
  if (existsSync(root)) await walk('')
  return digest
}

/**
 * The original repository facets candidate application must never change: the object store,
 * refs, the raw index file, local configuration, tracked file contents, and worktree registrations.
 */
export async function inventoryRepository(root: string): Promise<RepositoryInventory> {
  const commonDir = await realpath(path.resolve(root, readOnlyGit(root, 'rev-parse', '--git-common-dir').toString('utf8').trim()))
  const indexPath = path.resolve(root, readOnlyGit(root, 'rev-parse', '--git-path', 'index').toString('utf8').trim())
  const indexDigest = existsSync(indexPath) ? sha256(await readFile(indexPath)) : 'absent'
  const trackedFiles: Record<string, string> = {}
  for (const name of readOnlyGit(root, 'ls-files', '-z').toString('latin1').split('\0').filter(Boolean)) {
    const absolute = absoluteKey(root, name)
    try {
      const info = await lstat(absolute)
      trackedFiles[name] = info.isSymbolicLink() ? `symlink:${(await readlink(absolute, { encoding: 'buffer' })).toString('hex')}` : info.isFile() ? sha256(await readFile(absolute)) : 'other'
    } catch {
      trackedFiles[name] = 'missing'
    }
  }
  return {
    objects: await digestTree(path.join(commonDir, 'objects')),
    refs: readOnlyGit(root, 'for-each-ref', '--format=%(refname) %(objectname)').toString('utf8'),
    indexDigest,
    config: await readFile(path.join(commonDir, 'config'), 'utf8'),
    trackedFiles,
    worktreeList: readOnlyGit(root, 'worktree', 'list', '--porcelain').toString('utf8'),
  }
}
