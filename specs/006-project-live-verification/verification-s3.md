# Verification: Spec 006 — S3 Safe Demonstration Capture Module

**Scope**: S3 only — T021, T022, T024, T025 (`capture/projectPrivacy.ts`, `capture/projectRecorder.ts`
and their tests). Module evidence on controlled synthetic target frames. It is **not** a selected-project
acceptance run: no project admission, offline runtime, Studio server, orchestrator or model is involved;
production target integration and navigation/Finish/Discard races in the real flow remain T026 (S6).
No provider call, push, PR, review, merge or deployment was made. Parent reconciles marks/evidence.

**Branch / baseline**: `feat/006-project-live-verification-capture`, clean merged S1 main
`2b1155fd6c949afa62c7710d1353d7a06d87f6ef`. Code commits `f9a59ee` (privacy + unit test), `402db2c`
(recorder + contract test), `cd1db24` (Chromium pixel spec). Logs in the Git-ignored
`.flowproof/task-logs/006-project-live-verification/s3/`; `validated-files.sha` binds them to the five
committed files (identical bytes at `cd1db24`).

## What the module guarantees (and does not)

- **Authority**: only the admitted target frame (host frame identity from Playwright's binding source)
  and exact target origin are collected; foreign frames are rejected without data, nested-frame
  interaction is `unsupported`. Host-tracked document tokens/epochs reject stale, unknown, duplicate,
  out-of-order and gapped callbacks as explicit loss. The host assigns UUIDs and a contiguous sequence.
- **Actions**: click, safe fill (coalesced), native single select, coalesced page/element scroll and
  same-origin navigation (same-document and new-document). Pending input is flushed in its own epoch
  before navigation and at Finish (after an ordered drain round trip). Drag/drop, uploads, canvas
  gestures, shortcuts, Escape/unhandled Enter, contenteditable edits, multiple select, popups,
  downloads, cross-origin/credentialed/secret-query navigation are `unsupported`, never fake actions.
- **Limits / lifecycle**: exact S1 states, transitions, limits and schemas (`parseDemonstrationCapture`
  on every sealed report). 200 actions, 256 observations, 64 KiB error text, 1 MiB/image and 20 MiB
  staged; crossing one keeps recording but can only finish `incomplete` with the named reason. Images
  are sampled within 16 (start, end, ≤13 action images, one disclosed `IMAGE_SAMPLING_LIMIT` omission).
  Ready means zero dropped/unsupported; absent collectors are `unavailable` observations. Finish is
  idempotent with one digest (`projectDigest(capture with seal null)`); Discard (recording/finishing/
  ready, before `claimForAnalysis`) zeroes staged PNG bytes and wins over an in-flight Finish.
  No timer drives a human capture; the only bounds are automatic (5 s drain, 30 s entry reset, 5 s
  new-document load before its image, 10 s screenshot).
- **Privacy before staging**: values are admitted only by host policy (default none) and never from
  sensitive types/autocomplete/names/labels or sensitive value shapes; non-admitted values are kept
  only as keyed in-memory rolling fingerprints to remove reflections from names, selectors, URLs and
  error text. Locators/URLs/errors/source are sanitized to S1 shapes; unsafe candidates are dropped,
  not truncated. Retained PNGs are produced by Chromium, clipped to the target frame content box, with
  Playwright masks over inputs, textarea, select, contenteditable, nested frames/object/embed,
  `[data-flowproof-private]`, configured private selectors (with descendants) and, by default,
  canvas/video/data-blob images, plus a no-text-paint stylesheet. Rendered secret-shaped or reflected
  text makes the image `omitted`/`unsupported`; occlusion by Studio content or unstable masks omit it.
  No trace, video, HAR, cookies, storage, headers, bodies or Studio/desktop pixels are collected.
- **Not guaranteed**: arbitrary unmarked sensitive pixels (e.g. secrets drawn on an admitted canvas),
  CSS pseudo-content, closed shadow roots, case-changed reflections and values shorter than 4 chars;
  a hostile page can forge its own DOM descriptions and recorder envelopes (only frame/origin/epoch
  authority is host-derived). Essential-evidence judgement over disclosed masks/omissions is left to
  analysis (S5/S6), as is rejecting replay that needs a redacted value.

## Evidence

| Check | Result | Log |
| --- | --- | --- |
| Red before implementation | both focused files fail to load (modules absent) | `red.log` |
| Contract + unit (focused, serial) | 2 files, 56/56 (32 contract, 24 unit) | `focused-final.log`, `commitB-focused.log` |
| Intermediate commit `f9a59ee` unit file | 24/24 | `commitA-unit.log` |
| Guard mutations (17: frame authority, stale epoch, strict envelope, nav flush, lossy ready, image budget, duplicate Finish, Discard race, action cap, discard wipe, remember redacted, private names, secret query key, over-long omission, private descendants, sensitive field, rendered reflection) | each killed (≥1 failing test); sources restored, hash-checked | `mutation-results.json`, `mutation-results-2.json` |
| Actual headed Chromium 1248 (xvfb), `tests/e2e/project-privacy.spec.ts` | 3/3; `--repeat-each=3` 9/9 | `e2e-5.log`, `e2e-repeat.log` |
| Pixel red: masks+style removed / opaque admitted / private descendants unmasked | each fails on decoded pixels; restored | `e2e-mutant-*.log` |
| `pnpm typecheck`, `pnpm build` | passed | `typecheck-final.log`, `build.log` |
| Default `--project unit --project contract` (includes new files) | 36 files, 1165/1165, 0 skipped | `unit-contract.log` |
| Existing capture regression `browser-capture`, `probe-install-order` (Chromium) | 2 files, 10/10 | `capture-regression.log` |
| `git diff --check` | clean | — |

Pixel test: a Studio-like page (`127.0.0.1:43160`, yellow, red iframe border, green Studio seed) embeds
the synthetic target (`localhost:43161`) cross-origin. Eleven seeded surfaces render pure green; an
in-memory unmasked control proves each renders (>8 green px) and the Studio seed/border render. Every
retained image: 800×600, zero green, zero Studio red/yellow, >150 public-blue px; the image tied to the
Add click has each seeded region ≥98% exact mask colour. A reflected redacted value, Studio overlay,
canvas drag and contenteditable edit are explicit; a same-origin decoy frame and Studio clicks are absent.

Found and fixed during E2E: Playwright's screenshot `style` also applies to the embedding document, so an
`iframe { visibility: hidden }` rule hid the target itself (all-yellow "masked" image); the rule was
removed. Test-driver only: a recorder screenshot overlapping Playwright's own click-point computation
for this out-of-process frame occasionally lands 64 px off and is retried; the spec paces pointer
actions on `imagesSettled()` (keyboard input still overlaps screenshots). Human input has no such step.

Cleanup: servers closed, browser/contexts closed, ports 43160–43169 free, no containers or images used,
temporary copies moved out of the worktree; checkout clean except committed files.
