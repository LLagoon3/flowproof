import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import { GATE_IDS, META_MODEL_ID, parseDiagnosis, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'
import { DEMO_PORT, openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T034: the headed recorded-Hero skeleton. One real Studio run crosses every runtime layer
// with the committed `provider.mode=meta` Hero scenario, a recorded diagnosis injected only
// through the in-process `startStudio({ testTransport })` entry, and MODEL_API_KEY unset:
// visible reproduction, recorded diagnosis, validated one-file diff, isolated apply, patched
// rebuild, iframe reconnection, identical replay, dataset and Canvas oracles, nine passing
// gates, `Verified Fix`, cleanup, and unchanged pre-run snapshots. T049 makes it pass; T053
// completes the Proof Trail and timing assertions.

const HERO = 'canvas-filter-hero'
const SOURCE = 'apps/demo-chart/src/filterData.ts'
const RUN_BUDGET_MS = 300_000
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
const recorded = parseDiagnosis(loadRecordedHeroResponse())
if (!recorded.ok) throw new Error('The recorded Hero response is not a valid diagnosis.')

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function bundleAt(harness: StudioHarness, runId: string, phase: 'failure' | 'replay'): Promise<EvidenceBundle> {
  const parsed = parseEvidenceBundle(await harness.readJson(runId, `evidence/${phase}/manifest.json`))
  if (!parsed.ok) throw new Error(`The ${phase} manifest violates the evidence-bundle contract.`)
  expect(parsed.value.run_id).toBe(runId)
  return parsed.value
}

async function evidence(harness: StudioHarness, runId: string, bundle: EvidenceBundle, type: string): Promise<Record<string, unknown>> {
  const item = bundle.items.find((candidate) => candidate.type === type)
  if (!item) throw new Error(`The ${bundle.phase} bundle has no ${type} evidence.`)
  return (await harness.readJson(runId, item.artifact_path)) as Record<string, unknown>
}

test('the recorded Hero run closes the loop to Verified Fix in the headed Studio', async () => {
  test.setTimeout(RUN_BUDGET_MS + 180_000)
  const sourceBefore = git(REPO_ROOT, 'show', `HEAD:${SOURCE}`)
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let finished: { runId: string; result: RunResult } | undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO })
    const { page } = harness

    // One Studio page: the prepared app framed on the left, the agent pane with chat on the right.
    const target = page.locator('iframe')
    await expect(target).toHaveCount(1)
    await expect(target).toHaveAttribute('src', new RegExp(`^http://localhost:${DEMO_PORT}/`))
    const chat = page.getByLabel(/request/i)
    await expect(chat).toHaveValue(scenario.scenario.default_request)
    const navigationsBeforeRun = harness.targetNavigations()

    // Start through chat without entering paths, oracles, commands, or gates.
    await page.getByRole('button', { name: /^(start|send|run)\b/i }).click()
    finished = await harness.waitForResult(RUN_BUDGET_MS)
    const { runId, result } = finished

    // The authoritative result: nine passing gates and Verified Fix inside the budget.
    expect(result.status).toBe('Verified Fix')
    expect(result.gates.map((gate) => [gate.gate_id, gate.status])).toEqual(GATE_IDS.map((gateId) => [gateId, 'pass']))
    expect(result.failed_gate_ids).toEqual([])
    expect(result.provider).toEqual({ mode: 'meta', model: META_MODEL_ID, injected_fault_label: null })
    expect(result.total_duration_ms).toBeLessThan(RUN_BUDGET_MS)
    await expect(page.getByText('Verified Fix', { exact: true })).toBeVisible()

    // Exactly one recorded diagnosis; no live Meta or other external request.
    expect(harness.transport.calls).toHaveLength(1)
    expect(harness.blockedRequests).toEqual([])

    // The validated one-file candidate is the recorded diff for the permitted file only.
    const diff = await readFile(path.join(harness.runRoot(runId), result.candidate_diff_path ?? ''), 'utf8')
    expect(diff).toBe(recorded.value.candidate.unified_diff)
    expect(diff.match(/^diff --git /gm)).toHaveLength(1)
    expect(diff).toContain(`diff --git a/${SOURCE} b/${SOURCE}\n`)

    // Visible reproduction of the defect, then a patched rebuild replayed with identical actions.
    const failure = await bundleAt(harness, runId, 'failure')
    const replay = await bundleAt(harness, runId, 'replay')
    expect(failure.items).toHaveLength(7)
    expect(replay.items).toHaveLength(6)
    expect(await evidence(harness, runId, replay, 'actions')).toEqual(await evidence(harness, runId, failure, 'actions'))
    expect((await evidence(harness, runId, failure, 'dataset')).observed).not.toEqual(scenario.oracle.dataset)
    expect((await evidence(harness, runId, replay, 'dataset')).observed).toEqual(scenario.oracle.dataset)
    expect((await evidence(harness, runId, failure, 'chart')).observed).not.toEqual(scenario.oracle.chart)
    expect((await evidence(harness, runId, replay, 'chart')).observed).toEqual(scenario.oracle.chart)
    for (const shot of [result.failure_screenshot_path, result.replay_screenshot_path]) {
      expect(pngSize(await readFile(path.join(harness.runRoot(runId), shot ?? '')))).toEqual(scenario.scenario.app.canvas)
    }
    // The target iframe reconnected to the known-bad build and again to the patched build.
    expect(harness.targetNavigations() - navigationsBeforeRun).toBeGreaterThanOrEqual(2)

    // Isolated apply: the clone's permitted source is still the committed known-bad file.
    expect(await readFile(path.join(harness.repoRoot, SOURCE), 'utf8')).toBe(sourceBefore)
  } finally {
    cleanup = await harness?.close()
  }

  // After the Studio closes: no worktree, build, browser, server, or Git metadata remains, and
  // every original snapshot is restored apart from the ignored run artifacts.
  expect(finished).toBeDefined()
  expect(cleanup).toBeDefined()
  if (!cleanup || !harness) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
})
