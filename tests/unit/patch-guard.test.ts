import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { Diagnosis, EvidenceBundle, GateOutcome } from '../../packages/flowproof/src/contracts/index.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempDirectory, git } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T032: the candidate guards that T040 implements in `packages/flowproof/src/patch/validateDiff.ts`.
// Untrusted model output becomes an applicable candidate only when its strict schema, every
// citation, its single permitted target path, its patch grammar and size, and
// `git apply --check` against the original HEAD all pass. The guards never apply the patch.
// Unsafe diffs are produced by Git itself where possible, so they would apply if unguarded.
// Each fixture breaks one rule. Patch-form rules (absolute or parent paths, symlink mode,
// binary content, renames, several sections, size) are reported before the target allowlist,
// which is checked before `git apply --check`; a rename or absolute path therefore reports its
// form even though it also names a path outside the boundary.

export interface CandidateValidationInput {
  readonly runId: string
  /** Raw, untrusted transport output. */
  readonly diagnosis: unknown
  readonly failureBundle: EvidenceBundle
  /** The scenario's `permitted_source_paths`, repository-relative. */
  readonly permittedSourcePaths: readonly string[]
  /** Checkout at the original HEAD where only `git apply --check` may run. */
  readonly checkoutRoot: string
}

export interface ValidatedCandidate {
  readonly target_path: string
  readonly unified_diff: string
  readonly evidence_ids: readonly string[]
}

export interface CandidateValidation {
  /** The strict-schema diagnosis, or null when the output violates the diagnosis contract. */
  readonly diagnosis: Diagnosis | null
  /** `citations_valid` */
  readonly citations: GateOutcome
  /** `patch_scope_valid` */
  readonly scope: GateOutcome
  /** Present only when both guards pass. */
  readonly candidate: ValidatedCandidate | null
}

export interface PatchGuardModule {
  validateCandidate(input: CandidateValidationInput): Promise<CandidateValidation>
}

const guardModule = (): Promise<PatchGuardModule> =>
  loadPendingModule<PatchGuardModule>('packages/flowproof/src/patch/validateDiff.ts', 'T040', ['validateCandidate'])

const TARGET = 'apps/demo-chart/src/filterData.ts'
const SEEDED = 'sk-flowproofseededpatchguard01'
const BUNDLE = parseEvidenceBundle(
  JSON.parse(await readFile(new URL('../fixtures/contracts/evidence-bundle.valid-failure.json', import.meta.url), 'utf8')),
)
if (!BUNDLE.ok) throw new Error('The failure bundle fixture is invalid.')
const FAILURE_BUNDLE = BUNDLE.value
const RUN_ID = FAILURE_BUNDLE.run_id
const RECORDED = loadRecordedHeroResponse() as Diagnosis
const SAFE_DIFF = RECORDED.candidate.unified_diff

let checkout: TempDirectory
const diffs: Record<string, string> = {}

/** A committed checkout of the demo sources at the original HEAD content. */
beforeAll(async () => {
  checkout = await createTempDirectory('flowproof-patch-guard-')
  const sourceDir = path.join(checkout.path, 'apps/demo-chart/src')
  await mkdir(sourceDir, { recursive: true })
  for (const file of ['data.ts', 'filterData.ts', 'main.ts', 'testProbe.ts']) {
    await writeFile(path.join(sourceDir, file), git(REPO_ROOT, 'show', `HEAD:apps/demo-chart/src/${file}`))
  }
  git(checkout.path, 'init', '--quiet')
  git(checkout.path, 'add', '.')
  git(checkout.path, '-c', 'user.email=flowproof@example.invalid', '-c', 'user.name=FlowProof Test', 'commit', '--quiet', '-m', 'baseline')

  const target = path.join(checkout.path, TARGET)
  const original = await readFile(target)
  const capture = async (name: string, mutate: () => Promise<void>, args: string[] = ['diff']): Promise<void> => {
    await mutate()
    diffs[name] = git(checkout.path, ...args)
    git(checkout.path, 'reset', '--quiet', '--hard')
    expect(await readFile(target)).toEqual(original)
  }

  await capture('wrongTarget', async () => {
    await writeFile(path.join(sourceDir, 'main.ts'), '// candidate edit\n', { flag: 'a' })
  })
  await capture('probeTarget', async () => {
    await writeFile(path.join(sourceDir, 'testProbe.ts'), '// candidate edit\n', { flag: 'a' })
  })
  await capture('multiFile', async () => {
    await writeFile(target, (await readFile(target, 'utf8')).replace('row.region.includes(region)', 'row.region === region'))
    await writeFile(path.join(sourceDir, 'main.ts'), '// candidate edit\n', { flag: 'a' })
  })
  await capture('binary', async () => writeFile(target, Buffer.from([0, 1, 2, 3, 0, 255])), ['diff', '--binary'])
  await capture('binarySummary', async () => writeFile(target, Buffer.from([0, 1, 2, 3, 0, 255])))
  await capture(
    'rename',
    async () => {
      git(checkout.path, 'mv', TARGET, 'apps/demo-chart/src/filterRows.ts')
    },
    ['diff', '--cached', '-M', 'HEAD'],
  )
  // One section that keeps a valid hunk but switches the permitted file to symlink mode.
  diffs.symlink = SAFE_DIFF.replace(/^index ([0-9a-f]+\.\.[0-9a-f]+) 100644$/m, 'old mode 100644\nnew mode 120000\nindex $1')
  diffs.absolute = SAFE_DIFF.replaceAll(`a/${TARGET}`, 'a//tmp/flowproof-escape.ts').replaceAll(`b/${TARGET}`, 'b//tmp/flowproof-escape.ts')
  diffs.parent = SAFE_DIFF.replaceAll(TARGET, 'apps/demo-chart/src/../src/filterData.ts')
  diffs.stale = SAFE_DIFF.replace('-  return rows.filter((row) => row.region.includes(region))', '-  return rows.filter((row) => row.region.startsWith(region))')
  diffs.oversized = SAFE_DIFF.replace(' }\n', `+// ${'x'.repeat(20_001)}\n }\n`).replace('@@ -2,5 +2,5 @@', '@@ -2,5 +2,6 @@')
  diffs.duplicateSection = `${SAFE_DIFF}${SAFE_DIFF}`
})

afterAll(async () => {
  await checkout?.remove()
})

const diagnosisWith = (overrides: { candidate?: Partial<Diagnosis['candidate']>; claims?: Diagnosis['claims']; extra?: object } = {}): unknown => ({
  ...structuredClone(RECORDED),
  ...(overrides.claims ? { claims: overrides.claims } : {}),
  candidate: { ...structuredClone(RECORDED.candidate), ...overrides.candidate },
  ...overrides.extra,
})

async function validate(diagnosis: unknown, bundle: EvidenceBundle = FAILURE_BUNDLE): Promise<CandidateValidation> {
  const { validateCandidate } = await guardModule()
  const before = { file: await readFile(path.join(checkout.path, TARGET)), status: git(checkout.path, 'status', '--porcelain') }
  const result = await validateCandidate({
    runId: RUN_ID,
    diagnosis,
    failureBundle: bundle,
    permittedSourcePaths: [TARGET],
    checkoutRoot: checkout.path,
  })
  expect(result.citations.gate_id).toBe('citations_valid')
  expect(result.scope.gate_id).toBe('patch_scope_valid')
  // Validation never applies the candidate: the checkout is byte-for-byte unchanged.
  expect(await readFile(path.join(checkout.path, TARGET))).toEqual(before.file)
  expect(git(checkout.path, 'status', '--porcelain')).toBe(before.status)
  if (result.candidate !== null) {
    expect(result.citations.status).toBe('pass')
    expect(result.scope.status).toBe('pass')
  }
  return result
}

async function expectScopeRejected(diff: string, code: string, targetPaths: readonly string[] = [TARGET]): Promise<CandidateValidation> {
  const result = await validate(diagnosisWith({ candidate: { unified_diff: diff, target_paths: [...targetPaths] } }))
  expect(result.scope).toMatchObject({ status: 'fail', reason_code: code })
  expect(result.candidate).toBeNull()
  return result
}

describe('patch guard: accepted candidate', () => {
  it('accepts the evidence-cited one-file diff that passes git apply --check, without applying it', async () => {
    const result = await validate(diagnosisWith())

    expect(result.diagnosis).toEqual(RECORDED)
    expect(result.citations.status).toBe('pass')
    expect(result.citations.evidence_ids).toEqual(expect.arrayContaining(RECORDED.candidate.evidence_ids))
    expect(result.scope.status).toBe('pass')
    expect(result.candidate).toEqual({
      target_path: TARGET,
      unified_diff: SAFE_DIFF,
      evidence_ids: RECORDED.candidate.evidence_ids,
    })
  })
})

describe('patch guard: unsafe patch forms', () => {
  it('rejects an absolute path', async () => {
    await expectScopeRejected(diffs.absolute ?? '', 'PATCH_PATH_ABSOLUTE')
  })

  it('rejects a parent-directory segment even when it normalizes into the permitted file', async () => {
    await expectScopeRejected(diffs.parent ?? '', 'PATCH_PATH_PARENT')
  })

  it('rejects a change that turns the permitted file into a symlink', async () => {
    expect(diffs.symlink).toContain('120000')
    await expectScopeRejected(diffs.symlink ?? '', 'PATCH_SYMLINK')
  })

  it.each(['binary', 'binarySummary'])('rejects a %s patch', async (name) => {
    await expectScopeRejected(diffs[name] ?? '', 'PATCH_BINARY')
  })

  it('rejects a rename', async () => {
    expect(diffs.rename).toContain('rename from')
    await expectScopeRejected(diffs.rename ?? '', 'PATCH_RENAME')
  })

  it.each(['multiFile', 'duplicateSection'])('rejects a %s patch', async (name) => {
    await expectScopeRejected(diffs[name] ?? '', 'PATCH_MULTI_FILE')
  })

  it('rejects an oversized patch', async () => {
    expect((diffs.oversized ?? '').length).toBeGreaterThan(20_000)
    await expectScopeRejected(diffs.oversized ?? '', 'PATCH_TOO_LARGE')
  })

  it.each([
    ['a non-permitted source file', 'wrongTarget', ['apps/demo-chart/src/main.ts']],
    ['the trusted probe outside the boundary', 'probeTarget', ['apps/demo-chart/src/testProbe.ts']],
    ['a diff that edits a different file than it declares', 'wrongTarget', [TARGET]],
  ])('rejects %s', async (_label, name, targets) => {
    await expectScopeRejected(diffs[name] ?? '', 'PATCH_TARGET_NOT_PERMITTED', targets)
  })

  it('rejects a declared target outside the boundary even when the diff edits the permitted file', async () => {
    await expectScopeRejected(SAFE_DIFF, 'PATCH_TARGET_NOT_PERMITTED', ['apps/demo-chart/src/main.ts'])
  })

  it('rejects a diff that git apply --check refuses against the original HEAD', async () => {
    await expectScopeRejected(diffs.stale ?? '', 'PATCH_APPLY_CHECK_FAILED')
  })
})

describe('patch guard: citations', () => {
  it.each([
    ['a claim', { claims: [{ text: `Unsupported claim token=${SEEDED}`, evidence_ids: ['ev_failure_dataset_002'] }] }],
    ['the candidate', { candidate: { evidence_ids: ['ev_failure_dataset_001', 'ev_failure_network_002'] } }],
  ])('rejects an Evidence ID absent from the failure bundle in %s', async (_label, overrides) => {
    const result = await validate(diagnosisWith(overrides))

    expect(result.citations).toMatchObject({ status: 'fail', reason_code: 'CITATION_UNKNOWN_EVIDENCE_ID' })
    expect(result.candidate).toBeNull()
    expect(JSON.stringify([result.citations, result.scope])).not.toContain(SEEDED)
  })

  it('rejects citations checked against another run’s failure bundle', async () => {
    const otherRun = '11111111-2222-4333-8444-555555555555'
    const foreign = {
      ...FAILURE_BUNDLE,
      run_id: otherRun,
      items: FAILURE_BUNDLE.items.map((item) => ({ ...item, run_id: otherRun })),
    }

    const result = await validate(diagnosisWith(), foreign)

    expect(result.citations).toMatchObject({ status: 'fail', reason_code: 'CITATION_CROSS_RUN' })
    expect(result.candidate).toBeNull()
  })

  it.each([
    ['a model-supplied final status', diagnosisWith({ extra: { status: 'Verified Fix' } })],
    ['a model-supplied gate outcome', diagnosisWith({ extra: { gates: [{ gate_id: 'dataset_matches', status: 'pass' }] } })],
    ['a replay-phase citation', diagnosisWith({ claims: [{ text: 'Replay evidence.', evidence_ids: ['ev_replay_dataset_001'] }] })],
    ['a non-object output', 'diff --git a/apps/demo-chart/src/filterData.ts b/apps/demo-chart/src/filterData.ts'],
  ])('fails closed on %s that violates the diagnosis contract', async (_label, diagnosis) => {
    const result = await validate(diagnosis)

    expect(result.diagnosis).toBeNull()
    expect(result.citations.status).not.toBe('pass')
    expect(result.scope.status).not.toBe('pass')
    expect(result.candidate).toBeNull()
  })
})

describe('patch guard: fixture sanity', () => {
  it('uses Git-produced unsafe diffs that git apply would otherwise accept', async () => {
    for (const name of ['wrongTarget', 'probeTarget', 'multiFile', 'rename', 'binary']) {
      const file = path.join(checkout.path, `${name}.patch`)
      await writeFile(file, diffs[name] ?? '')
      try {
        expect(git(checkout.path, 'apply', '--check', file), name).toBe('')
      } finally {
        await rm(file)
      }
    }
  })
})
