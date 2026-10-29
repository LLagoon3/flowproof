import { describe, expect, it } from 'vitest'

import { parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import { LIFECYCLE_TRANSITIONS, LifecycleError, createSessionLifecycle, startEditingSession } from '../../packages/flowproof/src/editing/session.js'
import type { LifecyclePhase } from '../../packages/flowproof/src/editing/session.js'
import type { SessionWorkspace } from '../../packages/flowproof/src/editing/workspace.js'
import { fakeDocker, fakeProfiles, fakeRequest, fakeWorkspace, tick } from '../support/editingFakes.js'

// T017/T019 (US2): the lifecycle state machine, first-terminal-cause selection, idempotent
// cancellation and finalization, and cleanup that preserves the execution outcome while naming
// every remaining owned resource. Fake adapters make every race deterministic.

const profiles = fakeProfiles()
const request = fakeRequest

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

// T024 (US3): fixed-size capture and sanitized diagnostics. Output is untrusted: it is kept in a
// bounded tail per stream, cut only at line boundaries, stripped of host paths, and sanitized
// before it can reach the result.

describe('bounded sanitized diagnostics', () => {
  async function diagnosticFor(options: Parameters<typeof fakeDocker>[0], overrides: Record<string, unknown> = {}): Promise<string> {
    const result = await start(fakeDocker({ exitImmediately: 0, ...options }), fakeWorkspace(), overrides).result
    expectValid(result)
    return result.diagnostic
  }

  it('keeps a fixed-size tail of stdout and stderr cut at line boundaries', async () => {
    const lines = (stream: string): string =>
      Array.from({ length: 5_000 }, (_, index) => `${stream} line ${String(index).padStart(5, '0')} ${'q'.repeat(30)}\n`).join('')
    const diagnostic = await diagnosticFor({ stdout: [lines('out'), 'out final marker\n'], stderr: [lines('err'), 'err final marker\n'] }, { limits: { diagnosticBytes: 8_192 } })

    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(8_192)
    expect(diagnostic).toContain('out final marker')
    expect(diagnostic).toContain('err final marker')
    expect(diagnostic).not.toContain('line 00000')
    // Every retained output line is complete; the cut never leaves a fragment.
    for (const line of diagnostic.split('\n').filter((entry) => /^(out|err) line/.test(entry))) {
      expect(line).toMatch(/^(out|err) line \d{5} q{30}$/)
    }
  })

  it('never leaves a fragment of a secret that straddles the retained tail start', async () => {
    const line = `${'x'.repeat(57)} api_key=fpseededtailsecret000001\n`
    const output = Array.from({ length: 3_000 }, () => line)
    // Odd chunk sizes move the cut to arbitrary byte offsets inside the secret.
    const chunks = output.join('').match(/[\s\S]{1,997}/g) ?? []
    const diagnostic = await diagnosticFor({ stdout: chunks }, { limits: { diagnosticBytes: 4_096 } })

    expect(diagnostic).not.toMatch(/secret0000|tailsecret|seededtail|000001/)
    expect(diagnostic).toContain('api_key=[REDACTED]')
  })

  it('drops a private-key body whose BEGIN line fell outside the retained tail', async () => {
    const body = Array.from({ length: 400 }, (_, index) => `FPSEEDEDKEYBODY${String(index).padStart(4, '0')}abcdefghijklmnopqrstuvwxyz`).join('\n')
    const diagnostic = await diagnosticFor(
      { stdout: [`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, 'after the key\n'] },
      { limits: { diagnosticBytes: 4_096 } },
    )

    expect(diagnostic).not.toContain('FPSEEDEDKEYBODY')
    expect(diagnostic).toContain('after the key')
  })

  it.each([
    ['a provider key', 'MODEL_API_KEY=sk-fpseededproviderkey00000001', 'fpseededproviderkey'],
    ['a bearer token', 'Authorization: Bearer FPSEEDEDBEARER0000000001', 'FPSEEDEDBEARER'],
    ['a GitHub token', 'pushing with ghp_FPSEEDEDGITHUB000000000000001', 'FPSEEDEDGITHUB'],
    ['an AWS key', 'aws AKIAFPSEEDEDAWS00001 configured', 'AKIAFPSEEDEDAWS00001'],
    ['a quoted password', ['pass', 'word: "', 'FPSEEDED', 'PASSWORD0001"'].join(''), 'FPSEEDEDPASSWORD'],
    ['an exported token', 'export GITHUB_TOKEN=FPSEEDEDEXPORTED0001', 'FPSEEDEDEXPORTED'],
    ['a database password assignment', ['DB_', 'PASSWORD=', 'FPSEEDED', 'DBPASS0001 psql'].join(''), 'FPSEEDEDDBPASS'],
    ['URL credentials', 'cloning https://fpuser:FPSEEDEDURLPASS01@git.example.com/repo.git', 'FPSEEDEDURLPASS01'],
    ['a URL query secret', 'GET https://api.example.com/v1/items?token=FPSEEDEDQUERY01&x=1', 'FPSEEDEDQUERY01'],
  ])('redacts %s from either stream', async (_label, line, secret) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const diagnostic = await diagnosticFor({ [stream]: [`before\n${line}\nafter\n`] })
      expect(diagnostic).not.toContain(secret)
      expect(diagnostic).toContain('after')
    }
  })

  it('replaces absolute session and source paths with stable placeholders', async () => {
    const diagnostic = await diagnosticFor({
      stdout: [
        'cwd /tmp/flowproof-editing-Fake01/workspace/src\n',
        'mount root /flowproof-editing-Fake01/workspace\n',
        'origin /srv/projects/example/.git\n',
      ],
    })

    expect(diagnostic).not.toContain('/tmp/flowproof-editing-Fake01')
    expect(diagnostic).not.toContain('flowproof-editing-Fake01')
    expect(diagnostic).not.toContain('/srv/projects/example')
    expect(diagnostic).toContain('cwd <session-root>/workspace/src')
    expect(diagnostic).toContain('origin <source-repository>/.git')
  })

  it('uses stable coded messages for Docker and Git failures instead of their output', async () => {
    const created = await start(fakeDocker({ createFails: true }), fakeWorkspace()).result
    expect(created.diagnostic).toBe('startup_failed: the session container could not be created.')

    const resolved = await start(fakeDocker(), fakeWorkspace({ resolveFails: 'REVISION_UNAVAILABLE' })).result
    expect(resolved.diagnostic).toBe('startup_failed: the selected revision is not a commit in the repository.')
  })

  it('includes a bounded, sanitized cancellation reason', async () => {
    const docker = fakeDocker()
    const handle = start(docker, fakeWorkspace())
    await docker.started

    await handle.cancel(`stop now\nplease token=FPSEEDEDREASON0001 in /srv/projects/example ${'r'.repeat(1_000)}`)
    const { diagnostic } = await handle.result

    const summary = diagnostic.split('\n')[0] ?? ''
    expect(summary).toMatch(/^cancelled: /)
    expect(summary).toContain('stop now please')
    expect(summary.length).toBeLessThanOrEqual(400)
    expect(diagnostic).not.toContain('FPSEEDEDREASON0001')
    expect(diagnostic).not.toContain('/srv/projects/example')
  })
})
