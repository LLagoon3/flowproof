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
