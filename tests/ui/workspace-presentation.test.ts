import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as contracts from '../../packages/flowproof/src/contracts/index.js'
import { CONTRACT_SCHEMA_VERSION, parseStudioEvent } from '../../apps/studio/src/api.js'
import type { CapturedVerificationResult, GateSummary, RunResult, RunState, ScenarioSummary, StudioEvent, StudioEventType } from '../../apps/studio/src/api.js'
import {
  DEFAULT_PANEL_WIDTH_STEP,
  PANEL_WIDTHS_REM,
  compactStatusOf,
  initialWorkspacePresentation,
  panelWidthRem,
  panelWidthStepAt,
  panelWidthStepForKey,
  selectCompactStatus,
  selectMeasuringTarget,
  selectRunPresentation,
  workspaceReducer,
} from '../../apps/studio/src/presentation.js'
import type { CompactStatusView, RunPresentation, WorkCardView, WorkspaceAction, WorkspacePresentation } from '../../apps/studio/src/presentation.js'
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

  it('keeps a legacy run pending through every live event, including the final event, until its result: in progress, then finalizing once its integrity gate was observed', () => {
    let state = reduce(LEGACY_RUNNING)
    const seen: CompactStatusView[] = [selectCompactStatus(state)]
    for (const action of eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID)) {
      state = reduce([action], state)
      seen.push(selectCompactStatus(state))
    }
    // The stream ended with `run_finalized`, yet no authoritative result was read.
    expect(state.run?.stream.status).toBe('ended')
    expect(state.run?.status).toBe('running')
    // Before the tenth event, the original-worktree gate update, no finalization was observed.
    for (const view of seen.slice(0, 10)) expect(view).toEqual({ label: 'Run in progress', tone: 'progress', hasResult: false, activityNotice: null })
    for (const view of seen.slice(10)) expect(view).toEqual({ label: 'Finalizing · verdict pending', tone: 'progress', hasResult: false, activityNotice: null })
    for (const view of seen) expect(showsNoVerdict(view)).toBe(true)
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

  it('keeps the captured verification pending through scan, release and its final event until the strict result: in progress, then finalizing from the observed scan', () => {
    let state = reduce(CAPTURED_RUNNING)
    const seen: CompactStatusView[] = [selectCompactStatus(state)]
    for (const action of eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID)) {
      state = reduce([action], state)
      seen.push(selectCompactStatus(state))
    }
    expect(state.capturedRun?.stream.status).toBe('ended')
    expect(state.capturedRun?.status).toBe('running')
    // The eighth event is the scan marker; scan, release and the final event are all finalization.
    for (const view of seen.slice(0, 8)) expect(view).toEqual({ label: 'Verification in progress', tone: 'progress', hasResult: false, activityNotice: null })
    for (const view of seen.slice(8)) expect(view).toEqual({ label: 'Finalizing · verdict pending', tone: 'progress', hasResult: false, activityNotice: null })
    for (const view of seen) expect(showsNoVerdict(view)).toBe(true)
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
  // are kept and applied once it ends; preparation, diagnosis and finalization observed through
  // connected live activity never hold them. Lost or rejected activity ends only what the page can
  // see: the engine measures on, unseen, so the hold lasts until the bound result decides the run.

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

  it('releases the legacy layout once its bound result or observed final event decided the run, and holds nothing before a run', () => {
    const measuring = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 2), LEGACY_RUN_ID), LEGACY_RUN_ID)])
    expect(selectMeasuringTarget(measuring)).toBe(true)
    expect(selectMeasuringTarget(reduce([legacyResult(UNVERIFIED)], measuring))).toBe(false)
    const ended = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID)])
    expect(ended.run?.stream.status).toBe('ended')
    expect(selectMeasuringTarget(ended)).toBe(false)
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
    expect(state.capturedRun?.stream.status).toBe('ended')
    expect(selectMeasuringTarget(reduce([capturedResult(PASSED)], state))).toBe(false)
  })

  // Each way live activity stops before the result: the EventSource errors, the client rejects a
  // record, or the reducer rejects an event of another run. None of them stops the engine.
  const lostActivity = (runId: string, observed: number): ReadonlyArray<[string, StudioAction]> => [
    ['disconnected', { type: 'stream/disconnected', runId }],
    ['rejected', { type: 'stream/failed', runId, error: { code: 'EVENT_INVALID', message: 'x' } }],
    ['foreign event', { type: 'stream/event', runId, event: studioEvent(observed + 1, { type: 'agent_message', phase: null }, OTHER_RUN_ID) }],
  ]
  const NOTICES: Readonly<Record<string, string>> = { disconnected: 'Live activity disconnected', rejected: 'Live activity stopped', 'foreign event': 'Live activity stopped' }

  it('keeps holding a legacy run whose live activity was lost or rejected, wherever it stopped, until its bound result', () => {
    // Admission (reproduction already under way), reproduction, diagnosis before the unseen replay,
    // and the replay itself.
    for (const observed of [0, 2, 6, 9]) {
      const before = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, observed), LEGACY_RUN_ID), LEGACY_RUN_ID)])
      for (const [mode, stop] of lostActivity(LEGACY_RUN_ID, observed)) {
        const lost = reduce([stop], before)
        const where = `${mode} after ${observed} events`
        expect(lost.run?.status, where).toBe('running')
        expect(lost.run?.stream.status, where).toBe(mode === 'disconnected' ? 'disconnected' : 'rejected')
        expect(selectMeasuringTarget(lost), where).toBe(true)
        const status = selectCompactStatus(lost)
        expect(status, where).toEqual({ label: 'Run in progress', tone: 'progress', hasResult: false, activityNotice: NOTICES[mode] })
        expect(showsNoVerdict(status), where).toBe(true)
        // An unreadable result says nothing about the engine either, so the hold stays.
        const unreadable = reduce([{ type: 'result/failed', runId: LEGACY_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], lost)
        expect(selectMeasuringTarget(unreadable), where).toBe(true)
        expect(showsNoVerdict(selectCompactStatus(unreadable)), where).toBe(true)
        // Only the bound authoritative result releases it, with its exact verdict.
        const decided = reduce([legacyResult(VERIFIED)], lost)
        expect(selectMeasuringTarget(decided), where).toBe(false)
        expect(selectCompactStatus(decided).label, where).toBe('Verified Fix')
      }
    }
  })

  it('keeps holding a captured run whose live activity was lost or rejected in preparation, measurement or between measurements, without a live label or verdict, until its bound result', () => {
    // Preparation (nothing yet, then the baseline build), baseline measurement, the gap before the
    // unseen candidate measurement, and the candidate measurement.
    for (const observed of [0, 1, 2, 3, 5, 6]) {
      const before = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, observed), CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
      for (const [mode, stop] of lostActivity(CAPTURED_RUN_ID, observed)) {
        const lost = reduce([stop], before)
        const where = `${mode} after ${observed} events`
        expect(lost.capturedRun?.status, where).toBe('running')
        expect(lost.capturedRun?.stream.status, where).toBe(mode === 'disconnected' ? 'disconnected' : 'rejected')
        expect(selectMeasuringTarget(lost), where).toBe(true)
        // The frame is never presented as live, and no verdict appears, while the layout holds.
        expect(selectCapturedTarget(lost.capturedRun), where).toBe('not-live')
        const status = selectCompactStatus(lost)
        expect(status, where).toEqual({ label: 'Verification in progress', tone: 'progress', hasResult: false, activityNotice: NOTICES[mode] })
        expect(showsNoVerdict(status), where).toBe(true)
        const unreadable = reduce([{ type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], lost)
        expect(selectMeasuringTarget(unreadable), where).toBe(true)
        expect(selectCapturedTarget(unreadable.capturedRun), where).toBe('not-live')
        expect(showsNoVerdict(selectCompactStatus(unreadable)), where).toBe(true)
        const decided = reduce([capturedResult(PASSED)], lost)
        expect(selectMeasuringTarget(decided), where).toBe(false)
        expect(selectCapturedTarget(decided.capturedRun), where).toBe('completed-evidence')
        expect(selectCompactStatus(decided).label, where).toBe('Candidate verification passed')
      }
    }
  })

  it('lets connected activity, not an unreadable result, decide the hold after the result could not be read', () => {
    const unreadable: StudioAction = { type: 'result/failed', runId: LEGACY_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }
    const legacy = events(LEGACY_FLOW, LEGACY_RUN_ID)
    let state = reduce([...LEGACY_RUNNING, ...eventActions(legacy.slice(0, 2), LEGACY_RUN_ID), unreadable])
    expect(state.run?.status).toBe('failed')
    expect(selectMeasuringTarget(state)).toBe(true)
    const legacyHolds: boolean[] = []
    for (const action of eventActions(legacy.slice(2), LEGACY_RUN_ID)) {
      state = reduce([action], state)
      legacyHolds.push(selectMeasuringTarget(state))
      expect(showsNoVerdict(selectCompactStatus(state))).toBe(true)
    }
    // Reproduction, diagnosis, replay, then the final event: the same holds as a running run.
    expect(legacyHolds).toEqual([true, true, false, false, false, true, true, true, false])

    const captured = events(CAPTURED_FLOW, CAPTURED_RUN_ID)
    const capturedUnreadable: StudioAction = { ...unreadable, runId: CAPTURED_RUN_ID }
    let run = reduce([...CAPTURED_RUNNING, ...eventActions(captured.slice(0, 4), CAPTURED_RUN_ID), capturedUnreadable])
    expect(run.capturedRun?.status).toBe('failed')
    expect(selectMeasuringTarget(run)).toBe(false)
    const capturedHolds: boolean[] = []
    for (const action of eventActions(captured.slice(4), CAPTURED_RUN_ID)) {
      run = reduce([action], run)
      capturedHolds.push(selectMeasuringTarget(run))
      // Late activity holds the layout but never presents the frame as live without a running run.
      expect(selectCapturedTarget(run.capturedRun)).toBe('not-live')
      expect(showsNoVerdict(selectCompactStatus(run))).toBe(true)
    }
    // Applying, then the late candidate measurement and its evidence, then scan, release and the final event.
    expect(capturedHolds).toEqual([false, true, true, false, false, false])
    // Activity lost after the result could not be read leaves nothing to decide the hold.
    const lostLate = reduce([{ type: 'stream/disconnected', runId: CAPTURED_RUN_ID }], reduce([...CAPTURED_RUNNING, ...eventActions(captured.slice(0, 4), CAPTURED_RUN_ID), capturedUnreadable]))
    expect(selectMeasuringTarget(lostLate)).toBe(true)
    expect(selectCapturedTarget(lostLate.capturedRun)).toBe('not-live')
  })
})

// ---------------------------------------------------------------------------------------
// T017 for T018 (Spec 005 slice 3): observed work and the run presentation
// ---------------------------------------------------------------------------------------
//
// The work panel's readable groups and its current state are pure projections of the accepted,
// run-bound events and the authoritative result. A group is a contiguous run of events of one
// phase; finalization is recognized only from the exact captured scan/cleanup producer copy or the
// observed legacy original-worktree gate update, and any drifted copy falls back to the truthful
// observed phase. Live activity never yields a verdict: only a valid bound final result does, and
// once it exists late activity and lost streams never revise it. The collapsed workspace status
// is that same projection. These selector cases copy the producer strings; the real captured E2E
// checks the coupling against actual producer events.

const SCAN_MARKER = CAPTURED_FLOW[7]?.message ?? ''
const CLEANUP_MARKER = CAPTURED_FLOW[8]?.message ?? ''
const FINALIZING = 'Finalizing · verdict pending'

const flat = (cards: readonly WorkCardView[]): StudioEvent[] => cards.flatMap((card) => [...card.events])
const shape = (cards: readonly WorkCardView[]): Array<[WorkCardView['kind'], RunState | null, number, number]> =>
  cards.map((card) => [card.kind, card.phase, card.firstSequence, card.lastSequence])

/** Reduces events one at a time from `from`, returning every intermediate presentation. */
function presentEach(from: StudioState, list: readonly StudioEvent[], runId: string): { state: StudioState; seen: RunPresentation[] } {
  let state = from
  const seen: RunPresentation[] = [selectRunPresentation(state)]
  for (const action of eventActions(list, runId)) {
    state = reduce([action], state)
    seen.push(selectRunPresentation(state))
  }
  return { state, seen }
}

/** Every family verdict; a presentation without a bound final result must show none of them anywhere. */
const presentsNoVerdict = (view: RunPresentation): boolean =>
  view.verdict === null &&
  [view.label, view.detail ?? '', view.nextAction ?? '', ...view.cards.flatMap((card) => [card.title, card.statusText])].every((text) => !VERDICTS.some((verdict) => text.includes(verdict)))

describe('Work presentation: observed work in ordered contiguous groups', () => {
  it('groups contiguous events of one phase in accepted order, with IDs of run and first sequence that later events never change', () => {
    const list = events(LEGACY_FLOW, LEGACY_RUN_ID)
    const { state, seen } = presentEach(reduce(LEGACY_RUNNING), list, LEGACY_RUN_ID)
    expect(seen[0]?.cards).toEqual([])
    const firstSequenceOf = new Map<string, number>()
    seen.forEach((view, index) => {
      // Every accepted event, exactly once, in order: nothing dropped, reordered or added.
      expect(flat(view.cards)).toEqual(list.slice(0, index))
      for (const card of view.cards) {
        expect(card.id).toBe(`${LEGACY_RUN_ID}:${card.firstSequence}`)
        expect(card.runId).toBe(LEGACY_RUN_ID)
        expect(card.firstSequence).toBe(card.events[0]?.sequence)
        expect(card.lastSequence).toBe(card.events.at(-1)?.sequence)
        const known = firstSequenceOf.get(card.id)
        if (known !== undefined) expect(card.firstSequence).toBe(known)
        firstSequenceOf.set(card.id, card.firstSequence)
      }
      // A group that existed keeps its identity and position as later events arrive.
      const previous = seen[index - 1]
      if (previous !== undefined) expect(view.cards.slice(0, Math.max(0, previous.cards.length - 1)).map((card) => card.id)).toEqual(previous.cards.slice(0, -1).map((card) => card.id))
    })
    expect(shape(selectRunPresentation(state).cards)).toEqual([
      ['phase', 'initialized', 1, 1],
      ['phase', 'reproducing', 2, 4],
      ['phase', 'failure_captured', 5, 5],
      ['phase', 'diagnosing', 6, 6],
      ['phase', 'applying', 7, 7],
      ['phase', 'replaying', 8, 9],
      ['finalizing', 'replaying', 10, 11],
    ])
  })

  it('starts a new group when a phase recurs after another phase, and keeps a phase-less event in the group it follows', () => {
    const list = events(
      [
        { type: 'agent_message', phase: null, message: 'No phase reported yet.' },
        { type: 'phase_started', phase: 'reproducing' },
        { type: 'agent_message', phase: null, message: 'Still reproducing.' },
        { type: 'agent_message', phase: 'failure_captured' },
        { type: 'agent_message', phase: 'reproducing' },
      ],
      CAPTURED_RUN_ID,
    )
    const view = selectRunPresentation(reduce([...CAPTURED_RUNNING, ...eventActions(list, CAPTURED_RUN_ID)]))
    // A leading event without a phase is not given one; no phase is invented for the group.
    expect(shape(view.cards)).toEqual([
      ['phase', null, 1, 1],
      ['phase', 'reproducing', 2, 3],
      ['phase', 'failure_captured', 4, 4],
      ['phase', 'reproducing', 5, 5],
    ])
    expect(new Set(view.cards.map((card) => card.id)).size).toBe(4)
    expect(flat(view.cards)).toEqual(list)
  })

  it('keeps every accepted event of a long run rather than only the latest forty', () => {
    const inputs: EventInput[] = Array.from({ length: 45 }, (_, index) => ({ type: 'agent_message', phase: index % 2 === 0 ? 'applying' : 'failure_captured', message: `Activity ${index + 1}.` }))
    const list = events(inputs, CAPTURED_RUN_ID)
    const view = selectRunPresentation(reduce([...CAPTURED_RUNNING, ...eventActions(list, CAPTURED_RUN_ID)]))
    expect(view.cards).toHaveLength(45)
    expect(flat(view.cards)).toEqual(list)
    expect(view.cards[0]?.id).toBe(`${CAPTURED_RUN_ID}:1`)
  })

  it('marks only the last group current while the result is pending, and no group once the result is bound', () => {
    const running = selectRunPresentation(reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 5), CAPTURED_RUN_ID), CAPTURED_RUN_ID)]))
    expect(running.cards.map((card) => card.isCurrent)).toEqual([false, false, false, true])
    const lost = selectRunPresentation(
      reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 5), CAPTURED_RUN_ID), CAPTURED_RUN_ID), { type: 'stream/disconnected', runId: CAPTURED_RUN_ID }]),
    )
    expect(lost.cards.map((card) => card.isCurrent)).toEqual([false, false, false, true])
    const decided = selectRunPresentation(reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID), capturedResult(PASSED)]))
    expect(decided.cards.some((card) => card.isCurrent)).toBe(false)
  })

  it('reports the existing raw phase only: none before any event, then the accepted run phase', () => {
    const none = selectRunPresentation(reduce(LEGACY_RUNNING))
    expect(none).toMatchObject({ execution: 'active', phase: null, verdict: null, cards: [] })
    const legacy = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 5), LEGACY_RUN_ID), LEGACY_RUN_ID)])
    expect(selectRunPresentation(legacy).phase).toBe(legacy.run?.phase)
    expect(selectRunPresentation(legacy).phase).toBe('failure_captured')
  })
})

describe('Work presentation: exact observed finalization markers and drift fallback', () => {
  it('shows captured finalization from the exact scan and cleanup copy, keeping the raw phase of every event', () => {
    const list = events(CAPTURED_FLOW, CAPTURED_RUN_ID)
    const { seen } = presentEach(reduce(CAPTURED_RUNNING), list, CAPTURED_RUN_ID)
    for (const view of seen.slice(0, 8)) {
      expect(view.cards.some((card) => card.kind === 'finalizing')).toBe(false)
      expect(view.execution).toBe('active')
      expect(view.label).toBe('Verification in progress')
    }
    const [scan, cleanup, finalEvent] = [seen[8], seen[9], seen[10]]
    for (const view of [scan, cleanup, finalEvent]) {
      expect(view).toMatchObject({ execution: 'finalizing', label: FINALIZING, tone: 'progress', verdict: null })
      expect(presentsNoVerdict(view as RunPresentation)).toBe(true)
    }
    const card = finalEvent?.cards.at(-1)
    expect(card).toMatchObject({ kind: 'finalizing', title: 'Finalizing', phase: 'replaying', firstSequence: 8, lastSequence: 10, isCurrent: true })
    // One finalizing group, growing in place under the identity of its first marker.
    expect(scan?.cards.at(-1)?.id).toBe(card?.id)
    expect(cleanup?.cards.at(-1)?.events.map((event) => event.message)).toEqual([SCAN_MARKER, CLEANUP_MARKER])
    // `Finalizing` is a presentation label; the events keep the phases the producer sent.
    expect(card?.events.map((event) => event.phase)).toEqual(['replaying', 'replaying', 'finalized'])
    expect(cleanup?.phase).toBe('replaying')
  })

  it('starts captured finalization at the cleanup copy when only that marker is exact', () => {
    const drifted = CAPTURED_FLOW.map((input) => (input.message === SCAN_MARKER ? { ...input, message: 'Scanning for leaked credentials.' } : input))
    const view = selectRunPresentation(reduce([...CAPTURED_RUNNING, ...eventActions(events(drifted, CAPTURED_RUN_ID), CAPTURED_RUN_ID)]))
    expect(shape(view.cards).at(-1)).toEqual(['finalizing', 'replaying', 9, 10])
    expect(view.cards.at(-2)?.events.at(-1)?.message).toBe('Scanning for leaked credentials.')
    expect(view.execution).toBe('finalizing')
  })

  it.each<[string, (message: string) => EventInput]>([
    ['changed wording', (message) => ({ type: 'agent_message', phase: 'replaying', message: message.replace('Scanning', 'Checking').replace('Releasing', 'Freeing') })],
    ['a trailing space', (message) => ({ type: 'agent_message', phase: 'replaying', message: `${message} ` })],
    ['other letter case', (message) => ({ type: 'agent_message', phase: 'replaying', message: message.toUpperCase() })],
    ['only a prefix', (message) => ({ type: 'agent_message', phase: 'replaying', message: message.slice(0, 20) })],
    ['another event type', (message) => ({ type: 'phase_completed', phase: 'replaying', message })],
  ])('falls back to the observed phase and then a pending result when the captured copy drifted to %s', (_name, drift) => {
    const drifted = CAPTURED_FLOW.map((input) => (input.message === SCAN_MARKER || input.message === CLEANUP_MARKER ? drift(input.message ?? '') : input))
    const list = events(drifted, CAPTURED_RUN_ID)
    const { state, seen } = presentEach(reduce(CAPTURED_RUNNING), list, CAPTURED_RUN_ID)
    for (const view of seen) {
      expect(view.cards.some((card) => card.kind === 'finalizing' || card.title === 'Finalizing')).toBe(false)
      expect(view.label).not.toContain('Finalizing')
      expect(presentsNoVerdict(view)).toBe(true)
    }
    // Scan and release copy that is not exact stays in the replay group it followed.
    expect(seen[9]).toMatchObject({ execution: 'active', label: 'Verification in progress', phase: 'replaying' })
    expect(seen[9]?.cards.at(-1)).toMatchObject({ kind: 'phase', phase: 'replaying', firstSequence: 6, lastSequence: 9 })
    // The final event without an observed marker means only that the result is pending.
    const last = selectRunPresentation(state)
    expect(state.capturedRun?.stream.status).toBe('ended')
    expect(last).toMatchObject({ execution: 'result-pending', label: 'Result pending', verdict: null })
    expect(last.cards.at(-1)).toMatchObject({ kind: 'phase', phase: 'finalized', title: 'Final event' })
    expect(selectCompactStatus(state)).toEqual({ label: 'Result pending', tone: 'progress', hasResult: false, activityNotice: null })
  })

  it.each<[GateSummary['status'], string]>([
    ['pass', 'WORKTREE_UNCHANGED'],
    ['fail', 'ORIGINAL_WORKTREE_CHANGED'],
    ['unevaluable', 'CLEANUP_FAILED'],
  ])('shows legacy finalization from the observed original-worktree gate update with status %s', (status, reason) => {
    const flow = LEGACY_FLOW.map((input) => (input.gate?.gate_id === 'original_worktree_unchanged' ? { ...input, gate: gate('original_worktree_unchanged', status, reason) } : input))
    const view = selectRunPresentation(reduce([...LEGACY_RUNNING, ...eventActions(events(flow.slice(0, 10), LEGACY_RUN_ID), LEGACY_RUN_ID)]))
    expect(view).toMatchObject({ execution: 'finalizing', label: FINALIZING, verdict: null })
    expect(view.cards.at(-1)).toMatchObject({ kind: 'finalizing', phase: 'replaying', firstSequence: 10, lastSequence: 10 })
    expect(presentsNoVerdict(view)).toBe(true)
  })

  it('does not take another gate, a message naming the gate, or a captured marker as legacy finalization', () => {
    const lookalikes = events(
      [
        ...LEGACY_FLOW.slice(0, 9),
        { type: 'gate_updated', phase: 'replaying', gate: gate('canvas_matches', 'pass', 'CANVAS_MATCHES') },
        { type: 'agent_message', phase: 'replaying', message: 'original_worktree_unchanged' },
        { type: 'agent_message', phase: 'replaying', message: SCAN_MARKER },
        { type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Verified Fix.', artifact_refs: ['result.json'] },
      ],
      LEGACY_RUN_ID,
    )
    const { state, seen } = presentEach(reduce(LEGACY_RUNNING), lookalikes, LEGACY_RUN_ID)
    for (const view of seen) {
      expect(view.cards.some((card) => card.kind === 'finalizing')).toBe(false)
      expect(presentsNoVerdict(view)).toBe(true)
    }
    // The final event's own message claims a verdict; it reaches no label, only the raw record.
    const last = selectRunPresentation(state)
    expect(last).toMatchObject({ execution: 'result-pending', label: 'Result pending', verdict: null })
    expect(last.cards.at(-1)?.events.at(-1)?.message).toBe('Run finalized as Verified Fix.')
  })

  it('does not take the legacy integrity gate as captured finalization', () => {
    // Captured activity never carries legacy gates; the reducer stops such a stream before display.
    const state = reduce([...CAPTURED_RUNNING, ...eventActions(events([...CAPTURED_FLOW.slice(0, 7), LEGACY_FLOW[9] as EventInput], CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
    expect(state.capturedRun?.stream.status).toBe('rejected')
    const view = selectRunPresentation(state)
    expect(view.cards.some((card) => card.kind === 'finalizing')).toBe(false)
    expect(view).toMatchObject({ execution: 'active', verdict: null, activityNotice: 'Live activity stopped' })
  })
})

describe('Run presentation: final result, stream and verdict precedence', () => {
  it('never derives a verdict from a stream end, a disconnection or a rejection, in either mode', () => {
    const legacyEnded = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID)])
    const capturedEnded = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
    const legacyLost = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 3), LEGACY_RUN_ID), LEGACY_RUN_ID), { type: 'stream/disconnected', runId: LEGACY_RUN_ID }])
    const capturedLost = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 8), CAPTURED_RUN_ID), CAPTURED_RUN_ID), { type: 'stream/disconnected', runId: CAPTURED_RUN_ID }])
    const capturedRejected = reduce([...CAPTURED_RUNNING, { type: 'stream/failed', runId: CAPTURED_RUN_ID, error: { code: 'EVENT_INVALID', message: 'x' } }])
    for (const state of [legacyEnded, capturedEnded, legacyLost, capturedLost, capturedRejected]) {
      const view = selectRunPresentation(state)
      expect(presentsNoVerdict(view)).toBe(true)
      expect(view.tone).toBe('progress')
    }
    // A lost stream is a separate notice beside the last observed execution, not a replacement.
    expect(selectRunPresentation(legacyLost)).toMatchObject({ execution: 'active', label: 'Run in progress', phase: 'reproducing', stream: 'disconnected', activityNotice: 'Live activity disconnected' })
    expect(selectRunPresentation(capturedLost)).toMatchObject({ execution: 'finalizing', label: FINALIZING, stream: 'disconnected', activityNotice: 'Live activity disconnected' })
    expect(selectRunPresentation(capturedRejected)).toMatchObject({ execution: 'active', stream: 'rejected', activityNotice: 'Live activity stopped', cards: [] })
    // Missed events after the loss are neither inferred nor reconstructed.
    expect(flat(selectRunPresentation(legacyLost).cards)).toEqual(legacyLost.run?.activity)
  })

  it('distinguishes a result that could not be read, with no verdict, from a failed verification, with its exact verdict', () => {
    const unreadable: StudioAction = { type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }
    const capturedUnreadable = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID), unreadable])
    const capturedFailed = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID), capturedResult(FAILED)])
    const legacyUnreadable = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID), { ...unreadable, runId: LEGACY_RUN_ID }])
    const legacyUnverified = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID), legacyResult(UNVERIFIED)])
    for (const state of [capturedUnreadable, legacyUnreadable]) {
      const view = selectRunPresentation(state)
      expect(view).toMatchObject({ execution: 'result-unavailable', label: 'No final status', tone: 'warning', verdict: null })
      expect(presentsNoVerdict(view)).toBe(true)
    }
    expect(selectRunPresentation(capturedFailed)).toMatchObject({ execution: 'final', verdict: CAPTURED_STATUS_LABELS.failed, label: CAPTURED_STATUS_LABELS.failed, tone: 'danger' })
    expect(selectRunPresentation(legacyUnverified)).toMatchObject({ execution: 'final', verdict: 'Unverified', label: 'Unverified', tone: 'danger' })
  })

  it('lets a valid bound result win over observed finalization and every late event, never returning to pending', () => {
    const scanning = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 8), CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
    expect(selectRunPresentation(scanning).execution).toBe('finalizing')
    const decided = reduce([capturedResult(PASSED)], scanning)
    const expected = { execution: 'final', verdict: CAPTURED_STATUS_LABELS.passed, label: CAPTURED_STATUS_LABELS.passed, tone: 'success', activityNotice: null }
    expect(selectRunPresentation(decided)).toMatchObject(expected)
    const late = events([...CAPTURED_FLOW, { type: 'agent_message', phase: 'replaying', message: SCAN_MARKER }], CAPTURED_RUN_ID).slice(8)
    let state = decided
    for (const action of eventActions(late, CAPTURED_RUN_ID)) {
      state = reduce([action], state)
      expect(selectRunPresentation(state)).toMatchObject(expected)
    }
    expect(selectRunPresentation(reduce([{ type: 'stream/disconnected', runId: CAPTURED_RUN_ID }], decided))).toMatchObject(expected)
    expect(selectRunPresentation(reduce([{ type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }], decided))).toMatchObject(expected)

    // Legacy: a result bound mid-run stays final through the integrity gate and the final event.
    const early = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 4), LEGACY_RUN_ID), LEGACY_RUN_ID), legacyResult(VERIFIED)])
    const lateLegacy = reduce(eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID).slice(4), LEGACY_RUN_ID), early)
    expect(selectRunPresentation(lateLegacy)).toMatchObject({ execution: 'final', verdict: 'Verified Fix', label: 'Verified Fix', tone: 'success' })
    // Late activity stays inspectable in order; it only cannot change the decided presentation.
    expect(flat(selectRunPresentation(lateLegacy).cards)).toEqual(lateLegacy.run?.activity)
  })

  it('states the session before a run without a verdict, and starting ahead of the previous result', () => {
    expect(selectRunPresentation(initialStudioState)).toMatchObject({ execution: 'loading', verdict: null, runId: null, cards: [] })
    expect(selectRunPresentation(reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }]))).toMatchObject({ mode: 'legacy', execution: 'ready', label: 'Ready', verdict: null })
    expect(selectRunPresentation(reduce([{ type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS }]))).toMatchObject({ mode: 'captured', execution: 'ready', label: 'Ready', verdict: null })
    expect(selectRunPresentation(reduce([{ type: 'catalog/failed', error: { code: 'NETWORK_UNAVAILABLE', message: 'x' } }]))).toMatchObject({ execution: 'unavailable', label: 'Not ready', verdict: null })
    const finished = reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW, LEGACY_RUN_ID), LEGACY_RUN_ID), legacyResult(VERIFIED)])
    const next = selectRunPresentation(reduce([{ type: 'run/requested', requestText: GOAL }], finished))
    expect(next).toMatchObject({ execution: 'starting', label: 'Starting', verdict: null })
    expect(next.cards.some((card) => card.isCurrent)).toBe(false)
    expect(selectRunPresentation(reduce(CAPTURED_RUNNING.slice(0, 2)))).toMatchObject({ execution: 'starting', label: 'Starting', verdict: null, cards: [] })
  })

  it('offers only supported next actions: waiting, closing or relaunching, or a new legacy run; never cancel, retry or resume', () => {
    const states = [
      reduce([{ type: 'catalog/loaded', scenarios: LEGACY_SCENARIOS }]),
      reduce([{ type: 'catalog/loaded', scenarios: CAPTURED_SCENARIOS }]),
      reduce([...LEGACY_RUNNING, ...eventActions(events(LEGACY_FLOW.slice(0, 3), LEGACY_RUN_ID), LEGACY_RUN_ID)]),
      reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 9), CAPTURED_RUN_ID), CAPTURED_RUN_ID)]),
      reduce([...LEGACY_RUNNING, { type: 'stream/disconnected', runId: LEGACY_RUN_ID }]),
      reduce([...CAPTURED_RUNNING, { type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }]),
      reduce([...LEGACY_RUNNING, { type: 'result/failed', runId: LEGACY_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }]),
    ]
    const actions = states.map((state) => selectRunPresentation(state).nextAction)
    for (const action of actions) {
      expect(action).toEqual(expect.any(String))
      expect(action).not.toMatch(/\b(cancel|retry|resume)\b/i)
    }
    expect(actions[2]).toMatch(/Closing Studio interrupts the run/)
    expect(actions[3]).toMatch(/Closing Studio interrupts the verification/)
    expect(actions[4]).toMatch(/launch it again/)
    expect(actions[5]).toMatch(/launch it again/)
    expect(actions[6]).toMatch(/start another run/i)
  })
})

describe('Compact status: the same run presentation outside the collapsed panel', () => {
  it('equals the run presentation at every step of both flows, through results, lost streams and unreadable results', () => {
    const unreadable: StudioAction = { type: 'result/failed', runId: CAPTURED_RUN_ID, error: { code: 'RESULT_INVALID', message: 'x' } }
    const scenarios: Array<{ from: readonly StudioAction[]; list: readonly StudioEvent[]; runId: string; tail: readonly StudioAction[] }> = [
      { from: LEGACY_RUNNING, list: events(LEGACY_FLOW, LEGACY_RUN_ID), runId: LEGACY_RUN_ID, tail: [legacyResult(VERIFIED)] },
      { from: LEGACY_RUNNING, list: events(LEGACY_FLOW.slice(0, 6), LEGACY_RUN_ID), runId: LEGACY_RUN_ID, tail: [{ type: 'stream/disconnected', runId: LEGACY_RUN_ID }, legacyResult(UNVERIFIED)] },
      { from: CAPTURED_RUNNING, list: events(CAPTURED_FLOW, CAPTURED_RUN_ID), runId: CAPTURED_RUN_ID, tail: [capturedResult(INTERRUPTED)] },
      { from: CAPTURED_RUNNING, list: events(CAPTURED_FLOW.slice(0, 9), CAPTURED_RUN_ID), runId: CAPTURED_RUN_ID, tail: [{ type: 'stream/disconnected', runId: CAPTURED_RUN_ID }, unreadable] },
    ]
    for (const { from, list, runId, tail } of scenarios) {
      let state = reduce(from)
      for (const action of [...eventActions(list, runId), ...tail]) {
        state = reduce([action], state)
        const view = selectRunPresentation(state)
        const compact = selectCompactStatus(state)
        expect(compact).toEqual(compactStatusOf(view))
        expect(compact).toEqual({ label: view.label, tone: view.tone, hasResult: view.verdict !== null, activityNotice: view.activityNotice })
        if (view.verdict === null) expect(showsNoVerdict(compact)).toBe(true)
      }
    }
  })

  it('shows Finalizing and no verdict while collapsed during observed finalization and after the final event, then only the bound verdict', () => {
    const ended = reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW, CAPTURED_RUN_ID), CAPTURED_RUN_ID)])
    expect(selectCompactStatus(ended)).toEqual({ label: FINALIZING, tone: 'progress', hasResult: false, activityNotice: null })
    const lost = reduce([{ type: 'stream/disconnected', runId: CAPTURED_RUN_ID }], reduce([...CAPTURED_RUNNING, ...eventActions(events(CAPTURED_FLOW.slice(0, 8), CAPTURED_RUN_ID), CAPTURED_RUN_ID)]))
    expect(selectCompactStatus(lost)).toEqual({ label: FINALIZING, tone: 'progress', hasResult: false, activityNotice: 'Live activity disconnected' })
    expect(selectCompactStatus(reduce([capturedResult(PASSED)], ended))).toEqual({ label: CAPTURED_STATUS_LABELS.passed, tone: 'success', hasResult: true, activityNotice: null })
    expect(selectCompactStatus(reduce([capturedResult({ ...PASSED, run_id: OTHER_RUN_ID })], ended))).toEqual({ label: 'No final status', tone: 'warning', hasResult: false, activityNotice: null })
  })
})
