import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PRIVACY_POLICY,
  ProjectPrivacyError,
  RedactedValueRegistry,
  admitFillValue,
  admitSelectValue,
  assessRenderedText,
  classifyField,
  createPrivacyPolicy,
  locatorCandidates,
  navigationPathSensitive,
  maskSelector,
  maskStyle,
  readPngSize,
  sanitizeErrorText,
  sanitizeNavigation,
  sanitizeSourceText,
} from '../../packages/flowproof/src/capture/projectPrivacy.js'
import type { ElementDescriptor, FieldDescriptor } from '../../packages/flowproof/src/capture/projectPrivacy.js'
import { LocatorSchema, safeTextSchema } from '../../packages/flowproof/src/project/contracts.js'

// T022: privacy rules applied before anything is staged, hashed or persisted. Synthetic values
// only. Pixel masking of rendered secrets is proven separately in tests/e2e/project-privacy.spec.ts
// with actual Chromium screenshots; nothing here inspects PNG bytes for markers as a privacy proof.

const ROOT = path.resolve(import.meta.dirname, '../..')
const ORIGIN = 'http://localhost:43161'
const ADMIT = createPrivacyPolicy({ admitSafeValues: true, privateSelectors: ['.account-panel', '#ledger'] })

const text = (overrides: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  tag: 'input',
  type: 'text',
  autocomplete: null,
  name: 'title',
  label: 'Task title',
  placeholder: null,
  private: false,
  ...overrides,
})
const element = (overrides: Partial<ElementDescriptor> = {}): ElementDescriptor => ({
  tag: 'button',
  testId: 'save',
  role: 'button',
  name: 'Save task',
  id: 'save',
  css: 'button#save',
  private: false,
  ...overrides,
})

describe('privacy policy', () => {
  it('admits no input values by default and masks opaque surfaces', () => {
    expect(DEFAULT_PRIVACY_POLICY).toMatchObject({ admitSafeValues: false, opaqueSurfaces: 'mask', privateSelectors: [] })
    expect(Object.isFrozen(DEFAULT_PRIVACY_POLICY)).toBe(true)
    expect(admitFillValue(DEFAULT_PRIVACY_POLICY, text(), 'Buy milk', new RedactedValueRegistry())).toEqual({ kind: 'redacted', reason: 'VALUE_NOT_ADMITTED' })
  })

  it('rejects private selectors that could escape the generated stylesheet or selector list', () => {
    for (const selector of ['a{}', 'div;color:red', '.a, .b', 'x\\y', '@import', '', 'a'.repeat(300), 'div</style>']) {
      expect(() => createPrivacyPolicy({ privateSelectors: [selector] }), selector).toThrow(ProjectPrivacyError)
    }
    expect(() => createPrivacyPolicy({ privateSelectors: Array.from({ length: 33 }, (_, n) => `.p${n}`) })).toThrow(ProjectPrivacyError)
    expect(createPrivacyPolicy({ privateSelectors: ['[data-private="yes"] > .balance', 'section#ledger'] }).privateSelectors).toHaveLength(2)
  })

  it('masks inputs, editable content, nested frames, private regions with descendants and opaque surfaces', () => {
    const selector = maskSelector(ADMIT).split(', ')
    for (const required of [
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[contenteditable]:not([contenteditable="false"])',
      '[contenteditable]:not([contenteditable="false"]) *',
      'iframe',
      'frame',
      'object',
      'embed',
      '[data-flowproof-private]',
      '[data-flowproof-private] *',
      '.account-panel',
      '.account-panel *',
      '#ledger *',
      'canvas',
      'video',
      'img',
      'svg',
    ]) {
      expect(selector, required).toContain(required)
    }
    const admitted = maskSelector(createPrivacyPolicy({ opaqueSurfaces: 'admit' })).split(', ')
    expect(admitted).not.toContain('canvas')
    expect(admitted).not.toContain('img')
    expect(admitted).not.toContain('svg')
    expect(admitted).toContain('iframe')
    expect(maskStyle(ADMIT)).toMatch(/color: transparent !important/)
    expect(maskStyle(ADMIT)).toMatch(/-webkit-text-fill-color: transparent !important/)
  })
})

describe('field classification and value admission', () => {
  const registry = () => new RedactedValueRegistry()

  it('admits a non-sensitive synthetic text value only when policy admits values', () => {
    expect(admitFillValue(ADMIT, text(), 'Buy milk', registry())).toEqual({ kind: 'safe', text: 'Buy milk' })
    expect(admitFillValue(ADMIT, text({ tag: 'textarea', type: null }), 'One line note', registry())).toEqual({ kind: 'safe', text: 'One line note' })
    // The S1 fill value is single-line safe text; a multi-line value cannot be represented safely.
    expect(admitFillValue(ADMIT, text({ tag: 'textarea', type: null }), 'Line one\nLine two', registry())).toEqual({ kind: 'redacted', reason: 'VALUE_UNSAFE' })
  })

  it('redacts values from sensitive field types, autocomplete tokens, names and labels', () => {
    for (const field of [
      text({ type: 'password' }),
      text({ type: 'email' }),
      text({ type: 'tel' }),
      text({ autocomplete: 'cc-number' }),
      text({ autocomplete: 'section-billing current-password' }),
      text({ autocomplete: 'one-time-code' }),
      text({ name: 'api_token' }),
      text({ label: 'Card number' }),
      text({ placeholder: 'Your e-mail' }),
      text({ name: 'ssn' }),
    ]) {
      expect(admitFillValue(ADMIT, field, 'harmless words', registry()), JSON.stringify(field)).toEqual({ kind: 'redacted', reason: 'FIELD_SENSITIVE' })
    }
    expect(admitFillValue(ADMIT, text({ private: true }), 'harmless words', registry())).toEqual({ kind: 'redacted', reason: 'FIELD_PRIVATE' })
  })

  it('redacts secret-, identity- or payment-shaped values typed into ordinary fields', () => {
    for (const value of ['sk-abcdefghijklmnop1234', 'password: hunter2hunter2', 'someone@example.test', '4111 1111 1111 1111', 'Bearer abcdefghijklmnop']) {
      expect(admitFillValue(ADMIT, text(), value, registry()).kind, value).toBe('redacted')
    }
    expect(admitFillValue(ADMIT, text(), 'tab\u0007bell', registry())).toEqual({ kind: 'redacted', reason: 'VALUE_UNSAFE' })
    expect(admitFillValue(ADMIT, text(), 'x'.repeat(257), registry())).toEqual({ kind: 'redacted', reason: 'VALUE_TOO_LONG' })
    expect(admitFillValue(ADMIT, text(), null, registry())).toEqual({ kind: 'redacted', reason: 'VALUE_TOO_LONG' })
  })

  it('remembers every non-admitted value so later reflections can be removed', () => {
    const values = registry()
    admitFillValue(ADMIT, text({ type: 'password' }), 'Reflected-Secret', values)
    expect(values.contains('Welcome back, Reflected-Secret!')).toBe(true)
    expect(values.contains('Welcome back!')).toBe(false)
  })

  it('classifies supported controls and rejects unsupported input types', () => {
    expect(classifyField(text())).toEqual({ kind: 'text' })
    expect(classifyField(text({ type: 'search' }))).toEqual({ kind: 'text' })
    expect(classifyField(text({ tag: 'select', type: null }))).toEqual({ kind: 'select' })
    for (const type of ['file', 'range', 'color', 'date', 'checkbox', 'radio', 'hidden']) {
      expect(classifyField(text({ type })).kind, type).toBe('unsupported')
    }
  })

  it('admits a native select option only when it is safe and not from a sensitive field', () => {
    expect(admitSelectValue(ADMIT, text({ tag: 'select', type: null, name: 'filter' }), 'done', registry())).toEqual({ kind: 'safe', option: 'done' })
    expect(admitSelectValue(ADMIT, text({ tag: 'select', type: null, autocomplete: 'country' }), 'KR', registry())).toEqual({ kind: 'redacted', reason: 'FIELD_SENSITIVE' })
    expect(admitSelectValue(ADMIT, text({ tag: 'select', type: null }), '', registry())).toEqual({ kind: 'redacted', reason: 'OPTION_VALUE_EMPTY' })
  })
})

describe('redacted value registry', () => {
  it('finds and removes reflections without retaining the raw value', () => {
    const registry = new RedactedValueRegistry()
    const secret = 'Synthetic-Reflection-77'
    expect(registry.remember(secret)).toBe(true)
    expect(registry.size).toBe(1)
    expect(registry.redact(`a ${secret} b ${secret}`)).toEqual({ text: 'a [REDACTED] b [REDACTED]', count: 2 })
    // No representation of the registry exposes the value or any substring of it.
    const dump = `${inspect(registry, { depth: 10, showHidden: true })} ${JSON.stringify(registry)}`
    expect(dump).not.toContain(secret)
    expect(dump).not.toContain('Reflection')
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.contains(secret)).toBe(false)
  })

  it('ignores empty values and reports registry overflow explicitly', () => {
    const registry = new RedactedValueRegistry({ maxValues: 3 })
    expect(registry.remember('')).toBe(false)
    expect(registry.remember('317')).toBe(false)
    expect(registry.overflowed).toBe(true)
    expect(registry.contains('ordinary text')).toBe(true)
    expect(registry.redact('ordinary text')).toEqual({ text: '[REDACTED]', count: 1 })
    expect(sanitizeSourceText('const title = "private"', registry)).toEqual({ ok: false, reason: 'SOURCE_PRIVACY_UNVERIFIED' })
    registry.clear()
    expect(registry.overflowed).toBe(false)
    expect(registry.remember('alpha-1')).toBe(true)
    expect(registry.remember('alpha-1')).toBe(true)
    registry.remember('bravo-2')
    registry.remember('charlie-3')
    expect(registry.overflowed).toBe(false)
    registry.remember('delta-4')
    expect(registry.overflowed).toBe(true)
  })

  it('redacts short refused values from locator, error, URL and rendered-text metadata', () => {
    const registry = new RedactedValueRegistry()
    const shortSecret = '317'
    expect(admitFillValue(DEFAULT_PRIVACY_POLICY, text({ type: 'password', name: 'pin' }), shortSecret, registry)).toEqual({
      kind: 'redacted',
      reason: 'FIELD_SENSITIVE',
    })
    expect(registry.overflowed).toBe(true)
    expect(registry.contains(`Current value ${shortSecret}`)).toBe(true)
    expect(locatorCandidates(element({ testId: null, id: null, css: null, name: `Current value ${shortSecret}` }), registry)).toEqual([])
    expect(sanitizeErrorText(`Current value ${shortSecret}`, registry).message).toBe('[REDACTED]')
    expect(sanitizeNavigation(`${ORIGIN}/${shortSecret}`, ORIGIN, registry)).toEqual({ ok: false, reason: 'NAVIGATION_PATH_SENSITIVE' })
    expect(assessRenderedText(`Current value ${shortSecret}`, registry)).toEqual({ ok: false, reason: 'IMAGE_TEXT_UNVERIFIED' })
  })

  it('redacts URL-encoded reflections of refused values from free-text metadata', () => {
    const registry = new RedactedValueRegistry()
    const secret = 'private+handle/42'
    const encoded = encodeURIComponent(secret)
    registry.remember(secret)
    expect(locatorCandidates(element({ testId: null, id: null, css: null, name: `Current value ${secret.toUpperCase()}` }), registry)).toEqual([])
    expect(locatorCandidates(element({ testId: null, id: null, css: null, name: `Current value ${encoded}` }), registry)).toEqual([])
    expect(sanitizeErrorText(`Current value ${secret.toUpperCase()}`, registry).message).not.toContain(secret.toUpperCase())
    expect(sanitizeErrorText(`Current value ${encoded}`, registry).message).not.toContain(encoded)
    const source = sanitizeSourceText(`const user = "${encoded}"`, registry)
    expect(source.ok && source.text).not.toContain(encoded)
    const navigation = sanitizeNavigation(`${ORIGIN}/?q=${encoded}`, ORIGIN, registry)
    expect(navigation.ok).toBe(false)
  })

  it('redacts form-encoded reflections that use plus for spaces', () => {
    const registry = new RedactedValueRegistry()
    registry.remember('private handle')
    const reflected = 'private+handle'
    expect(locatorCandidates(element({ testId: null, id: null, css: null, name: `Current value ${reflected}` }), registry)).toEqual([])
    expect(sanitizeErrorText(`Current value ${reflected}`, registry).message).not.toContain(reflected)
    const source = sanitizeSourceText(`const handle = "${reflected}"`, registry)
    expect(source.ok && source.text).not.toContain(reflected)
    expect(sanitizeNavigation(`${ORIGIN}/?q=${reflected}`, ORIGIN, registry)).toEqual({ ok: false, reason: 'NAVIGATION_QUERY_SENSITIVE' })
  })
})

describe('locator sanitization', () => {
  it('keeps the preferred test-id, role and simple CSS candidates in order, each S1-valid', () => {
    const candidates = locatorCandidates(element(), new RedactedValueRegistry())
    expect(candidates).toEqual([
      { kind: 'test-id', value: 'save' },
      { kind: 'role', role: 'button', name: 'Save task' },
      { kind: 'css', selector: 'button#save' },
    ])
    for (const candidate of candidates) expect(LocatorSchema.safeParse(candidate).success).toBe(true)
  })

  it('drops names carrying reflected input, secret shapes, control characters or excess length instead of truncating', () => {
    const registry = new RedactedValueRegistry()
    registry.remember('Typed-Private-Name')
    for (const name of ['Delete Typed-Private-Name', 'token=abcdef123456', 'Save\u200b task', 'n'.repeat(129)]) {
      expect(locatorCandidates(element({ name }), registry).map((candidate) => candidate.kind), name).toEqual(['test-id', 'css'])
    }
    expect(locatorCandidates(element({ name: '  Save\n   task ' }), registry)[1]).toEqual({ kind: 'role', role: 'button', name: 'Save task' })
  })

  it('removes content-derived names inside private regions while keeping structural locators', () => {
    expect(locatorCandidates(element({ private: true, name: 'Balance 1,234' }), new RedactedValueRegistry())).toEqual([
      { kind: 'test-id', value: 'save' },
      { kind: 'css', selector: 'button#save' },
    ])
  })

  it('rejects attribute, value-bearing or reflected selectors and returns no candidate when nothing is safe', () => {
    const registry = new RedactedValueRegistry()
    registry.remember('alice-private')
    expect(locatorCandidates(element({ testId: 'row:alice-private', role: null, css: 'input[value="x"]' }), registry)).toEqual([])
    expect(locatorCandidates(element({ testId: null, role: 'button', name: '', css: 'li#alice-private' }), registry)).toEqual([])
    expect(locatorCandidates(element({ testId: 'a b', role: 'not-a-role', css: null }), registry)).toEqual([])
  })
})

describe('navigation and URL sanitization', () => {
  const registry = new RedactedValueRegistry()
  registry.remember('private-handle')

  it('keeps an admitted relative same-origin path with a safe query and fragment', () => {
    expect(sanitizeNavigation(`${ORIGIN}/board/done?view=compact#top`, ORIGIN, registry)).toEqual({ ok: true, path: '/board/done?view=compact#top' })
    expect(sanitizeNavigation(`${ORIGIN}/`, ORIGIN, registry)).toEqual({ ok: true, path: '/' })
  })

  it('refuses private query keys and recognizable sensitive values in URL paths or queries', () => {
    const cases: Array<[string, string]> = [
      [`${ORIGIN}/profile?email=alice@example.test`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/verify?pin=317`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/contact?phone=5551234567`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/account?username=alice`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/billing?card_number=demo-card-value`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/search?q=alice@example.test`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/search?view=compact;pin=317`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/users/alice@example.test`, 'NAVIGATION_PATH_SENSITIVE'],
      [`${ORIGIN}/records/123456789`, 'NAVIGATION_PATH_SENSITIVE'],
      [`${ORIGIN}/profile;pin=317`, 'NAVIGATION_PATH_SENSITIVE'],
    ]
    for (const [href, reason] of cases) expect(sanitizeNavigation(href, ORIGIN, registry), href).toEqual({ ok: false, reason })
  })

  it('makes cross-origin, credentialed, secret-query, reflected or encoded navigation unsupported', () => {
    const cases: Array<[string, string]> = [
      ['https://example.com/board', 'NAVIGATION_CROSS_ORIGIN'],
      ['http://localhost:43162/board', 'NAVIGATION_CROSS_ORIGIN'],
      ['http://user:pw@localhost:43161/board', 'NAVIGATION_CREDENTIALS'],
      [`${ORIGIN}/board?access_token=abc`, 'NAVIGATION_QUERY_SENSITIVE'],
      // Secret-named keys without a recognizable secret value shape are still refused.
      [`${ORIGIN}/board?credentials=abc`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/board?view=all&token`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/board?q=private-handle`, 'NAVIGATION_QUERY_SENSITIVE'],
      [`${ORIGIN}/users/private-handle`, 'NAVIGATION_PATH_SENSITIVE'],
      [`${ORIGIN}/space%20name`, 'NAVIGATION_PATH_UNSUPPORTED'],
      ['not a url', 'NAVIGATION_INVALID'],
    ]
    for (const [href, reason] of cases) expect(sanitizeNavigation(href, ORIGIN, registry), href).toEqual({ ok: false, reason })
  })
})

describe('error and source text sanitization', () => {
  it('redacts credentials and reflected values and yields an S1-valid bounded message', () => {
    const registry = new RedactedValueRegistry()
    registry.remember('Reflected-Value-9')
    const result = sanitizeErrorText('fetch failed Authorization: Bearer fpseedbearer1234567 for Reflected-Value-9\u0000 at https://x.test/a?token=1', registry)
    expect(result.message).not.toMatch(/fpseedbearer1234567|Reflected-Value-9|token=1|\u0000/)
    expect(result.redactions).toBeGreaterThanOrEqual(3)
    expect(safeTextSchema(2_048, { multiline: true }).safeParse(result.message).success).toBe(true)
  })

  it('replaces an over-long message whole rather than cutting a secret in half', () => {
    const long = `${'a'.repeat(2_040)} sk-abcdefghijklmnopqrstu`
    const result = sanitizeErrorText(long, new RedactedValueRegistry())
    expect(result.message).toMatch(/^\[OMITTED: /)
    expect(result.message).not.toContain('sk-abc')
    // Even when redaction would shrink it under the bound, over-long raw text is never kept in part.
    const shrinking = sanitizeErrorText(`${'x'.repeat(1_990)} https://h.test/a?${'q'.repeat(100)}`, new RedactedValueRegistry())
    expect(shrinking.message).toMatch(/^\[OMITTED: /)
  })

  it('gives two different redacted secrets the same safe text, so fingerprints carry no secret', () => {
    const registry = new RedactedValueRegistry()
    expect(sanitizeErrorText('token=aaaaaaaaaaaa1', registry).message).toBe(sanitizeErrorText('token=bbbbbbbbbbbb2', registry).message)
    expect(sanitizeErrorText('', registry).message).toBe('(empty)')
  })

  it('redacts inline credentials from admitted source text', () => {
    const result = sanitizeSourceText('const apiKey = "sk-abcdefghijklmnop1234"\nexport const title = "Board"\n', new RedactedValueRegistry())
    expect(result.ok && result.text).toContain('export const title = "Board"')
    expect(result.ok && result.text).not.toContain('sk-abcdefghijklmnop1234')
    expect(sanitizeSourceText('ok\u202etext', new RedactedValueRegistry())).toEqual({ ok: false, reason: 'SOURCE_CONTROL_CHARACTER' })
  })
})

describe('rendered surface assessment', () => {
  it('rejects an image whose rendered text shows a secret shape or a reflected redacted value', () => {
    const registry = new RedactedValueRegistry()
    registry.remember('Reflected-Secret-5')
    expect(assessRenderedText('Board  Done  3 tasks', registry)).toEqual({ ok: true })
    expect(assessRenderedText('Your key: sk-abcdefghijklmnop1234', registry)).toEqual({ ok: false, reason: 'IMAGE_SENSITIVE_TEXT' })
    expect(assessRenderedText('Hello Reflected-Secret-5', registry)).toEqual({ ok: false, reason: 'IMAGE_SENSITIVE_TEXT' })
    expect(assessRenderedText(null, registry)).toEqual({ ok: false, reason: 'IMAGE_TEXT_UNVERIFIED' })
  })

  it('reads PNG dimensions from the IHDR chunk and rejects non-PNG bytes', () => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(640, 16)
    png.writeUInt32BE(480, 20)
    expect(readPngSize(png)).toEqual({ width: 640, height: 480 })
    expect(readPngSize(Buffer.from('GIF89a'))).toBeNull()
  })
})

describe('collection boundary', () => {
  it('never calls trace, video, HAR, cookie, storage, header or body collection APIs', async () => {
    for (const file of ['projectPrivacy.ts', 'projectRecorder.ts']) {
      const source = await readFile(path.join(ROOT, 'packages/flowproof/src/capture', file), 'utf8')
      const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const api of [/\.tracing\b/, /recordVideo/, /recordHar/, /routeFromHAR/, /\.cookies\(/, /storageState/, /\.(?:all)?[hH]eaders\(/, /headerValue/, /postData/, /\.body\(/, /\.text\(\)/, /\.json\(\)/, /desktopCapturer|getDisplayMedia/]) {
        expect(api.test(code), `${file}: ${api}`).toBe(false)
      }
    }
  })
})

describe('S3 review privacy regressions', () => {
  const admitting = createPrivacyPolicy({ admitSafeValues: true })
  const plain: FieldDescriptor = { tag: 'input', type: 'text', name: 'note', label: 'Note', placeholder: null, autocomplete: null, private: false } as FieldDescriptor

  it('treats an unreadable oversized input value as privacy-unverified without remembering it', () => {
    const values = new RedactedValueRegistry()
    expect(admitFillValue(admitting, plain, null, values)).toEqual({ kind: 'redacted', reason: 'VALUE_TOO_LONG' })
    expect(values.overflowed, 'later reflections of the unknown value cannot be verified').toBe(true)
    expect(values.size).toBe(0)
    expect(values.contains('any later reflection')).toBe(true)
    const selected = new RedactedValueRegistry()
    expect(admitSelectValue(admitting, plain, null, selected).kind).toBe('redacted')
    expect(selected.overflowed).toBe(true)
  })

  it('shares the navigation sensitive-path checks with network-error paths', () => {
    const values = new RedactedValueRegistry()
    expect(navigationPathSensitive('/reset;token=synthetic-private-value', values)).toBe(true)
    expect(navigationPathSensitive('/missing.json', values)).toBe(false)
    expect(sanitizeNavigation('http://localhost:1/reset;token=synthetic-private-value', 'http://localhost:1', values)).toEqual({ ok: false, reason: 'NAVIGATION_PATH_SENSITIVE' })
  })
})
