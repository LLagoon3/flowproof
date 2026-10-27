import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { Agent, createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Frame, Page } from '@playwright/test'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { installTestProbe } from '../../apps/demo-chart/src/testProbe.js'
import type { ProbeChart } from '../../apps/demo-chart/src/testProbe.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import {
  TargetAppError,
  invokeTrustedProbe,
  isTargetLoadFailure,
  startTargetApp,
  trustedProbeReady,
} from '../../packages/flowproof/src/studio/targetApp.js'
import type { TargetApp } from '../../packages/flowproof/src/studio/targetApp.js'
import { REPO_ROOT, createTempDirectory } from '../support/repoFixture.js'

// T036: the target-app lifecycle owner in `packages/flowproof/src/studio/targetApp.ts`. One
// static server binds the scenario's `localhost` port once, serves only the active canonical
// document root as it advances from preview to known-bad to patched, never lets a request leave
// that root, and releases the port exactly once. The Studio iframe is reconnected in place and
// counts as ready only through the committed trusted-probe contract, and a reconnect that cannot
// show the prepared app is classified as a target load failure (T065). These suites bind a free
// port through a copy of the Hero scenario so they never contend for the committed demo port.

const HERO = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })
const BROWSER_TIMEOUT = 60_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

let browser: Promise<Browser> | undefined

afterAll(async () => {
  await (await browser)?.close()
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

async function startOn(port: number): Promise<TargetApp> {
  const app = await startTargetApp({ scenario: scenarioOn(port) })
  cleanups.push(() => app.close())
  return app
}

async function startApp(): Promise<{ app: TargetApp; port: number }> {
  const port = await freePort()
  return { app: await startOn(port), port }
}

type ProbeKind = 'trusted' | 'not-ready' | 'counterfeit'

const PROBE_SCRIPTS: Record<ProbeKind, string> = {
  trusted:
    "Object.defineProperty(window, '__flowproofProbe', { value: Object.freeze({ version: 1, isReady: () => true }), writable: false, configurable: false, enumerable: false })",
  'not-ready':
    "Object.defineProperty(window, '__flowproofProbe', { value: Object.freeze({ version: 1, isReady: () => false }), writable: false, configurable: false, enumerable: false })",
  // Target code claiming readiness outside the committed contract: a plain writable global.
  counterfeit: 'window.__flowproofProbe = { version: 1, isReady: () => true }',
}

/** A built app directory in OS temporary output whose page shows `label`; returns the root. */
async function builtRoot(label: string, probe: ProbeKind = 'trusted'): Promise<string> {
  const parent = await createTempDirectory('flowproof-target-build-')
  cleanups.push(parent.remove)
  const root = path.join(parent.path, 'dist')
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await writeFile(
    path.join(root, 'index.html'),
    `<!doctype html><html><head><title>${label}</title></head><body><p id="stage">${label}</p><script src="./assets/probe.js"></script></body></html>`,
  )
  await writeFile(path.join(root, 'assets', 'probe.js'), `${PROBE_SCRIPTS[probe]}\n`)
  return root
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly reused: boolean
}

function send(port: number, options: { path?: string; host?: string; method?: string; agent?: Agent } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: 'localhost',
        port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        agent: options.agent ?? false,
        headers: { host: options.host ?? `localhost:${port}` },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, reused: req.reusedSocket }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function expectTargetError(action: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(TargetAppError)
  expect((caught as TargetAppError).code).toBe(code)
}

function listen(port: number, server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, 'localhost', () => resolve())
  })
}

describe('trusted probe contract', () => {
  const chart: ProbeChart = {
    data: { labels: ['Q1'], datasets: [{ data: [120] }] },
    getDatasetMeta: () => ({ data: [{}] }),
    canvas: { width: 640, height: 360 },
  }

  function committedProbe(): { scope: object; render(): void } {
    const scope = {}
    let renders = 0
    installTestProbe(scope, {
      chart: () => (renders > 0 ? chart : null),
      rows: () => [{ region: 'North', quarter: 'Q1', revenue: 120 }],
      selectedRegion: () => 'North',
      renderCount: () => renders,
    })
    return { scope, render: () => (renders += 1) }
  }

  const defined = (value: unknown, descriptor: PropertyDescriptor = { writable: false, configurable: false }): object =>
    Object.defineProperty({}, '__flowproofProbe', { value, enumerable: false, ...descriptor })

  it('accepts only the committed probe, and only after the chart rendered', () => {
    const probe = committedProbe()
    expect(trustedProbeReady(probe.scope)).toBe(false)
    probe.render()
    expect(trustedProbeReady(probe.scope)).toBe(true)
  })

  it.each([
    ['no probe', {}],
    ['a plain writable global', { __flowproofProbe: Object.freeze({ version: 1, isReady: () => true }) }],
    ['a configurable property', defined(Object.freeze({ version: 1, isReady: () => true }), { writable: false, configurable: true })],
    ['a writable property', defined(Object.freeze({ version: 1, isReady: () => true }), { writable: true, configurable: false })],
    [
      'an accessor property',
      Object.defineProperty({}, '__flowproofProbe', { get: () => Object.freeze({ version: 1, isReady: () => true }), configurable: false }),
    ],
    ['an unfrozen probe', defined({ version: 1, isReady: () => true })],
    ['another probe version', defined(Object.freeze({ version: 2, isReady: () => true }))],
    ['a truthy string', defined(Object.freeze({ version: 1, isReady: () => 'true' }))],
    ['a truthy number', defined(Object.freeze({ version: 1, isReady: () => 1 }))],
    [
      'a throwing readiness check',
      defined(
        Object.freeze({
          version: 1,
          isReady: () => {
            throw new Error('not yet')
          },
        }),
      ),
    ],
  ])('refuses readiness from %s', (_label, scope) => {
    expect(trustedProbeReady(scope)).toBe(false)
  })

  it('reads committed probe methods and refuses counterfeit or failing reads', () => {
    const probe = committedProbe()
    expect(invokeTrustedProbe('readDataset', probe.scope)).toEqual({ ok: false })
    probe.render()
    expect(invokeTrustedProbe('readDataset', probe.scope)).toEqual({ ok: true, value: [{ region: 'North', quarter: 'Q1', revenue: 120 }] })
    expect(invokeTrustedProbe('readChartSeries', probe.scope)).toEqual({ ok: true, value: { bar_count: 1, labels: ['Q1'], values: [120] } })
    expect(invokeTrustedProbe('notAProbeMethod', probe.scope)).toEqual({ ok: false })
    expect(invokeTrustedProbe('readDataset', { __flowproofProbe: { version: 1, readDataset: () => [] } })).toEqual({ ok: false })
  })
})

describe('fixed-port static server', () => {
  it('binds the scenario port on localhost and serves nothing before the first build', async () => {
    const { app, port } = await startApp()

    expect(app.origin).toBe(`http://localhost:${port}`)
    expect(app.url).toBe(`http://localhost:${port}/`)
    expect(app.stage).toBeNull()
    const reply = await send(port)
    expect(reply.status).toBe(503)
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('serves the active root with no-store and no cache validators', async () => {
    const { app, port } = await startApp()
    await app.serve('preview', await builtRoot('preview'))

    const index = await send(port, { path: '/?seed=ignored' })
    expect(index.status).toBe(200)
    expect(index.body).toContain('<p id="stage">preview</p>')
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8')
    const script = await send(port, { path: '/assets/probe.js' })
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    for (const reply of [index, script]) {
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
      expect(reply.headers.etag).toBeUndefined()
      expect(reply.headers['last-modified']).toBeUndefined()
    }
    const head = await send(port, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
  })

  it('advances preview, known-bad, and patched roots on one listening socket without stale content', async () => {
    const { app, port } = await startApp()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    cleanups.push(async () => agent.destroy())

    const replies: Reply[] = []
    for (const stage of ['preview', 'known-bad', 'patched'] as const) {
      await app.serve(stage, await builtRoot(stage))
      expect(app.stage).toBe(stage)
      replies.push(await send(port, { agent }))
    }

    expect(replies.map((reply) => reply.body.match(/<p id="stage">([a-z-]+)<\/p>/)?.[1])).toEqual(['preview', 'known-bad', 'patched'])
    // The same keep-alive connection served every stage: the swaps never rebound the port.
    expect(replies.map((reply) => reply.reused)).toEqual([false, true, true])
  })

  it('refuses out-of-order stages and invalid roots while the previous build stays served', async () => {
    const { app, port } = await startApp()
    await app.serve('known-bad', await builtRoot('known-bad'))
    const fileRoot = path.join(await builtRoot('file'), 'index.html')
    const noIndex = await createTempDirectory('flowproof-target-empty-')
    cleanups.push(noIndex.remove)
    const linkedIndex = await createTempDirectory('flowproof-target-linked-')
    cleanups.push(linkedIndex.remove)
    await symlink(path.join(await builtRoot('elsewhere'), 'index.html'), path.join(linkedIndex.path, 'index.html'))

    await expectTargetError(() => app.serve('preview', '/unused'), 'TARGET_STAGE_OUT_OF_ORDER')
    await expectTargetError(() => app.serve('known-bad', '/unused'), 'TARGET_STAGE_OUT_OF_ORDER')
    await expectTargetError(() => app.serve('production' as never, '/unused'), 'TARGET_STAGE_INVALID')
    // The last root has a regular index.html but lies outside temporary output: the source checkout.
    const sourceCheckout = path.join(REPO_ROOT, HERO.scenario.app.root)
    for (const root of ['relative/dist', path.join(noIndex.path, 'missing'), fileRoot, noIndex.path, linkedIndex.path, sourceCheckout]) {
      await expectTargetError(() => app.serve('patched', root), 'TARGET_DOCUMENT_ROOT_INVALID')
    }

    expect(app.stage).toBe('known-bad')
    expect((await send(port)).body).toContain('<p id="stage">known-bad</p>')
  })

  it('keeps every request inside the active root and refuses foreign hosts and methods', async () => {
    const { app, port } = await startApp()
    const root = await builtRoot('preview')
    const outside = await createTempDirectory('flowproof-target-outside-')
    cleanups.push(outside.remove)
    await writeFile(path.join(outside.path, 'secret.txt'), 'outside-the-document-root\n')
    await writeFile(path.join(root, '.hidden'), 'hidden-file\n')
    // The build directory's own parent is FlowProof-owned temporary output, never served.
    await writeFile(path.join(path.dirname(root), 'sibling.txt'), 'sibling-file\n')
    await symlink(path.join(outside.path, 'secret.txt'), path.join(root, 'escape.txt'))
    await symlink(outside.path, path.join(root, 'linked-dir'))
    await app.serve('preview', root)

    for (const target of [
      '/../sibling.txt',
      '/%2e%2e/sibling.txt',
      '/assets/..%2F..%2Fsibling.txt',
      '/assets/%2e%2e/index.html',
      '/escape.txt',
      '/linked-dir/secret.txt',
      '/.hidden',
      '/assets',
      '/assets/',
      '//index.html',
      '/assets%5Cprobe.js',
      '/index.html%00',
      '/%E0%A4%A',
      '/missing.js',
    ]) {
      const reply = await send(port, { path: target })
      expect(reply.status, target).toBe(404)
      expect(reply.headers['cache-control'], target).toBe('no-store')
      expect(reply.body, target).toBe('')
    }

    expect((await send(port, { host: `127.0.0.1:${port}` })).status).toBe(421)
    expect((await send(port, { host: `attacker.example:${port}` })).status).toBe(421)
    const post = await send(port, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
  })

  it('refuses a second lifecycle on a bound port and leaves a foreign listener untouched', async () => {
    const { app, port } = await startApp()
    await app.serve('preview', await builtRoot('preview'))
    await expectTargetError(() => startTargetApp({ scenario: scenarioOn(port) }), 'TARGET_PORT_UNAVAILABLE')
    expect((await send(port)).status).toBe(200)

    const foreignPort = await freePort()
    const foreign = createServer((_req, res) => res.end('occupied'))
    await listen(foreignPort, foreign)
    cleanups.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())))
    await expectTargetError(() => startTargetApp({ scenario: scenarioOn(foreignPort) }), 'TARGET_PORT_UNAVAILABLE')
    expect(foreign.listening).toBe(true)
    expect((await send(foreignPort)).body).toBe('occupied')
  })

  it('rejects an app URL outside the committed localhost form', async () => {
    for (const url of ['http://127.0.0.1:43119/', 'https://localhost:43119/', 'http://localhost/', 'http://localhost:0/']) {
      const scenario = { ...HERO, scenario: { ...HERO.scenario, app: { ...HERO.scenario.app, url } } }
      await expectTargetError(() => startTargetApp({ scenario }), 'TARGET_URL_INVALID')
    }
  })

  it('releases the port exactly once on close', async () => {
    const { app, port } = await startApp()
    await app.serve('preview', await builtRoot('preview'))

    const first = app.close()
    expect(app.close()).toBe(first)
    await first
    expect(app.stage).toBeNull()
    await expectTargetError(() => app.serve('known-bad', '/unused'), 'TARGET_CLOSED')

    // The port is free again: a plain server can bind it, and a new lifecycle can follow it.
    const successor = createServer((_req, res) => res.end('successor'))
    await listen(port, successor)
    expect((await send(port)).body).toBe('successor')
    await new Promise<void>((resolve) => successor.close(() => resolve()))
    await startOn(port)
  })

  it('serves the committed worktree build through the build port', async () => {
    const { app, port } = await startApp()
    await app.serve('preview', await builtRoot('preview'))
    let builds = 0
    const knownBad = await builtRoot('known-bad')

    await expectTargetError(() => app.serveBuild('preview' as never, { build: async () => ({ documentRoot: knownBad }) }), 'TARGET_STAGE_INVALID')
    await app.serveBuild('known-bad', {
      build: async () => {
        builds += 1
        return { documentRoot: knownBad }
      },
    })
    expect(builds).toBe(1)
    expect(app.stage).toBe('known-bad')

    const failure = Object.assign(new Error('WORKTREE_BUILD_FAILED: the committed build command failed.'), { code: 'WORKTREE_BUILD_FAILED' })
    await expect(
      app.serveBuild('patched', {
        build: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(app.stage).toBe('known-bad')
    expect((await send(port)).body).toContain('<p id="stage">known-bad</p>')
  })
})

describe('iframe reconnection in headless Chromium', () => {
  async function studioPage(): Promise<{ page: Page; frame: Frame }> {
    const page = await (await (browser ??= chromium.launch())).newPage()
    cleanups.push(() => page.close())
    await page.setContent('<!doctype html><html><body><iframe id="target" src="about:blank" width="800" height="600"></iframe></body></html>')
    const frame = await (await page.waitForSelector('#target')).contentFrame()
    if (!frame) throw new Error('The target frame did not attach.')
    return { page, frame }
  }

  it(
    'reconnects the same target iframe to each served build',
    async () => {
      const { app } = await startApp()
      const { page, frame } = await studioPage()

      for (const stage of ['preview', 'known-bad', 'patched'] as const) {
        await app.serve(stage, await builtRoot(stage))
        await app.reconnect(frame, { timeoutMs: 15_000 })
        expect(await frame.textContent('#stage')).toBe(stage)
        expect(frame.url()).toBe(app.url)
      }
      // One page, one target iframe: the frame was reloaded in place, never replaced.
      expect(page.frames()).toHaveLength(2)
      expect(page.frames()[1]).toBe(frame)
    },
    BROWSER_TIMEOUT,
  )

  it(
    'refuses the Studio page itself and an app that serves no build',
    async () => {
      const { app } = await startApp()
      const { page, frame } = await studioPage()

      await expectTargetError(() => app.reconnect(frame), 'TARGET_NOT_SERVING')
      await app.serve('preview', await builtRoot('preview'))
      await expectTargetError(() => app.reconnect(page.mainFrame()), 'TARGET_FRAME_INVALID')
      await expectTargetError(() => app.reconnect(frame, { timeoutMs: 0 }), 'TARGET_TIMEOUT_INVALID')
    },
    BROWSER_TIMEOUT,
  )

  it.each(['counterfeit', 'not-ready'] as const)(
    'accepts readiness only from the committed probe, not a %s one',
    async (kind) => {
      const { app } = await startApp()
      const { frame } = await studioPage()
      await app.serve('preview', await builtRoot('preview', kind))

      await expectTargetError(() => app.reconnect(frame, { timeoutMs: 1_500 }), 'TARGET_PROBE_NOT_READY')
    },
    BROWSER_TIMEOUT,
  )

  it(
    'reports a served build whose document no longer loads as a target load failure',
    async () => {
      const { app } = await startApp()
      const { frame } = await studioPage()
      const root = await builtRoot('known-bad')
      await app.serve('preview', root)
      await rm(path.join(root, 'index.html'))

      let caught: unknown
      await app.reconnect(frame, { timeoutMs: 5_000 }).catch((error: unknown) => {
        caught = error
      })
      expect(caught).toBeInstanceOf(TargetAppError)
      expect((caught as TargetAppError).code).toBe('TARGET_LOAD_FAILED')
      expect(isTargetLoadFailure(caught)).toBe(true)
    },
    BROWSER_TIMEOUT,
  )
})

describe('target load failure classification (T065)', () => {
  it('classifies only a frame that did not load or never became ready', () => {
    for (const code of ['TARGET_LOAD_FAILED', 'TARGET_PROBE_NOT_READY'] as const) {
      expect(isTargetLoadFailure(new TargetAppError(code, 'The target frame did not show the served build.'))).toBe(true)
    }
    for (const code of ['TARGET_FRAME_INVALID', 'TARGET_NOT_SERVING', 'TARGET_ROOT_CHANGED', 'TARGET_CLOSED', 'TARGET_TIMEOUT_INVALID'] as const) {
      expect(isTargetLoadFailure(new TargetAppError(code, 'Another target failure.')), code).toBe(false)
    }
    // Look-alikes that did not come from the target-app owner never count.
    expect(isTargetLoadFailure(Object.assign(new Error('TARGET_LOAD_FAILED: lookalike'), { code: 'TARGET_LOAD_FAILED' }))).toBe(false)
    expect(isTargetLoadFailure({ name: 'TargetAppError', code: 'TARGET_LOAD_FAILED' })).toBe(false)
    expect(isTargetLoadFailure('TARGET_LOAD_FAILED')).toBe(false)
  })
})
