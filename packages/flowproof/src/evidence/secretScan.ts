import { REDACTED, containsSecretPattern, isSecretKeyName } from './sanitize.js'

// Whole-run leak detection. Seeded synthetic markers prove that sanitization removed known
// secrets; credential shapes and secret-named keys catch anything sanitization missed.
// Findings name only a location and a category, never the matched value.

export type SecretFindingCategory = 'seeded-marker' | 'credential-pattern' | 'secret-key'

export interface SecretFinding {
  readonly path: string
  readonly category: SecretFindingCategory
}

export interface SecretScanReport {
  readonly clean: boolean
  readonly findings: readonly SecretFinding[]
}

/** Every surface a run can emit: persisted artifacts, Studio events, the model request, and the result. */
export interface RunScanInput {
  readonly artifacts: Readonly<Record<string, unknown>>
  readonly events: readonly unknown[]
  readonly provider_request: unknown
  readonly result: unknown
}

export interface SecretScanner {
  scan(label: string, value: unknown): SecretScanReport
  scanRun(run: RunScanInput): SecretScanReport
}

export class SecretScanError extends Error {
  readonly code: 'SECRET_SCAN_MARKERS_REQUIRED' | 'SECRET_SCAN_MARKER_INVALID'

  constructor(code: SecretScanError['code'], message: string) {
    super(`${code}: ${message}`)
    this.name = 'SecretScanError'
    this.code = code
  }
}

const MIN_MARKER_LENGTH = 8

export function createSecretScanner(options: { readonly markers: readonly string[] }): SecretScanner {
  const markers = [...options.markers]
  if (markers.length === 0) {
    throw new SecretScanError('SECRET_SCAN_MARKERS_REQUIRED', 'A scan needs at least one seeded marker.')
  }
  if (markers.some((marker) => typeof marker !== 'string' || marker.length < MIN_MARKER_LENGTH)) {
    throw new SecretScanError('SECRET_SCAN_MARKER_INVALID', 'Seeded markers must be strings of at least eight characters.')
  }

  const classifyText = (text: string): SecretFindingCategory | null => {
    if (markers.some((marker) => text.includes(marker))) return 'seeded-marker'
    return containsSecretPattern(text) ? 'credential-pattern' : null
  }

  const walk = (
    value: unknown,
    label: string,
    trail: readonly string[],
    findings: SecretFinding[],
    ancestors: Set<object>,
  ): void => {
    const at = (segments: readonly string[]): string => (segments.length > 0 ? `${label}:${segments.join('.')}` : label)
    if (typeof value === 'string') {
      const category = classifyText(value)
      if (category) findings.push(Object.freeze({ path: at(trail), category }))
      return
    }
    if (value instanceof Uint8Array) {
      // Binary artifacts are checked for seeded markers only; credential shapes would misfire.
      const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1')
      if (markers.some((marker) => text.includes(marker))) {
        findings.push(Object.freeze({ path: at(trail), category: 'seeded-marker' }))
      }
      return
    }
    if (typeof value !== 'object' || value === null || ancestors.has(value)) return
    ancestors.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, label, [...trail, String(index)], findings, ancestors))
    } else {
      Object.entries(value).forEach(([key, child], index) => {
        const keyCategory = classifyText(key)
        if (keyCategory) {
          // A secret used as a key must not appear in the reported location.
          findings.push(Object.freeze({ path: at([...trail, `<key:${index}>`]), category: keyCategory }))
          return
        }
        const childTrail = [...trail, key]
        if (isSecretKeyName(key) && child !== null && child !== undefined && child !== '' && child !== REDACTED) {
          const valueCategory = typeof child === 'string' ? classifyText(child) : null
          const category = valueCategory === 'seeded-marker' ? 'seeded-marker' : 'secret-key'
          findings.push(Object.freeze({ path: at(childTrail), category }))
          return
        }
        walk(child, label, childTrail, findings, ancestors)
      })
    }
    ancestors.delete(value)
  }

  const report = (findings: SecretFinding[]): SecretScanReport =>
    Object.freeze({ clean: findings.length === 0, findings: Object.freeze(findings) })

  return Object.freeze({
    scan(label: string, value: unknown): SecretScanReport {
      const findings: SecretFinding[] = []
      walk(value, label, [], findings, new Set())
      return report(findings)
    },
    scanRun(run: RunScanInput): SecretScanReport {
      const findings: SecretFinding[] = []
      for (const [artifactPath, artifact] of Object.entries(run.artifacts)) walk(artifact, artifactPath, [], findings, new Set())
      walk(run.events, 'events', [], findings, new Set())
      walk(run.provider_request, 'provider_request', [], findings, new Set())
      walk(run.result, 'result', [], findings, new Set())
      return report(findings)
    },
  })
}
