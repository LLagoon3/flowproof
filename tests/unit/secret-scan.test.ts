import { describe, expect, it } from 'vitest'

import { sanitizeArtifact } from '../../packages/flowproof/src/evidence/sanitize.js'
import { createSecretScanner } from '../../packages/flowproof/src/evidence/secretScan.js'

// Seeded markers are synthetic credential-shaped values, so the sanitizer is expected
// to remove them and this scanner proves that it did.
const MARKERS = ['sk-flowproofseededalpha000001', 'sk-flowproofseededbeta0000002'] as const

describe('createSecretScanner', () => {
  it('reports a clean scan for sanitized evidence', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('evidence/failure/dataset.json', {
      rows: [{ region: 'North', quarter: 'Q1', revenue: 120 }],
      digest: 'a'.repeat(64),
    })

    expect(report.clean).toBe(true)
    expect(report.findings).toEqual([])
  })

  it('detects a seeded marker anywhere in a nested structure', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('evidence/failure/console.json', {
      entries: [{ level: 'error', text: `token ${MARKERS[1]} rejected` }],
    })

    expect(report.clean).toBe(false)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.category).toBe('seeded-marker')
    expect(report.findings[0]?.path).toBe('evidence/failure/console.json:entries.0.text')
  })

  it('reports one finding per location, preferring the seeded-marker category', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('artifact', { note: `Bearer ${MARKERS[0]}` })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.category).toBe('seeded-marker')
  })

  it('detects a seeded marker used as an object key', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('artifact', { [MARKERS[0]]: 'value' })

    expect(report.clean).toBe(false)
  })

  it('never includes the matched secret value in its findings', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('chat', { text: `my key is ${MARKERS[0]}` })

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(MARKERS[0])
    expect(serialized).toContain('seeded-marker')
  })

  it('detects credential-shaped values that sanitization should have removed', () => {
    const scanner = createSecretScanner({ markers: MARKERS })

    expect(scanner.scan('a', { note: 'Bearer tokenvalue111111' }).clean).toBe(false)
    expect(scanner.scan('b', { note: 'sk-abcdefghijklmnopqrstuvwx' }).clean).toBe(false)
    expect(scanner.scan('c', { authorization: 'anything' }).clean).toBe(false)
    expect(scanner.scan('d', { note: 'MODEL_API_KEY=sk-abcdefghijklmnopqrstuvwx' }).clean).toBe(false)
  })

  it('does not flag content digests or ordinary dataset values', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scan('manifest', {
      manifest_sha256: 'b'.repeat(64),
      original_head: '0123456789abcdef0123456789abcdef01234567',
      values: [120, 145, 130, 160],
    })

    expect(report.clean).toBe(true)
  })

  it('scans every section of a whole run and aggregates findings', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const report = scanner.scanRun({
      artifacts: { 'evidence/failure/dataset.json': { rows: [] } },
      events: [{ message: 'Captured the failing dataset.' }],
      provider_request: { goal: `use ${MARKERS[0]}` },
      result: { status: 'Unverified' },
    })

    expect(report.clean).toBe(false)
    expect(report.findings.map((finding) => finding.path)).toEqual(['provider_request:goal'])
  })

  it('passes a whole run whose every section is sanitized', () => {
    const scanner = createSecretScanner({ markers: MARKERS })
    const sanitized = sanitizeArtifact({ text: `chat mentions ${MARKERS[0]}` })
    const report = scanner.scanRun({
      artifacts: { 'evidence/failure/chat.json': sanitized.value },
      events: [],
      provider_request: {},
      result: { status: 'Verified Fix' },
    })

    expect(report.clean).toBe(true)
  })

  it('requires at least one marker so a scan can never pass vacuously', () => {
    expect(() => createSecretScanner({ markers: [] })).toThrow(/SECRET_SCAN_MARKERS_REQUIRED/)
  })
})
