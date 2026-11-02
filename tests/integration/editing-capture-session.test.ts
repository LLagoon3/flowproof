import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { CAPTURE_REASON_MESSAGES, validateCapturingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureCandidate, CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import { EDITING_SESSION_RESULT_FIELDS, parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import { createDockerCli } from '../../packages/flowproof/src/editing/dockerCli.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import type { RuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import { startCapturingEditingSession } from '../../packages/flowproof/src/editing/session.js'
import { createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import type { SessionWorkspace, WorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import {
  DOCKER_TEST_TIMEOUT,
  FIXTURE_IMAGE_TAG,
  FIXTURE_PROFILE_ID,
  FIXTURE_PROJECT_DIR,
  NO_RESIDUE,
  buildFixtureImage,
  createPrivateTmpRoot,
  createSyntheticRepository,
  fixtureProfile,
  processesWithin,
  recordingDocker,
  removeFixtureImage,
  sessionResidue,
  waitForRunningContainer,
} from '../support/editingRuntime.js'
import type { RecordingDocker, SyntheticRepository } from '../support/editingRuntime.js'
import { createTempDirectory, git, snapshotRepository } from '../support/repoFixture.js'
import type { RepositorySnapshot, TempDirectory } from '../support/repoFixture.js'

// T019/T021 (specs/003-capture-editing-candidate, US3): the opt-in capturing session against the
// real Docker daemon and the credential-free fixture agent. Capture runs only after an inspected
// successful stop and a proved workspace view, before disposal; every terminal path still removes
// the exact container, its anonymous volumes, the workspace, and the private capture scratch, and
// the original checkout matches its complete snapshot. Cleanup failures stay explicit beside a
// completed candidate. Nothing here claims verification.

const run = promisify(execFile)
const NESTED_VOLUME_PROFILE_ID = 'nested-volume-agent'
// A per-worker tag, like the fixture image, so concurrent workers never untag each other's image.
const NESTED_VOLUME_TAG = `${FIXTURE_IMAGE_TAG}-nested-volume`
const SEEDED = ['FPCAPTURE', 'SEEDED', 'MARKER', '000001'].join('')
const TOKEN = ['gh', 'p_', 'FPCAPTURE', 'SEEDED', 'TOKEN', '00000000001'].join('')
const scanner = createSecretScanner({ markers: [SEEDED] })

let profiles: RuntimeProfileRegistry
let nestedVolumeImage = ''

beforeAll(async () => {
  const imageId = await buildFixtureImage()
  // A disposable derived image whose declared volume obscures part of `/workspace`.
  execFileSync('docker', ['build', '--quiet', '--tag', NESTED_VOLUME_TAG, '-'], {
    input: `FROM ${FIXTURE_IMAGE_TAG}\nVOLUME /workspace/generated\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 300_000,
  })
  nestedVolumeImage = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', NESTED_VOLUME_TAG], { encoding: 'utf8' }).trim()
  profiles = createRuntimeProfileRegistry([fixtureProfile(imageId), fixtureProfile(nestedVolumeImage, { id: NESTED_VOLUME_PROFILE_ID })])
}, 300_000)

afterAll(async () => {
  await run('docker', ['image', 'rm', NESTED_VOLUME_TAG]).catch(() => undefined)
  await removeFixtureImage()
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

interface Fixture {
  readonly repo: SyntheticRepository
  readonly tmp: TempDirectory
  readonly marker: string
  readonly docker: RecordingDocker
  readonly before: RepositorySnapshot
}

async function fixture(): Promise<Fixture> {
  const repo = await createSyntheticRepository()
  const tmp = await createPrivateTmpRoot()
  cleanups.push(repo.remove, tmp.remove)
  return { repo, tmp, marker: randomBytes(8).toString('hex'), docker: recordingDocker(createDockerCli()), before: await snapshotRepository(repo.path) }
}

function launch(fx: Fixture, task: string, options: { readonly overrides?: Record<string, unknown>; readonly workspaces?: WorkspaceManager } = {}) {
  return startCapturingEditingSession(
    {
      repositoryRoot: fx.repo.path,
      revision: fx.repo.head,
      task: `${task} marker=${fx.marker}`,
      runtimeProfileId: FIXTURE_PROFILE_ID,
      declaredProjectCommands: [],
      ...options.overrides,
    },
    { profiles, docker: fx.docker, workspaces: options.workspaces ?? createWorkspaceManager({ tmpRoot: fx.tmp.path }), scanner },
  )
}

/** The full composition contract, the unchanged session field set, and no verified claim. */
function expectComposition(result: CapturingEditingSessionResult): void {
  expect(Object.keys(result)).toEqual(['session', 'capture'])
  expect(Object.keys(result.session)).toEqual([...EDITING_SESSION_RESULT_FIELDS])
  expect(parseEditingSessionResult(result.session)).toMatchObject({ ok: true })
  expect(validateCapturingSessionResult(result)).toMatchObject({ ok: true })
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('Verified Fix')
  expect(serialized).not.toMatch(/fpseeded|FPCAPTURESEEDED/i)
}

/** No owned container, anonymous volume, temporary entry, or capture/attach process remains. */
async function expectNoResidue(fx: Fixture, sessionId: string): Promise<void> {
  expect(await sessionResidue({ sessionId, tmpRoot: fx.tmp.path, needles: [...fx.docker.created, fx.marker] })).toEqual(NO_RESIDUE)
  expect(await processesWithin(fx.tmp.path)).toEqual([])
  for (const inspected of fx.docker.inspected.values()) {
    for (const mount of (inspected.Mounts as Array<Record<string, unknown>>) ?? []) {
      if (mount.Type !== 'volume') continue
      const { stdout } = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${String(mount.Name)}$`], { encoding: 'utf8' })
      expect(stdout.trim(), 'anonymous volume').toBe('')
    }
  }
  expect(await snapshotRepository(fx.repo.path)).toEqual(fx.before)
}

const COMPLETE = { status: 'complete', containerRemoved: true, workspaceRemoved: true, originalRepositoryUnchanged: true, reasonCode: null, remainingOwnedResources: [] }

// ---------------------------------------------------------------------------------------
// Independent expected state of the fixture's `scenario=capture` edits.
// ---------------------------------------------------------------------------------------

type Mode = '100644' | '100755' | '120000'
type State = Map<string, { readonly mode: Mode; readonly data: Buffer }>

const blobId = (data: Buffer): string => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest('hex')

async function expectedCaptureState(): Promise<{ readonly baseline: State; readonly final: State }> {
  const read = (relative: string): Promise<Buffer> => readFile(path.join(FIXTURE_PROJECT_DIR, relative))
  const baseline: State = new Map()
  for (const relative of ['README.md', 'package.json', 'scripts/check.mjs', 'src/greeting.mjs', 'src/math.mjs']) {
    baseline.set(relative, { mode: '100644', data: await read(relative) })
  }
  const final: State = new Map(baseline)
  final.set('src/math.mjs', { mode: '100644', data: Buffer.from((await read('src/math.mjs')).toString('utf8').replace('return left - right', 'return left + right')) })
  final.set('assets/pixel.bin', { mode: '100644', data: Buffer.from([0x89, 0x46, 0x50, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0x0a, 0x00]) })
  final.set('empty.txt', { mode: '100644', data: Buffer.alloc(0) })
  final.set(Buffer.from('src/héllo.txt', 'utf8').toString('latin1'), { mode: '100644', data: Buffer.from('café 안녕 no final newline', 'utf8') })
  final.set('lib/greeting.mjs', { mode: '100644', data: await read('src/greeting.mjs') })
  final.delete('src/greeting.mjs')
  final.set('scripts/check.mjs', { mode: '100755', data: await read('scripts/check.mjs') })
  final.set('lib/math-link.mjs', { mode: '120000', data: Buffer.from('../src/math.mjs') })
  final.delete('README.md')
  return { baseline, final }
}

/** Baseline checkout plus `git apply --index` of the captured patch, read back from the index. */
async function rebuild(repo: SyntheticRepository, patch: Buffer): Promise<State> {
  const scratch = await createTempDirectory('flowproof-capture-session-rebuild-')
  cleanups.push(scratch.remove)
  const root = path.join(scratch.path, 'repo')
  execFileSync('git', ['clone', '--quiet', '--no-checkout', repo.path, root], { stdio: 'ignore' })
  git(root, 'checkout', '--quiet', '--detach', repo.head)
  execFileSync('git', ['-C', root, 'apply', '--index', '--binary', '-'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
  const state: State = new Map()
  for (const record of execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z']).toString('latin1').split('\0').filter(Boolean)) {
    const [meta = '', key = ''] = record.split('\t')
    const [mode, id] = meta.split(' ') as [Mode, string]
    state.set(key, { mode, data: execFileSync('git', ['-C', root, 'cat-file', 'blob', id]) })
  }
  return state
}

const render = (state: State): Record<string, string> =>
  Object.fromEntries([...state].map(([key, entry]) => [Buffer.from(key, 'latin1').toString('hex'), `${entry.mode}:${entry.data.toString('hex')}`]))

function expectCandidateFiles(candidate: CaptureCandidate, baseline: State, final: State): void {
  const keys = new Set([...baseline.keys(), ...final.keys()])
  const changed = [...keys]
    .filter((key) => {
      const before = baseline.get(key)
      const after = final.get(key)
      return before?.mode !== after?.mode || !before?.data.equals(after?.data ?? Buffer.alloc(0)) || (before === undefined) !== (after === undefined)
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'latin1'), Buffer.from(right, 'latin1')))
  expect(candidate.files.map((record) => record.path.toString('latin1'))).toEqual(changed)
  for (const record of candidate.files) {
    const key = record.path.toString('latin1')
    const before = baseline.get(key)
    const after = final.get(key)
    expect(record.operation, key).toBe(before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified')
    expect([record.oldMode, record.oldObjectId, record.oldSize], key).toEqual(before === undefined ? [null, null, null] : [before.mode, blobId(before.data), before.data.length])
    expect([record.newMode, record.newObjectId, record.newSize], key).toEqual(after === undefined ? [null, null, null] : [after.mode, blobId(after.data), after.data.length])
  }
}

describe('capturing editing session', () => {
  it(
    'captures the exact versioned changes of a successful editor before disposal',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=capture')
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({ sessionId: handle.id, executionOutcome: 'completed', exitCode: 0, signal: null, cleanup: COMPLETE })
      expect(result.session.diagnostic).toContain('FIXTURE capture edits applied')
      expect(result.capture.status).toBe('captured')
      if (result.capture.status !== 'captured') return
      const { candidate } = result.capture
      expect(candidate.sessionId).toBe(handle.id)
      expect(candidate.baselineCommit).toBe(fx.repo.head)
      expect(candidate.coverage).toEqual({ scope: 'main_repository', note: null })
      const { baseline, final } = await expectedCaptureState()
      expect(render(await rebuild(fx.repo, candidate.patch))).toEqual(render(final))
      expectCandidateFiles(candidate, baseline, final)
      await expectNoResidue(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'reports no changes after edits the editor reverted',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=revert')
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({ executionOutcome: 'completed', cleanup: COMPLETE })
      expect(result.capture).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })
      await expectNoResidue(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it.each([
    ['a credential-shaped text change', 'scenario=sensitive'],
    ['a seeded marker in a binary payload', 'scenario=sensitive kind=marker'],
  ])(
    'rejects %s as a whole without exposing it',
    async (_label, task) => {
      const fx = await fixture()
      const handle = launch(fx, task)
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({ executionOutcome: 'completed', cleanup: COMPLETE })
      expect(result.capture).toEqual({
        status: 'rejected',
        reasonCode: 'SENSITIVE_DATA',
        message: CAPTURE_REASON_MESSAGES.SENSITIVE_DATA,
        coverage: { scope: 'main_repository', note: null },
      })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
      await expectNoResidue(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it.each([
    ['a nonzero exit after edits', 'scenario=capture code=5', {}, 'failed'],
    ['a timeout after edits', 'scenario=capture after=hang', { limits: { wallClockMs: 3_000, stopGraceMs: 1_000 } }, 'timed_out'],
    ['a cancellation after edits', 'scenario=capture after=hang', {}, 'cancelled'],
  ] as const)(
    'never captures after %s and still cleans up',
    async (label, task, overrides, outcome) => {
      const fx = await fixture()
      const handle = launch(fx, task, { overrides })
      if (label.startsWith('a cancellation')) {
        await waitForRunningContainer(handle.id)
        await handle.cancel('developer request')
      }
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({ executionOutcome: outcome, cleanup: COMPLETE })
      expect(result.capture).toEqual({ status: 'not_attempted', reasonCode: 'EDITOR_NOT_SUCCESSFUL', message: CAPTURE_REASON_MESSAGES.EDITOR_NOT_SUCCESSFUL, coverage: null })
      await expectNoResidue(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'rejects capture when an image-declared volume obscures part of the workspace',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=capture', { overrides: { runtimeProfileId: NESTED_VOLUME_PROFILE_ID } })
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({ executionOutcome: 'completed', exitCode: 0, cleanup: COMPLETE })
      expect(result.capture).toEqual({ status: 'rejected', reasonCode: 'WORKSPACE_VIEW_UNAVAILABLE', message: CAPTURE_REASON_MESSAGES.WORKSPACE_VIEW_UNAVAILABLE, coverage: null })
      // The obscuring anonymous volume really existed, and cleanup removed it.
      const [containerId] = fx.docker.created
      const mounts = (fx.docker.inspected.get(containerId ?? '')?.Mounts as Array<Record<string, unknown>>) ?? []
      expect(mounts.some((mount) => mount.Type === 'volume' && mount.Destination === '/workspace/generated')).toBe(true)
      await expectNoResidue(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------
// T021: injected cleanup and integrity failures stay explicit beside a completed candidate, and
// capture scratch is accounted for under the existing workspace category.
// ---------------------------------------------------------------------------------------

/** Wraps each opened workspace; `before` runs ahead of the real disposal. */
function wrappedWorkspaces(tmpRoot: string, wrap: (inner: SessionWorkspace) => Partial<SessionWorkspace>): WorkspaceManager {
  const manager = createWorkspaceManager({ tmpRoot })
  return {
    open: () => {
      const inner = manager.open()
      const overrides = wrap(inner)
      return {
        resolve: (root, revision) => inner.resolve(root, revision),
        create: (document) => inner.create(document),
        prepareCapture: () => (inner.prepareCapture as NonNullable<SessionWorkspace['prepareCapture']>)(),
        get createdPaths() {
          return inner.createdPaths
        },
        pathPlaceholders: () => inner.pathPlaceholders(),
        dispose: () => inner.dispose(),
        verifyOriginal: () => inner.verifyOriginal(),
        ...overrides,
      }
    },
  }
}

describe('capture with explicit cleanup failures', () => {
  it(
    'reports capture scratch that cannot be removed as workspace residue beside the candidate',
    async () => {
      const fx = await fixture()
      let scratch = ''
      const workspaces = wrappedWorkspaces(fx.tmp.path, (inner) => ({
        dispose: async () => {
          scratch = inner.createdPaths.find((entry) => entry.endsWith('/capture-git')) ?? ''
          // A read-only object directory makes the private scratch undeletable.
          if (scratch !== '') await chmod(path.join(scratch, 'objects'), 0o500)
          return inner.dispose()
        },
      }))
      cleanups.push(async () => {
        if (scratch !== '') await chmod(path.join(scratch, 'objects'), 0o700).catch(() => undefined)
      })
      const handle = launch(fx, 'scenario=capture', { workspaces })
      const result = await handle.result

      expectComposition(result)
      expect(scratch).not.toBe('')
      expect(result.session).toMatchObject({
        executionOutcome: 'completed',
        exitCode: 0,
        cleanup: { status: 'failed', containerRemoved: true, workspaceRemoved: false, reasonCode: 'WORKSPACE_NOT_REMOVED', remainingOwnedResources: ['workspace'] },
      })
      expect(result.capture.status).toBe('captured')
      expect(JSON.stringify(result.session)).not.toContain(scratch)
      expect(await snapshotRepository(fx.repo.path)).toEqual(fx.before)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'reports a changed original repository explicitly beside the candidate',
    async () => {
      const fx = await fixture()
      const workspaces = wrappedWorkspaces(fx.tmp.path, (inner) => ({
        verifyOriginal: async () => {
          // Something else changes the original checkout while the session finalizes.
          await writeFile(path.join(fx.repo.path, 'concurrent-change.txt'), 'not FlowProof\n')
          return inner.verifyOriginal()
        },
      }))
      const handle = launch(fx, 'scenario=capture', { workspaces })
      const result = await handle.result

      expectComposition(result)
      expect(result.session).toMatchObject({
        executionOutcome: 'completed',
        cleanup: { status: 'failed', containerRemoved: true, workspaceRemoved: true, originalRepositoryUnchanged: false, reasonCode: 'ORIGINAL_REPOSITORY_CHANGED' },
      })
      expect(result.capture.status).toBe('captured')
      expect(await sessionResidue({ sessionId: handle.id, tmpRoot: fx.tmp.path, needles: [...fx.docker.created, fx.marker] })).toEqual(NO_RESIDUE)
    },
    DOCKER_TEST_TIMEOUT,
  )
})
