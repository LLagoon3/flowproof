import { describe, expect, it } from 'vitest'

import { parseDemonstrationRunView } from '../../apps/studio/src/api.js'
import { demonstrationConditionText, demonstrationMessage, demonstrationModelText } from '../../apps/studio/src/presentation.js'
import { classifyDemonstrationRefusal, isDemonstrationRunStopped } from '../../apps/studio/src/state.js'

// T030 pure UI logic: the run view is read strictly, refusals map to explicit local transitions and
// wording never echoes provider text, keys or codes.

const RUN = '11111111-1111-4111-8111-111111111111'
const CAPTURE = '22222222-2222-4222-8222-222222222222'
const QUESTION = '33333333-3333-4333-8333-333333333333'
const base = { run_id: RUN, state: 'interpretation-ready', capture_id: CAPTURE, report: 'submitted', report_sha256: 'a'.repeat(64), question_id: null }
const readyResult = {
  status: 'ready',
  observed_problem: 'Completed tasks appear under Open.',
  citations: ['x'],
  replay: { steps: [] },
  expected_conditions: [{ kind: 'element-count', locator: { kind: 'test-id', value: 'task-item' }, count: 3 }, { kind: 'path', path: '/' }],
  task_condition_index: 0,
  intent_summary: 'Open shows only unfinished tasks.',
  support_explanation: 'The demonstration filtered by Open.',
}
const model = { requested_model: 'muse-spark-1.3', observed_model: 'muse-spark-1.3', transport: 'test_transport' }

describe('project demonstration UI logic', () => {
  it('reads a ready interpretation with its model provenance and nothing else', () => {
    const view = parseDemonstrationRunView({ ...base, interpretation: { analysis_attempt: 1, result: readyResult, input_sha256: 'b'.repeat(64) }, model })
    expect(view).not.toBeNull()
    expect(view!.result).toMatchObject({ status: 'ready', task_condition_index: 0, intent_summary: 'Open shows only unfinished tasks.' })
    expect(view!.result).not.toHaveProperty('replay')
    expect(view!.result).not.toHaveProperty('citations')
    expect(view!.model).toEqual(model)
    expect(view!.analysis_attempt).toBe(1)
  })

  it('reads one focused clarification question and refuses malformed views instead of partially showing them', () => {
    const clarify = { status: 'clarify', observed_facts: 'Two filters were used.', citations: ['x'], question: { question_id: QUESTION, text: 'Which filter is wrong?', missing_intent: 'The intended filter.', alternatives: ['Open', 'Done'] } }
    const view = parseDemonstrationRunView({ ...base, state: 'clarification-required', question_id: QUESTION, interpretation: { analysis_attempt: 1, result: clarify }, model })
    expect(view!.result).toMatchObject({ status: 'clarify', question: { question_id: QUESTION, alternatives: ['Open', 'Done'] } })
    expect(parseDemonstrationRunView({ ...base, interpretation: { analysis_attempt: 1, result: { status: 'ready' } }, model: null })).toBeNull()
    expect(parseDemonstrationRunView({ ...base, interpretation: null, model: { requested_model: 'm', transport: 3 } })).toBeNull()
    expect(parseDemonstrationRunView({ ...base, run_id: 7, interpretation: null, model: null })).toBeNull()
    expect(parseDemonstrationRunView({ ...base, interpretation: null, model: null })).toMatchObject({ result: null, model: null })
  })

  it('maps refusals to explicit transitions: host change resets, stop is sticky, busy is retryable', () => {
    for (const code of ['CAPTURE_INVALIDATED', 'CONFIGURATION_STALE', 'PROJECT_NOT_PREPARED', 'RUN_UNKNOWN', 'CAPTURE_UNKNOWN']) expect(classifyDemonstrationRefusal(code)).toBe('host-changed')
    for (const code of ['RUN_NOT_ACCEPTING', 'PROVIDER_CONNECTION_FAILED', 'PROMPT_IMAGE_REQUIRED', 'INTERPRETATION_INVALID']) expect(classifyDemonstrationRefusal(code)).toBe('stopped')
    expect(classifyDemonstrationRefusal('CAPTURE_ACTIVE')).toBe('busy')
    expect(classifyDemonstrationRefusal('SOURCES_UNAVAILABLE')).toBe('failed')
    expect([isDemonstrationRunStopped('finalizing'), isDemonstrationRunStopped('terminal'), isDemonstrationRunStopped('capture-ready')]).toEqual([true, true, false])
  })

  it('words outcomes, conditions and model provenance without echoing codes or claiming a live provider', () => {
    for (const code of ['PROVIDER_SERVER_ERROR', 'PROMPT_IMAGE_REQUIRED', 'CAPTURE_INVALIDATED', 'UNKNOWN_CODE']) {
      expect(demonstrationMessage(code)).not.toContain(code)
    }
    expect(demonstrationConditionText(readyResult.expected_conditions[0]!)).toBe('test ID “task-item” appears 3 times')
    expect(demonstrationConditionText({ kind: 'path', path: '/' })).toBe('the page path is /')
    expect(demonstrationModelText(model)).toBe('Requested muse-spark-1.3 · observed muse-spark-1.3 · labelled test transport, not a live provider')
    expect(demonstrationModelText({ ...model, observed_model: null, transport: 'meta' })).toBe('Requested muse-spark-1.3 · observed not reported · live provider')
  })
})
