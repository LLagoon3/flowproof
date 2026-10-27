// Trusted, read-only verification probe. It lives outside the permitted patch boundary and
// reports what the Chart.js instance actually rendered: bar elements, labels, values, and
// Canvas size. Every read returns a detached frozen copy, so callers cannot alter the app.

export const PROBE_GLOBAL = '__flowproofProbe'

export interface ChartSeriesSnapshot {
  readonly bar_count: number
  readonly labels: readonly string[]
  readonly values: readonly number[]
}

export interface CanvasSize {
  readonly width: number
  readonly height: number
}

export interface ProbeState {
  readonly ready: boolean
  readonly selected_region: string
  readonly render_count: number
}

export type ProbeRow = Readonly<Record<string, string | number>>

/** The subset of a Chart.js instance the probe reads. */
export interface ProbeChart {
  readonly data: {
    readonly labels?: readonly unknown[] | undefined
    readonly datasets: readonly { readonly data: readonly unknown[] }[]
  }
  getDatasetMeta(index: number): { readonly data: readonly unknown[] }
  readonly canvas: { readonly width: number; readonly height: number } | null
}

/** Read-only view of the app supplied by the entry point. */
export interface ProbeSource {
  chart(): ProbeChart | null
  rows(): readonly ProbeRow[]
  selectedRegion(): string
  renderCount(): number
}

export interface TrustedProbe {
  readonly version: 1
  isReady(): boolean
  readState(): ProbeState
  readDataset(): readonly ProbeRow[]
  readChartSeries(): ChartSeriesSnapshot
  readCanvasSize(): CanvasSize
}

/** Reads the rendered bar count from chart elements and labels and values from chart data. */
export function readChartSeries(chart: ProbeChart): ChartSeriesSnapshot {
  const labels = (chart.data.labels ?? []).map((label) => String(label))
  const values = (chart.data.datasets[0]?.data ?? []).map((value) => Number(value))
  return Object.freeze({
    bar_count: chart.getDatasetMeta(0).data.length,
    labels: Object.freeze(labels),
    values: Object.freeze(values),
  })
}

function renderedChart(source: ProbeSource): ProbeChart {
  const chart = source.chart()
  if (chart === null || source.renderCount() < 1) throw new Error('PROBE_NOT_READY: the chart has not rendered yet.')
  return chart
}

/** Installs the probe as a non-writable, non-configurable global; a second install fails. */
export function installTestProbe(target: object, source: ProbeSource): TrustedProbe {
  if (Object.prototype.hasOwnProperty.call(target, PROBE_GLOBAL)) {
    throw new Error('PROBE_ALREADY_INSTALLED: the trusted probe is already present.')
  }
  const probe: TrustedProbe = Object.freeze({
    version: 1,
    isReady: () => source.chart() !== null && source.renderCount() > 0,
    readState: () =>
      Object.freeze({
        ready: source.chart() !== null && source.renderCount() > 0,
        selected_region: source.selectedRegion(),
        render_count: source.renderCount(),
      }),
    readDataset: () => {
      renderedChart(source)
      return Object.freeze(source.rows().map((row) => Object.freeze({ ...row })))
    },
    readChartSeries: () => readChartSeries(renderedChart(source)),
    readCanvasSize: () => {
      const canvas = renderedChart(source).canvas
      if (canvas === null) throw new Error('PROBE_NOT_READY: the chart has no Canvas.')
      return Object.freeze({ width: canvas.width, height: canvas.height })
    },
  })
  Object.defineProperty(target, PROBE_GLOBAL, { value: probe, writable: false, configurable: false, enumerable: false })
  return probe
}
