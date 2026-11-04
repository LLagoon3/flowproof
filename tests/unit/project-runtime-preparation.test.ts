import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { REPO_ROOT, createTempDirectory } from '../support/repoFixture.js'
import type { TempDirectory } from '../support/repoFixture.js'

// T002: the operator preparation script fails closed. These cases run the real script against a
// recording `docker` stand-in on PATH, so they prove what reaches Docker (environment, argv, build
// context) and that mutable/mismatched identities are rejected before any Docker call. The real
// image build and inspection are operator evidence recorded in verification.md, not this suite.

const run = promisify(execFile)
const SCRIPT = path.join(REPO_ROOT, 'tools/runtime/prepare-project-vite.mjs')
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/project-live')

interface ScriptModule {
  withManifestDigest(body: Record<string, unknown>): Record<string, unknown>
  pinnedBaseReferences(text: string): string[]
  dockerEnvironment(source: Record<string, string | undefined>): Record<string, string>
  writePrivateJson(target: string, value: unknown): Promise<void>
}

const script = (await import(pathToFileURL(SCRIPT).href)) as ScriptModule

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const log = process.env.DOCKER_CONFIG
const args = process.argv.slice(2)
const record = { args, env: process.env }
if (args[0] === 'build') record.context = fs.readdirSync(args[args.length - 1]).sort()
fs.appendFileSync(path.join(log, 'calls.jsonl'), JSON.stringify(record) + '\\n')
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(fs.readFileSync(path.join(log, 'inspect.json'), 'utf8'))
  process.exit(0)
}
process.stderr.write('fake docker refuses ' + args[0] + '\\n')
process.exit(1)
`

let sandbox: TempDirectory
let bin: string
let logDir: string

beforeEach(async () => {
  sandbox = await createTempDirectory('flowproof-prepare-test-')
  bin = path.join(sandbox.path, 'bin')
  logDir = path.join(sandbox.path, 'docker-log')
  await mkdir(bin)
  await mkdir(logDir)
  await writeFile(path.join(bin, 'docker'), FAKE_DOCKER)
  await chmod(path.join(bin, 'docker'), 0o755)
})

afterEach(async () => {
  await sandbox?.remove()
})

interface Outcome {
  readonly code: number
  readonly stdout: string
  readonly error: { readonly code?: string } | null
}

async function runScript(args: readonly string[], extraEnv: Record<string, string> = {}): Promise<Outcome> {
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: sandbox.path,
    TMPDIR: sandbox.path,
    DOCKER_CONFIG: logDir,
    XDG_STATE_HOME: path.join(sandbox.path, 'state'),
    ...extraEnv,
  }
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 60_000 })
    return { code: 0, stdout, error: null }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    const line = (failure.stderr ?? '').trim().split('\n').pop() ?? ''
    let parsed: { code?: string } | null = null
    try {
      parsed = JSON.parse(line) as { code?: string }
    } catch {
      parsed = null
    }
    return { code: typeof failure.code === 'number' ? failure.code : -1, stdout: failure.stdout ?? '', error: parsed }
  }
}

interface DockerCall {
  readonly args: string[]
  readonly env: Record<string, string>
  readonly context?: string[]
}

async function dockerCalls(): Promise<DockerCall[]> {
  try {
    return (await readFile(path.join(logDir, 'calls.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerCall)
  } catch {
    return []
  }
}

async function fixtureDigests(): Promise<{ lock: string; pkg: string }> {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8')) as {
    lock: { sha256: string }
    files: Record<string, { sha256: string }>
  }
  return { lock: manifest.lock.sha256, pkg: manifest.files['package.json']?.sha256 ?? '' }
}

async function manifestBody(overrides: { imageId?: string; lock?: string } = {}): Promise<Record<string, unknown>> {
  const digests = await fixtureDigests()
  return {
    schema_version: 1,
    profile_id: 'vite-static-v1',
    image: { id: overrides.imageId ?? `sha256:${'a'.repeat(64)}`, repo_digests: [], architecture: 'amd64', os: 'linux', user: '65532:65532', layers: [], labels: {} },
    fixture: { fixture_id: 'vite-task-board', lock_path: 'package-lock.json', lock_sha256: overrides.lock ?? digests.lock, package_sha256: digests.pkg },
    dependencies: { root: '/opt/flowproof/toolchain/node_modules', tree_sha256: 'b'.repeat(64) },
    tools: {},
    absent_tools: [],
    build: {},
    prepared_at: '2026-11-04T00:00:00.000Z',
  }
}

async function writeManifest(value: Record<string, unknown>): Promise<string> {
  const target = path.join(sandbox.path, 'manifest.json')
  await writeFile(target, JSON.stringify(value))
  return target
}

describe('operator toolchain preparation', () => {
  it('rejects a mutable image reference before any Docker call', async () => {
    const manifest = await writeManifest(script.withManifestDigest(await manifestBody({ imageId: 'flowproof-project-vite:latest' })))
    const outcome = await runScript(['verify', '--manifest', manifest])
    expect(outcome.code).not.toBe(0)
    expect(outcome.error?.code).toBe('IMAGE_REFERENCE_MUTABLE')
    expect(await dockerCalls()).toEqual([])
  })

  it('rejects extra manifest keys and a manifest whose content differs from its digest', async () => {
    const extra = await writeManifest({ ...script.withManifestDigest(await manifestBody()), network: 'bridge' })
    expect((await runScript(['verify', '--manifest', extra])).error?.code).toBe('MANIFEST_INVALID')

    const tampered = script.withManifestDigest(await manifestBody())
    ;(tampered.dependencies as Record<string, unknown>).tree_sha256 = 'c'.repeat(64)
    const target = await writeManifest(tampered)
    expect((await runScript(['verify', '--manifest', target])).error?.code).toBe('MANIFEST_DIGEST_MISMATCH')
    expect(await dockerCalls()).toEqual([])
  })

  it('rejects a manifest bound to another lock before inspecting any image', async () => {
    const manifest = await writeManifest(script.withManifestDigest(await manifestBody({ lock: 'd'.repeat(64) })))
    const outcome = await runScript(['verify', '--manifest', manifest])
    expect(outcome.error?.code).toBe('FIXTURE_LOCK_MISMATCH')
    expect(await dockerCalls()).toEqual([])
  })

  it('rejects an image whose recorded identity or lock label differs from the manifest', async () => {
    const digests = await fixtureDigests()
    const id = `sha256:${'e'.repeat(64)}`
    const manifest = await writeManifest(script.withManifestDigest(await manifestBody({ imageId: id })))
    const document = (labels: Record<string, string>, reportedId = id): string =>
      JSON.stringify([{ Id: reportedId, Config: { User: '65532:65532', Entrypoint: null, Env: ['PATH=/usr/bin'], Labels: labels } }])

    await writeFile(path.join(logDir, 'inspect.json'), document({}, `sha256:${'f'.repeat(64)}`))
    expect((await runScript(['verify', '--manifest', manifest])).error?.code).toBe('IMAGE_MISMATCH')

    await writeFile(
      path.join(logDir, 'inspect.json'),
      document({
        'dev.flowproof.profile': 'vite-static-v1',
        'dev.flowproof.lock-sha256': '0'.repeat(64),
        'dev.flowproof.package-sha256': digests.pkg,
      }),
    )
    expect((await runScript(['verify', '--manifest', manifest])).error?.code).toBe('IMAGE_LOCK_MISMATCH')
    // Only read-only inspection reached Docker; no container ran for a mismatched image.
    expect((await dockerCalls()).every((call) => call.args[0] === 'image' && call.args[1] === 'inspect')).toBe(true)
  })

  it('refuses an unpinned base image and a tampered fixture lock before building', async () => {
    const dockerfile = path.join(sandbox.path, 'unpinned.Dockerfile')
    await writeFile(dockerfile, 'FROM node:24-bookworm-slim\nRUN true\n')
    expect((await runScript(['prepare', '--dockerfile', dockerfile])).error?.code).toBe('BASE_IMAGE_NOT_PINNED')
    expect(() => script.pinnedBaseReferences('FROM node@sha256:abc\n')).toThrow(/BASE_IMAGE_NOT_PINNED/)

    const fixtureCopy = path.join(sandbox.path, 'fixture')
    await cp(FIXTURE_DIR, fixtureCopy, { recursive: true })
    const lockPath = path.join(fixtureCopy, 'task-board/package-lock.json')
    await writeFile(lockPath, (await readFile(lockPath, 'utf8')).replace('"version": "8.3.5"', '"version": "8.3.6"'))
    expect((await runScript(['prepare', '--fixture-dir', fixtureCopy])).error?.code).toBe('FIXTURE_LOCK_MISMATCH')
    expect(await dockerCalls()).toEqual([])
  })

  it('builds from a two-file context with no credential, build argument, secret or SSH forwarding', async () => {
    const outcome = await runScript(['prepare', '--output', path.join(sandbox.path, 'out/manifest.json')], {
      MODEL_API_KEY: 'sk-flowproof-sentinel-model-key',
      OPENAI_API_KEY: 'sk-flowproof-sentinel-openai-key',
      GITHUB_TOKEN: 'ghp_flowproofsentineltoken',
      NPM_TOKEN: 'npm_flowproofsentineltoken',
    })
    expect(outcome.error?.code).toBe('IMAGE_BUILD_FAILED')
    const calls = await dockerCalls()
    const build = calls.find((call) => call.args[0] === 'build')
    expect(build).toBeDefined()
    expect(build?.context).toEqual(['package-lock.json', 'package.json'])
    expect(build?.args.some((arg) => /^--(?:build-arg|secret|ssh)/.test(arg))).toBe(false)
    for (const call of calls) {
      expect(Object.keys(call.env).sort()).toEqual(expect.arrayContaining(['PATH']))
      expect(JSON.stringify(call.env)).not.toMatch(/sentinel|MODEL_API_KEY|OPENAI|GITHUB_TOKEN|NPM_TOKEN/)
    }
    // The private build context is removed after the failed build; no manifest is written.
    const leftovers = (await readdir(sandbox.path)).filter((entry) => entry.startsWith('flowproof-vite-'))
    expect(leftovers).toEqual([])
    await expect(readFile(path.join(sandbox.path, 'out/manifest.json'))).rejects.toThrow()
  })

  it('forwards only Docker connection settings from the operator environment', () => {
    const environment = script.dockerEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/operator',
      DOCKER_HOST: 'unix:///run/docker.sock',
      MODEL_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      DOCKER_AUTH_CONFIG: 'secret',
    })
    expect(Object.keys(environment).sort()).toEqual(['DOCKER_CLI_HINTS', 'DOCKER_HOST', 'HOME', 'LC_ALL', 'PATH'])
  })
})

// The manifest writer behind `prepare` (its only caller). Every path lives in this test's own
// sandbox: an existing directory keeps its exact mode, only directories this write creates are
// 0700, the manifest is a new 0600 file renamed into place, and an unusable path stays unchanged.
describe('private manifest output', () => {
  const MANIFEST = { schema_version: 1, profile_id: 'vite-static-v1', note: 'manifest' }
  const modeOf = async (target: string): Promise<string> => ((await lstat(target)).mode & 0o7777).toString(8)

  async function directoryWithMode(name: string, mode: number): Promise<string> {
    const directory = path.join(sandbox.path, name)
    await mkdir(directory)
    await chmod(directory, mode)
    return directory
  }

  /** Type, exact mode (including sticky bits), digest or link target of every entry below root. */
  async function treeOf(root: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {}
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name)
        const absolute = path.join(root, name)
        if (entry.isSymbolicLink()) entries[name] = `symlink:${await readlink(absolute)}`
        else if (entry.isDirectory()) entries[name] = `dir:${await modeOf(absolute)}`
        else entries[name] = `file:${await modeOf(absolute)}:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`
        if (entry.isDirectory() && !entry.isSymbolicLink() && (await lstat(absolute)).mode & 0o400) await walk(name)
      }
    }
    await walk('')
    return entries
  }

  async function outcomeOf(operation: Promise<unknown>): Promise<string> {
    try {
      await operation
      return 'written'
    } catch (error) {
      return String((error as { code?: unknown }).code ?? 'unknown')
    }
  }

  async function written(directory: string): Promise<{ directory: string; file: string; entries: string[]; content: unknown }> {
    return {
      directory: await modeOf(directory),
      file: await modeOf(path.join(directory, 'manifest.json')),
      entries: (await readdir(directory)).sort(),
      content: JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
    }
  }

  it('keeps the exact mode of an existing sticky, shared or private manifest directory', async () => {
    const observed: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const mode of [0o1777, 0o755, 0o770, 0o700]) {
      const label = mode.toString(8)
      const directory = await directoryWithMode(`existing-${label}`, mode)
      await script.writePrivateJson(path.join(directory, 'manifest.json'), MANIFEST)
      observed[label] = await written(directory)
      expected[label] = { directory: label, file: '600', entries: ['manifest.json'], content: MANIFEST }
    }
    expect(observed).toEqual(expected)
  })

  it('creates only the missing directories, privately, below an unchanged existing or symlinked ancestor', async () => {
    const base = await directoryWithMode('base', 0o755)
    await script.writePrivateJson(path.join(base, 'a/b/c/manifest.json'), MANIFEST)
    const real = await directoryWithMode('real', 0o1777)
    await symlink(real, path.join(sandbox.path, 'link'))
    await script.writePrivateJson(path.join(sandbox.path, 'link/new/manifest.json'), MANIFEST)
    expect({
      base: await modeOf(base),
      created: [await modeOf(path.join(base, 'a')), await modeOf(path.join(base, 'a/b'))],
      nested: await written(path.join(base, 'a/b/c')),
      real: await modeOf(real),
      link: await readlink(path.join(sandbox.path, 'link')),
      linked: await written(path.join(real, 'new')),
    }).toEqual({
      base: '755',
      created: ['700', '700'],
      nested: { directory: '700', file: '600', entries: ['manifest.json'], content: MANIFEST },
      real: '1777',
      link: real,
      linked: { directory: '700', file: '600', entries: ['manifest.json'], content: MANIFEST },
    })
  })

  it('atomically replaces an existing regular manifest with a new private file', async () => {
    const directory = await directoryWithMode('replace', 0o755)
    const target = path.join(directory, 'manifest.json')
    await writeFile(target, '{"old":true}\n', { mode: 0o644 })
    await chmod(target, 0o644)
    const before = (await lstat(target)).ino
    await script.writePrivateJson(target, MANIFEST)
    expect(await written(directory)).toEqual({ directory: '755', file: '600', entries: ['manifest.json'], content: MANIFEST })
    expect((await lstat(target)).ino).not.toBe(before)
  })

  it('refuses an unusable manifest path unchanged and leaves no temporary file or directory', async () => {
    const elsewhere = await directoryWithMode('elsewhere', 0o755)
    await writeFile(path.join(elsewhere, 'kept.json'), '{"kept":true}\n')
    await symlink(elsewhere, path.join(sandbox.path, 'linked-dir'))
    await writeFile(path.join(sandbox.path, 'plain-file'), 'not a directory\n')
    const holder = await directoryWithMode('holder', 0o755)
    await mkdir(path.join(holder, 'manifest.json'))
    await writeFile(path.join(holder, 'manifest.json/inside.txt'), 'inside\n')
    const linkHolder = await directoryWithMode('link-holder', 0o755)
    await symlink(path.join(elsewhere, 'kept.json'), path.join(linkHolder, 'manifest.json'))
    const cases: Record<string, string> = {
      'symlinked manifest directory': path.join(sandbox.path, 'linked-dir/manifest.json'),
      'manifest directory is a file': path.join(sandbox.path, 'plain-file/manifest.json'),
      'ancestor is a file': path.join(sandbox.path, 'plain-file/sub/manifest.json'),
      'target is a directory': path.join(holder, 'manifest.json'),
      'target is a symlink': path.join(linkHolder, 'manifest.json'),
    }
    const expected: Record<string, string> = Object.fromEntries(Object.keys(cases).map((name) => [name, 'OUTPUT_INVALID']))
    const unwritable = typeof process.getuid === 'function' && process.getuid() !== 0
    if (unwritable) {
      const readOnly = await directoryWithMode('read-only', 0o500)
      cases['existing unwritable directory'] = path.join(readOnly, 'manifest.json')
      cases['missing child of an unwritable directory'] = path.join(readOnly, 'new/manifest.json')
      expected['existing unwritable directory'] = 'OUTPUT_WRITE_FAILED'
      expected['missing child of an unwritable directory'] = 'OUTPUT_WRITE_FAILED'
    }
    const before = await treeOf(sandbox.path)
    const outcomes: Record<string, string> = {}
    for (const [name, target] of Object.entries(cases)) outcomes[name] = await outcomeOf(script.writePrivateJson(target, MANIFEST))
    const after = await treeOf(sandbox.path)
    if (unwritable) await chmod(path.join(sandbox.path, 'read-only'), 0o700)
    expect({ outcomes, tree: after }).toEqual({ outcomes: expected, tree: before })
  })
})
