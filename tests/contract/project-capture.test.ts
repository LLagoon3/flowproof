import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPrivacyPolicy } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import type { RedactedValueRegistry, TargetImageOutcome } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import {
  RECORDER_IMAGE_BUDGET,
  ProjectRecorderError,
  createCaptureSession,
  networkEventFromRequest,
} from '../../packages/flowproof/src/capture/projectRecorder.js'
import type {
  CaptureBinding,
  CaptureSessionOptions,
  ProjectCaptureSession,
  RecorderSource,
  TargetImageSource,
} from '../../packages/flowproof/src/capture/projectRecorder.js'
import {
  PROJECT_LIMITS,
  canTransitionCapture,
  parseDemonstrationCapture,
  projectDigest,
} from '../../packages/flowproof/src/project/contracts.js'
import type { DemonstrationCapture, InteractionObservation } from '../../packages/flowproof/src/project/contracts.js'

// T021: contract tests for the host-side demonstration capture session. Recorder callbacks are fed
// to the host session as the Playwright adapter would deliver them. Every image source below is an
// explicitly labelled IN-PROCESS FAKE that returns a synthetic PNG-shaped buffer: these tests prove
// state, authority, ordering, limits and sealing, not pixel masking (tests/e2e/project-privacy.spec.ts
// covers actual rendered pixels). Nothing here is a selected-project acceptance run.

const ROOT = path.resolve(import.meta.dirname, '../..')
const ORIGIN = 'http://localhost:43161'
const FRAME = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const OTHER_FRAME = '7a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d'
const TOKEN_A = '11111111-1111-4111-8111-111111111111'
const TOKEN_B = '22222222-2222-4222-8222-222222222222'
const TOKEN_C = '33333333-3333-4333-8333-333333333333'

const BINDING: CaptureBinding = Object.freeze({
  run_id: '0e3d6a9c-1b2f-4c5d-9e8f-7a6b5c4d3e2f',
  project_id: '1f4e7b0d-2c3a-4d6e-8f9a-8b7c6d5e4f3a',
  baseline_commit: 'a'.repeat(40),
  configuration_id: '2a5f8c1e-3d4b-4e7f-a0b1-9c8d7e6f5a4b',
  configuration_digest: 'b'.repeat(64),
  target_origin: ORIGIN,
  viewport: Object.freeze({ width: 1280, height: 720, device_scale_factor: 1 as const }),
  build_sha256: 'c'.repeat(64),
})

const TARGET: RecorderSource = { frameId: FRAME, origin: ORIGIN, relation: 'target' }

type Json = Record<string, unknown>

const el = (overrides: Json = {}): Json => ({
  tag: 'button',
  testId: null,
  role: 'button',
  name: 'Add task',
  id: null,
  css: 'button.add',
  private: false,
  ...overrides,
})
const field = (overrides: Json = {}): Json => ({ type: 'text', autocomplete: null, name: 'title', label: 'Title', placeholder: null, ...overrides })
const titleEl = el({ tag: 'input', role: 'textbox', name: 'Title', css: 'input#title', testId: 'title' })

/** A recorder envelope as the in-page instrumentation sends it; every field is untrusted. */
const env = (token: string, n: number, e: Json): Json => ({ v: 1, token, n, e })

/** IN-PROCESS FAKE image source: a synthetic PNG header, not a rendered or masked screenshot. */
function fakeImages(outcomes: Array<TargetImageOutcome | 'ok'> = []): TargetImageSource & { calls: number; defer: () => () => void } {
  let calls = 0
  let gate: Promise<void> | null = null
  const source = {
    get calls() {
      return calls
    },
    defer() {
      let release = (): void => undefined
      gate = new Promise<void>((resolve) => (release = resolve))
      return release
    },
    async capture(_registry: RedactedValueRegistry): Promise<TargetImageOutcome> {
      calls += 1
      const planned = outcomes.shift() ?? 'ok'
      if (gate) await gate
      if (planned !== 'ok') return planned
      const png = syntheticPng(320, 240, calls)
      return {
        ok: true,
        image: { png, sha256: sha(png), bytes: png.length, viewport: { width: 320, height: 240 }, clip: { x: 0, y: 0, width: 320, height: 240 }, mask_count: 2 },
      }
    },
  }
  return source
}

function syntheticPng(width: number, height: number, salt: number, size = 64): Buffer {
  const buffer = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer.writeUInt32BE(salt, size - 4)
  return buffer
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface Harness {
  readonly session: ProjectCaptureSession
  readonly images: ReturnType<typeof fakeImages>
  advance(ms: number): void
}

function harness({ outcomes, ...options }: Partial<CaptureSessionOptions> & { readonly outcomes?: Array<TargetImageOutcome | 'ok'> } = {}): Harness {
  let now = 1_000
  const images = fakeImages(outcomes)
  const session = createCaptureSession({
    binding: BINDING,
    frameId: FRAME,
    policy: createPrivacyPolicy({ admitSafeValues: true, privateSelectors: ['.account'] }),
    clock: () => now,
    images,
    collectors: { console: true, pageErrors: true, network: true },
    ...options,
  })
  return { session, images, advance: (ms) => void (now += ms) }
}

/** Starts recording on the entry document (`TOKEN_A`, epoch 0). */
function recording(options: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(options)
  h.session.begin(TARGET, env(TOKEN_A, 0, { k: 'hello', href: `${ORIGIN}/app` }))
  return h
}

function expectContract(capture: DemonstrationCapture): void {
  const parsed = parseDemonstrationCapture(capture)
  expect(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.error.issues)).toBe(true)
}

const actions = (capture: DemonstrationCapture) => capture.interactions.map((interaction) => interaction.action.type)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('capture lifecycle', () => {
  it('moves idle -> recording -> finishing -> ready and every staged view satisfies the S1 contract', async () => {
    const h = harness()
    expect(h.session.state).toBe('idle')
    expectContract(h.session.snapshot())

    h.session.begin(TARGET, env(TOKEN_A, 0, { k: 'hello', href: `${ORIGIN}/app` }))
    expect(h.session.state).toBe('recording')
    expect(h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))).toBe('accepted')
    expectContract(h.session.snapshot())

    const states: string[] = []
    const sealed = await h.session.finish(async () => {
      states.push(h.session.state)
      return { ok: true, hostUrl: `${ORIGIN}/app` }
    })
    expect(states).toEqual(['finishing'])
    expect(sealed.capture.state).toBe('ready')
    expect(sealed.capture.completeness).toEqual({ status: 'complete', reasons: [] })
    expect(canTransitionCapture('recording', 'finishing') && canTransitionCapture('finishing', 'ready')).toBe(true)
    expectContract(sealed.capture)
  })

  it('binds the sealed capture to the host run, project, baseline, configuration and target identity', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    const { capture } = await h.session.finish()
    expect(capture).toMatchObject({
      run_id: BINDING.run_id,
      project_id: BINDING.project_id,
      baseline_commit: BINDING.baseline_commit,
      configuration_id: BINDING.configuration_id,
      configuration_digest: BINDING.configuration_digest,
      target_origin: ORIGIN,
      viewport: BINDING.viewport,
      capture_id: h.session.captureId,
    })
    expect(capture.capture_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (const interaction of capture.interactions) expect(interaction).toMatchObject({ capture_id: capture.capture_id, frame_id: FRAME })
    for (const observation of capture.observations) expect(observation).toMatchObject({ run_id: BINDING.run_id, capture_id: capture.capture_id, phase: 'demonstration' })
    const image = capture.observations.find((observation) => observation.type === 'image' && observation.availability === 'available')
    expect(image?.type === 'image' ? image.payload?.build_sha256 : undefined).toBe(BINDING.build_sha256)
  })

  it('refuses to begin from another frame, origin or a non-hello payload and stays idle', () => {
    for (const [source, envelope] of [
      [{ ...TARGET, frameId: OTHER_FRAME, relation: 'foreign' }, env(TOKEN_A, 0, { k: 'hello', href: `${ORIGIN}/app` })],
      [{ ...TARGET, origin: 'http://localhost:43162' }, env(TOKEN_A, 0, { k: 'hello', href: 'http://localhost:43162/app' })],
      [TARGET, env(TOKEN_A, 0, { k: 'click', el: el() })],
      [TARGET, env(TOKEN_A, 0, { k: 'hello', href: 'https://example.com/app' })],
    ] as const) {
      const h = harness()
      expect(() => h.session.begin(source as RecorderSource, envelope)).toThrow(ProjectRecorderError)
      expect(h.session.state).toBe('idle')
    }
  })

  it('finishes an empty demonstration as incomplete rather than as a usable ready report', async () => {
    const { capture } = await recording().session.finish()
    expect(capture.state).toBe('incomplete')
    expect(capture.completeness?.reasons).toContain('CAPTURE_EMPTY')
    expectContract(capture)
  })

  it('imposes no human deadline: two idle days of recording leave the capture recording and still sealable', async () => {
    vi.useFakeTimers()
    const h = recording()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * 60 * 60 * 1_000)
    h.advance(48 * 60 * 60 * 1_000)
    expect(h.session.state).toBe('recording')
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    vi.useRealTimers()
    const { capture } = await h.session.finish()
    expect(capture.state).toBe('ready')
    expect(capture.timing.finished_offset_ms).toBeGreaterThanOrEqual(48 * 60 * 60 * 1_000)
  })
})

describe('observation authority', () => {
  it('assigns its own contiguous sequence and ignores recorder-supplied sequence or identity fields', async () => {
    const h = recording()
    expect(h.session.ingest(TARGET, { ...env(TOKEN_A, 1, { k: 'click', el: el() }), sequence: 99 })).toBe('dropped')
    expect(h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el(), sequence: 7, capture_id: TOKEN_C }))).toBe('dropped')
    h.session.ingest(TARGET, env(TOKEN_A, 3, { k: 'click', el: el() }))
    h.session.ingest(TARGET, env(TOKEN_A, 4, { k: 'click', el: el({ name: 'Remove task', css: 'button.remove' }) }))
    const { capture } = await h.session.finish()
    expect(capture.interactions.map((interaction) => interaction.sequence)).toEqual([1, 2])
    expect(capture.state).toBe('incomplete')
    expect(capture.counters.dropped).toBe(2)
    expect(capture.completeness?.reasons).toContain('EVENT_INVALID')
  })

  it('never collects data from another frame or origin and keeps the target capture usable', async () => {
    const h = recording()
    const foreign: RecorderSource = { frameId: OTHER_FRAME, origin: ORIGIN, relation: 'foreign' }
    const wrongOrigin: RecorderSource = { ...TARGET, origin: 'http://127.0.0.1:43160' }
    expect(h.session.ingest(foreign, env(TOKEN_A, 1, { k: 'click', el: el({ name: 'Studio button' }) }))).toBe('rejected')
    expect(h.session.ingest(foreign, env(TOKEN_C, 0, { k: 'hello', href: `${ORIGIN}/decoy` }))).toBe('rejected')
    expect(h.session.ingest(wrongOrigin, env(TOKEN_A, 2, { k: 'console', level: 'error', message: 'studio log' }))).toBe('rejected')
    expect(h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))).toBe('accepted')
    const { capture } = await h.session.finish()
    expect(capture.state).toBe('ready')
    expect(capture.document_epoch).toBe(0)
    expect(JSON.stringify(capture)).not.toMatch(/Studio button|studio log|decoy/)
  })

  it('marks interaction inside a nested frame unsupported and ignores its other traffic', async () => {
    const h = recording()
    const nested: RecorderSource = { frameId: OTHER_FRAME, origin: ORIGIN, relation: 'descendant' }
    expect(h.session.ingest(nested, env(TOKEN_C, 0, { k: 'hello', href: `${ORIGIN}/nested` }))).toBe('ignored')
    expect(h.session.ingest(nested, env(TOKEN_C, 1, { k: 'click', el: el() }))).toBe('unsupported')
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    const { capture } = await h.session.finish()
    expect(capture.state).toBe('unsupported')
    expect(capture.completeness?.reasons).toContain('NESTED_FRAME_UNSUPPORTED')
    expect(actions(capture)).toEqual(['click'])
  })

  it('binds events to the document epoch and rejects stale, unknown, duplicate and out-of-order callbacks', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    expect(h.session.ingest(TARGET, env(TOKEN_B, 0, { k: 'hello', href: `${ORIGIN}/next` }))).toBe('accepted')
    expect(h.session.status().epoch).toBe(1)
    expect(h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el() }))).toBe('dropped')
    expect(h.session.ingest(TARGET, env(TOKEN_C, 1, { k: 'click', el: el() }))).toBe('dropped')
    expect(h.session.ingest(TARGET, env(TOKEN_B, 1, { k: 'click', el: el() }))).toBe('accepted')
    expect(h.session.ingest(TARGET, env(TOKEN_B, 1, { k: 'click', el: el() }))).toBe('dropped')
    expect(h.session.ingest(TARGET, env(TOKEN_B, 0, { k: 'click', el: el() }))).toBe('dropped')
    // A gap in the per-document counter means a callback never arrived: explicit loss, still staged.
    expect(h.session.ingest(TARGET, env(TOKEN_B, 3, { k: 'click', el: el() }))).toBe('accepted')
    const { capture } = await h.session.finish()
    expect(capture.interactions.map((interaction) => [interaction.action.type, interaction.document_epoch])).toEqual([
      ['click', 0],
      ['navigate', 1],
      ['click', 1],
      ['click', 1],
    ])
    expect(capture.state).toBe('incomplete')
    expect(capture.counters.dropped).toBe(5)
    expect(capture.completeness?.reasons).toEqual(expect.arrayContaining(['EVENT_STALE_DOCUMENT', 'EVENT_UNKNOWN_DOCUMENT', 'EVENT_ORDER_INVALID', 'EVENT_SEQUENCE_GAP']))
  })

  it('counts a host-detected detached target frame and cross-origin navigation instead of hiding them', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    h.session.recordHostEvent({ kind: 'unsupported', reason: 'NAVIGATION_CROSS_ORIGIN' })
    h.session.recordHostEvent({ kind: 'dropped', reason: 'TARGET_FRAME_DETACHED' })
    const { capture } = await h.session.finish()
    expect(capture.state).toBe('unsupported')
    expect(capture.completeness?.reasons).toEqual(expect.arrayContaining(['NAVIGATION_CROSS_ORIGIN', 'TARGET_FRAME_DETACHED']))
  })
})

describe('supported actions and ordering', () => {
  it('records click, a coalesced safe fill, a native select, a coalesced scroll and a same-origin navigation in order', async () => {
    const h = recording()
    const filter = el({ tag: 'select', role: 'combobox', name: 'Filter', css: 'select#filter', testId: null })
    const list = el({ tag: 'ul', role: 'list', name: '', css: 'ul#tasks', testId: 'tasks' })
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: titleEl }))
    for (const [n, value] of ['B', 'Bu', 'Buy', 'Buy milk'].entries()) {
      expect(h.session.ingest(TARGET, env(TOKEN_A, 2 + n, { k: 'input', el: titleEl, field: field(), value, commit: false }))).toBe(n === 0 ? 'accepted' : 'coalesced')
    }
    h.session.ingest(TARGET, env(TOKEN_A, 6, { k: 'select', el: filter, field: field({ type: null, name: 'filter', label: 'Filter' }), value: 'done', multiple: false }))
    for (const [n, y] of [40, 120, 360].entries()) h.session.ingest(TARGET, env(TOKEN_A, 7 + n, { k: 'scroll', el: list, x: 0, y }))
    h.session.ingest(TARGET, env(TOKEN_A, 10, { k: 'url', href: `${ORIGIN}/app?view=done#list` }))
    const { capture } = await h.session.finish()

    expect(capture.state).toBe('ready')
    expect(capture.interactions.map((interaction) => interaction.action)).toEqual([
      { type: 'click', locators: [{ kind: 'test-id', value: 'title' }, { kind: 'role', role: 'textbox', name: 'Title' }, { kind: 'css', selector: 'input#title' }] },
      { type: 'fill', locators: [{ kind: 'test-id', value: 'title' }, { kind: 'role', role: 'textbox', name: 'Title' }, { kind: 'css', selector: 'input#title' }], value: { kind: 'safe', text: 'Buy milk' } },
      { type: 'select', locators: [{ kind: 'role', role: 'combobox', name: 'Filter' }, { kind: 'css', selector: 'select#filter' }], value: { kind: 'safe', option: 'done' } },
      { type: 'scroll', target: { kind: 'element', locators: [{ kind: 'test-id', value: 'tasks' }, { kind: 'css', selector: 'ul#tasks' }] }, x: 0, y: 360 },
      { type: 'navigate', path: '/app?view=done#list' },
    ])
    expect(capture.interactions.map((interaction) => interaction.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('flushes pending typed input and scroll before a navigation changes the document epoch', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'input', el: titleEl, field: field(), value: 'Draft', commit: false }))
    h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'scroll', el: null, x: 0, y: 500 }))
    h.session.ingest(TARGET, env(TOKEN_B, 0, { k: 'hello', href: `${ORIGIN}/next` }))
    const { capture } = await h.session.finish()
    expect(capture.interactions.map((interaction) => [interaction.sequence, interaction.action.type, interaction.document_epoch])).toEqual([
      [1, 'fill', 0],
      [2, 'scroll', 0],
      [3, 'navigate', 1],
    ])
    expect(capture.interactions[2]?.action).toEqual({ type: 'navigate', path: '/next' })
  })

  it('flushes pending input when the Finish drain runs and seals events delivered during the drain', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'input', el: titleEl, field: field(), value: 'Pending', commit: false }))
    const { capture } = await h.session.finish(async () => {
      h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el() }))
      return { ok: true, hostUrl: `${ORIGIN}/app` }
    })
    expect(actions(capture)).toEqual(['fill', 'click'])
    const end = capture.observations.filter((observation) => observation.type === 'image').at(-1)
    expect(end?.sequence_range).toEqual({ first: 2, last: 2 })
  })

  it('makes a failed drain or an unattributed final navigation explicit', async () => {
    for (const [drain, reason] of [
      [{ ok: false, hostUrl: null }, 'FINISH_DRAIN_FAILED'],
      [{ ok: true, hostUrl: `${ORIGIN}/elsewhere` }, 'NAVIGATION_UNATTRIBUTED'],
    ] as const) {
      const h = recording()
      h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
      const { capture } = await h.session.finish(async () => drain)
      expect(capture.state).toBe('incomplete')
      expect(capture.completeness?.reasons).toContain(reason)
    }
  })

  it('marks unsupported user actions explicitly instead of turning them into supported actions', async () => {
    const reasons = ['DRAG_DROP', 'FILE_UPLOAD', 'CANVAS_GESTURE', 'KEYBOARD_SHORTCUT', 'CONTENTEDITABLE_EDIT'] as const
    const h = recording()
    reasons.forEach((reason, index) => expect(h.session.ingest(TARGET, env(TOKEN_A, index + 1, { k: 'unsupported', reason }))).toBe('unsupported'))
    h.session.ingest(TARGET, env(TOKEN_A, 9, { k: 'select', el: el({ tag: 'select', role: 'listbox' }), field: field(), value: 'a', multiple: true }))
    h.session.ingest(TARGET, env(TOKEN_A, 10, { k: 'click', el: el() }))
    const { capture } = await h.session.finish()
    expect(actions(capture)).toEqual(['click'])
    expect(capture.state).toBe('unsupported')
    expect(capture.counters.unsupported).toBe(reasons.length + 1)
    expect(capture.completeness?.reasons).toEqual(expect.arrayContaining([...reasons, 'SELECT_MULTIPLE_UNSUPPORTED']))
  })

  it('records an unsafe or cross-origin navigation as unsupported rather than a sanitized fake path', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    expect(h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'url', href: `${ORIGIN}/app?token=abc12345` }))).toBe('unsupported')
    const { capture } = await h.session.finish()
    expect(actions(capture)).toEqual(['click'])
    expect(capture.state).toBe('unsupported')
    expect(capture.completeness?.reasons).toContain('NAVIGATION_QUERY_SENSITIVE')
  })

  it('keeps redacted values explicit and never stages a non-admitted value', async () => {
    const h = recording()
    const secret = 'Synthetic-Pa55word'
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'input', el: el({ tag: 'input', role: 'textbox', name: 'Password', css: 'input#pw' }), field: field({ type: 'password', name: 'pw' }), value: secret, commit: true }))
    h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el({ name: `Hello ${secret}`, css: 'button.greet' }) }))
    const { capture } = await h.session.finish()
    expect(capture.interactions[0]?.action).toMatchObject({ type: 'fill', value: { kind: 'redacted', reason: 'FIELD_SENSITIVE' } })
    // The reflected secret makes the role name unusable; only the structural locator survives.
    expect(capture.interactions[1]?.action).toEqual({ type: 'click', locators: [{ kind: 'css', selector: 'button.greet' }] })
    expect(JSON.stringify(capture)).not.toContain(secret)
  })

  it('does not retain short sensitive values reflected into names, errors or URLs', async () => {
    const h = recording()
    const secret = '317'
    h.session.ingest(TARGET, env(TOKEN_A, 1, {
      k: 'input',
      el: el({ tag: 'input', role: 'textbox', name: 'PIN', css: 'input#pin' }),
      field: field({ type: 'password', name: 'pin', label: 'PIN' }),
      value: secret,
      commit: true,
    }))
    h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el({ testId: null, role: 'button', name: `Current value ${secret}`, css: 'button.current' }) }))
    h.session.ingest(TARGET, env(TOKEN_A, 3, { k: 'console', level: 'error', message: `Current value ${secret}` }))
    expect(h.session.ingest(TARGET, env(TOKEN_A, 4, { k: 'url', href: `${ORIGIN}/app?q=${secret}` }))).toBe('unsupported')

    const { capture } = await h.session.finish()
    expect(capture.state).toBe('unsupported')
    expect(capture.completeness?.reasons).toContain('PRIVACY_REGISTRY_LIMIT')
    expect(capture.interactions).toEqual([])
    expect(capture.observations.find((observation) => observation.type === 'console')?.payload).toMatchObject({ message: '[REDACTED]' })
    expect(capture.interactions.some((interaction) => interaction.action.type === 'navigate')).toBe(false)
    expect(JSON.stringify({
      actions: capture.interactions.map((interaction) => interaction.action),
      messages: capture.observations.filter((observation) => observation.type === 'console').map((observation) => observation.payload),
    })).not.toContain(secret)
  })
})

describe('observations, collectors and limits', () => {
  it('records sanitized target errors and network metadata without headers, bodies, cookies or queries', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'console', level: 'error', message: 'request failed Authorization: Bearer fpseedconsolebearer0042' }))
    h.session.ingest(TARGET, env(TOKEN_A, 3, { k: 'pageerror', message: 'TypeError: cannot read task' }))
    h.session.ingest(TARGET, env(TOKEN_A, 4, { k: 'pageerror', message: 'TypeError: cannot read task' }))
    const forbidden = () => {
      throw new Error('forbidden accessor')
    }
    const request = {
      method: () => 'GET',
      url: () => `${ORIGIN}/api/tasks.json?token=fpseednetworkquery77`,
      failure: () => null,
      headers: forbidden,
      allHeaders: forbidden,
      postData: forbidden,
      postDataBuffer: forbidden,
      headerValue: forbidden,
    }
    const response = { status: () => 404, headers: forbidden, body: forbidden, text: forbidden, allHeaders: forbidden }
    const event = networkEventFromRequest(request, response)
    expect(h.session.recordHostEvent(event)).toBe('accepted')
    h.session.recordHostEvent(networkEventFromRequest({ ...request, url: () => 'https://tracker.example/pixel?id=1' }, { status: () => 500 }))
    const { capture } = await h.session.finish()

    const byType = (type: string) => capture.observations.filter((observation) => observation.type === type)
    const consoleObservation = byType('console')[0]
    expect(consoleObservation?.payload).toMatchObject({ level: 'error' })
    expect(JSON.stringify(consoleObservation)).not.toContain('fpseedconsolebearer0042')
    expect(byType('page-error')).toHaveLength(1)
    expect(byType('page-error')[0]?.sequence_range).toEqual({ first: 1, last: 1 })
    const network = byType('network-error')
    expect(network[0]?.payload).toMatchObject({ method: 'GET', path: '/api/tasks.json', status: 404, error_class: 'HTTP_ERROR' })
    expect(network[1]).toMatchObject({ availability: 'omitted', reason: 'NETWORK_CROSS_ORIGIN', payload: null })
    expect(JSON.stringify(capture)).not.toMatch(/fpseednetworkquery77|tracker\.example/)
    expect(capture.state).toBe('ready')
  })

  it('discloses absent collectors as unavailable observations without treating them as error-free', async () => {
    const h = recording({ images: null, collectors: { console: false, pageErrors: true, network: false } })
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    expect(h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'console', level: 'error', message: 'not collected' }))).toBe('ignored')
    const { capture } = await h.session.finish()
    const unavailable = capture.observations.filter((observation) => observation.availability === 'unavailable').map((observation) => [observation.type, observation.reason])
    expect(unavailable).toEqual(expect.arrayContaining([['image', 'COLLECTOR_UNAVAILABLE'], ['console', 'COLLECTOR_UNAVAILABLE'], ['network-error', 'COLLECTOR_UNAVAILABLE']]))
    expect(capture.counters.unavailable).toBe(3)
    expect(capture.state).toBe('ready')
    expect(JSON.stringify(capture)).not.toContain('not collected')
  })

  it('stops accepting a complete report at the 200-action cap without silent truncation', async () => {
    const h = recording({ images: null })
    for (let n = 1; n <= PROJECT_LIMITS.maxActions + 3; n += 1) h.session.ingest(TARGET, env(TOKEN_A, n, { k: 'click', el: el() }))
    expect(h.session.status().reasons).toContain('ACTION_LIMIT_EXCEEDED')
    expect(h.session.state).toBe('recording')
    const { capture } = await h.session.finish()
    expect(capture.interactions).toHaveLength(PROJECT_LIMITS.maxActions)
    expect(capture.counters.dropped).toBe(3)
    expect(capture.state).toBe('incomplete')
    expect(capture.completeness?.reasons).toContain('ACTION_LIMIT_EXCEEDED')
    expectContract(capture)
  })

  it('bounds error summaries at 64 KiB and makes the overflow explicit', async () => {
    const h = recording({ images: null })
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    for (let n = 0; n < 40; n += 1) h.session.ingest(TARGET, env(TOKEN_A, 2 + n, { k: 'console', level: 'error', message: `failure ${n} ${'x'.repeat(1_990)}` }))
    const { capture } = await h.session.finish()
    expect(capture.state).toBe('incomplete')
    expect(capture.completeness?.reasons).toContain('ERROR_SUMMARY_LIMIT_EXCEEDED')
    expectContract(capture)
  })

  it('samples action images within the 16-image cap and discloses the sampling instead of exceeding it', async () => {
    const h = recording()
    for (let n = 1; n <= 30; n += 1) h.session.ingest(TARGET, env(TOKEN_A, n, { k: 'click', el: el() }))
    const { capture, artifacts } = await h.session.finish()
    const images = capture.observations.filter((observation) => observation.type === 'image')
    expect(images.length).toBeLessThanOrEqual(PROJECT_LIMITS.maxImages)
    expect(images.filter((image) => image.availability === 'available')).toHaveLength(RECORDER_IMAGE_BUDGET.actions + 2)
    expect(images.filter((image) => image.availability === 'omitted')).toEqual([expect.objectContaining({ reason: 'IMAGE_SAMPLING_LIMIT', sequence_range: { first: RECORDER_IMAGE_BUDGET.actions + 1, last: 30 } })])
    expect(artifacts.size).toBe(RECORDER_IMAGE_BUDGET.actions + 2)
    expect(capture.state).toBe('ready')
  })

  it('omits an oversized, sensitive or occluded image with an explicit effect on completeness', async () => {
    const cases: Array<[TargetImageOutcome, string]> = [
      [{ ok: false, availability: 'omitted', reason: 'IMAGE_BYTES_LIMIT', effect: 'dropped' }, 'incomplete'],
      [{ ok: false, availability: 'omitted', reason: 'IMAGE_SENSITIVE_TEXT', effect: 'unsupported' }, 'unsupported'],
      [{ ok: false, availability: 'omitted', reason: 'IMAGE_TARGET_OCCLUDED', effect: 'unavailable' }, 'ready'],
    ]
    for (const [outcome, state] of cases) {
      const h = recording({ outcomes: [outcome] })
      h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
      const { capture } = await h.session.finish()
      expect(capture.state, outcome.ok ? '' : outcome.reason).toBe(state)
      expect(capture.observations[0]).toMatchObject({ type: 'image', availability: 'omitted', reason: outcome.ok ? null : outcome.reason, payload: null })
      expectContract(capture)
    }
  })
})

describe('Finish, discard and re-record', () => {
  it('drains pending image work and returns one stable digest for duplicate Finish requests', async () => {
    const h = recording()
    const release = h.images.defer()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    const first = h.session.finish()
    const second = h.session.finish()
    let settled = false
    void first.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    release()
    const [a, b] = await Promise.all([first, second])
    const c = await h.session.finish()
    expect(a.report_sha256).toBe(b.report_sha256)
    expect(c.report_sha256).toBe(a.report_sha256)
    expect(c.capture).toBe(a.capture)
    expect(Object.isFrozen(a.capture)).toBe(true)
    expect(a.capture.seal?.report_sha256).toBe(a.report_sha256)
    expect(projectDigest({ ...a.capture, seal: null })).toBe(a.report_sha256)
    for (const observation of a.capture.observations) {
      if (observation.type === 'image' && observation.payload) {
        const bytes = a.artifacts.get(observation.payload.artifact.artifact_id)
        expect(bytes && sha(bytes)).toBe(observation.payload.artifact.sha256)
      }
    }
  })

  it('binds the digest to the capture identity: identical events in another capture seal differently', async () => {
    const digests = await Promise.all(
      [0, 1].map(async () => {
        const h = recording({ images: null })
        h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
        return (await h.session.finish()).report_sha256
      }),
    )
    expect(digests[0]).not.toBe(digests[1])
  })

  it('discards a recording capture, clears staged bytes and permanently invalidates it', async () => {
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const staged = [...h.session.status().artifactIds].map((id) => h.session.artifact(id))
    expect(staged.length).toBeGreaterThan(0)
    h.session.discard()
    expect(h.session.state).toBe('discarded')
    expect(staged.every((bytes) => bytes !== undefined && bytes.every((byte) => byte === 0))).toBe(true)
    const snapshot = h.session.snapshot()
    expect(snapshot).toMatchObject({ state: 'discarded', interactions: [], observations: [], staged_bytes: 0, seal: null })
    expectContract(snapshot)
    expect(h.session.ingest(TARGET, env(TOKEN_A, 2, { k: 'click', el: el() }))).toBe('ignored')
    await expect(h.session.finish()).rejects.toMatchObject({ code: 'CAPTURE_DISCARDED' })
    expect(() => h.session.claimForAnalysis()).toThrow(expect.objectContaining({ code: 'CAPTURE_DISCARDED' }))
  })

  it('lets Discard win over an in-flight Finish so no sealed report survives', async () => {
    const h = recording()
    const release = h.images.defer()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    const finishing = h.session.finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.session.state).toBe('finishing')
    h.session.discard()
    release()
    await expect(finishing).rejects.toMatchObject({ code: 'CAPTURE_DISCARDED' })
    expect(h.session.snapshot().seal).toBeNull()
  })

  it('allows discard of a ready report before analysis, but not after it is claimed for analysis', async () => {
    const discardable = recording({ images: null })
    discardable.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    await discardable.session.finish()
    discardable.session.discard()
    expect(discardable.session.state).toBe('discarded')

    const claimed = recording({ images: null })
    claimed.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    const sealed = await claimed.session.finish()
    expect(claimed.session.claimForAnalysis()).toBe(sealed)
    expect(() => claimed.session.discard()).toThrow(expect.objectContaining({ code: 'CAPTURE_SUBMITTED' }))
    expect(claimed.session.state).toBe('ready')
  })

  it('refuses analysis of incomplete or unsupported reports', async () => {
    const h = recording()
    await h.session.finish()
    expect(() => h.session.claimForAnalysis()).toThrow(expect.objectContaining({ code: 'CAPTURE_NOT_READY' }))
  })

  it('re-records with a new capture identity and no carried-over sequence, data or redaction state', async () => {
    const first = recording({ images: null })
    first.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'input', el: titleEl, field: field({ type: 'password' }), value: 'Carried-Secret-1', commit: true }))
    first.session.discard()
    const second = recording({ images: null })
    second.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el({ name: 'Carried-Secret-1' }) }))
    const { capture } = await second.session.finish()
    expect(capture.capture_id).not.toBe(first.session.captureId)
    expect(capture.interactions.map((interaction: InteractionObservation) => interaction.sequence)).toEqual([1])
    // The second capture never saw the first capture's value, so it has no basis to redact it.
    expect(capture.interactions[0]?.action).toMatchObject({ locators: [{ kind: 'role', name: 'Carried-Secret-1' }, expect.anything()] })
  })
})

describe('capture never contacts a model', () => {
  it('completes a full lifecycle without any network or model request', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network forbidden during capture')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const h = recording()
    h.session.ingest(TARGET, env(TOKEN_A, 1, { k: 'click', el: el() }))
    await h.session.finish()
    h.session.claimForAnalysis()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('has no model, provider or network client dependency in the capture modules', async () => {
    for (const file of ['projectRecorder.ts', 'projectPrivacy.ts']) {
      const source = await readFile(path.join(ROOT, 'packages/flowproof/src/capture', file), 'utf8')
      const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
      expect(imports.filter((specifier) => /model\/|openai|node:https?|undici|fetch/.test(specifier ?? '')), file).toEqual([])
      expect(source, file).not.toMatch(/\bfetch\(/)
    }
  })
})
