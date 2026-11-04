import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REPO_ROOT, createTempDirectory } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T003: the project-live Meta smoke and the manual full-live runner are opt-in. This suite proves
// it with the real Vitest and Playwright listers, not by reading the configuration: the committed
// configurations are copied into a private temporary root beside sentinel files at the reserved
// paths, so the proof holds before those live files exist and never writes into this checkout.
// Listing parses files statically; no sentinel body runs, and no provider can be contacted.

const run = promisify(execFile)

const PROJECT_SMOKE = 'tests/integration/project-live-meta-smoke.test.ts'
const LEGACY_SMOKE = 'tests/integration/meta-smoke.test.ts'
const MANUAL_RUNNER = 'tests/manual/project-live-acceptance.mjs'
const DEFAULT_SENTINELS = [
  'tests/unit/discovery-sentinel.test.ts',
  'tests/contract/discovery-sentinel.test.ts',
  'tests/integration/discovery-sentinel.test.ts',
  'tests/ui/discovery-sentinel.test.ts',
] as const
const E2E_SENTINEL = 'tests/e2e/discovery-sentinel.spec.ts'

const MUST_NOT_RUN = `import { it } from 'vitest'\nit('sentinel', () => { throw new Error('LIVE_TEST_DISCOVERED') })\n`
const ORDINARY = `import { it } from 'vitest'\nit('sentinel', () => {})\n`

let root: TempDirectory

async function writeSentinel(relative: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root.path, relative)), { recursive: true })
  await writeFile(path.join(root.path, relative), content)
}

/** The files the real Vitest lister discovers for the given CLI arguments, repository-relative. */
async function vitestFiles(args: readonly string[]): Promise<string[]> {
  const { stdout } = await run(process.execPath, [path.join(root.path, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json', ...args], {
    cwd: root.path,
    encoding: 'utf8',
    timeout: 90_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root.path, CI: '1' },
  })
  const listed = JSON.parse(stdout) as Array<{ file: string }>
  return [...new Set(listed.map((entry) => path.relative(root.path, entry.file)))].sort()
}

/** The `--project` arguments of the committed default `pnpm test` script. */
async function defaultScriptProjects(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const script = manifest.scripts.test ?? ''
  const projects = [...script.matchAll(/--project[= ]([^\s]+)/g)].map((match) => match[1] ?? '')
  return projects.flatMap((project) => ['--project', project])
}

beforeAll(async () => {
  root = await createTempDirectory('flowproof-discovery-')
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root.path, 'node_modules'), 'dir')
  await copyFile(path.join(REPO_ROOT, 'vitest.config.ts'), path.join(root.path, 'vitest.config.ts'))
  await copyFile(path.join(REPO_ROOT, 'playwright.config.ts'), path.join(root.path, 'playwright.config.ts'))
  await writeSentinel(PROJECT_SMOKE, MUST_NOT_RUN)
  await writeSentinel(LEGACY_SMOKE, MUST_NOT_RUN)
  await writeSentinel(MANUAL_RUNNER, `throw new Error('LIVE_RUNNER_DISCOVERED')\n`)
  await writeSentinel('tests/manual/project-live-acceptance.test.ts', MUST_NOT_RUN)
  for (const sentinel of DEFAULT_SENTINELS) await writeSentinel(sentinel, ORDINARY)
  await writeSentinel(E2E_SENTINEL, `import { test } from '@playwright/test'\ntest('sentinel', () => {})\n`)
}, 30_000)

afterAll(async () => {
  await root?.remove()
})

describe('project-live opt-in discovery boundary', () => {
  it('lists every default project file but never the live smoke or manual runner for `pnpm test`', { timeout: 120_000 }, async () => {
    const projects = await defaultScriptProjects()
    expect(projects.filter((arg) => arg !== '--project').sort()).toEqual(['contract', 'integration', 'ui', 'unit'])
    const files = await vitestFiles(projects)
    expect(files).toEqual([...DEFAULT_SENTINELS].sort())
  })

  it('keeps the live smoke out of a bare Vitest run and of negated project filters', { timeout: 120_000 }, async () => {
    const bare = await vitestFiles([])
    expect(bare).not.toContain(PROJECT_SMOKE)
    expect(bare).not.toContain(MANUAL_RUNNER)
    expect(bare.filter((file) => file.startsWith('tests/manual/'))).toEqual([])
    for (const sentinel of DEFAULT_SENTINELS) expect(bare).toContain(sentinel)

    const negated = await vitestFiles(['--project', '!unit'])
    expect(negated).not.toContain(PROJECT_SMOKE)
    // A wildcard is not an explicit selection; the legacy smoke keeps its unchanged behavior.
    expect(await vitestFiles(['--project', '*smoke*'])).toEqual([LEGACY_SMOKE])
  })

  it('reaches the live smoke only through the explicit project-meta-smoke project', { timeout: 120_000 }, async () => {
    expect(await vitestFiles(['--project', 'project-meta-smoke'])).toEqual([PROJECT_SMOKE])
    expect(await vitestFiles(['--project=project-meta-smoke'])).toEqual([PROJECT_SMOKE])
    expect(await vitestFiles(['-p', 'project-meta-smoke'])).toEqual([PROJECT_SMOKE])
  })

  it('fails the explicit live gate instead of passing vacuously when its test file is absent', { timeout: 120_000 }, async () => {
    const empty = await createTempDirectory('flowproof-discovery-empty-')
    try {
      await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(empty.path, 'node_modules'), 'dir')
      await copyFile(path.join(REPO_ROOT, 'vitest.config.ts'), path.join(empty.path, 'vitest.config.ts'))
      const outcome = await run(process.execPath, [path.join(empty.path, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'project-meta-smoke'], {
        cwd: empty.path,
        encoding: 'utf8',
        timeout: 90_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: empty.path, CI: '1' },
      }).then(
        () => ({ code: 0, output: '' }),
        (error: { code?: unknown; stdout?: string; stderr?: string }) => ({
          code: typeof error.code === 'number' ? error.code : -1,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        }),
      )
      expect(outcome.code).not.toBe(0)
      expect(outcome.output).toMatch(/No test files found/)
    } finally {
      await empty.remove()
    }
  })

  it('keeps the explicit live script and the manual runner outside default Playwright discovery', { timeout: 120_000 }, async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['test:project-meta-smoke']).toMatch(/--project project-meta-smoke(?:\s|$)/)
    expect(manifest.scripts.test).not.toMatch(/meta-smoke/)

    const { stdout } = await run(process.execPath, [path.join(root.path, 'node_modules/@playwright/test/cli.js'), 'test', '--list'], {
      cwd: root.path,
      encoding: 'utf8',
      timeout: 90_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root.path, CI: '1' },
    })
    expect(stdout).toContain('discovery-sentinel.spec.ts')
    expect(stdout).not.toMatch(/project-live-acceptance|meta-smoke|tests\/manual/)
  })
})
