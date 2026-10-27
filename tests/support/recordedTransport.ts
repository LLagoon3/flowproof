import { readFileSync } from 'node:fs'

// The deterministic test-only model transport for the Hero scenario. It replays one recorded,
// schema-valid diagnosis and records the prompts it receives. It performs no network I/O,
// needs no credential, and can reach the engine only as the in-process
// `startStudio({ testTransport })` option: no CLI flag, environment variable, scenario field,
// or Studio API body can select it. The committed Hero scenario stays `provider.mode=meta`.

export const RECORDED_HERO_RESPONSE_URL = new URL('../fixtures/provider/hero-recorded-response.json', import.meta.url)

export type TransportReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly code: 'PROVIDER_CREDENTIAL_MISSING'; readonly message: string }

export interface DiagnoseOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

/**
 * The `ModelTransport` shape that T035 implements in `packages/flowproof/src/model/transport.ts`:
 * the model it speaks to, a credential readiness check against an explicit environment, and
 * one diagnosis call that returns untrusted output for strict-schema parsing.
 */
export interface ModelTransportContract {
  readonly model: string | null
  checkReadiness(env: Readonly<Record<string, string | undefined>>): TransportReadiness
  diagnose(prompt: unknown, options: DiagnoseOptions): Promise<unknown>
}

export interface RecordedCall {
  readonly prompt: unknown
  readonly timeoutMs: number
}

export interface RecordedTransport extends ModelTransportContract {
  /** Every prompt received, in order, as detached copies. */
  readonly calls: readonly RecordedCall[]
}

export function loadRecordedHeroResponse(): unknown {
  return JSON.parse(readFileSync(RECORDED_HERO_RESPONSE_URL, 'utf8')) as unknown
}

export function createRecordedTransport(options: { readonly response?: unknown } = {}): RecordedTransport {
  const response = structuredClone(options.response ?? loadRecordedHeroResponse())
  const calls: RecordedCall[] = []
  return Object.freeze({
    model: null,
    calls,
    checkReadiness: (): TransportReadiness => ({ ready: true }),
    async diagnose(prompt: unknown, diagnoseOptions: DiagnoseOptions): Promise<unknown> {
      if (diagnoseOptions.signal.aborted) throw new Error('RECORDED_TRANSPORT_ABORTED: the diagnosis request was cancelled.')
      calls.push(Object.freeze({ prompt: structuredClone(prompt), timeoutMs: diagnoseOptions.timeoutMs }))
      // A fresh copy per call, so the engine can never mutate the recording.
      return structuredClone(response)
    },
  })
}
