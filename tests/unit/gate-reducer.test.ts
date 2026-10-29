import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { GateId, GateOutcome, GateStatus } from '../../packages/flowproof/src/contracts/index.js'
import { GATE_IDS, parseRunResult } from '../../packages/flowproof/src/contracts/index.js'
import {
  GateError,
  failGate,
  passGate,
  reduceGates,
  unevaluableGate,
} from '../../packages/flowproof/src/verify/gates.js'

const REQUIRED: readonly GateId[] = [
  'failure_reproduced',
  'evidence_complete',
  'citations_valid',
  'patch_scope_valid',
  'patch_applied',
  'dataset_matches',
  'canvas_matches',
  'secret_scan_clean',
  'original_worktree_unchanged',
]

const outcome = (gateId: GateId, status: GateStatus): GateOutcome => {
  if (status === 'pass') return passGate(gateId, { evidence_ids: ['ev_failure_dataset_001'] })
  if (status === 'fail') return failGate(gateId, 'GATE_CHECK_FAILED')
  return unevaluableGate(gateId, 'GATE_NOT_EVALUATED')
}

const allPass = (): GateOutcome[] => REQUIRED.map((gateId) => outcome(gateId, 'pass'))

describe('gate outcomes', () => {
  it('declares exactly the nine required gates in canonical order', () => {
    expect([...GATE_IDS]).toEqual(REQUIRED)
  })

  it('builds contract-shaped outcomes with stable reason codes and safe default messages', () => {
    expect(passGate('dataset_matches', { evidence_ids: ['ev_replay_dataset_001'], metrics: { rows: 4 } })).toEqual({
      gate_id: 'dataset_matches',
      status: 'pass',
      evidence_ids: ['ev_replay_dataset_001'],
      reason_code: 'GATE_PASSED',
      message: 'Gate dataset_matches reported pass.',
      metrics: { rows: 4 },
    })
    expect(failGate('canvas_matches', 'CANVAS_VALUE_MISMATCH', { message: 'Bar 2 differs.' })).toMatchObject({
      status: 'fail',
      reason_code: 'CANVAS_VALUE_MISMATCH',
      message: 'Bar 2 differs.',
      evidence_ids: [],
      metrics: {},
    })
    expect(unevaluableGate('patch_applied')).toMatchObject({ status: 'unevaluable', reason_code: 'GATE_NOT_EVALUATED' })
  })

  it('freezes every outcome so later stages cannot rewrite it', () => {
    const gate = passGate('patch_applied')

    expect(Object.isFrozen(gate)).toBe(true)
    expect(Object.isFrozen(gate.evidence_ids)).toBe(true)
    expect(Object.isFrozen(gate.metrics)).toBe(true)
  })

  it('rejects malformed reason codes, Evidence IDs, messages, and metrics', () => {
    const attempts = [
      () => failGate('patch_applied', 'lower_case'),
      () => passGate('patch_applied', { evidence_ids: ['dataset'] }),
      () => passGate('patch_applied', { evidence_ids: ['ev_failure_dataset_001', 'ev_failure_dataset_001'] }),
      () => passGate('patch_applied', { message: '' }),
      () => passGate('patch_applied', { message: 'm'.repeat(501) }),
      () => passGate('patch_applied', { metrics: { nested: { a: 1 } } as never }),
      () => passGate('not_a_gate' as GateId),
    ]

    for (const attempt of attempts) {
      expect(attempt).toThrow(GateError)
      expect(attempt).toThrow(/GATE_OUTCOME_INVALID/)
    }
  })
})

describe('reduceGates', () => {
  it('returns Verified Fix only for all nine gates passing', () => {
    const reduction = reduceGates(allPass())

    expect(reduction.status).toBe('Verified Fix')
    expect(reduction.failed_gate_ids).toEqual([])
    expect(reduction.gates.map((gate) => gate.gate_id)).toEqual(REQUIRED)
  })

  it('proves that every other status combination reduces to Unverified', () => {
    const statuses: readonly GateStatus[] = ['pass', 'fail', 'unevaluable']
    let verified = 0
    let combinations = 0

    for (let code = 0; code < 3 ** REQUIRED.length; code += 1) {
      let remainder = code
      const assigned = REQUIRED.map((gateId) => {
        const status = statuses[remainder % 3] as GateStatus
        remainder = Math.floor(remainder / 3)
        return { gateId, status }
      })
      const reduction = reduceGates(assigned.map(({ gateId, status }) => outcome(gateId, status)))
      const expectedFailed = assigned.filter(({ status }) => status !== 'pass').map(({ gateId }) => gateId)

      combinations += 1
      if (reduction.status === 'Verified Fix') verified += 1
      expect(reduction.failed_gate_ids).toEqual(expectedFailed)
      expect(reduction.status).toBe(expectedFailed.length === 0 ? 'Verified Fix' : 'Unverified')
    }

    expect(combinations).toBe(19_683)
    expect(verified).toBe(1)
  })

  it('reports every missing gate as unevaluable and never passes a partial set', () => {
    for (let mask = 0; mask < 2 ** REQUIRED.length - 1; mask += 1) {
      const present = REQUIRED.filter((_, index) => (mask & (1 << index)) !== 0)
      const reduction = reduceGates(present.map((gateId) => outcome(gateId, 'pass')))
      const missing = REQUIRED.filter((gateId) => !present.includes(gateId))

      expect(reduction.status).toBe('Unverified')
      expect(reduction.gates).toHaveLength(9)
      expect(reduction.failed_gate_ids).toEqual(missing)
      for (const gateId of missing) {
        expect(reduction.gates.find((gate) => gate.gate_id === gateId)).toMatchObject({
          status: 'unevaluable',
          reason_code: 'GATE_NOT_EVALUATED',
        })
      }
    }
  })

  it('treats duplicated outcomes for one gate as unevaluable instead of choosing one', () => {
    const outcomes = [...allPass(), passGate('dataset_matches')]

    const reduction = reduceGates(outcomes)

    expect(reduction.status).toBe('Unverified')
    expect(reduction.failed_gate_ids).toEqual(['dataset_matches'])
    expect(reduction.gates.find((gate) => gate.gate_id === 'dataset_matches')).toMatchObject({
      status: 'unevaluable',
      reason_code: 'GATE_OUTCOME_DUPLICATE',
    })
  })

  it('orders gates canonically regardless of evaluation order', () => {
    const reduction = reduceGates([...allPass()].reverse())

    expect(reduction.gates.map((gate) => gate.gate_id)).toEqual(REQUIRED)
  })

  it('rejects malformed outcomes instead of silently dropping them', () => {
    const malformed = { ...passGate('patch_applied'), status: 'skipped' } as unknown as GateOutcome

    expect(() => reduceGates([...allPass(), malformed])).toThrow(/GATE_OUTCOME_INVALID/)
    expect(() => reduceGates([{ gate_id: 'always_pass' } as unknown as GateOutcome])).toThrow(/GATE_OUTCOME_INVALID/)
  })

  it('returns a frozen reduction', () => {
    const reduction = reduceGates(allPass())

    expect(Object.isFrozen(reduction)).toBe(true)
    expect(Object.isFrozen(reduction.gates)).toBe(true)
    expect(Object.isFrozen(reduction.failed_gate_ids)).toBe(true)
  })

  it('composes into a contract-valid run result for both final statuses', () => {
    const base = JSON.parse(
      readFileSync(new URL('../fixtures/contracts/run-result.valid-unverified.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    const failing = reduceGates(
      REQUIRED.map((gateId) =>
        gateId === 'citations_valid'
          ? failGate(gateId, 'CITATION_UNKNOWN_EVIDENCE_ID')
          : ['failure_reproduced', 'evidence_complete', 'secret_scan_clean', 'original_worktree_unchanged'].includes(gateId)
            ? outcome(gateId, 'pass')
            : unevaluableGate(gateId),
      ),
    )

    const result = parseRunResult({ ...base, status: failing.status, gates: failing.gates, failed_gate_ids: failing.failed_gate_ids })
    expect(result.ok).toBe(true)
  })
})
