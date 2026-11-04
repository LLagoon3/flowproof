import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { canonicalJson, sha256Hex } from '../../packages/flowproof/src/evidence/store.js'
import { admitProjectPatch, applyProjectPatch } from '../../packages/flowproof/src/patch/projectDiff.js'
import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import type { ExecutionConfiguration } from '../../packages/flowproof/src/project/contracts.js'
import { ProfileError, admissionProfileOf, createExecutionConfiguration, parseRuntimeManifest, readRuntimeManifest, verifyRuntimeImage } from '../../packages/flowproof/src/project/profile.js'
import type { RuntimeProfile } from '../../packages/flowproof/src/project/profile.js'
import { RUNTIME_LABEL, createProjectRuntime } from '../../packages/flowproof/src/project/runtime.js'
import type { ImmutableOutput, ProjectRuntime } from '../../packages/flowproof/src/project/runtime.js'
import { exportProjectSnapshot } from '../../packages/flowproof/src/project/snapshot.js'
import type { ProjectSnapshot } from '../../packages/flowproof/src/project/snapshot.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository, OriginalProjectSnapshot } from '../helpers/projectLiveRepository.js'
import { commitFiles, containersWithLabel, runtimeManifestPath, sampleConfigFile } from '../support/projectSetup.js'

// T011: the offline project runtime against the actual operator-prepared immutable image. Every
// container is created from the pinned image ID with `--pull=never`, a read-only root, no
// capabilities, no-new-privileges, CPU/memory/PID limits, `--network=none`, an explicit environment
// and private HOME, and only the owned snapshot workspace (read-only) plus a separate owned output
// directory mounted. Commands are direct argv. Producers are stopped and joined before any output is
// copied through no-follow paths into immutable serving storage. Requires Docker and the prepared
// image recorded in the operator manifest; a missing image is a failing prerequisite, not a skip.
// This is the new project runtime, not the network-enabled bridge editor of Spec 002.

const run = promisify(execFile)
const DOCKER_TIMEOUT = 180_000

const PROBE = String.raw`
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
const attempt = (fn) => { try { fn(); return 'allowed' } catch (error) { return error.code ?? 'error' } }
const status = readFileSync('/proc/self/status', 'utf8')
const field = (name) => (status.match(new RegExp('^' + name + ':\\s*(.*)$', 'm')) ?? [])[1] ?? null
const read = (file) => { try { return readFileSync(file, 'utf8').trim() } catch { return null } }
const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((line) => { const parts = line.split(' '); return { root: parts[3], point: parts[4] } })
let network = 'unreachable'
try { await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(3000) }); network = 'reachable' } catch {}
console.log('FLOWPROOF_PROBE ' + JSON.stringify({
  uid: process.getuid(), gid: process.getgid(), argv: process.argv.slice(1), cwd: process.cwd(),
  env: Object.keys(process.env).sort(), home: process.env.HOME,
  capEff: field('CapEff'), noNewPrivs: field('NoNewPrivs'),
  interfaces: Object.keys(os.networkInterfaces()).sort(), network,
  writeRoot: attempt(() => writeFileSync('/flowproof-probe', 'x')),
  writeSource: attempt(() => writeFileSync('/workspace/src/App.jsx', 'x')),
  writeWorkspace: attempt(() => writeFileSync('/workspace/new-file', 'x')),
  writeOutput: attempt(() => writeFileSync('/workspace/dist/new-file', 'x')),
  writeHome: attempt(() => writeFileSync(process.env.HOME + '/probe', 'x')),
  writeToolchain: attempt(() => writeFileSync('/opt/flowproof/toolchain/node_modules/probe', 'x')),
  dockerSocket: existsSync('/var/run/docker.sock') || existsSync('/run/docker.sock'),
  gitDir: existsSync('/workspace/.git'),
  workspace: readdirSync('/workspace').sort(),
  memoryMax: read('/sys/fs/cgroup/memory.max'), pidsMax: read('/sys/fs/cgroup/pids.max'), cpuMax: read('/sys/fs/cgroup/cpu.max'),
  mounts,
}))
`

const HOSTILE_BUILD = String.raw`
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
const mode = process.argv[2]
const attempt = (fn) => { try { fn(); return 'allowed' } catch (error) { return error.code ?? 'error' } }
mkdirSync('dist/assets', { recursive: true })
if (mode !== 'empty') writeFileSync('dist/index.html', '<!doctype html><title>hostile</title>')
if (mode === 'sleep') await new Promise((resolve) => setTimeout(resolve, 120000))
if (mode === 'symlink') symlinkSync('/etc/passwd', 'dist/leak')
if (mode === 'large') writeFileSync('dist/assets/large.bin', Buffer.alloc(33 * 1024 * 1024, 1))
if (mode === 'fail') process.exit(2)
if (mode === 'mutate') {
  writeFileSync('dist/report.json', JSON.stringify({
    source: attempt(() => writeFileSync('src/App.jsx', 'export default null')),
    lock: attempt(() => writeFileSync('package-lock.json', '{}')),
    parent: attempt(() => writeFileSync('../escape', 'x')),
  }))
}
`

const NOISY = "process.stdout.write('x'.repeat(5 * 1024 * 1024)); process.stdout.write('\\nend\\n')\n"
const FAIL = 'process.exit(3)\n'

const repositories: MaterializedProjectRepository[] = []
const owned: Array<() => Promise<unknown>> = []
let profile: RuntimeProfile
let runtime: ProjectRuntime

beforeAll(async () => {
  profile = await readRuntimeManifest(runtimeManifestPath())
  await verifyRuntimeImage(profile)
  runtime = createProjectRuntime({ profile })
}, DOCKER_TIMEOUT)

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const release of owned.splice(0).reverse()) await release()
})

afterAll(async () => {
  expect(await runtime.dispose()).toBe(true)
  for (const repository of repositories.splice(0)) await repository.remove()
  expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
}, DOCKER_TIMEOUT)

interface Prepared {
  readonly repository: MaterializedProjectRepository
  readonly project: AdmittedProject
  readonly before: OriginalProjectSnapshot
}

async function prepare(changes?: Readonly<Record<string, string>>, options: { readonly seedIgnored?: boolean } = {}): Promise<Prepared> {
  const repository = await materializeProjectLiveRepository(options)
  repositories.push(repository)
  if (changes) await commitFiles(repository.root, changes)
  const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error(`fixture admission failed: ${admission.reasons.join(',')}`)
  return { repository, project: admission.project, before: await snapshotOriginalProject(repository.root) }
}

async function configure(project: AdmittedProject, overrides: Record<string, unknown> = {}): Promise<ExecutionConfiguration> {
  const file = await sampleConfigFile()
  const settings = { entry_path: file.entry_path, build: file.build, required_project_checks: file.required_project_checks, ...overrides }
  const result = createExecutionConfiguration({ project, profile, settings, targetOrigin: 'http://localhost:43155', confirmedAt: new Date().toISOString() })
  if (!result.ok) throw new Error(`configuration refused: ${result.reasons.join(',')}`)
  return result.configuration
}

async function snapshotOf(project: AdmittedProject): Promise<ProjectSnapshot> {
  const snapshot = await exportProjectSnapshot({ project, purpose: 'admission-snapshot' })
  owned.push(() => snapshot.remove())
  return snapshot
}

function keep(output: ImmutableOutput | null): ImmutableOutput {
  if (output === null) throw new Error('expected an accepted build output')
  owned.push(() => output.remove())
  return output
}

async function expectOriginalUnchanged(prepared: Prepared): Promise<void> {
  expect(changedSnapshotFacets(prepared.before, await snapshotOriginalProject(prepared.repository.root))).toEqual([])
}

describe('immutable image and lock admission', () => {
  it('accepts the recorded image only by its immutable ID and refuses tags, tampering, mismatches and absent images without pulling', async () => {
    const manifest = JSON.parse(await readFile(runtimeManifestPath(), 'utf8')) as Record<string, any>
    expect(parseRuntimeManifest(manifest).imageId).toBe(profile.imageId)
    const redigest = (body: Record<string, any>): Record<string, any> => {
      const { manifest_sha256: _digest, ...rest } = body
      return { ...rest, manifest_sha256: sha256Hex(canonicalJson(rest)) }
    }
    const code = (fn: () => unknown): string | null => {
      try {
        fn()
        return null
      } catch (error) {
        return error instanceof ProfileError ? error.code : 'OTHER'
      }
    }
    expect(code(() => parseRuntimeManifest(redigest({ ...manifest, image: { ...manifest.image, id: 'flowproof-project-vite:lock-edff91106eee' } })))).toBe('PROFILE_IMAGE_REFERENCE_MUTABLE')
    expect(code(() => parseRuntimeManifest({ ...manifest, prepared_at: '2026-11-05T00:00:00.000Z' }))).toBe('PROFILE_MANIFEST_DIGEST_MISMATCH')
    expect(code(() => parseRuntimeManifest({ ...manifest, extra: true }))).toBe('PROFILE_MANIFEST_INVALID')

    const otherLock = parseRuntimeManifest(redigest({ ...manifest, fixture: { ...manifest.fixture, lock_sha256: 'd'.repeat(64) } }))
    await expect(verifyRuntimeImage(otherLock)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_MISMATCH' })

    const absentId = `sha256:${'0'.repeat(64)}`
    const absent = parseRuntimeManifest(redigest({ ...manifest, image: { ...manifest.image, id: absentId } }))
    await expect(verifyRuntimeImage(absent)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_MISSING' })
    await expect(run('docker', ['image', 'inspect', '--', absentId])).rejects.toBeTruthy()
  }, DOCKER_TIMEOUT)

  it('refuses a project whose committed lock differs from the image lock before any container exists', async () => {
    const repository = await materializeProjectLiveRepository()
    repositories.push(repository)
    const lock = JSON.parse(await readFile(path.join(repository.root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    lock.packages['node_modules/vite']!.version = '8.3.4'
    await commitFiles(repository.root, { 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` })
    const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
    expect(admission).toEqual({ state: 'blocked', reasons: ['PROJECT_LOCK_MISMATCH'] })
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
  })
})

describe('scrubbed committed snapshot', () => {
  it('exports exactly the admitted committed files, without Git metadata, history, untracked or ignored content', async () => {
    const prepared = await prepare(undefined, { seedIgnored: true })
    const snapshot = await snapshotOf(prepared.project)
    const listing: string[] = []
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(path.join(snapshot.workspace, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(child)
        else listing.push(child)
      }
    }
    await walk('')
    expect(listing.sort()).toEqual(prepared.project.files.map((file) => file.path))
    for (const file of prepared.project.files) {
      expect(sha256Hex(await readFile(path.join(snapshot.workspace, file.path)))).toBe(file.sha256)
    }
    expect(snapshot.root.startsWith(prepared.repository.root)).toBe(false)
    expect(snapshot.privateDir.startsWith(snapshot.workspace)).toBe(false)
    expect(((await stat(snapshot.root)).mode & 0o777).toString(8)).toBe('700')
    expect((await snapshot.verify()).ok).toBe(true)
    await expectOriginalUnchanged(prepared)
  })
})

describe('offline direct-argv execution', () => {
  it('builds the actual sample offline into immutable output and leaves sources, original and containers untouched', async () => {
    const prepared = await prepare()
    const configuration = await configure(prepared.project)
    const snapshot = await snapshotOf(prepared.project)
    const build = await runtime.build({ snapshot, configuration })
    expect(build.status).toBe('passed')
    const output = keep(build.output)
    expect(output.files.map((file) => file.path)).toEqual(expect.arrayContaining(['index.html']))
    expect(output.files.some((file) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(file.path))).toBe(true)
    expect(output.root.startsWith(snapshot.root)).toBe(false)
    for (const file of output.files) {
      const info = await lstat(path.join(output.root, file.path))
      expect(info.isFile()).toBe(true)
      expect(info.mode & 0o222).toBe(0)
      expect(sha256Hex(await readFile(path.join(output.root, file.path)))).toBe(file.sha256)
    }
    expect((await lstat(output.root)).mode & 0o222).toBe(0)
    expect((await snapshot.verify()).ok).toBe(true)

    const check = await runtime.check({ snapshot, configuration, checkId: 'sample-unit', output })
    expect(check.status).toBe('passed')
    expect(check.diagnostics.text).toMatch(/pass 3/)
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
    await expectOriginalUnchanged(prepared)
  }, DOCKER_TIMEOUT)

  it('runs confirmed argv without a shell, as non-root, offline, read-only, unprivileged and limited, with only owned mounts and no host secrets', async () => {
    vi.stubEnv('MODEL_API_KEY', 'flowproof-runtime-canary-not-a-key')
    vi.stubEnv('GIT_DIR', '/nonexistent/.git')
    vi.stubEnv('NODE_OPTIONS', '--require /nonexistent/hook.js')
    const prepared = await prepare({ 'tests/runtime-probe.mjs': PROBE })
    const configuration = await configure(prepared.project, {
      required_project_checks: [{ id: 'probe', argv: ['node', 'tests/runtime-probe.mjs', '$HOME;echo pwned', '`id`'] }],
    })
    const snapshot = await snapshotOf(prepared.project)
    const output = keep((await runtime.build({ snapshot, configuration })).output)
    const check = await runtime.check({ snapshot, configuration, checkId: 'probe', output })
    expect(check.status).toBe('passed')
    const line = check.diagnostics.text.split('\n').find((entry) => entry.startsWith('FLOWPROOF_PROBE '))
    expect(line).toBeDefined()
    const facts = JSON.parse(line!.slice('FLOWPROOF_PROBE '.length))

    expect(facts.argv).toEqual(['/workspace/tests/runtime-probe.mjs', '$HOME;echo pwned', '`id`'])
    expect(facts.cwd).toBe('/workspace')
    expect(facts.uid).not.toBe(0)
    expect(facts.gid).not.toBe(0)
    expect(facts.home).toBe('/tmp')
    expect(facts.env.filter((key: string) => !['HOME', 'HOSTNAME', 'NODE_VERSION', 'NO_COLOR', 'PATH', 'TMPDIR', 'YARN_VERSION'].includes(key))).toEqual([])
    expect(facts.capEff).toBe('0000000000000000')
    expect(facts.noNewPrivs).toBe('1')
    expect(facts.interfaces).toEqual(['lo'])
    expect(facts.network).toBe('unreachable')
    expect(facts.writeRoot).toBe('EROFS')
    expect(facts.writeSource).toBe('EROFS')
    expect(facts.writeWorkspace).toBe('EROFS')
    expect(facts.writeOutput).toBe('EROFS')
    expect(facts.writeToolchain).toBe('EROFS')
    expect(facts.writeHome).toBe('allowed')
    expect(facts.dockerSocket).toBe(false)
    expect(facts.gitDir).toBe(false)
    expect(facts.workspace).toEqual(expect.arrayContaining(['dist', 'index.html', 'node_modules', 'package.json', 'src', 'tests']))
    expect(facts.workspace).not.toContain('.git')
    expect(facts.memoryMax).toBe('1073741824')
    expect(facts.pidsMax).toBe('256')
    expect(facts.cpuMax).toBe('100000 100000')
    const roots = (facts.mounts as Array<{ root: string; point: string }>).map((mount) => mount.root)
    for (const forbidden of [prepared.repository.root, homedir(), path.join(prepared.repository.root, '.git')]) {
      expect(roots.some((root) => root === forbidden || root.startsWith(`${forbidden}/`))).toBe(false)
    }
    const points = (facts.mounts as Array<{ root: string; point: string }>).map((mount) => mount.point)
    expect(points).toEqual(expect.arrayContaining(['/workspace', '/workspace/dist', '/tmp']))
    expect(points.filter((point) => point.startsWith('/workspace')).sort()).toEqual(['/workspace', '/workspace/dist'])
    expect(JSON.stringify(facts)).not.toContain('flowproof-runtime-canary')
    await expectOriginalUnchanged(prepared)
  }, DOCKER_TIMEOUT)

  it('bounds captured output and reports a failing build or check by exit status', async () => {
    const prepared = await prepare({ 'tests/noisy.mjs': NOISY, 'tests/fail.mjs': FAIL, 'tests/hostile-build.mjs': HOSTILE_BUILD })
    const configuration = await configure(prepared.project, {
      required_project_checks: [
        { id: 'noisy', argv: ['node', 'tests/noisy.mjs'] },
        { id: 'failing', argv: ['node', 'tests/fail.mjs'] },
      ],
    })
    const snapshot = await snapshotOf(prepared.project)
    const output = keep((await runtime.build({ snapshot, configuration })).output)
    const noisy = await runtime.check({ snapshot, configuration, checkId: 'noisy', output })
    expect(noisy.status).toBe('passed')
    expect(noisy.diagnostics.truncated).toBe(true)
    expect(noisy.diagnostics.bytes).toBeGreaterThan(configuration.profile.byte_limits.max_diagnostic_bytes)
    expect(Buffer.byteLength(noisy.diagnostics.text)).toBeLessThanOrEqual(configuration.profile.byte_limits.max_diagnostic_bytes)
    const failing = await runtime.check({ snapshot, configuration, checkId: 'failing', output })
    expect(failing).toMatchObject({ status: 'failed', reason: 'RUNTIME_CHECK_FAILED', exitCode: 3 })

    const failingBuild = await runtime.build({
      snapshot,
      configuration: await configure(prepared.project, { build: { argv: ['node', 'tests/hostile-build.mjs', 'fail'], output_directory: 'dist' } }),
    })
    expect(failingBuild).toMatchObject({ status: 'failed', reason: 'RUNTIME_BUILD_FAILED', exitCode: 2, output: null })
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
    await expectOriginalUnchanged(prepared)
  }, DOCKER_TIMEOUT)
})

describe('stop and join before accepting output', () => {
  it('stops and joins a timed-out or cancelled producer, removes its container and accepts no output', async () => {
    const prepared = await prepare({ 'tests/hostile-build.mjs': HOSTILE_BUILD })
    const configuration = await configure(prepared.project, { build: { argv: ['node', 'tests/hostile-build.mjs', 'sleep'], output_directory: 'dist' } })
    const started = Date.now()
    const timedOut = await runtime.build({ snapshot: await snapshotOf(prepared.project), configuration, timeoutMs: 4_000 })
    expect(timedOut).toMatchObject({ status: 'failed', reason: 'RUNTIME_TIMEOUT', output: null })
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 2_000)
    const cancelled = await runtime.build({ snapshot: await snapshotOf(prepared.project), configuration, signal: controller.signal })
    expect(cancelled).toMatchObject({ status: 'failed', reason: 'RUNTIME_CANCELLED', output: null })
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])

    const preAborted = new AbortController()
    preAborted.abort()
    expect(await runtime.build({ snapshot: await snapshotOf(prepared.project), configuration, signal: preAborted.signal })).toMatchObject({ status: 'failed', reason: 'RUNTIME_CANCELLED' })
    await expectOriginalUnchanged(prepared)
  }, DOCKER_TIMEOUT)

  it('refuses symlinked, missing and oversized output and keeps sources immutable during the build', async () => {
    const prepared = await prepare({ 'tests/hostile-build.mjs': HOSTILE_BUILD })
    const buildWith = async (mode: string) =>
      runtime.build({
        snapshot: await snapshotOf(prepared.project),
        configuration: await configure(prepared.project, { build: { argv: ['node', 'tests/hostile-build.mjs', mode], output_directory: 'dist' } }),
      })
    expect(await buildWith('symlink')).toMatchObject({ status: 'failed', reason: 'RUNTIME_OUTPUT_UNSAFE', output: null })
    expect(await buildWith('empty')).toMatchObject({ status: 'failed', reason: 'RUNTIME_OUTPUT_MISSING', output: null })
    expect(await buildWith('large')).toMatchObject({ status: 'failed', reason: 'RUNTIME_OUTPUT_TOO_LARGE', output: null })

    const snapshot = await snapshotOf(prepared.project)
    const mutate = await runtime.build({
      snapshot,
      configuration: await configure(prepared.project, { build: { argv: ['node', 'tests/hostile-build.mjs', 'mutate'], output_directory: 'dist' } }),
    })
    expect(mutate.status).toBe('passed')
    const output = keep(mutate.output)
    const report = JSON.parse(await readFile(path.join(output.root, 'report.json'), 'utf8'))
    expect(report).toEqual({ source: 'EROFS', lock: 'EROFS', parent: 'EROFS' })
    expect((await snapshot.verify()).ok).toBe(true)
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
    await expectOriginalUnchanged(prepared)
  }, DOCKER_TIMEOUT)
})

describe('candidate copy to offline runtime compatibility', () => {
  it('builds an exactly patched candidate snapshot using its frozen expected tree', async () => {
    const prepared = await prepare()
    const source = await readFile(path.join(prepared.repository.root, 'src/App.jsx'), 'utf8')
    const lines = source.replace(/\n$/, '').split('\n')
    const index = lines.findIndex((line) => line.includes("if (filter === 'open') return task.done"))
    expect(index).toBeGreaterThanOrEqual(0)
    const replacement = lines[index]!.replace('return task.done', 'return !task.done')
    const start = Math.max(0, index - 3)
    const end = Math.min(lines.length, index + 4)
    const before = lines.slice(start, index)
    const after = lines.slice(index + 1, end)
    const patch = [
      'diff --git a/src/App.jsx b/src/App.jsx',
      '--- a/src/App.jsx',
      '+++ b/src/App.jsx',
      `@@ -${start + 1},${before.length + 1 + after.length} +${start + 1},${before.length + 1 + after.length} @@`,
      ...before.map((line) => ` ${line}`),
      `-${lines[index]}`,
      `+${replacement}`,
      ...after.map((line) => ` ${line}`),
      '',
    ].join('\n')
    const admission = admitProjectPatch(prepared.project, {
      runId: newProjectUuid(),
      definitionId: newProjectUuid(),
      definitionDigest: 'e'.repeat(64),
      invocationId: newProjectUuid(),
      baselineCommit: prepared.project.context.baseline_commit,
      targetPaths: ['src/App.jsx'],
      patch,
    })
    expect(admission.state).toBe('proposed')
    if (admission.state !== 'proposed') return
    const application = await applyProjectPatch(prepared.project, admission)
    expect(application.state).toBe('applied-to-copy')
    if (application.state !== 'applied-to-copy') return
    owned.push(() => application.copy.remove())
    const result = await runtime.build({ snapshot: application.copy, configuration: await configure(prepared.project) })
    expect(result).toMatchObject({ status: 'passed', output: expect.any(Object) })
    keep(result.output)
    expect(changedSnapshotFacets(prepared.before, await snapshotOriginalProject(prepared.repository.root))).toEqual([])
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
  }, DOCKER_TIMEOUT)
})

describe('nested output integrity boundaries', () => {
  it('keeps committed siblings visible when a nested build output is runtime-owned', async () => {
    const prepared = await prepare({
      'tests/build-output.mjs':
        "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('tests/build', { recursive: true })\nwriteFileSync('tests/build/index.html', '<!doctype html><title>ok</title>')\n",
    })
    const snapshot = await snapshotOf(prepared.project)
    const configuration = await configure(prepared.project, {
      build: { argv: ['node', 'tests/build-output.mjs'], output_directory: 'tests/build' },
    })
    await writeFile(path.join(snapshot.workspace, 'tests/tasks.test.mjs'), 'tampered test input\n')

    const result = await runtime.build({ snapshot, configuration })
    expect(result).toMatchObject({ status: 'failed', reason: 'RUNTIME_INPUT_CHANGED', output: null })
    expect((await snapshot.verify()).changed).toContain('tests/tasks.test.mjs')
    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
    expect(changedSnapshotFacets(prepared.before, await snapshotOriginalProject(prepared.repository.root))).toEqual([])
  }, DOCKER_TIMEOUT)

  it('accepts a nested output whose ancestors did not exist, while strays, symlinks and source tampering stay refused', async () => {
    const prepared = await prepare({
      'tests/nested-output.mjs':
        "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('build/dist', { recursive: true })\nwriteFileSync('build/dist/index.html', '<!doctype html><title>ok</title>')\n",
    })
    const configuration = await configure(prepared.project, {
      build: { argv: ['node', 'tests/nested-output.mjs'], output_directory: 'build/dist' },
    })

    const fresh = await snapshotOf(prepared.project)
    const passed = await runtime.build({ snapshot: fresh, configuration })
    expect(passed).toMatchObject({ status: 'passed' })
    expect(passed.output).not.toBeNull()
    expect(await fresh.verify()).toMatchObject({ ok: true, changed: [], missing: [], unexpected: [] })
    await passed.output?.remove()

    const strays = await snapshotOf(prepared.project)
    await mkdir(path.join(strays.workspace, 'build'))
    await writeFile(path.join(strays.workspace, 'build/stray.txt'), 'stray\n')
    await symlink('/etc', path.join(strays.workspace, 'build/link'))
    expect(await runtime.build({ snapshot: strays, configuration })).toMatchObject({ status: 'failed', reason: 'RUNTIME_INPUT_CHANGED', output: null })
    expect([...(await strays.verify()).unexpected].sort()).toEqual(['build/link', 'build/stray.txt'])

    const tampered = await snapshotOf(prepared.project)
    await writeFile(path.join(tampered.workspace, 'tests/tasks.test.mjs'), 'tampered test input\n')
    expect(await runtime.build({ snapshot: tampered, configuration })).toMatchObject({ status: 'failed', reason: 'RUNTIME_INPUT_CHANGED', output: null })
    expect((await tampered.verify()).changed).toContain('tests/tasks.test.mjs')

    expect(await containersWithLabel(RUNTIME_LABEL, runtime.runtimeId)).toEqual([])
    expect(changedSnapshotFacets(prepared.before, await snapshotOriginalProject(prepared.repository.root))).toEqual([])
  }, DOCKER_TIMEOUT * 3)
})
