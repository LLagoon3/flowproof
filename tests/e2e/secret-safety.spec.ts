import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import { GATE_IDS, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { EvidenceBundle, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { createMetaTransport } from '../../packages/flowproof/src/model/metaClient.js'
import type { DiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadCliLifecycle } from '../support/cliLifecycle.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import type { DiagnoseOptions, RecordedCall, RecordedTransport, TransportReadiness } from '../support/recordedTransport.js'
import { REPO_ROOT, listTree } from '../support/repoFixture.js'
import { DEMO_PORT, openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T063: seeded-marker secret safety across one headed Hero run. Synthetic markers are seeded in
// credential positions of every untrusted input the run touches: the chat request, the target
// frame's console, a target-origin request query and cookie, a rejected API request, and the
// explicit environment of the real Meta adapter, which runs in-process against a local fake
// `fetch` that records each request and answers with the recorded diagnosis, so no request
// leaves the machine and the process MODEL_API_KEY stays unset. No marker may then appear in
// any persisted artifact, the captured Meta request body, the live events, the Studio UI, the
// diagnostics (API errors, Studio console, process output, and the CLI launch output), or the
// final result, while positive controls prove each seed reached its surface and was redacted.

const HERO = 'canvas-filter-hero'
const RUN_BUDGET_MS = 300_000
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
const RECORDED = loadRecordedHeroResponse()

/** Synthetic values only; failures name the marker, never print it. */
const MARKERS = {
  chatBearer: 'fpseedchatbearer7d41c09e5a',
  chatPassword: 'fpseedchatpassword2b8e61f0',
  consoleToken: 'fpseedconsoletoken9a3f27c4',
  consoleAuthorization: 'fpseedconsoleauth4e18b6d2',
  networkQuery: 'fpseednetworkquery6c0d93ab',
  targetCookie: 'fpseedtargetcookie1f7a5e83',
  providerKey: 'fpseedsynthetickey58b2c7e1',
  rejectedField: 'fpseedrejectedfield3d9e0a7',
} as const
type MarkerName = keyof typeof MARKERS

/** The marker names a surface contains; the values themselves never reach the report. */
function leaks(surface: string, text: string): string[] {
  return (Object.keys(MARKERS) as MarkerName[]).filter((name) => text.includes(MARKERS[name])).map((name) => `${surface}: ${name}`)
}

interface CapturedMetaRequest {
  readonly url: string
  readonly body: string
}

interface CapturingMetaTransport extends RecordedTransport {
  /** URL and body of every request the real Meta adapter sent to the local fake `fetch`. */
  readonly requests: readonly CapturedMetaRequest[]
}

/**
 * The production Meta adapter with a synthetic key in its explicit environment and a local fake
 * `fetch`: it builds and "sends" the real Responses API request, which is recorded and answered
 * with the recorded Hero diagnosis instead of reaching the network.
 */
function createCapturingMetaTransport(): CapturingMetaTransport {
  const calls: RecordedCall[] = []
  const requests: CapturedMetaRequest[] = []
  const meta = createMetaTransport({
    env: { MODEL_API_KEY: MARKERS.providerKey },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push(Object.freeze({ url, body: typeof init?.body === 'string' ? init.body : '' }))
      const completed = {
        id: 'resp_secret_safety',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_secret_safety',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(RECORDED), annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
      return new Response(JSON.stringify(completed), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return Object.freeze({
    model: null,
    calls,
    requests,
    // The process environment holds no key; only this in-process adapter has the synthetic one.
    checkReadiness: (): TransportReadiness => ({ ready: true }),
    diagnose(prompt: unknown, options: DiagnoseOptions): Promise<unknown> {
      calls.push(Object.freeze({ prompt: structuredClone(prompt), timeoutMs: options.timeoutMs }))
      return meta.diagnose(prompt as DiagnosisPrompt, options)
    },
  })
}

/** Tees one process stream for the duration of the test. */
function teeStream(stream: NodeJS.WriteStream, sink: string[]): () => void {
  const write = stream.write.bind(stream)
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof stream.write
  return () => {
    stream.write = write
  }
}

async function bundleAt(harness: StudioHarness, runId: string, phase: 'failure' | 'replay'): Promise<EvidenceBundle> {
  const parsed = parseEvidenceBundle(await harness.readJson(runId, `evidence/${phase}/manifest.json`))
  if (!parsed.ok) throw new Error(`The ${phase} manifest violates the evidence-bundle contract.`)
  return parsed.value
}

test('seeded secret markers reach no artifact, Meta request, event, UI, diagnostic, or result', async () => {
  test.setTimeout(RUN_BUDGET_MS)
  const transport = createCapturingMetaTransport()
  const processOutput: string[] = []
  const restoreStreams = [teeStream(process.stdout, processOutput), teeStream(process.stderr, processOutput)]
  const findings: string[] = []
  let harness: StudioHarness | undefined
  let cleanup: CleanupReport | undefined
  let supervised: Promise<number> | undefined
  let disposeSignals: () => void = () => undefined
  try {
    harness = await openStudioHarness({ scenarioId: HERO, testTransport: transport })
    const { page, studio } = harness

    // Every live event the Studio page receives, exactly as delivered.
    const delivered: string[] = []
    const cdp = await page.context().newCDPSession(page)
    cdp.on('Network.eventSourceMessageReceived', (message) => delivered.push(`${message.eventName}\n${message.data}`))
    await cdp.send('Network.enable')
    const studioConsole: string[] = []
    const targetConsole: string[] = []
    page.on('console', (message) => {
      if (message.location().url.startsWith(studio.origin)) studioConsole.push(message.text())
      else targetConsole.push(message.text())
    })

    // The target frame logs and requests secrets in credential positions on every load.
    await page.context().addInitScript(
      ({ origin, markers }) => {
        if (location.origin !== origin) return
        console.error(`Chart request failed: token=${markers.consoleToken}`)
        console.warn(`Retrying with Authorization: Bearer ${markers.consoleAuthorization}`)
        document.cookie = `flowproof_seed=${markers.targetCookie}; path=/`
        void fetch(`/flowproof-seed/report?api_key=${markers.networkQuery}`).catch(() => undefined)
      },
      { origin: DEMO_ORIGIN, markers: MARKERS },
    )

    // The chat request carries secrets beside the committed goal.
    await page.getByLabel(/request/i).fill(`${scenario.scenario.default_request} Authorization: Bearer ${MARKERS.chatBearer} password=${MARKERS.chatPassword}`)
    await page.getByRole('button', { name: /^(start|send|run)\b/i }).click()
    const { runId, result }: { runId: string; result: RunResult } = await harness.waitForResult(RUN_BUDGET_MS)

    // Redaction never costs the verdict: the run still verifies, with a clean whole-run scan.
    expect(result.status).toBe('Verified Fix')
    expect(result.gates.map((gate) => [gate.gate_id, gate.status])).toEqual(GATE_IDS.map((gateId) => [gateId, 'pass']))
    expect(result.gates.find((gate) => gate.gate_id === 'secret_scan_clean')?.metrics).toMatchObject({ findings: 0 })
    const proofTrail = page.getByRole('region', { name: 'Proof Trail', exact: true })
    await expect(proofTrail.getByRole('region', { name: 'Proof Trail final status' })).toHaveAttribute('data-status', 'verified')
    const failure = await bundleAt(harness, runId, 'failure')
    const replay = await bundleAt(harness, runId, 'replay')
    for (const [title, bundle] of [
      ['Failure evidence', failure],
      ['Replay evidence', replay],
    ] as const) {
      await expect(proofTrail.getByRole('region', { name: title, exact: true }).locator('li[data-evidence-id] pre')).toHaveCount(
        bundle.items.filter((item) => item.type !== 'screenshot').length,
      )
    }

    // Positive controls: each seed reached its surface raw and was redacted there.
    expect(leaks('target console', targetConsole.join('\n'))).toEqual(['target console: consoleToken', 'target console: consoleAuthorization'])
    const failureItem = (type: string): EvidenceBundle['items'][number] | undefined => failure.items.find((item) => item.type === type)
    const consoleEvidence = JSON.stringify(await harness.readJson(runId, failureItem('console')?.artifact_path ?? ''))
    expect(consoleEvidence).toContain('token=[REDACTED]')
    expect(consoleEvidence).toContain('Authorization: [REDACTED]')
    expect(failureItem('console')?.redactions).toContainEqual({ category: 'credential', count: 2 })
    const networkEvidence = (await harness.readJson(runId, failureItem('network')?.artifact_path ?? '')) as { requests: Array<{ path: string }> }
    expect(networkEvidence.requests.map((request) => request.path)).toContain('/flowproof-seed/report')
    expect(failureItem('network')?.redactions).toContainEqual(expect.objectContaining({ category: 'query' }))
    expect(transport.requests).toHaveLength(1)
    const [metaRequest] = transport.requests
    expect(metaRequest?.url).toBe('https://api.meta.ai/v1/responses')
    const metaInput = JSON.parse((JSON.parse(metaRequest?.body ?? '{}') as { input: string }).input) as { developer_goal: string }
    expect(metaInput.developer_goal).toBe(`${scenario.scenario.default_request} Authorization: [REDACTED] password=[REDACTED]`)
    expect(harness.blockedRequests).toEqual([])
    expect(delivered.some((record) => record.startsWith('evidence_added\n'))).toBe(true)

    // Artifacts: every persisted file of the run, byte for byte.
    for (const entry of await listTree(harness.runRoot(runId))) {
      const bytes = await readFile(path.join(harness.runRoot(runId), entry)).catch(() => null)
      if (bytes !== null) findings.push(...leaks(`artifact ${entry}`, bytes.toString('latin1')))
    }
    // The model input, as the transport received it and as the Meta request carried it.
    findings.push(...leaks('provider prompt', JSON.stringify(transport.calls)))
    for (const request of transport.requests) findings.push(...leaks('Meta request', `${request.url}\n${request.body}`))
    // Chat and events, as delivered live to the Studio.
    findings.push(...leaks('events', delivered.join('\n')))
    // Diagnostics: rejected API requests that carry a marker answer with fixed, non-echoing errors.
    const rejections = await page.evaluate(
      async ({ runId: id, marker }) => {
        const start = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenario_id: 'canvas-filter-hero', request_text: `Authorization: Bearer ${marker}`, api_key: marker }),
        })
        const evidence = await fetch(`/api/runs/${id}/evidence/${marker}`)
        return [
          { status: start.status, body: await start.text() },
          { status: evidence.status, body: await evidence.text() },
        ]
      },
      { runId, marker: MARKERS.rejectedField },
    )
    expect(rejections.map(({ status, body }) => [status, (JSON.parse(body) as { error: { code: string } }).error.code])).toEqual([
      [400, 'REQUEST_FIELD_REJECTED'],
      [400, 'EVIDENCE_ID_INVALID'],
    ])
    for (const { body } of rejections) findings.push(...leaks('API error', body))
    // The final result, on disk and as the Studio API serves it.
    findings.push(...leaks('result.json', JSON.stringify(result)))
    findings.push(...leaks('result API', await page.evaluate(async (id) => (await fetch(`/api/runs/${id}/result`)).text(), runId)))
    // The UI: everything rendered, except the developer's own chat draft control.
    const ui = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement
      for (const draft of clone.querySelectorAll('textarea')) draft.remove()
      return `${document.title}\n${clone.outerHTML}`
    })
    findings.push(...leaks('Studio UI', ui))
    findings.push(...leaks('Studio console', studioConsole.join('\n')))
    expect(findings).toEqual([])

    // The CLI lifecycle prints its launch object and closes the finalized run's Studio normally.
    const cli = await loadCliLifecycle()
    const signals = cli.watchShutdownSignals()
    disposeSignals = () => signals.dispose()
    supervised = cli.superviseStudio(studio, signals)
  } finally {
    cleanup = await harness?.close()
    disposeSignals()
    for (const restore of restoreStreams) restore()
  }

  expect(await supervised).toBe(0)
  const launchLines = processOutput.join('').split('\n').filter((line) => line.startsWith('{"mode":"studio"'))
  expect(launchLines).toHaveLength(1)
  expect(Object.keys(JSON.parse(launchLines[0] ?? '{}') as object).sort()).toEqual(['mode', 'origin', 'session_id'])
  expect(leaks('process output', processOutput.join(''))).toEqual([])

  expect(cleanup).toBeDefined()
  if (!cleanup || !harness) return
  expect(cleanup.modelApiKeyPresent).toBe(false)
  expect(cleanup.processes).toEqual([])
  expect(cleanup.tmpLeftovers).toEqual([])
  expect(cleanup.demoPortListening).toBe(false)
  expect(cleanup.snapshot).toEqual(harness.baseline)
})
