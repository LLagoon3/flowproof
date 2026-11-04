# S2 Verification: Real Project Setup and Offline Runtime

**Date:** 2026-11-04
**Branch:** `feat/006-project-live-verification-runtime`
**Authorized scope:** T010–T020, T035, T039 only. Stop at S2; no model/provider or full-feature acceptance.

## Implementation commits

- `21b9205e142635f5db82b24658e5c0e84b20478a` — candidate snapshots verify their frozen expected tree; nested output ownership no longer hides sibling inputs.
- `870d43dc15c5dd6028cc68cb3db691905df041e2` — strict project CLI/configuration, project-only context/configure/prepare routes, setup UI, isolated target launcher and server.
- `b5a3ee0e536607d2c3e85de245741a4cac405340` — real Chromium setup journey and built-target security coverage.

The inherited S2 admission/patch/runtime commits were preserved: `e052d5414c2286f250bf9329698c4a5ac27c6480`, `15fff2fdef66fbb67f76f607f41b81bc8b10e0d6`, and `3de5e64c9b1c58621b2ad6c7694c3d9daa5b51f3`. The merged S1 base remains `2b1155fd6c949afa62c7710d1353d7a06d87f6ef`.

## Decisions and boundaries

- `ProjectSnapshot.withExpectedCandidate()` produces an immutable candidate view bound to admitted paths/modes and a frozen expected tree. It does not refresh or weaken baseline verification. Runtime verification can therefore accept the exact owned candidate without treating the unchanged baseline view as its expected contents.
- Runtime output ownership is limited to the exact configured subtree. Existing siblings beneath the same top-level directory remain integrity-checked.
- Project mode is additive and rejects mixed legacy/project CLI options. Routes retain strict body, Host/Origin, cookie and session checks. Setup review/checkbox confirmation is required before configuration and preparation. Project-specific UI state remains local to `ProjectSetup`; the legacy reducer in `apps/studio/src/state.ts` is unchanged.
- The built target is served from immutable offline output. CSP, iframe sandbox, exact-origin browser routing, and a dedicated WebSocket route block foreign/private/loopback access and all project WebSockets. A labelled second browser context bypasses CSP only to test the route layer independently; the production context separately exercises CSP/sandbox behavior.
- Contract-route preparation uses explicitly labelled in-process test doubles. Actual successful setup/build/target interaction is independently exercised by the Chromium E2E and offline runtime integration tests.

## Validation

- Red-first evidence is retained for admission/patch (`t010-t035-red.log`), candidate/runtime mismatch (`t-runtime-candidate-red.log`) and nested output boundary (`t-nested-output-red.log`). Each regression is included in the final passing focused suite.
- `pnpm typecheck` — passed for the workspace packages (`typecheck-final.log`).
- `pnpm build` — passed for FlowProof, Studio and demo app (`build-final.log`).
- Project-focused Vitest run — **9 files, 153 tests passed**: admission, lifecycle, patch, runtime preparation, target app, project contracts, project Studio/CLI, real runtime and target security (`project-focused-final.log`). The runtime test uses the already-provisioned image and includes candidate-copy/runtime compatibility and nested output integrity.
- Parent recheck distinction: the initial default-concurrent recheck ran **8 files, 142 tests** and failed test cleanup because project-runtime and target-security asserted against the host-global runtime label; the multi-process project Studio CLI precondition case also exceeded Vitest's default 5-second per-test timeout (`parent-final/focused.log`). The serial confirmation passed **9 files, 153 tests** (`parent-final/focused-serial.log`). Cleanup checks are now scoped to each suite's runtime ID, and only the affected CLI test has a 60-second timeout matching its subprocess contract. The corrected default-concurrent run passed **9 files, 153 tests** (`parent-final/focused-default-fixed.log`).
- Final target-security integration run — **1 file, 6 tests passed** (`integration-target-security.log`): immutable output identity/path confinement, CSP/sandbox and readiness, private/external/Studio/other-loopback attempts, WebSockets, service workers, popups/downloads and blocked cross-origin navigation.
- Headed Chromium project-setup E2E under Xvfb — **2 tests passed** (`e2e-project-setup.log`): review/config confirmation, actual offline build and interactive task-board target, no target/container/model request before confirmation, stale-baseline refusal, and unchanged temporary project Git/filesystem snapshots.
- Project Studio contract run — **11 tests passed** (`contract-project-studio.log`), including option exclusivity, prepared-mode compatibility, strict routes, and security guards.
- `git diff --check` passed. Red attempts are evidence only; they are not counted as final passes.

Runtime identity was read from the ignored S2 manifest: immutable image `sha256:7e0ba4db1a543d98c2591bc13c6bd1da14fd0a81c4aafa87eb948b4d9c1cdb43`, profile `vite-static-v1`, image user `65532:65532`. No image pull or rebuild occurred.

## Integrity and cleanup

The synthetic selected-project snapshots reported no source/index/ref/ignored-state changes; test-owned stale edits were restored before comparison. Final cleanup evidence (`cleanup-final.txt`, with before/after container ID lists) records **46 containers before and after, zero added/missing, zero FlowProof runtime-labelled containers, no listeners on ports 43150–43159, and zero matching owned temp roots**. Test outputs remain under ignored `.flowproof/task-logs/006-project-live-verification/s2/`.

## Skips and stop boundary

No provider/model calls, V2 live-meta smoke, S3/S4/S5/S6/S7 work, complete feature acceptance, full repository-wide `pnpm test`, push, PR, merge or deployment were run. S2 proves its local slice only; later slices and actual live-model acceptance remain open.


## Source-parent independent verification

The source parent reviewed S2 at `d42ed72739ea7717f70dca45baf41b6206244eff` after the recovery writer settled, including the candidate/runtime compatibility correction, nested output boundary, additive CLI and guarded setup UI/server/browser policy. Under `/tmp/flowproof-spec006-heavy.lock`, independent workspace typecheck and build passed. The exact nine-file focused set passed **153/153**, with no skips, when run serially; the actual headed Chromium setup journey passed **2/2**. The whole-host container-ID lists before/after were identical, and selected-project tracked/untracked/ignored/index/ref/Git snapshots remained unchanged in the tests.

A separate built-module probe passed **22 assertions**, including cleanup: a different valid comment patch was applied only to an owned candidate copy and built/checked with the retained immutable image; the candidate's default expected-tree verification succeeded; subsequent candidate tampering failed verification and runtime admission; declaring nested `tests/parent-build` output did not hide a changed committed sibling; `src` output was refused; stale original edits were detected and restored; original repository snapshots were unchanged. The probe used only the permitted synthetic fixture materializer, not implementation test assertions or a model-produced correction.

The first parent concurrent test attempt is retained honestly in `parent-final/focused.log`: one test path was misspelled, so only eight files ran; an expensive multi-process CLI case exceeded its default 5 s test timeout; one suite's global runtime-label assertion observed another suite's legitimate container. The corrected nine-file serial pass was diagnostic, not a waiver of default-runner compatibility. A focused same-worker follow-up corrected runtime ownership assertions and scoped CLI timing; the final default-concurrent result is recorded below. No sibling container was removed and no global test setting was relaxed.

Parent logs and the independent probe are ignored under `.flowproof/task-logs/006-project-live-verification/parent-final/`. The parent verified all 55 task definitions unchanged, the precise 13 S2 task marks, and an unchanged requirements-quality checklist. This is local S2 evidence; S3/S4 remain separate branches, not a combined production workflow. Provider calls, S5+ and deployment remain unrun.

### Final default-concurrent source-parent recheck

At `eb5b8f9353d1ca6dc5184e1f95c0d404079ddc6c`, the source parent independently ran
`pnpm test` with the same exact nine focused file paths and no serial/file-parallelism overrides,
under the shared `/tmp/flowproof-spec006-heavy.lock`: **9 files, 153 tests passed**, no skips,
exit 0, 25.14 s. This is separate from the child's corrected concurrent pass. The only changes
since the parent-verified typecheck/build were three test files and evidence; all tracked
`packages/`, `apps/`, `tools/` and workspace configuration bytes were unchanged, so those passing
build/typecheck and 22 direct-probe assertions still describe the same product code.

The parent compared all host container IDs before and after: **46 -> 46, identical IDs**, no
runtime-labelled containers, and no listeners on S2 ports 43150–43159. Test cleanup retained no
sibling-removal workaround. Log: `parent-final/focused-default-parent-final.log`; machine-readable
resource/result summary: `parent-final/focused-default-parent-summary.json`, both under the ignored
slice log root above. The historical authorization paragraph in `tasks.md` now records the actual
S1 merge and parallel S2/S3/S4 authorization without copying sibling task marks or claiming their
integration. Optional Git auto-commit hooks remain skipped under the repository policy; this final
reviewed evidence is committed manually. No full default repository suite or live model was run.

## CI runtime preparation correction

The default S2 tests use real Docker and the operator manifest from `runtimeManifestPath()`, but a
fresh hosted runner has neither a prepared image nor a manifest. `.github/workflows/ci.yml` now
runs an explicit **Prepare offline project runtime** step after Build and before both test steps:
`node tools/runtime/prepare-project-vite.mjs prepare --output
"$RUNNER_TEMP/flowproof/runtime-profiles/vite-static-v1.json" --self-check`, then exports
`FLOWPROOF_PROJECT_PROFILE_MANIFEST` through `GITHUB_ENV`. The job builds its own immutable image
from the committed sample lock during this operator step only; selected-project execution still
never pulls or builds. No test is skipped and no product, script, dependency or global
configuration changed.

Local checks (heavy lock held): the workflow parses with eleven steps in the intended order; a
stubbed-`node` run of the exact step script writes the `GITHUB_ENV` line on success and exits 1
without it on failure; `tests/unit/project-runtime-preparation.test.ts` passed 11 tests; `verify
--self-check` of the retained local manifest passed without pulling or rebuilding it; host
containers were 46 -> 46 identical. The real image build on a fresh hosted runner is not yet
proven: only the hosted CI run on the published PR can show it. Logs are under the ignored
`.flowproof/task-logs/006-project-live-verification/s2-ci/`.
