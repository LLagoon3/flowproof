import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SUBMODULE_COVERAGE_NOTE, createCandidate } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureCandidate, CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import {
  advanceHead,
  blobId,
  createStateRepository,
  file,
  gitlink,
  inventoryRepository,
  link,
  produceCapturingResult,
  rawKey,
  scratchGit,
  stageExpectedTree,
} from '../support/capturedCandidate.js'
import type { ExpectedTree, ObjectFormat, StateRepository, VersionedState } from '../support/capturedCandidate.js'
import { createPrivateTmpRoot, listTree } from '../support/editingRuntime.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { REPO_ROOT, createTempDirectory } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T009 (specs/004-verify-captured-changes, US1): exact application of a complete captured
// candidate at its recorded baseline. Each case captures a real Spec 003 candidate from a
// synthetic repository, advances the original HEAD past the baseline, applies the exact patch
// bytes once in a fresh owned worktree through a private Git index and object store, and compares
// the result with an independently staged expected tree by raw path bytes, mode, and object ID.
// Tampered, wrong-baseline, and missing-baseline inputs never yield a usable target, and the
// original object store, refs, index, config, tracked files, and worktree registrations stay
// unchanged. The synthetic repositories carry the committed scenario skeleton so the prepared
// scenario loads from them; nothing here builds or replays.

interface CandidateInput {
  readonly baselineCommit: string
  readonly patch: Uint8Array
  readonly files: CaptureCandidate['files']
}

type ApplicationOutcome =
  | { readonly applied: true; readonly tree: string; readonly files: number }
  | { readonly applied: false; readonly reason: 'BASELINE_UNAVAILABLE' | 'APPLICATION_REJECTED' | 'APPLICATION_FIDELITY_MISMATCH' }

interface CapturedWorktreeDisposal {
  readonly unchanged: boolean
  readonly mismatches: readonly string[]
  readonly worktreeRemoved: boolean
  readonly privateStateRemoved: boolean
}

interface CapturedWorktreeSession {
  readonly repoRoot: string
  readonly originalHead: string
  readonly baselineCommit: string
  readonly objectFormat: ObjectFormat
  /** The owned detached worktree. */
  readonly path: string
  applyCandidate(candidate: CandidateInput, options?: { readonly signal?: AbortSignal }): Promise<ApplicationOutcome>
  build(options?: { readonly signal?: AbortSignal }): Promise<{ readonly documentRoot: string }>
  dispose(): Promise<CapturedWorktreeDisposal>
}

interface WorktreeModule {
  createCapturedWorktreeSession(options: { readonly repoRoot: string; readonly scenario: LoadedScenario; readonly baselineCommit: string }): Promise<CapturedWorktreeSession>
  WorktreeError: new (...args: never[]) => Error & { readonly code: string }
}

const worktreeModule = (): Promise<WorktreeModule> =>
  loadPendingModule<WorktreeModule>('packages/flowproof/src/worktree/session.ts', 'T013', ['createCapturedWorktreeSession', 'WorktreeError'])

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

/** The committed files the prepared scenario loader needs, so it loads from a synthetic repository. */
const SKELETON = [
  'scenarios/canvas-filter/hero.json',
  'scenarios/canvas-filter/expected/filtered-data.json',
  'scenarios/canvas-filter/expected/chart-series.json',
  'apps/demo-chart/src/filterData.ts',
] as const

async function skeleton(): Promise<VersionedState> {
  const state: VersionedState = new Map()
  for (const relative of SKELETON) state.set(relative, file(await readFile(path.join(REPO_ROOT, relative))))
  return state
}

const BINARY_V1 = Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x0a, 0x80])
const BINARY_V2 = Buffer.from([0x89, 0x50, 0x00, 0x02, 0xff, 0x00, 0x00, 0x0d, 0x0a, 0x7f])
const BINARY_NEW = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00])
const RAW_NAME = rawKey(Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]))
const UTF8_NAME = rawKey(Buffer.from('docs/ünïcode-파일.txt', 'utf8'))
const FILTER_MARKER = 'filter-runs.log'
const HOOK_MARKER = 'hook-runs.log'

const fakeCommit = (format: ObjectFormat, digit: string): string => digit.repeat(format === 'sha1' ? 40 : 64)

/** A standalone repository with one commit inside the editing clone; its HEAD is the new gitlink. */
async function nestedRepository(root: string, format: ObjectFormat, content: string): Promise<string> {
  await mkdir(root, { recursive: true })
  scratchGit(root, ['init', '--quiet', `--object-format=${format}`, '--initial-branch=main'])
  await writeFile(path.join(root, 'nested.txt'), content)
  scratchGit(root, ['add', 'nested.txt'])
  scratchGit(root, ['-c', 'user.email=nested@example.invalid', '-c', 'user.name=Nested', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'nested'])
  return scratchGit(root, ['rev-parse', 'HEAD']).toString('utf8').trim()
}

const at = (root: string, key: string): Buffer => Buffer.concat([Buffer.from(`${root}/`), Buffer.from(key, 'latin1')])

interface Fixture {
  readonly repo: StateRepository
  readonly baseline: string
  readonly head: string
  readonly scenario: LoadedScenario
  readonly result: CapturingEditingSessionResult
  readonly candidate: CaptureCandidate
  readonly expected: ExpectedTree
  readonly expectedState: VersionedState
  readonly tmp: TempDirectory
}

/**
 * Commits `baseline`, captures `edit` from a real editing clone at that baseline, advances the
 * original HEAD, and stages the independently expected final tree.
 */
async function fixture(options: {
  readonly format: ObjectFormat
  readonly baseline: VersionedState
  readonly edit: (workspace: string, expected: VersionedState) => Promise<void>
  readonly advance?: Readonly<Record<string, string>>
}): Promise<Fixture> {
  const state = new Map([...(await skeleton()), ...options.baseline])
  const repo = await createStateRepository(state, { objectFormat: options.format })
  const tmp = await createPrivateTmpRoot()
  cleanups.push(repo.remove, tmp.remove)
  const expectedState: VersionedState = new Map(state)
  const result = await produceCapturingResult({
    repositoryRoot: repo.root,
    baselineCommit: repo.commit,
    tmpRoot: tmp.path,
    edit: (workspace) => options.edit(workspace, expectedState),
  })
  expect(result.capture.status, JSON.stringify(result.capture)).toBe('captured')
  if (result.capture.status !== 'captured') throw new Error('not captured')
  const head = await advanceHead(repo.root, options.advance ?? { 'later.txt': 'a later original commit\n' })
  expect(head).not.toBe(repo.commit)
  return {
    repo,
    baseline: repo.commit,
    head,
    scenario: await loadScenario('canvas-filter-hero', { repoRoot: repo.root }),
    result,
    candidate: result.capture.candidate,
    expected: await stageExpectedTree(expectedState, options.format),
    expectedState,
    tmp,
  }
}

/** Runs `action` with session temporary output under a private root, which must end empty. */
async function withPrivateTmp<T>(action: (tmpRoot: string) => Promise<T>): Promise<T> {
  const root = await createTempDirectory('flowproof-captured-wt-')
  cleanups.push(root.remove)
  const saved = process.env.TMPDIR
  process.env.TMPDIR = root.path
  try {
    return await action(root.path)
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  }
}

async function openSession(mod: WorktreeModule, fx: Fixture, baselineCommit = fx.candidate.baselineCommit): Promise<CapturedWorktreeSession> {
  const session = await mod.createCapturedWorktreeSession({ repoRoot: fx.repo.root, scenario: fx.scenario, baselineCommit })
  cleanups.push(async () => {
    await session.dispose().catch(() => undefined)
  })
  return session
}

const input = (candidate: CaptureCandidate): CandidateInput => ({ baselineCommit: candidate.baselineCommit, patch: candidate.patch, files: candidate.files })

/** Every file and link below the worktree, by raw relative path; the `.git` pointer is excluded. */
async function worktreeLeaves(root: string): Promise<Map<string, { readonly mode: string; readonly objectId: string }>> {
  const leaves = new Map<string, { readonly mode: string; readonly objectId: string }>()
  const walk = async (relative: Buffer): Promise<void> => {
    const directory = relative.length === 0 ? Buffer.from(root) : Buffer.concat([Buffer.from(`${root}/`), relative])
    for (const entry of await readdir(directory, { withFileTypes: true, encoding: 'buffer' })) {
      if (relative.length === 0 && entry.name.equals(Buffer.from('.git'))) continue
      const child = relative.length === 0 ? Buffer.from(entry.name) : Buffer.concat([relative, Buffer.from('/'), entry.name])
      const absolute = Buffer.concat([Buffer.from(`${root}/`), child])
      if (entry.isDirectory()) await walk(child)
      else if (entry.isSymbolicLink()) leaves.set(rawKey(child), { mode: '120000', objectId: (await readlink(absolute, { encoding: 'buffer' })).toString('hex') })
      else leaves.set(rawKey(child), { mode: ((await lstat(absolute)).mode & 0o111) !== 0 ? '100755' : '100644', objectId: (await readFile(absolute)).toString('hex') })
    }
  }
  await walk(Buffer.alloc(0))
  return leaves
}

/** The worktree files equal the expected tree; gitlinks stay reference-only empty directories. */
async function expectWorktreeMatches(session: CapturedWorktreeSession, fx: Fixture): Promise<void> {
  const leaves = await worktreeLeaves(session.path)
  const expectedLeaves = new Map<string, { readonly mode: string; readonly objectId: string }>()
  for (const entry of fx.expected.entries) {
    const key = rawKey(entry.path)
    if (entry.mode === '160000') {
      const directory = at(session.path, key)
      if (existsSync(directory)) {
        expect((await lstat(directory)).isDirectory()).toBe(true)
        expect(await readdir(directory)).toEqual([])
      }
      continue
    }
    const data = (fx.expectedState.get(key) as { data: Buffer }).data
    expect(blobId(data, fx.repo.objectFormat), key).toBe(entry.objectId)
    expectedLeaves.set(key, { mode: entry.mode, objectId: data.toString('hex') })
  }
  const render = (map: Map<string, unknown>): Record<string, unknown> => Object.fromEntries([...map].map(([key, value]) => [Buffer.from(key, 'latin1').toString('hex'), value]))
  expect(render(leaves)).toEqual(render(expectedLeaves))
}

function richBaseline(format: ObjectFormat): VersionedState {
  return new Map([
    ['README.md', file('Status: pending\n')],
    ['src/app.txt', file('one\ntwo\nthree\n')],
    ['src/remove-me.txt', file('bye\n')],
    ['assets/logo.bin', file(BINARY_V1)],
    ['scripts/run.sh', file('#!/bin/sh\necho run\n')],
    ['scripts/tool.sh', file('#!/bin/sh\necho tool\n', '100755')],
    ['links/current', link('../src/app.txt')],
    ['vendor/lib', gitlink(fakeCommit(format, 'a'))],
  ])
}

/** Ordinary editor operations covering every supported entry effect. */
async function richEdit(workspace: string, expected: VersionedState, format: ObjectFormat): Promise<void> {
  const w = (key: string): Buffer => at(workspace, key)
  await writeFile(w('README.md'), 'Status: edited')
  expected.set('README.md', file('Status: edited'))
  await writeFile(w('src/app.txt'), 'one\n2\nthree\n')
  expected.set('src/app.txt', file('one\n2\nthree\n'))
  await unlink(w('src/remove-me.txt'))
  expected.delete('src/remove-me.txt')
  await writeFile(w('empty.txt'), '')
  expected.set('empty.txt', file(''))
  await writeFile(w(RAW_NAME), 'raw bytes in the name\n')
  expected.set(RAW_NAME, file('raw bytes in the name\n'))
  await mkdir(w('docs'))
  await writeFile(w(UTF8_NAME), 'café 안녕\n')
  expected.set(UTF8_NAME, file('café 안녕\n'))
  await writeFile(w('assets/logo.bin'), BINARY_V2)
  expected.set('assets/logo.bin', file(BINARY_V2))
  await writeFile(w('assets/new.bin'), BINARY_NEW)
  expected.set('assets/new.bin', file(BINARY_NEW))
  await chmod(w('scripts/run.sh'), 0o755)
  expected.set('scripts/run.sh', file('#!/bin/sh\necho run\n', '100755'))
  await chmod(w('scripts/tool.sh'), 0o644)
  expected.set('scripts/tool.sh', file('#!/bin/sh\necho tool\n'))
  await unlink(w('links/current'))
  await symlink('../README.md', w('links/current'))
  expected.set('links/current', link('../README.md'))
  await symlink('../src/app.txt', w('links/added'))
  expected.set('links/added', link('../src/app.txt'))
  expected.set('vendor/lib', gitlink(await nestedRepository(path.join(workspace, 'vendor', 'lib'), format, 'changed reference\n')))
  expected.set('vendor/added', gitlink(await nestedRepository(path.join(workspace, 'vendor', 'added'), format, 'added reference\n')))
}

describe('captured candidate application at the recorded baseline', () => {
  it.each(['sha1', 'sha256'] as const)(
    'reproduces every supported entry effect exactly in a %s repository after the original HEAD advanced',
    async (format) => {
      const mod = await worktreeModule()
      const fx = await fixture({ format, baseline: richBaseline(format), edit: (workspace, expected) => richEdit(workspace, expected, format) })
      expect(fx.candidate.baselineCommit).toBe(fx.baseline)
      expect(fx.candidate.baselineCommit).toHaveLength(format === 'sha1' ? 40 : 64)
      expect(fx.candidate.coverage).toEqual({ scope: 'main_repository', note: SUBMODULE_COVERAGE_NOTE })
      const before = await inventoryRepository(fx.repo.root)

      await withPrivateTmp(async (tmpRoot) => {
        const session = await openSession(mod, fx)
        expect(session.baselineCommit).toBe(fx.baseline)
        expect(session.originalHead).toBe(fx.head)
        expect(session.objectFormat).toBe(format)
        expect(scratchGit(session.path, ['rev-parse', 'HEAD']).toString('utf8').trim()).toBe(fx.baseline)

        const outcome = await session.applyCandidate(input(fx.candidate))
        expect(outcome).toEqual({ applied: true, tree: fx.expected.tree, files: fx.candidate.files.length })
        await expectWorktreeMatches(session, fx)
        // Gitlinks stay references: no nested checkout, Git directory, or fetched object appears.
        for (const gitlinkPath of ['vendor/lib', 'vendor/added']) expect(existsSync(path.join(session.path, gitlinkPath, '.git'))).toBe(false)

        const disposal = await session.dispose()
        expect(disposal).toEqual({ unchanged: true, mismatches: [], worktreeRemoved: true, privateStateRemoved: true })
        expect(await session.dispose()).toEqual(disposal)
        expect(existsSync(session.path)).toBe(false)
        expect(await listTree(tmpRoot)).toEqual([])
      })
      // No candidate blob, tree, or other object reached the original store; nothing else moved.
      expect(await inventoryRepository(fx.repo.root)).toEqual(before)
    },
    120_000,
  )

  it('applies once, through the full binary precheck, without unsafe, partial, merge, or repair modes', async () => {
    const mod = await worktreeModule()
    const fx = await fixture({ format: 'sha1', baseline: richBaseline('sha1'), edit: (workspace, expected) => richEdit(workspace, expected, 'sha1') })
    const shim = await createTempDirectory('flowproof-captured-git-shim-')
    cleanups.push(shim.remove)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const log = path.join(shim.path, 'git-args.log')
    await mkdir(path.join(shim.path, 'bin'))
    await writeFile(path.join(shim.path, 'bin', 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${path.join(shim.path, 'bin')}:${savedPath ?? ''}`
    try {
      await withPrivateTmp(async () => {
        const session = await openSession(mod, fx)
        expect((await session.applyCandidate(input(fx.candidate))).applied).toBe(true)
        let repeated: unknown
        try {
          await session.applyCandidate(input(fx.candidate))
        } catch (error) {
          repeated = error
        }
        expect(repeated).toBeInstanceOf(mod.WorktreeError)
        expect((repeated as { code: string }).code).toBe('WORKTREE_APPLY_REPEATED')
        await session.dispose()
      })
    } finally {
      process.env.PATH = savedPath
    }
    const invocations = (await readFile(log, 'utf8')).split('\n').filter(Boolean)
    const applies = invocations.filter((line) => / apply( |$)/.test(line))
    expect(applies).toHaveLength(2)
    expect(applies.filter((line) => line.includes('--check'))).toHaveLength(1)
    for (const line of applies) {
      expect(line).toContain('--index')
      expect(line).toContain('--binary')
      expect(line).toContain('core.hooksPath=/dev/null')
      for (const forbidden of ['--unsafe-paths', '--reject', '--3way', ' -3', '--whitespace=fix', '--recount', '--inaccurate-eof', '--unidiff-zero', '--allow-overlap', '--include', '--exclude']) {
        expect(line).not.toContain(forbidden)
      }
    }
    // The real application follows its precheck; no Git command ran without the hook guard.
    expect(applies[0]).toContain('--check')
    expect(invocations.every((line) => line.includes('core.hooksPath=/dev/null'))).toBe(true)
  }, 120_000)

  it('runs no repository hook or configured filter while applying', async () => {
    const mod = await worktreeModule()
    const marker = await createTempDirectory('flowproof-captured-markers-')
    cleanups.push(marker.remove)
    const filterLog = path.join(marker.path, FILTER_MARKER)
    const hookLog = path.join(marker.path, HOOK_MARKER)
    const fx = await fixture({
      format: 'sha1',
      baseline: new Map([
        ['.gitattributes', file('*.txt filter=fpfilter\n')],
        ['src/app.txt', file('one\n')],
      ]),
      edit: async (workspace, expected) => {
        await writeFile(path.join(workspace, 'src', 'app.txt'), 'two\n')
        expected.set('src/app.txt', file('two\n'))
        await writeFile(path.join(workspace, 'src', 'new.txt'), 'new\n')
        expected.set('src/new.txt', file('new\n'))
      },
    })
    // Identity filters with a side effect, and hooks that would record any run.
    const filterCommand = `sh -c 'echo run >> ${filterLog}; cat'`
    scratchGit(fx.repo.root, ['config', 'filter.fpfilter.clean', filterCommand])
    scratchGit(fx.repo.root, ['config', 'filter.fpfilter.smudge', filterCommand])
    const hooks = path.join(fx.repo.root, '.git', 'hooks')
    await mkdir(hooks, { recursive: true })
    for (const hook of ['post-checkout', 'post-index-change', 'pre-applypatch', 'post-applypatch', 'reference-transaction', 'pre-commit']) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${hookLog}\n`, { mode: 0o755 })
    }
    const before = await inventoryRepository(fx.repo.root)
    await withPrivateTmp(async () => {
      const session = await openSession(mod, fx)
      // Preparing the worktree checks out the baseline with the original's own configuration.
      const prepared = existsSync(filterLog) ? (await readFile(filterLog, 'utf8')).split('\n').filter(Boolean).length : 0
      expect((await session.applyCandidate(input(fx.candidate))).applied).toBe(true)
      const after = existsSync(filterLog) ? (await readFile(filterLog, 'utf8')).split('\n').filter(Boolean).length : 0
      expect(after).toBe(prepared)
      await expectWorktreeMatches(session, fx)
      await session.dispose()
    })
    expect(existsSync(hookLog)).toBe(false)
    expect(await inventoryRepository(fx.repo.root)).toEqual(before)
  }, 120_000)

  describe('inputs that cannot yield a tested target', () => {
    const simple = (): Promise<Fixture> =>
      fixture({
        format: 'sha1',
        baseline: new Map([
          ['src/app.txt', file('one\ntwo\nthree\n')],
          ['assets/logo.bin', file(BINARY_V1)],
          ['scripts/run.sh', file('#!/bin/sh\necho run\n')],
        ]),
        edit: async (workspace, expected) => {
          await writeFile(path.join(workspace, 'src', 'app.txt'), 'one\n2\nthree\n')
          expected.set('src/app.txt', file('one\n2\nthree\n'))
          await writeFile(path.join(workspace, 'assets', 'logo.bin'), BINARY_V2)
          expected.set('assets/logo.bin', file(BINARY_V2))
          await chmod(path.join(workspace, 'scripts', 'run.sh'), 0o755)
          expected.set('scripts/run.sh', file('#!/bin/sh\necho run\n', '100755'))
        },
        advance: { 'src/app.txt': 'one\nTWO\nthree\n' },
      })

    async function expectUnusable(mod: WorktreeModule, fx: Fixture, candidate: CandidateInput, reasons: readonly string[], baselineCommit?: string): Promise<void> {
      const before = await inventoryRepository(fx.repo.root)
      await withPrivateTmp(async (tmpRoot) => {
        const session = await openSession(mod, fx, baselineCommit)
        const outcome = await session.applyCandidate(candidate)
        expect(outcome.applied).toBe(false)
        if (!outcome.applied) expect(reasons).toContain(outcome.reason)
        // A failed application is never built or presented as a tested target.
        let refused: unknown
        try {
          await session.build()
        } catch (error) {
          refused = error
        }
        expect(refused).toBeInstanceOf(mod.WorktreeError)
        expect((refused as { code: string }).code).toBe('WORKTREE_APPLY_FAILED')
        expect(await session.dispose()).toEqual({ unchanged: true, mismatches: [], worktreeRemoved: true, privateStateRemoved: true })
        expect(await listTree(tmpRoot)).toEqual([])
      })
      expect(await inventoryRepository(fx.repo.root)).toEqual(before)
    }

    it('fails tampered patch bytes', async () => {
      const mod = await worktreeModule()
      const fx = await simple()
      const patch = Buffer.from(fx.candidate.patch)
      const text = patch.toString('latin1')
      // Only the text hunk has a line `+2`; base85 binary lines always start with a length letter.
      const altered = Buffer.from(text.replace('\n+2\n', '\n+3\n'), 'latin1')
      expect(altered.equals(patch)).toBe(false)
      await expectUnusable(mod, fx, { ...input(fx.candidate), patch: altered }, ['APPLICATION_FIDELITY_MISMATCH'])
      // A cut inside the last text hunk (`src/app.txt` sorts last) leaves a corrupt patch that
      // Git's full precheck rejects before anything is written.
      const lastLine = Buffer.from(' three\n')
      expect(patch.subarray(-lastLine.length).equals(lastLine)).toBe(true)
      const corrupt = patch.subarray(0, patch.length - lastLine.length)
      await expectUnusable(mod, fx, { ...input(fx.candidate), patch: corrupt }, ['APPLICATION_REJECTED'])
      // A cut between file sections is a valid shorter patch Git may accept; its effects differ
      // from the recorded summary, so it still never yields a built or usable target.
      const truncated = patch.subarray(0, Math.floor(patch.length / 2))
      await expectUnusable(mod, fx, { ...input(fx.candidate), patch: truncated }, ['APPLICATION_REJECTED', 'APPLICATION_FIDELITY_MISMATCH'])
    }, 120_000)

    it('fails a tampered file summary', async () => {
      const mod = await worktreeModule()
      const fx = await simple()
      const files = fx.candidate.files.map((entry) => ({
        path: entry.path,
        operation: entry.operation,
        oldMode: entry.oldMode,
        newMode: entry.newMode,
        oldObjectId: entry.oldObjectId,
        newObjectId: entry.newObjectId,
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      }))
      const modeTampered = createCandidate({
        ...fx.candidate,
        patch: fx.candidate.patch,
        files: files.map((entry) => (entry.path.toString() === 'scripts/run.sh' ? { ...entry, newMode: '100644' as const, oldMode: '100755' as const } : entry)),
      })
      await expectUnusable(mod, fx, input(modeTampered), ['APPLICATION_FIDELITY_MISMATCH'])
      const omitted = createCandidate({ ...fx.candidate, patch: fx.candidate.patch, files: files.filter((entry) => entry.path.toString() !== 'assets/logo.bin') })
      await expectUnusable(mod, fx, input(omitted), ['APPLICATION_FIDELITY_MISMATCH'])
    }, 120_000)

    it('fails a wrong but available baseline and a missing baseline object', async () => {
      const mod = await worktreeModule()
      const fx = await simple()
      // The candidate names the advanced original HEAD, whose bytes differ from its real preimage.
      const wrong = createCandidate({ ...fx.candidate, patch: fx.candidate.patch, baselineCommit: fx.head })
      await expectUnusable(mod, fx, input(wrong), ['APPLICATION_REJECTED', 'APPLICATION_FIDELITY_MISMATCH'], fx.head)

      const before = await inventoryRepository(fx.repo.root)
      await withPrivateTmp(async (tmpRoot) => {
        for (const missing of ['f'.repeat(40), fx.baseline.slice(0, 12), 'HEAD']) {
          let caught: unknown
          try {
            await mod.createCapturedWorktreeSession({ repoRoot: fx.repo.root, scenario: fx.scenario, baselineCommit: missing })
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(mod.WorktreeError)
          expect((caught as { code: string }).code).toBe('WORKTREE_BASELINE_UNAVAILABLE')
          expect((caught as Error).message).not.toContain(fx.repo.root)
        }
        expect(await listTree(tmpRoot)).toEqual([])
      })
      expect(await inventoryRepository(fx.repo.root)).toEqual(before)
    }, 120_000)

    it('refuses a candidate recorded for a different baseline than the session', async () => {
      const mod = await worktreeModule()
      const fx = await simple()
      await withPrivateTmp(async () => {
        const session = await openSession(mod, fx)
        let caught: unknown
        try {
          await session.applyCandidate({ ...input(fx.candidate), baselineCommit: fx.head })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(mod.WorktreeError)
        expect((caught as { code: string }).code).toBe('WORKTREE_OPTIONS_INVALID')
        await session.dispose()
      })
    }, 120_000)
  })

  it('keeps the legacy one-file session contract unchanged beside the captured sibling', async () => {
    const mod = (await loadPendingModule<WorktreeModule & { createWorktreeSession: (options: { repoRoot: string; scenario: LoadedScenario }) => Promise<{ applyDiff(diff: string): Promise<void>; dispose(): Promise<unknown>; readonly originalHead: string; readonly path: string }> }>(
      'packages/flowproof/src/worktree/session.ts',
      'T013',
      ['createWorktreeSession', 'createCapturedWorktreeSession', 'WorktreeError'],
    ))
    const fx = await fixture({
      format: 'sha1',
      baseline: new Map([['assets/logo.bin', file(BINARY_V1)]]),
      edit: async (workspace, expected) => {
        await writeFile(path.join(workspace, 'assets', 'logo.bin'), BINARY_V2)
        expected.set('assets/logo.bin', file(BINARY_V2))
      },
    })
    await withPrivateTmp(async (tmpRoot) => {
      const legacy = await mod.createWorktreeSession({ repoRoot: fx.repo.root, scenario: fx.scenario })
      cleanups.push(async () => {
        await legacy.dispose().catch(() => undefined)
      })
      // The legacy entry point stays at the original HEAD and still refuses a binary multi-file patch.
      expect(legacy.originalHead).toBe(fx.head)
      let caught: unknown
      try {
        await legacy.applyDiff(fx.candidate.patch.toString('latin1'))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(mod.WorktreeError)
      expect(['WORKTREE_DIFF_OUT_OF_SCOPE', 'WORKTREE_APPLY_FAILED', 'WORKTREE_DIFF_INVALID']).toContain((caught as { code: string }).code)
      await legacy.dispose()
      expect(await listTree(tmpRoot)).toEqual([])
    })
  }, 120_000)
})
