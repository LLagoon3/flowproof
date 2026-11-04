# Spec006 S6 verification — capture/analysis/verification orchestration

Records only what was run. No provider call, live acceptance (T053) or human walkthrough (T054).

## Unit A — guarded demonstration capture and explicit analysis service (T029 foundation)

Base `21d1f08` (main with S2–S5 merged). Tested committed source `7d609ba0ec069bfadf373d5babeeca13a6e3d706`.

| Step | Command | Result |
| --- | --- | --- |
| Red-first | `npx vitest run --project integration tests/integration/project-analysis.test.ts` before the service | 13 failed: `createProjectDemonstration is not a function` |
| Green | same (exact heavy lock) | 13 passed, 0 skipped |
| Lifecycle regression | `tests/unit/project-lifecycle.test.ts` | 15 passed |
| S3/S5 contracts | `tests/contract/project-capture.test.ts`, `project-model.test.ts` | 95 passed |
| Typecheck | `npm run typecheck` (lock) | passed |

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s6-unit-a/`.

Implemented: `createProjectDemonstration` in `project/run.ts` over the real S4 lifecycle, S5 prompt
builder and per-run client session, plus `demonstrationRecorderOf` adapting the merged S3 recorder
(and `ProjectCaptureSession.analysisRegistry()`, available only after `claimForAnalysis`). Proven with
an explicitly labelled `test_recorder` and `test_transport` HTTP fake: no model request before an
explicit Analyze; one active capture; foreign/reused/discarded capture IDs refused; idempotent Finish;
incomplete or other-configuration reports never become capture-ready or analyzable; Discard and a
settings change delete unsubmitted evidence, and after submission a settings change cancels the run;
interpretations bind run/capture/report/invocation/input digest; exactly one explicit clarification bound
to the current question (stale answer refused, attempt 2 with the answer digest, no third analysis);
sticky cancel discards a late response; missing key, wrong observed model, uncited evidence and a replay
of a redacted reflected value or redaction marker never yield a usable interpretation.

Not done in this unit (open, marks unchanged): T026 real launcher-owned Chromium recorder E2E
(`tests/e2e/project-recording.spec.ts`) exercising `demonstrationRecorderOf`; T029 Studio server routes
(session/Host/Origin/cookie/closed schemas, `/api/project/captures*`, `/runs/:id/clarify`) and launcher
wiring; T030 UI; T032 UI-dependent cases. A prompt-construction failure after the report is claimed
leaves the run in capture-ready with the report locked (only cancel proceeds) and needs an explicit stop.

## Unit A2 — service ownership revocation and fail-closed claimed reports

Base `1e894d0`. Parent reproduced with a synthetic deferred recorder (no provider,
`/tmp/flowproof-s6-parent-service-probe.mjs`, red retained at
`.flowproof/task-logs/006-project-live-verification/s6-parent-a/ownership-red.json`): invalidation was
skipped while start/finish were pending (old recorder became recording / old report capture-ready, not
discarded); a source failure after the claim reported `SOURCES_UNAVAILABLE` but left a claimed report
"discarded" OK when the recorder had actually refused; cancel during finish surfaced `CAPTURE_FAILED`.

Fix (`project/run.ts`): every invalidation/cancellation bumps a generation; work started under an older
generation is revoked after each await (start, finish, source load, claim, model call), discards what it
produced and returns `CAPTURE_INVALIDATED` (or `RUN_NOT_ACCEPTING` once the run stopped), never a stale
success. Invalidation revokes immediately, deletes unclaimed evidence and does not wait on a pending
producer; the service stays busy (`CAPTURE_ACTIVE`) until that producer settled, so nothing is reused
first. Sources load before the irreversible claim. After the claim the analysis state and provider
operation begin before the prompt is built, so a prompt failure or an unexpected thrown model error
(`ANALYSIS_FAILED`) fails the operation and finalizes the run; the report stays `claimed` (locked, unsent)
or `submitted` (a provider request carried its bytes) and is never reported deleted. A discard the
recorder refuses is `CAPTURE_DISCARD_REFUSED` and stops the run. Late completions never publish.

| Step | Tested SHA | Result |
| --- | --- | --- |
| Red-first (9 new cases) | `1e894d0` + tests (`39953e6`) | 9 failed, 13 passed |
| Green focused | `6b63f3e` | 22 passed; parent probe then hung: `invalidate` awaited a pending producer |
| Non-blocking invalidation case + fix | `fc58672` | 23 passed, 0 skipped |
| Lifecycle / S3+S5 contracts (lock) | `fc58672` | 15 passed / 95 passed |
| Typecheck + build (lock) | `fc58672` | passed |
| Parent probe on rebuilt `dist` | `fc58672` | start/finish invalidation `CAPTURE_INVALIDATED` + discarded + demonstration-ready; source failure unclaimed, discard OK and actually discarded; cancel during finish `RUN_NOT_ACCEPTING`/finalizing |

Logs: ignored `.flowproof/task-logs/006-project-live-verification/s6-unit-a2/`. Fakes only (`test_recorder`,
`test_transport`); no provider, Chromium or UI evidence. Task marks unchanged. Remaining: A3 routes, A4
real launcher-owned Chromium recorder (T026), then UI.

## Unit A3 — guarded demonstration routes (T029 server foundation; launcher wiring open)

Base `75e5db2`. Server source `fd7ad01`; final HEAD adds only an unused-import test fix and this note.

Implemented in `studio/server.ts` (project mode only; legacy/captured routes untouched):
`POST /api/project/captures` (closed `{configuration_id, output_sha256}` bound to the confirmed
configuration and the ready prepared output; host mints the run, creates the S4 lifecycle and the
A2 service from launcher ports), `POST /api/project/captures/:id/{finish,discard}` (strict `{}`),
`POST /api/project/captures/:id/analyze` (`{submit: true, description?}` with the S1 safe-text bound),
`POST /api/project/runs/:id/clarify` (`{question_id, answer}`), `POST /api/project/runs/:id/cancel`
(strict `{}`, 202, idempotent) and additive `GET /api/project/runs/:id` (safe service view: state,
capture ID, `report` sealed/claimed/submitted, interpretation, question ID; no registry/key/raw
evidence). All pass through the existing launch-session Host/Origin/cookie/fetch-metadata guard and
JSON content-type/body bound; bodies are validated before identity, identity before side effects;
unknown/foreign capture or run IDs are 404, stale configuration/output 409. New optional port
`ProjectStudioMode.openDemonstration` supplies `startRecorder`/`loadSources`/`model` per host run;
absent, capture start is `409 DEMONSTRATION_UNAVAILABLE`. A settings change and server close end the
demonstration (invalidate, then cancel) before releasing the prepared target.

| Step | Tested SHA | Result |
| --- | --- | --- |
| Red-first route cases (fixtures moved to `tests/support/projectDemonstration.ts`) | `0c99b59` | 5 failed, 12 passed; service suite unchanged 23 passed |
| Green routes | `fd7ad01` | `project-studio.test.ts` 17 passed |
| Contract project (lock) | `fd7ad01` | 13 files, 483 passed |
| Service / lifecycle (lock) | `fd7ad01` | 23 / 15 passed |
| Build (lock) | `fd7ad01` | passed |
| Typecheck (lock) | `fd7ad01` | failed: unused `IMAGE_BYTES` import in the moved test; fixed, then passed |

Fakes only: labelled `test_recorder` and `test_transport`; the route tests use the real admitted
sample, profile validation and guard. Not yet done (marks unchanged): the launcher implementation of
`openDemonstration` in `startProjectStudio` (real `startProjectRecorder` on the Studio page's target
frame via `demonstrationRecorderOf`, `CaptureBinding` from configuration/output digest, frozen admitted
`src/` sources from an admission snapshot, host `MODEL_API_KEY` session), then A4 real Chromium T026.
Source selection beyond the builder's 32-file/256-KiB bound is not defined; such projects fail closed.

## Unit A3 correction — configuration revocation of the demonstration

Base `91844e1`. Parent reproduced (labelled fakes, no provider; `.flowproof/task-logs/006-project-live-verification/s6-parent-a3/invalid-settings-probe.log`):
after start+finish, an authenticated settings request with invalid settings returned 400 and made the
configuration rejected/null, yet the old capture's Analyze still returned 200 and reached the fake
transport. A valid change also cleared the demonstration and then awaited invalidation/release while
the old configuration and prepared output stayed usable, so a concurrent capture could recreate a service.

Fix (`studio/server.ts`): every branch that rejects or replaces the configuration (settings schema
failure, profile `configure` failure, checked-configuration failure, valid replacement) first runs
`revokeForConfigurationChange` synchronously: configuration null, demonstration removed, service
invalidated (A2 generation) and cancelled, `configurationChanging` set. While it is set, configuration,
prepare and capture requests are `409 CONFIGURATION_CHANGING`; the valid branch also resets the
preparation view before awaiting. Revocation settles before the 400/200 response and always before the
target release. After every awaited demonstration call the route rechecks ownership; a revoked one is
`409 CAPTURE_INVALIDATED`, never a stale success. A malformed closed-schema request (extra key, invalid
JSON) changes nothing and does not revoke. Revocation errors are caught for resource settlement only;
refusal of old routes does not depend on them.

| Step | Tested SHA | Result |
| --- | --- | --- |
| Red-first (5 new route cases) | `5c4ebd9` | 4 failed (rejected-config analyze 200; capture admitted during pending discard; pending start/finish not revoked server-side), malformed case passed as specified |
| Green routes | `73aa5c7` | `project-studio.test.ts` 22 passed |
| Service / `tests/unit/project-lifecycle.test.ts` (lock) | `73aa5c7` | 23 / 15 passed |
| Contract project (lock) | `73aa5c7` | 488 passed, 0 skipped; no unhandled rejection |
| Typecheck + build (lock) | `73aa5c7` | passed |

Zero provider calls; labelled `test_recorder`/`test_transport` only. Marks unchanged (T026/T029 open).
Remaining: A3b launcher `openDemonstration`, A4 real Chromium T026.

## Unit A3b — real launcher demonstration ports (T029 wiring; Chromium acceptance is A4)

Base `56bedc3`. Source `eb00268` (`studio/launch.ts`, `cli.ts`).

`startProjectStudio` now supplies `openDemonstration` per host-minted run:
- `startRecorder`: the launcher-owned Studio `page` (unavailable before it exists), its single direct
  `[data-testid="project-target"]` frame (exactly one iframe, parent = main frame, origin = confirmed
  target origin), the CSS viewport measured on that iframe element in the Studio document (host side,
  not reported by the target) and validated as the S1 viewport with device scale 1, a `CaptureBinding`
  from admitted project + confirmed configuration + ready output digest (`projectCaptureBinding`), then
  the merged S3 `startProjectRecorder` (entry reset to the configured entry path) via
  `demonstrationRecorderOf`.
- `loadSources` (`loadAdmittedProjectSources`): baseline checked before and after; a fresh verified
  admission snapshot; every admitted committed `src/` text file read no-follow and checked against the
  admitted size/SHA-256 and strict UTF-8; snapshot removed; deeply frozen result. Beyond 32 files or
  256 KiB it refuses (`SOURCE_LIMIT_EXCEEDED`), never truncates; no relevance selection is defined.
- `model` (`projectDemonstrationModel`): the S5 session reads only `MODEL_API_KEY` of the explicit
  host `modelEnv`; the CLI passes `modelEnv: { MODEL_API_KEY: process.env.MODEL_API_KEY }` and never a
  fake. `modelFake` (labelled `test_transport`) is a test-only launcher option. No key in JSON, events,
  configuration, runtime mounts or child environment; setup and recording work without a key.

| Step | Tested SHA | Result |
| --- | --- | --- |
| Red-first seam cases | `803d9c9` | 6 failed (`... is not a function`); the 4 binding-refusal cases passed only vacuously (TypeError) before the seams existed |
| Green seams | `eb00268` | `project-demonstration-ports.test.ts` 10 passed |
| Seams + service (lock) | `eb00268` | 33 passed |
| `tests/unit/project-lifecycle.test.ts` (lock) | `eb00268` | 15 passed |
| Contract project incl. routes/CLI setup (lock) | `eb00268` | 13 files, 488 passed |
| Typecheck + build (lock) | `eb00268` | passed |

Sources tests use a real materialized and admitted sample repository (working-tree edit -> refused
`PROJECT_BASELINE_STALE`; 33 committed extra sources -> refused). Not exercised here: the private
`projectTargetFrame` and `startRecorder` path on real Chromium, recorder release ordering on the real
frame, and the route mapping of a source refusal (generic `SOURCES_UNAVAILABLE`); these are A4 (T026).
The viewport is the iframe `clientWidth/clientHeight` (assumes no iframe padding). Marks unchanged.

## S6 unit A4a — launcher-owned recorder journey (T026 partial)

- Tested source: `6f879bf8b1bcb682a9c81eebaf0b0500a2854ea2` (test-only commits cf9e312, fb375c5, 6f879bf); product source unchanged from 218e16c.
- Under `flock -w 1800 /tmp/flowproof-spec006-heavy.lock`: `pnpm typecheck` 0 and `pnpm build` 0 at cf9e312; `tsc --noEmit` 0 at 6f879bf.
- Headed Chromium (DISPLAY=:10.0), retained pinned offline runtime image, real `startProjectStudio`, T001 permitted repository, built Studio:
  - `playwright test tests/e2e/project-recording.spec.ts` at 6f879bf:  1 passed (5.0s) (no retries, no timeout changes).
  - Regression `playwright test tests/e2e/project-setup.spec.ts` at fb375c5 (same product source): 2 passed.
- Proved: cookie-less request refused (4xx); stale configuration 409 CONFIGURATION_STALE; stale output 409 PREPARATION_STALE; browser-supplied `run_id` 400 REQUEST_FIELD_REJECTED; host-minted run/capture UUIDs; real recorder on the admitted frame with click + native select; Finish returns only identity/state/digest; repeat Finish after later target actions keeps the same digest (immutable); Discard returns the run to `demonstration-ready` with no capture/report/digest; Analyze/Finish/Discard after discard 404 CAPTURE_UNKNOWN; labelled `test_transport` provider seam got 0 calls; only the explicit Analyze route was attempted; no request outside the Studio and admitted target origins; original repository snapshot facets unchanged; runtime-label containers and all Docker container IDs unchanged.
- Red runs (test-authoring, no product change): recording-1 expected `report: 'none'` while recording (contract value `'recording'`); recording-2 foreign-origin filter compared hostnames and flagged the admitted target origin. One earlier invocation never ran Playwright (shell construct error) and is not counted.
- Not proved (A4b): safe fill, coalesced scroll, same-origin navigation ordering, foreign/Studio-frame contamination, Finish/Discard/cancel/settings-change races, overflow/unsupported non-completion. T026 and T029 remain open.
- Logs: `.flowproof/task-logs/006-project-live-verification/s6-unit-a4/`.
