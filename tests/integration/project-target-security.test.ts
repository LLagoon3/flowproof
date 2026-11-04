import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Frame, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { admissionProfileOf, createExecutionConfiguration, readRuntimeManifest, suggestProjectSettings, verifyRuntimeImage } from '../../packages/flowproof/src/project/profile.js'
import type { RuntimeProfile } from '../../packages/flowproof/src/project/profile.js'
import { RUNTIME_LABEL, createProjectRuntime } from '../../packages/flowproof/src/project/runtime.js'
import type { ImmutableOutput, ProjectRuntime } from '../../packages/flowproof/src/project/runtime.js'
import { exportProjectSnapshot } from '../../packages/flowproof/src/project/snapshot.js'
import { PROJECT_BROWSER_CONTEXT_OPTIONS, installProjectBrowserPolicy } from '../../packages/flowproof/src/studio/launch.js'
import type { ProjectBrowserPolicy } from '../../packages/flowproof/src/studio/launch.js'
import { startStudioServer } from '../../packages/flowproof/src/studio/server.js'
import type { StudioServerHandle } from '../../packages/flowproof/src/studio/server.js'
import { PROJECT_TARGET_SANDBOX, TargetAppError, confirmProjectTargetReady, startProjectTargetApp } from '../../packages/flowproof/src/studio/targetApp.js'
import type { ProjectTargetApp } from '../../packages/flowproof/src/studio/targetApp.js'
import { materializeProjectLiveRepository } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { commitFiles, containersWithLabel, runtimeManifestPath, sampleConfigFile } from '../support/projectSetup.js'

// T012: the actual built target, served by FlowProof at its own `localhost` origin and confined in
// the browser. The target application here is a test-authored hostile variant of the sample that
// is admitted, built by the real offline runtime in the operator image and served from its
// immutable output; it tries to reach the Studio, other loopback ports, private and external hosts,
// WebSockets, service workers, popups, downloads, top-level and cross-origin navigation. The Studio
// server runs in project mode; its page here is a minimal labelled test host page that frames the
// target with the production sandbox value (the real Studio UI is covered by
// tests/e2e/project-setup.spec.ts). The browser context uses the production project policy.

const TARGET_PORT = 43151
const DECOY_LOOPBACK_PORT = 43152
const DECOY_LOCALHOST_PORT = 43153
const TIMEOUT = 240_000

const HOSTILE_MAIN = String.raw`
const params = new URLSearchParams(location.search)
const results = {}
const record = (name, value) => { results[name] = value; document.body.dataset.results = JSON.stringify(results) }
const tryFetch = async (name, url, init = {}) => {
  try { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) }); record(name, 'status:' + response.status) } catch { record(name, 'blocked') }
}
const socket = (name, url) => new Promise((resolve) => {
  let ws
  try { ws = new WebSocket(url) } catch { record(name, 'blocked'); resolve(); return }
  const timer = setTimeout(() => { record(name, results[name] ?? 'blocked'); resolve() }, 4000)
  ws.onopen = () => { clearTimeout(timer); record(name, 'open'); resolve() }
  ws.onerror = () => { clearTimeout(timer); record(name, 'blocked'); resolve() }
  ws.onclose = () => { clearTimeout(timer); if (!results[name]) record(name, 'blocked'); resolve() }
})
const run = async () => {
  await tryFetch('self', '/index.html')
  await tryFetch('studio', params.get('studio') + '/api/project/context', { credentials: 'include' })
  await tryFetch('otherLoopback', 'http://127.0.0.1:' + params.get('loop') + '/fetch')
  await tryFetch('otherLocalhost', 'http://localhost:' + params.get('local') + '/fetch')
  await tryFetch('private', 'http://10.255.255.1/fetch')
  await tryFetch('external', 'https://example.com/')
  await new Promise((resolve) => {
    const image = new Image()
    image.onload = () => { record('image', 'loaded'); resolve() }
    image.onerror = () => { record('image', 'blocked'); resolve() }
    image.src = 'http://127.0.0.1:' + params.get('loop') + '/pixel.png'
  })
  await socket('websocketSelf', 'ws://localhost:' + location.port + '/socket')
  await socket('websocketLoopback', 'ws://127.0.0.1:' + params.get('loop') + '/socket')
  try { await navigator.serviceWorker.register('/sw.js'); record('serviceWorker', 'registered') } catch { record('serviceWorker', 'blocked') }
  try { const opened = window.open('https://example.com/', '_blank'); record('popup', opened ? 'opened' : 'blocked') } catch { record('popup', 'blocked') }
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(new Blob(['payload']))
  anchor.download = 'payload.txt'
  document.body.append(anchor)
  anchor.click()
  if (params.get('topNavigation') === 'yes') {
    try { window.top.location.href = 'http://127.0.0.1:' + params.get('loop') + '/top'; record('topNavigation', 'attempted') } catch { record('topNavigation', 'blocked') }
  }
  const nested = document.createElement('iframe')
  nested.src = 'http://127.0.0.1:' + params.get('loop') + '/frame'
  document.body.append(nested)
  const button = document.createElement('button')
  button.id = 'navigate-away'
  button.textContent = 'Navigate away'
  button.onclick = () => { location.href = 'http://127.0.0.1:' + params.get('loop') + '/navigated' }
  document.body.append(button)
  await new Promise((resolve) => setTimeout(resolve, 500))
  record('done', true)
}
run()
`

let profile: RuntimeProfile
let runtime: ProjectRuntime
let repository: MaterializedProjectRepository
let project: AdmittedProject
let output: ImmutableOutput
let target: ProjectTargetApp
let server: StudioServerHandle
let browser: Browser
let context: BrowserContext
let page: Page
let policy: ProjectBrowserPolicy
let hostRoot: string
const decoyHits: string[] = []
const decoys: Server[] = []

async function decoy(port: number, host: string): Promise<void> {
  const decoyServer = createServer((req, res) => {
    decoyHits.push(`${host}:${port}${req.url ?? ''}`)
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    res.end('decoy')
  })
  decoyServer.on('upgrade', (req, socket) => {
    decoyHits.push(`upgrade ${host}:${port}${req.url ?? ''}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => decoyServer.listen(port, host, resolve))
  decoys.push(decoyServer)
}

function targetRequest(method: string, rawPath: string, host = `localhost:${TARGET_PORT}`): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: TARGET_PORT, method, path: rawPath, headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function results(frame: Frame): Promise<Record<string, unknown>> {
  await frame.waitForFunction(() => JSON.parse(document.body.dataset.results ?? '{}').done === true, undefined, { timeout: 60_000 })
  return frame.evaluate(() => JSON.parse(document.body.dataset.results ?? '{}') as Record<string, unknown>)
}

function targetFrame(): Frame {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  if (frame === undefined) throw new Error('no target frame')
  return frame
}

beforeAll(async () => {
  profile = await readRuntimeManifest(runtimeManifestPath())
  await verifyRuntimeImage(profile)
  runtime = createProjectRuntime({ profile })
  repository = await materializeProjectLiveRepository()
  await commitFiles(repository.root, { 'src/main.jsx': HOSTILE_MAIN, 'public/sw.js': "self.addEventListener('fetch', () => {})\n" }, 'Hostile target variant')
  const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error(`hostile variant admission failed: ${admission.reasons.join(',')}`)
  project = admission.project
  const file = await sampleConfigFile()
  const configured = createExecutionConfiguration({
    project,
    profile,
    settings: { entry_path: '/', build: file.build, required_project_checks: [] },
    targetOrigin: `http://localhost:${TARGET_PORT}`,
    confirmedAt: new Date().toISOString(),
  })
  if (!configured.ok) throw new Error('configuration refused')
  const snapshot = await exportProjectSnapshot({ project, purpose: 'admission-snapshot' })
  try {
    const build = await runtime.build({ snapshot, configuration: configured.configuration })
    if (build.output === null) throw new Error(`hostile variant build failed: ${build.status === 'failed' ? build.reason : ''}`)
    output = build.output
  } finally {
    await snapshot.remove()
  }
  expect(output.files.map((entry) => entry.path)).toContain('sw.js')

  await decoy(DECOY_LOOPBACK_PORT, '127.0.0.1')
  await decoy(DECOY_LOCALHOST_PORT, 'localhost')
  target = await startProjectTargetApp({ port: TARGET_PORT })

  // LABELLED TEST HOST PAGE (not the Studio UI): one iframe with the production sandbox value.
  hostRoot = await mkdtemp(path.join(tmpdir(), 'flowproof-s2-security-host-'))
  // The server validates its temporary document root before binding; the final page needs its
  // assigned origin, so install a harmless placeholder first and replace it after startup.
  await writeFile(path.join(hostRoot, 'index.html'), '<!doctype html><html><body>starting security host</body></html>')
  server = await startStudioServer({
    targetOrigin: target.origin,
    studioRoot: hostRoot,
    project: {
      context: project.context,
      modelConfigured: false,
      suggestion: suggestProjectSettings(project),
      initialSettings: null,
      configure: () => ({ ok: false, reasons: ['UNUSED'] }),
      prepare: () => Promise.reject(new Error('unused')),
      release: async () => undefined,
    },
  })
  const query = `?studio=${encodeURIComponent(server.origin)}&loop=${DECOY_LOOPBACK_PORT}&local=${DECOY_LOCALHOST_PORT}`
  await writeFile(
    path.join(hostRoot, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>S2 security test host page</title></head><body><iframe id="target" sandbox="${PROJECT_TARGET_SANDBOX}" src="${target.origin}/${query}"></iframe></body></html>`,
  )
  target.setFrameAncestor(server.origin)
  await target.serve(output, { entryPath: '/' })

  browser = await chromium.launch()
  context = await browser.newContext({ ...PROJECT_BROWSER_CONTEXT_OPTIONS, viewport: { width: 1280, height: 800 } })
  await context.addCookies([server.session.launchCookie()])
  page = await context.newPage()
  policy = await installProjectBrowserPolicy(context, { studioOrigin: server.origin, targetOrigin: target.origin, studioPage: () => page })
  const response = await page.goto(`${server.origin}/`, { waitUntil: 'load' })
  expect(response?.status()).toBe(200)
}, TIMEOUT)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  await target?.close()
  for (const decoyServer of decoys) await new Promise<void>((resolve) => decoyServer.close(() => resolve()))
  await output?.remove()
  if (hostRoot) await rm(hostRoot, { recursive: true, force: true })
  expect(await runtime.dispose()).toBe(true)
  await repository?.remove()
  expect(await containersWithLabel(RUNTIME_LABEL)).toEqual([])
}, TIMEOUT)

describe('actual built target identity and confinement', () => {
  it('serves exactly the immutable build output at its exact authority with the target policy headers', async () => {
    const index = await targetRequest('GET', '/')
    expect(index.status).toBe(200)
    const indexFile = output.files.find((file) => file.path === 'index.html')!
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(index.body).digest('hex')).toBe(indexFile.sha256)
    const csp = String(index.headers['content-security-policy'])
    for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", `frame-ancestors ${server.origin}`]) {
      expect(csp).toContain(directive)
    }
    expect(index.headers['cache-control']).toBe('no-store')
    expect(index.headers['x-content-type-options']).toBe('nosniff')

    // Sources, dependencies, metadata, traversal, other authorities and methods are not served.
    for (const route of ['/src/main.jsx', '/package.json', '/node_modules/react/package.json', '/.git/config', '/../package.json', '/%2e%2e/package.json', '/assets/../../etc/passwd']) {
      expect((await targetRequest('GET', route)).status).toBe(404)
    }
    expect((await targetRequest('GET', '/', `127.0.0.1:${TARGET_PORT}`)).status).toBe(421)
    expect((await targetRequest('GET', '/', `localhost:${TARGET_PORT + 1}`)).status).toBe(421)
    expect((await targetRequest('POST', '/')).status).toBe(405)
  })

  it('never follows a link planted into the served output', async () => {
    await chmod(output.root, 0o755)
    try {
      await symlink('/etc/hostname', path.join(output.root, 'planted.txt'))
      expect((await targetRequest('GET', '/planted.txt')).status).toBe(404)
    } finally {
      await rm(path.join(output.root, 'planted.txt'), { force: true })
      await chmod(output.root, 0o555)
    }
  })

  it('confirms readiness from the frame by exact document identity, not a page-global probe', async () => {
    const frame = targetFrame()
    const indexFile = output.files.find((file) => file.path === 'index.html')!
    await expect(confirmProjectTargetReady(frame, target, { entryPath: '/', entrySha256: 'f'.repeat(64), timeoutMs: 20_000 })).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' })
    await confirmProjectTargetReady(frame, target, { entryPath: '/', entrySha256: indexFile.sha256, timeoutMs: 20_000 })
    expect(new URL(frame.url()).origin).toBe(target.origin)
  })
})

describe('browser confinement of target code', () => {
  it('denies the Studio, other loopback, private and external hosts, WebSockets, service workers, popups and downloads', async () => {
    const query = `?studio=${encodeURIComponent(server.origin)}&loop=${DECOY_LOOPBACK_PORT}&local=${DECOY_LOCALHOST_PORT}&topNavigation=yes`
    const frame = targetFrame()
    const downloads: unknown[] = []
    page.on('download', (download) => downloads.push(download))
    const pagesBefore = context.pages().length
    await frame.goto(`${target.origin}/${query}`, { waitUntil: 'load' })
    const observed = await results(frame)
    expect(observed).toMatchObject({
      self: 'status:200',
      studio: 'blocked',
      otherLoopback: 'blocked',
      otherLocalhost: 'blocked',
      private: 'blocked',
      external: 'blocked',
      image: 'blocked',
      websocketSelf: 'blocked',
      websocketLoopback: 'blocked',
      popup: 'blocked',
      done: true,
    })
    await page.waitForTimeout(1_000)
    expect(page.url()).toBe(`${server.origin}/`)
    expect(context.pages()).toHaveLength(pagesBefore)
    expect(downloads).toHaveLength(0)
    expect(context.serviceWorkers()).toHaveLength(0)
    expect(decoyHits).toEqual([])
    expect(policy.blocked().every((entry) => entry.origin !== server.origin && entry.origin !== target.origin)).toBe(true)
  }, TIMEOUT)

  it('rejects target navigation to a different origin in the browser policy', async () => {
    // CSP is tested with the production context above. Bypass CSP only in this second, isolated
    // context so the route allowlist itself is exercised independently of the browser's CSP layer.
    const policyContext = await browser.newContext({ ...PROJECT_BROWSER_CONTEXT_OPTIONS, bypassCSP: true })
    try {
      await policyContext.addCookies([server.session.launchCookie()])
      const policyPage = await policyContext.newPage()
      const routePolicy = await installProjectBrowserPolicy(policyContext, {
        studioOrigin: server.origin,
        targetOrigin: target.origin,
        studioPage: () => policyPage,
      })
      await policyPage.goto(`${server.origin}/`, { waitUntil: 'load' })
      const query = `?studio=${encodeURIComponent(server.origin)}&loop=${DECOY_LOOPBACK_PORT}&local=${DECOY_LOCALHOST_PORT}&topNavigation=no&policyNavigation=1`
      const url = `${target.origin}/${query}`
      const navigating = policyPage.waitForEvent('framenavigated', { predicate: (candidate) => candidate.url() === url })
      await policyPage.evaluate((src) => {
        const frame = document.createElement('iframe')
        frame.name = 'policy-navigation-target'
        frame.src = src
        document.body.append(frame)
      }, url)
      const frame = await navigating
      await results(frame)
      await frame.click('#navigate-away')
      await policyPage.waitForTimeout(750)
      const frameOrigin = new URL(frame.url()).origin
      // Chromium may replace a rejected navigation with its opaque error page, but never commits
      // the disallowed origin or reaches the decoy server.
      expect([target.origin, 'null']).toContain(frameOrigin)
      expect(routePolicy.blocked().some((entry) => entry.kind === 'navigation' && entry.origin === `http://127.0.0.1:${DECOY_LOOPBACK_PORT}`)).toBe(true)
      expect(policyPage.url()).toBe(`${server.origin}/`)
      expect(decoyHits).toEqual([])
    } finally {
      await policyContext.close()
    }
  }, TIMEOUT)

  it('stops serving before anything else once unserved, and refuses readiness for an unserved target', async () => {
    target.unserve()
    expect((await targetRequest('GET', '/')).status).toBe(503)
    await expect(confirmProjectTargetReady(targetFrame(), target, { entryPath: '/', entrySha256: 'f'.repeat(64), timeoutMs: 5_000 })).rejects.toBeInstanceOf(TargetAppError)
  })
})
