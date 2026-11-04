# Verification: Spec 006 — S1 PR #27 Containment Correction

**Scope**: The first PR #27 review P1 finding for T006/T007 only (Codex comment `4467008517`, thread
`PRRT_kwDOVR0qYM6zkmuK`). This complements `verification.md`; it changes no task mark and claims no
feature, live or owner acceptance. Parent session owns push, review and merge.

**Branch / baseline**: `feat/006-project-live-verification`, clean baseline
`4a53a65af6f64b1c32ca18c16cc192940806dba1`. Fix commit `f1801e4`. Logs live in the Git-ignored
`.flowproof/task-logs/006-project-live-verification/`.

## Finding and Fix

`isInsideOrEqual` in `packages/flowproof/src/evidence/projectStore.ts` treated any relative path that
starts with `..` as outside, so `/repo/..state` was classified outside `/repo`. Only an exact leading
`..` segment (`..` or `..<sep>…`) now means outside; an absolute relative (another root) stays outside.

Call-site inventory (all in `projectStore.ts`, all share the corrected predicate):

| Call site | Check |
| --- | --- |
| `assertOutsideProtected` → `openProjectStateRoot` | canonical state root (realpath of deepest existing ancestor plus missing segments) inside a protected root; inverse: state root contains a protected root |
| `assertOutsideProtected` → `createProjectTempDirectory` | realpath of the temporary root, then realpath of the `mkdtemp` directory, inside a protected root |

Protected roots are realpath'd existing directories (checkout and, when supplied, external Git dir).
Missing temporary roots are refused by `realpath` (`ENOENT`) before any allocation; unchanged.
Not changed (out of scope, reported): `sanitizeFilesystemPath` in `evidence/sanitize.ts` uses the same
prefix test, but there a misclassification only redacts an in-repository path (fail-safe direction).

## Evidence

| Check | Result | Log |
| --- | --- | --- |
| Red, baseline store + new tests | 4 failed / 22 passed: every `..state`, `..cache`, `...` (existing, missing, nested, symlink-ancestor, external Git dir) state/temp root `accepted`, with `runs` or `flowproof-project-*` directories written inside the protected roots; `..project` containment accepted | `pr27-containment-red.log` |
| Green, store tests (three runs) | 26/26 each | `pr27-containment-green-{1,2,3}.log` |
| Over-strict mutation (string-prefix predicate) | 1 failed: the siblings-allowed test rejects `repo-state` | `pr27-containment-mutation-prefix.log` |
| S1 focused set, serial (6 files) at `f1801e4` | 109/109 (104 before + 5 new) | `pr27-s1-focused-f1801e4.log` |
| `pnpm typecheck`, `pnpm build` at `f1801e4` | passed | `pr27-typecheck-f1801e4.log`, `pr27-build-f1801e4.log` |
| `git diff --check 4a53a65..f1801e4` | clean | — |

New tests compare a full type/mode/digest tree of every protected root (and the symlink alias
directory) before and after each rejection: unchanged. Kept allowed: `sibling`, `..sibling`,
`repo-state`, lexical `repo/../..lexical`, parent temporary root and a `..cache` sibling temporary root.
Existing run, race, discard, seal and privacy tests pass unchanged.

Not rerun (no runtime, image or consumer change; only `tests/unit/project-store.test.ts` imports the store):
the default legacy suite, image verification, Playwright, model or live gates.
