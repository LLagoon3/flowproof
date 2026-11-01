import path from 'node:path'

import { z } from 'zod'

import { containsSecretPattern } from '../evidence/sanitize.js'

// The in-process editing-session contract of specs/002-agentic-sandbox-editing. A trusted caller
// selects one registered runtime profile and one exact commit; it can never supply an image,
// Docker flag, mount, network, entrypoint, shell string, or credential. Validation is synchronous
// and completes before any clone, task document, or container exists. The result reports only the
// lifecycle: it carries no diff, file metadata, candidate, replay, gate, or verification verdict.

export const EXECUTION_OUTCOMES = ['completed', 'failed', 'timed_out', 'cancelled', 'startup_failed'] as const
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number]

export const CLEANUP_STATUSES = ['complete', 'recovered', 'failed'] as const
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number]

export const OWNED_RESOURCE_CATEGORIES = ['container', 'task_document', 'workspace', 'original_repository'] as const
export type OwnedResourceCategory = (typeof OWNED_RESOURCE_CATEGORIES)[number]

/** `CLEANUP_RETRIED` marks a recovered cleanup; every other code names a failed category. */
export const CLEANUP_REASON_CODES = [
  'CLEANUP_RETRIED',
  'CONTAINER_NOT_REMOVED',
  'TASK_DOCUMENT_NOT_REMOVED',
  'WORKSPACE_NOT_REMOVED',
  'ORIGINAL_REPOSITORY_CHANGED',
  'ORIGINAL_REPOSITORY_UNVERIFIED',
] as const
export type CleanupReasonCode = (typeof CLEANUP_REASON_CODES)[number]

export const LSM_KINDS = ['apparmor', 'selinux'] as const
export type LsmKind = (typeof LSM_KINDS)[number]

/** The fixed container paths; neither a caller nor a profile chooses them. */
export const WORKSPACE_MOUNT = '/workspace'
export const TASK_DOCUMENT_MOUNT = '/run/flowproof/task.json'

export const MAX_TASK_BYTES = 16_384
export const MAX_DECLARED_COMMANDS = 16
export const MAX_DECLARED_COMMAND_BYTES = 512
const MAX_REPOSITORY_ROOT_LENGTH = 4_096
const MAX_SIGNAL_LENGTH = 16

export const IMMUTABLE_IMAGE_PATTERN =
  /^(?:sha256:[a-f0-9]{64}|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64})$/
export const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type EditingSessionErrorCode =
  | 'EDITING_REQUEST_INVALID'
  | 'EDITING_LIMITS_INVALID'
  | 'EDITING_PROFILE_UNKNOWN'
  | 'EDITING_PROFILE_INVALID'

/** A rejected request or profile; messages name fields, never their values. */
export class EditingSessionError extends Error {
  readonly code: EditingSessionErrorCode

  constructor(code: EditingSessionErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'EditingSessionError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------

export const LIMIT_FIELDS = ['wallClockMs', 'stopGraceMs', 'memoryBytes', 'cpuCount', 'pids', 'diagnosticBytes'] as const
export type LimitField = (typeof LIMIT_FIELDS)[number]

export interface LimitRange {
  readonly min: number
  readonly default: number
  readonly max: number
}
export type LimitBounds = { readonly [K in LimitField]: LimitRange }
export type SessionLimits = { readonly [K in LimitField]: number }

const range = (min: number, defaultValue: number, max: number): LimitRange => Object.freeze({ min, default: defaultValue, max })

/** The global v1 bounds. A runtime profile may narrow but never widen them. */
export const V1_LIMIT_BOUNDS: LimitBounds = Object.freeze({
  wallClockMs: range(1_000, 120_000, 900_000),
  stopGraceMs: range(1_000, 5_000, 30_000),
  memoryBytes: range(268_435_456, 1_073_741_824, 4_294_967_296),
  cpuCount: range(0.25, 1, 4),
  pids: range(32, 256, 1_024),
  diagnosticBytes: range(4_096, 65_536, 1_048_576),
})

/** True when `value` has the numeric kind `field` requires; never coerces strings. */
function isLimitValue(field: LimitField, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (field === 'cpuCount') return true
  if (!Number.isSafeInteger(value)) return false
  // Docker's stop timeout is whole seconds; the grace must map to it without rounding.
  return field !== 'stopGraceMs' || value % 1_000 === 0
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/**
 * Validates profile-specific ranges and merges them over the global bounds. Every supplied range
 * is a complete ordered `min <= default <= max` triple inside the global range for its field.
 */
export function validateLimitBounds(input: unknown): LimitBounds {
  const invalid = (field: string): EditingSessionError =>
    new EditingSessionError('EDITING_PROFILE_INVALID', `The profile limit range ${field} is invalid.`)
  if (input === undefined) return V1_LIMIT_BOUNDS
  if (!isPlainObject(input)) throw invalid('limits')
  const merged: Record<string, LimitRange> = { ...V1_LIMIT_BOUNDS }
  for (const [field, candidate] of Object.entries(input)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(field)) throw invalid(field)
    const key = field as LimitField
    const global = V1_LIMIT_BOUNDS[key]
    if (!isPlainObject(candidate) || Object.keys(candidate).sort().join(',') !== 'default,max,min') throw invalid(field)
    const { min, default: defaultValue, max } = candidate
    if (![min, defaultValue, max].every((value) => isLimitValue(key, value))) throw invalid(field)
    const [low, mid, high] = [min, defaultValue, max] as [number, number, number]
    if (!(global.min <= low && low <= mid && mid <= high && high <= global.max)) throw invalid(field)
    merged[key] = range(low, mid, high)
  }
  return Object.freeze(merged as Record<LimitField, LimitRange>)
}

/** Fills omitted limits with the bounds' defaults and rejects any value outside its range. */
export function resolveSessionLimits(requested: unknown, bounds: LimitBounds = V1_LIMIT_BOUNDS): SessionLimits {
  const invalid = (field: string): EditingSessionError =>
    new EditingSessionError('EDITING_LIMITS_INVALID', `The session limit ${field} is outside its permitted range.`)
  if (requested !== undefined && !isPlainObject(requested)) throw invalid('limits')
  const supplied = requested ?? {}
  for (const field of Object.keys(supplied)) if (!(LIMIT_FIELDS as readonly string[]).includes(field)) throw invalid(field)
  const resolved: Record<string, number> = {}
  for (const field of LIMIT_FIELDS) {
    const value = Object.hasOwn(supplied, field) ? supplied[field] : bounds[field].default
    if (!isLimitValue(field, value) || value < bounds[field].min || value > bounds[field].max) throw invalid(field)
    resolved[field] = value
  }
  return Object.freeze(resolved as Record<LimitField, number>)
}

// ---------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------

export interface EditingSessionRequest {
  /** Absolute local Git worktree resolved by the trusted caller; never forwarded to the container. */
  readonly repositoryRoot: string
  /** Full commit object ID (40 or 64 lowercase hex). */
  readonly revision: string
  /** Bounded untrusted task text for the agent. */
  readonly task: string
  /** A profile ID registered by trusted code. */
  readonly runtimeProfileId: string
  /** Task context written to the task document; never an enforced command allowlist. */
  readonly declaredProjectCommands: readonly string[]
  readonly limits?: Partial<SessionLimits>
  /** Cancels the session like `cancel()`. */
  readonly signal?: AbortSignal
}

/** The immutable structurally validated request; limits still resolve against the profile. */
export interface ParsedEditingSessionRequest {
  readonly repositoryRoot: string
  readonly revision: string
  readonly task: string
  readonly runtimeProfileId: string
  readonly declaredProjectCommands: readonly string[]
  readonly limits: Readonly<Partial<Record<LimitField, unknown>>> | undefined
  readonly signal: AbortSignal | undefined
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

const RequestSchema = z.strictObject({
  repositoryRoot: z
    .string()
    .min(1)
    .max(MAX_REPOSITORY_ROOT_LENGTH)
    .refine((value) => path.isAbsolute(value) && !value.includes('\0')),
  revision: z.string().regex(REVISION_PATTERN),
  task: z
    .string()
    .refine((value) => value.trim().length > 0 && utf8Bytes(value) <= MAX_TASK_BYTES && !value.includes('\0')),
  runtimeProfileId: z.string().max(64).regex(PROFILE_ID_PATTERN),
  declaredProjectCommands: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0 && utf8Bytes(value) <= MAX_DECLARED_COMMAND_BYTES && !/[\0\r\n]/.test(value)),
    )
    .max(MAX_DECLARED_COMMANDS),
  limits: z.record(z.string(), z.unknown()).optional(),
  signal: z.instanceof(AbortSignal).optional(),
})

/**
 * Structural request validation: exact keys, bounded task and command context, no embedded
 * credential or repository path, and a well-formed limits object. Throws before any side effect.
 */
export function parseEditingSessionRequest(input: unknown): ParsedEditingSessionRequest {
  const parsed = RequestSchema.safeParse(input)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'request')))].join(', ')
    throw new EditingSessionError('EDITING_REQUEST_INVALID', `The editing request is invalid at ${fields}.`)
  }
  const value = parsed.data
  // Task metadata is untrusted agent input; it must not smuggle a credential or host path.
  const leaks = (text: string): boolean => containsSecretPattern(text) || text.includes(value.repositoryRoot)
  if (leaks(value.task)) throw new EditingSessionError('EDITING_REQUEST_INVALID', 'The editing request is invalid at task.')
  if (value.declaredProjectCommands.some(leaks)) {
    throw new EditingSessionError('EDITING_REQUEST_INVALID', 'The editing request is invalid at declaredProjectCommands.')
  }
  // Shape check against the global bounds; the resolved profile may narrow them further.
  try {
    if (value.limits !== undefined) resolveSessionLimits(value.limits)
  } catch {
    throw new EditingSessionError('EDITING_REQUEST_INVALID', 'The editing request is invalid at limits.')
  }
  return Object.freeze({
    repositoryRoot: value.repositoryRoot,
    revision: value.revision,
    task: value.task,
    runtimeProfileId: value.runtimeProfileId,
    declaredProjectCommands: Object.freeze([...value.declaredProjectCommands]),
    limits: value.limits === undefined ? undefined : Object.freeze({ ...value.limits }),
    signal: value.signal,
  })
}

export interface TaskDocument {
  readonly task: string
  readonly declaredProjectCommands: readonly string[]
}

/** The session-owned task document: exactly the bounded task and declared command context. */
export function createTaskDocument(request: Pick<ParsedEditingSessionRequest, 'task' | 'declaredProjectCommands'>): TaskDocument {
  return Object.freeze({ task: request.task, declaredProjectCommands: Object.freeze([...request.declaredProjectCommands]) })
}

// ---------------------------------------------------------------------------------------
// Runtime profile
// ---------------------------------------------------------------------------------------

/** A trusted, code-registered execution profile; never a user-serializable request body. */
export interface AgentRuntimeProfile {
  readonly id: string
  /** Immutable `name@sha256:...` digest or `sha256:...` local image ID. */
  readonly imageReference: string
  /** Direct argv; FlowProof never wraps it in a shell. */
  readonly argv: readonly string[]
  /** Fixed non-secret environment; nothing is inherited from the host. */
  readonly environment: Readonly<Record<string, string>>
  readonly workingDirectory: typeof WORKSPACE_MOUNT
  /** Optional ranges that narrow the global v1 bounds. */
  readonly limits?: Partial<Record<LimitField, LimitRange>>
}

export interface ResolvedRuntimeProfile {
  readonly id: string
  readonly imageReference: string
  readonly argv: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly workingDirectory: typeof WORKSPACE_MOUNT
  readonly limits: LimitBounds
}

/** A request validated against its resolved profile, with every limit filled. */
export interface ResolvedEditingSessionRequest {
  readonly request: ParsedEditingSessionRequest
  readonly profile: ResolvedRuntimeProfile
  readonly limits: SessionLimits
}

// ---------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------

export interface IsolationObservation {
  /** True only when the daemon reports rootless mode. */
  readonly rootless: boolean
  /** The Linux security module applied to the container, when the daemon offers one. */
  readonly lsm: LsmKind | null
}

export interface RuntimeSummary {
  readonly profileId: string
  readonly imageReference: string
  /** Observed during capability preflight; null when preflight did not run. */
  readonly isolation: IsolationObservation | null
}

export interface CleanupResult {
  readonly status: CleanupStatus
  readonly containerRemoved: boolean
  readonly workspaceRemoved: boolean
  readonly originalRepositoryUnchanged: boolean
  readonly reasonCode: CleanupReasonCode | null
  readonly remainingOwnedResources: readonly OwnedResourceCategory[]
}

export interface EditingSessionResult {
  readonly sessionId: string
  readonly executionOutcome: ExecutionOutcome
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly diagnostic: string
  readonly cleanup: CleanupResult
  readonly runtime: RuntimeSummary
}

export interface EditingSessionHandle {
  readonly id: string
  readonly result: Promise<EditingSessionResult>
  cancel(reason?: string): Promise<void>
}

export const EDITING_SESSION_RESULT_FIELDS = [
  'sessionId',
  'executionOutcome',
  'exitCode',
  'signal',
  'durationMs',
  'diagnostic',
  'cleanup',
  'runtime',
] as const
export const CLEANUP_RESULT_FIELDS = [
  'status',
  'containerRemoved',
  'workspaceRemoved',
  'originalRepositoryUnchanged',
  'reasonCode',
  'remainingOwnedResources',
] as const

const CleanupSchema = z
  .strictObject({
    status: z.enum(CLEANUP_STATUSES),
    containerRemoved: z.boolean(),
    workspaceRemoved: z.boolean(),
    originalRepositoryUnchanged: z.boolean(),
    reasonCode: z.enum(CLEANUP_REASON_CODES).nullable(),
    remainingOwnedResources: z.array(z.enum(OWNED_RESOURCE_CATEGORIES)).max(OWNED_RESOURCE_CATEGORIES.length),
  })
  .superRefine((cleanup, context) => {
    const remaining = new Set(cleanup.remainingOwnedResources)
    const fail = (message: string): void => context.addIssue({ code: 'custom', message })
    if (remaining.size !== cleanup.remainingOwnedResources.length) fail('duplicate resource category')
    if (cleanup.containerRemoved === remaining.has('container')) fail('containerRemoved contradicts the residue')
    if (cleanup.originalRepositoryUnchanged === remaining.has('original_repository')) fail('originalRepositoryUnchanged contradicts the residue')
    // The task document lives under the session root, so either residue keeps the root.
    if (cleanup.workspaceRemoved && (remaining.has('workspace') || remaining.has('task_document'))) fail('workspaceRemoved contradicts the residue')
    if (!cleanup.workspaceRemoved && !remaining.has('workspace') && !remaining.has('task_document')) fail('workspaceRemoved contradicts the residue')
    if (cleanup.status === 'complete' && (remaining.size > 0 || cleanup.reasonCode !== null)) fail('complete cleanup has residue or a reason')
    if (cleanup.status === 'recovered' && (remaining.size > 0 || cleanup.reasonCode !== 'CLEANUP_RETRIED')) fail('recovered cleanup has residue')
    if (cleanup.status === 'failed' && (remaining.size === 0 || cleanup.reasonCode === null || cleanup.reasonCode === 'CLEANUP_RETRIED')) {
      fail('failed cleanup names no residue')
    }
  })

const ResultSchema = z
  .strictObject({
    sessionId: z.string().regex(UUID_PATTERN),
    executionOutcome: z.enum(EXECUTION_OUTCOMES),
    exitCode: z.int().min(0).max(255).nullable(),
    signal: z
      .string()
      .max(MAX_SIGNAL_LENGTH)
      .regex(/^SIG[A-Z0-9]+$/)
      .nullable(),
    durationMs: z.int().min(0),
    diagnostic: z.string().refine((value) => utf8Bytes(value) <= V1_LIMIT_BOUNDS.diagnosticBytes.max),
    cleanup: CleanupSchema,
    runtime: z.strictObject({
      profileId: z.string().max(64).regex(PROFILE_ID_PATTERN),
      imageReference: z.string().regex(IMMUTABLE_IMAGE_PATTERN),
      isolation: z.strictObject({ rootless: z.boolean(), lsm: z.enum(LSM_KINDS).nullable() }).nullable(),
    }),
  })
  .superRefine((result, context) => {
    const fail = (message: string): void => context.addIssue({ code: 'custom', message })
    if (result.executionOutcome === 'completed' && (result.exitCode !== 0 || result.signal !== null)) fail('completed without a zero exit')
    if (result.executionOutcome === 'failed' && result.exitCode === 0) fail('failed with a zero exit')
    if (result.executionOutcome === 'startup_failed' && (result.exitCode !== null || result.signal !== null)) fail('startup failure with an exit')
  })

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly string[] }

/** Validates the result shape and its cross-field cleanup and outcome invariants. */
export function parseEditingSessionResult(value: unknown): ParseResult<EditingSessionResult> {
  const parsed = ResultSchema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data as EditingSessionResult }
  return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`) }
}
