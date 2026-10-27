import { z } from 'zod'

import {
  GateOutcomeSchema,
  PhaseDurationsSchema,
  RUN_STATES,
  SCENARIO_CASES,
  checkVerificationInvariants,
  gitOidSchema,
  issueReporter,
  kebabIdSchema,
  localhostAppUrlSchema,
  relativePathSchema,
  safeParseContract,
  sha256Schema,
  timestampSchema,
  uuidSchema,
  verificationResultShape,
} from './schemas.js'
import type { ContractResult, RunState, RunStatus } from './schemas.js'

// Internal entities from data-model.md. They are not exchanged as JSON artifacts, but the
// engine validates them with the same strict, value-free error mapping as the contracts.

export const MAX_CHAT_TEXT_LENGTH = 500
export const WORKSPACE_SESSION_STATES = ['ready', 'running', 'finalized', 'closed'] as const

export type WorkspaceSessionState = (typeof WORKSPACE_SESSION_STATES)[number]

export const WorkspaceSessionSchema = z
  .strictObject({
    session_id: uuidSchema,
    created_at: timestampSchema,
    scenario_id: kebabIdSchema.nullable(),
    state: z.enum(WORKSPACE_SESSION_STATES),
    active_run_id: uuidSchema.nullable(),
    target_url: localhostAppUrlSchema.nullable(),
  })
  .superRefine((session, ctx) => {
    const issue = issueReporter(ctx)
    if (session.state === 'ready' && session.active_run_id !== null) issue(['active_run_id'], 'SESSION_READY_HAS_RUN')
    if (session.state === 'running' && (session.active_run_id === null || session.scenario_id === null)) {
      issue(['active_run_id'], 'SESSION_RUN_REQUIRED')
    }
  })

export const ChatRequestSchema = z.strictObject({
  request_id: uuidSchema,
  session_id: uuidSchema,
  run_id: uuidSchema,
  created_at: timestampSchema,
  // Sanitized plain text: chat is never rendered as HTML, so markup delimiters are refused.
  text: z.string().min(1).max(MAX_CHAT_TEXT_LENGTH).regex(/^[^<>]*$/),
  scenario_id: kebabIdSchema,
})

export const VerificationResultSchema = z.strictObject(verificationResultShape).superRefine(checkVerificationInvariants)

/** The only persistent product-artifact location beneath the original working tree. */
export const artifactRootFor = (runId: string): string => `.flowproof/runs/${runId}/`

export const RunSchema = z
  .strictObject({
    run_id: uuidSchema,
    scenario_id: kebabIdSchema,
    request_id: uuidSchema,
    case: z.enum(SCENARIO_CASES),
    started_at: timestampSchema,
    completed_at: timestampSchema.nullable(),
    original_head: gitOidSchema,
    original_status_digest: sha256Schema,
    original_worktree_list_digest: sha256Schema,
    state: z.enum(RUN_STATES),
    phase_durations_ms: PhaseDurationsSchema,
    artifact_root: z.string(),
    result: VerificationResultSchema.nullable(),
  })
  .superRefine((run, ctx) => {
    const issue = issueReporter(ctx)
    if (run.artifact_root !== artifactRootFor(run.run_id)) issue(['artifact_root'], 'RUN_ARTIFACT_ROOT_INVALID')
    const finalized = run.state === 'finalized'
    if (finalized !== (run.result !== null)) issue(['result'], 'RUN_RESULT_STATE_MISMATCH')
    if (finalized !== (run.completed_at !== null)) issue(['completed_at'], 'RUN_COMPLETION_STATE_MISMATCH')
  })

export const CandidateChangeSchema = z
  .strictObject({
    diagnosis_sha256: sha256Schema,
    target_paths: z.array(relativePathSchema).min(1).max(1),
    diff_path: relativePathSchema,
    diff_sha256: sha256Schema,
    guard_outcome: GateOutcomeSchema,
    application_outcome: GateOutcomeSchema,
    worktree_head: gitOidSchema,
  })
  .superRefine((candidate, ctx) => {
    const issue = issueReporter(ctx)
    if (!['citations_valid', 'patch_scope_valid'].includes(candidate.guard_outcome.gate_id)) {
      issue(['guard_outcome', 'gate_id'], 'CANDIDATE_GUARD_GATE_INVALID')
    }
    if (candidate.application_outcome.gate_id !== 'patch_applied') {
      issue(['application_outcome', 'gate_id'], 'CANDIDATE_APPLY_GATE_INVALID')
    }
  })

export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>
export type ChatRequest = z.infer<typeof ChatRequestSchema>
export type VerificationResult = z.infer<typeof VerificationResultSchema>
export type Run = z.infer<typeof RunSchema>
export type CandidateChange = z.infer<typeof CandidateChangeSchema>

export const parseWorkspaceSession = (input: unknown): ContractResult<WorkspaceSession> =>
  safeParseContract('workspace-session', WorkspaceSessionSchema, input)

export const parseChatRequest = (input: unknown): ContractResult<ChatRequest> =>
  safeParseContract('chat-request', ChatRequestSchema, input)

export const parseVerificationResult = (input: unknown): ContractResult<VerificationResult> =>
  safeParseContract('verification-result', VerificationResultSchema, input)

export const parseRun = (input: unknown): ContractResult<Run> => safeParseContract('run', RunSchema, input)

export const parseCandidateChange = (input: unknown): ContractResult<CandidateChange> =>
  safeParseContract('candidate-change', CandidateChangeSchema, input)

// ---------------------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------------------

/**
 * Legal run transitions: the ordered happy path, plus a direct fail-closed jump to
 * `finalized` from any state after `initialized` (data-model.md, "State transitions").
 */
export function isLegalRunTransition(from: RunState, to: RunState): boolean {
  if (from === 'finalized') return false
  if (to === 'finalized') return from !== 'initialized'
  return RUN_STATES.indexOf(to) === RUN_STATES.indexOf(from) + 1
}

/** `Verified Fix` is legal only when finalizing directly from `replaying`. */
export function isLegalFinalStatus(from: RunState, status: RunStatus): boolean {
  if (!isLegalRunTransition(from, 'finalized')) return false
  return status === 'Unverified' || from === 'replaying'
}

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze(
  Object.fromEntries(
    RUN_STATES.map((from) => [from, Object.freeze(RUN_STATES.filter((to) => isLegalRunTransition(from, to)))]),
  ) as Record<RunState, readonly RunState[]>,
)
