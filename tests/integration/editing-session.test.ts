import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import { createDockerCli } from '../../packages/flowproof/src/editing/dockerCli.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import type { RuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import { startEditingSession } from '../../packages/flowproof/src/editing/session.js'
import { WorkspaceError, createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import {
  DOCKER_TEST_TIMEOUT,
  FIXTURE_COMMAND,
  FIXTURE_PROFILE_ID,
  NO_RESIDUE,
  buildFixtureImage,
  createPrivateTmpRoot,
  createSyntheticRepository,
  fixtureProfile,
  listTree,
  recordingDocker,
  removeFixtureImage,
  sessionResidue,
} from '../support/editingRuntime.js'
import type { SyntheticRepository } from '../support/editingRuntime.js'
import { createTempDirectory, git, gitStatus, snapshotRepository } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T012-T016 (US1): one deterministic agent runs in a standalone clone of an exact commit inside
// the constrained container, edits three files, runs the declared project command, fetches one
// public resource, and exits. The original repository, including unrelated local changes and
// registered worktrees, matches its complete pre-session snapshot afterward, and nothing owned
// by the session remains.

const PUBLIC_RESOURCE = 'https://example.com/'

let imageId = ''
let profiles: RuntimeProfileRegistry

beforeAll(async () => {
  imageId = await buildFixtureImage()
  profiles = createRuntimeProfileRegistry([fixtureProfile(imageId)])
}, 300_000)

afterAll(async () => {
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
}

async function fixture(): Promise<Fixture> {
  const repo = await createSyntheticRepository()
  const tmp = await createPrivateTmpRoot()
  cleanups.push(repo.remove, tmp.remove)
  return { repo, tmp, marker: randomBytes(8).toString('hex') }
}

/** Unrelated local state the session must neither copy nor disturb. */
async function addUnrelatedState(repo: string): Promise<void> {
  const side = await createTempDirectory('flowproof-editing-unrelated-')
  cleanups.push(side.remove)
  git(repo, 'worktree', 'add', '--quiet', '-b', 'unrelated/plain', path.join(side.path, 'plain'))
  await writeFile(path.join(repo, 'README.md'), 'Status: uncommitted local edit\n', { flag: 'a' })
  await writeFile(path.join(repo, 'notes.local.txt'), 'untracked local note\n')
}

/** Every regular file below `root`, relative and sorted, without following symlinks. */
async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  await walk('')
  return found.sort()
}

async function expectWorkspaceError(action: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(WorkspaceError)
  expect((caught as WorkspaceError).code).toBe(code)
}

const TASK_DOCUMENT = Object.freeze({ task: 'Edit three files.', declaredProjectCommands: Object.freeze([FIXTURE_COMMAND]) })

describe('standalone editing clone', () => {
  it('clones the exact commit detached, without hardlinks, a remote, alternates, or source paths', async () => {
    const fx = await fixture()
    await addUnrelatedState(fx.repo.path)
    const before = await snapshotRepository(fx.repo.path)
    const workspace = createWorkspaceManager({ tmpRoot: fx.tmp.path }).open()

    await workspace.resolve(fx.repo.path, fx.repo.head)
    // Resolution records the baseline but creates nothing.
    expect(await listTree(fx.tmp.path)).toEqual([])
    const prepared = await workspace.create(TASK_DOCUMENT)
    cleanups.push(async () => {
      await workspace.dispose()
    })

    const sessionRoot = path.dirname(prepared.workspacePath)
    expect(path.dirname(sessionRoot)).toBe(fx.tmp.path)
    expect(path.basename(sessionRoot)).toMatch(/^flowproof-editing-[A-Za-z0-9]+$/)
    expect(prepared.taskDocumentPath).toBe(path.join(sessionRoot, 'task.json'))
    expect(prepared.baselineCommit).toBe(fx.repo.head)
    expect(workspace.createdPaths).toEqual([sessionRoot, prepared.workspacePath, prepared.taskDocumentPath])
    expect(((await stat(sessionRoot)).mode & 0o777).toString(8)).toBe('700')

    // Exact commit, detached, with the committed content rather than local edits.
    const clone = prepared.workspacePath
    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(fx.repo.head)
    expect(gitStatus(clone, 'symbolic-ref', '-q', 'HEAD')).not.toBe(0)
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(await readFile(path.join(clone, 'README.md'), 'utf8')).toContain('Status: pending')
    expect(existsSync(path.join(clone, 'notes.local.txt'))).toBe(false)

    // A standalone repository: no remote, alternates, gitfile, or worktree registration.
    expect(git(clone, 'remote')).toBe('')
    expect((await lstat(path.join(clone, '.git'))).isDirectory()).toBe(true)
    expect(existsSync(path.join(clone, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    expect(git(fx.repo.path, 'worktree', 'list', '--porcelain')).toBe(before.worktreeList)
    // --no-hardlinks: no object file shares an inode with anything else.
    const objectFiles = await filesBelow(path.join(clone, '.git', 'objects'))
    expect(objectFiles.length).toBeGreaterThan(0)
    for (const file of objectFiles) expect((await stat(path.join(clone, '.git', 'objects', file))).nlink, file).toBe(1)
    // No Git control file names the source repository.
    const sourcePaths = [fx.repo.path, await realpath(fx.repo.path), before.gitCommonDir]
    for (const file of await filesBelow(path.join(clone, '.git'))) {
      const content = await readFile(path.join(clone, '.git', file))
      for (const source of sourcePaths) expect(content.includes(source), `${file} names the source`).toBe(false)
    }

    // The fixed, read-only task document holds exactly the task and declared context.
    expect(JSON.parse(await readFile(prepared.taskDocumentPath, 'utf8'))).toEqual(TASK_DOCUMENT)
    expect(((await stat(prepared.taskDocumentPath)).mode & 0o777).toString(8)).toBe('444')

    // Manifest-scoped disposal, idempotent, and the original is untouched.
    expect(await workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await workspace.dispose()).toEqual({ taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true })
    expect(await listTree(fx.tmp.path)).toEqual([])
    expect(await workspace.verifyOriginal()).toEqual({ verified: true, unchanged: true, mismatches: [] })
    expect(await snapshotRepository(fx.repo.path)).toEqual(before)
  })

  it('checks out an older selected commit rather than the current HEAD', async () => {
    const fx = await fixture()
    await writeFile(path.join(fx.repo.path, 'src', 'math.mjs'), 'export const add = (left, right) => left + right\n')
    git(fx.repo.path, 'commit', '--quiet', '--all', '--message', 'Newer commit')
    const workspace = createWorkspaceManager({ tmpRoot: fx.tmp.path }).open()

    await workspace.resolve(fx.repo.path, fx.repo.head)
    const prepared = await workspace.create(TASK_DOCUMENT)
    cleanups.push(async () => {
      await workspace.dispose()
    })

    expect(git(prepared.workspacePath, 'rev-parse', 'HEAD').trim()).toBe(fx.repo.head)
    expect(await readFile(path.join(prepared.workspacePath, 'src', 'math.mjs'), 'utf8')).toContain('left - right')
    await workspace.dispose()
    expect(await listTree(fx.tmp.path)).toEqual([])
  })

  it('refuses an unresolvable revision or a non-repository root before creating anything', async () => {
    const fx = await fixture()
    const plain = await createTempDirectory('flowproof-editing-plain-')
    cleanups.push(plain.remove)
    const manager = createWorkspaceManager({ tmpRoot: fx.tmp.path })
    const before = await snapshotRepository(fx.repo.path)

    await expectWorkspaceError(() => manager.open().resolve(fx.repo.path, 'f'.repeat(40)), 'REVISION_UNAVAILABLE')
    // A blob or tree object ID is not a commit.
    const blob = git(fx.repo.path, 'rev-parse', 'HEAD:README.md').trim()
    await expectWorkspaceError(() => manager.open().resolve(fx.repo.path, blob), 'REVISION_UNAVAILABLE')
    await expectWorkspaceError(() => manager.open().resolve(plain.path, fx.repo.head), 'REPOSITORY_UNAVAILABLE')
    await expectWorkspaceError(() => manager.open().resolve(path.join(fx.repo.path, 'src'), fx.repo.head), 'REPOSITORY_UNAVAILABLE')
    await expectWorkspaceError(() => manager.open().create(TASK_DOCUMENT), 'WORKSPACE_STATE_INVALID')

    expect(await listTree(fx.tmp.path)).toEqual([])
    expect(await snapshotRepository(fx.repo.path)).toEqual(before)
  })

  it('refuses a session root inside the original repository', async () => {
    const fx = await fixture()
    const inside = path.join(fx.repo.path, '.flowproof-tmp')
    await mkdir(inside)
    const workspace = createWorkspaceManager({ tmpRoot: inside }).open()

    await expectWorkspaceError(() => workspace.resolve(fx.repo.path, fx.repo.head), 'SESSION_ROOT_INSIDE_REPOSITORY')
    expect(await listTree(inside)).toEqual([])
  })

  it('disposes only its own manifest paths', async () => {
    const fx = await fixture()
    const unrelated = path.join(fx.tmp.path, 'flowproof-editing-unrelated')
    await mkdir(unrelated)
    await writeFile(path.join(unrelated, 'keep.txt'), 'owned by someone else\n')
    const workspace = createWorkspaceManager({ tmpRoot: fx.tmp.path }).open()
    await workspace.resolve(fx.repo.path, fx.repo.head)
    await workspace.create(TASK_DOCUMENT)

    await workspace.dispose()

    expect(await listTree(fx.tmp.path)).toEqual(['flowproof-editing-unrelated', 'flowproof-editing-unrelated/keep.txt'])
  })
})

const successTask = (fx: Fixture): string => `scenario=success expect_head=${fx.repo.head} fetch=${PUBLIC_RESOURCE} marker=${fx.marker}`

describe('isolated editing session', () => {
  it(
    'completes an isolated editing session',
    async () => {
      const fx = await fixture()
      await addUnrelatedState(fx.repo.path)
      const before = await snapshotRepository(fx.repo.path)
      const docker = recordingDocker(createDockerCli())

      const handle = startEditingSession(
        {
          repositoryRoot: fx.repo.path,
          revision: fx.repo.head,
          task: successTask(fx),
          runtimeProfileId: FIXTURE_PROFILE_ID,
          declaredProjectCommands: [FIXTURE_COMMAND],
        },
        { profiles, docker, workspaces: createWorkspaceManager({ tmpRoot: fx.tmp.path }) },
      )
      const result: EditingSessionResult = await handle.result

      expect(result).toMatchObject({
        sessionId: handle.id,
        executionOutcome: 'completed',
        exitCode: 0,
        signal: null,
        cleanup: {
          status: 'complete',
          containerRemoved: true,
          workspaceRemoved: true,
          originalRepositoryUnchanged: true,
          reasonCode: null,
          remainingOwnedResources: [],
        },
      })
      expect(parseEditingSessionResult(result)).toMatchObject({ ok: true })
      // SC-001: within two minutes, excluding the image preparation done in beforeAll.
      expect(result.durationMs).toBeLessThan(120_000)

      // The agent saw the exact commit, edited three files, ran the declared command, fetched
      // one public resource, and verified its own edits before exiting.
      expect(result.diagnostic).toContain('FIXTURE head=expected remotes=absent')
      expect(result.diagnostic).toContain('FIXTURE edited files=3')
      expect(result.diagnostic).toContain('FIXTURE command status=0 output=check_passed')
      expect(result.diagnostic).toContain('FIXTURE fetch status=200')
      expect(result.diagnostic).toContain('FIXTURE self_verified=true')

      // SC-004: the original repository and unrelated worktrees match the complete snapshot.
      expect(await snapshotRepository(fx.repo.path)).toEqual(before)
      // SC-003: no container, temporary path, attach client, or descendant remains.
      expect(docker.created).toHaveLength(1)
      expect(await sessionResidue({ sessionId: handle.id, tmpRoot: fx.tmp.path, needles: [...docker.created, fx.marker] })).toEqual(NO_RESIDUE)
    },
    DOCKER_TEST_TIMEOUT,
  )

  it(
    'runs the agent under the container policy with no host mount, credential, or workspace metadata in the result',
    async () => {
      const fx = await fixture()
      const docker = recordingDocker(createDockerCli())
      const preflight = await createDockerCli().preflight()
      const hostSecret = `sk-fpseededhostenv${fx.marker}`
      const saved = { MODEL_API_KEY: process.env.MODEL_API_KEY, FLOWPROOF_HOST_ONLY: process.env.FLOWPROOF_HOST_ONLY }
      Object.assign(process.env, { MODEL_API_KEY: hostSecret, FLOWPROOF_HOST_ONLY: `host-only-${fx.marker}` })
      let result: EditingSessionResult
      let sessionId: string
      try {
        const handle = startEditingSession(
          {
            repositoryRoot: fx.repo.path,
            revision: fx.repo.head,
            task: successTask(fx),
            runtimeProfileId: FIXTURE_PROFILE_ID,
            declaredProjectCommands: [FIXTURE_COMMAND],
          },
          { profiles, docker, workspaces: createWorkspaceManager({ tmpRoot: fx.tmp.path }) },
        )
        sessionId = handle.id
        result = await handle.result
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }

      expect(result.executionOutcome).toBe('completed')
      expect(result.cleanup.status).toBe('complete')
      // The immutable runtime summary reports the observed daemon truthfully.
      expect(result.runtime).toEqual({ profileId: FIXTURE_PROFILE_ID, imageReference: imageId, isolation: preflight.isolation })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.cleanup)).toBe(true)
      expect(Object.isFrozen(result.runtime)).toBe(true)

      // The created container, inspected before it started.
      const [containerId] = docker.created
      const inspected = docker.inspected.get(containerId ?? '') as {
        Config: Record<string, unknown>
        HostConfig: Record<string, unknown>
        Mounts: Array<Record<string, unknown>>
      }
      const uid = process.getuid?.()
      const gid = process.getgid?.()
      expect(inspected.Config).toMatchObject({
        Image: imageId,
        User: `${uid}:${gid}`,
        WorkingDir: '/workspace',
        Entrypoint: ['node'],
        Cmd: ['/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
      })
      expect(inspected.Config.ExposedPorts ?? null).toBeNull()
      const labels = inspected.Config.Labels as Record<string, string>
      expect(Object.keys(labels).filter((key) => key.startsWith('dev.flowproof'))).toEqual(['dev.flowproof.editing-session'])
      expect(labels['dev.flowproof.editing-session']).toBe(sessionId)
      const env = inspected.Config.Env as string[]
      expect(env).toContain('HOME=/home/agent')
      expect(env).toContain('FLOWPROOF_FIXTURE=1')
      // Only the image's own non-secret defaults join the profile environment.
      for (const entry of env) expect(['HOME', 'FLOWPROOF_FIXTURE', 'PATH', 'NODE_VERSION', 'YARN_VERSION']).toContain(entry.split('=')[0])
      expect(env.join('\n')).not.toContain(hostSecret)

      const host = inspected.HostConfig
      expect(host).toMatchObject({
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        Init: true,
        NetworkMode: 'bridge',
        PublishAllPorts: false,
        Memory: 1_073_741_824,
        MemorySwap: 1_073_741_824,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        LogConfig: { Type: 'none' },
      })
      expect(host.CapAdd ?? []).toEqual([])
      expect(host.Devices ?? []).toEqual([])
      expect(host.Binds ?? []).toEqual([])
      expect(Object.keys((host.PortBindings as Record<string, unknown> | null) ?? {})).toEqual([])
      expect(host.SecurityOpt).toContain('no-new-privileges')
      expect((host.SecurityOpt as string[]).join(' ')).not.toMatch(/seccomp|unconfined/)
      expect(host.IpcMode).not.toBe('host')
      expect(host.PidMode ?? '').toBe('')
      expect(host.UsernsMode ?? '').toBe('')
      expect(Object.keys(host.Tmpfs as Record<string, string>).sort()).toEqual(['/home/agent', '/tmp'])

      // Exactly the session workspace (read-write) and task document (read-only) are mounted.
      const mounts = inspected.Mounts.map((mount) => ({
        type: mount.Type,
        destination: mount.Destination,
        rw: mount.RW,
        propagation: mount.Propagation,
        source: String(mount.Source),
      }))
      expect(mounts.map(({ source: _source, ...rest }) => rest).sort((left, right) => String(left.destination).localeCompare(String(right.destination)))).toEqual([
        { type: 'bind', destination: '/run/flowproof/task.json', rw: false, propagation: 'rprivate' },
        { type: 'bind', destination: '/workspace', rw: true, propagation: 'rprivate' },
      ])
      const homeDirectory = process.env.HOME ?? '/home'
      for (const { source } of mounts) {
        expect(source.startsWith(`${fx.tmp.path}/flowproof-editing-`)).toBe(true)
        expect(source.startsWith(fx.repo.path)).toBe(false)
        expect(source.startsWith(`${homeDirectory}/`) && !source.startsWith(fx.tmp.path)).toBe(false)
        expect(source).not.toMatch(/docker\.sock/)
      }

      // In-container observations: non-root, seccomp filtering, no privileges or capabilities,
      // read-only root and task document, writable home, and no Docker socket.
      expect(result.diagnostic).toContain(`FIXTURE isolation uid=${uid} seccomp=2 nonewprivs=1 capeff=0000000000000000`)
      expect(result.diagnostic).toContain('FIXTURE filesystem rootfs=readonly task_document=readonly docker_socket=absent home=writable')

      // No credential, host path, or workspace metadata reaches the result.
      expect(Object.keys(result)).toEqual(['sessionId', 'executionOutcome', 'exitCode', 'signal', 'durationMs', 'diagnostic', 'cleanup', 'runtime'])
      const serialized = JSON.stringify(result)
      for (const forbidden of [hostSecret, `host-only-${fx.marker}`, fx.repo.path, fx.tmp.path, 'flowproof-editing-', 'math.mjs', 'greeting.mjs', 'README.md']) {
        expect(serialized).not.toContain(forbidden)
      }
      expect(await sessionResidue({ sessionId, tmpRoot: fx.tmp.path, needles: [...docker.created, fx.marker] })).toEqual(NO_RESIDUE)
    },
    DOCKER_TEST_TIMEOUT,
  )
})
