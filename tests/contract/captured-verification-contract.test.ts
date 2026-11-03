import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseRunResult } from '../../packages/flowproof/src/contracts/index.js'
import { loadPendingModule } from '../support/pendingModule.js'

// T006 (specs/004-verify-captured-changes): the strict captured-verification result family. It is
// explicitly discriminated by `kind: captured-verification` with its own `schema_version` 1.0.0,
// carries exact candidate identity and ten fixed checks, and has no Diagnosis, provider, citation,
// legacy gate, patch, raw-path, argv, or host-locator field. The unchanged legacy `parseRunResult`
// and this parser reject each other's families instead of coercing them.

interface ContractIssue {
  readonly path: string
  readonly code: string
}

type ParseResult = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: { readonly code: string; readonly issues: readonly ContractIssue[] } }

interface CapturedContractsModule {
  parseCapturedVerificationResult(input: unknown): ParseResult
  readonly CAPTURED_RESULT_KIND: string
  readonly CAPTURED_SCHEMA_VERSION: string
  readonly CAPTURED_CHECK_IDS: readonly string[]
}

const MODULE_PATH = 'packages/flowproof/src/verify/capturedContracts.ts'
const contracts = (): Promise<CapturedContractsModule> =>
  loadPendingModule<CapturedContractsModule>(MODULE_PATH, 'T008', ['parseCapturedVerificationResult', 'CAPTURED_RESULT_KIND', 'CAPTURED_SCHEMA_VERSION', 'CAPTURED_CHECK_IDS'])

const FIXTURE_DIR = new URL('../fixtures/contracts/', import.meta.url)
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8')) as Record<string, unknown>
const clone = <T>(value: T): T => structuredClone(value)

const VALID = ['valid-passed', 'valid-failed', 'valid-interrupted-timeout', 'valid-sha256-baseline'].map((name) => `captured-verification-result.${name}`)
const INVALID_CASES: ReadonlyArray<readonly [string, string]> = [
  ['invalid-verified-fix-label', 'status'],
  ['invalid-diagnosis-field', '(root)'],
  ['invalid-missing-check', 'checks'],
  ['invalid-passed-with-unevaluable', 'status'],
  ['invalid-abbreviated-baseline', 'baseline_commit'],
  ['invalid-patch-or-raw-path-field', '(root)'],
  ['invalid-cleanup-failed-passed', 'status'],
]
const INVALID: ReadonlyArray<readonly [string, string]> = INVALID_CASES.map(([name, path]) => [`captured-verification-result.${name}`, path] as const)
const LEGACY_VALID = readdirSync(FIXTURE_DIR)
  .filter((name) => /^run-result\.valid-.*\.json$/.test(name))
  .map((name) => name.replace(/\.json$/, ''))

function rejectedPaths(result: ParseResult): string[] {
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.error.issues.map((issue) => issue.path)
}

describe('captured verification result contract', () => {
  it('declares the ten mandatory checks in the data-model order and the new family identity', async () => {
    const mod = await contracts()
    expect(mod.CAPTURED_CHECK_IDS).toEqual([
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
    ])
    expect(mod.CAPTURED_RESULT_KIND).toBe('captured-verification')
    expect(mod.CAPTURED_SCHEMA_VERSION).toBe('1.0.0')
  })

  it.each(VALID)('accepts %s', async (name) => {
    const { parseCapturedVerificationResult } = await contracts()
    const result = parseCapturedVerificationResult(fixture(name))
    expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('captured-verification')
    expect((result.value.checks as unknown[]).length).toBe(10)
  })

  it('accepts a passed result only under the Candidate verification label family, never Verified Fix', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const passed = parseCapturedVerificationResult(fixture('captured-verification-result.valid-passed'))
    expect(passed.ok).toBe(true)
    if (!passed.ok) return
    expect(passed.value.status).toBe('passed')
    expect(passed.value.reason_code).toBeNull()
    expect(JSON.stringify(passed.value)).not.toContain('Verified Fix')
  })

  it.each(INVALID)('rejects %s at %s', async (name, path) => {
    const { parseCapturedVerificationResult } = await contracts()
    expect(rejectedPaths(parseCapturedVerificationResult(fixture(name)))).toContain(path)
  })

  it('is discriminated by kind and its own schema version', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = fixture('captured-verification-result.valid-passed')
    const { kind: _kind, ...withoutKind } = valid
    expect(rejectedPaths(parseCapturedVerificationResult(withoutKind))).toContain('kind')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...valid, kind: 'run-result' }))).toContain('kind')
    for (const version of ['1.0.1', '2.0.0', 1]) {
      const result = parseCapturedVerificationResult({ ...valid, schema_version: version })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.issues.map((issue) => issue.path)).toContain('schema_version')
    }
  })

  it('accepts full lowercase SHA-1 and SHA-256 baselines and rejects abbreviated or uppercase IDs', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = fixture('captured-verification-result.valid-passed')
    for (const accepted of ['a'.repeat(40), 'b'.repeat(64), '0123456789abcdef0123456789abcdef01234567']) {
      expect(parseCapturedVerificationResult({ ...valid, baseline_commit: accepted }).ok).toBe(true)
    }
    for (const rejected of ['a'.repeat(39), 'a'.repeat(41), 'b'.repeat(63), 'b'.repeat(65), 'A'.repeat(40), `${'a'.repeat(39)}G`, '0123456', 'HEAD', 'main', '']) {
      expect(rejectedPaths(parseCapturedVerificationResult({ ...valid, baseline_commit: rejected }))).toContain('baseline_commit')
    }
  })

  it('requires candidate_patch_sha256 to be 64 lowercase hex characters', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = fixture('captured-verification-result.valid-passed')
    for (const rejected of ['c'.repeat(63), 'c'.repeat(65), 'C'.repeat(64), 'c'.repeat(40), '', null]) {
      expect(rejectedPaths(parseCapturedVerificationResult({ ...valid, candidate_patch_sha256: rejected }))).toContain('candidate_patch_sha256')
    }
  })

  it('rejects unknown fields and every Diagnosis, provider, citation, legacy-gate, patch, raw-path, argv, or host-locator field', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = fixture('captured-verification-result.valid-passed')
    const forbidden: Record<string, unknown> = {
      diagnosis: { summary: 'Synthetic.' },
      diagnosis_path: 'diagnosis/diagnosis.json',
      provider: { mode: 'meta', model: 'muse-spark-1.3', injected_fault_label: null },
      citations: ['ev_failure_dataset_001'],
      gates: [],
      failed_gate_ids: ['citations_valid'],
      candidate_diff_path: 'candidate/candidate.diff',
      patch: 'diff --git a/x b/x',
      candidate_patch: 'ZGlmZg==',
      files: [{ path: 'apps/demo-chart/src/filterData.ts' }],
      paths: ['apps/demo-chart/src/filterData.ts'],
      argv: ['pnpm', 'test'],
      command: 'pnpm test',
      repo_root: '/home/example/repo',
      worktree_path: '/tmp/flowproof-worktree-abc',
      original_head: '0123456789abcdef0123456789abcdef01234567',
      unknown_field: true,
    }
    for (const [key, value] of Object.entries(forbidden)) {
      const result = parseCapturedVerificationResult({ ...valid, [key]: value })
      expect(result.ok, key).toBe(false)
    }
    // Nested objects are strict as well.
    const withCheckPath = clone(valid)
    ;(withCheckPath.checks as Record<string, unknown>[])[2] = { ...(withCheckPath.checks as Record<string, unknown>[])[2], raw_path: 'src/a.ts' }
    expect(parseCapturedVerificationResult(withCheckPath).ok).toBe(false)
    const withCleanupPath = clone(valid)
    withCleanupPath.cleanup = { ...(withCleanupPath.cleanup as object), worktree_path: '/tmp/flowproof-worktree-abc' }
    expect(parseCapturedVerificationResult(withCleanupPath).ok).toBe(false)
    const hostEvidence = clone(valid)
    hostEvidence.before_evidence = { manifest_path: '/tmp/run/evidence/failure/manifest.json', screenshot_path: 'evidence/failure/screenshot.png' }
    expect(rejectedPaths(parseCapturedVerificationResult(hostEvidence)).some((path) => path.startsWith('before_evidence'))).toBe(true)
    const freeTextMessage = clone(valid)
    ;(freeTextMessage.checks as Record<string, unknown>[])[3] = { ...(freeTextMessage.checks as Record<string, unknown>[])[3], message: 'Verified Fix: build output at /tmp/x' }
    expect(parseCapturedVerificationResult(freeTextMessage).ok).toBe(false)
    const textMetric = clone(valid)
    ;(textMetric.checks as Record<string, unknown>[])[4] = { ...(textMetric.checks as Record<string, unknown>[])[4], metrics: { output: 'command output' } }
    expect(parseCapturedVerificationResult(textMetric).ok).toBe(false)
  })

  it('keeps the editing session, run, and request identities distinct', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = fixture('captured-verification-result.valid-passed')
    expect(parseCapturedVerificationResult({ ...valid, editing_session_id: valid.run_id }).ok).toBe(false)
    expect(parseCapturedVerificationResult({ ...valid, request_id: valid.run_id }).ok).toBe(false)
  })

  it('binds a non-passing reason to its status and the first failing check', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const failed = fixture('captured-verification-result.valid-failed')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...failed, reason_code: 'APPLICATION_FAILED', message: 'The candidate could not be applied completely at its recorded baseline, so it was not verified.' }))).toContain('reason_code')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...failed, reason_code: 'RUN_TIMEOUT' }))).toContain('reason_code')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...failed, message: 'Something else happened.' }))).toContain('message')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...failed, reason_code: null, message: null }))).toContain('reason_code')
    const timeout = fixture('captured-verification-result.valid-interrupted-timeout')
    expect(rejectedPaths(parseCapturedVerificationResult({ ...timeout, reason_code: 'CANDIDATE_FAILED' }))).toContain('reason_code')
  })

  it('reports only field paths and stable codes, never the rejected value', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const secretish = 'FPCONTRACTREJECTEDVALUE000001'
    const result = parseCapturedVerificationResult({ ...fixture('captured-verification-result.valid-passed'), baseline_commit: secretish, [secretish]: secretish })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secretish)
  })

  // A metric key is untrusted record input: a rejection names the check's metrics field only,
  // never the key itself, whether the key or its value is the invalid part.
  it.each([
    ['an invalid host-path key', { '/tmp/synthetic-private-marker': true }, ['/tmp/synthetic-private-marker']],
    ['an invalid home-path key with a text value', { '/home/fp-private/FPCONTRACTMETRICKEY000002': 'FPCONTRACTMETRICVALUE000002' }, ['FPCONTRACTMETRICKEY000002', 'FPCONTRACTMETRICVALUE000002', '/home/fp-private']],
    ['a valid-form secret key with a text value', { fpcontractmetrickey000003: 'FPCONTRACTMETRICVALUE000003' }, ['fpcontractmetrickey000003', 'FPCONTRACTMETRICVALUE000003']],
    ['a valid-form secret key with an object value', { fpcontractmetrickey000004: { nested: '/tmp/fp-nested-marker' } }, ['fpcontractmetrickey000004', '/tmp/fp-nested-marker', 'nested']],
    ['too many valid-form secret keys', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`fpcontractmetrickey00000${i}`, i])), ['fpcontractmetrickey']],
  ])('reports %s at the metrics field without its key or value', async (_label, metrics, secrets) => {
    const { parseCapturedVerificationResult } = await contracts()
    for (const index of [0, 5]) {
      const invalid = clone(fixture('captured-verification-result.valid-passed'))
      const checks = invalid.checks as Record<string, unknown>[]
      checks[index] = { ...checks[index], metrics }
      const result = parseCapturedVerificationResult(invalid)
      const serialized = JSON.stringify(result)
      for (const secret of secrets) expect(serialized).not.toContain(secret)
      expect(rejectedPaths(result)).toContain(`checks.${index}.metrics`)
      if (result.ok) continue
      for (const issue of result.error.issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'path'])
        expect(issue.path).toMatch(/^(?:\(root\)|[a-z_]+(?:\.(?:[a-z_]+|[0-9]+))*)$/)
        expect(issue.path.startsWith(`checks.${index}.metrics.`)).toBe(false)
        expect(issue.code).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('keeps accepting valid numeric, boolean, and null metrics', async () => {
    const { parseCapturedVerificationResult } = await contracts()
    const valid = clone(fixture('captured-verification-result.valid-passed'))
    const metrics = { expected_rows: 4, ratio: 0.5, matched: true, skipped: false, first_mismatch_index: null }
    ;(valid.checks as Record<string, unknown>[])[5] = { ...(valid.checks as Record<string, unknown>[])[5], metrics }
    const result = parseCapturedVerificationResult(valid)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (result.ok) expect((result.value.checks as Record<string, unknown>[])[5]?.metrics).toEqual(metrics)
  })

  it.each([...VALID, ...INVALID.map(([name]) => name)])('the unchanged legacy parseRunResult rejects %s', (name) => {
    expect(parseRunResult(fixture(name)).ok).toBe(false)
  })

  it.each(LEGACY_VALID)('the captured parser rejects the legacy %s fixture', async (name) => {
    expect(LEGACY_VALID.length).toBeGreaterThan(0)
    const { parseCapturedVerificationResult } = await contracts()
    expect(parseRunResult(fixture(name)).ok).toBe(true)
    expect(parseCapturedVerificationResult(fixture(name)).ok).toBe(false)
  })
})
