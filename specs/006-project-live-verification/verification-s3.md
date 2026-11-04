# Verification: Spec 006 — S3 Safe Demonstration Capture Module

**Scope:** S3 only — T021, T022, T024, T025 (`projectPrivacy.ts`, `projectRecorder.ts` and the S3
contract/unit/Chromium tests). T026 and production capture/orchestration remain S6. This is module
evidence on controlled synthetic target frames, **not** a selected-project acceptance run. No project
admission, offline runtime, Studio server, provider/model, PR, push, merge or deployment is involved.

**Baseline:** merged S1 `2b1155fd6c949afa62c7710d1353d7a06d87f6ef`. Original recovered S3 commits:
`f9a59ee` (privacy), `402db2c` (recorder), `cd1db24` (pixel tests), `504858d` (original evidence/task
marks). Independent-review fixes: `d25cc4f` (reflected values, URL metadata, sanitized digest and visual
surfaces) and `c56803e` (CSS list image fail-closed). The final implementation checks below ran against
`c56803e14023595febeb4da79a75f43b118a3a86`; this evidence file is committed separately. Only S3's two
capture modules and three tests changed in the implementation follow-up. The four S3 task marks remain
checked; T026 remains open.

## Review findings recovered and corrected

- A refused short sensitive value such as a 3-character PIN was redacted from the action but not entered
  in the reflection registry (`MIN_REFLECTED_VALUE_LENGTH`), so it could still appear in a locator,
  error or URL. Red/green: `independent-short-secret-red.log`,
  `independent-short-capture-red.log`, `independent-focused-final.log`. Short non-empty refused values
  now set a privacy-unverified registry state without hashing/storing the value. The capture becomes
  `unsupported` (`PRIVACY_REGISTRY_LIMIT`); affected actions are not staged, metadata is wholly redacted,
  source/images fail closed, and any raced PNG is zeroed before retention. Empty values do not taint.
- ASCII-case-changed, percent-encoded and form-style `+` reflections could bypass exact matching. Rolling
  fingerprints now ASCII-case-fold; registry lookups inspect up to two percent-decoding rounds and
  form-space variants. Encoded metadata is dropped whole when it cannot be safely spliced. Regression
  logs: `independent-privacy-red.log`, `independent-plus-encoding-red.log`,
  `independent-focused-final.log`.
- URL admission accepted recognizable private data under ordinary query keys (e.g. email, PIN, phone,
  username, card), generic keys with email/long-number shapes, semicolon-separated query parameters,
  and sensitive matrix parameters in paths. New tests first reproduced these (`independent-sensitive-url-red.log`,
  `independent-semicolon-url-red.log`, `independent-matrix-url-red.log`); sanitizer now rejects them.
  Percent escapes remain unsupported by the S1 path/query grammar. Navigation consistency hashes now
  use only the sanitized `{target_origin, path}`; rejected raw URLs are not hashed.
- Default screenshot masks previously covered only data/blob `<img>` URLs and not SVG. A real Chromium
  control showed non-data image and inline-SVG green pixels survived (red: `independent-surface-red.log`).
  Default masking now covers every `<img>` and `<svg>`; the S3 pixel test checks both remote SVG-backed
  `<img>` and inline SVG.
- Visible CSS-generated pseudo text reflecting an input was retained before post-capture assessment
  (red: `independent-pseudo-leak-red.log`). Visible `::before`, `::after`, and `::marker` content and
  referenced attributes are assessed; unrecognized generated functions fail closed. CSS background,
  list-style and border image URLs are also uninspectable and omit the image while marking the capture unsupported.
  The list-style leak was independently reproduced as a `ready` capture with image bytes
  (`independent-list-image-red.log`); fixed and green in `independent-list-image-green.log`.
- The 24px Studio hit-test grid missed a tiny visual overlay between samples (red:
  `independent-overlay-red.log`). Geometry now conservatively rejects a visible Studio element whose
  bounding box overlaps the target content, including `pointer-events:none` overlays. This is fail-closed
  and can conservatively classify a behind-frame overlap as unavailable evidence.

## Module guarantees and limits

- Target authority remains bound to host frame identity and exact target origin. Host document tokens,
  epochs and monotonic event numbers reject stale/foreign/out-of-order events; host assigns action
  sequence and UUIDs. Pending action/scroll ordering flushes at navigation and after Finish's drain.
- Supported interactions are click, policy-admitted/redacted fill, native single-select, coalesced
  page/element scroll and sanitized same-origin navigation. Drag/drop, file upload, canvas gestures,
  shortcuts, contenteditable edits, multiple select, popup/download and unsafe navigation are explicit
  unsupported outcomes, not invented actions. Pending input is flushed in its own epoch before
  navigation and at Finish after the ordered drain round trip.
- Existing S1 schemas, limits and completeness rules are unchanged: 200 actions, 256 observations,
  64 KiB error summaries, 16 images (one sampling disclosure, at most 13 action images, plus start/end),
  1 MiB per PNG and 20 MiB staged. Action/observation/byte overflow is named and cannot silently yield
  `ready`; image sampling omissions are disclosed. Absent/unavailable collectors remain explicit.
  Finish is idempotent with one stable report digest. Discard before Analyze invalidates in-flight image
  work and zeroes staged PNG buffers; re-record gets a new capture identity. The 5 s drain, 30 s entry
  reset, 5 s new-document image wait and 10 s screenshot bounds are automatic-operation limits, not a
  human recording deadline.
- Input, editable, configured/private regions, nested frames/object/embed, and by default canvas, video,
  all images and SVG are masked during target-only PNG production. DOM text, open shadow roots, reflected
  values, generated pseudo text, and URL-backed CSS background/list/border imagery are assessed before
  the PNG digest is retained. Studio/desktop pixels, trace, video, HAR, cookies, storage, headers and
  bodies are not collected.
- **Not guaranteed:** arbitrary text painted into an explicitly admitted opaque surface, unmarked pixels
  in custom graphics, closed shadow roots, browser/target misrepresentation, or arbitrary rendering
  mechanisms outside the inspected DOM/CSS image properties. Known-rule surfaces that cannot be inspected fail closed;
  this is not a general-purpose OCR or hostile-page proof. Refused values shorter than four characters are
  not fingerprinted: their use makes the capture privacy-unverified/unsupported instead of retaining them.
  Source evidence is not used by this module to infer or restore a refused action value.

## Validation evidence

All new logs are in Git-ignored `.flowproof/task-logs/006-project-live-verification/s3/`. The original
`validated-files.sha`, original focused/full-suite counts and mutation runs below are **historical evidence
for the recovered `504858d` implementation**, not a claim that those counts were rerun on the follow-up.
`independent-validated-files.sha` binds the final implementation files to the follow-up checks.

| Check | Result | Log |
| --- | --- | --- |
| Focused S3 unit + capture contract tests, final implementation | 2 files, 61/61 (28 unit, 33 contract), 0 skipped | `independent-focused-final.log` |
| Actual headed Chromium 1248 under Xvfb, final privacy suite | `project-privacy.spec.ts`, 8/8, 0 skipped; includes seeded pixel controls, URL-backed image/SVG, pseudo text, CSS background/list image, tiny Studio overlay, short PIN, discard/re-record | `independent-privacy-e2e-final.log` |
| Existing capture integration regressions | 2 files, 10/10, 0 skipped | `independent-capture-regression-final.log` |
| Workspace `pnpm typecheck` | passed (root plus all 3 workspace packages) | `independent-typecheck-final.log` |
| Workspace `pnpm build` | passed | `independent-build-final.log` |
| `git diff --check` | clean | command result; no diff output |
| Prior S3 focused suite at `504858d` | 56/56 | `focused-final.log`, `commitB-focused.log` |
| Prior default unit+contract suite at `504858d` | 36 files, 1165/1165, 0 skipped | `unit-contract.log` |
| Prior mutation checks at `504858d` | 17/17 killed; sources restored/hash-checked | `mutation-results.json`, `mutation-results-2.json` |

The main pixel test embeds the target at `localhost:43161` in a Studio-like page at `127.0.0.1:43160`.
Its in-memory unmasked control proves all 13 seeded surfaces render; retained 800×600 PNGs are decoded
and checked for zero green secret pixels, zero Studio red/yellow pixels, public blue content, and >98%
mask fill inside each seeded region. Marker-byte scans are supplementary only. Coverage includes private
input/editable regions, canvas, data-image, non-data remote `<img>`, inline SVG, iframe content and the
Studio region. CSS pseudo/list/background controls independently prove their seed pixels render before
asserting evidence is omitted or masked. No source files or captured image bytes are printed in logs.

## Cleanup and unrun scope

The Chromium suite closes its contexts, browser and synthetic HTTP servers in `afterEach`/`afterAll`;
Xvfb exits with each command. No Docker/container or image work was used. Port checks and final Git state
are recorded by the completion report. The full 1165-test workspace suite and selected-project/live
acceptance were not rerun; integration/order races T026, production workflow, model/provider, S5+, and
S6 remain outside this slice by design.


## Source-parent independent verification

The source parent independently reviewed the final correction diff at `9eba3a0eed115493b03f3657bc7821f379d3a9d5`
(implementation unchanged from `c56803e`) after the recovery writer settled. Under the exact shared
`/tmp/flowproof-spec006-heavy.lock` lease, the parent reran workspace typecheck and build, the two-file
S3 focused suite (**61/61**, no skips), the actual headed Chromium privacy suite (**8/8**, no skips),
and the existing browser-capture/probe-install-order integration regressions (**10/10**, no skips).
Logs are ignored under `.flowproof/task-logs/006-project-live-verification/parent-final/`.

A separate direct-built-module probe, not the S3 test helpers or their in-process recorder fake,
passed **40 assertions**: refused 1/2/3-character values cannot appear in locators, errors, navigation,
source or assessed screenshots; clearing the registry restores a valid public control; case-changed,
percent/double-percent/form-encoded reflections are refused; sensitive query and matrix parameters
are rejected. This probe verifies sanitizer APIs, not a browser capture or provider submission.
The Chromium suite supplies the separate real rendered-pixel evidence.

The parent verified the exact four supported task marks, all 55 unchanged task definitions, and an
unchanged requirements-quality checklist. Reserved ports were free after the owned tests. No model,
selected-project acceptance, production integration or publication is claimed. S2/S4 results remain
in their separate authorized worktrees rather than being silently combined here.
