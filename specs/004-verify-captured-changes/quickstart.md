# Quickstart: Validate Visible Captured Verification

This guide describes the delivered local slice-4 checkout. Slices 1–3 merged through
[PR #19](https://github.com/LLagoon3/flowproof/pull/19),
[PR #20](https://github.com/LLagoon3/flowproof/pull/20) and
[PR #21](https://github.com/LLagoon3/flowproof/pull/21). Slice 4 is local-only, based on
`bcb29e5`; publication and review are separate owner-authorized actions. Automated evidence and
remaining gaps are recorded in [delivery-split-review.md](./delivery-split-review.md).
The owner-only visual smoke below remains unperformed unless explicitly recorded otherwise.

## Prerequisites

- Existing prepared Linux environment, Node 24+, pinned pnpm/dependencies, Git and Docker fixture.
- Existing headed Chromium/display or Xvfb for automated UI tests.
- Clean tracked original checkout and the prepared scenario/installed dependencies.
- No model API key, provider login, network provisioning or global resource cleanup is required.

Use the repository's existing dependency/toolchain setup; this feature does not install packages
for candidate-authored lockfiles. A missing dependency is a preparation/build failure.

## 1. Check actual test discovery in this checkout

Before running a focused gate, confirm the delivered files exist and Vitest discovers nonzero tests:

```bash
pnpm exec vitest list tests/contract/captured-verification-contract.test.ts tests/unit/captured-verification.test.ts tests/integration/captured-verification-git.test.ts tests/integration/captured-verification-studio.test.ts tests/ui/captured-verification.test.ts
pnpm exec playwright test --list tests/e2e/captured-verification.spec.ts
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
pnpm exec vitest run tests/integration/captured-verification-studio.test.ts tests/ui/captured-verification.test.ts --no-file-parallelism --maxWorkers=1
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

## 5. Owner visual smoke (human-only)

Run one 2–3-minute success-path review after the automated gate, not a login or repeated manual
failure checklist. Build first; the QA launcher accepts only `--case pass` and imports built
FlowProof modules, not TypeScript source or test helpers:

```bash
pnpm build
node tests/manual/captured-verification.mjs --case pass
```

The QA launcher uses the deterministic editor/capture path and trusted host launch API; it
is not a production CLI mode. It clones committed HEAD, links existing prepared dependencies, builds the fixed local fixture
image and pins its immutable image ID. It never installs candidate dependencies or invokes a model. Confirm the real original
failure and candidate select replay are visible, final result/checks match, and the final pane is
labelled captured evidence rather than a navigable live app. Close Studio and check cleanup. Automated
tests cover negative cases. This manual smoke is not claimed completed by automated launcher or headed tests.

## Current stage

The current authorization covers local extraction and validation of slice 4 only. It adds no
production CLI mode, live agent/provider, export, hosting or deployment. T041 requires the owner;
automation does not record its visual acceptance. See the slice-4 report and task ledger for actual
discovery, compatibility and final-gate results. The prepared execution trust boundary and excluded
adversarial observation redesign (issue #15) remain unchanged.
