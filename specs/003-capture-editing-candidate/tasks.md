---

description: "Implementation tasks for Git-native editing change capture"
---

# Tasks: Capture Editing Changes

**Input**: Design documents from `/specs/003-capture-editing-candidate/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/capture-session.md`, `quickstart.md`

**Tests**: Required by the approved acceptance criteria and the Plan's risk-based test-first decision. Write the indicated failing cases before the corresponding implementation; record actual test discovery and results, never a zero-test pass.

**Organization**: Grouped by user story. The approved feature remains one delivery slice and one implementation PR. Phase checkpoints order internal work; they do not create additional PRs or authorize publication. Tasks are marked complete only with the implementation and validation evidence recorded below.

## Format: `[ID] [P?] [Story] Description`

- **[P]** means different files and no dependency on an incomplete task within that phase. It describes an opportunity, not an instruction to spawn agents.
- **[US1]**, **[US2]**, and **[US3]** map to the stories in `spec.md`.
- Paths are repository-relative. Only the new capture files listed in the Plan are introduced; existing helpers and fixtures are reused.

## Phase 1: Setup (Reuse the Credential-Free Editor)

**Purpose**: Extend the existing synthetic editor rather than create another runtime, project, dependency, or service.

- [x] T001 Add deterministic capture scenarios to `tests/fixtures/editing-agent/agent.mjs` for successful multi-file/binary edits, unchanged/reverted edits, a seeded-sensitive change, and edits followed by nonzero exit or cancellation; keep existing scenario behavior unchanged, use synthetic bytes only, and reuse `tests/support/editingRuntime.ts` for image/profile ownership and cleanup

**Checkpoint**: Prepared editing scenarios are available; this alone is not a working capture entry point.

---

## Phase 2: Foundational (Concrete Contract, Bounded Git, Owned Scratch)

**Purpose**: Establish the capture data and private Git operations without changing lifecycle-only callers or wiring production verification.

- [x] T002 Write failing opt-in capture contract tests in `tests/contract/editing-capture-contract.test.ts` for the `{ session, capture }` composition, the five statuses `captured|no_changes|rejected|failed|not_attempted`, the seven reason categories in `data-model.md`, candidate-only-on-captured invariants, matching session/baseline identity, fixed reference-only coverage, and absence of host locator or verification fields; retain the strict old result contract in `tests/contract/editing-session-contract.test.ts`
- [x] T003 Define concrete in-process candidate/result types and fixed safe reason messages in `packages/flowproof/src/editing/capture.ts`: quote and enforce "Only `captured` has a nonempty patch/files pair, matching the same baseline/session" and "Failure/rejection/no-changes/not-attempted never have candidate bytes or partial records"; preserve the existing execution/cleanup enums, keep messages within the existing diagnostic scale, and add no external schema, retry ledger, policy registry, or public callback API
- [x] T004 Write failing binary-safe runner tests in `tests/unit/editing-capture.test.ts` for lossless Buffer/NUL stdin/stdout, sanitized environment and disabled external Git commands, one shared `60_000`-ms deadline and `32 * 1024 * 1024`-byte cumulative budget, incremental stdout/stderr accounting, and abort/overflow/deadline termination plus joining of only the capture-owned process group, including a controlled descendant
- [x] T005 Implement the small shell-free binary-safe Git runner and shared deadline/byte accounting in `packages/flowproof/src/editing/captureGit.ts`, reusing `gitEnvironment`, `GIT_SAFETY`, `GIT_TIMEOUT_MS`, and `MAX_GIT_OUTPUT_BYTES` from `packages/flowproof/src/git/repositoryState.ts`; keep raw stderr private, preserve operational/interruption/limit distinctions, and join capture children before returning rather than relying on `Promise.race` alone
- [x] T006 Write failing opt-in workspace tests in `tests/integration/editing-capture-git.test.ts` for trusted baseline/object-format pinning before editor changes, private index/object output outside the agent mount, read-only trusted original object alternates, unchanged original index/refs/objects/config, and idempotent manifest cleanup after partial capture preparation; prove ordinary workspace creation still produces no capture scratch
- [x] T007 Add opt-in capture preparation and manifest-scoped scratch disposal to `packages/flowproof/src/editing/workspace.ts` using `packages/flowproof/src/editing/captureGit.ts`; satisfy "Created only for opt-in capture; cleaned as part of workspace state, not a new lifecycle category", match the source object format, and never place the original object path or private Git locator inside the agent clone/task/result

**Checkpoint**: Contract and private Git/workspace primitives pass their focused tests. No public session captures files yet.

---

## Phase 3: User Story 1 — Receive the Agent's Actual Changes (Priority: P1)

**Goal**: Derive a portable main-repository change set from the final filesystem against the pinned baseline, not model text, final HEAD, or staged blob contents.

**Independent Test**: `pnpm exec vitest run tests/integration/editing-capture-git.test.ts` compares an independently expected state with capture across text/binary additions, modifications, deletions, moves, modes, link/gitlink records, staged subsets, local commits, ignored output, and no-change cases. Test-scratch reconstruction proves artifact fidelity only; it is not production fresh-worktree verification.

### Tests First

- [x] T008 [US1] Add failing Git-fidelity cases to `tests/integration/editing-capture-git.test.ts` for text/binary add/modify/delete, rename-as-delete/add, executable-bit changes, empty files, missing final newline, non-ASCII and non-UTF-8 filename bytes, partially staged files, editor HEAD changes/local commits, force-tracked ignored additions, ordinary ignored untracked outputs, tracked changes under ignore rules, and unchanged/reverted edits; independently compare reconstructed file bytes, modes, paths, baseline identity, and exact changed-file membership

### Implementation and Link-Semantics Proof

- [x] T009 [US1] Build the private final tree and matching raw summary/full-index binary patch in `packages/flowproof/src/editing/captureGit.ts`: seed from the pinned baseline, read only contained final-index path metadata, force-refresh existing final tracked paths without trusting staged blob contents, then apply ordinary Git add/ignore semantics; use literal NUL-delimited pathspecs, skip empty force-add input, preserve baseline deletions, and disable external diff/text conversion and custom filter commands
- [x] T010 [US1] Add failing link/attribute/control-metadata cases to `tests/integration/editing-capture-git.test.ts` for symlink target text without reading an external sentinel, gitlink add/change/delete and unchanged dirty nested worktrees, contained versus external nested Git-directory pointers, editor-replaced `.git`/index pointers, excluded repository metadata, built-in EOL normalization, and marker-producing local hooks/clean/process filters that must never execute on the host
- [x] T011 [US1] Implement narrow no-follow completeness traversal and contained index/nested-Git-pointer checks in `packages/flowproof/src/editing/captureGit.ts`; prune ignored untracked directories but not baseline/final-index tracked paths, stop at nested repositories without inspecting their worktree contents, detect eligible Git-unrepresentable special entries rather than silently dropping them, and record fixed reference-only coverage whenever the baseline or final tree has gitlinks, including `no_changes`
- [x] T012 [US1] Assemble candidate snapshots and explicit no-change results in `packages/flowproof/src/editing/capture.ts` from the same final tree and diff: include `sessionId`, full trusted `baselineCommit`, binary-safe `patch`, ordered raw-relative-path `files`, operation/modes/object IDs/byte lengths where applicable, and `coverage`; implement "Copy retained byte buffers at the ownership boundary" and verify caller mutation cannot change a retained snapshot through an alias in `tests/unit/editing-capture.test.ts`

**Checkpoint**: Internal extraction proves US1/SC-001. Candidate release still requires US2 checks and US3 lifecycle/cleanup integration; this checkpoint is not merge-ready or a `Verified Fix`.

---

## Phase 4: User Story 2 — Understand Why Capture Was Rejected (Priority: P1)

**Goal**: Return a complete checked candidate or an accurate safe reason, never a filtered/redacted/truncated patch or a model retry.

**Independent Test**: Focused unit/Git tests seed sensitive bytes in names and old/new text/binary blobs, inject unrepresentable entries/read failures/limit exhaustion/interruption, and assert the exact outcome class, zero partial candidate bytes, safe fixed explanations, and zero feedback/model/retry calls.

### Tests First and Implementation

- [x] T013 [US2] Add failing secret-surface cases to `tests/integration/editing-capture-git.test.ts` for seeded markers in added/removed text, raw old/new binary blobs hidden by patch encoding, and raw filename bytes; add UTF-8 text-versus-binary dispatch and no-leaking-reason tests to `tests/unit/editing-capture.test.ts`, using synthetic credential patterns assembled from fragments so fixtures do not create secret-scanner false positives in commit history
- [x] T014 [US2] Reuse the injected trusted `SecretScanner` in `packages/flowproof/src/editing/capture.ts` to check raw old/new changed blobs, path bytes, and exposed diff/summary surfaces before release; dispatch valid UTF-8 NUL-free bytes as text and other bytes as binary, keep gitlink OIDs reference-only, reject with `SENSITIVE_DATA` without exposing scanner finding paths or redacting the patch, and preserve the existing seeded-marker-only binary limitation
- [x] T015 [US2] Add failing completeness/error cases to `tests/integration/editing-capture-git.test.ts` and `tests/unit/editing-capture.test.ts` for eligible FIFO/special entries versus ignored untracked output, operational file/Git/preparation errors, cumulative metadata/patch/raw-payload/stdout/stderr budget exhaustion, total capture deadline, cancellation, and unsafe stderr/exception content; assert accurate rejected/failed/no-change distinctions, no candidate fragments, bounded reasons, and joined capture-owned children
- [x] T016 [US2] Complete whole-candidate admission and fixed reason mapping in `packages/flowproof/src/editing/capture.ts` and `packages/flowproof/src/editing/captureGit.ts`: use `UNREPRESENTABLE_ENTRY`, `SENSITIVE_DATA`, and `CAPTURE_LIMIT` for known rejection, `CAPTURE_IO_FAILED` for operational/preparation failure, and `CAPTURE_INTERRUPTED` for interrupted capture; share one deadline/materialization budget across traversal, Git metadata/patch, and raw payload checks, discard all partial output, and add no retry/model call or configurable multi-axis policy

**Checkpoint**: Internal capture satisfies US1 and US2 together, including SC-002/SC-003; final session release still requires the next phase.

---

## Phase 5: User Story 3 — Finish Without Changing the Original Repository (Priority: P2)

**Goal**: Capture only a proven stopped successful editor before disposal; resolve with distinct capture/execution/cleanup facts and preserve existing callers and production behavior.

**Independent Test**: Fake-backed tests fix terminal/cancellation ordering; Docker-backed `tests/integration/editing-capture-session.test.ts` proves actual success-only capture, workspace-view admission, original snapshot integrity, and removal of only the exact owned container/volumes/workspace/private scratch. Existing lifecycle suites remain unchanged in meaning.

### Tests First and Implementation

- [x] T017 [P] [US3] Add failing capture-session lifecycle cases to `tests/unit/editing-capture.test.ts` for synchronous invalid-request/dependency rejection before side effects, exactly-once capture after inspected started/stopped/no-start-error/exit-zero success, attach-only exit and all non-success skips with `EDITOR_NOT_SUCCESSFUL`, cancellation before/during/after capture, capture-preparation/capture exceptions followed by cleanup, and completed capture alongside explicit cleanup/integrity failure; preserve the old handle/result and execution history
- [x] T018 [P] [US3] Write failing root-bind and obscuring-descendant-mount checks in `tests/unit/editing-docker-cli.test.ts`, then implement the narrow exact-container workspace-view operation in `packages/flowproof/src/editing/dockerCli.ts` and update `tests/support/editingFakes.ts`; validate the expected `/workspace` source, reject unproved/obscured views as `WORKSPACE_VIEW_UNAVAILABLE` in capture mode only, and do not add volume export or alter lifecycle-only runtime admission
- [x] T019 [US3] Write failing real-session cases in `tests/integration/editing-capture-session.test.ts` using the existing credential-free fixture and ownership helpers: successful exact diff, unchanged result, sensitive rejection, edits followed by failure/timeout/cancel, inspected termination, a disposable nested-volume image/view rejection, and original-checkout snapshots; include owned-container/anonymous-volume/private-root/process residue assertions and exact cleanup of all test-created images/resources
- [x] T020 [US3] Add `startCapturingEditingSession()` with required trusted scanner and the existing request/handle/cancel style in `packages/flowproof/src/editing/session.ts`; share a private concrete runner, prepare trusted capture state before launch, capture once only after inspected editor success/view proof and before disposal, settle capture exceptions as safe data, join aborted capture processes before cleanup, and resolve `{ session, capture }` after existing cleanup/integrity attempts without changing `startEditingSession()` or introducing a callback framework
- [x] T021 [US3] Complete cleanup/integrity and compatibility regressions in `tests/integration/editing-capture-session.test.ts` and `tests/contract/editing-capture-contract.test.ts`: inject capture-scratch disposal and original-integrity failures, preserve a completed candidate alongside explicit cleanup failure rather than a clean-success claim, prove owned scratch is accounted for under existing cleanup categories, and run `tests/integration/editing-session.test.ts`, `tests/integration/editing-session-cleanup.test.ts`, and `tests/contract/editing-session-contract.test.ts` without adding capture fields or file inspection to lifecycle-only callers

**Checkpoint**: All three stories work through the opt-in entry point. Existing Hero/Failure wiring, live-provider authentication, fresh-baseline verification, and automatic repair remain untouched.

---

## Phase 6: Polish & Cross-Cutting Verification

**Purpose**: Document the actual capability/limits and verify the complete approved slice; no speculative cleanup, optimization, or new product surface.

- [x] T022 Update `README.md` and `specs/003-capture-editing-candidate/quickstart.md` to describe the opt-in capture API, statuses/safe reasons, single fixed time/byte ceilings, binary scanner/custom-filter limitations, reference-only nested-worktree coverage, and separate cleanup facts; explicitly retain the capture-not-verification and future-agent/repair non-goals, and replace planned-only statements only where implementation evidence exists
- [x] T023 Execute the focused and repository regression gates in `specs/003-capture-editing-candidate/quickstart.md`, verify actual discovery of all four new test files, use existing exact-owner residue checks in `tests/support/editingRuntime.ts`, and record discovered/passed/skipped counts and any gaps in `specs/003-capture-editing-candidate/tasks.md`; include typecheck, build, full Vitest, Playwright, original integrity and `git diff --check`, without global Docker prune or credential-gated live-model smoke

**Named checkpoint — Capture-only ready**: T001–T023 and all slice gates are complete with evidence. Only this named checkpoint is the delivery-slice boundary. Stop and report; push, PR creation, and merge remain separate authorized actions.

---

## Delivery Slices

The approved one-PR scope is retained. Phases above are internal implementation checkpoints inside this single named delivery slice, consistent with the Plan and the preceding Spec 002 workflow. They are not extra PRs to merge in isolation.

| Order | Named checkpoint | Tasks | Required validation |
| --- | --- | --- | --- |
| 1 | Capture-only ready (Phases 1–6) | T001–T023 | Four-file discovery check below; focused capture suites; legacy editing suites; `pnpm typecheck`; `pnpm build`; serialized `pnpm test`; `pnpm exec playwright test --pass-with-no-tests`; exact owned-resource residue and original-integrity checks; `git diff --check` |

Implementation was authorized with the exact scope `only execute tasks T001-T023, then stop`. The capture-only ready checkpoint is complete; this does not authorize push, PR creation, or merge.

### Gate commands

```bash
test -f tests/contract/editing-capture-contract.test.ts
test -f tests/unit/editing-capture.test.ts
test -f tests/integration/editing-capture-git.test.ts
test -f tests/integration/editing-capture-session.test.ts
pnpm exec vitest run tests/contract/editing-capture-contract.test.ts tests/unit/editing-capture.test.ts tests/integration/editing-capture-git.test.ts tests/integration/editing-capture-session.test.ts
pnpm exec vitest run tests/unit/editing-docker-cli.test.ts tests/contract/editing-session-contract.test.ts tests/integration/editing-session.test.ts tests/integration/editing-session-cleanup.test.ts tests/integration/worktree.test.ts
pnpm typecheck
pnpm build
pnpm test --no-file-parallelism --maxWorkers=1
pnpm exec playwright test --pass-with-no-tests
git diff --check
```

Use the prepared display/Xvfb environment where required. Every named capture suite must execute tests; `passWithNoTests` must never be mistaken for proof. Record Docker/session residue assertions from the tests, not a blanket unscoped daemon cleanup. No login, live provider, or human-operated gate is required by this slice.

---

## Dependencies & Execution Order

- Phase 1 prepares the real editor scenarios. Phase 2 establishes the contract, runner, and opt-in scratch; T003 follows T002, T005 follows T004, and T007 follows T005/T006.
- US1 depends on Phase 2. T009 follows T008; T011 follows T009/T010; T012 follows T011. Gitlink/control-pointer/no-follow handling is part of correct capture, not a new source-file allowlist.
- US2 depends on the US1 extraction internals. T014 follows T013; T016 follows T014/T015. Tests first cover the applicable scanner and exact failure categories before any session can release a candidate.
- US3 depends on checked capture from US1/US2. T017 and T018 can proceed independently in their listed files; T019 follows both, T020 follows T019, and T021 validates the completed integration. The capture-owned child-join proof from Phase 2/US2 is required before disposal.
- Phase 6 follows all stories. Documentation follows implemented behavior; the final gate runs on the complete slice.
- Stories are independently testable at their respective internal layer, but are deliberately **not** independently mergeable: shipping unchecked extraction or skipping cleanup is not the approved MVP.

### Parallel Opportunities and Examples

The shared capture modules and new Git/unit suites require sequential edits; do not label overlapping writes as parallel merely because they have different task IDs.

- **US1**: Within T008, text/binary/mode fixtures may run independently in separate temporary repositories; T010 link/filter fixtures similarly isolate repository state. Implementation T009/T011/T012 remains sequential.
- **US2**: Within T013, added/deleted binary-marker and filename-marker fixtures may execute concurrently only in separate private repositories. Scanner dispatch and admission implementation T014/T016 remain sequential.
- **US3**: T017 changes `tests/unit/editing-capture.test.ts`; T018 changes Docker-view tests/adapter and `tests/support/editingFakes.ts`. They can be developed independently after US2, with T017 keeping test-specific mocks local until T018's shared fake operation exists. Both must finish before T019/T020 integration.

These are task/test-runner scheduling opportunities, not authorization for parallel agents. Avoid concurrent real-Docker jobs sharing mutable image tags or temporary roots; reuse the existing per-worker ownership helpers.

## Requirement and Acceptance Traceability

| Requirement | Tasks | Observable proof |
| --- | --- | --- |
| FR-001 | T006–T009, T012, T019–T020 | Pinned baseline/session; final filesystem not final HEAD/staged bytes; matching complete patch/summary |
| FR-002 | T008–T012 | Git-native binary/move/mode/link/reference fidelity without a file/extension permission list |
| FR-003 | T004–T007, T010–T011, T018–T021 | Private writes, no external traversal/project commands/control-metadata export, original snapshot unchanged |
| FR-004 | T004–T005, T011, T013–T016, T018 | Whole-candidate admission, shared finite budget, applicable raw-byte checks, accurate read failures |
| FR-005 | T002–T003, T013–T016, T018, T020 | Seven stable safe reason codes; no secret/host locator or automatic feedback loop |
| FR-006 | T008, T012, T017, T019–T020 | Successful stopped editor only, before disposal, explicit no-change outcome |
| FR-007 | T006–T007, T017, T019–T021, T023 | Every terminal path attempts existing cleanup/integrity; distinct failures and zero owned residue on successful cleanup |
| FR-008 | T002–T003, T017, T020–T023 | Legacy strict contract/Hero/Failure regression and capture-only non-goals preserved |
| SC-001 | T008–T012, T019 | Independent expected bytes/modes/paths and reference-only coverage |
| SC-002 | T012–T017, T019 | No-change/rejection/error accuracy, zero partial candidate or retry/model calls |
| SC-003 | T013–T014, T019 | Raw old/new binary/text/path seeds absent from candidates and diagnostics |
| SC-004 | T004–T007, T015–T021, T023 | Success-only extraction, joined children, owned cleanup, unchanged original, injected failure reporting |
| SC-005 | T002, T017, T020–T023 | Existing lifecycle/production results unchanged; no capture-only verified verdict |

## Implementation Strategy

1. Complete Setup and Foundational tasks without adding an unused service or dependency.
2. Prove Git-native extraction (US1), then whole-candidate admission/reasons (US2) before release wiring.
3. Integrate the concrete opt-in session with existing termination/cleanup behavior (US3).
4. Complete documentation and actual regression/residue proof, then stop at **Capture-only ready**.

The minimal usable deliverable includes all three stories: actual changes, honest rejection, and cleanup are one approved capability. No separate speculative MVP, future feedback controller, fresh-worktree verifier, live model integration, or UI is added. Every task stays unchecked until its evidence exists; commit small reviewable implementation/test units within the one approved feature PR.

## Validation Evidence

- Tasks-generation checks (2026-11-02): 23 sequential unchecked IDs; story labels/file paths/template placeholders/fences valid; FR-001–FR-008 and SC-001–SC-005 mapped (13/13); existing paths and six planned capture source/test paths verified against Plan; no unplanned dependency or service. These are document checks, not implementation evidence.
- Implementation evidence (2026-11-02): the deterministic fixture includes capture success, revert, seeded/credential-shaped sensitive changes, and nonzero/cancel-after-edit scenarios. The four capture suites were all discovered and executed: contract + unit, 2 files / 99 tests passed; Git capture, 1 file / 36 passed; session integration, 1 file / 10 passed. Focused Docker-view tests passed 73/73. New regression cases cover byte-safe non-ASCII nested-repository paths, external `.git` pointer rejection, dirty nested worktree reference-only behavior, and linked nested Git metadata rejection.
- Legacy compatibility evidence: editing lifecycle/cleanup integration passed 21/21; old lifecycle plus capture contract suites passed 206/206. Capture session integration verified original synthetic-repository snapshots and exact owned container, anonymous-volume, workspace, private-scratch, and process cleanup. The tests left no FlowProof-labeled containers, fixture images, or `flowproof-editing-tmp-*` roots; no global Docker prune was used.
- Repository gates: `pnpm typecheck` passed; `pnpm build` passed; `pnpm test --no-file-parallelism --maxWorkers=1` passed 43/43 files and 1269/1269 tests (0 skipped); `pnpm exec playwright test --pass-with-no-tests` passed 8/8 (0 skipped); `git diff --check` passed after final documentation/task updates. No credential-gated live-model smoke was run or required.
- Extension hooks: `before_implement` and `after_implement` register only the optional Git commit hook; `auto_commit.default` and the implementation-specific setting are disabled. Automatic hooks were skipped; implementation units and documentation were reviewed and committed manually.
- Owner-only manual gates: **none** in the approved capture-only scope.
- Publication: no push, PR, or merge was performed or authorized; the local feature branch and commits are preserved.
