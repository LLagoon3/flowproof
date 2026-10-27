import { CONTRACT_SCHEMA_VERSION, parseStudioEvent, uuidSchema } from '../contracts/index.js'
import type { GateSummary, RunState, StudioEvent, StudioEventType } from '../contracts/index.js'
import { sanitizeText } from '../evidence/sanitize.js'

// In-memory, ordered Studio activity for one run. Events are sanitized and validated before
// delivery and reach only currently connected subscribers: the MVP never replays missed
// events, and no subscriber can affect the run or its authoritative result.

const MAX_MESSAGE_LENGTH = 500
export const DEFAULT_HEARTBEAT_MS = 15_000
export const SSE_HEARTBEAT = ': heartbeat\n\n'

export type StudioEventErrorCode =
  | 'EVENT_RUN_ID_INVALID'
  | 'EVENT_STREAM_CLOSED'
  | 'EVENT_MESSAGE_EMPTY'
  | 'EVENT_EVIDENCE_UNKNOWN'
  | 'EVENT_ARTIFACT_UNKNOWN'
  | 'EVENT_CONTRACT_INVALID'

export class StudioEventError extends Error {
  readonly code: StudioEventErrorCode

  constructor(code: StudioEventErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'StudioEventError'
    this.code = code
  }
}

/** Answers whether an Evidence ID or artifact reference already exists for this run. */
export interface EventRegistry {
  hasEvidence(id: string): boolean
  hasArtifact(ref: string): boolean
}

export interface StudioEventInput {
  readonly type: StudioEventType
  readonly phase: RunState | null
  readonly message: string
  readonly evidence_ids?: readonly string[]
  readonly gate?: GateSummary | null
  readonly artifact_refs?: readonly string[]
}

export type StudioEventListener = (event: StudioEvent) => void

export interface RunEventStream {
  readonly runId: string
  readonly closed: boolean
  readonly subscriberCount: number
  emit(input: StudioEventInput): StudioEvent
  /** Receives events emitted after this call only. Returns the unsubscribe function. */
  subscribe(listener: StudioEventListener): () => void
  /** Frozen copy of the events emitted so far, for in-process checks such as secret scanning. */
  events(): readonly StudioEvent[]
}

export function createRunEventStream(options: {
  readonly runId: string
  readonly registry: EventRegistry
  readonly now?: () => Date
}): RunEventStream {
  const { runId, registry } = options
  if (!uuidSchema.safeParse(runId).success) throw new StudioEventError('EVENT_RUN_ID_INVALID', 'Events belong to a run UUID.')
  const now = options.now ?? (() => new Date())
  const emitted: StudioEvent[] = []
  const listeners = new Set<StudioEventListener>()
  let closed = false

  const deliver = (event: StudioEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A failing subscriber is a disconnected client; the run continues without it.
        listeners.delete(listener)
      }
    }
  }

  return {
    runId,
    get closed() {
      return closed
    },
    get subscriberCount() {
      return listeners.size
    },

    emit(input: StudioEventInput): StudioEvent {
      if (closed) throw new StudioEventError('EVENT_STREAM_CLOSED', 'The run already finalized.')
      const message = sanitizeText(String(input.message)).value.trim().slice(0, MAX_MESSAGE_LENGTH).trimEnd()
      if (message.length === 0) throw new StudioEventError('EVENT_MESSAGE_EMPTY', 'Events need a readable message.')
      const evidenceIds = [...(input.evidence_ids ?? [])]
      if (evidenceIds.some((id) => !registry.hasEvidence(id))) {
        throw new StudioEventError('EVENT_EVIDENCE_UNKNOWN', 'Events announce only persisted Evidence IDs of this run.')
      }
      const artifactRefs = [...(input.artifact_refs ?? [])]
      if (artifactRefs.some((ref) => !registry.hasArtifact(ref))) {
        throw new StudioEventError('EVENT_ARTIFACT_UNKNOWN', 'Events reference only persisted artifacts of this run.')
      }
      const sequence = emitted.length + 1
      const parsed = parseStudioEvent({
        schema_version: CONTRACT_SCHEMA_VERSION,
        event_id: `${runId}:${sequence}`,
        run_id: runId,
        sequence,
        occurred_at: now().toISOString(),
        type: input.type,
        phase: input.phase,
        message,
        evidence_ids: evidenceIds,
        gate: input.gate ?? null,
        artifact_refs: artifactRefs,
      })
      if (!parsed.ok) {
        const fields = parsed.error.issues.map((issue) => issue.path).join(', ')
        throw new StudioEventError('EVENT_CONTRACT_INVALID', `The event violates the Studio Event contract at ${fields}.`)
      }
      const event = parsed.value
      Object.freeze(event.evidence_ids)
      Object.freeze(event.artifact_refs)
      if (event.gate) Object.freeze(event.gate)
      Object.freeze(event)
      emitted.push(event)
      if (event.type === 'run_finalized') closed = true
      deliver(event)
      if (closed) listeners.clear()
      return event
    },

    subscribe(listener: StudioEventListener): () => void {
      if (!closed) listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    events: () => Object.freeze([...emitted]),
  }
}

// ---------------------------------------------------------------------------------------
// Server-Sent Events delivery
// ---------------------------------------------------------------------------------------

/** The minimal response surface SSE delivery needs; `http.ServerResponse` satisfies it. */
export interface SseSink {
  write(chunk: string): unknown
  end(): unknown
  once(event: 'close', listener: () => void): unknown
}

/** One SSE record: `id`, `event`, and the complete event as single-line JSON `data`. */
export function formatSseEvent(event: StudioEvent): string {
  return `id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Streams live events and comment-only heartbeats to one connected client. A disconnect or
 * failed write detaches only this client; the response ends after the final event.
 */
export function attachSseClient(
  stream: RunEventStream,
  sink: SseSink,
  options: { readonly heartbeatMs?: number } = {},
): { detach(): void } {
  let attached = true
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe: () => void = () => undefined

  const detach = (): void => {
    if (!attached) return
    attached = false
    unsubscribe()
    if (heartbeat !== undefined) clearInterval(heartbeat)
  }
  const write = (chunk: string): boolean => {
    try {
      sink.write(chunk)
      return true
    } catch {
      detach()
      return false
    }
  }
  const end = (): void => {
    detach()
    try {
      sink.end()
    } catch {
      // The client is already gone.
    }
  }

  if (stream.closed) {
    end()
    return { detach }
  }
  sink.once('close', detach)
  unsubscribe = stream.subscribe((event) => {
    if (!write(formatSseEvent(event))) return
    if (event.type === 'run_finalized') end()
  })
  heartbeat = setInterval(() => {
    write(SSE_HEARTBEAT)
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  heartbeat.unref?.()
  return { detach }
}
