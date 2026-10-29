import { readFile } from 'node:fs/promises'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { META_MODEL_ID, parseEvidenceBundle, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import type { Scenario } from '../../packages/flowproof/src/contracts/index.js'
import { buildDiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import type { DiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import { ModelTransportError } from '../../packages/flowproof/src/model/transport.js'
import type { DiagnoseOptions, ModelTransport } from '../../packages/flowproof/src/model/transport.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'

// T050: the production Meta Model API adapter that T051 implements in
// `packages/flowproof/src/model/metaClient.ts`. One diagnosis is exactly one stateless Responses API
// request to `muse-spark-1.3` with `store: false` and a strict JSON Schema, sent through the pinned
// OpenAI SDK with `maxRetries: 0` and the scenario's `timeouts.model_ms`. Success, 429, 5xx,
// connection failure, timeout, and abort each cost exactly one HTTP request, and every failure
// rejects with a fail-closed `ModelTransportError`. The key comes only from `MODEL_API_KEY` in the
// explicit environment the adapter is given; no metric, log line, or error carries the key, the
// prompt, or a provider payload. A local fake `fetch` answers every request: the suite never
// reaches the network, and the developer's real `MODEL_API_KEY` is unreachable while it runs.

export type MetaFailureCode =
  | 'PROVIDER_CREDENTIAL_MISSING'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_CONNECTION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_RESPONSE_INVALID'

/** The one sanitized record a diagnose call reports; never prompt, payload, provider text, or key. */
export interface MetaRequestMetrics {
  readonly model: string
  readonly outcome: 'completed' | MetaFailureCode
  /** The status of the one HTTP response; null when no response arrived. */
  readonly http_status: number | null
  readonly latency_ms: number
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
}

export type MetaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface MetaTransportOptions {
  /** The explicit environment; the adapter reads only `MODEL_API_KEY` from it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The HTTP implementation handed to the SDK; production uses the global `fetch`. */
  readonly fetch?: MetaFetch
  /** Receives exactly one sanitized metrics record per diagnose call. */
  readonly onMetrics?: (metrics: MetaRequestMetrics) => void
}

export interface MetaClientModule {
  createMetaTransport(options: MetaTransportOptions): ModelTransport
}

const metaClient = (): Promise<MetaClientModule> =>
  loadPendingModule<MetaClientModule>('packages/flowproof/src/model/metaClient.ts', 'T051', ['createMetaTransport'])

const RESPONSES_URL = 'https://api.meta.ai/v1/responses'
const TARGET = 'apps/demo-chart/src/filterData.ts'
const SYNTHETIC_KEY = 'synthetic-meta-key-t050-0000000001'
// Ambient look-alikes the adapter must never use: SDK environment fallbacks and other key names.
const DECOY = 'synthetic-decoy-t050-0000000002'
// Raw secrets seeded into the prompt inputs; sanitization removes them before transmission.
const SEEDED = ['sk-flowproofseededmeta00000001', 'sk-flowproofseededmeta00000002'] as const
// Non-secret canaries that survive sanitization, so they reveal where prompt or payload text travels.
const PROMPT_CANARY = 'flowproof-prompt-canary-t050'
const SOURCE_CANARY = 'flowproof-source-canary-t050'
const RESPONSE_CANARY = 'flowproof-response-canary-t050'
const PROVIDER_CANARY = 'flowproof-provider-canary-t050'
const NEVER_EMITTED = [SYNTHETIC_KEY, DECOY, ...SEEDED, PROMPT_CANARY, SOURCE_CANARY, RESPONSE_CANARY, PROVIDER_CANARY]

// The OpenAI SDK falls back to these when a client option is omitted; every test runs with them set.
const SDK_ENV_DECOYS = {
  OPENAI_API_KEY: DECOY,
  OPENAI_ADMIN_KEY: DECOY,
  OPENAI_BASE_URL: `https://${DECOY}.invalid/v1`,
  OPENAI_ORG_ID: DECOY,
  OPENAI_PROJECT_ID: DECOY,
  OPENAI_CUSTOM_HEADERS: `Authorization: Bearer ${DECOY}\nX-FlowProof-Decoy: ${DECOY}`,
  OPENAI_LOG: 'debug',
} as const

const HERO = (await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })).scenario
const shorter = parseScenario({ ...HERO, timeouts: { ...HERO.timeouts, model_ms: 1_234 } })
if (!shorter.ok) throw new Error('The shorter-budget scenario is invalid.')
const SHORTER: Scenario = shorter.value

const failure = parseEvidenceBundle(
  JSON.parse(await readFile(new URL('../fixtures/contracts/evidence-bundle.valid-failure.json', import.meta.url), 'utf8')),
)
if (!failure.ok) throw new Error('The failure Evidence Bundle fixture is invalid.')
const FAILURE = failure.value

// The sanitized one-file prompt that the Studio builds for a run, with seeded raw secrets.
const PROMPT: DiagnosisPrompt = buildDiagnosisPrompt({
  runId: FAILURE.run_id,
  goal: `Find the incorrect Canvas filtering behavior (${PROMPT_CANARY}). api_key=${SEEDED[0]}`,
  failureBundle: FAILURE,
  observations: { console: { entries: [{ level: 'error', text: `request failed password=${SEEDED[1]}` }] } },
  permittedSourcePaths: [TARGET],
  source: { path: TARGET, content: `${git(REPO_ROOT, 'show', `HEAD:${TARGET}`)}// ${SOURCE_CANARY}\n` },
})
const PROMPT_TEXT = `${PROMPT.instructions}\n${JSON.stringify(PROMPT.input)}`
if (![PROMPT_CANARY, SOURCE_CANARY].every((canary) => PROMPT_TEXT.includes(canary)) || SEEDED.some((seed) => PROMPT_TEXT.includes(seed))) {
  throw new Error('The prompt under test must keep its canaries and drop its seeded secrets.')
}

const recorded = loadRecordedHeroResponse() as { readonly summary: string }
const DIAGNOSIS = { ...recorded, summary: `${recorded.summary} ${RESPONSE_CANARY}` }

interface RecordedRequest {
  readonly url: string
  readonly method: string
  /** Lower-cased request headers without `authorization`, which is reduced to `auth`. */
  readonly headers: Readonly<Record<string, string>>
  /** A label, never the value, so no credential can reach an assertion message. */
  readonly auth: 'synthetic' | 'absent' | 'other'
  readonly body: string
  readonly signal: AbortSignal | null
}

type Reply = (request: RecordedRequest) => Response | Promise<Response>

interface Harness {
  readonly transport: ModelTransport
  readonly requests: readonly RecordedRequest[]
  readonly metrics: readonly MetaRequestMetrics[]
  /** Settles when the first request reaches the fake provider. */
  readonly sent: Promise<void>
}

async function bodyText(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
  const body = init?.body
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  return input instanceof Request ? input.clone().text() : ''
}

async function recordRequest(input: string | URL | Request, init: RequestInit | undefined): Promise<RecordedRequest> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  const authorization = headers.get('authorization')
  headers.delete('authorization')
  return Object.freeze({
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
    headers: Object.freeze(Object.fromEntries(headers)),
    auth: authorization === null ? 'absent' : authorization === `Bearer ${SYNTHETIC_KEY}` ? 'synthetic' : 'other',
    body: await bodyText(input, init),
    signal: init?.signal ?? (input instanceof Request ? input.signal : null),
  })
}

/** The adapter under test, wired to a local fake provider and a metrics sink. */
async function harness(reply: Reply, env: Readonly<Record<string, string | undefined>> = { MODEL_API_KEY: SYNTHETIC_KEY }): Promise<Harness> {
  const { createMetaTransport } = await metaClient()
  const requests: RecordedRequest[] = []
  const metrics: MetaRequestMetrics[] = []
  let markSent = (): void => undefined
  const sent = new Promise<void>((resolve) => {
    markSent = resolve
  })
  const fetch: MetaFetch = async (input, init) => {
    const request = await recordRequest(input, init)
    requests.push(request)
    markSent()
    return reply(request)
  }
  const transport = createMetaTransport({ env, fetch, onMetrics: (record) => metrics.push(structuredClone(record)) })
  return { transport, requests, metrics, sent }
}

const diagnose = (transport: ModelTransport, options: Partial<DiagnoseOptions> = {}): Promise<unknown> =>
  transport.diagnose(PROMPT, { signal: new AbortController().signal, timeoutMs: HERO.timeouts.model_ms, ...options })

/** Waits for the first request without timers, so fake clocks stay where the test put them. */
const untilSent = (provider: Harness, attempt: Promise<unknown>): Promise<unknown> =>
  Promise.race([provider.sent, attempt.catch(() => undefined)])

const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic_t050', ...headers },
  })

// A retrying client would retry these immediately, so a missing `maxRetries: 0` fails fast.
const RETRY_NOW = { 'retry-after-ms': '1', 'x-should-retry': 'true' }

const providerError = (status: number): Response =>
  jsonReply(
    status,
    { error: { message: `Rejected ${PROVIDER_CANARY} for ${SYNTHETIC_KEY}: ${PROMPT_CANARY}`, type: 'synthetic_error', code: null } },
    RETRY_NOW,
  )

const completed = (text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'resp_synthetic_t050',
  object: 'response',
  created_at: 1_793_145_600,
  status: 'completed',
  model: META_MODEL_ID,
  store: false,
  output: [
    {
      id: 'msg_synthetic_t050',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: { input_tokens: 1_234, output_tokens: 567, total_tokens: 1_801 },
  ...overrides,
})

const succeed: Reply = () => jsonReply(200, completed(JSON.stringify(DIAGNOSIS)))

/** Never answers; rejects like `fetch` once the request signal aborts. */
const hang: Reply = ({ signal }) =>
  new Promise<Response>((_resolve, reject) => {
    if (signal === null) return
    const abort = (): void => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })

function expectNothingLeaked(label: string, text: string): void {
  // Booleans keep any leaked value out of the assertion message.
  for (const marker of NEVER_EMITTED) expect(text.includes(marker), `${label} must not carry ${marker}`).toBe(false)
}

async function expectFailClosed(attempt: Promise<unknown>, code: MetaFailureCode): Promise<void> {
  let caught: unknown
  try {
    await attempt
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ModelTransportError)
  expect((caught as ModelTransportError).code).toBe(code)
  // The message, stack, and any cause chain stay free of the key, the prompt, and provider text.
  expectNothingLeaked('the rejection', inspect(caught, { depth: 8 }))
}

const METRIC_KEYS = ['http_status', 'input_tokens', 'latency_ms', 'model', 'outcome', 'output_tokens', 'total_tokens']

function expectOneMetric(metrics: readonly MetaRequestMetrics[], expected: Partial<MetaRequestMetrics>): void {
  expect(metrics).toHaveLength(1)
  const [record] = metrics
  expect(Object.keys(record ?? {}).sort()).toEqual(METRIC_KEYS)
  expect(record).toMatchObject({ model: META_MODEL_ID, ...expected })
  expect(Number.isFinite(record?.latency_ms) && (record?.latency_ms ?? -1) >= 0).toBe(true)
  for (const tokens of [record?.input_tokens, record?.output_tokens, record?.total_tokens]) {
    expect(tokens === null || Number.isInteger(tokens)).toBe(true)
  }
  expectNothingLeaked('the metrics record', JSON.stringify(record))
}

const bodyOf = (request: RecordedRequest | undefined): Record<string, unknown> => JSON.parse(request?.body ?? 'null') as Record<string, unknown>

/** The one user input, as a bare string or a single `input_text` message. */
function inputTextOf(body: Record<string, unknown>): string {
  const { input } = body
  if (typeof input === 'string') return input
  expect(Array.isArray(input) && input.length === 1, 'the input holds exactly one message').toBe(true)
  const [message] = input as Array<Record<string, unknown>>
  expect(message?.role).toBe('user')
  const content = message?.content
  if (typeof content === 'string') return content
  expect(Array.isArray(content) && content.length === 1, 'the message holds exactly one part').toBe(true)
  const [part] = content as Array<Record<string, unknown>>
  expect(part?.type).toBe('input_text')
  expect(typeof part?.text).toBe('string')
  return String(part?.text)
}

interface SchemaNode {
  readonly $ref?: string
  readonly type?: unknown
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: readonly string[]
  readonly additionalProperties?: unknown
  readonly items?: SchemaNode
  readonly $defs?: Readonly<Record<string, SchemaNode>>
}

/** Every object node of a schema, with local `$ref`s resolved, keyed by its property path. */
function objectNodes(root: SchemaNode): Map<string, SchemaNode> {
  const nodes = new Map<string, SchemaNode>()
  const resolve = (node: SchemaNode): SchemaNode => {
    if (node.$ref === undefined) return node
    const target = root.$defs?.[node.$ref.replace('#/$defs/', '')]
    if (target === undefined) throw new Error(`The response schema has an unresolvable reference ${node.$ref}.`)
    return resolve(target)
  }
  const visit = (raw: SchemaNode, path: string): void => {
    const node = resolve(raw)
    if (node.items) visit(node.items, `${path}[]`)
    if (!node.properties) return
    nodes.set(path, node)
    for (const [name, child] of Object.entries(node.properties)) visit(child, path === '' ? name : `${path}.${name}`)
  }
  visit(root, '')
  return nodes
}

const realEnv = process.env
let ambientKeyReads = 0
let output: string[] = []
let globalFetch: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // The developer's real key stays unreachable: process-environment reads of `MODEL_API_KEY` are
  // counted and answered as absent, without reading or changing the real value.
  ambientKeyReads = 0
  const hidden = (name: string | symbol): boolean => {
    if (name !== 'MODEL_API_KEY') return false
    ambientKeyReads += 1
    return true
  }
  process.env = new Proxy(realEnv, {
    get: (target, name) => (hidden(name) ? undefined : Reflect.get(target, name)),
    has: (target, name) => !hidden(name) && Reflect.has(target, name),
    getOwnPropertyDescriptor: (target, name) => (hidden(name) ? undefined : Reflect.getOwnPropertyDescriptor(target, name)),
    ownKeys: (target) => Reflect.ownKeys(target).filter((name) => name !== 'MODEL_API_KEY'),
  })
  for (const [name, value] of Object.entries(SDK_ENV_DECOYS)) vi.stubEnv(name, value)

  output = []
  const capture = (...args: unknown[]): void => {
    output.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8 }))).join(' '))
  }
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(capture)
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      capture(String(chunk))
      return true
    })
  }
  globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('Live network access is forbidden in unit tests.')))
})

afterEach(() => {
  // Every test: no request bypassed the injected fetch, and nothing reached a log or stream.
  const fetchedLive = globalFetch.mock.calls.length
  const logged = output.join('\n')
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.env = realEnv
  expect(fetchedLive).toBe(0)
  expectNothingLeaked('console and stdio output', logged)
})

describe('Meta Responses API request', () => {
  it('sends exactly one stateless strict-schema request for the sanitized one-file prompt', async () => {
    const provider = await harness(succeed)

    await expect(diagnose(provider.transport)).resolves.toEqual(DIAGNOSIS)

    expect(provider.requests).toHaveLength(1)
    const [request] = provider.requests
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(RESPONSES_URL)
    const body = bodyOf(request)
    expect(body.model).toBe(META_MODEL_ID)
    expect(body.store).toBe(false)
    expect(body.stream ?? false).toBe(false)
    for (const stateful of ['previous_response_id', 'conversation', 'background', 'tools', 'tool_choice', 'prompt']) {
      expect(body, stateful).not.toHaveProperty(stateful)
    }
    // The prompt travels unchanged: fixed instructions plus the one sanitized input document.
    expect(body.instructions).toBe(PROMPT.instructions)
    expect(JSON.parse(inputTextOf(body))).toEqual(PROMPT.input)
    expect(PROMPT.input.permitted_source.path).toBe(TARGET)
    for (const secret of [...SEEDED, SYNTHETIC_KEY]) expect(request?.body.includes(secret), secret).toBe(false)
  })

  it('requests the diagnosis contract as a strict JSON Schema', async () => {
    const provider = await harness(succeed)

    await diagnose(provider.transport)

    const format = (bodyOf(provider.requests[0]).text as { format?: Record<string, unknown> } | undefined)?.format
    expect(format).toMatchObject({ type: 'json_schema', strict: true })
    expect(String(format?.name)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    const schema = format?.schema as SchemaNode
    expect(schema.type).toBe('object')
    const nodes = objectNodes(schema)
    expect(Object.keys(nodes.get('')?.properties ?? {}).sort()).toEqual(['candidate', 'claims', 'root_cause', 'summary'])
    expect(Object.keys(nodes.get('claims[]')?.properties ?? {}).sort()).toEqual(['evidence_ids', 'text'])
    expect(Object.keys(nodes.get('candidate')?.properties ?? {}).sort()).toEqual(['evidence_ids', 'target_paths', 'unified_diff'])
    // Strict decoding: every object is closed and requires every property it declares.
    for (const [path, node] of nodes) {
      expect(node.additionalProperties, path).toBe(false)
      expect([...(node.required ?? [])].sort(), path).toEqual(Object.keys(node.properties ?? {}).sort())
    }
  })

  it('repeats the same self-contained request for every call instead of keeping history', async () => {
    const provider = await harness(succeed)

    await diagnose(provider.transport)
    await diagnose(provider.transport)

    expect(provider.requests).toHaveLength(2)
    expect(bodyOf(provider.requests[1])).toEqual(bodyOf(provider.requests[0]))
    expect(provider.metrics).toHaveLength(2)
  })

  it('reports one sanitized metrics record with the model, status, latency, and token usage', async () => {
    const provider = await harness(succeed)

    await diagnose(provider.transport)

    expectOneMetric(provider.metrics, {
      outcome: 'completed',
      http_status: 200,
      input_tokens: 1_234,
      output_tokens: 567,
      total_tokens: 1_801,
    })
  })
})

describe('Meta credential source', () => {
  it('authenticates only with MODEL_API_KEY from the explicit environment', async () => {
    const provider = await harness(succeed, {
      MODEL_API_KEY: SYNTHETIC_KEY,
      OPENAI_API_KEY: DECOY,
      META_API_KEY: DECOY,
      model_api_key: DECOY,
    })

    await diagnose(provider.transport)

    const [request] = provider.requests
    expect(request?.auth).toBe('synthetic')
    // SDK environment fallbacks never change the endpoint or add headers.
    expect(request?.url).toBe(RESPONSES_URL)
    for (const [name, value] of Object.entries(request?.headers ?? {})) expect(value.includes(DECOY), name).toBe(false)
    expect(request?.url.includes(SYNTHETIC_KEY)).toBe(false)
    expect(request?.body.includes(SYNTHETIC_KEY)).toBe(false)
    expect(ambientKeyReads).toBe(0)
  })

  it.each([
    ['no MODEL_API_KEY', {}],
    ['a blank MODEL_API_KEY', { MODEL_API_KEY: '   ' }],
    ['only look-alike key names', { OPENAI_API_KEY: DECOY, META_API_KEY: DECOY, model_api_key: DECOY }],
  ])('fails closed without a request for %s', async (_label, env: Record<string, string>) => {
    const provider = await harness(succeed, env)

    await expectFailClosed(diagnose(provider.transport), 'PROVIDER_CREDENTIAL_MISSING')

    expect(provider.requests).toHaveLength(0)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_CREDENTIAL_MISSING', http_status: null })
    expect(ambientKeyReads).toBe(0)
  })

  it('checks readiness against the explicit environment it is given and never exposes the key', async () => {
    const provider = await harness(succeed)
    const { transport } = provider

    expect(transport.model).toBe(META_MODEL_ID)
    expect(transport.checkReadiness({ MODEL_API_KEY: SYNTHETIC_KEY })).toEqual({ ready: true })
    for (const env of [{}, { MODEL_API_KEY: '' }, { OPENAI_API_KEY: DECOY }, { model_api_key: SYNTHETIC_KEY }]) {
      expect(transport.checkReadiness(env)).toMatchObject({ ready: false, code: 'PROVIDER_CREDENTIAL_MISSING' })
    }
    expectNothingLeaked('the transport', inspect(transport, { depth: 8, showHidden: true }))
    expect(provider.requests).toHaveLength(0)
    expect(ambientKeyReads).toBe(0)
  })
})

describe('Meta provider failures', () => {
  it.each([
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_SERVER_ERROR'],
    [502, 'PROVIDER_SERVER_ERROR'],
    [503, 'PROVIDER_SERVER_ERROR'],
  ] as const)('fails closed after exactly one request on HTTP %i', async (status, code) => {
    const provider = await harness(() => providerError(status))

    await expectFailClosed(diagnose(provider.transport), code)

    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: code, http_status: status })
  })

  it.each([400, 401, 403, 409, 422])('fails closed after exactly one request on HTTP %i', async (status) => {
    const provider = await harness(() => providerError(status))

    await expectFailClosed(diagnose(provider.transport), 'PROVIDER_REQUEST_REJECTED')

    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_REQUEST_REJECTED', http_status: status })
  })

  it('fails closed after exactly one request when the connection fails', async () => {
    const provider = await harness(() => Promise.reject(new TypeError(`fetch failed: ${PROVIDER_CANARY}`)))

    await expectFailClosed(diagnose(provider.transport), 'PROVIDER_CONNECTION_FAILED')

    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_CONNECTION_FAILED', http_status: null })
  })

  it.each([
    ['an incomplete response', () => jsonReply(200, completed(JSON.stringify(DIAGNOSIS), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))],
    ['a failed response', () => jsonReply(200, completed(JSON.stringify(DIAGNOSIS), { status: 'failed', error: { code: 'server_error', message: PROVIDER_CANARY } }))],
    [
      'a refusal without output text',
      () =>
        jsonReply(200, {
          ...completed(''),
          output: [
            {
              id: 'msg_synthetic_t050',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: `Refused: ${RESPONSE_CANARY}` }],
            },
          ],
        }),
    ],
    ['output text that is not JSON', () => jsonReply(200, completed(`Not JSON: ${RESPONSE_CANARY}`))],
    ['a body that is not a Responses API object', () => new Response(`<html>${RESPONSE_CANARY}</html>`, { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('fails closed after exactly one request on %s', async (_label, reply: Reply) => {
    const provider = await harness(reply)

    await expectFailClosed(diagnose(provider.transport), 'PROVIDER_RESPONSE_INVALID')

    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_RESPONSE_INVALID', http_status: 200 })
  })

  it('keeps provider error text out of every log line even when SDK debug logging is requested', async () => {
    const provider = await harness(
      () => new Response(`Upstream echoed ${PROVIDER_CANARY} ${PROMPT_CANARY} Bearer ${SYNTHETIC_KEY}`, { status: 503, headers: RETRY_NOW }),
    )

    await expectFailClosed(diagnose(provider.transport), 'PROVIDER_SERVER_ERROR')

    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_SERVER_ERROR', http_status: 503 })
    expect(process.env.OPENAI_LOG).toBe('debug')
    // The shared afterEach check proves that no console or stdio output carried the echoed text.
  })
})

describe('Meta request timeout and cancellation', () => {
  it.each([
    ['the Hero scenario', HERO],
    ['a shorter scenario budget', SHORTER],
  ])('aborts the one request exactly at timeouts.model_ms for %s', async (_label, scenario) => {
    const provider = await harness(hang)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeoutMs = scenario.timeouts.model_ms
    let settled = false
    const attempt = diagnose(provider.transport, { timeoutMs })
    void attempt.then(
      () => (settled = true),
      () => (settled = true),
    )

    await untilSent(provider, attempt)
    expect(provider.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(provider.requests[0]?.signal?.aborted).toBe(false)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.requests[0]?.signal?.aborted).toBe(true)
    // A retrying client would schedule another attempt inside this window.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.requests).toHaveLength(1)

    await expectFailClosed(attempt, 'PROVIDER_TIMEOUT')
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_TIMEOUT', http_status: null })
  })

  it('aborts the one in-flight request when the caller cancels the stage', async () => {
    const provider = await harness(hang)
    const controller = new AbortController()
    const attempt = diagnose(provider.transport, { signal: controller.signal })

    await untilSent(provider, attempt)
    expect(provider.requests).toHaveLength(1)
    controller.abort()

    await expectFailClosed(attempt, 'PROVIDER_ABORTED')
    expect(provider.requests[0]?.signal?.aborted).toBe(true)
    expect(provider.requests).toHaveLength(1)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_ABORTED', http_status: null })
  })

  it('never sends a request for a stage that is already cancelled', async () => {
    const provider = await harness(succeed)

    await expectFailClosed(diagnose(provider.transport, { signal: AbortSignal.abort() }), 'PROVIDER_ABORTED')

    expect(provider.requests).toHaveLength(0)
    expectOneMetric(provider.metrics, { outcome: 'PROVIDER_ABORTED', http_status: null })
  })
})
