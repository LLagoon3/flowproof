import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Frame } from 'playwright'

import { LOCALHOST_APP_URL_PATTERN } from '../contracts/index.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'

// The target-app lifecycle owner. One FlowProof-owned static server binds the scenario's fixed
// `localhost` port once per Studio session and serves only the active canonical document root,
// which advances from the preview build to the known-bad and patched worktree builds without a
// rebind. Every response is `no-store`, so a reconnected iframe never shows a stale build, and the
// iframe counts as ready only when the committed trusted probe says so.

export const TARGET_STAGES = ['preview', 'known-bad', 'patched'] as const
export type TargetStage = (typeof TARGET_STAGES)[number]

export const DEFAULT_RECONNECT_TIMEOUT_MS = 30_000
const PROBE_POLLING_MS = 50
const MAX_SERVED_FILE_BYTES = 16 * 1024 * 1024

export type TargetAppErrorCode =
  | 'TARGET_URL_INVALID'
  | 'TARGET_PORT_UNAVAILABLE'
  | 'TARGET_STAGE_INVALID'
  | 'TARGET_STAGE_OUT_OF_ORDER'
  | 'TARGET_DOCUMENT_ROOT_INVALID'
  | 'TARGET_NOT_SERVING'
  | 'TARGET_FRAME_INVALID'
  | 'TARGET_LOAD_FAILED'
  | 'TARGET_PROBE_NOT_READY'
  | 'TARGET_ROOT_CHANGED'
  | 'TARGET_TIMEOUT_INVALID'
  | 'TARGET_CLOSED'

/** A lifecycle failure with a stable code; messages never echo paths, URLs, or page content. */
export class TargetAppError extends Error {
  readonly code: TargetAppErrorCode

  constructor(code: TargetAppErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TargetAppError'
    this.code = code
  }
}

/** The committed worktree build, as the detached worktree session exposes it. */
export interface TargetBuilder {
  build(): Promise<{ readonly documentRoot: string }>
}

export interface ReconnectOptions {
  readonly timeoutMs?: number
}

export interface TargetApp {
  /** `http://localhost:<committed port>` */
  readonly origin: string
  /** The committed `app.url` the iframe loads. */
  readonly url: string
  /** The stage being served, or null before the first swap and after close. */
  readonly stage: TargetStage | null
  /** Swaps the served document root to a built app for the next stage; never rebinds. */
  serve(stage: TargetStage, documentRoot: string): Promise<void>
  /** Runs the committed worktree build, then serves its output for the stage. */
  serveBuild(stage: Exclude<TargetStage, 'preview'>, builder: TargetBuilder): Promise<void>
  /** Reloads the Studio's target iframe from the active build and waits for the trusted probe. */
  reconnect(frame: Frame, options?: ReconnectOptions): Promise<void>
  /** Stops serving and releases the port; repeated calls share the single release. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------------------
// Trusted probe contract
// ---------------------------------------------------------------------------------------

export const TRUSTED_PROBE_METHODS = ['isReady', 'readState', 'readDataset', 'readChartSeries', 'readCanvasSize'] as const
export type TrustedProbeMethod = (typeof TRUSTED_PROBE_METHODS)[number]

export type TrustedProbeReply = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

// The two functions below run inside the target frame: Playwright serializes their source, so
// they must stay self-contained. Both accept only the committed probe contract: a frozen
// version-1 object installed as a non-writable, non-configurable `__flowproofProbe` data
// property. Look-alike globals, accessors, DOM markers, and load events never count.

/** True only when the committed trusted probe reports exactly `true` from `isReady()`. */
export function trustedProbeReady(scope: object = globalThis): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(scope, '__flowproofProbe')
  if (descriptor === undefined || !('value' in descriptor) || descriptor.writable !== false || descriptor.configurable !== false) {
    return false
  }
  const probe: unknown = descriptor.value
  if (typeof probe !== 'object' || probe === null || !Object.isFrozen(probe)) return false
  const contract = probe as { readonly version?: unknown; readonly isReady?: unknown }
  if (contract.version !== 1 || typeof contract.isReady !== 'function') return false
  try {
    return (contract.isReady as () => unknown).call(probe) === true
  } catch {
    return false
  }
}

/** Calls one read-only method of the committed trusted probe; anything else is `{ ok: false }`. */
export function invokeTrustedProbe(method: string, scope: object = globalThis): TrustedProbeReply {
  const descriptor = Object.getOwnPropertyDescriptor(scope, '__flowproofProbe')
  if (descriptor === undefined || !('value' in descriptor) || descriptor.writable !== false || descriptor.configurable !== false) {
    return { ok: false }
  }
  const probe: unknown = descriptor.value
  if (typeof probe !== 'object' || probe === null || !Object.isFrozen(probe)) return { ok: false }
  const contract = probe as Readonly<Record<string, unknown>>
  const read = contract[method]
  if (contract.version !== 1 || typeof read !== 'function') return { ok: false }
  try {
    return { ok: true, value: (read as () => unknown).call(probe) }
  } catch {
    return { ok: false }
  }
}

/** Reads the trusted probe in the target frame; the reply's value is still untrusted data. */
export async function callTrustedProbe(frame: Frame, method: TrustedProbeMethod): Promise<TrustedProbeReply> {
  if (!(TRUSTED_PROBE_METHODS as readonly string[]).includes(method)) {
    throw new TargetAppError('TARGET_FRAME_INVALID', 'Only committed trusted-probe methods can be called.')
  }
  const reply: unknown = await frame.evaluate(invokeTrustedProbe, method)
  if (typeof reply !== 'object' || reply === null || (reply as { ok?: unknown }).ok !== true || !('value' in reply)) {
    return Object.freeze({ ok: false })
  }
  return Object.freeze({ ok: true, value: (reply as { value: unknown }).value })
}

// ---------------------------------------------------------------------------------------
// Static serving (the Studio server serves its built bundle through the same closed reader)
// ---------------------------------------------------------------------------------------

export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
})

// Plain file-name segments only: no empty, dot-leading (`.`, `..`, hidden), slash, backslash, or
// control characters after percent-decoding.
const SAFE_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/

const isInside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${path.sep}`)

/** Maps a request target to plain relative segments; `/` is the index document. */
export function requestSegments(rawUrl: string | undefined): readonly string[] | null {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null
  const pathname = rawUrl.split(/[?#]/, 1)[0] ?? ''
  if (pathname === '/') return ['index.html']
  const segments: string[] = []
  for (const encoded of pathname.slice(1).split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(encoded)
    } catch {
      return null
    }
    if (!SAFE_SEGMENT.test(segment)) return null
    segments.push(segment)
  }
  return segments
}

/** Reads one regular file that canonically resolves inside the active root, or null. */
export async function readServedFile(root: string, segments: readonly string[]): Promise<Buffer | null> {
  let canonical: string
  try {
    canonical = await realpath(path.join(root, ...segments))
  } catch {
    return null
  }
  if (!isInside(root, canonical)) return null
  let handle
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_SERVED_FILE_BYTES) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function sendStatus(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end()
}

/** A built app directory under the OS temporary root with a regular `index.html`. */
export async function canonicalDocumentRoot(documentRoot: unknown): Promise<string> {
  const invalid = (): TargetAppError =>
    new TargetAppError('TARGET_DOCUMENT_ROOT_INVALID', 'A document root is a built app directory in temporary output.')
  if (typeof documentRoot !== 'string' || !path.isAbsolute(documentRoot)) throw invalid()
  let root: string
  let tmpRoot: string
  try {
    root = await realpath(documentRoot)
    tmpRoot = await realpath(tmpdir())
    if (!(await stat(root)).isDirectory() || !(await lstat(path.join(root, 'index.html'))).isFile()) throw invalid()
  } catch {
    throw invalid()
  }
  if (!isInside(tmpRoot, root)) throw invalid()
  return root
}

function readTargetUrl(options: unknown): URL {
  const raw = (options as { scenario?: { scenario?: { app?: { url?: unknown } } } } | null)?.scenario?.scenario?.app?.url
  const invalid = (): TargetAppError => new TargetAppError('TARGET_URL_INVALID', 'The committed app URL must be http://localhost:<port>/.')
  if (typeof raw !== 'string' || !LOCALHOST_APP_URL_PATTERN.test(raw)) throw invalid()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid()
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !Number.isInteger(port) || port < 1 || port > 65_535) throw invalid()
  return url
}

// Ports this process has bound for a target app, so a second Studio lifecycle in the same
// process cannot take over the first one's port even where the OS would allow it.
const boundPorts = new Set<number>()

interface ActiveRoot {
  readonly stage: TargetStage
  readonly root: string
}

/** Binds the scenario's committed `localhost` port once and returns its lifecycle owner. */
export async function startTargetApp(options: { readonly scenario: LoadedScenario }): Promise<TargetApp> {
  const url = readTargetUrl(options)
  const port = Number(url.port)
  const authority = `localhost:${port}`
  if (boundPorts.has(port)) throw new TargetAppError('TARGET_PORT_UNAVAILABLE', 'The committed demo port is already bound.')

  let active: ActiveRoot | null = null
  let closed = false

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405, { Allow: 'GET, HEAD' })
    // The exact authority defeats DNS rebinding onto the loopback demo port.
    if (req.headers.host?.toLowerCase() !== authority) return sendStatus(res, 421)
    const serving = active
    if (serving === null) return sendStatus(res, 503)
    const segments = requestSegments(req.url)
    if (segments === null) return sendStatus(res, 404)
    const body = await readServedFile(serving.root, segments)
    if (body === null) return sendStatus(res, 404)
    // A swap during the read means this body belongs to a superseded build.
    if (active !== serving) return sendStatus(res, 503)
    const extension = path.extname(segments[segments.length - 1] ?? '').toLowerCase()
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const server = createServer((req, res) => {
    respond(req, res).catch(() => sendStatus(res, 500))
  })

  boundPorts.add(port)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, 'localhost', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    boundPorts.delete(port)
    throw new TargetAppError('TARGET_PORT_UNAVAILABLE', 'The committed demo port could not be bound on localhost.')
  }

  const assertOpen = (): void => {
    if (closed) throw new TargetAppError('TARGET_CLOSED', 'The target app was closed.')
  }

  const assertNextStage = (stage: unknown): TargetStage => {
    const index = (TARGET_STAGES as readonly unknown[]).indexOf(stage)
    if (index < 0) throw new TargetAppError('TARGET_STAGE_INVALID', 'Unknown target stage.')
    if (active !== null && index <= TARGET_STAGES.indexOf(active.stage)) {
      throw new TargetAppError('TARGET_STAGE_OUT_OF_ORDER', 'Target stages advance from preview to known-bad to patched.')
    }
    return stage as TargetStage
  }

  const serve = async (stage: TargetStage, documentRoot: string): Promise<void> => {
    assertOpen()
    const next = assertNextStage(stage)
    const root = await canonicalDocumentRoot(documentRoot)
    assertOpen()
    assertNextStage(next)
    active = Object.freeze({ stage: next, root })
  }

  const onTarget = (frame: Frame): boolean => {
    if (frame.isDetached()) return false
    try {
      return new URL(frame.url()).origin === url.origin
    } catch {
      return false
    }
  }

  let closing: Promise<void> | null = null

  return Object.freeze({
    origin: url.origin,
    url: url.href,

    get stage(): TargetStage | null {
      return active?.stage ?? null
    },

    serve,

    async serveBuild(stage: Exclude<TargetStage, 'preview'>, builder: TargetBuilder): Promise<void> {
      assertOpen()
      if (stage !== 'known-bad' && stage !== 'patched') {
        throw new TargetAppError('TARGET_STAGE_INVALID', 'Only worktree builds are served through the build port.')
      }
      assertNextStage(stage)
      const { documentRoot } = await builder.build()
      await serve(stage, documentRoot)
    },

    async reconnect(frame: Frame, reconnectOptions: ReconnectOptions = {}): Promise<void> {
      assertOpen()
      const serving = active
      if (serving === null) throw new TargetAppError('TARGET_NOT_SERVING', 'No build is being served yet.')
      const timeoutMs = reconnectOptions.timeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new TargetAppError('TARGET_TIMEOUT_INVALID', 'Reconnect timeouts are positive integer milliseconds.')
      }
      // Only the Studio's target iframe is reconnected, never the Studio page itself.
      if (frame.isDetached() || frame.parentFrame() === null) {
        throw new TargetAppError('TARGET_FRAME_INVALID', 'Only the attached Studio target iframe can be reconnected.')
      }
      const deadline = Date.now() + timeoutMs
      const remaining = (): number => Math.max(1, deadline - Date.now())

      let status: number | null = null
      try {
        status = (await frame.goto(url.href, { waitUntil: 'load', timeout: remaining() }))?.status() ?? null
      } catch {
        status = null
      }
      if (status !== 200) throw new TargetAppError('TARGET_LOAD_FAILED', 'The target frame did not load the served build.')
      if (!onTarget(frame)) throw new TargetAppError('TARGET_FRAME_INVALID', 'The target frame left the demo origin.')

      let ready: unknown = false
      try {
        const handle = await frame.waitForFunction(trustedProbeReady, undefined, { timeout: remaining(), polling: PROBE_POLLING_MS })
        ready = await handle.jsonValue()
        await handle.dispose()
      } catch {
        ready = false
      }
      if (ready !== true) throw new TargetAppError('TARGET_PROBE_NOT_READY', 'The trusted probe did not report a ready chart.')
      if (!onTarget(frame)) throw new TargetAppError('TARGET_FRAME_INVALID', 'The target frame left the demo origin.')
      if (active !== serving) throw new TargetAppError('TARGET_ROOT_CHANGED', 'The served build changed during reconnection.')
    },

    close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        closed = true
        active = null
        server.close(() => {
          boundPorts.delete(port)
          resolve()
        })
        server.closeAllConnections()
      })
      return closing
    },
  })
}
