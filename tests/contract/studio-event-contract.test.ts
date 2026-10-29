import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { expectSchemaParity, loadContractSchema } from '../support/schemaParity.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

describe('Studio Event contract', () => {
  it.each(['studio-event.valid-evidence-added', 'studio-event.valid-gate-updated'])(
    'mirrors the committed studio-event.schema.json for %s',
    (name) => {
      expect(expectSchemaParity(parseStudioEvent, loadContractSchema('studio-event'), fixture(name))).toBeGreaterThan(0)
    },
  )

  it('accepts an evidence event that announces an Evidence ID', () => {
    const result = parseStudioEvent(fixture('studio-event.valid-evidence-added'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe('evidence_added')
    expect(result.value.sequence).toBe(7)
    expect(result.value.event_id).toBe(`${result.value.run_id}:7`)
    expect(result.value.gate).toBeNull()
  })

  it('accepts a gate event that carries a gate summary', () => {
    const result = parseStudioEvent(fixture('studio-event.valid-gate-updated'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.gate).toEqual({
      gate_id: 'dataset_matches',
      status: 'pass',
      reason_code: 'DATASET_EXACT_MATCH',
    })
  })

  it('rejects an event_id that does not equal run_id and sequence', () => {
    const result = parseStudioEvent(fixture('studio-event.invalid-event-id-mismatch'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('event_id')
  })

  it('rejects a gate summary on a non-gate event', () => {
    const result = parseStudioEvent(fixture('studio-event.invalid-gate-on-non-gate-event'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('gate')
  })

  it('rejects a gate event without a gate summary', () => {
    const base = fixture('studio-event.valid-gate-updated') as Record<string, unknown>

    expect(parseStudioEvent({ ...base, gate: null }).ok).toBe(false)
  })

  it('rejects an evidence event without Evidence IDs', () => {
    const result = parseStudioEvent(fixture('studio-event.invalid-evidence-added-without-ids'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('evidence_ids')
  })

  it('requires a sequence that starts at one', () => {
    expect(parseStudioEvent(fixture('studio-event.invalid-sequence-zero')).ok).toBe(false)
  })

  it('accepts both failure-phase and replay-phase Evidence IDs', () => {
    const base = fixture('studio-event.valid-evidence-added') as Record<string, unknown>

    expect(parseStudioEvent({ ...base, evidence_ids: ['ev_replay_chart_001'] }).ok).toBe(true)
    expect(parseStudioEvent({ ...base, evidence_ids: ['ev_unknown_chart_001'] }).ok).toBe(false)
  })

  it('rejects unknown event types, unknown phases, and unknown properties', () => {
    const base = fixture('studio-event.valid-evidence-added') as Record<string, unknown>

    expect(parseStudioEvent({ ...base, type: 'model_tool_call' }).ok).toBe(false)
    expect(parseStudioEvent({ ...base, phase: 'patching' }).ok).toBe(false)
    expect(parseStudioEvent({ ...base, raw_model_output: '{}' }).ok).toBe(false)
  })

  it('accepts a null phase and rejects duplicate or escaping artifact references', () => {
    const base = fixture('studio-event.valid-evidence-added') as Record<string, unknown>

    expect(parseStudioEvent({ ...base, phase: null }).ok).toBe(true)
    expect(parseStudioEvent({ ...base, artifact_refs: ['a.json', 'a.json'] }).ok).toBe(false)
    expect(parseStudioEvent({ ...base, artifact_refs: ['../a.json'] }).ok).toBe(false)
    expect(parseStudioEvent({ ...base, artifact_refs: ['/a.json'] }).ok).toBe(false)
  })

  it('bounds the sanitized message length', () => {
    const base = fixture('studio-event.valid-evidence-added') as Record<string, unknown>

    expect(parseStudioEvent({ ...base, message: '' }).ok).toBe(false)
    expect(parseStudioEvent({ ...base, message: 'm'.repeat(501) }).ok).toBe(false)
  })

  it('requires an uppercase stable reason code on a gate summary', () => {
    const base = fixture('studio-event.valid-gate-updated') as Record<string, unknown>

    expect(
      parseStudioEvent({
        ...base,
        gate: { gate_id: 'dataset_matches', status: 'pass', reason_code: 'lower_case' },
      }).ok,
    ).toBe(false)
    expect(
      parseStudioEvent({
        ...base,
        gate: { gate_id: 'not_a_gate', status: 'pass', reason_code: 'OK' },
      }).ok,
    ).toBe(false)
  })
})
