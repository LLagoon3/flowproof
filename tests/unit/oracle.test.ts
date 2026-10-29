import { describe, expect, it } from 'vitest'

import { salesRows } from '../../apps/demo-chart/src/data.js'
import type { SalesRow } from '../../apps/demo-chart/src/data.js'
import { filterByRegion } from '../../apps/demo-chart/src/filterData.js'
import { GATE_IDS, GateOutcomeSchema } from '../../packages/flowproof/src/contracts/index.js'
import type { ChartSeries, GateOutcome, OracleDataset } from '../../packages/flowproof/src/contracts/index.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { passGate, reduceGates } from '../../packages/flowproof/src/verify/gates.js'
import { loadPendingModule } from '../support/pendingModule.js'
import { REPO_ROOT } from '../support/repoFixture.js'

// T033: exact dataset and rendered-chart oracle evaluation that T041 implements in
// `packages/flowproof/src/verify/oracle.ts`. Rows compare in order with exact keys and scalar
// types; the Canvas gate compares the trusted probe's bar count, labels, and values. A
// screenshot is review evidence only and never changes either outcome.

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

export interface OracleModule {
  evaluateOracles(input: OracleInput): OracleOutcomes
}

const oracleModule = (): Promise<OracleModule> =>
  loadPendingModule<OracleModule>('packages/flowproof/src/verify/oracle.ts', 'T041', ['evaluateOracles'])

const EVIDENCE = { dataset: ['ev_replay_dataset_001'], chart: ['ev_replay_chart_001'] }
const loaded = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })
const expected = { dataset: loaded.oracle.dataset, chart: loaded.oracle.chart }

const chartOf = (rows: readonly SalesRow[]): ChartSeries => ({
  bar_count: rows.length,
  labels: rows.map((row) => row.quarter),
  values: rows.map((row) => row.revenue),
})

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const knownBadRows = plain(filterByRegion(salesRows, 'North'))
const fixedRows = plain(salesRows.filter((row) => row.region === 'North'))

async function evaluate(observed: OracleInput['observed'], evidence = EVIDENCE): Promise<OracleOutcomes> {
  const { evaluateOracles } = await oracleModule()
  const outcomes = evaluateOracles({ expected, observed, evidence })
  expect(Object.keys(outcomes).sort()).toEqual(['canvas_matches', 'dataset_matches'])
  for (const gateId of ['dataset_matches', 'canvas_matches'] as const) {
    expect(GateOutcomeSchema.safeParse(outcomes[gateId]).success).toBe(true)
    expect(outcomes[gateId].gate_id).toBe(gateId)
  }
  return outcomes
}

describe('dataset and Canvas oracles', () => {
  it('passes both gates when the replay matches the committed oracles exactly', async () => {
    const outcomes = await evaluate({ dataset: plain(expected.dataset), chart: plain(expected.chart) })

    expect(outcomes.dataset_matches).toMatchObject({ status: 'pass', evidence_ids: EVIDENCE.dataset })
    expect(outcomes.canvas_matches).toMatchObject({ status: 'pass', evidence_ids: EVIDENCE.chart })
  })

  it('fails both gates for the known-bad filter and passes them for the exact-match fix', async () => {
    expect(knownBadRows).toHaveLength(8)
    const bad = await evaluate({ dataset: knownBadRows, chart: chartOf(knownBadRows) })
    expect(bad.dataset_matches).toMatchObject({ status: 'fail', reason_code: 'DATASET_MISMATCH' })
    expect(bad.canvas_matches).toMatchObject({ status: 'fail', reason_code: 'CANVAS_BAR_COUNT_MISMATCH' })

    const fixed = await evaluate({ dataset: fixedRows, chart: chartOf(fixedRows) })
    expect(fixed.dataset_matches.status).toBe('pass')
    expect(fixed.canvas_matches.status).toBe('pass')
  })

  it.each([
    ['reordered rows', [...fixedRows].reverse()],
    ['a missing row', fixedRows.slice(0, 3)],
    ['an extra row', [...fixedRows, fixedRows[0]]],
    ['a string where the oracle has a number', fixedRows.map((row, index) => (index === 1 ? { ...row, revenue: String(row.revenue) } : row))],
    ['an extra key', fixedRows.map((row, index) => (index === 2 ? { ...row, note: 'x' } : row))],
    ['a missing key', fixedRows.map((row, index) => (index === 3 ? { region: row.region, quarter: row.quarter } : row))],
    ['a near value', fixedRows.map((row, index) => (index === 0 ? { ...row, revenue: row.revenue + 1e-9 } : row))],
  ])('fails the dataset gate for %s while the Canvas gate is evaluated independently', async (_label, rows) => {
    const outcomes = await evaluate({ dataset: rows, chart: plain(expected.chart) })

    expect(outcomes.dataset_matches).toMatchObject({ status: 'fail', reason_code: 'DATASET_MISMATCH' })
    expect(outcomes.canvas_matches.status).toBe('pass')
  })

  it.each([
    ['a different bar count', { bar_count: 3, labels: ['Q1', 'Q2', 'Q3'], values: [120, 135, 128] }, 'CANVAS_BAR_COUNT_MISMATCH'],
    ['a different label', { ...expected.chart, labels: ['Q1', 'Q2', 'Q3', 'Q5'] }, 'CANVAS_LABEL_MISMATCH'],
    ['reordered labels', { ...expected.chart, labels: ['Q2', 'Q1', 'Q3', 'Q4'] }, 'CANVAS_LABEL_MISMATCH'],
    ['a different value', { ...expected.chart, values: [120, 135, 128, 151] }, 'CANVAS_VALUE_MISMATCH'],
    ['a near value', { ...expected.chart, values: [120, 135, 128, 150.000001] }, 'CANVAS_VALUE_MISMATCH'],
  ])('fails the Canvas gate for %s while the dataset gate is evaluated independently', async (_label, chart, code) => {
    const outcomes = await evaluate({ dataset: plain(expected.dataset), chart })

    expect(outcomes.canvas_matches).toMatchObject({ status: 'fail', reason_code: code })
    expect(outcomes.dataset_matches.status).toBe('pass')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not an array or series', 'PROBE_NOT_READY'],
    ['an inconsistent series', { bar_count: 4, labels: ['Q1', 'Q2', 'Q3'], values: [120, 135, 128, 150] }],
    ['non-numeric values', { bar_count: 4, labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [120, 135, 128, 'x'] }],
  ])('reports a %s chart observation as unevaluable, never as a pass', async (_label, chart) => {
    const outcomes = await evaluate({ dataset: plain(expected.dataset), chart })

    expect(outcomes.canvas_matches.status).toBe('unevaluable')
    expect(outcomes.dataset_matches.status).toBe('pass')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not an array', { rows: [] }],
    ['rows that are not objects', ['North', 'Q1', 120]],
  ])('reports a %s dataset observation as unevaluable, never as a pass', async (_label, dataset) => {
    const outcomes = await evaluate({ dataset, chart: plain(expected.chart) })

    expect(outcomes.dataset_matches.status).toBe('unevaluable')
    expect(outcomes.canvas_matches.status).toBe('pass')
  })

  it('never mutates the committed oracles or the observation', async () => {
    const observed = Object.freeze({
      dataset: Object.freeze([...fixedRows].reverse().map((row) => Object.freeze(row))),
      chart: Object.freeze({ ...expected.chart, labels: Object.freeze([...expected.chart.labels]) }),
    })
    const before = plain({ expected, observed })

    await evaluate(observed)

    expect(plain({ expected, observed })).toEqual(before)
    expect(Object.isFrozen(loaded.oracle.dataset)).toBe(true)
  })
})

describe('screenshots are excluded from status reduction', () => {
  const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])

  it.each([
    ['no screenshot', undefined],
    ['a missing screenshot', null],
    ['one screenshot', PNG_A],
    ['a visually different screenshot', PNG_B],
    ['bytes that are not an image', Uint8Array.from([0, 1, 2])],
    ['a screenshot path', 'evidence/replay/screenshot.png'],
  ])('produces identical gate outcomes with %s', async (_label, screenshot) => {
    const matching = { dataset: fixedRows, chart: chartOf(fixedRows) }
    const failing = { dataset: knownBadRows, chart: chartOf(knownBadRows) }

    expect(await evaluate({ ...matching, screenshot })).toEqual(await evaluate(matching))
    expect(await evaluate({ ...failing, screenshot })).toEqual(await evaluate(failing))
  })

  it('cites dataset and chart evidence only, and has no screenshot gate to reduce', async () => {
    const outcomes = await evaluate({ dataset: fixedRows, chart: chartOf(fixedRows), screenshot: PNG_B })

    for (const outcome of [outcomes.dataset_matches, outcomes.canvas_matches]) {
      expect(outcome.evidence_ids.some((id) => id.includes('_screenshot_'))).toBe(false)
    }
    expect(GATE_IDS.some((gateId) => gateId.includes('screenshot') || gateId.includes('pixel'))).toBe(false)

    // With every other gate passing, the oracle outcomes alone decide `Verified Fix`.
    const others = GATE_IDS.filter((gateId) => gateId !== 'dataset_matches' && gateId !== 'canvas_matches').map((gateId) =>
      passGate(gateId),
    )
    expect(reduceGates([...others, outcomes.dataset_matches, outcomes.canvas_matches]).status).toBe('Verified Fix')
  })
})
