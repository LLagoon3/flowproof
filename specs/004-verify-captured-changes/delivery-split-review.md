# Spec004 delivery decomposition review

**Date:** 2026-11-03. **State:** local-only feasibility review; further product implementation paused.

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
