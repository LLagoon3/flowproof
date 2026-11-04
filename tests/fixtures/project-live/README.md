# Project-live sample fixture (Spec 006)

`task-board/` is a permitted synthetic React 19.3.1 / Vite 8.3.5 single-package static client.
It contains only invented sample data, no real people, accounts, credentials or company content.
`tests/helpers/projectLiveRepository.ts` copies exactly the files listed in `fixture.json` into a
fresh, independent Git repository under the operating-system temporary directory, outside this
checkout, commits them once with fixed identity and dates, and verifies the resulting tree and
commit identities. Nothing in this directory is executed on the host by FlowProof tests.

- **Lock**: `task-board/package-lock.json` (npm lockfile v3, `registry.npmjs.org` integrity
  hashes only) is the locked dependency set the operator toolchain image in
  `tools/runtime/project-vite.Dockerfile` installs. `fixture.json` records its SHA-256.
- **Project check**: `node --test tests/tasks.test.mjs` exercises the pure helpers in
  `src/tasks.js`. It passes on the committed baseline; it does not cover the defect below.
- **Build**: the image's Vite (`/opt/flowproof/toolchain/node_modules/vite/bin/vite.js build
  --configLoader native`) writes static output to `dist/`; the entry path is `/`. The native
  config loader avoids Vite's default config bundling into `node_modules/.vite-temp`, which is
  the read-only prepared dependency root in the toolchain image.

## Evaluator-only notes

These notes describe the intended defect so that a human evaluator can judge a later live run.
They are not copied into the materialized repository, and production admission, analysis,
replay derivation or candidate selection must never read this file, key off the fixture name or
embed a fix for it.

- Intended DOM defect: choosing **Open** in the task filter lists the finished tasks instead of
  the unfinished ones, while the summary still reports three open tasks.
- Expected behavior: the **Open** filter lists exactly the unfinished tasks.
