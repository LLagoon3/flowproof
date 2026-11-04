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

## Review 2 P2: Manifest Directory Modes

**Finding**: Codex comment `4467130271`, thread `PRRT_kwDOVR0qYM6zk5hT`, at
`tools/runtime/prepare-project-vite.mjs` `writePrivateJson`. This is a separate defect, not a
recurrence of the path-segment finding above. Baseline `afae0887152ee12f9fd9e32e77de2db738052479`;
code commit `7ca86e2f0cee2529ccbbd04afc5facb77c010bbb`.

`writePrivateJson` ran `mkdir -p` and then `chmod 0700` on the manifest directory unconditionally, so
`prepare --output` into an existing directory rewrote that directory's mode (1777 sticky, 0755, 0770,
and even 0500, which it made writable). Now existing directories keep their exact mode and are never
chmod-ed. Only missing directories are created, one at a time, each with mode 0700 (the umask can
reduce that mode but never widen it). The manifest is still a new `O_EXCL | O_NOFOLLOW` 0600 file
(`fchmod` 0600), synced and renamed into place. Refused unchanged as `OUTPUT_INVALID`: a symlinked or
non-directory manifest directory, a file ancestor, and a target that is a directory or symlink.
Write I/O failures become `OUTPUT_WRITE_FAILED`. On failure the writer removes its own temporary
file and the empty directories it created, and nothing else.

Call-site inventory: `prepare` is the only caller (manifest write after a successful build and
inspection). The helper is exported so tests can call it directly in a sandbox. The other
`chmod(parent, 0o700)` calls, in `selfCheck` and `prepare`, act on each function's own fresh
`mkdtemp` directory (removed in `finally`) and are unchanged.

| Check | Result | Log |
| --- | --- | --- |
| Red: baseline helper plus `export` only, plus new tests | 3 failed / 8 passed: 1777/755/770 became 700; the replaced manifest's 755 directory became 700; file-path and file-ancestor gave raw `EEXIST`/`ENOTDIR`; a target directory gave `EISDIR` and left a `.tmp` file; a symlink target was replaced; a 0500 directory became 700 and was written | `pr27-r2-red.log` |
| Green, preparation suite (three runs) | 11/11 each | `pr27-r2-green-{1,2,3}.log` |
| Mutation: re-add `chmod(directory, 0o700)` | 3 failed (the red set) | `pr27-r2-mutation-chmod.log` |
| Mutation: drop the target-type check | 1 failed: a symlink target was replaced; a target directory went down the rename-failure path (`OUTPUT_WRITE_FAILED`) with no leftover temporary file | `pr27-r2-mutation-target-check.log` |
| S1 focused set, serial (6 files) at `7ca86e2` | 113/113 (109 + 4 new) | `pr27-r2-s1-focused-7ca86e2.log` |
| `pnpm typecheck`, `pnpm build` | passed | `pr27-r2-typecheck.log`, `pr27-r2-build.log` |
| Retained image `verify --manifest ... --self-check` (no build or pull) | `verified` for the recorded image, manifest and dependency tree digests; offline sample build passed; 3/3 project checks passed; container ID list identical before and after; no `flowproof-vite-*` temporary directory left | `pr27-r2-image-self-check.out`, `pr27-r2-containers-{before,after}.txt` |
| `git diff --check afae088..7ca86e2` | clean | — |

Every test path is inside the test's own `mkdtemp` sandbox; no test chmods `/tmp` or any shared path
(`/tmp` is still 1777). The tests snapshot the whole sandbox tree (type, mode including sticky bits,
digest, link target) before and after each rejection: unchanged. Not directly tested: removing
created directories after a mid-write I/O failure, which cannot be triggered deterministically
without a fault-injection layer. Not rerun: the default legacy suite, Playwright, image rebuild,
model or live gates.
