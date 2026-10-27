import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { parseStudioEvent } from '../../packages/flowproof/src/contracts/index.js'
import { createEvidenceIdAllocator } from '../../packages/flowproof/src/evidence/ids.js'
import {
  SSE_HEARTBEAT,
  StudioEventError,
  attachSseClient,
  createRunEventStream,
  formatSseEvent,
} from '../../packages/flowproof/src/studio/events.js'
import type { EventRegistry, SseSink } from '../../packages/flowproof/src/studio/events.js'

const RUN = '3d2642cc-e3d1-4c15-ae44-56fa719cd48e'
const OTHER_RUN = '11111111-2222-4333-8444-555555555555'
const SEEDED = 'sk-flowproofseededevents00001'
const FIXED_NOW = new Date('2026-10-27T10:00:00.000Z')

// Evidence and artifacts count as existing only after the run has issued and persisted them.
function registryFor(runId: string): EventRegistry & { persist(type: 'dataset' | 'chart', ref: string): string } {
  const allocator = createEvidenceIdAllocator(runId)
  const evidence = new Set<string>()
  const artifacts = new Set<string>()
  return {
    hasEvidence: (id) => evidence.has(id),
    hasArtifact: (ref) => artifacts.has(ref),
    persist(type, ref) {
      const id = allocator.allocate('failure', type)
      evidence.add(id)
      artifacts.add(ref)
      return id
    },
  }
}

class FakeSink implements SseSink {
  readonly chunks: string[] = []
  ended = false
  failWrites = false
  private closeListener: (() => void) | undefined

  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('socket closed')
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
  }

  once(event: 'close', listener: () => void): this {
    if (event === 'close') this.closeListener = listener
    return this
  }

  disconnect(): void {
    this.closeListener?.()
  }

  records(): StudioEvent[] {
    return this.chunks
      .filter((chunk) => !chunk.startsWith(':'))
      .map((chunk) => {
        const data = chunk.split('\n').find((line) => line.startsWith('data: '))
        return JSON.parse(data?.slice('data: '.length) ?? 'null') as StudioEvent
      })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRunEventStream', () => {
  it('assigns contiguous sequences from 1 with run-scoped event identifiers', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN), now: () => FIXED_NOW })

    const first = stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    const second = stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing the failure.' })
    const third = stream.emit({ type: 'agent_message', phase: null, message: 'Waiting for the target frame.' })

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3])
    expect(third.event_id).toBe(`${RUN}:3`)
    expect(third.occurred_at).toBe('2026-10-27T10:00:00.000Z')
    expect(stream.events().map((event) => event.sequence)).toEqual([1, 2, 3])
  })

  it('emits only contract-valid, frozen events', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })

    const event = stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing the failure.' })

    expect(parseStudioEvent(event).ok).toBe(true)
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.evidence_ids)).toBe(true)
    expect(Object.isFrozen(stream.events())).toBe(true)
  })

  it('does not consume a sequence number when an event is rejected', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })

    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    expect(() => stream.emit({ type: 'evidence_added', phase: 'reproducing', message: 'No IDs.' })).toThrow(
      StudioEventError,
    )
    const next = stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing.' })

    expect(next.sequence).toBe(2)
  })

  it('announces only Evidence IDs and artifacts already persisted for the same run', () => {
    const registry = registryFor(RUN)
    const otherRegistry = registryFor(OTHER_RUN)
    const stream = createRunEventStream({ runId: RUN, registry })
    const foreignId = otherRegistry.persist('chart', 'evidence/failure/chart.json')

    expect(() =>
      stream.emit({ type: 'evidence_added', phase: 'reproducing', message: 'Captured chart.', evidence_ids: [foreignId] }),
    ).toThrow(/EVENT_EVIDENCE_UNKNOWN/)

    const id = registry.persist('dataset', 'evidence/failure/dataset.json')
    expect(() =>
      stream.emit({
        type: 'evidence_added',
        phase: 'reproducing',
        message: 'Captured dataset.',
        evidence_ids: [id],
        artifact_refs: ['evidence/failure/unknown.json'],
      }),
    ).toThrow(/EVENT_ARTIFACT_UNKNOWN/)

    const event = stream.emit({
      type: 'evidence_added',
      phase: 'reproducing',
      message: 'Captured dataset.',
      evidence_ids: [id],
      artifact_refs: ['evidence/failure/dataset.json'],
    })
    expect(event.evidence_ids).toEqual(['ev_failure_dataset_001'])
    expect(event.run_id).toBe(RUN)
  })

  it('sanitizes and bounds every message before delivery', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const delivered: StudioEvent[] = []
    stream.subscribe((event) => delivered.push(event))

    const event = stream.emit({
      type: 'agent_message',
      phase: 'diagnosing',
      message: `Calling the model with Authorization: Bearer ${SEEDED} ${'x'.repeat(800)}`,
    })

    expect(event.message).not.toContain(SEEDED)
    expect(event.message.length).toBeLessThanOrEqual(500)
    expect(JSON.stringify(delivered)).not.toContain(SEEDED)
    expect(JSON.stringify(stream.events())).not.toContain(SEEDED)
  })

  it('carries gate summaries only on gate events', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })

    const gateEvent = stream.emit({
      type: 'gate_updated',
      phase: 'replaying',
      message: 'The dataset gate passed.',
      gate: { gate_id: 'dataset_matches', status: 'pass', reason_code: 'DATASET_EXACT_MATCH' },
    })

    expect(gateEvent.gate).toEqual({ gate_id: 'dataset_matches', status: 'pass', reason_code: 'DATASET_EXACT_MATCH' })
    expect(() =>
      stream.emit({
        type: 'phase_completed',
        phase: 'replaying',
        message: 'Replay completed.',
        gate: { gate_id: 'dataset_matches', status: 'pass', reason_code: 'DATASET_EXACT_MATCH' },
      }),
    ).toThrow(/EVENT_CONTRACT_INVALID/)
  })

  it('closes after the final event', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })

    stream.emit({ type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Unverified.' })

    expect(stream.closed).toBe(true)
    expect(() => stream.emit({ type: 'agent_message', phase: null, message: 'Late.' })).toThrow(/EVENT_STREAM_CLOSED/)
  })

  it('rejects a malformed run identifier', () => {
    expect(() => createRunEventStream({ runId: 'not-a-run', registry: registryFor(RUN) })).toThrow(/EVENT_RUN_ID_INVALID/)
  })
})

describe('live-only delivery', () => {
  it('delivers events emitted after subscription and never replays earlier ones', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })

    const late: number[] = []
    stream.subscribe((event) => late.push(event.sequence))
    stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing.' })

    expect(late).toEqual([2])
  })

  it('keeps emitting when a subscriber throws or unsubscribes', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const healthy: number[] = []
    stream.subscribe(() => {
      throw new Error('subscriber failure')
    })
    const unsubscribe = stream.subscribe((event) => healthy.push(event.sequence))

    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    unsubscribe()
    const later = stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing.' })

    expect(healthy).toEqual([1])
    expect(later.sequence).toBe(2)
    expect(stream.subscriberCount).toBe(0)
  })
})

describe('SSE delivery', () => {
  it('formats records with id, event, and single-line JSON data', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const event = stream.emit({ type: 'agent_message', phase: null, message: 'Line one\nline two' })

    const record = formatSseEvent(event)

    expect(record).toBe(`id: ${RUN}:1\nevent: agent_message\ndata: ${JSON.stringify(event)}\n\n`)
    expect(record.split('\n').filter((line) => line.startsWith('data: '))).toHaveLength(1)
  })

  it('streams live events plus comment-only heartbeats that are not Studio Events', () => {
    vi.useFakeTimers()
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const sink = new FakeSink()

    attachSseClient(stream, sink, { heartbeatMs: 1_000 })
    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    vi.advanceTimersByTime(2_500)

    expect(SSE_HEARTBEAT.startsWith(':')).toBe(true)
    expect(sink.chunks.filter((chunk) => chunk === SSE_HEARTBEAT)).toHaveLength(2)
    expect(sink.records().map((event) => event.sequence)).toEqual([1])
  })

  it('does not cancel or alter the run when the SSE client disconnects', () => {
    vi.useFakeTimers()
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const sink = new FakeSink()
    attachSseClient(stream, sink, { heartbeatMs: 1_000 })

    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    sink.disconnect()
    stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing.' })
    vi.advanceTimersByTime(5_000)

    expect(stream.closed).toBe(false)
    expect(stream.subscriberCount).toBe(0)
    expect(stream.events().map((event) => event.sequence)).toEqual([1, 2])
    expect(sink.records().map((event) => event.sequence)).toEqual([1])
    expect(sink.chunks.filter((chunk) => chunk === SSE_HEARTBEAT)).toHaveLength(0)
  })

  it('detaches a client whose socket write fails without disturbing the run', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const sink = new FakeSink()
    attachSseClient(stream, sink, { heartbeatMs: 60_000 })

    sink.failWrites = true
    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    const next = stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Reproducing.' })

    expect(next.sequence).toBe(2)
    expect(stream.subscriberCount).toBe(0)
  })

  it('a reconnecting client receives only new events, without missed-event replay', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const first = new FakeSink()
    attachSseClient(stream, first, { heartbeatMs: 60_000 })
    stream.emit({ type: 'chat_received', phase: 'initialized', message: 'Request received.' })
    first.disconnect()
    stream.emit({ type: 'phase_started', phase: 'reproducing', message: 'Missed while disconnected.' })

    const second = new FakeSink()
    attachSseClient(stream, second, { heartbeatMs: 60_000 })
    stream.emit({ type: 'phase_completed', phase: 'reproducing', message: 'Reproduced.' })

    expect(second.records().map((event) => event.sequence)).toEqual([3])
  })

  it('ends the response after the final event', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    const sink = new FakeSink()
    attachSseClient(stream, sink, { heartbeatMs: 60_000 })

    stream.emit({ type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Verified Fix.' })

    expect(sink.records().map((event) => event.type)).toEqual(['run_finalized'])
    expect(sink.ended).toBe(true)
    expect(stream.subscriberCount).toBe(0)
  })

  it('ends immediately when attached to an already finalized run', () => {
    const stream = createRunEventStream({ runId: RUN, registry: registryFor(RUN) })
    stream.emit({ type: 'run_finalized', phase: 'finalized', message: 'Run finalized as Unverified.' })
    const sink = new FakeSink()

    attachSseClient(stream, sink, { heartbeatMs: 60_000 })

    expect(sink.chunks).toEqual([])
    expect(sink.ended).toBe(true)
  })
})
