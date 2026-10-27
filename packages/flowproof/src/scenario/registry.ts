import { KEBAB_ID_PATTERN } from '../contracts/index.js'
import type { ScenarioCase } from '../contracts/index.js'

// The committed-case registry. The Studio and CLI resolve a scenario only by an exact
// identifier listed here; neither the browser nor chat can supply a scenario file path,
// build command, oracle location, or source allowlist.

export interface RegisteredScenario {
  readonly scenario_id: string
  readonly case: ScenarioCase
  readonly title: string
  /** Repository-relative path of the committed scenario file. */
  readonly scenario_path: string
  /** The only build command the scenario file may declare as `app.start_command`. */
  readonly build_command: readonly string[]
}

const DEMO_BUILD_COMMAND: readonly string[] = Object.freeze(['pnpm', '--filter', '@flowproof/demo-chart', 'run', 'build'])

export const SCENARIO_REGISTRY: readonly RegisteredScenario[] = Object.freeze([
  Object.freeze({
    scenario_id: 'canvas-filter-hero',
    case: 'hero',
    title: 'Verify the Canvas filter fix',
    scenario_path: 'scenarios/canvas-filter/hero.json',
    build_command: DEMO_BUILD_COMMAND,
  } satisfies RegisteredScenario),
])

/** Resolves an exact registered identifier; anything else, including non-strings, is null. */
export function findRegisteredScenario(scenarioId: unknown): RegisteredScenario | null {
  if (typeof scenarioId !== 'string' || !KEBAB_ID_PATTERN.test(scenarioId)) return null
  return SCENARIO_REGISTRY.find((entry) => entry.scenario_id === scenarioId) ?? null
}
