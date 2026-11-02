import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CAPTURE_BYTE_BUDGET,
  CAPTURE_DEADLINE_MS,
  CaptureStopError,
  captureGitEnvironment,
  createCaptureBudget,
  runCaptureGit,
} from '../../packages/flowproof/src/editing/captureGit.js'
import { GIT_TIMEOUT_MS, MAX_GIT_OUTPUT_BYTES } from '../../packages/flowproof/src/git/repositoryState.js'
import { createTempDirectory, git, processesMentioning } from '../support/repoFixture.js'
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
