# Feature Specification: Studio Workspace UX and Core Design System

**Feature Branch**: `feat/005-studio-workspace-ux`

**Created**: 2026-11-03

**Status**: The owner accepted the scope, workspace direction and preview-first review sequence,
then approved the Plan direction on 2026-11-03 and explicitly requested Tasks. Task generation
is authorized; preview/product implementation, push and PR creation are not part of this Tasks run.

**Input**: After trying the working Studio, the owner identified substantial UI/UX improvements
and requested a separate specification. Use conversation-plus-canvas references such as Claude
Artifacts, Lovable, and v0 to make the result prominent and the AI's observable work understandable.
Establish the core design system together with the improved workspace, not a standalone visual kit.

## Clarifications

### Session 2026-11-03

- Q: Does the feature stop at design rules or a mockup? → A: Deliver the design preview, the
  focused core design system, and its application to the real Studio, preserving existing functionality.
- Q: What workspace direction should the design start from? → A: Work panel on the left and
  a larger canvas on the right, one light appearance, desktop first, resizable/collapsible panels,
  and detailed work/checks disclosed on demand.
- Q: When should the owner review the actual visual direction? → A: Review a clickable design
  preview before production UI replacement; the contributor proposes specific visual details.

The owner accepted these recommendations together and requested the next stage (Coding message
24880). No additional high-impact product ambiguity requires a new question before planning.
The usability timings remain the specification's proposed acceptance targets; palette, typeface,
component dimensions, and technical execution are Plan/design decisions rather than new product scope.

The owner subsequently accepted the Plan direction and requested Tasks (Coding messages 24894
and 24903). Preview deliverables and repository instructions remain tool-neutral; an operator's
personal tooling or hosting is not a project dependency. Actual preview acceptance is still pending.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work in a Clear, Canvas-First Workspace (Priority: P1)

As a developer opening Studio, I want to understand what I can run and keep the target or result
in a large workspace beside the work panel, rather than navigate a dense stack of controls and logs.

**Why this priority**: The current functionality works, but its presentation makes the primary
action and the output compete with technical detail. A useful layout is the foundation for every run.

**Independent Test**: Open each existing Studio mode, identify its primary action, resize or hide
the work panel, restore it, and inspect the target without starting a new model request.

**Acceptance Scenarios**:

1. **Given** a ready session, **When** the developer opens Studio, **Then** the prepared case or
   fixed candidate, its scope, the primary start action, and the target area are identifiable;
   raw identifiers and detailed checks do not dominate the initial view.
2. **Given** a supported desktop window, **When** the developer resizes or collapses the work
   panel, **Then** the target gains or loses space without restarting the run, losing draft text,
   or losing the selected evidence; restoring the panel remains possible with a keyboard.
3. **Given** legacy prepared-case mode, **When** the developer enters a request and starts,
   **Then** the existing bounded request and case restrictions still apply. **Given** captured
   candidate mode, **Then** the panel presents its fixed candidate and verification action without
   offering unsupported chat, model selection, or new candidate generation.

---

### User Story 2 - Understand the Work Without Reading Raw Logs (Priority: P1)

As a developer watching a run, I want a readable sequence of observed work and a clear current
state so that I know whether it is preparing, working, checking, finalizing, or unable to continue.

**Why this priority**: A polished canvas alone does not explain whether the system is making
progress or whether its result can be trusted. Work visibility must reflect actual execution.

**Independent Test**: Present the existing modes' recorded activity and authoritative result
states, including disconnection and failure, and inspect the work panel independently of a live model.

**Acceptance Scenarios**:

1. **Given** a starting or active run, **When** observed work arrives, **Then** readable work cards
   expose the current phase, completed work, and available supporting details without showing
   every raw event as an equally prominent message or inventing hidden reasoning.
2. **Given** live activity is disconnected but no final result is available, **When** updates stop,
   **Then** Studio distinguishes unavailable activity from run failure and never announces success
   merely because a stream ended or a local animation completed.
3. **Given** the user is reading an earlier work card or using its controls, **When** new activity
   arrives, **Then** it does not steal focus or force the reader to the bottom; returning to the
   latest work remains discoverable.
4. **Given** rejected startup, active execution, interrupted execution, finalization, or a final
   error, **When** that state is displayed, **Then** the panel explains what happened and the next
   supported action. Closing the session or interrupting its launcher keeps its existing meaning;
   no unsupported in-panel cancel, retry, or resume action is promised.

---

### User Story 3 - Inspect a Result and Its Evidence Confidently (Priority: P2)

As a developer reviewing the outcome, I want a concise verdict with easy access to before/after
evidence and detailed checks so that I can distinguish a verified result from a plausible-looking fix.

**Why this priority**: FlowProof's differentiator is trustworthy verification. Visual simplification
must make the evidence easier to understand without weakening or broadening the success claim.

**Independent Test**: Open recorded successful and unsuccessful results for both existing modes,
inspect available before/after evidence and failed checks, and repeat the journey with a keyboard.

**Acceptance Scenarios**:

1. **Given** a finalized result, **When** it is displayed, **Then** its verdict, concise explanation,
   failed or unevaluable checks, and available evidence are easy to find. A captured-path success
   reads **Candidate verification passed**, not **Verified Fix**; legacy claim rules remain unchanged.
2. **Given** failure and replay images exist, **When** the developer selects before/after evidence,
   **Then** the comparison identifies each phase and its actual evidence. Missing or unreached
   evidence is explained rather than represented by a synthetic successful image.
3. **Given** the verification target has been disposed, **When** the result stays open, **Then**
   the canvas clearly identifies stored evidence rather than a live, interactive application;
   reviewing it does not require keeping the target running or recreating the worktree.
4. **Given** a result summary, **When** the developer expands detailed checks or evidence, **Then**
   every required check and its available reason remains inspectable; collapsing details does
   not hide the existence of a failure or change the verdict.

### Edge Cases

- Catalog loading, no usable prepared case, or a missing launch prerequisite: show the actual
  limitation and disable unavailable actions with a reason, rather than an apparently ready editor.
- Long candidate identifiers, evidence IDs, errors, or dense work history: keep the workspace
  readable and details accessible without a page-wide horizontal scrollbar at supported sizes.
- Collapsed work panel during a running session: preserve the session and retain a compact state
  indicator plus a visible way back to the panel and its result.
- Result arrival during an open detail view or after activity disconnection: show the authoritative
  outcome without overwriting the reader's selected evidence or silently closing their detail view.
- Partial runs, missing evidence, startup rejection, and cleanup failure: show only the work that
  occurred; never replace an unavailable result with a pass badge or an empty success screen.
- Browser zoom or a narrow desktop window: reflow controls so the primary action, panel restore,
  result summary, and evidence controls remain reachable without overlapping the canvas.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Studio MUST provide a canvas-first workspace beside a work panel, with clearly
  separated session context, primary action, work history, and result details. The default desktop
  layout places the work panel on the left and the larger canvas on the right.
- **FR-002**: Users MUST be able to resize and collapse/restore the work panel without changing
  run execution, draft text, or selected evidence. A collapsed panel MUST leave a compact current
  status and a discoverable restore control. Keyboard-only operation MUST be supported.
- **FR-003**: Each existing mode MUST expose only its supported inputs and actions. The legacy
  bounded request remains available; captured-candidate verification MUST NOT imply chat, a model
  diagnosis, provider selection, or editable candidate generation where none exists.
- **FR-004**: Studio MUST present observed work as readable, chronologically ordered activity
  with expandable details and an identifiable current phase. It MUST NOT invent agent messages,
  hidden reasoning, completed steps, elapsed progress percentages, or successful checks.
- **FR-005**: Ready, starting, active, finalizing, result-unavailable, and terminal states MUST
  communicate their meaning and supported next action. Stream availability MUST be distinct from
  execution and authoritative result status; final success MUST require the existing final result.
- **FR-006**: New activity MUST preserve keyboard focus and the reading position of users
  inspecting earlier work; users MUST be able to return to the latest activity explicitly.
- **FR-007**: A finalized result MUST prioritize its verdict, explanation, and failed or
  unevaluable checks, while retaining access to every applicable gate/check and available reason.
  The nine legacy gates, ten captured-path checks, and distinct success claims remain unchanged.
- **FR-008**: The canvas MUST offer clearly labelled access to available failure and replay
  visual evidence for comparison, with its phase and evidence identity accessible. Missing,
  unavailable, or unreached evidence MUST be explained without fabricated substitutes.
- **FR-009**: Studio MUST distinguish a live verification target, a non-live preview, a target
  that is not ready, and stored evidence after finalization. It MUST retain existing observation
  guards and automatic disposal, without extending a target's lifetime for visual review.
- **FR-010**: The feature MUST establish and apply one documented core design system for color
  roles, type hierarchy, spacing, surfaces, focus treatment, and interaction states, covering the
  workspace's buttons, request field, tabs, status indicators, activity cards, and disclosures.
  Equivalent meanings and actions MUST have consistent presentation across both existing modes.
- **FR-011**: Primary controls and details MUST have readable names, visible keyboard focus,
  predictable focus order, and text or icon explanations beyond color alone. Normal text MUST
  meet at least 4.5:1 contrast; large text and meaningful control boundaries MUST meet 3:1.
- **FR-012**: At the desktop sizes and zoom levels in Assumptions, users MUST reach primary
  actions, panel restore, result summary, and evidence controls without overlap, clipping of
  actionable content, or a page-wide horizontal scrollbar. Local scrolling of dense details is allowed.
- **FR-013**: Presentation changes MUST preserve existing prepared-case scope, request limits,
  authoritative outcomes, evidence/provenance safeguards, single-run session rules, original-file
  integrity, cancellation behavior, and cleanup. No new model call or unredacted output may be
  introduced merely to populate the new workspace.

### Key Entities

- **Studio workspace**: The current session's canvas, work panel, mode, and primary action;
  panel size/collapse and selected evidence are presentation choices, not execution state.
- **Work card**: A readable grouping of already observed run activity, its status, and available
  details. It is neither a separate agent task nor evidence that unobserved work happened.
- **Result summary**: The authoritative outcome, its bounded claim, failed/unevaluable checks,
  and links to available supporting evidence for this run.
- **Evidence view**: A labelled live/preview surface or a stored visual observation, with phase
  and identity. A stored observation is not an interactive verification target.
- **Core design rule**: A reusable presentation or interaction rule applied consistently to
  the Studio controls in scope, not a general-purpose component marketplace or new product service.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During an owner walkthrough without verbal coaching, the owner identifies the
  selected case/candidate and starts a ready run within 30 seconds in each existing mode, without
  opening detailed checks or raw logs. The result is recorded per mode, not claimed as a population study.
- **SC-002**: For six presented states (ready, active, finalizing, disconnected activity without
  a result, unsuccessful final result, successful final result), the owner correctly identifies
  what is happening and the supported next action within 15 seconds each, without raw-log reading.
- **SC-003**: In finalized examples of both modes, the owner finds the verdict, an unsuccessful
  or unevaluable check when present, and available before/after evidence within 30 seconds per
  example; the owner correctly distinguishes live content from stored evidence in every example.
- **SC-004**: In both modes, resizing and collapsing/restoring the panel preserves the current
  run, request draft when present, selected evidence, and focus accessibility in ready, active,
  and finalized states wherever each item applies.
- **SC-005**: All controls required for the start-to-result journey are keyboard reachable with
  visible focus; all in-scope text/control contrast checks meet FR-011, and the layout meets FR-012
  at every specified size/zoom combination.
- **SC-006**: All baseline compatibility scenarios for both modes retain the same outcomes,
  success labels, gate/check requirements, input restrictions, and cleanup guarantees. No UI
  animation, stream event, or design fixture alone can produce a successful final verdict.
  The minimum scenario set includes ready/start rejection, successful verification, failed and
  unevaluable checks, activity disconnection, interruption, and cleanup failure where applicable.
- **SC-007**: A documented visual inventory covers every control family named in FR-010,
  including applicable default, focus, disabled, active, and error states. Owner review records
  whether hierarchy, density, and work-to-canvas balance are acceptable; pending or negative
  feedback is not recorded as visual acceptance.

## Assumptions

- The scope, workspace direction, and preview-first review sequence above were accepted by the
  owner on 2026-11-03, separately from the earlier functional smoke test. No actual design preview
  has been accepted yet. The usability time limits are acceptance targets, not measured results.
- Desktop browser use is primary: check 1280 x 720 and 1920 x 1080 at 100% zoom, and 1280 x 720
  at 200% zoom. Compact layouts may rearrange the panes. Touch-first/mobile design is out of scope.
- Start with one coherent light appearance and English product copy. Exact palette, typeface,
  dimensions, and component implementation are design decisions for Plan and visual review;
  dark-mode switching, localization, and a brand redesign are not required here.
- The initial panel arrangement follows Lovable's conversation-left/preview-right pattern.
  A user-selectable left/right docking system and cross-session layout persistence are not required.
- Depend on the capabilities already delivered by Specs 001-004. The conversation-like surface
  organizes supported requests and observed work, not a new multi-turn chat or coding-agent runtime.
- During subsequent design work, review an interactive, clearly labelled design preview covering
  the principal states with the owner before production UI implementation. Simulated preview states
  are design material, never runtime verification evidence or proof that acceptance tests passed.
- Automated or agent-executed verification covers state fidelity, panel preservation, keyboard
  mechanics, contrast, layout constraints, and compatibility. Human review is limited to whether
  the owner understands the actions/states/evidence (SC-001-SC-003) and accepts the visual
  hierarchy, density, and balance (SC-007); it does not repeat the mechanical regression checklist.

### Scope and Non-Goals

In scope: the existing Studio workspace, its two current modes, state guidance, available evidence
inspection, desktop accessibility, and the small design system needed by these surfaces.

Out of scope: a presentation/HTML authoring product, arbitrary-project support, new scenario families,
live coding-agent integration, multi-turn chat, new model/provider choices, direct target editing,
new in-panel cancel/retry/resume operations, retained interactive targets, saved-session reopening,
cross-run history or rollback, authentication, deployment, and a separately published design library.

### Reference Boundaries

- [Claude Artifacts](https://claude.com/features/artifacts): conversation beside a prominent
  result; use the spatial hierarchy, not its document/slides authoring feature set.
- [Lovable editor](https://docs.lovable.dev/features/projects/editor) and
  [work activity cards](https://docs.lovable.dev/features/projects/chat#follow-the-work-in-activity-cards):
  separate preview from work history and disclose detail on demand; do not import its integrations.
- [v0 Design mode](https://v0.app/docs/design-mode): a clear preview toolbar and comparison
  affordances; selecting/editing target elements is not included in this specification.
- References inform interaction patterns only. Do not copy proprietary assets, branding, or source.
  FlowProof's verification semantics take precedence over similarities to reference products.

### Delivery Boundary

Plan and Tasks must define reviewable implementation slices under [CONTRIBUTING.md](../../CONTRIBUTING.md). This feature
is not automatically one implementation PR. Workspace/core controls, work-state presentation,
and result/evidence presentation are candidate boundaries, not an approved ledger or task list.
