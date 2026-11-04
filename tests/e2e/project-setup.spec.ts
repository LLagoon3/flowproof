import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { admissionProfileOf, readProjectConfigFile, readRuntimeManifest } from '../../packages/flowproof/src/project/profile.js'
import type { ProjectSettings } from '../../packages/flowproof/src/project/profile.js'
import { startProjectStudio } from '../../packages/flowproof/src/studio/launch.js'
import type { StudioInstance } from '../../packages/flowproof/src/studio/launch.js'
import { RUNTIME_LABEL } from '../../packages/flowproof/src/project/runtime.js'
import { changedSnapshotFacets, materializeProjectLiveRepository, snapshotOriginalProject } from '../helpers/projectLiveRepository.js'
import type { MaterializedProjectRepository } from '../helpers/projectLiveRepository.js'
import { containersWithLabel, runtimeManifestPath, sampleConfigFile } from '../support/projectSetup.js'

// T020: real built Studio + pinned offline runtime + interactive built project. No model transport
// or fake target is supplied. The separate stale journey uses a test-owned temporary Git repository
// and restores its intentional edit before proving full repository identity is otherwise unchanged.

async function admittedProject(repository: MaterializedProjectRepository): Promise<AdmittedProject> {
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error(`fixture admission failed: ${admission.reasons.join(',')}`)
  return admission.project
}

async function settingsFromFile(): Promise<{ readonly root: string; readonly settings: ProjectSettings }> {
  const root = await mkdtemp(path.join(tmpdir(), 'flowproof-s2-e2e-config-'))
  const config = await sampleConfigFile()
  const file = path.join(root, 'project.json')
  await writeFile(file, JSON.stringify(config), { mode: 0o600 })
  return { root, settings: await readProjectConfigFile(file) }
}

test('confirms settings, builds offline, and interacts with the actual project target', async () => {
  const repository = await materializeProjectLiveRepository()
  const before = await snapshotOriginalProject(repository.root)
  const config = await settingsFromFile()
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const project = await admittedProject(repository)
  const settings = config.settings
  const containersBefore = await containersWithLabel(RUNTIME_LABEL)
  let instance: StudioInstance | null = null
  const modelCalls: string[] = []

  try {
    instance = await startProjectStudio({
      repoRoot: process.cwd(),
      project,
      profile,
      initialSettings: settings,
      modelConfigured: false,
    })
    instance.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/runs') modelCalls.push(request.url())
    })

    await expect(instance.page.getByRole('heading', { name: 'Review your project' })).toBeVisible()
    await expect(instance.page.getByTestId('project-root')).toHaveText(repository.root)
    await expect(instance.page.getByText('Model configured').locator('..')).toContainText('No')
    await expect(instance.page.getByText('Settings loaded from the supplied configuration file; review before confirming.')).toBeVisible()
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(modelCalls).toEqual([])
    await expect(instance.page.getByTestId('project-target')).toHaveCount(0)

    await instance.page.getByRole('checkbox', { name: /I reviewed the committed project identity/ }).check()
    await instance.page.getByTestId('confirm-project-settings').click()
    await expect(instance.page.getByTestId('project-target')).toBeVisible({ timeout: 240_000 })
    const target = instance.page.frameLocator('[data-testid="project-target"]')
    await expect(target.getByRole('heading', { name: 'Task board' })).toBeVisible()
    await expect(target.getByTestId('task-item')).toHaveCount(5)
    await expect(target.getByTestId('task-summary')).toHaveText('3 open tasks')
    await target.getByTestId('task-list').getByRole('checkbox').first().click()
    await expect(target.getByTestId('task-summary')).toHaveText('4 open tasks')

    const frame = instance.page.frames().find((candidate) => candidate !== instance!.page.mainFrame())
    expect(frame).toBeDefined()
    expect(new URL(frame!.url()).origin).toBe(new URL((await instance.page.getByTestId('project-target').getAttribute('src'))!).origin)
    await expect(instance.page.getByText('sample-unit: passed')).toBeVisible()
    expect(modelCalls).toEqual([])
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
  } finally {
    await instance?.close()
    await rm(config.root, { recursive: true, force: true })
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await repository.remove()
  }
})

test('keeps selection non-executing and marks a changed baseline stale before preparation', async () => {
  const repository = await materializeProjectLiveRepository()
  const before = await snapshotOriginalProject(repository.root)
  const config = await settingsFromFile()
  const profile = await readRuntimeManifest(runtimeManifestPath())
  const project = await admittedProject(repository)
  const sourcePath = path.join(repository.root, 'src/main.jsx')
  const sourceBytes = await readFile(sourcePath)
  const containersBefore = await containersWithLabel(RUNTIME_LABEL)
  let instance: StudioInstance | null = null

  try {
    instance = await startProjectStudio({
      repoRoot: process.cwd(),
      project,
      profile,
      initialSettings: config.settings,
      modelConfigured: false,
    })
    await expect(instance.page.getByTestId('project-root')).toHaveText(repository.root)
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n// intentional stale-test edit\n')]))

    await instance.page.getByRole('checkbox', { name: /I reviewed the committed project identity/ }).check()
    await instance.page.getByTestId('confirm-project-settings').click()
    await expect(instance.page.getByText('The project changed after admission. Start a new session to review its current committed state.')).toBeVisible({ timeout: 30_000 })
    await expect(instance.page.getByTestId('project-target')).toHaveCount(0)
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
  } finally {
    await writeFile(sourcePath, sourceBytes)
    await instance?.close()
    await rm(config.root, { recursive: true, force: true })
    expect(await containersWithLabel(RUNTIME_LABEL)).toEqual(containersBefore)
    expect(changedSnapshotFacets(before, await snapshotOriginalProject(repository.root))).toEqual([])
    await repository.remove()
  }
})
