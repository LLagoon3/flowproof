# Verification: Spec 006 — S4 Frozen Replay/Compiler Module

**Scope**: S4 only, T034 and T037. Module evidence; no baseline/candidate orchestration (T038/T040 are
S6), no model/provider call, no end-to-end, live or owner acceptance. Parent owns reconciliation with
`verification.md`, publication, review and merge.

**Branch / baseline**: `feat/006-project-live-verification-replay` from merged S1 `2b1155fd6c949afa62c7710d1353d7a06d87f6ef`.
Code commit `eb8f9ae` (`packages/flowproof/src/verify/projectReplay.ts` sha256 `2dee3f4b…31c1`,
`tests/unit/project-replay.test.ts` sha256 `cc234c21…a0d`). Logs: Git-ignored
`.flowproof/task-logs/006-project-live-verification/s4/`. Own frozen-lockfile dependencies.

## What T037 implements

- `compileFrozenReplay`: pure; parses project/configuration/capture/interpretation with the S1 parsers and
  emits the unchanged S1 `FrozenVerificationDefinition` (compiler `1.0.0`) bound to project, baseline,
  configuration ID/digest, capture/report, interpretation ID/digest, `requiredCheckIds`, protected input
  digests and required evidence (`image` plus collectors used by `no-error`). A host-private deep-frozen
  handle adds project-context, admitted-tree, target-origin, cited-evidence and compiler-semantics digests.
- Rejects before freezing: unknown/executable operations or condition kinds, extra keys, S1-invalid CSS
  (XPath, engine prefixes, attributes, pseudo-classes) and external/non-canonical navigation; empty-name
  role and document-global locators; unready/stale/foreign identities; `clarify`/`unsupported`; unknown or
  unavailable citations; changed entry/viewport; actions not an in-order recorded subsequence with
  admitted values (redacted values never guessed); waits over 120 s total; unobserved `no-error`
  fingerprints, contradictory conjunctions and a task condition asserted by a trailing wait.
- `executeFrozenReplay`: accepts only a registered handle and a single-use session whose run/phase
  (`baseline|candidate`)/definition/origin/build binding matches, all before any browser call. Unique
  locator resolution within the 10 s wait bound, closed operations, origin/popup/dialog/download checks
  after actions, polling only in bounded waits, fixed 120 s phase limit, sticky cancellation, bounded
  release/join. Outcomes `conditions-satisfied|conditions-unsatisfied|operational-failure|canceled|rejected`;
  missing/unavailable required evidence, wrong run/phase/baseline/build observations and unevaluable
  conditions can never satisfy. No page text, value or error message is retained.
- `openChromiumReplaySession`: new empty context per phase with the frozen viewport, service workers
  blocked, downloads refused, other-origin requests and WebSockets refused; closed on release.
- `persistFrozenReplay`/`storedDefinitionMatches`: exact definition bytes in the outside-checkout store.

## Evidence

| Check | Result | Log |
| --- | --- | --- |
| Focused suite, fake driver (final) | 57 passed, 4 skipped (opt-in Chromium) | `unit-3.log` |
| Focused suite + actual headless Chromium, heavy lease (final code) | 61/61 | `unit-chromium-final.log` |
| Guard mutations on final code (17 guards) | 17/17 killed, original restored (sha matches) | `mutations-final.log` |
| Relevant regressions: replay, captured-verification, oracle, gate-reducer, project lifecycle/store unit; project and captured contracts (8 files) | 339 passed, 4 skipped | `regression.log` |
| `pnpm typecheck`, `pnpm build` (heavy lease) | passed | `typecheck.log`, `build.log` |
| `git diff --check`, status | clean | — |

Red history: the first focused run failed 1/56 on a test-fake defect (a hung call not settled by
release), fixed in the fake. The module draft preceded the final test file, so red was established by
guard mutation instead of a missing module; one surviving mutation (synchronous abort while a call
starts) gained a dedicated test before the final run.

Labelled fakes: executor tests use an in-process fake driver/collector (not a browser). The Chromium
section serves a synthetic page from the test and uses a fake image collector only to make DOM outcomes
observable; it is not masked screenshot evidence. Ports 43170/43171 were free before and after; no
browser process, container or temporary state root remained.

## Decisions for parent review

- Replay actions must reuse recorded locator candidates and values in recorded order (waits excepted);
  S5 prompts/validation must target this, and S6 must supply the run-bound masked image collector.
- Absent elements are legitimate for visibility/count conditions; text/value conditions on a missing
  or ambiguous target are unevaluable, never an intended failure.
- Configuration lock/profile digests must equal the project context (stale-configuration guard).

## Unexecuted limits

No real project/runtime, S3 recorder, S3 masking collector, model, baseline/candidate decision,
Studio input lock or headed-browser human-input exclusion (callers must use a headless browser or lock
input). Hostile page code can still lie about DOM state; only bounded host probes are used.
