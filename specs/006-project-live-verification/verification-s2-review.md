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

## Target-security decoy fixture (parent serial run)

The parent's full serial run failed `project-target-security.test.ts` with a 240 s `beforeAll` hook
timeout plus an unhandled `listen EADDRINUSE 127.0.0.1:43152`. Cause in the fixture: its decoy
servers listened on fixed ports 43152/43153, inside the 43150–43159 range production reserves for
project targets (a concurrently launched project Studio scans and binds any free one), and the
listen promise resolved only on `listening`, with no `error` handler, so an occupied port became
an unhandled error and a hook that never settled. Which process held 43152 during that run is not
recorded in the retained logs and is not asserted here.

Red: with a controlled listener holding `127.0.0.1:43152`, the unchanged file reproduced exactly
that failure (hook timeout at 240 s, unhandled `EADDRINUSE 127.0.0.1:43152`, 6 tests skipped).
Fix (test fixture only): each decoy takes an OS-assigned port outside the reserved range (an
in-range assignment is released and retried, bounded), rejects on a bind error, and is owned and
closed in `afterAll`; the hostile page and the navigation assertion receive the actual ports. The
target's reserved port 43151, production listen policy, origins, host guards and every security
assertion are unchanged.

Green (exact heavy lock, merged-S3 HEAD): the file passes 6/6 with 43152 and 43153 held by other
listeners, 6/6 under the runner-like `::1`-first resolver, and in the focused set
(`project-studio`, `project-runtime`, `project-target-security`, `worktree`: 49/49).
`pnpm typecheck` and `pnpm build` exit 0. Host containers 46 -> 46 identical; no listeners left on
43150–43159. Logs: ignored `.flowproof/task-logs/006-project-live-verification/s2-decoy/`. The full
serial and full concurrent suites were not rerun here; hosted CI after publication must prove the
whole check.

## Parent independent aggregate verification after review corrections

Tested implementation HEAD: `c06981111c6505ddb584736bc0124b63c152f6a0` (includes merged S3/main `76df76a`). The parent
inspected the actual product and test corrections, not only worker summaries. Under the exact
`flock -w 1800 /tmp/flowproof-spec006-heavy.lock` for the complete process and cleanup:

- `pnpm typecheck` and `pnpm build`: passed.
- Independent owned listeners held both `127.0.0.1:43152` and `:43153` while the complete target
  security file passed 6/6; the parent closed both listeners afterward.
- Runner-like IPv6-first `localhost` resolution: target security 6/6 passed.
- Eight focused admission/preparation/patch/runtime/security/route/worktree/editing-capture
  files using default file concurrency: 129/129 passed, no skips.
- Actual headed project setup journeys: 2/2 passed (real target/offline prepared runtime).
- Prescribed full V1-style serial default Vitest: 63/63 files, 2028 passed,
  5 existing opt-in Chromium replay skips, zero failures. Duration: 319.12s (tests 97%, import 3%).
- All host container IDs before/after are identical; no runtime preparation, pull or image
  rebuild was needed. Detailed logs and summary: ignored `pr30-parent-r3/` task-log directory.

Historical local failures remain separate: the earlier full default-concurrent run at `fe4d26c`
had 13 legacy timeouts and one `ENOTEMPTY` cleanup failure. All 14 passed in the earlier serial
run, which instead exposed the now-corrected fixed-decoy-port startup defect. This new serial
success is not a claim that the entire concurrent suite was rerun locally or that every historical
failure has a proven shared cause. Exact published-HEAD hosted CI and completed review are required
separate gates before merge. This remains S2 module verification, not live-model/full-feature or
owner acceptance; no provider call or deployment occurred.

## Review 2 finding 4473842280 — nested directory entry

A confirmed nested entry such as `/app/` is accepted (`projectFileOf` maps it to `app/index.html`),
but the project target parsed requests with `requestSegments`, which refuses the trailing empty
segment of `/app/`, so the prepared target answered 404 to its own entry. The parent's built-module
probe reproduced it (explicit `/app/index.html` 200; `GET`/`HEAD /app/` and `/app/?synthetic=1` 404).

Fix (`studio/targetApp.ts`, project target only): a private `projectRequestSegments` maps a closed
directory request (path longer than `/` ending in `/`) to that directory's `index.html` and then
applies the unchanged `requestSegments` checks, so repeated slashes, dot and `%2e%2e` segments,
encoded slashes, traversal and control bytes stay refused, and only a registered file whose bytes
match its accepted hash is served, with the unchanged headers and CSP. The legacy prepared-mode
`requestSegments` and its callers are unchanged.

New `tests/integration/project-target-directory.test.ts` (real HTTP target, owned temp output):
directory entry `GET /app/`, `/app/?synthetic=1` and `HEAD /app/` return the registered bytes with
headers identical to `/app/index.html`; root, file, 405, 421 and 503 controls hold; 17 confusion
forms × GET/HEAD stay 404 (including an unregistered `extra/index.html` on disk); and a headed
Chromium frame passes `confirmProjectTargetReady` for entry `/app/`, then runs its relative asset.
Red on the base: the directory test failed (`/app/` 404) and readiness failed `TARGET_LOAD_FAILED`;
the refusal test passed both before and after. A first green run exposed a fixture-only script
placement error in the new test (asset in `<head>`), corrected before commit.

Validation (exact heavy lock): new file 3/3, and 9/9 with `project-target-security` under the
runner-like `::1`-first resolver; `pnpm typecheck` and `pnpm build` exit 0; the parent probe with
`--green` against the rebuilt module passes (output in this unit's log root; the parent red JSON
is untouched); focused run of seven files (new, target-security, project-studio, project-runtime,
legacy target-app unit, run-state-machine unit, probe-install-order) 91/92 with the single failure
being the since-corrected fixture test; `tests/e2e/project-setup.spec.ts` 2/2. Containers 46 -> 46
identical; no listeners on 43150–43159; no temporary outputs left. Logs: ignored
`.flowproof/task-logs/006-project-live-verification/s2-directory/`. Full suites and hosted CI for
this commit are not run here.

### Independent parent validation of the nested-directory correction

At implementation `dc095d66cc9a47c35fb9654986b37174e962985f`, the source parent reviewed
all three changed files and independently ran the exact shared heavy lock:

- `pnpm typecheck` and `pnpm build`: exit 0.
- The original independent real-HTTP reproduction `/tmp/flowproof-pr30-directory-probe.mjs --green`:
  explicit file, directory GET/HEAD and query entry return 200; five path-confusion controls remain
  404. The original red receipt is preserved separately.
- Six focused files (directory, target-security, project-studio, project-runtime, legacy target-app,
  and run-state-machine): 91/91 passed, zero skipped. The first parent command misspelled the path
  of probe-install-order; that real integration file was therefore run separately, not counted here.
- Actual headed `tests/e2e/project-setup.spec.ts`: 2/2 passed.
- All 46 host container IDs are identical before and after; `git diff --check` passes.

Logs are ignored under `.flowproof/task-logs/006-project-live-verification/pr30-parent-r4/`.
This localized correction does not claim a new full serial run. Prior implementation `602280f`
hosted CI `41920238774` completed successfully with 2028 deterministic tests and 58 E2E tests
(five existing opt-in skips in each suite); those counts are historical, not proof for this revision.
The new published HEAD still requires completed exact-head Codex review and full hosted CI.

The correctly targeted `tests/integration/probe-install-order.test.ts` independently passed 1/1;
combined focused coverage is seven files and 92 passed, with the six-file and one-file runs distinct.
