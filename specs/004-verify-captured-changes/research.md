# Research: Visible Verification of Captured Changes

**Date**: 2026-11-02. **Code examined**: `b2ed6ad`; Spec approval recorded at `a3c51ca`.
This is planning evidence, not implemented feature acceptance. No new library, license commitment,
external service, account, or network provisioning is selected.

## R1 — Application must use exact bytes and the recorded baseline

**Observed**: `worktree/session.ts` prepares original HEAD and `applyDiff()` accepts at most a
20-KB one-file UTF-8 patch (`worktree/session.ts:380`, `patch/validateDiff.ts:17`). Spec 003 instead
returns a full-index binary-capable Buffer, raw filename bytes and reference-only gitlinks
(`editing/capture.ts:77`, `specs/003-capture-editing-candidate/data-model.md`).

**Decision**: retain the legacy method and add a narrow sibling for a captured candidate, explicitly
pinning its baseline. Reuse preparation/build/disposal and bounded Git primitives. Apply against an
owned private Git/index/object store with the original objects read-only as an alternate. Use
`--check --index --binary`, then actual application and an independent metadata/fidelity comparison.

**Rationale**: ordinary working-tree-only application cannot reliably preserve all gitlink index
semantics. Ordinary shared `--index` application would write new objects into the original common
object store. A private index/store preserves both properties without a new execution container.

**Alternatives rejected**: lossy `Buffer.toString('utf8')`, the legacy single-file parser, applying to
current HEAD rather than candidate baseline, shared-index mutation, 3-way/partial application,
recursive submodule initialization and an entire second editing runtime.

**Probe**: a disposable synthetic repository and linked baseline worktree preserved added/changed/
deleted text, empty and binary files, raw non-UTF-8 filename bytes, executable mode, symlink text,
and a gitlink; its final private tree matched an independently staged expected tree. The first
probe failed until private-index stat information was refreshed after `read-tree`; the corrected
probe passed. Implementation must retain this preparation step. The probe did not modify FlowProof
source and is not a general application-integrity or process-cleanup acceptance test.

## R2 — Legacy Verified Fix cannot be asserted from capture alone

**Observed**: `contracts/schemas.ts:18` defines nine gates; verified results require all nine and
non-null diagnosis/diff/before/after artifacts (`contracts/schemas.ts:360`). `run.ts:513` always
performs diagnose/citation/single-file admission before application. Capture has none of that
model provenance. `run.ts` must not receive an invented Diagnosis to make its parser pass.

**Owner-approved decision (2026-11-02)**: a disjoint `CapturedVerificationResult` and label
**Candidate verification passed**; reuse actual build/oracle/security/integrity checks, preserve the
old result and its meaning. It states that no model diagnosis was evaluated, not that a missing
citation check passed. The owner explicitly accepted the recommended Plan and requested finalization;
the Spec/checklist now record this decision. Diagnosis integration remains outside this feature.

**Alternative**: expand diagnosis/evidence integration and the Spec before claiming legacy
`Verified Fix`. This is a product/provenance scope choice, not a hidden implementation shortcut.
Do not mark the old citation gate unevaluable and then ignore it in the legacy reducer.

## R3 — The existing developer tests intentionally assert the bug

**Observed**: `tests/unit/demo-chart.test.ts` has a `known-bad region filter` suite expecting eight
rows and a mismatch with the oracle. `apps/demo-chart/package.json` has build/typecheck scripts,
not a candidate-correctness `test` command. The scenario registry only allowlists its build argv.

**Decision**: keep developer regressions unchanged. Use one trusted prepared functional checker
outside the candidate worktree, loading the owned candidate filter module and comparing trusted
synthetic input with trusted expected rows; retain actual browser dataset/chart oracles afterward.
Select the fixed command in host code, never from a submitted chat body or changed package script.

**Probe**: Node 24.22.1 loaded the existing erasable TypeScript filter module directly and reproduced
the prepared overlapping-region defect. No new loader/package is needed for this prepared fixture.
The prepared candidate fixture must stay compatible with this narrow checker; arbitrary application
modules, transpilation, dependency installation, and test discovery are not generalized here.

## R4 — The real Studio frame is already driven and observed

**Observed**: `studio/launch.ts:createRunPorts` serves known-bad/patched builds and passes the actual
Studio frame to `BrowserCapture.capturePhase`. `studio/targetApp.ts:368` reconnects that frame and
checks the active served root/probe. `capture/browserCapture.ts:375` currently supports exactly one
prepared select action. `TargetPane.tsx` memoizes its iframe so renders do not reload it.

**Decision**: reuse this frame/build/capture path. Preserve frame identity during live phases; update
phase labels without remounting it. No mirrored browser, remote-video streaming, replay recording
presented as live, hidden successful fallback, new port or arbitrary browser-action family.

**Input probe**: a parent input cover, outer focus and non-tabbable iframe blocked the probe's human
pointer path while Playwright `selectOption` still changed the actual iframe select. This was a
headless library behavior probe, not a demonstration of the final headed Studio UI or exhaustive
keyboard isolation. Implementation tests must include keyboard focus and measured action behavior.
A direct root import of `playwright` initially failed under pnpm's dependency boundaries; using the
already installed root `@playwright/test` export worked. No dependency was installed to fix that probe.

## R5 — A completed result is not a retained live app

**Observed**: the legacy Studio worktree is disposed after its run, but the outer browser, target
server and Studio server normally remain until `StudioInstance.close()` (`studio/launch.ts:480`).
There is no standalone cancel endpoint/button; closure/process interruption is the current cancel
path. Studio reads persisted evidence through closed identifiers in `evidence/store.ts`.

**Decision**: the new path disposes app serving, capture listeners, operations, worktree and private
Git state before a passing final result. The existing Studio shell/evidence server remains only to
show the result and captured images until user close. A labelled captured-view pane replaces the
live frame. Browser closure during a run still interrupts/finalizes locally before full release.

**Alternatives rejected**: preserving a navigable target after finalization, closing the only result
page before the user can read it, pretending a dead iframe is still live, and adding a new reconnect,
cancel API, video archive or export service.

## R6 — The new path must be selected by trusted host configuration

**Observed**: `/api/runs` accepts only registered scenario ID and goal, and the normal server selects
and checks the model transport before calling its starter (`studio/server.ts:237`). Results and the
frontend are strict about the legacy result shape; accidental extra fields are rejected.

**Decision**: expose a sibling in-process captured-verification launcher with a closed candidate
snapshot. The same guarded routes serve an explicitly selected response/result family. The host
mode has no model selection/readiness step; normal Hero/Failure remain unchanged. A planned QA
launcher exercises this internal mode without adding a production CLI command or accepting patch
bytes, baseline selectors, filesystem paths or command argv from the browser.

## R7 — Identity and artifact fidelity without another export protocol

**Decision**: persist the exact patch's SHA-256, editing-session and verification-run IDs, baseline,
coverage, fixed check summaries and existing screenshots/manifests/result. Candidate raw bytes remain
an in-process value. Do not encode them into a fake legacy text-diff artifact, create model fields,
or add a patch upload/export API merely to satisfy the old Proof Trail implementation.

**Rationale**: the Spec requires executed candidate identity and existing visual evidence, not a new
portable bundle. A digest identifies bytes but is not proof of correctness; actual apply/fidelity and
checks must still run. Scan raw relevant candidate surfaces and final evidence/result with the
existing scanner before publishing; do not assume that base64 or a digest scans hidden content.

## R8 — Limits, dependencies, and cleanup remain concrete

**Decision**: inherit scenario time windows, existing Git input/output scales and sensitive-data
coverage. The apply/build/test/replay window shares one monotonic deadline and joined subprocess
ownership, including cancellation. Reuse installed dependencies with the existing owner-specific
worktree preparation; do not silently fetch packages for changed lockfiles. Missing dependencies
are explicit failures. Cleanup compares the original snapshot and removes exact owned resources,
not global Docker/worktree state. No new policy dimensions or performance SLA.

## Review record and limitations

Two native read-only research agents were dispatched per the planning workflow. Both failed with
owner-verification authentication before performing research. All code inspection and probes above
were performed by the parent; there is no independent agent review result to cite. This record
earlier proposed a read-only architecture/scope review as a pre-Tasks gate; that gate came from a
since-replaced local planning skill, is not part of the repository workflow, and is withdrawn. The
combined engine/API/UI/cleanup boundary is examined by the read-only Analyze after Tasks. The owner
subsequently approved the recommended Plan, but that product/design approval is not evidence that an
independent technical review occurred.
No implementation, feature acceptance suite, live model call, credential entry or deployment ran.

The initial candidate producer is a trusted prepared fixture. Reusing the local build/check
environment does not establish containment against arbitrary hostile repository/configuration code;
source snapshots are integrity evidence, not prevention. Do not turn this host-only prepared mode
into an advertised general untrusted execution path. Live-agent execution requires its own scoped
trust/execution decision rather than silently inheriting a stronger isolation claim from Spec 002.
