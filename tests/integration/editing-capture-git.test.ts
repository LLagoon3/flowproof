import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { captureGitEnvironment, createCaptureBudget, runCaptureGit } from '../../packages/flowproof/src/editing/captureGit.js'
import { WorkspaceError, createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import type { CaptureWorkspace, SessionWorkspace } from '../../packages/flowproof/src/editing/workspace.js'
import { createPrivateTmpRoot, createSyntheticRepository, listTree } from '../support/editingRuntime.js'
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
