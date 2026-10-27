# CLI Contract: `flowproof run`

## Command

```text
flowproof run --scenario <repo-relative-json-path> [--artifacts-dir <repo-relative-path>]
```

The MVP exposes one command and requires an explicit committed scenario file. The default artifact
root is `.flowproof/runs`. The command does not accept prompts, source paths, expected values,
commands, or patch instructions from interactive input.

## Preconditions

- The scenario validates against `scenario.schema.json`.
- The repository has a `HEAD` commit and no tracked working-tree changes.
- The scenario, oracle, provider fixture, and permitted source files resolve inside the repository.
- Hero mode can read `MODEL_API_KEY` from the process environment or ignored local `.env` file.
- The artifact root is ignored by Git and is not a symlink outside the repository.

A failed precondition must not start the app, call Meta Model API, create a patch, or alter the
original working copy.

## Standard output

The command emits newline-delimited progress messages suitable for a terminal. Its final line is a
single JSON object:

```json
{
  "run_id": "3d2642cc-e3d1-4c15-ae44-56fa719cd48e",
  "status": "Verified Fix",
  "result_path": ".flowproof/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/result.json",
  "report_path": ".flowproof/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/report.html"
}
```

Progress messages and the final object must not contain API keys, cookies, authorization headers,
query strings, request or response bodies, raw prompts, or raw model output.

## Standard error

Diagnostics use stable reason codes and safe descriptions. They may identify a scenario field,
gate, or permitted repository-relative path, but must not echo rejected secret-bearing values or
raw provider payloads.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Run finalized as `Verified Fix`. |
| `2` | Run finalized safely as `Unverified`; `result.json` and `report.html` were written. |
| `3` | Scenario or clean-baseline precondition failed before a run could start. |
| `4` | FlowProof internal error prevented a contract-valid final result. |

An expected Failure demonstration exits `2`; this is a successful evaluation of fail-closed
behavior, not a `Verified Fix`.

## Artifact contract

For every started run, the command creates one `.flowproof/runs/<run-id>/` directory. A finalized
run contains at minimum:

- `result.json`, valid against `run-result.schema.json`;
- `report.html`, the static Proof Trail;
- `evidence/failure/manifest.json`, valid against `evidence-bundle.schema.json`;
- sanitized evidence artifacts referenced by that manifest; and
- the failure screenshot.

Diagnosis, candidate diff, replay evidence, replay screenshot, and visual diff are required only
when the corresponding phase was reached. Partial or failed runs must never invent those artifacts.

## Side-effect boundary

- All app execution, dependency linking or installation, patch checks, patch application, and replay
  occur in an operating-system temporary detached Git worktree.
- The command never commits, changes branches, pushes, opens a pull request, or edits the original
  working copy.
- Cleanup removes the temporary worktree. Cleanup failure forces `Unverified` and is reported
  without deleting the retained run artifacts.
