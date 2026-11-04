// T029 service foundation (S6 unit A) — guarded capture/analyze/clarify ownership.
//
// The browser side is an explicitly labelled fake `DemonstrationRecorder` (`test_recorder`); the real
// launcher-owned recorder adapter is exercised by T026 (`tests/e2e/project-recording.spec.ts`). The
// lifecycle, prompt builder and model client are the real merged S4/S5 modules; the provider is an
// explicitly labelled in-process HTTP fake (`test_transport`). Nothing here is live acceptance, and
// the later UI-dependent cases of T032 are not claimed by this portion.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createProjectModelSession } from '../../packages/flowproof/src/model/projectClient.js'
import { InterpretationSchema, newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import { createProjectDemonstration, createProjectRun } from '../../packages/flowproof/src/project/run.js'

type Json = Record<string, any>
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

import { CONFIGURATION, IMAGE_BYTES, SECRET, SOURCES, TestRecorder } from '../support/projectDemonstration.js'

type Answer = (recorder: TestRecorder, body: Json) => unknown
const hostQuestion = (body: Json): string => JSON.parse(String(body.input[0].content[0].text).split('\n').slice(1).join('\n')).binding.question_id
const ready = (citations: string[], value = 'open'): Json => ({
  status: 'ready',
  observed_problem: 'Completed tasks remain visible.',
  citations,
  replay: { entry_path: '/', viewport: { width: 1280, height: 800, device_scale_factor: 1 }, actions: [{ op: 'fill', locator: { kind: 'test-id', value: 'search' }, value }] },
  expected_conditions: [{ kind: 'element-count', locator: { kind: 'test-id', value: 'completed-task' }, count: 0 }],
  task_condition_index: 0,
  intent_summary: 'Only open tasks are listed.',
  support_explanation: 'The screenshot shows completed rows.',
})
const clarify = (questionId: string, citation: string): Json => ({
  status: 'clarify',
  observed_facts: 'Two completed rows remain.',
  citations: [citation],
  question: { question_id: questionId, text: 'Should completed tasks be hidden?', missing_intent: 'Whether open excludes done.', alternatives: ['Hide', 'Show'] },
})
const payload = (document: unknown, extra: Json = {}): Json => ({
  id: 'resp_fake_1',
  object: 'response',
  status: 'completed',
  model: 'muse-spark-1.3',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(document) }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  ...extra,
})
const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

type Sources = () => Promise<{ readonly sources: readonly { path: string; content: string }[]; readonly admitted: ReadonlySet<string> }>
function world(
  options: {
    answers?: Answer[]
    gate?: Promise<void>
    env?: Json
    extra?: Json
    recorder?: (runId: string) => TestRecorder
    startGate?: Promise<void>
    sources?: Sources
    wrapModel?: (model: ReturnType<typeof createProjectModelSession>) => ReturnType<typeof createProjectModelSession>
  } = {},
) {
  const run = newProjectUuid()
  const lifecycle = createProjectRun({ runId: run, projectCheckIds: ['unit'] })
  lifecycle.transition('configuration-required')
  lifecycle.transition('preparing')
  lifecycle.transition('demonstration-ready')
  const calls: Json[] = []
  const recorders: TestRecorder[] = []
  const model = createProjectModelSession({
    run_id: run,
    env: (options.env ?? { MODEL_API_KEY: 'fp-test-key-not-real' }) as never,
    fake: {
      label: 'test_transport',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Json
        calls.push(body)
        if (options.gate) await options.gate
        const answers = options.answers ?? [(r) => ({ result: ready([r.image]) })]
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!
        return reply(payload(answer(recorders.at(-1)!, body), options.extra))
      },
    },
  })
  const service = createProjectDemonstration({
    lifecycle,
    configurationId: CONFIGURATION,
    model: options.wrapModel ? options.wrapModel(model) : model,
    startRecorder: async () => {
      if (options.startGate) await options.startGate
      const recorder = (options.recorder ?? ((id) => new TestRecorder(id)))(run)
      recorders.push(recorder)
      return recorder
    },
    loadSources: options.sources ?? (async () => ({ sources: SOURCES, admitted: new Set(['src/tasks.ts']) })),
  })
  return { run, lifecycle, model, calls, recorders, service }
}

const codeOf = (outcome: { ok: boolean; code?: string }): string => (outcome.ok ? 'OK' : outcome.code!)
async function captured(w: ReturnType<typeof world>): Promise<string> {
  const started = await w.service.start()
  if (!started.ok) throw new Error(started.code)
  const finished = await w.service.finish(started.value.capture_id)
  if (!finished.ok) throw new Error(finished.code)
  return started.value.capture_id
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('T029 guarded demonstration capture ownership', () => {
  it('submits nothing before an explicit Analyze, then binds the interpretation to run, capture, report and invocation', async () => {
    const w = world()
    const id = await captured(w)
    expect(w.calls).toHaveLength(0)
    expect(w.service.view()).toMatchObject({ state: 'capture-ready', capture_id: id, interpretation: null })
    const outcome = await w.service.analyze(id, { description: 'Filtering shows completed tasks.' })
    expect(codeOf(outcome)).toBe('OK')
    expect(w.calls).toHaveLength(1)
    const interpretation = outcome.ok ? outcome.value.interpretation : null
    expect(InterpretationSchema.safeParse(interpretation).success).toBe(true)
    const invocation = w.model.invocations()[0]!
    expect(interpretation).toMatchObject({ run_id: w.run, capture_id: id, report_sha256: sha256(`report:${id}`), invocation_id: invocation.invocation_id, input_sha256: invocation.input_sha256, analysis_attempt: 1, clarification: null })
    expect(invocation.transport).toBe('test_transport')
    expect(w.lifecycle.state()).toBe('interpretation-ready')
    expect(w.recorders[0]!.claimed).toBe(true)
  })

  it('keeps one active capture and owns capture identity: concurrent, foreign and reused IDs are refused', async () => {
    const w = world()
    const [first, second] = await Promise.all([w.service.start(), w.service.start()])
    expect([codeOf(first), codeOf(second)].sort()).toEqual(['CAPTURE_ACTIVE', 'OK'])
    const id = first.ok ? first.value.capture_id : second.ok ? second.value.capture_id : ''
    expect(codeOf(await w.service.finish(newProjectUuid()))).toBe('CAPTURE_UNKNOWN')
    const sealed = await w.service.finish(id)
    const again = await w.service.finish(id)
    expect(sealed).toEqual(again)
    expect(codeOf(await w.service.analyze(newProjectUuid(), { description: null }))).toBe('CAPTURE_UNKNOWN')
    expect(w.recorders).toHaveLength(1)
    expect(w.calls).toHaveLength(0)
  })

  it('discards before analysis: the report is deleted, the run returns to demonstration and the old ID is dead', async () => {
    const w = world()
    const id = await captured(w)
    expect(codeOf(await w.service.discard(id))).toBe('OK')
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('CAPTURE_UNKNOWN')
    const started = await w.service.start()
    expect(started.ok && started.value.capture_id).not.toBe(id)
    expect(codeOf(await w.service.discard(started.ok ? started.value.capture_id : ''))).toBe('OK')
    expect(w.calls).toHaveLength(0)
  })

  it('never presents an incomplete capture as ready and never analyzes it', async () => {
    const w = world({ recorder: (runId) => new TestRecorder(runId, { incomplete: true }) })
    const started = await w.service.start()
    const id = started.ok ? started.value.capture_id : ''
    const finished = await w.service.finish(id)
    expect(finished.ok && finished.value.state).toBe('incomplete')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('CAPTURE_UNKNOWN')
    expect(w.calls).toHaveLength(0)
  })

  it('refuses a sealed report bound to another configuration before any model request', async () => {
    const w = world({ recorder: (runId) => new TestRecorder(runId, { configurationId: newProjectUuid() }) })
    const started = await w.service.start()
    expect(codeOf(await w.service.finish(started.ok ? started.value.capture_id : ''))).toBe('CAPTURE_BINDING_MISMATCH')
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(w.calls).toHaveLength(0)
  })

  it('invalidates staged evidence when settings change before analysis, and cancels the run after submission', async () => {
    const w = world()
    const id = await captured(w)
    await w.service.invalidate()
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('CAPTURE_UNKNOWN')
    const v = world({ answers: [(r, body) => ({ result: clarify(hostQuestion(body), r.image) })] })
    const submitted = await captured(v)
    expect(codeOf(await v.service.analyze(submitted, { description: null }))).toBe('OK')
    await v.service.invalidate()
    expect(v.lifecycle.state()).toBe('finalizing')
    expect(codeOf(await v.service.clarify(v.service.view().question_id ?? '', 'Hide completed tasks.'))).toBe('RUN_NOT_ACCEPTING')
    expect(v.calls).toHaveLength(1)
  })
})

describe('T029 explicit analysis and the single clarification', () => {
  it('admits exactly one explicit answer bound to the current question, then one bounded re-analysis', async () => {
    const w = world({ answers: [(r, body) => ({ result: clarify(hostQuestion(body), r.image) }), (r) => ({ result: ready([r.image]) })] })
    const id = await captured(w)
    const first = await w.service.analyze(id, { description: null })
    expect(first.ok && first.value.interpretation.result.status).toBe('clarify')
    expect(w.lifecycle.state()).toBe('clarification-required')
    const question = w.service.view().question_id!
    expect(codeOf(await w.service.clarify(newProjectUuid(), 'Hide completed tasks.'))).toBe('CLARIFICATION_STALE')
    expect(w.calls).toHaveLength(1)
    const second = await w.service.clarify(question, 'Hide completed tasks.')
    expect(codeOf(second)).toBe('OK')
    expect(second.ok && second.value.interpretation).toMatchObject({
      analysis_attempt: 2,
      clarification: { question_id: question, answer_sha256: sha256('Hide completed tasks.') },
      result: { status: 'ready' },
    })
    expect(w.lifecycle.state()).toBe('interpretation-ready')
    expect(codeOf(await w.service.clarify(question, 'Again.'))).toBe('CLARIFICATION_STATE')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('CAPTURE_STATE')
    expect(w.calls).toHaveLength(2)
  })

  it('keeps cancellation sticky: a late provider response never becomes a usable interpretation', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const w = world({ gate })
    const id = await captured(w)
    const pending = w.service.analyze(id, { description: null })
    await delay(20)
    w.service.cancel()
    release()
    const outcome = await pending
    expect(codeOf(outcome)).toBe('PROVIDER_ABORTED')
    await delay(20)
    expect(w.service.view().interpretation).toBeNull()
    expect(w.lifecycle.state()).toBe('finalizing')
    expect(w.model.invocations().map((record) => record.status)).toEqual(['cancelled'])
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('RUN_NOT_ACCEPTING')
  })

  it.each<[string, Parameters<typeof world>[0], string]>([
    ['a missing host credential', { env: {} }, 'PROVIDER_CREDENTIAL_MISSING'],
    ['a different observed model', { extra: { model: 'muse-spark-1.2' } }, 'PROVIDER_IDENTITY_MISMATCH'],
    ['an uncited observation', { answers: [() => ({ result: ready([newProjectUuid()]) })] }, 'PROMPT_OUTPUT_CITATION_UNKNOWN'],
    ['a replay of a redacted reflected value', { answers: [(r) => ({ result: ready([r.image], SECRET) })] }, 'INTERPRETATION_REDACTED_VALUE'],
    ['a replay of a redaction marker', { answers: [(r) => ({ result: ready([r.image], '[REDACTED]') })] }, 'INTERPRETATION_REDACTED_VALUE'],
  ])('never turns %s into a usable interpretation', async (_name, options, expected) => {
    const w = world({
      ...options,
      recorder: (runId) => {
        const recorder = new TestRecorder(runId)
        recorder.registry.remember(SECRET)
        return recorder
      },
    })
    const id = await captured(w)
    const outcome = await w.service.analyze(id, { description: null })
    expect(codeOf(outcome)).toBe(expected)
    expect(w.service.view().interpretation).toBeNull()
    expect(w.lifecycle.state()).toBe('finalizing')
  })
})

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

describe('T029 ownership revocation across every service await', () => {
  it('invalidating settings during a pending start revokes it: the produced recorder is discarded, never recording', async () => {
    const gate = deferred()
    const w = world({ startGate: gate.promise })
    const pending = w.service.start()
    const invalidated = w.service.invalidate()
    gate.release()
    expect(codeOf(await pending)).toBe('CAPTURE_INVALIDATED')
    await invalidated
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(w.service.view()).toMatchObject({ capture_id: null, report: 'none' })
    const next = await w.service.start()
    expect(codeOf(next)).toBe('OK')
    expect(next.ok && next.value.capture_id).not.toBe(w.recorders[0]!.captureId)
  })

  it('returns from a settings change without waiting on a pending producer, and reuses nothing until it settles', async () => {
    const gate = deferred()
    const w = world({ startGate: gate.promise })
    const pending = w.service.start()
    await w.service.invalidate()
    expect(codeOf(await w.service.start())).toBe('CAPTURE_ACTIVE')
    gate.release()
    expect(codeOf(await pending)).toBe('CAPTURE_INVALIDATED')
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(codeOf(await w.service.start())).toBe('OK')
    expect(w.recorders).toHaveLength(2)
  })

  it('invalidating settings during a pending finish never yields a ready report and discards it', async () => {
    const gate = deferred()
    const w = world({ recorder: (runId) => new TestRecorder(runId, { finishGate: gate.promise }) })
    const started = await w.service.start()
    const id = started.ok ? started.value.capture_id : ''
    const pending = w.service.finish(id)
    const invalidated = w.service.invalidate()
    gate.release()
    expect(codeOf(await pending)).toBe('CAPTURE_INVALIDATED')
    await invalidated
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('CAPTURE_UNKNOWN')
    expect(w.calls).toHaveLength(0)
  })

  it('cancelling during a pending finish reports the cancellation, not a capture failure', async () => {
    const gate = deferred()
    const w = world({ recorder: (runId) => new TestRecorder(runId, { finishGate: gate.promise }) })
    const started = await w.service.start()
    const pending = w.service.finish(started.ok ? started.value.capture_id : '')
    w.service.cancel()
    gate.release()
    expect(codeOf(await pending)).toBe('RUN_NOT_ACCEPTING')
    expect(w.lifecycle.state()).toBe('finalizing')
    expect(w.recorders[0]!.state).toBe('discarded')
  })

  it('loads and validates sources before the irreversible claim: a failure leaves an unclaimed, discardable report', async () => {
    const w = world({ sources: async () => Promise.reject(new Error('io')) })
    const id = await captured(w)
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('SOURCES_UNAVAILABLE')
    expect(w.recorders[0]!.claimed).toBe(false)
    expect(w.lifecycle.state()).toBe('capture-ready')
    expect(codeOf(await w.service.discard(id))).toBe('OK')
    expect(w.recorders[0]!.state).toBe('discarded')
    expect(w.calls).toHaveLength(0)
  })

  it.each(['sources', 'claim'] as const)('invalidating during a pending %s step revokes the report before anything is sent', async (step) => {
    const gate = deferred()
    const w = world({
      ...(step === 'sources' ? { sources: async () => (await gate.promise, { sources: SOURCES, admitted: new Set(['src/tasks.ts']) }) } : {}),
      recorder: (runId) => new TestRecorder(runId, step === 'claim' ? { claimGate: gate.promise } : {}),
    })
    const id = await captured(w)
    const pending = w.service.analyze(id, { description: null })
    const invalidated = w.service.invalidate()
    gate.release()
    expect(codeOf(await pending)).toBe('CAPTURE_INVALIDATED')
    await invalidated
    expect(w.recorders[0]).toMatchObject({ claimed: false, state: 'discarded' })
    expect(w.lifecycle.state()).toBe('demonstration-ready')
    expect(w.service.view()).toMatchObject({ interpretation: null, report: 'none' })
    expect(w.calls).toHaveLength(0)
  })

  it('a prompt that cannot be built after the claim stops the run fail-closed, keeping the report claimed and unsent', async () => {
    const w = world({ sources: async () => ({ sources: [{ path: 'src/tasks.ts', content: 'const bell = "\u0007"\n' }], admitted: new Set(['src/tasks.ts']) }) })
    const id = await captured(w)
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('PROMPT_SOURCE_UNSAFE')
    expect(w.lifecycle.state()).toBe('finalizing')
    expect(w.service.view()).toMatchObject({ report: 'claimed', interpretation: null })
    expect(codeOf(await w.service.discard(id))).toBe('RUN_NOT_ACCEPTING')
    expect(w.recorders[0]).toMatchObject({ claimed: true, state: 'finished' })
    expect(w.calls).toHaveLength(0)
  })

  it('an unexpected thrown model error settles the operation and stops the run without an interpretation', async () => {
    const w = world({ wrapModel: (model) => ({ ...model, analyze: async () => Promise.reject(new Error('boom')) }) })
    const id = await captured(w)
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('ANALYSIS_FAILED')
    expect(w.lifecycle.state()).toBe('finalizing')
    expect(w.service.view()).toMatchObject({ report: 'claimed', interpretation: null })
  })

  it('distinguishes a report actually sent to the provider from one only claimed', async () => {
    const w = world()
    const id = await captured(w)
    expect(w.service.view().report).toBe('sealed')
    expect(codeOf(await w.service.analyze(id, { description: null }))).toBe('OK')
    expect(w.service.view().report).toBe('submitted')
    const missing = world({ env: {} })
    const unsent = await captured(missing)
    expect(codeOf(await missing.service.analyze(unsent, { description: null }))).toBe('PROVIDER_CREDENTIAL_MISSING')
    expect(missing.service.view().report).toBe('claimed')
  })
})
