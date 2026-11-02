import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { captureChanges } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureCandidate, CaptureResult } from '../../packages/flowproof/src/editing/capture.js'
import { captureGitEnvironment, createCaptureBudget, runCaptureGit } from '../../packages/flowproof/src/editing/captureGit.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import { WorkspaceError, createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import type { CaptureWorkspace, SessionWorkspace } from '../../packages/flowproof/src/editing/workspace.js'
import { createPrivateTmpRoot, createSyntheticRepository, listTree, processesWithin } from '../support/editingRuntime.js'
import type { SyntheticRepository } from '../support/editingRuntime.js'
import { createTempDirectory, git, snapshotRepository } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T006/T007 (specs/003-capture-editing-candidate): opt-in capture preparation. Only a capturing
// session creates a private Git directory beneath its session root, outside the agent's
// `/workspace` mount. It pins the trusted baseline and original object source before the editor
// runs, reads original objects only as an alternate, and is removed by manifest-scoped disposal.

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

interface Fixture {
  readonly repo: SyntheticRepository
  readonly tmp: TempDirectory
  readonly workspace: SessionWorkspace
}

const TASK_DOCUMENT = Object.freeze({ task: 'Capture the changes.', declaredProjectCommands: Object.freeze([]) })

async function fixture(): Promise<Fixture> {
  const repo = await createSyntheticRepository()
  const tmp = await createPrivateTmpRoot()
  cleanups.push(repo.remove, tmp.remove)
  const workspace = createWorkspaceManager({ tmpRoot: tmp.path }).open()
  cleanups.push(async () => {
    await workspace.dispose()
  })
  return { repo, tmp, workspace }
}

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`)

/** File names and content digests below a directory; modification times are not compared. */
async function contentDigest(root: string): Promise<Record<string, string>> {
  const digest: Record<string, string> = {}
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else digest[child] = createHash('sha256').update(await readFile(path.join(root, child))).digest('hex')
    }
  }
  await walk('')
  return digest
}

/** Every file below `root` whose bytes contain `needle`. */
async function filesNaming(root: string, needle: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && (await readFile(path.join(root, child))).includes(needle)) found.push(child)
    }
  }
  await walk('')
  return found
}

async function prepare(fx: Fixture): Promise<{ readonly workspacePath: string; readonly capture: CaptureWorkspace }> {
  await fx.workspace.resolve(fx.repo.path, fx.repo.head)
  const prepared = await fx.workspace.create(TASK_DOCUMENT)
  const capture = await (fx.workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
  return { workspacePath: prepared.workspacePath, capture }
}

describe('opt-in capture preparation', () => {
  it('creates no capture scratch for an ordinary workspace', async () => {
    const fx = await fixture()
    await fx.workspace.resolve(fx.repo.path, fx.repo.head)
    const prepared = await fx.workspace.create(TASK_DOCUMENT)
    const sessionRoot = path.dirname(prepared.workspacePath)

    expect(fx.workspace.createdPaths).toEqual([sessionRoot, prepared.workspacePath, prepared.taskDocumentPath])
    expect((await readdir(sessionRoot)).sort()).toEqual(['task.json', 'workspace'])
  })

  it('pins the trusted baseline, object format, and object source in private scratch outside the agent mount', async () => {
    const fx = await fixture()
    const before = await snapshotRepository(fx.repo.path)
    const originalObjects = path.join(before.gitCommonDir, 'objects')
    const { workspacePath, capture } = await prepare(fx)
    const sessionRoot = path.dirname(workspacePath)

    expect(capture.workspacePath).toBe(workspacePath)
    expect(capture.baselineCommit).toBe(fx.repo.head)
    expect(capture.objectFormat).toBe('sha1')
    expect(capture.objectDirectory).toBe(originalObjects)
    expect(path.dirname(capture.gitDir)).toBe(sessionRoot)
    expect(isInside(workspacePath, capture.gitDir)).toBe(false)
    expect(fx.workspace.createdPaths).toContain(capture.gitDir)
    expect(Object.isFrozen(capture)).toBe(true)

    // The private repository uses a host-owned empty template: no hooks, config filters, or
    // alternates file. The original object path reaches Git only through the trusted environment.
    expect((await readdir(capture.gitDir)).sort()).toEqual(['HEAD', 'config', 'objects', 'refs'])
    expect(existsSync(path.join(capture.gitDir, 'objects', 'info', 'alternates'))).toBe(false)
    expect(existsSync(path.join(capture.gitDir, 'hooks'))).toBe(false)
    // Nothing the agent can read names the private directory or the original object source.
    for (const needle of [capture.gitDir, originalObjects, path.basename(capture.gitDir)]) {
      expect(await filesNaming(workspacePath, needle)).toEqual([])
      expect((await readFile(path.join(sessionRoot, 'task.json'), 'utf8')).includes(needle)).toBe(false)
    }

    // An editor commit, branch, staged change, and local config afterwards do not move the pin.
    await writeFile(path.join(workspacePath, 'src', 'math.mjs'), 'export const add = () => 0\n')
    git(workspacePath, '-c', 'user.email=a@example.invalid', '-c', 'user.name=Editor', 'commit', '--quiet', '--all', '--message', 'editor commit')
    git(workspacePath, 'checkout', '--quiet', '-b', 'editor-branch')
    git(workspacePath, 'config', 'filter.fp.clean', 'false')
    expect(git(workspacePath, 'rev-parse', 'HEAD').trim()).not.toBe(fx.repo.head)
    expect(capture.baselineCommit).toBe(fx.repo.head)
    expect(capture.objectDirectory).toBe(originalObjects)
  })

  it('matches a SHA-256 source object format', async () => {
    const parent = await createTempDirectory('flowproof-capture-sha256-')
    const tmp = await createPrivateTmpRoot()
    cleanups.push(parent.remove, tmp.remove)
    const root = path.join(parent.path, 'repo')
    git(parent.path, 'init', '--quiet', '--object-format=sha256', '--initial-branch=main', 'repo')
    await writeFile(path.join(root, 'a.txt'), 'a\n')
    git(root, 'add', 'a.txt')
    git(root, '-c', 'user.email=a@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'base')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const workspace = createWorkspaceManager({ tmpRoot: tmp.path }).open()
    cleanups.push(async () => {
      await workspace.dispose()
    })

    await workspace.resolve(root, head)
    await workspace.create(TASK_DOCUMENT)
    const capture = await (workspace.prepareCapture as () => Promise<CaptureWorkspace>)()

    expect(head).toHaveLength(64)
    expect(capture.objectFormat).toBe('sha256')
    expect(git(capture.gitDir, 'rev-parse', '--show-object-format').trim()).toBe('sha256')
  })

  it('reads baseline objects through the alternate while every capture write stays private', async () => {
    const fx = await fixture()
    const before = await snapshotRepository(fx.repo.path)
    const originalObjects = path.join(before.gitCommonDir, 'objects')
    const objectsBefore = await contentDigest(originalObjects)
    const { workspacePath, capture } = await prepare(fx)
    const env = captureGitEnvironment({
      gitDir: capture.gitDir,
      workTree: workspacePath,
      indexFile: path.join(capture.gitDir, 'index'),
      alternateObjectDirectory: capture.objectDirectory,
    })
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())

    await writeFile(path.join(workspacePath, 'new.txt'), 'new private object\n')
    await runCaptureGit(budget, ['read-tree', capture.baselineCommit], { cwd: workspacePath, env })
    await runCaptureGit(budget, ['add', '-A'], { cwd: workspacePath, env })
    const tree = (await runCaptureGit(budget, ['write-tree'], { cwd: workspacePath, env })).stdout.toString('utf8').trim()

    expect(tree).toMatch(/^[a-f0-9]{40}$/)
    // New blob and tree objects exist only in the private object directory.
    const privateObjects = Object.keys(await contentDigest(path.join(capture.gitDir, 'objects')))
    expect(privateObjects.some((name) => name.startsWith(tree.slice(0, 2)))).toBe(true)
    expect(await contentDigest(originalObjects)).toEqual(objectsBefore)
    // The editor's own index and refs are untouched by capture.
    expect(git(workspacePath, 'status', '--porcelain', '--untracked-files=all')).toBe('?? new.txt\n')
    expect(await snapshotRepository(fx.repo.path)).toEqual(before)
  })

  it('refuses capture preparation before the workspace exists, without creating anything', async () => {
    const fx = await fixture()
    let caught: unknown
    try {
      await (fx.workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkspaceError)
    expect((caught as WorkspaceError).code).toBe('WORKSPACE_STATE_INVALID')
    expect(await listTree(fx.tmp.path)).toEqual([])
  })

  it('disposes capture scratch idempotently, after use and after a partial preparation failure', async () => {
    const fx = await fixture()
    const before = await snapshotRepository(fx.repo.path)
    const { capture } = await prepare(fx)
    await writeFile(path.join(capture.gitDir, 'index'), 'partial capture output')
    expect((await (fx.workspace.prepareCapture as () => Promise<CaptureWorkspace>)().catch((error: unknown) => error)) instanceof WorkspaceError).toBe(true)

    expect(await fx.workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await fx.workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await listTree(fx.tmp.path)).toEqual([])

    // A Git initialization that fails after writing part of the private directory.
    const partial = await fixture()
    const fakeBin = await createTempDirectory('flowproof-capture-fake-git-')
    cleanups.push(fakeBin.remove)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    await mkdir(path.join(fakeBin.path, 'bin'))
    const fakeGit = path.join(fakeBin.path, 'bin', 'git')
    await writeFile(
      fakeGit,
      `#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nfor arg in "$@"; do if [ "$arg" = init ]; then mkdir -p "$last/objects/partial" && exit 1; fi; done\nexec ${JSON.stringify(realGit)} "$@"\n`,
    )
    await chmod(fakeGit, 0o755)
    await partial.workspace.resolve(partial.repo.path, partial.repo.head)
    await partial.workspace.create(TASK_DOCUMENT)
    const savedPath = process.env.PATH
    process.env.PATH = `${path.join(fakeBin.path, 'bin')}:${savedPath ?? ''}`
    let caught: unknown
    try {
      await (partial.workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
    } catch (error) {
      caught = error
    } finally {
      process.env.PATH = savedPath
    }
    expect(caught).toBeInstanceOf(WorkspaceError)
    expect((caught as WorkspaceError).code).toBe('WORKSPACE_PREPARE_FAILED')
    expect((caught as Error).message).not.toContain(partial.tmp.path)
    expect((await listTree(partial.tmp.path)).some((entry) => entry.endsWith('objects/partial'))).toBe(true)

    expect(await partial.workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await partial.workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await listTree(partial.tmp.path)).toEqual([])
    expect(await snapshotRepository(fx.repo.path)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------
// T008 (US1): Git-native fidelity. Each case describes the baseline and the expected final
// versioned state in plain data, lets an "editor" change the clone with ordinary file and Git
// operations, captures, then rebuilds the final state from the baseline plus the captured patch
// in test scratch. Blob IDs are computed independently from bytes. Rebuilding proves artifact
// fidelity only; it is not production fresh-worktree verification.
// ---------------------------------------------------------------------------------------

type Mode = '100644' | '100755' | '120000' | '160000'

interface Entry {
  readonly mode: Mode
  /** File bytes, link target text, or gitlink commit ID. */
  readonly data: Buffer
}

/** Versioned state keyed by the raw path bytes read as latin1, a byte-exact string mapping. */
type State = Map<string, Entry>

const bytes = (path: string): Buffer => Buffer.from(path, 'latin1')
const file = (text: string | Buffer, mode: Mode = '100644'): Entry => ({ mode, data: Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8') })
const link = (target: string): Entry => ({ mode: '120000', data: Buffer.from(target, 'utf8') })
const utf8Path = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')

/** The Git blob ID of `data`, computed without Git. */
const blobId = (data: Buffer, format: 'sha1' | 'sha256' = 'sha1'): string =>
  createHash(format).update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex')

const SCANNER = createSecretScanner({ markers: ['FPCAPTURENEVERPRESENT01'] })

interface Baseline {
  readonly root: string
  readonly head: string
  readonly state: State
}

/** Commits `state` as the only commit of a new repository; `forced` paths bypass ignore rules. */
async function commitBaseline(state: State, options: { readonly forced?: readonly string[] } = {}): Promise<Baseline> {
  const parent = await createTempDirectory('flowproof-capture-base-')
  cleanups.push(parent.remove)
  const root = path.join(parent.path, 'repo')
  git(parent.path, 'init', '--quiet', '--initial-branch=main', 'repo')
  for (const [key, entry] of state) {
    if (entry.mode === '160000') continue
    const target = Buffer.concat([bytes(`${root}/`), bytes(key)])
    await mkdir(Buffer.from(path.dirname(target.toString('latin1')), 'latin1'), { recursive: true })
    if (entry.mode === '120000') await symlink(entry.data, target)
    else await writeFile(target, entry.data, { mode: entry.mode === '100755' ? 0o755 : 0o644 })
  }
  git(root, 'add', '--all')
  for (const forced of options.forced ?? []) git(root, 'add', '--force', '--', forced)
  for (const [key, entry] of state) {
    if (entry.mode === '160000') git(root, 'update-index', '--add', '--cacheinfo', `160000,${entry.data.toString('utf8')},${key}`)
  }
  git(root, '-c', 'user.email=base@example.invalid', '-c', 'user.name=Base', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'baseline')
  return { root, head: git(root, 'rev-parse', 'HEAD').trim(), state }
}

interface Session {
  readonly baseline: Baseline
  readonly workspacePath: string
  readonly sessionId: string
  readonly pinned: CaptureWorkspace
  capture(options?: { readonly scanner?: typeof SCANNER; readonly signal?: AbortSignal; readonly bounds?: { readonly deadlineMs?: number; readonly byteLimit?: number } }): Promise<CaptureResult>
}

async function openSession(baseline: Baseline): Promise<Session> {
  const tmp = await createPrivateTmpRoot()
  cleanups.push(tmp.remove)
  const workspace = createWorkspaceManager({ tmpRoot: tmp.path }).open()
  cleanups.push(async () => {
    await workspace.dispose()
  })
  await workspace.resolve(baseline.root, baseline.head)
  const prepared = await workspace.create(TASK_DOCUMENT)
  const pinned = await (workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
  const sessionId = randomUUID()
  return {
    baseline,
    workspacePath: prepared.workspacePath,
    sessionId,
    pinned,
    capture: (options = {}) =>
      captureChanges({
        sessionId,
        workspace: pinned,
        scanner: options.scanner ?? SCANNER,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      }),
  }
}

/** An editor-side path below the clone, built from raw bytes. */
const at = (session: Session, key: string): Buffer => Buffer.concat([bytes(`${session.workspacePath}/`), bytes(key)])

const editorGit = (session: Session, ...args: string[]): string =>
  git(session.workspacePath, '-c', 'user.email=editor@example.invalid', '-c', 'user.name=Editor', '-c', 'commit.gpgsign=false', ...args)

function expectCaptured(result: CaptureResult): CaptureCandidate {
  expect(result.status, JSON.stringify(result)).toBe('captured')
  if (result.status !== 'captured') throw new Error('not captured')
  return result.candidate
}

/** Rebuilds the final versioned state: baseline checkout, then `git apply --index` of the patch. */
async function rebuild(baseline: Baseline, patch: Buffer): Promise<State> {
  const scratch = await createTempDirectory('flowproof-capture-rebuild-')
  cleanups.push(scratch.remove)
  const root = path.join(scratch.path, 'repo')
  execFileSync('git', ['clone', '--quiet', '--no-checkout', baseline.root, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(root, 'checkout', '--quiet', '--detach', baseline.head)
  execFileSync('git', ['-C', root, 'apply', '--index', '--binary', '--whitespace=nowarn', '-'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
  const state: State = new Map()
  const index = execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z'])
  for (const record of index.toString('latin1').split('\0').filter(Boolean)) {
    const [meta = '', key = ''] = record.split('\t')
    const [mode, id] = meta.split(' ') as [Mode, string]
    const data = mode === '160000' ? Buffer.from(id, 'utf8') : execFileSync('git', ['-C', root, 'cat-file', 'blob', id])
    state.set(key, { mode, data })
  }
  return state
}

function expectState(actual: State, expected: State): void {
  const render = (state: State): Record<string, string> =>
    Object.fromEntries([...state].sort(([a], [b]) => Buffer.compare(bytes(a), bytes(b))).map(([key, entry]) => [Buffer.from(key, 'latin1').toString('hex'), `${entry.mode}:${entry.data.toString('hex')}`]))
  expect(render(actual)).toEqual(render(expected))
}

interface ExpectedChange {
  readonly path: string
  readonly operation: 'added' | 'modified' | 'deleted'
}

/** Exact membership, Git byte order, modes, independent object IDs, and byte lengths. */
function expectFiles(candidate: CaptureCandidate, baseline: State, final: State, changes: readonly ExpectedChange[]): void {
  const actual = candidate.files.map((record) => ({ path: record.path.toString('latin1'), operation: record.operation }))
  const ordered = [...changes].sort((a, b) => Buffer.compare(bytes(a.path), bytes(b.path)))
  expect(actual).toEqual(ordered)
  for (const record of candidate.files) {
    const key = record.path.toString('latin1')
    const before = record.operation === 'added' ? undefined : baseline.get(key)
    const after = record.operation === 'deleted' ? undefined : final.get(key)
    const side = (entry: Entry | undefined) =>
      entry === undefined
        ? { mode: null, id: null, size: null }
        : { mode: entry.mode, id: entry.mode === '160000' ? entry.data.toString('utf8') : blobId(entry.data), size: entry.mode === '160000' ? null : entry.data.length }
    const old = side(before)
    const next = side(after)
    expect({ mode: record.oldMode, id: record.oldObjectId, size: record.oldSize }, key).toEqual(old)
    expect({ mode: record.newMode, id: record.newObjectId, size: record.newSize }, key).toEqual(next)
  }
}

const BINARY_V1 = Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x0a, 0x80])
const BINARY_V2 = Buffer.from([0x89, 0x50, 0x00, 0x02, 0xff, 0x00, 0x00, 0x0d, 0x0a, 0x7f])
const RAW_NAME = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]).toString('latin1')

function richBaseline(): State {
  return new Map<string, Entry>([
    ['.gitignore', file('build/\n*.log\n')],
    ['README.md', file('Status: pending\n')],
    ['src/app.txt', file('one\ntwo\nthree\n')],
    ['src/remove-me.txt', file('bye\n')],
    ['src/rename-me.txt', file('moving\n')],
    ['assets/logo.bin', file(BINARY_V1)],
    ['assets/old.bin', file(Buffer.from([0, 1, 2, 3, 0xff]))],
    ['scripts/run.sh', file('#!/bin/sh\necho run\n')],
    ['scripts/tool.sh', file('#!/bin/sh\necho tool\n', '100755')],
    ['build/keep.txt', file('kept\n')],
    ['staged.txt', file('base\n')],
    ['staged-only.txt', file('base\n')],
    ['committed.txt', file('base\n')],
  ])
}

describe('Git-native change fidelity', () => {
  it(
    'captures the final filesystem against the pinned baseline, regardless of staging or editor commits',
    async () => {
      const baseline = await commitBaseline(richBaseline(), { forced: ['build/keep.txt'] })
      const session = await openSession(baseline)
      const w = (key: string) => at(session, key)

      // Ordinary edits: missing final newline, empty, non-ASCII and non-UTF-8 names, binary.
      await writeFile(w('README.md'), 'Status: edited')
      await writeFile(w('src/app.txt'), 'one\n2\nthree\n')
      await writeFile(w('empty.txt'), '')
      await mkdir(w('docs'))
      await writeFile(w(utf8Path('docs/ünïcode-파일.txt')), 'café 안녕\n')
      await writeFile(w(RAW_NAME), 'raw\n')
      await writeFile(w('assets/logo.bin'), BINARY_V2)
      await writeFile(w('assets/new.bin'), BINARY_V1)
      await unlink(w('assets/old.bin'))
      await unlink(w('src/remove-me.txt'))
      await mkdir(w('lib'))
      await rename(w('src/rename-me.txt'), w('lib/renamed.txt'))
      await chmod(w('scripts/run.sh'), 0o755)
      await chmod(w('scripts/tool.sh'), 0o644)
      // Ignore semantics: tracked-under-ignore edits count; ignored output does not.
      await writeFile(w('build/keep.txt'), 'kept and edited\n')
      await writeFile(w('build/out.o'), 'generated\n')
      await writeFile(w('debug.log'), 'log\n')
      await mkdir(w('notes'))
      await writeFile(w('notes/new.txt'), 'untracked and not ignored\n')
      // Staging and history: final bytes win over staged blobs; a local commit moves HEAD only.
      await writeFile(w('build/forced-new.txt'), 'force tracked\n')
      editorGit(session, 'add', '--force', '--', 'build/forced-new.txt')
      await writeFile(w('staged.txt'), 'staged\n')
      editorGit(session, 'add', '--', 'staged.txt')
      await writeFile(w('staged.txt'), 'final\n')
      await writeFile(w('staged-only.txt'), 'staged only\n')
      editorGit(session, 'add', '--', 'staged-only.txt')
      await writeFile(w('staged-only.txt'), 'base\n')
      await writeFile(w('committed.txt'), 'committed by the editor\n')
      editorGit(session, 'commit', '--quiet', '--message', 'editor commit', '--', 'committed.txt')
      expect(git(session.workspacePath, 'rev-parse', 'HEAD').trim()).not.toBe(baseline.head)

      const candidate = expectCaptured(await session.capture())

      const final = new Map(baseline.state)
      final.set('README.md', file('Status: edited'))
      final.set('src/app.txt', file('one\n2\nthree\n'))
      final.set('empty.txt', file(''))
      final.set(utf8Path('docs/ünïcode-파일.txt'), file('café 안녕\n'))
      final.set(RAW_NAME, file('raw\n'))
      final.set('assets/logo.bin', file(BINARY_V2))
      final.set('assets/new.bin', file(BINARY_V1))
      final.delete('assets/old.bin')
      final.delete('src/remove-me.txt')
      final.delete('src/rename-me.txt')
      final.set('lib/renamed.txt', file('moving\n'))
      final.set('scripts/run.sh', file('#!/bin/sh\necho run\n', '100755'))
      final.set('scripts/tool.sh', file('#!/bin/sh\necho tool\n'))
      final.set('build/keep.txt', file('kept and edited\n'))
      final.set('notes/new.txt', file('untracked and not ignored\n'))
      final.set('build/forced-new.txt', file('force tracked\n'))
      final.set('staged.txt', file('final\n'))
      final.set('committed.txt', file('committed by the editor\n'))

      expect(candidate.sessionId).toBe(session.sessionId)
      expect(candidate.baselineCommit).toBe(baseline.head)
      expect(candidate.coverage).toEqual({ scope: 'main_repository', note: null })
      expectState(await rebuild(baseline, candidate.patch), final)
      expectFiles(candidate, baseline.state, final, [
        { path: 'README.md', operation: 'modified' },
        { path: 'src/app.txt', operation: 'modified' },
        { path: 'empty.txt', operation: 'added' },
        { path: utf8Path('docs/ünïcode-파일.txt'), operation: 'added' },
        { path: RAW_NAME, operation: 'added' },
        { path: 'assets/logo.bin', operation: 'modified' },
        { path: 'assets/new.bin', operation: 'added' },
        { path: 'assets/old.bin', operation: 'deleted' },
        { path: 'src/remove-me.txt', operation: 'deleted' },
        { path: 'src/rename-me.txt', operation: 'deleted' },
        { path: 'lib/renamed.txt', operation: 'added' },
        { path: 'scripts/run.sh', operation: 'modified' },
        { path: 'scripts/tool.sh', operation: 'modified' },
        { path: 'build/keep.txt', operation: 'modified' },
        { path: 'notes/new.txt', operation: 'added' },
        { path: 'build/forced-new.txt', operation: 'added' },
        { path: 'staged.txt', operation: 'modified' },
        { path: 'committed.txt', operation: 'modified' },
      ])
      // The patch is one full-index, binary-capable Git patch without renames.
      const patch = candidate.patch.toString('latin1')
      expect(patch).toContain('GIT binary patch')
      expect(patch).not.toMatch(/^rename from /m)
      expect(patch).not.toContain('build/out.o')
      expect(patch).not.toContain('debug.log')
      expect(patch).toMatch(new RegExp(`^index ${'[0-9a-f]'.repeat(40)}\\.\\.${'[0-9a-f]'.repeat(40)}`, 'm'))
    },
    60_000,
  )

  it('reports no changes for reverted edits, staged-only blobs, editor commits undone on disk, and ignored output', async () => {
    const baseline = await commitBaseline(richBaseline(), { forced: ['build/keep.txt'] })
    const session = await openSession(baseline)
    const w = (key: string) => at(session, key)

    await writeFile(w('src/app.txt'), 'temporary\n')
    await writeFile(w('src/app.txt'), 'one\ntwo\nthree\n')
    await writeFile(w('scratch.txt'), 'temporary\n')
    await unlink(w('scratch.txt'))
    await writeFile(w('staged-only.txt'), 'staged only\n')
    editorGit(session, 'add', '--', 'staged-only.txt')
    await writeFile(w('staged-only.txt'), 'base\n')
    await writeFile(w('committed.txt'), 'committed then undone\n')
    editorGit(session, 'commit', '--quiet', '--message', 'editor commit', '--', 'committed.txt')
    await writeFile(w('committed.txt'), 'base\n')
    await chmod(w('scripts/run.sh'), 0o755)
    await chmod(w('scripts/run.sh'), 0o644)
    await writeFile(w('build/out.o'), 'generated\n')
    await writeFile(w('debug.log'), 'log\n')

    const result = await session.capture()

    expect(result).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })
  })
})

// ---------------------------------------------------------------------------------------
// T010 (US1): links, gitlinks, nested Git pointers, control metadata, built-in attributes, and
// project-configured commands. Link records carry link text only; gitlinks carry commit IDs
// only, with the fixed reference-only coverage note; no external pointer is followed and no
// editor-configured hook, filter, monitor, or diff command runs on the host.
// ---------------------------------------------------------------------------------------

/** A standalone repository with one commit, returned with that commit ID. */
async function nestedRepository(root: string, content: string): Promise<string> {
  await mkdir(root, { recursive: true })
  git(root, 'init', '--quiet', '--initial-branch=main')
  await writeFile(path.join(root, 'nested.txt'), content)
  git(root, 'add', 'nested.txt')
  git(root, '-c', 'user.email=n@example.invalid', '-c', 'user.name=Nested', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'nested')
  return git(root, 'rev-parse', 'HEAD').trim()
}

function expectRejected(result: CaptureResult, reasonCode: string): void {
  expect(result).toMatchObject({ status: 'rejected', reasonCode })
  expect(JSON.stringify(result)).not.toMatch(/patch|files|\/tmp\//)
}

describe('links, gitlinks, and repository control metadata', () => {
  it('records link text without reading an external target', async () => {
    const outside = await createTempDirectory('flowproof-capture-outside-')
    cleanups.push(outside.remove)
    const sentinel = path.join(outside.path, 'sentinel.txt')
    const marker = ['FPCAPTURE', 'LINKTARGET', 'MARKER01'].join('')
    await writeFile(sentinel, `${marker}\n`)
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')], ['old-link', link('a.txt')], ['becomes-link', file('plain\n')]]))
    const session = await openSession(baseline)

    await symlink(sentinel, at(session, 'external-link'))
    await unlink(at(session, 'old-link'))
    await symlink('missing-target', at(session, 'old-link'))
    await unlink(at(session, 'becomes-link'))
    await symlink('a.txt', at(session, 'becomes-link'))

    const candidate = expectCaptured(await session.capture({ scanner: createSecretScanner({ markers: [marker] }) }))
    const final = new Map(baseline.state)
    final.set('external-link', link(sentinel))
    final.set('old-link', link('missing-target'))
    final.set('becomes-link', link('a.txt'))

    expectState(await rebuild(baseline, candidate.patch), final)
    expectFiles(candidate, baseline.state, final, [
      { path: 'becomes-link', operation: 'modified' },
      { path: 'external-link', operation: 'added' },
      { path: 'old-link', operation: 'modified' },
    ])
    expect(candidate.patch.includes(marker)).toBe(false)
  })

  it('captures gitlink references only and states reference-only coverage, even with no change', async () => {
    const side = await createTempDirectory('flowproof-capture-nested-')
    cleanups.push(side.remove)
    const first = await nestedRepository(path.join(side.path, 'lib'), 'v1\n')
    const second = await nestedRepository(path.join(side.path, 'other'), 'other\n')
    const baseline = await commitBaseline(
      new Map([
        ['a.txt', file('a\n')],
        ['vendor/lib', { mode: '160000', data: Buffer.from(first) }],
        ['vendor/gone', { mode: '160000', data: Buffer.from(second) }],
      ]),
    )

    // Unchanged reference, dirty nested working tree: still no main-repository change.
    const unchanged = await openSession(baseline)
    execFileSync('git', ['clone', '--quiet', path.join(side.path, 'lib'), at(unchanged, 'vendor/lib').toString('latin1')], { stdio: 'ignore' })
    await writeFile(path.join(at(unchanged, 'vendor/lib').toString('latin1'), 'dirty.txt'), 'nested dirt FPNESTEDDIRT01\n')
    expect(await unchanged.capture()).toEqual({
      status: 'no_changes',
      coverage: { scope: 'main_repository', note: expect.stringContaining('neither inspected nor captured') },
    })

    // Changed, added, and deleted references.
    const session = await openSession(baseline)
    const libPath = at(session, 'vendor/lib').toString('latin1')
    execFileSync('git', ['clone', '--quiet', path.join(side.path, 'lib'), libPath], { stdio: 'ignore' })
    await writeFile(path.join(libPath, 'nested.txt'), 'v2 FPNESTEDCONTENT01\n')
    git(libPath, '-c', 'user.email=n@example.invalid', '-c', 'user.name=Nested', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--all', '--message', 'v2')
    const moved = git(libPath, 'rev-parse', 'HEAD').trim()
    await writeFile(path.join(libPath, 'untracked-in-nested.txt'), 'FPNESTEDCONTENT02\n')
    const added = await nestedRepository(at(session, 'vendor/new').toString('latin1'), 'new\n')
    await rm(at(session, 'vendor/gone'), { recursive: true, force: true })

    const candidate = expectCaptured(await session.capture())
    const final = new Map(baseline.state)
    final.set('vendor/lib', { mode: '160000', data: Buffer.from(moved) })
    final.set('vendor/new', { mode: '160000', data: Buffer.from(added) })
    final.delete('vendor/gone')

    expect(candidate.coverage.note).toMatch(/neither inspected nor captured/)
    expectState(await rebuild(baseline, candidate.patch), final)
    expectFiles(candidate, baseline.state, final, [
      { path: 'vendor/gone', operation: 'deleted' },
      { path: 'vendor/lib', operation: 'modified' },
      { path: 'vendor/new', operation: 'added' },
    ])
    expect(candidate.patch.toString('latin1')).not.toMatch(/FPNESTED|nested\.txt/)
  })

  it('follows a contained nested Git-directory pointer and rejects an external or linked one', async () => {
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')]]))

    // A submodule-style pointer into the clone's own `.git/modules` is ordinary.
    const contained = await openSession(baseline)
    const modules = at(contained, '.git/modules/sub').toString('latin1')
    const head = await nestedRepository(at(contained, 'sub').toString('latin1'), 'sub\n')
    await mkdir(path.dirname(modules), { recursive: true })
    await rename(at(contained, 'sub/.git'), modules)
    await writeFile(at(contained, 'sub/.git'), 'gitdir: ../.git/modules/sub\n')
    const candidate = expectCaptured(await contained.capture())
    expect(candidate.files.map((record) => [record.path.toString('latin1'), record.newMode, record.newObjectId])).toEqual([['sub', '160000', head]])

    // A pointer outside the clone is never followed.
    const outside = await createTempDirectory('flowproof-capture-external-git-')
    cleanups.push(outside.remove)
    await nestedRepository(path.join(outside.path, 'repo'), 'external\n')
    const external = await openSession(baseline)
    await mkdir(at(external, 'ext'))
    await writeFile(at(external, 'ext/file.txt'), 'x\n')
    await writeFile(at(external, 'ext/.git'), `gitdir: ${path.join(outside.path, 'repo', '.git')}\n`)
    expectRejected(await external.capture(), 'UNREPRESENTABLE_ENTRY')

    const linked = await openSession(baseline)
    await mkdir(at(linked, 'ext'))
    await symlink(path.join(outside.path, 'repo', '.git'), at(linked, 'ext/.git'))
    expectRejected(await linked.capture(), 'UNREPRESENTABLE_ENTRY')
  })

  it('keeps non-ASCII nested repository paths byte-safe and never captures nested worktree content', async () => {
    const marker = 'FPCAPTURENONASCIINESTED01'
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')]]))

    // An external .git pointer under a UTF-8 directory name must be recognized before Git sees it.
    const outside = await createTempDirectory('flowproof-capture-unicode-external-')
    cleanups.push(outside.remove)
    const outsideRepo = path.join(outside.path, 'repo')
    await nestedRepository(outsideRepo, `${marker}\n`)
    const external = await openSession(baseline)
    const externalKey = utf8Path('external/외부')
    const externalDirectory = at(external, externalKey)
    await mkdir(externalDirectory, { recursive: true })
    await writeFile(Buffer.concat([externalDirectory, Buffer.from('/.git')]), `gitdir: ${path.join(outsideRepo, '.git')}\n`)
    const rejected = await external.capture({ scanner: createSecretScanner({ markers: [marker] }) })
    expectRejected(rejected, 'UNREPRESENTABLE_ENTRY')
    expect(JSON.stringify(rejected)).not.toContain(marker)

    // A contained nested repository is a gitlink reference only, even when its working tree is dirty.
    const contained = await openSession(baseline)
    const nestedKey = utf8Path('nested/하위')
    const nestedPath = at(contained, nestedKey).toString('utf8')
    const head = await nestedRepository(nestedPath, 'baseline nested content\n')
    await writeFile(path.join(nestedPath, 'dirty.txt'), `${marker}\n`)
    const candidate = expectCaptured(
      await contained.capture({ scanner: createSecretScanner({ markers: [marker] }) }),
    )
    expect(candidate.files.map((record) => record.path.toString('latin1'))).toEqual([nestedKey])
    expect(candidate.files[0]).toMatchObject({ newMode: '160000', newObjectId: head })
    expect(candidate.coverage.note).toMatch(/neither inspected nor captured/)
    expect(candidate.patch.includes(Buffer.from(marker))).toBe(false)
    expect(candidate.patch.toString('latin1')).not.toMatch(/nested\.txt|dirty\.txt/)
  })

  it.each(['HEAD', 'objects', 'refs', 'refs/heads/main'] as const)(
    'rejects a linked nested Git %s entry before Git can follow it',
    async (entry) => {
      const baseline = await commitBaseline(new Map([['a.txt', file('a\n')]]))
      const outside = await createTempDirectory('flowproof-capture-linked-git-metadata-')
      cleanups.push(outside.remove)
      const headTarget = path.join(outside.path, 'HEAD')
      const directoryTarget = path.join(outside.path, 'linked-directory')
      await writeFile(headTarget, 'ref: refs/heads/main\n')
      await mkdir(directoryTarget)

      const session = await openSession(baseline)
      const nestedPath = at(session, utf8Path('nested/하위')).toString('utf8')
      await nestedRepository(nestedPath, 'nested content\n')
      const gitDir = path.join(nestedPath, '.git')
      const target = entry === 'HEAD' || entry === 'refs/heads/main' ? headTarget : directoryTarget
      await rm(path.join(gitDir, entry), { recursive: true, force: true })
      await symlink(target, path.join(gitDir, entry))

      expectRejected(await session.capture(), 'UNREPRESENTABLE_ENTRY')
    },
  )

  it('rejects an editor-replaced repository directory or index pointer, and tolerates a removed index', async () => {
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')], ['b.txt', file('b\n')]]))
    const outside = await createTempDirectory('flowproof-capture-external-index-')
    cleanups.push(outside.remove)

    const gitfile = await openSession(baseline)
    await rm(at(gitfile, '.git'), { recursive: true, force: true })
    await writeFile(at(gitfile, '.git'), `gitdir: ${outside.path}\n`)
    expectRejected(await gitfile.capture(), 'UNREPRESENTABLE_ENTRY')

    const indexLink = await openSession(baseline)
    await rename(at(indexLink, '.git/index'), path.join(outside.path, 'index'))
    await symlink(path.join(outside.path, 'index'), at(indexLink, '.git/index'))
    expectRejected(await indexLink.capture(), 'UNREPRESENTABLE_ENTRY')

    // Without an index, the trusted baseline still defines tracked paths.
    const removed = await openSession(baseline)
    await unlink(at(removed, '.git/index'))
    await writeFile(at(removed, 'b.txt'), 'b2\n')
    const candidate = expectCaptured(await removed.capture())
    expect(candidate.files.map((record) => [record.path.toString('latin1'), record.operation])).toEqual([['b.txt', 'modified']])
  })

  it('never exports repository control metadata or lets editor-local excludes hide a change', async () => {
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')]]))
    const session = await openSession(baseline)
    await mkdir(at(session, '.git/info'), { recursive: true })
    await writeFile(at(session, '.git/info/exclude'), 'notes/\n')
    await writeFile(at(session, '.git/description'), 'editor metadata\n')
    editorGit(session, 'config', 'flowproof.editor', 'changed')
    await mkdir(at(session, 'notes'))
    await writeFile(at(session, 'notes/kept.txt'), 'visible change\n')
    await mkdir(at(session, 'deep/.git'), { recursive: true })
    await writeFile(at(session, 'deep/.git/stray'), 'not a repository\n')
    await writeFile(at(session, 'deep/file.txt'), 'deep\n')

    const candidate = expectCaptured(await session.capture())

    expect(candidate.files.map((record) => record.path.toString('latin1'))).toEqual(['deep/file.txt', 'notes/kept.txt'])
    expect(candidate.patch.toString('latin1')).not.toMatch(/\.git\/|editor metadata|flowproof\.editor|stray/)
  })

  it('keeps built-in end-of-line normalization so an unchanged CRLF checkout is not a change', async () => {
    const baseline = await commitBaseline(new Map([['.gitattributes', file('*.txt text eol=crlf\n')], ['crlf.txt', file('a\nb\n')]]))
    const unchanged = await openSession(baseline)
    expect(await readFile(at(unchanged, 'crlf.txt'))).toEqual(Buffer.from('a\r\nb\r\n'))
    expect(await unchanged.capture()).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })

    const edited = await openSession(baseline)
    await writeFile(at(edited, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    const candidate = expectCaptured(await edited.capture())
    const final = new Map(baseline.state)
    final.set('crlf.txt', file('a\nb\nc\n'))
    expectFiles(candidate, baseline.state, final, [{ path: 'crlf.txt', operation: 'modified' }])
  })

  it('never runs editor-configured hooks, filters, monitors, or diff commands on the host', async () => {
    const markers = await createTempDirectory('flowproof-capture-markers-')
    cleanups.push(markers.remove)
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')], ['b.txt', file('b\n')]]))
    const session = await openSession(baseline)
    const script = async (name: string, body: string): Promise<string> => {
      const target = path.join(markers.path, name)
      await writeFile(target, `#!/bin/sh\ntouch ${JSON.stringify(path.join(markers.path, `${name}.ran`))}\n${body}\n`, { mode: 0o755 })
      return target
    }
    const hooks = path.join(markers.path, 'hooks')
    await mkdir(hooks)
    for (const hook of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction']) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\ntouch ${JSON.stringify(path.join(markers.path, `${hook}.ran`))}\n`, { mode: 0o755 })
    }
    const settings: Array<[string, string]> = [
      ['core.hooksPath', hooks],
      ['core.fsmonitor', await script('fsmonitor', 'exit 1')],
      ['filter.fp.clean', await script('clean', 'tr a-z A-Z')],
      ['filter.fp.smudge', await script('smudge', 'cat')],
      ['filter.fp.process', await script('process', 'exit 1')],
      ['filter.fp.required', 'true'],
      ['diff.fp.textconv', await script('textconv', 'cat "$1"')],
      ['diff.fp.command', await script('diffcommand', 'exit 0')],
      ['diff.external', await script('external', 'exit 0')],
      ['core.pager', await script('pager', 'cat')],
    ]
    for (const [key, value] of settings) editorGit(session, 'config', key, value)
    await writeFile(at(session, '.gitattributes'), '* filter=fp diff=fp\n')
    await writeFile(at(session, 'b.txt'), 'raw lowercase bytes\n')
    const home = await createTempDirectory('flowproof-capture-home-')
    cleanups.push(home.remove)
    await writeFile(path.join(home.path, '.gitconfig'), `[filter "fp"]\n\tclean = ${await script('globalclean', 'tr a-z A-Z')}\n`)
    const saved = { HOME: process.env.HOME, GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS }
    process.env.HOME = home.path
    process.env.GIT_CONFIG_PARAMETERS = `'filter.fp.clean'='${await script('envclean', 'tr a-z A-Z')}'`
    let result: CaptureResult
    try {
      result = await session.capture()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    const candidate = expectCaptured(result)
    expect((await readdir(markers.path)).filter((name) => name.endsWith('.ran'))).toEqual([])
    const final = new Map(baseline.state)
    final.set('b.txt', file('raw lowercase bytes\n'))
    final.set('.gitattributes', file('* filter=fp diff=fp\n'))
    expectFiles(candidate, baseline.state, final, [
      { path: '.gitattributes', operation: 'added' },
      { path: 'b.txt', operation: 'modified' },
    ])
  })
})

// ---------------------------------------------------------------------------------------
// T013 (US2): the existing trusted scanner checks every exposed surface before release: raw
// old and new blobs (including binary payloads the encoded patch hides), raw path bytes, and
// the patch. A match rejects the whole candidate with a fixed reason; nothing is redacted.
// Credential-shaped values are assembled from fragments so fixtures never look like secrets.
// ---------------------------------------------------------------------------------------

const SEEDED = ['FPCAPTURE', 'SEEDED', 'MARKER', '000002'].join('')
const SEEDED_SCANNER = createSecretScanner({ markers: [SEEDED] })
const CREDENTIAL = ['gh', 'p_', 'FPCAPTURE', 'SEEDED', 'TOKEN', '00000000002'].join('')

/** The editor's working tree, index, and HEAD; capture must leave them exactly as they were. */
function editorView(session: Session): string {
  return [git(session.workspacePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), git(session.workspacePath, 'rev-parse', 'HEAD')].join('|')
}

function expectSensitiveRejection(result: CaptureResult, ...secrets: string[]): void {
  expect(result).toEqual({
    status: 'rejected',
    reasonCode: 'SENSITIVE_DATA',
    message: 'Capture was rejected because a changed path or payload matched a required sensitive-data check.',
    coverage: { scope: 'main_repository', note: null },
  })
  const serialized = JSON.stringify(result)
  for (const secret of secrets) expect(serialized).not.toContain(secret)
}

describe('sensitive-data admission', () => {
  const binaryWith = (marker: string): Buffer => Buffer.concat([BINARY_V1, Buffer.from(marker, 'latin1'), BINARY_V2])

  it.each([
    ['an added text line', async (s: Session) => writeFile(at(s, 'a.txt'), `a\n${SEEDED}\n`)],
    ['a removed text line', async (s: Session) => writeFile(at(s, 'seeded.txt'), 'clean now\n')],
    ['a deleted text file', async (s: Session) => unlink(at(s, 'seeded.txt'))],
    ['a new binary payload hidden by patch encoding', async (s: Session) => writeFile(at(s, 'new.bin'), binaryWith(SEEDED))],
    ['an old binary payload hidden by patch encoding', async (s: Session) => unlink(at(s, 'seeded.bin'))],
    ['a modified binary payload', async (s: Session) => writeFile(at(s, 'seeded.bin'), BINARY_V2)],
    ['raw filename bytes', async (s: Session) => writeFile(Buffer.concat([at(s, ''), Buffer.from(`notes-${SEEDED}-`, 'latin1'), Buffer.from([0xff, 0x2e, 0x74])]), 'x\n')],
    ['a UTF-8 filename', async (s: Session) => writeFile(at(s, `${SEEDED}.txt`), 'x\n')],
    ['a credential-shaped text value', async (s: Session) => writeFile(at(s, 'config.env'), `SETTING=${CREDENTIAL}\n`)],
  ])('rejects the whole candidate for a match in %s', async (_label, edit) => {
    const baseline = await commitBaseline(
      new Map([
        ['a.txt', file('a\n')],
        ['seeded.txt', file(`keep\n${SEEDED}\n`)],
        ['seeded.bin', file(binaryWith(SEEDED))],
      ]),
    )
    const session = await openSession(baseline)
    await writeFile(at(session, 'clean-change.txt'), 'an unrelated clean change\n')
    await edit(session)
    const before = editorView(session)

    const result = await session.capture({ scanner: SEEDED_SCANNER })

    expectSensitiveRejection(result, SEEDED, CREDENTIAL)
    // No redacted substitute, no retry, no edit: the editor's view is untouched.
    expect(editorView(session)).toBe(before)
  })

  it('proves the binary marker is invisible in the encoded patch yet still rejected', async () => {
    const baseline = await commitBaseline(new Map([['seeded.bin', file(binaryWith(SEEDED))]]))
    const clean = await openSession(baseline)
    await unlink(at(clean, 'seeded.bin'))
    const unscanned = expectCaptured(await clean.capture())
    expect(unscanned.patch.includes(SEEDED)).toBe(false)
    expect(unscanned.patch.toString('latin1')).toContain('GIT binary patch')

    const session = await openSession(baseline)
    await unlink(at(session, 'seeded.bin'))
    expectSensitiveRejection(await session.capture({ scanner: SEEDED_SCANNER }), SEEDED)
  })

  it('releases a clean change unchanged when no applicable check matches', async () => {
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')]]))
    const session = await openSession(baseline)
    await writeFile(at(session, 'a.txt'), 'a clean edit\n')
    const candidate = expectCaptured(await session.capture({ scanner: SEEDED_SCANNER }))
    expect(candidate.files.map((record) => record.path.toString('utf8'))).toEqual(['a.txt'])
  })
})

// ---------------------------------------------------------------------------------------
// T015 (US2): completeness and operational failures. A non-ignored entry Git would silently
// drop is a rejection; an unreadable workspace or Git state is a failure; the one shared byte
// budget covers metadata, patch, and raw payload reads; the one deadline and cancellation stop
// capture. Every outcome is whole: no candidate fragment, fixed safe text, joined children.
// ---------------------------------------------------------------------------------------

const NON_CANDIDATE_KEYS = ['status', 'reasonCode', 'message', 'coverage']

async function expectWhole(session: Session, result: CaptureResult, status: string, reasonCode: string): Promise<void> {
  expect(result).toMatchObject({ status, reasonCode })
  expect(Object.keys(result)).toEqual(NON_CANDIDATE_KEYS)
  const serialized = JSON.stringify(result)
  for (const forbidden of [session.workspacePath, session.pinned.gitDir, session.baseline.root, 'fatal', 'error:', 'EACCES']) {
    expect(serialized).not.toContain(forbidden)
  }
  expect(await processesWithin(session.workspacePath)).toEqual([])
  expect(await processesWithin(session.pinned.gitDir)).toEqual([])
}

const mkfifo = (target: Buffer): void => {
  execFileSync('mkfifo', [target.toString('latin1')])
}

describe('completeness and failure accuracy', () => {
  it('rejects a non-ignored special entry Git would silently drop, but not ignored output', async () => {
    const baseline = await commitBaseline(new Map([['.gitignore', file('build/\n*.sock\n')], ['a.txt', file('a\n')], ['tracked.txt', file('t\n')]]))

    const ignored = await openSession(baseline)
    await mkdir(at(ignored, 'build'))
    mkfifo(at(ignored, 'build/pipe'))
    mkfifo(at(ignored, 'local.sock'))
    expect(await ignored.capture()).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })

    const fifo = await openSession(baseline)
    await writeFile(at(fifo, 'a.txt'), 'a2\n')
    mkfifo(at(fifo, 'pipe'))
    await expectWhole(fifo, await fifo.capture(), 'rejected', 'UNREPRESENTABLE_ENTRY')

    const replaced = await openSession(baseline)
    await unlink(at(replaced, 'tracked.txt'))
    mkfifo(at(replaced, 'tracked.txt'))
    await expectWhole(replaced, await replaced.capture(), 'rejected', 'UNREPRESENTABLE_ENTRY')

    const socket = await openSession(baseline)
    const server = (await import('node:net')).createServer()
    await new Promise<void>((resolve) => server.listen(at(socket, 'agent.socket').toString('latin1'), resolve))
    try {
      await expectWhole(socket, await socket.capture(), 'rejected', 'UNREPRESENTABLE_ENTRY')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports unreadable workspace or Git state as a failure, never as no changes or a rejection', async () => {
    const baseline = await commitBaseline(new Map([['a.txt', file('a\n')], ['dir/b.txt', file('b\n')]]))

    const unreadable = await openSession(baseline)
    await chmod(at(unreadable, 'dir'), 0o000)
    cleanups.push(async () => chmod(at(unreadable, 'dir'), 0o755))
    const denied = await unreadable.capture()
    await chmod(at(unreadable, 'dir'), 0o755)
    await expectWhole(unreadable, denied, 'failed', 'CAPTURE_IO_FAILED')

    const corrupt = await openSession(baseline)
    await writeFile(at(corrupt, '.git/index'), `DIRC corrupt index naming ${corrupt.workspacePath}`)
    await expectWhole(corrupt, await corrupt.capture(), 'failed', 'CAPTURE_IO_FAILED')

    // The pinned baseline objects are unavailable: a preparation-level read failure.
    const missing = await openSession(baseline)
    const empty = await createTempDirectory('flowproof-capture-empty-objects-')
    cleanups.push(empty.remove)
    const broken = await captureChanges({ sessionId: missing.sessionId, workspace: { ...missing.pinned, objectDirectory: empty.path }, scanner: SCANNER })
    await expectWhole(missing, broken, 'failed', 'CAPTURE_IO_FAILED')
  })

  it('counts metadata, patch, and raw payload reads against one shared byte budget', async () => {
    // Metadata: many long tracked names exceed the budget before any patch exists.
    const names = new Map<string, Entry>(Array.from({ length: 400 }, (_, index) => [`src/${'n'.repeat(80)}-${index}.txt`, file(`${index}\n`)]))
    const metadata = await openSession(await commitBaseline(names))
    await writeFile(at(metadata, 'src/new.txt'), 'x\n')
    await expectWhole(metadata, await metadata.capture({ bounds: { byteLimit: 8 * 1024 } }), 'rejected', 'CAPTURE_LIMIT')

    // Patch: a large text addition exceeds the budget while producing the patch.
    const text = await openSession(await commitBaseline(new Map([['a.txt', file('a\n')]])))
    await writeFile(at(text, 'large.txt'), 'line of ordinary text\n'.repeat(12_000))
    await expectWhole(text, await text.capture({ bounds: { byteLimit: 160 * 1024 } }), 'rejected', 'CAPTURE_LIMIT')

    // Raw payload: a compressible binary has a small patch but a large raw blob to check.
    const zeros = Buffer.alloc(2 * 1024 * 1024)
    const roomy = await openSession(await commitBaseline(new Map([['a.txt', file('a\n')]])))
    await writeFile(at(roomy, 'zeros.bin'), zeros)
    const fits = expectCaptured(await roomy.capture())
    expect(fits.patch.length).toBeLessThan(64 * 1024)
    expect(fits.files[0]?.newSize).toBe(zeros.length)
    const payload = await openSession(await commitBaseline(new Map([['a.txt', file('a\n')]])))
    await writeFile(at(payload, 'zeros.bin'), zeros)
    await expectWhole(payload, await payload.capture({ bounds: { byteLimit: 512 * 1024 } }), 'rejected', 'CAPTURE_LIMIT')
  })

  it(
    'rejects a change set beyond the fixed 32-MiB ceiling instead of publishing a truncated patch',
    async () => {
      const session = await openSession(await commitBaseline(new Map([['a.txt', file('a\n')]])))
      await writeFile(at(session, 'random.bin'), (await import('node:crypto')).randomBytes(33 * 1024 * 1024))
      await expectWhole(session, await session.capture(), 'rejected', 'CAPTURE_LIMIT')
    },
    120_000,
  )

  it('stops at the shared deadline and on cancellation before or during capture', async () => {
    const baseline = await commitBaseline(new Map(Array.from({ length: 3_000 }, (_, index): [string, Entry] => [`files/${index}.txt`, file(`${index}\n`)])))

    const late = await openSession(baseline)
    await writeFile(at(late, 'files/new.txt'), 'x\n')
    await expectWhole(late, await late.capture({ bounds: { deadlineMs: 1 } }), 'rejected', 'CAPTURE_LIMIT')

    const early = await openSession(baseline)
    await expectWhole(early, await early.capture({ signal: AbortSignal.abort() }), 'failed', 'CAPTURE_INTERRUPTED')

    const during = await openSession(baseline)
    for (let index = 0; index < 3_000; index += 1) await writeFile(at(during, `files/${index}.txt`), `${index} edited\n`)
    const controller = new AbortController()
    const privateIndex = path.join(during.pinned.gitDir, 'index')
    const watcher = setInterval(() => {
      if (existsSync(privateIndex)) controller.abort()
    }, 1)
    try {
      await expectWhole(during, await during.capture({ signal: controller.signal }), 'failed', 'CAPTURE_INTERRUPTED')
    } finally {
      clearInterval(watcher)
    }
    expect(controller.signal.aborted).toBe(true)
    // Preparing and snapshotting several 3,000-file workspaces exceeds Vitest's default
    // five seconds on shared CI runners. This does not change capture's tested deadlines.
  }, 30_000)
})
