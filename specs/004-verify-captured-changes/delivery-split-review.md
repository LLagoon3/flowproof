# Spec004 delivery decomposition review

**Date:** 2026-11-03. **State when written:** local-only feasibility review; further product
implementation paused. **Current:** slices 1 and 2 merged through PR #19 (`16eecc0`) and
[PR #20](https://github.com/LLagoon3/flowproof/pull/20) (`d385c36`); slice 3 is extracted,
verified and reviewed locally, and published as [PR #21](https://github.com/LLagoon3/flowproof/pull/21)
for GitHub Codex review. See [Slice 3 branch](#slice-3-branch). Earlier sections are dated history;
their authorization boundaries and counts are not current.

## Correction and preserved work

The owner recalled the existing CONTRIBUTING.md policy after the earlier oversized PR: use
reviewable phase/checkpoint PRs, keep implementation and its tests together, execute only the
current slice, validate/report/stop, and start the next authorized slice from updated main after
the preceding PR merges. Small commits are not a substitute. The old one-PR ledger was an
incorrect application of local implementation authority, not an intentional large-PR exception.

- Preserved aggregate source: `b63a94f4dc6eff0490214954f4840322f54d7b8d` on `feat/004-verify-captured-changes`.
- Audit baseline: `78d6f81ce11bfc85e047c308455dc66caf361c92`; local main/origin-main at inspection: `b2ed6ad`.
- Original code, commits and task checkmarks are preserved. Only delivery documentation changed.
- No push, PR, bot request, merge or deployment. The temporary detached audit commits are not PR branches.

## Four sequential checkpoints

Exact task/part assignments are in [tasks.md](./tasks.md#delivery-slices).

| Slice | Purpose | Changed files | Added / removed | Product source added / removed |
| --- | --- | --- | --- | --- |
| 1 | Strict result / pinned Git application | 18 | +3979 / -35 | +945 / -35 |
| 2 | Engine / owned-resource lifecycle | 9 | +3888 / -30 | +1342 / -23 |
| 3 | Studio contracts / state | 5 | +2547 / -52 | +845 / -52 |
| 4 | Visible runtime / captured evidence | 10 | +2557 / -27 | +1161 / -25 |

These are measured incremental audit-tree diffs, not a promise that final PR diffs cannot change
during review. Files can appear in more than one slice. Remaining lines are tests, fixtures and
helpers; they are not excluded from review. The first actual PR also carries the existing Spec004
artifacts: main-to-audit-baseline is **8 files, +1,411 lines**, plus this delivery correction. Its
total will therefore exceed the roughly 4,000-line implementation increment; do not present
product-source counts as total PR size.

The first narrowed checkpoint uses the basic worktree/application implementation at `16357f7`.
Process joining and the new `operationsJoined` disposal fact, including its assertions, move with
the ownership/terminal-path tests into slice 2. No final assertion is deleted or skipped.
The server and launch portions of T019 are separated; strict result/state selectors are in slice
3, with their visible presentation in slice 4. This avoids requiring later runtime/UI code merely
to compile and test an earlier PR. Do not blindly cherry-pick the old interleaved commits.

## Independent parent validation

| Audit snapshot | Typecheck | Build | Focused tests |
| --- | --- | --- | --- |
| 1, narrowed | exit 0 | exit 0 | 4 files; 78 passed |
| 2 | exit 0 | exit 0 | 3 files; 147 passed |
| 3 | exit 0 | exit 0 | 6 files; 393 passed |
| 4 | exit 0 | exit 0 | 4 files; 346 passed |

- Snapshot 1: captured contract, reducer, exact Git application and unchanged legacy worktree tests.
- Snapshot 2: captured contract, unit and real Git/Canvas/terminal-path tests, without Studio changes.
- Snapshot 3: server-only captured integration, captured client/state, and legacy API/state/Proof Trail/worktree.
- Snapshot 4: full captured launch integration, captured client/state and legacy state/Proof Trail.
- Snapshot 4 headed Chromium under Xvfb: **14 passed**, comprising captured verification 6 and
  unchanged Hero/Failure/browser-close/load-failure/secret-safety 8. No skipped cases.
- Snapshot 4 product source and tests are byte-identical to the preserved aggregate head:
  `git diff <source-head> <snapshot-4> -- apps packages tests` is empty.
- Snapshot 4 aggregate `git diff --check`: exit 0.

Validation used the actual named files and checked discovered counts; a nonexistent filename
is not evidence of a passing suite. These are focused feasibility checks, not completion of T040.

## Failures retained, not hidden

- The initial audit accidentally staged dependency-directory symlinks because the existing
  directory-only ignore pattern does not ignore symlinks. Test-clone setup then failed 17 cases
  with EEXIST. Recreated the audit checkout with explicit dependency exclusions; product code and
  assertions were not changed to conceal that environment failure. Original failure logs retained.
- Narrowing slice 1 initially left two `operationsJoined` equality expectations behind: 5 expanded
  cases failed because that fact is introduced in slice 2. Moved those expectations with the
  matching implementation; slice 2 retains the complete final test file. No acceptance criterion
  was weakened in the final product tree.
- Known compatibility gate reproduced independently on snapshot 3: provider-seam has **23 passed,
  1 failed**, reporting exactly `editing/{capture,captureGit,contracts,workspace}.ts` reachable
  from production entry points. It is an unresolved Spec004 dependency-policy conflict, not an
  unrelated green baseline and not proof the slices are merge-ready. The guard and four modules
  were not changed; the previously requested narrow exception remains owner-pending.

## Stop / continuation boundary

- The decomposition is concrete, locally exercised preparation, not completion or publication of four PRs.
- Prepare only slice 1 as the next delivery; its scope/compatibility and actual PR-base diff must
  be reviewed before claiming readiness. Do not resume T035-T042 or the other slices now.
- Only after an explicitly authorized first PR is reviewed and merged, sync current main and
  create the next authorized slice branch. Do not open four stacked PRs or merge them together.
- T035-T042 remain uncompleted; the full final gate was not rerun in this review. T041 remains
  human-only and unperformed. Do not mark the whole feature accepted.

## Local evidence references

- Audit directory: `/tmp/flowproof-pr-boundary-audit-i1f8u_eo`.
- Per-snapshot logs: `slice-1-narrowed-{typecheck,build,focused}.log`,
  `slice-{2,3,4}-{typecheck,build,focused}.log`, `slice-3-seam.log`,
  `slice-4-headed.log` and `slice-4-diff-check.log`.
- `state.json` stores exact snapshot hashes and the discarded setup attempt.
- Temporary audit snapshots require no changes to the feature branch or its history.

## Slice 1 branch

The extraction and initial validation below describe the state before the owner's later
compatibility decision; see [Approved seam correction](#approved-seam-correction) for current status.

- Branch `feat/004-contracts-pinned-git` starts from `main`/`origin/main` at `b2ed6ad`. The owner
  authorized extraction and local verification of slice 1 only; no later slice, push, PR, review
  request, merge, deployment or dependency-policy exception is authorized.
- Scope: these Spec004 artifacts and T003, T005-T009 and T012-T013, using the product and test
  bytes of narrowed snapshot `8602163` rather than the interleaved aggregate commits:
  `packages/flowproof/src/verify/capturedContracts.ts`,
  `packages/flowproof/src/worktree/capturedCandidate.ts`,
  `packages/flowproof/src/worktree/session.ts`, `tests/contract/captured-verification-contract.test.ts`,
  `tests/unit/captured-verification.test.ts` (reducer portion), the 11
  `tests/fixtures/contracts/captured-verification-result.*.json` fixtures,
  `tests/support/capturedCandidate.ts` and `tests/integration/captured-verification-git.test.ts`
  (application-fidelity portion).
- Excluded: `capturedRun.ts`, process joining and `operationsJoined`, the editor fixture and Canvas
  producer, Studio server/client/UI, harness, launcher, and T035-T042.
- Product source is byte-identical to snapshot `8602163`; the product/test difference is 72
  deleted lines. The extra blank lines at the end of `tests/unit/captured-verification.test.ts`
  (1) and `tests/integration/captured-verification-git.test.ts` (2) were removed because they fail
  `git diff --check`. The browser-port evidence double `persistPhase` and its six imports (69
  lines) were removed from `tests/support/capturedCandidate.ts`: no slice 1 test uses it, and it
  belongs with the slice 2 engine tests.

### Slice 1 validation on this branch

Measured at `88015db`, the last product commit; later commits change only these documents.

| Check | Result |
| --- | --- |
| `check-prerequisites.sh --json --require-tasks --include-tasks` (feature directory set explicitly, not persisted) | exit 0 |
| `checklists/requirements.md` | 16/16 checked, unchanged |
| `pnpm install --offline --frozen-lockfile` | exit 0; dependency directories ignored, no tracked symlink |
| `pnpm typecheck`, `pnpm build` | exit 0, exit 0 |
| Slice 1 focused Vitest (4 files) | exit 0; 78 passed: contract 33, reducer 16, Git application 9, legacy `worktree.test.ts` 20 |
| `pnpm test --no-file-parallelism --maxWorkers=1` under Xvfb | exit 1; 46 files, 1,339 tests: 1,338 passed, 1 failed, 0 skipped |
| `playwright test --pass-with-no-tests`, headed Chromium under Xvfb | exit 0; 8 discovered, 8 passed |
| `git diff --check` over `b2ed6ad..HEAD` | exit 0 |

Full-suite projects: contract 9 files/314 tests, unit 21/594, ui 2/158, integration 14/273
including the one failure. The new suites pass inside the full run with the focused counts above.

- **Blocker, unresolved:** the only failure is the provider-seam guard
  `editing runtime stays disconnected from the production Hero/Failure flow > is unreachable from
  the CLI, run, and Studio entry points`, which reports `editing/{capture,captureGit,contracts,workspace}.ts`
  (provider-seam: 23 passed, 1 failed). On this branch they are reached through
  `worktree/session.ts` -> `worktree/capturedCandidate.ts`, which imports `editing/captureGit.ts`
  (value import, required by T012) and `editing/capture.ts` (type-only import, which in turn names
  `contracts.ts` and `workspace.ts`). The guard counts type-only imports; at runtime only
  `captureGit.ts` is loaded. No `editing/*` module is reachable from these entry points on
  `b2ed6ad`. The guard, the four modules and the architecture are unchanged; no test was weakened
  or skipped. The narrow exception remains owner-pending, so slice 1 is not review- or
  merge-ready.
- No push, PR, review request, merge or deployment was performed.

## Approved seam correction

On 2026-11-03 the owner authorized the proposed four-module exception and local validation/commit
on `feat/004-contracts-pinned-git`. The earlier owner-pending blocker above is historical, not a
request for another decision. No later slice or external action is authorized.

- Only the reachability assertion and its name/comments in `tests/integration/provider-seam.test.ts`
  change. The source import walk, including type-only imports, is unchanged.
- The allowed list is exactly `editing/{capture,captureGit,contracts,workspace}.ts`. T012 reuses
  `captureGit.ts` at runtime; the other modules are reached through type-only edges. Every additional
  editing module still fails the assertion.
- The independent direct-reference ban and Hero/Failure provider checks remain unchanged. No
  editing-session, Docker or runtime-profile access is admitted; product source is unchanged.
- T038 records this single approved exception but remains unchecked: its whole-feature audit and
  the later-slice work are not completed by fixing the first slice.
- Requirements checklist: 16/16; prerequisite script: exit 0, using the explicit feature directory
  with persistence disabled. The optional before/after-implement Git auto-commit hooks are not run;
  the existing clean tree and final manual reviewed commit follow `CONTRIBUTING.md`.

### Post-correction validation

Logs use `/tmp/fp-first-pr-seam-approved-*.log`. Product source is unchanged from `74698e4`.

| Check | Result |
| --- | --- |
| Focused provider-seam integration suite | exit 0; 1 file, 24/24 passed |
| `pnpm typecheck`, `pnpm build` | exit 0, exit 0 |
| `xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1` | exit 0; 46 files, 1,339/1,339 passed, 0 skipped |
| `xvfb-run -a pnpm exec playwright test` | exit 0; 8 discovered, 8 passed, 0 skipped |
| `git diff --check b2ed6ad` | exit 0 |

The previous provider-seam failure is resolved. This is local slice-1 validation, not completion
of the complete Spec004 task list, human-only T041, a GitHub review, required remote checks or
merge authorization. The original aggregate branch remains preserved; no push or PR was performed.

## Slice 1 PR review loop

- Current delivery: [PR #19](https://github.com/LLagoon3/flowproof/pull/19),
  `feat/004-contracts-pinned-git` -> `main`. The owner authorized this review loop on 2026-11-03,
  superseding the earlier local-only authorization records above.
- Authorized: push/PR creation, exact-head GitHub Codex review, valid in-scope correction commits,
  follow-up pushes and re-review. Follow `AGENTS.md`: initial review plus at most three remediation
  rounds; independently verify findings and stop for an out-of-scope decision or unavailable review.
- Not authorized: merge, manual deployment or starting another delivery slice.
- Current phase: initial exact-head review and CI verification pending. Local typecheck/build,
  1,339 Vitest tests and 8 browser E2E cases passed before publication; this status commit changes
  documentation only.
- The repository contains only the PR CI workflow, with no preview/deployment job configured.
  Confirm actual check state for each reviewed head; do not treat local results as remote CI.
- Outcome: the owner then authorized the merge. PR #19 merged into `main` as merge commit `16eecc0`
  (parents `b2ed6ad` and reviewed head `60616b6`), after its CI and GitGuardian checks succeeded
  with no unresolved review thread. The phase entries above describe the loop while it ran.

## Slice 2 branch

- Authority (2026-11-03): after the PR #19 merge the owner authorized local extraction and
  verification of slice 2, superseding the earlier pause. The subsequent request to publish the
  PR and proceed with review authorizes [PR #20](https://github.com/LLagoon3/flowproof/pull/20),
  GitHub Codex exact-head reviews, in-scope corrections and follow-up pushes. The initial review
  may be followed by up to three remediation/review rounds under AGENTS.md. Merge, deployment
  and later slices remain unauthorized.
- Branch `feat/004-verification-engine-lifecycle` starts from `main`/`origin/main` at `16eecc0`.
  The aggregate checkout (`feat/004-verify-captured-changes`, `7e21b48`) is untouched.
- Scope: T001-T002, T004, T010-T011, T014-T016, T028-T029 and T031-T032 from audit snapshot
  `72ad962`, compared incrementally against `8602163`. Excluded: the contract module and its
  tests/fixtures, the provider-seam guard, dependencies, CLI, legacy run/reducer, Studio
  server/client/harness/launch/UI and T017-T027, T030 and T033-T042.
- Product commit `c7998d3`: 10 files, +3,960/-30; product source +1,342/-23 (equal to the audit's
  slice-2 measurement).

### Source differences

- Byte-identical to `72ad962`: `verify/capturedRun.ts`, `worktree/capturedCandidate.ts`,
  `worktree/session.ts`, `tests/fixtures/captured-verification/{check-filter.mjs,filter-cases.json}`,
  `tests/fixtures/editing-agent/agent.mjs` (additions only), `tests/support/capturedCanvasCandidate.ts`
  and `tests/integration/captured-verification-git.test.ts`.
- `tests/unit/captured-verification.test.ts` equals the snapshot plus the 13 PR #19 regression tests
  (74 added lines, nothing removed). The shared unit and Git files took the snapshot's
  `8602163..72ad962` hunks over the merged files, not whole-file restores; their only conflicts
  were the appended sections at the end of each file.
- `tests/support/capturedCandidate.ts` regains only the `persistPhase` browser-port evidence
  helper and its six imports (69 lines) that slice 1 removed; the engine tests use it.
- `verify/capturedContracts.ts`, the contract tests/fixtures and `provider-seam.test.ts` are
  unchanged from `16eecc0`, so the PR #19 missing-evidence normalization, metric-key redaction and
  all 19 regression tests (unit 13, contract 6) remain. No product adaptation was needed.

### Commit boundary

The planned fixture, engine and process-joining commits are one commit. `capturedRun.ts` imports
`joinProcessGroup`, `BUILD_ENVIRONMENT_KEYS`, `buildBaseline`, the run signal and
`operationsJoined` from the hardened `worktree/session.ts`, so the engine cannot precede the
hardening. The tests that prove the checker fixtures, the Canvas cases and process joining (T011,
T029) all drive the engine, so neither can precede it with its own tests without writing
intermediate code. Clone-based tests read only committed bytes (`createTempClone` runs
`git clone`), so they were run on the commit; no failing commit was kept.

### Slice 2 validation

Measured on `c7998d3`; the documentation commit changes no product or test file. Logs use
`/tmp/fp-slice2-worker-*.log`.

| Check | Result |
| --- | --- |
| `check-prerequisites.sh --json --require-tasks --include-tasks` (feature directory explicit, not persisted) | exit 0 |
| `checklists/requirements.md`; `before/after_implement` hooks | 16/16 checked, unchanged; optional Git auto-commit hooks not run |
| `pnpm install --offline --frozen-lockfile` | exit 0; no tracked symlink |
| Focused slice-2 Vitest (3 files) on unchanged `16eecc0` | exit 0; 77 passed: contract 39, unit 29, Git 9 |
| Same files, tests restored before product | exit 1; 166 discovered: 72 passed, 94 failed (unit 71, Git 23) for the missing `capturedRun.ts`, missing `operationsJoined` and non-aborting disposal |
| Same files, product restored but uncommitted | exit 1; 149 passed, 17 failed: clone-based Git tests could not see uncommitted fixtures |
| Focused slice-2 Vitest on `c7998d3` | exit 0; 166/166 passed: contract 39, unit 100, Git 27 (Docker-backed Canvas cases executed), 0 skipped |
| Legacy `worktree.test.ts` + unchanged `provider-seam.test.ts` | exit 0; 44/44 passed (20 + 24) |
| `pnpm typecheck`, `pnpm build` | exit 0, exit 0 |
| `xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1` | exit 0; 46 files, 1,447/1,447 passed, 0 skipped: contract 9/320, unit 21/678, integration 14/291, ui 2/158 |
| `xvfb-run -a pnpm exec playwright test`, headed Chromium | exit 0; 8 discovered, 8 passed, 0 skipped |
| `git diff --check 16eecc0 HEAD` | exit 0 |

The audit's historical slice-2 focused count (147) plus the 19 PR #19 regressions gives the 166
measured here. T002 remains unchecked (`canvas-plausible-wrong` is first exercised by T020); T038,
T040 and T041 remain unchecked whole-feature gates, and T041 is human-only and unperformed. This is
local slice-2 verification, not remote CI or merge authority.

### Slice 2 PR review

- PR #20 targets `main` from `feat/004-verification-engine-lifecycle`; no later slice is included.
- Parent revalidation before publication: `pnpm typecheck`, `pnpm build`, and the combined captured
  contract/unit/Git, legacy worktree and provider-seam gate passed (5 files, 210/210, no skipped
  cases; `/tmp/fp-slice2-pr-{typecheck,build,focused}.log`). Those product and test bytes were
  unchanged at initial publication; the review correction below supersedes them.
- Publication/review status is recorded before the initial exact-head Codex request. Remote CI
  and review completion must be observed against the published HEAD; this document does not
  claim a completed review or authorize merging it.

### Slice 2 correction round 1

- Initial Codex review completed on `5738a5f` with one P2 finding: interruption tracking ended
  before asynchronous evidence scanning and cleanup, so a cancelled run could persist `passed`.
  Initial CI and GitGuardian checks passed on that exact head.
- Product correction `e63ce9a` keeps the interruption listener through scanning and both disposal
  operations, then folds the first interruption/deadline into the terminal decision before
  persistence. Cleanup still completes; earlier operational errors retain precedence. The
  listener is removed before persistence, including a failed result write.
- Nine new regressions cover scan/capture/worktree-disposal interruption, first-stop/error
  precedence and listener release, including real Git disposal. Baseline RED confirmed the
  reported false success; all new cases are GREEN on the correction.
- Worker validation on committed `e63ce9a`: typecheck/build passed; focused contract/unit/Git
  plus worktree/provider-seam passed 219/219 (5 files); full suite passed 1,456/1,456 (46 files,
  zero skipped); headed Chromium passed 8/8. Logs: `/tmp/fp-pr20-r1-*.log`.
- Parent independently inspected the correction commit and diff, then passed typecheck and
  219/219 tests: captured contract/unit/Git 175 plus legacy worktree/provider-seam 44, with no
  skipped cases (`/tmp/fp-pr20-r1-parent-{typecheck,focused,compat}.log`).
- This correction remains slice 2 only. A fresh exact-head Codex review and remote CI must be
  observed after the follow-up push; no clean review, merge, deployment or next slice is claimed.

## Slice 2 merge

The owner requested merge, deployment and the next slice on 2026-11-03. PR #20 merged as
`d385c36f5cc8cf3ae205ec1556f4c5c714fd3835` after correction-round Codex review completed with
no findings on exact head `639d993`. CI run `41585119282` and GitGuardian succeeded on that
same SHA, no review thread remained unresolved, and the PR body reflected that state. These
remote observations and the merge were performed by the parent session, not by this extractor.
Deployment target clarification is separate; this report claims no deployment.

## Slice 3 branch

- Current authority: local extraction, verification and manual commits for slice 3 only, following
  the owner's request after the PR #20 merge. No slice-3 push, PR, review request, merge or
  deployment is performed here, and slice 4 is not started.
- Branch `feat/004-studio-contracts-state` starts from current `main`/`origin/main` at `d385c36`.
  The aggregate checkout and every other worktree remain untouched.
- Scope: T018, T019 server portion, T021, T023-T024 and T034 selectors. T019 launch admission
  and T034 visible presentation remain incomplete, as do all slice-4 tasks. The existing
  launcher, UI components, browser harness, E2E tests, dependencies, package/lockfiles and CLI
  are unchanged. No product requirement or route is added.
- Source: immutable audit snapshot `1dc51234f242dde7dd31edbcfbf294e7827ea4b0`, incremental to
  `72ad9623298111e26c9c24478de97c63d41b20cd`. The server and client/state product files are
  byte-identical to that source. The server test drops one blank EOF line to pass diff-check;
  the client test adds two boundary regressions covering PR #19 reducer normalization for all
  12 missing-evidence/terminal combinations and strict/private metric failure handling.
- The merged contract and engine files, captured unit/contract/Git regressions (including the
  nine PR #20 finalization-interruption cases), and provider-seam guard are unchanged from
  `d385c36`. The guard still permits exactly the four approved capture modules, and does not
  admit the editing-session/Docker runtime.

### Slice 3 commit boundaries

1. `18ba202 feat(studio): add host-fixed captured verification server contract` contains the
   host-fixed server mode and server-only integration tests. Its independent typecheck/build
   and captured-server/legacy-API/provider-seam checks pass without the new client or state.
2. `19d1bf1 feat(studio): add explicit captured result client and state selectors` contains
   the browser-safe explicit result union/parser, catalog mode, captured state/selectors and
   their tests. The API and state form one client contract; both compile without a launcher
   or visible component integration.
3. A documentation-only commit records current authority, task-part completion and measured
   validation. Optional before/after-implement Git auto-commit hooks are not run, following
   CONTRIBUTING.md; no mandatory implementation hook is registered.

### Slice 3 validation

Measured on committed product `19d1bf1`; subsequent changes are documentation-only. Logs use
`/tmp/fp-slice3-native-*.log`. No live provider or credential is used.

| Check | Observed result | Log suffix |
| --- | --- | --- |
| `check-prerequisites.sh --json --require-tasks --include-tasks`, explicit feature directory with persistence disabled | exit 0 | `prerequisites.log` |
| Requirements checklist | 16/16 checked, unchanged | checked from file |
| `pnpm install --offline --frozen-lockfile` | exit 0; real ignored dependency directories, no tracked dependency symlink | `install.log` |
| Server tests first, merged baseline product | exit 1; 29 discovered, 17 failed and 12 passed; captured host mode is missing | `server-red.log` |
| Client tests first, baseline API/state | exit 1 before collection because captured exports are missing; not a zero-test pass | `client-red.log` |
| Client API restored, baseline state | exit 1; 143 discovered, 33 failed and 110 passed for missing captured state/selectors | `state-red.log` |
| Server boundary `pnpm typecheck`, `pnpm build`, before new client/state | exit 0, exit 0 | `server-{typecheck,build}.log` |
| Server captured + legacy API + unchanged seam gate | exit 0; 96/96 (29 + 43 + 24) | `server-green.log` |
| Final client/state/Proof Trail gate | exit 0; 303/303 (145 + 147 + 11), including the two extra parity regressions | `client-parity.log` |
| `pnpm typecheck`, `pnpm build` on final product | exit 0, exit 0 | `typecheck.log`, `build.log` |
| Slice-3 focused gate, all six named files | exit 0; 395/395, zero skipped | `focused.log` |
| Preserved captured contract/unit/Git plus unchanged provider-seam gate | exit 0; 199/199 (39 + 108 + 28 + 24), zero skipped | `regression.log` |
| `xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1 --reporter=verbose` | exit 0; 48 files, 1,630/1,630 passed, zero skipped | `full.log` |
| Existing headed Chromium suite under Xvfb | exit 0; 8 discovered, 8 passed, zero skipped | `e2e.log` |
| `git diff --check d385c36` and exact product/source comparison | exit 0; product/source diff empty, merged regression files unchanged | final local audit |

Focused file counts: captured server 29, captured client/state 145, legacy state 147, Proof Trail 11,
legacy Studio API 43, legacy worktree 20. `vitest list` discovers every named file; its unexpanded
parameterized-test entries are not substituted for the executed counts (`discovery.log`).
The prepared Docker-backed captured cases and all nine merged PR #20 finalization regressions ran.

Full regression project counts: contract 9 files/320 tests, unit 21/686, integration 15/321,
UI 3/303. This is the merged slice-2 total of 1,456 plus 29 server and 145 client/state tests,
with zero tests removed, skipped or weakened. The five product/test paths total +2,576/-52
relative to `d385c36`, including all tests; product source is +845/-52. The three active
delivery documents are additional changes, not excluded from review.
Whole-feature T002, T038, T040 and human-only T041 remain incomplete. Slice-3 automated
validation does not deliver the actual-frame launcher or visible captured-evidence components. The
prepared-candidate trust boundary and issue #15 observation-isolation exclusion are unchanged.

### Parent verification of slice 3

On `e1b06c8`, the parent inspected the three commits and aggregate scope, confirmed all three
product files match `1dc51234`, and verified the merged contract/engine/worktree regression files
and provider-seam guard are unchanged from `d385c36`. Worker full-suite and headed-suite logs
were checked through their final summaries. Independent `pnpm typecheck` and the six slice-3
focused files plus `provider-seam.test.ts` passed: exit 0, seven files, 419/419 tests, zero skipped.
Logs: `/tmp/fp-slice3-parent-typecheck.log` and `/tmp/fp-slice3-parent-focused.log`.
`git diff --check d385c36 HEAD` passed. This is local slice completion, not a published PR,
remote review, whole-feature acceptance or deployment.

### Slice 3 publication and review

The owner subsequently authorized PR publication and a review loop on 2026-11-03. Slice 3 is
[PR #21](https://github.com/LLagoon3/flowproof/pull/21), `feat/004-studio-contracts-state` to `main`.
This supersedes the earlier local-only publication boundary, authorizing in-scope corrections,
follow-up pushes and exact-head GitHub Codex review requests. Follow AGENTS.md: initial review
plus at most three remediation rounds. Merge, deployment and slice 4 remain outside this loop.
Current phase: exact-head review and CI pending; local verification above is not remote CI.
The repository has only the PR CI workflow and no automatic preview/deployment workflow.
This publication-status commit changes documentation only; all product and test bytes remain
those independently checked at `e1b06c8`.

### Slice 3 CI correction 1

Codex completed its initial review of `aaea755` without findings. CI run `41591935207` failed
one of 1,630 tests: the elapsed-total-window application case expected `RUN_TIMEOUT` for the
application, but got `CHECK_NOT_EVALUATED`. Its fake clock added advances to live elapsed time;
after advancing to ten milliseconds before the deadline, baseline evidence I/O could consume
that margin and correctly stop the engine before application ever began.

The parent reproduced the same failure by temporarily delaying baseline evidence by 25 ms.
The test-only clock now advances solely under test control, so the same delay passes without
altering engine behavior or assertions. The temporary delay was removed after the RED/GREEN
probe. The complete captured unit suite passes 108/108 with zero skipped; typecheck and
diff-check pass. Logs: `/tmp/fp-pr21-clock-{red,delayed-green,unit,typecheck}.log`. The filtered
probe selected one case and skipped the other 107; it is not reported as a full-suite pass.
No product source, test expectation or real-timer test changed. Exact-head re-review and full CI
must complete after this correction; the initial clean review is not approval of a later SHA.

## Slice 4 branch

### Authority, source and scope

- The owner authorized merging PR #21 and continuing the next slice on 2026-11-03. The parent
  verified the exact reviewed head `a405bf12bd142c2565aa458297bb61e7c7806994`, Codex no findings,
  successful CI `41592671435` (1,630 tests/eight headed cases), GitGuardian success and zero
  unresolved threads before merging. This checkout begins clean on merged main
  `bcb29e5261354039c1a1fdf34902615a6b145b9e`, branch `feat/004-visible-runtime-evidence`.
- Local-only scope: T017, T019 launch, T020, T022, T025-T027, T030, T033, T034 presentation,
  T035-T042. T002's final prepared negative case is now exercised by headed T020. T041 remains
  human-only, unperformed and unchecked. No push, PR, remote review, merge or deployment occurs
  in this extraction; the separate deployment target is still unspecified.
- Immutable source: `ebb747dd57dd3b1726e4eca1de8da9cdd3b1b52e`, incremental to slice-3 source
  `1dc51234f242dde7dd31edbcfbf294e7827ea4b0`: ten paths, +2,557/-27 including tests/helper.
  Nine safe whole-file candidates had no newer baseline fixes and were restored exactly. The
  integration file was applied additively after its EOF-only difference prevented a clean patch;
  all earlier server assertions remain, with import expansion and 16 appended admission cases.
  All ten extracted source files match `ebb747d` exactly. The new QA launcher and delivery docs
  are additional work, not claimed to be part of that source.
- Preserved unchanged from merged baseline: captured engine/contracts/private Git/worktree,
  all earlier contract/unit/Git/client/server fixes and regressions, API/state, and provider-seam.
  In particular the PR #21 deterministic clock is controlled only by test advances; all 108 unit
  cases still run, including the nine PR #20 finalization-interruption regressions.

### Commit boundaries

1. `0f06602 feat(studio): launch captured runs with owned target finalization`: launcher,
   captured harness and launch-admission regressions compile/build with legacy UI; RED 16 failed/
   29 passed before launcher implementation; GREEN 45/45 after it. This boundary is independent
   of visible UI; captured E2E was kept for the following UI commit.
2. `2073ce0 feat(studio): show actual captured replay and completed evidence`: existing App,
   AgentPanel/ProofTrail/TargetPane, the small captured result component, additive styles and six
   headed cases. Before the UI, the passing case failed for its missing candidate-start action;
   afterwards all six captured headed cases passed. Live iframe identity and covered/focused input,
   baseline/candidate readiness, plausible-wrong failure, build/load failure, static evidence and
   two mid-run close paths are checked against the real observed frame.
3. `ad807a2 test(studio): add built-module captured verification QA launcher`: strict `--case pass`
   interface, prior-build check, built-module imports only, temporary committed clone and prepared
   dependency links, exact fixed fixture build/pinned image, real canvas-fix capturing session,
   human-controlled start/close and explicit cleanup summary. Own tag/clone only are removed.
   Quickstart now includes UI discovery/focus, headed discovery and the prior-build prerequisite.
4. `d8a1ef1 fix(test): report QA cleanup only after all owned removals` ensures the manual
   launcher emits its single cleanup verdict after tag and clone removal too; exceptional
   cleanup can never leave an earlier `cleanupComplete: true` summary.
5. Documentation-only completion records the observed gate counts, scope audit and explicit
   human-only gap. Optional before/after-implement Git commit hooks are not executed, per
   CONTRIBUTING.md; there is no mandatory implementation hook. Manual Conventional Commits are used.

### Whole-feature scope audit (T038)

The whole feature from original `b2ed6ad` and the current slice from `bcb29e5` were both inspected.
`package.json`, `pnpm-lock.yaml`, production CLI, legacy `run.ts`, legacy result schemas and
verification gates are byte-identical to `b2ed6ad`. No new HTTP route, target URL/port, service,
container family, provider invocation, cancel endpoint or upload/export path is added. The new
in-process launcher export and browser result discriminator are the approved internal contracts,
not network export surfaces. Application keeps Git safe defaults; prohibited apply flags appear
only in the explanatory comment and are never used. The existing Docker fixture is reused.
The Docker context's `.dockerignore` excludes everything except `agent.mjs`; root Git ignores
installed dependencies, generated builds, run artifacts, environment files and test output.

Existing agent fixture and Studio harness changes are strictly additive (+93/0 and +232/0).
Existing test assertions are preserved; the integration imports expand, and 16 new admission
cases are appended. The only historical guard adjustment is the owner-approved exact four-module
capture reachability set from PR #19; type-only traversal and independent production restrictions
remain intact. PR #21's already-reviewed fake-clock correction is test-only; no product assertion
was weakened. Captured contract/unit/Git/server/client regressions are unchanged or additive,
not overwritten by the older aggregate snapshot. No secret, local artifact, dependency link or
new dependency is tracked. The aggregate checkout and other worktrees remain untouched.

### Slice 4 validation

All commands run from this slice checkout against committed product/test bytes. Logs are under
`/tmp/fp-slice4-native-*.log`; counts below are observed, not inferred from zero-test exits.

| Check | Observed result | Log suffix |
| --- | --- | --- |
| Explicit feature prerequisites; unchanged requirements checklist | exit 0; 16/16 checked | direct prerequisite/checklist output |
| `pnpm install --offline --frozen-lockfile` | exit 0, real ignored dependency directories | `install.log` |
| Launch admission tests first | exit 1; 16 failed, 29 passed | `launch-red.log` |
| Launcher typecheck/build without captured UI | exit 0 / exit 0 | `launch-typecheck.log`, `launch-build.log` |
| Launch admission/server GREEN | exit 0; 45/45 | `launch-green.log` |
| Headed passing case before captured UI | exit 1; missing candidate-start action | `ui-red.log` |
| Final typecheck/build | exit 0 / exit 0 | `typecheck.log`, `build.log` |
| Focused slice-4 plus preserved contract/unit/Git/seam, eight files | exit 0; 547/547, zero skipped | `focused.log` |
| Five-file Vitest discovery | nonzero for all five files | `discovery.log` |
| Captured headed discovery | six cases in one file | `headed-discovery.log` |
| Captured headed cases | exit 0; 6/6, zero skipped | `captured-e2e.log` |
| Exact T039 ten-file legacy Vitest command | exit 0; 497/497, zero skipped | `legacy.log` |
| Exact T039 five-file legacy headed command | exit 0; 8/8, zero skipped | `legacy-e2e.log` |
| Full `xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1 --reporter=verbose` | exit 0; 48 files, 1,646/1,646, zero skipped | `full.log` |
| Full `xvfb-run -a pnpm exec playwright test --pass-with-no-tests` | exit 0; 14 discovered, 14 passed, zero skipped | `e2e.log` |
| Manual script syntax and strict interface/prior-build refusals | exit 0 syntax; four expected exit-2 refusals | `manual-check.log`, `manual-interface.log` |
| Automated built-module launcher startup/close | exit 0; empty residue/processes, port off, original unchanged; not human QA | `manual-final-smoke.log` |
| Scope/source/preserved-regression audit and diff-check | exit 0; exact extracted source match | `whole-scope.log`, direct Git audit |

Focused executed counts: captured server/launch 45, captured UI 145, legacy state 147, Proof Trail
11, contract 39, unit 108, Git 28, provider-seam 24. Vitest list prints unexpanded parameterized
entries (15 contract, 50 unit, 27 Git, 21 server, 43 UI); execution expands those to
39/108/28/45/145 respectively, not zero-test success. Full project totals: contract nine
files/320 tests, unit 21/686, integration 15/337, UI three/303. Relative to slice 3 this adds
16 launch-admission cases; no earlier test is removed or skipped. Headed adds six captured
cases to the unchanged eight legacy cases.

Nine passing/failing/preparation PNGs are preserved in `/tmp/fp-slice4-native-screenshots/`.
The passing screenshot and its before/after captured labels were inspected; the automated
same-frame assertions remain the identity proof, not screenshots alone. The latest test output
also retains these under `test-results/`. The initial manual lifecycle attempt refused an
occupied prepared port while an earlier focused run settled (`manual-smoke.log`); a clean
retry passed (`manual-smoke-retry.log`). No foreign process/resource was stopped. This failure
is preserved rather than relabelled as a pass.

**Human-only T041: not performed.** Automated headed observations, screenshot inspection and
manual-launcher startup/close do not constitute owner visual acceptance. T042 records that gap;
all other tasks have supporting automated or scope-audit evidence. Prepared candidate execution
is not containment for arbitrary hostile code, and page-global adversarial observation isolation
remains excluded issue #15 work. No live model, credential, automatic install, deployment or
remote publication is claimed. The owner can perform T041 after the final gate with the exact
quickstart command and inspect its cleanup summary.


Final automated launcher smoke ran on committed `d8a1ef1`, after its summary-order correction:
exit 0, `ready=True`, empty temporary leftovers/processes, target port not listening, original
snapshot unchanged, no mismatch and `cleanupComplete: true` (`manual-final-smoke.log`). It closed
through SIGINT without starting verification and explicitly records `human_visual_acceptance=False`;
the separate six headed cases prove the full candidate run. The final documentation commit changes
no product or test bytes. All automated gates are settled; no owned test/runtime remains running.
