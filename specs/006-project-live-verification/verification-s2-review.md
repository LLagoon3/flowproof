# S2 PR #30 Review Fix Verification

Base: `c620ba84764709e9f8220d841b0ba7ccb481cc73`. Two P2 review findings were fixed red-first.

## Findings and fixes

- **4473258012 — nested output with new ancestors.** `snapshot.verify()` only traversed directories
  that held committed files, so a build-created ancestor of a registered nested output (for
  example `build` for `build/dist`) was reported unexpected. `verify` now also traverses the
  registered output's ancestors; they are walked, never trusted, so any other child (file, symlink
  or unknown entry) is still unexpected, and the output leaf alone stays runtime-owned. The
  existing committed-ancestor case (`tests/build`) is unchanged and still passes.
- **4473258030 — second prepare overwrote the active output.** `/api/project/prepare` now refuses a
  request while the target is ready (`409 PROJECT_ALREADY_PREPARED`); only a settings change,
  which releases the owned output first, can start another preparation. As defense in depth,
  `startProjectStudio`'s `prepare` releases any retained output before starting, so a later success
  never overwrites one. The Studio UI always reconfigures before preparing, so its flow is unchanged.

## Validation (exact `/tmp/flowproof-spec006-heavy.lock` held)

- Red: both new tests failed on the base (`expected 202 to be 409`; nested build reported failed).
- Green: both new tests pass; `pnpm typecheck` and `pnpm build` exit 0.
- Focused: `project-studio` contract, `project-runtime` and `project-target-security` integration
  files all pass with real Docker and the retained prepared image (no pull or rebuild);
  `tests/e2e/project-setup.spec.ts` passed 2 tests under Xvfb.
- Host containers 46 -> 46 identical IDs; no listeners left on ports 43150–43159.
- Logs: ignored `.flowproof/task-logs/006-project-live-verification/s2-review/`.

Not run here: the full default suite, and hosted CI for this commit. The separate hosted CI
failures (target-security `ECONNREFUSED 127.0.0.1:43151` and a legacy worktree timeout) were out
of scope for this unit and remain open.

## Hosted CI run 41911294131 failures

**Target security (3 tests, `ECONNREFUSED 127.0.0.1:43151`).** The production target listens on
`localhost` (`server.listen(port, 'localhost')`) and its origin is `http://localhost:<port>`. The
hosted runner's `/etc/hosts` maps `::1 localhost`, so Node binds `::1`; the test helper
`targetRequest` connected to a hard-coded `127.0.0.1`. Locally `localhost` resolves only to
`127.0.0.1`, which hid it. Chromium resolves `localhost` across both families, so the browser tests
in the same file passed on the runner. Reproduced with an evidence-only `--import` preload that
makes `dns.lookup('localhost')` return `[::1, 127.0.0.1]` like the runner: a probe server then binds
`::1`, a `127.0.0.1` request is refused and a `localhost` request succeeds; the unchanged file
fails exactly the same 3 tests with the same error while its 3 browser tests pass. Fix (test
only): `targetRequest` connects to `localhost`, as the production origin names it; the explicit
`Host` header values and every assertion are unchanged, and production listen policy, origins and
host guards are untouched. The file passes 6/6 under the runner-like resolver and by default.

**Worktree (`resolves the Git common directory…`, 5 s timeout).** The first two tests clone the
whole repository with two linked worktrees and run complete session lifecycles while every other
worker is starting. Measured 1275/520 ms alone, 3961/2492 ms on one contended CPU, and 6150/4676 ms
on the hosted runner, against ~0.5–0.8 s for later tests in the same file. They now carry a named
`GIT_SESSION_TIMEOUT` (30 s), like the file's existing `BUILD_TIMEOUT`; no global timeout,
serialization or assertion changed. The contended local run did not exceed 5 s, so this is
measured headroom, not a local red reproduction.

Validation (exact heavy lock): both files 26/26 by default; `pnpm typecheck` and `pnpm build`
exit 0. Full default `pnpm test` under Xvfb with the retained manifest: **1963 passed, 5 skipped,
2 failed** (79.65 s). Both failures are `editing-capture-git.test.ts` 5 s timeouts outside this
change and outside the hosted failures (972/1391 ms on the runner); they pass alone (2/2). Host
containers 46 -> 46 identical; no listeners on 43150–43159. Logs: ignored
`.flowproof/task-logs/006-project-live-verification/s2-ci-dns/`. Hosted CI for this commit is not run.
