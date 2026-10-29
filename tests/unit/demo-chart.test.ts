import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { INITIAL_REGION, REGION_OPTIONS, salesRows } from '../../apps/demo-chart/src/data.js'
import type { SalesRow } from '../../apps/demo-chart/src/data.js'
import { filterByRegion } from '../../apps/demo-chart/src/filterData.js'
import { PROBE_GLOBAL, installTestProbe, readChartSeries } from '../../apps/demo-chart/src/testProbe.js'
import type { ProbeChart, ProbeSource, TrustedProbe } from '../../apps/demo-chart/src/testProbe.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const committedJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')) as T

interface ChartSeries {
  readonly bar_count: number
  readonly labels: readonly string[]
  readonly values: readonly number[]
}

const hero = committedJson<{
  app: { canvas: { width: number; height: number } }
  actions: Array<{ selector: string; value: string }>
  permitted_source_paths: string[]
}>('scenarios/canvas-filter/hero.json')
const expectedRows = committedJson<SalesRow[]>('scenarios/canvas-filter/expected/filtered-data.json')
const expectedChart = committedJson<ChartSeries>('scenarios/canvas-filter/expected/chart-series.json')
const selectedRegion = hero.actions[0]?.value ?? ''

const chartOf = (rows: readonly SalesRow[]): ChartSeries => ({
  bar_count: rows.length,
  labels: rows.map((row) => row.quarter),
  values: rows.map((row) => row.revenue),
})

function fakeChart(labels: readonly string[], values: readonly number[], rendered = values.length): ProbeChart {
  return {
    data: { labels: [...labels], datasets: [{ data: [...values] }] },
    getDatasetMeta: () => ({ data: Array.from({ length: rendered }, () => ({})) }),
    canvas: { width: hero.app.canvas.width, height: hero.app.canvas.height },
  }
}

function probeHarness(): { target: Record<string, unknown>; probe: TrustedProbe; render(rows: readonly SalesRow[]): void } {
  let chart: ProbeChart | null = null
  let rows: readonly SalesRow[] = []
  let renders = 0
  const source: ProbeSource = {
    chart: () => chart,
    rows: () => rows,
    selectedRegion: () => INITIAL_REGION,
    renderCount: () => renders,
  }
  const target: Record<string, unknown> = {}
  const probe = installTestProbe(target, source)
  return {
    target,
    probe,
    render(next) {
      rows = next
      const series = chartOf(next)
      chart = fakeChart(series.labels, series.values)
      renders += 1
    },
  }
}

describe('known-bad region filter', () => {
  it('reproduces the defect for the committed scenario action', () => {
    const observed = filterByRegion(salesRows, selectedRegion)

    expect(selectedRegion).toBe('North')
    expect(observed).not.toEqual(expectedRows)
    expect(observed).toHaveLength(8)
    expect(new Set(observed.map((row) => row.region))).toEqual(new Set(['North', 'Northeast']))
    expect(observed.slice(0, expectedRows.length)).toEqual(expectedRows)
  })

  it('renders duplicated quarter labels and the wrong bar count for the selected region', () => {
    const observed = chartOf(filterByRegion(salesRows, selectedRegion))

    expect(observed).not.toEqual(expectedChart)
    expect(observed.bar_count).toBe(8)
    expect(observed.labels).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'])
  })

  it('confines the defect to the overlapping region name', () => {
    for (const region of REGION_OPTIONS.map((option) => option.value).filter((value) => value !== 'North')) {
      expect(filterByRegion(salesRows, region), region).toEqual(salesRows.filter((row) => row.region === region))
    }
  })

  it('returns a new array without mutating the committed dataset', () => {
    const before = JSON.stringify(salesRows)
    const observed = filterByRegion(salesRows, selectedRegion)

    expect(observed).not.toBe(salesRows)
    expect(JSON.stringify(salesRows)).toBe(before)
    expect(Object.isFrozen(salesRows)).toBe(true)
  })
})

describe('committed oracles', () => {
  it('derive the dataset oracle from an exact-match reference filter over the committed data', () => {
    expect(salesRows.filter((row) => row.region === selectedRegion)).toEqual(expectedRows)
  })

  it('derive the chart oracle from the dataset oracle', () => {
    expect(expectedChart).toEqual(chartOf(expectedRows))
    expect(expectedChart.bar_count).toBe(4)
  })

  it('select a committed option that differs from the initial selection', () => {
    expect(REGION_OPTIONS.map((option) => option.value)).toContain(selectedRegion)
    expect(INITIAL_REGION).not.toBe(selectedRegion)
    expect(REGION_OPTIONS.map((option) => option.value)).toContain(INITIAL_REGION)
    expect(hero.actions[0]?.selector).toBe('#region-filter')
  })
})

describe('readChartSeries', () => {
  it('reads labels and values from the chart instance', () => {
    expect(readChartSeries(fakeChart(['Q1', 'Q2'], [120, 135]))).toEqual({
      bar_count: 2,
      labels: ['Q1', 'Q2'],
      values: [120, 135],
    })
  })

  it('counts rendered bar elements rather than trusting configured data', () => {
    const series = readChartSeries(fakeChart(['Q1', 'Q2', 'Q3'], [1, 2, 3], 2))

    expect(series.bar_count).toBe(2)
    expect(series.values).toEqual([1, 2, 3])
  })

  it('returns frozen copies', () => {
    const chart = fakeChart(['Q1'], [120])
    const series = readChartSeries(chart)
    ;(chart.data.labels as string[]).push('Q2')

    expect(Object.isFrozen(series)).toBe(true)
    expect(Object.isFrozen(series.labels)).toBe(true)
    expect(series.labels).toEqual(['Q1'])
  })
})

describe('trusted test probe', () => {
  it('installs a read-only, non-configurable global', () => {
    const { target, probe } = probeHarness()
    const descriptor = Object.getOwnPropertyDescriptor(target, PROBE_GLOBAL)

    expect(descriptor?.value).toBe(probe)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(() => {
      target[PROBE_GLOBAL] = {}
    }).toThrow()
    expect(() => delete target[PROBE_GLOBAL]).toThrow()
    expect(() => Object.defineProperty(target, PROBE_GLOBAL, { value: {} })).toThrow()
  })

  it('refuses a second installation', () => {
    const { target } = probeHarness()
    const source: ProbeSource = { chart: () => null, rows: () => [], selectedRegion: () => '', renderCount: () => 0 }

    expect(() => installTestProbe(target, source)).toThrow(/PROBE_ALREADY_INSTALLED/)
  })

  it('exposes only frozen read operations', () => {
    const { probe } = probeHarness()

    expect(Object.isFrozen(probe)).toBe(true)
    expect(probe.version).toBe(1)
    for (const key of Object.keys(probe).filter((name) => name !== 'version')) {
      expect(key).toMatch(/^(?:read|is)[A-Z]/)
    }
  })

  it('is not ready until the chart has rendered', () => {
    const { probe, render } = probeHarness()

    expect(probe.isReady()).toBe(false)
    expect(probe.readState()).toEqual({ ready: false, selected_region: INITIAL_REGION, render_count: 0 })
    expect(() => probe.readChartSeries()).toThrow(/PROBE_NOT_READY/)

    render(filterByRegion(salesRows, INITIAL_REGION))

    expect(probe.isReady()).toBe(true)
    expect(probe.readState().render_count).toBe(1)
  })

  it('reports the rendered dataset, chart series, and fixed Canvas size', () => {
    const { probe, render } = probeHarness()
    render(filterByRegion(salesRows, selectedRegion))

    expect(probe.readDataset()).toEqual(filterByRegion(salesRows, selectedRegion))
    expect(probe.readChartSeries()).toEqual(chartOf(filterByRegion(salesRows, selectedRegion)))
    expect(probe.readCanvasSize()).toEqual(hero.app.canvas)
  })

  it('returns detached snapshots that callers cannot use to alter the app', () => {
    const { probe, render } = probeHarness()
    render(expectedRows)

    const dataset = probe.readDataset()
    const series = probe.readChartSeries()

    expect(Object.isFrozen(dataset)).toBe(true)
    expect(Object.isFrozen(dataset[0])).toBe(true)
    expect(Object.isFrozen(series.values)).toBe(true)
    expect(() => (dataset as SalesRow[]).push(expectedRows[0] as SalesRow)).toThrow()
    expect(probe.readDataset()).toEqual(expectedRows)
  })
})

describe('patch boundary', () => {
  it('permits only the filter module; the probe, entry point, and data stay outside', () => {
    expect(hero.permitted_source_paths).toEqual(['apps/demo-chart/src/filterData.ts'])
    for (const outside of ['apps/demo-chart/src/testProbe.ts', 'apps/demo-chart/src/main.ts', 'apps/demo-chart/src/data.ts']) {
      expect(hero.permitted_source_paths).not.toContain(outside)
    }
  })

  it('resolves the committed Hero scenario against the demo application files', async () => {
    const loaded = await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })

    expect(loaded.resolved.permittedSourcePaths).toEqual([
      fileURLToPath(new URL('../../apps/demo-chart/src/filterData.ts', import.meta.url)),
    ])
    expect(loaded.oracle.dataset).toEqual(expectedRows)
    expect(loaded.oracle.chart).toEqual(expectedChart)
  })
})
