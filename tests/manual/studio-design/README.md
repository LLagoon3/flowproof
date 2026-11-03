# Studio Workspace Design Preview

An isolated, clickable design preview for
[Spec 005](../../../specs/005-studio-workspace-ux/spec.md). It shows the proposed canvas-first
Studio workspace with **simulated data only** so the visual direction can be reviewed before any
production UI changes. It is design material, not a product route, a test suite, or evidence that
a real run behaves this way.

The proposed visual values and control inventory are recorded in
[design-system.md](../../../specs/005-studio-workspace-ux/design-system.md).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Static page shell, preview controls, and the compact `Preview · simulated` label with its overflow menu. |
| `preview.css` | Proposed tokens, layout, and control states. Self-hosted; no remote fonts or assets. |
| `preview.js` | Synthetic mode/state data and presentation-only interactions. No network calls. |
| `README.md` | These instructions and the preview verification record. |

Nothing here is imported by the Studio bundle, served by the Studio backend, or discovered by the
repository's typecheck, Vitest, or Playwright configuration. There is no build step, no dependency,
and nothing to install.

## Run the preview

Serve the directory over loopback HTTP with any static file server. With Python 3:

```bash
# From the repository root. Check that the port is free first; pick another loopback
# port if it is taken, and do not stop a listener you did not start.
python3 -m http.server 43120 --bind 127.0.0.1 --directory tests/manual/studio-design
```

Open `http://127.0.0.1:43120/` in a desktop browser and stop the server with `Ctrl+C` when the
review ends. Loopback HTTP is the primary verified path. The parent reviewer also verified the
unchanged files directly in Chromium; other browsers and file-origin behavior are not guaranteed.

If a reviewer needs remote access, use an existing authorized connection to the loopback server.
Do not expose the server publicly. How the files are hosted is the operator's choice and is not
a project service.

## Minimalist revision direction (2026-11-04)

The owner rejected the first preview's information density. The revised default screen reduces the
workspace to a request/work column and a large canvas. Preview-only mode/state/evidence controls
move into a closed overflow menu. Technical scope, activity events, check rows and identity remain
available in one collapsed `Details` disclosure instead of multiple competing cards. The header's
small `Preview · simulated` label keeps the synthetic nature visible without a testing toolbar.
No production UI or later slice is included. Owner acceptance of the revision is still pending.

## What the preview covers

- **Two modes.** *Legacy prepared case*: case picker (in Preview options), bounded request (1 to 500 characters), and
  `Start run`. *Captured candidate*: a host-fixed candidate and `Start candidate verification`,
  with no chat, model or provider selection, or candidate generation.
- **Six SC-002 states** for each mode: ready, active, finalizing, activity disconnected without a
  result, unsuccessful final result, and successful final result.
- **Exact success claims.** `Verified Fix` appears only for a successful legacy result and
  `Candidate verification passed` only for a successful captured result. The nine legacy gates and
  ten captured checks are available on demand in final states.
- **Canvas surfaces.** A synthetic scene of the demo chart, labelled as a prepared preview, a live
  candidate build, not live, or stored evidence. Finalized legacy results add `Target` and
  `Evidence` tabs; finalized captured results show stored evidence because the target was released.
- **Evidence examples.** Available before/after screenshots, a phase that was not produced, an
  Evidence ID that was not received, a loading screenshot, and an unreadable screenshot.
- **Work panel interactions.** Drag or keyboard resizing across seven widths (20 to 32rem, default
  24rem), collapse and restore with an updating external status and result entry, work-card
  disclosures, and a latest-work affordance when the reader is away from the newest activity.

The controls in the closed Preview overflow menu exist only in this preview. `Append simulated activity`
adds one clearly labelled synthetic card per click so reading-position behavior can be inspected.
Nothing advances on a timer, and no control sends a request.

## Allowed data and constraints

- Use only synthetic data. Chart values come from the committed synthetic demo dataset
  (`apps/demo-chart/src/data.ts`); labels, check names, and fixed messages mirror existing Studio
  copy. Run IDs, Evidence IDs, digests, and commits are synthetic placeholders.
- Do not add real run artifacts, screenshots, tokens, credentials, personal data, host paths, or
  output from a model.
- No product network access: the page's content security policy permits no connections, frames,
  remote fonts, or remote images. There is no live iframe and no product endpoint.
- No inline styles: panel widths are stylesheet-backed steps selected by a data attribute,
  matching the production policy `style-src 'self'`.

## Review evidence and ignore rules

Store review screenshots and measurement logs under the ignored
`.flowproof/review/005-studio-workspace-ux/<tested-sha>/slice1/<case>/` directory, outside
Playwright's `test-results/` output. Both paths are already covered by `.gitignore`
(`.flowproof/`, `test-results/`); no ignore rule changes are needed. Do not commit screenshots or
generated logs; record only concise results and repository-relative locations here.

## Owner review questions

The owner reviews comprehension and visual direction only; mechanical checks are recorded below.

1. Do the primary action and the canvas/work division make sense without explanation?
2. Can you tell current work, a pending result versus a final verdict, and available evidence apart?
3. Is the hierarchy, density, and balance comfortable enough to use?

The owner's decision is recorded in `design-system.md`, not inferred from these checks.

## Verification record (initial revision, historical)

Mechanical checks only (T005/T006). They are not owner acceptance (T008) and not evidence that
the real Studio behaves this way.

- **Tested revision**: `e80e291cc4425cf49089be46e4deb8819007ff03`. The preview files were
  exported from that commit with `git archive` and served unchanged from a temporary directory.
- **Environment**: Linux, Node.js v24.22.1, the repository-pinned Playwright 1.64.1 with Chromium
  156.0.8078.4, headed on an isolated Xvfb display; loopback server
  `python3 -m http.server 43120 --bind 127.0.0.1`. A throwaway script outside the repository drove
  the browser; it is kept with the evidence, not here.
- **Static checks**: `node --check tests/manual/studio-design/preview.js` and
  `git diff --check 84727e4 e80e291` both exited 0. The scripts use no timers, network APIs, HTML
  parsing, inline styles, or storage.
- **Rendered checks**: 346 desktop/compact checks and 56 native-zoom checks, 0 failures.

| Area | Observed outcome |
| --- | --- |
| Sizes | 1280 x 720 and 1920 x 1080 side by side; 390 x 844 and 320 x 640 stacked with the separator hidden. These four use Playwright viewport sizes at 100%. Every mode and state has no page-wide horizontal overflow, and the start, collapse, `Go to result`, result, `Compare before and after`, and legacy tab controls scroll into view without being covered. |
| Native 200% zoom | Ordinary browser window, no viewport emulation, content area sized to 1280 x 720 at 100%. OS-level Ctrl+0 then five Ctrl+= key events (XTest on the run's own display) gave Chromium's visible 200% indicator, a 640 x 360 CSS viewport, DPR 2, and an unchanged 1280 x 807 outer window. Stacked layout, all twelve mode/state views, collapse/restore, and visible focus passed. Ctrl+0 restored 1280 x 720 at DPR 1. |
| Modes and states | Both modes, all six SC-002 states. `Verified Fix` appears only in the successful legacy state and `Candidate verification passed` only in the successful captured state. Nine gates and ten checks are available on demand. Captured mode has no request, chat, model, or provider control. No iframe exists. |
| Panel | Default 24rem; keyboard and drag select exactly 20, 22, 24, 26, 28, 30, and 32rem, clamped at both ends. Collapse inerts the panel and moves focus to `Show work panel`. The external status updates to the final verdict, and `View result` restores the panel and focuses the retained result. Restore returns focus to the previous panel control. |
| Preservation | The request draft survives resizing, collapse/restore, and a mode round trip. Empty and over-500-character requests disable Start with a visible reason. Card disclosures and focus survive appended activity, collapse, resizing, and state changes on the same run. |
| Tabs and evidence | Finalized legacy `Target` / `Evidence` tabs work with arrows, Home, and End; the target wrapper is hidden and inert, then returns as the same element. Evidence examples show available, phase not produced, ID not received, loading, and unreadable sides. Evidence tabs are absent while active. |
| Reading position | With the reader away from the latest work, three appended items keep scroll position and focus, and the affordance reads `3 new updates · Jump to latest`. Jumping reaches the end, and a reader at the end keeps following. No activity is appended while disconnected. |
| Contrast | Measured on computed rendered colors with composited backgrounds, in every state with details expanded, plus evidence, error, and collapsed views. 2,744 enabled text samples have a minimum of 4.96:1; disabled text has a minimum of 4.66:1. 323 control boundaries, fills, and icons have a minimum of 3.52:1. In the four recorded Tab traversals, every stop shows a 2px focus indicator at 6.75:1 or more. The synthetic target scene stands in for the target app and was excluded. |
| Network | Only `/`, `/preview.css`, and `/preview.js` were requested from the loopback server. No console errors, warnings, or policy violations occurred, and the page policy blocked a probe `fetch` to its own origin. |

Corrections made before the tested commit (T006): absent nodes no longer print `null`; the final
verdict is not repeated in the state card; the latest-work control no longer overlaps result
controls; result and evidence headings keep a scroll margin; unavailable preview controls keep a
3:1 boundary; the work-panel skip link is hidden while the panel is collapsed; and the `file://`
statement above was corrected.

**Evidence**: ignored
`.flowproof/review/005-studio-workspace-ux/e80e291cc4425cf49089be46e4deb8819007ff03/slice1/`. It
holds `manifest.json`, `desktop-checks.json`, `zoom-checks.json`, per-state screenshots in
`matrix-1280x720/`, `matrix-1920x1080/`, `compact-390x844/`, `compact-320x640/`, and
`native-zoom-200/` (desktop captures, including the visible zoom indicator), plus `keyboard/`,
`activity/`, and `contrast/` records. It is local review material and is not committed.

**Gaps**: Only Chromium was tested. This is not a complete accessibility audit: no screen-reader
review was done, and hover colors were not contrast-measured. The 100% sizes use viewport
overrides. The preview proves no runtime behavior.

## Review handoff (T007)

- **Source offered for owner review**: `e80e291cc4425cf49089be46e4deb8819007ff03`. The HTML,
  CSS, and JavaScript are unchanged at the handoff source commit
  `79afa85e0f7f96fb35dd9ae05bb211428f8556a7`.
- The three static files were copied byte-for-byte to an existing authenticated static host.
  The owner-facing location is delivered in the source conversation; the portable local review
  location is `http://127.0.0.1:43120/` using the command above. Hosting is not a project dependency.
- **Independent parent checks**: 219 checks, 0 failures, using offline Chromium on the unchanged
  files with HTTP requests blocked. Both modes and all six states at the four 100% sizes above,
  verdict boundaries, keyboard panel widths, collapse/restore and result focus, request bounds,
  nine gates and ten checks, keyboard tabs, and evidence states passed. Desktop and compact
  screenshots were inspected. Evidence is in `parent-review/` below the ignored evidence location.
  These checks do not independently repeat native zoom; the worker's zoom evidence was inspected.
- **Delivery gap**: The managed browser rejected loopback navigation under its existing policy.
  The public HTTPS page and both assets require existing Basic authentication (401); no authenticated
  HTTPS render or interaction was verified by the parent. No browser, server, or authentication
  policy was changed. Local file rendering is not proof of authenticated hosted rendering.
- **Owner decision (T008)**: Initial density rejected on 2026-11-04; revision acceptance pending. Offering the preview is not owner acceptance, and no later
  implementation slice has started.


## Minimalist revision verification (2026-11-04)

- **Tested revision**: `eab7b55acbca3a14195218821fd6f80ed0991986`, clean before verification.
  Only HTML/CSS/JS and design/review documentation changed; no production or later-slice files.
- **Environment**: Linux, Node.js 24.22.1, Playwright 1.64.1, Chromium 156.0.8078.4 headless;
  a review-owned loopback server with an automatically allocated free port. The saved verification
  script creates and closes its own server/browser; it needs the operator's existing Playwright
  installation. No dependencies were installed or modified.
- **Static checks**: `node --check tests/manual/studio-design/preview.js` and
  `git diff --check bbcbbe4 eab7b55` exited 0. Source review found no network, timer, storage,
  HTML-injection or inline-style API added; the restrictive CSP is unchanged.
- **Rendered checks**: 591 checks, 0 failures. Both modes and all six states at 1440 x 900,
  1280 x 720, 1920 x 1080, 390 x 844 and 320 x 640; all sizes are viewport overrides at 100%.
  No page-wide overflow; captured mode never has chat/request fields; exact verdict boundaries,
  disconnected/pending distinction, initial closed menu/Details, stable target wrapper, keyboard
  tabs/resize, drag bounds, collapse/restore focus/status, draft and disclosure retention, request
  bounds, no follow-up composer, all nine gates/ten checks, all evidence states and appended-work
  reading-position/focus preservation passed. Escape closes the native popover and restores focus.
- **Density observation**: the default desktop view has three visible buttons: preview options,
  panel collapse and request send. There is no testing toolbar, status card stack, identifier list,
  or work log in that initial view. This is an observation, not an acceptance criterion or owner approval.
- **Contrast/focus**: 1,228 visible text samples across states/menu/expanded details have minimum
  5.97:1. Composer control border 3.97:1, primary control fill 11.44:1, focus ring 7.39:1 against
  the work background. Preview options, collapse, send and composer show visible keyboard focus.
  These focused measurements are not a complete accessibility audit.
- **Network/errors**: only `/`, `/preview.css` and `/preview.js` were requested; no console or page
  errors. There is no iframe or real verification target.
- **Evidence**: ignored
  `.flowproof/review/005-studio-workspace-ux/eab7b55acbca3a14195218821fd6f80ed0991986/slice1-minimal/`
  contains `checks.json`, `manifest.json`, `verify.mjs` and 24 screenshots including the initial
  desktop, all desktop states, compact ready/results, open menu and expanded technical details.
- **Gaps**: native 200% browser zoom was **not rerun** for this revision; the earlier zoom record
  is historical and cannot be claimed for these changed files. No screen-reader or non-Chromium
  review and no hover-color contrast measurement. The worker did not publish or test a remote
  hosted page. This preview proves no real Studio behavior. The revised owner decision is pending.

Publication and the reviewed source must be recorded by the delivery owner after its independent
review; this record does not claim T007 re-delivery or T008 acceptance for the revision.
