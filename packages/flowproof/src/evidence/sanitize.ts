import path from 'node:path'

import { MAX_CHAT_TEXT_LENGTH, REDACTION_CATEGORIES } from '../contracts/index.js'
import type { Redaction, RedactionCategory } from '../contracts/index.js'

// Redaction runs before anything is persisted, hashed, displayed, or sent to the model.
// Results report only categories and counts, never the removed values.

export { MAX_CHAT_TEXT_LENGTH }

export const REDACTED = '[REDACTED]'
export const MAX_CONSOLE_TEXT_LENGTH = 2000
/** Replaces console text that is too long to keep whole; such text is never scanned or cut. */
export const CONSOLE_TEXT_OMITTED = `[OMITTED: console text longer than ${MAX_CONSOLE_TEXT_LENGTH} characters]`
/** Longer request URLs are reduced to placeholders rather than parsed, scanned, and persisted. */
export const MAX_NETWORK_URL_LENGTH = 2048

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface Sanitized<T> {
  readonly value: T
  readonly redactions: readonly Redaction[]
}

export class SanitizeError extends Error {
  readonly code = 'SANITIZE_UNSUPPORTED_VALUE'

  constructor(message: string) {
    super(`SANITIZE_UNSUPPORTED_VALUE: ${message}`)
    this.name = 'SanitizeError'
  }
}

class RedactionTally {
  private readonly counts = new Map<RedactionCategory, number>()

  add(category: RedactionCategory, count = 1): void {
    if (count > 0) this.counts.set(category, (this.counts.get(category) ?? 0) + count)
  }

  merge(redactions: readonly Redaction[]): void {
    for (const redaction of redactions) this.add(redaction.category, redaction.count)
  }

  toArray(): readonly Redaction[] {
    return Object.freeze(
      REDACTION_CATEGORIES.filter((category) => this.counts.has(category)).map((category) =>
        Object.freeze({ category, count: this.counts.get(category) ?? 0 }),
      ),
    )
  }
}

interface TextRule {
  readonly category: RedactionCategory
  readonly pattern: RegExp
  readonly replace: (...groups: string[]) => string
}

// Skips values that an earlier pass already redacted, keeping sanitization idempotent. The
// optional whitespace lets the check see a placeholder past the separator's whitespace.
const NOT_REDACTED = String.raw`(?!\s*["']?\[REDACTED\])`
// A secret name is a whole run of name characters ending in a secret word, matched from the
// run's start; `\b` also matches inside runs such as `a.b-c`.
const NAME_START = String.raw`(?<![A-Za-z0-9_.-])`
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|secret[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key)`

// Order matters: structured forms (headers, URLs, assignments) consume their values before
// the bare token shapes run, so one secret is counted once.
//
// Long runs are scanned once, not once per possible start or split:
// - A name, URL scheme, or URL that can start inside a run of its own characters is tried only
//   at the run's first possible start. Every later start reaches the same end and fails alike.
// - A separator's whitespace ends in `(?!\s)`: no value starts with whitespace, so a shorter
//   split cannot match and would only rerun NOT_REDACTED over the rest of the run. Cookie
//   values may start with whitespace, so that rule checks NOT_REDACTED once, before them.
const TEXT_RULES: readonly TextRule[] = [
  {
    category: 'credential',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
  {
    category: 'cookie',
    pattern: new RegExp(String.raw`\b(set-cookie|cookie)(\s*:${NOT_REDACTED}\s*)[^\r\n]+`, 'gi'),
    replace: (_match, name, separator) => `${name}${separator}${REDACTED}`,
  },
  {
    category: 'credential',
    pattern: new RegExp(
      String.raw`\b(proxy-authorization|authorization)(["']?\s*[:=]\s*(?!\s)["']?)${NOT_REDACTED}(?:(?:bearer|basic|digest|token)\s+)?[^\s,;'"]+`,
      'gi',
    ),
    replace: (_match, name, separator) => `${name}${separator}${REDACTED}`,
  },
  {
    category: 'credential',
    pattern: /\b(?=[a-z])(?<!\b[a-z][a-z0-9+.-]*?)([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    category: 'query',
    pattern: /\b(?=https?:\/\/)(?<!\bhttps?:\/\/[^\s?#"'<>]*?)(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi,
    replace: (_match, base) => base ?? '',
  },
  {
    category: 'credential',
    pattern: new RegExp(
      String.raw`${NAME_START}(${SECRET_NAME})(["']?\s*[:=]\s*(?!\s))(["'])${NOT_REDACTED}(?:\\.|(?!\3)[^\\\r\n])*\3`,
      'gi',
    ),
    replace: (_match, name, separator, quote) => `${name}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    category: 'credential',
    pattern: new RegExp(
      String.raw`${NAME_START}(${SECRET_NAME})(["']?\s*[:=]\s*(?!\s))(["']?)${NOT_REDACTED}([^\s"'\`,;&]+)\3`,
      'gi',
    ),
    replace: (_match, name, separator, quote) => `${name}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    category: 'credential',
    pattern: new RegExp(String.raw`\b(bearer)\s+(?!\s)${NOT_REDACTED}[\w.~+/-]{8,}=*`, 'gi'),
    replace: (_match, scheme) => `${scheme} ${REDACTED}`,
  },
  { category: 'credential', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  { category: 'credential', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: () => REDACTED },
  { category: 'credential', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: () => REDACTED },
  { category: 'credential', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTED },
  {
    category: 'credential',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
]

function applyTextRules(text: string, tally: RedactionTally): string {
  let current = text
  for (const rule of TEXT_RULES) {
    current = current.replace(rule.pattern, (...args: unknown[]) => {
      tally.add(rule.category)
      const groups = args.slice(1, -2).map((group) => (typeof group === 'string' ? group : ''))
      return rule.replace(String(args[0]), ...groups)
    })
  }
  return current
}

/** Redacts credentials, cookies, URL userinfo, and URL query strings inside free text. */
export function sanitizeText(text: string): Sanitized<string> {
  const tally = new RedactionTally()
  const value = applyTextRules(text, tally)
  return Object.freeze({ value, redactions: tally.toArray() })
}

/** True when text still contains a credential or cookie shape the sanitizer would remove. */
export function containsSecretPattern(text: string): boolean {
  return sanitizeText(text).redactions.some((redaction) => redaction.category === 'credential' || redaction.category === 'cookie')
}

const SECRET_KEY_SUFFIXES = [
  'password',
  'passwd',
  'secret',
  'apikey',
  'token',
  'privatekey',
  'accesskey',
  'authorization',
  'cookie',
  'credentials',
  'credential',
] as const

/** True for object keys whose values are secrets by name, such as `authorization` or `api_key`. */
export function isSecretKeyName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

const keyCategory = (key: string): RedactionCategory => (/cookie/i.test(key) ? 'cookie' : 'credential')

// ---------------------------------------------------------------------------------------
// Structured inputs
// ---------------------------------------------------------------------------------------

const SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'vary',
])

/** Keeps only allowlisted, non-identifying headers; everything else is dropped and counted. */
export function sanitizeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | number | undefined>>,
): Sanitized<Readonly<Record<string, string>>> {
  const tally = new RedactionTally()
  const kept: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue
    const name = rawName.toLowerCase()
    if (!SAFE_HEADERS.has(name)) {
      tally.add(name.includes('cookie') ? 'cookie' : 'header')
      continue
    }
    const joined = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
    kept[name] = applyTextRules(joined, tally)
  }
  return Object.freeze({ value: Object.freeze(kept), redactions: tally.toArray() })
}

/** Reduces a URL to origin plus path; userinfo, query, and fragment are removed. */
export function sanitizeUrl(raw: string): Sanitized<string> {
  const tally = new RedactionTally()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    tally.add('path')
    return Object.freeze({ value: REDACTED, redactions: tally.toArray() })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    tally.add('path')
    return Object.freeze({ value: REDACTED, redactions: tally.toArray() })
  }
  if (url.username || url.password) tally.add('credential')
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) tally.add('query')
  const pathname = applyTextRules(url.pathname, tally)
  return Object.freeze({ value: `${url.origin}${pathname}`, redactions: tally.toArray() })
}

export interface NetworkObservation {
  readonly method: string
  readonly origin: string
  readonly path: string
  readonly status: number
  readonly mime_type: string | null
  readonly duration_ms: number | null
}

export interface RawNetworkObservation {
  readonly method: string
  readonly url: string
  readonly status: number
  readonly mime_type?: string | null
  readonly duration_ms?: number | null
  readonly [extra: string]: unknown
}

const NETWORK_METADATA_KEYS = new Set(['method', 'url', 'status', 'mime_type', 'duration_ms'])

/** Keeps only method, origin, query-free path, status, MIME type, and timing. */
export function sanitizeNetworkObservation(raw: RawNetworkObservation): Sanitized<NetworkObservation> {
  const tally = new RedactionTally()
  const method = String(raw.method).toUpperCase()
  let origin = REDACTED
  let pathname = REDACTED
  try {
    if (raw.url.length > MAX_NETWORK_URL_LENGTH) throw new Error('URL too long')
    const url = new URL(raw.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme')
    origin = url.origin
    if (url.username || url.password) tally.add('credential')
    if (url.search || url.hash || raw.url.includes('?')) tally.add('query')
    pathname = applyTextRules(url.pathname, tally)
  } catch {
    tally.add('path')
  }
  for (const [key, value] of Object.entries(raw)) {
    if (NETWORK_METADATA_KEYS.has(key) || value === undefined || value === null) continue
    if (/cookie/i.test(key)) tally.add('cookie')
    else if (/header/i.test(key)) tally.add('header', typeof value === 'object' ? Math.max(1, Object.keys(value).length) : 1)
    else if (/body|post_?data|payload/i.test(key)) tally.add('body')
  }
  const mime = typeof raw.mime_type === 'string' ? (raw.mime_type.split(';')[0]?.trim().toLowerCase() ?? '') : ''
  const value: NetworkObservation = Object.freeze({
    method: /^[A-Z]{1,16}$/.test(method) ? method : 'UNKNOWN',
    origin,
    path: pathname,
    status: Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 999 ? raw.status : 0,
    mime_type: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : null,
    duration_ms:
      typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms) && raw.duration_ms >= 0
        ? Math.round(raw.duration_ms)
        : null,
  })
  return Object.freeze({ value, redactions: tally.toArray() })
}

export const CONSOLE_LEVELS = ['debug', 'info', 'log', 'warning', 'error'] as const
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

export interface ConsoleEntry {
  readonly level: ConsoleLevel
  readonly text: string
}

/**
 * Keeps the level and redacted text of each console entry. Text longer than the bound, before or
 * after redaction, is replaced whole by a placeholder: it is never scanned past the bound or cut,
 * so a partial secret cannot survive.
 */
export function sanitizeConsoleEntries(
  entries: readonly { readonly level: string; readonly text: string }[],
): Sanitized<readonly ConsoleEntry[]> {
  const tally = new RedactionTally()
  const value = entries.map((entry) => {
    const raw = String(entry.text)
    const redacted = raw.length <= MAX_CONSOLE_TEXT_LENGTH ? applyTextRules(raw, tally) : CONSOLE_TEXT_OMITTED
    return Object.freeze({
      level: (CONSOLE_LEVELS as readonly string[]).includes(entry.level) ? (entry.level as ConsoleLevel) : 'log',
      text: redacted.length <= MAX_CONSOLE_TEXT_LENGTH ? redacted : CONSOLE_TEXT_OMITTED,
    })
  })
  return Object.freeze({ value: Object.freeze(value), redactions: tally.toArray() })
}

/** Redacts inline credentials in captured permitted-source context. */
export function sanitizeSourceContent(content: string): Sanitized<string> {
  return sanitizeText(content)
}

/** Rewrites in-repository absolute paths as relative and hides every other absolute path. */
export function sanitizeFilesystemPath(candidate: string, options: { readonly repoRoot: string }): Sanitized<string> {
  const tally = new RedactionTally()
  if (path.isAbsolute(candidate)) {
    tally.add('path')
    const relative = path.relative(options.repoRoot, candidate)
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    const value = inside ? relative.split(path.sep).join('/') : REDACTED
    return Object.freeze({ value, redactions: tally.toArray() })
  }
  const normalized = path.posix.normalize(candidate.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../')) {
    tally.add('path')
    return Object.freeze({ value: REDACTED, redactions: tally.toArray() })
  }
  return Object.freeze({ value: candidate, redactions: tally.toArray() })
}

/** Produces bounded plain text for a chat goal: no markup, controls, or credentials. */
export function sanitizeChatText(text: string): Sanitized<string> {
  const plain = String(text)
    .normalize('NFC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const tally = new RedactionTally()
  let value = applyTextRules(plain, tally)
  if (value.length > MAX_CHAT_TEXT_LENGTH) {
    value = value.slice(0, MAX_CHAT_TEXT_LENGTH).replace(/[\ud800-\udbff]$/, '').trimEnd()
  }
  return Object.freeze({ value, redactions: tally.toArray() })
}

// ---------------------------------------------------------------------------------------
// Whole artifacts
// ---------------------------------------------------------------------------------------

function sanitizeValue(value: unknown, tally: RedactionTally, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return applyTextRules(value, tally)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') throw new SanitizeError(`Values of type ${typeof value} cannot be persisted.`)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new SanitizeError('Binary data cannot be persisted as a JSON artifact.')
  }
  if (ancestors.has(value)) throw new SanitizeError('Cyclic structures cannot be persisted.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => (item === undefined ? null : sanitizeValue(item, tally, ancestors))))
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SanitizeError('Only plain objects can be persisted.')
    }
    const result: Record<string, JsonValue> = {}
    for (const [rawKey, child] of Object.entries(value)) {
      if (child === undefined) continue
      const key = applyTextRules(rawKey, tally)
      if (isSecretKeyName(rawKey) && child !== null && child !== '' && child !== REDACTED) {
        tally.add(keyCategory(rawKey))
        result[key] = REDACTED
      } else {
        result[key] = sanitizeValue(child, tally, ancestors)
      }
    }
    return Object.freeze(result)
  } finally {
    ancestors.delete(value)
  }
}

/** Deeply sanitizes a JSON-compatible artifact: secret-named keys and secret-shaped text. */
export function sanitizeArtifact(value: unknown): Sanitized<JsonValue> {
  const tally = new RedactionTally()
  const sanitized = sanitizeValue(value, tally, new Set())
  return Object.freeze({ value: sanitized, redactions: tally.toArray() })
}

/** Sanitizes untrusted model output before it is persisted, displayed, or validated further. */
export function sanitizeProviderOutput(value: unknown): Sanitized<JsonValue> {
  return sanitizeArtifact(value)
}
