import { describe, expect, it } from 'vitest'

import {
  CHECK_STATUSES,
  EXECUTION_LIMITS,
  MANDATORY_CHECK_IDS,
  PROJECT_CLAIM,
  PROJECT_LIMITS,
  bindingMismatches,
  canTransitionCapture,
  newProjectUuid,
  parseCandidate,
  parseDemonstrationCapture,
  parseExecutionConfiguration,
  parseFrozenVerificationDefinition,
  parseInteractionObservation,
  parseInterpretation,
  parseProjectConfigFile,
  parseProjectContext,
  parseProjectRunResult,
  parseProviderInvocation,
  parseSafeObservation,
  projectCheckId,
  projectDigest,
  reduceProjectOutcome,
  requiredCheckIds,
  resultConfigurationIssues,
  withConfigurationDigest,
  withDefinitionDigest,
} from '../../packages/flowproof/src/project/contracts.js'

// T004: the closed project-live contract family of specs/006 data-model.md and its Constraint
// Register. Every object is strict, every identity is a host-generated lowercase UUIDv4 or SHA-256,
// every bound is exact, and cross-field invariants reject fake success before any side effect.

type Json = Record<string, unknown>

const id = (seed: number): string => `${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`
const sha = (char: string): string => char.repeat(64)
const REVISION = 'b09f068f7001b8530086dec95b1128d8fdb49286'
const IMAGE_ID = `sha256:${sha('7')}`
const TIME = '2026-11-04T10:00:00.000Z'
const LATER = '2026-11-04T10:00:05.000Z'

const RUN = id(1)
const PROJECT = id(2)
const CONFIGURATION = id(3)
const CAPTURE = id(4)
const FRAME = id(5)
const IMAGE_OBSERVATION = id(6)
const CONSOLE_OBSERVATION = id(7)
const ANALYSIS = id(8)
const INTERPRETATION = id(9)
const DEFINITION = id(10)
const CORRECTION = id(11)
const CANDIDATE = id(12)
const ARTIFACT = id(13)

const clone = <T>(value: T): T => structuredClone(value)
const codes = (result: { ok: boolean; error?: { issues: readonly { code: string; path: string }[] } }): string[] =>
  result.ok ? [] : (result.error?.issues ?? []).map((issue) => issue.code)

function expectValid(result: { ok: boolean; error?: { issues: readonly { code: string; path: string }[] } }): void {
  expect(result.ok ? [] : result.error?.issues).toEqual([])
}

function expectInvalid(result: { ok: boolean }, code?: string): void {
  expect(result.ok).toBe(false)
  if (code !== undefined) expect(codes(result as never)).toContain(code)
}

// ---------------------------------------------------------------------------------------
// Valid fixtures
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
    { path: 'tests/tasks.test.mjs', kind: 'test', sha256: sha('1') },
    { path: 'vite.config.js', kind: 'configuration', sha256: sha('2') },
  ],
  admission: { state: 'ready', reasons: [], required_prerequisites: [] },
})

const configFile = (): Json => ({
  schema_version: 1,
  category: 'vite-static-v1',
  entry_path: '/',
  build: { argv: ['node', '/opt/flowproof/toolchain/node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native'], output_directory: 'dist' },
  required_project_checks: [{ id: 'sample-unit', argv: ['node', '--test', 'tests/tasks.test.mjs'] }],
})

const configurationBody = (): Json => ({
  schema_version: 1,
  configuration_id: CONFIGURATION,
  project_id: PROJECT,
  baseline_commit: REVISION,
  category: 'vite-static-v1',
  entry_path: '/',
  target_origin: 'http://localhost:41234',
  build: (configFile().build as Json),
  required_project_checks: configFile().required_project_checks,
  mandatory_checks: [...MANDATORY_CHECK_IDS],
  inputs: { source_tree_sha256: sha('a'), configuration_sha256: sha('3'), checks_sha256: sha('4'), lock_sha256: sha('e') },
  profile: {
    profile_id: 'vite-static-v1',
    image_id: IMAGE_ID,
    dependency_tree_sha256: sha('c'),
    manifest_sha256: sha('d'),
    network: 'none',
    environment_allowlist: ['CI'],
    limits: {
      cpu_count: 1,
      memory_bytes: 1_073_741_824,
      pids: 256,
      stop_grace_ms: 5_000,
      phase_timeout_ms: 120_000,
      provider_timeout_ms: 90_000,
      aggregate_automatic_ms: 600_000,
    },
    byte_limits: { max_output_bytes: 16_777_216, max_output_files: 512, max_diagnostic_bytes: 65_536 },
  },
  confirmation: { state: 'confirmed', confirmed_at: TIME },
})

const configuration = (mutate: (body: Json) => void = () => undefined): Json => {
  const body = configurationBody()
  mutate(body)
  return withConfigurationDigest(body as never) as unknown as Json
}

const locator = (): Json => ({ kind: 'test-id', value: 'task-filter' })

const interaction = (sequence: number, action: Json, extra: Json = {}): Json => ({
  sequence,
  capture_id: CAPTURE,
  document_epoch: 0,
  frame_id: FRAME,
  offset_ms: sequence * 100,
  action,
  related_observation_ids: [],
  ...extra,
})

const imageObservation = (extra: Json = {}): Json => ({
  observation_id: IMAGE_OBSERVATION,
  run_id: RUN,
  capture_id: CAPTURE,
  baseline_commit: REVISION,
  phase: 'demonstration',
  type: 'image',
  availability: 'available',
  reason: null,
  sequence_range: { first: 1, last: 2 },
  policy_version: 'project-privacy-v1',
  redaction_count: 0,
  payload: {
    viewport: { width: 1280, height: 800 },
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    mask_count: 2,
    masked_before_retention: true,
    build_sha256: sha('5'),
    artifact: { artifact_id: ARTIFACT, sha256: sha('6'), bytes: 40_000, media_type: 'image/png' },
  },
  ...extra,
})

const consoleObservation = (extra: Json = {}): Json => ({
  observation_id: CONSOLE_OBSERVATION,
  run_id: RUN,
  capture_id: CAPTURE,
  baseline_commit: REVISION,
  phase: 'demonstration',
  type: 'console',
  availability: 'available',
  reason: null,
  sequence_range: null,
  policy_version: 'project-privacy-v1',
  redaction_count: 1,
  payload: { level: 'error', message: 'TypeError: cannot read properties of undefined', fingerprint: sha('8') },
  ...extra,
})

const capture = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
    schema_version: 1,
    capture_id: CAPTURE,
    run_id: RUN,
    project_id: PROJECT,
    baseline_commit: REVISION,
    configuration_id: CONFIGURATION,
    configuration_digest: sha('9'),
    target_origin: 'http://localhost:41234',
    viewport: { width: 1280, height: 800, device_scale_factor: 1 },
    state: 'ready',
    document_epoch: 0,
    interactions: [
      interaction(1, { type: 'select', locators: [locator()], value: { kind: 'safe', option: 'open' } }, { related_observation_ids: [IMAGE_OBSERVATION] }),
      interaction(2, { type: 'click', locators: [{ kind: 'role', role: 'checkbox', name: 'Review sample data' }] }),
    ],
    observations: [imageObservation(), consoleObservation()],
    counters: { unavailable: 0, unsupported: 0, dropped: 0 },
    completeness: { status: 'complete', reasons: [] },
    timing: { started_offset_ms: 0, finished_offset_ms: 500 },
    staged_bytes: 41_000,
    seal: { report_sha256: sha('a') },
  }
  mutate(body)
  return body
}

const replay = (): Json => ({
  entry_path: '/',
  viewport: { width: 1280, height: 800, device_scale_factor: 1 },
  actions: [{ op: 'select', locator: locator(), value: 'open' }],
})

const conditions = (): Json[] => [
  { kind: 'element-count', locator: { kind: 'test-id', value: 'task-item' }, count: 3 },
  { kind: 'text', locator: { kind: 'test-id', value: 'task-summary' }, match: 'exact', text: '3 open tasks' },
]

const interpretation = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
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
      observed_problem: 'Choosing Open lists finished tasks.',
      citations: [IMAGE_OBSERVATION],
      replay: replay(),
      expected_conditions: conditions(),
      task_condition_index: 0,
      intent_summary: 'The Open filter should list only unfinished tasks.',
      support_explanation: 'The image after choosing Open shows two finished tasks while the summary reports three open tasks.',
    },
  }
  mutate(body)
  return body
}

const definition = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
    schema_version: 1,
    definition_id: DEFINITION,
    run_id: RUN,
    project_id: PROJECT,
    baseline_commit: REVISION,
    configuration_id: CONFIGURATION,
    configuration_digest: sha('9'),
    capture_id: CAPTURE,
    report_sha256: sha('a'),
    interpretation_id: INTERPRETATION,
    interpretation_sha256: sha('c'),
    replay: replay(),
    expected_conditions: conditions(),
    task_condition_index: 0,
    required_checks: [...MANDATORY_CHECK_IDS, 'project_check:sample-unit'],
    required_evidence: ['image'],
    compiler: { id: 'flowproof-project-replay', version: '1.0.0' },
    protected_digests: { source_tree_sha256: sha('a'), configuration_sha256: sha('3'), checks_sha256: sha('4'), lock_sha256: sha('e') },
    frozen_at: TIME,
  }
  mutate(body)
  return withDefinitionDigest(body as never) as unknown as Json
}

const invocation = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
    schema_version: 1,
    invocation_id: ANALYSIS,
    run_id: RUN,
    phase: 'analysis',
    transport: 'meta',
    requested_model: 'muse-spark-1.3',
    observed_model: 'muse-spark-1.3',
    response_id: 'resp_0123456789abcdef',
    input_sha256: sha('b'),
    included_source_paths: ['src/App.jsx', 'src/tasks.js'],
    included_image_ids: [IMAGE_OBSERVATION],
    included_observation_ids: [IMAGE_OBSERVATION, CONSOLE_OBSERVATION],
    request_bytes: 120_000,
    source_bytes: 3_000,
    status: 'completed',
    error_code: null,
    http_status: 200,
    usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
    latency_ms: 2_500,
    started_at: TIME,
    completed_at: LATER,
  }
  mutate(body)
  return body
}

const candidate = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
    schema_version: 1,
    candidate_id: CANDIDATE,
    run_id: RUN,
    baseline_commit: REVISION,
    definition_id: DEFINITION,
    definition_digest: sha('d'),
    invocation_id: CORRECTION,
    state: 'applied-to-copy',
    patch_sha256: sha('e'),
    patch_bytes: 412,
    changed_paths: ['src/App.jsx'],
    expected_tree_sha256: sha('f'),
    build_sha256: sha('1'),
    rejection_reasons: [],
  }
  mutate(body)
  return body
}

const passedChecks = (): Json[] =>
  [...MANDATORY_CHECK_IDS, 'project_check:sample-unit'].map((checkId) => ({
    id: checkId,
    status: 'passed',
    phase: 'finalization',
    reason: 'CHECK_PASSED',
    evidence_ids: [],
  }))

const result = (mutate: (body: Json) => void = () => undefined): Json => {
  const body: Json = {
    kind: 'project-live',
    schema_version: 1,
    run_id: RUN,
    project_id: PROJECT,
    baseline_commit: REVISION,
    configuration_id: CONFIGURATION,
    configuration_digest: sha('9'),
    capture_id: CAPTURE,
    report_sha256: sha('a'),
    definition_id: DEFINITION,
    definition_digest: sha('d'),
    candidate: { candidate_id: CANDIDATE, state: 'applied-to-copy', patch_sha256: sha('e'), changed_paths: ['src/App.jsx'], build_sha256: sha('1') },
    invocations: [
      { invocation_id: ANALYSIS, phase: 'analysis', transport: 'meta', status: 'completed', requested_model: 'muse-spark-1.3', observed_model: 'muse-spark-1.3', response_id: 'resp_a' },
      { invocation_id: CORRECTION, phase: 'correction', transport: 'meta', status: 'completed', requested_model: 'muse-spark-1.3', observed_model: 'muse-spark-1.3', response_id: 'resp_b' },
    ],
    required_checks: [...MANDATORY_CHECK_IDS, 'project_check:sample-unit'],
    checks: passedChecks(),
    evidence: [{ observation_id: IMAGE_OBSERVATION, phase: 'demonstration', sha256: sha('6') }],
    diff: { artifact_id: id(30), sha256: sha('2') },
    patch: { artifact_id: id(31), sha256: sha('e') },
    outcome: 'passed',
    claim: PROJECT_CLAIM,
    primary_reason: null,
    blockers: [],
    cancel_requested: false,
    original_integrity: 'verified',
    cleanup: 'complete',
    live_acceptance_eligible: true,
    finalized_at: LATER,
  }
  mutate(body)
  return body
}

const failedAt = (body: Json, checkId: string, status: 'failed' | 'not_evaluated', reason: string): void => {
  for (const check of body.checks as Json[]) {
    if (check.id === checkId) {
      check.status = status
      check.reason = reason
    }
  }
}

// ---------------------------------------------------------------------------------------
// Identities and primitive bounds
// ---------------------------------------------------------------------------------------

describe('project-live identities', () => {
  it('issues lowercase random UUIDv4 identities and canonical SHA-256 digests', () => {
    const issued = new Set(Array.from({ length: 64 }, () => newProjectUuid()))
    expect(issued.size).toBe(64)
    for (const value of issued) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(projectDigest({ b: 1, a: [true, null] })).toBe(projectDigest({ a: [true, null], b: 1 }))
    expect(projectDigest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects uppercase, non-v4, nil and malformed identities or digests', () => {
    expectValid(parseProjectContext({ ...projectContext(), project_id: 'abcdef01-0000-4000-8000-0000000000ab' }))
    for (const bad of ['abcdef01-0000-4000-8000-0000000000ab'.toUpperCase(), '00000000-0000-1000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'run-1', 42]) {
      expectInvalid(parseProjectContext({ ...projectContext(), project_id: bad }))
    }
    for (const bad of [sha('A'), 'a'.repeat(63), `sha256:${sha('a')}`]) {
      expectInvalid(parseProjectContext({ ...projectContext(), admitted_tree_sha256: bad }))
    }
    expectInvalid(parseProjectContext({ ...projectContext(), baseline_commit: REVISION.slice(0, 12) }))
    expectValid(parseProjectContext({ ...projectContext(), baseline_commit: sha('a') }))
  })

  it('reports bindings between objects that name another run, capture, baseline or configuration', () => {
    const expected = { run_id: RUN, capture_id: CAPTURE, baseline_commit: REVISION, configuration_digest: sha('9') }
    expect(bindingMismatches(expected, capture() as never)).toEqual([])
    expect(bindingMismatches(expected, { ...capture(), run_id: id(99) } as never)).toEqual(['run_id'])
    expect(bindingMismatches(expected, { ...capture(), capture_id: id(98), baseline_commit: sha('a') } as never)).toEqual(['baseline_commit', 'capture_id'])
    expect(bindingMismatches({ definition_digest: sha('d') }, { ...result() } as never)).toEqual([])
    expect(bindingMismatches({ definition_digest: sha('d') }, { ...result(), definition_digest: sha('0') } as never)).toEqual(['definition_digest'])
  })
})

describe('ProjectContext', () => {
  it('accepts a ready admitted project', () => {
    expectValid(parseProjectContext(projectContext()))
  })

  it('rejects extra keys, including any client-supplied filesystem authority', () => {
    for (const key of ['canonical_root', 'root', 'path', 'state_root', 'artifact_root', 'mounts']) {
      expectInvalid(parseProjectContext({ ...projectContext(), [key]: '/home/user/project' }))
    }
    const nested = projectContext()
    ;(nested.profile as Json).image_tag = 'latest'
    expectInvalid(parseProjectContext(nested))
  })

  it('keeps the category, profile image and admission states closed', () => {
    expectInvalid(parseProjectContext({ ...projectContext(), category: 'next-ssr' }))
    expectInvalid(parseProjectContext({ ...projectContext(), profile: { ...(projectContext().profile as Json), image_id: 'flowproof-project-vite:latest' } }))
    for (const state of ['inspecting', 'ready', 'blocked', 'stale']) {
      const reasons = state === 'blocked' || state === 'stale' ? ['TRACKED_CHANGES'] : []
      expectValid(parseProjectContext({ ...projectContext(), admission: { state, reasons, required_prerequisites: [] } }))
    }
    expectInvalid(parseProjectContext({ ...projectContext(), admission: { state: 'ready', reasons: ['TRACKED_CHANGES'], required_prerequisites: [] } }), 'ADMISSION_READY_WITH_REASONS')
    expectInvalid(parseProjectContext({ ...projectContext(), admission: { state: 'blocked', reasons: [], required_prerequisites: [] } }), 'ADMISSION_REASON_REQUIRED')
    expectInvalid(parseProjectContext({ ...projectContext(), admission: { state: 'approved', reasons: [], required_prerequisites: [] } }))
  })

  it('confines source and protected paths', () => {
    for (const bad of ['/etc/passwd', '../outside.js', 'src/../package.json', 'src/./a.js', 'src\\a.js', 'src//a.js', 'package.json', '~/src/a.js', 'src/a\u0000.js']) {
      expectInvalid(parseProjectContext({ ...projectContext(), allowed_source_paths: [bad] }))
    }
    expectInvalid(parseProjectContext({ ...projectContext(), allowed_source_paths: ['src/a.js', 'src/a.js'] }), 'NOT_UNIQUE')
    expectInvalid(
      parseProjectContext({ ...projectContext(), protected_inputs: [{ path: '/repo/package.json', kind: 'package', sha256: sha('1') }] }),
    )
    expectInvalid(parseProjectContext({ ...projectContext(), display_root: 'repo\u202e' }))
    expectInvalid(parseProjectContext({ ...projectContext(), label: 'token=sk-flowproof0123456789abcdef' }))
  })
})

describe('project configuration file', () => {
  it('accepts the strict sample configuration', () => {
    expectValid(parseProjectConfigFile(configFile()))
    expectValid(parseProjectConfigFile({ ...configFile(), required_project_checks: [] }))
  })

  it('cannot choose image, network, mounts, model, credentials, environment or artifact roots', () => {
    for (const key of ['image', 'image_id', 'network', 'mounts', 'model', 'endpoint', 'api_key', 'environment', 'env', 'artifacts_root', 'browser_profile', 'evaluator']) {
      expectInvalid(parseProjectConfigFile({ ...configFile(), [key]: 'x' }))
    }
    expectInvalid(parseProjectConfigFile({ ...configFile(), build: { ...(configFile().build as Json), network: 'bridge' } }))
  })

  it('accepts direct argv only, without shells, environment assignments, host paths or traversal', () => {
    const withBuild = (argv: unknown): Json => ({ ...configFile(), build: { argv, output_directory: 'dist' } })
    for (const argv of [
      ['sh', '-c', 'vite build'],
      ['/bin/bash', 'build.sh'],
      ['bash', '-lc', 'npm run build'],
      ['env', 'NODE_ENV=production', 'node', 'build.js'],
      ['NODE_OPTIONS=--require=x', 'node', 'build.js'],
      ['node', '/home/user/.npmrc'],
      ['node', '/etc/passwd'],
      ['node', '../outside.js'],
      ['node', '/opt/flowproof/toolchain/../../etc/passwd'],
      ['node', 'build\u0000.js'],
      ['node', 'a\nb'],
      [''],
      [],
      Array.from({ length: 33 }, () => 'x'),
      ['node', 'x'.repeat(1025)],
    ]) {
      expectInvalid(parseProjectConfigFile(withBuild(argv)))
    }
    expectValid(parseProjectConfigFile(withBuild(['node', '/workspace/scripts/build.mjs'])))
  })

  it('keeps entry, output and check settings relative, confined and bounded', () => {
    for (const entry of ['http://localhost:1/', '//evil.example/', 'index.html', '/../x', '/a/%2e%2e/b', '/a?token=1', '/a#x', '/a b']) {
      expectInvalid(parseProjectConfigFile({ ...configFile(), entry_path: entry }))
    }
    expectValid(parseProjectConfigFile({ ...configFile(), entry_path: '/tasks/index.html' }))
    for (const output of ['/dist', '../dist', '.', 'src', 'src/out', 'node_modules/.out', '.git']) {
      expectInvalid(parseProjectConfigFile({ ...configFile(), build: { ...(configFile().build as Json), output_directory: output } }))
    }
    const check = { id: 'sample-unit', argv: ['node', '--test'] }
    expectInvalid(parseProjectConfigFile({ ...configFile(), required_project_checks: [check, check] }), 'NOT_UNIQUE')
    expectInvalid(
      parseProjectConfigFile({ ...configFile(), required_project_checks: Array.from({ length: 9 }, (_, index) => ({ id: `check-${index}`, argv: ['node', '--test'] })) }),
    )
    expectInvalid(parseProjectConfigFile({ ...configFile(), required_project_checks: [{ id: 'Bad_ID', argv: ['node'] }] }))
    expectInvalid(parseProjectConfigFile({ ...configFile(), schema_version: 2 }))
  })
})

describe('ExecutionConfiguration', () => {
  it('accepts a host-confirmed configuration whose digest binds every setting', () => {
    expectValid(parseExecutionConfiguration(configuration()))
    expectValid(parseExecutionConfiguration(configuration((body) => void (body.confirmation = { state: 'pending' }))))
  })

  it('rejects a changed setting under the old digest and issues a new digest for new settings', () => {
    const original = configuration()
    const tampered = { ...original, entry_path: '/other/' }
    expectInvalid(parseExecutionConfiguration(tampered), 'CONFIGURATION_DIGEST_MISMATCH')
    const reconfigured = configuration((body) => void (body.entry_path = '/other/'))
    expectValid(parseExecutionConfiguration(reconfigured))
    expect(reconfigured.configuration_digest).not.toBe(original.configuration_digest)
    // Confirmation state is not part of the bound settings.
    expect(configuration((body) => void (body.confirmation = { state: 'pending' })).configuration_digest).toBe(original.configuration_digest)
  })

  it('pins the exact Plan runtime limits, offline network and immutable profile image', () => {
    expect(EXECUTION_LIMITS).toEqual({
      cpu_count: 1,
      memory_bytes: 1_073_741_824,
      pids: 256,
      stop_grace_ms: 5_000,
      phase_timeout_ms: 120_000,
      provider_timeout_ms: 90_000,
      aggregate_automatic_ms: 600_000,
    })
    const limit = (field: string, value: unknown): Json =>
      configuration((body) => void ((body.profile as Json).limits = { ...((body.profile as Json).limits as Json), [field]: value }))
    for (const [field, value] of [
      ['cpu_count', 2],
      ['memory_bytes', 2_147_483_648],
      ['pids', 1024],
      ['stop_grace_ms', 30_000],
      ['phase_timeout_ms', 300_000],
      ['provider_timeout_ms', 120_000],
      ['aggregate_automatic_ms', 900_000],
    ] as const) {
      expectInvalid(parseExecutionConfiguration(limit(field, value)))
    }
    expectInvalid(parseExecutionConfiguration(configuration((body) => void ((body.profile as Json).network = 'bridge'))))
    expectInvalid(parseExecutionConfiguration(configuration((body) => void ((body.profile as Json).image_id = 'node:24'))))
    expectInvalid(parseExecutionConfiguration(configuration((body) => void ((body.profile as Json).byte_limits = { max_output_bytes: 0, max_output_files: 1, max_diagnostic_bytes: 65_536 }))))
  })

  it('never removes or reorders a mandatory check and admits no secret or reserved environment name', () => {
    expectInvalid(parseExecutionConfiguration(configuration((body) => void (body.mandatory_checks = MANDATORY_CHECK_IDS.slice(1)))))
    expectInvalid(parseExecutionConfiguration(configuration((body) => void (body.mandatory_checks = [...MANDATORY_CHECK_IDS].reverse()))))
    for (const name of ['MODEL_API_KEY', 'GITHUB_TOKEN', 'HOME', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'lower_case']) {
      expectInvalid(parseExecutionConfiguration(configuration((body) => void ((body.profile as Json).environment_allowlist = [name]))))
    }
    expect(requiredCheckIds(configuration() as never)).toEqual([
      ...MANDATORY_CHECK_IDS,
      projectCheckId('sample-unit'),
    ])
  })

  it('requires an exact Studio-independent localhost target origin and a confirmation time', () => {
    for (const origin of ['http://127.0.0.1:41234', 'https://localhost:41234', 'http://localhost:80', 'http://localhost:041234', 'http://localhost:41234/', 'http://localhost']) {
      expectInvalid(parseExecutionConfiguration(configuration((body) => void (body.target_origin = origin))))
    }
    expectInvalid(parseExecutionConfiguration(configuration((body) => void (body.confirmation = { state: 'confirmed' }))))
    expectInvalid(parseExecutionConfiguration(configuration((body) => void (body.confirmation = { state: 'pending', confirmed_at: TIME }))))
  })
})

// ---------------------------------------------------------------------------------------
// Capture and observations
// ---------------------------------------------------------------------------------------

describe('DemonstrationCapture', () => {
  it('accepts a sealed ready capture with ordered host-assigned interactions', () => {
    expectValid(parseDemonstrationCapture(capture()))
  })

  it('implements exactly the declared capture transitions', () => {
    const allowed = [
      ['idle', 'recording'],
      ['recording', 'finishing'],
      ['finishing', 'ready'],
      ['recording', 'discarded'],
      ['finishing', 'discarded'],
      ['ready', 'discarded'],
      ['recording', 'incomplete'],
      ['recording', 'unsupported'],
      ['finishing', 'incomplete'],
      ['finishing', 'unsupported'],
    ]
    const states = ['idle', 'recording', 'finishing', 'ready', 'discarded', 'incomplete', 'unsupported']
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionCapture(from as never, to as never), `${from} -> ${to}`).toBe(allowed.some(([a, b]) => a === from && b === to))
      }
    }
  })

  it('requires a seal and at least one interaction to be ready, and clears discarded data', () => {
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.seal = null))), 'CAPTURE_SEAL_REQUIRED')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = []))), 'CAPTURE_EMPTY')
    const discarded = capture((body) => {
      body.state = 'discarded'
      body.seal = null
      body.completeness = null
    })
    expectInvalid(parseDemonstrationCapture(discarded), 'CAPTURE_DISCARDED_NOT_CLEARED')
    expectValid(
      parseDemonstrationCapture(
        capture((body) => {
          Object.assign(body, { state: 'discarded', seal: null, completeness: null, interactions: [], observations: [], staged_bytes: 0 })
        }),
      ),
    )
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.state = 'recording'))), 'CAPTURE_SEAL_FORBIDDEN')
  })

  it('makes incomplete and unsupported states explicit with reasons', () => {
    expectValid(parseDemonstrationCapture(capture((body) => void Object.assign(body, { state: 'incomplete', completeness: { status: 'incomplete', reasons: ['ACTION_LIMIT_EXCEEDED'] } }))))
    expectInvalid(parseDemonstrationCapture(capture((body) => void Object.assign(body, { state: 'incomplete', completeness: { status: 'incomplete', reasons: [] } }))), 'CAPTURE_REASON_REQUIRED')
    expectInvalid(parseDemonstrationCapture(capture((body) => void Object.assign(body, { state: 'ready', completeness: { status: 'incomplete', reasons: ['X'] } }))), 'CAPTURE_COMPLETENESS_MISMATCH')
    expectInvalid(parseDemonstrationCapture(capture((body) => void Object.assign(body, { state: 'unsupported', completeness: { status: 'complete', reasons: [] } }))))
  })

  it('never marks a capture with dropped or unsupported events as ready and complete', () => {
    for (const counter of ['dropped', 'unsupported']) {
      const lossy = capture((body) => void ((body.counters as Json)[counter] = 1))
      expectInvalid(parseDemonstrationCapture(lossy), 'CAPTURE_READY_LOSSY')
    }
    expectValid(parseDemonstrationCapture(capture((body) => void ((body.counters as Json).unavailable = 1))))
    const incomplete = capture((body) => {
      Object.assign(body, { state: 'incomplete', completeness: { status: 'incomplete', reasons: ['EVENT_DROPPED'] } })
      ;(body.counters as Json).dropped = 1
    })
    expectValid(parseDemonstrationCapture(incomplete))
  })

  it('rejects out-of-order, duplicate, foreign or future-epoch interactions', () => {
    const interactions = (capture().interactions as Json[]).map(clone)
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [interactions[1], interactions[0]]))), 'INTERACTION_SEQUENCE_ORDER')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [interactions[0], { ...interactions[1], sequence: 1 }]))), 'INTERACTION_SEQUENCE_ORDER')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [interactions[0], { ...interactions[1], capture_id: id(99) }]))), 'INTERACTION_CAPTURE_MISMATCH')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [{ ...interactions[0], document_epoch: 2 }, interactions[1]]))), 'INTERACTION_EPOCH_ORDER')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [interactions[0], { ...interactions[1], offset_ms: 0 }]))), 'INTERACTION_OFFSET_ORDER')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = [{ ...interactions[0], related_observation_ids: [id(97)] }, interactions[1]]))), 'OBSERVATION_REFERENCE_UNKNOWN')
  })

  it('enforces the 200-action, 16-image, 1-MiB image, 64-KiB error and 20-MiB report limits', () => {
    expect(PROJECT_LIMITS).toMatchObject({
      maxActions: 200,
      maxImages: 16,
      maxImageBytes: 1_048_576,
      maxErrorSummaryBytes: 65_536,
      maxStagedReportBytes: 20_971_520,
    })
    const many = Array.from({ length: 201 }, (_, index) => interaction(index + 1, { type: 'click', locators: [locator()] }))
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.interactions = many))))
    const images = Array.from({ length: 17 }, (_, index) => imageObservation({ observation_id: id(200 + index) }))
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.observations = images))), 'IMAGE_LIMIT_EXCEEDED')
    const large = imageObservation()
    ;((large.payload as Json).artifact as Json).bytes = 1_048_577
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.observations = [large]))))
    const errors = Array.from({ length: 40 }, (_, index) =>
      consoleObservation({ observation_id: id(300 + index), payload: { level: 'error', message: 'e'.repeat(2_000), fingerprint: sha('8') } }),
    )
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.observations = errors))), 'ERROR_SUMMARY_LIMIT_EXCEEDED')
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.staged_bytes = 20_971_521))))
    expectInvalid(parseDemonstrationCapture(capture((body) => void (body.staged_bytes = 10))), 'STAGED_BYTES_INCONSISTENT')
  })
})

describe('InteractionObservation', () => {
  const valid = (action: Json): void => expectValid(parseInteractionObservation(interaction(1, action)))
  const invalid = (action: Json): void => expectInvalid(parseInteractionObservation(interaction(1, action)))

  it('admits click, safe fill, native select, coalesced scroll and same-origin navigation only', () => {
    valid({ type: 'click', locators: [locator(), { kind: 'role', role: 'button', name: 'Add' }, { kind: 'css', selector: 'main > ul.tasks li:nth-of-type(2)' }] })
    valid({ type: 'fill', locators: [locator()], value: { kind: 'safe', text: 'Buy milk' } })
    valid({ type: 'fill', locators: [locator()], value: { kind: 'redacted', reason: 'SENSITIVE_FIELD' } })
    valid({ type: 'select', locators: [locator()], value: { kind: 'safe', option: 'open' } })
    valid({ type: 'scroll', target: { kind: 'page' }, x: 0, y: 1200 })
    valid({ type: 'scroll', target: { kind: 'element', locators: [locator()] }, x: 0, y: 40 })
    valid({ type: 'navigate', path: '/tasks?filter=open#top' })
    for (const type of ['drag', 'upload', 'keypress', 'evaluate', 'popup']) invalid({ type, locators: [locator()] })
  })

  it('never carries a secret value, an attribute-based selector or an external navigation', () => {
    invalid({ type: 'fill', locators: [locator()], value: { kind: 'safe', text: 'password=hunter2-flowproof-secret' } })
    invalid({ type: 'fill', locators: [locator()], value: { kind: 'redacted', reason: 'SENSITIVE_FIELD', text: 'x' } })
    invalid({ type: 'click', locators: [{ kind: 'css', selector: 'input[value="secret"]' }] })
    invalid({ type: 'click', locators: [{ kind: 'css', selector: 'body * { color: red }' }] })
    invalid({ type: 'click', locators: [{ kind: 'role', role: 'not-a-role', name: 'x' }] })
    invalid({ type: 'click', locators: [] })
    invalid({ type: 'click', locators: Array.from({ length: 5 }, () => locator()) })
    for (const path of ['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', 'tasks', '/a/../b', '/x?api_key=sk-flowproof0123456789abcdef']) {
      invalid({ type: 'navigate', path })
    }
    invalid({ type: 'scroll', target: { kind: 'page' }, x: -1, y: 0 })
  })
})

describe('SafeObservation', () => {
  it('accepts masked image and sanitized error observations', () => {
    expectValid(parseSafeObservation(imageObservation()))
    expectValid(parseSafeObservation(consoleObservation()))
    expectValid(
      parseSafeObservation({
        ...consoleObservation(),
        type: 'network-error',
        payload: { method: 'GET', path: '/assets/app.js', status: 404, error_class: 'HTTP_ERROR', fingerprint: sha('3') },
      }),
    )
    expectValid(parseSafeObservation({ ...consoleObservation(), type: 'page-error', payload: { message: 'ReferenceError: x is not defined', fingerprint: sha('4') } }))
  })

  it('requires explicit unavailable/omitted states with reasons and no artifact', () => {
    expectValid(parseSafeObservation(imageObservation({ availability: 'unavailable', reason: 'COLLECTOR_UNAVAILABLE', payload: null })))
    expectValid(parseSafeObservation(imageObservation({ availability: 'omitted', reason: 'SENSITIVE_SURFACE', payload: null })))
    expectInvalid(parseSafeObservation(imageObservation({ availability: 'unavailable', reason: null, payload: null })), 'OBSERVATION_REASON_REQUIRED')
    expectInvalid(parseSafeObservation(imageObservation({ availability: 'unavailable', reason: 'X' })), 'OBSERVATION_PAYLOAD_FORBIDDEN')
    expectInvalid(parseSafeObservation(imageObservation({ payload: null })), 'OBSERVATION_PAYLOAD_REQUIRED')
    expectInvalid(parseSafeObservation(imageObservation({ reason: 'X' })), 'OBSERVATION_REASON_FORBIDDEN')
  })

  it('accepts only masked-before-retention PNG artifacts within the viewport', () => {
    const unmasked = imageObservation()
    ;(unmasked.payload as Json).masked_before_retention = false
    expectInvalid(parseSafeObservation(unmasked))
    const jpeg = imageObservation()
    ;((jpeg.payload as Json).artifact as Json).media_type = 'image/jpeg'
    expectInvalid(parseSafeObservation(jpeg))
    const outside = imageObservation()
    ;(outside.payload as Json).clip = { x: 100, y: 0, width: 1280, height: 800 }
    expectInvalid(parseSafeObservation(outside), 'IMAGE_CLIP_OUTSIDE_VIEWPORT')
  })

  it('keeps error payloads free of secrets, queries and unbounded text', () => {
    expectInvalid(parseSafeObservation(consoleObservation({ payload: { level: 'error', message: 'Authorization: Bearer sk-flowproof0123456789abcdef', fingerprint: sha('8') } })))
    expectInvalid(parseSafeObservation(consoleObservation({ payload: { level: 'error', message: 'x'.repeat(2_049), fingerprint: sha('8') } })))
    expectInvalid(
      parseSafeObservation({ ...consoleObservation(), type: 'network-error', payload: { method: 'GET', path: '/api?token=1', status: 500, error_class: 'HTTP_ERROR', fingerprint: sha('3') } }),
    )
    expectInvalid(parseSafeObservation({ ...consoleObservation(), type: 'network-error', payload: { method: 'GET', path: '/a', status: 500, error_class: 'HTTP_ERROR', fingerprint: sha('3'), headers: {} } }))
    expectInvalid(parseSafeObservation(consoleObservation({ phase: 'demonstration', capture_id: null })), 'OBSERVATION_CAPTURE_REQUIRED')
    expectInvalid(parseSafeObservation(consoleObservation({ phase: 'baseline' })), 'OBSERVATION_CAPTURE_FORBIDDEN')
  })
})

// ---------------------------------------------------------------------------------------
// Interpretation, definition and provider invocation
// ---------------------------------------------------------------------------------------

describe('Interpretation', () => {
  it('accepts closed ready, clarify and unsupported results', () => {
    expectValid(parseInterpretation(interpretation()))
    expectValid(
      parseInterpretation(
        interpretation((body) => {
          body.result = {
            status: 'clarify',
            observed_facts: 'Choosing Open lists two tasks.',
            citations: [IMAGE_OBSERVATION],
            question: { question_id: id(40), text: 'Should Open list unfinished tasks?', missing_intent: 'The intended filter meaning is unclear.', alternatives: ['Unfinished tasks', 'Finished tasks'] },
          }
        }),
      ),
    )
    expectValid(parseInterpretation(interpretation((body) => void (body.result = { status: 'unsupported', reason: 'UNSUPPORTED_ACTION', explanation: 'A drag gesture cannot be replayed.', citations: [] }))))
  })

  it('requires a complete replay and 1-8 conditions with a valid designated task condition', () => {
    const ready = (mutate: (result: Json) => void): Json => interpretation((body) => mutate(body.result as Json))
    expectInvalid(parseInterpretation(ready((r) => void (r.expected_conditions = []))))
    expectInvalid(parseInterpretation(ready((r) => void (r.expected_conditions = Array.from({ length: 9 }, (_, n) => ({ kind: 'element-count', locator: locator(), count: n }))))))
    expectInvalid(parseInterpretation(ready((r) => void (r.task_condition_index = 2))), 'TASK_CONDITION_INDEX_INVALID')
    expectInvalid(parseInterpretation(ready((r) => void ((r.replay as Json).actions = []))))
    expectInvalid(parseInterpretation(ready((r) => void (r.citations = []))))
    expectInvalid(parseInterpretation(ready((r) => void (r.expected_conditions = [conditions()[0], conditions()[0]]))), 'NOT_UNIQUE')
  })

  it('rejects executable, unknown or placeholder replay operations and conditions', () => {
    const withAction = (action: Json): Json => interpretation((body) => void (((body.result as Json).replay as Json).actions = [action]))
    for (const action of [
      { op: 'evaluate', script: 'document.body.innerHTML = ""' },
      { op: 'shell', argv: ['rm', '-rf', '/'] },
      { op: 'click', locator: { kind: 'xpath', value: '//button' } },
      { op: 'click', locator: locator(), code: 'x()' },
      { op: 'navigate', path: 'https://evil.example/' },
      { op: 'wait', until: { kind: 'visible', locator: locator() }, timeout_ms: 10_001 },
      { op: 'wait', until: { kind: 'sleep' }, timeout_ms: 100 },
      { op: 'fill', locator: locator(), value: 'api_key=sk-flowproof0123456789abcdef' },
      { op: 'scroll', target: { kind: 'page' }, x: 0, y: 100_001 },
    ]) {
      expectInvalid(parseInterpretation(withAction(action)))
    }
    expectValid(parseInterpretation(withAction({ op: 'wait', until: { kind: 'text', locator: locator(), text: 'Ready' }, timeout_ms: 2_000 })))
    const withCondition = (condition: Json): Json => interpretation((body) => void ((body.result as Json).expected_conditions = [condition]))
    for (const condition of [
      { kind: 'screenshot-diff', threshold: 0.1 },
      { kind: 'script', code: 'return true' },
      { kind: 'text', locator: locator(), match: 'exact', text: '' },
      { kind: 'text', locator: locator(), match: 'regex', text: '.*' },
      { kind: 'always', value: true },
      { kind: 'model-pass', statement: 'fixed' },
    ]) {
      expectInvalid(parseInterpretation(withCondition(condition)))
    }
  })

  it('permits at most one clarified re-analysis, which cannot ask again', () => {
    const clarification = { question_id: id(40), answer_id: id(41), answer_sha256: sha('9') }
    expectValid(parseInterpretation(interpretation((body) => void Object.assign(body, { analysis_attempt: 2, clarification }))))
    expectInvalid(parseInterpretation(interpretation((body) => void Object.assign(body, { analysis_attempt: 3, clarification }))))
    expectInvalid(parseInterpretation(interpretation((body) => void Object.assign(body, { analysis_attempt: 2, clarification: null }))), 'CLARIFICATION_REQUIRED')
    expectInvalid(parseInterpretation(interpretation((body) => void Object.assign(body, { analysis_attempt: 1, clarification }))), 'CLARIFICATION_FORBIDDEN')
    const askAgain = interpretation((body) => {
      Object.assign(body, { analysis_attempt: 2, clarification })
      body.result = { status: 'clarify', observed_facts: 'x', citations: [IMAGE_OBSERVATION], question: { question_id: id(42), text: 'Again?', missing_intent: 'x', alternatives: [] } }
    })
    expectInvalid(parseInterpretation(askAgain), 'CLARIFICATION_REPEATED')
  })
})

describe('FrozenVerificationDefinition', () => {
  it('accepts a definition whose digest binds the frozen obligation', () => {
    expectValid(parseFrozenVerificationDefinition(definition()))
  })

  it('rejects an edited obligation, missing mandatory checks or a placeholder compiler identity', () => {
    const original = definition()
    expectInvalid(parseFrozenVerificationDefinition({ ...original, expected_conditions: [conditions()[1]] }), 'DEFINITION_DIGEST_MISMATCH')
    expectInvalid(parseFrozenVerificationDefinition({ ...original, task_condition_index: 1 }), 'DEFINITION_DIGEST_MISMATCH')
    expectInvalid(parseFrozenVerificationDefinition(definition((body) => void (body.required_checks = MANDATORY_CHECK_IDS.slice(0, 5)))), 'MANDATORY_CHECK_MISSING')
    expectInvalid(parseFrozenVerificationDefinition(definition((body) => void (body.required_checks = ['project_check:sample-unit', ...MANDATORY_CHECK_IDS]))), 'MANDATORY_CHECK_ORDER')
    expectInvalid(parseFrozenVerificationDefinition(definition((body) => void (body.compiler = { id: 'model', version: '1.0.0' }))))
    expectInvalid(parseFrozenVerificationDefinition(definition((body) => void (body.task_condition_index = 5))), 'TASK_CONDITION_INDEX_INVALID')
  })
})

describe('ProviderInvocation', () => {
  it('accepts an actual completed exchange with matching requested and observed model', () => {
    expectValid(parseProviderInvocation(invocation()))
    expectValid(parseProviderInvocation(invocation((body) => void Object.assign(body, { status: 'started', observed_model: null, response_id: null, http_status: null, usage: { input_tokens: null, output_tokens: null, total_tokens: null }, latency_ms: null, completed_at: null }))))
    expectValid(parseProviderInvocation(invocation((body) => void Object.assign(body, { transport: 'test_transport' }))))
  })

  it('never marks a call completed without the actual response identity', () => {
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.response_id = null))), 'INVOCATION_RESPONSE_REQUIRED')
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.observed_model = null))), 'INVOCATION_RESPONSE_REQUIRED')
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.observed_model = 'other-model'))), 'INVOCATION_MODEL_MISMATCH')
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.requested_model = 'gpt-x'))))
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.completed_at = null))), 'INVOCATION_COMPLETION_TIME')
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.completed_at = '2026-11-04T09:00:00.000Z'))), 'INVOCATION_COMPLETION_TIME')
    expectInvalid(parseProviderInvocation(invocation((body) => void Object.assign(body, { status: 'failed', error_code: null }))), 'INVOCATION_ERROR_REQUIRED')
    expectInvalid(parseProviderInvocation(invocation((body) => void Object.assign(body, { status: 'started' }))), 'INVOCATION_NOT_FINISHED')
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.transport = 'fixture'))))
  })

  it('bounds request content to 32 source files, 256 KiB source, eight images and 8 MiB', () => {
    expect(PROJECT_LIMITS).toMatchObject({ maxRequestSourceFiles: 32, maxRequestSourceBytes: 262_144, maxRequestImages: 8, maxRequestBytes: 8_388_608 })
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.included_source_paths = Array.from({ length: 33 }, (_, n) => `src/f${n}.js`)))))
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.source_bytes = 262_145))))
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.request_bytes = 8_388_609))))
    const images = Array.from({ length: 9 }, (_, n) => id(500 + n))
    expectInvalid(parseProviderInvocation(invocation((body) => void Object.assign(body, { included_image_ids: images, included_observation_ids: images }))))
    expectInvalid(parseProviderInvocation(invocation((body) => void (body.included_image_ids = [id(600)]))), 'INVOCATION_IMAGE_NOT_INCLUDED')
  })
})

// ---------------------------------------------------------------------------------------
// Candidate and terminal result
// ---------------------------------------------------------------------------------------

describe('Candidate', () => {
  it('accepts proposed, rejected and applied-to-copy candidates', () => {
    expectValid(parseCandidate(candidate()))
    expectValid(parseCandidate(candidate((body) => void Object.assign(body, { state: 'proposed', expected_tree_sha256: null, build_sha256: null }))))
    expectValid(parseCandidate(candidate((body) => void Object.assign(body, { state: 'rejected', expected_tree_sha256: null, build_sha256: null, rejection_reasons: ['PROTECTED_PATH'] }))))
  })

  it('bounds a patch to eight existing src/ text files and 64 KiB', () => {
    expect(PROJECT_LIMITS).toMatchObject({ maxPatchFiles: 8, maxPatchBytes: 65_536 })
    expectInvalid(parseCandidate(candidate((body) => void (body.changed_paths = Array.from({ length: 9 }, (_, n) => `src/f${n}.js`)))))
    expectInvalid(parseCandidate(candidate((body) => void (body.patch_bytes = 65_537))))
    expectInvalid(parseCandidate(candidate((body) => void (body.patch_bytes = 0))))
    for (const path of ['package.json', 'package-lock.json', 'tests/tasks.test.mjs', 'vite.config.js', '../src/App.jsx', '/src/App.jsx']) {
      expectInvalid(parseCandidate(candidate((body) => void (body.changed_paths = [path]))))
    }
    expectInvalid(parseCandidate(candidate((body) => void (body.changed_paths = ['src/a.js', 'src/a.js']))), 'NOT_UNIQUE')
  })

  it('keeps each candidate state consistent', () => {
    expectInvalid(parseCandidate(candidate((body) => void Object.assign(body, { state: 'rejected', rejection_reasons: [] }))), 'CANDIDATE_REASON_REQUIRED')
    expectInvalid(parseCandidate(candidate((body) => void (body.rejection_reasons = ['X']))), 'CANDIDATE_REASON_FORBIDDEN')
    expectInvalid(parseCandidate(candidate((body) => void (body.expected_tree_sha256 = null))), 'CANDIDATE_TREE_REQUIRED')
    expectInvalid(parseCandidate(candidate((body) => void Object.assign(body, { state: 'proposed', expected_tree_sha256: null }))), 'CANDIDATE_BUILD_FORBIDDEN')
    expectInvalid(parseCandidate(candidate((body) => void (body.state = 'applied'))))
  })
})

describe('ProjectRunResult', () => {
  it('accepts a passed result only with every obligation, identity, integrity and cleanup', () => {
    expect(CHECK_STATUSES).toEqual(['passed', 'failed', 'not_evaluated'])
    expectValid(parseProjectRunResult(result()))
    expectValid(parseProjectRunResult(result((body) => void (body.cleanup = 'recovered'))))
  })

  it('never treats a missing, failed or not-evaluated check as a pass', () => {
    expectInvalid(parseProjectRunResult(result((body) => failedAt(body, 'candidate_replay', 'not_evaluated', 'CHECK_NOT_EVALUATED'))), 'PASSED_REQUIRES_ALL_CHECKS')
    expectInvalid(parseProjectRunResult(result((body) => failedAt(body, 'project_check:sample-unit', 'failed', 'PROJECT_CHECK_FAILED'))), 'PASSED_REQUIRES_ALL_CHECKS')
    expectInvalid(parseProjectRunResult(result((body) => void (body.checks = (body.checks as Json[]).slice(1)))), 'CHECKS_DO_NOT_MATCH_REQUIRED')
    expectInvalid(parseProjectRunResult(result((body) => void (body.required_checks = MANDATORY_CHECK_IDS.slice(1)))), 'MANDATORY_CHECK_MISSING')
    expectInvalid(parseProjectRunResult(result((body) => void ((body.checks as Json[])[0]!.status = 'pass'))))
    expectInvalid(parseProjectRunResult(result((body) => void (body.candidate = null))), 'PASSED_REQUIRES_CANDIDATE')
    expectInvalid(parseProjectRunResult(result((body) => void (body.invocations = (body.invocations as Json[]).slice(0, 1)))), 'PASSED_REQUIRES_CORRECTION')
  })

  it('lets integrity, cleanup and cancellation override a provisional pass', () => {
    expectInvalid(parseProjectRunResult(result((body) => void (body.original_integrity = 'unverified'))), 'OUTCOME_PRECEDENCE')
    expectInvalid(parseProjectRunResult(result((body) => void (body.cleanup = 'failed'))), 'OUTCOME_PRECEDENCE')
    expectInvalid(parseProjectRunResult(result((body) => void (body.cancel_requested = true))), 'OUTCOME_PRECEDENCE')
    const canceled = result((body) => {
      Object.assign(body, { outcome: 'canceled', claim: null, primary_reason: 'RUN_CANCELED', live_acceptance_eligible: false, cancel_requested: true })
      failedAt(body, 'candidate_replay', 'not_evaluated', 'CHECK_NOT_EVALUATED')
    })
    expectValid(parseProjectRunResult(canceled))
    expectInvalid(parseProjectRunResult({ ...canceled, cancel_requested: false }), 'OUTCOME_PRECEDENCE')
    expectInvalid(parseProjectRunResult({ ...canceled, outcome: 'cleanup_failed' }), 'OUTCOME_PRECEDENCE')
    const canceledCleanupFailed = clone(canceled)
    Object.assign(canceledCleanupFailed, { cleanup: 'failed' })
    failedAt(canceledCleanupFailed, 'cleanup_complete', 'failed', 'CLEANUP_INCOMPLETE')
    expectInvalid(parseProjectRunResult(canceledCleanupFailed), 'OUTCOME_PRECEDENCE')
    expectValid(parseProjectRunResult({ ...canceledCleanupFailed, outcome: 'cleanup_failed', primary_reason: 'CLEANUP_INCOMPLETE' }))
    const changed = { ...clone(canceledCleanupFailed), original_integrity: 'changed', outcome: 'integrity_failed', primary_reason: 'ORIGINAL_CHANGED' }
    failedAt(changed, 'original_unchanged', 'failed', 'ORIGINAL_CHANGED')
    expectValid(parseProjectRunResult(changed))
    expectInvalid(parseProjectRunResult({ ...changed, outcome: 'cleanup_failed' }), 'OUTCOME_PRECEDENCE')
  })

  it('keeps the claim, reasons, integrity/cleanup checks and live eligibility honest', () => {
    expectInvalid(parseProjectRunResult(result((body) => void (body.claim = 'Verified Fix'))))
    const notReproduced = result((body) => {
      Object.assign(body, { outcome: 'not_reproduced', claim: PROJECT_CLAIM, primary_reason: 'BASELINE_NOT_REPRODUCED', live_acceptance_eligible: false })
      failedAt(body, 'baseline_reproduced', 'failed', 'BASELINE_NOT_REPRODUCED')
    })
    expectInvalid(parseProjectRunResult(notReproduced), 'CLAIM_ONLY_FOR_PASSED')
    expectValid(parseProjectRunResult({ ...notReproduced, claim: null }))
    expectInvalid(parseProjectRunResult({ ...notReproduced, claim: null, primary_reason: null }), 'PRIMARY_REASON_REQUIRED')
    expectInvalid(parseProjectRunResult(result((body) => void (body.primary_reason = 'X'))), 'PASSED_HAS_NO_REASON')
    expectInvalid(parseProjectRunResult(result((body) => failedAt(body, 'original_unchanged', 'failed', 'ORIGINAL_CHANGED'))), 'INTEGRITY_CHECK_MISMATCH')
    expectInvalid(parseProjectRunResult(result((body) => void (body.live_acceptance_eligible = false))), 'LIVE_ELIGIBILITY_MISMATCH')
    const faked = result((body) => {
      for (const entry of body.invocations as Json[]) entry.transport = 'test_transport'
    })
    expectInvalid(parseProjectRunResult(faked), 'LIVE_ELIGIBILITY_MISMATCH')
    expectValid(parseProjectRunResult({ ...faked, live_acceptance_eligible: false }))
    expectInvalid(parseProjectRunResult(result((body) => void (body.kind = 'captured-verification'))))
    expectInvalid(parseProjectRunResult(result((body) => void (body.verdict = 'Verified Fix'))))
  })

  it('requires every completed invocation summary to carry the observed requested model and response ID', () => {
    const summaryAt = (index: number, patch: Json) =>
      result((body) => void Object.assign((body.invocations as Json[])[index]!, patch))
    for (const index of [0, 1]) {
      expectInvalid(parseProjectRunResult(summaryAt(index, { observed_model: null })), 'INVOCATION_RESPONSE_REQUIRED')
      expectInvalid(parseProjectRunResult(summaryAt(index, { response_id: null })), 'INVOCATION_RESPONSE_REQUIRED')
      expectInvalid(parseProjectRunResult(summaryAt(index, { observed_model: 'other-model' })), 'INVOCATION_MODEL_MISMATCH')
    }
    expectInvalid(parseProjectRunResult(summaryAt(0, { status: 'started' })), 'INVOCATION_NOT_FINISHED')
  })

  it('enforces the per-run call budget and evidence references', () => {
    const extraCorrection = { invocation_id: id(70), phase: 'correction', transport: 'meta', status: 'failed', requested_model: 'muse-spark-1.3', observed_model: null, response_id: null }
    expectInvalid(parseProjectRunResult(result((body) => void (body.invocations as Json[]).push(extraCorrection))), 'CALL_BUDGET_EXCEEDED')
    const analysis = (n: number): Json => ({ ...(result().invocations as Json[])[0], invocation_id: id(80 + n) })
    expectInvalid(parseProjectRunResult(result((body) => void (body.invocations as Json[]).unshift(analysis(1)))), 'CALL_BUDGET_EXCEEDED')
    const clarified = { ...analysis(2), phase: 'clarified-analysis' }
    expectValid(parseProjectRunResult(result((body) => void (body.invocations as Json[]).splice(1, 0, clarified))))
    expectInvalid(parseProjectRunResult(result((body) => void (body.invocations = [clarified, (body.invocations as Json[])[1]]))), 'CLARIFIED_WITHOUT_ANALYSIS')
    expectInvalid(parseProjectRunResult(result((body) => void ((body.checks as Json[])[0]!.evidence_ids = [id(90)]))), 'EVIDENCE_REFERENCE_UNKNOWN')
    expectInvalid(parseProjectRunResult(result((body) => void Object.assign(body, { capture_id: null }))), 'IDENTITY_PAIR_INCOMPLETE')
  })

  it('reports a project check that the result silently dropped from its configuration', () => {
    const config = configuration()
    const bound = (mutate: (body: Json) => void = () => undefined): Json =>
      result((body) => {
        body.configuration_digest = config.configuration_digest
        mutate(body)
      })
    expect(resultConfigurationIssues(bound() as never, config as never)).toEqual([])
    const dropped = bound((body) => {
      body.required_checks = [...MANDATORY_CHECK_IDS]
      body.checks = (body.checks as Json[]).filter((check) => check.id !== 'project_check:sample-unit')
    })
    expectValid(parseProjectRunResult(dropped))
    expect(resultConfigurationIssues(dropped as never, config as never)).toEqual(['PROJECT_CHECK_MISSING'])
    expect(resultConfigurationIssues(result() as never, config as never)).toEqual(['CONFIGURATION_MISMATCH'])
    expect(resultConfigurationIssues(bound((body) => void (body.configuration_id = id(99))) as never, config as never)).toEqual(['CONFIGURATION_MISMATCH'])
  })
})

describe('reduceProjectOutcome', () => {
  const checks = (overrides: Record<string, 'passed' | 'failed' | 'not_evaluated'> = {}) =>
    [...MANDATORY_CHECK_IDS, 'project_check:sample-unit'].map((checkId) => ({
      id: checkId,
      status: overrides[checkId] ?? 'passed',
      reason: overrides[checkId] === undefined ? 'CHECK_PASSED' : `${checkId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${overrides[checkId]?.toUpperCase()}`,
    }))
  const base = { cancel_requested: false, original_integrity: 'verified', cleanup: 'complete' } as const

  it('passes only when every check passed and nothing overrides it', () => {
    expect(reduceProjectOutcome({ ...base, checks: checks() })).toEqual({ outcome: 'passed', primary_reason: null, blockers: [] })
    expect(reduceProjectOutcome({ ...base, checks: checks({ candidate_replay: 'not_evaluated' }) }).outcome).toBe('unverified')
  })

  it('maps the first failed check to its outcome and keeps the others as blockers', () => {
    const reduced = reduceProjectOutcome({ ...base, checks: checks({ baseline_reproduced: 'failed', candidate_build: 'failed' }) })
    expect(reduced.outcome).toBe('not_reproduced')
    expect(reduced.primary_reason).toBe('BASELINE_REPRODUCED_FAILED')
    expect(reduced.blockers).toEqual(['CANDIDATE_BUILD_FAILED'])
    expect(reduceProjectOutcome({ ...base, checks: checks({ 'project_check:sample-unit': 'failed' }) }).outcome).toBe('verification_failed')
    expect(reduceProjectOutcome({ ...base, checks: checks({ candidate_applied: 'failed' }) }).outcome).toBe('candidate_rejected')
    expect(reduceProjectOutcome({ ...base, checks: checks({ correction_generated: 'failed' }) }).outcome).toBe('generation_failed')
    expect(reduceProjectOutcome({ ...base, checks: checks({ admission_consistent: 'failed' }) }).outcome).toBe('blocked')
    expect(reduceProjectOutcome({ ...base, checks: checks({ capture_complete: 'failed' }) }).outcome).toBe('unsupported')
    expect(reduceProjectOutcome({ ...base, checks: checks({ evidence_bound: 'failed' }) }).outcome).toBe('unverified')
  })

  it('applies integrity, then cleanup, then cancellation precedence over any phase result', () => {
    expect(reduceProjectOutcome({ ...base, cancel_requested: true, checks: checks() })).toMatchObject({ outcome: 'canceled', primary_reason: 'RUN_CANCELED' })
    expect(reduceProjectOutcome({ ...base, cancel_requested: true, cleanup: 'failed', checks: checks() })).toMatchObject({ outcome: 'cleanup_failed' })
    expect(reduceProjectOutcome({ ...base, cancel_requested: true, cleanup: 'failed', original_integrity: 'changed', checks: checks() })).toMatchObject({
      outcome: 'integrity_failed',
      primary_reason: 'ORIGINAL_CHANGED',
    })
    expect(reduceProjectOutcome({ ...base, original_integrity: 'unverified', checks: checks() })).toMatchObject({ outcome: 'integrity_failed', primary_reason: 'ORIGINAL_UNVERIFIED' })
    expect(reduceProjectOutcome({ ...base, cleanup: 'unverified', checks: checks() })).toMatchObject({ outcome: 'cleanup_failed', primary_reason: 'CLEANUP_UNVERIFIED' })
  })
})
