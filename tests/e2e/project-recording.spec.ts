import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { admissionProfileOf, readProjectConfigFile, readRuntimeManifest } from '../../packages/flowproof/src/project/profile.js'
import type { ProjectSettings } from '../../packages/flowproof/src/project/profile.js'
import type { ProjectModelFake } from '../../packages/flowproof/src/model/projectClient.js'
import { startProjectStudio } from '../../packages/flowproof/src/studio/launch.js'
import type { StudioInstance } from '../../packages/flowproof/src/studio/launch.js'
import { RUNTIME_LABEL } from '../../packages/flowproof/src/project/runtime.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { containersWithLabel, runtimeManifestPath, sampleConfigFile } from '../support/projectSetup.js'

// T026 (S6 unit A4a): the actual launcher-owned recorder on the real prepared target frame. The
// built Studio, pinned offline runtime and permitted T001 repository are real; capture, finish,
// discard and analyze are driven from the launched page so the launch cookie, Origin and host
// authority are exercised. The only seam is an explicitly labelled `test_transport` that counts
// provider exchanges and must never be reached here. No report, frame or recorder is fabricated.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

interface ApiResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function admittedProject(repository: MaterializedProjectRepository): Promise<AdmittedProject> {
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error(`fixture admission failed: ${admission.reasons.join(',')}`)
  return admission.project
}

async function settingsFromFile(): Promise<{ readonly root: string; readonly settings: ProjectSettings }> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowproof-s6-recording-config-'))
  const file = path.join(root, 'project.json')
  await writeFile(file, JSON.stringify(await sampleConfigFile()), { mode: 0o600 })
  return { root, settings: await readProjectConfigFile(file) }
}

/** A guarded request issued by the launched Studio page itself (its cookie and Origin). */
async function api(page: Page, method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<ApiResult> {
  return page.evaluate(
    async ({ method, pathname, body }) => {
      const response = await fetch(pathname, {
        method,
        headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    { method, pathname, body },
  )
}

const codeOf = (result: ApiResult): unknown => {
  const error = result.body.error as Record<string, unknown> | undefined
  return error?.code ?? result.body.code
}

test('records real target actions, seals an immutable report, discards it, and refuses analysis without a provider call', async () => {
  const repository = await materializeProjectLiveRepository()
  const before = await snapshotOriginalProject(repository.root)
  const config = await settingsFromFile()
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const project = await admittedProject(repository)
  const containersBefore = await containersWithLabel(RUNTIME_LABEL)
  const providerCalls: string[] = []
  const modelFake: ProjectModelFake = Object.freeze({
    label: 'test_transport' as const,
    fetch: async (input: string | URL | Request): Promise<Response> => {
      providerCalls.push(String(input instanceof Request ? input.url : input))
      throw new Error('test_transport: no provider exchange is permitted in this journey')
    },
  })
  const browserModelRoutes: string[] = []
  const foreignRequests: string[] = []
  let instance: StudioInstance | null = null

  try {
    instance = await startProjectStudio({
      repoRoot: process.cwd(),
      project,
      profile,
      initialSettings: config.settings,
      modelConfigured: false,
      modelEnv: Object.freeze({}),
      modelFake,
    })
    const page = instance.page
    const studioOrigin = new URL(page.url()).origin
    page.on('request', (outgoing) => {
      const url = new URL(outgoing.url())
      if (url.pathname === '/api/runs' || url.pathname.endsWith('/analyze') || url.pathname.endsWith('/clarify')) browserModelRoutes.push(url.pathname)
      if (url.protocol.startsWith('http') && url.origin !== studioOrigin && url.hostname !== new URL(studioOrigin).hostname) foreignRequests.push(url.origin)
    })

    await page.getByRole('checkbox', { name: /I reviewed the committed project identity/ }).check()
    await page.getByTestId('confirm-project-settings').click()
    await expect(page.getByTestId('project-target')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByText('sample-unit: passed')).toBeVisible()
    const target = page.frameLocator('[data-testid="project-target"]')
    await expect(target.getByTestId('task-summary')).toHaveText('3 open tasks')

    const context = await api(page, 'GET', '/api/project/context')
    expect(context.status).toBe(200)
    const configuration = context.body.configuration as Record<string, unknown>
    const preparation = context.body.preparation as Record<string, unknown>
    expect(configuration.state).toBe('confirmed')
    expect(preparation.state).toBe('ready')
    const configurationId = configuration.configuration_id as string
    const outputSha = preparation.output_sha256 as string
    expect(configurationId).toMatch(UUID)
    expect(outputSha).toMatch(SHA256)

    // Host authority: a request without the launch cookie, stale identities and browser-supplied
    // run identity are all refused before any capture exists.
    const outsider = await playwrightRequest.newContext({ baseURL: studioOrigin })
    try {
      const anonymous = await outsider.post('/api/project/captures', { data: { configuration_id: configurationId, output_sha256: outputSha } })
      expect(anonymous.status()).toBeGreaterThanOrEqual(400)
      expect(anonymous.status()).toBeLessThan(500)
    } finally {
      await outsider.dispose()
    }
    const stale = await api(page, 'POST', '/api/project/captures', { configuration_id: '00000000-0000-4000-8000-000000000000', output_sha256: outputSha })
    expect([stale.status, codeOf(stale)]).toEqual([409, 'CONFIGURATION_STALE'])
    const stalePreparation = await api(page, 'POST', '/api/project/captures', { configuration_id: configurationId, output_sha256: '0'.repeat(64) })
    expect([stalePreparation.status, codeOf(stalePreparation)]).toEqual([409, 'PREPARATION_STALE'])
    const forged = await api(page, 'POST', '/api/project/captures', { configuration_id: configurationId, output_sha256: outputSha, run_id: '00000000-0000-4000-8000-000000000001' })
    expect([forged.status, codeOf(forged)]).toEqual([400, 'REQUEST_FIELD_REJECTED'])

    // Start: the host mints run and capture identities.
    const started = await api(page, 'POST', '/api/project/captures', { configuration_id: configurationId, output_sha256: outputSha })
    expect(started.status).toBe(200)
    expect(Object.keys(started.body).sort()).toEqual(['capture_id', 'run_id', 'state'])
    expect(started.body.state).toBe('recording')
    const runId = started.body.run_id as string
    const captureId = started.body.capture_id as string
    expect(runId).toMatch(UUID)
    expect(captureId).toMatch(UUID)
    const recording = await api(page, 'GET', `/api/project/runs/${runId}`)
    expect(recording.status).toBe(200)
    expect(recording.body).toMatchObject({ run_id: runId, state: 'recording', capture_id: captureId, report: 'none', report_sha256: null, interpretation: null })

    // Real actions on the admitted target frame after the recorder's entry reset: click and native select.
    await expect(target.getByTestId('task-summary')).toHaveText('3 open tasks')
    await target.getByTestId('task-list').getByRole('checkbox').first().click()
    await expect(target.getByTestId('task-summary')).toHaveText('4 open tasks')
    const filter = target.getByTestId('task-filter')
    const options = await filter.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    expect(options.length).toBeGreaterThan(1)
    await filter.selectOption(options[1]!)
    await expect(filter).toHaveValue(options[1]!)

    // Finish drains and seals; the browser learns only identity, state and digest.
    const finished = await api(page, 'POST', `/api/project/captures/${captureId}/finish`, {})
    expect(finished.status).toBe(200)
    expect(Object.keys(finished.body).sort()).toEqual(['capture_id', 'report_sha256', 'run_id', 'state'])
    expect(finished.body).toMatchObject({ run_id: runId, capture_id: captureId, state: 'ready' })
    const reportSha = finished.body.report_sha256 as string
    expect(reportSha).toMatch(SHA256)

    // Immutable: later target actions cannot alter the sealed report.
    await filter.selectOption(options[0]!)
    await target.getByTestId('task-list').getByRole('checkbox').first().click()
    await expect(target.getByTestId('task-summary')).toHaveText('3 open tasks')
    const refinished = await api(page, 'POST', `/api/project/captures/${captureId}/finish`, {})
    expect(refinished.status).toBe(200)
    expect(refinished.body).toMatchObject({ run_id: runId, capture_id: captureId, state: 'ready', report_sha256: reportSha })
    const sealed = await api(page, 'GET', `/api/project/runs/${runId}`)
    expect(sealed.body).toMatchObject({ run_id: runId, state: 'capture-ready', capture_id: captureId, report: 'sealed', report_sha256: reportSha, interpretation: null })
    expect(providerCalls).toEqual([])
    expect(browserModelRoutes).toEqual([])

    // Discard before analysis deletes the sealed evidence; the report can never be reused.
    const discarded = await api(page, 'POST', `/api/project/captures/${captureId}/discard`, {})
    expect(discarded.status).toBe(200)
    expect(discarded.body).toEqual({ run_id: runId, capture_id: captureId, state: 'discarded' })
    const afterDiscard = await api(page, 'GET', `/api/project/runs/${runId}`)
    expect(afterDiscard.body).toMatchObject({ run_id: runId, capture_id: null, report: 'none', report_sha256: null, interpretation: null })
    expect(afterDiscard.body.state).not.toBe('capture-ready')

    const analyzed = await api(page, 'POST', `/api/project/captures/${captureId}/analyze`, { submit: true })
    expect([analyzed.status, codeOf(analyzed)]).toEqual([404, 'CAPTURE_UNKNOWN'])
    expect(analyzed.body).not.toHaveProperty('interpretation')
    const finishAgain = await api(page, 'POST', `/api/project/captures/${captureId}/finish`, {})
    expect([finishAgain.status, codeOf(finishAgain)]).toEqual([404, 'CAPTURE_UNKNOWN'])
    const discardAgain = await api(page, 'POST', `/api/project/captures/${captureId}/discard`, {})
    expect([discardAgain.status, codeOf(discardAgain)]).toEqual([404, 'CAPTURE_UNKNOWN'])

    // Only the explicit Analyze route was attempted, and nothing reached the provider seam.
    expect(providerCalls).toEqual([])
    expect(browserModelRoutes).toEqual([`/api/project/captures/${captureId}/analyze`])
    expect(foreignRequests).toEqual([])
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
  } finally {
    await instance?.close()
    await rm(config.root, { recursive: true, force: true })
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await repository.remove()
  }
})
