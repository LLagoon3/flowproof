import { execFile, spawn } from 'node:child_process'
import path from 'node:path'

import { containsSecretPattern, isSecretKeyName } from '../evidence/sanitize.js'
import { IMMUTABLE_IMAGE_PATTERN, LSM_KINDS, TASK_DOCUMENT_MOUNT, WORKSPACE_MOUNT, resolveSessionLimits } from './contracts.js'
import type { IsolationObservation, LsmKind, ResolvedRuntimeProfile, SessionLimits } from './contracts.js'

// The shell-free Docker CLI adapter. Creation argv comes only from a registered profile,
// validated resolved limits, and FlowProof-created paths; there is no field through which a
// caller could add a flag, mount, network, port, or shell. Every other operation addresses one
// exact 64-hex container ID. Docker output and error text never leave this module: failures are
// stable codes.

export const EDITING_SESSION_LABEL = 'dev.flowproof.editing-session'
export const CONTAINER_NAME_PREFIX = 'flowproof-editing-'
export const CONTAINER_HOME = '/home/agent'
/** Size of each bounded tmpfs mount (`/tmp` and the agent home); it also counts toward memory. */
export const TMPFS_BYTES = 134_217_728

const COMMAND_TIMEOUT_MS = 30_000
// The CLI must settle before the session's wider stop boundary expires, so a timed-out
// `docker stop` process cannot outlive the result. The session allows one additional second.
const STOP_MARGIN_MS = 1_000
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Bind-mount sources are FlowProof-created temporary paths; this charset keeps them free of the
// `,` and `=` that Docker's mount syntax would parse as options.
const SAFE_HOST_PATH = /^\/[A-Za-z0-9._/-]+$/
const ENVIRONMENT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/
// Variables the Docker CLI itself may need to reach the daemon; none is passed to the container.
const DOCKER_CLI_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'XDG_RUNTIME_DIR',
] as const

export type DockerErrorCode =
  | 'DOCKER_SPEC_INVALID'
  | 'DOCKER_UNAVAILABLE'
  | 'DOCKER_CREATE_FAILED'
  | 'DOCKER_STOP_FAILED'
  | 'DOCKER_INSPECT_FAILED'
  | 'DOCKER_REMOVE_FAILED'

/** A Docker failure with a stable code; it never carries Docker's output. */
export class DockerError extends Error {
  readonly code: DockerErrorCode

  constructor(code: DockerErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'DockerError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------
// Container creation argv
// ---------------------------------------------------------------------------------------

export interface ContainerSpec {
  readonly sessionId: string
  readonly profile: ResolvedRuntimeProfile
  readonly limits: SessionLimits
  /** The non-root identity the agent runs as; FlowProof uses its own UID/GID. */
  readonly user: { readonly uid: number; readonly gid: number }
  /** FlowProof-created standalone clone, mounted read-write at `/workspace`. */
  readonly workspacePath: string
  /** FlowProof-created task document, mounted read-only at `/run/flowproof/task.json`. */
  readonly taskDocumentPath: string
  /** The LSM the daemon offers, from capability preflight. */
  readonly lsm: LsmKind | null
}

const SPEC_KEYS = ['limits', 'lsm', 'profile', 'sessionId', 'taskDocumentPath', 'user', 'workspacePath'].sort().join(',')

export const containerName = (sessionId: string): string => `${CONTAINER_NAME_PREFIX}${sessionId}`

const invalidSpec = (field: string): DockerError => new DockerError('DOCKER_SPEC_INVALID', `The container specification is invalid at ${field}.`)

const isNonRootId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function isSafeHostPath(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    SAFE_HOST_PATH.test(candidate) &&
    path.posix.normalize(candidate) === candidate &&
    !candidate.split('/').includes('..')
  )
}

function validateSpec(spec: ContainerSpec): void {
  if (typeof spec !== 'object' || spec === null || Object.keys(spec).sort().join(',') !== SPEC_KEYS) throw invalidSpec('spec')
  if (typeof spec.sessionId !== 'string' || !UUID_PATTERN.test(spec.sessionId)) throw invalidSpec('sessionId')
  const { profile } = spec
  if (typeof profile?.imageReference !== 'string' || !IMMUTABLE_IMAGE_PATTERN.test(profile.imageReference)) throw invalidSpec('profile.imageReference')
  if (!Array.isArray(profile.argv) || profile.argv.length === 0 || profile.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw invalidSpec('profile.argv')
  }
  if (profile.argv[0] === '') throw invalidSpec('profile.argv')
  if (profile.workingDirectory !== WORKSPACE_MOUNT) throw invalidSpec('profile.workingDirectory')
  for (const [key, value] of Object.entries(profile.environment ?? {})) {
    if (
      !ENVIRONMENT_KEY_PATTERN.test(key) ||
      key === 'HOME' ||
      typeof value !== 'string' ||
      /[\0\r\n]/.test(value) ||
      isSecretKeyName(key) ||
      containsSecretPattern(`${key}=${value}`)
    ) {
      throw invalidSpec('profile.environment')
    }
  }
  // Re-validates the resolved limits against the global bounds; nothing unresolved reaches argv.
  try {
    const limits = resolveSessionLimits(spec.limits)
    if (Object.keys(spec.limits).length !== Object.keys(limits).length) throw new Error('unresolved')
  } catch {
    throw invalidSpec('limits')
  }
  if (!isNonRootId(spec.user?.uid) || !isNonRootId(spec.user?.gid)) throw invalidSpec('user')
  if (!isSafeHostPath(spec.workspacePath)) throw invalidSpec('workspacePath')
  if (!isSafeHostPath(spec.taskDocumentPath) || spec.taskDocumentPath === spec.workspacePath) throw invalidSpec('taskDocumentPath')
  if (spec.lsm !== null && !(LSM_KINDS as readonly string[]).includes(spec.lsm)) throw invalidSpec('lsm')
}

/** The complete `docker container create` argv for one session; throws before anything runs. */
export function buildCreateArgs(spec: ContainerSpec): readonly string[] {
  validateSpec(spec)
  const { profile, limits, user } = spec
  const [entrypoint, ...args] = profile.argv as [string, ...string[]]
  const environment = Object.entries(profile.environment).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.freeze([
    'container',
    'create',
    '--pull=never',
    `--name=${containerName(spec.sessionId)}`,
    `--label=${EDITING_SESSION_LABEL}=${spec.sessionId}`,
    '--init',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // Docker's default seccomp profile applies because no seccomp option is ever passed.
    ...(spec.lsm === 'apparmor' ? ['--security-opt=apparmor=docker-default'] : []),
    `--user=${user.uid}:${user.gid}`,
    `--workdir=${WORKSPACE_MOUNT}`,
    `--memory=${limits.memoryBytes}`,
    `--memory-swap=${limits.memoryBytes}`,
    `--cpus=${limits.cpuCount}`,
    `--pids-limit=${limits.pids}`,
    `--stop-timeout=${limits.stopGraceMs / 1_000}`,
    '--network=bridge',
    // Raw output is read only through the attach stream; the daemon keeps no log copy.
    '--log-driver=none',
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${TMPFS_BYTES}`,
    `--tmpfs=${CONTAINER_HOME}:rw,exec,nosuid,nodev,size=${TMPFS_BYTES}`,
    `--mount=type=bind,source=${spec.workspacePath},target=${WORKSPACE_MOUNT},bind-propagation=rprivate`,
    `--mount=type=bind,source=${spec.taskDocumentPath},target=${TASK_DOCUMENT_MOUNT},readonly,bind-propagation=rprivate`,
    `--env=HOME=${CONTAINER_HOME}`,
    ...environment.map(([key, value]) => `--env=${key}=${value}`),
    `--entrypoint=${entrypoint}`,
    profile.imageReference,
    ...args,
  ])
}

// ---------------------------------------------------------------------------------------
// Capability preflight
// ---------------------------------------------------------------------------------------

export interface DockerCapabilities {
  readonly supported: boolean
  /** Missing required capabilities, for example `seccomp`; never daemon output. */
  readonly missing: readonly string[]
  readonly isolation: IsolationObservation
}

/** Evaluates `docker info` JSON against the required isolation and resource controls. */
export function evaluateCapabilities(info: unknown): DockerCapabilities {
  const unsupported = (missing: string[]): DockerCapabilities =>
    Object.freeze({ supported: false, missing: Object.freeze(missing), isolation: Object.freeze({ rootless: false, lsm: null }) })
  if (typeof info !== 'object' || info === null || Array.isArray(info)) return unsupported(['daemon'])
  const record = info as Record<string, unknown>
  const options = record.SecurityOptions
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) return unsupported(['daemon'])
  const names = options.map((option) => {
    const fields = Object.fromEntries(
      option.split(',').map((field) => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)] as const),
    )
    return { name: fields.name ?? '', profile: fields.profile ?? null }
  })
  const seccomp = names.find((option) => option.name === 'seccomp')
  const missing: string[] = []
  if (record.OSType !== 'linux') missing.push('linux')
  if (seccomp === undefined || seccomp.profile === 'unconfined') missing.push('seccomp')
  if (record.MemoryLimit !== true) missing.push('memory')
  if (record.SwapLimit !== true) missing.push('swap')
  if (record.PidsLimit !== true) missing.push('pids')
  if (record.CpuCfsQuota !== true) missing.push('cpu')
  const has = (name: string): boolean => names.some((option) => option.name === name)
  const rootless = has('rootless')
  // The controller-owned clone appears as container root through a rootless daemon's user
  // namespace. Reusing the controller's numeric UID therefore selects a subordinate host UID,
  // which cannot write the bind mount. Fail closed until workspace ownership and the daemon's
  // UID/GID mapping can be resolved together without running the agent as container root.
  if (rootless) missing.push('rootless-user-mapping')
  const lsm: LsmKind | null = has('apparmor') ? 'apparmor' : has('selinux') ? 'selinux' : null
  return Object.freeze({
    supported: missing.length === 0,
    missing: Object.freeze(missing),
    isolation: Object.freeze({ rootless, lsm }),
  })
}

// ---------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------

export interface ContainerState {
  readonly running: boolean
  readonly exitCode: number | null
  readonly oomKilled: boolean
  /** False when the container never started its process. */
  readonly started: boolean
  /** True when the runtime reported an error starting the container. */
  readonly startError: boolean
}

export interface AttachOutput {
  onStdout(chunk: Buffer): void
  onStderr(chunk: Buffer): void
}

export interface AttachedContainer {
  /** Resolves when the attached CLI process exits; `code` mirrors the container exit when known. */
  readonly exited: Promise<{ readonly code: number | null }>
  /** Kills the attached CLI client; the container itself is unaffected. */
  kill(): void
}

export interface DockerCommandRunner {
  run(args: readonly string[], options: { readonly timeoutMs: number }): Promise<{ readonly code: number | null; readonly stdout: string }>
  attach(args: readonly string[], output: AttachOutput): AttachedContainer
}

export interface DockerAdapter {
  preflight(): Promise<DockerCapabilities>
  /** Creates the session container and returns its exact full ID. */
  create(spec: ContainerSpec): Promise<string>
  start(id: string, output: AttachOutput): AttachedContainer
  /** Graceful stop: SIGTERM, then SIGKILL after `graceSeconds`. */
  stop(id: string, graceSeconds: number): Promise<void>
  /** Null when no container with this exact ID exists. */
  inspect(id: string): Promise<ContainerState | null>
  exists(id: string): Promise<boolean>
  /** The exact ID of a container with this FlowProof-generated name, if one exists. */
  findByName(name: string): Promise<string | null>
  /** `docker container rm --force` for one exact ID. */
  remove(id: string): Promise<void>
}

/** The allowlisted host variables the Docker CLI may need; never forwarded into a container. */
export function dockerCliEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = { LC_ALL: 'C' }
  for (const key of DOCKER_CLI_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

/** Runs the Docker CLI directly, without a shell, with bounded time and output. */
export function createDockerCommandRunner(options: { readonly executable?: string; readonly environment?: Record<string, string> } = {}): DockerCommandRunner {
  const executable = options.executable ?? 'docker'
  const env = options.environment ?? dockerCliEnvironment()
  return Object.freeze({
    run(args: readonly string[], { timeoutMs }: { readonly timeoutMs: number }) {
      return new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve) => {
        execFile(
          executable,
          [...args],
          { encoding: 'utf8', env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
          (error, stdout) => {
            if (error === null) resolve({ code: 0, stdout })
            else resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: '' })
          },
        )
      })
    },
    attach(args: readonly string[], output: AttachOutput): AttachedContainer {
      const child = spawn(executable, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      child.stdout.on('data', (chunk: Buffer) => output.onStdout(chunk))
      child.stderr.on('data', (chunk: Buffer) => output.onStderr(chunk))
      const exited = new Promise<{ readonly code: number | null }>((resolve) => {
        child.once('error', () => resolve({ code: null }))
        child.once('close', (code) => resolve({ code }))
      })
      return Object.freeze({
        exited,
        kill: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        },
      })
    },
  })
}

const exactId = (id: string): string => {
  if (typeof id !== 'string' || !CONTAINER_ID_PATTERN.test(id)) throw invalidSpec('containerId')
  return id
}

/** The Docker adapter used by editing sessions; tests may inject a command runner. */
export function createDockerCli(options: { readonly runner?: DockerCommandRunner } = {}): DockerAdapter {
  const runner = options.runner ?? createDockerCommandRunner()
  const run = (args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) => runner.run(args, { timeoutMs })

  const listIds = async (filter: string): Promise<string[]> => {
    const { code, stdout } = await run(['container', 'ls', '--all', '--no-trunc', '--quiet', `--filter=${filter}`])
    if (code !== 0) throw new DockerError('DOCKER_INSPECT_FAILED', 'Containers could not be listed.')
    return stdout.split('\n').filter((line) => CONTAINER_ID_PATTERN.test(line))
  }

  const exists = async (id: string): Promise<boolean> => {
    const exact = exactId(id)
    return (await listIds(`id=${exact}`)).includes(exact)
  }

  return Object.freeze({
    async preflight(): Promise<DockerCapabilities> {
      const { code, stdout } = await run(['info', '--format', '{{json .}}'])
      if (code !== 0) return evaluateCapabilities(null)
      try {
        return evaluateCapabilities(JSON.parse(stdout) as unknown)
      } catch {
        return evaluateCapabilities(null)
      }
    },

    async create(spec: ContainerSpec): Promise<string> {
      const args = buildCreateArgs(spec)
      const { code, stdout } = await run(args)
      const id = stdout.trim()
      if (code !== 0 || !CONTAINER_ID_PATTERN.test(id)) throw new DockerError('DOCKER_CREATE_FAILED', 'The session container could not be created.')
      return id
    },

    start(id: string, output: AttachOutput): AttachedContainer {
      return runner.attach(['container', 'start', '--attach', exactId(id)], output)
    },

    async stop(id: string, graceSeconds: number): Promise<void> {
      const exact = exactId(id)
      if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 1) throw invalidSpec('graceSeconds')
      const { code } = await run(['container', 'stop', `--timeout=${graceSeconds}`, exact], graceSeconds * 1_000 + STOP_MARGIN_MS)
      if (code !== 0) throw new DockerError('DOCKER_STOP_FAILED', 'The session container could not be stopped.')
    },

    async inspect(id: string): Promise<ContainerState | null> {
      const exact = exactId(id)
      if (!(await exists(exact))) return null
      const { code, stdout } = await run(['container', 'inspect', '--format', '{{json .State}}', exact])
      if (code !== 0) throw new DockerError('DOCKER_INSPECT_FAILED', 'The session container could not be inspected.')
      let state: Record<string, unknown>
      try {
        state = JSON.parse(stdout) as Record<string, unknown>
      } catch {
        throw new DockerError('DOCKER_INSPECT_FAILED', 'The session container state is unreadable.')
      }
      const startedAt = typeof state.StartedAt === 'string' ? state.StartedAt : ''
      return Object.freeze({
        running: state.Running === true,
        exitCode: Number.isSafeInteger(state.ExitCode) ? (state.ExitCode as number) : null,
        oomKilled: state.OOMKilled === true,
        started: startedAt !== '' && !startedAt.startsWith('0001-'),
        startError: typeof state.Error === 'string' && state.Error !== '',
      })
    },

    exists,

    async findByName(name: string): Promise<string | null> {
      if (typeof name !== 'string' || !name.startsWith(CONTAINER_NAME_PREFIX) || !UUID_PATTERN.test(name.slice(CONTAINER_NAME_PREFIX.length))) {
        throw invalidSpec('name')
      }
      return (await listIds(`name=^/?${name}$`))[0] ?? null
    },

    async remove(id: string): Promise<void> {
      const { code } = await run(['container', 'rm', '--force', exactId(id)])
      if (code !== 0) throw new DockerError('DOCKER_REMOVE_FAILED', 'The session container could not be removed.')
    },
  })
}
