import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import type { RuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import type { AttachOutput, ContainerSpec, ContainerState, DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import type {
  OriginalIntegrity,
  PathPlaceholder,
  PreparedWorkspace,
  SessionWorkspace,
  WorkspaceDisposal,
} from '../../packages/flowproof/src/editing/workspace.js'

// Deterministic in-memory Docker and workspace adapters for the editing-session contract and unit
// suites. They let a test decide exactly when the container exits, what it prints, and which
// cleanup step fails, so races and failure paths are reproducible without a daemon.

export const FAKE_IMAGE_ID = `sha256:${'a'.repeat(64)}`
export const FAKE_REVISION = 'b'.repeat(40)
export const FAKE_CONTAINER_ID = 'c'.repeat(64)
export const FAKE_REPOSITORY_ROOT = '/srv/projects/example'
export const FAKE_SESSION_ROOT = '/tmp/flowproof-editing-Fake01'

export const fakeProfiles = (): RuntimeProfileRegistry =>
  createRuntimeProfileRegistry([
    {
      id: 'fixture-editing-agent',
      imageReference: FAKE_IMAGE_ID,
      argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
      environment: {},
      workingDirectory: '/workspace',
    },
  ])

export const fakeRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repositoryRoot: FAKE_REPOSITORY_ROOT,
  revision: FAKE_REVISION,
  task: 'Edit three files.',
  runtimeProfileId: 'fixture-editing-agent',
  declaredProjectCommands: [],
  limits: { wallClockMs: 60_000, stopGraceMs: 1_000 },
  ...overrides,
})

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface FakeDockerOptions {
  /** Exit code the container reports when stopped; null makes stop hang without effect. */
  readonly stopExitCode?: number | null
  /** Number of initial removals that fail, or `always`. */
  readonly failRemovals?: number | 'always'
  readonly createFails?: boolean
  readonly supported?: boolean
  /** The container never starts its process. */
  readonly startError?: boolean
  /** Output chunks the container prints as soon as it starts. */
  readonly stdout?: readonly (string | Buffer)[]
  readonly stderr?: readonly (string | Buffer)[]
  /** Exit immediately after printing, with this code. */
  readonly exitImmediately?: number
}

export interface FakeDocker extends DockerAdapter {
  readonly calls: string[]
  readonly started: Promise<void>
  /** Ends the container process with `code`. */
  exit(code: number): void
  killedClients: number
}

const chunk = (value: string | Buffer): Buffer => (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)

export function fakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const calls: string[] = []
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
    started: started.promise,
    killedClients: 0,
    exit: finish,
    async preflight() {
      calls.push('preflight')
      return { supported: options.supported ?? true, missing: options.supported === false ? ['seccomp'] : [], isolation: { rootless: false, lsm: null } }
    },
    async create(_spec: ContainerSpec) {
      calls.push('create')
      if (options.createFails) {
        throw Object.assign(new Error(`Error response from daemon: conflict at ${FAKE_SESSION_ROOT} for MODEL_API_KEY=sk-abcdefghijklmnopqrstuv`), {
          code: 'DOCKER_CREATE_FAILED',
        })
      }
      created = true
      return FAKE_CONTAINER_ID
    },
    start(_id: string, attach: AttachOutput) {
      calls.push('start')
      exited = deferred()
      for (const value of options.stdout ?? []) attach.onStdout(chunk(value))
      for (const value of options.stderr ?? []) attach.onStderr(chunk(value))
      if (options.startError) exited.resolve({ code: 127 })
      if (options.exitImmediately !== undefined) finish(options.exitImmediately)
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

export interface FakeWorkspaceOptions {
  readonly resolveFails?: string
  readonly disposal?: WorkspaceDisposal
  readonly integrity?: OriginalIntegrity
}

export interface FakeWorkspace extends SessionWorkspace {
  readonly calls: string[]
}

/** The host paths a real session would know: its root and the source repository. */
export const FAKE_PLACEHOLDERS: readonly PathPlaceholder[] = [
  { value: FAKE_SESSION_ROOT, placeholder: '<session-root>' },
  { value: FAKE_REPOSITORY_ROOT, placeholder: '<source-repository>' },
  { value: 'flowproof-editing-Fake01', placeholder: '<session-root>' },
]

export function fakeWorkspace(options: FakeWorkspaceOptions = {}): FakeWorkspace {
  const calls: string[] = []
  return {
    calls,
    async resolve() {
      calls.push('resolve')
      if (options.resolveFails) throw Object.assign(new Error('resolve failed'), { code: options.resolveFails })
    },
    async create(): Promise<PreparedWorkspace> {
      calls.push('create')
      return { workspacePath: `${FAKE_SESSION_ROOT}/workspace`, taskDocumentPath: `${FAKE_SESSION_ROOT}/task.json`, baselineCommit: FAKE_REVISION }
    },
    get createdPaths() {
      return []
    },
    pathPlaceholders: () => FAKE_PLACEHOLDERS,
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
