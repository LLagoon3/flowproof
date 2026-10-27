import OpenAI, { APIConnectionTimeoutError } from 'openai'

import { META_MODEL_ID } from '../contracts/index.js'
import type { DiagnosisPrompt } from './prompt.js'
// `transport.ts` registers this adapter, so its bindings are used only inside calls, never at load.
import { MODEL_API_KEY_ENV, ModelTransportError, checkMetaReadiness } from './transport.js'
import type { DiagnoseOptions, ModelTransport, ModelTransportErrorCode } from './transport.js'

// The production Meta Model API adapter. One diagnosis is exactly one stateless Responses API
// request to `muse-spark-1.3` with `store: false` and a strict JSON Schema response format, sent
// through the pinned OpenAI SDK with `maxRetries: 0` and bounded by the scenario's model timeout
// and the caller's cancellation. The key comes only from `MODEL_API_KEY` in the explicit
// environment the adapter is given. Every failure rejects with a coded `ModelTransportError`, and
// every call reports one allowlisted metrics record; no error, metric, or log line carries the key,
// the prompt, or provider text.

const META_BASE_URL = 'https://api.meta.ai/v1'

export type MetaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** The one sanitized record a diagnose call reports; never prompt, payload, provider text, or key. */
export interface MetaRequestMetrics {
  readonly model: string
  readonly outcome: 'completed' | ModelTransportErrorCode
  /** The status of the one HTTP response; null when no response arrived. */
  readonly http_status: number | null
  readonly latency_ms: number
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
}

export interface MetaTransportOptions {
  /** The explicit environment; the adapter reads only `MODEL_API_KEY` from it, once per call. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The HTTP implementation handed to the SDK; production uses the global `fetch`. */
  readonly fetch?: MetaFetch
  /** Receives exactly one sanitized metrics record per diagnose call. */
  readonly onMetrics?: (metrics: MetaRequestMetrics) => void
}

// The diagnosis contract as a strict response format: every object is closed and requires every
// property it declares. Lengths, patterns, and uniqueness stay with `parseDiagnosis` and the patch
// guards, which never trust a schema-valid response on its own.
const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const
const DIAGNOSIS_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'flowproof_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'root_cause', 'claims', 'candidate'],
    properties: {
      summary: { type: 'string' },
      root_cause: { type: 'string' },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'evidence_ids'],
          properties: { text: { type: 'string' }, evidence_ids: STRING_ARRAY },
        },
      },
      candidate: {
        type: 'object',
        additionalProperties: false,
        required: ['target_paths', 'evidence_ids', 'unified_diff'],
        properties: { target_paths: STRING_ARRAY, evidence_ids: STRING_ARRAY, unified_diff: { type: 'string' } },
      },
    },
  },
} as const

const FAILURE_MESSAGES: Readonly<Record<ModelTransportErrorCode, string>> = {
  PROVIDER_CREDENTIAL_MISSING: 'The live Meta provider requires MODEL_API_KEY.',
  PROVIDER_RATE_LIMITED: 'Meta Model API rate-limited the diagnosis request.',
  PROVIDER_SERVER_ERROR: 'Meta Model API failed the diagnosis request with a server error.',
  PROVIDER_REQUEST_REJECTED: 'Meta Model API rejected the diagnosis request.',
  PROVIDER_CONNECTION_FAILED: 'The diagnosis request could not reach Meta Model API.',
  PROVIDER_TIMEOUT: 'The diagnosis request exceeded the scenario model timeout.',
  PROVIDER_ABORTED: 'The diagnosis request was cancelled.',
  PROVIDER_RESPONSE_INVALID: 'Meta Model API returned no usable strict-schema diagnosis.',
}

/** A coded failure with fixed text and no cause, so nothing the provider sent can ride along. */
const failure = (code: ModelTransportErrorCode): ModelTransportError => new ModelTransportError(code, FAILURE_MESSAGES[code])

const SILENT_LOGGER = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined }

interface Usage {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
}

const NO_USAGE: Usage = Object.freeze({ input_tokens: null, output_tokens: null, total_tokens: null })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tokenCount = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null)

function readUsage(payload: unknown): Usage {
  const usage = isRecord(payload) ? payload.usage : undefined
  if (!isRecord(usage)) return NO_USAGE
  return {
    input_tokens: tokenCount(usage.input_tokens),
    output_tokens: tokenCount(usage.output_tokens),
    total_tokens: tokenCount(usage.total_tokens),
  }
}

/** Parses provider text; a parse error would quote that text, so only a coded failure leaves. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw failure('PROVIDER_RESPONSE_INVALID')
  }
}

/**
 * The one JSON document a completed response carries: exactly one `output_text` part across the
 * assistant messages and no refusal. Other output items, such as reasoning, are ignored.
 */
function readOutputText(payload: unknown): string {
  if (!isRecord(payload) || payload.status !== 'completed' || !Array.isArray(payload.output)) throw failure('PROVIDER_RESPONSE_INVALID')
  const texts: string[] = []
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'message') continue
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw failure('PROVIDER_RESPONSE_INVALID')
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') throw failure('PROVIDER_RESPONSE_INVALID')
      texts.push(part.text)
    }
  }
  const [text] = texts
  if (texts.length !== 1 || text === undefined) throw failure('PROVIDER_RESPONSE_INVALID')
  return text
}

/** Maps a failed exchange to one code from adapter state and the HTTP status, never error text. */
function classify(error: unknown, stopped: ModelTransportErrorCode | null, httpStatus: number | null): ModelTransportError {
  if (stopped !== null) return failure(stopped)
  if (error instanceof ModelTransportError) return error
  if (error instanceof APIConnectionTimeoutError) return failure('PROVIDER_TIMEOUT')
  if (httpStatus === null) return failure('PROVIDER_CONNECTION_FAILED')
  if (httpStatus === 429) return failure('PROVIDER_RATE_LIMITED')
  if (httpStatus >= 500 && httpStatus <= 599) return failure('PROVIDER_SERVER_ERROR')
  if (httpStatus >= 400 && httpStatus <= 499) return failure('PROVIDER_REQUEST_REJECTED')
  return failure('PROVIDER_RESPONSE_INVALID')
}

/** The non-blank `MODEL_API_KEY` of the explicit environment, read once; null when absent. */
function readApiKey(env: unknown): string | null {
  const value: unknown = isRecord(env) ? env[MODEL_API_KEY_ENV] : undefined
  const key = typeof value === 'string' ? value.trim() : ''
  return key === '' ? null : key
}

/**
 * Creates the live Meta transport. It keeps no credential, client, or history between calls: each
 * diagnosis reads the key, builds a fresh SDK client, and sends one self-contained request.
 */
export function createMetaTransport(options: MetaTransportOptions): ModelTransport {
  const { env, fetch: injectedFetch, onMetrics } = options

  async function diagnose(prompt: DiagnosisPrompt, { signal, timeoutMs }: DiagnoseOptions): Promise<unknown> {
    const started = performance.now()
    let outcome: MetaRequestMetrics['outcome'] = 'completed'
    let httpStatus: number | null = null
    let usage = NO_USAGE
    try {
      if (signal.aborted) throw failure('PROVIDER_ABORTED')
      const apiKey = readApiKey(env)
      if (apiKey === null) throw failure('PROVIDER_CREDENTIAL_MISSING')

      // The deadline covers the whole exchange, including the response body.
      const controller = new AbortController()
      let stopped: ModelTransportErrorCode | null = null
      const stop = (code: ModelTransportErrorCode): void => {
        if (stopped !== null) return
        stopped = code
        controller.abort()
      }

      // The SDK merges `OPENAI_CUSTOM_HEADERS` from the process environment into every request, so
      // the adapter sends only its own headers. Redirects are refused so the key reaches one origin.
      const send: MetaFetch = async (input, init) => {
        const response = await (injectedFetch ?? globalThis.fetch)(input, {
          method: init?.method ?? 'POST',
          headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: init?.body ?? null,
          signal: init?.signal ?? controller.signal,
          redirect: 'error',
        })
        httpStatus = response.status
        return response
      }

      const onAbort = (): void => stop('PROVIDER_ABORTED')
      signal.addEventListener('abort', onAbort, { once: true })
      const deadline = setTimeout(() => stop('PROVIDER_TIMEOUT'), timeoutMs)
      try {
        // Every option with a process-environment fallback is explicit, so `OPENAI_*` variables
        // never choose the endpoint, credential, organization, project, or logging.
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
        const response = await client.responses
          .create(
            {
              model: META_MODEL_ID,
              instructions: prompt.instructions,
              input: JSON.stringify(prompt.input),
              store: false,
              text: { format: DIAGNOSIS_RESPONSE_FORMAT },
            },
            { signal: controller.signal },
          )
          .asResponse()
        const payload = parseJson(await response.text())
        usage = readUsage(payload)
        return parseJson(readOutputText(payload))
      } catch (error) {
        throw classify(error, stopped, httpStatus)
      } finally {
        clearTimeout(deadline)
        signal.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      const coded = error instanceof ModelTransportError ? error : failure('PROVIDER_CONNECTION_FAILED')
      outcome = coded.code
      throw coded
    } finally {
      const metrics: MetaRequestMetrics = Object.freeze({
        model: META_MODEL_ID,
        outcome,
        http_status: httpStatus,
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        ...usage,
      })
      try {
        onMetrics?.(metrics)
      } catch {
        // A metrics sink never changes the diagnosis outcome.
      }
    }
  }

  return Object.freeze({ model: META_MODEL_ID, checkReadiness: checkMetaReadiness, diagnose })
}
