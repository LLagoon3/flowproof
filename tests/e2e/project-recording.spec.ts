import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import type { Frame, Locator, Page } from '@playwright/test'

import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { admissionProfileOf, readProjectConfigFile, readRuntimeManifest } from '../../packages/flowproof/src/project/profile.js'
import type { ProjectSettings } from '../../packages/flowproof/src/project/profile.js'
import { PROJECT_META_ENDPOINT } from '../../packages/flowproof/src/model/projectClient.js'
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
      if (url.protocol.startsWith('http') && url.origin !== studioOrigin) foreignRequests.push(url.origin)
    })

    await page.getByRole('checkbox', { name: /I reviewed the committed project identity/ }).check()
    await page.getByTestId('confirm-project-settings').click()
    await expect(page.getByTestId('project-target')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByText('sample-unit: passed')).toBeVisible()
    const target = page.frameLocator('[data-testid="project-target"]')
    await expect(target.getByTestId('task-summary')).toHaveText('3 open tasks')

    const targetOrigin = new URL((await page.getByTestId('project-target').getAttribute('src'))!).origin
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
    expect(recording.body).toMatchObject({ run_id: runId, state: 'recording', capture_id: captureId, report: 'recording', report_sha256: null, interpretation: null })

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
    expect(afterDiscard.body).toMatchObject({ run_id: runId, state: 'demonstration-ready', capture_id: null, report: 'none', report_sha256: null, interpretation: null })

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
    expect(foreignRequests.filter((origin) => origin !== targetOrigin)).toEqual([])
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
  } finally {
    await instance?.close()
    await rm(config.root, { recursive: true, force: true })
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await repository.remove()
  }
})

// T026 (S6 unit A4b1): the serialized report itself. A test-owned synthetic extension is committed
// only into the temporary permitted repository (never the shared fixture, lock or profile) before
// admission, adding a safe text field, a scroll container, an in-document pushState control and a
// same-origin link; the sample's original defect and dependencies are untouched. The report is
// observed only after an explicit Analyze, as the bounded request reaching the labelled
// `test_transport` seam with a fixed synthetic key (never a real credential); the seam then fails.

const execFileAsync = promisify(execFile)
const SYNTHETIC_KEY = 'flowproof-synthetic-test-key-a4b1'

async function commitRecordingSurfaces(root: string): Promise<void> {
  const file = path.join(root, 'src/App.jsx')
  const original = await readFile(file, 'utf8')
  const anchorState = "  const [filter, setFilter] = useState('all')\n"
  const anchorSummary = '      <p data-testid="task-summary">'
  if (!original.includes(anchorState) || !original.includes(anchorSummary)) throw new Error('synthetic extension anchors are missing')
  const surfaces = [
    '      <label>',
    "        Search tasks{' '}",
    '        <input data-testid="task-search" type="text" value={query} onChange={(event) => setQuery(event.target.value)} />',
    '      </label>',
    "      <button type=\"button\" data-testid=\"show-archive\" onClick={() => window.history.pushState(null, '', '/archive')}>",
    '        Archive view',
    '      </button>',
    "      <div data-testid=\"task-scroll\" style={{ height: '60px', overflowY: 'auto' }}>",
    "        <div style={{ height: '900px' }}>Task notes</div>",
    '      </div>',
    '      <a data-testid="details-link" href="/index.html">',
    '        Details',
    '      </a>',
    '',
  ].join('\n')
  await writeFile(file, original.replace(anchorState, `${anchorState}  const [query, setQuery] = useState('')\n`).replace(anchorSummary, `${surfaces}${anchorSummary}`))
  await execFileAsync('git', ['-C', root, 'add', 'src/App.jsx'])
  await execFileAsync('git', ['-C', root, '-c', 'user.name=FlowProof Test', '-c', 'user.email=test@flowproof.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'test: add synthetic recording surfaces'])
}

/** Waits until a user scroll has fully settled, then returns the container's final offset. */
async function settledScrollTop(locator: Locator): Promise<number> {
  let previous = -1
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const now = await locator.evaluate((node) => (node as HTMLElement).scrollTop)
    if (now === previous && now > 0) return now
    previous = now
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('the scroll container did not settle')
}

function reportActions(body: string): Record<string, unknown>[] {
  const request = JSON.parse(body) as { input?: { content?: { type?: string; text?: string }[] }[] }
  for (const block of request.input?.[0]?.content ?? []) {
    if (block.type !== 'input_text' || typeof block.text !== 'string' || !block.text.includes('"actions"')) continue
    const context = JSON.parse(block.text.slice(block.text.indexOf('{'))) as { actions?: unknown }
    if (Array.isArray(context.actions)) return context.actions as Record<string, unknown>[]
  }
  throw new Error('the analysis request carried no action context')
}

const testIds = (value: unknown): string[] => [...JSON.stringify(value ?? null).matchAll(/"kind":"test-id","value":"([A-Za-z0-9_.:-]+)"/g)].map((match) => match[1]!)

test('serializes real fill, select, coalesced scroll and same-origin navigation in order and epoch, flushing at navigation and Finish', async () => {
  const repository = await materializeProjectLiveRepository()
  await commitRecordingSurfaces(repository.root)
  const before = await snapshotOriginalProject(repository.root)
  const config = await settingsFromFile()
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const project = await admittedProject(repository)
  const containersBefore = await containersWithLabel(RUNTIME_LABEL)
  const exchanges: { readonly url: string; readonly body: string }[] = []
  const modelFake: ProjectModelFake = Object.freeze({
    label: 'test_transport' as const,
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      exchanges.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === 'string' ? init.body : '' })
      throw new Error('test_transport: deliberate failure after observing the bounded request')
    },
  })
  let instance: StudioInstance | null = null

  try {
    instance = await startProjectStudio({
      repoRoot: process.cwd(),
      project,
      profile,
      initialSettings: config.settings,
      modelConfigured: true,
      modelEnv: Object.freeze({ MODEL_API_KEY: SYNTHETIC_KEY }),
      modelFake,
    })
    const page = instance.page
    await page.getByRole('checkbox', { name: /I reviewed the committed project identity/ }).check()
    await page.getByTestId('confirm-project-settings').click()
    await expect(page.getByTestId('project-target')).toBeVisible({ timeout: 240_000 })
    await expect(page.getByText('sample-unit: passed')).toBeVisible()
    const target = page.frameLocator('[data-testid="project-target"]')
    await expect(target.getByTestId('task-search')).toBeVisible()
    const targetFrame = (): Frame => {
      const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())
      if (frame === undefined) throw new Error('target frame missing')
      return frame
    }
    const pathOf = (): string => new URL(targetFrame().url()).pathname

    const context = await api(page, 'GET', '/api/project/context')
    const configurationId = (context.body.configuration as Record<string, unknown>).configuration_id as string
    const outputSha = (context.body.preparation as Record<string, unknown>).output_sha256 as string
    const started = await api(page, 'POST', '/api/project/captures', { configuration_id: configurationId, output_sha256: outputSha })
    expect(started.status).toBe(200)
    const runId = started.body.run_id as string
    const captureId = started.body.capture_id as string
    await expect(target.getByTestId('task-search')).toBeVisible()
    expect(pathOf()).toBe('/')

    // Epoch of the entry document.
    const search = target.getByTestId('task-search')
    const scroller = target.getByTestId('task-scroll')
    const filter = target.getByTestId('task-filter')
    await search.fill('milk')
    await scroller.hover()
    for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, 120)
    const firstScroll = await settledScrollTop(scroller)
    const option = await filter.locator('option').nth(1).evaluate((node) => ({ value: (node as HTMLOptionElement).value, label: (node.textContent ?? '').trim() }))
    await filter.selectOption(option.value)
    await page.mouse.click(4, 4) // Studio document, outside the admitted frame.
    await target.getByTestId('show-archive').click()
    await expect.poll(pathOf).toBe('/archive')
    await scroller.hover()
    for (let step = 0; step < 2; step += 1) await page.mouse.wheel(0, 120)
    const secondScroll = await settledScrollTop(scroller)
    expect(secondScroll).toBeGreaterThan(firstScroll)
    await targetFrame().evaluate(() => window.history.back()) // history traversal with a scroll still pending
    await expect.poll(pathOf).toBe('/')
    await target.getByTestId('details-link').click()
    await expect.poll(pathOf).toBe('/index.html')

    // A new document: the next epoch, then pending input drained only by Finish.
    await expect(target.getByTestId('task-search')).toBeVisible()
    await target.getByTestId('task-search').fill('eggs')
    await target.getByTestId('task-scroll').hover()
    await page.mouse.wheel(0, 120)
    const lastScroll = await settledScrollTop(target.getByTestId('task-scroll'))

    const finished = await api(page, 'POST', `/api/project/captures/${captureId}/finish`, {})
    expect(finished.status).toBe(200)
    expect(finished.body).toMatchObject({ run_id: runId, capture_id: captureId, state: 'ready' })
    expect(exchanges).toEqual([])

    const analyzed = await api(page, 'POST', `/api/project/captures/${captureId}/analyze`, { submit: true })
    expect(analyzed.status).toBe(502)
    expect(String(codeOf(analyzed))).toMatch(/^PROVIDER_/)
    expect(exchanges.map((exchange) => exchange.url)).toEqual([PROJECT_META_ENDPOINT])
    const body = exchanges[0]!.body
    expect(body.includes(SYNTHETIC_KEY)).toBe(false)
    const actions = reportActions(body)
    const epoch0 = actions[0]!.document_epoch as number
    const shape = actions.map((entry) => {
      const action = entry.action as Record<string, unknown>
      return [(entry.document_epoch as number) - epoch0, action.type, action.type === 'navigate' ? action.path : testIds(action)[0] ?? null]
    })
    expect(shape).toEqual([
      [0, 'fill', 'task-search'],
      [0, 'scroll', 'task-scroll'],
      [0, 'select', 'task-filter'],
      [0, 'click', 'show-archive'],
      [0, 'navigate', '/archive'],
      [0, 'scroll', 'task-scroll'],
      [0, 'navigate', '/'],
      [0, 'click', 'details-link'],
      [1, 'navigate', '/index.html'],
      [1, 'fill', 'task-search'],
      [1, 'scroll', 'task-scroll'],
    ])
    expect(actions.map((entry) => entry.sequence)).toEqual(actions.map((_, index) => index + 1))
    const action = (index: number): Record<string, unknown> => actions[index]!.action as Record<string, unknown>
    expect(action(0).value).toEqual({ kind: 'safe', text: 'milk' })
    expect(action(9).value).toEqual({ kind: 'safe', text: 'eggs' })
    expect([action(1).y, action(5).y, action(10).y]).toEqual([firstScroll, secondScroll, lastScroll])
    expect([option.value, option.label]).toContain((action(2).value as Record<string, unknown>).option)
  } finally {
    await instance?.close()
    await rm(config.root, { recursive: true, force: true })
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await repository.remove()
  }
})
