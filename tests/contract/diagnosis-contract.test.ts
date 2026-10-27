import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseDiagnosis } from '../../packages/flowproof/src/contracts/index.js'
import { expectSchemaParity, loadContractSchema } from '../support/schemaParity.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

describe('Diagnosis contract', () => {
  it.each(['diagnosis.valid'])(
    'mirrors the committed diagnosis.schema.json for %s',
    (name) => {
      expect(expectSchemaParity(parseDiagnosis, loadContractSchema('diagnosis'), fixture(name))).toBeGreaterThan(0)
    },
  )

  it('accepts a schema-valid evidence-cited diagnosis', () => {
    const result = parseDiagnosis(fixture('diagnosis.valid'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.claims).toHaveLength(2)
    expect(result.value.candidate.target_paths).toEqual(['apps/demo-chart/src/filterData.ts'])
    expect(result.value.candidate.unified_diff.startsWith('diff --git a/')).toBe(true)
  })

  it('rejects citations that reference the replay phase', () => {
    const result = parseDiagnosis(fixture('diagnosis.invalid-replay-citation'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('claims.0.evidence_ids.0')
  })

  it('rejects a candidate that targets more than one file', () => {
    const result = parseDiagnosis(fixture('diagnosis.invalid-multi-target'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('candidate.target_paths')
  })

  it('rejects a diff that is not a unified git diff', () => {
    expect(parseDiagnosis(fixture('diagnosis.invalid-diff-prefix')).ok).toBe(false)
  })

  it('requires at least one claim', () => {
    expect(parseDiagnosis(fixture('diagnosis.invalid-empty-claims')).ok).toBe(false)
  })

  it('rejects unknown properties so the model cannot add its own fields', () => {
    const base = fixture('diagnosis.valid') as Record<string, unknown>

    expect(parseDiagnosis({ ...base, status: 'Verified Fix' }).ok).toBe(false)
    expect(parseDiagnosis({ ...base, gates: [] }).ok).toBe(false)
  })

  it('rejects absolute, parent-escaping, and oversized candidate content', () => {
    const base = fixture('diagnosis.valid') as Record<string, unknown>
    const candidate = base['candidate'] as Record<string, unknown>

    expect(parseDiagnosis({ ...base, candidate: { ...candidate, target_paths: ['/etc/passwd'] } }).ok).toBe(false)
    expect(
      parseDiagnosis({ ...base, candidate: { ...candidate, target_paths: ['../../etc/passwd'] } }).ok,
    ).toBe(false)
    expect(
      parseDiagnosis({
        ...base,
        candidate: { ...candidate, unified_diff: `diff --git a/x${'x'.repeat(20_001)}` },
      }).ok,
    ).toBe(false)
  })

  it('rejects duplicate and malformed Evidence IDs', () => {
    const base = fixture('diagnosis.valid') as Record<string, unknown>
    const candidate = base['candidate'] as Record<string, unknown>

    expect(
      parseDiagnosis({
        ...base,
        candidate: { ...candidate, evidence_ids: ['ev_failure_dataset_001', 'ev_failure_dataset_001'] },
      }).ok,
    ).toBe(false)
    expect(
      parseDiagnosis({ ...base, candidate: { ...candidate, evidence_ids: ['ev_failure_dataset_1'] } }).ok,
    ).toBe(false)
    expect(
      parseDiagnosis({ ...base, candidate: { ...candidate, evidence_ids: ['dataset'] } }).ok,
    ).toBe(false)
  })

  it('never echoes rejected model text in the contract error', () => {
    const base = fixture('diagnosis.valid') as Record<string, unknown>
    const result = parseDiagnosis({ ...base, summary: '' , root_cause: 'FLOWPROOF_SEEDED_SECRET_A' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(JSON.stringify(result.error)).not.toContain('FLOWPROOF_SEEDED_SECRET_A')
  })
})
