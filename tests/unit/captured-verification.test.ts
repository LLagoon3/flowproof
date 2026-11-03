import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadPendingModule } from '../support/pendingModule.js'

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
