import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { MAX_CHAT_TEXT_LENGTH, parseChatRequest, parseRunResult, uuidSchema } from '../contracts/index.js'
import type { ChatRequest, RunResult } from '../contracts/index.js'
import { parseEvidenceId } from '../evidence/ids.js'
import { sanitizeChatText } from '../evidence/sanitize.js'
import { ArtifactStoreError } from '../evidence/store.js'
import type { RunArtifactStore } from '../evidence/store.js'
import { TransportSelectionError, selectTransport } from '../model/transport.js'
import type { ModelTransport } from '../model/transport.js'
import { ScenarioLoadError, loadScenario } from '../scenario/loadScenario.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'
import { SCENARIO_REGISTRY, findRegisteredScenario } from '../scenario/registry.js'
import { parseCapturedVerificationResult } from '../verify/capturedContracts.js'
import type { CapturedVerificationResult } from '../verify/capturedContracts.js'
import { PREPARED_FUNCTIONAL_CHECKS } from '../verify/capturedRun.js'
import { STUDIO_BIND_HOST, StudioSecurityError, assertLoopbackAddress, buildContentSecurityPolicy, createLaunchSession, withStudioGuards } from './auth.js'
import type { LaunchSession } from './auth.js'
import { StudioRequestError, sendJson } from './errors.js'
import { attachSseClient } from './events.js'
import type { RunEventStream } from './events.js'
import { CONTENT_TYPES, canonicalDocumentRoot, readServedFile, requestSegments } from './targetApp.js'

// The loopback Studio API from contracts/studio-api.md. Every route sits behind the launch-session
// guards. A start request carries only a registered scenario ID and a bounded goal; every
// rejection, the credential check, and the active-run conflict happen before `startRun`, so a
// refused request creates no run, artifact directory, or worktree. Proof Trail reads are closed
// lookups by run ID plus a registered Evidence ID or the candidate diff; there is no file route.
// Outside `/api/`, the launcher's built Studio bundle is served read-only behind the same guards.
// A case fixed at launch is listed first, so the Studio opens on it.
//
// The host-fixed captured verification mode (Spec 004) is an in-process option that only
// `startCapturedVerificationStudio` sets. It reuses the same guards, body parser and routes, lists
// only its prepared case with an additive execution-kind discriminator, selects no model transport
// and reads no credential, starts one run per launch through the host's fixed starter, serves only
// the strict captured result family bound to that run, and never serves a candidate diff.

/** What the server hands the run engine for one accepted start request. */
export interface StudioRunStart {
  /** Sanitized, server-bound chat request; `run_id` and `request_id` are server-generated. */
  readonly request: ChatRequest
  readonly scenario: LoadedScenario
  readonly transport: ModelTransport
}

/**
 * The authoritative result of either family: the unchanged legacy `RunResult`, or the strict
 * `kind: captured-verification` family. Each mode serves only its own family.
 */
export type StudioRunResult = RunResult | CapturedVerificationResult

/** The engine's live view of one run, as the server needs it. */
export interface StudioRunHandle {
  readonly runId: string
  readonly events: RunEventStream
  readonly artifacts: RunArtifactStore
  /** The authoritative result once finalized; null while the run is active. */
  result(): StudioRunResult | null
}

/** The catalog discriminator of the host-fixed captured mode; legacy entries carry none. */
export const CAPTURED_EXECUTION_KIND = 'captured-verification'

/** What the host-fixed captured starter receives: no model transport and nothing from the browser but the goal. */
export interface CapturedStudioRunStart {
  /** Sanitized, server-bound request; `run_id` and `request_id` are server-generated. */
  readonly request: ChatRequest
  readonly scenario: LoadedScenario
}

/** The host-fixed captured verification mode; only the in-process `startCapturedVerificationStudio` sets it. */
export interface CapturedStudioMode {
  /** The prepared case; the only one this Studio lists and accepts. */
  readonly scenarioId: string
  /** The host's fixed verification starter, which owns the admitted candidate snapshot. */
  readonly startRun: (start: CapturedStudioRunStart) => Promise<StudioRunHandle>
}

interface StudioServerBaseOptions {
  readonly repoRoot: string
  /** The only origin the Studio frames, for example `http://localhost:43119`. */
  readonly targetOrigin: string
  /** The launcher's built Studio bundle in temporary output; without it only `/api/` is served. */
  readonly studioRoot?: string
}

/** The captured mode reads no credential, takes no model transport, and has no legacy starter or launch case. */
export interface CapturedStudioServerOptions extends StudioServerBaseOptions {
  readonly captured: CapturedStudioMode
  readonly env?: undefined
  readonly startRun?: undefined
  readonly testTransport?: undefined
  readonly scenarioId?: undefined
}

export type StudioServerOptions = LegacyStudioServerOptions | CapturedStudioServerOptions

export interface LegacyStudioServerOptions {
  readonly captured?: undefined
  readonly repoRoot: string
  /** The only origin the Studio frames, for example `http://localhost:43119`. */
  readonly targetOrigin: string
  /** Credential readiness source; the launcher passes `process.env`. Values are never kept or logged. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly startRun: (start: StudioRunStart) => Promise<StudioRunHandle>
  /** Forwarded only from the in-process `startStudio({ testTransport })` entry. */
  readonly testTransport?: ModelTransport
  /** The launcher's built Studio bundle in temporary output; without it only `/api/` is served. */
  readonly studioRoot?: string
  /** The registered case fixed by `flowproof studio --scenario`; listed first so the Studio opens on it. */
  readonly scenarioId?: string
}

export interface StudioServerHandle {
  readonly session: LaunchSession
  readonly origin: string
  readonly address: AddressInfo
  close(): Promise<void>
}

const START_FIELDS = new Set(['scenario_id', 'request_text'])
const CAPTURED_MODE_FIELDS = new Set(['scenarioId', 'startRun'])
const MAX_START_BODY_BYTES = 16 * 1024
const RUN_ROUTE = /^\/api\/runs\/([^/]+)\/(events|result|evidence\/[^/]+|artifacts\/candidate-diff)$/

const fail = (status: number, code: string, message: string): StudioRequestError => new StudioRequestError(status, code, message)

function readStartBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (error: StudioRequestError | null): void => {
      if (settled) return
      settled = true
      if (error) {
        reject(error)
        return
      }
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        reject(fail(400, 'REQUEST_BODY_INVALID', 'The start request body must be UTF-8 JSON.'))
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_START_BODY_BYTES) {
        settle(fail(413, 'REQUEST_TOO_LARGE', 'The start request body is too large.'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(null))
    req.on('error', () => settle(fail(400, 'REQUEST_BODY_INVALID', 'The start request body could not be read.')))
  })
}

/** Validates the browser body: exactly a registered scenario ID and a bounded, sanitized goal. */
function parseStartBody(raw: string): { readonly scenarioId: string; readonly text: string } {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw fail(400, 'REQUEST_JSON_INVALID', 'The start request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw fail(400, 'REQUEST_BODY_INVALID', 'The start request body must be a JSON object.')
  }
  if (Object.keys(body).some((key) => !START_FIELDS.has(key))) {
    throw fail(400, 'REQUEST_FIELD_REJECTED', 'The start request accepts only scenario_id and request_text.')
  }
  const { scenario_id: scenarioId, request_text: requestText } = body as Record<string, unknown>
  if (typeof scenarioId !== 'string') throw fail(400, 'SCENARIO_ID_INVALID', 'scenario_id must name a committed case.')
  if (findRegisteredScenario(scenarioId) === null) {
    throw fail(400, 'SCENARIO_NOT_REGISTERED', 'scenario_id does not name a committed case.')
  }
  if (typeof requestText !== 'string') throw fail(400, 'REQUEST_TEXT_INVALID', 'request_text must be a string.')
  if (requestText.length > MAX_CHAT_TEXT_LENGTH) {
    throw fail(400, 'REQUEST_TEXT_TOO_LONG', `request_text is limited to ${MAX_CHAT_TEXT_LENGTH} characters.`)
  }
  const text = sanitizeChatText(requestText).value
  if (text.length === 0) throw fail(400, 'REQUEST_TEXT_EMPTY', 'request_text must contain a readable goal.')
  return { scenarioId, text }
}

const isJsonMediaType = (contentType: string | undefined): boolean =>
  (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() === 'application/json'

async function loadCommittedScenario(scenarioId: string, repoRoot: string): Promise<LoadedScenario> {
  try {
    return await loadScenario(scenarioId, { repoRoot })
  } catch (error) {
    if (error instanceof ScenarioLoadError) throw fail(500, 'SCENARIO_UNAVAILABLE', 'The committed case could not be loaded.')
    throw error
  }
}

/**
 * The captured mode is exactly a prepared committed case plus a host starter, with no legacy option
 * beside it. Returns the validated snapshot, so later changes to the caller's object have no effect.
 */
function assertCapturedMode(options: StudioServerOptions): CapturedStudioMode {
  const captured: unknown = options.captured
  if (typeof captured !== 'object' || captured === null || Object.keys(captured).some((key) => !CAPTURED_MODE_FIELDS.has(key))) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The captured verification mode needs exactly a prepared case and a host starter.')
  }
  const { scenarioId, startRun } = captured as { scenarioId?: unknown; startRun?: unknown }
  if (typeof startRun !== 'function') {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The captured verification mode needs exactly a prepared case and a host starter.')
  }
  if (typeof scenarioId !== 'string' || findRegisteredScenario(scenarioId) === null || !Object.hasOwn(PREPARED_FUNCTIONAL_CHECKS, scenarioId)) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The captured verification case is not a prepared committed case.')
  }
  if (options.env !== undefined || options.startRun !== undefined || options.testTransport !== undefined || options.scenarioId !== undefined) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The captured verification mode takes no credential source, model transport, legacy starter, or launch case.')
  }
  return Object.freeze({ scenarioId, startRun: startRun as CapturedStudioMode['startRun'] })
}

/** Validates the options; returns the captured mode snapshot, or null for the legacy mode. */
function assertOptions(options: StudioServerOptions): CapturedStudioMode | null {
  let captured: CapturedStudioMode | null = null
  if (typeof options !== 'object' || options === null) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'Studio server options are required.')
  }
  if (typeof options.repoRoot !== 'string' || !path.isAbsolute(options.repoRoot)) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The repository root must be an absolute path.')
  }
  if (options.captured !== undefined) {
    captured = assertCapturedMode(options)
  } else {
    if (typeof options.env !== 'object' || options.env === null || typeof options.startRun !== 'function') {
      throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The Studio needs an environment source and a run starter.')
    }
    if (options.scenarioId !== undefined && findRegisteredScenario(options.scenarioId) === null) {
      throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The launch-selected case is not a committed case.')
    }
  }
  // Validates the framed target before anything binds.
  buildContentSecurityPolicy(options.targetOrigin)
  return captured
}

/** The built Studio bundle must be a directory with `index.html` in temporary output. */
async function readStudioRoot(studioRoot: unknown): Promise<string | null> {
  if (studioRoot === undefined) return null
  try {
    return await canonicalDocumentRoot(studioRoot)
  } catch {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'The Studio bundle must be a built directory in temporary output.')
  }
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: STUDIO_BIND_HOST, port: 0, exclusive: true }, () => {
      server.off('error', reject)
      const address = server.address()
      try {
        assertLoopbackAddress(address)
      } catch (error) {
        server.close()
        reject(error)
        return
      }
      resolve(address as AddressInfo)
    })
  })
}

/**
 * Starts the guarded Studio API on `127.0.0.1` at an ephemeral port and returns its launch
 * session. Credential readiness is deferred to accepted start requests.
 */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServerHandle> {
  const captured = assertOptions(options)
  const { repoRoot } = options
  const mode: { readonly kind: 'legacy'; readonly options: LegacyStudioServerOptions } | { readonly kind: 'captured'; readonly captured: CapturedStudioMode } =
    captured === null ? { kind: 'legacy', options: options as LegacyStudioServerOptions } : { kind: 'captured', captured }
  const studioRoot = await readStudioRoot(options.studioRoot)
  const launchCase = mode.kind === 'captured' ? mode.captured.scenarioId : mode.options.scenarioId
  const listedCases =
    mode.kind === 'captured'
      ? SCENARIO_REGISTRY.filter((entry) => entry.scenario_id === launchCase)
      : [...SCENARIO_REGISTRY.filter((entry) => entry.scenario_id === launchCase), ...SCENARIO_REGISTRY.filter((entry) => entry.scenario_id !== launchCase)]
  const runs = new Map<string, StudioRunHandle>()
  /** The server-bound request of each captured run, so its result is checked against both identities. */
  const capturedRequests = new Map<string, ChatRequest>()
  const streams = new Set<ServerResponse>()
  let starting = false
  let activeRun: StudioRunHandle | null = null
  let closing: Promise<void> | null = null

  const server = createServer()
  const address = await listen(server)
  const session = createLaunchSession({ port: address.port, targetOrigin: options.targetOrigin })

  const findRun = (runId: string): StudioRunHandle => {
    if (!uuidSchema.safeParse(runId).success) throw fail(400, 'RUN_ID_INVALID', 'The run identifier is not valid.')
    const handle = runs.get(runId)
    if (!handle) throw fail(404, 'RUN_NOT_FOUND', 'The run does not exist in this Studio session.')
    return handle
  }

  const listScenarios = async (res: ServerResponse): Promise<void> => {
    const scenarios = []
    for (const entry of listedCases) {
      const loaded = await loadCommittedScenario(entry.scenario_id, repoRoot)
      scenarios.push({
        scenario_id: entry.scenario_id,
        case: entry.case,
        title: entry.title,
        default_request: loaded.scenario.default_request,
        ...(mode.kind === 'captured' ? { execution_kind: CAPTURED_EXECUTION_KIND } : {}),
      })
    }
    sendJson(res, 200, { scenarios })
  }

  /**
   * Prepares the starter for an accepted request. The legacy mode selects the model transport and
   * checks its credential first; the host-fixed captured mode selects no transport and reads nothing.
   */
  const prepareStart = (scenario: LoadedScenario): ((request: ChatRequest) => Promise<StudioRunHandle>) => {
    if (mode.kind === 'captured') {
      const { startRun } = mode.captured
      return (request) => startRun(Object.freeze({ request, scenario }))
    }
    const { env, startRun, testTransport } = mode.options
    let transport: ModelTransport
    try {
      transport = testTransport === undefined ? selectTransport(scenario.scenario) : selectTransport(scenario.scenario, { testTransport })
    } catch (error) {
      if (error instanceof TransportSelectionError) {
        throw fail(500, 'PROVIDER_UNAVAILABLE', 'The model provider for this case is not available.')
      }
      throw error
    }
    if (!transport.checkReadiness(env).ready) {
      throw fail(409, 'PROVIDER_CREDENTIAL_MISSING', 'The live Meta provider requires MODEL_API_KEY; no run was created.')
    }
    return (request) => startRun(Object.freeze({ request, scenario, transport }))
  }

  const startRunRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonMediaType(req.headers['content-type'])) {
      res.setHeader('Connection', 'close')
      throw fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'The start request must be application/json.')
    }
    let raw: string
    try {
      raw = await readStartBody(req)
    } catch (error) {
      res.setHeader('Connection', 'close')
      throw error
    }
    const { scenarioId, text } = parseStartBody(raw)
    if (mode.kind === 'captured' && scenarioId !== mode.captured.scenarioId) {
      throw fail(400, 'SCENARIO_NOT_AVAILABLE', 'scenario_id does not name the prepared case of this Studio session.')
    }
    if (starting || (activeRun !== null && activeRun.result() === null)) {
      throw fail(409, 'ACTIVE_RUN_EXISTS', 'This Studio session already has an active run.')
    }
    // One verification run per captured launch, even after it finalized.
    if (mode.kind === 'captured' && activeRun !== null) {
      throw fail(409, 'RUN_LIMIT_REACHED', 'This Studio session has already started its verification run.')
    }
    starting = true
    try {
      const scenario = await loadCommittedScenario(scenarioId, repoRoot)
      const launch = prepareStart(scenario)
      const parsed = parseChatRequest({
        request_id: randomUUID(),
        session_id: session.sessionId,
        run_id: randomUUID(),
        created_at: new Date().toISOString(),
        text,
        scenario_id: scenarioId,
      })
      if (!parsed.ok) throw fail(400, 'REQUEST_TEXT_INVALID', 'request_text is not a valid goal.')
      const request = Object.freeze(parsed.value)
      let handle: StudioRunHandle
      try {
        handle = await launch(request)
      } catch {
        throw fail(500, 'RUN_START_FAILED', 'The run could not be started.')
      }
      if (handle.runId !== request.run_id) throw fail(500, 'RUN_START_FAILED', 'The run could not be started.')
      if (mode.kind === 'captured') capturedRequests.set(handle.runId, request)
      runs.set(handle.runId, handle)
      activeRun = handle
      sendJson(res, 202, {
        request_id: request.request_id,
        run_id: request.run_id,
        events_url: `/api/runs/${request.run_id}/events`,
      })
    } finally {
      starting = false
    }
  }

  const streamEvents = (res: ServerResponse, handle: StudioRunHandle): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    streams.add(res)
    res.once('close', () => streams.delete(res))
    // Live only: `Last-Event-ID` is ignored and missed events are never replayed.
    attachSseClient(handle.events, res)
  }

  const sendResult = (res: ServerResponse, handle: StudioRunHandle): void => {
    const result = handle.result()
    if (result === null) {
      sendJson(res, 202, { state: 'running' })
      return
    }
    if (mode.kind === 'captured') {
      // Only the strict captured family, bound to the run, request, and case this server started.
      const request = capturedRequests.get(handle.runId)
      const captured = parseCapturedVerificationResult(result)
      if (
        !captured.ok ||
        request === undefined ||
        captured.value.run_id !== handle.runId ||
        captured.value.request_id !== request.request_id ||
        captured.value.scenario_id !== request.scenario_id
      ) {
        throw fail(500, 'RESULT_INVALID', 'The run result is not available.')
      }
      sendJson(res, 200, captured.value)
      return
    }
    const parsed = parseRunResult(result)
    if (!parsed.ok || parsed.value.run_id !== handle.runId) throw fail(500, 'RESULT_INVALID', 'The run result is not available.')
    sendJson(res, 200, parsed.value)
  }

  const sendArtifact = async (res: ServerResponse, handle: StudioRunHandle, id: string, contentType: string): Promise<void> => {
    let bytes: Buffer
    try {
      bytes = await handle.artifacts.read(id)
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === 'ARTIFACT_UNKNOWN_ID') {
        throw fail(404, 'ARTIFACT_NOT_FOUND', 'The artifact is not available for this run.')
      }
      throw fail(500, 'ARTIFACT_UNAVAILABLE', 'The artifact could not be read.')
    }
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.end(bytes)
  }

  const sendEvidence = async (res: ServerResponse, handle: StudioRunHandle, evidenceId: string): Promise<void> => {
    const parsed = parseEvidenceId(evidenceId)
    if (parsed === null) throw fail(400, 'EVIDENCE_ID_INVALID', 'The Evidence ID is not valid.')
    if (!handle.artifacts.hasEvidence(evidenceId)) throw fail(404, 'EVIDENCE_NOT_FOUND', 'The evidence is not registered for this run.')
    await sendArtifact(res, handle, evidenceId, parsed.type === 'screenshot' ? 'image/png' : 'application/json; charset=utf-8')
  }

  /** One regular file of the built Studio bundle; `/` is its `index.html`. */
  const sendStudioAsset = async (req: IncomingMessage, res: ServerResponse, root: string): Promise<void> => {
    const segments = requestSegments(req.url)
    const body = segments === null ? null : await readServedFile(root, segments)
    if (segments === null || body === null) throw fail(404, 'NOT_FOUND', 'The requested route does not exist.')
    const extension = path.extname(segments[segments.length - 1] ?? '').toLowerCase()
    res.statusCode = 200
    res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream')
    res.setHeader('Content-Length', String(body.length))
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
    const method = req.method ?? 'GET'
    const only = (allowed: string): void => {
      if (method !== allowed) throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
    }
    if (pathname === '/api/scenarios') {
      only('GET')
      await listScenarios(res)
      return
    }
    if (pathname === '/api/runs') {
      only('POST')
      await startRunRequest(req, res)
      return
    }
    const match = RUN_ROUTE.exec(pathname)
    if (match) {
      only('GET')
      const handle = findRun(match[1] ?? '')
      const action = match[2] ?? ''
      if (action === 'events') streamEvents(res, handle)
      else if (action === 'result') sendResult(res, handle)
      else if (action === 'artifacts/candidate-diff') {
        // A captured run never exposes candidate bytes to the browser, whatever its store holds.
        if (mode.kind === 'captured') throw fail(404, 'ARTIFACT_NOT_FOUND', 'The artifact is not available for this run.')
        await sendArtifact(res, handle, 'candidate-diff', 'text/plain; charset=utf-8')
      }
      else await sendEvidence(res, handle, action.slice('evidence/'.length))
      return
    }
    if (studioRoot !== null && pathname !== '/api' && !pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      await sendStudioAsset(req, res, studioRoot)
      return
    }
    throw fail(404, 'NOT_FOUND', 'The requested route does not exist.')
  }

  server.on('request', withStudioGuards(session, route))

  return Object.freeze({
    session,
    origin: session.origin,
    address: Object.freeze({ ...address }),
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const stream of streams) stream.end()
        server.closeAllConnections()
      })
      return closing
    },
  })
}
