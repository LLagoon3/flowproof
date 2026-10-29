import { describe, expect, it } from 'vitest'

import {
  CLEANUP_STATUSES,
  CLEANUP_RESULT_FIELDS,
  EDITING_SESSION_RESULT_FIELDS,
  EXECUTION_OUTCOMES,
  EditingSessionError,
  LIMIT_FIELDS,
  MAX_DECLARED_COMMANDS,
  MAX_DECLARED_COMMAND_BYTES,
  MAX_TASK_BYTES,
  OWNED_RESOURCE_CATEGORIES,
  V1_LIMIT_BOUNDS,
  createTaskDocument,
  parseEditingSessionRequest,
  parseEditingSessionResult,
  resolveSessionLimits,
  validateLimitBounds,
} from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionResult, LimitField } from '../../packages/flowproof/src/editing/contracts.js'

// T004: the in-process editing-session request, limit, runtime-profile bound, and result
// contract of specs/002-agentic-sandbox-editing/contracts/editing-session.md. Validation is pure
// and synchronous, so every rejection here happens before any clone, task document, container,
// or persistent artifact can exist.

const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const REVISION = 'b'.repeat(40)

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repositoryRoot: '/srv/projects/example',
  revision: REVISION,
  task: 'Fix the failing greeting test.',
  runtimeProfileId: 'fixture-editing-agent',
  declaredProjectCommands: ['node scripts/check.mjs'],
  ...overrides,
})

function expectCode(action: () => unknown, code: string): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(EditingSessionError)
  expect((caught as EditingSessionError).code).toBe(code)
}

const DEFAULTS = {
  wallClockMs: 120_000,
  stopGraceMs: 5_000,
  memoryBytes: 1_073_741_824,
  cpuCount: 1,
  pids: 256,
  diagnosticBytes: 65_536,
} as const

const MINIMA = { wallClockMs: 1_000, stopGraceMs: 1_000, memoryBytes: 268_435_456, cpuCount: 0.25, pids: 32, diagnosticBytes: 4_096 } as const
const MAXIMA = {
  wallClockMs: 900_000,
  stopGraceMs: 30_000,
  memoryBytes: 4_294_967_296,
  cpuCount: 4,
  pids: 1_024,
  diagnosticBytes: 1_048_576,
} as const

describe('session limits', () => {
  it('publishes the exact v1 bounds', () => {
    expect([...LIMIT_FIELDS]).toEqual(['wallClockMs', 'stopGraceMs', 'memoryBytes', 'cpuCount', 'pids', 'diagnosticBytes'])
    for (const field of LIMIT_FIELDS) {
      expect(V1_LIMIT_BOUNDS[field]).toEqual({ min: MINIMA[field], default: DEFAULTS[field], max: MAXIMA[field] })
    }
    expect(Object.isFrozen(V1_LIMIT_BOUNDS)).toBe(true)
  })

  it('resolves every omitted field to its documented default', () => {
    expect(resolveSessionLimits(undefined)).toEqual(DEFAULTS)
    expect(resolveSessionLimits({})).toEqual(DEFAULTS)
    for (const field of LIMIT_FIELDS) {
      const only = resolveSessionLimits({ [field]: MINIMA[field] })
      expect(only).toEqual({ ...DEFAULTS, [field]: MINIMA[field] })
    }
    expect(Object.isFrozen(resolveSessionLimits({}))).toBe(true)
  })

  it('accepts the exact minima and maxima', () => {
    expect(resolveSessionLimits(MINIMA)).toEqual(MINIMA)
    expect(resolveSessionLimits(MAXIMA)).toEqual(MAXIMA)
    expect(resolveSessionLimits({ cpuCount: 2.5 }).cpuCount).toBe(2.5)
  })

  const invalid: Array<[string, LimitField, unknown]> = [
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['below the minimum', field, MINIMA[field] - (field === 'cpuCount' ? 0.01 : 1)]),
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['above the maximum', field, MAXIMA[field] + (field === 'cpuCount' ? 0.01 : 1)]),
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['NaN', field, Number.NaN]),
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['Infinity', field, Number.POSITIVE_INFINITY]),
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['a numeric string', field, String(DEFAULTS[field])]),
    ...LIMIT_FIELDS.map((field): [string, LimitField, unknown] => ['null', field, null]),
    ...LIMIT_FIELDS.filter((field) => field !== 'cpuCount').map((field): [string, LimitField, unknown] => [
      'a fractional integer field',
      field,
      DEFAULTS[field] + 0.5,
    ]),
    ['a non-whole-second stop grace', 'stopGraceMs', 1_500],
  ]

  it.each(invalid)('rejects %s for %s', (_label, field, value) => {
    expectCode(() => resolveSessionLimits({ [field]: value }), 'EDITING_LIMITS_INVALID')
  })

  it('rejects unknown limit fields', () => {
    expectCode(() => resolveSessionLimits({ diskBytes: 1 }), 'EDITING_LIMITS_INVALID')
  })
})

describe('profile limit bounds', () => {
  it('narrows the global bounds and resolves its own defaults', () => {
    const bounds = validateLimitBounds({ wallClockMs: { min: 2_000, default: 30_000, max: 60_000 }, cpuCount: { min: 0.5, default: 0.5, max: 2 } })
    expect(bounds.wallClockMs).toEqual({ min: 2_000, default: 30_000, max: 60_000 })
    expect(bounds.cpuCount).toEqual({ min: 0.5, default: 0.5, max: 2 })
    expect(bounds.memoryBytes).toEqual(V1_LIMIT_BOUNDS.memoryBytes)
    expect(resolveSessionLimits({}, bounds)).toEqual({ ...DEFAULTS, wallClockMs: 30_000, cpuCount: 0.5 })
    expect(resolveSessionLimits({ wallClockMs: 60_000 }, bounds).wallClockMs).toBe(60_000)
    // A value valid globally is still rejected outside the narrowed profile range.
    expectCode(() => resolveSessionLimits({ wallClockMs: 120_000 }, bounds), 'EDITING_LIMITS_INVALID')
    expectCode(() => resolveSessionLimits({ wallClockMs: 1_000 }, bounds), 'EDITING_LIMITS_INVALID')
  })

  it.each([
    ['a widened maximum', { wallClockMs: { min: 1_000, default: 120_000, max: 900_001 } }],
    ['a widened minimum', { pids: { min: 31, default: 256, max: 1_024 } }],
    ['an unordered range', { pids: { min: 512, default: 256, max: 1_024 } }],
    ['a default above the maximum', { memoryBytes: { min: 268_435_456, default: 2_147_483_648, max: 1_073_741_824 } }],
    ['a fractional integer bound', { pids: { min: 32, default: 256.5, max: 1_024 } }],
    ['a non-whole-second stop grace bound', { stopGraceMs: { min: 1_000, default: 2_500, max: 30_000 } }],
    ['a string bound', { pids: { min: '32', default: 256, max: 1_024 } }],
    ['an incomplete range', { pids: { min: 32, max: 1_024 } }],
    ['an unknown field', { diskBytes: { min: 1, default: 1, max: 1 } }],
  ])('rejects %s', (_label, bounds) => {
    expectCode(() => validateLimitBounds(bounds), 'EDITING_PROFILE_INVALID')
  })
})

describe('editing session request', () => {
  it('accepts a complete request and returns an immutable copy', () => {
    const input = request({ limits: { wallClockMs: 30_000 } })
    const parsed = parseEditingSessionRequest(input)

    expect(parsed).toMatchObject({
      repositoryRoot: '/srv/projects/example',
      revision: REVISION,
      task: 'Fix the failing greeting test.',
      runtimeProfileId: 'fixture-editing-agent',
      declaredProjectCommands: ['node scripts/check.mjs'],
      limits: { wallClockMs: 30_000 },
    })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.declaredProjectCommands)).toBe(true)
    ;(input.declaredProjectCommands as string[]).push('rm -rf /')
    expect(parsed.declaredProjectCommands).toEqual(['node scripts/check.mjs'])
  })

  it('accepts a 64-hex SHA-256 object ID and an AbortSignal', () => {
    const signal = new AbortController().signal
    const parsed = parseEditingSessionRequest(request({ revision: 'c'.repeat(64), signal }))
    expect(parsed.revision).toBe('c'.repeat(64))
    expect(parsed.signal).toBe(signal)
  })

  it('treats declared project commands as bounded context, not an allowlist', () => {
    // Shell metacharacters are just context text: nothing evaluates or enforces them.
    const commands = ['pnpm test -- --run', 'node scripts/check.mjs && echo done', 'make lint | tee lint.log']
    const parsed = parseEditingSessionRequest(request({ declaredProjectCommands: commands }))
    expect(parsed.declaredProjectCommands).toEqual(commands)
    expect(Object.keys(parsed)).not.toContain('allowedCommands')
    expect(parseEditingSessionRequest(request({ declaredProjectCommands: [] })).declaredProjectCommands).toEqual([])

    // The task document carries exactly the task and the declared context, nothing else.
    const document = createTaskDocument(parsed)
    expect(document).toEqual({ task: parsed.task, declaredProjectCommands: commands })
    expect(Object.isFrozen(document)).toBe(true)
  })

  it('accepts the exact task and command bounds', () => {
    const maxTask = 'x'.repeat(MAX_TASK_BYTES)
    const maxCommand = 'y'.repeat(MAX_DECLARED_COMMAND_BYTES)
    const commands = Array.from({ length: MAX_DECLARED_COMMANDS }, () => maxCommand)
    expect(parseEditingSessionRequest(request({ task: maxTask, declaredProjectCommands: commands })).task).toBe(maxTask)
  })

  it.each([
    ['a missing repository root', { repositoryRoot: undefined }],
    ['a relative repository root', { repositoryRoot: 'projects/example' }],
    ['a repository root with a NUL byte', { repositoryRoot: '/srv/example\0' }],
    ['a symbolic revision', { revision: 'HEAD' }],
    ['an abbreviated revision', { revision: 'b'.repeat(12) }],
    ['an uppercase revision', { revision: 'B'.repeat(40) }],
    ['an option-shaped revision', { revision: '--upload-pack=x' }],
    ['an empty task', { task: '' }],
    ['a whitespace-only task', { task: '   \n ' }],
    ['an oversized task', { task: 'x'.repeat(MAX_TASK_BYTES + 1) }],
    ['a multi-byte task beyond the byte bound', { task: 'é'.repeat(MAX_TASK_BYTES / 2 + 1) }],
    ['a task with a NUL byte', { task: 'fix\0it' }],
    ['a task embedding a credential', { task: 'Use MODEL_API_KEY=sk-abcdefghijklmnopqrstuvwx to call the API.' }],
    ['a task embedding the repository root', { task: 'Edit /srv/projects/example/src/app.ts.' }],
    ['a missing command list', { declaredProjectCommands: undefined }],
    ['a command list that is a string', { declaredProjectCommands: 'pnpm test' }],
    ['too many commands', { declaredProjectCommands: Array.from({ length: MAX_DECLARED_COMMANDS + 1 }, () => 'pnpm test') }],
    ['an oversized command', { declaredProjectCommands: ['y'.repeat(MAX_DECLARED_COMMAND_BYTES + 1)] }],
    ['an empty command', { declaredProjectCommands: [''] }],
    ['a multi-line command', { declaredProjectCommands: ['pnpm test\nrm -rf /'] }],
    ['a command embedding a credential', {
      declaredProjectCommands: [[
        'curl -H "Authorization: ',
        'Bearer ',
        'abcdef',
        'ghijklmnop" https://x.test',
      ].join('')],
    }],
    ['a command embedding the repository root', { declaredProjectCommands: ['ls /srv/projects/example'] }],
    ['an unregistered-shape profile ID', { runtimeProfileId: 'Fixture Agent' }],
    ['a numeric profile ID', { runtimeProfileId: 7 }],
    ['an invalid limit', { limits: { pids: 4_096 } }],
    ['a limits array', { limits: [] }],
    ['a non-signal abort field', { signal: { aborted: false } }],
  ])('rejects %s', (_label, overrides) => {
    expectCode(() => parseEditingSessionRequest(request(overrides)), 'EDITING_REQUEST_INVALID')
  })

  it.each([
    ['an image', { image: 'node:latest' }],
    ['an image reference', { imageReference: IMAGE_ID }],
    ['raw Docker flags', { dockerArgs: ['--privileged'] }],
    ['mounts', { mounts: [{ source: '/', target: '/host' }] }],
    ['a network', { network: 'host' }],
    ['published ports', { ports: ['8080:80'] }],
    ['an entrypoint override', { entrypoint: ['sh', '-c', 'id'] }],
    ['a shell command string', { command: 'sh -c "cat ~/.ssh/id_rsa"' }],
    ['a credential', { credential: 'sk-abcdefghijklmnopqrstuvwx' }],
    ['an environment', { environment: { MODEL_API_KEY: 'x' } }],
    ['a task document path', { taskDocumentPath: '/etc/passwd' }],
  ])('rejects a request carrying %s', (_label, overrides) => {
    expectCode(() => parseEditingSessionRequest(request(overrides)), 'EDITING_REQUEST_INVALID')
  })

  it('rejects non-object input and never echoes values in its message', () => {
    expectCode(() => parseEditingSessionRequest(null), 'EDITING_REQUEST_INVALID')
    expectCode(() => parseEditingSessionRequest('task'), 'EDITING_REQUEST_INVALID')
    let message = ''
    try {
      parseEditingSessionRequest(request({ task: 'MODEL_API_KEY=sk-abcdefghijklmnopqrstuvwx', repositoryRoot: 'relative/secret-dir' }))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(message).not.toContain('secret-dir')
  })
})

const cleanComplete = {
  status: 'complete',
  containerRemoved: true,
  workspaceRemoved: true,
  originalRepositoryUnchanged: true,
  reasonCode: null,
  remainingOwnedResources: [],
} as const

const validResult = (overrides: Partial<Record<keyof EditingSessionResult, unknown>> = {}): Record<string, unknown> => ({
  sessionId: '0b8f4f47-8a43-4a6f-9b37-5d1f3c2e9a10',
  executionOutcome: 'completed',
  exitCode: 0,
  signal: null,
  durationMs: 1_234,
  diagnostic: 'completed: the agent exited with code 0.',
  cleanup: cleanComplete,
  runtime: { profileId: 'fixture-editing-agent', imageReference: IMAGE_ID, isolation: { rootless: false, lsm: 'apparmor' } },
  ...overrides,
})

describe('editing session result', () => {
  it('has the exact outcome enums and field sets', () => {
    expect([...EXECUTION_OUTCOMES]).toEqual(['completed', 'failed', 'timed_out', 'cancelled', 'startup_failed'])
    expect([...CLEANUP_STATUSES]).toEqual(['complete', 'recovered', 'failed'])
    expect([...OWNED_RESOURCE_CATEGORIES]).toEqual(['container', 'task_document', 'workspace', 'original_repository'])
    expect([...EDITING_SESSION_RESULT_FIELDS]).toEqual(['sessionId', 'executionOutcome', 'exitCode', 'signal', 'durationMs', 'diagnostic', 'cleanup', 'runtime'])
    expect([...CLEANUP_RESULT_FIELDS]).toEqual([
      'status',
      'containerRemoved',
      'workspaceRemoved',
      'originalRepositoryUnchanged',
      'reasonCode',
      'remainingOwnedResources',
    ])
  })

  it('accepts a valid result for every execution outcome', () => {
    const exits: Record<string, { exitCode: number | null; signal: string | null }> = {
      completed: { exitCode: 0, signal: null },
      failed: { exitCode: 3, signal: null },
      timed_out: { exitCode: 137, signal: 'SIGKILL' },
      cancelled: { exitCode: 143, signal: 'SIGTERM' },
      startup_failed: { exitCode: null, signal: null },
    }
    for (const outcome of EXECUTION_OUTCOMES) {
      const parsed = parseEditingSessionResult(validResult({ executionOutcome: outcome, ...exits[outcome] }))
      expect(parsed.ok, outcome).toBe(true)
    }
    expect(parseEditingSessionResult(validResult({ runtime: { profileId: 'fixture-editing-agent', imageReference: IMAGE_ID, isolation: null } })).ok).toBe(true)
  })

  it('keeps the execution outcome independent of a recovered or failed cleanup', () => {
    const recovered = { ...cleanComplete, status: 'recovered', reasonCode: 'CLEANUP_RETRIED' }
    expect(parseEditingSessionResult(validResult({ cleanup: recovered })).ok).toBe(true)
    const failed = {
      status: 'failed',
      containerRemoved: false,
      workspaceRemoved: true,
      originalRepositoryUnchanged: true,
      reasonCode: 'CONTAINER_NOT_REMOVED',
      remainingOwnedResources: ['container'],
    }
    const parsed = parseEditingSessionResult(validResult({ cleanup: failed }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.executionOutcome).toBe('completed')
  })

  it.each([
    ['a complete cleanup with residue', { ...cleanComplete, remainingOwnedResources: ['workspace'], workspaceRemoved: false }],
    ['a complete cleanup with a reason', { ...cleanComplete, reasonCode: 'CONTAINER_NOT_REMOVED' }],
    ['a recovered cleanup without its reason', { ...cleanComplete, status: 'recovered' }],
    ['a failed cleanup without residue', { ...cleanComplete, status: 'failed', reasonCode: 'CONTAINER_NOT_REMOVED' }],
    [
      'a failed cleanup whose flags contradict its residue',
      { ...cleanComplete, status: 'failed', reasonCode: 'CONTAINER_NOT_REMOVED', remainingOwnedResources: ['container'] },
    ],
    [
      'an unknown resource category',
      { ...cleanComplete, status: 'failed', reasonCode: 'CONTAINER_NOT_REMOVED', containerRemoved: false, remainingOwnedResources: ['volume'] },
    ],
    ['a raw stderr reason', { ...cleanComplete, status: 'recovered', reasonCode: 'Error response from daemon: busy' }],
    ['an extra cleanup field', { ...cleanComplete, residuePaths: ['/tmp/x'] }],
  ])('rejects %s', (_label, cleanup) => {
    expect(parseEditingSessionResult(validResult({ cleanup })).ok).toBe(false)
  })

  it.each([
    ['an unknown outcome', { executionOutcome: 'cleanup_failed' }],
    ['a completed outcome with a non-zero exit', { executionOutcome: 'completed', exitCode: 1 }],
    ['a startup failure with an exit code', { executionOutcome: 'startup_failed', exitCode: 127 }],
    ['a fractional exit code', { exitCode: 0.5 }],
    ['an unbounded signal', { executionOutcome: 'failed', exitCode: null, signal: 'S'.repeat(64) }],
    ['a negative duration', { durationMs: -1 }],
    ['a fractional duration', { durationMs: 1.5 }],
    ['an oversized diagnostic', { diagnostic: 'x'.repeat(1_048_577) }],
    ['a mutable image tag', { runtime: { profileId: 'fixture-editing-agent', imageReference: 'node:24', isolation: null } }],
    ['raw argv in the runtime summary', { runtime: { profileId: 'fixture-editing-agent', imageReference: IMAGE_ID, isolation: null, argv: ['node'] } }],
    ['a non-UUID session ID', { sessionId: '../escape' }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseEditingSessionResult(validResult(overrides)).ok).toBe(false)
  })

  it.each([
    'candidate',
    'candidateStatus',
    'diff',
    'unifiedDiff',
    'changedFiles',
    'files',
    'fileContents',
    'workspacePath',
    'workspace',
    'transcript',
    'stdout',
    'stderr',
    'replay',
    'gates',
    'verified',
    'verdict',
    'status',
    'containerId',
  ])('rejects a result carrying %s', (field) => {
    expect(parseEditingSessionResult({ ...validResult(), [field]: field === 'verified' ? true : 'x' }).ok).toBe(false)
  })
})
