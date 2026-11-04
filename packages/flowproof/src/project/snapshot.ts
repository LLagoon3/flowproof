import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createProjectTempDirectory } from '../evidence/projectStore.js'
import { readCommittedBlobs } from './admission.js'
import type { AdmittedFile, AdmittedProject } from './admission.js'

// Scrubbed committed snapshots (Spec 006 T015). Each snapshot is a new owner-only temporary
// directory outside the selected repository holding two siblings:
//
//   workspace/  exactly the admitted committed regular files, read from the original object
//               database without filters and verified against their blob IDs and SHA-256 digests.
//               This is the only directory a runtime mounts (read-only).
//   private/    host-only frozen metadata (the baseline manifest and, for a candidate copy, the
//               private Git state); never mounted.
//
// Nothing else is exported: no `.git`, history, credentials, untracked or ignored files, and never
// the original `node_modules`. The runtime may register its own entries (the prepared dependency
// link and the output mount point); `verify` accepts only those beyond the expected files.

export type SnapshotPurpose = 'admission-snapshot' | 'candidate-copy'

export interface SnapshotVerification {
  readonly ok: boolean
  readonly changed: readonly string[]
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
}

export interface ProjectSnapshot {
  /** The owned temporary root (0700). */
  readonly root: string
  /** The exported committed tree; the only runtime mount source. */
  readonly workspace: string
  /** Host-only metadata outside every runtime mount. */
  readonly privateDir: string
  readonly purpose: SnapshotPurpose
  readonly baselineCommit: string
  /** The files the workspace held when it was exported. */
  readonly files: readonly AdmittedFile[]
  /** Registers a runtime-owned workspace entry (`node_modules` link or output mount point). */
  allowRuntimeEntry(relative: string): void
  /** Re-reads the workspace through no-follow paths against `expected` (the exported files by default). */
  verify(expected?: readonly AdmittedFile[]): Promise<SnapshotVerification>
  /** Idempotent removal of exactly this owned directory. */
  remove(): Promise<void>
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function readNoFollow(absolute: string): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null
  } finally {
    await handle.close()
  }
}

/** Exports the admitted committed tree into a new owned snapshot. */
export async function exportProjectSnapshot(options: { readonly project: AdmittedProject; readonly purpose: SnapshotPurpose; readonly tempRoot?: string }): Promise<ProjectSnapshot> {
  const { project, purpose } = options
  const owned = await createProjectTempDirectory({
    purpose,
    protectedRoots: [project.canonicalRoot, project.gitDir],
    ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
  })
  const workspace = path.join(owned.path, 'workspace')
  const privateDir = path.join(owned.path, 'private')
  try {
    await mkdir(workspace, { mode: 0o755 })
    await mkdir(privateDir, { mode: 0o700 })
    const blobs = await readCommittedBlobs(project, project.files)
    for (const file of project.files) {
      const content = blobs.get(file.path)
      if (content === undefined) throw new Error('missing blob')
      const target = path.join(workspace, file.path)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
      await writeFile(target, content, { flag: 'wx', mode: 0o644 })
      await chmod(target, file.mode === '100755' ? 0o755 : 0o644)
    }
    await writeFile(
      path.join(privateDir, 'baseline.json'),
      `${JSON.stringify({ baseline_commit: project.context.baseline_commit, admitted_tree_sha256: project.context.admitted_tree_sha256, files: project.files })}\n`,
      { flag: 'wx', mode: 0o600 },
    )
  } catch (error) {
    await owned.remove()
    throw error
  }

  const runtimeEntries = new Set<string>()
  const files = Object.freeze([...project.files])
  return Object.freeze({
    root: owned.path,
    workspace,
    privateDir,
    purpose,
    baselineCommit: project.context.baseline_commit,
    files,

    allowRuntimeEntry(relative: string): void {
      runtimeEntries.add(relative)
    },

    async verify(expected: readonly AdmittedFile[] = files): Promise<SnapshotVerification> {
      const changed: string[] = []
      const missing: string[] = []
      const unexpected: string[] = []
      const byPath = new Map(expected.map((file) => [file.path, file]))
      const directories = new Set<string>()
      for (const file of expected) {
        const segments = file.path.split('/')
        for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join('/'))
      }
      const seen = new Set<string>()
      const walk = async (relative: string): Promise<void> => {
        const entries = await readdir(path.join(workspace, relative), { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          const child = relative ? `${relative}/${entry.name}` : entry.name
          if (runtimeEntries.has(child)) continue
          const info = await lstat(path.join(workspace, child))
          if (info.isDirectory() && directories.has(child)) {
            await walk(child)
            continue
          }
          const file = byPath.get(child)
          if (file === undefined || !info.isFile()) {
            unexpected.push(child)
            continue
          }
          seen.add(child)
          const content = await readNoFollow(path.join(workspace, child))
          const executable = (info.mode & 0o100) !== 0
          if (content === null || sha256(content) !== file.sha256 || executable !== (file.mode === '100755')) changed.push(child)
        }
      }
      await walk('')
      for (const file of expected) if (!seen.has(file.path)) missing.push(file.path)
      return Object.freeze({ ok: changed.length + missing.length + unexpected.length === 0, changed, missing, unexpected })
    },

    remove: () => owned.remove(),
  })
}
