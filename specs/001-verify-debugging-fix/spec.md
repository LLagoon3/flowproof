# Feature Specification: Evidence-Grounded Fix Verification

**Feature Branch**: `feat/001-verify-debugging-fix`

**Created**: 2026-10-27

**Status**: Ready for Tasks

**Input**: User description: "Define FlowProof's first hackathon MVP together, starting with the problem and primary user."

## Problem Statement & Primary User

### Problem

AI coding tools can produce plausible fixes from error descriptions, logs, and screenshots, but they do not reliably prove that a proposed change fixes the observed problem. This is especially difficult for visual web defects where the rendered result is not fully represented by page structure alone.

Today, a developer must manually connect failure reproduction, runtime evidence, diagnosis, source changes, replay of the same scenario, and the final verification decision. Because this process is fragmented, it is difficult to distinguish a plausible fix from a verified fix, and repeated manual checking consumes limited development time.

### Primary User

The primary user is an indie or solo full-stack developer who builds and operates a web application without a dedicated quality-assurance team or debugging platform. This developer can reproduce a defect locally and wants a fast, trustworthy way to determine whether an AI-proposed change actually resolves it.

### Core User Need

When an AI proposes a change for a reproducible visual web defect, the developer needs the proposal to be tied to evidence from the failing run and evaluated by replaying the same scenario, so they can tell whether it is verified rather than merely plausible.

### Verification Semantics

`Verified Fix` means that the captured defect no longer reproduces under the agreed replay and verification conditions. The status is granted only when all of the following are true:

For this MVP, the expected filtered dataset and expected chart result are authored before execution and stored with the predefined scenario as a fixed verification oracle. They MUST NOT be inferred from the failing run or defined solely by the same AI that produces the diagnosis or candidate change.

The predefined scenario, verification oracle, and permitted source boundary are loaded automatically for the MVP run. The developer is not required to enter file paths, expected values, or structured verification rules for each execution.

- The defect was reproduced in the original scenario and evidence was captured from that failing run.
- The diagnosis and candidate change are connected to evidence from that run.
- The candidate change was applied successfully in an isolated project copy.
- After the agreed filter is selected during replay, the resulting filtered data exactly matches the predefined expected dataset.
- The Canvas-rendered chart shows the predefined number of bars, and every bar's label and value match the expected result.

If any required condition fails or cannot be evaluated, the result remains `Unverified`. `Verified Fix` does not claim universal correctness, absence of regressions outside the agreed checks, production readiness, or identical behavior in environments that were not evaluated.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Obtain a Verified Fix (Priority: P1)

An indie or solo full-stack developer opens a local FlowProof workspace with the prepared web
application on the left and the FlowProof agent on the right. The developer starts the run through
chat, watches the agent reproduce the defect and expose its evidence and verification progress, and
receives a `Verified Fix` result only when replay satisfies every agreed verification condition.

**Why this priority**: This closed loop is the product's primary value and must be independently demonstrable as the minimum viable product.

**Independent Test**: Open the prepared local workspace and start the agreed known-bad scenario
through chat without manually entering verification configuration or editing the candidate change.
The story succeeds when the same workspace shows the reproduced failure, agent activity, evidence,
isolated candidate application, replay, and accurate final result.

**Acceptance Scenarios**:

1. **Given** FlowProof is opened for the prepared scenario, **When** the workspace becomes ready,
   **Then** it shows the live application on the left and chat, agent activity, evidence, and gate
   status on the right.
2. **Given** the workspace is ready, **When** the developer sends the natural-language start
   request, **Then** FlowProof starts the fixed scenario without asking for file paths, expected
   values, or structured verification rules.
3. **Given** the agreed scenario is in its known-bad state, **When** the run starts, **Then** the
   visible application reproduces the failure and FlowProof records evidence from that run.
4. **Given** the run advances, **When** FlowProof changes phase or captures evidence, **Then** the
   right panel shows the ordered activity and available Evidence IDs without exposing secrets.
5. **Given** the failure evidence exists, **When** FlowProof produces a candidate change, **Then**
   the candidate's factual claims are connected to evidence from the same run.
6. **Given** a candidate change is ready, **When** FlowProof evaluates it, **Then** FlowProof applies
   it only to an isolated copy and leaves the developer's tracked files, Git index, checked-out
   branch, HEAD, and history unchanged.
7. **Given** the candidate change was applied successfully, **When** FlowProof replays the same
   scenario, **Then** the left application shows the replay and the result becomes `Verified Fix`
   only if every agreed verification condition passes.
8. **Given** the run is finalized, **When** the developer reviews the result, **Then** the same
   workspace connects the chat request, failure evidence, diagnosis, candidate change, replay,
   gate outcomes, and final status.
9. **Given** the run is finalized as `Verified Fix`, **When** FlowProof hands the result to the
   developer, **Then** it provides the verified diff and in-workspace Proof Trail without
   committing or changing the developer's tracked files or Git state.

---

### User Story 2 - Reject an Unverified Fix (Priority: P2)

An indie or solo full-stack developer runs a deliberately failing evaluation case and sees FlowProof refuse to present the candidate change as verified. When evidence is invalid, isolated application is unsuccessful, or replay does not satisfy an agreed verification condition, the result remains `Unverified` and identifies the failed gate.

**Why this priority**: A separate failure demonstration proves that FlowProof is a verification system rather than a tool that always approves its own suggestions.

**Independent Test**: Start the predefined Failure case from the local workspace. The story
succeeds when the right panel stops before unsafe application, shows the failed gate and supporting
context, the final result remains `Unverified`, and the original tracked files and Git state remain
unchanged.

**Acceptance Scenarios**:

1. **Given** a required evidence reference is invalid, **When** FlowProof evaluates the candidate, **Then** it rejects the unsupported claim and keeps the result `Unverified`.
2. **Given** the candidate cannot be applied within the permitted isolated scope, **When**
   application is attempted, **Then** the result remains `Unverified` and the original tracked
   files and Git state remain unchanged.
3. **Given** the candidate was applied in isolation but replay fails any agreed verification condition, **When** the run is finalized, **Then** FlowProof reports `Unverified` and identifies the failed condition.
4. **Given** the run is `Unverified`, **When** the developer reviews the result, **Then** the same result view connects the relevant evidence, candidate change, failed gate, and final status without requiring a separate review workspace.
5. **Given** the run remains `Unverified`, **When** FlowProof hands the result to the developer,
   **Then** it does not create a commit or modify the developer's tracked files or Git state.

### Edge Cases

- If a required evidence item cannot be captured or evaluated, the affected gate remains failed and the final result is `Unverified`.
- If a diagnosis or candidate claim references an Evidence ID that does not exist in the same run, the claim is rejected as unsupported.
- If a candidate change targets content outside the permitted source boundary, application is rejected and the result remains `Unverified`.
- If candidate application succeeds but either the filtered data check or any Canvas chart check fails, the result remains `Unverified`.
- If sanitization removes information required to evaluate a gate safely, the system reports that gate as unevaluable rather than exposing the sensitive value or granting `Verified Fix`.
- If the workspace event stream disconnects while the browser remains open, the run continues and
  the authoritative final result remains available, but the MVP does not promise replay of missed
  activity events.
- If the Studio page or browser closes during an active run, FlowProof stops the visible run,
  finalizes it as `Unverified`, writes only artifacts available for the phases reached, and cleans
  up the isolated copy without changing the original tracked files or Git state.
- If the embedded prepared application cannot load, the run does not call the model or apply a
  patch, does not invent a failure Evidence Bundle or screenshot, and reports
  `failure_reproduced` and dependent gates as unevaluable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST load the predefined scenario, fixed verification oracle, and permitted source boundary without requiring the developer to enter file paths, expected values, or structured verification rules for each run.
- **FR-002**: The system MUST reproduce the known-bad Canvas filter defect before producing or evaluating a candidate change.
- **FR-003**: For every run that reaches failure capture, the system MUST produce a failure Evidence
  Bundle containing the reproduction actions, expected and observed filtered data, a failure
  screenshot, console errors, a sanitized network summary, and relevant source context selected
  from within the permitted boundary. A run that ends before failure capture MUST NOT invent this
  bundle or its artifacts.
- **FR-004**: The system MUST assign a stable Evidence ID to every captured evidence item so later claims and results can reference the exact supporting item.
- **FR-005**: The system MUST produce an evidence-grounded diagnosis and candidate diff whose factual claims reference Evidence IDs from the same failure run.
- **FR-006**: The system MUST reject unsupported evidence references and MUST NOT apply a candidate change outside the permitted source boundary.
- **FR-007**: The system MUST apply the candidate change only to an isolated project copy and MUST
  leave the developer's original tracked files, Git index, checked-out branch, HEAD, and history
  unchanged.
- **FR-008**: The system MUST replay the same predefined scenario after candidate application and capture the observed filtered data, chart result, screenshot, and outcome of each verification gate.
- **FR-009**: The system MUST grant `Verified Fix` only when the candidate applies successfully, the replayed filtered data exactly matches the fixed expected dataset, and the Canvas bar count, labels, and values all match the fixed expected chart result.
- **FR-010**: The system MUST keep the result `Unverified` when any required evidence, application
  step, or verification gate is missing, cannot be evaluated, or fails; MUST identify the failed
  or unevaluable gate; and MUST require only artifacts for phases the run actually reached.
- **FR-011**: The completed result MUST connect the failure evidence, evidence-grounded diagnosis, candidate diff, replay evidence, gate outcomes, and final status in one review flow.
- **FR-012**: The system MUST omit or redact secrets, credentials, cookies, authorization headers, and unnecessary sensitive request or response data from captured evidence and model inputs.
- **FR-013**: The system MUST NOT automatically commit, push, open or merge a pull request, deploy,
  change tracked files, the Git index, the checked-out branch, `HEAD`, or Git history in the
  original repository. Sanitized artifacts under the ignored `.flowproof/runs/` root are its only
  persistent additions beneath the original working tree. While an isolated project copy exists,
  the system MAY create only the transient Git administrative metadata required for that copy and
  MUST remove and prune only the metadata it created on every finalization path.
- **FR-014**: The system MUST provide a local split-view workspace that presents the prepared web
  application and the FlowProof agent in the same browser window.
- **FR-015**: The agent panel MUST provide chat input and show ordered run activity, available
  Evidence IDs, candidate status, verification gates, and the final result as the run progresses.
- **FR-016**: A chat request MAY express the developer's goal but MUST NOT replace or modify the
  fixed scenario, verification oracle, permitted source boundary, or deterministic final gates.
- **FR-017**: The completed Proof Trail MUST remain reviewable inside the active workspace and MUST
  show the verified diff, supporting evidence, gate outcomes, and final status.

### Key Entities

- **Predefined Scenario**: The fixed reproduction actions, verification oracle, and permitted source boundary used by both the Hero and Failure cases.
- **Evidence Item**: A single sanitized observation with a stable Evidence ID, evidence type, run phase, and provenance.
- **Evidence Bundle**: The run-scoped collection of failure and replay evidence used for diagnosis and verification.
- **Candidate Change**: The proposed diff, its cited Evidence IDs, its permitted target scope, and its isolated application outcome.
- **Verification Result**: The final `Verified Fix` or `Unverified` status, each gate outcome, and any failed or unevaluable reason.
- **Workspace Session**: The local split-view context that owns the selected prepared case, chat,
  visible target application, and current run.
- **Run Activity Event**: One ordered, sanitized update that connects agent progress, evidence,
  candidate status, gate changes, or finalization to a run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the prepared demo environment, excluding initial dependency installation, the complete Hero run reaches a final status within five minutes.
- **SC-002**: A developer can start and complete both the Hero and Failure runs without manually entering file paths, expected values, or structured verification rules.
- **SC-003**: The known-bad baseline is reproduced before candidate generation, and every required failure Evidence Bundle field is present.
- **SC-004**: The agreed Hero case receives `Verified Fix` only after every required application, data, and Canvas chart gate passes.
- **SC-005**: The agreed Failure case remains `Unverified` and visibly identifies at least one failed or unevaluable gate.
- **SC-006**: Every factual claim in the final diagnosis and candidate rationale references an Evidence ID that exists in the same run's Evidence Bundle.
- **SC-007**: After both demo cases finish, the developer's tracked working-tree contents, Git
  index, checked-out branch, `HEAD`, Git history, protected file hashes, and registered-worktree
  list equal their respective pre-run snapshots; the only persistent additions are sanitized
  ignored artifacts under `.flowproof/runs/`.
- **SC-008**: Seeded secret markers used for validation do not appear in captured evidence, model inputs, or the completed result.
- **SC-009**: A developer can start either prepared case and review its final result without leaving
  the primary split-view workspace.
- **SC-010**: For every phase reached by a run, the workspace displays the phase in order and shows
  every emitted Evidence ID and gate update associated with that phase.
- **SC-011**: Closing the Studio page during an active prepared run yields `Unverified`, records the
  interruption as a failed or unevaluable gate, writes no artifacts for phases not reached, removes
  the isolated copy, and leaves the original tracked files and Git state unchanged.

## Assumptions

- The demo application, known-bad state, predefined scenario, fixed verification oracle, and permitted source boundary are prepared before a run begins.
- The expected dataset and chart result remain immutable throughout a run.
- Initial project dependencies are installed before measuring the five-minute demo completion target.
- The developer is authorized to inspect and evaluate the selected project locally.
- The prepared demo application permits embedding inside the local FlowProof workspace.
- The chat request is synthetic demo input and is sanitized before persistence or model use.
- Sanitized run artifacts under ignored `.flowproof/runs/` are the only intentional persistent
  additions beneath the original working tree; build outputs and temporary worktrees live outside
  it. Git may create transient administrative metadata for the FlowProof-owned detached worktree
  under the resolved Git common directory, but FlowProof removes and prunes only its own entry and
  restores the complete pre-run registered-worktree snapshot before finalization.
- The judged demo runs on the prepared Linux environment; cross-platform support is not an MVP
  acceptance condition.

## Scope Boundaries

This specification intentionally defines only the hackathon MVP feature slice. Broader FlowProof capabilities will be defined in separate future feature specifications instead of weakening this MVP's deterministic acceptance conditions.

### MVP In Scope

- One predefined, reproducible visual defect: applying a filter produces an incorrect result in a Canvas-rendered bar chart.
- The P1 verified-fix flow and P2 unverified-fix flow both use controlled cases derived from this single defect.
- Candidate changes are applied and replayed only in an isolated project copy.
- A completed run provides the candidate diff, evidence, replay outcome, and final status for the developer to review.
- One local, single-user split-view workspace shows the prepared target application and agent panel.
- Chat starts one fixed Hero or Failure case and does not redefine its oracle or source boundary.
- Failure and replay screenshots are retained as review evidence, while deterministic dataset and
  rendered bar count, label, and value checks decide the Canvas gate.

### MVP Out of Scope

- Automatically modifying the developer's tracked files, Git index, checked-out branch, HEAD, or
  history.
- Automatically creating a commit, pushing a branch, opening or merging a pull request, or deploying a change.
- Installing a browser extension or supporting arbitrary third-party sites.
- General-purpose browser tabs, arbitrary URL navigation, accounts, cloud synchronization, or
  multi-user collaboration.
- Allowing chat to create new scenarios, redefine expected behavior, or expand the permitted source
  boundary during a run.
- A public headless CLI or CI automation interface.
- Self-contained HTML export and generic or bulk artifact-download endpoints.
- Replay of missed activity events after an SSE disconnect or reopening a completed Studio session.
- Pixel-level screenshot comparison as a required verification gate.
- Multi-turn agent conversations after the single run-start request.
- Validated macOS support for the local runtime.

### Future Expansion

- User-supplied or arbitrary visual web defects are intentionally deferred until after the MVP.
- Additional defect types may be added later without changing the MVP requirement that every fix be grounded in failure evidence and verified by replaying the same scenario.
- Headless automation, portable Proof Trail export, resilient activity replay, pixel-level visual
  verification, multi-turn conversations, and macOS support may be added independently after the
  Hero and Failure Studio flows are stable.
- Optional Git integration may later preserve an approved verified change as a local commit or remote collaboration artifact.
- A Chrome Side Panel may later pair the same FlowProof engine with the developer's existing tab;
  an owned desktop browser may be considered when reproducible browser isolation is more important
  than extension integration.
- Each expansion should be introduced as a separate numbered feature specification with its own user scenarios, requirements, and success criteria.
- A future generalized version may obtain its verification oracle from existing test assertions, fixtures, contracts, or an explicitly approved known-good baseline. When no trustworthy oracle exists, the user must define or approve the expected behavior before `Verified Fix` can be granted.
- A future generalized version should discover the candidate source scope automatically from failure evidence and project relationships while applying safe default exclusions. It should ask for user approval only when the verification oracle is missing or the candidate scope remains materially ambiguous.
- The absence of a trustworthy oracle or safe source scope MUST result in `Unverified`; it MUST NOT be resolved by letting the patch-producing AI approve its own inferred criteria.
- The five-minute completion target applies only to the prepared hackathon demo environment. Larger repositories and broader future scenarios require separately measured performance targets.

### Tracked Follow-Up Work

- [#5 Headless run adapter](https://github.com/LLagoon3/flowproof/issues/5)
- [#6 Portable Proof Trail export](https://github.com/LLagoon3/flowproof/issues/6)
- [#7 SSE activity replay](https://github.com/LLagoon3/flowproof/issues/7)
- [#8 Pixel-level Canvas gates](https://github.com/LLagoon3/flowproof/issues/8)
- [#9 Multi-turn agent conversations](https://github.com/LLagoon3/flowproof/issues/9)
- [#10 macOS runtime validation](https://github.com/LLagoon3/flowproof/issues/10)
- [#11 Chrome Side Panel integration](https://github.com/LLagoon3/flowproof/issues/11)
- [#12 User-defined visual defects](https://github.com/LLagoon3/flowproof/issues/12)
