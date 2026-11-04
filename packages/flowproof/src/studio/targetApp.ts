import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Frame } from 'playwright'

import { LOCALHOST_APP_URL_PATTERN, MAX_TARGET_FILE_BYTES } from '../contracts/index.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'

// The target-app lifecycle owner. One FlowProof-owned static server binds the scenario's fixed
// `localhost` port once per Studio session and serves only the active canonical document root,
// which advances from the preview build to the known-bad and patched worktree builds without a
// rebind. Every response is `no-store`, so a reconnected iframe never shows a stale build, and the
// iframe counts as ready only when the committed trusted probe says so. A reconnect that cannot
// show the prepared application is a target load failure the run tells apart from capture failures.

export const TARGET_STAGES = ['preview', 'known-bad', 'patched'] as const
export type TargetStage = (typeof TARGET_STAGES)[number]

export const DEFAULT_RECONNECT_TIMEOUT_MS = 30_000
const PROBE_POLLING_MS = 50
const MAX_SERVED_FILE_BYTES = MAX_TARGET_FILE_BYTES

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
  | 'TARGET_IDENTITY_MISMATCH'

/** A lifecycle failure with a stable code; messages never echo paths, URLs, or page content. */
export class TargetAppError extends Error {
  readonly code: TargetAppErrorCode

  constructor(code: TargetAppErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TargetAppError'
    this.code = code
  }
}

/** Reconnect outcomes in which the target frame could not show the prepared application. */
const TARGET_LOAD_FAILURE_CODES: ReadonlySet<TargetAppErrorCode> = new Set(['TARGET_LOAD_FAILED', 'TARGET_PROBE_NOT_READY'])

/**
 * True when a reconnect failed because the prepared application did not load in the target
 * frame: the served build's document did not load, or the trusted probe never became ready.
 */
export function isTargetLoadFailure(error: unknown): boolean {
  return error instanceof TargetAppError && TARGET_LOAD_FAILURE_CODES.has(error.code)
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

// ---------------------------------------------------------------------------------------
// Project-live target (specs/006-project-live-verification, T018)
// ---------------------------------------------------------------------------------------
//
// The project target serves only the accepted immutable build output of an admitted project at
// its own run-owned `http://localhost:<port>` origin, never the original checkout and never a
// repository dev server. Only files listed in the accepted output manifest are served, each read
// through a no-follow handle and checked against its recorded SHA-256, so a file planted into the
// output root is never served. Every response carries the target policy: a restrictive CSP that
// allows only same-origin scripts/connections, no workers, frames, objects or base changes, and
// `frame-ancestors` naming exactly the Studio origin, plus `no-store`, `nosniff` and a closed
// Permissions-Policy. Readiness is confirmed from the Studio's one target frame by loading the entry
// document and matching its exact bytes to the accepted output; the old chart probe is not used.

/** The target iframe sandbox: scripts and forms in its own origin; no popups, downloads or top navigation. */
export const PROJECT_TARGET_SANDBOX = 'allow-scripts allow-same-origin allow-forms'

const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'bluetooth=()',
  'payment=()',
  'display-capture=()',
  'clipboard-read=()',
].join(', ')

const STUDIO_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/

/** The target's Content Security Policy; only the exact Studio origin may frame it. */
export function buildProjectTargetPolicy(studioOrigin: string): string {
  const port = Number(STUDIO_ORIGIN_PATTERN.exec(studioOrigin)?.[1] ?? 0)
  if (!(port >= 1 && port <= 65_535)) throw new TargetAppError('TARGET_URL_INVALID', 'The framing Studio must be an http://127.0.0.1:<port> origin.')
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${studioOrigin}`,
  ].join('; ')
}

/** The accepted immutable output a project target may serve. */
export interface ServedProjectOutput {
  readonly root: string
  readonly sha256: string
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[]
}

export interface ProjectTargetServing {
  readonly outputSha256: string
  readonly entryPath: string
  readonly entrySha256: string
  /** Increases with every serve, so a swap during readiness is detected. */
  readonly generation: number
}

export interface ProjectTargetApp {
  /** `http://localhost:<port>` */
  readonly origin: string
  readonly port: number
  /** The served output identity, or null while nothing is served. */
  readonly serving: ProjectTargetServing | null
  /** Names the one Studio origin allowed to frame the target; required before serving. */
  setFrameAncestor(studioOrigin: string): void
  serve(output: ServedProjectOutput, options: { readonly entryPath: string }): Promise<void>
  /** Stops serving at once; later requests receive 503. */
  unserve(): void
  close(): Promise<void>
}

const projectFileOf = (entryPath: string): string => {
  const relative = entryPath.replace(/^\//, '')
  return relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative
}

/**
 * Project request target to segments. A closed directory request (`/app/`) names that directory's
 * `index.html`, matching how `projectFileOf` reads a confirmed directory entry. The rewritten target
 * passes the same `requestSegments` checks, so empty, dot, encoded-slash and traversal segments stay
 * refused, and only a registered file with its accepted hash is ever served.
 */
const projectRequestSegments = (rawUrl: string | undefined): readonly string[] | null => {
  if (typeof rawUrl !== 'string') return null
  const pathname = rawUrl.split(/[?#]/, 1)[0] ?? ''
  return requestSegments(pathname.length > 1 && pathname.endsWith('/') ? `${pathname}index.html` : rawUrl)
}

const sha256Of = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Binds the project target's `localhost` port (0 for an ephemeral port) and returns its owner. */
export async function startProjectTargetApp(options: { readonly port: number }): Promise<ProjectTargetApp> {
  const requested = options?.port
  if (!Number.isInteger(requested) || (requested !== 0 && (requested < 1_024 || requested > 65_535))) {
    throw new TargetAppError('TARGET_URL_INVALID', 'The project target port is 0 or 1024-65535.')
  }
  let active: { readonly output: ServedProjectOutput; readonly root: string; readonly files: ReadonlyMap<string, string>; readonly serving: ProjectTargetServing } | null = null
  let policy: string | null = null
  let generation = 0
  let closed = false
  let authority = ''

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405, { Allow: 'GET, HEAD' })
    if (req.headers.host?.toLowerCase() !== authority) return sendStatus(res, 421)
    const serving = active
    if (serving === null || policy === null) return sendStatus(res, 503)
    const segments = projectRequestSegments(req.url)
    const relative = segments === null ? null : segments.join('/')
    const expected = relative === null ? undefined : serving.files.get(relative)
    if (segments === null || relative === null || expected === undefined) return sendStatus(res, 404)
    const body = await readServedFile(serving.root, segments)
    if (body === null || sha256Of(body) !== expected) return sendStatus(res, 404)
    if (active !== serving) return sendStatus(res, 503)
    const extension = path.extname(segments[segments.length - 1] ?? '').toLowerCase()
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const server = createServer((req, res) => {
    respond(req, res).catch(() => sendStatus(res, 500))
  })
  if (requested !== 0 && boundPorts.has(requested)) throw new TargetAppError('TARGET_PORT_UNAVAILABLE', 'The project target port is already bound.')
  let port: number
  try {
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(requested, 'localhost', () => {
        server.off('error', reject)
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  } catch {
    throw new TargetAppError('TARGET_PORT_UNAVAILABLE', 'The project target port could not be bound on localhost.')
  }
  boundPorts.add(port)
  authority = `localhost:${port}`
  const origin = `http://${authority}`

  let closing: Promise<void> | null = null
  return Object.freeze({
    origin,
    port,
    get serving(): ProjectTargetServing | null {
      return active?.serving ?? null
    },
    setFrameAncestor(studioOrigin: string): void {
      policy = buildProjectTargetPolicy(studioOrigin)
    },
    async serve(output: ServedProjectOutput, serveOptions: { readonly entryPath: string }): Promise<void> {
      if (closed) throw new TargetAppError('TARGET_CLOSED', 'The target app was closed.')
      if (policy === null) throw new TargetAppError('TARGET_NOT_SERVING', 'The framing Studio origin is not set.')
      let root: string
      try {
        root = await realpath(output.root)
        const tmpRoot = await realpath(tmpdir())
        if (!isInside(tmpRoot, root) || !(await stat(root)).isDirectory()) throw new Error('outside')
      } catch {
        throw new TargetAppError('TARGET_DOCUMENT_ROOT_INVALID', 'A project target serves accepted output in temporary storage.')
      }
      const files = new Map(output.files.map((file) => [file.path, file.sha256]))
      const entrySha256 = files.get(projectFileOf(serveOptions.entryPath))
      if (entrySha256 === undefined) throw new TargetAppError('TARGET_DOCUMENT_ROOT_INVALID', 'The accepted output has no entry document.')
      if (closed) throw new TargetAppError('TARGET_CLOSED', 'The target app was closed.')
      generation += 1
      active = Object.freeze({
        output,
        root,
        files,
        serving: Object.freeze({ outputSha256: output.sha256, entryPath: serveOptions.entryPath, entrySha256, generation }),
      })
    },
    unserve(): void {
      active = null
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

/**
 * Confirms the Studio's target frame shows the served project build: the entry document loads in
 * that frame from the exact target origin with exactly the accepted entry bytes, and the served
 * output did not change meanwhile. Throws `TargetAppError` otherwise; there is no fallback.
 */
export async function confirmProjectTargetReady(
  frame: Frame,
  target: ProjectTargetApp,
  options: { readonly entryPath: string; readonly entrySha256: string; readonly timeoutMs: number },
): Promise<void> {
  const serving = target.serving
  if (serving === null || serving.entryPath !== options.entryPath) throw new TargetAppError('TARGET_NOT_SERVING', 'No project build is being served.')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new TargetAppError('TARGET_TIMEOUT_INVALID', 'Readiness timeouts are positive integer milliseconds.')
  if (frame.isDetached() || frame.parentFrame() === null) throw new TargetAppError('TARGET_FRAME_INVALID', 'Only the attached Studio target iframe is confirmed.')
  let response
  try {
    response = await frame.goto(`${target.origin}${options.entryPath}`, { waitUntil: 'load', timeout: options.timeoutMs })
  } catch {
    response = null
  }
  if (response === null || response.status() !== 200) throw new TargetAppError('TARGET_LOAD_FAILED', 'The target frame did not load the served build.')
  const body = await response.body().catch(() => null)
  if (body === null || sha256Of(body) !== serving.entrySha256 || sha256Of(body) !== options.entrySha256) {
    throw new TargetAppError('TARGET_IDENTITY_MISMATCH', 'The target frame shows a document other than the accepted build entry.')
  }
  let frameOrigin = ''
  try {
    frameOrigin = new URL(frame.url()).origin
  } catch {
    frameOrigin = ''
  }
  if (frameOrigin !== target.origin) throw new TargetAppError('TARGET_FRAME_INVALID', 'The target frame left the target origin.')
  if (target.serving?.generation !== serving.generation) throw new TargetAppError('TARGET_ROOT_CHANGED', 'The served build changed during readiness.')
}
