import { parseChartSeries, parseOracleDataset } from '../contracts/index.js'
import type { ChartSeries, EvidenceType, GateOutcome, OracleDataset } from '../contracts/index.js'
import { parseEvidenceId } from '../evidence/ids.js'
import { failGate, passGate, unevaluableGate } from './gates.js'

// Exact, independent dataset and rendered-chart oracles. Rows compare in order with exact keys
// and scalar types; the Canvas gate compares the trusted probe's bar count, labels, and values.
// A malformed observation is unevaluable, never a pass, and the screenshot is never read.

export interface OracleInput {
  /** The committed, immutable oracles from the loaded scenario. */
  readonly expected: { readonly dataset: OracleDataset; readonly chart: ChartSeries }
  /** What the trusted probe observed; untrusted until validated. Screenshots are ignored. */
  readonly observed: { readonly dataset: unknown; readonly chart: unknown; readonly screenshot?: unknown }
  /** Evidence IDs that support each gate, for example the replay dataset and chart items. */
  readonly evidence: { readonly dataset: readonly string[]; readonly chart: readonly string[] }
}

export interface OracleOutcomes {
  readonly dataset_matches: GateOutcome
  readonly canvas_matches: GateOutcome
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** Each gate cites only evidence of its own type, so a screenshot can never support either gate. */
function citedAs(type: EvidenceType, ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id): id is string => parseEvidenceId(id)?.type === type))]
}

function rowsEqual(expected: Readonly<Record<string, string | number>>, observed: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(expected)
  if (Object.keys(observed).length !== keys.length) return false
  return keys.every((key) => Object.hasOwn(observed, key) && observed[key] === expected[key])
}

function evaluateDataset(expectedOracle: unknown, observed: unknown, evidenceIds: readonly string[]): GateOutcome {
  const expected = parseOracleDataset(expectedOracle)
  if (!expected.ok) {
    return unevaluableGate('dataset_matches', 'DATASET_ORACLE_INVALID', { message: 'The committed dataset oracle is malformed.' })
  }
  if (!Array.isArray(observed) || !observed.every(isPlainObject)) {
    return unevaluableGate('dataset_matches', 'DATASET_OBSERVATION_INVALID', {
      evidence_ids: evidenceIds,
      message: 'The observed dataset is missing or malformed, so it cannot be compared.',
    })
  }
  const rows = expected.value
  const length = Math.max(rows.length, observed.length)
  let mismatch = -1
  for (let index = 0; index < length && mismatch === -1; index += 1) {
    const want = rows[index]
    const got = observed[index] as Record<string, unknown> | undefined
    if (want === undefined || got === undefined || !rowsEqual(want, got)) mismatch = index
  }
  const metrics = { expected_rows: rows.length, observed_rows: observed.length, first_mismatch_index: mismatch === -1 ? null : mismatch }
  if (mismatch !== -1) {
    return failGate('dataset_matches', 'DATASET_MISMATCH', {
      evidence_ids: evidenceIds,
      metrics,
      message: 'The observed filtered rows differ from the committed dataset oracle.',
    })
  }
  return passGate('dataset_matches', {
    reason_code: 'DATASET_MATCHED',
    evidence_ids: evidenceIds,
    metrics,
    message: 'The observed filtered rows exactly match the committed dataset oracle.',
  })
}

function evaluateChart(expectedOracle: unknown, observed: unknown, evidenceIds: readonly string[]): GateOutcome {
  const expected = parseChartSeries(expectedOracle)
  if (!expected.ok) {
    return unevaluableGate('canvas_matches', 'CANVAS_ORACLE_INVALID', { message: 'The committed chart-series oracle is malformed.' })
  }
  const series = parseChartSeries(observed)
  if (!series.ok) {
    return unevaluableGate('canvas_matches', 'CANVAS_OBSERVATION_INVALID', {
      evidence_ids: evidenceIds,
      message: 'The rendered chart observation is missing or malformed, so it cannot be compared.',
    })
  }
  const want = expected.value
  const got = series.value
  if (got.bar_count !== want.bar_count) {
    return failGate('canvas_matches', 'CANVAS_BAR_COUNT_MISMATCH', {
      evidence_ids: evidenceIds,
      metrics: { expected_bars: want.bar_count, observed_bars: got.bar_count },
      message: 'The rendered bar count differs from the committed chart oracle.',
    })
  }
  const labelMismatches = want.labels.filter((label, index) => got.labels[index] !== label).length
  const valueMismatches = want.values.filter((value, index) => got.values[index] !== value).length
  const metrics = {
    expected_bars: want.bar_count,
    observed_bars: got.bar_count,
    label_mismatches: labelMismatches,
    value_mismatches: valueMismatches,
  }
  if (labelMismatches > 0) {
    return failGate('canvas_matches', 'CANVAS_LABEL_MISMATCH', {
      evidence_ids: evidenceIds,
      metrics,
      message: 'A rendered bar label differs from the committed chart oracle.',
    })
  }
  if (valueMismatches > 0) {
    return failGate('canvas_matches', 'CANVAS_VALUE_MISMATCH', {
      evidence_ids: evidenceIds,
      metrics,
      message: 'A rendered bar value differs from the committed chart oracle.',
    })
  }
  return passGate('canvas_matches', {
    reason_code: 'CANVAS_MATCHED',
    evidence_ids: evidenceIds,
    metrics,
    message: 'The rendered bar count, labels, and values exactly match the committed chart oracle.',
  })
}

/** Evaluates `dataset_matches` and `canvas_matches` independently; neither reads the screenshot. */
export function evaluateOracles(input: OracleInput): OracleOutcomes {
  return Object.freeze({
    dataset_matches: evaluateDataset(input.expected.dataset, input.observed.dataset, citedAs('dataset', input.evidence.dataset)),
    canvas_matches: evaluateChart(input.expected.chart, input.observed.chart, citedAs('chart', input.evidence.chart)),
  })
}
