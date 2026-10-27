import { request } from 'node:http'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'

import type { GateId, RunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadCliLifecycle } from '../support/cliLifecycle.js'
import { createHeldTransport, createRecordedTransport, loadRecordedHeroResponse } from '../support/recordedTransport.js'
import type { RecordedTransport, TransportReadiness } from '../support/recordedTransport.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'
import { openStudioHarness } from '../support/studioHarness.js'
import type { CleanupReport, StudioHarness } from '../support/studioHarness.js'

// T066: cleanup residue. For every way a run can end (success, provider failure, apply failure,
// browser close, target failure, and interrupt), the in-process Studio that `startStudio`
// launches, the same one `flowproof studio` launches, leaves nothing FlowProof owned once it
// closes: no entry in its private TMPDIR (Studio and preview builds, the detached worktree, the
// browser profile), no process using it, no listening Studio or demo server, a disconnected
// browser, and no registered worktree or administrative entry under the resolved Git common
// directory beyond the pre-run snapshot, while an unrelated pre-existing worktree stays
// registered. MODEL_API_KEY stays unset and only in-process test transports answer.

const HERO = 'canvas-filter-hero'
const RUN_BUDGET_MS = 120_000
const TEST_TIMEOUT_MS = 240_000
const UNRELATED = 'unrelated-worktree'
const scenario = await loadScenario(HERO, { repoRoot: REPO_ROOT })
const TARGET_DOCUMENT = scenario.scenario.app.url

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A transport whose one diagnosis request fails, as a provider outage would. */
const failingTransport = (): RecordedTransport =>
  Object.freeze({
    model: null,
    calls: [],
    checkReadiness: (): TransportReadiness => ({ ready: true }),
    diagnose: async (): Promise<never> => {
      throw new Error('PROVIDER_SERVER_ERROR: synthetic provider outage.')
    },
  })

/** The recorded diagnosis with a diff that passes every guard and applies, but breaks the patched build. */
function unbuildableTransport(): RecordedTransport {
  const recorded = loadRecordedHeroResponse() as { candidate: { unified_diff: string } }
  const fixed = '+  return rows.filter((row) => row.region === region)\n'
  if (!recorded.candidate.unified_diff.includes(fixed)) throw new Error('The recorded Hero diff changed shape.')
  const broken = recorded.candidate.unified_diff.replace(fixed, '+  return rows.filter((row) => row.region === region\n')
  return createRecordedTransport({ response: { ...recorded, candidate: { ...recorded.candidate, unified_diff: broken } } })
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request({ host, port, path: '/', timeout: 1_000 }, (response) => {
      response.resume()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
    probe.on('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.end()
  })
}

const startRun = (harness: StudioHarness): Promise<void> => harness.page.getByRole('button', { name: /^(start|send|run)\b/i }).click()

const reason = (result: RunResult, gateId: GateId): readonly [string, string] => {
  const outcome = result.gates.find((gate) => gate.gate_id === gateId)
  return [outcome?.status ?? 'missing', outcome?.reason_code ?? 'missing']
}

let harness: StudioHarness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

/** A Studio for one ending, with an unrelated worktree registered before the baseline snapshot. */
async function open(testTransport?: RecordedTransport): Promise<StudioHarness> {
  harness = await openStudioHarness({
    scenarioId: HERO,
    ...(testTransport === undefined ? {} : { testTransport }),
    prepareClone: (repoRoot) => {
      git(repoRoot, 'worktree', 'add', '--detach', '--quiet', path.join(path.dirname(repoRoot), UNRELATED), 'HEAD')
    },
  })
  expect(harness.baseline.worktreeAdminEntries).toEqual([UNRELATED])
  return harness
}

/** Closes the Studio (again, if it already closed itself) and proves nothing FlowProof owned remains. */
async function expectNoResidue(opened: StudioHarness): Promise<CleanupReport> {
  const studioPort = Number(new URL(opened.studio.origin).port)
  harness = undefined
  const report = await opened.close()
  expect(report.tmpLeftovers).toEqual([])
  expect(report.processes).toEqual([])
  expect(report.demoPortListening).toBe(false)
  expect(await listening('127.0.0.1', studioPort)).toBe(false)
  expect(opened.page.context().browser()?.isConnected()).toBe(false)
  // Only FlowProof's own worktree entry was removed and pruned; the unrelated one remains.
  expect(report.snapshot.worktreeAdminEntries).toEqual([UNRELATED])
  expect(report.snapshot.worktreeList).toContain(path.join(path.dirname(opened.repoRoot), UNRELATED))
  expect(report.snapshot).toEqual(opened.baseline)
  expect(report.modelApiKeyPresent).toBe(false)
  expect(opened.blockedRequests).toEqual([])
  return report
}

describe('cleanup residue after every run ending', () => {
  it(
    'leaves nothing after a verified run',
    async () => {
      const opened = await open()
      await startRun(opened)
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(result.status).toBe('Verified Fix')
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves nothing after a provider failure',
    async () => {
      const opened = await open(failingTransport())
      await startRun(opened)
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(result.status).toBe('Unverified')
      expect(reason(result, 'citations_valid')).toEqual(['unevaluable', 'PROVIDER_FAILED'])
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves nothing after a candidate that applies but does not rebuild',
    async () => {
      const opened = await open(unbuildableTransport())
      await startRun(opened)
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(result.status).toBe('Unverified')
      expect(reason(result, 'patch_scope_valid')).toEqual(['pass', expect.any(String)])
      expect(reason(result, 'patch_applied')).toEqual(['fail', 'PATCH_APPLY_FAILED'])
      // The broken candidate was applied only in the removed worktree; the snapshot covers the source.
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves nothing after the browser closes during a run',
    async () => {
      const transport = createHeldTransport()
      const opened = await open(transport)
      await startRun(opened)
      await transport.held
      // The developer quits Chromium itself, not only the Studio page.
      await opened.page.context().browser()?.close()
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(transport.cancelled()).toBe(true)
      expect(reason(result, 'citations_valid')).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves nothing after the target frame cannot load the prepared app',
    async () => {
      const transport = createRecordedTransport()
      const opened = await open(transport)
      await opened.page.route(
        (url) => url.href === TARGET_DOCUMENT,
        (route) => route.abort('connectionrefused'),
      )
      await startRun(opened)
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(reason(result, 'failure_reproduced')).toEqual(['unevaluable', 'TARGET_LOAD_FAILED'])
      expect(transport.calls).toHaveLength(0)
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'leaves nothing after an interrupt to the flowproof studio lifecycle during a run',
    async () => {
      // A real signal must reach only this test process and only the CLI lifecycle's handler.
      expect(isMainThread).toBe(true)
      expect(process.listenerCount('SIGINT')).toBe(0)
      const transport = createHeldTransport()
      const opened = await open(transport)
      const cli = await loadCliLifecycle()
      const signals = cli.watchShutdownSignals()
      try {
        const exit = cli.superviseStudio(opened.studio, signals)
        await startRun(opened)
        await transport.held
        process.kill(process.pid, 'SIGINT')
        expect(await exit).toBe(2)
      } finally {
        signals.dispose()
      }
      const { result } = await opened.waitForResult(RUN_BUDGET_MS)
      expect(reason(result, 'citations_valid')).toEqual(['unevaluable', 'RUN_INTERRUPTED'])
      // Let the closed browser's processes exit before they are counted.
      await sleep(250)
      await expectNoResidue(opened)
    },
    TEST_TIMEOUT_MS,
  )
})
