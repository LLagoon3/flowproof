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

### Reproducible Size and Zoom Matrix (also applies to T005)

The launcher currently fixes Studio to the scenario's 1280 x 800 viewport at device scale 1.
Changing its OS window alone does not test the requested sizes. Do not change the launcher or
scenario for this feature, and do not request Playwright's built-in page/browser fixtures.

1. At 100%, the new workspace test uses the existing harness's actual `page.setViewportSize`
   with 1280 x 720 and 1920 x 1080. Record `innerWidth`, `innerHeight`, zoom, and screenshots.
   This is an explicit viewport override for layout, not proof of actual browser zoom.
2. For the actual zoom check, retain that same launcher-owned page/browser on a visible desktop.
   A test-only CDP session from `page.context().newCDPSession(page)` calls
   `Emulation.clearDeviceMetricsOverride`; use `Browser.getWindowForTarget` and
   `Browser.setWindowBounds` to restore normal native-window sizing. At native 100% zoom, adjust
   window bounds until the measured content area (`innerWidth`/`innerHeight`) is 1280 x 720.
   Do not replace the context/page or change the target frame. This procedure is mechanical review,
   not part of the default unattended Playwright suite.
3. With the outer window unchanged, use OS-delivered browser shortcuts/menu to set actual 200%
   zoom. Capture the browser's visible 200% indicator and effective CSS viewport (approximately
   640 x 360, allowing browser rounding). Check reflow, focus, primary/result/evidence/restore
   controls, and absence of page-wide horizontal overflow; keep the chart at 640 x 360 with local
   scrolling. Restore 100% and original test viewport afterward, then close only owned resources.
4. Record browser version, pre/post dimensions, the native zoom indicator and observed outcomes.
   If CDP/native zoom cannot produce the measured state, record a blocked check, not a pass or
   an emulated substitute. A required launcher change returns to owner design review.

For the static preview, use its ordinary visible browser page without viewport emulation, size
the content area at 100%, then follow steps 3-4. CSS transforms, pinch scaling, device scale or
smaller viewports alone are never 200%-zoom evidence. The agent performs these mechanical checks;
the owner need not repeat them. In stacked layout the width separator is hidden/unfocusable but
collapse/restore remains. A collapsed panel's external status must update through final result arrival.

During captured baseline and candidate measurement, change panel width and collapse/restore in
the real E2E. Compare with a matched control: same verdict/checks, 640 x 360 screenshot dimensions,
and valid unchanged within-run evidence binding. Different runs may generate different evidence
IDs. Assert same iframe/frame, no extra navigation/start and unchanged guards throughout.

## Slice 3: Work-State Presentation

Repeat the UI and workspace browser suites. Include event order, contiguous groups, exact observed
finalizing markers, finalizing-marker drift fallback, stream disconnect without execution failure,
result-read failure without a verdict, authoritative result precedence, and late events after result.
At actual captured scan and cleanup barriers, assert that producer events render the finalizing
card before the authoritative result is exposed; details retain raw phase. Use bounded test-local
barriers released in `finally`, without changing engine exports, budgets or production options.
Copied selector fixtures alone cannot establish producer-string drift coverage.

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

### Real-UI Owner Acceptance Material

Extend `tests/e2e/workspace-ux.spec.ts` in T021/T023/T025, using existing support harnesses and
test-local request/transport barriers. These are planned test cases, not existing manual launcher
options. The manual captured launcher remains pass-only. Do not add a product fault-injection
feature, server endpoint, engine delay or new manual launcher case.

| Check / state | Reproducible real-UI source | Owner presentation |
| --- | --- | --- |
| SC-001, both ready modes | Existing recorded Hero harness and captured pass harness, before start | Interactive actual primary action, no verbal coaching; timed per mode. |
| SC-002 ready / active | Same harnesses; observe actual admission/phase events | Unaltered state screenshots with test revision/mode, not annotated answers. |
| SC-002 finalizing | Actual captured scan/cleanup events; bounded test-local delivery/poll barriers while observing the real producer | Screenshot before valid final result is delivered; record raw event sequence and pending result assertion. |
| SC-002 disconnected without result | Abort the real events request using the existing route pattern in `browser-close.spec.ts`; hold the test transport/result response until the warning is rendered | Screenshot with no final verdict; release routes/barriers in `finally`. |
| SC-002 unsuccessful / successful final | Existing legacy failure/Hero and captured plausible-wrong/pass cases, actual persisted results | Screenshots tied to strict result/run IDs; success comes only from the result. |
| SC-003 successful and unsuccessful/unevaluable, both modes | Existing Hero and rejected-citation legacy cases; captured pass and plausible-wrong/unevaluable cases | Interactive actual final shell, real stored or explicitly missing evidence and all gate/check details. |

For SC-002 use these real Studio screenshots (all six states, with both modes represented), not
simulated preview screenshots. Record the owner's answer/next action and elapsed time separately
from the expected answer. Missing captures leave the criterion pending.

For SC-001/SC-003, author named owner-review cases in the workspace E2E using the same harness
setup and assertions, then run on the owner's visible desktop (not a hidden Xvfb display):

```bash
pnpm exec playwright test tests/e2e/workspace-ux.spec.ts --debug --grep owner-review
```

These prospective cases use test-local `page.pause()` before start for SC-001 and after verified
final result/artifact availability for SC-003. The owner navigates the actual UI while the harness
is retained. Pauses apply only in explicit debug review, not normal CI, and must never suspend
engine measurement, cleanup, time budgets or active resources. Resume to run cleanup assertions in
`finally`; captured target disposal must already be complete before final-shell review. Keep legacy
iframe mounted while switching canvas evidence tabs and assert element/frame identity on return.
Record each missing evidence side honestly; never create replay evidence for a run that did not reach it.
If a source case lacks a needed state/check outcome, add only a test-local case using existing
contract-valid conditions; inability to reproduce it remains a gap, not permission for product changes.

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

Store screenshots, traces, zoom evidence and the state-to-case/run manifest under ignored
`test-results/studio-workspace-ux/`, with per-slice/per-tested-commit subdirectories. Do not commit
binary evidence, launch tokens, private data or absolute operator hosting paths. Commit concise
results and repository-relative artifact locations in tasks/design-system records; transfer review
material through the authorized review surface when needed. If evidence expires, mark it unavailable.
To avoid a circular commit reference: commit the implementation first, test that clean commit,
then record its full SHA in a separate results-only commit. The tested revision is that results
commit's parent, never a claim that the later documentation commit itself was tested. Any code/test
change after testing requires testing the new committed revision before recording its results.

Each slice is independently reviewable/revertible through the repository PR workflow. Production
rollback restores presentation code while preserving runtime contracts and prior artifacts; preview
rollback removes only its isolated files and design material. Stop on any safety-semantic regression.
