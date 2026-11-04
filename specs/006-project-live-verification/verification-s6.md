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
