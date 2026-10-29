import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StudioRequestError, sendError, sendInternalError } from './errors.js'

// Request guards for the loopback Studio. The Studio listens only on 127.0.0.1 while the
// model-patched demo app is framed from `localhost`, so the launch cookie is never sent to
// target code. Every request must name the exact Studio authority; reads need same-origin
// fetch metadata, writes need the exact Studio Origin, and both need the launch cookie.

export const STUDIO_BIND_HOST = '127.0.0.1'
export const LAUNCH_COOKIE_NAME = 'flowproof_launch'

const TARGET_ORIGIN_PATTERN = /^http:\/\/localhost:([0-9]{1,5})$/
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::ffff:127.0.0.1'])

export class StudioSecurityError extends Error {
  readonly code: 'STUDIO_BIND_NOT_LOOPBACK' | 'STUDIO_LAUNCH_CONFIG_INVALID'

  constructor(code: StudioSecurityError['code'], message: string) {
    super(`${code}: ${message}`)
    this.name = 'StudioSecurityError'
    this.code = code
  }
}

/** The cookie shape Playwright `context.addCookies()` accepts. */
export interface LaunchCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: '/'
  readonly httpOnly: true
  readonly secure: false
  readonly sameSite: 'Strict'
}

export interface LaunchSession {
  readonly sessionId: string
  /** Exact Studio origin, for example `http://127.0.0.1:43117`. */
  readonly origin: string
  /** Exact `Host` header value the Studio accepts. */
  readonly authority: string
  /** The only origin the Studio may frame. */
  readonly targetOrigin: string
  launchCookie(): LaunchCookie
  hasLaunchCookie(cookieHeader: string | undefined): boolean
  toJSON(): { readonly sessionId: string; readonly origin: string; readonly targetOrigin: string }
}

const isPort = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 65_535

function assertTargetOrigin(targetOrigin: string): void {
  const match = TARGET_ORIGIN_PATTERN.exec(targetOrigin)
  if (!match || !isPort(Number(match[1]))) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The framed target must be an http://localhost:<port> origin.')
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  let found: string | null = null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    if (found !== null) return null
    found = part.slice(separator + 1).trim()
  }
  return found
}

/** Creates the in-memory launch credential for one Studio bound to `127.0.0.1:<port>`. */
export function createLaunchSession(options: { readonly port: number; readonly targetOrigin: string }): LaunchSession {
  if (!isPort(options.port)) throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The Studio port is invalid.')
  assertTargetOrigin(options.targetOrigin)
  const token = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()
  const authority = `${STUDIO_BIND_HOST}:${options.port}`
  const origin = `http://${authority}`
  const { targetOrigin } = options
  return Object.freeze({
    sessionId,
    origin,
    authority,
    targetOrigin,
    launchCookie: (): LaunchCookie =>
      Object.freeze({
        name: LAUNCH_COOKIE_NAME,
        value: token,
        domain: STUDIO_BIND_HOST,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      }),
    hasLaunchCookie(cookieHeader: string | undefined): boolean {
      const presented = readCookie(cookieHeader, LAUNCH_COOKIE_NAME)
      if (presented === null) return false
      const expected = Buffer.from(token)
      const actual = Buffer.from(presented)
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    },
    toJSON: () => ({ sessionId, origin, targetOrigin }),
  })
}

/** Restricts the Studio to its own bundle and API and frames only the prepared target. */
export function buildContentSecurityPolicy(targetOrigin: string): string {
  assertTargetOrigin(targetOrigin)
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${targetOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
}

export function applySecurityHeaders(res: ServerResponse, session: LaunchSession): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(session.targetOrigin))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

/** Throws unless the server is bound to exactly the IPv4 loopback address. */
export function assertLoopbackAddress(address: AddressInfo | string | null): void {
  if (address === null || typeof address === 'string' || address.address !== STUDIO_BIND_HOST) {
    throw new StudioSecurityError('STUDIO_BIND_NOT_LOOPBACK', 'The Studio must listen only on 127.0.0.1.')
  }
}

/** True for an origin-form target without traversal, encoded separators, or control bytes. */
function isSafeRequestTarget(target: string | undefined): target is string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return false
  const rawPath = target.split(/[?#]/, 1)[0] ?? ''
  if (/[\\\u0000-\u001f\u007f]/.test(rawPath) || /%(?:2e|2f|5c|00)/i.test(rawPath)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return false
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return false
  return !decoded.split('/').some((segment) => segment === '.' || segment === '..')
}

export interface GuardedRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly socket: { readonly remoteAddress?: string | undefined }
}

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

const reject = (status: number, code: string, message: string): GuardVerdict => ({ ok: false, status, code, message })
const header = (request: GuardedRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * Validates the peer, Host, request target, method, browser request context, and launch
 * cookie. Same-origin GET and EventSource requests may omit `Origin`; a present Origin must
 * still be exact. The browser-initiated Studio document navigation (`Sec-Fetch-Site: none`)
 * is accepted only outside `/api/`.
 */
export function checkRequest(request: GuardedRequest, session: LaunchSession): GuardVerdict {
  if (!LOOPBACK_PEERS.has(request.socket.remoteAddress ?? '')) {
    return reject(403, 'REMOTE_NOT_LOOPBACK', 'The Studio accepts loopback connections only.')
  }
  if (header(request, 'host') !== session.authority) {
    return reject(403, 'HOST_REJECTED', 'The request Host does not match the Studio.')
  }
  if (!isSafeRequestTarget(request.url)) {
    return reject(400, 'PATH_REJECTED', 'The request path is not allowed.')
  }
  const method = request.method ?? 'GET'
  const origin = header(request, 'origin')
  const site = header(request, 'sec-fetch-site')
  if (method === 'GET' || method === 'HEAD') {
    if (origin !== undefined && origin !== session.origin) {
      return reject(403, 'ORIGIN_REJECTED', 'The request Origin does not match the Studio.')
    }
    const pathname = request.url.split(/[?#]/, 1)[0] ?? ''
    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    const isDocumentNavigation =
      !isApi && site === 'none' && header(request, 'sec-fetch-mode') === 'navigate' && header(request, 'sec-fetch-dest') === 'document'
    if (site !== 'same-origin' && !isDocumentNavigation) {
      return reject(403, 'FETCH_SITE_REJECTED', 'The request must come from the Studio page.')
    }
  } else if (method === 'POST') {
    if (origin !== session.origin) return reject(403, 'ORIGIN_REJECTED', 'The request Origin does not match the Studio.')
    if (site !== undefined && site !== 'same-origin') {
      return reject(403, 'FETCH_SITE_REJECTED', 'The request must come from the Studio page.')
    }
  } else {
    return reject(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
  }
  if (!session.hasLaunchCookie(header(request, 'cookie'))) {
    return reject(401, 'LAUNCH_SESSION_REQUIRED', 'A valid Studio launch session is required.')
  }
  return { ok: true }
}

export type StudioHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Wraps a Studio handler with security headers, request guards, and envelope mapping.
 * Handler failures other than `StudioRequestError` become a generic `INTERNAL_ERROR`.
 */
export function withStudioGuards(session: LaunchSession, handler: StudioHandler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    applySecurityHeaders(res, session)
    const verdict = checkRequest(req, session)
    if (!verdict.ok) {
      res.setHeader('Connection', 'close')
      sendError(res, verdict.status, verdict.code, verdict.message)
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error: unknown) => {
        if (error instanceof StudioRequestError) sendError(res, error.status, error.code, error.message)
        else sendInternalError(res)
      })
  }
}
