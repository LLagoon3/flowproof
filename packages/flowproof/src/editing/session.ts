import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { sanitizeText } from '../evidence/sanitize.js'
import { createTaskDocument } from './contracts.js'
import type {
  CleanupReasonCode,
  CleanupResult,
  EditingSessionHandle,
  EditingSessionResult,
  ExecutionOutcome,
  IsolationObservation,
  OwnedResourceCategory,
  ResolvedEditingSessionRequest,
} from './contracts.js'
import { createDockerCli } from './dockerCli.js'
import type { DockerAdapter } from './dockerCli.js'
import type { RuntimeProfileRegistry } from './runtimeProfile.js'
import { createWorkspaceManager } from './workspace.js'
import type { OriginalIntegrity, SessionWorkspace, WorkspaceDisposal, WorkspaceManager } from './workspace.js'

// The editing-session lifecycle owner. It validates the request synchronously, then prepares the
// standalone clone, creates and attaches the constrained container, and finalizes exactly once:
// the exact container is removed, the manifest paths are disposed, and the original repository is
// compared with its pre-session snapshot before the single result resolves. The session never
// enumerates, opens, or analyzes agent-authored workspace contents and exposes no workspace path.

export interface EditingSessionDependencies {
  /** The trusted profile registry; requests can only name one of its profiles. */
  readonly profiles: RuntimeProfileRegistry
  readonly docker?: DockerAdapter
  readonly workspaces?: WorkspaceManager
  /** Monotonic milliseconds. */
  readonly clock?: () => number
}

/** Stable startup-failure codes; diagnostics never carry Docker or Git output. */
const STARTUP_MESSAGES = {
  REPOSITORY_UNAVAILABLE: 'the repository root is not a readable Git worktree',
  REVISION_UNAVAILABLE: 'the selected revision is not a commit in the repository',
  SESSION_ROOT_INSIDE_REPOSITORY: 'session state would live inside the original repository',
  SESSION_ROOT_UNSAFE: 'the temporary root cannot hold session state safely',
  WORKSPACE_PREPARE_FAILED: 'the disposable workspace could not be prepared',
  DOCKER_CAPABILITY_MISSING: 'the Docker daemon cannot enforce the required isolation',
  DOCKER_CREATE_FAILED: 'the session container could not be created',
  DOCKER_START_FAILED: 'the session container could not start',
  CONTROLLER_ROOT_UNSUPPORTED: 'a root controller cannot provide a non-root agent identity',
  SESSION_INTERNAL_ERROR: 'the session failed unexpectedly',
} as const
type StartupCode = keyof typeof STARTUP_MESSAGES

class StartupFailure extends Error {
  constructor(readonly startupCode: StartupCode) {
    super(startupCode)
  }
}

const startupCodeOf = (error: unknown): StartupCode => {
  if (error instanceof StartupFailure) return error.startupCode
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && Object.hasOwn(STARTUP_MESSAGES, code) ? (code as StartupCode) : 'SESSION_INTERNAL_ERROR'
}

/** Assembles the cleanup proof from what actually remains. */
function cleanupResult(input: { readonly containerRemoved: boolean; readonly disposal: WorkspaceDisposal; readonly integrity: OriginalIntegrity }): CleanupResult {
  const { containerRemoved, disposal, integrity } = input
  const remaining: OwnedResourceCategory[] = []
  if (!containerRemoved) remaining.push('container')
  if (!disposal.taskDocumentRemoved) remaining.push('task_document')
  if (!disposal.workspaceRemoved || (!disposal.sessionRootRemoved && disposal.taskDocumentRemoved)) remaining.push('workspace')
  if (!integrity.unchanged) remaining.push('original_repository')
  const reasons: Record<OwnedResourceCategory, CleanupReasonCode> = {
    container: 'CONTAINER_NOT_REMOVED',
    task_document: 'TASK_DOCUMENT_NOT_REMOVED',
    workspace: 'WORKSPACE_NOT_REMOVED',
    original_repository: integrity.verified ? 'ORIGINAL_REPOSITORY_CHANGED' : 'ORIGINAL_REPOSITORY_UNVERIFIED',
  }
  const first = remaining[0]
  return Object.freeze({
    status: first === undefined ? 'complete' : 'failed',
    containerRemoved,
    workspaceRemoved: disposal.sessionRootRemoved,
    originalRepositoryUnchanged: integrity.unchanged,
    reasonCode: first === undefined ? null : reasons[first],
    remainingOwnedResources: Object.freeze(remaining),
  })
}

/** Starts one editing session; throws synchronously, before any side effect, on invalid input. */
export function startEditingSession(request: unknown, dependencies: EditingSessionDependencies): EditingSessionHandle {
  const resolved: ResolvedEditingSessionRequest = dependencies.profiles.resolveRequest(request)
  const docker = dependencies.docker ?? createDockerCli()
  const workspaces = dependencies.workspaces ?? createWorkspaceManager()
  const clock = dependencies.clock ?? (() => performance.now())
  const id = randomUUID()
  const result = runSession({ id, resolved, docker, workspace: workspaces.open(), clock })
  return Object.freeze({
    id,
    result,
    // Cancellation, timeout, and terminal-cause selection arrive with the US2 lifecycle (T020).
    cancel: async (): Promise<void> => {
      await result
    },
  })
}

interface SessionContext {
  readonly id: string
  readonly resolved: ResolvedEditingSessionRequest
  readonly docker: DockerAdapter
  readonly workspace: SessionWorkspace
  readonly clock: () => number
}

async function runSession(context: SessionContext): Promise<EditingSessionResult> {
  const { id, resolved, docker, workspace, clock } = context
  const { request, profile, limits } = resolved
  const startedAt = clock()
  let isolation: IsolationObservation | null = null
  let containerId: string | null = null
  let outcome: ExecutionOutcome = 'startup_failed'
  let startupCode: StartupCode | null = null
  let exitCode: number | null = null
  const captured: Buffer[] = []
  let capturedBytes = 0
  const capture = (chunk: Buffer): void => {
    const room = limits.diagnosticBytes - capturedBytes
    if (room <= 0) return
    const kept = chunk.subarray(0, room)
    captured.push(kept)
    capturedBytes += kept.length
  }

  try {
    const uid = process.getuid?.() ?? -1
    const gid = process.getgid?.() ?? -1
    if (uid <= 0 || gid <= 0) throw new StartupFailure('CONTROLLER_ROOT_UNSUPPORTED')
    await workspace.resolve(request.repositoryRoot, request.revision)
    const capabilities = await docker.preflight()
    if (!capabilities.supported) throw new StartupFailure('DOCKER_CAPABILITY_MISSING')
    isolation = capabilities.isolation
    const prepared = await workspace.create(createTaskDocument(request))
    containerId = await docker.create({
      sessionId: id,
      profile,
      limits,
      user: { uid, gid },
      workspacePath: prepared.workspacePath,
      taskDocumentPath: prepared.taskDocumentPath,
      lsm: capabilities.isolation.lsm,
    })
    const attached = docker.start(containerId, { onStdout: capture, onStderr: capture })
    await attached.exited
    const state = await docker.inspect(containerId)
    if (state === null || !state.started || state.startError) throw new StartupFailure('DOCKER_START_FAILED')
    exitCode = state.exitCode
    outcome = exitCode === 0 ? 'completed' : 'failed'
  } catch (error) {
    startupCode = startupCodeOf(error)
    outcome = 'startup_failed'
    exitCode = null
  }

  // Finalization: exact container, manifest paths, then the original-repository comparison.
  let containerRemoved = true
  if (containerId !== null) {
    await docker.remove(containerId).catch(() => undefined)
    containerRemoved = !(await docker.exists(containerId).catch(() => true))
  }
  const disposal = await workspace.dispose()
  const integrity = await workspace.verifyOriginal()

  const summary =
    outcome === 'startup_failed'
      ? `startup_failed: ${STARTUP_MESSAGES[startupCode ?? 'SESSION_INTERNAL_ERROR']}.`
      : `${outcome}: the agent exited with code ${exitCode ?? 'unknown'}.`
  const output = sanitizeText(Buffer.concat(captured).toString('utf8')).value
  return Object.freeze({
    sessionId: id,
    executionOutcome: outcome,
    exitCode,
    signal: null,
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    diagnostic: output === '' ? summary : `${summary}\n${output}`,
    cleanup: cleanupResult({ containerRemoved, disposal, integrity }),
    runtime: Object.freeze({ profileId: profile.id, imageReference: profile.imageReference, isolation }),
  })
}
