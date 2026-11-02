import { EXECUTION_OUTCOMES, parseEditingSessionResult } from './contracts.js'
import type { EditingSessionResult, ParseResult } from './contracts.js'

// The opt-in change-capture result of specs/003-capture-editing-candidate. A capturing session
// resolves `{ session, capture }`: `session` is the unchanged Spec 002 lifecycle result and
// `capture` is a small discriminated union. Two invariants hold for every value built here:
//
// - "Only `captured` has a nonempty patch/files pair, matching the same baseline/session."
// - "Failure/rejection/no-changes/not-attempted never have candidate bytes or partial records."
//
// A candidate is an unverified proposal, not a verdict. Results carry stable reason codes and
// fixed messages only: never Git output, exception text, scanner findings, content, or host paths.

export const CAPTURE_STATUSES = ['captured', 'no_changes', 'rejected', 'failed', 'not_attempted'] as const
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number]

export const CAPTURE_REASON_CODES = [
  'EDITOR_NOT_SUCCESSFUL',
  'WORKSPACE_VIEW_UNAVAILABLE',
  'UNREPRESENTABLE_ENTRY',
  'SENSITIVE_DATA',
  'CAPTURE_LIMIT',
  'CAPTURE_INTERRUPTED',
  'CAPTURE_IO_FAILED',
] as const
export type CaptureReasonCode = (typeof CAPTURE_REASON_CODES)[number]

export const REJECTION_REASON_CODES = ['WORKSPACE_VIEW_UNAVAILABLE', 'UNREPRESENTABLE_ENTRY', 'SENSITIVE_DATA', 'CAPTURE_LIMIT'] as const
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number]
export const FAILURE_REASON_CODES = ['CAPTURE_INTERRUPTED', 'CAPTURE_IO_FAILED'] as const
export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number]

/** Fixed safe explanations; each is far below the smallest session diagnostic bound. */
export const CAPTURE_REASON_MESSAGES: Readonly<Record<CaptureReasonCode, string>> = Object.freeze({
  EDITOR_NOT_SUCCESSFUL: 'Capture was not attempted because the editor did not finish successfully with confirmed termination.',
  WORKSPACE_VIEW_UNAVAILABLE: 'Capture was rejected because the complete editing workspace view could not be proved.',
  UNREPRESENTABLE_ENTRY: 'Capture was rejected because an entry cannot be represented as an ordinary Git change and would otherwise be omitted.',
  SENSITIVE_DATA: 'Capture was rejected because a changed path or payload matched a required sensitive-data check.',
  CAPTURE_LIMIT: 'Capture was rejected because the change set exceeded the capture time or size budget.',
  CAPTURE_INTERRUPTED: 'Capture was interrupted before it completed, so no candidate was produced.',
  CAPTURE_IO_FAILED: 'Capture failed because the workspace or Git state could not be read.',
})

export const SUBMODULE_COVERAGE_NOTE =
  'Submodule entries are captured as commit references only; nested working-tree changes were neither inspected nor captured.'

/** Main-repository scope, with the fixed note whenever the baseline or final tree has a gitlink. */
export interface CaptureCoverage {
  readonly scope: 'main_repository'
  readonly note: typeof SUBMODULE_COVERAGE_NOTE | null
}

const REFERENCE_ONLY: CaptureCoverage = Object.freeze({ scope: 'main_repository', note: SUBMODULE_COVERAGE_NOTE })
const MAIN_ONLY: CaptureCoverage = Object.freeze({ scope: 'main_repository', note: null })

export const repositoryCoverage = (hasGitlinks: boolean): CaptureCoverage => (hasGitlinks ? REFERENCE_ONLY : MAIN_ONLY)

export const CANDIDATE_OPERATIONS = ['added', 'modified', 'deleted'] as const
export type CandidateOperation = (typeof CANDIDATE_OPERATIONS)[number]

/** Git tree entry modes: regular, executable, symbolic link, and gitlink. */
export const CANDIDATE_MODES = ['100644', '100755', '120000', '160000'] as const
export type CandidateMode = (typeof CANDIDATE_MODES)[number]
const GITLINK_MODE = '160000'

/**
 * One changed main-repository entry. A rename is a deletion plus an addition; a mode or type
 * change is a modification. Gitlinks carry commit references only, so they have no byte length.
 */
export interface CandidateFile {
  /** Raw relative path bytes; each read returns a fresh copy. */
  readonly path: Buffer
  readonly operation: CandidateOperation
  readonly oldMode: CandidateMode | null
  readonly newMode: CandidateMode | null
  readonly oldObjectId: string | null
  readonly newObjectId: string | null
  /** Blob byte length; null when the side is absent or a gitlink. */
  readonly oldSize: number | null
  readonly newSize: number | null
}

export interface CaptureCandidate {
  readonly sessionId: string
  /** The full trusted starting commit, never the editor's HEAD. */
  readonly baselineCommit: string
  /** One full-index, binary-capable Git patch; each read returns a fresh copy. */
  readonly patch: Buffer
  readonly files: readonly CandidateFile[]
  readonly coverage: CaptureCoverage
}

export const CANDIDATE_FIELDS = ['sessionId', 'baselineCommit', 'patch', 'files', 'coverage'] as const
export const CANDIDATE_FILE_FIELDS = ['path', 'operation', 'oldMode', 'newMode', 'oldObjectId', 'newObjectId', 'oldSize', 'newSize'] as const

export type CaptureResult =
  | { readonly status: 'captured'; readonly candidate: CaptureCandidate }
  | { readonly status: 'no_changes'; readonly coverage: CaptureCoverage }
  | { readonly status: 'rejected'; readonly reasonCode: RejectionReasonCode; readonly message: string; readonly coverage: CaptureCoverage | null }
  | { readonly status: 'failed'; readonly reasonCode: FailureReasonCode; readonly message: string; readonly coverage: CaptureCoverage | null }
  | { readonly status: 'not_attempted'; readonly reasonCode: 'EDITOR_NOT_SUCCESSFUL'; readonly message: string; readonly coverage: null }

/** The opt-in session composition; execution and cleanup facts stay in `session`. */
export interface CapturingEditingSessionResult {
  readonly session: EditingSessionResult
  readonly capture: CaptureResult
}

/** A violated in-process capture invariant; it never carries candidate bytes or paths. */
export class CaptureContractError extends Error {
  constructor(field: string) {
    super(`CAPTURE_CONTRACT_INVALID: the capture result is invalid at ${field}.`)
    this.name = 'CaptureContractError'
  }
}

// ---------------------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export interface CandidateFileInput {
  readonly path: Uint8Array
  readonly operation: CandidateOperation
  readonly oldMode: CandidateMode | null
  readonly newMode: CandidateMode | null
  readonly oldObjectId: string | null
  readonly newObjectId: string | null
  readonly oldSize: number | null
  readonly newSize: number | null
}

export interface CandidateInput {
  readonly sessionId: string
  readonly baselineCommit: string
  readonly patch: Uint8Array
  readonly files: readonly CandidateFileInput[]
  readonly coverage: CaptureCoverage
}

const isCoverage = (value: unknown): value is CaptureCoverage => value === REFERENCE_ONLY || value === MAIN_ONLY

/** A safe relative path: nonempty, no NUL, no absolute or `.`/`..`/`.git` component. */
function isRelativePath(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false
  const components = Buffer.from(bytes).toString('latin1').split('/')
  return components.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function checkSide(file: CandidateFileInput, side: 'old' | 'new', present: boolean, idLength: number, at: string): void {
  const mode = side === 'old' ? file.oldMode : file.newMode
  const id = side === 'old' ? file.oldObjectId : file.newObjectId
  const size = side === 'old' ? file.oldSize : file.newSize
  if (!present) {
    if (mode !== null || id !== null || size !== null) throw new CaptureContractError(`${at}.${side}`)
    return
  }
  if (!(CANDIDATE_MODES as readonly unknown[]).includes(mode)) throw new CaptureContractError(`${at}.${side}Mode`)
  if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id) || id.length !== idLength) throw new CaptureContractError(`${at}.${side}ObjectId`)
  if (mode === GITLINK_MODE ? size !== null : !isSize(size)) throw new CaptureContractError(`${at}.${side}Size`)
}

/** A detached snapshot whose byte fields return fresh copies, so no caller can alias it. */
function freezeWithBytes<T extends object>(fields: T, bytes: Record<string, Buffer>, order: readonly string[]): T {
  const target: Record<string, unknown> = {}
  for (const key of order) {
    const retained = bytes[key]
    if (retained !== undefined) {
      Object.defineProperty(target, key, { enumerable: true, get: () => Buffer.from(retained) })
    } else {
      Object.defineProperty(target, key, { enumerable: true, value: (fields as Record<string, unknown>)[key] })
    }
  }
  return Object.freeze(target) as T
}

/** Builds a frozen candidate; throws `CaptureContractError` when an invariant does not hold. */
export function createCandidate(input: CandidateInput): CaptureCandidate {
  if (typeof input.sessionId !== 'string' || !UUID_PATTERN.test(input.sessionId)) throw new CaptureContractError('sessionId')
  if (typeof input.baselineCommit !== 'string' || !OBJECT_ID_PATTERN.test(input.baselineCommit)) throw new CaptureContractError('baselineCommit')
  if (!(input.patch instanceof Uint8Array) || input.patch.length === 0) throw new CaptureContractError('patch')
  if (!Array.isArray(input.files) || input.files.length === 0) throw new CaptureContractError('files')
  if (!isCoverage(input.coverage)) throw new CaptureContractError('coverage')
  const idLength = input.baselineCommit.length
  const seen = new Set<string>()
  const files = input.files.map((file, index) => {
    const at = `files.${index}`
    if (!(file.path instanceof Uint8Array) || !isRelativePath(file.path)) throw new CaptureContractError(`${at}.path`)
    const key = Buffer.from(file.path).toString('hex')
    if (seen.has(key)) throw new CaptureContractError(`${at}.path`)
    seen.add(key)
    if (!(CANDIDATE_OPERATIONS as readonly unknown[]).includes(file.operation)) throw new CaptureContractError(`${at}.operation`)
    checkSide(file, 'old', file.operation !== 'added', idLength, at)
    checkSide(file, 'new', file.operation !== 'deleted', idLength, at)
    if (file.operation === 'modified' && file.oldMode === file.newMode && file.oldObjectId === file.newObjectId) {
      throw new CaptureContractError(`${at}.operation`)
    }
    const fields = {
      operation: file.operation,
      oldMode: file.oldMode,
      newMode: file.newMode,
      oldObjectId: file.oldObjectId,
      newObjectId: file.newObjectId,
      oldSize: file.oldSize,
      newSize: file.newSize,
    }
    return freezeWithBytes(fields as unknown as CandidateFile, { path: Buffer.from(file.path) }, CANDIDATE_FILE_FIELDS)
  })
  const fields = { sessionId: input.sessionId, baselineCommit: input.baselineCommit, files: Object.freeze(files), coverage: input.coverage }
  return freezeWithBytes(fields as unknown as CaptureCandidate, { patch: Buffer.from(input.patch) }, CANDIDATE_FIELDS)
}

// ---------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------

const message = (code: CaptureReasonCode): string => CAPTURE_REASON_MESSAGES[code]

export function capturedResult(candidate: CaptureCandidate): CaptureResult {
  if (!isCoverage((candidate as { coverage?: unknown })?.coverage) || candidate.patch.length === 0 || candidate.files.length === 0) {
    throw new CaptureContractError('candidate')
  }
  return Object.freeze({ status: 'captured', candidate })
}

export function noChangesResult(coverage: CaptureCoverage): CaptureResult {
  if (!isCoverage(coverage)) throw new CaptureContractError('coverage')
  return Object.freeze({ status: 'no_changes', coverage })
}

export function rejectedResult(reasonCode: RejectionReasonCode, coverage: CaptureCoverage | null = null): CaptureResult {
  if (!(REJECTION_REASON_CODES as readonly unknown[]).includes(reasonCode)) throw new CaptureContractError('reasonCode')
  if (coverage !== null && !isCoverage(coverage)) throw new CaptureContractError('coverage')
  return Object.freeze({ status: 'rejected', reasonCode, message: message(reasonCode), coverage })
}

export function failedResult(reasonCode: FailureReasonCode, coverage: CaptureCoverage | null = null): CaptureResult {
  if (!(FAILURE_REASON_CODES as readonly unknown[]).includes(reasonCode)) throw new CaptureContractError('reasonCode')
  if (coverage !== null && !isCoverage(coverage)) throw new CaptureContractError('coverage')
  return Object.freeze({ status: 'failed', reasonCode, message: message(reasonCode), coverage })
}

export function notAttemptedResult(): CaptureResult {
  return Object.freeze({ status: 'not_attempted', reasonCode: 'EDITOR_NOT_SUCCESSFUL', message: message('EDITOR_NOT_SUCCESSFUL'), coverage: null })
}

// ---------------------------------------------------------------------------------------
// Composition validation
// ---------------------------------------------------------------------------------------

const sameKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Structural capture issues independent of the wrapped session. */
function captureIssues(capture: unknown): string[] {
  if (!isRecord(capture) || !(CAPTURE_STATUSES as readonly unknown[]).includes(capture.status)) return ['capture.status']
  const coverageOk = (value: unknown, nullable: boolean): boolean => isCoverage(value) || (nullable && value === null)
  switch (capture.status) {
    case 'captured': {
      if (!sameKeys(capture, ['status', 'candidate'])) return ['capture']
      const candidate = capture.candidate
      if (!isRecord(candidate) || !sameKeys(candidate, CANDIDATE_FIELDS)) return ['capture.candidate']
      try {
        // Rebuilding checks every candidate invariant against the same rules used at creation.
        createCandidate(candidate as unknown as CandidateInput)
      } catch {
        return ['capture.candidate']
      }
      if (!(candidate.files as unknown[]).every((file) => isRecord(file) && sameKeys(file, CANDIDATE_FILE_FIELDS))) return ['capture.candidate.files']
      return []
    }
    case 'no_changes':
      return sameKeys(capture, ['status', 'coverage']) && coverageOk(capture.coverage, false) ? [] : ['capture']
    default: {
      const codes: Record<string, readonly string[]> = {
        rejected: REJECTION_REASON_CODES,
        failed: FAILURE_REASON_CODES,
        not_attempted: ['EDITOR_NOT_SUCCESSFUL'],
      }
      const allowed = codes[String(capture.status)] ?? []
      if (!sameKeys(capture, ['status', 'reasonCode', 'message', 'coverage'])) return ['capture']
      if (!allowed.includes(capture.reasonCode as string)) return ['capture.reasonCode']
      if (capture.message !== message(capture.reasonCode as CaptureReasonCode)) return ['capture.message']
      const coverage = capture.status === 'not_attempted' ? capture.coverage === null : coverageOk(capture.coverage, true)
      return coverage ? [] : ['capture.coverage']
    }
  }
}

/**
 * Validates `{ session, capture }`: the unchanged session contract, the capture invariants, and
 * their agreement. Capture runs only after a completed editor, so every attempted outcome needs
 * `completed`, except a capture-preparation failure that kept the editor from starting.
 */
export function validateCapturingSessionResult(value: unknown): ParseResult<CapturingEditingSessionResult> {
  if (!isRecord(value) || !sameKeys(value, ['session', 'capture'])) return { ok: false, issues: ['result'] }
  const session = parseEditingSessionResult(value.session)
  if (!session.ok) return { ok: false, issues: session.issues.map((issue) => `session.${issue}`) }
  const issues = captureIssues(value.capture)
  if (issues.length > 0) return { ok: false, issues }
  const capture = value.capture as CaptureResult
  const outcome = session.value.executionOutcome
  const completed = outcome === 'completed'
  let agrees: boolean
  switch (capture.status) {
    case 'captured':
      agrees = completed && capture.candidate.sessionId === session.value.sessionId
      break
    case 'not_attempted':
      agrees = !completed && (EXECUTION_OUTCOMES as readonly string[]).includes(outcome)
      break
    case 'failed':
      agrees = completed || (capture.reasonCode === 'CAPTURE_IO_FAILED' && outcome === 'startup_failed')
      break
    default:
      agrees = completed
  }
  return agrees ? { ok: true, value: value as unknown as CapturingEditingSessionResult } : { ok: false, issues: ['capture.status'] }
}
