import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import { RELATIVE_PATH_PATTERN, parseDiagnosis, parseEvidenceBundle } from '../contracts/index.js'
import type { Diagnosis, EvidenceBundle, GateOutcome } from '../contracts/index.js'
import { validateCitations } from '../evidence/ids.js'
import { failGate, passGate, unevaluableGate } from '../verify/gates.js'

// Candidate guards. Untrusted model output becomes an applicable candidate only when its strict
// diagnosis contract, every citation, its one-file patch form and size, its single permitted
// target, and `git apply --check` against the original HEAD all pass. Nothing here applies the
// patch, and gate messages never echo model text, paths, or Git output.

export const MAX_DIFF_BYTES = 20_000
const GIT_APPLY_TIMEOUT_MS = 10_000
const MAX_GIT_OUTPUT_BYTES = 64 * 1024

export interface CandidateValidationInput {
  readonly runId: string
  /** Raw, untrusted transport output. */
  readonly diagnosis: unknown
  readonly failureBundle: EvidenceBundle
  /** The scenario's `permitted_source_paths`, repository-relative. */
  readonly permittedSourcePaths: readonly string[]
  /** Checkout at the original HEAD where only `git apply --check` may run. */
  readonly checkoutRoot: string
}

export interface ValidatedCandidate {
  readonly target_path: string
  readonly unified_diff: string
  readonly evidence_ids: readonly string[]
}

export interface CandidateValidation {
  /** The strict-schema diagnosis, or null when the output violates the diagnosis contract. */
  readonly diagnosis: Diagnosis | null
  /** `citations_valid` */
  readonly citations: GateOutcome
  /** `patch_scope_valid` */
  readonly scope: GateOutcome
  /** Present only when both guards pass. */
  readonly candidate: ValidatedCandidate | null
}

type PatchFormCode =
  | 'PATCH_MULTI_FILE'
  | 'PATCH_PATH_ABSOLUTE'
  | 'PATCH_PATH_PARENT'
  | 'PATCH_PATH_INVALID'
  | 'PATCH_RENAME'
  | 'PATCH_SYMLINK'
  | 'PATCH_BINARY'
  | 'PATCH_GRAMMAR_INVALID'

// When one diff breaks several form rules, the first listed code is reported.
const FORM_PRECEDENCE: readonly PatchFormCode[] = [
  'PATCH_MULTI_FILE',
  'PATCH_PATH_ABSOLUTE',
  'PATCH_PATH_PARENT',
  'PATCH_PATH_INVALID',
  'PATCH_RENAME',
  'PATCH_SYMLINK',
  'PATCH_BINARY',
  'PATCH_GRAMMAR_INVALID',
]

const SCOPE_MESSAGES = {
  PATCH_MULTI_FILE: 'The candidate diff must contain exactly one file section.',
  PATCH_PATH_ABSOLUTE: 'The candidate diff names an absolute path.',
  PATCH_PATH_PARENT: 'The candidate diff names a path with a parent-directory segment.',
  PATCH_PATH_INVALID: 'The candidate diff names a non-canonical path.',
  PATCH_RENAME: 'The candidate diff renames or copies a file.',
  PATCH_SYMLINK: 'The candidate diff targets or creates a symbolic link.',
  PATCH_BINARY: 'The candidate diff contains binary content.',
  PATCH_GRAMMAR_INVALID: 'The candidate diff is not a one-file text modification in unified diff form.',
  PATCH_TOO_LARGE: `The candidate diff exceeds ${MAX_DIFF_BYTES} bytes.`,
  PATCH_TARGET_NOT_PERMITTED: 'The candidate diff targets a file outside the permitted source boundary.',
  PATCH_APPLY_CHECK_FAILED: 'git apply --check rejected the candidate diff against the original HEAD.',
  PATCH_CHECK_UNAVAILABLE: 'git apply --check could not run against the original HEAD checkout.',
  PERMITTED_SOURCE_INVALID: 'The permitted source boundary is unavailable.',
  DIAGNOSIS_CONTRACT_INVALID: 'The model response violates the strict diagnosis contract.',
} as const

type ScopeCode = keyof typeof SCOPE_MESSAGES

const CITATION_MESSAGES = {
  CITATION_REQUIRED: 'The diagnosis cites no evidence.',
  CITATION_MALFORMED: 'A citation is not a well-formed Evidence ID.',
  CITATION_DUPLICATE: 'A citation repeats an Evidence ID.',
  CITATION_REPLAY_PHASE: 'A citation refers to replay evidence instead of failure evidence.',
  CITATION_CROSS_RUN: "The citations were checked against another run's failure evidence.",
  CITATION_UNKNOWN_EVIDENCE_ID: "A cited Evidence ID does not exist in this run's failure evidence.",
  DIAGNOSIS_CONTRACT_INVALID: 'The model response violates the strict diagnosis contract.',
  FAILURE_BUNDLE_INVALID: 'The failure Evidence Bundle is unavailable or invalid.',
} as const

// ---------------------------------------------------------------------------------------
// Patch form
// ---------------------------------------------------------------------------------------

type PatchForm = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly code: PatchFormCode }

const DIFF_HEADER = 'diff --git '
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/
const INDEX_LINE = /^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: ([0-7]{6}))?$/
const MODE_LINE = /^(?:old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/
const RENAME_LINE = /^(?:rename from |rename to |copy from |copy to |similarity index |dissimilarity index )/
const REGULAR_MODES = new Set(['100644', '100755'])
const SYMLINK_MODE = '120000'

/** Adds the form finding for a path that is not a plain repository-relative file path. */
function checkPath(candidate: string, findings: Set<PatchFormCode>): void {
  if (candidate.startsWith('/')) findings.add('PATCH_PATH_ABSOLUTE')
  const segments = candidate.split('/')
  if (segments.includes('..')) findings.add('PATCH_PATH_PARENT')
  if (!RELATIVE_PATH_PATTERN.test(candidate) || segments.some((segment) => segment === '' || segment === '.' || /["\\]/.test(segment))) {
    findings.add('PATCH_PATH_INVALID')
  }
}

/** The path of a `diff --git a/<path> b/<path>` header naming one file, or null. */
function headerPath(line: string): string | null {
  const rest = line.slice(DIFF_HEADER.length)
  const size = (rest.length - 5) / 2
  if (!Number.isInteger(size) || size < 1) return null
  const candidate = rest.slice(2, 2 + size)
  return rest === `a/${candidate} b/${candidate}` ? candidate : null
}

/** A `--- a/<path>` or `+++ b/<path>` line's path; `/dev/null` and other forms are null. */
function markerPath(line: string | undefined, marker: '---' | '+++'): string | null {
  const prefix = `${marker} ${marker === '---' ? 'a' : 'b'}/`
  return line?.startsWith(prefix) ? line.slice(prefix.length) : null
}

/** Inspects one file section and returns the path it modifies, recording every form finding. */
function inspectSection(lines: readonly string[], findings: Set<PatchFormCode>): string | null {
  const declared = headerPath(lines[0] ?? '')
  if (declared === null) findings.add('PATCH_GRAMMAR_INVALID')
  else checkPath(declared, findings)

  let index = 1
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('--- ') || line.startsWith('@@')) break
    const indexLine = INDEX_LINE.exec(line)
    if (indexLine) {
      const mode = indexLine[1]
      if (mode === SYMLINK_MODE) findings.add('PATCH_SYMLINK')
      else if (mode !== undefined && !REGULAR_MODES.has(mode)) findings.add('PATCH_GRAMMAR_INVALID')
      continue
    }
    const modeLine = MODE_LINE.exec(line)
    if (modeLine) {
      // Mode changes, creation, and deletion are not one-file text modifications.
      findings.add(modeLine[1] === SYMLINK_MODE ? 'PATCH_SYMLINK' : 'PATCH_GRAMMAR_INVALID')
      continue
    }
    if (RENAME_LINE.test(line)) {
      findings.add('PATCH_RENAME')
      const renamed = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line)?.[1]
      if (renamed !== undefined) checkPath(renamed, findings)
      continue
    }
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
      findings.add('PATCH_BINARY')
      return declared
    }
    findings.add('PATCH_GRAMMAR_INVALID')
  }

  const oldPath = markerPath(lines[index], '---')
  const newPath = markerPath(lines[index + 1], '+++')
  if (oldPath === null || newPath === null) {
    findings.add('PATCH_GRAMMAR_INVALID')
    return declared
  }
  checkPath(oldPath, findings)
  checkPath(newPath, findings)
  if (oldPath !== newPath) findings.add('PATCH_RENAME')
  else if (declared !== null && oldPath !== declared) findings.add('PATCH_GRAMMAR_INVALID')
  index += 2

  // Hunks: the header counts must match the lines exactly, as `git apply` reads them.
  let hunks = 0
  let changes = 0
  while (index < lines.length) {
    // Blank lines after the last complete hunk carry no change.
    if (lines.slice(index).every((line) => line === '')) break
    const hunk = HUNK_HEADER.exec(lines[index] ?? '')
    if (!hunk) {
      // `git apply` reads a `---` line after a complete hunk as another file's patch.
      findings.add(lines[index]?.startsWith('--- ') ? 'PATCH_MULTI_FILE' : 'PATCH_GRAMMAR_INVALID')
      return declared
    }
    index += 1
    hunks += 1
    let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
    let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[index]
      if (line === undefined) {
        findings.add('PATCH_GRAMMAR_INVALID')
        return declared
      }
      const tag = line[0]
      if (tag === undefined || tag === ' ') {
        // An empty line is an empty context line, as `git apply` treats it.
        oldLeft -= 1
        newLeft -= 1
      } else if (tag === '-') {
        oldLeft -= 1
        changes += 1
      } else if (tag === '+') {
        newLeft -= 1
        changes += 1
      } else if (!line.startsWith('\\ ')) {
        findings.add('PATCH_GRAMMAR_INVALID')
        return declared
      }
      if (oldLeft < 0 || newLeft < 0) {
        findings.add('PATCH_GRAMMAR_INVALID')
        return declared
      }
      index += 1
    }
    if (lines[index]?.startsWith('\\ ')) index += 1
  }
  if (hunks === 0 || changes === 0) findings.add('PATCH_GRAMMAR_INVALID')
  return declared
}

/** Parses the strict one-file modification grammar and reports the highest-precedence violation. */
function inspectPatchForm(diff: string): PatchForm {
  // Character checks come first: NUL is binary content, and tabs and newlines are the only
  // control characters a text patch for this source may carry.
  if (diff.includes('\0')) return { ok: false, code: 'PATCH_BINARY' }
  if (/[\u0001-\u0008\u000b-\u001f\u007f]/.test(diff)) return { ok: false, code: 'PATCH_GRAMMAR_INVALID' }

  const findings = new Set<PatchFormCode>()
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const starts = lines.flatMap((line, index) => (line.startsWith(DIFF_HEADER) ? [index] : []))
  if (starts[0] !== 0) findings.add('PATCH_GRAMMAR_INVALID')
  if (starts.length > 1) findings.add('PATCH_MULTI_FILE')
  const paths = starts.map((start, position) => inspectSection(lines.slice(start, starts[position + 1] ?? lines.length), findings))

  const code = FORM_PRECEDENCE.find((candidate) => findings.has(candidate))
  if (code !== undefined) return { ok: false, code }
  const [only] = paths
  return paths.length === 1 && typeof only === 'string' ? { ok: true, path: only } : { ok: false, code: 'PATCH_GRAMMAR_INVALID' }
}

// ---------------------------------------------------------------------------------------
// Checkout inspection and `git apply --check`
// ---------------------------------------------------------------------------------------

type TargetState = 'regular' | 'symlink' | 'absent' | 'unavailable'

/** Refuses a target reached through, or being, a symbolic link in the original-HEAD checkout. */
async function inspectTarget(checkoutRoot: string, relative: string): Promise<TargetState> {
  let current: string
  try {
    current = await realpath(checkoutRoot)
  } catch {
    return 'unavailable'
  }
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) return 'symlink'
    } catch {
      return 'absent'
    }
  }
  return 'regular'
}

type ApplyCheck =
  | { readonly status: 'applicable'; readonly records: readonly string[] }
  | { readonly status: 'rejected' }
  | { readonly status: 'unavailable' }

// Git inherits no `GIT_*` overrides, credentials, or system and global configuration; only the
// checkout's own repository configuration applies.
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
})

/** Runs `git apply --check --numstat -z` with the patch on stdin; it never writes the checkout. */
function gitApplyCheck(checkoutRoot: string, patch: string): Promise<ApplyCheck> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: ApplyCheck): void => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    const child = spawn('git', ['apply', '--check', '--numstat', '-z', '-'], {
      cwd: checkoutRoot,
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: GIT_APPLY_TIMEOUT_MS,
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_GIT_OUTPUT_BYTES) chunks.push(chunk)
    })
    child.on('error', () => settle({ status: 'unavailable' }))
    child.on('close', (code, signal) => {
      if (code === 0 && size <= MAX_GIT_OUTPUT_BYTES) {
        settle({ status: 'applicable', records: Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) })
      } else if (code !== null && code !== 0 && signal === null) {
        settle({ status: 'rejected' })
      } else {
        settle({ status: 'unavailable' })
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(patch)
  })
}

// ---------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------

function rawUnifiedDiff(output: unknown): string | null {
  try {
    const candidate = typeof output === 'object' && output !== null ? (output as { candidate?: unknown }).candidate : undefined
    const diff = typeof candidate === 'object' && candidate !== null ? (candidate as { unified_diff?: unknown }).unified_diff : undefined
    return typeof diff === 'string' ? diff : null
  } catch {
    return null
  }
}

function readFailureBundle(bundle: unknown): EvidenceBundle | null {
  const parsed = parseEvidenceBundle(bundle)
  return parsed.ok && parsed.value.phase === 'failure' ? parsed.value : null
}

function readPermittedPaths(paths: unknown): readonly string[] | null {
  if (!Array.isArray(paths) || paths.length === 0) return null
  return paths.every((entry) => typeof entry === 'string' && RELATIVE_PATH_PATTERN.test(entry)) ? (paths as string[]) : null
}

function checkCitations(runId: string, bundle: EvidenceBundle | null, diagnosis: Diagnosis | null): GateOutcome {
  if (bundle === null) {
    return unevaluableGate('citations_valid', 'FAILURE_BUNDLE_INVALID', { message: CITATION_MESSAGES.FAILURE_BUNDLE_INVALID })
  }
  if (diagnosis === null) {
    return failGate('citations_valid', 'DIAGNOSIS_CONTRACT_INVALID', { message: CITATION_MESSAGES.DIAGNOSIS_CONTRACT_INVALID })
  }
  // A claim and the candidate may cite the same item; each identifier is validated once.
  const cited = [...new Set([...diagnosis.claims.flatMap((claim) => claim.evidence_ids), ...diagnosis.candidate.evidence_ids])]
  const result = validateCitations({ runId, failureBundle: bundle, citedIds: cited })
  const accepted = new Set(result.accepted)
  const evidenceIds = bundle.items.map((item) => item.evidence_id).filter((id) => accepted.has(id))
  const metrics = { cited: cited.length, accepted: result.accepted.length, rejected: result.rejected.length }
  const [rejection] = result.rejected
  if (rejection === undefined) {
    return passGate('citations_valid', {
      reason_code: 'CITATIONS_VALID',
      evidence_ids: evidenceIds,
      metrics,
      message: "Every cited Evidence ID exists in this run's failure evidence.",
    })
  }
  return failGate('citations_valid', rejection.reason, {
    evidence_ids: evidenceIds,
    metrics,
    message: CITATION_MESSAGES[rejection.reason],
  })
}

async function checkScope(input: CandidateValidationInput, diagnosis: Diagnosis | null, bundle: EvidenceBundle | null): Promise<GateOutcome> {
  // The scope gate cites this run's source evidence, which records the permitted file.
  const evidenceIds =
    bundle !== null && bundle.run_id === input.runId ? bundle.items.filter((item) => item.type === 'source').map((item) => item.evidence_id) : []
  const rawDiff = rawUnifiedDiff(input.diagnosis)
  const metrics = rawDiff === null ? {} : { diff_bytes: Buffer.byteLength(rawDiff, 'utf8') }
  const fail = (code: ScopeCode): GateOutcome => failGate('patch_scope_valid', code, { evidence_ids: evidenceIds, metrics, message: SCOPE_MESSAGES[code] })
  const unevaluable = (code: ScopeCode): GateOutcome =>
    unevaluableGate('patch_scope_valid', code, { evidence_ids: evidenceIds, metrics, message: SCOPE_MESSAGES[code] })

  // Size is measured on the raw text, so an oversized diff reports its size even though it also
  // breaks the diagnosis contract.
  if (rawDiff !== null && Buffer.byteLength(rawDiff, 'utf8') > MAX_DIFF_BYTES) return fail('PATCH_TOO_LARGE')
  if (diagnosis === null) return unevaluable('DIAGNOSIS_CONTRACT_INVALID')
  const permitted = readPermittedPaths(input.permittedSourcePaths)
  if (permitted === null) return unevaluable('PERMITTED_SOURCE_INVALID')

  const { unified_diff: diff, target_paths: targets } = diagnosis.candidate
  const form = inspectPatchForm(diff)
  if (!form.ok) return fail(form.code)
  const [declared] = targets
  if (declared === undefined || targets.length !== 1 || !permitted.includes(declared) || form.path !== declared) {
    return fail('PATCH_TARGET_NOT_PERMITTED')
  }

  if (typeof input.checkoutRoot !== 'string' || !path.isAbsolute(input.checkoutRoot)) return unevaluable('PATCH_CHECK_UNAVAILABLE')
  const target = await inspectTarget(input.checkoutRoot, declared)
  if (target === 'unavailable') return unevaluable('PATCH_CHECK_UNAVAILABLE')
  if (target === 'symlink') return fail('PATCH_SYMLINK')

  const check = await gitApplyCheck(input.checkoutRoot, diff)
  if (check.status === 'unavailable') return unevaluable('PATCH_CHECK_UNAVAILABLE')
  if (check.status === 'rejected') return fail('PATCH_APPLY_CHECK_FAILED')
  // Git's own reading of the patch must touch exactly the declared text file.
  const [record] = check.records
  const touched = record === undefined ? null : /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record)
  if (check.records.length !== 1 || touched === null) return fail('PATCH_GRAMMAR_INVALID')
  if (touched[1] === '-' || touched[2] === '-') return fail('PATCH_BINARY')
  if (touched[3] !== declared) return fail('PATCH_TARGET_NOT_PERMITTED')

  return passGate('patch_scope_valid', {
    reason_code: 'PATCH_SCOPE_VALID',
    evidence_ids: evidenceIds,
    metrics,
    message: 'The candidate is a one-file text diff of the permitted source that git apply --check accepts.',
  })
}

/**
 * Validates untrusted transport output against the strict diagnosis contract, this run's failure
 * evidence, the permitted source boundary, and `git apply --check`. Both gates are always
 * evaluated so every failure is reported; the candidate exists only when both pass.
 */
export async function validateCandidate(input: CandidateValidationInput): Promise<CandidateValidation> {
  const parsed = parseDiagnosis(input.diagnosis)
  const diagnosis = parsed.ok ? parsed.value : null
  const bundle = readFailureBundle(input.failureBundle)
  const citations = checkCitations(input.runId, bundle, diagnosis)
  const scope = await checkScope(input, diagnosis, bundle)
  const [targetPath] = diagnosis?.candidate.target_paths ?? []
  const candidate =
    diagnosis !== null && targetPath !== undefined && citations.status === 'pass' && scope.status === 'pass'
      ? Object.freeze({
          target_path: targetPath,
          unified_diff: diagnosis.candidate.unified_diff,
          evidence_ids: Object.freeze([...diagnosis.candidate.evidence_ids]),
        })
      : null
  return Object.freeze({ diagnosis, citations, scope, candidate })
}
