import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { EvidenceItem } from '../../packages/flowproof/src/contracts/index.js'
import { parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import {
  ARTIFACT_ROOT,
  ArtifactStoreError,
  assertArtifactRootSafe,
  buildEvidenceBundle,
  canonicalJson,
  createOsTempOutput,
  createRunArtifactStore,
} from '../../packages/flowproof/src/evidence/store.js'

const RUN = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const OTHER_RUN = '11111111-2222-4333-8444-555555555555'
const SEEDED = 'sk-flowproofseededstore000001'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

const temporaryRoots: string[] = []

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function scratch(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  temporaryRoots.push(root)
  return root
}

// A committed repository that ignores the run-artifact root, mirroring the real checkout.
async function makeRepo(gitignore = '.flowproof/\n'): Promise<string> {
  const root = await scratch('flowproof-store-')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'flowproof@example.invalid')
  git(root, 'config', 'user.name', 'FlowProof Test')
  await writeFile(path.join(root, '.gitignore'), gitignore)
  await writeFile(path.join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (child === '.git') continue
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)))
    else files.push(child)
  }
  return files.sort()
}

async function expectStoreError(action: () => Promise<unknown> | unknown, code: string): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(ArtifactStoreError)
  expect((caught as ArtifactStoreError).code).toBe(code)
}

function evidenceItem(type: EvidenceItem['type'], artifactPath: string, digest: string): EvidenceItem {
  return {
    evidence_id: `ev_failure_${type}_001`,
    run_id: RUN,
    phase: 'failure',
    type,
    captured_at: '2026-10-27T10:00:00.000Z',
    artifact_path: artifactPath,
    sha256: digest,
    summary: `Sanitized ${type} evidence captured during failure.`,
    provenance:
      type === 'source'
        ? { mechanism: 'repository-read', origin: 'repository', trusted: true, source_path: 'apps/demo-chart/src/filterData.ts' }
        : { mechanism: 'playwright', origin: 'browser', trusted: false, source_path: null },
    redactions: [],
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('artifact root validation', () => {
  it('accepts a Git-ignored, non-symlinked artifact root', async () => {
    const repo = await makeRepo()

    await expect(assertArtifactRootSafe(repo)).resolves.toBeUndefined()
    expect(ARTIFACT_ROOT).toBe('.flowproof/runs')
  })

  it('rejects an artifact root that Git does not ignore', async () => {
    const repo = await makeRepo('node_modules/\n')

    await expectStoreError(() => assertArtifactRootSafe(repo), 'ARTIFACT_ROOT_NOT_IGNORED')
    await expectStoreError(() => createRunArtifactStore({ repoRoot: repo, runId: RUN }), 'ARTIFACT_ROOT_NOT_IGNORED')
    await expect(lstat(path.join(repo, '.flowproof'))).rejects.toThrow()
  })

  it('rejects a symlinked artifact root even when the target is inside the repository', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, '.flowproof'))
    await mkdir(path.join(repo, 'elsewhere'))
    await symlink(path.join(repo, 'elsewhere'), path.join(repo, '.flowproof', 'runs'))

    await expectStoreError(() => assertArtifactRootSafe(repo), 'ARTIFACT_ROOT_SYMLINK')
  })

  it('rejects a symlinked .flowproof directory that escapes the repository', async () => {
    const repo = await makeRepo()
    const outside = await scratch('flowproof-outside-')
    await symlink(outside, path.join(repo, '.flowproof'))

    await expectStoreError(() => createRunArtifactStore({ repoRoot: repo, runId: RUN }), 'ARTIFACT_ROOT_SYMLINK')
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects tracked content beneath the artifact root', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, '.flowproof', 'runs'), { recursive: true })
    await writeFile(path.join(repo, '.flowproof', 'runs', 'tracked.txt'), 'tracked\n')
    git(repo, 'add', '-f', '.flowproof/runs/tracked.txt')
    git(repo, 'commit', '-q', '-m', 'track artifact')

    await expectStoreError(() => assertArtifactRootSafe(repo), 'ARTIFACT_ROOT_TRACKED')
  })
})

describe('run artifact store', () => {
  it('creates only .flowproof/runs/<run-id>/ beneath the working tree', async () => {
    const repo = await makeRepo()
    const before = await listFiles(repo)
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })

    await store.writeJson('evidence/failure/dataset.json', { rows: [{ region: 'North', revenue: 120 }] })
    await store.writeText('candidate/diff.patch', 'diff --git a/x b/x\n')
    await store.writePng('evidence/failure/screenshot.png', PNG)

    expect(store.relativeRoot).toBe(`.flowproof/runs/${RUN}/`)
    const added = (await listFiles(repo)).filter((file) => !before.includes(file))
    expect(added.length).toBe(3)
    for (const file of added) expect(file.startsWith(`.flowproof/runs/${RUN}/`)).toBe(true)
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(repo, 'status', '--porcelain', '--ignored', '--untracked-files=all').trim().split('\n')).toEqual(
      added.map((file) => `!! ${file}`),
    )
  })

  it('refuses a malformed run identifier and an existing run directory', async () => {
    const repo = await makeRepo()

    await expectStoreError(() => createRunArtifactStore({ repoRoot: repo, runId: '../escape' }), 'ARTIFACT_RUN_ID_INVALID')
    await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    await expectStoreError(() => createRunArtifactStore({ repoRoot: repo, runId: RUN }), 'ARTIFACT_RUN_EXISTS')
  })

  it('sanitizes before hashing and persisting', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })

    const written = await store.writeJson('evidence/failure/console.json', {
      entries: [{ level: 'error', text: `fetch rejected with token ${SEEDED}` }],
      headers: { authorization: `Bearer ${SEEDED}` },
    })

    const bytes = await readFile(path.join(repo, store.relativeRoot, 'evidence/failure/console.json'))
    expect(bytes.toString('utf8')).not.toContain(SEEDED)
    expect(written.sha256).toBe(sha256(bytes))
    expect(written.bytes).toBe(bytes.length)
    expect(written.artifact_path).toBe('evidence/failure/console.json')
    expect(written.redactions.map((redaction) => redaction.category)).toContain('credential')
  })

  it('sanitizes text artifacts such as candidate diffs', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })

    const written = await store.writeText('candidate/diff.patch', `+const key = '${SEEDED}'\n`)
    const bytes = await readFile(path.join(repo, store.relativeRoot, 'candidate/diff.patch'))

    expect(bytes.toString('utf8')).not.toContain(SEEDED)
    expect(written.sha256).toBe(sha256(bytes))
  })

  it('accepts only PNG bytes for binary screenshots', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })

    await expectStoreError(
      () => store.writePng('evidence/failure/screenshot.png', new TextEncoder().encode(`not a png ${SEEDED}`)),
      'ARTIFACT_CONTENT_INVALID',
    )
    const written = await store.writePng('evidence/failure/screenshot.png', PNG)
    expect(written.sha256).toBe(sha256(PNG))
  })

  it('writes atomically, never overwrites, and leaves no temporary files', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const cyclic: Record<string, unknown> = { name: 'cycle' }
    cyclic['self'] = cyclic

    await expect(store.writeJson('evidence/failure/chart.json', cyclic)).rejects.toThrow()
    await store.writeJson('evidence/failure/chart.json', { labels: ['Q1'], values: [120] })
    await expectStoreError(
      () => store.writeJson('evidence/failure/chart.json', { labels: ['Q2'], values: [1] }),
      'ARTIFACT_ALREADY_EXISTS',
    )

    const files = await listFiles(path.join(repo, store.relativeRoot))
    expect(files).toEqual(['evidence/failure/chart.json'])
    const persisted = JSON.parse(await readFile(path.join(repo, store.relativeRoot, files[0] ?? ''), 'utf8'))
    expect(persisted).toEqual({ labels: ['Q1'], values: [120] })
  })

  it.each(['/etc/passwd', '../escape.json', 'evidence/../../escape.json', 'evidence\\x.json', 'evidence//x.json', '', 'evidence/.hidden/x.json'])(
    'rejects the unsafe artifact path %j',
    async (unsafe) => {
      const repo = await makeRepo()
      const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })

      await expectStoreError(() => store.writeJson(unsafe, {}), 'ARTIFACT_PATH_INVALID')
    },
  )

  it('rejects writing through a symlink planted inside the run directory', async () => {
    const repo = await makeRepo()
    const outside = await scratch('flowproof-outside-')
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    await symlink(outside, path.join(repo, store.relativeRoot, 'evidence'))

    await expectStoreError(() => store.writeJson('evidence/failure/dataset.json', {}), 'ARTIFACT_PATH_SYMLINK')
    expect(await readdir(outside)).toEqual([])
  })
})

describe('closed artifact reads', () => {
  it('reads only identifiers registered for this run', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const written = await store.writeJson('evidence/failure/dataset.json', { rows: [] })

    store.register('ev_failure_dataset_001', written)

    expect(store.hasEvidence('ev_failure_dataset_001')).toBe(true)
    expect(store.hasArtifact('evidence/failure/dataset.json')).toBe(true)
    expect(JSON.parse((await store.read('ev_failure_dataset_001')).toString('utf8'))).toEqual({ rows: [] })
    await expectStoreError(() => store.read('ev_failure_chart_001'), 'ARTIFACT_UNKNOWN_ID')
    await expectStoreError(() => store.read('evidence/failure/dataset.json'), 'ARTIFACT_UNKNOWN_ID')
    await expectStoreError(() => store.read('../../etc/passwd'), 'ARTIFACT_UNKNOWN_ID')
    expect(store.hasEvidence('ev_failure_chart_001')).toBe(false)
  })

  it('registers each identifier once and only for artifacts it persisted', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const written = await store.writeJson('evidence/failure/dataset.json', { rows: [] })

    store.register('ev_failure_dataset_001', written)
    await expectStoreError(() => store.register('ev_failure_dataset_001', written), 'ARTIFACT_ID_DUPLICATE')
    await expectStoreError(
      () => store.register('ev_failure_chart_001', { ...written, artifact_path: 'evidence/failure/chart.json' }),
      'ARTIFACT_NOT_PERSISTED',
    )
    await expectStoreError(() => store.register('not-an-identifier', written), 'ARTIFACT_ID_INVALID')
  })

  it('supports the fixed named artifacts used by the Proof Trail', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const diff = await store.writeText('candidate/diff.patch', 'diff --git a/x b/x\n')

    store.register('candidate-diff', diff)

    expect((await store.read('candidate-diff')).toString('utf8')).toBe('diff --git a/x b/x\n')
  })

  it('detects tampering after persistence', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const written = await store.writeJson('evidence/failure/dataset.json', { rows: [] })
    store.register('ev_failure_dataset_001', written)

    await writeFile(path.join(repo, store.relativeRoot, 'evidence/failure/dataset.json'), '{"rows":[1]}')

    await expectStoreError(() => store.read('ev_failure_dataset_001'), 'ARTIFACT_INTEGRITY_MISMATCH')
  })

  it('refuses to follow a symlink swapped in after persistence', async () => {
    const repo = await makeRepo()
    const outside = await scratch('flowproof-outside-')
    await writeFile(path.join(outside, 'secret.json'), '{"rows":[]}')
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const written = await store.writeJson('evidence/failure/dataset.json', { rows: [] })
    store.register('ev_failure_dataset_001', written)
    const target = path.join(repo, store.relativeRoot, 'evidence/failure/dataset.json')

    await rm(target)
    await symlink(path.join(outside, 'secret.json'), target)

    await expectStoreError(() => store.read('ev_failure_dataset_001'), 'ARTIFACT_PATH_SYMLINK')
  })
})

describe('canonical manifests', () => {
  it('serializes with sorted keys and no insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: true, e: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"e":null,"f":true}]},"b":1}',
    )
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('builds a contract-valid bundle whose digest covers canonical item metadata', () => {
    const types = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'] as const
    const items = types.map((type) => evidenceItem(type, `evidence/failure/${type}.json`, sha256(type)))

    const bundle = buildEvidenceBundle({ runId: RUN, scenarioId: 'canvas-filter-hero', phase: 'failure', items })

    expect(parseEvidenceBundle(bundle).ok).toBe(true)
    expect(bundle.manifest_sha256).toBe(sha256(canonicalJson(items)))
    const reordered = buildEvidenceBundle({
      runId: RUN,
      scenarioId: 'canvas-filter-hero',
      phase: 'failure',
      items: items.map((item) => Object.fromEntries(Object.entries(item).reverse()) as EvidenceItem),
    })
    expect(reordered.manifest_sha256).toBe(bundle.manifest_sha256)
  })

  it('rejects a bundle that would violate the Evidence Bundle contract', () => {
    const items = (['actions', 'dataset', 'chart', 'screenshot', 'console', 'network'] as const).map((type) =>
      evidenceItem(type, `evidence/failure/${type}.json`, sha256(type)),
    )

    expect(() => buildEvidenceBundle({ runId: RUN, scenarioId: 'canvas-filter-hero', phase: 'failure', items })).toThrow(
      /ARTIFACT_BUNDLE_INVALID/,
    )
    expect(() =>
      buildEvidenceBundle({ runId: OTHER_RUN, scenarioId: 'canvas-filter-hero', phase: 'failure', items }),
    ).toThrow(/ARTIFACT_BUNDLE_INVALID/)
  })

  it('persists a bundle manifest whose bytes hash to its recorded digest', async () => {
    const repo = await makeRepo()
    const store = await createRunArtifactStore({ repoRoot: repo, runId: RUN })
    const types = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source'] as const
    const items = types.map((type) => evidenceItem(type, `evidence/failure/${type}.json`, sha256(type)))
    const bundle = buildEvidenceBundle({ runId: RUN, scenarioId: 'canvas-filter-hero', phase: 'failure', items })

    const written = await store.writeJson('evidence/failure/manifest.json', bundle)
    const persisted = await readFile(path.join(repo, store.relativeRoot, 'evidence/failure/manifest.json'))

    expect(JSON.parse(persisted.toString('utf8'))).toEqual(bundle)
    expect(written.sha256).toBe(sha256(persisted))
  })
})

describe('operating-system temporary output', () => {
  it('allocates build and worktree output outside the repository', async () => {
    const repo = await makeRepo()
    const before = await listFiles(repo)

    for (const purpose of ['studio-build', 'preview-build', 'worktree'] as const) {
      const output = await createOsTempOutput({ purpose, repoRoot: repo })
      expect(output.path.startsWith(`${await realpath(tmpdir())}${path.sep}`)).toBe(true)
      expect(output.path.startsWith(repo)).toBe(false)
      expect(path.basename(output.path).startsWith(`flowproof-${purpose}-`)).toBe(true)
      await writeFile(path.join(output.path, 'index.html'), '<!doctype html>')
      await output.remove()
      await expect(lstat(output.path)).rejects.toThrow()
    }
    expect(await listFiles(repo)).toEqual(before)
  })

  it('refuses a temporary root inside the repository', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, 'tmp'))

    await expectStoreError(
      () => createOsTempOutput({ purpose: 'worktree', repoRoot: repo, tmpRoot: path.join(repo, 'tmp') }),
      'ARTIFACT_TEMP_INSIDE_REPOSITORY',
    )
  })
})
