import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MAX_CHAT_TEXT_LENGTH, parseChatRequest, parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import type { ChatRequest, RunResult, StudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { SCENARIO_REGISTRY } from '../../packages/flowproof/src/scenario/registry.js'
import { LAUNCH_COOKIE_NAME } from '../../packages/flowproof/src/studio/auth.js'
import type { LaunchSession } from '../../packages/flowproof/src/studio/auth.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { RunEventStream } from '../../packages/flowproof/src/studio/events.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { createRecordedTransport } from '../support/recordedTransport.js'
import type { ModelTransportContract } from '../support/recordedTransport.js'
import { createTempClone, git } from '../support/repoFixture.js'

// T028: the loopback Studio API from contracts/studio-api.md, implemented by T043 in
// `packages/flowproof/src/studio/server.ts`. The run engine is replaced by an in-process fake
// launcher, so these tests exercise only the HTTP surface: request binding, rejection without
// side effects, live SSE, the authoritative result, and closed Proof Trail reads.

/** What the server hands the run engine for one accepted start request. */
export interface StudioRunStart {
  /** Sanitized, server-bound chat request; `run_id` and `request_id` are server-generated. */
  readonly request: ChatRequest
  readonly scenario: LoadedScenario
  readonly transport: ModelTransportContract
}

/** The engine's live view of one run, as the server needs it. */
export interface StudioRunHandle {
  readonly runId: string
  readonly events: RunEventStream
  readonly artifacts: RunArtifactStore
  /** The authoritative result once finalized; null while the run is active. */
  result(): RunResult | null
}

export interface StudioServerOptions {
  readonly repoRoot: string
  /** The only origin the Studio frames, for example `http://localhost:43119`. */
  readonly targetOrigin: string
  /** Credential readiness source; the launcher passes `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly startRun: (start: StudioRunStart) => Promise<StudioRunHandle>
  /** Forwarded only from the in-process `startStudio({ testTransport })` entry. */
  readonly testTransport?: ModelTransportContract
}

export interface StudioServerHandle {
  readonly session: LaunchSession
  readonly origin: string
  readonly address: AddressInfo
  close(): Promise<void>
}

export interface StudioServerModule {
  startStudioServer(options: StudioServerOptions): Promise<StudioServerHandle>
}

const MODULE_PATH = 'packages/flowproof/src/studio/server.ts'
const serverModule = (): Promise<StudioServerModule> =>
  loadPendingModule<StudioServerModule>(MODULE_PATH, 'T043', ['startStudioServer'])

const HERO = 'canvas-filter-hero'
const TARGET_ORIGIN = 'http://localhost:43119'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'
const SEEDED = 'sk-flowproofseededstudioapi001'
const RESULT_FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/contracts/run-result.valid-unverified.json', import.meta.url), 'utf8'),
) as RunResult

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface FakeRun {
  readonly start: StudioRunStart
  readonly handle: StudioRunHandle
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  finalize(result: RunResult): void
}

interface Studio {
  readonly server: StudioServerHandle
  readonly repo: string
  readonly runs: FakeRun[]
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function studio(options: { readonly testTransport?: ModelTransportContract; readonly env?: Record<string, string> } = {}): Promise<Studio> {
  const mod = await serverModule()
  const clone = await createTempClone()
  cleanups.push(clone.remove)
  const runs: FakeRun[] = []
  const startRun = async (start: StudioRunStart): Promise<StudioRunHandle> => {
    const store = await createRunArtifactStore({ repoRoot: clone.path, runId: start.request.run_id })
    const events = createRunEventStream({ runId: start.request.run_id, registry: store })
    let finalResult: RunResult | null = null
    const handle: StudioRunHandle = {
      runId: start.request.run_id,
      events,
      artifacts: store,
      result: () => finalResult,
    }
    runs.push({
      start,
      handle,
      store,
      events,
      finalize(result: RunResult) {
        finalResult = result
      },
    })
    return handle
  }
  const server = await mod.startStudioServer({
    repoRoot: clone.path,
    targetOrigin: TARGET_ORIGIN,
    env: options.env ?? {},
    startRun,
    ...(options.testTransport ? { testTransport: options.testTransport } : {}),
  })
  cleanups.push(() => server.close())
  return { server, repo: clone.path, runs }
}

function send(
  s: Studio,
  options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: s.server.address.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { host: s.server.session.authority, ...options.headers },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(options.body)
  })
}

const cookie = (s: Studio): string => `${LAUNCH_COOKIE_NAME}=${s.server.session.launchCookie().value}`

const get = (s: Studio, target: string, headers: Record<string, string> = {}): Promise<Reply> =>
  send(s, { path: target, headers: { cookie: cookie(s), 'sec-fetch-site': 'same-origin', ...headers } })

const post = (s: Studio, target: string, body: unknown): Promise<Reply> =>
  send(s, {
    method: 'POST',
    path: target,
    headers: { cookie: cookie(s), origin: s.server.session.origin, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const startBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  scenario_id: HERO,
  request_text: GOAL,
  ...overrides,
})

function expectEnvelope(reply: Reply, status: number | 'client', code?: string): { code: string; message: string } {
  if (status === 'client') {
    expect(reply.status).toBeGreaterThanOrEqual(400)
    expect(reply.status).toBeLessThan(500)
  } else {
    expect(reply.status).toBe(status)
  }
  expect(reply.headers['content-type']).toMatch(/^application\/json/)
  expect(reply.headers['cache-control']).toBe('no-store')
  const parsed = JSON.parse(reply.body) as { error: { code: string; message: string } }
  expect(Object.keys(parsed)).toEqual(['error'])
  expect(Object.keys(parsed.error).sort()).toEqual(['code', 'message'])
  expect(parsed.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/)
  if (code) expect(parsed.error.code).toBe(code)
  return parsed.error
}

/** Proves a rejected start left no run, artifact directory, or worktree behind. */
function expectNoRunSideEffect(s: Studio, worktreesBefore: string): void {
  expect(s.runs).toHaveLength(0)
  expect(existsSync(path.join(s.repo, '.flowproof'))).toBe(false)
  expect(git(s.repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
}

async function startHero(s: Studio): Promise<{ reply: Reply; run: FakeRun; body: Record<string, unknown> }> {
  const reply = await post(s, '/api/runs', startBody())
  expect(reply.status).toBe(202)
  const run = s.runs.at(-1)
  if (!run) throw new Error('The server accepted the run without starting it.')
  return { reply, run, body: JSON.parse(reply.body) as Record<string, unknown> }
}

describe('Studio API: transport and prepared cases', () => {
  it('binds to loopback and keeps the request guards in front of every route', async () => {
    const s = await studio()
    expect(s.server.address.address).toBe('127.0.0.1')
    expect(s.server.origin).toBe(`http://127.0.0.1:${s.server.address.port}`)
    expect(s.server.session.targetOrigin).toBe(TARGET_ORIGIN)

    expectEnvelope(await send(s, { path: '/api/scenarios', headers: { 'sec-fetch-site': 'same-origin' } }), 401, 'LAUNCH_SESSION_REQUIRED')
    expectEnvelope(await get(s, '/api/scenarios', { host: 'localhost:1' }), 403, 'HOST_REJECTED')
  })

  it('lists only safe presentation metadata for committed cases', async () => {
    const s = await studio()
    const reply = await get(s, '/api/scenarios')

    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    const parsed = JSON.parse(reply.body) as { scenarios: Array<Record<string, unknown>> }
    expect(Object.keys(parsed)).toEqual(['scenarios'])
    expect(parsed.scenarios.map((entry) => entry.scenario_id)).toEqual(SCENARIO_REGISTRY.map((entry) => entry.scenario_id))
    for (const entry of parsed.scenarios) {
      expect(Object.keys(entry).sort()).toEqual(['case', 'default_request', 'scenario_id', 'title'])
    }
    expect(parsed.scenarios).toContainEqual({
      scenario_id: HERO,
      case: 'hero',
      title: SCENARIO_REGISTRY.find((entry) => entry.scenario_id === HERO)?.title,
      default_request: GOAL,
    })
    // No paths, commands, oracle or fixture locations, or source allowlist.
    for (const leak of ['scenarios/', 'apps/', 'pnpm', 'filterData', 'expected', '.json', s.repo]) {
      expect(reply.body).not.toContain(leak)
    }
  })
})

describe('Studio API: starting a run', () => {
  it('binds a sanitized bounded chat request to the committed scenario and returns 202', async () => {
    const recorded = createRecordedTransport()
    const s = await studio({ testTransport: recorded })
    const reply = await post(s, '/api/runs', startBody({ request_text: `  <b>Please</b> verify the fix. api_key=${SEEDED}  ` }))

    expect(reply.status).toBe(202)
    expect(reply.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(reply.body) as Record<string, string>
    expect(Object.keys(body).sort()).toEqual(['events_url', 'request_id', 'run_id'])
    expect(body.events_url).toBe(`/api/runs/${body.run_id}/events`)
    expect(reply.body).not.toContain(SEEDED)

    expect(s.runs).toHaveLength(1)
    const [run] = s.runs as [FakeRun]
    const { request: chat } = run.start
    expect(parseChatRequest(chat).ok).toBe(true)
    expect(chat).toMatchObject({
      request_id: body.request_id,
      run_id: body.run_id,
      session_id: s.server.session.sessionId,
      scenario_id: HERO,
    })
    expect(chat.text).not.toContain(SEEDED)
    expect(chat.text).not.toMatch(/[<>]/)
    expect(chat.text).toContain('Please verify the fix.')
    // The committed scenario, not the browser, defines every execution boundary.
    expect(run.start.scenario.scenario.scenario_id).toBe(HERO)
    expect(run.start.scenario.scenario.provider.mode).toBe('meta')
    // The in-process test transport reached the engine; no key was needed.
    expect(run.start.transport).toBe(recorded)
  })

  it.each([
    ['provider', { mode: 'fixture' }],
    ['transport', 'recorded'],
    ['test_transport', 'recorded'],
    ['model', 'other-model'],
    ['model_options', { temperature: 0 }],
    ['path', 'apps/demo-chart/src/main.ts'],
    ['scenario_path', 'scenarios/canvas-filter/hero.json'],
    ['command', ['sh', '-c', 'true']],
    ['start_command', ['sh', '-c', 'true']],
    ['oracle', { dataset_path: 'README.md' }],
    ['expected', []],
    ['gates', ['dataset_matches']],
    ['permitted_source_paths', ['apps/demo-chart/src/main.ts']],
    ['patch', 'diff --git a/x b/x'],
  ])('rejects the %s body field without starting a run or echoing it', async (field, value) => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')
    const seeded = typeof value === 'string' ? `${value}-${SEEDED}` : { value, marker: SEEDED }

    const error = expectEnvelope(await post(s, '/api/runs', startBody({ [field]: seeded })), 400)

    expect(JSON.stringify(error)).not.toContain(SEEDED)
    expectNoRunSideEffect(s, worktrees)
  })

  it.each([
    ['an empty goal', startBody({ request_text: '   ' })],
    ['an over-long goal', startBody({ request_text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1) })],
    ['a non-string goal', startBody({ request_text: { text: GOAL } })],
    ['a missing goal', { scenario_id: HERO }],
    ['a missing scenario', { request_text: GOAL }],
    ['a path-like scenario', startBody({ scenario_id: '../scenarios/canvas-filter/hero.json' })],
    ['an unregistered scenario', startBody({ scenario_id: 'canvas-filter-unknown' })],
  ])('rejects %s without starting a run', async (_label, body) => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')

    expectEnvelope(await post(s, '/api/runs', body), 'client')

    expectNoRunSideEffect(s, worktrees)
  })

  it('rejects malformed, non-JSON, and cross-origin start requests without side effects', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')

    expectEnvelope(await post(s, '/api/runs', '{"scenario_id":'), 400)
    expectEnvelope(
      await send(s, {
        method: 'POST',
        path: '/api/runs',
        headers: { cookie: cookie(s), origin: s.server.session.origin, 'content-type': 'text/plain' },
        body: JSON.stringify(startBody()),
      }),
      'client',
    )
    expectEnvelope(
      await send(s, {
        method: 'POST',
        path: '/api/runs',
        headers: { cookie: cookie(s), origin: TARGET_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(startBody()),
      }),
      403,
      'ORIGIN_REJECTED',
    )
    expectNoRunSideEffect(s, worktrees)
  })

  it('defers the Hero credential check to the start request and creates nothing without a key', async () => {
    const s = await studio({ env: {} })
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')

    const error = expectEnvelope(await post(s, '/api/runs', startBody()), 'client', 'PROVIDER_CREDENTIAL_MISSING')

    expect(error.message).not.toContain('MODEL_API_KEY=')
    expectNoRunSideEffect(s, worktrees)
    // The Studio stays usable: the prepared cases are still listed.
    expect((await get(s, '/api/scenarios')).status).toBe(200)
  })

  it('accepts one active run per session', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { body } = await startHero(s)

    expectEnvelope(await post(s, '/api/runs', startBody()), 'client', 'ACTIVE_RUN_EXISTS')

    expect(s.runs).toHaveLength(1)
    expect(s.runs[0]?.handle.runId).toBe(body.run_id)
  })
})

describe('Studio API: live events and the authoritative result', () => {
  interface SseClient {
    readonly response: IncomingMessage
    readonly request: ClientRequest
    readonly records: () => string
    waitFor(predicate: (text: string) => boolean): Promise<void>
  }

  function openEvents(s: Studio, runId: string, headers: Record<string, string> = {}): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port: s.server.address.port,
          path: `/api/runs/${runId}/events`,
          headers: { host: s.server.session.authority, cookie: cookie(s), 'sec-fetch-site': 'same-origin', ...headers },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => (text += chunk))
          resolve({
            response,
            request: outgoing,
            records: () => text,
            async waitFor(predicate) {
              const deadline = Date.now() + 5_000
              while (!predicate(text)) {
                if (Date.now() > deadline) throw new Error('The expected SSE records did not arrive.')
                await new Promise((tick) => setTimeout(tick, 20))
              }
            },
          })
        },
      )
      outgoing.on('error', reject)
      outgoing.end()
    })
  }

  const dataRecords = (text: string): StudioEvent[] =>
    text
      .split('\n\n')
      .map((record) => record.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice('data: '.length)) as StudioEvent)

  it('streams live ordered events without replaying events emitted before the connection', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { run, body } = await startHero(s)
    run.events.emit({ type: 'agent_message', phase: 'initialized', message: 'Missed before connecting.' })
    const emittedBefore = run.events.events().length

    const client = await openEvents(s, String(body.run_id), { 'last-event-id': `${String(body.run_id)}:0` })
    expect(client.response.statusCode).toBe(200)
    expect(client.response.headers['content-type']).toMatch(/^text\/event-stream/)
    expect(client.response.headers['cache-control']).toBe('no-store')

    const live = [
      run.events.emit({ type: 'phase_started', phase: 'reproducing', message: `Reproducing token=${SEEDED}` }),
      run.events.emit({ type: 'agent_message', phase: 'reproducing', message: 'Driving the target frame.' }),
    ]
    await client.waitFor((text) => dataRecords(text).length >= live.length)

    const delivered = dataRecords(client.records())
    expect(delivered).toEqual(live)
    expect(delivered.every((event) => event.sequence > emittedBefore)).toBe(true)
    for (const event of delivered) expect(parseStudioEvent(event).ok).toBe(true)
    expect(client.records()).toContain(`id: ${live[0]?.event_id}\nevent: phase_started\n`)
    expect(client.records()).not.toContain('Missed before connecting.')
    expect(client.records()).not.toContain(SEEDED)
    client.request.destroy()
  })

  it('keeps the run and its result independent of an SSE disconnect', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { run, body } = await startHero(s)
    const client = await openEvents(s, String(body.run_id))
    client.request.destroy()
    await new Promise((settle) => setTimeout(settle, 50))

    // The run continues after the client left.
    expect(() => run.events.emit({ type: 'phase_started', phase: 'reproducing', message: 'Still running.' })).not.toThrow()

    const running = await get(s, `/api/runs/${String(body.run_id)}/result`)
    expect(running.status).toBe(202)
    expect(running.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(running.body)).toEqual({ state: 'running' })

    const final: RunResult = {
      ...RESULT_FIXTURE,
      run_id: String(body.run_id),
      request_id: String(body.request_id),
    }
    run.finalize(final)
    const finished = await get(s, `/api/runs/${String(body.run_id)}/result`)
    expect(finished.status).toBe(200)
    expect(finished.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(finished.body)).toEqual(final)
  })

  it('ends the stream after the final event', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { run, body } = await startHero(s)
    const client = await openEvents(s, String(body.run_id))
    const ended = new Promise<void>((resolve) => client.response.once('end', () => resolve()))

    const final = run.events.emit({ type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Unverified.' })

    await ended
    expect(dataRecords(client.records())).toEqual([final])
  })

  it('returns envelope errors for unknown runs', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const unknown = randomUUID()

    expectEnvelope(await get(s, `/api/runs/${unknown}/result`), 404)
    expectEnvelope(await get(s, `/api/runs/${unknown}/events`), 404)
    expectEnvelope(await get(s, '/api/runs/not-a-run-id/result'), 'client')
  })
})

describe('Studio API: closed Proof Trail reads', () => {
  async function runWithEvidence(s: Studio): Promise<{ runId: string; run: FakeRun }> {
    const { run, body } = await startHero(s)
    const dataset = await run.store.writeJson('evidence/failure/dataset.json', { observed: [], note: `token=${SEEDED}` })
    run.store.register('ev_failure_dataset_001', dataset)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
    run.store.register('ev_failure_screenshot_001', await run.store.writePng('evidence/failure/screenshot.png', png))
    return { runId: String(body.run_id), run }
  }

  it('serves a registered evidence artifact by run and Evidence ID only', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { runId, run } = await runWithEvidence(s)

    const json = await get(s, `/api/runs/${runId}/evidence/ev_failure_dataset_001`)
    expect(json.status).toBe(200)
    expect(json.headers['cache-control']).toBe('no-store')
    expect(json.headers['content-type']).toMatch(/^application\/json/)
    expect(json.body).toBe((await run.store.read('ev_failure_dataset_001')).toString('utf8'))
    expect(json.body).not.toContain(SEEDED)

    const png = await get(s, `/api/runs/${runId}/evidence/ev_failure_screenshot_001`)
    expect(png.status).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')
  })

  it.each([
    'ev_failure_dataset_002',
    'ev_replay_dataset_001',
    'ev_failure_dataset_1',
    'dataset.json',
    'evidence%2Ffailure%2Fdataset.json',
    '..%2F..%2FREADME.md',
  ])('rejects the unknown or malformed evidence identifier %s', async (identifier) => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { runId } = await runWithEvidence(s)

    const error = expectEnvelope(await get(s, `/api/runs/${runId}/evidence/${identifier}`), 'client')

    expect(error.message).not.toContain(s.repo)
  })

  it('does not serve evidence through another run identifier', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    await runWithEvidence(s)

    expectEnvelope(await get(s, `/api/runs/${randomUUID()}/evidence/ev_failure_dataset_001`), 404)
  })

  it('serves the validated candidate diff only once one exists', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { runId, run } = await runWithEvidence(s)
    expectEnvelope(await get(s, `/api/runs/${runId}/artifacts/candidate-diff`), 404)

    const diff = 'diff --git a/apps/demo-chart/src/filterData.ts b/apps/demo-chart/src/filterData.ts\n'
    run.store.register('candidate-diff', await run.store.writeText('candidate/candidate.diff', diff))

    const reply = await get(s, `/api/runs/${runId}/artifacts/candidate-diff`)
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['content-type']).not.toMatch(/html/)
    expect(reply.body).toBe(diff)
  })

  it('has no generic file, directory, report, or bulk-download route', async () => {
    const s = await studio({ testTransport: createRecordedTransport() })
    const { runId, run } = await runWithEvidence(s)
    run.store.register('result', await run.store.writeJson('result.json', { placeholder: true }))

    for (const target of [
      `/api/runs/${runId}/artifacts/result`,
      `/api/runs/${runId}/artifacts/diagnosis`,
      `/api/runs/${runId}/artifacts/failure-manifest`,
      `/api/runs/${runId}/files/result.json`,
      `/api/runs/${runId}/evidence`,
      `/api/runs/${runId}/report`,
      `/api/runs/${runId}/download`,
      '/api/files?path=README.md',
      '/api/artifacts?path=.flowproof/runs',
      '/api/runs',
      '/README.md',
      '/package.json',
      `/.flowproof/runs/${runId}/result.json`,
    ]) {
      const reply = await get(s, target)
      expect(reply.status, target).toBeGreaterThanOrEqual(400)
      expect(reply.body, target).not.toContain('"placeholder"')
      expect(reply.body, target).not.toContain('# FlowProof')
    }
    expectEnvelope(await get(s, '/api/unknown-route'), 404)
    expectEnvelope(await send(s, { method: 'PUT', path: '/api/runs', headers: { cookie: cookie(s), origin: s.server.session.origin } }), 405)
  })
})
