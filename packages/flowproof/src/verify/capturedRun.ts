import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { CapturedPhase } from '../capture/browserCapture.js'
import { parseEvidenceBundle, uuidSchema } from '../contracts/index.js'
import type { EvidenceBundle, EvidenceType, RunState } from '../contracts/index.js'
import { createCandidate, repositoryCoverage, validateCapturingSessionResult } from '../editing/capture.js'
import type { CandidateFile, CaptureCandidate, CaptureCoverage } from '../editing/capture.js'
import type { EvidenceIdAllocator } from '../evidence/ids.js'
import { createSecretScanner } from '../evidence/secretScan.js'
import type { SecretScanner } from '../evidence/secretScan.js'
import { ArtifactStoreError } from '../evidence/store.js'
import type { RunArtifactStore } from '../evidence/store.js'
import { compareSnapshots, readGit, snapshotRepository } from '../git/repositoryState.js'
import type { RepositorySnapshot } from '../git/repositoryState.js'
import type { LoadedScenario } from '../scenario/loadScenario.js'
import type { RunEventStream, StudioEventInput } from '../studio/events.js'
import { CANDIDATE_APPLICATION_FAILURES } from '../worktree/capturedCandidate.js'
import type { CandidateApplicationFailure } from '../worktree/capturedCandidate.js'
import { BUILD_ENVIRONMENT_KEYS, WorktreeError, createCapturedWorktreeSession, joinProcessGroup } from '../worktree/session.js'
import type { CapturedWorktreeSession } from '../worktree/session.js'
import {
  CAPTURED_CLEANUP_RESOURCES,
  CAPTURED_ORIGINAL_MISMATCHES,
  CAPTURED_RESULT_KIND,
  CAPTURED_SCHEMA_VERSION,
  CapturedContractError,
  capturedCheck,
  parseCapturedVerificationResult,
  reduceCapturedVerification,
} from './capturedContracts.js'
import type {
  CapturedCheck,
  CapturedCheckId,
  CapturedCheckReason,
  CapturedCleanupFacts,
  CapturedCleanupResource,
  CapturedEvidenceReference,
  CapturedOriginalMismatch,
  CapturedTermination,
  CapturedVerificationResult,
} from './capturedContracts.js'
import { evaluateOracles } from './oracle.js'

// Captured candidate verification (specs/004-verify-captured-changes, US1). Admission turns a
// completed Spec 003 capture result into an owned, frozen candidate snapshot before any
// asynchronous work; the prepared functional check reads its trusted checker and expected values
// from the original checkout before the candidate is applied and runs them in their own process
// group with the build's environment allowlist and bounded output. `executeCapturedRun` then runs
// the injected baseline, application, build, check, and replay ports in order, evaluates them with
// the existing oracles (not the legacy reducer), scans the whole run, always cleans up and compares
// the original repository, and persists the strict result. Every rejection or refusal is a fixed
// bounded code and message: never candidate bytes, paths, command output, or host paths.

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export type CapturedRunErrorCode =
  | 'RUN_OPTIONS_INVALID'
  | 'CANDIDATE_NOT_ADMITTED'
  | 'CHECK_UNAVAILABLE'
  | 'CHECK_INPUT_CHANGED'
  | 'CHECK_TARGET_INVALID'
  | 'CHECK_FAILED_TO_START'
  | 'CHECK_ABORTED'
  | 'CHECK_NOT_JOINED'
  | 'BASELINE_NOT_PREPARED'
  | 'RUN_ABORTED'

/** A refused captured-verification operation; the message never carries values or paths. */
export class CapturedRunError extends Error {
  readonly code: CapturedRunErrorCode

  constructor(code: CapturedRunErrorCode) {
    super(`${code}: the captured verification operation was refused.`)
    this.name = 'CapturedRunError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------
// Candidate admission (T014)
// ---------------------------------------------------------------------------------------

export type CapturedObjectFormat = 'sha1' | 'sha256'

/** The owned, frozen candidate snapshot that every later stage reads. */
export interface AdmittedCandidate {
  readonly editingSessionId: string
  /** The full recorded baseline commit, in the repository's object format. */
  readonly baselineCommit: string
  /** SHA-256 of the exact owned patch bytes. */
  readonly patchSha256: string
  /** The exact owned patch bytes; each read returns a fresh copy. */
  readonly patch: Buffer
  /** Raw file summaries; each path read returns a fresh copy. */
  readonly files: readonly CandidateFile[]
  readonly coverage: CaptureCoverage
}

/** Fixed launch errors for inputs that cannot start a verification run. */
export const CAPTURED_ADMISSION_ERRORS = {
  ADMISSION_OPTIONS_INVALID: 'The repository object format for candidate admission is invalid.',
  CAPTURE_RESULT_INVALID: 'The input is not a valid capturing editing-session result.',
  EDITOR_NOT_COMPLETED: 'The editing session did not complete, so there is no candidate to verify.',
  CANDIDATE_NOT_CAPTURED: 'The capture produced no complete candidate, so there is nothing to verify.',
  UPSTREAM_CLEANUP_INCOMPLETE: 'The editing session did not release every resource or keep the original repository unchanged.',
  BASELINE_FORMAT_MISMATCH: 'The candidate baseline does not match the repository object format.',
} as const
export type CapturedAdmissionErrorCode = keyof typeof CAPTURED_ADMISSION_ERRORS

export type CapturedAdmission =
  | { readonly admitted: true; readonly candidate: AdmittedCandidate }
  | { readonly admitted: false; readonly error: { readonly code: CapturedAdmissionErrorCode; readonly message: string } }

const ADMITTED = new WeakSet<object>()
const MAX_COPY_DEPTH = 8
const OBJECT_ID_LENGTH: Readonly<Record<CapturedObjectFormat, number>> = { sha1: 40, sha256: 64 }
/** The capture contract compares coverage by identity, so the fixed values survive the copy. */
const COVERAGES: readonly unknown[] = [repositoryCoverage(false), repositoryCoverage(true)]

/** True only for a snapshot this module admitted; a look-alike object is never a candidate. */
export const isAdmittedCandidate = (value: unknown): value is AdmittedCandidate => typeof value === 'object' && value !== null && ADMITTED.has(value)

/**
 * A detached plain copy that reads every caller field once: byte arrays are copied, arrays and
 * plain objects are rebuilt, and anything else is refused. Validation then runs on the copy, so
 * no getter or later caller mutation can change what was validated.
 */
function ownedCopy(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (COVERAGES.includes(value)) return value
  if (depth >= MAX_COPY_DEPTH) throw new CapturedRunError('CANDIDATE_NOT_ADMITTED')
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (Array.isArray(value)) return Array.from(value, (item: unknown) => ownedCopy(item, depth + 1))
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) throw new CapturedRunError('CANDIDATE_NOT_ADMITTED')
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value)) copy[key] = ownedCopy((value as Record<string, unknown>)[key], depth + 1)
  return copy
}

const rejected = (code: CapturedAdmissionErrorCode): CapturedAdmission =>
  Object.freeze({ admitted: false, error: Object.freeze({ code, message: CAPTURED_ADMISSION_ERRORS[code] }) })

function ownedCandidate(snapshot: CaptureCandidate): AdmittedCandidate {
  const patchSha256 = sha256(snapshot.patch)
  const target = {}
  Object.defineProperties(target, {
    editingSessionId: { enumerable: true, value: snapshot.sessionId },
    baselineCommit: { enumerable: true, value: snapshot.baselineCommit },
    patchSha256: { enumerable: true, value: patchSha256 },
    // The capture snapshot returns a fresh copy of its retained bytes on every read.
    patch: { enumerable: true, get: () => snapshot.patch },
    files: { enumerable: true, value: snapshot.files },
    coverage: { enumerable: true, value: snapshot.coverage },
  })
  const candidate = Object.freeze(target) as AdmittedCandidate
  ADMITTED.add(candidate)
  return candidate
}

/**
 * Admits only a completed editor whose capture is `captured` with complete upstream cleanup and
 * original integrity. The candidate is copied synchronously into an owned frozen snapshot, its
 * exact patch bytes are hashed, and its baseline ID must match the repository object format.
 * Every other input yields a fixed bounded error without creating a run or an artifact.
 */
export function admitCapturedCandidate(value: unknown, options: { readonly objectFormat: CapturedObjectFormat }): CapturedAdmission {
  const objectFormat = isRecord(options) ? options.objectFormat : undefined
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return rejected('ADMISSION_OPTIONS_INVALID')
  let copy: unknown
  try {
    copy = ownedCopy(value, 0)
  } catch {
    return rejected('CAPTURE_RESULT_INVALID')
  }
  const validated = validateCapturingSessionResult(copy)
  if (!validated.ok) return rejected('CAPTURE_RESULT_INVALID')
  const { session, capture } = validated.value
  if (session.executionOutcome !== 'completed') return rejected('EDITOR_NOT_COMPLETED')
  if (capture.status !== 'captured') return rejected('CANDIDATE_NOT_CAPTURED')
  const cleanup = session.cleanup
  const cleanupComplete =
    cleanup.status !== 'failed' && cleanup.containerRemoved && cleanup.workspaceRemoved && cleanup.originalRepositoryUnchanged && cleanup.remainingOwnedResources.length === 0
  if (!cleanupComplete) return rejected('UPSTREAM_CLEANUP_INCOMPLETE')
  let snapshot: CaptureCandidate
  try {
    snapshot = createCandidate(capture.candidate)
  } catch {
    return rejected('CAPTURE_RESULT_INVALID')
  }
  if (snapshot.baselineCommit.length !== OBJECT_ID_LENGTH[objectFormat]) return rejected('BASELINE_FORMAT_MISMATCH')
  return Object.freeze({ admitted: true, candidate: ownedCandidate(snapshot) })
}

// ---------------------------------------------------------------------------------------
// Trusted prepared functional check (T015)
// ---------------------------------------------------------------------------------------

export interface PreparedCheckSelection {
  /** The trusted checker, relative to the original checkout. */
  readonly checker: string
  /** The trusted cases and expected rows, relative to the original checkout. */
  readonly cases: string
  /** The candidate module the checker loads, relative to the owned candidate worktree. */
  readonly module: string
}

/**
 * Host-selected prepared checks, keyed by registered scenario. Never a submitted command, a
 * candidate package script, or the developer suite that asserts the baseline defect.
 */
export const PREPARED_FUNCTIONAL_CHECKS: Readonly<Record<string, PreparedCheckSelection>> = Object.freeze({
  'canvas-filter-hero': Object.freeze({
    checker: 'tests/fixtures/captured-verification/check-filter.mjs',
    cases: 'tests/fixtures/captured-verification/filter-cases.json',
    module: 'apps/demo-chart/src/filterData.ts',
  }),
})

export interface FunctionalCheckSummary {
  readonly discovered: number
  readonly executed: number
  readonly passed: number
  readonly failed: number
}

/** What one checker run reported; `summary` is null when its output was missing or malformed. */
export interface FunctionalCheckFact {
  readonly exitCode: number | null
  readonly summary: FunctionalCheckSummary | null
  /** The case count read from the trusted cases before application. */
  readonly expectedCases: number
}

export interface PreparedFunctionalCheck {
  readonly expectedCases: number
  /** Runs the trusted checker against the candidate module under `targetRoot`. */
  run(targetRoot: string, signal?: AbortSignal): Promise<FunctionalCheckFact>
}

const CHECK_NAME = 'prepared-region-filter'
const SUMMARY_KEYS = ['check', 'discovered', 'executed', 'passed', 'failed'] as const
const MAX_TRUSTED_INPUT_BYTES = 256 * 1024
const MAX_CHECK_OUTPUT_BYTES = 4 * 1024
const MAX_CASES = 1_000

/** Reads one trusted regular file whose canonical path is exactly `root/relative`, with no link. */
async function readTrustedFile(root: string, relative: string): Promise<Buffer> {
  const absolute = path.join(root, relative)
  try {
    if ((await realpath(absolute)) !== absolute) throw new Error('linked')
    const info = await lstat(absolute)
    if (!info.isFile() || info.size > MAX_TRUSTED_INPUT_BYTES) throw new Error('not a bounded file')
    const bytes = await readFile(absolute)
    if (bytes.length > MAX_TRUSTED_INPUT_BYTES) throw new Error('not a bounded file')
    return bytes
  } catch {
    throw new CapturedRunError('CHECK_UNAVAILABLE')
  }
}

/** The trusted case count; the cases themselves stay with the checker. */
function countCases(bytes: Buffer): number {
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new CapturedRunError('CHECK_UNAVAILABLE')
  }
  if (!isRecord(document)) throw new CapturedRunError('CHECK_UNAVAILABLE')
  const cases = document.cases
  const valid =
    Array.isArray(document.rows) &&
    Array.isArray(cases) &&
    cases.length > 0 &&
    cases.length <= MAX_CASES &&
    cases.every((entry: unknown) => isRecord(entry) && typeof entry.region === 'string' && Array.isArray(entry.expected))
  if (!valid) throw new CapturedRunError('CHECK_UNAVAILABLE')
  return (cases as unknown[]).length
}

/** Parses the checker's one fixed summary line; anything else is no summary. */
export function parseCheckSummary(stdout: Buffer): FunctionalCheckSummary | null {
  const text = stdout.toString('utf8')
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(0, -1)) as unknown
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== SUMMARY_KEYS.length || keys.some((key, index) => key !== SUMMARY_KEYS[index]) || value.check !== CHECK_NAME) return null
  return readSummary(value)
}

/** Consistent non-negative counts, or null; never a partial or contradictory summary. */
function readSummary(value: unknown): FunctionalCheckSummary | null {
  if (!isRecord(value)) return null
  const { discovered, executed, passed, failed } = value
  if (!isCount(discovered) || !isCount(executed) || !isCount(passed) || !isCount(failed)) return null
  if (executed > discovered || passed + failed !== executed) return null
  return Object.freeze({ discovered, executed, passed, failed })
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The process group already exited.
  }
}

/**
 * Selects the scenario's prepared check and reads its trusted checker and cases from the original
 * checkout now, before any candidate is applied. A later run refuses to execute when either file
 * changed since, and only the owned candidate module path is passed to the checker.
 */
export async function prepareFunctionalCheck(options: { readonly repoRoot: string; readonly scenario: LoadedScenario }): Promise<PreparedFunctionalCheck> {
  const scenarioId = options?.scenario?.scenario?.scenario_id
  if (typeof scenarioId !== 'string' || !Object.hasOwn(PREPARED_FUNCTIONAL_CHECKS, scenarioId)) throw new CapturedRunError('CHECK_UNAVAILABLE')
  const selection = PREPARED_FUNCTIONAL_CHECKS[scenarioId] as PreparedCheckSelection
  let root: string
  try {
    root = await realpath(options.repoRoot)
  } catch {
    throw new CapturedRunError('CHECK_UNAVAILABLE')
  }
  // The checker and the scenario oracle come from the same trusted original checkout.
  if (options.scenario.resolved.repoRoot !== root) throw new CapturedRunError('CHECK_UNAVAILABLE')
  const checkerPath = path.join(root, selection.checker)
  const checkerDigest = sha256(await readTrustedFile(root, selection.checker))
  const casesBytes = await readTrustedFile(root, selection.cases)
  const casesDigest = sha256(casesBytes)
  const expectedCases = countCases(casesBytes)
  const timeoutMs = options.scenario.scenario.timeouts.replay_ms

  const unchanged = async (): Promise<boolean> =>
    sha256(await readTrustedFile(root, selection.checker)) === checkerDigest && sha256(await readTrustedFile(root, selection.cases)) === casesDigest

  const notRun = (): FunctionalCheckFact => Object.freeze({ exitCode: null, summary: null, expectedCases })

  const execute = (cwd: string, modulePath: string, signal: AbortSignal | undefined): Promise<FunctionalCheckFact> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CapturedRunError('CHECK_ABORTED'))
        return
      }
      const env: NodeJS.ProcessEnv = { NO_COLOR: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
      for (const key of BUILD_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
      // Its own process group, with no shell and no inherited NODE_OPTIONS or loader.
      const child = spawn(process.execPath, [checkerPath, modulePath], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true, shell: false })
      const chunks: Buffer[] = []
      let size = 0
      let stopped: 'timeout' | 'aborted' | 'overflow' | null = null
      let settled = false
      const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
        stopped ??= reason
        killGroup(child.pid)
      }
      const timer = setTimeout(() => stop('timeout'), timeoutMs)
      const onAbort = (): void => stop('aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        outcome()
      }
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_CHECK_OUTPUT_BYTES) stop('overflow')
        else chunks.push(chunk)
      })
      child.once('error', () => {
        if (child.pid === undefined) settle(() => reject(new CapturedRunError('CHECK_FAILED_TO_START')))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const reason = stopped
        // The checker's exit does not prove its group gone: anything the checked module left in
        // it is killed and joined (no live member) before the check settles.
        void (child.pid === undefined ? Promise.resolve(true) : joinProcessGroup(child.pid)).then((joined) =>
          settle(() => {
            if (!joined) reject(new CapturedRunError('CHECK_NOT_JOINED'))
            else if (reason === 'aborted') reject(new CapturedRunError('CHECK_ABORTED'))
            else if (reason !== null) resolve(notRun())
            else resolve(Object.freeze({ exitCode: code, summary: parseCheckSummary(Buffer.concat(chunks)), expectedCases }))
          }),
        )
      })
    })

  return Object.freeze({
    expectedCases,
    async run(targetRoot: string, signal?: AbortSignal): Promise<FunctionalCheckFact> {
      if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot)) throw new CapturedRunError('CHECK_TARGET_INVALID')
      // Trusted inputs that changed after preparation are refused, never run.
      let same: boolean
      try {
        same = await unchanged()
      } catch {
        same = false
      }
      if (!same) throw new CapturedRunError('CHECK_INPUT_CHANGED')
      let target: string
      try {
        target = await realpath(targetRoot)
      } catch {
        throw new CapturedRunError('CHECK_TARGET_INVALID')
      }
      // The candidate module must be a regular file at its exact path inside the target.
      const modulePath = path.join(target, selection.module)
      try {
        if ((await realpath(modulePath)) !== modulePath || !(await lstat(modulePath)).isFile()) return notRun()
      } catch {
        return notRun()
      }
      return execute(target, modulePath, signal)
    },
  })
}

// ---------------------------------------------------------------------------------------
// Orchestration (T016)
// ---------------------------------------------------------------------------------------

/** What every stage port receives: this run, its store, and the owned candidate snapshot. */
export interface CapturedStageContext {
  readonly runId: string
  readonly scenario: LoadedScenario
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  readonly candidate: AdmittedCandidate
  /** Aborted on timeout or interruption; ports stop their owned work when it fires. */
  readonly signal: AbortSignal
  /**
   * The measured stages' readiness attestation. Reproduction and replay ports call it once, only
   * after the actual Studio frame was reconnected to their stage's build and its trusted probe
   * reported it ready; only then is the measured phase announced live. Building, serving, and
   * reconnecting stay preparation under the prior phase. It is bound to its own stage: inert in
   * unmeasured stages, on a second call, after the run was aborted, and once its stage settled.
   */
  readonly frameReady: () => void
}

export type CapturedApplicationFact = { readonly applied: true } | { readonly applied: false; readonly reason: CandidateApplicationFailure }
export type CapturedBuildFact = { readonly built: true } | { readonly built: false; readonly reason: 'BUILD_FAILED' | 'BUILD_OUTPUT_INVALID' }

/** Owned resources a disposal port could not release. */
export interface CapturedReleaseFact {
  readonly remaining: readonly CapturedCleanupResource[]
}

export interface CapturedWorktreeReleaseFact extends CapturedReleaseFact {
  /** Whether the original repository was compared with its pre-run snapshot, and the outcome. */
  readonly original: { readonly verified: boolean; readonly unchanged: boolean; readonly mismatches: readonly string[] }
}

/** Injected stages; US2 wires reproduction and replay to the actual Studio frame. */
export interface CapturedRunPorts {
  reproduceBaseline(context: CapturedStageContext): Promise<CapturedPhase>
  applyCandidate(context: CapturedStageContext): Promise<CapturedApplicationFact>
  build(context: CapturedStageContext): Promise<CapturedBuildFact>
  functionalCheck(context: CapturedStageContext): Promise<FunctionalCheckFact>
  replay(context: CapturedStageContext): Promise<CapturedPhase>
  /** Stops target serving and capture; always called, after every stage settled. */
  disposeCapture(): Promise<CapturedReleaseFact>
  /** Removes the owned worktree and private Git state and compares the original; always called. */
  disposeWorktree(): Promise<CapturedWorktreeReleaseFact>
}

const PORT_NAMES = ['reproduceBaseline', 'applyCandidate', 'build', 'functionalCheck', 'replay', 'disposeCapture', 'disposeWorktree'] as const

export interface ExecuteCapturedRunOptions {
  /** Server-assigned verification identities, distinct from the editing session ID. */
  readonly runId: string
  readonly requestId: string
  /** The trusted scenario loaded from the original checkout; its oracle is the expectation. */
  readonly scenario: LoadedScenario
  readonly candidate: AdmittedCandidate
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  readonly allocator: EvidenceIdAllocator
  readonly ports: CapturedRunPorts
  /** Seeded markers for the whole-run secret scan. */
  readonly secretMarkers: readonly string[]
  /** Existing close/process interruption; finalizes `interrupted` when it fires before the terminal boundary. */
  readonly signal?: AbortSignal
}

const RESULT_PATH = 'result.json'
const SCANNED_MANIFESTS = ['failure-manifest', 'replay-manifest'] as const

const PHASE_MESSAGES = {
  reproducing: 'The recorded baseline is live in the Studio frame; reproducing the prepared defect.',
  failure_captured: 'Captured the baseline failure evidence.',
  applying: 'Preparing the candidate: application, build, and functional check (not live).',
  replaying: 'The candidate build is live in the same Studio frame; replaying the prepared scenario.',
} as const satisfies Partial<Record<RunState, string>>

/** The measured phases, each announced only on its own stage's readiness attestation. */
type MeasuredPhase = 'reproducing' | 'replaying'

const ACTIVITY = {
  admitted: 'Admitted the captured candidate; verification starts at its recorded baseline.',
  loadBaseline: 'Building the recorded baseline and loading it into the Studio frame (not live yet).',
  loadCandidate: 'Loading the candidate build into the same Studio frame (not live yet).',
  apply: 'Applying the captured candidate once at its recorded baseline.',
  build: 'Running the registered application build for the applied candidate.',
  test: 'Running the trusted prepared functional check against the candidate module.',
  scan: 'Scanning the candidate, the evidence, and the run activity for secrets.',
  cleanup: 'Releasing the target, operations, and owned worktree, then comparing the original repository.',
} as const

const isPortFailureReason = (value: unknown): value is CandidateApplicationFailure => (CANDIDATE_APPLICATION_FAILURES as readonly unknown[]).includes(value)

function readRunOptions(options: ExecuteCapturedRunOptions): { readonly scanner: SecretScanner; readonly ports: CapturedRunPorts } {
  if (!isRecord(options)) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  const { runId, requestId, scenario, candidate, store, events, allocator, ports } = options
  if (!uuidSchema.safeParse(runId).success || !uuidSchema.safeParse(requestId).success) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  if (!isAdmittedCandidate(candidate)) throw new CapturedRunError('CANDIDATE_NOT_ADMITTED')
  // The verification run never reuses the editing session's identity.
  if (new Set([runId, requestId, candidate.editingSessionId]).size !== 3) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  if (!isRecord(store) || store.runId !== runId || !isRecord(events) || events.runId !== runId || events.closed || !isRecord(allocator) || allocator.runId !== runId) {
    throw new CapturedRunError('RUN_OPTIONS_INVALID')
  }
  const scenarioId = scenario?.scenario?.scenario_id
  if (typeof scenarioId !== 'string' || !Object.hasOwn(PREPARED_FUNCTIONAL_CHECKS, scenarioId)) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  if (!isRecord(ports) || PORT_NAMES.some((name) => typeof ports[name] !== 'function')) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  let scanner: SecretScanner
  try {
    scanner = createSecretScanner({ markers: options.secretMarkers })
  } catch {
    throw new CapturedRunError('RUN_OPTIONS_INVALID')
  }
  // Port functions are read once, so a caller cannot swap them mid-run.
  const bound = Object.fromEntries(PORT_NAMES.map((name) => [name, (ports[name] as (...args: never[]) => unknown).bind(ports)])) as unknown as CapturedRunPorts
  return { scanner, ports: Object.freeze(bound) }
}

type CheckedPhase =
  | { readonly complete: true; readonly bundle: EvidenceBundle; readonly reference: CapturedEvidenceReference; readonly observed: { readonly dataset: unknown; readonly chart: unknown } }
  | { readonly complete: false }

/**
 * A phase counts only when its bundle is contract-valid for this run, scenario, and phase, sits at
 * the fixed evidence paths, and its manifest, screenshot, and every item are persisted here.
 */
function checkPhase(captured: unknown, phase: 'failure' | 'replay', store: RunArtifactStore, runId: string, scenarioId: string): CheckedPhase {
  if (!isRecord(captured)) return { complete: false }
  const parsed = parseEvidenceBundle(captured.bundle)
  if (!parsed.ok) return { complete: false }
  const bundle = parsed.value
  const reference = { manifest_path: `evidence/${phase}/manifest.json`, screenshot_path: `evidence/${phase}/screenshot.png` } as const
  const complete =
    captured.phase === phase &&
    bundle.phase === phase &&
    bundle.run_id === runId &&
    bundle.scenario_id === scenarioId &&
    captured.manifestPath === reference.manifest_path &&
    captured.screenshotPath === reference.screenshot_path &&
    store.hasArtifact(reference.manifest_path) &&
    store.hasArtifact(reference.screenshot_path) &&
    bundle.items.find((item) => item.type === 'screenshot')?.artifact_path === reference.screenshot_path &&
    bundle.items.every((item) => store.hasEvidence(item.evidence_id) && store.hasArtifact(item.artifact_path))
  if (!complete) return { complete: false }
  const observed = isRecord(captured.observed) ? captured.observed : {}
  return { complete: true, bundle, reference: Object.freeze({ ...reference }), observed: { dataset: observed.dataset, chart: observed.chart } }
}

const idsOf = (bundle: EvidenceBundle, type: EvidenceType): string[] => bundle.items.filter((item) => item.type === type).map((item) => item.evidence_id)

const safeMetrics = (metrics: Readonly<Record<string, unknown>>): Record<string, number | boolean | null> =>
  Object.fromEntries(Object.entries(metrics).filter((entry): entry is [string, number | boolean | null] => entry[1] === null || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'))

/** The prepared defect reproduces when the actual baseline observation differs from the oracle. */
function baselineCheck(checked: CheckedPhase, scenario: LoadedScenario): CapturedCheck {
  if (!checked.complete) return capturedCheck('baseline_reproduced', 'BASELINE_EVIDENCE_INCOMPLETE')
  const evidence = { dataset: idsOf(checked.bundle, 'dataset'), chart: idsOf(checked.bundle, 'chart') }
  const oracles = evaluateOracles({ expected: scenario.oracle, observed: checked.observed, evidence })
  const statuses = [oracles.dataset_matches.status, oracles.canvas_matches.status]
  const evidenceIds = [...evidence.dataset, ...evidence.chart]
  if (statuses.includes('unevaluable')) return capturedCheck('baseline_reproduced', 'BASELINE_OBSERVATION_INVALID', { evidence_ids: evidenceIds })
  if (statuses.every((status) => status === 'pass')) return capturedCheck('baseline_reproduced', 'BASELINE_NOT_REPRODUCED', { evidence_ids: evidenceIds })
  return capturedCheck('baseline_reproduced', 'BASELINE_REPRODUCED', {
    evidence_ids: evidenceIds,
    metrics: { dataset_differs: statuses[0] === 'fail', canvas_differs: statuses[1] === 'fail' },
  })
}

/** The existing replay oracles on the actual replay observation, never a legacy gate. */
function replayChecks(checked: CheckedPhase, scenario: LoadedScenario): readonly [CapturedCheck, CapturedCheck] {
  if (!checked.complete) return [capturedCheck('dataset_matches', 'REPLAY_EVIDENCE_INCOMPLETE'), capturedCheck('canvas_matches', 'REPLAY_EVIDENCE_INCOMPLETE')]
  const evidence = { dataset: idsOf(checked.bundle, 'dataset'), chart: idsOf(checked.bundle, 'chart') }
  const oracles = evaluateOracles({ expected: scenario.oracle, observed: checked.observed, evidence })
  return [
    capturedCheck('dataset_matches', oracles.dataset_matches.reason_code as CapturedCheckReason, { evidence_ids: oracles.dataset_matches.evidence_ids, metrics: safeMetrics(oracles.dataset_matches.metrics) }),
    capturedCheck('canvas_matches', oracles.canvas_matches.reason_code as CapturedCheckReason, { evidence_ids: oracles.canvas_matches.evidence_ids, metrics: safeMetrics(oracles.canvas_matches.metrics) }),
  ]
}

function applicationCheck(fact: unknown): CapturedCheck {
  if (isRecord(fact) && fact.applied === true) return capturedCheck('application_complete', 'APPLICATION_COMPLETE')
  if (isRecord(fact) && fact.applied === false && isPortFailureReason(fact.reason)) return capturedCheck('application_complete', fact.reason)
  throw new CapturedRunError('RUN_OPTIONS_INVALID')
}

function buildCheck(fact: unknown): CapturedCheck {
  if (isRecord(fact) && fact.built === true) return capturedCheck('build_passed', 'BUILD_PASSED')
  if (isRecord(fact) && fact.built === false && (fact.reason === 'BUILD_FAILED' || fact.reason === 'BUILD_OUTPUT_INVALID')) return capturedCheck('build_passed', fact.reason)
  throw new CapturedRunError('RUN_OPTIONS_INVALID')
}

/**
 * The trusted checker passes only when it exited zero and executed and passed exactly the trusted
 * case count. Zero executed cases, a missing or malformed summary, or any mismatch cannot pass.
 */
function testsCheck(fact: unknown): CapturedCheck {
  if (!isRecord(fact) || !isCount(fact.expectedCases) || fact.expectedCases === 0) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  const exitCode = fact.exitCode
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  const expected = fact.expectedCases
  const summary = fact.summary === null ? null : readSummary(fact.summary)
  const base = { expected_cases: expected, exit_code: exitCode as number | null }
  if (summary === null) return capturedCheck('tests_passed', 'TESTS_FAILED', { metrics: base })
  const metrics = { ...summary, ...base }
  if (summary.executed === 0) return capturedCheck('tests_passed', 'TESTS_NOT_EXECUTED', { metrics })
  const passed = exitCode === 0 && summary.discovered === expected && summary.executed === expected && summary.passed === expected && summary.failed === 0
  return capturedCheck('tests_passed', passed ? 'TESTS_PASSED' : 'TESTS_FAILED', { metrics })
}

/** Valid UTF-8 without NUL is scanned as text; other bytes for seeded markers only. */
function rawSurface(bytes: Buffer): string | Buffer {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? bytes : text
  } catch {
    return bytes
  }
}

const decodeArtifact = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return bytes
  }
}

function releaseOf(fact: unknown, fallback: readonly CapturedCleanupResource[]): CapturedCleanupResource[] {
  if (!isRecord(fact) || !Array.isArray(fact.remaining)) return [...fallback]
  const remaining = fact.remaining as unknown[]
  // An unknown category is still an unreleased resource, reported under the port's own categories.
  if (remaining.some((item) => !(CAPTURED_CLEANUP_RESOURCES as readonly unknown[]).includes(item))) return [...fallback]
  return remaining as CapturedCleanupResource[]
}

function originalOf(fact: unknown): { readonly unchanged: boolean; readonly mismatches: readonly CapturedOriginalMismatch[] } {
  const original = isRecord(fact) && isRecord(fact.original) ? fact.original : null
  if (original === null || original.verified !== true || !Array.isArray(original.mismatches)) return { unchanged: false, mismatches: ['snapshot'] }
  const known = (original.mismatches as unknown[]).filter((item): item is CapturedOriginalMismatch => (CAPTURED_ORIGINAL_MISMATCHES as readonly unknown[]).includes(item))
  const unknown = known.length !== original.mismatches.length
  if (original.unchanged === true && original.mismatches.length === 0) return { unchanged: true, mismatches: [] }
  const mismatches = new Set<CapturedOriginalMismatch>(known)
  if (unknown || mismatches.size === 0) mismatches.add('snapshot')
  return { unchanged: false, mismatches: CAPTURED_ORIGINAL_MISMATCHES.filter((item) => mismatches.has(item)) }
}

const elapsedMs = (mark: number): number => Math.max(0, Math.round(performance.now() - mark))

/**
 * Executes one captured verification: baseline reproduction, exact application, registered build,
 * trusted functional check, same-frame replay, whole-run scan, cleanup, and original integrity, in
 * that order. The first failing mandatory check stops execution; later checks are unevaluable.
 * Scan, cleanup, and integrity run on every exit. The strict result is persisted as the existing
 * `result` artifact and returned exactly as persisted; no patch bytes or raw paths are persisted.
 *
 * Time: the scenario's total window covers the whole run, finalization included, and one shared
 * `replay_ms` window covers application, build, functional check, and replay together. Abort timers
 * stop a running stage, and elapsed monotonic time (`performance.now()`) is checked as well, at
 * every stage boundary, before a stage's output is accepted, on readiness, on interruption, and at
 * the terminal boundary, so a starved timer never lets a late stage or run pass. The first of
 * timeout and interruption to happen decides the outcome; every stage is joined before cleanup.
 * Interruption is tracked until the terminal boundary, so a close during scan or cleanup still
 * finalizes the run as interrupted once cleanup completed.
 */
export async function executeCapturedRun(options: ExecuteCapturedRunOptions): Promise<CapturedVerificationResult> {
  const { scanner, ports } = readRunOptions(options)
  const { runId, requestId, scenario, candidate, store, events, allocator } = options
  const scenarioId = scenario.scenario.scenario_id
  const { total_ms: totalMs, replay_ms: windowMs } = scenario.scenario.timeouts
  const startedAt = new Date()
  const runMark = performance.now()
  const totalEnd = runMark + totalMs
  const durations = { reproduce: 0, apply: 0, build: 0, test: 0, replay: 0, finalize: 0 }

  const controller = new AbortController()
  let stopReason: 'timeout' | 'interrupted' | null = null
  const abort = (reason: 'timeout' | 'interrupted'): void => {
    stopReason ??= reason
    controller.abort()
  }
  /** The end of the shared application/build/check/replay window while it is open. */
  let windowEnd: number | null = null
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  const deadlinePassed = (): boolean => {
    const now = performance.now()
    return now >= totalEnd || (windowEnd !== null && now >= windowEnd)
  }
  /** Elapsed time decides even when no timer fired. */
  const checkDeadline = (): void => {
    if (!controller.signal.aborted && deadlinePassed()) abort('timeout')
  }
  // A close after a deadline already passed is reported as the timeout it followed.
  const onInterrupt = (): void => {
    checkDeadline()
    abort('interrupted')
  }
  if (options.signal?.aborted) abort('interrupted')
  else options.signal?.addEventListener('abort', onInterrupt, { once: true })
  const runTimer = setTimeout(() => abort('timeout'), totalMs)
  const openWindow = (): void => {
    windowEnd = performance.now() + windowMs
    windowTimer = setTimeout(() => abort('timeout'), windowMs)
  }

  const checks = new Map<CapturedCheckId, CapturedCheck>()
  const record = (check: CapturedCheck): void => {
    checks.set(check.check_id, check)
  }
  let termination: CapturedTermination = 'completed'
  let before: CapturedEvidenceReference | null = null
  let after: CapturedEvidenceReference | null = null
  let phase: RunState = 'initialized'

  const emit = (input: Omit<StudioEventInput, 'phase'>): void => {
    try {
      events.emit({ ...input, phase })
    } catch {
      // Activity is advisory: a rejected event never changes the authoritative result.
    }
  }
  const enter = (next: keyof typeof PHASE_MESSAGES): void => {
    phase = next
    emit({ type: 'phase_started', message: PHASE_MESSAGES[next] })
  }
  const announce = (bundle: EvidenceBundle, manifestPath: string): void =>
    emit({
      type: 'evidence_added',
      message: `Captured ${bundle.items.length} sanitized ${bundle.phase} evidence items.`,
      evidence_ids: bundle.items.map((item) => item.evidence_id),
      artifact_refs: [manifestPath],
    })

  /**
   * A fresh context per stage. Only a measured stage's attestation can announce its phase, once,
   * while that stage is running and the run was not aborted; `settle` makes it inert afterwards.
   */
  const stageContext = (measured: MeasuredPhase | null): { readonly context: CapturedStageContext; readonly settle: () => void } => {
    let open = measured !== null
    const frameReady = (): void => {
      if (!open || measured === null) return
      // A late attestation never announces a live phase.
      checkDeadline()
      if (controller.signal.aborted) return
      open = false
      enter(measured)
    }
    const context: CapturedStageContext = Object.freeze({ runId, scenario, store, allocator, candidate, signal: controller.signal, frameReady })
    return { context, settle: () => (open = false) }
  }

  const stopped = (ids: readonly CapturedCheckId[]): null => {
    termination = stopReason === 'timeout' ? 'timeout' : 'interrupted'
    for (const id of ids) record(capturedCheck(id, stopReason === 'timeout' ? 'RUN_TIMEOUT' : 'RUN_INTERRUPTED'))
    return null
  }

  /**
   * Runs one stage and returns its evaluated checks, or null when it did not finish: a timeout or
   * interruption marks its checks with that reason, and an operational failure marks them
   * `STAGE_ERROR` and finalizes the run as `error`. The stage is always joined before returning.
   */
  const stage = async <T>(
    ids: readonly CapturedCheckId[],
    key: keyof typeof durations,
    run: (context: CapturedStageContext) => Promise<T>,
    measured: MeasuredPhase | null = null,
  ): Promise<T | null> => {
    checkDeadline()
    if (controller.signal.aborted) return stopped(ids)
    const mark = performance.now()
    const { context, settle } = stageContext(measured)
    try {
      const value = await run(context)
      // An output that arrived after a deadline is never accepted.
      checkDeadline()
      return controller.signal.aborted ? stopped(ids) : value
    } catch {
      checkDeadline()
      if (controller.signal.aborted) return stopped(ids)
      termination = 'error'
      for (const id of ids) record(capturedCheck(id, 'STAGE_ERROR'))
      return null
    } finally {
      settle()
      durations[key] += elapsedMs(mark)
    }
  }

  const passes = (...ids: CapturedCheckId[]): boolean => ids.every((id) => checks.get(id)?.status === 'pass')

  record(capturedCheck('input_valid', 'INPUT_ADMITTED'))
  emit({ type: 'agent_message', message: ACTIVITY.admitted })
  try {
    // The baseline is built, served, and reconnected first; it is live only once its port attests it.
    emit({ type: 'agent_message', message: ACTIVITY.loadBaseline })
    const baseline = await stage(
      ['baseline_reproduced'],
      'reproduce',
      async (context) => {
        const checked = checkPhase(await ports.reproduceBaseline(context), 'failure', store, runId, scenarioId)
        return { checked, check: baselineCheck(checked, scenario) }
      },
      'reproducing',
    )
    if (baseline !== null) {
      record(baseline.check)
      if (baseline.checked.complete) {
        before = baseline.checked.reference
        announce(baseline.checked.bundle, baseline.checked.reference.manifest_path)
      }
    }
    if (passes('baseline_reproduced')) {
      enter('failure_captured')
      enter('applying')
      // One shared window for application, build, functional check, and replay.
      openWindow()
      emit({ type: 'agent_message', message: ACTIVITY.apply })
      const applied = await stage(['application_complete'], 'apply', async (context) => applicationCheck(await ports.applyCandidate(context)))
      if (applied !== null) record(applied)
    }
    if (passes('application_complete')) {
      emit({ type: 'agent_message', message: ACTIVITY.build })
      const built = await stage(['build_passed'], 'build', async (context) => buildCheck(await ports.build(context)))
      if (built !== null) record(built)
    }
    if (passes('build_passed')) {
      emit({ type: 'agent_message', message: ACTIVITY.test })
      const tested = await stage(['tests_passed'], 'test', async (context) => testsCheck(await ports.functionalCheck(context)))
      if (tested !== null) record(tested)
    }
    if (passes('tests_passed')) {
      // Still preparation: the candidate build is served and reconnected before its port attests it.
      emit({ type: 'agent_message', message: ACTIVITY.loadCandidate })
      const replayed = await stage(
        ['dataset_matches', 'canvas_matches'],
        'replay',
        async (context) => {
          const checked = checkPhase(await ports.replay(context), 'replay', store, runId, scenarioId)
          return { checked, checks: replayChecks(checked, scenario) }
        },
        'replaying',
      )
      if (replayed !== null) {
        for (const check of replayed.checks) record(check)
        if (replayed.checked.complete) {
          after = replayed.checked.reference
          announce(replayed.checked.bundle, replayed.checked.reference.manifest_path)
        }
      }
    }
  } catch {
    // An engine-side failure outside a stage stops the run; unreached checks stay unevaluable.
    termination = 'error'
  } finally {
    // Every stage settled. Finalization still counts toward the total window, and an interruption
    // during it still counts too; both are decided at the terminal boundary below.
    clearTimeout(runTimer)
    clearTimeout(windowTimer)
    windowEnd = null
  }

  // Whole-run scan of the raw candidate, every persisted evidence artifact, and the activity so far.
  const finalizeMark = performance.now()
  emit({ type: 'agent_message', message: ACTIVITY.scan })
  let scanIncomplete = false
  let findings = 0
  let scannedArtifacts = 0
  try {
    findings += scanner.scan('candidate', { patch: rawSurface(candidate.patch), paths: candidate.files.map((file) => rawSurface(file.path)) }).findings.length
    const artifacts: Record<string, unknown> = {}
    for (const id of [...new Set(allocator.issued())].filter((issued) => store.hasEvidence(issued)).concat(SCANNED_MANIFESTS)) {
      try {
        artifacts[id] = decodeArtifact(await store.read(id))
      } catch (error) {
        // A manifest of a phase the run never reached is absent; any other failure is incomplete.
        if (error instanceof ArtifactStoreError && error.code === 'ARTIFACT_UNKNOWN_ID') continue
        scanIncomplete = true
      }
    }
    scannedArtifacts = Object.keys(artifacts).length
    findings += scanner.scanRun({ artifacts, events: events.events(), provider_request: null, result: null }).findings.length
  } catch {
    scanIncomplete = true
  }

  // Cleanup and integrity always run, after every stage was joined.
  emit({ type: 'agent_message', message: ACTIVITY.cleanup })
  const remaining = new Set<CapturedCleanupResource>()
  try {
    for (const item of releaseOf(await ports.disposeCapture(), ['target_runtime', 'browser_capture'])) remaining.add(item)
  } catch {
    remaining.add('target_runtime')
    remaining.add('browser_capture')
  }
  let original: ReturnType<typeof originalOf> = { unchanged: false, mismatches: ['snapshot'] }
  try {
    const released = await ports.disposeWorktree()
    for (const item of releaseOf(released, ['worktree', 'private_git_state'])) remaining.add(item)
    original = originalOf(released)
  } catch {
    remaining.add('worktree')
    remaining.add('private_git_state')
  }
  const cleanup: CapturedCleanupFacts = {
    complete: remaining.size === 0,
    remaining_owned_resources: CAPTURED_CLEANUP_RESOURCES.filter((item) => remaining.has(item)),
    original_unchanged: original.unchanged,
    original_mismatches: [...original.mismatches],
  }

  const resultWith = (secretScan: CapturedCheck | null, completedAt: Date): CapturedVerificationResult => {
    const reduction = reduceCapturedVerification({
      checks: [...checks.values(), ...(secretScan === null ? [] : [secretScan])],
      termination,
      before_evidence: before,
      after_evidence: after,
      cleanup,
    })
    return {
      kind: CAPTURED_RESULT_KIND,
      schema_version: CAPTURED_SCHEMA_VERSION,
      run_id: runId,
      request_id: requestId,
      scenario_id: scenarioId,
      editing_session_id: candidate.editingSessionId,
      baseline_commit: candidate.baselineCommit,
      candidate_patch_sha256: candidate.patchSha256,
      coverage: { scope: candidate.coverage.scope, note: candidate.coverage.note },
      status: reduction.status,
      reason_code: reduction.reason_code,
      message: reduction.message,
      checks: [...reduction.checks],
      // The fixed phase paths; the strict parse below rejects anything else.
      before_evidence: before === null ? null : ({ ...before } as CapturedVerificationResult['before_evidence']),
      after_evidence: after === null ? null : ({ ...after } as CapturedVerificationResult['after_evidence']),
      cleanup: { ...cleanup, remaining_owned_resources: [...cleanup.remaining_owned_resources], original_mismatches: [...cleanup.original_mismatches] },
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      total_duration_ms: elapsedMs(runMark),
      phase_durations_ms: { ...durations },
    }
  }

  /**
   * The terminal boundary: a run that otherwise completed but was interrupted or crossed its total
   * window, scan and cleanup included, finalizes with whichever of the two happened first. An
   * earlier error, timeout, or interruption keeps its own reason.
   */
  const stoppedBeforeTerminal = (): boolean => {
    if (termination !== 'completed') return false
    checkDeadline()
    if (stopReason === null) return false
    termination = stopReason
    return true
  }
  // The final result is scanned too, together with the complete activity, before it is persisted;
  // it is scanned again when the terminal boundary changed its outcome meanwhile.
  const scanFinal = (): number => {
    try {
      return scanner.scanRun({ artifacts: {}, events: events.events(), provider_request: null, result: resultWith(null, new Date()) }).findings.length
    } catch {
      scanIncomplete = true
      return 0
    }
  }
  stoppedBeforeTerminal()
  let finalFindings = scanFinal()
  if (stoppedBeforeTerminal()) finalFindings = scanFinal()
  // The outcome is decided; a later close cannot change what is persisted and returned.
  options.signal?.removeEventListener('abort', onInterrupt)
  findings += finalFindings
  const secretScan = scanIncomplete
    ? capturedCheck('secret_scan_clean', 'SECRET_SCAN_INCOMPLETE')
    : capturedCheck('secret_scan_clean', findings === 0 ? 'SECRET_SCAN_CLEAN' : 'SECRET_SCAN_FINDINGS', { metrics: { artifacts: scannedArtifacts, findings } })
  durations.finalize = elapsedMs(finalizeMark)
  const result = resultWith(secretScan, new Date())
  if (!parseCapturedVerificationResult(result).ok) throw new CapturedContractError('result')
  store.register('result', await store.writeJson(RESULT_PATH, result))
  // The authoritative result is exactly what was persisted.
  const persisted = parseCapturedVerificationResult(JSON.parse((await store.read('result')).toString('utf8')) as unknown)
  if (!persisted.ok) throw new CapturedContractError('result')
  phase = 'finalized'
  emit({ type: 'run_finalized', message: `Run finalized as ${persisted.value.status}.`, artifact_refs: [RESULT_PATH] })
  return persisted.value
}

// ---------------------------------------------------------------------------------------
// Prepared non-browser ports (T015/T016)
// ---------------------------------------------------------------------------------------

/** The built, unchanged recorded baseline that the Studio serves and captures before application. */
export interface PreparedBaseline {
  /** The built document root of the unchanged baseline inside the owned pinned worktree. */
  readonly documentRoot: string
  /** The owned pinned worktree at the recorded baseline: the trusted source root for its evidence. */
  readonly sourceRoot: string
}

/** The prepared application, build, check, and worktree disposal ports for one candidate. */
export interface PreparedCandidatePorts {
  /**
   * Creates the owned pinned worktree at the candidate's recorded baseline and builds it before
   * anything is applied. Application, the candidate build, and the check then reuse that session.
   * At most once, and only before application.
   */
  prepareBaseline(context: CapturedStageContext): Promise<PreparedBaseline>
  applyCandidate(context: CapturedStageContext): Promise<CapturedApplicationFact>
  build(context: CapturedStageContext): Promise<CapturedBuildFact>
  functionalCheck(context: CapturedStageContext): Promise<FunctionalCheckFact>
  disposeWorktree(): Promise<CapturedWorktreeReleaseFact>
  /** The owned worktree once application started; for acceptance inspection only. */
  worktreePath(): string | null
  /** The built document root after a successful build. */
  documentRoot(): string | null
}

/**
 * Prepares the trusted functional check and an independent original-repository snapshot before
 * anything is applied. The one owned pinned worktree at the candidate baseline is created either by
 * `prepareBaseline` (which also builds the unchanged baseline for reproduction) or, without a
 * reproduced baseline, on application; every later stage reuses that same session. Disposal joins
 * every owned operation, removes the worktree and private Git state, and compares the original
 * repository on every exit, including when no worktree was ever created.
 */
export async function createPreparedCandidatePorts(options: {
  readonly repoRoot: string
  readonly scenario: LoadedScenario
  readonly candidate: AdmittedCandidate
}): Promise<PreparedCandidatePorts> {
  const { scenario, candidate } = options
  if (!isAdmittedCandidate(candidate)) throw new CapturedRunError('CANDIDATE_NOT_ADMITTED')
  const check = await prepareFunctionalCheck({ repoRoot: options.repoRoot, scenario })
  let root: string
  let gitCommonDir: string
  let baseline: RepositorySnapshot
  try {
    root = await realpath((await readGit(await realpath(options.repoRoot), ['rev-parse', '--show-toplevel'])).trim())
    gitCommonDir = await realpath((await readGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    baseline = await snapshotRepository(root, gitCommonDir)
  } catch {
    throw new CapturedRunError('CHECK_UNAVAILABLE')
  }

  let creating: Promise<CapturedWorktreeSession | null> | null = null
  let creationFailure: unknown = null
  let session: CapturedWorktreeSession | null = null
  /** The baseline preparation: absent, started, or completed with its built document root. */
  let baselineState: 'none' | 'started' | 'prepared' = 'none'
  let applicationStarted = false
  let applied = false
  let documentRoot: string | null = null
  let disposal: Promise<CapturedWorktreeReleaseFact> | null = null
  const checkController = new AbortController()
  let activeCheck: Promise<unknown> | null = null
  /** A check process group outlived its bounded join; disposal reports it as a remaining operation. */
  let checkUnjoined = false

  const bound = (context: CapturedStageContext): void => {
    if (!isRecord(context) || context.candidate !== candidate) throw new CapturedRunError('CANDIDATE_NOT_ADMITTED')
    if (disposal !== null) throw new CapturedRunError('RUN_OPTIONS_INVALID')
  }

  /**
   * Creates the one owned pinned session; a second creation is never attempted, and nothing is
   * created for a run that was already aborted.
   */
  const open = (signal: AbortSignal): Promise<CapturedWorktreeSession | null> => {
    if (signal.aborted && creating === null) return Promise.reject(new CapturedRunError('RUN_ABORTED'))
    creating ??= createCapturedWorktreeSession({ repoRoot: root, scenario, baselineCommit: candidate.baselineCommit, signal }).then(
      (created) => created,
      (error: unknown) => {
        creationFailure = error
        return null
      },
    )
    return creating
  }

  return Object.freeze({
    async prepareBaseline(context: CapturedStageContext): Promise<PreparedBaseline> {
      bound(context)
      if (baselineState !== 'none' || creating !== null) throw new CapturedRunError('RUN_OPTIONS_INVALID')
      baselineState = 'started'
      session = await open(context.signal)
      if (session === null) throw new CapturedRunError('BASELINE_NOT_PREPARED')
      const { documentRoot } = await session.buildBaseline({ signal: context.signal })
      baselineState = 'prepared'
      return Object.freeze({ documentRoot, sourceRoot: session.path })
    },

    async applyCandidate(context: CapturedStageContext): Promise<CapturedApplicationFact> {
      bound(context)
      // Applied at most once, and only onto a completely prepared baseline when one was started.
      if (applicationStarted || baselineState === 'started') throw new CapturedRunError('RUN_OPTIONS_INVALID')
      applicationStarted = true
      session = await open(context.signal)
      if (session === null) {
        if (creationFailure instanceof WorktreeError && creationFailure.code === 'WORKTREE_BASELINE_UNAVAILABLE') return { applied: false, reason: 'BASELINE_UNAVAILABLE' }
        throw new CapturedRunError('RUN_OPTIONS_INVALID')
      }
      const outcome = await session.applyCandidate(candidate, { signal: context.signal })
      applied = outcome.applied
      return outcome.applied ? { applied: true } : { applied: false, reason: outcome.reason }
    },

    async build(context: CapturedStageContext): Promise<CapturedBuildFact> {
      bound(context)
      if (session === null || !applied) throw new CapturedRunError('RUN_OPTIONS_INVALID')
      try {
        documentRoot = (await session.build({ signal: context.signal })).documentRoot
        return { built: true }
      } catch (error) {
        if (error instanceof WorktreeError && error.code === 'WORKTREE_BUILD_FAILED') return { built: false, reason: 'BUILD_FAILED' }
        if (error instanceof WorktreeError && error.code === 'WORKTREE_BUILD_OUTPUT_INVALID') return { built: false, reason: 'BUILD_OUTPUT_INVALID' }
        throw error
      }
    },

    async functionalCheck(context: CapturedStageContext): Promise<FunctionalCheckFact> {
      bound(context)
      if (session === null || documentRoot === null) throw new CapturedRunError('RUN_OPTIONS_INVALID')
      const running = check.run(session.path, AbortSignal.any([context.signal, checkController.signal]))
      activeCheck = running
      try {
        return await running
      } catch (error) {
        if (error instanceof CapturedRunError && error.code === 'CHECK_NOT_JOINED') checkUnjoined = true
        throw error
      } finally {
        activeCheck = null
      }
    },

    disposeWorktree(): Promise<CapturedWorktreeReleaseFact> {
      disposal ??= (async () => {
        // Stop and join the owned check and any worktree creation before removing their files.
        checkController.abort()
        await activeCheck?.catch(() => undefined)
        const created = creating === null ? null : await creating
        const remaining: CapturedCleanupResource[] = []
        if (checkUnjoined) remaining.push('operation')
        const mismatches = new Set<string>()
        let verified = true
        if (created !== null) {
          try {
            const report = await created.dispose()
            if (!report.operationsJoined && !remaining.includes('operation')) remaining.push('operation')
            if (!report.worktreeRemoved) remaining.push('worktree')
            if (!report.privateStateRemoved) remaining.push('private_git_state')
            for (const mismatch of report.mismatches) mismatches.add(mismatch)
          } catch {
            remaining.push('worktree', 'private_git_state')
            verified = false
          }
        }
        try {
          for (const mismatch of compareSnapshots(baseline, await snapshotRepository(root, gitCommonDir))) mismatches.add(mismatch)
        } catch {
          verified = false
        }
        if (mismatches.has('snapshot')) verified = false
        return Object.freeze({
          remaining: Object.freeze(remaining),
          original: Object.freeze({ verified, unchanged: verified && mismatches.size === 0, mismatches: Object.freeze([...mismatches]) }),
        })
      })()
      return disposal
    },

    worktreePath: (): string | null => session?.path ?? null,
    documentRoot: (): string | null => documentRoot,
  })
}
