import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as contracts from '../../packages/flowproof/src/contracts/index.js'
import {
  CONTRACT_SCHEMA_VERSION,
  GATE_IDS,
  GATE_STATUSES,
  MAX_REQUEST_TEXT_LENGTH,
  META_MODEL_ID,
  RUN_STATES,
  RUN_STATUSES,
  SCENARIO_CASES,
  STUDIO_EVENT_TYPES,
  StudioClientError,
  createStudioClient,
  evidenceUrl,
  parseRunResult,
  parseStudioEvent,
  toStudioError,
} from '../../apps/studio/src/api.js'
import type {
  EventSourceLike,
  GateSummary,
  RunEventHandlers,
  RunResult,
  RunState,
  ScenarioSummary,
  SseMessage,
  StudioError,
  StudioEvent,
  StudioEventType,
} from '../../apps/studio/src/api.js'
import { canStartRun, initialStudioState, runEventHandlers, selectGateRows, studioReducer } from '../../apps/studio/src/state.js'
import type { StudioAction, StudioState } from '../../apps/studio/src/state.js'

// T044: the browser Studio client and its deterministic state. Everything here runs without a
// browser or server: HTTP and SSE are faked at the `fetch` and `EventSource` seams, and the
// client's narrow validators are checked for parity against the engine's Zod contracts and the
// committed contract fixtures.

const RUN_ID = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const REQUEST_ID = '69f414d8-aa1e-4b2d-8c60-a5ce21b415cf'
const OTHER_RUN_ID = 'b0c1d2e3-f405-4617-8829-3a4b5c6d7e8f'
const SEEDED = 'sk-flowproofseededstudioui001'
const HERO = 'canvas-filter-hero'
const FAILURE = 'canvas-filter-failure-invalid-citation'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'

const FIXTURE_DIR = new URL('../fixtures/contracts/', import.meta.url)
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as unknown
const VERIFIED = fixture('run-result.valid-verified.json') as RunResult
const UNVERIFIED = fixture('run-result.valid-unverified.json') as RunResult

const SCENARIOS: readonly ScenarioSummary[] = [
  { scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL },
  { scenario_id: FAILURE, case: 'failure-invalid-citation', title: 'Reject an invalid citation', default_request: GOAL },
]
const START = { request_id: REQUEST_ID, run_id: RUN_ID, events_url: `/api/runs/${RUN_ID}/events` } as const

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
  readonly phase?: RunState | null
  readonly message?: string
  readonly evidence_ids?: readonly string[]
  readonly gate?: GateSummary | null
  readonly artifact_refs?: readonly string[]
  readonly run_id?: string
}

function rawEvent(sequence: number, input: EventInput): Record<string, unknown> {
  const runId = input.run_id ?? RUN_ID
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    event_id: `${runId}:${sequence}`,
    run_id: runId,
    sequence,
    occurred_at: '2026-10-27T10:00:00.000Z',
    type: input.type,
    phase: input.phase ?? null,
    message: input.message ?? `Event ${sequence}.`,
    evidence_ids: [...(input.evidence_ids ?? [])],
    gate: input.gate ?? null,
    artifact_refs: [...(input.artifact_refs ?? [])],
  }
}

/** A Studio Event that both the client and the engine contract accept. */
function studioEvent(sequence: number, input: EventInput): StudioEvent {
  const raw = rawEvent(sequence, input)
  expect(contracts.parseStudioEvent(raw).ok).toBe(true)
  const event = parseStudioEvent(raw)
  if (event === null) throw new Error('The test event violates the Studio Event contract.')
  return event
}

const gate = (gate_id: GateSummary['gate_id'], status: GateSummary['status'], reason_code: string): GateSummary => ({ gate_id, status, reason_code })

/** The live activity of a Hero run in the order `run.ts` emits it. */
function heroEvents(runId = RUN_ID): StudioEvent[] {
  const inputs: EventInput[] = [
    { type: 'chat_received', phase: 'initialized', message: 'Received the start request.' },
    { type: 'phase_started', phase: 'reproducing' },
    { type: 'evidence_added', phase: 'reproducing', evidence_ids: FAILURE_IDS, artifact_refs: ['evidence/failure/manifest.json'] },
    { type: 'gate_updated', phase: 'reproducing', gate: gate('failure_reproduced', 'pass', 'FAILURE_REPRODUCED') },
    { type: 'gate_updated', phase: 'reproducing', gate: gate('evidence_complete', 'pass', 'EVIDENCE_COMPLETE') },
    { type: 'phase_started', phase: 'failure_captured' },
    { type: 'phase_started', phase: 'diagnosing' },
    { type: 'diagnosis_ready', phase: 'diagnosing', artifact_refs: ['diagnosis/diagnosis.json'] },
    { type: 'gate_updated', phase: 'diagnosing', gate: gate('citations_valid', 'pass', 'CITATIONS_VALID') },
    { type: 'gate_updated', phase: 'diagnosing', gate: gate('patch_scope_valid', 'pass', 'PATCH_SCOPE_VALID') },
    { type: 'candidate_ready', phase: 'diagnosing', artifact_refs: ['candidate/candidate.diff'] },
    { type: 'phase_started', phase: 'candidate_validated' },
    { type: 'phase_started', phase: 'applying' },
    { type: 'gate_updated', phase: 'applying', gate: gate('patch_applied', 'pass', 'PATCH_APPLIED') },
    { type: 'phase_started', phase: 'replaying' },
    { type: 'evidence_added', phase: 'replaying', evidence_ids: REPLAY_IDS, artifact_refs: ['evidence/replay/manifest.json'] },
    { type: 'gate_updated', phase: 'replaying', gate: gate('dataset_matches', 'pass', 'DATASET_EXACT_MATCH') },
    { type: 'gate_updated', phase: 'replaying', gate: gate('canvas_matches', 'pass', 'CHART_EXACT_MATCH') },
    { type: 'gate_updated', phase: 'replaying', gate: gate('original_worktree_unchanged', 'pass', 'WORKTREE_UNCHANGED') },
    { type: 'gate_updated', phase: 'replaying', gate: gate('secret_scan_clean', 'unevaluable', 'SECRET_SCAN_PENDING') },
    { type: 'gate_updated', phase: 'replaying', gate: gate('secret_scan_clean', 'pass', 'SECRET_SCAN_CLEAN') },
    { type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Verified Fix.', artifact_refs: ['result.json'] },
  ]
  return inputs.map((input, index) => studioEvent(index + 1, { ...input, run_id: runId }))
}

const eventActions = (events: readonly StudioEvent[], runId = RUN_ID): StudioAction[] =>
  events.map((event) => ({ type: 'stream/event', runId, event }))

/** A session with both cases loaded and one accepted Hero run attached to its stream. */
const RUNNING: readonly StudioAction[] = [
  { type: 'catalog/loaded', scenarios: SCENARIOS },
  { type: 'run/requested', requestText: GOAL },
  { type: 'run/started', start: START },
  { type: 'stream/opened', runId: RUN_ID },
]

function currentRun(state: StudioState) {
  if (state.run === null) throw new Error('The state has no run.')
  return state.run
}

describe('Studio state: prepared cases and session readiness', () => {
  it('starts loading and refuses to start a run before the cases are listed', () => {
    expect(initialStudioState).toEqual({ catalog: { status: 'loading', scenarios: [] }, selectedScenarioId: null, pendingStart: null, run: null, error: null })
    expect(canStartRun(initialStudioState)).toBe(false)
    const state = reduce([{ type: 'run/requested', requestText: GOAL }])
    expect(state.pendingStart).toBeNull()
    expect(state.error?.code).toBe('SESSION_NOT_READY')
  })

  it('selects the first listed case, keeps a valid selection, and ignores unknown cases', () => {
    const loaded = reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }])
    expect(loaded.catalog).toEqual({ status: 'ready', scenarios: SCENARIOS })
    expect(loaded.selectedScenarioId).toBe(HERO)
    expect(canStartRun(loaded)).toBe(true)

    const switched = reduce([{ type: 'scenario/selected', scenarioId: FAILURE }], loaded)
    expect(switched.selectedScenarioId).toBe(FAILURE)
    expect(reduce([{ type: 'scenario/selected', scenarioId: 'not-a-case' }], switched)).toBe(switched)
    expect(reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }], switched).selectedScenarioId).toBe(FAILURE)
  })

  it('reports a failed case listing as a safe session error with nothing to start', () => {
    const state = reduce([{ type: 'catalog/failed', error: toStudioError(new StudioClientError('NETWORK_UNAVAILABLE')) }])
    expect(state.catalog).toEqual({ status: 'failed', scenarios: [] })
    expect(state.error).toEqual({ code: 'NETWORK_UNAVAILABLE', message: 'The Studio API could not be reached.' })
    expect(canStartRun(state)).toBe(false)
  })
})

describe('Studio state: one active run', () => {
  it('holds one pending start, then binds the accepted run to its live stream', () => {
    const pending = reduce(RUNNING.slice(0, 2))
    expect(pending.pendingStart).toEqual({ scenarioId: HERO, requestText: GOAL })
    expect(canStartRun(pending)).toBe(false)
    const again = reduce([{ type: 'run/requested', requestText: GOAL }], pending)
    expect(again.pendingStart).toEqual(pending.pendingStart)
    expect(again.error?.code).toBe('RUN_ALREADY_ACTIVE')
    expect(reduce([{ type: 'scenario/selected', scenarioId: FAILURE }], pending).selectedScenarioId).toBe(HERO)

    const started = reduce(RUNNING.slice(2, 3), again)
    expect(started.pendingStart).toBeNull()
    expect(started.error).toBeNull()
    expect(started.run).toEqual({
      runId: RUN_ID,
      requestId: REQUEST_ID,
      scenarioId: HERO,
      requestText: GOAL,
      stream: { status: 'connecting', lastSequence: null, error: null },
      phase: null,
      activity: [],
      evidenceIds: [],
      gates: {},
      candidate: 'pending',
      status: 'running',
      result: null,
      error: null,
    })
    expect(currentRun(reduce(RUNNING)).stream.status).toBe('open')
  })

  it('refuses a second run and a case switch while one is running', () => {
    const running = reduce(RUNNING)
    expect(canStartRun(running)).toBe(false)
    const refused = reduce([{ type: 'run/requested', requestText: GOAL }], running)
    expect(refused.pendingStart).toBeNull()
    expect(refused.run).toBe(running.run)
    expect(refused.error?.code).toBe('RUN_ALREADY_ACTIVE')
    expect(reduce([{ type: 'scenario/selected', scenarioId: FAILURE }], running)).toBe(running)
  })

  it.each([
    ['empty', ''],
    ['blank', ' \n\t '],
    ['over the server bound', 'x'.repeat(MAX_REQUEST_TEXT_LENGTH + 1)],
  ])('refuses %s request text before anything is sent', (_label, requestText) => {
    const state = reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }, { type: 'run/requested', requestText }])
    expect(state.pendingStart).toBeNull()
    expect(state.error?.code).toBe('REQUEST_TEXT_INVALID')
  })

  it('clears a refused start, keeps the server code, and allows another attempt', () => {
    const error = toStudioError(new StudioClientError('PROVIDER_CREDENTIAL_MISSING', 409))
    const state = reduce([...RUNNING.slice(0, 2), { type: 'run/rejected', error }])
    expect(state.pendingStart).toBeNull()
    expect(state.run).toBeNull()
    expect(state.error).toEqual({ code: 'PROVIDER_CREDENTIAL_MISSING', message: 'The live Meta provider requires MODEL_API_KEY; no run was created.' })
    expect(canStartRun(state)).toBe(true)
  })

  it('ignores start outcomes that no pending request is waiting for', () => {
    const loaded = reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }])
    expect(reduce([{ type: 'run/started', start: START }], loaded)).toBe(loaded)
    expect(reduce([{ type: 'run/rejected', error: toStudioError(null) }], loaded)).toBe(loaded)
  })

  it('allows the next run only after the authoritative result and keeps the finished run until then', () => {
    const finalized = reduce([...RUNNING, { type: 'result/received', runId: RUN_ID, result: VERIFIED }])
    expect(canStartRun(finalized)).toBe(true)
    const next = reduce([{ type: 'scenario/selected', scenarioId: FAILURE }, { type: 'run/requested', requestText: GOAL }], finalized)
    expect(next.pendingStart).toEqual({ scenarioId: FAILURE, requestText: GOAL })
    expect(next.run).toBe(finalized.run)
    const replaced = reduce([{ type: 'run/started', start: { request_id: OTHER_RUN_ID, run_id: OTHER_RUN_ID, events_url: `/api/runs/${OTHER_RUN_ID}/events` } }], next)
    expect(currentRun(replaced)).toMatchObject({ runId: OTHER_RUN_ID, scenarioId: FAILURE, status: 'running', activity: [] })
  })
})

describe('Studio state: ordered live activity', () => {
  it('accumulates the ordered Hero activity, Evidence IDs, gate summaries, and candidate status', () => {
    const events = heroEvents()
    const state = reduce([...RUNNING, ...eventActions(events)])
    const run = currentRun(state)
    expect(run.activity).toEqual(events)
    expect(run.activity.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1))
    expect(run.evidenceIds).toEqual([...FAILURE_IDS, ...REPLAY_IDS])
    expect(run.phase).toBe('finalized')
    expect(run.candidate).toBe('ready')
    expect(run.stream).toEqual({ status: 'ended', lastSequence: events.length, error: null })
    expect(run.gates.secret_scan_clean).toEqual(gate('secret_scan_clean', 'pass', 'SECRET_SCAN_CLEAN'))
    expect(selectGateRows(run).map((row) => [row.gateId, row.status])).toEqual(GATE_IDS.map((gateId) => [gateId, 'pass']))
    expect(selectGateRows(run).every((row) => row.outcome === null)).toBe(true)

    // The final event says "Verified Fix", but only the authoritative result may decide that.
    expect(run.status).toBe('running')
    expect(run.result).toBeNull()
    expect(canStartRun(state)).toBe(false)
  })

  it('tracks provisional progress while the run is still active', () => {
    const events = heroEvents()
    const run = currentRun(reduce([...RUNNING, ...eventActions(events.slice(0, 11))]))
    expect(run.phase).toBe('diagnosing')
    expect(run.evidenceIds).toEqual(FAILURE_IDS)
    expect(run.candidate).toBe('ready')
    expect(run.stream.status).toBe('open')
    expect(selectGateRows(run).map((row) => row.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pending', 'pending', 'pending', 'pending', 'pending'])
    expect(selectGateRows(run)[0]).toEqual({ gateId: 'failure_reproduced', status: 'pass', reasonCode: 'FAILURE_REPRODUCED', outcome: null })
  })

  it('accepts a late connection that starts after earlier unreplayed events, then requires contiguity', () => {
    const events = heroEvents()
    const state = reduce([...RUNNING, ...eventActions(events.slice(4, 7))])
    const run = currentRun(state)
    expect(run.activity.map((event) => event.sequence)).toEqual([5, 6, 7])
    expect(run.stream).toEqual({ status: 'open', lastSequence: 7, error: null })
    const gap = currentRun(reduce(eventActions([events[8] as StudioEvent]), state))
    expect(gap.stream.status).toBe('rejected')
    expect(gap.stream.error?.code).toBe('EVENT_SEQUENCE_GAP')
  })

  it.each([
    ['a duplicate', 2, 'EVENT_SEQUENCE_DUPLICATE'],
    ['a reordered', 1, 'EVENT_SEQUENCE_REORDERED'],
    ['a skipped', 4, 'EVENT_SEQUENCE_GAP'],
  ] as const)('fails the stream closed on %s sequence and ignores every later event', (_label, sequence, code) => {
    const events = heroEvents()
    const before = reduce([...RUNNING, ...eventActions(events.slice(0, 2))])
    const rejected = reduce(eventActions([events[sequence - 1] as StudioEvent]), before)
    const run = currentRun(rejected)
    expect(run.stream).toEqual({ status: 'rejected', lastSequence: 2, error: { code, message: expect.any(String) as string } })
    expect(run.activity).toEqual(currentRun(before).activity)
    const after = reduce(eventActions(events.slice(2)), rejected)
    expect(currentRun(after).activity).toHaveLength(2)
    expect(currentRun(after).evidenceIds).toEqual([])
    expect(currentRun(after).status).toBe('running')
  })

  it('fails the stream closed on an event from another run without touching run state', () => {
    const events = heroEvents()
    const before = reduce([...RUNNING, ...eventActions(events.slice(0, 2))])
    const foreign = heroEvents(OTHER_RUN_ID)[2] as StudioEvent
    const run = currentRun(reduce(eventActions([foreign]), before))
    expect(run.stream.status).toBe('rejected')
    expect(run.stream.error?.code).toBe('EVENT_RUN_MISMATCH')
    expect(run.evidenceIds).toEqual([])
    expect(run.activity).toHaveLength(2)
    // The result stays authoritative and readable after the stream failed.
    const finalized = currentRun(reduce([{ type: 'result/received', runId: RUN_ID, result: VERIFIED }], reduce(eventActions([foreign]), before)))
    expect(finalized.status).toBe('finalized')
  })

  it('ignores actions from a connection or read that belongs to another run', () => {
    const running = reduce(RUNNING)
    const foreign = heroEvents(OTHER_RUN_ID)
    expect(reduce(eventActions(foreign, OTHER_RUN_ID), running)).toBe(running)
    expect(reduce([{ type: 'stream/disconnected', runId: OTHER_RUN_ID }], running)).toBe(running)
    expect(reduce([{ type: 'result/received', runId: OTHER_RUN_ID, result: VERIFIED }], running)).toBe(running)
    expect(reduce(eventActions(heroEvents().slice(0, 1)), reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }]))).toEqual(
      reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }]),
    )
  })

  it('records a disconnect without replay, keeps the activity received, and still accepts the result', () => {
    const events = heroEvents()
    const disconnected = reduce([...RUNNING, ...eventActions(events.slice(0, 3)), { type: 'stream/disconnected', runId: RUN_ID }])
    const run = currentRun(disconnected)
    expect(run.stream.status).toBe('disconnected')
    expect(run.stream.error?.code).toBe('STREAM_DISCONNECTED')
    expect(run.stream.error?.message).toMatch(/not replayed/)
    expect(run.evidenceIds).toEqual(FAILURE_IDS)
    expect(reduce(eventActions(events.slice(3, 4)), disconnected)).toBe(disconnected)
    expect(reduce([{ type: 'stream/failed', runId: RUN_ID, error: toStudioError(null) }], disconnected)).toBe(disconnected)

    const finalized = currentRun(reduce([{ type: 'result/received', runId: RUN_ID, result: VERIFIED }], disconnected))
    expect(finalized.status).toBe('finalized')
    expect(finalized.result?.status).toBe('Verified Fix')
    expect(selectGateRows(finalized).every((row) => row.status === 'pass' && row.outcome !== null)).toBe(true)
  })
})

describe('Studio state: the authoritative result', () => {
  it('finalizes from the result, replacing provisional gates and candidate status', () => {
    const state = reduce([...RUNNING, ...eventActions(heroEvents()), { type: 'result/received', runId: RUN_ID, result: VERIFIED }])
    const run = currentRun(state)
    expect(run.status).toBe('finalized')
    expect(run.result).toBe(VERIFIED)
    expect(run.error).toBeNull()
    expect(run.phase).toBe('finalized')
    expect(run.candidate).toBe('available')
    expect(selectGateRows(run)).toEqual(
      GATE_IDS.map((gateId) => {
        const outcome = VERIFIED.gates.find((entry) => entry.gate_id === gateId)
        return { gateId, status: 'pass', reasonCode: outcome?.reason_code, outcome }
      }),
    )
    expect(canStartRun(state)).toBe(true)
  })

  it('reports Unverified from the result even when every live event claimed success', () => {
    const events = heroEvents()
    const beforeFinal = reduce([...RUNNING, ...eventActions(events.slice(0, -1))])
    const state = reduce([{ type: 'result/received', runId: RUN_ID, result: UNVERIFIED }], beforeFinal)
    const run = currentRun(state)
    expect(run.status).toBe('finalized')
    expect(run.result?.status).toBe('Unverified')
    expect(run.candidate).toBe('absent')
    const rows = selectGateRows(run)
    expect(rows.find((row) => row.gateId === 'citations_valid')).toMatchObject({ status: 'fail', reasonCode: 'CITATION_UNKNOWN_EVIDENCE_ID' })
    expect(rows.filter((row) => row.status !== 'pass').map((row) => row.gateId)).toEqual(UNVERIFIED.failed_gate_ids)

    // Activity still arriving after the result is shown, but cannot revise the final gates.
    const late = currentRun(
      reduce(
        eventActions([
          studioEvent(events.length, { type: 'gate_updated', phase: 'finalized', gate: gate('citations_valid', 'pass', 'CITATIONS_VALID') }),
        ]),
        state,
      ),
    )
    expect(late.activity).toHaveLength(events.length)
    expect(late.gates.citations_valid?.status).toBe('fail')
    expect(late.phase).toBe('finalized')
  })

  it.each([
    ['another run', { ...UNVERIFIED, run_id: OTHER_RUN_ID }],
    ['another request', { ...UNVERIFIED, request_id: OTHER_RUN_ID }],
  ])('fails closed on a result for %s and shows no final status', (_label, result) => {
    const state = reduce([...RUNNING, ...eventActions(heroEvents()), { type: 'result/received', runId: RUN_ID, result }])
    const run = currentRun(state)
    expect(run.status).toBe('failed')
    expect(run.result).toBeNull()
    expect(run.error?.code).toBe('RESULT_RUN_MISMATCH')
    expect(selectGateRows(run).every((row) => row.outcome === null)).toBe(true)
    expect(canStartRun(state)).toBe(true)
  })

  it('shows no status after an invalid result read and accepts only a later valid one', () => {
    const error = toStudioError(new StudioClientError('RESULT_INVALID', 200))
    const failed = reduce([...RUNNING, { type: 'result/failed', runId: RUN_ID, error }])
    expect(currentRun(failed)).toMatchObject({ status: 'failed', result: null, error: { code: 'RESULT_INVALID' } })
    const recovered = currentRun(reduce([{ type: 'result/received', runId: RUN_ID, result: UNVERIFIED }], failed))
    expect(recovered).toMatchObject({ status: 'finalized', error: null })
    expect(recovered.result?.status).toBe('Unverified')
  })

  it('keeps the first authoritative result once finalized', () => {
    const finalized = reduce([...RUNNING, { type: 'result/received', runId: RUN_ID, result: UNVERIFIED }])
    expect(reduce([{ type: 'result/received', runId: RUN_ID, result: VERIFIED }], finalized)).toBe(finalized)
    expect(reduce([{ type: 'result/failed', runId: RUN_ID, error: toStudioError(null) }], finalized)).toBe(finalized)
  })
})

// ---------------------------------------------------------------------------------------
// Client validation parity with the engine contracts
// ---------------------------------------------------------------------------------------

// Test-only mutable view of a JSON fixture.
type Draft = { [key: string]: any }

const variant = (base: unknown, change: (draft: Draft) => void): unknown => {
  const draft = structuredClone(base) as Draft
  change(draft)
  return draft
}

function expectParity(label: string, input: unknown, accepted: boolean): void {
  const isEvent = label.startsWith('event')
  const client = isEvent ? parseStudioEvent(input) : parseRunResult(input)
  const engine = (isEvent ? contracts.parseStudioEvent(input) : contracts.parseRunResult(input)).ok
  expect({ label, client: client !== null, engine }).toEqual({ label, client: accepted, engine: accepted })
}

describe('Studio client: contract parity', () => {
  it('mirrors the engine contract enumerations and bounds', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(contracts.CONTRACT_SCHEMA_VERSION)
    expect(META_MODEL_ID).toBe(contracts.META_MODEL_ID)
    expect(MAX_REQUEST_TEXT_LENGTH).toBe(contracts.MAX_CHAT_TEXT_LENGTH)
    expect(GATE_IDS).toEqual(contracts.GATE_IDS)
    expect(GATE_STATUSES).toEqual(contracts.GATE_STATUSES)
    expect(RUN_STATES).toEqual(contracts.RUN_STATES)
    expect(RUN_STATUSES).toEqual(contracts.RUN_STATUSES)
    expect(SCENARIO_CASES).toEqual(contracts.SCENARIO_CASES)
    expect(STUDIO_EVENT_TYPES).toEqual(contracts.STUDIO_EVENT_TYPES)
  })

  it('agrees with the engine on every committed Studio Event and Run Result fixture', () => {
    const names = readdirSync(FIXTURE_DIR).filter((name) => /^(studio-event|run-result)\./.test(name))
    expect(names.length).toBeGreaterThanOrEqual(12)
    for (const name of names) {
      const valid = name.includes('.valid-')
      expectParity(`${name.startsWith('studio-event') ? 'event' : 'result'} fixture ${name}`, fixture(name), valid)
    }
  })

  const EVENT = fixture('studio-event.valid-evidence-added.json')
  const GATE_EVENT = fixture('studio-event.valid-gate-updated.json')
  it.each<[string, unknown, boolean]>([
    ['event: phase null', variant(EVENT, (e) => void (e.phase = null)), true],
    ['event: 500-character message', variant(EVENT, (e) => void (e.message = 'x'.repeat(500))), true],
    ['event: nanosecond timestamp', variant(EVENT, (e) => void (e.occurred_at = '2026-10-27T10:00:00.123456789Z')), true],
    ['event: extra key', variant(EVENT, (e) => void (e.extra = SEEDED)), false],
    ['event: missing gate key', variant(EVENT, (e) => void delete e.gate), false],
    ['event: schema version', variant(EVENT, (e) => void (e.schema_version = '2.0.0')), false],
    ['event: sequence zero', variant(EVENT, (e) => Object.assign(e, { sequence: 0, event_id: `${RUN_ID}:0` })), false],
    ['event: fractional sequence', variant(EVENT, (e) => Object.assign(e, { sequence: 7.5, event_id: `${RUN_ID}:7.5` })), false],
    ['event: string sequence', variant(EVENT, (e) => void (e.sequence = '7')), false],
    ['event: event id mismatch', variant(EVENT, (e) => void (e.event_id = `${RUN_ID}:8`)), false],
    ['event: run id', variant(EVENT, (e) => Object.assign(e, { run_id: 'run-1', event_id: 'run-1:7' })), false],
    ['event: offset timestamp', variant(EVENT, (e) => void (e.occurred_at = '2026-10-27T10:00:00+09:00')), false],
    ['event: impossible date', variant(EVENT, (e) => void (e.occurred_at = '2026-02-30T10:00:00Z')), false],
    ['event: unknown type', variant(EVENT, (e) => void (e.type = 'shell_command')), false],
    ['event: unknown phase', variant(EVENT, (e) => void (e.phase = 'deploying')), false],
    ['event: empty message', variant(EVENT, (e) => void (e.message = '')), false],
    ['event: oversized message', variant(EVENT, (e) => void (e.message = 'x'.repeat(501))), false],
    ['event: evidence without IDs', variant(EVENT, (e) => void (e.evidence_ids = [])), false],
    ['event: malformed Evidence ID', variant(EVENT, (e) => void (e.evidence_ids = ['ev_failure_dataset_1'])), false],
    ['event: duplicate Evidence IDs', variant(EVENT, (e) => void (e.evidence_ids = ['ev_failure_dataset_001', 'ev_failure_dataset_001'])), false],
    ['event: absolute artifact', variant(EVENT, (e) => void (e.artifact_refs = ['/etc/passwd'])), false],
    ['event: parent artifact', variant(EVENT, (e) => void (e.artifact_refs = ['evidence/../../secret'])), false],
    ['event: gate on non-gate event', variant(EVENT, (e) => void (e.gate = gate('dataset_matches', 'pass', 'OK'))), false],
    ['event: gate event without gate', variant(GATE_EVENT, (e) => void (e.gate = null)), false],
    ['event: gate extra key', variant(GATE_EVENT, (e) => void (e.gate.message = SEEDED)), false],
    ['event: gate status', variant(GATE_EVENT, (e) => void (e.gate.status = 'skipped')), false],
    ['event: gate id', variant(GATE_EVENT, (e) => void (e.gate.gate_id = 'model_approved')), false],
    ['event: reason code', variant(GATE_EVENT, (e) => void (e.gate.reason_code = 'passed')), false],
    ['event: array', [EVENT], false],
  ])('%s', (label, input, accepted) => expectParity(label, input, accepted))

  it.each<[string, unknown, boolean]>([
    ['result: reordered gates', variant(VERIFIED, (r) => void r.gates.reverse()), true],
    ['result: scalar metrics', variant(VERIFIED, (r) => void (r.gates[0].metrics = { count: 3, ok: true, label: 'x', none: null })), true],
    ['result: unverified with null paths', variant(UNVERIFIED, (r) => void (r.diagnosis_path = null)), true],
    ['result: extra key', variant(VERIFIED, (r) => void (r.extra = SEEDED)), false],
    ['result: missing key', variant(VERIFIED, (r) => void delete r.total_duration_ms), false],
    ['result: schema version', variant(VERIFIED, (r) => void (r.schema_version = '2.0.0')), false],
    ['result: run id', variant(VERIFIED, (r) => void (r.run_id = 'run-1')), false],
    ['result: UUID version', variant(VERIFIED, (r) => void (r.request_id = '3d2642cc-e3d1-0c15-ae44-56fa719cd48e')), false],
    ['result: scenario id', variant(VERIFIED, (r) => void (r.scenario_id = 'Canvas_Filter')), false],
    ['result: case', variant(VERIFIED, (r) => void (r.case = 'custom')), false],
    ['result: offset timestamp', variant(VERIFIED, (r) => void (r.started_at = '2026-10-27T10:00:00+09:00')), false],
    ['result: impossible date', variant(VERIFIED, (r) => void (r.completed_at = '2026-02-30T10:00:00Z')), false],
    ['result: short head', variant(VERIFIED, (r) => void (r.original_head = 'abc123')), false],
    ['result: uppercase digest', variant(VERIFIED, (r) => void (r.original_status_digest = 'A'.repeat(64))), false],
    ['result: extra duration', variant(VERIFIED, (r) => void (r.phase_durations_ms.extra = 1)), false],
    ['result: negative duration', variant(VERIFIED, (r) => void (r.phase_durations_ms.capture = -1)), false],
    ['result: fractional total', variant(VERIFIED, (r) => void (r.total_duration_ms = 1.5)), false],
    ['result: Meta model', variant(VERIFIED, (r) => void (r.provider.model = 'other-model')), false],
    ['result: Meta fault label', variant(VERIFIED, (r) => void (r.provider.injected_fault_label = 'label')), false],
    ['result: fixture model', variant(UNVERIFIED, (r) => void (r.provider.model = META_MODEL_ID)), false],
    ['result: fixture without label', variant(UNVERIFIED, (r) => void (r.provider.injected_fault_label = '')), false],
    ['result: provider mode', variant(VERIFIED, (r) => void (r.provider.mode = 'local')), false],
    ['result: status', variant(VERIFIED, (r) => void (r.status = 'Verified')), false],
    ['result: eight gates', variant(VERIFIED, (r) => void r.gates.pop()), false],
    ['result: duplicate gate', variant(VERIFIED, (r) => void (r.gates[1] = r.gates[0])), false],
    ['result: unknown gate', variant(VERIFIED, (r) => void (r.gates[0].gate_id = 'model_approved')), false],
    ['result: gate extra key', variant(VERIFIED, (r) => void (r.gates[0].raw = SEEDED)), false],
    ['result: gate empty message', variant(VERIFIED, (r) => void (r.gates[0].message = '')), false],
    ['result: gate oversized message', variant(VERIFIED, (r) => void (r.gates[0].message = 'x'.repeat(501))), false],
    ['result: gate Evidence ID', variant(VERIFIED, (r) => void (r.gates[0].evidence_ids = ['ev_failure_dataset_1'])), false],
    ['result: gate duplicate Evidence IDs', variant(VERIFIED, (r) => void (r.gates[0].evidence_ids = ['ev_failure_dataset_001', 'ev_failure_dataset_001'])), false],
    ['result: nested metric', variant(VERIFIED, (r) => void (r.gates[0].metrics = { nested: { value: SEEDED } })), false],
    ['result: array metrics', variant(VERIFIED, (r) => void (r.gates[0].metrics = [])), false],
    ['result: reason code', variant(VERIFIED, (r) => void (r.gates[0].reason_code = 'passed')), false],
    ['result: Verified with an unlisted failing gate', variant(VERIFIED, (r) => void (r.gates[5].status = 'fail')), false],
    [
      'result: Verified with a listed failing gate',
      variant(VERIFIED, (r) => {
        r.gates[5].status = 'fail'
        r.failed_gate_ids = ['dataset_matches']
      }),
      false,
    ],
    ['result: Verified without a candidate diff', variant(VERIFIED, (r) => void (r.candidate_diff_path = null)), false],
    ['result: Unverified with every gate passing', variant(VERIFIED, (r) => void (r.status = 'Unverified')), false],
    ['result: failed IDs missing one', variant(UNVERIFIED, (r) => void r.failed_gate_ids.pop()), false],
    ['result: failed IDs naming a passing gate', variant(UNVERIFIED, (r) => void r.failed_gate_ids.push('failure_reproduced')), false],
    ['result: duplicate failed IDs', variant(UNVERIFIED, (r) => void r.failed_gate_ids.push('citations_valid')), false],
    ['result: absolute path', variant(UNVERIFIED, (r) => void (r.diagnosis_path = '/etc/passwd')), false],
    ['result: parent path', variant(UNVERIFIED, (r) => void (r.failure_screenshot_path = 'evidence/../../x.png')), false],
    ['result: null', null, false],
  ])('%s', (label, input, accepted) => expectParity(label, input, accepted))

  it('returns frozen copies so neither the caller nor the UI can change validated data', () => {
    const input = structuredClone(VERIFIED)
    const parsed = parseRunResult(input)
    expect(parsed).toEqual(VERIFIED)
    expect(parsed).not.toBe(input)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.gates[0])).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
// Same-origin HTTP client
// ---------------------------------------------------------------------------------------

interface FetchCall {
  readonly path: string
  readonly init: RequestInit
}

function fakeFetch(...replies: Array<Response | Error>) {
  const calls: FetchCall[] = []
  const fetch = async (path: string, init: RequestInit): Promise<Response> => {
    calls.push({ path, init })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('Unexpected Studio request.')
    if (reply instanceof Error) throw reply
    return reply
  }
  return { calls, client: createStudioClient({ fetch, openEventSource: () => new FakeEventSource() }) }
}

const json = (status: number, body: unknown, contentType = 'application/json; charset=utf-8'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } })
const envelope = (status: number, code: string, message = `Rejected ${SEEDED}`): Response => json(status, { error: { code, message } })

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

describe('Studio client: same-origin HTTP operations', () => {
  it('lists prepared cases with same-origin, no-store, no-redirect requests and frozen results', async () => {
    const { calls, client } = fakeFetch(json(200, { scenarios: SCENARIOS }))
    const scenarios = await client.listScenarios()
    expect(scenarios).toEqual(SCENARIOS)
    expect(Object.isFrozen(scenarios) && Object.isFrozen(scenarios[0])).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/api/scenarios')
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  })

  it.each<[string, Response]>([
    ['a leaked path field', json(200, { scenarios: [{ ...SCENARIOS[0], scenario_path: `scenarios/${SEEDED}.json` }] })],
    ['an extra envelope key', json(200, { scenarios: SCENARIOS, oracle: SEEDED })],
    ['a duplicate case', json(200, { scenarios: [SCENARIOS[0], SCENARIOS[0]] })],
    ['an unknown case kind', json(200, { scenarios: [{ ...SCENARIOS[0], case: SEEDED }] })],
    ['an oversized default request', json(200, { scenarios: [{ ...SCENARIOS[0], default_request: SEEDED.repeat(30) }] })],
    ['a non-JSON media type', json(200, { scenarios: SCENARIOS }, 'text/html')],
    ['a non-JSON body', new Response(`<html>${SEEDED}</html>`, { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['an unexpected success status', json(201, { scenarios: SCENARIOS })],
    ['an invalid error envelope', json(500, { error: { code: 'lowercase', message: SEEDED } })],
    ['an error envelope with extra keys', json(500, { error: { code: 'INTERNAL_ERROR', message: 'x', detail: SEEDED } })],
  ])('rejects %s as RESPONSE_INVALID without echoing it', async (_label, response) => {
    const { client } = fakeFetch(response)
    expect((await failure(client.listScenarios())).code).toBe('RESPONSE_INVALID')
  })

  it('maps network failures and unknown thrown values to safe codes', async () => {
    const { client } = fakeFetch(new TypeError(`connect ECONNREFUSED ${SEEDED}`))
    const error = await failure(client.listScenarios())
    expect(error).toMatchObject({ code: 'NETWORK_UNAVAILABLE', status: null })
    expect(toStudioError(new Error(SEEDED))).toEqual({ code: 'CLIENT_ERROR', message: 'The Studio client could not complete the operation.' })
    expect(toStudioError(SEEDED).message).not.toContain(SEEDED)
  })

  it('starts a run with only the scenario ID and request text and validates the accepted run', async () => {
    const { calls, client } = fakeFetch(json(202, START))
    expect(await client.startRun({ scenarioId: HERO, requestText: GOAL })).toEqual(START)
    expect(calls[0]?.path).toBe('/api/runs')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ scenario_id: HERO, request_text: GOAL })
  })

  it.each<[string, unknown]>([
    ['a foreign events URL', { ...START, events_url: `https://example.test/${SEEDED}` }],
    ['an events URL for another run', { ...START, events_url: `/api/runs/${OTHER_RUN_ID}/events` }],
    ['an extra field', { ...START, worktree: SEEDED }],
    ['a malformed run ID', { ...START, run_id: SEEDED }],
  ])('rejects an accepted run with %s', async (_label, body) => {
    const { client } = fakeFetch(json(202, body))
    expect((await failure(client.startRun({ scenarioId: HERO, requestText: GOAL }))).code).toBe('RESPONSE_INVALID')
  })

  it('surfaces stable server codes with client-authored messages only', async () => {
    const { client } = fakeFetch(
      envelope(409, 'PROVIDER_CREDENTIAL_MISSING'),
      envelope(409, 'ACTIVE_RUN_EXISTS'),
      envelope(400, 'REQUEST_FIELD_REJECTED'),
    )
    const start = (): Promise<unknown> => client.startRun({ scenarioId: HERO, requestText: GOAL })
    expect(await failure(start())).toMatchObject({ code: 'PROVIDER_CREDENTIAL_MISSING', status: 409, message: expect.stringContaining('MODEL_API_KEY') })
    expect(await failure(start())).toMatchObject({ code: 'ACTIVE_RUN_EXISTS', status: 409 })
    expect(await failure(start())).toMatchObject({ code: 'REQUEST_FIELD_REJECTED', status: 400, message: 'The Studio API rejected the request.' })
  })

  it.each<[string, { scenarioId: string; requestText: string }, string]>([
    ['a path as scenario ID', { scenarioId: '../scenarios/hero.json', requestText: GOAL }, 'REQUEST_INVALID'],
    ['blank request text', { scenarioId: HERO, requestText: '   ' }, 'REQUEST_TEXT_INVALID'],
    ['oversized request text', { scenarioId: HERO, requestText: SEEDED.repeat(20) }, 'REQUEST_TEXT_INVALID'],
  ])('refuses %s before sending anything', async (_label, request, code) => {
    const { calls, client } = fakeFetch()
    expect((await failure(client.startRun(request))).code).toBe(code)
    expect(calls).toHaveLength(0)
  })

  it('reads the authoritative result as running or as a validated final result', async () => {
    const { calls, client } = fakeFetch(json(202, { state: 'running' }), json(200, VERIFIED))
    expect(await client.readResult(RUN_ID)).toEqual({ state: 'running' })
    const read = await client.readResult(RUN_ID)
    expect(read).toEqual({ state: 'finalized', result: VERIFIED })
    expect(calls.map((call) => call.path)).toEqual([`/api/runs/${RUN_ID}/result`, `/api/runs/${RUN_ID}/result`])
  })

  it.each<[string, Response, string]>([
    ['a contract-invalid result', json(200, variant(VERIFIED, (r) => void (r.gates[5].status = 'fail'))), 'RESULT_INVALID'],
    ['a result with an extra secret field', json(200, { ...VERIFIED, token: SEEDED }), 'RESULT_INVALID'],
    ['a non-JSON result', new Response(SEEDED, { status: 200, headers: { 'Content-Type': 'text/plain' } }), 'RESULT_INVALID'],
    ['a result for another run', json(200, { ...UNVERIFIED, run_id: OTHER_RUN_ID }), 'RESULT_RUN_MISMATCH'],
    ['a running body with extra keys', json(202, { state: 'running', detail: SEEDED }), 'RESPONSE_INVALID'],
    ['an unknown run', envelope(404, 'RUN_NOT_FOUND'), 'RUN_NOT_FOUND'],
  ])('fails closed on %s', async (_label, response, code) => {
    const { client } = fakeFetch(response)
    expect((await failure(client.readResult(RUN_ID))).code).toBe(code)
  })

  it('validates run and Evidence identifiers before building any route', async () => {
    const { calls, client } = fakeFetch()
    expect((await failure(client.readResult('../../etc/passwd'))).code).toBe('REQUEST_INVALID')
    expect((await failure(client.readCandidateDiff(`${RUN_ID}/x`))).code).toBe('REQUEST_INVALID')
    expect(() => client.openRunEvents('not-a-run', recorder().handlers)).toThrow(StudioClientError)
    expect(calls).toHaveLength(0)
    expect(evidenceUrl(RUN_ID, 'ev_failure_screenshot_001')).toBe(`/api/runs/${RUN_ID}/evidence/ev_failure_screenshot_001`)
    for (const id of ['ev_failure_screenshot_1', '../result.json', 'ev_other_screenshot_001', `ev_failure_screenshot_001?${SEEDED}`]) {
      expect(() => evidenceUrl(RUN_ID, id)).toThrow(StudioClientError)
    }
    expect(() => evidenceUrl('run', 'ev_failure_screenshot_001')).toThrow(StudioClientError)
  })

  it('polls until the run finalizes and stops when aborted', async () => {
    const { calls, client } = fakeFetch(json(202, { state: 'running' }), json(202, { state: 'running' }), json(200, UNVERIFIED))
    expect(await client.pollResult(RUN_ID, { intervalMs: 0 })).toEqual(UNVERIFIED)
    expect(calls).toHaveLength(3)

    const controller = new AbortController()
    const abortingClient = createStudioClient({
      fetch: async () => {
        controller.abort()
        return json(202, { state: 'running' })
      },
      openEventSource: () => new FakeEventSource(),
    })
    expect((await failure(abortingClient.pollResult(RUN_ID, { intervalMs: 60_000, signal: controller.signal }))).code).toBe('REQUEST_ABORTED')
  })

  it('reads the validated candidate diff, or null when the run has none', async () => {
    const diff = 'diff --git a/apps/demo-chart/src/filterData.ts b/apps/demo-chart/src/filterData.ts\n'
    const { calls, client } = fakeFetch(
      new Response(diff, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
      envelope(404, 'ARTIFACT_NOT_FOUND'),
      new Response(`<script>${SEEDED}</script>`, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      envelope(404, 'RUN_NOT_FOUND'),
    )
    expect(await client.readCandidateDiff(RUN_ID)).toBe(diff)
    expect(calls[0]?.path).toBe(`/api/runs/${RUN_ID}/artifacts/candidate-diff`)
    expect(await client.readCandidateDiff(RUN_ID)).toBeNull()
    expect((await failure(client.readCandidateDiff(RUN_ID))).code).toBe('RESPONSE_INVALID')
    expect((await failure(client.readCandidateDiff(RUN_ID))).code).toBe('RUN_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------------------
// Live event stream
// ---------------------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(message: SseMessage) => void>>()
  closeCalls = 0

  addEventListener(type: string, listener: (message: SseMessage) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closeCalls += 1
  }

  /** Dispatches even after `close()`, so the client's own guard is what stops delivery. */
  dispatch(message: SseMessage): void {
    for (const listener of this.listeners.get(message.type) ?? []) listener(message)
  }

  send(event: StudioEvent): void {
    this.dispatch({ type: event.type, data: JSON.stringify(event), lastEventId: event.event_id })
  }
}

type Delivery = { readonly kind: 'open' } | { readonly kind: 'event'; readonly sequence: number } | { readonly kind: 'error'; readonly error: StudioError } | { readonly kind: 'disconnect' }

function recorder() {
  const log: Delivery[] = []
  const handlers: RunEventHandlers = {
    onOpen: () => log.push({ kind: 'open' }),
    onEvent: (event) => log.push({ kind: 'event', sequence: event.sequence }),
    onError: (error) => log.push({ kind: 'error', error }),
    onDisconnect: () => log.push({ kind: 'disconnect' }),
  }
  return { log, handlers }
}

function openStream(runId = RUN_ID) {
  const sources: Array<{ path: string; source: FakeEventSource }> = []
  const client = createStudioClient({
    fetch: () => Promise.reject(new Error('No HTTP request is expected.')),
    openEventSource: (path) => {
      const source = new FakeEventSource()
      sources.push({ path, source })
      return source
    },
  })
  const { log, handlers } = recorder()
  const subscription = client.openRunEvents(runId, handlers)
  const opened = sources[0]
  if (opened === undefined) throw new Error('No event source was opened.')
  return { ...opened, log, subscription, opens: sources }
}

describe('Studio client: live-only event stream', () => {
  it('delivers contiguous events of the run and closes itself after the final event', () => {
    const { path, source, log } = openStream()
    expect(path).toBe(`/api/runs/${RUN_ID}/events`)
    source.dispatch({ type: 'open' })
    const events = heroEvents()
    for (const event of events) source.send(event)
    source.send(events[0] as StudioEvent)
    source.dispatch({ type: 'error' })
    expect(log).toEqual([{ kind: 'open' }, ...events.map((event) => ({ kind: 'event', sequence: event.sequence }))])
    expect(source.closeCalls).toBe(1)
  })

  it.each<[string, (source: FakeEventSource, event: StudioEvent) => void]>([
    ['malformed JSON', (source) => source.dispatch({ type: 'chat_received', data: `{"token":"${SEEDED}"`, lastEventId: `${RUN_ID}:1` })],
    ['a non-string payload', (source, event) => source.dispatch({ type: event.type, data: event, lastEventId: event.event_id })],
    ['a contract-invalid payload', (source, event) => source.dispatch({ type: event.type, data: JSON.stringify({ ...event, secret: SEEDED }), lastEventId: event.event_id })],
    ['an SSE id that differs from the payload', (source, event) => source.dispatch({ type: event.type, data: JSON.stringify(event), lastEventId: `${RUN_ID}:9` })],
    ['an SSE event name that differs from the payload', (source, event) => source.dispatch({ type: 'run_finalized', data: JSON.stringify(event), lastEventId: event.event_id })],
    ['an unnamed record', (source, event) => source.dispatch({ type: 'message', data: JSON.stringify(event), lastEventId: event.event_id })],
  ])('fails closed on %s and stops delivery', (_label, deliver) => {
    const { source, log } = openStream()
    const events = heroEvents()
    deliver(source, events[0] as StudioEvent)
    source.send(events[0] as StudioEvent)
    source.dispatch({ type: 'error' })
    expect(log).toEqual([{ kind: 'error', error: { code: 'EVENT_INVALID', message: expect.any(String) as string } }])
    expect(JSON.stringify(log)).not.toContain(SEEDED)
    expect(source.closeCalls).toBe(1)
  })

  it.each([
    ['another run', OTHER_RUN_ID, 1, 'EVENT_RUN_MISMATCH'],
    ['a repeated sequence', RUN_ID, 0, 'EVENT_SEQUENCE_DUPLICATE'],
    ['a skipped sequence', RUN_ID, 2, 'EVENT_SEQUENCE_GAP'],
  ] as const)('fails closed on %s', (_label, runId, index, code) => {
    const { source, log } = openStream()
    const events = heroEvents()
    source.send(events[0] as StudioEvent)
    source.send(heroEvents(runId)[index] as StudioEvent)
    source.send(events[1] as StudioEvent)
    expect(log).toEqual([{ kind: 'event', sequence: 1 }, { kind: 'error', error: { code, message: expect.any(String) as string } }])
    expect(source.closeCalls).toBe(1)
  })

  it('reports a disconnect once and never reconnects or replays', () => {
    const { source, log, opens } = openStream()
    source.send(heroEvents()[0] as StudioEvent)
    source.dispatch({ type: 'error' })
    source.dispatch({ type: 'error' })
    source.send(heroEvents()[1] as StudioEvent)
    expect(log).toEqual([{ kind: 'event', sequence: 1 }, { kind: 'disconnect' }])
    expect(source.closeCalls).toBe(1)
    expect(opens).toHaveLength(1)
  })

  it('stops silently when the consumer closes the subscription', () => {
    const { source, log, subscription } = openStream()
    subscription.close()
    subscription.close()
    source.dispatch({ type: 'open' })
    source.send(heroEvents()[0] as StudioEvent)
    source.dispatch({ type: 'error' })
    expect(log).toEqual([])
    expect(source.closeCalls).toBe(1)
  })
})

describe('Studio client and state together', () => {
  it('drives a Hero run from case listing to the authoritative Verified Fix', async () => {
    let state: StudioState = initialStudioState
    const dispatch = (action: StudioAction): void => {
      state = studioReducer(deepFreeze(state), action)
    }
    const requests: string[] = []
    const sources: FakeEventSource[] = []
    const replies = [json(200, { scenarios: SCENARIOS }), json(202, START), json(202, { state: 'running' }), json(200, VERIFIED)]
    const client = createStudioClient({
      fetch: async (path, init) => {
        requests.push(`${String(init.method)} ${path}`)
        const reply = replies.shift()
        if (reply === undefined) throw new Error('Unexpected Studio request.')
        return reply
      },
      openEventSource: (path) => {
        requests.push(`SSE ${path}`)
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
    })

    dispatch({ type: 'catalog/loaded', scenarios: await client.listScenarios() })
    const scenarioId = state.selectedScenarioId
    expect(scenarioId).toBe(HERO)
    dispatch({ type: 'run/requested', requestText: GOAL })
    const start = await client.startRun({ scenarioId: scenarioId as string, requestText: GOAL })
    dispatch({ type: 'run/started', start })
    client.openRunEvents(start.run_id, runEventHandlers(start.run_id, dispatch))
    const [source] = sources
    if (source === undefined) throw new Error('No event source was opened.')
    source.dispatch({ type: 'open' })
    const events = heroEvents()
    for (const event of events.slice(0, 12)) source.send(event)
    expect(currentRun(state)).toMatchObject({ status: 'running', phase: 'candidate_validated', candidate: 'ready' })
    for (const event of events.slice(12)) source.send(event)
    expect(currentRun(state).stream.status).toBe('ended')
    expect(currentRun(state).result).toBeNull()

    dispatch({ type: 'result/received', runId: start.run_id, result: await client.pollResult(start.run_id, { intervalMs: 0 }) })
    const run = currentRun(state)
    expect(run.status).toBe('finalized')
    expect(run.result?.status).toBe('Verified Fix')
    expect(run.activity).toHaveLength(events.length)
    expect(run.evidenceIds).toEqual([...FAILURE_IDS, ...REPLAY_IDS])
    expect(selectGateRows(run).every((row) => row.status === 'pass' && row.outcome !== null)).toBe(true)
    expect(requests).toEqual([
      'GET /api/scenarios',
      'POST /api/runs',
      `SSE /api/runs/${RUN_ID}/events`,
      `GET /api/runs/${RUN_ID}/result`,
      `GET /api/runs/${RUN_ID}/result`,
    ])
    expect(source.closeCalls).toBe(1)
  })

  it('records a refused start through the same safe error path', async () => {
    let state = reduce([{ type: 'catalog/loaded', scenarios: SCENARIOS }, { type: 'run/requested', requestText: GOAL }])
    const { client } = fakeFetch(envelope(409, 'PROVIDER_CREDENTIAL_MISSING'))
    try {
      await client.startRun({ scenarioId: HERO, requestText: GOAL })
    } catch (error) {
      state = studioReducer(state, { type: 'run/rejected', error: toStudioError(error) })
    }
    expect(state.pendingStart).toBeNull()
    expect(state.error?.code).toBe('PROVIDER_CREDENTIAL_MISSING')
    expect(JSON.stringify(state)).not.toContain(SEEDED)
  })
})
