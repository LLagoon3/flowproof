---

description: "Implementation tasks for the evidence-grounded fix verification MVP"
---

# Tasks: Evidence-Grounded Fix Verification

**Input**: Design documents from `/specs/001-verify-debugging-fix/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, and
`quickstart.md`

**Tests**: Required. The Plan mandates test-first work for contracts, sanitization, Evidence IDs,
patch guards, gate reduction, preconditions, run transitions, lifecycle finalization, and Git
integrity. Each user story also has integration and end-to-end coverage.

**Organization**: Phases follow Spec Kit order. User Story 1 uses two internal slices. Slice 3A is
the first closed-loop walking skeleton and must reach recorded diagnosis, safe apply, rebuild,
visible replay, oracle evaluation, and a contract-valid result. Slice 3B adds the production Meta
adapter and full Proof Trail. Neither internal slice changes the Spec's completion criteria.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it changes different files and has no incomplete dependency.
- **[Story]**: `US1` or `US2`; labels appear only in user-story phases.
- Every task names the exact file or files it changes or validates.

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Create the pnpm workspace root with `flowproof`, `typecheck`, `build`, `test`, `test:contract`, `test:integration`, `test:e2e`, and `test:meta-smoke` scripts, `MODEL_API_KEY` documentation, and ignore rules for `.flowproof/`, generated output, and local secrets in `package.json`, `pnpm-workspace.yaml`, `.env.example`, and `.gitignore`
- [X] T002 Pin the Plan-approved dependencies and configure the engine to compile with `tsc` into `packages/flowproof/dist/` and execute `node --env-file-if-exists=.env packages/flowproof/dist/cli.js` in `tsconfig.base.json`, `packages/flowproof/package.json`, and `packages/flowproof/tsconfig.json`
- [X] T003 [P] Configure the CSP-compatible React Studio build with no inline scripts or styles in `apps/studio/index.html`, `apps/studio/package.json`, `apps/studio/vite.config.ts`, `apps/studio/tsconfig.json`, and `apps/studio/src/main.tsx`
- [X] T004 [P] Configure the static trusted demo build in `apps/demo-chart/index.html`, `apps/demo-chart/package.json`, `apps/demo-chart/vite.config.ts`, and `apps/demo-chart/tsconfig.json`
- [X] T005 [P] Configure Vitest projects and the pinned headed-Chromium Playwright project, excluding `meta-smoke` from default test discovery and avoiding an auto-launched browser fixture, in `vitest.config.ts` and `playwright.config.ts`
- [X] T006 Install the pinned dependency graph, run `pnpm exec playwright install chromium`, and commit the reproducible lockfile in `pnpm-lock.yaml`

**Checkpoint 1**: `pnpm install --frozen-lockfile`, `pnpm typecheck`, and empty test discovery run
from the repository root.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Critical**: No user-story implementation starts until Checkpoint 2 passes.

### Failing tests first

- [X] T007 [P] Write failing contract tests with valid and invalid fixtures for Scenario, Evidence Bundle, Diagnosis, Studio Event, and Run Result per `contracts/*.schema.json` in `tests/contract/scenario-contract.test.ts`, `tests/contract/evidence-bundle-contract.test.ts`, `tests/contract/diagnosis-contract.test.ts`, `tests/contract/studio-event-contract.test.ts`, `tests/contract/run-result-contract.test.ts`, and `tests/fixtures/contracts/`
- [X] T008 [P] Write failing sanitizer and seeded-marker scan tests for credentials, authorization headers, cookies, queries, bodies, paths, chat, console, source, artifacts, and provider output in `tests/unit/sanitize.test.ts` and `tests/unit/secret-scan.test.ts`
- [X] T009 [P] Write failing Evidence ID tests for `ev_<phase>_<type>_<ordinal>`, deterministic order, immutability, uniqueness, and rejection of malformed, duplicate, replay-phase, cross-run, and unknown citations in `tests/unit/evidence-ids.test.ts`
- [X] T010 [P] Write failing artifact-store tests for `.flowproof/runs/<run-id>/` as the only persistent product-artifact addition beneath the original working tree, OS-temp build/worktree output, sanitize-before-hash, atomic writes, closed reads, symlinked-root rejection, and Git-ignored root in `tests/unit/artifact-store.test.ts`
- [X] T011 [P] Write failing gate-reducer tests for the nine required gate IDs, complete failed and unevaluable reporting, and all-pass-only `Verified Fix` in `tests/unit/gate-reducer.test.ts`
- [X] T012 [P] Write failing connected-stream tests for contiguous sequence from `1`, same-run Evidence IDs, sanitized content, heartbeats, no missed-event replay, and result independence from SSE in `tests/unit/studio-events.test.ts`
- [X] T013 [P] Write failing registry and loader tests for kebab-case IDs, repository-contained paths, non-overlapping oracle/provider/source paths, fixed build commands, identical replay actions, provider mode per case, and rejection of command/path/oracle/gate/provider/timeout overrides in `tests/unit/scenario-registry.test.ts`
- [X] T014 [P] Write failing request-guard tests for exact `Host`, launch cookie, POST `Origin`, GET/SSE `Sec-Fetch-Site: same-origin`, loopback binding, `no-store`, restrictive CSP with demo-origin-only `frame-src`, path traversal, and the stable `{"error":{"code","message"}}` envelope in `tests/integration/studio-security.test.ts`
- [X] T015 [P] Write failing known-bad filter and trusted chart-probe tests in `tests/unit/demo-chart.test.ts`

### Implementation

- [X] T016 Implement strict Zod contracts, cross-field invariants, safe parsing and error mapping, schema-version checks, Workspace Session, Chat Request, Run states `initialized → reproducing → failure_captured → diagnosing → candidate_validated → applying → replaying → finalized`, Candidate Change, and Verification Result in `packages/flowproof/src/contracts/schemas.ts`, `packages/flowproof/src/contracts/index.ts`, and `packages/flowproof/src/contracts/entities.ts`
- [X] T017 Commit the synthetic dataset and filter options, Hero scenario with `provider.mode=meta` and `timeouts.model_ms=90000`, and immutable ordered-row and chart-series oracles in `apps/demo-chart/src/data.ts`, `scenarios/canvas-filter/hero.json`, `scenarios/canvas-filter/expected/filtered-data.json`, and `scenarios/canvas-filter/expected/chart-series.json`
- [X] T018 Implement the committed-case registry and override-proof Scenario loader in `packages/flowproof/src/scenario/registry.ts` and `packages/flowproof/src/scenario/loadScenario.ts`
- [X] T019 Implement pre-persistence and pre-transmission redaction plus whole-run seeded-marker scanning in `packages/flowproof/src/evidence/sanitize.ts` and `packages/flowproof/src/evidence/secretScan.ts`
- [X] T020 Implement stable Evidence ID creation and same-run failure-phase citation validation in `packages/flowproof/src/evidence/ids.ts`
- [X] T021 Implement atomic sanitized artifact persistence, canonical manifest hashing, closed identifier lookup, and artifact-root symlink and ignore validation in `packages/flowproof/src/evidence/store.ts`
- [X] T022 Implement nine gate outcomes and deterministic all-pass reduction in `packages/flowproof/src/verify/gates.ts`
- [X] T023 Implement in-memory ordered Studio event emission with live-only SSE delivery in `packages/flowproof/src/studio/events.ts`
- [X] T024 Implement launch-cookie, Host, Origin, fetch-site, loopback, CSP, and no-store guards plus the stable error-envelope helper in `packages/flowproof/src/studio/auth.ts` and `packages/flowproof/src/studio/errors.ts`
- [X] T025 [P] Implement the one-file filter defect in the only permitted candidate target, the fixed-size animation-disabled Canvas chart and filter control, and the read-only trusted probe outside the patch boundary in `apps/demo-chart/src/filterData.ts`, `apps/demo-chart/src/main.ts`, and `apps/demo-chart/src/testProbe.ts`

**Checkpoint 2**: deterministic tests pass without a browser or Meta call; the built demo app
reproduces the defect in a plain browser.

---

## Phase 3: User Story 1 - Obtain a Verified Fix (Priority: P1) MVP

**Goal**: In one split-view Studio, visibly reproduce the known-bad Canvas defect, capture sanitized
evidence, obtain one evidence-cited Meta diagnosis and safe diff, apply it only in a detached
worktree, replay the same action, and show `Verified Fix` only after all nine gates pass.

**Independent Test**: Run `pnpm flowproof studio --scenario canvas-filter-hero`, submit the bounded
chat request, and verify that the left pane shows failure then replay, the right pane shows ordered
evidence and gates, the live Meta response cites only current failure Evidence IDs, all nine gates
pass within 300 seconds, and every original tracked/Git/worktree-list snapshot is restored apart
from ignored sanitized run artifacts.

### Slice 3A - Closed-loop walking skeleton (internal checkpoint, not a deliverable)

#### Failing tests first

- [X] T026 [P] [US1] Write the seven-item failure and six-item replay capture integration tests against the built demo app on its fixed `localhost` port in `tests/integration/browser-capture.test.ts`
- [X] T027 [P] [US1] Write detached-worktree tests that resolve `git rev-parse --git-common-dir`, snapshot the complete `git worktree list --porcelain` output, preserve unrelated pre-existing worktrees, create at original `HEAD`, run the committed build command, apply a known safe diff, remove with `git worktree remove --force`, prune, and require the full tracked/index/branch/HEAD/history/hash/worktree-list snapshot to match on normal and error paths in `tests/integration/worktree.test.ts`
- [X] T028 [P] [US1] Write Studio API tests for safe scenario metadata, one active run, bounded chat, rejection of provider/transport/path/command/oracle/gate/model body fields, deferred `PROVIDER_CREDENTIAL_MISSING` with no run side effect, live SSE, authoritative result, closed evidence and candidate-diff reads, envelope errors, and no generic file route in `tests/integration/studio-api.test.ts`
- [X] T029 [P] [US1] Write CLI precondition tests against temporary clones asserting exit `3` with stable reason codes and no artifact, app, worktree, Git-metadata, or Chromium side effect for dirty tracked state, missing `HEAD`, unresolvable committed paths, explicit Hero without `MODEL_API_KEY`, unregistered scenario, and symlinked `.flowproof/runs`, while launch without `--scenario` succeeds without a key and internal startup failure exits `4`, in `tests/integration/cli-preconditions.test.ts`
- [X] T030 [P] [US1] Author the recorded schema-valid Hero response and test transports, plus negative tests proving only in-process `startStudio({ testTransport })` can inject one, ordinary `selectTransport(heroScenario)` selects live Meta, and CLI flags, environment variables, scenario fields, and `POST /api/runs` cannot select test transport, in `tests/fixtures/provider/hero-recorded-response.json`, `tests/support/recordedTransport.ts`, and `tests/integration/provider-seam.test.ts`
- [X] T031 [P] [US1] Write failing run-state tests for every legal transition, direct fail-closed finalization, nine outcomes always present, downstream `unevaluable` gates, stage-aware artifacts, scenario timeouts, phase/total durations, and cleanup on every exit in `tests/unit/run-state-machine.test.ts`
- [X] T032 [P] [US1] Write patch-guard tests rejecting absolute, parent, symlink, binary, rename, multi-file, oversized, wrong-target, invalid-citation, and `git apply --check` failures in `tests/unit/patch-guard.test.ts`
- [X] T033 [P] [US1] Write dataset and Canvas oracle tests for exact ordered rows, bar count, labels, and values, with screenshots excluded from status reduction, in `tests/unit/oracle.test.ts`
- [X] T034 [US1] Write the in-process Studio harness and a headed Hero end-to-end skeleton that expects recorded diagnosis, validated one-file diff, isolated apply, patched rebuild, iframe reconnection, identical replay, dataset and Canvas oracle evaluation, nine passing gates, `Verified Fix`, cleanup, and unchanged pre-run snapshots with `MODEL_API_KEY` unset in `tests/support/studioHarness.ts` and `tests/e2e/hero.spec.ts`

#### Closed-loop implementation

- [X] T035 [P] [US1] Implement `ModelTransport`, readiness checks, and `selectTransport(scenario, { testTransport? })` so an override is accepted only by the in-process `startStudio` option in `packages/flowproof/src/model/transport.ts`
- [X] T036 [P] [US1] Implement the target-app lifecycle owner with one fixed-port `localhost` server, document-root swaps for preview, known-bad, and patched builds, single bind/release, committed worktree build command, iframe reconnection, and trusted-probe readiness in `packages/flowproof/src/studio/targetApp.ts` and `tests/unit/target-app.test.ts`
- [X] T037 [P] [US1] Implement Playwright action replay plus action, dataset, chart, screenshot, console, metadata-only network, and allowlisted source capture sanitized before persistence and ID emission in `packages/flowproof/src/capture/browserCapture.ts`
- [X] T038 [P] [US1] Implement detached worktree creation at original `HEAD`, pre-run snapshots, offline dependency linking, committed build command execution, validated diff application, FlowProof-owned remove/prune, and full post-cleanup snapshot comparison in `packages/flowproof/src/worktree/session.ts`
- [X] T039 [P] [US1] Build the sanitized evidence manifest and one-file source prompt with no commands, oracle values, or tool definitions in `packages/flowproof/src/model/prompt.ts`
- [X] T040 [P] [US1] Implement citation, target-path, grammar, size, and `git apply --check` validation producing `citations_valid` and `patch_scope_valid` before any apply in `packages/flowproof/src/patch/validateDiff.ts`
- [X] T041 [P] [US1] Implement exact dataset and rendered-chart oracle evaluation in `packages/flowproof/src/verify/oracle.ts`
- [X] T042 [US1] Implement the complete recorded-transport run state machine from reproduction through diagnosis, safe apply, patched rebuild, visible replay, nine-gate reduction, stage-aware artifacts, `result.json`, cleanup, and final integrity comparison in `packages/flowproof/src/run.ts`
- [X] T043 [US1] Implement the guarded loopback endpoints and live SSE lifecycle from `contracts/studio-api.md`, including deferred credential readiness and no-side-effect rejection, in `packages/flowproof/src/studio/server.ts`
- [X] T044 [US1] Implement the typed Studio client and session/activity/evidence/gate/candidate/result state with a state test in `apps/studio/src/api.ts`, `apps/studio/src/state.ts`, and `tests/ui/state.test.ts`
- [X] T045 [US1] Implement bounded chat, ordered Agent Activity, Evidence, Gate, and final-status views without inline styles in `apps/studio/src/components/AgentPanel.tsx`
- [X] T046 [US1] Implement the framed prepared-application surface and assemble the CSP-compatible split workspace with case selection in `apps/studio/src/components/TargetPane.tsx`, `apps/studio/src/App.tsx`, `apps/studio/src/main.tsx`, and `apps/studio/src/styles.css`
- [ ] T047 [US1] Implement OS-temp Studio and preview builds, Studio and target servers, launch session and HttpOnly cookie injection, pinned headed Chromium, safe launch JSON, and the in-process `startStudio(options)` entry in `packages/flowproof/src/studio/launch.ts`
- [ ] T048 [US1] Implement only `flowproof studio [--scenario <scenario-id>]` with the precondition sequence, `tsc`-built CLI runtime, deferred key check without `--scenario`, exit codes `0`/`3`/`4`, and safe diagnostics in `packages/flowproof/src/cli.ts`
- [ ] T049 [US1] Make the recorded Hero end-to-end test pass through apply, rebuild, replay, oracle evaluation, `Verified Fix`, FlowProof-owned worktree remove/prune, and exact restoration of the pre-run worktree list in `tests/e2e/hero.spec.ts`

**Checkpoint 3A**: one real headed Studio run crosses every runtime layer and closes the loop with
a recorded response. It is an internal implementation checkpoint, not the live Meta deliverable.

### Slice 3B - Production Meta adapter and complete Proof Trail

- [ ] T050 [P] [US1] Write Meta client tests for a sanitized one-file prompt, one stateless `store:false` strict-schema call, SDK `maxRetries:0`, timeout from `scenario.timeouts.model_ms`, exactly one HTTP request on success, 429, 5xx, and timeout, fail-closed outcomes, key only from `MODEL_API_KEY`, and no raw payload or key in logs in `tests/unit/meta-client.test.ts`
- [ ] T051 [US1] Implement the `muse-spark-1.3` Responses API adapter with strict schema, `store:false`, `maxRetries:0`, scenario timeout, one attempt, safe metrics, and ordinary Hero registration as the live transport in `packages/flowproof/src/model/metaClient.ts` and `packages/flowproof/src/model/transport.ts`
- [ ] T052 [US1] Implement the in-workspace Proof Trail with verified diff, failure and replay evidence, screenshots, gate outcomes, fixture provenance when present, and final status in `apps/studio/src/components/ProofTrail.tsx` and `apps/studio/src/App.tsx`
- [ ] T053 [US1] Complete deterministic Hero assertions for the full Proof Trail, visible replay, nine passing gates, phase budgets, `total_duration_ms < 300000`, no live Meta request, and restored original snapshots in `tests/e2e/hero.spec.ts`
- [ ] T054 [US1] Add an opt-in adapter-level live Meta smoke that is excluded from default tests, visibly skips without `MODEL_API_KEY`, and records only model ID, tokens, latency, schema outcome, and citation outcome in `tests/integration/meta-smoke.test.ts` and the `test:meta-smoke` script in `package.json`

**Checkpoint 3B**: User Story 1 is implementation-complete; the final credential-gated full live
Hero run remains an explicit Quickstart verification gate.

---

## Phase 4: User Story 2 - Reject an Unverified Fix (Priority: P2)

**Goal**: Run the same controlled defect with a clearly labeled invalid-citation fixture, reject it
before patch application, and show the failed `citations_valid` gate and `Unverified` Proof Trail
without changing original tracked files or Git state.

**Independent Test**: Run `pnpm flowproof studio --scenario canvas-filter-failure-invalid-citation`,
submit the request, and verify visible failure evidence, labeled injection, rejection before apply,
no replay artifacts, `Unverified`, and restored pre-run snapshots.

- [ ] T055 [P] [US2] Commit and register the Failure scenario with the same actions, oracles, and app, `provider.mode=fixture`, explicit `injected_fault_label`, and the labeled nonexistent-Evidence-ID diagnosis fixture in `scenarios/canvas-filter/failure-invalid-citation.json`, `scenarios/canvas-filter/provider-fixtures/invalid-citation.json`, and `packages/flowproof/src/scenario/registry.ts`
- [ ] T056 [P] [US2] Write fixture-transport tests for explicit injection labeling, no Meta call, no key requirement, and invalid-citation rejection before patch application in `tests/integration/failure-provider.test.ts`
- [ ] T057 [US2] Write the deterministic Failure end-to-end skeleton for visible evidence, labeled fixture, failed citation gate, no application or replay artifact, `Unverified`, and restored snapshots in `tests/e2e/failure.spec.ts`
- [ ] T058 [US2] Implement the fixture transport and injected-fault labeling in events and the result in `packages/flowproof/src/model/transport.ts` and `packages/flowproof/src/run.ts`
- [ ] T059 [US2] Render injected-fixture provenance, the failed citation gate, absent replay, and `Unverified` without raw fixture content in `apps/studio/src/components/ProofTrail.tsx`
- [ ] T060 [US2] Make the deterministic Failure end-to-end test pass and prove the candidate is rejected before application in `tests/e2e/failure.spec.ts`

**Checkpoint 4**: User Story 2 independently proves fail-closed behavior and never invents
artifacts for phases not reached.

---

## Phase 5: Lifecycle Safety & Cross-Cutting Verification

**Purpose**: Complete normative lifecycle, security, documentation, and live verification without
adding another product surface.

- [ ] T061 [P] Write browser/page-close and interrupt end-to-end skeletons for close during `reproducing`, `diagnosing`, and `replaying` plus SIGINT during `applying`, asserting `Unverified`, the affected required gate failed or unevaluable, stage-aware omission, FlowProof-owned remove/prune, exit `2`, and restored worktree snapshots in `tests/e2e/browser-close.spec.ts`
- [ ] T062 [P] Write the target-frame load-failure skeleton asserting no model call, no patch, null `failure_screenshot_path`, no failure bundle, `failure_reproduced` and dependents failed or unevaluable, contract-valid `result.json`, and cleanup in `tests/e2e/target-load-failure.spec.ts`
- [ ] T063 [P] Write seeded-marker end-to-end coverage across artifacts, captured Meta request body, chat/events, UI, diagnostics, and final result in `tests/e2e/secret-safety.spec.ts`
- [ ] T064 Implement page/browser-close detection and interrupt handling with safe finalization, FlowProof-owned worktree remove/prune, snapshot comparison, and exit `2` in `packages/flowproof/src/studio/launch.ts`, `packages/flowproof/src/run.ts`, and `packages/flowproof/src/cli.ts`
- [ ] T065 Implement target-frame load-failure handling before model use in `packages/flowproof/src/run.ts` and `packages/flowproof/src/studio/targetApp.ts`
- [ ] T066 Add cleanup-residue integration coverage proving no FlowProof-owned temporary directory, server, browser, or Git common-directory worktree entry remains after success, provider failure, apply failure, browser close, target failure, or interrupt in `tests/integration/cleanup.test.ts`
- [ ] T067 [P] Update the public MVP overview, setup, runtime build strategy, security and isolation boundary, Hero/Failure demo, and explicit non-goals in `README.md`
- [ ] T068 Run all deterministic commands and correct documentation-only drift in `specs/001-verify-debugging-fix/quickstart.md`
- [ ] T069 Run `pnpm test:meta-smoke` with and without credentials, verify the documented skip and sanitized live result, and correct only protocol-smoke drift in `specs/001-verify-debugging-fix/quickstart.md`
- [ ] T070 Run the credential-gated full live Hero flow, verify one Meta request and `total_duration_ms < 300000`, compare every expected outcome, and correct only observed Quickstart drift in `specs/001-verify-debugging-fix/quickstart.md`
- [ ] T071 Run `pnpm test`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm build`, JSON Schema validation, `git diff --check`, requirement/task traceability, dependency-DAG validation, and a repository secret scan against `package.json` and `specs/001-verify-debugging-fix/tasks.md`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1**: none.
- **Phase 2**: depends on Phase 1 and blocks both stories.
- **Phase 3**: depends on Phase 2. Slice 3A must finish at T049 before Slice 3B.
- **Phase 4**: T055-T057 may be prepared after T049; completing the Failure UI and checkpoint also depends on T052. The story remains independently runnable through its registered case.
- **Phase 5**: test skeletons T061-T063 may be written after T049; implementations and final runs depend on both story checkpoints.

### Critical dependency path

```text
T001 -> T002 -> T006 -> T007 -> T016 -> T017 -> T025
  -> T026/T027/T030/T031/T032/T033/T034
  -> T035/T036/T037/T038/T039/T040/T041
  -> T042 -> T043 -> T044 -> T045 -> T046 -> T047 -> T048 -> T049
  -> T050 -> T051 -> T052 -> T053 -> T054
  -> T055/T056 -> T057 -> T058 -> T059 -> T060
  -> T061/T062/T063 -> T064/T065/T066 -> T068 -> T069 -> T070 -> T071
```

T028 depends on T024. T029 constrains T048. T045 depends on T044; T046 depends on T044 and T045.
T047 depends on T036, T043, and T046. T057 depends on T055-T056. T060 depends on T055-T059.
T068-T071 run only after their referenced implementation and documentation tasks are complete.

### Parallel opportunities

- T003-T005 after T002.
- T007-T015 after T006.
- T018-T024 after T016 and T017 where applicable; T025 after T015 and T017.
- T026-T033 after Checkpoint 2, except T028 also requires T024.
- T035-T041 after their matching failing tests.
- T050 may be authored while T052 is implemented after T049; T051 follows T050.
- T055-T056 after T049; T061-T063 after T049 in separate files.
- T067 may proceed after both user-story UI contracts stabilize.

## Parallel Example: Slice 3A tests

```text
T026: tests/integration/browser-capture.test.ts
T027: tests/integration/worktree.test.ts
T028: tests/integration/studio-api.test.ts
T029: tests/integration/cli-preconditions.test.ts
T030: tests/integration/provider-seam.test.ts and provider fixture/support files
T031: tests/unit/run-state-machine.test.ts
T032: tests/unit/patch-guard.test.ts
T033: tests/unit/oracle.test.ts
```

## Implementation Strategy

### MVP first

1. Complete Setup and Foundation.
2. Complete Slice 3A and stop at the first real apply/rebuild/replay/oracle checkpoint.
3. Add the production Meta adapter and complete the Proof Trail in Slice 3B.
4. Run the credential-gated live Hero only after deterministic Hero is stable.
5. Add the Failure case and cross-cutting lifecycle gates.

### Incremental delivery

1. **Foundation ready**: contracts and fail-closed primitives pass without external services.
2. **Closed loop wired**: recorded evidence → diff → isolated apply → replay reaches `Verified Fix`.
3. **Hero ready**: production Meta adapter, Proof Trail, and deterministic full UI pass.
4. **Failure ready**: invalid citation remains `Unverified` before application.
5. **Demo ready**: lifecycle, secret, timing, docs, deterministic suite, Meta smoke, and live Hero pass.

### Explicit user-only work

- Provide a valid local `MODEL_API_KEY` through ignored `.env` for T069-T070; never print, persist,
  or commit the value.
- Keep a display session available for headed-Chromium end-to-end runs and the final demo check.
- Push, open a pull request, publish a live artifact, record the submission video, submit the
  hackathon entry, or accept legal terms only after separate authorization.

## Notes

- Deferred issues #5-#12 remain out of scope. The in-process `startStudio` entry is not a headless
  adapter: it launches the same Studio and browser and substitutes only the model transport.
- The integrity baseline is the complete pre-run worktree list, not an assumption that only one
  worktree exists. Resolve the Git common directory instead of hardcoding `.git/worktrees`.
- A screenshot is required evidence but never a status-deciding pixel gate in this MVP.
- A failed run is correct when it safely reports failed or unevaluable gates.
- Mark a task complete only after its named verification passes; keep implementation commits small
  and reviewable.
