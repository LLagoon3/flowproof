import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CONTRACT_SCHEMA_VERSION, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import { expectSchemaParity, loadContractSchema } from '../support/schemaParity.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

describe('Scenario contract', () => {
  it.each(['scenario.valid-hero', 'scenario.valid-failure'])(
    'mirrors the committed scenario.schema.json for %s',
    (name) => {
      expect(expectSchemaParity(parseScenario, loadContractSchema('scenario'), fixture(name))).toBeGreaterThan(0)
    },
  )

  it('accepts the committed Hero fixture', () => {
    const result = parseScenario(fixture('scenario.valid-hero'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.scenario_id).toBe('canvas-filter-hero')
    expect(result.value.case).toBe('hero')
    expect(result.value.provider.mode).toBe('meta')
    expect(result.value.timeouts.model_ms).toBe(90_000)
    expect(result.value.permitted_source_paths).toEqual(['apps/demo-chart/src/filterData.ts'])
  })

  it('accepts the committed Failure fixture with a labeled provider fixture', () => {
    const result = parseScenario(fixture('scenario.valid-failure'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.provider.mode).toBe('fixture')
    expect(result.value.provider.fixture_path).not.toBeNull()
    expect(result.value.provider.injected_fault_label).toBeTruthy()
  })

  it('rejects an unsupported schema version with a dedicated code', () => {
    const result = parseScenario(fixture('scenario.invalid-schema-version'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('SCHEMA_VERSION_UNSUPPORTED')
    expect(CONTRACT_SCHEMA_VERSION).toBe('1.0.0')
  })

  it('rejects a Hero case that does not use the live Meta provider', () => {
    const result = parseScenario(fixture('scenario.invalid-hero-fixture-provider'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('provider.mode')
  })

  it('rejects an oracle path that overlaps the permitted source boundary', () => {
    const result = parseScenario(fixture('scenario.invalid-oracle-overlaps-source'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.map((issue) => issue.path)).toContain('oracle.dataset_path')
  })

  it('rejects absolute and parent-escaping repository paths', () => {
    expect(parseScenario(fixture('scenario.invalid-absolute-path')).ok).toBe(false)

    const base = fixture('scenario.valid-hero') as Record<string, unknown>
    const escaping = { ...base, permitted_source_paths: ['../outside/filterData.ts'] }
    expect(parseScenario(escaping).ok).toBe(false)
  })

  it('rejects unknown properties so chat input cannot smuggle configuration', () => {
    const base = fixture('scenario.valid-hero') as Record<string, unknown>
    const result = parseScenario({ ...base, gates: ['always_pass'] })

    expect(result.ok).toBe(false)
  })

  it('requires exactly one permitted source path and one replay action', () => {
    const base = fixture('scenario.valid-hero') as Record<string, unknown>

    expect(parseScenario({ ...base, permitted_source_paths: [] }).ok).toBe(false)
    expect(
      parseScenario({
        ...base,
        permitted_source_paths: ['apps/demo-chart/src/filterData.ts', 'apps/demo-chart/src/main.ts'],
      }).ok,
    ).toBe(false)
    expect(parseScenario({ ...base, actions: [] }).ok).toBe(false)
  })

  it('enforces the fixed device scale factor and bounded timeouts', () => {
    const base = fixture('scenario.valid-hero') as Record<string, { [key: string]: unknown }>
    const app = base['app'] as Record<string, unknown>
    const timeouts = base['timeouts'] as Record<string, unknown>

    expect(
      parseScenario({
        ...base,
        app: { ...app, viewport: { width: 1280, height: 800, device_scale_factor: 2 } },
      }).ok,
    ).toBe(false)
    expect(parseScenario({ ...base, timeouts: { ...timeouts, model_ms: 90_001 } }).ok).toBe(false)
    expect(parseScenario({ ...base, timeouts: { ...timeouts, total_ms: 300_001 } }).ok).toBe(false)
  })

  it('reports only field paths and stable codes, never rejected values', () => {
    const base = fixture('scenario.valid-hero') as Record<string, unknown>
    const result = parseScenario({ ...base, default_request: 'MODEL_API_KEY=seeded-marker-value' , scenario_id: 'Not Kebab Case' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    const serialized = JSON.stringify(result.error)
    expect(serialized).not.toContain('seeded-marker-value')
    expect(serialized).not.toContain('Not Kebab Case')
    expect(result.error.issues.every((issue) => /^[A-Z][A-Z0-9_]*$/.test(issue.code))).toBe(true)
  })
})
