// Synthetic quarterly revenue used only by the FlowProof demo fixture. The values are
// invented for this project and carry no real business data.

export type SalesRow = {
  readonly region: string
  readonly quarter: string
  readonly revenue: number
}

export interface RegionOption {
  readonly value: string
  readonly label: string
}

const row = (region: string, quarter: string, revenue: number): SalesRow => Object.freeze({ region, quarter, revenue })

export const salesRows: readonly SalesRow[] = Object.freeze([
  row('North', 'Q1', 120),
  row('North', 'Q2', 135),
  row('North', 'Q3', 128),
  row('North', 'Q4', 150),
  row('Northeast', 'Q1', 95),
  row('Northeast', 'Q2', 102),
  row('Northeast', 'Q3', 110),
  row('Northeast', 'Q4', 99),
  row('South', 'Q1', 80),
  row('South', 'Q2', 88),
  row('South', 'Q3', 92),
  row('South', 'Q4', 101),
  row('West', 'Q1', 140),
  row('West', 'Q2', 132),
  row('West', 'Q3', 145),
  row('West', 'Q4', 158),
])

export const REGION_OPTIONS: readonly RegionOption[] = Object.freeze(
  ['North', 'Northeast', 'South', 'West'].map((region) => Object.freeze({ value: region, label: region })),
)

export const INITIAL_REGION = 'South'
