import { createHash, randomInt } from 'node:crypto'
import type { Frame, Page } from 'playwright'

import { REDACTED, containsSecretPattern, isSecretKeyName, sanitizeSourceContent, sanitizeText } from '../evidence/sanitize.js'
import { ARIA_ROLES, LocatorSchema, PROJECT_LIMITS, PROJECT_PRIVACY_POLICY_VERSION, safeTextSchema, sameOriginPathSchema } from '../project/contracts.js'
import type { Locator } from '../project/contracts.js'

// Project-live privacy rules (specs/006-project-live-verification, FR-018, research Decision 9).
// Everything a demonstration capture keeps passes through this module before it is staged,
// hashed or persisted: input values are admitted only by host policy, locator names, URLs,
// error and source text are sanitized, and the retained PNG is produced by Chromium with every
// input/editable/private/opaque surface already masked, so unmasked pixels never reach Node.
//
// The limits are honest: masking and text rules cannot discover every secret encoded in arbitrary
// pixels. Unknown sensitive content found by a supported rule makes the image unsupported rather
// than silently retained, and a hostile page can still lie about its own DOM. The module never
// touches traces, video, HAR, cookies, storage state, request/response headers or bodies, and
// never captures Studio or desktop pixels: images are clipped to the admitted target frame.

export const PRIVACY_MASK_COLOR = '#FF00FF'
/** Values shorter than this cannot be located in other text without masking ordinary words. */
export const MIN_REFLECTED_VALUE_LENGTH = 4
export const MAX_REDACTED_VALUES = 2_048
const MAX_PRIVATE_SELECTORS = 32
const MAX_LOCATOR_NAME = 128
const MAX_FILL_TEXT = 256
const MAX_ERROR_TEXT = 2_048
/** Rendered text larger than this cannot be assessed and makes the image unverifiable. */
export const MAX_RENDERED_TEXT_CHARS = 256 * 1_024
const IMAGE_TIMEOUT_MS = 10_000
const OCCLUSION_STEP_PX = 24

export type OpaqueSurfacePolicy = 'mask' | 'admit'

/** Host-owned privacy policy. Neither the browser, the target page nor a project file sets it. */
export interface ProjectPrivacyPolicy {
  readonly version: typeof PROJECT_PRIVACY_POLICY_VERSION
  /** Simple CSS selectors whose regions (and descendants) are always masked and never named. */
  readonly privateSelectors: readonly string[]
  /** Admit non-sensitive synthetic fill/select values. Off by default: no value is kept. */
  readonly admitSafeValues: boolean
  /** Image/vector/canvas/video surfaces cannot be inspected; mask them unless the host admits them. */
  readonly opaqueSurfaces: OpaqueSurfacePolicy
}

export type PrivacyErrorCode = 'PRIVACY_POLICY_INVALID'

export class ProjectPrivacyError extends Error {
  readonly code: PrivacyErrorCode

  constructor(code: PrivacyErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ProjectPrivacyError'
    this.code = code
  }
}

// No braces, semicolons, commas, at-rules, escapes, slashes or angle brackets: a selector can
// never leave its slot in the generated selector list or stylesheet.
const PRIVATE_SELECTOR = /^[A-Za-z0-9_\-#.[\]="' :>+~*()^$|]{1,256}$/

export function createPrivacyPolicy(
  input: { readonly privateSelectors?: readonly string[]; readonly admitSafeValues?: boolean; readonly opaqueSurfaces?: OpaqueSurfacePolicy } = {},
): ProjectPrivacyPolicy {
  const selectors = [...(input.privateSelectors ?? [])]
  if (selectors.length > MAX_PRIVATE_SELECTORS) throw new ProjectPrivacyError('PRIVACY_POLICY_INVALID', 'Too many private selectors.')
  for (const selector of selectors) {
    if (typeof selector !== 'string' || !PRIVATE_SELECTOR.test(selector) || selector.trim() !== selector) {
      throw new ProjectPrivacyError('PRIVACY_POLICY_INVALID', 'A private selector is not a supported simple selector.')
    }
  }
  const opaque = input.opaqueSurfaces ?? 'mask'
  if (opaque !== 'mask' && opaque !== 'admit') throw new ProjectPrivacyError('PRIVACY_POLICY_INVALID', 'Unknown opaque surface policy.')
  return Object.freeze({
    version: PROJECT_PRIVACY_POLICY_VERSION,
    privateSelectors: Object.freeze(selectors),
    admitSafeValues: input.admitSafeValues === true,
    opaqueSurfaces: opaque,
  })
}

export const DEFAULT_PRIVACY_POLICY: ProjectPrivacyPolicy = createPrivacyPolicy()

// ---------------------------------------------------------------------------------------
// Redacted value registry
// ---------------------------------------------------------------------------------------

// Two moduli below 2^26 keep every rolling-hash product below 2^53, so plain numbers are exact.
const MOD_A = 67_108_859
const MOD_B = 67_108_837

/**
 * Remembers non-admitted input values only as keyed rolling-hash fingerprints so their later
 * reflections in names, selectors, URLs or messages can be found and removed. The raw value is
 * never stored; the random bases live only in this process and only for one capture.
 */
export class RedactedValueRegistry {
  readonly #baseA = randomInt(257, MOD_A - 1)
  readonly #baseB = randomInt(257, MOD_B - 1)
  readonly #byLength = new Map<number, Set<string>>()
  readonly #maxValues: number
  #size = 0
  #overflowed = false

  constructor(options: { readonly maxValues?: number } = {}) {
    this.#maxValues = options.maxValues ?? MAX_REDACTED_VALUES
  }

  get size(): number {
    return this.#size
  }

  /** True once a value could not be remembered because the registry was full. */
  get overflowed(): boolean {
    return this.#overflowed
  }

  /** Remembers every non-empty refused value; false only when it is empty. */
  remember(value: string): boolean {
    if (value.length === 0) return false
    if (value.length < MIN_REFLECTED_VALUE_LENGTH || this.#overflowed) {
      this.#overflowed = true
      return false
    }
    const fingerprint = this.#fingerprint(value, 0, value.length)
    const set = this.#byLength.get(value.length)
    if (set?.has(fingerprint)) return true
    if (this.#size >= this.#maxValues) {
      this.#overflowed = true
      return true
    }
    if (set) set.add(fingerprint)
    else this.#byLength.set(value.length, new Set([fingerprint]))
    this.#size += 1
    return true
  }

  contains(text: string): boolean {
    if (this.#overflowed) return true
    return this.#reflectionForms(text).some((form) => this.#matches(form).length > 0)
  }

  /** Replaces every remembered value inside `text`. */
  redact(text: string): { readonly text: string; readonly count: number } {
    if (this.#overflowed) return text === '' ? { text, count: 0 } : { text: REDACTED, count: 1 }
    const forms = this.#reflectionForms(text)
    // Encoded reflections cannot be safely spliced back into their original representation.
    // Drop the whole metadata field rather than risk retaining a partially encoded secret.
    if (forms.slice(1).some((form) => this.#matches(form).length > 0)) return { text: REDACTED, count: 1 }
    const matches = this.#matches(text)
    if (matches.length === 0) return { text, count: 0 }
    // Merge overlapping windows, then rebuild the text around them.
    matches.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    const merged: Array<[number, number]> = []
    for (const [start, end] of matches) {
      const last = merged.at(-1)
      if (last && start <= last[1]) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    let result = ''
    let cursor = 0
    for (const [start, end] of merged) {
      result += `${text.slice(cursor, start)}${REDACTED}`
      cursor = end
    }
    return { text: result + text.slice(cursor), count: merged.length }
  }

  clear(): void {
    this.#byLength.clear()
    this.#size = 0
    this.#overflowed = false
  }

  toJSON(): { readonly size: number } {
    return { size: this.#size }
  }

  #fingerprint(text: string, start: number, end: number): string {
    let a = 0
    let b = 0
    for (let index = start; index < end; index += 1) {
      const rawCode = text.charCodeAt(index)
      const code = rawCode >= 0x41 && rawCode <= 0x5a ? rawCode + 0x20 : rawCode
      a = (a * this.#baseA + code) % MOD_A
      b = (b * this.#baseB + code) % MOD_B
    }
    return `${a}:${b}`
  }

  #matches(text: string): Array<[number, number]> {
    const found: Array<[number, number]> = []
    for (const [length, fingerprints] of this.#byLength) {
      if (length > text.length) continue
      const powA = this.#power(this.#baseA, length - 1, MOD_A)
      const powB = this.#power(this.#baseB, length - 1, MOD_B)
      let a = 0
      let b = 0
      for (let index = 0; index < length; index += 1) {
        const rawCode = text.charCodeAt(index)
        const code = rawCode >= 0x41 && rawCode <= 0x5a ? rawCode + 0x20 : rawCode
        a = (a * this.#baseA + code) % MOD_A
        b = (b * this.#baseB + code) % MOD_B
      }
      for (let start = 0; ; start += 1) {
        if (fingerprints.has(`${a}:${b}`)) found.push([start, start + length])
        const next = start + length
        if (next >= text.length) break
        const rawOutgoing = text.charCodeAt(start)
        const outgoing = rawOutgoing >= 0x41 && rawOutgoing <= 0x5a ? rawOutgoing + 0x20 : rawOutgoing
        const rawIncoming = text.charCodeAt(next)
        const incoming = rawIncoming >= 0x41 && rawIncoming <= 0x5a ? rawIncoming + 0x20 : rawIncoming
        a = (((a - ((outgoing * powA) % MOD_A) + MOD_A) % MOD_A) * this.#baseA + incoming) % MOD_A
        b = (((b - ((outgoing * powB) % MOD_B) + MOD_B) % MOD_B) * this.#baseB + incoming) % MOD_B
      }
    }
    return found
  }

  #decodePercentEncoding(text: string): string {
    let decoded = text
    // Two rounds catch both ordinary percent-encoding and a common double-encoded reflection.
    for (let round = 0; round < 2; round += 1) {
      const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (sequence) => {
        try {
          return decodeURIComponent(sequence)
        } catch {
          return sequence
        }
      })
      if (next === decoded) break
      decoded = next
    }
    return decoded
  }

  #reflectionForms(text: string): string[] {
    const forms = [text]
    const decoded = this.#decodePercentEncoding(text)
    if (decoded !== text) forms.push(decoded)
    const formEncoded = decoded.replace(/\+/g, ' ')
    if (formEncoded !== decoded && !forms.includes(formEncoded)) forms.push(formEncoded)
    return forms
  }

  #power(base: number, exponent: number, modulus: number): number {
    let result = 1
    for (let index = 0; index < exponent; index += 1) result = (result * base) % modulus
    return result
  }
}

// ---------------------------------------------------------------------------------------
// Fields and admitted values
// ---------------------------------------------------------------------------------------

/** App-defined field attributes as the target recorder describes them; never the value. */
export interface FieldDescriptor {
  readonly tag: string
  readonly type: string | null
  readonly autocomplete: string | null
  readonly name: string | null
  readonly label: string | null
  readonly placeholder: string | null
  /** Inside a configured private selector or `data-flowproof-private` region. */
  readonly private: boolean
}

export type FieldClass = { readonly kind: 'text' } | { readonly kind: 'select' } | { readonly kind: 'unsupported'; readonly reason: string }
export type FillValue = { readonly kind: 'safe'; readonly text: string } | { readonly kind: 'redacted'; readonly reason: string }
export type SelectValue = { readonly kind: 'safe'; readonly option: string } | { readonly kind: 'redacted'; readonly reason: string }

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'number', 'password', 'email', 'tel'])
const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel'])
// Autocomplete tokens for credentials, identity, contact, address and payment data.
const SENSITIVE_AUTOCOMPLETE =
  /^(?:current-password|new-password|one-time-code|username|webauthn|email|impp|url|photo|name|given-name|additional-name|family-name|honorific-prefix|honorific-suffix|nickname|organization|organization-title|street-address|address-line[1-3]|address-level[1-4]|country|country-name|postal-code|bday(?:-day|-month|-year)?|sex|language|tel(?:-[a-z-]+)?|cc-[a-z-]+|transaction-[a-z]+)$/
const SENSITIVE_FIELD_TEXT =
  /pass(?:word|wd|code|phrase)?\b|secret|token|api[\s_-]?key|\bauth|card|\bcvv|\bcvc|\bssn\b|social security|\biban\b|account|routing|\bpin\b|\botp\b|e-?mail|phone|mobile|\btel\b|address|birth|\bdob\b|salary|passport|licen[cs]e|\btax\b|credit|\bbank|user\s?name|login/i
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/
const LONG_NUMBER_SHAPE = /\d{9,}/

export function classifyField(field: FieldDescriptor): FieldClass {
  if (field.tag === 'select') return { kind: 'select' }
  if (field.tag === 'textarea') return { kind: 'text' }
  if (field.tag !== 'input') return { kind: 'unsupported', reason: 'INPUT_TYPE_UNSUPPORTED' }
  const type = (field.type ?? 'text').toLowerCase()
  return TEXT_INPUT_TYPES.has(type) ? { kind: 'text' } : { kind: 'unsupported', reason: 'INPUT_TYPE_UNSUPPORTED' }
}

function sensitiveField(field: FieldDescriptor): boolean {
  if (field.tag === 'input' && SENSITIVE_INPUT_TYPES.has((field.type ?? '').toLowerCase())) return true
  const tokens = (field.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.test(token))) return true
  return [field.name, field.label, field.placeholder].some((value) => value !== null && (SENSITIVE_FIELD_TEXT.test(value) || isSecretKeyName(value)))
}

function containsSensitiveValueShape(value: string): boolean {
  return containsSecretPattern(value) || EMAIL_SHAPE.test(value) || LONG_NUMBER_SHAPE.test(value.replace(/[\s-]/g, '')) || /\bbearer\s+\S{8,}/i.test(value)
}

function isSensitiveUrlKey(key: string): boolean {
  return sensitiveField({ tag: 'input', type: null, autocomplete: null, name: key, label: null, placeholder: null, private: false })
}

function containsSensitivePathParameter(path: string): boolean {
  for (const segment of path.split('/')) {
    for (const parameter of segment.split(';').slice(1)) {
      const [rawKey, ...rawValue] = parameter.split('=')
      const key = decodeURIComponentSafe(rawKey ?? '')
      const value = decodeURIComponentSafe(rawValue.join('=').replace(/\+/g, ' '))
      if (key === null || value === null || isSensitiveUrlKey(key) || containsSensitiveValueShape(value)) return true
    }
  }
  return false
}

function valueRejection(value: string): string | null {
  if (!safeTextSchema(MAX_FILL_TEXT, { min: 0 }).safeParse(value).success) return containsSecretPattern(value) ? 'VALUE_SENSITIVE_SHAPE' : 'VALUE_UNSAFE'
  if (containsSensitiveValueShape(value)) return 'VALUE_SENSITIVE_SHAPE'
  return null
}

/** Decides whether a typed value is kept. Every non-admitted value is remembered for scrubbing. */
export function admitFillValue(policy: ProjectPrivacyPolicy, field: FieldDescriptor, raw: string | null, registry: RedactedValueRegistry): FillValue {
  const decision = admitText(policy, field, raw, registry)
  return decision.kind === 'safe' ? { kind: 'safe', text: decision.value } : decision
}

export function admitSelectValue(policy: ProjectPrivacyPolicy, field: FieldDescriptor, raw: string | null, registry: RedactedValueRegistry): SelectValue {
  if (raw === '') return { kind: 'redacted', reason: 'OPTION_VALUE_EMPTY' }
  const decision = admitText(policy, field, raw, registry)
  return decision.kind === 'safe' ? { kind: 'safe', option: decision.value } : decision
}

function admitText(
  policy: ProjectPrivacyPolicy,
  field: FieldDescriptor,
  raw: string | null,
  registry: RedactedValueRegistry,
): { readonly kind: 'safe'; readonly value: string } | { readonly kind: 'redacted'; readonly reason: string } {
  const redacted = (reason: string) => {
    if (raw !== null) registry.remember(raw)
    return { kind: 'redacted', reason } as const
  }
  if (raw === null || raw.length > MAX_FILL_TEXT) return redacted('VALUE_TOO_LONG')
  if (field.private) return redacted('FIELD_PRIVATE')
  if (sensitiveField(field)) return redacted('FIELD_SENSITIVE')
  const rejection = valueRejection(raw)
  if (rejection !== null) return redacted(rejection)
  if (!policy.admitSafeValues) return redacted('VALUE_NOT_ADMITTED')
  if (registry.contains(raw)) return redacted('VALUE_REFLECTS_REDACTED')
  return { kind: 'safe', value: raw }
}

// ---------------------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------------------

/** A target element as the recorder describes it. Every field is untrusted page data. */
export interface ElementDescriptor {
  readonly tag: string
  readonly testId: string | null
  readonly role: string | null
  readonly name: string | null
  readonly id: string | null
  readonly css: string | null
  readonly private: boolean
}

const ROLES: ReadonlySet<string> = new Set(ARIA_ROLES)
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/

function safeIdentifier(value: string, registry: RedactedValueRegistry): boolean {
  return !registry.contains(value) && !containsSecretPattern(value)
}

/**
 * Ordered S1 locator candidates: test ID, role plus safe accessible name, then a simple unique
 * CSS selector. Unsafe candidates are dropped, never truncated or rewritten; an empty result
 * means the action cannot be represented safely and must be reported as unsupported.
 */
export function locatorCandidates(element: ElementDescriptor, registry: RedactedValueRegistry): Locator[] {
  const candidates: Locator[] = []
  const push = (candidate: Locator): void => {
    const parsed = LocatorSchema.safeParse(candidate)
    if (parsed.success) candidates.push(parsed.data)
  }
  if (element.testId !== null && safeIdentifier(element.testId, registry)) push({ kind: 'test-id', value: element.testId })
  if (element.role !== null && ROLES.has(element.role) && element.name !== null && !element.private) {
    const name = element.name.replace(/\s+/g, ' ').trim()
    const safe = name.length > 0 && name.length <= MAX_LOCATOR_NAME && !INVISIBLE_OR_CONTROL.test(name) && safeIdentifier(name, registry)
    if (safe) push({ kind: 'role', role: element.role as (typeof ARIA_ROLES)[number], name })
  }
  if (element.css !== null && safeIdentifier(element.css, registry)) push({ kind: 'css', selector: element.css })
  return candidates
}

// ---------------------------------------------------------------------------------------
// URLs, errors and source text
// ---------------------------------------------------------------------------------------

export type NavigationResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }

const QUERY_OR_FRAGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]*$/

/** Reduces a target URL to an admitted relative same-origin path, or names why it cannot. */
export function sanitizeNavigation(href: string, targetOrigin: string, registry: RedactedValueRegistry): NavigationResult {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { ok: false, reason: 'NAVIGATION_INVALID' }
  }
  if (url.origin !== targetOrigin) return { ok: false, reason: 'NAVIGATION_CROSS_ORIGIN' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'NAVIGATION_CREDENTIALS' }
  const path = url.pathname
  if (registry.contains(path) || containsSensitiveValueShape(path) || containsSensitivePathParameter(path)) return { ok: false, reason: 'NAVIGATION_PATH_SENSITIVE' }
  for (const extra of [url.search.slice(1), url.hash.slice(1)]) {
    if (extra === '') continue
    if (registry.contains(extra) || containsSensitiveValueShape(extra)) return { ok: false, reason: 'NAVIGATION_QUERY_SENSITIVE' }
    for (const pair of extra.split(/[&;]/)) {
      const [rawKey, ...rawValue] = pair.split('=')
      const key = decodeURIComponentSafe(rawKey ?? '')
      const value = decodeURIComponentSafe(rawValue.join('=').replace(/\+/g, ' '))
      if (key === null || value === null || isSensitiveUrlKey(key)) {
        return { ok: false, reason: 'NAVIGATION_QUERY_SENSITIVE' }
      }
      if (containsSensitiveValueShape(value)) return { ok: false, reason: 'NAVIGATION_QUERY_SENSITIVE' }
    }
    if (!QUERY_OR_FRAGMENT.test(extra)) return { ok: false, reason: 'NAVIGATION_QUERY_UNSUPPORTED' }
  }
  const relative = `${path}${url.search}${url.hash}`
  if (!sameOriginPathSchema.safeParse(relative).success) return { ok: false, reason: 'NAVIGATION_PATH_UNSUPPORTED' }
  return { ok: true, path: relative }
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g
const ERROR_OMITTED = `[OMITTED: message longer than ${MAX_ERROR_TEXT} characters]`

/**
 * Bounded S1-safe error/console text. Over-long text is replaced whole, never cut, so a partial
 * secret cannot survive; credentials, URL queries and reflected input values are redacted.
 */
export function sanitizeErrorText(raw: string, registry: RedactedValueRegistry): { readonly message: string; readonly redactions: number } {
  if (raw.length > MAX_ERROR_TEXT) return { message: ERROR_OMITTED, redactions: 1 }
  let redactions = 0
  const stripped = raw.replace(CONTROL_EXCEPT_WHITESPACE, () => {
    redactions += 1
    return ''
  })
  const sanitized = sanitizeText(stripped)
  redactions += sanitized.redactions.reduce((sum, redaction) => sum + redaction.count, 0)
  const scrubbed = registry.redact(sanitized.value)
  redactions += scrubbed.count
  const message = scrubbed.text.trim() === '' ? '(empty)' : scrubbed.text
  if (message.length > MAX_ERROR_TEXT || !safeTextSchema(MAX_ERROR_TEXT, { multiline: true }).safeParse(message).success) {
    return { message: ERROR_OMITTED, redactions: redactions + 1 }
  }
  return { message, redactions }
}

/** Admitted source text with inline credentials and reflected values redacted. */
export function sanitizeSourceText(
  content: string,
  registry: RedactedValueRegistry,
): { readonly ok: true; readonly text: string; readonly redactions: number } | { readonly ok: false; readonly reason: string } {
  if (registry.overflowed) return { ok: false, reason: 'SOURCE_PRIVACY_UNVERIFIED' }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069]/.test(content)) return { ok: false, reason: 'SOURCE_CONTROL_CHARACTER' }
  const sanitized = sanitizeSourceContent(content)
  const scrubbed = registry.redact(sanitized.value)
  if (containsSecretPattern(scrubbed.text)) return { ok: false, reason: 'SOURCE_SECRET_PATTERN' }
  return { ok: true, text: scrubbed.text, redactions: sanitized.redactions.reduce((sum, redaction) => sum + redaction.count, 0) + scrubbed.count }
}

// ---------------------------------------------------------------------------------------
// Target-only masked PNG production
// ---------------------------------------------------------------------------------------

const EDITABLE = '[contenteditable]:not([contenteditable="false"])'

/** Every surface masked while Chromium renders the retained PNG. */
export function maskSelector(policy: ProjectPrivacyPolicy): string {
  const regions = ['[data-flowproof-private]', ...policy.privateSelectors].flatMap((selector) => [selector, `${selector} *`])
  const opaque = policy.opaqueSurfaces === 'mask' ? ['canvas', 'video', 'img', 'svg'] : []
  return ['input:not([type="hidden"])', 'textarea', 'select', EDITABLE, `${EDITABLE} *`, 'iframe', 'frame', 'object', 'embed', ...regions, ...opaque].join(', ')
}

/**
 * Defense in depth under the masks: form and editable text is not painted at all. Playwright
 * applies this stylesheet to every frame of the page, including the embedding Studio document,
 * so it may only suppress text paint; it must never hide frames (that would hide the target).
 */
export function maskStyle(policy: ProjectPrivacyPolicy): string {
  const text = ['input', 'textarea', 'select', EDITABLE, `${EDITABLE} *`, '[data-flowproof-private]', '[data-flowproof-private] *', ...policy.privateSelectors.flatMap((selector) => [selector, `${selector} *`])]
  return [
    `${text.join(', ')} { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }`,
    'input::placeholder, textarea::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }',
    '::selection { background: transparent !important; color: transparent !important; }',
  ].join('\n')
}

export type RenderedTextAssessment = { readonly ok: true } | { readonly ok: false; readonly reason: 'IMAGE_SENSITIVE_TEXT' | 'IMAGE_TEXT_UNVERIFIED' }

/** Rejects an image whose unmasked rendered text shows a secret shape or a redacted value. */
export function assessRenderedText(text: string | null, registry: RedactedValueRegistry): RenderedTextAssessment {
  if (registry.overflowed) return { ok: false, reason: 'IMAGE_TEXT_UNVERIFIED' }
  if (text === null || text.length > MAX_RENDERED_TEXT_CHARS) return { ok: false, reason: 'IMAGE_TEXT_UNVERIFIED' }
  if (containsSecretPattern(text) || registry.contains(text)) return { ok: false, reason: 'IMAGE_SENSITIVE_TEXT' }
  return { ok: true }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function readPngSize(buffer: Uint8Array): { readonly width: number; readonly height: number } | null {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export interface MaskedTargetImage {
  readonly png: Buffer
  readonly sha256: string
  readonly bytes: number
  /** The admitted target frame's viewport (CSS px). */
  readonly viewport: { readonly width: number; readonly height: number }
  /** The retained region, relative to that viewport. */
  readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly mask_count: number
}

/**
 * `effect` says how an absent image affects completeness: `unsupported` for an unknown sensitive
 * surface, `dropped` for a crossed limit, `unavailable` when evidence could not be collected.
 */
export type TargetImageOutcome =
  | { readonly ok: true; readonly image: MaskedTargetImage }
  | { readonly ok: false; readonly availability: 'omitted' | 'unavailable'; readonly reason: string; readonly effect: 'unsupported' | 'unavailable' | 'dropped' }

const omitted = (reason: string, effect: 'unsupported' | 'unavailable' | 'dropped'): TargetImageOutcome => ({ ok: false, availability: 'omitted', reason, effect })
const unavailable = (reason: string): TargetImageOutcome => ({ ok: false, availability: 'unavailable', reason, effect: 'unavailable' })

interface TargetGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly occluded: boolean
}

/** Content-box geometry of the target iframe in the top viewport and whether anything covers it. */
async function iframeGeometry(frame: Frame): Promise<TargetGeometry | null> {
  const element = await frame.frameElement()
  try {
    // Runs in the trusted embedding (Studio) document, not in the target page.
    return await element.evaluate((node, step: number) => {
      const iframe = node as unknown as {
        getBoundingClientRect(): { left: number; top: number }
        clientLeft: number
        clientTop: number
        clientWidth: number
        clientHeight: number
        ownerDocument: {
          elementFromPoint(x: number, y: number): unknown
          querySelectorAll(selector: string): ArrayLike<{
            contains(target: unknown): boolean
            getBoundingClientRect(): { left: number; top: number; right: number; bottom: number }
          }>
          defaultView: {
            innerWidth: number
            innerHeight: number
            getComputedStyle(element: unknown): { display: string; visibility: string; opacity: string }
          } | null
        }
      }
      const rect = iframe.getBoundingClientRect()
      const left = rect.left + iframe.clientLeft
      const top = rect.top + iframe.clientTop
      const x = Math.ceil(left)
      const y = Math.ceil(top)
      const width = Math.floor(left + iframe.clientWidth) - x
      const height = Math.floor(top + iframe.clientHeight) - y
      const doc = iframe.ownerDocument
      const view = doc.defaultView
      const inside = view !== null && x >= 0 && y >= 0 && x + width <= view.innerWidth && y + height <= view.innerHeight
      let occluded = !inside
      if (!occluded && view !== null) {
        // Hit-testing samples can skip small or pointer-transparent overlays. Conservatively
        // reject any visible Studio element whose painted box overlaps the target content.
        for (const candidate of Array.from(doc.querySelectorAll('*'))) {
          if (candidate.contains(iframe)) continue
          const style = view.getComputedStyle(candidate)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
          const rect = candidate.getBoundingClientRect()
          if (rect.right > x && rect.left < x + width && rect.bottom > y && rect.top < y + height) {
            occluded = true
            break
          }
        }
      }
      const xs: number[] = []
      const ys: number[] = []
      for (let px = x + 0.5; px < x + width; px += step) xs.push(px)
      for (let py = y + 0.5; py < y + height; py += step) ys.push(py)
      xs.push(x + width - 0.5)
      ys.push(y + height - 0.5)
      for (const py of ys) {
        for (const px of xs) {
          if (iframe.ownerDocument.elementFromPoint(px, py) !== iframe) occluded = true
          if (occluded) break
        }
        if (occluded) break
      }
      return { x, y, width, height, occluded }
    }, OCCLUSION_STEP_PX)
  } finally {
    await element.dispose()
  }
}

/** Visible text outside masked surfaces, read from the target document; null when too large. */
async function renderedText(frame: Frame, selector: string): Promise<string | null> {
  return frame.evaluate(
    ({ selector: masked, max }) => {
      const doc = (globalThis as unknown as { document: any }).document
      const chunks: string[] = []
      let total = 0
      const append = (value: string): boolean => {
        if (value.trim() === '') return true
        total += value.length + 1
        if (total > max) return false
        chunks.push(value)
        return true
      }
      const appendPseudo = (element: any, pseudo: string): boolean => {
        let style: any
        try {
          style = doc.defaultView.getComputedStyle(element, pseudo)
        } catch {
          return false
        }
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true
        const content = String(style.content || '')
        if (content === '' || content === 'none' || content === 'normal' || content === '""' || content === "''") return true
        const attributes = [...content.matchAll(/attr\(\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*(?:,[^)]*)?\)/gi)]
        const remainder = content.replace(/attr\(\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*(?:,[^)]*)?\)/gi, '')
        // Counters, URLs and other computed functions are not safely inspectable as text.
        if (/[A-Za-z_-][A-Za-z0-9_-]*\(/.test(remainder)) return false
        if (!append(content)) return false
        for (const match of attributes) {
          const value = element.getAttribute(match[1])
          if (value !== null && !append(String(value))) return false
        }
        return true
      }
      const visit = (root: any): boolean => {
        const walker = doc.createTreeWalker(root, 0x5 /* SHOW_ELEMENT | SHOW_TEXT */)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.nodeType === 1) {
            const element = node as any
            if (element.closest(masked) || (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue
            const style = doc.defaultView.getComputedStyle(element)
            if ([style.backgroundImage, style.listStyleImage, style.borderImageSource].some((image) => /url\(/i.test(image))) return false
            for (const pseudo of ['::before', '::after', '::marker']) if (!appendPseudo(element, pseudo)) return false
            if (node.shadowRoot && !visit(node.shadowRoot)) return false
            continue
          }
          const parent = node.parentElement
          if (!parent || parent.closest(masked) || (parent.checkVisibility && !parent.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue
          const value = String(node.data)
          if (!append(value)) return false
        }
        return true
      }
      if (!doc.body) return ''
      return visit(doc.body) ? chunks.join('\n') : null
    },
    { selector, max: MAX_RENDERED_TEXT_CHARS },
  )
}

/**
 * Produces the retained target-only PNG. Chromium paints it with every masked surface already
 * covered (Playwright masks plus a no-paint stylesheet), clipped to the admitted frame's content
 * box. The surrounding rendered text is assessed before and after, mask counts must be stable and
 * nothing may cover the target; otherwise the bytes are wiped and an explicit omission returned.
 */
export async function captureMaskedTargetImage(input: {
  readonly page: Page
  readonly frame: Frame
  readonly targetOrigin: string
  readonly policy: ProjectPrivacyPolicy
  readonly registry: RedactedValueRegistry
}): Promise<TargetImageOutcome> {
  const { page, frame, policy, registry } = input
  let png: Buffer | null = null
  const wipe = (outcome: TargetImageOutcome): TargetImageOutcome => {
    png?.fill(0)
    png = null
    return outcome
  }
  try {
    if (frame.isDetached()) return unavailable('IMAGE_TARGET_DETACHED')
    if (frame.page() !== page) return unavailable('IMAGE_TARGET_INVALID')
    let origin: string
    try {
      origin = new URL(frame.url()).origin
    } catch {
      return unavailable('IMAGE_TARGET_ORIGIN')
    }
    if (origin !== input.targetOrigin) return unavailable('IMAGE_TARGET_ORIGIN')

    const parent = frame.parentFrame()
    let geometry: TargetGeometry | null
    if (parent === null) {
      const size = page.viewportSize()
      geometry = size ? { x: 0, y: 0, width: size.width, height: size.height, occluded: false } : null
    } else if (parent === page.mainFrame()) {
      geometry = await iframeGeometry(frame)
    } else {
      return unavailable('IMAGE_TARGET_NESTED')
    }
    if (geometry === null || geometry.width < 1 || geometry.height < 1) return unavailable('IMAGE_TARGET_NOT_VISIBLE')
    if (geometry.occluded) return omitted('IMAGE_TARGET_OCCLUDED', 'unavailable')

    const selector = maskSelector(policy)
    const masks = frame.locator(selector)
    const before = assessRenderedText(await renderedText(frame, selector), registry)
    if (!before.ok) return omitted(before.reason, 'unsupported')
    const maskCount = await masks.count()

    png = await page.screenshot({
      type: 'png',
      clip: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
      mask: [masks],
      maskColor: PRIVACY_MASK_COLOR,
      style: maskStyle(policy),
      caret: 'hide',
      scale: 'css',
      animations: 'allow',
      timeout: IMAGE_TIMEOUT_MS,
    })
    const after = assessRenderedText(await renderedText(frame, selector), registry)
    if (!after.ok) return wipe(omitted(after.reason, 'unsupported'))
    if ((await masks.count()) !== maskCount) return wipe(omitted('IMAGE_MASK_UNSTABLE', 'unavailable'))
    if (parent !== null) {
      const recheck = await iframeGeometry(frame)
      if (recheck === null || recheck.occluded || recheck.x !== geometry.x || recheck.y !== geometry.y || recheck.width !== geometry.width || recheck.height !== geometry.height) {
        return wipe(omitted('IMAGE_TARGET_OCCLUDED', 'unavailable'))
      }
    }
    const retained: Buffer = png
    const size = readPngSize(retained)
    if (size === null || size.width !== geometry.width || size.height !== geometry.height) return wipe(unavailable('IMAGE_DIMENSIONS_MISMATCH'))
    if (retained.length > PROJECT_LIMITS.maxImageBytes) return wipe(omitted('IMAGE_BYTES_LIMIT', 'dropped'))
    return {
      ok: true,
      image: {
        png: retained,
        sha256: createHash('sha256').update(retained).digest('hex'),
        bytes: retained.length,
        viewport: { width: geometry.width, height: geometry.height },
        clip: { x: 0, y: 0, width: geometry.width, height: geometry.height },
        mask_count: maskCount,
      },
    }
  } catch {
    return wipe(unavailable('IMAGE_CAPTURE_FAILED'))
  }
}
