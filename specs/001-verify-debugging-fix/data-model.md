# Data Model: Evidence-Grounded Fix Verification

## Overview

The MVP holds one local Studio session, one immutable scenario definition, and one run-scoped Proof
Trail. Chat, activity, and model output are untrusted inputs or intermediate objects. Only
deterministic gate reduction produces the final status.

## Entity: Workspace Session

Represents one local split-view Studio launch.

| Field | Type | Rules |
| --- | --- | --- |
| `session_id` | UUID | Generated once per Studio launch. |
| `created_at` | ISO 8601 | UTC timestamp. |
| `scenario_id` | string or null | Selected committed case; null before selection. |
| `state` | enum | `ready`, `running`, `finalized`, or `closed`. |
| `active_run_id` | UUID or null | At most one run in the MVP. |
| `target_url` | URL or null | Allowlisted loopback iframe URL only. |

The launch credential is held in memory and an `HttpOnly; SameSite=Strict; Path=/` cookie scoped to
the Studio host, not in run artifacts. Playwright injects it before Studio navigation. The Studio
cannot change scenario commands, oracle paths, permitted source paths, or gate definitions.

## Entity: Chat Request

Represents the developer's natural-language start request.

| Field | Type | Rules |
| --- | --- | --- |
| `request_id` | UUID | Generated before the run starts. |
| `session_id` | UUID | Owning Workspace Session. |
| `run_id` | UUID | Run created for this request. |
| `created_at` | ISO 8601 | UTC timestamp. |
| `text` | string | Sanitized bounded text; no HTML rendering. |
| `scenario_id` | string | Server-selected committed scenario. |

The text may be included as the developer's goal in the model request. It is never interpreted as a
command, path, oracle, expected value, gate definition, or permission expansion.

## Entity: Predefined Scenario

Represents the trusted, committed inputs loaded before a run.

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | string | Exact supported contract version. |
| `scenario_id` | string | Stable kebab-case identifier. |
| `case` | enum | `hero` or `failure-invalid-citation`. |
| `default_request` | string | Synthetic chat goal prefilled in the Studio. |
| `app.root` | repo-relative path | Must resolve inside the repository. |
| `app.url` | URL | Fixed `localhost` HTTP URL for the MVP demo server. |
| `app.start_command` | string array | Committed command tokens; never model-generated. |
| `app.viewport` | object | Fixed width and height with device scale factor `1`. |
| `app.canvas` | object | Fixed Canvas width and height used for both phases. |
| `actions` | array | Ordered Playwright actions reused for failure and replay. |
| `oracle.dataset_path` | repo-relative path | Committed immutable JSON fixture. |
| `oracle.chart_path` | repo-relative path | Expected rendered labels and values. |
| `permitted_source_paths` | string array | Exact file allowlist; one file in this MVP. |
| `provider.mode` | enum | `meta` for Hero, `fixture` for explicit Failure evaluation. |
| `provider.fixture_path` | path or null | Required only in fixture mode. |
| `timeouts` | object | Capture, model, replay, and total millisecond limits. |

### Validation rules

- The Hero case must use the Meta provider.
- The Failure case must use the committed invalid-citation fixture and label the injection.
- The selected tracked working tree must be clean before the scenario starts.
- Oracle and provider-fixture paths must not overlap the permitted source boundary.
- Commands and paths are loaded only from the committed scenario; model output cannot modify them.
- The same `actions` array is used for failure reproduction and replay.

## Entity: Run

Owns lifecycle state, artifact paths, timing, and the final result.

| Field | Type | Rules |
| --- | --- | --- |
| `run_id` | UUID | Generated once; used by every related entity. |
| `scenario_id` | string | References one Predefined Scenario. |
| `request_id` | UUID | References the initiating Chat Request. |
| `case` | enum | Copied from the scenario. |
| `started_at` / `completed_at` | ISO 8601 | UTC timestamps. |
| `original_head` | Git object ID | Captured before any worktree operation. |
| `original_status_digest` | SHA-256 | Digest of normalized initial status. |
| `state` | enum | Lifecycle state below. |
| `phase_durations_ms` | object | Capture, model, apply, replay, and finalization durations. |
| `artifact_root` | repo-relative path | `.flowproof/runs/<run-id>/`. |
| `result` | Verification Result | Present only after finalization. |

### State transitions

```text
initialized
  -> reproducing
  -> failure_captured
  -> diagnosing
  -> candidate_validated
  -> applying
  -> replaying
  -> finalized
```

Any state after `initialized` may transition directly to `finalized` with `Unverified` when a
required step fails or becomes unevaluable. `Verified Fix` is legal only after `replaying` and only
when every required gate passes.

## Entity: Studio Event

Represents one ordered update streamed to the connected agent pane.

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | string | Exact supported contract version. |
| `event_id` | string | `<run_id>:<sequence>`; unique and stable. |
| `run_id` | UUID | Owning run. |
| `sequence` | integer | Starts at 1 and increases contiguously. |
| `occurred_at` | ISO 8601 | UTC timestamp. |
| `type` | enum | Chat, phase, evidence, candidate, gate, or final event. |
| `phase` | run state or null | Phase associated with the event. |
| `message` | string | Sanitized human-readable activity text. |
| `evidence_ids` | string array | Existing Evidence IDs made available by this event. |
| `gate` | Gate Outcome summary or null | Present only for a gate event. |
| `artifact_refs` | relative path array | Existing sanitized artifacts referenced by the event. |

Events are sanitized before SSE delivery and remain ordered while the connection is active. The MVP
does not persist or replay missed events after a disconnect. Missing, duplicate, cross-run, or
reordered events fail the Studio event contract but do not alter the authoritative run result.

## Entity: Evidence Item

Represents one sanitized observation from failure reproduction or replay.

| Field | Type | Rules |
| --- | --- | --- |
| `evidence_id` | string | `ev_<phase>_<type>_<ordinal>`; unique within the run. |
| `run_id` | UUID | Must match the owning Evidence Bundle. |
| `phase` | enum | `failure` or `replay`. |
| `type` | enum | `actions`, `dataset`, `chart`, `screenshot`, `console`, `network`, or `source`. |
| `captured_at` | ISO 8601 | UTC timestamp. |
| `artifact_path` | relative path | Resolves inside the run artifact root. |
| `sha256` | string | Digest of the persisted sanitized artifact. |
| `summary` | string | Safe human-readable description. |
| `provenance` | object | Capture mechanism and trusted origin. |
| `redactions` | array | Counts and categories only; no removed values. |

### Validation rules

- Sanitization happens before persistence, hashing, or transmission.
- Evidence IDs are immutable and cannot be created by the model.
- Network evidence contains only method, origin, path without query, status, MIME type, and timing.
- Source evidence must come from an exact permitted path and include the captured blob hash.

## Entity: Evidence Bundle

The run-scoped collection of Evidence Items used for diagnosis and verification.

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | string | Exact supported contract version. |
| `run_id` | UUID | Owner key. |
| `scenario_id` | string | Scenario reference. |
| `phase` | enum | `failure` or `replay`. |
| `items` | Evidence Item array | Unique Evidence IDs; all same run and phase. |
| `manifest_sha256` | string | Digest of canonicalized item metadata. |

The failure bundle requires all seven evidence types. The replay bundle requires actions, dataset,
chart, screenshot, console, and network; source evidence is optional unless the applied file hash
is needed for a failed gate.

## Entity: Diagnosis

The strict-schema Meta response before deterministic validation.

| Field | Type | Rules |
| --- | --- | --- |
| `summary` | string | Concise diagnosis. |
| `root_cause` | string | Claimed cause; treated as untrusted. |
| `claims` | array | Each claim has text and one or more Evidence IDs. |
| `candidate.target_paths` | string array | Must equal a subset of permitted paths. |
| `candidate.evidence_ids` | string array | Must exist in the failure bundle. |
| `candidate.unified_diff` | string | Text patch subject to all patch guards. |

### Validation rules

- Every claim and the candidate must cite existing failure-phase Evidence IDs from the same run.
- Unknown, replay-phase, duplicate-only, or cross-run references fail the citation gate.
- A schema-valid response is not automatically a valid candidate.

## Entity: Candidate Change

Represents the validated form of a Diagnosis candidate and its isolated application outcome.

| Field | Type | Rules |
| --- | --- | --- |
| `diagnosis_sha256` | string | Hash of the raw schema-valid diagnosis JSON. |
| `target_paths` | string array | Exactly validated paths. |
| `diff_path` | relative path | Persisted sanitized unified diff. |
| `diff_sha256` | string | Diff integrity digest. |
| `guard_outcome` | Gate Outcome | Citation/path/grammar/size checks. |
| `application_outcome` | Gate Outcome | `git apply --check` and apply result. |
| `worktree_head` | Git object ID | Must equal the original HEAD before application. |

## Entity: Gate Outcome

| Field | Type | Rules |
| --- | --- | --- |
| `gate_id` | enum | One of the required gates listed below. |
| `status` | enum | `pass`, `fail`, or `unevaluable`. |
| `evidence_ids` | string array | Supporting evidence from the same run. |
| `reason_code` | string | Stable machine-readable code. |
| `message` | string | Safe human-readable explanation. |
| `metrics` | object | Optional gate-specific measurements. |

### Required gates

1. `failure_reproduced`
2. `evidence_complete`
3. `citations_valid`
4. `patch_scope_valid`
5. `patch_applied`
6. `dataset_matches`
7. `canvas_matches`
8. `secret_scan_clean`
9. `original_worktree_unchanged`

`canvas_matches` compares the trusted rendered bar count, labels, and values with the committed
chart-series oracle. Failure and replay screenshots are Evidence Items for review and do not add a
pixel-comparison gate in the MVP.

## Entity: Verification Result

| Field | Type | Rules |
| --- | --- | --- |
| `status` | enum | `Verified Fix` or `Unverified`. |
| `gates` | Gate Outcome array | Exactly one outcome per required gate. |
| `failed_gate_ids` | string array | Every `fail` or `unevaluable` gate. |
| `diagnosis_path` | path or null | Null if diagnosis was never obtained. |
| `candidate_diff_path` | path or null | Null if no candidate passed validation. |
| `failure_screenshot_path` | path | Required. |
| `replay_screenshot_path` | path or null | Null when replay did not occur. |
| `total_duration_ms` | integer | Includes all run phases. |

### Reduction rule

`Verified Fix` is produced only when all nine required gates are present and `pass`. Any missing,
`fail`, or `unevaluable` outcome produces `Unverified` and appears in `failed_gate_ids`. The model
has no field that can set or override the final status. The active Studio renders the Proof Trail
from this result and the referenced evidence; portable report generation is deferred.

## Relationships

```text
Workspace Session 1 ── 0..1 Chat Request
Chat Request 1 ── 1 Run
Predefined Scenario 1 ── * Run
Run 1 ── * Studio Event
Run 1 ── 2 Evidence Bundle (failure, replay when reached)
Evidence Bundle 1 ── * Evidence Item
Run 1 ── 0..1 Diagnosis
Diagnosis 1 ── 0..1 Candidate Change
Run 1 ── 1 Verification Result
Verification Result 1 ── 9 Gate Outcome
```
