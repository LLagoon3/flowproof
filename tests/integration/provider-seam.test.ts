import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { META_MODEL_ID, parseDiagnosis, parseScenario } from '../../packages/flowproof/src/contracts/index.js'
import type { Scenario } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { LAUNCH_COOKIE_NAME } from '../../packages/flowproof/src/studio/auth.js'
import { assertLauncherImplemented, buildFlowproofCli, runFlowproof } from '../support/flowproofCli.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { createRecordedTransport, loadRecordedHeroResponse } from '../support/recordedTransport.js'
import type { ModelTransportContract } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempClone, createTempDirectory, git, listTree } from '../support/repoFixture.js'

// T030: the recorded Hero provider fixture, the test transport, and the seam that keeps it
// test-only. T035 implements `selectTransport(scenario, { testTransport? })` in
// `packages/flowproof/src/model/transport.ts`; the ordinary Hero resolution is always the live
// Meta transport, and only the in-process `startStudio({ testTransport })` entry passes an
// override. CLI flags, environment variables, scenario fields, and `POST /api/runs` bodies can
// never select the recorded transport.

export interface TransportModule {
  selectTransport(
    scenario: Scenario,
    options?: { readonly testTransport?: ModelTransportContract | undefined },
  ): ModelTransportContract
  TransportSelectionError: new (...args: never[]) => Error & { readonly code: string }
}

interface StudioServerModule {
  startStudioServer(options: {
    readonly repoRoot: string
    readonly targetOrigin: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly startRun: (start: unknown) => Promise<never>
    readonly testTransport?: ModelTransportContract
  }): Promise<{
    readonly session: { readonly authority: string; readonly origin: string; launchCookie(): { readonly value: string } }
    readonly address: { readonly port: number }
    close(): Promise<void>
  }>
}

const transportModule = (): Promise<TransportModule> =>
  loadPendingModule<TransportModule>('packages/flowproof/src/model/transport.ts', 'T035', [
    'selectTransport',
    'TransportSelectionError',
  ])

const HERO = 'canvas-filter-hero'
const SOURCE = 'apps/demo-chart/src/filterData.ts'
const FIXTURE_PATH = 'tests/fixtures/provider/hero-recorded-response.json'
// Plausible names an implementation might be tempted to honor; none may select a transport.
const TEMPTING_ENV = {
  FLOWPROOF_TEST_TRANSPORT: 'recorded',
  FLOWPROOF_TRANSPORT: 'recorded',
  FLOWPROOF_PROVIDER: 'fixture',
  FLOWPROOF_PROVIDER_MODE: 'fixture',
  FLOWPROOF_RECORDED_RESPONSE: FIXTURE_PATH,
  MODEL_TRANSPORT: 'recorded',
  MODEL_PROVIDER: 'fixture',
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function heroScenario(): Promise<Scenario> {
  return (await loadScenario(HERO, { repoRoot: REPO_ROOT })).scenario
}

/** Live Meta identity without any network call: the committed model and a credential requirement. */
function expectLiveMeta(transport: ModelTransportContract, recorded?: ModelTransportContract): void {
  if (recorded) expect(transport).not.toBe(recorded)
  expect(transport.model).toBe(META_MODEL_ID)
  expect(transport.checkReadiness({})).toMatchObject({ ready: false, code: 'PROVIDER_CREDENTIAL_MISSING' })
}

describe('recorded Hero provider fixture', () => {
  it('is a strict-schema diagnosis that cites only failure Evidence IDs a seven-item capture issues', () => {
    const parsed = parseDiagnosis(loadRecordedHeroResponse())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const issued = new Set(['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'].map((type) => `ev_failure_${type}_001`))
    const cited = [...parsed.value.claims.flatMap((claim) => claim.evidence_ids), ...parsed.value.candidate.evidence_ids]
    expect(cited.length).toBeGreaterThan(0)
    for (const id of cited) expect(issued.has(id), id).toBe(true)
    expect(parsed.value.candidate.target_paths).toEqual([SOURCE])
  })

  it('carries a one-file diff that applies to the committed source and fixes the defect', async () => {
    const diff = parseDiagnosis(loadRecordedHeroResponse())
    if (!diff.ok) throw new Error('The recorded fixture is not a valid diagnosis.')
    const { unified_diff: unifiedDiff } = diff.value.candidate
    expect(unifiedDiff.match(/^diff --git /gm)).toHaveLength(1)
    expect(unifiedDiff).toContain(`--- a/${SOURCE}\n+++ b/${SOURCE}\n`)

    // Apply it to the committed file in a scratch repository, then run the patched filter.
    const scratch = await createTempDirectory('flowproof-recorded-diff-')
    cleanups.push(scratch.remove)
    const appSource = path.join(scratch.path, 'apps/demo-chart/src')
    await mkdir(appSource, { recursive: true })
    git(scratch.path, 'init', '--quiet')
    for (const file of ['data.ts', 'filterData.ts']) await copyFile(path.join(REPO_ROOT, 'apps/demo-chart/src', file), path.join(appSource, file))
    const committed = git(REPO_ROOT, 'show', `HEAD:${SOURCE}`)
    expect(await readFile(path.join(scratch.path, SOURCE), 'utf8')).toBe(committed)
    const patchFile = path.join(scratch.path, 'candidate.diff')
    await writeFile(patchFile, unifiedDiff)
    git(scratch.path, 'apply', '--check', patchFile)
    git(scratch.path, 'apply', patchFile)

    const patched = (await import(pathToFileURL(path.join(scratch.path, SOURCE)).href)) as {
      filterByRegion(rows: readonly unknown[], region: string): unknown[]
    }
    const data = (await import(pathToFileURL(path.join(appSource, 'data.ts')).href)) as { salesRows: readonly unknown[] }
    const expected = JSON.parse(await readFile(path.join(REPO_ROOT, 'scenarios/canvas-filter/expected/filtered-data.json'), 'utf8')) as unknown
    expect(patched.filterByRegion(data.salesRows, 'North')).toEqual(expected)
  })
})

describe('recorded test transport', () => {
  it('replays a detached copy of the recording, records prompts, and needs no credential', async () => {
    const transport = createRecordedTransport()
    expect(transport.checkReadiness({})).toEqual({ ready: true })

    const first = await transport.diagnose({ goal: 'verify' }, { signal: new AbortController().signal, timeoutMs: 90_000 })
    ;(first as { summary: string }).summary = 'mutated by the engine'
    const second = await transport.diagnose({ goal: 'again' }, { signal: new AbortController().signal, timeoutMs: 90_000 })

    expect(second).toEqual(loadRecordedHeroResponse())
    expect(transport.calls.map((call) => call.prompt)).toEqual([{ goal: 'verify' }, { goal: 'again' }])
    expect(transport.calls[0]?.timeoutMs).toBe(90_000)
  })

  it('honors cancellation before answering', async () => {
    const transport = createRecordedTransport()
    const controller = new AbortController()
    controller.abort()

    await expect(transport.diagnose({}, { signal: controller.signal, timeoutMs: 1 })).rejects.toThrow(/ABORTED/)
    expect(transport.calls).toHaveLength(0)
  })
})

describe('test transport selection seam', () => {
  it('keeps the committed Hero scenario on the live Meta provider', async () => {
    const hero = await heroScenario()
    expect(hero.provider).toEqual({ mode: 'meta', fixture_path: null, injected_fault_label: null })
  })

  it('resolves ordinary Hero selection to the live Meta transport', async () => {
    const { selectTransport } = await transportModule()
    const hero = await heroScenario()

    expectLiveMeta(selectTransport(hero))
    expectLiveMeta(selectTransport(hero, {}))
    expectLiveMeta(selectTransport(hero, { testTransport: undefined }))
  })

  it('accepts an in-process transport object passed by the startStudio entry', async () => {
    const { selectTransport } = await transportModule()
    const recorded = createRecordedTransport()

    expect(selectTransport(await heroScenario(), { testTransport: recorded })).toBe(recorded)
  })

  it('ignores every environment variable when selecting the Hero transport', async () => {
    const { selectTransport } = await transportModule()
    const hero = await heroScenario()
    const saved = Object.fromEntries(Object.keys(TEMPTING_ENV).map((key) => [key, process.env[key]]))
    Object.assign(process.env, TEMPTING_ENV)
    try {
      expectLiveMeta(selectTransport(hero))
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it.each([
    ['a transport name', 'recorded'],
    ['a fixture path', FIXTURE_PATH],
    ['a plain object', { model: null, kind: 'recorded' }],
    ['a JSON-parsed transport', JSON.parse(JSON.stringify(createRecordedTransport())) as unknown],
  ])('rejects %s as a test transport', async (_label, override) => {
    const { selectTransport, TransportSelectionError } = await transportModule()
    const hero = await heroScenario()

    let caught: unknown
    try {
      selectTransport(hero, { testTransport: override as ModelTransportContract })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TransportSelectionError)
    expect((caught as { code: string }).code).toBe('TRANSPORT_OVERRIDE_INVALID')
  })

  it.each([
    ['a transport field', { provider: { mode: 'meta', fixture_path: null, injected_fault_label: null, transport: 'recorded' } }],
    ['a test-transport field', { test_transport: 'recorded' }],
    ['a fixture provider on Hero', { provider: { mode: 'fixture', fixture_path: FIXTURE_PATH, injected_fault_label: 'recorded' } }],
  ])('rejects a forged scenario with %s', async (_label, forgery) => {
    const { selectTransport, TransportSelectionError } = await transportModule()
    const forged = { ...(await heroScenario()), ...forgery } as unknown as Scenario

    expect(parseScenario(forged).ok).toBe(false)
    expect(() => selectTransport(forged)).toThrow(TransportSelectionError)
    expect(() => selectTransport(forged, { testTransport: createRecordedTransport() })).toThrow(TransportSelectionError)
  })
})

describe('test transport is unreachable from outside the process', () => {
  beforeAll(async () => {
    await buildFlowproofCli()
  }, 180_000)

  it.each([
    ['--test-transport', 'recorded'],
    ['--transport', 'recorded'],
    ['--provider', 'fixture'],
    ['--recorded-response', FIXTURE_PATH],
  ])('rejects the CLI flag %s without launching', async (flag, value) => {
    const clone = await createTempClone()
    cleanups.push(clone.remove)

    const result = await runFlowproof(['studio', '--scenario', HERO, flag, value], { cwd: clone.path })
    cleanups.push(result.tmp.remove)

    expect(result.code).not.toBe(0)
    expect(result.code).not.toBeNull()
    expect(result.stdout).not.toContain('"mode"')
    expect(await listTree(result.tmp.path)).toEqual([])
    expect(await listTree(path.join(clone.path, '.flowproof'))).toEqual([])
  })

  it('still requires MODEL_API_KEY for Hero when transport-selection variables are set', async () => {
    const clone = await createTempClone()
    cleanups.push(clone.remove)

    const result = await runFlowproof(['studio', '--scenario', HERO], { cwd: clone.path, env: TEMPTING_ENV })
    cleanups.push(result.tmp.remove)
    assertLauncherImplemented(result)

    // Had any variable selected the credential-free recorded transport, startup would proceed.
    expect(result.code).toBe(3)
    expect(result.stderr).toMatch(/\bPROVIDER_CREDENTIAL_MISSING\b/)
    expect(await listTree(result.tmp.path)).toEqual([])
  })

  it('refuses transport selection through POST /api/runs', async () => {
    const { startStudioServer } = await loadPendingModule<StudioServerModule>('packages/flowproof/src/studio/server.ts', 'T043', [
      'startStudioServer',
    ])
    const clone = await createTempClone()
    cleanups.push(clone.remove)
    const started: unknown[] = []
    const server = await startStudioServer({
      repoRoot: clone.path,
      targetOrigin: 'http://localhost:43119',
      env: {},
      startRun: async (start) => {
        started.push(start)
        throw new Error('No run may start in this test.')
      },
    })
    cleanups.push(() => server.close())

    const post = (body: unknown): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const outgoing = request(
          {
            host: '127.0.0.1',
            port: server.address.port,
            method: 'POST',
            path: '/api/runs',
            headers: {
              host: server.session.authority,
              origin: server.session.origin,
              cookie: `${LAUNCH_COOKIE_NAME}=${server.session.launchCookie().value}`,
              'content-type': 'application/json',
            },
          },
          (response) => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', (chunk: string) => (text += chunk))
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
          },
        )
        outgoing.on('error', reject)
        outgoing.end(JSON.stringify(body))
      })

    const goal = 'Find the incorrect Canvas filtering behavior and verify the fix.'
    for (const selector of [
      { transport: 'recorded' },
      { test_transport: 'recorded' },
      { testTransport: 'recorded' },
      { provider: 'fixture' },
      { provider: { mode: 'fixture', fixture_path: FIXTURE_PATH } },
      { recorded_response: FIXTURE_PATH },
    ]) {
      const reply = await post({ scenario_id: HERO, request_text: goal, ...selector })
      expect(reply.status, JSON.stringify(selector)).toBe(400)
    }
    // Without a selector the live Meta transport applies and its missing credential blocks the run.
    const plain = await post({ scenario_id: HERO, request_text: goal })
    expect(plain.status).toBeGreaterThanOrEqual(400)
    expect((JSON.parse(plain.body) as { error: { code: string } }).error.code).toBe('PROVIDER_CREDENTIAL_MISSING')
    expect(started).toHaveLength(0)
    expect(await listTree(path.join(clone.path, '.flowproof'))).toEqual([])
  })
})
