import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { CONTRACT_SCHEMA_VERSION, artifactRootFor, parseEvidenceBundle, uuidSchema } from '../contracts/index.js'
import type { EvidenceBundle, EvidenceItem, EvidencePhase, Redaction } from '../contracts/index.js'
import { parseEvidenceId } from './ids.js'
import { sanitizeArtifact, sanitizeText } from './sanitize.js'

// Run artifacts live only under the Git-ignored `.flowproof/runs/<run-id>/` root. Content is
// sanitized before it is hashed or written, writes are atomic and never overwrite, and reads
// resolve closed identifiers registered by this run rather than caller-supplied paths.

export const ARTIFACT_ROOT = '.flowproof/runs'

/** Fixed, non-evidence artifacts the Proof Trail can read by name. */
export const ARTIFACT_NAMES = ['diagnosis', 'candidate-diff', 'failure-manifest', 'replay-manifest', 'result'] as const

export type ArtifactStoreErrorCode =
  | 'ARTIFACT_ROOT_SYMLINK'
  | 'ARTIFACT_ROOT_NOT_DIRECTORY'
  | 'ARTIFACT_ROOT_NOT_IGNORED'
  | 'ARTIFACT_ROOT_TRACKED'
  | 'ARTIFACT_ROOT_GIT_UNAVAILABLE'
  | 'ARTIFACT_RUN_ID_INVALID'
  | 'ARTIFACT_RUN_EXISTS'
  | 'ARTIFACT_PATH_INVALID'
  | 'ARTIFACT_PATH_SYMLINK'
  | 'ARTIFACT_ALREADY_EXISTS'
  | 'ARTIFACT_CONTENT_INVALID'
  | 'ARTIFACT_ID_INVALID'
  | 'ARTIFACT_ID_DUPLICATE'
  | 'ARTIFACT_NOT_PERSISTED'
  | 'ARTIFACT_UNKNOWN_ID'
  | 'ARTIFACT_INTEGRITY_MISMATCH'
  | 'ARTIFACT_BUNDLE_INVALID'
  | 'ARTIFACT_TEMP_PURPOSE_INVALID'
  | 'ARTIFACT_TEMP_INSIDE_REPOSITORY'

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ArtifactStoreError'
    this.code = code
  }
}

export interface PersistedArtifact {
  /** Path relative to the run directory. */
  readonly artifact_path: string
  /** SHA-256 of the exact persisted (already sanitized) bytes. */
  readonly sha256: string
  readonly bytes: number
  readonly redactions: readonly Redaction[]
}

export interface RunArtifactStore {
  readonly runId: string
  /** `.flowproof/runs/<run-id>/`, relative to the repository root. */
  readonly relativeRoot: string
  writeJson(artifactPath: string, value: unknown): Promise<PersistedArtifact>
  writeText(artifactPath: string, text: string): Promise<PersistedArtifact>
  writePng(artifactPath: string, bytes: Uint8Array): Promise<PersistedArtifact>
  /** Binds an Evidence ID or fixed artifact name to an artifact this store persisted. */
  register(id: string, artifact: PersistedArtifact): void
  hasEvidence(id: string): boolean
  hasArtifact(artifactPath: string): boolean
  read(id: string): Promise<Buffer>
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_ARTIFACT_PATH_LENGTH = 200
const runGit = promisify(execFile)

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Deterministic JSON: object keys sorted, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  }
  throw new ArtifactStoreError('ARTIFACT_CONTENT_INVALID', 'Only JSON values can be canonicalized.')
}

/** Assembles a contract-valid Evidence Bundle whose digest covers canonical item metadata. */
export function buildEvidenceBundle(input: {
  readonly runId: string
  readonly scenarioId: string
  readonly phase: EvidencePhase
  readonly items: readonly EvidenceItem[]
}): EvidenceBundle {
  const candidate = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    run_id: input.runId,
    scenario_id: input.scenarioId,
    phase: input.phase,
    items: input.items,
    manifest_sha256: sha256Hex(canonicalJson(input.items)),
  }
  const parsed = parseEvidenceBundle(candidate)
  if (!parsed.ok) {
    const fields = parsed.error.issues.map((issue) => issue.path).join(', ')
    throw new ArtifactStoreError('ARTIFACT_BUNDLE_INVALID', `The evidence bundle violates its contract at ${fields}.`)
  }
  return parsed.value
}

function validateArtifactPath(artifactPath: unknown): string {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0 || artifactPath.length > MAX_ARTIFACT_PATH_LENGTH) {
    throw new ArtifactStoreError('ARTIFACT_PATH_INVALID', 'Artifact paths are short relative paths.')
  }
  if (!artifactPath.split('/').every((segment) => ARTIFACT_SEGMENT.test(segment))) {
    throw new ArtifactStoreError('ARTIFACT_PATH_INVALID', 'Artifact paths use plain relative segments only.')
  }
  return artifactPath
}

const isNodeError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

async function gitExitCode(repoRoot: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await runGit('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'number' ? code : -1, stdout: '' }
  }
}

/**
 * Requires `.flowproof` and `.flowproof/runs` to be real directories (or absent), ignored by
 * Git, and free of tracked content. A symlink anywhere on the root is refused.
 */
export async function assertArtifactRootSafe(repoRoot: string): Promise<void> {
  const root = await realpath(repoRoot)
  for (const relative of ['.flowproof', ARTIFACT_ROOT]) {
    const info = await lstatOrNull(path.join(root, relative))
    if (info?.isSymbolicLink()) throw new ArtifactStoreError('ARTIFACT_ROOT_SYMLINK', 'The artifact root must not be a symlink.')
    if (info && !info.isDirectory()) throw new ArtifactStoreError('ARTIFACT_ROOT_NOT_DIRECTORY', 'The artifact root must be a directory.')
  }
  const probe = `${ARTIFACT_ROOT}/.flowproof-ignore-probe`
  const ignored = await gitExitCode(root, ['check-ignore', '-q', '--', probe])
  if (ignored.code === 1) throw new ArtifactStoreError('ARTIFACT_ROOT_NOT_IGNORED', 'Git must ignore the artifact root.')
  if (ignored.code !== 0) throw new ArtifactStoreError('ARTIFACT_ROOT_GIT_UNAVAILABLE', 'Git could not evaluate the artifact root.')
  const tracked = await gitExitCode(root, ['ls-files', '-z', '--', '.flowproof'])
  if (tracked.code !== 0) throw new ArtifactStoreError('ARTIFACT_ROOT_GIT_UNAVAILABLE', 'Git could not list the artifact root.')
  if (tracked.stdout.length > 0) {
    throw new ArtifactStoreError('ARTIFACT_ROOT_TRACKED', 'The artifact root must not contain tracked files.')
  }
}

async function ensureRealDirectory(target: string, onSymlink: ArtifactStoreErrorCode): Promise<void> {
  try {
    await mkdir(target, { mode: 0o700 })
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  const info = await lstat(target)
  if (info.isSymbolicLink()) throw new ArtifactStoreError(onSymlink, 'Artifact directories must not be symlinks.')
  if (!info.isDirectory()) throw new ArtifactStoreError('ARTIFACT_PATH_INVALID', 'Artifact directories must be directories.')
}

/** Creates the run directory and returns the only writer and reader for its artifacts. */
export async function createRunArtifactStore(options: { readonly repoRoot: string; readonly runId: string }): Promise<RunArtifactStore> {
  const { runId } = options
  if (!uuidSchema.safeParse(runId).success) throw new ArtifactStoreError('ARTIFACT_RUN_ID_INVALID', 'Run identifiers are UUIDs.')
  await assertArtifactRootSafe(options.repoRoot)
  const repoRoot = await realpath(options.repoRoot)
  await ensureRealDirectory(path.join(repoRoot, '.flowproof'), 'ARTIFACT_ROOT_SYMLINK')
  await ensureRealDirectory(path.join(repoRoot, ARTIFACT_ROOT), 'ARTIFACT_ROOT_SYMLINK')
  const runRoot = path.join(repoRoot, ARTIFACT_ROOT, runId)
  try {
    await mkdir(runRoot, { mode: 0o700 })
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) throw new ArtifactStoreError('ARTIFACT_RUN_EXISTS', 'The run directory already exists.')
    throw error
  }
  if ((await realpath(runRoot)) !== runRoot) throw new ArtifactStoreError('ARTIFACT_ROOT_SYMLINK', 'The run directory moved.')

  const written = new Map<string, string>()
  const registry = new Map<string, PersistedArtifact>()

  const assertNoSymlinkParents = async (relative: string, create: boolean): Promise<string> => {
    let current = runRoot
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment)
      const info = await lstatOrNull(current)
      if (info === null && create) {
        await mkdir(current, { mode: 0o700 })
        continue
      }
      if (info?.isSymbolicLink()) throw new ArtifactStoreError('ARTIFACT_PATH_SYMLINK', 'Artifact paths must not traverse symlinks.')
      if (!info?.isDirectory()) throw new ArtifactStoreError('ARTIFACT_PATH_INVALID', 'An artifact parent is not a directory.')
    }
    return path.join(runRoot, relative)
  }

  const persist = async (artifactPath: string, bytes: Uint8Array, redactions: readonly Redaction[]): Promise<PersistedArtifact> => {
    const target = await assertNoSymlinkParents(artifactPath, true)
    if ((await lstatOrNull(target)) !== null) throw new ArtifactStoreError('ARTIFACT_ALREADY_EXISTS', 'Artifacts are written once.')
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A hard link publishes the complete file atomically and fails instead of overwriting.
      await link(temporary, target)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) throw new ArtifactStoreError('ARTIFACT_ALREADY_EXISTS', 'Artifacts are written once.')
      throw error
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    const artifact: PersistedArtifact = Object.freeze({
      artifact_path: artifactPath,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      redactions,
    })
    written.set(artifactPath, artifact.sha256)
    return artifact
  }

  return Object.freeze({
    runId,
    relativeRoot: artifactRootFor(runId),

    async writeJson(artifactPath: string, value: unknown): Promise<PersistedArtifact> {
      const relative = validateArtifactPath(artifactPath)
      const sanitized = sanitizeArtifact(value)
      const bytes = Buffer.from(`${JSON.stringify(sanitized.value, null, 2)}\n`, 'utf8')
      return persist(relative, bytes, sanitized.redactions)
    },

    async writeText(artifactPath: string, text: string): Promise<PersistedArtifact> {
      const relative = validateArtifactPath(artifactPath)
      const sanitized = sanitizeText(String(text))
      return persist(relative, Buffer.from(sanitized.value, 'utf8'), sanitized.redactions)
    },

    async writePng(artifactPath: string, bytes: Uint8Array): Promise<PersistedArtifact> {
      const relative = validateArtifactPath(artifactPath)
      const isPng = bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
      if (!isPng) throw new ArtifactStoreError('ARTIFACT_CONTENT_INVALID', 'Screenshots must be PNG images.')
      return persist(relative, Uint8Array.from(bytes), [])
    },

    register(id: string, artifact: PersistedArtifact): void {
      const valid = parseEvidenceId(id) !== null || (ARTIFACT_NAMES as readonly string[]).includes(id)
      if (!valid) throw new ArtifactStoreError('ARTIFACT_ID_INVALID', 'Artifacts are registered by Evidence ID or fixed name.')
      if (registry.has(id)) throw new ArtifactStoreError('ARTIFACT_ID_DUPLICATE', 'Artifact identifiers are registered once.')
      if (written.get(artifact.artifact_path) !== artifact.sha256) {
        throw new ArtifactStoreError('ARTIFACT_NOT_PERSISTED', 'Only artifacts persisted by this run can be registered.')
      }
      registry.set(id, Object.freeze({ ...artifact }))
    },

    hasEvidence: (id: string): boolean => parseEvidenceId(id) !== null && registry.has(id),

    hasArtifact: (artifactPath: string): boolean => written.has(artifactPath),

    async read(id: string): Promise<Buffer> {
      const artifact = typeof id === 'string' ? registry.get(id) : undefined
      if (!artifact) throw new ArtifactStoreError('ARTIFACT_UNKNOWN_ID', 'The artifact is not registered for this run.')
      const target = await assertNoSymlinkParents(artifact.artifact_path, false)
      let handle
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if (isNodeError(error, 'ELOOP')) {
          throw new ArtifactStoreError('ARTIFACT_PATH_SYMLINK', 'Artifacts are never read through symlinks.')
        }
        throw error
      }
      try {
        const bytes = await handle.readFile()
        if (sha256Hex(bytes) !== artifact.sha256) {
          throw new ArtifactStoreError('ARTIFACT_INTEGRITY_MISMATCH', 'The artifact changed after it was persisted.')
        }
        return bytes
      } finally {
        await handle.close()
      }
    },
  })
}

// ---------------------------------------------------------------------------------------
// Operating-system temporary output
// ---------------------------------------------------------------------------------------

export const TEMP_OUTPUT_PURPOSES = ['studio-build', 'preview-build', 'worktree'] as const
export type TempOutputPurpose = (typeof TEMP_OUTPUT_PURPOSES)[number]

export interface TempOutput {
  readonly path: string
  remove(): Promise<void>
}

/**
 * Allocates build or worktree output under the operating-system temporary directory. A
 * temporary root inside the repository is refused, so generated output never lands in the
 * original working tree.
 */
export async function createOsTempOutput(options: {
  readonly purpose: TempOutputPurpose
  readonly repoRoot: string
  readonly tmpRoot?: string
}): Promise<TempOutput> {
  if (!TEMP_OUTPUT_PURPOSES.includes(options.purpose)) {
    throw new ArtifactStoreError('ARTIFACT_TEMP_PURPOSE_INVALID', 'Unknown temporary output purpose.')
  }
  const tmpRoot = await realpath(options.tmpRoot ?? tmpdir())
  const repoRoot = await realpath(options.repoRoot)
  if (tmpRoot === repoRoot || tmpRoot.startsWith(`${repoRoot}${path.sep}`)) {
    throw new ArtifactStoreError('ARTIFACT_TEMP_INSIDE_REPOSITORY', 'Temporary output must live outside the repository.')
  }
  const directory = await mkdtemp(path.join(tmpRoot, `flowproof-${options.purpose}-`))
  return Object.freeze({
    path: directory,
    remove: () => rm(directory, { recursive: true, force: true }),
  })
}
