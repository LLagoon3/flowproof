# FlowProof

FlowProof is a local tool for checking whether an AI-proposed fix really fixes a reproducible
visual web defect. Instead of trusting a plausible patch, it reproduces the failure, ties the
diagnosis to evidence from that failing run, applies the candidate change only to an isolated copy,
replays the same scenario, and reports `Verified Fix` only when fixed deterministic checks pass.
Otherwise the result is `Unverified`.

This repository holds the hackathon MVP defined by
[feature 001: Evidence-Grounded Fix Verification](./specs/001-verify-debugging-fix/spec.md). The
MVP covers exactly one prepared defect in a Canvas bar chart and two committed demo cases.

## What the MVP does

`pnpm flowproof studio` opens the **FlowProof Studio**, a local split-view workspace in a headed
Chromium window:

- **Left:** the prepared demo application, a Vite and Chart.js page served from
  `http://localhost:43119/`.
- **Right:** the FlowProof agent pane with chat, run status, Agent Activity, Evidence IDs, the
  candidate, the nine verification gates, and the final Proof Trail.

The prepared defect is in `apps/demo-chart/src/filterData.ts`, the only file a candidate change may
touch. Selecting the `North` region uses a substring match, so the chart shows eight bars, four of
them from `Northeast` rows, instead of the four expected `North` bars. The expected rows and chart
series are committed as a fixed oracle in
[`scenarios/canvas-filter/expected/`](./scenarios/canvas-filter/expected/), outside the patchable
source.

One run proceeds in this order:

1. Snapshot the original repository state and refuse to continue if tracked files have changes.
2. Create a detached temporary Git worktree at the original `HEAD`, build the known-bad app there,
   and reproduce the defect visibly in the left pane with Playwright.
3. Capture seven sanitized failure evidence items, each with a stable Evidence ID: reproduction
   actions, expected and observed dataset, rendered chart series, a fixed-size Canvas screenshot,
   console entries, metadata-only network observations, and the permitted source file.
4. Obtain one diagnosis and unified diff whose claims cite those Evidence IDs.
5. Reject unknown citations and unsafe or out-of-scope patches before anything is applied.
6. Apply the validated diff only in the temporary worktree, rebuild, and replay the same action.
7. Remove the temporary worktree, confirm that the original repository matches its snapshot,
   reduce the nine gates to the final status, and render the Proof Trail in the Studio.

### The two demo cases

| Case | Scenario ID | Diagnosis source | Expected result |
| --- | --- | --- | --- |
| Hero | `canvas-filter-hero` | One live Meta Model API `muse-spark-1.3` request | `Verified Fix` only if all nine gates pass |
| Failure | `canvas-filter-failure-invalid-citation` | A committed, clearly labeled evaluation fixture; no model call | `Unverified`: `citations_valid` fails before patch application |

The Failure fixture cites a nonexistent Evidence ID on purpose. It demonstrates that FlowProof
refuses an unsupported candidate; it is not presented as a Meta response.

### Verification gates

`Verified Fix` requires every gate to pass. A gate that fails or cannot be evaluated keeps the run
`Unverified`, and the result names it.

| Gate | Passes when |
| --- | --- |
| `failure_reproduced` | The known-bad run differs from the committed oracle. |
| `evidence_complete` | The failure Evidence Bundle holds every required evidence type. |
| `citations_valid` | Every cited Evidence ID exists in this run's failure evidence. |
| `patch_scope_valid` | The diff targets only the permitted file and passes the patch guards and `git apply --check`. |
| `patch_applied` | The diff applied in the temporary worktree and the patched app rebuilt. |
| `dataset_matches` | The replayed filtered rows exactly match the expected dataset. |
| `canvas_matches` | The rendered bar count, labels, and values exactly match the expected chart series. |
| `secret_scan_clean` | No seeded marker or credential appears in the run's artifacts. |
| `original_worktree_unchanged` | The original repository equals its pre-run snapshot after cleanup. |

Screenshots are review evidence only. Rendered chart values are read by a trusted, read-only probe
outside the patch boundary; no pixel comparison decides the result.

`Verified Fix` means the captured defect no longer reproduces under these agreed checks. It does
not claim universal correctness, absence of regressions outside the checks, production readiness,
or identical behavior in environments that were not evaluated.

## Requirements

- Linux. The MVP targets the prepared Linux environment; macOS support is not validated.
- Git.
- Node.js 24 LTS and pnpm 10 (the workspace pins `pnpm@10.34.5`).
- A display for the headed Chromium build pinned by Playwright `1.64.1`. The Studio, the
  end-to-end suite, and part of the integration suite open a visible browser.
- A Meta Model API key with `muse-spark-1.3` access, only for the live Hero case and the opt-in
  protocol smoke. The Failure case and every deterministic test run without a key.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
test -f .env || cp .env.example .env
```

For the live Hero case, set `MODEL_API_KEY` in the ignored `.env` file or export it in your shell;
an exported value takes precedence over `.env`. Never commit `.env` or paste the key into logs,
reports, fixtures, or issues.

## Run the demos

Run FlowProof from a checkout with no uncommitted tracked changes. Untracked and ignored files, such
as `.env`, may remain.

### Failure case (deterministic, no key)

```bash
pnpm flowproof studio --scenario canvas-filter-failure-invalid-citation
```

The command prints a launch object such as
`{"mode":"studio","origin":"http://127.0.0.1:<port>","session_id":"<uuid>"}` once the Studio is
ready. Select **Start run** to submit the prefilled request. FlowProof reproduces the defect,
captures the failure evidence, and labels the diagnosis as an injected evaluation fixture.
`citations_valid` fails with `CITATION_UNKNOWN_EVIDENCE_ID`, the later `patch_applied`,
`dataset_matches`, and `canvas_matches` gates are unevaluable, and the result is `Unverified`. No
candidate diff or replay evidence is written.

### Hero case (live Meta Model API)

```bash
pnpm flowproof studio --scenario canvas-filter-hero
```

Without `MODEL_API_KEY`, this command exits with code `3` before starting anything. With a key,
submit the prefilled request: FlowProof reproduces the defect, sends one sanitized request to
`muse-spark-1.3`, validates and applies the returned diff in the temporary worktree, replays the
same action in the left pane, and shows `Verified Fix` only when all nine gates pass. Any provider
error, timeout, invalid citation, unsafe diff, or oracle mismatch finishes as `Unverified`.

The deterministic test suites never call Meta. The live Hero flow is checked separately by the
credential-gated procedure in the [Quickstart](./specs/001-verify-debugging-fix/quickstart.md).

### Studio sessions

- The Studio header has a prepared-case picker. `--scenario` preselects that case and checks its
  launch preconditions, including the key for Hero. Without `--scenario`, the Studio opens without
  a key, and starting Hero without one is rejected with `PROVIDER_CREDENTIAL_MISSING` before a run
  is created.
- Each Studio launch accepts one run. Close the Studio and launch it again to run another case.
- Chat states a goal of up to 500 characters. It cannot change the scenario, the oracle, the
  permitted source file, build commands, or gates.
- Closing the Studio window or pressing Ctrl+C ends the session.

| Exit code | Meaning |
| ---: | --- |
| `0` | The Studio closed with no run or after its run finalized. |
| `2` | The Studio closed or was interrupted before its run finalized. A run stopped while reproducing, diagnosing, applying, or replaying finalizes as `Unverified`. |
| `3` | A launch precondition failed, such as a dirty tracked tree, an unregistered scenario, or a missing key for an explicit Hero launch. |
| `4` | An internal error prevented safe startup or finalization. |

### Proof Trail and run artifacts

When a run finalizes, the Proof Trail in the right pane shows the final status, the diagnosis
provenance, the failure and replay evidence with their screenshots, the candidate or verified diff,
every gate outcome, and phase timing. Evidence and diff sections for phases a run never reached
say so instead of inventing content, and their timing reads zero.

The same sanitized artifacts are kept under the Git-ignored `.flowproof/runs/<run-id>/` directory.
Every safely finalized run writes `result.json`. The `evidence/failure/` and `evidence/replay/`
manifests with their items, the strict-schema `diagnosis/diagnosis.json`, and
`candidate/candidate.diff` exist only when the run reached those phases. The Studio does not
display the diagnosis text; it shows the diagnosis provenance and the Evidence IDs accepted by
`citations_valid`. The MVP has no report export.

## Runtime build strategy

- `pnpm flowproof` compiles the engine with `tsc` into the ignored `packages/flowproof/dist/`, then
  runs `node --env-file-if-exists=.env packages/flowproof/dist/cli.js`. No TypeScript loader or
  environment-loader package is used at runtime.
- At launch, the Studio bundle and an initial demo preview are built with their package build
  scripts into operating-system temporary directories and served as static files. No Vite
  development server or hot reload is involved.
- The Studio and its JSON/Server-Sent Events API are served by a Node.js built-in HTTP server on
  `127.0.0.1` at an ephemeral port. A separate FlowProof-owned static server binds
  `localhost:43119` once and switches its document root from the preview to the known-bad build
  and then to the patched build. After each switch, Playwright reconnects the iframe and waits for
  the trusted probe to report the chart ready.
- Each run builds inside the detached temporary worktree. Its `node_modules` entries link to the
  existing install, so nothing is installed during a run, and only the committed command
  `pnpm --filter @flowproof/demo-chart run build` runs, with an allowlisted environment that
  excludes credentials.
- `pnpm build` writes ignored `dist/` outputs in the checkout for development checks; the Studio
  does not serve them.

## Security and isolation boundary

- **Original repository.** FlowProof refuses a dirty tracked baseline. It never commits, pushes,
  switches branches, or changes tracked files, the index, refs, `HEAD`, or history. A run's only
  persistent addition in the working tree is the ignored `.flowproof/runs/` directory. The
  temporary worktree lives in operating-system temporary storage. On every finalization path,
  FlowProof removes and prunes only its own worktree entry, keeps unrelated worktrees, and compares
  `HEAD`, branch, status, index, refs, history, local Git config, the registered-worktree list, and
  tracked file hashes with the pre-run snapshot.
- **Model output is untrusted.** The diagnosis is one stateless Responses API call with
  `store: false`, a strict JSON Schema response, no tools or model-selected commands, no automatic
  retry, and the scenario's 90-second timeout. FlowProof strictly parses the response, accepts only
  Evidence IDs from the same run's failure evidence, and rejects absolute, parent-directory,
  symlink, binary, rename, multi-file, oversized, or out-of-scope diffs and any diff that fails
  `git apply --check`.
- **Sanitized evidence.** Network evidence covers only target-origin requests and keeps only the
  method, origin, query-free path, status, MIME type, and duration; query strings, cookies, other
  headers, and bodies are dropped. Evidence and chat text are sanitized before they are persisted,
  displayed, or sent to the model, and a whole-run secret scan feeds the `secret_scan_clean` gate.
- **Credentials.** `MODEL_API_KEY` is read only from the process environment or the ignored `.env`
  file. It is not written to artifacts, model input, or diagnostics, and it is not passed to builds.
- **Local surface.** The Studio binds only to `127.0.0.1`. A launch cookie (`HttpOnly`,
  `SameSite=Strict`) is injected by Playwright and never printed. Every request needs the exact
  `Host` and the launch cookie; POST requests need the Studio `Origin`, and API GET and SSE requests
  need `Sec-Fetch-Site: same-origin`. Responses
  use a restrictive Content Security Policy and `Cache-Control: no-store`. Evidence is readable
  only by Evidence ID; there is no generic file route. The demo app uses a separate `localhost`
  host, so patched app code never receives the Studio cookie.
- **Lifecycle.** Closing the Studio page or browser, or sending SIGINT, SIGTERM, or SIGHUP, while a
  run is reproducing, diagnosing, applying, or replaying stops that stage, finalizes the run as
  `Unverified`, writes only artifacts for phases reached, and cleans up the worktree. Final cleanup
  and gate evaluation always complete. If the target frame cannot load the app, the run stops
  before any model call or patch.

## Testing

```bash
pnpm test              # unit, contract, integration, and UI projects
pnpm test:contract     # contract project only
pnpm test:integration  # integration project only
pnpm test:e2e          # headed Playwright end-to-end suite
pnpm typecheck
pnpm build
```

These commands need no `MODEL_API_KEY`. Tests that launch the Studio or create worktrees use
temporary clones, so the checkout's Git state is untouched. The end-to-end Hero test substitutes a
recorded response only through the in-process `startStudio({ testTransport })` test entry; no CLI
flag, environment variable, scenario field, or API body can select it. The live protocol smoke,
`pnpm test:meta-smoke`, is excluded from the default projects. It loads the ignored `.env` file and
sends a real request when a key is present, so run it only when you intend to.

## MVP non-goals

- Changing the developer's tracked files, Git index, branch, `HEAD`, or history, or automatically
  committing, pushing, opening or merging a pull request, or deploying.
- Arbitrary or user-supplied defects, arbitrary sites or URLs, browser extensions, accounts, cloud
  synchronization, or multi-user collaboration.
- Letting chat create scenarios, redefine expected behavior, or widen the permitted source
  boundary.
- A public headless CLI or CI interface, portable HTML report export, or bulk artifact downloads.
- Replay of missed activity events after an SSE disconnect, or reopening a completed Studio
  session.
- Pixel-level screenshot comparison as a gate, multi-turn agent conversations, and validated
  macOS support.

Deferred work is tracked in issues
[#5](https://github.com/LLagoon3/flowproof/issues/5)–[#12](https://github.com/LLagoon3/flowproof/issues/12).

## Repository layout

```text
apps/studio/           React Studio: target pane, agent pane, Proof Trail
apps/demo-chart/       Trusted Vite and Chart.js demo app with the prepared defect
packages/flowproof/    Engine and `flowproof studio` launcher
scenarios/             Committed scenarios, oracles, and the Failure provider fixture
specs/001-verify-debugging-fix/   Spec, plan, contracts, tasks, and Quickstart
tests/                 Unit, contract, integration, UI, and end-to-end tests
```

## Development workflow

FlowProof is developed with GitHub Spec Kit `v1.2.2`, the Spec Kit `git` extension for feature
branches, and the Codex CLI and Claude Code agent integrations. Read
[CONTRIBUTING.md](./CONTRIBUTING.md), [AGENTS.md](./AGENTS.md), and
[the project Constitution](./.specify/memory/constitution.md) before contributing.
