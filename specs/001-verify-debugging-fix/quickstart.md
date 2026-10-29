# Quickstart: Validate the Evidence-Grounded Fix MVP

This guide defines the runnable validation flow expected after implementation. It does not replace
the contracts or provide implementation code.

Reference [the data model](./data-model.md), [the CLI contract](./contracts/cli.md),
[the Studio API](./contracts/studio-api.md), and the JSON Schemas in
[`contracts/`](./contracts/) for the normative interfaces, artifact shapes, and reduction rules.

## Prerequisites

- Linux
- Git
- Node.js 24 LTS
- pnpm 10
- A display capable of opening the pinned headed Chromium build
- A Meta Model API key with `muse-spark-1.3` access for the live Hero run
- A clean tracked working tree at the selected baseline; ignored local files such as `.env` may
  remain present

## One-time setup

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
test -f .env || cp .env.example .env
```

The guard keeps an existing `.env` and its key. Set `MODEL_API_KEY` in `.env` before the live Hero
run or the protocol smoke; the deterministic commands below and the Failure case need no key. Never
commit `.env` or paste the key into logs, reports, fixtures, or issues.

The root `pnpm flowproof` script loads this ignored file with Node.js 24
`--env-file-if-exists=.env`. An already exported environment variable takes precedence, so no
additional environment-loader package is required.

## Validate contracts and deterministic logic

```bash
pnpm test
pnpm test:contract
pnpm test:integration
pnpm typecheck
pnpm build
```

`pnpm test` runs the unit, contract, integration, and UI projects; `pnpm test:contract` and
`pnpm test:integration` rerun one project. The live Meta smoke is excluded from all three. Some
integration tests launch the Studio in the pinned headed Chromium against temporary clones, so they
need the display, and their output includes a launch object and a `RUN_INTERRUPTED` diagnostic from
the lifecycle tests.

Expected outcome:

- Every test passes, and `pnpm typecheck` and `pnpm build` succeed. The build writes only ignored
  `dist/` outputs.
- Every valid JSON fixture validates against its contract, and every invalid fixture is rejected.
- Studio event fixtures preserve ordered, sanitized activity while connected.
- Sanitizer tests remove all seeded secret markers.
- Invalid Evidence IDs and unsafe patches are rejected.
- Only an all-pass gate set reduces to `Verified Fix`.
- Worktree tests leave the original tracked-file status, index, checked-out branch, `HEAD`, Git
  history, protected file hashes, and complete registered-worktree list unchanged. Ignored
  sanitized files under `.flowproof/runs/` are the only persistent additions beneath the original
  working tree; pre-existing unrelated worktrees remain registered.

## Open the Studio for the deterministic Failure case

```bash
pnpm flowproof studio --scenario canvas-filter-failure-invalid-citation
```

Expected outcome:

- The script compiles the engine, then prints
  `{"mode":"studio","origin":"http://127.0.0.1:<port>","session_id":"<uuid>"}` once the browser is
  ready.
- Headed Chromium opens one FlowProof Studio page with the prepared application on the left and
  Chat, Agent Activity, Evidence, Gates, and Proof Trail views on the right. The Failure case is
  preselected and its default request is prefilled.
- Select **Start run** to submit the prefilled request or an equivalent goal of up to 500
  characters. The request cannot change the committed scenario, oracle, permitted source path,
  commands, or gates.
- The known-bad chart failure is reproduced and the required failure evidence is captured.
- Agent Activity and the Proof Trail's diagnosis provenance label the diagnosis as an injected
  evaluation fixture, not a Meta Model API response, without displaying the fixture content.
- The nonexistent Evidence ID fails `citations_valid` with `CITATION_UNKNOWN_EVIDENCE_ID` before
  patch application. `patch_applied`, `dataset_matches`, and `canvas_matches` are unevaluable, and
  no candidate diff or replay evidence is written.
- The final status is `Unverified`; the failed gate and collected evidence remain visible in the
  right panel without leaving the Studio.
- The original repository's tracked files, index, checked-out branch, `HEAD`, and Git history are
  unchanged; only ignored sanitized run artifacts may be added.
- Close the Studio window or press Ctrl+C to end the session. Doing so while a run is reproducing,
  diagnosing, applying, or replaying finalizes it as `Unverified` and exits with code `2`.

## Open the Studio for the live Hero case

```bash
pnpm flowproof studio --scenario canvas-filter-hero
```

Expected outcome:

- The left target pane visibly shows the failure reproduction and patched replay while the right
  pane receives ordered activity through the local event stream.
- The initial run reproduces the incorrect filtered dataset and Canvas chart.
- The trusted probe captures the rendered bar labels and values independently of the patch target.
- A sanitized Evidence Bundle is sent once to live `muse-spark-1.3`.
- The response cites only Evidence IDs from that failure run and proposes a diff only for
  `apps/demo-chart/src/filterData.ts`.
- Failure capture and patch replay both occur in a detached temporary worktree at the selected
  baseline. The diff passes every guard, applies only there, and replays the same actions.
- The replay dataset and rendered labels and values match their fixed oracles; the fixed-size
  failure and replay screenshots remain available as review evidence.
- All nine required gates pass, the in-workspace Proof Trail shows `Verified Fix`, and total
  duration is below 300 seconds in the prepared environment.
- The original repository's tracked files, index, checked-out branch, `HEAD`, and Git history are
  unchanged; only ignored sanitized run artifacts may be added.

## Inspect the Proof Trail

Review the completed run directly in the right panel:

1. reproduction actions and failure evidence;
2. expected versus observed dataset;
3. failure screenshot, when failure capture completed;
4. diagnosis provenance and the Evidence IDs accepted by `citations_valid`;
5. candidate diff and patch-guard outcome;
6. replay screenshot, when replay completed;
7. every gate outcome and phase timing; and
8. final `Verified Fix` or `Unverified` status.

The Studio does not display the diagnosis text or injected fixture content. The strict-schema
diagnosis and every other sanitized artifact for the phases reached remain under the ignored
`.flowproof/runs/<run-id>/` directory.

The MVP keeps the Proof Trail inside the active Studio. Portable HTML export and a headless CLI are
tracked as follow-up work rather than duplicate implementation surfaces.

## Run the full end-to-end suite

```bash
pnpm test:e2e
```

The headed deterministic suite runs serially against temporary clones with `MODEL_API_KEY` unset in
the process environment. It covers the recorded Hero path, the Failure fixture, closing the Studio
while reproducing, diagnosing, and replaying, SIGINT while applying, a target-frame load failure,
and seeded secret markers. Its Hero path feeds a recorded schema-valid response only through the
in-process `startStudio({ testTransport })` test entry and does not call Meta; no CLI flag,
environment variable, scenario field, or API body can select that transport, and the committed Hero
scenario remains configured for the live Meta provider. Run the credential-gated protocol smoke
separately:

```bash
pnpm test:meta-smoke
```

Without `MODEL_API_KEY`, the live smoke prints a visible skip result and exits successfully. With a
key, it must not persist prompts, raw model output, or credentials. It records only sanitized
status, model ID, token usage, latency, schema-parse outcome, and citation-validation outcome.

## Failure expectations

Any missing evidence, invalid citation, unsafe patch, apply failure, replay mismatch, secret-marker
leak, original-repository tracked/Git-state mutation, timeout, or unavailable gate must finish as
`Unverified`. A safely finalized run always writes `result.json`, but it records only artifacts from
phases actually reached. In particular, a target-frame failure before capture keeps
`failure_screenshot_path` null and does not invent a failure Evidence Bundle. A failed run is a
valid test result when its failed gate and safe artifacts are reported accurately.
