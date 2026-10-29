import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Frame } from '@playwright/test'
import { afterAll, describe, expect, it } from 'vitest'

import { salesRows } from '../../apps/demo-chart/src/data.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { callTrustedProbe, startTargetApp } from '../../packages/flowproof/src/studio/targetApp.js'
import { REPO_ROOT, createTempClone, createTempDirectory } from '../support/repoFixture.js'

// The permitted patch module cannot claim the trusted probe. The demo entry installs the
// committed probe before it loads the one file a candidate patch may change, so that module's
// top-level code runs only after `__flowproofProbe` is already a non-configurable data property.
// The committed demo app is built from a clone of HEAD with `filterData.ts` replaced by a module
// that first tries to install a counterfeit frozen version-1 probe reporting the oracle values,
// then keeps the known-bad filter. The target app must accept and read only the committed probe.

const HERO = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })
const PERMITTED_SOURCE = 'apps/demo-chart/src/filterData.ts'
const BUILD_TIMEOUT = 180_000

const teardown: Array<() => Promise<void>> = []
let browser: Browser | undefined

afterAll(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined)
  await browser?.close()
})

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, 'localhost', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** The Hero scenario with only its app URL moved to a free port. */
const scenarioOn = (port: number): LoadedScenario => ({
  ...HERO,
  scenario: { ...HERO.scenario, app: { ...HERO.scenario.app, url: `http://localhost:${port}/` } },
})

/** A permitted module whose top-level code races to install a counterfeit probe. */
const hostileFilter = (): string => `import type { SalesRow } from './data.js'

const oracle = ${JSON.stringify({ dataset: HERO.oracle.dataset, chart: HERO.oracle.chart })}
const counterfeit = Object.freeze({
  version: 1,
  isReady: () => true,
  readState: () => Object.freeze({ ready: true, selected_region: 'North', render_count: 99 }),
  readDataset: () => oracle.dataset,
  readChartSeries: () => oracle.chart,
  readCanvasSize: () => Object.freeze({ width: 640, height: 360 }),
})
let claimed = false
try {
  Object.defineProperty(window, '__flowproofProbe', { value: counterfeit, writable: false, configurable: false, enumerable: false })
  claimed = true
} catch {
  // The committed probe was installed first.
}
Object.defineProperty(window, '__counterfeitClaimed', { value: claimed })

export function filterByRegion(rows: readonly SalesRow[], region: string): SalesRow[] {
  return rows.filter((row) => row.region.includes(region))
}
`

/** Builds the committed demo app with the permitted module replaced, as a candidate patch would. */
async function buildDemoWith(filterSource: string): Promise<string> {
  const repo = await createTempClone({ withDependencies: true })
  teardown.push(repo.remove)
  await writeFile(path.join(repo.path, PERMITTED_SOURCE), filterSource)
  const output = await createTempDirectory('flowproof-probe-order-build-')
  teardown.push(output.remove)
  execFileSync('pnpm', ['--filter', '@flowproof/demo-chart', 'exec', 'vite', 'build', '--outDir', output.path, '--emptyOutDir'], {
    cwd: repo.path,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.path
}

async function targetFrame(): Promise<Frame> {
  browser ??= await chromium.launch()
  const { viewport } = HERO.scenario.app
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
  await page.setContent(
    `<!doctype html><html><body style="margin:0"><iframe id="target" src="about:blank" width="${viewport.width}" height="${viewport.height}"></iframe></body></html>`,
  )
  const frame = await (await page.waitForSelector('#target')).contentFrame()
  if (!frame) throw new Error('The target frame did not attach.')
  return frame
}

describe('trusted probe installation order', () => {
  it(
    'installs the committed probe before top-level code in the permitted module can claim it',
    async () => {
      const root = await buildDemoWith(hostileFilter())
      const app = await startTargetApp({ scenario: scenarioOn(await freePort()) })
      teardown.push(() => app.close())
      await app.serve('patched', root)
      const frame = await targetFrame()

      await app.reconnect(frame, { timeoutMs: 30_000 })

      expect(await frame.evaluate(() => (window as { __counterfeitClaimed?: unknown }).__counterfeitClaimed)).toBe(false)
      // The accepted probe reports the app's own first render and then the module's real output.
      expect(await callTrustedProbe(frame, 'readState')).toEqual({ ok: true, value: { ready: true, selected_region: 'South', render_count: 1 } })
      await frame.selectOption('#region-filter', 'North')
      await frame.waitForFunction(
        () => (window as { __flowproofProbe?: { readState(): { render_count: number } } }).__flowproofProbe?.readState().render_count === 2,
      )
      const knownBad = salesRows.filter((row) => row.region.includes('North'))
      expect(await callTrustedProbe(frame, 'readDataset')).toEqual({ ok: true, value: knownBad })
      expect(await callTrustedProbe(frame, 'readChartSeries')).toEqual({
        ok: true,
        value: { bar_count: knownBad.length, labels: knownBad.map((row) => row.quarter), values: knownBad.map((row) => row.revenue) },
      })
      expect(knownBad).not.toEqual(HERO.oracle.dataset)
    },
    BUILD_TIMEOUT,
  )
})
