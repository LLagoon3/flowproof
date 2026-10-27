---

description: "Implementation tasks for the evidence-grounded fix verification MVP"
---

# Tasks: Evidence-Grounded Fix Verification

**Input**: Design documents from `/specs/001-verify-debugging-fix/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, and
`quickstart.md`

**Tests**: Tests are required because the Plan mandates test-first implementation for the
sanitizer, Evidence ID validator, patch guard, gate reducer, and original-worktree integrity check,
plus contract, integration, Studio, and end-to-end coverage.

**Organization**: Tasks are grouped by user story. User Story 1 delivers the complete Hero loop;
User Story 2 reuses that loop to prove deterministic fail-closed behavior.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it changes different files and has no dependency on another
  incomplete task in the same phase.
- **[Story]**: Maps the task to User Story 1 (`US1`) or User Story 2 (`US2`).
- Every task names the exact file or files it changes or validates.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the pinned Node.js, TypeScript, pnpm, Vite, Vitest, and Playwright workspace
without implementing product behavior.

- [ ] T001 Create the pnpm workspace and root scripts, including Node.js 24 `--env-file-if-exists=.env` loading for `pnpm flowproof`, in `package.json`, `pnpm-workspace.yaml`, and `tsconfig.base.json`
- [ ] T002 Pin the Plan-approved runtime and test dependencies in `apps/studio/package.json`, `apps/demo-chart/package.json`, and `packages/flowproof/package.json`
- [ ] T003 [P] Configure the React Studio build in `apps/studio/index.html`, `apps/studio/vite.config.ts`, and `apps/studio/tsconfig.json`
- [ ] T004 [P] Configure the static trusted demo build in `apps/demo-chart/index.html`, `apps/demo-chart/vite.config.ts`, and `apps/demo-chart/tsconfig.json`
- [ ] T005 [P] Configure deterministic Vitest and Playwright projects in `vitest.config.ts` and `playwright.config.ts`
- [ ] T006 Add `MODEL_API_KEY` documentation to `.env.example` and ignore `.flowproof/`, temporary outputs, and local secrets in `.gitignore`
- [ ] T007 Install the pinned dependency graph and commit the reproducible lockfile in `pnpm-lock.yaml`

**Checkpoint**: `pnpm install --frozen-lockfile`, TypeScript compilation, and empty test discovery can
run from the repository root.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the shared contracts, trusted scenario boundary, sanitization, evidence,
gate reduction, event ordering, and loopback request guards required by both stories.

**Critical**: No user story implementation starts until these tasks pass.

### Contract and scenario tests

- [ ] T008 [P] Write failing scenario-contract tests for exact version `1.0.0`, one action, one permitted path, Hero=`meta`, Failure=`fixture`, device scale `1`, and timeout maxima in `tests/contract/scenario-contract.test.ts`
- [ ] T009 [P] Write failing Evidence Bundle tests for six replay types, all seven failure types after completed failure capture, same-run/phase items, unique IDs, safe relative paths, and 64-character hashes in `tests/contract/evidence-bundle-contract.test.ts`
- [ ] T010 [P] Write failing diagnosis-contract tests for nonempty claims, failure Evidence IDs, exactly one safe target path, and a `1..20000` character unified diff beginning `diff --git a/` in `tests/contract/diagnosis-contract.test.ts`
- [ ] T011 [P] Write failing Studio event tests for `<run_id>:<sequence>`, contiguous sequences from `1`, sanitized messages, existing artifact refs, and gate payloads only on `gate_updated` in `tests/contract/studio-event-contract.test.ts`
- [ ] T012 [P] Write failing run-result tests for exactly nine unique gates, complete `failed_gate_ids`, nullable pre-capture `failure_screenshot_path`, non-null Verified Fix phase artifacts, Meta model `muse-spark-1.3`, labeled fixture mode, and all-pass-only `Verified Fix` in `tests/contract/run-result-contract.test.ts`
- [ ] T013 Implement strict Zod contracts and cross-field invariants for Scenario, Evidence Bundle, Diagnosis, Studio Event, and Run Result in `packages/flowproof/src/contracts/schemas.ts`
- [ ] T014 Export contract parsing, safe error mapping, and schema version checks from `packages/flowproof/src/contracts/index.ts`

### Trusted scenario and immutable oracle boundary

- [ ] T015 [P] Commit the Hero scenario, ordered expected rows, and exact bar count, labels, and values in `scenarios/canvas-filter/hero.json`, `scenarios/canvas-filter/expected/filtered-data.json`, and `scenarios/canvas-filter/expected/chart-series.json`
- [ ] T016 Write failing registry tests for kebab-case IDs, repository-contained paths, non-overlapping oracle/provider/source paths, fixed commands, and identical replay actions in `tests/unit/scenario-registry.test.ts`
- [ ] T017 Implement the committed-case registry and path/command/oracle validation in `packages/flowproof/src/scenario/registry.ts`
- [ ] T018 Implement the Scenario loader so browser and chat input can select only a registered ID and cannot override commands, paths, expected values, gates, or provider mode in `packages/flowproof/src/scenario/loadScenario.ts`

### Sanitized evidence and deterministic status

- [ ] T019 [P] Write failing sanitizer and seeded-marker scan tests for credentials, authorization headers, cookies, queries, bodies, paths, chat, console, source, artifacts, and provider output in `tests/unit/sanitize.test.ts` and `tests/unit/secret-scan.test.ts`
- [ ] T020 Implement pre-persistence and pre-transmission redaction plus whole-run seeded-marker scanning in `packages/flowproof/src/evidence/sanitize.ts` and `packages/flowproof/src/evidence/secretScan.ts`
- [ ] T021 [P] Write failing Evidence ID tests for `ev_<phase>_<type>_<ordinal>`, immutability, uniqueness, and rejection of malformed, duplicate, replay-phase, cross-run, and unknown citations in `tests/unit/evidence-ids.test.ts`
- [ ] T022 Implement stable Evidence ID creation and same-run citation validation in `packages/flowproof/src/evidence/ids.ts`
- [ ] T023 [P] Write failing artifact-store tests proving `.flowproof/runs/<run-id>/` is the only write beneath the original repository, build/worktree outputs stay in OS temporary directories, sanitization precedes hashing/writes, and generic path reads are rejected in `tests/unit/artifact-store.test.ts`
- [ ] T024 Implement atomic sanitized artifact persistence, canonical manifest hashing, and closed identifier lookup in `packages/flowproof/src/evidence/store.ts`
- [ ] T025 [P] Write failing gate-reducer tests for the nine required gate IDs, complete failed/unevaluable reporting, and the rule that only nine passes yield `Verified Fix` in `tests/unit/gate-reducer.test.ts`
- [ ] T026 Implement gate outcomes and deterministic all-pass reduction in `packages/flowproof/src/verify/gates.ts`
- [ ] T027 [P] Write failing connected-stream tests for contiguous event sequence, same-run Evidence IDs, sanitized content, no missed-event replay, and result independence from SSE in `tests/unit/studio-events.test.ts`
- [ ] T028 Implement in-memory ordered Studio event emission with live-only SSE delivery in `packages/flowproof/src/studio/events.ts`

### Workspace session and local security boundary

- [ ] T029 Define Workspace Session, Chat Request, Run, Candidate Change, and Verification Result types with session state `ready|running|finalized|closed`, at most one active run, and run state transitions from `initialized` to `finalized` in `packages/flowproof/src/contracts/entities.ts`
- [ ] T030 [P] Write failing request-guard tests for exact `Host`, launch cookie, POST `Origin`, GET/SSE `Sec-Fetch-Site: same-origin`, loopback binding, no-store responses, and path traversal in `tests/integration/studio-security.test.ts`
- [ ] T031 Implement launch-cookie, Host, Origin, fetch-site, loopback, CSP, and no-store guards in `packages/flowproof/src/studio/auth.ts`

**Checkpoint**: All contract and shared deterministic tests pass without starting a browser or
calling Meta Model API.

---

## Phase 3: User Story 1 - Obtain a Verified Fix (Priority: P1) MVP

**Goal**: In one split-view Studio, visibly reproduce the known-bad Canvas defect, capture sanitized
evidence, obtain one evidence-cited Meta diagnosis and safe diff, apply it only in a detached
worktree, replay the same action, and show `Verified Fix` only after all nine gates pass.

**Independent Test**: Run `pnpm flowproof studio --scenario canvas-filter-hero`, submit the bounded
chat request, and verify that the left pane shows failure then replay, the right pane shows ordered
evidence and gates, the live Meta response cites only current failure Evidence IDs, all nine gates
pass within 300 seconds, and the original tracked files, index, checked-out branch, `HEAD`, history,
and protected hashes remain unchanged apart from permitted ignored run artifacts.

### Tests for User Story 1 (write first and observe failure)

- [ ] T032 [P] [US1] Write the known-bad filter and trusted chart-probe unit tests in `tests/unit/demo-chart.test.ts`
- [ ] T033 [P] [US1] Write the seven-item failure and six-item replay capture integration tests in `tests/integration/browser-capture.test.ts`
- [ ] T034 [P] [US1] Write Meta request/response tests for exactly one stateless `store:false` strict-schema HTTP attempt, no automatic retry, 90-second timeout, fail-closed 429/5xx handling, sanitized input, and no raw payload logging in `tests/unit/meta-client.test.ts`
- [ ] T035 [P] [US1] Write patch-guard tests that reject absolute/parent/symlink paths, binary patches, renames, multiple files, oversized diffs, and any target except `apps/demo-chart/src/filterData.ts` in `tests/unit/patch-guard.test.ts`
- [ ] T036 [P] [US1] Write detached-worktree tests for a clean baseline, preservation of original tracked files, index, checked-out branch, `HEAD`, history, and protected hashes, permitted ignored run artifacts, `git apply --check`, isolated apply, and cleanup in `tests/integration/worktree.test.ts`
- [ ] T037 [P] [US1] Write dataset and Canvas oracle tests proving exact ordered rows plus exact rendered bar count, labels, and values, with screenshots excluded from status reduction in `tests/unit/oracle.test.ts`
- [ ] T038 [P] [US1] Write Studio API tests for safe scenario metadata, one active run, bounded chat, live SSE, authoritative result, Evidence-ID reads, candidate-diff reads, and no generic file route in `tests/integration/studio-api.test.ts`
- [ ] T039 [US1] Write the deterministic headed Hero end-to-end skeleton using a recorded schema-valid response through a test-only provider transport, with split view, visible reproduction/replay, Proof Trail, nine passing gates, no Meta request, and unchanged original tracked/Git state in `tests/e2e/hero.spec.ts`

### Trusted demo and capture implementation

- [ ] T040 [P] [US1] Add the synthetic chart dataset and filter options in `apps/demo-chart/src/data.ts`
- [ ] T041 [P] [US1] Implement the intentional one-file filter defect in the only permitted candidate target `apps/demo-chart/src/filterData.ts`
- [ ] T042 [US1] Render the fixed-size, animation-disabled Canvas chart and filter control in `apps/demo-chart/src/main.ts`
- [ ] T043 [US1] Expose a read-only trusted probe for rendered labels and values outside the patch boundary in `apps/demo-chart/src/testProbe.ts`
- [ ] T044 [US1] Implement Playwright action replay plus actions, dataset, chart, screenshot, console, metadata-only network, and allowlisted source capture in `packages/flowproof/src/capture/browserCapture.ts`
- [ ] T045 [US1] Implement exact dataset and rendered-chart oracle evaluation in `packages/flowproof/src/verify/oracle.ts`

### Model, patch, and isolation implementation

- [ ] T046 [P] [US1] Build the sanitized evidence manifest and one-file source prompt with no commands, oracle mutation, or tool selection in `packages/flowproof/src/model/prompt.ts`
- [ ] T047 [US1] Implement the `muse-spark-1.3` Responses API adapter with strict schema, `store:false`, exactly one HTTP attempt, no automatic retry, a 90-second timeout, fail-closed 429/5xx handling, and safe metrics in `packages/flowproof/src/model/metaClient.ts`
- [ ] T048 [US1] Implement citation, target-path, grammar, size, and `git apply --check` validation before application in `packages/flowproof/src/patch/validateDiff.ts`
- [ ] T049 [US1] Implement detached worktree creation at original HEAD, isolated dependency linking and build/apply/replay, original tracked/index/branch/HEAD/history and protected-hash checks, and cleanup in `packages/flowproof/src/worktree/session.ts`
- [ ] T050 [US1] Implement the Hero run state machine, phase timing, fail-closed transitions, nine gates, stage-aware contract-valid artifacts with `result.json` on safe finalization, and final cleanup in `packages/flowproof/src/run.ts`

### Split-view Studio implementation

- [ ] T051 [US1] Implement the internal loopback endpoints and live SSE lifecycle from `contracts/studio-api.md` in `packages/flowproof/src/studio/server.ts`
- [ ] T052 [P] [US1] Implement the typed Studio client for scenario, run, SSE, result, evidence, and candidate-diff routes in `apps/studio/src/api.ts`
- [ ] T053 [P] [US1] Implement session, ordered activity, Evidence ID, gate, candidate, and final-result state in `apps/studio/src/state.ts`
- [ ] T054 [P] [US1] Implement the framed prepared application surface in `apps/studio/src/components/TargetPane.tsx`
- [ ] T055 [P] [US1] Implement bounded chat, ordered Agent Activity, Evidence, and Gate views in `apps/studio/src/components/AgentPanel.tsx`
- [ ] T056 [P] [US1] Implement the in-workspace verified diff, supporting evidence, gate outcomes, and final status review in `apps/studio/src/components/ProofTrail.tsx`
- [ ] T057 [US1] Assemble and style the single-page split-view workspace and case selection in `apps/studio/src/App.tsx`, `apps/studio/src/main.tsx`, and `apps/studio/src/styles.css`
- [ ] T058 [US1] Build both Vite apps into OS temporary directories without HMR, start separate `127.0.0.1` and `localhost` static servers, inject the HttpOnly launch cookie, open pinned headed Chromium, and detect page/browser closure in `packages/flowproof/src/studio/launch.ts`
- [ ] T059 [US1] Implement only `flowproof studio [--scenario <scenario-id>]`, safe launch JSON, stable exit codes, and interrupt finalization in `packages/flowproof/src/cli.ts`
- [ ] T060 [US1] Complete and pass the deterministic recorded-provider Hero end-to-end assertions without a Meta request in `tests/e2e/hero.spec.ts`

**Checkpoint**: User Story 1 independently demonstrates the full verified-fix loop and is the
minimum shippable hackathon slice.

---

## Phase 4: User Story 2 - Reject an Unverified Fix (Priority: P2)

**Goal**: Run the same controlled defect with a clearly labeled invalid-citation provider fixture,
reject it before patch application, and show the failed `citations_valid` gate and `Unverified`
Proof Trail without changing the original tracked files or Git state.

**Independent Test**: Run
`pnpm flowproof studio --scenario canvas-filter-failure-invalid-citation`, submit the request, and
verify that the known-bad state and failure evidence appear, the injected nonexistent Evidence ID
is labeled and rejected before application, the failed gate is visible, no replay artifact is
invented, and the original tracked files and Git state remain unchanged.

### Tests for User Story 2 (write first and observe failure)

- [ ] T061 [P] [US2] Write fixture-provider tests for explicit injection labeling, no Meta call, and invalid-citation rejection before patch application in `tests/integration/failure-provider.test.ts`
- [ ] T062 [US2] Write the deterministic Failure end-to-end skeleton for visible evidence, failed citation gate, no application, `Unverified`, and unchanged original tracked/Git state in `tests/e2e/failure.spec.ts`

### Failure-case implementation

- [ ] T063 [P] [US2] Commit the nonexistent-Evidence-ID diagnosis fixture with a safe one-file diff in `scenarios/canvas-filter/provider-fixtures/invalid-citation.json`
- [ ] T064 [P] [US2] Register the Failure case, same actions/oracles, fixture provider, and explicit injected-fault label in `scenarios/canvas-filter/failure-invalid-citation.json`
- [ ] T065 [US2] Add the fixture provider path and reject-before-apply behavior to the run state machine in `packages/flowproof/src/run.ts`
- [ ] T066 [US2] Render injected-fixture provenance, the failed citation gate, absent replay, and `Unverified` without unsafe raw content in `apps/studio/src/components/ProofTrail.tsx`
- [ ] T067 [US2] Complete and pass the deterministic Failure assertions in `tests/e2e/failure.spec.ts`

**Checkpoint**: User Story 2 independently proves that FlowProof does not approve unsupported
model output and never invents artifacts for phases that were not reached.

---

## Phase 5: Polish & Cross-Cutting Verification

**Purpose**: Prove browser lifecycle, secret safety, performance, public documentation, and the
complete quickstart without adding another product surface.

- [ ] T068 [P] Add seeded-marker coverage across artifacts, Meta request capture, chat/events, UI, diagnostics, and final result in `tests/e2e/secret-safety.spec.ts`
- [ ] T069 [P] Add browser/page-close and interrupt tests for `Unverified`, interruption gate, stage-aware artifact omission, worktree cleanup, exit code `2`, and original tracked/Git-state preservation in `tests/e2e/browser-close.spec.ts`
- [ ] T070 [P] Add target-frame startup failure coverage proving no model call or patch attempt, a safely finalized `result.json`, null `failure_screenshot_path`, and no invented failure bundle in `tests/e2e/target-load-failure.spec.ts`
- [ ] T071 [P] Add the opt-in live Meta smoke that records only model ID, tokens, latency, schema result, and citation result in `tests/integration/meta-smoke.test.ts`
- [ ] T072 Add phase budgets and the total `<300000ms` Hero assertion for the prepared environment in `tests/e2e/hero.spec.ts`
- [ ] T073 Update the public MVP overview, setup, security boundary, Hero/Failure demo, and explicit non-goals in `README.md`
- [ ] T074 Run every deterministic command plus the credential-gated live Hero flow and compare every expected result in `specs/001-verify-debugging-fix/quickstart.md`, correcting documentation-only drift in that file
- [ ] T075 Run `pnpm test`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`, build/type checks, contract validation, `git diff --check`, and a repository secret scan from `package.json`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 — Setup**: No dependencies.
- **Phase 2 — Foundational**: Depends on Phase 1 and blocks both user stories.
- **Phase 3 — User Story 1**: Depends on Phase 2 and delivers the MVP Hero loop.
- **Phase 4 — User Story 2**: Depends on the shared engine completed for User Story 1, but has its
  own scenario, provider fixture, and independent end-to-end acceptance test.
- **Phase 5 — Polish**: Depends on both user stories.

### User story dependency graph

```text
Setup -> Foundation -> US1 Hero MVP -> US2 Fail-closed proof -> Cross-cutting validation
```

User Story 2 has a delivery dependency on the shared capture and run engine built in User Story 1;
its behavior remains independently runnable and testable through its registered Failure case.

### Within each user story

- Write the listed tests first and observe the relevant failure before implementation.
- Build the trusted fixture and deterministic logic before orchestration.
- Validate model output and patch scope before any apply operation.
- Complete engine and API behavior before wiring the UI and end-to-end test.
- Finish the story checkpoint before starting the next story.

### Parallel opportunities

- T003-T005 can run in parallel after T001-T002 establish root conventions.
- T008-T012, T015, T019, T021, T023, T025, T027, and T030 touch independent fixtures or tests.
- T032-T038 are independent failing-test work after Foundation is complete.
- T040-T041 and T046 can proceed in parallel before their dependent integration work.
- T052-T056 touch separate Studio files after the API contract and state shape are stable.
- T061-T064 can be prepared in parallel after User Story 1 passes.
- T068-T071 cover independent cross-cutting risks after both stories pass.

## Parallel Example: User Story 1

```text
T032: tests/unit/demo-chart.test.ts
T033: tests/integration/browser-capture.test.ts
T034: tests/unit/meta-client.test.ts
T035: tests/unit/patch-guard.test.ts
T036: tests/integration/worktree.test.ts
T037: tests/unit/oracle.test.ts
T038: tests/integration/studio-api.test.ts
```

These tests can be authored in parallel because they target different files and bounded contracts.
Implementation then proceeds through capture/oracle, model/patch/worktree, orchestration/API, and UI.

## Implementation Strategy

### MVP first

1. Complete Setup and Foundation.
2. Complete User Story 1 and stop at its end-to-end checkpoint.
3. Confirm the Hero loop is stable before implementing the Failure fixture.

### Incremental delivery

1. **Foundation ready**: contracts and fail-closed primitives pass without external services.
2. **Hero ready**: live Meta-backed evidence → diff → isolated replay reaches `Verified Fix`.
3. **Failure ready**: deterministic invalid citation remains `Unverified` before application.
4. **Demo ready**: security, lifecycle, secret, timing, docs, and full quickstart gates pass.

### Explicit user-only work

- Provide a valid local `MODEL_API_KEY` through ignored `.env` when running the live Hero or Meta
  smoke. The agent must never print, persist, or commit the value.
- Keep a display session available for the final headed-Chromium demo check.
- Push, open a pull request, publish a live artifact, record the submission video, submit the
  hackathon entry, or accept legal terms only after separate user authorization.

## Notes

- Deferred issues #5-#12 are intentionally absent: headless CLI, portable export/bulk artifacts,
  SSE replay, pixel hard gate, multi-turn chat, macOS validation, Chrome Side Panel, and
  user-defined defects each require a future Spec Kit feature.
- A screenshot is required evidence but never a status-deciding pixel gate in this MVP.
- A failed run is a correct result when it safely reports the failed or unevaluable gate.
- Mark a task complete only after its named verification passes; keep implementation commits small
  and reviewable.
