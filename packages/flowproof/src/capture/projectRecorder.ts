import { randomBytes } from 'node:crypto'
import type { Frame, Page, Request, Response } from 'playwright'
import { z } from 'zod'

import { canonicalJson } from '../evidence/store.js'
import {
  HTTP_METHODS,
  PROJECT_LIMITS,
  PROJECT_PRIVACY_POLICY_VERSION,
  PROJECT_SCHEMA_VERSION,
  canTransitionCapture,
  entryPathSchema,
  newProjectUuid,
  parseDemonstrationCapture,
  parseInteractionObservation,
  projectDigest,
  projectUuidSchema,
} from '../project/contracts.js'
import type { CaptureState, DemonstrationCapture, InteractionObservation, SafeObservation } from '../project/contracts.js'
import {
  DEFAULT_PRIVACY_POLICY,
  RedactedValueRegistry,
  admitFillValue,
  admitSelectValue,
  captureMaskedTargetImage,
  classifyField,
  locatorCandidates,
  sanitizeErrorText,
  sanitizeNavigation,
} from './projectPrivacy.js'
import type { ElementDescriptor, FieldDescriptor, ProjectPrivacyPolicy, TargetImageOutcome } from './projectPrivacy.js'

// Project-live demonstration recorder (specs/006-project-live-verification, FR-004/FR-018 and the
// capture-and-replay contract). Two layers:
//
// - `ProjectCaptureSession` is the host authority. It accepts recorder envelopes only from the
//   admitted target frame and origin, binds them to host-tracked document epochs, rejects stale,
//   unknown, duplicate and out-of-order callbacks, assigns its own contiguous sequence, coalesces
//   typing/scroll bursts without reordering their final effect, flushes pending input before an
//   epoch change and at Finish, sanitizes everything through `projectPrivacy.ts` before staging,
//   and seals one stable report digest. Every loss, unsupported action or crossed limit is counted
//   and named, so a lossy capture can never be `ready`. No timer moves a human capture anywhere.
// - `startProjectRecorder` is the Playwright adapter. It installs target-only instrumentation via
//   a host binding whose source frame Playwright reports, resets the target to its entry, and wires
//   host-observed navigation, detachment, popups, downloads and target-origin request failures.
//
// Capture never contacts a model, and a recorded event cannot prove a hostile page did not
// synthesize it: the target is untrusted, so the host admits only bounded, sanitized structure.

export const RECORDER_PROTOCOL_VERSION = 1
/** Start, end and one sampling disclosure are reserved inside the 16-image cap. */
export const RECORDER_IMAGE_BUDGET = Object.freeze({ actions: PROJECT_LIMITS.maxImages - 3 })
/** Bounds the automatic Finish drain round trip; it is not a human deadline. */
export const FINISH_DRAIN_TIMEOUT_MS = 5_000
/** Bounds the automatic entry reset at Start. */
const START_RESET_TIMEOUT_MS = 30_000
/** Bounds the automatic wait for a new target document before its image. */
const IMAGE_LOAD_TIMEOUT_MS = 5_000
const MAX_REASONS = 16
const MAX_EPOCH = 10_000

export type RecorderErrorCode =
  | 'CAPTURE_STATE_INVALID'
  | 'CAPTURE_TARGET_INVALID'
  | 'CAPTURE_INSTRUMENTATION_UNAVAILABLE'
  | 'CAPTURE_DISCARDED'
  | 'CAPTURE_SUBMITTED'
  | 'CAPTURE_NOT_READY'
  | 'CAPTURE_CONTRACT_INVALID'

/** A recorder failure with a stable code; messages never echo page content. */
export class ProjectRecorderError extends Error {
  readonly code: RecorderErrorCode

  constructor(code: RecorderErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ProjectRecorderError'
    this.code = code
  }
}

/** Host-owned identity a capture is bound to. */
export interface CaptureBinding {
  readonly run_id: string
  readonly project_id: string
  readonly baseline_commit: string
  readonly configuration_id: string
  readonly configuration_digest: string
  readonly target_origin: string
  readonly viewport: { readonly width: number; readonly height: number; readonly device_scale_factor: 1 }
  /** Actual target build identity when known; bound into every image observation. */
  readonly build_sha256: string | null
}

/** Where a recorder callback came from, as determined by the host from Playwright's binding source. */
export interface RecorderSource {
  readonly frameId: string
  readonly origin: string
  readonly relation: 'target' | 'descendant' | 'foreign'
}

export interface TargetImageSource {
  capture(registry: RedactedValueRegistry): Promise<TargetImageOutcome>
}

export interface CaptureCollectors {
  readonly console: boolean
  readonly pageErrors: boolean
  readonly network: boolean
}

export interface CaptureSessionOptions {
  readonly binding: CaptureBinding
  /** Host-generated identity of the admitted target frame. */
  readonly frameId: string
  readonly policy?: ProjectPrivacyPolicy
  /** Monotonic milliseconds; ordering offsets only, never a deadline. */
  readonly clock?: () => number
  /** `null` discloses an unavailable image collector. */
  readonly images?: TargetImageSource | null
  readonly collectors?: CaptureCollectors
}

/** Host-observed events that do not come through the page recorder. */
export type HostCaptureEvent =
  | { readonly kind: 'network'; readonly method: string; readonly url: string; readonly status: number | null; readonly failure: string | null }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'dropped'; readonly reason: string }

export type IngestOutcome = 'accepted' | 'coalesced' | 'ignored' | 'rejected' | 'dropped' | 'unsupported'

export interface DrainResult {
  readonly ok: boolean
  /** The host's current target frame URL after the drain round trip. */
  readonly hostUrl: string | null
}

export interface SealedCapture {
  readonly capture: DemonstrationCapture
  readonly report_sha256: string
  /** Masked PNG bytes by artifact ID; cleared (zeroed) by Discard. */
  readonly artifacts: ReadonlyMap<string, Buffer>
}

export interface CaptureStatus {
  readonly state: CaptureState
  readonly epoch: number
  readonly sequence: number
  readonly counters: { readonly unavailable: number; readonly unsupported: number; readonly dropped: number }
  /** Live, precise incompleteness/unsupported reasons, shown while still recording. */
  readonly reasons: readonly string[]
  readonly artifactIds: readonly string[]
}

// ---------------------------------------------------------------------------------------
// Untrusted recorder envelope
// ---------------------------------------------------------------------------------------

const text = (max: number) => z.string().max(max)
const ElementSchema = z.strictObject({
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  testId: text(256).nullable(),
  role: text(32).nullable(),
  name: text(1_024).nullable(),
  id: text(256).nullable(),
  css: text(512).nullable(),
  private: z.boolean(),
})
const FieldSchema = z.strictObject({
  type: text(32).nullable(),
  autocomplete: text(256).nullable(),
  name: text(256).nullable(),
  label: text(1_024).nullable(),
  placeholder: text(1_024).nullable(),
})
const href = z.string().min(1).max(4_096)
const PAGE_UNSUPPORTED = [
  'DRAG_DROP',
  'FILE_UPLOAD',
  'CANVAS_GESTURE',
  'KEYBOARD_SHORTCUT',
  'KEYBOARD_KEY',
  'CONTENTEDITABLE_EDIT',
  'INPUT_TYPE_UNSUPPORTED',
  'FORM_SUBMIT_UNSUPPORTED',
  'NESTED_FRAME',
] as const
const EventSchema = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('hello'), href }),
  z.strictObject({ k: z.literal('url'), href }),
  z.strictObject({ k: z.literal('click'), el: ElementSchema }),
  z.strictObject({ k: z.literal('input'), el: ElementSchema, field: FieldSchema, value: text(4_096).nullable(), commit: z.boolean() }),
  z.strictObject({ k: z.literal('select'), el: ElementSchema, field: FieldSchema, value: text(4_096).nullable(), multiple: z.boolean() }),
  z.strictObject({ k: z.literal('scroll'), el: ElementSchema.nullable(), x: z.number().finite(), y: z.number().finite() }),
  z.strictObject({ k: z.literal('console'), level: z.enum(['error', 'warning']), message: text(8_192) }),
  z.strictObject({ k: z.literal('pageerror'), message: text(8_192) }),
  z.strictObject({ k: z.literal('unsupported'), reason: z.enum(PAGE_UNSUPPORTED) }),
])
const HeaderSchema = z.object({ v: z.literal(RECORDER_PROTOCOL_VERSION), token: projectUuidSchema, n: z.int().min(0).max(1_000_000_000) })
const EnvelopeSchema = z.strictObject({ v: z.literal(RECORDER_PROTOCOL_VERSION), token: projectUuidSchema, n: z.int().min(0).max(1_000_000_000), e: EventSchema })
type RecorderEvent = z.infer<typeof EventSchema>
const INTERACTION_KINDS = new Set(['click', 'input', 'select', 'scroll', 'unsupported'])

type InteractionAction = InteractionObservation['action']
type MutableObservation = SafeObservation
type Pending = { readonly kind: 'fill' | 'scroll'; readonly key: string; action: InteractionAction; offset: number; readonly epoch: number }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** Hashes only a path already accepted by the privacy sanitizer, never an untrusted raw URL. */
function navigationDigest(targetOrigin: string, safePath: string): string {
  return projectDigest({ target_origin: targetOrigin, path: safePath })
}

// ---------------------------------------------------------------------------------------
// Host capture session
// ---------------------------------------------------------------------------------------

export class ProjectCaptureSession {
  readonly captureId: string = newProjectUuid()
  readonly #binding: CaptureBinding
  readonly #frameId: string
  readonly #policy: ProjectPrivacyPolicy
  readonly #clock: () => number
  readonly #images: TargetImageSource | null
  readonly #collectors: CaptureCollectors
  #registry = new RedactedValueRegistry()

  #state: CaptureState = 'idle'
  #generation = 0
  #startedAt = 0
  #lastOffset = 0
  #sequence = 0
  #epoch = 0
  #currentToken: string | null = null
  readonly #documents = new Map<string, { readonly epoch: number; lastN: number }>()
  #lastUrlDigest: string | null = null
  #lastPath: string | null = null
  #lastFill = new Map<string, string>()

  #interactions: InteractionObservation[] = []
  #observations: MutableObservation[] = []
  #fingerprints = new Map<string, number>()
  #artifacts = new Map<string, Buffer>()
  #counters = { unavailable: 0, unsupported: 0, dropped: 0 }
  #reasons: string[] = []
  #pending: Pending | null = null
  #errorBytes = 0
  #jsonBytes = 0
  #artifactBytes = 0
  #registryOverflowReported = false

  #actionImages = 0
  #samplingIndex: number | null = null
  #imageQueue: Promise<void> = Promise.resolve()
  #accepting = false
  #finishPromise: Promise<SealedCapture> | null = null
  #sealed: SealedCapture | null = null
  #submitted = false

  constructor(options: CaptureSessionOptions) {
    this.#binding = Object.freeze({ ...options.binding, viewport: Object.freeze({ ...options.binding.viewport }) })
    this.#frameId = options.frameId
    this.#policy = options.policy ?? DEFAULT_PRIVACY_POLICY
    this.#clock = options.clock ?? (() => performance.now())
    this.#images = options.images === undefined ? null : options.images
    this.#collectors = options.collectors ?? { console: true, pageErrors: true, network: true }
    if (!projectUuidSchema.safeParse(this.#frameId).success) throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'The target frame identity is not host-generated.')
  }

  get state(): CaptureState {
    return this.#state
  }

  status(): CaptureStatus {
    return Object.freeze({
      state: this.#state,
      epoch: this.#epoch,
      sequence: this.#sequence,
      counters: Object.freeze({ ...this.#counters }),
      reasons: Object.freeze([...this.#reasons]),
      artifactIds: Object.freeze([...this.#artifacts.keys()]),
    })
  }

  artifact(id: string): Buffer | undefined {
    return this.#artifacts.get(id)
  }

  /** Resolves once every image requested so far has been produced or explicitly omitted. */
  imagesSettled(): Promise<void> {
    return this.#imageQueue
  }

  /** Starts recording on the entry document announced by the admitted target frame. */
  begin(source: RecorderSource, envelope: unknown): void {
    if (this.#state !== 'idle') throw new ProjectRecorderError('CAPTURE_STATE_INVALID', 'Only an idle capture can begin.')
    if (!this.#isTarget(source)) throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'Recording must begin in the admitted target frame.')
    const parsed = EnvelopeSchema.safeParse(envelope)
    if (!parsed.success || parsed.data.e.k !== 'hello') throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'Recording must begin with the entry document announcement.')
    const entry = sanitizeNavigation(parsed.data.e.href, this.#binding.target_origin, this.#registry)
    if (!entry.ok) throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'The entry document is not an admitted same-origin path.')
    this.#transition('recording')
    this.#startedAt = this.#clock()
    this.#documents.set(parsed.data.token, { epoch: 0, lastN: parsed.data.n })
    this.#currentToken = parsed.data.token
    this.#lastUrlDigest = navigationDigest(this.#binding.target_origin, entry.path)
    this.#lastPath = entry.path
    this.#accepting = true
    const absent: Array<SafeObservation['type']> = []
    if (this.#images === null) absent.push('image')
    if (!this.#collectors.console) absent.push('console')
    if (!this.#collectors.pageErrors) absent.push('page-error')
    if (!this.#collectors.network) absent.push('network-error')
    for (const type of absent) {
      this.#counters.unavailable += 1
      this.#addObservation(type, { availability: 'unavailable', reason: 'COLLECTOR_UNAVAILABLE', payload: null, sequence_range: null, redaction_count: 0 })
    }
    this.#requestImage('start', 0)
  }

  /** Admits one recorder callback. Staging is synchronous so arrival order is preserved. */
  ingest(source: RecorderSource, envelope: unknown): IngestOutcome {
    if (!this.#accepting) return 'ignored'
    if (source.relation === 'descendant' && source.frameId !== this.#frameId) {
      const kind = (envelope as { e?: { k?: unknown } } | null)?.e?.k
      if (typeof kind === 'string' && INTERACTION_KINDS.has(kind)) return this.#unsupported('NESTED_FRAME_UNSUPPORTED')
      return 'ignored'
    }
    if (!this.#isTarget(source)) return 'rejected'

    const header = HeaderSchema.safeParse(envelope)
    if (!header.success) return this.#drop('EVENT_INVALID')
    const document = this.#documents.get(header.data.token)
    const parsed = EnvelopeSchema.safeParse(envelope)
    const event = parsed.success ? parsed.data.e : null

    if (event?.k === 'hello' && document === undefined) return this.#newDocument(header.data.token, header.data.n, event.href)
    if (document === undefined) return this.#drop('EVENT_UNKNOWN_DOCUMENT')
    if (header.data.token !== this.#currentToken) return this.#drop('EVENT_STALE_DOCUMENT')
    if (header.data.n <= document.lastN) return this.#drop('EVENT_ORDER_INVALID')
    const gap = header.data.n > document.lastN + 1
    document.lastN = header.data.n
    if (gap) this.#drop('EVENT_SEQUENCE_GAP')
    if (event === null) return this.#drop('EVENT_INVALID')
    return this.#handle(event, document.epoch)
  }

  /** Admits a host-observed event (network failure, unsupported browser action, detected loss). */
  recordHostEvent(event: HostCaptureEvent): IngestOutcome {
    if (!this.#accepting) return 'ignored'
    switch (event.kind) {
      case 'unsupported':
        return this.#unsupported(event.reason)
      case 'dropped':
        return this.#drop(event.reason)
      case 'network':
        return this.#network(event)
    }
  }

  /**
   * Drains outstanding work and seals the report. `drain` is the adapter's round trip to the
   * target document; callbacks delivered before it resolves still belong to this capture.
   * Duplicate requests share one result and one digest.
   */
  finish(drain?: () => Promise<DrainResult>): Promise<SealedCapture> {
    if (this.#finishPromise) return this.#finishPromise
    if (this.#state === 'discarded') return Promise.reject(new ProjectRecorderError('CAPTURE_DISCARDED', 'A discarded capture cannot be finished.'))
    if (this.#state !== 'recording') return Promise.reject(new ProjectRecorderError('CAPTURE_STATE_INVALID', 'Only a recording capture can be finished.'))
    this.#finishPromise = this.#runFinish(drain)
    return this.#finishPromise
  }

  /** Clears staged and sealed material before analysis and permanently invalidates this capture. */
  discard(): void {
    if (this.#submitted) throw new ProjectRecorderError('CAPTURE_SUBMITTED', 'A report already claimed for analysis cannot be discarded as if never sent.')
    if (this.#state === 'discarded') return
    if (!canTransitionCapture(this.#state, 'discarded')) throw new ProjectRecorderError('CAPTURE_STATE_INVALID', 'This capture cannot be discarded.')
    this.#generation += 1
    this.#accepting = false
    this.#state = 'discarded'
    this.#wipe()
  }

  /** Releases staged bytes of a capture that is no longer needed, whatever its state. */
  dispose(): void {
    this.#generation += 1
    this.#accepting = false
    this.#wipe()
  }

  /** Hands the sealed ready report to explicit analysis; afterwards Discard is refused. */
  claimForAnalysis(): SealedCapture {
    if (this.#state === 'discarded') throw new ProjectRecorderError('CAPTURE_DISCARDED', 'A discarded capture cannot be analyzed.')
    if (this.#state !== 'ready' || this.#sealed === null) throw new ProjectRecorderError('CAPTURE_NOT_READY', 'Only a complete ready capture can be analyzed.')
    this.#submitted = true
    return this.#sealed
  }

  /** The current S1 view: staged while recording, sealed once finished, empty once discarded. */
  snapshot(): DemonstrationCapture {
    if (this.#sealed !== null && this.#state !== 'discarded') return this.#sealed.capture
    const empty = this.#state === 'idle' || this.#state === 'discarded'
    return deepFreeze(
      structuredClone({
        ...this.#body(this.#state, null),
        interactions: empty ? [] : this.#interactions,
        observations: empty ? [] : this.#observations,
        staged_bytes: empty ? 0 : this.#stagedBytes(),
        timing: { started_offset_ms: 0 as const, finished_offset_ms: null },
        seal: null,
      }),
    ) as DemonstrationCapture
  }

  // -------------------------------------------------------------------------------------

  #isTarget(source: RecorderSource): boolean {
    return source.relation === 'target' && source.frameId === this.#frameId && source.origin === this.#binding.target_origin
  }

  #transition(to: CaptureState): void {
    if (!canTransitionCapture(this.#state, to)) throw new ProjectRecorderError('CAPTURE_STATE_INVALID', `Capture cannot move ${this.#state} -> ${to}.`)
    this.#state = to
  }

  #offset(): number {
    const offset = Math.max(this.#lastOffset, Math.round(Math.max(0, this.#clock() - this.#startedAt)))
    this.#lastOffset = offset
    return offset
  }

  #reason(reason: string): void {
    if (this.#reasons.includes(reason)) return
    if (this.#reasons.length < MAX_REASONS - 1) this.#reasons.push(reason)
    else if (!this.#reasons.includes('ADDITIONAL_REASONS')) this.#reasons.push('ADDITIONAL_REASONS')
  }

  #drop(reason: string): IngestOutcome {
    this.#counters.dropped += 1
    this.#reason(reason)
    return 'dropped'
  }

  #unsupported(reason: string): IngestOutcome {
    this.#counters.unsupported += 1
    this.#reason(reason)
    return 'unsupported'
  }

  #checkRegistry(): boolean {
    if (this.#registry.overflowed && !this.#registryOverflowReported) {
      this.#registryOverflowReported = true
      this.#unsupported('PRIVACY_REGISTRY_LIMIT')
    }
    return this.#registry.overflowed
  }

  #newDocument(token: string, n: number, documentHref: string): IngestOutcome {
    this.#flushPending()
    if (this.#epoch >= MAX_EPOCH) return this.#drop('EPOCH_LIMIT_EXCEEDED')
    this.#epoch += 1
    this.#documents.set(token, { epoch: this.#epoch, lastN: n })
    this.#currentToken = token
    return this.#navigate(documentHref, this.#epoch, true)
  }

  #navigate(target: string, epoch: number, newDocument: boolean): IngestOutcome {
    const navigation = sanitizeNavigation(target, this.#binding.target_origin, this.#registry)
    if (!navigation.ok) {
      this.#lastUrlDigest = null
      this.#flushPending()
      this.#lastPath = null
      return this.#unsupported(navigation.reason)
    }
    this.#lastUrlDigest = navigationDigest(this.#binding.target_origin, navigation.path)
    if (!newDocument && navigation.path === this.#lastPath) return 'coalesced'
    this.#flushPending()
    this.#lastPath = navigation.path
    return this.#stage({ type: 'navigate', path: navigation.path }, this.#offset(), epoch, true)
  }

  #handle(event: RecorderEvent, epoch: number): IngestOutcome {
    switch (event.k) {
      case 'hello':
        return this.#drop('EVENT_ORDER_INVALID')
      case 'url':
        return this.#navigate(event.href, epoch, false)
      case 'click': {
        const locators = locatorCandidates(event.el as ElementDescriptor, this.#registry)
        this.#flushPending()
        if (locators.length === 0) return this.#unsupported('ACTION_LOCATOR_UNSAFE')
        return this.#stage({ type: 'click', locators }, this.#offset(), epoch, true)
      }
      case 'input':
        return this.#input(event, epoch)
      case 'select': {
        this.#flushPending()
        const field = this.#field(event.el, event.field)
        if (event.multiple) return this.#unsupported('SELECT_MULTIPLE_UNSUPPORTED')
        if (classifyField(field).kind !== 'select') return this.#unsupported('INPUT_TYPE_UNSUPPORTED')
        const value = admitSelectValue(this.#policy, field, event.value, this.#registry)
        if (this.#checkRegistry()) {
          this.#flushPending()
          return 'unsupported'
        }
        const locators = locatorCandidates(event.el as ElementDescriptor, this.#registry)
        if (locators.length === 0) return this.#unsupported('ACTION_LOCATOR_UNSAFE')
        return this.#stage({ type: 'select', locators, value }, this.#offset(), epoch, true)
      }
      case 'scroll':
        return this.#scroll(event, epoch)
      case 'console':
        if (!this.#collectors.console) return 'ignored'
        return this.#error('console', event.message, event.level)
      case 'pageerror':
        if (!this.#collectors.pageErrors) return 'ignored'
        return this.#error('page-error', event.message, null)
      case 'unsupported':
        this.#flushPending()
        return this.#unsupported(event.reason === 'NESTED_FRAME' ? 'NESTED_FRAME_UNSUPPORTED' : event.reason)
    }
  }

  #field(element: z.infer<typeof ElementSchema>, field: z.infer<typeof FieldSchema>): FieldDescriptor {
    return { tag: element.tag, ...field, private: element.private }
  }

  #input(event: Extract<RecorderEvent, { k: 'input' }>, epoch: number): IngestOutcome {
    const field = this.#field(event.el, event.field)
    const kind = classifyField(field)
    if (kind.kind !== 'text') {
      this.#flushPending()
      return this.#unsupported(kind.kind === 'unsupported' ? kind.reason : 'INPUT_TYPE_UNSUPPORTED')
    }
    const value = admitFillValue(this.#policy, field, event.value, this.#registry)
    if (this.#checkRegistry()) {
      this.#flushPending()
      return 'unsupported'
    }
    const locators = locatorCandidates(event.el as ElementDescriptor, this.#registry)
    if (locators.length === 0) {
      this.#flushPending()
      return this.#unsupported('ACTION_LOCATOR_UNSAFE')
    }
    const key = canonicalJson(locators)
    const action: InteractionAction = { type: 'fill', locators, value }
    const offset = this.#offset()
    let outcome: IngestOutcome
    if (this.#pending?.kind === 'fill' && this.#pending.key === key) {
      this.#pending.action = action
      this.#pending.offset = offset
      outcome = 'coalesced'
    } else if (this.#pending === null && event.commit && this.#lastFill.get(key) === canonicalJson(value)) {
      return 'coalesced'
    } else {
      this.#flushPending()
      this.#pending = { kind: 'fill', key, action, offset, epoch }
      outcome = 'accepted'
    }
    if (event.commit) {
      const flushed = this.#flushPending()
      if (flushed === 'dropped') return 'dropped'
    }
    return outcome
  }

  #scroll(event: Extract<RecorderEvent, { k: 'scroll' }>, epoch: number): IngestOutcome {
    const x = Math.round(event.x)
    const y = Math.round(event.y)
    if (x < 0 || y < 0 || x > 1_000_000 || y > 1_000_000) {
      this.#flushPending()
      return this.#unsupported('SCROLL_UNSUPPORTED')
    }
    let target: Extract<InteractionAction, { type: 'scroll' }>['target']
    if (event.el === null) target = { kind: 'page' }
    else {
      const locators = locatorCandidates(event.el as ElementDescriptor, this.#registry)
      if (locators.length === 0) {
        this.#flushPending()
        return this.#unsupported('ACTION_LOCATOR_UNSAFE')
      }
      target = { kind: 'element', locators }
    }
    const key = canonicalJson(target)
    const action: InteractionAction = { type: 'scroll', target, x, y }
    const offset = this.#offset()
    if (this.#pending?.kind === 'scroll' && this.#pending.key === key) {
      this.#pending.action = action
      this.#pending.offset = offset
      return 'coalesced'
    }
    this.#flushPending()
    this.#pending = { kind: 'scroll', key, action, offset, epoch }
    return 'accepted'
  }

  #flushPending(): IngestOutcome | null {
    const pending = this.#pending
    if (pending === null) return null
    this.#pending = null
    if (pending.kind === 'fill' && pending.action.type === 'fill') this.#lastFill.set(pending.key, canonicalJson(pending.action.value))
    return this.#stage(pending.action, pending.offset, pending.epoch, false)
  }

  #stage(action: InteractionAction, offset: number, epoch: number, image: boolean): IngestOutcome {
    if (this.#interactions.length >= PROJECT_LIMITS.maxActions) return this.#drop('ACTION_LIMIT_EXCEEDED')
    const interaction = {
      sequence: this.#sequence + 1,
      capture_id: this.captureId,
      document_epoch: epoch,
      frame_id: this.#frameId,
      offset_ms: Math.max(offset, this.#interactions.at(-1)?.offset_ms ?? 0),
      action,
      related_observation_ids: [] as string[],
    }
    const parsed = parseInteractionObservation(interaction)
    if (!parsed.ok) return this.#drop('ACTION_INVALID')
    const bytes = Buffer.byteLength(canonicalJson(interaction))
    if (this.#stagedBytes() + bytes > PROJECT_LIMITS.maxStagedReportBytes) return this.#drop('STAGED_REPORT_LIMIT_EXCEEDED')
    this.#sequence += 1
    this.#jsonBytes += bytes
    this.#interactions.push(interaction)
    if (image) this.#requestImage('action', interaction.sequence)
    return 'accepted'
  }

  #stagedBytes(): number {
    return this.#jsonBytes + this.#artifactBytes
  }

  #addObservation(
    type: SafeObservation['type'],
    fields: Pick<SafeObservation, 'availability' | 'reason' | 'sequence_range' | 'redaction_count'> & { readonly payload: unknown },
  ): string | null {
    if (this.#observations.length >= PROJECT_LIMITS.maxObservations) {
      this.#drop('OBSERVATION_LIMIT_EXCEEDED')
      return null
    }
    const observation = {
      observation_id: newProjectUuid(),
      run_id: this.#binding.run_id,
      capture_id: this.captureId,
      baseline_commit: this.#binding.baseline_commit,
      phase: 'demonstration' as const,
      type,
      ...fields,
      policy_version: PROJECT_PRIVACY_POLICY_VERSION,
    } as MutableObservation
    const bytes = Buffer.byteLength(canonicalJson(observation))
    if (this.#stagedBytes() + bytes > PROJECT_LIMITS.maxStagedReportBytes) {
      this.#drop('STAGED_REPORT_LIMIT_EXCEEDED')
      return null
    }
    this.#jsonBytes += bytes
    this.#observations.push(observation)
    return observation.observation_id
  }

  #currentRange(): { first: number; last: number } | null {
    return this.#sequence > 0 ? { first: this.#sequence, last: this.#sequence } : null
  }

  #extendRange(index: number): void {
    const observation = this.#observations[index]
    if (!observation) return
    const range = observation.sequence_range
    if (range === null) observation.sequence_range = this.#currentRange()
    else if (this.#sequence > range.last) observation.sequence_range = { first: range.first, last: this.#sequence }
  }

  #error(type: 'console' | 'page-error', raw: string, level: 'error' | 'warning' | null): IngestOutcome {
    const sanitized = sanitizeErrorText(raw, this.#registry)
    const message = sanitized.message
    const fingerprint = projectDigest({ type, level, message })
    const known = this.#fingerprints.get(fingerprint)
    if (known !== undefined) {
      this.#extendRange(known)
      return 'coalesced'
    }
    const bytes = Buffer.byteLength(message, 'utf8')
    if (this.#errorBytes + bytes > PROJECT_LIMITS.maxErrorSummaryBytes) return this.#drop('ERROR_SUMMARY_LIMIT_EXCEEDED')
    const payload = type === 'console' ? { level, message, fingerprint } : { message, fingerprint }
    const id = this.#addObservation(type, { availability: 'available', reason: null, payload, sequence_range: this.#currentRange(), redaction_count: sanitized.redactions })
    if (id === null) return 'dropped'
    this.#errorBytes += bytes
    this.#fingerprints.set(fingerprint, this.#observations.length - 1)
    return 'accepted'
  }

  #network(event: Extract<HostCaptureEvent, { kind: 'network' }>): IngestOutcome {
    if (!this.#collectors.network) return 'ignored'
    const omit = (reason: string): IngestOutcome => {
      const key = projectDigest({ type: 'network-error', omitted: reason })
      const known = this.#fingerprints.get(key)
      if (known !== undefined) {
        this.#extendRange(known)
        return 'coalesced'
      }
      const id = this.#addObservation('network-error', { availability: 'omitted', reason, payload: null, sequence_range: this.#currentRange(), redaction_count: 1 })
      if (id === null) return 'dropped'
      this.#fingerprints.set(key, this.#observations.length - 1)
      return 'accepted'
    }
    let url: URL
    try {
      url = new URL(event.url)
    } catch {
      return omit('NETWORK_URL_INVALID')
    }
    if (url.origin !== this.#binding.target_origin || url.username !== '' || url.password !== '') return omit('NETWORK_CROSS_ORIGIN')
    const path = url.pathname
    if (!entryPathSchema.safeParse(path).success || this.#registry.contains(path)) return omit('NETWORK_PATH_UNSAFE')
    const method = event.method.toUpperCase()
    if (!(HTTP_METHODS as readonly string[]).includes(method)) return omit('NETWORK_METHOD_UNSUPPORTED')
    const status = event.status !== null && Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null
    let errorClass = 'HTTP_ERROR'
    if (event.failure !== null) {
      const code = `NET_${event.failure.replace(/^net::/i, '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 64)
      errorClass = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'NET_FAILED'
    }
    const fingerprint = projectDigest({ type: 'network-error', method, path, status, error_class: errorClass })
    const known = this.#fingerprints.get(fingerprint)
    if (known !== undefined) {
      this.#extendRange(known)
      return 'coalesced'
    }
    const bytes = Buffer.byteLength(`${method} ${path} ${status ?? ''} ${errorClass}`, 'utf8')
    if (this.#errorBytes + bytes > PROJECT_LIMITS.maxErrorSummaryBytes) return this.#drop('ERROR_SUMMARY_LIMIT_EXCEEDED')
    const redactions = url.search !== '' || url.hash !== '' ? 1 : 0
    const id = this.#addObservation('network-error', {
      availability: 'available',
      reason: null,
      payload: { method, path, status, error_class: errorClass, fingerprint },
      sequence_range: this.#currentRange(),
      redaction_count: redactions,
    })
    if (id === null) return 'dropped'
    this.#errorBytes += bytes
    this.#fingerprints.set(fingerprint, this.#observations.length - 1)
    return 'accepted'
  }

  #requestImage(kind: 'start' | 'action' | 'end', trigger: number): void {
    const images = this.#images
    if (images === null) return
    if (kind === 'action') {
      if (this.#actionImages >= RECORDER_IMAGE_BUDGET.actions) {
        // Disclosed sampling, not loss: one omitted observation spans the actions without images.
        if (this.#samplingIndex === null) {
          const id = this.#addObservation('image', { availability: 'omitted', reason: 'IMAGE_SAMPLING_LIMIT', payload: null, sequence_range: { first: trigger, last: trigger }, redaction_count: 0 })
          if (id !== null) this.#samplingIndex = this.#observations.length - 1
        } else this.#extendRange(this.#samplingIndex)
        return
      }
      this.#actionImages += 1
    }
    const generation = this.#generation
    this.#imageQueue = this.#imageQueue.then(async () => {
      if (generation !== this.#generation) return
      let outcome: TargetImageOutcome
      try {
        outcome = await images.capture(this.#registry)
      } catch {
        outcome = { ok: false, availability: 'unavailable', reason: 'IMAGE_CAPTURE_FAILED', effect: 'unavailable' }
      }
      if (generation !== this.#generation) {
        if (outcome.ok) outcome.image.png.fill(0)
        return
      }
      this.#registerImage(outcome, kind, trigger)
    })
  }

  #registerImage(outcome: TargetImageOutcome, kind: 'start' | 'action' | 'end', trigger: number): void {
    const range = kind === 'start' ? null : kind === 'end' ? this.#currentRange() : { first: trigger, last: Math.max(trigger, this.#sequence) }
    if (outcome.ok && this.#registry.overflowed) {
      outcome.image.png.fill(0)
      outcome = { ok: false, availability: 'omitted', reason: 'IMAGE_TEXT_UNVERIFIED', effect: 'unsupported' }
    }
    if (!outcome.ok) {
      if (outcome.effect === 'unsupported') this.#unsupported(outcome.reason)
      else if (outcome.effect === 'dropped') this.#drop(outcome.reason)
      else this.#counters.unavailable += 1
      this.#addObservation('image', { availability: outcome.availability, reason: outcome.reason, payload: null, sequence_range: range, redaction_count: 0 })
      return
    }
    const image = outcome.image
    if (image.bytes !== image.png.length || image.bytes > PROJECT_LIMITS.maxImageBytes) {
      image.png.fill(0)
      this.#drop('IMAGE_BYTES_LIMIT')
      this.#addObservation('image', { availability: 'omitted', reason: 'IMAGE_BYTES_LIMIT', payload: null, sequence_range: range, redaction_count: 0 })
      return
    }
    if (this.#stagedBytes() + image.bytes > PROJECT_LIMITS.maxStagedReportBytes) {
      image.png.fill(0)
      this.#drop('STAGED_REPORT_LIMIT_EXCEEDED')
      return
    }
    const artifactId = newProjectUuid()
    const id = this.#addObservation('image', {
      availability: 'available',
      reason: null,
      payload: {
        viewport: { ...image.viewport },
        clip: { ...image.clip },
        mask_count: image.mask_count,
        masked_before_retention: true,
        build_sha256: this.#binding.build_sha256,
        artifact: { artifact_id: artifactId, sha256: image.sha256, bytes: image.bytes, media_type: 'image/png' },
      },
      sequence_range: range,
      redaction_count: image.mask_count,
    })
    if (id === null) {
      image.png.fill(0)
      return
    }
    this.#artifacts.set(artifactId, image.png)
    this.#artifactBytes += image.bytes
    if (kind === 'action') {
      const interaction = this.#interactions.find((candidate) => candidate.sequence === trigger)
      if (interaction && interaction.related_observation_ids.length < 8) (interaction.related_observation_ids as string[]).push(id)
    }
  }

  #assertLive(generation: number): void {
    if (generation !== this.#generation || this.#state === 'discarded') throw new ProjectRecorderError('CAPTURE_DISCARDED', 'The capture was discarded before it was sealed.')
  }

  async #runFinish(drain: (() => Promise<DrainResult>) | undefined): Promise<SealedCapture> {
    const generation = this.#generation
    this.#transition('finishing')
    let drained: DrainResult = { ok: true, hostUrl: null }
    if (drain) {
      try {
        drained = await drain()
      } catch {
        drained = { ok: false, hostUrl: null }
      }
    }
    this.#assertLive(generation)
    this.#accepting = false
    if (!drained.ok) this.#drop('FINISH_DRAIN_FAILED')
    else if (drained.hostUrl !== null) {
      let origin: string | null = null
      try {
        origin = new URL(drained.hostUrl).origin
      } catch {
        origin = null
      }
      if (origin !== this.#binding.target_origin) this.#unsupported('NAVIGATION_CROSS_ORIGIN')
      else {
        const navigation = sanitizeNavigation(drained.hostUrl, this.#binding.target_origin, this.#registry)
        if (!navigation.ok) this.#unsupported(navigation.reason)
        else if (navigationDigest(this.#binding.target_origin, navigation.path) !== this.#lastUrlDigest) this.#drop('NAVIGATION_UNATTRIBUTED')
      }
    }
    this.#flushPending()
    await this.#imageQueue
    this.#assertLive(generation)
    this.#requestImage('end', this.#sequence)
    await this.#imageQueue
    this.#assertLive(generation)

    if (this.#interactions.length === 0) this.#reason('CAPTURE_EMPTY')
    const final: CaptureState =
      this.#counters.unsupported > 0 ? 'unsupported' : this.#counters.dropped > 0 || this.#interactions.length === 0 ? 'incomplete' : 'ready'
    const completeness = final === 'ready' ? { status: 'complete' as const, reasons: [] } : { status: final as 'incomplete' | 'unsupported', reasons: [...this.#reasons] }
    const finished = Math.max(this.#offset(), this.#interactions.at(-1)?.offset_ms ?? 0)
    const body = structuredClone({
      ...this.#body(final, completeness),
      interactions: this.#interactions,
      observations: this.#observations,
      staged_bytes: 0,
      timing: { started_offset_ms: 0 as const, finished_offset_ms: finished },
      seal: null,
    })
    body.staged_bytes = Buffer.byteLength(canonicalJson({ interactions: body.interactions, observations: body.observations })) + this.#artifactBytes
    const report_sha256 = projectDigest(body)
    const capture = deepFreeze({ ...body, seal: { report_sha256 } }) as DemonstrationCapture
    const parsed = parseDemonstrationCapture(capture)
    if (!parsed.ok) {
      throw new ProjectRecorderError('CAPTURE_CONTRACT_INVALID', `The sealed capture violates the S1 contract: ${parsed.error.issues.map((issue) => issue.code).join(', ')}.`)
    }
    this.#transition(final)
    const sealed = Object.freeze({ capture, report_sha256, artifacts: this.#artifacts as ReadonlyMap<string, Buffer> })
    this.#sealed = sealed
    return sealed
  }

  #body(state: CaptureState, completeness: DemonstrationCapture['completeness']) {
    return {
      schema_version: PROJECT_SCHEMA_VERSION,
      capture_id: this.captureId,
      run_id: this.#binding.run_id,
      project_id: this.#binding.project_id,
      baseline_commit: this.#binding.baseline_commit,
      configuration_id: this.#binding.configuration_id,
      configuration_digest: this.#binding.configuration_digest,
      target_origin: this.#binding.target_origin,
      viewport: { ...this.#binding.viewport },
      state,
      document_epoch: this.#epoch,
      counters: { ...this.#counters },
      completeness,
    }
  }

  #wipe(): void {
    for (const bytes of this.#artifacts.values()) bytes.fill(0)
    this.#artifacts.clear()
    this.#artifactBytes = 0
    this.#interactions = []
    this.#observations = []
    this.#fingerprints.clear()
    this.#lastFill.clear()
    this.#pending = null
    this.#jsonBytes = 0
    this.#errorBytes = 0
    this.#registry.clear()
    this.#registry = new RedactedValueRegistry()
    this.#sealed = null
  }
}

export function createCaptureSession(options: CaptureSessionOptions): ProjectCaptureSession {
  return new ProjectCaptureSession(options)
}

/**
 * Network failure metadata from a Playwright request: method, URL and status or failure text
 * only. Headers, bodies, post data and cookies are never read.
 */
export function networkEventFromRequest(
  request: Pick<Request, 'method' | 'url'> & { failure(): { readonly errorText: string } | null },
  response: Pick<Response, 'status'> | null,
): Extract<HostCaptureEvent, { kind: 'network' }> {
  return {
    kind: 'network',
    method: request.method(),
    url: request.url(),
    status: response === null ? null : response.status(),
    failure: response === null ? (request.failure()?.errorText ?? 'net::ERR_FAILED') : null,
  }
}

// ---------------------------------------------------------------------------------------
// Playwright adapter
// ---------------------------------------------------------------------------------------

export interface StartRecorderOptions {
  readonly page: Page
  /** The actual admitted target frame (normally the run-owned target iframe). */
  readonly frame: Frame
  readonly binding: CaptureBinding
  /** Confirmed relative entry path; Start resets the target here. */
  readonly entryPath: string
  readonly policy?: ProjectPrivacyPolicy
  readonly collectors?: CaptureCollectors
  /** `false` discloses an unavailable image collector instead of capturing images. */
  readonly images?: boolean
}

export interface ProjectRecorder {
  readonly session: ProjectCaptureSession
  readonly frameId: string
  /** Drains the target document, seals the report and detaches instrumentation. */
  finish(): Promise<SealedCapture>
  /** Discards before analysis and detaches instrumentation. */
  discard(): Promise<void>
  /** Detaches instrumentation without changing the capture state. */
  detach(): Promise<void>
}

/** Playwright's binding source; only the host-reported calling frame is used. */
type BindingSource = Parameters<Parameters<Page['exposeBinding']>[1]>[0]

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function frameOrigin(frame: Frame): string {
  try {
    return new URL(frame.url()).origin
  } catch {
    return 'null'
  }
}

/**
 * Attaches the recorder to the admitted target frame, resets it to the entry path and begins
 * recording once that entry document announces itself through the host binding.
 */
export async function startProjectRecorder(options: StartRecorderOptions): Promise<ProjectRecorder> {
  const { page, frame, binding } = options
  if (!entryPathSchema.safeParse(options.entryPath).success) throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'The entry path is not an admitted relative path.')
  if (frame.isDetached() || frame.page() !== page) throw new ProjectRecorderError('CAPTURE_TARGET_INVALID', 'The target frame does not belong to this page.')
  const policy = options.policy ?? DEFAULT_PRIVACY_POLICY
  const frameId = newProjectUuid()
  const frameIds = new WeakMap<Frame, string>([[frame, frameId]])
  const idOf = (candidate: Frame): string => {
    let id = frameIds.get(candidate)
    if (id === undefined) {
      id = newProjectUuid()
      frameIds.set(candidate, id)
    }
    return id
  }
  const relationOf = (candidate: Frame): RecorderSource['relation'] => {
    if (candidate === frame) return 'target'
    for (let parent = candidate.parentFrame(); parent !== null; parent = parent.parentFrame()) if (parent === frame) return 'descendant'
    return 'foreign'
  }
  const sourceOf = (candidate: Frame): RecorderSource => ({ frameId: idOf(candidate), origin: frameOrigin(candidate), relation: relationOf(candidate) })

  const images: TargetImageSource | null =
    options.images === false
      ? null
      : {
          capture: async (registry) => {
            // A new document announces itself at creation; its image waits (bounded) for its load.
            await frame.waitForLoadState('load', { timeout: IMAGE_LOAD_TIMEOUT_MS }).catch(() => undefined)
            return captureMaskedTargetImage({ page, frame, targetOrigin: binding.target_origin, policy, registry })
          },
        }
  const session = createCaptureSession({ binding, frameId, policy, images, ...(options.collectors ? { collectors: options.collectors } : {}) })

  let hello: { readonly source: RecorderSource; readonly envelope: unknown } | null = null
  let announce: (() => void) | null = null
  const announced = new Promise<void>((resolve) => (announce = resolve))
  const onBinding = (source: BindingSource, envelope: unknown): void => {
    const origin = sourceOf(source.frame)
    if (session.state === 'idle') {
      const kind = (envelope as { e?: { k?: unknown } } | null)?.e?.k
      if (origin.relation === 'target' && kind === 'hello') {
        hello = { source: origin, envelope }
        announce?.()
      }
      return
    }
    session.ingest(origin, envelope)
  }

  const bindingName = `__flowproofCapture_${randomBytes(8).toString('hex')}`
  const privateSelector = ['[data-flowproof-private]', ...policy.privateSelectors].join(', ')
  const disposables: Array<{ dispose(): Promise<void> }> = []
  const listeners: Array<() => void> = []
  const on = <A extends unknown[]>(event: string, handler: (...args: A) => void): void => {
    const listener = handler as (...args: unknown[]) => void
    page.on(event as 'load', listener as () => void)
    listeners.push(() => page.off(event as 'load', listener as () => void))
  }
  let detached = false
  const detach = async (): Promise<void> => {
    if (detached) return
    detached = true
    for (const remove of listeners.splice(0)) remove()
    for (const disposable of disposables.splice(0).reverse()) await disposable.dispose().catch(() => undefined)
  }

  try {
    disposables.push(await page.exposeBinding(bindingName, onBinding))
    disposables.push(
      await page.addInitScript({
        content: recorderScript({ binding: bindingName, origin: binding.target_origin, top: frame.parentFrame() === null, privateSelector }),
      }),
    )
    on('framenavigated', (navigated: Frame) => {
      if (navigated === frame && frameOrigin(frame) !== binding.target_origin) session.recordHostEvent({ kind: 'unsupported', reason: 'NAVIGATION_CROSS_ORIGIN' })
    })
    on('framedetached', (removed: Frame) => {
      if (removed === frame) session.recordHostEvent({ kind: 'dropped', reason: 'TARGET_FRAME_DETACHED' })
    })
    const fromTarget = (request: Request): boolean => {
      try {
        return request.frame() === frame
      } catch {
        return false
      }
    }
    on('requestfailed', (request: Request) => {
      if (fromTarget(request)) session.recordHostEvent(networkEventFromRequest(request, null))
    })
    on('response', (response: Response) => {
      if (response.status() >= 400 && fromTarget(response.request())) session.recordHostEvent(networkEventFromRequest(response.request(), response))
    })
    on('popup', () => session.recordHostEvent({ kind: 'unsupported', reason: 'POPUP_UNSUPPORTED' }))
    on('download', () => session.recordHostEvent({ kind: 'unsupported', reason: 'DOWNLOAD_UNSUPPORTED' }))
    on('filechooser', () => session.recordHostEvent({ kind: 'unsupported', reason: 'FILE_UPLOAD' }))

    await frame.goto(`${binding.target_origin}${options.entryPath}`, { waitUntil: 'load', timeout: START_RESET_TIMEOUT_MS })
    if (hello === null) await withTimeout(announced, FINISH_DRAIN_TIMEOUT_MS).catch(() => undefined)
    const entry = hello as { readonly source: RecorderSource; readonly envelope: unknown } | null
    if (entry === null) throw new ProjectRecorderError('CAPTURE_INSTRUMENTATION_UNAVAILABLE', 'The target entry document did not announce the recorder.')
    session.begin(entry.source, entry.envelope)
  } catch (error) {
    await detach()
    session.dispose()
    if (error instanceof ProjectRecorderError) throw error
    throw new ProjectRecorderError('CAPTURE_INSTRUMENTATION_UNAVAILABLE', 'The recorder could not be attached to the target frame.')
  }

  const drain = async (): Promise<DrainResult> => {
    try {
      // The ordered round trip: callbacks the target sent before this evaluation are delivered first.
      await withTimeout(
        frame.evaluate(() => 0),
        FINISH_DRAIN_TIMEOUT_MS,
      )
      return { ok: true, hostUrl: frame.isDetached() ? null : frame.url() }
    } catch {
      return { ok: false, hostUrl: null }
    }
  }

  return Object.freeze({
    session,
    frameId,
    async finish(): Promise<SealedCapture> {
      try {
        return await session.finish(drain)
      } finally {
        await detach()
      }
    },
    async discard(): Promise<void> {
      try {
        session.discard()
      } finally {
        await detach()
      }
    },
    detach,
  })
}

// ---------------------------------------------------------------------------------------
// In-page target instrumentation (runs in every new document; inert outside the target)
// ---------------------------------------------------------------------------------------

interface RecorderScriptConfig {
  readonly binding: string
  readonly origin: string
  readonly top: boolean
  readonly privateSelector: string
}

/**
 * The recorder installed before page scripts. It captures the host binding and deletes it from
 * the page global, listens only to trusted events, never sends a value from another origin and
 * reports unsupported gestures instead of inventing actions. It is untrusted by the host anyway.
 */
export function recorderScript(config: RecorderScriptConfig): string {
  return `(() => {
  const C = ${JSON.stringify(config)};
  const w = window;
  let send = null;
  try { send = w[C.binding]; delete w[C.binding]; } catch (error) { send = null; }
  if (typeof send !== 'function') return;
  if (C.top ? w !== w.top : w === w.top) return;
  const add = EventTarget.prototype.addEventListener;
  const listen = (target, type, handler) => add.call(target, type, handler, { capture: true, passive: true });
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;
  const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const token = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  let n = 0;
  const post = (e) => {
    try {
      const reply = send({ v: ${RECORDER_PROTOCOL_VERSION}, token, n, e });
      n += 1;
      if (reply && typeof reply.catch === 'function') reply.catch(() => undefined);
    } catch (error) { /* the host binding is gone */ }
  };
  if (location.origin !== C.origin) {
    for (const type of ['click', 'input', 'change', 'keydown', 'dragstart']) listen(w, type, (event) => { if (event.isTrusted) post({ k: 'unsupported', reason: 'NESTED_FRAME' }); });
    return;
  }
  const TEXT_TYPES = ['text', 'search', 'url', 'number', 'password', 'email', 'tel'];
  const ID = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const isPrivate = (el) => { try { return el.closest(C.privateSelector) !== null; } catch (error) { return true; } };
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch (error) { return false; } };
  const compound = (el) => {
    const tag = el.localName;
    if (el.id && ID.test(el.id) && unique(tag + '#' + el.id)) return { selector: tag + '#' + el.id, done: true };
    let selector = tag;
    for (const name of Array.from(el.classList || []).filter((name) => ID.test(name)).slice(0, 2)) selector += '.' + name;
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.localName === tag);
      const index = same.indexOf(el) + 1;
      if (same.length > 1 && index > 0 && index <= 999) selector += ':nth-of-type(' + index + ')';
    }
    return { selector, done: false };
  };
  const cssPath = (el) => {
    const parts = [];
    for (let current = el, depth = 0; current && current.nodeType === 1 && depth < 8; current = current.parentElement, depth += 1) {
      if (!/^[a-z][a-z0-9-]*$/.test(current.localName)) return null;
      const part = compound(current);
      parts.unshift(part.selector);
      const selector = parts.join(' > ');
      if (part.done || unique(selector)) return selector.length <= 256 ? selector : null;
    }
    return null;
  };
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox' };
  const TAG_ROLES = { button: 'button', textarea: 'textbox', option: 'option', ul: 'list', ol: 'list', li: 'listitem', nav: 'navigation', main: 'main', dialog: 'dialog', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', article: 'article', progress: 'progressbar' };
  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
    if (tag === 'input') return INPUT_ROLES[String(el.type || 'text').toLowerCase()] || null;
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return el.getAttribute('alt') === '' ? null : 'img';
    return TAG_ROLES[tag] || null;
  };
  const labelOf = (el) => clean(Array.from(el.labels || [], (label) => label.textContent).join(' '));
  const NAMED_BY_CONTENT = ['button', 'link', 'heading', 'listitem', 'cell', 'columnheader', 'option', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'];
  const nameOf = (el, role) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = clean(by.split(/\\s+/).map((id) => { const ref = document.getElementById(id); return ref && ref !== el ? ref.textContent : ''; }).join(' '));
      if (joined) return joined;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = String(el.type || '').toLowerCase();
      if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) return clean(el.getAttribute('value')) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      return labelOf(el) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));
    }
    if (tag === 'img') return clean(el.getAttribute('alt')) || clean(el.getAttribute('title'));
    if (NAMED_BY_CONTENT.includes(role)) return clean(el.textContent) || clean(el.getAttribute('title'));
    return clean(el.getAttribute('title'));
  };
  const bounded = (value, max) => (value !== null && value !== undefined && String(value).length <= max ? String(value) : null);
  const describe = (el) => {
    const role = roleOf(el);
    const name = role ? nameOf(el, role) : null;
    return {
      tag: /^[a-z][a-z0-9-]{0,31}$/.test(el.localName) ? el.localName : 'x-unknown',
      testId: bounded(el.getAttribute('data-testid'), 256),
      role: bounded(role, 32),
      name: bounded(name, 1024),
      id: el.id ? bounded(el.id, 256) : null,
      css: cssPath(el),
      private: isPrivate(el),
    };
  };
  const optional = (value, max) => { const text = String(value || ''); return text && text.length <= max ? text : null; };
  const fieldOf = (el) => ({
    type: el.localName === 'input' ? optional(String(el.type || 'text').toLowerCase(), 32) : null,
    autocomplete: optional(el.getAttribute('autocomplete'), 256),
    name: optional(el.getAttribute('name'), 256),
    label: optional(labelOf(el), 1024),
    placeholder: optional(el.getAttribute('placeholder'), 1024),
  });
  const targetOf = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let target = path[0] || event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    return target && target.nodeType === 1 ? target : null;
  };
  const editable = (el) => !!el && (el.isContentEditable || el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select');
  let skipClickOn = null;
  let lastClicked = null;
  listen(w, 'click', (event) => {
    if (!event.isTrusted) return;
    const el = targetOf(event);
    if (!el) return;
    if (skipClickOn !== null && el === skipClickOn) { skipClickOn = null; return; }
    if (el.localName === 'select' || el.localName === 'option' || el.closest('select')) return;
    if (el.localName === 'label' && el.control) {
      skipClickOn = el.control;
      setTimeout(() => { skipClickOn = null; }, 0);
    }
    lastClicked = el;
    post({ k: 'click', el: describe(el) });
  });
  const onValue = (event, commit) => {
    if (!event.isTrusted) return;
    const el = targetOf(event);
    if (!el) return;
    if (el.isContentEditable) { post({ k: 'unsupported', reason: 'CONTENTEDITABLE_EDIT' }); return; }
    const tag = el.localName;
    if (tag === 'select') {
      if (commit) post({ k: 'select', el: describe(el), field: fieldOf(el), value: el.multiple ? null : bounded(el.value, 4096), multiple: !!el.multiple });
      return;
    }
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
    if (tag === 'textarea' || (tag === 'input' && TEXT_TYPES.includes(type))) {
      post({ k: 'input', el: describe(el), field: fieldOf(el), value: bounded(el.value, 4096), commit });
      return;
    }
    if (tag === 'input' && type !== 'checkbox' && type !== 'radio' && commit) post({ k: 'unsupported', reason: type === 'file' ? 'FILE_UPLOAD' : 'INPUT_TYPE_UNSUPPORTED' });
  };
  listen(w, 'input', (event) => onValue(event, false));
  listen(w, 'change', (event) => onValue(event, true));
  const scrollDescriptors = new WeakMap();
  listen(w, 'scroll', (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (target === document || target === document.documentElement || target === w || target === document.scrollingElement) {
      post({ k: 'scroll', el: null, x: w.scrollX, y: w.scrollY });
    } else if (target && target.nodeType === 1) {
      let described = scrollDescriptors.get(target);
      if (!described) { described = describe(target); scrollDescriptors.set(target, described); }
      post({ k: 'scroll', el: described, x: target.scrollLeft, y: target.scrollTop });
    }
  });
  listen(w, 'keydown', (event) => {
    if (!event.isTrusted) return;
    const el = targetOf(event);
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    if (modifier && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) { if (!editable(el)) post({ k: 'unsupported', reason: 'KEYBOARD_SHORTCUT' }); return; }
    if (event.key === 'Escape') { post({ k: 'unsupported', reason: 'KEYBOARD_KEY' }); return; }
    if (event.key === 'Enter' && el) {
      const tag = el.localName;
      const type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
      const activates = tag === 'textarea' || tag === 'button' || tag === 'summary' || tag === 'select' || (tag === 'a' && el.hasAttribute('href')) ||
        ['submit', 'button', 'reset', 'checkbox', 'radio', 'image'].includes(type) || (tag === 'input' && el.form !== null);
      if (!activates) post({ k: 'unsupported', reason: 'KEYBOARD_KEY' });
    }
  });
  listen(w, 'submit', (event) => {
    if (!event.isTrusted) return;
    if (!event.submitter || event.submitter !== lastClicked) post({ k: 'unsupported', reason: 'FORM_SUBMIT_UNSUPPORTED' });
  });
  listen(w, 'dragstart', (event) => { if (event.isTrusted) post({ k: 'unsupported', reason: 'DRAG_DROP' }); });
  listen(w, 'drop', (event) => { if (event.isTrusted) post({ k: 'unsupported', reason: 'DRAG_DROP' }); });
  let gesture = null;
  listen(w, 'pointerdown', (event) => {
    if (!event.isTrusted) return;
    const el = targetOf(event);
    gesture = el && (el.localName === 'canvas' || el.closest('svg')) ? { x: event.clientX, y: event.clientY, reported: false } : null;
  });
  listen(w, 'pointermove', (event) => {
    if (!gesture || gesture.reported || !event.isTrusted || event.buttons === 0) return;
    if (Math.abs(event.clientX - gesture.x) + Math.abs(event.clientY - gesture.y) > 8) { gesture.reported = true; post({ k: 'unsupported', reason: 'CANVAS_GESTURE' }); }
  });
  listen(w, 'pointerup', () => { gesture = null; });
  const history = w.History && w.History.prototype;
  if (history) {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function (...args) { const result = original.apply(this, args); post({ k: 'url', href: String(location.href) }); return result; };
    }
  }
  listen(w, 'popstate', () => post({ k: 'url', href: String(location.href) }));
  listen(w, 'hashchange', () => post({ k: 'url', href: String(location.href) }));
  const format = (args) => {
    try {
      return Array.from(args, (arg) => {
        if (arg instanceof Error) return arg.name + ': ' + arg.message;
        const type = typeof arg;
        if (type === 'string') return arg;
        if (type === 'number' || type === 'boolean' || type === 'bigint' || arg === null || arg === undefined) return String(arg);
        return '[object]';
      }).join(' ').slice(0, 8192);
    } catch (error) { return '[unformattable]'; }
  };
  const output = w.console;
  for (const level of ['error', 'warn']) {
    const original = output[level];
    if (typeof original !== 'function') continue;
    output[level] = function (...args) { post({ k: 'console', level: level === 'warn' ? 'warning' : 'error', message: format(args) }); return original.apply(this, args); };
  }
  listen(w, 'error', (event) => { if (event.target === w && event.message !== undefined) post({ k: 'pageerror', message: String(event.message).slice(0, 8192) }); });
  listen(w, 'unhandledrejection', (event) => {
    const reason = event.reason;
    const text = reason instanceof Error ? reason.name + ': ' + reason.message : typeof reason === 'string' ? reason : '[object]';
    post({ k: 'pageerror', message: ('Unhandled rejection: ' + text).slice(0, 8192) });
  });
  post({ k: 'hello', href: String(location.href) });
})();`
}
