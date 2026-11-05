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
import { REASON_CODE_PATTERN } from '../contracts/index.js'
import { newProjectUuid, parseExecutionConfiguration, parseProjectContext, projectSha256Schema, projectUuidSchema, safeTextSchema } from '../project/contracts.js'
import { createProjectDemonstration, createProjectRun } from '../project/run.js'
import type { ProjectDemonstration, ProjectDemonstrationOptions } from '../project/run.js'
import type { ExecutionConfiguration, ProjectContext } from '../project/contracts.js'
import { ProjectSettingsSchema } from '../project/profile.js'
import type { ConfigurationResult, ProjectSettings } from '../project/profile.js'
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

export interface ProjectPreparation {
  readonly target_url: string
  readonly output_sha256: string
  readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }[]
}

export class ProjectPreparationError extends Error {
  readonly code: string
  readonly reasons: readonly string[]

  constructor(code: string, reasons: readonly string[] = []) {
    super('The project could not be prepared.')
    this.name = 'ProjectPreparationError'
    this.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PROJECT_PREPARE_FAILED'
    this.reasons = Object.freeze(reasons.filter((reason) => REASON_CODE_PATTERN.test(reason)).slice(0, 16))
  }
}

/** Explicit project-only ports; no legacy run/model capability is accepted here. */
export interface ProjectStudioMode {
  readonly context: ProjectContext
  readonly modelConfigured: boolean
  readonly suggestion: ProjectSettings
  readonly initialSettings: ProjectSettings | null
  readonly configure: (settings: ProjectSettings, confirmedAt: string) => ConfigurationResult
  readonly prepare: (configuration: ExecutionConfiguration, signal: AbortSignal) => Promise<ProjectPreparation>
  readonly release: () => Promise<void>
  /**
   * Launcher-owned ports of one guarded demonstration on the prepared target: the real recorder on
   * the Studio page's single target frame, frozen admitted sources and the host-keyed model session
   * for this host-minted run. Absent, no capture can start. The server owns run/capture identity.
   */
  readonly openDemonstration?: (input: { readonly runId: string; readonly configuration: ExecutionConfiguration; readonly preparation: ProjectPreparation }) => ProjectDemonstrationPorts
}

/** Run-scoped demonstration ports supplied by the launcher; nothing here comes from the browser. */
export type ProjectDemonstrationPorts = Pick<ProjectDemonstrationOptions, 'startRecorder' | 'loadSources' | 'model'>

export interface ProjectStudioServerOptions extends Pick<StudioServerBaseOptions, 'targetOrigin' | 'studioRoot'> {
  readonly project: ProjectStudioMode
  readonly repoRoot?: never
  readonly env?: never
  readonly startRun?: never
  readonly captured?: never
  readonly testTransport?: never
  readonly scenarioId?: never
}

export type StudioServerOptions = LegacyStudioServerOptions | CapturedStudioServerOptions | ProjectStudioServerOptions

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
function assertCapturedMode(options: LegacyStudioServerOptions | CapturedStudioServerOptions): CapturedStudioMode {
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
function assertOptions(options: LegacyStudioServerOptions | CapturedStudioServerOptions): CapturedStudioMode | null {
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
  if ((options as { project?: unknown } | null)?.project !== undefined) return startProjectStudioServer(options as ProjectStudioServerOptions)
  const captured = assertOptions(options as LegacyStudioServerOptions | CapturedStudioServerOptions)
  const { repoRoot } = options as LegacyStudioServerOptions | CapturedStudioServerOptions
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

const MAX_PROJECT_BODY_BYTES = 32 * 1_024
const PROJECT_SETTING_FIELDS = new Set(['project_id', 'baseline_commit', 'settings', 'confirm'])
const PROJECT_PREPARE_FIELDS = new Set(['configuration_id'])
const PROJECT_CAPTURE_FIELDS = new Set(['configuration_id', 'output_sha256'])
const PROJECT_ANALYZE_FIELDS = new Set(['submit', 'description'])
const PROJECT_CLARIFY_FIELDS = new Set(['question_id', 'answer'])
const DEMONSTRATION_DESCRIPTION = safeTextSchema(2_000, { multiline: true })
const DEMONSTRATION_ANSWER = safeTextSchema(1_000, { multiline: true })
/** Fixed statuses of demonstration refusals; the code names the reason, never provider text. */
const demonstrationStatus = (code: string): number =>
  code === 'CAPTURE_UNKNOWN' ? 404 : code === 'CAPTURE_FAILED' || code === 'SOURCES_UNAVAILABLE' ? 503 : /^(PROVIDER_|PROMPT_|INTERPRETATION_|ANALYSIS_)/.test(code) ? 502 : 409
const PROJECT_SERVER_FIELDS = new Set(['targetOrigin', 'studioRoot', 'project'])

type ProjectConfigurationView = {
  readonly state: 'required' | 'review' | 'confirmed' | 'rejected'
  readonly source: 'suggestion' | 'file' | 'confirmed' | 'rejected'
  readonly configuration_id: string | null
  readonly configuration_digest: string | null
  readonly reasons: readonly string[]
  readonly settings: ProjectSettings
}
type ProjectPreparationView = {
  readonly state: 'idle' | 'preparing' | 'ready' | 'failed'
  readonly reason: string | null
  readonly target_url: string | null
  readonly output_sha256: string | null
  readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }[]
}

function readProjectBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_PROJECT_BODY_BYTES) {
        rejectOnce(fail(413, 'REQUEST_BODY_TOO_LARGE', 'The project request body is too large.'))
        req.resume()
        return
      }
      chunks.push(bytes)
    })
    req.once('error', () => rejectOnce(fail(400, 'REQUEST_BODY_INVALID', 'The project request body is invalid.')))
    req.once('end', () => {
      if (settled) return
      let parsed: unknown
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        parsed = JSON.parse(text)
      } catch {
        rejectOnce(fail(400, 'REQUEST_JSON_INVALID', 'The project request body is not valid UTF-8 JSON.'))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        rejectOnce(fail(400, 'REQUEST_BODY_INVALID', 'The project request body must be an object.'))
        return
      }
      settled = true
      resolve(parsed)
    })
  })
}

function hasOnlyKeys(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key))
}

function projectReasonList(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value) => REASON_CODE_PATTERN.test(value)))].slice(0, 16))
}

function initialProjectConfiguration(mode: ProjectStudioMode): ProjectConfigurationView {
  const settings = mode.initialSettings ?? mode.suggestion
  const source = mode.initialSettings === null ? 'suggestion' : 'file'
  return Object.freeze({
    state: mode.initialSettings === null ? 'required' : 'review',
    source,
    configuration_id: null,
    configuration_digest: null,
    reasons: Object.freeze([]),
    settings,
  })
}

function projectPreparationView(state: ProjectPreparationView['state'], reason: string | null = null): ProjectPreparationView {
  return Object.freeze({ state, reason, target_url: null, output_sha256: null, checks: Object.freeze([]) })
}

function summarizeProjectContext(mode: ProjectStudioMode, admissionState: 'ready' | 'stale', admissionReasons: readonly string[], configuration: ProjectConfigurationView, preparation: ProjectPreparationView): Record<string, unknown> {
  const context = mode.context
  return {
    kind: 'project-live',
    project: {
      project_id: context.project_id,
      display_root: context.display_root,
      label: context.label,
      baseline_commit: context.baseline_commit,
      branch: context.branch,
      category: context.category,
      admission: { state: admissionState, reasons: admissionReasons },
    },
    model_configured: mode.modelConfigured,
    configuration,
    preparation,
  }
}

function assertProjectMode(options: ProjectStudioServerOptions): void {
  if (typeof options !== 'object' || options === null || Object.keys(options).some((key) => !PROJECT_SERVER_FIELDS.has(key))) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'Project Studio options are invalid.')
  }
  const mode = options.project
  const context = ProjectSettingsSchema.safeParse(mode?.suggestion)
  const initial = mode?.initialSettings === null ? null : ProjectSettingsSchema.safeParse(mode?.initialSettings)
  if (
    typeof mode !== 'object' ||
    mode === null ||
    typeof mode.modelConfigured !== 'boolean' ||
    !parseProjectContext(mode.context).ok ||
    !context.success ||
    (initial !== null && !initial.success) ||
    typeof mode.configure !== 'function' ||
    (mode.openDemonstration !== undefined && typeof mode.openDemonstration !== 'function') ||
    typeof mode.prepare !== 'function' ||
    typeof mode.release !== 'function'
  ) {
    throw new StudioSecurityError('STUDIO_LAUNCH_CONFIG_INVALID', 'Project Studio options are invalid.')
  }
}

/** Project-only guarded setup API. It never exposes the integrity manifest or starts work before confirmation. */
async function startProjectStudioServer(options: ProjectStudioServerOptions): Promise<StudioServerHandle> {
  assertProjectMode(options)
  const studioRoot = await readStudioRoot(options.studioRoot)
  const { project: mode, targetOrigin } = options
  const server = createServer()
  const address = await listen(server)
  const session = createLaunchSession({ port: address.port, targetOrigin })
  let closing: Promise<void> | null = null
  let closed = false
  let admissionState: 'ready' | 'stale' = 'ready'
  let admissionReasons: readonly string[] = Object.freeze([])
  let configurationView = initialProjectConfiguration(mode)
  let configuration: ExecutionConfiguration | null = null
  let preparation = projectPreparationView('idle')
  let activePreparation: AbortController | null = null
  let targetOwned = false
  let preparationSequence = 0
  let demonstration: { readonly runId: string; readonly service: ProjectDemonstration } | null = null
  // True from the first state change of a configuration request until its revocation and target
  // release settled: no capture, preparation or other configuration is admitted meanwhile.
  let configurationChanging = false
  /**
   * Synchronously revokes the demonstration (no later request reaches it, and the service generation
   * moves so pending work is refused), then settles its unsubmitted evidence deletion. Always runs
   * before the prepared target is released.
   */
  const revokeDemonstration = (): Promise<void> => {
    const current = demonstration
    demonstration = null
    if (current === null) return Promise.resolve()
    const invalidated = current.service.invalidate()
    current.service.cancel()
    return invalidated.catch(() => undefined)
  }
  const closeDemonstration = (): Promise<void> => revokeDemonstration()
  /** Every branch that rejects or replaces the configuration starts here, before its first await. */
  const revokeForConfigurationChange = (): Promise<void> => {
    configurationChanging = true
    configuration = null
    return revokeDemonstration()
  }
  const changingRefusal = (): StudioRequestError => fail(409, 'CONFIGURATION_CHANGING', 'The project configuration is changing.')
  const revokedRefusal = (): StudioRequestError => fail(409, 'CAPTURE_INVALIDATED', 'The demonstration was revoked by a configuration change.')
  const refuseDemonstration = (code: string): StudioRequestError => fail(demonstrationStatus(code), code, 'The demonstration request was refused.')
  const runView = (current: { readonly runId: string; readonly service: ProjectDemonstration }): Record<string, unknown> => ({ run_id: current.runId, ...current.service.view() })

  const contextView = (): Record<string, unknown> =>
    summarizeProjectContext(mode, admissionState, admissionReasons, configurationView, preparation)

  const releaseTarget = async (): Promise<void> => {
    if (!targetOwned) return
    targetOwned = false
    await mode.release()
  }

  const completePreparation = async (sequence: number, controller: AbortController, current: ExecutionConfiguration): Promise<void> => {
    try {
      const value = await mode.prepare(current, controller.signal)
      if (closed || controller.signal.aborted || sequence !== preparationSequence) {
        await mode.release().catch(() => undefined)
        return
      }
      const target = new URL(value.target_url)
      if (
        target.origin !== targetOrigin ||
        target.username !== '' ||
        target.password !== '' ||
        !projectSha256Schema.safeParse(value.output_sha256).success ||
        !Array.isArray(value.checks) ||
        value.checks.length > 64 ||
        value.checks.some((check) => typeof check.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(check.id) || !['passed', 'failed', 'not_evaluated'].includes(check.status))
      ) {
        throw new ProjectPreparationError('PROJECT_PREPARE_FAILED')
      }
      targetOwned = true
      preparation = Object.freeze({
        state: 'ready',
        reason: null,
        target_url: target.href,
        output_sha256: value.output_sha256,
        checks: Object.freeze(value.checks.map((check) => Object.freeze({ id: check.id, status: check.status }))),
      })
    } catch (error) {
      if (closed || controller.signal.aborted || sequence !== preparationSequence) return
      if (error instanceof ProjectPreparationError && error.code === 'PROJECT_BASELINE_STALE') {
        admissionState = 'stale'
        admissionReasons = projectReasonList(error.reasons.length ? error.reasons : ['PROJECT_BASELINE_CHANGED'])
        configuration = null
        configurationView = Object.freeze({ ...configurationView, state: 'rejected', source: 'rejected', configuration_id: null, configuration_digest: null, reasons: admissionReasons })
        preparation = projectPreparationView('failed', 'PROJECT_BASELINE_STALE')
      } else {
        const reason = error instanceof ProjectPreparationError ? error.code : 'PROJECT_PREPARE_FAILED'
        preparation = projectPreparationView('failed', reason)
      }
    } finally {
      if (activePreparation === controller) activePreparation = null
    }
  }

  const parseJsonRequest = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw fail(415, 'CONTENT_TYPE_UNSUPPORTED', 'Project requests must use application/json.')
    }
    return (await readProjectBody(req)) as Record<string, unknown>
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
    const method = req.method ?? 'GET'
    if (pathname === '/api/project/context') {
      if (method !== 'GET') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      sendJson(res, 200, contextView())
      return
    }
    if (pathname === '/api/project/configuration') {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      const body = await parseJsonRequest(req)
      if (configurationChanging) throw changingRefusal()
      if (!hasOnlyKeys(body, PROJECT_SETTING_FIELDS)) throw fail(400, 'REQUEST_FIELD_REJECTED', 'The project configuration request contains unsupported fields.')
      if (body.confirm !== true) throw fail(400, 'CONFIRMATION_REQUIRED', 'Review and confirm the project settings before continuing.')
      if (admissionState !== 'ready') throw fail(409, 'PROJECT_BASELINE_STALE', 'The admitted project baseline is stale.')
      if (typeof body.project_id !== 'string' || body.project_id !== mode.context.project_id || typeof body.baseline_commit !== 'string' || body.baseline_commit !== mode.context.baseline_commit) {
        throw fail(409, 'PROJECT_IDENTITY_MISMATCH', 'The configuration does not match the admitted project identity.')
      }
      if (activePreparation !== null || preparation.state === 'preparing') throw fail(409, 'PROJECT_PREPARATION_ACTIVE', 'Project preparation is already active.')
      const parsedSettings = ProjectSettingsSchema.safeParse(body.settings)
      if (!parsedSettings.success) {
        const settled = revokeForConfigurationChange()
        configurationView = Object.freeze({ state: 'rejected', source: 'rejected', configuration_id: null, configuration_digest: null, reasons: Object.freeze(['CONFIGURATION_INVALID']), settings: configurationView.settings })
        try {
          await settled
        } finally {
          configurationChanging = false
        }
        throw fail(400, 'CONFIGURATION_INVALID', 'The reviewed project settings are invalid.')
      }
      const confirmedAt = new Date().toISOString()
      let result: ConfigurationResult
      try {
        result = mode.configure(parsedSettings.data, confirmedAt)
      } catch {
        result = { ok: false, reasons: ['CONFIGURATION_INVALID'] }
      }
      if (!result.ok) {
        const reasons = projectReasonList(result.reasons)
        const settled = revokeForConfigurationChange()
        configurationView = Object.freeze({ state: 'rejected', source: 'rejected', configuration_id: null, configuration_digest: null, reasons, settings: parsedSettings.data })
        try {
          await settled
        } finally {
          configurationChanging = false
        }
        throw fail(400, 'CONFIGURATION_INVALID', 'The reviewed project settings are not supported by the admitted profile.')
      }
      const checked = parseExecutionConfiguration(result.configuration)
      if (
        !checked.ok ||
        checked.value.project_id !== mode.context.project_id ||
        checked.value.baseline_commit !== mode.context.baseline_commit ||
        checked.value.target_origin !== targetOrigin ||
        checked.value.confirmation.state !== 'confirmed'
      ) {
        const settled = revokeForConfigurationChange()
        configurationView = Object.freeze({ state: 'rejected', source: 'rejected', configuration_id: null, configuration_digest: null, reasons: Object.freeze(['CONFIGURATION_INVALID']), settings: parsedSettings.data })
        try {
          await settled
        } finally {
          configurationChanging = false
        }
        throw fail(400, 'CONFIGURATION_INVALID', 'The reviewed project settings are not supported by the admitted profile.')
      }
      const settled = revokeForConfigurationChange()
      preparation = projectPreparationView('idle')
      try {
        await settled
        await releaseTarget().catch(() => undefined)
      } finally {
        configurationChanging = false
      }
      if (closed) throw fail(409, 'CONFIGURATION_CHANGING', 'The Studio is closing.')
      configuration = checked.value
      configurationView = Object.freeze({
        state: 'confirmed',
        source: 'confirmed',
        configuration_id: checked.value.configuration_id,
        configuration_digest: checked.value.configuration_digest,
        reasons: Object.freeze([]),
        settings: parsedSettings.data,
      })
      preparation = projectPreparationView('idle')
      sendJson(res, 200, { configuration_id: checked.value.configuration_id, configuration_digest: checked.value.configuration_digest })
      return
    }
    if (pathname === '/api/project/prepare') {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      const body = await parseJsonRequest(req)
      if (configurationChanging) throw changingRefusal()
      if (!hasOnlyKeys(body, PROJECT_PREPARE_FIELDS)) throw fail(400, 'REQUEST_FIELD_REJECTED', 'The project preparation request contains unsupported fields.')
      if (admissionState !== 'ready') throw fail(409, 'PROJECT_BASELINE_STALE', 'The admitted project baseline is stale.')
      if (configuration === null || configurationView.state !== 'confirmed') throw fail(409, 'CONFIGURATION_REQUIRED', 'Confirm project settings before preparing the target.')
      if (typeof body.configuration_id !== 'string' || body.configuration_id !== configuration.configuration_id) {
        throw fail(409, 'CONFIGURATION_STALE', 'The project configuration has changed; confirm it again.')
      }
      if (activePreparation !== null || preparation.state === 'preparing') throw fail(409, 'PROJECT_PREPARATION_ACTIVE', 'Project preparation is already active.')
      // A ready target owns its immutable output; only a settings change (which releases it) may
      // start another preparation, so no prepared output is ever replaced without release.
      if (preparation.state === 'ready') throw fail(409, 'PROJECT_ALREADY_PREPARED', 'The project target is already prepared; change the settings to prepare again.')
      const controller = new AbortController()
      activePreparation = controller
      const sequence = ++preparationSequence
      preparation = projectPreparationView('preparing')
      void completePreparation(sequence, controller, configuration)
      sendJson(res, 202, { state: 'preparing' })
      return
    }
    if (pathname === '/api/project/captures') {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      const body = await parseJsonRequest(req)
      if (configurationChanging) throw changingRefusal()
      if (!hasOnlyKeys(body, PROJECT_CAPTURE_FIELDS) || typeof body.configuration_id !== 'string' || typeof body.output_sha256 !== 'string') {
        throw fail(400, 'REQUEST_FIELD_REJECTED', 'The capture request contains unsupported fields.')
      }
      if (configuration === null || configurationView.state !== 'confirmed' || body.configuration_id !== configuration.configuration_id) {
        throw fail(409, 'CONFIGURATION_STALE', 'The project configuration has changed; confirm it again.')
      }
      if (preparation.state !== 'ready' || !targetOwned) throw fail(409, 'PROJECT_NOT_PREPARED', 'Prepare the project target before capturing.')
      const ready = preparation as unknown as ProjectPreparation
      if (body.output_sha256 !== ready.output_sha256) throw fail(409, 'PREPARATION_STALE', 'The prepared target has changed.')
      if (mode.openDemonstration === undefined) throw fail(409, 'DEMONSTRATION_UNAVAILABLE', 'This Studio cannot record a demonstration.')
      if (demonstration === null) {
        const runId = newProjectUuid()
        const lifecycle = createProjectRun({ runId, projectCheckIds: configuration.required_project_checks.map((check) => check.id) })
        lifecycle.transition('configuration-required')
        lifecycle.transition('preparing')
        lifecycle.transition('demonstration-ready')
        const ports = mode.openDemonstration({ runId, configuration, preparation: Object.freeze({ target_url: ready.target_url, output_sha256: ready.output_sha256, checks: ready.checks }) })
        demonstration = Object.freeze({ runId, service: createProjectDemonstration({ lifecycle, configurationId: configuration.configuration_id, ...ports }) })
      }
      const current = demonstration
      const outcome = await current.service.start()
      if (demonstration !== current) throw revokedRefusal()
      if (!outcome.ok) throw refuseDemonstration(outcome.code)
      sendJson(res, 200, { run_id: current.runId, capture_id: outcome.value.capture_id, state: 'recording' })
      return
    }
    const captureRoute = /^\/api\/project\/captures\/([^/]+)\/(finish|discard|analyze)$/.exec(pathname)
    if (captureRoute !== null) {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      const captureId = captureRoute[1] ?? ''
      const action = captureRoute[2]
      const body = await parseJsonRequest(req)
      if (action === 'analyze') {
        const description = body.description
        const validDescription = description === undefined || description === null || (typeof description === 'string' && DEMONSTRATION_DESCRIPTION.safeParse(description).success)
        if (!hasOnlyKeys(body, PROJECT_ANALYZE_FIELDS) || body.submit !== true || !validDescription) {
          throw fail(400, 'REQUEST_FIELD_REJECTED', 'Analysis needs the explicit submission and an optional safe description.')
        }
      } else if (Object.keys(body).length !== 0) {
        throw fail(400, 'REQUEST_FIELD_REJECTED', 'This capture request takes an empty object.')
      }
      const current = demonstration
      if (current === null || !projectUuidSchema.safeParse(captureId).success) throw fail(404, 'CAPTURE_UNKNOWN', 'The capture does not exist.')
      if (action === 'finish') {
        const outcome = await current.service.finish(captureId)
        if (demonstration !== current) throw revokedRefusal()
        if (!outcome.ok) throw refuseDemonstration(outcome.code)
        sendJson(res, 200, { run_id: current.runId, ...outcome.value })
      } else if (action === 'discard') {
        const outcome = await current.service.discard(captureId)
        if (demonstration !== current) throw revokedRefusal()
        if (!outcome.ok) throw refuseDemonstration(outcome.code)
        sendJson(res, 200, { run_id: current.runId, capture_id: captureId, state: 'discarded' })
      } else {
        const outcome = await current.service.analyze(captureId, { description: typeof body.description === 'string' ? body.description : null })
        if (demonstration !== current) throw revokedRefusal()
        if (!outcome.ok) throw refuseDemonstration(outcome.code)
        sendJson(res, 200, { run_id: current.runId, interpretation: outcome.value.interpretation })
      }
      return
    }
    const runRoute = /^\/api\/project\/runs\/([^/]+)(?:\/(clarify|cancel|verify))?$/.exec(pathname)
    if (runRoute !== null) {
      const runId = runRoute[1] ?? ''
      const action = runRoute[2]
      if (action === undefined) {
        if (method !== 'GET') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
        const current = demonstration
        if (current === null || current.runId !== runId) throw fail(404, 'RUN_UNKNOWN', 'The run does not exist.')
        sendJson(res, 200, runView(current))
        return
      }
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
      const body = await parseJsonRequest(req)
      if (action === 'clarify') {
        if (!hasOnlyKeys(body, PROJECT_CLARIFY_FIELDS) || typeof body.question_id !== 'string' || typeof body.answer !== 'string' || !DEMONSTRATION_ANSWER.safeParse(body.answer).success) {
          throw fail(400, 'REQUEST_FIELD_REJECTED', 'A clarification needs the current question ID and a safe answer.')
        }
      } else if (Object.keys(body).length !== 0) {
        throw fail(400, 'REQUEST_FIELD_REJECTED', 'This run request takes an empty object.')
      }
      const current = demonstration
      if (current === null || current.runId !== runId) throw fail(404, 'RUN_UNKNOWN', 'The run does not exist.')
      if (action === 'cancel') {
        current.service.cancel()
        sendJson(res, 202, runView(current))
        return
      }
      if (action === 'verify') {
        const verified = await current.service.verify()
        if (demonstration !== current) throw revokedRefusal()
        if (!verified.ok) throw refuseDemonstration(verified.code)
        sendJson(res, 200, runView(current))
        return
      }
      const outcome = await current.service.clarify(body.question_id as string, body.answer as string)
      if (demonstration !== current) throw revokedRefusal()
      if (!outcome.ok) throw refuseDemonstration(outcome.code)
      sendJson(res, 200, { run_id: current.runId, interpretation: outcome.value.interpretation })
      return
    }
    if (pathname.startsWith('/api/')) throw fail(404, 'NOT_FOUND', 'The requested route does not exist.')
    if (studioRoot === null) throw fail(404, 'NOT_FOUND', 'The requested route does not exist.')
    if (method !== 'GET' && method !== 'HEAD') throw fail(405, 'METHOD_NOT_ALLOWED', 'The request method is not allowed.')
    const segments = requestSegments(req.url)
    const bytes = segments === null ? null : await readServedFile(studioRoot, segments)
    if (segments === null || bytes === null) throw fail(404, 'NOT_FOUND', 'The requested route does not exist.')
    const extension = path.extname(segments.at(-1) ?? '').toLowerCase()
    res.statusCode = 200
    res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream')
    res.setHeader('Content-Length', String(bytes.length))
    res.end(method === 'HEAD' ? undefined : bytes)
  }

  server.on('request', withStudioGuards(session, route))
  return Object.freeze({
    session,
    origin: session.origin,
    address: Object.freeze({ ...address }),
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        ++preparationSequence
        activePreparation?.abort()
        activePreparation = null
        try {
          await closeDemonstration()
          await releaseTarget()
        } finally {
          await new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          })
        }
      })()
      return closing
    },
  })
}
