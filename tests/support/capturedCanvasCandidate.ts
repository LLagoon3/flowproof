import { randomBytes } from 'node:crypto'

import type { CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import { createRuntimeProfileRegistry } from '../../packages/flowproof/src/editing/runtimeProfile.js'
import { startCapturingEditingSession } from '../../packages/flowproof/src/editing/session.js'
import { createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import { file, scratchGit } from './capturedCandidate.js'
import type { StateEntry } from './capturedCandidate.js'
import { FIXTURE_PROFILE_ID, buildFixtureImage, fixtureProfile } from './editingRuntime.js'

// Docker-backed producer of prepared Canvas candidates (specs/004-verify-captured-changes). One
// case of the deterministic editing-agent fixture runs through the existing opt-in capturing
// session against a temporary clone of this repository, so the returned capture result is
// exactly what Spec 003 produces for that edit. The expected versioned effects are written out
// here independently of the agent and derived from the clone's committed baseline. No
// credential, provider, network fetch, or live model is involved. Callers own the fixture image
// lifecycle through `removeFixtureImage()` from `editingRuntime.ts`.

export const CANVAS_CASES = ['canvas-fix', 'canvas-hidden-dependency', 'canvas-build-fail', 'canvas-plausible-wrong', 'canvas-self-certify'] as const
export type CanvasCase = (typeof CANVAS_CASES)[number]

export interface ExpectedEffect {
  /** Repository-relative path; every prepared Canvas path is ASCII. */
  readonly path: string
  readonly operation: 'added' | 'modified' | 'deleted'
  /** The final entry; null for a deletion. */
  readonly entry: StateEntry | null
}

export interface CanvasCandidate {
  readonly result: CapturingEditingSessionResult
  readonly baselineCommit: string
  readonly expected: readonly ExpectedEffect[]
}

const DEMO = 'apps/demo-chart'
const FILTER_MODULE = `${DEMO}/src/filterData.ts`
const BUGGY_FILTER = 'return rows.filter((row) => row.region.includes(region))'
const FILTER_IMPORT = "import type { SalesRow } from './data.js'\n"
const REGION_MATCH_SOURCE =
  '// Exact region matching, so overlapping names such as North and Northeast stay separate.\n' +
  'export function matchesRegion(rowRegion: string, selectedRegion: string): boolean {\n' +
  '  return rowRegion === selectedRegion\n' +
  '}\n'
const REGION_NOTES = 'Region filtering compares names exactly; overlapping names such as North and Northeast stay separate.\n'
const REGION_SWATCH = Buffer.from([0x89, 0x52, 0x47, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x10, 0x80, 0x0a, 0x00])
const SELF_CERTIFIED_SUMMARY = '{"check":"prepared-region-filter","discovered":6,"executed":6,"passed":6,"failed":0}\n'

const replaceOnce = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) throw new Error('The committed baseline differs from the prepared Canvas fixture.')
  return text.replace(from, to)
}

/** The independently expected versioned effects of one case against the committed baseline. */
function expectedEffects(caseName: CanvasCase, baseline: (relative: string) => string): ExpectedEffect[] {
  const filter = baseline(FILTER_MODULE)
  const withHelper = (specifier: string): string =>
    replaceOnce(
      replaceOnce(filter, FILTER_IMPORT, `${FILTER_IMPORT}import { matchesRegion } from '${specifier}'\n`),
      BUGGY_FILTER,
      'return rows.filter((row) => matchesRegion(row.region, region))',
    )
  const modified = (path: string, entry: StateEntry): ExpectedEffect => ({ path, operation: 'modified', entry })
  const added = (path: string, entry: StateEntry): ExpectedEffect => ({ path, operation: 'added', entry })
  switch (caseName) {
    case 'canvas-fix':
      return [
        modified('README.md', file(baseline('README.md'), '100755')),
        added(`${DEMO}/assets/region-swatch.bin`, file(REGION_SWATCH)),
        added(`${DEMO}/src/REGION-MATCHING.md`, file(REGION_NOTES)),
        modified(FILTER_MODULE, file(withHelper('./regionMatch.ts'))),
        added(`${DEMO}/src/regionMatch.ts`, file(REGION_MATCH_SOURCE)),
      ]
    case 'canvas-hidden-dependency':
      // The helper under the ignored `dist/` directory is not a versioned change.
      return [modified(FILTER_MODULE, file(withHelper('./dist/regionMatch.ts')))]
    case 'canvas-build-fail':
      return [modified(FILTER_MODULE, file(replaceOnce(filter, BUGGY_FILTER, 'return rows.filter((row) => row.region === region')))]
    case 'canvas-plausible-wrong':
      return [
        modified(`${DEMO}/src/data.ts`, file(replaceOnce(baseline(`${DEMO}/src/data.ts`), "row('North', 'Q4', 150)", "row('North', 'Q4', 105)"))),
        modified(FILTER_MODULE, file(replaceOnce(filter, BUGGY_FILTER, 'return rows.filter((row) => row.region === region)'))),
      ]
    case 'canvas-self-certify': {
      const manifest = JSON.parse(baseline(`${DEMO}/package.json`)) as { scripts?: Record<string, string> }
      manifest.scripts = { ...manifest.scripts, test: 'node -e "process.exit(0)"' }
      return [
        modified(`${DEMO}/package.json`, file(`${JSON.stringify(manifest, null, 2)}\n`)),
        modified('tests/fixtures/captured-verification/check-filter.mjs', file(`process.stdout.write(${JSON.stringify(SELF_CERTIFIED_SUMMARY)})\n`)),
        modified('tests/fixtures/captured-verification/filter-cases.json', file(`${JSON.stringify({ rows: [], cases: [] })}\n`)),
      ]
    }
  }
}

export interface ProduceCanvasCandidateOptions {
  readonly caseName: CanvasCase
  /** A temporary clone of this repository; never the developer checkout. */
  readonly repositoryRoot: string
  /** Private temporary root for the editing session state. */
  readonly tmpRoot: string
}

/** Runs one prepared case through the real capturing session and returns its capture result. */
export async function produceCanvasCandidate(options: ProduceCanvasCandidateOptions): Promise<CanvasCandidate> {
  const baselineCommit = scratchGit(options.repositoryRoot, ['rev-parse', 'HEAD']).toString('utf8').trim()
  const baseline = (relative: string): string => scratchGit(options.repositoryRoot, ['show', `${baselineCommit}:${relative}`]).toString('utf8')
  const expected = expectedEffects(options.caseName, baseline)
  const imageId = await buildFixtureImage()
  const handle = startCapturingEditingSession(
    {
      repositoryRoot: options.repositoryRoot,
      revision: baselineCommit,
      task: `scenario=${options.caseName} marker=${randomBytes(8).toString('hex')}`,
      runtimeProfileId: FIXTURE_PROFILE_ID,
      declaredProjectCommands: [],
    },
    {
      profiles: createRuntimeProfileRegistry([fixtureProfile(imageId)]),
      workspaces: createWorkspaceManager({ tmpRoot: options.tmpRoot }),
      scanner: createSecretScanner({ markers: ['FPCANVASCANDIDATENEVERPRESENT01'] }),
    },
  )
  return { result: await handle.result, baselineCommit, expected }
}
