# Data Model: Project-Live Demonstration and Verification

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

These are planned strict, versioned data contracts, not implemented TypeScript definitions.
Use closed discriminated objects, bounded lengths/counts and explicit unavailable states. Hashes
are SHA-256 over canonical data/exact bytes as appropriate; IDs are host-generated UUIDs. Never use
client-supplied paths or IDs as filesystem authority. No raw credentials, cookies, headers, provider
body, reasoning, excluded input, or unmasked screenshot belongs in these entities.

## Entities and Relationships

### ProjectContext

- `project_id`, canonical root (controller-private), safe displayed root/label, full baseline commit,
  optional branch, admitted-tree digest and original integrity snapshot reference.
- `category: vite-static-v1`, profile/dependency-set IDs and digests, lock digest, allowed source
  path manifest and protected configuration/test/input digests.
- Admission state `inspecting|ready|blocked|stale`, fixed reason codes and required prerequisites.
- The canonical path and full integrity snapshot never enter a model request. Display path is
  owner-visible session context; logs/errors use safe identifiers rather than arbitrary path dumps.

**Validation**: canonical readable Git root and exact committed revision; no tracked modifications,
untracked source prerequisites, symlink/gitlink/runtime secret files, unsupported workspace or lock
mismatch. Revalidate before each capture preparation and before editing; never refresh baseline silently.

### ExecutionConfiguration

- `configuration_id`, project/baseline identity, confirmed entry path, owned target origin,
  fixed category, direct-argv build/output settings, required project-check actions and input digests.
- Profile-owned immutable image/dependency digests, offline/network policy, environment allowlist,
  CPU/memory/PID/phase/byte limits; host selects these, not the browser or project file.
- Confirmation state/time and canonical `configuration_digest`.

**Validation**: entry is relative same-origin; argv arrays have finite bounds, no shell wrapper,
NUL/embedded environment assignment or host path; work/output paths are confined to owned snapshot.
No image/network/mount/credential/endpoint policy in user configuration. No required-check removal.
Changing settings invalidates capture/prepared state and requires a new confirmed attempt.

### DemonstrationCapture

- `capture_id`, parent `run_id`, project/baseline/configuration identity, viewport, target origin,
  document epochs and capture state.
- Ordered sanitized `InteractionObservation` records; safe image/error observation registry;
  unavailable/unsupported/dropped counters and explicit completeness reasons.
- Monotonic start/end timestamps for ordering, not a human time-to-completion gate; seal digest
  after Finish drains outstanding events. Capture duration may be displayed only as an observation.
- In-memory sanitized staging until Finish; discarded data is cleared and is not analyzed or retained
  as a report. After Finish, persist safe registered observations only; analysis needs user action.

**Transitions**: `idle -> recording -> finishing -> ready`; `recording|finishing|ready -> discarded`
before analysis; overflow/unsupported attribution -> `incomplete|unsupported`. Ready immutable;
re-record creates a new capture identity. No automatic deadline moves a human capture to failure.
Once analysis starts, its sealed report is not retroactively discarded as if it was never submitted;
Cancel stops future work and the UI explains any data already sent. A later report is a new attempt.

### InteractionObservation

- Host-assigned global `sequence`, capture/document epoch, source frame identity, monotonic event
  offset, action type and bounded normalized target locator candidates.
- `click`, safe `fill`, native `select`, coalesced `scroll`, or relative same-origin `navigate`.
- Admitted safe synthetic value for fill/select; redaction/missing-value reason instead of sensitive
  content. Never infer a secret input from screenshots or replay a redaction token as the original.
- Related image/error observation IDs. Recorder-supplied fields are untrusted; host supplies authority.

**Validation**: actual admitted target source, strict action schema, valid epoch/order, unique host
sequence, bounded locator/value/path, same-origin navigation and no unrelated frame/desktop content.
A recorded event does not attest that a hostile page did not synthesize it; preserve this limitation.

### SafeObservation / EvidenceItem

- Host observation ID, run/capture/baseline/phase, type (`image|console|page-error|network-error`),
  safe artifact digest/registered path reference, sequence range and viewport where applicable.
- `available|omitted|unavailable`, reason, sanitization/masking policy version and redaction counts.
- Image: masked PNG only, target clip and associated phase/build identity. Raw pre-mask pixels are
  not persisted, logged or submitted. Unknown sensitive surfaces are excluded/unsupported.
- Error: sanitized bounded text or method/relative-path/status/error class; no headers/body/query
  secrets/cookies. An absent collector is explicit; empty error lists are not proof all errors were observed.

### Interpretation

- Actual `invocation_id`, capture/report/input digests, `ready|clarify|unsupported` status.
- Readable observed problem, available observation citations, proposed replay and expectation, and
  why those observations support the interpretation. A summary is not hidden model reasoning.
- Clarify: one focused question, missing-intent explanation and optional bounded answer alternatives;
  explicit user answer has its own sanitized identity. At most one user-triggered re-analysis.
- Unsupported: fixed safe reason and what must be re-recorded or cannot be handled.

**Validation**: all citations resolve to included safe capture evidence; no generated command/code,
unknown action/check/locator, fabricated observation, alternate provider or arbitrary file-read request.
A `ready` result must include a supported nontrivial expected condition and complete replay.

### FrozenVerificationDefinition

- `definition_id`, project/baseline/configuration/report/interpretation digests, confirmed expectation
  and immutable replay/check DSL plus required build/check/evidence obligations.
- Host compiler/version and protected source/config/check digests; host-private canonical definition
  outside candidate snapshot. `definition_digest` binds the exact obligation evaluated twice.
- Expected condition is frozen before editing and baseline replay; ambiguity must be resolved first.

**Validation**: initial target state fixed, actions executable under category, expected condition
connected to cited demonstrated behavior. Only a fully executed baseline replay with the intended
condition failure unlocks correction. An always-false arbitrary check is rejected by supported-check
and intent review; model inference still cannot prove the user's broader intent automatically.

### ProviderInvocation

- `invocation_id`, `run_id`, phase `analysis|clarified-analysis|correction`, requested model,
  observed model, safe provider response ID, request input digest, included source/evidence IDs.
- `started|completed|failed|cancelled`, sanitized error code, optional HTTP status/token counts/
  latency, completion time. `test_transport` is explicit and disqualifies live acceptance.
- No raw key, Authorization header, prompt dump, provider body or reasoning is retained.

**Validation**: completed exchange contains expected response type/model/id and strict phase output;
absence/mismatch is invalid. A configured constant or nonblank key never sets `completed`.
One correction call/run; analysis call count <=2, second gated by explicit clarification answer.

### Candidate

- `candidate_id`, run/baseline/definition identity, actual correction invocation reference,
  exact UTF-8 patch digest, allowed changed path list, expected source tree digest after application.
- `proposed|rejected|applied-to-copy`, fixed guard reasons, actual isolated candidate build digest.
- Up to eight existing admitted regular source text files and 64 KiB patch. Config/test/check/lock,
  symlink/binary/mode/new/deleted/renamed/outside-root changes are never candidates for execution.

**Validation**: closed response schema/citations, exact source baseline, patch applies cleanly in
owned copy with private Git metadata, no protected-path mutation, scan for excluded material.
`applied-to-copy` means no change to the original repository.

### ProjectRunResult

- `kind: project-live`, schema version, run/project/baseline/configuration/report/definition IDs and
  digests, candidate/model identities when reached, required check list, available evidence/diff refs.
- Terminal outcome, safe primary reason and additional blockers; original integrity and cleanup.
- Every check is `passed|failed|not_evaluated` with phase/evidence/reason; no missing check is a pass.
- Result text **Project verification passed** only for success. Other results distinguish blocked
  readiness, unsupported capture/analysis, not reproduced, generation failure, rejected candidate,
  failed verification, unverified evidence, canceled and cleanup/integrity failure.
- A non-success can expose a captured patch or partial evidence only if actual, safe and registered.

**Validation**: success requires all mandatory checks true, intended baseline failure, one actual
candidate, matching identities/hashes, unchanged original and complete/recovered verified cleanup.
Requested cancellation is sticky and cannot be overwritten by a late provider/build result.

## Run State Machine

```text
project-selected -> configuration-required -> preparing -> demonstration-ready
  -> recording -> capture-ready -> analyzing
  -> clarification-required -> analyzing (explicit answer, at most once)
  -> interpretation-ready -> baseline-replay
  -> correcting -> candidate-checking -> finalizing -> terminal
```

- `capture-ready -> recording` creates a new capture after discarding the old unsubmitted report.
- `interpretation-ready -> baseline-replay` requires the user's Verify-and-fix action and freezes
  the definition. It does not require the user to type its executable representation.
- Every automatic stage can fail/cancel -> finalizing -> non-success terminal. Non-reproduction
  stops before correction. Unsupported data stops before execution of unsupported operations.
- A missing/expired provider credential can be reported before analysis without claiming any call.
- Human waiting states have no execution countdown. Automatic phase timers are suspended during
  demonstration/clarification/review and never close the window on their behalf.
- Every terminal result follows integrity and owned-resource finalization. Cleanup failure overrides
  success; display lower-level results as evidence, not a competing successful terminal state.
- First version permits one active attempt; a failed/terminal attempt does not silently retry. A new
  launch supplies a new attempt. Within the pre-analysis state, discard/re-record is explicitly supported.

## Ownership and Retention

The controller owns admission snapshots, offline containers, browser context/frame, target server,
model cancellation and host-side definitions. Candidate code owns none of these capabilities. The
external owner-only state root stores sanitized review files; neither project runtime nor model can
choose its paths. Delete only resources from an explicit ownership manifest, not guessed project paths.
Retained evidence survives temporary target cleanup and is still labelled stored/non-interactive.
