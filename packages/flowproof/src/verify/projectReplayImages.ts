import type { Page } from 'playwright'

import { DEFAULT_PRIVACY_POLICY, captureMaskedTargetImage } from '../capture/projectPrivacy.js'
import type { ProjectPrivacyPolicy, RedactedValueRegistry } from '../capture/projectPrivacy.js'
import { PROJECT_PRIVACY_POLICY_VERSION, newProjectUuid } from '../project/contracts.js'
import type { SafeObservation } from '../project/contracts.js'
import type { ReplayCheckpoint, ReplayEvidenceCollector, ReplayPhaseBinding } from './projectReplay.js'

// Production replay evidence (T036/T038/T041): genuine masked PNGs of the actual private replay
// page, produced by the unchanged capture privacy guard on the top-level target frame (clip at the
// viewport origin), bound to the phase binding's run, phase and build. Bytes stay host-side for the
// correction prompt; nothing here is synthetic or uploaded by a browser.

export interface ReplayImageEvidence extends ReplayEvidenceCollector {
  /** Retained masked PNG bytes by observation ID (host-only; never logged). */
  images(): ReadonlyMap<string, Uint8Array>
  /** Every observation produced so far, in checkpoint order. */
  observations(): readonly SafeObservation[]
  dispose(): Promise<void>
}

export function createReplayImageCollector(input: {
  readonly page: Page
  readonly binding: ReplayPhaseBinding
  readonly baselineCommit: string
  readonly registry: RedactedValueRegistry
  readonly policy?: ProjectPrivacyPolicy
}): ReplayImageEvidence {
  const { page, binding, baselineCommit, registry } = input
  const policy = input.policy ?? DEFAULT_PRIVACY_POLICY
  const observations: SafeObservation[] = []
  const bytes = new Map<string, Uint8Array>()
  let pending: Promise<void> = Promise.resolve()
  let disposed = false

  const record = async (point: ReplayCheckpoint): Promise<void> => {
    if (disposed) return
    const observationId = newProjectUuid()
    const common = {
      observation_id: observationId,
      run_id: binding.run_id,
      capture_id: null,
      baseline_commit: baselineCommit,
      phase: binding.phase,
      type: 'image' as const,
      sequence_range: point.kind === 'action' ? { first: point.action_index + 1, last: point.action_index + 1 } : null,
      policy_version: PROJECT_PRIVACY_POLICY_VERSION,
    }
    let outcome: Awaited<ReturnType<typeof captureMaskedTargetImage>>
    try {
      outcome = await captureMaskedTargetImage({ page, frame: page.mainFrame(), targetOrigin: binding.target_origin, policy, registry })
    } catch {
      outcome = { ok: false, availability: 'unavailable', reason: 'IMAGE_CAPTURE_FAILED', effect: 'unavailable' }
    }
    if (disposed) {
      if (outcome.ok) outcome.image.png.fill(0)
      return
    }
    if (!outcome.ok) {
      observations.push({ ...common, availability: outcome.availability, reason: outcome.reason, redaction_count: 0, payload: null } as unknown as SafeObservation)
      return
    }
    const image = outcome.image
    bytes.set(observationId, new Uint8Array(image.png))
    observations.push({
      ...common,
      availability: 'available',
      reason: null,
      redaction_count: 0,
      payload: {
        viewport: { width: image.viewport.width, height: image.viewport.height, device_scale_factor: 1 },
        clip: image.clip,
        mask_count: image.mask_count,
        masked_before_retention: true,
        build_sha256: binding.build_sha256,
        artifact: { artifact_id: observationId, sha256: image.sha256, bytes: image.bytes, media_type: 'image/png' },
      },
    } as unknown as SafeObservation)
  }

  return {
    available: (type) => type === 'image',
    checkpoint: (point) => {
      pending = pending.then(() => record(point))
      return pending
    },
    drain: async () => {
      await pending
      return observations.map((observation) => structuredClone(observation))
    },
    images: () => bytes,
    observations: () => observations,
    dispose: async () => {
      await pending.catch(() => undefined)
      disposed = true
    },
  }
}
