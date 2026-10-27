import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import type { Diagnosis } from '../../packages/flowproof/src/contracts/index.js'
import { validateCandidate } from '../../packages/flowproof/src/patch/validateDiff.js'
import type { CandidateValidation } from '../../packages/flowproof/src/patch/validateDiff.js'
import { loadRecordedHeroResponse } from '../support/recordedTransport.js'
import { REPO_ROOT, createTempDirectory, git } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T040 grammar details beyond the T032 patch-guard suite: the strict one-file grammar rejects
// patch forms that `git apply` would otherwise accept, tolerates harmless formatting, and
// refuses a permitted target reached through a symbolic link in the original-HEAD checkout.

const TARGET = 'apps/demo-chart/src/filterData.ts'
const BUNDLE = parseEvidenceBundle(
  JSON.parse(await readFile(new URL('../fixtures/contracts/evidence-bundle.valid-failure.json', import.meta.url), 'utf8')),
)
if (!BUNDLE.ok) throw new Error('The failure bundle fixture is invalid.')
const FAILURE_BUNDLE = BUNDLE.value
const RECORDED = loadRecordedHeroResponse() as Diagnosis
const SAFE_DIFF = RECORDED.candidate.unified_diff

let checkout: TempDirectory
let smuggled = ''

beforeAll(async () => {
  checkout = await createTempDirectory('flowproof-patch-grammar-')
  const sourceDir = path.join(checkout.path, 'apps/demo-chart/src')
  await mkdir(sourceDir, { recursive: true })
  for (const file of ['data.ts', 'filterData.ts', 'main.ts']) {
    await writeFile(path.join(sourceDir, file), git(REPO_ROOT, 'show', `HEAD:apps/demo-chart/src/${file}`))
  }
  git(checkout.path, 'init', '--quiet')
  git(checkout.path, 'add', '.')
  git(checkout.path, '-c', 'user.email=flowproof@example.invalid', '-c', 'user.name=FlowProof Test', 'commit', '--quiet', '-m', 'baseline')

  // A second file's `---`/`+++`/hunk appended after the permitted hunk, without a `diff --git` line.
  await writeFile(path.join(sourceDir, 'main.ts'), '// candidate edit\n', { flag: 'a' })
  const mainDiff = git(checkout.path, 'diff', 'apps/demo-chart/src/main.ts')
  git(checkout.path, 'reset', '--quiet', '--hard')
  smuggled = SAFE_DIFF + mainDiff.slice(mainDiff.indexOf('--- '))
})

afterAll(async () => {
  await checkout?.remove()
})

async function validate(diff: string, checkoutRoot = checkout.path): Promise<CandidateValidation> {
  const diagnosis = { ...structuredClone(RECORDED), candidate: { ...structuredClone(RECORDED.candidate), unified_diff: diff } }
  return validateCandidate({
    runId: FAILURE_BUNDLE.run_id,
    diagnosis,
    failureBundle: FAILURE_BUNDLE,
    permittedSourcePaths: [TARGET],
    checkoutRoot,
  })
}

describe('patch grammar', () => {
  it.each([
    ['no index line', SAFE_DIFF.replace(/^index .*\n/m, '')],
    ['trailing blank lines', `${SAFE_DIFF}\n\n`],
  ])('accepts a one-file diff with %s', async (_label, diff) => {
    const result = await validate(diff)

    expect(result.scope.status).toBe('pass')
    expect(result.candidate?.unified_diff).toBe(diff)
  })

  it('rejects a second file appended without a diff --git header that git apply would accept', async () => {
    const file = path.join(checkout.path, 'smuggled.patch')
    await writeFile(file, smuggled)
    try {
      expect(git(checkout.path, 'apply', '--numstat', '--check', file).trim().split('\n')).toHaveLength(2)
    } finally {
      await rm(file)
    }

    const result = await validate(smuggled)
    expect(result.scope).toMatchObject({ status: 'fail', reason_code: 'PATCH_MULTI_FILE' })
    expect(result.candidate).toBeNull()
  })

  it.each([
    ['a mode change', SAFE_DIFF.replace(/^index ([0-9a-f]+\.\.[0-9a-f]+) 100644$/m, 'old mode 100644\nnew mode 100755\nindex $1')],
    ['a file creation', SAFE_DIFF.replace(/^index .*\n--- a\/.*$/m, `new file mode 100644\nindex 0000000..31c7332\n--- /dev/null`)],
    ['a hunk whose counts disagree with its lines', SAFE_DIFF.replace('@@ -2,5 +2,5 @@', '@@ -2,4 +2,4 @@')],
    ['carriage returns', SAFE_DIFF.replaceAll('\n', '\r\n')],
  ])('rejects %s', async (_label, diff) => {
    const result = await validate(diff)

    expect(result.scope).toMatchObject({ status: 'fail', reason_code: 'PATCH_GRAMMAR_INVALID' })
    expect(result.candidate).toBeNull()
  })

  it('rejects a permitted target reached through a symbolic link in the checkout', async () => {
    const linked = await createTempDirectory('flowproof-patch-symlink-')
    try {
      const real = path.join(linked.path, 'real-src')
      await mkdir(real, { recursive: true })
      await writeFile(path.join(real, 'filterData.ts'), git(REPO_ROOT, 'show', `HEAD:${TARGET}`))
      await mkdir(path.join(linked.path, 'apps/demo-chart'), { recursive: true })
      await symlink(real, path.join(linked.path, 'apps/demo-chart/src'), 'dir')

      const result = await validate(SAFE_DIFF, linked.path)
      expect(result.scope).toMatchObject({ status: 'fail', reason_code: 'PATCH_SYMLINK' })
      expect(result.candidate).toBeNull()
    } finally {
      await linked.remove()
    }
  })
})
