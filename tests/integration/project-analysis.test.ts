// T029 service foundation (S6 unit A) — guarded capture/analyze/clarify ownership.
//
// The browser side is an explicitly labelled fake `DemonstrationRecorder` (`test_recorder`); the real
// launcher-owned recorder adapter is exercised by T026 (`tests/e2e/project-recording.spec.ts`). The
// lifecycle, prompt builder and model client are the real merged S4/S5 modules; the provider is an
// explicitly labelled in-process HTTP fake (`test_transport`). Nothing here is live acceptance, and
// the later UI-dependent cases of T032 are not claimed by this portion.
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { RedactedValueRegistry } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import type { SealedCapture } from '../../packages/flowproof/src/capture/projectRecorder.js'
import { createProjectModelSession } from '../../packages/flowproof/src/model/projectClient.js'
import { InterpretationSchema, newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import { createProjectDemonstration, createProjectRun } from '../../packages/flowproof/src/project/run.js'
import type { DemonstrationRecorder } from '../../packages/flowproof/src/project/run.js'

type Json = Record<string, any>
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc(height * (1 + width * 4), 0x40)
  for (let y = 0; y < height; y += 1) pixels[y * (1 + width * 4)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

const IMAGE_BYTES = png(8, 6)
const REVISION = 'b'.repeat(40)
const PROJECT = newProjectUuid()
const CONFIGURATION = newProjectUuid()
const FRAME = newProjectUuid()
const SECRET = 'harbor-lamp-4821'
const SOURCES = [{ path: 'src/tasks.ts', content: 'export const visible = (tasks: string[]) => tasks\n' }]

/** Explicitly labelled stand-in for the launcher-owned recorder; it never claims a browser capture. */
class TestRecorder implements DemonstrationRecorder {
  readonly label = 'test_recorder'
  readonly captureId = newProjectUuid()
  readonly image = newProjectUuid()
  readonly artifact = newProjectUuid()
  readonly registry = new RedactedValueRegistry()
  state: 'recording' | 'finished' | 'discarded' = 'recording'
  claimed = false
  #sealed: Promise<SealedCapture> | null = null

  constructor(
    readonly runId: string,
    readonly options: { readonly incomplete?: boolean; readonly configurationId?: string } = {},
  ) {}

  finish(): Promise<SealedCapture> {
    this.#sealed ??= Promise.resolve(this.#seal())
    this.state = 'finished'
    return this.#sealed
  }

  async discard(): Promise<void> {
    if (this.claimed) throw new Error('CAPTURE_SUBMITTED')
    this.state = 'discarded'
  }

  async detach(): Promise<void> {}

  async claim(): Promise<{ readonly sealed: SealedCapture; readonly registry: RedactedValueRegistry }> {
    if (this.state !== 'finished' || this.options.incomplete) throw new Error('CAPTURE_NOT_READY')
    this.claimed = true
    return { sealed: await this.finish(), registry: this.registry }
  }

  #seal(): SealedCapture {
    const ready = this.options.incomplete !== true
    const report = sha256(`report:${this.captureId}`)
    const capture = {
      schema_version: 1,
      capture_id: this.captureId,
      run_id: this.runId,
      project_id: PROJECT,
      baseline_commit: REVISION,
      configuration_id: this.options.configurationId ?? CONFIGURATION,
      configuration_digest: 'c'.repeat(64),
      target_origin: 'http://localhost:41234',
      viewport: { width: 1280, height: 800, device_scale_factor: 1 },
      state: ready ? 'ready' : 'incomplete',
      document_epoch: 0,
      interactions: [
        {
          sequence: 1,
          capture_id: this.captureId,
          document_epoch: 0,
          frame_id: FRAME,
          offset_ms: 100,
          action: { type: 'fill', locators: [{ kind: 'test-id', value: 'search' }], value: { kind: 'safe', text: 'open' } },
          related_observation_ids: [this.image],
        },
      ],
      observations: [
        {
          observation_id: this.image,
          run_id: this.runId,
          capture_id: this.captureId,
          baseline_commit: REVISION,
          phase: 'demonstration',
          type: 'image',
          availability: 'available',
          reason: null,
          sequence_range: { first: 1, last: 1 },
          policy_version: 'project-privacy-v1',
          redaction_count: 0,
          payload: {
            viewport: { width: 1280, height: 800 },
            clip: { x: 0, y: 0, width: 640, height: 400 },
            mask_count: 0,
            masked_before_retention: true,
            build_sha256: 'd'.repeat(64),
            artifact: { artifact_id: this.artifact, sha256: sha256(IMAGE_BYTES), bytes: IMAGE_BYTES.length, media_type: 'image/png' },
          },
        },
      ],
      counters: { unavailable: 0, unsupported: 0, dropped: 0 },
      completeness: ready ? { status: 'complete', reasons: [] } : { status: 'incomplete', reasons: ['IMAGE_LIMIT_EXCEEDED'] },
      timing: { started_offset_ms: 0, finished_offset_ms: 200 },
      staged_bytes: IMAGE_BYTES.length,
      seal: ready ? { report_sha256: report } : null,
    }
    return { capture: capture as never, report_sha256: report, artifacts: new Map([[this.artifact, IMAGE_BYTES]]) }
  }
}

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

function world(options: { answers?: Answer[]; gate?: Promise<void>; env?: Json; extra?: Json; recorder?: (runId: string) => TestRecorder } = {}) {
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
    model,
    startRecorder: async () => {
      const recorder = (options.recorder ?? ((id) => new TestRecorder(id)))(run)
      recorders.push(recorder)
      return recorder
    },
    loadSources: async () => ({ sources: SOURCES, admitted: new Set(['src/tasks.ts']) }),
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
