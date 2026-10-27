# CLI Contract: `flowproof studio`

## Command

```text
flowproof studio [--scenario <scenario-id>]
```

`studio` is the only MVP command. It builds the Studio and initial prepared preview into
operating-system temporary output, starts their local servers, creates a launch session, injects the
launch cookie into a pinned headed Chromium context, and opens the split-view workspace. Run
execution and candidate builds occur in a detached worktree. Without `--scenario`, the Studio
presents the two committed demo cases for selection.

The root `pnpm flowproof` script uses Node.js 24 `--env-file-if-exists=.env`, so an ignored local
`.env` supplies `MODEL_API_KEY` without adding an environment-loader dependency. An already exported
process value takes precedence according to Node's environment-file behavior.

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

A failed precondition must not start the app, call Meta Model API, create a patch, or alter tracked
files or Git state.

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

For every started run, the launcher creates one `.flowproof/runs/<run-id>/` directory. Every safely
finalized run contains `result.json`, valid against `run-result.schema.json`.

Artifact requirements are phase-dependent:

- after completed failure capture: `evidence/failure/manifest.json`, its sanitized referenced
  artifacts, and the failure screenshot are required;
- after diagnosis or candidate validation: the corresponding diagnosis and candidate diff are
  required;
- after replay capture: the replay manifest, its sanitized referenced artifacts, and replay
  screenshot are required.

A run that finalizes before failure capture keeps `failure_screenshot_path` null and omits the
failure manifest. Partial or failed runs never invent artifacts for phases not reached. The active
Studio renders the Proof Trail from the artifacts that exist; portable report export is not part
of the MVP contract.

## Side-effect boundary

- Generated Studio and initial preview assets are written only to operating-system temporary
  output. Run execution, dependency linking, patch checks, patch application, and replay occur in
  an operating-system temporary detached Git worktree.
- The Studio service binds only to `127.0.0.1`; the prepared demo app binds only to `localhost`.
- The command never commits, changes branches, pushes, opens a pull request, or edits tracked files
  or Git state. Sanitized ignored files under `.flowproof/runs/` are the only repository-root write.
- Closing the Studio during an active run or interrupting the process forces `Unverified`, flushes a
  contract-valid stage-aware result when possible, and removes the temporary worktree.
