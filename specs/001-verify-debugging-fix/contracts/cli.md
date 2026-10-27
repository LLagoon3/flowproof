# CLI Contract: `flowproof studio` and `flowproof run`

## Command

```text
flowproof studio [--scenario <scenario-id>] [--artifacts-dir <repo-relative-path>] [--no-open]
flowproof run --scenario <scenario-id> [--request <text>] [--artifacts-dir <repo-relative-path>]
```

`studio` is the primary local experience. It starts the loopback service and opens headed Chromium
unless `--no-open` is supplied. Without `--scenario`, the Studio presents the two committed demo
cases for selection. `run` executes the same engine without the Studio for tests and CI. Both
commands resolve the selected ID through the committed scenario registry. The default artifact
root is `.flowproof/runs`.

The Studio accepts a bounded natural-language request through chat. Headless `run` accepts the same
goal through `--request` or uses the scenario's committed `default_request`. Neither surface accepts
source paths, expected values, commands, gate definitions, or patch instructions.

## Preconditions

- The selected registered scenario validates against `scenario.schema.json`.
- The repository has a `HEAD` commit and no tracked working-tree changes.
- The scenario, oracle, provider fixture, and permitted source files resolve inside the repository.
- Hero mode can read `MODEL_API_KEY` from the process environment or ignored local `.env` file.
- The artifact root is ignored by Git and is not a symlink outside the repository.
- Studio mode can bind an available loopback port and launch the pinned Chromium build.

A failed precondition must not start the app, call Meta Model API, create a patch, or alter the
original working copy.

## Studio launch output

The launcher prints a small machine-readable object after the browser is ready:

```json
{
  "mode": "studio",
  "origin": "http://127.0.0.1:43117",
  "session_id": "8d45c8c4-369e-4200-bfed-02eedd4a3489"
}
```

The launch credential is delivered through a secure browser cookie and is never printed. The
process stays active until the Studio closes or receives an interrupt. `--no-open` prints the same
object without launching Chromium.

## Headless run output

`run` emits newline-delimited progress messages suitable for CI. Its final line is one JSON object:

```json
{
  "run_id": "3d2642cc-e3d1-4c15-ae44-56fa719cd48e",
  "status": "Verified Fix",
  "result_path": ".flowproof/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/result.json",
  "report_path": ".flowproof/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/report.html"
}
```

Launcher output, progress messages, and final objects must not contain API keys, cookies,
authorization headers, query strings, request or response bodies, raw unsanitized chat, raw prompts,
or raw model output.

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

For `studio`, normal user shutdown exits `0`. Pre-launch validation uses `3`, and an unrecoverable
local service or browser-launch failure uses `4`. Individual run outcomes remain visible in the
Studio and do not terminate the Studio process.

## Artifact contract

For every started run, the command creates one `.flowproof/runs/<run-id>/` directory. A finalized
run contains at minimum:

- `result.json`, valid against `run-result.schema.json`;
- `report.html`, the static Proof Trail;
- `events.jsonl`, ordered events valid against `studio-event.schema.json`;
- `evidence/failure/manifest.json`, valid against `evidence-bundle.schema.json`;
- sanitized evidence artifacts referenced by that manifest; and
- the failure screenshot.

Diagnosis, candidate diff, replay evidence, replay screenshot, and visual diff are required only
when the corresponding phase was reached. Partial or failed runs must never invent those artifacts.

## Side-effect boundary

- All app execution, dependency linking or installation, patch checks, patch application, and replay
  occur in an operating-system temporary detached Git worktree.
- The Studio service binds only to loopback and exposes only the routes in `studio-api.md`.
- The command never commits, changes branches, pushes, opens a pull request, or edits the original
  working copy.
- Cleanup removes the temporary worktree. Cleanup failure forces `Unverified` and is reported
  without deleting the retained run artifacts.
