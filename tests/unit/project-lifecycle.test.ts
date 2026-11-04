import { describe, expect, it, vi } from 'vitest'

import {
  AUTOMATIC_RUN_STATES,
  EXECUTION_LIMITS,
  HUMAN_WAIT_STATES,
  MANDATORY_CHECK_IDS,
  PROJECT_CLAIM,
  RUN_STATES,
  canTransitionRun,
  isHumanWaitState,
  newProjectUuid,
  operationTimeoutMs,
} from '../../packages/flowproof/src/project/contracts.js'
import type { RunState } from '../../packages/flowproof/src/project/contracts.js'
import { FINALIZATION_CHECK_IDS, ProjectRunError, createProjectRun } from '../../packages/flowproof/src/project/run.js'
import type { LifecycleClock, ProjectRunLifecycle } from '../../packages/flowproof/src/project/run.js'

// T008: the project-live run lifecycle walks only the declared state sequence, keeps a requested
// cancellation sticky against late model/build completions, releases owned resources exactly
// once, lets integrity and cleanup veto a provisional pass, and counts automatic budgets only in
// automatic states: demonstration, clarification, interpretation and result review never time out.

interface FakeClock extends LifecycleClock {
  advance(ms: number): void
  readonly pending: () => number
}

function fakeClock(): FakeClock {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimer(callback, ms) {
      const id = next
      next += 1
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].callback()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

const HOUR = 3_600_000
const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function newRun(clock = fakeClock()): { run: ProjectRunLifecycle; clock: FakeClock } {
  return { run: createProjectRun({ runId: newProjectUuid(), projectCheckIds: ['unit'], clock }), clock }
}

function expectRunError(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectRunError)
    expect((error as ProjectRunError).code).toBe(code)
    return
  }
  throw new Error(`Expected ${code}, but the action succeeded.`)
}

const pass = (run: ProjectRunLifecycle, id: string, phase = 'candidate'): boolean =>
  run.recordCheck({ id, status: 'passed', phase: phase as never, reason: 'CHECK_PASSED' })

/** Runs a short automatic operation that completes and applies its checks. */
function work(
  run: ProjectRunLifecycle,
  clock: FakeClock,
  kind: 'prepare' | 'build' | 'check' | 'replay' | 'provider',
  ms: number,
  checks: string[] = [],
  skip: readonly string[] = [],
): boolean {
  const operation = run.beginOperation(kind)
  clock.advance(ms)
  return operation.complete(() => checks.filter((check) => !skip.includes(check)).forEach((check) => expect(pass(run, check)).toBe(true)))
}

/** Drives a run through every declared state with all functional checks passing. */
function driveToCandidateChecking(run: ProjectRunLifecycle, clock: FakeClock, options: { readonly clarify?: boolean; readonly skip?: readonly string[] } = {}): void {
  const skip = options.skip ?? []
  run.transition('configuration-required')
  pass(run, 'admission_consistent', 'admission')
  run.transition('preparing')
  work(run, clock, 'prepare', 1_000)
  run.transition('demonstration-ready')
  run.transition('recording')
  run.transition('capture-ready')
  pass(run, 'capture_complete', 'capture')
  run.transition('analyzing')
  work(run, clock, 'provider', 1_000)
  if (options.clarify) {
    run.transition('clarification-required')
    run.transition('analyzing')
    work(run, clock, 'provider', 1_000)
  }
  pass(run, 'interpretation_valid', 'analysis')
  run.transition('interpretation-ready')
  run.transition('baseline-replay')
  pass(run, 'definition_frozen', 'definition')
  work(run, clock, 'replay', 1_000, ['baseline_reproduced'])
  run.transition('correcting')
  work(run, clock, 'provider', 1_000, ['correction_generated'])
  run.transition('candidate-checking')
  work(run, clock, 'build', 1_000, ['candidate_applied', 'candidate_build'])
  work(run, clock, 'check', 1_000, ['inputs_unchanged', 'project_check:unit'], skip)
  work(run, clock, 'replay', 1_000, ['candidate_replay', 'evidence_bound'])
}

describe('shared run-state helpers', () => {
  it('classifies every state exactly once and keeps finalization/terminal out of both budgets', () => {
    expect(RUN_STATES).toEqual([
      'project-selected',
      'configuration-required',
      'preparing',
      'demonstration-ready',
      'recording',
      'capture-ready',
      'analyzing',
      'clarification-required',
      'interpretation-ready',
      'baseline-replay',
      'correcting',
      'candidate-checking',
      'finalizing',
      'terminal',
    ])
    expect(HUMAN_WAIT_STATES).toEqual([
      'project-selected',
      'configuration-required',
      'demonstration-ready',
      'recording',
      'capture-ready',
      'clarification-required',
      'interpretation-ready',
      'terminal',
    ])
    expect(AUTOMATIC_RUN_STATES).toEqual(['preparing', 'analyzing', 'baseline-replay', 'correcting', 'candidate-checking'])
    expect(HUMAN_WAIT_STATES.filter((state) => (AUTOMATIC_RUN_STATES as readonly string[]).includes(state))).toEqual([])
    expect(isHumanWaitState('recording')).toBe(true)
    expect(isHumanWaitState('finalizing')).toBe(false)
    expect(canTransitionRun('capture-ready', 'recording')).toBe(true)
    expect(canTransitionRun('interpretation-ready', 'recording')).toBe(false)
    expect(canTransitionRun('finalizing', 'terminal')).toBe(true)
    expect(canTransitionRun('terminal', 'finalizing')).toBe(false)
    expect(operationTimeoutMs('provider')).toBe(EXECUTION_LIMITS.provider_timeout_ms)
    expect(operationTimeoutMs('build')).toBe(EXECUTION_LIMITS.phase_timeout_ms)
  })
})

describe('declared run-state sequence', () => {
  it('walks the declared sequence and rejects skipped, backward and reserved transitions', async () => {
    const { run, clock } = newRun()
    expect(run.state()).toBe('project-selected')
    expectRunError(() => run.transition('preparing'), 'RUN_TRANSITION_INVALID')
    expectRunError(() => run.transition('terminal'), 'RUN_TRANSITION_RESERVED')
    expectRunError(() => run.transition('finalizing'), 'RUN_TRANSITION_RESERVED')
    expectRunError(() => run.transition('nonsense' as RunState), 'RUN_TRANSITION_INVALID')
    driveToCandidateChecking(run, clock)
    expect(run.state()).toBe('candidate-checking')
    expectRunError(() => run.transition('baseline-replay'), 'RUN_TRANSITION_INVALID')
    const result = await run.finalize({ originalIntegrity: 'verified' })
    expect(run.state()).toBe('terminal')
    expect(result.outcome).toBe('passed')
    expect(result.claim).toBe(PROJECT_CLAIM)
    expectRunError(() => run.transition('recording'), 'RUN_TRANSITION_INVALID')
  })

  it('supports pre-analysis discard and re-record but at most one clarification', () => {
    const { run, clock } = newRun()
    run.transition('configuration-required')
    run.transition('preparing')
    work(run, clock, 'prepare', 10)
    run.transition('demonstration-ready')
    run.transition('recording')
    run.transition('demonstration-ready')
    run.transition('recording')
    run.transition('capture-ready')
    run.transition('recording')
    run.transition('capture-ready')
    run.transition('analyzing')
    expectRunError(() => run.transition('recording'), 'RUN_TRANSITION_INVALID')
    work(run, clock, 'provider', 10)
    run.transition('clarification-required')
    run.transition('analyzing')
    work(run, clock, 'provider', 10)
    expectRunError(() => run.transition('clarification-required'), 'RUN_CLARIFICATION_EXHAUSTED')
  })

  it('never reports a pass before finalization or without every obligation on the full path', async () => {
    const early = newRun()
    early.run.transition('configuration-required')
    for (const check of [...MANDATORY_CHECK_IDS, 'project_check:unit']) {
      if (!(FINALIZATION_CHECK_IDS as readonly string[]).includes(check)) expect(pass(early.run, check)).toBe(true)
    }
    expect(early.run.snapshot().outcome).toBeNull()
    const earlyResult = await early.run.finalize({ originalIntegrity: 'verified' })
    expect(earlyResult.outcome).toBe('unverified')
    expect(earlyResult.primary_reason).toBe('RUN_PATH_INCOMPLETE')
    expect(earlyResult.claim).toBeNull()

    const missing = newRun()
    driveToCandidateChecking(missing.run, missing.clock, { skip: ['project_check:unit'] })
    expect(missing.run.snapshot().checks.find((check) => check.id === 'project_check:unit')?.status).toBe('not_evaluated')
    expect(missing.run.snapshot().outcome).toBeNull()
    const missingResult = await missing.run.finalize({ originalIntegrity: 'verified' })
    expect(missingResult.outcome).toBe('unverified')
    expect(missingResult.primary_reason).toBe('CHECK_NOT_EVALUATED')
    expect(missingResult.checks.map((check) => check.id)).toEqual([...MANDATORY_CHECK_IDS, 'project_check:unit'])
  })

  it('rejects unknown, reserved and regressing check updates', () => {
    const { run } = newRun()
    expectRunError(() => run.recordCheck({ id: 'made_up', status: 'passed', phase: 'admission', reason: 'CHECK_PASSED' }), 'RUN_CHECK_UNKNOWN')
    expectRunError(() => run.recordCheck({ id: 'cleanup_complete', status: 'passed', phase: 'finalization', reason: 'CHECK_PASSED' }), 'RUN_CHECK_RESERVED')
    expectRunError(() => run.recordCheck({ id: 'original_unchanged', status: 'passed', phase: 'finalization', reason: 'CHECK_PASSED' }), 'RUN_CHECK_RESERVED')
    expect(run.recordCheck({ id: 'admission_consistent', status: 'failed', phase: 'admission', reason: 'ADMISSION_STALE' })).toBe(true)
    expectRunError(() => pass(run, 'admission_consistent', 'admission'), 'RUN_CHECK_REGRESSION')
    expectRunError(() => run.recordCheck({ id: 'capture_complete', status: 'passed', phase: 'capture', reason: 'lowercase' }), 'RUN_CHECK_INVALID')
    expectRunError(() => createProjectRun({ runId: 'not-a-uuid', projectCheckIds: ['unit'] }), 'RUN_ID_INVALID')
    expectRunError(() => createProjectRun({ runId: newProjectUuid(), projectCheckIds: ['unit', 'unit'] }), 'RUN_CHECK_INVALID')
  })
})

describe('sticky cancellation and late completions', () => {
  it('ignores a late model completion after cancellation and finalizes as canceled', async () => {
    const late = newRun()
    late.run.transition('configuration-required')
    late.run.transition('preparing')
    work(late.run, late.clock, 'prepare', 10)
    late.run.transition('demonstration-ready')
    late.run.transition('recording')
    late.run.transition('capture-ready')
    late.run.transition('analyzing')
    const provider = late.run.beginOperation('provider')
    expect(late.run.requestCancel()).toBe(true)
    expect(provider.signal.aborted).toBe(true)
    expect(late.run.state()).toBe('finalizing')
    const apply = vi.fn(() => pass(late.run, 'interpretation_valid', 'analysis'))
    expect(provider.complete(apply)).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    expect(pass(late.run, 'interpretation_valid', 'analysis')).toBe(false)
    expect(late.run.requestCancel()).toBe(true)
    const result = await late.run.finalize({ originalIntegrity: 'verified' })
    expect(result.outcome).toBe('canceled')
    expect(result.cancel_requested).toBe(true)
    expect(result.late_completions).toBe(1)
    expect(result.checks.find((check) => check.id === 'interpretation_valid')?.status).toBe('not_evaluated')
    expect(late.run.requestCancel()).toBe(false)
  })

  it('keeps a canceled run canceled when a build passes late, even with every other check passed', async () => {
    const { run, clock } = newRun()
    driveToCandidateChecking(run, clock)
    const build = run.beginOperation('build')
    run.requestCancel()
    clock.advance(1_000)
    expect(build.complete(() => pass(run, 'candidate_build'))).toBe(false)
    const result = await run.finalize({ originalIntegrity: 'verified' })
    expect(result.outcome).toBe('canceled')
    expect(result.claim).toBeNull()
    expect(build.complete()).toBe(false)
    expect(build.fail('BUILD_FAILED')).toBe(false)
    expect(result.late_completions).toBe(1)
  })

  it('treats completions after the terminal result as late and leaves the result unchanged', async () => {
    const { run, clock } = newRun()
    driveToCandidateChecking(run, clock)
    const replay = run.beginOperation('replay')
    const finalizing = run.finalize({ originalIntegrity: 'verified' })
    expect(replay.signal.aborted).toBe(true)
    expect(replay.complete(() => pass(run, 'candidate_replay'))).toBe(false)
    const result = await finalizing
    expect(result.outcome).toBe('unverified')
    expect(result.primary_reason).toBe('RUN_FINALIZED_EARLY')
    expect(await run.finalize({ originalIntegrity: 'changed' })).toBe(result)
  })
})

describe('ownership cleanup and finalization vetoes', () => {
  it('releases each owned resource exactly once in reverse order across concurrent finalize and cancel', async () => {
    const { run, clock } = newRun()
    const order: string[] = []
    const resource = (label: string) => ({
      kind: 'container' as const,
      label,
      release: vi.fn(async () => {
        order.push(label)
      }),
      verifyReleased: vi.fn(async () => true),
    })
    const first = resource('first')
    const second = resource('second')
    run.own(first)
    run.own(second)
    driveToCandidateChecking(run, clock)
    const [left, right] = await Promise.all([run.finalize({ originalIntegrity: 'verified' }), run.finalize({ originalIntegrity: 'verified' })])
    run.requestCancel()
    expect(left).toBe(right)
    expect(left.outcome).toBe('passed')
    expect(left.cleanup).toBe('complete')
    expect(order).toEqual(['second', 'first'])
    for (const spec of [first, second]) {
      expect(spec.release).toHaveBeenCalledTimes(1)
      expect(spec.verifyReleased).toHaveBeenCalledTimes(1)
    }
    expectRunError(() => run.own(resource('late')), 'RUN_OWNERSHIP_CLOSED')
    expectRunError(() => newRun().run.own({ ...resource('x'), kind: 'arbitrary' as never }), 'RUN_RESOURCE_INVALID')
  })

  it('lets original-integrity and cleanup failures override a provisional functional pass', async () => {
    const changed = newRun()
    driveToCandidateChecking(changed.run, changed.clock)
    expect((await changed.run.finalize({ originalIntegrity: 'changed' })).outcome).toBe('integrity_failed')

    const leaked = newRun()
    leaked.run.own({ kind: 'container', label: 'target', release: async () => undefined, verifyReleased: async () => false })
    driveToCandidateChecking(leaked.run, leaked.clock)
    const leakedResult = await leaked.run.finalize({ originalIntegrity: 'verified' })
    expect(leakedResult.outcome).toBe('cleanup_failed')
    expect(leakedResult.cleanup).toBe('failed')
    expect(leakedResult.claim).toBeNull()

    const recovered = newRun()
    const release = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(undefined)
    recovered.run.own({ kind: 'temp-directory', label: 'candidate-copy', release, verifyReleased: async () => true })
    driveToCandidateChecking(recovered.run, recovered.clock)
    const recoveredResult = await recovered.run.finalize({ originalIntegrity: 'verified' })
    expect(release).toHaveBeenCalledTimes(2)
    expect(recoveredResult.cleanup).toBe('recovered')
    expect(recoveredResult.outcome).toBe('passed')

    const cancelledAndChanged = newRun()
    cancelledAndChanged.run.requestCancel()
    expect((await cancelledAndChanged.run.finalize({ originalIntegrity: 'changed' })).outcome).toBe('integrity_failed')
  })

  it('joins producers before cleanup and marks cleanup unverified when one never stops', async () => {
    const { run, clock } = newRun()
    const release = vi.fn(async () => undefined)
    run.own({ kind: 'process', label: 'build', release, verifyReleased: async () => true })
    driveToCandidateChecking(run, clock)
    run.beginOperation('build')
    run.requestCancel()
    const finalizing = run.finalize({ originalIntegrity: 'verified' })
    await flush()
    expect(release).not.toHaveBeenCalled()
    clock.advance(EXECUTION_LIMITS.stop_grace_ms)
    const result = await finalizing
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.producers_joined).toBe(false)
    expect(result.cleanup).toBe('unverified')
    expect(result.outcome).toBe('cleanup_failed')
  })
})

describe('automatic budgets exclude human waiting states', () => {
  it('runs no countdown and allows no automatic work in any human waiting state', async () => {
    const { run, clock } = newRun()
    const idle = (): void => {
      expect(clock.pending()).toBe(0)
      clock.advance(10 * HOUR)
      expect(run.snapshot().automatic_elapsed_ms).toBe(elapsed)
      expect(run.snapshot().interruption_reason).toBeNull()
      expectRunError(() => run.beginOperation('provider'), 'RUN_OPERATION_STATE')
    }
    let elapsed = 0
    idle()
    run.transition('configuration-required')
    idle()
    run.transition('preparing')
    work(run, clock, 'prepare', 2_000)
    elapsed += 2_000
    run.transition('demonstration-ready')
    idle()
    run.transition('recording')
    idle()
    run.transition('capture-ready')
    idle()
    run.transition('analyzing')
    work(run, clock, 'provider', 3_000)
    elapsed += 3_000
    run.transition('clarification-required')
    idle()
    run.transition('analyzing')
    work(run, clock, 'provider', 3_000)
    elapsed += 3_000
    run.transition('interpretation-ready')
    idle()
    expect(run.snapshot().automatic_remaining_ms).toBe(EXECUTION_LIMITS.aggregate_automatic_ms - elapsed)
    run.requestCancel()
    await run.finalize({ originalIntegrity: 'verified' })
    clock.advance(10 * HOUR)
    expect(run.state()).toBe('terminal')
    expect(clock.pending()).toBe(0)
  })

  it('stops automatic work when the aggregate 600-second budget is exhausted', async () => {
    const { run, clock } = newRun()
    run.transition('configuration-required')
    run.transition('preparing')
    work(run, clock, 'prepare', 110_000)
    work(run, clock, 'build', 110_000)
    run.transition('demonstration-ready')
    run.transition('recording')
    run.transition('capture-ready')
    run.transition('analyzing')
    work(run, clock, 'provider', 85_000)
    run.transition('interpretation-ready')
    clock.advance(HOUR)
    run.transition('baseline-replay')
    work(run, clock, 'build', 110_000)
    work(run, clock, 'replay', 110_000)
    expect(run.snapshot().automatic_elapsed_ms).toBe(525_000)
    run.transition('correcting')
    const provider = run.beginOperation('provider')
    clock.advance(75_000)
    expect(provider.signal.aborted).toBe(true)
    expect(run.state()).toBe('finalizing')
    expect(run.snapshot().interruption_reason).toBe('AUTOMATIC_BUDGET_EXCEEDED')
    expect(provider.complete()).toBe(false)
    const result = await run.finalize({ originalIntegrity: 'verified' })
    expect(result.outcome).toBe('unverified')
    expect(result.primary_reason).toBe('AUTOMATIC_BUDGET_EXCEEDED')
    expect(result.automatic_elapsed_ms).toBe(EXECUTION_LIMITS.aggregate_automatic_ms)
  })

  it('bounds each build/check/replay phase and provider exchange, and checks operation states', async () => {
    const build = newRun()
    build.run.transition('configuration-required')
    build.run.transition('preparing')
    const operation = build.run.beginOperation('build')
    expectRunError(() => build.run.beginOperation('provider'), 'RUN_OPERATION_STATE')
    expectRunError(() => build.run.transition('demonstration-ready'), 'RUN_OPERATION_PENDING')
    build.clock.advance(EXECUTION_LIMITS.phase_timeout_ms)
    expect(operation.signal.aborted).toBe(true)
    expect(build.run.snapshot().interruption_reason).toBe('PHASE_TIMEOUT')
    expect(operation.complete()).toBe(false)
    expect((await build.run.finalize({ originalIntegrity: 'verified' })).primary_reason).toBe('PHASE_TIMEOUT')

    const provider = newRun()
    provider.run.transition('configuration-required')
    provider.run.transition('preparing')
    work(provider.run, provider.clock, 'prepare', 10)
    provider.run.transition('demonstration-ready')
    provider.run.transition('recording')
    provider.run.transition('capture-ready')
    provider.run.transition('analyzing')
    const call = provider.run.beginOperation('provider')
    provider.clock.advance(EXECUTION_LIMITS.provider_timeout_ms - 1)
    expect(call.signal.aborted).toBe(false)
    provider.clock.advance(1)
    expect(call.signal.aborted).toBe(true)
    expect(provider.run.snapshot().interruption_reason).toBe('PROVIDER_TIMEOUT')
  })

  it('fails an automatic stage into finalization without a pass', async () => {
    const { run, clock } = newRun()
    driveToCandidateChecking(run, clock)
    const check = run.beginOperation('check')
    expect(check.fail('PROJECT_CHECK_CRASHED')).toBe(true)
    expect(run.state()).toBe('finalizing')
    const result = await run.finalize({ originalIntegrity: 'verified' })
    expect(result.outcome).toBe('unverified')
    expect(result.primary_reason).toBe('PROJECT_CHECK_CRASHED')
  })
})
