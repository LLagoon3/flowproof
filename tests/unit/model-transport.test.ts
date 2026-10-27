import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { META_MODEL_ID, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import type { Scenario } from '../../packages/flowproof/src/contracts/index.js'
import type { DiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import { ModelTransportError, TransportSelectionError, selectTransport } from '../../packages/flowproof/src/model/transport.js'
import type { ModelTransport } from '../../packages/flowproof/src/model/transport.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { createRecordedTransport } from '../support/recordedTransport.js'
import { REPO_ROOT } from '../support/repoFixture.js'

// T035 details beyond the provider seam: readiness reads only the explicit environment it is
// given, the live Meta transport that T051 registers fails closed without any network request
// when the process environment holds no key, and selection accepts no option or override it does
// not recognize.

const HERO = (await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })).scenario
const failureScenario = parseScenario(
  JSON.parse(await readFile(new URL('../fixtures/contracts/scenario.valid-failure.json', import.meta.url), 'utf8')),
)
if (!failureScenario.ok) throw new Error('The Failure scenario fixture is invalid.')
const FAILURE: Scenario = failureScenario.value
// A synthetic value: tests never read or set the developer's real credential.
const SYNTHETIC_KEY = 'synthetic-readiness-value'
const PROMPT: DiagnosisPrompt = {
  instructions: 'synthetic',
  input: { developer_goal: 'synthetic', failure_evidence: [], permitted_source: { path: 'synthetic.ts', evidence_id: 'ev_failure_source_001', content: '' } },
}

afterEach(() => {
  vi.restoreAllMocks()
})

function selectionError(select: () => unknown): TransportSelectionError {
  let caught: unknown
  try {
    select()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(TransportSelectionError)
  return caught as TransportSelectionError
}

describe('live Meta transport readiness', () => {
  it('is ready only when the explicit environment holds a non-blank MODEL_API_KEY', () => {
    const live = selectTransport(HERO)

    expect(live.model).toBe(META_MODEL_ID)
    const ready = live.checkReadiness({ MODEL_API_KEY: SYNTHETIC_KEY })
    expect(ready).toEqual({ ready: true })
    expect(JSON.stringify(ready)).not.toContain(SYNTHETIC_KEY)
    for (const env of [{}, { MODEL_API_KEY: '' }, { MODEL_API_KEY: '   ' }, { MODEL_API_KEY: undefined }, { model_api_key: SYNTHETIC_KEY }]) {
      expect(live.checkReadiness(env)).toMatchObject({ ready: false, code: 'PROVIDER_CREDENTIAL_MISSING' })
    }
  })

  it('fails the diagnosis closed without a network request when the process environment holds no key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live network access is forbidden in unit tests.'))
    // The developer's real key stays unreachable: it is answered as absent, never read or changed.
    const realEnv = process.env
    process.env = new Proxy(realEnv, {
      get: (target, name) => (name === 'MODEL_API_KEY' ? undefined : Reflect.get(target, name)),
      has: (target, name) => name !== 'MODEL_API_KEY' && Reflect.has(target, name),
      getOwnPropertyDescriptor: (target, name) => (name === 'MODEL_API_KEY' ? undefined : Reflect.getOwnPropertyDescriptor(target, name)),
      ownKeys: (target) => Reflect.ownKeys(target).filter((name) => name !== 'MODEL_API_KEY'),
    })
    try {
      const live = selectTransport(HERO)

      const attempt = live.diagnose(PROMPT, { signal: new AbortController().signal, timeoutMs: HERO.timeouts.model_ms })
      await expect(attempt).rejects.toBeInstanceOf(ModelTransportError)
      await expect(attempt).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_MISSING' })
    } finally {
      process.env = realEnv
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('transport selection options', () => {
  it.each([
    ['an unknown option', { provider: 'fixture' }],
    ['a transport name option', { transport: 'recorded' }],
    ['a non-object options value', 'recorded'],
  ])('rejects %s', (_label, options) => {
    const error = selectionError(() => selectTransport(HERO, options as never))
    expect(error.code).toBe('TRANSPORT_OPTIONS_INVALID')
  })

  it('rejects a mutable transport object even when its methods are callable', () => {
    const recorded = createRecordedTransport()
    const mutable: ModelTransport = { model: null, checkReadiness: recorded.checkReadiness, diagnose: recorded.diagnose }

    expect(selectionError(() => selectTransport(HERO, { testTransport: mutable })).code).toBe('TRANSPORT_OVERRIDE_INVALID')
  })

  it('never lets a test transport substitute for the fixture provider', () => {
    const error = selectionError(() => selectTransport(FAILURE, { testTransport: createRecordedTransport() }))
    expect(error.code).toBe('TRANSPORT_OVERRIDE_INVALID')
  })
})
