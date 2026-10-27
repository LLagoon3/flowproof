# Feature Specification: Evidence-Grounded Fix Verification

**Feature Branch**: `feat/001-verify-debugging-fix`

**Created**: 2026-10-27

**Status**: Ready for Planning

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

An indie or solo full-stack developer runs FlowProof against a reproducible visual web defect. FlowProof gathers evidence from the failing run, produces an evidence-grounded candidate change, applies that change to an isolated copy of the project, and replays the same scenario. The developer receives a `Verified Fix` result only when the replay satisfies every agreed verification condition.

**Why this priority**: This closed loop is the product's primary value and must be independently demonstrable as the minimum viable product.

**Independent Test**: Start from the agreed known-bad scenario and run the complete flow without manually editing the candidate change. The story succeeds when the original failure is reproduced, the candidate change is applied only to an isolated copy, the same scenario is replayed, and the final result accurately reports whether the change was verified.

**Acceptance Scenarios**:

1. **Given** the agreed scenario is in its known-bad state, **When** the developer starts a FlowProof run, **Then** FlowProof reproduces the failure and records evidence from that run.
2. **Given** the failure evidence exists, **When** FlowProof produces a candidate change, **Then** the candidate's factual claims are connected to evidence from the same run.
3. **Given** a candidate change is ready, **When** FlowProof evaluates it, **Then** FlowProof applies it only to an isolated copy and leaves the developer's original working copy unchanged.
4. **Given** the candidate change was applied successfully, **When** FlowProof replays the same scenario, **Then** it labels the result `Verified Fix` only if every agreed verification condition passes.
5. **Given** the run is finalized, **When** the developer reviews the result, **Then** the result connects the failure evidence, evidence-grounded diagnosis, candidate change, replay outcome, and final status without requiring a separate review workspace.
6. **Given** the run is finalized as `Verified Fix`, **When** FlowProof hands the result to the developer, **Then** it provides the verified diff and supporting result without committing or changing the developer's original working copy.

---

### User Story 2 - Reject an Unverified Fix (Priority: P2)

An indie or solo full-stack developer runs a deliberately failing evaluation case and sees FlowProof refuse to present the candidate change as verified. When evidence is invalid, isolated application is unsuccessful, or replay does not satisfy an agreed verification condition, the result remains `Unverified` and identifies the failed gate.

**Why this priority**: A separate failure demonstration proves that FlowProof is a verification system rather than a tool that always approves its own suggestions.

**Independent Test**: Run one predefined failure case in which at least one required verification gate cannot pass. The story succeeds when the final result remains `Unverified`, the failed gate is visible, and the original working copy remains unchanged.

**Acceptance Scenarios**:

1. **Given** a required evidence reference is invalid, **When** FlowProof evaluates the candidate, **Then** it rejects the unsupported claim and keeps the result `Unverified`.
2. **Given** the candidate cannot be applied within the permitted isolated scope, **When** application is attempted, **Then** the result remains `Unverified` and the original working copy remains unchanged.
3. **Given** the candidate was applied in isolation but replay fails any agreed verification condition, **When** the run is finalized, **Then** FlowProof reports `Unverified` and identifies the failed condition.
4. **Given** the run is `Unverified`, **When** the developer reviews the result, **Then** the same result view connects the relevant evidence, candidate change, failed gate, and final status without requiring a separate review workspace.
5. **Given** the run remains `Unverified`, **When** FlowProof hands the result to the developer, **Then** it does not create a commit or modify the developer's original working copy.

### Edge Cases

- If a required evidence item cannot be captured or evaluated, the affected gate remains failed and the final result is `Unverified`.
- If a diagnosis or candidate claim references an Evidence ID that does not exist in the same run, the claim is rejected as unsupported.
- If a candidate change targets content outside the permitted source boundary, application is rejected and the result remains `Unverified`.
- If candidate application succeeds but either the filtered data check or any Canvas chart check fails, the result remains `Unverified`.
- If sanitization removes information required to evaluate a gate safely, the system reports that gate as unevaluable rather than exposing the sensitive value or granting `Verified Fix`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST load the predefined scenario, fixed verification oracle, and permitted source boundary without requiring the developer to enter file paths, expected values, or structured verification rules for each run.
- **FR-002**: The system MUST reproduce the known-bad Canvas filter defect before producing or evaluating a candidate change.
- **FR-003**: The system MUST capture a failure Evidence Bundle containing the reproduction actions, expected and observed filtered data, a failure screenshot, console errors, a sanitized network summary, and relevant source context selected from within the permitted boundary.
- **FR-004**: The system MUST assign a stable Evidence ID to every captured evidence item so later claims and results can reference the exact supporting item.
- **FR-005**: The system MUST produce an evidence-grounded diagnosis and candidate diff whose factual claims reference Evidence IDs from the same failure run.
- **FR-006**: The system MUST reject unsupported evidence references and MUST NOT apply a candidate change outside the permitted source boundary.
- **FR-007**: The system MUST apply the candidate change only to an isolated project copy and MUST leave the developer's original working copy unchanged.
- **FR-008**: The system MUST replay the same predefined scenario after candidate application and capture the observed filtered data, chart result, screenshot, and outcome of each verification gate.
- **FR-009**: The system MUST grant `Verified Fix` only when the candidate applies successfully, the replayed filtered data exactly matches the fixed expected dataset, and the Canvas bar count, labels, and values all match the fixed expected chart result.
- **FR-010**: The system MUST keep the result `Unverified` when any required evidence, application step, or verification gate is missing, cannot be evaluated, or fails, and MUST identify the failed gate.
- **FR-011**: The completed result MUST connect the failure evidence, evidence-grounded diagnosis, candidate diff, replay evidence, gate outcomes, and final status in one review flow.
- **FR-012**: The system MUST omit or redact secrets, credentials, cookies, authorization headers, and unnecessary sensitive request or response data from captured evidence and model inputs.
- **FR-013**: The system MUST NOT automatically commit, push, open or merge a pull request, deploy, or modify the developer's original working copy.

### Key Entities

- **Predefined Scenario**: The fixed reproduction actions, verification oracle, and permitted source boundary used by both the Hero and Failure cases.
- **Evidence Item**: A single sanitized observation with a stable Evidence ID, evidence type, run phase, and provenance.
- **Evidence Bundle**: The run-scoped collection of failure and replay evidence used for diagnosis and verification.
- **Candidate Change**: The proposed diff, its cited Evidence IDs, its permitted target scope, and its isolated application outcome.
- **Verification Result**: The final `Verified Fix` or `Unverified` status, each gate outcome, and any failed or unevaluable reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the prepared demo environment, excluding initial dependency installation, the complete Hero run reaches a final status within five minutes.
- **SC-002**: A developer can start and complete both the Hero and Failure runs without manually entering file paths, expected values, or structured verification rules.
- **SC-003**: The known-bad baseline is reproduced before candidate generation, and every required failure Evidence Bundle field is present.
- **SC-004**: The agreed Hero case receives `Verified Fix` only after every required application, data, and Canvas chart gate passes.
- **SC-005**: The agreed Failure case remains `Unverified` and visibly identifies at least one failed or unevaluable gate.
- **SC-006**: Every factual claim in the final diagnosis and candidate rationale references an Evidence ID that exists in the same run's Evidence Bundle.
- **SC-007**: After both demo cases finish, the developer's original working-copy contents and Git history are unchanged.
- **SC-008**: Seeded secret markers used for validation do not appear in captured evidence, model inputs, or the completed result.

## Assumptions

- The demo application, known-bad state, predefined scenario, fixed verification oracle, and permitted source boundary are prepared before a run begins.
- The expected dataset and chart result remain immutable throughout a run.
- Initial project dependencies are installed before measuring the five-minute demo completion target.
- The developer is authorized to inspect and evaluate the selected project locally.

## Scope Boundaries

This specification intentionally defines only the hackathon MVP feature slice. Broader FlowProof capabilities will be defined in separate future feature specifications instead of weakening this MVP's deterministic acceptance conditions.

### MVP In Scope

- One predefined, reproducible visual defect: applying a filter produces an incorrect result in a Canvas-rendered bar chart.
- The P1 verified-fix flow and P2 unverified-fix flow both use controlled cases derived from this single defect.
- Candidate changes are applied and replayed only in an isolated project copy.
- A completed run provides the candidate diff, evidence, replay outcome, and final status for the developer to review.

### MVP Out of Scope

- Automatically modifying the developer's original working copy.
- Automatically creating a commit, pushing a branch, opening or merging a pull request, or deploying a change.

### Future Expansion

- User-supplied or arbitrary visual web defects are intentionally deferred until after the MVP.
- Additional defect types may be added later without changing the MVP requirement that every fix be grounded in failure evidence and verified by replaying the same scenario.
- Optional Git integration may later preserve an approved verified change as a local commit or remote collaboration artifact.
- Each expansion should be introduced as a separate numbered feature specification with its own user scenarios, requirements, and success criteria.
- A future generalized version may obtain its verification oracle from existing test assertions, fixtures, contracts, or an explicitly approved known-good baseline. When no trustworthy oracle exists, the user must define or approve the expected behavior before `Verified Fix` can be granted.
- A future generalized version should discover the candidate source scope automatically from failure evidence and project relationships while applying safe default exclusions. It should ask for user approval only when the verification oracle is missing or the candidate scope remains materially ambiguous.
- The absence of a trustworthy oracle or safe source scope MUST result in `Unverified`; it MUST NOT be resolved by letting the patch-producing AI approve its own inferred criteria.
- The five-minute completion target applies only to the prepared hackathon demo environment. Larger repositories and broader future scenarios require separately measured performance targets.
