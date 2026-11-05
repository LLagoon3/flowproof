// T029 A3b: deterministic launcher seams behind `ProjectStudioMode.openDemonstration`.
// Sources come from a real admitted sample repository through a fresh verified admission snapshot;
// the model session uses only the explicit host environment, with an explicitly labelled
// `test_transport` HTTP fake. No browser, container or provider is involved here; the real
// launcher-owned Chromium recorder path is A4 (T026).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RedactedValueRegistry } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import { buildProjectAnalysisPrompt } from '../../packages/flowproof/src/model/projectPrompt.js'
import { admitProject } from '../../packages/flowproof/src/project/admission.js'
import type { AdmittedProject } from '../../packages/flowproof/src/project/admission.js'
import { PROJECT_LIMITS, newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import { admissionProfileOf, readRuntimeManifest } from '../../packages/flowproof/src/project/profile.js'
import type { RuntimeProfile } from '../../packages/flowproof/src/project/profile.js'
import { loadAdmittedProjectSources, projectCaptureBinding, projectDemonstrationModel } from '../../packages/flowproof/src/studio/launch.js'
import { materializeProjectLiveRepository } from '../helpers/projectLiveRepository.js'
import { TestRecorder } from '../support/projectDemonstration.js'
import { runtimeManifestPath } from '../support/projectSetup.js'

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let profile: RuntimeProfile
beforeAll(async () => {
  profile = await readRuntimeManifest(runtimeManifestPath())
})

async function admittedSample(prepare?: (root: string) => Promise<void>): Promise<{ readonly root: string; readonly project: AdmittedProject }> {
  const repository = await materializeProjectLiveRepository()
  cleanups.push(() => repository.remove())
  if (prepare) await prepare(repository.root)
  const admission = await admitProject({ root: repository.root, profile: admissionProfileOf(profile) })
  if (admission.state !== 'ready') throw new Error(`fixture admission failed: ${JSON.stringify(admission)}`)
  return { root: repository.root, project: admission.project }
}

const git = (root: string, ...args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'FlowProof Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'FlowProof Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  })
}

describe('T029 A3b frozen admitted sources', () => {
  it('returns exactly the admitted committed src/ text files, digest-checked against admission and deeply frozen', async () => {
    const { project } = await admittedSample()
    const expected = project.files.filter((file) => file.path.startsWith('src/') && file.text).map((file) => file.path)
    expect(expected.length).toBeGreaterThan(0)
    const loaded = await loadAdmittedProjectSources(project, profile)
    expect(loaded.sources.map((source) => source.path)).toEqual([...expected].sort())
    expect([...loaded.admitted].sort()).toEqual([...expected].sort())
    for (const source of loaded.sources) {
      const admitted = project.files.find((file) => file.path === source.path)!
      expect(sha256(source.content)).toBe(admitted.sha256)
    }
    expect(Object.isFrozen(loaded.sources) && loaded.sources.every((source) => Object.isFrozen(source))).toBe(true)
  })

  it('refuses sources once the original checkout moved from the admitted baseline, and never reads the working tree', async () => {
    const { root, project } = await admittedSample()
    const file = project.files.find((entry) => entry.path.startsWith('src/') && entry.text)!
    const absolute = path.join(root, file.path)
    const original = await readFile(absolute, 'utf8')
    await writeFile(absolute, `${original}\nexport const injected = 'working-tree-only'\n`)
    await expect(loadAdmittedProjectSources(project, profile)).rejects.toMatchObject({ code: 'PROJECT_BASELINE_STALE' })
  })

  it('fails closed instead of truncating when the admitted sources exceed the request bound', async () => {
    const { project } = await admittedSample(async (root) => {
      for (let index = 0; index <= PROJECT_LIMITS.maxRequestSourceFiles; index += 1) {
        await writeFile(path.join(root, 'src', `extra-${index.toString().padStart(2, '0')}.ts`), `export const value${index} = ${index}\n`)
      }
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'add many sources')
    })
    await expect(loadAdmittedProjectSources(project, profile)).rejects.toMatchObject({ code: 'SOURCE_LIMIT_EXCEEDED' })
  })
})

describe('T029 A3b capture binding from host-owned identities', () => {
  const input = (project: AdmittedProject, viewport: { width: number; height: number; devicePixelRatio: number }, targetUrl = 'http://localhost:43150/') => ({
    runId: newProjectUuid(),
    project,
    configuration: { configuration_id: newProjectUuid(), configuration_digest: 'c'.repeat(64), target_origin: 'http://localhost:43150' } as never,
    preparation: { target_url: targetUrl, output_sha256: 'd'.repeat(64), checks: [] },
    viewport,
  })

  it('binds the admitted project, confirmed configuration, ready output digest and the measured frame viewport', async () => {
    const { project } = await admittedSample()
    const values = input(project, { width: 1024, height: 640, devicePixelRatio: 1 })
    expect(projectCaptureBinding(values)).toEqual({
      run_id: values.runId,
      project_id: project.context.project_id,
      baseline_commit: project.context.baseline_commit,
      configuration_id: (values.configuration as { configuration_id: string }).configuration_id,
      configuration_digest: 'c'.repeat(64),
      target_origin: 'http://localhost:43150',
      viewport: { width: 1024, height: 640, device_scale_factor: 1 },
      build_sha256: 'd'.repeat(64),
    })
  })

  it.each([
    ['a scaled device', { width: 1024, height: 640, devicePixelRatio: 2 }, undefined],
    ['a frame below the supported viewport', { width: 200, height: 640, devicePixelRatio: 1 }, undefined],
    ['a fractional frame size', { width: 1024.5, height: 640, devicePixelRatio: 1 }, undefined],
    ['a prepared target on another origin', { width: 1024, height: 640, devicePixelRatio: 1 }, 'http://localhost:43151/'],
  ])('refuses %s', async (_name, viewport, targetUrl) => {
    const { project } = await admittedSample()
    expect(() => projectCaptureBinding(input(project, viewport, targetUrl))).toThrow()
  })
})

describe('T029 A3b host-only model session', () => {
  async function prompt(runId: string) {
    const recorder = new TestRecorder(runId)
    await recorder.finish()
    const { sealed, registry } = await recorder.claim()
    const built = buildProjectAnalysisPrompt({
      run_id: runId,
      invocation_id: newProjectUuid(),
      question_id: newProjectUuid(),
      capture: sealed.capture,
      description: null,
      sources: [{ path: 'src/main.ts', content: 'export {}\n' }],
      admitted_source_paths: new Set(['src/main.ts']),
      images: sealed.artifacts,
      registry: registry ?? new RedactedValueRegistry(),
    })
    if (!built.ok) throw new Error(built.error.code)
    return built.value
  }

  it('reads only the explicit host MODEL_API_KEY and never a process value or another variable', async () => {
    const saved = process.env.MODEL_API_KEY
    process.env.MODEL_API_KEY = 'process-key-must-not-be-used'
    try {
      const headers: string[] = []
      const fake = {
        label: 'test_transport' as const,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          headers.push(`${String(input)} ${JSON.stringify(init?.headers)}`)
          return new Response('{}', { status: 500 })
        },
      }
      const missingRun = newProjectUuid()
      const missing = projectDemonstrationModel(missingRun, { modelEnv: {}, modelFake: fake })
      expect(missing.transport).toBe('test_transport')
      const refused = await missing.analyze(await prompt(missingRun))
      expect(refused.ok ? 'OK' : refused.error.code).toBe('PROVIDER_CREDENTIAL_MISSING')
      expect(headers).toHaveLength(0)
      const hostRun = newProjectUuid()
      const host = projectDemonstrationModel(hostRun, { modelEnv: { MODEL_API_KEY: 'host-key', OPENAI_BASE_URL: 'https://attacker.invalid/v1' } as never, modelFake: fake })
      await host.analyze(await prompt(hostRun))
      expect(headers).toHaveLength(1)
      expect(headers[0]).toContain('https://api.meta.ai/v1/responses')
      expect(headers[0]).toContain('Bearer host-key')
      expect(headers[0]).not.toContain('process-key')
      expect(projectDemonstrationModel(newProjectUuid(), { modelEnv: {} }).transport).toBe('meta')
    } finally {
      if (saved === undefined) delete process.env.MODEL_API_KEY
      else process.env.MODEL_API_KEY = saved
    }
  })

  it('wires the CLI to pass only the host MODEL_API_KEY and never a fake or transport override', async () => {
    const cli = await readFile(new URL('../../packages/flowproof/src/cli.ts', import.meta.url), 'utf8')
    expect(cli).toMatch(/modelEnv: \{ MODEL_API_KEY: process\.env\.MODEL_API_KEY \}/)
    expect(cli).not.toMatch(/modelFake|test_transport/)
  })
})
