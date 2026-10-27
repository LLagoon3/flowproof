import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseRunResult } from '../../packages/flowproof/src/contracts/index.js'
import { expectSchemaParity, loadContractSchema } from '../support/schemaParity.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

describe('Run Result contract', () => {
  it.each(['run-result.valid-verified', 'run-result.valid-unverified'])(
    'mirrors the committed run-result.schema.json for %s',
    (name) => {
      expect(expectSchemaParity(parseRunResult, loadContractSchema('run-result'), fixture(name))).toBeGreaterThan(0)
    },
  )

  it('accepts an all-pass Verified Fix result', () => {
    const result = parseRunResult(fixture('run-result.valid-verified'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('Verified Fix')
    expect(result.value.gates).toHaveLength(9)
    expect(result.value.failed_gate_ids).toEqual([])
    expect(result.value.provider).toEqual({
      mode: 'meta',
      model: 'muse-spark-1.3',
      injected_fault_label: null,
    })
  })

  it('accepts an Unverified fixture result that omits unreached artifacts', () => {
    const result = parseRunResult(fixture('run-result.valid-unverified'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('Unverified')
    expect(result.value.candidate_diff_path).toBeNull()
    expect(result.value.replay_screenshot_path).toBeNull()
    expect(result.value.failed_gate_ids).toContain('citations_valid')
    expect(result.value.provider.mode).toBe('fixture')
    expect(result.value.provider.model).toBeNull()
    expect(result.value.provider.injected_fault_label).toBeTruthy()
  })

  it('rejects Verified Fix when any gate did not pass', () => {
    const result = parseRunResult(fixture('run-result.invalid-verified-with-failed-gate'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('status')
  })

  it('rejects a result that does not report all nine gates', () => {
    const result = parseRunResult(fixture('run-result.invalid-missing-gate'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('gates')
  })

  it('rejects failed_gate_ids that disagree with the reported gate outcomes', () => {
    const result = parseRunResult(fixture('run-result.invalid-failed-ids-mismatch'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('failed_gate_ids')
  })

  it('rejects a live Meta provider that reports another model', () => {
    const result = parseRunResult(fixture('run-result.invalid-meta-provider-model'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('provider.model')
  })

  it('rejects a duplicated gate outcome', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>
    const gates = base['gates'] as Array<Record<string, unknown>>
    const duplicated = [...gates.slice(0, 8), { ...gates[0] }]

    const result = parseRunResult({ ...base, gates: duplicated })
    expect(result.ok).toBe(false)
  })

  it('requires Verified Fix to reference every produced artifact', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>

    expect(parseRunResult({ ...base, diagnosis_path: null }).ok).toBe(false)
    expect(parseRunResult({ ...base, candidate_diff_path: null }).ok).toBe(false)
    expect(parseRunResult({ ...base, failure_screenshot_path: null }).ok).toBe(false)
    expect(parseRunResult({ ...base, replay_screenshot_path: null }).ok).toBe(false)
  })

  it('requires an Unverified result to name at least one failed or unevaluable gate', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>

    const result = parseRunResult({ ...base, status: 'Unverified' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('failed_gate_ids')
  })

  it('rejects malformed identifiers, digests, and durations', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>

    expect(parseRunResult({ ...base, original_head: 'HEAD' }).ok).toBe(false)
    expect(parseRunResult({ ...base, original_status_digest: 'nope' }).ok).toBe(false)
    expect(parseRunResult({ ...base, run_id: 'not-a-uuid' }).ok).toBe(false)
    expect(parseRunResult({ ...base, total_duration_ms: -1 }).ok).toBe(false)
    expect(parseRunResult({ ...base, total_duration_ms: 1.5 }).ok).toBe(false)
  })

  it('rejects absolute artifact paths and unknown properties', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>

    expect(parseRunResult({ ...base, diagnosis_path: '/tmp/diagnosis.json' }).ok).toBe(false)
    expect(parseRunResult({ ...base, diagnosis_path: '../diagnosis.json' }).ok).toBe(false)
    expect(parseRunResult({ ...base, raw_provider_response: '{}' }).ok).toBe(false)
  })

  it('requires every phase duration to be present', () => {
    const base = fixture('run-result.valid-verified') as Record<string, unknown>

    expect(parseRunResult({ ...base, phase_durations_ms: { capture: 1, model: 1, apply: 1, replay: 1 } }).ok).toBe(
      false,
    )
  })
})
