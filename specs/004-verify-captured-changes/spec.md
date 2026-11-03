# Feature Specification: Visible Verification of Captured Changes

**Feature Branch**: `feat/004-verify-captured-changes`

**Created**: 2026-11-02

**Status**: Specification and recommended Plan approved by the owner on 2026-11-02; Tasks and a
read-only Analyze authorized on 2026-11-03. Later on 2026-11-03 the owner authorized local
implementation covering T001-T042. Further implementation is paused for delivery-boundary correction;
this was not an intentional exception to the repository's reviewable-PR policy. Push and PR
creation are not authorized.

**Input**: Apply the candidate extracted by Spec 003 to a fresh worktree from the same baseline,
run the existing verification, and let the user watch the actual browser verification in Studio.
Reuse existing capabilities rather than introduce another validation framework or broad UI redesign.

## Clarifications

### Session 2026-11-02

**Confirmed direction**:

- The owner requested this specification draft and review before proceeding.
- Candidate application and re-verification use a fresh baseline worktree in the existing execution
  environment; no dedicated second verification container is required.
- The owner chose visible browser verification: the user should see the real page being verified,
  not a separate demonstration page or a recording presented as a live run.
- Retain the earlier preference for ordinary Git changes, automatic cleanup, and minimal new policy.

**Defaults approved by the owner on 2026-11-02**:

- Start with the existing prepared scenario and a deterministic credential-free editing fixture;
  production coding-agent connections and automatic repair remain later features.
- Automation owns target-page interactions during measurement. The user watches progress and can
  use the existing cancellation path; interactive debugging and manual input during replay are not
  added in this feature.
- After finalization, show the result and existing captured visual evidence. Do not retain a live
  worktree, server, or browser solely for post-run exploration; static evidence is labelled as such.
- Preserve the current verification requirements and compatibility paths. No language-independent
  project runner, new scenario family, or new success criterion is introduced here.
- The owner approved these defaults and requested Plan preparation followed by owner review.
  This approval does not authorize Tasks, implementation, or publication.

**Plan decisions approved by the owner on 2026-11-02**:

- The owner accepted the recommended Plan and requested that it be finalized.
- A successful captured-candidate run is labelled **Candidate verification passed**, separately
  from the existing **Verified Fix** claim. It proves the candidate passed the prepared application,
  build, functional, browser, evidence/security, cleanup and original-integrity checks; it does not
  claim that a model diagnosis or its citations were evaluated. Existing Verified Fix requirements
  remain unchanged; diagnosis/provenance integration is outside this feature.
- The real verification target is shown during execution. After finalization, dispose that target
  and worktree while retaining the Studio result shell and labelled captured evidence until close.
- Keep the prepared-scenario/dependency scope, existing close/interrupt cancellation path and short
  post-implementation visual review described in Plan. No automatic dependency installation,
  interactive post-run app, general project runner or live-agent integration is added.
- This is owner approval of the Plan, not evidence of an independent technical review or successful
  implementation. Tasks, implementation, push and PR creation were not authorized by this approval.

### Session 2026-11-03

- The owner authorized Tasks for the approved Spec and Plan, followed by a read-only Analyze.
  Implementation, push and PR creation remain unauthorized. No product requirement changed.
- Later the same day, the owner authorized local implementation covering T001-T042. The initial
  implementation treated that range as one PR, but the owner challenged this grouping and recalled
  the existing phase/checkpoint delivery policy. Small commits do not replace reviewable PRs.
  Further implementation is paused while the existing work is preserved and decomposed; see
  [the delivery review](./delivery-split-review.md). Push, PR creation, review requests, merge and
  deployment remain unauthorized. No product requirement changed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verify the Captured Changes Alone (Priority: P1)

As a developer, I want the saved candidate tested from its original starting state so that a
successful result does not depend on unrecorded edits or files left in the editing workspace.

**Why this priority**: Change extraction is already available. Applying that candidate independently
is the missing link between editing and a trustworthy verification result.

**Independent Test**: Supply a deterministic multi-file candidate for the prepared scenario. Apply
it to its recorded baseline, compare the resulting versioned state with the independently expected
state, and run the existing required checks without a live model or retained editing workspace.

**Acceptance Scenarios**:

1. **Given** a captured candidate and its recorded baseline, **When** verification starts, **Then**
   a fresh worktree receives only that candidate's versioned changes; the original checkout is not
   edited and the editing workspace is not reused as the verification target.
2. **Given** supported ordinary Git changes, **When** the candidate is applied, **Then** its captured
   file contents, paths, additions, deletions, modes, and link/reference effects are preserved, with
   the same main-repository and reference-only coverage as Spec 003.
3. **Given** a candidate that fixes the prepared defect, **When** the required build, tests, and
   scenario replay pass, **Then** the result identifies that candidate and the successful checks;
   the successful result is labelled Candidate verification passed, not Verified Fix, and requires
   every mandatory check of this path without weakening the existing Verified Fix conditions.
4. **Given** missing baseline data or a candidate that cannot apply completely, **When** application
   is attempted, **Then** verification stops with an application/preparation failure, not a partial
   application presented as a tested candidate.
5. **Given** an editing-only temporary file required by the proposed fix, **When** verification runs
   without that file, **Then** the failing check prevents success rather than importing the missing
   file from the disposed editing workspace.

---

### User Story 2 - Watch the Actual Browser Verification (Priority: P1)

As a developer, I want to watch the original problem and the candidate replay in the existing
Studio so that I can understand what was exercised and why the result was reached.

**Why this priority**: Visible execution is part of the requested feature, not a separate presentation
layer that can disagree with the checks used to decide the result.

**Independent Test**: Run the prepared success and failure fixtures in Studio. Observe the actual
scenario actions, target transition, stage indicators, and final result; verify that the displayed
candidate page is the page from which the replay observations are collected.

**Acceptance Scenarios**:

1. **Given** a prepared verification run, **When** the baseline defect is reproduced and the candidate
   is subsequently replayed, **Then** the user sees those real target pages and automated scenario
   actions in sequence, with the current phase clearly distinguished.
2. **Given** build or tests are running, **When** browser replay has not yet started, **Then** Studio
   shows the actual stage and a bounded check summary; it does not imply that a stale baseline page
   is already the candidate verification page.
3. **Given** a candidate replay, **When** automation clicks, types, or triggers the prepared browser
   interactions, **Then** those actions and the resulting page behavior are visible on the same
   target used to collect verification observations, not on an independently served lookalike.
4. **Given** a page that looks correct but fails an existing required check, **When** the result is
   finalized, **Then** Studio shows the failed result and its reason rather than a verified claim.
5. **Given** target loading fails or the user cancels or closes the run, **When** verification stops,
   **Then** the run does not succeed and the existing cleanup path still executes; a missing or
   disconnected verification page is not silently replaced by an unseen successful replay.

---

### User Story 3 - Receive an Honest Result and Finish Cleanly (Priority: P2)

As a developer, I want to distinguish a bad candidate from an execution problem, inspect the
resulting evidence, and finish without abandoned worktrees or changes to my original checkout.

**Why this priority**: Visible verification must not require keeping disposable environments alive
or hiding cleanup failures behind an otherwise successful candidate result.

**Independent Test**: Exercise success, application failure, check failure, execution error, timeout,
cancellation, and cleanup failure with synthetic fixtures. Check result identity, reasons, original
integrity, owned resources, and what Studio presents after the live target is gone.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the user inspects its result, **Then** the candidate/baseline,
   evaluated and skipped checks, outcome, and safe failure reasons agree with the executed run.
2. **Given** any terminal outcome, **When** finalization completes, **Then** cleanup is attempted for
   the owned worktree, processes, and browser resources and original-checkout integrity is reported.
3. **Given** successful candidate checks but failed cleanup or integrity checks, **When** the run
   finalizes, **Then** the failure remains explicit and cannot yield an overall verified success.
4. **Given** cleanup has disposed the live target, **When** Studio presents captured before/after
   evidence, **Then** it is identifiable as captured evidence, not an apparently still-running app.

### Edge Cases

- Only a complete `captured` result enters candidate verification. No changes, rejection, capture
  failure, or an unsuccessful editor outcome does not become a successful verification by default.
- A mismatched or unavailable baseline, incomplete application, failed build/test, failed browser
  load/replay, or absent required observations produces a non-success result with an appropriate reason.
- No additional text-only, single-file, extension, or predeclared editable-path restriction is added.
  This does not turn a captured submodule reference into a recursively populated nested worktree.
- Changing a build/test script is a versioned change, but neither that script's own success claim nor
  the candidate's page text replaces existing required scenario observations and expected outcomes.
- A candidate page that cannot be observed in the Studio target is not treated as visibly verified
  by running a separate hidden fallback page. Existing intentional headless/non-capture paths remain
  separate and retain their behavior.
- Cancellation, timeouts, and browser closure stop the owned run, preserve an honest partial check
  summary, and still attempt cleanup. No debugging retention, reconnect protocol, or retry is added.
- The final visual evidence may outlive the disposable target through the existing evidence path;
  keeping a navigable live preview after completion is not required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST associate verification with one complete captured candidate and its
  recorded baseline, reject unavailable or inconsistent inputs before a success claim, and derive
  the candidate verification target from a fresh baseline worktree rather than the editing workspace.
- **FR-002**: Candidate application MUST preserve the ordinary Git-representable changes and coverage
  supported by Spec 003 without reintroducing one-file/text-only/path-allowlist restrictions; an
  application that cannot be completed MUST not be reported as a successful candidate application.
- **FR-003**: Verification MUST run the existing scenario's required build, test, and browser checks
  against the applied candidate. Success MUST be labelled Candidate verification passed, not
  Verified Fix; all mandatory candidate checks MUST pass without weakening the existing Verified
  Fix conditions or claiming unevaluated model diagnosis/citations. Expected
  outcomes and the required check selection MUST come from the trusted scenario/caller, not a model
  claim or a candidate-authored success message.
- **FR-004**: The existing Studio MUST show the actual verification target and its automated scenario
  actions, including the baseline failure reproduction and candidate replay, clearly distinguishing
  their phases. The displayed replay target and the observed verification target MUST be the same.
- **FR-005**: Studio MUST display actual preparation, application, build/test, replay, and finalization
  progress, identifying failed and unexecuted checks without presenting stale or captured content as
  a live successful candidate run. It MUST reuse the current surface rather than require a new UI.
- **FR-006**: Final results MUST distinguish preparation/application failures, failed candidate checks,
  execution errors, timeout, and cancellation using safe reasons and existing outcome conventions.
  Missing required evidence or checks MUST prevent a verified result; visual appearance alone is not
  a success criterion.
- **FR-007**: Automation MUST own target-page input during measured replay; the user MUST be able to
  watch and use the existing cancellation path. Target loading failure, closure, or cancellation MUST
  not produce an unseen fallback success.
- **FR-008**: Existing automatic cleanup and original-checkout integrity reporting MUST run for all
  terminal paths. Cleanup/integrity failure MUST remain visible and prevent overall verified success.
- **FR-009**: The completed result MUST identify the executed candidate/baseline and existing visual
  evidence, clearly separating completed evidence from a live target, without requiring runtime
  retention or introducing new storage/export surfaces.
- **FR-010**: Existing lifecycle-only editing, capture-only callers, and legacy Hero/Failure behavior
  MUST remain compatible. This feature MUST add no live provider connection, automatic model repair,
  original-checkout application, automatic commit/push/PR, or unrelated observation-isolation redesign.

### Key Entities

- **Captured candidate**: The complete change set and baseline identity produced by Spec 003.
- **Verification run**: One candidate's fresh-baseline application and required check execution.
- **Visible target**: The real page Studio displays and automation observes for that run and phase.
- **Verification result**: Candidate/baseline identity, check outcomes, safe reasons, existing evidence,
  and cleanup/integrity facts; not a second source of truth competing with existing final verdicts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A prepared multi-file fix is reproduced from its saved changes alone, with every
  expected versioned file effect matching the independently expected result after application.
- **SC-002**: In the prepared passing case, the user sees both the original defect and the actual
  candidate replay; the required checks pass and the final result agrees with those observations.
- **SC-003**: In the hidden-edit-dependency, application-failure, failed-check, and visually-correct-
  but-wrong-result fixtures, zero runs are incorrectly reported as verified.
- **SC-004**: In successful and failing visible runs, all displayed target phases and replay actions
  belong to the same run and candidate being evaluated; zero independently served lookalikes or
  recordings are presented as the live verification target.
- **SC-005**: For every tested terminal path, original-checkout integrity and owned-resource cleanup
  are checked; zero cleanup/integrity failures are presented as overall verified success.
- **SC-006**: A viewer can distinguish live replay, check failure, interruption, and completed visual
  evidence from Studio's existing page without needing raw terminal output to identify the outcome.
- **SC-007**: Existing lifecycle-only, capture-only, and Hero/Failure acceptance suites retain their
  expected behavior, and acceptance of this feature requires no live coding-model account.

## Assumptions

- The initial use case is the existing prepared scenario and execution environment. This is not
  universal validation of every project, language, test runner, or browser application.
- A deterministic credential-free editor supplies candidates for acceptance. Connection to a real
  coding agent remains separate; existing production model behavior is not silently replaced.
- Build/test preparation, browser execution, evidence handling, and resource limits reuse the current
  trusted setup. This does not claim cache-free or hermetic execution, nor copy editing-only files
  into verification as undeclared prerequisites.
- Existing verification is sufficient for the current accepted threat model. Resistance to arbitrary
  malicious candidate code forging page-global observations remains the separate work in issue #15.
- The owner approved the interaction and finalization defaults before Plan. Exact interfaces,
  resource mechanics, command wiring, and UI implementation decisions belong to the recommended
  Plan approved on 2026-11-02. Independent technical review is not implied by owner approval.

## Scope and Delivery Boundary

**Included**: fresh-baseline candidate application, existing verification and verdict integration,
real-time visibility through existing Studio, explicit results, cleanup, and deterministic fixtures.

**Excluded**: a broad UI redesign or separate viewer, a universal validation framework, dedicated second verification container,
new file-permission/policy engines, recursive nested-worktree capture/population, live coding-agent
credentials, automatic repair/retry, manual exploration or debugging retention, exports/hosting,
manual deployment, and the adversarial observation-boundary redesign tracked by issue #15.

The approved scope is one cohesive capability: "apply this captured candidate, watch its real
verification, receive an honest result, and clean up." One capability does not imply one PR.
Follow the reviewable delivery slices in [tasks.md](./tasks.md#delivery-slices) and the
[local decomposition review](./delivery-split-review.md); the previous one-PR statement was an
incorrect application of implementation authorization, not an owner-approved large-PR exception.
This contributes another part of issue #14 without claiming the full live-agent workflow is
complete. Preserve existing local work, deliver one slice at a time, then report and stop.
After an authorized PR merges, start the next authorized slice from updated main. Push and PR
creation remain separate actions requiring owner authorization.
