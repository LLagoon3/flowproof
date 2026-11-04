// Shared explicitly labelled demonstration fakes for T029 service and route tests. `TestRecorder`
// stands in for the launcher-owned recorder (label `test_recorder`); it never claims a browser capture.
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

import { RedactedValueRegistry } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import type { SealedCapture } from '../../packages/flowproof/src/capture/projectRecorder.js'
import { newProjectUuid } from '../../packages/flowproof/src/project/contracts.js'
import type { DemonstrationRecorder } from '../../packages/flowproof/src/project/run.js'

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

export function png(width: number, height: number): Buffer {
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
  header[9] = 6
  const pixels = Buffer.alloc(height * (1 + width * 4), 0x40)
  for (let y = 0; y < height; y += 1) pixels[y * (1 + width * 4)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export const IMAGE_BYTES = png(8, 6)
export const REVISION = 'b'.repeat(40)
export const PROJECT = newProjectUuid()
export const CONFIGURATION = newProjectUuid()
export const FRAME = newProjectUuid()
export const SECRET = 'harbor-lamp-4821'
export const SOURCES = [{ path: 'src/tasks.ts', content: 'export const visible = (tasks: string[]) => tasks\n' }]

/** Explicitly labelled stand-in for the launcher-owned recorder; it never claims a browser capture. */
export class TestRecorder implements DemonstrationRecorder {
  readonly label = 'test_recorder'
  readonly captureId = newProjectUuid()
  readonly image = newProjectUuid()
  readonly artifact = newProjectUuid()
  readonly registry = new RedactedValueRegistry()
  state: 'recording' | 'finished' | 'discarded' = 'recording'
  claimed = false
  #sealed: Promise<SealedCapture> | null = null

  constructor(
    readonly runId: string,
    readonly options: { readonly incomplete?: boolean; readonly configurationId?: string; readonly finishGate?: Promise<void>; readonly claimGate?: Promise<void> } = {},
  ) {}

  finish(): Promise<SealedCapture> {
    this.#sealed ??= (async () => {
      await this.options.finishGate
      const sealed = this.#seal()
      if (this.state !== 'discarded') this.state = 'finished'
      return sealed
    })()
    return this.#sealed
  }

  async discard(): Promise<void> {
    if (this.claimed) throw new Error('CAPTURE_SUBMITTED')
    this.state = 'discarded'
  }

  async detach(): Promise<void> {}

  async claim(): Promise<{ readonly sealed: SealedCapture; readonly registry: RedactedValueRegistry }> {
    await this.options.claimGate
    if (this.state !== 'finished' || this.options.incomplete) throw new Error('CAPTURE_NOT_READY')
    this.claimed = true
    return { sealed: await this.finish(), registry: this.registry }
  }

  #seal(): SealedCapture {
    const ready = this.options.incomplete !== true
    const report = sha256(`report:${this.captureId}`)
    const capture = {
      schema_version: 1,
      capture_id: this.captureId,
      run_id: this.runId,
      project_id: PROJECT,
      baseline_commit: REVISION,
      configuration_id: this.options.configurationId ?? CONFIGURATION,
      configuration_digest: 'c'.repeat(64),
      target_origin: 'http://localhost:41234',
      viewport: { width: 1280, height: 800, device_scale_factor: 1 },
      state: ready ? 'ready' : 'incomplete',
      document_epoch: 0,
      interactions: [
        {
          sequence: 1,
          capture_id: this.captureId,
          document_epoch: 0,
          frame_id: FRAME,
          offset_ms: 100,
          action: { type: 'fill', locators: [{ kind: 'test-id', value: 'search' }], value: { kind: 'safe', text: 'open' } },
          related_observation_ids: [this.image],
        },
      ],
      observations: [
        {
          observation_id: this.image,
          run_id: this.runId,
          capture_id: this.captureId,
          baseline_commit: REVISION,
          phase: 'demonstration',
          type: 'image',
          availability: 'available',
          reason: null,
          sequence_range: { first: 1, last: 1 },
          policy_version: 'project-privacy-v1',
          redaction_count: 0,
          payload: {
            viewport: { width: 1280, height: 800 },
            clip: { x: 0, y: 0, width: 640, height: 400 },
            mask_count: 0,
            masked_before_retention: true,
            build_sha256: 'd'.repeat(64),
            artifact: { artifact_id: this.artifact, sha256: sha256(IMAGE_BYTES), bytes: IMAGE_BYTES.length, media_type: 'image/png' },
          },
        },
      ],
      counters: { unavailable: 0, unsupported: 0, dropped: 0 },
      completeness: ready ? { status: 'complete', reasons: [] } : { status: 'incomplete', reasons: ['IMAGE_LIMIT_EXCEEDED'] },
      timing: { started_offset_ms: 0, finished_offset_ms: 200 },
      staged_bytes: IMAGE_BYTES.length,
      seal: ready ? { report_sha256: report } : null,
    }
    return { capture: capture as never, report_sha256: report, artifacts: new Map([[this.artifact, IMAGE_BYTES]]) }
  }
}

