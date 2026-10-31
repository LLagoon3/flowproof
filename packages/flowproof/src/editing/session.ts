import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'

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
import type { OriginalIntegrity, PathPlaceholder, SessionWorkspace, WorkspaceDisposal, WorkspaceManager } from './workspace.js'

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

/**
 * Reports a signal only when FlowProof initiated termination or Docker observed an OOM kill.
 * An agent may deliberately exit with a code such as 143, which is not itself proof of SIGTERM.
 */
const signalOf = (outcome: ExecutionOutcome, exitCode: number | null, oomKilled: boolean): string | null => {
  if (exitCode === null || (!oomKilled && outcome !== 'timed_out' && outcome !== 'cancelled')) return null
  return exitCode > 128 ? (SIGNAL_NAMES.get(exitCode - 128) ?? null) : null
}

/** Longer cancellation reasons are omitted whole rather than cut, so no partial secret survives. */
const MAX_CANCEL_REASON_INPUT = 2_048
const MAX_CANCEL_REASON_DISPLAY = 200

interface TailBuffer {
  push(chunk: Buffer): void
  /** The retained tail as text; after truncation it starts at the first complete line. */
  text(): string
}

const PRIVATE_KEY_LABEL_MAX = 64
const PRIVATE_KEY_MARKER_CARRY = 128
const KEY_BEGIN = new RegExp(`-----BEGIN [A-Z ]{0,${PRIVATE_KEY_LABEL_MAX}}PRIVATE KEY-----`)
const KEY_END = new RegExp(`-----END [A-Z ]{0,${PRIVATE_KEY_LABEL_MAX}}PRIVATE KEY-----`)

/** Keeps the last `limit` bytes of one output stream while tracking private-key blocks. */
function createTailBuffer(limit: number): TailBuffer {
  let chunks: Buffer[] = []
  let size = 0
  let truncated = false
  let markerCarry = ''
  let privateKeyOpen = false
  let finalized = false
  const decoder = new StringDecoder('utf8')

  const append = (text: string): void => {
    if (text === '') return
    const chunk = Buffer.from(text)
    if (chunk.length >= limit) {
      chunks = [Buffer.from(chunk.subarray(chunk.length - limit))]
      size = limit
      truncated = true
      return
    }
    chunks.push(chunk)
    size += chunk.length
    while (size > limit) {
      const first = chunks[0] as Buffer
      const excess = size - limit
      if (first.length <= excess) {
        chunks.shift()
        size -= first.length
      } else {
        chunks[0] = first.subarray(excess)
        size -= excess
      }
      truncated = true
    }
  }

  const scrubPrivateKeys = (decoded: string, flush: boolean): void => {
    let current = markerCarry + decoded
    markerCarry = ''
    while (current !== '') {
      if (privateKeyOpen) {
        const end = KEY_END.exec(current)
        if (end !== null) {
          current = current.slice(end.index + end[0].length)
          privateKeyOpen = false
          continue
        }
        // Retain only enough text to recognize an END marker split across chunks. On final flush,
        // discard the unfinished block rather than exposing a body whose BEGIN marker is gone.
        if (!flush) markerCarry = current.slice(-PRIVATE_KEY_MARKER_CARRY)
        return
      }

      const begin = KEY_BEGIN.exec(current)
      if (begin !== null) {
        append(current.slice(0, begin.index))
        append('[REDACTED]')
        current = current.slice(begin.index + begin[0].length)
        privateKeyOpen = true
        continue
      }
      if (flush) {
        append(current)
        return
      }
      const safeLength = Math.max(0, current.length - PRIVATE_KEY_MARKER_CARRY)
      append(current.slice(0, safeLength))
      markerCarry = current.slice(safeLength)
      return
    }
  }

  return {
    push(chunk: Buffer): void {
      if (!finalized) scrubPrivateKeys(decoder.write(chunk), false)
    },
    text(): string {
      if (!finalized) {
        scrubPrivateKeys(decoder.end(), true)
        finalized = true
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return truncated ? dropPartialFirstLine(text) : text
    },
  }
}

/** A cut can split a line, and with it a secret the sanitizer would no longer recognize. */
const dropPartialFirstLine = (text: string): string => {
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

const KEY_END_WITH_LINE = new RegExp(`${KEY_END.source}[^\\n]*\\n?`)

/**
 * The sanitizer redacts complete private-key blocks only. A retained tail can hold a key body
 * whose BEGIN line was cut away, or output can end inside a key; both fragments are dropped.
 */
function dropPartialPrivateKeys(text: string): string {
  let current = text
  const end = KEY_END_WITH_LINE.exec(current)
  const begin = KEY_BEGIN.exec(current)
  if (end !== null && (begin === null || begin.index > end.index)) current = current.slice(end.index + end[0].length)
  const openBegin = KEY_BEGIN.exec(current)
  if (openBegin !== null && !KEY_END_WITH_LINE.test(current.slice(openBegin.index))) current = current.slice(0, openBegin.index)
  return current
}

function replacePaths(text: string, placeholders: readonly PathPlaceholder[]): string {
  let current = text
  for (const { value, placeholder } of placeholders) if (value !== '') current = current.split(value).join(placeholder)
  return current
}

/** Untrusted text made safe for a result: host paths replaced, then secrets redacted. */
const safeText = (text: string, placeholders: readonly PathPlaceholder[]): string => sanitizeText(replacePaths(text, placeholders)).value

/** The last complete lines of `text` that fit in `budget` UTF-8 bytes. */
function tailWithin(text: string, budget: number): string {
  if (Buffer.byteLength(text, 'utf8') <= budget) return text
  if (budget <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  return dropPartialFirstLine(bytes.subarray(bytes.length - budget).toString('utf8'))
}

function sanitizeReason(reason: unknown, placeholders: readonly PathPlaceholder[]): string | null {
  if (typeof reason !== 'string' || reason.trim() === '') return null
  if (reason.length > MAX_CANCEL_REASON_INPUT) return '[omitted: too long]'
  const single = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const safe = safeText(single, placeholders)
  return safe.length <= MAX_CANCEL_REASON_DISPLAY ? safe : `${safe.slice(0, MAX_CANCEL_REASON_DISPLAY).replace(/[\ud800-\udbff]$/, '')}…`
}

/**
 * The bounded diagnostic: one fixed summary line, then the sanitized tail of each stream. The whole
 * text never exceeds `limit` bytes; each stream keeps at most half of what remains.
 */
function composeDiagnostic(input: {
  readonly summary: string
  readonly stdout: string
  readonly stderr: string
  readonly placeholders: readonly PathPlaceholder[]
  readonly limit: number
}): string {
  const sections = [
    ['stdout', input.stdout],
    ['stderr', input.stderr],
  ] as const
  const rendered = sections
    .map(([name, raw]) => [name, safeText(dropPartialPrivateKeys(raw), input.placeholders).replace(/\n+$/, '')] as const)
    .filter(([, text]) => text !== '')
  const headers = rendered.reduce((total, [name]) => total + Buffer.byteLength(`\n${name}:\n`, 'utf8'), 0)
  const budget = Math.floor((input.limit - Buffer.byteLength(input.summary, 'utf8') - headers) / Math.max(1, rendered.length))
  let diagnostic = input.summary
  for (const [name, text] of rendered) {
    const tail = tailWithin(text, budget)
    if (tail !== '') diagnostic += `\n${name}:\n${tail}`
  }
  return Buffer.byteLength(diagnostic, 'utf8') <= input.limit ? diagnostic : input.summary
}

function describeOutcome(input: {
  readonly outcome: ExecutionOutcome
  readonly exitCode: number | null
  readonly startupCode: StartupCode | null
  readonly oomKilled: boolean
  readonly runtimeInterrupted: boolean
  readonly wallClockMs: number
  readonly reason: string | null
}): string {
  const exit = `exit code ${input.exitCode ?? 'unknown'}`
  switch (input.outcome) {
    case 'startup_failed':
      return `startup_failed: ${STARTUP_MESSAGES[input.startupCode ?? 'SESSION_INTERNAL_ERROR']}.`
    case 'timed_out':
      return `timed_out: the agent exceeded its ${input.wallClockMs / 1_000}-second wall-clock limit and was stopped (${exit}).`
    case 'cancelled':
      return `cancelled: the session was cancelled${input.reason === null ? '' : ` (reason: ${input.reason})`} and the agent was stopped (${exit}).`
    case 'failed':
      if (input.runtimeInterrupted) return 'failed: the runtime attachment ended before the agent container stopped.'
      return `failed: the agent exited with code ${input.exitCode ?? 'unknown'}.${input.oomKilled ? ' The container reached its memory limit.' : ''}`
    default:
      return `${input.outcome}: the agent exited with code ${input.exitCode ?? 'unknown'}.${input.oomKilled ? ' The container reached its memory limit.' : ''}`
  }
}

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
  // Only the winning cancellation's reason is kept; it is sanitized during finalization.
  const cancellation: { reason: unknown } = { reason: undefined }
  // A won timeout or cancellation resolves `lifecycle.terminal`, which the running session awaits.
  const requestStop = (cause: 'timed_out' | 'cancelled', reason?: unknown): void => {
    if (lifecycle.selectTerminal(cause) && cause === 'cancelled') cancellation.reason = reason
  }

  const { signal } = resolved.request
  const onAbort = (): void => requestStop('cancelled', 'the request signal was aborted')
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const result = runSession({ id, resolved, docker, workspace: workspaces.open(), clock, lifecycle, requestStop, cancellation }).finally(() =>
    signal?.removeEventListener('abort', onAbort),
  )
  return Object.freeze({
    id,
    result,
    cancel: async (reason?: string): Promise<void> => {
      requestStop('cancelled', reason)
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
  readonly cancellation: { readonly reason: unknown }
}

async function runSession(context: SessionContext): Promise<EditingSessionResult> {
  const { id, resolved, docker, workspace, clock, lifecycle, requestStop, cancellation } = context
  const { request, profile, limits } = resolved
  const startedAt = clock()
  let isolation: IsolationObservation | null = null
  let containerId: string | null = null
  let createAttempted = false
  let attached: AttachedContainer | null = null
  let startupCode: StartupCode | null = null
  let finalState: ContainerState | null = null
  let runtimeInterrupted = false
  // Raw output stays in memory, bounded per stream, and leaves only through composeDiagnostic.
  const stdout = createTailBuffer(Math.floor(limits.diagnosticBytes / 2))
  const stderr = createTailBuffer(Math.floor(limits.diagnosticBytes / 2))
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
      // Establish absence before create. If create subsequently fails after the daemon made the
      // container, cleanup may safely recover the newly appeared exact name. A pre-existing name
      // is never adopted or removed as session-owned state.
      const existing = await docker.findByName(containerName(id)).catch(() => {
        throw new StartupFailure('DOCKER_CREATE_FAILED')
      })
      if (existing !== null) throw new StartupFailure('DOCKER_CREATE_FAILED')
      if (!ended()) {
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
    }
    if (containerId !== null && !ended()) {
      lifecycle.transition('running')
      const running = docker.start(containerId, { onStdout: (chunk) => stdout.push(chunk), onStderr: (chunk) => stderr.push(chunk) })
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
    if (finalState?.running === true) {
      // The attach client ended but the agent container did not. Treat this controller/runtime
      // interruption as a failure and never reuse Docker's placeholder running-state exit code.
      outcome = 'failed'
      runtimeInterrupted = true
    } else if (finalState !== null && (!finalState.started || finalState.startError)) {
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

  // ---- Immutable result: fixed summary, bounded sanitized output, no path or raw tool text.
  const placeholders = workspace.pathPlaceholders()
  const summary = describeOutcome({
    outcome,
    exitCode,
    startupCode,
    oomKilled: finalState?.oomKilled === true,
    runtimeInterrupted,
    wallClockMs: limits.wallClockMs,
    reason: outcome === 'cancelled' ? sanitizeReason(cancellation.reason, placeholders) : null,
  })
  return Object.freeze({
    sessionId: id,
    executionOutcome: outcome,
    exitCode,
    signal: outcome === 'startup_failed' ? null : signalOf(outcome, exitCode, finalState?.oomKilled === true),
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    diagnostic: composeDiagnostic({ summary, stdout: stdout.text(), stderr: stderr.text(), placeholders, limit: limits.diagnosticBytes }),
    cleanup,
    runtime: Object.freeze({
      profileId: profile.id,
      imageReference: profile.imageReference,
      isolation: isolation === null ? null : Object.freeze({ rootless: isolation.rootless, lsm: isolation.lsm }),
    }),
  })
}
