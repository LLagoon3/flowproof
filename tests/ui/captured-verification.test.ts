import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as contracts from '../../packages/flowproof/src/contracts/index.js'
import { SUBMODULE_COVERAGE_NOTE } from '../../packages/flowproof/src/editing/capture.js'
import { CAPTURED_EXECUTION_KIND as SERVER_EXECUTION_KIND } from '../../packages/flowproof/src/studio/server.js'
import * as engine from '../../packages/flowproof/src/verify/capturedContracts.js'
import {
  CAPTURED_CHECK_IDS,
  CAPTURED_CHECK_REASONS,
  CONTRACT_SCHEMA_VERSION,
  CAPTURED_CLEANUP_RESOURCES,
  CAPTURED_COVERAGE_NOTE,
  CAPTURED_EXECUTION_KIND,
  CAPTURED_ORIGINAL_MISMATCHES,
  CAPTURED_OUTCOME_REASONS,
  CAPTURED_RESULT_KIND,
  CAPTURED_SCHEMA_VERSION,
  CAPTURED_STATUSES,
  StudioClientError,
  createStudioClient,
  isCapturedScenario,
  isCapturedVerificationResult,
  parseCapturedVerificationResult,
  parseRunResult,
  parseStudioEvent,
  parseStudioRunResult,
} from '../../apps/studio/src/api.js'
import type {
  CapturedVerificationResult,
  EventSourceLike,
  GateSummary,
  RunResult,
  RunState,
  ScenarioSummary,
  SseMessage,
  StudioEvent,
  StudioEventType,
} from '../../apps/studio/src/api.js'
import {
  CAPTURED_STATUS_LABELS,
  canStartRun,
  initialStudioState,
  runEventHandlers,
  selectCapturedCheckSummary,
  selectCapturedChecks,
  selectCapturedCleanup,
  selectCapturedEvidence,
  selectCapturedIdentity,
  selectCapturedOutcome,
  selectCapturedTarget,
  selectGateRows,
  selectStudioMode,
  studioReducer,
} from '../../apps/studio/src/state.js'
import type { CapturedRunView, StudioAction, StudioState } from '../../apps/studio/src/state.js'

// T018 for T023/T024: the browser side of the Spec 004 captured verification family. The client
// parser is a browser-safe mirror of `packages/flowproof/src/verify/capturedContracts.ts`, so it is
// checked for parity with the engine on every committed T005 fixture and on generated variants.
// Catalog discrimination is opt-in: legacy entries keep their exact shape. Everything runs without a
// browser or server; HTTP is faked at the `fetch` seam.

const SEEDED = 'sk-flowproofseededcaptured001'
const HERO = 'canvas-filter-hero'
const FAILURE = 'canvas-filter-failure-invalid-citation'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'

const FIXTURE_DIR = new URL('../fixtures/contracts/', import.meta.url)
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as unknown
const CAPTURED_FIXTURES = readdirSync(FIXTURE_DIR).filter((name) => name.startsWith('captured-verification-result.'))
const LEGACY_RESULT_FIXTURES = readdirSync(FIXTURE_DIR).filter((name) => name.startsWith('run-result.'))

const PASSED = fixture('captured-verification-result.valid-passed.json') as CapturedVerificationResult
const FAILED = fixture('captured-verification-result.valid-failed.json') as CapturedVerificationResult
const TIMEOUT = fixture('captured-verification-result.valid-interrupted-timeout.json') as CapturedVerificationResult
const VERIFIED = fixture('run-result.valid-verified.json') as RunResult
const RUN_ID = PASSED.run_id
const REQUEST_ID = PASSED.request_id
const OTHER_ID = 'b0c1d2e3-f405-4617-8829-3a4b5c6d7e8f'
const START = { request_id: REQUEST_ID, run_id: RUN_ID, events_url: `/api/runs/${RUN_ID}/events` } as const

// Test-only mutable view of a JSON fixture.
type Draft = { [key: string]: any }

const variant = (base: unknown, change: (draft: Draft) => void): unknown => {
  const draft = structuredClone(base) as Draft
  change(draft)
  return draft
}

const ENGINE_CHECK_REASONS = engine.CAPTURED_CHECK_REASONS as Readonly<Record<string, readonly [string, string]>>
const ENGINE_OUTCOME_REASONS = engine.CAPTURED_OUTCOME_REASONS as Readonly<Record<string, readonly [string, string]>>
const FAILURE_REFERENCE = { manifest_path: 'evidence/failure/manifest.json', screenshot_path: 'evidence/failure/screenshot.png' }
const REPLAY_REFERENCE = { manifest_path: 'evidence/replay/manifest.json', screenshot_path: 'evidence/replay/screenshot.png' }

/** Sets one check to a reason, with that reason's fixed status and message. */
const setCheck = (draft: Draft, checkId: string, reason: string): void => {
  const check = (draft.checks as Draft[]).find((entry) => entry.check_id === checkId)
  if (check === undefined) throw new Error(`The fixture has no ${checkId} check.`)
  const [status, message] = ENGINE_CHECK_REASONS[reason] ?? ['pass', 'Unknown reason.']
  Object.assign(check, { reason_code: reason, status, message })
}

/** Sets the outcome to a status and reason, with that reason's fixed message. */
const setOutcome = (draft: Draft, status: string, reason: string | null): void => {
  Object.assign(draft, { status, reason_code: reason, message: reason === null ? null : (ENGINE_OUTCOME_REASONS[reason]?.[1] ?? 'Unknown reason.') })
}

function expectParity(label: string, input: unknown, accepted: boolean): void {
  const client = parseCapturedVerificationResult(input) !== null
  const server = engine.parseCapturedVerificationResult(input).ok
  expect({ label, client, server }).toEqual({ label, client: accepted, server: accepted })
}

/** Client and engine agree, whichever way; returns whether the input was accepted. */
function agreed(label: string, input: unknown): boolean {
  const client = parseCapturedVerificationResult(input) !== null
  const server = engine.parseCapturedVerificationResult(input).ok
  expect({ label, client }).toEqual({ label, client: server })
  return server
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

// ---------------------------------------------------------------------------------------
// HTTP seam
// ---------------------------------------------------------------------------------------

const QUIET_SOURCE: EventSourceLike = { addEventListener: () => undefined, close: () => undefined }

function fakeFetch(...replies: Response[]) {
  const paths: string[] = []
  const fetch = async (requestPath: string): Promise<Response> => {
    paths.push(requestPath)
    const reply = replies.shift()
    if (reply === undefined) throw new Error('Unexpected Studio request.')
    return reply
  }
  return { paths, client: createStudioClient({ fetch, openEventSource: () => QUIET_SOURCE }) }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

/** Awaits a rejection and proves its code and message carry no response value. */
async function failure(promise: Promise<unknown>): Promise<StudioClientError> {
  const reason = await promise.then(
    () => null,
    (error: unknown) => error,
  )
  expect(reason).toBeInstanceOf(StudioClientError)
  const error = reason as StudioClientError
  expect(`${error.code} ${error.message}`).not.toContain(SEEDED)
  return error
}

// ---------------------------------------------------------------------------------------
// Client captured-result parser (T023)
// ---------------------------------------------------------------------------------------

describe('Captured client contract: parity with the engine family', () => {
  it('mirrors the engine discriminators, check set, fixed reasons, and cleanup categories', () => {
    expect(CAPTURED_RESULT_KIND).toBe(engine.CAPTURED_RESULT_KIND)
    expect(CAPTURED_SCHEMA_VERSION).toBe(engine.CAPTURED_SCHEMA_VERSION)
    expect(CAPTURED_EXECUTION_KIND).toBe(SERVER_EXECUTION_KIND)
    expect(CAPTURED_CHECK_IDS).toEqual(engine.CAPTURED_CHECK_IDS)
    expect(CAPTURED_STATUSES).toEqual(engine.CAPTURED_STATUSES)
    expect(CAPTURED_CHECK_REASONS).toEqual(engine.CAPTURED_CHECK_REASONS)
    expect(CAPTURED_OUTCOME_REASONS).toEqual(engine.CAPTURED_OUTCOME_REASONS)
    expect(CAPTURED_CLEANUP_RESOURCES).toEqual(engine.CAPTURED_CLEANUP_RESOURCES)
    expect(CAPTURED_ORIGINAL_MISMATCHES).toEqual(engine.CAPTURED_ORIGINAL_MISMATCHES)
    expect(CAPTURED_COVERAGE_NOTE).toBe(SUBMODULE_COVERAGE_NOTE)
    expect(CAPTURED_CHECK_IDS).toHaveLength(10)
  })

  it('accepts and rejects exactly the T005 fixtures the engine parser does', () => {
    expect(CAPTURED_FIXTURES).toHaveLength(11)
    for (const name of CAPTURED_FIXTURES) expectParity(`fixture ${name}`, fixture(name), name.includes('.valid-'))
  })

  it('keeps the families disjoint: neither legacy parser accepts a captured result, and the captured parser accepts no Run Result', () => {
    expect(LEGACY_RESULT_FIXTURES.length).toBeGreaterThanOrEqual(2)
    for (const name of CAPTURED_FIXTURES) {
      expect({ name, client: parseRunResult(fixture(name)) }).toEqual({ name, client: null })
      expect({ name, engine: contracts.parseRunResult(fixture(name)).ok }).toEqual({ name, engine: false })
    }
    for (const name of LEGACY_RESULT_FIXTURES) expectParity(`legacy ${name}`, fixture(name), false)
  })

  it.each<[string, unknown, boolean]>([
    ['coverage note of a gitlink candidate', variant(PASSED, (r) => void (r.coverage.note = SUBMODULE_COVERAGE_NOTE)), true],
    ['nanosecond timestamp', variant(PASSED, (r) => void (r.started_at = '2026-11-03T10:00:00.123456789Z')), true],
    ['eight metrics', variant(PASSED, (r) => void (r.checks[2].metrics = Object.fromEntries(Array.from({ length: 8 }, (_v, i) => [`m${i}`, i])))), true],
    [
      'execution error at a stage',
      variant(FAILED, (r) => {
        setCheck(r, 'build_passed', 'STAGE_ERROR')
        setOutcome(r, 'error', 'VERIFICATION_ERROR')
      }),
      true,
    ],
    [
      'interrupted by close',
      variant(TIMEOUT, (r) => {
        setCheck(r, 'dataset_matches', 'RUN_INTERRUPTED')
        setCheck(r, 'canvas_matches', 'RUN_INTERRUPTED')
        setOutcome(r, 'interrupted', 'RUN_INTERRUPTED')
      }),
      true,
    ],
    [
      'baseline not reproduced',
      variant(FAILED, (r) => {
        setCheck(r, 'baseline_reproduced', 'BASELINE_NOT_REPRODUCED')
        r.checks[1].evidence_ids = []
        r.checks[1].metrics = {}
        for (const id of ['application_complete', 'build_passed']) setCheck(r, id, 'CHECK_NOT_EVALUATED')
        r.checks[2].metrics = {}
        setOutcome(r, 'failed', 'BASELINE_NOT_CONFIRMED')
      }),
      true,
    ],
    [
      'failed secret scan after passing checks',
      variant(PASSED, (r) => {
        setCheck(r, 'secret_scan_clean', 'SECRET_SCAN_FINDINGS')
        setOutcome(r, 'failed', 'FINALIZATION_FAILED')
      }),
      true,
    ],
    [
      'incomplete cleanup reported consistently',
      variant(PASSED, (r) => {
        r.cleanup = { ...r.cleanup, complete: false, remaining_owned_resources: ['worktree', 'private_git_state'] }
        setCheck(r, 'cleanup_complete', 'CLEANUP_INCOMPLETE')
        setOutcome(r, 'failed', 'FINALIZATION_FAILED')
      }),
      true,
    ],
    [
      'unverified original integrity reported consistently',
      variant(PASSED, (r) => {
        r.cleanup = { ...r.cleanup, original_unchanged: false, original_mismatches: ['snapshot'] }
        setCheck(r, 'original_unchanged', 'ORIGINAL_INTEGRITY_UNVERIFIED')
        setOutcome(r, 'failed', 'FINALIZATION_FAILED')
      }),
      true,
    ],
    ['top-level array', [PASSED], false],
    ['null', null, false],
    ['kind of another family', variant(PASSED, (r) => void (r.kind = 'run-result')), false],
    ['schema version 2.0.0', variant(PASSED, (r) => void (r.schema_version = '2.0.0')), false],
    ['legacy status label', variant(PASSED, (r) => void (r.status = 'Verified Fix')), false],
    ['unknown status', variant(PASSED, (r) => void (r.status = 'verified')), false],
    ['uppercase baseline', variant(PASSED, (r) => void (r.baseline_commit = String(r.baseline_commit).toUpperCase())), false],
    ['41-character baseline', variant(PASSED, (r) => void (r.baseline_commit = `${String(r.baseline_commit)}0`)), false],
    ['63-character baseline', variant(PASSED, (r) => void (r.baseline_commit = 'a'.repeat(63))), false],
    ['uppercase patch digest', variant(PASSED, (r) => void (r.candidate_patch_sha256 = String(r.candidate_patch_sha256).toUpperCase())), false],
    ['short patch digest', variant(PASSED, (r) => void (r.candidate_patch_sha256 = 'a'.repeat(63))), false],
    ['run ID not a UUID', variant(PASSED, (r) => void (r.run_id = 'run-1')), false],
    ['request ID equal to the run ID', variant(PASSED, (r) => void (r.request_id = r.run_id)), false],
    ['editing session ID equal to the request ID', variant(PASSED, (r) => void (r.editing_session_id = r.request_id)), false],
    ['scenario ID', variant(PASSED, (r) => void (r.scenario_id = 'Canvas_Filter')), false],
    ['coverage scope', variant(PASSED, (r) => void (r.coverage.scope = 'nested_worktrees')), false],
    ['coverage note text', variant(PASSED, (r) => void (r.coverage.note = 'Submodules were captured.')), false],
    ['coverage extra key', variant(PASSED, (r) => void (r.coverage.path = SEEDED)), false],
    ['passed with a reason', variant(PASSED, (r) => setOutcome(r, 'passed', 'CANDIDATE_FAILED')), false],
    ['passed with a message', variant(PASSED, (r) => void (r.message = 'Candidate verification passed.')), false],
    ['failed without a reason', variant(FAILED, (r) => setOutcome(r, 'failed', null)), false],
    ['failed with a reason of another check', variant(FAILED, (r) => setOutcome(r, 'failed', 'FINALIZATION_FAILED')), false],
    ['failed with a reason of another status', variant(FAILED, (r) => setOutcome(r, 'failed', 'VERIFICATION_ERROR')), false],
    ['failed with a free message', variant(FAILED, (r) => void (r.message = `Build failed: ${SEEDED}`)), false],
    ['failed without a failing check', variant(FAILED, (r) => setCheck(r, 'build_passed', 'STAGE_ERROR')), false],
    ['interrupted with an error reason', variant(TIMEOUT, (r) => setOutcome(r, 'interrupted', 'VERIFICATION_ERROR')), false],
    ['reordered checks', variant(PASSED, (r) => void r.checks.reverse()), false],
    ['eleven checks', variant(PASSED, (r) => void r.checks.push(r.checks[0])), false],
    ['duplicate check', variant(PASSED, (r) => void (r.checks[1] = r.checks[0])), false],
    ['legacy gate ID as a check', variant(PASSED, (r) => void (r.checks[1].check_id = 'failure_reproduced')), false],
    ['check extra key', variant(PASSED, (r) => void (r.checks[3].stdout = SEEDED)), false],
    ['check free message', variant(PASSED, (r) => void (r.checks[3].message = 'Build passed.')), false],
    ['check status against its reason', variant(PASSED, (r) => void (r.checks[3].status = 'fail')), false],
    ['check reason of another check', variant(PASSED, (r) => setCheck(r, 'tests_passed', 'BUILD_PASSED')), false],
    ['check unknown reason', variant(PASSED, (r) => void (r.checks[3].reason_code = 'BUILD_OK')), false],
    ['check lowercase reason', variant(PASSED, (r) => void (r.checks[3].reason_code = 'build_passed')), false],
    ['evidence on a check without evidence', variant(PASSED, (r) => void (r.checks[0].evidence_ids = ['ev_failure_dataset_001'])), false],
    ['replay evidence on the baseline check', variant(PASSED, (r) => void (r.checks[1].evidence_ids = ['ev_replay_dataset_001'])), false],
    ['chart evidence on the dataset check', variant(PASSED, (r) => void (r.checks[5].evidence_ids = ['ev_replay_chart_001'])), false],
    ['malformed Evidence ID', variant(PASSED, (r) => void (r.checks[1].evidence_ids = ['ev_failure_dataset_1'])), false],
    ['duplicate Evidence IDs', variant(PASSED, (r) => void (r.checks[1].evidence_ids = ['ev_failure_dataset_001', 'ev_failure_dataset_001'])), false],
    ['nine Evidence IDs', variant(PASSED, (r) => void (r.checks[1].evidence_ids = Array.from({ length: 9 }, (_v, i) => `ev_failure_dataset_00${i + 1}`))), false],
    ['string metric', variant(PASSED, (r) => void (r.checks[2].metrics = { output: SEEDED })), false],
    ['nested metric', variant(PASSED, (r) => void (r.checks[2].metrics = { nested: { files: 1 } })), false],
    ['array metrics', variant(PASSED, (r) => void (r.checks[2].metrics = [])), false],
    ['nine metrics', variant(PASSED, (r) => void (r.checks[2].metrics = Object.fromEntries(Array.from({ length: 9 }, (_v, i) => [`m${i}`, i])))), false],
    ['uppercase metric key', variant(PASSED, (r) => void (r.checks[2].metrics = { Files: 1 })), false],
    ['before evidence of another phase', variant(PASSED, (r) => void (r.before_evidence = REPLAY_REFERENCE)), false],
    ['after evidence with a raw path', variant(PASSED, (r) => void (r.after_evidence = { ...REPLAY_REFERENCE, manifest_path: '/tmp/replay/manifest.json' })), false],
    ['before evidence extra key', variant(PASSED, (r) => void (r.before_evidence = { ...FAILURE_REFERENCE, host: SEEDED })), false],
    ['passing baseline without before evidence', variant(TIMEOUT, (r) => void (r.before_evidence = null)), false],
    ['passing replay without after evidence', variant(PASSED, (r) => void (r.after_evidence = null)), false],
    ['complete cleanup with remaining resources', variant(PASSED, (r) => void (r.cleanup.remaining_owned_resources = ['worktree'])), false],
    ['unknown cleanup resource', variant(FAILED, (r) => Object.assign(r.cleanup, { complete: false, remaining_owned_resources: ['/tmp/worktree'] })), false],
    ['unchanged original with mismatches', variant(PASSED, (r) => void (r.cleanup.original_mismatches = ['head'])), false],
    ['unknown original facet', variant(PASSED, (r) => Object.assign(r.cleanup, { original_unchanged: false, original_mismatches: ['objects'] })), false],
    ['cleanup extra key', variant(PASSED, (r) => void (r.cleanup.worktree_path = SEEDED)), false],
    ['model duration', variant(PASSED, (r) => void (r.phase_durations_ms.model = 0)), false],
    ['missing phase duration', variant(PASSED, (r) => void delete r.phase_durations_ms.build), false],
    ['negative phase duration', variant(PASSED, (r) => void (r.phase_durations_ms.test = -1)), false],
    ['fractional total duration', variant(PASSED, (r) => void (r.total_duration_ms = 1.5)), false],
    ['offset timestamp', variant(PASSED, (r) => void (r.started_at = '2026-11-03T10:00:00+09:00')), false],
    ['impossible date', variant(PASSED, (r) => void (r.completed_at = '2026-02-30T10:00:00Z')), false],
  ])('%s', (label, input, accepted) => expectParity(label, input, accepted))

  it.each(['diagnosis', 'provider', 'gates', 'failed_gate_ids', 'candidate_diff_path', 'patch', 'raw_paths', 'argv', 'host_root', 'original_head', 'token'])(
    'rejects the extra top-level field %s',
    (field) => expectParity(`extra ${field}`, variant(PASSED, (r) => void (r[field] = SEEDED)), false),
  )

  it('rejects a result missing any one of its fields', () => {
    for (const field of Object.keys(PASSED)) expectParity(`missing ${field}`, variant(PASSED, (r) => void delete r[field]), false)
  })

  it('agrees with the engine for every check and fixed check reason', () => {
    // An interrupted base keeps the outcome rules out of the way, so the per-check reason rules decide.
    const base = variant(TIMEOUT, (r) => void (r.after_evidence = REPLAY_REFERENCE))
    let accepted = 0
    for (const checkId of engine.CAPTURED_CHECK_IDS) {
      for (const reason of Object.keys(engine.CAPTURED_CHECK_REASONS)) {
        if (agreed(`${checkId} ${reason}`, variant(base, (r) => setCheck(r, checkId, reason)))) accepted += 1
      }
    }
    expect(accepted).toBeGreaterThan(30)
  })

  it('agrees with the engine for every status and outcome reason', () => {
    let accepted = 0
    for (const base of [PASSED, FAILED, TIMEOUT]) {
      for (const status of [...engine.CAPTURED_STATUSES, 'Verified Fix', 'Unverified']) {
        for (const reason of [null, ...Object.keys(engine.CAPTURED_OUTCOME_REASONS)]) {
          if (agreed(`${String(base.status)} as ${status} ${String(reason)}`, variant(base, (r) => setOutcome(r, status, reason)))) accepted += 1
        }
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(3)
  })

  it('agrees with the engine on the evidence each check may cite', () => {
    const ids = ['ev_failure_dataset_001', 'ev_failure_screenshot_002', 'ev_failure_source_001', 'ev_replay_dataset_001', 'ev_replay_chart_001', 'ev_replay_screenshot_001', 'ev_other_dataset_001']
    let accepted = 0
    for (const [index, checkId] of engine.CAPTURED_CHECK_IDS.entries()) {
      for (const id of ids) {
        if (agreed(`${checkId} cites ${id}`, variant(PASSED, (r) => void (r.checks[index].evidence_ids = [id])))) accepted += 1
      }
    }
    expect(accepted).toBe(5)
  })

  it('returns a frozen copy that later input changes cannot reach', () => {
    const input = structuredClone(PASSED) as Draft
    const parsed = parseCapturedVerificationResult(input)
    expect(parsed).toEqual(PASSED)
    expect(isDeepFrozen(parsed)).toBe(true)
    input.status = 'failed'
    input.checks[0].message = SEEDED
    expect(parsed?.status).toBe('passed')
    expect(JSON.stringify(parsed)).not.toContain(SEEDED)
  })

  it('accepts the PR #19 reducer missing-evidence corrections for every terminal outcome', () => {
    for (const termination of ['completed', 'error', 'timeout', 'interrupted'] as const) {
      for (const [before, after] of [[null, REPLAY_REFERENCE], [FAILURE_REFERENCE, null], [null, null]] as const) {
        const reduction = engine.reduceCapturedVerification({
          termination,
          checks: PASSED.checks,
          before_evidence: before,
          after_evidence: after,
          cleanup: PASSED.cleanup,
        })
        const result = { ...PASSED, ...reduction, before_evidence: before, after_evidence: after }
        expectParity(`${termination}, before=${before !== null}, after=${after !== null}`, result, true)
        expect(parseCapturedVerificationResult(result)?.status).not.toBe('passed')
      }
    }
  })

  it('keeps metric values strict without exposing rejected metric keys through result reads', async () => {
    const valid = variant(PASSED, (r) => void (r.checks[2].metrics = { files: 3, complete: true, optional: null }))
    expectParity('numeric, boolean and null metrics', valid, true)
    for (const key of [SEEDED, 'private_metric_key']) {
      const invalid = variant(PASSED, (r) => void (r.checks[2].metrics = { [key]: SEEDED }))
      expectParity('rejected metric with private key', invalid, false)
      const { client } = fakeFetch(json(200, invalid))
      const error = await failure(client.readResult(RUN_ID))
      expect(error.code).toBe('RESULT_INVALID')
      expect(JSON.stringify(error)).not.toContain(key)
    }
  })
})

describe('Captured client contract: explicit family dispatch', () => {
  it('dispatches by the kind discriminator and never falls back to the other family', () => {
    const captured = parseStudioRunResult(PASSED)
    expect(captured).toEqual(PASSED)
    expect(captured !== null && isCapturedVerificationResult(captured)).toBe(true)
    const legacy = parseStudioRunResult(VERIFIED)
    expect(legacy).toEqual(VERIFIED)
    expect(legacy !== null && isCapturedVerificationResult(legacy)).toBe(false)

    expect(parseStudioRunResult({ ...VERIFIED, kind: CAPTURED_RESULT_KIND })).toBeNull()
    expect(parseStudioRunResult(variant(PASSED, (r) => void delete r.kind))).toBeNull()
    expect(parseStudioRunResult(variant(PASSED, (r) => void (r.kind = 'Verified Fix')))).toBeNull()
    for (const name of [...CAPTURED_FIXTURES, ...LEGACY_RESULT_FIXTURES]) {
      const valid = name.includes('.valid-')
      expect({ name, accepted: parseStudioRunResult(fixture(name)) !== null }).toEqual({ name, accepted: valid })
    }
  })
})

// ---------------------------------------------------------------------------------------
// Catalog discrimination (T023)
// ---------------------------------------------------------------------------------------

const LEGACY_SCENARIOS: readonly ScenarioSummary[] = [
  { scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL },
  { scenario_id: FAILURE, case: 'failure-invalid-citation', title: 'Reject an invalid citation', default_request: GOAL },
]
const CAPTURED_ENTRY = { scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL, execution_kind: 'captured-verification' } as const

describe('Captured client contract: opt-in catalog discrimination', () => {
  it('parses the captured execution-kind discriminator of the host-fixed mode', async () => {
    const { paths, client } = fakeFetch(json(200, { scenarios: [CAPTURED_ENTRY] }))
    const scenarios = await client.listScenarios()
    expect(scenarios).toEqual([CAPTURED_ENTRY])
    expect(scenarios.every(isCapturedScenario)).toBe(true)
    expect(isDeepFrozen(scenarios)).toBe(true)
    expect(paths).toEqual(['/api/scenarios'])
  })

  it('keeps legacy entries in their exact four-field shape', async () => {
    const { client } = fakeFetch(json(200, { scenarios: LEGACY_SCENARIOS }))
    const scenarios = await client.listScenarios()
    expect(scenarios).toEqual(LEGACY_SCENARIOS)
    for (const entry of scenarios) {
      expect(Object.keys(entry).sort()).toEqual(['case', 'default_request', 'scenario_id', 'title'])
      expect(isCapturedScenario(entry)).toBe(false)
    }
  })

  it.each<[string, unknown]>([
    ['a legacy execution kind', { scenarios: [{ ...CAPTURED_ENTRY, execution_kind: 'legacy' }] }],
    ['a null execution kind', { scenarios: [{ ...CAPTURED_ENTRY, execution_kind: null }] }],
    ['a differently cased execution kind', { scenarios: [{ ...CAPTURED_ENTRY, execution_kind: 'Captured-Verification' }] }],
    ['a mixed catalog', { scenarios: [CAPTURED_ENTRY, LEGACY_SCENARIOS[1]] }],
    ['a second captured case', { scenarios: [CAPTURED_ENTRY, { ...CAPTURED_ENTRY, scenario_id: FAILURE, case: 'failure-invalid-citation' }] }],
    ['a captured entry with an extra key', { scenarios: [{ ...CAPTURED_ENTRY, patch: SEEDED }] }],
    ['a captured entry without its goal', { scenarios: [{ scenario_id: HERO, case: 'hero', title: 'Verify', execution_kind: 'captured-verification' }] }],
    ['a legacy entry with an extra key', { scenarios: [{ ...LEGACY_SCENARIOS[0], mode: 'captured' }] }],
    ['a top-level mode field', { scenarios: [CAPTURED_ENTRY], execution_kind: 'captured-verification' }],
  ])('rejects %s', async (_label, body) => {
    const { client } = fakeFetch(json(200, body))
    expect((await failure(client.listScenarios())).code).toBe('RESPONSE_INVALID')
  })
})

// ---------------------------------------------------------------------------------------
// Browser safety
// ---------------------------------------------------------------------------------------

const STUDIO_SRC = fileURLToPath(new URL('../../apps/studio/src/', import.meta.url))
const BARE_RUNTIME_IMPORTS = new Set(['react', 'react-dom/client'])

function studioSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return studioSources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** Specifiers of imports and re-exports that survive type erasure. */
function runtimeSpecifiers(source: string): string[] {
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '')
}

describe('Captured client contract: browser safety', () => {
  it('reaches no engine, Zod, or Node module at runtime; engine contracts are imported for types only', () => {
    const files = studioSources(STUDIO_SRC)
    expect(files.map((file) => path.relative(STUDIO_SRC, file))).toEqual(expect.arrayContaining(['api.ts', 'state.ts']))
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of runtimeSpecifiers(source)) {
        const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null
        const local = resolved !== null && resolved.startsWith(STUDIO_SRC)
        expect({ file: path.relative(STUDIO_SRC, file), specifier, allowed: local || BARE_RUNTIME_IMPORTS.has(specifier) }).toEqual({
          file: path.relative(STUDIO_SRC, file),
          specifier,
          allowed: true,
        })
      }
    }
    const api = readFileSync(path.join(STUDIO_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/import type \{[^}]*CapturedVerificationResult[^}]*\} from '\.\.\/\.\.\/\.\.\/packages\/flowproof\/src\/verify\/capturedContracts\.js'/)
  })
})

// ---------------------------------------------------------------------------------------
// Result reads and polling (T023)
// ---------------------------------------------------------------------------------------

describe('Captured client: result reads bound to the started run', () => {
  it('reads running, then the strict captured result as a frozen finalized read', async () => {
    const { paths, client } = fakeFetch(json(202, { state: 'running' }), json(200, PASSED))
    expect(await client.readResult(RUN_ID)).toEqual({ state: 'running' })
    const read = await client.readResult(RUN_ID)
    expect(read).toEqual({ state: 'finalized', result: PASSED })
    if (read.state !== 'finalized') throw new Error('The run did not finalize.')
    expect(isCapturedVerificationResult(read.result)).toBe(true)
    expect(isDeepFrozen(read)).toBe(true)
    expect(paths).toEqual([`/api/runs/${RUN_ID}/result`, `/api/runs/${RUN_ID}/result`])
  })

  it.each<[string, unknown, string]>([
    ['a captured result of another run', variant(PASSED, (r) => void (r.run_id = OTHER_ID)), 'RESULT_RUN_MISMATCH'],
    ['a captured result with patch bytes', variant(PASSED, (r) => void (r.patch = `diff --git ${SEEDED}`)), 'RESULT_INVALID'],
    ['a captured result labelled Verified Fix', variant(PASSED, (r) => void (r.status = 'Verified Fix')), 'RESULT_INVALID'],
    ['a legacy body claiming the captured kind', { ...VERIFIED, run_id: RUN_ID, kind: CAPTURED_RESULT_KIND }, 'RESULT_INVALID'],
  ])('fails closed on %s', async (_label, body, code) => {
    const { client } = fakeFetch(json(200, body))
    expect((await failure(client.readResult(RUN_ID))).code).toBe(code)
  })

  it('polls until the captured run finalizes', async () => {
    const { paths, client } = fakeFetch(json(202, { state: 'running' }), json(202, { state: 'running' }), json(200, FAILED))
    const result = await client.pollResult(RUN_ID, { intervalMs: 0 })
    expect(result).toEqual(FAILED)
    expect(isCapturedVerificationResult(result)).toBe(true)
    expect(paths).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------------------
// Captured run state (T024)
// ---------------------------------------------------------------------------------------

const CAPTURED_SCENARIOS: readonly ScenarioSummary[] = [CAPTURED_ENTRY]
const FAILURE_IDS = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'].map((type) => `ev_failure_${type}_001`)
const REPLAY_IDS = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network'].map((type) => `ev_replay_${type}_001`)

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Applies actions to frozen states, so any in-place mutation by the reducer throws. */
const reduce = (actions: readonly StudioAction[], from: StudioState = initialStudioState): StudioState =>
  actions.reduce((state, action) => studioReducer(deepFreeze(state), action), from)

interface EventInput {
  readonly type: StudioEventType
  readonly phase: RunState | null
  readonly message?: string
  readonly evidence_ids?: readonly string[]
  readonly gate?: GateSummary | null
  readonly artifact_refs?: readonly string[]
}

/** A Studio Event that both the client and the engine contract accept. */
function studioEvent(sequence: number, input: EventInput, runId = RUN_ID): StudioEvent {
  const raw = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    event_id: `${runId}:${sequence}`,
    run_id: runId,
    sequence,
    occurred_at: '2026-11-03T10:00:00.000Z',
    type: input.type,
    phase: input.phase,
    message: input.message ?? `Event ${sequence}.`,
    evidence_ids: [...(input.evidence_ids ?? [])],
    gate: input.gate ?? null,
    artifact_refs: [...(input.artifact_refs ?? [])],
  }
  expect(contracts.parseStudioEvent(raw).ok).toBe(true)
  const event = parseStudioEvent(raw)
  if (event === null) throw new Error('The test event violates the Studio Event contract.')
  return event
}

/**
 * The live activity of a passing captured run in the order `executeCapturedRun` emits it. A measured
 * phase starts only once its port attested that the actual frame shows that phase's build and is
 * ready; building, serving and reconnecting are reported as not-live activity of the prior phase.
 */
const CAPTURED_FLOW: readonly EventInput[] = [
  { type: 'agent_message', phase: 'initialized', message: 'Admitted the captured candidate; verification starts at its recorded baseline.' },
  { type: 'agent_message', phase: 'initialized', message: 'Building the recorded baseline and loading it into the Studio frame (not live yet).' },
  { type: 'phase_started', phase: 'reproducing', message: 'The recorded baseline is live in the Studio frame; reproducing the prepared defect.' },
  { type: 'evidence_added', phase: 'reproducing', evidence_ids: FAILURE_IDS, artifact_refs: ['evidence/failure/manifest.json'] },
  { type: 'phase_started', phase: 'failure_captured', message: 'Captured the baseline failure evidence.' },
  { type: 'phase_started', phase: 'applying', message: 'Preparing the candidate: application, build, and functional check (not live).' },
  { type: 'agent_message', phase: 'applying', message: 'Applying the captured candidate once at its recorded baseline.' },
  { type: 'agent_message', phase: 'applying', message: 'Running the registered application build for the applied candidate.' },
  { type: 'agent_message', phase: 'applying', message: 'Running the trusted prepared functional check against the candidate module.' },
  { type: 'agent_message', phase: 'applying', message: 'Loading the candidate build into the same Studio frame (not live yet).' },
  { type: 'phase_started', phase: 'replaying', message: 'The candidate build is live in the same Studio frame; replaying the prepared scenario.' },
  { type: 'evidence_added', phase: 'replaying', evidence_ids: REPLAY_IDS, artifact_refs: ['evidence/replay/manifest.json'] },
  { type: 'agent_message', phase: 'replaying', message: 'Scanning the candidate, the evidence, and the run activity for secrets.' },
  { type: 'agent_message', phase: 'replaying', message: 'Releasing the target, operations, and owned worktree, then comparing the original repository.' },
  { type: 'run_finalized', phase: 'finalized', message: 'Run finalized as passed.', artifact_refs: ['result.json'] },
]

const capturedEvents = (inputs: readonly EventInput[] = CAPTURED_FLOW, runId = RUN_ID): StudioEvent[] =>
  inputs.map((input, index) => studioEvent(index + 1, input, runId))
const eventActions = (events: readonly StudioEvent[], runId = RUN_ID): StudioAction[] => events.map((event) => ({ type: 'stream/event', runId, event }))

/** A captured session with its one prepared case loaded and its accepted run attached to the stream. */
const CAPTURED_RUNNING: readonly StudioAction[] = [
  { type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS },
  { type: 'run/requested', requestText: GOAL },
  { type: 'run/started', start: START },
  { type: 'stream/opened', runId: RUN_ID },
]

function capturedRun(state: StudioState): CapturedRunView {
  if (state.capturedRun === undefined) throw new Error('The state has no captured run.')
  return state.capturedRun
}

const finalized = (result: unknown = PASSED): StudioState =>
  reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents()), { type: 'result/received', runId: RUN_ID, result: result as CapturedVerificationResult }])

describe('Captured Studio state: mode and the one verification run', () => {
  it('derives the mode from the catalog discriminator only', () => {
    expect(selectStudioMode(initialStudioState)).toBe('legacy')
    expect(selectStudioMode(reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }]))).toBe('legacy')
    expect(selectStudioMode(reduce([{ type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS }]))).toBe('captured')
    expect(selectStudioMode(reduce([{ type: 'catalog/failed', error: { code: 'NETWORK_UNAVAILABLE', message: 'x' } }]))).toBe('legacy')
  })

  it('starts the captured run with no Meta chat, no legacy gates and no candidate-diff state', () => {
    const pending = reduce(CAPTURED_RUNNING.slice(0, 2))
    expect(pending.pendingStart).toEqual({ scenarioId: HERO, requestText: GOAL, executionKind: CAPTURED_EXECUTION_KIND })
    expect(canStartRun(pending)).toBe(false)

    const state = reduce(CAPTURED_RUNNING)
    expect(state.pendingStart).toBeNull()
    expect(state.run).toBeNull()
    const run = capturedRun(state)
    expect(Object.keys(run).sort()).toEqual(['activity', 'error', 'evidenceIds', 'mode', 'phase', 'requestId', 'result', 'runId', 'scenarioId', 'status', 'stream'])
    expect(run).toMatchObject({ mode: 'captured', runId: RUN_ID, requestId: REQUEST_ID, scenarioId: HERO, status: 'running', result: null, error: null })
    for (const legacyField of ['gates', 'candidate', 'requestText']) expect(Object.hasOwn(run, legacyField)).toBe(false)
    expect(selectCapturedChecks(run)).toEqual([])
    expect(selectCapturedOutcome(run)).toBeNull()
    expect(selectCapturedTarget(run)).toBe('not-live')
    expect(canStartRun(state)).toBe(false)
  })

  it('leaves a legacy session exactly as before', () => {
    const state = reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }, { type: 'run/requested', requestText: GOAL }])
    expect(state.pendingStart).toEqual({ scenarioId: HERO, requestText: GOAL })
    expect(Object.hasOwn(state.pendingStart ?? {}, 'executionKind')).toBe(false)
    const started = reduce([{ type: 'run/started', start: START }], state)
    expect(Object.hasOwn(started, 'capturedRun')).toBe(false)
    expect(started.run?.runId).toBe(RUN_ID)
    expect(selectCapturedTarget(started.capturedRun)).toBeNull()
  })

  it('allows exactly one verification run per captured launch, even after it finalized', () => {
    const done = finalized()
    expect(capturedRun(done).status).toBe('finalized')
    expect(canStartRun(done)).toBe(false)
    const again = reduce([{ type: 'run/requested', requestText: GOAL }], done)
    expect(again.pendingStart).toBeNull()
    expect(again.error?.code).toBe('RUN_LIMIT_REACHED')
    expect(again.capturedRun).toBe(done.capturedRun)
    expect(reduce([{ type: 'run/started', start: { ...START, run_id: OTHER_ID } }], again)).toBe(again)
  })
})

describe('Captured Studio state: target presentation from actual events', () => {
  it('labels the frame live from a readiness-announced measured phase through its own evidence, never during preparation', () => {
    const events = capturedEvents()
    const presentations = [selectCapturedTarget(capturedRun(reduce(CAPTURED_RUNNING)))]
    let state = reduce(CAPTURED_RUNNING)
    for (const action of eventActions(events)) {
      state = reduce([action], state)
      presentations.push(selectCapturedTarget(capturedRun(state)))
    }
    expect(presentations).toEqual([
      'not-live', // connected, nothing observed yet
      'not-live', // admitted
      'not-live', // building and loading the baseline: the frame may still show the launch preview
      'baseline-live', // reproduction announced on the actual frame's readiness
      'baseline-live', // baseline evidence came from that frame
      'not-live', // failure captured
      'not-live', // preparation started
      'not-live', // applying
      'not-live', // building
      'not-live', // checking
      'not-live', // loading the candidate: the frame may still show the baseline
      'candidate-live', // replay announced on the actual frame's readiness
      'candidate-live', // replay evidence came from that frame
      'not-live', // scanning
      'not-live', // releasing the target
      'not-live', // finalized, before the authoritative result
    ])
    const run = capturedRun(state)
    expect(run.activity).toEqual(events)
    expect(run.evidenceIds).toEqual([...FAILURE_IDS, ...REPLAY_IDS])
    expect(run.phase).toBe('finalized')
    expect(run.stream.status).toBe('ended')
    expect(selectCapturedChecks(run)).toEqual([])
    expect(selectCapturedOutcome(run)).toBeNull()

    expect(selectCapturedTarget(capturedRun(reduce([{ type: 'result/received', runId: RUN_ID, result: PASSED }], state)))).toBe('completed-evidence')
  })

  it('does not treat evidence of another phase as readiness', () => {
    const flow = (inputs: readonly EventInput[]): string | null =>
      selectCapturedTarget(capturedRun(reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents(inputs))])))
    const [admitted, reproducing] = CAPTURED_FLOW as [EventInput, EventInput]
    expect(flow([admitted, reproducing, { type: 'evidence_added', phase: 'reproducing', evidence_ids: REPLAY_IDS }])).toBe('not-live')
    expect(flow([admitted, reproducing, { type: 'evidence_added', phase: 'reproducing', evidence_ids: [...FAILURE_IDS, 'ev_replay_dataset_001'] }])).toBe('not-live')
    expect(flow([admitted, { type: 'phase_started', phase: 'applying' }, { type: 'evidence_added', phase: 'applying', evidence_ids: REPLAY_IDS }])).toBe('not-live')
    expect(flow([admitted, { type: 'phase_started', phase: 'replaying' }, { type: 'evidence_added', phase: 'replaying', evidence_ids: FAILURE_IDS }])).toBe('not-live')
  })

  it('never treats preparation, unannounced evidence, or activity after the measurement as live', () => {
    const flow = (inputs: readonly EventInput[]): string | null =>
      selectCapturedTarget(capturedRun(reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents(inputs))])))
    const [admitted, loadBaseline, reproducing, baselineEvidence] = CAPTURED_FLOW as [EventInput, EventInput, EventInput, EventInput]
    // A port that never attested readiness: its evidence carries the prior phase and is not live.
    expect(flow([admitted, loadBaseline, { type: 'evidence_added', phase: 'initialized', evidence_ids: FAILURE_IDS }])).toBe('not-live')
    // Same-phase evidence without the phase start in the delivered activity proves no readiness.
    expect(flow([baselineEvidence])).toBe('not-live')
    // Any other activity after the announcement means the run moved on, even within the phase.
    expect(flow([admitted, loadBaseline, reproducing, { type: 'agent_message', phase: 'reproducing' }])).toBe('not-live')
    expect(flow([admitted, loadBaseline, reproducing, { type: 'agent_message', phase: 'reproducing' }, baselineEvidence])).toBe('not-live')
    // The candidate replay is live only from its own announcement, never from the baseline's.
    const toReplay = CAPTURED_FLOW.slice(0, 10)
    expect(flow(toReplay)).toBe('not-live')
    expect(flow([...toReplay, { type: 'evidence_added', phase: 'applying', evidence_ids: REPLAY_IDS }])).toBe('not-live')
  })

  it('stops vouching for the frame when no valid result can be read, even with the stream still open', () => {
    const baselineLive = reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents().slice(0, 3))])
    expect(selectCapturedTarget(capturedRun(baselineLive))).toBe('baseline-live')
    const unreadable = reduce([{ type: 'result/failed', runId: RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], baselineLive)
    expect(capturedRun(unreadable)).toMatchObject({ status: 'failed', stream: { status: 'open' } })
    expect(selectCapturedTarget(capturedRun(unreadable))).toBe('not-live')
  })

  it('stops vouching for the frame once live activity disconnects or is rejected', () => {
    const baselineLive = reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents().slice(0, 3))])
    expect(selectCapturedTarget(capturedRun(baselineLive))).toBe('baseline-live')
    const disconnected = reduce([{ type: 'stream/disconnected', runId: RUN_ID }], baselineLive)
    expect(capturedRun(disconnected).stream).toMatchObject({ status: 'disconnected', error: { code: 'STREAM_DISCONNECTED' } })
    expect(selectCapturedTarget(capturedRun(disconnected))).toBe('not-live')

    const candidateLive = reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents().slice(0, 12))])
    expect(selectCapturedTarget(capturedRun(candidateLive))).toBe('candidate-live')
    const rejected = reduce([{ type: 'stream/failed', runId: RUN_ID, error: { code: 'EVENT_INVALID', message: 'x' } }], candidateLive)
    expect(selectCapturedTarget(capturedRun(rejected))).toBe('not-live')
  })

  it.each<[string, EventInput]>([
    ['a legacy gate update', { type: 'gate_updated', phase: 'replaying', gate: { gate_id: 'dataset_matches', status: 'pass', reason_code: 'DATASET_EXACT_MATCH' } }],
    ['a diagnosis', { type: 'diagnosis_ready', phase: 'diagnosing' }],
    ['a model candidate', { type: 'candidate_ready', phase: 'applying' }],
    ['a Meta chat message', { type: 'chat_received', phase: 'initialized' }],
    ['a diagnosing phase', { type: 'phase_started', phase: 'diagnosing' }],
    ['a candidate validation phase', { type: 'phase_started', phase: 'candidate_validated' }],
  ])('stops live activity on %s, which the captured flow never emits', (_label, input) => {
    const before = reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents().slice(0, 3))])
    expect(selectCapturedTarget(capturedRun(before))).toBe('baseline-live')
    const after = reduce(eventActions([studioEvent(4, input)]), before)
    const run = capturedRun(after)
    expect(run.stream).toMatchObject({ status: 'rejected', error: { code: 'EVENT_INVALID' } })
    expect(run.activity).toHaveLength(3)
    expect(run.phase).toBe('reproducing')
    expect(selectCapturedTarget(run)).toBe('not-live')
  })
})

describe('Captured Studio state: the strict final result', () => {
  it('takes the ten check rows and the Candidate verification passed label only from the bound strict result', () => {
    const state = finalized()
    const run = capturedRun(state)
    expect(run.status).toBe('finalized')
    const checks = selectCapturedChecks(run)
    expect(checks).toEqual(PASSED.checks)
    expect(checks.map((check) => check.check_id)).toEqual([...CAPTURED_CHECK_IDS])
    expect(selectCapturedOutcome(run)).toEqual({ status: 'passed', label: 'Candidate verification passed', reasonCode: null, message: null })
    expect(selectCapturedTarget(run)).toBe('completed-evidence')
    expect(state.run).toBeNull()
    const visible = JSON.stringify({ state, checks, outcome: selectCapturedOutcome(run) })
    expect(visible).not.toContain('Verified Fix')
  })

  it.each<[string, unknown]>([
    ['failed', FAILED],
    ['interrupted', TIMEOUT],
    [
      'error',
      variant(FAILED, (r) => {
        setCheck(r, 'build_passed', 'STAGE_ERROR')
        setOutcome(r, 'error', 'VERIFICATION_ERROR')
      }),
    ],
  ])('labels a %s outcome honestly, never as passed or Verified Fix', (status, result) => {
    const parsed = parseCapturedVerificationResult(result)
    if (parsed === null) throw new Error('The test result violates the captured contract.')
    const run = capturedRun(finalized(parsed))
    const outcome = selectCapturedOutcome(run)
    expect(outcome).toEqual({ status, label: CAPTURED_STATUS_LABELS[parsed.status], reasonCode: parsed.reason_code, message: parsed.message })
    expect(outcome?.label).not.toBe('Candidate verification passed')
    expect(selectCapturedChecks(run)).toEqual(parsed.checks)
    expect(JSON.stringify({ run, outcome })).not.toContain('Verified Fix')
  })

  it('shows the short executed identity and the coverage note only from the bound strict result', () => {
    expect(selectCapturedIdentity(undefined)).toBeNull()
    expect(selectCapturedIdentity(capturedRun(reduce(CAPTURED_RUNNING)))).toBeNull()
    expect(selectCapturedIdentity(capturedRun(finalized()))).toEqual({
      candidateDigest: PASSED.candidate_patch_sha256,
      candidateDigestShort: PASSED.candidate_patch_sha256.slice(0, 12),
      baselineCommit: PASSED.baseline_commit,
      baselineCommitShort: PASSED.baseline_commit.slice(0, 12),
      coverageNote: null,
    })
    // The inherited submodule coverage note is shown exactly when the strict result carries it.
    const noted = parseCapturedVerificationResult(variant(PASSED, (r) => void (r.coverage.note = CAPTURED_COVERAGE_NOTE)))
    if (noted === null) throw new Error('The noted result violates the captured contract.')
    expect(selectCapturedIdentity(capturedRun(finalized(noted)))?.coverageNote).toBe(CAPTURED_COVERAGE_NOTE)
    // A SHA-256 baseline is shortened the same way, never abbreviated in the result itself.
    const sha256 = parseCapturedVerificationResult(fixture('captured-verification-result.valid-sha256-baseline.json'))
    if (sha256 === null) throw new Error('The SHA-256 fixture violates the captured contract.')
    const bound = { ...sha256, run_id: RUN_ID, request_id: REQUEST_ID, scenario_id: HERO }
    expect(selectCapturedIdentity(capturedRun(finalized(bound)))).toMatchObject({ baselineCommit: sha256.baseline_commit, baselineCommitShort: sha256.baseline_commit.slice(0, 12) })
    expect(sha256.baseline_commit).toHaveLength(64)
    // A refused result shows no identity.
    expect(selectCapturedIdentity(capturedRun(finalized(variant(PASSED, (r) => void (r.run_id = OTHER_ID)))))).toBeNull()
  })

  it('labels only the passed status as Candidate verification passed', () => {
    expect(Object.entries(CAPTURED_STATUS_LABELS).filter(([, label]) => label === 'Candidate verification passed')).toEqual([['passed', 'Candidate verification passed']])
    expect(Object.values(CAPTURED_STATUS_LABELS)).not.toContain('Verified Fix')
    expect(Object.keys(CAPTURED_STATUS_LABELS)).toEqual([...CAPTURED_STATUSES])
  })

  it.each<[string, unknown, string]>([
    ['another request', variant(PASSED, (r) => void (r.request_id = OTHER_ID)), 'RESULT_RUN_MISMATCH'],
    ['another scenario', variant(PASSED, (r) => void (r.scenario_id = 'canvas-filter-other')), 'RESULT_RUN_MISMATCH'],
    ['another run', variant(PASSED, (r) => void (r.run_id = OTHER_ID)), 'RESULT_RUN_MISMATCH'],
    ['the legacy family', { ...VERIFIED, run_id: RUN_ID, request_id: REQUEST_ID }, 'RESULT_FAMILY_MISMATCH'],
  ])('binds the result to the started run, request, scenario and family: refuses %s', (_label, result, code) => {
    const state = finalized(result)
    const run = capturedRun(state)
    expect(run).toMatchObject({ status: 'failed', result: null, error: { code } })
    expect(selectCapturedChecks(run)).toEqual([])
    expect(selectCapturedOutcome(run)).toBeNull()
    expect(selectCapturedTarget(run)).toBe('not-live')
    // A result read for another run never reaches this one.
    expect(reduce([{ type: 'result/received', runId: OTHER_ID, result: PASSED }], state)).toBe(state)
  })

  it('keeps the first bound result; later results and events never revise it', () => {
    const state = finalized()
    expect(reduce([{ type: 'result/received', runId: RUN_ID, result: FAILED }], state)).toBe(state)
    expect(reduce([{ type: 'result/failed', runId: RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], state)).toBe(state)
  })

  it('makes a legacy run refuse a captured result by family', () => {
    const legacy = reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }, { type: 'run/requested', requestText: GOAL }, { type: 'run/started', start: START }])
    const state = reduce([{ type: 'result/received', runId: RUN_ID, result: PASSED }], legacy)
    expect(state.run).toMatchObject({ status: 'failed', result: null, error: { code: 'RESULT_FAMILY_MISMATCH' } })
    expect(selectGateRows(state.run).every((row) => row.outcome === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// Completed captured evidence (T034)
// ---------------------------------------------------------------------------------------

const FAILURE_MANIFEST = 'evidence/failure/manifest.json'
const REPLAY_MANIFEST = 'evidence/replay/manifest.json'
const SHOWN_BEFORE = { side: 'before', phase: 'failure', state: 'shown', evidenceId: 'ev_failure_screenshot_001' } as const
const SHOWN_AFTER = { side: 'after', phase: 'replay', state: 'shown', evidenceId: 'ev_replay_screenshot_001' } as const
const UNRECEIVED_BEFORE = { side: 'before', phase: 'failure', state: 'not-received', evidenceId: null } as const
const UNRECEIVED_AFTER = { side: 'after', phase: 'replay', state: 'not-received', evidenceId: null } as const

/** A captured run that received exactly these events, then the bound strict result. */
const finalizedWith = (inputs: readonly EventInput[], result: unknown = PASSED): CapturedRunView =>
  capturedRun(reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents(inputs)), { type: 'result/received', runId: RUN_ID, result: result as CapturedVerificationResult }]))

/** A strict failed result whose baseline evidence was never produced, so neither screenshot exists. */
const NO_BASELINE = variant(FAILED, (r) => {
  setCheck(r, 'baseline_reproduced', 'BASELINE_EVIDENCE_INCOMPLETE')
  for (const checkId of ['application_complete', 'build_passed']) setCheck(r, checkId, 'CHECK_NOT_EVALUATED')
  setOutcome(r, 'failed', 'BASELINE_NOT_CONFIRMED')
  r.before_evidence = null
})

/** A strict result whose otherwise passing run left an owned worktree and changed the original. */
const UNCLEAN = variant(PASSED, (r) => {
  setCheck(r, 'cleanup_complete', 'CLEANUP_INCOMPLETE')
  setCheck(r, 'original_unchanged', 'ORIGINAL_CHANGED')
  setOutcome(r, 'failed', 'FINALIZATION_FAILED')
  r.cleanup = { complete: false, remaining_owned_resources: ['worktree'], original_unchanged: false, original_mismatches: [CAPTURED_ORIGINAL_MISMATCHES[0]] }
})

describe('Captured Studio state: completed captured evidence', () => {
  it('shows the before and after screenshots by the Evidence IDs this run announced with the result manifests', () => {
    expect(selectCapturedEvidence(capturedRun(finalized()))).toEqual({ runId: RUN_ID, before: SHOWN_BEFORE, after: SHOWN_AFTER })
    expect(agreed('the result without baseline evidence', NO_BASELINE)).toBe(true)
    expect(agreed('the unclean result', UNCLEAN)).toBe(true)
  })

  it('has no completed evidence before the bound strict result, for a refused result, or in a legacy session', () => {
    expect(selectCapturedEvidence(undefined)).toBeNull()
    const running = reduce([...CAPTURED_RUNNING, ...eventActions(capturedEvents())])
    expect(capturedRun(running).evidenceIds).toEqual([...FAILURE_IDS, ...REPLAY_IDS])
    expect(selectCapturedEvidence(capturedRun(running))).toBeNull()
    for (const refused of [variant(PASSED, (r) => void (r.run_id = OTHER_ID)), variant(PASSED, (r) => void (r.request_id = OTHER_ID)), { ...VERIFIED, run_id: RUN_ID, request_id: REQUEST_ID }]) {
      const run = finalizedWith(CAPTURED_FLOW, refused)
      expect(run.status).toBe('failed')
      expect(selectCapturedEvidence(run)).toBeNull()
    }
    const legacy = reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }, { type: 'run/requested', requestText: GOAL }, { type: 'run/started', start: START }])
    expect(selectCapturedEvidence(legacy.capturedRun)).toBeNull()
  })

  it('states evidence the result does not record as not produced, whatever the activity announced', () => {
    // The full activity announced replay evidence, but the strict result records none.
    expect(selectCapturedEvidence(finalizedWith(CAPTURED_FLOW, FAILED))).toEqual({
      runId: RUN_ID,
      before: SHOWN_BEFORE,
      after: { side: 'after', phase: 'replay', state: 'not-produced', evidenceId: null },
    })
    expect(selectCapturedEvidence(finalizedWith(CAPTURED_FLOW, NO_BASELINE))).toEqual({
      runId: RUN_ID,
      before: { side: 'before', phase: 'failure', state: 'not-produced', evidenceId: null },
      after: { side: 'after', phase: 'replay', state: 'not-produced', evidenceId: null },
    })
  })

  it('never guesses a screenshot Evidence ID the session did not receive with its result manifest', () => {
    const reproducing = CAPTURED_FLOW.slice(0, 3)
    const announce = (evidence: readonly string[], refs: readonly string[], phase: RunState = 'reproducing'): EventInput => ({ type: 'evidence_added', phase, evidence_ids: evidence, artifact_refs: refs })
    // Nothing announced: the stream connected after the evidence or missed it.
    expect(selectCapturedEvidence(finalizedWith([]))).toEqual({ runId: RUN_ID, before: UNRECEIVED_BEFORE, after: UNRECEIVED_AFTER })
    // Announced without the result's manifest, or with the other phase's manifest.
    expect(selectCapturedEvidence(finalizedWith([...reproducing, announce(FAILURE_IDS, [])]))?.before).toEqual(UNRECEIVED_BEFORE)
    expect(selectCapturedEvidence(finalizedWith([...reproducing, announce(FAILURE_IDS, [REPLAY_MANIFEST])]))?.before).toEqual(UNRECEIVED_BEFORE)
    // Two different screenshots for one phase are ambiguous, so neither is shown.
    expect(selectCapturedEvidence(finalizedWith([...reproducing, announce([...FAILURE_IDS, 'ev_failure_screenshot_002'], [FAILURE_MANIFEST])]))?.before).toEqual(UNRECEIVED_BEFORE)
    // A screenshot of the other phase in a matched announcement is not this phase's evidence.
    const mixed = selectCapturedEvidence(finalizedWith([...reproducing, announce([...FAILURE_IDS, 'ev_replay_screenshot_001'], [FAILURE_MANIFEST])]))
    expect(mixed).toEqual({ runId: RUN_ID, before: SHOWN_BEFORE, after: UNRECEIVED_AFTER })
    // Only a screenshot ID counts: other evidence of the phase is never shown as its screenshot.
    const noScreenshot = FAILURE_IDS.filter((id) => !id.includes('_screenshot_'))
    expect(selectCapturedEvidence(finalizedWith([...reproducing, announce(noScreenshot, [FAILURE_MANIFEST])]))?.before).toEqual(UNRECEIVED_BEFORE)
  })

  it('restates the cleanup and original-integrity facts and the evaluated checks only from the strict result', () => {
    expect(selectCapturedCleanup(capturedRun(reduce(CAPTURED_RUNNING)))).toBeNull()
    expect(selectCapturedCheckSummary(capturedRun(reduce(CAPTURED_RUNNING)))).toBeNull()
    expect(selectCapturedCleanup(capturedRun(finalized()))).toEqual({ complete: true, remainingOwnedResources: [], originalUnchanged: true, originalMismatches: [] })
    expect(selectCapturedCheckSummary(capturedRun(finalized()))).toEqual({ pass: 10, fail: 0, unevaluable: 0 })
    expect(selectCapturedCheckSummary(finalizedWith(CAPTURED_FLOW, FAILED))).toEqual({ pass: 6, fail: 1, unevaluable: 3 })
    const unclean = finalizedWith(CAPTURED_FLOW, UNCLEAN)
    expect(selectCapturedCleanup(unclean)).toEqual({ complete: false, remainingOwnedResources: ['worktree'], originalUnchanged: false, originalMismatches: [CAPTURED_ORIGINAL_MISMATCHES[0]] })
    expect(selectCapturedCheckSummary(unclean)).toEqual({ pass: 8, fail: 2, unevaluable: 0 })
    expect(selectCapturedOutcome(unclean)?.label).toBe('Candidate verification failed')
    expect(selectCapturedCleanup(finalizedWith(CAPTURED_FLOW, variant(PASSED, (r) => void (r.run_id = OTHER_ID))))).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------
// Client and state together
// ---------------------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(message: SseMessage) => void>>()

  addEventListener(type: string, listener: (message: SseMessage) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {}

  dispatch(message: SseMessage): void {
    for (const listener of this.listeners.get(message.type) ?? []) listener(message)
  }

  send(event: StudioEvent): void {
    this.dispatch({ type: event.type, data: JSON.stringify(event), lastEventId: event.event_id })
  }
}

describe('Captured Studio state: through the client', () => {
  it('runs a captured session from the catalog to the bound strict result', async () => {
    let state = initialStudioState
    const dispatch = (action: StudioAction): void => {
      state = studioReducer(deepFreeze(state), action)
    }
    const replies = [json(200, { scenarios: [CAPTURED_ENTRY] }), json(202, START), json(202, { state: 'running' }), json(200, PASSED)]
    const sources: FakeEventSource[] = []
    const client = createStudioClient({
      fetch: async () => {
        const reply = replies.shift()
        if (reply === undefined) throw new Error('Unexpected Studio request.')
        return reply
      },
      openEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
    })

    dispatch({ type: 'catalog/loaded', scenarios: await client.listScenarios() })
    expect(selectStudioMode(state)).toBe('captured')
    dispatch({ type: 'run/requested', requestText: GOAL })
    dispatch({ type: 'run/started', start: await client.startRun({ scenarioId: HERO, requestText: GOAL }) })
    client.openRunEvents(RUN_ID, runEventHandlers(RUN_ID, dispatch))
    const [source] = sources
    if (source === undefined) throw new Error('No event source was opened.')
    source.dispatch({ type: 'open' })
    const events = capturedEvents()
    for (const event of events.slice(0, 12)) source.send(event)
    expect(selectCapturedTarget(state.capturedRun)).toBe('candidate-live')
    for (const event of events.slice(12)) source.send(event)
    expect(state.capturedRun?.stream.status).toBe('ended')

    dispatch({ type: 'result/received', runId: RUN_ID, result: await client.pollResult(RUN_ID, { intervalMs: 0 }) })
    const run = capturedRun(state)
    expect(run.status).toBe('finalized')
    expect(selectCapturedOutcome(run)?.label).toBe('Candidate verification passed')
    expect(selectCapturedChecks(run)).toHaveLength(10)
    expect(selectCapturedTarget(run)).toBe('completed-evidence')
    expect(selectCapturedEvidence(run)).toEqual({ runId: RUN_ID, before: SHOWN_BEFORE, after: SHOWN_AFTER })
    expect(state.run).toBeNull()
  })
})
