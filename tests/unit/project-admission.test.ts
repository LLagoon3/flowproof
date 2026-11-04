import { mkdir, readFile, symlink, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { admitProject, captureOriginalIntegrity, changedIntegrityFacets, checkProjectBaseline } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject, ProjectAdmission } from '../../packages/flowproof/src/project/admission.js'
import { parseProjectContext } from '../../packages/flowproof/src/project/contracts.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository, MaterializeOptions } from '../helpers/projectLiveRepository.js'
import { commitFiles, testAdmissionProfile, testGit, writeFiles } from '../support/projectSetup.js'

// T010: canonical read-only admission of a selected local project. Every case runs against an
// independent materialized sample repository and proves the original (tracked, untracked, ignored,
// index, refs and the whole Git directory) is byte-for-byte unchanged afterwards, whether the
// admission was accepted or refused. A refused admission returns only fixed reason codes: it hands
// out no admitted project, so nothing downstream can configure, build or call a model for it.

const repositories: MaterializedProjectRepository[] = []

async function sample(options: MaterializeOptions = {}): Promise<MaterializedProjectRepository> {
  const repository = await materializeProjectLiveRepository(options)
  repositories.push(repository)
  return repository
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const repository of repositories.splice(0)) await repository.remove()
})

async function admit(root: string): Promise<ProjectAdmission> {
  return admitProject({ root, profile: await testAdmissionProfile() })
}

function admitted(admission: ProjectAdmission): AdmittedProject {
  if (admission.state !== 'ready') throw new Error(`expected ready admission, got ${admission.reasons.join(',')}`)
  return admission.project
}

/** Admission must refuse with `reason` and leave every facet of the original unchanged. */
async function expectBlocked(root: string, reason: string): Promise<void> {
  const before = await snapshotOriginalProject(root)
  const admission = await admit(root)
  expect(admission.state).toBe('blocked')
  if (admission.state !== 'blocked') return
  expect(admission.reasons).toContain(reason)
  // A refusal carries no admitted project, path or file data: nothing can proceed from it.
  expect(Object.keys(admission).sort()).toEqual(['reasons', 'state'])
  expect(changedSnapshotFacets(before, await snapshotOriginalProject(root))).toEqual([])
}

describe('admitting a clean committed project', () => {
  it('pins the exact committed root, revision, branch, category and manifests without writing to the original', async () => {
    const repository = await sample({ seedIgnored: true })
    const before = await snapshotOriginalProject(repository.root)
    const project = admitted(await admit(repository.root))
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])

    const parsed = parseProjectContext(project.context)
    expect(parsed.ok).toBe(true)
    const { context } = project
    expect(context.baseline_commit).toBe(repository.manifest.git.commit_oid)
    expect(context.branch).toBe('main')
    expect(context.category).toBe('vite-static-v1')
    expect(context.admission).toEqual({ state: 'ready', reasons: [], required_prerequisites: [] })
    expect(context.display_root).toBe(repository.root)
    expect(context.label).toBe(path.basename(repository.root))
    expect(context.profile.lock_sha256).toBe(repository.manifest.lock.sha256)
    expect(project.canonicalRoot).toBe(repository.root)

    // Only non-test text files under src/ are editable; everything else is a protected input.
    expect(context.allowed_source_paths).toEqual(['src/App.jsx', 'src/main.jsx', 'src/tasks.js'])
    const kinds = Object.fromEntries(context.protected_inputs.map((input) => [input.path, input.kind]))
    expect(kinds).toEqual({
      '.gitignore': 'configuration',
      'index.html': 'entry',
      'package-lock.json': 'lock',
      'package.json': 'package',
      'tests/tasks.test.mjs': 'test',
      'vite.config.js': 'configuration',
    })
    for (const input of context.protected_inputs) expect(input.sha256).toBe(repository.manifest.files[input.path]?.sha256)

    // Exactly the committed files: ignored dependencies and build residue are never admitted.
    expect(project.files.map((file) => file.path)).toEqual(Object.keys(repository.manifest.files).sort())
    for (const file of project.files) expect(file.sha256).toBe(repository.manifest.files[file.path]?.sha256)
    expect(project.files.some((file) => file.path.startsWith('node_modules/') || file.path.startsWith('dist/'))).toBe(false)
  })

  it('makes no network or model request while inspecting', async () => {
    const repository = await sample()
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network refused by test')))
    vi.stubGlobal('fetch', fetchSpy)
    admitted(await admit(repository.root))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('canonicalizes a symlinked selection to the real repository root', async () => {
    const repository = await sample()
    const link = path.join(path.dirname(repository.root), 'selected-link')
    await symlink(repository.root, link)
    const project = admitted(await admit(link))
    expect(project.canonicalRoot).toBe(repository.root)
    expect(project.context.display_root).toBe(repository.root)
  })

  it('ignores host Git environment overrides, local hooks and the filesystem monitor', async () => {
    const repository = await sample()
    const marker = path.join(path.dirname(repository.root), 'git-side-effect')
    const script = path.join(path.dirname(repository.root), 'monitor.sh')
    await writeFile(script, `#!/bin/sh\necho ran >> ${marker}\n`)
    await chmod(script, 0o755)
    const hooks = path.join(path.dirname(repository.root), 'hooks')
    await mkdir(hooks)
    for (const hook of ['post-index-change', 'reference-transaction', 'post-checkout']) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\necho hook >> ${marker}\n`)
      await chmod(path.join(hooks, hook), 0o755)
    }
    await testGit(repository.root, ['config', 'core.fsmonitor', script])
    await testGit(repository.root, ['config', 'core.hooksPath', hooks])
    const decoy = await sample()
    const globalConfig = path.join(path.dirname(repository.root), 'global.gitconfig')
    await writeFile(globalConfig, `[core]\n\tfsmonitor = ${script}\n`)
    vi.stubEnv('GIT_DIR', path.join(decoy.root, '.git'))
    vi.stubEnv('GIT_WORK_TREE', decoy.root)
    vi.stubEnv('GIT_INDEX_FILE', path.join(decoy.root, '.git/index'))
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)

    const before = await snapshotOriginalProject(repository.root)
    const project = admitted(await admit(repository.root))
    expect(project.canonicalRoot).toBe(repository.root)
    expect(project.context.baseline_commit).toBe(repository.head)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('refusing selections before any command or model call', () => {
  it('refuses relative, missing, non-directory and non-repository paths', async () => {
    const repository = await sample()
    expect(await admit('relative/path')).toEqual({ state: 'blocked', reasons: ['PROJECT_PATH_INVALID'] })
    expect(await admit(path.join(repository.root, 'missing'))).toEqual({ state: 'blocked', reasons: ['PROJECT_PATH_INVALID'] })
    expect(await admit(path.join(repository.root, 'package.json'))).toEqual({ state: 'blocked', reasons: ['PROJECT_PATH_INVALID'] })
    expect(await admit(tmpdir())).toEqual({ state: 'blocked', reasons: ['PROJECT_NOT_GIT_ROOT'] })
  })

  it('refuses a nested path inside a repository instead of widening it to the top level', async () => {
    const repository = await sample()
    await expectBlocked(path.join(repository.root, 'src'), 'PROJECT_NOT_GIT_ROOT')
  })

  it('refuses modified, deleted, mode-changed and staged tracked content', async () => {
    const modified = await sample()
    await writeFiles(modified.root, { 'src/tasks.js': '// changed\n' })
    await expectBlocked(modified.root, 'PROJECT_TRACKED_CHANGES')

    const deleted = await sample()
    await writeFiles(deleted.root, { 'vite.config.js': null })
    await expectBlocked(deleted.root, 'PROJECT_TRACKED_CHANGES')

    const mode = await sample()
    await chmod(path.join(mode.root, 'src/main.jsx'), 0o755)
    await expectBlocked(mode.root, 'PROJECT_TRACKED_CHANGES')

    // Staged but restored in the working tree: the index no longer matches the committed tree.
    const staged = await sample()
    const original = await readFile(path.join(staged.root, 'src/tasks.js'))
    await writeFiles(staged.root, { 'src/tasks.js': '// staged\n' })
    await testGit(staged.root, ['add', 'src/tasks.js'])
    await writeFiles(staged.root, { 'src/tasks.js': original })
    await expectBlocked(staged.root, 'PROJECT_STAGED_CHANGES')
  })

  it('refuses untracked content but permits ignored dependencies and build output', async () => {
    const untracked = await sample({ seedUntracked: true })
    await expectBlocked(untracked.root, 'PROJECT_UNTRACKED_FILES')
    const ignored = await sample({ seedIgnored: true })
    expect((await admit(ignored.root)).state).toBe('ready')
  })

  it('refuses committed symlinks and gitlinks', async () => {
    const link = await sample()
    await commitFiles(link.root, { 'src/alias.js': { symlink: 'tasks.js' } })
    await expectBlocked(link.root, 'PROJECT_SYMLINK_TRACKED')

    const gitlink = await sample()
    await testGit(gitlink.root, ['update-index', '--add', '--cacheinfo', `160000,${gitlink.head},vendor/library`])
    await testGit(gitlink.root, ['commit', '--quiet', '--no-verify', '--message', 'Add gitlink'])
    await expectBlocked(gitlink.root, 'PROJECT_GITLINK_TRACKED')
  })

  it('refuses committed secret files and secret-shaped source content', async () => {
    const environment = await sample()
    await commitFiles(environment.root, { '.env': 'FEATURE_FLAG=on\n' })
    await expectBlocked(environment.root, 'PROJECT_SECRET_FILE')

    const key = await sample()
    await commitFiles(key.root, { 'config/deploy.pem': 'not a real key\n' })
    await expectBlocked(key.root, 'PROJECT_SECRET_FILE')

    const content = await sample()
    await commitFiles(content.root, { 'src/client.js': 'export const apiKey = "sk-test0123456789abcdefghij"\n' })
    await expectBlocked(content.root, 'PROJECT_SECRET_CONTENT')
  })

  it('refuses unsupported layouts and repository attributes', async () => {
    const yarn = await sample()
    await commitFiles(yarn.root, { 'yarn.lock': '# yarn\n' })
    await expectBlocked(yarn.root, 'PROJECT_LAYOUT_UNSUPPORTED')

    const nested = await sample()
    await commitFiles(nested.root, { 'packages/widget/package.json': '{"name":"widget"}\n' })
    await expectBlocked(nested.root, 'PROJECT_LAYOUT_UNSUPPORTED')

    const noEntry = await sample()
    await commitFiles(noEntry.root, { 'index.html': null })
    await expectBlocked(noEntry.root, 'PROJECT_LAYOUT_UNSUPPORTED')

    const vendored = await sample()
    await commitFiles(vendored.root, { 'node_modules/react/index.js': 'module.exports = {}\n' })
    await expectBlocked(vendored.root, 'PROJECT_LAYOUT_UNSUPPORTED')

    const attributes = await sample()
    await commitFiles(attributes.root, { '.gitattributes': '*.js filter=lfs\n' })
    await expectBlocked(attributes.root, 'PROJECT_GIT_ATTRIBUTES_UNSUPPORTED')

    const spaced = await sample()
    await commitFiles(spaced.root, { 'src/my file.js': 'export {}\n' })
    await expectBlocked(spaced.root, 'PROJECT_PATH_UNSUPPORTED')
  })

  it('refuses a missing or changed lock and package dependencies that differ from the lock', async () => {
    const missing = await sample()
    await commitFiles(missing.root, { 'package-lock.json': null })
    await expectBlocked(missing.root, 'PROJECT_LOCK_MISSING')

    const changedLock = await sample()
    const lock = JSON.parse(await readFile(path.join(changedLock.root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    lock.packages['node_modules/react']!.version = '19.3.0'
    await commitFiles(changedLock.root, { 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` })
    await expectBlocked(changedLock.root, 'PROJECT_LOCK_MISMATCH')

    const changedPackage = await sample()
    const manifest = JSON.parse(await readFile(path.join(changedPackage.root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['left-pad'] = '1.3.0'
    await commitFiles(changedPackage.root, { 'package.json': `${JSON.stringify(manifest, null, 2)}\n` })
    await expectBlocked(changedPackage.root, 'PROJECT_PACKAGE_MISMATCH')

    const workspaces = await sample()
    const withWorkspaces = JSON.parse(await readFile(path.join(workspaces.root, 'package.json'), 'utf8')) as Record<string, unknown>
    withWorkspaces.workspaces = ['packages/*']
    await commitFiles(workspaces.root, { 'package.json': `${JSON.stringify(withWorkspaces, null, 2)}\n` })
    await expectBlocked(workspaces.root, 'PROJECT_LAYOUT_UNSUPPORTED')
  })
})

describe('detecting a stale baseline without refreshing it', () => {
  it('reports a new commit, a dirty tree, a lock change and a config change as stale and keeps the admitted identity', async () => {
    const profile = await testAdmissionProfile()
    const commit = await sample()
    const project = admitted(await admit(commit.root))
    const identity = structuredClone(project.context)
    expect(await checkProjectBaseline(project, profile)).toEqual({ state: 'ready' })

    await commitFiles(commit.root, { 'src/tasks.js': '// next revision\n' })
    const first = await checkProjectBaseline(project, profile)
    expect(first.state).toBe('stale')
    if (first.state === 'stale') expect(first.reasons).toContain('PROJECT_BASELINE_CHANGED')
    // Repeated checks stay stale: the admitted baseline is never silently replaced.
    expect((await checkProjectBaseline(project, profile)).state).toBe('stale')
    expect(project.context).toEqual(identity)

    const dirty = await sample()
    const dirtyProject = admitted(await admit(dirty.root))
    await writeFiles(dirty.root, { 'src/App.jsx': '// edited\n' })
    const dirtyCheck = await checkProjectBaseline(dirtyProject, profile)
    expect(dirtyCheck).toMatchObject({ state: 'stale' })
    if (dirtyCheck.state === 'stale') expect(dirtyCheck.reasons).toContain('PROJECT_TRACKED_CHANGES')

    const config = await sample()
    const configProject = admitted(await admit(config.root))
    await commitFiles(config.root, { 'vite.config.js': "export default { build: { outDir: 'dist' } }\n" })
    expect((await checkProjectBaseline(configProject, profile)).state).toBe('stale')

    const lockProfile = await testAdmissionProfile({ lock_sha256: 'd'.repeat(64) })
    const lock = await sample()
    const lockProject = admitted(await admit(lock.root))
    const lockCheck = await checkProjectBaseline(lockProject, lockProfile)
    expect(lockCheck.state).toBe('stale')
    if (lockCheck.state === 'stale') expect(lockCheck.reasons).toContain('PROJECT_LOCK_MISMATCH')
  })
})

describe('original integrity snapshot', () => {
  it('detects index, ref, tracked and untracked changes and nothing on an untouched original', async () => {
    const repository = await sample({ seedIgnored: true })
    const project = admitted(await admit(repository.root))
    const again = await captureOriginalIntegrity(project.canonicalRoot, project.gitDir)
    expect(changedIntegrityFacets(project.integrity, again)).toEqual([])
    expect(again.sha256).toBe(project.integrity.sha256)

    await testGit(repository.root, ['update-ref', 'refs/heads/other', 'HEAD'])
    expect(changedIntegrityFacets(project.integrity, await captureOriginalIntegrity(project.canonicalRoot, project.gitDir))).toContain('refs')

    await writeFiles(repository.root, { 'notes.txt': 'new\n' })
    expect(changedIntegrityFacets(project.integrity, await captureOriginalIntegrity(project.canonicalRoot, project.gitDir))).toContain('untracked')

    await writeFiles(repository.root, { 'src/tasks.js': '// edit\n' })
    await testGit(repository.root, ['add', 'src/tasks.js'])
    const changed = changedIntegrityFacets(project.integrity, await captureOriginalIntegrity(project.canonicalRoot, project.gitDir))
    expect(changed).toEqual(expect.arrayContaining(['index', 'tracked']))
  })
})
