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
