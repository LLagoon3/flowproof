import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { META_MODEL_ID, parseDiagnosis, parseEvidenceBundle } from '../../packages/flowproof/src/contracts/index.js'
import { validateCitations } from '../../packages/flowproof/src/evidence/ids.js'
import { createMetaTransport } from '../../packages/flowproof/src/model/metaClient.js'
import type { MetaRequestMetrics } from '../../packages/flowproof/src/model/metaClient.js'
import { buildDiagnosisPrompt } from '../../packages/flowproof/src/model/prompt.js'
import { checkMetaReadiness } from '../../packages/flowproof/src/model/transport.js'
import { loadScenario } from '../../packages/flowproof/src/scenario/loadScenario.js'
import { REPO_ROOT, git } from '../support/repoFixture.js'

// T054: the opt-in, credential-gated live Meta protocol smoke. Only `pnpm test:meta-smoke` runs it
// (the `meta-smoke` Vitest project; every default project excludes this file), and without
// MODEL_API_KEY it skips visibly and sends nothing. With a key, the production adapter sends one
// sanitized Hero-shaped diagnosis prompt, built the way a Studio run builds it, to live
// `muse-spark-1.3`; the response must pass the strict diagnosis contract and cite only failure
// Evidence IDs of that prompt. The key is read only by the adapter, from the process environment.
// The smoke reports exactly one allowlisted record — model ID, token counts, latency, schema
// outcome, and citation outcome — and never prints or persists the prompt, provider output,
// provider errors, or the key.

/** `unavailable`: no provider response, or no schema-valid diagnosis, to evaluate. */
type SmokeOutcome = 'pass' | 'fail' | 'unavailable'

interface SmokeRecord {
  readonly model: string
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
  readonly latency_ms: number | null
  readonly schema_outcome: SmokeOutcome
  readonly citation_outcome: SmokeOutcome
}

const RECORD_FIELDS = ['model', 'input_tokens', 'output_tokens', 'total_tokens', 'latency_ms', 'schema_outcome', 'citation_outcome'] as const
const SKIP_NOTE = 'MODEL_API_KEY is not set, so no live Meta request was made.'

const HERO = (await loadScenario('canvas-filter-hero', { repoRoot: REPO_ROOT })).scenario
const [TARGET] = HERO.permitted_source_paths
if (TARGET === undefined) throw new Error('The Hero scenario permits no source file.')

const failure = parseEvidenceBundle(
  JSON.parse(await readFile(new URL('../fixtures/contracts/evidence-bundle.valid-failure.json', import.meta.url), 'utf8')),
)
if (!failure.ok) throw new Error('The failure Evidence Bundle fixture is invalid.')
const FAILURE = failure.value

/** One allowlisted line; every value is a model ID, a count, a duration, or an enumerated outcome. */
function report(record: SmokeRecord): void {
  console.info(`[meta-smoke] ${JSON.stringify(Object.fromEntries(RECORD_FIELDS.map((field) => [field, record[field]])))}`)
}

describe('live Meta protocol smoke', () => {
  it(
    'diagnoses one sanitized Hero-shaped prompt with a schema-valid, evidence-cited response',
    { timeout: HERO.timeouts.model_ms + 30_000 },
    async (context) => {
      if (!checkMetaReadiness(process.env).ready) {
        console.info(`[meta-smoke] skipped: ${SKIP_NOTE}`)
        context.skip(SKIP_NOTE)
      }

      const prompt = buildDiagnosisPrompt({
        runId: FAILURE.run_id,
        goal: HERO.default_request,
        failureBundle: FAILURE,
        observations: { actions: HERO.actions },
        permittedSourcePaths: HERO.permitted_source_paths,
        source: { path: TARGET, content: git(REPO_ROOT, 'show', `HEAD:${TARGET}`) },
      })
      const metrics: MetaRequestMetrics[] = []
      const transport = createMetaTransport({ env: process.env, onMetrics: (record) => metrics.push(record) })

      let output: unknown
      let responded = false
      try {
        output = await transport.diagnose(prompt, { signal: new AbortController().signal, timeoutMs: HERO.timeouts.model_ms })
        responded = true
      } catch {
        // The coded provider failure stays private; the record reports the missing response.
      }

      const diagnosis = responded ? parseDiagnosis(output) : null
      output = undefined
      let citationOutcome: SmokeOutcome = 'unavailable'
      if (diagnosis?.ok) {
        // As in the citation guard, a claim and the candidate may cite the same item once.
        const { claims, candidate } = diagnosis.value
        const cited = [...new Set([...claims.flatMap((claim) => claim.evidence_ids), ...candidate.evidence_ids])]
        citationOutcome = validateCitations({ runId: FAILURE.run_id, failureBundle: FAILURE, citedIds: cited }).valid ? 'pass' : 'fail'
      }
      const [metric] = metrics
      const record: SmokeRecord = {
        model: metric?.model ?? META_MODEL_ID,
        input_tokens: metric?.input_tokens ?? null,
        output_tokens: metric?.output_tokens ?? null,
        total_tokens: metric?.total_tokens ?? null,
        latency_ms: metric?.latency_ms ?? null,
        schema_outcome: diagnosis === null ? 'unavailable' : diagnosis.ok ? 'pass' : 'fail',
        citation_outcome: citationOutcome,
      }
      report(record)

      // Assertions compare only allowlisted record values and counts.
      expect(metrics.length).toBe(1)
      expect(record.model).toBe(META_MODEL_ID)
      expect(record.schema_outcome).toBe('pass')
      expect(record.citation_outcome).toBe('pass')
    },
  )
})
