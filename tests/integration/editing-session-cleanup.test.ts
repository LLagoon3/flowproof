import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionHandle, EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import { createDockerCli } from '../../packages/flowproof/src/editing/dockerCli.js'
import type { DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import type { RuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import { startEditingSession } from '../../packages/flowproof/src/editing/session.js'
import { createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import {
  DOCKER_TEST_TIMEOUT,
  FIXTURE_PROFILE_ID,
  NO_RESIDUE,
  SESSION_LABEL,
  buildFixtureImage,
  containerExists,
  createPrivateTmpRoot,
  createSyntheticRepository,
  fixtureProfile,
  processesMentioning,
  recordingDocker,
  sessionContainers,
  sessionResidue,
  waitForRunningContainer,
} from '../support/editingRuntime.js'
import type { RecordingDocker, SyntheticRepository } from '../support/editingRuntime.js'
import { createTempDirectory, git, snapshotRepository } from '../support/repoFixture.js'
import type { RepositorySnapshot, TempDirectory } from '../support/repoFixture.js'

// T018/T022/T026 (US2, US3): every prepared terminal path against the real Docker daemon.
// Each case must report the correct execution cause, report cleanup independently, and leave no
// owned container, task document, workspace, attach client, or descendant process behind.

const MISSING_IMAGE = `sha256:${'0'.repeat(64)}`
const FAILING_PROFILE_ID = 'missing-image-agent'

let profiles: RuntimeProfileRegistry
let imageId = ''

beforeAll(async () => {
  imageId = await buildFixtureImage()
  profiles = createRuntimeProfileRegistry([fixtureProfile(imageId), fixtureProfile(MISSING_IMAGE, { id: FAILING_PROFILE_ID })])
}, 300_000)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

interface Fixture {
  readonly repo: SyntheticRepository
  readonly tmp: TempDirectory
  readonly marker: string
  readonly docker: RecordingDocker
  /** The complete original-repository snapshot taken after the unrelated state was added. */
  readonly before: RepositorySnapshot
  /** Containers owned by someone else, including one reusing the session label key. */
  readonly unrelatedContainers: readonly string[]
}

const run = promisify(execFile)
const UNRELATED_TMP_ENTRIES = ['flowproof-editing-unrelated', 'flowproof-editing-unrelated/keep.txt']

/** Creates (never starts) a container the session does not own. */
async function unrelatedContainer(label: string): Promise<string> {
  const { stdout } = await run('docker', ['container', 'create', '--pull=never', '--network=none', `--label=${label}`, '--entrypoint=true', imageId], {
    encoding: 'utf8',
  })
  const id = stdout.trim()
  cleanups.push(async () => {
    await run('docker', ['container', 'rm', '--force', id])
  })
  return id
}

async function fixture(inner: DockerAdapter = createDockerCli()): Promise<Fixture> {
  const repo = await createSyntheticRepository()
  const tmp = await createPrivateTmpRoot()
  const side = await createTempDirectory('flowproof-editing-unrelated-')
  cleanups.push(repo.remove, tmp.remove, side.remove)
  const marker = randomBytes(8).toString('hex')
  // Unrelated state the session must leave exactly as it found it.
  git(repo.path, 'worktree', 'add', '--quiet', '--detach', path.join(side.path, 'unrelated-worktree'))
  await writeFile(path.join(repo.path, 'notes.local.txt'), 'untracked local note\n')
  await mkdir(path.join(tmp.path, 'flowproof-editing-unrelated'))
  await writeFile(path.join(tmp.path, 'flowproof-editing-unrelated', 'keep.txt'), 'owned by someone else\n')
  const unrelatedContainers = [
    await unrelatedContainer(`${SESSION_LABEL}=unrelated-${marker}`),
    await unrelatedContainer(`dev.flowproof.test-unrelated=${marker}`),
  ]
  return { repo, tmp, marker, docker: recordingDocker(inner), before: await snapshotRepository(repo.path), unrelatedContainers }
}

/**
 * SC-003/SC-004: no owned container, task document, workspace, attach client, or descendant
 * remains; the original repository matches its complete snapshot; unrelated containers,
 * worktrees, and temporary entries survive untouched.
 */
async function expectContained(fx: Fixture, sessionId: string): Promise<void> {
  expect(await snapshotRepository(fx.repo.path)).toEqual(fx.before)
  expect(await sessionResidue({ sessionId, tmpRoot: fx.tmp.path, needles: [...fx.docker.created, fx.marker] })).toEqual({
    ...NO_RESIDUE,
    tmpEntries: UNRELATED_TMP_ENTRIES,
  })
  for (const id of fx.docker.created) expect(await containerExists(id)).toBe(false)
  for (const id of fx.unrelatedContainers) expect(await containerExists(id)).toBe(true)
  expect(await sessionContainers(`unrelated-${fx.marker}`)).toEqual([fx.unrelatedContainers[0]])
}

function launch(fx: Fixture, task: string, overrides: Record<string, unknown> = {}): EditingSessionHandle {
  return startEditingSession(
    {
      repositoryRoot: fx.repo.path,
      revision: fx.repo.head,
      task: `${task} marker=${fx.marker}`,
      runtimeProfileId: FIXTURE_PROFILE_ID,
      declaredProjectCommands: [],
      ...overrides,
    },
    { profiles, docker: fx.docker, workspaces: createWorkspaceManager({ tmpRoot: fx.tmp.path }) },
  )
}

function expectValid(result: EditingSessionResult): void {
  expect(parseEditingSessionResult(result)).toMatchObject({ ok: true })
}

const COMPLETE = { status: 'complete', containerRemoved: true, workspaceRemoved: true, originalRepositoryUnchanged: true, reasonCode: null, remainingOwnedResources: [] }

describe('editing session termination', () => {
  it(
    'reports a non-zero agent exit as failed and cleans up',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=fail code=7')
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'failed', exitCode: 7, signal: null, cleanup: COMPLETE })
      expect(result.diagnostic).toContain('FIXTURE failing on purpose')
      expectValid(result)
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'reports an image that cannot start as startup_failed after creating the workspace',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=success', { runtimeProfileId: FAILING_PROFILE_ID })
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'startup_failed', exitCode: null, signal: null, cleanup: COMPLETE })
      expect(result.runtime.imageReference).toBe(MISSING_IMAGE)
      expect(fx.docker.created).toEqual([])
      expectValid(result)
      // Partial initialization: the clone and task document existed and are gone.
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'reports an unresolvable revision as startup_failed before any resource exists',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=success', { revision: 'f'.repeat(40) })
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'startup_failed', cleanup: COMPLETE })
      expect(result.runtime.isolation).toBeNull()
      expect(fx.docker.created).toEqual([])
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'times out an agent that ignores SIGTERM, with descendants, and force-removes it after the grace period',
    async () => {
      const fx = await fixture()
      const startedAt = Date.now()
      const handle = launch(fx, 'scenario=hang ignore_term=1 children=2', { limits: { wallClockMs: 3_000, stopGraceMs: 1_000 } })
      const result = await handle.result
      const elapsed = Date.now() - startedAt

      expect(result).toMatchObject({ executionOutcome: 'timed_out', exitCode: 137, signal: 'SIGKILL', cleanup: COMPLETE })
      expect(elapsed).toBeGreaterThanOrEqual(3_000)
      // Wall clock plus the stop grace and bounded margins, not an unbounded wait.
      expect(elapsed).toBeLessThan(3_000 + 1_000 + 20_000)
      expect(result.diagnostic).toContain('FIXTURE ready')
      expectValid(result)
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'cancels a running agent explicitly',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=hang children=1')
      await waitForRunningContainer(handle.id)
      // The host-side residue probe really sees the container's descendant while it runs.
      const deadline = Date.now() + 10_000
      while ((await processesMentioning(`flowproof-fixture-child-${fx.marker}`)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect((await processesMentioning(`flowproof-fixture-child-${fx.marker}`)).length).toBeGreaterThan(0)

      await handle.cancel('developer request')
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'cancelled', exitCode: 143, signal: 'SIGTERM', cleanup: COMPLETE })
      expectValid(result)
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'cancels a running agent through the request AbortSignal',
    async () => {
      const fx = await fixture()
      const controller = new AbortController()
      const handle = launch(fx, 'scenario=hang', { signal: controller.signal })
      await waitForRunningContainer(handle.id)

      controller.abort()
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'cancelled', cleanup: COMPLETE })
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'resolves a cancellation racing normal completion to one consistent outcome',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=exit code=0')
      await waitForRunningContainer(handle.id).catch(() => undefined)

      const [first, second] = await Promise.all([handle.cancel(), handle.cancel()])
      const result = await handle.result

      expect(first).toBeUndefined()
      expect(second).toBeUndefined()
      expect(['completed', 'cancelled']).toContain(result.executionOutcome)
      if (result.executionOutcome === 'completed') expect(result.exitCode).toBe(0)
      expect(result.cleanup).toMatchObject(COMPLETE)
      expect(await handle.result).toBe(result)
      expectValid(result)
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'removes detached descendants that outlive the agent process',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=orphans children=3')
      const result = await handle.result

      expect(result).toMatchObject({ executionOutcome: 'completed', exitCode: 0, cleanup: COMPLETE })
      expect(result.diagnostic).toContain('FIXTURE orphans spawned')
      // The descendants carry the marker in their argv; none survives the container.
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'keeps repeated cleanup calls idempotent after completion',
    async () => {
      const fx = await fixture()
      const handle = launch(fx, 'scenario=exit code=0')
      const result = await handle.result

      await handle.cancel()
      await handle.cancel('again')

      expect(await handle.result).toBe(result)
      expect(result).toMatchObject({ executionOutcome: 'completed', cleanup: COMPLETE })
      expect(fx.docker.created).toHaveLength(1)
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'recovers a transient container-removal interruption by bounded retry',
    async () => {
      const real = createDockerCli()
      let interrupted = 0
      const flaky: DockerAdapter = {
        ...real,
        async remove(id) {
          // The first removal is interrupted before it reaches the daemon.
          if (interrupted === 0) {
            interrupted += 1
            throw Object.assign(new Error('interrupted'), { code: 'DOCKER_REMOVE_FAILED' })
          }
          await real.remove(id)
        },
      }
      const fx = await fixture(flaky)

      const handle = launch(fx, 'scenario=exit code=0')
      const result = await handle.result

      expect(interrupted).toBe(1)
      expect(result).toMatchObject({
        executionOutcome: 'completed',
        cleanup: { ...COMPLETE, status: 'recovered', reasonCode: 'CLEANUP_RETRIED' },
      })
      expectValid(result)
      // Recovered means the same no-residue invariant as complete.
      await expectContained(fx, handle.id)
    },
    DOCKER_TEST_TIMEOUT,
  )
})
