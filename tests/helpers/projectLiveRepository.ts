import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// T001: materializes the permitted synthetic project-live sample as a clean, independent Git
// repository outside this checkout, and records exact original-repository snapshots. The sample
// files are copied only after their committed lock manifest verifies; nothing in the sample is
// executed on the host. Git runs without a shell, global/system configuration, hooks, templates,
// filesystem monitor or optional index locks, so taking a snapshot never writes to the original.

const run = promisify(execFile)

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
export const PROJECT_LIVE_FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/project-live')
export const PROJECT_LIVE_MANIFEST_PATH = path.join(PROJECT_LIVE_FIXTURE_DIR, 'fixture.json')

const SHA256 = /^[a-f0-9]{64}$/
const GIT_OID = /^[a-f0-9]{40}$/
const SAMPLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/

export interface FixtureFile {
  readonly sha256: string
  readonly mode: '100644'
}

export interface ProjectLiveFixtureManifest {
  readonly schema_version: 1
  readonly fixture_id: string
  readonly category: 'vite-static-v1'
  readonly sample_directory: string
  readonly files: Readonly<Record<string, FixtureFile>>
  readonly lock: { readonly path: string; readonly sha256: string }
  readonly dependencies: Readonly<Record<string, string>>
  readonly project_check: { readonly id: string; readonly argv: readonly string[] }
  readonly build: { readonly argv: readonly string[]; readonly output_directory: string }
  readonly entry_path: string
  readonly git: {
    readonly initial_branch: string
    readonly author_name: string
    readonly author_email: string
    readonly date: string
    readonly message: string
    readonly tree_oid: string
    readonly commit_oid: string
  }
}

export class FixtureLockError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FixtureLockError'
  }
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function exactKeys(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new FixtureLockError('FIXTURE_MANIFEST_INVALID', `The fixture manifest field ${field} has unexpected keys.`)
  }
  return value
}

/** Reads and strictly validates the committed fixture lock manifest. */
export async function loadFixtureManifest(manifestPath = PROJECT_LIVE_MANIFEST_PATH): Promise<ProjectLiveFixtureManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const top = exactKeys(
    parsed,
    ['schema_version', 'fixture_id', 'category', 'sample_directory', 'files', 'lock', 'dependencies', 'project_check', 'build', 'entry_path', 'git'],
    'manifest',
  )
  const invalid = (field: string): FixtureLockError => new FixtureLockError('FIXTURE_MANIFEST_INVALID', `The fixture manifest field ${field} is invalid.`)
  if (top.schema_version !== 1) throw invalid('schema_version')
  if (top.category !== 'vite-static-v1') throw invalid('category')
  if (typeof top.sample_directory !== 'string' || !SAMPLE_PATH.test(top.sample_directory)) throw invalid('sample_directory')
  if (!isRecord(top.files) || Object.keys(top.files).length === 0) throw invalid('files')
  for (const [file, entry] of Object.entries(top.files)) {
    const fields = exactKeys(entry, ['sha256', 'mode'], `files.${file}`)
    if (!SAMPLE_PATH.test(file) || file.split('/')[0] === '.git') throw invalid('files')
    if (typeof fields.sha256 !== 'string' || !SHA256.test(fields.sha256) || fields.mode !== '100644') throw invalid(`files.${file}`)
  }
  const lock = exactKeys(top.lock, ['path', 'sha256'], 'lock')
  if (typeof lock.path !== 'string' || !(lock.path in top.files)) throw invalid('lock.path')
  if ((top.files[lock.path] as FixtureFile).sha256 !== lock.sha256) throw invalid('lock.sha256')
  const gitFields = exactKeys(top.git, ['initial_branch', 'author_name', 'author_email', 'date', 'message', 'tree_oid', 'commit_oid'], 'git')
  if (typeof gitFields.tree_oid !== 'string' || !GIT_OID.test(gitFields.tree_oid)) throw invalid('git.tree_oid')
  if (typeof gitFields.commit_oid !== 'string' || !GIT_OID.test(gitFields.commit_oid)) throw invalid('git.commit_oid')
  exactKeys(top.project_check, ['id', 'argv'], 'project_check')
  exactKeys(top.build, ['argv', 'output_directory'], 'build')
  return parsed as ProjectLiveFixtureManifest
}

async function listRegularFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) found.push(child)
      else throw new FixtureLockError('FIXTURE_ENTRY_UNSUPPORTED', 'The sample contains a non-regular entry.')
    }
  }
  await walk('')
  return found.sort()
}

/**
 * Verifies that the sample directory holds exactly the manifest's files with their recorded
 * SHA-256 digests: no file is missing, extra, altered or a non-regular entry.
 */
export async function verifyFixtureSources(options: { readonly manifest?: ProjectLiveFixtureManifest; readonly sampleDir?: string } = {}): Promise<void> {
  const manifest = options.manifest ?? (await loadFixtureManifest())
  const sampleDir = options.sampleDir ?? path.join(PROJECT_LIVE_FIXTURE_DIR, manifest.sample_directory)
  const expected = Object.keys(manifest.files).sort()
  const actual = await listRegularFiles(sampleDir)
  if (actual.join('\0') !== expected.join('\0')) {
    throw new FixtureLockError('FIXTURE_FILE_SET_MISMATCH', 'The sample file set differs from the fixture manifest.')
  }
  for (const file of expected) {
    const bytes = await readFile(path.join(sampleDir, file))
    if (sha256(bytes) !== manifest.files[file]?.sha256) {
      throw new FixtureLockError('FIXTURE_FILE_DIGEST_MISMATCH', 'A sample file differs from its recorded digest.')
    }
  }
}

// ---------------------------------------------------------------------------------------
// Git, isolated from the host
// ---------------------------------------------------------------------------------------

const GIT_SAFETY = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const

function gitEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  }
}

/** Read-only Git: never takes optional locks, so it cannot refresh the index. */
async function readGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['--no-optional-locks', '-C', cwd, ...GIT_SAFETY, ...args], {
    encoding: 'utf8',
    env: gitEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  })
  return stdout
}

async function optionalReadGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await readGit(cwd, args)).trim()
  } catch {
    return null
  }
}

async function writeGit(cwd: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...GIT_SAFETY, ...args], {
    encoding: 'utf8',
    env: gitEnvironment(extra),
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  })
  return stdout
}

const isInside = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`)

// ---------------------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------------------

export interface MaterializeOptions {
  /** Adds an untracked, non-ignored note; the checkout is then intentionally not clean. */
  readonly seedUntracked?: boolean
  /** Adds ignored dependency/build residue that admission must never copy. */
  readonly seedIgnored?: boolean
  /** Parent for the private temporary directory; defaults to the operating-system tmpdir. */
  readonly tmpRoot?: string
}

export interface MaterializedProjectRepository {
  /** Canonical root of the independent sample repository. */
  readonly root: string
  readonly head: string
  readonly tree: string
  readonly branch: string
  readonly manifest: ProjectLiveFixtureManifest
  /** Seeded paths, repository-relative; empty unless seeding was requested. */
  readonly seeded: { readonly untracked: readonly string[]; readonly ignored: readonly string[] }
  remove(): Promise<void>
}

export const SEEDED_UNTRACKED = ['notes/untracked-note.txt'] as const
export const SEEDED_IGNORED = ['node_modules/.flowproof-seed/marker.txt', 'dist/stale-output.txt'] as const

/**
 * Copies the verified sample into a fresh private temporary directory outside this checkout,
 * commits it once with the manifest's fixed identity and dates, and verifies the resulting tree,
 * commit and clean status against the fixture lock before returning.
 */
export async function materializeProjectLiveRepository(options: MaterializeOptions = {}): Promise<MaterializedProjectRepository> {
  const manifest = await loadFixtureManifest()
  const sampleDir = path.join(PROJECT_LIVE_FIXTURE_DIR, manifest.sample_directory)
  await verifyFixtureSources({ manifest, sampleDir })

  const tmpRoot = await realpath(options.tmpRoot ?? tmpdir())
  const checkout = await realpath(REPO_ROOT)
  if (isInside(tmpRoot, checkout)) throw new FixtureLockError('FIXTURE_ROOT_INSIDE_CHECKOUT', 'The sample must live outside FlowProof.')
  const parent = await realpath(await mkdtemp(path.join(tmpRoot, 'flowproof-project-live-')))
  const remove = (): Promise<void> => rm(parent, { recursive: true, force: true })
  try {
    if (isInside(parent, checkout) || (await optionalReadGit(parent, ['rev-parse', '--show-toplevel'])) !== null) {
      throw new FixtureLockError('FIXTURE_ROOT_INSIDE_REPOSITORY', 'The sample parent must not belong to another repository.')
    }
    await chmod(parent, 0o700)
    const root = path.join(parent, 'repo')
    await mkdir(root, { mode: 0o755 })
    for (const file of Object.keys(manifest.files).sort()) {
      const target = path.join(root, file)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
      const bytes = await readFile(path.join(sampleDir, file))
      await writeFile(target, bytes, { mode: 0o644, flag: 'wx' })
      await chmod(target, 0o644)
    }

    const { git: identity } = manifest
    const commitEnvironment = {
      GIT_AUTHOR_NAME: identity.author_name,
      GIT_AUTHOR_EMAIL: identity.author_email,
      GIT_AUTHOR_DATE: identity.date,
      GIT_COMMITTER_NAME: identity.author_name,
      GIT_COMMITTER_EMAIL: identity.author_email,
      GIT_COMMITTER_DATE: identity.date,
    }
    await writeGit(root, ['init', '--quiet', '--template=', `--initial-branch=${identity.initial_branch}`, '--object-format=sha1'])
    await writeGit(root, ['add', '--all'])
    await writeGit(root, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--message', identity.message], commitEnvironment)

    const head = (await readGit(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    const tree = (await readGit(root, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
    const branch = (await readGit(root, ['symbolic-ref', '--short', 'HEAD'])).trim()
    if (tree !== identity.tree_oid) throw new FixtureLockError('FIXTURE_TREE_MISMATCH', 'The materialized tree differs from the fixture lock.')
    if (head !== identity.commit_oid) throw new FixtureLockError('FIXTURE_COMMIT_MISMATCH', 'The materialized commit differs from the fixture lock.')
    if (branch !== identity.initial_branch) throw new FixtureLockError('FIXTURE_BRANCH_MISMATCH', 'The materialized branch differs from the fixture lock.')
    if ((await readGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) !== '') {
      throw new FixtureLockError('FIXTURE_NOT_CLEAN', 'The materialized repository is not clean.')
    }

    const seed = async (relative: string, text: string): Promise<void> => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true, mode: 0o755 })
      await writeFile(path.join(root, relative), text, { mode: 0o644, flag: 'wx' })
    }
    const untracked: string[] = []
    const ignored: string[] = []
    if (options.seedIgnored) {
      for (const relative of SEEDED_IGNORED) {
        await seed(relative, `ignored seed ${relative}\n`)
        ignored.push(relative)
      }
    }
    if (options.seedUntracked) {
      for (const relative of SEEDED_UNTRACKED) {
        await seed(relative, `untracked seed ${relative}\n`)
        untracked.push(relative)
      }
    }
    return Object.freeze({
      root,
      head,
      tree,
      branch,
      manifest,
      seeded: Object.freeze({ untracked: Object.freeze(untracked), ignored: Object.freeze(ignored) }),
      remove,
    })
  } catch (error) {
    await remove()
    throw error
  }
}

// ---------------------------------------------------------------------------------------
// Exact original snapshots
// ---------------------------------------------------------------------------------------

/** One filesystem entry: regular file content, symlink target, or directory. */
export type EntryFingerprint = string

export interface OriginalProjectSnapshot {
  /** `git rev-parse HEAD`, or null for an unborn branch. */
  readonly head: string | null
  /** `git symbolic-ref HEAD`, or null when detached. */
  readonly branch: string | null
  /** Every ref with its object and symbolic target, plus raw `packed-refs` bytes. */
  readonly refs: string
  /** `ls-files --stage` plus the exact bytes of the index file. */
  readonly index: { readonly stage: string; readonly sha256: string | null }
  /** Tracked paths and their working-tree fingerprints. */
  readonly tracked: Readonly<Record<string, EntryFingerprint>>
  /** Untracked, non-ignored files and their fingerprints. */
  readonly untracked: Readonly<Record<string, EntryFingerprint>>
  /** Ignored files and their fingerprints. */
  readonly ignored: Readonly<Record<string, EntryFingerprint>>
  /** Porcelain status including ignored entries. */
  readonly status: string
  /** Every working-tree entry outside `.git`, including empty directories. */
  readonly worktree: Readonly<Record<string, EntryFingerprint>>
  /** Every entry of the Git directory: objects, refs, logs, config, HEAD and index. */
  readonly gitDir: Readonly<Record<string, EntryFingerprint>>
}

export const SNAPSHOT_FACETS = ['head', 'branch', 'refs', 'index', 'tracked', 'untracked', 'ignored', 'status', 'worktree', 'gitDir'] as const
export type SnapshotFacet = (typeof SNAPSHOT_FACETS)[number]

async function fingerprint(absolute: string): Promise<EntryFingerprint> {
  const info = await lstat(absolute)
  const mode = (info.mode & 0o7777).toString(8)
  if (info.isSymbolicLink()) return `symlink:${await readlink(absolute)}`
  if (info.isDirectory()) return `dir:${mode}`
  if (!info.isFile()) return `special:${mode}`
  // No-follow read: a swapped-in symlink fails instead of fingerprinting another file.
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return `file:${mode}:${info.size}:${sha256(await handle.readFile())}`
  } finally {
    await handle.close()
  }
}

async function walkEntries(root: string, skipTopLevel: ReadonlySet<string>): Promise<Record<string, EntryFingerprint>> {
  const entries: Record<string, EntryFingerprint> = {}
  const walk = async (relative: string): Promise<void> => {
    let children
    try {
      children = await readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const name = relative ? `${relative}/${child.name}` : child.name
      if (relative === '' && skipTopLevel.has(child.name)) continue
      entries[name] = await fingerprint(path.join(root, name))
      if (child.isDirectory()) await walk(name)
    }
  }
  await walk('')
  return entries
}

async function fingerprintPaths(root: string, nulList: string): Promise<Record<string, EntryFingerprint>> {
  const result: Record<string, EntryFingerprint> = {}
  for (const relative of nulList.split('\0').filter(Boolean).sort()) {
    try {
      result[relative] = await fingerprint(path.join(root, relative))
    } catch {
      result[relative] = 'missing'
    }
  }
  return result
}

async function optionalFileDigest(absolute: string): Promise<string | null> {
  try {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return sha256(await handle.readFile())
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** Takes the exact original snapshot without writing to the repository or its Git directory. */
export async function snapshotOriginalProject(root: string): Promise<OriginalProjectSnapshot> {
  const gitDir = path.resolve(root, (await readGit(root, ['rev-parse', '--git-dir'])).trim())
  const packedRefs = await optionalFileDigest(path.join(gitDir, 'packed-refs'))
  const refs = await readGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'])
  return Object.freeze({
    head: await optionalReadGit(root, ['rev-parse', '--verify', '-q', 'HEAD']),
    branch: await optionalReadGit(root, ['symbolic-ref', '-q', 'HEAD']),
    refs: `${refs}\npacked-refs:${packedRefs ?? 'absent'}`,
    index: Object.freeze({ stage: await readGit(root, ['ls-files', '--stage', '-z']), sha256: await optionalFileDigest(path.join(gitDir, 'index')) }),
    tracked: Object.freeze(await fingerprintPaths(root, await readGit(root, ['ls-files', '-z', '--cached']))),
    untracked: Object.freeze(await fingerprintPaths(root, await readGit(root, ['ls-files', '-z', '--others', '--exclude-standard']))),
    ignored: Object.freeze(await fingerprintPaths(root, await readGit(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']))),
    status: await readGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']),
    worktree: Object.freeze(await walkEntries(root, new Set(['.git']))),
    gitDir: Object.freeze(await walkEntries(gitDir, new Set())),
  })
}

const stable = (value: unknown): string => JSON.stringify(value)

/** Names every snapshot facet that differs between two snapshots, in facet order. */
export function changedSnapshotFacets(before: OriginalProjectSnapshot, after: OriginalProjectSnapshot): SnapshotFacet[] {
  return SNAPSHOT_FACETS.filter((facet) => stable(before[facet]) !== stable(after[facet]))
}
