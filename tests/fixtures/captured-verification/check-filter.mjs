// The trusted prepared functional check for the Canvas filter scenario (specs/004-verify-captured-
// changes). FlowProof runs this file from the original checkout, never from a candidate worktree,
// with exactly one argument: the absolute path of the candidate's filter module inside the owned
// verification worktree. Node 24 loads that TypeScript module through its built-in type stripping;
// no loader, transpiler, or package is involved. Every case in the sibling synthetic
// `filter-cases.json` runs against a fresh frozen copy of its rows and must return exactly the
// trusted expected rows, in order, with exact keys and scalar values.
//
// Output is one fixed JSON line of counts; candidate output, values, and errors are never echoed.
// Exit status: 0 when every discovered case executed and passed, 1 on any mismatch, 2 when the
// input or the candidate module cannot be used (zero cases executed). The check performs no network
// access or filesystem writes and reads no environment variables.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CHECK_NAME = 'prepared-region-filter'
const EXPORT_NAME = 'filterByRegion'

const finish = (counts, code) => {
  const summary = { check: CHECK_NAME, discovered: counts.discovered, executed: counts.executed, passed: counts.passed, failed: counts.failed }
  process.stdout.write(`${JSON.stringify(summary)}\n`, () => process.exit(code))
}

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isScalar = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/** Trusted rows and cases; anything malformed stops the check before the candidate loads. */
function readCases() {
  const document = JSON.parse(readFileSync(new URL('./filter-cases.json', import.meta.url), 'utf8'))
  const rowShape = (row) => isPlainObject(row) && Object.values(row).every(isScalar)
  if (!isPlainObject(document) || !Array.isArray(document.rows) || !document.rows.every(rowShape)) throw new Error('rows')
  if (!Array.isArray(document.cases) || document.cases.length === 0) throw new Error('cases')
  for (const entry of document.cases) {
    if (!isPlainObject(entry) || typeof entry.region !== 'string' || !Array.isArray(entry.expected) || !entry.expected.every(rowShape)) {
      throw new Error('case')
    }
  }
  return document
}

const frozenRows = (rows) => Object.freeze(rows.map((row) => Object.freeze({ ...row })))

/** Exact, order-sensitive comparison with exact keys and strictly equal scalar values. */
function matches(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  return expected.every((want, index) => {
    const got = actual[index]
    if (!isPlainObject(got)) return false
    const keys = Object.keys(want)
    return Object.keys(got).length === keys.length && keys.every((key) => Object.hasOwn(got, key) && got[key] === want[key])
  })
}

const counts = { discovered: 0, executed: 0, passed: 0, failed: 0 }
const args = process.argv.slice(2)
let document
try {
  if (args.length !== 1 || !path.isAbsolute(args[0])) throw new Error('usage')
  document = readCases()
} catch {
  finish(counts, 2)
}

if (document !== undefined) {
  counts.discovered = document.cases.length
  let filter
  try {
    const candidate = await import(pathToFileURL(args[0]).href)
    filter = candidate[EXPORT_NAME]
    if (typeof filter !== 'function') throw new Error('export')
  } catch {
    filter = undefined
  }
  if (filter === undefined) {
    finish(counts, 2)
  } else {
    for (const entry of document.cases) {
      counts.executed += 1
      let actual
      try {
        actual = filter(frozenRows(document.rows), entry.region)
      } catch {
        actual = undefined
      }
      if (matches(actual, entry.expected)) counts.passed += 1
      else counts.failed += 1
    }
    const ok = counts.executed > 0 && counts.executed === counts.discovered && counts.passed === counts.executed
    finish(counts, ok ? 0 : 1)
  }
}
