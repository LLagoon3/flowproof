import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { EvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import {
  EVIDENCE_TYPES,
  createEvidenceId,
  createEvidenceIdAllocator,
  parseEvidenceId,
  validateCitations,
} from '../../packages/flowproof/src/evidence/ids.js'

const RUN = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const OTHER_RUN = '11111111-2222-4333-8444-555555555555'

const failureBundle = JSON.parse(
  readFileSync(new URL('../fixtures/contracts/evidence-bundle.valid-failure.json', import.meta.url), 'utf8'),
) as EvidenceBundle

describe('createEvidenceId', () => {
  it('builds the ev_<phase>_<type>_<ordinal> form with a three-digit ordinal', () => {
    expect(createEvidenceId('failure', 'dataset', 1)).toBe('ev_failure_dataset_001')
    expect(createEvidenceId('replay', 'chart', 12)).toBe('ev_replay_chart_012')
  })

  it('rejects an ordinal that cannot be represented', () => {
    expect(() => createEvidenceId('failure', 'dataset', 0)).toThrow(/EVIDENCE_ID_ORDINAL_INVALID/)
    expect(() => createEvidenceId('failure', 'dataset', 1000)).toThrow(/EVIDENCE_ID_ORDINAL_INVALID/)
    expect(() => createEvidenceId('failure', 'dataset', 1.5)).toThrow(/EVIDENCE_ID_ORDINAL_INVALID/)
  })
})

describe('parseEvidenceId', () => {
  it('round-trips a well-formed identifier', () => {
    expect(parseEvidenceId('ev_failure_screenshot_003')).toEqual({
      phase: 'failure',
      type: 'screenshot',
      ordinal: 3,
    })
  })

  it('returns null for malformed identifiers', () => {
    const malformed = [
      'ev_failure_dataset_1',
      'ev_failure_dataset',
      'ev_unknown_dataset_001',
      'ev_failure_unknown_001',
      'EV_FAILURE_DATASET_001',
      'ev_failure_dataset_001_extra',
      '',
    ]

    for (const id of malformed) {
      expect(parseEvidenceId(id), id).toBeNull()
    }
  })
})

describe('createEvidenceIdAllocator', () => {
  it('assigns deterministic identifiers in capture order', () => {
    const allocator = createEvidenceIdAllocator(RUN)
    const issued = EVIDENCE_TYPES.map((type) => allocator.allocate('failure', type))

    expect(issued).toEqual([
      'ev_failure_actions_001',
      'ev_failure_dataset_001',
      'ev_failure_chart_001',
      'ev_failure_screenshot_001',
      'ev_failure_console_001',
      'ev_failure_network_001',
      'ev_failure_source_001',
    ])
  })

  it('produces the identical sequence for two allocators of the same run', () => {
    const first = createEvidenceIdAllocator(RUN)
    const second = createEvidenceIdAllocator(RUN)

    expect(EVIDENCE_TYPES.map((type) => first.allocate('failure', type))).toEqual(
      EVIDENCE_TYPES.map((type) => second.allocate('failure', type)),
    )
  })

  it('increments the ordinal for a repeated phase and type', () => {
    const allocator = createEvidenceIdAllocator(RUN)

    expect(allocator.allocate('failure', 'console')).toBe('ev_failure_console_001')
    expect(allocator.allocate('failure', 'console')).toBe('ev_failure_console_002')
    expect(allocator.allocate('replay', 'console')).toBe('ev_replay_console_001')
  })

  it('never reissues an identifier and exposes an immutable issued list', () => {
    const allocator = createEvidenceIdAllocator(RUN)
    allocator.allocate('failure', 'dataset')
    allocator.allocate('failure', 'chart')

    const issued = allocator.issued()
    expect(new Set(issued).size).toBe(issued.length)
    expect(Object.isFrozen(issued)).toBe(true)
    expect(() => (issued as string[]).push('ev_failure_console_001')).toThrow()
    expect(allocator.issued()).toHaveLength(2)
  })

  it('binds allocated identifiers to its own run', () => {
    const allocator = createEvidenceIdAllocator(RUN)
    expect(allocator.runId).toBe(RUN)
    expect(() => createEvidenceIdAllocator('not-a-uuid')).toThrow(/EVIDENCE_RUN_ID_INVALID/)
  })
})

describe('validateCitations', () => {
  const cited = (ids: readonly string[]) => validateCitations({ runId: RUN, failureBundle, citedIds: ids })

  it('accepts citations that exist in the same run failure bundle', () => {
    const result = cited(['ev_failure_dataset_001', 'ev_failure_source_001'])

    expect(result.valid).toBe(true)
    expect(result.rejected).toEqual([])
  })

  it('requires at least one citation', () => {
    const result = cited([])

    expect(result.valid).toBe(false)
    expect(result.rejected.map((entry) => entry.reason)).toContain('CITATION_REQUIRED')
  })

  it('rejects an unknown Evidence ID', () => {
    const result = cited(['ev_failure_dataset_009'])

    expect(result.valid).toBe(false)
    expect(result.rejected).toEqual([
      { id: 'ev_failure_dataset_009', reason: 'CITATION_UNKNOWN_EVIDENCE_ID' },
    ])
  })

  it('rejects a malformed Evidence ID', () => {
    const result = cited(['dataset-1'])

    expect(result.valid).toBe(false)
    expect(result.rejected[0]?.reason).toBe('CITATION_MALFORMED')
  })

  it('rejects a duplicate citation', () => {
    const result = cited(['ev_failure_dataset_001', 'ev_failure_dataset_001'])

    expect(result.valid).toBe(false)
    expect(result.rejected[0]?.reason).toBe('CITATION_DUPLICATE')
  })

  it('rejects a replay-phase citation during diagnosis', () => {
    const result = cited(['ev_replay_dataset_001'])

    expect(result.valid).toBe(false)
    expect(result.rejected[0]?.reason).toBe('CITATION_REPLAY_PHASE')
  })

  it('rejects every citation when the bundle belongs to another run', () => {
    const result = validateCitations({
      runId: OTHER_RUN,
      failureBundle,
      citedIds: ['ev_failure_dataset_001'],
    })

    expect(result.valid).toBe(false)
    expect(result.rejected[0]?.reason).toBe('CITATION_CROSS_RUN')
  })

  it('reports every rejected citation rather than stopping at the first', () => {
    const result = cited(['ev_failure_dataset_009', 'ev_replay_chart_001', 'nope'])

    expect(result.rejected).toHaveLength(3)
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      'CITATION_UNKNOWN_EVIDENCE_ID',
      'CITATION_REPLAY_PHASE',
      'CITATION_MALFORMED',
    ])
  })

  it('refuses a replay bundle as the citation source', () => {
    const replayBundle = { ...failureBundle, phase: 'replay' } as EvidenceBundle

    expect(() => validateCitations({ runId: RUN, failureBundle: replayBundle, citedIds: ['ev_failure_dataset_001'] })).toThrow(
      /CITATION_SOURCE_MUST_BE_FAILURE_BUNDLE/,
    )
  })
})
