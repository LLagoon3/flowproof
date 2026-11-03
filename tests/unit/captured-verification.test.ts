import { createHash, randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CapturedPhase } from '../../packages/flowproof/src/capture/browserCapture.js'
import { capturedResult, createCandidate, failedResult, noChangesResult, notAttemptedResult, rejectedResult, repositoryCoverage } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureCandidate, CaptureResult } from '../../packages/flowproof/src/editing/capture.js'
import type { EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import type { EvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import { createRunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import type { RunArtifactStore } from '../../packages/flowproof/src/evidence/store.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import type { LoadedScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { createRunEventStream } from '../../packages/flowproof/src/studio/events.js'
import type { RunEventStream } from '../../packages/flowproof/src/studio/events.js'
import { persistPhase, sessionResult } from '../support/capturedCandidate.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { REPO_ROOT, createTempDirectory, git } from '../support/repoFixture.js'

// T007 (specs/004-verify-captured-changes): the captured-verification reduction. Exactly ten
// mandatory checks in data-model order; `passed` only when every check passes with the required
// evidence and complete cleanup; failed checks give `failed`, operational inability `error`,
// timeout and close `interrupted`. Unreported checks become `unevaluable`, never omitted or passed,
// and cleanup or integrity failure overrides otherwise-passing checks. This is not the legacy
// nine-gate reducer and never produces `Verified Fix`.

type CheckStatus = 'pass' | 'fail' | 'unevaluable'

interface CapturedCheck {
  readonly check_id: string
  readonly status: CheckStatus
  readonly reason_code: string
  readonly message: string
  readonly evidence_ids: readonly string[]
  readonly metrics: Readonly<Record<string, number | boolean | null>>
}

interface EvidenceReference {
  readonly manifest_path: string
  readonly screenshot_path: string
}

interface CleanupFacts {
  readonly complete: boolean
  readonly remaining_owned_resources: readonly string[]
  readonly original_unchanged: boolean
  readonly original_mismatches: readonly string[]
}

type Termination = 'completed' | 'error' | 'timeout' | 'interrupted'

interface Reduction {
  readonly status: 'passed' | 'failed' | 'error' | 'interrupted'
  readonly reason_code: string | null
  readonly message: string | null
  readonly checks: readonly CapturedCheck[]
}

interface CapturedContractsModule {
  readonly CAPTURED_CHECK_IDS: readonly string[]
  capturedCheck(checkId: string, reasonCode: string, init?: { readonly evidence_ids?: readonly string[]; readonly metrics?: Readonly<Record<string, number | boolean | null>> }): CapturedCheck
  reduceCapturedVerification(input: {
    readonly checks: readonly CapturedCheck[]
    readonly termination: Termination
    readonly before_evidence: EvidenceReference | null
    readonly after_evidence: EvidenceReference | null
    readonly cleanup: CleanupFacts
  }): Reduction
  parseCapturedVerificationResult(input: unknown): { readonly ok: boolean }
}

const MODULE_PATH = 'packages/flowproof/src/verify/capturedContracts.ts'
const contracts = (): Promise<CapturedContractsModule> =>
  loadPendingModule<CapturedContractsModule>(MODULE_PATH, 'T008', ['CAPTURED_CHECK_IDS', 'capturedCheck', 'reduceCapturedVerification', 'parseCapturedVerificationResult'])

const ORDER = [
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

const PASS_REASONS: Readonly<Record<(typeof ORDER)[number], string>> = {
  input_valid: 'INPUT_ADMITTED',
  baseline_reproduced: 'BASELINE_REPRODUCED',
  application_complete: 'APPLICATION_COMPLETE',
  build_passed: 'BUILD_PASSED',
  tests_passed: 'TESTS_PASSED',
  dataset_matches: 'DATASET_MATCHED',
  canvas_matches: 'CANVAS_MATCHED',
  secret_scan_clean: 'SECRET_SCAN_CLEAN',
  cleanup_complete: 'CLEANUP_COMPLETE',
  original_unchanged: 'ORIGINAL_UNCHANGED',
}

const BEFORE: EvidenceReference = { manifest_path: 'evidence/failure/manifest.json', screenshot_path: 'evidence/failure/screenshot.png' }
const AFTER: EvidenceReference = { manifest_path: 'evidence/replay/manifest.json', screenshot_path: 'evidence/replay/screenshot.png' }
const CLEAN: CleanupFacts = { complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] }

function passing(mod: CapturedContractsModule): CapturedCheck[] {
  return ORDER.map((id) =>
    mod.capturedCheck(id, PASS_REASONS[id], {
      evidence_ids:
        id === 'baseline_reproduced' ? ['ev_failure_dataset_001', 'ev_failure_chart_001'] : id === 'dataset_matches' ? ['ev_replay_dataset_001'] : id === 'canvas_matches' ? ['ev_replay_chart_001'] : [],
    }),
  )
}

const replace = (checks: readonly CapturedCheck[], next: CapturedCheck): CapturedCheck[] => checks.map((check) => (check.check_id === next.check_id ? next : check))
const without = (checks: readonly CapturedCheck[], ...ids: string[]): CapturedCheck[] => checks.filter((check) => !ids.includes(check.check_id))

/** Wraps a reduction in the strict result envelope, so every reduction is also contract-valid. */
function envelope(reduction: Reduction, evidence: { before: EvidenceReference | null; after: EvidenceReference | null }, cleanup: CleanupFacts): Record<string, unknown> {
  const base = JSON.parse(readFileSync(new URL('../fixtures/contracts/captured-verification-result.valid-passed.json', import.meta.url), 'utf8')) as Record<string, unknown>
  return { ...base, ...reduction, checks: [...reduction.checks], before_evidence: evidence.before, after_evidence: evidence.after, cleanup }
}

describe('captured verification reduction', () => {
  it('reduces to exactly ten checks in the data-model order', async () => {
    const mod = await contracts()
    expect(mod.CAPTURED_CHECK_IDS).toEqual(ORDER)
    const shuffled = [...passing(mod)].reverse()
    const reduction = mod.reduceCapturedVerification({ checks: shuffled, termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })
    expect(reduction.checks.map((check) => check.check_id)).toEqual(ORDER)
  })

  it('passes only when all ten checks pass with required evidence and complete cleanup', async () => {
    const mod = await contracts()
    const reduction = mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })
    expect(reduction).toMatchObject({ status: 'passed', reason_code: null, message: null })
    expect(reduction.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(JSON.stringify(reduction)).not.toContain('Verified Fix')
    expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: AFTER }, CLEAN)).ok).toBe(true)
  })

  it.each([
    ['baseline_reproduced', 'BASELINE_NOT_REPRODUCED', 'BASELINE_NOT_CONFIRMED'],
    ['application_complete', 'APPLICATION_REJECTED', 'APPLICATION_FAILED'],
    ['application_complete', 'APPLICATION_FIDELITY_MISMATCH', 'APPLICATION_FAILED'],
    ['build_passed', 'BUILD_FAILED', 'CANDIDATE_FAILED'],
    ['tests_passed', 'TESTS_NOT_EXECUTED', 'CANDIDATE_FAILED'],
    ['dataset_matches', 'DATASET_MISMATCH', 'CANDIDATE_FAILED'],
    ['canvas_matches', 'CANVAS_VALUE_MISMATCH', 'CANDIDATE_FAILED'],
    ['secret_scan_clean', 'SECRET_SCAN_FINDINGS', 'FINALIZATION_FAILED'],
  ])('a failed %s (%s) gives failed with %s', async (checkId, reason, outcome) => {
    const mod = await contracts()
    const checks = replace(passing(mod), mod.capturedCheck(checkId, reason))
    const reduction = mod.reduceCapturedVerification({ checks, termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })
    expect(reduction.status).toBe('failed')
    expect(reduction.reason_code).toBe(outcome)
    expect(reduction.message).toEqual(expect.any(String))
    expect(reduction.checks.find((check) => check.check_id === checkId)?.status).toBe('fail')
    expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: AFTER }, CLEAN)).ok).toBe(true)
  })

  it('marks later unexecuted checks unevaluable, never omitted or passed', async () => {
    const mod = await contracts()
    const executed = without(passing(mod), 'tests_passed', 'dataset_matches', 'canvas_matches')
    const checks = replace(executed, mod.capturedCheck('build_passed', 'BUILD_FAILED'))
    const reduction = mod.reduceCapturedVerification({ checks, termination: 'completed', before_evidence: BEFORE, after_evidence: null, cleanup: CLEAN })
    expect(reduction.checks).toHaveLength(10)
    for (const id of ['tests_passed', 'dataset_matches', 'canvas_matches']) {
      expect(reduction.checks.find((check) => check.check_id === id)).toMatchObject({ status: 'unevaluable', reason_code: 'CHECK_NOT_EVALUATED' })
    }
    expect(reduction.status).toBe('failed')
    expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: null }, CLEAN)).ok).toBe(true)
  })

  it('gives error for operational inability and interrupted for timeout or close', async () => {
    const mod = await contracts()
    const stopped = replace(without(passing(mod), 'tests_passed', 'dataset_matches', 'canvas_matches'), mod.capturedCheck('build_passed', 'STAGE_ERROR'))
    const error = mod.reduceCapturedVerification({ checks: stopped, termination: 'error', before_evidence: BEFORE, after_evidence: null, cleanup: CLEAN })
    expect(error).toMatchObject({ status: 'error', reason_code: 'VERIFICATION_ERROR' })
    expect(error.checks.find((check) => check.check_id === 'build_passed')?.status).toBe('unevaluable')

    const timedOut = replace(without(passing(mod), 'canvas_matches'), mod.capturedCheck('dataset_matches', 'RUN_TIMEOUT'))
    const timeout = mod.reduceCapturedVerification({ checks: timedOut, termination: 'timeout', before_evidence: BEFORE, after_evidence: null, cleanup: CLEAN })
    expect(timeout).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })

    const closed = replace(without(passing(mod), 'canvas_matches'), mod.capturedCheck('dataset_matches', 'RUN_INTERRUPTED'))
    const close = mod.reduceCapturedVerification({ checks: closed, termination: 'interrupted', before_evidence: BEFORE, after_evidence: null, cleanup: CLEAN })
    expect(close).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })

    // Even every check passing cannot turn a timeout or close into a pass.
    for (const termination of ['timeout', 'interrupted', 'error'] as const) {
      expect(mod.reduceCapturedVerification({ checks: passing(mod), termination, before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN }).status).not.toBe('passed')
    }
    for (const reduction of [error, timeout, close]) {
      expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: null }, CLEAN)).ok).toBe(true)
    }
  })

  it('cannot pass a zero-check or partially reported result', async () => {
    const mod = await contracts()
    const empty = mod.reduceCapturedVerification({ checks: [], termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })
    expect(empty.status).not.toBe('passed')
    expect(empty.checks).toHaveLength(10)
    expect(empty.checks.filter((check) => check.status === 'pass').map((check) => check.check_id)).toEqual(['cleanup_complete', 'original_unchanged'])
    const partial = mod.reduceCapturedVerification({ checks: without(passing(mod), 'canvas_matches'), termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })
    expect(partial.status).not.toBe('passed')
    expect(partial.checks.find((check) => check.check_id === 'canvas_matches')?.status).toBe('unevaluable')
    for (const reduction of [empty, partial]) {
      expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: AFTER }, CLEAN)).ok).toBe(true)
    }
  })

  it('cannot pass without the required before and after evidence', async () => {
    const mod = await contracts()
    for (const [before, after] of [
      [null, AFTER],
      [BEFORE, null],
    ] as const) {
      expect(mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: before, after_evidence: after, cleanup: CLEAN }).status).not.toBe('passed')
    }
  })

  // Every terminal result is also contract-valid: a passing baseline check cites the before
  // evidence and a passing replay check the after evidence, whatever the run's termination. A
  // missing reference turns the passing check into its existing evidence failure, never a pass.
  const MISSING_EVIDENCE = [
    [null, AFTER],
    [BEFORE, null],
    [null, null],
  ] as const
  const TERMINAL = [
    ['completed', null],
    ['error', 'VERIFICATION_ERROR'],
    ['timeout', 'RUN_TIMEOUT'],
    ['interrupted', 'RUN_INTERRUPTED'],
  ] as const

  it.each(TERMINAL.flatMap(([termination, reason]) => MISSING_EVIDENCE.map(([before, after]) => [termination, reason, before, after] as const)))(
    'a run ending as %s with missing evidence fails the passing evidence-dependent checks and stays contract-valid (%#)',
    async (termination, terminalReason, before, after) => {
      const mod = await contracts()
      const reduction = mod.reduceCapturedVerification({ checks: passing(mod), termination, before_evidence: before, after_evidence: after, cleanup: CLEAN })
      const byId = (id: string) => reduction.checks.find((check) => check.check_id === id)
      if (before === null) expect(byId('baseline_reproduced')).toMatchObject({ status: 'fail', reason_code: 'BASELINE_EVIDENCE_INCOMPLETE', evidence_ids: [] })
      else expect(byId('baseline_reproduced')).toMatchObject({ status: 'pass', reason_code: 'BASELINE_REPRODUCED' })
      for (const id of ['dataset_matches', 'canvas_matches']) {
        if (after === null) expect(byId(id)).toMatchObject({ status: 'fail', reason_code: 'REPLAY_EVIDENCE_INCOMPLETE', evidence_ids: [] })
        else expect(byId(id)?.status).toBe('pass')
      }
      for (const id of ['input_valid', 'application_complete', 'build_passed', 'tests_passed', 'secret_scan_clean', 'cleanup_complete', 'original_unchanged']) {
        expect(byId(id)?.status).toBe('pass')
      }
      expect(reduction.status).not.toBe('passed')
      expect(reduction.reason_code).toBe(terminalReason ?? (before === null ? 'BASELINE_NOT_CONFIRMED' : 'CANDIDATE_FAILED'))
      const parsed = mod.parseCapturedVerificationResult(envelope(reduction, { before, after }, CLEAN))
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    },
  )

  it('keeps non-passing evidence-dependent reasons and cleanup facts when evidence is missing', async () => {
    const mod = await contracts()
    const reported = replace(
      replace(without(passing(mod), 'canvas_matches'), mod.capturedCheck('baseline_reproduced', 'BASELINE_NOT_REPRODUCED')),
      mod.capturedCheck('dataset_matches', 'DATASET_MISMATCH'),
    )
    const incomplete: CleanupFacts = { complete: false, remaining_owned_resources: ['worktree'], original_unchanged: false, original_mismatches: ['snapshot'] }
    for (const [termination, outcome] of [
      ['completed', 'BASELINE_NOT_CONFIRMED'],
      ['error', 'VERIFICATION_ERROR'],
      ['timeout', 'RUN_TIMEOUT'],
      ['interrupted', 'RUN_INTERRUPTED'],
    ] as const) {
      const reduction = mod.reduceCapturedVerification({ checks: reported, termination, before_evidence: null, after_evidence: null, cleanup: incomplete })
      expect(reduction.reason_code).toBe(outcome)
      expect(reduction.checks.map((check) => [check.check_id, check.reason_code])).toEqual([
        ['input_valid', 'INPUT_ADMITTED'],
        ['baseline_reproduced', 'BASELINE_NOT_REPRODUCED'],
        ['application_complete', 'APPLICATION_COMPLETE'],
        ['build_passed', 'BUILD_PASSED'],
        ['tests_passed', 'TESTS_PASSED'],
        ['dataset_matches', 'DATASET_MISMATCH'],
        ['canvas_matches', 'CHECK_NOT_EVALUATED'],
        ['secret_scan_clean', 'SECRET_SCAN_CLEAN'],
        ['cleanup_complete', 'CLEANUP_INCOMPLETE'],
        ['original_unchanged', 'ORIGINAL_INTEGRITY_UNVERIFIED'],
      ])
      expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: null, after: null }, incomplete)).ok).toBe(true)
    }

    // Missing replay evidence alone fails the replay checks before cleanup in canonical order.
    const leaked = mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: BEFORE, after_evidence: null, cleanup: incomplete })
    expect(leaked).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED' })
    expect(leaked.checks.find((check) => check.check_id === 'cleanup_complete')).toMatchObject({ status: 'fail', reason_code: 'CLEANUP_INCOMPLETE' })
    expect(mod.parseCapturedVerificationResult(envelope(leaked, { before: BEFORE, after: null }, incomplete)).ok).toBe(true)
  })

  it('lets cleanup or integrity failure override otherwise-passing checks', async () => {
    const mod = await contracts()
    const incomplete: CleanupFacts = { complete: false, remaining_owned_resources: ['worktree'], original_unchanged: true, original_mismatches: [] }
    const leaked = mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: incomplete })
    expect(leaked).toMatchObject({ status: 'failed', reason_code: 'FINALIZATION_FAILED' })
    expect(leaked.checks.find((check) => check.check_id === 'cleanup_complete')).toMatchObject({ status: 'fail', reason_code: 'CLEANUP_INCOMPLETE' })

    const changed: CleanupFacts = { complete: true, remaining_owned_resources: [], original_unchanged: false, original_mismatches: ['trackedFiles'] }
    const modified = mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: changed })
    expect(modified).toMatchObject({ status: 'failed', reason_code: 'FINALIZATION_FAILED' })
    expect(modified.checks.find((check) => check.check_id === 'original_unchanged')).toMatchObject({ status: 'fail', reason_code: 'ORIGINAL_CHANGED' })

    const unverified: CleanupFacts = { complete: true, remaining_owned_resources: [], original_unchanged: false, original_mismatches: ['snapshot'] }
    const unknown = mod.reduceCapturedVerification({ checks: passing(mod), termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: unverified })
    expect(unknown.status).not.toBe('passed')
    expect(unknown.checks.find((check) => check.check_id === 'original_unchanged')).toMatchObject({ status: 'fail', reason_code: 'ORIGINAL_INTEGRITY_UNVERIFIED' })

    for (const [reduction, cleanup] of [
      [leaked, incomplete],
      [modified, changed],
      [unknown, unverified],
    ] as const) {
      expect(mod.parseCapturedVerificationResult(envelope(reduction, { before: BEFORE, after: AFTER }, cleanup)).ok).toBe(true)
    }
  })

  it('derives each check status and fixed message from its reason and rejects foreign reasons or duplicates', async () => {
    const mod = await contracts()
    const built = mod.capturedCheck('build_passed', 'BUILD_FAILED')
    expect(built).toMatchObject({ check_id: 'build_passed', status: 'fail', reason_code: 'BUILD_FAILED', evidence_ids: [], metrics: {} })
    expect(built.message).toBe(mod.capturedCheck('build_passed', 'BUILD_FAILED').message)
    expect(() => mod.capturedCheck('build_passed', 'TESTS_PASSED')).toThrow()
    expect(() => mod.capturedCheck('input_valid', 'Verified Fix')).toThrow()
    expect(() => mod.capturedCheck('unknown_check', 'CHECK_NOT_EVALUATED')).toThrow()
    expect(() => mod.capturedCheck('build_passed', 'BUILD_PASSED', { metrics: { output: 'text' as unknown as number } })).toThrow()
    const checks = [...passing(mod), mod.capturedCheck('build_passed', 'BUILD_FAILED')]
    expect(() => mod.reduceCapturedVerification({ checks, termination: 'completed', before_evidence: BEFORE, after_evidence: AFTER, cleanup: CLEAN })).toThrow()
  })
})

// ---------------------------------------------------------------------------------------
// T010 (US1): admission, orchestration, and whole-run scanning with fake ports. Only a completed
// editor with a `captured` result and complete upstream cleanup is admitted, as a frozen,
// digest-bound snapshot. The engine runs baseline reproduction, application, build, functional
// check, replay, scan, cleanup, and integrity in that order, stops at the first failing mandatory
// check, and never lets a check command, checker, or expected value come from anywhere but host
// code and trusted original inputs.
// ---------------------------------------------------------------------------------------

interface AdmittedCandidate {
  readonly editingSessionId: string
  readonly baselineCommit: string
  readonly patchSha256: string
  readonly patch: Buffer
  readonly files: CaptureCandidate['files']
  readonly coverage: CaptureCandidate['coverage']
}

type Admission = { readonly admitted: true; readonly candidate: AdmittedCandidate } | { readonly admitted: false; readonly error: { readonly code: string; readonly message: string } }

interface StageContext {
  readonly runId: string
  readonly scenario: LoadedScenario
  readonly store: RunArtifactStore
  readonly allocator: EvidenceIdAllocator
  readonly candidate: AdmittedCandidate
  readonly signal: AbortSignal
  /** A measured stage's port attests that the actual Studio frame shows its build and is ready. */
  readonly frameReady: () => void
}

type ApplicationFact = { readonly applied: true } | { readonly applied: false; readonly reason: 'BASELINE_UNAVAILABLE' | 'APPLICATION_REJECTED' | 'APPLICATION_FIDELITY_MISMATCH' }
type BuildFact = { readonly built: true } | { readonly built: false; readonly reason: 'BUILD_FAILED' | 'BUILD_OUTPUT_INVALID' }
interface FunctionalCheckFact {
  readonly exitCode: number | null
  readonly summary: { readonly discovered: number; readonly executed: number; readonly passed: number; readonly failed: number } | null
  readonly expectedCases: number
}
interface ReleaseFact {
  readonly remaining: readonly string[]
}
interface WorktreeReleaseFact extends ReleaseFact {
  readonly original: { readonly verified: boolean; readonly unchanged: boolean; readonly mismatches: readonly string[] }
}

interface CapturedRunPorts {
  reproduceBaseline(context: StageContext): Promise<CapturedPhase>
  applyCandidate(context: StageContext): Promise<ApplicationFact>
  build(context: StageContext): Promise<BuildFact>
  functionalCheck(context: StageContext): Promise<FunctionalCheckFact>
  replay(context: StageContext): Promise<CapturedPhase>
  disposeCapture(): Promise<ReleaseFact>
  disposeWorktree(): Promise<WorktreeReleaseFact>
}

interface CapturedResult {
  readonly kind: string
  readonly run_id: string
  readonly request_id: string
  readonly editing_session_id: string
  readonly baseline_commit: string
  readonly candidate_patch_sha256: string
  readonly status: string
  readonly reason_code: string | null
  readonly checks: readonly CapturedCheck[]
  readonly cleanup: Record<string, unknown>
  readonly before_evidence: unknown
  readonly after_evidence: unknown
}

interface CapturedRunModule {
  admitCapturedCandidate(value: unknown, options: { readonly objectFormat: 'sha1' | 'sha256' }): Admission
  executeCapturedRun(options: {
    readonly runId: string
    readonly requestId: string
    readonly scenario: LoadedScenario
    readonly candidate: AdmittedCandidate
    readonly store: RunArtifactStore
    readonly events: RunEventStream
    readonly allocator: EvidenceIdAllocator
    readonly ports: CapturedRunPorts
    readonly secretMarkers: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<CapturedResult>
  readonly PREPARED_FUNCTIONAL_CHECKS: Readonly<Record<string, Readonly<Record<string, string>>>>
  parseCheckSummary(stdout: Buffer): { readonly discovered: number; readonly executed: number; readonly passed: number; readonly failed: number } | null
}

const capturedRun = (): Promise<CapturedRunModule> =>
  loadPendingModule<CapturedRunModule>('packages/flowproof/src/verify/capturedRun.ts', 'T014-T016', ['admitCapturedCandidate', 'executeCapturedRun', 'PREPARED_FUNCTIONAL_CHECKS'])

const HERO = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })
const EXPECTED_ROWS = HERO.oracle.dataset
const EXPECTED_CHART = HERO.oracle.chart
const KNOWN_BAD = {
  dataset: [...EXPECTED_ROWS, ...EXPECTED_ROWS.map((row) => ({ ...row, region: 'Northeast' }))],
  chart: { bar_count: 8, labels: [...EXPECTED_CHART.labels, ...EXPECTED_CHART.labels], values: [...EXPECTED_CHART.values, ...EXPECTED_CHART.values] },
}
const MARKER = 'FPCAPTUREDUNITMARKER000001'
const UNIQUE_PATH = 'src/zz-captured-unit-only-path.txt'
const PATCH_TEXT = 'diff --git a/src/zz-captured-unit-only-path.txt b/src/zz-captured-unit-only-path.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/zz-captured-unit-only-path.txt\n@@ -0,0 +1 @@\n+synthetic captured unit line\n'
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const runCleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of runCleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

function syntheticCandidate(options: { readonly sessionId?: string; readonly patch?: Uint8Array; readonly path?: string; readonly baselineCommit?: string } = {}): CaptureCandidate {
  const baselineCommit = options.baselineCommit ?? 'a'.repeat(40)
  return createCandidate({
    sessionId: options.sessionId ?? randomUUID(),
    baselineCommit,
    patch: options.patch ?? Buffer.from(PATCH_TEXT),
    files: [
      {
        path: Buffer.from(options.path ?? UNIQUE_PATH),
        operation: 'added',
        oldMode: null,
        newMode: '100644',
        oldObjectId: null,
        newObjectId: 'b'.repeat(baselineCommit.length),
        oldSize: null,
        newSize: 29,
      },
    ],
    coverage: repositoryCoverage(false),
  })
}

const composition = (candidate: CaptureCandidate, session: Partial<EditingSessionResult> = {}): { session: EditingSessionResult; capture: CaptureResult } => ({
  session: sessionResult(candidate.sessionId, session),
  capture: capturedResult(candidate),
})

function admitted(mod: CapturedRunModule, value: unknown): AdmittedCandidate {
  const admission = mod.admitCapturedCandidate(value, { objectFormat: 'sha1' })
  expect(admission.admitted, JSON.stringify(admission)).toBe(true)
  if (!admission.admitted) throw new Error('not admitted')
  return admission.candidate
}

interface Harness {
  readonly log: string[]
  readonly runId: string
  readonly requestId: string
  readonly runRoot: string
  readonly store: RunArtifactStore
  readonly events: RunEventStream
  readonly contexts: StageContext[]
}

async function harness(): Promise<Harness> {
  const repo = await createTempDirectory('flowproof-captured-run-')
  runCleanups.push(repo.remove)
  git(repo.path, 'init', '--quiet')
  await writeFile(path.join(repo.path, '.gitignore'), '.flowproof/\n')
  const runId = randomUUID()
  const store = await createRunArtifactStore({ repoRoot: repo.path, runId })
  const events = createRunEventStream({ runId, registry: store })
  const log: string[] = []
  events.subscribe((event) => log.push(`event:${event.type}:${event.phase ?? 'none'}:${event.message}`))
  return { log, runId, requestId: randomUUID(), runRoot: path.join(repo.path, '.flowproof', 'runs', runId), store, events, contexts: [] }
}

function fakePorts(h: Harness, overrides: Partial<CapturedRunPorts> = {}): CapturedRunPorts {
  const scenarioId = HERO.scenario.scenario_id
  const record = <T>(name: keyof CapturedRunPorts, fallback: (context: StageContext) => Promise<T>) => async (context: StageContext): Promise<T> => {
    h.log.push(`port:${name}`)
    h.contexts.push(context)
    const override = overrides[name] as ((context: StageContext) => Promise<T>) | undefined
    return override ? override(context) : fallback(context)
  }
  // The default measured ports attest frame readiness explicitly before they capture.
  return {
    reproduceBaseline: record('reproduceBaseline', (context) => {
      context.frameReady()
      return persistPhase(context, scenarioId, 'failure', KNOWN_BAD)
    }),
    applyCandidate: record('applyCandidate', async () => ({ applied: true }) as ApplicationFact),
    build: record('build', async () => ({ built: true }) as BuildFact),
    functionalCheck: record('functionalCheck', async () => ({ exitCode: 0, summary: { discovered: 6, executed: 6, passed: 6, failed: 0 }, expectedCases: 6 })),
    replay: record('replay', (context) => {
      context.frameReady()
      return persistPhase(context, scenarioId, 'replay', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) })
    }),
    disposeCapture: async () => {
      h.log.push('port:disposeCapture')
      return overrides.disposeCapture ? overrides.disposeCapture() : { remaining: [] }
    },
    disposeWorktree: async () => {
      h.log.push('port:disposeWorktree')
      return overrides.disposeWorktree ? overrides.disposeWorktree() : { remaining: [], original: { verified: true, unchanged: true, mismatches: [] } }
    },
  }
}

async function run(
  mod: CapturedRunModule,
  options: {
    readonly candidate?: AdmittedCandidate
    readonly overrides?: Partial<CapturedRunPorts>
    readonly markers?: readonly string[]
    readonly before?: (h: Harness) => void
    readonly signal?: AbortSignal
    /** Wraps the run's store, to observe or fail its reads and writes. */
    readonly store?: (store: RunArtifactStore) => RunArtifactStore
  } = {},
): Promise<{ readonly result: CapturedResult; readonly h: Harness }> {
  const h = await harness()
  options.before?.(h)
  const candidate = options.candidate ?? admitted(mod, composition(syntheticCandidate()))
  const result = await mod.executeCapturedRun({
    runId: h.runId,
    requestId: h.requestId,
    scenario: HERO,
    candidate,
    store: options.store?.(h.store) ?? h.store,
    events: h.events,
    allocator: createEvidenceIdAllocator(h.runId),
    ports: fakePorts(h, options.overrides),
    secretMarkers: options.markers ?? [MARKER],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { result, h }
}

const ports = (h: Harness): string[] => h.log.filter((line) => line.startsWith('port:')).map((line) => line.slice('port:'.length))
const statusOf = (result: CapturedResult, id: string): string | undefined => result.checks.find((check) => check.check_id === id)?.status
const reasonOf = (result: CapturedResult, id: string): string | undefined => result.checks.find((check) => check.check_id === id)?.reason_code

/** Every file persisted below the run directory, as raw bytes. */
async function persistedFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else files.set(child, await readFile(path.join(root, child)))
    }
  }
  await walk('')
  return files
}

describe('captured candidate admission', () => {
  it('admits only a completed editor with a captured result and complete upstream cleanup', async () => {
    const mod = await capturedRun()
    const candidate = syntheticCandidate()
    expect(mod.admitCapturedCandidate(composition(candidate), { objectFormat: 'sha1' }).admitted).toBe(true)
    // A retried cleanup that left nothing behind is complete.
    const recovered = { status: 'recovered', containerRemoved: true, workspaceRemoved: true, originalRepositoryUnchanged: true, reasonCode: 'CLEANUP_RETRIED', remainingOwnedResources: [] } as const
    expect(mod.admitCapturedCandidate(composition(candidate, { cleanup: recovered }), { objectFormat: 'sha1' }).admitted).toBe(true)
  })

  it.each<[string, () => unknown]>([
    ['no_changes', () => ({ session: sessionResult(randomUUID()), capture: noChangesResult(repositoryCoverage(false)) })],
    ['rejected', () => ({ session: sessionResult(randomUUID()), capture: rejectedResult('SENSITIVE_DATA', repositoryCoverage(false)) })],
    ['failed', () => ({ session: sessionResult(randomUUID()), capture: failedResult('CAPTURE_IO_FAILED', null) })],
    ['not_attempted after an editor failure', () => ({ session: sessionResult(randomUUID(), { executionOutcome: 'failed', exitCode: 3, diagnostic: 'failed: the agent exited with code 3.' }), capture: notAttemptedResult() })],
    [
      'an upstream cleanup failure',
      () => {
        const candidate = syntheticCandidate()
        return composition(candidate, {
          cleanup: { status: 'failed', containerRemoved: true, workspaceRemoved: false, originalRepositoryUnchanged: true, reasonCode: 'WORKSPACE_NOT_REMOVED', remainingOwnedResources: ['workspace'] },
        })
      },
    ],
    [
      'an upstream original-integrity failure',
      () => {
        const candidate = syntheticCandidate()
        return composition(candidate, {
          cleanup: { status: 'failed', containerRemoved: true, workspaceRemoved: true, originalRepositoryUnchanged: false, reasonCode: 'ORIGINAL_REPOSITORY_CHANGED', remainingOwnedResources: ['original_repository'] },
        })
      },
    ],
    ['a malformed composition', () => ({ session: {}, capture: { status: 'captured' } })],
    ['a bare candidate', () => syntheticCandidate()],
    ['nothing', () => undefined],
  ])('returns a fixed bounded start error for %s', async (_name, build) => {
    const mod = await capturedRun()
    const value = build()
    const admission = mod.admitCapturedCandidate(value, { objectFormat: 'sha1' })
    expect(admission.admitted).toBe(false)
    if (admission.admitted) return
    expect(admission.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/)
    expect(admission.error.message.length).toBeGreaterThan(0)
    expect(admission.error.message.length).toBeLessThanOrEqual(200)
    expect(admission.error.message).not.toMatch(/\/|zz-captured|diff --git/)
    // The same input always yields the same fixed error.
    expect(mod.admitCapturedCandidate(value, { objectFormat: 'sha1' })).toEqual(admission)
  })

  it('requires the baseline ID format to match the repository object format', async () => {
    const mod = await capturedRun()
    const sha1 = composition(syntheticCandidate())
    const sha256Candidate = composition(syntheticCandidate({ baselineCommit: 'c'.repeat(64) }))
    expect(mod.admitCapturedCandidate(sha1, { objectFormat: 'sha256' }).admitted).toBe(false)
    expect(mod.admitCapturedCandidate(sha256Candidate, { objectFormat: 'sha1' }).admitted).toBe(false)
    expect(mod.admitCapturedCandidate(sha256Candidate, { objectFormat: 'sha256' }).admitted).toBe(true)
  })

  it('owns a frozen snapshot whose digest covers the exact bytes, regardless of later caller mutation', async () => {
    const mod = await capturedRun()
    const original = Buffer.from(PATCH_TEXT)
    const source = syntheticCandidate({ patch: original })
    // A caller-built plain composition whose Buffers and arrays the caller still holds.
    const patch = Buffer.from(original)
    const filePath = Buffer.from(UNIQUE_PATH)
    const files = [{ ...source.files[0], path: filePath }]
    const plainCandidate = { sessionId: source.sessionId, baselineCommit: source.baselineCommit, patch, files, coverage: source.coverage }
    const value = { session: sessionResult(source.sessionId), capture: { status: 'captured', candidate: plainCandidate } }
    const candidate = admitted(mod, value)
    patch.fill(0x41)
    filePath.fill(0x42)
    files.push({ ...files[0] as (typeof files)[number] })
    expect(candidate.patchSha256).toBe(sha256(original))
    expect(candidate.patch.equals(original)).toBe(true)
    expect(candidate.files).toHaveLength(1)
    expect((candidate.files[0] as CaptureCandidate['files'][number]).path.toString()).toBe(UNIQUE_PATH)
    expect(Object.isFrozen(candidate)).toBe(true)
    // Reads return fresh copies, so a consumer cannot alter the owned bytes either.
    candidate.patch.fill(0x43)
    expect(candidate.patch.equals(original)).toBe(true)

    let applied: Buffer | null = null
    const { result } = await run(mod, {
      candidate,
      overrides: {
        applyCandidate: async (context) => {
          applied = context.candidate.patch
          return { applied: true }
        },
      },
    })
    expect((applied as Buffer | null)?.equals(original)).toBe(true)
    expect(result.candidate_patch_sha256).toBe(sha256(original))
    expect(result.baseline_commit).toBe(source.baselineCommit)
  })

  it('keeps the editing session ID distinct from the server-assigned run and request IDs', async () => {
    const mod = await capturedRun()
    const source = syntheticCandidate()
    const candidate = admitted(mod, composition(source))
    const { result, h } = await run(mod, { candidate })
    expect(result.editing_session_id).toBe(source.sessionId)
    expect(result.run_id).toBe(h.runId)
    expect(result.request_id).toBe(h.requestId)
    expect(new Set([result.editing_session_id, result.run_id, result.request_id]).size).toBe(3)

    // A run whose identity reuses the editing session ID is refused before any stage.
    const reused = await harness()
    const store = await createRunArtifactStore({ repoRoot: path.dirname(path.dirname(path.dirname(reused.runRoot))), runId: source.sessionId })
    await expect(
      mod.executeCapturedRun({
        runId: source.sessionId,
        requestId: randomUUID(),
        scenario: HERO,
        candidate,
        store,
        events: createRunEventStream({ runId: source.sessionId, registry: store }),
        allocator: createEvidenceIdAllocator(source.sessionId),
        ports: fakePorts(reused),
        secretMarkers: [MARKER],
      }),
    ).rejects.toThrow()
    expect(ports(reused).filter((name) => !name.startsWith('dispose'))).toEqual([])
  })
})

describe('captured verification orchestration', () => {
  it('runs reproduction, application, build, functional check, replay, scan, cleanup, and integrity in order and passes only then', async () => {
    const mod = await capturedRun()
    const { result, h } = await run(mod)
    expect(result.kind).toBe('captured-verification')
    expect(result.status).toBe('passed')
    expect(result.checks.map((check) => check.status)).toEqual(Array(10).fill('pass'))
    expect(ports(h)).toEqual(['reproduceBaseline', 'applyCandidate', 'build', 'functionalCheck', 'replay', 'disposeCapture', 'disposeWorktree'])
    // The whole-run scan stage runs after replay and before cleanup.
    const scan = h.log.findIndex((line) => line.startsWith('event:agent_message') && /scan/i.test(line))
    expect(scan).toBeGreaterThan(h.log.indexOf('port:replay'))
    expect(scan).toBeLessThan(h.log.indexOf('port:disposeCapture'))
    // Only existing event types and the supported captured phases; no model or gate events.
    const events = h.events.events()
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(['agent_message', 'phase_started', 'evidence_added', 'run_finalized']))
    expect(events.every((event) => ['initialized', 'reproducing', 'failure_captured', 'applying', 'replaying', 'finalized'].includes(event.phase ?? ''))).toBe(true)
    expect(events.every((event) => event.gate === null)).toBe(true)
    expect(events.at(-1)?.type).toBe('run_finalized')
    expect(JSON.stringify(events)).not.toMatch(/diagnos|Verified Fix|citation/i)
    // The strict result is the run's existing `result` artifact, exactly as returned.
    expect(JSON.parse((await h.store.read('result')).toString('utf8'))).toEqual(result)
    expect(h.store.hasArtifact('candidate/candidate.diff')).toBe(false)
  })

  it.each<[string, Partial<CapturedRunPorts>, string, string, string]>([
    ['an incomplete application', { applyCandidate: async () => ({ applied: false, reason: 'APPLICATION_REJECTED' }) }, 'application_complete', 'APPLICATION_REJECTED', 'APPLICATION_FAILED'],
    ['a fidelity mismatch', { applyCandidate: async () => ({ applied: false, reason: 'APPLICATION_FIDELITY_MISMATCH' }) }, 'application_complete', 'APPLICATION_FIDELITY_MISMATCH', 'APPLICATION_FAILED'],
    ['a missing baseline', { applyCandidate: async () => ({ applied: false, reason: 'BASELINE_UNAVAILABLE' }) }, 'application_complete', 'BASELINE_UNAVAILABLE', 'APPLICATION_FAILED'],
    ['a failed build', { build: async () => ({ built: false, reason: 'BUILD_FAILED' }) }, 'build_passed', 'BUILD_FAILED', 'CANDIDATE_FAILED'],
    ['missing build output', { build: async () => ({ built: false, reason: 'BUILD_OUTPUT_INVALID' }) }, 'build_passed', 'BUILD_OUTPUT_INVALID', 'CANDIDATE_FAILED'],
    ['a nonzero checker exit', { functionalCheck: async () => ({ exitCode: 1, summary: { discovered: 6, executed: 6, passed: 3, failed: 3 }, expectedCases: 6 }) }, 'tests_passed', 'TESTS_FAILED', 'CANDIDATE_FAILED'],
    ['a checker that executed zero cases', { functionalCheck: async () => ({ exitCode: 0, summary: { discovered: 0, executed: 0, passed: 0, failed: 0 }, expectedCases: 6 }) }, 'tests_passed', 'TESTS_NOT_EXECUTED', 'CANDIDATE_FAILED'],
    ['a summary that disagrees with the trusted case count', { functionalCheck: async () => ({ exitCode: 0, summary: { discovered: 2, executed: 2, passed: 2, failed: 0 }, expectedCases: 6 }) }, 'tests_passed', 'TESTS_FAILED', 'CANDIDATE_FAILED'],
    ['a missing checker summary', { functionalCheck: async () => ({ exitCode: 0, summary: null, expectedCases: 6 }) }, 'tests_passed', 'TESTS_FAILED', 'CANDIDATE_FAILED'],
  ])('stops at %s and marks later checks unevaluable', async (_name, overrides, checkId, reason, outcome) => {
    const mod = await capturedRun()
    const { result, h } = await run(mod, { overrides })
    expect(result).toMatchObject({ status: 'failed', reason_code: outcome })
    expect(reasonOf(result, checkId)).toBe(reason)
    const order = ['application_complete', 'build_passed', 'tests_passed', 'dataset_matches', 'canvas_matches']
    for (const later of order.slice(order.indexOf(checkId) + 1)) {
      expect(result.checks.find((check) => check.check_id === later)).toMatchObject({ status: 'unevaluable', reason_code: 'CHECK_NOT_EVALUATED' })
    }
    const stages = ['applyCandidate', 'build', 'functionalCheck', 'replay']
    const stopped = { application_complete: 'applyCandidate', build_passed: 'build', tests_passed: 'functionalCheck' }[checkId] as string
    expect(ports(h)).toEqual(['reproduceBaseline', ...stages.slice(0, stages.indexOf(stopped) + 1), 'disposeCapture', 'disposeWorktree'])
    for (const id of ['secret_scan_clean', 'cleanup_complete', 'original_unchanged']) expect(statusOf(result, id)).toBe('pass')
  })

  it('passes baseline_reproduced only when actual baseline observations show the defect with complete evidence', async () => {
    const mod = await capturedRun()
    const shown = await run(mod)
    expect(shown.result.checks.find((check) => check.check_id === 'baseline_reproduced')).toMatchObject({
      status: 'pass',
      evidence_ids: ['ev_failure_dataset_001', 'ev_failure_chart_001'],
    })
    const matching = await run(mod, {
      overrides: { reproduceBaseline: (context) => persistPhase(context, HERO.scenario.scenario_id, 'failure', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) }) },
    })
    expect(reasonOf(matching.result, 'baseline_reproduced')).toBe('BASELINE_NOT_REPRODUCED')
    expect(matching.result).toMatchObject({ status: 'failed', reason_code: 'BASELINE_NOT_CONFIRMED' })
    expect(ports(matching.h)).toEqual(['reproduceBaseline', 'disposeCapture', 'disposeWorktree'])
    const incomplete = await run(mod, {
      overrides: {
        reproduceBaseline: async (context) => {
          const phase = await persistPhase(context, HERO.scenario.scenario_id, 'failure', KNOWN_BAD)
          return { ...phase, bundle: { ...phase.bundle, items: phase.bundle.items.filter((item) => item.type !== 'console') } }
        },
      },
    })
    expect(reasonOf(incomplete.result, 'baseline_reproduced')).toBe('BASELINE_EVIDENCE_INCOMPLETE')
    expect(incomplete.result.status).toBe('failed')
    expect(incomplete.result.before_evidence).toBeNull()
  })

  it('fails both replay oracles when replay evidence is missing and fails a plausible but wrong replay', async () => {
    const mod = await capturedRun()
    const missing = await run(mod, {
      overrides: {
        replay: async (context) => {
          const phase = await persistPhase(context, HERO.scenario.scenario_id, 'replay', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) })
          return { ...phase, screenshotPath: 'evidence/replay/missing.png' }
        },
      },
    })
    for (const id of ['dataset_matches', 'canvas_matches']) expect(missing.result.checks.find((check) => check.check_id === id)).toMatchObject({ status: 'fail', reason_code: 'REPLAY_EVIDENCE_INCOMPLETE' })
    expect(missing.result).toMatchObject({ status: 'failed', reason_code: 'CANDIDATE_FAILED', after_evidence: null })

    const wrongRows = EXPECTED_ROWS.map((row, index) => (index === 3 ? { ...row, revenue: 105 } : { ...row }))
    const wrong = await run(mod, {
      overrides: { replay: (context) => persistPhase(context, HERO.scenario.scenario_id, 'replay', { dataset: wrongRows, chart: { ...EXPECTED_CHART, values: wrongRows.map((row) => row.revenue as number) } }) },
    })
    expect(reasonOf(wrong.result, 'dataset_matches')).toBe('DATASET_MISMATCH')
    expect(reasonOf(wrong.result, 'canvas_matches')).toBe('CANVAS_VALUE_MISMATCH')
    expect(wrong.result.status).toBe('failed')
  })

  it('reports an operational stage failure as error and still runs the scan, cleanup, and integrity steps', async () => {
    const mod = await capturedRun()
    const { result, h } = await run(mod, {
      overrides: {
        build: async () => {
          throw new Error(`spawn failed at /tmp/private/${MARKER}`)
        },
      },
    })
    expect(result).toMatchObject({ status: 'error', reason_code: 'VERIFICATION_ERROR' })
    expect(result.checks.find((check) => check.check_id === 'build_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'STAGE_ERROR' })
    expect(ports(h)).toEqual(['reproduceBaseline', 'applyCandidate', 'build', 'disposeCapture', 'disposeWorktree'])
    expect(JSON.stringify(result)).not.toContain(MARKER)
    expect(JSON.stringify(h.events.events())).not.toMatch(/\/tmp\/private|spawn failed/)
  })

  it('takes check commands, the checker, and expected values only from host code and trusted original inputs', async () => {
    const mod = await capturedRun()
    expect(mod.PREPARED_FUNCTIONAL_CHECKS['canvas-filter-hero']).toEqual({
      checker: 'tests/fixtures/captured-verification/check-filter.mjs',
      cases: 'tests/fixtures/captured-verification/filter-cases.json',
      module: 'apps/demo-chart/src/filterData.ts',
    })
    expect(Object.keys(mod.PREPARED_FUNCTIONAL_CHECKS)).toEqual(['canvas-filter-hero'])
    const selection = JSON.stringify(mod.PREPARED_FUNCTIONAL_CHECKS)
    expect(selection).not.toContain('demo-chart.test')
    expect(selection).not.toMatch(/vitest|pnpm|npm|package\.json/)
    // Expected values come from the loaded scenario oracle: a replay that matches only a
    // candidate-supplied expectation, not the committed one, fails.
    const shifted = { dataset: EXPECTED_ROWS.map((row) => ({ ...row, region: 'Northeast' })), chart: structuredClone(EXPECTED_CHART) }
    const { result } = await run(mod, { overrides: { replay: (context) => persistPhase(context, HERO.scenario.scenario_id, 'replay', shifted) } })
    expect(reasonOf(result, 'dataset_matches')).toBe('DATASET_MISMATCH')
  })
})

describe('captured measured-phase readiness', () => {
  const SCENARIO_ID = HERO.scenario.scenario_id
  const REPLAYED = (): { dataset: unknown; chart: unknown } => ({ dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) })
  const phaseStarts = (h: Harness): Array<string | null> => h.events.events().filter((event) => event.type === 'phase_started').map((event) => event.phase)
  const evidencePhases = (h: Harness): Array<string | null> => h.events.events().filter((event) => event.type === 'evidence_added').map((event) => event.phase)
  type Seen = ReadonlyArray<readonly [string, string | null, string]>

  it('announces each measured phase only when its port attests that the actual frame is ready', async () => {
    const mod = await capturedRun()
    let current: Harness | undefined
    const seen = (): Seen => (current?.events.events() ?? []).map((event) => [event.type, event.phase, event.message] as const)
    const observed: { beforeBaseline?: Seen; afterBaseline?: Seen; beforeReplay?: Seen; afterReplay?: Seen } = {}
    const { result, h } = await run(mod, {
      before: (harness) => {
        current = harness
      },
      overrides: {
        reproduceBaseline: async (context) => {
          // Building, serving, and reconnecting the baseline is still preparation under the prior phase.
          observed.beforeBaseline = seen()
          context.frameReady()
          observed.afterBaseline = seen()
          return persistPhase(context, SCENARIO_ID, 'failure', KNOWN_BAD)
        },
        replay: async (context) => {
          observed.beforeReplay = seen()
          context.frameReady()
          observed.afterReplay = seen()
          return persistPhase(context, SCENARIO_ID, 'replay', REPLAYED())
        },
      },
    })
    expect(result.status).toBe('passed')

    const { beforeBaseline = [], afterBaseline = [], beforeReplay = [], afterReplay = [] } = observed
    expect(beforeBaseline.filter(([type]) => type === 'phase_started')).toEqual([])
    expect(beforeBaseline.at(-1)).toEqual(['agent_message', 'initialized', expect.stringMatching(/not live/i)])
    expect(afterBaseline.slice(0, beforeBaseline.length)).toEqual(beforeBaseline)
    expect(afterBaseline.slice(beforeBaseline.length)).toEqual([['phase_started', 'reproducing', expect.stringMatching(/live/i)]])

    expect(beforeReplay.filter(([type]) => type === 'phase_started').map(([, phase]) => phase)).toEqual(['reproducing', 'failure_captured', 'applying'])
    expect(beforeReplay.at(-1)).toEqual(['agent_message', 'applying', expect.stringMatching(/not live/i)])
    expect(afterReplay.slice(beforeReplay.length)).toEqual([['phase_started', 'replaying', expect.stringMatching(/live/i)]])

    // Each measured phase's evidence is announced inside that phase, then the run moves on.
    expect(phaseStarts(h)).toEqual(['reproducing', 'failure_captured', 'applying', 'replaying'])
    expect(evidencePhases(h)).toEqual(['reproducing', 'replaying'])
    for (const event of h.events.events()) expect(event.message.length).toBeLessThanOrEqual(200)
  })

  it('never invents a live phase when a measured port does not attest readiness', async () => {
    const mod = await capturedRun()
    const { result, h } = await run(mod, {
      overrides: {
        reproduceBaseline: (context) => persistPhase(context, SCENARIO_ID, 'failure', KNOWN_BAD),
        replay: (context) => persistPhase(context, SCENARIO_ID, 'replay', REPLAYED()),
      },
    })
    expect(phaseStarts(h)).toEqual(['failure_captured', 'applying'])
    expect(evidencePhases(h)).toEqual(['initialized', 'applying'])
    expect(h.events.events().some((event) => event.phase === 'reproducing' || event.phase === 'replaying')).toBe(false)
    // The verdict still comes only from the checked evidence; readiness gates the live announcement.
    expect(result.status).toBe('passed')
  })

  it('keeps readiness once-only, bound to its own measured stage, and inert once that stage settled', async () => {
    const mod = await capturedRun()
    const retained: StageContext[] = []
    const { result, h } = await run(mod, {
      overrides: {
        reproduceBaseline: async (context) => {
          retained.push(context)
          context.frameReady()
          context.frameReady()
          return persistPhase(context, SCENARIO_ID, 'failure', KNOWN_BAD)
        },
        // Unmeasured stages cannot announce a live phase, and a settled stage's attestation is inert.
        applyCandidate: async (context) => {
          context.frameReady()
          retained[0]?.frameReady()
          return { applied: true }
        },
        build: async (context) => {
          context.frameReady()
          return { built: true }
        },
        functionalCheck: async (context) => {
          context.frameReady()
          return { exitCode: 0, summary: { discovered: 6, executed: 6, passed: 6, failed: 0 }, expectedCases: 6 }
        },
        replay: async (context) => {
          retained.push(context)
          retained[0]?.frameReady()
          context.frameReady()
          context.frameReady()
          return persistPhase(context, SCENARIO_ID, 'replay', REPLAYED())
        },
      },
    })
    expect(result.status).toBe('passed')
    expect(phaseStarts(h)).toEqual(['reproducing', 'failure_captured', 'applying', 'replaying'])
    expect(retained).toHaveLength(2)
    expect(retained[0]).not.toBe(retained[1])
    const count = h.events.events().length
    for (const context of retained) context.frameReady()
    expect(h.events.events()).toHaveLength(count)
  })

  it('ignores a readiness attestation that arrives after the run was interrupted', async () => {
    const mod = await capturedRun()
    const controller = new AbortController()
    const { result, h } = await run(mod, {
      signal: controller.signal,
      overrides: {
        reproduceBaseline: async (context) => {
          controller.abort()
          context.frameReady()
          return persistPhase(context, SCENARIO_ID, 'failure', KNOWN_BAD)
        },
      },
    })
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
    expect(phaseStarts(h)).toEqual([])
    expect(h.events.events().some((event) => event.phase === 'reproducing')).toBe(false)
  })
})

describe('captured whole-run secret scanning', () => {
  it('fails secret_scan_clean for a seeded marker in the raw candidate patch bytes', async () => {
    const mod = await capturedRun()
    const candidate = admitted(mod, composition(syntheticCandidate({ patch: Buffer.from(`${PATCH_TEXT}+${MARKER}\n`) })))
    const { result } = await run(mod, { candidate })
    expect(result.checks.find((check) => check.check_id === 'secret_scan_clean')).toMatchObject({ status: 'fail', reason_code: 'SECRET_SCAN_FINDINGS' })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'FINALIZATION_FAILED' })
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })

  it('fails secret_scan_clean for a seeded marker in raw candidate path bytes', async () => {
    const mod = await capturedRun()
    const candidate = admitted(mod, composition(syntheticCandidate({ path: `src/${MARKER}.txt` })))
    const { result } = await run(mod, { candidate })
    expect(reasonOf(result, 'secret_scan_clean')).toBe('SECRET_SCAN_FINDINGS')
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })

  it('fails secret_scan_clean for a seeded marker in persisted evidence', async () => {
    const mod = await capturedRun()
    const { result } = await run(mod, { overrides: { reproduceBaseline: (context) => persistPhase(context, HERO.scenario.scenario_id, 'failure', KNOWN_BAD, `seeded ${MARKER}`) } })
    expect(reasonOf(result, 'secret_scan_clean')).toBe('SECRET_SCAN_FINDINGS')
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })

  it('fails secret_scan_clean for a seeded marker in run events', async () => {
    const mod = await capturedRun()
    const { result } = await run(mod, { before: (h) => h.events.emit({ type: 'agent_message', phase: 'initialized', message: `seeded ${MARKER}` }) })
    expect(reasonOf(result, 'secret_scan_clean')).toBe('SECRET_SCAN_FINDINGS')
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })

  it('fails secret_scan_clean for a seeded marker in the final result', async () => {
    const mod = await capturedRun()
    const source = syntheticCandidate()
    const candidate = admitted(mod, composition(source))
    // The editing-session identity appears only in the final result.
    const { result } = await run(mod, { candidate, markers: [source.sessionId] })
    expect(reasonOf(result, 'secret_scan_clean')).toBe('SECRET_SCAN_FINDINGS')
    expect(result.status).not.toBe('passed')
  })

  it('persists no patch bytes, raw candidate paths, or candidate-diff artifact', async () => {
    const mod = await capturedRun()
    const { result, h } = await run(mod)
    expect(result.status).toBe('passed')
    const files = await persistedFiles(h.runRoot)
    expect([...files.keys()].every((name) => name === 'result.json' || name.startsWith('evidence/'))).toBe(true)
    for (const [name, bytes] of files) {
      expect(bytes.includes(Buffer.from(PATCH_TEXT)), name).toBe(false)
      expect(bytes.includes(Buffer.from('zz-captured-unit-only-path')), name).toBe(false)
      expect(bytes.includes(Buffer.from('diff --git')), name).toBe(false)
    }
    expect(JSON.stringify(h.events.events())).not.toContain('zz-captured-unit-only-path')
  })
})

describe('captured run ownership, finalization, and interruption', () => {
  it('refuses a look-alike candidate that admission never produced, before any stage', async () => {
    const mod = await capturedRun()
    const real = admitted(mod, composition(syntheticCandidate()))
    const forged = Object.freeze({
      editingSessionId: real.editingSessionId,
      baselineCommit: real.baselineCommit,
      patchSha256: real.patchSha256,
      patch: real.patch,
      files: real.files,
      coverage: real.coverage,
    })
    const h = await harness()
    await expect(
      mod.executeCapturedRun({
        runId: h.runId,
        requestId: h.requestId,
        scenario: HERO,
        candidate: forged,
        store: h.store,
        events: h.events,
        allocator: createEvidenceIdAllocator(h.runId),
        ports: fakePorts(h),
        secretMarkers: [MARKER],
      }),
    ).rejects.toThrow()
    expect(ports(h)).toEqual([])
    expect(h.store.hasArtifact('result.json')).toBe(false)
  })

  it.each<[string, Partial<CapturedRunPorts>, Record<string, unknown>, string]>([
    [
      'a worktree that was not removed',
      { disposeWorktree: async () => ({ remaining: ['worktree'], original: { verified: true, unchanged: true, mismatches: [] } }) },
      { complete: false, remaining_owned_resources: ['worktree'], original_unchanged: true },
      'CLEANUP_INCOMPLETE',
    ],
    [
      'a capture disposal that threw',
      {
        disposeCapture: async () => {
          throw new Error(`release failed at /tmp/private/${MARKER}`)
        },
      },
      { complete: false, remaining_owned_resources: ['target_runtime', 'browser_capture'], original_unchanged: true },
      'CLEANUP_INCOMPLETE',
    ],
    [
      'a changed original repository',
      { disposeWorktree: async () => ({ remaining: [], original: { verified: true, unchanged: false, mismatches: ['refs'] } }) },
      { complete: true, original_unchanged: false, original_mismatches: ['refs'] },
      'ORIGINAL_CHANGED',
    ],
    [
      'an original repository that could not be compared',
      {
        disposeWorktree: async () => {
          throw new Error('snapshot failed')
        },
      },
      { complete: false, remaining_owned_resources: ['worktree', 'private_git_state'], original_unchanged: false, original_mismatches: ['snapshot'] },
      'ORIGINAL_INTEGRITY_UNVERIFIED',
    ],
  ])('fails an otherwise-passing run after %s, still running every disposal', async (_name, overrides, cleanup, reason) => {
    const mod = await capturedRun()
    const { result, h } = await run(mod, { overrides })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'FINALIZATION_FAILED', cleanup })
    expect(result.checks.filter((check) => check.status !== 'pass').map((check) => check.reason_code)).toContain(reason)
    expect(ports(h).slice(-2)).toEqual(['disposeCapture', 'disposeWorktree'])
    expect(JSON.stringify(result)).not.toContain(MARKER)
  })

  it('finalizes an interruption as interrupted, with the in-flight check unevaluable, after scanning and cleanup', async () => {
    const mod = await capturedRun()
    const controller = new AbortController()
    let observed = false
    const { result, h } = await run(mod, {
      overrides: {
        build: async (context) => {
          controller.abort()
          observed = context.signal.aborted
          return { built: true }
        },
      },
      signal: controller.signal,
    })
    expect(observed).toBe(true)
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
    expect(result.checks.find((check) => check.check_id === 'build_passed')).toMatchObject({ status: 'unevaluable', reason_code: 'RUN_INTERRUPTED' })
    expect(statusOf(result, 'tests_passed')).toBe('unevaluable')
    expect(ports(h)).toEqual(['reproduceBaseline', 'applyCandidate', 'build', 'disposeCapture', 'disposeWorktree'])
    expect(h.log.some((line) => line.startsWith('event:agent_message') && /scan/i.test(line))).toBe(true)
    expect(result.cleanup).toMatchObject({ complete: true, original_unchanged: true })
  })

  it('accepts only the trusted checker summary line with consistent counts', async () => {
    const mod = await capturedRun()
    const line = (value: unknown, suffix = '\n'): Buffer => Buffer.from(`${JSON.stringify(value)}${suffix}`)
    const valid = { check: 'prepared-region-filter', discovered: 6, executed: 6, passed: 6, failed: 0 }
    expect(mod.parseCheckSummary(line(valid))).toEqual({ discovered: 6, executed: 6, passed: 6, failed: 0 })
    for (const output of [
      line(valid, ''),
      Buffer.concat([line(valid), line(valid)]),
      Buffer.from(`noise\n${JSON.stringify(valid)}\n`),
      line({ ...valid, check: 'other-check' }),
      line({ ...valid, extra: 1 }),
      line({ ...valid, passed: 7, failed: -1 }),
      line({ ...valid, executed: 7 }),
      line({ ...valid, passed: 5 }),
      line({ ...valid, discovered: 6.5 }),
      Buffer.alloc(0),
    ]) {
      expect(mod.parseCheckSummary(output)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------------
// T028 (US3): terminal paths with fake ports and a fake monotonic clock. Application failure and
// failed checks are `failed`; spawn, Git, or capture inability is `error`; exceeding the shared
// apply/build/test/replay window or the total window is `interrupted`/`RUN_TIMEOUT` even when no
// timer fires; an abort is `interrupted`/`RUN_INTERRUPTED`. Later checks are `unevaluable`; every
// cleanup step runs exactly once on every path, also after an earlier cleanup-step failure; the
// secret scan runs on every terminal path; identity equals the admitted snapshot and run; and no
// reason carries a host path, command output, or scanner value.
// ---------------------------------------------------------------------------------------

const WINDOW_MS = HERO.scenario.timeouts.replay_ms
const TOTAL_MS = HERO.scenario.timeouts.total_ms
const STAGE_PORTS = ['reproduceBaseline', 'applyCandidate', 'build', 'functionalCheck', 'replay'] as const
type StagePort = (typeof STAGE_PORTS)[number]
const STAGE_CHECKS: Readonly<Record<StagePort, readonly string[]>> = {
  reproduceBaseline: ['baseline_reproduced'],
  applyCandidate: ['application_complete'],
  build: ['build_passed'],
  functionalCheck: ['tests_passed'],
  replay: ['dataset_matches', 'canvas_matches'],
}
const PRIVATE_LOCATOR = `/tmp/private-host-locator/${MARKER}`

/** A test-controlled monotonic clock, independent of real filesystem and scheduler latency. */
function fakeMonotonicClock(): { advance(ms: number): void } {
  let now = performance.now()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return {
    advance(ms: number): void {
      now += ms
    },
  }
}

/** The default passing behavior of one stage port, so an override can delay it and still pass. */
function passingStage(port: StagePort, context: StageContext): Promise<unknown> {
  const scenarioId = HERO.scenario.scenario_id
  switch (port) {
    case 'reproduceBaseline':
      context.frameReady()
      return persistPhase(context, scenarioId, 'failure', KNOWN_BAD)
    case 'applyCandidate':
      return Promise.resolve({ applied: true })
    case 'build':
      return Promise.resolve({ built: true })
    case 'functionalCheck':
      return Promise.resolve({ exitCode: 0, summary: { discovered: 6, executed: 6, passed: 6, failed: 0 }, expectedCases: 6 })
    case 'replay':
      context.frameReady()
      return persistPhase(context, scenarioId, 'replay', { dataset: structuredClone(EXPECTED_ROWS), chart: structuredClone(EXPECTED_CHART) })
  }
}

const override = (port: StagePort, action: (context: StageContext) => Promise<unknown>): Partial<CapturedRunPorts> => ({ [port]: action }) as Partial<CapturedRunPorts>

/** Assertions that hold on every terminal path. */
async function expectTerminal(result: CapturedResult, h: Harness, candidate: AdmittedCandidate, stopped: StagePort | null): Promise<void> {
  // Identity is the admitted snapshot and this run, never anything a port returned.
  expect(result).toMatchObject({
    kind: 'captured-verification',
    run_id: h.runId,
    request_id: h.requestId,
    editing_session_id: candidate.editingSessionId,
    baseline_commit: candidate.baselineCommit,
    candidate_patch_sha256: candidate.patchSha256,
  })
  expect(JSON.parse((await h.store.read('result')).toString('utf8'))).toEqual(result)
  // Every cleanup step runs exactly once, last, after every stage settled.
  const called = ports(h)
  expect(called.filter((name) => name === 'disposeCapture')).toHaveLength(1)
  expect(called.filter((name) => name === 'disposeWorktree')).toHaveLength(1)
  expect(called.slice(-2)).toEqual(['disposeCapture', 'disposeWorktree'])
  // The whole-run scan ran and produced an evaluated check.
  expect(h.log.filter((line) => line.startsWith('event:agent_message') && /scan/i.test(line))).toHaveLength(1)
  expect(statusOf(result, 'secret_scan_clean')).not.toBe('unevaluable')
  // No stage after the stopped one ran, and its checks are unevaluable, never omitted or passed.
  if (stopped !== null) {
    const later = STAGE_PORTS.slice(STAGE_PORTS.indexOf(stopped) + 1)
    for (const port of later) {
      expect(called).not.toContain(port)
      for (const id of STAGE_CHECKS[port]) expect(result.checks.find((check) => check.check_id === id)).toMatchObject({ status: 'unevaluable', reason_code: 'CHECK_NOT_EVALUATED' })
    }
  }
  expect(result.checks).toHaveLength(10)
  // Reasons and activity are fixed text: no host path, command output, or scanner value.
  for (const surface of [JSON.stringify(result), JSON.stringify(h.events.events())]) {
    expect(surface).not.toContain(MARKER)
    expect(surface).not.toMatch(/private-host-locator|command output|spawn failed/)
  }
}

describe('captured terminal paths, deadlines, and cleanup (T028)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each<[string, StagePort]>([
    ['capture inability during baseline reproduction', 'reproduceBaseline'],
    ['Git inability during application', 'applyCandidate'],
    ['a build that could not spawn', 'build'],
    ['a checker that could not spawn', 'functionalCheck'],
    ['capture inability during replay', 'replay'],
  ])('finalizes %s as error with the stage unevaluable', async (_name, port) => {
    const mod = await capturedRun()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const { result, h } = await run(mod, {
      candidate,
      overrides: override(port, async () => {
        throw new Error(`spawn failed with command output at ${PRIVATE_LOCATOR}`)
      }),
    })
    expect(result).toMatchObject({ status: 'error', reason_code: 'VERIFICATION_ERROR' })
    for (const id of STAGE_CHECKS[port]) expect(result.checks.find((check) => check.check_id === id)).toMatchObject({ status: 'unevaluable', reason_code: 'STAGE_ERROR' })
    await expectTerminal(result, h, candidate, port)
  })

  it.each<StagePort>(['applyCandidate', 'build', 'functionalCheck', 'replay'])(
    'times out when %s settles after the shared application window elapsed, although no timer fired',
    async (port) => {
      const mod = await capturedRun()
      const clock = fakeMonotonicClock()
      const candidate = admitted(mod, composition(syntheticCandidate()))
      const { result, h } = await run(mod, {
        candidate,
        overrides: override(port, (context) => {
          clock.advance(WINDOW_MS + 1)
          // A late readiness attestation never announces a live phase.
          return passingStage(port, context)
        }),
      })
      expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
      for (const id of STAGE_CHECKS[port]) expect(result.checks.find((check) => check.check_id === id)).toMatchObject({ status: 'unevaluable', reason_code: 'RUN_TIMEOUT' })
      if (port === 'replay') {
        expect(result.after_evidence).toBeNull()
        expect(h.log.some((line) => line.startsWith('event:phase_started:replaying'))).toBe(false)
      }
      await expectTerminal(result, h, candidate, port)
    },
  )

  it('shares one window across application, build, check, and replay', async () => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const half = Math.ceil(WINDOW_MS / 2)
    const { result, h } = await run(mod, {
      candidate,
      overrides: {
        applyCandidate: async () => {
          clock.advance(half)
          return { applied: true }
        },
        build: async () => {
          clock.advance(half + 1)
          return { built: true }
        },
      },
    })
    // Each stage alone fits the window; together they exceed it.
    expect(reasonOf(result, 'application_complete')).toBe('APPLICATION_COMPLETE')
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
    expect(reasonOf(result, 'build_passed')).toBe('RUN_TIMEOUT')
    await expectTerminal(result, h, candidate, 'build')
  })

  it('does not charge baseline reproduction to the application window', async () => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const { result, h } = await run(mod, {
      candidate,
      overrides: override('reproduceBaseline', (context) => {
        clock.advance(WINDOW_MS + 1)
        return passingStage('reproduceBaseline', context)
      }),
    })
    expect(result.status).toBe('passed')
    await expectTerminal(result, h, candidate, null)
  })

  it.each<[string, StagePort]>([
    ['a baseline reproduction that outlasts the total window', 'reproduceBaseline'],
    ['an application that crosses the total window inside its own window', 'applyCandidate'],
  ])('times out %s, although no timer fired', async (_name, port) => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const overrides: Partial<CapturedRunPorts> =
      port === 'reproduceBaseline'
        ? override('reproduceBaseline', (context) => {
            clock.advance(TOTAL_MS + 1)
            return passingStage('reproduceBaseline', context)
          })
        : {
            ...override('reproduceBaseline', (context) => {
              clock.advance(TOTAL_MS - 10)
              return passingStage('reproduceBaseline', context)
            }),
            ...override('applyCandidate', async () => {
              clock.advance(20)
              return { applied: true }
            }),
          }
    const { result, h } = await run(mod, { candidate, overrides })
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
    for (const id of STAGE_CHECKS[port]) expect(reasonOf(result, id)).toBe('RUN_TIMEOUT')
    await expectTerminal(result, h, candidate, port)
  })

  it('accounts finalization to the total window: a cleanup that crosses it finalizes as timeout, never passed', async () => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const { result, h } = await run(mod, {
      candidate,
      overrides: {
        disposeWorktree: async () => {
          clock.advance(TOTAL_MS + 1)
          return { remaining: [], original: { verified: true, unchanged: true, mismatches: [] } }
        },
      },
    })
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT', cleanup: { complete: true, original_unchanged: true } })
    // Every executed stage keeps its evaluated outcome; nothing is invented or dropped.
    for (const id of ['baseline_reproduced', 'application_complete', 'build_passed', 'tests_passed', 'dataset_matches', 'canvas_matches']) expect(statusOf(result, id)).toBe('pass')
    const durations = (result as unknown as { readonly phase_durations_ms: Record<string, number>; readonly total_duration_ms: number })
    expect(durations.phase_durations_ms.finalize).toBeGreaterThanOrEqual(TOTAL_MS)
    expect(durations.total_duration_ms).toBeGreaterThan(TOTAL_MS)
    await expectTerminal(result, h, candidate, null)
  })

  it.each<[string, StagePort, number]>([
    ['the shared application window', 'build', WINDOW_MS],
    ['the total window', 'reproduceBaseline', TOTAL_MS],
  ])('aborts a stage that is still running when the timer of %s fires', async (_name, port, budget) => {
    const mod = await capturedRun()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const candidate = admitted(mod, composition(syntheticCandidate()))
    let entered: () => void = () => undefined
    const reached = new Promise<void>((resolve) => (entered = resolve))
    let signal: AbortSignal | null = null
    const pending = run(mod, {
      candidate,
      overrides: override(port, (context) => {
        signal = context.signal
        entered()
        return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error(`aborted at ${PRIVATE_LOCATOR}`)), { once: true }))
      }),
    })
    await reached
    await vi.advanceTimersByTimeAsync(budget + 1)
    const abortedInTime = (signal as AbortSignal | null)?.aborted === true
    // Release a run whose timer did not fire, so a missing timer fails instead of hanging.
    await vi.advanceTimersByTimeAsync(TOTAL_MS + 1)
    const { result, h } = await pending
    expect(abortedInTime).toBe(true)
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
    for (const id of STAGE_CHECKS[port]) expect(reasonOf(result, id)).toBe('RUN_TIMEOUT')
    await expectTerminal(result, h, candidate, port)
  })

  it.each<StagePort>([...STAGE_PORTS])('finalizes an abort during %s as interrupted, joining the stage first', async (port) => {
    const mod = await capturedRun()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const controller = new AbortController()
    let settledBeforeDisposal = false
    const { result, h } = await run(mod, {
      candidate,
      signal: controller.signal,
      overrides: {
        ...override(port, async (context) => {
          controller.abort()
          expect(context.signal.aborted).toBe(true)
          // The stage still settles late; disposal waits for it.
          await new Promise((resolve) => setTimeout(resolve, 20))
          settledBeforeDisposal = true
          return passingStage(port, context)
        }),
        disposeCapture: async () => {
          expect(settledBeforeDisposal).toBe(true)
          return { remaining: [] }
        },
      },
    })
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
    for (const id of STAGE_CHECKS[port]) expect(reasonOf(result, id)).toBe('RUN_INTERRUPTED')
    await expectTerminal(result, h, candidate, port)
  })

  it('reports whichever of interruption and deadline came first', async () => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const lateClose = new AbortController()
    const late = await run(mod, {
      signal: lateClose.signal,
      overrides: override('build', async () => {
        clock.advance(WINDOW_MS + 1)
        lateClose.abort()
        return { built: true }
      }),
    })
    expect(late.result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_TIMEOUT' })
    const earlyClose = new AbortController()
    const early = await run(mod, {
      signal: earlyClose.signal,
      overrides: override('build', async () => {
        earlyClose.abort()
        clock.advance(WINDOW_MS + 1)
        return { built: true }
      }),
    })
    expect(early.result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
  })

  it.each(['scan', 'disposeCapture', 'disposeWorktree'] as const)(
    'finalizes an otherwise-passing run as interrupted when the close arrives during its %s step, still finishing every cleanup step once',
    async (step) => {
      const mod = await capturedRun()
      const candidate = admitted(mod, composition(syntheticCandidate()))
      const controller = new AbortController()
      /** Closes the run while this finalization step is running; the step still settles afterwards. */
      const closeDuring = async (current: typeof step): Promise<void> => {
        if (current !== step || controller.signal.aborted) return
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const { result, h } = await run(mod, {
        candidate,
        signal: controller.signal,
        // The whole-run scan reads every persisted evidence artifact asynchronously.
        store: (store) => ({
          ...store,
          read: async (id: string) => {
            await closeDuring('scan')
            return store.read(id)
          },
        }),
        overrides: {
          disposeCapture: async () => {
            await closeDuring('disposeCapture')
            return { remaining: [] }
          },
          disposeWorktree: async () => {
            await closeDuring('disposeWorktree')
            return { remaining: [], original: { verified: true, unchanged: true, mismatches: [] } }
          },
        },
      })
      expect(controller.signal.aborted).toBe(true)
      expect(result).toMatchObject({
        status: 'interrupted',
        reason_code: 'RUN_INTERRUPTED',
        cleanup: { complete: true, remaining_owned_resources: [], original_unchanged: true, original_mismatches: [] },
      })
      // Every stage finished before the close and keeps its evaluated outcome; nothing is dropped.
      for (const id of ['baseline_reproduced', 'application_complete', 'build_passed', 'tests_passed', 'dataset_matches', 'canvas_matches', 'secret_scan_clean']) {
        expect(statusOf(result, id), id).toBe('pass')
      }
      await expectTerminal(result, h, candidate, null)
    },
  )

  it.each<[string, (clock: { advance(ms: number): void }, controller: AbortController) => Partial<CapturedRunPorts>, string, string]>([
    [
      'a close during cleanup that the total deadline passes only afterwards',
      (clock, controller) => ({
        disposeCapture: async () => {
          controller.abort()
          return { remaining: [] }
        },
        disposeWorktree: async () => {
          clock.advance(TOTAL_MS + 1)
          return { remaining: [], original: { verified: true, unchanged: true, mismatches: [] } }
        },
      }),
      'interrupted',
      'RUN_INTERRUPTED',
    ],
    [
      'a close during cleanup after the total deadline already passed',
      (clock, controller) => ({
        disposeCapture: async () => {
          clock.advance(TOTAL_MS + 1)
          controller.abort()
          return { remaining: [] }
        },
      }),
      'interrupted',
      'RUN_TIMEOUT',
    ],
    [
      'a close during cleanup after a failed check',
      (_clock, controller) => ({
        build: async () => ({ built: false, reason: 'BUILD_FAILED' }),
        disposeCapture: async () => {
          controller.abort()
          return { remaining: [] }
        },
      }),
      'interrupted',
      'RUN_INTERRUPTED',
    ],
    [
      'a close during cleanup after an operational error',
      (_clock, controller) => ({
        build: async () => {
          throw new Error(PRIVATE_LOCATOR)
        },
        disposeCapture: async () => {
          controller.abort()
          return { remaining: [] }
        },
      }),
      'error',
      'VERIFICATION_ERROR',
    ],
  ])('at the terminal boundary, reports the earliest stop for %s', async (_name, make, status, reason) => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const controller = new AbortController()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const { result, h } = await run(mod, { candidate, signal: controller.signal, overrides: make(clock, controller) })
    expect(result).toMatchObject({ status, reason_code: reason })
    // A check evaluated before the stop keeps its own outcome.
    if (reason !== 'VERIFICATION_ERROR') expect(statusOf(result, 'application_complete')).toBe('pass')
    await expectTerminal(result, h, candidate, null)
  })

  it('releases its interruption listener once the run finalized, also after an error or a failed persistence', async () => {
    const mod = await capturedRun()
    const listeners = (signal: AbortSignal): number => getEventListeners(signal, 'abort').length
    const passed = new AbortController()
    expect((await run(mod, { signal: passed.signal })).result.status).toBe('passed')
    expect(listeners(passed.signal)).toBe(0)

    const errored = new AbortController()
    const failing = run(mod, {
      signal: errored.signal,
      overrides: {
        build: async () => {
          throw new Error(PRIVATE_LOCATOR)
        },
      },
    })
    expect((await failing).result.status).toBe('error')
    expect(listeners(errored.signal)).toBe(0)

    const unpersisted = new AbortController()
    await expect(
      run(mod, {
        signal: unpersisted.signal,
        store: (store) => ({
          ...store,
          writeJson: (artifactPath: string, value: unknown) => (artifactPath === 'result.json' ? Promise.reject(new Error('synthetic write failure')) : store.writeJson(artifactPath, value)),
        }),
      }),
    ).rejects.toThrow('synthetic write failure')
    expect(listeners(unpersisted.signal)).toBe(0)
  })

  it('runs no stage for a run interrupted before it started, and still scans and cleans up', async () => {
    const mod = await capturedRun()
    const candidate = admitted(mod, composition(syntheticCandidate()))
    const controller = new AbortController()
    controller.abort()
    const { result, h } = await run(mod, { candidate, signal: controller.signal })
    expect(result).toMatchObject({ status: 'interrupted', reason_code: 'RUN_INTERRUPTED' })
    expect(ports(h)).toEqual(['disposeCapture', 'disposeWorktree'])
    expect(reasonOf(result, 'baseline_reproduced')).toBe('RUN_INTERRUPTED')
    expect(h.log.some((line) => line.startsWith('event:phase_started'))).toBe(false)
    await expectTerminal(result, h, candidate, 'reproduceBaseline')
  })

  it.each<[string, (clock: { advance(ms: number): void }, controller: AbortController) => Partial<CapturedRunPorts>, string]>([
    ['a failed build', () => ({ build: async () => ({ built: false, reason: 'BUILD_FAILED' }) }), 'failed'],
    [
      'an error',
      () => ({
        build: async () => {
          throw new Error(PRIVATE_LOCATOR)
        },
      }),
      'error',
    ],
    [
      'a timeout',
      (clock) => ({
        build: async () => {
          clock.advance(WINDOW_MS + 1)
          return { built: true }
        },
      }),
      'interrupted',
    ],
    [
      'an interruption',
      (_clock, controller) => ({
        build: async () => {
          controller.abort()
          return { built: true }
        },
      }),
      'interrupted',
    ],
  ])('after %s still attempts every cleanup step once despite an earlier cleanup failure, scans, and reports safe categories', async (_name, make, status) => {
    const mod = await capturedRun()
    const clock = fakeMonotonicClock()
    const controller = new AbortController()
    const candidate = admitted(mod, composition(syntheticCandidate({ patch: Buffer.from(PATCH_TEXT.replace('synthetic captured unit line', MARKER)) })))
    const { result, h } = await run(mod, {
      candidate,
      signal: controller.signal,
      overrides: {
        ...make(clock, controller),
        disposeCapture: async () => {
          throw new Error(`release failed at ${PRIVATE_LOCATOR}`)
        },
        disposeWorktree: async () => ({ remaining: ['worktree'], original: { verified: true, unchanged: false, mismatches: ['status'] } }),
      },
    })
    expect(result.status).toBe(status)
    expect(result.cleanup).toEqual({ complete: false, remaining_owned_resources: ['target_runtime', 'browser_capture', 'worktree'], original_unchanged: false, original_mismatches: ['status'] })
    expect(reasonOf(result, 'cleanup_complete')).toBe('CLEANUP_INCOMPLETE')
    expect(reasonOf(result, 'original_unchanged')).toBe('ORIGINAL_CHANGED')
    // The seeded marker in the raw candidate bytes is found on this terminal path too.
    expect(reasonOf(result, 'secret_scan_clean')).toBe('SECRET_SCAN_FINDINGS')
    await expectTerminal(result, h, candidate, 'build')
  })
})
