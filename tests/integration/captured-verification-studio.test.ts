import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { STUDIO_EVENT_TYPES, parseChatRequest, parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import type { RunResult, StudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { capturedResult, createCandidate, repositoryCoverage } from '../../packages/flowproof/src/editing/capture.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import { SCENARIO_REGISTRY } from '../../packages/flowproof/src/scenario/registry.js'
import { LAUNCH_COOKIE_NAME } from '../../packages/flowproof/src/studio/auth.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { RunEventStream } from '../../packages/flowproof/src/studio/events.js'
import { startStudioServer } from '../../packages/flowproof/src/studio/server.js'
import type { CapturedStudioRunStart, StudioRunHandle, StudioRunResult, StudioRunStart, StudioServerHandle, StudioServerOptions } from '../../packages/flowproof/src/studio/server.js'
import { parseCapturedVerificationResult } from '../../packages/flowproof/src/verify/capturedContracts.js'
import type { CapturedVerificationResult } from '../../packages/flowproof/src/verify/capturedContracts.js'
import { admitCapturedCandidate, executeCapturedRun } from '../../packages/flowproof/src/verify/capturedRun.js'
import type { AdmittedCandidate, CapturedRunPorts } from '../../packages/flowproof/src/verify/capturedRun.js'
import { persistPhase, sessionResult } from '../support/capturedCandidate.js'
import { createRecordedTransport } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempClone, git } from '../support/repoFixture.js'

// T019 (server part) for T021: the host-fixed captured verification mode of the guarded Studio
// server in `packages/flowproof/src/studio/server.ts`. Only the in-process captured launcher
// (T022) selects this mode; here a deterministic host starter stands in for it, either a manual
// fake run or the real `executeCapturedRun` engine with fake stage ports. The tests exercise the
// HTTP surface: unchanged guards, the prepared catalog with its execution-kind discriminator, body
// rejection before side effects, no model readiness or transport, server-generated identities,
// one run per launch, live event discipline, the strict captured result bound to its run, closed
// evidence reads and the always-absent candidate diff. Launch admission and the real headed frame
// belong to T022 and its harness.

const HERO = 'canvas-filter-hero'
const FAILURE = 'canvas-filter-failure-invalid-citation'
const TARGET_ORIGIN = 'http://localhost:43119'
const GOAL = 'Find the incorrect Canvas filtering behavior and verify the fix.'
const CAPTURED_KIND = 'captured-verification'
const SEEDED = 'sk-flowproofseededcapturedstudio01'
const MARKER = 'FPCAPTUREDSTUDIOMARKER0000001'
const UNIQUE_PATH = 'src/zz-captured-studio-only-path.txt'
const PATCH_TEXT = `diff --git a/${UNIQUE_PATH} b/${UNIQUE_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${UNIQUE_PATH}\n@@ -0,0 +1 @@\n+synthetic captured studio line\n`
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), 'utf8')) as T
const PASSED = fixture<CapturedVerificationResult>('captured-verification-result.valid-passed.json')
const FAILED = fixture<CapturedVerificationResult>('captured-verification-result.valid-failed.json')
const LEGACY = fixture<RunResult>('run-result.valid-unverified.json')
/** Phases the captured flow may use; never `diagnosing`. */
const CAPTURED_PHASES = ['initialized', 'reproducing', 'failure_captured', 'applying', 'replaying', 'finalized']
const MODEL_EVENT_TYPES = ['chat_received', 'diagnosis_ready', 'candidate_ready', 'gate_updated']

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface CapturedRun {
  readonly start: CapturedStudioRunStart
  readonly handle: StudioRunHandle
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  finalize(result: StudioRunResult): void
  /** Settles when the deterministic engine run finalized (immediately for a manual run). */
  readonly done: Promise<void>
}

interface Server {
  readonly server: StudioServerHandle
  readonly repo: string
}

interface CapturedStudio extends Server {
  readonly runs: CapturedRun[]
  readonly starts: unknown[]
  readonly candidate: AdmittedCandidate
  /** Lets a gated engine run proceed, for example after an SSE client connected. */
  release(): void
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

function admittedCandidate(): AdmittedCandidate {
  const candidate = createCandidate({
    sessionId: randomUUID(),
    baselineCommit: 'a'.repeat(40),
    patch: Buffer.from(PATCH_TEXT),
    files: [
      {
        path: Buffer.from(UNIQUE_PATH),
        operation: 'added',
        oldMode: null,
        newMode: '100644',
        oldObjectId: null,
        newObjectId: 'b'.repeat(40),
        oldSize: null,
        newSize: 31,
      },
    ],
    coverage: repositoryCoverage(false),
  })
  const admission = admitCapturedCandidate({ session: sessionResult(candidate.sessionId), capture: capturedResult(candidate) }, { objectFormat: 'sha1' })
  if (!admission.admitted) throw new Error(`The synthetic candidate was not admitted: ${admission.error.code}`)
  return admission.candidate
}

/**
 * Deterministic stage doubles: the baseline shows the prepared defect, the candidate matches the
 * oracle. Each measured double attests frame readiness, as the real launcher port does after its
 * reconnect, before it captures.
 */
function passingPorts(start: CapturedStudioRunStart): CapturedRunPorts {
  const { scenario } = start
  const expected = scenario.oracle
  const knownBad = {
    dataset: [...expected.dataset, ...expected.dataset.map((row) => ({ ...row, region: 'Northeast' }))],
    chart: { bar_count: 8, labels: [...expected.chart.labels, ...expected.chart.labels], values: [...expected.chart.values, ...expected.chart.values] },
  }
  return {
    reproduceBaseline: (context) => {
      context.frameReady()
      return persistPhase(context, scenario.scenario.scenario_id, 'failure', knownBad)
    },
    applyCandidate: async () => ({ applied: true }),
    build: async () => ({ built: true }),
    functionalCheck: async () => ({ exitCode: 0, summary: { discovered: 6, executed: 6, passed: 6, failed: 0 }, expectedCases: 6 }),
    replay: (context) => {
      context.frameReady()
      return persistPhase(context, scenario.scenario.scenario_id, 'replay', { dataset: structuredClone(expected.dataset), chart: structuredClone(expected.chart) })
    },
    disposeCapture: async () => ({ remaining: [] }),
    disposeWorktree: async () => ({ remaining: [], original: { verified: true, unchanged: true, mismatches: [] } }),
  }
}

/** Starts the guarded server in host-fixed captured mode with a deterministic host starter. */
async function capturedStudio(options: { readonly engine?: boolean; readonly gated?: boolean } = {}): Promise<CapturedStudio> {
  const clone = await createTempClone()
  cleanups.push(clone.remove)
  const candidate = admittedCandidate()
  const runs: CapturedRun[] = []
  const starts: unknown[] = []
  let release: () => void = () => undefined
  const gate = options.gated ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
  const startRun = async (start: CapturedStudioRunStart): Promise<StudioRunHandle> => {
    starts.push(start)
    const store = await createRunArtifactStore({ repoRoot: clone.path, runId: start.request.run_id })
    const events = createRunEventStream({ runId: start.request.run_id, registry: store })
    let finalResult: StudioRunResult | null = null
    const handle: StudioRunHandle = { runId: start.request.run_id, events, artifacts: store, result: () => finalResult }
    const done = options.engine
      ? gate
          .then(() =>
            executeCapturedRun({
              runId: start.request.run_id,
              requestId: start.request.request_id,
              scenario: start.scenario,
              candidate,
              store,
              events,
              allocator: createEvidenceIdAllocator(start.request.run_id),
              ports: passingPorts(start),
              secretMarkers: [MARKER],
            }),
          )
          .then((result) => {
            finalResult = result
          })
      : Promise.resolve()
    runs.push({
      start,
      handle,
      store,
      events,
      done,
      finalize(result) {
        finalResult = result
      },
    })
    return handle
  }
  const server = await startStudioServer({ repoRoot: clone.path, targetOrigin: TARGET_ORIGIN, captured: { scenarioId: HERO, startRun } })
  cleanups.push(() => server.close())
  return { server, repo: clone.path, runs, starts, candidate, release: () => release() }
}

/** The unchanged legacy mode, with a fake engine whose result the test controls. */
async function legacyStudio(env: Record<string, string> = {}, transport = true): Promise<Server & { readonly finalize: (result: StudioRunResult) => void; readonly runs: StudioRunStart[] }> {
  const clone = await createTempClone()
  cleanups.push(clone.remove)
  const runs: StudioRunStart[] = []
  let finalResult: StudioRunResult | null = null
  const server = await startStudioServer({
    repoRoot: clone.path,
    targetOrigin: TARGET_ORIGIN,
    env,
    startRun: async (start) => {
      runs.push(start)
      const store = await createRunArtifactStore({ repoRoot: clone.path, runId: start.request.run_id })
      return { runId: start.request.run_id, events: createRunEventStream({ runId: start.request.run_id, registry: store }), artifacts: store, result: () => finalResult }
    },
    ...(transport ? { testTransport: createRecordedTransport() } : {}),
  })
  cleanups.push(() => server.close())
  return { server, repo: clone.path, runs, finalize: (result) => (finalResult = result) }
}

function send(s: Server, options: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: string }): Promise<Reply> {
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

const cookie = (s: Server): string => `${LAUNCH_COOKIE_NAME}=${s.server.session.launchCookie().value}`

const get = (s: Server, target: string, headers: Record<string, string> = {}): Promise<Reply> =>
  send(s, { path: target, headers: { cookie: cookie(s), 'sec-fetch-site': 'same-origin', ...headers } })

const post = (s: Server, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  send(s, {
    method: 'POST',
    path: '/api/runs',
    headers: { cookie: cookie(s), origin: s.server.session.origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const startBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ scenario_id: HERO, request_text: GOAL, ...overrides })

function expectEnvelope(reply: Reply, status: number, code?: string): { code: string; message: string } {
  expect(reply.status, reply.body).toBe(status)
  expect(reply.headers['content-type']).toMatch(/^application\/json/)
  expect(reply.headers['cache-control']).toBe('no-store')
  const parsed = JSON.parse(reply.body) as { error: { code: string; message: string } }
  expect(Object.keys(parsed)).toEqual(['error'])
  expect(Object.keys(parsed.error).sort()).toEqual(['code', 'message'])
  if (code) expect(parsed.error.code).toBe(code)
  return parsed.error
}

/** Proves a rejected start left no run, artifact directory, or worktree behind. */
function expectNoRunSideEffect(s: Server & { readonly starts?: unknown[]; readonly runs: unknown[] }, worktreesBefore: string): void {
  expect(s.runs).toHaveLength(0)
  if (s.starts) expect(s.starts).toHaveLength(0)
  expect(existsSync(path.join(s.repo, '.flowproof'))).toBe(false)
  expect(git(s.repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
}

async function startCaptured(s: CapturedStudio): Promise<{ readonly run: CapturedRun; readonly body: { readonly run_id: string; readonly request_id: string; readonly events_url: string } }> {
  const reply = await post(s, startBody())
  expect(reply.status, reply.body).toBe(202)
  const run = s.runs.at(-1)
  if (!run) throw new Error('The server accepted the run without starting it.')
  return { run, body: JSON.parse(reply.body) as { run_id: string; request_id: string; events_url: string } }
}

const bound = (result: CapturedVerificationResult, body: { readonly run_id: string; readonly request_id: string }): CapturedVerificationResult => ({
  ...structuredClone(result),
  run_id: body.run_id,
  request_id: body.request_id,
})

/** Opens the live SSE stream and collects records until the server ends it. */
function openEvents(s: Server, runId: string): Promise<{ readonly status: number; readonly ended: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: s.server.address.port,
        path: `/api/runs/${runId}/events`,
        headers: { host: s.server.session.authority, cookie: cookie(s), 'sec-fetch-site': 'same-origin' },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        const ended = new Promise<string>((settle, fail) => {
          const timer = setTimeout(() => fail(new Error('The captured event stream did not end.')), 15_000)
          response.on('data', (chunk: string) => (text += chunk))
          response.on('end', () => {
            clearTimeout(timer)
            settle(text)
          })
        })
        resolve({ status: response.statusCode ?? 0, ended })
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

describe('Captured Studio server: host-fixed mode configuration', () => {
  it('keeps the existing loopback, session, host, origin and CSP guards in front of every captured route', async () => {
    const s = await capturedStudio()
    const legacy = await legacyStudio()
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')
    expect(s.server.address.address).toBe('127.0.0.1')
    expect(s.server.origin).toBe(`http://127.0.0.1:${s.server.address.port}`)
    expect(s.server.session.targetOrigin).toBe(TARGET_ORIGIN)

    expectEnvelope(await send(s, { path: '/api/scenarios', headers: { 'sec-fetch-site': 'same-origin' } }), 401, 'LAUNCH_SESSION_REQUIRED')
    expectEnvelope(await get(s, '/api/scenarios', { host: 'localhost:1' }), 403, 'HOST_REJECTED')
    expectEnvelope(await send(s, { method: 'POST', path: '/api/runs', headers: { origin: s.server.session.origin, 'content-type': 'application/json' }, body: JSON.stringify(startBody()) }), 401, 'LAUNCH_SESSION_REQUIRED')
    expectEnvelope(await post(s, startBody(), { origin: TARGET_ORIGIN }), 403, 'ORIGIN_REJECTED')
    expectEnvelope(await post(s, startBody(), { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    expectEnvelope(await post(s, '{"scenario_id":'), 400, 'REQUEST_JSON_INVALID')
    expectEnvelope(await post(s, `{"scenario_id":"${HERO}","request_text":"${'x'.repeat(17 * 1024)}"}`), 413, 'REQUEST_TOO_LARGE')
    expectNoRunSideEffect(s, worktrees)

    // The same security headers as the legacy mode for the same framed target.
    const securityHeaders = (reply: Reply): Record<string, unknown> =>
      Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !['date', 'content-length', 'connection', 'keep-alive', 'transfer-encoding'].includes(name)))
    const capturedHeaders = securityHeaders(await get(s, '/api/scenarios'))
    expect(capturedHeaders['content-security-policy']).toBeTruthy()
    expect(capturedHeaders).toEqual(securityHeaders(await get(legacy, '/api/scenarios')))
  })

  it('lists only the prepared scenario with the captured execution-kind discriminator', async () => {
    const s = await capturedStudio()
    const reply = await get(s, '/api/scenarios')

    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(reply.body)).toEqual({
      scenarios: [
        {
          scenario_id: HERO,
          case: 'hero',
          title: SCENARIO_REGISTRY.find((entry) => entry.scenario_id === HERO)?.title,
          default_request: GOAL,
          execution_kind: CAPTURED_KIND,
        },
      ],
    })
    for (const leak of ['scenarios/', 'apps/', 'pnpm', 'filterData', 'check-filter', '.json', s.repo, UNIQUE_PATH, s.candidate.editingSessionId]) {
      expect(reply.body).not.toContain(leak)
    }
  })

  it('keeps the legacy catalog without a discriminator', async () => {
    const s = await legacyStudio()
    const parsed = JSON.parse((await get(s, '/api/scenarios')).body) as { scenarios: Array<Record<string, unknown>> }

    expect(parsed.scenarios.map((entry) => entry.scenario_id)).toEqual(SCENARIO_REGISTRY.map((entry) => entry.scenario_id))
    for (const entry of parsed.scenarios) expect(Object.keys(entry).sort()).toEqual(['case', 'default_request', 'scenario_id', 'title'])
  })

  const starter = async (): Promise<StudioRunHandle> => {
    throw new Error('A refused configuration never starts a run.')
  }
  it.each([
    ['a registered case that is not prepared for captured verification', { captured: { scenarioId: FAILURE, startRun: starter } }],
    ['an unregistered case', { captured: { scenarioId: 'canvas-filter-unknown', startRun: starter } }],
    ['a missing host starter', { captured: { scenarioId: HERO } }],
    ['an extra captured field', { captured: { scenarioId: HERO, startRun: starter, provider: 'meta' } }],
    ['a test transport', { captured: { scenarioId: HERO, startRun: starter }, testTransport: createRecordedTransport() }],
    ['a legacy run starter', { captured: { scenarioId: HERO, startRun: starter }, startRun: starter }],
    ['a credential environment', { captured: { scenarioId: HERO, startRun: starter }, env: { MODEL_API_KEY: SEEDED } }],
    ['a legacy launch case', { captured: { scenarioId: HERO, startRun: starter }, scenarioId: HERO }],
    ['a non-object mode', { captured: HERO }],
  ])('refuses a captured configuration with %s before binding', async (_label, extra) => {
    const options = { repoRoot: REPO_ROOT, targetOrigin: TARGET_ORIGIN, ...extra } as unknown as StudioServerOptions
    await expect(startStudioServer(options)).rejects.toMatchObject({ code: 'STUDIO_LAUNCH_CONFIG_INVALID' })
  })

  it('keeps the validated host mode when the caller changes its object afterwards', async () => {
    const clone = await createTempClone()
    cleanups.push(clone.remove)
    const calls: string[] = []
    const mode = {
      scenarioId: HERO,
      startRun: async (start: CapturedStudioRunStart): Promise<StudioRunHandle> => {
        calls.push(`host:${start.scenario.scenario.scenario_id}`)
        const store = await createRunArtifactStore({ repoRoot: clone.path, runId: start.request.run_id })
        return { runId: start.request.run_id, events: createRunEventStream({ runId: start.request.run_id, registry: store }), artifacts: store, result: () => null }
      },
    }
    const server = await startStudioServer({ repoRoot: clone.path, targetOrigin: TARGET_ORIGIN, captured: mode })
    cleanups.push(() => server.close())
    const s: Server = { server, repo: clone.path }
    Object.assign(mode, {
      scenarioId: FAILURE,
      startRun: async () => {
        calls.push('swapped')
        throw new Error('A swapped starter is never used.')
      },
    })

    expect(JSON.parse((await get(s, '/api/scenarios')).body)).toMatchObject({ scenarios: [{ scenario_id: HERO, execution_kind: CAPTURED_KIND }] })
    expectEnvelope(await post(s, startBody({ scenario_id: FAILURE })), 400, 'SCENARIO_NOT_AVAILABLE')
    expect((await post(s, startBody())).status).toBe(202)
    expect(calls).toEqual([`host:${HERO}`])
  })
})

describe('Captured Studio server: starting the host-fixed run', () => {
  it('starts the host-fixed run with server-generated IDs and no model key, transport or readiness', async () => {
    const savedKey = process.env.MODEL_API_KEY
    delete process.env.MODEL_API_KEY
    try {
      const s = await capturedStudio()
      const reply = await post(s, startBody({ request_text: `  <b>Please</b> verify the captured change. api_key=${SEEDED}  ` }))

      expect(reply.status, reply.body).toBe(202)
      expect(reply.headers['cache-control']).toBe('no-store')
      const body = JSON.parse(reply.body) as Record<string, string>
      expect(Object.keys(body).sort()).toEqual(['events_url', 'request_id', 'run_id'])
      expect(body.events_url).toBe(`/api/runs/${body.run_id}/events`)
      expect(body.run_id).not.toBe(body.request_id)
      expect(reply.body).not.toContain(SEEDED)

      expect(s.starts).toHaveLength(1)
      const [run] = s.runs as [CapturedRun]
      // The host starter receives only the server-bound request and the committed scenario.
      expect(Object.keys(run.start).sort()).toEqual(['request', 'scenario'])
      expect(Object.isFrozen(run.start)).toBe(true)
      expect(Object.isFrozen(run.start.request)).toBe(true)
      expect(parseChatRequest(run.start.request).ok).toBe(true)
      expect(run.start.request).toMatchObject({ request_id: body.request_id, run_id: body.run_id, session_id: s.server.session.sessionId, scenario_id: HERO })
      expect(run.start.request.text).not.toContain(SEEDED)
      expect(run.start.request.text).toContain('Please verify the captured change.')
      // Server-generated verification identities, distinct from the editing session.
      expect([body.run_id, body.request_id]).not.toContain(s.candidate.editingSessionId)
      expect(run.start.scenario.scenario.scenario_id).toBe(HERO)
    } finally {
      if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey
    }
  })

  it('rejects patch, filesystem, command, provider, mode and identity fields without starting a run or echoing them', async () => {
    const s = await capturedStudio()
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')
    const injected: Array<readonly [string, unknown]> = [
      ['patch', PATCH_TEXT],
      ['candidate', { patch: PATCH_TEXT }],
      ['candidate_patch', Buffer.from(PATCH_TEXT).toString('base64')],
      ['diff', PATCH_TEXT],
      ['repo_root', '/tmp/other-repository'],
      ['repository_root', '/tmp/other-repository'],
      ['worktree', '/tmp/other-worktree'],
      ['path', UNIQUE_PATH],
      ['scenario_path', 'scenarios/canvas-filter/hero.json'],
      ['command', ['sh', '-c', 'true']],
      ['check_command', ['node', 'check.mjs']],
      ['build_command', ['pnpm', 'build']],
      ['provider', { mode: 'fixture' }],
      ['transport', 'recorded'],
      ['test_transport', 'recorded'],
      ['model', 'other-model'],
      ['mode', CAPTURED_KIND],
      ['execution_kind', 'legacy'],
      ['kind', CAPTURED_KIND],
      ['run_id', randomUUID()],
      ['request_id', randomUUID()],
      ['editing_session_id', randomUUID()],
      ['baseline_commit', 'c'.repeat(40)],
    ]
    for (const [field, value] of injected) {
      const seeded = typeof value === 'string' ? `${value}-${SEEDED}` : { value, marker: SEEDED }
      const error = expectEnvelope(await post(s, startBody({ [field]: seeded })), 400, 'REQUEST_FIELD_REJECTED')
      expect(JSON.stringify(error), field).not.toContain(SEEDED)
      expect(JSON.stringify(error), field).not.toContain(UNIQUE_PATH)
      expectNoRunSideEffect(s, worktrees)
    }
  })

  it('accepts only the prepared scenario and a bounded goal', async () => {
    const s = await capturedStudio()
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')

    expectEnvelope(await post(s, startBody({ scenario_id: FAILURE })), 400, 'SCENARIO_NOT_AVAILABLE')
    expectEnvelope(await post(s, startBody({ scenario_id: 'canvas-filter-unknown' })), 400, 'SCENARIO_NOT_REGISTERED')
    expectEnvelope(await post(s, startBody({ scenario_id: '../scenarios/canvas-filter/hero.json' })), 400, 'SCENARIO_NOT_REGISTERED')
    expectEnvelope(await post(s, startBody({ request_text: '   ' })), 400, 'REQUEST_TEXT_EMPTY')
    expectEnvelope(await post(s, { scenario_id: HERO }), 400, 'REQUEST_TEXT_INVALID')
    expectNoRunSideEffect(s, worktrees)
  })

  it('cannot be selected by a browser on a legacy server, whose credential readiness is unchanged', async () => {
    const s = await legacyStudio({}, false)
    const worktrees = git(s.repo, 'worktree', 'list', '--porcelain')

    for (const field of ['mode', 'execution_kind', 'kind']) {
      expectEnvelope(await post(s, startBody({ [field]: CAPTURED_KIND })), 400, 'REQUEST_FIELD_REJECTED')
    }
    const error = expectEnvelope(await post(s, startBody()), 409, 'PROVIDER_CREDENTIAL_MISSING')
    expect(error.message).not.toContain('MODEL_API_KEY=')
    expectNoRunSideEffect(s, worktrees)
  })

  it('allows exactly one run per launch, even after it finalized', async () => {
    const s = await capturedStudio()
    const { run, body } = await startCaptured(s)

    expectEnvelope(await post(s, startBody()), 409, 'ACTIVE_RUN_EXISTS')
    run.finalize(bound(FAILED, body))
    expectEnvelope(await post(s, startBody()), 409, 'RUN_LIMIT_REACHED')

    expect(s.starts).toHaveLength(1)
    expect(s.runs.map((entry) => entry.handle.runId)).toEqual([body.run_id])
  })

  it('maps a failing host starter or a mismatched run identity to a fixed error without registering a run', async () => {
    const clone = await createTempClone()
    cleanups.push(clone.remove)
    let mode: 'throw' | 'mismatch' = 'throw'
    const server = await startStudioServer({
      repoRoot: clone.path,
      targetOrigin: TARGET_ORIGIN,
      captured: {
        scenarioId: HERO,
        startRun: async (start) => {
          if (mode === 'throw') throw new Error(`host failure at ${clone.path} ${SEEDED}`)
          const runId = randomUUID()
          const store = await createRunArtifactStore({ repoRoot: clone.path, runId })
          void start
          return { runId, events: createRunEventStream({ runId, registry: store }), artifacts: store, result: () => null }
        },
      },
    })
    cleanups.push(() => server.close())
    const s: Server = { server, repo: clone.path }

    const thrown = expectEnvelope(await post(s, startBody()), 500, 'RUN_START_FAILED')
    expect(JSON.stringify(thrown)).not.toContain(SEEDED)
    expect(JSON.stringify(thrown)).not.toContain(clone.path)
    mode = 'mismatch'
    expectEnvelope(await post(s, startBody()), 500, 'RUN_START_FAILED')
  })
})

describe('Captured Studio server: result, events and closed evidence', () => {
  it('returns the strict captured result bound to the started run', async () => {
    const s = await capturedStudio()
    const { run, body } = await startCaptured(s)

    const running = await get(s, `/api/runs/${body.run_id}/result`)
    expect(running.status).toBe(202)
    expect(JSON.parse(running.body)).toEqual({ state: 'running' })

    const final = bound(FAILED, body)
    run.finalize(final)
    const finished = await get(s, `/api/runs/${body.run_id}/result`)
    expect(finished.status).toBe(200)
    expect(finished.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(finished.body)).toEqual(final)
    expect(parseCapturedVerificationResult(JSON.parse(finished.body)).ok).toBe(true)
  })

  const variants: Array<readonly [string, (body: { readonly run_id: string; readonly request_id: string }) => unknown]> = [
    ['another run identifier', (body) => ({ ...bound(PASSED, body), run_id: randomUUID() })],
    ['another request identifier', (body) => ({ ...bound(PASSED, body), request_id: randomUUID() })],
    ['another scenario', (body) => ({ ...bound(PASSED, body), scenario_id: FAILURE })],
    ['the legacy result family', (body) => ({ ...structuredClone(LEGACY), run_id: body.run_id, request_id: body.request_id })],
    ['a Verified Fix label', (body) => ({ ...bound(PASSED, body), status: 'verified' })],
    ['an extra raw-path field', (body) => ({ ...bound(PASSED, body), patch_path: UNIQUE_PATH })],
  ]
  it.each(variants)('refuses to serve a result with %s', async (_label, make) => {
    const s = await capturedStudio()
    const { run, body } = await startCaptured(s)
    run.finalize(make(body) as StudioRunResult)

    const error = expectEnvelope(await get(s, `/api/runs/${body.run_id}/result`), 500, 'RESULT_INVALID')
    expect(JSON.stringify(error)).not.toContain(UNIQUE_PATH)
  })

  it('keeps the legacy result route strict about the legacy family', async () => {
    const s = await legacyStudio()
    const reply = await post(s, startBody())
    expect(reply.status, reply.body).toBe(202)
    const body = JSON.parse(reply.body) as { run_id: string; request_id: string }

    s.finalize(bound(PASSED, body))
    expectEnvelope(await get(s, `/api/runs/${body.run_id}/result`), 500, 'RESULT_INVALID')
    const legacy = { ...structuredClone(LEGACY), run_id: body.run_id, request_id: body.request_id }
    s.finalize(legacy)
    expect(JSON.parse((await get(s, `/api/runs/${body.run_id}/result`)).body)).toEqual(legacy)
  })

  it('streams the deterministic captured engine run with supported phases only and serves its bound result', async () => {
    const s = await capturedStudio({ engine: true, gated: true })
    const { run, body } = await startCaptured(s)
    const stream = await openEvents(s, body.run_id)
    expect(stream.status).toBe(200)
    s.release()
    const text = await stream.ended
    await run.done

    const delivered = dataRecords(text)
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered).toEqual(run.events.events())
    for (const event of delivered) {
      expect(parseStudioEvent(event).ok).toBe(true)
      expect(event.run_id).toBe(body.run_id)
      expect(STUDIO_EVENT_TYPES).toContain(event.type)
      expect(MODEL_EVENT_TYPES).not.toContain(event.type)
      expect(CAPTURED_PHASES).toContain(event.phase)
      for (const leak of [s.repo, UNIQUE_PATH, MARKER, s.candidate.editingSessionId, 'diff --git']) expect(event.message).not.toContain(leak)
    }
    expect(delivered.filter((event) => event.type === 'phase_started').map((event) => event.phase)).toEqual(['reproducing', 'failure_captured', 'applying', 'replaying'])
    // Each measured phase starts only on readiness, right after its not-live preparation activity.
    for (const [measured, prior] of [['reproducing', 'initialized'], ['replaying', 'applying']] as const) {
      const index = delivered.findIndex((event) => event.type === 'phase_started' && event.phase === measured)
      expect(delivered[index - 1]).toMatchObject({ type: 'agent_message', phase: prior, message: expect.stringMatching(/not live/i) })
      expect(delivered[index + 1]).toMatchObject({ type: 'evidence_added', phase: measured })
    }
    expect(delivered.at(-1)).toMatchObject({ type: 'run_finalized', phase: 'finalized' })

    const reply = await get(s, `/api/runs/${body.run_id}/result`)
    expect(reply.status).toBe(200)
    const parsed = parseCapturedVerificationResult(JSON.parse(reply.body))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    expect(parsed.value).toMatchObject({ kind: CAPTURED_KIND, run_id: body.run_id, request_id: body.request_id, scenario_id: HERO, editing_session_id: s.candidate.editingSessionId, status: 'passed' })
    expect(parsed.value.candidate_patch_sha256).toBe(s.candidate.patchSha256)
    for (const leak of [s.repo, UNIQUE_PATH, 'diff --git', MARKER]) expect(reply.body).not.toContain(leak)
  })

  it('serves registered evidence by closed ID, never a candidate diff or another run', async () => {
    const s = await capturedStudio({ engine: true })
    const { run, body } = await startCaptured(s)
    await run.done
    const result = run.handle.result() as CapturedVerificationResult
    const evidenceIds = result.checks.find((check) => check.check_id === 'baseline_reproduced')?.evidence_ids ?? []
    expect(evidenceIds.length).toBeGreaterThan(0)

    for (const id of evidenceIds) {
      const reply = await get(s, `/api/runs/${body.run_id}/evidence/${id}`)
      expect(reply.status, id).toBe(200)
      expect(reply.headers['cache-control']).toBe('no-store')
    }
    expectEnvelope(await get(s, `/api/runs/${body.run_id}/evidence/ev_replay_network_999`), 404, 'EVIDENCE_NOT_FOUND')
    expectEnvelope(await get(s, `/api/runs/${body.run_id}/evidence/result`), 400, 'EVIDENCE_ID_INVALID')
    expectEnvelope(await get(s, `/api/runs/${randomUUID()}/evidence/${evidenceIds[0] ?? ''}`), 404, 'RUN_NOT_FOUND')

    // Even an artifact stored under the candidate-diff name is never served for a captured run.
    expectEnvelope(await get(s, `/api/runs/${body.run_id}/artifacts/candidate-diff`), 404, 'ARTIFACT_NOT_FOUND')
    run.store.register('candidate-diff', await run.store.writeText('candidate/candidate.diff', PATCH_TEXT))
    const diff = expectEnvelope(await get(s, `/api/runs/${body.run_id}/artifacts/candidate-diff`), 404, 'ARTIFACT_NOT_FOUND')
    expect(JSON.stringify(diff)).not.toContain(UNIQUE_PATH)

    for (const target of [`/api/runs/${body.run_id}/artifacts/result`, `/api/runs/${body.run_id}/patch`, `/api/runs/${body.run_id}/candidate`, '/api/patch', `/api/runs/${body.run_id}/evidence/..%2Fresult.json`]) {
      const reply = await get(s, target)
      expect(reply.status, target).toBeGreaterThanOrEqual(400)
      expect(reply.body, target).not.toContain(UNIQUE_PATH)
      expect(reply.body, target).not.toContain('diff --git')
    }
  })
})
