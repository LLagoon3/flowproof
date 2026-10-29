import { execFile } from 'node:child_process'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { AgentRuntimeProfile } from '../../packages/flowproof/src/editing/contracts.js'
import type { DockerAdapter } from '../../packages/flowproof/src/editing/dockerCli.js'
import { REPO_ROOT, createTempDirectory, git, listTree, processesMentioning } from './repoFixture.js'
import type { TempDirectory } from './repoFixture.js'

// Docker and repository helpers for the editing-runtime suites. The deterministic fixture image
// is built locally from committed files and resolved to its immutable local image ID before a
// profile is registered; no test ever passes a mutable tag to a session.

export { listTree, processesMentioning }

const run = promisify(execFile)

export const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/editing-agent')
export const FIXTURE_PROJECT_DIR = path.join(FIXTURE_DIR, 'project')
export const FIXTURE_IMAGE_TAG = 'flowproof-editing-agent:test'
export const FIXTURE_PROFILE_ID = 'fixture-editing-agent'
export const FIXTURE_ARGV = ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'] as const
export const FIXTURE_COMMAND = 'node scripts/check.mjs'
/** The label every editing-session container carries, with the session ID as its value. */
export const SESSION_LABEL = 'dev.flowproof.editing-session'
/** Generous per-test timeout for Docker-backed cases. */
export const DOCKER_TEST_TIMEOUT = 150_000

async function docker(args: readonly string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

let fixtureImage: Promise<string> | null = null

/** Builds the fixture image once per test process and returns its immutable `sha256:` image ID. */
export function buildFixtureImage(): Promise<string> {
  fixtureImage ??= (async () => {
    await docker(['build', '--quiet', '--file', path.join(FIXTURE_DIR, 'Dockerfile'), '--tag', FIXTURE_IMAGE_TAG, FIXTURE_DIR], 300_000)
    const id = (await docker(['image', 'inspect', '--format', '{{.Id}}', FIXTURE_IMAGE_TAG])).trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('The fixture image ID is not immutable.')
    return id
  })()
  return fixtureImage
}

/** The registered deterministic fixture profile for an immutable image reference. */
export function fixtureProfile(imageReference: string, overrides: Partial<AgentRuntimeProfile> = {}): AgentRuntimeProfile {
  return {
    id: FIXTURE_PROFILE_ID,
    imageReference,
    argv: [...FIXTURE_ARGV],
    environment: { FLOWPROOF_FIXTURE: '1' },
    workingDirectory: '/workspace',
    ...overrides,
  }
}

export interface SyntheticRepository extends TempDirectory {
  /** The committed baseline the fixture agent expects. */
  readonly head: string
}

/** A fresh Git repository holding the synthetic project, committed once. */
export async function createSyntheticRepository(): Promise<SyntheticRepository> {
  const parent = await createTempDirectory('flowproof-editing-repo-')
  const root = path.join(parent.path, 'repo')
  await cp(FIXTURE_PROJECT_DIR, root, { recursive: true })
  git(root, 'init', '--quiet', '--initial-branch=main')
  git(root, 'config', 'user.email', 'flowproof@example.invalid')
  git(root, 'config', 'user.name', 'FlowProof Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '--message', 'Synthetic editing fixture')
  return { path: root, head: git(root, 'rev-parse', 'HEAD').trim(), remove: parent.remove }
}

/** A private temporary root for session state, so residue checks see only this test's output. */
export function createPrivateTmpRoot(): Promise<TempDirectory> {
  return createTempDirectory('flowproof-editing-tmp-')
}

/** Full IDs of every container, in any state, labeled for one editing session. */
export async function sessionContainers(sessionId: string): Promise<string[]> {
  const out = await docker(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=${SESSION_LABEL}=${sessionId}`])
  return out.split('\n').filter(Boolean)
}

/** Full IDs of every editing-session container on the daemon. */
export async function allEditingContainers(): Promise<string[]> {
  const out = await docker(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=${SESSION_LABEL}`])
  return out.split('\n').filter(Boolean)
}

/** True while a container with this exact full ID exists in any state. */
export async function containerExists(id: string): Promise<boolean> {
  const out = await docker(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `id=${id}`])
  return out.split('\n').includes(id)
}

/** Waits until the session's container is running; resolves with its full ID. */
export async function waitForRunningContainer(sessionId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = await docker([
      'container',
      'ls',
      '--no-trunc',
      '--quiet',
      '--filter',
      `label=${SESSION_LABEL}=${sessionId}`,
      '--filter',
      'status=running',
    ])
    const id = out.split('\n').find(Boolean)
    if (id !== undefined) return id
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The session container never reached the running state.')
}

/** The complete `docker inspect` document of one container. */
export async function inspectContainer(id: string): Promise<Record<string, unknown>> {
  const [document] = JSON.parse(await docker(['container', 'inspect', id])) as Record<string, unknown>[]
  if (document === undefined) throw new Error('The container has no inspect document.')
  return document
}

export interface ResidueReport {
  readonly containers: readonly string[]
  readonly tmpEntries: readonly string[]
  readonly processes: readonly number[]
}

/**
 * Everything one session could leave behind: its labeled containers, any entry under its private
 * temporary root, and host processes whose command line names the session, its container, or the
 * fixture's descendant marker.
 */
export async function sessionResidue(input: {
  readonly sessionId: string
  readonly tmpRoot: string
  readonly needles?: readonly string[]
}): Promise<ResidueReport> {
  const processes = new Set<number>()
  for (const needle of [input.sessionId, ...(input.needles ?? [])]) {
    for (const pid of await processesMentioning(needle)) processes.add(pid)
  }
  return {
    containers: await sessionContainers(input.sessionId),
    tmpEntries: await listTree(input.tmpRoot),
    processes: [...processes].sort((left, right) => left - right),
  }
}

export const NO_RESIDUE: ResidueReport = { containers: [], tmpEntries: [], processes: [] }

export interface RecordingDocker extends DockerAdapter {
  /** Full IDs of every container this adapter created, in creation order. */
  readonly created: readonly string[]
  /** The complete `docker inspect` document of each created container, captured before start. */
  readonly inspected: ReadonlyMap<string, Record<string, unknown>>
}

/** Wraps a real Docker adapter, recording created container IDs and their inspect documents. */
export function recordingDocker(inner: DockerAdapter): RecordingDocker {
  const created: string[] = []
  const inspected = new Map<string, Record<string, unknown>>()
  return {
    ...inner,
    created,
    inspected,
    async create(spec) {
      const id = await inner.create(spec)
      created.push(id)
      inspected.set(id, await inspectContainer(id))
      return id
    },
  }
}
