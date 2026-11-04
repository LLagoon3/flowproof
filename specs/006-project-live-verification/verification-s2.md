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
- Final target-security integration run — **1 file, 6 tests passed** (`integration-target-security.log`): immutable output identity/path confinement, CSP/sandbox and readiness, private/external/Studio/other-loopback attempts, WebSockets, service workers, popups/downloads and blocked cross-origin navigation.
- Headed Chromium project-setup E2E under Xvfb — **2 tests passed** (`e2e-project-setup.log`): review/config confirmation, actual offline build and interactive task-board target, no target/container/model request before confirmation, stale-baseline refusal, and unchanged temporary project Git/filesystem snapshots.
- Project Studio contract run — **11 tests passed** (`contract-project-studio.log`), including option exclusivity, prepared-mode compatibility, strict routes, and security guards.
- `git diff --check` passed. Red attempts are evidence only; they are not counted as final passes.

Runtime identity was read from the ignored S2 manifest: immutable image `sha256:7e0ba4db1a543d98c2591bc13c6bd1da14fd0a81c4aafa87eb948b4d9c1cdb43`, profile `vite-static-v1`, image user `65532:65532`. No image pull or rebuild occurred.

## Integrity and cleanup

The synthetic selected-project snapshots reported no source/index/ref/ignored-state changes; test-owned stale edits were restored before comparison. Final cleanup evidence (`cleanup-final.txt`, with before/after container ID lists) records **46 containers before and after, zero added/missing, zero FlowProof runtime-labelled containers, no listeners on ports 43150–43159, and zero matching owned temp roots**. Test outputs remain under ignored `.flowproof/task-logs/006-project-live-verification/s2/`.

## Skips and stop boundary

No provider/model calls, V2 live-meta smoke, S3/S4/S5/S6/S7 work, complete feature acceptance, full repository-wide `pnpm test`, push, PR, merge or deployment were run. S2 proves its local slice only; later slices and actual live-model acceptance remain open.
