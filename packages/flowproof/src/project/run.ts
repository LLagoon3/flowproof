import {
  CHECK_PHASES,
  CHECK_STATUSES,
  EXECUTION_LIMITS,
  MANDATORY_CHECK_IDS,
  OPERATION_STATES,
  PROJECT_CLAIM,
  PROJECT_LIMITS,
  RUN_STATES,
  canTransitionRun,
  canUpdateCheckStatus,
  isAutomaticRunState,
  newProjectUuid,
  operationTimeoutMs,
  projectCheckId,
  projectReasonSchema,
  projectUuidSchema,
  reduceProjectOutcome,
} from './contracts.js'
import type { AutomaticOperationKind, CheckPhase, CheckStatus, CleanupState, OriginalIntegrity, RunOutcome, RunState } from './contracts.js'

// The project-live run lifecycle and ownership skeleton (Spec 006 T009). It enforces the declared
// run-state sequence and check statuses; phase-specific work (admission, runtime, capture, model,
// replay, patch) is connected by later stories through `beginOperation`, never replaced here.
//
// Authority: nothing reports a pass before finalization. Only `finalize` reaches `terminal`, after
// joining producers and releasing every owned resource once; a pass additionally requires the full
// path to candidate checking without interruption and every required check passed, and original
// integrity, cleanup and a sticky cancellation override any provisional functional pass.
//
// Budgets: automatic work accrues the 600-second aggregate only in automatic states, and each
// operation has its own phase/provider bound. Human waiting states have no timer and refuse
// automatic work, so demonstration, clarification, interpretation and result review never expire.

export type ProjectRunErrorCode =
  | 'RUN_ID_INVALID'
  | 'RUN_TRANSITION_INVALID'
  | 'RUN_TRANSITION_RESERVED'
  | 'RUN_CLARIFICATION_EXHAUSTED'
  | 'RUN_OPERATION_STATE'
  | 'RUN_OPERATION_PENDING'
  | 'RUN_CHECK_INVALID'
  | 'RUN_CHECK_UNKNOWN'
  | 'RUN_CHECK_RESERVED'
  | 'RUN_CHECK_REGRESSION'
  | 'RUN_RESOURCE_INVALID'
  | 'RUN_OWNERSHIP_CLOSED'

export class ProjectRunError extends Error {
  readonly code: ProjectRunErrorCode

  constructor(code: ProjectRunErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ProjectRunError'
    this.code = code
  }
}

const fail = (code: ProjectRunErrorCode, message: string): never => {
  throw new ProjectRunError(code, message)
}

/** Monotonic clock and timers; injectable so tests can prove human waits accrue nothing. */
export interface LifecycleClock {
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export const systemLifecycleClock: LifecycleClock = Object.freeze({
  now: () => performance.now(),
  setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

/** Checks only finalization may set, from integrity and cleanup evidence. */
export const FINALIZATION_CHECK_IDS = ['original_unchanged', 'cleanup_complete'] as const

export const OWNED_RESOURCE_KINDS = ['container', 'temp-directory', 'target-server', 'browser-context', 'process'] as const
export type OwnedResourceKind = (typeof OWNED_RESOURCE_KINDS)[number]

/** Resource bound for one cleanup step (release or verification); not a product limit. */
export const CLEANUP_STEP_TIMEOUT_MS = 30_000
const MAX_OWNED_RESOURCES = 64
const PROJECT_CHECK_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/
const NOT_EVALUATED = 'CHECK_NOT_EVALUATED'

export interface RunCheck {
  readonly id: string
  readonly status: CheckStatus
  readonly phase: CheckPhase
  readonly reason: string
  readonly evidence_ids: readonly string[]
}

export interface CheckUpdate {
  readonly id: string
  readonly status: CheckStatus
  readonly phase: CheckPhase
  readonly reason: string
  readonly evidence_ids?: readonly string[]
}

export interface OwnedResourceSpec {
  readonly kind: OwnedResourceKind
  readonly label: string
  release(): Promise<void>
  /** True only when the resource is verifiably gone. */
  verifyReleased(): Promise<boolean>
}

export type ResourceCleanup = 'released' | 'recovered' | 'failed' | 'unverified'

export interface RunOperation {
  readonly id: string
  readonly kind: AutomaticOperationKind
  /** Aborted on cancellation, timeout, failure or finalization; producers must stop and settle. */
  readonly signal: AbortSignal
  /** Settles the operation; `apply` runs only if the run still accepts this result. */
  complete(apply?: () => void): boolean
  /** Settles the operation as failed; an accepted failure moves the run to finalization. */
  fail(reason: string): boolean
}

export interface RunSnapshot {
  readonly run_id: string
  readonly state: RunState
  readonly cancel_requested: boolean
  readonly interruption_reason: string | null
  readonly clarifications_used: number
  readonly pending_operations: number
  readonly automatic_elapsed_ms: number
  readonly automatic_remaining_ms: number
  readonly checks: readonly RunCheck[]
  /** Always null before the terminal result. */
  readonly outcome: RunOutcome | null
}

export interface FinalizedProjectRun {
  readonly run_id: string
  readonly outcome: RunOutcome
  readonly claim: typeof PROJECT_CLAIM | null
  readonly primary_reason: string | null
  readonly blockers: readonly string[]
  readonly checks: readonly RunCheck[]
  readonly cancel_requested: boolean
  readonly original_integrity: OriginalIntegrity
  readonly cleanup: CleanupState
  readonly producers_joined: boolean
  readonly late_completions: number
  readonly automatic_elapsed_ms: number
  readonly resources: readonly { readonly id: string; readonly kind: OwnedResourceKind; readonly label: string; readonly cleanup: ResourceCleanup }[]
}

export interface ProjectRunLifecycle {
  readonly runId: string
  state(): RunState
  /** Moves along the declared sequence; `finalizing`/`terminal` are reserved for finalization. */
  transition(to: RunState): void
  beginOperation(kind: AutomaticOperationKind): RunOperation
  /** Returns false (ignored) once cancellation or finalization started. */
  recordCheck(update: CheckUpdate): boolean
  /** Sticky: true while the run is not terminal. */
  requestCancel(): boolean
  own(resource: OwnedResourceSpec): string
  snapshot(): RunSnapshot
  /** Idempotent: the first call decides; later calls return the same terminal result. */
  finalize(input: { readonly originalIntegrity: OriginalIntegrity }): Promise<FinalizedProjectRun>
}

interface OperationEntry {
  readonly controller: AbortController
  settled: boolean
  timer: unknown
}

interface ResourceEntry {
  readonly id: string
  readonly spec: OwnedResourceSpec
}

function validCheckUpdate(update: CheckUpdate): void {
  const evidence = update?.evidence_ids ?? []
  const valid =
    typeof update === 'object' &&
    update !== null &&
    (CHECK_STATUSES as readonly unknown[]).includes(update.status) &&
    (CHECK_PHASES as readonly unknown[]).includes(update.phase) &&
    projectReasonSchema.safeParse(update.reason).success &&
    Array.isArray(evidence) &&
    evidence.length <= 16 &&
    new Set(evidence).size === evidence.length &&
    evidence.every((id) => projectUuidSchema.safeParse(id).success)
  if (!valid) fail('RUN_CHECK_INVALID', 'Check updates use closed statuses, phases, reason codes and evidence IDs.')
}

/** Creates one project-live run attempt. Limits are the fixed Plan limits; nothing overrides them. */
export function createProjectRun(options: {
  readonly runId: string
  readonly projectCheckIds: readonly string[]
  readonly clock?: LifecycleClock
}): ProjectRunLifecycle {
  if (!projectUuidSchema.safeParse(options?.runId).success) fail('RUN_ID_INVALID', 'Run identities are host UUIDs.')
  const projectChecks = options.projectCheckIds
  if (
    !Array.isArray(projectChecks) ||
    projectChecks.length > PROJECT_LIMITS.maxProjectChecks ||
    new Set(projectChecks).size !== projectChecks.length ||
    !projectChecks.every((id) => typeof id === 'string' && id.length <= 48 && PROJECT_CHECK_SLUG.test(id))
  ) {
    fail('RUN_CHECK_INVALID', 'Project checks are unique bounded slugs.')
  }
  const runId = options.runId
  const clock = options.clock ?? systemLifecycleClock
  const requiredIds: readonly string[] = Object.freeze([...MANDATORY_CHECK_IDS, ...projectChecks.map(projectCheckId)])
  const checks = new Map<string, RunCheck>(
    requiredIds.map((id) => [id, Object.freeze({ id, status: 'not_evaluated' as const, phase: 'finalization' as CheckPhase, reason: NOT_EVALUATED, evidence_ids: Object.freeze([]) })]),
  )

  let state: RunState = 'project-selected'
  let cancelRequested = false
  let interruptionReason: string | null = null
  let finalizingFrom: RunState | null = null
  let clarificationsUsed = 0
  let analysisEntries = 0
  let lateCompletions = 0
  let automaticElapsed = 0
  let segmentStart: number | null = null
  let aggregateTimer: unknown = null
  let cleanupStarted = false
  let finalization: Promise<FinalizedProjectRun> | null = null
  let terminalResult: FinalizedProjectRun | null = null
  const operations = new Map<string, OperationEntry>()
  const resources: ResourceEntry[] = []
  const settleWaiters = new Set<() => void>()

  const currentElapsed = (): number => automaticElapsed + (segmentStart === null ? 0 : Math.max(0, clock.now() - segmentStart))
  const pendingCount = (): number => [...operations.values()].filter((entry) => !entry.settled).length
  const accepting = (): boolean => !cancelRequested && state !== 'finalizing' && state !== 'terminal'

  const notifySettled = (): void => {
    if (pendingCount() === 0) for (const waiter of [...settleWaiters]) waiter()
  }

  const stopSegment = (): void => {
    if (segmentStart !== null) {
      automaticElapsed = Math.min(EXECUTION_LIMITS.aggregate_automatic_ms, automaticElapsed + Math.max(0, clock.now() - segmentStart))
      segmentStart = null
    }
    if (aggregateTimer !== null) {
      clock.clearTimer(aggregateTimer)
      aggregateTimer = null
    }
  }

  const abortPending = (reason: string): void => {
    for (const entry of operations.values()) {
      if (entry.timer !== null) {
        clock.clearTimer(entry.timer)
        entry.timer = null
      }
      if (!entry.settled && !entry.controller.signal.aborted) entry.controller.abort(reason)
    }
  }

  const enterFinalizing = (): void => {
    if (state === 'finalizing' || state === 'terminal') return
    stopSegment()
    finalizingFrom = state
    state = 'finalizing'
  }

  const interrupt = (reason: string): void => {
    if (!accepting()) return
    interruptionReason ??= reason
    abortPending(reason)
    enterFinalizing()
  }

  const enterState = (next: RunState): void => {
    stopSegment()
    state = next
    if (isAutomaticRunState(next)) {
      const remaining = EXECUTION_LIMITS.aggregate_automatic_ms - automaticElapsed
      if (remaining <= 0) {
        interrupt('AUTOMATIC_BUDGET_EXCEEDED')
        return
      }
      segmentStart = clock.now()
      aggregateTimer = clock.setTimer(() => {
        aggregateTimer = null
        interrupt('AUTOMATIC_BUDGET_EXCEEDED')
      }, remaining)
    }
  }

  const transition = (to: RunState): void => {
    if (!(RUN_STATES as readonly unknown[]).includes(to)) fail('RUN_TRANSITION_INVALID', 'Unknown run state.')
    if (to === 'finalizing' || to === 'terminal') fail('RUN_TRANSITION_RESERVED', 'Only cancellation, failure or finalize enter finalization.')
    if (!canTransitionRun(state, to)) fail('RUN_TRANSITION_INVALID', `The run cannot move from ${state} to ${to}.`)
    if (pendingCount() > 0) fail('RUN_OPERATION_PENDING', 'Automatic work must settle before the run leaves its state.')
    if (to === 'clarification-required' && clarificationsUsed >= 1) fail('RUN_CLARIFICATION_EXHAUSTED', 'At most one clarification is allowed.')
    if (to === 'analyzing' && analysisEntries >= PROJECT_LIMITS.maxAnalysisCalls) fail('RUN_CLARIFICATION_EXHAUSTED', 'At most two analyses are allowed.')
    if (to === 'clarification-required') clarificationsUsed += 1
    if (to === 'analyzing') analysisEntries += 1
    enterState(to)
  }

  const beginOperation = (kind: AutomaticOperationKind): RunOperation => {
    if (!accepting() || !isAutomaticRunState(state) || !OPERATION_STATES[state].includes(kind)) {
      return fail('RUN_OPERATION_STATE', 'Automatic work runs only in its own automatic state.')
    }
    const id = newProjectUuid()
    const entry: OperationEntry = { controller: new AbortController(), settled: false, timer: null }
    entry.timer = clock.setTimer(() => {
      entry.timer = null
      if (!entry.settled) interrupt(kind === 'provider' ? 'PROVIDER_TIMEOUT' : 'PHASE_TIMEOUT')
    }, operationTimeoutMs(kind))
    operations.set(id, entry)

    const settle = (): boolean => {
      if (entry.settled) return false
      entry.settled = true
      if (entry.timer !== null) {
        clock.clearTimer(entry.timer)
        entry.timer = null
      }
      const accepted = accepting() && !entry.controller.signal.aborted
      if (!accepted) lateCompletions += 1
      notifySettled()
      return accepted
    }

    return Object.freeze({
      id,
      kind,
      signal: entry.controller.signal,
      complete(apply?: () => void): boolean {
        if (entry.settled) return false
        const accepted = settle()
        if (accepted) apply?.()
        return accepted
      },
      fail(reason: string): boolean {
        if (entry.settled) return false
        const accepted = settle()
        if (accepted) interrupt(projectReasonSchema.safeParse(reason).success ? reason : 'OPERATION_FAILED')
        return accepted
      },
    })
  }

  const recordCheck = (update: CheckUpdate): boolean => {
    const id = update?.id
    if (typeof id !== 'string' || !checks.has(id)) return fail('RUN_CHECK_UNKNOWN', 'Only required checks of this run can be recorded.')
    if ((FINALIZATION_CHECK_IDS as readonly string[]).includes(id)) return fail('RUN_CHECK_RESERVED', 'Integrity and cleanup checks are set only by finalization.')
    validCheckUpdate(update)
    if (!accepting()) return false
    const current = checks.get(id) as RunCheck
    if (!canUpdateCheckStatus(current.status, update.status)) return fail('RUN_CHECK_REGRESSION', 'A check result never regresses.')
    checks.set(
      id,
      Object.freeze({ id, status: update.status, phase: update.phase, reason: update.reason, evidence_ids: Object.freeze([...(update.evidence_ids ?? [])]) }),
    )
    return true
  }

  const requestCancel = (): boolean => {
    if (state === 'terminal') return false
    cancelRequested = true
    abortPending('RUN_CANCELED')
    enterFinalizing()
    return true
  }

  const own = (spec: OwnedResourceSpec): string => {
    const valid =
      typeof spec === 'object' &&
      spec !== null &&
      (OWNED_RESOURCE_KINDS as readonly unknown[]).includes(spec.kind) &&
      typeof spec.label === 'string' &&
      RESOURCE_LABEL.test(spec.label) &&
      typeof spec.release === 'function' &&
      typeof spec.verifyReleased === 'function'
    if (!valid) return fail('RUN_RESOURCE_INVALID', 'Owned resources have a closed kind, safe label, release and verification.')
    if (cleanupStarted || state === 'terminal') return fail('RUN_OWNERSHIP_CLOSED', 'Ownership closed when cleanup started.')
    if (resources.length >= MAX_OWNED_RESOURCES) return fail('RUN_RESOURCE_INVALID', 'The ownership manifest is full.')
    const id = newProjectUuid()
    resources.push({ id, spec })
    return id
  }

  /** Resolves true when every producer settled, false after the stop grace period. */
  const joinProducers = (): Promise<boolean> => {
    if (pendingCount() === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (joined: boolean): void => {
        settleWaiters.delete(waiter)
        clock.clearTimer(timer)
        resolve(joined)
      }
      const waiter = (): void => done(true)
      settleWaiters.add(waiter)
      const timer = clock.setTimer(() => done(pendingCount() === 0), EXECUTION_LIMITS.stop_grace_ms)
    })
  }

  /** Runs one cleanup step bounded by the step timeout; never throws. */
  const bounded = async <T>(step: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    let timer: unknown = null
    const timeout = new Promise<{ ok: false }>((resolve) => {
      timer = clock.setTimer(() => resolve({ ok: false }), CLEANUP_STEP_TIMEOUT_MS)
    })
    try {
      return await Promise.race([
        Promise.resolve()
          .then(step)
          .then(
            (value) => ({ ok: true as const, value }),
            () => ({ ok: false as const }),
          ),
        timeout,
      ])
    } finally {
      clock.clearTimer(timer)
    }
  }

  /** Releases every owned resource once, newest first, with one retry. */
  const cleanup = async (): Promise<Array<{ readonly entry: ResourceEntry; readonly cleanup: ResourceCleanup }>> => {
    cleanupStarted = true
    const outcomes: Array<{ readonly entry: ResourceEntry; readonly cleanup: ResourceCleanup }> = []
    for (const entry of [...resources].reverse()) {
      let released = await bounded(() => entry.spec.release())
      let recovered = false
      if (!released.ok) {
        released = await bounded(() => entry.spec.release())
        recovered = released.ok
      }
      if (!released.ok) {
        outcomes.push({ entry, cleanup: 'failed' })
        continue
      }
      const verified = await bounded(() => entry.spec.verifyReleased())
      const result: ResourceCleanup = !verified.ok ? 'unverified' : verified.value !== true ? 'failed' : recovered ? 'recovered' : 'released'
      outcomes.push({ entry, cleanup: result })
    }
    return outcomes
  }

  const aggregateCleanup = (outcomes: readonly { readonly cleanup: ResourceCleanup }[], joined: boolean): CleanupState => {
    const states = outcomes.map((outcome) => outcome.cleanup)
    if (states.includes('failed')) return 'failed'
    if (!joined || states.includes('unverified')) return 'unverified'
    return states.includes('recovered') ? 'recovered' : 'complete'
  }

  const runFinalization = async (originalIntegrity: OriginalIntegrity): Promise<FinalizedProjectRun> => {
    const joined = await joinProducers()
    const outcomes = await cleanup()
    const cleanupState = aggregateCleanup(outcomes, joined)

    checks.set(
      'original_unchanged',
      Object.freeze({
        id: 'original_unchanged',
        status: originalIntegrity === 'verified' ? 'passed' : originalIntegrity === 'changed' ? 'failed' : 'not_evaluated',
        phase: 'finalization',
        reason: originalIntegrity === 'verified' ? 'ORIGINAL_UNCHANGED' : originalIntegrity === 'changed' ? 'ORIGINAL_CHANGED' : 'ORIGINAL_UNVERIFIED',
        evidence_ids: Object.freeze([]),
      } satisfies RunCheck),
    )
    const cleanupPassed = cleanupState === 'complete' || cleanupState === 'recovered'
    checks.set(
      'cleanup_complete',
      Object.freeze({
        id: 'cleanup_complete',
        status: cleanupPassed ? 'passed' : cleanupState === 'failed' ? 'failed' : 'not_evaluated',
        phase: 'finalization',
        reason: cleanupPassed ? 'CLEANUP_COMPLETE' : cleanupState === 'failed' ? 'CLEANUP_INCOMPLETE' : 'CLEANUP_UNVERIFIED',
        evidence_ids: Object.freeze([]),
      } satisfies RunCheck),
    )

    // The interruption explains the first obligation that was never evaluated.
    if (interruptionReason !== null) {
      const first = requiredIds.map((id) => checks.get(id) as RunCheck).find((check) => check.status === 'not_evaluated' && check.reason === NOT_EVALUATED)
      if (first !== undefined) checks.set(first.id, Object.freeze({ ...first, reason: interruptionReason }))
    }

    const ordered = Object.freeze(requiredIds.map((id) => checks.get(id) as RunCheck))
    let reduced: { outcome: RunOutcome; primary_reason: string | null; blockers: readonly string[] } = reduceProjectOutcome({
      checks: ordered,
      cancel_requested: cancelRequested,
      original_integrity: originalIntegrity,
      cleanup: cleanupState,
    })
    const pathComplete = finalizingFrom === 'candidate-checking' && interruptionReason === null && !cancelRequested
    if (reduced.outcome === 'passed' && !pathComplete) {
      reduced = { outcome: 'unverified', primary_reason: interruptionReason ?? 'RUN_PATH_INCOMPLETE', blockers: Object.freeze([]) }
    }

    const result: FinalizedProjectRun = Object.freeze({
      run_id: runId,
      outcome: reduced.outcome,
      claim: reduced.outcome === 'passed' ? PROJECT_CLAIM : null,
      primary_reason: reduced.primary_reason,
      blockers: Object.freeze([...reduced.blockers]),
      checks: ordered,
      cancel_requested: cancelRequested,
      original_integrity: originalIntegrity,
      cleanup: cleanupState,
      producers_joined: joined,
      late_completions: lateCompletions,
      automatic_elapsed_ms: automaticElapsed,
      resources: Object.freeze(
        outcomes.map(({ entry, cleanup: resourceCleanup }) => Object.freeze({ id: entry.id, kind: entry.spec.kind, label: entry.spec.label, cleanup: resourceCleanup })),
      ),
    })
    terminalResult = result
    state = 'terminal'
    return result
  }

  const finalize = (input: { readonly originalIntegrity: OriginalIntegrity }): Promise<FinalizedProjectRun> => {
    if (finalization !== null) return finalization
    const integrity: OriginalIntegrity = (['verified', 'changed', 'unverified'] as const).includes(input?.originalIntegrity) ? input.originalIntegrity : 'unverified'
    // Finalizing with unsettled work is an interruption, never a pass.
    if (pendingCount() > 0) interrupt('RUN_FINALIZED_EARLY')
    abortPending(cancelRequested ? 'RUN_CANCELED' : 'RUN_FINALIZING')
    enterFinalizing()
    finalization = runFinalization(integrity)
    return finalization
  }

  return Object.freeze({
    runId,
    state: () => state,
    transition,
    beginOperation,
    recordCheck,
    requestCancel,
    own,
    finalize,
    snapshot(): RunSnapshot {
      const elapsed = Math.min(EXECUTION_LIMITS.aggregate_automatic_ms, currentElapsed())
      return Object.freeze({
        run_id: runId,
        state,
        cancel_requested: cancelRequested,
        interruption_reason: interruptionReason,
        clarifications_used: clarificationsUsed,
        pending_operations: pendingCount(),
        automatic_elapsed_ms: elapsed,
        automatic_remaining_ms: EXECUTION_LIMITS.aggregate_automatic_ms - elapsed,
        checks: Object.freeze(requiredIds.map((id) => checks.get(id) as RunCheck)),
        outcome: terminalResult?.outcome ?? null,
      })
    },
  })
}
