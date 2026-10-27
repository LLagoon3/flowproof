# CLI Contract: `flowproof studio`

## Command

```text
flowproof studio [--scenario <scenario-id>]
```

`studio` is the only MVP command. It builds the Studio and trusted demo fixture, starts their local
servers, creates a launch session, injects the launch cookie into a pinned headed Chromium context,
and opens the split-view workspace. Without `--scenario`, the Studio presents the two committed demo
cases for selection.

The Studio accepts one bounded natural-language run-start request through chat. Neither the CLI nor
chat accepts source paths, expected values, commands, gate definitions, or patch instructions.

## Preconditions

- The selected registered scenario validates against `scenario.schema.json`.
- The repository has a `HEAD` commit and no tracked working-tree changes.
- The scenario, oracle, provider fixture, and permitted source files resolve inside the repository.
- Hero mode can read `MODEL_API_KEY` from the process environment or ignored local `.env` file.
- The default artifact root `.flowproof/runs` is ignored by Git and is not a symlink outside the
  repository.
- The Studio can bind an ephemeral `127.0.0.1` port, the demo app can bind its committed fixed
  `localhost` port, and the pinned Chromium build can launch.

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

The launch credential is delivered through an `HttpOnly; SameSite=Strict; Path=/` browser cookie
injected by Playwright before navigation. It is never printed. The process stays active until the
Studio closes or receives an interrupt.

Launcher output and diagnostics must not contain API keys, cookies, authorization headers, query
strings, request or response bodies, raw unsanitized chat, raw prompts, or raw model output.

## Standard error

Diagnostics use stable reason codes and safe descriptions. They may identify a scenario field,
gate, or permitted repository-relative path, but must not echo rejected secret-bearing values or
raw provider payloads.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | The Studio closed normally after no active run or a finalized run. |
| `2` | The Studio page or browser closed during a run; FlowProof finalized it as `Unverified`. |
| `3` | Scenario or clean-baseline precondition failed before the Studio could start. |
| `4` | An internal error prevented safe startup or finalization. |

## Artifact contract

For every started run, the launcher creates one `.flowproof/runs/<run-id>/` directory. A finalized
run contains at minimum:

- `result.json`, valid against `run-result.schema.json`;
- `evidence/failure/manifest.json`, valid against `evidence-bundle.schema.json`;
- sanitized evidence artifacts referenced by that manifest; and
- the failure screenshot.

Diagnosis, candidate diff, replay evidence, and replay screenshot are required only when the
corresponding phase was reached. Partial or failed runs must never invent those artifacts. The
active Studio renders the Proof Trail from these artifacts; portable report export is not part of
the MVP contract.

## Side-effect boundary

- All app execution, dependency linking, patch checks, patch application, and replay occur in an
  operating-system temporary detached Git worktree.
- The Studio service binds only to `127.0.0.1`; the prepared demo app binds only to `localhost`.
- The command never commits, changes branches, pushes, opens a pull request, or edits the original
  working copy.
- Closing the Studio during an active run or interrupting the process forces `Unverified`, flushes a
  contract-valid result when possible, and removes the temporary worktree.
