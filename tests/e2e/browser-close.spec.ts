import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { GATE_IDS } from '../../packages/flowproof/src/contracts/index.js'
import type { GateId, GateOutcome, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadCliLifecycle, superviseExitCode } from '../support/cliLifecycle.js'
import { createHeldTransport } from '../support/recordedTransport.js'
import { REPO_ROOT, git, listTree } from '../support/repoFixture.js'
import { openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T061: browser/page-close and interrupt lifecycle in the headed Studio. Closing the Studio page
// while the run is reproducing, diagnosing, or replaying, and a SIGINT to the `flowproof studio`
// lifecycle while the run is applying, each stop the visible run. It finalizes `Unverified` with
// the interrupted stage's gate failed or unevaluable as RUN_INTERRUPTED and every later gate never
// evaluated, keeps only the artifacts of the phases it reached, removes and prunes only
// FlowProof's own worktree, restores every original snapshot, and the CLI lifecycle exits `2`.
// Each stage is held at a deterministic point: a route that never answers holds the target
// frame's reproduction or replay load, and a test transport that never answers holds the
// diagnosis. A refused live event stream alone never cancels the run.

const HERO = 'canvas-filter-hero'
const SOURCE = 'apps/demo-chart/src/filterData.ts'
const RUN_BUDGET_MS = 300_000
const NOT_EVALUATED = 'GATE_NOT_EVALUATED'
const INTERRUPTED = 'RUN_INTERRUPTED'
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
/** The document the Studio's target iframe loads for each reconnection. */
const TARGET_DOCUMENT = scenario.scenario.app.url
const FAILURE_TREE = [
  'evidence',
  'evidence/failure',
  ...['actions.json', 'chart.json', 'console.json', 'dataset.json', 'manifest.json', 'network.json', 'screenshot.png', 'source.json'].map(
    (file) => `evidence/failure/${file}`,
  ),
]
const CANDIDATE_TREE = ['candidate', 'candidate/candidate.diff', 'diagnosis', 'diagnosis/diagnosis.json']

type GateRow = readonly [GateId, GateOutcome['status'], string | null]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const startRun = (page: Page): Promise<void> => page.getByRole('button', { name: /^(start|send|run)\b/i }).click()

/**
 * Lets the first `allowed` target-frame loads through and holds the next one without ever
 * answering it, so the run waits in that reconnection; `held` resolves once a load is held.
 */
async function holdTargetLoad(page: Page, allowed: number): Promise<{ readonly held: Promise<void> }> {
  let seen = 0
  let markHeld: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    markHeld = resolve
  })
  await page.route(
    (url) => url.href === TARGET_DOCUMENT,
    async (route) => {
      seen += 1
      if (seen <= allowed) {
        await route.continue()
        return
      }
      markHeld()
    },
  )
  return { held }
}

const runsDir = (harness: StudioHarness): string => path.join(harness.repoRoot, '.flowproof', 'runs')

/** Polls every 10 ms for a file of the one run and returns that run's ID as soon as it exists. */
async function waitForRunFile(harness: StudioHarness, relative: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const runs = existsSync(runsDir(harness)) ? readdirSync(runsDir(harness)) : []
    const runId = runs.find((candidate) => existsSync(path.join(runsDir(harness), candidate, relative)))
    if (runId !== undefined) return runId
    if (Date.now() > deadline) throw new Error(`The run did not write ${relative} in time.`)
    await sleep(10)
  }
}

/**
 * The nine outcomes of an interrupted run: the gates passed before the interruption, the stopped
 * stage's outcomes, every later gate never evaluated, and the secret-scan and integrity gates
 * still evaluated by the finalization the interruption triggered.
 */
function interruptedGates(passed: readonly GateId[], stopped: readonly GateRow[]): GateRow[] {
  return GATE_IDS.map((gateId): GateRow => {
    if (gateId === 'secret_scan_clean') return [gateId, 'pass', 'SECRET_SCAN_CLEAN']
    if (gateId === 'original_worktree_unchanged') return [gateId, 'pass', 'ORIGINAL_WORKTREE_UNCHANGED']
    if (passed.includes(gateId)) return [gateId, 'pass', null]
    return stopped.find(([stoppedId]) => stoppedId === gateId) ?? [gateId, 'unevaluable', NOT_EVALUATED]
  })
}

/** An authoritative Unverified result with exactly these outcomes and only the reached phases' artifacts. */
async function expectInterruptedRun(harness: StudioHarness, runId: string, result: RunResult, gates: readonly GateRow[], tree: readonly string[]): Promise<void> {
  expect(result.status).toBe('Unverified')
  expect(result.gates.map((gate) => [gate.gate_id, gate.status, gate.reason_code])).toEqual(
    gates.map(([gateId, status, reason]) => [gateId, status, reason ?? expect.any(String)]),
  )
  expect(result.failed_gate_ids).toEqual(gates.filter(([, status]) => status !== 'pass').map(([gateId]) => gateId))
  // Stage-aware: nothing exists for a phase the run never reached.
  expect(await listTree(harness.runRoot(runId))).toEqual([...tree, 'result.json'].sort())
}

/** Nothing FlowProof owned remains, and every original snapshot, including the worktree list, is restored. */
function expectRestored(harness: StudioHarness, cleanup: CleanupReport | undefined): void {
  expect(cleanup).toBeDefined()
  if (!cleanup) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
}

test('closing the Studio page while reproducing finalizes Unverified before failure capture', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    const reproduction = await holdTargetLoad(page, 0)
    const exit = superviseExitCode(harness.studio)

    await startRun(page)
    await reproduction.held
    await page.close()
    const { runId, result } = await harness.waitForResult(RUN_BUDGET_MS)

    await expectInterruptedRun(
      harness,
      runId,
      result,
      interruptedGates(
        [],
        [
          ['failure_reproduced', 'unevaluable', INTERRUPTED],
          ['evidence_complete', 'fail', 'FAILURE_EVIDENCE_INCOMPLETE'],
        ],
      ),
      [],
    )
    // Closed before failure capture: no bundle or screenshot is invented and the model never ran.
    expect(result).toMatchObject({ diagnosis_path: null, candidate_diff_path: null, failure_screenshot_path: null, replay_screenshot_path: null })
    expect(result.phase_durations_ms).toMatchObject({ model: 0, apply: 0, replay: 0 })
    expect(harness.transport?.calls).toHaveLength(0)
    expect(await exit).toBe(2)
  } finally {
    cleanup = await harness?.close()
  }
  if (harness) expectRestored(harness, cleanup)
})

test('closing the Studio page while diagnosing cancels the model call, and a refused event stream alone does not', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  const transport = createHeldTransport()
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO, testTransport: transport })
    const { page } = harness
    // The live activity stream is refused for the whole run.
    await page.route('**/api/runs/*/events', (route) => route.abort())
    const exit = superviseExitCode(harness.studio)

    await startRun(page)
    await transport.held
    // Without a live stream the run still reproduced and reached the model, and it keeps waiting.
    await expect(page.locator('[data-stream]')).toHaveAttribute('data-stream', 'disconnected')
    await sleep(1_000)
    expect(transport.cancelled()).toBe(false)
    const activeRun = await waitForRunFile(harness, 'evidence/failure/manifest.json', 1_000)
    expect(existsSync(path.join(harness.runRoot(activeRun), 'result.json'))).toBe(false)

    await page.close()
    const { runId, result } = await harness.waitForResult(RUN_BUDGET_MS)

    expect(runId).toBe(activeRun)
    expect(transport.cancelled()).toBe(true)
    expect(transport.calls).toHaveLength(1)
    await expectInterruptedRun(
      harness,
      runId,
      result,
      interruptedGates(['failure_reproduced', 'evidence_complete'], [['citations_valid', 'unevaluable', INTERRUPTED]]),
      FAILURE_TREE,
    )
    expect(result.failure_screenshot_path).toBe('evidence/failure/screenshot.png')
    expect(result).toMatchObject({ diagnosis_path: null, candidate_diff_path: null, replay_screenshot_path: null })
    expect(result.phase_durations_ms).toMatchObject({ apply: 0, replay: 0 })
    expect(await exit).toBe(2)
  } finally {
    cleanup = await harness?.close()
  }
  if (harness) expectRestored(harness, cleanup)
})

test('closing the Studio page while replaying finalizes Unverified without replay evidence', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  const sourceBefore = git(REPO_ROOT, 'show', `HEAD:${SOURCE}`)
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    // The reproduction load passes; the replay's reconnection to the patched build is held.
    const replay = await holdTargetLoad(page, 1)
    const exit = superviseExitCode(harness.studio)

    await startRun(page)
    await replay.held
    await page.close()
    const { runId, result } = await harness.waitForResult(RUN_BUDGET_MS)

    expect(harness.transport?.calls).toHaveLength(1)
    await expectInterruptedRun(
      harness,
      runId,
      result,
      interruptedGates(
        ['failure_reproduced', 'evidence_complete', 'citations_valid', 'patch_scope_valid', 'patch_applied'],
        [
          ['dataset_matches', 'unevaluable', INTERRUPTED],
          ['canvas_matches', 'unevaluable', INTERRUPTED],
        ],
      ),
      [...FAILURE_TREE, ...CANDIDATE_TREE],
    )
    expect(result).toMatchObject({
      diagnosis_path: 'diagnosis/diagnosis.json',
      candidate_diff_path: 'candidate/candidate.diff',
      failure_screenshot_path: 'evidence/failure/screenshot.png',
      replay_screenshot_path: null,
    })
    // The candidate was applied only in the removed worktree.
    expect(await readFile(path.join(harness.repoRoot, SOURCE), 'utf8')).toBe(sourceBefore)
    expect(await exit).toBe(2)
  } finally {
    cleanup = await harness?.close()
  }
  if (harness) expectRestored(harness, cleanup)
})

test('SIGINT to the flowproof studio lifecycle while applying exits 2 and prunes only the FlowProof worktree', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  const sourceBefore = git(REPO_ROOT, 'show', `HEAD:${SOURCE}`)
  const unrelated = 'unrelated-worktree'
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  try {
    // A pre-existing unrelated worktree must stay registered through the interrupt.
    harness = await openStudioHarness({
      scenarioId: HERO,
      prepareClone: (repoRoot) => {
        git(repoRoot, 'worktree', 'add', '--detach', '--quiet', path.join(path.dirname(repoRoot), unrelated), 'HEAD')
      },
    })
    expect(harness.baseline.worktreeAdminEntries).toEqual([unrelated])
    const cli = await loadCliLifecycle()
    const signals = cli.watchShutdownSignals()
    try {
      const exit = cli.superviseStudio(harness.studio, signals)
      await startRun(harness.page)
      // The run persists the validated diff and enters `applying` in the same turn, so the
      // interrupt arrives while the candidate is applied and the patched app rebuilds.
      await waitForRunFile(harness, 'candidate/candidate.diff', RUN_BUDGET_MS)
      process.kill(process.pid, 'SIGINT')
      expect(await exit).toBe(2)
    } finally {
      signals.dispose()
    }
    const { runId, result } = await harness.waitForResult(RUN_BUDGET_MS)

    await expectInterruptedRun(
      harness,
      runId,
      result,
      interruptedGates(['failure_reproduced', 'evidence_complete', 'citations_valid', 'patch_scope_valid'], [['patch_applied', 'fail', INTERRUPTED]]),
      [...FAILURE_TREE, ...CANDIDATE_TREE],
    )
    expect(result.replay_screenshot_path).toBeNull()
    expect(result.phase_durations_ms.replay).toBe(0)
    expect(await readFile(path.join(harness.repoRoot, SOURCE), 'utf8')).toBe(sourceBefore)
  } finally {
    cleanup = await harness?.close()
  }
  if (!harness) return
  expectRestored(harness, cleanup)
  expect(cleanup?.snapshot.worktreeList).toContain(path.join(path.dirname(harness.repoRoot), unrelated))
})
