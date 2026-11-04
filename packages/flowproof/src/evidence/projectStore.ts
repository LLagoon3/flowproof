import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  PROJECT_LIMITS,
  PROJECT_PRIVACY_POLICY_VERSION,
  newProjectUuid,
  parseDemonstrationCapture,
  parseFrozenVerificationDefinition,
  parseInterpretation,
  parseProjectRunResult,
  parseProviderInvocation,
  projectSha256Schema,
  projectUuidSchema,
} from '../project/contracts.js'
import type { ProjectContractResult } from '../project/contracts.js'
import { SanitizeError, sanitizeArtifact, sanitizeText } from './sanitize.js'
import { canonicalJson, sha256Hex } from './store.js'

// Project-live review artifacts live in an owner-only state root OUTSIDE the selected checkout.
// The store never creates `.flowproof` or edits `.gitignore` in the selected repository. Callers
// choose a closed artifact kind, never a path: the store assigns a host UUID and a fixed file
// name, sanitizes or verifies content before it is hashed and staged, publishes it atomically
// with 0600 permissions in 0700 directories, and reads only IDs registered to that run with
// their exact digest through no-follow, identity-checked paths.
//
// Trust boundary: JSON and text are sanitized here. Contract objects and exact diff/patch bytes
// must already be safe; the store verifies that the sanitizer would not change them and refuses
// rather than silently altering them. PNG images are accepted only with the producer's masking
// policy attestation; the store checks PNG structure and size but does NOT and cannot prove that
// rendered pixels are free of sensitive content. No byte scan here is a pixel-safety claim.

export type ProjectStoreErrorCode =
  | 'PROJECT_STORE_ROOT_INVALID'
  | 'PROJECT_STORE_PROTECTED_ROOT_INVALID'
  | 'PROJECT_STORE_ROOT_INSIDE_PROJECT'
  | 'PROJECT_STORE_ROOT_CONTAINS_PROJECT'
  | 'PROJECT_STORE_ROOT_SYMLINK'
  | 'PROJECT_STORE_ROOT_NOT_DIRECTORY'
  | 'PROJECT_STORE_ROOT_NOT_PRIVATE'
  | 'PROJECT_STORE_ROOT_REPLACED'
  | 'PROJECT_STORE_TEMP_PURPOSE_INVALID'
  | 'PROJECT_STORE_TEMP_INSIDE_PROJECT'
  | 'PROJECT_STORE_RUN_ID_INVALID'
  | 'PROJECT_STORE_RUN_EXISTS'
  | 'PROJECT_STORE_RUN_UNKNOWN'
  | 'PROJECT_STORE_RUN_REPLACED'
  | 'PROJECT_STORE_RUN_SEALED'
  | 'PROJECT_STORE_KIND_INVALID'
  | 'PROJECT_STORE_CAPTURE_ID_INVALID'
  | 'PROJECT_STORE_CAPTURE_SUBMITTED'
  | 'PROJECT_STORE_CAPTURE_DISCARDED'
  | 'PROJECT_STORE_CONTENT_INVALID'
  | 'PROJECT_STORE_CONTENT_UNSAFE'
  | 'PROJECT_STORE_CONTENT_TOO_LARGE'
  | 'PROJECT_STORE_MASKING_UNATTESTED'
  | 'PROJECT_STORE_ARTIFACT_LIMIT'
  | 'PROJECT_STORE_ID_INVALID'
  | 'PROJECT_STORE_DIGEST_INVALID'
  | 'PROJECT_STORE_UNKNOWN_ARTIFACT'
  | 'PROJECT_STORE_DIGEST_MISMATCH'
  | 'PROJECT_STORE_ARTIFACT_DISCARDED'
  | 'PROJECT_STORE_PATH_SYMLINK'
  | 'PROJECT_STORE_ARTIFACT_REPLACED'
  | 'PROJECT_STORE_INTEGRITY_MISMATCH'

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode

  constructor(code: ProjectStoreErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ProjectStoreError'
    this.code = code
  }
}

const fail = (code: ProjectStoreErrorCode, message: string): never => {
  throw new ProjectStoreError(code, message)
}

// ---------------------------------------------------------------------------------------
// Closed artifact kinds
// ---------------------------------------------------------------------------------------

type KindFormat = 'contract-json' | 'json' | 'text' | 'exact-text' | 'png'
type ContractParser = (input: unknown) => ProjectContractResult<unknown>

interface KindSpec {
  readonly format: KindFormat
  readonly mediaType: string
  readonly extension: string
  readonly maxBytes: number
  readonly parse?: ContractParser
}

const JSON_MEDIA = 'application/json'
const KIND_SPECS = Object.freeze({
  capture: { format: 'contract-json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes, parse: parseDemonstrationCapture },
  interpretation: { format: 'contract-json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes, parse: parseInterpretation },
  definition: { format: 'contract-json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes, parse: parseFrozenVerificationDefinition },
  invocation: { format: 'contract-json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes, parse: parseProviderInvocation },
  result: { format: 'contract-json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes, parse: parseProjectRunResult },
  'check-results': { format: 'json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes },
  'evidence-manifest': { format: 'json', mediaType: JSON_MEDIA, extension: 'json', maxBytes: PROJECT_LIMITS.maxStagedReportBytes },
  'observation-text': { format: 'text', mediaType: 'text/plain; charset=utf-8', extension: 'txt', maxBytes: PROJECT_LIMITS.maxErrorSummaryBytes },
  'observation-image': { format: 'png', mediaType: 'image/png', extension: 'png', maxBytes: PROJECT_LIMITS.maxImageBytes },
  diff: { format: 'exact-text', mediaType: 'text/x-diff; charset=utf-8', extension: 'diff', maxBytes: PROJECT_LIMITS.maxPatchBytes },
  patch: { format: 'exact-text', mediaType: 'text/x-diff; charset=utf-8', extension: 'patch', maxBytes: PROJECT_LIMITS.maxPatchBytes },
} satisfies Record<string, KindSpec>)

export type ProjectArtifactKind = keyof typeof KIND_SPECS
export const PROJECT_ARTIFACT_KINDS = Object.freeze(Object.keys(KIND_SPECS) as ProjectArtifactKind[])
export type ProjectJsonKind = { [K in ProjectArtifactKind]: (typeof KIND_SPECS)[K]['format'] extends 'contract-json' | 'json' ? K : never }[ProjectArtifactKind]
export type ProjectTextKind = { [K in ProjectArtifactKind]: (typeof KIND_SPECS)[K]['format'] extends 'text' | 'exact-text' ? K : never }[ProjectArtifactKind]

/** How the persisted bytes were made safe; `producer-masked-image` is an attestation, not a proof. */
export type ArtifactSanitization = 'store-sanitized' | 'verified-clean' | 'producer-masked-image'

/** Resource bound for one run's registry; not a product limit. */
export const PROJECT_STORE_MAX_ARTIFACTS = 512
const MAX_PROTECTED_ROOTS = 8

export interface ProjectArtifactRecord {
  readonly artifact_id: string
  readonly run_id: string
  readonly kind: ProjectArtifactKind
  readonly media_type: string
  /** SHA-256 of the exact persisted bytes. */
  readonly sha256: string
  readonly bytes: number
  readonly capture_id: string | null
  readonly sanitization: ArtifactSanitization
  readonly redaction_count: number
}

export interface ProjectArtifactContent {
  readonly record: ProjectArtifactRecord
  readonly bytes: Buffer
}

export interface ArtifactWriteOptions {
  /** Groups a pre-analysis capture report so Discard can remove it. */
  readonly captureId?: string
}

export interface ImageWriteOptions extends ArtifactWriteOptions {
  /** The producer's masking attestation; must equal the current privacy policy version. */
  readonly maskingPolicyVersion: string
}

export interface ProjectRunStore {
  readonly runId: string
  readonly sealed: boolean
  writeJson(kind: ProjectJsonKind, value: unknown, options?: ArtifactWriteOptions): Promise<ProjectArtifactRecord>
  writeText(kind: ProjectTextKind, text: string, options?: ArtifactWriteOptions): Promise<ProjectArtifactRecord>
  writePng(bytes: Uint8Array, options: ImageWriteOptions): Promise<ProjectArtifactRecord>
  /** Closed lookup: a registered artifact ID with its exact digest. */
  read(artifactId: string, sha256: string): Promise<ProjectArtifactContent>
  list(): readonly ProjectArtifactRecord[]
  /** A submitted capture report is never retroactively discarded. */
  markCaptureSubmitted(captureId: string): void
  /** Removes every artifact of an unsubmitted capture; idempotent. */
  discardCapture(captureId: string): Promise<{ readonly removed: number }>
  /** Ends writes and discards; registered partial results stay readable. */
  seal(): void
}

export interface ProjectStateRoot {
  /** Canonical absolute state root. */
  readonly path: string
  createRun(runId: string): Promise<ProjectRunStore>
  readArtifact(runId: string, artifactId: string, sha256: string): Promise<ProjectArtifactContent>
}

// ---------------------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------------------

const isNodeError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

const isInsideOrEqual = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const ownerUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null)

/** Private means owned by this user with no group/other permission bits (where POSIX applies). */
function isPrivate(info: Stats): boolean {
  const uid = ownerUid()
  if (uid === null) return true
  return info.uid === uid && (info.mode & 0o077) === 0
}

/** Canonical form of a possibly missing path: realpath of the deepest existing ancestor. */
async function canonicalTarget(absolute: string): Promise<string> {
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      const resolved = await realpath(current)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse())
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

async function canonicalProtectedRoots(roots: unknown): Promise<string[]> {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > MAX_PROTECTED_ROOTS) {
    return fail('PROJECT_STORE_PROTECTED_ROOT_INVALID', 'At least one selected repository root must be protected.')
  }
  const canonical: string[] = []
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
      return fail('PROJECT_STORE_PROTECTED_ROOT_INVALID', 'Protected roots are absolute paths.')
    }
    try {
      const resolved = await realpath(root)
      if (!(await lstat(resolved)).isDirectory()) throw new Error('not a directory')
      canonical.push(resolved)
    } catch {
      return fail('PROJECT_STORE_PROTECTED_ROOT_INVALID', 'Protected roots must be existing directories.')
    }
  }
  return canonical
}

function assertOutsideProtected(candidate: string, protectedRoots: readonly string[], insideCode: ProjectStoreErrorCode, checkContains: boolean): void {
  for (const root of protectedRoots) {
    if (isInsideOrEqual(candidate, root)) fail(insideCode, 'Project state must stay outside the selected repository.')
    if (checkContains && isInsideOrEqual(root, candidate)) {
      fail('PROJECT_STORE_ROOT_CONTAINS_PROJECT', 'The state root must not contain the selected repository.')
    }
  }
}

/** Creates (or accepts) a private real directory and returns its identity. */
async function ensurePrivateDirectory(target: string, onSymlink: ProjectStoreErrorCode): Promise<Stats> {
  let created = false
  try {
    await mkdir(target, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
  }
  const info = await lstat(target)
  if (info.isSymbolicLink()) fail(onSymlink, 'Project state directories must not be symlinks.')
  if (!info.isDirectory()) fail('PROJECT_STORE_ROOT_NOT_DIRECTORY', 'Project state paths must be directories.')
  if (created) {
    await chmod(target, 0o700)
    return lstat(target)
  }
  if (!isPrivate(info)) fail('PROJECT_STORE_ROOT_NOT_PRIVATE', 'Project state directories must be owner-only.')
  return info
}

const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino

// ---------------------------------------------------------------------------------------
// Content preparation
// ---------------------------------------------------------------------------------------

interface PreparedContent {
  readonly bytes: Buffer
  readonly sanitization: ArtifactSanitization
  readonly redactionCount: number
}

const redactionTotal = (redactions: readonly { readonly count: number }[]): number => redactions.reduce((sum, entry) => sum + entry.count, 0)

function assertSize(bytes: number, spec: KindSpec): void {
  if (bytes > spec.maxBytes) fail('PROJECT_STORE_CONTENT_TOO_LARGE', 'The artifact exceeds its bound.')
}

function prepareJson(kind: ProjectArtifactKind, spec: KindSpec, value: unknown, runId: string): PreparedContent {
  if (spec.format === 'contract-json') {
    const parsed = (spec.parse as ContractParser)(value)
    if (!parsed.ok) return fail('PROJECT_STORE_CONTENT_INVALID', `The ${kind} artifact violates its contract.`)
    const object = parsed.value as Record<string, unknown>
    if ('run_id' in object && object.run_id !== runId) return fail('PROJECT_STORE_CONTENT_INVALID', `The ${kind} artifact belongs to another run.`)
    const checked = sanitizeArtifact(parsed.value)
    if (checked.redactions.length > 0) return fail('PROJECT_STORE_CONTENT_UNSAFE', 'Contract artifacts must already be safe.')
    const bytes = Buffer.from(canonicalJson(parsed.value), 'utf8')
    assertSize(bytes.length, spec)
    return { bytes, sanitization: 'verified-clean', redactionCount: 0 }
  }
  let sanitized
  try {
    sanitized = sanitizeArtifact(value)
  } catch (error) {
    if (error instanceof SanitizeError) return fail('PROJECT_STORE_CONTENT_INVALID', 'Only JSON values can be stored.')
    throw error
  }
  const bytes = Buffer.from(canonicalJson(sanitized.value), 'utf8')
  assertSize(bytes.length, spec)
  return { bytes, sanitization: 'store-sanitized', redactionCount: redactionTotal(sanitized.redactions) }
}

/** A lone surrogate would not round-trip through UTF-8, so stored bytes would not be exact. */
const isWellFormedText = (text: string): boolean => Buffer.from(text, 'utf8').toString('utf8') === text

function prepareText(spec: KindSpec, text: unknown): PreparedContent {
  if (typeof text !== 'string' || !isWellFormedText(text)) return fail('PROJECT_STORE_CONTENT_INVALID', 'Text artifacts are well-formed strings.')
  assertSize(Buffer.byteLength(text, 'utf8'), spec)
  const sanitized = sanitizeText(text)
  if (spec.format === 'exact-text') {
    if (sanitized.value !== text || sanitized.redactions.length > 0) {
      return fail('PROJECT_STORE_CONTENT_UNSAFE', 'Exact diff/patch bytes would need redaction and are refused.')
    }
    return { bytes: Buffer.from(text, 'utf8'), sanitization: 'verified-clean', redactionCount: 0 }
  }
  const bytes = Buffer.from(sanitized.value, 'utf8')
  assertSize(bytes.length, spec)
  return { bytes, sanitization: 'store-sanitized', redactionCount: redactionTotal(sanitized.redactions) }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Structural PNG check: signature, leading IHDR, CRC-valid chunks and a final IEND. */
function isStructurallyValidPng(bytes: Buffer): boolean {
  if (bytes.length < PNG_SIGNATURE.length + 12 * 2 + 13 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = PNG_SIGNATURE.length
  let index = 0
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (length > 0x7fffffff || end > bytes.length) return false
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false
    if (index === 0 && (type !== 'IHDR' || length !== 13)) return false
    if (type === 'IEND') return length === 0 && end === bytes.length
    offset = end
    index += 1
  }
  return false
}

function preparePng(spec: KindSpec, input: unknown, maskingPolicyVersion: unknown): PreparedContent {
  if (maskingPolicyVersion !== PROJECT_PRIVACY_POLICY_VERSION) {
    return fail('PROJECT_STORE_MASKING_UNATTESTED', 'Images require the producer masking attestation for the current policy.')
  }
  if (!(input instanceof Uint8Array)) return fail('PROJECT_STORE_CONTENT_INVALID', 'Images are PNG bytes.')
  assertSize(input.length, spec)
  const bytes = Buffer.from(Uint8Array.from(input))
  if (!isStructurallyValidPng(bytes)) return fail('PROJECT_STORE_CONTENT_INVALID', 'Images must be complete PNG files.')
  return { bytes, sanitization: 'producer-masked-image', redactionCount: 0 }
}

// ---------------------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------------------

interface RegistryEntry {
  readonly record: ProjectArtifactRecord
  readonly file: string
  readonly dev: number
  readonly ino: number
}

interface RootContext {
  readonly root: string
  readonly runsDirectory: string
  readonly rootIdentity: Stats
  readonly runsIdentity: Stats
}

async function assertRootUnchanged(context: RootContext): Promise<void> {
  const root = await lstatOrNull(context.root)
  if (root === null || root.isSymbolicLink() || !root.isDirectory() || !sameIdentity(root, context.rootIdentity)) {
    fail('PROJECT_STORE_ROOT_REPLACED', 'The project state root changed.')
  }
  const runs = await lstatOrNull(context.runsDirectory)
  if (runs?.isSymbolicLink()) fail('PROJECT_STORE_PATH_SYMLINK', 'Project state paths are never followed through symlinks.')
  if (runs === null || !runs.isDirectory() || !sameIdentity(runs, context.runsIdentity)) fail('PROJECT_STORE_ROOT_REPLACED', 'The runs directory changed.')
}

const validUuid = (value: unknown): value is string => projectUuidSchema.safeParse(value).success

function createRunStore(context: RootContext, runId: string, runRoot: string, runIdentity: Stats): ProjectRunStore {
  const registry = new Map<string, RegistryEntry>()
  const discarded = new Set<string>()
  const submittedCaptures = new Set<string>()
  const discardedCaptures = new Set<string>()
  let sealed = false
  let total = 0

  const assertRunPath = async (): Promise<void> => {
    await assertRootUnchanged(context)
    const info = await lstatOrNull(runRoot)
    if (info?.isSymbolicLink()) fail('PROJECT_STORE_PATH_SYMLINK', 'Project state paths are never followed through symlinks.')
    if (info === null || !info.isDirectory() || !sameIdentity(info, runIdentity)) fail('PROJECT_STORE_RUN_REPLACED', 'The run directory changed.')
  }

  const captureOf = (options: ArtifactWriteOptions | undefined): string | null => {
    const captureId = options?.captureId
    if (captureId === undefined) return null
    if (!validUuid(captureId)) return fail('PROJECT_STORE_CAPTURE_ID_INVALID', 'Capture identities are host UUIDs.')
    if (submittedCaptures.has(captureId)) return fail('PROJECT_STORE_CAPTURE_SUBMITTED', 'A submitted capture report is immutable.')
    if (discardedCaptures.has(captureId)) return fail('PROJECT_STORE_CAPTURE_DISCARDED', 'A discarded capture is never reused.')
    return captureId
  }

  const assertWritable = (): void => {
    if (sealed) fail('PROJECT_STORE_RUN_SEALED', 'The run no longer accepts writes.')
    if (total >= PROJECT_STORE_MAX_ARTIFACTS) fail('PROJECT_STORE_ARTIFACT_LIMIT', 'The run artifact bound was reached.')
  }

  const persist = async (kind: ProjectArtifactKind, spec: KindSpec, content: PreparedContent, captureId: string | null): Promise<ProjectArtifactRecord> => {
    assertWritable()
    await assertRunPath()
    const artifactId = newProjectUuid()
    const file = path.join(runRoot, `${artifactId}.${spec.extension}`)
    const staging = path.join(runRoot, `.staging-${randomBytes(8).toString('hex')}`)
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try {
        await handle.chmod(0o600)
        await handle.writeFile(content.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A hard link publishes the complete file atomically and never overwrites.
      await link(staging, file)
    } finally {
      await unlink(staging).catch(() => undefined)
    }
    const info = await lstat(file)
    const record: ProjectArtifactRecord = Object.freeze({
      artifact_id: artifactId,
      run_id: runId,
      kind,
      media_type: spec.mediaType,
      sha256: sha256Hex(content.bytes),
      bytes: content.bytes.length,
      capture_id: captureId,
      sanitization: content.sanitization,
      redaction_count: content.redactionCount,
    })
    registry.set(artifactId, { record, file, dev: info.dev, ino: info.ino })
    total += 1
    return record
  }

  const specFor = (kind: unknown, formats: readonly KindFormat[]): KindSpec => {
    const spec = typeof kind === 'string' && Object.hasOwn(KIND_SPECS, kind) ? (KIND_SPECS as Record<string, KindSpec>)[kind] : undefined
    if (spec === undefined || !formats.includes(spec.format)) return fail('PROJECT_STORE_KIND_INVALID', 'Artifacts use a closed kind for their format.')
    return spec
  }

  return {
    runId,
    get sealed(): boolean {
      return sealed
    },

    async writeJson(kind, value, options) {
      const spec = specFor(kind, ['contract-json', 'json'])
      assertWritable()
      const captureId = captureOf(options)
      return persist(kind, spec, prepareJson(kind, spec, value, runId), captureId)
    },

    async writeText(kind, text, options) {
      const spec = specFor(kind, ['text', 'exact-text'])
      assertWritable()
      const captureId = captureOf(options)
      return persist(kind, spec, prepareText(spec, text), captureId)
    },

    async writePng(bytes, options) {
      const spec = KIND_SPECS['observation-image']
      assertWritable()
      const captureId = captureOf(options)
      return persist('observation-image', spec, preparePng(spec, bytes, options?.maskingPolicyVersion), captureId)
    },

    async read(artifactId, sha256) {
      if (!validUuid(artifactId)) return fail('PROJECT_STORE_ID_INVALID', 'Artifact identities are host UUIDs.')
      if (!projectSha256Schema.safeParse(sha256).success) return fail('PROJECT_STORE_DIGEST_INVALID', 'Artifact digests are SHA-256.')
      if (discarded.has(artifactId)) return fail('PROJECT_STORE_ARTIFACT_DISCARDED', 'The artifact was discarded.')
      const entry = registry.get(artifactId)
      if (entry === undefined) return fail('PROJECT_STORE_UNKNOWN_ARTIFACT', 'The artifact is not registered to this run.')
      if (entry.record.sha256 !== sha256) return fail('PROJECT_STORE_DIGEST_MISMATCH', 'The artifact digest does not match.')
      await assertRunPath()
      let handle
      try {
        handle = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if (isNodeError(error, 'ELOOP')) return fail('PROJECT_STORE_PATH_SYMLINK', 'Artifacts are never read through symlinks.')
        if (isNodeError(error, 'ENOENT')) return fail('PROJECT_STORE_ARTIFACT_REPLACED', 'The artifact file is missing.')
        throw error
      }
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) return fail('PROJECT_STORE_ARTIFACT_REPLACED', 'The artifact file was replaced.')
        if (info.size !== entry.record.bytes) return fail('PROJECT_STORE_INTEGRITY_MISMATCH', 'The artifact changed after it was persisted.')
        const bytes = await handle.readFile()
        if (bytes.length !== entry.record.bytes || sha256Hex(bytes) !== entry.record.sha256) {
          return fail('PROJECT_STORE_INTEGRITY_MISMATCH', 'The artifact changed after it was persisted.')
        }
        return Object.freeze({ record: entry.record, bytes })
      } finally {
        await handle.close()
      }
    },

    list() {
      return Object.freeze([...registry.values()].map((entry) => entry.record))
    },

    markCaptureSubmitted(captureId) {
      if (!validUuid(captureId)) fail('PROJECT_STORE_CAPTURE_ID_INVALID', 'Capture identities are host UUIDs.')
      if (discardedCaptures.has(captureId)) fail('PROJECT_STORE_CAPTURE_DISCARDED', 'A discarded capture cannot be submitted.')
      submittedCaptures.add(captureId)
    },

    async discardCapture(captureId) {
      if (!validUuid(captureId)) return fail('PROJECT_STORE_CAPTURE_ID_INVALID', 'Capture identities are host UUIDs.')
      if (sealed) return fail('PROJECT_STORE_RUN_SEALED', 'The run no longer accepts discards.')
      if (submittedCaptures.has(captureId)) return fail('PROJECT_STORE_CAPTURE_SUBMITTED', 'A submitted capture report is not retroactively discarded.')
      discardedCaptures.add(captureId)
      await assertRunPath()
      let removed = 0
      for (const [artifactId, entry] of [...registry.entries()]) {
        if (entry.record.capture_id !== captureId) continue
        await unlink(entry.file).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
        if ((await lstatOrNull(entry.file)) !== null) return fail('PROJECT_STORE_ARTIFACT_REPLACED', 'A discarded artifact could not be removed.')
        registry.delete(artifactId)
        discarded.add(artifactId)
        removed += 1
      }
      return Object.freeze({ removed })
    },

    seal() {
      sealed = true
    },
  }
}

// ---------------------------------------------------------------------------------------
// State root and temporary directories
// ---------------------------------------------------------------------------------------

/**
 * Opens (creating if needed) the owner-only state root. It must be absolute, outside every
 * protected (selected repository) root after canonicalization, not contain one, not be a
 * symlink, and be private to this user. An existing shared root is refused, not repaired.
 */
export async function openProjectStateRoot(options: { readonly stateRoot: string; readonly protectedRoots: readonly string[] }): Promise<ProjectStateRoot> {
  const requested = options?.stateRoot
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) {
    return fail('PROJECT_STORE_ROOT_INVALID', 'The state root is an absolute path.')
  }
  const protectedRoots = await canonicalProtectedRoots(options.protectedRoots)
  const literal = path.resolve(requested)
  const canonical = await canonicalTarget(literal)
  assertOutsideProtected(canonical, protectedRoots, 'PROJECT_STORE_ROOT_INSIDE_PROJECT', true)

  const existing = await lstatOrNull(literal)
  if (existing?.isSymbolicLink()) return fail('PROJECT_STORE_ROOT_SYMLINK', 'The state root must not be a symlink.')
  if (existing !== null && !existing.isDirectory()) return fail('PROJECT_STORE_ROOT_NOT_DIRECTORY', 'The state root must be a directory.')
  if (existing === null) {
    await mkdir(canonical, { recursive: true, mode: 0o700 })
    await chmod(canonical, 0o700)
  }
  if ((await realpath(canonical)) !== canonical) return fail('PROJECT_STORE_ROOT_REPLACED', 'The state root moved while it was opened.')
  const rootIdentity = await lstat(canonical)
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) return fail('PROJECT_STORE_ROOT_REPLACED', 'The state root moved while it was opened.')
  if (!isPrivate(rootIdentity)) return fail('PROJECT_STORE_ROOT_NOT_PRIVATE', 'The state root must be owner-only.')

  const runsDirectory = path.join(canonical, 'runs')
  const runsIdentity = await ensurePrivateDirectory(runsDirectory, 'PROJECT_STORE_PATH_SYMLINK')
  const context: RootContext = { root: canonical, runsDirectory, rootIdentity, runsIdentity }
  const runs = new Map<string, ProjectRunStore>()

  return Object.freeze({
    path: canonical,

    async createRun(runId: string): Promise<ProjectRunStore> {
      if (!validUuid(runId)) return fail('PROJECT_STORE_RUN_ID_INVALID', 'Run identities are host UUIDs.')
      if (runs.has(runId)) return fail('PROJECT_STORE_RUN_EXISTS', 'The run is already registered.')
      await assertRootUnchanged(context)
      const runRoot = path.join(runsDirectory, runId)
      try {
        await mkdir(runRoot, { mode: 0o700 })
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) return fail('PROJECT_STORE_RUN_EXISTS', 'The run directory already exists.')
        throw error
      }
      await chmod(runRoot, 0o700)
      const runIdentity = await lstat(runRoot)
      if (runIdentity.isSymbolicLink() || !runIdentity.isDirectory()) return fail('PROJECT_STORE_RUN_REPLACED', 'The run directory moved.')
      const store = createRunStore(context, runId, runRoot, runIdentity)
      runs.set(runId, store)
      return store
    },

    async readArtifact(runId: string, artifactId: string, sha256: string): Promise<ProjectArtifactContent> {
      if (!validUuid(runId)) return fail('PROJECT_STORE_RUN_ID_INVALID', 'Run identities are host UUIDs.')
      const run = runs.get(runId)
      if (run === undefined) return fail('PROJECT_STORE_RUN_UNKNOWN', 'The run is not registered in this state root.')
      return run.read(artifactId, sha256)
    },
  })
}

export const PROJECT_TEMP_PURPOSES = ['admission-snapshot', 'candidate-copy', 'target-output'] as const
export type ProjectTempPurpose = (typeof PROJECT_TEMP_PURPOSES)[number]

export interface OwnedTempDirectory {
  readonly path: string
  readonly purpose: ProjectTempPurpose
  /** Idempotent removal of exactly this owned directory. */
  remove(): Promise<void>
}

/** Allocates a private temporary directory that is never inside a protected repository root. */
export async function createProjectTempDirectory(options: {
  readonly purpose: ProjectTempPurpose
  readonly protectedRoots: readonly string[]
  readonly tempRoot?: string
}): Promise<OwnedTempDirectory> {
  const purpose = options?.purpose
  if (!(PROJECT_TEMP_PURPOSES as readonly unknown[]).includes(purpose)) {
    return fail('PROJECT_STORE_TEMP_PURPOSE_INVALID', 'Temporary directories have a closed purpose.')
  }
  const protectedRoots = await canonicalProtectedRoots(options.protectedRoots)
  const requestedRoot = options.tempRoot ?? tmpdir()
  if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot)) return fail('PROJECT_STORE_ROOT_INVALID', 'The temporary root is absolute.')
  const tempRoot = await realpath(requestedRoot)
  assertOutsideProtected(tempRoot, protectedRoots, 'PROJECT_STORE_TEMP_INSIDE_PROJECT', false)
  const directory = await realpath(await mkdtemp(path.join(tempRoot, `flowproof-project-${purpose}-`)))
  let removal: Promise<void> | null = null
  const remove = (): Promise<void> => (removal ??= rm(directory, { recursive: true, force: true }))
  try {
    assertOutsideProtected(directory, protectedRoots, 'PROJECT_STORE_TEMP_INSIDE_PROJECT', false)
    await chmod(directory, 0o700)
  } catch (error) {
    await remove()
    throw error
  }
  return Object.freeze({ path: directory, purpose: purpose as ProjectTempPurpose, remove })
}
