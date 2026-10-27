# Quickstart: Validate the Evidence-Grounded Fix MVP

This guide defines the runnable validation flow expected after implementation. It does not replace
the contracts or provide implementation code.

Reference [the data model](./data-model.md), [the CLI contract](./contracts/cli.md), and the JSON
Schemas in [`contracts/`](./contracts/) for the normative artifact shapes and reduction rules.

## Prerequisites

- Linux or macOS
- Git
- Node.js 24 LTS
- pnpm 10
- A Meta Model API key with `muse-spark-1.3` access for the live Hero run
- A clean tracked working tree at the selected baseline; ignored local files such as `.env` may
  remain present

## One-time setup

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
cp .env.example .env
```

Set `MODEL_API_KEY` in `.env`. Never commit `.env` or paste the key into logs, reports, fixtures, or
issues.

## Validate contracts and deterministic logic

```bash
pnpm test
pnpm test:contract
pnpm test:integration
```

Expected outcome:

- Every JSON fixture validates against its contract.
- Sanitizer tests remove all seeded secret markers.
- Invalid Evidence IDs and unsafe patches are rejected.
- Only an all-pass gate set reduces to `Verified Fix`.
- Worktree tests leave the original HEAD, status, and protected file hashes unchanged.

## Run the deterministic Failure case

```bash
pnpm flowproof run --scenario scenarios/canvas-filter/failure-invalid-citation.json
```

Expected outcome:

- The known-bad chart failure is reproduced and the required failure evidence is captured.
- The report labels the provider response as an injected evaluation fixture.
- The nonexistent Evidence ID fails `citations_valid` before patch application.
- The final status is `Unverified` and the failed gate is visible in the HTML report.
- The original working copy and Git history are unchanged.

## Run the live Hero case

```bash
pnpm flowproof run --scenario scenarios/canvas-filter/hero.json
```

Expected outcome:

- The initial run reproduces the incorrect filtered dataset and Canvas chart.
- The trusted probe captures the rendered bar labels and values independently of the patch target.
- A sanitized Evidence Bundle is sent once to live `muse-spark-1.3`.
- The response cites only Evidence IDs from that failure run and proposes a diff only for
  `apps/demo-chart/src/filterData.ts`.
- Failure capture and patch replay both occur in a detached temporary worktree at the selected
  baseline. The diff passes every guard, applies only there, and replays the same actions.
- The replay dataset, rendered labels and values, and Canvas screenshot match their fixed oracles.
- All nine required gates pass, the final status is `Verified Fix`, and total duration is below
  300 seconds in the prepared environment.
- The original working copy and Git history are unchanged.

## Inspect the Proof Trail

The command prints the run artifact directory. Open its report:

```bash
xdg-open .flowproof/runs/<run-id>/report.html
```

Review the following in one flow:

1. reproduction actions and failure evidence;
2. expected versus observed dataset;
3. failure screenshot;
4. evidence-linked diagnosis;
5. candidate diff and patch-guard outcome;
6. replay screenshot and visual diff;
7. every gate outcome; and
8. final `Verified Fix` or `Unverified` status.

## Run the full end-to-end suite

```bash
pnpm test:e2e
```

The deterministic suite uses provider fixtures. Run the credential-gated live smoke separately:

```bash
pnpm test:meta-smoke
```

The live smoke must not persist prompts, raw model output, or credentials. It records only sanitized
status, model ID, token usage, latency, schema-parse outcome, and citation-validation outcome.

## Failure expectations

Any missing evidence, invalid citation, unsafe patch, apply failure, replay mismatch, secret-marker
leak, original-worktree mutation, timeout, or unavailable gate must finish as `Unverified`. A failed
run is a valid test result when its failed gate and safe artifacts are reported accurately.
