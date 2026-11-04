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
