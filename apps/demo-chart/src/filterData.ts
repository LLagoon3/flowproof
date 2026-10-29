import type { SalesRow } from './data.js'

// Returns the rows for the selected region, preserving dataset order.
export function filterByRegion(rows: readonly SalesRow[], region: string): SalesRow[] {
  return rows.filter((row) => row.region.includes(region))
}
