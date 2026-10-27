import { parseScenario } from '../contracts/index.js'
import type { Scenario } from '../contracts/index.js'
import { committedProviderFixture } from '../scenario/loadScenario.js'
import type { CommittedProviderFixture } from '../scenario/loadScenario.js'
import { createMetaTransport } from './metaClient.js'
import type { DiagnosisPrompt } from './prompt.js'

// The model transport seam. Ordinary selection resolves the committed Hero scenario to the live
// Meta transport, which receives the process environment and reads only `MODEL_API_KEY` from it
// when a diagnosis starts, and the committed Failure scenario to the labeled fixture transport,
// which replays the evaluation fixture `loadScenario` read for it without a network request or a
// credential. A test transport is accepted only as an in-process object that the
// `startStudio({ testTransport })` entry hands over: no environment variable influences selection,
// and a scenario file, CLI argument, or Studio API body can carry only data, never transport functions.

export const MODEL_API_KEY_ENV = 'MODEL_API_KEY'

export type TransportReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly code: 'PROVIDER_CREDENTIAL_MISSING'; readonly message: string }

export interface DiagnoseOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

export interface ModelTransport {
  /** The model this transport speaks to; null for the fixture or an in-process test transport. */
  readonly model: string | null
  /** Checks credentials against the explicit environment it is given; never reads `process.env`. */
  checkReadiness(env: Readonly<Record<string, string | undefined>>): TransportReadiness
  /** One diagnosis call. Its output is untrusted until strict parsing and the patch guards. */
  diagnose(prompt: DiagnosisPrompt, options: DiagnoseOptions): Promise<unknown>
}

export type TransportSelectionErrorCode =
  | 'TRANSPORT_SCENARIO_INVALID'
  | 'TRANSPORT_OPTIONS_INVALID'
  | 'TRANSPORT_OVERRIDE_INVALID'
  | 'TRANSPORT_PROVIDER_UNAVAILABLE'

export class TransportSelectionError extends Error {
  readonly code: TransportSelectionErrorCode

  constructor(code: TransportSelectionErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TransportSelectionError'
    this.code = code
  }
}

export type ModelTransportErrorCode =
  | 'PROVIDER_CREDENTIAL_MISSING'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_CONNECTION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_RESPONSE_INVALID'

/** A fail-closed provider outcome; messages never carry prompts, payloads, or credentials. */
export class ModelTransportError extends Error {
  readonly code: ModelTransportErrorCode

  constructor(code: ModelTransportErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ModelTransportError'
    this.code = code
  }
}

const READY: TransportReadiness = Object.freeze({ ready: true })
const CREDENTIAL_MISSING: TransportReadiness = Object.freeze({
  ready: false,
  code: 'PROVIDER_CREDENTIAL_MISSING',
  message: `The live Meta provider requires ${MODEL_API_KEY_ENV}.`,
})

/** Ready only when the explicit environment holds a non-blank `MODEL_API_KEY`; the value is never kept. */
export function checkMetaReadiness(env: Readonly<Record<string, string | undefined>>): TransportReadiness {
  const value: unknown = typeof env === 'object' && env !== null ? env[MODEL_API_KEY_ENV] : undefined
  return typeof value === 'string' && value.trim() !== '' ? READY : CREDENTIAL_MISSING
}

/**
 * Replays the committed evaluation fixture as untrusted output: a fresh copy per call, so the
 * engine can never change the fixture, with no network request and no credential.
 */
function createFixtureTransport(fixture: CommittedProviderFixture): ModelTransport {
  return Object.freeze({
    model: null,
    checkReadiness: (): TransportReadiness => READY,
    async diagnose(_prompt: DiagnosisPrompt, options: DiagnoseOptions): Promise<unknown> {
      if (options.signal.aborted) throw new ModelTransportError('PROVIDER_ABORTED', 'The diagnosis request was cancelled.')
      return structuredClone(fixture.output)
    },
  })
}

export interface SelectTransportOptions {
  /** Passed only by the in-process `startStudio({ testTransport })` entry. */
  readonly testTransport?: ModelTransport | undefined
}

/**
 * True only for a frozen in-process transport object with callable methods. Values that came
 * through JSON, argv, the environment, or a scenario file cannot satisfy it, and freezing keeps
 * the selected transport from being swapped during a run.
 */
function isInProcessTransport(value: unknown): value is ModelTransport {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.isFrozen(value)) return false
  const candidate = value as Partial<Record<keyof ModelTransport, unknown>>
  return (
    (candidate.model === null || typeof candidate.model === 'string') &&
    typeof candidate.checkReadiness === 'function' &&
    typeof candidate.diagnose === 'function'
  )
}

function readOverride(options: unknown): ModelTransport | undefined {
  if (options === undefined) return undefined
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TransportSelectionError('TRANSPORT_OPTIONS_INVALID', 'Transport selection options must be an object.')
  }
  if (Reflect.ownKeys(options).some((key) => key !== 'testTransport')) {
    throw new TransportSelectionError('TRANSPORT_OPTIONS_INVALID', 'Transport selection accepts only an in-process test transport.')
  }
  const override = (options as { testTransport?: unknown }).testTransport
  if (override === undefined) return undefined
  if (!isInProcessTransport(override)) {
    throw new TransportSelectionError('TRANSPORT_OVERRIDE_INVALID', 'A test transport must be a frozen in-process transport object.')
  }
  return override
}

/**
 * Resolves the transport for a contract-valid scenario. Hero (`provider.mode=meta`) resolves to
 * the live Meta transport unless the in-process test entry supplies a transport object. A
 * `provider.mode=fixture` case resolves to its committed fixture, available only for a scenario
 * returned by `loadScenario`, and never accepts a test transport.
 */
export function selectTransport(scenario: Scenario, options?: SelectTransportOptions): ModelTransport {
  const parsed = parseScenario(scenario)
  if (!parsed.ok) throw new TransportSelectionError('TRANSPORT_SCENARIO_INVALID', 'The scenario violates the scenario contract.')
  const override = readOverride(options)
  if (parsed.value.provider.mode === 'meta') return override ?? createMetaTransport({ env: process.env })
  if (override !== undefined) {
    throw new TransportSelectionError('TRANSPORT_OVERRIDE_INVALID', 'A test transport substitutes only the live Meta transport.')
  }
  const fixture = committedProviderFixture(scenario)
  if (fixture === null) {
    throw new TransportSelectionError('TRANSPORT_PROVIDER_UNAVAILABLE', 'The fixture provider needs a scenario loaded from the committed registry.')
  }
  return createFixtureTransport(fixture)
}
