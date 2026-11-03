# Data Model: Captured Candidate Verification

Owner-approved design, not implemented schemas or a new database. The owner approved the distinct
Candidate verification passed result claim on 2026-11-02; see [plan.md](./plan.md).

## Existing contracts preserved

- Editing/capture request, handle and result contracts from Specs 002/003.
- Legacy `Diagnosis`, `RunResult`, nine-gate reduction and Hero/Failure provider semantics.
- Loaded prepared scenario, immutable expected dataset/chart, Evidence IDs/bundles, existing
  guarded lookup routes and result storage.
- General Git candidate bytes and reference-only coverage. The legacy `permitted_source_paths`
  selects source evidence for that scenario; it is not a new captured-candidate edit allowlist.

## Host-side captured verification input

- Completed `CapturingEditingSessionResult`: editor success, captured status and complete upstream
  cleanup/integrity are required. Other capture outcomes cannot start a passing verification.
- Candidate is copied as a snapshot: editing session ID, full baseline object ID, raw patch Buffer,
  raw file path/mode/object metadata, coverage. No mutable caller alias survives admission.
- Trusted loaded prepared scenario and its immutable oracle plus fixed checker/build selection.
- Abort signal for existing close/process interruption; no retry policy or public callback registry.
- A verification run/request ID is assigned by the trusted Studio starter, not copied from the
  browser or confused with the earlier editing session ID.

`candidate_patch_sha256` identifies exact input bytes; hash after taking ownership and bind the same
snapshot to the private-index application and final result. Validate full baseline OID format against
repository object format (capture permits SHA-1 or SHA-256); do not reuse the legacy 40-character-only
result parser to truncate or reject a valid captured identity.

## Owned verification workspace (private)

- Actual detached worktree at `candidate.baselineCommit`.
- Original repository pre-run snapshot and current original HEAD, independent of candidate baseline.
- Private Git/index/object store outside candidate content, with trusted original objects read-only
  as alternates; no writes of candidate objects/index/refs into the original checkout.
- Exact resource manifest, active operation/process group, and idempotent disposal.
- Host paths never appear in browser payloads, event reasons or result identity.

## Result family (approved design)

A strict JSON family discriminated by `kind: captured-verification`, independent of the unchanged
legacy `RunResult`. New Studio readers use an explicit union and enforce run binding for each family.

- `schema_version`: `1.0.0` of this explicitly discriminated new family, not a silent
  reinterpretation of the legacy v1 result.
- `run_id`, `request_id`, `scenario_id`, `editing_session_id`.
- `baseline_commit`, `candidate_patch_sha256`, and inherited `coverage`.
- `status`: `passed | failed | error | interrupted`.
- `reason_code` and fixed bounded `message` for non-passing terminal outcomes; timeout is
  `interrupted` with `RUN_TIMEOUT`, user close is `interrupted` with `RUN_INTERRUPTED`.
- `checks`: the concrete mandatory checks below, with existing `pass | fail | unevaluable` status,
  safe reason/message and relevant same-run evidence references. Later unexecuted checks are
  unevaluable, not omitted or converted to pass.
- Existing before/after evidence/manifests/image references when actually produced; absent stages
  have no fabricated evidence.
- `cleanup`: completion plus original-integrity facts and safe owned-resource failure categories.
- Started/completed timestamps and total/phase durations; no fake model duration or provider result.

No Diagnosis, live-model provenance, citation success, legacy gate-array padding, raw host locator,
arbitrary command argv, patch bytes or new raw-path JSON/export format is added to this result.
If a candidate is rejected before a run exists, use the existing bounded start-error response rather
than forging a run/result ID.

## Concrete check set, not a plug-in registry

1. `input_valid`: complete captured result, source identity and upstream cleanup.
2. `baseline_reproduced`: actual baseline browser observations show the prepared defect and the
   complete failure evidence exists.
3. `application_complete`: private application exactly reproduces the candidate's versioned effects.
4. `build_passed`: trusted prepared app build completed and produced the expected servable output.
5. `tests_passed`: trusted prepared functional checker actually ran and matched expected outcomes.
6. `dataset_matches`: reuse the existing replay oracle on actual same-frame observations.
7. `canvas_matches`: reuse the existing rendered-chart oracle on actual same-frame observations.
8. `secret_scan_clean`: applicable raw candidate and whole-result/evidence checks completed cleanly.
9. `cleanup_complete`: target/runtime, operations and owned temporary worktree/Git state were released.
10. `original_unchanged`: original checkout/index/refs/worktree registration snapshot was restored.

A passing result requires all ten checks to pass, with required evidence and complete cleanup.
Failed input/checks are `failed`; operational inability to execute them is `error`; timeout/close is
`interrupted`. No non-passing mandatory check is ignored. This is not the legacy nine-gate reducer
and is not labelled `Verified Fix` under the owner-approved Plan.

## Progress and visible target

Reuse the existing Studio event envelope and supported phases: initialized, reproducing,
failure_captured, applying, replaying, finalized. Emit bounded real substep messages for preparation,
application, build and tests; no `diagnosing`/model events are emitted for this path. New check IDs
must not be smuggled into legacy `gate_updated` events. Final check rows come from the strict result.

The catalog/start context explicitly identifies the host-selected captured verification mode, so
Studio does not render a live Meta chat or nine pending provenance gates for it. This is not a
browser-selectable permission to bypass model readiness or supply another candidate.

Target presentation is one of: baseline live, candidate live, preparation/non-live, or completed
captured evidence. Live presentation refers to the actual observed iframe/served build of this run.
Final presentation swaps to existing captured evidence after the target is released. The result
shell/evidence service remains until user close; it is not a retained application runtime.

## Lifecycle invariants

- Observe baseline before candidate replay; never present unrelated preview content as either.
- Apply at most once, preserve exact patch bytes, do not repair a failed patch.
- Stop/join application/build/check/capture operations before deleting their workspace.
- Attempt all owned cleanup steps even after earlier failure, and finalize truthfully afterward.
- Browser/page closure during measurement interrupts; SSE disconnect alone is not hidden success
  or proof of missing frame. No event replay/reconnect capability is added.
- Old lifecycle/capture and Hero/Failure callers keep their existing strict contracts and behavior.
