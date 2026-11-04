# Verification: Spec 006 — S1 Foundation Evidence

**Scope**: Delivery slice S1 only (T001–T009). T055 later finalizes this file with per-FR/per-SC
evidence; this revision records actual S1 facts and gaps, not feature acceptance.

**Authorization**: On 2026-11-04 the owner requested work to start from slice 1 following the workflow
skill (message 25437). That covers local S1 implementation, dependency/operator image preparation,
required tests and local commits. It does not cover push, PR, GitHub review, merge, deployment, model
calls or S2+. The parent session retains independent review and delivery.

**Branch / baseline**: `feat/006-project-live-verification`, baseline
`9b3b96210c0b3f8b1c7142c23b7404ec421ea476` (`origin/main` `878df7ead7767d9c084fc7a6717769140428f31b`, no
upstream delta at start). Code SHA for the S1 evidence below:
`826958e8ee23de36b8d4658d6e6d56c4aeabafc9`. Logs live in the Git-ignored
`.flowproof/task-logs/006-project-live-verification/`.

## Commits

| Commit | Tasks | Summary |
| --- | --- | --- |
| `d2e6e9b` | T003 | Exclude `project-live-meta-smoke` from every default Vitest project; explicit opt-in project only |
| `4f1c413` | T001 | Permitted React 19.3.1/Vite 8.3.5 sample, lock-bound manifest, independent repo materialization and original snapshots |
| `6ef7950` | T002 | Operator-only offline `vite-static-v1` Dockerfile and preparation/verify script |
| `009dd21` | T004, T005 | Strict closed project-live contracts and contract tests |
| `5c794e8` | T006, T007 | Outside-project owner-only project store and tests |
| `826958e` | T008, T009 | Run-state helpers, lifecycle/ownership skeleton and tests |

T001–T005 were committed by the first S1 run; that run's output exceeded the CLI transcript limit, so
the parent recovered HEAD `009dd21` and is reviewing those commits independently. T006–T009 were
completed in the recovery run. Both runs used this worktree as the only writer.

## Task Evidence

| Task | Evidence | Red → green |
| --- | --- | --- |
| T001 | `tests/integration/project-live-fixture.test.ts` (5): lock/manifest verification, clean independent repo outside FlowProof, snapshot detects tracked/untracked/ignored/index/refs/Git-dir changes | `t001.log` |
| T002 | `tests/unit/project-runtime-preparation.test.ts` (7); actual image prepared and re-verified (below) | `t002-unit.log`, `t002-mutation.log`, `t002-prepare.out`, `t002-verify.out`, `s1-image-verify.out` |
| T003 | `tests/integration/project-live-discovery.test.ts` (5): `pnpm test` listing, a bare run, negated project filters and default Playwright discovery never reach the live smoke or manual runner; only explicit `--project project-meta-smoke` can, and it fails rather than passing vacuously when its file is absent | `t003-red.log` → `t003-green.log` |
| T004/T005 | `tests/contract/project-contracts.test.ts` (49) | `t004-red.log` → `t005-green.log` |
| T006/T007 | `tests/unit/project-store.test.ts` (18) | `t006-red.log` (18 failed on assertions against a stub) → `t007-green.log` (18 passed) |
| T008/T009 | `tests/unit/project-lifecycle.test.ts` (15) | `t008-red.log` (15 failed on assertions against stubs) → `t009-green.log` (15 passed) |

## Runtime Manifest (actual inspection)

Private manifest `.flowproof/task-logs/006-project-live-verification/vite-static-v1.manifest.json`
(`manifest_sha256` `17a86078eb55e2169f40e90eb17a1caea4c361fcd085710b976a8655f8963139`), prepared
2026-11-04T10:54:55Z with Docker 29.1.3, re-verified at the S1 code SHA with `verify --manifest`:

- Image ID `sha256:7e0ba4db1a543d98c2591bc13c6bd1da14fd0a81c4aafa87eb948b4d9c1cdb43`, linux/amd64, user
  `65532:65532`; base `node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203`.
- Lock `package-lock.json` SHA-256 `edff91106eeeda834c3380ff623e7f0847dd12082aaff210847fa888fffa132a`;
  dependency tree SHA-256 `1f9aef8357be2593d1768954eb96704479cafff18284f28a0fb1d77427230bc7` (18 packages:
  react/react-dom 19.3.1, vite 8.3.5); Dockerfile SHA-256 `a867d73e8d6d8a9cc89ecc5352b45010ed5c14a2128fc0b16da48cd561184941`.
- Tools: `/usr/local/bin/node` v24.16.0, `/opt/flowproof/toolchain/node_modules/vite/bin/vite.js` 8.3.5;
  npm/npx/corepack/yarn absent. Build context: `package.json` and `package-lock.json` only; no provider
  credential or build argument.
- Preparation self-check (`--network=none`): sample build passed and `node --test` project check passed
  (3 tests). This is an operator preparation smoke, not selected-project execution.

## S1 Validation (code SHA `826958e`)

| Check | Result | Log |
| --- | --- | --- |
| `pnpm typecheck` | passed | `t009-typecheck.log` |
| `pnpm build` | passed | `s1-build.log` |
| `git diff --check 9b3b962..HEAD` | clean | — |
| S1 focused set, serial (6 files) | 99/99 passed | `s1-focused.log` |
| Image `verify --manifest` | `verified`, IDs above | `s1-image-verify.out` |
| Default Vitest suite, serial (`unit`, `contract`, `integration`, `ui`) | 55 files / 1820 tests passed (236 s) | `s1-default-suite.log` |

Not run in S1: headed Playwright/browser suites (no UI change), the explicit `project-meta-smoke`
gate, any model call, any full project-live flow or owner walkthrough.

## S1 Design Decisions

- **Store placement**: the state root is absolute, canonicalized, outside and not containing every
  protected root (selected repository and, when admission supplies it, its Git directory), owner-only
  and not a symlink. A shared or symlinked existing root is refused rather than repaired. The default
  state-root location is chosen when S2/S6 wire the store.
- **Store trust boundary**: generic JSON/text are sanitized before hashing. Contract objects
  (capture, interpretation, definition, invocation, result) must parse, bind to the run and already be
  safe; exact diff/patch bytes are refused rather than altered if redaction would apply. PNG images
  require the producer's `project-privacy-v1` masking attestation and are checked only for PNG structure
  and size: the store makes no pixel-safety claim, and masking itself is S3 work.
- **Store reads**: a closed lookup by registered run-owned UUID plus exact SHA-256, re-checking root,
  run-directory and file identity (dev/inode) through `O_NOFOLLOW`. The registry is per process, which
  matches "reviewable until the user closes Studio"; no arbitrary path route exists.
- **Lifecycle authority**: only `finalize` reaches `terminal`. It joins producers within the 5-second
  stop grace, releases owned resources once (newest first, one retry, verified), then reduces with
  `reduceProjectOutcome`. A pass also needs the uninterrupted path through `candidate-checking`.
  An unjoined producer makes cleanup `unverified`, so the run cannot pass.
- **Budgets**: human waiting states are selection/configuration, demonstration, report review,
  clarification, interpretation review and result review (`terminal`); they run no timer and refuse
  automatic work. Only `preparing`, `analyzing`, `baseline-replay`, `correcting` and
  `candidate-checking` accrue the 600-second aggregate. `finalizing` is excluded so mandatory cleanup is
  never cut short by the budget.
- **Implementation resource bounds (not product limits)**: 512 artifacts per run, 64 owned resources per
  run, 30 seconds per cleanup step.

## Resources

T006–T009 tests create only private temporary directories and in-process fakes; they start no
container. The prepared image is retained intentionally as the S1 operator artifact for later slices.
Two `Created` containers labelled `dev.flowproof.test-unrelated`/`dev.flowproof.editing-session`
(created 2026-11-04T04:55Z, before S1 began) pre-date this work and were left untouched.
The full container list before and after the serial default suite was identical
(`s1-containers-before.txt`, `s1-containers-after.txt`).

## Gaps and Open Items

- The store and lifecycle are not wired into admission, runtime, capture, model, replay, patch, CLI or
  Studio; those connections belong to S2–S6 and their tasks remain open.
- No live model call, project-live run, live smoke or owner observation has been executed; no feature,
  live or owner acceptance is claimed.
- Pixel masking is not implemented here; the PNG attestation is a contract for the S3 producer.
- `pnpm test:project-meta-smoke` loads `.env` when present; it was not run.
