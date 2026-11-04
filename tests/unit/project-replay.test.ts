import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openProjectStateRoot } from '../../packages/flowproof/src/evidence/projectStore.js'
import { canonicalJson } from '../../packages/flowproof/src/evidence/store.js'
import {
  EXECUTION_LIMITS,
  MANDATORY_CHECK_IDS,
  PROJECT_LIMITS,
  parseFrozenVerificationDefinition,
  projectDigest,
  withConfigurationDigest,
} from '../../packages/flowproof/src/project/contracts.js'
import type { Locator, ObservationType } from '../../packages/flowproof/src/project/contracts.js'
import type { LifecycleClock } from '../../packages/flowproof/src/project/run.js'
import {
  PROJECT_REPLAY_COMPILER_SHA256,
  ProjectReplayError,
  createReplaySession,
  compileFrozenReplay,
  executeFrozenReplay,
  isHostFrozenReplay,
  openChromiumReplaySession,
  persistFrozenReplay,
  storedDefinitionMatches,
} from '../../packages/flowproof/src/verify/projectReplay.js'
import type {
  CompileFrozenReplayInput,
  FrozenReplay,
  ReplayCheckpoint,
  ReplayDriver,
  ReplayEvidenceCollector,
  ReplayExecutionResult,
  ReplayFieldKind,
  ReplaySession,
} from '../../packages/flowproof/src/verify/projectReplay.js'
import { createTempDirectory } from '../support/repoFixture.js'

// T034: the host-owned frozen replay. The compiler accepts only the closed S1 DSL bound to the actual
// project, confirmed configuration, sealed capture and interpretation, and rejects executable content,
// unsafe locators, external navigation, unrecorded/reordered/redacted actions and placeholder or
// contradictory expectations before anything runs. The interpreter executes only a host-frozen handle
// in a single-use phase session, resolves unique locators within documented bounds, polls state only in
// bounded waits, and cannot report satisfied conditions without required run-bound evidence.
//
// The executor tests drive an explicitly labelled IN-PROCESS FAKE driver/collector (no browser); the
// opt-in Chromium section (FLOWPROOF_REPLAY_CHROMIUM=1) exercises the real Playwright session on a
// synthetic page served by this file. Neither is a baseline/candidate integration or live acceptance.

type Json = Record<string, unknown>

const id = (seed: number): string => `${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`
const sha = (char: string): string => char.repeat(64)
const REVISION = 'b09f068f7001b8530086dec95b1128d8fdb49286'
const IMAGE_ID = `sha256:${sha('7')}`
const TIME = '2026-11-04T10:00:00.000Z'
const ORIGIN = 'http://localhost:41234'

const RUN = id(1)
const PROJECT = id(2)
const CONFIGURATION = id(3)
const CAPTURE = id(4)
const FRAME = id(5)
const IMAGE_OBSERVATION = id(6)
const CONSOLE_OBSERVATION = id(7)
const NETWORK_OBSERVATION = id(8)
const ANALYSIS = id(9)
const INTERPRETATION = id(10)
const DEFINITION = id(11)
const ARTIFACT = id(12)
const BUILD = sha('5')
const CONSOLE_FINGERPRINT = sha('8')

const testId = (value: string): Json => ({ kind: 'test-id', value })
const role = (name: string, roleName = 'button'): Json => ({ kind: 'role', role: roleName, name })
const css = (selector: string): Json => ({ kind: 'css', selector })

const FILTER = testId('task-filter')
const TITLE = testId('task-title')
const ADD = role('Add task')
const ITEM = testId('task-item')
const SUMMARY = testId('task-summary')
const SECRET = testId('api-key')

// ---------------------------------------------------------------------------------------
// Compile fixtures (synthetic task-list demonstration)
// ---------------------------------------------------------------------------------------

const projectContext = (): Json => ({
  schema_version: 1,
  project_id: PROJECT,
  display_root: '/tmp/flowproof-project-live-abc/repo',
  label: 'repo',
  baseline_commit: REVISION,
  branch: 'main',
  category: 'vite-static-v1',
  admitted_tree_sha256: sha('a'),
  integrity_snapshot: { snapshot_id: id(20), sha256: sha('b') },
  profile: { profile_id: 'vite-static-v1', image_id: IMAGE_ID, dependency_tree_sha256: sha('c'), manifest_sha256: sha('d'), lock_sha256: sha('e') },
  allowed_source_paths: ['src/App.jsx', 'src/main.jsx', 'src/tasks.js'],
  protected_inputs: [
    { path: 'package-lock.json', kind: 'lock', sha256: sha('e') },
    { path: 'package.json', kind: 'package', sha256: sha('f') },
  ],
  admission: { state: 'ready', reasons: [], required_prerequisites: [] },
})

const configurationBody = (origin: string): Json => ({
  schema_version: 1,
  configuration_id: CONFIGURATION,
  project_id: PROJECT,
  baseline_commit: REVISION,
  category: 'vite-static-v1',
  entry_path: '/',
  target_origin: origin,
  build: { argv: ['node', '/opt/flowproof/toolchain/node_modules/vite/bin/vite.js', 'build'], output_directory: 'dist' },
  required_project_checks: [{ id: 'sample-unit', argv: ['node', '--test', 'tests/tasks.test.mjs'] }],
  mandatory_checks: [...MANDATORY_CHECK_IDS],
  inputs: { source_tree_sha256: sha('a'), configuration_sha256: sha('3'), checks_sha256: sha('4'), lock_sha256: sha('e') },
  profile: {
    profile_id: 'vite-static-v1',
    image_id: IMAGE_ID,
    dependency_tree_sha256: sha('c'),
    manifest_sha256: sha('d'),
    network: 'none',
    environment_allowlist: ['CI'],
    limits: { ...EXECUTION_LIMITS },
    byte_limits: { max_output_bytes: 16_777_216, max_output_files: 512, max_diagnostic_bytes: 65_536 },
  },
  confirmation: { state: 'confirmed', confirmed_at: TIME },
})

const interaction = (sequence: number, action: Json): Json => ({
  sequence,
  capture_id: CAPTURE,
  document_epoch: 0,
  frame_id: FRAME,
  offset_ms: sequence * 100,
  action,
  related_observation_ids: [],
})

const RECORDED: Json[] = [
  { type: 'select', locators: [FILTER], value: { kind: 'safe', option: 'open' } },
  { type: 'fill', locators: [TITLE, css('input.title')], value: { kind: 'safe', text: 'Buy milk' } },
  { type: 'click', locators: [ADD, testId('add-task-button')] },
  { type: 'scroll', target: { kind: 'page' }, x: 0, y: 400 },
  { type: 'fill', locators: [SECRET], value: { kind: 'redacted', reason: 'SECRET_FIELD' } },
  { type: 'navigate', path: '/reports' },
]

const demoObservation = (observationId: string, type: ObservationType, availability: 'available' | 'unavailable'): Json => {
  const common = {
    observation_id: observationId,
    run_id: RUN,
    capture_id: CAPTURE,
    baseline_commit: REVISION,
    phase: 'demonstration',
    type,
    availability,
    reason: availability === 'available' ? null : 'COLLECTOR_UNAVAILABLE',
    sequence_range: null,
    policy_version: 'project-privacy-v1',
    redaction_count: 0,
  }
  if (availability === 'unavailable') return { ...common, payload: null }
  if (type === 'image') {
    return {
      ...common,
      payload: {
        viewport: { width: 1280, height: 800 },
        clip: { x: 0, y: 0, width: 1280, height: 800 },
        mask_count: 1,
        masked_before_retention: true,
        build_sha256: BUILD,
        artifact: { artifact_id: ARTIFACT, sha256: sha('6'), bytes: 40_000, media_type: 'image/png' },
      },
    }
  }
  return { ...common, payload: { level: 'error', message: 'TypeError: cannot read properties of undefined', fingerprint: CONSOLE_FINGERPRINT } }
}

const DEFAULT_ACTIONS: Json[] = [
  { op: 'select', locator: FILTER, value: 'open' },
  { op: 'fill', locator: TITLE, value: 'Buy milk' },
  { op: 'click', locator: ADD },
  { op: 'wait', until: { kind: 'visible', locator: SUMMARY }, timeout_ms: 2_000 },
]
const DEFAULT_CONDITIONS: Json[] = [
  { kind: 'element-count', locator: ITEM, count: 1 },
  { kind: 'text', locator: SUMMARY, match: 'normalized', text: '1 open task' },
  { kind: 'no-error', error_type: 'console', fingerprint: CONSOLE_FINGERPRINT },
]

interface Scenario {
  readonly origin?: string
  readonly recorded?: readonly Json[]
  readonly actions?: readonly Json[]
  readonly conditions?: readonly Json[]
  readonly task?: number
  readonly citations?: readonly string[]
}

interface Fixture {
  run_id: string
  project: Json
  configuration: Json
  capture: Json
  interpretation: Json
}

function fixture(scenario: Scenario = {}): Fixture {
  const origin = scenario.origin ?? ORIGIN
  const configuration = withConfigurationDigest(configurationBody(origin) as never) as unknown as Json
  const capture: Json = {
    schema_version: 1,
    capture_id: CAPTURE,
    run_id: RUN,
    project_id: PROJECT,
    baseline_commit: REVISION,
    configuration_id: CONFIGURATION,
    configuration_digest: configuration.configuration_digest,
    target_origin: origin,
    viewport: { width: 1280, height: 800, device_scale_factor: 1 },
    state: 'ready',
    document_epoch: 0,
    interactions: (scenario.recorded ?? RECORDED).map((action, index) => interaction(index + 1, action)),
    observations: [demoObservation(IMAGE_OBSERVATION, 'image', 'available'), demoObservation(CONSOLE_OBSERVATION, 'console', 'available'), demoObservation(NETWORK_OBSERVATION, 'network-error', 'unavailable')],
    counters: { unavailable: 1, unsupported: 0, dropped: 0 },
    completeness: { status: 'complete', reasons: [] },
    timing: { started_offset_ms: 0, finished_offset_ms: 5_000 },
    staged_bytes: 41_000,
    seal: { report_sha256: sha('a') },
  }
  const interpretation: Json = {
    schema_version: 1,
    interpretation_id: INTERPRETATION,
    run_id: RUN,
    invocation_id: ANALYSIS,
    capture_id: CAPTURE,
    report_sha256: sha('a'),
    input_sha256: sha('b'),
    analysis_attempt: 1,
    clarification: null,
    result: {
      status: 'ready',
      observed_problem: 'Adding one task lists it twice.',
      citations: scenario.citations ?? [IMAGE_OBSERVATION],
      replay: { entry_path: '/', viewport: { width: 1280, height: 800, device_scale_factor: 1 }, actions: scenario.actions ?? DEFAULT_ACTIONS },
      expected_conditions: scenario.conditions ?? DEFAULT_CONDITIONS,
      task_condition_index: scenario.task ?? 0,
      intent_summary: 'Adding a task should list it exactly once.',
      support_explanation: 'The image after Add task shows two identical rows.',
    },
  }
  return structuredClone({ run_id: RUN, project: projectContext(), configuration, capture, interpretation })
}

const result = (f: Fixture): Json => f.interpretation.result as Json
const replayOf = (f: Fixture): Json => result(f).replay as Json
const fixedOptions = { now: () => new Date(TIME), newId: () => DEFINITION }

function compiled(scenario: Scenario = {}, mutate: (f: Fixture) => void = () => undefined): FrozenReplay {
  const f = fixture(scenario)
  mutate(f)
  const outcome = compileFrozenReplay(f as unknown as CompileFrozenReplayInput, fixedOptions)
  if (!outcome.ok) throw new Error(`compile failed: ${outcome.reasons.join(',')} ${JSON.stringify(outcome.issues)}`)
  return outcome.frozen
}

function reasonsOf(mutate: (f: Fixture) => void, scenario: Scenario = {}): readonly string[] {
  const f = fixture(scenario)
  mutate(f)
  const outcome = compileFrozenReplay(f as unknown as CompileFrozenReplayInput, fixedOptions)
  return outcome.ok ? [] : outcome.reasons
}

const issueCodes = (mutate: (f: Fixture) => void): readonly string[] => {
  const f = fixture()
  mutate(f)
  const outcome = compileFrozenReplay(f as unknown as CompileFrozenReplayInput, fixedOptions)
  return outcome.ok ? [] : outcome.issues.map((issue) => issue.code)
}

// ---------------------------------------------------------------------------------------
// Compiler: frozen identities
// ---------------------------------------------------------------------------------------

describe('compileFrozenReplay binds a ready interpretation into the S1 frozen definition', () => {
  it('binds every project, baseline, configuration, report, interpretation, check, evidence and compiler identity', () => {
    const f = fixture()
    const before = structuredClone(f)
    const outcome = compileFrozenReplay(f as unknown as CompileFrozenReplayInput, fixedOptions)
    expect(outcome.ok ? [] : outcome.reasons).toEqual([])
    if (!outcome.ok) return
    const { definition, identity } = outcome.frozen

    expect(parseFrozenVerificationDefinition(definition).ok).toBe(true)
    expect(definition).toMatchObject({
      definition_id: DEFINITION,
      run_id: RUN,
      project_id: PROJECT,
      baseline_commit: REVISION,
      configuration_id: CONFIGURATION,
      configuration_digest: f.configuration.configuration_digest,
      capture_id: CAPTURE,
      report_sha256: sha('a'),
      interpretation_id: INTERPRETATION,
      interpretation_sha256: projectDigest(f.interpretation),
      task_condition_index: 0,
      required_checks: [...MANDATORY_CHECK_IDS, 'project_check:sample-unit'],
      required_evidence: ['image', 'console'],
      compiler: { id: 'flowproof-project-replay', version: '1.0.0' },
      protected_digests: { source_tree_sha256: sha('a'), configuration_sha256: sha('3'), checks_sha256: sha('4'), lock_sha256: sha('e') },
      frozen_at: TIME,
    })
    // Entry state, viewport and action ordering are exactly the interpretation's (data only).
    expect(definition.replay).toEqual(replayOf(f))
    expect(definition.expected_conditions).toEqual(result(f).expected_conditions)
    expect(identity).toMatchObject({
      definition_digest: definition.definition_digest,
      project_context_sha256: projectDigest(f.project),
      admitted_tree_sha256: sha('a'),
      target_origin: ORIGIN,
      compiler_sha256: PROJECT_REPLAY_COMPILER_SHA256,
    })
    expect(outcome.frozen.record_sha256).toBe(projectDigest(identity))
    expect(isHostFrozenReplay(outcome.frozen)).toBe(true)
    // Pure: no input is mutated.
    expect(f).toEqual(before)
  })

  it('is deterministic for identical inputs and changes digests when any bound identity changes', () => {
    const first = compiled()
    const second = compiled()
    expect(second.definition.definition_digest).toBe(first.definition.definition_digest)
    const reworded = compiled({}, (f) => {
      result(f).intent_summary = 'Adding a task must create one row.'
    })
    expect(reworded.definition.interpretation_sha256).not.toBe(first.definition.interpretation_sha256)
    expect(reworded.definition.definition_digest).not.toBe(first.definition.definition_digest)
    const otherProject = compiled({}, (f) => {
      ;(f.project.allowed_source_paths as string[]).push('src/extra.js')
    })
    expect(otherProject.identity.project_context_sha256).not.toBe(first.identity.project_context_sha256)
    expect(otherProject.record_sha256).not.toBe(first.record_sha256)
  })

  it('deep-freezes the handle so host definitions cannot be edited after freezing', () => {
    const frozen = compiled()
    expect(() => (frozen.definition.replay.actions as unknown as Json[]).push({ op: 'click', locator: ADD })).toThrow(TypeError)
    expect(() => {
      ;(frozen.definition.expected_conditions[0] as unknown as Json).count = 2
    }).toThrow(TypeError)
    expect(() => {
      ;(frozen.identity as unknown as Json).target_origin = 'http://localhost:9999'
    }).toThrow(TypeError)
    // Copies are data, not host-frozen handles.
    expect(isHostFrozenReplay(structuredClone(frozen))).toBe(false)
    expect(isHostFrozenReplay({ ...frozen })).toBe(false)
    expect(isHostFrozenReplay(JSON.parse(JSON.stringify(frozen)))).toBe(false)
  })
})

describe('compileFrozenReplay rejects before freezing', () => {
  it.each([
    ['evaluate', { op: 'evaluate', script: 'document.body.innerHTML = ""' }],
    ['shell', { op: 'shell', argv: ['sh', '-c', 'rm -rf /'] }],
    ['request', { op: 'request', url: 'http://localhost:41234/api/reset' }],
    ['module', { op: 'import', module: './helpers.js' }],
    ['keyboard', { op: 'press', key: 'Control+Shift+I' }],
  ])('model %s operations as unsupported executable content', (_name, action) => {
    const reasons = reasonsOf((f) => {
      ;(replayOf(f).actions as Json[]).push(action)
    })
    expect(reasons).toContain('REPLAY_OPERATION_UNSUPPORTED')
    expect(reasons).toContain('INTERPRETATION_INVALID')
  })

  it('code smuggled into allowed operations, waits and conditions', () => {
    expect(issueCodes((f) => ((replayOf(f).actions as Json[])[2] = { op: 'click', locator: ADD, script: 'alert(1)' }))).toContain('UNRECOGNIZED_KEYS')
    expect(reasonsOf((f) => (replayOf(f).actions as Json[]).push({ op: 'wait', until: { kind: 'function', body: 'return true' }, timeout_ms: 100 }))).toContain(
      'WAIT_CONDITION_UNSUPPORTED',
    )
    expect(reasonsOf((f) => (result(f).expected_conditions as Json[]).push({ kind: 'script', code: 'return true' }))).toContain('CONDITION_KIND_UNSUPPORTED')
    expect(reasonsOf((f) => ((result(f).expected_conditions as Json[])[1] = { kind: 'text', locator: SUMMARY, match: 'regex', text: '^1 open' }))).toContain(
      'INTERPRETATION_INVALID',
    )
    expect(reasonsOf((f) => ((result(f).expected_conditions as Json[])[1] = { kind: 'text', locator: SUMMARY, match: 'exact', text: '1', pattern: '/1/' }))).toContain(
      'INTERPRETATION_INVALID',
    )
  })

  it.each(['//button', 'xpath=//button', 'text=Add task', 'button >> nth=0', 'a[href^="javascript:"]', 'div:has-text("Add")', '#add, #remove', 'button​'])(
    'unsafe selector %j',
    (selector) => {
      const codes = issueCodes((f) => ((replayOf(f).actions as Json[])[2] = { op: 'click', locator: css(selector) }))
      expect(codes.length).toBeGreaterThan(0)
      expect(compileFrozenReplay(Object.assign(fixture(), {}) as unknown as CompileFrozenReplayInput, fixedOptions).ok).toBe(true)
    },
  )

  it('role locators without a safe accessible name and global document selectors', () => {
    expect(reasonsOf((f) => (result(f).expected_conditions as Json[]).push({ kind: 'element-visible', locator: role('  '), visible: true }))).toContain('LOCATOR_UNSAFE')
    for (const selector of ['body', '*', 'html > body', 'body *']) {
      expect(reasonsOf((f) => ((result(f).expected_conditions as Json[])[1] = { kind: 'element-visible', locator: css(selector), visible: true }))).toContain(
        'CONDITION_PLACEHOLDER',
      )
    }
    expect(reasonsOf((f) => ((replayOf(f).actions as Json[])[3] = { op: 'wait', until: { kind: 'visible', locator: css('body') }, timeout_ms: 100 }))).toContain(
      'LOCATOR_GLOBAL',
    )
  })

  it.each(['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example', 'http://localhost:41234/reports', '/%2e%2e/admin', '/a/../b'])(
    'external or non-canonical navigation %j',
    (target) => {
      const codes = issueCodes((f) => (replayOf(f).actions as Json[]).push({ op: 'navigate', path: target }))
      expect(codes).toContain('URL_PATH_INVALID')
    },
  )

  it('actions that were not demonstrated, are reordered or use values that were never admitted', () => {
    const replace = (index: number, action: Json) => (f: Fixture) => {
      ;(replayOf(f).actions as Json[])[index] = action
    }
    expect(reasonsOf((f) => (replayOf(f).actions as Json[]).push({ op: 'navigate', path: '/admin' }))).toEqual(['REPLAY_ACTION_NOT_RECORDED'])
    expect(reasonsOf(replace(2, { op: 'click', locator: role('Delete all') }))).toEqual(['REPLAY_ACTION_NOT_RECORDED'])
    // A locator the recorder did not offer for that interaction is not substituted.
    expect(reasonsOf(replace(2, { op: 'click', locator: css('button.add') }))).toEqual(['REPLAY_ACTION_NOT_RECORDED'])
    expect(reasonsOf(replace(1, { op: 'fill', locator: TITLE, value: 'Buy bread' }))).toEqual(['REPLAY_VALUE_NOT_ADMITTED'])
    expect(reasonsOf(replace(0, { op: 'select', locator: FILTER, value: 'done' }))).toEqual(['REPLAY_VALUE_NOT_ADMITTED'])
    expect(reasonsOf(replace(3, { op: 'scroll', target: { kind: 'page' }, x: 0, y: 500 }))).toEqual(['REPLAY_VALUE_NOT_ADMITTED'])
    // A redacted demonstration value is never replaced by a guessed one.
    expect(reasonsOf(replace(3, { op: 'fill', locator: SECRET, value: 'hunter2' }))).toEqual(['REPLAY_VALUE_REDACTED'])
    expect(
      reasonsOf((f) => {
        replayOf(f).actions = [
          { op: 'click', locator: ADD },
          { op: 'select', locator: FILTER, value: 'open' },
        ]
      }),
    ).toEqual(['REPLAY_ORDER_MISMATCH'])
    // A recorded subsequence in order, including the second fill candidate, is accepted.
    expect(reasonsOf(replace(1, { op: 'fill', locator: css('input.title'), value: 'Buy milk' }))).toEqual([])
  })

  it('changed entry state, viewport and over-budget or oversized replays', () => {
    expect(reasonsOf((f) => (replayOf(f).entry_path = '/reports'))).toContain('ENTRY_PATH_MISMATCH')
    expect(reasonsOf((f) => (replayOf(f).viewport = { width: 390, height: 844, device_scale_factor: 1 }))).toContain('VIEWPORT_MISMATCH')
    const waits = (count: number): Json[] => Array.from({ length: count }, () => ({ op: 'wait', until: { kind: 'visible', locator: ITEM }, timeout_ms: PROJECT_LIMITS.maxWaitMs }))
    const withWaits = (count: number) => (f: Fixture) => {
      replayOf(f).actions = [...DEFAULT_ACTIONS, ...waits(count)]
    }
    expect(reasonsOf(withWaits(11))).toEqual([])
    expect(reasonsOf(withWaits(12))).toEqual(['REPLAY_WAIT_BUDGET_EXCEEDED'])
    expect(reasonsOf((f) => ((replayOf(f).actions as Json[])[3] = { op: 'wait', until: { kind: 'visible', locator: SUMMARY }, timeout_ms: PROJECT_LIMITS.maxWaitMs + 1 }))).toContain(
      'INTERPRETATION_INVALID',
    )
    const clicks = Array.from({ length: PROJECT_LIMITS.maxReplayActions + 1 }, () => ({ op: 'click', locator: ADD }))
    expect(reasonsOf((f) => (replayOf(f).actions = clicks))).toContain('INTERPRETATION_INVALID')
  })

  it('accepts 1 to 8 conjunctive conditions only', () => {
    const counts = (n: number): Json[] => Array.from({ length: n }, (_, index) => ({ kind: 'element-count', locator: testId(`row-${index}`), count: 1 }))
    expect(reasonsOf((f) => (result(f).expected_conditions = []))).toContain('INTERPRETATION_INVALID')
    expect(reasonsOf((f) => (result(f).expected_conditions = counts(1)))).toEqual([])
    expect(reasonsOf((f) => (result(f).expected_conditions = counts(8)))).toEqual([])
    expect(reasonsOf((f) => (result(f).expected_conditions = counts(9)))).toContain('INTERPRETATION_INVALID')
    expect(reasonsOf((f) => (result(f).expected_conditions = [...counts(1), ...counts(1)]))).toContain('INTERPRETATION_INVALID')
    expect(reasonsOf((f) => (result(f).task_condition_index = 3))).toContain('INTERPRETATION_INVALID')
  })

  it('placeholder, contradictory and tautological expectations', () => {
    const set = (conditions: Json[], task = 0) => (f: Fixture) => {
      result(f).expected_conditions = conditions
      result(f).task_condition_index = task
    }
    // An error that was never observed (or was observed by another collector) is trivially absent.
    expect(reasonsOf(set([{ kind: 'no-error', error_type: 'console', fingerprint: sha('9') }]))).toEqual(['CONDITION_ERROR_NOT_OBSERVED'])
    expect(reasonsOf(set([{ kind: 'no-error', error_type: 'page-error', fingerprint: CONSOLE_FINGERPRINT }]))).toEqual(['CONDITION_ERROR_NOT_OBSERVED'])
    const contradictions: Json[][] = [
      [
        { kind: 'element-visible', locator: ITEM, visible: true },
        { kind: 'element-visible', locator: ITEM, visible: false },
      ],
      [
        { kind: 'element-count', locator: ITEM, count: 1 },
        { kind: 'element-count', locator: ITEM, count: 2 },
      ],
      [
        { kind: 'element-visible', locator: ITEM, visible: true },
        { kind: 'element-count', locator: ITEM, count: 0 },
      ],
      [
        { kind: 'text', locator: SUMMARY, match: 'exact', text: '1 open task' },
        { kind: 'text', locator: SUMMARY, match: 'normalized', text: '2 open tasks' },
      ],
      [
        { kind: 'form-value', locator: TITLE, value: 'a' },
        { kind: 'form-value', locator: TITLE, value: 'b' },
      ],
      [
        { kind: 'path', path: '/' },
        { kind: 'path', path: '/reports' },
      ],
    ]
    for (const conditions of contradictions) expect(reasonsOf(set(conditions))).toEqual(['CONDITIONS_CONTRADICTORY'])
    // Hidden-but-present and absence are consistent states.
    expect(
      reasonsOf(
        set([
          { kind: 'element-visible', locator: ITEM, visible: false },
          { kind: 'element-count', locator: ITEM, count: 1 },
        ]),
      ),
    ).toEqual([])
    // A task condition already asserted by the trailing wait cannot fail in the intended way.
    expect(reasonsOf(set([{ kind: 'element-visible', locator: SUMMARY, visible: true }]))).toEqual(['TASK_CONDITION_TAUTOLOGICAL'])
    expect(
      reasonsOf((f) => {
        set([{ kind: 'element-visible', locator: SUMMARY, visible: true }])(f)
        replayOf(f).actions = [DEFAULT_ACTIONS[3], DEFAULT_ACTIONS[0]]
      }),
    ).toEqual([])
  })

  it('stale, foreign or unready identities and unresolved interpretations', () => {
    const cases: [string, (f: Fixture) => void][] = [
      ['RUN_MISMATCH', (f) => (f.run_id = id(99))],
      ['PROJECT_NOT_READY', (f) => (f.project.admission = { state: 'stale', reasons: ['BASELINE_MOVED'], required_prerequisites: [] })],
      ['BASELINE_STALE', (f) => (f.project.baseline_commit = 'c'.repeat(40))],
      ['PROFILE_MISMATCH', (f) => ((f.project.profile as Json).manifest_sha256 = sha('0'))],
      ['LOCK_MISMATCH', (f) => ((f.project.profile as Json).lock_sha256 = sha('0'))],
      ['CONFIGURATION_STALE', (f) => (f.capture.configuration_digest = sha('9'))],
      ['TARGET_ORIGIN_MISMATCH', (f) => (f.capture.target_origin = 'http://localhost:41235')],
      ['REPORT_MISMATCH', (f) => (f.interpretation.report_sha256 = sha('b'))],
      ['CITATION_UNKNOWN', (f) => (result(f).citations = [id(77)])],
      ['CITATION_UNAVAILABLE', (f) => (result(f).citations = [NETWORK_OBSERVATION])],
      [
        'CONFIGURATION_NOT_CONFIRMED',
        (f) => {
          f.configuration = withConfigurationDigest({ ...configurationBody(ORIGIN), confirmation: { state: 'pending' } } as never) as unknown as Json
        },
      ],
      [
        'CAPTURE_NOT_READY',
        (f) => {
          Object.assign(f.capture, { state: 'incomplete', completeness: { status: 'incomplete', reasons: ['ACTION_LIMIT_EXCEEDED'] }, counters: { unavailable: 1, unsupported: 0, dropped: 3 } })
        },
      ],
      [
        'INTERPRETATION_AMBIGUOUS',
        (f) => {
          f.interpretation.result = {
            status: 'clarify',
            observed_facts: 'Two rows appear after Add task.',
            citations: [IMAGE_OBSERVATION],
            question: { question_id: id(30), text: 'Should duplicates ever be allowed?', missing_intent: 'Whether duplicate titles are intended.', alternatives: [] },
          }
        },
      ],
      [
        'INTERPRETATION_UNSUPPORTED',
        (f) => (f.interpretation.result = { status: 'unsupported', reason: 'CANVAS_ONLY', explanation: 'The defect is drawn on a canvas.', citations: [] }),
      ],
    ]
    for (const [reason, mutate] of cases) expect(reasonsOf(mutate), reason).toContain(reason)
    expect(reasonsOf((f) => (f.capture.seal = null))).toContain('CAPTURE_INVALID')
    expect(compileFrozenReplay(null as unknown as CompileFrozenReplayInput).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
// In-process FAKE driver/collector (labelled; not a browser)
// ---------------------------------------------------------------------------------------

interface FakeClock extends LifecycleClock {
  advanceNext(): boolean
  pending(): number
  /** Moves time forward without firing timers, like a primitive that blocked the event loop. */
  jump(ms: number): void
}

function fakeClock(): FakeClock {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimer(callback, ms) {
      const handle = next
      next += 1
      timers.set(handle, { at: now + ms, callback })
      return handle
    },
    clearTimer(handle) {
      timers.delete(handle as number)
    },
    advanceNext() {
      const due = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) return false
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].callback()
      return true
    },
    pending: () => timers.size,
    jump(ms) {
      now += ms
    },
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Drives fake time only while the execution is otherwise idle. */
async function settle<T>(promise: Promise<T>, clock: FakeClock): Promise<T> {
  let done = false
  let value: T | undefined
  let failure: unknown
  promise.then(
    (resolved) => {
      done = true
      value = resolved
    },
    (error: unknown) => {
      done = true
      failure = error
    },
  )
  for (let index = 0; index < 20_000 && !done; index += 1) {
    await tick()
    if (!done) clock.advanceNext()
  }
  if (!done) throw new Error('execution did not settle')
  if (failure !== undefined) throw failure
  return value as T
}

interface FakeElement {
  readonly key: string
  readonly testId?: string
  readonly role?: string
  readonly name?: string
  readonly css?: readonly string[]
  visible: boolean
  text: string | null
  value: string
  kind: ReplayFieldKind
  appearsAt?: number
}

/** IN-PROCESS FAKE target page: a minimal element table, not a DOM or browser. */
class FakePage {
  url = 'about:blank'
  readonly calls: string[] = []
  readonly violationCodes: string[] = []
  elements: FakeElement[] = []
  readonly onClick = new Map<string, () => void>()
  navigateStatus: number | null = 200
  viewportSize: { width: number; height: number } | null = { width: 1280, height: 800 }
  hang: { readonly method: string; resolveOnRelease: boolean; resolve?: () => void; onStart?: () => void } | null = null
  activeHang: FakePage['hang'] = null
  released = 0
  releaseFails = false
  /** Timeout argument each primitive received, per method. */
  readonly timeouts = new Map<string, number[]>()
  /** Synchronous time a primitive takes, from the timeout it received. */
  readonly durations = new Map<string, (timeoutMs: number) => number>()
  /** Side effect run when a primitive is called (for example a hostile popup). */
  readonly onCall = new Map<string, () => void>()
  onRelease: (() => void) | null = null
  onUrlRead: (() => void) | null = null

  constructor(readonly clock: FakeClock) {}

  matches(locator: Locator): FakeElement[] {
    return this.elements.filter((element) => {
      if (element.appearsAt !== undefined && this.clock.now() < element.appearsAt) return false
      if (locator.kind === 'test-id') return element.testId === locator.value
      if (locator.kind === 'role') return element.role === locator.role && element.name === locator.name
      return element.css?.includes(locator.selector) ?? false
    })
  }

  one(locator: Locator): FakeElement {
    const [element, ...rest] = this.matches(locator)
    if (element === undefined || rest.length > 0) throw new Error('strict mode violation')
    return element
  }

  private record<T>(method: string, detail: string, timeoutMs: number | null, run: () => T): Promise<T> {
    this.calls.push(detail === '' ? method : `${method}:${detail}`)
    if (timeoutMs !== null) this.timeouts.set(method, [...(this.timeouts.get(method) ?? []), timeoutMs])
    this.onCall.get(method)?.()
    const duration = this.durations.get(method)
    if (duration !== undefined && timeoutMs !== null) this.clock.jump(duration(timeoutMs))
    if (this.hang?.method === method) {
      const hang = this.hang
      this.hang = null
      this.activeHang = hang
      const pending = new Promise<T>((resolve) => {
        hang.resolve = () => resolve(run())
      })
      hang.onStart?.()
      return pending
    }
    return Promise.resolve().then(run)
  }

  driver(): ReplayDriver {
    const key = (locator: Locator): string => canonicalJson(locator)
    return {
      viewport: () => this.viewportSize,
      navigate: (url, timeout) =>
        this.record('navigate', url, timeout, () => {
          this.url = url
          return { status: this.navigateStatus }
        }),
      currentUrl: () => {
        this.onUrlRead?.()
        return this.url
      },
      count: (locator, timeout) => this.record('count', key(locator), timeout, () => this.matches(locator).length),
      isVisible: (locator, timeout) => this.record('isVisible', key(locator), timeout, () => this.one(locator).visible),
      fieldKind: (locator, timeout) => this.record('fieldKind', key(locator), timeout, () => this.one(locator).kind),
      click: (locator, timeout) =>
        this.record('click', key(locator), timeout, () => {
          this.onClick.get(this.one(locator).key)?.()
        }),
      fill: (locator, value, timeout) =>
        this.record('fill', `${key(locator)}=${value}`, timeout, () => {
          this.one(locator).value = value
        }),
      select: (locator, value, timeout) =>
        this.record('select', `${key(locator)}=${value}`, timeout, () => {
          this.one(locator).value = value
        }),
      scroll: (locator, x, y, timeout) => this.record('scroll', `${locator === null ? 'page' : key(locator)}@${x},${y}`, timeout, () => undefined),
      text: (locator, timeout) => this.record('text', key(locator), timeout, () => this.one(locator).text),
      value: (locator, timeout) => this.record('value', key(locator), timeout, () => this.one(locator).value),
      violations: () => this.violationCodes,
    }
  }

  release = async (): Promise<void> => {
    this.released += 1
    this.onRelease?.()
    // Like closing a browser context, release settles a call that was left in flight.
    if (this.activeHang?.resolveOnRelease === true) this.activeHang.resolve?.()
    if (this.releaseFails) throw new Error('context close failed')
  }

  sideEffects(): string[] {
    return this.calls.filter((call) => !call.startsWith('count') && !call.startsWith('isVisible') && !call.startsWith('text') && !call.startsWith('value'))
  }
}

/** A synthetic task app on the fake page; `duplicates` reproduces the demonstrated defect. */
function taskApp(clock: FakeClock, options: { readonly duplicates: boolean }): FakePage {
  const page = new FakePage(clock)
  const items = (): FakeElement[] => page.elements.filter((element) => element.testId === 'task-item')
  page.elements = [
    { key: 'filter', testId: 'task-filter', visible: true, text: null, value: 'all', kind: 'select' },
    { key: 'title', testId: 'task-title', css: ['input.title'], visible: true, text: null, value: '', kind: 'text' },
    { key: 'add', role: 'button', name: 'Add task', testId: 'add-task-button', visible: true, text: 'Add task', value: '', kind: 'unsupported' },
    { key: 'summary', testId: 'task-summary', visible: true, text: '0 open tasks', value: '', kind: 'unsupported' },
    { key: 'secret', testId: 'api-key', visible: true, text: null, value: '', kind: 'unsupported' },
  ]
  page.onClick.set('add', () => {
    const copies = options.duplicates ? 2 : 1
    for (let index = 0; index < copies; index += 1) {
      page.elements.push({ key: `item-${items().length}`, testId: 'task-item', visible: true, text: 'Buy milk', value: '', kind: 'unsupported' })
    }
    const summary = page.elements.find((element) => element.key === 'summary')
    if (summary !== undefined) summary.text = `${items().length} open task${items().length === 1 ? '' : 's'}`
  })
  return page
}

const phaseImage = (overrides: { run?: string; phase?: string; build?: string; baseline?: string } = {}): Json => ({
  observation_id: id(40),
  run_id: overrides.run ?? RUN,
  capture_id: null,
  baseline_commit: overrides.baseline ?? REVISION,
  phase: overrides.phase ?? 'baseline',
  type: 'image',
  availability: 'available',
  reason: null,
  sequence_range: null,
  policy_version: 'project-privacy-v1',
  redaction_count: 0,
  payload: {
    viewport: { width: 1280, height: 800 },
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    mask_count: 1,
    masked_before_retention: true,
    build_sha256: overrides.build ?? BUILD,
    artifact: { artifact_id: id(41), sha256: sha('d'), bytes: 30_000, media_type: 'image/png' },
  },
})

const phaseConsole = (phase = 'baseline', availability: 'available' | 'unavailable' = 'available'): Json => ({
  observation_id: id(42),
  run_id: RUN,
  capture_id: null,
  baseline_commit: REVISION,
  phase,
  type: 'console',
  availability,
  reason: availability === 'available' ? null : 'COLLECTOR_UNAVAILABLE',
  sequence_range: null,
  policy_version: 'project-privacy-v1',
  redaction_count: 0,
  payload: availability === 'available' ? { level: 'error', message: 'TypeError: duplicate key', fingerprint: CONSOLE_FINGERPRINT } : null,
})

/** IN-PROCESS FAKE collector: attests availability and returns prepared observations. */
function fakeCollector(
  options: {
    readonly available?: readonly ObservationType[]
    readonly observations?: readonly Json[]
    readonly onCheckpoint?: (point: ReplayCheckpoint) => void
    readonly onDrain?: () => void
  } = {},
): ReplayEvidenceCollector & {
  readonly checkpoints: ReplayCheckpoint[]
} {
  const checkpoints: ReplayCheckpoint[] = []
  const available = new Set(options.available ?? ['image', 'console'])
  return {
    checkpoints,
    available: (type) => available.has(type),
    checkpoint: async (point) => {
      checkpoints.push(point)
      options.onCheckpoint?.(point)
    },
    drain: async () => {
      options.onDrain?.()
      return options.observations ?? [phaseImage()]
    },
  }
}

const binding = (frozen: FrozenReplay, overrides: Json = {}): Json => ({
  run_id: frozen.definition.run_id,
  phase: 'baseline',
  definition_id: frozen.definition.definition_id,
  definition_digest: frozen.definition.definition_digest,
  target_origin: frozen.identity.target_origin,
  build_sha256: BUILD,
  ...overrides,
})

interface Execution {
  readonly page: FakePage
  readonly clock: FakeClock
  readonly result: ReplayExecutionResult
  readonly session: ReplaySession
}

async function execute(
  frozen: unknown,
  options: {
    readonly page?: (clock: FakeClock) => FakePage
    readonly binding?: Json
    readonly collector?: ReplayEvidenceCollector | null
    readonly signal?: AbortSignal
    readonly during?: (page: FakePage, controller: AbortController) => void
  } = {},
): Promise<Execution> {
  const clock = fakeClock()
  const page = (options.page ?? ((c) => taskApp(c, { duplicates: true })))(clock)
  const collector = options.collector === undefined ? fakeCollector() : options.collector
  const session = createReplaySession({
    binding: options.binding ?? binding(frozen as FrozenReplay),
    driver: page.driver(),
    ...(collector === null ? {} : { collector }),
    release: page.release,
  })
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal
  const running = executeFrozenReplay(frozen, session, { signal, clock })
  options.during?.(page, controller)
  const result = await settle(running, clock)
  return { page, clock, result, session }
}

const statuses = (result: ReplayExecutionResult) => ({
  actions: result.actions.map((action) => action.status),
  conditions: result.conditions.map((condition) => condition.status),
})

// ---------------------------------------------------------------------------------------
// Interpreter: authority, locators, conditions, evidence, bounds and cancellation
// ---------------------------------------------------------------------------------------

describe('executeFrozenReplay authority checks happen before any browser call', () => {
  it('executes only the host-frozen handle; copies and JSON from editable storage are rejected', async () => {
    const frozen = compiled()
    for (const forged of [structuredClone(frozen), { ...frozen }, JSON.parse(JSON.stringify(frozen)), frozen.definition]) {
      const { page, result } = await execute(forged, { binding: binding(frozen) })
      expect(result.outcome).toBe('rejected')
      expect(result.reason).toBe('DEFINITION_NOT_HOST_FROZEN')
      expect(page.calls).toEqual([])
      expect(page.released).toBe(1)
      expect(result.released).toBe(true)
    }
  })

  it('rejects wrong phase, run, definition, origin or build bindings', async () => {
    const frozen = compiled()
    const other = compiled({}, (f) => {
      result(f).observed_problem = 'Another interpretation of the same report.'
    })
    const cases: [Json, string][] = [
      [{ definition_digest: other.definition.definition_digest }, 'REPLAY_BINDING_MISMATCH'],
      [{ definition_id: id(50) }, 'REPLAY_BINDING_MISMATCH'],
      [{ run_id: id(51) }, 'REPLAY_BINDING_MISMATCH'],
      [{ target_origin: 'http://localhost:41235' }, 'REPLAY_BINDING_MISMATCH'],
      [{ target_origin: 'http://127.0.0.1:41234' }, 'REPLAY_BINDING_INVALID'],
      [{ phase: 'demonstration' }, 'REPLAY_BINDING_INVALID'],
      [{ build_sha256: 'not-a-digest' }, 'REPLAY_BINDING_INVALID'],
      [{ extra: true }, 'REPLAY_BINDING_INVALID'],
    ]
    for (const [overrides, reason] of cases) {
      const { page, result } = await execute(frozen, { binding: binding(frozen, overrides) })
      expect(result.outcome, reason).toBe('rejected')
      expect(result.reason).toBe(reason)
      expect(page.calls).toEqual([])
      expect(page.released).toBe(1)
    }
  })

  it('makes every phase session single-use so no browser state carries over', async () => {
    const frozen = compiled()
    const first = await execute(frozen)
    expect(first.result.outcome).toBe('conditions-unsatisfied')
    const callsAfterFirst = first.page.calls.length
    const again = await settle(executeFrozenReplay(frozen, first.session, { clock: first.clock }), first.clock)
    expect(again.outcome).toBe('rejected')
    expect(again.reason).toBe('REPLAY_SESSION_REUSED')
    expect(first.page.calls.length).toBe(callsAfterFirst)
    expect(first.page.released).toBe(1)
    const unknown = await executeFrozenReplay(frozen, Object.freeze({ kind: 'project-replay-session' }) as ReplaySession)
    expect(unknown.reason).toBe('REPLAY_SESSION_UNKNOWN')
  })

  it('rejects a session whose actual viewport is not the demonstrated one', async () => {
    const frozen = compiled()
    const { page, result } = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: true })
        app.viewportSize = { width: 1280, height: 720 }
        return app
      },
    })
    expect(result.reason).toBe('REPLAY_VIEWPORT_MISMATCH')
    expect(page.calls).toEqual([])
  })
})

describe('executeFrozenReplay interprets the closed DSL in frozen order', () => {
  it('reproduces the demonstrated defect and passes the same conditions on a corrected target', async () => {
    const frozen = compiled()
    const collector = fakeCollector({ observations: [phaseImage(), phaseConsole()] })
    const baseline = await execute(frozen, { collector })
    expect(baseline.result.outcome).toBe('conditions-unsatisfied')
    expect(baseline.result.reason).toBeNull()
    expect(statuses(baseline.result)).toEqual({ actions: ['executed', 'executed', 'executed', 'executed'], conditions: ['unsatisfied', 'unsatisfied', 'unsatisfied'] })
    expect(baseline.result.task_condition).toEqual({ index: 0, status: 'unsatisfied' })
    // Entry first, then exact values in recorded order; nothing else touches the page.
    expect(baseline.page.sideEffects()).toEqual([
      `navigate:${ORIGIN}/`,
      `fieldKind:${canonicalJson(FILTER)}`,
      `select:${canonicalJson(FILTER)}=open`,
      `fieldKind:${canonicalJson(TITLE)}`,
      `fill:${canonicalJson(TITLE)}=Buy milk`,
      `click:${canonicalJson(ADD)}`,
    ])
    expect(collector.checkpoints.map((point) => `${point.kind}:${point.action_index ?? ''}`)).toEqual(['start:', 'action:0', 'action:1', 'action:2', 'action:3', 'end:'])
    expect(baseline.result.evidence).toEqual([
      { observation_id: id(40), type: 'image', sha256: sha('d') },
      { observation_id: id(42), type: 'console', sha256: expect.any(String) },
    ])
    expect(baseline.clock.now()).toBe(0)

    const candidate = await execute(frozen, {
      page: (clock) => taskApp(clock, { duplicates: false }),
      binding: binding(frozen, { phase: 'candidate' }),
      collector: fakeCollector({ observations: [phaseImage({ phase: 'candidate' })] }),
    })
    expect(candidate.result.outcome).toBe('conditions-satisfied')
    expect(statuses(candidate.result).conditions).toEqual(['satisfied', 'satisfied', 'satisfied'])
    expect(candidate.result.binding?.phase).toBe('candidate')
    expect(candidate.result.released && candidate.result.joined).toBe(true)
    expect(Object.isFrozen(candidate.result.conditions[0])).toBe(true)
  })

  it('fails ambiguous or missing locators without acting on any element', async () => {
    const frozen = compiled()
    const ambiguous = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: true })
        app.elements.push({ key: 'add-2', role: 'button', name: 'Add task', visible: true, text: 'Add task', value: '', kind: 'unsupported' })
        return app
      },
    })
    expect(ambiguous.result.outcome).toBe('operational-failure')
    expect(ambiguous.result.reason).toBe('LOCATOR_AMBIGUOUS')
    expect(statuses(ambiguous.result)).toEqual({ actions: ['executed', 'executed', 'failed', 'not_executed'], conditions: ['not_evaluated', 'not_evaluated', 'not_evaluated'] })
    expect(ambiguous.page.calls.some((call) => call.startsWith('click'))).toBe(false)
    // Resolution is bounded by the documented wait limit, not an open-ended retry.
    expect(ambiguous.clock.now()).toBeGreaterThanOrEqual(PROJECT_LIMITS.maxWaitMs)
    expect(ambiguous.clock.now()).toBeLessThanOrEqual(PROJECT_LIMITS.maxWaitMs + 100)

    const missing = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: true })
        app.elements = app.elements.filter((element) => element.key !== 'add')
        return app
      },
    })
    expect(missing.result.reason).toBe('LOCATOR_NOT_FOUND')
    expect(missing.page.calls.some((call) => call.startsWith('click'))).toBe(false)
  })

  it('waits for a late element by polling state, never by a fixed delay', async () => {
    const frozen = compiled()
    const late = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: false })
        const add = app.elements.find((element) => element.key === 'add')
        if (add !== undefined) add.appearsAt = 350
        return app
      },
      collector: fakeCollector({ observations: [phaseImage()] }),
    })
    expect(late.result.outcome).toBe('conditions-satisfied')
    expect(late.clock.now()).toBe(400)
  })

  it('fills only supported text fields and selects only native selects', async () => {
    const fillSecret = compiled({ recorded: [{ type: 'fill', locators: [SECRET], value: { kind: 'safe', text: 'synthetic' } }], actions: [{ op: 'fill', locator: SECRET, value: 'synthetic' }] })
    const filled = await execute(fillSecret)
    expect(filled.result.reason).toBe('FILL_TARGET_UNSUPPORTED')
    expect(filled.page.calls.some((call) => call.startsWith('fill'))).toBe(false)

    const selectText = compiled({ recorded: [{ type: 'select', locators: [TITLE], value: { kind: 'safe', option: 'open' } }], actions: [{ op: 'select', locator: TITLE, value: 'open' }] })
    const selected = await execute(selectText)
    expect(selected.result.reason).toBe('SELECT_TARGET_UNSUPPORTED')
    expect(selected.page.calls.some((call) => call.startsWith('select'))).toBe(false)
  })

  it('stops when the page leaves the target origin, errors on entry or opens a popup', async () => {
    const frozen = compiled()
    const left = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: false })
        app.onClick.set('add', () => {
          app.url = 'chrome-error://chromewebdata/'
        })
        return app
      },
    })
    expect(left.result.reason).toBe('NAVIGATION_LEFT_TARGET')
    expect(statuses(left.result).actions).toEqual(['executed', 'executed', 'failed', 'not_executed'])

    const notFound = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: false })
        app.navigateStatus = 404
        return app
      },
    })
    expect(notFound.result.reason).toBe('NAVIGATION_HTTP_ERROR')
    expect(notFound.page.sideEffects()).toEqual([`navigate:${ORIGIN}/`])

    const popup = await execute(frozen, {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: false })
        app.onClick.set('add', () => app.violationCodes.push('REPLAY_POPUP'))
        return app
      },
    })
    expect(popup.result.reason).toBe('REPLAY_POPUP')
  })

  it('navigates only to the frozen same-origin path and checks the resulting path', async () => {
    const frozen = compiled({
      actions: [
        { op: 'navigate', path: '/reports' },
        { op: 'wait', until: { kind: 'path', path: '/reports' }, timeout_ms: 500 },
      ],
      conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }],
    })
    const { page, result } = await execute(frozen, { collector: fakeCollector({ observations: [phaseImage()] }) })
    expect(result.outcome).toBe('conditions-satisfied')
    expect(page.sideEffects()).toEqual([`navigate:${ORIGIN}/`, `navigate:${ORIGIN}/reports`])
  })

  it('bounds a wait that never becomes true and reports it as an operational failure', async () => {
    const frozen = compiled({
      actions: [...DEFAULT_ACTIONS.slice(0, 3), { op: 'wait', until: { kind: 'text', locator: SUMMARY, text: '9 open tasks' }, timeout_ms: 1_500 }],
    })
    const { result, clock } = await execute(frozen)
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('WAIT_TIMEOUT')
    expect(clock.now()).toBe(1_500)
    expect(result.task_condition).toEqual({ index: 0, status: 'not_evaluated' })
  })

  it('evaluates hidden, exact versus normalized text, form values and ambiguous condition targets', async () => {
    const run = async (conditions: Json[], prepare: (page: FakePage) => void = () => undefined) =>
      (
        await execute(compiled({ conditions }), {
          page: (clock) => {
            const app = taskApp(clock, { duplicates: false })
            prepare(app)
            return app
          },
          collector: fakeCollector({ observations: [phaseImage()] }),
        })
      ).result
    const hiddenAbsent = await run([
      { kind: 'element-visible', locator: testId('error-banner'), visible: false },
      { kind: 'form-value', locator: TITLE, value: 'Buy milk' },
    ])
    expect(hiddenAbsent.outcome).toBe('conditions-satisfied')

    const exact = await run(
      [
        { kind: 'text', locator: testId('static-summary'), match: 'exact', text: '0 open tasks' },
        { kind: 'text', locator: testId('static-summary'), match: 'normalized', text: '0 open tasks' },
      ],
      (page) => {
        page.elements.push({ key: 'static', testId: 'static-summary', visible: true, text: ' 0  open\ntasks ', value: '', kind: 'unsupported' })
      },
    )
    expect(exact.outcome).toBe('conditions-unsatisfied')
    expect(exact.conditions.map((condition) => condition.status)).toEqual(['unsatisfied', 'satisfied'])

    const ambiguousTarget = await run([{ kind: 'text', locator: testId('dup'), match: 'normalized', text: 'x' }], (page) => {
      page.elements.push({ key: 'd1', testId: 'dup', visible: true, text: 'x', value: '', kind: 'unsupported' }, { key: 'd2', testId: 'dup', visible: true, text: 'x', value: '', kind: 'unsupported' })
    })
    expect(ambiguousTarget.outcome).toBe('operational-failure')
    expect(ambiguousTarget.conditions[0]).toMatchObject({ status: 'unevaluable', reason: 'LOCATOR_AMBIGUOUS' })

    const missingTarget = await run([{ kind: 'text', locator: testId('nowhere'), match: 'exact', text: 'x' }])
    expect(missingTarget.conditions[0]).toMatchObject({ status: 'unevaluable', reason: 'CONDITION_TARGET_MISSING' })
    expect(missingTarget.outcome).toBe('operational-failure')

    const secretValue = await run([{ kind: 'form-value', locator: SECRET, value: '' }])
    expect(secretValue.conditions[0]).toMatchObject({ status: 'unevaluable', reason: 'CONDITION_TARGET_UNSUPPORTED' })
  })

  it('distinguishes exact from whitespace-normalized text on the actual text', async () => {
    const frozenExact = compiled({ conditions: [{ kind: 'text', locator: SUMMARY, match: 'exact', text: '1 open task' }] })
    const frozenNormalized = compiled({ conditions: [{ kind: 'text', locator: SUMMARY, match: 'normalized', text: '1 open task' }] })
    const spaced = (clock: FakeClock): FakePage => {
      const app = taskApp(clock, { duplicates: false })
      app.onClick.set('add', () => {
        app.elements.push({ key: 'item', testId: 'task-item', visible: true, text: 'Buy milk', value: '', kind: 'unsupported' })
        const summary = app.elements.find((element) => element.key === 'summary')
        if (summary !== undefined) summary.text = '  1   open\n task '
      })
      return app
    }
    const collector = () => fakeCollector({ observations: [phaseImage()] })
    expect((await execute(frozenExact, { page: spaced, collector: collector() })).result.outcome).toBe('conditions-unsatisfied')
    expect((await execute(frozenNormalized, { page: spaced, collector: collector() })).result.outcome).toBe('conditions-satisfied')
  })
})

describe('executeFrozenReplay requires run-bound evidence and available collectors', () => {
  it('cannot satisfy conditions without the required evidence collectors', async () => {
    const frozen = compiled()
    const { result } = await execute(frozen, { page: (clock) => taskApp(clock, { duplicates: false }), collector: null })
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('REQUIRED_EVIDENCE_UNAVAILABLE')
    expect(result.missing_evidence).toEqual(['image', 'console'])
    // DOM conditions are evaluated, but an absent error collector is never an error-free verdict.
    expect(statuses(result).conditions).toEqual(['satisfied', 'satisfied', 'unevaluable'])
    expect(result.conditions[2]?.reason).toBe('COLLECTOR_UNAVAILABLE')
  })

  it('treats an explicitly unavailable collector and a missing image as missing evidence', async () => {
    const frozen = compiled()
    const unavailable = await execute(frozen, {
      page: (clock) => taskApp(clock, { duplicates: false }),
      collector: fakeCollector({ observations: [phaseImage(), phaseConsole('baseline', 'unavailable')] }),
    })
    expect(unavailable.result.missing_evidence).toEqual(['console'])
    expect(unavailable.result.outcome).toBe('operational-failure')
    const noImage = await execute(frozen, { page: (clock) => taskApp(clock, { duplicates: false }), collector: fakeCollector({ observations: [] }) })
    expect(noImage.result.missing_evidence).toEqual(['image'])
  })

  it.each([
    ['another run', { run: id(60) }],
    ['another phase', { phase: 'candidate' }],
    ['another baseline', { baseline: 'd'.repeat(40) }],
    ['another build', { build: sha('f') }],
  ])('rejects observations from %s', async (_name, overrides) => {
    const frozen = compiled()
    const { result } = await execute(frozen, { page: (clock) => taskApp(clock, { duplicates: false }), collector: fakeCollector({ observations: [phaseImage(overrides)] }) })
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('EVIDENCE_BINDING_MISMATCH')
    expect(result.evidence).toEqual([])
  })

  it('rejects malformed drained observations and failed collector checkpoints', async () => {
    const frozen = compiled()
    const malformed = await execute(frozen, { collector: fakeCollector({ observations: [{ ...phaseImage(), payload: { raw_png: 'AAAA' } }] }) })
    expect(malformed.result.reason).toBe('EVIDENCE_BINDING_MISMATCH')
    const failing: ReplayEvidenceCollector = {
      available: () => true,
      checkpoint: async () => {
        throw new Error('screenshot failed')
      },
      drain: async () => [],
    }
    const checkpoint = await execute(frozen, { collector: failing })
    expect(checkpoint.result.reason).toBe('EVIDENCE_COLLECTION_FAILED')
    expect(checkpoint.page.sideEffects()).toEqual([`navigate:${ORIGIN}/`])
  })
})

describe('executeFrozenReplay bounds, cancellation and cleanup', () => {
  it('does not touch the page when cancellation precedes execution', async () => {
    const controller = new AbortController()
    controller.abort()
    const { page, result } = await execute(compiled(), { signal: controller.signal })
    expect(result.outcome).toBe('canceled')
    expect(page.calls).toEqual([])
    expect(page.released).toBe(1)
  })

  it('keeps cancellation sticky against a late driver completion and joins it before returning', async () => {
    const frozen = compiled()
    const { page, result, clock } = await execute(frozen, {
      page: (fakeTime) => {
        const app = taskApp(fakeTime, { duplicates: false })
        app.hang = { method: 'click', resolveOnRelease: true }
        return app
      },
      during: (fake, controller) => {
        if (fake.hang !== null) fake.hang.onStart = () => queueMicrotask(() => controller.abort())
      },
    })
    expect(result.outcome).toBe('canceled')
    expect(result.reason).toBe('REPLAY_CANCELED')
    expect(statuses(result)).toEqual({ actions: ['executed', 'executed', 'failed', 'not_executed'], conditions: ['not_evaluated', 'not_evaluated', 'not_evaluated'] })
    // The in-flight click stopped at cancellation, not at its 10-second action bound.
    expect(result.actions[2]?.reason).toBe('REPLAY_CANCELED')
    expect(clock.now()).toBe(0)
    expect(result.joined).toBe(true)
    expect(page.released).toBe(1)
    // The late click completed during release; the frozen result did not change.
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.outcome).toBe('canceled')
  })

  it('stops an in-flight call even when cancellation arrives while that call is starting', async () => {
    const { result, clock } = await execute(compiled(), {
      page: (fakeTime) => {
        const app = taskApp(fakeTime, { duplicates: false })
        app.hang = { method: 'click', resolveOnRelease: true }
        return app
      },
      during: (fake, controller) => {
        if (fake.hang !== null) fake.hang.onStart = () => controller.abort()
      },
    })
    expect(result.outcome).toBe('canceled')
    expect(result.actions[2]?.reason).toBe('REPLAY_CANCELED')
    expect(clock.now()).toBe(0)
  })

  it('bounds a driver call that never settles and reports an unjoined producer honestly', async () => {
    const frozen = compiled()
    const { result, clock, page } = await execute(frozen, {
      page: (c) => {
        const app = taskApp(c, { duplicates: false })
        app.hang = { method: 'navigate', resolveOnRelease: false }
        return app
      },
    })
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('REPLAY_ACTION_TIMEOUT')
    expect(result.joined).toBe(false)
    expect(result.released).toBe(true)
    expect(page.released).toBe(1)
    expect(clock.now()).toBe(PROJECT_LIMITS.maxWaitMs + EXECUTION_LIMITS.stop_grace_ms)
  })

  it('stops at the fixed 120-second phase limit even when every action stays within its own bound', async () => {
    const steps = 14
    const recorded = Array.from({ length: steps }, (_, index) => ({ type: 'click', locators: [role(`Step ${index + 1}`)] }))
    const actions = Array.from({ length: steps }, (_, index) => ({ op: 'click', locator: role(`Step ${index + 1}`) }))
    const frozen = compiled({ recorded, actions, conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }] })
    const { result, clock } = await execute(frozen, {
      page: (c) => {
        const app = new FakePage(c)
        app.elements = Array.from({ length: steps }, (_, index) => ({ key: `step-${index + 1}`, role: 'button', name: `Step ${index + 1}`, visible: true, text: null, value: '', kind: 'unsupported' as const, appearsAt: index === 0 ? 0 : Number.POSITIVE_INFINITY }))
        app.elements.forEach((element, index) => {
          app.onClick.set(element.key, () => {
            const next = app.elements[index + 1]
            if (next !== undefined) next.appearsAt = c.now() + 9_500
          })
        })
        return app
      },
    })
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('REPLAY_PHASE_TIMEOUT')
    expect(result.actions.filter((action) => action.status === 'executed').length).toBe(13)
    expect(result.actions[13]).toMatchObject({ status: 'failed', reason: 'REPLAY_PHASE_TIMEOUT' })
    expect(clock.now()).toBeLessThanOrEqual(EXECUTION_LIMITS.phase_timeout_ms)
  })

  it('reports a failed session release instead of hiding it', async () => {
    const { result } = await execute(compiled(), {
      page: (clock) => {
        const app = taskApp(clock, { duplicates: true })
        app.releaseFails = true
        return app
      },
    })
    expect(result.outcome).toBe('conditions-unsatisfied')
    expect(result.released).toBe(false)
  })
})

describe('executeFrozenReplay fails closed on late target events', () => {
  type Stage = 'end checkpoint' | 'condition evaluation' | 'evidence drain' | 'session release'
  type LateEvent = 'popup' | 'origin'

  const runWith = async (stage: Stage | null, event: LateEvent, duplicates: boolean): Promise<{ result: ReplayExecutionResult; drained: boolean }> => {
    let target: FakePage | undefined
    let drained = false
    const happen = (): void => {
      if (target === undefined) return
      if (event === 'popup') target.violationCodes.push('REPLAY_POPUP')
      else target.url = 'http://localhost:49999/studio'
    }
    const collector = fakeCollector({
      observations: [phaseImage()],
      onCheckpoint: (point) => {
        if (stage === 'end checkpoint' && point.kind === 'end') happen()
      },
      onDrain: () => {
        drained = true
        if (stage === 'evidence drain') happen()
      },
    })
    const { result } = await execute(compiled(), {
      collector,
      page: (clock) => {
        const app = taskApp(clock, { duplicates })
        target = app
        // `text` is used only by the final text condition in this definition.
        if (stage === 'condition evaluation') app.onCall.set('text', happen)
        if (stage === 'session release') app.onRelease = happen
        return app
      },
    })
    return { result, drained }
  }

  const cases: [LateEvent, Stage, boolean][] = []
  for (const stage of ['end checkpoint', 'condition evaluation', 'evidence drain', 'session release'] as const) {
    for (const event of ['popup', 'origin'] as const) {
      // After release the page is gone; only host-recorded events (popup) remain observable.
      if (stage === 'session release' && event === 'origin') continue
      for (const duplicates of [false, true]) cases.push([event, stage, duplicates])
    }
  }

  it.each(cases)('a late %s during %s leaves no verdict (defective target: %s)', async (event, stage, duplicates) => {
    const control = await runWith(null, event, duplicates)
    expect(control.result.outcome).toBe(duplicates ? 'conditions-unsatisfied' : 'conditions-satisfied')
    const { result: late, drained } = await runWith(stage, event, duplicates)
    expect(late.outcome).toBe('operational-failure')
    expect(late.reason).toBe(event === 'popup' ? 'REPLAY_POPUP' : 'NAVIGATION_LEFT_TARGET')
    expect(late.released).toBe(true)
    expect(late.joined).toBe(true)
    // The event is caught at the stage where it happened, before any later stage runs.
    const evaluated = late.conditions.map((condition) => condition.status !== 'not_evaluated')
    if (stage === 'end checkpoint') expect(evaluated).toEqual([false, false, false])
    if (stage === 'condition evaluation') expect(evaluated).toEqual([true, true, false])
    expect(drained).toBe(stage === 'evidence drain' || stage === 'session release')
  })
})

describe('executeFrozenReplay propagates effective wait, action and phase deadlines', () => {
  const once = (ms: number): ((timeoutMs: number) => number) => {
    let used = false
    return () => {
      if (used) return 0
      used = true
      return ms
    }
  }
  const candidatePage =
    (prepare: (page: FakePage) => void) =>
    (clock: FakeClock): FakePage => {
      const app = taskApp(clock, { duplicates: false })
      prepare(app)
      return app
    }
  const imageOnly = () => fakeCollector({ observations: [phaseImage()] })
  const shortWait = () =>
    compiled({ actions: [...DEFAULT_ACTIONS.slice(0, 3), { op: 'wait', until: { kind: 'text', locator: SUMMARY, text: '1 open task' }, timeout_ms: 20 }] })

  it('gives a declared wait only its remaining time and rejects a success that arrives after it', async () => {
    const honoring = await execute(shortWait(), { page: candidatePage((page) => page.durations.set('text', (timeout) => timeout - 1)), collector: imageOnly() })
    // The wait's text probe receives the 20 ms declared wait, not the 10-second action bound.
    expect(honoring.page.timeouts.get('text')?.[0]).toBe(20)
    expect(honoring.result.actions[3]).toMatchObject({ status: 'executed', reason: null })
    expect(honoring.result.outcome).toBe('conditions-satisfied')

    const late = await execute(shortWait(), { page: candidatePage((page) => page.durations.set('text', once(9_999))), collector: imageOnly() })
    expect(late.result.actions[3]).toMatchObject({ status: 'failed', reason: 'WAIT_TIMEOUT' })
    expect(late.result.outcome).toBe('operational-failure')
    expect(late.result.reason).toBe('WAIT_TIMEOUT')
    expect(late.result.released && late.result.joined).toBe(true)
  })

  it('rejects a path wait whose state was read only after the declared wait elapsed', async () => {
    const frozen = compiled({ actions: [{ op: 'wait', until: { kind: 'path', path: '/' }, timeout_ms: 20 }, DEFAULT_ACTIONS[2] as Json] })
    const run = async (jumpMs: number) =>
      execute(frozen, {
        page: candidatePage((page) => {
          // URL reads: after entry, after the start checkpoint, then the wait's own probe.
          let reads = 0
          page.onUrlRead = () => {
            reads += 1
            if (reads === 3) page.clock.jump(jumpMs)
          }
        }),
        collector: imageOnly(),
      })
    expect((await run(20)).result.actions[0]).toMatchObject({ status: 'executed', reason: null })
    const late = await run(21)
    expect(late.result.actions[0]).toMatchObject({ status: 'failed', reason: 'WAIT_TIMEOUT' })
    expect(late.page.calls.some((call) => call.startsWith('click'))).toBe(false)
  })

  it('shares one 10-second bound across locator resolution and the action primitive', async () => {
    const appearLate = (page: FakePage): void => {
      const add = page.elements.find((element) => element.key === 'add')
      if (add !== undefined) add.appearsAt = 9_000
    }
    const inTime = await execute(compiled(), { page: candidatePage(appearLate), collector: imageOnly() })
    expect(inTime.page.timeouts.get('click')).toEqual([1_000])
    expect(inTime.result.outcome).toBe('conditions-satisfied')

    const lateClick = await execute(compiled(), {
      page: candidatePage((page) => {
        appearLate(page)
        page.durations.set('click', () => 1_001)
      }),
      collector: imageOnly(),
    })
    expect(lateClick.result.actions[2]).toMatchObject({ status: 'failed', reason: 'REPLAY_ACTION_TIMEOUT' })
    expect(lateClick.result.outcome).toBe('operational-failure')
  })

  it('names the last observed unmet state when the window closes during a probe', async () => {
    const { page, result } = await execute(compiled(), {
      page: candidatePage((app) => {
        app.elements.push({ key: 'add-2', role: 'button', name: 'Add task', visible: true, text: 'Add task', value: '', kind: 'unsupported' })
        // The probe started with the last 100 ms of the window overruns it.
        app.durations.set('count', (timeout) => (timeout <= 100 ? timeout + 1 : 0))
      }),
      collector: imageOnly(),
    })
    expect(result.actions[2]).toMatchObject({ status: 'failed', reason: 'LOCATOR_AMBIGUOUS' })
    expect(page.calls.some((call) => call.startsWith('click'))).toBe(false)
  })

  it('rejects a locator resolution that completes after its window without acting', async () => {
    const { page, result } = await execute(compiled(), { page: candidatePage((app) => app.durations.set('count', once(10_500))), collector: imageOnly() })
    expect(result.actions[0]).toMatchObject({ status: 'failed', reason: 'REPLAY_ACTION_TIMEOUT' })
    expect(page.calls.some((call) => call.startsWith('select') || call.startsWith('fieldKind'))).toBe(false)
  })

  it('caps primitives by the remaining 120-second phase and rejects a late arrival at the phase end', async () => {
    const steps = 14
    const recorded = Array.from({ length: steps }, (_, index) => ({ type: 'click', locators: [role(`Step ${index + 1}`)] }))
    const actions = Array.from({ length: steps }, (_, index) => ({ op: 'click', locator: role(`Step ${index + 1}`) }))
    const frozen = (): FrozenReplay => compiled({ recorded, actions, conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }] })
    const stepsPage = (duration: (timeoutMs: number) => number) => (clock: FakeClock): FakePage => {
      const app = new FakePage(clock)
      app.elements = Array.from({ length: steps }, (_, index) => ({ key: `step-${index + 1}`, role: 'button', name: `Step ${index + 1}`, visible: true, text: null, value: '', kind: 'unsupported' as const }))
      app.durations.set('click', duration)
      return app
    }
    const honoring = await execute(frozen(), { page: stepsPage((timeout) => Math.min(9_500, timeout - 1)), collector: imageOnly() })
    expect(honoring.page.timeouts.get('click')).toEqual([...Array.from({ length: 12 }, () => 10_000), 6_000, 1])
    expect(honoring.result.outcome).toBe('conditions-satisfied')
    expect(honoring.clock.now()).toBeLessThan(EXECUTION_LIMITS.phase_timeout_ms)

    const late = await execute(frozen(), { page: stepsPage(() => 9_500), collector: imageOnly() })
    expect(late.result.actions[12]).toMatchObject({ status: 'failed', reason: 'REPLAY_PHASE_TIMEOUT' })
    expect(late.result.actions[13]?.status).toBe('not_executed')
    expect(late.result.reason).toBe('REPLAY_PHASE_TIMEOUT')
  })

  it('bounds condition evaluation and final collection, rejecting successes that arrive late', async () => {
    const lateCondition = await execute(compiled(), { page: candidatePage((page) => page.durations.set('text', () => 10_001)), collector: imageOnly() })
    expect(lateCondition.result.conditions[1]).toMatchObject({ status: 'unevaluable', reason: 'CONDITION_TIMEOUT' })
    expect(lateCondition.result.outcome).toBe('operational-failure')

    for (const stage of ['checkpoint', 'drain'] as const) {
      let target: FakePage | undefined
      const jump = (): void => target?.clock.jump(10_001)
      const collector = fakeCollector({
        observations: [phaseImage()],
        onCheckpoint: (point) => {
          if (stage === 'checkpoint' && point.kind === 'end') jump()
        },
        onDrain: () => {
          if (stage === 'drain') jump()
        },
      })
      const { result } = await execute(compiled(), {
        page: candidatePage((page) => {
          target = page
        }),
        collector,
      })
      expect(result.outcome, stage).toBe('operational-failure')
      expect(result.reason, stage).toBe('EVIDENCE_COLLECTION_FAILED')
      expect(result.released && result.joined).toBe(true)
    }
  })

  it('stays canceled when cancellation arrives during final collection and joins the drain', async () => {
    let target: FakePage | undefined
    let abort: (() => void) | undefined
    const collector: ReplayEvidenceCollector = {
      available: () => true,
      drain: () =>
        new Promise((resolve) => {
          if (target !== undefined) target.onRelease = () => resolve([phaseImage()])
          queueMicrotask(() => abort?.())
        }),
    }
    const { result, page } = await execute(compiled(), {
      page: candidatePage((app) => {
        target = app
      }),
      collector,
      during: (_page, controller) => {
        abort = () => controller.abort()
      },
    })
    expect(result.outcome).toBe('canceled')
    expect(result.joined).toBe(true)
    expect(page.released).toBe(1)
  })

  it('rejects duplicate or wrong-viewport phase observations', async () => {
    const duplicate = await execute(compiled(), { page: candidatePage(() => undefined), collector: fakeCollector({ observations: [phaseImage(), phaseImage()] }) })
    expect(duplicate.result.reason).toBe('EVIDENCE_BINDING_MISMATCH')
    const small = phaseImage()
    Object.assign(small.payload as Json, { viewport: { width: 1024, height: 768 }, clip: { x: 0, y: 0, width: 1024, height: 768 } })
    const viewport = await execute(compiled(), { page: candidatePage(() => undefined), collector: fakeCollector({ observations: [small] }) })
    expect(viewport.result.reason).toBe('EVIDENCE_BINDING_MISMATCH')
    expect(viewport.result.outcome).toBe('operational-failure')
  })
})

describe('frozen definitions persist only outside the candidate mount', () => {
  it('stores the exact definition in the outside-checkout store and detects any other content', async () => {
    const temp = await createTempDirectory('flowproof-replay-store-')
    try {
      const candidate = path.join(temp.path, 'candidate-copy')
      await mkdir(candidate)
      const root = await openProjectStateRoot({ stateRoot: path.join(temp.path, 'state'), protectedRoots: [candidate] })
      const frozen = compiled()
      const store = await root.createRun(RUN)
      const record = await persistFrozenReplay(frozen, store)
      const content = await store.read(record.artifact_id, record.sha256)
      expect(storedDefinitionMatches(frozen, content)).toBe(true)
      expect(path.relative(candidate, root.path).startsWith('..')).toBe(true)
      expect(content.bytes.toString('utf8')).toBe(canonicalJson(frozen.definition))

      const other = compiled({ conditions: [{ kind: 'element-count', locator: ITEM, count: 2 }] })
      expect(storedDefinitionMatches(other, content)).toBe(false)
      const edited = { ...content, bytes: Buffer.from(content.bytes.toString('utf8').replace('"count":1', '"count":2')) }
      expect(storedDefinitionMatches(frozen, edited)).toBe(false)
      await expect(persistFrozenReplay(structuredClone(frozen), store)).rejects.toBeInstanceOf(ProjectReplayError)
      await expect(openProjectStateRoot({ stateRoot: path.join(candidate, '.flowproof'), protectedRoots: [candidate] })).rejects.toThrow('PROJECT_STORE_ROOT_INSIDE_PROJECT')
    } finally {
      await temp.remove()
    }
  })
})

// ---------------------------------------------------------------------------------------
// Opt-in actual Chromium session on a synthetic page (FLOWPROOF_REPLAY_CHROMIUM=1)
// ---------------------------------------------------------------------------------------

const CHROMIUM = process.env.FLOWPROOF_REPLAY_CHROMIUM === '1'
const TARGET_PORT = 43_170
const EXTERNAL_PORT = 43_171
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`

const syntheticPage = (duplicates: boolean): string => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic tasks</title></head><body>
<select data-testid="task-filter"><option value="all">All</option><option value="open">Open</option></select>
<input data-testid="task-title" class="title" type="text">
<input data-testid="api-key" type="password">
<button type="button" id="add">Add task</button>
<button type="button" class="dup">Duplicate</button><button type="button" class="dup">Duplicate</button>
<button type="button" id="remember">Remember</button>
<button type="button" id="open-later">Open later</button>
<button type="button" id="leave-later">Leave later</button>
<a href="http://localhost:${EXTERNAL_PORT}/help">Help</a>
<ul id="list"></ul>
<p data-testid="task-summary">0 open tasks</p>
<p data-testid="stored-on-load"></p>
<div style="height:3000px"></div>
<script>
  document.querySelector('[data-testid="stored-on-load"]').textContent = localStorage.getItem('remembered') || 'none';
  fetch('http://localhost:${EXTERNAL_PORT}/beacon').catch(function () {});
  document.getElementById('remember').addEventListener('click', function () { localStorage.setItem('remembered', 'yes'); document.cookie = 'remembered=yes'; });
  document.getElementById('open-later').addEventListener('click', function () { setTimeout(function () { window.open('/', '_blank'); }, 300); });
  document.getElementById('leave-later').addEventListener('click', function () { setTimeout(function () { location.href = 'http://localhost:${EXTERNAL_PORT}/away'; }, 300); });
  document.getElementById('add').addEventListener('click', function () {
    var title = document.querySelector('[data-testid="task-title"]').value;
    for (var i = 0; i < ${duplicates ? 2 : 1}; i += 1) { var li = document.createElement('li'); li.setAttribute('data-testid', 'task-item'); li.textContent = title; document.getElementById('list').appendChild(li); }
    var n = document.querySelectorAll('[data-testid="task-item"]').length;
    setTimeout(function () { document.querySelector('[data-testid="task-summary"]').textContent = n + ' open task' + (n === 1 ? '' : 's'); }, 150);
  });
</script></body></html>`

describe.runIf(CHROMIUM)('actual Chromium replay session on a synthetic page (opt-in, heavy lease)', () => {
  let browser: Browser
  let target: Server
  let external: Server
  let duplicates = true
  let externalHits = 0

  beforeAll(async () => {
    target = createServer((request, response) => {
      response.writeHead(request.url === '/' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      response.end(request.url === '/' ? syntheticPage(duplicates) : 'not found')
    })
    external = createServer((_request, response) => {
      externalHits += 1
      response.end('external')
    })
    await new Promise<void>((resolve) => target.listen(TARGET_PORT, 'localhost', resolve))
    await new Promise<void>((resolve) => external.listen(EXTERNAL_PORT, 'localhost', resolve))
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => target?.close(() => resolve()))
    await new Promise<void>((resolve) => external?.close(() => resolve()))
  })

  const imageCollector = (phase: string, build: string): ReplayEvidenceCollector =>
    // IN-PROCESS FAKE collector: attests a bound image so DOM outcomes are observable; not a masked screenshot.
    fakeCollector({ available: ['image'], observations: [phaseImage({ phase, build })] })

  const chromiumScenario = (scenario: Scenario): FrozenReplay => compiled({ origin: TARGET_ORIGIN, ...scenario })

  const run = async (frozen: FrozenReplay, phase: 'baseline' | 'candidate', build: string, collector?: ReplayEvidenceCollector) => {
    const session = await openChromiumReplaySession(browser, frozen, binding(frozen, { phase, build_sha256: build }), collector === undefined ? {} : { collector })
    return executeFrozenReplay(frozen, session)
  }

  it('reproduces a synthetic defect and passes the identical definition on a corrected build', async () => {
    const frozen = chromiumScenario({
      recorded: RECORDED.slice(0, 4),
      actions: [...DEFAULT_ACTIONS.slice(0, 3), { op: 'scroll', target: { kind: 'page' }, x: 0, y: 400 }],
      conditions: [
        { kind: 'element-count', locator: ITEM, count: 1 },
        { kind: 'form-value', locator: FILTER, value: 'open' },
        { kind: 'form-value', locator: TITLE, value: 'Buy milk' },
        { kind: 'path', path: '/' },
      ],
    })
    duplicates = true
    const baseline = await run(frozen, 'baseline', BUILD, imageCollector('baseline', BUILD))
    expect(baseline.outcome).toBe('conditions-unsatisfied')
    expect(statuses(baseline)).toEqual({ actions: ['executed', 'executed', 'executed', 'executed'], conditions: ['unsatisfied', 'satisfied', 'satisfied', 'satisfied'] })
    expect(baseline.released).toBe(true)

    duplicates = false
    const candidate = await run(frozen, 'candidate', sha('6'), imageCollector('candidate', sha('6')))
    expect(candidate.outcome).toBe('conditions-satisfied')
    // Without a host collector the same satisfied DOM state cannot pass.
    const unevidenced = await run(frozen, 'candidate', sha('6'))
    expect(unevidenced.outcome).toBe('operational-failure')
    expect(unevidenced.reason).toBe('REQUIRED_EVIDENCE_UNAVAILABLE')
    // Requests to any other origin were refused by the session routing.
    expect(externalHits).toBe(0)
  }, 30_000)

  it('waits on actual delayed text and fails an ambiguous role locator without clicking', async () => {
    duplicates = false
    const waited = chromiumScenario({
      recorded: RECORDED.slice(0, 3),
      actions: [...DEFAULT_ACTIONS.slice(0, 3), { op: 'wait', until: { kind: 'text', locator: SUMMARY, text: '1 open task' }, timeout_ms: 2_000 }],
      conditions: [{ kind: 'text', locator: SUMMARY, match: 'exact', text: '1 open task' }, { kind: 'element-count', locator: ITEM, count: 1 }],
      task: 1,
    })
    expect((await run(waited, 'baseline', BUILD, imageCollector('baseline', BUILD))).outcome).toBe('conditions-satisfied')

    const ambiguous = chromiumScenario({
      recorded: [{ type: 'click', locators: [role('Duplicate')] }],
      actions: [{ op: 'click', locator: role('Duplicate') }],
      conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }],
    })
    const result = await run(ambiguous, 'baseline', BUILD, imageCollector('baseline', BUILD))
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('LOCATOR_AMBIGUOUS')
  }, 30_000)

  it('starts every phase in fresh browser storage', async () => {
    const frozen = chromiumScenario({
      recorded: [{ type: 'click', locators: [role('Remember')] }],
      actions: [{ op: 'click', locator: role('Remember') }],
      conditions: [{ kind: 'text', locator: testId('stored-on-load'), match: 'exact', text: 'none' }],
    })
    const first = await run(frozen, 'baseline', BUILD, imageCollector('baseline', BUILD))
    const second = await run(frozen, 'candidate', sha('6'), imageCollector('candidate', sha('6')))
    expect(first.outcome).toBe('conditions-satisfied')
    expect(second.outcome).toBe('conditions-satisfied')
    // Control: the page does detect carried-over storage when one context is reused.
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(`${TARGET_ORIGIN}/`)
      await page.getByRole('button', { name: 'Remember', exact: true }).click()
      await page.goto(`${TARGET_ORIGIN}/`)
      expect(await page.getByTestId('stored-on-load').textContent()).toBe('yes')
    } finally {
      await context.close()
    }
  }, 30_000)

  it('fails closed when a popup or origin change arrives during final evidence collection', async () => {
    // IN-PROCESS FAKE collector whose drain takes 1.5 s, so the page's delayed (300 ms) event lands inside it.
    const slowDrain = (): ReplayEvidenceCollector => ({
      available: (type) => type === 'image',
      drain: () => new Promise((resolve) => setTimeout(() => resolve([phaseImage()]), 1_500)),
    })
    const before = externalHits
    for (const [name, reason] of [
      ['Open later', 'REPLAY_POPUP'],
      ['Leave later', 'NAVIGATION_LEFT_TARGET'],
    ] as const) {
      const frozen = chromiumScenario({
        recorded: [{ type: 'click', locators: [role(name)] }],
        actions: [{ op: 'click', locator: role(name) }],
        conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }],
      })
      const result = await run(frozen, 'baseline', BUILD, slowDrain())
      expect(result.actions[0]?.status, name).toBe('executed')
      expect(result.conditions[0]?.status, name).toBe('satisfied')
      expect(result.outcome, name).toBe('operational-failure')
      expect(result.reason, name).toBe(reason)
      expect(result.released).toBe(true)
    }
    expect(externalHits).toBe(before)
  }, 30_000)

  it('stops when a click leaves the target origin and refuses the external request', async () => {
    const frozen = chromiumScenario({
      recorded: [{ type: 'click', locators: [role('Help', 'link')] }],
      actions: [
        { op: 'click', locator: role('Help', 'link') },
        { op: 'wait', until: { kind: 'path', path: '/help' }, timeout_ms: 2_000 },
      ],
      conditions: [{ kind: 'element-count', locator: ITEM, count: 0 }],
    })
    const before = externalHits
    const result = await run(frozen, 'baseline', BUILD, imageCollector('baseline', BUILD))
    expect(result.outcome).toBe('operational-failure')
    expect(result.reason).toBe('NAVIGATION_LEFT_TARGET')
    expect(externalHits).toBe(before)
  }, 30_000)
})
