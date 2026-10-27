import { GATE_IDS, GateOutcomeSchema } from '../contracts/index.js'
import type { GateId, GateOutcome, GateStatus, RunStatus } from '../contracts/index.js'

// Deterministic gate reduction. The model has no field that can set or override the final
// status: `Verified Fix` requires exactly one passing outcome for each of the nine gates.

export class GateError extends Error {
  readonly code = 'GATE_OUTCOME_INVALID'

  constructor(message: string) {
    super(`GATE_OUTCOME_INVALID: ${message}`)
    this.name = 'GateError'
  }
}

export interface GateOutcomeInit {
  readonly evidence_ids?: readonly string[]
  readonly message?: string
  readonly metrics?: Readonly<Record<string, string | number | boolean | null>>
}

export interface PassGateInit extends GateOutcomeInit {
  readonly reason_code?: string
}

function createOutcome(gateId: GateId, status: GateStatus, reasonCode: string, init: GateOutcomeInit = {}): GateOutcome {
  const parsed = GateOutcomeSchema.safeParse({
    gate_id: gateId,
    status,
    evidence_ids: [...(init.evidence_ids ?? [])],
    reason_code: reasonCode,
    message: init.message ?? `Gate ${gateId} reported ${status}.`,
    metrics: { ...(init.metrics ?? {}) },
  })
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')
    throw new GateError(`The gate outcome is malformed at ${fields}.`)
  }
  const outcome = parsed.data
  Object.freeze(outcome.evidence_ids)
  Object.freeze(outcome.metrics)
  return Object.freeze(outcome)
}

export const passGate = (gateId: GateId, init: PassGateInit = {}): GateOutcome =>
  createOutcome(gateId, 'pass', init.reason_code ?? 'GATE_PASSED', init)

export const failGate = (gateId: GateId, reasonCode: string, init: GateOutcomeInit = {}): GateOutcome =>
  createOutcome(gateId, 'fail', reasonCode, init)

export const unevaluableGate = (gateId: GateId, reasonCode = 'GATE_NOT_EVALUATED', init: GateOutcomeInit = {}): GateOutcome =>
  createOutcome(gateId, 'unevaluable', reasonCode, init)

export interface GateReduction {
  readonly status: RunStatus
  /** Exactly one outcome per required gate, in canonical order. */
  readonly gates: readonly GateOutcome[]
  /** Every `fail` or `unevaluable` gate, in canonical order. */
  readonly failed_gate_ids: readonly GateId[]
}

/**
 * Reduces evaluated outcomes to the final status. Missing gates become `unevaluable`
 * (`GATE_NOT_EVALUATED`), conflicting duplicates become `unevaluable`
 * (`GATE_OUTCOME_DUPLICATE`), and malformed outcomes are rejected rather than dropped.
 */
export function reduceGates(outcomes: readonly GateOutcome[]): GateReduction {
  const byGate = new Map<GateId, GateOutcome[]>()
  for (const candidate of outcomes) {
    const parsed = GateOutcomeSchema.safeParse(candidate)
    if (!parsed.success) throw new GateError('A gate outcome does not satisfy the gate contract.')
    const list = byGate.get(parsed.data.gate_id) ?? []
    list.push(candidate)
    byGate.set(parsed.data.gate_id, list)
  }
  const gates = GATE_IDS.map((gateId) => {
    const reported = byGate.get(gateId) ?? []
    if (reported.length === 0) return unevaluableGate(gateId, 'GATE_NOT_EVALUATED')
    if (reported.length > 1) {
      return unevaluableGate(gateId, 'GATE_OUTCOME_DUPLICATE', {
        message: `Gate ${gateId} reported conflicting outcomes and cannot be trusted.`,
      })
    }
    // Re-create the outcome so the reduction holds its own frozen copy.
    const [only] = reported as [GateOutcome]
    return createOutcome(gateId, only.status, only.reason_code, only)
  })
  const failed = gates.filter((gate) => gate.status !== 'pass').map((gate) => gate.gate_id)
  return Object.freeze({
    status: failed.length === 0 ? 'Verified Fix' : 'Unverified',
    gates: Object.freeze(gates),
    failed_gate_ids: Object.freeze(failed),
  })
}
