import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import { GATE_IDS, parseRunResult } from '../../packages/flowproof/src/contracts/index.js'
import type { GateId, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { REPO_ROOT, listTree } from '../support/repoFixture.js'
import { openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T062: a target frame that cannot load the prepared application. A route refuses the Studio
// target iframe's reproduction load, as an unreachable application would. The run then stops
// before model use: no diagnosis call, patch, failure Evidence Bundle, or failure screenshot;
// `failure_reproduced` and `evidence_complete` are unevaluable as TARGET_LOAD_FAILED and every
// dependent gate is never evaluated; the contract-valid `result.json` is the run's only
// artifact; and cleanup removes everything FlowProof owned and restores every original snapshot.

const HERO = 'canvas-filter-hero'
const RUN_BUDGET_MS = 300_000
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
/** The document the Studio's target iframe loads for each reconnection. */
const TARGET_DOCUMENT = scenario.scenario.app.url
const DEPENDENT: readonly GateId[] = ['citations_valid', 'patch_scope_valid', 'patch_applied', 'dataset_matches', 'canvas_matches']

test('a target frame that cannot load the prepared app stops the run before model use', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let finished: { runId: string; result: RunResult } | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness
    let refusedLoads = 0
    await page.route(
      (url) => url.href === TARGET_DOCUMENT,
      async (route) => {
        refusedLoads += 1
        await route.abort('connectionrefused')
      },
    )

    await page.getByRole('button', { name: /^(start|send|run)\b/i }).click()
    finished = await harness.waitForResult(RUN_BUDGET_MS)
    const { runId, result } = finished

    // Only the reproduction tried to load the frame; nothing reached a later phase.
    expect(refusedLoads).toBe(1)
    expect(result.status).toBe('Unverified')
    expect(result.gates.map((gate) => [gate.gate_id, gate.status, gate.reason_code])).toEqual(
      GATE_IDS.map((gateId) => {
        if (gateId === 'failure_reproduced' || gateId === 'evidence_complete') return [gateId, 'unevaluable', 'TARGET_LOAD_FAILED']
        if (gateId === 'secret_scan_clean') return [gateId, 'pass', 'SECRET_SCAN_CLEAN']
        if (gateId === 'original_worktree_unchanged') return [gateId, 'pass', 'ORIGINAL_WORKTREE_UNCHANGED']
        return [gateId, 'unevaluable', 'GATE_NOT_EVALUATED']
      }),
    )
    expect(result.failed_gate_ids).toEqual(['failure_reproduced', 'evidence_complete', ...DEPENDENT])

    // No model call, no patch, and no invented failure bundle or screenshot.
    expect(harness.transport?.calls).toHaveLength(0)
    expect(result).toMatchObject({ diagnosis_path: null, candidate_diff_path: null, failure_screenshot_path: null, replay_screenshot_path: null })
    expect(result.phase_durations_ms).toMatchObject({ model: 0, apply: 0, replay: 0 })
    expect(await listTree(harness.runRoot(runId))).toEqual(['result.json'])
    const persisted = parseRunResult(JSON.parse(await readFile(path.join(harness.runRoot(runId), 'result.json'), 'utf8')))
    expect(persisted.ok && persisted.value).toEqual(result)

    // The agent pane shows the same stopped run without inventing capture, candidate, or replay.
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Unverified', { exact: true })).toBeVisible()
    const gateRows = page.locator('tr.agent-gate')
    await expect(gateRows).toHaveCount(GATE_IDS.length)
    expect(await gateRows.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-gate'), row.getAttribute('data-status')]))).toEqual(
      result.gates.map((gate) => [gate.gate_id, gate.status]),
    )
    await expect(page.locator('.agent-activity__item[data-type="evidence_added"]')).toHaveCount(0)
    await expect(page.locator('.agent-activity__item[data-type="phase_started"]:not([data-phase="reproducing"])')).toHaveCount(0)
    const proofTrail = page.getByRole('region', { name: 'Proof Trail', exact: true })
    await expect(proofTrail).toHaveAttribute('data-run-id', runId)
    await expect(proofTrail.getByRole('region', { name: 'Proof Trail final status' })).toHaveAttribute('data-status', 'unverified')
    const failureEvidence = proofTrail.getByRole('region', { name: 'Failure evidence', exact: true })
    await expect(failureEvidence).toHaveAttribute('data-reached', 'false')
    await expect(failureEvidence.locator('img, li[data-evidence-id]')).toHaveCount(0)
    await expect(proofTrail.getByRole('region', { name: 'Replay evidence', exact: true })).toHaveAttribute('data-reached', 'false')
    await expect(page.getByRole('region', { name: 'Candidate', exact: true }).locator('[data-candidate]')).toHaveAttribute('data-candidate', 'absent')
  } finally {
    cleanup = await harness?.close()
  }

  expect(finished).toBeDefined()
  expect(cleanup).toBeDefined()
  if (!cleanup || !harness) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
})
