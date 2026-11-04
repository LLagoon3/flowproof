// T031: isolated synthetic image + strict-schema protocol gate for the project-live Meta client.
//
// Opt-in only: `pnpm test:project-meta-smoke` (the explicit `project-meta-smoke` Vitest project).
// Default discovery never reaches this file (see tests/integration/project-live-discovery.test.ts).
// It is the final-live-acceptance protocol check (T053), not a default test: it sends one real
// analysis request containing one synthetic solid-colour PNG through the production client and
// asserts the actual requested/observed model, a validated response ID, strict closed output and
// that the answer reflects the image pixels (the colour is stated nowhere in the text context).
// A missing key, quota, image or schema failure FAILS this gate as a blocker; it never skips or
// passes on a fixture. Only safe invocation fields are printed; never the key, prompt or body.
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { RedactedValueRegistry } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import { createProjectModelSession } from '../../packages/flowproof/src/model/projectClient.js'
import { buildProjectAnalysisPrompt } from '../../packages/flowproof/src/model/projectPrompt.js'
import { ProviderInvocationSchema, newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'

const BLOCKER = 'T031 BLOCKER: MODEL_API_KEY is not set in the host environment, so no live Meta request was made.'

function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

function syntheticPrompt() {
  const run = newProjectUuid()
  const capture = newProjectUuid()
  const image = newProjectUuid()
  const artifact = newProjectUuid()
  const revision = 'c'.repeat(40)
  const bytes = solidPng(320, 200, [255, 0, 0])
  const observation = {
    observation_id: image,
    run_id: run,
    capture_id: capture,
    baseline_commit: revision,
    phase: 'demonstration',
    type: 'image',
    availability: 'available',
    reason: null,
    sequence_range: { first: 1, last: 1 },
    policy_version: 'project-privacy-v1',
    redaction_count: 0,
    payload: {
      viewport: { width: 1280, height: 800 },
      clip: { x: 0, y: 0, width: 320, height: 200 },
      mask_count: 0,
      masked_before_retention: true,
      build_sha256: 'd'.repeat(64),
      artifact: { artifact_id: artifact, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, media_type: 'image/png' },
    },
  }
  const sealedCapture = {
    schema_version: 1,
    capture_id: capture,
    run_id: run,
    project_id: newProjectUuid(),
    baseline_commit: revision,
    configuration_id: newProjectUuid(),
    configuration_digest: 'e'.repeat(64),
    target_origin: 'http://localhost:41234',
    viewport: { width: 1280, height: 800, device_scale_factor: 1 },
    state: 'ready',
    document_epoch: 0,
    interactions: [
      {
        sequence: 1,
        capture_id: capture,
        document_epoch: 0,
        frame_id: newProjectUuid(),
        offset_ms: 100,
        action: { type: 'click', locators: [{ kind: 'test-id', value: 'status-banner' }] },
        related_observation_ids: [image],
      },
    ],
    observations: [observation],
    counters: { unavailable: 0, unsupported: 0, dropped: 0 },
    completeness: { status: 'complete', reasons: [] },
    timing: { started_offset_ms: 0, finished_offset_ms: 200 },
    staged_bytes: bytes.length,
    seal: { report_sha256: 'f'.repeat(64) },
  }
  const built = buildProjectAnalysisPrompt({
    run_id: run,
    invocation_id: newProjectUuid(),
    question_id: newProjectUuid(),
    capture: sealedCapture as never,
    description: 'After clicking the status banner, it shows the wrong colour. Describe which colour the screenshot shows.',
    sources: [{ path: 'src/banner.ts', content: "export const bannerTone = 'tone-a'\n" }],
    admitted_source_paths: new Set(['src/banner.ts']),
    images: new Map([[artifact, bytes]]),
    registry: new RedactedValueRegistry(),
  })
  if (!built.ok) throw new Error(`synthetic prompt invalid: ${built.error.code}`)
  return { run, image, prompt: built.value }
}

describe('project-live Meta image + strict-schema protocol gate (T031, opt-in)', () => {
  it('interprets an actual image through the production client with validated model and response identity', { timeout: 120_000 }, async () => {
    const key = process.env.MODEL_API_KEY?.trim()
    if (!key) throw new Error(BLOCKER)
    const { run, image, prompt } = syntheticPrompt()
    expect(prompt.manifest.included_image_ids).toEqual([image])
    const session = createProjectModelSession({ run_id: run, env: { MODEL_API_KEY: key } })
    expect(session.transport).toBe('meta')
    const result = await session.analyze(prompt)
    const invocation = result.invocation
    console.info(
      '[project-meta-smoke]',
      JSON.stringify(invocation && { status: invocation.status, error_code: invocation.error_code, http_status: invocation.http_status, observed_model: invocation.observed_model, response_id_present: invocation.response_id !== null, latency_ms: invocation.latency_ms }),
    )
    expect(result.ok ? 'OK' : result.error.code).toBe('OK')
    if (!result.ok) return
    expect(ProviderInvocationSchema.safeParse(invocation).success).toBe(true)
    expect(result.invocation).toMatchObject({ transport: 'meta', status: 'completed', requested_model: 'muse-spark-1.3', observed_model: 'muse-spark-1.3', input_sha256: prompt.manifest.input_sha256 })
    expect(result.invocation.response_id).toMatch(/^[A-Za-z0-9._:-]{1,256}$/)
    expect(result.invocation.included_image_ids).toEqual([image])
    const output = result.output
    const prose = output.status === 'ready' ? `${output.observed_problem} ${output.support_explanation}` : output.status === 'clarify' ? output.observed_facts : output.explanation
    expect(prose).toMatch(/\b(red|crimson|scarlet)\b/i)
  })
})
