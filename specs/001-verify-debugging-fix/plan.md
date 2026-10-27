# Implementation Plan: Evidence-Grounded Fix Verification

**Branch**: `feat/001-verify-debugging-fix` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-verify-debugging-fix/spec.md`

## Summary

Build a local TypeScript CLI that runs one predefined Canvas filter-defect scenario, captures a
sanitized Evidence Bundle with Playwright, asks Meta Model API `muse-spark-1.3` for a
schema-constrained diagnosis and unified diff, validates and applies that diff in a detached Git
worktree, and replays the same scenario. A run becomes `Verified Fix` only when the patch guard,
fixed dataset oracle, and Canvas screenshot oracle all pass. The CLI writes a run-scoped JSON and
static HTML Proof Trail; it never edits or commits the developer's original working copy.

## Technical Context

**Language/Version**: Node.js 24 LTS, TypeScript 7.0

**Primary Dependencies**: pnpm 10 workspace, Commander 15, Zod 4, OpenAI JavaScript SDK 7,
Playwright 1.64, Vite 8, Chart.js 4, pixelmatch 8, pngjs 7

**Storage**: Local run artifacts only under ignored `.flowproof/runs/<run-id>/`; temporary detached
Git worktrees under the operating-system temporary directory; no database or cloud storage

**Testing**: Vitest 5 for unit and contract tests; Playwright for browser capture and end-to-end
Hero/Failure scenarios; committed JSON and image fixtures for deterministic assertions

**Target Platform**: Local Linux or macOS developer machine with Git, Node.js 24, pnpm 10, and
headless Chromium; the prepared hackathon demo runs on Linux

**Project Type**: CLI application plus one trusted Vite/Chart.js demo fixture

**Performance Goals**: Excluding the initial root dependency install, complete the Hero run in less
than five minutes; target budgets are 45 seconds for failure capture, 90 seconds for one model call,
120 seconds for worktree setup/build/replay, and 15 seconds for result generation

**Constraints**: One predefined defect and permitted source file; one model call per normal run;
Standard-mode Meta Model API only; fixed pre-authored data and screenshot oracles; fail closed on
missing evidence, invalid citations, unsafe patches, API failures, or unevaluable gates; original
working-copy contents and Git history must remain unchanged; the prepared tracked working tree must
be clean before a run

**Scale/Scope**: One Hero case and one deterministic Failure fixture derived from the same defect;
one CLI process, one browser context, one temporary worktree, and one run-scoped artifact bundle

## Constitution Check

*GATE: Passed before Phase 0 research and passed again after Phase 1 design.*

### I. Clean-Room Development — PASS

- The demo application, scenario, source context, expected dataset, expected screenshot, and seeded
  secret markers are synthetic and committed specifically for this project.
- Runtime capture is restricted to the trusted demo fixture and the configured permitted source
  boundary.
- Planned dependencies use permissive Apache-2.0, MIT, or ISC licenses; exact versions and license
  metadata are recorded in [research.md](./research.md).

### II. Scope and Justified Complexity — PASS

- The design supports exactly one Canvas filter defect, one Hero path, and one Failure path.
- A local CLI and static report avoid a database, hosted backend, queue, account system, or generic
  repository abstraction.
- SAM 3.1 is not in the default path. It may be evaluated later only if it materially improves the
  fixed screenshot oracle without threatening the five-minute target.
- The temporary Git worktree and independent visual oracle are justified by the explicit isolation
  and Canvas verification requirements.

### III. Risk-Based Verification — PASS

- Test-driven implementation is required for the high-risk sanitizer, Evidence ID validator, patch
  guard, gate reducer, and original-worktree integrity check.
- Contract tests validate every JSON artifact and the model response before use.
- End-to-end tests prove both the `Verified Fix` Hero path and a fail-closed `Unverified` path.
- Real Meta API smoke coverage is opt-in and credential-gated; deterministic CI uses a recorded
  schema-valid provider fixture.

### IV. Security by Design — PASS

- Network evidence is metadata-only with queries, headers, cookies, and bodies excluded.
- Source capture and patch application use explicit allowlists; model output cannot select commands
  or expand the source boundary.
- Evidence is sanitized before disk persistence and before transmission to Meta Model API.
- Model output is untrusted until strict-schema parsing, citation validation, path validation,
  patch-size checks, and `git apply --check` all pass.
- The Model API key is read only from `MODEL_API_KEY`, never written to artifacts, and never
  included in model input or logs.

### Post-Design Re-check — PASS

The data model, contracts, and quickstart preserve all four principles. No Constitution exception or
complexity justification is required.

## Architecture

### Run sequence

1. Load and validate the committed scenario, immutable oracle, and permitted source boundary.
2. Require a clean tracked working tree, then record the original branch HEAD, status, and hashes of
   protected tracked files.
3. Create a detached temporary Git worktree at the original HEAD, start the trusted known-bad demo
   app there, and reproduce the filter failure with Playwright.
4. Capture actions, observed/expected data, rendered chart labels and values, clipped Canvas
   screenshot, console entries, metadata-only network observations, and allowlisted source context.
5. Sanitize every evidence item, assign stable Evidence IDs, hash persisted artifacts, and validate
   the failure Evidence Bundle contract.
6. Send only the sanitized source context and evidence manifest to `muse-spark-1.3` through Meta's
   Responses API with `store: false` and a strict JSON Schema response contract.
7. Reject unknown Evidence IDs, paths outside the allowlist, non-unified diffs, excessive patch
   size, binary/rename patches, and patches that fail `git apply --check`.
8. Stop the known-bad app, apply the candidate in the same temporary worktree, install dependencies
   from the frozen lockfile, and start the patched fixture.
9. Replay the exact same Playwright actions and evaluate application, dataset, Canvas screenshot,
   secret-scan, and original-worktree integrity gates.
10. Reduce the gates to `Verified Fix` or `Unverified`, write contract-valid JSON artifacts,
    render a static HTML Proof Trail, save the verified diff, and remove the temporary worktree.

### Verification oracle

- The dataset oracle is a committed ordered array of expected rows for the selected filter.
- A trusted, read-only test probe outside the permitted patch path reports the rendered Chart.js
  labels and values. The Canvas gate compares them exactly to the committed chart oracle.
- The Canvas oracle is a committed known-good chart screenshot captured at a fixed Chromium version,
  viewport, device scale factor, locale, timezone, font set, and animation-disabled state.
- The visual gate uses pixel comparison with a committed maximum differing-pixel ratio. A diff image
  is retained for both pass and fail outcomes.
- Dataset and screenshot gates are independent. The model cannot write either oracle, threshold, or
  expected value.

### Model boundary

- Use `muse-spark-1.3` Standard mode because it is available in South Korea, recommended for new
  agentic work, supports strict structured output, and does not use submitted content for training.
- Use one stateless Responses API call with `store: false`; do not use server-managed history,
  search grounding, model-selected tools, or model-selected shell commands.
- The response contains a diagnosis, evidence-linked claims, and one unified diff. FlowProof
  performs all validation, application, replay, and final status computation deterministically.
- A deterministic recorded provider fixture is permitted only in automated tests and the explicit
  Failure demonstration. The Hero demonstration must use the live Meta endpoint.

### Failure demonstration

The Failure case uses the same known-bad application and captured Evidence Bundle but replaces the
provider result with a clearly labeled committed evaluation fixture containing one nonexistent
Evidence ID. The citation gate must reject it before patch application and finalize the run as
`Unverified`. This makes the fail-closed path repeatable without falsely attributing the injected
fault to Meta Model API.

## Requirement Traceability

- **FR-001, SC-002**: committed scenario contract, immutable oracle paths, and CLI without
  interactive verification inputs.
- **FR-002, FR-003, FR-004, SC-003**: failure reproduction, seven required evidence types, stable
  Evidence IDs, and Evidence Bundle contract.
- **FR-005, FR-006, SC-006**: strict diagnosis contract plus deterministic citation, target-path,
  and patch guards.
- **FR-007, FR-013, SC-007**: clean baseline precondition, detached worktree execution, and original
  HEAD/status/hash integrity gate.
- **FR-008, FR-009, FR-010, SC-004, SC-005**: exact action replay, independent dataset and Canvas
  gates, exact rendered label/value checks, nine-gate fail-closed reducer, and deterministic
  Failure fixture.
- **FR-011**: run-result contract and static Proof Trail connect the complete evidence-to-result
  flow.
- **FR-012, SC-008**: allowlisted metadata capture, pre-persistence sanitization, seeded-marker
  scanning, and secret-safe output contracts.
- **SC-001**: one model call, phase budgets, total 300-second limit, and recorded durations.

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
│   └── scenario.schema.json
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
    └── src/
        ├── cli.ts
        ├── capture/
        ├── contracts/
        ├── evidence/
        ├── model/
        ├── patch/
        ├── report/
        ├── scenario/
        ├── verify/
        └── worktree/

scenarios/
└── canvas-filter/
    ├── hero.json
    ├── failure-invalid-citation.json
    ├── expected/
    │   ├── chart.png
    │   ├── chart-series.json
    │   └── filtered-data.json
    └── provider-fixtures/
        └── invalid-citation.json

tests/
├── contract/
├── e2e/
├── integration/
└── unit/
```

**Structure Decision**: Use one pnpm workspace with a single production CLI package and a separate
trusted demo fixture. Shared libraries remain internal folders until reuse is proven. Scenario
inputs and verification oracles live outside source code so the patch-producing model cannot change
them through the permitted source boundary.

## Verification Strategy

### Unit and contract gates

- Validate scenario, Evidence Bundle, diagnosis, and run-result fixtures against the committed JSON
  Schemas.
- Prove deterministic Evidence IDs and reject duplicate, malformed, cross-run, and unknown IDs.
- Seed representative tokens in console, URL, network metadata, source, and model-output fixtures;
  assert that no raw marker reaches persisted or transmitted payloads.
- Reject absolute paths, `..`, symlinks, binary patches, renames, multiple target files, oversized
  diffs, and any path outside `apps/demo-chart/src/filterData.ts`.
- Exercise every verification-gate combination and prove only the all-pass set yields
  `Verified Fix`.

### Integration gates

- Capture a known-bad run from the trusted app and validate every required Evidence Bundle field,
  including the rendered chart labels and values from the trusted probe.
- Parse a recorded schema-valid Meta response and a recorded invalid-citation fixture.
- Create and remove a detached worktree, apply a known patch, and verify that the original worktree
  status, HEAD, and protected file hashes do not change.
- Compare exact and intentionally different Canvas screenshots and retain the expected diff image.

### End-to-end gates

- Hero: live `muse-spark-1.3` response, allowed patch, passing dataset and screenshot oracles,
  `Verified Fix`, complete Proof Trail, and unchanged original working copy.
- Failure: injected nonexistent Evidence ID, no patch application, `Unverified`, visible failed
  gate, and unchanged original working copy.
- Secret safety: seeded markers are absent from evidence JSON, request-capture fixture, static
  report, logs, and final run result.
- Timing: Hero total duration is below 300 seconds in the prepared demo environment, with phase
  durations recorded in the result.

## Operational Risks and Mitigations

- **Model latency or outage**: apply a 90-second request timeout, bounded retry only for transient
  429/5xx responses, and finalize `Unverified` on exhaustion.
- **Screenshot instability**: pin Playwright Chromium, viewport, fonts, locale, timezone, and device
  scale; disable Chart.js animation; keep a diff artifact and threshold in the immutable scenario.
- **Unsafe model patch**: validate strict schema, citations, paths, patch grammar, size, and
  `git apply --check` before creating an application outcome.
- **Original-tree mutation**: refuse a dirty tracked baseline, record HEAD/status/hashes before the
  run, and re-check after cleanup; any mismatch forces `Unverified` and a prominent integrity
  warning.
- **Sensitive-data leakage**: capture metadata by allowlist, sanitize before persistence or network
  transmission, and run seeded-marker scans over every emitted artifact.
- **Five-minute target overrun**: use one model call, one browser, one source file, a shared pnpm
  store, and phase-level timeouts; retain timings for demo evidence.

## Complexity Tracking

No Constitution violations require justification.
