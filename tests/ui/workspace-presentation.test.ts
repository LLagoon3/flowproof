import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as contracts from '../../packages/flowproof/src/contracts/index.js'
import { CONTRACT_SCHEMA_VERSION, parseStudioEvent } from '../../apps/studio/src/api.js'
import type { CapturedVerificationResult, GateSummary, RunResult, RunState, ScenarioSummary, StudioEvent, StudioEventType } from '../../apps/studio/src/api.js'
import {
  DEFAULT_PANEL_WIDTH_STEP,
  PANEL_WIDTHS_REM,
  initialWorkspacePresentation,
  panelWidthRem,
  panelWidthStepAt,
  panelWidthStepForKey,
  selectCompactStatus,
  selectMeasuringTarget,
  workspaceReducer,
} from '../../apps/studio/src/presentation.js'
import type { CompactStatusView, WorkspaceAction, WorkspacePresentation } from '../../apps/studio/src/presentation.js'
import { CAPTURED_STATUS_LABELS, initialStudioState, selectCapturedOutcome, selectCapturedTarget, studioReducer } from '../../apps/studio/src/state.js'
import type { StudioAction, StudioState } from '../../apps/studio/src/state.js'

// T009 for T011: the local workspace presentation of Spec 005 slice 2. The panel width and
// collapse choices are pure presentation state with no route into the run reducer, the client or
// the network. The compact status shown outside a collapsed work panel is derived only from the
// existing authoritative Studio state and selectors: it never turns a stream end, a disconnection
// or an unreadable result into a verdict, and it repeats the exact family verdict of a bound final
// result. Existing acceptance assertions in `state.test.ts` and `captured-verification.test.ts`
// stay as they are; these cases add the presentation boundary on top of them.

const HERO = 'canvas-filter-hero'
const FAILURE = 'canvas-filter-failure-invalid-citation'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'

const FIXTURE_DIR = new URL('../fixtures/contracts/', import.meta.url)
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as unknown
const VERIFIED = fixture('run-result.valid-verified.json') as RunResult
const UNVERIFIED = fixture('run-result.valid-unverified.json') as RunResult
const PASSED = fixture('captured-verification-result.valid-passed.json') as CapturedVerificationResult
const FAILED = fixture('captured-verification-result.valid-failed.json') as CapturedVerificationResult
const INTERRUPTED = fixture('captured-verification-result.valid-interrupted-timeout.json') as CapturedVerificationResult

const LEGACY_RUN_ID = VERIFIED.run_id
const LEGACY_REQUEST_ID = VERIFIED.request_id
const CAPTURED_RUN_ID = PASSED.run_id
const CAPTURED_REQUEST_ID = PASSED.request_id
const OTHER_RUN_ID = 'b0c1d2e3-f405-4617-8829-3a4b5c6d7e8f'

const LEGACY_SCENARIOS: readonly ScenarioSummary[] = [
  { scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL },
  { scenario_id: FAILURE, case: 'failure-invalid-citation', title: 'Reject an invalid citation', default_request: GOAL },
]
const CAPTURED_SCENARIOS: readonly ScenarioSummary[] = [
  { scenario_id: HERO, case: 'hero', title: 'Verify the Canvas filter fix', default_request: GOAL, execution_kind: 'captured-verification' },
]

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Applies actions to frozen states, so any in-place mutation throws. */
const reduce = (actions: readonly StudioAction[], from: StudioState = initialStudioState): StudioState =>
  actions.reduce((state, action) => studioReducer(deepFreeze(state), action), from)

const present = (actions: readonly WorkspaceAction[], from: WorkspacePresentation = initialWorkspacePresentation): WorkspacePresentation =>
  actions.reduce((state, action) => workspaceReducer(deepFreeze(state), action), from)

interface EventInput {
  readonly type: StudioEventType
  readonly phase: RunState | null
  readonly message?: string
  readonly evidence_ids?: readonly string[]
  readonly gate?: GateSummary | null
  readonly artifact_refs?: readonly string[]
}

/** A Studio Event that both the client and the engine contract accept. */
function studioEvent(sequence: number, input: EventInput, runId: string): StudioEvent {
  const raw = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    event_id: `${runId}:${sequence}`,
    run_id: runId,
    sequence,
    occurred_at: '2026-11-04T09:00:00.000Z',
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

const FAILURE_IDS = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'].map((type) => `ev_failure_${type}_001`)
const REPLAY_IDS = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network'].map((type) => `ev_replay_${type}_001`)
const gate = (gate_id: GateSummary['gate_id'], status: GateSummary['status'], reason_code: string): GateSummary => ({ gate_id, status, reason_code })

/** Legacy live activity that claims success at every step, ending with the run's final event. */
const LEGACY_FLOW: readonly EventInput[] = [
  { type: 'chat_received', phase: 'initialized' },
  { type: 'phase_started', phase: 'reproducing' },
  { type: 'evidence_added', phase: 'reproducing', evidence_ids: FAILURE_IDS, artifact_refs: ['evidence/failure/manifest.json'] },
  { type: 'gate_updated', phase: 'reproducing', gate: gate('failure_reproduced', 'pass', 'FAILURE_REPRODUCED') },
  { type: 'phase_started', phase: 'failure_captured' },
  { type: 'phase_started', phase: 'diagnosing' },
  { type: 'phase_started', phase: 'applying' },
  { type: 'phase_started', phase: 'replaying' },
  { type: 'evidence_added', phase: 'replaying', evidence_ids: REPLAY_IDS, artifact_refs: ['evidence/replay/manifest.json'] },
  { type: 'gate_updated', phase: 'replaying', gate: gate('original_worktree_unchanged', 'pass', 'WORKTREE_UNCHANGED') },
  { type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Verified Fix.', artifact_refs: ['result.json'] },
]

/** Captured live activity in the order the captured engine emits it, ending with its final event. */
const CAPTURED_FLOW: readonly EventInput[] = [
  { type: 'agent_message', phase: 'initialized', message: 'Building the recorded baseline and loading it into the Studio frame (not live yet).' },
  { type: 'phase_started', phase: 'reproducing', message: 'The recorded baseline is live in the Studio frame; reproducing the prepared defect.' },
  { type: 'evidence_added', phase: 'reproducing', evidence_ids: FAILURE_IDS, artifact_refs: ['evidence/failure/manifest.json'] },
  { type: 'phase_started', phase: 'failure_captured' },
  { type: 'phase_started', phase: 'applying' },
  { type: 'phase_started', phase: 'replaying', message: 'The candidate build is live in the same Studio frame; replaying the prepared scenario.' },
  { type: 'evidence_added', phase: 'replaying', evidence_ids: REPLAY_IDS, artifact_refs: ['evidence/replay/manifest.json'] },
  { type: 'agent_message', phase: 'replaying', message: 'Scanning the candidate, the evidence, and the run activity for secrets.' },
  { type: 'agent_message', phase: 'replaying', message: 'Releasing the target, operations, and owned worktree, then comparing the original repository.' },
  { type: 'run_finalized', phase: 'finalized', message: 'Run finalized as passed.', artifact_refs: ['result.json'] },
]

const events = (inputs: readonly EventInput[], runId: string): StudioEvent[] => inputs.map((input, index) => studioEvent(index + 1, input, runId))
const eventActions = (list: readonly StudioEvent[], runId: string): StudioAction[] => list.map((event) => ({ type: 'stream/event', runId, event }))

const LEGACY_RUNNING: readonly StudioAction[] = [
  { type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS },
  { type: 'run/requested', requestText: GOAL },
  { type: 'run/started', start: { request_id: LEGACY_REQUEST_ID, run_id: LEGACY_RUN_ID, events_url: `/api/runs/${LEGACY_RUN_ID}/events` } },
  { type: 'stream/opened', runId: LEGACY_RUN_ID },
]
const CAPTURED_RUNNING: readonly StudioAction[] = [
  { type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS },
  { type: 'run/requested', requestText: GOAL },
  { type: 'run/started', start: { request_id: CAPTURED_REQUEST_ID, run_id: CAPTURED_RUN_ID, events_url: `/api/runs/${CAPTURED_RUN_ID}/events` } },
  { type: 'stream/opened', runId: CAPTURED_RUN_ID },
]

const legacyResult = (result: unknown): StudioAction => ({ type: 'result/received', runId: LEGACY_RUN_ID, result: result as RunResult })
const capturedResult = (result: unknown): StudioAction => ({ type: 'result/received', runId: CAPTURED_RUN_ID, result: result as CapturedVerificationResult })

/** Every family verdict; a compact status that is not a final result must show none of them. */
const VERDICTS = ['Verified Fix', 'Unverified', ...Object.values(CAPTURED_STATUS_LABELS)]
const showsNoVerdict = (view: CompactStatusView): boolean => !VERDICTS.some((verdict) => view.label.includes(verdict))

describe('Workspace presentation: panel width and collapse are local choices', () => {
  it('offers seven bounded width choices from 20rem to 32rem and defaults to the 24rem choice', () => {
    expect([...PANEL_WIDTHS_REM]).toEqual([20, 22, 24, 26, 28, 30, 32])
    expect(DEFAULT_PANEL_WIDTH_STEP).toBe(2)
    expect(initialWorkspacePresentation).toEqual({ panelWidthStep: 2, panelCollapsed: false })
    expect(panelWidthRem(initialWorkspacePresentation.panelWidthStep)).toBe(24)
    expect(Object.isFrozen(initialWorkspacePresentation)).toBe(true)
  })

  it('keeps only presentation choices: no run, request, stream, result or network field', () => {
    let state = initialWorkspacePresentation
    for (const action of [{ type: 'panel/width', step: 5 }, { type: 'panel/collapse' }, { type: 'panel/restore' }] as const) {
      state = present([action], state)
      expect(Object.keys(state).sort()).toEqual(['panelCollapsed', 'panelWidthStep'])
    }
  })

  it('clamps and rounds every requested width to one of the seven integer choices', () => {
    expect(present([{ type: 'panel/width', step: -3 }]).panelWidthStep).toBe(0)
    expect(present([{ type: 'panel/width', step: 99 }]).panelWidthStep).toBe(6)
    expect(present([{ type: 'panel/width', step: 3.4 }]).panelWidthStep).toBe(3)
    expect(present([{ type: 'panel/width', step: Number.NaN }]).panelWidthStep).toBe(DEFAULT_PANEL_WIDTH_STEP)
    for (let step = 0; step < 7; step += 1) expect(panelWidthRem(present([{ type: 'panel/width', step }]).panelWidthStep)).toBe(20 + step * 2)
  })

  it('maps the separator keys onto the same width choice the drag uses', () => {
    expect(panelWidthStepForKey(2, 'ArrowRight')).toBe(3)
    expect(panelWidthStepForKey(2, 'ArrowUp')).toBe(3)
    expect(panelWidthStepForKey(2, 'ArrowLeft')).toBe(1)
    expect(panelWidthStepForKey(2, 'ArrowDown')).toBe(1)
    expect(panelWidthStepForKey(2, 'Home')).toBe(0)
    expect(panelWidthStepForKey(2, 'End')).toBe(6)
    expect(panelWidthStepForKey(6, 'ArrowRight')).toBe(6)
    expect(panelWidthStepForKey(0, 'ArrowLeft')).toBe(0)
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a']) expect(panelWidthStepForKey(2, key)).toBeNull()
  })

  it('snaps a dragged panel width to the nearest choice at the current root font size', () => {
    expect(panelWidthStepAt(24 * 16, 16)).toBe(2)
    expect(panelWidthStepAt(25.1 * 16, 16)).toBe(3)
    expect(panelWidthStepAt(10 * 16, 16)).toBe(0)
    expect(panelWidthStepAt(60 * 16, 16)).toBe(6)
    // Root font size from the actual page, for example under browser zoom or a larger default.
    expect(panelWidthStepAt(28 * 20, 20)).toBe(4)
    expect(panelWidthStepAt(Number.NaN, 16)).toBe(DEFAULT_PANEL_WIDTH_STEP)
  })

  it('preserves the width choice through collapse and restore, and repeated choices change nothing', () => {
    const wide = present([{ type: 'panel/width', step: 5 }])
    const collapsed = present([{ type: 'panel/collapse' }], wide)
    expect(collapsed).toEqual({ panelWidthStep: 5, panelCollapsed: true })
    expect(present([{ type: 'panel/collapse' }], collapsed)).toBe(collapsed)
    // A width choice made while collapsed is kept for the restored panel.
    const narrower = present([{ type: 'panel/width', step: 1 }], collapsed)
    expect(narrower).toEqual({ panelWidthStep: 1, panelCollapsed: true })
    const restored = present([{ type: 'panel/restore' }], narrower)
    expect(restored).toEqual({ panelWidthStep: 1, panelCollapsed: false })
    expect(present([{ type: 'panel/restore' }], restored)).toBe(restored)
    expect(present([{ type: 'panel/width', step: 1 }], restored)).toBe(restored)
  })

  it('keeps layout choices out of execution: the presentation module reaches only the state selectors', () => {
    const source = readFileSync(new URL('../../apps/studio/src/presentation.ts', import.meta.url), 'utf8')
    const runtime = [...source.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)].map((match) => match[1])
    expect(runtime).toEqual(['./state.js'])
    expect(source).not.toMatch(/\b(fetch|EventSource|createStudioClient|startRun|pollResult|openRunEvents|studioReducer|localStorage|sessionStorage)\b/)
  })

  it('keeps the shell free of execution: it reaches no client, reducer, storage or network seam', () => {
    const shell = new URL('../../apps/studio/src/components/WorkspaceShell.tsx', import.meta.url)
    expect(existsSync(shell)).toBe(true)
    const source = readFileSync(shell, 'utf8')
    const runtime = [...source.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'([^']+)'/gm)].map((match) => match[1]).sort()
    expect(runtime).toEqual(['../presentation.js', 'react'])
    expect(source).not.toMatch(/\b(fetch|EventSource|createStudioClient|startRun|pollResult|openRunEvents|studioReducer|localStorage|sessionStorage)\b/)
    // Widths are attribute-backed CSS classes; an inline style would need a CSP exception.
    expect(source).not.toMatch(/\bstyle\s*=|\.style\b/)
  })
})

describe('Workspace presentation: compact status from authoritative state only', () => {
  it('states loading, unavailable, ready and starting without a verdict or a result entry', () => {
    const loading = selectCompactStatus(initialStudioState)
    const unavailable = selectCompactStatus(reduce([{ type: 'catalog/failed', error: { code: 'NETWORK_UNAVAILABLE', message: 'x' } }]))
    const ready = selectCompactStatus(reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }]))
    const starting = selectCompactStatus(reduce(LEGACY_RUNNING.slice(0, 2)))
    expect(loading).toEqual({ label: 'Loading', tone: 'neutral', hasResult: false, activityNotice: null })
    expect(unavailable).toEqual({ label: 'Not ready', tone: 'warning', hasResult: false, activityNotice: null })
    expect(ready).toEqual({ label: 'Ready', tone: 'neutral', hasResult: false, activityNotice: null })
    expect(starting).toEqual({ label: 'Starting', tone: 'progress', hasResult: false, activityNotice: null })
    expect(selectCompactStatus(reduce([{ type: 'catalog/loaded', scenarios: [] }]))).toEqual(unavailable)
  })

  it('offers no action of its own beyond returning to an existing result', () => {
    for (const state of [initialStudioState, reduce(LEGACY_RUNNING), reduce([...LEGACY_RUNNING, legacyResult(VERIFIED)])]) {
      expect(Object.keys(selectCompactStatus(state)).sort()).toEqual(['activityNotice', 'hasResult', 'label', 'tone'])
    }
  })

  it('keeps a legacy run in progress through every live event, including the final event, until its result', () => {
    let state = reduce(LEGACY_RUNNING)
    const seen: CompactStatusView[] = [selectCompactStatus(state)]
    for (const action of eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID)) {
      state = reduce([action], state)
      seen.push(selectCompactStatus(state))
    }
    // The stream ended with `run_finalized`, yet no authoritative result was read.
    expect(state.run?.stream.status).toBe('ended')
    expect(state.run?.status).toBe('running')
    for (const view of seen) expect(view).toEqual({ label: 'Run in progress', tone: 'progress', hasResult: false, activityNotice: null })
  })

  it('shows a lost activity stream as a separate notice, never as a failure or success', () => {
    const disconnected = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 3), LEGACY_RUN_ID), LEGACY_RUN_ID), { type: 'stream/disconnected', runId: LEGACY_RUN_ID }])
    expect(selectCompactStatus(disconnected)).toEqual({ label: 'Run in progress', tone: 'progress', hasResult: false, activityNotice: 'Live activity disconnected' })
    const rejected = reduce([...LEGACY_RUNNING, { type: 'stream/failed', runId: LEGACY_RUN_ID, error: { code: 'EVENT_INVALID', message: 'x' } }])
    expect(selectCompactStatus(rejected)).toEqual({ label: 'Run in progress', tone: 'progress', hasResult: false, activityNotice: 'Live activity stopped' })
    // The authoritative poll still finalizes the run, and the result replaces the notice.
    expect(selectCompactStatus(reduce([legacyResult(UNVERIFIED)], disconnected))).toEqual({ label: 'Unverified', tone: 'danger', hasResult: true, activityNotice: null })
  })

  it('shows no verdict when no valid result could be read, including a result of the other family or run', () => {
    const unreadable = reduce([...LEGACY_RUNNING, { type: 'result/failed', runId: LEGACY_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }])
    const otherFamily = reduce([...LEGACY_RUNNING, legacyResult(PASSED)])
    const otherRun = reduce([...LEGACY_RUNNING, legacyResult({ ...VERIFIED, run_id: OTHER_RUN_ID })])
    for (const state of [unreadable, otherFamily, otherRun]) {
      expect(state.run?.status).toBe('failed')
      const view = selectCompactStatus(state)
      expect(view).toEqual({ label: 'No final status', tone: 'warning', hasResult: false, activityNotice: null })
      expect(showsNoVerdict(view)).toBe(true)
    }
  })

  it('repeats the exact legacy verdict of the bound result, and late activity never revises it', () => {
    const verified = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 4), LEGACY_RUN_ID), LEGACY_RUN_ID), legacyResult(VERIFIED)])
    expect(selectCompactStatus(verified)).toEqual({ label: 'Verified Fix', tone: 'success', hasResult: true, activityNotice: null })
    expect(selectCompactStatus(verified).label).toBe(verified.run?.result?.status)
    const late = reduce(eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID).slice(4), LEGACY_RUN_ID), verified)
    expect(selectCompactStatus(late)).toEqual(selectCompactStatus(verified))
    expect(selectCompactStatus(reduce([{ type: 'stream/disconnected', runId: LEGACY_RUN_ID }], verified))).toEqual(selectCompactStatus(verified))

    const unverified = reduce([...LEGACY_RUNNING, legacyResult(UNVERIFIED)])
    expect(selectCompactStatus(unverified)).toEqual({ label: 'Unverified', tone: 'danger', hasResult: true, activityNotice: null })
  })

  it('stops offering the previous legacy result once the next start is pending', () => {
    const finished = reduce([...LEGACY_RUNNING, legacyResult(VERIFIED)])
    expect(selectCompactStatus(reduce([{ type: 'run/requested', requestText: GOAL }], finished))).toEqual({
      label: 'Starting',
      tone: 'progress',
      hasResult: false,
      activityNotice: null,
    })
  })

  it('keeps the captured verification in progress through scan, release and its final event until the strict result', () => {
    let state = reduce(CAPTURED_RUNNING)
    const seen: CompactStatusView[] = [selectCompactStatus(state)]
    for (const action of eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID)) {
      state = reduce([action], state)
      seen.push(selectCompactStatus(state))
    }
    expect(state.capturedRun?.stream.status).toBe('ended')
    expect(state.capturedRun?.status).toBe('running')
    for (const view of seen) expect(view).toEqual({ label: 'Verification in progress', tone: 'progress', hasResult: false, activityNotice: null })
  })

  it.each<[string, CapturedVerificationResult, CompactStatusView['tone']]>([
    ['passed', PASSED, 'success'],
    ['failed', FAILED, 'danger'],
    ['interrupted', INTERRUPTED, 'warning'],
  ])('repeats the exact captured label of a bound %s result, never a legacy claim', (_name, result, tone) => {
    const state = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID), capturedResult(result)])
    const view = selectCompactStatus(state)
    expect(view).toEqual({ label: CAPTURED_STATUS_LABELS[result.status], tone, hasResult: true, activityNotice: null })
    expect(view.label).toBe(selectCapturedOutcome(state.capturedRun)?.label)
    expect(view.label).not.toMatch(/Verified Fix|Unverified/)
  })

  it('shows no captured verdict for a legacy result, a result bound to another run, or an unreadable result', () => {
    const legacyFamily = reduce([...CAPTURED_RUNNING, capturedResult(VERIFIED)])
    const otherRun = reduce([...CAPTURED_RUNNING, capturedResult({ ...PASSED, run_id: OTHER_RUN_ID })])
    const unreadable = reduce([...CAPTURED_RUNNING, { type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }])
    for (const state of [legacyFamily, otherRun, unreadable]) {
      expect(state.capturedRun?.status).toBe('failed')
      const view = selectCompactStatus(state)
      expect(view).toEqual({ label: 'No final status', tone: 'warning', hasResult: false, activityNotice: null })
      expect(showsNoVerdict(view)).toBe(true)
    }
  })

  it('keeps a lost captured activity stream a notice beside the pending verification', () => {
    const lost = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 3), CAPTURED_RUN_ID), CAPTURED_RUN_ID), { type: 'stream/disconnected', runId: CAPTURED_RUN_ID }])
    expect(selectCompactStatus(lost)).toEqual({ label: 'Verification in progress', tone: 'progress', hasResult: false, activityNotice: 'Live activity disconnected' })
    const done = reduce([capturedResult(PASSED)], lost)
    expect(selectCompactStatus(done)).toEqual({ label: 'Candidate verification passed', tone: 'success', hasResult: true, activityNotice: null })
  })

  it('never shows Verified Fix in a captured session or a captured label in a legacy session', () => {
    const captured = [
      reduce([{ type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS }]),
      reduce(CAPTURED_RUNNING.slice(0, 2)),
      reduce(CAPTURED_RUNNING),
      ...[PASSED, FAILED, INTERRUPTED, VERIFIED].map((result) => reduce([...CAPTURED_RUNNING, capturedResult(result)])),
    ]
    for (const state of captured) expect(selectCompactStatus(state).label).not.toMatch(/Verified Fix|Unverified/)
    const legacy = [reduce(LEGACY_RUNNING), ...[VERIFIED, UNVERIFIED, PASSED].map((result) => reduce([...LEGACY_RUNNING, legacyResult(result)]))]
    for (const state of legacy) expect(selectCompactStatus(state).label).not.toMatch(/Candidate verification/)
  })
})

describe('Workspace presentation: layout holds still while the target is measured', () => {
  // The engine reads the Canvas box and then clips the page screenshot to it, so a layout change in
  // between would move the frame under the clip. While a measured phase is observed, layout requests
  // are kept and applied once it ends; preparation, diagnosis and finalization never hold them.

  it('holds a legacy run from its start through reproduction and again through replay while live activity is connected', () => {
    // Reproduction begins as soon as the run is admitted, often before the page's live stream is
    // attached, so the hold starts with the start request and lasts until a later phase is observed.
    const pending = reduce(LEGACY_RUNNING.slice(0, 2))
    expect(selectMeasuringTarget(pending)).toBe(true)
    let state = reduce(LEGACY_RUNNING)
    const holds: Array<[string, boolean]> = [['connected', selectMeasuringTarget(state)]]
    for (const action of eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID)) {
      state = reduce([action], state)
      holds.push([`${action.type === 'stream/event' ? action.event.type : action.type}:${state.run?.phase ?? 'none'}`, selectMeasuringTarget(state)])
    }
    expect(holds).toEqual([
      ['connected', true],
      ['chat_received:initialized', true],
      ['phase_started:reproducing', true],
      ['evidence_added:reproducing', true],
      ['gate_updated:reproducing', true],
      ['phase_started:failure_captured', false],
      ['phase_started:diagnosing', false],
      ['phase_started:applying', false],
      ['phase_started:replaying', true],
      ['evidence_added:replaying', true],
      ['gate_updated:replaying', true],
      ['run_finalized:finalized', false],
    ])
    expect(selectMeasuringTarget(reduce([legacyResult(VERIFIED)], state))).toBe(false)
  })

  it('releases a legacy run whose first observed activity is already past reproduction', () => {
    const late = events(LEGACY_FLOW, LEGACY_RUN_ID).slice(4)
    expect(late[0]?.phase).toBe('failure_captured')
    expect(selectMeasuringTarget(reduce([...LEGACY_RUNNING, ...eventActions(late.slice(0, 1), LEGACY_RUN_ID)]))).toBe(false)
  })

  it('never holds the legacy layout without a live stream, a running run or once a result decided it', () => {
    const measuring = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 2), LEGACY_RUN_ID), LEGACY_RUN_ID)])
    expect(selectMeasuringTarget(measuring)).toBe(true)
    expect(selectMeasuringTarget(reduce([{ type: 'stream/disconnected', runId: LEGACY_RUN_ID }], measuring))).toBe(false)
    expect(selectMeasuringTarget(reduce([{ type: 'stream/failed', runId: LEGACY_RUN_ID, error: { code: 'EVENT_INVALID', message: 'x' } }], reduce(LEGACY_RUNNING)))).toBe(false)
    expect(selectMeasuringTarget(reduce([{ type: 'result/failed', runId: LEGACY_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], measuring))).toBe(false)
    expect(selectMeasuringTarget(reduce([legacyResult(UNVERIFIED)], measuring))).toBe(false)
    for (const state of [initialStudioState, reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }]), reduce([...LEGACY_RUNNING.slice(0, 2), { type: 'run/rejected', error: { code: 'RUN_ALREADY_ACTIVE', message: 'x' } }])]) {
      expect(selectMeasuringTarget(state)).toBe(false)
    }
  })

  it('holds the captured layout exactly while the target is presented as live, never during preparation, scan or release', () => {
    // The captured target is first measured only after its baseline build, long after the stream attached.
    expect(selectMeasuringTarget(reduce(CAPTURED_RUNNING.slice(0, 2)))).toBe(false)
    let state = reduce(CAPTURED_RUNNING)
    const holds: Array<[string | null, boolean]> = [[selectCapturedTarget(state.capturedRun), selectMeasuringTarget(state)]]
    for (const action of eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID)) {
      state = reduce([action], state)
      holds.push([selectCapturedTarget(state.capturedRun), selectMeasuringTarget(state)])
    }
    for (const [label, held] of holds) expect(held, String(label)).toBe(label === 'baseline-live' || label === 'candidate-live')
    expect(holds.filter(([, held]) => held).length).toBe(4)
    expect(selectMeasuringTarget(reduce([capturedResult(PASSED)], state))).toBe(false)
    const lost = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 2), CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
    expect(selectMeasuringTarget(lost)).toBe(true)
    expect(selectMeasuringTarget(reduce([{ type: 'stream/disconnected', runId: CAPTURED_RUN_ID }], lost))).toBe(false)
  })
})
