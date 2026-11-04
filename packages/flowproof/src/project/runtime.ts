import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { sanitizeText } from '../evidence/sanitize.js'
import { createProjectTempDirectory } from '../evidence/projectStore.js'
import { ExecutionConfigurationSchema, newProjectUuid, projectDigest } from './contracts.js'
import type { ExecutionConfiguration } from './contracts.js'
import { PROFILE_DEPENDENCY_ROOT, PROFILE_NODE_PATH, dockerCliEnvironment } from './profile.js'
import type { RuntimeProfile } from './profile.js'
import type { ProjectSnapshot } from './snapshot.js'

// The offline project runtime (Spec 006 T017). Every build or project check runs in a new
// container created from the profile's immutable image ID with `--pull=never`, `--network=none`,
// a read-only root filesystem, all capabilities dropped, no-new-privileges, one CPU, 1 GiB memory
// without swap, 256 PIDs, a private tmpfs HOME, an explicit environment, and the host user (never
// root). Its only mounts are the owned snapshot workspace (read-only) and, for a build, a separate
// owned writable output directory at the confirmed output path; a check sees the accepted output
// read-only. No original checkout, Git metadata, host HOME, credential, Docker socket or original
// `node_modules` is ever mounted, and the prepared dependency set is reached only through the
// image's read-only toolchain. The confirmed argv runs directly: there is no shell or entrypoint.
//
// Ordering: the snapshot inputs are verified before the producer starts; on exit, timeout or
// cancellation the container is stopped (5-second grace) and joined, then removed and confirmed
// gone; the inputs are verified again; only then is the output copied through no-follow reads into
// a new immutable serving directory, bounded in files and bytes and refused on any link or special
// entry. Diagnostics are bounded and sanitized and are never logged by this module.

export const RUNTIME_LABEL = 'dev.flowproof.project-runtime'

export const RUNTIME_FAILURES = [
  'RUNTIME_INPUT_INVALID',
  'RUNTIME_INPUT_CHANGED',
  'RUNTIME_BUILD_FAILED',
  'RUNTIME_CHECK_FAILED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_CANCELLED',
  'RUNTIME_OOM',
  'RUNTIME_OUTPUT_MISSING',
  'RUNTIME_OUTPUT_UNSAFE',
  'RUNTIME_OUTPUT_TOO_LARGE',
  'RUNTIME_DOCKER_FAILED',
  'RUNTIME_CLEANUP_FAILED',
] as const
export type RuntimeFailure = (typeof RUNTIME_FAILURES)[number]

export interface RuntimeDiagnostics {
  /** Total bytes the producer wrote to stdout and stderr. */
  readonly bytes: number
  readonly truncated: boolean
  /** The first bounded, sanitized bytes; never logged by the runtime. */
  readonly text: string
}

export type PhaseOutcome =
  | { readonly status: 'passed'; readonly exitCode: 0; readonly diagnostics: RuntimeDiagnostics }
  | { readonly status: 'failed'; readonly reason: RuntimeFailure; readonly exitCode: number | null; readonly diagnostics: RuntimeDiagnostics }

export interface OutputFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

/** Accepted build output in its own immutable owned directory. */
export interface ImmutableOutput {
  readonly root: string
  readonly files: readonly OutputFile[]
  /** Digest over every output path, size and content digest. */
  readonly sha256: string
  remove(): Promise<void>
}

export type BuildResult = PhaseOutcome & { readonly output: ImmutableOutput | null }

export interface PhaseOptions {
  readonly snapshot: ProjectSnapshot
  readonly configuration: ExecutionConfiguration
  readonly signal?: AbortSignal
  /** At most the configuration's phase limit (120 seconds). */
  readonly timeoutMs?: number
}

export interface ProjectRuntime {
  readonly runtimeId: string
  build(options: PhaseOptions): Promise<BuildResult>
  check(options: PhaseOptions & { readonly checkId: string; readonly output: ImmutableOutput }): Promise<PhaseOutcome>
  /** IDs of containers this runtime still owns (any state). */
  containers(): Promise<string[]>
  /** Removes every container this runtime owns; true when none remains. */
  dispose(): Promise<boolean>
}

const CONTAINER_HOME = '/tmp'
const CONTAINER_PATH = '/usr/local/bin:/usr/bin:/bin'
const CONTAINER_WORKSPACE = '/workspace'
const STOP_GRACE_SECONDS = 5
const DOCKER_CALL_TIMEOUT_MS = 60_000
const JOIN_SLACK_MS = 20_000
const SAFE_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}$/
const MAX_OUTPUT_DEPTH = 16

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const emptyDiagnostics: RuntimeDiagnostics = Object.freeze({ bytes: 0, truncated: false, text: '' })

interface DockerResult {
  readonly code: number | null
  readonly stdout: string
  readonly unavailable: boolean
}

function docker(args: readonly string[], timeout = DOCKER_CALL_TIMEOUT_MS): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding: 'utf8', env: dockerCliEnvironment(), timeout, maxBuffer: 4 * 1_024 * 1_024, shell: false }, (error, stdout) => {
      if (error === null) return resolve({ code: 0, stdout, unavailable: false })
      const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null
      resolve({ code: code ?? 1, stdout: String(stdout ?? ''), unavailable: (error as NodeJS.ErrnoException).code === 'ENOENT' })
    })
  })
}

/** Bounded collector of a producer's merged stdout and stderr. */
function boundedCollector(maxBytes: number) {
  const chunks: Buffer[] = []
  let kept = 0
  let total = 0
  return {
    push(chunk: Buffer): void {
      total += chunk.length
      if (kept >= maxBytes) return
      const slice = chunk.subarray(0, maxBytes - kept)
      chunks.push(slice)
      kept += slice.length
    },
    result(): RuntimeDiagnostics {
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
      let text = sanitizeText(decoded).value
      while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1)
      return Object.freeze({ bytes: total, truncated: total > maxBytes, text })
    },
  }
}

async function readNoFollow(absolute: string): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null
  } finally {
    await handle.close()
  }
}

/** Restores owner write permission on an immutable tree so it can be removed. */
async function makeRemovable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null)
  if (info === null || !info.isDirectory()) return
  await chmod(root, 0o700).catch(() => undefined)
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeRemovable(path.join(root, entry.name))
  }
}

type CopyOutcome = { readonly ok: true; readonly output: ImmutableOutput } | { readonly ok: false; readonly reason: RuntimeFailure }

/** Copies regular build output through no-follow reads into a new immutable owned directory. */
async function acceptOutput(source: string, configuration: ExecutionConfiguration, protectedRoots: readonly string[]): Promise<CopyOutcome> {
  const limits = configuration.profile.byte_limits
  const listing: Array<{ readonly relative: string; readonly directory: boolean }> = []
  let bytes = 0
  const walk = async (relative: string, depth: number): Promise<RuntimeFailure | null> => {
    if (depth > MAX_OUTPUT_DEPTH) return 'RUNTIME_OUTPUT_UNSAFE'
    const entries = await readdir(path.join(source, relative), { withFileTypes: true }).catch(() => null)
    if (entries === null) return 'RUNTIME_OUTPUT_MISSING'
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      const info = await lstat(path.join(source, child))
      if (!SAFE_SEGMENT.test(entry.name) || info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) return 'RUNTIME_OUTPUT_UNSAFE'
      if (info.isDirectory()) {
        listing.push({ relative: child, directory: true })
        const nested = await walk(child, depth + 1)
        if (nested !== null) return nested
        continue
      }
      bytes += info.size
      if (listing.filter((item) => !item.directory).length + 1 > limits.max_output_files || bytes > limits.max_output_bytes) return 'RUNTIME_OUTPUT_TOO_LARGE'
      listing.push({ relative: child, directory: false })
    }
    return null
  }
  const problem = await walk('', 0)
  if (problem !== null) return { ok: false, reason: problem }
  const entry = entryFile(configuration.entry_path)
  if (!listing.some((item) => !item.directory && item.relative === entry)) return { ok: false, reason: 'RUNTIME_OUTPUT_MISSING' }

  const target = await createProjectTempDirectory({ purpose: 'target-output', protectedRoots })
  const remove = async (): Promise<void> => {
    await makeRemovable(target.path)
    await rm(target.path, { recursive: true, force: true })
  }
  try {
    const files: OutputFile[] = []
    for (const item of listing) {
      const destination = path.join(target.path, item.relative)
      if (item.directory) {
        await mkdir(destination, { mode: 0o700 })
        continue
      }
      const content = await readNoFollow(path.join(source, item.relative))
      if (content === null) {
        await remove()
        return { ok: false, reason: 'RUNTIME_OUTPUT_UNSAFE' }
      }
      await writeFile(destination, content, { flag: 'wx', mode: 0o444 })
      await chmod(destination, 0o444)
      files.push(Object.freeze({ path: item.relative, size: content.length, sha256: sha256(content) }))
    }
    for (const item of [...listing].reverse()) if (item.directory) await chmod(path.join(target.path, item.relative), 0o555)
    await chmod(target.path, 0o555)
    const sorted = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { ok: true, output: Object.freeze({ root: target.path, files: Object.freeze(sorted), sha256: projectDigest(sorted.map((file) => [file.path, file.size, file.sha256])), remove }) }
  } catch (error) {
    await remove()
    throw error
  }
}

/** The output file that serves a confirmed entry path. */
export function entryFile(entryPath: string): string {
  const relative = entryPath.replace(/^\//, '')
  return relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative
}

/** Creates the runtime for one profile; each phase owns exactly one container. */
export function createProjectRuntime(options: { readonly profile: RuntimeProfile }): ProjectRuntime {
  const { profile } = options
  const runtimeId = newProjectUuid()
  let sequence = 0

  const owned = async (): Promise<string[]> => {
    const listed = await docker(['ps', '-a', '--no-trunc', '--filter', `label=${RUNTIME_LABEL}=${runtimeId}`, '--format', '{{.ID}}'])
    if (listed.code !== 0) throw new Error('docker unavailable')
    return listed.stdout.split('\n').filter(Boolean).sort()
  }

  const removeContainer = async (name: string): Promise<boolean> => {
    await docker(['rm', '--force', '--volumes', '--', name])
    const inspected = await docker(['container', 'inspect', '--', name])
    return inspected.code !== 0
  }

  const validate = (phase: PhaseOptions): ExecutionConfiguration | null => {
    const parsed = ExecutionConfigurationSchema.safeParse(phase.configuration)
    if (!parsed.success) return null
    const configuration = parsed.data
    if (configuration.confirmation.state !== 'confirmed' || configuration.profile.image_id !== profile.imageId || configuration.profile.network !== 'none') return null
    if (configuration.baseline_commit !== phase.snapshot.baselineCommit) return null
    const timeout = phase.timeoutMs ?? configuration.profile.limits.phase_timeout_ms
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > configuration.profile.limits.phase_timeout_ms) return null
    return configuration
  }

  /** Prepares the runtime-owned workspace entries: the dependency link and the output mount point. */
  const prepareWorkspace = async (snapshot: ProjectSnapshot, outputDirectory: string): Promise<boolean> => {
    const link = path.join(snapshot.workspace, 'node_modules')
    const existing = await lstat(link).catch(() => null)
    if (existing === null) await symlink(PROFILE_DEPENDENCY_ROOT, link)
    else if (!existing.isSymbolicLink()) return false
    snapshot.allowRuntimeEntry('node_modules')
    const mountPoint = path.join(snapshot.workspace, outputDirectory)
    const top = outputDirectory.split('/')[0] ?? outputDirectory
    const info = await lstat(mountPoint).catch(() => null)
    if (info === null) await mkdir(mountPoint, { recursive: true, mode: 0o755 })
    else if (!info.isDirectory() || (await readdir(mountPoint)).length > 0) return false
    snapshot.allowRuntimeEntry(top)
    return true
  }

  const runContainer = async (
    phase: PhaseOptions,
    configuration: ExecutionConfiguration,
    argv: readonly string[],
    output: { readonly source: string; readonly readonly: boolean },
    failure: 'RUNTIME_BUILD_FAILED' | 'RUNTIME_CHECK_FAILED',
  ): Promise<PhaseOutcome> => {
    const collector = boundedCollector(configuration.profile.byte_limits.max_diagnostic_bytes)
    const fail = (reason: RuntimeFailure, exitCode: number | null = null): PhaseOutcome => Object.freeze({ status: 'failed', reason, exitCode, diagnostics: collector.result() })
    if (phase.signal?.aborted) return fail('RUNTIME_CANCELLED')
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    const gid = typeof process.getgid === 'function' ? process.getgid() : -1
    if (uid <= 0 || gid < 0) return fail('RUNTIME_INPUT_INVALID')
    for (const mount of [phase.snapshot.workspace, output.source]) if (/[,=\s]/.test(mount)) return fail('RUNTIME_INPUT_INVALID')
    if (!(await phase.snapshot.verify()).ok) return fail('RUNTIME_INPUT_CHANGED')

    const limits = configuration.profile.limits
    const name = `flowproof-project-${runtimeId.slice(0, 8)}-${++sequence}-${randomBytes(4).toString('hex')}`
    const [program, ...rest] = argv
    const executable = program === 'node' ? PROFILE_NODE_PATH : (program as string)
    const created = await docker([
      'create',
      `--name=${name}`,
      `--label=${RUNTIME_LABEL}=${runtimeId}`,
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      `--pids-limit=${limits.pids}`,
      `--memory=${limits.memory_bytes}`,
      `--memory-swap=${limits.memory_bytes}`,
      `--cpus=${limits.cpu_count}`,
      `--stop-timeout=${STOP_GRACE_SECONDS}`,
      '--log-driver=none',
      '--hostname=flowproof-project',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m',
      `--user=${uid}:${gid}`,
      `--workdir=${CONTAINER_WORKSPACE}`,
      '--entrypoint=',
      `--env=HOME=${CONTAINER_HOME}`,
      `--env=TMPDIR=${CONTAINER_HOME}`,
      `--env=PATH=${CONTAINER_PATH}`,
      '--env=NO_COLOR=1',
      `--mount=type=bind,source=${phase.snapshot.workspace},target=${CONTAINER_WORKSPACE},readonly`,
      `--mount=type=bind,source=${output.source},target=${CONTAINER_WORKSPACE}/${configuration.build.output_directory}${output.readonly ? ',readonly' : ''}`,
      '--',
      profile.imageId,
      executable,
      ...rest,
    ])
    if (created.code !== 0) {
      await removeContainer(name)
      return fail(created.unavailable ? 'RUNTIME_DOCKER_FAILED' : 'RUNTIME_DOCKER_FAILED')
    }

    let stopReason: 'RUNTIME_TIMEOUT' | 'RUNTIME_CANCELLED' | null = null
    let stopping: Promise<unknown> | null = null
    const attached = spawn('docker', ['start', '--attach', '--', name], { env: dockerCliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    attached.stdout.on('data', (chunk: Buffer) => collector.push(chunk))
    attached.stderr.on('data', (chunk: Buffer) => collector.push(chunk))
    const exited = new Promise<void>((resolve) => {
      attached.once('close', () => resolve())
      attached.once('error', () => resolve())
    })
    const stop = (reason: 'RUNTIME_TIMEOUT' | 'RUNTIME_CANCELLED'): void => {
      stopReason ??= reason
      stopping ??= docker(['stop', `--time=${STOP_GRACE_SECONDS}`, '--', name], (STOP_GRACE_SECONDS + 30) * 1_000)
    }
    const timer = setTimeout(() => stop('RUNTIME_TIMEOUT'), phase.timeoutMs ?? limits.phase_timeout_ms)
    const onAbort = (): void => stop('RUNTIME_CANCELLED')
    phase.signal?.addEventListener('abort', onAbort, { once: true })
    if (phase.signal?.aborted) onAbort()
    // Join: the attached CLI ends when the container ends; a stuck attach is killed after the grace.
    const joinDeadline = new Promise<'late'>((resolve) => {
      const check = setInterval(() => {
        if (stopping !== null) {
          clearInterval(check)
          setTimeout(() => resolve('late'), STOP_GRACE_SECONDS * 1_000 + JOIN_SLACK_MS)
        }
      }, 100)
      void exited.then(() => clearInterval(check))
    })
    const joined = await Promise.race([exited.then(() => 'joined' as const), joinDeadline])
    clearTimeout(timer)
    phase.signal?.removeEventListener('abort', onAbort)
    if (joined === 'late') {
      await docker(['kill', '--', name])
      attached.kill('SIGKILL')
      await exited
    }
    if (stopping !== null) await stopping

    const state = await docker(['container', 'inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}', '--', name])
    const [status, exitText, oomText] = state.stdout.trim().split(' ')
    const exitCode = state.code === 0 && status === 'exited' ? Number(exitText) : null
    const removed = await removeContainer(name)
    if (!removed) return fail('RUNTIME_CLEANUP_FAILED', exitCode)
    if (stopReason !== null) return fail(stopReason, exitCode)
    if (oomText === 'true') return fail('RUNTIME_OOM', exitCode)
    if (exitCode === null) return fail('RUNTIME_DOCKER_FAILED')
    if (!(await phase.snapshot.verify()).ok) return fail('RUNTIME_INPUT_CHANGED', exitCode)
    if (exitCode !== 0) return fail(failure, exitCode)
    return Object.freeze({ status: 'passed', exitCode: 0, diagnostics: collector.result() })
  }

  return Object.freeze({
    runtimeId,

    async build(phase: PhaseOptions): Promise<BuildResult> {
      const configuration = validate(phase)
      if (configuration === null) return Object.freeze({ status: 'failed', reason: 'RUNTIME_INPUT_INVALID', exitCode: null, diagnostics: emptyDiagnostics, output: null })
      if (!(await prepareWorkspace(phase.snapshot, configuration.build.output_directory))) {
        return Object.freeze({ status: 'failed', reason: 'RUNTIME_INPUT_INVALID', exitCode: null, diagnostics: emptyDiagnostics, output: null })
      }
      const source = path.join(phase.snapshot.root, `output-${randomBytes(6).toString('hex')}`)
      await mkdir(source, { mode: 0o700 })
      try {
        const outcome = await runContainer(phase, configuration, configuration.build.argv, { source, readonly: false }, 'RUNTIME_BUILD_FAILED')
        if (outcome.status !== 'passed') return Object.freeze({ ...outcome, output: null })
        // The producer is stopped, joined and removed: only now is its output read.
        const accepted = await acceptOutput(source, configuration, [phase.snapshot.root])
        if (!accepted.ok) return Object.freeze({ status: 'failed', reason: accepted.reason, exitCode: 0, diagnostics: outcome.diagnostics, output: null })
        return Object.freeze({ ...outcome, output: accepted.output })
      } finally {
        await makeRemovable(source)
        await rm(source, { recursive: true, force: true })
      }
    },

    async check(phase: PhaseOptions & { readonly checkId: string; readonly output: ImmutableOutput }): Promise<PhaseOutcome> {
      const configuration = validate(phase)
      const check = configuration?.required_project_checks.find((entry) => entry.id === phase.checkId)
      if (configuration === null || check === undefined || !(await prepareWorkspace(phase.snapshot, configuration.build.output_directory))) {
        return Object.freeze({ status: 'failed', reason: 'RUNTIME_INPUT_INVALID', exitCode: null, diagnostics: emptyDiagnostics })
      }
      return runContainer(phase, configuration, check.argv, { source: phase.output.root, readonly: true }, 'RUNTIME_CHECK_FAILED')
    },

    containers: owned,

    async dispose(): Promise<boolean> {
      let remaining: string[]
      try {
        remaining = await owned()
      } catch {
        return false
      }
      for (const id of remaining) await removeContainer(id)
      try {
        return (await owned()).length === 0
      } catch {
        return false
      }
    },
  })
}
