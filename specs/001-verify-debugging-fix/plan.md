# Implementation Plan: Evidence-Grounded Fix Verification

**Branch**: `feat/001-verify-debugging-fix` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-verify-debugging-fix/spec.md`

## Summary

Build a local TypeScript split-view Studio that opens the prepared Canvas application on the left
and Chat, Agent Activity, Evidence, Gates, and the Proof Trail on the right. A local engine drives
the visible target frame with Playwright, asks Meta Model API `muse-spark-1.3` for a
schema-constrained diagnosis and diff, applies the validated diff in a detached Git worktree, and
replays the same scenario. The CLI only launches the Studio; the active workspace renders the Proof
Trail from local contract-valid artifacts. The engine never changes tracked files, the index, the
checked-out branch, `HEAD`, or Git history in the original repository. The only persistent write
beneath that working tree is the ignored sanitized run-artifact directory; detached-worktree Git
metadata is transient, scoped to the resolved Git common directory, and removed before
finalization.

## Technical Context

**Language/Version**: Node.js 24 LTS, TypeScript 7.0 compiled with `tsc` to `dist/`; the root
launcher runs `node --env-file-if-exists=.env packages/flowproof/dist/cli.js`

**Primary Dependencies**: pnpm 10 workspace, React 19, Vite 8, Commander 15, Zod 4, OpenAI
JavaScript SDK 7, Playwright 1.64, Chart.js 4

**Storage**: Local sanitized run artifacts under ignored `.flowproof/runs/<run-id>/`; generated
Studio preview assets and detached Git worktrees under operating-system temporary directories; no
database or cloud storage; transient worktree administrative metadata only under the path resolved
by `git rev-parse --git-common-dir`

**Testing**: Vitest 5 for unit and contract tests; Playwright for Studio, browser capture, and
deterministic Hero/Failure end-to-end scenarios using recorded provider transport; committed JSON
and image fixtures for deterministic assertions; credential-gated live Meta smoke and Hero
Quickstart validation run separately

**Target Platform**: The prepared Linux hackathon environment with Git, Node.js 24, pnpm 10, and
headed Chromium

**Project Type**: Local React Studio, Node.js orchestration service and launcher, plus one trusted
Vite/Chart.js demo fixture

**Performance Goals**: Excluding the initial root dependency install, open the Studio within ten
seconds and complete the Hero run in less than five minutes; target budgets are 45 seconds for
failure capture, 90 seconds for one model call, 120 seconds for worktree setup/build/replay, and 15
seconds for result generation

**Constraints**: One predefined defect, permitted source file, Studio session, and active run; one
model call per normal run; loopback-only local service; fixed framed target; chat cannot change the
scenario, oracles, source boundary, or gates; fail closed on missing evidence, invalid citations,
unsafe patches, API failures, or unevaluable gates; the prepared tracked working tree must be clean;
tracked files, Git index, checked-out branch, HEAD, and history must remain unchanged; ignored
sanitized run artifacts are the only persistent working-tree additions; the registered-worktree
list must equal its pre-run snapshot after FlowProof removes and prunes its own temporary entry

**Scale/Scope**: One Hero case and one deterministic Failure fixture derived from the same defect;
one local Studio process, one browser context, one target iframe, one temporary worktree, and one
run-scoped artifact bundle

## Constitution Check

*GATE: Passed before Phase 0 research and passed again after Phase 1 design.*

### I. Clean-Room Development — PASS

- The demo application, scenario, source context, expected dataset, expected chart series, and
  seeded secret markers are synthetic and committed specifically for this project.
- Runtime capture is restricted to the trusted demo fixture and the configured permitted source
  boundary.
- Planned dependencies use permissive Apache-2.0, MIT, or ISC licenses; exact versions and license
  metadata are recorded in [research.md](./research.md).

### II. Scope and Justified Complexity — PASS

- The design supports exactly one Canvas filter defect, one Hero path, and one Failure path.
- A local split-view Studio is required by the approved user experience. It reuses the same Node.js
  process and browser while avoiding a database, hosted backend, queue, account system, extension,
  or desktop wrapper.
- SAM 3.1 is not in the default path. It may be evaluated later only if it materially improves
  verification without threatening the five-minute target.
- The temporary Git worktree and trusted chart probe are justified by the explicit isolation and
  Canvas verification requirements.
- React and a narrow loopback HTTP/SSE surface are justified by the approved Chat, Agent Activity,
  Evidence, Gates, and in-workspace Proof Trail requirements.

### III. Risk-Based Verification — PASS

- Test-driven implementation is required for the high-risk sanitizer, Evidence ID validator, patch
  guard, gate reducer, run state machine, launch preconditions, lifecycle finalization, and
  original-worktree integrity check.
- Contract tests validate every JSON artifact and the model response before use.
- Studio event tests prove that connected-run activity is ordered and sanitized.
- End-to-end tests prove both the `Verified Fix` Hero path and a fail-closed `Unverified` path.
- Real Meta API smoke coverage is opt-in and credential-gated; deterministic CI uses a recorded
  schema-valid response through a test-only provider transport without changing the committed Hero
  scenario's `meta` mode.

### IV. Security by Design — PASS

- Network evidence is metadata-only with queries, headers, cookies, and bodies excluded.
- Source capture and patch application use explicit allowlists; model output cannot select commands
  or expand the source boundary.
- Evidence is sanitized before disk persistence and before transmission to Meta Model API.
- Model output is untrusted until strict-schema parsing, citation validation, path validation,
  patch-size checks, and `git apply --check` all pass.
- The Model API key is read only from `MODEL_API_KEY`, never written to artifacts, and never
  included in model input or logs.
- The Studio binds only to loopback, separates the Studio and demo hosts, validates the exact Host,
  browser request context, and launch session, applies a restrictive content-security policy, and
  frames only the prepared target.
- Chat text and Studio events are sanitized before persistence, display, or model transmission.

### Post-Design Re-check — PASS

The data model, contracts, and quickstart preserve all four principles. No Constitution exception or
complexity justification is required.

## Architecture

### Run sequence

1. Build the Studio and initial prepared preview into operating-system temporary output, start the
   loopback services, create a launch session, open headed Chromium, and render the two registered
   cases with the target pane and agent pane.
2. Accept a sanitized chat request, bind it to the selected committed scenario, create the run, and
   emit the first ordered activity event.
3. Load and validate the immutable oracle and permitted source boundary. Require a clean tracked
   working tree and record the original HEAD, status, index, protected hashes, resolved Git common
   directory, and complete `git worktree list --porcelain` snapshot.
4. Create a detached temporary Git worktree, start the known-bad app, frame it in the left pane, and
   drive that exact frame with Playwright to reproduce the failure visibly.
5. Capture actions, data, rendered chart labels and values, Canvas screenshot, console entries,
   metadata-only network observations, and allowlisted source context. Sanitize and persist every
   item before emitting its Evidence ID to the Studio.
6. Send the sanitized chat goal, source context, and evidence manifest to `muse-spark-1.3` through
   the Responses API with `store: false` and a strict JSON Schema response contract.
7. Reject unknown Evidence IDs, paths outside the allowlist, unsafe patch forms, excessive size, and
   patches that fail `git apply --check`; stream the safe diagnosis and guard outcomes.
8. Stop the known-bad app, apply the candidate in the same worktree, start the patched fixture,
   repoint the left frame, and replay the exact actions visibly.
9. Evaluate application, dataset, rendered chart, secret-scan, and original-worktree integrity gates
   while emitting ordered gate events. Retain the failure and replay screenshots as review evidence,
   not as a pixel-comparison gate.
10. Reduce the gates to `Verified Fix` or `Unverified`, render the in-workspace Proof Trail, write
    the contract-valid artifacts available for phases actually reached, never invent artifacts for
    skipped phases, then remove the temporary worktree.

### Studio boundary

- `flowproof studio` builds the Studio and initial prepared preview into operating-system temporary
  output, launches the loopback service, injects the launch cookie, and opens headed Chromium.
  Run execution and candidate builds occur in the detached worktree. There is no headless CLI in
  the MVP.
- One Node.js built-in HTTP server serves the compiled Studio assets, JSON API, and live SSE stream
  from `127.0.0.1`. One FlowProof-owned fixed-port static server exposes the built demo app on
  `localhost`; it binds once per Studio session and swaps its document root from initial preview to
  known-bad worktree build to patched worktree build before Playwright reconnects the iframe and
  waits for the trusted probe.
- The Studio resolves a selected scenario ID through a committed registry. The browser never
  supplies a scenario file path, command, oracle path, or source allowlist.
- `app.start_command` is a committed build command executed inside the detached worktree. It never
  starts or owns the demo HTTP server; the FlowProof target-app lifecycle owns that fixed port.
- The Studio page owns the right agent pane and one target iframe. Playwright controls the iframe in
  the same browser page, so the visible target is the authoritative failure and replay surface.
- Chat supplies a sanitized goal to the diagnosis prompt but cannot select commands, paths, or
  expected values and cannot modify the committed scenario.
- `POST /api/runs` starts a run. `GET /api/runs/:id/events` provides live ordered SSE, and
  `GET /api/runs/:id/result` exposes the authoritative sanitized result. Closed evidence-by-ID and
  candidate-diff routes support the in-workspace Proof Trail; there is no generic file route.
- An SSE disconnect alone does not cancel the run, but the MVP does not replay missed events.
  Closing
  the Studio page or browser stops the visible run, finalizes it as `Unverified`, and triggers
  isolated-worktree cleanup.
- Playwright injects an `HttpOnly; SameSite=Strict; Path=/` launch cookie for `127.0.0.1` before
  navigation. The server validates the exact `Host`, requires the exact `Origin` on POST, and
  requires the cookie plus `Sec-Fetch-Site: same-origin` on GET and SSE.

### Verification oracle

- The dataset oracle is a committed ordered array of expected rows for the selected filter.
- A trusted, read-only test probe outside the permitted patch path reports the rendered Chart.js
  labels and values. The Canvas gate compares them exactly to the committed chart oracle.
- Failure and replay screenshots are retained as evidence at fixed Canvas dimensions, viewport,
  device scale factor, locale, timezone, font set, and animation-disabled state.
- Dataset and chart-series gates are independent. The model cannot write either oracle or expected
  value, and screenshot pixels do not determine the final status in this MVP.

### Model boundary

- Use `muse-spark-1.3` Standard mode because it is available in South Korea, recommended for new
  agentic work, supports strict structured output, and does not use submitted content for training.
- Use one stateless Responses API call with `store: false`; do not use server-managed history,
  search grounding, model-selected tools, or model-selected shell commands.
- Make exactly one HTTP attempt for that call with SDK `maxRetries: 0` and
  `scenario.timeouts.model_ms`. Timeout, 429, 5xx, and other provider failures finish as
  `Unverified`; the MVP does not retry automatically.
- The response contains a diagnosis, evidence-linked claims, and one unified diff. FlowProof
  performs all validation, application, replay, and final status computation deterministically.
- A deterministic recorded provider fixture is permitted only in automated tests and the explicit
  Failure demonstration. The Hero demonstration must use the live Meta endpoint.
- Automated Hero tests may inject a `ModelTransport` only through the in-process
  `startStudio({ testTransport })` test entry. No CLI flag, environment variable, scenario field,
  chat/API field, or production code path may select that transport; ordinary Hero resolution
  always returns the live Meta adapter.
- With `--scenario canvas-filter-hero`, credential readiness is checked before any app, browser,
  worktree, artifact, or Git-metadata side effect and missing credentials exit with code `3`.
  Without `--scenario`, the Studio may open without credentials; selecting Hero later performs the
  same readiness check in `POST /api/runs`, returns `PROVIDER_CREDENTIAL_MISSING`, and creates no
  run.

### Failure demonstration

The Failure case uses the same known-bad application and captured Evidence Bundle but replaces the
provider result with a clearly labeled committed evaluation fixture containing one nonexistent
Evidence ID. The citation gate must reject it before patch application and finalize the run as
`Unverified`. This makes the fail-closed path repeatable without falsely attributing the injected
fault to Meta Model API.

## Requirement Traceability

- **FR-001, SC-002**: committed scenario contract, immutable oracle paths, and chat start without
  interactive verification configuration.
- **FR-002, FR-003, FR-004, SC-003**: failure reproduction, seven required evidence types, stable
  Evidence IDs, and Evidence Bundle contract.
- **FR-005, FR-006, SC-006**: strict diagnosis contract plus deterministic citation, target-path,
  and patch guards.
- **FR-007, FR-013, SC-007**: clean baseline precondition, detached worktree execution, the ignored
  persistent artifact-root exception, transient FlowProof-owned Git administrative metadata, and
  pre/post tracked-file/index/branch/HEAD/history/worktree-list integrity gate.
- **FR-008, FR-009, FR-010, SC-004, SC-005**: exact action replay, independent dataset and Canvas
  gates, exact rendered label/value checks, nine-gate fail-closed reducer, and deterministic
  Failure fixture.
- **FR-011**: the in-workspace Proof Trail connects the complete evidence-to-result flow.
- **FR-012, SC-008**: allowlisted metadata capture, pre-persistence sanitization, seeded-marker
  scanning, and secret-safe output contracts.
- **SC-001**: one model HTTP attempt, phase budgets, total 300-second limit, and recorded durations.
- **FR-014, SC-009**: one browser page contains the target iframe and agent pane from start through
  final review.
- **FR-015, SC-010**: the chat and ordered Studio event contract expose activity, Evidence IDs,
  candidate state, gates, and final status.
- **FR-016**: server-side scenario binding keeps chat outside oracle, source-scope, command, and
  gate selection.
- **FR-017**: the active Studio renders the verified diff, evidence, gate outcomes, and final status
  from the same sanitized run artifacts.
- **SC-011**: page-close detection finalizes an active run as `Unverified`, records the interruption,
  omits artifacts for phases not reached, cleans the detached worktree, and rechecks the original
  tracked files and Git state.

## Project Structure

### Documentation (this feature)

```text
specs/001-verify-debugging-fix/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli.md
│   ├── diagnosis.schema.json
│   ├── evidence-bundle.schema.json
│   ├── run-result.schema.json
│   ├── scenario.schema.json
│   ├── studio-api.md
│   └── studio-event.schema.json
└── tasks.md                 # created by the next Spec Kit phase
```

### Source Code (repository root)

```text
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.base.json
.env.example

apps/
├── studio/
│   ├── index.html
│   ├── src/
│   │   ├── components/
│   │   │   ├── AgentPanel.tsx
│   │   │   ├── ProofTrail.tsx
│   │   │   └── TargetPane.tsx
│   │   ├── api.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── state.ts
│   └── vite.config.ts
└── demo-chart/
    ├── index.html
    ├── src/
    │   ├── data.ts
    │   ├── filterData.ts    # only permitted candidate target in the MVP
    │   ├── main.ts
    │   └── testProbe.ts
    └── vite.config.ts

packages/
└── flowproof/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── cli.ts
        ├── run.ts
        ├── capture/
        ├── contracts/
        ├── evidence/
        ├── model/
        │   ├── metaClient.ts
        │   ├── prompt.ts
        │   └── transport.ts
        ├── patch/
        ├── scenario/
        ├── studio/
        │   ├── auth.ts
        │   ├── errors.ts
        │   ├── events.ts
        │   ├── launch.ts
        │   ├── server.ts
        │   └── targetApp.ts
        ├── verify/
        └── worktree/

scenarios/
└── canvas-filter/
    ├── hero.json
    ├── failure-invalid-citation.json
    ├── expected/
    │   ├── chart-series.json
    │   └── filtered-data.json
    └── provider-fixtures/
        └── invalid-citation.json

tests/
├── contract/
├── e2e/
├── fixtures/
│   └── provider/
├── integration/
├── support/
├── ui/
└── unit/
```

**Structure Decision**: Use one pnpm workspace with a React Studio, a single local engine package
with a thin launcher, and a separate trusted demo fixture. Shared libraries remain internal folders
until reuse is proven. Scenario inputs and verification oracles live outside source code so the
patch-producing model cannot change them through the permitted source boundary.

## Verification Strategy

### Unit and contract gates

- Validate scenario, Studio event, Evidence Bundle, diagnosis, and run-result fixtures against the
  committed JSON Schemas.
- Prove deterministic Evidence IDs and reject duplicate, malformed, cross-run, and unknown IDs.
- Seed representative tokens in console, URL, network metadata, source, and model-output fixtures;
  assert that no raw marker reaches persisted or transmitted payloads.
- Reject absolute paths, `..`, symlinks, binary patches, renames, multiple target files, oversized
  diffs, and any path outside `apps/demo-chart/src/filterData.ts`.
- Exercise every verification-gate combination and prove only the all-pass set yields
  `Verified Fix`.
- Reject chat or local API input that attempts to change the scenario, path allowlist, oracle,
  command, or gate definitions.

### Integration gates

- Capture a known-bad run from the trusted app and validate every required Evidence Bundle field,
  including the rendered chart labels and values from the trusted probe.
- Parse a recorded schema-valid Meta response and a recorded invalid-citation fixture.
- Resolve the Git common directory, snapshot the complete registered-worktree list, create and
  remove a detached worktree, apply a known patch, then run `git worktree remove --force` followed
  by `git worktree prune`. Verify that the original tracked status, index, checked-out branch,
  `HEAD`, history, protected file hashes, and registered-worktree list equal their pre-run snapshots;
  ignore only the expected sanitized `.flowproof/runs/` addition and preserve unrelated worktrees.
- Prove the fixed Canvas dimensions and chart-series probe remain outside the permitted patch path;
  retain failure and replay screenshots as evidence without using pixel thresholds.
- Reject an unexpected `Host`, a foreign POST `Origin`, a non-same-origin fetch context, an invalid
  launch cookie, non-loopback Studio binding, unknown artifact identifiers, and path traversal.

### End-to-end gates

- Deterministic Hero automation: launch the Studio, start through chat, visibly reproduce and replay
  the target frame, feed a recorded schema-valid response through the test-only Meta transport,
  pass every oracle, show `Verified Fix` in the agent pane, and preserve the original tracked files
  and Git state.
- Live Hero Quickstart: repeat the complete visible flow with the committed Hero scenario and the
  real `muse-spark-1.3` endpoint using a credential-gated manual run.
- Failure: injected nonexistent Evidence ID, no patch application, `Unverified`, visible failed
  gate in the Studio, and unchanged original tracked files and Git state.
- Secret safety: seeded markers are absent from evidence JSON, request-capture fixture, chat/events,
  UI, logs, and final run result.
- Browser lifecycle: closing the Studio during an active run yields `Unverified`, writes only
  stage-available artifacts, cleans the detached worktree, and preserves the original tracked files
  and Git state.
- Timing: Hero total duration is below 300 seconds in the prepared demo environment, with phase
  durations recorded in the result.

## Operational Risks and Mitigations

- **Model latency or outage**: apply a 90-second request timeout, make no automatic retry, and
  finalize `Unverified` after any timeout or provider failure.
- **Screenshot inconsistency**: pin Playwright Chromium, viewport, Canvas dimensions, fonts, locale,
  timezone, and device scale, and disable Chart.js animation; screenshots remain review evidence,
  not hard gates.
- **Unsafe model patch**: validate strict schema, citations, paths, patch grammar, size, and
  `git apply --check` before creating an application outcome.
- **Original-tree mutation**: refuse a dirty tracked baseline, record tracked status, index,
  checked-out branch, HEAD, history, protected hashes, resolved Git common directory, and complete
  registered-worktree list before the run. Remove and prune only the FlowProof-owned worktree and
  compare every snapshot after cleanup, preserving unrelated worktrees; disregard only the
  expected ignored `.flowproof/runs/` addition. Any other mismatch forces `Unverified` and a
  prominent integrity warning.
- **Sensitive-data leakage**: capture metadata by allowlist, sanitize before persistence or network
  transmission, and run seeded-marker scans over every emitted artifact.
- **Local UI attack surface**: bind only to loopback, separate Studio and demo hosts, require the
  launch cookie, validate Host and request context, and apply CSP and no-store headers.
- **Iframe, browser, or event-stream failure**: frame only the controlled app and fail before model
  use when it cannot load. An SSE disconnect does not cancel the engine; a browser/page close forces
  `Unverified` because the authoritative visible target no longer exists. Pre-capture failures omit
  the failure bundle and screenshot instead of inventing them.
- **Five-minute target overrun**: use one model call, one browser, one source file, a shared pnpm
  store, and phase-level timeouts; retain timings for demo evidence.

## Complexity Tracking

No Constitution violations require justification.
