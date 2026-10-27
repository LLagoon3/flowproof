import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import { expectSchemaParity, loadContractSchema } from '../support/schemaParity.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

describe('Evidence Bundle contract', () => {
  it.each(['evidence-bundle.valid-failure', 'evidence-bundle.valid-replay'])(
    'mirrors the committed evidence-bundle.schema.json for %s',
    (name) => {
      expect(expectSchemaParity(parseEvidenceBundle, loadContractSchema('evidence-bundle'), fixture(name))).toBeGreaterThan(0)
    },
  )

  it('accepts a failure bundle carrying all seven evidence types', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.valid-failure'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.phase).toBe('failure')
    expect(result.value.items).toHaveLength(7)
    expect(result.value.items.map((item) => item.type).sort()).toEqual([
      'actions',
      'chart',
      'console',
      'dataset',
      'network',
      'screenshot',
      'source',
    ])
  })

  it('accepts a replay bundle without source evidence', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.valid-replay'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toHaveLength(6)
    expect(result.value.items.some((item) => item.type === 'source')).toBe(false)
  })

  it('rejects a failure bundle that omits the required source evidence', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.invalid-failure-missing-source'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('items')
  })

  it('rejects an item whose run differs from the owning bundle', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.invalid-cross-run-item'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('items.0.run_id')
  })

  it('rejects an item whose phase differs from the owning bundle', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.invalid-phase-mismatch'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('items.1.phase')
  })

  it('rejects duplicate Evidence IDs inside one bundle', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.invalid-duplicate-evidence-id'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('items.1.evidence_id')
  })

  it('rejects an Evidence ID whose phase and type segments contradict the item', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.invalid-id-type-mismatch'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('items.1.evidence_id')
  })

  it('rejects malformed digests, paths, and redaction records', () => {
    const base = fixture('evidence-bundle.valid-failure') as Record<string, unknown>
    const items = base['items'] as Array<Record<string, unknown>>
    const mutate = (patch: Record<string, unknown>): unknown => ({
      ...base,
      items: items.map((item, index) => (index === 0 ? { ...item, ...patch } : item)),
    })

    expect(parseEvidenceBundle(mutate({ sha256: 'NOTAHASH' })).ok).toBe(false)
    expect(parseEvidenceBundle(mutate({ artifact_path: '/absolute/path.json' })).ok).toBe(false)
    expect(parseEvidenceBundle(mutate({ artifact_path: '../escape.json' })).ok).toBe(false)
    expect(parseEvidenceBundle(mutate({ redactions: [{ category: 'unknown', count: 1 }] })).ok).toBe(false)
    expect(parseEvidenceBundle(mutate({ redactions: [{ category: 'cookie', count: 0 }] })).ok).toBe(false)
    expect(parseEvidenceBundle({ ...base, manifest_sha256: 'short' }).ok).toBe(false)
  })

  it('requires network evidence to stay metadata-only through declared redactions', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.valid-failure'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const network = result.value.items.find((item) => item.type === 'network')
    expect(network?.redactions.map((redaction) => redaction.category)).toContain('query')
  })

  it('records trusted repository provenance only for source evidence', () => {
    const result = parseEvidenceBundle(fixture('evidence-bundle.valid-failure'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const item of result.value.items) {
      if (item.type === 'source') {
        expect(item.provenance.origin).toBe('repository')
        expect(item.provenance.source_path).toBe('apps/demo-chart/src/filterData.ts')
      } else {
        expect(item.provenance.origin).toBe('browser')
        expect(item.provenance.source_path).toBeNull()
      }
    }
  })
})
