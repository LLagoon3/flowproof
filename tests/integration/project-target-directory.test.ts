import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { afterEach, describe, expect, it } from 'vitest'

import { PROJECT_TARGET_SANDBOX, confirmProjectTargetReady, startProjectTargetApp } from '../../packages/flowproof/src/studio/targetApp.js'
import type { ProjectTargetApp } from '../../packages/flowproof/src/studio/targetApp.js'

// Spec 006 review fix: a confirmed nested entry such as `/app/` is a closed directory request that
// the production project target answers with its registered `app/index.html` (same bytes, hash
// check and target policy as the explicit file), while every path-confusion form stays refused.

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const POLICY_HEADERS = ['cache-control', 'content-type', 'content-length', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'permissions-policy']
const FILES: Readonly<Record<string, Buffer>> = {
  'index.html': Buffer.from('<!doctype html><title>root</title>'),
  'app/index.html': Buffer.from('<!doctype html><html><head><title>nested app</title></head><body>nested<script src="main.js"></script></body></html>'),
  'app/main.js': Buffer.from('document.body.dataset.ready = "yes"\n'),
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A real project target serving an owned temporary output whose confirmed entry is `/app/`. */
async function nestedTarget(studioOrigin = 'http://127.0.0.1:43141'): Promise<ProjectTargetApp> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowproof-s2-directory-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const [relative, bytes] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), bytes)
  }
  // Present on disk but not part of the accepted output, so never served.
  await mkdir(path.join(root, 'extra'))
  await writeFile(path.join(root, 'extra/index.html'), 'unregistered')
  const target = await startProjectTargetApp({ port: 0 })
  cleanups.push(() => target.close())
  target.setFrameAncestor(studioOrigin)
  const files = Object.entries(FILES).map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha256(bytes) }))
  await target.serve({ root, sha256: sha256(JSON.stringify(files)), files }, { entryPath: '/app/' })
  return target
}

function get(target: ProjectTargetApp, rawPath: string, method = 'GET', host = `localhost:${target.port}`): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: target.port, method, path: rawPath, headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const policyOf = (headers: IncomingHttpHeaders): Record<string, unknown> => Object.fromEntries(POLICY_HEADERS.map((name) => [name, headers[name]]))

describe('nested project entry directory requests', () => {
  it('serves a confirmed nested directory entry as its registered index with identical bytes and policy', async () => {
    const target = await nestedTarget()
    const explicit = await get(target, '/app/index.html')
    expect(explicit.status).toBe(200)
    expect(explicit.body.equals(FILES['app/index.html']!)).toBe(true)
    expect(explicit.headers['content-security-policy']).toContain("frame-ancestors http://127.0.0.1:43141")

    for (const directory of ['/app/', '/app/?synthetic=1']) {
      const response = await get(target, directory)
      expect(response.status, directory).toBe(200)
      expect(response.body.equals(FILES['app/index.html']!), directory).toBe(true)
      expect(policyOf(response.headers), directory).toEqual(policyOf(explicit.headers))
    }
    const head = await get(target, '/app/', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect(policyOf(head.headers)).toEqual(policyOf(explicit.headers))

    // Root, file and method/authority/serving controls are unchanged.
    expect((await get(target, '/')).body.equals(FILES['index.html']!)).toBe(true)
    expect((await get(target, '/app/main.js')).status).toBe(200)
    expect((await get(target, '/app/', 'POST')).status).toBe(405)
    expect((await get(target, '/app/', 'GET', `127.0.0.1:${target.port}`)).status).toBe(421)
    target.unserve()
    expect((await get(target, '/app/')).status).toBe(503)
  })

  it('keeps every path-confusion form of a directory request refused', async () => {
    const target = await nestedTarget()
    const refused = [
      '/app', '/app//', '//app/', '/app/./', '/./app/', '/app/../app/', '/../app/', '/%2e%2e/app/', '/app%2F', '/app%2f/',
      '/app%2Findex.html', '/app\\', '/app/main.js/', '/app/index.html/', '/extra/', '/missing/', '/app/%00/',
    ]
    for (const rawPath of refused) {
      for (const method of ['GET', 'HEAD']) {
        const response = await get(target, rawPath, method)
        expect(response.status, `${method} ${rawPath}`).toBe(404)
        expect(response.body.length, `${method} ${rawPath}`).toBe(0)
      }
    }
  })

  it('confirms readiness of a nested directory entry in an actual headed target frame', async () => {
    const host = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(`<!doctype html><html><body><iframe id="target" sandbox="${PROJECT_TARGET_SANDBOX}" src="about:blank"></iframe></body></html>`)
    })
    await new Promise<void>((resolve, reject) => {
      host.once('error', reject)
      host.listen(0, '127.0.0.1', () => resolve())
    })
    cleanups.push(() => new Promise<void>((resolve) => host.close(() => resolve())))
    const hostOrigin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
    const target = await nestedTarget(hostOrigin)
    const browser = await chromium.launch({ headless: false })
    cleanups.push(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${hostOrigin}/`)
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
    expect(frame).toBeDefined()

    await confirmProjectTargetReady(frame!, target, { entryPath: '/app/', entrySha256: sha256(FILES['app/index.html']!), timeoutMs: 15_000 })
    expect(frame!.url()).toBe(`${target.origin}/app/`)
    // The nested document's relative asset resolved against the directory and ran in the frame.
    await expect.poll(() => frame!.evaluate(() => document.body.dataset.ready ?? null)).toBe('yes')
  }, 60_000)
})
