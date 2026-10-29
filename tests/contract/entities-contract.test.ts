import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { RunState } from '../../packages/flowproof/src/contracts/index.js'
import {
  RUN_STATES,
  RUN_TRANSITIONS,
  artifactRootFor,
  isLegalFinalStatus,
  isLegalRunTransition,
  parseCandidateChange,
  parseChatRequest,
  parseRun,
  parseVerificationResult,
  parseWorkspaceSession,
} from '../../packages/flowproof/src/contracts/index.js'

const RUN = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const REQUEST = '69f414d8-aa1e-4b2d-8c60-a5ce21b415cf'
const SESSION = '8d45c8c4-369e-4200-bfed-02eedd4a3489'
const NOW = '2026-10-27T10:00:00.000Z'

const runResult = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>

const VERIFICATION_FIELDS = [
  'status',
  'gates',
  'failed_gate_ids',
  'diagnosis_path',
  'candidate_diff_path',
  'failure_screenshot_path',
  'replay_screenshot_path',
  'total_duration_ms',
] as const

const verification = (name: string): Record<string, unknown> => {
  const result = runResult(name)
  return Object.fromEntries(VERIFICATION_FIELDS.map((field) => [field, result[field]]))
}

const gate = (gateId: string, status: string): Record<string, unknown> => ({
  gate_id: gateId,
  status,
  evidence_ids: [],
  reason_code: status === 'pass' ? 'GATE_PASSED' : 'GATE_CHECK_FAILED',
  message: `Gate ${gateId} reported ${status}.`,
  metrics: {},
})

describe('Workspace Session', () => {
  const ready = {
    session_id: SESSION,
    created_at: NOW,
    scenario_id: null,
    state: 'ready',
    active_run_id: null,
    target_url: 'http://localhost:43119/',
  }

  it('accepts a ready session and a running session with its single active run', () => {
    expect(parseWorkspaceSession(ready).ok).toBe(true)
    expect(parseWorkspaceSession({ ...ready, state: 'running', scenario_id: 'canvas-filter-hero', active_run_id: RUN }).ok).toBe(true)
  })

  it('rejects inconsistent run ownership and non-loopback targets', () => {
    expect(parseWorkspaceSession({ ...ready, active_run_id: RUN }).ok).toBe(false)
    expect(parseWorkspaceSession({ ...ready, state: 'running' }).ok).toBe(false)
    expect(parseWorkspaceSession({ ...ready, target_url: 'http://example.com:43119/' }).ok).toBe(false)
    expect(parseWorkspaceSession({ ...ready, target_url: 'https://localhost:43119/' }).ok).toBe(false)
    expect(parseWorkspaceSession({ ...ready, launch_token: 'secret' }).ok).toBe(false)
  })
})

describe('Chat Request', () => {
  const request = {
    request_id: REQUEST,
    session_id: SESSION,
    run_id: RUN,
    created_at: NOW,
    text: 'Find the incorrect Canvas filtering behavior and verify the fix.',
    scenario_id: 'canvas-filter-hero',
  }

  it('accepts bounded plain-text goals bound to a committed scenario', () => {
    expect(parseChatRequest(request).ok).toBe(true)
  })

  it('rejects markup, empty or oversized text, and configuration fields', () => {
    expect(parseChatRequest({ ...request, text: '<b>fix</b>' }).ok).toBe(false)
    expect(parseChatRequest({ ...request, text: '' }).ok).toBe(false)
    expect(parseChatRequest({ ...request, text: 'x'.repeat(501) }).ok).toBe(false)
    for (const field of ['oracle', 'permitted_source_paths', 'start_command', 'gates', 'provider']) {
      expect(parseChatRequest({ ...request, [field]: 'override' }).ok, field).toBe(false)
    }
  })
})

describe('Verification Result', () => {
  it('accepts the reduced results of both final statuses', () => {
    expect(parseVerificationResult(verification('run-result.valid-verified')).ok).toBe(true)
    expect(parseVerificationResult(verification('run-result.valid-unverified')).ok).toBe(true)
  })

  it('applies the same all-pass reduction rule as the run result', () => {
    expect(parseVerificationResult(verification('run-result.invalid-verified-with-failed-gate')).ok).toBe(false)
    expect(parseVerificationResult({ ...verification('run-result.valid-verified'), status: 'Unverified' }).ok).toBe(false)
    expect(parseVerificationResult({ ...verification('run-result.valid-verified'), model_status: 'Verified Fix' }).ok).toBe(false)
  })
})

describe('Run', () => {
  const run = {
    run_id: RUN,
    scenario_id: 'canvas-filter-hero',
    request_id: REQUEST,
    case: 'hero',
    started_at: NOW,
    completed_at: null,
    original_head: '0123456789abcdef0123456789abcdef01234567',
    original_status_digest: 'a'.repeat(64),
    original_worktree_list_digest: 'b'.repeat(64),
    state: 'diagnosing',
    phase_durations_ms: { capture: 1, model: 0, apply: 0, replay: 0, finalize: 0 },
    artifact_root: `.flowproof/runs/${RUN}/`,
    result: null,
  }

  it('owns exactly one artifact root beneath .flowproof/runs', () => {
    expect(artifactRootFor(RUN)).toBe(`.flowproof/runs/${RUN}/`)
    expect(parseRun(run).ok).toBe(true)
    expect(parseRun({ ...run, artifact_root: '.flowproof/runs/other/' }).ok).toBe(false)
    expect(parseRun({ ...run, artifact_root: 'build/output/' }).ok).toBe(false)
  })

  it('holds a result exactly when finalized', () => {
    const result = verification('run-result.valid-unverified')

    expect(parseRun({ ...run, state: 'finalized', completed_at: NOW, result }).ok).toBe(true)
    expect(parseRun({ ...run, result }).ok).toBe(false)
    expect(parseRun({ ...run, state: 'finalized' }).ok).toBe(false)
  })

  it('walks the ordered lifecycle and finalizes directly from any started state', () => {
    const forward: RunState[] = [...RUN_STATES]
    for (let index = 0; index < forward.length - 1; index += 1) {
      const from = forward[index] as RunState
      const to = forward[index + 1] as RunState
      expect(isLegalRunTransition(from, to), `${from} -> ${to}`).toBe(true)
    }
    for (const from of RUN_STATES.filter((state) => state !== 'initialized' && state !== 'finalized')) {
      expect(isLegalRunTransition(from, 'finalized'), `${from} -> finalized`).toBe(true)
    }
  })

  it('rejects skipped, backward, and post-finalization transitions', () => {
    expect(isLegalRunTransition('reproducing', 'diagnosing')).toBe(false)
    expect(isLegalRunTransition('replaying', 'applying')).toBe(false)
    expect(isLegalRunTransition('initialized', 'finalized')).toBe(false)
    for (const to of RUN_STATES) expect(isLegalRunTransition('finalized', to)).toBe(false)
    expect(RUN_TRANSITIONS.finalized).toEqual([])
    expect(RUN_TRANSITIONS.diagnosing).toEqual(['candidate_validated', 'finalized'])
    expect(Object.isFrozen(RUN_TRANSITIONS)).toBe(true)
  })

  it('permits Verified Fix only when finalizing from replaying', () => {
    expect(isLegalFinalStatus('replaying', 'Verified Fix')).toBe(true)
    for (const from of RUN_STATES.filter((state) => state !== 'replaying')) {
      expect(isLegalFinalStatus(from, 'Verified Fix'), from).toBe(false)
    }
    expect(isLegalFinalStatus('diagnosing', 'Unverified')).toBe(true)
  })
})

describe('Candidate Change', () => {
  const candidate = {
    diagnosis_sha256: 'c'.repeat(64),
    target_paths: ['apps/demo-chart/src/filterData.ts'],
    diff_path: 'candidate/diff.patch',
    diff_sha256: 'd'.repeat(64),
    guard_outcome: gate('patch_scope_valid', 'pass'),
    application_outcome: gate('patch_applied', 'pass'),
    worktree_head: '0123456789abcdef0123456789abcdef01234567',
  }

  it('accepts one validated target with guard and application outcomes', () => {
    expect(parseCandidateChange(candidate).ok).toBe(true)
  })

  it('rejects multiple targets, escaping paths, and mislabeled outcomes', () => {
    expect(
      parseCandidateChange({ ...candidate, target_paths: ['apps/demo-chart/src/filterData.ts', 'apps/demo-chart/src/main.ts'] }).ok,
    ).toBe(false)
    expect(parseCandidateChange({ ...candidate, diff_path: '../diff.patch' }).ok).toBe(false)
    expect(parseCandidateChange({ ...candidate, guard_outcome: gate('dataset_matches', 'pass') }).ok).toBe(false)
    expect(parseCandidateChange({ ...candidate, application_outcome: gate('patch_scope_valid', 'pass') }).ok).toBe(false)
  })
})
