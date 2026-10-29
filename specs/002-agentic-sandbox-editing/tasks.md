---

description: "Implementation tasks for the isolated agent editing runtime"
---

# Tasks: Isolated Agent Editing Runtime

**Input**: Design documents from `/specs/002-agentic-sandbox-editing/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/editing-session.md`, `quickstart.md`

**Tests**: Required. The Plan mandates test-first coverage for lifecycle transitions, Docker argv, request/result contracts, sanitization, cancellation races, idempotent cleanup, and Docker-backed containment.

**Organization**: Tasks are grouped by user story. All phases belong to one delivery slice and one pull request; phase checkpoints control implementation order without creating additional pull requests.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it changes different files and has no dependency on an incomplete task.
- **[Story]**: Maps the task to a user story in `spec.md`.
- Every task names the exact file or directory it changes.

## Phase 1: Setup (Synthetic Runtime Fixture)

**Purpose**: Create the credential-free deterministic runtime used by every automated story test.

- [X] T001 Create the non-root deterministic editing-agent image and fixed `/run/flowproof/task.json` entrypoint in `tests/fixtures/editing-agent/Dockerfile` and `tests/fixtures/editing-agent/agent.mjs`
- [X] T002 [P] Create the synthetic three-file project and declared project command used by the fixture agent in `tests/fixtures/editing-agent/project/`
- [X] T003 Add Docker image build, immutable image-ID resolution, private temporary-root, container-residue, and process-residue helpers in `tests/support/editingRuntime.ts`

**Checkpoint**: The fixture can be built locally without provider credentials, but no production runtime path exists yet.

---

## Phase 2: Foundational (Trusted Contracts and Adapters)

**Purpose**: Establish the shared contracts, Git safety primitives, runtime-profile registry, and shell-free Docker adapter that block every user story.

**Critical**: No user-story implementation begins until this phase is complete.

- [X] T004 Write failing request, runtime-profile, result-shape, and no-candidate-field contract tests in `tests/contract/editing-session-contract.test.ts`; prove `declaredProjectCommands` is bounded task context rather than an allowlist, every omitted resource field resolves to the documented default, exact minima/maxima pass, narrowed profile bounds stay ordered inside global bounds, and below-minimum, above-maximum, non-finite, fractional-integer, non-whole-second stop-grace, or string-coerced values fail before side effects
- [X] T005 Implement immutable editing request, session handle, v1 resource-bound constants/default resolution, runtime profile, execution outcome, and cleanup result types and validation in `packages/flowproof/src/editing/contracts.ts`; preserve the exact enums `completed|failed|timed_out|cancelled|startup_failed` and `complete|recovered|failed`, require bounded non-empty task text and command-context arrays, allow profiles only to narrow the global limits, and reject raw image, Docker flag, mount, network, shell, credential, and invalid limit input
- [X] T006 Write failing registry tests for stable profile IDs, immutable `name@sha256:...` or `sha256:...` image references, non-empty direct argv, literal `/workspace`, a fixed non-secret environment allowlist, and ordered profile min/default/max limits that may narrow but never widen the global v1 bounds in `tests/unit/editing-runtime-profile.test.ts`
- [X] T007 Implement trusted in-process profile registration and resolution, including profile-bound validation and resolved request defaults, without inherited host environment or credential seams in `packages/flowproof/src/editing/runtimeProfile.ts`
- [X] T008 Add regression coverage for shell-free Git execution and complete original-repository snapshot comparison before extracting shared code in `tests/integration/worktree.test.ts`
- [X] T009 Extract the bounded Git runner, disabled hooks/global config, tracked-file hashing, and complete repository snapshot/compare primitives into `packages/flowproof/src/git/repositoryState.ts`, then reuse them from `packages/flowproof/src/worktree/session.ts`
- [X] T010 Write failing Docker argv and capability-preflight tests covering immutable images, exact labels, non-root user, read-only root, `cap-drop=ALL`, `no-new-privileges`, default seccomp, optional LSM observation, exact resolved default/minimum/maximum resource argv, equal memory-swap and memory limits, bounded tmpfs, bridge-only networking, no published ports, and rejection of caller-controlled flags or mounts in `tests/unit/editing-docker-cli.test.ts`
- [X] T011 Implement bounded shell-free `docker create`, `start --attach`, `stop`, `inspect`, and exact-ID `rm -f` operations using only validated resolved limits, plus capability preflight, in `packages/flowproof/src/editing/dockerCli.ts`

**Checkpoint**: Trusted inputs and adapters are independently tested; no session lifecycle is wired yet.

---

## Phase 3: User Story 1 - Run an Agent in an Isolated Project Copy (Priority: P1) - MVP

**Goal**: Run the deterministic agent at an exact commit in a standalone clone, allow multi-file edits, one declared project command, and one public fetch, then clean up while leaving the original repository unchanged.

**Independent Test**: `pnpm exec vitest run tests/integration/editing-session.test.ts -t "completes an isolated editing session"` builds the fixture image, edits at least three files, executes the declared project command, fetches one public resource, returns `completed`, and proves the original snapshot is unchanged after cleanup.

### Tests for User Story 1

- [X] T012 [US1] Write the failing exact-revision, fixture-self-verified three-file edit, task-document, declared-command, public-fetch, and original-repository-integrity success scenario in `tests/integration/editing-session.test.ts`
- [X] T013 [US1] Add failing standalone-clone tests for `--no-hardlinks`, detached exact commit, removed remote, absent alternates/source paths, fixed read-only task document, and exact created-path cleanup manifest in `tests/integration/editing-session.test.ts`

### Implementation for User Story 1

- [X] T014 [US1] Implement OS-temporary standalone clone preparation, exact detached checkout, remote/alternate/source-path scrubbing, bounded `task.json`, and manifest-scoped workspace disposal in `packages/flowproof/src/editing/workspace.ts`
- [X] T015 [US1] Implement `startEditingSession()` and the success-path lifecycle from request validation through container attachment, cleanup, integrity comparison, and one final result promise in `packages/flowproof/src/editing/session.ts`; do not enumerate, open, or analyze agent-authored workspace contents or expose a pre-cleanup inspection hook
- [X] T016 [US1] Complete the success fixture assertions for self-verified three-file edits, immutable runtime summary, no original/home/Docker-socket mount, no provider credential, no workspace-content metadata in the result, and zero owned residue in `tests/integration/editing-session.test.ts`

**Checkpoint**: User Story 1 works independently and satisfies SC-001, SC-004, SC-006, and the successful portion of SC-003.

---

## Phase 4: User Story 2 - Stop and Clean Up Failed Sessions (Priority: P2)

**Goal**: Make failure, timeout, cancellation, startup failure, descendant processes, and interrupted cleanup deterministic, idempotent, and exact-resource scoped.

**Independent Test**: `pnpm exec vitest run tests/integration/editing-session-cleanup.test.ts` exercises every prepared terminal path and proves the execution cause, cleanup status, original repository, unrelated workspaces/containers, and no-residue invariants.

### Tests for User Story 2

- [X] T017 [US2] Write failing first-terminal-cause, late-cancel, repeated-cancel, repeated-finalization, and legal lifecycle-transition tests in `tests/unit/editing-session-state.test.ts`
- [X] T018 [US2] Write failing Docker-backed cases for non-zero exit, startup failure, timeout, explicit cancellation, cancellation/completion race, child processes, repeated cleanup, and transient cleanup interruption in `tests/integration/editing-session-cleanup.test.ts`
- [X] T019 [US2] Write failing unit cases for persistent cleanup failure preserving the execution outcome while reporting the exact remaining `container|task_document|workspace|original_repository` category in `tests/unit/editing-session-state.test.ts`

### Implementation for User Story 2

- [X] T020 [US2] Implement atomic first-terminal-cause selection, bounded timeout, idempotent `cancel()`, graceful stop, force removal, and shared finalization across pre-start, running, exited, cleaning, and completed states in `packages/flowproof/src/editing/session.ts`
- [X] T021 [US2] Implement exact-ID/container and created-path cleanup with bounded retry, `complete|recovered|failed` reporting, independent execution and cleanup outcomes, and protection for unrelated resources in `packages/flowproof/src/editing/session.ts` and `packages/flowproof/src/editing/workspace.ts`
- [X] T022 [US2] Complete Docker-backed assertions that every acceptance case removes owned containers, task documents, workspaces, and child processes while preserving the full original-repository snapshot and unrelated workspaces/containers in `tests/integration/editing-session-cleanup.test.ts`

**Checkpoint**: User Story 2 works independently after the foundation and satisfies SC-002, SC-003, and SC-004; persistent cleanup failure remains an explicit non-acceptance unit case.

---

## Phase 5: User Story 3 - Review a Safe Session Outcome (Priority: P3)

**Goal**: Return one stable, bounded, sanitized lifecycle result without raw logs, host paths, credentials, authoritative change data, candidate state, replay state, gates, or verification claims.

**Independent Test**: Focused contract, unit, and cleanup tests cover every execution/cleanup outcome, seed credentials and host paths into diagnostics, and assert the returned result is bounded, sanitized, and contains no candidate or verification field.

### Tests for User Story 3

- [X] T023 [US3] Extend result contract tests for exactly-once resolution, nullable exit code/signal, bounded duration/diagnostic, immutable runtime summary, cleanup proof, and absence of workspace path, file metadata, diff, file contents, transcript, raw output, host path, candidate, replay, gate, or verification fields in `tests/contract/editing-session-contract.test.ts`
- [X] T024 [P] [US3] Write failing diagnostic tests for fixed-size stdout/stderr capture, seeded credential markers, sensitive environment assignments, URL credentials/queries, and absolute session/source paths in `tests/unit/editing-session-state.test.ts`
- [X] T025 [US3] Implement bounded output capture, existing `sanitizeText` reuse, session/source path placeholders, stable coded Docker/Git failure messages, immutable result assembly, and exactly-once resolution in `packages/flowproof/src/editing/session.ts`
- [X] T026 [US3] Complete cross-outcome assertions that diagnostics contain zero seeded secrets or sensitive host paths and successful completion never creates candidate, replay, gate, or `Verified Fix` state in `tests/integration/editing-session-cleanup.test.ts`

**Checkpoint**: User Story 3 works independently after the foundation and satisfies SC-005 plus the result-contract portions of FR-007, FR-008, and FR-011.

---

## Phase 6: Polish and Cross-Cutting Verification

**Purpose**: Prove the complete one-PR slice and guard the unchanged production Hero/Failure path.

- [X] T027 [P] Add a regression assertion that the editing runtime is not imported or invoked by the production Hero/Failure flow in `tests/integration/provider-seam.test.ts`
- [X] T028 Run the focused contract/unit/integration commands and the fixture residue checks from `specs/002-agentic-sandbox-editing/quickstart.md`, fixing only defects within the approved feature files
- [X] T029 Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm exec playwright test --pass-with-no-tests`, and `git diff --check`, then record the actual pass/fail evidence by checking only the completed tasks in `specs/002-agentic-sandbox-editing/tasks.md`

**Checkpoint**: All requirements and success criteria are evidenced; no implementation task or human-only gate remains.

---

## Delivery Slices

| Order | Phase or checkpoint | Tasks | Validation |
| --- | --- | --- | --- |
| 1 | Complete isolated editing runtime (Phases 1-6) | T001-T029 | `pnpm exec vitest run tests/contract/editing-session-contract.test.ts tests/unit/editing-runtime-profile.test.ts tests/unit/editing-docker-cli.test.ts tests/unit/editing-session-state.test.ts tests/integration/editing-session.test.ts tests/integration/editing-session-cleanup.test.ts && pnpm typecheck && pnpm build && pnpm test && pnpm exec playwright test --pass-with-no-tests && git diff --check` |

This single delivery slice maps to the single pull request approved for Spec 002. Run `$speckit-implement` for T001-T029, validate, report, and stop before push or pull-request creation.

## Dependencies and Execution Order

### Phase Dependencies

- **Phase 1** has no dependency and provides the deterministic fixture.
- **Phase 2** depends on Phase 1 and blocks every user story.
- **Phase 3 / US1** depends on Phase 2 and proves the successful runtime path.
- **Phase 4 / US2** depends on Phase 3's working lifecycle and adds every stop/cleanup path.
- **Phase 5 / US3** depends on the stable lifecycle outcomes from Phases 3-4 and hardens the returned result.
- **Phase 6** depends on all user stories and closes the complete delivery slice.

### User Story Dependencies

- **US1 (P1)**: Starts after the shared foundation; no dependency on US2 or US3.
- **US2 (P2)**: Reuses US1's session/workspace boundary but is independently verified by its termination suite.
- **US3 (P3)**: Reuses all terminal outcomes but is independently verified by contract and sanitization assertions.

### Within Each User Story

- Write the listed tests first and verify that each new assertion fails for the missing behavior.
- Implement lower-level adapters before session orchestration.
- Keep execution outcome and cleanup outcome independent.
- Complete the story checkpoint before starting the next story.

## Requirement Traceability

| Requirement or criterion | Tasks |
| --- | --- |
| FR-001, FR-010, SC-004 | T008-T009, T012-T016, T018, T021-T022 |
| FR-002, FR-003, FR-004, SC-001, SC-006 | T001-T003, T006-T016 |
| FR-005, FR-006 | T004-T005, T010-T011, T017-T022 |
| FR-007, SC-002 | T004-T005, T017-T023, T025-T026 |
| FR-008, SC-005 | T004-T005, T023-T026 |
| FR-009, SC-003 | T018-T022 |
| FR-011, SC-007 | T004-T005, T023, T026-T029 |

## Parallel Opportunities

- T001 and T002 can run in parallel because the runtime image/entrypoint and synthetic project use different files.
- T006 and T008 can run in parallel after T004-T005 because they change independent profile and Git paths.
- T023 and T024 can run in parallel because they cover separate contract and diagnostic files.
- T027 can run in parallel with US3 implementation because it touches only the existing production-seam regression test.

## Parallel Example: User Story 3

```text
Task T023: Extend the stable result-shape contract in tests/contract/editing-session-contract.test.ts
Task T024: Add bounded diagnostic and sanitizer cases in tests/unit/editing-session-state.test.ts
```

## Implementation Strategy

### MVP First

1. Complete Phases 1-2.
2. Complete Phase 3 / US1.
3. Run the US1 independent test and inspect the original-repository and residue assertions.
4. Continue within the same approved delivery slice; US1 alone is not ready for production wiring or PR completion.

### Complete One-PR Slice

1. Add US2 termination and cleanup behavior.
2. Add US3 safe result behavior.
3. Run Phase 6 focused and repository-wide gates.
4. Stop after T029 and report before any push or pull-request action.

## Human-Only Verification

None. Docker capability checks, fixture execution, containment, cleanup, and all regression gates are automated on the prepared Linux development host.

## Notes

- `[P]` tasks operate on different files and have no dependency on unfinished implementation.
- Do not add provider authentication, host-side content enumeration or analysis, authoritative diff/change capture, candidate admission, replay, verification-container, Studio/CLI surface, or production Hero/Failure migration work.
- Do not claim private-network isolation: default bridge egress may reach host/LAN/private, link-local, or cloud-metadata services.
- Do not mark a task complete without the specified failing-first or passing verification evidence.
- Commit implementation in small reviewable units with its tests; the whole T001-T029 range remains one delivery slice and one pull request.
