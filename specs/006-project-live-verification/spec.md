# Feature Specification: User Project Onboarding and Live AI Fix Verification

**Feature Branch**: `feat/006-project-live-verification`

**Created**: 2026-11-04

**Status**: Draft. The owner agreed to the product direction and requested Specify.
Review of this specification's detailed scope, assumptions, and acceptance outcomes precedes Plan.
No implementation, live model execution, publication, or deployment is authorized by this document.

**Input**: Let a developer identify the local project that has a problem, configure its execution,
describe the problem, obtain an actual AI-generated correction, and inspect independent verification
and before/after evidence in Studio. Include the real model in the first end-to-end implementation
slice rather than delivering another prepared-candidate-only demonstration. Deployment is canceled.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open My Project and Confirm What Will Run (Priority: P1)

As a developer, I want to start FlowProof for an existing local Git project, confirm which project
it will inspect, and supply its execution settings so that I can investigate my application rather
than select a built-in demonstration.

**Why this priority**: Project identity and a supported execution setup are prerequisites for a
meaningful user-project run. Selecting a directory alone must not execute unreviewed project code.

**Independent Test**: Open a supported local project without calling a model, inspect its project
identity and settings, confirm the settings, and observe a readiness result. Repeat with an invalid
location, unsupported project, dirty checkout, and unavailable target.

**Acceptance Scenarios**:

1. **Given** a clean, committed local Git project, **When** the developer launches FlowProof for
   that location, **Then** Studio identifies the resolved project root, branch when applicable,
   and baseline revision before offering a real run; the project is not silently replaced by a demo.
2. **Given** the selected project, **When** the developer supplies or reviews suggested startup,
   build/check settings and the local target address, **Then** FlowProof explains its supported
   execution boundary and obtains confirmation before running those project commands.
3. **Given** an invalid, dirty, or unsupported project or missing prerequisites, **When** readiness
   is checked, **Then** the developer receives a specific blocker and corrective action; no live
   model request or source modification occurs. A project that changes before execution is rechecked.
4. **Given** confirmed settings, **When** the readiness check cannot start or reach the selected
   target, **Then** the startup/readiness error is distinct from an application defect or AI failure.

---

### User Story 2 - Ask a Real AI to Correct My Reproducible Problem (Priority: P1)

As a developer, I want to describe what is wrong, how to reproduce it, and what I expect instead,
then ask the configured AI to produce a correction in an isolated working copy of my project.

**Why this priority**: The core value is a correction generated for the developer's problem, not
replaying a patch prepared before the session. A live model belongs in the first usable vertical slice.

**Independent Test**: For an admitted project and confirmed reproduction/check definition, submit
a request through the real configured model, inspect its resulting candidate and change summary,
and verify that the original checkout was not changed. Candidate generation is observable separately
from the later verdict; deterministic substitutes are allowed only in explicitly labelled tests.

**Acceptance Scenarios**:

1. **Given** a ready project, **When** the developer enters the problem, supported reproduction
   steps, and expected observable behavior, **Then** Studio presents the project and complete run
   request for confirmation and rejects missing or unsupported verification conditions before editing.
2. **Given** a confirmed request and a successfully reproduced baseline defect, **When** the
   developer starts live correction, **Then** the configured model receives only the admitted project
   context and request, edits an isolated copy, and produces a candidate tied to this baseline and run.
   The candidate is not a predetermined fixture or a patch selected by a built-in scenario identifier.
3. **Given** absent credentials, a rejected model request, exhausted execution limits, or no usable
   changes, **When** generation ends, **Then** Studio explains the actual failure and does not silently
   substitute a prepared patch, run a different model, or announce a verified correction.
4. **Given** generation is active, **When** observed work becomes available or execution is
   interrupted, **Then** Studio presents only observed activity and the actual interruption state;
   it does not invent reasoning, tool use, completion, or successful checks.
5. **Given** excluded secrets, unrelated files, or instructions requesting additional authority,
   **When** the model receives context or uses editing tools, **Then** the excluded content and model
   credentials remain unavailable to the candidate and output, and editable scope does not expand.

---

### User Story 3 - Verify the Same Problem Before and After the Change (Priority: P1)

As a developer, I want FlowProof to reproduce the defect on the unchanged baseline, repeat the same
steps against the AI candidate, and independently evaluate agreed checks so that a plausible-looking
change is not mistaken for proof of a fix.

**Why this priority**: Real generation without independent verification would remove FlowProof's
principal distinction. A model's own success statement cannot be the verification authority.

**Independent Test**: Evaluate fixed baseline/candidate pairs for a supported project with the same
confirmed reproduction and checks: a true correction, an ineffective change, a broken build, a
modified check definition, and missing evidence. The evaluator can be assessed without a new model
call; at least one separate full-flow acceptance run must still use the real model.

**Acceptance Scenarios**:

1. **Given** confirmed reproduction steps and a required expected-behavior check, **When** the
   unchanged baseline is exercised, **Then** the expected-behavior check fails in the intended way
   and available failure evidence is retained before any AI correction is requested. A startup error
   or unrelated test failure alone does not establish reproduction of the reported defect.
2. **Given** a reproduced baseline and a candidate, **When** verification runs, **Then** the same
   reproduction and frozen expected-behavior checks are evaluated against that candidate, together
   with the confirmed required build/project checks. Only all required checks passing permits success.
3. **Given** the baseline does not reproduce, the candidate breaks a required check, or a required
   observation is missing, **When** the run ends, **Then** the outcome is respectively not reproduced,
   unsuccessful, or unverified, with the reason visible; it is never promoted to success.
4. **Given** the candidate changes a required check, attempts to alter the frozen expectation,
   or supplies evidence from another run, **When** verification evaluates it, **Then** those changes
   or observations cannot satisfy the original obligation and the run cannot claim verification success.
5. **Given** screenshots differ but no required expected-behavior check has passed, **When** the
   result is summarized, **Then** visual difference alone is not presented as proof of correctness.

---

### User Story 4 - Review the Outcome Without Losing Control of My Project (Priority: P2)

As a developer, I want to inspect the result, before/after evidence, check reasons, and exact changes
so that I can decide whether to use the candidate while retaining control of my original project.

**Why this priority**: The existing workspace already supports result inspection. Extending it with
the selected project's identity and candidate diff makes the live flow useful without auto-applying it.

**Independent Test**: Open retained results for successful, unsuccessful, and interrupted runs;
inspect available evidence, diff, and limitations without requesting another correction or keeping
the verification target alive. Check the original checkout remains unchanged.

**Acceptance Scenarios**:

1. **Given** a completed project run, **When** the developer inspects the result, **Then** Studio
   exposes project/baseline/candidate identity, actual model identity, verdict, required check results,
   available before/after evidence, and an inspectable diff or patch with missing evidence explained.
2. **Given** passing checks, **When** success is displayed, **Then** the claim is limited to the
   declared reproduction and checks, not unrestricted correctness, a merge, or a production deployment.
3. **Given** an unsuccessful or interrupted run, **When** the developer reviews it, **Then** actual
   partial work and limitations remain available where captured; absent final evidence or a complete
   patch is explicitly identified and is not replaced with a successful-looking example.
4. **Given** a retained result, **When** the developer reads details or leaves the window idle,
   **Then** no review timer closes the window or applies the patch. Live target disposal remains
   distinct from retained evidence; manual patch application outside FlowProof is the initial handoff.
5. **Given** an existing prepared mode, **When** it is opened after this feature is introduced,
   **Then** its supported interactions and bounded verdict remain unchanged, and it is not presented
   as an actual correction generated for a newly selected user project.

### Edge Cases

- A path inside a repository resolves to its actual root; missing paths, non-repositories,
  ambiguous nested-project settings, and unsupported repository layouts have explicit blockers.
- Uncommitted changes or an external baseline change after confirmation invalidate readiness;
  FlowProof neither discards the developer's work nor silently fixes a different revision.
- Ignored/untracked prerequisites, submodules, unavailable dependencies, target authentication,
  external services, or unsupported actions are reported rather than silently omitted or auto-installed.
- Conflicting target addresses, a target that exits, readiness failure, and inability to stop a
  run-owned process remain operational errors, not evidence that the reported defect was fixed.
- A problem expressed only in prose without a supported observable condition is not automatically
  accepted as verifiable. Changing reproduction or expected behavior requires a newly confirmed run.
- Project instructions, model output, or candidate code that requests extra project access,
  credential disclosure, check bypass, or changes outside the admitted copy cannot expand authority.
- Model/network failure, empty or invalid changes, required-check failure, cancellation,
  evidence mismatch, and cleanup failure retain their actual outcome without a fixture fallback.
- Missing before/after images, deleted candidate artifacts, or disconnected live activity do not
  imply success. Review distinguishes stored evidence from an interactive project preview.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Developers MUST be able to open FlowProof for an existing local Git project by
  specifying its location at launch. Studio MUST display the resolved root, baseline revision, and
  branch when present. An in-app directory browser or project switcher is not required initially.
- **FR-002**: FlowProof MUST admit only a clean, committed baseline within its advertised supported
  project category, validate required prerequisites, and explain rejected inputs without changing
  the original. The confirmed identity and prerequisites MUST be revalidated before execution.
- **FR-003**: Developers MUST be able to review and confirm startup settings, local target address,
  and required build/project checks. Suggested or repository-supplied settings MUST remain untrusted
  suggestions until confirmed; selecting a project alone MUST NOT execute its scripts or install tools.
- **FR-004**: Developers MUST provide a problem description, supported reproducible actions, and
  an observable expected-behavior condition. FlowProof MUST show what will be exercised and checked
  before execution, rejecting incomplete or unsupported definitions with actionable feedback.
- **FR-005**: FlowProof MUST establish the reported baseline defect against the confirmed
  expected-behavior check before live correction. A non-reproduced defect or unrelated operational
  failure MUST stop correction with a distinct outcome, not a speculative success.
- **FR-006**: The first delivered end-to-end user-project path MUST invoke one explicitly
  configured real AI model to generate a candidate from that project's admitted context and request.
  Prepared patches MAY support labelled tests/demos but MUST NOT substitute for live-path acceptance.
- **FR-007**: FlowProof MUST disclose the configured model identity and readiness without exposing
  credentials, and preserve actual invocation identity in the result. Unavailable or failed model
  access MUST produce an explicit failure; no silent provider/model or fixture fallback is allowed.
- **FR-008**: AI edits and project execution MUST operate on isolated copies of the admitted
  baseline. FlowProof MUST NOT modify the original checkout's tracked/untracked content, index,
  branch, or revision, or commit, push, merge, or deploy a candidate automatically.
- **FR-009**: Each run MUST bind the confirmed project, baseline, execution settings, request,
  reproduction, required checks, and required evidence before editing. The supported category MUST
  define its mandatory checks and evidence; users cannot omit them to obtain success. Candidate
  changes MUST NOT redefine the frozen reproduction or expected checks. Changes to those inputs
  require explicit reconfirmation as a new run.
- **FR-010**: Verification MUST independently repeat the confirmed reproduction against the
  candidate and evaluate the unchanged expected-behavior and required build/project checks.
  Candidate changes to required verification definitions MUST block success rather than weaken checks;
  model prose, candidate-provided pass messages, and visual difference alone MUST NOT establish a pass.
- **FR-011**: Success MUST require the intended baseline failure, a usable candidate, all required
  candidate checks passing, required run-bound evidence, original integrity, and successful required
  cleanup. Rejected readiness, not reproduced, generation failure, failed checks, unverified evidence,
  and interrupted execution MUST remain distinguishable non-success outcomes.
- **FR-012**: Studio MUST show observed work and actual execution status for readiness, baseline
  reproduction, generation, verification, and finalization; unavailable live activity MUST be
  distinct from the authoritative run outcome. No invented reasoning or progress may be displayed.
- **FR-013**: A retained result MUST expose project, baseline, candidate and run identities,
  actual model identity, the bounded verdict, every required check and its reason, and available
  before/after evidence. Missing or mismatched evidence MUST be explicit and MUST NOT satisfy a check.
- **FR-014**: Developers MUST be able to inspect the candidate's changed files and exact diff
  and obtain an available patch for manual use. No in-app application to the original is required;
  unavailable or incomplete candidate artifacts MUST be labelled rather than fabricated.
- **FR-015**: FlowProof MUST support interruption of active execution, prevent later success
  after cancellation, and finalize run-owned resources with cleanup failures visible. Retained result
  review MUST NOT depend on a live target or end because a human review timer expired.
- **FR-016**: Project context sent to the model MUST be limited to the admitted project and task.
  Credentials, excluded secret files, and unrelated host files MUST NOT be included in that context,
  patches, retained evidence, or visible logs. Authentication MUST NOT grant the candidate access to
  model credentials. Project/model instructions MUST NOT expand the confirmed access or execution scope.
- **FR-017**: The user-project live path MUST be distinguishable from existing prepared modes.
  Existing legacy and captured-candidate modes MUST retain their supported actions, authoritative
  verdicts, evidence boundaries, and original-integrity safeguards without gaining a broader claim.

### Key Entities

- **Project context**: The admitted local Git root, baseline revision/branch, supported category,
  and prerequisites. It identifies the source project, not permission to change the original.
- **Confirmed execution settings**: The reviewed startup/target settings, required build/check
  actions, and execution boundary associated with a particular project baseline.
- **Problem and verification definition**: The developer's description, reproduction steps,
  expected observable condition, and required checks frozen before model editing.
- **Live correction run**: One confirmed request, actual model invocation, observed activity,
  candidate generation, independent verification, interruption state, and final outcome.
- **Candidate**: The model-generated changes and their isolated baseline association, exact diff,
  and available handoff patch; it is not an applied correction in the original checkout.
- **Verification result**: Baseline/candidate observations, required check outcomes, provenance,
  original integrity and cleanup outcomes, retained evidence, and bounded success/non-success claim.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least one permitted sample project outside the built-in demo repository completes
  the full flow using an actual configured model: project admission, intended baseline failure,
  a newly model-generated patch, the same reproduction passing on the candidate, all required
  project checks passing, and inspectable result/evidence/diff. A prepared patch does not count.
- **SC-002**: In the acceptance set of valid, missing, non-Git, dirty, unsupported, and changed-after-
  confirmation projects, every invalid/stale input is rejected before a model call; every admitted
  input displays its actual project and baseline. No project-selection action executes project code.
- **SC-003**: Across successful, failed, and canceled sample runs, FlowProof makes zero changes
  to the original checkout's content, index, branch, and revision and performs zero automatic commits,
  pushes, merges, or deployments. Checks compare the original state before and after each run.
- **SC-004**: In a defined negative acceptance set covering non-reproduction, model failure,
  empty/invalid candidate, ineffective correction, broken required project check, altered verification
  definition, missing/mismatched evidence, cancellation, and cleanup failure, zero runs report success
  or silently use a prepared candidate. Each result explains its actual blocking condition.
- **SC-005**: Every finalized run in the acceptance set identifies the project/baseline, run,
  candidate and actual model when reached; shows every required check outcome or why it was not
  evaluated; and identifies available or missing before/after evidence and diff. No observation from
  a different run is accepted as supporting evidence.
- **SC-006**: Seeded excluded-secret and unrelated-file samples do not appear in model-bound
  context, candidate patches, visible logs, or retained evidence in the acceptance set; the candidate
  cannot obtain model credentials or write outside its admitted editable copy through supported tools.
- **SC-007**: In an untimed owner walkthrough, the owner can select a project, understand and
  confirm the request/settings, start the live flow, and locate its outcome, evidence, and exact
  changes without a prescribed click script. Confusion and missing steps are recorded explicitly;
  no time-to-completion target or auto-close rule is used as a delivery gate.
- **SC-008**: Existing legacy and captured-candidate acceptance scenarios retain their distinct
  claims and pass/fail behavior after the new flow is added. New user-project results never imply
  that a change has been applied, merged, deployed, or proven correct beyond its declared checks.

## Assumptions

- **Agreed direction**: The owner accepted local-project onboarding followed by real AI correction
  and independent verification on 2026-11-04, then requested this Specify. The detailed defaults below
  are proposed scope choices, not claims that every choice has already received owner approval.
- **Initial project entry**: The developer launches FlowProof with a local project location and
  confirms its identity/settings in Studio. Remote cloning, uploading source, an in-app file browser,
  recent-project management, and switching multiple projects in one session are deferred.
- **First supported category**: One self-contained browser-based project with one local preview
  and prepared dependencies. Required code is represented by a clean committed Git baseline; projects
  requiring untracked source, submodules, login, databases, or external services are rejected initially.
  Plan must name and document the concrete supported execution category before implementation; this
  is not a promise to support every framework, repository, language, or host environment.
- **Execution settings**: The developer supplies/reviews startup and required check actions rather
  than relying on universal automatic project discovery. Confirmation permits those bounded actions
  in isolation, not unrestricted commands on the original host. Dependency installation is not automatic.
- **Problem input**: The first flow uses explicit supported reproduction steps and an independently
  evaluable expected condition. Automatic recording and unconstrained natural-language test generation
  are deferred. Any suggested condition needs developer confirmation before the run is frozen.
- **Live model**: One operator-configured provider/model and its authorized credentials suffice.
  Provider choice, authentication mechanics, and integration of existing model capabilities are Plan
  decisions; no provider marketplace or model picker is required. Acceptance depends on permitted
  model access, network availability, and an adequate execution budget. Specify itself makes no calls.
- **Bounded correction**: One live candidate is generated per confirmed run. A developer may start
  another run deliberately; autonomous repair/retry loops and an open-ended conversational coding IDE
  are deferred. Model or process execution limits are separate from untimed human review.
- **Trust boundary**: Only public, synthetic, or explicitly permitted projects/data are used for
  acceptance. Frozen checks and isolated execution address the declared workflow, not a universal
  proof against arbitrary hostile applications forging every possible observation. Unsupported cases
  must be surfaced rather than represented as comprehensively verified.
- **Existing foundation**: The existing Studio workspace, isolated editing/capture, verification,
  and model capabilities are reusable foundations, not evidence that arbitrary-project live correction
  is already connected. Existing prepared demos remain clearly labelled separate modes.
- **Handoff and non-goals**: Exact diff/patch review and manual application outside FlowProof are
  sufficient initially. Automatic original-project writes, commits, pushes, PRs, merges, hosting,
  deployment, cloud/multi-user accounts, and broad multi-project management are out of scope.
- **Phase boundary**: This feature defines the user journey and acceptance obligations only.
  Clarify addresses owner feedback; Plan and Tasks follow explicit agreement on the detailed scope.
  The first usable implementation slice must include live correction and independent verification,
  not stop at an onboarding mockup or another deterministic prepared-patch demo.
