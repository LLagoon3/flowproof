import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import { z } from 'zod'

import { META_MODEL_ID, REASON_CODE_PATTERN, repositoryPathsOverlap } from '../contracts/index.js'
import { containsSecretPattern, isSecretKeyName } from '../evidence/sanitize.js'
import { canonicalJson, sha256Hex } from '../evidence/store.js'

// The strict, versioned project-live contract family of specs/006-project-live-verification
// (data-model.md and the tasks.md Constraint Register). It is disjoint from the legacy prepared
// Run Result and the captured-verification result: its own `kind: project-live`, its own checks
// and its own claim, **Project verification passed**. Every object is closed, every identity is a
// host-generated lowercase UUIDv4 or a SHA-256 over canonical data or exact bytes, and every count,
// length and byte size is bounded. Cross-field invariants make fake success unrepresentable: a
// result cannot pass with a missing, failed or not-evaluated check, without an actual correction
// exchange, or over a cancellation, original-integrity or cleanup failure.
//
// No entity carries a host filesystem root, credential, cookie, header, request/response body,
// provider reasoning, excluded input or unmasked screenshot. The selected repository's canonical
// root is controller-private state and never part of these schemas. Parse errors carry only field
// paths and stable codes, never the rejected value.

export const PROJECT_SCHEMA_VERSION = 1
export const PROJECT_RESULT_KIND = 'project-live'
export const PROJECT_CATEGORY = 'vite-static-v1'
export const PROJECT_PROFILE_ID = 'vite-static-v1'
export const PROJECT_PRIVACY_POLICY_VERSION = 'project-privacy-v1'
export const PROJECT_REPLAY_COMPILER_ID = 'flowproof-project-replay'
export const PROJECT_CLAIM = 'Project verification passed'

// ---------------------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------------------

export const ADMISSION_STATES = ['inspecting', 'ready', 'blocked', 'stale'] as const
export const PROTECTED_INPUT_KINDS = ['configuration', 'package', 'lock', 'test', 'check', 'entry'] as const
export const CAPTURE_STATES = ['idle', 'recording', 'finishing', 'ready', 'discarded', 'incomplete', 'unsupported'] as const
export const CAPTURE_COMPLETENESS = ['complete', 'incomplete', 'unsupported'] as const
export const INTERACTION_TYPES = ['click', 'fill', 'select', 'scroll', 'navigate'] as const
export const OBSERVATION_TYPES = ['image', 'console', 'page-error', 'network-error'] as const
export const OBSERVATION_AVAILABILITY = ['available', 'omitted', 'unavailable'] as const
export const EVIDENCE_PHASES = ['demonstration', 'baseline', 'candidate'] as const
export const INTERPRETATION_STATUSES = ['ready', 'clarify', 'unsupported'] as const
export const REPLAY_OPERATIONS = ['click', 'fill', 'select', 'scroll', 'navigate', 'wait'] as const
export const CONDITION_KINDS = ['element-visible', 'element-count', 'text', 'form-value', 'path', 'no-error'] as const
export const INVOCATION_PHASES = ['analysis', 'clarified-analysis', 'correction'] as const
export const INVOCATION_STATUSES = ['started', 'completed', 'failed', 'cancelled'] as const
/** `test_transport` is an explicitly labelled in-process fake; it disqualifies live acceptance. */
export const PROVIDER_TRANSPORTS = ['meta', 'test_transport'] as const
export const CANDIDATE_STATES = ['proposed', 'rejected', 'applied-to-copy'] as const
export const CHECK_STATUSES = ['passed', 'failed', 'not_evaluated'] as const
export const CHECK_PHASES = ['admission', 'capture', 'analysis', 'definition', 'baseline', 'correction', 'candidate', 'finalization'] as const
export const ORIGINAL_INTEGRITY_STATES = ['verified', 'changed', 'unverified'] as const
export const CLEANUP_STATES = ['complete', 'recovered', 'failed', 'unverified'] as const
export const RUN_OUTCOMES = [
  'passed',
  'blocked',
  'unsupported',
  'not_reproduced',
  'generation_failed',
  'candidate_rejected',
  'verification_failed',
  'unverified',
  'canceled',
  'cleanup_failed',
  'integrity_failed',
] as const
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export const ARIA_ROLES = [
  'alert',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'dialog',
  'form',
  'grid',
  'gridcell',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'main',
  'menu',
  'menuitem',
  'navigation',
  'option',
  'paragraph',
  'progressbar',
  'radio',
  'region',
  'row',
  'rowheader',
  'searchbox',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'textbox',
] as const

/**
 * The host-owned mandatory checks, in reduction order. Confirmed project checks are added after
 * them as `project_check:<id>`; none of these can be removed or made optional by configuration.
 */
export const MANDATORY_CHECK_IDS = [
  'admission_consistent',
  'capture_complete',
  'interpretation_valid',
  'definition_frozen',
  'baseline_reproduced',
  'correction_generated',
  'candidate_applied',
  'candidate_build',
  'inputs_unchanged',
  'candidate_replay',
  'evidence_bound',
  'original_unchanged',
  'cleanup_complete',
] as const

export type AdmissionState = (typeof ADMISSION_STATES)[number]
export type CaptureState = (typeof CAPTURE_STATES)[number]
export type ObservationType = (typeof OBSERVATION_TYPES)[number]
export type EvidencePhase = (typeof EVIDENCE_PHASES)[number]
export type InvocationPhase = (typeof INVOCATION_PHASES)[number]
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number]
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number]
export type CandidateState = (typeof CANDIDATE_STATES)[number]
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export type CheckPhase = (typeof CHECK_PHASES)[number]
export type OriginalIntegrity = (typeof ORIGINAL_INTEGRITY_STATES)[number]
export type CleanupState = (typeof CLEANUP_STATES)[number]
export type RunOutcome = (typeof RUN_OUTCOMES)[number]
export type MandatoryCheckId = (typeof MANDATORY_CHECK_IDS)[number]

// ---------------------------------------------------------------------------------------
// Limits (Constraint Register)
// ---------------------------------------------------------------------------------------

const KIB = 1_024
const MIB = 1_024 * KIB

/** Capture, request and patch bounds. They bound resources, never a human's time. */
export const PROJECT_LIMITS = Object.freeze({
  maxActions: 200,
  maxImages: 16,
  maxImageBytes: MIB,
  maxErrorSummaryBytes: 64 * KIB,
  maxStagedReportBytes: 20 * MIB,
  maxObservations: 256,
  maxRequestSourceFiles: 32,
  maxRequestSourceBytes: 256 * KIB,
  maxRequestImages: 8,
  maxRequestBytes: 8 * MIB,
  maxPatchFiles: 8,
  maxPatchBytes: 64 * KIB,
  minConditions: 1,
  maxConditions: 8,
  maxReplayActions: 200,
  maxWaitMs: 10_000,
  maxProjectChecks: 8,
  maxAnalysisCalls: 2,
  maxCorrectionCalls: 1,
})

/** The exact Plan runtime limits. Automatic budgets exclude every human waiting state. */
export const EXECUTION_LIMITS = Object.freeze({
  cpu_count: 1,
  memory_bytes: 1_073_741_824,
  pids: 256,
  stop_grace_ms: 5_000,
  phase_timeout_ms: 120_000,
  provider_timeout_ms: 90_000,
  aggregate_automatic_ms: 600_000,
})

// ---------------------------------------------------------------------------------------
// Identities and digests
// ---------------------------------------------------------------------------------------

/** A host-generated identity. The model, recorder, browser or project can never mint one. */
export const newProjectUuid = (): string => randomUUID()

/** SHA-256 over canonical JSON (sorted keys, no insignificant whitespace). */
export const projectDigest = (value: unknown): string => sha256Hex(canonicalJson(value))

/** Builds a project check identifier from a confirmed project check ID. */
export const projectCheckId = (id: string): string => `project_check:${id}`

// ---------------------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------------------

type Issue = (path: PropertyKey[], code: string) => void

function reporter(ctx: z.RefinementCtx): Issue {
  return (path, code) => ctx.addIssue({ code: 'custom', path, message: code, params: { code } })
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/
const PATH_SEGMENT = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]{0,127}$|^\.[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,126}$/
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/+-]{1,255}(?<![./])$/
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,128}$/
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SEMVER = /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/
const LOCALHOST_ORIGIN = /^http:\/\/localhost:([1-9][0-9]{3,4})$/
// Same-origin URL path characters: no percent-encoding, backslash, whitespace or quotes.
const URL_PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/
const URL_EXTRA_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]*$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const INVISIBLE = /[\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/

export const projectUuidSchema = z.string().regex(UUID_V4)
export const projectSha256Schema = z.string().regex(SHA256)
export const gitRevisionSchema = z.string().regex(REVISION)
export const imageIdSchema = z.string().regex(IMAGE_ID)
export const projectReasonSchema = z.string().regex(REASON)
export const projectTimestampSchema = z.iso.datetime()
const count = (max: number) => z.int().min(0).max(max)

/** Bounded display/model text: no control or invisible formatting characters, no secret shape. */
export function safeTextSchema(max: number, options: { readonly min?: number; readonly multiline?: boolean } = {}) {
  const control = options.multiline ? CONTROL_MULTILINE : CONTROL
  return z
    .string()
    .min(options.min ?? 1)
    .max(max)
    .superRefine((value, ctx) => {
      const issue = reporter(ctx)
      if (control.test(value) || INVISIBLE.test(value)) issue([], 'TEXT_CONTROL_CHARACTER')
      if (containsSecretPattern(value)) issue([], 'TEXT_SECRET_PATTERN')
    })
}

/** Canonical repository-relative POSIX path: no absolute, dot, empty, home or encoded segment. */
export const projectRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    const segments = value.split('/')
    if (segments.length > 32 || !segments.every((segment) => PATH_SEGMENT.test(segment)) || posix.normalize(value) !== value) {
      reporter(ctx)([], 'PATH_NOT_CANONICAL')
    }
  })

/** An editable admitted source file: always under `src/`. */
export const projectSourcePathSchema = projectRelativePathSchema.refine((value) => value.startsWith('src/') && value.length > 4, {
  params: { code: 'SOURCE_PATH_OUTSIDE_SRC' },
  message: 'SOURCE_PATH_OUTSIDE_SRC',
})

function checkUrlPath(path: string, issue: Issue): void {
  if (!path.startsWith('/') || path.startsWith('//') || !URL_PATH_CHARS.test(path)) return issue([], 'URL_PATH_INVALID')
  const segments = path.slice(1).split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) issue([], 'URL_PATH_INVALID')
}

/** A relative same-origin path without query or fragment, such as an entry or request path. */
export const entryPathSchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((value, ctx) => checkUrlPath(value, reporter(ctx)))

/** A relative same-origin navigation: path plus optional sanitized query and fragment. */
export const sameOriginPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    const issue = reporter(ctx)
    const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value)
    if (!match) return issue([], 'URL_PATH_INVALID')
    checkUrlPath(match[1] ?? '', issue)
    for (const extra of [match[2], match[3]]) if (extra !== undefined && !URL_EXTRA_CHARS.test(extra.slice(1))) issue([], 'URL_PATH_INVALID')
    if (containsSecretPattern(value)) issue([], 'TEXT_SECRET_PATTERN')
  })

/** The run-owned target origin: `http://localhost:<port>`, never Studio's `127.0.0.1`. */
export const localhostOriginSchema = z.string().superRefine((value, ctx) => {
  const port = Number(LOCALHOST_ORIGIN.exec(value)?.[1] ?? 0)
  if (!(port >= 1_024 && port <= 65_535)) reporter(ctx)([], 'TARGET_ORIGIN_INVALID')
})

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox'])
const WRAPPERS = new Set(['env', 'sudo', 'su', 'doas', 'nohup', 'xargs', 'exec', 'eval', 'command', 'nice', 'timeout', 'setsid'])
const CONTAINER_PREFIXES = ['/opt/flowproof/toolchain/', '/workspace/'] as const

/**
 * Confirmed direct argv: bounded entries, no shell or wrapper program, no embedded environment
 * assignment, no NUL/newline, and absolute paths only inside the fixed container toolchain or
 * owned workspace. A project setting can never name a host path.
 */
export const projectArgvSchema = z
  .array(z.string().min(1).max(1_024))
  .min(1)
  .max(32)
  .superRefine((argv, ctx) => {
    const issue = reporter(ctx)
    const program = argv[0] ?? ''
    const base = posix.basename(program)
    if (SHELLS.has(base) || WRAPPERS.has(base)) issue([0], 'ARGV_WRAPPER_FORBIDDEN')
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) issue([0], 'ARGV_ENVIRONMENT_ASSIGNMENT')
    argv.forEach((argument, index) => {
      if (/[\u0000\r\n]/.test(argument) || Buffer.byteLength(argument, 'utf8') > 1_024) issue([index], 'ARGV_ENTRY_INVALID')
      const candidates = [argument, ...(argument.startsWith('-') && argument.includes('=') ? [argument.slice(argument.indexOf('=') + 1)] : [])]
      for (const candidate of candidates) {
        if (candidate.startsWith('~')) issue([index], 'ARGV_HOST_PATH')
        if (candidate.startsWith('/')) {
          const confined = CONTAINER_PREFIXES.some((prefix) => candidate.startsWith(prefix)) && posix.normalize(candidate) === candidate
          if (!confined) issue([index], 'ARGV_HOST_PATH')
        }
        if (candidate.split('/').includes('..')) issue([index], 'ARGV_PATH_TRAVERSAL')
      }
    })
  })

const PROTECTED_OUTPUT_ROOTS = ['src', 'node_modules', '.git'] as const

/** A confined build output directory inside the owned snapshot; never sources or metadata. */
export const outputDirectorySchema = projectRelativePathSchema.superRefine((value, ctx) => {
  if (PROTECTED_OUTPUT_ROOTS.some((root) => repositoryPathsOverlap(value, root))) reporter(ctx)([], 'OUTPUT_OVERLAPS_PROTECTED_PATH')
})

function uniqueBy<T extends z.ZodType>(item: T, key: (value: z.infer<T>) => string = (value) => canonicalJson(value)) {
  return z.array(item).superRefine((values, ctx) => {
    if (new Set(values.map((value) => key(value))).size !== values.length) reporter(ctx)([], 'NOT_UNIQUE')
  })
}

// ---------------------------------------------------------------------------------------
// ProjectContext
// ---------------------------------------------------------------------------------------

export const ProjectContextSchema = z.strictObject({
  schema_version: z.literal(PROJECT_SCHEMA_VERSION),
  project_id: projectUuidSchema,
  /** Owner-visible session context only; never part of a model request or log. */
  display_root: safeTextSchema(1_024),
  label: safeTextSchema(128),
  baseline_commit: gitRevisionSchema,
  branch: z.string().regex(BRANCH).nullable(),
  category: z.literal(PROJECT_CATEGORY),
  admitted_tree_sha256: projectSha256Schema,
  integrity_snapshot: z.strictObject({ snapshot_id: projectUuidSchema, sha256: projectSha256Schema }),
  profile: z.strictObject({
    profile_id: z.literal(PROJECT_PROFILE_ID),
    image_id: imageIdSchema,
    dependency_tree_sha256: projectSha256Schema,
    manifest_sha256: projectSha256Schema,
    lock_sha256: projectSha256Schema,
  }),
  allowed_source_paths: uniqueBy(projectSourcePathSchema).max(4_096),
  protected_inputs: uniqueBy(
    z.strictObject({ path: projectRelativePathSchema, kind: z.enum(PROTECTED_INPUT_KINDS), sha256: projectSha256Schema }),
    (input) => input.path,
  ).max(256),
  admission: z
    .strictObject({
      state: z.enum(ADMISSION_STATES),
      reasons: uniqueBy(projectReasonSchema).max(16),
      required_prerequisites: uniqueBy(projectReasonSchema).max(16),
    })
    .superRefine((admission, ctx) => {
      const issue = reporter(ctx)
      const hasReasons = admission.reasons.length > 0 || admission.required_prerequisites.length > 0
      if (admission.state === 'ready' && hasReasons) issue(['reasons'], 'ADMISSION_READY_WITH_REASONS')
      if ((admission.state === 'blocked' || admission.state === 'stale') && admission.reasons.length === 0) {
        issue(['reasons'], 'ADMISSION_REASON_REQUIRED')
      }
      if (admission.state === 'inspecting' && admission.reasons.length > 0) issue(['reasons'], 'ADMISSION_INSPECTING_WITH_REASONS')
    }),
})
export type ProjectContext = z.infer<typeof ProjectContextSchema>

// ---------------------------------------------------------------------------------------
// Project configuration file and ExecutionConfiguration
// ---------------------------------------------------------------------------------------

const projectCheckSchema = z.strictObject({ id: z.string().max(48).regex(KEBAB), argv: projectArgvSchema })
const projectChecksSchema = uniqueBy(projectCheckSchema, (check) => check.id).max(PROJECT_LIMITS.maxProjectChecks)
const buildSchema = z.strictObject({ argv: projectArgvSchema, output_directory: outputDirectorySchema })

/**
 * The optional external `--project-config` JSON. Strict data only: it cannot choose an image,
 * network, mount, credential, environment, model, endpoint, artifact root or evaluator.
 */
export const ProjectConfigFileSchema = z.strictObject({
  schema_version: z.literal(PROJECT_SCHEMA_VERSION),
  category: z.literal(PROJECT_CATEGORY),
  entry_path: entryPathSchema,
  build: buildSchema,
  required_project_checks: projectChecksSchema,
})
export type ProjectConfigFile = z.infer<typeof ProjectConfigFileSchema>

const RESERVED_ENVIRONMENT = new Set(['HOME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'TMPDIR', 'USER', 'SHELL'])

const executionLimitsSchema = z.strictObject({
  cpu_count: z.literal(EXECUTION_LIMITS.cpu_count),
  memory_bytes: z.literal(EXECUTION_LIMITS.memory_bytes),
  pids: z.literal(EXECUTION_LIMITS.pids),
  stop_grace_ms: z.literal(EXECUTION_LIMITS.stop_grace_ms),
  phase_timeout_ms: z.literal(EXECUTION_LIMITS.phase_timeout_ms),
  provider_timeout_ms: z.literal(EXECUTION_LIMITS.provider_timeout_ms),
  aggregate_automatic_ms: z.literal(EXECUTION_LIMITS.aggregate_automatic_ms),
})

const configurationBodyShape = {
  schema_version: z.literal(PROJECT_SCHEMA_VERSION),
  configuration_id: projectUuidSchema,
  project_id: projectUuidSchema,
  baseline_commit: gitRevisionSchema,
  category: z.literal(PROJECT_CATEGORY),
  entry_path: entryPathSchema,
  target_origin: localhostOriginSchema,
  build: buildSchema,
  required_project_checks: projectChecksSchema,
  mandatory_checks: z.array(z.string().max(64)).max(64).superRefine((checks, ctx) => {
    if (canonicalJson(checks) !== canonicalJson(MANDATORY_CHECK_IDS)) reporter(ctx)([], 'MANDATORY_CHECKS_ALTERED')
  }),
  inputs: z.strictObject({
    source_tree_sha256: projectSha256Schema,
    configuration_sha256: projectSha256Schema,
    checks_sha256: projectSha256Schema,
    lock_sha256: projectSha256Schema,
  }),
  /** Host-selected policy; neither the browser nor a project file can set any of it. */
  profile: z.strictObject({
    profile_id: z.literal(PROJECT_PROFILE_ID),
    image_id: imageIdSchema,
    dependency_tree_sha256: projectSha256Schema,
    manifest_sha256: projectSha256Schema,
    network: z.literal('none'),
    environment_allowlist: uniqueBy(
      z.string().regex(ENV_KEY).refine((key) => !RESERVED_ENVIRONMENT.has(key) && !isSecretKeyName(key), {
        params: { code: 'ENVIRONMENT_NAME_FORBIDDEN' },
        message: 'ENVIRONMENT_NAME_FORBIDDEN',
      }),
    ).max(16),
    limits: executionLimitsSchema,
    byte_limits: z.strictObject({
      max_output_bytes: z.int().min(1).max(64 * MIB),
      max_output_files: z.int().min(1).max(10_000),
      max_diagnostic_bytes: z.int().min(4 * KIB).max(MIB),
    }),
  }),
}

const confirmationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending') }),
  z.strictObject({ state: z.literal('confirmed'), confirmed_at: projectTimestampSchema }),
])

const ConfigurationBodySchema = z.strictObject(configurationBodyShape)
type ConfigurationBody = z.infer<typeof ConfigurationBodySchema>

const configurationDigestOf = (body: Record<string, unknown>): string => {
  const { configuration_digest: _digest, confirmation: _confirmation, ...bound } = body
  return projectDigest(bound)
}

/**
 * A confirmed, host-bound execution configuration. Its digest binds every setting except the
 * confirmation record, so any changed setting needs a new digest and a new confirmed attempt.
 */
export const ExecutionConfigurationSchema = z
  .strictObject({ ...configurationBodyShape, confirmation: confirmationSchema, configuration_digest: projectSha256Schema })
  .superRefine((configuration, ctx) => {
    if (configurationDigestOf(configuration) !== configuration.configuration_digest) {
      reporter(ctx)(['configuration_digest'], 'CONFIGURATION_DIGEST_MISMATCH')
    }
  })
export type ExecutionConfiguration = z.infer<typeof ExecutionConfigurationSchema>

/** Host helper: binds a configuration body to its canonical digest. */
export function withConfigurationDigest(
  body: ConfigurationBody & { readonly confirmation: z.infer<typeof confirmationSchema> },
): ExecutionConfiguration {
  return { ...body, configuration_digest: configurationDigestOf(body as Record<string, unknown>) } as ExecutionConfiguration
}

/** Every check a run of this configuration must report: the mandatory set, then project checks. */
export function requiredCheckIds(configuration: Pick<ExecutionConfiguration, 'required_project_checks'>): string[] {
  return [...MANDATORY_CHECK_IDS, ...configuration.required_project_checks.map((check) => projectCheckId(check.id))]
}

// ---------------------------------------------------------------------------------------
// Locators, interactions and safe observations
// ---------------------------------------------------------------------------------------

const CSS_COMPOUND = String.raw`(?:[a-z][a-z0-9-]*|\*)?(?:[#.][A-Za-z_-][A-Za-z0-9_-]{0,63})*(?::nth-of-type\([1-9][0-9]{0,2}\))?`
const CSS_SELECTOR = new RegExp(String.raw`^${CSS_COMPOUND}(?:(?: > | )${CSS_COMPOUND}){0,7}$`)

/** A bounded unique simple CSS selector: tags, IDs, classes, nth-of-type; no attribute or value. */
const simpleCssSchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((value, ctx) => {
    const compounds = value.split(/ > | /)
    if (!CSS_SELECTOR.test(value) || compounds.some((compound) => compound === '')) reporter(ctx)([], 'CSS_SELECTOR_UNSUPPORTED')
  })

export const LocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('test-id'), value: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }),
  z.strictObject({ kind: z.literal('role'), role: z.enum(ARIA_ROLES), name: safeTextSchema(128, { min: 0 }) }),
  z.strictObject({ kind: z.literal('css'), selector: simpleCssSchema }),
])
export type Locator = z.infer<typeof LocatorSchema>

const locatorCandidatesSchema = uniqueBy(LocatorSchema).min(1).max(4)
const redactedValueSchema = z.strictObject({ kind: z.literal('redacted'), reason: projectReasonSchema })
const scrollOffset = z.int().min(0).max(1_000_000)

export const InteractionActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('click'), locators: locatorCandidatesSchema }),
  z.strictObject({
    type: z.literal('fill'),
    locators: locatorCandidatesSchema,
    value: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('safe'), text: safeTextSchema(256, { min: 0 }) }), redactedValueSchema]),
  }),
  z.strictObject({
    type: z.literal('select'),
    locators: locatorCandidatesSchema,
    value: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('safe'), option: safeTextSchema(256) }), redactedValueSchema]),
  }),
  z.strictObject({
    type: z.literal('scroll'),
    target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('page') }), z.strictObject({ kind: z.literal('element'), locators: locatorCandidatesSchema })]),
    x: scrollOffset,
    y: scrollOffset,
  }),
  z.strictObject({ type: z.literal('navigate'), path: sameOriginPathSchema }),
])

/**
 * One host-normalized target interaction. Recorder-supplied fields are untrusted: the host
 * assigns the sequence, binds the capture, frame and epoch, and admits only safe values.
 */
export const InteractionObservationSchema = z.strictObject({
  sequence: z.int().min(1).max(1_000_000),
  capture_id: projectUuidSchema,
  document_epoch: count(10_000),
  frame_id: projectUuidSchema,
  offset_ms: z.int().min(0),
  action: InteractionActionSchema,
  related_observation_ids: uniqueBy(projectUuidSchema).max(8),
})
export type InteractionObservation = z.infer<typeof InteractionObservationSchema>

const viewportSize = { width: z.int().min(320).max(3_840), height: z.int().min(240).max(2_160) }
export const ViewportSchema = z.strictObject({ ...viewportSize, device_scale_factor: z.literal(1) })

const imagePayloadSchema = z
  .strictObject({
    viewport: z.strictObject(viewportSize),
    clip: z.strictObject({ x: count(3_840), y: count(2_160), width: z.int().min(1).max(3_840), height: z.int().min(1).max(2_160) }),
    mask_count: count(10_000),
    /** Masks are applied while producing the retained PNG; raw pre-mask pixels never persist. */
    masked_before_retention: z.literal(true),
    build_sha256: projectSha256Schema.nullable(),
    artifact: z.strictObject({
      artifact_id: projectUuidSchema,
      sha256: projectSha256Schema,
      bytes: z.int().min(1).max(PROJECT_LIMITS.maxImageBytes),
      media_type: z.literal('image/png'),
    }),
  })
  .superRefine((image, ctx) => {
    if (image.clip.x + image.clip.width > image.viewport.width || image.clip.y + image.clip.height > image.viewport.height) {
      reporter(ctx)(['clip'], 'IMAGE_CLIP_OUTSIDE_VIEWPORT')
    }
  })

const errorMessageSchema = safeTextSchema(2_048, { multiline: true })
const consolePayloadSchema = z.strictObject({ level: z.enum(['error', 'warning']), message: errorMessageSchema, fingerprint: projectSha256Schema })
const pageErrorPayloadSchema = z.strictObject({ message: errorMessageSchema, fingerprint: projectSha256Schema })
const networkErrorPayloadSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  path: entryPathSchema,
  status: z.int().min(100).max(599).nullable(),
  error_class: projectReasonSchema,
  fingerprint: projectSha256Schema,
})

const observationCommon = {
  observation_id: projectUuidSchema,
  run_id: projectUuidSchema,
  capture_id: projectUuidSchema.nullable(),
  baseline_commit: gitRevisionSchema,
  phase: z.enum(EVIDENCE_PHASES),
  availability: z.enum(OBSERVATION_AVAILABILITY),
  reason: projectReasonSchema.nullable(),
  sequence_range: z
    .strictObject({ first: z.int().min(1).max(1_000_000), last: z.int().min(1).max(1_000_000) })
    .refine((range) => range.first <= range.last, { params: { code: 'SEQUENCE_RANGE_INVALID' }, message: 'SEQUENCE_RANGE_INVALID' })
    .nullable(),
  policy_version: z.literal(PROJECT_PRIVACY_POLICY_VERSION),
  redaction_count: count(1_000_000),
}

/**
 * A safe image or error observation. `available` carries its sanitized payload; `omitted` and
 * `unavailable` carry a reason and nothing else, so an absent collector is explicit.
 */
export const SafeObservationSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ ...observationCommon, type: z.literal('image'), payload: imagePayloadSchema.nullable() }),
    z.strictObject({ ...observationCommon, type: z.literal('console'), payload: consolePayloadSchema.nullable() }),
    z.strictObject({ ...observationCommon, type: z.literal('page-error'), payload: pageErrorPayloadSchema.nullable() }),
    z.strictObject({ ...observationCommon, type: z.literal('network-error'), payload: networkErrorPayloadSchema.nullable() }),
  ])
  .superRefine((observation, ctx) => {
    const issue = reporter(ctx)
    if (observation.availability === 'available') {
      if (observation.reason !== null) issue(['reason'], 'OBSERVATION_REASON_FORBIDDEN')
      if (observation.payload === null) issue(['payload'], 'OBSERVATION_PAYLOAD_REQUIRED')
    } else {
      if (observation.reason === null) issue(['reason'], 'OBSERVATION_REASON_REQUIRED')
      if (observation.payload !== null) issue(['payload'], 'OBSERVATION_PAYLOAD_FORBIDDEN')
    }
    if (observation.phase === 'demonstration' && observation.capture_id === null) issue(['capture_id'], 'OBSERVATION_CAPTURE_REQUIRED')
    if (observation.phase !== 'demonstration' && observation.capture_id !== null) issue(['capture_id'], 'OBSERVATION_CAPTURE_FORBIDDEN')
  })
export type SafeObservation = z.infer<typeof SafeObservationSchema>

/** UTF-8 bytes of the text an error observation contributes to the capture summary budget. */
function errorSummaryBytes(observation: SafeObservation): number {
  if (observation.payload === null) return 0
  switch (observation.type) {
    case 'image':
      return 0
    case 'console':
    case 'page-error':
      return Buffer.byteLength(observation.payload.message, 'utf8')
    case 'network-error': {
      const payload = observation.payload
      return Buffer.byteLength(`${payload.method} ${payload.path} ${payload.status ?? ''} ${payload.error_class}`, 'utf8')
    }
  }
}

// ---------------------------------------------------------------------------------------
// DemonstrationCapture
// ---------------------------------------------------------------------------------------

const CAPTURE_TRANSITIONS: Readonly<Record<CaptureState, readonly CaptureState[]>> = Object.freeze({
  idle: ['recording'],
  recording: ['finishing', 'discarded', 'incomplete', 'unsupported'],
  finishing: ['ready', 'discarded', 'incomplete', 'unsupported'],
  ready: ['discarded'],
  discarded: [],
  incomplete: [],
  unsupported: [],
})

/**
 * The declared capture lifecycle. `ready` is immutable; re-recording creates a new capture
 * identity rather than reopening one. No transition is driven by a human-time deadline.
 */
export const canTransitionCapture = (from: CaptureState, to: CaptureState): boolean => CAPTURE_TRANSITIONS[from]?.includes(to) ?? false

const FINISHED_CAPTURE_STATES: ReadonlySet<CaptureState> = new Set(['ready', 'incomplete', 'unsupported'])

export const DemonstrationCaptureSchema = z
  .strictObject({
    schema_version: z.literal(PROJECT_SCHEMA_VERSION),
    capture_id: projectUuidSchema,
    run_id: projectUuidSchema,
    project_id: projectUuidSchema,
    baseline_commit: gitRevisionSchema,
    configuration_id: projectUuidSchema,
    configuration_digest: projectSha256Schema,
    target_origin: localhostOriginSchema,
    viewport: ViewportSchema,
    state: z.enum(CAPTURE_STATES),
    document_epoch: count(10_000),
    interactions: z.array(InteractionObservationSchema).max(PROJECT_LIMITS.maxActions),
    observations: uniqueBy(SafeObservationSchema, (observation) => observation.observation_id).max(PROJECT_LIMITS.maxObservations),
    counters: z.strictObject({ unavailable: count(1_000_000), unsupported: count(1_000_000), dropped: count(1_000_000) }),
    completeness: z
      .strictObject({ status: z.enum(CAPTURE_COMPLETENESS), reasons: uniqueBy(projectReasonSchema).max(16) })
      .nullable(),
    /** Monotonic ordering offsets; not a human time-to-completion gate. */
    timing: z.strictObject({ started_offset_ms: z.literal(0), finished_offset_ms: z.int().min(0).nullable() }),
    staged_bytes: count(PROJECT_LIMITS.maxStagedReportBytes),
    seal: z.strictObject({ report_sha256: projectSha256Schema }).nullable(),
  })
  .superRefine((capture, ctx) => {
    const issue = reporter(ctx)
    const finished = FINISHED_CAPTURE_STATES.has(capture.state)

    if (capture.state === 'ready' && capture.seal === null) issue(['seal'], 'CAPTURE_SEAL_REQUIRED')
    if (!finished && capture.seal !== null) issue(['seal'], 'CAPTURE_SEAL_FORBIDDEN')
    if (capture.state === 'ready' && capture.interactions.length === 0) issue(['interactions'], 'CAPTURE_EMPTY')
    if (capture.state === 'idle' && (capture.interactions.length > 0 || capture.observations.length > 0)) issue(['state'], 'CAPTURE_IDLE_NOT_EMPTY')
    if (capture.state === 'discarded' && (capture.interactions.length > 0 || capture.observations.length > 0 || capture.staged_bytes > 0)) {
      issue(['state'], 'CAPTURE_DISCARDED_NOT_CLEARED')
    }

    if (finished) {
      const completeness = capture.completeness
      if (completeness === null) issue(['completeness'], 'CAPTURE_COMPLETENESS_REQUIRED')
      else {
        const expected = capture.state === 'ready' ? 'complete' : capture.state
        if (completeness.status !== expected) issue(['completeness', 'status'], 'CAPTURE_COMPLETENESS_MISMATCH')
        if (capture.state === 'ready' && completeness.reasons.length > 0) issue(['completeness', 'reasons'], 'CAPTURE_COMPLETENESS_MISMATCH')
        // A usable ready capture lost nothing; an absent collector (`unavailable`) stays disclosed.
        if (capture.state === 'ready' && (capture.counters.dropped > 0 || capture.counters.unsupported > 0)) issue(['counters'], 'CAPTURE_READY_LOSSY')
        if (capture.state !== 'ready' && completeness.reasons.length === 0) issue(['completeness', 'reasons'], 'CAPTURE_REASON_REQUIRED')
      }
      if (capture.timing.finished_offset_ms === null) issue(['timing', 'finished_offset_ms'], 'CAPTURE_FINISH_TIME_REQUIRED')
    } else {
      if (capture.completeness !== null) issue(['completeness'], 'CAPTURE_COMPLETENESS_FORBIDDEN')
      if (capture.state !== 'discarded' && capture.timing.finished_offset_ms !== null) issue(['timing', 'finished_offset_ms'], 'CAPTURE_NOT_FINISHED')
    }

    const known = new Set(capture.observations.map((observation) => observation.observation_id))
    let previous: InteractionObservation | undefined
    capture.interactions.forEach((interaction, index) => {
      if (interaction.capture_id !== capture.capture_id) issue(['interactions', index, 'capture_id'], 'INTERACTION_CAPTURE_MISMATCH')
      if (previous !== undefined && interaction.sequence <= previous.sequence) issue(['interactions', index, 'sequence'], 'INTERACTION_SEQUENCE_ORDER')
      if (interaction.document_epoch > capture.document_epoch || (previous !== undefined && interaction.document_epoch < previous.document_epoch)) {
        issue(['interactions', index, 'document_epoch'], 'INTERACTION_EPOCH_ORDER')
      }
      if (previous !== undefined && interaction.offset_ms < previous.offset_ms) issue(['interactions', index, 'offset_ms'], 'INTERACTION_OFFSET_ORDER')
      if (!interaction.related_observation_ids.every((related) => known.has(related))) {
        issue(['interactions', index, 'related_observation_ids'], 'OBSERVATION_REFERENCE_UNKNOWN')
      }
      previous = interaction
    })
    const lastOffset = previous?.offset_ms ?? 0
    if (capture.timing.finished_offset_ms !== null && capture.timing.finished_offset_ms < lastOffset) {
      issue(['timing', 'finished_offset_ms'], 'INTERACTION_OFFSET_ORDER')
    }

    let images = 0
    let errorBytes = 0
    let artifactBytes = 0
    capture.observations.forEach((observation, index) => {
      if (observation.run_id !== capture.run_id || observation.capture_id !== capture.capture_id || observation.phase !== 'demonstration') {
        issue(['observations', index], 'OBSERVATION_CAPTURE_MISMATCH')
      }
      if (observation.baseline_commit !== capture.baseline_commit) issue(['observations', index, 'baseline_commit'], 'OBSERVATION_CAPTURE_MISMATCH')
      if (observation.type === 'image') {
        images += 1
        artifactBytes += observation.payload?.artifact.bytes ?? 0
      }
      errorBytes += errorSummaryBytes(observation)
    })
    if (images > PROJECT_LIMITS.maxImages) issue(['observations'], 'IMAGE_LIMIT_EXCEEDED')
    if (errorBytes > PROJECT_LIMITS.maxErrorSummaryBytes) issue(['observations'], 'ERROR_SUMMARY_LIMIT_EXCEEDED')
    if (capture.staged_bytes < artifactBytes + errorBytes) issue(['staged_bytes'], 'STAGED_BYTES_INCONSISTENT')
  })
export type DemonstrationCapture = z.infer<typeof DemonstrationCaptureSchema>

// ---------------------------------------------------------------------------------------
// Replay definition and expected conditions (data only)
// ---------------------------------------------------------------------------------------

const replayOffset = z.int().min(0).max(100_000)

const waitConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('visible'), locator: LocatorSchema }),
  z.strictObject({ kind: z.literal('text'), locator: LocatorSchema, text: safeTextSchema(512) }),
  z.strictObject({ kind: z.literal('path'), path: sameOriginPathSchema }),
])

/** The closed replay operations; no function, code string, regular expression, shell or URL client. */
export const ReplayActionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('click'), locator: LocatorSchema }),
  z.strictObject({ op: z.literal('fill'), locator: LocatorSchema, value: safeTextSchema(256, { min: 0 }) }),
  z.strictObject({ op: z.literal('select'), locator: LocatorSchema, value: safeTextSchema(256) }),
  z.strictObject({
    op: z.literal('scroll'),
    target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('page') }), z.strictObject({ kind: z.literal('element'), locator: LocatorSchema })]),
    x: replayOffset,
    y: replayOffset,
  }),
  z.strictObject({ op: z.literal('navigate'), path: sameOriginPathSchema }),
  z.strictObject({ op: z.literal('wait'), until: waitConditionSchema, timeout_ms: z.int().min(1).max(PROJECT_LIMITS.maxWaitMs) }),
])
export type ReplayAction = z.infer<typeof ReplayActionSchema>

export const ReplayDefinitionSchema = z.strictObject({
  entry_path: entryPathSchema,
  viewport: ViewportSchema,
  actions: z.array(ReplayActionSchema).min(1).max(PROJECT_LIMITS.maxReplayActions),
})
export type ReplayDefinition = z.infer<typeof ReplayDefinitionSchema>

/** Finite DOM/URL/error conditions; never code, a model pass statement or a pixel-difference oracle. */
export const ExpectedConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element-visible'), locator: LocatorSchema, visible: z.boolean() }),
  z.strictObject({ kind: z.literal('element-count'), locator: LocatorSchema, count: count(1_000) }),
  z.strictObject({ kind: z.literal('text'), locator: LocatorSchema, match: z.enum(['exact', 'normalized']), text: safeTextSchema(512) }),
  z.strictObject({ kind: z.literal('form-value'), locator: LocatorSchema, value: safeTextSchema(256, { min: 0 }) }),
  z.strictObject({ kind: z.literal('path'), path: sameOriginPathSchema }),
  z.strictObject({ kind: z.literal('no-error'), error_type: z.enum(['console', 'page-error', 'network-error']), fingerprint: projectSha256Schema }),
])
export type ExpectedCondition = z.infer<typeof ExpectedConditionSchema>

const conditionsSchema = uniqueBy(ExpectedConditionSchema).min(PROJECT_LIMITS.minConditions).max(PROJECT_LIMITS.maxConditions)
const citationsSchema = (min: number) => uniqueBy(projectUuidSchema).min(min).max(32)

// ---------------------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------------------

const InterpretationResultSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('ready'),
      observed_problem: safeTextSchema(2_000, { multiline: true }),
      citations: citationsSchema(1),
      replay: ReplayDefinitionSchema,
      expected_conditions: conditionsSchema,
      task_condition_index: count(PROJECT_LIMITS.maxConditions - 1),
      intent_summary: safeTextSchema(1_000, { multiline: true }),
      support_explanation: safeTextSchema(2_000, { multiline: true }),
    })
    .superRefine((ready, ctx) => {
      if (ready.task_condition_index >= ready.expected_conditions.length) reporter(ctx)(['task_condition_index'], 'TASK_CONDITION_INDEX_INVALID')
    }),
  z.strictObject({
    status: z.literal('clarify'),
    observed_facts: safeTextSchema(2_000, { multiline: true }),
    citations: citationsSchema(1),
    question: z.strictObject({
      question_id: projectUuidSchema,
      text: safeTextSchema(500),
      missing_intent: safeTextSchema(1_000, { multiline: true }),
      alternatives: uniqueBy(safeTextSchema(200)).max(4),
    }),
  }),
  z.strictObject({
    status: z.literal('unsupported'),
    reason: projectReasonSchema,
    explanation: safeTextSchema(1_000, { multiline: true }),
    citations: citationsSchema(0),
  }),
])

/**
 * A strictly validated real interpretation. At most one user-triggered re-analysis exists; it is
 * bound to an explicit answer and cannot ask another question.
 */
export const InterpretationSchema = z
  .strictObject({
    schema_version: z.literal(PROJECT_SCHEMA_VERSION),
    interpretation_id: projectUuidSchema,
    run_id: projectUuidSchema,
    invocation_id: projectUuidSchema,
    capture_id: projectUuidSchema,
    report_sha256: projectSha256Schema,
    input_sha256: projectSha256Schema,
    analysis_attempt: z.union([z.literal(1), z.literal(2)]),
    clarification: z.strictObject({ question_id: projectUuidSchema, answer_id: projectUuidSchema, answer_sha256: projectSha256Schema }).nullable(),
    result: InterpretationResultSchema,
  })
  .superRefine((interpretation, ctx) => {
    const issue = reporter(ctx)
    if (interpretation.analysis_attempt === 2 && interpretation.clarification === null) issue(['clarification'], 'CLARIFICATION_REQUIRED')
    if (interpretation.analysis_attempt === 1 && interpretation.clarification !== null) issue(['clarification'], 'CLARIFICATION_FORBIDDEN')
    if (interpretation.analysis_attempt === 2 && interpretation.result.status === 'clarify') issue(['result', 'status'], 'CLARIFICATION_REPEATED')
  })
export type Interpretation = z.infer<typeof InterpretationSchema>

// ---------------------------------------------------------------------------------------
// FrozenVerificationDefinition
// ---------------------------------------------------------------------------------------

const CHECK_ID = /^(?:[a-z]+(?:_[a-z]+)*|project_check:[a-z0-9]+(?:-[a-z0-9]+)*)$/

/** Required checks: every mandatory check first, in order, then unique project checks. */
const requiredChecksSchema = uniqueBy(z.string().max(64).regex(CHECK_ID))
  .max(MANDATORY_CHECK_IDS.length + PROJECT_LIMITS.maxProjectChecks)
  .superRefine((checks, ctx) => {
    const issue = reporter(ctx)
    if (!MANDATORY_CHECK_IDS.every((check) => checks.includes(check))) issue([], 'MANDATORY_CHECK_MISSING')
    else if (canonicalJson(checks.slice(0, MANDATORY_CHECK_IDS.length)) !== canonicalJson(MANDATORY_CHECK_IDS)) issue([], 'MANDATORY_CHECK_ORDER')
    if (!checks.slice(MANDATORY_CHECK_IDS.length).every((check) => check.startsWith('project_check:'))) issue([], 'MANDATORY_CHECK_ORDER')
  })

const definitionBodyShape = {
  schema_version: z.literal(PROJECT_SCHEMA_VERSION),
  definition_id: projectUuidSchema,
  run_id: projectUuidSchema,
  project_id: projectUuidSchema,
  baseline_commit: gitRevisionSchema,
  configuration_id: projectUuidSchema,
  configuration_digest: projectSha256Schema,
  capture_id: projectUuidSchema,
  report_sha256: projectSha256Schema,
  interpretation_id: projectUuidSchema,
  interpretation_sha256: projectSha256Schema,
  replay: ReplayDefinitionSchema,
  expected_conditions: conditionsSchema,
  task_condition_index: count(PROJECT_LIMITS.maxConditions - 1),
  required_checks: requiredChecksSchema,
  required_evidence: uniqueBy(z.enum(OBSERVATION_TYPES)).max(OBSERVATION_TYPES.length),
  compiler: z.strictObject({ id: z.literal(PROJECT_REPLAY_COMPILER_ID), version: z.string().regex(SEMVER) }),
  protected_digests: z.strictObject({
    source_tree_sha256: projectSha256Schema,
    configuration_sha256: projectSha256Schema,
    checks_sha256: projectSha256Schema,
    lock_sha256: projectSha256Schema,
  }),
  frozen_at: projectTimestampSchema,
}
const DefinitionBodySchema = z.strictObject(definitionBodyShape)
type DefinitionBody = z.infer<typeof DefinitionBodySchema>

const definitionDigestOf = (body: Record<string, unknown>): string => {
  const { definition_digest: _digest, ...bound } = body
  return projectDigest(bound)
}

/** The host-frozen obligation evaluated identically against baseline and candidate. */
export const FrozenVerificationDefinitionSchema = z
  .strictObject({ ...definitionBodyShape, definition_digest: projectSha256Schema })
  .superRefine((definition, ctx) => {
    const issue = reporter(ctx)
    if (definition.task_condition_index >= definition.expected_conditions.length) issue(['task_condition_index'], 'TASK_CONDITION_INDEX_INVALID')
    if (definitionDigestOf(definition) !== definition.definition_digest) issue(['definition_digest'], 'DEFINITION_DIGEST_MISMATCH')
  })
export type FrozenVerificationDefinition = z.infer<typeof FrozenVerificationDefinitionSchema>

export function withDefinitionDigest(body: DefinitionBody): FrozenVerificationDefinition {
  return { ...body, definition_digest: definitionDigestOf(body as Record<string, unknown>) } as FrozenVerificationDefinition
}

// ---------------------------------------------------------------------------------------
// ProviderInvocation
// ---------------------------------------------------------------------------------------

const tokenCount = z.int().min(0).max(100_000_000).nullable()

/**
 * Safe provenance of one actual provider exchange. `completed` requires the validated observed
 * response model and response ID; a configured constant or nonblank key never completes a call.
 */
export const ProviderInvocationSchema = z
  .strictObject({
    schema_version: z.literal(PROJECT_SCHEMA_VERSION),
    invocation_id: projectUuidSchema,
    run_id: projectUuidSchema,
    phase: z.enum(INVOCATION_PHASES),
    transport: z.enum(PROVIDER_TRANSPORTS),
    requested_model: z.literal(META_MODEL_ID),
    observed_model: z.string().regex(MODEL_NAME).nullable(),
    response_id: z.string().regex(RESPONSE_ID).nullable(),
    input_sha256: projectSha256Schema,
    included_source_paths: uniqueBy(projectRelativePathSchema).max(PROJECT_LIMITS.maxRequestSourceFiles),
    included_image_ids: uniqueBy(projectUuidSchema).max(PROJECT_LIMITS.maxRequestImages),
    included_observation_ids: uniqueBy(projectUuidSchema).max(64),
    request_bytes: count(PROJECT_LIMITS.maxRequestBytes),
    source_bytes: count(PROJECT_LIMITS.maxRequestSourceBytes),
    status: z.enum(INVOCATION_STATUSES),
    error_code: projectReasonSchema.nullable(),
    http_status: z.int().min(100).max(599).nullable(),
    usage: z.strictObject({ input_tokens: tokenCount, output_tokens: tokenCount, total_tokens: tokenCount }),
    latency_ms: z.int().min(0).max(EXECUTION_LIMITS.provider_timeout_ms * 2).nullable(),
    started_at: projectTimestampSchema,
    completed_at: projectTimestampSchema.nullable(),
  })
  .superRefine((invocation, ctx) => {
    const issue = reporter(ctx)
    const included = new Set(invocation.included_observation_ids)
    if (!invocation.included_image_ids.every((image) => included.has(image))) issue(['included_image_ids'], 'INVOCATION_IMAGE_NOT_INCLUDED')
    if (invocation.status === 'started') {
      const finishedFields = [invocation.observed_model, invocation.response_id, invocation.error_code, invocation.http_status, invocation.latency_ms, invocation.completed_at]
      const usage = Object.values(invocation.usage)
      if (finishedFields.some((field) => field !== null) || usage.some((field) => field !== null)) issue(['status'], 'INVOCATION_NOT_FINISHED')
      return
    }
    if (invocation.completed_at === null || Date.parse(invocation.completed_at) < Date.parse(invocation.started_at)) {
      issue(['completed_at'], 'INVOCATION_COMPLETION_TIME')
    }
    if (invocation.status === 'completed') {
      if (invocation.observed_model === null || invocation.response_id === null) issue(['response_id'], 'INVOCATION_RESPONSE_REQUIRED')
      else if (invocation.observed_model !== invocation.requested_model) issue(['observed_model'], 'INVOCATION_MODEL_MISMATCH')
      if (invocation.error_code !== null) issue(['error_code'], 'INVOCATION_ERROR_FORBIDDEN')
    }
    if (invocation.status === 'failed' && invocation.error_code === null) issue(['error_code'], 'INVOCATION_ERROR_REQUIRED')
  })
export type ProviderInvocation = z.infer<typeof ProviderInvocationSchema>

// ---------------------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------------------

/** One bounded correction. `applied-to-copy` means applied only to an owned copy, never the original. */
export const CandidateSchema = z
  .strictObject({
    schema_version: z.literal(PROJECT_SCHEMA_VERSION),
    candidate_id: projectUuidSchema,
    run_id: projectUuidSchema,
    baseline_commit: gitRevisionSchema,
    definition_id: projectUuidSchema,
    definition_digest: projectSha256Schema,
    invocation_id: projectUuidSchema,
    state: z.enum(CANDIDATE_STATES),
    patch_sha256: projectSha256Schema,
    patch_bytes: z.int().min(1).max(PROJECT_LIMITS.maxPatchBytes),
    changed_paths: uniqueBy(projectSourcePathSchema).min(1).max(PROJECT_LIMITS.maxPatchFiles),
    expected_tree_sha256: projectSha256Schema.nullable(),
    build_sha256: projectSha256Schema.nullable(),
    rejection_reasons: uniqueBy(projectReasonSchema).max(16),
  })
  .superRefine((candidate, ctx) => {
    const issue = reporter(ctx)
    if (candidate.state === 'rejected' && candidate.rejection_reasons.length === 0) issue(['rejection_reasons'], 'CANDIDATE_REASON_REQUIRED')
    if (candidate.state !== 'rejected' && candidate.rejection_reasons.length > 0) issue(['rejection_reasons'], 'CANDIDATE_REASON_FORBIDDEN')
    if (candidate.state === 'applied-to-copy' && candidate.expected_tree_sha256 === null) issue(['expected_tree_sha256'], 'CANDIDATE_TREE_REQUIRED')
    if (candidate.state !== 'applied-to-copy' && candidate.build_sha256 !== null) issue(['build_sha256'], 'CANDIDATE_BUILD_FORBIDDEN')
  })
export type Candidate = z.infer<typeof CandidateSchema>

// ---------------------------------------------------------------------------------------
// Terminal reduction
// ---------------------------------------------------------------------------------------

/** The outcome a failed mandatory check implies when nothing with higher precedence applies. */
const CHECK_OUTCOMES: Readonly<Record<MandatoryCheckId, RunOutcome>> = Object.freeze({
  admission_consistent: 'blocked',
  capture_complete: 'unsupported',
  interpretation_valid: 'unsupported',
  definition_frozen: 'unverified',
  baseline_reproduced: 'not_reproduced',
  correction_generated: 'generation_failed',
  candidate_applied: 'candidate_rejected',
  candidate_build: 'verification_failed',
  inputs_unchanged: 'verification_failed',
  candidate_replay: 'verification_failed',
  evidence_bound: 'unverified',
  original_unchanged: 'integrity_failed',
  cleanup_complete: 'cleanup_failed',
})

const outcomeForCheck = (checkId: string): RunOutcome =>
  checkId.startsWith('project_check:') ? 'verification_failed' : (CHECK_OUTCOMES[checkId as MandatoryCheckId] ?? 'unverified')

export interface ReducibleCheck {
  readonly id: string
  readonly status: CheckStatus
  readonly reason: string
}

export interface OutcomeReductionInput {
  readonly checks: readonly ReducibleCheck[]
  readonly cancel_requested: boolean
  readonly original_integrity: OriginalIntegrity
  readonly cleanup: CleanupState
}

export interface ReducedOutcome {
  readonly outcome: RunOutcome
  readonly primary_reason: string | null
  readonly blockers: readonly string[]
}

/**
 * Reduces a finalized run. Precedence: original integrity, then cleanup, then requested
 * cancellation, then the first failed check in required order; a run passes only when every
 * required check passed. A not-evaluated check without a failure leaves the run unverified.
 */
export function reduceProjectOutcome(input: OutcomeReductionInput): ReducedOutcome {
  const failed = input.checks.filter((check) => check.status === 'failed')
  const blockersExcept = (primary: string | null): string[] =>
    [...new Set(failed.map((check) => check.reason).filter((reason) => reason !== primary))].slice(0, 16)
  const stop = (outcome: RunOutcome, primary: string): ReducedOutcome => Object.freeze({ outcome, primary_reason: primary, blockers: Object.freeze(blockersExcept(primary)) })

  if (input.original_integrity !== 'verified') return stop('integrity_failed', input.original_integrity === 'changed' ? 'ORIGINAL_CHANGED' : 'ORIGINAL_UNVERIFIED')
  if (input.cleanup === 'failed' || input.cleanup === 'unverified') return stop('cleanup_failed', input.cleanup === 'failed' ? 'CLEANUP_INCOMPLETE' : 'CLEANUP_UNVERIFIED')
  if (input.cancel_requested) return stop('canceled', 'RUN_CANCELED')
  const firstFailed = failed[0]
  if (firstFailed !== undefined) return stop(outcomeForCheck(firstFailed.id), firstFailed.reason)
  const notEvaluated = input.checks.find((check) => check.status !== 'passed')
  if (notEvaluated !== undefined || input.checks.length === 0) return stop('unverified', notEvaluated?.reason ?? 'CHECK_NOT_EVALUATED')
  return Object.freeze({ outcome: 'passed', primary_reason: null, blockers: Object.freeze([]) })
}

// ---------------------------------------------------------------------------------------
// ProjectRunResult
// ---------------------------------------------------------------------------------------

const resultCheckSchema = z.strictObject({
  id: z.string().max(64).regex(CHECK_ID),
  status: z.enum(CHECK_STATUSES),
  phase: z.enum(CHECK_PHASES),
  reason: projectReasonSchema,
  evidence_ids: uniqueBy(projectUuidSchema).max(16),
})

/** Mirrors ProviderInvocation: `completed` carries the observed requested model and response ID. */
const invocationSummarySchema = z
  .strictObject({
    invocation_id: projectUuidSchema,
    phase: z.enum(INVOCATION_PHASES),
    transport: z.enum(PROVIDER_TRANSPORTS),
    status: z.enum(INVOCATION_STATUSES),
    requested_model: z.literal(META_MODEL_ID),
    observed_model: z.string().regex(MODEL_NAME).nullable(),
    response_id: z.string().regex(RESPONSE_ID).nullable(),
  })
  .superRefine((summary, ctx) => {
    const issue = reporter(ctx)
    if (summary.status === 'started' && (summary.observed_model !== null || summary.response_id !== null)) issue(['status'], 'INVOCATION_NOT_FINISHED')
    if (summary.status === 'completed') {
      if (summary.observed_model === null || summary.response_id === null) issue(['response_id'], 'INVOCATION_RESPONSE_REQUIRED')
      else if (summary.observed_model !== summary.requested_model) issue(['observed_model'], 'INVOCATION_MODEL_MISMATCH')
    }
  })

const artifactReferenceSchema = z.strictObject({ artifact_id: projectUuidSchema, sha256: projectSha256Schema })

/**
 * The authoritative terminal project-live result. **Project verification passed** is claimed only
 * when every required check passed, an actual correction produced the applied candidate, original
 * integrity is verified and cleanup completed. Cancellation, integrity and cleanup failures take
 * precedence over any provisional functional pass, and a late completion cannot overwrite them.
 */
export const ProjectRunResultSchema = z
  .strictObject({
    kind: z.literal(PROJECT_RESULT_KIND),
    schema_version: z.literal(PROJECT_SCHEMA_VERSION),
    run_id: projectUuidSchema,
    project_id: projectUuidSchema,
    baseline_commit: gitRevisionSchema,
    configuration_id: projectUuidSchema,
    configuration_digest: projectSha256Schema,
    capture_id: projectUuidSchema.nullable(),
    report_sha256: projectSha256Schema.nullable(),
    definition_id: projectUuidSchema.nullable(),
    definition_digest: projectSha256Schema.nullable(),
    candidate: z
      .strictObject({
        candidate_id: projectUuidSchema,
        state: z.enum(CANDIDATE_STATES),
        patch_sha256: projectSha256Schema,
        changed_paths: uniqueBy(projectSourcePathSchema).min(1).max(PROJECT_LIMITS.maxPatchFiles),
        build_sha256: projectSha256Schema.nullable(),
      })
      .nullable(),
    invocations: uniqueBy(invocationSummarySchema, (entry) => entry.invocation_id).max(PROJECT_LIMITS.maxAnalysisCalls + PROJECT_LIMITS.maxCorrectionCalls),
    required_checks: requiredChecksSchema,
    checks: z.array(resultCheckSchema).max(MANDATORY_CHECK_IDS.length + PROJECT_LIMITS.maxProjectChecks),
    evidence: uniqueBy(
      z.strictObject({ observation_id: projectUuidSchema, phase: z.enum(EVIDENCE_PHASES), sha256: projectSha256Schema }),
      (entry) => entry.observation_id,
    ).max(64),
    diff: artifactReferenceSchema.nullable(),
    patch: artifactReferenceSchema.nullable(),
    outcome: z.enum(RUN_OUTCOMES),
    claim: z.literal(PROJECT_CLAIM).nullable(),
    primary_reason: projectReasonSchema.nullable(),
    blockers: uniqueBy(projectReasonSchema).max(16),
    cancel_requested: z.boolean(),
    original_integrity: z.enum(ORIGINAL_INTEGRITY_STATES),
    cleanup: z.enum(CLEANUP_STATES),
    /** True only for a passed result whose every provider exchange used the real transport. */
    live_acceptance_eligible: z.boolean(),
    finalized_at: projectTimestampSchema,
  })
  .superRefine((result, ctx) => {
    const issue = reporter(ctx)
    const passed = result.outcome === 'passed'

    // Identity pairs are both present or both absent.
    if ((result.capture_id === null) !== (result.report_sha256 === null)) issue(['capture_id'], 'IDENTITY_PAIR_INCOMPLETE')
    if ((result.definition_id === null) !== (result.definition_digest === null)) issue(['definition_id'], 'IDENTITY_PAIR_INCOMPLETE')
    if ((result.diff !== null || result.patch !== null) && result.candidate === null) issue(['candidate'], 'ARTIFACT_WITHOUT_CANDIDATE')

    // Checks cover exactly the required list, in order.
    if (canonicalJson(result.checks.map((check) => check.id)) !== canonicalJson(result.required_checks)) issue(['checks'], 'CHECKS_DO_NOT_MATCH_REQUIRED')
    const evidence = new Set(result.evidence.map((entry) => entry.observation_id))
    result.checks.forEach((check, index) => {
      if (!check.evidence_ids.every((evidenceId) => evidence.has(evidenceId))) issue(['checks', index, 'evidence_ids'], 'EVIDENCE_REFERENCE_UNKNOWN')
    })
    const statusOf = (checkId: string): CheckStatus | undefined => result.checks.find((check) => check.id === checkId)?.status
    const integrityCheck = statusOf('original_unchanged')
    if (integrityCheck !== undefined && (integrityCheck === 'passed') !== (result.original_integrity === 'verified')) {
      issue(['checks'], 'INTEGRITY_CHECK_MISMATCH')
    }
    const cleanupCheck = statusOf('cleanup_complete')
    const cleanupPassed = result.cleanup === 'complete' || result.cleanup === 'recovered'
    if (cleanupCheck !== undefined && (cleanupCheck === 'passed') !== cleanupPassed) issue(['checks'], 'CLEANUP_CHECK_MISMATCH')

    // Per-run call budget: one analysis, one clarified re-analysis after it, one correction.
    const phases = result.invocations.map((entry) => entry.phase)
    const countOf = (phase: InvocationPhase): number => phases.filter((candidate) => candidate === phase).length
    if (countOf('analysis') > 1 || countOf('clarified-analysis') > 1 || countOf('correction') > PROJECT_LIMITS.maxCorrectionCalls) {
      issue(['invocations'], 'CALL_BUDGET_EXCEEDED')
    }
    const firstClarified = phases.indexOf('clarified-analysis')
    if (firstClarified !== -1 && !phases.slice(0, firstClarified).includes('analysis')) issue(['invocations'], 'CLARIFIED_WITHOUT_ANALYSIS')

    // Precedence of overriding outcomes.
    const expected =
      result.original_integrity !== 'verified'
        ? 'integrity_failed'
        : !cleanupPassed
          ? 'cleanup_failed'
          : result.cancel_requested
            ? 'canceled'
            : null
    const overriding: readonly RunOutcome[] = ['integrity_failed', 'cleanup_failed', 'canceled']
    if ((expected !== null || overriding.includes(result.outcome)) && result.outcome !== expected) issue(['outcome'], 'OUTCOME_PRECEDENCE')

    // The claim, reasons and live eligibility.
    if (result.claim !== null && !passed) issue(['claim'], 'CLAIM_ONLY_FOR_PASSED')
    if (passed && result.claim === null) issue(['claim'], 'CLAIM_REQUIRED_FOR_PASSED')
    if (passed && (result.primary_reason !== null || result.blockers.length > 0)) issue(['primary_reason'], 'PASSED_HAS_NO_REASON')
    if (!passed && result.primary_reason === null) issue(['primary_reason'], 'PRIMARY_REASON_REQUIRED')
    const allReal = result.invocations.length > 0 && result.invocations.every((entry) => entry.transport === 'meta')
    if (result.live_acceptance_eligible !== (passed && allReal)) issue(['live_acceptance_eligible'], 'LIVE_ELIGIBILITY_MISMATCH')

    if (passed) {
      if (!result.checks.every((check) => check.status === 'passed')) issue(['checks'], 'PASSED_REQUIRES_ALL_CHECKS')
      if (result.candidate === null || result.candidate.state !== 'applied-to-copy' || result.candidate.build_sha256 === null) {
        issue(['candidate'], 'PASSED_REQUIRES_CANDIDATE')
      }
      if (result.capture_id === null || result.definition_id === null) issue(['definition_id'], 'PASSED_REQUIRES_IDENTITIES')
      const correction = result.invocations.find((entry) => entry.phase === 'correction')
      const analysis = result.invocations.find((entry) => entry.phase === 'analysis')
      if (correction?.status !== 'completed' || analysis?.status !== 'completed') issue(['invocations'], 'PASSED_REQUIRES_CORRECTION')
    }
  })
export type ProjectRunResult = z.infer<typeof ProjectRunResultSchema>

/** Issues when a result does not belong to, or silently drops checks of, its configuration. */
export function resultConfigurationIssues(result: ProjectRunResult, configuration: ExecutionConfiguration): string[] {
  const issues: string[] = []
  if (result.configuration_id !== configuration.configuration_id || result.configuration_digest !== configuration.configuration_digest) {
    issues.push('CONFIGURATION_MISMATCH')
  } else if (!requiredCheckIds(configuration).every((check) => result.required_checks.includes(check))) {
    issues.push('PROJECT_CHECK_MISSING')
  }
  return issues
}

// ---------------------------------------------------------------------------------------
// Cross-object identity binding
// ---------------------------------------------------------------------------------------

export const BINDING_FIELDS = [
  'run_id',
  'project_id',
  'baseline_commit',
  'configuration_id',
  'configuration_digest',
  'capture_id',
  'report_sha256',
  'definition_id',
  'definition_digest',
  'interpretation_id',
  'candidate_id',
] as const
export type BindingField = (typeof BINDING_FIELDS)[number]
export type IdentityBinding = Partial<Record<BindingField, string | null>>

/**
 * Names (sorted) every expected identity field the actual object does not carry exactly. Callers
 * check this before any side effect, so an object from another run, capture, baseline,
 * configuration or definition is rejected instead of being evaluated.
 */
export function bindingMismatches(expected: IdentityBinding, actual: IdentityBinding): BindingField[] {
  return BINDING_FIELDS.filter((field) => field in expected && expected[field] !== actual[field]).sort()
}

// ---------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------

export type ProjectContractName =
  | 'project-context'
  | 'project-config-file'
  | 'execution-configuration'
  | 'demonstration-capture'
  | 'interaction-observation'
  | 'safe-observation'
  | 'interpretation'
  | 'frozen-verification-definition'
  | 'provider-invocation'
  | 'candidate'
  | 'project-run-result'

export interface ProjectContractIssue {
  readonly path: string
  readonly code: string
}

export type ProjectContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: 'CONTRACT_INVALID'; readonly contract: ProjectContractName; readonly issues: readonly ProjectContractIssue[] } }

function toIssue(issue: z.core.$ZodIssue): ProjectContractIssue {
  const path = issue.path.map(String).join('.') || '(root)'
  const custom = issue.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : undefined
  const code = typeof custom === 'string' && REASON_CODE_PATTERN.test(custom) ? custom : issue.code.toUpperCase()
  return Object.freeze({ path, code })
}

function parseWith<T>(contract: ProjectContractName, schema: z.ZodType<T>, input: unknown): ProjectContractResult<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: Object.freeze({ code: 'CONTRACT_INVALID', contract, issues: Object.freeze(parsed.error.issues.map(toIssue)) }) }
}

export const parseProjectContext = (input: unknown) => parseWith('project-context', ProjectContextSchema, input)
export const parseProjectConfigFile = (input: unknown) => parseWith('project-config-file', ProjectConfigFileSchema, input)
export const parseExecutionConfiguration = (input: unknown) => parseWith('execution-configuration', ExecutionConfigurationSchema, input)
export const parseDemonstrationCapture = (input: unknown) => parseWith('demonstration-capture', DemonstrationCaptureSchema, input)
export const parseInteractionObservation = (input: unknown) => parseWith('interaction-observation', InteractionObservationSchema, input)
export const parseSafeObservation = (input: unknown) => parseWith('safe-observation', SafeObservationSchema, input)
export const parseInterpretation = (input: unknown) => parseWith('interpretation', InterpretationSchema, input)
export const parseFrozenVerificationDefinition = (input: unknown) => parseWith('frozen-verification-definition', FrozenVerificationDefinitionSchema, input)
export const parseProviderInvocation = (input: unknown) => parseWith('provider-invocation', ProviderInvocationSchema, input)
export const parseCandidate = (input: unknown) => parseWith('candidate', CandidateSchema, input)
export const parseProjectRunResult = (input: unknown) => parseWith('project-run-result', ProjectRunResultSchema, input)

// ---------------------------------------------------------------------------------------
// Run lifecycle states (shared by the run coordinator, Studio and result reduction)
// ---------------------------------------------------------------------------------------

/** The declared Spec 006 run state sequence; `finalizing -> terminal` is reached only by finalization. */
export const RUN_STATES = [
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
] as const
export type RunState = (typeof RUN_STATES)[number]

/**
 * Human waiting states: selection/configuration, demonstration, report review, clarification,
 * interpretation review and result review (`terminal`). No execution countdown runs in them and
 * no automatic work may start in them, so they never close the window on the user's behalf.
 */
export const HUMAN_WAIT_STATES = [
  'project-selected',
  'configuration-required',
  'demonstration-ready',
  'recording',
  'capture-ready',
  'clarification-required',
  'interpretation-ready',
  'terminal',
] as const satisfies readonly RunState[]
export type HumanWaitState = (typeof HUMAN_WAIT_STATES)[number]

/** Automatic states: only these accrue the 600-second aggregate automatic budget. */
export const AUTOMATIC_RUN_STATES = ['preparing', 'analyzing', 'baseline-replay', 'correcting', 'candidate-checking'] as const satisfies readonly RunState[]
export type AutomaticRunState = (typeof AUTOMATIC_RUN_STATES)[number]

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  'project-selected': ['configuration-required', 'finalizing'],
  'configuration-required': ['preparing', 'finalizing'],
  preparing: ['demonstration-ready', 'finalizing'],
  'demonstration-ready': ['recording', 'finalizing'],
  // Discard returns to demonstration-ready; re-record from capture-ready starts a new capture.
  recording: ['capture-ready', 'demonstration-ready', 'finalizing'],
  'capture-ready': ['analyzing', 'recording', 'demonstration-ready', 'finalizing'],
  analyzing: ['clarification-required', 'interpretation-ready', 'finalizing'],
  'clarification-required': ['analyzing', 'finalizing'],
  'interpretation-ready': ['baseline-replay', 'finalizing'],
  'baseline-replay': ['correcting', 'finalizing'],
  correcting: ['candidate-checking', 'finalizing'],
  'candidate-checking': ['finalizing'],
  finalizing: ['terminal'],
  terminal: [],
})

export const canTransitionRun = (from: RunState, to: RunState): boolean => RUN_TRANSITIONS[from]?.includes(to) ?? false
export const isHumanWaitState = (state: RunState): boolean => (HUMAN_WAIT_STATES as readonly string[]).includes(state)
export const isAutomaticRunState = (state: RunState): state is AutomaticRunState => (AUTOMATIC_RUN_STATES as readonly string[]).includes(state)

/** Kinds of bounded automatic work; each runs only in its own automatic states. */
export const AUTOMATIC_OPERATION_KINDS = ['prepare', 'build', 'check', 'replay', 'provider'] as const
export type AutomaticOperationKind = (typeof AUTOMATIC_OPERATION_KINDS)[number]

export const OPERATION_STATES: Readonly<Record<AutomaticRunState, readonly AutomaticOperationKind[]>> = Object.freeze({
  preparing: ['prepare', 'build'],
  analyzing: ['provider'],
  'baseline-replay': ['build', 'check', 'replay'],
  correcting: ['provider'],
  'candidate-checking': ['build', 'check', 'replay'],
})

/** 90 seconds per provider exchange; 120 seconds per prepare/build/check/replay phase. */
export const operationTimeoutMs = (kind: AutomaticOperationKind): number =>
  kind === 'provider' ? EXECUTION_LIMITS.provider_timeout_ms : EXECUTION_LIMITS.phase_timeout_ms

/** A check never regresses from `failed`; `not_evaluated` may only become an evaluated status. */
export function canUpdateCheckStatus(from: CheckStatus, to: CheckStatus): boolean {
  if (from === 'not_evaluated') return true
  if (from === 'passed') return to === 'passed' || to === 'failed'
  return to === 'failed'
}
