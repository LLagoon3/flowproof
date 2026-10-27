import { describe, expect, it } from 'vitest'

import {
  MAX_CHAT_TEXT_LENGTH,
  REDACTED,
  sanitizeArtifact,
  sanitizeChatText,
  sanitizeConsoleEntries,
  sanitizeFilesystemPath,
  sanitizeHeaders,
  sanitizeNetworkObservation,
  sanitizeProviderOutput,
  sanitizeSourceContent,
  sanitizeText,
  sanitizeUrl,
} from '../../packages/flowproof/src/evidence/sanitize.js'

const SEEDED = 'FLOWPROOF_SEEDED_SECRET_ALPHA'

describe('sanitizeText', () => {
  it('redacts bearer tokens', () => {
    const result = sanitizeText(`request failed: Authorization: Bearer ${SEEDED}abcdefgh`)

    expect(result.value).not.toContain(SEEDED)
    expect(result.value).toContain(REDACTED)
    expect(result.redactions.some((redaction) => redaction.category === 'credential')).toBe(true)
  })

  it('redacts provider-style keys and assignments', () => {
    const samples = [
      'sk-abcdefghijklmnopqrstuvwx',
      'MODEL_API_KEY=sk-abcdefghijklmnopqrstuvwx',
      'api_key: abcdefghijklmnopqrst',
      'AKIAIOSFODNN7EXAMPLE',
    ]

    for (const sample of samples) {
      const result = sanitizeText(`log line ${sample} end`)
      expect(result.value, sample).toContain(REDACTED)
      expect(result.value, sample).not.toContain('abcdefghijklmnopqrstuvwx')
      expect(result.value, sample).not.toContain('AKIAIOSFODNN7EXAMPLE')
    }
  })

  it('redacts complete quoted credential assignments with whitespace', () => {
    const samples = [
      ['password = "correct horse battery staple"', `password = "${REDACTED}"`],
      ["api_key: 'alpha beta gamma'", `api_key: '${REDACTED}'`],
      ['"secret": "value with an escaped \\"quote\\" inside"', `"secret": "${REDACTED}"`],
    ] as const

    for (const [sample, expected] of samples) {
      const once = sanitizeText(`before ${sample} after`)
      const twice = sanitizeText(once.value)

      expect(once.value, sample).toBe(`before ${expected} after`)
      expect(once.redactions, sample).toEqual([{ category: 'credential', count: 1 }])
      expect(twice, sample).toEqual({ value: once.value, redactions: [] })
    }
  })

  it('leaves ordinary evidence text and content digests untouched', () => {
    const digest = 'a'.repeat(64)
    const result = sanitizeText(`dataset digest ${digest} contains 8 rows`)

    expect(result.value).toBe(`dataset digest ${digest} contains 8 rows`)
    expect(result.redactions).toEqual([])
  })

  it('redacts the whole bearer token, including underscores', () => {
    const result = sanitizeText(`retry with Bearer ${SEEDED}_tail`)

    expect(result.value).toBe(`retry with Bearer ${REDACTED}`)
    expect(result.value).not.toContain('SEEDED_SECRET')
  })

  it('is idempotent on already sanitized text', () => {
    const once = sanitizeText(`Authorization: Bearer ${SEEDED} api_key=abcdefghijklmnop Cookie: a=b`)
    const twice = sanitizeText(once.value)

    expect(twice.value).toBe(once.value)
    expect(twice.redactions).toEqual([])
  })

  it('keeps token-count metrics that only resemble secret names', () => {
    const metrics = 'input_tokens: 179 output_tokens: 318 total_tokens=497'

    expect(sanitizeText(metrics)).toEqual({ value: metrics, redactions: [] })
    expect(sanitizeArtifact({ input_tokens: 179, output_tokens: 318 }).redactions).toEqual([])
  })

  it('counts every redaction it performs', () => {
    const result = sanitizeText('Bearer tokenvalue111111 and Bearer tokenvalue222222')

    const credential = result.redactions.find((redaction) => redaction.category === 'credential')
    expect(credential?.count).toBe(2)
  })
})

describe('sanitizeHeaders', () => {
  it('drops authorization, cookie, and api-key headers', () => {
    const result = sanitizeHeaders({
      'content-type': 'application/json',
      authorization: `Bearer ${SEEDED}`,
      cookie: `flowproof_launch=${SEEDED}`,
      'set-cookie': `session=${SEEDED}`,
      'x-api-key': SEEDED,
    })

    expect(Object.keys(result.value)).toEqual(['content-type'])
    expect(JSON.stringify(result.value)).not.toContain(SEEDED)
    const categories = result.redactions.map((redaction) => redaction.category)
    expect(categories).toContain('header')
    expect(categories).toContain('cookie')
  })

  it('matches header names case-insensitively', () => {
    const result = sanitizeHeaders({ Authorization: 'Bearer abc', 'Set-Cookie': 'a=b' })

    expect(Object.keys(result.value)).toEqual([])
  })
})

describe('sanitizeUrl', () => {
  it('removes the query string and fragment but keeps origin and path', () => {
    const result = sanitizeUrl(`http://localhost:43119/api/data?token=${SEEDED}#frag`)

    expect(result.value).toBe('http://localhost:43119/api/data')
    expect(result.redactions.some((redaction) => redaction.category === 'query')).toBe(true)
  })

  it('reports no redaction when there is nothing to remove', () => {
    const result = sanitizeUrl('http://localhost:43119/index.html')

    expect(result.value).toBe('http://localhost:43119/index.html')
    expect(result.redactions).toEqual([])
  })
})

describe('sanitizeNetworkObservation', () => {
  it('keeps only metadata and drops headers, bodies, and query strings', () => {
    const result = sanitizeNetworkObservation({
      method: 'GET',
      url: `http://localhost:43119/data.json?key=${SEEDED}`,
      status: 200,
      mime_type: 'application/json',
      duration_ms: 12,
      request_headers: { authorization: `Bearer ${SEEDED}` },
      response_body: `{"secret":"${SEEDED}"}`,
    })

    expect(result.value).toEqual({
      method: 'GET',
      origin: 'http://localhost:43119',
      path: '/data.json',
      status: 200,
      mime_type: 'application/json',
      duration_ms: 12,
    })
    expect(JSON.stringify(result.value)).not.toContain(SEEDED)
    const categories = result.redactions.map((redaction) => redaction.category)
    expect(categories).toContain('query')
    expect(categories).toContain('header')
    expect(categories).toContain('body')
  })
})

describe('sanitizeConsoleEntries', () => {
  it('redacts credentials inside console text', () => {
    const result = sanitizeConsoleEntries([
      { level: 'error', text: `fetch rejected with Bearer ${SEEDED}aaaaaaaa` },
      { level: 'warning', text: 'filtered row count is 8' },
    ])

    expect(result.value[0]?.text).not.toContain(SEEDED)
    expect(result.value[1]?.text).toBe('filtered row count is 8')
    expect(result.value).toHaveLength(2)
  })

  it('strips query strings and fragments from URLs mentioned in console text', () => {
    const result = sanitizeConsoleEntries([
      { level: 'error', text: `GET http://localhost:43119/data.json?session=${SEEDED}#top failed` },
    ])

    expect(result.value[0]?.text).toBe('GET http://localhost:43119/data.json failed')
    expect(result.redactions.map((redaction) => redaction.category)).toContain('query')
  })
})

describe('sanitizeSourceContent', () => {
  it('redacts inline credentials in captured source context', () => {
    const result = sanitizeSourceContent(`const key = 'sk-abcdefghijklmnopqrstuvwx'\nexport const n = 1\n`)

    expect(result.value).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(result.value).toContain('export const n = 1')
  })
})

describe('sanitizeFilesystemPath', () => {
  it('rewrites an absolute path inside the repository to a relative path', () => {
    const result = sanitizeFilesystemPath('/srv/project/apps/demo-chart/src/filterData.ts', {
      repoRoot: '/srv/project',
    })

    expect(result.value).toBe('apps/demo-chart/src/filterData.ts')
    expect(result.redactions.some((redaction) => redaction.category === 'path')).toBe(true)
  })

  it('redacts an absolute path outside the repository', () => {
    const result = sanitizeFilesystemPath('/home/someone/.config/credentials', { repoRoot: '/srv/project' })

    expect(result.value).toBe(REDACTED)
    expect(result.value).not.toContain('someone')
    expect(result.redactions.some((redaction) => redaction.category === 'path')).toBe(true)
  })

  it('passes an already relative repository path through unchanged', () => {
    const result = sanitizeFilesystemPath('apps/demo-chart/src/filterData.ts', { repoRoot: '/srv/project' })

    expect(result.value).toBe('apps/demo-chart/src/filterData.ts')
    expect(result.redactions).toEqual([])
  })
})

describe('sanitizeChatText', () => {
  it('redacts credentials and bounds the developer goal', () => {
    const result = sanitizeChatText(`fix it, key is sk-abcdefghijklmnopqrstuvwx ${'x'.repeat(900)}`)

    expect(result.value).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(result.value.length).toBeLessThanOrEqual(MAX_CHAT_TEXT_LENGTH)
  })

  it('strips markup so chat is never rendered as HTML', () => {
    const result = sanitizeChatText('<script>alert(1)</script>verify the filter')

    expect(result.value).not.toContain('<script>')
  })
})

describe('sanitizeProviderOutput', () => {
  it('redacts credentials nested anywhere in untrusted model output', () => {
    const result = sanitizeProviderOutput({
      summary: 'use Bearer tokenvalue111111 to retry',
      candidate: { unified_diff: `+const key = 'sk-abcdefghijklmnopqrstuvwx'\n` },
      authorization: 'Bearer tokenvalue222222',
    })

    const serialized = JSON.stringify(result.value)
    expect(serialized).not.toContain('tokenvalue111111')
    expect(serialized).not.toContain('tokenvalue222222')
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })
})

describe('sanitizeArtifact', () => {
  it('walks nested structures, redacting secret-named keys and values', () => {
    const result = sanitizeArtifact({
      rows: [{ region: 'North', revenue: 120 }],
      meta: { cookie: `flowproof_launch=${SEEDED}`, note: `Bearer ${SEEDED}bbbbbbbb` },
      nested: [[{ password: SEEDED }]],
    })

    const serialized = JSON.stringify(result.value)
    expect(serialized).not.toContain(SEEDED)
    expect(serialized).toContain('North')
    expect(result.redactions.length).toBeGreaterThan(0)
  })

  it('preserves non-sensitive evidence values exactly', () => {
    const payload = { labels: ['Q1', 'Q2'], values: [120, 145], bar_count: 2 }
    const result = sanitizeArtifact(payload)

    expect(result.value).toEqual(payload)
    expect(result.redactions).toEqual([])
  })
})
