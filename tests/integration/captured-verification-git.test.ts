import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { CapturedPhase } from '../../packages/flowproof/src/capture/browserCapture.js'
import { SUBMODULE_COVERAGE_NOTE, createCandidate } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureCandidate, CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import type { EvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { RunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import {
  advanceHead,
  blobId,
  createStateRepository,
  file,
  gitlink,
  inventoryRepository,
  link,
  persistPhase,
  produceCapturingResult,
  rawKey,
  scratchGit,
  stageExpectedTree,
} from '../support/capturedCandidate.js'
import type { ExpectedTree, ObjectFormat, StateRepository, VersionedState } from '../support/capturedCandidate.js'
import { produceCanvasCandidate } from '../support/capturedCanvasCandidate.js'
import type { CanvasCandidate, CanvasCase } from '../support/capturedCanvasCandidate.js'
import { DOCKER_TEST_TIMEOUT, createPrivateTmpRoot, listTree, removeFixtureImage } from '../support/editingRuntime.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { REPO_ROOT, createTempClone, createTempDirectory, git } from '../support/repoFixture.js'
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
  readonly operationsJoined: boolean
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
        expect(disposal).toEqual({ unchanged: true, mismatches: [], worktreeRemoved: true, privateStateRemoved: true, operationsJoined: true })
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
        expect(await session.dispose()).toEqual({ unchanged: true, mismatches: [], worktreeRemoved: true, privateStateRemoved: true, operationsJoined: true })
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


// ---------------------------------------------------------------------------------------
// T011 (US1): the prepared Canvas checks on real captured candidates. Each case runs one
// deterministic editing-agent edit through the real Docker capturing session against a temporary
// clone of this repository, then verifies it with the prepared non-browser ports: the pinned
// worktree application, the registered build, and the trusted functional checker read from the
// original checkout before application. Browser reproduction and replay are same-run evidence
// doubles here; US2 wires them to the real Studio frame.
// ---------------------------------------------------------------------------------------

interface AdmittedCandidate {
  readonly editingSessionId: string
  readonly baselineCommit: string
  readonly patchSha256: string
  readonly patch: Buffer
  readonly files: CaptureCandidate['files']
}

type Admission = { readonly admitted: true; readonly candidate: AdmittedCandidate } | { readonly admitted: false; readonly error: { readonly code: string; readonly message: string } }

interface StageContext {
  readonly runId: string
  readonly scenario: LoadedScenario
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  readonly candidate: AdmittedCandidate
  readonly signal: AbortSignal
}

interface FunctionalCheckFact {
  readonly exitCode: number | null
  readonly summary: { readonly discovered: number; readonly executed: number; readonly passed: number; readonly failed: number } | null
  readonly expectedCases: number
}

interface PreparedCandidatePorts {
  applyCandidate(context: StageContext): Promise<unknown>
  build(context: StageContext): Promise<unknown>
  functionalCheck(context: StageContext): Promise<FunctionalCheckFact>
  disposeWorktree(): Promise<unknown>
  worktreePath(): string | null
  documentRoot(): string | null
}

interface PreparedFunctionalCheck {
  readonly expectedCases: number
  run(targetRoot: string, signal?: AbortSignal): Promise<FunctionalCheckFact>
}

interface ResultCheck {
  readonly check_id: string
  readonly status: string
  readonly reason_code: string
  readonly metrics: Readonly<Record<string, unknown>>
}

interface CapturedResult {
  readonly status: string
  readonly reason_code: string | null
  readonly checks: readonly ResultCheck[]
  readonly cleanup: Record<string, unknown>
}

interface CapturedRunModule {
  admitCapturedCandidate(value: unknown, options: { readonly objectFormat: ObjectFormat }): Admission
  prepareFunctionalCheck(options: { readonly repoRoot: string; readonly scenario: LoadedScenario }): Promise<PreparedFunctionalCheck>
  createPreparedCandidatePorts(options: { readonly repoRoot: string; readonly scenario: LoadedScenario; readonly candidate: AdmittedCandidate }): Promise<PreparedCandidatePorts>
  executeCapturedRun(options: {
    readonly runId: string
    readonly requestId: string
    readonly scenario: LoadedScenario
    readonly candidate: AdmittedCandidate
    readonly store: RunArtifactStore
    readonly events: RunEventStream
    readonly allocator: EvidenceIdAllocator
    readonly ports: Record<string, unknown>
    readonly secretMarkers: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<CapturedResult>
}

const capturedRunModule = (): Promise<CapturedRunModule> =>
  loadPendingModule<CapturedRunModule>('packages/flowproof/src/verify/capturedRun.ts', 'T014-T016', [
    'admitCapturedCandidate',
    'prepareFunctionalCheck',
    'createPreparedCandidatePorts',
    'executeCapturedRun',
  ])

const MARKERS = ['FPCAPTUREDCANVASRUNMARKER0001'] as const
const CHECKER = 'tests/fixtures/captured-verification/check-filter.mjs'

afterAll(async () => {
  await removeFixtureImage()
})

interface CanvasClone {
  readonly root: string
  readonly scenario: LoadedScenario
  readonly tmp: TempDirectory
}

async function canvasClone(): Promise<CanvasClone> {
  const clone = await createTempClone({ withDependencies: true })
  const tmp = await createPrivateTmpRoot()
  cleanups.push(clone.remove, tmp.remove)
  git(clone.path, 'checkout', '--quiet', '-B', 'flowproof-captured-main')
  return { root: clone.path, scenario: await loadScenario('canvas-filter-hero', { repoRoot: clone.path }), tmp }
}

const checkOf = (result: CapturedResult, id: string): ResultCheck | undefined => result.checks.find((check) => check.check_id === id)

interface RunObservation {
  readonly result: CapturedResult
  /** Assertions run inside the build stage, while the owned worktree still exists. */
  readonly inspected: boolean
}

/** Verifies one admitted capture with the prepared ports and same-run browser evidence doubles. */
async function verifyCapture(
  mod: CapturedRunModule,
  clone: CanvasClone,
  capture: CapturingEditingSessionResult,
  inspect: (worktree: string, documentRoot: string | null) => Promise<void> = async () => undefined,
): Promise<RunObservation> {
  const admission = mod.admitCapturedCandidate(capture, { objectFormat: 'sha1' })
  expect(admission.admitted, JSON.stringify(admission)).toBe(true)
  if (!admission.admitted) throw new Error('not admitted')
  const prepared = await mod.createPreparedCandidatePorts({ repoRoot: clone.root, scenario: clone.scenario, candidate: admission.candidate })
  const runId = randomUUID()
  const store = await createRunArtifactStore({ repoRoot: clone.root, runId })
  const events = createRunEventStream({ runId, registry: store })
  const allocator = createEvidenceIdAllocator(runId)
  const scenarioId = clone.scenario.scenario.scenario_id
  const expectedRows = clone.scenario.oracle.dataset
  const expectedChart = clone.scenario.oracle.chart
  const knownBad = { dataset: [...expectedRows, ...expectedRows.map((row) => ({ ...row, region: 'Northeast' }))], chart: { bar_count: 8, labels: [...expectedChart.labels, ...expectedChart.labels], values: [...expectedChart.values, ...expectedChart.values] } }
  let inspected = false
  const result = await mod.executeCapturedRun({
    runId,
    requestId: randomUUID(),
    scenario: clone.scenario,
    candidate: admission.candidate,
    store,
    events,
    allocator,
    secretMarkers: MARKERS,
    ports: {
      reproduceBaseline: (context: StageContext): Promise<CapturedPhase> => persistPhase(context, scenarioId, 'failure', knownBad),
      applyCandidate: (context: StageContext) => prepared.applyCandidate(context),
      build: async (context: StageContext) => {
        try {
          return await prepared.build(context)
        } finally {
          const worktree = prepared.worktreePath()
          if (worktree !== null) {
            await inspect(worktree, prepared.documentRoot())
            inspected = true
          }
        }
      },
      functionalCheck: (context: StageContext) => prepared.functionalCheck(context),
      replay: (context: StageContext): Promise<CapturedPhase> => persistPhase(context, scenarioId, 'replay', { dataset: structuredClone(expectedRows), chart: structuredClone(expectedChart) }),
      disposeCapture: async () => ({ remaining: [] }),
      disposeWorktree: () => prepared.disposeWorktree(),
    },
  })
  expect(prepared.worktreePath() === null || !existsSync(prepared.worktreePath() as string)).toBe(true)
  return { result, inspected }
}

async function expectEffects(worktree: string, canvas: CanvasCandidate): Promise<void> {
  for (const effect of canvas.expected) {
    const target = path.join(worktree, effect.path)
    if (effect.entry === null) {
      expect(existsSync(target), effect.path).toBe(false)
      continue
    }
    expect((await readFile(target)).equals(effect.entry.data), effect.path).toBe(true)
    expect(((await lstat(target)).mode & 0o111) !== 0, effect.path).toBe(effect.entry.mode === '100755')
  }
}

async function capturedCanvas(clone: CanvasClone, caseName: CanvasCase): Promise<CanvasCandidate> {
  const canvas = await produceCanvasCandidate({ caseName, repositoryRoot: clone.root, tmpRoot: clone.tmp.path })
  expect(canvas.result.capture.status, JSON.stringify(canvas.result.capture)).toBe('captured')
  return canvas
}

describe('prepared Canvas checks on captured candidates', () => {
  it(
    'verifies the multi-file canvas-fix from its saved changes alone with the registered build and trusted checker',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const canvas = await capturedCanvas(clone, 'canvas-fix')
      const { result, inspected } = await verifyCapture(mod, clone, canvas.result, async (worktree, documentRoot) => {
        await expectEffects(worktree, canvas)
        // Servable output from the registered build of the applied candidate.
        expect(documentRoot).not.toBeNull()
        expect((await lstat(path.join(documentRoot as string, 'index.html'))).isFile()).toBe(true)
      })
      expect(inspected).toBe(true)
      expect(checkOf(result, 'application_complete')).toMatchObject({ status: 'pass', reason_code: 'APPLICATION_COMPLETE' })
      expect(checkOf(result, 'build_passed')).toMatchObject({ status: 'pass', reason_code: 'BUILD_PASSED' })
      expect(checkOf(result, 'tests_passed')).toMatchObject({ status: 'pass', reason_code: 'TESTS_PASSED', metrics: { discovered: 6, executed: 6, passed: 6 } })
      expect(result).toMatchObject({ status: 'passed', reason_code: null })
      expect(result.cleanup).toMatchObject({ complete: true, original_unchanged: true })
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'runs the trusted checker read from the original checkout before application, which fails the unchanged baseline module',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const check = await mod.prepareFunctionalCheck({ repoRoot: clone.root, scenario: clone.scenario })
      expect(check.expectedCases).toBe(6)
      // The original checkout holds the unchanged baseline module.
      const baseline = await check.run(clone.root)
      expect(baseline.exitCode).toBe(1)
      expect(baseline.summary).toEqual({ discovered: 6, executed: 6, passed: 3, failed: 3 })
      // Replacing the trusted checker after preparation is refused instead of being run.
      const checker = path.join(clone.root, CHECKER)
      const original = await readFile(checker)
      await writeFile(checker, 'process.stdout.write(\'{"check":"prepared-region-filter","discovered":6,"executed":6,"passed":6,"failed":0}\\n\')\n')
      try {
        await expect(check.run(clone.root)).rejects.toThrow()
      } finally {
        await writeFile(checker, original)
      }
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'fails canvas-hidden-dependency without importing the omitted helper from the disposed editing workspace',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const canvas = await capturedCanvas(clone, 'canvas-hidden-dependency')
      const { result, inspected } = await verifyCapture(mod, clone, canvas.result, async (worktree) => {
        await expectEffects(worktree, canvas)
        expect(existsSync(path.join(worktree, 'apps/demo-chart/src/dist/regionMatch.ts'))).toBe(false)
      })
      expect(inspected).toBe(true)
      expect(checkOf(result, 'application_complete')?.status).toBe('pass')
      const build = checkOf(result, 'build_passed')
      const tests = checkOf(result, 'tests_passed')
      expect(build?.status === 'fail' || tests?.status === 'fail').toBe(true)
      expect(result.status).toBe('failed')
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'fails build_passed for canvas-build-fail',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const canvas = await capturedCanvas(clone, 'canvas-build-fail')
      const { result } = await verifyCapture(mod, clone, canvas.result)
      expect(checkOf(result, 'build_passed')).toMatchObject({ status: 'fail', reason_code: 'BUILD_FAILED' })
      expect(checkOf(result, 'tests_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'CHECK_NOT_EVALUATED' })
      expect(result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED' })
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'still fails tests_passed for canvas-self-certify because its checker copies and package script are ignored',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const canvas = await capturedCanvas(clone, 'canvas-self-certify')
      const { result } = await verifyCapture(mod, clone, canvas.result, async (worktree) => expectEffects(worktree, canvas))
      expect(checkOf(result, 'build_passed')?.status).toBe('pass')
      expect(checkOf(result, 'tests_passed')).toMatchObject({ status: 'fail', reason_code: 'TESTS_FAILED', metrics: { discovered: 6, executed: 6, passed: 3 } })
      expect(result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED' })
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'applies dependency manifest and lockfile changes without installing anything and fails explicitly on the missing dependency',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const head = git(clone.root, 'rev-parse', 'HEAD').trim()
      const absent = '@flowproof-synthetic/absent-dependency'
      const capture = await produceCapturingResult({
        repositoryRoot: clone.root,
        baselineCommit: head,
        tmpRoot: clone.tmp.path,
        edit: async (workspace) => {
          const manifestPath = path.join(workspace, 'apps/demo-chart/package.json')
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
          manifest.dependencies[absent] = '1.0.0'
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
          await writeFile(path.join(workspace, 'pnpm-lock.yaml'), `${await readFile(path.join(workspace, 'pnpm-lock.yaml'), 'utf8')}# synthetic lockfile change\n`)
          const filter = path.join(workspace, 'apps/demo-chart/src/filterData.ts')
          await writeFile(filter, `import '${absent}'\n${await readFile(filter, 'utf8')}`)
        },
      })
      const installedBefore = await listTree(path.join(REPO_ROOT, 'node_modules', '@flowproof-synthetic'))
      const { result, inspected } = await verifyCapture(mod, clone, capture, async (worktree) => {
        expect((await readFile(path.join(worktree, 'pnpm-lock.yaml'), 'utf8')).endsWith('# synthetic lockfile change\n')).toBe(true)
        for (const modules of ['node_modules', 'apps/demo-chart/node_modules']) {
          expect(existsSync(path.join(worktree, modules, '@flowproof-synthetic'))).toBe(false)
        }
      })
      expect(inspected).toBe(true)
      expect(checkOf(result, 'application_complete')?.status).toBe('pass')
      expect(checkOf(result, 'build_passed')).toMatchObject({ status: 'fail', reason_code: 'BUILD_FAILED' })
      expect(result.status).toBe('failed')
      expect(await listTree(path.join(REPO_ROOT, 'node_modules', '@flowproof-synthetic'))).toEqual(installedBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )
})

// The prepared baseline entry point used by the captured Studio (T022). The Studio reproduces the
// prepared defect on the recorded baseline before anything is applied, so the prepared ports
// create and build the one owned pinned worktree first and then reuse that same session for the
// exact application, the candidate build and the trusted check. The original HEAD advances past
// the baseline with an observable build input, so a baseline guessed from HEAD would show it.

interface PreparedBaseline {
  readonly documentRoot: string
  readonly sourceRoot: string
}

interface BaselinePreparedPorts extends PreparedCandidatePorts {
  prepareBaseline?(context: StageContext): Promise<PreparedBaseline>
}

const HEAD_ONLY_INPUT = 'apps/demo-chart/public/flowproof-head-only-input.txt'
const FILTER_MODULE = 'apps/demo-chart/src/filterData.ts'

const ownedRegistrations = (root: string): number =>
  git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length

/** A Docker-free exact-match fix of the prepared filter, captured at the clone's HEAD. */
async function captureExactFilterFix(clone: CanvasClone): Promise<{ readonly capture: CapturingEditingSessionResult; readonly baseline: string; readonly fixed: Buffer }> {
  const baseline = git(clone.root, 'rev-parse', 'HEAD').trim()
  let fixed = Buffer.alloc(0)
  const capture = await produceCapturingResult({
    repositoryRoot: clone.root,
    baselineCommit: baseline,
    tmpRoot: clone.tmp.path,
    edit: async (workspace) => {
      const target = path.join(workspace, FILTER_MODULE)
      const source = await readFile(target, 'utf8')
      expect(source).toContain('row.region.includes(region)')
      fixed = Buffer.from(source.replace('row.region.includes(region)', 'row.region === region'))
      await writeFile(target, fixed)
    },
  })
  expect(capture.capture.status).toBe('captured')
  return { capture, baseline, fixed }
}

/** Commits an observable build input so the original HEAD is no longer the candidate baseline. */
async function advanceOriginalHead(clone: CanvasClone): Promise<string> {
  await mkdir(path.join(clone.root, path.dirname(HEAD_ONLY_INPUT)), { recursive: true })
  await writeFile(path.join(clone.root, HEAD_ONLY_INPUT), 'present only after the captured baseline\n')
  git(clone.root, 'add', HEAD_ONLY_INPUT)
  git(clone.root, '-c', 'user.email=flowproof@example.invalid', '-c', 'user.name=FlowProof', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'Advance HEAD past the captured baseline')
  return git(clone.root, 'rev-parse', 'HEAD').trim()
}

async function stageContextFor(clone: CanvasClone, candidate: AdmittedCandidate): Promise<StageContext> {
  const runId = randomUUID()
  return {
    runId,
    scenario: clone.scenario,
    store: await createRunArtifactStore({ repoRoot: clone.root, runId }),
    allocator: createEvidenceIdAllocator(runId),
    candidate,
    signal: new AbortController().signal,
  }
}

function prepareBaselineOf(prepared: BaselinePreparedPorts): (context: StageContext) => Promise<PreparedBaseline> {
  // Named failure while the prepared baseline entry point does not exist yet.
  expect(typeof prepared.prepareBaseline, 'createPreparedCandidatePorts().prepareBaseline is not implemented').toBe('function')
  return (context) => (prepared.prepareBaseline as (context: StageContext) => Promise<PreparedBaseline>).call(prepared, context)
}

describe('prepared recorded baseline for the captured Studio', () => {
  it(
    'builds the recorded baseline, not the advanced original HEAD, and reuses that one owned session for application, build and check',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture, baseline, fixed } = await captureExactFilterFix(clone)
      const head = await advanceOriginalHead(clone)
      expect(head).not.toBe(baseline)
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const registrations = ownedRegistrations(clone.root)

      const admission = mod.admitCapturedCandidate(capture, { objectFormat: 'sha1' })
      if (!admission.admitted) throw new Error(`not admitted: ${admission.error.code}`)
      const prepared: BaselinePreparedPorts = await mod.createPreparedCandidatePorts({ repoRoot: clone.root, scenario: clone.scenario, candidate: admission.candidate })
      const prepareBaseline = prepareBaselineOf(prepared)
      const context = await stageContextFor(clone, admission.candidate)
      try {
        const prep = await prepareBaseline(context)
        const owned = prepared.worktreePath()
        expect(owned).not.toBeNull()
        if (owned === null) return
        // The trusted source root is the owned pinned worktree at the recorded baseline.
        expect(prep.sourceRoot).toBe(owned)
        expect(git(owned, 'rev-parse', 'HEAD').trim()).toBe(baseline)
        expect(existsSync(path.join(owned, HEAD_ONLY_INPUT))).toBe(false)
        expect(await readFile(path.join(owned, FILTER_MODULE), 'utf8')).toBe(git(clone.root, 'show', `${baseline}:${FILTER_MODULE}`))
        // Servable output of the unchanged baseline inside that worktree; no HEAD-only input.
        expect(prep.documentRoot.startsWith(`${owned}${path.sep}`)).toBe(true)
        expect((await lstat(path.join(prep.documentRoot, 'index.html'))).isFile()).toBe(true)
        expect(existsSync(path.join(prep.documentRoot, path.basename(HEAD_ONLY_INPUT)))).toBe(false)
        expect(prepared.documentRoot()).toBeNull()
        expect(ownedRegistrations(clone.root)).toBe(registrations + 1)
        // One baseline per session.
        await expect(prepareBaseline(context)).rejects.toThrow()

        // Exact application, the candidate build and the trusted check reuse the same session.
        expect(await prepared.applyCandidate(context)).toEqual({ applied: true })
        expect(prepared.worktreePath()).toBe(owned)
        expect((await readFile(path.join(owned, FILTER_MODULE))).equals(fixed)).toBe(true)
        await expect(prepared.applyCandidate(context)).rejects.toThrow()
        await expect(prepareBaseline(context)).rejects.toThrow()
        expect(await prepared.build(context)).toEqual({ built: true })
        expect(prepared.documentRoot()).toBe(prep.documentRoot)
        expect(prepared.worktreePath()).toBe(owned)
        const checked = await prepared.functionalCheck(context)
        expect(checked).toMatchObject({ exitCode: 0, summary: { discovered: 6, executed: 6, passed: 6, failed: 0 }, expectedCases: 6 })
        expect(ownedRegistrations(clone.root)).toBe(registrations + 1)
        expect(git(clone.root, 'rev-parse', 'HEAD').trim()).toBe(head)
      } finally {
        const released = await prepared.disposeWorktree()
        expect(released).toEqual({ remaining: [], original: { verified: true, unchanged: true, mismatches: [] } })
      }
      expect(prepared.worktreePath() === null || !existsSync(prepared.worktreePath() as string)).toBe(true)
      expect(git(clone.root, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'refuses a baseline after application started and never creates a second owned session',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const registrations = ownedRegistrations(clone.root)
      const admission = mod.admitCapturedCandidate(capture, { objectFormat: 'sha1' })
      if (!admission.admitted) throw new Error(`not admitted: ${admission.error.code}`)
      const prepared: BaselinePreparedPorts = await mod.createPreparedCandidatePorts({ repoRoot: clone.root, scenario: clone.scenario, candidate: admission.candidate })
      const prepareBaseline = prepareBaselineOf(prepared)
      const context = await stageContextFor(clone, admission.candidate)
      try {
        expect(await prepared.applyCandidate(context)).toEqual({ applied: true })
        const owned = prepared.worktreePath()
        await expect(prepareBaseline(context)).rejects.toThrow()
        expect(prepared.worktreePath()).toBe(owned)
        expect(ownedRegistrations(clone.root)).toBe(registrations + 1)
      } finally {
        expect(await prepared.disposeWorktree()).toEqual({ remaining: [], original: { verified: true, unchanged: true, mismatches: [] } })
      }
      // A disposed session prepares nothing.
      await expect(prepareBaseline(context)).rejects.toThrow()
      expect(ownedRegistrations(clone.root)).toBe(registrations)
    },
    DOCKER_TEST_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------
// T029 (US3): real owned-resource release. Candidate builds and the trusted check run in their own
// process groups; a synthetic candidate leaves a descendant in that group that keeps re-creating
// residue inside the owned worktree. Aborting during the build or the functional check, and a build
// that exits while its descendant still runs, kill the whole group and join it (no live, non-zombie
// member) before the worktree is removed. No process, temporary entry, worktree registration, or
// private Git directory remains on any terminal path. An injected removal failure and an original
// tracked-file change are reported with safe categories and never pass.
// ---------------------------------------------------------------------------------------

const DESCENDANT_PID = 'fp-descendant.pid'
const RESIDUE = 'fp-residue'
const SYNTHETIC_BUILD = 'apps/demo-chart/fp-build.mjs'
/** Stays in its parent's process group and keeps re-creating residue below the given root. */
const DESCENDANT_SOURCE = `const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[1]; setInterval(() => { try { fs.mkdirSync(path.join(root, '${RESIDUE}'), { recursive: true }); fs.writeFileSync(path.join(root, '${RESIDUE}', 'alive'), '1') } catch {} }, 20)`
/**
 * A candidate-controlled build: `hang` starts the descendant and never exits; `leave` starts it,
 * writes servable output, and exits while it still runs; `static` only writes servable output.
 */
const SYNTHETIC_BUILD_SOURCE = `import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const mode = process.argv[2]
const root = path.resolve('..', '..')
if (mode !== 'static') {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(DESCENDANT_SOURCE)}, root], { stdio: 'ignore' })
  writeFileSync(path.join(root, '${DESCENDANT_PID}'), String(child.pid))
  if (mode === 'leave') child.unref()
}
if (mode === 'hang') setInterval(() => {}, 1000)
else {
  mkdirSync('dist', { recursive: true })
  writeFileSync('dist/index.html', '<!doctype html><title>synthetic build</title>\\n')
}
`
/** A candidate filter module that, once imported by the trusted checker, starts the descendant and never finishes loading. */
const HANGING_MODULE_SOURCE = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const root = process.cwd()
const child = spawn(process.execPath, ['-e', ${JSON.stringify(DESCENDANT_SOURCE)}, root], { stdio: 'ignore' })
writeFileSync(path.join(root, '${DESCENDANT_PID}'), String(child.pid))
await new Promise(() => setInterval(() => {}, 1000))
export const filterByRegion = (): never[] => []
`

type BuildMode = 'hang' | 'leave' | 'static'

/** A Docker-free capture at the clone's HEAD with the exact filter fix and optional synthetic build and module. */
async function captureOwnershipCandidate(clone: CanvasClone, options: { readonly build: BuildMode | null; readonly hangingModule?: boolean }): Promise<CapturingEditingSessionResult> {
  const capture = await produceCapturingResult({
    repositoryRoot: clone.root,
    baselineCommit: git(clone.root, 'rev-parse', 'HEAD').trim(),
    tmpRoot: clone.tmp.path,
    edit: async (workspace) => {
      const filter = path.join(workspace, FILTER_MODULE)
      await writeFile(filter, options.hangingModule === true ? HANGING_MODULE_SOURCE : (await readFile(filter, 'utf8')).replace('row.region.includes(region)', 'row.region === region'))
      if (options.build === null) return
      await writeFile(path.join(workspace, SYNTHETIC_BUILD), SYNTHETIC_BUILD_SOURCE)
      const manifestPath = path.join(workspace, 'apps/demo-chart/package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { scripts: Record<string, string> }
      manifest.scripts.build = `node fp-build.mjs ${options.build}`
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    },
  })
  expect(capture.capture.status, JSON.stringify(capture.capture)).toBe('captured')
  return capture
}

/** One process from Linux `/proc`, or null once it is gone. */
function procEntry(pid: number): { readonly state: string; readonly pgrp: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1')
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: state ?? '', pgrp: Number(pgrp) }
  } catch {
    return null
  }
}

/** A zombie can no longer run or touch files; only a running member counts as remaining. */
const liveProcess = (pid: number): boolean => {
  const entry = procEntry(pid)
  return entry !== null && entry.state !== 'Z' && entry.state !== 'X'
}

/** Live (non-zombie) processes whose process group is `pgrp`, or whose working directory is inside `root`. */
async function liveOwned(options: { readonly pgrp?: number; readonly root?: string }): Promise<number[]> {
  const found: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid || !liveProcess(pid)) continue
    if (options.pgrp !== undefined && procEntry(pid)?.pgrp === options.pgrp) found.push(pid)
    if (options.root !== undefined) {
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`)
        if (cwd === options.root || cwd.startsWith(`${options.root}${path.sep}`)) found.push(pid)
      } catch {
        // Another user's process, or it exited meanwhile.
      }
    }
  }
  return [...new Set(found)]
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const readDescendant = async (worktree: string | null): Promise<number | null> => {
  if (worktree === null) return null
  try {
    const pid = Number((await readFile(path.join(worktree, DESCENDANT_PID), 'utf8')).trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

interface OwnedObservation {
  descendant: number | null
  pgrp: number | null
  worktree: string | null
  /** Facts taken when the engine called worktree disposal, before anything was removed. */
  atDisposal: { readonly worktreeExists: boolean; readonly descendantLive: boolean; readonly groupMembers: number } | null
}

interface OwnedRun {
  readonly result: CapturedResult
  readonly observation: OwnedObservation
  readonly prepared: PreparedCandidatePorts
  readonly tmpRoot: string
}

type StageName = 'applyCandidate' | 'build' | 'functionalCheck'

/** Runs the prepared ports through the engine with an owned TMPDIR, so every temporary entry is observable. */
async function runOwned(
  mod: CapturedRunModule,
  clone: CanvasClone,
  capture: CapturingEditingSessionResult,
  hooks: {
    readonly abortDuring?: StageName
    readonly duringBuild?: (observation: OwnedObservation) => Promise<void>
    readonly beforeDisposal?: (worktree: string) => Promise<void>
    readonly signal?: AbortSignal
    /** A shorter shared application window for the engine only; the prepared ports keep theirs. */
    readonly windowMs?: number
    /** Replay fails operationally, as a capture inability would. */
    readonly failReplay?: boolean
  } = {},
): Promise<OwnedRun> {
  return withPrivateTmp(async (tmpRoot) => {
    const admission = mod.admitCapturedCandidate(capture, { objectFormat: 'sha1' })
    if (!admission.admitted) throw new Error(`not admitted: ${admission.error.code}`)
    const prepared = await mod.createPreparedCandidatePorts({ repoRoot: clone.root, scenario: clone.scenario, candidate: admission.candidate })
    const controller = new AbortController()
    const observation: OwnedObservation = { descendant: null, pgrp: null, worktree: null, atDisposal: null }
    const runId = randomUUID()
    const store = await createRunArtifactStore({ repoRoot: clone.root, runId })
    const scenarioId = clone.scenario.scenario.scenario_id
    const expectedRows = clone.scenario.oracle.dataset
    const expectedChart = clone.scenario.oracle.chart
    const knownBad = { dataset: [...expectedRows, ...expectedRows.map((row) => ({ ...row, region: 'Northeast' }))], chart: { bar_count: 8, labels: [...expectedChart.labels, ...expectedChart.labels], values: [...expectedChart.values, ...expectedChart.values] } }
    /** Starts one prepared stage, waits until its descendant runs, then aborts the run and joins the stage. */
    const stage = <T>(name: StageName, start: () => Promise<T>): Promise<T> => {
      if (hooks.abortDuring !== name) return start()
      return (async () => {
        const running = start().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        observation.descendant = await waitFor(() => readDescendant(prepared.worktreePath()), 60_000)
        observation.pgrp = observation.descendant === null ? null : (procEntry(observation.descendant)?.pgrp ?? null)
        controller.abort()
        const settled = await running
        if (!settled.ok) throw settled.error
        return settled.value
      })()
    }
    const scenario: LoadedScenario =
      hooks.windowMs === undefined ? clone.scenario : { ...clone.scenario, scenario: { ...clone.scenario.scenario, timeouts: { ...clone.scenario.scenario.timeouts, replay_ms: hooks.windowMs } } }
    const result = await mod.executeCapturedRun({
      runId,
      requestId: randomUUID(),
      scenario,
      candidate: admission.candidate,
      store,
      events: createRunEventStream({ runId, registry: store }),
      allocator: createEvidenceIdAllocator(runId),
      secretMarkers: MARKERS,
      signal: hooks.signal ?? controller.signal,
      ports: {
        reproduceBaseline: (context: StageContext): Promise<CapturedPhase> => persistPhase(context, scenarioId, 'failure', knownBad),
        applyCandidate: (context: StageContext) => stage('applyCandidate', () => prepared.applyCandidate(context)),
        build: (context: StageContext) =>
          stage('build', async () => {
            observation.worktree = prepared.worktreePath()
            const built = await prepared.build(context)
            await hooks.duringBuild?.(observation)
            return built
          }),
        functionalCheck: (context: StageContext) => stage('functionalCheck', () => prepared.functionalCheck(context)),
        replay: async (context: StageContext): Promise<CapturedPhase> => {
          if (hooks.failReplay === true) throw new Error('synthetic capture inability')
          return persistPhase(context, scenarioId, 'replay', { dataset: structuredClone(expectedRows), chart: structuredClone(expectedChart) })
        },
        disposeCapture: async () => ({ remaining: [] }),
        disposeWorktree: async () => {
          const worktree = prepared.worktreePath()
          observation.worktree ??= worktree
          observation.descendant ??= await readDescendant(worktree)
          if (observation.descendant !== null) observation.pgrp ??= procEntry(observation.descendant)?.pgrp ?? null
          observation.atDisposal = {
            worktreeExists: worktree !== null && existsSync(worktree),
            descendantLive: observation.descendant !== null && liveProcess(observation.descendant),
            groupMembers: observation.pgrp === null ? 0 : (await liveOwned({ pgrp: observation.pgrp })).length,
          }
          if (worktree !== null) await hooks.beforeDisposal?.(worktree)
          return prepared.disposeWorktree()
        },
      },
    })
    return { result, observation, prepared, tmpRoot }
  })
}

/** Nothing owned remains: process, temporary entry, worktree registration, or private Git directory. */
async function expectReleased(clone: CanvasClone, run: OwnedRun, worktreesBefore: string): Promise<void> {
  const { observation, tmpRoot } = run
  // A descendant that outlived disposal would re-create residue below the removed worktree.
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (observation.descendant !== null) expect(liveProcess(observation.descendant), 'descendant still running').toBe(false)
  if (observation.pgrp !== null) expect(await liveOwned({ pgrp: observation.pgrp })).toEqual([])
  expect(await liveOwned({ root: tmpRoot })).toEqual([])
  if (observation.worktree !== null) expect(existsSync(observation.worktree), 'owned worktree or its residue remains').toBe(false)
  expect(await listTree(tmpRoot)).toEqual([])
  expect(git(clone.root, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  expect(run.result.cleanup).toEqual({ complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] })
}

describe('captured owned-resource release on terminal paths', () => {
  it(
    'kills and joins the whole build process group when the run is aborted during the build, before removing the worktree',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const capture = await captureOwnershipCandidate(clone, { build: 'hang' })
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const run = await runOwned(mod, clone, capture, { abortDuring: 'build' })
      expect(run.observation.descendant, 'the synthetic build never started its descendant').not.toBeNull()
      expect(run.observation.pgrp).not.toBeNull()
      expect(run.result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
      expect(checkOf(run.result, 'build_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'RUN_INTERRUPTED' })
      // Joined before removal: no live group member while the worktree still existed.
      expect(run.observation.atDisposal).toEqual({ worktreeExists: true, descendantLive: false, groupMembers: 0 })
      await expectReleased(clone, run, worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'kills and joins the whole checker process group when the run is aborted during the functional check, before removing the worktree',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const capture = await captureOwnershipCandidate(clone, { build: 'static', hangingModule: true })
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const run = await runOwned(mod, clone, capture, { abortDuring: 'functionalCheck' })
      expect(run.observation.descendant, 'the candidate module never started its descendant').not.toBeNull()
      expect(run.result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
      expect(checkOf(run.result, 'build_passed')?.status).toBe('pass')
      expect(checkOf(run.result, 'tests_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'RUN_INTERRUPTED' })
      expect(run.observation.atDisposal).toEqual({ worktreeExists: true, descendantLive: false, groupMembers: 0 })
      await expectReleased(clone, run, worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'stops and joins a descendant that a successful build left running, before the check runs',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const capture = await captureOwnershipCandidate(clone, { build: 'leave' })
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      let afterBuild: { readonly descendantLive: boolean } | null = null
      const run = await runOwned(mod, clone, capture, {
        duringBuild: async (observation) => {
          observation.descendant = await readDescendant(observation.worktree)
          afterBuild = { descendantLive: observation.descendant !== null && liveProcess(observation.descendant) }
        },
      })
      expect(run.observation.descendant, 'the synthetic build never started its descendant').not.toBeNull()
      expect(afterBuild).toEqual({ descendantLive: false })
      expect(run.result.status).toBe('passed')
      await expectReleased(clone, run, worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'kills and joins a hanging build when the shared application window times out, and finalizes as timeout',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const capture = await captureOwnershipCandidate(clone, { build: 'hang' })
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const run = await runOwned(mod, clone, capture, { windowMs: 4_000 })
      expect(run.observation.descendant, 'the synthetic build never started its descendant').not.toBeNull()
      expect(run.result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
      expect(checkOf(run.result, 'build_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'RUN_TIMEOUT' })
      expect(run.observation.atDisposal).toEqual({ worktreeExists: true, descendantLive: false, groupMembers: 0 })
      await expectReleased(clone, run, worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'releases everything on an operational error after the candidate was built and checked',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const run = await runOwned(mod, clone, capture, { failReplay: true })
      expect(run.result).toMatchObject({ status: 'error', reason_code: 'VERIFICATION_ERROR' })
      expect(checkOf(run.result, 'tests_passed')?.status).toBe('pass')
      expect(checkOf(run.result, 'dataset_matches')).toMatchObject({ status: 'unevaluable', reason_code: 'STAGE_ERROR' })
      expect(run.observation.atDisposal?.worktreeExists).toBe(true)
      await expectReleased(clone, run, worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'stops a running application on disposal instead of waiting for it, then removes everything it owned',
    async () => {
      const mod = await worktreeModule()
      const fx = await fixture({ format: 'sha1', baseline: richBaseline('sha1'), edit: (workspace, expected) => richEdit(workspace, expected, 'sha1') })
      const before = await inventoryRepository(fx.repo.root)
      await withPrivateTmp(async (tmpRoot) => {
        const session = await openSession(mod, fx)
        // No caller signal: only disposal can stop this application.
        const applying = session.applyCandidate(input(fx.candidate)).then(
          () => 'applied',
          (error: unknown) => (error as { readonly code?: string }).code ?? 'unknown',
        )
        // Dispose once the application is running: its private Git state exists.
        const privateGitDir = path.join(path.dirname(session.path), 'candidate-git')
        const deadline = Date.now() + 10_000
        while (!existsSync(privateGitDir) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
        expect(existsSync(privateGitDir)).toBe(true)
        const disposal = await session.dispose()
        expect(await applying).toBe('WORKTREE_APPLY_ABORTED')
        expect(disposal).toEqual({ unchanged: true, mismatches: [], worktreeRemoved: true, privateStateRemoved: true, operationsJoined: true })
        expect(await session.dispose()).toBe(disposal)
        expect(await listTree(tmpRoot)).toEqual([])
      })
      expect(await inventoryRepository(fx.repo.root)).toEqual(before)
    },
    120_000,
  )

  it(
    'creates no worktree, temporary entry, or registration when the run is aborted before setup',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      await withPrivateTmp(async (tmpRoot) => {
        const admission = mod.admitCapturedCandidate(capture, { objectFormat: 'sha1' })
        if (!admission.admitted) throw new Error(`not admitted: ${admission.error.code}`)
        for (const stage of ['prepareBaseline', 'applyCandidate'] as const) {
          const prepared: BaselinePreparedPorts = await mod.createPreparedCandidatePorts({ repoRoot: clone.root, scenario: clone.scenario, candidate: admission.candidate })
          const aborted = new AbortController()
          aborted.abort()
          const context = { ...(await stageContextFor(clone, admission.candidate)), signal: aborted.signal }
          const call = stage === 'prepareBaseline' ? prepareBaselineOf(prepared)(context) : prepared.applyCandidate(context)
          await expect(call, stage).rejects.toThrow()
          expect(prepared.worktreePath(), stage).toBeNull()
          expect(await listTree(tmpRoot), stage).toEqual([])
          expect(git(clone.root, 'worktree', 'list', '--porcelain'), stage).toBe(worktreesBefore)
          expect(await prepared.disposeWorktree(), stage).toEqual({ remaining: [], original: { verified: true, unchanged: true, mismatches: [] } })
        }
      })
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'fails cleanup_complete with a safe category when the owned worktree cannot be removed, and never passes',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const run = await runOwned(mod, clone, capture, {
        beforeDisposal: async (worktree) => {
          const locked = path.join(worktree, 'apps', 'demo-chart', 'src')
          await chmod(locked, 0o555)
          // Runs before the owned TMPDIR root is removed.
          cleanups.push(() => chmod(locked, 0o755))
        },
      })
      expect(run.result).toMatchObject({
        status: 'failed',
        reason_code: 'FINALIZATION_FAILED',
        cleanup: { complete: false, remaining_owned_resources: ['worktree'], original_unchanged: true, original_mismatches: [] },
      })
      expect(checkOf(run.result, 'cleanup_complete')).toMatchObject({ status: 'fail', reason_code: 'CLEANUP_INCOMPLETE' })
      // Idempotent: a second disposal reports the same facts and attempts nothing new.
      expect(await run.prepared.disposeWorktree()).toBe(await run.prepared.disposeWorktree())
      expect(JSON.stringify(run.result)).not.toMatch(/\/tmp\/|EACCES|permission/i)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'reports an owned temporary entry that cannot be removed instead of hiding it',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const run = await runOwned(mod, clone, capture, {
        beforeDisposal: async (worktree) => {
          // Beside the worktree, inside the owned temporary root, as a candidate build could write it.
          const locked = path.join(path.dirname(worktree), 'fp-escaped-output')
          await mkdir(path.join(locked, 'kept'), { recursive: true })
          await writeFile(path.join(locked, 'kept', 'entry'), 'synthetic\n')
          await chmod(locked, 0o555)
          // Runs before the owned TMPDIR root is removed.
          cleanups.push(() => chmod(locked, 0o755))
        },
      })
      expect(run.result.status).not.toBe('passed')
      expect(run.result.cleanup).toMatchObject({ complete: false, original_unchanged: true })
      expect(run.result.cleanup.remaining_owned_resources).toContain('worktree')
      expect(checkOf(run.result, 'cleanup_complete')?.reason_code).toBe('CLEANUP_INCOMPLETE')
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'fails original_unchanged with a safe category when an original tracked file changes during the run, and never passes',
    async () => {
      const mod = await capturedRunModule()
      const clone = await canvasClone()
      const { capture } = await captureExactFilterFix(clone)
      const worktreesBefore = git(clone.root, 'worktree', 'list', '--porcelain')
      const tracked = path.join(clone.root, 'README.md')
      const run = await runOwned(mod, clone, capture, {
        duringBuild: async () => {
          await writeFile(tracked, `${await readFile(tracked, 'utf8')}\nchanged during the run\n`)
        },
      })
      expect(run.result).toMatchObject({ status: 'failed', reason_code: 'FINALIZATION_FAILED', cleanup: { complete: true, original_unchanged: false } })
      expect(run.result.cleanup.original_mismatches).toContain('status')
      expect(checkOf(run.result, 'original_unchanged')).toMatchObject({ status: 'fail', reason_code: 'ORIGINAL_CHANGED' })
      expect(await listTree(run.tmpRoot)).toEqual([])
      expect(git(clone.root, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
    },
    DOCKER_TEST_TIMEOUT,
  )
})
