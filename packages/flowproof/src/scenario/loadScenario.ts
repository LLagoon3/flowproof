import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { EVIDENCE_PHASES, KEBAB_ID_PATTERN, parseChartSeries, parseOracleDataset, parseScenario } from '../contracts/index.js'
import type {
  ChartSeries,
  ContractIssue,
  EvidencePhase,
  OracleDataset,
  Scenario,
  ScenarioAction,
} from '../contracts/index.js'
import { findRegisteredScenario } from './registry.js'

export type ScenarioLoadErrorCode =
  | 'SCENARIO_OVERRIDE_REJECTED'
  | 'SCENARIO_ID_INVALID'
  | 'SCENARIO_NOT_REGISTERED'
  | 'REPOSITORY_ROOT_INVALID'
  | 'SCENARIO_PATH_UNRESOLVABLE'
  | 'SCENARIO_PATH_OUTSIDE_REPOSITORY'
  | 'SCENARIO_PATH_OVERLAP'
  | 'SCENARIO_SOURCE_OUTSIDE_APP'
  | 'SCENARIO_JSON_INVALID'
  | 'SCENARIO_CONTRACT_INVALID'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'SCENARIO_REGISTRY_MISMATCH'
  | 'SCENARIO_COMMAND_NOT_ALLOWED'
  | 'ORACLE_INVALID'
  | 'PROVIDER_FIXTURE_INVALID'

/** A load failure with a stable code; messages and issues never echo committed values. */
export class ScenarioLoadError extends Error {
  readonly code: ScenarioLoadErrorCode
  readonly issues: readonly ContractIssue[]

  constructor(code: ScenarioLoadErrorCode, message: string, issues: readonly ContractIssue[] = []) {
    super(`${code}: ${message}`)
    this.name = 'ScenarioLoadError'
    this.code = code
    this.issues = issues
  }
}

/** The loader accepts the repository root and nothing else: no scenario field is overridable. */
export interface LoadScenarioOptions {
  readonly repoRoot: string
}

export interface LoadedScenario {
  readonly scenario: Readonly<Scenario>
  readonly title: string
  /** Repository-relative path of the committed scenario file. */
  readonly scenarioPath: string
  readonly oracle: {
    readonly dataset: OracleDataset
    readonly chart: ChartSeries
    readonly datasetSha256: string
    readonly chartSha256: string
  }
  /** Canonical absolute paths, each verified to resolve inside the repository. */
  readonly resolved: {
    readonly repoRoot: string
    readonly scenarioFile: string
    readonly appRoot: string
    readonly permittedSourcePaths: readonly string[]
    readonly datasetPath: string
    readonly chartPath: string
    readonly fixturePath: string | null
  }
  /** Failure reproduction and replay always receive this identical frozen action array. */
  actionsFor(phase: EvidencePhase): readonly ScenarioAction[]
}

/** The committed evaluation fixture of a `provider.mode=fixture` case, as `loadScenario` read it. */
export interface CommittedProviderFixture {
  /** The fixture JSON, deeply frozen; untrusted model output until the candidate guards pass. */
  readonly output: unknown
}

const MAX_COMMITTED_JSON_BYTES = 256 * 1024

// Keyed by the frozen scenario object `loadScenario` returned, so only a scenario loaded from the
// committed registry carries a fixture: a deserialized or forged copy names a fixture path as data
// but can never make the fixture transport read a file.
const committedFixtures = new WeakMap<object, CommittedProviderFixture>()

/** The provider fixture `loadScenario` read for exactly this returned scenario object, or null. */
export function committedProviderFixture(scenario: unknown): CommittedProviderFixture | null {
  return typeof scenario === 'object' && scenario !== null ? (committedFixtures.get(scenario) ?? null) : null
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const isInside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${path.sep}`)

async function resolveInside(repoRoot: string, relative: string, kind: 'file' | 'directory'): Promise<string> {
  const lexical = path.resolve(repoRoot, relative)
  if (!isInside(repoRoot, lexical)) {
    throw new ScenarioLoadError('SCENARIO_PATH_OUTSIDE_REPOSITORY', 'A committed scenario path leaves the repository.')
  }
  let canonical: string
  try {
    canonical = await realpath(lexical)
  } catch {
    throw new ScenarioLoadError('SCENARIO_PATH_UNRESOLVABLE', 'A committed scenario path does not resolve.')
  }
  if (!isInside(repoRoot, canonical)) {
    throw new ScenarioLoadError('SCENARIO_PATH_OUTSIDE_REPOSITORY', 'A committed scenario path resolves outside the repository.')
  }
  const info = await stat(canonical)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new ScenarioLoadError('SCENARIO_PATH_UNRESOLVABLE', `A committed scenario path is not a ${kind}.`)
  }
  return canonical
}

async function readCommittedJson(
  file: string,
  failure: 'SCENARIO_JSON_INVALID' | 'ORACLE_INVALID' | 'PROVIDER_FIXTURE_INVALID',
): Promise<{ json: unknown; sha256: string }> {
  const bytes = await readFile(file)
  if (bytes.length > MAX_COMMITTED_JSON_BYTES) throw new ScenarioLoadError(failure, 'A committed JSON file is too large.')
  try {
    return { json: JSON.parse(bytes.toString('utf8')) as unknown, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    throw new ScenarioLoadError(failure, 'A committed JSON file is not valid JSON.')
  }
}

function assertOptions(options: unknown): string {
  if (typeof options !== 'object' || options === null) {
    throw new ScenarioLoadError('REPOSITORY_ROOT_INVALID', 'The repository root is required.')
  }
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'repoRoot') {
      throw new ScenarioLoadError('SCENARIO_OVERRIDE_REJECTED', 'Scenario loading accepts no overrides.')
    }
  }
  const { repoRoot } = options as { repoRoot?: unknown }
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new ScenarioLoadError('REPOSITORY_ROOT_INVALID', 'The repository root must be an absolute path.')
  }
  return repoRoot
}

/**
 * Loads one committed scenario by its registered identifier. Every path is resolved from the
 * committed file inside the repository, the build command must equal the registered command,
 * and the scenario, oracles, and actions are returned deeply frozen. A fixture-provider case also
 * reads its committed fixture, which `committedProviderFixture` then yields for that scenario only.
 */
export async function loadScenario(scenarioId: string, options: LoadScenarioOptions): Promise<LoadedScenario> {
  const requestedRoot = assertOptions(options)
  if (typeof scenarioId !== 'string' || !KEBAB_ID_PATTERN.test(scenarioId)) {
    throw new ScenarioLoadError('SCENARIO_ID_INVALID', 'Scenario identifiers are kebab-case.')
  }
  const entry = findRegisteredScenario(scenarioId)
  if (entry === null) throw new ScenarioLoadError('SCENARIO_NOT_REGISTERED', 'The scenario is not a committed case.')

  let repoRoot: string
  try {
    repoRoot = await realpath(requestedRoot)
    if (!(await stat(repoRoot)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new ScenarioLoadError('REPOSITORY_ROOT_INVALID', 'The repository root does not resolve to a directory.')
  }

  const scenarioFile = await resolveInside(repoRoot, entry.scenario_path, 'file')
  const { json } = await readCommittedJson(scenarioFile, 'SCENARIO_JSON_INVALID')
  const parsed = parseScenario(json)
  if (!parsed.ok) {
    const code = parsed.error.code === 'SCHEMA_VERSION_UNSUPPORTED' ? 'SCHEMA_VERSION_UNSUPPORTED' : 'SCENARIO_CONTRACT_INVALID'
    throw new ScenarioLoadError(code, 'The committed scenario violates the scenario contract.', parsed.error.issues)
  }
  const scenario = parsed.value
  if (scenario.scenario_id !== entry.scenario_id || scenario.case !== entry.case) {
    throw new ScenarioLoadError('SCENARIO_REGISTRY_MISMATCH', 'The committed scenario disagrees with its registry entry.')
  }
  const command = scenario.app.start_command
  if (command.length !== entry.build_command.length || command.some((token, index) => token !== entry.build_command[index])) {
    throw new ScenarioLoadError('SCENARIO_COMMAND_NOT_ALLOWED', 'The scenario build command is not the registered command.')
  }

  const appRoot = await resolveInside(repoRoot, scenario.app.root, 'directory')
  const permittedSourcePaths: string[] = []
  for (const source of scenario.permitted_source_paths) {
    const canonical = await resolveInside(repoRoot, source, 'file')
    if (!isInside(appRoot, canonical)) {
      throw new ScenarioLoadError('SCENARIO_SOURCE_OUTSIDE_APP', 'A permitted source file is outside the application root.')
    }
    permittedSourcePaths.push(canonical)
  }
  const datasetPath = await resolveInside(repoRoot, scenario.oracle.dataset_path, 'file')
  const chartPath = await resolveInside(repoRoot, scenario.oracle.chart_path, 'file')
  const fixturePath =
    scenario.provider.fixture_path === null ? null : await resolveInside(repoRoot, scenario.provider.fixture_path, 'file')

  // The contract compares committed strings; symlinks are caught here on canonical paths.
  for (const guarded of [datasetPath, chartPath, fixturePath]) {
    if (guarded === null) continue
    for (const source of permittedSourcePaths) {
      if (guarded === source || isInside(guarded, source) || isInside(source, guarded)) {
        throw new ScenarioLoadError('SCENARIO_PATH_OVERLAP', 'An oracle or fixture path overlaps the permitted source boundary.')
      }
    }
  }

  const datasetFile = await readCommittedJson(datasetPath, 'ORACLE_INVALID')
  const dataset = parseOracleDataset(datasetFile.json)
  if (!dataset.ok) throw new ScenarioLoadError('ORACLE_INVALID', 'The dataset oracle is malformed.', dataset.error.issues)
  const chartFile = await readCommittedJson(chartPath, 'ORACLE_INVALID')
  const chart = parseChartSeries(chartFile.json)
  if (!chart.ok) throw new ScenarioLoadError('ORACLE_INVALID', 'The chart-series oracle is malformed.', chart.error.issues)
  // Only JSON is required here: the fixture stays untrusted output for the run's guards to judge.
  const fixtureFile = fixturePath === null ? null : await readCommittedJson(fixturePath, 'PROVIDER_FIXTURE_INVALID')

  const frozenScenario = deepFreeze(scenario)
  if (fixtureFile !== null) committedFixtures.set(frozenScenario, Object.freeze({ output: deepFreeze(fixtureFile.json) }))
  return Object.freeze({
    scenario: frozenScenario,
    title: entry.title,
    scenarioPath: entry.scenario_path,
    oracle: Object.freeze({
      dataset: deepFreeze(dataset.value),
      chart: deepFreeze(chart.value),
      datasetSha256: datasetFile.sha256,
      chartSha256: chartFile.sha256,
    }),
    resolved: Object.freeze({
      repoRoot,
      scenarioFile,
      appRoot,
      permittedSourcePaths: Object.freeze(permittedSourcePaths),
      datasetPath,
      chartPath,
      fixturePath,
    }),
    actionsFor(phase: EvidencePhase): readonly ScenarioAction[] {
      if (!EVIDENCE_PHASES.includes(phase)) throw new TypeError('Unknown evidence phase.')
      return frozenScenario.actions
    },
  })
}
