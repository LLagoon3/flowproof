import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'

import { sanitizeText } from '../evidence/sanitize.js'
import { createTaskDocument } from './contracts.js'
import type {
  CleanupReasonCode,
  CleanupResult,
  EditingSessionHandle,
  EditingSessionResult,
  ExecutionOutcome,
  IsolationObservation,
  OwnedResourceCategory,
  ResolvedEditingSessionRequest,
} from './contracts.js'
import { containerName, createDockerCli } from './dockerCli.js'
import type { AttachedContainer, ContainerState, DockerAdapter } from './dockerCli.js'
import type { RuntimeProfileRegistry } from './runtimeProfile.js'
import { createWorkspaceManager } from './workspace.js'
import type { OriginalIntegrity, SessionWorkspace, WorkspaceDisposal, WorkspaceManager } from './workspace.js'

// The editing-session lifecycle owner. It validates the request synchronously, then prepares the
// standalone clone, creates and attaches the constrained container, and finalizes exactly once.
// Process exit, timeout, cancellation, an AbortSignal, and startup failure converge on one atomic
// terminal selection: the first cause wins and every caller awaits the same finalization. Cleanup
// removes the exact container and the manifest paths with a bounded retry, then compares the
// original repository with its pre-session snapshot before the single result resolves. The
// session never enumerates, opens, or analyzes agent-authored workspace contents.

export interface EditingSessionDependencies {
  /** The trusted profile registry; requests can only name one of its profiles. */
  readonly profiles: RuntimeProfileRegistry
  readonly docker?: DockerAdapter
  readonly workspaces?: WorkspaceManager
  /** Monotonic milliseconds. */
  readonly clock?: () => number
}

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

export const LIFECYCLE_PHASES = ['requested', 'preparing', 'starting', 'running', 'stopping', 'cleaning', 'finished'] as const
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number]

/** Legal transitions. Startup and early cancellation skip to cleaning; an exited process skips stopping. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecyclePhase, readonly LifecyclePhase[]>> = Object.freeze({
  requested: Object.freeze(['preparing'] as const),
  preparing: Object.freeze(['starting', 'cleaning'] as const),
  starting: Object.freeze(['running', 'cleaning'] as const),
  running: Object.freeze(['stopping', 'cleaning'] as const),
  stopping: Object.freeze(['cleaning'] as const),
  cleaning: Object.freeze(['finished'] as const),
  finished: Object.freeze([] as const),
})

/** Why execution ended; mapped to the reported execution outcome during finalization. */
export type TerminalCause = 'exited' | 'startup_failed' | 'timed_out' | 'cancelled'

export class LifecycleError extends Error {
  constructor(from: LifecyclePhase, to: LifecyclePhase) {
    super(`EDITING_LIFECYCLE_INVALID: ${from} cannot move to ${to}.`)
    this.name = 'LifecycleError'
  }
}

export interface SessionLifecycle {
  readonly phase: LifecyclePhase
  readonly history: readonly LifecyclePhase[]
  /** The first selected terminal cause, or null while execution continues. */
  readonly terminalCause: TerminalCause | null
  /** Resolves with the first selected terminal cause. */
  readonly terminal: Promise<TerminalCause>
  transition(to: LifecyclePhase): void
  /** Selects `cause` only when no cause was selected yet; true when this call won. */
  selectTerminal(cause: TerminalCause): boolean
}

export function createSessionLifecycle(): SessionLifecycle {
  let phase: LifecyclePhase = 'requested'
  const history: LifecyclePhase[] = [phase]
  let terminalCause: TerminalCause | null = null
  let settle!: (cause: TerminalCause) => void
  const terminal = new Promise<TerminalCause>((resolve) => {
    settle = resolve
  })
  return {
    get phase() {
      return phase
    },
    get history() {
      return Object.freeze([...history])
    },
    get terminalCause() {
      return terminalCause
    },
    terminal,
    transition(to: LifecyclePhase): void {
      if (!LIFECYCLE_TRANSITIONS[phase].includes(to)) throw new LifecycleError(phase, to)
      phase = to
      history.push(to)
    },
    selectTerminal(cause: TerminalCause): boolean {
      if (terminalCause !== null) return false
      terminalCause = cause
      settle(cause)
      return true
    },
  }
}

// ---------------------------------------------------------------------------------------
// Bounded waits and cleanup
// ---------------------------------------------------------------------------------------

/** After the grace period, a hung `docker stop` is abandoned in favor of forced removal. */
const STOP_MARGIN_MS = 2_000
/** Bounded wait for the attached CLI client to exit after its container stopped or was removed. */
const EXIT_WAIT_MS = 5_000
/** Cleanup attempts, including the first; the retry delay grows linearly. */
const CLEANUP_ATTEMPTS = 3
const CLEANUP_RETRY_DELAY_MS = 250

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** True when `promise` settles successfully within `ms`; never rejects and never leaves a timer. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(
      () => true,
      () => false,
    ), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Assembles the cleanup proof from what actually remains. */
function cleanupResult(input: {
  readonly containerRemoved: boolean
  readonly disposal: WorkspaceDisposal
  readonly integrity: OriginalIntegrity
  readonly retried: boolean
}): CleanupResult {
  const { containerRemoved, disposal, integrity, retried } = input
  const remaining: OwnedResourceCategory[] = []
  if (!containerRemoved) remaining.push('container')
  if (!disposal.taskDocumentRemoved) remaining.push('task_document')
  if (!disposal.workspaceRemoved || (!disposal.sessionRootRemoved && disposal.taskDocumentRemoved)) remaining.push('workspace')
  if (!integrity.unchanged) remaining.push('original_repository')
  const reasons: Record<OwnedResourceCategory, CleanupReasonCode> = {
    container: 'CONTAINER_NOT_REMOVED',
    task_document: 'TASK_DOCUMENT_NOT_REMOVED',
    workspace: 'WORKSPACE_NOT_REMOVED',
    original_repository: integrity.verified ? 'ORIGINAL_REPOSITORY_CHANGED' : 'ORIGINAL_REPOSITORY_UNVERIFIED',
  }
  const first = remaining[0]
  return Object.freeze({
    status: first !== undefined ? 'failed' : retried ? 'recovered' : 'complete',
    containerRemoved,
    workspaceRemoved: disposal.sessionRootRemoved,
    originalRepositoryUnchanged: integrity.unchanged,
    reasonCode: first !== undefined ? reasons[first] : retried ? 'CLEANUP_RETRIED' : null,
    remainingOwnedResources: Object.freeze(remaining),
  })
}

// ---------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------

/** Stable startup-failure codes; diagnostics never carry Docker or Git output. */
const STARTUP_MESSAGES = {
  REPOSITORY_UNAVAILABLE: 'the repository root is not a readable Git worktree',
  REVISION_UNAVAILABLE: 'the selected revision is not a commit in the repository',
  SESSION_ROOT_INSIDE_REPOSITORY: 'session state would live inside the original repository',
  SESSION_ROOT_UNSAFE: 'the temporary root cannot hold session state safely',
  WORKSPACE_PREPARE_FAILED: 'the disposable workspace could not be prepared',
  DOCKER_CAPABILITY_MISSING: 'the Docker daemon cannot enforce the required isolation',
  DOCKER_CREATE_FAILED: 'the session container could not be created',
  DOCKER_START_FAILED: 'the session container could not start',
  CONTROLLER_ROOT_UNSUPPORTED: 'a root controller cannot provide a non-root agent identity',
  SESSION_INTERNAL_ERROR: 'the session failed unexpectedly',
} as const
type StartupCode = keyof typeof STARTUP_MESSAGES

class StartupFailure extends Error {
  constructor(readonly startupCode: StartupCode) {
    super(startupCode)
  }
}

const startupCodeOf = (error: unknown): StartupCode => {
  if (error instanceof StartupFailure) return error.startupCode
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && Object.hasOwn(STARTUP_MESSAGES, code) ? (code as StartupCode) : 'SESSION_INTERNAL_ERROR'
}

const SIGNAL_NAMES = new Map(Object.entries(constants.signals).map(([name, number]) => [number, name]))

/** Container exit codes above 128 conventionally report the terminating signal. */
const signalOf = (exitCode: number | null): string | null => (exitCode !== null && exitCode > 128 ? (SIGNAL_NAMES.get(exitCode - 128) ?? null) : null)

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------

/** Starts one editing session; throws synchronously, before any side effect, on invalid input. */
export function startEditingSession(request: unknown, dependencies: EditingSessionDependencies): EditingSessionHandle {
  const resolved: ResolvedEditingSessionRequest = dependencies.profiles.resolveRequest(request)
  const docker = dependencies.docker ?? createDockerCli()
  const workspaces = dependencies.workspaces ?? createWorkspaceManager()
  const clock = dependencies.clock ?? (() => performance.now())
  const id = randomUUID()
  const lifecycle = createSessionLifecycle()
  // A won timeout or cancellation resolves `lifecycle.terminal`, which the running session awaits.
  const requestStop = (cause: 'timed_out' | 'cancelled'): void => {
    lifecycle.selectTerminal(cause)
  }

  const { signal } = resolved.request
  const onAbort = (): void => requestStop('cancelled')
  if (signal?.aborted) requestStop('cancelled')
  else signal?.addEventListener('abort', onAbort, { once: true })

  const result = runSession({ id, resolved, docker, workspace: workspaces.open(), clock, lifecycle, requestStop }).finally(() =>
    signal?.removeEventListener('abort', onAbort),
  )
  return Object.freeze({
    id,
    result,
    cancel: async (): Promise<void> => {
      requestStop('cancelled')
      await result
    },
  })
}

interface SessionContext {
  readonly id: string
  readonly resolved: ResolvedEditingSessionRequest
  readonly docker: DockerAdapter
  readonly workspace: SessionWorkspace
  readonly clock: () => number
  readonly lifecycle: SessionLifecycle
  readonly requestStop: (cause: 'timed_out' | 'cancelled') => void
}

async function runSession(context: SessionContext): Promise<EditingSessionResult> {
  const { id, resolved, docker, workspace, clock, lifecycle, requestStop } = context
  const { request, profile, limits } = resolved
  const startedAt = clock()
  let isolation: IsolationObservation | null = null
  let containerId: string | null = null
  let createAttempted = false
  let attached: AttachedContainer | null = null
  let startupCode: StartupCode | null = null
  let finalState: ContainerState | null = null
  const captured: Buffer[] = []
  let capturedBytes = 0
  const capture = (chunk: Buffer): void => {
    const room = limits.diagnosticBytes - capturedBytes
    if (room <= 0) return
    const kept = chunk.subarray(0, room)
    captured.push(kept)
    capturedBytes += kept.length
  }
  const ended = (): boolean => lifecycle.terminalCause !== null
  let timer: NodeJS.Timeout | undefined

  lifecycle.transition('preparing')
  // ---- Preparation and execution: every step re-checks for an earlier terminal cause.
  try {
    const uid = process.getuid?.() ?? -1
    const gid = process.getgid?.() ?? -1
    if (uid <= 0 || gid <= 0) throw new StartupFailure('CONTROLLER_ROOT_UNSUPPORTED')
    if (!ended()) await workspace.resolve(request.repositoryRoot, request.revision)
    if (!ended()) {
      const capabilities = await docker.preflight()
      if (!capabilities.supported) throw new StartupFailure('DOCKER_CAPABILITY_MISSING')
      isolation = capabilities.isolation
    }
    const prepared = ended() ? null : await workspace.create(createTaskDocument(request))
    if (prepared !== null && !ended()) {
      lifecycle.transition('starting')
      createAttempted = true
      containerId = await docker.create({
        sessionId: id,
        profile,
        limits,
        user: { uid, gid },
        workspacePath: prepared.workspacePath,
        taskDocumentPath: prepared.taskDocumentPath,
        lsm: isolation?.lsm ?? null,
      })
    }
    if (containerId !== null && !ended()) {
      lifecycle.transition('running')
      const running = docker.start(containerId, { onStdout: capture, onStderr: capture })
      attached = running
      timer = setTimeout(() => requestStop('timed_out'), limits.wallClockMs)
      void running.exited.then(() => lifecycle.selectTerminal('exited'))
      await lifecycle.terminal
    }
  } catch (error) {
    if (lifecycle.selectTerminal('startup_failed')) startupCode = startupCodeOf(error)
  } finally {
    clearTimeout(timer)
  }
  // A step can finish without selecting a cause only through an internal defect; fail closed.
  if (lifecycle.selectTerminal('startup_failed')) startupCode = 'SESSION_INTERNAL_ERROR'
  const cause = lifecycle.terminalCause ?? 'startup_failed'

  // ---- Stopping: a graceful stop bounded by the grace period, then forced removal.
  if (attached !== null && containerId !== null && (cause === 'timed_out' || cause === 'cancelled')) {
    lifecycle.transition('stopping')
    const graceSeconds = limits.stopGraceMs / 1_000
    if (await within(docker.stop(containerId, graceSeconds), limits.stopGraceMs + STOP_MARGIN_MS)) {
      await within(attached.exited, EXIT_WAIT_MS)
    }
  }
  if (attached !== null && containerId !== null) finalState = await docker.inspect(containerId).catch(() => null)

  // ---- Cleaning: exact container, manifest paths, bounded retry, original comparison.
  lifecycle.transition('cleaning')
  attached?.kill()
  let retried = false
  let containerRemoved = false
  let disposal: WorkspaceDisposal = { taskDocumentRemoved: false, workspaceRemoved: false, sessionRootRemoved: false }
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    containerRemoved = await removeContainer()
    disposal = await workspace.dispose().catch(() => disposal)
    if (containerRemoved && disposal.taskDocumentRemoved && disposal.workspaceRemoved && disposal.sessionRootRemoved) break
    if (attempt === CLEANUP_ATTEMPTS) break
    retried = true
    await delay(CLEANUP_RETRY_DELAY_MS * attempt)
  }
  if (attached !== null) await within(attached.exited, EXIT_WAIT_MS)
  const integrity = await workspace.verifyOriginal().catch((): OriginalIntegrity => ({ verified: false, unchanged: false, mismatches: ['snapshot'] }))
  const cleanup = cleanupResult({ containerRemoved, disposal, integrity, retried })

  async function removeContainer(): Promise<boolean> {
    try {
      // A create that failed after the daemon made the container is found by its exact generated name.
      containerId ??= createAttempted ? await docker.findByName(containerName(id)) : null
      if (containerId === null) return true
      await docker.remove(containerId).catch(() => undefined)
      return !(await docker.exists(containerId))
    } catch {
      return false
    }
  }

  // ---- Outcome.
  let outcome: ExecutionOutcome
  let exitCode: number | null = null
  if (cause === 'exited') {
    if (finalState !== null && (!finalState.started || finalState.startError)) {
      outcome = 'startup_failed'
      startupCode = 'DOCKER_START_FAILED'
    } else {
      exitCode = finalState?.exitCode ?? null
      outcome = exitCode === 0 ? 'completed' : 'failed'
    }
  } else {
    outcome = cause
    if (cause !== 'startup_failed' && finalState !== null && !finalState.running) exitCode = finalState.exitCode
  }
  lifecycle.transition('finished')

  const summary =
    outcome === 'startup_failed'
      ? `startup_failed: ${STARTUP_MESSAGES[startupCode ?? 'SESSION_INTERNAL_ERROR']}.`
      : `${outcome}: the agent exited with code ${exitCode ?? 'unknown'}.`
  const output = sanitizeText(Buffer.concat(captured).toString('utf8')).value
  return Object.freeze({
    sessionId: id,
    executionOutcome: outcome,
    exitCode,
    signal: outcome === 'startup_failed' ? null : signalOf(exitCode),
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    diagnostic: output === '' ? summary : `${summary}\n${output}`,
    cleanup,
    runtime: Object.freeze({ profileId: profile.id, imageReference: profile.imageReference, isolation }),
  })
}
