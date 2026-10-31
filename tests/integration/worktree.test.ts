import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempClone, createTempDirectory, git, gitStatus, listTree, snapshotRepository } from '../support/repoFixture.js'
import type { RepositorySnapshot } from '../support/repoFixture.js'

// T027: the detached-worktree contract that T038 implements in
// `packages/flowproof/src/worktree/session.ts`. Every case runs against a temporary clone of
// this repository with unrelated pre-existing worktrees registered, and compares the complete
// original snapshot (tracked contents, status, index, branch, HEAD, refs/history, config,
// `git worktree list --porcelain`, and Git administrative entries) after every exit path.

export interface WorktreeIntegrityReport {
  readonly unchanged: boolean
  /** Snapshot facets that differ from the pre-run baseline, for example `status`. */
  readonly mismatches: readonly string[]
}

export interface WorktreeSession {
  /** Canonical original repository root. */
  readonly repoRoot: string
  /** Absolute canonical `git rev-parse --git-common-dir` of the original repository. */
  readonly gitCommonDir: string
  readonly originalHead: string
  /** The complete pre-run `git worktree list --porcelain` output. */
  readonly worktreeListBaseline: string
  /** Absolute path of the FlowProof-owned detached worktree under the OS temporary directory. */
  readonly path: string
  /** Runs the committed `app.start_command` inside the worktree; returns the built document root. */
  build(): Promise<{ readonly documentRoot: string }>
  /** Applies an already validated unified diff to the worktree only. */
  applyDiff(unifiedDiff: string): Promise<void>
  /** `git worktree remove --force`, `git worktree prune`, then full snapshot comparison. Idempotent. */
  dispose(): Promise<WorktreeIntegrityReport>
}

export interface WorktreeModule {
  createWorktreeSession(options: { readonly repoRoot: string; readonly scenario: LoadedScenario }): Promise<WorktreeSession>
  WorktreeError: new (...args: never[]) => Error & { readonly code: string }
}

const MODULE_PATH = 'packages/flowproof/src/worktree/session.ts'
const worktreeModule = (): Promise<WorktreeModule> =>
  loadPendingModule<WorktreeModule>(MODULE_PATH, 'T038', ['createWorktreeSession', 'WorktreeError'])

const SOURCE = 'apps/demo-chart/src/filterData.ts'
const BUILD_TIMEOUT = 120_000
const KNOWN_SAFE_DIFF = (loadRecordedHeroResponse() as { candidate: { unified_diff: string } }).candidate.unified_diff

// A diff that applies cleanly but leaves the app unbuildable.
const BREAKING_DIFF = KNOWN_SAFE_DIFF.replace(
  '+  return rows.filter((row) => row.region === region)',
  '+  return rows.filter((row) => row.region === region',
)
// A diff whose context does not match the committed file.
const STALE_DIFF = KNOWN_SAFE_DIFF.replace(
  '-  return rows.filter((row) => row.region.includes(region))',
  '-  return rows.filter((row) => row.region.startsWith(region))',
)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Fixture {
  readonly repo: string
  readonly scenario: LoadedScenario
  /** Unrelated worktrees that must survive every FlowProof cleanup. */
  readonly unrelated: { readonly plain: string; readonly locked: string }
}

async function fixture(): Promise<Fixture> {
  const clone = await createTempClone({ withDependencies: true })
  const side = await createTempDirectory('flowproof-unrelated-')
  cleanups.push(clone.remove, side.remove)
  const repo = clone.path
  // GitHub Actions checks pull requests out at a detached merge commit. A local clone of that
  // checkout may therefore also start detached, which would make the branch/ref mutation cases
  // no-ops. Give this suite the explicit branch baseline its integrity assertions exercise.
  git(repo, 'checkout', '--quiet', '-B', 'flowproof-fixture-main')
  const plain = path.join(side.path, 'plain')
  const locked = path.join(side.path, 'locked')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'unrelated/plain', plain)
  git(repo, 'worktree', 'add', '--quiet', '--detach', locked)
  git(repo, 'worktree', 'lock', '--reason', 'owned by another tool', locked)
  cleanups.push(async () => {
    // Unlock first so the temporary clone can be deleted even after a failed assertion.
    gitStatus(repo, 'worktree', 'unlock', locked)
  })
  return { repo, scenario: await loadScenario('canvas-filter-hero', { repoRoot: repo }), unrelated: { plain, locked } }
}

/** Every snapshot facet except the worktree registrations, which legitimately grow mid-run. */
function originalState(snapshot: RepositorySnapshot): Omit<RepositorySnapshot, 'worktreeList' | 'worktreeAdminEntries'> {
  return {
    gitCommonDir: snapshot.gitCommonDir,
    head: snapshot.head,
    branch: snapshot.branch,
    status: snapshot.status,
    index: snapshot.index,
    refs: snapshot.refs,
    history: snapshot.history,
    localConfig: snapshot.localConfig,
    trackedFiles: snapshot.trackedFiles,
  }
}

const CLEAN = { unchanged: true, mismatches: [] }

/** Creates a session and guarantees disposal even when the test fails first. */
async function open(mod: WorktreeModule, fx: Fixture): Promise<WorktreeSession> {
  const session = await mod.createWorktreeSession({ repoRoot: fx.repo, scenario: fx.scenario })
  cleanups.push(async () => {
    await session.dispose().catch(() => undefined)
  })
  return session
}

async function expectWorktreeError(action: () => Promise<unknown>, mod: WorktreeModule, code: string): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(mod.WorktreeError)
  expect((caught as { code: string }).code).toBe(code)
}

describe('detached worktree session', () => {
  it('resolves the Git common directory instead of assuming .git/worktrees', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const commonDir = await realpath(path.join(fx.repo, '.git'))

    const fromMain = await open(mod, fx)
    expect(fromMain.gitCommonDir).toBe(commonDir)
    await fromMain.dispose()

    // Started from a linked worktree, the common directory is still the main repository's.
    const linkedScenario = await loadScenario('canvas-filter-hero', { repoRoot: fx.unrelated.plain })
    const fromLinked = await mod.createWorktreeSession({ repoRoot: fx.unrelated.plain, scenario: linkedScenario })
    cleanups.push(async () => {
      await fromLinked.dispose().catch(() => undefined)
    })
    expect(fromLinked.gitCommonDir).toBe(commonDir)
    expect(fromLinked.gitCommonDir).not.toContain(`${path.sep}worktrees${path.sep}`)
    expect((await fromLinked.dispose()).unchanged).toBe(true)
  })

  it('snapshots the complete pre-run worktree list and creates a detached worktree at the original HEAD', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const listBefore = git(fx.repo, 'worktree', 'list', '--porcelain')
    const refsBefore = git(fx.repo, 'for-each-ref', '--format=%(refname) %(objectname)')
    const head = git(fx.repo, 'rev-parse', 'HEAD').trim()

    const session = await open(mod, fx)

    expect(session.repoRoot).toBe(await realpath(fx.repo))
    expect(session.originalHead).toBe(head)
    expect(session.worktreeListBaseline).toBe(listBefore)
    expect(session.worktreeListBaseline).toContain(`worktree ${fx.unrelated.plain}\n`)
    expect(session.worktreeListBaseline).toContain(`worktree ${fx.unrelated.locked}\n`)

    // OS-temporary location, outside the original working tree.
    const tmpRoot = await realpath(tmpdir())
    expect(session.path.startsWith(`${tmpRoot}${path.sep}`)).toBe(true)
    expect(session.path.startsWith(`${fx.repo}${path.sep}`)).toBe(false)

    // Detached at the original HEAD: no branch, no new ref, no commit.
    expect(git(session.path, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(gitStatus(session.path, 'symbolic-ref', '-q', 'HEAD')).not.toBe(0)
    const during = git(fx.repo, 'worktree', 'list', '--porcelain')
    expect(during).toContain(`worktree ${session.path}\nHEAD ${head}\ndetached\n`)
    expect(git(fx.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore)
    await expect(readFile(path.join(session.path, SOURCE), 'utf8')).resolves.toBe(
      await readFile(path.join(fx.repo, SOURCE), 'utf8'),
    )
  })

  it(
    'runs the committed build command inside the worktree only',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture()
      const before = await snapshotRepository(fx.repo)
      const session = await open(mod, fx)

      const { documentRoot } = await session.build()

      expect(documentRoot.startsWith(`${session.path}${path.sep}`)).toBe(true)
      expect(existsSync(path.join(documentRoot, 'index.html'))).toBe(true)
      // The original working tree receives no build output.
      expect(existsSync(path.join(fx.repo, fx.scenario.scenario.app.root, 'dist'))).toBe(false)
      expect(originalState(await snapshotRepository(fx.repo))).toEqual(originalState(before))
    },
    BUILD_TIMEOUT,
  )

  it(
    'leaves no Node compile-cache residue in the temporary root after a build',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture()
      const privateTmp = await createTempDirectory('flowproof-build-tmp-')
      cleanups.push(privateTmp.remove)
      const savedTmp = process.env.TMPDIR
      process.env.TMPDIR = privateTmp.path

      try {
        const session = await open(mod, fx)
        await session.build()
        await session.dispose()

        expect(await listTree(privateTmp.path)).toEqual([])
      } finally {
        if (savedTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = savedTmp
      }
    },
    BUILD_TIMEOUT,
  )

  it(
    'applies a known safe diff only in the worktree and rebuilds the patched app',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture()
      const originalSource = await readFile(path.join(fx.repo, SOURCE), 'utf8')
      const session = await open(mod, fx)

      await session.applyDiff(KNOWN_SAFE_DIFF)

      const patched = await readFile(path.join(session.path, SOURCE), 'utf8')
      expect(patched).toContain('row.region === region')
      expect(patched).not.toContain('row.region.includes(region)')
      expect(git(session.path, 'diff', '--name-only')).toBe(`${SOURCE}\n`)
      // The candidate is never committed or staged, in the worktree or the original.
      expect(git(session.path, 'rev-parse', 'HEAD').trim()).toBe(session.originalHead)
      expect(git(session.path, 'diff', '--cached', '--name-only')).toBe('')
      await expect(readFile(path.join(fx.repo, SOURCE), 'utf8')).resolves.toBe(originalSource)
      expect(git(fx.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')

      const { documentRoot } = await session.build()
      expect(existsSync(path.join(documentRoot, 'index.html'))).toBe(true)
    },
    BUILD_TIMEOUT,
  )

  it(
    'removes and prunes its own entry and restores the complete snapshot on the normal path',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture()
      const before = await snapshotRepository(fx.repo)
      const session = await open(mod, fx)
      await session.applyDiff(KNOWN_SAFE_DIFF)
      await session.build()
      const adminDuring = (await snapshotRepository(fx.repo)).worktreeAdminEntries
      expect(adminDuring.length).toBe(before.worktreeAdminEntries.length + 1)

      // The worktree is dirty with the candidate and build output, so only --force removes it.
      const report = await session.dispose()

      expect(report).toMatchObject(CLEAN)
      expect(existsSync(session.path)).toBe(false)
      expect(await snapshotRepository(fx.repo)).toEqual(before)
      // Unrelated worktrees, including a locked one, remain registered and intact.
      expect(git(fx.repo, 'worktree', 'list', '--porcelain')).toBe(before.worktreeList)
      expect(existsSync(path.join(fx.unrelated.plain, SOURCE))).toBe(true)
      expect(existsSync(path.join(fx.unrelated.locked, SOURCE))).toBe(true)
      // Disposal is idempotent.
      await expect(session.dispose()).resolves.toMatchObject(CLEAN)
    },
    BUILD_TIMEOUT,
  )

  it(
    'restores the complete snapshot after a failed build',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture()
      const before = await snapshotRepository(fx.repo)
      const session = await open(mod, fx)
      await session.applyDiff(BREAKING_DIFF)

      await expectWorktreeError(() => session.build(), mod, 'WORKTREE_BUILD_FAILED')

      expect(await session.dispose()).toMatchObject(CLEAN)
      expect(await snapshotRepository(fx.repo)).toEqual(before)
    },
    BUILD_TIMEOUT,
  )

  it('restores the complete snapshot after a diff that does not apply', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const before = await snapshotRepository(fx.repo)
    const session = await open(mod, fx)
    const committed = await readFile(path.join(session.path, SOURCE), 'utf8')

    await expectWorktreeError(() => session.applyDiff(STALE_DIFF), mod, 'WORKTREE_APPLY_FAILED')

    await expect(readFile(path.join(session.path, SOURCE), 'utf8')).resolves.toBe(committed)
    expect(await session.dispose()).toMatchObject(CLEAN)
    expect(await snapshotRepository(fx.repo)).toEqual(before)
  })

  it('still removes its administrative entry when the worktree directory vanished', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const before = await snapshotRepository(fx.repo)
    const session = await open(mod, fx)

    await rm(session.path, { recursive: true, force: true })

    expect(await session.dispose()).toMatchObject(CLEAN)
    expect(await snapshotRepository(fx.repo)).toEqual(before)
  })

  it('reports an original-repository change detected at cleanup instead of hiding it', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const session = await open(mod, fx)
    const readme = path.join(fx.repo, 'README.md')
    const original = await readFile(readme, 'utf8')

    await writeFile(readme, `${original}\nchanged during the run\n`)
    const report = await session.dispose()
    await writeFile(readme, original)

    expect(report.unchanged).toBe(false)
    expect(report.mismatches.length).toBeGreaterThan(0)
    // The FlowProof-owned entry is still removed and pruned.
    expect(git(fx.repo, 'worktree', 'list', '--porcelain')).toBe(session.worktreeListBaseline)
  })

  // T008 (Spec 002): regression coverage for the shared Git runner and snapshot primitives that
  // the editing runtime reuses. They must behave identically before and after extraction.
  it('runs Git without a shell, inherited Git overrides, global configuration, or hooks', async () => {
    const mod = await worktreeModule()
    const side = await createTempDirectory('flowproof-git-safety-')
    cleanups.push(side.remove)
    // A repository path full of shell metacharacters must be passed through as one argument.
    const parent = path.join(side.path, 'repo $(touch flowproof-shell-marker) ; `touch flowproof-shell-marker` & x')
    await mkdir(parent)
    const repo = path.join(parent, 'repo')
    git(REPO_ROOT, 'clone', '--quiet', REPO_ROOT, repo)
    await appendFile(path.join(repo, '.git', 'info', 'exclude'), '\nnode_modules\n')
    const hookMarker = path.join(side.path, 'hook-ran')
    const hook = `#!/bin/sh\ntouch '${hookMarker}'\n`
    // A repository-local hook and a hostile global configuration that would install another.
    await writeFile(path.join(repo, '.git', 'hooks', 'post-checkout'), hook, { mode: 0o755 })
    const globalHooks = path.join(side.path, 'global-hooks')
    await mkdir(globalHooks)
    await writeFile(path.join(globalHooks, 'post-checkout'), hook, { mode: 0o755 })
    const globalConfig = path.join(side.path, 'global.gitconfig')
    await writeFile(globalConfig, `[core]\n\thooksPath = ${globalHooks}\n`)
    const before = await snapshotRepository(repo)
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_DIR: process.env.GIT_DIR }
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_INDEX_FILE: path.join(side.path, 'missing', 'index'), GIT_DIR: side.path })
    const scenario = await loadScenario('canvas-filter-hero', { repoRoot: repo })
    let session: WorktreeSession
    try {
      session = await mod.createWorktreeSession({ repoRoot: repo, scenario })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    cleanups.push(async () => {
      await session.dispose().catch(() => undefined)
    })
    expect(git(session.path, 'rev-parse', 'HEAD').trim()).toBe(before.head)

    expect(await session.dispose()).toMatchObject(CLEAN)
    expect(existsSync(hookMarker)).toBe(false)
    for (const directory of [side.path, parent, process.cwd()]) expect(existsSync(path.join(directory, 'flowproof-shell-marker'))).toBe(false)
    expect(await snapshotRepository(repo)).toEqual(before)
  })

  it.each([
    ['localConfig', ['localConfig'], (repo: string) => git(repo, 'config', '--local', 'flowproof.probe', 'changed')],
    ['refs', ['refs'], (repo: string) => git(repo, 'branch', 'flowproof-probe')],
    ['an untracked file', ['status'], (repo: string) => writeFile(path.join(repo, 'flowproof-untracked.txt'), 'x')],
    [
      'the index',
      ['status', 'index', 'trackedFiles'],
      async (repo: string) => {
        await writeFile(path.join(repo, 'flowproof-staged.txt'), 'x')
        git(repo, 'add', 'flowproof-staged.txt')
      },
    ],
    // The porcelain worktree list also records the main worktree's HEAD and branch.
    ['HEAD and history', ['head', 'refs', 'history', 'worktreeList'], (repo: string) => git(repo, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'probe')],
    ['the checked-out branch', ['branch', 'worktreeList'], (repo: string) => git(repo, 'checkout', '--quiet', '--detach')],
    [
      'a tracked file',
      ['status', 'trackedFiles'],
      (repo: string) => writeFile(path.join(repo, 'README.md'), 'changed during the run\n', { flag: 'a' }),
    ],
    [
      'the registered worktrees',
      ['worktreeList', 'worktreeAdminEntries'],
      async (repo: string) => {
        const extra = await createTempDirectory('flowproof-extra-worktree-')
        cleanups.push(extra.remove)
        git(repo, 'worktree', 'add', '--quiet', '--detach', path.join(extra.path, 'extra'))
      },
    ],
  ] as const)('names exactly the changed snapshot facets after %s changes', async (_label, expected, mutate) => {
    const mod = await worktreeModule()
    const fx = await fixture()
    const session = await open(mod, fx)

    await mutate(fx.repo)
    const report = await session.dispose()

    expect(report.unchanged).toBe(false)
    expect(report.mismatches).toEqual(expected)
    // FlowProof's own entry is still removed even though the comparison failed.
    expect(existsSync(session.path)).toBe(false)
  })

  it('refuses a dirty tracked baseline without creating a worktree or Git metadata', async () => {
    const mod = await worktreeModule()
    const fx = await fixture()
    await writeFile(path.join(fx.repo, SOURCE), '// uncommitted edit\n', { flag: 'a' })
    const before = await snapshotRepository(fx.repo)

    await expectWorktreeError(
      () => mod.createWorktreeSession({ repoRoot: fx.repo, scenario: fx.scenario }),
      mod,
      'WORKING_TREE_DIRTY',
    )

    expect(await snapshotRepository(fx.repo)).toEqual(before)
  })
})
