# Quickstart: Validate Visible Captured Verification

**Planning guide only.** The new files/launcher below are planned, not implemented. Do not report
these commands as executed acceptance. Current planning probes are recorded in [research.md](./research.md).
The owner approved the recommended Plan and distinct result label on 2026-11-02 and authorized
Tasks plus a read-only Analyze on 2026-11-03, followed that day by local implementation of the
T001-T042 scope. Implementation is now paused for delivery-boundary correction, not
authorized as one large PR (see [delivery-split-review.md](./delivery-split-review.md)).
No independent technical review was performed; the
earlier pre-Tasks review gate is withdrawn (see [plan.md](./plan.md)).

## Prerequisites

- Existing prepared Linux environment, Node 24+, pinned pnpm/dependencies, Git and Docker fixture.
- Existing headed Chromium/display or Xvfb for automated UI tests.
- Clean tracked original checkout and the prepared scenario/installed dependencies.
- No model API key, provider login, network provisioning or global resource cleanup is required.

Use the repository's existing dependency/toolchain setup; this feature does not install packages
for candidate-authored lockfiles. A missing dependency is a preparation/build failure.

## 1. Check actual test discovery after implementation

Before running a focused gate, confirm the planned files exist and Vitest discovers nonzero tests:

```bash
pnpm exec vitest list tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts tests/integration/captured-verification-studio.test.ts
```

A missing file or empty selection is an unimplemented gate, not a pass. Match finalized test names
to `tasks.md`; this guide does not create or complete Tasks.

## 2. Application and engine proof

```bash
pnpm exec vitest run tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts --no-file-parallelism --maxWorkers=1
```

Expected evidence:

- Baseline pinning works even when original HEAD is a different available commit; missing/wrong
  baseline and malformed inputs cannot pass.
- Complete text/binary/raw-path/add/delete/mode/link/gitlink effects match an independent expected
  tree. Capture summary tampering and partial application fail; no linked target is read or fetched.
- Original index/refs/config/tracked files/object-store contents stay unchanged outside the known
  owned worktree registration lifecycle, and that registration is removed afterward.
- Prepared build and functional checks actually execute on the candidate; a baseline-bug developer
  unit suite is not mistaken for the candidate checker.
- Missing editing-only prerequisites, failed build/checks, missing evidence, timeout/interruption,
  sensitive surfaces and injected cleanup/integrity failure cannot yield `passed`.
- Legacy `Verified Fix` parsing/reduction is neither loosened nor faked by the new result family.

## 3. Visible Studio proof

```bash
pnpm exec vitest run tests/integration/captured-verification-studio.test.ts --no-file-parallelism --maxWorkers=1
pnpm exec playwright test tests/e2e/captured-verification.spec.ts
```

Use the repository's headed display/Xvfb setup where required. Prove that the live target supplying
observations is the one shown in Studio, that the baseline/candidate stage and build/check summaries
are truthful, and that covered/focus-controlled user input does not disturb the prepared automation.
A missing visible frame must fail rather than trigger a hidden successful fallback.

Verify the final target is gone, completed evidence is labelled static, and the existing result shell
remains readable until user close. Closing mid-run must still finalize safely and release owned
resources. Save success/failure screenshot evidence of the delivered interaction during implementation;
a planning browser-library probe is not that evidence.

## 4. Full compatibility gates

```bash
pnpm typecheck
pnpm build
pnpm test --no-file-parallelism --maxWorkers=1
pnpm exec playwright test --pass-with-no-tests
git diff --check
```

Record actual discovered/passed/skipped counts, plus any unrun gates. Include original lifecycle,
capture-only, nine-gate/result/client/server and Hero/Failure acceptance paths. No fixture may
suppress discovery, globally weaken assertions, run a live provider, or prune unrelated resources.

## 5. Planned owner visual smoke after implementation

Plan one 2–3-minute success-path review, not a login or repeated manual failure checklist:

```bash
node tests/manual/captured-verification.mjs --case pass
```

The future QA launcher uses the deterministic editor/capture path and trusted host launch API; it
is not a production CLI mode. Its exact interface is finalized with Tasks. Confirm the real original
failure and candidate select replay are visible, final result/checks match, and the final pane is
labelled captured evidence rather than a navigable live app. Close Studio and check cleanup. Automated
tests cover negative cases. This manual smoke is planned, not claimed completed.

## Current stage

Spec and recommended Plan approved on 2026-11-02; Tasks and a read-only Analyze authorized on
2026-11-03. When this guide was written, no new application code, acceptance test, manual QA
launcher, provider connection, push or PR had been created. The result-label choice is resolved. No
independent technical review was performed and owner approval is not claimed as one. No
implementation authority follows from this guide, the finalized Plan or the Tasks authorization.
Later on 2026-11-03 the owner separately authorized local implementation covering T001-T042;
the subsequent delivery-size correction requires reviewable PR slices, not merely small commits.
Push and PR creation remain unauthorized. Implementation progress and evidence are recorded in
[tasks.md](./tasks.md); T036 syncs this guide after implementation.
