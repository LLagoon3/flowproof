# Tasks: Studio Workspace UX and Core Design System

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [UI contract](./contracts/workspace-ui.md), and
[validation guide](./quickstart.md).

**Status**: Tasks prepared after owner approval of the Plan direction on 2026-11-03. Analyze corrections were authorized on 2026-11-03; no task
below is implemented or verified by documentation correction. Execution is one authorized slice at a time.

**Tests**: Required by the feature's state, accessibility, evidence and compatibility criteria.
Use test-first (RED then GREEN) regressions for risky product changes; the static design preview receives
browser checks, not a new test framework or tests that merely mirror its markup.

**Format**: `- [ ] TNNN [P?] [USn?] Description with exact file paths and requirement references`.
`[P]` denotes an optional independent-file opportunity, not permission to spawn workers or start
another slice. All future paths below are proposed until their implementation task is completed.

## Phase 1: Setup — Preview Scope and Review Material

**Goal**: Establish a small, portable preview boundary without changing the real application.

- [X] T001 Record the preview run instructions, allowed synthetic data, two modes, six SC-002 states and no-product-network constraint in `tests/manual/studio-design/README.md`; verify existing ignore rules without changing unrelated tooling (FR-003, FR-013).
- [X] T002 Define the seven-control-family (workspace shell, buttons, request field, tabs, status indicators, activity cards, disclosures) visual inventory and review/verification record structure in `specs/005-studio-workspace-ux/design-system.md`, distinguishing proposed values, measured checks and actual owner acceptance (FR-010, SC-007).

## Phase 2: Foundation — Isolated Clickable Design Preview

**Goal**: Review the entire proposed work-to-canvas experience before production UI replacement.
This checkpoint is a design foundation for all stories, not proof of any production story's completion.

- [X] T003 Build the labelled `Design preview — simulated data` canvas-first shell in `tests/manual/studio-design/index.html` and `tests/manual/studio-design/preview.css`, with left work panel, right larger canvas, light appearance, English copy and compact reflow; no live iframe or product endpoint (FR-001, FR-009-FR-012).
- [X] T004 Add mode/state switching, work-card disclosures, result and before/after examples, missing/unreadable evidence states, request draft and panel resize/collapse/restore in `tests/manual/studio-design/preview.js`; include the external updating collapsed-status/result entry, hidden compact-width separator and legacy target/evidence tab behavior; all actions alter synthetic presentation only (FR-002-FR-009).
- [X] T005 Measure browser rendering, keyboard/focus behavior, text/control contrast, the specified desktop matrix and separate native 200%-zoom procedure from `specs/005-studio-workspace-ux/quickstart.md`, plus compact layout for the preview in `tests/manual/studio-design/`; record observed outcomes and screenshot locations in `tests/manual/studio-design/README.md` (FR-011, FR-012, SC-005).
- [X] T006 Correct preview defects found by T005 in `tests/manual/studio-design/index.html`, `tests/manual/studio-design/preview.css` and `tests/manual/studio-design/preview.js`; rerun the affected checks and record the final proposed tokens/control states in `specs/005-studio-workspace-ux/design-system.md` (FR-010-FR-012).
- [X] T007 Serve the independent files using the portable instructions in `tests/manual/studio-design/README.md`, provide the owner a review location, and record the exact reviewed source revision; no production deployment or repository-specific hosted service is required (SC-007).
- [X] T008 Record the owner's actual hierarchy/density/balance decision and any revisions in `specs/005-studio-workspace-ux/design-system.md`; keep this unchecked while feedback is pending or negative, and do not start production UI replacement without accepted direction (SC-007).

**Checkpoint / slice 1**: Preview and review material only. No production or runtime files change.
Stop for the actual visual decision; preview screenshots are not verification evidence for real runs.

**Slice 1 record (2026-11-03)**: T001-T006 were implemented and mechanically verified at tested revision
`e80e291cc4425cf49089be46e4deb8819007ff03`: `node --check` and `git diff --check` passed, and
the 346 desktop/compact and 56 native-200%-zoom rendered checks had 0 failures. The record and the
ignored evidence location are in `tests/manual/studio-design/README.md`. T007 offers the unchanged
preview at that exact source revision through the owner-facing review location, with 219 independent
parent checks passing and the authenticated HTTPS render explicitly unverified. The owner rejected the first density on 2026-11-04, then accepted the minimalist revision
recorded below (T008). No T009 or later task has started.

**Minimalist revision record (2026-11-04)**: the owner requested correction of slice 1's visual
density, not production implementation. Tested clean revision
`eab7b55acbca3a14195218821fd6f80ed0991986` passed JS syntax, diff checks and 591 headless browser
checks with 0 failures; details and gaps are in the preview README. Native 200% zoom was not rerun.
The delivery owner independently passed 206 local Chromium checks and re-offered the unchanged
preview files at the existing review location, with authenticated HTTPS rendering unverified.
The owner accepted this revised UI as the direction on 2026-11-04 (T008), after the initial
rejection. Native 200% zoom remains unverified for the changed revision. T009+ remain untouched
and unauthorized. Push/PR creation and merge were not requested by this acceptance.

## Phase 3: User Story 1 — Canvas-First Real Workspace (P1)

**Goal**: Apply the accepted shell and core design vocabulary while preserving execution ownership.
**Independent test**: In both real modes, start the supported flow and resize/collapse/restore the
panel without losing a draft, run, frame identity, focus accessibility or selected evidence.

### Tests before risky integration

- [ ] T009 [US1] Add failing preservation and mode-boundary cases in `tests/ui/workspace-presentation.test.ts`, keeping current `tests/ui/state.test.ts` and `tests/ui/captured-verification.test.ts` acceptance assertions intact (FR-002, FR-003, FR-013).
- [ ] T010 [P] [US1] Add failing real-browser workspace cases in `tests/e2e/workspace-ux.spec.ts` for same iframe element/frame, no reload or duplicate start, pending reads through collapse, keyboard resize/restore, 100% viewport reflow, updating collapsed status/result access, and captured resize/collapse during guarded measurement against a matched control (same outcomes, screenshot dimensions and within-run evidence bindings); also author the opt-in `native-zoom-review` case with bounded acknowledgements and cleanup per quickstart for T015/T031; use native OS zoom, not a Playwright zoom API; use the existing harness rather than a second browser/runtime (FR-001, FR-002, FR-011-FR-013).

### Implementation and boundary verification

- [ ] T011 [US1] Implement `apps/studio/src/components/WorkspaceShell.tsx` and local workspace selection in `apps/studio/src/presentation.ts`: `panelWidthStep` is "one of seven integer width choices, default the 24rem choice" and `panelCollapsed` is "boolean; never means run cancellation or event unsubscription"; derive the external updating compact status/result restore entry only from existing authoritative state/selectors, never stream-end inference; hide/unfocus the width separator in stacked layout while retaining its width choice; no persistence or execution-reducer changes (FR-002).
- [ ] T012 [US1] Apply the accepted color/type/space/surface/focus rules and applicable control states in `apps/studio/src/styles.css`, referencing `specs/005-studio-workspace-ux/design-system.md`; bounded widths use self-hosted CSS classes, with no new dependency, external font or CSP exception (FR-010-FR-012).
- [ ] T013 [US1] Integrate the stable shell in `apps/studio/src/App.tsx` without alternate layout trees or target reparenting; keep the keyed live wrapper in `apps/studio/src/components/TargetPane.tsx` and mounted work/read owners intact through panel changes (FR-001, FR-002, FR-009, FR-013).
- [ ] T014 [US1] Adapt the existing case picker/request and fixed-candidate entry surfaces in `apps/studio/src/App.tsx`, `apps/studio/src/components/AgentPanel.tsx` and `apps/studio/src/components/CapturedVerification.tsx` to the shared controls; preserve bounded request, one-run admission and no-chat captured mode (FR-003, FR-005, FR-013).
- [ ] T015 [US1] Pass typecheck/build, UI tests and the new workspace browser cases using `specs/005-studio-workspace-ux/quickstart.md`; verify computed contrast/focus and actual 200% browser zoom rather than CSS or device-scale substitution (SC-004, SC-005).
- [ ] T016 [US1] Run the existing headed suites, including `tests/e2e/captured-verification.spec.ts`, under the current CSP; record exact revision, commands, results and remaining human-only SC-001 feedback in `specs/005-studio-workspace-ux/tasks.md` without claiming it passed (FR-013, SC-006).

**Checkpoint / slice 2**: The usable real shell is independently reviewable with the old work/result
presentation still functioning. Stop; do not incorporate the activity or evidence rewrite here.

## Phase 4: User Story 2 — Understand Observed Work (P1)

**Goal**: Readable work cards, faithful pending/finalizing/stream states, and stable reading position.
**Independent test**: Feed both modes' accepted event/result sequences to pure selectors and inspect
the panel in a browser, including disconnected activity, unavailable results and focused earlier work.

- [ ] T017 [US2] Add failing grouping/precedence cases in `tests/ui/workspace-presentation.test.ts`: ordered contiguous groups, exact observed finalizing markers and drift fallback; add a failing real-producer finalizing-card case in `tests/e2e/workspace-ux.spec.ts` before integration (passed in T021, not proved by copied strings alone), no pass from stream end, result-unavailable vs failed verification, final-result precedence and late events; include collapsed-status cases with no verdict before a valid bound result, including stream end/disconnection (FR-002, FR-004-FR-006).
- [ ] T018 [US2] Extend `apps/studio/src/presentation.ts` with mode-aware `WorkCardView`/`RunPresentation`; `phase` is "existing phase when present; an unknown phase is not invented" and final `verdict` is "absent until a valid bound final result, then the unchanged family-specific verdict"; switch the T011 compact status to this same `RunPresentation` projection and retain raw phase in details when the card label is `Finalizing`, without engine exports (FR-004, FR-005, FR-013).
- [ ] T019 [US2] Build `apps/studio/src/components/WorkTimeline.tsx` with stable run/first-sequence card IDs and retained disclosures; `expandedWorkIds` is a "set of stable work-card identities; disclosures survive new activity and collapse" and `followingLatest` is "whether the reader is at the latest work; new events do not force this to true" (FR-004, FR-006).
- [ ] T020 [US2] Integrate the timeline/state guidance in `apps/studio/src/components/AgentPanel.tsx` and `apps/studio/src/components/CapturedVerification.tsx`, remove last-40-events-only rendering, preserve all accepted details, and show only supported start/close/relaunch guidance rather than new cancel/retry/resume actions (FR-004-FR-006, FR-013).
- [ ] T021 [US2] Add and pass browser regressions in `tests/e2e/workspace-ux.spec.ts` for earlier-card focus/scroll preservation, latest-work affordance, mounted reads through collapse and result arrival without closing details; also assert finalizing cards from actual captured scan/cleanup producer events using bounded test-local barriers, released in `finally`, with raw phase retained; assert collapsed status shares the same result/stream precedence and cannot show a verdict before binding; prepare opt-in bounded `owner-review` cases without Inspector and real six-state captures per quickstart; no forced scrolling or focus theft (FR-002, FR-005, FR-006).
- [ ] T022 [US2] Apply clear activity-connection warnings, concise live announcements and accessible work-card states in `apps/studio/src/components/WorkTimeline.tsx` and `apps/studio/src/styles.css`; pending or disconnected activity must not imply a verdict or unsupported live target (FR-004, FR-005, FR-009-FR-012).
- [ ] T023 [US2] Run UI tests, workspace browser cases and existing headed compatibility suites per `specs/005-studio-workspace-ux/quickstart.md`; produce the real-UI six-state screenshot manifest with case/run/event/result references using the quickstart sources; record results and separately identify pending six-state owner comprehension checks in `specs/005-studio-workspace-ux/tasks.md` (SC-002, SC-004-SC-006).

**Checkpoint / slice 3**: Work presentation is independently reviewable with unchanged result/evidence
consumption. Stop before the final comparison rewrite; UI grouping is not a new execution engine.

## Phase 5: User Story 3 — Trustworthy Results and Evidence (P2)

**Goal**: Concise verdicts with inspectable family-specific details and accessible stored comparison.
**Independent test**: Use both modes' authoritative results and known IDs, inspect available or absent
before/after evidence, and prove that captured final review never recreates its released target.

- [ ] T024 [US3] Add failing family-specific summary/evidence cases in `tests/ui/workspace-presentation.test.ts`, retaining `tests/ui/proof-trail.test.ts` and `tests/ui/captured-verification.test.ts` coverage for exact IDs/manifests, provenance, all required rows, unavailable results and wrong-run rejection (FR-007-FR-009, FR-013).
- [ ] T025 [P] [US3] Extend `tests/e2e/workspace-ux.spec.ts` with final summary/detail navigation, selection retention, missing/not-received/unreadable images and captured no-live-frame-after-finalization assertions, same legacy iframe/frame through final canvas evidence tabs, and named opt-in bounded interactive `owner-review` cases without Inspector for successful and unsuccessful/unevaluable results in both modes per quickstart (FR-007-FR-009).
- [ ] T026 [US3] Implement result/comparison adapters in `apps/studio/src/presentation.ts`; `selectedEvidence` is "null or { runId, phase }, where phase is failure or replay" and resets only when its identity becomes invalid; retain nine legacy gates, ten captured checks and separate success claims (FR-007-FR-009).
- [ ] T027 [US3] Implement `apps/studio/src/components/ResultSummary.tsx` with the exact authoritative verdict, safe explanation, visible unsuccessful/unevaluable checks and accessible detail entry points; captured mode has no invented diagnosis/provenance (FR-007, FR-011).
- [ ] T028 [US3] Implement `apps/studio/src/components/EvidenceComparison.tsx` with phase/ID labels and distinct available, phase-not-produced, ID-not-received, loading and unreadable states; reuse existing closed reads and escaped text, with no raw-path route or cross-run cache (FR-008, FR-009, FR-013).
- [ ] T029 [US3] Integrate final comparison in `apps/studio/src/App.tsx` and `apps/studio/src/components/TargetPane.tsx` without replacing the active measured target; use final legacy canvas target/evidence tabs that hide/inert the original wrapper without unmounting it; keep one stable artifact owner, retain captured guard/release and legacy target lifetime, and never recreate a target for review (FR-008, FR-009, FR-013).
- [ ] T030 [US3] Preserve legacy provenance/diff and captured identity/cleanup detail access in `apps/studio/src/components/ProofTrail.tsx` and `apps/studio/src/components/CapturedVerification.tsx`; keep one stable artifact-loading owner and disclosure state through unrelated updates (FR-007-FR-009, FR-013).
- [ ] T031 [US3] Pass both-mode UI/browser checks in `tests/ui/workspace-presentation.test.ts` and `tests/e2e/workspace-ux.spec.ts`, plus rendered contrast/keyboard checks and the separate native-zoom procedure in quickstart; verify final verdict and selected evidence do not change on late activity or panel changes (SC-003-SC-006).

## Phase 6: Polish and Final Cross-Cutting Verification

These tasks are included in slice 4, not an unrelated fifth PR or a new product feature.

- [ ] T032 Run the full typecheck/build/Vitest/headed commands from `specs/005-studio-workspace-ux/quickstart.md`, retaining all existing failure/load/interruption/cleanup/secret-safety assertions and comparing exact source revision, dependencies and CSP; record observed results in `specs/005-studio-workspace-ux/tasks.md` (FR-013, SC-006).
- [ ] T033 Record the final visual inventory and actual interactive real-Studio SC-001/SC-003 start/result timings in both modes (including unsuccessful/unevaluable results), six SC-002 real-UI screenshot state answers and SC-007 hierarchy/density/balance feedback in `specs/005-studio-workspace-ux/design-system.md`; separate mechanical checks from human acceptance and keep unresolved feedback explicit (SC-001-SC-003, SC-007).

**Checkpoint / slice 4**: Real result/evidence UX and final compatibility evidence are ready for review.
Do not mark owner acceptance complete without the owner's actual observations. Any remaining
human-only verification is disclosed in review; it is not invented to make a task list look complete.

## Delivery Slices

| Order | Boundary | Exact task range | Validation / stop condition |
| --- | --- | --- | --- |
| 1 | Isolated design preview (Phases 1-2) | T001-T008 | `node --check tests/manual/studio-design/preview.js`; local static server below; browser/contrast/zoom checks from quickstart; recorded owner decision. No production files. |
| 2 | Real workspace / core controls (US1) | T009-T016 | `pnpm typecheck`; `pnpm build`; `pnpm exec vitest run --project ui`; workspace and existing headed suites. Accepted preview plus separate slice authorization required. |
| 3 | Work-state presentation (US2) | T017-T023 | UI selectors and workspace headed cases plus existing headed suites; final-result/stream precedence and focus/scroll checks. Stop before result/evidence changes. |
| 4 | Results / evidence and final verification (US3 + polish) | T024-T033 | All UI and headed cases, `pnpm typecheck`, `pnpm build`, `xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1`, final owner review and declared gaps. |

Common checks: `git diff --check`; UI tests with no model key; preserve original files and owned
resource cleanup. New test files must actually exist and contain discovered cases before their
commands count as validation. Commands here are prospective, not executed or passed in Tasks.

Preview command after files exist:

```bash
python3 -m http.server 43120 --bind 127.0.0.1 --directory tests/manual/studio-design
```

Check port availability first, do not stop an unrelated listener, and stop only the server owned
by the review session afterward. Preview hosting/sharing is operator-selected and is not a product
service or a prerequisite on a personal tool, account, URL, filesystem outside this checkout, or skill.

Headed commands after relevant files exist:

```bash
xvfb-run -a pnpm exec playwright test tests/e2e/workspace-ux.spec.ts
xvfb-run -a pnpm exec playwright test
```

Every implementation run executes only one authorized exact range, reports the boundary and stops.
One PR per slice is the default. This Tasks request authorizes no implementation, push, PR or merge.
First slice stays on this feature branch; later slices start from updated main after their predecessor
merges, using the same feature number. No task group silently combines all production changes.

## Dependencies and Execution Order

1. T001-T002 establish the portable preview contract and inventory; T003-T004 implement it.
   T005 verifies it, T006 corrects/rechecks and records the design, T007 delivers the reviewed revision,
   T008 records actual visual acceptance. Partial/negative feedback loops through T004-T007 and
   renewed review; T008 stays unchecked until accepted. Pending/negative T008 blocks production replacement.
2. US1 requires slice 1 acceptance. T009/T010 define behavior before T011-T014 change production;
   T015/T016 verify the independently usable shell. No backend or project-runner foundation is needed.
3. US2 reuses the stable shell but is selector-testable without running US3; T017 precedes T018-T022,
   T023 verifies work presentation. Do not defer known regressions to the final slice.
4. US3 uses the existing strict selectors and stable shell; tests T024/T025 precede T026-T030.
   The planned PR order follows US2, but evidence selectors remain independently testable with recorded
   results. T031 verifies this story; T032/T033 finish cross-cutting and human evidence.
5. Tasks editing the same file run sequentially. A test's RED phase may expose a missing adapter or
   real violated behavior; document the reason, then verify GREEN. Do not apply TDD to markup snapshots.

## Parallel Opportunities

- US1: T009 and T010 may be authored concurrently after slice 1 acceptance; they touch separate test
  files. Integration and all tasks editing `App.tsx`/`presentation.ts` remain sequential.
- US2: Author T017 selector regressions first; after T018, timeline markup and its style refinement
  may be reviewed as separate files, but T019/T022 are intentionally not marked parallel because
  accessible-state design depends on the component. No premature team dispatch is assumed.
- US3: T024 and T025 may be authored concurrently after prior slice authorization; component work
  shares `presentation.ts` and must not race. T032 regression and T033 owner review are not substitutes.

## Requirement Coverage

| Requirement | Production tasks | Preview / final evidence |
| --- | --- | --- |
| FR-001 | T010, T013 | T003 |
| FR-002 | T009-T011, T013, T021 | T004-T006 |
| FR-003 | T009, T014 | T001, T004 |
| FR-004 | T017-T020, T022 | T004 |
| FR-005 | T014, T017-T018, T020, T022 | T004 |
| FR-006 | T017, T019, T021 | T004-T006 |
| FR-007 | T024, T026-T027, T030 | T004, T033 |
| FR-008 | T024-T026, T028-T030 | T004, T033 |
| FR-009 | T010, T013, T022, T024-T026, T028-T030 | T003-T004 |
| FR-010 | T012, T022 | T002-T003, T006, T033 |
| FR-011 | T010, T012, T015, T022, T027, T031 | T003, T005-T006 |
| FR-012 | T010, T012, T015, T022, T031 | T003, T005-T006 |
| FR-013 | T009-T010, T013-T014, T016, T018, T020, T024, T028-T030, T032 | T001, T007 |

| Success criterion | Tasks / observation |
| --- | --- |
| SC-001 | T014-T016, T033; real owner start timing, not preview simulation |
| SC-002 | T017-T023, T033; six owner state answers/times |
| SC-003 | T024-T031, T033; real result/evidence walkthrough |
| SC-004 | T009-T011, T013, T015, T021, T031 |
| SC-005 | T005-T006, T010, T012, T015, T022, T031 |
| SC-006 | T009-T010, T016-T018, T023-T026, T028-T032 |
| SC-007 | T002, T006-T008, T012, T033; owner decisions recorded separately |

## Implementation Strategy and Completion Evidence

The first deliverable is the isolated design preview, not an automatically accepted production MVP.
After accepted visual direction and authorization, US1 provides the first usable production increment;
US2 and US3 each improve it while preserving its working baseline. No general component framework,
new wire schema, runtime enum, public endpoint, live model call or stored preference is required.

Commit each reviewable unit with its relevant behavior checks, rather than a commit per checkbox.
Leave tasks unchecked until supporting work and verification exist. Use ignored
`.flowproof/review/005-studio-workspace-ux/<tested-sha>/<slice>/<case>/` outside Playwright output
and disposable clones for binary evidence and the quickstart evidence manifest. Commit
implementation first, test that clean commit, then record its full SHA in a separate results-only
commit (the tested revision is the results commit parent, not a self-reference). Record exact tested revision,
commands/results, screenshots and owner feedback at the appropriate checkpoint. The task-generation
format/coverage review is not implementation evidence and cannot check off T001-T033.


## Slice 1 publication authorization (2026-11-04)

After accepting the minimalist UI, the owner authorized push, PR creation and the repository's
Codex review/correction loop. Follow CONTRIBUTING.md: at most three remediation rounds after
the initial review. Merge, later-slice implementation and product deployment remain unauthorized.
Before publication, the unchanged accepted preview source passed 56 additional actual native-200%
checks with a visible zoom indicator, unchanged outer window and restored 100% metrics. This closes
the static preview's prior zoom gap; other gaps are recorded in the preview README.

Publication status: [PR #23](https://github.com/LLagoon3/flowproof/pull/23) is open against `main`
for slice 1 only. Exact-head CI and Codex review are tracked on that PR; their completion will be
recorded in PR metadata without changing the reviewed source. Merge remains unauthorized.
