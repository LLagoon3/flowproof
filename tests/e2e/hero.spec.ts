import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

import { GATE_IDS, META_MODEL_ID, RUN_STATES, parseDiagnosis, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { callTrustedProbe } from '../../packages/flowproof/src/studio/targetApp.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'
import { DEMO_PORT, openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T034/T049/T053: the headed recorded-Hero run. One real Studio run crosses every runtime layer
// with the committed `provider.mode=meta` Hero scenario, a recorded diagnosis injected only
// through the in-process `startStudio({ testTransport })` entry, and MODEL_API_KEY unset:
// visible reproduction, recorded diagnosis, validated one-file diff, isolated apply, patched
// rebuild, iframe reconnection, identical visible replay, dataset and Canvas oracles, nine
// passing gates, `Verified Fix`, cleanup, and unchanged pre-run snapshots. The run must stay
// inside every phase budget and the 300-second total, make no live Meta or other external
// request, and leave a complete in-workspace Proof Trail rendered from the stored run artifacts.

const HERO = 'canvas-filter-hero'
const SOURCE = 'apps/demo-chart/src/filterData.ts'
const RUN_BUDGET_MS = 300_000
// plan.md "Performance Goals": 15 seconds for result generation. The other phase budgets are the
// committed scenario timeouts; apply and replay share the scenario's `replay_ms` window.
const FINALIZE_BUDGET_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
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

/** The rendered size of a fully loaded image, or null while it is still loading. */
const loadedSize = (image: Locator): Promise<{ width: number; height: number } | null> =>
  image.evaluate((element: HTMLImageElement) =>
    element.complete && element.naturalWidth > 0 ? { width: element.naturalWidth, height: element.naturalHeight } : null,
  )

/**
 * One capture section of the Proof Trail: every Evidence ID of the stored bundle in order, the
 * screenshot served through its closed evidence route at the committed Canvas size, and every JSON
 * evidence item showing exactly its stored sanitized artifact.
 */
async function expectCaptureTrail(harness: StudioHarness, runId: string, section: Locator, bundle: EvidenceBundle): Promise<void> {
  await expect(section).toBeVisible()
  await expect(section).toHaveAttribute('data-reached', 'true')
  const items = section.locator('li[data-evidence-id]')
  await expect(items).toHaveCount(bundle.items.length)
  expect(await items.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-evidence-id')))).toEqual(
    bundle.items.map((item) => item.evidence_id),
  )

  const screenshot = bundle.items.find((item) => item.type === 'screenshot')
  const image = section.locator('img')
  await expect(image).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', `/api/runs/${runId}/evidence/${screenshot?.evidence_id ?? ''}`)
  await expect.poll(() => loadedSize(image)).toEqual(scenario.scenario.app.canvas)

  for (const item of bundle.items.filter((candidate) => candidate.type !== 'screenshot')) {
    const shown = section.locator(`li[data-evidence-id="${item.evidence_id}"] pre`)
    await expect(shown).toHaveCount(1)
    if (item.type === 'dataset' || item.type === 'chart') await expect(shown).toBeVisible()
    expect(JSON.parse((await shown.textContent()) ?? '')).toEqual(await harness.readJson(runId, item.artifact_path))
  }
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

    // Every request the Studio browser makes from here on, including the target frame's.
    const browserRequests: string[] = []
    page.context().on('request', (request) => browserRequests.push(request.url()))

    // One Studio page: the prepared app framed on the left, the agent pane with chat on the right.
    const target = page.locator('iframe')
    await expect(target).toHaveCount(1)
    await expect(target).toHaveAttribute('src', new RegExp(`^http://localhost:${DEMO_PORT}/`))
    const chat = page.getByLabel(/request/i)
    await expect(chat).toHaveValue(scenario.scenario.default_request)
    const proofTrail = page.getByRole('region', { name: 'Proof Trail', exact: true })
    await expect(proofTrail).toContainText('The Proof Trail appears here after a run finalizes.')
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
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Verified Fix', { exact: true })).toBeVisible()

    // Every phase stays inside its budget and the whole run inside 300 seconds.
    const { capture, model, apply, replay: replayMs, finalize } = result.phase_durations_ms
    const { timeouts } = scenario.scenario
    expect(capture).toBeLessThan(timeouts.capture_ms)
    expect(model).toBeLessThan(timeouts.model_ms)
    expect(apply + replayMs).toBeLessThan(timeouts.replay_ms)
    expect(finalize).toBeLessThan(FINALIZE_BUDGET_MS)
    expect(capture + model + apply + replayMs + finalize).toBeLessThanOrEqual(result.total_duration_ms)
    expect(result.total_duration_ms).toBeLessThan(RUN_BUDGET_MS)
    expect(result.total_duration_ms).toBeLessThanOrEqual(timeouts.total_ms)

    // Exactly one recorded diagnosis; no live Meta or other external request from the engine.
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

    // The replay was visible: the target iframe reconnected to the known-bad build and again to
    // the patched build, and the visible frame still shows the replayed action and patched chart.
    expect(harness.targetNavigations() - navigationsBeforeRun).toBeGreaterThanOrEqual(2)
    await expect(target).toBeVisible()
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
    expect(frame?.url().startsWith(`http://localhost:${DEMO_PORT}/`)).toBe(true)
    if (!frame) throw new Error('The target frame is missing.')
    const [action] = scenario.scenario.actions
    expect(await callTrustedProbe(frame, 'readState')).toMatchObject({ ok: true, value: { ready: true, selected_region: action?.value } })
    expect(await callTrustedProbe(frame, 'readChartSeries')).toEqual({ ok: true, value: scenario.oracle.chart })

    // The agent pane connected the run in order: phases only advance, replay followed the apply,
    // the replay evidence was announced, and every gate in the gate table passed.
    const phases = await page
      .locator('.agent-activity__item[data-type="phase_started"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-phase') ?? ''))
    const order = (phase: string): number => (RUN_STATES as readonly string[]).indexOf(phase)
    expect(phases.every((phase, index) => order(phase) > (index === 0 ? -1 : order(phases[index - 1] ?? '')))).toBe(true)
    expect(phases.slice(-2)).toEqual(['applying', 'replaying'])
    const replayAnnounced = page.locator('.agent-activity__item[data-type="evidence_added"][data-phase="replaying"] li code')
    expect(await replayAnnounced.allTextContents()).toEqual(replay.items.map((item) => item.evidence_id))
    const gateRows = page.locator('tr.agent-gate')
    await expect(gateRows).toHaveCount(GATE_IDS.length)
    expect(await gateRows.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-gate'), row.getAttribute('data-status')]))).toEqual(
      GATE_IDS.map((gateId) => [gateId, 'pass']),
    )

    // The complete Proof Trail, inside the same Studio page, rendered from the stored run artifacts.
    await expect(proofTrail).toHaveAttribute('data-run-id', runId)
    const finalStatus = proofTrail.getByRole('region', { name: 'Proof Trail final status' })
    await expect(finalStatus).toHaveAttribute('data-status', 'verified')
    await expect(finalStatus).toContainText('Verified Fix')
    await expect(finalStatus).toContainText('All nine required gates passed.')
    const provenance = proofTrail.getByRole('region', { name: 'Diagnosis provenance' })
    await expect(provenance.locator('[data-provenance]')).toHaveAttribute('data-provenance', 'meta')
    await expect(provenance).toContainText(META_MODEL_ID)
    await expect(proofTrail.locator('[data-provenance="fixture"]')).toHaveCount(0)

    await expectCaptureTrail(harness, runId, proofTrail.getByRole('region', { name: 'Failure evidence', exact: true }), failure)
    await expectCaptureTrail(harness, runId, proofTrail.getByRole('region', { name: 'Replay evidence', exact: true }), replay)

    const verifiedDiff = proofTrail.getByRole('region', { name: 'Verified diff' })
    await expect(verifiedDiff).toHaveAttribute('data-verified', 'true')
    const shownDiff = verifiedDiff.locator('pre')
    await expect(shownDiff).toBeVisible()
    expect(await shownDiff.textContent()).toBe(diff)

    const shownGates = proofTrail.getByRole('region', { name: 'Gate outcomes' }).locator('li.proof-gate')
    await expect(shownGates).toHaveCount(GATE_IDS.length)
    expect(
      await shownGates.evaluateAll((elements) =>
        elements.map((element) => [element.getAttribute('data-gate'), element.getAttribute('data-status'), element.querySelector('.proof-gate__head code')?.textContent]),
      ),
    ).toEqual(result.gates.map((gate) => [gate.gate_id, 'pass', gate.reason_code]))

    const timing = proofTrail.getByRole('region', { name: 'Run timing' })
    for (const [phase, ms] of Object.entries(result.phase_durations_ms)) {
      await expect(timing.locator(`[data-phase="${phase}"]`)).toHaveAttribute('data-ms', String(ms))
    }
    await expect(timing.locator('[data-phase="total"]')).toHaveAttribute('data-ms', String(result.total_duration_ms))
    expect(page.context().pages()).toHaveLength(1)

    // The browser stayed on loopback: no live Meta or other external request from the Studio page.
    const external = browserRequests.filter((url) => {
      const { protocol, hostname } = new URL(url)
      return ['http:', 'https:', 'ws:', 'wss:'].includes(protocol) && !LOOPBACK_HOSTS.has(hostname)
    })
    expect(external).toEqual([])

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
