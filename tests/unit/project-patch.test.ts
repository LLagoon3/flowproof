import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { admitProjectPatch, applyProjectPatch } from '../../packages/flowproof/src/patch/projectDiff.js'
import type { PatchAdmission, PatchProposal } from '../../packages/flowproof/src/patch/projectDiff.js'
import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { PROJECT_LIMITS, newProjectUuid, parseCandidate } from '../../packages/flowproof/src/project/contracts.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { commitFiles, testAdmissionProfile } from '../support/projectSetup.js'

// T035: the bounded multi-file candidate guard and its copy-only application. A candidate is
// `proposed` only after strict UTF-8 diff/path/target checks; it becomes `applied-to-copy` only in a
// new owned baseline copy with private Git metadata, applied exactly once; anything else is
// `rejected` with fixed reasons. Every case proves zero writes to the original, including its Git
// object database, whether the candidate was applied or refused.

const repositories: MaterializedProjectRepository[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const repository of repositories.splice(0)) await repository.remove()
})

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function project(changes?: Readonly<Record<string, string | null>>): Promise<{ repository: MaterializedProjectRepository; project: AdmittedProject }> {
  const repository = await materializeProjectLiveRepository()
  repositories.push(repository)
  if (changes) await commitFiles(repository.root, changes)
  const admission = await admitProject({ root: repository.root, profile: await testAdmissionProfile() })
  if (admission.state !== 'ready') throw new Error(`fixture admission failed: ${admission.reasons.join(',')}`)
  return { repository, project: admission.project }
}

async function content(repository: MaterializedProjectRepository, file: string): Promise<string> {
  return readFile(path.join(repository.root, file), 'utf8')
}

/** One hunk replacing line `line` (1-based) of `text` with `replacement`, with three context lines. */
function hunk(text: string, line: number, replacement: readonly string[], options: { readonly shift?: number } = {}): string {
  const lines = text.replace(/\n$/, '').split('\n')
  const index = line - 1
  const start = Math.max(0, index - 3)
  const end = Math.min(lines.length, index + 4)
  const before = lines.slice(start, index)
  const after = lines.slice(index + 1, end)
  const header = `@@ -${start + 1 + (options.shift ?? 0)},${before.length + 1 + after.length} +${start + 1 + (options.shift ?? 0)},${before.length + replacement.length + after.length} @@`
  return [header, ...before.map((entry) => ` ${entry}`), `-${lines[index]}`, ...replacement.map((entry) => `+${entry}`), ...after.map((entry) => ` ${entry}`)].join('\n') + '\n'
}

function fileDiff(file: string, body: string, extraHeader = ''): string {
  return `diff --git a/${file} b/${file}\n${extraHeader}--- a/${file}\n+++ b/${file}\n${body}`
}

function proposal(target: AdmittedProject, patch: string | Uint8Array, targetPaths: readonly string[], overrides: Partial<PatchProposal> = {}): PatchProposal {
  return {
    runId: newProjectUuid(),
    definitionId: newProjectUuid(),
    definitionDigest: 'e'.repeat(64),
    invocationId: newProjectUuid(),
    baselineCommit: target.context.baseline_commit,
    targetPaths,
    patch,
    ...overrides,
  }
}

function reasonsOf(admission: PatchAdmission): readonly string[] {
  return admission.state === 'rejected' ? admission.reasons : []
}

/** A refused candidate never yields an applicable proposal and keeps the original untouched. */
async function expectRejected(repository: MaterializedProjectRepository, target: AdmittedProject, patch: string | Uint8Array, paths: readonly string[], reason: string): Promise<void> {
  const before = await snapshotOriginalProject(repository.root)
  const admission = admitProjectPatch(target, proposal(target, patch, paths))
  expect(admission.state).toBe('rejected')
  expect(reasonsOf(admission)).toContain(reason)
  if (admission.state === 'rejected' && admission.candidate !== null) {
    expect(parseCandidate(admission.candidate).ok).toBe(true)
    expect(admission.candidate.state).toBe('rejected')
  }
  expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
}

describe('a valid bounded candidate', () => {
  it('is proposed, then applied exactly once to a new owned copy with exact hashes and no original writes', async () => {
    const { repository, project: target } = await project()
    const app = await content(repository, 'src/App.jsx')
    const patch = fileDiff('src/App.jsx', hunk(app, 6, ["  if (filter === 'open') return !task.done"]))
    const before = await snapshotOriginalProject(repository.root)

    const admission = admitProjectPatch(target, proposal(target, patch, ['src/App.jsx']))
    expect(admission.state).toBe('proposed')
    if (admission.state !== 'proposed') return
    const proposed = parseCandidate(admission.candidate)
    expect(proposed.ok).toBe(true)
    expect(admission.candidate).toMatchObject({
      state: 'proposed',
      baseline_commit: repository.head,
      changed_paths: ['src/App.jsx'],
      patch_sha256: sha256(patch),
      patch_bytes: Buffer.byteLength(patch),
      expected_tree_sha256: null,
      build_sha256: null,
      rejection_reasons: [],
    })

    const application = await applyProjectPatch(target, admission)
    expect(application.state).toBe('applied-to-copy')
    if (application.state !== 'applied-to-copy') return
    cleanups.push(() => application.copy.remove())
    expect(parseCandidate(application.candidate).ok).toBe(true)
    expect(application.candidate.candidate_id).toBe(admission.candidate.candidate_id)
    expect(application.candidate.expected_tree_sha256).toBe(application.treeSha256)
    expect(application.treeSha256).not.toBe(target.context.admitted_tree_sha256)

    // The copy holds exactly the admitted tree with the one change; no Git metadata is in it.
    const workspace = application.copy.workspace
    const expected = app.replace("  if (filter === 'open') return task.done", "  if (filter === 'open') return !task.done")
    expect(await readFile(path.join(workspace, 'src/App.jsx'), 'utf8')).toBe(expected)
    for (const file of target.files.filter((entry) => entry.path !== 'src/App.jsx')) {
      expect(sha256(await readFile(path.join(workspace, file.path)))).toBe(file.sha256)
    }
    expect(await readdir(workspace)).not.toContain('.git')
    const changed = application.files.find((file) => file.path === 'src/App.jsx')
    expect(changed?.sha256).toBe(sha256(expected))
    expect((await application.copy.verify(application.files)).ok).toBe(true)
    expect((await application.copy.verify()).ok).toBe(true)

    // Private metadata lives outside the workspace that a runtime mounts.
    expect(application.copy.privateDir.startsWith(application.copy.root)).toBe(true)
    expect(application.copy.privateDir.startsWith(workspace)).toBe(false)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])

    // Exactly once: the same proposal cannot be applied again.
    const again = await applyProjectPatch(target, admission)
    expect(again.state).toBe('rejected')
    if (again.state === 'rejected') expect(again.reasons).toEqual(['PATCH_ALREADY_APPLIED'])

    const root = application.copy.root
    await application.copy.remove()
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts up to eight existing source files and a 64 KiB patch, and refuses one more of either', async () => {
    const extra = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`src/extra-${index}.js`, `export const value${index} = ${index}\n`]))
    const { repository, project: target } = await project(extra)
    const files = [...target.context.allowed_source_paths]
    expect(files).toHaveLength(9)
    const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await content(repository, file)] as const)))
    const diffFor = (file: string): string => fileDiff(file, hunk(sources[file]!, 1, [`${sources[file]!.split('\n')[0]} // reviewed`]))

    const eight = files.slice(0, PROJECT_LIMITS.maxPatchFiles)
    const accepted = admitProjectPatch(target, proposal(target, eight.map(diffFor).join(''), eight))
    expect(accepted.state).toBe('proposed')
    const application = await applyProjectPatch(target, accepted)
    expect(application.state).toBe('applied-to-copy')
    if (application.state === 'applied-to-copy') cleanups.push(() => application.copy.remove())

    await expectRejected(repository, target, files.map(diffFor).join(''), files, 'PATCH_TOO_MANY_FILES')

    // One long added comment line: exactly at the byte bound is accepted, one byte more is not.
    const base = fileDiff('src/tasks.js', hunk(sources['src/tasks.js']!, 1, ['// ', sources['src/tasks.js']!.split('\n')[0]!]))
    const padding = PROJECT_LIMITS.maxPatchBytes - Buffer.byteLength(base)
    const atLimit = base.replace('+// \n', `+// ${'x'.repeat(padding)}\n`)
    expect(Buffer.byteLength(atLimit)).toBe(PROJECT_LIMITS.maxPatchBytes)
    expect(admitProjectPatch(target, proposal(target, atLimit, ['src/tasks.js'])).state).toBe('proposed')
    await expectRejected(repository, target, atLimit.replace('+// ', '+//  '), ['src/tasks.js'], 'PATCH_TOO_LARGE')
  })
})

describe('refusing out-of-scope candidates before anything is applied', () => {
  it('refuses protected configuration, package, lock, entry and test inputs', async () => {
    const { repository, project: target } = await project({ 'src/tasks.test.js': "import './tasks.js'\n" })
    for (const file of ['package.json', 'package-lock.json', 'vite.config.js', 'index.html', 'tests/tasks.test.mjs', '.gitignore', 'src/tasks.test.js']) {
      const text = await content(repository, file)
      await expectRejected(repository, target, fileDiff(file, hunk(text, 1, [`${text.split('\n')[0]} `])), [file], 'PATCH_PATH_PROTECTED')
    }
  })

  it('refuses traversal, absolute, quoted, mismatched and unknown paths', async () => {
    const { repository, project: target } = await project()
    const app = await content(repository, 'src/App.jsx')
    const body = hunk(app, 6, ["  if (filter === 'open') return !task.done"])
    await expectRejected(repository, target, fileDiff('src/../package.json', body), ['src/../package.json'], 'PATCH_PATH_INVALID')
    await expectRejected(repository, target, `diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n${body}`, ['/etc/passwd'], 'PATCH_PATH_INVALID')
    await expectRejected(repository, target, `diff --git "a/src/App.jsx" "b/src/App.jsx"\n--- "a/src/App.jsx"\n+++ "b/src/App.jsx"\n${body}`, ['src/App.jsx'], 'PATCH_PATH_INVALID')
    await expectRejected(repository, target, `diff --git a/src/App.jsx b/src/tasks.js\n--- a/src/App.jsx\n+++ b/src/tasks.js\n${body}`, ['src/App.jsx'], 'PATCH_PATH_INVALID')
    await expectRejected(repository, target, fileDiff('src/Missing.jsx', body), ['src/Missing.jsx'], 'PATCH_PATH_NOT_ADMITTED')
    // The declared target paths must be exactly the changed paths.
    await expectRejected(repository, target, fileDiff('src/App.jsx', body), ['src/App.jsx', 'src/tasks.js'], 'PATCH_TARGETS_MISMATCH')
    await expectRejected(repository, target, fileDiff('src/App.jsx', body) + fileDiff('src/App.jsx', body), ['src/App.jsx'], 'PATCH_DUPLICATE_FILE')
  })

  it('refuses binary, mode, link, creation, deletion, rename and copy changes', async () => {
    const { repository, project: target } = await project()
    const app = await content(repository, 'src/App.jsx')
    const body = hunk(app, 6, ["  if (filter === 'open') return !task.done"])
    const header = (lines: string): string => `diff --git a/src/App.jsx b/src/App.jsx\n${lines}`
    await expectRejected(repository, target, header('Binary files a/src/App.jsx and b/src/App.jsx differ\n'), ['src/App.jsx'], 'PATCH_BINARY')
    await expectRejected(repository, target, header('GIT binary patch\nliteral 1\nKc${0}\n\n'), ['src/App.jsx'], 'PATCH_BINARY')
    await expectRejected(repository, target, fileDiff('src/App.jsx', body, 'old mode 100644\nnew mode 100755\n'), ['src/App.jsx'], 'PATCH_MODE_CHANGE')
    await expectRejected(repository, target, fileDiff('src/App.jsx', body, 'index 1111111..2222222 120000\n'), ['src/App.jsx'], 'PATCH_MODE_CHANGE')
    await expectRejected(repository, target, `diff --git a/src/New.jsx b/src/New.jsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/New.jsx\n@@ -0,0 +1 @@\n+export {}\n`, ['src/New.jsx'], 'PATCH_FILE_CREATE')
    await expectRejected(repository, target, `diff --git a/src/App.jsx b/src/App.jsx\ndeleted file mode 100644\n--- a/src/App.jsx\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`, ['src/App.jsx'], 'PATCH_FILE_DELETE')
    await expectRejected(repository, target, `diff --git a/src/App.jsx b/src/Board.jsx\nsimilarity index 100%\nrename from src/App.jsx\nrename to src/Board.jsx\n`, ['src/App.jsx'], 'PATCH_RENAME')
    await expectRejected(repository, target, `diff --git a/src/App.jsx b/src/Board.jsx\nsimilarity index 100%\ncopy from src/App.jsx\ncopy to src/Board.jsx\n`, ['src/App.jsx'], 'PATCH_RENAME')
  })

  it('refuses empty, non-UTF-8, NUL-bearing, secret-bearing, malformed and wrong-baseline patches', async () => {
    const { repository, project: target } = await project()
    const app = await content(repository, 'src/App.jsx')
    await expectRejected(repository, target, '', ['src/App.jsx'], 'PATCH_EMPTY')
    const valid = fileDiff('src/App.jsx', hunk(app, 6, ["  if (filter === 'open') return !task.done"]))
    await expectRejected(repository, target, Buffer.concat([Buffer.from(valid), Buffer.from([0xff, 0xfe, 0x0a])]), ['src/App.jsx'], 'PATCH_ENCODING_INVALID')
    await expectRejected(repository, target, valid.replace('!task.done', '!task.done\u0000'), ['src/App.jsx'], 'PATCH_ENCODING_INVALID')
    await expectRejected(repository, target, fileDiff('src/App.jsx', hunk(app, 6, ['  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123"'])), ['src/App.jsx'], 'PATCH_SECRET_CONTENT')
    await expectRejected(repository, target, valid.replace('@@ -3,7 +3,7 @@', '@@ -3,9 +3,7 @@'), ['src/App.jsx'], 'PATCH_MALFORMED')
    await expectRejected(repository, target, 'not a diff\n', ['src/App.jsx'], 'PATCH_MALFORMED')
    const wrongBaseline = admitProjectPatch(target, proposal(target, valid, ['src/App.jsx'], { baselineCommit: 'f'.repeat(40) }))
    expect(reasonsOf(wrongBaseline)).toContain('PATCH_BASELINE_MISMATCH')
  })
})

describe('exact application without partial apply or repair', () => {
  it('refuses a hunk whose context does not match the baseline exactly, even at a shifted offset, and keeps no partial copy', async () => {
    const { repository, project: target } = await project()
    const app = await content(repository, 'src/App.jsx')
    const tasks = await content(repository, 'src/tasks.js')
    const before = await snapshotOriginalProject(repository.root)

    const good = fileDiff('src/tasks.js', hunk(tasks, 1, ['// Synthetic sample data (reviewed).']))
    const stale = fileDiff('src/App.jsx', hunk(app, 6, ["  if (filter === 'open') return !task.done"]).replace(" function isVisible(task, filter) {", ' function isVisible(item, filter) {'))
    const mixed = admitProjectPatch(target, proposal(target, good + stale, ['src/tasks.js', 'src/App.jsx']))
    expect(mixed.state).toBe('proposed')
    const refused = await applyProjectPatch(target, mixed)
    expect(refused.state).toBe('rejected')
    if (refused.state === 'rejected') {
      expect(refused.reasons).toContain('PATCH_CONTEXT_MISMATCH')
      expect(refused.candidate?.state).toBe('rejected')
      expect(parseCandidate(refused.candidate).ok).toBe(true)
    }

    // Correct lines at a shifted position: Git would apply this with an offset; the guard does not.
    const shifted = admitProjectPatch(target, proposal(target, fileDiff('src/App.jsx', hunk(app, 6, ["  if (filter === 'open') return !task.done"], { shift: 2 })), ['src/App.jsx']))
    expect(shifted.state).toBe('proposed')
    const offset = await applyProjectPatch(target, shifted)
    expect(offset.state).toBe('rejected')
    if (offset.state === 'rejected') expect(offset.reasons).toContain('PATCH_CONTEXT_MISMATCH')
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
  })

  it('refuses a candidate whose result would no longer be UTF-8 text', async () => {
    const { repository, project: target } = await project()
    const tasks = await content(repository, 'src/tasks.js')
    await expectRejected(repository, target, fileDiff('src/tasks.js', hunk(tasks, 1, ['\u0007 bell'])), ['src/tasks.js'], 'PATCH_ENCODING_INVALID')
  })
})
