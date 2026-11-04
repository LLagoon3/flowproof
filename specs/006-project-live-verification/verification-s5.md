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

## Unit C — parent correction: prompt provenance and snapshot integrity

Base: `d03e272`. Defect independently reproduced by the parent with
`/tmp/flowproof-s5-parent-binding-probe.mjs` (no provider): a spread copy of a built prompt whose
`manifest.included_observation_ids` added a UUID absent from the serialized request was admitted
(`accepted:true, calls:1, invocation_includes_unknown:true`; parent red retained unchanged at
`.flowproof/task-logs/006-project-live-verification/s5-parent/manifest-red.json`). Admission hashed only
instructions/input, the validators trusted the copied manifest, and nested prompt/manifest arrays were
mutable while an exchange was pending.

Fix (no new trust root, no cryptographic claim; in-process host provenance only):

- Builders snapshot every caller-supplied value exactly once (sources, run/invocation IDs, capture,
  description, question, clarification, definition, baseline boundary) before validation.
- Each built prompt re-derives its provenance from the actual request blocks (bindings, image labels,
  decoded image digests, included observation IDs, source paths/digests, omissions, clarification)
  and must match the manifest exactly, then is deeply frozen and registered as builder-owned.
- The client admits only builder-owned prompts (`isBuiltProjectPrompt`); copies, `structuredClone`s
  and rebound manifests are `PROVIDER_PROMPT_INVALID` before any send. Validators return
  `PROMPT_UNTRUSTED` for non-built prompts. The client fixes the exact request body before any await
  and refuses to send any body other than it.

| Step | Command | Result |
| --- | --- | --- |
| Red-first | focused `project-model.test.ts` with new cases, before the fix | 14 failed, 48 passed (62); the one new passing case is phase rebinding, already refused by the prior phase check |
| Green | same command | 62 passed, 0 skipped |
| Typecheck + build | `flock -w 1800 /tmp/flowproof-spec006-heavy.lock npm run typecheck` / `npm run build` | passed (first attempt failed on two type errors, fixed, then passed) |
| Parent probe | `node /tmp/flowproof-s5-parent-binding-probe.mjs --green` against the rebuilt `dist` | `accepted:false, calls:0, error:PROVIDER_PROMPT_INVALID`; original-mode run now fails its old acceptance assertion as expected |
| Contract project | `npx vitest run --project contract` (under the lock, before the type-only fix) | 12 files, 466 passed |
| Discovery | `tests/integration/project-live-discovery.test.ts` | 5 passed |

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s5-unit-c/`.

New proofs: the manifest-adds-unknown-evidence probe case; rebinding image IDs, source paths,
source digests, question, capture, report, clarification, phase or nothing (structural copy and
`structuredClone`) is refused with zero sends; deep freezing of prompt/input/content/manifest
arrays; caller mutation of capture/sources/image map and attempted prompt mutation while an exchange
is pending leaves the serialized bytes, wire `input` hash and record provenance unchanged; a getter
that changes a source path after N reads (N = 1..10) can never smuggle an unadmitted path; a baseline
`outcome` getter cannot change the sent context; a copied correction prompt cannot widen target paths
or rebind the definition digest.

Gap: provenance is in-process object identity for the trusted host; it is not a signature and does
not survive serialization across processes (none is used). Live calls remain T053.


## Independent parent verification before publication

At implementation HEAD `dd22ef0ca42ea4d24b172d585fc654cc29a764fe`, the parent inspected the actual
unit C source/test diff and independently ran all following checks under the exact shared
`/tmp/flowproof-spec006-heavy.lock` lease (no actual provider request):

- `pnpm typecheck` and `pnpm build`: passed.
- Complete contract project: 12 files, 466 passed, zero skipped.
- Legacy prompt/client/transport and project-live discovery: four files, 60 passed, zero skipped.
- Original independent manifest-only evidence-rebinding probe against rebuilt production modules:
  rejected before transport, `PROVIDER_PROMPT_INVALID`, zero calls. The historical red remains intact.
- A separate independent built-module probe rejects a structurally cloned prompt with no invocation,
  then admits the genuine prompt. Nested mutation attempts while the exchange is pending throw;
  its legitimate cited response remains usable, the wire input hash matches the invocation and
  no unadmitted source path enters the request. Exactly one explicitly labelled `test_transport`
  call, not a live provider call.
- `git diff --check`: passed. Legacy `prompt.ts`, `metaClient.ts` and `transport.ts` remain unchanged.

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s5-parent-final/`.
These are module/protocol-contract checks, not proof of a reproduced baseline, actual image-model
compatibility, full project workflow or human usability. T031 remains authored but unchecked until
its explicit live execution in T053. Full default/headed hosted CI and exact-head review are separate
publication/merge gates, recorded in PR metadata without a results-only source commit afterward.

## Units D/D2 — CI E2E `canvas-plausible-wrong`: released frame shown live

PR31 CI 41922770619 failed one legacy captured-verification case
(`expectGuardedPane`: first `!frameAttached` sample index 5, last live-labelled index 5). Not a
sample-count threshold: one rAF sample showed a live label on a physically detached iframe.

Cause (code path, then controlled reproduction): `verify/capturedRun.ts` emits its `scan` and
`cleanup` activity (which ends the live presentation in `selectCapturedTarget`) and then calls
`disposeCapture`, whose `studio/launch.ts` `releaseTargetFrame` removes the iframe directly through
CDP. The Studio learns of the activity only through the SSE stream and a React render, so nothing
ordered the presentation against the physical removal; a late delivered measured-phase event could
also present an already released frame as live. Not caused by the S5 model/prompt code.

Fix (`cb41b5e`): `TargetPane` (captured mode only) observes its iframe's removal with a
MutationObserver and commits a sticky `not-live` label with `flushSync` in that microtask, before
the next frame; a later stale live event cannot re-live it, the iframe is never recreated, and
cover/focus/guard, the keyed live wrapper, completed-evidence replacement and the legacy Studio are
unchanged. The UI browser-safety allowlist adds exactly `react-dom` (same pinned 19.3.1 browser
dependency as the allowed `react-dom/client`, root entry used only for `flushSync`); the engine/Zod/
Node guard is unchanged.

Harness fact: the E2E harness clones committed HEAD (`tests/support/repoFixture.ts`), so every run
below names its exact tested SHA. Unit D's earlier "6 passed, 1 failed" run tested the test-only
`9ec3669`, not the then-uncommitted fix.

| Run (exact heavy lock) | Tested SHA | Result |
| --- | --- | --- |
| Unit D controlled red: 300 ms delay of the Studio's own run events | `9ec3669` (no fix) | failed as CI: released index 4, last live 5 |
| Unit D2, fixed delay with fix | `cb41b5e` | original assertion passed; candidate-live then honestly never shown, so a fixed-delay expectation was nondeterministic and was replaced |
| Deterministic red: hold Studio replay events until the iframe is detached, then deliver paced by animation frames | `d2d1c9a` (temporary revert of the fix, later dropped) | failed: `candidate-live` presented after the release |
| Green: all captured-verification E2E (`--list`: 7 tests in 1 file) | `2fcbf74` | 7 passed, 0 skipped, 0 flaky |
| UI project | `2fcbf74` | 4 files, 378 passed |
| Typecheck + build | `2fcbf74` | passed |

The held-event case asserts the hold engaged (`held > 0`, started while attached, drained). No timeout,
retry or existing assertion was weakened; no fixed sleep decides the controlled case. No flowproof
containers remained. Full suite, providers and publication were not run.
Logs: ignored `.flowproof/task-logs/006-project-live-verification/s5-unit-d{,2}/`.
