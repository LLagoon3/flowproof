import { BarController, BarElement, CategoryScale, Chart, LinearScale } from 'chart.js'

import { INITIAL_REGION, REGION_OPTIONS, salesRows } from './data.js'
import type { SalesRow } from './data.js'
import { filterByRegion } from './filterData.js'
import { installTestProbe } from './testProbe.js'

// Fixed Canvas size and disabled animation keep failure and replay renders comparable.
const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 360

Chart.register(BarController, BarElement, CategoryScale, LinearScale)

const app = document.getElementById('app')

if (!app) {
  throw new Error('The demo chart root element is missing.')
}

const heading = document.createElement('h1')
heading.textContent = 'Quarterly revenue by region'

const label = document.createElement('label')
label.htmlFor = 'region-filter'
label.textContent = 'Region '

const select = document.createElement('select')
select.id = 'region-filter'
for (const option of REGION_OPTIONS) {
  const element = document.createElement('option')
  element.value = option.value
  element.textContent = option.label
  select.append(element)
}
select.value = INITIAL_REGION
label.append(select)

const canvas = document.createElement('canvas')
canvas.id = 'revenue-chart'
canvas.width = CANVAS_WIDTH
canvas.height = CANVAS_HEIGHT

app.append(heading, label, canvas)

let rows: readonly SalesRow[] = filterByRegion(salesRows, select.value)
let renderCount = 0

const chart = new Chart<'bar', number[], string>(canvas, {
  type: 'bar',
  data: {
    labels: rows.map((row) => row.quarter),
    datasets: [{ label: 'Revenue', data: rows.map((row) => row.revenue), backgroundColor: '#2563eb' }],
  },
  options: {
    responsive: false,
    animation: false,
    devicePixelRatio: 1,
  },
})
renderCount = 1

installTestProbe(window, {
  chart: () => chart,
  rows: () => rows,
  selectedRegion: () => select.value,
  renderCount: () => renderCount,
})

select.addEventListener('change', () => {
  rows = filterByRegion(salesRows, select.value)
  chart.data.labels = rows.map((row) => row.quarter)
  const [dataset] = chart.data.datasets
  if (dataset) dataset.data = rows.map((row) => row.revenue)
  chart.update()
  renderCount += 1
})
