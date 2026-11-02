# Data Model: Editing Change Capture

This defines in-process design data, not a database, durable audit store, or external JSON API.

## Existing data kept unchanged

`EditingSessionRequest`, `EditingSessionHandle`, `EditingSessionResult`, and existing execution and
cleanup enums keep the Spec 002 contract. Existing callers receive no new fields or file inspection.

## Capture workspace (private)

- Trusted workspace path and starting commit, from `PreparedWorkspace`.
- Private Git directory/index/object output beneath the owned session root, not agent-mounted.
- Trusted original object directory used read-only for baseline objects.
- No workspace/Git-directory path is exposed by the capture result.
- Created only for opt-in capture; cleaned as part of workspace state, not a new lifecycle category.

## Captured candidate

- `sessionId`: same identity as the wrapped execution result.
- `baselineCommit`: full trusted starting object ID, not editor HEAD.
- `patch`: binary-safe bytes containing one full-index, binary-capable Git patch.
- `files`: ordered changed-file records, derived from the same captured tree as the patch.
- `coverage`: main repository only; when baseline/final tree contains gitlinks, fixed explicit note
  that nested working-tree changes were neither inspected nor captured.

A changed-file record carries raw relative path bytes, operation (`added`, `modified`, `deleted`,
including mode/type changes), old/new Git modes, object IDs when present, and byte lengths where
applicable. A rename can be two records. Raw paths avoid lossy filename decoding; no UI presentation
schema is needed now. Gitlink entries carry commit references, not nested file/blob payloads.

Candidate data is a snapshot, independent of the later deleted workspace. Copy retained byte buffers
at the ownership boundary; TypeScript readonly types do not alone make a Buffer immutable. Do not
retain a mutable alias that changes the patch after its summary or scanner result was computed.

## Capture result

A small discriminated union, not another execution state machine:

| Status | Candidate | Meaning |
| --- | --- | --- |
| `captured` | Required | A complete main-repository change candidate passed applicable capture checks. |
| `no_changes` | None | No main-repository versioned diff; not a recursive submodule cleanliness claim. |
| `rejected` | None | Known sensitive-data, representability, view, or budget condition prevented release. |
| `failed` | None | Operational read/Git/preparation/interruption failure prevented capture. |
| `not_attempted` | None | The editor did not finish successfully with confirmed termination. |

All statuses can carry the fixed reference-only coverage note when applicable. Non-success details
are stable reason codes plus fixed bounded safe messages. Do not echo Git stderr, exception text,
unsafe path bytes, scanner finding paths, content, or secret matches. No raw partial patch is kept.

## Reason categories

- `EDITOR_NOT_SUCCESSFUL`: capture not attempted.
- `WORKSPACE_VIEW_UNAVAILABLE`: obscured/unproved workspace view; rejected.
- `UNREPRESENTABLE_ENTRY`: a non-Git entry would be silently omitted; rejected.
- `SENSITIVE_DATA`: applicable existing scanner matched; rejected.
- `CAPTURE_LIMIT`: common byte budget or total deadline exhausted; rejected.
- `CAPTURE_INTERRUPTED`: interrupted capture, no candidate; failed.
- `CAPTURE_IO_FAILED`: operational file/Git error; failed.

These result facts suffice for a future caller to generate model feedback. No policy IDs, retry
attempt ledger, plug-in callbacks, or repair graph are needed.

## Session composition

The opt-in result is `{ session: EditingSessionResult, capture: CaptureResult }`. Execution and
cleanup are not inferred from the capture status. A captured candidate with `session.cleanup.status`
`failed` remains visibly an unsuccessful finalization, not a `Verified Fix` or successful clean run.

## Validation invariants

1. Only `captured` has a nonempty patch/files pair, matching the same baseline/session.
2. Failure/rejection/no-changes/not-attempted never have candidate bytes or partial records.
3. Link records never contain target-file contents; gitlinks never contain nested worktree contents.
4. Capture follows confirmed editor success and precedes disposal; results resolve after cleanup attempts.
5. No result exposes internal source/workspace locator fields or claims verification. Candidate
   project bytes are not a hidden workspace-access API; safe reasons never expose host paths.
6. Fixed messages must be bounded by the existing diagnostic scale; no per-user configuration registry.
