---

description: "Task list for Visible Verification of Captured Changes"
---

# Tasks: Visible Verification of Captured Changes

**Input**: Design documents from `/specs/004-verify-captured-changes/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/captured-verification.md](./contracts/captured-verification.md),
[quickstart.md](./quickstart.md)

**Tests**: Required. The Plan's Constitution Check (III) makes byte fidelity, input/result
discrimination, frame identity, cancellation and cleanup test-first. Within each phase, write the
test tasks first and confirm they fail for the missing behavior before the implementation tasks.
Vitest runs with `passWithNoTests: true` (`vitest.config.ts`), so a focused run counts only when
discovery reports a nonzero number of tests for every named file; an empty selection is a missing
gate, never a pass.

**Organization**: Tasks remain grouped by user story, but delivery follows the reviewable PR
checkpoints in [Delivery Slices](#delivery-slices), not the entire feature in one PR. The previous
one-PR grouping was an incorrect application of the local implementation authorization.

**Status**: Owner authorized Tasks and a read-only Analyze on 2026-11-03, and later that day local
implementation covering T001-T042 with `speckit-implement`. Further implementation was then paused
for delivery-boundary correction. The aggregate work and its checkmarks are preserved on
`feat/004-verify-captured-changes` (`7e21b48`); those checkmarks are not carried into this branch.
Push and PR creation are not authorized.

**This branch**: `feat/004-contracts-pinned-git`, created from `main` at `b2ed6ad`. The owner
authorized extraction and local verification of delivery slice 1 only: T003, T005-T009 and
T012-T013, taken from the narrowed local audit snapshot `8602163` (see
[delivery-split-review.md](./delivery-split-review.md#slice-1-branch)). Checkmarks in this file
describe only this branch and are set only with this branch's verification evidence. Every other
task is unimplemented here; this branch does not complete the feature. T003, T005-T009 and
T012-T013 are checked on the evidence recorded in the delivery review. T009 asserts failed
application at the application layer (no applied or buildable target); reducing that outcome to
the `application_complete` check is engine work (T010, T016) in slice 2. The full regression gate
fails on the provider-seam compatibility conflict, which is pending an owner decision, so slice 1
is not review- or merge-ready.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with the other [P] tasks of its group once its listed dependencies
  are complete (different files, no shared incomplete dependency)
- **[Story]**: User story from [spec.md](./spec.md) (US1, US2, US3)
- Paths are repository-relative. "New" marks a planned file; every other path exists at
  `87232db` and is extended, not replaced.

## Path Conventions

Existing monorepo layout from [plan.md](./plan.md): engine in `packages/flowproof/src/`, Studio
client in `apps/studio/src/`, tests in `tests/{unit,contract,integration,ui,e2e}/` with fixtures in
`tests/fixtures/` and helpers in `tests/support/`. Client parser and state tests follow the
existing `ui` Vitest project convention (`tests/ui/state.test.ts`). This adds
`tests/ui/captured-verification.test.ts` to the four Vitest files named in quickstart; T036 syncs
quickstart after implementation.

No new package, dependency, service, port, container, production CLI command, JSON Schema file or
tool installation is needed; the existing prepared Linux/Docker/headed-Chromium environment,
pnpm workspace and Docker editor fixture are reused.

---

## Phase 1: Setup (Shared Fixtures)

**Purpose**: Trusted prepared inputs and test producers shared by every story. No infrastructure
or dependency setup is required.

- [ ] T001 [P] Create the trusted prepared functional check: new `tests/fixtures/captured-verification/filter-cases.json` (synthetic rows including overlapping region names and the trusted expected rows per case) and new `tests/fixtures/captured-verification/check-filter.mjs`, which accepts exactly one argument (the absolute path of the candidate module `apps/demo-chart/src/filterData.ts` in the owned worktree), imports it through Node 24's existing type stripping (no loader, transpiler or package), runs every case, prints one fixed bounded JSON summary of cases discovered/executed/passed, and exits nonzero on any mismatch or when zero cases executed; it performs no network access or filesystem writes and reads no environment variables.
- [ ] T002 [P] Add deterministic, synthetic Canvas candidate cases to `tests/fixtures/editing-agent/agent.mjs`, using ordinary file operations only and leaving existing cases unchanged: `canvas-fix` (multi-file fix: exact region matching in `apps/demo-chart/src/filterData.ts` through a new versioned helper module, plus a new binary file, a new text file and an executable-mode change to an existing tracked non-build file); `canvas-hidden-dependency` (same fix, but its helper is written only under a path ignored by the existing `.gitignore`, such as a `dist/` directory, so capture omits it); `canvas-build-fail` (a change that breaks the registered build); `canvas-plausible-wrong` (passes the trusted functional check but changes rendering so the replayed dataset or chart series deviates from the immutable oracle while a normal-looking chart is still drawn); `canvas-self-certify` (leaves the defect, rewrites the worktree copies of `tests/fixtures/captured-verification/*` and adds a passing `test` script to `apps/demo-chart/package.json`).
- [X] T003 [P] Create new `tests/support/capturedCandidate.ts`: a Docker-free producer of real, complete `CapturingEditingSessionResult` values for synthetic repositories through the existing `captureChanges` (setup pattern of `tests/integration/editing-capture-git.test.ts`, with a completed session and complete cleanup record), for both SHA-1 and SHA-256 object formats; an independent expected-tree reader (`git ls-tree -r -z --full-tree` raw entries of an independently staged expected commit); and an original-repository inventory (object-store file and pack listing, refs, index digest, config, tracked files, `git worktree list --porcelain`).
- [ ] T004 Create new `tests/support/capturedCanvasCandidate.ts`: a Docker-backed producer that runs one T002 case through the existing `startCapturingEditingSession` with `buildFixtureImage`/`fixtureProfile` from `tests/support/editingRuntime.ts` against a given temporary clone and returns the complete capture result and the case's expected versioned effects; no credential, provider, network fetch or live model (depends on T002).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The strict, disjoint captured result family and its reduction, used by all stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 [P] Add contract fixtures new `tests/fixtures/contracts/captured-verification-result.valid-passed.json`, `.valid-failed.json`, `.valid-interrupted-timeout.json`, `.valid-sha256-baseline.json` and invalid fixtures (`.invalid-verified-fix-label.json`, `.invalid-diagnosis-field.json`, `.invalid-missing-check.json`, `.invalid-passed-with-unevaluable.json`, `.invalid-abbreviated-baseline.json`, `.invalid-patch-or-raw-path-field.json`, `.invalid-cleanup-failed-passed.json`) with synthetic values only.
- [X] T006 [P] Write contract tests in new `tests/contract/captured-verification-contract.test.ts` (before T008): every T005 fixture is accepted or rejected as named; the family is discriminated by `kind: captured-verification` with `schema_version` "`1.0.0` of this explicitly discriminated new family, not a silent reinterpretation of the legacy v1 result"; `baseline_commit` accepts full lowercase SHA-1 (40) and SHA-256 (64) object IDs and rejects abbreviated or uppercase IDs; `candidate_patch_sha256` is 64 lowercase hex; unknown fields, Diagnosis/provider/citation/legacy gate arrays, `Verified Fix`, patch bytes, raw paths, argv and host locators are rejected; the unchanged legacy `parseRunResult` from `packages/flowproof/src/contracts/index.ts` rejects every captured fixture and the captured parser rejects `tests/fixtures/contracts/run-result.valid-*.json`.
- [X] T007 [P] Write reducer unit tests in new `tests/unit/captured-verification.test.ts` (before T008): exactly ten checks in the data-model order; `passed` only when all ten pass with required evidence and complete cleanup; failed input/checks give `failed`, operational inability gives `error`, timeout/close give `interrupted`; later unexecuted checks are `unevaluable`, never omitted or passed; a zero-check or partially reported result cannot pass; cleanup or integrity failure overrides otherwise-passing checks.
- [X] T008 Implement new `packages/flowproof/src/verify/capturedContracts.ts`: the ten check IDs in order (`input_valid`, `baseline_reproduced`, `application_complete`, `build_passed`, `tests_passed`, `dataset_matches`, `canvas_matches`, `secret_scan_clean`, `cleanup_complete`, `original_unchanged`); the strict Zod schema and parser with `run_id`, `request_id`, `scenario_id`, `editing_session_id`, `baseline_commit`, `candidate_patch_sha256`, inherited `coverage`, `status`: "`passed | failed | error | interrupted`", `reason_code` and fixed bounded `message` for non-passing outcomes ("timeout is `interrupted` with `RUN_TIMEOUT`, user close is `interrupted` with `RUN_INTERRUPTED`"), checks with "existing `pass | fail | unevaluable` status, safe reason/message and relevant same-run evidence references", before/after evidence references only when produced, `cleanup` completion/original-integrity facts with safe owned-resource failure categories, and timestamps/durations without model duration; a closed fixed reason-code set; and the reducer enforcing "A passing result requires all ten checks to pass, with required evidence and complete cleanup." Legacy `packages/flowproof/src/contracts/schemas.ts` and `packages/flowproof/src/verify/gates.ts` stay unchanged (depends on T005-T007).

**Checkpoint (Foundation ready)**: T006/T007 pass with nonzero discovered tests, and the unchanged
`tests/contract/run-result-contract.test.ts` and `tests/unit/gate-reducer.test.ts` still pass.

---

## Phase 3: User Story 1 - Verify the Captured Changes Alone (Priority: P1) 🎯 MVP

**Goal**: Apply one complete captured candidate with exact bytes to a fresh worktree at its recorded
baseline, run the trusted prepared build, functional check and replay oracles, and produce an
honest strict result labelled Candidate verification passed only when every mandatory check passes.
Browser reproduction and replay enter through engine ports here; US2 wires them to the real Studio frame.

**Independent Test**: With synthetic and prepared Canvas candidates and no live model or retained
editing workspace, run quickstart section 2. Every expected versioned effect matches an
independently staged tree; the hidden-edit dependency, application-failure, failed-check and
self-certifying candidates never pass; the original repository and object store are unchanged.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before T012-T016.

- [X] T009 [P] [US1] Write application-fidelity integration tests in new `tests/integration/captured-verification-git.test.ts` using T003: the candidate applies at its recorded baseline after the original HEAD has advanced (baseline != HEAD), with original HEAD recorded separately; added/modified/deleted text, empty and binary files, raw non-UTF-8 path bytes, `100644`/`100755` modes, symlink text and a gitlink OID match the independent expected tree by raw path bytes, mode and object ID; the gitlink is reference-only (nested worktree neither populated, read nor fetched) with the Spec 003 coverage note; the same holds for a SHA-256 repository; tampered patch bytes, tampered file summary, missing baseline object and a wrong baseline fail `application_complete` with no partially applied target; the patch applies at most once and never through `--unsafe-paths`, `--reject`, 3-way merge, whitespace repair, hooks or filters; the original index, refs, config, tracked files and object store contain no candidate object or other change, and the owned worktree registration and private Git state are gone after disposal.
- [ ] T010 [P] [US1] Write admission, orchestration and scan unit tests in `tests/unit/captured-verification.test.ts` with fake ports (after T007, same file): only a completed editor with `captured` status and complete upstream cleanup/integrity is admitted; `no_changes`, `rejected`, `failed`, `not_attempted`, editor failure and upstream cleanup failure return a fixed bounded start error without a run or artifact; mutating the caller's Buffers or arrays after admission changes neither the digest nor the applied bytes; `candidate_patch_sha256` covers the exact owned bytes; the baseline ID format must match the repository object format; the editing session ID and the server-assigned run/request IDs stay distinct; stage order is baseline reproduction, application, build, functional check, replay, scan, cleanup, integrity; the first failing mandatory check stops execution and marks later checks unevaluable; `baseline_reproduced` passes only when actual baseline observations show the prepared defect and the failure evidence bundle is complete, and missing replay evidence fails `dataset_matches`/`canvas_matches`; check commands, checker path and expected values come only from host code and trusted original inputs; `tests/unit/demo-chart.test.ts` is never run as the candidate check; a seeded marker in raw candidate bytes, evidence, events or the final result fails `secret_scan_clean` without reporting its value; no patch bytes or raw paths reach any persisted artifact.
- [ ] T011 [US1] Extend `tests/integration/captured-verification-git.test.ts` with prepared Canvas check tests using T004 in a temporary clone (after T009, same file): `canvas-fix` reproduces every expected versioned effect, the registered build produces servable output, and `tests/fixtures/captured-verification/check-filter.mjs`, loaded from the original checkout before application, passes against the owned candidate module; the same checker fails for the unchanged baseline module; `canvas-hidden-dependency` fails `build_passed` or `tests_passed` and nothing is copied from the disposed editing workspace; `canvas-build-fail` fails `build_passed`; `canvas-self-certify` still fails `tests_passed` because the changed worktree copies and package script are ignored; a candidate that changes `pnpm-lock.yaml` or dependency manifests triggers no installation or network access, and a missing prepared dependency is an explicit failure.

### Implementation for User Story 1

- [X] T012 [P] [US1] Implement new `packages/flowproof/src/worktree/capturedCandidate.ts`: an owned private bare Git directory, index and object store outside the candidate content, with the original object directory as a read-only alternate; seed the private index with `read-tree` of the pinned baseline and refresh its stat information before `git apply --check --index --binary -`, then apply the exact Buffer once with `--index --binary`; run Git through `runCaptureGit`, `captureGitEnvironment`, `CAPTURE_GIT_SAFETY` and `createCaptureBudget` from `packages/flowproof/src/editing/captureGit.ts` (not its workspace extraction); never use UTF-8 conversion or `packages/flowproof/src/patch/validateDiff.ts`; compare the raw NUL-delimited private-index result with the candidate's file summary (path bytes, operation, modes, object IDs); return a safe pass/fail fact and expose idempotent disposal of the private state (depends on T009).
- [X] T013 [US1] Add a sibling pinned-baseline entry point to `packages/flowproof/src/worktree/session.ts` that verifies the recorded full commit in the original object store (not original HEAD or a branch), creates the owned detached worktree at it, reuses the existing clean-tracked-checkout preflight, snapshot, dependency linking, build and disposal ownership, delegates candidate application to T012, and records original HEAD independently; legacy `createWorktreeSession` and its 20-KB one-file `applyDiff()` contract stay unchanged (depends on T012).
- [ ] T014 [P] [US1] Implement candidate admission in new `packages/flowproof/src/verify/capturedRun.ts`: validate with `validateCapturingSessionResult` from `packages/flowproof/src/editing/capture.ts`, require the admitted composition from T010, deep-copy the candidate into a frozen snapshot, hash the owned patch bytes with SHA-256, check the baseline ID against the repository object format, and map every rejection to a fixed bounded launch error without creating a run (depends on T008, T010).
- [ ] T015 [US1] Add the fixed prepared check selection to `packages/flowproof/src/verify/capturedRun.ts`: the registered scenario build and the T001 checker read from the original checkout before application; run the checker with `process.execPath` in its own process group with the build's environment allowlist and bounded output, pass only the owned candidate module path, parse its fixed summary, and fail `tests_passed` when it exits nonzero, reports a mismatch, or executes zero cases (depends on T011, T014).
- [ ] T016 [US1] Implement `executeCapturedRun` in `packages/flowproof/src/verify/capturedRun.ts` with injectable ports (baseline reproduction, application, build, functional check, replay, capture disposal, worktree disposal): run the T010 stage order and record supported-phase events through an injected existing `RunEventStream` from `packages/flowproof/src/studio/events.ts`; evaluate baseline reproduction and replay dataset/chart checks with the oracle functions of `packages/flowproof/src/verify/oracle.ts` (not through the legacy `run.ts` reducer); scan raw candidate surfaces, persisted evidence, events and the final result with `createSecretScanner` from `packages/flowproof/src/evidence/secretScan.ts`; always run cleanup and integrity steps; reduce with T008; persist the strict result as the existing `result` artifact through the unchanged `RunArtifactStore` in `packages/flowproof/src/evidence/store.ts`, without a candidate-diff artifact, new artifact name, patch bytes or raw paths (depends on T008, T013, T015).

**Checkpoint (US1)**: quickstart section 2 passes with nonzero discovered tests for its three files.

---

## Phase 4: User Story 2 - Watch the Actual Browser Verification (Priority: P1)

**Goal**: The host-selected captured mode runs inside the existing Studio: the user watches the real
baseline reproduction and candidate replay in the same observed iframe, with truthful stages,
covered user input and the strict captured result.

**Independent Test**: Run quickstart section 3 with the `canvas-fix`, `canvas-plausible-wrong` and
`canvas-build-fail` candidates. The frame that supplies observations is the displayed frame; phase
labels and check summaries are truthful; failures show their reasons; a missing frame fails rather
than triggering a hidden fallback.

### Tests for User Story 2 ⚠️

> Write T018-T020 first and confirm they fail before T021-T027. T019 and T020 use the T017 harness;
> T018 does not.

- [ ] T017 [P] [US2] Extend `tests/support/studioHarness.ts` with a captured-mode harness that launches `startCapturedVerificationStudio` (through `tests/support/pendingModule.ts`) for a temporary clone and a supplied capture result, with the existing private TMPDIR, unset `MODEL_API_KEY`, loopback-only request guard and cleanup report; the legacy harness is unchanged.
- [ ] T018 [P] [US2] Write client contract and state tests in new `tests/ui/captured-verification.test.ts`: the client captured-result parser accepts and rejects exactly the T005 fixtures the server parser does, the unchanged client `parseRunResult` rejects the captured family, and result reads are bound to the started run; catalog entries parse the captured execution-kind discriminator while legacy entries keep their exact shape; in captured mode the reducer creates no Meta chat and no nine pending legacy gates; target presentation is derived only from actual events as baseline live, preparation (not live), candidate live or completed captured evidence; ten check rows come only from the strict result; `Candidate verification passed` appears only for `passed`, never `Verified Fix`.
- [ ] T019 [P] [US2] Write server and launch integration tests in new `tests/integration/captured-verification-studio.test.ts` (pattern of `tests/integration/studio-api.test.ts`): existing host/origin/cookie/CSP guards apply unchanged; the captured catalog lists only the prepared scenario with the discriminator; a `POST /api/runs` body carrying a patch, filesystem root, command, provider or mode override is rejected without side effects; captured mode requires no model key or transport while legacy readiness is unchanged; the start response carries server-generated IDs; events use only existing types and the phases `initialized`, `reproducing`, `failure_captured`, `applying`, `replaying`, `finalized` with bounded messages, and no `diagnosing`, model or `gate_updated` event; the result route returns the strict captured family bound to its run; the candidate-diff route and any raw-path or patch read return the existing not-found; one run per launch; invalid launch input (T003 non-captured outcomes, unknown scenario) fails with a fixed error before any browser, server or artifact exists (depends on T003, T017).
- [ ] T020 [P] [US2] Write headed end-to-end tests in new `tests/e2e/captured-verification.spec.ts` using T004 and T017: for `canvas-fix`, the same Studio iframe element and Playwright frame show the baseline build and then the candidate build (served stage verified through `TargetApp`), the prepared select action is visible in both phases, and the observations used for the result come from that frame; during application/build/check the pane is labelled as preparation, not live; during measured phases a transparent cover blocks a pointer click on the target, focus stays outside the iframe and the iframe is not tabbable, while the prepared programmatic select still changes the real iframe; `canvas-plausible-wrong` and `canvas-build-fail` finalize as failed with visible reasons; a target load failure (pattern of `tests/e2e/target-load-failure.spec.ts`) never yields a hidden successful replay; closing the browser mid-run (pattern of `tests/e2e/browser-close.spec.ts`) finalizes `interrupted`; save success and failure screenshots as test evidence (depends on T004, T017).

### Implementation for User Story 2

- [ ] T021 [US2] Add the host-configured captured mode to `packages/flowproof/src/studio/server.ts`: an in-process option only `startCapturedVerificationStudio` can set; the catalog exposes only the prepared scenario with an additive execution-kind discriminator; the existing start-body parser and guards are reused, and the host-fixed starter is selected without model readiness or transport; `StudioRunHandle.result()` returns the explicit union of the unchanged `RunResult` and the captured family; existing closed evidence routes serve captured runs and the candidate-diff route returns not-found for them; legacy server behavior is unchanged (depends on T008, T019).
- [ ] T022 [US2] Implement `startCapturedVerificationStudio()` in `packages/flowproof/src/studio/launch.ts` per contract section 1: accept the original repository root, the completed capture result and the prepared scenario ID `canvas-filter-hero`, admit and snapshot the candidate (T014) before asynchronous work, start the same target app, Studio build, guarded server and headed browser as `startStudio()`, and return the existing origin/session/page/close handle shape; wire `executeCapturedRun` ports to `TargetApp.serveBuild('known-bad')`/`reconnect` and `BrowserCapture.capturePhase('failure')` on the actual Studio frame, then the pinned worktree's application/build/check, then `serveBuild('patched')`/`reconnect` of the same frame and `capturePhase('replay')`; emit only the T019 phases and bounded real activity messages; abort the run on the existing close path; legacy `startStudio()` options and credential behavior are unchanged (depends on T016, T020, T021).
- [ ] T023 [P] [US2] Extend `apps/studio/src/api.ts` with the strict client captured-result parser, the explicit `ResultRead` union with run binding, and the catalog execution-kind discriminator, keeping legacy `parseRunResult` and legacy payload parsing unchanged (depends on T018).
- [ ] T024 [US2] Extend `apps/studio/src/state.ts` with the captured run view: mode from the catalog, check rows from the strict result, target presentation states (baseline live, preparation, candidate live) from actual events, and no legacy gate placeholders or Meta chat state in captured mode (depends on T023).
- [ ] T025 [US2] Create new `apps/studio/src/components/CapturedVerification.tsx` in the existing right-hand surface: current stage and bounded activity, the ten check rows with pass/fail/unevaluable and safe reasons, final status (`Candidate verification passed` or the non-passing status and reason), short candidate digest and baseline, the coverage note when present, and the statement that no model diagnosis or citations were evaluated (depends on T024).
- [ ] T026 [US2] Update `apps/studio/src/components/TargetPane.tsx`, `apps/studio/src/App.tsx` and `apps/studio/src/styles.css`: keep the one memoized iframe mounted with the same identity during live phases, add the phase label, and during measured phases add a transparent input cover, move focus to the outer Studio and set the iframe out of the tab order; no new iframe, URL, port or navigation (depends on T020, T024).
- [ ] T027 [US2] Update `apps/studio/src/components/AgentPanel.tsx` and `apps/studio/src/components/ProofTrail.tsx` for captured mode: a candidate-verification start action instead of the Meta chat and nine legacy gates, and no diagnosis, provider or candidate-diff sections; legacy rendering is unchanged (depends on T025).

**Checkpoint (US2)**: quickstart section 3 plus `tests/ui/captured-verification.test.ts` pass
with nonzero discovered tests.

---

## Phase 5: User Story 3 - Receive an Honest Result and Finish Cleanly (Priority: P2)

**Goal**: Every terminal path yields an honest, identity-bound result; owned resources are released
and original integrity is checked on every exit; after disposal Studio shows labelled static
evidence in the retained result shell until the user closes it.

**Independent Test**: Exercise success, application failure, check failure, execution error,
timeout, cancellation and injected cleanup/integrity failure. Check result identity and reasons,
evaluated and skipped checks, original integrity, owned resources, and what Studio shows after the
live target is gone.

### Tests for User Story 3 ⚠️

> Write these first and confirm they fail before T031-T034.

- [ ] T028 [P] [US3] Add terminal-path unit tests to `tests/unit/captured-verification.test.ts` with fake ports and a fake monotonic clock: application failure and failed checks give `failed`; spawn, Git or capture inability gives `error`; exceeding the shared apply/build/test/replay window or the total window gives `interrupted`/`RUN_TIMEOUT` even when timers do not fire; an abort gives `interrupted`/`RUN_INTERRUPTED`; later checks are `unevaluable`; every cleanup step runs exactly once on every path, including after an earlier cleanup-step failure; injected cleanup or integrity failure never yields `passed`; the secret scan runs on every terminal path; result identity equals the admitted snapshot and run; reasons contain no host path, command output or scanner value.
- [ ] T029 [P] [US3] Add real resource-ownership integration tests to `tests/integration/captured-verification-git.test.ts`: aborting during build and during the functional check kills each whole process group and joins it before the worktree is removed; no process, temporary entry, worktree registration or private Git directory remains on any terminal path; an injected worktree-removal failure fails `cleanup_complete` and an original tracked-file change during the run fails `original_unchanged`, both with safe categories.
- [ ] T030 [P] [US3] Extend `tests/e2e/captured-verification.spec.ts` with finalization tests: after a run finalizes, the target app no longer serves or listens, the live iframe is replaced by captured before/after evidence labelled as captured, not live, and the result shell and closed evidence routes stay readable until the user closes Studio; closing then releases every owned resource (empty harness cleanup report, unchanged original snapshot); closing mid-run finalizes `interrupted` locally and still releases everything.

### Implementation for User Story 3

- [ ] T031 [US3] Harden `packages/flowproof/src/verify/capturedRun.ts`: one shared monotonic deadline (`performance.now()`) for the application/build/test/replay window and the scenario total, alongside abort timers; propagate the run signal into Git, build, check and capture operations; join stopped operations before disposal; attempt every cleanup step despite earlier failures; map outcomes to `failed`, `error` and `interrupted` with fixed reasons (depends on T028).
- [ ] T032 [P] [US3] Make captured disposal idempotent and fully reported in `packages/flowproof/src/worktree/session.ts` and `packages/flowproof/src/worktree/capturedCandidate.ts`: remove the owned worktree registration and private Git state, compare the original snapshot, and return safe owned-resource failure categories without global pruning (depends on T029).
- [ ] T033 [US3] Implement captured finalization in `packages/flowproof/src/studio/launch.ts`: capture final evidence, then stop target serving and detach the frame, join owned operations, dispose the worktree and private Git state, compare original integrity, run the whole-run scan and publish the result; afterwards keep only the guarded result shell, evidence server and its browser until the user closes Studio; a close during the run aborts, finalizes locally and then releases everything (depends on T030-T032).
- [ ] T034 [US3] Add the completed-evidence presentation to `apps/studio/src/state.ts`, `apps/studio/src/components/TargetPane.tsx`, `apps/studio/src/components/CapturedVerification.tsx` and `apps/studio/src/components/ProofTrail.tsx`: after finalization show the captured before/after evidence labelled as captured, not live, with evaluated and unevaluated checks and cleanup/integrity facts from the strict result (depends on T030, T033).

**Checkpoint (US3)**: quickstart sections 2 and 3 pass again with nonzero discovered tests,
including the T028-T030 terminal-path cases.

---

## Phase 6: Polish & Cross-Cutting Concerns (Slice Final Gate)

**Purpose**: Manual QA launcher, documentation sync, discovery, compatibility and the final gate.

- [ ] T035 [P] Create new `tests/manual/captured-verification.mjs`, the QA launcher (not a production CLI): accepts only `--case pass`, requires a prior `pnpm build`, imports only built `packages/flowproof/dist/` modules, builds the editor fixture image with the same fixed arguments as `tests/support/editingRuntime.ts`, produces the `canvas-fix` capture against a temporary clone through the deterministic editor/capture path, calls `startCapturedVerificationStudio`, waits for the user to close Studio, prints the cleanup summary (temporary leftovers, processes, target port, original snapshot), and removes its own image tag and temporary clone; no key, login or network fetch (depends on T034).
- [ ] T036 [P] Sync `specs/004-verify-captured-changes/quickstart.md` with the delivered files: add `tests/ui/captured-verification.test.ts` to the discovery and focused commands, add `pnpm exec playwright test --list tests/e2e/captured-verification.spec.ts`, and record the T035 launcher interface and its `pnpm build` prerequisite; no requirement or scope change.
- [ ] T037 Confirm discovery: `pnpm exec vitest list tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts tests/integration/captured-verification-studio.test.ts tests/ui/captured-verification.test.ts` and `pnpm exec playwright test --list tests/e2e/captured-verification.spec.ts` report nonzero tests for every file; record the counts.
- [ ] T038 Audit scope and compatibility in the slice diff: no change to `package.json`, `pnpm-lock.yaml` or `packages/flowproof/src/cli.ts`; no change in meaning to `packages/flowproof/src/run.ts`, the legacy schemas in `packages/flowproof/src/contracts/schemas.ts` or `packages/flowproof/src/verify/gates.ts` (at most a pure export of an existing helper); no new route, port, service, container, provider call, cancel endpoint, export or upload path; no `--unsafe-paths`, `--reject` or `--3way` in `packages/flowproof/src/worktree/capturedCandidate.ts`; existing test files changed only additively (`tests/fixtures/editing-agent/agent.mjs`, `tests/support/studioHarness.ts`).
- [ ] T039 Run the unchanged legacy acceptance suites: `pnpm exec vitest run tests/contract/run-result-contract.test.ts tests/contract/editing-capture-contract.test.ts tests/contract/editing-session-contract.test.ts tests/unit/gate-reducer.test.ts tests/integration/editing-session.test.ts tests/integration/editing-capture-session.test.ts tests/integration/editing-capture-git.test.ts tests/integration/studio-api.test.ts tests/ui/state.test.ts tests/ui/proof-trail.test.ts --no-file-parallelism --maxWorkers=1` and `pnpm exec playwright test tests/e2e/hero.spec.ts tests/e2e/failure.spec.ts tests/e2e/browser-close.spec.ts tests/e2e/target-load-failure.spec.ts tests/e2e/secret-safety.spec.ts`.
- [ ] T040 Run the slice final gate: `pnpm typecheck`, `pnpm build`, `pnpm test --no-file-parallelism --maxWorkers=1`, `pnpm exec playwright test --pass-with-no-tests` and `git diff --check`; record discovered/passed/skipped counts per project and any unrun gate; no live provider, credential or global resource pruning.
- [ ] T041 Owner visual smoke (human-only, about 2-3 minutes, after T040): after `pnpm build`, run `node tests/manual/captured-verification.mjs --case pass`; confirm the real original failure and candidate select replay are visible, the final result and checks match, and the final pane is labelled captured evidence rather than a navigable live app; close Studio and check the printed cleanup summary. Negative cases stay automated.
- [ ] T042 Mark only evidence-backed tasks complete in `specs/004-verify-captured-changes/tasks.md` and record the current delivery slice report for the owner: its exact task scope, T037/T039/T040 counts and exit results, the T041 outcome or its explicit absence, and remaining gaps (execution trust and issue #15 boundaries from [plan.md](./plan.md)); stop without push or PR, which require owner authorization.

---

## Delivery Slices

The owner recalled the existing repository rule: reviewable phase/checkpoint slices, normally one
PR each; implement only the current slice, validate, report and stop. Small commits do not replace
PR boundaries. The previous T001-T042 one-PR ledger is superseded. This is a delivery correction,
not a change to product behavior. See [delivery-split-review.md](./delivery-split-review.md) for
measured local extraction evidence and the outstanding compatibility gate.

| Order | Named delivery checkpoint | Exact task scope | Validation |
| --- | --- | --- | --- |
| 1 | Strict result and faithful pinned Git application | T003, T005-T009, T012-T013 | Contract/reducer/application tests and legacy `worktree.test.ts`; typecheck; build; applicable compatibility gate |
| 2 | Verification engine and owned-resource lifecycle | T001-T002, T004, T010-T011, T014-T016, T028-T029, T031-T032 | Captured contract/unit/Git suites, including real terminal paths; typecheck; build |
| 3 | Studio server/client contract and state | T018, T019 server portion, T021, T023-T024, T034 selectors | Server-only integration, captured UI/state, legacy API/state/Proof Trail/worktree; typecheck; build |
| 4 | Visible runtime and completed captured evidence | T017, T019 launch portion, T020, T022, T025-T027, T030, T033, T034 presentation, T035-T042 | Launch/UI tests, captured and legacy headed cases, discovery/full final gate, explicit human-only smoke status |

**Validation commands** (run from each slice's actual checkout, not the aggregate branch):

- Every slice: `pnpm typecheck`, `pnpm build`, `git diff --check`, and the applicable full regression/compatibility gate `pnpm test --no-file-parallelism --maxWorkers=1`. Focused audit success does not replace this gate.
- Slice 1 focused: `pnpm exec vitest run tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts tests/integration/worktree.test.ts --no-file-parallelism --maxWorkers=1` (only the slice's reducer/application test portions exist here).
- Slice 2 focused: `pnpm exec vitest run tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts --no-file-parallelism --maxWorkers=1`.
- Slice 3 focused: `pnpm exec vitest run tests/integration/captured-verification-studio.test.ts tests/ui/captured-verification.test.ts tests/ui/state.test.ts tests/ui/proof-trail.test.ts tests/integration/studio-api.test.ts tests/integration/worktree.test.ts --no-file-parallelism --maxWorkers=1` (server-only integration portion).
- Slice 4 focused: `pnpm exec vitest run tests/integration/captured-verification-studio.test.ts tests/ui/captured-verification.test.ts tests/ui/state.test.ts tests/ui/proof-trail.test.ts --no-file-parallelism --maxWorkers=1`; headed: `xvfb-run -a pnpm exec playwright test tests/e2e/captured-verification.spec.ts tests/e2e/hero.spec.ts tests/e2e/failure.spec.ts tests/e2e/browser-close.spec.ts tests/e2e/target-load-failure.spec.ts tests/e2e/secret-safety.spec.ts`. T037-T041 retain the remaining discovery/full-suite/manual gates.

T019 server portion is the host-fixed server configuration/start/result/evidence tests; its launch
portion is pre-side-effect launcher admission. T034 selectors are strict completed-evidence,
cleanup and check-summary derivation; presentation is their component/launcher integration.
These parts must retain their assertions with the implementation they prove. Process-joining
implementation and its `operationsJoined` assertions belong together in slice 2, not slice 1.
T037-T040 also supply the applicable per-slice discovery/scope/compatibility/check obligations;
T041 remains only the final visible slice's human check. Existing task IDs and aggregate history
are preserved; a checked parent task is not a statement that either PR part is review-ready.

The local audit snapshots are dependency/validation evidence, not published or owner-approved
PR branches. Do not blindly cherry-pick the interleaved aggregate commits. Preserve the original
branch; prepare only the first reviewable slice. Do not implement T035-T042 or start a later
slice now. Report and stop at the current slice boundary. After its PR is separately authorized,
reviewed and merged, update main and create the next authorized slice branch from it, as required
by CONTRIBUTING.md. No push, PR, bot review, merge or deployment is authorized here.

---

## Requirement Coverage

| Requirement | Tasks |
| --- | --- |
| FR-001 Candidate/baseline association, fresh baseline worktree | T003, T009, T010, T013, T014, T019, T022 |
| FR-002 Git-representable fidelity, no partial application | T003, T009, T011, T012, T013 |
| FR-003 Trusted build/check/replay, distinct label, all mandatory checks | T001, T002, T006, T007, T008, T010, T011, T015, T016, T018, T025 |
| FR-004 Actual displayed target is the observed target | T020, T022, T026 |
| FR-005 Truthful progress in the existing Studio | T018, T019, T020, T024, T025, T026, T027 |
| FR-006 Outcome distinctions; missing evidence prevents success | T006, T007, T008, T010, T028, T031 |
| FR-007 Automation-owned input, close path, no unseen fallback | T020, T022, T026, T030, T033 |
| FR-008 Cleanup and integrity on all terminal paths | T016, T028, T029, T030, T031, T032, T033 |
| FR-009 Executed identity, static evidence, no retention/export | T008, T016, T030, T033, T034, T038 |
| FR-010 Legacy compatibility, no provider/repair/publication | T006, T019, T021, T022, T038, T039 |
| SC-001 Multi-file fix reproduced from saved changes alone | T003, T004, T009, T011, T012 |
| SC-002 Visible original defect and candidate replay agree with checks | T020, T022, T041 |
| SC-003 Zero false verifications for negative fixtures | T002, T010, T011, T020, T028 |
| SC-004 Same run/candidate frame, no lookalike or recording | T019, T020, T022 |
| SC-005 Cleanup/integrity checked on every terminal path | T028, T029, T030, T032 |
| SC-006 Live, failure, interruption and static evidence distinguishable | T018, T020, T030, T034, T041 |
| SC-007 Legacy suites unchanged, no live model account | T037, T039, T040 |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T004 depends on T002.
- **Foundational (Phase 2)**: T008 depends on T005-T007; blocks all stories.
- **US1 (Phase 3)**: depends on Phases 1-2.
- **US2 (Phase 4)**: depends on US1; T022 drives the US1 engine through the Studio frame.
- **US3 (Phase 5)**: depends on US1 and US2; it hardens their terminal paths and finalizes the Studio view.
- **Polish (Phase 6)**: depends on US1-US3; T041 follows T040, and T042 is last.

The stories are sequential increments of one capability, each with its own acceptance test at its
checkpoint. The delivery checkpoints above expose independently verifiable internal increments; the complete
visible feature is accepted only after the final slice.

### Task Graph

```text
Setup         T001    T002 -> T004    T003
Foundational  T005, T006, T007 -> T008
US1           T009 -> T011 -> T015
              T009 -> T012 -> T013 --------+
              T010 -> T014 -> T015 --------+-> T016   (T014, T016 also need T008)
US2           T017 -> T019, T020           T018 (no harness)
              T019 -> T021 -> T022         (T022 also needs T016, T020)
              T018 -> T023 -> T024 -> T025 -> T027
                               T024 -> T026 (also needs T020)
US3           T028 -> T031 --+
              T029 -> T032 --+-> T033 -> T034
              T030 ----------+
Polish        T034 -> T035, T036 -> T037 -> T038 -> T039 -> T040 -> T041 -> T042
              (T041 also needs T035)
```

### Within Each User Story

- Tests are written first and fail before the corresponding implementation.
- Contracts before engine, engine before Studio wiring, server before client rendering.
- Same-file tasks run in ID order: `tests/unit/captured-verification.test.ts` (T007, T010, T028),
  `tests/integration/captured-verification-git.test.ts` (T009, T011, T029),
  `tests/e2e/captured-verification.spec.ts` (T020, T030), `packages/flowproof/src/verify/capturedRun.ts`
  (T014-T016, T031), `packages/flowproof/src/studio/launch.ts` (T022, T033).

### Parallel Opportunities

- Setup: T001, T002, T003 write different new or fixture files; T004 (not [P]) waits for T002.
- Foundational: T005, T006, T007 write fixtures and two separate test files.
- US1: T009 with T010 (different test files); T012 with T014 (different modules whose inputs,
  T009 and T008/T010, are complete).
- US2: T017 with T018; T019 with T020 after T017; T023 with T021 (client and server packages).
- US3: T028, T029, T030 (three test files); T032 with T031 (worktree modules versus `capturedRun.ts`).
- Polish: T035 with T036 (launcher versus documentation).

Same-file tasks are never marked [P] against each other.

---

## Parallel Example: User Story 1

```bash
# Tests in different files:
Task: "T009 Application-fidelity tests in tests/integration/captured-verification-git.test.ts"
Task: "T010 Admission/orchestration/scan tests in tests/unit/captured-verification.test.ts"

# Independent modules once their tests fail:
Task: "T012 Private-index application in packages/flowproof/src/worktree/capturedCandidate.ts"
Task: "T014 Candidate admission in packages/flowproof/src/verify/capturedRun.ts"
```

## Parallel Example: User Story 2

```bash
# Harness and client tests have no shared file or dependency:
Task: "T017 Captured-mode harness in tests/support/studioHarness.ts"
Task: "T018 Client parser/state tests in tests/ui/captured-verification.test.ts"

# After T017:
Task: "T019 Server/launch tests in tests/integration/captured-verification-studio.test.ts"
Task: "T020 Headed visibility tests in tests/e2e/captured-verification.spec.ts"

# Server and client parsing touch different packages:
Task: "T021 Captured mode in packages/flowproof/src/studio/server.ts"
Task: "T023 Client result union in apps/studio/src/api.ts"
```

## Parallel Example: User Story 3

```bash
Task: "T028 Terminal-path unit tests in tests/unit/captured-verification.test.ts"
Task: "T029 Resource-ownership tests in tests/integration/captured-verification-git.test.ts"
Task: "T030 Finalization e2e tests in tests/e2e/captured-verification.spec.ts"
```

---

## Implementation Strategy

### MVP Checkpoint Inside the Slice

1. Complete Phases 1-2, then US1 (T001-T016).
2. Stop at the US1 checkpoint and run its focused validation: exact application, the trusted build
   and functional check, and strict result reduction work without the Studio (browser stages through
   test ports). This is a verification point, not a release or a separate pull request.

### Incremental Completion

1. US2 (T017-T027) makes the same engine run visible in the existing Studio.
2. US3 (T028-T034) hardens every terminal path and finalizes the Studio view.
3. Phase 6 (T035-T042) runs discovery, compatibility and the final gate, then the short owner smoke.
4. Report and stop; push and PR creation need separate owner authorization.

---

## Notes

- Every task remains unchecked until implemented and verified; mark a task complete only with
  supporting evidence, and keep automated checks separate from the human-only T041.
- Prerequisites for test execution: the existing Docker engine for the editor fixture and the
  existing Docker-backed editing suites (T004, T011, T020, T030, T035, T039-T041) and a headed
  display or Xvfb for Playwright (T020, T030, T039-T041).
- No task adds model/provider integration, retries, a generic project runner or browser action
  family, automatic package installation, export/reconnect, a post-run interactive target, the
  issue #15 observation redesign, or a new container or service.
