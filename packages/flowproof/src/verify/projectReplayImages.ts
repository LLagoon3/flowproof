import type { Page } from 'playwright'

import { DEFAULT_PRIVACY_POLICY, captureMaskedTargetImage, sanitizeErrorText } from '../capture/projectPrivacy.js'
import type { ProjectPrivacyPolicy, RedactedValueRegistry } from '../capture/projectPrivacy.js'
import { PROJECT_LIMITS, PROJECT_PRIVACY_POLICY_VERSION, newProjectUuid, projectDigest } from '../project/contracts.js'
import type { SafeObservation } from '../project/contracts.js'
import type { ReplayCheckpoint, ReplayEvidenceCollector, ReplayPhaseBinding } from './projectReplay.js'

// Production replay evidence (T036/T038/T041): genuine masked PNGs of the actual private replay
// page, produced by the unchanged capture privacy guard on the top-level target frame (clip at the
// viewport origin), bound to the phase binding's run, phase and build. Bytes stay host-side for the
// correction prompt; nothing here is synthetic or uploaded by a browser. Console and page errors of
// the private page are sanitized through the capture privacy sanitizer and coalesced by the same
// fingerprint as the recorder; crossing the error budget fails the drain closed rather than
// presenting incomplete error evidence as "no error". Network errors are not collected here, so a
// `no-error` network condition stays unevaluable.

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
  let errorBytes = 0
  let errorOverflow = false
  const fingerprints = new Set<string>()
  const recordError = (type: 'console' | 'page-error', raw: string, level: 'error' | 'warning' | null): void => {
    if (disposed || errorOverflow) return
    const sanitized = sanitizeErrorText(raw, registry)
    const message = sanitized.message
    const fingerprint = projectDigest({ type, level, message })
    if (fingerprints.has(fingerprint)) return
    const size = Buffer.byteLength(message, 'utf8')
    if (errorBytes + size > PROJECT_LIMITS.maxErrorSummaryBytes || observations.length >= PROJECT_LIMITS.maxObservations) {
      errorOverflow = true
      return
    }
    errorBytes += size
    fingerprints.add(fingerprint)
    observations.push({
      observation_id: newProjectUuid(),
      run_id: binding.run_id,
      capture_id: null,
      baseline_commit: baselineCommit,
      phase: binding.phase,
      type,
      availability: 'available',
      reason: null,
      sequence_range: null,
      redaction_count: sanitized.redactions,
      policy_version: PROJECT_PRIVACY_POLICY_VERSION,
      payload: type === 'console' ? { level, message, fingerprint } : { message, fingerprint },
    } as unknown as SafeObservation)
  }
  page.on('console', (message) => {
    const kind = message.type()
    if (kind === 'error' || kind === 'warning') recordError('console', message.text(), kind)
  })
  page.on('pageerror', (error) => recordError('page-error', String(error?.message ?? error), null))

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
    available: (type) => type === 'image' || type === 'console' || type === 'page-error',
    checkpoint: (point) => {
      pending = pending.then(() => record(point))
      return pending
    },
    drain: async () => {
      await pending
      if (errorOverflow) throw new Error('ERROR_SUMMARY_LIMIT_EXCEEDED')
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
