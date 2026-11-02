# Quickstart: Validate Editing Change Capture

This is the implemented local acceptance workflow for Spec 003. The latest observed test discovery,
pass counts, and any gaps are recorded in `tasks.md`; rerun the commands below after changing the
implementation. These checks prove capture and cleanup behavior only, not that a candidate fixes a
defect.

## Prerequisites

Existing prepared Linux host, Node.js 24+, pnpm 10, Git (research used 2.53.0), supported Docker Engine,
and the credential-free fixture runtime from Spec 002. No provider login, live model, manual UI action,
new service, or new runtime npm dependency is needed.

```bash
node --version
pnpm --version
git --version
docker version
pnpm install --frozen-lockfile
```

## In-process API and result boundary

Trusted engine callers opt in with `startCapturingEditingSession(request, { profiles, scanner })`.
It returns the usual `id`, `result`, and `cancel()` handle; `result` resolves to `{ session, capture }`.
The existing `startEditingSession` result remains unchanged and file-blind. The capture result has
five statuses: `captured`, `no_changes`, `rejected`, `failed`, and `not_attempted`. Only `captured`
contains a complete candidate; all other statuses contain no candidate bytes or partial records.

Safe reason codes are `EDITOR_NOT_SUCCESSFUL`, `WORKSPACE_VIEW_UNAVAILABLE`,
`UNREPRESENTABLE_ENTRY`, `SENSITIVE_DATA`, `CAPTURE_LIMIT`, `CAPTURE_INTERRUPTED`, and
`CAPTURE_IO_FAILED`. Each reason has a fixed bounded message rather than Git stderr, an unsafe path,
scanner finding details, or secret content. Capture uses one fixed 60-second deadline and one
cumulative 32-MiB materialization budget.

Candidate bytes are not verification. Always inspect `session.cleanup` independently: a completed
candidate may be returned alongside a failed cleanup or original-integrity check. Capture does not
apply or replay the candidate, run its project tests, call an agent, or claim `Verified Fix`.

## 1. Confirm the capture test files exist

The repository permits empty Vitest selections in some projects. A zero-test run is not acceptance.
Before running the focused commands below, confirm that implementation added these files and that
Vitest reports discovered/executed tests:

```bash
test -f tests/contract/editing-capture-contract.test.ts
test -f tests/unit/editing-capture.test.ts
test -f tests/integration/editing-capture-git.test.ts
test -f tests/integration/editing-capture-session.test.ts
```

## 2. Contract and focused capture checks

```bash
pnpm exec vitest run tests/contract/editing-capture-contract.test.ts tests/unit/editing-capture.test.ts
pnpm exec vitest run tests/integration/editing-capture-git.test.ts
```

Expected proof:

- The old lifecycle request/result shape remains unchanged; only the opt-in entry point returns capture.
- Add/modify/delete text and binary files, move files, change executable mode and symlink records,
  change gitlink reference, and obtain exactly the expected main-repository versioned result.
- Staged subsets, new untracked files, force-tracked ignored additions, editor local commits, and
  ignored build output follow the contract, not a source-extension or editable-path allowlist.
- Link targets are not read; nested worktrees are not scanned; reference-only coverage is explicit.
- No changes yields no candidate. Special entries, raw sensitive markers (including old/new binary
  payloads), byte/time bounds and operational read errors produce accurate safe results, no partial patch.
- A small capture fixture can prove artifact fidelity by reconstructing its expected file state in
  test scratch. This is a test of bytes, not production verification integration or `Verified Fix`.

## 3. Docker/session integration

```bash
pnpm exec vitest run tests/integration/editing-capture-session.test.ts
pnpm exec vitest run tests/integration/editing-session.test.ts tests/integration/editing-session-cleanup.test.ts
```

Expected proof:

- Capture runs once only after inspected successful stopped execution, never merely attach-client exit.
- Failure/startup failure/timeout/cancellation skip extraction; interrupted capture returns no candidate.
- Root bind plus obscuring nested volume is rejected for capture, without volume-export machinery.
- Capture precedes disposal, subprocesses are joined, and container/anonymous volumes/workspace/private
  Git scratch are gone after successful cleanup. Original checkout/metadata snapshot is unchanged.
- Injected cleanup/integrity failure remains explicit alongside the capture result, never a clean
  success claim. Existing non-capture sessions do not inspect authored files.

## 4. Lifecycle compatibility and repository regression gates

```bash
pnpm exec vitest run tests/integration/editing-session.test.ts tests/integration/editing-session-cleanup.test.ts
pnpm exec vitest run tests/contract/editing-session-contract.test.ts
pnpm typecheck
pnpm build
pnpm test --no-file-parallelism --maxWorkers=1
pnpm exec playwright test --pass-with-no-tests
git diff --check
```

Run the full Vitest suite with file parallelism disabled: editing integration suites reuse the same
fixture image tag and owned temporary resources. Use the existing display/Xvfb setup for headed
integration and Playwright tests when needed. Record actual discovered/passed counts and any skipped
or unrun gate in `tasks.md`. Inspect exact session labels and private temp roots with the existing
test-support residue helpers; do not use global Docker prune. No credential-gated live Meta smoke is
required because production Hero/Failure wiring is unchanged.

## Scope and limitations

Capture is attempted only after inspected successful editor termination and proof of the complete
workspace bind view. The single fixed budget is 60 seconds and 32 MiB cumulative materialized bytes;
it covers capture metadata, Git stdout/stderr, patch bytes, and changed payloads. Existing sensitive
data checks cover credential patterns in valid UTF-8 text and seeded markers in text and binary;
they are not general binary credential detection. Custom Git filters, hooks, and external diff
commands are not executed on the host, so custom-filter/LFS hydration fidelity is not promised. A
gitlink carries only its reference and a fixed note that nested working-tree changes were not
inspected or captured. Execution, capture, and cleanup remain separate facts, and a candidate
alongside failed cleanup is not a clean success.

This proves extraction and cleanup, not that a candidate fixes a defect. Fresh-baseline application,
authoritative build/test/browser replay, live agent integration, and rejection-to-model repair remain
deferred features.
