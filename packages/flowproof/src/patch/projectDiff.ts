import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { containsSecretPattern } from '../evidence/sanitize.js'
import { admittedTreeDigest, blobOid, decodeText } from '../project/admission.js'
import type { AdmittedFile, AdmittedProject } from '../project/admission.js'
import { CandidateSchema, PROJECT_LIMITS, PROJECT_SCHEMA_VERSION, newProjectUuid, projectRelativePathSchema, projectSha256Schema, projectSourcePathSchema, projectUuidSchema } from '../project/contracts.js'
import type { Candidate } from '../project/contracts.js'
import { exportProjectSnapshot } from '../project/snapshot.js'
import type { ProjectSnapshot } from '../project/snapshot.js'

// The bounded multi-file candidate guard and its copy-only application (Spec 006 T039).
//
// `admitProjectPatch` checks one correction's exact UTF-8 bytes before anything is applied: at most
// eight existing admitted non-test source text files under `src/` and 64 KiB, `diff --git` sections
// with identical `a/` and `b/` canonical paths, only an optional `index` header with the admitted
// mode, strictly counted hunks, the declared target paths exactly equal to the changed paths, the
// exact admitted baseline, and no secret-shaped added text. Binary, mode, link, creation, deletion,
// rename and copy changes, protected inputs (configuration, package, lock, entry, tests/checks) and
// unknown paths are refused with fixed reasons. The legacy one-file validator is untouched.
//
// `applyProjectPatch` applies a proposed candidate exactly once, to a new owned copy of the admitted
// baseline, never to the original. A host applier first computes each file's result with exact
// hunk positions and context (no offset, fuzz or repair). Git then applies the same bytes once with
// a private bare object store and index outside the copy's workspace (no hooks, filters, 3-way
// merge, `--reject` or unsafe paths), seeded from the copy itself, so no original object or index
// is written. The private-index diff against the baseline tree must list exactly the changed paths
// with unchanged modes and the expected blob IDs, and the workspace must hold exactly the computed
// bytes; any disagreement, partial result or error rejects the candidate and removes the copy.

export const PATCH_REJECTION_REASONS = [
  'PATCH_PROPOSAL_INVALID',
  'PATCH_BASELINE_MISMATCH',
  'PATCH_EMPTY',
  'PATCH_TOO_LARGE',
  'PATCH_ENCODING_INVALID',
  'PATCH_MALFORMED',
  'PATCH_BINARY',
  'PATCH_MODE_CHANGE',
  'PATCH_FILE_CREATE',
  'PATCH_FILE_DELETE',
  'PATCH_RENAME',
  'PATCH_PATH_INVALID',
  'PATCH_PATH_PROTECTED',
  'PATCH_PATH_NOT_ADMITTED',
  'PATCH_DUPLICATE_FILE',
  'PATCH_TOO_MANY_FILES',
  'PATCH_TARGETS_MISMATCH',
  'PATCH_SECRET_CONTENT',
  'PATCH_CONTEXT_MISMATCH',
  'PATCH_APPLY_REJECTED',
  'PATCH_FIDELITY_MISMATCH',
  'PATCH_NOT_PROPOSED',
  'PATCH_PROPOSAL_UNKNOWN',
  'PATCH_ALREADY_APPLIED',
] as const
export type PatchRejectionReason = (typeof PATCH_REJECTION_REASONS)[number]

export interface PatchProposal {
  readonly runId: string
  readonly baselineCommit: string
  readonly definitionId: string
  readonly definitionDigest: string
  /** The actual correction invocation that produced the patch. */
  readonly invocationId: string
  /** The correction's declared target paths; must equal the changed paths exactly. */
  readonly targetPaths: readonly string[]
  /** The exact UTF-8 unified diff bytes. */
  readonly patch: string | Uint8Array
}

export type PatchAdmission =
  | { readonly state: 'proposed'; readonly candidate: Candidate }
  | { readonly state: 'rejected'; readonly candidate: Candidate | null; readonly reasons: readonly PatchRejectionReason[] }

export type CandidateApplication =
  | {
      readonly state: 'applied-to-copy'
      readonly candidate: Candidate
      /** The new owned candidate copy; the caller owns its removal. */
      readonly copy: ProjectSnapshot
      readonly treeSha256: string
      /** The copy's files after application. */
      readonly files: readonly AdmittedFile[]
    }
  | { readonly state: 'rejected'; readonly candidate: Candidate | null; readonly reasons: readonly PatchRejectionReason[] }

// ---------------------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------------------

interface HunkLine {
  readonly kind: ' ' | '-' | '+'
  readonly text: string
  /** True when this line has no trailing newline in its file (`\ No newline at end of file`). */
  noNewline: boolean
}

interface Hunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: HunkLine[]
}

interface FilePatch {
  readonly path: string
  readonly indexMode: string | null
  readonly hunks: Hunk[]
}

class Refusal extends Error {
  constructor(readonly reason: PatchRejectionReason) {
    super(reason)
  }
}

const refuse = (reason: PatchRejectionReason): never => {
  throw new Refusal(reason)
}

const FORBIDDEN_HEADERS: ReadonlyArray<readonly [RegExp, PatchRejectionReason]> = [
  [/^(?:Binary files |GIT binary patch)/, 'PATCH_BINARY'],
  [/^(?:old mode |new mode )/, 'PATCH_MODE_CHANGE'],
  [/^new file mode /, 'PATCH_FILE_CREATE'],
  [/^deleted file mode /, 'PATCH_FILE_DELETE'],
  [/^(?:similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/, 'PATCH_RENAME'],
]

const HUNK_HEADER = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$/
const INDEX_HEADER = /^index ([a-f0-9]{7,64})\.\.([a-f0-9]{7,64})(?: ([0-7]{6}))?$/

function parsePath(value: string): string {
  if (value.includes('"') || value.includes('\\') || /\s/.test(value)) refuse('PATCH_PATH_INVALID')
  if (!projectRelativePathSchema.safeParse(value).success) refuse('PATCH_PATH_INVALID')
  return value
}

/** Parses the whole diff; the first violation found (in byte order) is the refusal reason. */
function parseDiff(text: string): FilePatch[] {
  if (!text.endsWith('\n')) refuse('PATCH_MALFORMED')
  const lines = text.slice(0, -1).split('\n')
  const files: FilePatch[] = []
  let index = 0
  while (index < lines.length) {
    const header = lines[index] ?? ''
    if (!header.startsWith('diff --git ')) refuse('PATCH_MALFORMED')
    const names = /^diff --git a\/(\S+) b\/(\S+)$/.exec(header)
    if (header.includes('"')) refuse('PATCH_PATH_INVALID')
    index += 1
    // Extended headers: only `index` is allowed; every other kind names a forbidden change.
    let indexMode: string | null = null
    while (index < lines.length && !(lines[index] ?? '').startsWith('--- ') && !(lines[index] ?? '').startsWith('diff --git ')) {
      const line = lines[index] ?? ''
      for (const [pattern, reason] of FORBIDDEN_HEADERS) if (pattern.test(line)) refuse(reason)
      const indexLine = INDEX_HEADER.exec(line)
      if (indexLine === null) refuse('PATCH_MALFORMED')
      indexMode = indexLine?.[3] ?? null
      index += 1
    }
    if (names === null) refuse('PATCH_PATH_INVALID')
    const [, left = '', right = ''] = names as RegExpExecArray
    if (left !== right) refuse('PATCH_PATH_INVALID')
    const file = parsePath(left)
    if (indexMode !== null && indexMode !== '100644' && indexMode !== '100755') refuse('PATCH_MODE_CHANGE')
    const minus = lines[index] ?? ''
    const plus = lines[index + 1] ?? ''
    if (minus === '--- /dev/null') refuse('PATCH_FILE_CREATE')
    if (plus === '+++ /dev/null') refuse('PATCH_FILE_DELETE')
    if (minus !== `--- a/${file}` || plus !== `+++ b/${file}`) refuse(minus.startsWith('--- ') ? 'PATCH_PATH_INVALID' : 'PATCH_MALFORMED')
    index += 2
    const hunks: Hunk[] = []
    let previousEnd = 0
    while (index < lines.length && (lines[index] ?? '').startsWith('@@')) {
      const match = HUNK_HEADER.exec(lines[index] ?? '')
      if (match === null) refuse('PATCH_MALFORMED')
      const [, oldStart = '0', oldCount = '1', newStart = '0', newCount = '1'] = match as RegExpExecArray
      const hunk: Hunk = { oldStart: Number(oldStart), oldCount: Number(oldCount), newStart: Number(newStart), newCount: Number(newCount), lines: [] }
      if (hunk.oldStart === 0 && hunk.oldCount !== 0) refuse('PATCH_MALFORMED')
      if (hunk.oldStart < previousEnd || (hunk.oldCount === 0 && hunk.newCount === 0)) refuse('PATCH_MALFORMED')
      index += 1
      let oldSeen = 0
      let newSeen = 0
      while (index < lines.length && (oldSeen < hunk.oldCount || newSeen < hunk.newCount || lines[index] === '\\ No newline at end of file')) {
        const line = lines[index] ?? ''
        if (line === '\\ No newline at end of file') {
          const last = hunk.lines[hunk.lines.length - 1]
          if (last === undefined || last.noNewline) refuse('PATCH_MALFORMED')
          ;(last as HunkLine).noNewline = true
          index += 1
          continue
        }
        const kind = line[0]
        if (kind !== ' ' && kind !== '-' && kind !== '+') refuse('PATCH_MALFORMED')
        if (kind !== '+') oldSeen += 1
        if (kind !== '-') newSeen += 1
        hunk.lines.push({ kind: kind as HunkLine['kind'], text: line.slice(1), noNewline: false })
        index += 1
      }
      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) refuse('PATCH_MALFORMED')
      if (!hunk.lines.some((line) => line.kind !== ' ')) refuse('PATCH_MALFORMED')
      previousEnd = hunk.oldStart + hunk.oldCount
      hunks.push(hunk)
    }
    if (hunks.length === 0) refuse('PATCH_MALFORMED')
    files.push({ path: file, indexMode, hunks })
  }
  if (files.length === 0) refuse('PATCH_MALFORMED')
  return files
}

// ---------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------

interface ParsedProposal {
  readonly projectId: string
  readonly bytes: Buffer
  readonly files: readonly FilePatch[]
  readonly candidate: Candidate
}

const PROPOSALS = new WeakMap<object, ParsedProposal>()
const APPLIED = new WeakSet<object>()

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

function candidateOf(input: {
  readonly proposal: PatchProposal
  readonly bytes: Buffer
  readonly paths: readonly string[]
  readonly state: Candidate['state']
  readonly reasons: readonly PatchRejectionReason[]
  readonly candidateId?: string
  readonly expectedTree?: string | null
}): Candidate | null {
  const parsed = CandidateSchema.safeParse({
    schema_version: PROJECT_SCHEMA_VERSION,
    candidate_id: input.candidateId ?? newProjectUuid(),
    run_id: input.proposal.runId,
    baseline_commit: input.proposal.baselineCommit,
    definition_id: input.proposal.definitionId,
    definition_digest: input.proposal.definitionDigest,
    invocation_id: input.proposal.invocationId,
    state: input.state,
    patch_sha256: sha256(input.bytes),
    patch_bytes: input.bytes.length,
    changed_paths: [...input.paths].sort(),
    expected_tree_sha256: input.expectedTree ?? null,
    build_sha256: null,
    rejection_reasons: input.state === 'rejected' ? [...input.reasons] : [],
  })
  return parsed.success ? Object.freeze(parsed.data) : null
}

function rejected(reasons: readonly PatchRejectionReason[], candidate: Candidate | null): PatchAdmission & { readonly state: 'rejected' } {
  return Object.freeze({ state: 'rejected', candidate, reasons: Object.freeze([...new Set(reasons)]) })
}

/** Checks one correction's exact bytes against the admitted project; applies nothing. */
export function admitProjectPatch(project: AdmittedProject, proposal: PatchProposal): PatchAdmission {
  const identities = [proposal?.runId, proposal?.definitionId, proposal?.invocationId].every((value) => projectUuidSchema.safeParse(value).success)
  const bytes = typeof proposal?.patch === 'string' ? Buffer.from(proposal.patch, 'utf8') : proposal?.patch instanceof Uint8Array ? Buffer.from(proposal.patch) : null
  if (!identities || !projectSha256Schema.safeParse(proposal.definitionDigest).success || bytes === null || !Array.isArray(proposal.targetPaths)) {
    return rejected(['PATCH_PROPOSAL_INVALID'], null)
  }
  const reject = (reason: PatchRejectionReason, paths: readonly string[] = []): PatchAdmission =>
    rejected([reason], paths.length > 0 ? candidateOf({ proposal, bytes, paths, state: 'rejected', reasons: [reason] }) : null)

  if (proposal.baselineCommit !== project.context.baseline_commit) return reject('PATCH_BASELINE_MISMATCH')
  if (bytes.length === 0) return reject('PATCH_EMPTY')
  if (bytes.length > PROJECT_LIMITS.maxPatchBytes) return reject('PATCH_TOO_LARGE')
  const text = decodeText(bytes)
  if (text === null) return reject('PATCH_ENCODING_INVALID')

  let files: FilePatch[]
  try {
    files = parseDiff(text)
  } catch (error) {
    if (error instanceof Refusal) return reject(error.reason)
    throw error
  }
  const paths = files.map((file) => file.path)
  if (new Set(paths).size !== paths.length) return reject('PATCH_DUPLICATE_FILE')
  const protectedPaths = new Set(project.context.protected_inputs.map((input) => input.path))
  if (paths.some((file) => protectedPaths.has(file))) return reject('PATCH_PATH_PROTECTED')
  const allowed = new Set(project.context.allowed_source_paths)
  if (paths.some((file) => !allowed.has(file) || !projectSourcePathSchema.safeParse(file).success)) return reject('PATCH_PATH_NOT_ADMITTED')
  const admittedModes = new Map(project.files.map((file) => [file.path, file.mode]))
  if (files.some((file) => file.indexMode !== null && file.indexMode !== admittedModes.get(file.path))) return reject('PATCH_MODE_CHANGE', paths)
  if (paths.length > PROJECT_LIMITS.maxPatchFiles) return reject('PATCH_TOO_MANY_FILES')
  const targets = [...proposal.targetPaths]
  if (new Set(targets).size !== targets.length || targets.length !== paths.length || targets.some((target) => !paths.includes(target))) {
    return reject('PATCH_TARGETS_MISMATCH', paths)
  }
  const added = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === '+').map((line) => line.text)))
  if (containsSecretPattern(added.join('\n'))) return reject('PATCH_SECRET_CONTENT', paths)

  const candidate = candidateOf({ proposal, bytes, paths, state: 'proposed', reasons: [] })
  if (candidate === null) return reject('PATCH_PROPOSAL_INVALID')
  const admission = Object.freeze({ state: 'proposed' as const, candidate })
  PROPOSALS.set(admission, Object.freeze({ projectId: project.context.project_id, bytes, files: Object.freeze(files), candidate }))
  return admission
}

// ---------------------------------------------------------------------------------------
// Exact host application
// ---------------------------------------------------------------------------------------

interface SourceLine {
  readonly text: string
  readonly newline: boolean
}

function splitLines(content: string): SourceLine[] {
  if (content === '') return []
  const parts = content.split('\n')
  const last = parts.pop() as string
  const lines = parts.map((text) => ({ text, newline: true }))
  if (last !== '') lines.push({ text: last, newline: false })
  return lines
}

/** Applies hunks at their exact stated positions; any context or removed-line mismatch refuses. */
function applyExactly(content: string, hunks: readonly Hunk[]): string {
  const source = splitLines(content)
  const result: SourceLine[] = []
  let cursor = 0
  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < cursor || start > source.length) refuse('PATCH_CONTEXT_MISMATCH')
    result.push(...source.slice(cursor, start))
    let position = start
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        result.push({ text: line.text, newline: !line.noNewline })
        continue
      }
      const actual = source[position]
      if (actual === undefined || actual.text !== line.text || actual.newline === line.noNewline) refuse('PATCH_CONTEXT_MISMATCH')
      if (line.kind === ' ') result.push({ text: line.text, newline: !line.noNewline })
      position += 1
    }
    // The new-side position must agree with the result so far: no offset is tolerated.
    if (hunk.newCount > 0 && hunk.newStart - 1 !== result.length - hunk.lines.filter((line) => line.kind !== '-').length) refuse('PATCH_CONTEXT_MISMATCH')
    cursor = position
  }
  result.push(...source.slice(cursor))
  if (result.slice(0, -1).some((line) => !line.newline)) refuse('PATCH_MALFORMED')
  return result.map((line) => `${line.text}${line.newline ? '\n' : ''}`).join('')
}

// ---------------------------------------------------------------------------------------
// Private Git application
// ---------------------------------------------------------------------------------------

const PRIVATE_GIT_TIMEOUT_MS = 60_000

function privateGitEnvironment(gitDir: string, workTree: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    LC_ALL: 'C',
  }
}

const PRIVATE_GIT_SAFETY = [
  '-c',
  'core.bare=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.symlinks=false',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'apply.whitespace=nowarn',
] as const

function privateGit(gitDir: string, workTree: string, args: readonly string[], input?: Buffer): Promise<{ readonly code: number | null; readonly stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn('git', [...PRIVATE_GIT_SAFETY, ...args], { cwd: workTree, env: privateGitEnvironment(gitDir, workTree), stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), PRIVATE_GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', () => undefined)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(chunks) })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function initPrivateRepository(gitDir: string, format: 'sha1' | 'sha256'): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, gitDir],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, timeout: PRIVATE_GIT_TIMEOUT_MS, shell: false },
      (error) => resolve(error === null),
    )
  })
}

interface RawChange {
  readonly oldMode: string
  readonly newMode: string
  readonly newOid: string
  readonly status: string
  readonly path: string
}

function parseRawDiff(stdout: Buffer): RawChange[] | null {
  const records = stdout.toString('utf8').split('\0')
  if (records.pop() !== '') return null
  if (records.length % 2 !== 0) return null
  const changes: RawChange[] = []
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]{40,64} ([a-f0-9]{40,64}) ([A-Z])$/.exec(records[index] ?? '')
    if (match === null) return null
    changes.push({ oldMode: match[1] ?? '', newMode: match[2] ?? '', newOid: match[3] ?? '', status: match[4] ?? '', path: records[index + 1] ?? '' })
  }
  return changes
}

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

/**
 * Applies a proposed candidate exactly once to a new owned copy of the admitted baseline. The
 * original repository, its index and object database are never written.
 */
export async function applyProjectPatch(project: AdmittedProject, admission: PatchAdmission): Promise<CandidateApplication> {
  if (admission?.state !== 'proposed') return rejected(['PATCH_NOT_PROPOSED'], admission?.state === 'rejected' ? admission.candidate : null)
  const parsed = PROPOSALS.get(admission)
  if (parsed === undefined) return rejected(['PATCH_PROPOSAL_UNKNOWN'], null)
  if (APPLIED.has(admission)) return rejected(['PATCH_ALREADY_APPLIED'], null)
  APPLIED.add(admission)
  const { candidate } = parsed
  const refusal = (reason: PatchRejectionReason): CandidateApplication =>
    rejected(
      [reason],
      CandidateSchema.parse({ ...candidate, state: 'rejected', expected_tree_sha256: null, build_sha256: null, rejection_reasons: [reason] }),
    )
  if (parsed.projectId !== project.context.project_id || candidate.baseline_commit !== project.context.baseline_commit) return refusal('PATCH_BASELINE_MISMATCH')

  const copy = await exportProjectSnapshot({ project, purpose: 'candidate-copy' })
  const fail = async (reason: PatchRejectionReason): Promise<CandidateApplication> => {
    await copy.remove()
    return refusal(reason)
  }
  try {
    // 1. Host-computed exact results from the copy's verified baseline bytes.
    const byPath = new Map(project.files.map((file) => [file.path, file]))
    const results = new Map<string, Buffer>()
    for (const file of parsed.files) {
      const admitted = byPath.get(file.path)
      const baseline = await readNoFollow(path.join(copy.workspace, file.path))
      if (admitted === undefined || baseline === null || sha256(baseline) !== admitted.sha256) return await fail('PATCH_BASELINE_MISMATCH')
      const before = decodeText(baseline)
      if (before === null) return await fail('PATCH_ENCODING_INVALID')
      let after: string
      try {
        after = applyExactly(before, file.hunks)
      } catch (error) {
        if (error instanceof Refusal) return await fail(error.reason)
        throw error
      }
      const bytes = Buffer.from(after, 'utf8')
      if (decodeText(bytes) === null) return await fail('PATCH_ENCODING_INVALID')
      if (containsSecretPattern(after)) return await fail('PATCH_SECRET_CONTENT')
      results.set(file.path, bytes)
    }

    // 2. One Git application through a private object store and index outside the workspace.
    const gitDir = path.join(copy.privateDir, 'git')
    if (!(await initPrivateRepository(gitDir, project.objectFormat))) return await fail('PATCH_APPLY_REJECTED')
    const git = (args: readonly string[], input?: Buffer) => privateGit(gitDir, copy.workspace, args, input)
    if ((await git(['add', '--all', '--force', '--', '.'])).code !== 0) return await fail('PATCH_APPLY_REJECTED')
    const tree = await git(['write-tree'])
    if (tree.code !== 0 || tree.stdout.toString('utf8').trim() !== project.treeOid) return await fail('PATCH_BASELINE_MISMATCH')
    if ((await git(['apply', '--check', '--index', '--whitespace=nowarn', '-'], parsed.bytes)).code !== 0) return await fail('PATCH_APPLY_REJECTED')
    if ((await git(['apply', '--index', '--whitespace=nowarn', '-'], parsed.bytes)).code !== 0) return await fail('PATCH_APPLY_REJECTED')

    // 3. The private-index change set and the workspace bytes must be exactly the computed result.
    const raw = await git(['diff-index', '--cached', '-z', '--raw', '--no-renames', project.treeOid])
    const changes = raw.code === 0 ? parseRawDiff(raw.stdout) : null
    if (changes === null || changes.length !== results.size) return await fail('PATCH_FIDELITY_MISMATCH')
    for (const change of changes) {
      const expected = results.get(change.path)
      const admitted = byPath.get(change.path)
      if (
        expected === undefined ||
        admitted === undefined ||
        change.status !== 'M' ||
        change.oldMode !== admitted.mode ||
        change.newMode !== admitted.mode ||
        change.newOid !== blobOid(project.objectFormat, expected)
      ) {
        return await fail('PATCH_FIDELITY_MISMATCH')
      }
    }
    const files = project.files.map((file) => {
      const bytes = results.get(file.path)
      return bytes === undefined ? file : Object.freeze({ ...file, oid: blobOid(project.objectFormat, bytes), sha256: sha256(bytes), size: bytes.length, text: true })
    })
    const verification = await copy.verify(files)
    if (!verification.ok) return await fail('PATCH_FIDELITY_MISMATCH')

    const treeSha256 = admittedTreeDigest(files)
    await writeFile(path.join(copy.privateDir, 'candidate.json'), `${JSON.stringify({ candidate_id: candidate.candidate_id, tree_sha256: treeSha256, files })}\n`, { flag: 'wx', mode: 0o600 })
    const candidateCopy = copy.withExpectedCandidate(files)
    if (!(await candidateCopy.verify()).ok) return await fail('PATCH_FIDELITY_MISMATCH')
    const applied = CandidateSchema.parse({ ...candidate, state: 'applied-to-copy', expected_tree_sha256: treeSha256, build_sha256: null, rejection_reasons: [] })
    return Object.freeze({ state: 'applied-to-copy', candidate: Object.freeze(applied), copy: candidateCopy, treeSha256, files: Object.freeze(files) })
  } catch (error) {
    await copy.remove()
    throw error
  }
}
