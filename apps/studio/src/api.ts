import type {
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  RunResult,
  RunState,
  RunStatus,
  ScenarioCase,
  StudioEvent,
  StudioEventType,
} from '../../../packages/flowproof/src/contracts/index.js'

// The browser side of contracts/studio-api.md. Every HTTP and SSE payload is untrusted: it is
// checked here with narrow, browser-safe mirrors of the committed contracts before any state
// sees it. The engine's Zod contracts are reused for types only, so neither Zod nor Node code
// reaches the Studio bundle. Errors carry a stable code and a client-authored message and never
// echo a response body, a server message, or a rejected value.

export type {
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  RunResult,
  RunState,
  RunStatus,
  ScenarioCase,
  StudioEvent,
  StudioEventType,
}

export const CONTRACT_SCHEMA_VERSION = '1.0.0'
export const META_MODEL_ID = 'muse-spark-1.3'
/** The server's chat bound; a longer request is never sent. */
export const MAX_REQUEST_TEXT_LENGTH = 500

export const SCENARIO_CASES = ['hero', 'failure-invalid-citation'] as const satisfies readonly ScenarioCase[]
export const GATE_IDS = [
  'failure_reproduced',
  'evidence_complete',
  'citations_valid',
  'patch_scope_valid',
  'patch_applied',
  'dataset_matches',
  'canvas_matches',
  'secret_scan_clean',
  'original_worktree_unchanged',
] as const satisfies readonly GateId[]
export const GATE_STATUSES = ['pass', 'fail', 'unevaluable'] as const satisfies readonly GateStatus[]
export const RUN_STATES = [
  'initialized',
  'reproducing',
  'failure_captured',
  'diagnosing',
  'candidate_validated',
  'applying',
  'replaying',
  'finalized',
] as const satisfies readonly RunState[]
export const RUN_STATUSES = ['Verified Fix', 'Unverified'] as const satisfies readonly RunStatus[]
export const STUDIO_EVENT_TYPES = [
  'chat_received',
  'phase_started',
  'phase_completed',
  'evidence_added',
  'diagnosis_ready',
  'candidate_ready',
  'gate_updated',
  'run_finalized',
  'agent_message',
] as const satisfies readonly StudioEventType[]

/** Safe presentation metadata for one committed case, as listed by `GET /api/scenarios`. */
export interface ScenarioSummary {
  readonly scenario_id: string
  readonly case: ScenarioCase
  readonly title: string
  readonly default_request: string
}

/** The `202 Accepted` body of `POST /api/runs`. */
export interface RunStart {
  readonly request_id: string
  readonly run_id: string
  readonly events_url: string
}

export type ResultRead = { readonly state: 'running' } | { readonly state: 'finalized'; readonly result: RunResult }

// ---------------------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------------------

/** A displayable error: a stable code and a client-authored message. */
export interface StudioError {
  readonly code: string
  readonly message: string
}

const MESSAGES: Readonly<Record<string, string>> = {
  NETWORK_UNAVAILABLE: 'The Studio API could not be reached.',
  REQUEST_ABORTED: 'The request was cancelled.',
  REQUEST_INVALID: 'The request was not sent because an identifier is not valid.',
  REQUEST_TEXT_INVALID: `Enter a request of 1 to ${MAX_REQUEST_TEXT_LENGTH} characters.`,
  RESPONSE_INVALID: 'The Studio API returned a response outside its contract.',
  RESULT_INVALID: 'The run result violates the run-result contract, so no final status is shown.',
  RESULT_RUN_MISMATCH: 'The run result belongs to another run or request, so no final status is shown.',
  EVENT_INVALID: 'A live activity event violated the Studio Event contract, so live activity stopped.',
  EVENT_RUN_MISMATCH: 'A live activity event belonged to another run, so live activity stopped.',
  EVENT_SEQUENCE_DUPLICATE: 'A live activity event repeated a sequence, so live activity stopped.',
  EVENT_SEQUENCE_REORDERED: 'A live activity event arrived out of order, so live activity stopped.',
  EVENT_SEQUENCE_GAP: 'Live activity skipped an event and missed events are not replayed, so it stopped.',
  STREAM_DISCONNECTED: 'Live activity disconnected. Missed events are not replayed; the final result stays available.',
  SESSION_NOT_READY: 'The prepared cases are not available yet.',
  SCENARIO_NOT_SELECTED: 'Select a prepared case before starting a run.',
  RUN_ALREADY_ACTIVE: 'A run is already active in this Studio session.',
  ACTIVE_RUN_EXISTS: 'This Studio session already has an active run.',
  PROVIDER_CREDENTIAL_MISSING: 'The live Meta provider requires MODEL_API_KEY; no run was created.',
  SCENARIO_NOT_REGISTERED: 'The selected case is not a committed scenario.',
  REQUEST_TEXT_TOO_LONG: `The request is limited to ${MAX_REQUEST_TEXT_LENGTH} characters.`,
  REQUEST_TEXT_EMPTY: 'The request must contain a readable goal.',
  RUN_NOT_FOUND: 'The run does not exist in this Studio session.',
  CLIENT_ERROR: 'The Studio client could not complete the operation.',
}
const SERVER_REJECTION = 'The Studio API rejected the request.'
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/** Builds a displayable error for a stable code; unknown codes get a generic message. */
export function studioError(code: string): StudioError {
  const safeCode = ERROR_CODE_PATTERN.test(code) ? code : 'CLIENT_ERROR'
  return Object.freeze({ code: safeCode, message: MESSAGES[safeCode] ?? SERVER_REJECTION })
}

export class StudioClientError extends Error {
  readonly code: string
  /** The HTTP status when a response was received; null otherwise. */
  readonly status: number | null

  constructor(code: string, status: number | null = null) {
    const safe = studioError(code)
    super(safe.message)
    this.name = 'StudioClientError'
    this.code = safe.code
    this.status = status
  }
}

/** Converts anything thrown into a displayable error without reading foreign error text. */
export function toStudioError(error: unknown): StudioError {
  return error instanceof StudioClientError ? studioError(error.code) : studioError('CLIENT_ERROR')
}

// ---------------------------------------------------------------------------------------
// Narrow contract checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^[a-f0-9]{40}$/
const EVIDENCE_ID_PATTERN = /^ev_(?:failure|replay)_(?:actions|dataset|chart|screenshot|console|network|source)_[0-9]{3}$/
const EVENT_ID_PATTERN = /^[0-9a-fA-F-]{36}:[1-9][0-9]*$/
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/
const MAX_TITLE_LENGTH = 200
const MAX_MESSAGE_LENGTH = 500

const EVENT_KEYS = [
  'schema_version',
  'event_id',
  'run_id',
  'sequence',
  'occurred_at',
  'type',
  'phase',
  'message',
  'evidence_ids',
  'gate',
  'artifact_refs',
] as const
const RESULT_KEYS = [
  'schema_version',
  'run_id',
  'request_id',
  'scenario_id',
  'case',
  'started_at',
  'completed_at',
  'original_head',
  'original_status_digest',
  'phase_durations_ms',
  'provider',
  'status',
  'gates',
  'failed_gate_ids',
  'diagnosis_path',
  'candidate_diff_path',
  'failure_screenshot_path',
  'replay_screenshot_path',
  'total_duration_ms',
] as const
const RESULT_PATH_KEYS = ['diagnosis_path', 'candidate_diff_path', 'failure_screenshot_path', 'replay_screenshot_path'] as const
const DURATION_KEYS = ['capture', 'model', 'apply', 'replay', 'finalize'] as const

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasExactKeys = (value: JsonObject, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max
const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
const isMilliseconds = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isUuid = (value: unknown): value is string => matches(value, UUID_PATTERN)
const isEvidenceId = (value: unknown): value is string => matches(value, EVIDENCE_ID_PATTERN)
const isRelativePath = (value: unknown): value is string => matches(value, RELATIVE_PATH_PATTERN)
const isNullablePath = (value: unknown): boolean => value === null || isRelativePath(value)
const isUniqueList = (value: unknown, item: (entry: unknown) => boolean): value is string[] =>
  Array.isArray(value) && value.every(item) && new Set(value).size === value.length

function isTimestamp(value: unknown): value is string {
  const match = typeof value === 'string' ? TIMESTAMP_PATTERN.exec(value) : null
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  const realDay = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return realDay && hour <= 23 && minute <= 59 && second <= 59
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Validated data is copied and frozen so neither the caller nor the UI can change it later. */
const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value))

function isGateSummary(value: unknown): value is GateSummary {
  return (
    isObject(value) &&
    hasExactKeys(value, ['gate_id', 'status', 'reason_code']) &&
    isOneOf(value.gate_id, GATE_IDS) &&
    isOneOf(value.status, GATE_STATUSES) &&
    matches(value.reason_code, REASON_CODE_PATTERN)
  )
}

function isGateOutcome(value: unknown): value is GateOutcome {
  if (!isObject(value) || !hasExactKeys(value, ['gate_id', 'status', 'evidence_ids', 'reason_code', 'message', 'metrics'])) return false
  const { metrics } = value
  return (
    isOneOf(value.gate_id, GATE_IDS) &&
    isOneOf(value.status, GATE_STATUSES) &&
    isUniqueList(value.evidence_ids, isEvidenceId) &&
    matches(value.reason_code, REASON_CODE_PATTERN) &&
    isText(value.message, MAX_MESSAGE_LENGTH) &&
    isObject(metrics) &&
    Object.values(metrics).every(
      (metric) => metric === null || ['string', 'boolean'].includes(typeof metric) || (typeof metric === 'number' && Number.isFinite(metric)),
    )
  )
}

/** Mirrors studio-event.schema.json, including the event ID, gate, and Evidence ID invariants. */
export function parseStudioEvent(input: unknown): StudioEvent | null {
  if (!isObject(input) || !hasExactKeys(input, EVENT_KEYS)) return null
  const { sequence, type, gate } = input
  const valid =
    input.schema_version === CONTRACT_SCHEMA_VERSION &&
    isUuid(input.run_id) &&
    Number.isSafeInteger(sequence) &&
    (sequence as number) >= 1 &&
    matches(input.event_id, EVENT_ID_PATTERN) &&
    input.event_id === `${input.run_id}:${String(sequence)}` &&
    isTimestamp(input.occurred_at) &&
    isOneOf(type, STUDIO_EVENT_TYPES) &&
    (input.phase === null || isOneOf(input.phase, RUN_STATES)) &&
    isText(input.message, MAX_MESSAGE_LENGTH) &&
    isUniqueList(input.evidence_ids, isEvidenceId) &&
    isUniqueList(input.artifact_refs, isRelativePath) &&
    (gate === null || isGateSummary(gate)) &&
    (type === 'gate_updated') === (gate !== null) &&
    (type !== 'evidence_added' || (input.evidence_ids as string[]).length > 0)
  return valid ? frozenCopy(input as unknown as StudioEvent) : null
}

function hasValidProvider(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, ['mode', 'model', 'injected_fault_label'])) return false
  if (value.mode === 'meta') return value.model === META_MODEL_ID && value.injected_fault_label === null
  return value.mode === 'fixture' && value.model === null && typeof value.injected_fault_label === 'string' && value.injected_fault_label.length > 0
}

/** Mirrors run-result.schema.json, including the nine-gate reduction and provider invariants. */
export function parseRunResult(input: unknown): RunResult | null {
  if (!isObject(input) || !hasExactKeys(input, RESULT_KEYS)) return null
  const durations = input.phase_durations_ms
  const gates = input.gates
  if (
    input.schema_version !== CONTRACT_SCHEMA_VERSION ||
    !isUuid(input.run_id) ||
    !isUuid(input.request_id) ||
    !matches(input.scenario_id, KEBAB_ID_PATTERN) ||
    !isOneOf(input.case, SCENARIO_CASES) ||
    !isTimestamp(input.started_at) ||
    !isTimestamp(input.completed_at) ||
    !matches(input.original_head, GIT_OID_PATTERN) ||
    !matches(input.original_status_digest, SHA256_PATTERN) ||
    !isObject(durations) ||
    !hasExactKeys(durations, DURATION_KEYS) ||
    !DURATION_KEYS.every((key) => isMilliseconds(durations[key])) ||
    !hasValidProvider(input.provider) ||
    !isOneOf(input.status, RUN_STATUSES) ||
    !Array.isArray(gates) ||
    !gates.every(isGateOutcome) ||
    !isUniqueList(input.failed_gate_ids, (id) => isOneOf(id, GATE_IDS)) ||
    !RESULT_PATH_KEYS.every((key) => isNullablePath(input[key])) ||
    !isMilliseconds(input.total_duration_ms)
  ) {
    return null
  }
  // Exactly one outcome per required gate, and failed_gate_ids names exactly the non-passing ones.
  if (gates.length !== GATE_IDS.length || !GATE_IDS.every((gateId) => gates.filter((gate) => gate.gate_id === gateId).length === 1)) {
    return null
  }
  const nonPassing = new Set(gates.filter((gate) => gate.status !== 'pass').map((gate) => gate.gate_id))
  const failed = input.failed_gate_ids as string[]
  if (failed.length !== nonPassing.size || !failed.every((gateId) => nonPassing.has(gateId as GateId))) return null
  const consistent =
    input.status === 'Verified Fix' ? nonPassing.size === 0 && RESULT_PATH_KEYS.every((key) => input[key] !== null) : nonPassing.size > 0
  return consistent ? frozenCopy(input as unknown as RunResult) : null
}

function parseScenarioList(input: unknown): readonly ScenarioSummary[] | null {
  if (!isObject(input) || !hasExactKeys(input, ['scenarios']) || !Array.isArray(input.scenarios)) return null
  const scenarios: unknown[] = input.scenarios
  const valid = scenarios.every(
    (entry) =>
      isObject(entry) &&
      hasExactKeys(entry, ['scenario_id', 'case', 'title', 'default_request']) &&
      matches(entry.scenario_id, KEBAB_ID_PATTERN) &&
      isOneOf(entry.case, SCENARIO_CASES) &&
      isText(entry.title, MAX_TITLE_LENGTH) &&
      isText(entry.default_request, MAX_REQUEST_TEXT_LENGTH),
  )
  const ids = scenarios.map((entry) => (entry as ScenarioSummary).scenario_id)
  return valid && new Set(ids).size === ids.length ? frozenCopy(scenarios as ScenarioSummary[]) : null
}

function parseRunStart(input: unknown): RunStart | null {
  if (!isObject(input) || !hasExactKeys(input, ['request_id', 'run_id', 'events_url'])) return null
  const valid = isUuid(input.request_id) && isUuid(input.run_id) && input.events_url === `/api/runs/${String(input.run_id)}/events`
  return valid ? frozenCopy(input as unknown as RunStart) : null
}

/** True when the text may be sent as a run request: non-blank and within the server bound. */
export const isValidRequestText = (text: unknown): text is string =>
  typeof text === 'string' && text.length <= MAX_REQUEST_TEXT_LENGTH && text.trim().length > 0

export type EventOrderViolation = 'EVENT_RUN_MISMATCH' | 'EVENT_SEQUENCE_DUPLICATE' | 'EVENT_SEQUENCE_REORDERED' | 'EVENT_SEQUENCE_GAP'

/**
 * Live-only ordering for one connected run. The first delivered event may follow events emitted
 * before the connection, because missed events are never replayed; every later event must carry
 * the next contiguous sequence of the same run.
 */
export function eventOrderViolation(runId: string, lastSequence: number | null, event: StudioEvent): EventOrderViolation | null {
  if (event.run_id !== runId) return 'EVENT_RUN_MISMATCH'
  if (lastSequence === null) return null
  if (event.sequence === lastSequence) return 'EVENT_SEQUENCE_DUPLICATE'
  if (event.sequence < lastSequence) return 'EVENT_SEQUENCE_REORDERED'
  return event.sequence === lastSequence + 1 ? null : 'EVENT_SEQUENCE_GAP'
}

function assertRunId(runId: string): void {
  if (!isUuid(runId)) throw new StudioClientError('REQUEST_INVALID')
}

/** The closed same-origin route for one registered Evidence ID of a run, for example a screenshot. */
export function evidenceUrl(runId: string, evidenceId: string): string {
  assertRunId(runId)
  if (!isEvidenceId(evidenceId)) throw new StudioClientError('REQUEST_INVALID')
  return `/api/runs/${runId}/evidence/${evidenceId}`
}

// ---------------------------------------------------------------------------------------
// Same-origin client
// ---------------------------------------------------------------------------------------

/** The part of a server-sent message the client reads; `MessageEvent` satisfies it. */
export interface SseMessage {
  readonly type: string
  readonly data?: unknown
  readonly lastEventId?: unknown
}

/** The part of `EventSource` the client uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (message: SseMessage) => void): void
  close(): void
}

export interface StudioClientOptions {
  readonly fetch?: (path: string, init: RequestInit) => Promise<Response>
  readonly openEventSource?: (path: string) => EventSourceLike
}

export interface RunEventHandlers {
  readonly onOpen: () => void
  /** A contract-valid event of this run with the next contiguous sequence. */
  readonly onEvent: (event: StudioEvent) => void
  /** A contract or ordering violation; the stream is already closed. */
  readonly onError: (error: StudioError) => void
  /** The connection dropped before the final event; the stream is closed and never resumed. */
  readonly onDisconnect: () => void
}

export interface RunEventSubscription {
  close(): void
}

export interface StudioClient {
  listScenarios(signal?: AbortSignal): Promise<readonly ScenarioSummary[]>
  startRun(request: { readonly scenarioId: string; readonly requestText: string }, signal?: AbortSignal): Promise<RunStart>
  /** Reads the authoritative result once: still running, or the validated final result. */
  readResult(runId: string, signal?: AbortSignal): Promise<ResultRead>
  /** Reads the result until the run finalizes or the signal aborts. */
  pollResult(runId: string, options?: { readonly intervalMs?: number; readonly signal?: AbortSignal }): Promise<RunResult>
  /** The validated candidate diff text, or null when the run has none. */
  readCandidateDiff(runId: string, signal?: AbortSignal): Promise<string | null>
  /** Attaches to the live event stream of one run. Missed events are never replayed. */
  openRunEvents(runId: string, handlers: RunEventHandlers): RunEventSubscription
}

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DIFF_PREFIX = 'diff --git a/'

const mediaType = (response: Response): string => (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StudioClientError('REQUEST_ABORTED'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new StudioClientError('REQUEST_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseSseMessage(message: SseMessage): StudioEvent | null {
  if (typeof message.data !== 'string') return null
  let data: unknown
  try {
    data = JSON.parse(message.data)
  } catch {
    return null
  }
  const event = parseStudioEvent(data)
  // The SSE record's `event` and `id` fields must restate the validated payload.
  return event !== null && message.type === event.type && message.lastEventId === event.event_id ? event : null
}

export function createStudioClient(options: StudioClientOptions = {}): StudioClient {
  const fetchImpl = options.fetch ?? ((path: string, init: RequestInit) => globalThis.fetch(path, init))
  const openEventSource = options.openEventSource ?? ((path: string) => new EventSource(path))

  const send = async (path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> => {
    try {
      return await fetchImpl(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: signal ?? null })
    } catch {
      throw new StudioClientError(signal?.aborted ? 'REQUEST_ABORTED' : 'NETWORK_UNAVAILABLE')
    }
  }

  const readJson = async (response: Response, code = 'RESPONSE_INVALID'): Promise<unknown> => {
    if (mediaType(response) !== 'application/json') throw new StudioClientError(code, response.status)
    try {
      return JSON.parse(await response.text()) as unknown
    } catch {
      throw new StudioClientError(code, response.status)
    }
  }

  /** Maps a non-success response to its envelope code; anything else is outside the contract. */
  const rejection = async (response: Response): Promise<StudioClientError> => {
    if (response.status < 400 || response.status > 599) return new StudioClientError('RESPONSE_INVALID', response.status)
    let body: unknown
    try {
      body = await readJson(response)
    } catch {
      return new StudioClientError('RESPONSE_INVALID', response.status)
    }
    const error = isObject(body) && hasExactKeys(body, ['error']) ? body.error : null
    const valid =
      isObject(error) && hasExactKeys(error, ['code', 'message']) && matches(error.code, ERROR_CODE_PATTERN) && typeof error.message === 'string'
    return new StudioClientError(valid ? (error.code as string) : 'RESPONSE_INVALID', response.status)
  }

  const getJson = (path: string, signal: AbortSignal | undefined): Promise<Response> =>
    send(path, { method: 'GET', headers: { Accept: 'application/json' } }, signal)

  const readResult = async (runId: string, signal?: AbortSignal): Promise<ResultRead> => {
    assertRunId(runId)
    const response = await getJson(`/api/runs/${runId}/result`, signal)
    if (response.status === 202) {
      const body = await readJson(response)
      if (!isObject(body) || !hasExactKeys(body, ['state']) || body.state !== 'running') throw new StudioClientError('RESPONSE_INVALID', 202)
      return Object.freeze({ state: 'running' })
    }
    if (response.status !== 200) throw await rejection(response)
    const result = parseRunResult(await readJson(response, 'RESULT_INVALID'))
    if (result === null) throw new StudioClientError('RESULT_INVALID', 200)
    if (result.run_id !== runId) throw new StudioClientError('RESULT_RUN_MISMATCH', 200)
    return Object.freeze({ state: 'finalized', result })
  }

  return Object.freeze({
    async listScenarios(signal?: AbortSignal): Promise<readonly ScenarioSummary[]> {
      const response = await getJson('/api/scenarios', signal)
      if (response.status !== 200) throw await rejection(response)
      const scenarios = parseScenarioList(await readJson(response))
      if (scenarios === null) throw new StudioClientError('RESPONSE_INVALID', 200)
      return scenarios
    },

    async startRun(request: { readonly scenarioId: string; readonly requestText: string }, signal?: AbortSignal): Promise<RunStart> {
      if (!matches(request.scenarioId, KEBAB_ID_PATTERN)) throw new StudioClientError('REQUEST_INVALID')
      if (!isValidRequestText(request.requestText)) throw new StudioClientError('REQUEST_TEXT_INVALID')
      const body = JSON.stringify({ scenario_id: request.scenarioId, request_text: request.requestText })
      const response = await send('/api/runs', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body }, signal)
      if (response.status !== 202) throw await rejection(response)
      const start = parseRunStart(await readJson(response))
      if (start === null) throw new StudioClientError('RESPONSE_INVALID', 202)
      return start
    },

    readResult,

    async pollResult(runId: string, options: { readonly intervalMs?: number; readonly signal?: AbortSignal } = {}): Promise<RunResult> {
      const { intervalMs = DEFAULT_POLL_INTERVAL_MS, signal } = options
      for (;;) {
        const read = await readResult(runId, signal)
        if (read.state === 'finalized') return read.result
        await wait(intervalMs, signal)
      }
    },

    async readCandidateDiff(runId: string, signal?: AbortSignal): Promise<string | null> {
      assertRunId(runId)
      const response = await send(`/api/runs/${runId}/artifacts/candidate-diff`, { method: 'GET', headers: { Accept: 'text/plain' } }, signal)
      if (response.status !== 200) {
        const error = await rejection(response)
        if (response.status === 404 && error.code === 'ARTIFACT_NOT_FOUND') return null
        throw error
      }
      const diff = mediaType(response) === 'text/plain' ? await response.text() : ''
      if (!diff.startsWith(DIFF_PREFIX)) throw new StudioClientError('RESPONSE_INVALID', 200)
      return diff
    },

    openRunEvents(runId: string, handlers: RunEventHandlers): RunEventSubscription {
      assertRunId(runId)
      const source = openEventSource(`/api/runs/${runId}/events`)
      let active = true
      let lastSequence: number | null = null
      // Closing also stops EventSource's automatic reconnect, which would resume without replay.
      const stop = (): boolean => {
        if (!active) return false
        active = false
        source.close()
        return true
      }
      const fail = (code: string): void => {
        if (stop()) handlers.onError(studioError(code))
      }
      const receive = (message: SseMessage): void => {
        if (!active) return
        const event = parseSseMessage(message)
        if (event === null) {
          fail('EVENT_INVALID')
          return
        }
        const violation = eventOrderViolation(runId, lastSequence, event)
        if (violation !== null) {
          fail(violation)
          return
        }
        lastSequence = event.sequence
        if (event.type === 'run_finalized') stop()
        handlers.onEvent(event)
      }
      source.addEventListener('open', () => {
        if (active) handlers.onOpen()
      })
      // Unnamed records are not Studio Events; `receive` rejects them by their `message` type.
      for (const type of ['message', ...STUDIO_EVENT_TYPES]) source.addEventListener(type, receive)
      source.addEventListener('error', () => {
        if (stop()) handlers.onDisconnect()
      })
      return Object.freeze({ close: () => void stop() })
    },
  })
}
