import { cp, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_LIVE_FIXTURE_DIR,
  REPO_ROOT,
  SEEDED_IGNORED,
  SEEDED_UNTRACKED,
  changedSnapshotFacets,
  loadFixtureManifest,
  materializeProjectLiveRepository,
  snapshotOriginalProject,
  verifyFixtureSources,
} from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { createTempDirectory } from '../support/repoFixture.js'

// T001: the permitted sample materializes as an independent clean Git repository outside this
// checkout, bound to its committed lock, and the original-state snapshot detects every write
// facet a later run could cause. No sample code, install or build runs on the host here.

const owned: Array<{ remove(): Promise<void> }> = []

afterEach(async () => {
  while (owned.length > 0) await owned.pop()?.remove()
})

async function materialize(options: Parameters<typeof materializeProjectLiveRepository>[0] = {}): Promise<MaterializedProjectRepository> {
  const repository = await materializeProjectLiveRepository(options)
  owned.push(repository)
  return repository
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['--no-optional-locks', '-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })

describe('project-live sample fixture', () => {
  it('pins exact React/Vite versions, an integrity-checked public lock, a project check and no expected fix', async () => {
    const manifest = await loadFixtureManifest()
    await verifyFixtureSources({ manifest })
    expect(manifest.dependencies).toEqual({ react: '19.3.1', 'react-dom': '19.3.1', vite: '8.3.5' })
    const sample = path.join(PROJECT_LIVE_FIXTURE_DIR, manifest.sample_directory)
    const lock = JSON.parse(await readFile(path.join(sample, manifest.lock.path), 'utf8')) as {
      lockfileVersion: number
      packages: Record<string, { version?: string; resolved?: string; integrity?: string }>
    }
    expect(lock.lockfileVersion).toBe(3)
    for (const [name, version] of Object.entries(manifest.dependencies)) expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '') continue
      expect(entry.resolved?.startsWith('https://registry.npmjs.org/')).toBe(true)
      expect(entry.integrity).toMatch(/^sha512-/)
    }
    expect(manifest.project_check).toEqual({ id: 'sample-unit', argv: ['node', '--test', 'tests/tasks.test.mjs'] })
    expect(Object.keys(manifest.files)).toContain('tests/tasks.test.mjs')
    // Evaluator notes stay outside the committed sample; no patch or expected-fix file exists.
    expect(Object.keys(manifest.files).some((file) => /readme|expected|fix|patch|\.diff$/i.test(file))).toBe(false)
  })

  it('rejects a sample whose files differ from the fixture lock', async () => {
    const manifest = await loadFixtureManifest()
    const copy = await createTempDirectory('flowproof-fixture-copy-')
    owned.push(copy)
    await cp(path.join(PROJECT_LIVE_FIXTURE_DIR, manifest.sample_directory), copy.path, { recursive: true })
    await writeFile(path.join(copy.path, 'src/App.jsx'), '// altered\n', { flag: 'a' })
    await expect(verifyFixtureSources({ manifest, sampleDir: copy.path })).rejects.toThrow(/FIXTURE_FILE_DIGEST_MISMATCH/)
    await writeFile(path.join(copy.path, 'extra.js'), 'export {}\n')
    await expect(verifyFixtureSources({ manifest, sampleDir: copy.path })).rejects.toThrow(/FIXTURE_FILE_SET_MISMATCH/)
  })

  it('materializes a clean independent repository outside FlowProof with fixed identities', async () => {
    const first = await materialize()
    const second = await materialize()
    const manifest = first.manifest
    for (const repository of [first, second]) {
      expect(repository.root.startsWith(`${REPO_ROOT}/`)).toBe(false)
      expect(git(repository.root, 'rev-parse', '--show-toplevel').trim()).toBe(repository.root)
      expect(repository.head).toBe(manifest.git.commit_oid)
      expect(repository.tree).toBe(manifest.git.tree_oid)
      expect(repository.branch).toBe('main')
      expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')).toBe('')
      expect(git(repository.root, 'ls-files').split('\n').filter(Boolean).sort()).toEqual(Object.keys(manifest.files).sort())
      expect(git(repository.root, 'remote')).toBe('')
      // No template hooks, no FlowProof artifact root, no host dependency links.
      await expect(lstat(path.join(repository.root, '.git/hooks'))).rejects.toThrow()
      expect((await readdir(repository.root)).sort()).toEqual(['.git', '.gitignore', 'index.html', 'package-lock.json', 'package.json', 'src', 'tests', 'vite.config.js'])
    }
    expect(first.root).not.toBe(second.root)
    expect(((await lstat(path.dirname(first.root))).mode & 0o777).toString(8)).toBe('700')
  })

  it('takes a read-only snapshot that detects every original-state facet', async () => {
    const repository = await materialize({ seedIgnored: true })
    const before = await snapshotOriginalProject(repository.root)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    expect(Object.keys(before.ignored).sort()).toEqual([...SEEDED_IGNORED].sort())
    expect(before.untracked).toEqual({})
    expect(before.head).toBe(repository.head)
    expect(before.branch).toBe('refs/heads/main')

    const mutate = async (action: () => Promise<void> | void, expected: readonly string[]): Promise<void> => {
      const prior = await snapshotOriginalProject(repository.root)
      await action()
      const facets = changedSnapshotFacets(prior, await snapshotOriginalProject(repository.root))
      for (const facet of expected) expect(facets).toContain(facet)
    }
    await mutate(() => writeFile(path.join(repository.root, 'src/tasks.js'), '// changed\n', { flag: 'a' }), ['tracked', 'worktree', 'status'])
    await mutate(() => writeFile(path.join(repository.root, 'scratch.txt'), 'note\n'), ['untracked', 'worktree', 'status'])
    await mutate(() => writeFile(path.join(repository.root, 'dist/new-output.txt'), 'ignored\n'), ['ignored', 'worktree'])
    await mutate(() => void git(repository.root, 'add', 'src/tasks.js'), ['index', 'gitDir'])
    await mutate(() => void git(repository.root, 'branch', 'side'), ['refs', 'gitDir'])

    // Re-hashing objects that already exist writes nothing; a new loose object is a Git-directory write.
    const settled = await snapshotOriginalProject(repository.root)
    git(repository.root, 'hash-object', '-w', 'package.json', 'index.html', 'src/main.jsx')
    expect(changedSnapshotFacets(settled, await snapshotOriginalProject(repository.root))).toEqual([])
    execFileSync('git', ['-C', repository.root, 'hash-object', '-w', '--stdin'], { input: 'flowproof new loose object\n', encoding: 'utf8' })
    expect(changedSnapshotFacets(settled, await snapshotOriginalProject(repository.root))).toEqual(['gitDir'])
    await mutate(() => void git(repository.root, 'checkout', '--quiet', 'side'), ['branch', 'gitDir'])
  })

  it('seeds untracked and ignored residue only on request and removes everything it owns', async () => {
    const repository = await materializeProjectLiveRepository({ seedUntracked: true, seedIgnored: true })
    const parent = path.dirname(repository.root)
    const snapshot = await snapshotOriginalProject(repository.root)
    expect(Object.keys(snapshot.untracked)).toEqual([...SEEDED_UNTRACKED])
    expect(Object.keys(snapshot.ignored).sort()).toEqual([...SEEDED_IGNORED].sort())
    expect(repository.seeded).toEqual({ untracked: [...SEEDED_UNTRACKED], ignored: [...SEEDED_IGNORED] })
    await repository.remove()
    await expect(lstat(parent)).rejects.toThrow()
  })
})
