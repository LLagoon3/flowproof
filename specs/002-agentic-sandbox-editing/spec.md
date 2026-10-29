# Feature Specification: Isolated Agent Editing Runtime

**Feature Branch**: `feat/002-agentic-sandbox-editing`

**Created**: 2026-10-29

**Status**: Ready for Planning

**Input**: User description: "Build the first one-Spec, one-PR slice of agentic sandbox editing: the disposable editing-workspace lifecycle and coding-agent execution boundary."

## Problem Statement & Primary User

### Problem

FlowProof currently asks a model to return a complete unified diff. Before that mechanism can be
replaced with realistic multi-file editing, FlowProof needs a bounded runtime in which a coding
agent can inspect a project copy, run project commands, and edit files without gaining access to the
developer's original repository or protected host resources.

Without this runtime boundary, later change-capture and verification work would either remain tied
to model-authored patch syntax or execute an agent directly on the developer's checkout.

### Primary User

The primary user is an indie or solo full-stack developer who wants FlowProof to attempt realistic
repository edits while keeping the original working copy safe from agent mistakes and failed
processes.

### Core User Need

When FlowProof starts a coding-agent attempt, the developer needs that attempt to run in a
disposable project copy with a predictable start, cancellation, completion, and cleanup lifecycle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run an Agent in an Isolated Project Copy (Priority: P1)

A developer starts a prepared editing task. FlowProof creates a disposable copy of the selected
project baseline and runs a coding agent there. The agent can inspect and edit multiple files, run
the project commands needed for the task, and consult public technical resources when necessary,
while the developer's original repository remains unchanged.

**Why this priority**: A functioning isolated agent runtime is the minimum foundation required to
replace model-authored patches in later features.

**Independent Test**: Run a deterministic fixture agent that reads the prepared project, changes at
least three files, runs an approved project command, and exits successfully. The story succeeds when
all expected edits exist in the disposable copy during the session and no original-repository state
changes.

**Acceptance Scenarios**:

1. **Given** a selected repository revision and editing task, **When** FlowProof starts the session,
   **Then** the agent receives a disposable project copy derived from that exact revision.
2. **Given** an active session, **When** the agent inspects and edits multiple project files and runs
   task-related project commands, **Then** those actions affect only the disposable copy.
3. **Given** the task needs public technical documentation, **When** the agent retrieves it, **Then**
   the session permits that access subject to the user's and project's ordinary policies rather
   than limiting access to model-provider endpoints only.
4. **Given** the agent exits normally, **When** FlowProof finalizes the outcome, **Then** a trusted
   bounded inspector can observe the final disposable state before cleanup and the caller receives
   the bounded session result after cleanup.

---

### User Story 2 - Stop and Clean Up Failed Sessions (Priority: P2)

A developer can cancel an editing attempt or let FlowProof stop one that times out or fails. The
session reports why it stopped, terminates its remaining processes, removes its disposable state,
and leaves the original repository and unrelated workspaces unchanged.

**Why this priority**: Agent execution is not safe enough to become a dependency of the verification
pipeline until every termination path has predictable containment and cleanup.

**Independent Test**: Execute prepared success, non-zero exit, timeout, cancellation, and unexpected
interruption cases. The story succeeds when each case has the correct terminal outcome, owns no
remaining process or disposable workspace afterward, and leaves the original repository unchanged.

**Acceptance Scenarios**:

1. **Given** an active session, **When** its time limit is reached, **Then** FlowProof stops all
   session-owned processes and records a timeout outcome.
2. **Given** an active session, **When** the developer or trusted caller cancels it, **Then**
   FlowProof stops all session-owned processes and records a cancellation outcome.
3. **Given** the agent exits unsuccessfully or the runtime is interrupted, **When** finalization
   runs, **Then** FlowProof records a bounded failure reason and removes the disposable workspace.
4. **Given** any terminal outcome, **When** cleanup completes, **Then** the original repository,
   unrelated registered workspaces, and protected host resources remain unchanged.

---

### User Story 3 - Review a Safe Session Outcome (Priority: P3)

A developer or later FlowProof stage receives a consistent session outcome that states whether the
agent completed, failed, timed out, or was cancelled, along with sanitized diagnostics and cleanup
proof. The outcome does not claim that the edits are valid or verified.

**Why this priority**: Later change-capture work needs a stable handoff, while this first slice must
not accidentally blur agent completion with candidate acceptance or `Verified Fix`.

**Independent Test**: Run one fixture for each terminal outcome and inspect the resulting records.
The story succeeds when every result contains the same required lifecycle fields, excludes seeded
secret markers, and never reports candidate or verification success.

**Acceptance Scenarios**:

1. **Given** a terminal editing session, **When** its result is returned, **Then** the result identifies
   its terminal outcome, timing, bounded diagnostic, and cleanup status.
2. **Given** command output contains a seeded credential marker, **When** the session result is
   recorded, **Then** the marker does not appear in the returned or persisted diagnostic.
3. **Given** the agent completed successfully, **When** the result is reviewed, **Then** it does not
   claim that a candidate was admitted, replayed, or verified.

### Edge Cases

- The selected repository revision cannot be prepared.
- The agent executable cannot start or exits before making any edit.
- The agent creates child processes that remain active when the parent exits.
- Cancellation and normal completion occur at nearly the same time.
- The session reaches its time or resource limit during a project command.
- Public technical resources are unavailable or return untrusted content.
- A diagnostic contains an absolute host path, environment value, or seeded credential marker.
- Cleanup is invoked more than once after partial initialization.
- The original repository has unrelated local changes or registered workspaces before the run.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST create one disposable editing workspace from the exact repository
  revision selected for the session.
- **FR-002**: The editing session MUST NOT grant the agent write access to the developer's original
  repository, personal home directory, host credentials, or privileged host-control interfaces.
- **FR-003**: The agent MUST be able to inspect and change multiple files within the disposable
  project copy and run the project commands authorized for the editing task.
- **FR-004**: The session MUST permit access to general external technical resources when allowed by
  the user's and project's policies; it MUST NOT restrict external access solely to model-provider
  endpoints.
- **FR-005**: Every session MUST have finite execution-time and resource limits that can be selected
  by the trusted caller within configured bounds.
- **FR-006**: The trusted caller MUST be able to cancel an active session.
- **FR-007**: FlowProof MUST distinguish successful completion, unsuccessful exit, timeout,
  cancellation, startup failure, and cleanup failure in the session outcome.
- **FR-008**: A terminal session result MUST include bounded timing, diagnostic, and cleanup
  information and MUST sanitize secrets, credentials, sensitive environment values, and unnecessary
  host paths.
- **FR-009**: The trusted caller MUST have a bounded opportunity to inspect the disposable project's
  final state after agent termination and before workspace disposal.
- **FR-010**: Every finalization path MUST stop session-owned processes and dispose only the
  workspace and lifecycle resources created for that session.
- **FR-011**: After finalization, the original repository's tracked files, index, checked-out branch,
  `HEAD`, history, local configuration, and unrelated registered workspaces MUST match their
  pre-session state.
- **FR-012**: Successful agent completion MUST NOT by itself create an authoritative candidate,
  modify the original repository, or grant `Verified Fix`.

### Key Entities

- **Editing Session Request**: The selected repository revision, editing task, authorized project
  commands, and bounded runtime limits supplied by the trusted caller.
- **Disposable Editing Workspace**: The run-scoped project copy in which the agent may inspect,
  execute, and edit without changing the developer's original repository.
- **Editing Session**: The lifecycle that owns workspace preparation, agent execution, cancellation,
  termination, final-state inspection, and cleanup.
- **Editing Session Result**: The terminal outcome, timing, sanitized diagnostic, and cleanup status
  returned to the trusted caller without making candidate or verification claims.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A prepared fixture agent can inspect the project, change at least three files, run an
  authorized project command, and return a successful session outcome within two minutes, excluding
  initial dependency installation.
- **SC-002**: Across prepared success, unsuccessful-exit, startup-failure, timeout, cancellation,
  and interrupted-cleanup cases, 100% of sessions produce the expected terminal outcome and bounded
  cleanup status.
- **SC-003**: After every prepared terminal case, no session-owned child process or disposable
  workspace remains.
- **SC-004**: After every prepared terminal case, the original repository and unrelated registered
  workspaces match their complete pre-session snapshots.
- **SC-005**: Seeded credential markers and sensitive host paths appear zero times in returned or
  persisted session diagnostics.
- **SC-006**: A prepared task can retrieve one public technical resource while the session still has
  no access to seeded host credentials or privileged host-control interfaces.
- **SC-007**: Existing FlowProof Hero and Failure flows keep their current candidate-generation and
  verification behavior until a later feature explicitly migrates them to this runtime.

## Assumptions

- The trusted caller resolves the repository revision and editing task before starting a session.
- This feature uses a deterministic runtime that requires no provider authentication. Selecting a
  production coding agent and defining its authentication boundary require a later specification.
- External technical content is untrusted input and does not alter repository scope or verification
  policy by itself.
- The threat model protects the developer's repository and host resources from agent mistakes,
  malformed outputs, and failed processes; deliberate isolation escapes by a hostile model or target
  project are outside this feature.
- The first supported environment is the project's prepared Linux development environment.

## Scope Boundaries

### In Scope

- Disposable editing-workspace creation, readiness, bounded inspection, and disposal.
- Coding-agent startup, execution, cancellation, timeout, process cleanup, and terminal outcomes.
- Multi-file editing and authorized project commands inside the disposable copy.
- General external technical research subject to ordinary user and project policy.
- Protection of the original repository and host credentials from accidental modification or
  exposure.
- Sanitized lifecycle diagnostics and automated success/failure cleanup tests.

### Out of Scope

- Computing the authoritative changed-file manifest or final diff.
- Candidate path, size, file-type, or secret admission checks.
- Applying edits to a fresh verification baseline.
- Replacing the current model-authored-diff path in the production Hero or Failure flow.
- Replay, browser verification, gate changes, or `Verified Fix` decisions.
- A provider-only network proxy or a general web-research prohibition.
- A second dedicated verification container.
- Solving trusted browser-probe isolation tracked separately in
  [#15](https://github.com/LLagoon3/flowproof/issues/15).
- Automatically applying edits to the original repository, committing, pushing, opening or merging
  a pull request, or deploying.

## Delivery Boundary

This specification is the first independently verifiable delivery slice and is intended to map to
one pull request. The pull request is complete when the isolated editing-session contract,
deterministic fixture agent, lifecycle implementation, and automated containment and cleanup tests
satisfy this specification. Authoritative change capture and verification integration require
separate numbered specifications and pull requests.
