import type {
  EvidencePhase,
  EvidenceType,
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  PhaseDurations,
  RunResult,
  RunState,
  RunStatus,
  ScenarioCase,
  StudioEvent,
  StudioEventType,
} from '../../../packages/flowproof/src/contracts/index.js'
import type { SUBMODULE_COVERAGE_NOTE } from '../../../packages/flowproof/src/editing/capture.js'
import type {
  CAPTURED_CHECK_IDS as ENGINE_CAPTURED_CHECK_IDS,
  CAPTURED_CHECK_REASONS as ENGINE_CAPTURED_CHECK_REASONS,
  CAPTURED_CLEANUP_RESOURCES as ENGINE_CAPTURED_CLEANUP_RESOURCES,
  CAPTURED_ORIGINAL_MISMATCHES as ENGINE_CAPTURED_ORIGINAL_MISMATCHES,
  CAPTURED_OUTCOME_REASONS as ENGINE_CAPTURED_OUTCOME_REASONS,
  CAPTURED_RESULT_KIND as ENGINE_CAPTURED_RESULT_KIND,
  CAPTURED_SCHEMA_VERSION as ENGINE_CAPTURED_SCHEMA_VERSION,
  CAPTURED_STATUSES as ENGINE_CAPTURED_STATUSES,
  CapturedCheck,
  CapturedCheckId,
  CapturedCheckReason,
  CapturedCheckStatus,
  CapturedOutcomeReason,
  CapturedStatus,
  CapturedVerificationResult,
} from '../../../packages/flowproof/src/verify/capturedContracts.js'

// The browser side of contracts/studio-api.md. Every HTTP and SSE payload is untrusted: it is
// checked here with narrow, browser-safe mirrors of the committed contracts before any state
// sees it. The engine's Zod contracts are reused for types only, so neither Zod nor Node code
// reaches the Studio bundle. Errors carry a stable code and a client-authored message and never
// echo a response body, a server message, or a rejected value.

export type {
  EvidencePhase,
  EvidenceType,
  GateId,
  GateOutcome,
  GateStatus,
  GateSummary,
  PhaseDurations,
  RunResult,
  RunState,
  RunStatus,
  ScenarioCase,
  StudioEvent,
  StudioEventType,
}
export type { CapturedCheck, CapturedCheckId, CapturedCheckStatus, CapturedStatus, CapturedVerificationResult }

export const CONTRACT_SCHEMA_VERSION = '1.0.0'
export const META_MODEL_ID = 'muse-spark-1.3'
/** The server's chat bound; a longer request is never sent. */
export const MAX_REQUEST_TEXT_LENGTH = 500

export const SCENARIO_CASES = ['hero', 'failure-invalid-citation'] as const satisfies readonly ScenarioCase[]
export const GATE_IDS = [
  'failure_reproduced',
  'evidence_complete',
  'citations_valid',
  'patch_scope_valid',
  'patch_applied',
  'dataset_matches',
  'canvas_matches',
  'secret_scan_clean',
  'original_worktree_unchanged',
] as const satisfies readonly GateId[]
export const GATE_STATUSES = ['pass', 'fail', 'unevaluable'] as const satisfies readonly GateStatus[]
export const RUN_STATES = [
  'initialized',
  'reproducing',
  'failure_captured',
  'diagnosing',
  'candidate_validated',
  'applying',
  'replaying',
  'finalized',
] as const satisfies readonly RunState[]
export const RUN_STATUSES = ['Verified Fix', 'Unverified'] as const satisfies readonly RunStatus[]
export const EVIDENCE_PHASES = ['failure', 'replay'] as const satisfies readonly EvidencePhase[]
export const EVIDENCE_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'] as const satisfies readonly EvidenceType[]
export const STUDIO_EVENT_TYPES = [
  'chat_received',
  'phase_started',
  'phase_completed',
  'evidence_added',
  'diagnosis_ready',
  'candidate_ready',
  'gate_updated',
  'run_finalized',
  'agent_message',
] as const satisfies readonly StudioEventType[]

/** The catalog discriminator of the host-fixed captured verification mode; legacy entries carry none. */
export const CAPTURED_EXECUTION_KIND = 'captured-verification'

interface ScenarioSummaryFields {
  readonly scenario_id: string
  readonly case: ScenarioCase
  readonly title: string
  readonly default_request: string
}

/** A legacy catalog entry: exactly the four committed fields. */
export interface LegacyScenarioSummary extends ScenarioSummaryFields {
  readonly execution_kind?: never
}

/** The one prepared case of a host-fixed captured verification Studio, explicitly discriminated. */
export interface CapturedScenarioSummary extends ScenarioSummaryFields {
  readonly execution_kind: typeof CAPTURED_EXECUTION_KIND
}

/** Safe presentation metadata for one committed case, as listed by `GET /api/scenarios`. */
export type ScenarioSummary = LegacyScenarioSummary | CapturedScenarioSummary

export const isCapturedScenario = (scenario: ScenarioSummary): scenario is CapturedScenarioSummary =>
  scenario.execution_kind === CAPTURED_EXECUTION_KIND

/** The `202 Accepted` body of `POST /api/runs`. */
export interface RunStart {
  readonly request_id: string
  readonly run_id: string
  readonly events_url: string
}

/**
 * One authoritative result read: still running, or a final result of either explicit family, already
 * validated and bound to the requested run. The Studio state also binds the request, case and family.
 */
export type ResultRead = { readonly state: 'running' } | { readonly state: 'finalized'; readonly result: StudioRunResult }

// ---------------------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------------------

/** A displayable error: a stable code and a client-authored message. */
export interface StudioError {
  readonly code: string
  readonly message: string
}

const MESSAGES: Readonly<Record<string, string>> = {
  NETWORK_UNAVAILABLE: 'The Studio API could not be reached.',
  REQUEST_ABORTED: 'The request was cancelled.',
  REQUEST_INVALID: 'The request was not sent because an identifier is not valid.',
  REQUEST_TEXT_INVALID: `Enter a request of 1 to ${MAX_REQUEST_TEXT_LENGTH} characters.`,
  RESPONSE_INVALID: 'The Studio API returned a response outside its contract.',
  RESULT_INVALID: 'The run result violates the run-result contract, so no final status is shown.',
  RESULT_RUN_MISMATCH: 'The run result belongs to another run or request, so no final status is shown.',
  RESULT_FAMILY_MISMATCH: 'The run result is not the kind of result this Studio mode produces, so no final status is shown.',
  EVENT_INVALID: 'A live activity event violated the Studio Event contract, so live activity stopped.',
  EVENT_RUN_MISMATCH: 'A live activity event belonged to another run, so live activity stopped.',
  EVENT_SEQUENCE_DUPLICATE: 'A live activity event repeated a sequence, so live activity stopped.',
  EVENT_SEQUENCE_REORDERED: 'A live activity event arrived out of order, so live activity stopped.',
  EVENT_SEQUENCE_GAP: 'Live activity skipped an event and missed events are not replayed, so it stopped.',
  STREAM_DISCONNECTED: 'Live activity disconnected. Missed events are not replayed; the final result stays available.',
  SESSION_NOT_READY: 'The prepared cases are not available yet.',
  SCENARIO_NOT_SELECTED: 'Select a prepared case before starting a run.',
  RUN_ALREADY_ACTIVE: 'A run is already active in this Studio session.',
  ACTIVE_RUN_EXISTS: 'This Studio session already has an active run.',
  RUN_LIMIT_REACHED: 'This Studio session has already started its verification run.',
  PROVIDER_CREDENTIAL_MISSING: 'The live Meta provider requires MODEL_API_KEY; no run was created.',
  SCENARIO_NOT_REGISTERED: 'The selected case is not a committed scenario.',
  REQUEST_TEXT_TOO_LONG: `The request is limited to ${MAX_REQUEST_TEXT_LENGTH} characters.`,
  REQUEST_TEXT_EMPTY: 'The request must contain a readable goal.',
  RUN_NOT_FOUND: 'The run does not exist in this Studio session.',
  CLIENT_ERROR: 'The Studio client could not complete the operation.',
}
const SERVER_REJECTION = 'The Studio API rejected the request.'
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/** Builds a displayable error for a stable code; unknown codes get a generic message. */
export function studioError(code: string): StudioError {
  const safeCode = ERROR_CODE_PATTERN.test(code) ? code : 'CLIENT_ERROR'
  return Object.freeze({ code: safeCode, message: MESSAGES[safeCode] ?? SERVER_REJECTION })
}

export class StudioClientError extends Error {
  readonly code: string
  /** The HTTP status when a response was received; null otherwise. */
  readonly status: number | null

  constructor(code: string, status: number | null = null) {
    const safe = studioError(code)
    super(safe.message)
    this.name = 'StudioClientError'
    this.code = safe.code
    this.status = status
  }
}

/** Converts anything thrown into a displayable error without reading foreign error text. */
export function toStudioError(error: unknown): StudioError {
  return error instanceof StudioClientError ? studioError(error.code) : studioError('CLIENT_ERROR')
}

// ---------------------------------------------------------------------------------------
// Narrow contract checks
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^[a-f0-9]{40}$/
const EVIDENCE_ID_PATTERN = /^ev_(failure|replay)_(actions|dataset|chart|screenshot|console|network|source)_[0-9]{3}$/
const EVENT_ID_PATTERN = /^[0-9a-fA-F-]{36}:[1-9][0-9]*$/
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/
const MAX_TITLE_LENGTH = 200
const MAX_MESSAGE_LENGTH = 500

const EVENT_KEYS = [
  'schema_version',
  'event_id',
  'run_id',
  'sequence',
  'occurred_at',
  'type',
  'phase',
  'message',
  'evidence_ids',
  'gate',
  'artifact_refs',
] as const
const RESULT_KEYS = [
  'schema_version',
  'run_id',
  'request_id',
  'scenario_id',
  'case',
  'started_at',
  'completed_at',
  'original_head',
  'original_status_digest',
  'phase_durations_ms',
  'provider',
  'status',
  'gates',
  'failed_gate_ids',
  'diagnosis_path',
  'candidate_diff_path',
  'failure_screenshot_path',
  'replay_screenshot_path',
  'total_duration_ms',
] as const
const RESULT_PATH_KEYS = ['diagnosis_path', 'candidate_diff_path', 'failure_screenshot_path', 'replay_screenshot_path'] as const
const DURATION_KEYS = ['capture', 'model', 'apply', 'replay', 'finalize'] as const

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasExactKeys = (value: JsonObject, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max
const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
const isMilliseconds = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isUuid = (value: unknown): value is string => matches(value, UUID_PATTERN)
const isEvidenceId = (value: unknown): value is string => matches(value, EVIDENCE_ID_PATTERN)
const isRelativePath = (value: unknown): value is string => matches(value, RELATIVE_PATH_PATTERN)
const isNullablePath = (value: unknown): boolean => value === null || isRelativePath(value)
const isUniqueList = (value: unknown, item: (entry: unknown) => boolean): value is string[] =>
  Array.isArray(value) && value.every(item) && new Set(value).size === value.length

function isTimestamp(value: unknown): value is string {
  const match = typeof value === 'string' ? TIMESTAMP_PATTERN.exec(value) : null
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  const realDay = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return realDay && hour <= 23 && minute <= 59 && second <= 59
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Validated data is copied and frozen so neither the caller nor the UI can change it later. */
const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value))

export interface ProjectSettingsView {
  readonly entry_path: string
  readonly build: { readonly argv: readonly string[]; readonly output_directory: string }
  readonly required_project_checks: readonly { readonly id: string; readonly argv: readonly string[] }[]
}

export interface ProjectContextView {
  readonly kind: 'project-live'
  readonly project: {
    readonly project_id: string
    readonly display_root: string
    readonly label: string
    readonly baseline_commit: string
    readonly branch: string | null
    readonly category: 'vite-static-v1'
    readonly admission: { readonly state: 'inspecting' | 'ready' | 'blocked' | 'stale'; readonly reasons: readonly string[] }
  }
  readonly model_configured: boolean
  readonly configuration: {
    readonly state: 'required' | 'review' | 'confirmed' | 'rejected'
    readonly source: 'suggestion' | 'file' | 'confirmed' | 'rejected'
    readonly configuration_id: string | null
    readonly configuration_digest: string | null
    readonly reasons: readonly string[]
    readonly settings: ProjectSettingsView
  }
  readonly preparation: {
    readonly state: 'idle' | 'preparing' | 'ready' | 'failed'
    readonly reason: string | null
    readonly target_url: string | null
    readonly output_sha256: string | null
    readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }[]
  }
}

const projectSettingsKeys = ['entry_path', 'build', 'required_project_checks'] as const
const projectArgv = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((part) => typeof part === 'string' && part.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(part))

function isProjectSettingsView(value: unknown): value is ProjectSettingsView {
  if (!isObject(value) || !hasExactKeys(value, projectSettingsKeys) || !isText(value.entry_path, 2_048) || !value.entry_path.startsWith('/')) return false
  if (!isObject(value.build) || !hasExactKeys(value.build, ['argv', 'output_directory']) || !projectArgv(value.build.argv) || !isRelativePath(value.build.output_directory)) return false
  if (!Array.isArray(value.required_project_checks) || value.required_project_checks.length > 16) return false
  return value.required_project_checks.every(
    (check) => isObject(check) && hasExactKeys(check, ['id', 'argv']) && matches(check.id, KEBAB_ID_PATTERN) && projectArgv(check.argv),
  )
}

/** Strict browser-safe mirror of the scrubbed setup-context response. */
export function parseProjectContextView(input: unknown): ProjectContextView | null {
  if (!isObject(input) || !hasExactKeys(input, ['kind', 'project', 'model_configured', 'configuration', 'preparation']) || input.kind !== 'project-live') return null
  const project = input.project
  const configuration = input.configuration
  const preparation = input.preparation
  if (
    !isObject(project) ||
    !hasExactKeys(project, ['project_id', 'display_root', 'label', 'baseline_commit', 'branch', 'category', 'admission']) ||
    !isUuid(project.project_id) ||
    !isText(project.display_root, 1_024) ||
    !isText(project.label, 128) ||
    !matches(project.baseline_commit, GIT_OID_PATTERN) ||
    !(project.branch === null || isText(project.branch, 256)) ||
    project.category !== 'vite-static-v1' ||
    !isObject(project.admission) ||
    !hasExactKeys(project.admission, ['state', 'reasons']) ||
    !isOneOf(project.admission.state, ['inspecting', 'ready', 'blocked', 'stale'] as const) ||
    !isUniqueList(project.admission.reasons, (reason) => matches(reason, REASON_CODE_PATTERN)) ||
    typeof input.model_configured !== 'boolean' ||
    !isObject(configuration) ||
    !hasExactKeys(configuration, ['state', 'source', 'configuration_id', 'configuration_digest', 'reasons', 'settings']) ||
    !isOneOf(configuration.state, ['required', 'review', 'confirmed', 'rejected'] as const) ||
    !isOneOf(configuration.source, ['suggestion', 'file', 'confirmed', 'rejected'] as const) ||
    !(configuration.configuration_id === null || isUuid(configuration.configuration_id)) ||
    !(configuration.configuration_digest === null || matches(configuration.configuration_digest, SHA256_PATTERN)) ||
    !isUniqueList(configuration.reasons, (reason) => matches(reason, REASON_CODE_PATTERN)) ||
    !isProjectSettingsView(configuration.settings) ||
    !isObject(preparation) ||
    !hasExactKeys(preparation, ['state', 'reason', 'target_url', 'output_sha256', 'checks']) ||
    !isOneOf(preparation.state, ['idle', 'preparing', 'ready', 'failed'] as const) ||
    !(preparation.reason === null || matches(preparation.reason, REASON_CODE_PATTERN)) ||
    !(preparation.target_url === null || isText(preparation.target_url, 2_048)) ||
    !(preparation.output_sha256 === null || matches(preparation.output_sha256, SHA256_PATTERN)) ||
    !Array.isArray(preparation.checks) ||
    preparation.checks.length > 64 ||
    !preparation.checks.every((check) => isObject(check) && hasExactKeys(check, ['id', 'status']) && matches(check.id, KEBAB_ID_PATTERN) && isOneOf(check.status, ['passed', 'failed', 'not_evaluated'] as const))
  ) return null
  if (configuration.state === 'confirmed' && (configuration.configuration_id === null || configuration.configuration_digest === null)) return null
  if (preparation.state === 'ready' && (preparation.target_url === null || preparation.output_sha256 === null)) return null
  return frozenCopy(input as unknown as ProjectContextView)
}

function isGateSummary(value: unknown): value is GateSummary {
  return (
    isObject(value) &&
    hasExactKeys(value, ['gate_id', 'status', 'reason_code']) &&
    isOneOf(value.gate_id, GATE_IDS) &&
    isOneOf(value.status, GATE_STATUSES) &&
    matches(value.reason_code, REASON_CODE_PATTERN)
  )
}

function isGateOutcome(value: unknown): value is GateOutcome {
  if (!isObject(value) || !hasExactKeys(value, ['gate_id', 'status', 'evidence_ids', 'reason_code', 'message', 'metrics'])) return false
  const { metrics } = value
  return (
    isOneOf(value.gate_id, GATE_IDS) &&
    isOneOf(value.status, GATE_STATUSES) &&
    isUniqueList(value.evidence_ids, isEvidenceId) &&
    matches(value.reason_code, REASON_CODE_PATTERN) &&
    isText(value.message, MAX_MESSAGE_LENGTH) &&
    isObject(metrics) &&
    Object.values(metrics).every(
      (metric) => metric === null || ['string', 'boolean'].includes(typeof metric) || (typeof metric === 'number' && Number.isFinite(metric)),
    )
  )
}

/** Mirrors studio-event.schema.json, including the event ID, gate, and Evidence ID invariants. */
export function parseStudioEvent(input: unknown): StudioEvent | null {
  if (!isObject(input) || !hasExactKeys(input, EVENT_KEYS)) return null
  const { sequence, type, gate } = input
  const valid =
    input.schema_version === CONTRACT_SCHEMA_VERSION &&
    isUuid(input.run_id) &&
    Number.isSafeInteger(sequence) &&
    (sequence as number) >= 1 &&
    matches(input.event_id, EVENT_ID_PATTERN) &&
    input.event_id === `${input.run_id}:${String(sequence)}` &&
    isTimestamp(input.occurred_at) &&
    isOneOf(type, STUDIO_EVENT_TYPES) &&
    (input.phase === null || isOneOf(input.phase, RUN_STATES)) &&
    isText(input.message, MAX_MESSAGE_LENGTH) &&
    isUniqueList(input.evidence_ids, isEvidenceId) &&
    isUniqueList(input.artifact_refs, isRelativePath) &&
    (gate === null || isGateSummary(gate)) &&
    (type === 'gate_updated') === (gate !== null) &&
    (type !== 'evidence_added' || (input.evidence_ids as string[]).length > 0)
  return valid ? frozenCopy(input as unknown as StudioEvent) : null
}

function hasValidProvider(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, ['mode', 'model', 'injected_fault_label'])) return false
  if (value.mode === 'meta') return value.model === META_MODEL_ID && value.injected_fault_label === null
  return value.mode === 'fixture' && value.model === null && typeof value.injected_fault_label === 'string' && value.injected_fault_label.length > 0
}

/** Mirrors run-result.schema.json, including the nine-gate reduction and provider invariants. */
export function parseRunResult(input: unknown): RunResult | null {
  if (!isObject(input) || !hasExactKeys(input, RESULT_KEYS)) return null
  const durations = input.phase_durations_ms
  const gates = input.gates
  if (
    input.schema_version !== CONTRACT_SCHEMA_VERSION ||
    !isUuid(input.run_id) ||
    !isUuid(input.request_id) ||
    !matches(input.scenario_id, KEBAB_ID_PATTERN) ||
    !isOneOf(input.case, SCENARIO_CASES) ||
    !isTimestamp(input.started_at) ||
    !isTimestamp(input.completed_at) ||
    !matches(input.original_head, GIT_OID_PATTERN) ||
    !matches(input.original_status_digest, SHA256_PATTERN) ||
    !isObject(durations) ||
    !hasExactKeys(durations, DURATION_KEYS) ||
    !DURATION_KEYS.every((key) => isMilliseconds(durations[key])) ||
    !hasValidProvider(input.provider) ||
    !isOneOf(input.status, RUN_STATUSES) ||
    !Array.isArray(gates) ||
    !gates.every(isGateOutcome) ||
    !isUniqueList(input.failed_gate_ids, (id) => isOneOf(id, GATE_IDS)) ||
    !RESULT_PATH_KEYS.every((key) => isNullablePath(input[key])) ||
    !isMilliseconds(input.total_duration_ms)
  ) {
    return null
  }
  // Exactly one outcome per required gate, and failed_gate_ids names exactly the non-passing ones.
  if (gates.length !== GATE_IDS.length || !GATE_IDS.every((gateId) => gates.filter((gate) => gate.gate_id === gateId).length === 1)) {
    return null
  }
  const nonPassing = new Set(gates.filter((gate) => gate.status !== 'pass').map((gate) => gate.gate_id))
  const failed = input.failed_gate_ids as string[]
  if (failed.length !== nonPassing.size || !failed.every((gateId) => nonPassing.has(gateId as GateId))) return null
  const consistent =
    input.status === 'Verified Fix' ? nonPassing.size === 0 && RESULT_PATH_KEYS.every((key) => input[key] !== null) : nonPassing.size > 0
  return consistent ? frozenCopy(input as unknown as RunResult) : null
}

// ---------------------------------------------------------------------------------------
// Captured verification result family (Spec 004)
// ---------------------------------------------------------------------------------------

// A browser-safe mirror of `packages/flowproof/src/verify/capturedContracts.ts`: the strict result
// family discriminated by `kind`, independent of the legacy Run Result. The engine's tables are
// imported for their types only, so each mirror below fails type checking when it drifts, and the
// client contract tests check parity with the engine parser.

export const CAPTURED_RESULT_KIND: typeof ENGINE_CAPTURED_RESULT_KIND = 'captured-verification'
export const CAPTURED_SCHEMA_VERSION: typeof ENGINE_CAPTURED_SCHEMA_VERSION = '1.0.0'
/** The fixed note of a candidate whose baseline or final tree holds a submodule entry. */
export const CAPTURED_COVERAGE_NOTE: typeof SUBMODULE_COVERAGE_NOTE =
  'Submodule entries are captured as commit references only; nested working-tree changes were neither inspected nor captured.'

/** The ten mandatory checks, in data-model order. */
export const CAPTURED_CHECK_IDS: typeof ENGINE_CAPTURED_CHECK_IDS = [
  'input_valid',
  'baseline_reproduced',
  'application_complete',
  'build_passed',
  'tests_passed',
  'dataset_matches',
  'canvas_matches',
  'secret_scan_clean',
  'cleanup_complete',
  'original_unchanged',
]
export const CAPTURED_STATUSES: typeof ENGINE_CAPTURED_STATUSES = ['passed', 'failed', 'error', 'interrupted']
export const CAPTURED_CLEANUP_RESOURCES: typeof ENGINE_CAPTURED_CLEANUP_RESOURCES = ['target_runtime', 'browser_capture', 'operation', 'worktree', 'private_git_state']
export const CAPTURED_ORIGINAL_MISMATCHES: typeof ENGINE_CAPTURED_ORIGINAL_MISMATCHES = [
  'gitCommonDir',
  'head',
  'branch',
  'status',
  'index',
  'refs',
  'history',
  'localConfig',
  'worktreeList',
  'worktreeAdminEntries',
  'trackedFiles',
  'snapshot',
]

/** Fixed check reasons; each has exactly one status and one message. */
export const CAPTURED_CHECK_REASONS: typeof ENGINE_CAPTURED_CHECK_REASONS = {
  INPUT_ADMITTED: ['pass', 'The completed captured candidate, its editing-session identity, and complete upstream cleanup were admitted.'],
  BASELINE_REPRODUCED: ['pass', 'The baseline observation shows the prepared defect, and the failure evidence is complete.'],
  BASELINE_NOT_REPRODUCED: ['fail', 'The baseline observation already matches the expected outcome, so the prepared defect did not reproduce.'],
  BASELINE_OBSERVATION_INVALID: ['fail', 'The baseline observation is malformed, so the prepared defect could not be confirmed.'],
  BASELINE_EVIDENCE_INCOMPLETE: ['fail', 'The baseline failure evidence is missing, invalid, or not fully persisted.'],
  APPLICATION_COMPLETE: ['pass', 'The candidate applied once at its recorded baseline, and every versioned effect matched its captured summary.'],
  BASELINE_UNAVAILABLE: ['fail', 'The recorded baseline commit is not available in the original repository.'],
  APPLICATION_REJECTED: ['fail', 'The candidate did not apply completely at its recorded baseline, so nothing was tested.'],
  APPLICATION_FIDELITY_MISMATCH: ['fail', "The applied result differs from the candidate's captured file summary, so nothing was tested."],
  BUILD_PASSED: ['pass', 'The registered application build completed and produced servable output.'],
  BUILD_FAILED: ['fail', 'The registered application build failed for the applied candidate.'],
  BUILD_OUTPUT_INVALID: ['fail', 'The registered application build produced no servable output.'],
  TESTS_PASSED: ['pass', 'The trusted prepared functional check executed every case and matched every expected outcome.'],
  TESTS_FAILED: ['fail', 'The trusted prepared functional check reported a mismatch or did not complete.'],
  TESTS_NOT_EXECUTED: ['fail', 'The trusted prepared functional check executed no case, so it cannot pass.'],
  DATASET_MATCHED: ['pass', 'The observed filtered rows exactly match the committed dataset oracle.'],
  DATASET_MISMATCH: ['fail', 'The observed filtered rows differ from the committed dataset oracle.'],
  DATASET_OBSERVATION_INVALID: ['fail', 'The observed dataset is missing or malformed, so it cannot match the oracle.'],
  DATASET_ORACLE_INVALID: ['fail', 'The committed dataset oracle is malformed.'],
  CANVAS_MATCHED: ['pass', 'The rendered bar count, labels, and values exactly match the committed chart oracle.'],
  CANVAS_BAR_COUNT_MISMATCH: ['fail', 'The rendered bar count differs from the committed chart oracle.'],
  CANVAS_LABEL_MISMATCH: ['fail', 'A rendered bar label differs from the committed chart oracle.'],
  CANVAS_VALUE_MISMATCH: ['fail', 'A rendered bar value differs from the committed chart oracle.'],
  CANVAS_OBSERVATION_INVALID: ['fail', 'The rendered chart observation is missing or malformed, so it cannot match the oracle.'],
  CANVAS_ORACLE_INVALID: ['fail', 'The committed chart-series oracle is malformed.'],
  REPLAY_EVIDENCE_INCOMPLETE: ['fail', 'The replay evidence is missing, invalid, or not fully persisted, so the oracle cannot pass.'],
  SECRET_SCAN_CLEAN: ['pass', 'The whole-run secret scan found no seeded marker or credential.'],
  SECRET_SCAN_FINDINGS: ['fail', 'The whole-run secret scan found potential secrets; their values are not reported.'],
  SECRET_SCAN_INCOMPLETE: ['fail', 'A required surface could not be read or scanned, so the whole-run secret scan is incomplete.'],
  CLEANUP_COMPLETE: ['pass', 'Every owned target, operation, worktree, and private Git state was released.'],
  CLEANUP_INCOMPLETE: ['fail', 'At least one owned resource could not be released.'],
  ORIGINAL_UNCHANGED: ['pass', 'After cleanup the original repository equals its pre-run snapshot.'],
  ORIGINAL_CHANGED: ['fail', 'After cleanup the original repository differs from its pre-run snapshot.'],
  ORIGINAL_INTEGRITY_UNVERIFIED: ['fail', 'The original repository could not be compared with its pre-run snapshot.'],
  CHECK_NOT_EVALUATED: ['unevaluable', 'The run stopped before this check was evaluated.'],
  STAGE_ERROR: ['unevaluable', 'This check could not be executed because its stage failed to run.'],
  RUN_TIMEOUT: ['unevaluable', 'This check was not completed because the run exceeded its scenario time window.'],
  RUN_INTERRUPTED: ['unevaluable', 'This check was not completed because the Studio closed or the process was interrupted.'],
}

/** Fixed outcome reasons of non-passing results, with the status each one belongs to. */
export const CAPTURED_OUTCOME_REASONS: typeof ENGINE_CAPTURED_OUTCOME_REASONS = {
  BASELINE_NOT_CONFIRMED: ['failed', 'The prepared defect was not confirmed on the baseline, so the candidate was not verified.'],
  APPLICATION_FAILED: ['failed', 'The candidate could not be applied completely at its recorded baseline, so it was not verified.'],
  CANDIDATE_FAILED: ['failed', 'A mandatory candidate check failed, so the candidate was not verified.'],
  FINALIZATION_FAILED: ['failed', 'Secret scanning, cleanup, or original-integrity checks failed, so the run cannot pass.'],
  VERIFICATION_ERROR: ['error', 'A verification stage could not be executed, so the candidate was not verified.'],
  RUN_TIMEOUT: ['interrupted', 'The run exceeded its scenario time window and was cancelled.'],
  RUN_INTERRUPTED: ['interrupted', 'The Studio closed or the process was interrupted, so the run was cancelled.'],
}

/** Reasons any check may report when it could not be evaluated. */
const CAPTURED_UNEVALUABLE_REASONS = ['CHECK_NOT_EVALUATED', 'STAGE_ERROR', 'RUN_TIMEOUT', 'RUN_INTERRUPTED'] as const satisfies readonly CapturedCheckReason[]

/** The evaluated reasons each check may report, beside the shared unevaluable reasons. */
const CAPTURED_CHECK_REASON_SETS: Readonly<Record<CapturedCheckId, readonly CapturedCheckReason[]>> = {
  input_valid: ['INPUT_ADMITTED'],
  baseline_reproduced: ['BASELINE_REPRODUCED', 'BASELINE_NOT_REPRODUCED', 'BASELINE_OBSERVATION_INVALID', 'BASELINE_EVIDENCE_INCOMPLETE'],
  application_complete: ['APPLICATION_COMPLETE', 'BASELINE_UNAVAILABLE', 'APPLICATION_REJECTED', 'APPLICATION_FIDELITY_MISMATCH'],
  build_passed: ['BUILD_PASSED', 'BUILD_FAILED', 'BUILD_OUTPUT_INVALID'],
  tests_passed: ['TESTS_PASSED', 'TESTS_FAILED', 'TESTS_NOT_EXECUTED'],
  dataset_matches: ['DATASET_MATCHED', 'DATASET_MISMATCH', 'DATASET_OBSERVATION_INVALID', 'DATASET_ORACLE_INVALID', 'REPLAY_EVIDENCE_INCOMPLETE'],
  canvas_matches: [
    'CANVAS_MATCHED',
    'CANVAS_BAR_COUNT_MISMATCH',
    'CANVAS_LABEL_MISMATCH',
    'CANVAS_VALUE_MISMATCH',
    'CANVAS_OBSERVATION_INVALID',
    'CANVAS_ORACLE_INVALID',
    'REPLAY_EVIDENCE_INCOMPLETE',
  ],
  secret_scan_clean: ['SECRET_SCAN_CLEAN', 'SECRET_SCAN_FINDINGS', 'SECRET_SCAN_INCOMPLETE'],
  cleanup_complete: ['CLEANUP_COMPLETE', 'CLEANUP_INCOMPLETE'],
  original_unchanged: ['ORIGINAL_UNCHANGED', 'ORIGINAL_CHANGED', 'ORIGINAL_INTEGRITY_UNVERIFIED'],
}

/** Which same-run evidence each check may cite; all other checks cite none. */
const CAPTURED_EVIDENCE_SCOPE: Partial<Readonly<Record<CapturedCheckId, RegExp>>> = {
  baseline_reproduced: /^ev_failure_[a-z]+_[0-9]{3}$/,
  dataset_matches: /^ev_replay_dataset_[0-9]{3}$/,
  canvas_matches: /^ev_replay_chart_[0-9]{3}$/,
}

/** The outcome reason of a `failed` result follows its first failing check in canonical order. */
const CAPTURED_FAILED_OUTCOME: Readonly<Record<CapturedCheckId, CapturedOutcomeReason>> = {
  input_valid: 'CANDIDATE_FAILED',
  baseline_reproduced: 'BASELINE_NOT_CONFIRMED',
  application_complete: 'APPLICATION_FAILED',
  build_passed: 'CANDIDATE_FAILED',
  tests_passed: 'CANDIDATE_FAILED',
  dataset_matches: 'CANDIDATE_FAILED',
  canvas_matches: 'CANDIDATE_FAILED',
  secret_scan_clean: 'FINALIZATION_FAILED',
  cleanup_complete: 'FINALIZATION_FAILED',
  original_unchanged: 'FINALIZATION_FAILED',
}

const CAPTURED_RESULT_KEYS = [
  'kind',
  'schema_version',
  'run_id',
  'request_id',
  'scenario_id',
  'editing_session_id',
  'baseline_commit',
  'candidate_patch_sha256',
  'coverage',
  'status',
  'reason_code',
  'message',
  'checks',
  'before_evidence',
  'after_evidence',
  'cleanup',
  'started_at',
  'completed_at',
  'total_duration_ms',
  'phase_durations_ms',
] as const
const CAPTURED_CHECK_KEYS = ['check_id', 'status', 'reason_code', 'message', 'evidence_ids', 'metrics'] as const
const CAPTURED_CLEANUP_KEYS = ['complete', 'remaining_owned_resources', 'original_unchanged', 'original_mismatches'] as const
const CAPTURED_DURATION_KEYS = ['reproduce', 'apply', 'build', 'test', 'replay', 'finalize'] as const
/** A full lowercase SHA-1 (40) or SHA-256 (64) Git object ID; never abbreviated. */
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
const MAX_CAPTURED_METRICS = 8
const MAX_CHECK_EVIDENCE = 8

/** An own entry of a fixed table; inherited names such as `constructor` never count. */
const ownEntry = <T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined

const isMetricValue = (value: unknown): boolean =>
  value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))

function isCapturedCheck(value: unknown, checkId: CapturedCheckId): value is CapturedCheck {
  if (!isObject(value) || !hasExactKeys(value, CAPTURED_CHECK_KEYS) || value.check_id !== checkId) return false
  const allowed: readonly string[] = [...CAPTURED_CHECK_REASON_SETS[checkId], ...CAPTURED_UNEVALUABLE_REASONS]
  const fixed = ownEntry<readonly [CapturedCheckStatus, string]>(CAPTURED_CHECK_REASONS, value.reason_code)
  if (fixed === undefined || !allowed.includes(value.reason_code as string)) return false
  const scope = CAPTURED_EVIDENCE_SCOPE[checkId]
  const { evidence_ids: evidence, metrics } = value
  return (
    value.status === fixed[0] &&
    value.message === fixed[1] &&
    isUniqueList(evidence, isEvidenceId) &&
    evidence.length <= MAX_CHECK_EVIDENCE &&
    evidence.every((id) => scope !== undefined && scope.test(id)) &&
    isObject(metrics) &&
    Object.keys(metrics).length <= MAX_CAPTURED_METRICS &&
    Object.entries(metrics).every(([key, metric]) => METRIC_KEY_PATTERN.test(key) && isMetricValue(metric))
  )
}

const isEvidenceReference = (value: unknown, phase: EvidencePhase): boolean =>
  isObject(value) &&
  hasExactKeys(value, ['manifest_path', 'screenshot_path']) &&
  value.manifest_path === `evidence/${phase}/manifest.json` &&
  value.screenshot_path === `evidence/${phase}/screenshot.png`

const isCapturedCoverage = (value: unknown): boolean =>
  isObject(value) && hasExactKeys(value, ['scope', 'note']) && value.scope === 'main_repository' && (value.note === null || value.note === CAPTURED_COVERAGE_NOTE)

function isCapturedCleanup(value: unknown): value is CapturedVerificationResult['cleanup'] {
  if (!isObject(value) || !hasExactKeys(value, CAPTURED_CLEANUP_KEYS)) return false
  const { complete, remaining_owned_resources: remaining, original_unchanged: unchanged, original_mismatches: mismatches } = value
  return (
    typeof complete === 'boolean' &&
    typeof unchanged === 'boolean' &&
    isUniqueList(remaining, (item) => isOneOf(item, CAPTURED_CLEANUP_RESOURCES)) &&
    isUniqueList(mismatches, (item) => isOneOf(item, CAPTURED_ORIGINAL_MISMATCHES)) &&
    complete === (remaining.length === 0) &&
    unchanged === (mismatches.length === 0)
  )
}

/**
 * Mirrors the strict captured verification family: exact identity, ten canonical checks with fixed
 * reasons and same-run evidence, fixed outcome reasons, and cleanup facts. A passing result requires
 * all ten checks to pass, both evidence references, and complete cleanup with an unchanged original.
 */
export function parseCapturedVerificationResult(input: unknown): CapturedVerificationResult | null {
  if (!isObject(input) || !hasExactKeys(input, CAPTURED_RESULT_KEYS)) return null
  const { checks, cleanup, status, reason_code: reason, message, before_evidence: before, after_evidence: after } = input
  const durations = input.phase_durations_ms
  if (
    input.kind !== CAPTURED_RESULT_KIND ||
    input.schema_version !== CAPTURED_SCHEMA_VERSION ||
    !isUuid(input.run_id) ||
    !isUuid(input.request_id) ||
    !isUuid(input.editing_session_id) ||
    new Set([input.run_id, input.request_id, input.editing_session_id]).size !== 3 ||
    !matches(input.scenario_id, KEBAB_ID_PATTERN) ||
    !matches(input.baseline_commit, OBJECT_ID_PATTERN) ||
    !matches(input.candidate_patch_sha256, SHA256_PATTERN) ||
    !isCapturedCoverage(input.coverage) ||
    !isOneOf(status, CAPTURED_STATUSES) ||
    !(reason === null || ownEntry(CAPTURED_OUTCOME_REASONS, reason) !== undefined) ||
    !(message === null || isText(message, MAX_MESSAGE_LENGTH)) ||
    !Array.isArray(checks) ||
    checks.length !== CAPTURED_CHECK_IDS.length ||
    !CAPTURED_CHECK_IDS.every((checkId, index) => isCapturedCheck(checks[index], checkId)) ||
    !(before === null || isEvidenceReference(before, 'failure')) ||
    !(after === null || isEvidenceReference(after, 'replay')) ||
    !isCapturedCleanup(cleanup) ||
    !isTimestamp(input.started_at) ||
    !isTimestamp(input.completed_at) ||
    !isMilliseconds(input.total_duration_ms) ||
    !isObject(durations) ||
    !hasExactKeys(durations, CAPTURED_DURATION_KEYS) ||
    !CAPTURED_DURATION_KEYS.every((key) => isMilliseconds(durations[key]))
  ) {
    return null
  }
  const ordered = checks as CapturedCheck[]
  const passes = (checkId: CapturedCheckId): boolean => ordered[CAPTURED_CHECK_IDS.indexOf(checkId)]?.status === 'pass'
  // The cleanup and integrity checks restate the cleanup facts; passing oracles cite produced evidence.
  if (passes('cleanup_complete') !== cleanup.complete || passes('original_unchanged') !== cleanup.original_unchanged) return null
  if (passes('baseline_reproduced') && before === null) return null
  if ((passes('dataset_matches') || passes('canvas_matches')) && after === null) return null
  if (status === 'passed') {
    const complete = ordered.every((check) => check.status === 'pass') && before !== null && after !== null
    return complete && cleanup.complete && cleanup.original_unchanged && reason === null && message === null
      ? frozenCopy(input as unknown as CapturedVerificationResult)
      : null
  }
  const outcome = ownEntry<readonly [string, string]>(CAPTURED_OUTCOME_REASONS, reason)
  if (outcome === undefined || outcome[0] !== status || message !== outcome[1]) return null
  if (status === 'failed') {
    const first = ordered.find((check) => check.status === 'fail')
    if (first === undefined || CAPTURED_FAILED_OUTCOME[first.check_id] !== reason) return null
  }
  return frozenCopy(input as unknown as CapturedVerificationResult)
}

/** A final result of either family: the unchanged legacy Run Result or the captured verification result. */
export type StudioRunResult = RunResult | CapturedVerificationResult

export const isCapturedVerificationResult = (result: StudioRunResult): result is CapturedVerificationResult =>
  'kind' in result && result.kind === CAPTURED_RESULT_KIND

/**
 * Dispatches by the explicit `kind` discriminator: a body with `kind` is only ever read as the
 * captured family, and one without it only as the legacy Run Result. Neither falls back to the other.
 */
export function parseStudioRunResult(input: unknown): StudioRunResult | null {
  return isObject(input) && Object.hasOwn(input, 'kind') ? parseCapturedVerificationResult(input) : parseRunResult(input)
}

const SCENARIO_KEYS = ['scenario_id', 'case', 'title', 'default_request'] as const
const CAPTURED_SCENARIO_KEYS = [...SCENARIO_KEYS, 'execution_kind'] as const

const hasScenarioFields = (entry: JsonObject): boolean =>
  matches(entry.scenario_id, KEBAB_ID_PATTERN) &&
  isOneOf(entry.case, SCENARIO_CASES) &&
  isText(entry.title, MAX_TITLE_LENGTH) &&
  isText(entry.default_request, MAX_REQUEST_TEXT_LENGTH)

function parseScenarioList(input: unknown): readonly ScenarioSummary[] | null {
  if (!isObject(input) || !hasExactKeys(input, ['scenarios']) || !Array.isArray(input.scenarios)) return null
  const scenarios: unknown[] = input.scenarios
  const legacy = scenarios.every((entry) => isObject(entry) && hasExactKeys(entry, SCENARIO_KEYS) && hasScenarioFields(entry))
  // The host-fixed captured mode lists exactly its one prepared case, carrying the discriminator.
  const captured =
    scenarios.length === 1 &&
    scenarios.every(
      (entry) => isObject(entry) && hasExactKeys(entry, CAPTURED_SCENARIO_KEYS) && entry.execution_kind === CAPTURED_EXECUTION_KIND && hasScenarioFields(entry),
    )
  const ids = scenarios.map((entry) => (entry as ScenarioSummary).scenario_id)
  return (legacy || captured) && new Set(ids).size === ids.length ? frozenCopy(scenarios as ScenarioSummary[]) : null
}

function parseRunStart(input: unknown): RunStart | null {
  if (!isObject(input) || !hasExactKeys(input, ['request_id', 'run_id', 'events_url'])) return null
  const valid = isUuid(input.request_id) && isUuid(input.run_id) && input.events_url === `/api/runs/${String(input.run_id)}/events`
  return valid ? frozenCopy(input as unknown as RunStart) : null
}

/** True when the text may be sent as a run request: non-blank and within the server bound. */
export const isValidRequestText = (text: unknown): text is string =>
  typeof text === 'string' && text.length <= MAX_REQUEST_TEXT_LENGTH && text.trim().length > 0

export type EventOrderViolation = 'EVENT_RUN_MISMATCH' | 'EVENT_SEQUENCE_DUPLICATE' | 'EVENT_SEQUENCE_REORDERED' | 'EVENT_SEQUENCE_GAP'

/**
 * Live-only ordering for one connected run. The first delivered event may follow events emitted
 * before the connection, because missed events are never replayed; every later event must carry
 * the next contiguous sequence of the same run.
 */
export function eventOrderViolation(runId: string, lastSequence: number | null, event: StudioEvent): EventOrderViolation | null {
  if (event.run_id !== runId) return 'EVENT_RUN_MISMATCH'
  if (lastSequence === null) return null
  if (event.sequence === lastSequence) return 'EVENT_SEQUENCE_DUPLICATE'
  if (event.sequence < lastSequence) return 'EVENT_SEQUENCE_REORDERED'
  return event.sequence === lastSequence + 1 ? null : 'EVENT_SEQUENCE_GAP'
}

function assertRunId(runId: string): void {
  if (!isUuid(runId)) throw new StudioClientError('REQUEST_INVALID')
}

/** The phase and type a well-formed Evidence ID names; null for anything else. */
export function evidenceIdParts(id: unknown): { readonly phase: EvidencePhase; readonly type: EvidenceType } | null {
  const match = typeof id === 'string' ? EVIDENCE_ID_PATTERN.exec(id) : null
  return match === null ? null : { phase: match[1] as EvidencePhase, type: match[2] as EvidenceType }
}

/** The closed same-origin route for one registered Evidence ID of a run, for example a screenshot. */
export function evidenceUrl(runId: string, evidenceId: string): string {
  assertRunId(runId)
  if (!isEvidenceId(evidenceId)) throw new StudioClientError('REQUEST_INVALID')
  return `/api/runs/${runId}/evidence/${evidenceId}`
}

// ---------------------------------------------------------------------------------------
// Same-origin client
// ---------------------------------------------------------------------------------------

/** The part of a server-sent message the client reads; `MessageEvent` satisfies it. */
export interface SseMessage {
  readonly type: string
  readonly data?: unknown
  readonly lastEventId?: unknown
}

/** The part of `EventSource` the client uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (message: SseMessage) => void): void
  close(): void
}

export interface StudioClientOptions {
  readonly fetch?: (path: string, init: RequestInit) => Promise<Response>
  readonly openEventSource?: (path: string) => EventSourceLike
}

export interface RunEventHandlers {
  readonly onOpen: () => void
  /** A contract-valid event of this run with the next contiguous sequence. */
  readonly onEvent: (event: StudioEvent) => void
  /** A contract or ordering violation; the stream is already closed. */
  readonly onError: (error: StudioError) => void
  /** The connection dropped before the final event; the stream is closed and never resumed. */
  readonly onDisconnect: () => void
}

export interface RunEventSubscription {
  close(): void
}

export interface StudioClient {
  listScenarios(signal?: AbortSignal): Promise<readonly ScenarioSummary[]>
  startRun(request: { readonly scenarioId: string; readonly requestText: string }, signal?: AbortSignal): Promise<RunStart>
  /** Reads the authoritative result once: still running, or the validated final result of this run. */
  readResult(runId: string, signal?: AbortSignal): Promise<ResultRead>
  /** Reads the result until the run finalizes or the signal aborts. */
  pollResult(runId: string, options?: { readonly intervalMs?: number; readonly signal?: AbortSignal }): Promise<StudioRunResult>
  /** The validated candidate diff text, or null when the run has none. */
  readCandidateDiff(runId: string, signal?: AbortSignal): Promise<string | null>
  /** One sanitized JSON evidence artifact of the run; screenshots are shown through `evidenceUrl` instead. */
  readEvidence(runId: string, evidenceId: string, signal?: AbortSignal): Promise<unknown>
  /** Attaches to the live event stream of one run. Missed events are never replayed. */
  openRunEvents(runId: string, handlers: RunEventHandlers): RunEventSubscription
}

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DIFF_PREFIX = 'diff --git a/'

const mediaType = (response: Response): string => (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StudioClientError('REQUEST_ABORTED'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new StudioClientError('REQUEST_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseSseMessage(message: SseMessage): StudioEvent | null {
  if (typeof message.data !== 'string') return null
  let data: unknown
  try {
    data = JSON.parse(message.data)
  } catch {
    return null
  }
  const event = parseStudioEvent(data)
  // The SSE record's `event` and `id` fields must restate the validated payload.
  return event !== null && message.type === event.type && message.lastEventId === event.event_id ? event : null
}

export function createStudioClient(options: StudioClientOptions = {}): StudioClient {
  const fetchImpl = options.fetch ?? ((path: string, init: RequestInit) => globalThis.fetch(path, init))
  const openEventSource = options.openEventSource ?? ((path: string) => new EventSource(path))

  const send = async (path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> => {
    try {
      return await fetchImpl(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: signal ?? null })
    } catch {
      throw new StudioClientError(signal?.aborted ? 'REQUEST_ABORTED' : 'NETWORK_UNAVAILABLE')
    }
  }

  const readJson = async (response: Response, code = 'RESPONSE_INVALID'): Promise<unknown> => {
    if (mediaType(response) !== 'application/json') throw new StudioClientError(code, response.status)
    try {
      return JSON.parse(await response.text()) as unknown
    } catch {
      throw new StudioClientError(code, response.status)
    }
  }

  /** Maps a non-success response to its envelope code; anything else is outside the contract. */
  const rejection = async (response: Response): Promise<StudioClientError> => {
    if (response.status < 400 || response.status > 599) return new StudioClientError('RESPONSE_INVALID', response.status)
    let body: unknown
    try {
      body = await readJson(response)
    } catch {
      return new StudioClientError('RESPONSE_INVALID', response.status)
    }
    const error = isObject(body) && hasExactKeys(body, ['error']) ? body.error : null
    const valid =
      isObject(error) && hasExactKeys(error, ['code', 'message']) && matches(error.code, ERROR_CODE_PATTERN) && typeof error.message === 'string'
    return new StudioClientError(valid ? (error.code as string) : 'RESPONSE_INVALID', response.status)
  }

  const getJson = (path: string, signal: AbortSignal | undefined): Promise<Response> =>
    send(path, { method: 'GET', headers: { Accept: 'application/json' } }, signal)

  const readResult = async (runId: string, signal?: AbortSignal): Promise<ResultRead> => {
    assertRunId(runId)
    const response = await getJson(`/api/runs/${runId}/result`, signal)
    if (response.status === 202) {
      const body = await readJson(response)
      if (!isObject(body) || !hasExactKeys(body, ['state']) || body.state !== 'running') throw new StudioClientError('RESPONSE_INVALID', 202)
      return Object.freeze({ state: 'running' })
    }
    if (response.status !== 200) throw await rejection(response)
    const result = parseStudioRunResult(await readJson(response, 'RESULT_INVALID'))
    if (result === null) throw new StudioClientError('RESULT_INVALID', 200)
    if (result.run_id !== runId) throw new StudioClientError('RESULT_RUN_MISMATCH', 200)
    return Object.freeze({ state: 'finalized', result })
  }

  return Object.freeze({
    async listScenarios(signal?: AbortSignal): Promise<readonly ScenarioSummary[]> {
      const response = await getJson('/api/scenarios', signal)
      if (response.status !== 200) throw await rejection(response)
      const scenarios = parseScenarioList(await readJson(response))
      if (scenarios === null) throw new StudioClientError('RESPONSE_INVALID', 200)
      return scenarios
    },

    async startRun(request: { readonly scenarioId: string; readonly requestText: string }, signal?: AbortSignal): Promise<RunStart> {
      if (!matches(request.scenarioId, KEBAB_ID_PATTERN)) throw new StudioClientError('REQUEST_INVALID')
      if (!isValidRequestText(request.requestText)) throw new StudioClientError('REQUEST_TEXT_INVALID')
      const body = JSON.stringify({ scenario_id: request.scenarioId, request_text: request.requestText })
      const response = await send('/api/runs', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body }, signal)
      if (response.status !== 202) throw await rejection(response)
      const start = parseRunStart(await readJson(response))
      if (start === null) throw new StudioClientError('RESPONSE_INVALID', 202)
      return start
    },

    readResult,

    async pollResult(runId: string, options: { readonly intervalMs?: number; readonly signal?: AbortSignal } = {}): Promise<StudioRunResult> {
      const { intervalMs = DEFAULT_POLL_INTERVAL_MS, signal } = options
      for (;;) {
        const read = await readResult(runId, signal)
        if (read.state === 'finalized') return read.result
        await wait(intervalMs, signal)
      }
    },

    async readCandidateDiff(runId: string, signal?: AbortSignal): Promise<string | null> {
      assertRunId(runId)
      const response = await send(`/api/runs/${runId}/artifacts/candidate-diff`, { method: 'GET', headers: { Accept: 'text/plain' } }, signal)
      if (response.status !== 200) {
        const error = await rejection(response)
        if (response.status === 404 && error.code === 'ARTIFACT_NOT_FOUND') return null
        throw error
      }
      const diff = mediaType(response) === 'text/plain' ? await response.text() : ''
      if (!diff.startsWith(DIFF_PREFIX)) throw new StudioClientError('RESPONSE_INVALID', 200)
      return diff
    },

    async readEvidence(runId: string, evidenceId: string, signal?: AbortSignal): Promise<unknown> {
      const path = evidenceUrl(runId, evidenceId)
      if (evidenceIdParts(evidenceId)?.type === 'screenshot') throw new StudioClientError('REQUEST_INVALID')
      const response = await getJson(path, signal)
      if (response.status !== 200) throw await rejection(response)
      return frozenCopy(await readJson(response))
    },

    openRunEvents(runId: string, handlers: RunEventHandlers): RunEventSubscription {
      assertRunId(runId)
      const source = openEventSource(`/api/runs/${runId}/events`)
      let active = true
      let lastSequence: number | null = null
      // Closing also stops EventSource's automatic reconnect, which would resume without replay.
      const stop = (): boolean => {
        if (!active) return false
        active = false
        source.close()
        return true
      }
      const fail = (code: string): void => {
        if (stop()) handlers.onError(studioError(code))
      }
      const receive = (message: SseMessage): void => {
        if (!active) return
        const event = parseSseMessage(message)
        if (event === null) {
          fail('EVENT_INVALID')
          return
        }
        const violation = eventOrderViolation(runId, lastSequence, event)
        if (violation !== null) {
          fail(violation)
          return
        }
        lastSequence = event.sequence
        if (event.type === 'run_finalized') stop()
        handlers.onEvent(event)
      }
      source.addEventListener('open', () => {
        if (active) handlers.onOpen()
      })
      // Unnamed records are not Studio Events; `receive` rejects them by their `message` type.
      for (const type of ['message', ...STUDIO_EVENT_TYPES]) source.addEventListener(type, receive)
      source.addEventListener('error', () => {
        if (stop()) handlers.onDisconnect()
      })
      return Object.freeze({ close: () => void stop() })
    },
  })
}

// Project demonstration (T030): typed views of the guarded capture and run routes. The browser
// supplies only the confirmed configuration ID, output digest, an optional description and one
// answer; the host owns run, capture, report and model identity.

export interface DemonstrationModelView {
  readonly requested_model: string
  readonly observed_model: string | null
  readonly transport: string
}

export type DemonstrationResultView =
  | {
      readonly status: 'ready'
      readonly observed_problem: string
      readonly intent_summary: string
      readonly support_explanation: string
      readonly expected_conditions: readonly Record<string, unknown>[]
      readonly task_condition_index: number
    }
  | {
      readonly status: 'clarify'
      readonly observed_facts: string
      readonly question: { readonly question_id: string; readonly text: string; readonly missing_intent: string; readonly alternatives: readonly string[] }
    }
  | { readonly status: 'unsupported'; readonly reason: string; readonly explanation: string }

export interface DemonstrationRunView {
  readonly run_id: string
  readonly state: string
  readonly capture_id: string | null
  readonly report: string
  readonly report_sha256: string | null
  readonly analysis_attempt: number | null
  readonly result: DemonstrationResultView | null
  readonly question_id: string | null
  readonly model: DemonstrationModelView | null
}

export class DemonstrationRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
  }
}

const isDemoRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const demoText = (value: unknown): value is string => typeof value === 'string'
const demoOptionalText = (value: unknown): value is string | null => value === null || typeof value === 'string'

function parseDemonstrationResult(input: unknown): DemonstrationResultView | null {
  if (!isDemoRecord(input)) return null
  if (input.status === 'ready') {
    const conditions = input.expected_conditions
    if (!demoText(input.observed_problem) || !demoText(input.intent_summary) || !demoText(input.support_explanation)) return null
    if (!Array.isArray(conditions) || !conditions.every(isDemoRecord) || typeof input.task_condition_index !== 'number') return null
    return {
      status: 'ready',
      observed_problem: input.observed_problem,
      intent_summary: input.intent_summary,
      support_explanation: input.support_explanation,
      expected_conditions: conditions,
      task_condition_index: input.task_condition_index,
    }
  }
  if (input.status === 'clarify') {
    const question = input.question
    if (!demoText(input.observed_facts) || !isDemoRecord(question)) return null
    const alternatives = question.alternatives
    if (!demoText(question.question_id) || !demoText(question.text) || !demoText(question.missing_intent)) return null
    if (!Array.isArray(alternatives) || !alternatives.every(demoText)) return null
    return {
      status: 'clarify',
      observed_facts: input.observed_facts,
      question: { question_id: question.question_id, text: question.text, missing_intent: question.missing_intent, alternatives },
    }
  }
  if (input.status === 'unsupported' && demoText(input.reason) && demoText(input.explanation)) {
    return { status: 'unsupported', reason: input.reason, explanation: input.explanation }
  }
  return null
}

/** Strictly reads the host run view; anything malformed is refused rather than partially shown. */
export function parseDemonstrationRunView(input: unknown): DemonstrationRunView | null {
  if (!isDemoRecord(input)) return null
  const { run_id, state, capture_id, report, report_sha256, interpretation, question_id, model } = input
  if (!demoText(run_id) || !demoText(state) || !demoOptionalText(capture_id) || !demoText(report) || !demoOptionalText(report_sha256) || !demoOptionalText(question_id)) return null
  let result: DemonstrationResultView | null = null
  let attempt: number | null = null
  if (interpretation !== null && interpretation !== undefined) {
    if (!isDemoRecord(interpretation) || typeof interpretation.analysis_attempt !== 'number') return null
    result = parseDemonstrationResult(interpretation.result)
    if (result === null) return null
    attempt = interpretation.analysis_attempt
  }
  let modelView: DemonstrationModelView | null = null
  if (model !== null && model !== undefined) {
    if (!isDemoRecord(model) || !demoText(model.requested_model) || !demoOptionalText(model.observed_model) || !demoText(model.transport)) return null
    modelView = { requested_model: model.requested_model, observed_model: model.observed_model, transport: model.transport }
  }
  return { run_id, state, capture_id, report, report_sha256, analysis_attempt: attempt, result, question_id, model: modelView }
}

async function demonstrationRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  let value: unknown = null
  try {
    value = await response.json()
  } catch {
    value = null
  }
  if (!response.ok) {
    const error = isDemoRecord(value) && isDemoRecord(value.error) ? value.error : null
    throw new DemonstrationRequestError(error !== null && demoText(error.code) ? error.code : 'REQUEST_FAILED', response.status)
  }
  if (!isDemoRecord(value)) throw new DemonstrationRequestError('RESPONSE_INVALID', response.status)
  return value
}

const demoId = (value: unknown): string => {
  if (!demoText(value)) throw new DemonstrationRequestError('RESPONSE_INVALID', 200)
  return value
}

export const demonstrationApi = {
  async start(configurationId: string, outputSha256: string): Promise<{ readonly runId: string; readonly captureId: string }> {
    const value = await demonstrationRequest('/api/project/captures', 'POST', { configuration_id: configurationId, output_sha256: outputSha256 })
    return { runId: demoId(value.run_id), captureId: demoId(value.capture_id) }
  },
  async finish(captureId: string): Promise<{ readonly state: string; readonly reportSha256: string | null }> {
    const value = await demonstrationRequest(`/api/project/captures/${encodeURIComponent(captureId)}/finish`, 'POST', {})
    if (!demoText(value.state) || !demoOptionalText(value.report_sha256)) throw new DemonstrationRequestError('RESPONSE_INVALID', 200)
    return { state: value.state, reportSha256: value.report_sha256 }
  },
  async discard(captureId: string): Promise<void> {
    await demonstrationRequest(`/api/project/captures/${encodeURIComponent(captureId)}/discard`, 'POST', {})
  },
  async analyze(captureId: string, description: string): Promise<void> {
    const trimmed = description.trim()
    await demonstrationRequest(`/api/project/captures/${encodeURIComponent(captureId)}/analyze`, 'POST', trimmed === '' ? { submit: true } : { submit: true, description: trimmed })
  },
  async clarify(runId: string, questionId: string, answer: string): Promise<void> {
    await demonstrationRequest(`/api/project/runs/${encodeURIComponent(runId)}/clarify`, 'POST', { question_id: questionId, answer })
  },
  async cancel(runId: string): Promise<void> {
    await demonstrationRequest(`/api/project/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {})
  },
  async view(runId: string): Promise<DemonstrationRunView> {
    const parsed = parseDemonstrationRunView(await demonstrationRequest(`/api/project/runs/${encodeURIComponent(runId)}`, 'GET'))
    if (parsed === null) throw new DemonstrationRequestError('RESPONSE_INVALID', 200)
    return parsed
  },
}
