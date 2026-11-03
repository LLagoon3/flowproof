# Validation Guide: Studio Workspace UX

**Status**: Proposed checks for future authorized implementation, not results of this Plan run.
Run only the current approved slice's checks. No new preview, test file, or production UI exists yet.

## Prerequisites

Use Linux, Node.js 24, repository-pinned pnpm, Git, the prepared Docker environment for captured
real-process checks, and a desktop display or Xvfb. Preserve unrelated worktrees and occupied ports.
Never read or copy private environment values into preview data or review screenshots.

For implementation validation, use a clean committed slice checkout, because existing E2E and
manual harnesses clone committed bytes. Install dependencies when needed, not merely to review docs:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm build
```

Tests use recorded/synthetic provider responses. Do not run `test:meta-smoke` or a live Hero
request for this UI feature. A fixture's legacy provenance must remain explicitly labelled.

## Slice 1: Review the Design Preview

After the proposed static preview files actually exist, start their loopback-only server:

```bash
python3 -m http.server 43120 --bind 127.0.0.1 --directory tests/manual/studio-design
```

First check the port is free; use a different loopback port if occupied, without stopping unrelated
services. Open the printed local address in the intended visible browser. If a remote display or
review surface is needed, use an authorized existing connection rather than publicly exposing it.
The preview must be labelled simulated, make no production requests, and contain no live target.

Agent-executed checks: both modes; all six SC-002 states; collapsed/restore; drag/keyboard resizing;
missing/unreadable evidence examples; reading position; focus; contrast; all specified sizes/zoom.
Record mechanical failures and fix them before owner review. Stop only the preview server owned
by this run after review unless the owner wants it left open.

Human-only review:

1. Does the primary action and canvas/work division make sense without explanation?
2. Can the owner understand current work, result pending vs final verdict, and available evidence?
3. Is the hierarchy/density/balance comfortable enough to use?

Record feedback, reviewed version, and decision. This is not runtime QA or automatic acceptance
of the production feature. Production slices await accepted visual direction and their own authorization.

## Slice 2: Workspace and Controls

After the new browser suite exists, use the commands below; absent files or zero discovered tests
are not successful validation. Existing suites must retain their assertions:

```bash
pnpm exec vitest run --project ui
xvfb-run -a pnpm exec playwright test tests/e2e/workspace-ux.spec.ts
xvfb-run -a pnpm exec playwright test
```

Check same iframe element/frame through panel resizing, collapse/restore and responsive layout;
no start re-submission, iframe reload, or unnecessary artifact reload. Preserve draft and selections,
keyboard resize/restore, hidden-panel focus exclusion, and existing production CSP.

Run the layout matrix at 1280 x 720 and 1920 x 1080 at 100%, and 1280 x 720 at actual 200% browser
zoom. Use browser zoom controls and record the effective viewport; CSS transforms, pinch scaling,
`deviceScaleFactor`, or smaller viewport dimensions alone are not substitutes. The agent can perform
this mechanical browser check; do not ask the owner to repeat it. Keep the fixed measured chart
unchanged; local target scrolling is allowed while outer-page controls remain reachable.

## Slice 3: Work-State Presentation

Repeat the UI and workspace browser suites. Include event order, contiguous groups, exact observed
finalizing markers, finalizing-marker drift fallback, stream disconnect without execution failure,
result-read failure without a verdict, authoritative result precedence, and late events after result.

Focus an older card and scroll away from the end, append work, and verify no removal, forced
scroll, or focus theft. Collapse and restore while a detail read is pending; it must not cancel
execution or discard the detail state. Do not fabricate completed checks from grouped cards.

## Slice 4: Result and Evidence

Repeat the UI/browser suites and complete final regression:

```bash
pnpm typecheck
pnpm build
xvfb-run -a pnpm test --no-file-parallelism --maxWorkers=1
xvfb-run -a pnpm exec playwright test
git diff --check
```

Use both legacy and captured families: successful, unsuccessful and unevaluable checks, no valid
result, missing/not-received/unreadable images, disconnection followed by result, interruptions,
cleanup failure and original-integrity evidence. Preserve all nine gates / ten checks, exact success
labels, legacy provenance/diff and captured identity/cleanup. Retain captured frame-detachment,
input-guard and no-owned-resource-leak checks in the existing real E2E suites.

For a final owner walkthrough of actual captured success, use the existing credential-free launcher
in a clean committed checkout with dependencies/build and Docker ready:

```bash
node tests/manual/captured-verification.mjs --case pass
```

Select the existing candidate-verification start action. This is an actual prepared run, not a
recorded design preview. Close the session normally after review and inspect its cleanup output.
The agent checks processes/worktrees/port/integrity; the owner checks comprehension and visual feel.
For legacy success use the existing recorded Hero browser harness rather than launch a live API call.

Record SC-001 and SC-003 per-mode times, the six SC-002 answers/times, and SC-007 visual feedback.
These small owner checks are not a user-population study. Failed/pending feedback stays unresolved.

Measure contrast from rendered foreground/background combinations, including translucent layers,
not a token-name snapshot. Treat text as large only at >=24 CSS px, or >=18.67 CSS px when bold;
apply 4.5:1 otherwise. Check meaningful control boundaries at 3:1 as specified, and retain visible
focus and non-color status labels. Do not call these measurements a complete accessibility audit.

## Evidence and Rollback

Record the exact tested commit, commands/exit status, discovered cases, screenshots per state,
mechanical accessibility/contrast/zoom evidence, baseline-compatibility outcomes and owner decision.
Never reuse earlier Spec 004 counts as this feature's validation or turn preview screenshots into proof.

Each slice is independently reviewable/revertible through the repository PR workflow. Production
rollback restores presentation code while preserving runtime contracts and prior artifacts; preview
rollback removes only its isolated files and design material. Stop on any safety-semantic regression.
