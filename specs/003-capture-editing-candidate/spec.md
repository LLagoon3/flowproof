# Feature Specification: Capture Editing Changes

**Feature Branch**: `feat/003-capture-editing-candidate`

**Created**: 2026-11-02

**Status**: Approved for planning — owner agreed to the simplified scope on 2026-11-02.

**Input**: Capture the changes an ordinary coding agent actually made in its isolated repository.
Keep this PR limited to candidate extraction and rejection reporting. Avoid a second permission
system, a custom file-type policy engine, or verification architecture beyond the current need.

## Clarifications

### Session 2026-11-02

- The owner confirmed that this feature ends at change-candidate extraction. Fresh-worktree
  application and authoritative verification belong to a later feature.
- The owner rejected excessive text-only/file-scope restrictions and then approved ordinary
  Git-representable changes: binary files, moves, executable modes, link records, and submodule
  references, without following external links or recursively copying nested working trees.
- This PR returns rejection reasons. A future feature may send those reasons back to the model
  for revision, but this PR must not implement the retry loop or speculative extension machinery.
- Extract only after successful editor execution. Recovery of intermediate changes after failure,
  timeout, or cancellation is deferred.
- Automatic editing-workspace cleanup is the default. Workspace retention for debugging is deferred.
- The owner approved this revised scope and proceeding to Plan. No new product restrictions,
  automated retry controller, or implementation work are authorized by that planning step alone.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive the Agent's Actual Changes (Priority: P1)

As a developer, I want the changes from an isolated coding session captured as a portable candidate,
without requiring the model to author patch syntax or restricting it to a special set of source files.

**Why this priority**: Spec 002 can run an editor and clean up afterward. This feature preserves its
actual changes before cleanup, which is the missing handoff to later verification.

**Independent Test**: A credential-free prepared editor changes several repository files. Compare
capture with independently expected file contents and Git changes; no live model or browser is needed.

**Acceptance Scenarios**:

1. **Given** a known starting commit, **When** the editor completes successfully, **Then** FlowProof
   captures the actual final repository changes, including additions, modifications, and deletions,
   regardless of whether the editor staged them, committed them locally, or described them correctly.
2. **Given** ordinary source, configuration, documentation, dependency-lock, or asset changes,
   **When** capture runs, **Then** these are not rejected merely because of their extension, because
   they are binary, or because they were not in a predeclared editable-file list.
3. **Given** a rename or executable-bit change, **When** capture runs, **Then** its versioned effect
   is preserved. Rename detection is optional: equivalent deletion plus addition is acceptable.
4. **Given** a versioned symbolic link or submodule reference change, **When** capture runs, **Then**
   only its Git-representable link/reference is captured; the external target or nested working tree
   is not recursively copied or inspected. Uncommitted nested changes that cannot be represented
   by that reference must be reported explicitly, not claimed to be part of the candidate.
5. **Given** no remaining changes, including edits reverted by the editor, **When** capture runs,
   **Then** the result explicitly reports no changes and contains no candidate.

---

### User Story 2 - Understand Why Capture Was Rejected (Priority: P1)

As a developer, I want either a complete candidate or a clear rejection/failure reason, rather
than a silently incomplete patch. Later, the same reason can be used to ask an agent to revise its work.

**Why this priority**: Honest output and actionable failures are necessary now; an autonomous retry
controller, policy plug-in system, and model-feedback pipeline are not.

**Independent Test**: Trigger a known secret match, an unrepresentable entry, an output-limit breach,
and a capture read error. Check that no partial candidate is returned and that each explanation is
clear without exposing sensitive bytes.

**Acceptance Scenarios**:

1. **Given** a changed payload or path triggers an existing required sensitive-data check, **When**
   capture runs, **Then** the candidate is rejected with a safe reason; no secret excerpt or altered,
   redacted substitute patch is returned.
2. **Given** a special entry that cannot be represented as an ordinary Git change, or an inability
   to obtain a complete candidate within the capture budget, **When** capture runs, **Then** the
   result explains the problem rather than silently dropping the affected change.
3. **Given** an operational read or capture error, **When** capture ends, **Then** the result reports
   failure rather than no changes or a policy violation.
4. **Given** a rejection, **When** the caller receives the result, **Then** it has a stable reason
   category and sanitized actionable explanation. No new model call, edit attempt, or retry occurs.

---

### User Story 3 - Finish Without Changing the Original Repository (Priority: P2)

As a developer, I want capture and cleanup to finish without affecting my original checkout or
misrepresenting an extracted candidate as a tested fix.

**Why this priority**: This preserves the existing local-tool boundary without adding a new product
surface or changing how the current production demo is verified.

**Independent Test**: Run successful, unchanged, rejected, failed, cancelled, and timed-out sessions;
check capture outcomes, original-checkout integrity, and existing cleanup results separately.

**Acceptance Scenarios**:

1. **Given** successful editing, **When** capture is requested, **Then** editing stops, capture runs
   before workspace disposal, and the session automatically attempts its existing cleanup.
2. **Given** editor failure, cancellation, timeout, or unproved editor termination, **When** the
   session finalizes, **Then** no candidate is extracted and normal cleanup is still attempted.
3. **Given** a cleanup or integrity failure, **When** the result is returned, **Then** that failure
   is explicit and distinct from the capture outcome; it is never described as a clean successful run.
4. **Given** an existing lifecycle-only caller or production Hero/Failure run, **When** it executes,
   **Then** its existing behavior remains unchanged. A capture-only result never says `Verified Fix`.

### Edge Cases

- New files not yet staged are included under ordinary repository ignore rules; ignored untracked
  dependency/build outputs are not automatically exported. Tracked changes remain visible even if
  their paths match an ignore rule. A changed ignore file is itself an ordinary tracked change.
- Empty files, missing final newlines, non-ASCII text, binary assets, and versioned file modes retain
  their actual versioned effect. Symlink changes record the link, not bytes from its target.
- Repository-control metadata is not exported as project content. The starting commit is retained
  by trusted code, not inferred from an editor-modified branch or staging area.
- Special files and uncommitted nested-repository contents must not be silently flattened into an
  incomplete candidate. Ordinary capture is not a recursive backup of every workspace entry.
- Secrets in removed text, file names, or binary payloads receive the applicable existing checks;
  no claim is made that arbitrary unknown secret formats can all be detected.
- Capture errors must not prevent cleanup attempts. No workspace is kept alive to await a future
  verifier or retry controller.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engine MUST derive the candidate from actual final repository state against the
  trusted starting commit, not from model-authored patches, the final branch tip, or staging alone.
  The candidate MUST identify its baseline/session and include a complete diff and changed-file summary.
- **FR-002**: Capture MUST support ordinary Git-representable changes: text and binary file additions,
  modifications, deletions, renames or equivalent delete/add, executable-bit changes, symbolic-link
  records, and submodule references. It MUST NOT impose a text-only rule, extension allowlist, or
  new predeclared editable-file list. Nested dirty worktrees are not recursively captured.
- **FR-003**: Capture MUST stay within the session repository and MUST NOT write to the original
  checkout, follow links to read external content, or export repository-control metadata. It MUST
  preserve Spec 002 isolation without adding a broker that approves each agent edit or shell command.
- **FR-004**: Existing sensitive-data checks and bounded capture time/output handling MUST apply
  before candidate release. A detected violation or unrepresentable change MUST return an explicit
  rejection, not a filtered safe subset or an altered substitute diff. An incomplete read MUST report
  failure. No separate configurable policy engine, new scanner suite, or five-axis limit registry
  is required; Plan must document the minimal bounds and applicable checks, including binary handling.
- **FR-005**: A rejection/failure MUST include a stable reason category and a bounded sanitized
  explanation sufficient to understand the problem without raw secret excerpts or host paths.
  The result MUST be usable by trusted code in a future feedback loop without introducing that loop,
  model calls, retry scheduling, or callback/plug-in frameworks in this feature.
- **FR-006**: Capture MUST occur only after successful editor execution and confirmed termination,
  and before workspace disposal. Failed, cancelled, timed-out, and incomplete executions MUST NOT
  produce an extracted candidate. A successful execution with no changes MUST be reported explicitly.
- **FR-007**: Existing automatic cleanup and original-checkout integrity reporting MUST run on all
  terminal paths. Capture and cleanup/integrity results MUST remain distinguishable; cleanup failure
  MUST NOT be presented as success. Workspace retention, debug leases, and recovery are not required.
- **FR-008**: Existing lifecycle-only callers and production Hero/Failure behavior MUST remain
  unchanged. This feature MUST NOT perform authoritative fresh-worktree application or verification,
  claim `Verified Fix`, or automatically commit, push, publish, deploy, or modify the original checkout.

### Key Entities

- **Baseline**: The trusted starting commit for the isolated session.
- **Candidate**: The actual versioned changes, with their diff, changed-file summary, and baseline/session
  identity. It is an unverified proposal, not a correctness verdict.
- **Capture result**: Candidate available, no changes, rejected, failed, or not attempted, plus an
  appropriate safe reason. These are observable outcomes, not a prescribed API schema or state machine.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Prepared successful edits reproduce exactly the expected versioned changes across text,
  binary, new/deleted files, moves, executable modes, link records, and submodule references, with zero
  missing or extra changes. Staging or local editor commits do not change the trusted comparison baseline.
- **SC-002**: No-change/reverted examples return no candidate. Prepared rejection/read-error examples
  return zero partial candidates and an accurate safe reason, with zero automatic retry/model calls.
- **SC-003**: Seeded sensitive values appear zero times in returned candidates and diagnostics;
  existing required checks reject the corresponding fixtures, including changed binary payloads.
- **SC-004**: Failed, cancelled, timed-out, and unconfirmed-termination sessions produce zero captured
  candidates. Successful cleanup leaves zero session-owned editing workspaces/processes, and the original
  checkout remains unchanged. Injected cleanup/integrity failures are reported explicitly.
- **SC-005**: Existing lifecycle-only and Hero/Failure outcomes remain unchanged; no new capture-only
  outcome claims that a fix has been verified.

## Assumptions

- The local, single-user, accidental-error/failed-process threat model from Spec 002 still applies.
  This is not a new hardened service for hostile tenants, arbitrary malicious projects, or sandbox escapes.
- Agents remain free to inspect, edit, research, and run project commands within their existing session
  boundaries. Capturing changes is not a second runtime permission or semantic code-review layer.
- Ordinary repository ignore and Git file semantics should be reused. Prefer existing Git functionality
  over custom rename inference, type-policy registries, or repository-wide scanning frameworks.
- Initial proof uses credential-free prepared editors in the existing Linux environment. Choosing and
  authenticating a live coding agent is separate work, not a prerequisite for testing capture.
- The capture integration must happen before Spec 002 disposes of the workspace. Exact internal APIs,
  minimal finite budgets, and error representations belong in Plan.
- Scope, ordinary-Git support, rejection-only handling, success-only extraction, and automatic cleanup
  are owner-confirmed. Internal implementation design is the responsibility of Plan within that scope.

## Scope Boundaries

### In Scope

- Actual Git change extraction before disposal, minimal rejection/failure reporting, existing
  sensitive-data protection, and reuse of existing cleanup/integrity behavior.
- Small deterministic fixtures that demonstrate the observable success and failure criteria.

### Out of Scope

- Fresh-worktree application/build/test/browser replay and final correctness decisions.
- Production Hero/Failure migration, live coding-agent/provider credentials, UI, exports, or hosting.
- Automated rejection-to-model repair loops, partial-result recovery, and debug workspace retention.
- New editable-path permission systems, text-only policies, custom policy engines, tool brokers,
  dedicated verification containers, or unrelated rootless/platform/network/browser-isolation work.
- Recursive capture of dirty submodule working trees or arbitrary non-versionable filesystem backups.

## Delivery Boundary

One implementation PR delivers change capture, not the entire agentic-editing feature tracked by
[#14](https://github.com/LLagoon3/flowproof/issues/14). Later verification will reuse a fresh baseline
with only the captured changes, without adding a dedicated second verification container. This draft
records the approved minimal scope and authorization to proceed to Plan, not implementation.
