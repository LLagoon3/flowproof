import { describe, expect, it } from 'vitest'

import {
  CANDIDATE_FILE_FIELDS,
  CANDIDATE_FIELDS,
  CAPTURE_REASON_CODES,
  CAPTURE_REASON_MESSAGES,
  CAPTURE_STATUSES,
  CaptureContractError,
  SUBMODULE_COVERAGE_NOTE,
  capturedResult,
  createCandidate,
  failedResult,
  noChangesResult,
  notAttemptedResult,
  rejectedResult,
  repositoryCoverage,
  validateCapturingSessionResult,
} from '../../packages/flowproof/src/editing/capture.js'
import type { CandidateFileInput, CaptureResult } from '../../packages/flowproof/src/editing/capture.js'
import { EDITING_SESSION_RESULT_FIELDS, V1_LIMIT_BOUNDS } from '../../packages/flowproof/src/editing/contracts.js'
import type { EditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'

// T002/T003 (specs/003-capture-editing-candidate): the opt-in capture result. A capturing session
// resolves `{ session, capture }`; `session` is the unchanged Spec 002 lifecycle result and
// `capture` is one of five statuses. Only `captured` carries candidate bytes, and its identity
// matches the wrapped session. No result names a host locator or claims verification.

const SESSION_ID = '0b8f4f47-8a43-4a6f-9b37-5d1f3c2e9a10'
const BASELINE = 'b'.repeat(40)
const IMAGE_ID = `sha256:${'a'.repeat(64)}`

const session = (overrides: Partial<Record<keyof EditingSessionResult, unknown>> = {}): EditingSessionResult =>
  ({
    sessionId: SESSION_ID,
    executionOutcome: 'completed',
    exitCode: 0,
    signal: null,
    durationMs: 10,
    diagnostic: 'completed: the agent exited with code 0.',
    cleanup: {
      status: 'complete',
      containerRemoved: true,
      workspaceRemoved: true,
      originalRepositoryUnchanged: true,
      reasonCode: null,
      remainingOwnedResources: [],
    },
    runtime: { profileId: 'fixture-editing-agent', imageReference: IMAGE_ID, isolation: null },
    ...overrides,
  }) as EditingSessionResult

const modified = (overrides: Partial<CandidateFileInput> = {}): CandidateFileInput => ({
  path: Buffer.from('src/app.ts'),
  operation: 'modified',
  oldMode: '100644',
  newMode: '100644',
  oldObjectId: '1'.repeat(40),
  newObjectId: '2'.repeat(40),
  oldSize: 12,
  newSize: 14,
  ...overrides,
})

const candidateInput = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
  baselineCommit: BASELINE,
  patch: Buffer.from('diff --git a/src/app.ts b/src/app.ts\n'),
  files: [modified()],
  coverage: repositoryCoverage(false),
  ...overrides,
})

function expectContractError(action: () => unknown): void {
  expect(action).toThrow(CaptureContractError)
}

const FORBIDDEN_FIELDS = [
  'workspacePath',
  'workspace',
  'gitDir',
  'privateGitDir',
  'sourceRepository',
  'repositoryRoot',
  'objectDirectory',
  'verified',
  'verdict',
  'verifiedFix',
  'gates',
  'replay',
  'stderr',
  'stdout',
  'findings',
]

function allKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return keys
  for (const [key, child] of Object.entries(value)) {
    keys.add(key)
    allKeys(child, keys)
  }
  return keys
}

describe('capture result vocabulary', () => {
  it('publishes exactly five statuses and seven reason categories', () => {
    expect([...CAPTURE_STATUSES]).toEqual(['captured', 'no_changes', 'rejected', 'failed', 'not_attempted'])
    expect([...CAPTURE_REASON_CODES]).toEqual([
      'EDITOR_NOT_SUCCESSFUL',
      'WORKSPACE_VIEW_UNAVAILABLE',
      'UNREPRESENTABLE_ENTRY',
      'SENSITIVE_DATA',
      'CAPTURE_LIMIT',
      'CAPTURE_INTERRUPTED',
      'CAPTURE_IO_FAILED',
    ])
    expect(Object.keys(CAPTURE_REASON_MESSAGES)).toEqual([...CAPTURE_REASON_CODES])
    expect(Object.isFrozen(CAPTURE_REASON_MESSAGES)).toBe(true)
  })

  it('uses fixed, bounded, locator-free reason messages within the diagnostic scale', () => {
    for (const code of CAPTURE_REASON_CODES) {
      const message = CAPTURE_REASON_MESSAGES[code]
      expect(message.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(V1_LIMIT_BOUNDS.diagnosticBytes.min)
      expect(message).not.toMatch(/\/|\\|<|>|Verified Fix/)
    }
  })

  it('maps every reason to exactly one status', () => {
    expect(notAttemptedResult()).toEqual({
      status: 'not_attempted',
      reasonCode: 'EDITOR_NOT_SUCCESSFUL',
      message: CAPTURE_REASON_MESSAGES.EDITOR_NOT_SUCCESSFUL,
      coverage: null,
    })
    for (const code of ['WORKSPACE_VIEW_UNAVAILABLE', 'UNREPRESENTABLE_ENTRY', 'SENSITIVE_DATA', 'CAPTURE_LIMIT'] as const) {
      expect(rejectedResult(code)).toEqual({ status: 'rejected', reasonCode: code, message: CAPTURE_REASON_MESSAGES[code], coverage: null })
    }
    for (const code of ['CAPTURE_INTERRUPTED', 'CAPTURE_IO_FAILED'] as const) {
      expect(failedResult(code)).toEqual({ status: 'failed', reasonCode: code, message: CAPTURE_REASON_MESSAGES[code], coverage: null })
    }
    // A failure category can never be reported as a rejection, nor the reverse.
    expectContractError(() => rejectedResult('CAPTURE_IO_FAILED' as never))
    expectContractError(() => failedResult('SENSITIVE_DATA' as never))
    expectContractError(() => rejectedResult('EDITOR_NOT_SUCCESSFUL' as never))
  })
})

describe('reference-only coverage', () => {
  it('states that nested working trees were neither inspected nor captured whenever gitlinks exist', () => {
    expect(repositoryCoverage(true)).toEqual({ scope: 'main_repository', note: SUBMODULE_COVERAGE_NOTE })
    expect(repositoryCoverage(false)).toEqual({ scope: 'main_repository', note: null })
    expect(SUBMODULE_COVERAGE_NOTE).toMatch(/not|neither/)
    expect(SUBMODULE_COVERAGE_NOTE).toMatch(/inspected/)
    expect(SUBMODULE_COVERAGE_NOTE).toMatch(/captured/)
    expect(SUBMODULE_COVERAGE_NOTE).not.toMatch(/clean/)
    expect(Object.isFrozen(repositoryCoverage(true))).toBe(true)
  })

  it('carries the note on no-change and non-success results too', () => {
    expect(noChangesResult(repositoryCoverage(true))).toEqual({ status: 'no_changes', coverage: repositoryCoverage(true) })
    expect(rejectedResult('SENSITIVE_DATA', repositoryCoverage(true))).toMatchObject({ coverage: repositoryCoverage(true) })
    expect(failedResult('CAPTURE_INTERRUPTED', repositoryCoverage(true))).toMatchObject({ coverage: repositoryCoverage(true) })
  })
})

describe('captured candidate', () => {
  it('has the exact field sets, the session and baseline identity, and no locator or verdict', () => {
    const result = capturedResult(createCandidate(candidateInput()))
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    const { candidate } = result

    expect(Object.keys(result)).toEqual(['status', 'candidate'])
    expect(Object.keys(candidate)).toEqual([...CANDIDATE_FIELDS])
    expect([...CANDIDATE_FIELDS]).toEqual(['sessionId', 'baselineCommit', 'patch', 'files', 'coverage'])
    expect([...CANDIDATE_FILE_FIELDS]).toEqual(['path', 'operation', 'oldMode', 'newMode', 'oldObjectId', 'newObjectId', 'oldSize', 'newSize'])
    expect(Object.keys(candidate.files[0] ?? {})).toEqual([...CANDIDATE_FILE_FIELDS])
    expect(candidate.sessionId).toBe(SESSION_ID)
    expect(candidate.baselineCommit).toBe(BASELINE)
    expect(Buffer.isBuffer(candidate.patch)).toBe(true)
    expect(Buffer.isBuffer(candidate.files[0]?.path)).toBe(true)
    const keys = allKeys(result)
    for (const forbidden of FORBIDDEN_FIELDS) expect(keys.has(forbidden), forbidden).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(candidate.files)).toBe(true)
    expect(Object.isFrozen(candidate.files[0])).toBe(true)
  })

  it('accepts additions, deletions, mode and type changes, links, gitlinks, and SHA-256 identities', () => {
    const files: CandidateFileInput[] = [
      { path: Buffer.from('new.bin'), operation: 'added', oldMode: null, newMode: '100755', oldObjectId: null, newObjectId: '3'.repeat(40), oldSize: null, newSize: 0 },
      { path: Buffer.from('gone.txt'), operation: 'deleted', oldMode: '100644', newMode: null, oldObjectId: '4'.repeat(40), newObjectId: null, oldSize: 3, newSize: null },
      { path: Buffer.from('link'), operation: 'modified', oldMode: '100644', newMode: '120000', oldObjectId: '5'.repeat(40), newObjectId: '6'.repeat(40), oldSize: 3, newSize: 9 },
      { path: Buffer.from('vendor/lib'), operation: 'added', oldMode: null, newMode: '160000', oldObjectId: null, newObjectId: '7'.repeat(40), oldSize: null, newSize: null },
      { path: Buffer.from([0x66, 0xff, 0x2e, 0x74]), operation: 'modified', oldMode: '100644', newMode: '100755', oldObjectId: '8'.repeat(40), newObjectId: '8'.repeat(40), oldSize: 1, newSize: 1 },
    ]
    expect(createCandidate(candidateInput({ files })).files).toHaveLength(5)
    const sha256 = createCandidate(
      candidateInput({ baselineCommit: 'c'.repeat(64), files: [modified({ oldObjectId: '1'.repeat(64), newObjectId: '2'.repeat(64) })] }),
    )
    expect(sha256.baselineCommit).toBe('c'.repeat(64))
  })

  it.each([
    ['an empty patch', { patch: Buffer.alloc(0) }],
    ['no changed files', { files: [] }],
    ['a non-UUID session identity', { sessionId: 'session-1' }],
    ['an abbreviated baseline', { baselineCommit: 'b'.repeat(12) }],
    ['a symbolic baseline', { baselineCommit: 'HEAD' }],
    ['object IDs of a different format than the baseline', { files: [modified({ oldObjectId: '1'.repeat(64), newObjectId: '2'.repeat(64) })] }],
    ['an addition with an old side', { files: [modified({ operation: 'added' })] }],
    ['a deletion with a new side', { files: [modified({ operation: 'deleted' })] }],
    ['a modification without a change', { files: [modified({ newObjectId: '1'.repeat(40), newMode: '100644' })] }],
    ['a directory mode', { files: [modified({ newMode: '040000' as never })] }],
    ['an absolute path', { files: [modified({ path: Buffer.from('/etc/passwd') })] }],
    ['a parent-directory path', { files: [modified({ path: Buffer.from('src/../../x') })] }],
    ['a repository-control path', { files: [modified({ path: Buffer.from('.git/config') })] }],
    ['a path with a NUL byte', { files: [modified({ path: Buffer.from('a\0b') })] }],
    ['an empty path', { files: [modified({ path: Buffer.alloc(0) })] }],
    ['a duplicated path', { files: [modified(), modified()] }],
    ['a gitlink with a byte length', { files: [modified({ oldMode: '160000', newMode: '160000' })] }],
    ['a negative byte length', { files: [modified({ newSize: -1 })] }],
    ['a missing coverage', { coverage: undefined }],
  ])('refuses a candidate with %s', (_label, overrides) => {
    expectContractError(() => createCandidate(candidateInput(overrides)))
  })

  it('retains private byte copies, so neither the input nor a returned buffer aliases the snapshot', () => {
    const patch = Buffer.from('diff --git a/src/app.ts b/src/app.ts\n')
    const path = Buffer.from('src/app.ts')
    const candidate = createCandidate(candidateInput({ patch, files: [modified({ path })] }))

    patch.fill(0x41)
    path.fill(0x42)
    const exposed = candidate.patch
    exposed.fill(0x43)
    candidate.files[0]?.path.fill(0x44)

    expect(candidate.patch.toString('utf8')).toBe('diff --git a/src/app.ts b/src/app.ts\n')
    expect(candidate.files[0]?.path.toString('utf8')).toBe('src/app.ts')
  })
})

describe('non-captured results', () => {
  const outcomes: Array<[string, CaptureResult]> = [
    ['no_changes', noChangesResult(repositoryCoverage(false))],
    ['rejected', rejectedResult('SENSITIVE_DATA')],
    ['failed', failedResult('CAPTURE_IO_FAILED')],
    ['not_attempted', notAttemptedResult()],
  ]

  it.each(outcomes)('%s carries no candidate bytes or partial records', (_label, result) => {
    const keys = allKeys(result)
    for (const field of ['candidate', 'patch', 'files', 'path', 'sessionId', 'baselineCommit']) expect(keys.has(field), field).toBe(false)
    for (const forbidden of FORBIDDEN_FIELDS) expect(keys.has(forbidden), forbidden).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
  })
})

describe('capturing session composition', () => {
  const candidate = (): CaptureResult => capturedResult(createCandidate(candidateInput()))
  const failedCleanup = {
    status: 'failed',
    containerRemoved: false,
    workspaceRemoved: true,
    originalRepositoryUnchanged: true,
    reasonCode: 'CONTAINER_NOT_REMOVED',
    remainingOwnedResources: ['container'],
  }

  it.each([
    ['a captured candidate after completion', session(), candidate()],
    ['a captured candidate beside an explicit cleanup failure', session({ cleanup: failedCleanup }), candidate()],
    ['no changes after completion', session(), noChangesResult(repositoryCoverage(true))],
    ['a rejection after completion', session(), rejectedResult('CAPTURE_LIMIT')],
    ['an interrupted capture after completion', session(), failedResult('CAPTURE_INTERRUPTED')],
    ['a capture preparation failure that prevented startup', session({ executionOutcome: 'startup_failed', exitCode: null, diagnostic: 'startup_failed: x.' }), failedResult('CAPTURE_IO_FAILED')],
    ['no attempt after a failed editor', session({ executionOutcome: 'failed', exitCode: 3 }), notAttemptedResult()],
    ['no attempt after a timeout', session({ executionOutcome: 'timed_out', exitCode: 137, signal: 'SIGKILL' }), notAttemptedResult()],
    ['no attempt after cancellation', session({ executionOutcome: 'cancelled', exitCode: null }), notAttemptedResult()],
  ])('accepts %s', (_label, sessionResult, capture) => {
    const validated = validateCapturingSessionResult({ session: sessionResult, capture })
    expect(validated).toEqual({ ok: true, value: { session: sessionResult, capture } })
    // The wrapped session keeps the exact Spec 002 field set: capture adds nothing to it.
    expect(Object.keys(sessionResult)).toEqual([...EDITING_SESSION_RESULT_FIELDS])
  })

  it.each([
    ['a candidate from a failed editor', session({ executionOutcome: 'failed', exitCode: 3 }), candidate()],
    ['a candidate from a cancelled editor', session({ executionOutcome: 'cancelled', exitCode: 143, signal: 'SIGTERM' }), candidate()],
    ['a candidate for another session', session({ sessionId: '9b8f4f47-8a43-4a6f-9b37-5d1f3c2e9a10' }), candidate()],
    ['no changes after a timeout', session({ executionOutcome: 'timed_out', exitCode: 137, signal: 'SIGKILL' }), noChangesResult(repositoryCoverage(false))],
    ['a skipped capture after completion', session(), notAttemptedResult()],
    ['an interrupted capture before the editor finished', session({ executionOutcome: 'cancelled', exitCode: 143, signal: 'SIGTERM' }), failedResult('CAPTURE_INTERRUPTED')],
    ['an invalid session result', session({ executionOutcome: 'verified' }), noChangesResult(repositoryCoverage(false))],
    ['an unknown capture status', session(), { status: 'verified_fix' }],
    ['a rejection carrying a raw message', session(), { status: 'rejected', reasonCode: 'SENSITIVE_DATA', message: 'matched ghp_x in /tmp/x', coverage: null }],
    ['a failure carrying a patch', session(), { ...failedResult('CAPTURE_IO_FAILED'), patch: Buffer.from('x') }],
    ['a captured result with an extra verdict', session(), { ...candidate(), verified: true }],
  ])('rejects %s', (_label, sessionResult, capture) => {
    expect(validateCapturingSessionResult({ session: sessionResult, capture }).ok).toBe(false)
  })

  it('rejects a composition with extra top-level fields', () => {
    expect(validateCapturingSessionResult({ session: session(), capture: notAttemptedResult(), verdict: 'Verified Fix' }).ok).toBe(false)
    expect(validateCapturingSessionResult(null).ok).toBe(false)
  })
})
