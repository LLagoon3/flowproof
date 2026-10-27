import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

import { GATE_IDS, parseDiagnosis, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, GateId, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { REPO_ROOT, listTree } from '../support/repoFixture.js'
import { DEMO_PORT, openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T057: the headed deterministic Failure run. The committed
// `canvas-filter-failure-invalid-citation` case runs the same app, actions, oracles, and permitted
// source as Hero with its committed `provider.mode=fixture` provider, MODEL_API_KEY unset, and no
// test transport. The Studio visibly reproduces the defect and captures the failure evidence, the
// labeled injected fixture answers instead of Meta Model API, its nonexistent Evidence ID fails
// `citations_valid`, no candidate or replay artifact exists, the final status is `Unverified`, the
// Proof Trail never shows the fixture's content, and every original snapshot is restored.

const FAILURE = 'canvas-filter-failure-invalid-citation'
const FIXTURE_PATH = 'scenarios/canvas-filter/provider-fixtures/invalid-citation.json'
const FAULT_LABEL = 'Injected evaluation fixture: nonexistent Evidence ID'
const NONEXISTENT_ID = 'ev_failure_chart_999'
const RUN_BUDGET_MS = 300_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** Gates after the rejected candidate: never evaluated, so unevaluable rather than invented. */
const NOT_REACHED: readonly GateId[] = ['patch_applied', 'dataset_matches', 'canvas_matches']
const scenario = await loadScenario(FAILURE, { repoRoot: REPO_ROOT })
const fixture = parseDiagnosis(JSON.parse(await readFile(path.join(REPO_ROOT, FIXTURE_PATH), 'utf8')))
if (!fixture.ok) throw new Error('The committed Failure fixture is not a valid diagnosis.')
/** Every free-text value of the fixture: none may be rendered anywhere in the Studio. */
const FIXTURE_TEXTS = [
  fixture.value.summary,
  fixture.value.root_cause,
  ...fixture.value.claims.map((claim) => claim.text),
  fixture.value.candidate.unified_diff,
  NONEXISTENT_ID,
]

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function failureBundle(harness: StudioHarness, runId: string): Promise<EvidenceBundle> {
  const parsed = parseEvidenceBundle(await harness.readJson(runId, 'evidence/failure/manifest.json'))
  if (!parsed.ok) throw new Error('The failure manifest violates the evidence-bundle contract.')
  expect(parsed.value.run_id).toBe(runId)
  return parsed.value
}

/** The rendered size of a fully loaded image, or null while it is still loading. */
const loadedSize = (image: Locator): Promise<{ width: number; height: number } | null> =>
  image.evaluate((element: HTMLImageElement) =>
    element.complete && element.naturalWidth > 0 ? { width: element.naturalWidth, height: element.naturalHeight } : null,
  )

/** The failure section shows every stored Evidence ID, the screenshot, and each stored JSON artifact. */
async function expectFailureTrail(harness: StudioHarness, runId: string, section: Locator, bundle: EvidenceBundle): Promise<void> {
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
  await expect(image).toHaveAttribute('src', `/api/runs/${runId}/evidence/${screenshot?.evidence_id ?? ''}`)
  await expect.poll(() => loadedSize(image)).toEqual(scenario.scenario.app.canvas)
  for (const item of bundle.items.filter((candidate) => candidate.type !== 'screenshot')) {
    const shown = section.locator(`li[data-evidence-id="${item.evidence_id}"] pre`)
    await expect(shown).toHaveCount(1)
    expect(JSON.parse((await shown.textContent()) ?? '')).toEqual(await harness.readJson(runId, item.artifact_path))
  }
}

test('the injected invalid-citation fixture is rejected before application and stays Unverified', async () => {
  test.setTimeout(RUN_BUDGET_MS + 180_000)
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let finished: { runId: string; result: RunResult } | undefined
  try {
    harness = await openStudioHarness({ scenarioId: FAILURE, recordedTransport: false })
    const { page } = harness
    const browserRequests: string[] = []
    page.context().on('request', (request) => browserRequests.push(request.url()))

    // The Studio opens on the launch-selected Failure case with the prepared app framed on the left.
    const target = page.locator('iframe')
    await expect(target).toHaveCount(1)
    await expect(target).toHaveAttribute('src', new RegExp(`^http://localhost:${DEMO_PORT}/`))
    await expect(page.getByLabel('Prepared case')).toHaveValue(FAILURE)
    await expect(page.getByLabel(/request/i)).toHaveValue(scenario.scenario.default_request)

    // Start through chat with no credential, path, oracle, command, or gate input.
    await page.getByRole('button', { name: /^(start|send|run)\b/i }).click()
    finished = await harness.waitForResult(RUN_BUDGET_MS)
    const { runId, result } = finished

    // The authoritative result: the labeled fixture failed the citation gate, so nothing later ran.
    expect(result.status).toBe('Unverified')
    expect(result.provider).toEqual({ mode: 'fixture', model: null, injected_fault_label: FAULT_LABEL })
    expect(result.gates.map((gate) => [gate.gate_id, gate.status])).toEqual(
      GATE_IDS.map((gateId) => [gateId, gateId === 'citations_valid' ? 'fail' : NOT_REACHED.includes(gateId) ? 'unevaluable' : 'pass']),
    )
    expect(result.gates.find((gate) => gate.gate_id === 'citations_valid')?.reason_code).toBe('CITATION_UNKNOWN_EVIDENCE_ID')
    expect(result.failed_gate_ids).toEqual(['citations_valid', ...NOT_REACHED])
    expect(result.total_duration_ms).toBeLessThan(RUN_BUDGET_MS)
    await expect(page.getByRole('region', { name: 'Run status' }).getByText('Unverified', { exact: true })).toBeVisible()

    // No test transport, credential, or live Meta request: the committed fixture answered.
    expect(harness.transport).toBeNull()
    expect(harness.blockedRequests).toEqual([])

    // Visible failure evidence was captured; no application or replay artifact exists.
    const failure = await failureBundle(harness, runId)
    expect(failure.items).toHaveLength(7)
    const dataset = await harness.readJson(runId, failure.items.find((item) => item.type === 'dataset')?.artifact_path ?? '')
    expect((dataset as { observed: unknown }).observed).not.toEqual(scenario.oracle.dataset)
    expect(pngSize(await readFile(path.join(harness.runRoot(runId), result.failure_screenshot_path ?? '')))).toEqual(scenario.scenario.app.canvas)
    expect(result.candidate_diff_path).toBeNull()
    expect(result.replay_screenshot_path).toBeNull()
    expect(result.diagnosis_path).toBe('diagnosis/diagnosis.json')
    const tree = await listTree(harness.runRoot(runId))
    expect(tree.filter((entry) => /^(candidate|evidence\/replay)(\/|$)/.test(entry))).toEqual([])
    // The stored diagnosis is the committed fixture after the strict diagnosis parse.
    const stored = parseDiagnosis(await harness.readJson(runId, 'diagnosis/diagnosis.json'))
    expect(stored.ok && stored.value).toEqual(fixture.value)

    // The agent pane labels the injection and shows the failed citation gate.
    const labeled = page.locator('.agent-activity__item[data-type="agent_message"][data-phase="diagnosing"]', { hasText: FAULT_LABEL })
    await expect(labeled).toHaveCount(1)
    await expect(labeled).toContainText('not from Meta Model API')
    const gateRows = page.locator('tr.agent-gate')
    await expect(gateRows).toHaveCount(GATE_IDS.length)
    expect(await gateRows.evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-gate'), row.getAttribute('data-status')]))).toEqual(
      result.gates.map((gate) => [gate.gate_id, gate.status]),
    )

    // The in-workspace Proof Trail: Unverified, rejected at the citation gate, injected provenance.
    const proofTrail = page.getByRole('region', { name: 'Proof Trail', exact: true })
    await expect(proofTrail).toHaveAttribute('data-run-id', runId)
    const finalStatus = proofTrail.getByRole('region', { name: 'Proof Trail final status' })
    await expect(finalStatus).toHaveAttribute('data-status', 'unverified')
    await expect(finalStatus).toContainText('Unverified')
    const rejection = finalStatus.locator('[data-rejected-by]')
    await expect(rejection).toHaveAttribute('data-rejected-by', 'citations_valid')
    await expect(rejection).toContainText('Rejected before patch application')
    await expect(rejection).toContainText('CITATION_UNKNOWN_EVIDENCE_ID')

    const provenance = proofTrail.getByRole('region', { name: 'Diagnosis provenance' })
    await expect(provenance.locator('[data-provenance]')).toHaveAttribute('data-provenance', 'fixture')
    await expect(provenance).toContainText('Injected evaluation fixture.')
    await expect(provenance).toContainText(FAULT_LABEL)
    await expect(provenance).toContainText('not displayed')
    await expect(proofTrail.locator('[data-provenance="meta"]')).toHaveCount(0)

    await expectFailureTrail(harness, runId, proofTrail.getByRole('region', { name: 'Failure evidence', exact: true }), failure)

    const candidate = proofTrail.getByRole('region', { name: 'Candidate diff', exact: true })
    await expect(candidate).toHaveAttribute('data-verified', 'false')
    await expect(candidate.locator('pre')).toHaveCount(0)
    await expect(proofTrail.getByRole('region', { name: 'Verified diff' })).toHaveCount(0)
    const replay = proofTrail.getByRole('region', { name: 'Replay evidence', exact: true })
    await expect(replay).toHaveAttribute('data-reached', 'false')
    await expect(replay.locator('img, li[data-evidence-id]')).toHaveCount(0)

    const shownGates = proofTrail.getByRole('region', { name: 'Gate outcomes' }).locator('li.proof-gate')
    expect(
      await shownGates.evaluateAll((elements) =>
        elements.map((element) => [element.getAttribute('data-gate'), element.getAttribute('data-status'), element.querySelector('.proof-gate__head code')?.textContent]),
      ),
    ).toEqual(result.gates.map((gate) => [gate.gate_id, gate.status, gate.reason_code]))

    // The fixture is untrusted input: none of its text reaches the Studio page.
    const pageText = await page.evaluate(() => document.body.textContent ?? '')
    for (const text of FIXTURE_TEXTS) expect(pageText).not.toContain(text)

    // The browser stayed on loopback.
    const external = browserRequests.filter((url) => {
      const { protocol, hostname } = new URL(url)
      return ['http:', 'https:', 'ws:', 'wss:'].includes(protocol) && !LOOPBACK_HOSTS.has(hostname)
    })
    expect(external).toEqual([])
  } finally {
    cleanup = await harness?.close()
  }

  // After the Studio closes: nothing FlowProof owned remains, and every original snapshot is
  // restored apart from the ignored run artifacts.
  expect(finished).toBeDefined()
  expect(cleanup).toBeDefined()
  if (!cleanup || !harness) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
})
