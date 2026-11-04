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
import { createHash } from 'node:crypto'
import type { RedactedValueRegistry } from '../capture/projectPrivacy.js'
import type { ProjectRecorder, SealedCapture } from '../capture/projectRecorder.js'
import { REDACTED } from '../evidence/sanitize.js'
import type { ProjectModelErrorCode, ProjectModelSession } from '../model/projectClient.js'
import { buildProjectAnalysisPrompt } from '../model/projectPrompt.js'
import type { ProjectPromptErrorCode, PromptSourceFile } from '../model/projectPrompt.js'
import { InterpretationSchema, PROJECT_SCHEMA_VERSION } from './contracts.js'
import type { CaptureState, Interpretation } from './contracts.js'

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

// ---------------------------------------------------------------------------------------
// Demonstration capture and explicit analysis (T029 service foundation)
// ---------------------------------------------------------------------------------------

/**
 * The launcher-owned recorder as the demonstration service drives it. Observations come only from
 * the host recorder bound to the actual target frame (see `demonstrationRecorderOf`); nothing the
 * browser uploads becomes a report.
 */
export interface DemonstrationRecorder {
  readonly captureId: string
  finish(): Promise<SealedCapture>
  discard(): Promise<void>
  detach(): Promise<void>
  /** Claims the sealed ready report for analysis (Discard is refused afterwards) with its redaction registry. */
  claim(): Promise<{ readonly sealed: SealedCapture; readonly registry: RedactedValueRegistry }>
}

/** Adapts the merged S3 recorder started on the launcher-owned target frame. */
export function demonstrationRecorderOf(recorder: ProjectRecorder): DemonstrationRecorder {
  return Object.freeze({
    captureId: recorder.session.captureId,
    finish: () => recorder.finish(),
    discard: () => recorder.discard(),
    detach: () => recorder.detach(),
    claim: async () => {
      const sealed = recorder.session.claimForAnalysis()
      return { sealed, registry: recorder.session.analysisRegistry() }
    },
  })
}

export type DemonstrationErrorCode =
  | 'CAPTURE_ACTIVE'
  | 'CAPTURE_STATE'
  | 'CAPTURE_UNKNOWN'
  | 'CAPTURE_NOT_READY'
  | 'CAPTURE_BINDING_MISMATCH'
  | 'CAPTURE_FAILED'
  | 'CAPTURE_INVALIDATED'
  | 'CAPTURE_DISCARD_REFUSED'
  | 'CLARIFICATION_STATE'
  | 'CLARIFICATION_STALE'
  | 'RUN_NOT_ACCEPTING'
  | 'SOURCES_UNAVAILABLE'
  | 'ANALYSIS_FAILED'
  | 'INTERPRETATION_REDACTED_VALUE'
  | 'INTERPRETATION_INVALID'
  | ProjectPromptErrorCode
  | ProjectModelErrorCode
export type DemonstrationOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: DemonstrationErrorCode }

/**
 * Where the current report is: `claimed` was handed to analysis and is locked but no provider request
 * carried it; `submitted` means a provider request with its bytes left the host. Neither is ever
 * reported as deleted.
 */
export type DemonstrationReportState = 'none' | 'recording' | 'sealed' | 'claimed' | 'submitted'

export interface DemonstrationView {
  readonly state: RunState
  readonly capture_id: string | null
  readonly report: DemonstrationReportState
  readonly report_sha256: string | null
  readonly interpretation: Interpretation | null
  readonly question_id: string | null
}

export interface ProjectDemonstration {
  start(): Promise<DemonstrationOutcome<{ readonly capture_id: string }>>
  finish(captureId: string): Promise<DemonstrationOutcome<{ readonly capture_id: string; readonly report_sha256: string | null; readonly state: CaptureState }>>
  discard(captureId: string): Promise<DemonstrationOutcome<{ readonly capture_id: string }>>
  /** The only path that submits a report: explicit, once per sealed report. */
  analyze(captureId: string, input: { readonly description: string | null }): Promise<DemonstrationOutcome<{ readonly interpretation: Interpretation }>>
  /** The single explicit clarification answer to the current question. */
  clarify(questionId: string, answer: string): Promise<DemonstrationOutcome<{ readonly interpretation: Interpretation }>>
  /**
   * Settings/reset change: revokes every pending operation at once and deletes unclaimed evidence;
   * once a report was claimed it cancels. It never waits on a pending producer: revoked work
   * discards what it produced when it settles, and until then the service stays busy, so nothing is
   * reused before the old producer settled.
   */
  invalidate(): Promise<void>
  /** Sticky run cancellation; a response arriving later is discarded. */
  cancel(): void
  view(): DemonstrationView
}

export interface ProjectDemonstrationOptions {
  readonly lifecycle: ProjectRunLifecycle
  readonly configurationId: string
  /** Starts the host recorder on the launcher-owned target frame of this run. */
  readonly startRecorder: () => Promise<DemonstrationRecorder>
  /** Admitted `src/` text and its allow-list from the frozen baseline snapshot. */
  readonly loadSources: () => Promise<{ readonly sources: readonly PromptSourceFile[]; readonly admitted: ReadonlySet<string> }>
  /** The merged S5 per-run model session bound to the same run. */
  readonly model: ProjectModelSession
}

/** Values a replay or condition would have to type or compare; a redacted one can never be replayed. */
function replaysRedacted(result: Interpretation['result'], registry: RedactedValueRegistry): boolean {
  if (result.status !== 'ready') return false
  const texts = [
    ...result.replay.actions.flatMap((action) =>
      action.op === 'fill' || action.op === 'select' ? [action.value] : action.op === 'wait' && action.until.kind === 'text' ? [action.until.text] : [],
    ),
    ...result.expected_conditions.flatMap((condition) => (condition.kind === 'text' ? [condition.text] : condition.kind === 'form-value' ? [condition.value] : [])),
  ]
  return texts.some((text) => text.includes(REDACTED) || registry.contains(text))
}

interface ClaimedReport {
  readonly sealed: SealedCapture
  readonly registry: RedactedValueRegistry
  readonly sources: readonly PromptSourceFile[]
  readonly admitted: ReadonlySet<string>
  readonly description: string | null
}

export function createProjectDemonstration(options: ProjectDemonstrationOptions): ProjectDemonstration {
  const { lifecycle, configurationId, startRecorder, loadSources, model } = options
  const runId = lifecycle.runId
  if (model.run_id !== runId || !projectUuidSchema.safeParse(configurationId).success) fail('RUN_ID_INVALID', 'The model session and configuration must belong to this run.')
  let recorder: DemonstrationRecorder | null = null
  let sealed: SealedCapture | null = null
  let claimed: ClaimedReport | null = null
  let interpretation: Interpretation | null = null
  let report: DemonstrationReportState = 'none'
  let busy = false
  // Every invalidation or cancellation bumps the generation; work started under an older one is
  // revoked after each await, discards what it produced and never publishes a success.
  let generation = 0

  const refuse = (code: DemonstrationErrorCode): { readonly ok: false; readonly code: DemonstrationErrorCode } => ({ ok: false, code })
  const accepting = (): boolean => {
    const state = lifecycle.state()
    return state !== 'finalizing' && state !== 'terminal'
  }
  const owned = (captureId: string): boolean => recorder !== null && recorder.captureId === captureId
  const revoked = (gen: number): boolean => gen !== generation || !accepting()
  const stopped = (): DemonstrationErrorCode => (accepting() ? 'CAPTURE_INVALIDATED' : 'RUN_NOT_ACCEPTING')
  const exclusive = <T>(work: (gen: number) => Promise<T>): Promise<T> => {
    busy = true
    return work(generation).finally(() => {
      busy = false
    })
  }

  /** True only when the recorder itself confirmed the discard; otherwise it is only detached. */
  const retire = async (target: DemonstrationRecorder): Promise<boolean> => {
    try {
      await target.discard()
      return true
    } catch {
      await target.detach().catch(() => undefined)
      return false
    }
  }

  /** Revokes the current unclaimed recorder: deletes its evidence and returns the run to demonstration. */
  const drop = async (): Promise<boolean> => {
    const current = recorder
    recorder = null
    sealed = null
    report = 'none'
    const discarded = current === null ? true : await retire(current)
    const state = lifecycle.state()
    if (state === 'recording' || state === 'capture-ready') lifecycle.transition('demonstration-ready')
    return discarded
  }

  function cancel(): void {
    generation += 1
    lifecycle.requestCancel()
    model.cancel()
    const current = recorder
    if (current !== null && claimed === null) void retire(current)
    else if (current !== null) void current.detach().catch(() => undefined)
  }

  async function analyzeOnce(gen: number, clarification: { readonly prior: Interpretation; readonly answer: string } | null): Promise<DemonstrationOutcome<{ readonly interpretation: Interpretation }>> {
    const claim = claimed!
    // The analysis state and its provider operation start before the prompt is built, so a prompt
    // that cannot be built is an explicit fail-closed stop of this claimed, unsent report.
    let operation: RunOperation
    try {
      lifecycle.transition('analyzing')
      operation = lifecycle.beginOperation('provider')
    } catch {
      if (accepting()) cancel()
      return refuse('RUN_NOT_ACCEPTING')
    }
    const onAbort = (): void => model.cancel()
    operation.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const answerId = newProjectUuid()
      const built = buildProjectAnalysisPrompt({
        run_id: runId,
        invocation_id: newProjectUuid(),
        question_id: newProjectUuid(),
        capture: claim.sealed.capture,
        description: claim.description,
        sources: claim.sources,
        admitted_source_paths: claim.admitted,
        images: claim.sealed.artifacts,
        registry: claim.registry,
        clarification: clarification === null ? null : { prior: clarification.prior, answer_id: answerId, answer: clarification.answer },
      })
      if (!built.ok) {
        operation.fail(built.error.code)
        return refuse(built.error.code)
      }
      let result: Awaited<ReturnType<ProjectModelSession['analyze']>>
      try {
        result = await model.analyze(built.value)
      } catch {
        const cancelled = operation.signal.aborted
        operation.fail('ANALYSIS_FAILED')
        return refuse(cancelled ? 'RUN_NOT_ACCEPTING' : 'ANALYSIS_FAILED')
      }
      if ((result.invocation?.request_bytes ?? 0) > 0) report = 'submitted'
      if (!result.ok) {
        operation.fail(result.error.code)
        return refuse(result.error.code)
      }
      if (replaysRedacted(result.output, claim.registry)) {
        operation.fail('INTERPRETATION_REDACTED_VALUE')
        return refuse('INTERPRETATION_REDACTED_VALUE')
      }
      const record = InterpretationSchema.safeParse({
        schema_version: PROJECT_SCHEMA_VERSION,
        interpretation_id: newProjectUuid(),
        run_id: runId,
        invocation_id: result.invocation.invocation_id,
        capture_id: claim.sealed.capture.capture_id,
        report_sha256: claim.sealed.report_sha256,
        input_sha256: result.invocation.input_sha256,
        analysis_attempt: clarification === null ? 1 : 2,
        clarification:
          clarification === null || clarification.prior.result.status !== 'clarify'
            ? null
            : { question_id: clarification.prior.result.question.question_id, answer_id: answerId, answer_sha256: createHash('sha256').update(clarification.answer).digest('hex') },
        result: result.output,
      })
      if (!record.success) {
        operation.fail('INTERPRETATION_INVALID')
        return refuse('INTERPRETATION_INVALID')
      }
      if (record.data.result.status === 'unsupported') {
        // An explicit unsupported interpretation stops the run; it is shown, never replayed.
        if (!operation.fail('INTERPRETATION_UNSUPPORTED') || gen !== generation) return refuse('RUN_NOT_ACCEPTING')
        interpretation = record.data
        return { ok: true, value: { interpretation: record.data } }
      }
      // A late completion after cancellation or revocation is never accepted.
      if (operation.signal.aborted || gen !== generation || !operation.complete() || !accepting()) return refuse('RUN_NOT_ACCEPTING')
      interpretation = record.data
      lifecycle.transition(record.data.result.status === 'clarify' ? 'clarification-required' : 'interpretation-ready')
      return { ok: true, value: { interpretation: record.data } }
    } finally {
      operation.signal.removeEventListener('abort', onAbort)
    }
  }

  return Object.freeze({
    async start() {
      if (!accepting()) return refuse('RUN_NOT_ACCEPTING')
      if (busy || recorder !== null) return refuse('CAPTURE_ACTIVE')
      if (lifecycle.state() !== 'demonstration-ready') return refuse('CAPTURE_STATE')
      return exclusive(async (gen) => {
        let next: DemonstrationRecorder
        try {
          next = await startRecorder()
        } catch {
          return refuse(revoked(gen) ? stopped() : 'CAPTURE_FAILED')
        }
        if (revoked(gen)) {
          await retire(next)
          return refuse(stopped())
        }
        recorder = next
        report = 'recording'
        lifecycle.transition('recording')
        return { ok: true as const, value: { capture_id: next.captureId } }
      })
    },

    async finish(captureId: string) {
      if (!accepting()) return refuse('RUN_NOT_ACCEPTING')
      if (!owned(captureId)) return refuse('CAPTURE_UNKNOWN')
      if (sealed !== null) return { ok: true as const, value: { capture_id: captureId, report_sha256: sealed.report_sha256, state: 'ready' as CaptureState } }
      if (busy) return refuse('CAPTURE_ACTIVE')
      const current = recorder!
      return exclusive(async (gen) => {
        let result: SealedCapture
        try {
          result = await current.finish()
        } catch {
          if (revoked(gen)) {
            await retire(current)
            return refuse(stopped())
          }
          await drop()
          return refuse('CAPTURE_FAILED')
        }
        if (revoked(gen) || recorder !== current) {
          await retire(current)
          return refuse(stopped())
        }
        const capture = result.capture
        const bound =
          capture.capture_id === captureId &&
          capture.run_id === runId &&
          capture.configuration_id === configurationId &&
          (capture.state !== 'ready' || capture.seal?.report_sha256 === result.report_sha256)
        if (!bound) {
          await drop()
          return refuse('CAPTURE_BINDING_MISMATCH')
        }
        if (capture.state !== 'ready') {
          // Incomplete or unsupported: disclosed, never presented as a ready report.
          await drop()
          return { ok: true as const, value: { capture_id: captureId, report_sha256: null, state: capture.state } }
        }
        sealed = result
        report = 'sealed'
        lifecycle.transition('capture-ready')
        return { ok: true as const, value: { capture_id: captureId, report_sha256: result.report_sha256, state: capture.state } }
      })
    },

    async discard(captureId: string) {
      if (!accepting()) return refuse('RUN_NOT_ACCEPTING')
      if (!owned(captureId)) return refuse('CAPTURE_UNKNOWN')
      if (claimed !== null) return refuse('CAPTURE_STATE')
      if (busy) return refuse('CAPTURE_ACTIVE')
      if (!(await drop())) {
        // Not confirmed deleted: never reported as discarded; the run stops instead.
        cancel()
        return refuse('CAPTURE_DISCARD_REFUSED')
      }
      return { ok: true as const, value: { capture_id: captureId } }
    },

    async analyze(captureId: string, input: { readonly description: string | null }) {
      if (!accepting()) return refuse('RUN_NOT_ACCEPTING')
      if (!owned(captureId)) return refuse('CAPTURE_UNKNOWN')
      if (claimed !== null || sealed === null || lifecycle.state() !== 'capture-ready') return refuse('CAPTURE_STATE')
      if (busy) return refuse('CAPTURE_ACTIVE')
      const current = recorder!
      const expected = sealed
      const description = input?.description ?? null
      return exclusive(async (gen) => {
        // Sources are loaded before the irreversible claim, so their failure leaves an unclaimed report.
        let loaded: Awaited<ReturnType<ProjectDemonstrationOptions['loadSources']>>
        try {
          loaded = await loadSources()
        } catch {
          return refuse(revoked(gen) ? stopped() : 'SOURCES_UNAVAILABLE')
        }
        if (revoked(gen) || recorder !== current) return refuse(stopped())
        let claim: Awaited<ReturnType<DemonstrationRecorder['claim']>>
        try {
          claim = await current.claim()
        } catch {
          return refuse(revoked(gen) ? stopped() : 'CAPTURE_NOT_READY')
        }
        // From here the report is claimed: it is never deleted as if unsent, and any stop is fail-closed.
        claimed = Object.freeze({ sealed: claim.sealed, registry: claim.registry, sources: loaded.sources, admitted: loaded.admitted, description })
        report = 'claimed'
        if (revoked(gen)) {
          if (accepting()) cancel()
          return refuse('RUN_NOT_ACCEPTING')
        }
        if (claim.sealed.report_sha256 !== expected.report_sha256) {
          cancel()
          return refuse('CAPTURE_BINDING_MISMATCH')
        }
        return analyzeOnce(gen, null)
      })
    },

    async clarify(questionId: string, answer: string) {
      if (!accepting()) return refuse('RUN_NOT_ACCEPTING')
      const prior = interpretation
      if (lifecycle.state() !== 'clarification-required' || claimed === null || prior === null || prior.result.status !== 'clarify') return refuse('CLARIFICATION_STATE')
      if (questionId !== prior.result.question.question_id) return refuse('CLARIFICATION_STALE')
      if (busy) return refuse('CAPTURE_ACTIVE')
      return exclusive((gen) => analyzeOnce(gen, { prior, answer }))
    },

    async invalidate() {
      if (!accepting()) return
      generation += 1
      if (claimed !== null) cancel()
      else if (recorder !== null && !(await drop())) cancel()
    },

    cancel: () => cancel(),

    view(): DemonstrationView {
      const current = interpretation
      return Object.freeze({
        state: lifecycle.state(),
        capture_id: recorder?.captureId ?? null,
        report,
        report_sha256: sealed?.report_sha256 ?? claimed?.sealed.report_sha256 ?? null,
        interpretation: current,
        question_id: current?.result.status === 'clarify' ? current.result.question.question_id : null,
      })
    },
  })
}
