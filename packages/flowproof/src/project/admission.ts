import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { containsSecretPattern } from '../evidence/sanitize.js'
import { PROJECT_CATEGORY, PROJECT_SCHEMA_VERSION, ProjectContextSchema, newProjectUuid, projectDigest, projectRelativePathSchema } from './contracts.js'
import type { ProjectContext } from './contracts.js'

// Canonical, read-only admission of a selected local project (Spec 006 T014). Admission inspects
// only committed inputs and the original's state; it never executes project code, installs,
// builds, writes or calls a model. Git runs without a shell and with an explicit environment: no
// inherited `GIT_*` override, no global/system configuration, hooks, filesystem monitor,
// untracked cache or optional index locks, and only plumbing that reads (`rev-parse`, `ls-tree`,
// `ls-files`, `for-each-ref`). Working-tree content is compared with the committed blobs by
// hashing the bytes here, so no clean/smudge filter or `status` refresh can run. A refusal
// returns only fixed reason codes and no admitted project, so nothing can proceed from it.
//
// The admitted identity (`ProjectContext`) pins the canonical root, full commit, branch, admitted
// tree digest, protected-input digests and the runtime profile. `checkProjectBaseline` re-inspects
// later and reports a changed or no-longer-admissible original as stale; it never replaces the
// admitted baseline. `captureOriginalIntegrity` records the original's tracked, untracked, ignored,
// index, ref and Git-directory state for later zero-write confirmation.

export const ADMISSION_REASONS = [
  'PROJECT_PATH_INVALID',
  'PROJECT_NOT_GIT_ROOT',
  'PROJECT_GIT_DIR_UNSUPPORTED',
  'PROJECT_GIT_UNREADABLE',
  'PROJECT_HEAD_MISSING',
  'PROJECT_STAGED_CHANGES',
  'PROJECT_TRACKED_CHANGES',
  'PROJECT_UNTRACKED_FILES',
  'PROJECT_SYMLINK_TRACKED',
  'PROJECT_GITLINK_TRACKED',
  'PROJECT_PATH_UNSUPPORTED',
  'PROJECT_SECRET_FILE',
  'PROJECT_SECRET_CONTENT',
  'PROJECT_GIT_ATTRIBUTES_UNSUPPORTED',
  'PROJECT_LAYOUT_UNSUPPORTED',
  'PROJECT_LOCK_MISSING',
  'PROJECT_LOCK_MISMATCH',
  'PROJECT_PACKAGE_MISMATCH',
  'PROJECT_TOO_LARGE',
  'PROJECT_BASELINE_CHANGED',
] as const
export type AdmissionReason = (typeof ADMISSION_REASONS)[number]

export interface AdmittedFile {
  readonly path: string
  readonly mode: '100644' | '100755'
  /** The committed blob object ID. */
  readonly oid: string
  readonly sha256: string
  readonly size: number
  /** Valid UTF-8 without NUL or other control bytes beyond tab, CR and LF. */
  readonly text: boolean
}

export const INTEGRITY_FACETS = ['head', 'branch', 'refs', 'index', 'tracked', 'untracked', 'ignored', 'git_dir'] as const
export type IntegrityFacet = (typeof INTEGRITY_FACETS)[number]

export interface OriginalIntegrity {
  readonly snapshot_id: string
  readonly sha256: string
  readonly facets: Readonly<Record<IntegrityFacet, string>>
}

export interface AdmittedProject {
  readonly context: ProjectContext
  /** Controller-private; never part of a model request, log or error message. */
  readonly canonicalRoot: string
  readonly gitDir: string
  readonly objectFormat: 'sha1' | 'sha256'
  /** The committed root tree object ID of the baseline commit. */
  readonly treeOid: string
  /** Every admitted committed regular file, sorted by path. */
  readonly files: readonly AdmittedFile[]
  readonly integrity: OriginalIntegrity
}

export type ProjectAdmission =
  | { readonly state: 'ready'; readonly project: AdmittedProject }
  | { readonly state: 'blocked'; readonly reasons: readonly AdmissionReason[] }

/** The runtime profile identity a project is admitted against. */
export type AdmissionProfile = ProjectContext['profile']

export type BaselineCheck = { readonly state: 'ready' } | { readonly state: 'stale'; readonly reasons: readonly AdmissionReason[] }

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

const MAX_FILES = 4_096
const MAX_FILE_BYTES = 16 * 1_024 * 1_024
const MAX_TOTAL_BYTES = 64 * 1_024 * 1_024
const MAX_PROTECTED_INPUTS = 256
const MAX_GIT_DIR_ENTRIES = 200_000
const FINGERPRINT_CONTENT_BYTES = 1_024 * 1_024
const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 64 * 1_024 * 1_024

// ---------------------------------------------------------------------------------------
// Isolated read-only Git
// ---------------------------------------------------------------------------------------

const GIT_SAFETY = [
  '--no-optional-locks',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'core.excludesFile=/dev/null',
] as const

/** No inherited Git or user configuration; nothing here can name another repository or index. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
}

class GitReadError extends Error {}

function readGitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...GIT_SAFETY, ...args],
      { encoding: 'buffer', env: gitEnvironment(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, shell: false },
      (error, stdout) => (error ? reject(new GitReadError('git read failed')) : resolve(stdout)),
    )
  })
}

const readGit = async (cwd: string, args: readonly string[]): Promise<string> => (await readGitBytes(cwd, args)).toString('utf8')

async function optionalGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await readGit(cwd, args)).trim()
  } catch {
    return null
  }
}

/** Splits NUL-terminated records; the decoding is strict UTF-8 or the record is null. */
function nulRecords(bytes: Buffer): Array<string | null> {
  const records: Array<string | null> = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let start = 0
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    try {
      records.push(decoder.decode(bytes.subarray(start, end)))
    } catch {
      records.push(null)
    }
    start = end + 1
  }
  return records
}

// ---------------------------------------------------------------------------------------
// Hashing and file reads (no-follow)
// ---------------------------------------------------------------------------------------

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

function blobOid(format: 'sha1' | 'sha256', content: Uint8Array): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex')
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
// eslint-disable-next-line no-control-regex
const NON_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Strict text: valid UTF-8 without NUL or control bytes other than tab, LF and CR. */
export function decodeText(content: Uint8Array): string | null {
  try {
    const text = TEXT_DECODER.decode(content)
    return NON_TEXT_CONTROL.test(text) ? null : text
  } catch {
    return null
  }
}

async function readNoFollow(absolute: string, maxBytes: number): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------------------

const OTHER_LOCKS = new Set(['yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock'])
const SECRET_BASENAMES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.pgpass', '.htpasswd', 'credentials', 'credentials.json', '.git-credentials'])
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.docker', '.kube'])
const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i
const KEY_FILE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/
const TEST_SEGMENTS = new Set(['tests', 'test', '__tests__', 'spec'])
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

function isSecretFile(file: string): boolean {
  const segments = file.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES.has(segment))) return true
  if (/^\.env(?:$|\.)/.test(base) && !SAFE_ENV_TEMPLATES.has(base)) return true
  return SECRET_BASENAMES.has(base) || SECRET_EXTENSIONS.test(base) || KEY_FILE.test(base) || /^service-account.*\.json$/i.test(base)
}

const isTestFile = (file: string): boolean => file.split('/').slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment)) || TEST_FILE.test(file)

type ProtectedKind = ProjectContext['protected_inputs'][number]['kind']

function protectedKind(file: string): ProtectedKind {
  if (file === 'package.json') return 'package'
  if (file === 'package-lock.json') return 'lock'
  if (file === 'index.html') return 'entry'
  if (isTestFile(file)) return 'test'
  return 'configuration'
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The package manifest must describe exactly the lock's root package and no workspace. */
function checkPackageAgainstLock(packageText: string | null, lockText: string | null, reasons: Set<AdmissionReason>): void {
  let manifest: unknown
  let lock: unknown
  try {
    manifest = JSON.parse(packageText ?? '')
    lock = JSON.parse(lockText ?? '')
  } catch {
    reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
    return
  }
  if (!isRecord(manifest) || !isRecord(lock) || !isRecord(lock.packages) || !isRecord(lock.packages[''])) {
    reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
    return
  }
  if ('workspaces' in manifest) reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
  const root = lock.packages[''] as Record<string, unknown>
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  const sorted = (value: unknown): unknown => (isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value)
  if (!same(manifest.name, root.name) || !same(manifest.version, root.version)) reasons.add('PROJECT_PACKAGE_MISMATCH')
  for (const field of DEPENDENCY_FIELDS) {
    if (!same(sorted(manifest[field]), sorted(root[field]))) reasons.add('PROJECT_PACKAGE_MISMATCH')
  }
}

// ---------------------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------------------

interface Inspection {
  readonly canonicalRoot: string
  readonly gitDir: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly head: string
  readonly treeOid: string
  readonly branch: string | null
  readonly files: readonly AdmittedFile[]
  readonly reasons: readonly AdmissionReason[]
}

type Located = { readonly ok: true; readonly root: string; readonly gitDir: string } | { readonly ok: false; readonly reason: AdmissionReason }

async function locate(requested: unknown): Promise<Located> {
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) return { ok: false, reason: 'PROJECT_PATH_INVALID' }
  let root: string
  try {
    root = await realpath(requested)
    if (!(await stat(root)).isDirectory()) return { ok: false, reason: 'PROJECT_PATH_INVALID' }
  } catch {
    return { ok: false, reason: 'PROJECT_PATH_INVALID' }
  }
  const top = await optionalGit(root, ['rev-parse', '--show-toplevel'])
  if (top === null) return { ok: false, reason: 'PROJECT_NOT_GIT_ROOT' }
  let canonicalTop: string
  try {
    canonicalTop = await realpath(top)
  } catch {
    return { ok: false, reason: 'PROJECT_GIT_UNREADABLE' }
  }
  if (canonicalTop !== root) return { ok: false, reason: 'PROJECT_NOT_GIT_ROOT' }
  // Only an ordinary repository: a linked worktree, `.git` file or symlink shares or redirects metadata.
  const dotGit = path.join(root, '.git')
  const info = await lstat(dotGit).catch(() => null)
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return { ok: false, reason: 'PROJECT_GIT_DIR_UNSUPPORTED' }
  const gitDir = await optionalGit(root, ['rev-parse', '--absolute-git-dir'])
  const bare = await optionalGit(root, ['rev-parse', '--is-bare-repository'])
  if (gitDir === null || bare !== 'false') return { ok: false, reason: 'PROJECT_GIT_UNREADABLE' }
  if ((await realpath(gitDir).catch(() => null)) !== dotGit) return { ok: false, reason: 'PROJECT_GIT_DIR_UNSUPPORTED' }
  return { ok: true, root, gitDir: dotGit }
}

interface TreeEntry {
  readonly mode: string
  readonly type: string
  readonly oid: string
  readonly path: string | null
}

function parseTree(bytes: Buffer): TreeEntry[] | null {
  const entries: TreeEntry[] = []
  for (const record of nulRecords(bytes)) {
    if (record === null) {
      entries.push({ mode: '', type: '', oid: '', path: null })
      continue
    }
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record)
    if (match === null) return null
    entries.push({ mode: match[1] ?? '', type: match[2] ?? '', oid: match[3] ?? '', path: match[4] ?? '' })
  }
  return entries
}

interface IndexEntry {
  readonly mode: string
  readonly oid: string
  readonly stage: string
  readonly path: string | null
}

function parseIndex(bytes: Buffer): IndexEntry[] | null {
  const entries: IndexEntry[] = []
  for (const record of nulRecords(bytes)) {
    const match = record === null ? null : /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(record)
    if (match === null) {
      if (record === null) {
        entries.push({ mode: '', oid: '', stage: '0', path: null })
        continue
      }
      return null
    }
    entries.push({ mode: match[1] ?? '', oid: match[2] ?? '', stage: match[3] ?? '', path: match[4] ?? '' })
  }
  return entries
}

/** True when every ancestor directory of `file` below `root` is a real directory (no symlink). */
async function ancestorsAreDirectories(root: string, file: string, verified: Map<string, boolean>): Promise<boolean> {
  const segments = file.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    let ok = verified.get(current)
    if (ok === undefined) {
      const info = await lstat(path.join(root, current)).catch(() => null)
      ok = info !== null && info.isDirectory() && !info.isSymbolicLink()
      verified.set(current, ok)
    }
    if (!ok) return false
  }
  return true
}

async function inspect(requested: unknown, profile: AdmissionProfile): Promise<Inspection | { readonly blocked: readonly AdmissionReason[] }> {
  const located = await locate(requested)
  if (!located.ok) return { blocked: [located.reason] }
  const { root, gitDir } = located
  const reasons = new Set<AdmissionReason>()

  const format = await optionalGit(root, ['rev-parse', '--show-object-format'])
  if (format !== 'sha1' && format !== 'sha256') return { blocked: ['PROJECT_GIT_UNREADABLE'] }
  const head = await optionalGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])
  if (head === null || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return { blocked: ['PROJECT_HEAD_MISSING'] }
  const treeOid = await optionalGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${head}^{tree}`])
  if (treeOid === null || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeOid)) return { blocked: ['PROJECT_GIT_UNREADABLE'] }
  const symbolic = await optionalGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  // The branch is display data only; a name outside the contract is shown as detached.
  const branch = symbolic !== null && ProjectContextSchema.shape.branch.safeParse(symbolic).success ? symbolic : null

  let tree: TreeEntry[] | null
  let index: IndexEntry[] | null
  let untracked: Buffer
  try {
    tree = parseTree(await readGitBytes(root, ['ls-tree', '-r', '-z', '--full-tree', head]))
    index = parseIndex(await readGitBytes(root, ['ls-files', '--stage', '-z']))
    untracked = await readGitBytes(root, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--no-empty-directory'])
  } catch {
    return { blocked: ['PROJECT_GIT_UNREADABLE'] }
  }
  if (tree === null || index === null) return { blocked: ['PROJECT_GIT_UNREADABLE'] }
  if (untracked.length > 0) reasons.add('PROJECT_UNTRACKED_FILES')

  // The index must hold exactly the committed tree at stage 0.
  const committed = new Map(tree.filter((entry) => entry.path !== null).map((entry) => [entry.path as string, entry]))
  if (index.length !== tree.length || index.some((entry) => entry.stage !== '0' || entry.path === null)) reasons.add('PROJECT_STAGED_CHANGES')
  for (const entry of index) {
    const match = entry.path === null ? undefined : committed.get(entry.path)
    if (match === undefined || match.mode !== entry.mode || match.oid !== entry.oid) reasons.add('PROJECT_STAGED_CHANGES')
  }

  if (tree.length > MAX_FILES) return { blocked: ['PROJECT_TOO_LARGE'] }
  const files: AdmittedFile[] = []
  const verifiedDirectories = new Map<string, boolean>()
  let total = 0
  for (const entry of tree) {
    if (entry.path === null || !projectRelativePathSchema.safeParse(entry.path).success || entry.path.split('/')[0] === '.git') {
      reasons.add('PROJECT_PATH_UNSUPPORTED')
      continue
    }
    if (entry.mode === '120000') {
      reasons.add('PROJECT_SYMLINK_TRACKED')
      continue
    }
    if (entry.mode === '160000' || entry.type === 'commit') {
      reasons.add('PROJECT_GITLINK_TRACKED')
      continue
    }
    if ((entry.mode !== '100644' && entry.mode !== '100755') || entry.type !== 'blob') {
      reasons.add('PROJECT_PATH_UNSUPPORTED')
      continue
    }
    const absolute = path.join(root, entry.path)
    const info = (await ancestorsAreDirectories(root, entry.path, verifiedDirectories)) ? await lstat(absolute).catch(() => null) : null
    if (info === null || !info.isFile()) {
      reasons.add('PROJECT_TRACKED_CHANGES')
      continue
    }
    if (info.size > MAX_FILE_BYTES || (total += info.size) > MAX_TOTAL_BYTES) return { blocked: ['PROJECT_TOO_LARGE'] }
    const executable = (info.mode & 0o100) !== 0
    if (executable !== (entry.mode === '100755')) reasons.add('PROJECT_TRACKED_CHANGES')
    const content = await readNoFollow(absolute, MAX_FILE_BYTES)
    if (content === null || blobOid(format, content) !== entry.oid) {
      reasons.add('PROJECT_TRACKED_CHANGES')
      continue
    }
    const text = decodeText(content)
    if (isSecretFile(entry.path)) reasons.add('PROJECT_SECRET_FILE')
    else if (text !== null && containsSecretPattern(text)) reasons.add('PROJECT_SECRET_CONTENT')
    files.push(Object.freeze({ path: entry.path, mode: entry.mode, oid: entry.oid, sha256: sha256(content), size: content.length, text: text !== null }))
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  // The vite-static-v1 layout: one root package with its lock, an entry document and sources.
  const byPath = new Map(files.map((file) => [file.path, file]))
  const paths = [...committed.keys()]
  if (paths.some((file) => file.split('/').pop() === '.gitattributes')) reasons.add('PROJECT_GIT_ATTRIBUTES_UNSUPPORTED')
  if (paths.includes('.gitmodules')) reasons.add('PROJECT_GITLINK_TRACKED')
  if (paths.some((file) => OTHER_LOCKS.has(file.split('/').pop() ?? ''))) reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
  if (paths.some((file) => file !== 'package.json' && file.split('/').pop() === 'package.json')) reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
  if (paths.some((file) => file.split('/').includes('node_modules'))) reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
  if (!byPath.has('index.html') || !byPath.has('package.json') || !paths.some((file) => file.startsWith('src/'))) reasons.add('PROJECT_LAYOUT_UNSUPPORTED')
  const lock = byPath.get('package-lock.json')
  if (!paths.includes('package-lock.json')) reasons.add('PROJECT_LOCK_MISSING')
  else if (lock !== undefined && lock.sha256 !== profile.lock_sha256) reasons.add('PROJECT_LOCK_MISMATCH')
  const packageFile = byPath.get('package.json')
  if (packageFile !== undefined && lock !== undefined) {
    const read = async (file: AdmittedFile): Promise<string | null> => {
      const bytes = await readNoFollow(path.join(root, file.path), MAX_FILE_BYTES)
      return bytes === null || sha256(bytes) !== file.sha256 ? null : decodeText(bytes)
    }
    checkPackageAgainstLock(await read(packageFile), await read(lock), reasons)
  }
  if (files.filter((file) => !isAllowedSource(file)).length > MAX_PROTECTED_INPUTS) reasons.add('PROJECT_TOO_LARGE')

  return { canonicalRoot: root, gitDir, objectFormat: format, head, treeOid, branch, files, reasons: orderedReasons(reasons) }
}

const orderedReasons = (reasons: ReadonlySet<AdmissionReason>): AdmissionReason[] => ADMISSION_REASONS.filter((reason) => reasons.has(reason))

/** Editable candidates: non-test UTF-8 text files under `src/`. */
const isAllowedSource = (file: AdmittedFile): boolean => file.path.startsWith('src/') && file.text && !isTestFile(file.path)

/** Digest of the admitted committed tree: path, mode and content digest of every file. */
export function admittedTreeDigest(files: readonly Pick<AdmittedFile, 'path' | 'mode' | 'sha256'>[]): string {
  return projectDigest([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => [file.path, file.mode, file.sha256]))
}

function protectedInputs(files: readonly AdmittedFile[]): ProjectContext['protected_inputs'] {
  return files
    .filter((file) => !file.path.startsWith('src/') || isTestFile(file.path))
    .map((file) => ({ path: file.path, kind: protectedKind(file.path), sha256: file.sha256 }))
}

/**
 * Admits a selected local project against a runtime profile, read-only. A refusal carries only
 * fixed reason codes. Nothing is executed, written, installed or sent.
 */
export async function admitProject(options: { readonly root: string; readonly profile: AdmissionProfile }): Promise<ProjectAdmission> {
  const inspection = await inspect(options?.root, options.profile)
  if ('blocked' in inspection) return Object.freeze({ state: 'blocked', reasons: Object.freeze([...inspection.blocked]) })
  if (inspection.reasons.length > 0) return Object.freeze({ state: 'blocked', reasons: Object.freeze(inspection.reasons.slice(0, 16)) })

  const integrity = await captureOriginalIntegrity(inspection.canonicalRoot, inspection.gitDir)
  const parsed = ProjectContextSchema.safeParse({
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: newProjectUuid(),
    display_root: inspection.canonicalRoot,
    label: path.basename(inspection.canonicalRoot),
    baseline_commit: inspection.head,
    branch: inspection.branch,
    category: PROJECT_CATEGORY,
    admitted_tree_sha256: admittedTreeDigest(inspection.files),
    integrity_snapshot: { snapshot_id: integrity.snapshot_id, sha256: integrity.sha256 },
    profile: options.profile,
    allowed_source_paths: inspection.files.filter(isAllowedSource).map((file) => file.path),
    protected_inputs: protectedInputs(inspection.files),
    admission: { state: 'ready', reasons: [], required_prerequisites: [] },
  })
  // A root label or display path outside the safe-text contract cannot be shown honestly.
  if (!parsed.success) return Object.freeze({ state: 'blocked', reasons: Object.freeze(['PROJECT_PATH_UNSUPPORTED' as const]) })
  return Object.freeze({
    state: 'ready',
    project: Object.freeze({
      context: Object.freeze(parsed.data),
      canonicalRoot: inspection.canonicalRoot,
      gitDir: inspection.gitDir,
      objectFormat: inspection.objectFormat,
      treeOid: inspection.treeOid,
      files: Object.freeze(inspection.files),
      integrity,
    }),
  })
}

/**
 * Re-inspects the original. Any change to the admitted identity, or a no-longer-admissible state,
 * is stale; the admitted baseline is never refreshed, so a stale project stays stale.
 */
export async function checkProjectBaseline(project: AdmittedProject, profile: AdmissionProfile): Promise<BaselineCheck> {
  const inspection = await inspect(project.canonicalRoot, profile)
  if ('blocked' in inspection) {
    const reasons: AdmissionReason[] = ['PROJECT_BASELINE_CHANGED', ...inspection.blocked]
    return Object.freeze({ state: 'stale', reasons: Object.freeze(reasons.filter(unique).slice(0, 16)) })
  }
  const reasons = new Set<AdmissionReason>(inspection.reasons)
  const { context } = project
  const changed =
    inspection.canonicalRoot !== project.canonicalRoot ||
    inspection.head !== context.baseline_commit ||
    inspection.branch !== context.branch ||
    admittedTreeDigest(inspection.files) !== context.admitted_tree_sha256 ||
    JSON.stringify(protectedInputs(inspection.files)) !== JSON.stringify(context.protected_inputs) ||
    JSON.stringify(inspection.files.filter(isAllowedSource).map((file) => file.path)) !== JSON.stringify(context.allowed_source_paths)
  if (changed) reasons.add('PROJECT_BASELINE_CHANGED')
  if (profile.lock_sha256 !== context.profile.lock_sha256 || profile.image_id !== context.profile.image_id) reasons.add('PROJECT_BASELINE_CHANGED')
  if (reasons.size === 0) return Object.freeze({ state: 'ready' })
  return Object.freeze({ state: 'stale', reasons: Object.freeze(orderedReasons(reasons).slice(0, 16)) })
}

function unique<T>(value: T, index: number, values: readonly T[]): boolean {
  return values.indexOf(value) === index
}

/**
 * Reads committed blobs of an admitted project from the original object database, read-only and
 * without filters, and verifies each against its object ID and admitted SHA-256.
 */
export function readCommittedBlobs(project: Pick<AdmittedProject, 'canonicalRoot' | 'objectFormat'>, files: readonly AdmittedFile[]): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', project.canonicalRoot, ...GIT_SAFETY, 'cat-file', '--batch'],
      { encoding: 'buffer', env: gitEnvironment(), timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_TOTAL_BYTES + files.length * 128 + 1_024, shell: false },
      (error, stdout) => {
        if (error) return reject(new GitReadError('git read failed'))
        const blobs = new Map<string, Buffer>()
        let offset = 0
        for (const file of files) {
          const newline = stdout.indexOf(0x0a, offset)
          const header = newline < 0 ? '' : stdout.subarray(offset, newline).toString('latin1')
          const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(header)
          if (match === null || match[1] !== file.oid) return reject(new GitReadError('unexpected object'))
          const size = Number(match[2])
          const content = stdout.subarray(newline + 1, newline + 1 + size)
          if (content.length !== size || stdout[newline + 1 + size] !== 0x0a) return reject(new GitReadError('truncated object'))
          if (blobOid(project.objectFormat, content) !== file.oid || sha256(content) !== file.sha256) return reject(new GitReadError('object mismatch'))
          blobs.set(file.path, Buffer.from(content))
          offset = newline + 1 + size + 1
        }
        if (offset !== stdout.length) return reject(new GitReadError('unexpected trailing output'))
        resolve(blobs)
      },
    )
    child.stdin?.end(files.map((file) => `${file.oid}\n`).join(''))
  })
}

export { blobOid }

// ---------------------------------------------------------------------------------------
// Original integrity snapshot
// ---------------------------------------------------------------------------------------

async function fingerprint(absolute: string, hashContent: boolean): Promise<string> {
  const info = await lstat(absolute).catch(() => null)
  if (info === null) return 'missing'
  const mode = (info.mode & 0o7777).toString(8)
  if (info.isSymbolicLink()) return `link:${mode}:${info.mtimeMs}`
  if (info.isDirectory()) return `dir:${mode}:${info.ino}:${info.mtimeMs}`
  if (!info.isFile()) return `special:${mode}`
  if (hashContent && info.size <= FINGERPRINT_CONTENT_BYTES) {
    const content = await readNoFollow(absolute, FINGERPRINT_CONTENT_BYTES)
    if (content !== null) return `file:${mode}:${info.size}:${sha256(content)}`
  }
  return `file:${mode}:${info.size}:${info.ino}:${info.mtimeMs}`
}

async function listFacet(root: string, args: readonly string[], hashContent: boolean): Promise<string> {
  const records = nulRecords(await readGitBytes(root, args))
  const entries: string[] = []
  for (const record of records) entries.push(record === null ? 'undecodable' : `${record}\u0000${await fingerprint(path.join(root, record.replace(/\/$/, '')), hashContent)}`)
  return sha256(entries.sort().join('\n'))
}

async function gitDirFacet(gitDir: string): Promise<string> {
  const lines: string[] = []
  let count = 0
  const walk = async (relative: string): Promise<void> => {
    let children
    try {
      children = await readdir(path.join(gitDir, relative), { withFileTypes: true })
    } catch {
      lines.push(`unreadable:${relative}`)
      return
    }
    for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (++count > MAX_GIT_DIR_ENTRIES) {
        lines.push('bound-exceeded')
        return
      }
      const name = relative ? `${relative}/${child.name}` : child.name
      // Loose and packed objects are content-addressed by name; everything else is hashed.
      lines.push(`${name}\u0000${await fingerprint(path.join(gitDir, name), !name.startsWith('objects/'))}`)
      if (child.isDirectory()) await walk(name)
    }
  }
  await walk('')
  return sha256(lines.join('\n'))
}

/** Records the original's state without writing to it; facets are digests, never content. */
export async function captureOriginalIntegrity(root: string, gitDir: string): Promise<OriginalIntegrity> {
  const read = async (args: readonly string[]): Promise<string> => sha256(await readGitBytes(root, args).catch(() => Buffer.from('unreadable')))
  const facets: Record<IntegrityFacet, string> = {
    head: await read(['rev-parse', '--verify', '--quiet', 'HEAD']),
    branch: await read(['symbolic-ref', '--quiet', 'HEAD']),
    refs: sha256(
      `${(await readGitBytes(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)']).catch(() => Buffer.from('unreadable'))).toString('hex')}:${
        (await readNoFollow(path.join(gitDir, 'packed-refs'), MAX_FILE_BYTES).then((bytes) => (bytes === null ? 'absent' : sha256(bytes))))
      }`,
    ),
    index: await readNoFollow(path.join(gitDir, 'index'), 512 * 1_024 * 1_024).then((bytes) => (bytes === null ? 'absent' : sha256(bytes))),
    tracked: await listFacet(root, ['ls-files', '-z', '--cached'], true).catch(() => 'unreadable'),
    untracked: await listFacet(root, ['ls-files', '-z', '--others', '--exclude-standard'], true).catch(() => 'unreadable'),
    ignored: await listFacet(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], false).catch(() => 'unreadable'),
    git_dir: await gitDirFacet(gitDir),
  }
  return Object.freeze({ snapshot_id: newProjectUuid(), sha256: projectDigest(facets), facets: Object.freeze(facets) })
}

/** The facets that differ between two integrity snapshots, in facet order. */
export function changedIntegrityFacets(before: OriginalIntegrity, after: OriginalIntegrity): IntegrityFacet[] {
  return INTEGRITY_FACETS.filter((facet) => before.facets[facet] !== after.facets[facet])
}
