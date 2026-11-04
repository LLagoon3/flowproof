import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { META_MODEL_ID } from '../../packages/flowproof/src/contracts/index.js'
import {
  PROJECT_ARTIFACT_KINDS,
  ProjectStoreError,
  createProjectTempDirectory,
  openProjectStateRoot,
} from '../../packages/flowproof/src/evidence/projectStore.js'
import type { ProjectRunStore, ProjectStateRoot } from '../../packages/flowproof/src/evidence/projectStore.js'
import { PROJECT_LIMITS, PROJECT_PRIVACY_POLICY_VERSION, newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import { createTempDirectory } from '../support/repoFixture.js'

// T006: the project-live store keeps sanitized review artifacts in an owner-only state root outside
// the selected checkout. It never writes the original repository, reads only registered
// run-owned IDs with their exact digest through no-follow paths, and removes discarded reports.

const owned: Array<{ remove(): Promise<void> }> = []
afterEach(async () => {
  while (owned.length > 0) await owned.pop()?.remove()
})

async function tempDirectory(prefix = 'flowproof-project-store-'): Promise<string> {
  const directory = await createTempDirectory(prefix)
  owned.push(directory)
  return directory.path
}

/** A plain directory standing in for the selected checkout; T001's sample proves zero writes. */
async function selectedRepository(): Promise<string> {
  const root = await tempDirectory('flowproof-project-selected-')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/App.jsx'), 'export const App = () => null\n')
  return root
}

async function openRoot(): Promise<{ root: ProjectStateRoot; repository: string; parent: string }> {
  const repository = await selectedRepository()
  const parent = await tempDirectory()
  const root = await openProjectStateRoot({ stateRoot: path.join(parent, 'state'), protectedRoots: [repository] })
  return { root, repository, parent }
}

async function openRun(): Promise<{ root: ProjectStateRoot; run: ProjectRunStore; repository: string; parent: string }> {
  const opened = await openRoot()
  return { ...opened, run: await opened.root.createRun(newProjectUuid()) }
}

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectStoreError)
    expect((error as ProjectStoreError).code).toBe(code)
    return
  }
  throw new Error(`Expected ${code}, but the operation succeeded.`)
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const modeOf = async (target: string): Promise<number> => (await lstat(target)).mode & 0o777

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
  return Buffer.concat([header, data, crc])
}

/** A structurally valid 1x1 PNG, optionally padded with an ancillary chunk. */
function png(padding = 0): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  const idat = Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00])
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (padding > 0) parts.push(chunk('tEXt', Buffer.alloc(padding, 0x61)))
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

const masked = { maskingPolicyVersion: PROJECT_PRIVACY_POLICY_VERSION }

function startedInvocation(runId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    invocation_id: newProjectUuid(),
    run_id: runId,
    phase: 'analysis',
    transport: 'meta',
    requested_model: META_MODEL_ID,
    observed_model: null,
    response_id: null,
    input_sha256: 'a'.repeat(64),
    included_source_paths: ['src/App.jsx'],
    included_image_ids: [],
    included_observation_ids: [],
    request_bytes: 100,
    source_bytes: 30,
    status: 'started',
    error_code: null,
    http_status: null,
    usage: { input_tokens: null, output_tokens: null, total_tokens: null },
    latency_ms: null,
    started_at: '2026-11-04T10:00:00.000Z',
    completed_at: null,
  }
}

/** Every regular file below a directory, relative; detects stray staging files. */
async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else found.push(path.relative(root, absolute))
    }
  }
  await walk(root)
  return found.sort()
}

describe('project state root placement and permissions', () => {
  it('creates an owner-only state root, run directory and artifact files outside the selected checkout', async () => {
    const { root, run } = await openRun()
    expect(path.isAbsolute(root.path)).toBe(true)
    expect(await modeOf(root.path)).toBe(0o700)
    const record = await run.writeText('observation-text', 'TypeError: filter is not a function')
    const files = await filesBelow(root.path)
    expect(files).toHaveLength(1)
    const artifactFile = path.join(root.path, files[0] as string)
    expect(await modeOf(artifactFile)).toBe(0o600)
    for (let directory = path.dirname(artifactFile); directory.startsWith(root.path); directory = path.dirname(directory)) {
      expect(await modeOf(directory)).toBe(0o700)
      if (directory === root.path) break
    }
    expect(record.run_id).toBe(run.runId)
  })

  it('rejects a state root inside, equal to, aliased into, or containing the selected repository', async () => {
    const repository = await selectedRepository()
    const protectedRoots = [repository]
    await expectCode(openProjectStateRoot({ stateRoot: path.join(repository, '.flowproof/state'), protectedRoots }), 'PROJECT_STORE_ROOT_INSIDE_PROJECT')
    await expectCode(openProjectStateRoot({ stateRoot: repository, protectedRoots }), 'PROJECT_STORE_ROOT_INSIDE_PROJECT')
    const aliasParent = await tempDirectory()
    await symlink(repository, path.join(aliasParent, 'alias'))
    await expectCode(openProjectStateRoot({ stateRoot: path.join(aliasParent, 'alias/state'), protectedRoots }), 'PROJECT_STORE_ROOT_INSIDE_PROJECT')
    await expectCode(openProjectStateRoot({ stateRoot: path.dirname(repository), protectedRoots }), 'PROJECT_STORE_ROOT_CONTAINS_PROJECT')
    await expectCode(openProjectStateRoot({ stateRoot: 'relative/state', protectedRoots }), 'PROJECT_STORE_ROOT_INVALID')
    await expectCode(openProjectStateRoot({ stateRoot: path.join(aliasParent, 'state'), protectedRoots: [] }), 'PROJECT_STORE_PROTECTED_ROOT_INVALID')
    expect(await readdir(repository)).toEqual(['src'])
  })

  it('refuses a symlinked or shared state root instead of following or repairing it', async () => {
    const repository = await selectedRepository()
    const parent = await tempDirectory()
    const elsewhere = await tempDirectory()
    await chmod(elsewhere, 0o700)
    await symlink(elsewhere, path.join(parent, 'linked'))
    await expectCode(openProjectStateRoot({ stateRoot: path.join(parent, 'linked'), protectedRoots: [repository] }), 'PROJECT_STORE_ROOT_SYMLINK')
    const shared = path.join(parent, 'shared')
    await mkdir(shared)
    await chmod(shared, 0o755)
    await expectCode(openProjectStateRoot({ stateRoot: shared, protectedRoots: [repository] }), 'PROJECT_STORE_ROOT_NOT_PRIVATE')
    expect(await modeOf(shared)).toBe(0o755)
    await writeFile(path.join(parent, 'file'), 'x')
    await expectCode(openProjectStateRoot({ stateRoot: path.join(parent, 'file'), protectedRoots: [repository] }), 'PROJECT_STORE_ROOT_NOT_DIRECTORY')
  })

  it('allocates owned temporary directories outside the selected repository and removes them idempotently', async () => {
    const repository = await selectedRepository()
    await expectCode(
      createProjectTempDirectory({ purpose: 'candidate-copy', protectedRoots: [repository], tempRoot: repository }),
      'PROJECT_STORE_TEMP_INSIDE_PROJECT',
    )
    await expectCode(
      createProjectTempDirectory({ purpose: 'arbitrary' as never, protectedRoots: [repository], tempRoot: await tempDirectory() }),
      'PROJECT_STORE_TEMP_PURPOSE_INVALID',
    )
    const temp = await createProjectTempDirectory({ purpose: 'candidate-copy', protectedRoots: [repository], tempRoot: await tempDirectory() })
    expect(await modeOf(temp.path)).toBe(0o700)
    expect(temp.path.startsWith(repository)).toBe(false)
    await temp.remove()
    await temp.remove()
    await expect(lstat(temp.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(repository)).toEqual(['src'])
  })

  it('never writes the selected sample repository: tracked, untracked, ignored, index and refs stay exact', async () => {
    const repository = await materializeProjectLiveRepository({ seedUntracked: true, seedIgnored: true })
    owned.push(repository)
    const before = await snapshotOriginalProject(repository.root)
    const root = await openProjectStateRoot({ stateRoot: path.join(await tempDirectory(), 'state'), protectedRoots: [repository.root] })
    const run = await root.createRun(newProjectUuid())
    const capture = newProjectUuid()
    const text = await run.writeText('observation-text', 'TypeError at src/App.jsx', { captureId: capture })
    await run.writePng(png(), { ...masked, captureId: capture })
    await run.writeText('patch', '--- a/src/App.jsx\n+++ b/src/App.jsx\n')
    await run.read(text.artifact_id, text.sha256)
    await run.discardCapture(capture)
    run.seal()
    const temp = await createProjectTempDirectory({ purpose: 'target-output', protectedRoots: [repository.root] })
    await temp.remove()
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await expect(lstat(path.join(repository.root, '.flowproof'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('closed per-run registration', () => {
  it('requires host UUID run identities and creates each run once', async () => {
    const { root } = await openRoot()
    await expectCode(root.createRun('../escape'), 'PROJECT_STORE_RUN_ID_INVALID')
    await expectCode(root.createRun('00000000-0000-0000-0000-000000000000'), 'PROJECT_STORE_RUN_ID_INVALID')
    const runId = newProjectUuid()
    await root.createRun(runId)
    await expectCode(root.createRun(runId), 'PROJECT_STORE_RUN_EXISTS')
  })

  it('assigns host artifact IDs and fixed names; callers choose a closed kind, never a path', async () => {
    const { root, run } = await openRun()
    expect(PROJECT_ARTIFACT_KINDS).toContain('patch')
    const record = await run.writeText('observation-text', 'plain error')
    expect(record.artifact_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Object.keys(record).sort()).toEqual(
      ['artifact_id', 'bytes', 'capture_id', 'kind', 'media_type', 'redaction_count', 'run_id', 'sanitization', 'sha256'].sort(),
    )
    const files = await filesBelow(root.path)
    expect(files.map((file) => path.basename(file))).toEqual([`${record.artifact_id}.txt`])
    await expectCode(run.writeText('../../outside' as never, 'x'), 'PROJECT_STORE_KIND_INVALID')
    await expectCode(run.writeJson('observation-text' as never, {}), 'PROJECT_STORE_KIND_INVALID')
    await expectCode(run.writeText('result' as never, 'x'), 'PROJECT_STORE_KIND_INVALID')
    await expectCode(run.writeText('observation-text', 'x', { captureId: 'not-a-uuid' }), 'PROJECT_STORE_CAPTURE_ID_INVALID')
  })

  it('sanitizes generic text and JSON before hashing, staging and persistence', async () => {
    const { root, run } = await openRun()
    const text = await run.writeText('observation-text', 'failed with Bearer tokenvalue111111 sk-abcdefghijklmnopqrstuvwx')
    const json = await run.writeJson('check-results', { api_key: 'abc', note: 'sk-abcdefghijklmnopqrstuvwx', ok: true })
    for (const record of [text, json]) {
      const { bytes } = await run.read(record.artifact_id, record.sha256)
      expect(sha256(bytes)).toBe(record.sha256)
      expect(bytes.length).toBe(record.bytes)
      expect(bytes.toString('utf8')).not.toMatch(/tokenvalue111111|sk-abcdefghijklmnopqrstuvwx|"abc"/)
      expect(record.sanitization).toBe('store-sanitized')
      expect(record.redaction_count).toBeGreaterThan(0)
    }
    expect((await filesBelow(root.path)).every((file) => !/\.tmp$|stag/.test(file))).toBe(true)
  })

  it('validates contract artifacts and refuses rather than alters unsafe already-safe objects', async () => {
    const { run } = await openRun()
    const valid = await run.writeJson('invocation', startedInvocation(run.runId))
    expect(valid.sanitization).toBe('verified-clean')
    expect(valid.redaction_count).toBe(0)
    await expectCode(run.writeJson('invocation', { ...startedInvocation(run.runId), extra: true }), 'PROJECT_STORE_CONTENT_INVALID')
    await expectCode(run.writeJson('invocation', startedInvocation(newProjectUuid())), 'PROJECT_STORE_CONTENT_INVALID')
    await expectCode(run.writeJson('result', { kind: 'project-live' }), 'PROJECT_STORE_CONTENT_INVALID')
    expect(run.list().map((record) => record.artifact_id)).toEqual([valid.artifact_id])
  })

  it('stores diff and patch bytes exactly and rejects content that would need redaction', async () => {
    const { root, run } = await openRun()
    const patch = '--- a/src/App.jsx\n+++ b/src/App.jsx\n@@ -1 +1 @@\n-a\n+b\n'
    const record = await run.writeText('patch', patch)
    expect(record.sanitization).toBe('verified-clean')
    expect((await run.read(record.artifact_id, record.sha256)).bytes.toString('utf8')).toBe(patch)
    await expectCode(run.writeText('diff', `${patch}+const key = 'sk-abcdefghijklmnopqrstuvwx'\n`), 'PROJECT_STORE_CONTENT_UNSAFE')
    await expectCode(run.writeText('patch', 'x'.repeat(PROJECT_LIMITS.maxPatchBytes + 1)), 'PROJECT_STORE_CONTENT_TOO_LARGE')
    await expectCode(run.writeText('patch', `${patch}\uD800`), 'PROJECT_STORE_CONTENT_INVALID')
    expect(await filesBelow(root.path)).toHaveLength(1)
  })

  it('accepts only producer-masked bounded PNG images and does not claim pixel scanning', async () => {
    const { run } = await openRun()
    const image = await run.writePng(png(), masked)
    expect(image.media_type).toBe('image/png')
    expect(image.sanitization).toBe('producer-masked-image')
    expect(image.redaction_count).toBe(0)
    await expectCode(run.writePng(png(), { maskingPolicyVersion: 'unmasked' }), 'PROJECT_STORE_MASKING_UNATTESTED')
    await expectCode(run.writePng(Buffer.from('not a png image'), masked), 'PROJECT_STORE_CONTENT_INVALID')
    await expectCode(run.writePng(png().subarray(0, 40), masked), 'PROJECT_STORE_CONTENT_INVALID')
    await expectCode(run.writePng(png(PROJECT_LIMITS.maxImageBytes), masked), 'PROJECT_STORE_CONTENT_TOO_LARGE')
  })
})

describe('closed registered-ID, digest and no-follow reads', () => {
  it('returns exact bytes only for a registered ID with its exact digest', async () => {
    const { root, run } = await openRun()
    const record = await run.writeText('observation-text', 'plain error')
    const read = await root.readArtifact(run.runId, record.artifact_id, record.sha256)
    expect(read.bytes.toString('utf8')).toBe('plain error')
    expect(read.record).toEqual(record)
    await expectCode(run.read(record.artifact_id, 'b'.repeat(64)), 'PROJECT_STORE_DIGEST_MISMATCH')
    await expectCode(run.read(record.artifact_id, 'XYZ'), 'PROJECT_STORE_DIGEST_INVALID')
    await expectCode(run.read('../../etc/passwd', record.sha256), 'PROJECT_STORE_ID_INVALID')
    await expectCode(run.read(newProjectUuid(), record.sha256), 'PROJECT_STORE_UNKNOWN_ARTIFACT')
    await expectCode(root.readArtifact(newProjectUuid(), record.artifact_id, record.sha256), 'PROJECT_STORE_RUN_UNKNOWN')
  })

  it('never serves another run artifact through a different run', async () => {
    const { root, run } = await openRun()
    const other = await root.createRun(newProjectUuid())
    const record = await run.writeText('observation-text', 'owned by the first run')
    await expectCode(other.read(record.artifact_id, record.sha256), 'PROJECT_STORE_UNKNOWN_ARTIFACT')
    await expectCode(root.readArtifact(other.runId, record.artifact_id, record.sha256), 'PROJECT_STORE_UNKNOWN_ARTIFACT')
  })

  it('detects changed bytes, swapped files and symlinked path components', async () => {
    const { root, run } = await openRun()
    const tampered = await run.writeText('observation-text', 'first')
    const swapped = await run.writeText('observation-text', 'second')
    const linked = await run.writeText('observation-text', 'third')
    const fileOf = async (artifactId: string): Promise<string> =>
      path.join(root.path, (await filesBelow(root.path)).find((file) => path.basename(file).startsWith(artifactId)) as string)

    const tamperedFile = await fileOf(tampered.artifact_id)
    await chmod(tamperedFile, 0o600)
    await writeFile(tamperedFile, 'FIRST')
    await expectCode(run.read(tampered.artifact_id, tampered.sha256), 'PROJECT_STORE_INTEGRITY_MISMATCH')

    const swappedFile = await fileOf(swapped.artifact_id)
    // Create the replacement before unlinking the original so its inode cannot be reused.
    await writeFile(`${swappedFile}.new`, 'second', { mode: 0o600 })
    await rename(`${swappedFile}.new`, swappedFile)
    await expectCode(run.read(swapped.artifact_id, swapped.sha256), 'PROJECT_STORE_ARTIFACT_REPLACED')

    const linkedFile = await fileOf(linked.artifact_id)
    const outside = path.join(await tempDirectory(), 'outside.txt')
    await writeFile(outside, 'third')
    await rm(linkedFile)
    await symlink(outside, linkedFile)
    await expectCode(run.read(linked.artifact_id, linked.sha256), 'PROJECT_STORE_PATH_SYMLINK')
  })

  it('refuses reads after the run directory or state root is replaced by a symlink', async () => {
    const { root, run } = await openRun()
    const record = await run.writeText('observation-text', 'kept')
    const runDirectory = path.dirname(path.join(root.path, (await filesBelow(root.path))[0] as string))
    const moved = `${runDirectory}.moved`
    await rename(runDirectory, moved)
    await symlink(moved, runDirectory)
    await expectCode(run.read(record.artifact_id, record.sha256), 'PROJECT_STORE_PATH_SYMLINK')
    await rm(runDirectory)
    await rename(moved, runDirectory)
    expect((await run.read(record.artifact_id, record.sha256)).bytes.toString('utf8')).toBe('kept')

    const rootMoved = `${root.path}.moved`
    await rename(root.path, rootMoved)
    await symlink(rootMoved, root.path)
    await expectCode(run.read(record.artifact_id, record.sha256), 'PROJECT_STORE_ROOT_REPLACED')
    await rm(root.path)
    await rename(rootMoved, root.path)
  })
})

describe('discard, partial retention and sealing', () => {
  it('removes a discarded pre-analysis capture report and keeps other artifacts', async () => {
    const { root, run } = await openRun()
    const discarded = newProjectUuid()
    const kept = newProjectUuid()
    const first = await run.writeText('observation-text', 'discard me', { captureId: discarded })
    const image = await run.writePng(png(), { ...masked, captureId: discarded })
    const other = await run.writeText('observation-text', 'keep me', { captureId: kept })
    expect(await run.discardCapture(discarded)).toEqual({ removed: 2 })
    await expectCode(run.read(first.artifact_id, first.sha256), 'PROJECT_STORE_ARTIFACT_DISCARDED')
    await expectCode(run.read(image.artifact_id, image.sha256), 'PROJECT_STORE_ARTIFACT_DISCARDED')
    expect(run.list().map((record) => record.artifact_id)).toEqual([other.artifact_id])
    expect((await filesBelow(root.path)).map((file) => path.basename(file))).toEqual([`${other.artifact_id}.txt`])
    expect(await run.discardCapture(discarded)).toEqual({ removed: 0 })
  })

  it('does not retroactively discard a capture once it was submitted for analysis', async () => {
    const { run } = await openRun()
    const capture = newProjectUuid()
    const record = await run.writeText('observation-text', 'sent', { captureId: capture })
    run.markCaptureSubmitted(capture)
    await expectCode(run.discardCapture(capture), 'PROJECT_STORE_CAPTURE_SUBMITTED')
    expect((await run.read(record.artifact_id, record.sha256)).bytes.toString('utf8')).toBe('sent')
  })

  it('retains registered partial results after a failed write and after sealing', async () => {
    const { root, run } = await openRun()
    const record = await run.writeText('observation-text', 'partial evidence')
    await expectCode(run.writeText('observation-text', 'x'.repeat(PROJECT_LIMITS.maxErrorSummaryBytes + 1)), 'PROJECT_STORE_CONTENT_TOO_LARGE')
    run.seal()
    await expectCode(run.writeText('observation-text', 'late'), 'PROJECT_STORE_RUN_SEALED')
    await expectCode(run.discardCapture(newProjectUuid()), 'PROJECT_STORE_RUN_SEALED')
    expect((await run.read(record.artifact_id, record.sha256)).bytes.toString('utf8')).toBe('partial evidence')
    expect(await filesBelow(root.path)).toHaveLength(1)
    expect((await stat(path.join(root.path, (await filesBelow(root.path))[0] as string))).size).toBe(record.bytes)
    expect(await readFile(path.join(root.path, (await filesBelow(root.path))[0] as string), 'utf8')).toBe('partial evidence')
  })
})
