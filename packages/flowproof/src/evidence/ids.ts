import { EVIDENCE_ID_PATTERN, EVIDENCE_TYPES, uuidSchema } from '../contracts/index.js'
import type { EvidenceBundle, EvidencePhase, EvidenceType } from '../contracts/index.js'

export { EVIDENCE_TYPES }

export type EvidenceIdErrorCode =
  | 'EVIDENCE_ID_ORDINAL_INVALID'
  | 'EVIDENCE_RUN_ID_INVALID'
  | 'CITATION_SOURCE_MUST_BE_FAILURE_BUNDLE'

export class EvidenceIdError extends Error {
  readonly code: EvidenceIdErrorCode

  constructor(code: EvidenceIdErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'EvidenceIdError'
    this.code = code
  }
}

const MAX_ORDINAL = 999

export interface ParsedEvidenceId {
  readonly phase: EvidencePhase
  readonly type: EvidenceType
  readonly ordinal: number
}

/** Builds the stable `ev_<phase>_<type>_<ordinal>` identifier with a three-digit ordinal. */
export function createEvidenceId(phase: EvidencePhase, type: EvidenceType, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_ORDINAL) {
    throw new EvidenceIdError('EVIDENCE_ID_ORDINAL_INVALID', 'Evidence ordinals must be integers from 1 to 999.')
  }
  return `ev_${phase}_${type}_${String(ordinal).padStart(3, '0')}`
}

/** Returns the identifier's segments, or null when it is not a well-formed issued identifier. */
export function parseEvidenceId(id: unknown): ParsedEvidenceId | null {
  if (typeof id !== 'string') return null
  const match = EVIDENCE_ID_PATTERN.exec(id)
  if (!match) return null
  const ordinal = Number(match[3])
  if (ordinal < 1) return null
  return { phase: match[1] as EvidencePhase, type: match[2] as EvidenceType, ordinal }
}

export interface EvidenceIdAllocator {
  readonly runId: string
  /** Issues the next identifier for the phase and type in deterministic capture order. */
  allocate(phase: EvidencePhase, type: EvidenceType): string
  /** A frozen snapshot of every identifier issued so far, in issue order. */
  issued(): readonly string[]
}

/** Creates the only source of Evidence IDs for one run; the model can never mint one. */
export function createEvidenceIdAllocator(runId: string): EvidenceIdAllocator {
  if (!uuidSchema.safeParse(runId).success) {
    throw new EvidenceIdError('EVIDENCE_RUN_ID_INVALID', 'Evidence IDs must belong to a run UUID.')
  }
  const counters = new Map<string, number>()
  const issued: string[] = []
  return Object.freeze({
    runId,
    allocate(phase: EvidencePhase, type: EvidenceType): string {
      const key = `${phase}:${type}`
      const ordinal = (counters.get(key) ?? 0) + 1
      const id = createEvidenceId(phase, type, ordinal)
      counters.set(key, ordinal)
      issued.push(id)
      return id
    },
    issued: () => Object.freeze([...issued]),
  })
}

export type CitationRejectionReason =
  | 'CITATION_REQUIRED'
  | 'CITATION_MALFORMED'
  | 'CITATION_DUPLICATE'
  | 'CITATION_REPLAY_PHASE'
  | 'CITATION_CROSS_RUN'
  | 'CITATION_UNKNOWN_EVIDENCE_ID'

export interface CitationRejection {
  /** The rejected identifier, or null when it is absent or malformed and must not be echoed. */
  readonly id: string | null
  readonly reason: CitationRejectionReason
}

export interface CitationValidation {
  readonly valid: boolean
  readonly accepted: readonly string[]
  readonly rejected: readonly CitationRejection[]
}

/**
 * Validates model-cited Evidence IDs against the current run's failure bundle. Every
 * citation is checked, so the result lists all rejections rather than the first one.
 */
export function validateCitations(input: {
  readonly runId: string
  readonly failureBundle: EvidenceBundle
  readonly citedIds: readonly unknown[]
}): CitationValidation {
  const { runId, failureBundle, citedIds } = input
  if (failureBundle.phase !== 'failure') {
    throw new EvidenceIdError('CITATION_SOURCE_MUST_BE_FAILURE_BUNDLE', 'Citations resolve only against failure evidence.')
  }
  const sameRun = failureBundle.run_id === runId && failureBundle.items.every((item) => item.run_id === runId)
  const known = new Set(failureBundle.items.map((item) => item.evidence_id))
  const seen = new Set<string>()
  const accepted: string[] = []
  const rejected: CitationRejection[] = []

  if (citedIds.length === 0) rejected.push({ id: null, reason: 'CITATION_REQUIRED' })
  for (const cited of citedIds) {
    const parsed = parseEvidenceId(cited)
    if (parsed === null || typeof cited !== 'string') {
      rejected.push({ id: null, reason: 'CITATION_MALFORMED' })
    } else if (seen.has(cited)) {
      rejected.push({ id: cited, reason: 'CITATION_DUPLICATE' })
    } else if (!sameRun) {
      rejected.push({ id: cited, reason: 'CITATION_CROSS_RUN' })
    } else if (parsed.phase !== 'failure') {
      rejected.push({ id: cited, reason: 'CITATION_REPLAY_PHASE' })
    } else if (!known.has(cited)) {
      rejected.push({ id: cited, reason: 'CITATION_UNKNOWN_EVIDENCE_ID' })
    } else {
      accepted.push(cited)
    }
    if (typeof cited === 'string' && parsed !== null) seen.add(cited)
  }

  return Object.freeze({
    valid: rejected.length === 0,
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry))),
  })
}
