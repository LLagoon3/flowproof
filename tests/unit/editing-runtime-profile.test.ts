import { describe, expect, it } from 'vitest'

import { EditingSessionError, V1_LIMIT_BOUNDS } from '../../packages/flowproof/src/editing/contracts.js'
import type { AgentRuntimeProfile } from '../../packages/flowproof/src/editing/contracts.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'

// T006: the trusted in-process runtime-profile registry. Profiles are code-registered and fix an
// immutable image, a direct argv, the literal `/workspace` working directory, a non-secret
// environment, and limit ranges that may only narrow the global v1 bounds.

const DIGEST = 'd'.repeat(64)
const IMAGE_ID = `sha256:${DIGEST}`

const profile = (overrides: Record<string, unknown> = {}): AgentRuntimeProfile =>
  ({
    id: 'fixture-editing-agent',
    imageReference: IMAGE_ID,
    argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
    environment: { FLOWPROOF_FIXTURE: '1' },
    workingDirectory: '/workspace',
    ...overrides,
  }) as AgentRuntimeProfile

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repositoryRoot: '/srv/projects/example',
  revision: 'e'.repeat(40),
  task: 'Edit three files.',
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

describe('runtime profile registry', () => {
  it('resolves a registered profile by its stable ID as a frozen copy', () => {
    const input = profile()
    const registry = createRuntimeProfileRegistry([input])
    const resolved = registry.resolve('fixture-editing-agent')

    expect(registry.ids).toEqual(['fixture-editing-agent'])
    expect(resolved).toMatchObject({
      id: 'fixture-editing-agent',
      imageReference: IMAGE_ID,
      argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
      environment: { FLOWPROOF_FIXTURE: '1' },
      workingDirectory: '/workspace',
      limits: V1_LIMIT_BOUNDS,
    })
    expect(registry.resolve('fixture-editing-agent')).toBe(resolved)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.argv)).toBe(true)
    expect(Object.isFrozen(resolved.environment)).toBe(true)

    // Later mutation of the registration input cannot change the trusted profile.
    ;(input.argv as string[]).push('--privileged')
    ;(input.environment as Record<string, string>).MODEL_API_KEY = 'sk-abcdefghijklmnopqrstuvwx'
    expect(registry.resolve('fixture-editing-agent').argv).toHaveLength(3)
    expect(registry.resolve('fixture-editing-agent').environment).toEqual({ FLOWPROOF_FIXTURE: '1' })
  })

  it('rejects an unknown profile ID', () => {
    const registry = createRuntimeProfileRegistry([profile()])
    expectCode(() => registry.resolve('codex'), 'EDITING_PROFILE_UNKNOWN')
    expectCode(() => registry.resolveRequest(request({ runtimeProfileId: 'codex' })), 'EDITING_PROFILE_UNKNOWN')
  })

  it('rejects duplicate and malformed profile IDs', () => {
    expectCode(() => createRuntimeProfileRegistry([profile(), profile()]), 'EDITING_PROFILE_INVALID')
    expectCode(() => createRuntimeProfileRegistry([profile({ id: 'Fixture Agent' })]), 'EDITING_PROFILE_INVALID')
    expectCode(() => createRuntimeProfileRegistry([profile({ id: '' })]), 'EDITING_PROFILE_INVALID')
    expectCode(() => createRuntimeProfileRegistry('fixture' as never), 'EDITING_PROFILE_INVALID')
  })

  it.each([
    IMAGE_ID,
    `flowproof-editing-agent@sha256:${DIGEST}`,
    `ghcr.io/example/agent@sha256:${DIGEST}`,
    `localhost:5000/team/agent@sha256:${DIGEST}`,
  ])('accepts the immutable image reference %s', (imageReference) => {
    expect(createRuntimeProfileRegistry([profile({ imageReference })]).resolve('fixture-editing-agent').imageReference).toBe(imageReference)
  })

  it.each([
    ['an implicit latest', 'node'],
    ['a tag', 'node:24'],
    ['latest', 'node:latest'],
    ['a tag with a digest', `node:24@sha256:${DIGEST}`],
    ['a short digest', 'sha256:abc123'],
    ['an uppercase digest', `sha256:${'D'.repeat(64)}`],
    ['another digest algorithm', `node@sha512:${'d'.repeat(128)}`],
    ['a Docker flag', '--privileged'],
    ['a shell fragment', `node@sha256:${DIGEST}; id`],
    ['a non-string', 42],
  ])('rejects %s as an image reference', (_label, imageReference) => {
    expectCode(() => createRuntimeProfileRegistry([profile({ imageReference })]), 'EDITING_PROFILE_INVALID')
  })

  it.each([
    ['an empty argv', []],
    ['a string argv', 'node agent.mjs'],
    ['an empty executable', ['', 'agent.mjs']],
    ['a NUL byte', ['node', 'agent\0.mjs']],
    ['a non-string element', ['node', 7]],
    ['a shell wrapper', ['sh', '-c', 'node agent.mjs']],
    ['an absolute bash wrapper', ['/bin/bash', '-lc', 'node agent.mjs']],
    ['too many elements', Array.from({ length: 65 }, () => 'x')],
  ])('rejects %s', (_label, argv) => {
    expectCode(() => createRuntimeProfileRegistry([profile({ argv })]), 'EDITING_PROFILE_INVALID')
  })

  it.each(['/workspace/', '/tmp', 'workspace', '/'])('requires the literal /workspace working directory, not %s', (workingDirectory) => {
    expectCode(() => createRuntimeProfileRegistry([profile({ workingDirectory })]), 'EDITING_PROFILE_INVALID')
  })

  it.each([
    ['a secret-named key', { MODEL_API_KEY: 'value' }],
    ['a token key', { GITHUB_TOKEN: 'value' }],
    ['a password key', { DB_PASSWORD: 'value' }],
    ['a credential-shaped value', { FLOWPROOF_NOTE: 'sk-abcdefghijklmnopqrstuvwx' }],
    ['a reserved HOME', { HOME: '/root' }],
    ['a lowercase key', { flowproof_fixture: '1' }],
    ['a key with an equals sign', { 'A=B': '1' }],
    ['a multi-line value', { FLOWPROOF_NOTE: 'a\nb' }],
    ['a NUL value', { FLOWPROOF_NOTE: 'a\0b' }],
    ['a non-string value', { FLOWPROOF_FIXTURE: 1 }],
    ['an array environment', ['FLOWPROOF_FIXTURE=1']],
    ['too many entries', Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`FLOWPROOF_K${index}`, '1']))],
  ])('rejects an environment with %s', (_label, environment) => {
    expectCode(() => createRuntimeProfileRegistry([profile({ environment })]), 'EDITING_PROFILE_INVALID')
  })

  it('never inherits the host environment', () => {
    process.env.FLOWPROOF_HOST_ONLY_VALUE = 'host-only'
    try {
      const resolved = createRuntimeProfileRegistry([profile({ environment: {} })]).resolve('fixture-editing-agent')
      expect(resolved.environment).toEqual({})
    } finally {
      delete process.env.FLOWPROOF_HOST_ONLY_VALUE
    }
  })

  it.each([
    ['mounts', { mounts: [{ source: '/', target: '/host' }] }],
    ['a privileged flag', { privileged: true }],
    ['a network', { network: 'host' }],
    ['raw Docker flags', { dockerArgs: ['--cap-add=ALL'] }],
    ['a credential provider', { credentials: { provider: 'host' } }],
    ['an entrypoint override', { entrypoint: 'sh' }],
  ])('rejects a profile carrying %s', (_label, overrides) => {
    expectCode(() => createRuntimeProfileRegistry([profile(overrides)]), 'EDITING_PROFILE_INVALID')
  })
})

describe('profile limit ranges', () => {
  const narrowed = profile({
    limits: {
      wallClockMs: { min: 5_000, default: 60_000, max: 300_000 },
      memoryBytes: { min: 536_870_912, default: 536_870_912, max: 2_147_483_648 },
      pids: { min: 64, default: 128, max: 512 },
    },
  })

  it('narrows the global bounds and resolves request defaults from the profile', () => {
    const registry = createRuntimeProfileRegistry([narrowed])
    const resolved = registry.resolveRequest(request())

    expect(resolved.profile.limits.wallClockMs).toEqual({ min: 5_000, default: 60_000, max: 300_000 })
    expect(resolved.profile.limits.cpuCount).toEqual(V1_LIMIT_BOUNDS.cpuCount)
    expect(resolved.limits).toEqual({
      wallClockMs: 60_000,
      stopGraceMs: 5_000,
      memoryBytes: 536_870_912,
      cpuCount: 1,
      pids: 128,
      diagnosticBytes: 65_536,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.limits)).toBe(true)
    expect(resolved.request.runtimeProfileId).toBe('fixture-editing-agent')
  })

  it('accepts explicit values at the narrowed edges and rejects globally valid values outside them', () => {
    const registry = createRuntimeProfileRegistry([narrowed])
    expect(registry.resolveRequest(request({ limits: { wallClockMs: 5_000, pids: 512 } })).limits).toMatchObject({ wallClockMs: 5_000, pids: 512 })
    expectCode(() => registry.resolveRequest(request({ limits: { wallClockMs: 600_000 } })), 'EDITING_LIMITS_INVALID')
    expectCode(() => registry.resolveRequest(request({ limits: { pids: 1_024 } })), 'EDITING_LIMITS_INVALID')
    expectCode(() => registry.resolveRequest(request({ limits: { memoryBytes: 268_435_456 } })), 'EDITING_LIMITS_INVALID')
  })

  it('still rejects structurally invalid requests before profile resolution', () => {
    const registry = createRuntimeProfileRegistry([narrowed])
    expectCode(() => registry.resolveRequest(request({ image: 'node:latest' })), 'EDITING_REQUEST_INVALID')
    expectCode(() => registry.resolveRequest(request({ limits: { pids: '128' } })), 'EDITING_REQUEST_INVALID')
  })

  it.each([
    ['a widened maximum', { wallClockMs: { min: 1_000, default: 120_000, max: 1_000_000 } }],
    ['a widened minimum', { cpuCount: { min: 0.1, default: 1, max: 4 } }],
    ['an unordered range', { pids: { min: 512, default: 64, max: 1_024 } }],
    ['a fractional integer bound', { diagnosticBytes: { min: 4_096, default: 8_192.5, max: 65_536 } }],
    ['a non-whole-second stop grace', { stopGraceMs: { min: 1_000, default: 1_500, max: 30_000 } }],
  ])('rejects %s', (_label, limits) => {
    expectCode(() => createRuntimeProfileRegistry([profile({ limits })]), 'EDITING_PROFILE_INVALID')
  })
})
