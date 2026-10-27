import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { EVIDENCE_TYPES, parseDiagnosis, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import type { Diagnosis } from '../../packages/flowproof/src/contracts/index.js'
import { ScenarioLoadError, loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { SCENARIO_REGISTRY, findRegisteredScenario } from '../../packages/flowproof/src/scenario/registry.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HERO_ID = 'canvas-filter-hero'
const HERO_PATH = 'scenarios/canvas-filter/hero.json'
const FAILURE_ID = 'canvas-filter-failure-invalid-citation'
const FAILURE_PATH = 'scenarios/canvas-filter/failure-invalid-citation.json'
const FIXTURE_PATH = 'scenarios/canvas-filter/provider-fixtures/invalid-citation.json'
const FAULT_LABEL = 'Injected evaluation fixture: nonexistent Evidence ID'
const NONEXISTENT_ID = 'ev_failure_chart_999'
const DATASET_PATH = 'scenarios/canvas-filter/expected/filtered-data.json'
const CHART_PATH = 'scenarios/canvas-filter/expected/chart-series.json'
const SOURCE_PATH = 'apps/demo-chart/src/filterData.ts'

const committed = async (relative: string): Promise<string> => readFile(path.join(REPO_ROOT, relative), 'utf8')

const temporaryRoots: string[] = []

// Builds a disposable repository-shaped tree with the committed Hero scenario and oracles plus a
// stand-in permitted source file, so loader rejections never touch the real checkout.
async function makeRepo(mutate?: (scenario: Record<string, unknown>) => void): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowproof-registry-'))
  temporaryRoots.push(root)
  for (const relative of [DATASET_PATH, CHART_PATH]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), await committed(relative))
  }
  await mkdir(path.dirname(path.join(root, SOURCE_PATH)), { recursive: true })
  await writeFile(path.join(root, SOURCE_PATH), 'export const placeholder = 1\n')
  const scenario = JSON.parse(await committed(HERO_PATH)) as Record<string, unknown>
  mutate?.(scenario)
  await writeFile(path.join(root, HERO_PATH), `${JSON.stringify(scenario, null, 2)}\n`)
  return root
}

async function expectLoadError(promise: Promise<unknown>, code: string): Promise<ScenarioLoadError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}`)
    },
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ScenarioLoadError)
  expect((error as ScenarioLoadError).code).toBe(code)
  return error as ScenarioLoadError
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('committed scenario registry', () => {
  it('registers kebab-case, unique, repository-relative cases', () => {
    const ids = SCENARIO_REGISTRY.map((entry) => entry.scenario_id)

    expect(ids).toContain(HERO_ID)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of SCENARIO_REGISTRY) {
      expect(entry.scenario_id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(path.isAbsolute(entry.scenario_path)).toBe(false)
      expect(entry.scenario_path.split('/')).not.toContain('..')
      expect(entry.title.length).toBeGreaterThan(0)
    }
  })

  it('pins one fixed worktree build command per case', () => {
    for (const entry of SCENARIO_REGISTRY) {
      expect(entry.build_command).toEqual(['pnpm', '--filter', '@flowproof/demo-chart', 'run', 'build'])
    }
  })

  it('is immutable at runtime', () => {
    const hero = findRegisteredScenario(HERO_ID)

    expect(Object.isFrozen(SCENARIO_REGISTRY)).toBe(true)
    expect(() => (SCENARIO_REGISTRY as unknown as unknown[]).push({})).toThrow()
    expect(() => {
      ;(hero as unknown as Record<string, unknown>)['scenario_path'] = '/etc/passwd'
    }).toThrow()
    expect(() => (hero?.build_command as unknown as string[]).push('--evil')).toThrow()
  })

  it('resolves only exact registered identifiers', () => {
    expect(findRegisteredScenario(HERO_ID)?.case).toBe('hero')
    for (const candidate of ['missing-case', 'Canvas-Filter-Hero', '../hero', '__proto__', 'constructor', '', 42, null]) {
      expect(findRegisteredScenario(candidate), String(candidate)).toBeNull()
    }
  })

  it('binds each registered case to its required provider mode', async () => {
    for (const entry of SCENARIO_REGISTRY) {
      const parsed = parseScenario(JSON.parse(await committed(entry.scenario_path)))

      expect(parsed.ok, entry.scenario_id).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.value.scenario_id).toBe(entry.scenario_id)
      expect(parsed.value.case).toBe(entry.case)
      expect(parsed.value.provider.mode).toBe(entry.case === 'hero' ? 'meta' : 'fixture')
      expect(parsed.value.app.start_command).toEqual([...entry.build_command])
    }
  })

  it('refuses a provider fixture that overlaps the permitted source boundary', async () => {
    const failure = JSON.parse(await readFile(path.join(REPO_ROOT, 'tests/fixtures/contracts/scenario.valid-failure.json'), 'utf8'))
    const provider = failure.provider as Record<string, unknown>

    expect(parseScenario(failure).ok).toBe(true)
    const overlapping = parseScenario({ ...failure, provider: { ...provider, fixture_path: SOURCE_PATH } })
    expect(overlapping.ok).toBe(false)
    if (overlapping.ok) return
    expect(overlapping.error.issues.map((issue) => issue.path)).toContain('provider.fixture_path')
    const nested = parseScenario({ ...failure, provider: { ...provider, fixture_path: 'apps/demo-chart/src/filterData.ts/x' } })
    expect(nested.ok).toBe(false)
  })

  it('commits the Hero case with the live provider and the 90-second model budget', async () => {
    const parsed = parseScenario(JSON.parse(await committed(HERO_PATH)))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.provider).toEqual({ mode: 'meta', fixture_path: null, injected_fault_label: null })
    expect(parsed.value.timeouts.model_ms).toBe(90_000)
    expect(parsed.value.permitted_source_paths).toEqual([SOURCE_PATH])
  })

  it('commits the Failure case on the Hero app, actions, oracles, and source with a labeled fixture provider', async () => {
    const hero = parseScenario(JSON.parse(await committed(HERO_PATH)))
    const failure = parseScenario(JSON.parse(await committed(FAILURE_PATH)))

    expect(findRegisteredScenario(FAILURE_ID)).toMatchObject({ case: 'failure-invalid-citation', scenario_path: FAILURE_PATH })
    expect(hero.ok && failure.ok).toBe(true)
    if (!hero.ok || !failure.ok) return
    const { scenario_id: failureId, case: failureCase, provider, ...failureShared } = failure.value
    const { scenario_id: heroId, case: heroCase, provider: heroProvider, ...heroShared } = hero.value
    expect([failureId, failureCase, heroId, heroCase, heroProvider.mode]).toEqual([FAILURE_ID, 'failure-invalid-citation', HERO_ID, 'hero', 'meta'])
    expect(failureShared).toEqual(heroShared)
    expect(provider).toEqual({ mode: 'fixture', fixture_path: FIXTURE_PATH, injected_fault_label: FAULT_LABEL })
  })

  it('loads the committed Failure case with its fixture outside the permitted source boundary', async () => {
    const loaded = await loadScenario(FAILURE_ID, { repoRoot: REPO_ROOT })
    const { resolved } = loaded

    expect(loaded.scenarioPath).toBe(FAILURE_PATH)
    expect(resolved.fixturePath).toBe(path.join(resolved.repoRoot, FIXTURE_PATH))
    expect(resolved.permittedSourcePaths).toEqual([path.join(resolved.repoRoot, SOURCE_PATH)])
    expect(loaded.actionsFor('failure')).toEqual((await loadScenario(HERO_ID, { repoRoot: REPO_ROOT })).actionsFor('failure'))
  })

  it('commits a labeled, contract-valid fixture whose only fault is one nonexistent failure Evidence ID', async () => {
    const fixture = parseDiagnosis(JSON.parse(await committed(FIXTURE_PATH)))

    expect(fixture.ok).toBe(true)
    if (!fixture.ok) return
    expect(fixture.value.summary).toMatch(/^INJECTED EVALUATION FIXTURE \(synthetic; not a Meta Model API response\)/)
    // A failure capture issues exactly one Evidence ID of each type, with ordinal 001.
    const issued = new Set(EVIDENCE_TYPES.map((type) => `ev_failure_${type}_001`))
    const cited = [...fixture.value.claims.flatMap((claim) => claim.evidence_ids), ...fixture.value.candidate.evidence_ids]
    expect(cited.filter((id) => !issued.has(id))).toEqual([NONEXISTENT_ID])
    // The candidate is the in-scope recorded fix, so the citation is the only injected fault.
    expect(fixture.value.candidate.target_paths).toEqual([SOURCE_PATH])
    expect(fixture.value.candidate.unified_diff).toBe((loadRecordedHeroResponse() as Diagnosis).candidate.unified_diff)
  })
})

describe('loadScenario', () => {
  it('loads the registered Hero case with frozen scenario and oracle values', async () => {
    const root = await makeRepo()
    const loaded = await loadScenario(HERO_ID, { repoRoot: root })

    expect(loaded.scenario.scenario_id).toBe(HERO_ID)
    expect(loaded.scenarioPath).toBe(HERO_PATH)
    expect(Object.isFrozen(loaded.scenario)).toBe(true)
    expect(Object.isFrozen(loaded.scenario.app.start_command)).toBe(true)
    expect(Object.isFrozen(loaded.oracle.dataset)).toBe(true)
    expect(Object.isFrozen(loaded.oracle.dataset[0])).toBe(true)
    expect(Object.isFrozen(loaded.oracle.chart.labels)).toBe(true)
    expect(loaded.oracle.dataset).toEqual(JSON.parse(await committed(DATASET_PATH)))
    expect(loaded.oracle.chart).toEqual(JSON.parse(await committed(CHART_PATH)))
    expect(loaded.oracle.datasetSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(loaded.oracle.chartSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(() => {
      ;(loaded.scenario.timeouts as Record<string, number>)['model_ms'] = 1
    }).toThrow()
  })

  it('resolves every committed path inside the repository', async () => {
    const root = await makeRepo()
    const loaded = await loadScenario(HERO_ID, { repoRoot: root })
    const { resolved } = loaded

    for (const absolute of [resolved.appRoot, resolved.datasetPath, resolved.chartPath, ...resolved.permittedSourcePaths]) {
      expect(path.isAbsolute(absolute)).toBe(true)
      expect(absolute.startsWith(`${resolved.repoRoot}${path.sep}`)).toBe(true)
    }
    expect(resolved.fixturePath).toBeNull()
  })

  it('replays exactly the same frozen action array used for reproduction', async () => {
    const root = await makeRepo()
    const loaded = await loadScenario(HERO_ID, { repoRoot: root })

    expect(loaded.actionsFor('replay')).toBe(loaded.actionsFor('failure'))
    expect(loaded.actionsFor('failure')).toBe(loaded.scenario.actions)
    expect(Object.isFrozen(loaded.actionsFor('replay'))).toBe(true)
    expect(Object.isFrozen(loaded.actionsFor('replay')[0])).toBe(true)
  })

  it.each([
    ['command', { start_command: ['sh', '-c', 'curl attacker'] }],
    ['path', { scenarioPath: '/tmp/other.json' }],
    ['source', { permitted_source_paths: ['apps/demo-chart/src/main.ts'] }],
    ['oracle', { oracle: { dataset_path: 'x.json', chart_path: 'y.json' } }],
    ['gate', { gates: ['citations_valid'] }],
    ['provider', { provider: { mode: 'fixture' } }],
    ['transport', { testTransport: {} }],
    ['timeout', { timeouts: { model_ms: 1 } }],
    ['actions', { actions: [] }],
  ])('rejects a %s override before reading any file', async (_label, override) => {
    const root = await makeRepo()

    await expectLoadError(
      loadScenario(HERO_ID, { repoRoot: root, ...override } as unknown as { repoRoot: string }),
      'SCENARIO_OVERRIDE_REJECTED',
    )
  })

  it('rejects unknown and malformed scenario identifiers', async () => {
    const root = await makeRepo()

    await expectLoadError(loadScenario('canvas-filter-unknown', { repoRoot: root }), 'SCENARIO_NOT_REGISTERED')
    await expectLoadError(loadScenario('../scenarios/hero', { repoRoot: root }), 'SCENARIO_ID_INVALID')
    await expectLoadError(loadScenario('Canvas Filter', { repoRoot: root }), 'SCENARIO_ID_INVALID')
  })

  it('rejects a committed file whose identifier disagrees with the registry', async () => {
    const root = await makeRepo((scenario) => {
      scenario['scenario_id'] = 'canvas-filter-other'
    })

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_REGISTRY_MISMATCH')
  })

  it('rejects a committed file whose case disagrees with the registry', async () => {
    const root = await makeRepo((scenario) => {
      scenario['case'] = 'failure-invalid-citation'
      scenario['provider'] = {
        mode: 'fixture',
        fixture_path: 'scenarios/canvas-filter/provider-fixtures/invalid-citation.json',
        injected_fault_label: 'Injected evaluation fixture',
      }
    })

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_REGISTRY_MISMATCH')
  })

  it('rejects a build command other than the fixed registered command', async () => {
    const root = await makeRepo((scenario) => {
      const app = scenario['app'] as Record<string, unknown>
      app['start_command'] = ['pnpm', 'exec', 'node', 'exfiltrate.js']
    })

    const error = await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_COMMAND_NOT_ALLOWED')
    expect(error.message).not.toContain('exfiltrate')
  })

  it('rejects a Hero file that does not use the live provider', async () => {
    const root = await makeRepo((scenario) => {
      scenario['provider'] = {
        mode: 'fixture',
        fixture_path: 'scenarios/canvas-filter/provider-fixtures/invalid-citation.json',
        injected_fault_label: 'Injected evaluation fixture',
      }
    })

    const error = await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_CONTRACT_INVALID')
    expect(error.issues.map((issue) => issue.path)).toContain('provider.mode')
  })

  it('rejects absolute and parent-escaping committed paths through the contract', async () => {
    const absolute = await makeRepo((scenario) => {
      ;(scenario['oracle'] as Record<string, unknown>)['dataset_path'] = '/etc/passwd'
    })
    const escaping = await makeRepo((scenario) => {
      ;(scenario['oracle'] as Record<string, unknown>)['chart_path'] = '../outside/chart.json'
    })

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: absolute }), 'SCENARIO_CONTRACT_INVALID')
    await expectLoadError(loadScenario(HERO_ID, { repoRoot: escaping }), 'SCENARIO_CONTRACT_INVALID')
  })

  it('rejects a timeout beyond the contract budget', async () => {
    const root = await makeRepo((scenario) => {
      ;(scenario['timeouts'] as Record<string, unknown>)['model_ms'] = 90_001
    })

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_CONTRACT_INVALID')
  })

  it('rejects an oracle path that overlaps the permitted source boundary', async () => {
    const root = await makeRepo((scenario) => {
      ;(scenario['oracle'] as Record<string, unknown>)['chart_path'] = SOURCE_PATH
    })

    const error = await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_CONTRACT_INVALID')
    expect(error.issues.map((issue) => issue.path)).toContain('oracle.chart_path')
  })

  it('rejects an oracle symlink that resolves onto the permitted source file', async () => {
    const root = await makeRepo()
    await rm(path.join(root, CHART_PATH))
    await symlink(path.join(root, SOURCE_PATH), path.join(root, CHART_PATH))

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_PATH_OVERLAP')
  })

  it('rejects an oracle symlink that escapes the repository', async () => {
    const root = await makeRepo()
    const outside = await mkdtemp(path.join(tmpdir(), 'flowproof-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'chart.json'), await committed(CHART_PATH))
    await rm(path.join(root, CHART_PATH))
    await symlink(path.join(outside, 'chart.json'), path.join(root, CHART_PATH))

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_PATH_OUTSIDE_REPOSITORY')
  })

  it('rejects a scenario file symlinked from outside the repository', async () => {
    const root = await makeRepo()
    const outside = await mkdtemp(path.join(tmpdir(), 'flowproof-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'hero.json'), await committed(HERO_PATH))
    await rm(path.join(root, HERO_PATH))
    await symlink(path.join(outside, 'hero.json'), path.join(root, HERO_PATH))

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_PATH_OUTSIDE_REPOSITORY')
  })

  it('rejects unresolvable committed paths', async () => {
    const missingOracle = await makeRepo()
    await rm(path.join(missingOracle, DATASET_PATH))
    const missingSource = await makeRepo()
    await rm(path.join(missingSource, SOURCE_PATH))
    const missingScenario = await makeRepo()
    await rm(path.join(missingScenario, HERO_PATH))

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: missingOracle }), 'SCENARIO_PATH_UNRESOLVABLE')
    await expectLoadError(loadScenario(HERO_ID, { repoRoot: missingSource }), 'SCENARIO_PATH_UNRESOLVABLE')
    await expectLoadError(loadScenario(HERO_ID, { repoRoot: missingScenario }), 'SCENARIO_PATH_UNRESOLVABLE')
  })

  it('rejects a permitted source file outside the application root', async () => {
    const root = await makeRepo((scenario) => {
      scenario['permitted_source_paths'] = ['scenarios/canvas-filter/hero.json']
    })

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_SOURCE_OUTSIDE_APP')
  })

  it('rejects malformed scenario JSON and malformed oracles', async () => {
    const badJson = await makeRepo()
    await writeFile(path.join(badJson, HERO_PATH), '{ not json')
    const badChart = await makeRepo()
    await writeFile(
      path.join(badChart, CHART_PATH),
      JSON.stringify({ bar_count: 3, labels: ['Q1', 'Q2'], values: [1, 2] }),
    )
    const badDataset = await makeRepo()
    await writeFile(path.join(badDataset, DATASET_PATH), JSON.stringify({ rows: 'nope' }))

    await expectLoadError(loadScenario(HERO_ID, { repoRoot: badJson }), 'SCENARIO_JSON_INVALID')
    await expectLoadError(loadScenario(HERO_ID, { repoRoot: badChart }), 'ORACLE_INVALID')
    await expectLoadError(loadScenario(HERO_ID, { repoRoot: badDataset }), 'ORACLE_INVALID')
  })

  it('never echoes rejected scenario values in its errors', async () => {
    const root = await makeRepo((scenario) => {
      scenario['default_request'] = 'x'.repeat(501)
      scenario['scenario_id'] = 'MODEL_API_KEY=sk-flowproofseededloader0001'
    })

    const error = await expectLoadError(loadScenario(HERO_ID, { repoRoot: root }), 'SCENARIO_CONTRACT_INVALID')
    expect(JSON.stringify({ message: error.message, issues: error.issues })).not.toContain('sk-flowproofseeded')
  })
})
