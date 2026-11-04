# Parallel Implementation Dispatch: Spec 006

**Status**: Scheduling only, requested by the owner on 2026-11-04. No implementation task has run.
**Delivery**: One named delivery slice, I6 / T001–T055, as recorded in [tasks.md](tasks.md).
**Scope**: Real project -> direct demonstration -> real image/code analysis -> derived reproduction
-> intended baseline failure -> one actual correction -> identical independent verification -> review.
No model/capture/verification obligation is postponed to another release. I1–I5 are internal checkpoints,
not separate owner approval gates. This schedule does not authorize publishing, merging or deployment.

## Four Active Lanes, Including the Coordinator

| Lane | Responsibility | Exclusive source ownership |
| --- | --- | --- |
| I | Integration, UI, shared contracts, store/lifecycle and final acceptance | `project/contracts.ts`, `project/run.ts`, `evidence/projectStore.ts`, `cli.ts`, `studio/targetApp.ts`, `studio/launch.ts`, `studio/server.ts`; all `apps/studio/src/` changes; root test discovery/configuration; feature docs and task marks |
| A | Project admission, immutable runtime and candidate patch | `project/{admission,snapshot,profile,runtime}.ts`, `patch/projectDiff.ts`; `tools/runtime/project-vite.Dockerfile`, `tools/runtime/prepare-project-vite.mjs`; sample fixtures/helper |
| B | Privacy and recording | `capture/projectPrivacy.ts`, `capture/projectRecorder.ts`; capture/privacy/recording tests |
| C | Actual provider adapter and replay module | `model/projectPrompt.ts`, `model/projectClient.ts`, `verify/projectReplay.ts` through T037; provider/replay tests |

Package source paths above are relative to `packages/flowproof/src/`. Each task's test paths remain
those in [tasks.md](tasks.md); the owner column below assigns their sole writer. Existing regression
files and all new paths not explicitly delegated remain I-owned. No worker changes a shared file,
dependency manifest, global configuration or another lane's tests to make its own checks pass.

### Shared-File Handoffs

- I publishes the tested T005 contract exports and T007/T009 boundaries before story-module dispatch:
  parameter/result types, exact enums, identities/digests, cancellation/cleanup ownership, safe artifact
  references, and failure shapes. Use the existing design contracts, not invented task-local schemas.
  Interface corrections return to I; I updates and communicates the change before affected work resumes.
- B hands off the tested T024 privacy interface before C starts T027. C may write T023/T034/T037
  while waiting. Recorder integration still needs the real admitted target; a fake page proves only units.
- **Replay transfer**: C completes and hands off T037 plus its focused test/evidence and file revision,
  including ownership of `tests/unit/project-replay.test.ts` originally written in T034.
  I then becomes the sole writer of that test and `verify/projectReplay.ts` for T038/T040 and owns their `run.ts`
  changes as well. C continues only its model files/tests. No partial task or dual-writer split is hidden.
  If C must fix replay after transfer, I suspends its edits and explicitly loans ownership back first.
- T022/T026 belong to B. Once T026 is handed off, B stops editing its browser tests; I may extend
  `tests/e2e/project-privacy.spec.ts` for T050. T046 is entirely I-owned (both server and store).
  `DemonstrationPanel.tsx` remains I-owned across T030/T042; result/diff components remain I-owned.

## Ready-Queue Matrix

Each of the 55 task IDs appears exactly once. `—` means no task predecessor, not permission to skip
design reads or implementation authorization. An edge means the predecessor is verified and handed
off, not merely started. Where earlier prose used a whole-story barrier, these module-level edges
refine it; all explicit task dependencies and security/acceptance gates remain mandatory.
`T005/T007/T009` are the common story-module foundation gate. Resourceful test authoring can start
before modules exist, but a checkbox requires the task's actual failure/pass evidence, not a test file.

| Task | Owner | Required predecessors |
| --- | --- | --- |
| T001 | A | — |
| T002 | A | T001 |
| T003 | I | — |
| T004 | I | — |
| T005 | I | T004 |
| T006 | I | — |
| T007 | I | T005, T006 |
| T008 | I | — |
| T009 | I | T005, T008 |
| T010 | A | T005, T007, T009 |
| T011 | A | T005, T007, T009 |
| T012 | A | T005, T007, T009 |
| T013 | I | T005, T007, T009 |
| T014 | A | T010 |
| T015 | A | T014 |
| T016 | A | T002, T005, T010 |
| T017 | A | T011, T015, T016 |
| T018 | I | T012, T017 |
| T019 | I | T013, T014, T015, T016, T017, T018 |
| T020 | I | T019 |
| T021 | B | T005, T007, T009 |
| T022 | B | T005, T007, T009 |
| T023 | C | T005, T007, T009 |
| T024 | B | T022 |
| T025 | B | T021, T024 |
| T026 | B | T018, T025 |
| T027 | C | T023, T024 |
| T028 | C | T023, T027 |
| T029 | I | T019, T025, T028 |
| T030 | I | T029 |
| T031 | C | T003, T028 |
| T032 | I | T029, T030 |
| T033 | I | T026, T027, T028, T029, T030, T031, T032 |
| T034 | C | T005, T007, T009 |
| T035 | A | T005, T007, T009 |
| T036 | I | T005, T007, T009 |
| T037 | C | T034 |
| T038 | I | T036, T037, T017, T018, T029 |
| T039 | A | T035, T015 |
| T040 | I | T038, T039 |
| T041 | I | T028, T038, T040 |
| T042 | I | T030, T041 |
| T043 | I | T033, T042 |
| T044 | I | T005, T007, T009 |
| T045 | I | T044, T041, T042 |
| T046 | I | T007, T039, T044 |
| T047 | I | T045, T046 |
| T048 | I | T047 |
| T049 | I | T047 |
| T050 | I | T020, T026, T032, T033, T043, T048, T049 |
| T051 | I | T048, T049 |
| T052 | I | T050, T051 |
| T053 | I | T031, T043, T052 |
| T054 | I | T048, T052 |
| T055 | I | T052, T053, T054 |

T031 implements the opt-in protocol test; it does not call the provider at module handoff.
T053 executes both actual protocol and full-live gates after final regression. T054 may share that
human live session; if the owner is unavailable, leave it open rather than inventing acceptance.

## Dispatch Waves and Integration Boundaries

These are ready queues within the same delivery slice, not new sequential releases. Start a task
as soon as its matrix dependencies and exclusive ownership permit; do not wait for a whole wave.

1. **Bootstrap overlap:** A prepares T001 -> T002. I handles T003 and the contract/store/lifecycle
   tests/implementations T004–T009. Image work does not block resource-free foundation work.
2. **Three module lanes:** After the foundation gate, A handles admission/runtime tests and modules;
   B handles T021/T022 -> T024 -> T025; C handles T023, T034 -> T037, then T027 -> T028/T031 when
   privacy is ready. I writes T013/T036/T044 and integrates T018/T019 once the real runtime is ready.
   A can implement T035/T039 after snapshot T015 without waiting for all analysis UI work.
3. **Rolling joins:** I connects T029/T030 as soon as target, capture and model modules are ready,
   then T038/T040/T041/T042 and result routes/UI. B runs T026 when the target/resource lease is ready;
   C hands off the replay file; A hands off guarded patches. No all-lanes-idle barrier is needed.
4. **Final acceptance:** I closes remaining negative cases/documentation, runs V1 at T052, then
   actual V2/T053 and untimed V3/T054, and records T055. Module passes never imply live acceptance.

### Resource Lease and Commit Protocol

- Use one shared integration checkout with disjoint write allowlists. I alone stages/commits, installs
  dependencies, changes shared configuration or updates `tasks.md`. Workers report exact changed paths,
  checks/results, unexecuted gates and dependency/file revision; they do not use `git add .` or reset peers.
  I commits only a coherent handed-off unit after its relevant checks, using explicit paths. Temporary
  uncommitted work in another lane must not be included or described as verified by that commit.
- Resource-free focused checks may overlap. I issues one exclusive lease for Docker image preparation,
  container-backed checks, headed-browser tests, whole-repository build/typecheck/default suites or live
  execution. A lease includes owned ports/containers/output root and release/cleanup evidence. A worker
  needing that resource reports readiness; it does not start a competing suite. Build/test outputs must
  not be shared concurrently. Keep CPU/memory limits unchanged.
- Before repo-wide validation, pause code writers, receive all handoffs, review/commit the intended
  implementation, and record its exact HEAD. Final/live evidence must refer to that same implementation.
  Later source changes invalidate affected acceptance and require appropriate revalidation.
- Source/import changes in a dependency can invalidate a worker result; recheck the affected boundary,
  not every unrelated suite. Missing image, actual provider failure or owner-only feedback blocks only
  dependent completion; unrelated already-authorized ready work can continue.

## Worker Dispatch Template

> Execute only lane `<I|A|B|C>` ready tasks in delivery slice I6 / T001–T055 after implementation is
> authorized. Read repository instructions and feature contracts. Follow the matrix, exact write
> allowlist and resource lease. Write meaningful high-risk tests before their implementation. Do not
> edit shared files, task marks, other workers' work or Git state; request an ownership handoff instead.
> Return task IDs, changed files, dependency/file revisions, actual verification, resource cleanup and
> remaining gaps. No provider call before final live acceptance; no publication/merge/deploy.

This is an execution handoff, not a formal `speckit-analyze` result. Run the recommended read-only
consistency stage separately and resolve any critical/high/Constitution findings before implementation.
