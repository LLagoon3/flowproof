# Spec006 S5 verification — real model analysis/correction adapter

Slice S5 (T023, T027–T028, T031). This file records only what was actually run; it does not
claim live provider, image-interpretation, strict-schema or human acceptance (T053/T054).

## Unit A — contract-first prompt construction (T023 partial, T027)

Base: `76df76a` (main after S3 PR28 merge). Author: Opus implementation unit, no provider calls.

| Step | Command | Result |
| --- | --- | --- |
| Red-first | `npx vitest run --project contract tests/contract/project-model.test.ts` before `projectPrompt.ts` existed | failed: module `projectPrompt.js` not found (no tests ran) |
| Green | same command after T027 | 1 file, 16 tests passed, 0 skipped |
| Typecheck | `flock -w 1800 /tmp/flowproof-spec006-heavy.lock npm run typecheck` | passed (root + recursive packages) |

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s5-unit-a/`.

Proven in-process (pure builder, no transport, network, filesystem, environment or clock):

- Selected retained PNGs are sent as `input_image` `data:image/png;base64` blocks whose decoded
  bytes and SHA-256 equal the capture artifact; each is preceded by an observation-ID/digest label;
  no artifact ID, filename or base64 text surrogate appears in text blocks.
- Wrong digest, missing bytes, non-PNG bytes and zero available images fail closed
  (`PROMPT_IMAGE_*`); there is no text-only image fallback.
- System-owned per-phase instructions never contain untrusted text; untrusted capture/source/
  user text is carried only as JSON data bound to run, invocation, capture, report digest,
  baseline commit and host-minted question ID.
- S3 `sanitizeSourceText`/`sanitizeErrorText`/registry redaction run before hashing; reflected
  values never reach the serialized request; unsafe source and an unverified registry are rejected.
- Sources: unique admitted `src/` paths only, sorted; exactly 32 files/256 KiB accepted, one more
  file or byte rejected (`PROMPT_SOURCE_LIMIT`), never truncated.
- Deterministic disclosed selection: interaction-referenced observations and the final image are
  essential; other images fill the 8-image and 8 MiB budgets in host order; every omission is
  disclosed in manifest and context; essential overflow is rejected (`PROMPT_ESSENTIAL_OMISSION`,
  `PROMPT_REQUEST_LIMIT`). The exact serialized request is checked against 8 MiB.
- Same input in any source/image-map order yields identical bytes; `input_sha256` is the SHA-256 of
  the exact `{instructions, input}` serialization; the manifest parses into an S1
  `ProviderInvocation` (`started`).
- Closed outputs: S1 `ready|clarify|unsupported` result plus a strict correction output; citations
  must be included observation IDs; `clarify` must echo the host question ID and is refused in
  clarified analysis; correction `target_paths` must be included admitted sources; extra fields
  such as a pass verdict are rejected. Nothing is applied.
- Clarified analysis requires this capture's first `clarify` interpretation and a valid answer.
  Correction requires a digest-valid frozen definition, the intended baseline failure and
  same-run baseline evidence.

Open for unit B (T023 stays partial): client/auth/redirect/no-retry/no-tools, call budgets,
90 s timeout, sticky cancellation, requested/observed model + response-ID validation, wire
`text.format` strict-schema mapping, and the isolated live-smoke discovery gate (T028, T031).
Live strict-schema/image compatibility remains unproven until T053.

## Unit B — project Meta client and opt-in live gate (T023 complete, T028; T031 authored only)

Base: `503d0ec` (unit A). No provider was called; every client result below came from in-process
HTTP fakes explicitly labelled `test_transport`, which can never satisfy live acceptance.

| Step | Command | Result |
| --- | --- | --- |
| Red-first | `npx vitest run --project contract tests/contract/project-model.test.ts` before `projectClient.ts` existed | failed: module `projectClient.js` not found (no tests ran) |
| Green | same command | 1 file, 47 tests passed, 0 skipped |
| Typecheck | `flock -w 1800 /tmp/flowproof-spec006-heavy.lock npm run typecheck` | passed |
| Contract project | `npx vitest run --project contract` (under the same lock) | 12 files, 451 tests passed |
| Discovery (T003 test) | `npx vitest run --project integration tests/integration/project-live-discovery.test.ts` | 5 passed |
| Real lister | `vitest list --filesOnly` with the default `unit/contract/integration/ui` projects vs `--project project-meta-smoke` | default 59 files, 0 smoke files; explicit project lists only `tests/integration/project-live-meta-smoke.test.ts` |

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s5-unit-b/`.

Proven in-process for `packages/flowproof/src/model/projectClient.ts`:

- One stateless POST to the fixed `https://api.meta.ai/v1/responses`, `muse-spark-1.3`,
  `store: false`, body keys exactly `model/instructions/input/store/text`; `input` equals the prompt's
  structured blocks, so the decoded `input_image` bytes hash to the retained PNGs; strict closed
  phase formats (analysis `{result: ready|clarify|unsupported}`, clarified `{result: ready|unsupported}`,
  correction `{summary, citations, target_paths, patch}`); `redirect: 'error'`; only
  accept/authorization/content-type headers.
- Key read only from the explicit host `env.MODEL_API_KEY`; process `MODEL_API_KEY`/`OPENAI_*`
  values (base URL, custom headers, key) are ignored; a blank key fails before any send.
- Completed records parse as S1 `ProviderInvocation` with the validated observed model and response
  ID, prompt `input_sha256`/included IDs and the actual wire `request_bytes` (within 8 MiB for the
  largest fitted prompt). A different/missing model or a missing/malformed response ID fails as
  `PROVIDER_IDENTITY_MISMATCH`; nothing is copied from configuration.
- Strict output: an uncited observation, an unwrapped or extra-field result, non-JSON, an incomplete,
  refused or multi-part response and a foreign question ID all fail with codes; correction targets
  outside the included sources fail. HTTP 500/429/400/401/307 fail once with fixed text, no retry
  or redirect, and the provider error text, reasoning and key never appear in results or records.
- Per-run budgets: one analysis (a failed one is not retried), one clarified re-analysis admitted
  only by this run's validated `clarify` with the same question/capture, one correction admitted
  only after this run's validated `ready` analysis of the same capture. A concurrent call is
  `PROVIDER_BUSY`. Tampered, foreign-run or wrong-route prompts are refused before sending.
- The 90 s default per-exchange budget is enforced (shortened in tests) even when the provider
  never answers; cancellation is sticky; a late valid response stays `cancelled`; later calls
  send nothing.
- Prompt builder (unit A API preserved, additive): the manifest binds the answered clarification;
  `serialized` keeps a 32 KiB envelope reserve under 8 MiB; the 64-observation cap includes exactly
  64 in host order, discloses `REQUEST_OBSERVATION_LIMIT` omissions and rejects essential overflow.
- Legacy `diagnose()`, `prompt.ts`, `metaClient.ts` and `transport.ts` are unchanged.

Boundaries and gaps:

- The correction prompt's `baseline.outcome` is a host-supplied boundary. Neither this client nor
  its fakes prove an executed baseline replay; S6 (T038/T041) must derive it from actual replay.
- T031 `tests/integration/project-live-meta-smoke.test.ts` is authored, typechecked and isolated
  but NOT executed. Without `MODEL_API_KEY` it fails with a blocker message (no skip). Live
  strict-schema, image interpretation, quota and identity compatibility remain unproven until T053.
