import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as contracts from '../../packages/flowproof/src/contracts/index.js'
import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_PHASES,
  EVIDENCE_TYPES,
  GATE_IDS,
  META_MODEL_ID,
  StudioClientError,
  createStudioClient,
  evidenceIdParts,
  parseRunResult,
  parseStudioEvent,
} from '../../apps/studio/src/api.js'
import type { GateId, GateOutcome, GateStatus, RunResult, RunState, StudioEvent, StudioEventType } from '../../apps/studio/src/api.js'
import { initialStudioState, selectProofTrail, studioReducer } from '../../apps/studio/src/state.js'
import type { StudioAction, StudioState } from '../../apps/studio/src/state.js'

// T052: the in-workspace Proof Trail. The Studio renders it only from the authoritative run result
// and the Evidence IDs it already holds: every one of the nine gate outcomes, the final status,
// the provider provenance with any injected-fixture label, the failure and replay captures with
// their screenshots, and the candidate diff. A phase the run never reached shows no evidence,
// screenshot, or diff, and nothing is inferred from a filename. Evidence content is read only
// through the closed per-Evidence-ID route; screenshots are images, never JSON reads.

const RUN_ID = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const REQUEST_ID = '69f414d8-aa1e-4b2d-8c60-a5ce21b415cf'
const SEEDED = 'sk-flowproofseededprooftrail01'
const HERO = 'canvas-filter-hero'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'
const START = { request_id: REQUEST_ID, run_id: RUN_ID, events_url: `/api/runs/${RUN_ID}/events` } as const
const FIXTURE_LABEL = 'Injected evaluation fixture: nonexistent Evidence ID'

const FAILURE_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'] as const
const REPLAY_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network'] as const
const FAILURE_IDS = FAILURE_TYPES.map((type) => `ev_failure_${type}_001`)
const REPLAY_IDS = REPLAY_TYPES.map((type) => `ev_replay_${type}_001`)

const FIXTURE_DIR = new URL('../fixtures/contracts/', import.meta.url)
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as Record<string, unknown>

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Applies actions to frozen states, so any in-place mutation by the reducer or selector throws. */
const reduce = (actions: readonly StudioAction[]): StudioState =>
  deepFreeze(actions.reduce((state, action) => studioReducer(deepFreeze(state), action), initialStudioState))

const outcome = (gate_id: GateId, status: GateStatus, reason_code: string, evidence_ids: readonly string[] = [], metrics = {}): GateOutcome => ({
  gate_id,
  status,
  evidence_ids: [...evidence_ids],
  reason_code,
  message: `Gate ${gate_id} reported ${status}.`,
  metrics,
})

/** A run result that both the Studio client and the engine contract accept. */
function result(overrides: Record<string, unknown>): RunResult {
  const raw = { ...fixture('run-result.valid-verified.json'), run_id: RUN_ID, request_id: REQUEST_ID, ...overrides }
  expect(contracts.parseRunResult(raw).ok).toBe(true)
  const parsed = parseRunResult(raw)
  if (parsed === null) throw new Error('The test result violates the run-result contract.')
  return parsed
}

const HERO_GATES: readonly GateOutcome[] = [
  outcome('failure_reproduced', 'pass', 'FAILURE_REPRODUCED', ['ev_failure_dataset_001', 'ev_failure_chart_001'], { dataset_differs: true, canvas_differs: true }),
  outcome('evidence_complete', 'pass', 'EVIDENCE_COMPLETE', FAILURE_IDS),
  outcome('citations_valid', 'pass', 'CITATIONS_VALID', ['ev_failure_dataset_001', 'ev_failure_source_001']),
  outcome('patch_scope_valid', 'pass', 'PATCH_SCOPE_VALID', ['ev_failure_source_001']),
  outcome('patch_applied', 'pass', 'PATCH_APPLIED'),
  outcome('dataset_matches', 'pass', 'DATASET_EXACT_MATCH', ['ev_replay_dataset_001']),
  outcome('canvas_matches', 'pass', 'CHART_EXACT_MATCH', ['ev_replay_chart_001']),
  outcome('secret_scan_clean', 'pass', 'SECRET_SCAN_CLEAN', [], { artifacts: 17, findings: 0 }),
  outcome('original_worktree_unchanged', 'pass', 'ORIGINAL_WORKTREE_UNCHANGED'),
]

const HERO_RESULT = result({
  scenario_id: HERO,
  case: 'hero',
  gates: HERO_GATES,
  failed_gate_ids: [],
  diagnosis_path: 'diagnosis/diagnosis.json',
  candidate_diff_path: 'candidate/candidate.diff',
  phase_durations_ms: { capture: 9_100, model: 1_200, apply: 21_400, replay: 7_300, finalize: 900 },
  total_duration_ms: 39_950,
})

/** The Failure fixture case: rejected before application, so it never replays or keeps a diff. */
const FIXTURE_RESULT = result(fixture('run-result.valid-unverified.json'))

/** A run that ended before failure capture: no screenshot, bundle, diagnosis, or diff. */
const PRE_CAPTURE_RESULT = result({
  status: 'Unverified',
  gates: GATE_IDS.map((gateId) => {
    if (gateId === 'failure_reproduced') return outcome(gateId, 'unevaluable', 'FAILURE_CAPTURE_FAILED')
    if (gateId === 'evidence_complete') return outcome(gateId, 'fail', 'FAILURE_EVIDENCE_INCOMPLETE')
    if (gateId === 'secret_scan_clean') return outcome(gateId, 'pass', 'SECRET_SCAN_CLEAN')
    if (gateId === 'original_worktree_unchanged') return outcome(gateId, 'pass', 'ORIGINAL_WORKTREE_UNCHANGED')
    return outcome(gateId, 'unevaluable', 'GATE_NOT_EVALUATED')
  }),
  failed_gate_ids: GATE_IDS.filter((gateId) => gateId !== 'secret_scan_clean' && gateId !== 'original_worktree_unchanged'),
  diagnosis_path: null,
  candidate_diff_path: null,
  failure_screenshot_path: null,
  replay_screenshot_path: null,
})

interface EventInput {
  readonly type: StudioEventType
  readonly phase: RunState
  readonly evidence_ids?: readonly string[]
}

function studioEvent(sequence: number, input: EventInput): StudioEvent {
  const raw = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    event_id: `${RUN_ID}:${sequence}`,
    run_id: RUN_ID,
    sequence,
    occurred_at: '2026-10-27T10:00:00.000Z',
    type: input.type,
    phase: input.phase,
    message: `Event ${sequence}.`,
    evidence_ids: [...(input.evidence_ids ?? [])],
    gate: null,
    artifact_refs: [],
  }
  expect(contracts.parseStudioEvent(raw).ok).toBe(true)
  const event = parseStudioEvent(raw)
  if (event === null) throw new Error('The test event violates the Studio Event contract.')
  return event
}

const FAILURE_ANNOUNCED = studioEvent(1, { type: 'evidence_added', phase: 'failure_captured', evidence_ids: FAILURE_IDS })
const REPLAY_ANNOUNCED = studioEvent(2, { type: 'evidence_added', phase: 'replaying', evidence_ids: REPLAY_IDS })

const RUNNING: readonly StudioAction[] = [
  { type: 'catalog/loaded', scenarios: [{ scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL }] },
  { type: 'run/requested', requestText: GOAL },
  { type: 'run/started', start: START },
  { type: 'stream/opened', runId: RUN_ID },
]
const announce = (...events: StudioEvent[]): StudioAction[] => events.map((event) => ({ type: 'stream/event', runId: RUN_ID, event }))
const finalize = (value: RunResult): StudioAction => ({ type: 'result/received', runId: RUN_ID, result: value })

const trailOf = (actions: readonly StudioAction[]) => selectProofTrail(reduce(actions).run)

// ---------------------------------------------------------------------------------------
// Closed evidence reads
// ---------------------------------------------------------------------------------------

interface FetchCall {
  readonly path: string
  readonly init: RequestInit
}

function fakeFetch(...replies: Response[]) {
  const calls: FetchCall[] = []
  const fetch = async (path: string, init: RequestInit): Promise<Response> => {
    calls.push({ path, init })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('Unexpected Studio request.')
    return reply
  }
  return { calls, client: createStudioClient({ fetch, openEventSource: () => ({ addEventListener: () => undefined, close: () => undefined }) }) }
}

const json = (status: number, body: unknown, contentType = 'application/json; charset=utf-8'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } })

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

describe('Studio client: Proof Trail evidence reads', () => {
  it('mirrors the contract evidence phases and types in contract order', () => {
    expect(EVIDENCE_PHASES).toEqual(contracts.EVIDENCE_PHASES)
    expect(EVIDENCE_TYPES).toEqual(contracts.EVIDENCE_TYPES)
  })

  it('names the phase and type of a well-formed Evidence ID only', () => {
    expect(evidenceIdParts('ev_failure_screenshot_001')).toEqual({ phase: 'failure', type: 'screenshot' })
    expect(evidenceIdParts('ev_replay_dataset_002')).toEqual({ phase: 'replay', type: 'dataset' })
    for (const id of ['ev_failure_screenshot_1', 'ev_other_dataset_001', '../result.json', `ev_failure_dataset_001?${SEEDED}`, null, 7]) {
      expect(evidenceIdParts(id)).toBeNull()
    }
  })

  it('reads one sanitized JSON evidence artifact through its closed same-origin route as a frozen value', async () => {
    const dataset = { expected: [{ region: 'North', revenue: 10 }], observed: [{ region: 'South', revenue: 12 }] }
    const { calls, client } = fakeFetch(json(200, dataset))
    const value = await client.readEvidence(RUN_ID, 'ev_failure_dataset_001')
    expect(value).toEqual(dataset)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen((value as typeof dataset).observed[0])).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(`/api/runs/${RUN_ID}/evidence/ev_failure_dataset_001`)
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  })

  it('never requests a screenshot, a malformed Evidence ID, or an invalid run as JSON evidence', async () => {
    const { calls, client } = fakeFetch()
    expect((await failure(client.readEvidence(RUN_ID, 'ev_failure_screenshot_001'))).code).toBe('REQUEST_INVALID')
    expect((await failure(client.readEvidence(RUN_ID, '../result.json'))).code).toBe('REQUEST_INVALID')
    expect((await failure(client.readEvidence(RUN_ID, `ev_failure_dataset_001?${SEEDED}`))).code).toBe('REQUEST_INVALID')
    expect((await failure(client.readEvidence('run', 'ev_failure_dataset_001'))).code).toBe('REQUEST_INVALID')
    expect(calls).toEqual([])
  })

  it('rejects non-JSON evidence and maps envelope errors without echoing response values', async () => {
    const { client } = fakeFetch(
      new Response(`<script>${SEEDED}</script>`, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      new Response(`{"token":"${SEEDED}"`, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      json(404, { error: { code: 'EVIDENCE_NOT_FOUND', message: `Missing ${SEEDED}` } }),
    )
    expect((await failure(client.readEvidence(RUN_ID, 'ev_failure_dataset_001'))).code).toBe('RESPONSE_INVALID')
    expect((await failure(client.readEvidence(RUN_ID, 'ev_failure_dataset_001'))).code).toBe('RESPONSE_INVALID')
    expect((await failure(client.readEvidence(RUN_ID, 'ev_replay_chart_001'))).code).toBe('EVIDENCE_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------------------
// Proof Trail selection
// ---------------------------------------------------------------------------------------

describe('Proof Trail selection', () => {
  it('exists only once the authoritative result has finalized the run', () => {
    expect(selectProofTrail(null)).toBeNull()
    expect(trailOf(RUNNING)).toBeNull()
    expect(trailOf([...RUNNING, ...announce(FAILURE_ANNOUNCED, REPLAY_ANNOUNCED)])).toBeNull()
    const unreadable: StudioAction = { type: 'result/failed', runId: RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }
    expect(trailOf([...RUNNING, ...announce(FAILURE_ANNOUNCED), unreadable])).toBeNull()
  })

  it('connects a verified Hero run: final status, live provider, both captures, verified diff, nine gates, and timing', () => {
    const trail = trailOf([...RUNNING, ...announce(FAILURE_ANNOUNCED, REPLAY_ANNOUNCED), finalize(HERO_RESULT)])
    expect(trail).toEqual({
      runId: RUN_ID,
      status: 'Verified Fix',
      failedGateIds: [],
      provenance: { kind: 'meta', model: META_MODEL_ID },
      failure: {
        phase: 'failure',
        evidence: FAILURE_TYPES.map((type) => ({ evidenceId: `ev_failure_${type}_001`, type })),
        screenshotPath: 'evidence/failure/screenshot.png',
        screenshotEvidenceId: 'ev_failure_screenshot_001',
      },
      replay: {
        phase: 'replay',
        evidence: REPLAY_TYPES.map((type) => ({ evidenceId: `ev_replay_${type}_001`, type })),
        screenshotPath: 'evidence/replay/screenshot.png',
        screenshotEvidenceId: 'ev_replay_screenshot_001',
      },
      candidateDiff: true,
      gates: HERO_GATES,
      durations: { capture: 9_100, model: 1_200, apply: 21_400, replay: 7_300, finalize: 900 },
      totalDurationMs: 39_950,
    })
    expect(trail?.gates.map((gate) => gate.gate_id)).toEqual(GATE_IDS)
  })

  it('lists evidence in contract type order regardless of announcement order', () => {
    const shuffled = studioEvent(1, { type: 'evidence_added', phase: 'failure_captured', evidence_ids: [...FAILURE_IDS].reverse() })
    const trail = trailOf([...RUNNING, ...announce(shuffled), finalize(HERO_RESULT)])
    expect(trail?.failure.evidence.map((item) => item.type)).toEqual(FAILURE_TYPES)
  })

  it('keeps the captures reviewable from final gate citations after the live stream disconnects', () => {
    const trail = trailOf([...RUNNING, { type: 'stream/disconnected', runId: RUN_ID }, finalize(HERO_RESULT)])
    expect(trail?.failure.evidence.map((item) => item.evidenceId)).toEqual(FAILURE_IDS)
    expect(trail?.failure.screenshotEvidenceId).toBe('ev_failure_screenshot_001')
    // Only the replay dataset and chart are cited by a gate; the replay screenshot was persisted, but
    // its Evidence ID never reached this session, so it is reported as unreceived, not guessed.
    expect(trail?.replay.evidence).toEqual([
      { evidenceId: 'ev_replay_dataset_001', type: 'dataset' },
      { evidenceId: 'ev_replay_chart_001', type: 'chart' },
    ])
    expect(trail?.replay.screenshotPath).toBe('evidence/replay/screenshot.png')
    expect(trail?.replay.screenshotEvidenceId).toBeNull()
  })

  it('labels an injected fixture provider and reports the unreached replay and absent candidate without inventing them', () => {
    const trail = trailOf([...RUNNING, ...announce(FAILURE_ANNOUNCED), finalize(FIXTURE_RESULT)])
    expect(trail).toMatchObject({
      status: 'Unverified',
      failedGateIds: FIXTURE_RESULT.failed_gate_ids,
      provenance: { kind: 'fixture', label: FIXTURE_LABEL },
      candidateDiff: false,
      replay: { phase: 'replay', evidence: [], screenshotPath: null, screenshotEvidenceId: null },
    })
    expect(trail?.failure.evidence).toHaveLength(7)
    expect(trail?.gates.find((gate) => gate.gate_id === 'citations_valid')).toMatchObject({ status: 'fail', reason_code: 'CITATION_UNKNOWN_EVIDENCE_ID' })
  })

  it('shows no failure evidence, screenshot, or diff for a run that ended before failure capture', () => {
    const trail = trailOf([...RUNNING, finalize(PRE_CAPTURE_RESULT)])
    expect(trail).toMatchObject({
      status: 'Unverified',
      provenance: { kind: 'meta', model: META_MODEL_ID },
      failure: { phase: 'failure', evidence: [], screenshotPath: null, screenshotEvidenceId: null },
      replay: { phase: 'replay', evidence: [], screenshotPath: null, screenshotEvidenceId: null },
      candidateDiff: false,
    })
    expect(trail?.gates.map((gate) => [gate.gate_id, gate.status])).toEqual(PRE_CAPTURE_RESULT.gates.map((gate) => [gate.gate_id, gate.status]))
    expect(trail?.failedGateIds).toEqual(PRE_CAPTURE_RESULT.failed_gate_ids)
  })
})
