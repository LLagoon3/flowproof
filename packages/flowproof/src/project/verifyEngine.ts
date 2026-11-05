import { access } from 'node:fs/promises'

import type { Browser } from 'playwright'

import type { RedactedValueRegistry } from '../capture/projectPrivacy.js'
import type { ProjectModelSession } from '../model/projectClient.js'
import { buildProjectCorrectionPrompt } from '../model/projectPrompt.js'
import { admitProjectPatch, applyProjectPatch } from '../patch/projectDiff.js'
import { compileFrozenReplay, executeFrozenReplay, openChromiumReplaySession } from '../verify/projectReplay.js'
import type { FrozenReplay, ReplayExecutionResult, ReplayPhase } from '../verify/projectReplay.js'
import { createReplayImageCollector } from '../verify/projectReplayImages.js'
import type { ReplayImageEvidence } from '../verify/projectReplayImages.js'
import type { AdmittedProject } from './admission.js'
import { newProjectUuid, projectCheckId, projectDigest } from './contracts.js'
import type { DemonstrationCapture, ExecutionConfiguration, Interpretation, OriginalIntegrity } from './contracts.js'
import type { FinalizedProjectRun, ProjectRunLifecycle } from './run.js'
import type { ProjectSnapshot } from './snapshot.js'

// Verify-and-fix engine (T036/T038/T040/T041): host-owned and serial. The frozen definition is
// compiled from the sealed capture and ready interpretation; a fresh isolated baseline replay must
// fail exactly the designated task condition, after every action executed, before the single
// correction request is allowed. The strict patch is applied to a fresh owned copy, built and
// checked offline, served at the same admitted origin and replayed identically. Finalization takes
// the lifecycle's authoritative reduction after cleanup and original-integrity evidence; nothing
// in the browser or the model can mint success.

type CorrectionInput = Parameters<typeof buildProjectCorrectionPrompt>[0]

export type CandidateServing =
  | { readonly ok: true; readonly outputSha256: string; readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }[] }
  | { readonly ok: false; readonly reason: string; readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'failed' | 'not_evaluated' }[] }

/** Launcher-owned resources the engine needs; nothing here comes from the browser. */
export interface VerifyHostPorts {
  readonly project: AdmittedProject
  readonly configuration: ExecutionConfiguration
  /** Digest of the prepared baseline output currently served at the admitted origin. */
  readonly baselineBuildSha256: string
  /** A fresh host-owned browser for isolated replays; the engine closes it. */
  openBrowser(): Promise<Browser>
  /** Builds and checks the candidate copy offline, then serves its output at the admitted origin. */
  serveCandidate(copy: ProjectSnapshot, signal: AbortSignal): Promise<CandidateServing>
  /** Serves the prepared baseline again and removes candidate output; true when clean. */
  restoreBaseline(): Promise<boolean>
  /** True only when no candidate output is retained and the baseline output is served. */
  candidateReleased(): Promise<boolean>
  /** Re-verifies the original repository against its admitted baseline. */
  originalIntegrity(): Promise<OriginalIntegrity>
}

export interface VerifyEnginePorts extends VerifyHostPorts {
  readonly lifecycle: ProjectRunLifecycle
  readonly runId: string
  readonly capture: DemonstrationCapture
  readonly interpretation: Interpretation
  readonly registry: RedactedValueRegistry
  readonly sources: CorrectionInput['sources']
  readonly admitted: ReadonlySet<string>
  readonly model: ProjectModelSession
}

export interface VerifyEvent {
  readonly stage: 'definition' | 'baseline' | 'correction' | 'patch' | 'candidate-build' | 'candidate-replay' | 'cleanup'
  readonly status: 'started' | 'passed' | 'failed'
  readonly reason: string | null
}

export interface ReplaySummary {
  readonly outcome: ReplayExecutionResult['outcome']
  readonly reason: string | null
  readonly task_condition: ReplayExecutionResult['task_condition']
  readonly actions_executed: number
  readonly actions_total: number
  readonly evidence: number
}

export interface VerifyResult {
  readonly finalized: FinalizedProjectRun
  readonly baseline: ReplaySummary | null
  readonly candidate: ReplaySummary | null
  readonly patch: { readonly target_paths: readonly string[]; readonly summary: string } | null
  readonly events: readonly VerifyEvent[]
}

const summarize = (result: ReplayExecutionResult): ReplaySummary =>
  Object.freeze({
    outcome: result.outcome,
    reason: result.reason,
    task_condition: result.task_condition,
    actions_executed: result.actions.filter((action) => action.status === 'executed').length,
    actions_total: result.actions.length,
    evidence: result.evidence.length,
  })

export async function runVerifyAndFix(ports: VerifyEnginePorts, onEvent: (event: VerifyEvent) => void = () => undefined): Promise<VerifyResult> {
  const { lifecycle } = ports
  const events: VerifyEvent[] = []
  const emit = (stage: VerifyEvent['stage'], status: VerifyEvent['status'], reason: string | null = null): void => {
    const event = Object.freeze({ stage, status, reason })
    events.push(event)
    onEvent(event)
  }
  const check = (id: string, passed: boolean, phase: Parameters<ProjectRunLifecycle['recordCheck']>[0]['phase'], reason: string, evidence: readonly string[] = []): void => {
    lifecycle.recordCheck({ id, status: passed ? 'passed' : 'failed', phase, reason, evidence_ids: evidence.slice(0, 16) })
  }

  // Each engine-owned resource is registered with the lifecycle before it can exist, so
  // finalization verifies its release and a failed cleanup decides the authoritative outcome.
  const once = (work: () => Promise<void>): (() => Promise<void>) => {
    let done: Promise<void> | null = null
    return () => (done ??= work())
  }
  const own = (kind: Parameters<ProjectRunLifecycle['own']>[0]['kind'], label: string, release: () => Promise<void>, verifyReleased: () => Promise<boolean>): (() => Promise<void>) => {
    const released = once(release)
    lifecycle.own({ kind, label, release: released, verifyReleased })
    return released
  }
  const halted = (): boolean => lifecycle.snapshot().cancel_requested || lifecycle.state() === 'finalizing' || lifecycle.state() === 'terminal'
  const releases: Array<() => Promise<void>> = []

  let browser: Browser | null = null
  let copy: ProjectSnapshot | null = null
  let baseline: ReplaySummary | null = null
  let candidate: ReplaySummary | null = null
  let patch: VerifyResult['patch'] = null

  const replay = async (frozen: FrozenReplay, phase: ReplayPhase, buildSha256: string): Promise<{ readonly result: ReplayExecutionResult; readonly evidence: ReplayImageEvidence | null }> => {
    const operation = lifecycle.beginOperation('replay')
    const binding = {
      run_id: ports.runId,
      phase,
      definition_id: frozen.identity.definition_id,
      definition_digest: frozen.identity.definition_digest,
      target_origin: ports.configuration.target_origin,
      build_sha256: buildSha256,
    }
    const holder: { evidence: ReplayImageEvidence | null } = { evidence: null }
    try {
      const session = await openChromiumReplaySession(browser!, frozen, binding, {
        collectorFactory: (page) => {
          const produced = createReplayImageCollector({ page, binding, baselineCommit: ports.project.context.baseline_commit, registry: ports.registry })
          holder.evidence = produced
          return produced
        },
      })
      const result = await executeFrozenReplay(frozen, session, { signal: operation.signal })
      if (result.outcome === 'conditions-satisfied' || result.outcome === 'conditions-unsatisfied') operation.complete()
      else operation.fail(result.reason ?? 'REPLAY_FAILED')
      return { result, evidence: holder.evidence }
    } catch (error) {
      operation.fail('REPLAY_FAILED')
      throw error
    }
  }

  const engine = async (): Promise<void> => {
    emit('definition', 'started')
    const compiled = compileFrozenReplay({
      run_id: ports.runId,
      project: ports.project.context,
      configuration: ports.configuration,
      capture: ports.capture,
      interpretation: ports.interpretation,
    })
    if (!compiled.ok) {
      const reason = compiled.reasons[0] ?? 'DEFINITION_INVALID'
      check('definition_frozen', false, 'definition', reason)
      emit('definition', 'failed', reason)
      return
    }
    const frozen = compiled.frozen
    check('definition_frozen', true, 'definition', 'DEFINITION_FROZEN')
    emit('definition', 'passed')

    if (halted()) return
    const browserRelease = own('browser-context', 'verify-browser', async () => { await browser?.close() }, async () => browser === null || !browser.isConnected())
    releases.push(browserRelease)
    browser = await ports.openBrowser()
    if (halted()) return
    const definitionBefore = projectDigest(frozen.definition)
    const configurationBefore = projectDigest(ports.configuration)
    const sourcesBefore = projectDigest(ports.sources)
    lifecycle.transition('baseline-replay')
    emit('baseline', 'started')
    const base = await replay(frozen, 'baseline', ports.baselineBuildSha256)
    baseline = summarize(base.result)
    const baseEvidence = base.result.evidence.map((item) => item.observation_id)
    const intended =
      base.result.outcome === 'conditions-unsatisfied' &&
      base.result.task_condition?.status === 'unsatisfied' &&
      base.result.actions.every((action) => action.status === 'executed') &&
      base.evidence !== null
    if (!intended) {
      const reason = base.result.outcome === 'conditions-satisfied' ? 'BASELINE_NOT_REPRODUCED' : (base.result.reason ?? 'BASELINE_REPLAY_FAILED')
      check('baseline_reproduced', false, 'baseline', reason, baseEvidence)
      emit('baseline', 'failed', reason)
      return
    }
    check('baseline_reproduced', true, 'baseline', 'INTENDED_CONDITION_FAILED', baseEvidence)
    emit('baseline', 'passed')

    // The single correction request, unlocked only by the host-proved intended failure.
    if (halted()) return
    lifecycle.transition('correcting')
    emit('correction', 'started')
    const operation = lifecycle.beginOperation('provider')
    const onAbort = (): void => ports.model.cancel()
    operation.signal.addEventListener('abort', onAbort, { once: true })
    let corrected: Awaited<ReturnType<ProjectModelSession['correct']>>
    try {
      const built = buildProjectCorrectionPrompt({
        run_id: ports.runId,
        invocation_id: newProjectUuid(),
        sources: ports.sources,
        admitted_source_paths: ports.admitted,
        images: base.evidence!.images(),
        registry: ports.registry,
        definition: frozen.definition,
        baseline: { outcome: 'intended-condition-failed', task_condition_index: frozen.definition.task_condition_index, observations: base.evidence!.observations() },
      })
      if (!built.ok) {
        operation.fail(built.error.code)
        check('correction_generated', false, 'correction', built.error.code)
        emit('correction', 'failed', built.error.code)
        return
      }
      corrected = await ports.model.correct(built.value)
    } catch {
      operation.fail('CORRECTION_FAILED')
      check('correction_generated', false, 'correction', 'CORRECTION_FAILED')
      emit('correction', 'failed', 'CORRECTION_FAILED')
      return
    } finally {
      operation.signal.removeEventListener('abort', onAbort)
    }
    if (!corrected.ok) {
      operation.fail(corrected.error.code)
      check('correction_generated', false, 'correction', corrected.error.code)
      emit('correction', 'failed', corrected.error.code)
      return
    }
    if (!operation.complete()) {
      emit('correction', 'failed', 'RUN_NOT_ACCEPTING')
      return
    }
    check('correction_generated', true, 'correction', 'CORRECTION_RECEIVED')
    emit('correction', 'passed')

    if (halted()) return
    emit('patch', 'started')
    let ownedCopy: ProjectSnapshot | null = null
    releases.push(own('temp-directory', 'candidate-copy', async () => { await ownedCopy?.remove() }, async () => ownedCopy === null || (await access(ownedCopy.root).then(() => false, () => true))))
    const admission = admitProjectPatch(ports.project, {
      runId: ports.runId,
      baselineCommit: ports.project.context.baseline_commit,
      definitionId: frozen.identity.definition_id,
      definitionDigest: frozen.identity.definition_digest,
      invocationId: corrected.invocation.invocation_id,
      targetPaths: corrected.output.target_paths,
      patch: corrected.output.patch,
    })
    const applied = await applyProjectPatch(ports.project, admission)
    if (applied.state !== 'applied-to-copy') {
      const reason = applied.reasons[0] ?? 'PATCH_REJECTED'
      check('candidate_applied', false, 'candidate', reason)
      emit('patch', 'failed', reason)
      return
    }
    copy = applied.copy
    ownedCopy = applied.copy
    const appliedFiles = applied.files
    patch = Object.freeze({ target_paths: Object.freeze([...corrected.output.target_paths]), summary: corrected.output.summary })
    check('candidate_applied', true, 'candidate', 'CANDIDATE_APPLIED_TO_COPY')
    emit('patch', 'passed')

    if (halted()) return
    const copyBefore = await applied.copy.verify(appliedFiles)
    lifecycle.transition('candidate-checking')
    releases.push(
      own(
        'target-server',
        'candidate-output',
        async () => {
          if (!(await ports.restoreBaseline())) throw new Error('BASELINE_RESTORE_FAILED')
        },
        () => ports.candidateReleased(),
      ),
    )
    emit('candidate-build', 'started')
    const buildOperation = lifecycle.beginOperation('build')
    const served = await ports.serveCandidate(copy, buildOperation.signal)
    for (const projectCheck of served.checks) {
      lifecycle.recordCheck({ id: projectCheckId(projectCheck.id), status: projectCheck.status, phase: 'candidate', reason: projectCheck.status === 'passed' ? 'CHECK_PASSED' : 'CHECK_NOT_PASSED' })
    }
    if (!served.ok) {
      buildOperation.fail(served.reason)
      check('candidate_build', false, 'candidate', served.reason)
      emit('candidate-build', 'failed', served.reason)
      return
    }
    if (!buildOperation.complete()) {
      emit('candidate-build', 'failed', 'RUN_NOT_ACCEPTING')
      return
    }
    check('candidate_build', true, 'candidate', 'CANDIDATE_BUILT')
    emit('candidate-build', 'passed')

    if (halted()) return
    emit('candidate-replay', 'started')
    const next = await replay(frozen, 'candidate', served.outputSha256)
    candidate = summarize(next.result)
    const nextEvidence = next.result.evidence.map((item) => item.observation_id)
    const satisfied = next.result.outcome === 'conditions-satisfied'
    check('candidate_replay', satisfied, 'candidate', satisfied ? 'CONDITIONS_SATISFIED' : (next.result.reason ?? 'CONDITIONS_UNSATISFIED'), nextEvidence)
    check('evidence_bound', baseEvidence.length > 0 && nextEvidence.length > 0, 'candidate', baseEvidence.length > 0 && nextEvidence.length > 0 ? 'EVIDENCE_BOUND' : 'EVIDENCE_MISSING')
    // Inputs: the candidate copy, frozen definition, configuration and sources are identical before
    // the runtime build and after the candidate replay.
    const copyAfter = await applied.copy.verify(appliedFiles)
    const inputsSame =
      copyBefore.ok &&
      copyAfter.ok &&
      projectDigest(frozen.definition) === definitionBefore &&
      projectDigest(ports.configuration) === configurationBefore &&
      projectDigest(ports.sources) === sourcesBefore
    check('inputs_unchanged', inputsSame, 'candidate', inputsSame ? 'INPUTS_UNCHANGED' : 'INPUTS_CHANGED')
    emit('candidate-replay', satisfied ? 'passed' : 'failed', satisfied ? null : (next.result.reason ?? 'CONDITIONS_UNSATISFIED'))
  }

  try {
    await engine()
  } catch {
    emit('cleanup', 'failed', 'VERIFY_ENGINE_FAILED')
  }

  // Cleanup and original-integrity evidence decide finalization; a provisional pass cannot hide
  // them. Every owned resource is released (candidate output, copy, browser) before the original is
  // re-read; finalization then verifies each release, so any failure reaches the reduction.
  emit('cleanup', 'started')
  let clean = true
  for (const release of [...releases].reverse()) clean = (await release().then(() => true, () => false)) && clean
  const integrity: OriginalIntegrity = await ports.originalIntegrity().catch(() => 'unverified' as const)
  emit('cleanup', clean ? 'passed' : 'failed', clean ? null : 'CLEANUP_INCOMPLETE')
  const finalized = await lifecycle.finalize({ originalIntegrity: integrity })
  return Object.freeze({ finalized, baseline, candidate, patch, events: Object.freeze([...events]) })
}
