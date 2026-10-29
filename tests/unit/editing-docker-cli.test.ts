import { describe, expect, it } from 'vitest'

import { V1_LIMIT_BOUNDS, resolveSessionLimits } from '../../packages/flowproof/src/editing/contracts.js'
import type { SessionLimits } from '../../packages/flowproof/src/editing/contracts.js'
import {
  CONTAINER_HOME,
  DockerError,
  EDITING_SESSION_LABEL,
  TMPFS_BYTES,
  buildCreateArgs,
  containerName,
  createDockerCli,
  evaluateCapabilities,
} from '../../packages/flowproof/src/editing/dockerCli.js'
import type { AttachOutput, ContainerSpec, DockerCommandRunner } from '../../packages/flowproof/src/editing/dockerCli.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'

// T010: the shell-free Docker CLI adapter. Container creation argv is generated only from a
// registered profile, validated resolved limits, and FlowProof-created paths, so no caller value
// can add a flag, mount, network, port, or shell. Capability preflight refuses daemons that cannot
// enforce the policy and records rootless and LSM observations without inventing them.

const SESSION_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
const IMAGE_ID = `sha256:${'f'.repeat(64)}`
const CONTAINER_ID = 'c'.repeat(64)
const WORKSPACE = '/tmp/flowproof-editing-AbC123/workspace'
const TASK_DOCUMENT = '/tmp/flowproof-editing-AbC123/task.json'

const profile = createRuntimeProfileRegistry([
  {
    id: 'fixture-editing-agent',
    imageReference: IMAGE_ID,
    argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
    environment: { FLOWPROOF_FIXTURE: '1', NODE_OPTIONS: '--max-old-space-size=256' },
    workingDirectory: '/workspace',
  },
]).resolve('fixture-editing-agent')

const spec = (overrides: Record<string, unknown> = {}): ContainerSpec =>
  ({
    sessionId: SESSION_ID,
    profile,
    limits: resolveSessionLimits({}),
    user: { uid: 1000, gid: 1000 },
    workspacePath: WORKSPACE,
    taskDocumentPath: TASK_DOCUMENT,
    lsm: 'apparmor',
    ...overrides,
  }) as ContainerSpec

function expectDockerError(action: () => unknown, code: string): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(DockerError)
  expect((caught as DockerError).code).toBe(code)
}

const limitArgs = (limits: SessionLimits): string[] => [
  `--memory=${limits.memoryBytes}`,
  `--memory-swap=${limits.memoryBytes}`,
  `--cpus=${limits.cpuCount}`,
  `--pids-limit=${limits.pids}`,
  `--stop-timeout=${limits.stopGraceMs / 1_000}`,
]

describe('docker create argv', () => {
  it('generates the exact policy argv for the resolved defaults', () => {
    expect(containerName(SESSION_ID)).toBe(`flowproof-editing-${SESSION_ID}`)
    expect(buildCreateArgs(spec())).toEqual([
      'container',
      'create',
      '--pull=never',
      `--name=flowproof-editing-${SESSION_ID}`,
      `--label=${EDITING_SESSION_LABEL}=${SESSION_ID}`,
      '--init',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--security-opt=apparmor=docker-default',
      '--user=1000:1000',
      '--workdir=/workspace',
      '--memory=1073741824',
      '--memory-swap=1073741824',
      '--cpus=1',
      '--pids-limit=256',
      '--stop-timeout=5',
      '--network=bridge',
      '--log-driver=none',
      `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${TMPFS_BYTES}`,
      `--tmpfs=${CONTAINER_HOME}:rw,exec,nosuid,nodev,size=${TMPFS_BYTES}`,
      `--mount=type=bind,source=${WORKSPACE},target=/workspace,bind-propagation=rprivate`,
      `--mount=type=bind,source=${TASK_DOCUMENT},target=/run/flowproof/task.json,readonly,bind-propagation=rprivate`,
      `--env=HOME=${CONTAINER_HOME}`,
      '--env=FLOWPROOF_FIXTURE=1',
      '--env=NODE_OPTIONS=--max-old-space-size=256',
      '--entrypoint=node',
      IMAGE_ID,
      '/opt/flowproof-agent/agent.mjs',
      '/run/flowproof/task.json',
    ])
  })

  it.each([
    ['minimum', Object.fromEntries(Object.entries(V1_LIMIT_BOUNDS).map(([field, bounds]) => [field, bounds.min]))],
    ['maximum', Object.fromEntries(Object.entries(V1_LIMIT_BOUNDS).map(([field, bounds]) => [field, bounds.max]))],
  ])('maps the exact %s limits, with memory-plus-swap equal to memory', (_label, requested) => {
    const limits = resolveSessionLimits(requested)
    const args = buildCreateArgs(spec({ limits }))
    for (const expected of limitArgs(limits)) expect(args).toContain(expected)
    const memory = args.find((arg) => arg.startsWith('--memory='))?.split('=')[1]
    expect(args.find((arg) => arg.startsWith('--memory-swap='))?.split('=')[1]).toBe(memory)
  })

  it('keeps every isolation restriction and never weakens the default seccomp profile', () => {
    const args = buildCreateArgs(spec({ lsm: null }))
    for (const required of ['--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=bridge']) {
      expect(args).toContain(required)
    }
    expect(args.join(' ')).not.toMatch(/seccomp|unconfined|apparmor|--privileged|--cap-add|--device|--publish|-p=|--expose|--volume|-v=|docker\.sock|--ipc=host|--pid=host|--userns=host/)
    expect(args.filter((arg) => arg.startsWith('--network'))).toEqual(['--network=bridge'])
    expect(args.filter((arg) => arg.startsWith('--mount'))).toHaveLength(2)
    expect(args.filter((arg) => arg.startsWith('--tmpfs'))).toHaveLength(2)
    // Only the FlowProof-generated session label exists.
    expect(args.filter((arg) => arg.startsWith('--label'))).toEqual([`--label=${EDITING_SESSION_LABEL}=${SESSION_ID}`])
  })

  it('records an SELinux daemon without inventing an AppArmor option', () => {
    expect(buildCreateArgs(spec({ lsm: 'selinux' })).filter((arg) => arg.includes('apparmor'))).toEqual([])
  })

  it.each([
    ['root', { uid: 0, gid: 1000 }],
    ['the root group', { uid: 1000, gid: 0 }],
    ['a fractional UID', { uid: 1000.5, gid: 1000 }],
    ['a negative UID', { uid: -1, gid: 1000 }],
    ['a string UID', { uid: '1000', gid: 1000 }],
  ])('rejects %s as the container user', (_label, user) => {
    expectDockerError(() => buildCreateArgs(spec({ user })), 'DOCKER_SPEC_INVALID')
  })

  it.each([
    ['a mutable image tag', { profile: { ...profile, imageReference: 'node:latest' } }],
    ['an implicit latest image', { profile: { ...profile, imageReference: 'node' } }],
    ['an empty argv', { profile: { ...profile, argv: [] } }],
    ['an extra Docker flag', { extraArgs: ['--privileged'] }],
    ['an extra mount', { mounts: [{ source: '/', target: '/host' }] }],
    ['a network choice', { network: 'host' }],
    ['published ports', { ports: ['8080:80'] }],
    ['a mount-option injection in the workspace path', { workspacePath: '/tmp/x,target=/etc,readonly=false' }],
    ['a relative workspace path', { workspacePath: 'workspace' }],
    ['a traversal workspace path', { workspacePath: '/tmp/flowproof/../../home/user' }],
    ['a task document path with an equals sign', { taskDocumentPath: '/tmp/x/task.json,source=/etc/shadow' }],
    ['the same path for the workspace and task document', { taskDocumentPath: WORKSPACE }],
    ['a non-UUID session ID', { sessionId: 'x --privileged' }],
    ['an unresolved limit object', { limits: { wallClockMs: 1_000 } }],
    ['an out-of-range limit', { limits: { ...resolveSessionLimits({}), pids: 100_000 } }],
    ['a non-whole-second stop grace', { limits: { ...resolveSessionLimits({}), stopGraceMs: 1_500 } }],
    ['an unknown LSM', { lsm: 'unconfined' }],
    ['a secret environment entry', { profile: { ...profile, environment: { MODEL_API_KEY: 'sk-abcdefghijklmnopqrstuvwx' } } }],
    ['a multi-line environment value', { profile: { ...profile, environment: { FLOWPROOF_NOTE: 'a\n--privileged' } } }],
    ['a working directory other than /workspace', { profile: { ...profile, workingDirectory: '/' } }],
  ])('rejects %s before running Docker', (_label, overrides) => {
    expectDockerError(() => buildCreateArgs(spec(overrides)), 'DOCKER_SPEC_INVALID')
  })
})

// The JSON keys `docker info --format '{{json .}}'` emits on Docker Engine 29.
const DOCKER_INFO = {
  OSType: 'linux',
  MemoryLimit: true,
  SwapLimit: true,
  PidsLimit: true,
  CpuCfsQuota: true,
  SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'],
}

describe('capability preflight', () => {
  it('accepts a rootful AppArmor daemon and records it truthfully', () => {
    expect(evaluateCapabilities(DOCKER_INFO)).toEqual({ supported: true, missing: [], isolation: { rootless: false, lsm: 'apparmor' } })
  })

  it('records rootless and SELinux only when the daemon reports them', () => {
    const info = { ...DOCKER_INFO, SecurityOptions: ['name=seccomp,profile=default', 'name=rootless', 'name=selinux'] }
    expect(evaluateCapabilities(info)).toEqual({ supported: true, missing: [], isolation: { rootless: true, lsm: 'selinux' } })
  })

  it('treats a missing LSM as an observation, not a blocker', () => {
    const info = { ...DOCKER_INFO, SecurityOptions: ['name=seccomp,profile=builtin'] }
    expect(evaluateCapabilities(info)).toEqual({ supported: true, missing: [], isolation: { rootless: false, lsm: null } })
  })

  it.each([
    ['no seccomp', { SecurityOptions: ['name=apparmor'] }, 'seccomp'],
    ['an unconfined seccomp default', { SecurityOptions: ['name=seccomp,profile=unconfined'] }, 'seccomp'],
    ['no memory limit', { MemoryLimit: false }, 'memory'],
    ['no swap limit', { SwapLimit: false }, 'swap'],
    ['no PID limit', { PidsLimit: false }, 'pids'],
    ['no CPU quota', { CpuCfsQuota: false }, 'cpu'],
    ['a Windows daemon', { OSType: 'windows' }, 'linux'],
  ])('refuses a daemon with %s', (_label, overrides, missing) => {
    const result = evaluateCapabilities({ ...DOCKER_INFO, ...overrides })
    expect(result.supported).toBe(false)
    expect(result.missing).toContain(missing)
  })

  it.each([null, 'docker info', [], { SecurityOptions: 'name=seccomp' }])('refuses malformed daemon information %#', (info) => {
    expect(evaluateCapabilities(info).supported).toBe(false)
  })
})

interface RecordedCall {
  readonly args: readonly string[]
  readonly timeoutMs: number
}

function fakeRunner(reply: (args: readonly string[]) => { code: number | null; stdout: string }): DockerCommandRunner & {
  readonly calls: RecordedCall[]
  readonly attached: (readonly string[])[]
} {
  const calls: RecordedCall[] = []
  const attached: (readonly string[])[] = []
  return {
    calls,
    attached,
    async run(args, options) {
      calls.push({ args: [...args], timeoutMs: options.timeoutMs })
      return reply(args)
    },
    attach(args: readonly string[], output: AttachOutput) {
      attached.push([...args])
      output.onStdout(Buffer.from('out'))
      return { exited: Promise.resolve({ code: 0 }), kill: () => undefined }
    },
  }
}

describe('docker operations', () => {
  it('runs preflight through docker info JSON', async () => {
    const runner = fakeRunner(() => ({ code: 0, stdout: JSON.stringify(DOCKER_INFO) }))
    const docker = createDockerCli({ runner })

    await expect(docker.preflight()).resolves.toMatchObject({ supported: true })
    expect(runner.calls[0]?.args).toEqual(['info', '--format', '{{json .}}'])
  })

  it('reports an unreachable daemon as unsupported without its error text', async () => {
    const docker = createDockerCli({ runner: fakeRunner(() => ({ code: 1, stdout: 'Cannot connect to /var/run/docker.sock' })) })
    const result = await docker.preflight()
    expect(result.supported).toBe(false)
    expect(JSON.stringify(result)).not.toContain('docker.sock')
  })

  it('creates with the generated argv and returns the exact full container ID', async () => {
    const runner = fakeRunner(() => ({ code: 0, stdout: `${CONTAINER_ID}\n` }))
    const docker = createDockerCli({ runner })

    await expect(docker.create(spec())).resolves.toBe(CONTAINER_ID)
    expect(runner.calls[0]?.args).toEqual(buildCreateArgs(spec()))
  })

  it('maps a failed or malformed create to a coded error', async () => {
    await expect(createDockerCli({ runner: fakeRunner(() => ({ code: 125, stdout: '' })) }).create(spec())).rejects.toMatchObject({
      code: 'DOCKER_CREATE_FAILED',
    })
    await expect(createDockerCli({ runner: fakeRunner(() => ({ code: 0, stdout: 'abc\n' })) }).create(spec())).rejects.toMatchObject({
      code: 'DOCKER_CREATE_FAILED',
    })
  })

  it('attaches, stops, inspects, and removes by exact container ID only', async () => {
    const runner = fakeRunner((args) => {
      if (args[1] === 'ls') return { code: 0, stdout: `${CONTAINER_ID}\n` }
      if (args[1] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 143, OOMKilled: false, Error: '', StartedAt: '2026-10-29T00:00:00Z' }),
        }
      }
      return { code: 0, stdout: '' }
    })
    const docker = createDockerCli({ runner })
    const chunks: string[] = []

    const attached = docker.start(CONTAINER_ID, { onStdout: (chunk) => chunks.push(chunk.toString()), onStderr: () => undefined })
    await expect(attached.exited).resolves.toEqual({ code: 0 })
    await docker.stop(CONTAINER_ID, 7)
    await expect(docker.inspect(CONTAINER_ID)).resolves.toEqual({ running: false, exitCode: 143, oomKilled: false, started: true, startError: false })
    await docker.remove(CONTAINER_ID)
    await expect(docker.exists(CONTAINER_ID)).resolves.toBe(true)

    expect(chunks).toEqual(['out'])
    expect(runner.attached).toEqual([['container', 'start', '--attach', CONTAINER_ID]])
    const commands = runner.calls.map((call) => call.args)
    expect(commands).toContainEqual(['container', 'stop', '--timeout=7', CONTAINER_ID])
    expect(commands).toContainEqual(['container', 'inspect', '--format', '{{json .State}}', CONTAINER_ID])
    expect(commands).toContainEqual(['container', 'rm', '--force', CONTAINER_ID])
    expect(commands).toContainEqual(['container', 'ls', '--all', '--no-trunc', '--quiet', `--filter=id=${CONTAINER_ID}`])
    // The bounded stop call allows the grace period plus a margin.
    expect(runner.calls.find((call) => call.args[1] === 'stop')?.timeoutMs).toBeGreaterThan(7_000)
    // Nothing broad: no prune, no label- or name-wide removal.
    for (const args of commands) expect(args.join(' ')).not.toMatch(/prune|--filter=label|rm .*--filter/)
  })

  it('finds an orphaned container only by its exact generated name', async () => {
    const runner = fakeRunner(() => ({ code: 0, stdout: `${CONTAINER_ID}\n` }))
    const docker = createDockerCli({ runner })

    await expect(docker.findByName(containerName(SESSION_ID))).resolves.toBe(CONTAINER_ID)
    expect(runner.calls[0]?.args).toEqual([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--quiet',
      `--filter=name=^/?flowproof-editing-${SESSION_ID}$`,
    ])
    await expect(docker.findByName('other-container')).rejects.toMatchObject({ code: 'DOCKER_SPEC_INVALID' })
  })

  it('reports a missing container as null and a never-started container as a start error', async () => {
    const missing = createDockerCli({ runner: fakeRunner(() => ({ code: 0, stdout: '' })) })
    await expect(missing.inspect(CONTAINER_ID)).resolves.toBeNull()
    await expect(missing.exists(CONTAINER_ID)).resolves.toBe(false)

    const neverStarted = createDockerCli({
      runner: fakeRunner((args) =>
        args[1] === 'ls'
          ? { code: 0, stdout: `${CONTAINER_ID}\n` }
          : {
              code: 0,
              stdout: JSON.stringify({ Status: 'created', Running: false, ExitCode: 127, OOMKilled: false, Error: 'exec failed', StartedAt: '0001-01-01T00:00:00Z' }),
            },
      ),
    })
    await expect(neverStarted.inspect(CONTAINER_ID)).resolves.toMatchObject({ started: false, startError: true })
  })

  it.each(['abc', `${CONTAINER_ID}0`, `--force ${CONTAINER_ID}`, CONTAINER_ID.toUpperCase()])('rejects the non-exact container ID %s', async (id) => {
    const runner = fakeRunner(() => ({ code: 0, stdout: '' }))
    const docker = createDockerCli({ runner })
    for (const operation of [() => docker.stop(id, 5), () => docker.inspect(id), () => docker.remove(id), () => docker.exists(id)]) {
      await expect(operation()).rejects.toMatchObject({ code: 'DOCKER_SPEC_INVALID' })
    }
    expect(() => docker.start(id, { onStdout: () => undefined, onStderr: () => undefined })).toThrow(DockerError)
    expect(runner.calls).toEqual([])
  })

  it('maps a failed removal to a coded error', async () => {
    const docker = createDockerCli({ runner: fakeRunner(() => ({ code: 1, stdout: '' })) })
    await expect(docker.remove(CONTAINER_ID)).rejects.toMatchObject({ code: 'DOCKER_REMOVE_FAILED' })
  })
})
