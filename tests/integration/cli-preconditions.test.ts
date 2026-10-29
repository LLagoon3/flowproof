import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { assertLauncherImplemented, buildFlowproofCli, runFlowproof, startFlowproof } from '../support/flowproofCli.js'
import type { CliResult, RunningStudio } from '../support/flowproofCli.js'
import { withProcessLock, demoPortLockName } from '../support/processLock.js'
import { createTempClone, createTempDirectory, git, listTree, processesMentioning, snapshotRepository } from '../support/repoFixture.js'
import type { RepositorySnapshot, TempDirectory } from '../support/repoFixture.js'

// T029: `flowproof studio [--scenario <id>]` preconditions from contracts/cli.md, implemented by
// T048 in `packages/flowproof/src/cli.ts`. Each case runs the compiled launcher in a temporary
// clone with a private TMPDIR and no MODEL_API_KEY. A failed precondition exits `3` with a
// stable reason code before any Studio or demo build, browser, worktree, artifact, or Git
// metadata side effect. Exactly one precondition fails per case; the clean-baseline and
// committed-path checks precede the Hero credential check, as listed in the contract.

const HERO = 'canvas-filter-hero'
const DEMO_PORT = 43119
const LAUNCH_TIMEOUT = 180_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

beforeAll(async () => {
  await buildFlowproofCli()
}, 180_000)

async function clone(options: { readonly withDependencies?: boolean } = {}): Promise<TempDirectory> {
  const repo = await createTempClone(options)
  cleanups.push(repo.remove)
  return repo
}

async function run(args: readonly string[], cwd: string): Promise<CliResult> {
  const result = await runFlowproof(args, { cwd })
  cleanups.push(result.tmp.remove)
  assertLauncherImplemented(result)
  return result
}

/** Exit 3, a stable reason code, safe diagnostics, and no side effect of any kind. */
async function expectPreconditionFailure(
  result: CliResult,
  code: string,
  repo: string,
  before: RepositorySnapshot,
): Promise<void> {
  expect({ exit: result.code, signal: result.signal }).toEqual({ exit: 3, signal: null })
  expect(result.stderr).toMatch(new RegExp(`\\b${code}\\b`))
  // No launch object, no absolute local paths, no stack traces in diagnostics.
  expect(result.stdout.trim()).toBe('')
  expect(result.stderr).not.toContain(repo)
  expect(result.stderr).not.toContain(result.tmp.path)
  expect(result.stderr).not.toMatch(/^\s+at /m)
  // No Studio or app build, browser profile, or worktree left in the private temp root.
  expect(await listTree(result.tmp.path)).toEqual([])
  expect(await processesMentioning(result.tmp.path)).toEqual([])
  // No artifact directory, no Git metadata, and an identical original snapshot.
  expect(await listTree(path.join(repo, '.flowproof'))).toEqual([])
  expect(await snapshotRepository(repo)).toEqual(before)
}

describe('flowproof studio preconditions (exit 3)', () => {
  it('refuses a dirty tracked working tree', async () => {
    const repo = await clone()
    await writeFile(path.join(repo.path, 'apps/demo-chart/src/filterData.ts'), '// uncommitted edit\n', { flag: 'a' })
    const before = await snapshotRepository(repo.path)

    await expectPreconditionFailure(await run(['studio'], repo.path), 'WORKING_TREE_DIRTY', repo.path, before)
  })

  it('refuses a dirty tracked working tree before checking Hero credentials', async () => {
    const repo = await clone()
    await writeFile(path.join(repo.path, 'README.md'), '\nuncommitted\n', { flag: 'a' })
    const before = await snapshotRepository(repo.path)

    await expectPreconditionFailure(await run(['studio', '--scenario', HERO], repo.path), 'WORKING_TREE_DIRTY', repo.path, before)
  })

  it('refuses a repository without a HEAD commit', async () => {
    const repo = await clone()
    await rm(path.join(repo.path, '.git'), { recursive: true, force: true })
    git(repo.path, 'init', '--quiet')
    const before = await snapshotRepository(repo.path)
    expect(before.head).toBeNull()

    await expectPreconditionFailure(await run(['studio'], repo.path), 'HEAD_MISSING', repo.path, before)
  })

  it.each([
    ['oracle', 'scenarios/canvas-filter/expected/chart-series.json'],
    ['permitted source', 'apps/demo-chart/src/filterData.ts'],
  ])('refuses a committed %s path that does not resolve', async (_label, committedPath) => {
    const repo = await clone()
    git(repo.path, 'rm', '--quiet', committedPath)
    git(repo.path, 'commit', '--quiet', '-m', 'remove a committed scenario path')
    const before = await snapshotRepository(repo.path)

    await expectPreconditionFailure(
      await run(['studio', '--scenario', HERO], repo.path),
      'SCENARIO_PATH_UNRESOLVABLE',
      repo.path,
      before,
    )
  })

  it('refuses explicit Hero without MODEL_API_KEY in the environment or an ignored .env', async () => {
    const repo = await clone()
    const before = await snapshotRepository(repo.path)

    const result = await run(['studio', '--scenario', HERO], repo.path)

    await expectPreconditionFailure(result, 'PROVIDER_CREDENTIAL_MISSING', repo.path, before)
    expect(result.stderr).toContain('MODEL_API_KEY')
  })

  it.each([
    ['canvas-filter-unknown', 'SCENARIO_NOT_REGISTERED'],
    // Malformed identifiers may be reported as invalid rather than unregistered.
    ['../scenarios/canvas-filter/hero.json', 'SCENARIO_(?:NOT_REGISTERED|ID_INVALID)'],
    ['Canvas-Filter-Hero', 'SCENARIO_(?:NOT_REGISTERED|ID_INVALID)'],
  ])('refuses the unregistered scenario %s without resolving it as a path', async (scenario, code) => {
    const repo = await clone()
    const before = await snapshotRepository(repo.path)

    await expectPreconditionFailure(await run(['studio', '--scenario', scenario], repo.path), code, repo.path, before)
  })

  it('refuses a symlinked .flowproof/runs artifact root without writing through it', async () => {
    const repo = await clone()
    const outside = await createTempDirectory('flowproof-runs-target-')
    cleanups.push(outside.remove)
    await mkdir(path.join(repo.path, '.flowproof'))
    await symlink(outside.path, path.join(repo.path, '.flowproof', 'runs'), 'dir')
    const before = await snapshotRepository(repo.path)

    const result = await run(['studio'], repo.path)

    expect({ exit: result.code, signal: result.signal }).toEqual({ exit: 3, signal: null })
    expect(result.stderr).toMatch(/\bARTIFACT_ROOT_SYMLINK\b/)
    expect(result.stdout.trim()).toBe('')
    expect(await listTree(outside.path)).toEqual([])
    expect(await listTree(result.tmp.path)).toEqual([])
    expect(await snapshotRepository(repo.path)).toEqual(before)
  })
})

describe('flowproof studio startup', () => {
  async function listening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = request({ host: 'localhost', port, path: '/', timeout: 1_000 }, (response) => {
        response.resume()
        resolve(true)
      })
      probe.on('error', () => resolve(false))
      probe.on('timeout', () => {
        probe.destroy()
        resolve(false)
      })
      probe.end()
    })
  }

  it(
    'launches without --scenario and without a key, then closes cleanly on interrupt',
    async () => {
      const repo = await clone({ withDependencies: true })
      const before = await snapshotRepository(repo.path)

      await withProcessLock(demoPortLockName(DEMO_PORT), async () => {
        const studio: RunningStudio = await startFlowproof(['studio'], { cwd: repo.path })
        cleanups.push(studio.tmp.remove)
        try {
          const launch = await studio.waitForLaunch(LAUNCH_TIMEOUT)

          expect(Object.keys(launch).sort()).toEqual(['mode', 'origin', 'session_id'])
          expect(launch.mode).toBe('studio')
          expect(launch.origin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/)
          expect(launch.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
          // The launch credential is a browser cookie, never printed.
          expect(studio.stdout()).not.toMatch(/flowproof_launch|cookie/i)
          // The guarded loopback Studio is up and refuses a request without the launch cookie.
          const port = Number(new URL(launch.origin).port)
          const status = await new Promise<number>((resolve, reject) => {
            const probe = request(
              { host: '127.0.0.1', port, path: '/api/scenarios', headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } },
              (response) => {
                response.resume()
                resolve(response.statusCode ?? 0)
              },
            )
            probe.on('error', reject)
            probe.end()
          })
          expect(status).toBe(401)
          expect(await listening(DEMO_PORT)).toBe(true)

          const exit = await studio.interrupt()
          expect(exit).toEqual({ code: 0, signal: null })
        } finally {
          studio.kill()
        }
        // Everything the launcher started is gone: servers, browser, temporary output.
        expect(await listening(DEMO_PORT)).toBe(false)
        expect(await processesMentioning(studio.tmp.path)).toEqual([])
        expect(await listTree(studio.tmp.path)).toEqual([])
      })

      expect(await listTree(path.join(repo.path, '.flowproof', 'runs'))).toEqual([])
      expect(await snapshotRepository(repo.path)).toEqual(before)
    },
    LAUNCH_TIMEOUT + 60_000,
  )

  it(
    'exits 4 with a safe diagnostic when startup fails internally',
    async () => {
      const repo = await clone({ withDependencies: true })
      const before = await snapshotRepository(repo.path)

      await withProcessLock(demoPortLockName(DEMO_PORT), async () => {
        // Another process owns the committed demo port, so the target app cannot bind it.
        const blocker: Server = createServer((_req, res) => res.end('occupied'))
        await new Promise<void>((resolve, reject) => {
          blocker.once('error', reject)
          blocker.listen(DEMO_PORT, 'localhost', () => resolve())
        })
        try {
          const result = await run(['studio'], repo.path)

          expect({ exit: result.code, signal: result.signal }).toEqual({ exit: 4, signal: null })
          expect(result.stderr).toMatch(/^[A-Z][A-Z0-9_]+: /m)
          expect(result.stdout.trim()).toBe('')
          expect(result.stderr).not.toContain(repo.path)
          expect(result.stderr).not.toMatch(/^\s+at /m)
          expect(await processesMentioning(result.tmp.path)).toEqual([])
          expect(await listTree(result.tmp.path)).toEqual([])
          // The launcher released nothing it did not own: the blocker still serves the port.
          expect(blocker.listening).toBe(true)
        } finally {
          await new Promise<void>((resolve) => blocker.close(() => resolve()))
        }
      })

      expect(await listTree(path.join(repo.path, '.flowproof', 'runs'))).toEqual([])
      expect(await snapshotRepository(repo.path)).toEqual(before)
    },
    LAUNCH_TIMEOUT,
  )
})
