# Quickstart: Validate Editing Change Capture

**Planning artifact:** the capture tests/entry point below are planned, not implemented. These
commands become acceptance checks during implementation; none is reported as a passed feature gate now.

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

## 1. Confirm the planned test files exist

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

## 4. Repository regression gates

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm exec playwright test --pass-with-no-tests
git diff --check
```

Use the existing display/Xvfb setup for headed integration and Playwright tests when needed.
Record actual discovered/passed counts and any skipped/unrun gate. Inspect exact session labels and
private temp roots with the existing test-support residue helpers; do not use global Docker prune.
No credential-gated live Meta smoke is required because production Hero/Failure wiring is unchanged.

## Remaining non-goals

This proves extraction and cleanup, not that a candidate fixes a defect. Fresh-baseline application,
authoritative build/test/browser replay, live agent integration and rejection-to-model repair remain
subsequent features. Custom project filters are not executed on the host; binary checking preserves
the existing seeded-marker-only policy. Full recursive submodule changes are not captured.
