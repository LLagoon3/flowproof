/**
 * Spec006 project-live Meta model client (T028).
 *
 * One session per run. Each exchange is one stateless Responses API request to the fixed
 * `https://api.meta.ai/v1/responses` endpoint and `muse-spark-1.3`, with `store: false`, a strict
 * closed phase response format, the prompt's actual `input_image` blocks unchanged, no tool or
 * history fields, `maxRetries: 0`, refused redirects and the pinned SDK's environment fallbacks
 * disabled. The key comes only from `MODEL_API_KEY` in the explicit host environment the session is
 * given. Budgets are per run: one analysis, one clarified re-analysis admitted only by this run's
 * validated `clarify` result, and one correction admitted only after this run's validated `ready`
 * analysis of the same capture. A slot is spent when an exchange starts, so failures never retry.
 * Each exchange is bounded by the 90-second provider budget; cancellation is sticky, and a response
 * arriving after cancellation or timeout is discarded rather than turned into success.
 *
 * Every started exchange yields one S1 ProviderInvocation whose observed model and response ID come
 * from the validated response, never from configuration. No record, error or log carries the key,
 * prompt, provider body, provider error text or reasoning. An injected HTTP implementation is always
 * labelled `test_transport`, which can never satisfy live acceptance. This client does not prove a
 * baseline replay: the correction prompt's baseline boundary is supplied by the host orchestrator
 * (S6), which must derive it from an actual executed replay.
 */
import { createHash } from 'node:crypto'

import OpenAI, { APIConnectionTimeoutError } from 'openai'

import { META_MODEL_ID } from '../contracts/index.js'
import {
  EXECUTION_LIMITS,
  PROJECT_LIMITS,
  PROJECT_SCHEMA_VERSION,
  ProviderInvocationSchema,
  projectUuidSchema,
  type InvocationStatus,
  type ProviderInvocation,
  type ProviderTransport,
} from '../project/contracts.js'
import type { MetaFetch } from './metaClient.js'
import {
  PROJECT_ANALYSIS_INSTRUCTIONS,
  PROJECT_CLARIFIED_ANALYSIS_INSTRUCTIONS,
  PROJECT_CORRECTION_INSTRUCTIONS,
  validateProjectAnalysisOutput,
  validateProjectCorrectionOutput,
  type ProjectAnalysisOutput,
  type ProjectCorrectionOutput,
  type ProjectPrompt,
  type ProjectPromptPhase,
  type ProjectPromptResult,
} from './projectPrompt.js'
import { MODEL_API_KEY_ENV } from './transport.js'

export const PROJECT_META_ENDPOINT = 'https://api.meta.ai/v1/responses'
const META_BASE_URL = 'https://api.meta.ai/v1'
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,128}$/
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const MAX_LATENCY_MS = EXECUTION_LIMITS.provider_timeout_ms * 2

// ---------------------------------------------------------------------------------------
// Strict closed phase response formats (lengths, patterns and references stay with the
// S1/prompt validators, which never trust a schema-valid response on its own)
// ---------------------------------------------------------------------------------------

type JsonSchema = Readonly<Record<string, unknown>>
const STRING: JsonSchema = { type: 'string' }
const INTEGER: JsonSchema = { type: 'integer' }
const BOOLEAN: JsonSchema = { type: 'boolean' }
const literal = (value: string): JsonSchema => ({ type: 'string', enum: [value] })
const oneOfStrings = (...values: string[]): JsonSchema => ({ type: 'string', enum: values })
const array = (items: JsonSchema): JsonSchema => ({ type: 'array', items })
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const anyOf = (...options: JsonSchema[]): JsonSchema => ({ anyOf: options })

const LOCATOR = anyOf(
  object({ kind: literal('test-id'), value: STRING }),
  object({ kind: literal('role'), role: STRING, name: STRING }),
  object({ kind: literal('css'), selector: STRING }),
)
const VIEWPORT = object({ width: INTEGER, height: INTEGER, device_scale_factor: { type: 'integer', enum: [1] } })
const WAIT = anyOf(
  object({ kind: literal('visible'), locator: LOCATOR }),
  object({ kind: literal('text'), locator: LOCATOR, text: STRING }),
  object({ kind: literal('path'), path: STRING }),
)
const ACTION = anyOf(
  object({ op: literal('click'), locator: LOCATOR }),
  object({ op: literal('fill'), locator: LOCATOR, value: STRING }),
  object({ op: literal('select'), locator: LOCATOR, value: STRING }),
  object({ op: literal('scroll'), target: anyOf(object({ kind: literal('page') }), object({ kind: literal('element'), locator: LOCATOR })), x: INTEGER, y: INTEGER }),
  object({ op: literal('navigate'), path: STRING }),
  object({ op: literal('wait'), until: WAIT, timeout_ms: INTEGER }),
)
const CONDITION = anyOf(
  object({ kind: literal('element-visible'), locator: LOCATOR, visible: BOOLEAN }),
  object({ kind: literal('element-count'), locator: LOCATOR, count: INTEGER }),
  object({ kind: literal('text'), locator: LOCATOR, match: oneOfStrings('exact', 'normalized'), text: STRING }),
  object({ kind: literal('form-value'), locator: LOCATOR, value: STRING }),
  object({ kind: literal('path'), path: STRING }),
  object({ kind: literal('no-error'), error_type: oneOfStrings('console', 'page-error', 'network-error'), fingerprint: STRING }),
)
const CITATIONS = array(STRING)
const READY = object({
  status: literal('ready'),
  observed_problem: STRING,
  citations: CITATIONS,
  replay: object({ entry_path: STRING, viewport: VIEWPORT, actions: array(ACTION) }),
  expected_conditions: array(CONDITION),
  task_condition_index: INTEGER,
  intent_summary: STRING,
  support_explanation: STRING,
})
const CLARIFY = object({
  status: literal('clarify'),
  observed_facts: STRING,
  citations: CITATIONS,
  question: object({ question_id: STRING, text: STRING, missing_intent: STRING, alternatives: array(STRING) }),
})
const UNSUPPORTED = object({ status: literal('unsupported'), reason: STRING, explanation: STRING, citations: CITATIONS })

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

export interface ProjectResponseFormat {
  readonly type: 'json_schema'
  readonly name: string
  readonly strict: true
  readonly schema: JsonSchema
}
const responseFormat = (name: string, schema: JsonSchema): ProjectResponseFormat => deepFreeze({ type: 'json_schema', name, strict: true, schema })

/** The analysis variant travels as `{result}` because a strict root must be one object. */
export const PROJECT_ANALYSIS_RESPONSE_FORMAT = responseFormat('flowproof_project_analysis', object({ result: anyOf(READY, CLARIFY, UNSUPPORTED) }))
/** The clarified re-analysis cannot ask another question. */
export const PROJECT_CLARIFIED_ANALYSIS_RESPONSE_FORMAT = responseFormat('flowproof_project_clarified_analysis', object({ result: anyOf(READY, UNSUPPORTED) }))
/** Summary, citations, target paths and one diff; no command, verdict or new condition field. */
export const PROJECT_CORRECTION_RESPONSE_FORMAT = responseFormat('flowproof_project_correction', object({ summary: STRING, citations: CITATIONS, target_paths: array(STRING), patch: STRING }))

const PHASES: Readonly<Record<ProjectPromptPhase, { readonly instructions: string; readonly format: ProjectResponseFormat; readonly wrapped: boolean }>> = {
  analysis: { instructions: PROJECT_ANALYSIS_INSTRUCTIONS, format: PROJECT_ANALYSIS_RESPONSE_FORMAT, wrapped: true },
  'clarified-analysis': { instructions: PROJECT_CLARIFIED_ANALYSIS_INSTRUCTIONS, format: PROJECT_CLARIFIED_ANALYSIS_RESPONSE_FORMAT, wrapped: true },
  correction: { instructions: PROJECT_CORRECTION_INSTRUCTIONS, format: PROJECT_CORRECTION_RESPONSE_FORMAT, wrapped: false },
}

// ---------------------------------------------------------------------------------------
// Coded failures with fixed text
// ---------------------------------------------------------------------------------------

const MESSAGES = {
  PROVIDER_CREDENTIAL_MISSING: 'The live Meta provider requires MODEL_API_KEY in the host environment.',
  PROVIDER_RATE_LIMITED: 'Meta Model API rate-limited the project request.',
  PROVIDER_SERVER_ERROR: 'Meta Model API failed the project request with a server error.',
  PROVIDER_REQUEST_REJECTED: 'Meta Model API rejected the project request.',
  PROVIDER_REDIRECT_REFUSED: 'Meta Model API answered with a redirect, which is refused.',
  PROVIDER_CONNECTION_FAILED: 'The project request could not reach Meta Model API.',
  PROVIDER_TIMEOUT: 'The project request exceeded the provider exchange budget.',
  PROVIDER_ABORTED: 'The project model request was cancelled.',
  PROVIDER_RESPONSE_INVALID: 'Meta Model API returned no usable strict-schema phase result.',
  PROVIDER_IDENTITY_MISMATCH: 'Meta Model API returned no valid response ID or a different model.',
  PROVIDER_REQUEST_LIMIT: 'The project model request exceeds the request size limit.',
  PROVIDER_PROMPT_INVALID: 'The project prompt is not an intact prompt for this run and phase.',
  PROVIDER_BUDGET_EXHAUSTED: 'This run already used its model call for this phase.',
  PROVIDER_CLARIFICATION_REQUIRED: 'A clarified analysis needs this run’s own clarification question.',
  PROVIDER_PHASE_ORDER: 'A correction needs this run’s validated ready analysis of the same capture.',
  PROVIDER_BUSY: 'Another project model request of this run is still active.',
  PROVIDER_RECORD_INVALID: 'The provider invocation record could not be validated.',
  PROMPT_OUTPUT_PHASE_MISMATCH: 'The phase result does not belong to this prompt phase.',
  PROMPT_OUTPUT_INVALID: 'The phase result failed the closed FlowProof contract.',
  PROMPT_OUTPUT_CITATION_UNKNOWN: 'The phase result cites evidence that was not included.',
  PROMPT_OUTPUT_QUESTION_MISMATCH: 'The clarification question does not match the host question.',
  PROMPT_OUTPUT_CLARIFICATION_REPEATED: 'A clarified analysis asked another question.',
  PROMPT_OUTPUT_PATH_UNKNOWN: 'The correction targets a file that was not included.',
} as const
export type ProjectModelErrorCode = keyof typeof MESSAGES

export interface ProjectModelFailure {
  readonly code: ProjectModelErrorCode
  readonly message: string
}
export type ProjectModelResult<T> =
  | { readonly ok: true; readonly output: T; readonly invocation: ProviderInvocation }
  | { readonly ok: false; readonly error: ProjectModelFailure; readonly invocation: ProviderInvocation | null }

/** Carries only a code; nothing the provider sent rides along. */
class ProjectModelError extends Error {
  constructor(readonly code: ProjectModelErrorCode) {
    super(MESSAGES[code])
    this.name = 'ProjectModelError'
  }
}
const failure = (code: ProjectModelErrorCode): ProjectModelFailure => Object.freeze({ code, message: MESSAGES[code] })

// ---------------------------------------------------------------------------------------
// Response reading (mirrors the legacy adapter; reasoning items are ignored, never kept)
// ---------------------------------------------------------------------------------------

const SILENT_LOGGER = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined }
const NO_USAGE = Object.freeze({ input_tokens: null, output_tokens: null, total_tokens: null })
type Usage = ProviderInvocation['usage']
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const tokenCount = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000 ? (value as number) : null)
const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex')

function readUsage(payload: unknown): Usage {
  const usage = isRecord(payload) ? payload.usage : undefined
  if (!isRecord(usage)) return NO_USAGE
  return { input_tokens: tokenCount(usage.input_tokens), output_tokens: tokenCount(usage.output_tokens), total_tokens: tokenCount(usage.total_tokens) }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
  }
}

function readIdentity(payload: unknown, field: 'model' | 'id', pattern: RegExp): string | null {
  const value = isRecord(payload) ? payload[field] : undefined
  return typeof value === 'string' && pattern.test(value) ? value : null
}

/** Exactly one `output_text` part across assistant messages of a completed response; no refusal. */
function readOutputText(payload: unknown): string {
  if (!isRecord(payload) || payload.status !== 'completed' || !Array.isArray(payload.output)) throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
  const texts: string[] = []
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'message') continue
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
      texts.push(part.text)
    }
  }
  if (texts.length !== 1) throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
  return texts[0]!
}

function classify(error: unknown, stopped: ProjectModelErrorCode | null, refused: ProjectModelErrorCode | null, httpStatus: number | null): ProjectModelErrorCode {
  if (stopped !== null) return stopped
  if (refused !== null) return refused
  if (error instanceof ProjectModelError) return error.code
  if (error instanceof APIConnectionTimeoutError) return 'PROVIDER_TIMEOUT'
  if (httpStatus === null) return 'PROVIDER_CONNECTION_FAILED'
  if (httpStatus >= 300 && httpStatus <= 399) return 'PROVIDER_REDIRECT_REFUSED'
  if (httpStatus === 429) return 'PROVIDER_RATE_LIMITED'
  if (httpStatus >= 500 && httpStatus <= 599) return 'PROVIDER_SERVER_ERROR'
  if (httpStatus >= 400 && httpStatus <= 499) return 'PROVIDER_REQUEST_REJECTED'
  return 'PROVIDER_RESPONSE_INVALID'
}

function readApiKey(env: unknown): string | null {
  const value: unknown = isRecord(env) ? env[MODEL_API_KEY_ENV] : undefined
  const key = typeof value === 'string' ? value.trim() : ''
  return key === '' ? null : key
}

// ---------------------------------------------------------------------------------------
// Per-run session
// ---------------------------------------------------------------------------------------

/** An explicitly labelled in-process HTTP fake; its records are `test_transport`. */
export interface ProjectModelFake {
  readonly label: 'test_transport'
  readonly fetch: MetaFetch
}

export interface ProjectModelSessionOptions {
  /** Host-minted run identity every prompt and record must carry. */
  readonly run_id: string
  /** Explicit host environment; only `MODEL_API_KEY` is read, once per exchange. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Run cancellation; once aborted the session stays cancelled. */
  readonly signal?: AbortSignal
  /** Per-exchange budget in ms, at most the 90-second provider budget (default). */
  readonly timeoutMs?: number
  readonly fake?: ProjectModelFake
  readonly now?: () => Date
}

export interface ProjectModelSession {
  readonly run_id: string
  readonly transport: ProviderTransport
  readonly timeout_ms: number
  readonly cancelled: boolean
  /** `analysis` or the single explicit `clarified-analysis` prompt. */
  analyze(prompt: ProjectPrompt): Promise<ProjectModelResult<ProjectAnalysisOutput>>
  /** The single correction; the prompt's baseline boundary is host-owned evidence, not proven here. */
  correct(prompt: ProjectPrompt): Promise<ProjectModelResult<ProjectCorrectionOutput>>
  cancel(): void
  invocations(): readonly ProviderInvocation[]
}

interface CaptureBinding {
  readonly capture_id: string
  readonly report_sha256: string
}

export function createProjectModelSession(options: ProjectModelSessionOptions): ProjectModelSession {
  if (!isRecord(options) || !projectUuidSchema.safeParse(options.run_id).success || !isRecord(options.env)) throw new TypeError('PROJECT_MODEL_SESSION_INVALID')
  const timeoutMs = options.timeoutMs ?? EXECUTION_LIMITS.provider_timeout_ms
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXECUTION_LIMITS.provider_timeout_ms) throw new RangeError('PROJECT_MODEL_TIMEOUT_INVALID')
  const fake = options.fake
  if (fake !== undefined && (!isRecord(fake) || fake.label !== 'test_transport' || typeof fake.fetch !== 'function')) throw new TypeError('PROJECT_MODEL_FAKE_UNLABELLED')
  const runId = options.run_id
  const env = options.env
  const transport: ProviderTransport = fake === undefined ? 'meta' : 'test_transport'
  const now = options.now ?? (() => new Date())

  const run = new AbortController()
  if (options.signal?.aborted) run.abort()
  else options.signal?.addEventListener('abort', () => run.abort(), { once: true })
  const used: Record<ProjectPromptPhase, boolean> = { analysis: false, 'clarified-analysis': false, correction: false }
  const invocationIds = new Set<string>()
  const records: ProviderInvocation[] = []
  let active = false
  let pendingQuestion: (CaptureBinding & { readonly question_id: string }) | null = null
  let ready: CaptureBinding | null = null

  const refuse = (code: ProjectModelErrorCode): { readonly ok: false; readonly error: ProjectModelFailure; readonly invocation: null } => ({ ok: false, error: failure(code), invocation: null })

  function intact(prompt: ProjectPrompt): boolean {
    try {
      const manifest = prompt.manifest
      if (manifest.run_id !== runId || manifest.phase !== prompt.phase || PHASES[prompt.phase]?.instructions !== prompt.instructions) return false
      if (!projectUuidSchema.safeParse(manifest.invocation_id).success) return false
      const serialized = JSON.stringify({ instructions: prompt.instructions, input: prompt.input })
      return serialized === prompt.serialized && sha256Hex(serialized) === manifest.input_sha256
    } catch {
      return false
    }
  }

  const requestBody = (prompt: ProjectPrompt): string =>
    JSON.stringify({ model: META_MODEL_ID, instructions: prompt.instructions, input: prompt.input, store: false, text: { format: PHASES[prompt.phase].format } })

  function admit(prompt: ProjectPrompt, route: 'analysis' | 'correction'): ProjectModelErrorCode | null {
    if (run.signal.aborted) return 'PROVIDER_ABORTED'
    if (active) return 'PROVIDER_BUSY'
    if (!isRecord(prompt) || !intact(prompt)) return 'PROVIDER_PROMPT_INVALID'
    const phase = prompt.phase
    if ((route === 'correction') !== (phase === 'correction')) return 'PROVIDER_PROMPT_INVALID'
    if (used[phase]) return 'PROVIDER_BUDGET_EXHAUSTED'
    if (invocationIds.has(prompt.manifest.invocation_id)) return 'PROVIDER_PROMPT_INVALID'
    const manifest = prompt.manifest
    const sameCapture = (binding: CaptureBinding | null): boolean => binding !== null && binding.capture_id === manifest.capture_id && binding.report_sha256 === manifest.report_sha256
    if (phase === 'clarified-analysis' && (!sameCapture(pendingQuestion) || manifest.clarification?.question_id !== pendingQuestion?.question_id)) return 'PROVIDER_CLARIFICATION_REQUIRED'
    if (phase === 'correction' && !sameCapture(ready)) return 'PROVIDER_PHASE_ORDER'
    if (Buffer.byteLength(requestBody(prompt), 'utf8') > PROJECT_LIMITS.maxRequestBytes) return 'PROVIDER_REQUEST_LIMIT'
    return null
  }

  async function invoke<T>(prompt: ProjectPrompt, validate: (prompt: ProjectPrompt, output: unknown) => ProjectPromptResult<T>): Promise<ProjectModelResult<T>> {
    const phase = prompt.phase
    const manifest = prompt.manifest
    used[phase] = true
    invocationIds.add(manifest.invocation_id)
    active = true
    const startedAt = now()
    const started = performance.now()
    let httpStatus: number | null = null
    let sentBytes = 0
    let usage: Usage = NO_USAGE
    let observedModel: string | null = null
    let responseId: string | null = null
    let stopped: ProjectModelErrorCode | null = null
    let refused: ProjectModelErrorCode | null = null
    let errorCode: ProjectModelErrorCode | null = null
    let output: T | undefined

    const controller = new AbortController()
    let halt: (error: ProjectModelError) => void = () => undefined
    const halted = new Promise<never>((_, reject) => {
      halt = reject
    })
    halted.catch(() => undefined)
    const stop = (code: ProjectModelErrorCode): void => {
      if (stopped !== null) return
      stopped = code
      controller.abort()
      halt(new ProjectModelError(code))
    }
    const onCancel = (): void => stop('PROVIDER_ABORTED')
    run.signal.addEventListener('abort', onCancel, { once: true })
    const deadline = setTimeout(() => stop('PROVIDER_TIMEOUT'), timeoutMs)
    try {
      const apiKey = readApiKey(env)
      if (apiKey === null) throw new ProjectModelError('PROVIDER_CREDENTIAL_MISSING')
      const httpFetch: MetaFetch = fake?.fetch ?? globalThis.fetch
      // Only this adapter's headers are sent (the SDK would merge custom headers from the process
      // environment), redirects are refused so the key reaches one origin, and the actual wire
      // body is measured against the request limit before it leaves.
      const send: MetaFetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : null
        if (body === null) refused = 'PROVIDER_PROMPT_INVALID'
        else if (Buffer.byteLength(body, 'utf8') > PROJECT_LIMITS.maxRequestBytes) refused = 'PROVIDER_REQUEST_LIMIT'
        if (refused !== null || body === null) throw new ProjectModelError(refused ?? 'PROVIDER_PROMPT_INVALID')
        sentBytes = Buffer.byteLength(body, 'utf8')
        const response = await httpFetch(input, {
          method: init?.method ?? 'POST',
          headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
          signal: init?.signal ?? controller.signal,
          redirect: 'error',
        })
        httpStatus = response.status
        return response
      }
      // Every option with a process-environment fallback is explicit.
      const client = new OpenAI({
        apiKey,
        adminAPIKey: null,
        organization: null,
        project: null,
        webhookSecret: null,
        baseURL: META_BASE_URL,
        maxRetries: 0,
        timeout: timeoutMs,
        fetch: send,
        logLevel: 'off',
        logger: SILENT_LOGGER,
      })
      const params = { model: META_MODEL_ID, instructions: prompt.instructions, input: prompt.input, store: false, text: { format: PHASES[phase].format } }
      const work = (async () => {
        const response = await client.responses.create(params as never, { signal: controller.signal }).asResponse()
        return parseJson(await response.text())
      })()
      work.catch(() => undefined)
      const payload = await Promise.race([work, halted])
      if (stopped !== null) throw new ProjectModelError(stopped)
      usage = readUsage(payload)
      observedModel = readIdentity(payload, 'model', MODEL_NAME)
      responseId = readIdentity(payload, 'id', RESPONSE_ID)
      const text = readOutputText(payload)
      if (observedModel !== META_MODEL_ID || responseId === null) throw new ProjectModelError('PROVIDER_IDENTITY_MISMATCH')
      let document = parseJson(text)
      if (PHASES[phase].wrapped) {
        if (!isRecord(document) || Object.keys(document).length !== 1 || !Object.hasOwn(document, 'result')) throw new ProjectModelError('PROVIDER_RESPONSE_INVALID')
        document = document.result
      }
      const validated = validate(prompt, document)
      if (!validated.ok) throw new ProjectModelError(validated.error.code in MESSAGES ? (validated.error.code as ProjectModelErrorCode) : 'PROMPT_OUTPUT_INVALID')
      if (stopped !== null) throw new ProjectModelError(stopped)
      output = validated.value
    } catch (error) {
      errorCode = classify(error, stopped, refused, httpStatus)
    } finally {
      clearTimeout(deadline)
      run.signal.removeEventListener('abort', onCancel)
      active = false
    }

    const status: InvocationStatus = errorCode === null ? 'completed' : errorCode === 'PROVIDER_ABORTED' ? 'cancelled' : 'failed'
    const record = ProviderInvocationSchema.safeParse({
      schema_version: PROJECT_SCHEMA_VERSION,
      invocation_id: manifest.invocation_id,
      run_id: runId,
      phase,
      transport,
      requested_model: META_MODEL_ID,
      observed_model: observedModel,
      response_id: responseId,
      input_sha256: manifest.input_sha256,
      included_source_paths: [...manifest.included_source_paths],
      included_image_ids: [...manifest.included_image_ids],
      included_observation_ids: [...manifest.included_observation_ids],
      request_bytes: sentBytes,
      source_bytes: manifest.source_bytes,
      status,
      error_code: errorCode,
      http_status: httpStatus,
      usage,
      latency_ms: Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(performance.now() - started))),
      started_at: startedAt.toISOString(),
      completed_at: now().toISOString(),
    })
    if (!record.success) return refuse('PROVIDER_RECORD_INVALID')
    const invocation = deepFreeze(record.data)
    records.push(invocation)
    if (errorCode !== null || output === undefined) return { ok: false, error: failure(errorCode ?? 'PROVIDER_RESPONSE_INVALID'), invocation }
    return { ok: true, output, invocation }
  }

  async function analyze(prompt: ProjectPrompt): Promise<ProjectModelResult<ProjectAnalysisOutput>> {
    const refusal = admit(prompt, 'analysis')
    if (refusal !== null) return refuse(refusal)
    const result = await invoke(prompt, validateProjectAnalysisOutput)
    const binding = { capture_id: prompt.manifest.capture_id, report_sha256: prompt.manifest.report_sha256 }
    if (prompt.phase === 'clarified-analysis') pendingQuestion = null
    if (result.ok && result.output.status === 'clarify') pendingQuestion = Object.freeze({ ...binding, question_id: result.output.question.question_id })
    if (result.ok && result.output.status === 'ready') ready = Object.freeze(binding)
    return result
  }

  async function correct(prompt: ProjectPrompt): Promise<ProjectModelResult<ProjectCorrectionOutput>> {
    const refusal = admit(prompt, 'correction')
    if (refusal !== null) return refuse(refusal)
    return invoke(prompt, validateProjectCorrectionOutput)
  }

  return Object.freeze({
    run_id: runId,
    transport,
    timeout_ms: timeoutMs,
    get cancelled(): boolean {
      return run.signal.aborted
    },
    analyze,
    correct,
    cancel: (): void => run.abort(),
    invocations: (): readonly ProviderInvocation[] => Object.freeze([...records]),
  })
}
