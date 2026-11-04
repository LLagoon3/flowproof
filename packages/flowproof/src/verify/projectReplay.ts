import type { Browser, Locator as PlaywrightLocator, Page } from 'playwright'
import { z } from 'zod'

import type { ProjectArtifactContent, ProjectArtifactRecord, ProjectRunStore } from '../evidence/projectStore.js'
import { canonicalJson, sha256Hex } from '../evidence/store.js'
import {
  CONDITION_KINDS,
  EXECUTION_LIMITS,
  OBSERVATION_TYPES,
  PROJECT_LIMITS,
  PROJECT_REPLAY_COMPILER_ID,
  PROJECT_SCHEMA_VERSION,
  REPLAY_OPERATIONS,
  localhostOriginSchema,
  newProjectUuid,
  parseDemonstrationCapture,
  parseExecutionConfiguration,
  parseFrozenVerificationDefinition,
  parseInterpretation,
  parseProjectContext,
  parseSafeObservation,
  projectDigest,
  projectSha256Schema,
  projectUuidSchema,
  requiredCheckIds,
  withDefinitionDigest,
} from '../project/contracts.js'
import type {
  DemonstrationCapture,
  ExecutionConfiguration,
  ExpectedCondition,
  FrozenVerificationDefinition,
  InteractionObservation,
  Interpretation,
  Locator,
  ObservationType,
  ProjectContext,
  ProjectContractResult,
  ReplayAction,
  SafeObservation,
} from '../project/contracts.js'
import { CLEANUP_STEP_TIMEOUT_MS, systemLifecycleClock } from '../project/run.js'
import type { LifecycleClock } from '../project/run.js'

// The host-owned project replay compiler and interpreter (Spec 006 T037, contracts/capture-and-replay.md).
//
// Compiler: a model interpretation is untrusted data. Only the closed S1 replay/condition schemas are
// accepted, then bound to the actual project, confirmed configuration, sealed capture and the
// interpretation. Replay actions must reproduce recorded interactions in recorded order with admitted
// safe values; viewport and entry path are the demonstrated ones; 1–8 conjunctive conditions must be
// consistent and not trivially true. Nothing is executable: no code string, page evaluation, shell,
// regular expression, request client or module path exists in the language. The result is a deep-frozen
// handle registered in this module; only such a handle can be executed or persisted, so a definition
// copied from editable (candidate) storage or re-parsed from bytes can never replace it.
//
// Interpreter: every execution consumes one single-use session bound to an actual phase (baseline or
// candidate), run, definition digest, target origin and build. Mismatches are rejected before any
// browser call. Each action resolves a unique locator, is bounded by the documented wait and phase
// limits and is followed by an origin/violation check; waits poll deterministic state only. Conditions
// report satisfied, unsatisfied or unevaluable; required run-bound evidence and collector availability
// are checked, and missing evidence can never yield a satisfied outcome. Deciding whether an outcome is
// an intended baseline failure or a candidate pass belongs to the run orchestration, not here.

export const PROJECT_REPLAY_COMPILER_VERSION = '1.0.0'
/** Interval between probes of a bounded state wait; never a fixed delay between actions. */
export const REPLAY_POLL_INTERVAL_MS = 100

const COMPILER_DESCRIPTOR = Object.freeze({
  id: PROJECT_REPLAY_COMPILER_ID,
  version: PROJECT_REPLAY_COMPILER_VERSION,
  operations: REPLAY_OPERATIONS,
  conditions: CONDITION_KINDS,
  wait_conditions: ['visible', 'text', 'path'],
  limits: {
    max_actions: PROJECT_LIMITS.maxReplayActions,
    min_conditions: PROJECT_LIMITS.minConditions,
    max_conditions: PROJECT_LIMITS.maxConditions,
    max_wait_ms: PROJECT_LIMITS.maxWaitMs,
    phase_timeout_ms: EXECUTION_LIMITS.phase_timeout_ms,
    poll_interval_ms: REPLAY_POLL_INTERVAL_MS,
  },
})

/** Digest of the compiler's closed semantics; it changes whenever operations or limits change. */
export const PROJECT_REPLAY_COMPILER_SHA256 = projectDigest(COMPILER_DESCRIPTOR)

export type ProjectReplayErrorCode = 'DEFINITION_NOT_HOST_FROZEN' | 'DEFINITION_PERSIST_MISMATCH' | 'REPLAY_BINDING_INVALID' | 'REPLAY_CONTEXT_NOT_FRESH'

export class ProjectReplayError extends Error {
  readonly code: ProjectReplayErrorCode

  constructor(code: ProjectReplayErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ProjectReplayError'
    this.code = code
  }
}

/** A coded failure a replay driver may raise; any other error is reported as a generic action failure. */
export class ReplayDriverError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ReplayDriverError'
    this.code = code
  }
}

const REASON = /^[A-Z][A-Z0-9_]{0,63}$/
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

// ---------------------------------------------------------------------------------------
// Frozen definition handle
// ---------------------------------------------------------------------------------------

/** Host-private identities bound with the S1 definition; never part of a candidate mount. */
export interface FrozenReplayIdentity {
  readonly definition_id: string
  readonly definition_digest: string
  readonly run_id: string
  readonly project_id: string
  readonly project_context_sha256: string
  readonly admitted_tree_sha256: string
  readonly baseline_commit: string
  readonly configuration_id: string
  readonly configuration_digest: string
  readonly target_origin: string
  readonly capture_id: string
  readonly report_sha256: string
  readonly interpretation_id: string
  readonly interpretation_sha256: string
  readonly cited_evidence_sha256: string
  readonly compiler_sha256: string
}

export interface FrozenReplay {
  /** The exact S1 FrozenVerificationDefinition, deep-frozen. */
  readonly definition: FrozenVerificationDefinition
  readonly identity: FrozenReplayIdentity
  /** Digest over `identity`. */
  readonly record_sha256: string
}

const hostFrozen = new WeakSet<object>()

/** True only for a handle minted by `compileFrozenReplay` in this process. */
export const isHostFrozenReplay = (value: unknown): value is FrozenReplay => typeof value === 'object' && value !== null && hostFrozen.has(value)

function definitionIntact(frozen: FrozenReplay): boolean {
  const parsed = parseFrozenVerificationDefinition(frozen.definition)
  if (!parsed.ok || !Object.isFrozen(frozen.definition) || !Object.isFrozen(frozen.identity)) return false
  const { definition, identity } = frozen
  return (
    identity.definition_id === definition.definition_id &&
    identity.definition_digest === definition.definition_digest &&
    identity.run_id === definition.run_id &&
    identity.project_id === definition.project_id &&
    identity.baseline_commit === definition.baseline_commit &&
    identity.configuration_id === definition.configuration_id &&
    identity.configuration_digest === definition.configuration_digest &&
    identity.capture_id === definition.capture_id &&
    identity.report_sha256 === definition.report_sha256 &&
    identity.interpretation_id === definition.interpretation_id &&
    identity.interpretation_sha256 === definition.interpretation_sha256 &&
    identity.compiler_sha256 === PROJECT_REPLAY_COMPILER_SHA256 &&
    projectDigest(identity) === frozen.record_sha256
  )
}

// ---------------------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------------------

export interface CompileFrozenReplayInput {
  readonly run_id: string
  readonly project: unknown
  readonly configuration: unknown
  readonly capture: unknown
  readonly interpretation: unknown
}

export interface CompileFrozenReplayOptions {
  readonly now?: () => Date
  readonly newId?: () => string
}

export interface ReplayCompileIssue {
  readonly contract: string
  readonly path: string
  readonly code: string
}

export type CompileFrozenReplayResult =
  | { readonly ok: true; readonly frozen: FrozenReplay }
  | { readonly ok: false; readonly reasons: readonly string[]; readonly issues: readonly ReplayCompileIssue[] }

type ReadyResult = Extract<Interpretation['result'], { status: 'ready' }>
type RecordedAction = InteractionObservation['action']
type StepAction = Exclude<ReplayAction, { op: 'wait' }>
type WaitAction = Extract<ReplayAction, { op: 'wait' }>

const GLOBAL_CSS_COMPOUNDS = new Set(['*', 'html', 'head', 'body'])
const sameLocator = (left: Locator, right: Locator): boolean => canonicalJson(left) === canonicalJson(right)
const hasLocator = (candidates: readonly Locator[], locator: Locator): boolean => candidates.some((candidate) => sameLocator(candidate, locator))
const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A selector that addresses the document itself is not a meaningful element check. */
const isGlobalLocator = (locator: Locator): boolean => locator.kind === 'css' && locator.selector.split(/ > | /).every((compound) => GLOBAL_CSS_COMPOUNDS.has(compound))
/** Role locators need a safe accessible name; a bare role is not a supported unique locator. */
const isUnsafeLocator = (locator: Locator): boolean => locator.kind === 'role' && locator.name.trim() === ''

function prescan(interpretation: unknown, add: (reason: string) => void): void {
  const result = isRecord(interpretation) ? interpretation.result : undefined
  if (!isRecord(result)) return
  const replay = result.replay
  const actions = isRecord(replay) && Array.isArray(replay.actions) ? replay.actions : []
  for (const action of actions) {
    if (!isRecord(action) || !(REPLAY_OPERATIONS as readonly unknown[]).includes(action.op)) add('REPLAY_OPERATION_UNSUPPORTED')
    else if (action.op === 'wait' && !(isRecord(action.until) && ['visible', 'text', 'path'].includes(action.until.kind as string))) add('WAIT_CONDITION_UNSUPPORTED')
  }
  const conditions = Array.isArray(result.expected_conditions) ? result.expected_conditions : []
  for (const condition of conditions) {
    if (!isRecord(condition) || !(CONDITION_KINDS as readonly unknown[]).includes(condition.kind)) add('CONDITION_KIND_UNSUPPORTED')
  }
}

function matchRecorded(action: StepAction, recorded: RecordedAction): 'match' | 'redacted' | 'value' | 'none' {
  switch (action.op) {
    case 'click':
      return recorded.type === 'click' && hasLocator(recorded.locators, action.locator) ? 'match' : 'none'
    case 'fill':
      if (recorded.type !== 'fill' || !hasLocator(recorded.locators, action.locator)) return 'none'
      if (recorded.value.kind === 'redacted') return 'redacted'
      return recorded.value.text === action.value ? 'match' : 'value'
    case 'select':
      if (recorded.type !== 'select' || !hasLocator(recorded.locators, action.locator)) return 'none'
      if (recorded.value.kind === 'redacted') return 'redacted'
      return recorded.value.option === action.value ? 'match' : 'value'
    case 'scroll': {
      if (recorded.type !== 'scroll') return 'none'
      if (action.target.kind === 'page') {
        if (recorded.target.kind !== 'page') return 'none'
      } else if (recorded.target.kind !== 'element' || !hasLocator(recorded.target.locators, action.target.locator)) return 'none'
      return recorded.x === action.x && recorded.y === action.y ? 'match' : 'value'
    }
    case 'navigate':
      return recorded.type === 'navigate' && recorded.path === action.path ? 'match' : 'none'
  }
}

/** Non-wait actions must be an in-order subsequence of the recorded interactions with admitted values. */
function bindActions(actions: readonly ReplayAction[], interactions: readonly InteractionObservation[], add: (reason: string) => void): void {
  let cursor = 0
  for (const action of actions) {
    if (action.op === 'wait') continue
    const states = interactions.map((interaction) => matchRecorded(action, interaction.action))
    const found = states.findIndex((state, index) => index >= cursor && state === 'match')
    if (found !== -1) {
      cursor = found + 1
      continue
    }
    if (states.slice(0, cursor).includes('match')) add('REPLAY_ORDER_MISMATCH')
    else if (states.includes('redacted')) add('REPLAY_VALUE_REDACTED')
    else if (states.includes('value')) add('REPLAY_VALUE_NOT_ADMITTED')
    else add('REPLAY_ACTION_NOT_RECORDED')
  }
}

/** A conjunction that no document state can satisfy is an always-false placeholder. */
function contradictory(conditions: readonly ExpectedCondition[]): boolean {
  const paths = new Set<string>()
  const byLocator = new Map<string, ExpectedCondition[]>()
  for (const condition of conditions) {
    if (condition.kind === 'path') paths.add(condition.path)
    else if (condition.kind !== 'no-error') {
      const key = canonicalJson(condition.locator)
      byLocator.set(key, [...(byLocator.get(key) ?? []), condition])
    }
  }
  if (paths.size > 1) return true
  for (const group of byLocator.values()) {
    const visible = new Set<boolean>()
    const counts = new Set<number>()
    const exact = new Set<string>()
    const normalized = new Set<string>()
    const values = new Set<string>()
    let requiresSingle = false
    for (const condition of group) {
      if (condition.kind === 'element-visible') {
        visible.add(condition.visible)
        if (condition.visible) requiresSingle = true
      } else if (condition.kind === 'element-count') counts.add(condition.count)
      else if (condition.kind === 'text') {
        requiresSingle = true
        if (condition.match === 'exact') exact.add(condition.text)
        normalized.add(normalizeText(condition.text))
      } else if (condition.kind === 'form-value') {
        requiresSingle = true
        values.add(condition.value)
      }
    }
    if (visible.size > 1 || counts.size > 1 || exact.size > 1 || normalized.size > 1 || values.size > 1) return true
    const count = [...counts][0]
    if (requiresSingle && count !== undefined && count !== 1) return true
  }
  return false
}

function waitEquivalent(until: WaitAction['until'], condition: ExpectedCondition): boolean {
  switch (until.kind) {
    case 'visible':
      return condition.kind === 'element-visible' && condition.visible && sameLocator(until.locator, condition.locator)
    case 'text':
      return condition.kind === 'text' && condition.match === 'normalized' && sameLocator(until.locator, condition.locator) && normalizeText(until.text) === normalizeText(condition.text)
    case 'path':
      return condition.kind === 'path' && condition.path === until.path
  }
}

/** A task condition already asserted by a trailing successful wait cannot fail in the intended way. */
function tautological(actions: readonly ReplayAction[], task: ExpectedCondition): boolean {
  let lastStep = -1
  actions.forEach((action, index) => {
    if (action.op !== 'wait') lastStep = index
  })
  return actions.slice(lastStep + 1).some((action) => action.op === 'wait' && waitEquivalent(action.until, task))
}

function errorObserved(capture: DemonstrationCapture, type: ObservationType, fingerprint: string): boolean {
  return capture.observations.some(
    (observation) => observation.type === type && observation.type !== 'image' && observation.availability === 'available' && observation.payload?.fingerprint === fingerprint,
  )
}

/**
 * Compiles a ready interpretation into the frozen verification definition. Pure: it performs no I/O
 * and never mutates its inputs. Any rejection returns stable reason codes and no definition.
 */
export function compileFrozenReplay(input: CompileFrozenReplayInput, options: CompileFrozenReplayOptions = {}): CompileFrozenReplayResult {
  const reasons = new Set<string>()
  const issues: ReplayCompileIssue[] = []
  const add = (reason: string): void => {
    reasons.add(reason)
  }
  const reject = (): CompileFrozenReplayResult => Object.freeze({ ok: false, reasons: Object.freeze([...reasons].sort()), issues: Object.freeze(issues) })
  const parsed = <T>(reason: string, result: ProjectContractResult<T>): T | undefined => {
    if (result.ok) return result.value
    add(reason)
    for (const issue of result.error.issues) issues.push(Object.freeze({ contract: result.error.contract, path: issue.path, code: issue.code }))
    return undefined
  }

  const source: Partial<CompileFrozenReplayInput> = isRecord(input) ? input : {}
  prescan(source.interpretation, add)
  const runId = projectUuidSchema.safeParse(source.run_id)
  if (!runId.success) add('RUN_ID_INVALID')
  const project = parsed<ProjectContext>('PROJECT_INVALID', parseProjectContext(source.project))
  const configuration = parsed<ExecutionConfiguration>('CONFIGURATION_INVALID', parseExecutionConfiguration(source.configuration))
  const capture = parsed<DemonstrationCapture>('CAPTURE_INVALID', parseDemonstrationCapture(source.capture))
  const interpretation = parsed<Interpretation>('INTERPRETATION_INVALID', parseInterpretation(source.interpretation))
  if (!runId.success || project === undefined || configuration === undefined || capture === undefined || interpretation === undefined) return reject()
  const run = runId.data

  // Identity: the project, confirmed configuration, sealed capture and interpretation of this run.
  if (project.admission.state !== 'ready') add('PROJECT_NOT_READY')
  if (configuration.confirmation.state !== 'confirmed') add('CONFIGURATION_NOT_CONFIRMED')
  if (configuration.project_id !== project.project_id || capture.project_id !== project.project_id) add('PROJECT_MISMATCH')
  if (configuration.baseline_commit !== project.baseline_commit || capture.baseline_commit !== project.baseline_commit) add('BASELINE_STALE')
  const profile = configuration.profile
  if (profile.image_id !== project.profile.image_id || profile.dependency_tree_sha256 !== project.profile.dependency_tree_sha256 || profile.manifest_sha256 !== project.profile.manifest_sha256) {
    add('PROFILE_MISMATCH')
  }
  if (configuration.inputs.lock_sha256 !== project.profile.lock_sha256) add('LOCK_MISMATCH')
  if (capture.configuration_id !== configuration.configuration_id || capture.configuration_digest !== configuration.configuration_digest) add('CONFIGURATION_STALE')
  if (capture.target_origin !== configuration.target_origin) add('TARGET_ORIGIN_MISMATCH')
  if (capture.run_id !== run || interpretation.run_id !== run) add('RUN_MISMATCH')
  const seal = capture.state === 'ready' ? capture.seal : null
  if (seal === null) add('CAPTURE_NOT_READY')
  if (interpretation.capture_id !== capture.capture_id || interpretation.report_sha256 !== capture.seal?.report_sha256) add('REPORT_MISMATCH')

  // Ambiguity and unsupported interpretations are resolved before anything is frozen.
  const result = interpretation.result
  if (result.status === 'clarify') add('INTERPRETATION_AMBIGUOUS')
  if (result.status === 'unsupported') add('INTERPRETATION_UNSUPPORTED')
  if (result.status !== 'ready' || seal === null) return reject()
  const ready: ReadyResult = result

  const observations = new Map(capture.observations.map((observation) => [observation.observation_id, observation]))
  for (const citation of ready.citations) {
    const cited = observations.get(citation)
    if (cited === undefined) add('CITATION_UNKNOWN')
    else if (cited.availability !== 'available') add('CITATION_UNAVAILABLE')
  }

  const { replay } = ready
  if (replay.entry_path !== configuration.entry_path) add('ENTRY_PATH_MISMATCH')
  if (canonicalJson(replay.viewport) !== canonicalJson(capture.viewport)) add('VIEWPORT_MISMATCH')
  const waitBudget = replay.actions.reduce((total, action) => total + (action.op === 'wait' ? action.timeout_ms : 0), 0)
  if (waitBudget > EXECUTION_LIMITS.phase_timeout_ms) add('REPLAY_WAIT_BUDGET_EXCEEDED')
  for (const action of replay.actions) {
    const locator =
      action.op === 'wait' ? (action.until.kind === 'path' ? null : action.until.locator) : action.op === 'navigate' ? null : action.op === 'scroll' ? (action.target.kind === 'element' ? action.target.locator : null) : action.locator
    if (locator === null) continue
    if (isUnsafeLocator(locator)) add('LOCATOR_UNSAFE')
    if (isGlobalLocator(locator)) add('LOCATOR_GLOBAL')
  }
  bindActions(replay.actions, capture.interactions, add)

  for (const condition of ready.expected_conditions) {
    if (condition.kind === 'path') continue
    if (condition.kind === 'no-error') {
      if (!errorObserved(capture, condition.error_type, condition.fingerprint)) add('CONDITION_ERROR_NOT_OBSERVED')
      continue
    }
    if (isUnsafeLocator(condition.locator)) add('LOCATOR_UNSAFE')
    if (isGlobalLocator(condition.locator)) add('CONDITION_PLACEHOLDER')
  }
  if (contradictory(ready.expected_conditions)) add('CONDITIONS_CONTRADICTORY')
  const task = ready.expected_conditions[ready.task_condition_index]
  if (task !== undefined && tautological(replay.actions, task)) add('TASK_CONDITION_TAUTOLOGICAL')
  if (reasons.size > 0) return reject()

  const requiredEvidence = OBSERVATION_TYPES.filter(
    (type) => type === 'image' || ready.expected_conditions.some((condition) => condition.kind === 'no-error' && condition.error_type === type),
  )
  const interpretationSha256 = projectDigest(interpretation)
  const definition = withDefinitionDigest({
    schema_version: PROJECT_SCHEMA_VERSION,
    definition_id: (options.newId ?? newProjectUuid)(),
    run_id: run,
    project_id: project.project_id,
    baseline_commit: project.baseline_commit,
    configuration_id: configuration.configuration_id,
    configuration_digest: configuration.configuration_digest,
    capture_id: capture.capture_id,
    report_sha256: seal.report_sha256,
    interpretation_id: interpretation.interpretation_id,
    interpretation_sha256: interpretationSha256,
    replay: structuredClone(replay),
    expected_conditions: structuredClone(ready.expected_conditions),
    task_condition_index: ready.task_condition_index,
    required_checks: requiredCheckIds(configuration),
    required_evidence: requiredEvidence,
    compiler: { id: PROJECT_REPLAY_COMPILER_ID, version: PROJECT_REPLAY_COMPILER_VERSION },
    protected_digests: { ...configuration.inputs },
    frozen_at: (options.now ?? (() => new Date()))().toISOString(),
  })
  const checked = parsed<FrozenVerificationDefinition>('DEFINITION_INVALID', parseFrozenVerificationDefinition(definition))
  if (checked === undefined) return reject()

  const cited = [...ready.citations].sort().map((citation) => observations.get(citation))
  const identity: FrozenReplayIdentity = {
    definition_id: checked.definition_id,
    definition_digest: checked.definition_digest,
    run_id: run,
    project_id: project.project_id,
    project_context_sha256: projectDigest(project),
    admitted_tree_sha256: project.admitted_tree_sha256,
    baseline_commit: project.baseline_commit,
    configuration_id: configuration.configuration_id,
    configuration_digest: configuration.configuration_digest,
    target_origin: configuration.target_origin,
    capture_id: capture.capture_id,
    report_sha256: seal.report_sha256,
    interpretation_id: interpretation.interpretation_id,
    interpretation_sha256: interpretationSha256,
    cited_evidence_sha256: projectDigest({ required_evidence: requiredEvidence, cited }),
    compiler_sha256: PROJECT_REPLAY_COMPILER_SHA256,
  }
  const frozen: FrozenReplay = deepFreeze({ definition: checked, identity, record_sha256: projectDigest(identity) })
  hostFrozen.add(frozen)
  return Object.freeze({ ok: true, frozen })
}

// ---------------------------------------------------------------------------------------
// Persistence outside every candidate mount
// ---------------------------------------------------------------------------------------

/**
 * Stores the exact definition in the run's outside-checkout state store. The store refuses roots
 * inside the selected project; the stored bytes are for review and never become an executable handle.
 */
export async function persistFrozenReplay(frozen: FrozenReplay, store: ProjectRunStore): Promise<ProjectArtifactRecord> {
  if (!isHostFrozenReplay(frozen) || !definitionIntact(frozen)) throw new ProjectReplayError('DEFINITION_NOT_HOST_FROZEN', 'Only a host-frozen definition can be persisted.')
  const record = await store.writeJson('definition', frozen.definition)
  if (record.kind !== 'definition' || record.sha256 !== sha256Hex(canonicalJson(frozen.definition))) {
    throw new ProjectReplayError('DEFINITION_PERSIST_MISMATCH', 'The stored definition differs from the frozen definition.')
  }
  return record
}

/** True only when stored content is exactly this frozen definition of this run. */
export function storedDefinitionMatches(frozen: FrozenReplay, content: ProjectArtifactContent): boolean {
  if (!isHostFrozenReplay(frozen) || !definitionIntact(frozen)) return false
  const expected = Buffer.from(canonicalJson(frozen.definition), 'utf8')
  return (
    content.record.kind === 'definition' &&
    content.record.run_id === frozen.definition.run_id &&
    content.record.sha256 === sha256Hex(expected) &&
    Buffer.isBuffer(content.bytes) &&
    content.bytes.equals(expected)
  )
}

// ---------------------------------------------------------------------------------------
// Phase sessions: the minimal host-owned browser boundary
// ---------------------------------------------------------------------------------------

export const REPLAY_PHASES = ['baseline', 'candidate'] as const
export type ReplayPhase = (typeof REPLAY_PHASES)[number]

const ReplayPhaseBindingSchema = z.strictObject({
  run_id: projectUuidSchema,
  phase: z.enum(REPLAY_PHASES),
  definition_id: projectUuidSchema,
  definition_digest: projectSha256Schema,
  target_origin: localhostOriginSchema,
  build_sha256: projectSha256Schema,
})
export type ReplayPhaseBinding = z.infer<typeof ReplayPhaseBindingSchema>

export type ReplayFieldKind = 'text' | 'select' | 'unsupported'

/**
 * Closed primitive operations on one fresh target page. Implementations take host-built arguments
 * only: absolute same-origin URLs, closed locators and admitted values. No member accepts code.
 */
export interface ReplayDriver {
  /** The actual page viewport, or null when unknown. */
  viewport(): { readonly width: number; readonly height: number } | null
  navigate(url: string, timeoutMs: number): Promise<{ readonly status: number | null }>
  currentUrl(): string
  count(locator: Locator, timeoutMs: number): Promise<number>
  isVisible(locator: Locator, timeoutMs: number): Promise<boolean>
  fieldKind(locator: Locator, timeoutMs: number): Promise<ReplayFieldKind>
  click(locator: Locator, timeoutMs: number): Promise<void>
  fill(locator: Locator, value: string, timeoutMs: number): Promise<void>
  select(locator: Locator, value: string, timeoutMs: number): Promise<void>
  scroll(target: Locator | null, x: number, y: number, timeoutMs: number): Promise<void>
  text(locator: Locator, timeoutMs: number): Promise<string | null>
  value(locator: Locator, timeoutMs: number): Promise<string>
  /** Host-observed unsupported events (popup, dialog, download) as reason codes. */
  violations(): readonly string[]
}

export type ReplayCheckpoint = { readonly kind: 'start' | 'end'; readonly action_index: null } | { readonly kind: 'action'; readonly action_index: number }

/** Run-bound evidence for one phase, supplied by the host's privacy-preserving collectors. */
export interface ReplayEvidenceCollector {
  /** Host-attested availability of a collector in this session. */
  available(type: ObservationType): boolean
  checkpoint?(point: ReplayCheckpoint): Promise<void>
  /**
   * Ends the phase's observation window and returns what was collected since the session opened;
   * untrusted until parsed and bound. Events after drain belong to no verdict: `no-error` asserts
   * absence only within this window, never that the page cannot raise the error later.
   */
  drain(): Promise<readonly unknown[]>
}

export interface ReplaySession {
  readonly kind: 'project-replay-session'
}

interface SessionState {
  readonly binding: unknown
  readonly driver: ReplayDriver
  readonly collector: ReplayEvidenceCollector | null
  readonly release: () => Promise<void>
  used: boolean
}

const sessions = new WeakMap<ReplaySession, SessionState>()

function snapshot(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return undefined
  }
}

/** Registers a single-use phase session. A session executes once and is then released. */
export function createReplaySession(options: {
  readonly binding: unknown
  readonly driver: ReplayDriver
  readonly collector?: ReplayEvidenceCollector
  readonly release: () => Promise<void>
}): ReplaySession {
  const session: ReplaySession = Object.freeze({ kind: 'project-replay-session' })
  sessions.set(session, { binding: snapshot(options.binding), driver: options.driver, collector: options.collector ?? null, release: options.release, used: false })
  return session
}

function playwrightLocator(page: Page, locator: Locator): PlaywrightLocator {
  switch (locator.kind) {
    case 'test-id':
      return page.getByTestId(locator.value)
    case 'role':
      return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], { name: locator.name, exact: true })
    case 'css':
      // The explicit engine prefix keeps the validated simple selector from selecting another engine.
      return page.locator(`css=${locator.selector}`)
  }
}

const TEXT_INPUT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'number']

function playwrightReason(error: unknown): ReplayDriverError {
  if (error instanceof ReplayDriverError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  if (name === 'TimeoutError') return new ReplayDriverError('REPLAY_ACTION_TIMEOUT')
  if (message.includes('strict mode violation')) return new ReplayDriverError('LOCATOR_AMBIGUOUS')
  return new ReplayDriverError('REPLAY_ACTION_FAILED')
}

async function guardPlaywright<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw playwrightReason(error)
  }
}

/**
 * Opens one phase session in a new, empty Chromium browser context: no storage state, service
 * workers blocked, downloads refused, popups/dialogs reported, and every request or WebSocket to
 * another origin refused. The context is the session's only state and is closed on release, so
 * nothing carries over between phases. The page is created by the host, never by the target.
 * Pass a headless browser: this module cannot detect human pointer/keyboard input in a headed
 * window, so a headed integration must lock target input itself during automatic replay.
 */
export async function openChromiumReplaySession(
  browser: Browser,
  frozen: FrozenReplay,
  binding: unknown,
  options: { readonly collector?: ReplayEvidenceCollector } = {},
): Promise<ReplaySession> {
  if (!isHostFrozenReplay(frozen) || !definitionIntact(frozen)) throw new ProjectReplayError('DEFINITION_NOT_HOST_FROZEN', 'Only a host-frozen definition can open a session.')
  const parsedBinding = ReplayPhaseBindingSchema.safeParse(snapshot(binding))
  if (!parsedBinding.success) throw new ProjectReplayError('REPLAY_BINDING_INVALID', 'A replay session needs a valid phase binding.')
  const origin = parsedBinding.data.target_origin
  const { width, height } = frozen.definition.replay.viewport
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false })
  try {
    if (context.pages().length !== 0 || (await context.cookies()).length !== 0) throw new ProjectReplayError('REPLAY_CONTEXT_NOT_FRESH', 'The replay context is not empty.')
    const violations: string[] = []
    let main: Page | null = null
    await context.route('**/*', async (route) => {
      let allowed = false
      try {
        allowed = new URL(route.request().url()).origin === origin
      } catch {
        allowed = false
      }
      await (allowed ? route.continue() : route.abort('blockedbyclient'))
    })
    await context.routeWebSocket(/.*/, (socket) => socket.close())
    context.on('page', (page) => {
      if (main === null || page === main) return
      violations.push('REPLAY_POPUP')
      void page.close().catch(() => undefined)
    })
    const page = await context.newPage()
    main = page
    page.on('dialog', (dialog) => {
      violations.push('REPLAY_DIALOG')
      void dialog.dismiss().catch(() => undefined)
    })
    page.on('download', () => violations.push('REPLAY_DOWNLOAD'))

    const target = (locator: Locator): PlaywrightLocator => playwrightLocator(page, locator)
    const driver: ReplayDriver = {
      viewport: () => page.viewportSize(),
      navigate: (url, timeout) =>
        guardPlaywright(async () => {
          const response = await page.goto(url, { waitUntil: 'load', timeout })
          return { status: response?.status() ?? null }
        }),
      currentUrl: () => page.url(),
      count: (locator) => guardPlaywright(() => target(locator).count()),
      isVisible: (locator) => guardPlaywright(() => target(locator).isVisible()),
      // Host-authored constant probe; it receives no definition data and returns a closed kind.
      fieldKind: (locator, timeout) =>
        guardPlaywright(() =>
          target(locator).evaluate(
            (node, textTypes) => {
              const element = node as unknown as { localName?: string; type?: string; multiple?: boolean }
              if (element.localName === 'textarea') return 'text'
              if (element.localName === 'select') return element.multiple === true ? 'unsupported' : 'select'
              if (element.localName === 'input') return textTypes.includes(String(element.type ?? '').toLowerCase()) ? 'text' : 'unsupported'
              return 'unsupported'
            },
            TEXT_INPUT_TYPES,
            { timeout },
          ),
        ) as Promise<ReplayFieldKind>,
      click: (locator, timeout) => guardPlaywright(() => target(locator).click({ timeout })),
      fill: (locator, value, timeout) => guardPlaywright(() => target(locator).fill(value, { timeout })),
      select: (locator, value, timeout) =>
        guardPlaywright(async () => {
          const selected = await target(locator).selectOption({ value }, { timeout })
          if (!selected.includes(value)) throw new ReplayDriverError('SELECT_VALUE_NOT_APPLIED')
        }),
      // Host-authored constant scroll with numeric arguments only.
      scroll: (locator, x, y, timeout) =>
        guardPlaywright(async () => {
          if (locator === null) await page.evaluate(([left, top]) => (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(left, top), [x, y] as const)
          else await target(locator).evaluate((node, [left, top]) => (node as unknown as { scrollTo(x: number, y: number): void }).scrollTo(left, top), [x, y] as const, { timeout })
        }),
      text: (locator, timeout) => guardPlaywright(() => target(locator).textContent({ timeout })),
      value: (locator, timeout) => guardPlaywright(() => target(locator).inputValue({ timeout })),
      violations: () => [...violations],
    }
    const sessionOptions = options.collector === undefined ? {} : { collector: options.collector }
    return createReplaySession({ binding, driver, ...sessionOptions, release: () => context.close() })
  } catch (error) {
    await context.close().catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------------------

export type ReplayOutcome = 'conditions-satisfied' | 'conditions-unsatisfied' | 'operational-failure' | 'canceled' | 'rejected'
export type ReplayActionStatus = 'executed' | 'failed' | 'not_executed'
export type ReplayConditionStatus = 'satisfied' | 'unsatisfied' | 'unevaluable' | 'not_evaluated'

export interface ReplayActionResult {
  readonly index: number
  readonly op: ReplayAction['op']
  readonly status: ReplayActionStatus
  readonly reason: string | null
}

export interface ReplayConditionResult {
  readonly index: number
  readonly kind: ExpectedCondition['kind']
  readonly status: ReplayConditionStatus
  readonly reason: string | null
}

export interface ReplayEvidenceReference {
  readonly observation_id: string
  readonly type: ObservationType
  readonly sha256: string
}

/**
 * One phase execution. Only host-observed state is reported: no page text, value or error message is
 * retained. `conditions-satisfied` needs every action, every required evidence type and every condition.
 */
export interface ReplayExecutionResult {
  readonly binding: ReplayPhaseBinding | null
  readonly outcome: ReplayOutcome
  readonly reason: string | null
  readonly actions: readonly ReplayActionResult[]
  readonly conditions: readonly ReplayConditionResult[]
  readonly task_condition: { readonly index: number; readonly status: ReplayConditionStatus } | null
  readonly evidence: readonly ReplayEvidenceReference[]
  readonly missing_evidence: readonly ObservationType[]
  /** The session was released (its browser context closed) exactly once. */
  readonly released: boolean
  /** Every driver call issued by this execution settled before the result was returned. */
  readonly joined: boolean
}

export interface ReplayExecutionOptions {
  readonly signal?: AbortSignal
  readonly clock?: LifecycleClock
}

type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
type Probe<T> = { readonly done: true; readonly value: T } | { readonly done: false; readonly reason: string; readonly final?: boolean }
/** An absolute monotonic deadline and the reason reported once it passes. */
interface Bound {
  readonly deadline: number
  readonly reason: string
}

const driverReason = (error: unknown): string => (error instanceof ReplayDriverError && REASON.test(error.code) ? error.code : 'REPLAY_ACTION_FAILED')

/** The first host-recorded unsupported event (popup, dialog, download), or null. */
function recordedViolation(driver: ReplayDriver): string | null {
  let violations: readonly string[]
  try {
    violations = driver.violations()
  } catch {
    return 'REPLAY_ACTION_FAILED'
  }
  if (violations.length === 0) return null
  return violations.find((code) => REASON.test(code)) ?? 'REPLAY_ACTION_FAILED'
}

function timed<T>(clock: LifecycleClock, promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = clock.setTimer(() => resolve(onTimeout), ms)
    promise.then(
      (value) => {
        clock.clearTimer(timer)
        resolve(value)
      },
      () => {
        clock.clearTimer(timer)
        resolve(onTimeout)
      },
    )
  })
}

/** Executes the host-frozen definition once in a fresh single-use phase session. */
export async function executeFrozenReplay(frozen: unknown, session: ReplaySession, options: ReplayExecutionOptions = {}): Promise<ReplayExecutionResult> {
  const state = sessions.get(session)
  const clock = options.clock ?? systemLifecycleClock
  const signal = options.signal ?? new AbortController().signal
  if (state === undefined || state.used) {
    return deepFreeze({
      binding: null,
      outcome: 'rejected',
      reason: state === undefined ? 'REPLAY_SESSION_UNKNOWN' : 'REPLAY_SESSION_REUSED',
      actions: [],
      conditions: [],
      task_condition: null,
      evidence: [],
      missing_evidence: [],
      released: false,
      joined: true,
    })
  }
  state.used = true

  const inflight = new Set<Promise<unknown>>()
  let body: Omit<ReplayExecutionResult, 'released' | 'joined'>
  try {
    body = await interpret(frozen, state, signal, clock, inflight)
  } catch {
    body = { binding: null, outcome: 'operational-failure', reason: 'REPLAY_INTERNAL_ERROR', actions: [], conditions: [], task_condition: null, evidence: [], missing_evidence: [] }
  }
  const released = await timed(
    clock,
    Promise.resolve().then(() => state.release()).then(() => true),
    CLEANUP_STEP_TIMEOUT_MS,
    false,
  )
  const joined = inflight.size === 0 || (await timed(clock, Promise.allSettled([...inflight]).then(() => true), EXECUTION_LIMITS.stop_grace_ms, false))
  // A cancellation requested at any point before the result is returned is sticky.
  const canceled = signal.aborted && body.outcome !== 'rejected'
  if (canceled) return deepFreeze({ ...body, outcome: 'canceled' as const, reason: 'REPLAY_CANCELED', released, joined })
  // A verdict survives only if no producer outlived it and nothing unsupported happened up to release.
  const verdict = body.outcome === 'conditions-satisfied' || body.outcome === 'conditions-unsatisfied'
  const late = verdict ? (joined ? recordedViolation(state.driver) : 'REPLAY_PRODUCER_NOT_JOINED') : null
  if (late !== null) return deepFreeze({ ...body, outcome: 'operational-failure' as const, reason: late, released, joined })
  return deepFreeze({ ...body, released, joined })
}

async function interpret(
  frozen: unknown,
  state: SessionState,
  signal: AbortSignal,
  clock: LifecycleClock,
  inflight: Set<Promise<unknown>>,
): Promise<Omit<ReplayExecutionResult, 'released' | 'joined'>> {
  const rejected = (reason: string, binding: ReplayPhaseBinding | null = null): Omit<ReplayExecutionResult, 'released' | 'joined'> => ({
    binding,
    outcome: 'rejected',
    reason,
    actions: [],
    conditions: [],
    task_condition: null,
    evidence: [],
    missing_evidence: [],
  })

  // Authority checks happen before any browser call.
  if (!isHostFrozenReplay(frozen)) return rejected('DEFINITION_NOT_HOST_FROZEN')
  if (!definitionIntact(frozen)) return rejected('DEFINITION_ALTERED')
  const definition = frozen.definition
  const parsedBinding = ReplayPhaseBindingSchema.safeParse(state.binding)
  if (!parsedBinding.success) return rejected('REPLAY_BINDING_INVALID')
  const binding = parsedBinding.data
  if (
    binding.run_id !== definition.run_id ||
    binding.definition_id !== definition.definition_id ||
    binding.definition_digest !== definition.definition_digest ||
    binding.target_origin !== frozen.identity.target_origin
  ) {
    return rejected('REPLAY_BINDING_MISMATCH', binding)
  }

  const { driver, collector } = state
  const origin = binding.target_origin
  const actions: ReplayActionResult[] = definition.replay.actions.map((action, index) => ({ index, op: action.op, status: 'not_executed', reason: null }))
  const conditions: ReplayConditionResult[] = definition.expected_conditions.map((condition, index) => ({ index, kind: condition.kind, status: 'not_evaluated', reason: null }))
  const finish = (outcome: ReplayOutcome, reason: string | null, evidence: ReplayEvidenceReference[] = [], missing: ObservationType[] = []) => ({
    binding,
    outcome,
    reason,
    actions,
    conditions,
    task_condition: { index: definition.task_condition_index, status: conditions[definition.task_condition_index]?.status ?? 'not_evaluated' },
    evidence,
    missing_evidence: missing,
  })
  if (signal.aborted) return finish('canceled', 'REPLAY_CANCELED')

  let viewport: { readonly width: number; readonly height: number } | null = null
  try {
    viewport = driver.viewport()
  } catch {
    viewport = null
  }
  if (viewport === null || viewport.width !== definition.replay.viewport.width || viewport.height !== definition.replay.viewport.height) {
    return { ...rejected('REPLAY_VIEWPORT_MISMATCH', binding), actions, conditions }
  }

  const phaseDeadline = clock.now() + EXECUTION_LIMITS.phase_timeout_ms

  /** A bound of `ms` from now, reported with `reason`; the fixed phase deadline always caps it. */
  const within = (ms: number, reason: string): Bound => {
    const own = clock.now() + ms
    return own < phaseDeadline ? { deadline: own, reason } : { deadline: phaseDeadline, reason: 'REPLAY_PHASE_TIMEOUT' }
  }

  /**
   * One driver call under `limit`. The primitive receives only the time left before the deadline;
   * the call settles at the deadline or on cancellation; and a result arriving after the deadline
   * (for example after a blocked event loop) is a timeout, never a success.
   */
  const call = <T>(limit: Bound, produce: (timeoutMs: number) => Promise<T>): Promise<Guarded<T>> => {
    if (signal.aborted) return Promise.resolve({ ok: false, reason: 'REPLAY_CANCELED' })
    const remaining = limit.deadline - clock.now()
    if (remaining <= 0) return Promise.resolve({ ok: false, reason: limit.reason })
    // Playwright treats a zero timeout as unlimited, so the smallest bound handed out is 1 ms.
    const timeoutMs = Math.max(1, Math.floor(remaining))
    let promise: Promise<T>
    try {
      promise = Promise.resolve(produce(timeoutMs))
    } catch (error) {
      return Promise.resolve({ ok: false, reason: clock.now() > limit.deadline ? limit.reason : driverReason(error) })
    }
    inflight.add(promise)
    const forget = (): void => {
      inflight.delete(promise)
    }
    promise.then(forget, forget)
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: Guarded<T>): void => {
        if (settled) return
        settled = true
        clock.clearTimer(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => settle({ ok: false, reason: 'REPLAY_CANCELED' })
      const late = (): boolean => clock.now() > limit.deadline
      const timer = clock.setTimer(() => settle({ ok: false, reason: limit.reason }), Math.max(0, limit.deadline - clock.now()))
      signal.addEventListener('abort', onAbort, { once: true })
      // A driver that aborted synchronously while starting the call is still canceled.
      if (signal.aborted) onAbort()
      promise.then(
        (value) => settle(late() ? { ok: false, reason: limit.reason } : { ok: true, value }),
        (error: unknown) => settle({ ok: false, reason: late() ? limit.reason : driverReason(error) }),
      )
    })
  }

  const delay = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(false)
      const onAbort = (): void => {
        clock.clearTimer(timer)
        resolve(false)
      }
      const timer = clock.setTimer(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })

  /**
   * Probes deterministic state immediately, then at the poll interval, under one bound shared by every
   * probe call. A probe that succeeds after the bound passed is not a success.
   */
  const poll = async <T>(limit: Bound, probe: (limit: Bound) => Promise<Probe<T>>): Promise<Guarded<T>> => {
    let unmet: string | null = null
    for (;;) {
      const result = await probe(limit)
      if (signal.aborted) return { ok: false, reason: 'REPLAY_CANCELED' }
      if (result.done) return clock.now() <= limit.deadline ? { ok: true, value: result.value } : { ok: false, reason: limit.reason }
      if (result.final === true) {
        // A probe cut off by this window's own deadline reports the state observed before it.
        const cutOff = result.reason === limit.reason && limit.reason !== 'REPLAY_PHASE_TIMEOUT'
        return { ok: false, reason: cutOff && unmet !== null ? unmet : result.reason }
      }
      unmet = result.reason
      // The last unmet state names the failure (not found, ambiguous, wait) unless the phase ended.
      const expired = { ok: false as const, reason: limit.reason === 'REPLAY_PHASE_TIMEOUT' ? limit.reason : result.reason }
      const left = limit.deadline - clock.now()
      if (left <= 0) return expired
      if (!(await delay(Math.min(REPLAY_POLL_INTERVAL_MS, left)))) return { ok: false, reason: 'REPLAY_CANCELED' }
      if (limit.deadline - clock.now() <= 0) return expired
    }
  }

  /** The current same-origin relative path, or null when the page left the target origin. */
  const targetPath = (): string | null => {
    try {
      const url = new URL(driver.currentUrl())
      return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null
    } catch {
      return null
    }
  }

  /** Checked after every step, condition and collection: a late popup/dialog/download or origin change fails closed. */
  const stillOnTarget = (): string | null => recordedViolation(driver) ?? (targetPath() === null ? 'NAVIGATION_LEFT_TARGET' : null)

  /** Waits (bounded) until the locator resolves to exactly one element. */
  const unique = (locator: Locator, limit: Bound): Promise<Guarded<true>> =>
    poll<true>(limit, async (bound) => {
      const counted = await call(bound, (timeout) => driver.count(locator, timeout))
      if (!counted.ok) return { done: false, reason: counted.reason, final: true }
      if (counted.value === 1) return { done: true, value: true }
      return { done: false, reason: counted.value === 0 ? 'LOCATOR_NOT_FOUND' : 'LOCATOR_AMBIGUOUS' }
    })

  const navigate = async (path: string, limit: Bound): Promise<string | null> => {
    let url: URL
    try {
      url = new URL(path, origin)
    } catch {
      return 'NAVIGATION_EXTERNAL'
    }
    if (url.origin !== origin) return 'NAVIGATION_EXTERNAL'
    const navigated = await call(limit, (timeout) => driver.navigate(url.href, timeout))
    if (!navigated.ok) return navigated.reason === 'REPLAY_ACTION_FAILED' ? 'NAVIGATION_FAILED' : navigated.reason
    const status = navigated.value.status
    if (status !== null && (status < 200 || status >= 400)) return 'NAVIGATION_HTTP_ERROR'
    return null
  }

  const probeWait = async (until: WaitAction['until'], limit: Bound): Promise<Probe<true>> => {
    if (until.kind === 'path') {
      const path = targetPath()
      if (path === null) return { done: false, reason: 'NAVIGATION_LEFT_TARGET', final: true }
      return path === until.path ? { done: true, value: true } : { done: false, reason: 'WAIT_TIMEOUT' }
    }
    const counted = await call(limit, (timeout) => driver.count(until.locator, timeout))
    if (!counted.ok) return { done: false, reason: counted.reason, final: true }
    if (counted.value !== 1) return { done: false, reason: counted.value === 0 ? 'WAIT_TIMEOUT' : 'LOCATOR_AMBIGUOUS' }
    if (until.kind === 'visible') {
      const visible = await call(limit, (timeout) => driver.isVisible(until.locator, timeout))
      if (!visible.ok) return { done: false, reason: visible.reason, final: true }
      return visible.value ? { done: true, value: true } : { done: false, reason: 'WAIT_TIMEOUT' }
    }
    const text = await call(limit, (timeout) => driver.text(until.locator, timeout))
    if (!text.ok) return { done: false, reason: text.reason, final: true }
    return text.value !== null && normalizeText(text.value) === normalizeText(until.text) ? { done: true, value: true } : { done: false, reason: 'WAIT_TIMEOUT' }
  }

  /** One action: a declared wait gets its own timeout; any other action shares one 10-second bound. */
  const perform = async (action: ReplayAction): Promise<string | null> => {
    if (action.op === 'wait') {
      const waited = await poll(within(action.timeout_ms, 'WAIT_TIMEOUT'), (limit) => probeWait(action.until, limit))
      return waited.ok ? null : waited.reason
    }
    const limit = within(PROJECT_LIMITS.maxWaitMs, 'REPLAY_ACTION_TIMEOUT')
    switch (action.op) {
      case 'navigate':
        return navigate(action.path, limit)
      case 'scroll': {
        const element = action.target.kind === 'element' ? action.target.locator : null
        if (element !== null) {
          const resolved = await unique(element, limit)
          if (!resolved.ok) return resolved.reason
        }
        const scrolled = await call(limit, (timeout) => driver.scroll(element, action.x, action.y, timeout))
        return scrolled.ok ? null : scrolled.reason
      }
      case 'click':
      case 'fill':
      case 'select': {
        const resolved = await unique(action.locator, limit)
        if (!resolved.ok) return resolved.reason
        if (action.op === 'click') {
          const clicked = await call(limit, (timeout) => driver.click(action.locator, timeout))
          return clicked.ok ? null : clicked.reason
        }
        const kind = await call(limit, (timeout) => driver.fieldKind(action.locator, timeout))
        if (!kind.ok) return kind.reason
        if (action.op === 'fill') {
          if (kind.value !== 'text') return 'FILL_TARGET_UNSUPPORTED'
          const filled = await call(limit, (timeout) => driver.fill(action.locator, action.value, timeout))
          return filled.ok ? null : filled.reason
        }
        if (kind.value !== 'select') return 'SELECT_TARGET_UNSUPPORTED'
        const selected = await call(limit, (timeout) => driver.select(action.locator, action.value, timeout))
        return selected.ok ? null : selected.reason
      }
    }
  }

  const collectionReason = (reason: string): string => (reason === 'REPLAY_CANCELED' || reason === 'REPLAY_PHASE_TIMEOUT' ? reason : 'EVIDENCE_COLLECTION_FAILED')

  const checkpoint = async (point: ReplayCheckpoint): Promise<string | null> => {
    const record = collector?.checkpoint
    if (collector === null || record === undefined) return null
    const done = await call(within(PROJECT_LIMITS.maxWaitMs, 'EVIDENCE_COLLECTION_FAILED'), () => record.call(collector, point))
    return done.ok ? null : collectionReason(done.reason)
  }

  const stopped = (reason: string): ReplayOutcome => (reason === 'REPLAY_CANCELED' ? 'canceled' : 'operational-failure')

  // Entry state, then every action in frozen order. Any failure stops further actions.
  const entry =
    (await navigate(definition.replay.entry_path, within(PROJECT_LIMITS.maxWaitMs, 'REPLAY_ACTION_TIMEOUT'))) ??
    stillOnTarget() ??
    (await checkpoint({ kind: 'start', action_index: null })) ??
    stillOnTarget()
  if (entry !== null) return finish(stopped(entry), entry)
  for (const [index, action] of definition.replay.actions.entries()) {
    const failure = (await perform(action)) ?? stillOnTarget() ?? (await checkpoint({ kind: 'action', action_index: index })) ?? stillOnTarget()
    actions[index] = { index, op: action.op, status: failure === null ? 'executed' : 'failed', reason: failure }
    if (failure !== null) return finish(stopped(failure), failure)
  }
  const ended = stillOnTarget() ?? (await checkpoint({ kind: 'end', action_index: null })) ?? stillOnTarget()
  if (ended !== null) return finish(stopped(ended), ended)

  // DOM/URL conditions on the final state, once each, each under its own bound: no implicit retry
  // turns a failure into a pass.
  const evaluate = async (condition: Exclude<ExpectedCondition, { kind: 'no-error' }>, limit: Bound): Promise<{ status: ReplayConditionStatus; reason: string | null }> => {
    const unevaluable = (reason: string) => ({ status: 'unevaluable' as const, reason })
    const verdict = (satisfied: boolean) => ({ status: satisfied ? ('satisfied' as const) : ('unsatisfied' as const), reason: null })
    if (condition.kind === 'path') {
      const path = targetPath()
      return path === null ? unevaluable('NAVIGATION_LEFT_TARGET') : verdict(path === condition.path)
    }
    const counted = await call(limit, (timeout) => driver.count(condition.locator, timeout))
    if (!counted.ok) return unevaluable(counted.reason)
    const count = counted.value
    if (condition.kind === 'element-count') return verdict(count === condition.count)
    if (count > 1) return unevaluable('LOCATOR_AMBIGUOUS')
    if (condition.kind === 'element-visible') {
      if (count === 0) return verdict(!condition.visible)
      const visible = await call(limit, (timeout) => driver.isVisible(condition.locator, timeout))
      return visible.ok ? verdict(visible.value === condition.visible) : unevaluable(visible.reason)
    }
    if (count === 0) return unevaluable('CONDITION_TARGET_MISSING')
    if (condition.kind === 'text') {
      const text = await call(limit, (timeout) => driver.text(condition.locator, timeout))
      if (!text.ok) return unevaluable(text.reason)
      if (text.value === null) return unevaluable('CONDITION_TARGET_UNSUPPORTED')
      return verdict(condition.match === 'exact' ? text.value === condition.text : normalizeText(text.value) === normalizeText(condition.text))
    }
    const kind = await call(limit, (timeout) => driver.fieldKind(condition.locator, timeout))
    if (!kind.ok) return unevaluable(kind.reason)
    if (kind.value === 'unsupported') return unevaluable('CONDITION_TARGET_UNSUPPORTED')
    const value = await call(limit, (timeout) => driver.value(condition.locator, timeout))
    return value.ok ? verdict(value.value === condition.value) : unevaluable(value.reason)
  }
  for (const [index, condition] of definition.expected_conditions.entries()) {
    if (condition.kind === 'no-error') continue
    const evaluated = await evaluate(condition, within(PROJECT_LIMITS.maxWaitMs, 'CONDITION_TIMEOUT'))
    if (evaluated.reason === 'REPLAY_CANCELED') return finish('canceled', 'REPLAY_CANCELED')
    conditions[index] = { index, kind: condition.kind, ...evaluated }
    const moved = stillOnTarget()
    if (moved !== null) return finish('operational-failure', moved)
  }

  // Run-bound evidence. Drain ends the observation window; wrong run/phase/baseline/build/viewport or
  // duplicate observations are rejected, never dropped.
  const drained: Guarded<readonly unknown[]> =
    collector === null ? { ok: true, value: [] } : await call(within(PROJECT_LIMITS.maxWaitMs, 'EVIDENCE_COLLECTION_FAILED'), () => collector.drain())
  if (!drained.ok) return finish(stopped(drained.reason), collectionReason(drained.reason))
  const afterDrain = stillOnTarget()
  if (afterDrain !== null) return finish('operational-failure', afterDrain)
  if (!Array.isArray(drained.value) || drained.value.length > PROJECT_LIMITS.maxObservations) return finish('operational-failure', 'EVIDENCE_BINDING_MISMATCH')
  const bound: SafeObservation[] = []
  const seen = new Set<string>()
  const { width, height } = definition.replay.viewport
  for (const item of drained.value) {
    const parsed = parseSafeObservation(item)
    if (!parsed.ok) return finish('operational-failure', 'EVIDENCE_BINDING_MISMATCH')
    const observation = parsed.value
    const image = observation.type === 'image' ? observation.payload : null
    const imageMismatch = image !== null && (image.build_sha256 !== binding.build_sha256 || image.viewport.width !== width || image.viewport.height !== height)
    if (
      seen.has(observation.observation_id) ||
      observation.run_id !== binding.run_id ||
      observation.phase !== binding.phase ||
      observation.baseline_commit !== definition.baseline_commit ||
      imageMismatch
    ) {
      return finish('operational-failure', 'EVIDENCE_BINDING_MISMATCH')
    }
    seen.add(observation.observation_id)
    bound.push(observation)
  }
  const evidence: ReplayEvidenceReference[] = bound
    .filter((observation) => observation.availability === 'available')
    .map((observation) => ({
      observation_id: observation.observation_id,
      type: observation.type,
      sha256: observation.type === 'image' && observation.payload !== null ? observation.payload.artifact.sha256 : projectDigest(observation),
    }))
  const collectorAvailable = (type: ObservationType): boolean => {
    let attested = false
    try {
      attested = collector?.available(type) === true
    } catch {
      attested = false
    }
    return attested && !bound.some((observation) => observation.type === type && observation.availability === 'unavailable')
  }
  const missing = definition.required_evidence.filter(
    (type) => !collectorAvailable(type) || (type === 'image' && !bound.some((observation) => observation.type === 'image' && observation.availability === 'available')),
  )

  for (const [index, condition] of definition.expected_conditions.entries()) {
    if (condition.kind !== 'no-error') continue
    if (!collectorAvailable(condition.error_type)) {
      conditions[index] = { index, kind: condition.kind, status: 'unevaluable', reason: 'COLLECTOR_UNAVAILABLE' }
      continue
    }
    const seen = bound.some(
      (observation) => observation.type !== 'image' && observation.type === condition.error_type && observation.availability === 'available' && observation.payload?.fingerprint === condition.fingerprint,
    )
    conditions[index] = { index, kind: condition.kind, status: seen ? 'unsatisfied' : 'satisfied', reason: null }
  }

  if (signal.aborted) return finish('canceled', 'REPLAY_CANCELED', evidence, missing)
  if (missing.length > 0) return finish('operational-failure', 'REQUIRED_EVIDENCE_UNAVAILABLE', evidence, missing)
  const unevaluable = conditions.find((condition) => condition.status !== 'satisfied' && condition.status !== 'unsatisfied')
  if (unevaluable !== undefined) return finish('operational-failure', unevaluable.reason ?? 'CONDITION_NOT_EVALUATED', evidence, missing)
  const satisfied = conditions.every((condition) => condition.status === 'satisfied')
  return finish(satisfied ? 'conditions-satisfied' : 'conditions-unsatisfied', null, evidence, missing)
}
