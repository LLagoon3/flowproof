import { posix } from 'node:path'

import { z } from 'zod'

// Runtime mirrors of the committed JSON Schemas in specs/001-verify-debugging-fix/contracts/.
// Every object is strict so untrusted input cannot smuggle configuration, and every
// cross-field invariant the schemas document is enforced here before data is used.

export const CONTRACT_SCHEMA_VERSION = '1.0.0'
export const META_MODEL_ID = 'muse-spark-1.3'

export const SCENARIO_CASES = ['hero', 'failure-invalid-citation'] as const
export const PROVIDER_MODES = ['meta', 'fixture'] as const
export const EVIDENCE_PHASES = ['failure', 'replay'] as const
export const EVIDENCE_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'] as const
export const REDACTION_CATEGORIES = ['credential', 'header', 'query', 'cookie', 'body', 'path'] as const
export const PROVENANCE_ORIGINS = ['scenario', 'browser', 'repository'] as const
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
] as const
export const GATE_STATUSES = ['pass', 'fail', 'unevaluable'] as const
export const RUN_STATES = [
  'initialized',
  'reproducing',
  'failure_captured',
  'diagnosing',
  'candidate_validated',
  'applying',
  'replaying',
  'finalized',
] as const
export const RUN_STATUSES = ['Verified Fix', 'Unverified'] as const
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
] as const

export const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const GIT_OID_PATTERN = /^[a-f0-9]{40}$/
export const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
export const EVIDENCE_ID_PATTERN =
  /^ev_(failure|replay)_(actions|dataset|chart|screenshot|console|network|source)_([0-9]{3})$/
export const LOCALHOST_APP_URL_PATTERN = /^http:\/\/localhost:[0-9]+(?:\/.*)?$/
const FAILURE_EVIDENCE_ID_PATTERN =
  /^ev_failure_(?:actions|dataset|chart|screenshot|console|network|source)_[0-9]{3}$/
const STUDIO_EVENT_ID_PATTERN = /^[0-9a-fA-F-]{36}:[1-9][0-9]*$/

export type ScenarioCase = (typeof SCENARIO_CASES)[number]
export type ProviderMode = (typeof PROVIDER_MODES)[number]
export type EvidencePhase = (typeof EVIDENCE_PHASES)[number]
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number]
export type GateId = (typeof GATE_IDS)[number]
export type GateStatus = (typeof GATE_STATUSES)[number]
export type RunState = (typeof RUN_STATES)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]
export type StudioEventType = (typeof STUDIO_EVENT_TYPES)[number]

type Issue = (path: PropertyKey[], code: string) => void

// Reports a cross-field violation by path and stable code only. Messages and params never
// carry the rejected value, so contract errors cannot echo secrets or model text.
export function issueReporter(ctx: z.RefinementCtx): Issue {
  return (path, code) => ctx.addIssue({ code: 'custom', path, message: code, params: { code } })
}

function uniqueArray<T extends z.ZodType>(item: T) {
  return z.array(item).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) issueReporter(ctx)([], 'NOT_UNIQUE')
  })
}

export const kebabIdSchema = z.string().regex(KEBAB_ID_PATTERN)
export const relativePathSchema = z.string().min(1).regex(RELATIVE_PATH_PATTERN)
export const sha256Schema = z.string().regex(SHA256_PATTERN)
export const gitOidSchema = z.string().regex(GIT_OID_PATTERN)
export const uuidSchema = z.uuid()
export const timestampSchema = z.iso.datetime()
export const reasonCodeSchema = z.string().regex(REASON_CODE_PATTERN)
export const millisecondsSchema = z.int().min(0)
export const evidenceIdSchema = z.string().regex(EVIDENCE_ID_PATTERN)
export const localhostAppUrlSchema = z.string().regex(LOCALHOST_APP_URL_PATTERN)

/** True when two repository-relative paths name the same file or one contains the other. */
export function repositoryPathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string): string => posix.normalize(value).replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

// ---------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------

export const ScenarioActionSchema = z.strictObject({
  action_id: kebabIdSchema,
  type: z.literal('select'),
  selector: z.string().min(1),
  value: z.string().min(1),
})

export const ScenarioSchema = z
  .strictObject({
    schema_version: z.literal(CONTRACT_SCHEMA_VERSION),
    scenario_id: kebabIdSchema,
    case: z.enum(SCENARIO_CASES),
    default_request: z.string().min(1).max(500),
    app: z.strictObject({
      root: relativePathSchema,
      url: localhostAppUrlSchema,
      start_command: z.array(z.string().min(1)).min(1),
      viewport: z.strictObject({
        width: z.int().min(800).max(2560),
        height: z.int().min(600).max(1440),
        device_scale_factor: z.literal(1),
      }),
      canvas: z.strictObject({
        width: z.int().min(320).max(1600),
        height: z.int().min(240).max(1200),
      }),
    }),
    actions: z.array(ScenarioActionSchema).min(1).max(1),
    oracle: z.strictObject({
      dataset_path: relativePathSchema,
      chart_path: relativePathSchema,
    }),
    permitted_source_paths: uniqueArray(relativePathSchema).min(1).max(1),
    provider: z.strictObject({
      mode: z.enum(PROVIDER_MODES),
      fixture_path: relativePathSchema.nullable(),
      injected_fault_label: z.string().nullable(),
    }),
    timeouts: z.strictObject({
      capture_ms: z.int().min(1).max(45_000),
      model_ms: z.int().min(1).max(90_000),
      replay_ms: z.int().min(1).max(120_000),
      total_ms: z.int().min(1).max(300_000),
    }),
  })
  .superRefine((scenario, ctx) => {
    const issue = issueReporter(ctx)
    const { provider } = scenario
    const requiredMode: ProviderMode = scenario.case === 'hero' ? 'meta' : 'fixture'
    if (provider.mode !== requiredMode) issue(['provider', 'mode'], 'PROVIDER_MODE_CASE_MISMATCH')
    if (provider.mode === 'meta') {
      if (provider.fixture_path !== null) issue(['provider', 'fixture_path'], 'PROVIDER_FIXTURE_FORBIDDEN')
      if (provider.injected_fault_label !== null) {
        issue(['provider', 'injected_fault_label'], 'PROVIDER_FAULT_LABEL_FORBIDDEN')
      }
    } else {
      if (provider.fixture_path === null) issue(['provider', 'fixture_path'], 'PROVIDER_FIXTURE_REQUIRED')
      if (!provider.injected_fault_label) issue(['provider', 'injected_fault_label'], 'PROVIDER_FAULT_LABEL_REQUIRED')
    }
    const guarded: Array<[PropertyKey[], string | null]> = [
      [['oracle', 'dataset_path'], scenario.oracle.dataset_path],
      [['oracle', 'chart_path'], scenario.oracle.chart_path],
      [['provider', 'fixture_path'], provider.fixture_path],
    ]
    for (const [path, candidate] of guarded) {
      if (candidate === null) continue
      if (scenario.permitted_source_paths.some((source) => repositoryPathsOverlap(candidate, source))) {
        issue(path, 'PATH_OVERLAPS_SOURCE_BOUNDARY')
      }
    }
  })

export type ScenarioAction = z.infer<typeof ScenarioActionSchema>
export type Scenario = z.infer<typeof ScenarioSchema>

// ---------------------------------------------------------------------------------------
// Evidence Bundle
// ---------------------------------------------------------------------------------------

export const RedactionSchema = z.strictObject({
  category: z.enum(REDACTION_CATEGORIES),
  count: z.int().min(1),
})

export const EvidenceItemSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  run_id: uuidSchema,
  phase: z.enum(EVIDENCE_PHASES),
  type: z.enum(EVIDENCE_TYPES),
  captured_at: timestampSchema,
  artifact_path: relativePathSchema,
  sha256: sha256Schema,
  summary: z.string().min(1).max(500),
  provenance: z.strictObject({
    mechanism: z.string().min(1),
    origin: z.enum(PROVENANCE_ORIGINS),
    trusted: z.boolean(),
    source_path: relativePathSchema.nullable(),
  }),
  redactions: z.array(RedactionSchema),
})

const REQUIRED_EVIDENCE_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network'] as const

export const EvidenceBundleSchema = z
  .strictObject({
    schema_version: z.literal(CONTRACT_SCHEMA_VERSION),
    run_id: uuidSchema,
    scenario_id: kebabIdSchema,
    phase: z.enum(EVIDENCE_PHASES),
    items: z.array(EvidenceItemSchema).min(6).max(7),
    manifest_sha256: sha256Schema,
  })
  .superRefine((bundle, ctx) => {
    const issue = issueReporter(ctx)
    const seen = new Set<string>()
    bundle.items.forEach((item, index) => {
      if (item.run_id !== bundle.run_id) issue(['items', index, 'run_id'], 'EVIDENCE_RUN_MISMATCH')
      if (item.phase !== bundle.phase) issue(['items', index, 'phase'], 'EVIDENCE_PHASE_MISMATCH')
      const match = EVIDENCE_ID_PATTERN.exec(item.evidence_id)
      if (match?.[1] !== item.phase || match[2] !== item.type) {
        issue(['items', index, 'evidence_id'], 'EVIDENCE_ID_SEGMENT_MISMATCH')
      }
      if (seen.has(item.evidence_id)) issue(['items', index, 'evidence_id'], 'EVIDENCE_ID_DUPLICATE')
      seen.add(item.evidence_id)
      // Source evidence must name the exact permitted file it was read from.
      if (item.type === 'source' && (item.provenance.origin !== 'repository' || item.provenance.source_path === null)) {
        issue(['items', index, 'provenance'], 'SOURCE_PROVENANCE_REQUIRED')
      }
    })
    const count = (type: EvidenceType): number => bundle.items.filter((item) => item.type === type).length
    const sourceCount = count('source')
    const complete =
      REQUIRED_EVIDENCE_TYPES.every((type) => count(type) === 1) &&
      (bundle.phase === 'failure' ? sourceCount === 1 : sourceCount <= 1)
    if (!complete) issue(['items'], 'EVIDENCE_TYPES_INCOMPLETE')
  })

export type Redaction = z.infer<typeof RedactionSchema>
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>

// ---------------------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------------------

const failureEvidenceIdSchema = z.string().regex(FAILURE_EVIDENCE_ID_PATTERN)

export const DiagnosisSchema = z.strictObject({
  summary: z.string().min(1).max(1000),
  root_cause: z.string().min(1).max(2000),
  claims: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(1000),
        evidence_ids: uniqueArray(failureEvidenceIdSchema).min(1),
      }),
    )
    .min(1),
  candidate: z.strictObject({
    target_paths: uniqueArray(relativePathSchema).min(1).max(1),
    evidence_ids: uniqueArray(failureEvidenceIdSchema).min(1),
    unified_diff: z.string().min(1).max(20_000).regex(/^diff --git a\//),
  }),
})

export type Diagnosis = z.infer<typeof DiagnosisSchema>

// ---------------------------------------------------------------------------------------
// Gate outcomes
// ---------------------------------------------------------------------------------------

export const GateSummarySchema = z.strictObject({
  gate_id: z.enum(GATE_IDS),
  status: z.enum(GATE_STATUSES),
  reason_code: reasonCodeSchema,
})

export const GateOutcomeSchema = z.strictObject({
  gate_id: z.enum(GATE_IDS),
  status: z.enum(GATE_STATUSES),
  evidence_ids: uniqueArray(evidenceIdSchema),
  reason_code: reasonCodeSchema,
  message: z.string().min(1).max(500),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})

export type GateSummary = z.infer<typeof GateSummarySchema>
export type GateOutcome = z.infer<typeof GateOutcomeSchema>

// ---------------------------------------------------------------------------------------
// Studio Event
// ---------------------------------------------------------------------------------------

export const StudioEventSchema = z
  .strictObject({
    schema_version: z.literal(CONTRACT_SCHEMA_VERSION),
    event_id: z.string().regex(STUDIO_EVENT_ID_PATTERN),
    run_id: uuidSchema,
    sequence: z.int().min(1),
    occurred_at: timestampSchema,
    type: z.enum(STUDIO_EVENT_TYPES),
    phase: z.enum(RUN_STATES).nullable(),
    message: z.string().min(1).max(500),
    evidence_ids: uniqueArray(evidenceIdSchema),
    gate: GateSummarySchema.nullable(),
    artifact_refs: uniqueArray(relativePathSchema),
  })
  .superRefine((event, ctx) => {
    const issue = issueReporter(ctx)
    if (event.event_id !== `${event.run_id}:${event.sequence}`) issue(['event_id'], 'EVENT_ID_MISMATCH')
    if (event.type === 'gate_updated' && event.gate === null) issue(['gate'], 'GATE_SUMMARY_REQUIRED')
    if (event.type !== 'gate_updated' && event.gate !== null) issue(['gate'], 'GATE_SUMMARY_FORBIDDEN')
    if (event.type === 'evidence_added' && event.evidence_ids.length === 0) {
      issue(['evidence_ids'], 'EVIDENCE_IDS_REQUIRED')
    }
  })

export type StudioEvent = z.infer<typeof StudioEventSchema>

// ---------------------------------------------------------------------------------------
// Verification and Run Result
// ---------------------------------------------------------------------------------------

export const PhaseDurationsSchema = z.strictObject({
  capture: millisecondsSchema,
  model: millisecondsSchema,
  apply: millisecondsSchema,
  replay: millisecondsSchema,
  finalize: millisecondsSchema,
})

export const verificationResultShape = {
  status: z.enum(RUN_STATUSES),
  gates: z.array(GateOutcomeSchema).min(9).max(9),
  failed_gate_ids: uniqueArray(z.enum(GATE_IDS)),
  diagnosis_path: relativePathSchema.nullable(),
  candidate_diff_path: relativePathSchema.nullable(),
  failure_screenshot_path: relativePathSchema.nullable(),
  replay_screenshot_path: relativePathSchema.nullable(),
  total_duration_ms: millisecondsSchema,
}

type VerificationFields = z.infer<z.ZodObject<typeof verificationResultShape>>

/** Enforces the nine-gate reduction rule shared by the Run Result and Verification Result. */
export function checkVerificationInvariants(result: VerificationFields, ctx: z.RefinementCtx): void {
  const issue = issueReporter(ctx)
  const ids = result.gates.map((gate) => gate.gate_id)
  if (GATE_IDS.some((gateId) => ids.filter((id) => id === gateId).length !== 1)) issue(['gates'], 'GATES_INCOMPLETE')
  const nonPassing = new Set(result.gates.filter((gate) => gate.status !== 'pass').map((gate) => gate.gate_id))
  const reported = new Set(result.failed_gate_ids)
  if (nonPassing.size !== reported.size || [...nonPassing].some((gateId) => !reported.has(gateId))) {
    issue(['failed_gate_ids'], 'FAILED_GATE_IDS_MISMATCH')
  }
  if (result.status === 'Verified Fix') {
    const allPass = result.gates.length === GATE_IDS.length && result.gates.every((gate) => gate.status === 'pass')
    if (!allPass) issue(['status'], 'VERIFIED_REQUIRES_ALL_GATES_PASS')
    if (result.failed_gate_ids.length > 0) issue(['failed_gate_ids'], 'VERIFIED_FORBIDS_FAILED_GATES')
    for (const field of [
      'diagnosis_path',
      'candidate_diff_path',
      'failure_screenshot_path',
      'replay_screenshot_path',
    ] as const) {
      if (result[field] === null) issue([field], 'VERIFIED_REQUIRES_ARTIFACT')
    }
  } else {
    if (result.failed_gate_ids.length === 0) issue(['failed_gate_ids'], 'UNVERIFIED_REQUIRES_FAILED_GATE')
    if (nonPassing.size === 0) issue(['gates'], 'UNVERIFIED_REQUIRES_NON_PASSING_GATE')
  }
}

export const RunResultSchema = z
  .strictObject({
    schema_version: z.literal(CONTRACT_SCHEMA_VERSION),
    run_id: uuidSchema,
    request_id: uuidSchema,
    scenario_id: kebabIdSchema,
    case: z.enum(SCENARIO_CASES),
    started_at: timestampSchema,
    completed_at: timestampSchema,
    original_head: gitOidSchema,
    original_status_digest: sha256Schema,
    phase_durations_ms: PhaseDurationsSchema,
    provider: z.strictObject({
      mode: z.enum(PROVIDER_MODES),
      model: z.string().nullable(),
      injected_fault_label: z.string().nullable(),
    }),
    ...verificationResultShape,
  })
  .superRefine((result, ctx) => {
    checkVerificationInvariants(result, ctx)
    const issue = issueReporter(ctx)
    const { provider } = result
    if (provider.mode === 'meta') {
      if (provider.model !== META_MODEL_ID) issue(['provider', 'model'], 'PROVIDER_MODEL_MISMATCH')
      if (provider.injected_fault_label !== null) {
        issue(['provider', 'injected_fault_label'], 'PROVIDER_FAULT_LABEL_FORBIDDEN')
      }
    } else {
      if (provider.model !== null) issue(['provider', 'model'], 'PROVIDER_MODEL_FORBIDDEN')
      if (!provider.injected_fault_label) issue(['provider', 'injected_fault_label'], 'PROVIDER_FAULT_LABEL_REQUIRED')
    }
  })

export type PhaseDurations = z.infer<typeof PhaseDurationsSchema>
export type RunResult = z.infer<typeof RunResultSchema>

// ---------------------------------------------------------------------------------------
// Committed oracle files
// ---------------------------------------------------------------------------------------

/** Ordered expected rows; values are scalars so comparison is exact and order-sensitive. */
export const OracleDatasetSchema = z
  .array(z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.string(), z.number()])))
  .min(1)

/** Expected rendered bar count, labels, and values for the Canvas gate. */
export const ChartSeriesSchema = z
  .strictObject({
    bar_count: z.int().min(0),
    labels: z.array(z.string()),
    values: z.array(z.number()),
  })
  .superRefine((series, ctx) => {
    if (series.labels.length !== series.bar_count || series.values.length !== series.bar_count) {
      issueReporter(ctx)(['bar_count'], 'CHART_SERIES_LENGTH_MISMATCH')
    }
  })

export type OracleDataset = z.infer<typeof OracleDatasetSchema>
export type ChartSeries = z.infer<typeof ChartSeriesSchema>

// ---------------------------------------------------------------------------------------
// Safe parsing
// ---------------------------------------------------------------------------------------

export type ContractName =
  | 'scenario'
  | 'evidence-bundle'
  | 'diagnosis'
  | 'studio-event'
  | 'run-result'
  | 'workspace-session'
  | 'chat-request'
  | 'run'
  | 'candidate-change'
  | 'verification-result'
  | 'oracle-dataset'
  | 'chart-series'

export interface ContractIssue {
  readonly path: string
  readonly code: string
}

export interface ContractError {
  readonly code: 'CONTRACT_INVALID' | 'SCHEMA_VERSION_UNSUPPORTED'
  readonly contract: ContractName
  readonly issues: readonly ContractIssue[]
}

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError }

function toContractIssue(issue: z.core.$ZodIssue): ContractIssue {
  const path = issue.path.map(String).join('.') || '(root)'
  const custom = issue.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : undefined
  const code = typeof custom === 'string' && REASON_CODE_PATTERN.test(custom) ? custom : issue.code.toUpperCase()
  return Object.freeze({ path, code })
}

/**
 * Parses untrusted input against one contract. Errors carry only field paths and stable
 * codes: never the rejected value, the library message, or unrecognized key names.
 */
export function safeParseContract<T>(
  contract: ContractName,
  schema: z.ZodType<T>,
  input: unknown,
  options: { readonly versioned?: boolean } = {},
): ContractResult<T> {
  if (options.versioned && typeof input === 'object' && input !== null && 'schema_version' in input) {
    const version = (input as { schema_version: unknown }).schema_version
    if (version !== CONTRACT_SCHEMA_VERSION) {
      const issues = Object.freeze([Object.freeze({ path: 'schema_version', code: 'SCHEMA_VERSION_UNSUPPORTED' })])
      return { ok: false, error: Object.freeze({ code: 'SCHEMA_VERSION_UNSUPPORTED', contract, issues }) }
    }
  }
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = Object.freeze(parsed.error.issues.map(toContractIssue))
  return { ok: false, error: Object.freeze({ code: 'CONTRACT_INVALID', contract, issues }) }
}

export const parseScenario = (input: unknown): ContractResult<Scenario> =>
  safeParseContract('scenario', ScenarioSchema, input, { versioned: true })

export const parseEvidenceBundle = (input: unknown): ContractResult<EvidenceBundle> =>
  safeParseContract('evidence-bundle', EvidenceBundleSchema, input, { versioned: true })

export const parseDiagnosis = (input: unknown): ContractResult<Diagnosis> =>
  safeParseContract('diagnosis', DiagnosisSchema, input)

export const parseStudioEvent = (input: unknown): ContractResult<StudioEvent> =>
  safeParseContract('studio-event', StudioEventSchema, input, { versioned: true })

export const parseRunResult = (input: unknown): ContractResult<RunResult> =>
  safeParseContract('run-result', RunResultSchema, input, { versioned: true })

export const parseOracleDataset = (input: unknown): ContractResult<OracleDataset> =>
  safeParseContract('oracle-dataset', OracleDatasetSchema, input)

export const parseChartSeries = (input: unknown): ContractResult<ChartSeries> =>
  safeParseContract('chart-series', ChartSeriesSchema, input)
