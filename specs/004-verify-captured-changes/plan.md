# Implementation Plan: Visible Verification of Captured Changes

**Branch**: `feat/004-verify-captured-changes` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Owner-approved scope, defaults and recommended Plan.
**Status**: Finalized with owner approval on 2026-11-02. The owner authorized Tasks and a read-only
Analyze on 2026-11-03, and later that day local implementation covering T001-T042. Further
implementation outside slice 1 was then paused after the owner-requested delivery-boundary
correction; see [delivery-split-review.md](./delivery-split-review.md). On 2026-11-03 the owner
authorized the slice-1 PR review loop: [PR #19](https://github.com/LLagoon3/flowproof/pull/19),
including push, in-scope corrections and exact-head GitHub Codex reviews. Later that day the owner
authorized merging PR #19 (merged as `16eecc0`) and local extraction and verification of slice 2
only, superseding the pause for that slice. The owner subsequently authorized publishing slice 2
as [PR #20](https://github.com/LLagoon3/flowproof/pull/20) and its GitHub Codex review loop,
including in-scope corrections and follow-up pushes. This supersedes the local-only publication
boundary; merge, deployment and later slices remain unauthorized. The loop allows an initial
exact-head review and up to three remediation/review rounds, as required by AGENTS.md.
**Code baseline**: `b2ed6ad8a268457ae2f6797e02f48a028d5c9b9b`; approved Spec commit `a3c51ca`.
**Approved claim clarification**: `ed450ad`. No independent technical review was performed, and
owner approval is not recorded as one.

## Summary

Add a concrete opt-in captured-candidate verification path. Reapply the Spec 003 candidate to its
pinned baseline in a fresh worktree, run the prepared checks, and drive/observe the actual existing
Studio iframe. Retain the original Hero/Failure flow unchanged. Reuse Git, workspace ownership,
Playwright capture, expected dataset/chart values, the evidence store, authentication, and Studio.

The important compatibility finding is that today's `Verified Fix` result requires nine specific
gates, including diagnosis/citation and one-file patch policy. A captured candidate has neither a
model diagnosis nor that one-file contract. **Owner-approved decision (2026-11-02)**: show a separately
labelled **Candidate verification passed** result for this path, never fabricate a diagnosis or
mark the old citation gate passed. The existing `Verified Fix` meaning remains unchanged. If the
owner later requests that final label, a separate scope/provenance decision and updated Spec are
required; this approved Plan does not weaken the old gate set.

## Technical Context

**Language/Version**: TypeScript 7.0.2, Node.js 24+ (local probe: 24.22.1).
**Primary Dependencies**: Existing Git 2.53.0, Playwright 1.64.1, Zod 4.6.7, React Studio, Docker
credential-free editor fixture. No new package, provider account, service, or deployment.
**Storage**: Existing `.flowproof/runs/<run-id>/` evidence/result storage and owned temporary roots;
one private Git index/object store for application. Candidate bytes remain in process, not a new
patch-upload/export service. Persist its raw-byte digest and existing visual evidence.
**Testing**: Existing Vitest/Playwright; synthetic Git fidelity tests, prepared editor and Canvas
scenario, process/resource assertions, strict client/server contract tests.
**Target Platform**: Current prepared Linux/Docker/headed-Chromium environment. No new OS, rootless,
remote viewer, or generic browser-action claim.
**Project Type**: One integrated engine/Studio capability in the current monorepo.
**Performance Goals**: Existing scenario total deadline (300 seconds for the prepared case), capture
window (45 seconds), and shared candidate apply/build/test/replay window (120 seconds). No benchmark
SLA or configurable policy registry. Check elapsed monotonic time as well as abort timers.
**Constraints**: Actual displayed/observed frame; no hidden fallback, no copied editing residue, no
writes to original checkout/index/refs, bounded commands, automatic cleanup and truthful results.
**Scale/Scope**: One captured candidate, prepared scenario, live target and verification run per
Studio launch. No model invocation, recursive submodule checkout, or arbitrary project runner.

## Constitution Check

*Pre-research check: PASS. Post-design: no proposed Constitution deviation; owner Plan approval
recorded on 2026-11-02. Cross-artifact consistency is checked by the read-only Analyze after Tasks,
as defined in `CONTRIBUTING.md`; no separate pre-Tasks review gate applies.*

- **I — Clean-room:** synthetic prepared data and existing dependencies; no credentials or private code.
- **II — Scope:** a concrete sibling path is necessary because binary/multi-file candidates and
  model-free provenance cannot be safely squeezed into the legacy contract. Reuse lower-level
  capabilities; no plug-in strategy registry, generalized workflow engine, second viewer/container,
  new network service, or retry controller.
- **III — Verification:** test-first for byte fidelity, input/result discrimination, frame identity,
  cancellation and cleanup. Planning probes below are not feature acceptance tests. An earlier
  draft required a read-only independent architecture review before Tasks; that gate came from a
  since-replaced local planning skill, is not part of the repository workflow, and is withdrawn.
  Historical record: no independent technical review was performed; the attempted research
  children failed authentication and are not counted as reviews.
- **IV — Trust:** pin baseline and trusted commands/oracles before candidate execution; preserve
  no-follow Git behavior, existing sensitive-data handling and guarded Studio routes. No expanded
  claim against malicious page-global observation forgery (issue #15).

## Project Structure

### Documentation

```text
specs/004-verify-captured-changes/
├── spec.md
├── checklists/requirements.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/captured-verification.md
└── quickstart.md
```

`tasks.md` is deliberately not created in Plan.

### Planned code surfaces, not implemented

```text
packages/flowproof/src/
├── worktree/session.ts                  # share preparation/build/ownership, legacy API preserved
├── worktree/capturedCandidate.ts        # pinned-baseline binary apply + private index fidelity
├── verify/capturedRun.ts                # concrete captured verification orchestration
├── verify/capturedContracts.ts          # new strict result/input boundary; not old RunResult
├── capture/browserCapture.ts           # reuse actual frame capture; no new browser action family
├── evidence/store.ts                   # reuse result/manifests/images; no arbitrary byte export
└── studio/{launch,server}.ts            # trusted in-process mode, same guarded routes and frame
apps/studio/src/
├── {api,state}.ts                       # strict disjoint result family and mode handling
├── components/{TargetPane,AgentPanel,ProofTrail}.tsx
└── components/CapturedVerification.tsx  # small check/result view in existing right-hand surface
tests/
├── {unit,contract,integration}/captured-verification*.test.ts
├── e2e/captured-verification.spec.ts
├── fixtures/captured-verification/      # prepared functional check and expected inputs
├── fixtures/editing-agent/agent.mjs     # additive deterministic Canvas candidate cases
└── manual/captured-verification.mjs    # QA launcher, not a new production CLI or service
```

**Structure decision**: Keep the existing `executeRun`, `validateCandidate`, nine-gate reducer and
legacy schemas unchanged in meaning. Share existing primitives, not a new abstract orchestration
layer. A private shared worktree owner may serve both public entry points; the legacy one-file
`applyDiff()` continues to enforce its current contract.

## Design

### 1. Admit a complete capture result and bind identity

The host supplies the completed `CapturingEditingSessionResult` and trusted loaded scenario through
an in-process launcher. Require completed editing, `captured`, valid candidate/session/baseline
identity and complete upstream cleanup before launching verification. Copy candidate byte ownership
and compute the patch digest over exact bytes. Capture-only failures/no-changes return a safe
non-success without inventing a verified run. Browser requests cannot supply patch bytes, repository
paths, build commands, model providers, or an alternate baseline.

### 2. Apply at the recorded baseline without contaminating original metadata

Extend owned worktree preparation with a narrow sibling operation that resolves the recorded full
commit rather than assuming current original HEAD. Preserve the original snapshot independently;
an older available baseline is legitimate. The current clean-tracked-checkout preflight remains.

Prepare a private bare Git directory/index/object store outside candidate paths, with trusted
original objects as a read-only alternate. Seed the index from the pinned baseline and refresh its
stat state before `git apply --check --index --binary -`; then apply the exact bytes once. Default Git
path/link checks stay enabled. No `--unsafe-paths`, `--reject`, whitespace repair, 3-way merge,
submodule fetch, local hook/filter execution, or partial-candidate continuation.

Compare the resulting private-index diff/entry identities with the candidate summary using raw
NUL-delimited path bytes, modes and object IDs. Failed application or fidelity ends the run and
discards that owned target. Private indexing preserves gitlink references without writing new blobs
into the original object store; nested worktrees are not populated or inspected. The same existing
coverage note is shown. Do not pass this patch through UTF-8 string conversion or the 20-KB
single-file validator. Reuse the bounded capture Git runner/environment where applicable, not its
workspace extraction routine (a linked worktree has different `.git` semantics).

### 3. Run prepared checks, not the repository's known-bad developer suite

Load scenario/oracle/command selection from trusted original metadata before application. Reuse the
registered app build and existing before/after browser capture/oracles. Add one fixed credential-free
functional check for the prepared filter using Node 24's existing type-stripping support and trusted
synthetic input/expected rows; its checker comes from outside the candidate worktree and loads the
candidate module from the explicit owned target. This is not a runner for arbitrary user commands.

Do not run `tests/unit/demo-chart.test.ts` as the candidate correctness test: it intentionally asserts
that the baseline bug exists. A candidate fix should fail those developer baseline assertions. Test
selection must be explicit and report discovery/execution, not a zero-test pass. Prepared multi-file
editor fixtures fix the filter and include additional versioned text/binary/mode effects; negative
fixtures cover omitted editing-only inputs and checks that fail despite plausible page appearance.

### 4. Reuse the actual visible frame and bound user input

The trusted host mode supplies the fixed captured candidate before Studio launch. The existing case
start interaction starts this fixed verification, not a model call. Bypass model readiness only for
this host-configured mode; normal Hero/Failure credential behavior is unchanged. No new production
CLI, user patch-upload route, provider selection field, server, port, or iframe is introduced.

Build/reproduce the pinned baseline, show its real prepared select action, apply/build/check the
candidate, then `TargetApp.serveBuild/reconnect` that same Studio frame and capture replay there.
Use existing phase events plus bounded activity messages for apply/build/test substeps; no synthetic
`diagnosing` stage or legacy gate events for checks that did not occur. Result polling remains
authoritative; SSE remains live-only with no reconnect/replay project added.

During measured phases, the existing pane gets a transparent input cover, focus moved to the outer
Studio, and the iframe removed from keyboard tab order. The prepared scenario uses programmatic
`selectOption`, which a local browser probe confirmed works through this cover. This is a prepared
scenario UX guard, not a general click/fill broker or adversarial isolation mechanism. Generic browser
input would require a separate design; it is not added to make the acceptance example larger.

### 5. Finalize the run but keep the result shell, not the app runtime

Capture final evidence before disposal. Stop/detach the target frame and its application serving,
join owned operations, remove owned worktree/private Git state, then compare original integrity and
perform whole-run scanning of the final result and evidence. Any cleanup/integrity failure prevents
`passed`. Preserve failed and unevaluated check summaries for other terminal paths.

Keep the existing Studio result page/guarded evidence server available until the user closes Studio,
but remove the verification target/runtime. Replace its live pane with clearly labelled captured
before/after evidence. This is necessary to let the user read a completed result; it is not keeping
a live debug session. The shell browser closes through existing user-close/process interruption.
Closing during a run aborts it and still finalizes to the existing local evidence path. Cancellation
means the existing close/interrupt path, not a newly promised cancel endpoint or button.

### 6. Result compatibility and review boundary

The approved new result design is strict and explicitly discriminated; it carries exact candidate identity,
fixed checks, safe outcome/reason, evidence references and cleanup facts. It does not contain invented
provider, diagnosis, citation or one-file-scope success fields. The frontend renders it in the existing
activity/result surface, separately from `Verified Fix`. See [data model](./data-model.md) and
[contract](./contracts/captured-verification.md). An old parser must reject this new family, not
silently coerce it; new Studio parsers accept the two families through an explicit union.

## Verification and Delivery

- **SC-001:** independently reconstruct all supported entry effects, baseline != original HEAD,
  wrong/missing baseline, tampered summary, binary/raw path/mode/link/gitlink and original object-store
  preservation. No lossy artifact conversion.
- **SC-002/003:** deterministic passing, hidden-edit dependency, apply failure, functional/build
  failure, visually plausible but wrong replay and required-evidence failure; only a fully checked
  and clean candidate run passes.
- **SC-004/006:** same real frame/action/served-build identity; baseline versus candidate labels,
  user input cover, failed target load, final captured-view label, failed/unevaluated checks.
- **SC-005/007:** every terminal path, original snapshots, exact process/resource cleanup, legacy
  contracts and Hero/Failure regressions. No live-model account or global resource pruning.
- Future validation commands and the planned short owner visual smoke are in [quickstart.md](./quickstart.md).
- Small Plan probes passed for private-index Git fidelity, Node loading of the current prepared
  module, and covered-frame select automation. Product acceptance has not been executed.

## Approved Decisions and Remaining Risks

1. **Result wording:** the owner approved `Candidate verification passed`, not legacy `Verified Fix`,
   on 2026-11-02. Spec/checklist record the same claim. All ten candidate checks remain mandatory;
   no model diagnosis/citation evaluation or legacy-gate bypass is implied.
2. **Result-shell lifetime:** only the Studio result shell remains until user close; the application
   and worktree are disposed. This interpretation must remain visible in UI and tests.
3. **Dependencies:** reuse currently prepared dependencies; lockfile changes are applied faithfully
   but do not imply automatic package installation or network provisioning. Missing dependencies
   produce explicit preparation/build failure, not an altered candidate.
4. **Independent review (historical):** two native research dispatches failed owner-verification
   authentication before doing work. Research/probes were completed by the parent; no independent
   agent approval is claimed. Owner Plan approval does not prove a technical review. The earlier
   pre-Tasks review gate is withdrawn (see Constitution Check); the combined engine/API/UI/cleanup
   boundary is examined by the read-only Analyze after Tasks. No review is claimed here.
5. **Manual burden:** one planned 2–3-minute success-path visual smoke after implementation, with
   failures covered automatically. No owner login, QR pairing, or credential setup is needed.
6. **Execution trust:** this initial path executes trusted prepared fixture candidates through the
   existing local verification setup. It is not an isolation boundary for arbitrary hostile
   repository/build code. The host-selected mode must not be advertised as a general untrusted
   code execution service; production live-agent execution is a later scope decision. Snapshot
   checks detect unexpected original changes, not a proof that candidate code could never cause them.

### Requirement coverage in the approved Plan

| Requirement | Design boundary | Acceptance evidence planned |
| --- | --- | --- |
| FR-001 | Host input and pinned baseline | Input/identity and non-current-HEAD fixtures |
| FR-002 | Binary private-index application | Exact independent raw path/mode/blob/gitlink reconstruction |
| FR-003 | Prepared build/check/oracle reuse | Actual execution and immutable expected values; verdict wording reviewed |
| FR-004 | Existing real iframe/capture | Same-run frame/build identity and baseline/candidate actions |
| FR-005 | Mode-aware existing Studio progress | Actual stage/failure/unevaluated and final static-view assertions |
| FR-006 | Disjoint strict result | Non-success distinctions and no legacy provenance bypass |
| FR-007 | Prepared input guard and close | Input/focus/automation, target-load and interrupt cases |
| FR-008 | Exact owner cleanup | All terminal paths and explicit original-integrity failures |
| FR-009 | Digest plus existing evidence | Candidate identity, result persistence and shell-only retention |
| FR-010 | Opt-in sibling compatibility | Unchanged lifecycle/capture/Hero/Failure and strict old parsers |

## Complexity Tracking

No proposed Constitution violation. The private application index is required to preserve binary and
gitlink fidelity without original object writes. The disjoint result family avoids falsely passing
legacy provenance gates. Other planned changes are adapters to the existing Studio and ownership
path, not independent products. They can still be reviewed as sequential foundation, engine,
Studio contract/state, and visible-runtime slices. One Spec does not imply one PR; the prior
one-PR statement did not establish an intentional owner exception to CONTRIBUTING.md.
Keep implementation and its tests together in each slice, validate and report that slice, then
stop. See [the delivery ledger](./tasks.md#delivery-slices) and
[decomposition evidence](./delivery-split-review.md).
