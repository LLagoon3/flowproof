import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CAPTURE_REASON_MESSAGES, captureChanges, validateCapturingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import type { CaptureResult, CapturingEditingSessionResult } from '../../packages/flowproof/src/editing/capture.js'
import {
  CAPTURE_BYTE_BUDGET,
  CAPTURE_DEADLINE_MS,
  CaptureStopError,
  captureGitEnvironment,
  createCaptureBudget,
  runCaptureGit,
} from '../../packages/flowproof/src/editing/captureGit.js'
import { EDITING_SESSION_RESULT_FIELDS, EditingSessionError, parseEditingSessionResult } from '../../packages/flowproof/src/editing/contracts.js'
import type { DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import { startCapturingEditingSession, startEditingSession } from '../../packages/flowproof/src/editing/session.js'
import { createWorkspaceManager } from '../../packages/flowproof/src/editing/workspace.js'
import type { CaptureWorkspace, SessionWorkspace } from '../../packages/flowproof/src/editing/workspace.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import type { SecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'
import { GIT_TIMEOUT_MS, MAX_GIT_OUTPUT_BYTES } from '../../packages/flowproof/src/git/repositoryState.js'
import { deferred, fakeDocker, fakeProfiles, fakeRequest, fakeWorkspace, tick } from '../support/editingFakes.js'
import type { FakeDockerOptions, FakeWorkspaceOptions } from '../support/editingFakes.js'
import { createTempDirectory, git, processesMentioning, snapshotRepository } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T004 (specs/003-capture-editing-candidate): the small shell-free capture Git runner. It moves
// bytes losslessly in both directions, runs Git with a sanitized environment and disabled
// external commands, and shares one deadline and one cumulative byte budget across every call.
// On deadline, abort, or overflow it terminates and joins only its own process group, including
// descendants, before it settles.

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function temp(prefix = 'flowproof-capture-unit-'): Promise<TempDirectory> {
  const directory = await createTempDirectory(prefix)
  cleanups.push(directory.remove)
  return directory
}

/** A private bare repository the runner can address through its trusted environment. */
async function privateRepository(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly root: string }> {
  const root = (await temp()).path
  git(root, 'init', '--quiet', '--bare', '--template=', 'private.git')
  const env = captureGitEnvironment({
    gitDir: path.join(root, 'private.git'),
    workTree: root,
    indexFile: path.join(root, 'private.git', 'index'),
  })
  return { env, root }
}

/** True while `pid` runs; a zombie awaiting a late reaper no longer counts as running. */
const alive = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'X')
  } catch {
    return false
  }
}

async function expectStop(action: Promise<unknown>, kind: string): Promise<void> {
  let caught: unknown
  try {
    await action
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${kind}`).toBeInstanceOf(CaptureStopError)
  expect((caught as CaptureStopError).kind).toBe(kind)
  // Raw Git output and paths never reach the error text.
  expect((caught as Error).message).toMatch(/^CAPTURE_STOPPED: /)
}

/**
 * A Git alias runs a Node child that starts a descendant in the same process group, records both
 * PIDs, then idles. The marker in both argv vectors lets the test prove neither survives.
 */
function hangingAlias(pidFile: string, marker: string): string[] {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'descendant-${marker}'], { stdio: 'ignore' })`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid)`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  return ['-c', `alias.fp-hang=!node -e "${script.replaceAll('"', '\\"')}" parent-${marker}`, 'fp-hang']
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8')
      if (text.includes(' ')) return text
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('The hanging alias never recorded its PIDs.')
}

describe('capture budget constants', () => {
  it('reuses the existing Git-helper scale for one deadline and one cumulative byte budget', () => {
    expect(CAPTURE_DEADLINE_MS).toBe(60_000)
    expect(CAPTURE_DEADLINE_MS).toBe(GIT_TIMEOUT_MS)
    expect(CAPTURE_BYTE_BUDGET).toBe(32 * 1024 * 1024)
    expect(CAPTURE_BYTE_BUDGET).toBe(MAX_GIT_OUTPUT_BYTES)
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())
    expect(budget.byteLimit).toBe(CAPTURE_BYTE_BUDGET)
    expect(budget.deadlineMs).toBe(CAPTURE_DEADLINE_MS)
  })
})

describe('binary-safe capture Git runner', () => {
  it('moves every byte value, including NUL, losslessly through stdin and stdout', async () => {
    const { env, root } = await privateRepository()
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())
    const payload = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, index) => index)), randomBytes(4_096), Buffer.from([0, 0, 10, 13, 0])])

    const written = await runCaptureGit(budget, ['hash-object', '-w', '--stdin'], { cwd: root, env, input: payload })
    const id = written.stdout.toString('latin1').trim()
    const read = await runCaptureGit(budget, ['cat-file', 'blob', id], { cwd: root, env })

    expect(Buffer.compare(read.stdout, payload)).toBe(0)
    expect(read.code).toBe(0)
    // Every consumed stdout byte counts against the shared budget.
    expect(budget.consumed).toBeGreaterThanOrEqual(payload.length + id.length)
  })

  it('runs Git with only the trusted environment and disabled hooks, monitor, and external configuration', async () => {
    const { env, root } = await privateRepository()
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_DIR: '/nonexistent/hostile',
      GIT_CONFIG_PARAMETERS: "'core.pager=evil-pager'",
      GIT_EXTERNAL_DIFF: 'evil-diff',
      MODEL_API_KEY: 'sk-fpcapturehostsecret0001',
      HOME: root,
    })
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())
    try {
      const config = (await runCaptureGit(budget, ['config', '--list', '--show-scope'], { cwd: root, env })).stdout.toString('utf8')
      const environment = (await runCaptureGit(budget, ['-c', 'alias.fp-env=!env', 'fp-env'], { cwd: root, env })).stdout.toString('utf8')

      for (const setting of ['core.hookspath=/dev/null', 'core.fsmonitor=false', 'core.attributesfile=/dev/null', 'core.excludesfile=/dev/null']) {
        expect(config).toContain(`command\t${setting}`)
      }
      expect(config).not.toContain('evil')
      expect(environment).not.toMatch(/GIT_EXTERNAL_DIFF|evil|MODEL_API_KEY|fpcapturehostsecret|^HOME=/m)
      expect(environment).toContain(`GIT_DIR=${path.join(root, 'private.git')}`)
      expect(environment).toContain('GIT_CONFIG_GLOBAL=/dev/null')
      expect(environment).toContain('GIT_CONFIG_NOSYSTEM=1')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  it('quotes an alternate object directory path that Git would otherwise split', () => {
    const env = captureGitEnvironment({ gitDir: '/tmp/a', workTree: '/tmp/b', indexFile: '/tmp/a/index', alternateObjectDirectory: '/srv/x:y/"q"/objects' })
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('"/srv/x:y/\\"q\\"/objects"')
    const plain = captureGitEnvironment({ gitDir: '/tmp/a', workTree: '/tmp/b', indexFile: '/tmp/a/index', alternateObjectDirectory: '/srv/repo/.git/objects' })
    expect(plain.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('/srv/repo/.git/objects')
  })

  it('reports an operational Git failure without its output, and accepts declared exit codes', async () => {
    const { env, root } = await privateRepository()
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())
    await expectStop(runCaptureGit(budget, ['cat-file', 'blob', 'f'.repeat(40)], { cwd: root, env }), 'io')
    const ignored = await runCaptureGit(budget, ['check-ignore', '--stdin', '-z', '--no-index'], { cwd: root, env, input: Buffer.from('a\0'), okCodes: [0, 1] })
    expect(ignored.code).toBe(1)
    await expectStop(runCaptureGit(budget, ['status'], { cwd: path.join(root, 'missing'), env }), 'io')
  })

  it('counts stdout and stderr incrementally against one cumulative budget shared by every call', async () => {
    const { env, root } = await privateRepository()
    const budget = createCaptureBudget({ byteLimit: 1_000 })
    cleanups.push(async () => budget.dispose())
    const print = (stream: 'stdout' | 'stderr', bytes: number): string[] => [
      '-c',
      `alias.fp-print=!node -e "process.${stream}.write('x'.repeat(${bytes}))"`,
      'fp-print',
    ]

    await runCaptureGit(budget, print('stdout', 600), { cwd: root, env })
    expect(budget.consumed).toBe(600)
    await expectStop(runCaptureGit(budget, print('stderr', 600), { cwd: root, env }), 'limit')
    // Once exhausted, no further process starts.
    await expectStop(runCaptureGit(budget, ['--version'], { cwd: root, env }), 'limit')
  })

  it('stops a flood as soon as the budget is exceeded instead of collecting it first', async () => {
    const { env, root } = await privateRepository()
    const budget = createCaptureBudget({ byteLimit: 64 * 1024 })
    cleanups.push(async () => budget.dispose())
    const startedAt = Date.now()
    const flood = ['-c', `alias.fp-flood=!node -e "const b = Buffer.alloc(65536, 120); (function w() { while (process.stdout.write(b)); process.stdout.once('drain', w) })()"`, 'fp-flood']
    await expectStop(runCaptureGit(budget, flood, { cwd: root, env }), 'limit')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it.each([
    ['the shared deadline', 'limit'],
    ['an abort', 'interrupted'],
    ['a byte overflow', 'limit'],
  ] as const)('terminates and joins only its own process group, descendants included, on %s', async (trigger, kind) => {
    const { env, root } = await privateRepository()
    const marker = randomBytes(6).toString('hex')
    const pidFile = path.join(root, 'pids.txt')
    const controller = new AbortController()
    const budget = createCaptureBudget({
      signal: controller.signal,
      deadlineMs: trigger === 'the shared deadline' ? 1_500 : 60_000,
      byteLimit: trigger === 'a byte overflow' ? 16 : CAPTURE_BYTE_BUDGET,
    })
    cleanups.push(async () => budget.dispose())
    // An unrelated process in its own group must survive.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `unrelated-${marker}`], { detached: true, stdio: 'ignore' })
    cleanups.push(async () => {
      if (unrelated.pid !== undefined && alive(unrelated.pid)) process.kill(unrelated.pid, 'SIGKILL')
    })

    const args = hangingAlias(pidFile, marker)
    const running = runCaptureGit(budget, args, { cwd: root, env })
    const [parent, descendant] = (await waitForFile(pidFile)).split(' ').map(Number) as [number, number]
    expect(alive(parent) && alive(descendant)).toBe(true)
    if (trigger === 'an abort') controller.abort()
    // Another consumer of the same budget (for example a raw payload read) overflows it.
    if (trigger === 'a byte overflow') expect(() => budget.consume(17)).toThrow(CaptureStopError)

    await expectStop(running, kind)

    // Settled only after the whole capture-owned group is gone.
    expect(alive(parent)).toBe(false)
    expect(alive(descendant)).toBe(false)
    expect(await processesMentioning(`descendant-${marker}`)).toEqual([])
    expect(await processesMentioning(`parent-${marker}`)).toEqual([])
    expect(unrelated.pid !== undefined && alive(unrelated.pid)).toBe(true)
  })

  it('joins a descendant that outlives a successful Git process', async () => {
    const { env, root } = await privateRepository()
    const marker = randomBytes(6).toString('hex')
    const budget = createCaptureBudget()
    cleanups.push(async () => budget.dispose())
    // The alias exits at once but leaves a same-group descendant with closed standard streams.
    const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'lingering-${marker}'], { stdio: 'ignore' }).unref()`
    const result = await runCaptureGit(budget, ['-c', `alias.fp-linger=!node -e "${script.replaceAll('"', '\\"')}"`, 'fp-linger'], { cwd: root, env })

    expect(result.code).toBe(0)
    expect(await processesMentioning(`lingering-${marker}`)).toEqual([])
  })

  it('refuses to start after the caller aborted', async () => {
    const { env, root } = await privateRepository()
    const controller = new AbortController()
    controller.abort()
    const budget = createCaptureBudget({ signal: controller.signal })
    cleanups.push(async () => budget.dispose())
    await expectStop(runCaptureGit(budget, ['--version'], { cwd: root, env }), 'interrupted')
    expect(budget.consumed).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------
// Capture over a small real repository
// ---------------------------------------------------------------------------------------

const SCANNER = createSecretScanner({ markers: ['FPCAPTUREUNITNEVER01'] })

interface Captured {
  readonly workspacePath: string
  readonly baselineCommit: string
  capture(options?: { readonly scanner?: SecretScanner; readonly signal?: AbortSignal; readonly bounds?: { readonly deadlineMs?: number; readonly byteLimit?: number } }): Promise<CaptureResult>
}

/** A one-commit repository holding `files`. */
async function syntheticRepository(files: Record<string, string | Buffer>): Promise<{ readonly root: string; readonly head: string }> {
  const parent = await temp('flowproof-capture-unit-repo-')
  const root = path.join(parent.path, 'repo')
  git(parent.path, 'init', '--quiet', '--initial-branch=main', 'repo')
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content)
  git(root, 'add', '--all')
  git(root, '-c', 'user.email=u@example.invalid', '-c', 'user.name=Unit', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'base')
  return { root, head: git(root, 'rev-parse', 'HEAD').trim() }
}

/** A one-commit repository with `files`, cloned into a prepared capture workspace. */
async function capturable(files: Record<string, string | Buffer>): Promise<Captured> {
  const { root, head } = await syntheticRepository(files)
  const tmp = await temp('flowproof-capture-unit-tmp-')
  const workspace = createWorkspaceManager({ tmpRoot: tmp.path }).open()
  cleanups.push(async () => {
    await workspace.dispose()
  })
  await workspace.resolve(root, head)
  const prepared = await workspace.create({ task: 'unit', declaredProjectCommands: [] })
  const pinned = await (workspace.prepareCapture as () => Promise<CaptureWorkspace>)()
  const sessionId = randomUUID()
  return {
    workspacePath: prepared.workspacePath,
    baselineCommit: head,
    capture: (options = {}) =>
      captureChanges({
        sessionId,
        workspace: pinned,
        scanner: options.scanner ?? SCANNER,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      }),
  }
}

describe('captured candidate snapshot', () => {
  it('derives the summary and patch from one tree and retains bytes no caller can alias', async () => {
    const repo = await capturable({ 'a.txt': 'a\n', 'b.bin': Buffer.from([0, 1, 2, 255]) })
    await writeFile(path.join(repo.workspacePath, 'a.txt'), 'a2\n')
    await writeFile(path.join(repo.workspacePath, 'b.bin'), Buffer.from([0, 9, 9, 255]))

    const result = await repo.capture()
    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    const { candidate } = result
    const patch = candidate.patch
    const original = Buffer.from(patch)
    expect(candidate.files.map((record) => record.path.toString('utf8'))).toEqual(['a.txt', 'b.bin'])
    for (const record of candidate.files) expect(patch.includes(`diff --git a/${record.path.toString('utf8')} b/`)).toBe(true)

    // Mutating every buffer a caller can obtain leaves the retained snapshot unchanged.
    patch.fill(0)
    candidate.files[0]?.path.fill(0)
    expect(Buffer.compare(candidate.patch, original)).toBe(0)
    expect(candidate.files[0]?.path.toString('utf8')).toBe('a.txt')
    expect(() => {
      ;(candidate as unknown as { patch: Buffer }).patch = Buffer.from('replaced')
    }).toThrow(TypeError)
    expect(Object.isFrozen(candidate.files)).toBe(true)
  })
})

// T013 (US2): text-versus-binary dispatch to the existing scanner and fixed safe reasons.
// Valid UTF-8 without NUL is scanned as text (credential shapes and seeded markers); every other
// payload is scanned as binary (seeded markers only), the existing scanner's documented limit.

describe('scanner dispatch', () => {
  const marker = ['FPCAPTURE', 'UNIT', 'MARKER', '0001'].join('')
  const credential = ['gh', 'p_', 'FPCAPTURE', 'UNIT', 'TOKEN', '000000000001'].join('')
  const scanner = createSecretScanner({ markers: [marker] })

  /** Records what the scanner saw for each surface. */
  function recording(inner: SecretScanner): SecretScanner & { readonly seen: Array<'text' | 'binary'> } {
    const seen: Array<'text' | 'binary'> = []
    return {
      seen,
      scan(label, value) {
        seen.push(typeof value === 'string' ? 'text' : 'binary')
        return inner.scan(label, value)
      },
      scanRun: (run) => inner.scanRun(run),
    }
  }

  it.each([
    ['a credential shape in UTF-8 text', 'config.env', Buffer.from(`SETTING=${credential}\n`), 'rejected'],
    ['a credential shape in non-ASCII UTF-8 text', 'notes.txt', Buffer.from(`café ${credential} 안녕\n`), 'rejected'],
    ['a seeded marker in non-UTF-8 text', 'latin1.txt', Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(marker)]), 'rejected'],
    ['a seeded marker in a binary payload', 'blob.bin', Buffer.concat([Buffer.from([0, 1]), Buffer.from(marker), Buffer.from([0])]), 'rejected'],
    ['a credential shape inside a binary payload', 'blob.bin', Buffer.concat([Buffer.from([0, 1]), Buffer.from(credential), Buffer.from([0])]), 'captured'],
  ])('handles %s', async (_label, name, content, expected) => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    await writeFile(path.join(repo.workspacePath, name), content)
    const result = await repo.capture({ scanner })
    expect(result.status).toBe(expected)
    if (result.status === 'rejected') expect(result.reasonCode).toBe('SENSITIVE_DATA')
  })

  it('scans text surfaces as text and binary surfaces as bytes', async () => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    await writeFile(path.join(repo.workspacePath, 'text.txt'), 'plain text\n')
    await writeFile(path.join(repo.workspacePath, 'blob.bin'), Buffer.from([0, 1, 2]))
    const spy = recording(scanner)
    expect((await repo.capture({ scanner: spy })).status).toBe('captured')
    expect(spy.seen).toContain('text')
    expect(spy.seen).toContain('binary')
  })

  it('returns only the fixed reason, never the scanner finding, path, or matched value', async () => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    const name = `secret-dir-${marker}`
    await writeFile(path.join(repo.workspacePath, `${name}.txt`), `value ${marker}\n`)
    const leaking: SecretScanner = {
      scan: (label, value) => {
        const report = scanner.scan(label, value)
        return report.clean ? report : { clean: false, findings: [{ path: `${label}:${name}:${repo.workspacePath}`, category: 'seeded-marker' }] }
      },
      scanRun: (run) => scanner.scanRun(run),
    }
    const result = await repo.capture({ scanner: leaking })
    expect(result).toEqual({
      status: 'rejected',
      reasonCode: 'SENSITIVE_DATA',
      message: 'Capture was rejected because a changed path or payload matched a required sensitive-data check.',
      coverage: { scope: 'main_repository', note: null },
    })
    const serialized = JSON.stringify(result)
    for (const forbidden of [marker, name, repo.workspacePath, 'seeded-marker', 'findings']) expect(serialized).not.toContain(forbidden)
  })
})

// T015 (US2): failures stay failures. A scanner or read exception becomes a fixed I/O failure
// without its text, and interruption is reported even when nothing changed.

describe('capture failure distinctions', () => {
  it('turns an unexpected exception into a fixed failure without its message', async () => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    await writeFile(path.join(repo.workspacePath, 'base.txt'), 'changed\n')
    const throwing: SecretScanner = {
      scan: () => {
        throw new Error(`scanner exploded at ${repo.workspacePath} with sk-fpcaptureexception0001`)
      },
      scanRun: () => ({ clean: true, findings: [] }),
    }
    const result = await repo.capture({ scanner: throwing })
    expect(result).toEqual({
      status: 'failed',
      reasonCode: 'CAPTURE_IO_FAILED',
      message: 'Capture failed because the workspace or Git state could not be read.',
      coverage: { scope: 'main_repository', note: null },
    })
    expect(JSON.stringify(result)).not.toMatch(/exploded|fpcaptureexception|\/tmp\//)
  })

  it('reports an interrupted unchanged capture as interrupted, not as no changes', async () => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    expect(await repo.capture({ signal: AbortSignal.abort() })).toEqual({
      status: 'failed',
      reasonCode: 'CAPTURE_INTERRUPTED',
      message: 'Capture was interrupted before it completed, so no candidate was produced.',
      coverage: null,
    })
    expect(await repo.capture()).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })
  })

  it('reports an exhausted budget as a rejection, not as a failure', async () => {
    const repo = await capturable({ 'base.txt': 'base\n' })
    await writeFile(path.join(repo.workspacePath, 'base.txt'), 'changed\n')
    expect(await repo.capture({ bounds: { byteLimit: 1 } })).toMatchObject({ status: 'rejected', reasonCode: 'CAPTURE_LIMIT', coverage: null })
  })
})

// ---------------------------------------------------------------------------------------
// T017 (US3): the opt-in capturing session lifecycle. A fake Docker adapter fixes terminal and
// cancellation ordering while a real workspace and real capture run underneath, so these cases
// prove ordering without a daemon: capture runs once, only after an inspected successful stop,
// before disposal, and the result resolves after cleanup with distinct execution, capture, and
// cleanup facts.
// ---------------------------------------------------------------------------------------

const profiles = fakeProfiles()

interface Harness {
  readonly repo: { readonly root: string; readonly head: string }
  readonly docker: ReturnType<typeof fakeDocker>
  readonly workspaces: { open(): SessionWorkspace }
  /** The real workspace once opened. */
  workspace(): SessionWorkspace
  /** The clone path once created. */
  clonePath(): string
  request(overrides?: Record<string, unknown>): Record<string, unknown>
}

/** A real repository and real workspace manager beneath a fake Docker daemon. */
async function harness(dockerOptions: FakeDockerOptions = {}, wrap: (inner: SessionWorkspace) => SessionWorkspace = (inner) => inner): Promise<Harness> {
  const repo = await syntheticRepository({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const tmp = await temp('flowproof-capture-session-tmp-')
  const manager = createWorkspaceManager({ tmpRoot: tmp.path })
  let opened: SessionWorkspace | null = null
  const docker = fakeDocker(dockerOptions)
  return {
    repo,
    docker,
    workspaces: {
      open: () => {
        const inner = manager.open()
        cleanups.push(async () => {
          await inner.dispose()
        })
        opened = wrap(inner)
        return opened
      },
    },
    workspace: () => opened as unknown as SessionWorkspace,
    clonePath: () => (opened as unknown as SessionWorkspace).createdPaths[1] as string,
    request: (overrides = {}) => fakeRequest({ repositoryRoot: repo.root, revision: repo.head, ...overrides }),
  }
}

function startCapture(h: Harness, overrides: Record<string, unknown> = {}, scanner: SecretScanner = SCANNER) {
  return startCapturingEditingSession(h.request(overrides), { profiles, docker: h.docker, workspaces: h.workspaces, scanner })
}

function expectComposition(result: CapturingEditingSessionResult): void {
  expect(Object.keys(result)).toEqual(['session', 'capture'])
  expect(Object.keys(result.session)).toEqual([...EDITING_SESSION_RESULT_FIELDS])
  expect(parseEditingSessionResult(result.session)).toMatchObject({ ok: true })
  expect(validateCapturingSessionResult(result)).toMatchObject({ ok: true })
  expect(Object.isFrozen(result)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('Verified Fix')
}

const NOT_ATTEMPTED = { status: 'not_attempted', reasonCode: 'EDITOR_NOT_SUCCESSFUL', message: CAPTURE_REASON_MESSAGES.EDITOR_NOT_SUCCESSFUL, coverage: null }

describe('capturing session admission', () => {
  it.each([
    ['an invalid request', { task: '' }, SCANNER, 'EDITING_REQUEST_INVALID'],
    ['an unknown profile', { runtimeProfileId: 'codex' }, SCANNER, 'EDITING_PROFILE_UNKNOWN'],
    ['a missing scanner', {}, undefined, 'EDITING_REQUEST_INVALID'],
    ['a scanner without a scan function', {}, { scanRun: () => ({ clean: true, findings: [] }) }, 'EDITING_REQUEST_INVALID'],
  ])('rejects %s synchronously before any side effect', (_label, overrides, scanner, code) => {
    const docker = fakeDocker()
    const workspace = fakeWorkspace()
    let caught: unknown
    try {
      startCapturingEditingSession(fakeRequest(overrides), { profiles, docker, workspaces: { open: () => workspace }, scanner: scanner as SecretScanner })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EditingSessionError)
    expect((caught as EditingSessionError).code).toBe(code)
    expect(docker.calls).toEqual([])
    expect(workspace.calls).toEqual([])
  })
})

describe('capturing session lifecycle', () => {
  it('captures exactly once after an inspected successful stop, before disposal, then cleans up', async () => {
    const h = await harness()
    const before = await snapshotRepository(h.repo.root)
    const handle = startCapture(h)
    await h.docker.started
    await writeFile(path.join(h.clonePath(), 'b.txt'), 'b edited\n')
    h.docker.exit(0)

    const result = await handle.result

    expectComposition(result)
    expect(result.session).toMatchObject({ sessionId: handle.id, executionOutcome: 'completed', exitCode: 0, cleanup: { status: 'complete' } })
    expect(result.capture.status).toBe('captured')
    if (result.capture.status !== 'captured') return
    expect(result.capture.candidate.sessionId).toBe(handle.id)
    expect(result.capture.candidate.baselineCommit).toBe(h.repo.head)
    expect(result.capture.candidate.files.map((record) => record.path.toString('utf8'))).toEqual(['b.txt'])
    // Ordering: inspect, then the single view proof, then removal; disposal comes last.
    const calls = h.docker.calls
    expect(calls.filter((call) => call === 'verifyWorkspaceView')).toHaveLength(1)
    expect(calls.lastIndexOf('inspect')).toBeLessThan(calls.indexOf('verifyWorkspaceView'))
    expect(calls.indexOf('verifyWorkspaceView')).toBeLessThan(calls.indexOf('remove'))
    expect(await snapshotRepository(h.repo.root)).toEqual(before)
    expect(h.workspace().createdPaths.every((entry) => !existsSync(entry))).toBe(true)
    // A later cancellation starts neither another capture nor another cleanup.
    await handle.cancel('late')
    expect(await handle.result).toBe(result)
    expect(h.docker.calls.filter((call) => call === 'verifyWorkspaceView')).toHaveLength(1)
    expect(h.docker.calls.filter((call) => call === 'remove')).toHaveLength(1)
  })

  it('reports no changes after a successful stop that changed nothing', async () => {
    const h = await harness({ exitImmediately: 0 })
    const result = await startCapture(h).result
    expectComposition(result)
    expect(result.capture).toEqual({ status: 'no_changes', coverage: { scope: 'main_repository', note: null } })
  })

  it.each([
    ['an attach-client exit while the container still runs', { attachClientExitImmediately: 0, runningExitCode: 0 }, {}, 'failed'],
    ['a nonzero exit', { exitImmediately: 3 }, {}, 'failed'],
    ['a container that never started', { startError: true }, {}, 'startup_failed'],
    ['a failed container creation', { createFails: true }, {}, 'startup_failed'],
    ['a timeout', { stopExitCode: 137 }, { limits: { wallClockMs: 1_000, stopGraceMs: 1_000 } }, 'timed_out'],
  ] as const)('never captures after %s', async (_label, dockerOptions, overrides, outcome) => {
    const h = await harness(dockerOptions)
    const handle = startCapture(h, overrides)
    // Edits are made whenever the container starts; a creation failure never starts it.
    await Promise.race([h.docker.started.then(() => writeFile(path.join(h.clonePath(), 'b.txt'), 'edited before failure\n')).catch(() => undefined), handle.result])
    const result = await handle.result

    expectComposition(result)
    expect(result.session.executionOutcome).toBe(outcome)
    expect(result.session.cleanup.status).toBe('complete')
    expect(result.capture).toEqual(NOT_ATTEMPTED)
    expect(h.docker.calls).not.toContain('verifyWorkspaceView')
  })

  it('never captures after cancellation before or while the editor runs', async () => {
    const early = await harness()
    const beforeStart = startCapture(early)
    await beforeStart.cancel('before start')
    const first = await beforeStart.result
    expectComposition(first)
    expect(first.session.executionOutcome).toBe('cancelled')
    expect(first.capture).toEqual(NOT_ATTEMPTED)

    const running = await harness()
    const handle = startCapture(running)
    await running.docker.started
    await writeFile(path.join(running.clonePath(), 'b.txt'), 'edited before cancel\n')
    await handle.cancel('while running')
    const second = await handle.result
    expectComposition(second)
    expect(second.session).toMatchObject({ executionOutcome: 'cancelled', cleanup: { status: 'complete' } })
    expect(second.capture).toEqual(NOT_ATTEMPTED)
    expect(running.docker.calls).not.toContain('verifyWorkspaceView')
  })

  it('interrupts capture on cancellation during capture without rewriting the completed execution', async () => {
    const gate = deferred<boolean>()
    const h = await harness({ workspaceViewGate: gate.promise })
    const handle = startCapture(h)
    await h.docker.started
    await writeFile(path.join(h.clonePath(), 'b.txt'), 'edited\n')
    h.docker.exit(0)
    while (!h.docker.calls.includes('verifyWorkspaceView')) await tick(1)

    const cancelled = handle.cancel('during capture')
    gate.resolve(true)
    await cancelled
    const result = await handle.result

    expectComposition(result)
    expect(result.session).toMatchObject({ executionOutcome: 'completed', exitCode: 0, cleanup: { status: 'complete' } })
    expect(result.capture).toEqual({ status: 'failed', reasonCode: 'CAPTURE_INTERRUPTED', message: CAPTURE_REASON_MESSAGES.CAPTURE_INTERRUPTED, coverage: null })
    expect(h.workspace().createdPaths.every((entry) => !existsSync(entry))).toBe(true)
  })

  it.each([
    ['an unproved workspace view', { workspaceView: false }, 'rejected', 'WORKSPACE_VIEW_UNAVAILABLE'],
    ['a failing workspace-view check', { workspaceView: 'throws' }, 'rejected', 'WORKSPACE_VIEW_UNAVAILABLE'],
  ] as const)('settles %s as a safe capture result and still cleans up', async (_label, dockerOptions, status, reasonCode) => {
    const h = await harness({ exitImmediately: 0, ...dockerOptions })
    const result = await startCapture(h).result
    expectComposition(result)
    expect(result.session).toMatchObject({ executionOutcome: 'completed', cleanup: { status: 'complete' } })
    expect(result.capture).toMatchObject({ status, reasonCode })
  })

  it('reports a capture-preparation failure as a failed capture of an editor that never started', async () => {
    const docker = fakeDocker({ exitImmediately: 0 })
    const workspace = fakeWorkspace({ prepareCaptureFails: true })
    const result = await startCapturingEditingSession(fakeRequest(), { profiles, docker, workspaces: { open: () => workspace }, scanner: SCANNER }).result
    expectComposition(result)
    expect(result.session).toMatchObject({ executionOutcome: 'startup_failed', cleanup: { status: 'complete' } })
    expect(result.session.diagnostic).toBe('startup_failed: the disposable workspace could not be prepared.')
    expect(result.capture).toEqual({ status: 'failed', reasonCode: 'CAPTURE_IO_FAILED', message: CAPTURE_REASON_MESSAGES.CAPTURE_IO_FAILED, coverage: null })
    expect(docker.calls).not.toContain('create')
    expect(workspace.calls).toEqual(['resolve', 'create', 'prepareCapture', 'dispose', 'verifyOriginal'])
  })

  it('settles a capture read failure as data and still disposes and verifies', async () => {
    const docker = fakeDocker({ exitImmediately: 0 })
    const workspace = fakeWorkspace()
    const result = await startCapturingEditingSession(fakeRequest(), { profiles, docker, workspaces: { open: () => workspace }, scanner: SCANNER }).result
    expectComposition(result)
    expect(result.session.cleanup.status).toBe('complete')
    expect(result.capture).toMatchObject({ status: 'failed', reasonCode: 'CAPTURE_IO_FAILED' })
    expect(workspace.calls.slice(-2)).toEqual(['dispose', 'verifyOriginal'])
  })

  it.each([
    ['a container that cannot be removed', { failRemovals: 'always' } as FakeDockerOptions, null, 'CONTAINER_NOT_REMOVED'],
    [
      'a changed original repository',
      {} as FakeDockerOptions,
      (inner: SessionWorkspace): SessionWorkspace => ({
        ...inner,
        get createdPaths() {
          return inner.createdPaths
        },
        ...(inner.prepareCapture === undefined ? {} : { prepareCapture: inner.prepareCapture.bind(inner) }),
        verifyOriginal: async () => ({ verified: true, unchanged: false, mismatches: ['status'] }),
      }),
      'ORIGINAL_REPOSITORY_CHANGED',
    ],
  ] as const)('keeps a completed candidate beside an explicit cleanup failure for %s', async (_label, dockerOptions, wrap, reasonCode) => {
    const h = await harness(dockerOptions, wrap ?? undefined)
    const handle = startCapture(h)
    await h.docker.started
    await writeFile(path.join(h.clonePath(), 'a.txt'), 'a edited\n')
    h.docker.exit(0)
    const result = await handle.result

    expectComposition(result)
    expect(result.session).toMatchObject({ executionOutcome: 'completed', cleanup: { status: 'failed', reasonCode } })
    expect(result.capture.status).toBe('captured')
  })
})

describe('lifecycle-only compatibility', () => {
  it('keeps the existing entry point free of capture work and fields', async () => {
    const docker = fakeDocker({ exitImmediately: 0 })
    const workspace = fakeWorkspace()
    const handle = startEditingSession(fakeRequest(), { profiles, docker: docker as DockerAdapter, workspaces: { open: () => workspace } })
    const result = await handle.result

    expect(Object.keys(result)).toEqual([...EDITING_SESSION_RESULT_FIELDS])
    expect(parseEditingSessionResult(result)).toMatchObject({ ok: true })
    expect(result).toMatchObject({ executionOutcome: 'completed', exitCode: 0, cleanup: { status: 'complete' } })
    expect(docker.calls).not.toContain('verifyWorkspaceView')
    expect(workspace.calls).not.toContain('prepareCapture')
    expect(JSON.stringify(result)).not.toMatch(/capture|candidate|patch/)
  })

  it.each([
    ['completed', { exitImmediately: 0 }, {}],
    ['failed', { exitImmediately: 9 }, {}],
    ['startup_failed', { createFails: true }, {}],
    ['timed_out', { stopExitCode: 137 }, { limits: { wallClockMs: 1_000, stopGraceMs: 1_000 } }],
  ] as const)('reports the same %s session facts through both entry points', async (_label, dockerOptions, overrides) => {
    const plain = await startEditingSession(fakeRequest(overrides), { profiles, docker: fakeDocker(dockerOptions), workspaces: { open: () => fakeWorkspace() } }).result
    const capturing = await startCapturingEditingSession(fakeRequest(overrides), {
      profiles,
      docker: fakeDocker(dockerOptions),
      workspaces: { open: () => fakeWorkspace() },
      scanner: SCANNER,
    }).result
    const stable = ({ sessionId: _id, durationMs: _duration, ...rest }: typeof plain) => rest
    expect(stable(capturing.session)).toEqual(stable(plain))
  })
})

// Fake options used above must exist on the shared fakes.
const _fakeOptionsCompile: FakeWorkspaceOptions = { prepareCaptureFails: true }
void _fakeOptionsCompile
