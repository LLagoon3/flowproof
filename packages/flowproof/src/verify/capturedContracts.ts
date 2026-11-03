import { z } from 'zod'

import {
  GATE_STATUSES,
  REASON_CODE_PATTERN,
  evidenceIdSchema,
  issueReporter,
  kebabIdSchema,
  millisecondsSchema,
  sha256Schema,
  timestampSchema,
  uuidSchema,
} from '../contracts/index.js'
import type { GateStatus } from '../contracts/index.js'
import { SUBMODULE_COVERAGE_NOTE } from '../editing/capture.js'
import { SNAPSHOT_FACETS } from '../git/repositoryState.js'

// The strict captured-verification result family of specs/004-verify-captured-changes. It is a
// sibling of the unchanged legacy Run Result, explicitly discriminated by `kind`, with its own
// `schema_version` 1.0.0. A result carries the exact candidate identity, ten fixed mandatory checks,
// a safe outcome, same-run evidence references, and cleanup facts. It has no Diagnosis, provider,
// citation, legacy gate, patch, raw-path, argv, or host-locator field, and it is never labelled
// `Verified Fix`: a passing result means "Candidate verification passed" only.
//
// Every reason code is from a closed set with one fixed message, so a result can never carry
// command output, exception text, scanner findings, content, or host paths.

export const CAPTURED_RESULT_KIND = 'captured-verification'
export const CAPTURED_SCHEMA_VERSION = '1.0.0'

/** The ten mandatory checks, in data-model order. */
export const CAPTURED_CHECK_IDS = [
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
] as const
export type CapturedCheckId = (typeof CAPTURED_CHECK_IDS)[number]
export type CapturedCheckStatus = GateStatus

export const CAPTURED_STATUSES = ['passed', 'failed', 'error', 'interrupted'] as const
export type CapturedStatus = (typeof CAPTURED_STATUSES)[number]

/** How a run ended before reduction: normally, or stopped by inability, timeout, or close. */
export type CapturedTermination = 'completed' | 'error' | 'timeout' | 'interrupted'

/** Fixed check reasons; each has exactly one status and one message. */
export const CAPTURED_CHECK_REASONS = {
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
} as const satisfies Record<string, readonly [CapturedCheckStatus, string]>
export type CapturedCheckReason = keyof typeof CAPTURED_CHECK_REASONS

/** Reasons any check may report when it could not be evaluated. */
const UNEVALUABLE_REASONS = ['CHECK_NOT_EVALUATED', 'STAGE_ERROR', 'RUN_TIMEOUT', 'RUN_INTERRUPTED'] as const satisfies readonly CapturedCheckReason[]

/** The evaluated reasons each check may report, beside the shared unevaluable reasons. */
const CHECK_REASONS: Readonly<Record<CapturedCheckId, readonly CapturedCheckReason[]>> = {
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

/** Fixed outcome reasons of non-passing results, with the status each one belongs to. */
export const CAPTURED_OUTCOME_REASONS = {
  BASELINE_NOT_CONFIRMED: ['failed', 'The prepared defect was not confirmed on the baseline, so the candidate was not verified.'],
  APPLICATION_FAILED: ['failed', 'The candidate could not be applied completely at its recorded baseline, so it was not verified.'],
  CANDIDATE_FAILED: ['failed', 'A mandatory candidate check failed, so the candidate was not verified.'],
  FINALIZATION_FAILED: ['failed', 'Secret scanning, cleanup, or original-integrity checks failed, so the run cannot pass.'],
  VERIFICATION_ERROR: ['error', 'A verification stage could not be executed, so the candidate was not verified.'],
  RUN_TIMEOUT: ['interrupted', 'The run exceeded its scenario time window and was cancelled.'],
  RUN_INTERRUPTED: ['interrupted', 'The Studio closed or the process was interrupted, so the run was cancelled.'],
} as const satisfies Record<string, readonly [Exclude<CapturedStatus, 'passed'>, string]>
export type CapturedOutcomeReason = keyof typeof CAPTURED_OUTCOME_REASONS

/** The outcome reason of a `failed` result follows its first failing check in canonical order. */
const FAILED_OUTCOME: Readonly<Record<CapturedCheckId, CapturedOutcomeReason>> = {
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

/** Safe categories of owned resources that cleanup could not release. */
export const CAPTURED_CLEANUP_RESOURCES = ['target_runtime', 'browser_capture', 'operation', 'worktree', 'private_git_state'] as const
export type CapturedCleanupResource = (typeof CAPTURED_CLEANUP_RESOURCES)[number]

/** Original-snapshot facets that differ; `snapshot` means the comparison itself failed. */
export const CAPTURED_ORIGINAL_MISMATCHES = [...SNAPSHOT_FACETS, 'snapshot'] as const
export type CapturedOriginalMismatch = (typeof CAPTURED_ORIGINAL_MISMATCHES)[number]

const MAX_METRICS = 8
const METRIC_KEY = /^[a-z][a-z0-9_]{0,39}$/

/** A captured contract violation; the message names a field only, never a value. */
export class CapturedContractError extends Error {
  readonly code = 'CAPTURED_CONTRACT_INVALID'

  constructor(field: string) {
    super(`CAPTURED_CONTRACT_INVALID: the captured verification value is invalid at ${field}.`)
    this.name = 'CapturedContractError'
  }
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/** A full lowercase SHA-1 (40) or SHA-256 (64) Git object ID; never abbreviated. */
const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

function uniqueArray<T extends z.ZodType>(item: T) {
  return z.array(item).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) issueReporter(ctx)([], 'NOT_UNIQUE')
  })
}

const metricsSchema = z
  .record(z.string().regex(METRIC_KEY), z.union([z.number(), z.boolean(), z.null()]))
  .refine((metrics) => Object.keys(metrics).length <= MAX_METRICS, { message: 'TOO_MANY_METRICS' })

/** Which same-run evidence each check may cite; all other checks cite none. */
const EVIDENCE_SCOPE: Partial<Readonly<Record<CapturedCheckId, RegExp>>> = {
  baseline_reproduced: /^ev_failure_[a-z]+_[0-9]{3}$/,
  dataset_matches: /^ev_replay_dataset_[0-9]{3}$/,
  canvas_matches: /^ev_replay_chart_[0-9]{3}$/,
}

const CheckSchema = z
  .strictObject({
    check_id: z.enum(CAPTURED_CHECK_IDS),
    status: z.enum(GATE_STATUSES),
    reason_code: z.string().regex(REASON_CODE_PATTERN),
    message: z.string().min(1).max(500),
    evidence_ids: uniqueArray(evidenceIdSchema).max(8),
    metrics: metricsSchema,
  })
  .superRefine((check, ctx) => {
    const issue = issueReporter(ctx)
    const reason = check.reason_code as CapturedCheckReason
    const allowed = [...CHECK_REASONS[check.check_id], ...UNEVALUABLE_REASONS] as readonly string[]
    if (!allowed.includes(reason) || !(reason in CAPTURED_CHECK_REASONS)) {
      issue(['reason_code'], 'CHECK_REASON_INVALID')
      return
    }
    const [status, message] = CAPTURED_CHECK_REASONS[reason]
    if (check.status !== status) issue(['status'], 'CHECK_STATUS_REASON_MISMATCH')
    if (check.message !== message) issue(['message'], 'CHECK_MESSAGE_NOT_FIXED')
    const scope = EVIDENCE_SCOPE[check.check_id]
    if (check.evidence_ids.some((id) => scope === undefined || !scope.test(id))) issue(['evidence_ids'], 'CHECK_EVIDENCE_OUT_OF_SCOPE')
  })

const evidenceReferenceSchema = (phase: 'failure' | 'replay') =>
  z.strictObject({
    manifest_path: z.literal(`evidence/${phase}/manifest.json`),
    screenshot_path: z.literal(`evidence/${phase}/screenshot.png`),
  })

const CleanupSchema = z
  .strictObject({
    complete: z.boolean(),
    remaining_owned_resources: uniqueArray(z.enum(CAPTURED_CLEANUP_RESOURCES)),
    original_unchanged: z.boolean(),
    original_mismatches: uniqueArray(z.enum(CAPTURED_ORIGINAL_MISMATCHES)),
  })
  .superRefine((cleanup, ctx) => {
    const issue = issueReporter(ctx)
    if (cleanup.complete !== (cleanup.remaining_owned_resources.length === 0)) issue(['complete'], 'CLEANUP_RESIDUE_MISMATCH')
    if (cleanup.original_unchanged !== (cleanup.original_mismatches.length === 0)) issue(['original_unchanged'], 'ORIGINAL_MISMATCH_CONTRADICTION')
  })

const CoverageSchema = z.strictObject({
  scope: z.literal('main_repository'),
  note: z.literal(SUBMODULE_COVERAGE_NOTE).nullable(),
})

const PhaseDurationsSchema = z.strictObject({
  reproduce: millisecondsSchema,
  apply: millisecondsSchema,
  build: millisecondsSchema,
  test: millisecondsSchema,
  replay: millisecondsSchema,
  finalize: millisecondsSchema,
})

export const CAPTURED_RESULT_FIELDS = [
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

export const CapturedVerificationResultSchema = z
  .strictObject({
    kind: z.literal(CAPTURED_RESULT_KIND),
    schema_version: z.literal(CAPTURED_SCHEMA_VERSION),
    run_id: uuidSchema,
    request_id: uuidSchema,
    scenario_id: kebabIdSchema,
    editing_session_id: uuidSchema,
    baseline_commit: objectIdSchema,
    candidate_patch_sha256: sha256Schema,
    coverage: CoverageSchema,
    status: z.enum(CAPTURED_STATUSES),
    reason_code: z.enum(Object.keys(CAPTURED_OUTCOME_REASONS) as [CapturedOutcomeReason, ...CapturedOutcomeReason[]]).nullable(),
    message: z.string().min(1).max(500).nullable(),
    checks: z.array(CheckSchema).length(CAPTURED_CHECK_IDS.length),
    before_evidence: evidenceReferenceSchema('failure').nullable(),
    after_evidence: evidenceReferenceSchema('replay').nullable(),
    cleanup: CleanupSchema,
    started_at: timestampSchema,
    completed_at: timestampSchema,
    total_duration_ms: millisecondsSchema,
    phase_durations_ms: PhaseDurationsSchema,
  })
  .superRefine((result, ctx) => {
    const issue = issueReporter(ctx)
    if (result.checks.some((check, index) => check.check_id !== CAPTURED_CHECK_IDS[index])) issue(['checks'], 'CHECKS_NOT_CANONICAL')
    if (new Set([result.run_id, result.request_id, result.editing_session_id]).size !== 3) issue(['editing_session_id'], 'IDENTITIES_NOT_DISTINCT')
    const byId = new Map(result.checks.map((check) => [check.check_id, check]))
    const statusOf = (id: CapturedCheckId): CapturedCheckStatus | undefined => byId.get(id)?.status
    if ((statusOf('cleanup_complete') === 'pass') !== result.cleanup.complete) issue(['cleanup'], 'CLEANUP_CHECK_MISMATCH')
    if ((statusOf('original_unchanged') === 'pass') !== result.cleanup.original_unchanged) issue(['cleanup'], 'INTEGRITY_CHECK_MISMATCH')
    if (statusOf('baseline_reproduced') === 'pass' && result.before_evidence === null) issue(['before_evidence'], 'EVIDENCE_REQUIRED')
    if ((statusOf('dataset_matches') === 'pass' || statusOf('canvas_matches') === 'pass') && result.after_evidence === null) {
      issue(['after_evidence'], 'EVIDENCE_REQUIRED')
    }

    if (result.status === 'passed') {
      if (result.checks.length !== CAPTURED_CHECK_IDS.length || result.checks.some((check) => check.status !== 'pass')) issue(['status'], 'PASSED_REQUIRES_ALL_CHECKS')
      if (result.before_evidence === null || result.after_evidence === null) issue(['status'], 'PASSED_REQUIRES_EVIDENCE')
      if (!result.cleanup.complete || !result.cleanup.original_unchanged) issue(['status'], 'PASSED_REQUIRES_CLEANUP')
      if (result.reason_code !== null) issue(['reason_code'], 'PASSED_FORBIDS_REASON')
      if (result.message !== null) issue(['message'], 'PASSED_FORBIDS_REASON')
      return
    }
    if (result.reason_code === null) {
      issue(['reason_code'], 'REASON_REQUIRED')
      return
    }
    const [status, message] = CAPTURED_OUTCOME_REASONS[result.reason_code]
    if (status !== result.status) issue(['reason_code'], 'REASON_STATUS_MISMATCH')
    if (result.message !== message) issue(['message'], 'MESSAGE_NOT_FIXED')
    if (result.status === 'failed') {
      const first = result.checks.find((check) => check.status === 'fail')
      if (first === undefined) issue(['status'], 'FAILED_REQUIRES_FAILING_CHECK')
      else if (FAILED_OUTCOME[first.check_id] !== result.reason_code) issue(['reason_code'], 'REASON_NOT_FIRST_FAILURE')
    }
  })

export type CapturedCheck = z.infer<typeof CheckSchema>
export type CapturedEvidenceReference = { readonly manifest_path: string; readonly screenshot_path: string }
export type CapturedCleanupFacts = z.infer<typeof CleanupSchema>
export type CapturedPhaseDurations = z.infer<typeof PhaseDurationsSchema>
export type CapturedVerificationResult = z.infer<typeof CapturedVerificationResultSchema>

// ---------------------------------------------------------------------------------------
// Safe parsing
// ---------------------------------------------------------------------------------------

export interface CapturedContractIssue {
  readonly path: string
  readonly code: string
}

export type CapturedParseResult =
  | { readonly ok: true; readonly value: CapturedVerificationResult }
  | { readonly ok: false; readonly error: { readonly code: 'CONTRACT_INVALID' | 'SCHEMA_VERSION_UNSUPPORTED'; readonly issues: readonly CapturedContractIssue[] } }

/** Fields whose keys are untrusted record input; an issue path stops at the field itself. */
const RECORD_FIELDS: ReadonlySet<PropertyKey> = new Set(['metrics'])

function toIssue(issue: z.core.$ZodIssue): CapturedContractIssue {
  const record = issue.path.findIndex((segment) => RECORD_FIELDS.has(segment))
  const path = (record === -1 ? issue.path : issue.path.slice(0, record + 1)).map(String).join('.') || '(root)'
  const custom = issue.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : undefined
  const code = typeof custom === 'string' && REASON_CODE_PATTERN.test(custom) ? custom : issue.code.toUpperCase()
  return Object.freeze({ path, code })
}

/**
 * Parses untrusted input against the captured family. Errors carry only field paths and stable
 * codes: never the rejected value, the library message, unrecognized key names, or metric keys.
 */
export function parseCapturedVerificationResult(input: unknown): CapturedParseResult {
  if (typeof input === 'object' && input !== null && 'schema_version' in input && (input as { schema_version: unknown }).schema_version !== CAPTURED_SCHEMA_VERSION) {
    const issues = Object.freeze([Object.freeze({ path: 'schema_version', code: 'SCHEMA_VERSION_UNSUPPORTED' })])
    return { ok: false, error: Object.freeze({ code: 'SCHEMA_VERSION_UNSUPPORTED', issues }) }
  }
  const parsed = CapturedVerificationResultSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: Object.freeze({ code: 'CONTRACT_INVALID', issues: Object.freeze(parsed.error.issues.map(toIssue)) }) }
}

// ---------------------------------------------------------------------------------------
// Checks and reduction
// ---------------------------------------------------------------------------------------

export interface CapturedCheckInit {
  readonly evidence_ids?: readonly string[]
  readonly metrics?: Readonly<Record<string, number | boolean | null>>
}

/** Builds one check; its status and fixed message follow from the reason. Throws on misuse. */
export function capturedCheck(checkId: CapturedCheckId, reasonCode: CapturedCheckReason, init: CapturedCheckInit = {}): CapturedCheck {
  const entry = (CAPTURED_CHECK_REASONS as Record<string, readonly [CapturedCheckStatus, string] | undefined>)[reasonCode]
  const parsed = CheckSchema.safeParse({
    check_id: checkId,
    status: entry?.[0],
    reason_code: reasonCode,
    message: entry?.[1],
    evidence_ids: [...(init.evidence_ids ?? [])],
    metrics: { ...(init.metrics ?? {}) },
  })
  if (entry === undefined || !parsed.success) throw new CapturedContractError(`checks.${String(checkId)}`)
  const check = parsed.data
  Object.freeze(check.evidence_ids)
  Object.freeze(check.metrics)
  return Object.freeze(check)
}

export interface CapturedReductionInput {
  /** Evaluated checks, in any order; unreported checks become `unevaluable`. */
  readonly checks: readonly CapturedCheck[]
  readonly termination: CapturedTermination
  readonly before_evidence: CapturedEvidenceReference | null
  readonly after_evidence: CapturedEvidenceReference | null
  readonly cleanup: CapturedCleanupFacts
}

export interface CapturedReduction {
  readonly status: CapturedStatus
  readonly reason_code: CapturedOutcomeReason | null
  readonly message: string | null
  /** Exactly ten checks in canonical order. */
  readonly checks: readonly CapturedCheck[]
}

/** The cleanup and integrity checks always restate the cleanup facts; a failure there wins. */
function factChecks(cleanup: CapturedCleanupFacts): readonly [CapturedCheck, CapturedCheck] {
  const parsed = CleanupSchema.safeParse(cleanup)
  if (!parsed.success) throw new CapturedContractError('cleanup')
  const facts = parsed.data
  const integrity: CapturedCheckReason = facts.original_unchanged
    ? 'ORIGINAL_UNCHANGED'
    : facts.original_mismatches.includes('snapshot')
      ? 'ORIGINAL_INTEGRITY_UNVERIFIED'
      : 'ORIGINAL_CHANGED'
  return [capturedCheck('cleanup_complete', facts.complete ? 'CLEANUP_COMPLETE' : 'CLEANUP_INCOMPLETE'), capturedCheck('original_unchanged', integrity)]
}

/**
 * A passing evidence-dependent check needs its same-run evidence reference. Without it the check
 * reports its existing evidence failure and cites no evidence, so no terminal result can carry a
 * pass that the result contract rejects.
 */
function evidenceChecked(check: CapturedCheck, input: CapturedReductionInput): CapturedCheck {
  if (check.status !== 'pass') return check
  if (check.check_id === 'baseline_reproduced' && input.before_evidence === null) return capturedCheck(check.check_id, 'BASELINE_EVIDENCE_INCOMPLETE')
  if ((check.check_id === 'dataset_matches' || check.check_id === 'canvas_matches') && input.after_evidence === null) {
    return capturedCheck(check.check_id, 'REPLAY_EVIDENCE_INCOMPLETE')
  }
  return check
}

const outcome = (reason: CapturedOutcomeReason): Pick<CapturedReduction, 'status' | 'reason_code' | 'message'> => ({
  status: CAPTURED_OUTCOME_REASONS[reason][0],
  reason_code: reason,
  message: CAPTURED_OUTCOME_REASONS[reason][1],
})

/**
 * Reduces evaluated checks to the final outcome. A passing result requires all ten checks to pass,
 * with required evidence and complete cleanup; a passing check whose evidence is missing fails.
 * Failed input/checks are `failed`; operational inability, including a partial report, is `error`;
 * timeout and close are `interrupted`.
 */
export function reduceCapturedVerification(input: CapturedReductionInput): CapturedReduction {
  const reported = new Map<CapturedCheckId, CapturedCheck>()
  for (const candidate of input.checks) {
    const parsed = CheckSchema.safeParse(candidate)
    if (!parsed.success) throw new CapturedContractError('checks')
    if (reported.has(parsed.data.check_id)) throw new CapturedContractError(`checks.${parsed.data.check_id}`)
    reported.set(parsed.data.check_id, capturedCheck(parsed.data.check_id, parsed.data.reason_code as CapturedCheckReason, parsed.data))
  }
  const [cleanupCheck, integrityCheck] = factChecks(input.cleanup)
  const checks = Object.freeze(
    CAPTURED_CHECK_IDS.map((id) => {
      if (id === 'cleanup_complete') return cleanupCheck
      if (id === 'original_unchanged') return integrityCheck
      const check = reported.get(id)
      return check === undefined ? capturedCheck(id, 'CHECK_NOT_EVALUATED') : evidenceChecked(check, input)
    }),
  )
  const allPass = checks.every((check) => check.status === 'pass') && input.before_evidence !== null && input.after_evidence !== null
  let result: Pick<CapturedReduction, 'status' | 'reason_code' | 'message'>
  if (input.termination === 'timeout') result = outcome('RUN_TIMEOUT')
  else if (input.termination === 'interrupted') result = outcome('RUN_INTERRUPTED')
  else if (input.termination === 'error') result = outcome('VERIFICATION_ERROR')
  else if (allPass) result = { status: 'passed', reason_code: null, message: null }
  else {
    const first = checks.find((check) => check.status === 'fail')
    result = first === undefined ? outcome('VERIFICATION_ERROR') : outcome(FAILED_OUTCOME[first.check_id])
  }
  return Object.freeze({ ...result, checks })
}
