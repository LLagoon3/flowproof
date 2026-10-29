import { request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  LAUNCH_COOKIE_NAME,
  STUDIO_BIND_HOST,
  assertLoopbackAddress,
  buildContentSecurityPolicy,
  checkRequest,
  createLaunchSession,
  withStudioGuards,
} from '../../packages/flowproof/src/studio/auth.js'
import type { LaunchSession } from '../../packages/flowproof/src/studio/auth.js'
import { StudioRequestError, createErrorEnvelope } from '../../packages/flowproof/src/studio/errors.js'

const TARGET_ORIGIN = 'http://localhost:43119'
const SEEDED = 'sk-flowproofseededsecurity001'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

let server: Server
let session: LaunchSession
let port: number

function send(options: {
  readonly method?: string
  readonly path?: string
  readonly headers?: Record<string, string | undefined>
}): Promise<Reply> {
  const headers = Object.fromEntries(
    Object.entries({
      host: `127.0.0.1:${port}`,
      ...options.headers,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/api/scenarios', headers },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

const cookie = (): string => `${LAUNCH_COOKIE_NAME}=${session.launchCookie().value}`

const sameOriginGet = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  cookie: cookie(),
  'sec-fetch-site': 'same-origin',
  ...overrides,
})

const studioPost = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  cookie: cookie(),
  origin: session.origin,
  'content-type': 'application/json',
  ...overrides,
})

function expectEnvelope(reply: Reply, status: number, code: string): void {
  expect(reply.status).toBe(status)
  expect(reply.headers['content-type']).toMatch(/^application\/json/)
  expect(reply.headers['cache-control']).toBe('no-store')
  const parsed = JSON.parse(reply.body) as { error: { code: string; message: string } }
  expect(Object.keys(parsed)).toEqual(['error'])
  expect(Object.keys(parsed.error).sort()).toEqual(['code', 'message'])
  expect(parsed.error.code).toBe(code)
  expect(parsed.error.message.length).toBeGreaterThan(0)
}

beforeAll(async () => {
  server = createServer()
  await new Promise<void>((resolve) => server.listen(0, STUDIO_BIND_HOST, resolve))
  port = (server.address() as AddressInfo).port
  session = createLaunchSession({ port, targetOrigin: TARGET_ORIGIN })
  server.on(
    'request',
    withStudioGuards(session, (req, res) => {
      if (req.url === '/api/fail-known') throw new StudioRequestError(409, 'ACTIVE_RUN_EXISTS', 'This Studio session already has an active run.')
      if (req.url === '/api/fail-unknown') throw new Error(`internal detail ${SEEDED}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, method: req.method }))
    }),
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('loopback binding', () => {
  it('binds the Studio to 127.0.0.1 only', () => {
    expect(STUDIO_BIND_HOST).toBe('127.0.0.1')
    expect(() => assertLoopbackAddress(server.address())).not.toThrow()
  })

  it.each([
    [{ address: '0.0.0.0', family: 'IPv4', port: 1 }],
    [{ address: '::', family: 'IPv6', port: 1 }],
    [{ address: '192.168.1.20', family: 'IPv4', port: 1 }],
    ['/tmp/flowproof.sock'],
    [null],
  ])('rejects the non-loopback binding %j', (address) => {
    expect(() => assertLoopbackAddress(address as AddressInfo | string | null)).toThrow(/STUDIO_BIND_NOT_LOOPBACK/)
  })

  it('rejects a request from a non-loopback peer', () => {
    const verdict = checkRequest(
      {
        method: 'GET',
        url: '/api/scenarios',
        headers: { host: session.authority, cookie: cookie(), 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '10.0.0.5' },
      },
      session,
    )

    expect(verdict).toMatchObject({ ok: false, status: 403, code: 'REMOTE_NOT_LOOPBACK' })
  })
})

describe('launch session', () => {
  it('derives the exact Studio origin and authority from the bound port', () => {
    expect(session.origin).toBe(`http://127.0.0.1:${port}`)
    expect(session.authority).toBe(`127.0.0.1:${port}`)
    expect(session.targetOrigin).toBe(TARGET_ORIGIN)
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('issues an HttpOnly SameSite=Strict cookie scoped to the Studio host for Playwright injection', () => {
    const launchCookie = session.launchCookie()

    expect(launchCookie).toMatchObject({
      name: LAUNCH_COOKIE_NAME,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    })
    expect(launchCookie.value.length).toBeGreaterThanOrEqual(43)
  })

  it('never serializes the launch credential', () => {
    const serialized = JSON.stringify(session)

    expect(serialized).not.toContain(session.launchCookie().value)
    expect(serialized).toContain(session.sessionId)
  })

  it('issues an independent credential per launch', () => {
    const other = createLaunchSession({ port, targetOrigin: TARGET_ORIGIN })

    expect(other.launchCookie().value).not.toBe(session.launchCookie().value)
    expect(other.sessionId).not.toBe(session.sessionId)
  })

  it.each([
    [{ port: 0, targetOrigin: TARGET_ORIGIN }],
    [{ port: 70_000, targetOrigin: TARGET_ORIGIN }],
    [{ port: 4000, targetOrigin: 'http://127.0.0.1:43119' }],
    [{ port: 4000, targetOrigin: 'https://localhost:43119' }],
    [{ port: 4000, targetOrigin: 'http://localhost:43119/path' }],
    [{ port: 4000, targetOrigin: 'http://example.com:43119' }],
  ])('rejects the unsafe launch configuration %j', (options) => {
    expect(() => createLaunchSession(options)).toThrow(/STUDIO_LAUNCH_CONFIG_INVALID/)
  })
})

describe('response headers', () => {
  it('applies no-store and a restrictive CSP that frames only the demo origin', async () => {
    const reply = await send({ headers: sameOriginGet() })
    const csp = String(reply.headers['content-security-policy'])

    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(csp).toBe(buildContentSecurityPolicy(TARGET_ORIGIN))
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain(`frame-src ${TARGET_ORIGIN}`)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('*')
  })

  it('applies the same headers to rejected requests', async () => {
    const reply = await send({ headers: { 'sec-fetch-site': 'same-origin' } })

    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['content-security-policy']).toBe(buildContentSecurityPolicy(TARGET_ORIGIN))
  })
})

describe('Host validation', () => {
  it.each([
    ['the demo host on the Studio port', (studioPort: number) => `localhost:${studioPort}`],
    ['a foreign host', () => 'evil.example'],
    ['the loopback address without a port', () => '127.0.0.1'],
    ['the loopback address on another port', () => '127.0.0.1:1'],
    ['an IPv6 loopback authority', (studioPort: number) => `[::1]:${studioPort}`],
  ])('rejects %s', async (_label, host) => {
    expectEnvelope(await send({ headers: sameOriginGet({ host: host(port) }) }), 403, 'HOST_REJECTED')
  })
})

describe('GET and SSE request context', () => {
  it('accepts a same-origin GET without an Origin header', async () => {
    const reply = await send({ headers: sameOriginGet() })

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ ok: true, method: 'GET' })
  })

  it('accepts a same-origin EventSource request', async () => {
    const reply = await send({
      path: '/api/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/events',
      headers: sameOriginGet({ accept: 'text/event-stream' }),
    })

    expect(reply.status).toBe(200)
  })

  it.each([undefined, 'cross-site', 'same-site', 'none'])('rejects Sec-Fetch-Site %s on API reads', async (site) => {
    expectEnvelope(await send({ headers: sameOriginGet({ 'sec-fetch-site': site }) }), 403, 'FETCH_SITE_REJECTED')
  })

  it('rejects a GET that carries a foreign Origin', async () => {
    expectEnvelope(await send({ headers: sameOriginGet({ origin: TARGET_ORIGIN }) }), 403, 'ORIGIN_REJECTED')
  })

  it.each([
    ['missing', undefined],
    ['wrong', `${LAUNCH_COOKIE_NAME}=${'A'.repeat(43)}`],
    ['short', `${LAUNCH_COOKIE_NAME}=abc`],
    ['other-name', `other=${'A'.repeat(43)}`],
  ])('rejects a %s launch cookie', async (_label, value) => {
    expectEnvelope(await send({ headers: sameOriginGet({ cookie: value }) }), 401, 'LAUNCH_SESSION_REQUIRED')
  })

  it('allows the browser-initiated Studio document navigation with the launch cookie', async () => {
    const navigation = {
      cookie: cookie(),
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    }

    expect((await send({ path: '/', headers: navigation })).status).toBe(200)
    expectEnvelope(await send({ path: '/', headers: { ...navigation, cookie: undefined } }), 401, 'LAUNCH_SESSION_REQUIRED')
    expectEnvelope(
      await send({ path: '/', headers: { ...navigation, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } }),
      403,
      'FETCH_SITE_REJECTED',
    )
    expectEnvelope(await send({ path: '/api/scenarios', headers: navigation }), 403, 'FETCH_SITE_REJECTED')
  })
})

describe('POST request context', () => {
  it('accepts a POST with the exact Studio Origin and launch cookie', async () => {
    const reply = await send({ method: 'POST', path: '/api/runs', headers: studioPost() })

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ ok: true, method: 'POST' })
  })

  it.each([
    ['a missing Origin', () => undefined],
    ['the demo origin', () => TARGET_ORIGIN],
    ['an opaque origin', () => 'null'],
    ['the loopback origin without a port', () => 'http://127.0.0.1'],
    ['the localhost spelling of the Studio origin', (studioPort: number) => `http://localhost:${studioPort}`],
    ['a trailing-slash Studio origin', (studioPort: number) => `http://127.0.0.1:${studioPort}/`],
  ])('rejects POST with %s', async (_label, origin) => {
    expectEnvelope(
      await send({ method: 'POST', path: '/api/runs', headers: studioPost({ origin: origin(port) }) }),
      403,
      'ORIGIN_REJECTED',
    )
  })

  it('rejects a POST without the launch cookie', async () => {
    expectEnvelope(
      await send({ method: 'POST', path: '/api/runs', headers: studioPost({ cookie: undefined }) }),
      401,
      'LAUNCH_SESSION_REQUIRED',
    )
  })

  it('rejects a POST whose fetch metadata reports a cross-site initiator', async () => {
    expectEnvelope(
      await send({ method: 'POST', path: '/api/runs', headers: studioPost({ 'sec-fetch-site': 'cross-site' }) }),
      403,
      'FETCH_SITE_REJECTED',
    )
  })

  it.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])('rejects the %s method', async (method) => {
    expectEnvelope(await send({ method, path: '/api/runs', headers: studioPost() }), 405, 'METHOD_NOT_ALLOWED')
  })
})

describe('request target validation', () => {
  it.each([
    '/api/../secret',
    '/api/%2e%2e/secret',
    '/api/runs/%2E%2E%2Fetc',
    '/assets/..%2f..%2fpackage.json',
    '/api/runs/x%5c..%5cy',
    '/api/runs/x%00',
    '/api/./scenarios',
    '//evil.example/api',
    '/api\\runs',
  ])('rejects the traversal target %s', async (target) => {
    expectEnvelope(await send({ path: target, headers: sameOriginGet() }), 400, 'PATH_REJECTED')
  })

  it('rejects absolute-form request targets', () => {
    const verdict = checkRequest(
      {
        method: 'GET',
        url: `http://127.0.0.1:${port}/api/scenarios`,
        headers: { host: session.authority, cookie: cookie(), 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      session,
    )

    expect(verdict).toMatchObject({ ok: false, status: 400, code: 'PATH_REJECTED' })
  })
})

describe('error envelope', () => {
  it('maps a handler request error to its stable envelope', async () => {
    expectEnvelope(await send({ path: '/api/fail-known', headers: sameOriginGet() }), 409, 'ACTIVE_RUN_EXISTS')
  })

  it('hides internal error details behind a generic envelope', async () => {
    const reply = await send({ path: '/api/fail-unknown', headers: sameOriginGet() })

    expectEnvelope(reply, 500, 'INTERNAL_ERROR')
    expect(reply.body).not.toContain(SEEDED)
    expect(reply.body).not.toContain('internal detail')
  })

  it('never echoes rejected credentials, cookies, or header values', async () => {
    const replies = await Promise.all([
      send({ headers: sameOriginGet({ host: `${SEEDED}.example` }) }),
      send({ method: 'POST', path: '/api/runs', headers: studioPost({ origin: `http://${SEEDED}.example` }) }),
      send({ headers: sameOriginGet({ cookie: `${LAUNCH_COOKIE_NAME}=${SEEDED}` }) }),
      send({ path: `/api/${SEEDED}/%2e%2e/x`, headers: sameOriginGet() }),
    ])

    for (const reply of replies) {
      expect(reply.status).toBeGreaterThanOrEqual(400)
      expect(reply.body).not.toContain(SEEDED)
    }
  })

  it('builds envelopes with sanitized messages and stable codes only', () => {
    expect(createErrorEnvelope('ACTIVE_RUN_EXISTS', 'This Studio session already has an active run.')).toEqual({
      error: { code: 'ACTIVE_RUN_EXISTS', message: 'This Studio session already has an active run.' },
    })
    expect(createErrorEnvelope('lower_case', 'x').error.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(createErrorEnvelope('PROVIDER_FAILED', `Bearer ${SEEDED}`))).not.toContain(SEEDED)
    expect(createErrorEnvelope('PROVIDER_FAILED', 'm'.repeat(2_000)).error.message.length).toBeLessThanOrEqual(300)
    expect(createErrorEnvelope('PROVIDER_FAILED', '').error.message.length).toBeGreaterThan(0)
  })
})
