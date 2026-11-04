import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { PROJECT_LIVE_FIXTURE_DIR, loadFixtureManifest } from '../helpers/projectLiveRepository.js'

// Shared S2 (Spec 006 T010–T020, T035, T039) test support: isolated Git edits on a materialized
// sample repository, the operator runtime manifest location, and Docker ownership queries. Git
// runs without global/system configuration, hooks or filesystem monitor; edits are made only by
// the tests, never by the code under test.

const run = promisify(execFile)

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'FlowProof Test',
  GIT_AUTHOR_EMAIL: 'test@flowproof.invalid',
  GIT_AUTHOR_DATE: '2026-11-04T01:00:00+00:00',
  GIT_COMMITTER_NAME: 'FlowProof Test',
  GIT_COMMITTER_EMAIL: 'test@flowproof.invalid',
  GIT_COMMITTER_DATE: '2026-11-04T01:00:00+00:00',
}

/** Test-owned Git write in a materialized sample; never used by production code. */
export async function testGit(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

export type FileChange = string | Buffer | null | { readonly symlink: string }

/** Writes (or removes, for null) files in the working tree without committing. */
export async function writeFiles(root: string, changes: Readonly<Record<string, FileChange>>): Promise<void> {
  for (const [relative, content] of Object.entries(changes)) {
    const target = path.join(root, relative)
    if (content === null) {
      await rm(target, { force: true, recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    if (typeof content === 'object' && !Buffer.isBuffer(content)) {
      await rm(target, { force: true })
      await symlink(content.symlink, target)
    } else {
      await writeFile(target, content)
      await chmod(target, 0o644)
    }
  }
}

/** Applies the changes and commits them on the current branch; returns the new HEAD. */
export async function commitFiles(root: string, changes: Readonly<Record<string, FileChange>>, message = 'Test change'): Promise<string> {
  await writeFiles(root, changes)
  await testGit(root, ['add', '--all', '--force', '--', ...Object.keys(changes)])
  await testGit(root, ['commit', '--quiet', '--no-verify', '--allow-empty', '--message', message])
  return (await testGit(root, ['rev-parse', 'HEAD'])).trim()
}

/** The operator runtime manifest: an explicit environment path, else the prepare script's default. */
export function runtimeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLOWPROOF_PROJECT_PROFILE_MANIFEST) return env.FLOWPROOF_PROJECT_PROFILE_MANIFEST
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir(), '.local/state')
  return path.join(state, 'flowproof/runtime-profiles/vite-static-v1.json')
}

/** The sample's confirmed settings from the committed fixture lock (an external config file shape). */
export async function sampleConfigFile(): Promise<Record<string, unknown>> {
  const fixture = await loadFixtureManifest()
  return {
    schema_version: 1,
    category: 'vite-static-v1',
    entry_path: fixture.entry_path,
    build: { argv: [...fixture.build.argv], output_directory: fixture.build.output_directory },
    required_project_checks: [{ id: fixture.project_check.id, argv: [...fixture.project_check.argv] }],
  }
}

export { PROJECT_LIVE_FIXTURE_DIR }

/** Container IDs (all states) that carry `label` (optionally with an exact value). */
export async function containersWithLabel(label: string, value?: string): Promise<string[]> {
  const filter = value === undefined ? label : `${label}=${value}`
  const { stdout } = await run('docker', ['ps', '-a', '--no-trunc', '--filter', `label=${filter}`, '--format', '{{.ID}}'], { encoding: 'utf8' })
  return stdout.split('\n').filter(Boolean).sort()
}

/** Every container ID on the host, for before/after ownership comparison. */
export async function allContainerIds(): Promise<string[]> {
  const { stdout } = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'], { encoding: 'utf8' })
  return stdout.split('\n').filter(Boolean).sort()
}

/** Test-only identities for admission unit tests: the fixture lock plus labelled non-image IDs. */
export async function testAdmissionProfile(overrides: Partial<Record<string, string>> = {}) {
  const fixture = await loadFixtureManifest()
  return {
    profile_id: 'vite-static-v1' as const,
    image_id: `sha256:${'a'.repeat(64)}`,
    dependency_tree_sha256: 'b'.repeat(64),
    manifest_sha256: 'c'.repeat(64),
    lock_sha256: fixture.lock.sha256,
    ...overrides,
  }
}
