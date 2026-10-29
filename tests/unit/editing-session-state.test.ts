import { describe, expect, it } from 'vitest'

import { parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { AttachOutput, ContainerSpec, ContainerState, DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import { LIFECYCLE_TRANSITIONS, LifecycleError, createSessionLifecycle, startEditingSession } from '../../packages/flowproof/src/editing/session.js'
import type { LifecyclePhase } from '../../packages/flowproof/src/editing/session.js'
import type { OriginalIntegrity, PreparedWorkspace, SessionWorkspace, WorkspaceDisposal } from '../../packages/flowproof/src/editing/workspace.js'

// T017/T019 (US2): the lifecycle state machine, first-terminal-cause selection, idempotent
// cancellation and finalization, and cleanup that preserves the execution outcome while naming
// every remaining owned resource. Fake adapters make every race deterministic.

const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const REVISION = 'b'.repeat(40)
const CONTAINER_ID = 'c'.repeat(64)

const profiles = createRuntimeProfileRegistry([
  {
    id: 'fixture-editing-agent',
    imageReference: IMAGE_ID,
    argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
    environment: {},
    workingDirectory: '/workspace',
  },
])

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repositoryRoot: '/srv/projects/example',
  revision: REVISION,
  task: 'Edit three files.',
  runtimeProfileId: 'fixture-editing-agent',
  declaredProjectCommands: [],
  limits: { wallClockMs: 60_000, stopGraceMs: 1_000 },
  ...overrides,
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface FakeDockerOptions {
  /** Exit code the container reports when stopped; null makes stop hang without effect. */
  readonly stopExitCode?: number | null
  /** Number of initial removals that fail, or `always`. */
  readonly failRemovals?: number | 'always'
  readonly createFails?: boolean
  readonly supported?: boolean
  /** The container never starts its process. */
  readonly startError?: boolean
}

interface FakeDocker extends DockerAdapter {
  readonly calls: string[]
  readonly output: AttachOutput[]
  readonly started: Promise<void>
  /** Ends the container process with `code`. */
  exit(code: number): void
  killedClients: number
}

function fakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const calls: string[] = []
  const output: AttachOutput[] = []
  const started = deferred<void>()
  let exited: Deferred<{ readonly code: number | null }> | null = null
  let exitCode: number | null = null
  let created = false
  let removed = false
  let removalFailures = 0
  const finish = (code: number): void => {
    if (exitCode !== null) return
    exitCode = code
    exited?.resolve({ code })
  }
  const docker: FakeDocker = {
    calls,
    output,
    started: started.promise,
    killedClients: 0,
    exit: finish,
    async preflight() {
      calls.push('preflight')
      return { supported: options.supported ?? true, missing: options.supported === false ? ['seccomp'] : [], isolation: { rootless: false, lsm: null } }
    },
    async create(_spec: ContainerSpec) {
      calls.push('create')
      if (options.createFails) throw Object.assign(new Error('create failed'), { code: 'DOCKER_CREATE_FAILED' })
      created = true
      return CONTAINER_ID
    },
    start(_id: string, attach: AttachOutput) {
      calls.push('start')
      output.push(attach)
      exited = deferred()
      if (options.startError) exited.resolve({ code: 127 })
      started.resolve()
      return {
        exited: exited.promise,
        kill: () => {
          docker.killedClients += 1
        },
      }
    },
    async stop(_id: string, graceSeconds: number) {
      calls.push(`stop:${graceSeconds}`)
      const code = options.stopExitCode === undefined ? 143 : options.stopExitCode
      if (code === null) return new Promise<void>(() => undefined)
      finish(code)
    },
    async inspect(): Promise<ContainerState | null> {
      calls.push('inspect')
      if (!created || removed) return null
      if (options.startError) return { running: false, exitCode: 127, oomKilled: false, started: false, startError: true }
      return { running: exitCode === null, exitCode, oomKilled: false, started: true, startError: false }
    },
    async exists() {
      calls.push('exists')
      return created && !removed
    },
    async findByName() {
      calls.push('findByName')
      return null
    },
    async remove() {
      calls.push('remove')
      if (options.failRemovals === 'always' || removalFailures < (options.failRemovals ?? 0)) {
        removalFailures += 1
        throw Object.assign(new Error('busy'), { code: 'DOCKER_REMOVE_FAILED' })
      }
      // Removing a running container ends its process like a SIGKILL.
      finish(137)
      removed = true
    },
  }
  return docker
}

interface FakeWorkspaceOptions {
  readonly resolveFails?: string
  readonly disposal?: WorkspaceDisposal
  readonly integrity?: OriginalIntegrity
}

interface FakeWorkspace extends SessionWorkspace {
  readonly calls: string[]
}

function fakeWorkspace(options: FakeWorkspaceOptions = {}): FakeWorkspace {
  const calls: string[] = []
  return {
    calls,
    async resolve() {
      calls.push('resolve')
      if (options.resolveFails) throw Object.assign(new Error('resolve failed'), { code: options.resolveFails })
    },
    async create(): Promise<PreparedWorkspace> {
      calls.push('create')
      return { workspacePath: '/tmp/flowproof-editing-Fake01/workspace', taskDocumentPath: '/tmp/flowproof-editing-Fake01/task.json', baselineCommit: REVISION }
    },
    get createdPaths() {
      return []
    },
    pathPlaceholders: () => [],
    async dispose() {
      calls.push('dispose')
      return options.disposal ?? { taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: true }
    },
    async verifyOriginal() {
      calls.push('verifyOriginal')
      return options.integrity ?? { verified: true, unchanged: true, mismatches: [] }
    },
  }
}

function start(docker: DockerAdapter, workspace: SessionWorkspace, overrides: Record<string, unknown> = {}) {
  return startEditingSession(request(overrides), { profiles, docker, workspaces: { open: () => workspace } })
}

function expectValid(result: EditingSessionResult): void {
  expect(parseEditingSessionResult(result)).toMatchObject({ ok: true })
}

describe('lifecycle state machine', () => {
  it('allows exactly the documented transitions', () => {
    expect(LIFECYCLE_TRANSITIONS).toEqual({
      requested: ['preparing'],
      preparing: ['starting', 'cleaning'],
      starting: ['running', 'cleaning'],
      running: ['stopping', 'cleaning'],
      stopping: ['cleaning'],
      cleaning: ['finished'],
      finished: [],
    })
  })

  it.each([
    [['preparing', 'starting', 'running', 'cleaning', 'finished']],
    [['preparing', 'starting', 'running', 'stopping', 'cleaning', 'finished']],
    [['preparing', 'cleaning', 'finished']],
    [['preparing', 'starting', 'cleaning', 'finished']],
  ] as const)('follows the legal path %j', (path) => {
    const lifecycle = createSessionLifecycle()
    expect(lifecycle.phase).toBe('requested')
    for (const phase of path) lifecycle.transition(phase as LifecyclePhase)
    expect(lifecycle.history).toEqual(['requested', ...path])
  })

  it.each([
    ['requested', 'running'],
    ['preparing', 'running'],
    ['running', 'starting'],
    ['stopping', 'running'],
    ['cleaning', 'running'],
    ['finished', 'cleaning'],
  ] as const)('rejects %s -> %s', (from, to) => {
    const lifecycle = createSessionLifecycle()
    const route: Record<string, LifecyclePhase[]> = {
      requested: [],
      preparing: ['preparing'],
      running: ['preparing', 'starting', 'running'],
      stopping: ['preparing', 'starting', 'running', 'stopping'],
      cleaning: ['preparing', 'cleaning'],
      finished: ['preparing', 'cleaning', 'finished'],
    }
    for (const phase of route[from] ?? []) lifecycle.transition(phase)
    expect(() => lifecycle.transition(to)).toThrow(LifecycleError)
    expect(lifecycle.phase).toBe(from)
  })

  it('selects only the first terminal cause', async () => {
    const lifecycle = createSessionLifecycle()
    expect(lifecycle.terminalCause).toBeNull()
    expect(lifecycle.selectTerminal('exited')).toBe(true)
    expect(lifecycle.selectTerminal('cancelled')).toBe(false)
    expect(lifecycle.selectTerminal('timed_out')).toBe(false)
    expect(lifecycle.terminalCause).toBe('exited')
    await expect(lifecycle.terminal).resolves.toBe('exited')
  })
})

describe('terminal-cause races', () => {
  it('lets a late cancellation leave normal completion in place', async () => {
    const docker = fakeDocker()
    const handle = start(docker, fakeWorkspace())
    await docker.started
    docker.exit(0)
    await tick()
    await handle.cancel('too late')

    const result = await handle.result
    expect(result).toMatchObject({ executionOutcome: 'completed', exitCode: 0, signal: null, cleanup: { status: 'complete' } })
    expect(docker.calls.filter((call) => call.startsWith('stop'))).toEqual([])
    expectValid(result)
  })

  it('cancels a running session with a graceful stop and reports the observed signal', async () => {
    const docker = fakeDocker()
    const handle = start(docker, fakeWorkspace())
    await docker.started

    await handle.cancel('user request')
    const result = await handle.result

    expect(result).toMatchObject({ executionOutcome: 'cancelled', exitCode: 143, signal: 'SIGTERM', cleanup: { status: 'complete' } })
    expect(docker.calls).toContain('stop:1')
    expect(docker.calls.indexOf('stop:1')).toBeLessThan(docker.calls.lastIndexOf('remove'))
    expectValid(result)
  })

  it('makes repeated cancellation idempotent and shares one finalization', async () => {
    const docker = fakeDocker()
    const workspace = fakeWorkspace()
    const handle = start(docker, workspace)
    await docker.started

    await Promise.all([handle.cancel(), handle.cancel(), handle.cancel('again')])
    const first = await handle.result
    await handle.cancel()

    expect(await handle.result).toBe(first)
    expect(first.executionOutcome).toBe('cancelled')
    expect(docker.calls.filter((call) => call.startsWith('stop'))).toHaveLength(1)
    expect(docker.calls.filter((call) => call === 'remove')).toHaveLength(1)
    expect(workspace.calls.filter((call) => call === 'dispose')).toHaveLength(1)
    expect(workspace.calls.filter((call) => call === 'verifyOriginal')).toHaveLength(1)
  })

  it('cancels before the container exists without creating or starting one', async () => {
    const docker = fakeDocker()
    const workspace = fakeWorkspace()
    const handle = start(docker, workspace)
    const cancelled = handle.cancel()

    const result = await handle.result
    await cancelled
    expect(result).toMatchObject({ executionOutcome: 'cancelled', exitCode: null, signal: null, cleanup: { status: 'complete' } })
    expect(docker.calls).not.toContain('create')
    expect(docker.calls).not.toContain('start')
    expect(workspace.calls).toContain('dispose')
    expectValid(result)
  })

  it('treats an already-aborted signal as cancellation before any side effect', async () => {
    const docker = fakeDocker()
    const workspace = fakeWorkspace()
    const controller = new AbortController()
    controller.abort()

    const result = await start(docker, workspace, { signal: controller.signal }).result

    expect(result.executionOutcome).toBe('cancelled')
    expect(workspace.calls).not.toContain('create')
    expect(docker.calls).not.toContain('create')
  })

  it('cancels through the request AbortSignal while running', async () => {
    const docker = fakeDocker()
    const controller = new AbortController()
    const handle = start(docker, fakeWorkspace(), { signal: controller.signal })
    await docker.started

    controller.abort()
    const result = await handle.result

    expect(result.executionOutcome).toBe('cancelled')
    expect(docker.calls).toContain('stop:1')
  })

  it('times out at the wall-clock deadline and stops the container', async () => {
    const docker = fakeDocker({ stopExitCode: 137 })
    const startedAt = Date.now()
    const handle = start(docker, fakeWorkspace(), { limits: { wallClockMs: 1_000, stopGraceMs: 1_000 } })

    const result = await handle.result
    await handle.cancel()

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950)
    expect(result).toMatchObject({ executionOutcome: 'timed_out', exitCode: 137, signal: 'SIGKILL', cleanup: { status: 'complete' } })
    expect(docker.calls).toContain('stop:1')
    expectValid(result)
  })

  it('keeps a timeout that won before a later cancellation', async () => {
    const docker = fakeDocker({ stopExitCode: null })
    const handle = start(docker, fakeWorkspace(), { limits: { wallClockMs: 1_000, stopGraceMs: 1_000 } })
    await docker.started
    await tick(1_100)

    await handle.cancel()
    expect((await handle.result).executionOutcome).toBe('timed_out')
  })

  it('force-removes the exact container when a graceful stop does not finish within the grace period', async () => {
    const docker = fakeDocker({ stopExitCode: null })
    const handle = start(docker, fakeWorkspace(), { limits: { wallClockMs: 60_000, stopGraceMs: 1_000 } })
    await docker.started
    const cancelledAt = Date.now()

    await handle.cancel()
    const result = await handle.result

    // Grace plus the bounded stop margin, never an unbounded wait.
    expect(Date.now() - cancelledAt).toBeLessThan(6_000)
    expect(result).toMatchObject({ executionOutcome: 'cancelled', cleanup: { status: 'complete', containerRemoved: true } })
    expect(docker.calls).toContain('remove')
    expect(docker.killedClients).toBeGreaterThan(0)
  })

  it('resolves the result exactly once and keeps the same promise', async () => {
    const docker = fakeDocker()
    const handle = start(docker, fakeWorkspace())
    const promise = handle.result
    await docker.started
    docker.exit(3)

    const result = await promise
    expect(handle.result).toBe(promise)
    expect(result).toMatchObject({ executionOutcome: 'failed', exitCode: 3 })
    await handle.cancel()
    await handle.cancel()
    expect(await handle.result).toBe(result)
    expect(Object.isFrozen(result)).toBe(true)
  })
})

describe('startup failures', () => {
  it.each([
    ['an unresolvable revision', { workspace: { resolveFails: 'REVISION_UNAVAILABLE' } }, []],
    ['a non-repository root', { workspace: { resolveFails: 'REPOSITORY_UNAVAILABLE' } }, []],
    ['an unsupported daemon', { docker: { supported: false } }, ['preflight']],
    ['a failed container creation', { docker: { createFails: true } }, ['preflight', 'create', 'findByName']],
    ['a container whose process never starts', { docker: { startError: true } }, ['preflight', 'create', 'start']],
  ] as const)('reports %s as startup_failed with complete cleanup', async (_label, setup, expectedCalls) => {
    const docker = fakeDocker('docker' in setup ? setup.docker : {})
    const workspace = fakeWorkspace('workspace' in setup ? setup.workspace : {})

    const result = await start(docker, workspace).result

    expect(result).toMatchObject({ executionOutcome: 'startup_failed', exitCode: null, signal: null, cleanup: { status: 'complete' } })
    for (const call of expectedCalls) expect(docker.calls).toContain(call)
    if (!('docker' in setup)) expect(docker.calls).toEqual([])
    expect(workspace.calls).toContain('dispose')
    expectValid(result)
  })
})

describe('persistent cleanup failure', () => {
  it('preserves completion and names the container that could not be removed', async () => {
    const docker = fakeDocker({ failRemovals: 'always' })
    const handle = start(docker, fakeWorkspace())
    await docker.started
    docker.exit(0)

    const result = await handle.result

    expect(result).toMatchObject({
      executionOutcome: 'completed',
      exitCode: 0,
      cleanup: {
        status: 'failed',
        containerRemoved: false,
        workspaceRemoved: true,
        originalRepositoryUnchanged: true,
        reasonCode: 'CONTAINER_NOT_REMOVED',
        remainingOwnedResources: ['container'],
      },
    })
    // Bounded retry: a few attempts, never an unbounded loop.
    const removals = docker.calls.filter((call) => call === 'remove').length
    expect(removals).toBeGreaterThan(1)
    expect(removals).toBeLessThanOrEqual(5)
    expectValid(result)
  })

  it.each([
    [
      'the task document',
      { disposal: { taskDocumentRemoved: false, workspaceRemoved: true, sessionRootRemoved: false } },
      ['task_document'],
      'TASK_DOCUMENT_NOT_REMOVED',
    ],
    ['the workspace', { disposal: { taskDocumentRemoved: true, workspaceRemoved: false, sessionRootRemoved: false } }, ['workspace'], 'WORKSPACE_NOT_REMOVED'],
    [
      'an empty session root',
      { disposal: { taskDocumentRemoved: true, workspaceRemoved: true, sessionRootRemoved: false } },
      ['workspace'],
      'WORKSPACE_NOT_REMOVED',
    ],
    ['a changed original repository', { integrity: { verified: true, unchanged: false, mismatches: ['status'] } }, ['original_repository'], 'ORIGINAL_REPOSITORY_CHANGED'],
    [
      'an unverifiable original repository',
      { integrity: { verified: false, unchanged: false, mismatches: ['snapshot'] } },
      ['original_repository'],
      'ORIGINAL_REPOSITORY_UNVERIFIED',
    ],
    [
      'several resources',
      {
        disposal: { taskDocumentRemoved: false, workspaceRemoved: false, sessionRootRemoved: false },
        integrity: { verified: true, unchanged: false, mismatches: ['refs'] },
      },
      ['task_document', 'workspace', 'original_repository'],
      'TASK_DOCUMENT_NOT_REMOVED',
    ],
  ] as const)('preserves the failed outcome and names %s', async (_label, workspaceOptions, remaining, reasonCode) => {
    const docker = fakeDocker()
    const handle = start(docker, fakeWorkspace(workspaceOptions))
    await docker.started
    docker.exit(4)

    const result = await handle.result

    expect(result.executionOutcome).toBe('failed')
    expect(result.exitCode).toBe(4)
    expect(result.cleanup.status).toBe('failed')
    expect(result.cleanup.remainingOwnedResources).toEqual(remaining)
    expect(result.cleanup.reasonCode).toBe(reasonCode)
    expectValid(result)
  })

  it('reports a transient removal failure recovered by bounded retry', async () => {
    const docker = fakeDocker({ failRemovals: 1 })
    const handle = start(docker, fakeWorkspace())
    await docker.started
    docker.exit(0)

    const result = await handle.result

    expect(result).toMatchObject({
      executionOutcome: 'completed',
      cleanup: { status: 'recovered', reasonCode: 'CLEANUP_RETRIED', remainingOwnedResources: [], containerRemoved: true },
    })
    expectValid(result)
  })
})
