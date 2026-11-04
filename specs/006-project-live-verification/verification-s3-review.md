# S3 PR28 review round 1 — privacy corrections

Scope: three P1 review findings in `projectPrivacy.ts` / `projectRecorder.ts`. Base `4c904d4`, fix commit `272b8d9`. Synthetic values only; no provider, push or deployment.

| Finding | Fix | Regression |
| --- | --- | --- |
| `renderedText` walked from `body` with `TreeWalker.nextNode`, so html/body computed url images and body pseudo content were never assessed | html and body are assessed unconditionally (url backgrounds, list/border images, ::before/::after/::marker) and the walk starts at the document element; body shadow roots are now visited | 4 headed Chromium cases (html url background, body url background, body::before and body::after secret-shaped text); each has a passing real-pixel control |
| `#network` path used only `entryPathSchema` + registry, so `/reset;token=synthetic-private-value` was retained and hashed | shared exported `navigationPathSensitive` (registry, value shape, sensitive path parameters) used by `sanitizeNavigation` and `#network` before retaining/hashing; omission keeps `NETWORK_PATH_UNSAFE` | headed Chromium: sensitive path omitted, safe `/missing.json` 404 still retained, value absent from capture JSON; unit helper test |
| `admitText` redacted a null (over 4096 chars, unreadable) value without tainting the registry | `RedactedValueRegistry.markUnverified()`; null value keeps `VALUE_TOO_LONG` and fails closed (`PRIVACY_REGISTRY_LIMIT`, later images `IMAGE_TEXT_UNVERIFIED`) without remembering anything | headed Chromium oversized reflection with real-pixel control; unit fill and select tests |

## Results (logs in ignored `.flowproof/task-logs/006-project-live-verification/s3-review1/`)

| Check | Result | Log |
| --- | --- | --- |
| Red before fix, new unit tests | 2 failed / 28 passed (30) | `red-unit.log` |
| Red before fix, new headed e2e (Chromium under Xvfb) | 6/6 failed: root cases sealed `incomplete` with images retained, network observations retained with path, oversized capture `ready` | `red-e2e.log` |
| Workspace `pnpm typecheck` | passed | `green-typecheck.log` |
| Workspace `pnpm build` | passed | `green-build.log` |
| `vitest --project unit --project contract` | 36 files, 1172/1172, 0 skipped | `green-unit-contract.log` |
| Headed Chromium `project-privacy.spec.ts` | 14/14 (8 existing + 6 new), 0 skipped | `green-e2e.log` |

All heavy steps ran under `flock -w 1800 /tmp/flowproof-spec006-heavy.lock` on owned ports 43160-43161.

## Gaps

- The red oversized and root cases failed at the first state assertion. Their pixel assertions were not reached before the fix; leaking pixels are shown by the passing Chromium controls, not by a red pixel assertion.
- Pseudo content on `html` is now assessed, but no Chromium regression covers it. Integration, UI and the full e2e suite were not rerun in this unit.
- Review threads, independent check, push and merge stay with the parent.

## Independent source-parent validation

The parent inspected the complete correction diff, then refreshed this branch with merged S4/main
in `58ee37d44c477bfedc95ee618d9633eea2f07397`. Under the exact shared heavy lock, the parent independently
passed workspace typecheck/build, three capture/privacy/replay test files (143 passed, five explicit
opt-in replay Chromium skips), and all 14 headed `project-privacy.spec.ts` tests without skips. The
previous independent 40-assertion built-module privacy probe also passed on the corrected build.

A separate 18-assertion built-module/real Chromium probe confirmed null fill/select values taint the
registry without storing a value, sensitive failed-request paths are refused with a public-path
control, and a real rendered `html::before` sensitive-text case is refused before retention while a
public page produces an image. This additional case checks the rendered computed pseudo content and
a control screenshot, not OCR or a separate pixel-decoding oracle; the headed suite supplies the
pixel-level root/body/reflection evidence. The parent probe closes the previously untested HTML
pseudo execution path but does not claim general hostile-renderer privacy.

Parent logs: ignored `.flowproof/task-logs/006-project-live-verification/pr28-parent/` (typecheck,
build, focused, chromium, probe and additional-probe). The parent-only probe server and browser were
closed in `finally`; no original repository, provider, deployment or sibling container was used.
`git diff --check origin/main..HEAD` passed. Hosted updated-HEAD CI and the second Codex review remain
separate, pending checks before merge.

# S3 PR28 review round 2 — paintable-surface corrections

Scope: review threads 4473364097 and 4473364109, both in `renderedText` (`projectPrivacy.ts`). Base `2cacfc0`, fix commit `6a3ced4`. Synthetic values only; no provider, push or deployment.

Shared cause: visibility and content shortcuts ran before every paintable surface had been assessed, and box visibility (`checkVisibility`) stood in for paint visibility.

| Finding | Fix | Regression (headed Chromium, real-pixel control first) |
| --- | --- | --- |
| `appendPseudo` returned on empty content before checking the pseudo's own `url()` images | url image properties of every pseudo are checked before any visibility or content return | empty-content `::before` 200x40 url background; text `::after` with url background |
| `parent.checkVisibility()` is false for a `display: contents` parent, so its painted bare text was skipped | a node's content paints unless it has no layout (box ancestor `checkVisibility()` false) or a box ancestor has opacity 0; text uses its parent's computed visibility; `display: contents` elements skip only their own box images; the html/body root checks are unchanged | wrapper bare text; wrapper `::before` text; a refused password reflected into a wrapper; plus a visible `::before` in a `visibility: hidden` element and bare text directly in an open shadow root (same predicate) |

Guard: a page with `display: none`, `visibility: hidden` and opacity-0 hidden text, plus head style/script text and body script text, still seals `ready` with images retained and no seed in the capture.

## Round 2 results (logs in ignored `.flowproof/task-logs/006-project-live-verification/s3-review2/`)

| Check | Result | Log |
| --- | --- | --- |
| Red before fix, 8 new headed tests | 7 failed (6 sealed `ready` with images retained, the reflection case had no `IMAGE_SENSITIVE_TEXT`), every pixel control passed; the hidden-text guard passed | `red-e2e.log` |
| Workspace `pnpm typecheck` / `pnpm build` | passed / passed | `green-typecheck.log`, `green-build.log` |
| `vitest --project unit --project contract` | 37 files, 1252 passed, 5 skipped (existing opt-in `runIf(CHROMIUM)` replay tests in `project-replay.test.ts`) | `green-unit-contract.log` |
| Headed Chromium `project-privacy.spec.ts` | 22/22 (the 14 earlier tests + 8 new), 0 skipped | `green-e2e.log` |

All heavy steps ran under `flock -w 1800 /tmp/flowproof-spec006-heavy.lock` on owned ports 43160-43161.

## Round 2 gaps

- This round did not assess these surfaces: closed shadow roots (not readable from page script), `::backdrop`, `::first-line`/`::first-letter` backgrounds, and url values in `mask-image`, `filter` or `-webkit-box-reflect`.
- Pseudo url checks now fail closed even when the pseudo is hidden or not generated (`content: none`), and for inherited `list-style-image` in hidden subtrees. These are deliberate false positives.
- Integration, UI and the full e2e suite were not rerun in this unit.

# S3 PR28 parent correction before review 3 — URL image surfaces

Scope: the parent's pre-publication probe (`pr28-parent-r2/surface-probe.mjs`) showed retained unmasked synthetic pixels for `::first-letter` (2046), `::first-line` (1878) and a modal `::backdrop` (11594), all `ok=true`. These were listed as gaps in round 2. They are the same fail-closed image-surface boundary, so they are fixed here rather than accepted. Base `76b5696`, fix commit `2d1e821`. Synthetic values only.

Fix (`renderedText`, shared): one computed-property list now carries every URL-bearing image property checked on each element and every pseudo surface: background, list-style and border images, `mask-image`, `-webkit-mask-image`, `-webkit-mask-box-image-source`, `filter`, `backdrop-filter`, `-webkit-box-reflect`, `clip-path` and `content`. Any `url(` fails closed as `IMAGE_TEXT_UNVERIFIED`. `::first-line` and `::first-letter` join `::before`/`::after`/`::marker`. `::backdrop` is checked for every element, masked or not, and for html/body, because a top-layer backdrop paints outside its element's mask.

## Results (logs in ignored `.flowproof/task-logs/006-project-live-verification/s3-parent-r2/`)

| Check | Result | Log |
| --- | --- | --- |
| Red before fix, 10 new headed tests | 10/10 failed: each sealed `incomplete` with its start image retained. The 6 pixel controls passed first: `::first-letter`, `::first-line`, modal `::backdrop`, masked-modal `::backdrop`, text-shaped `mask-image` and element `content: url()`. The `filter`, `backdrop-filter`, `-webkit-box-reflect` and `clip-path` cases are URL-only, with no pixel leak shown | `red-e2e.log` |
| Workspace `pnpm typecheck` / `pnpm build` | passed / passed | `green-typecheck.log`, `green-build.log` |
| `vitest --project unit --project contract` | 37 files, 1252 passed, 5 skipped (existing opt-in `runIf(CHROMIUM)` replay tests) | `green-unit-contract.log` |
| Headed Chromium `project-privacy.spec.ts` | 32/32 (the 22 earlier tests + 10 new), 0 skipped | `green-e2e.log` |
| Parent probe rerun against the new build (read-only, own output) | first-letter, first-line, backdrop and filter now `ok=false IMAGE_TEXT_UNVERIFIED` with 0 retained; public and hidden controls still `ok=true`; contents and empty-pseudo unchanged `ok=false` | `parent-probe-rerun.json` |

Heavy steps ran under `flock -w 1800 /tmp/flowproof-spec006-heavy.lock`. The e2e tests used owned ports 43160-43161; the probe used an OS-assigned loopback port that it closed.

## Remaining limits (not a universal privacy guarantee)

- Closed shadow roots cannot be inspected from page script, so text or images inside them are not assessed. That would need browser-level DOM access and stays an open threat.
- The property and pseudo lists are an explicit enumeration of known URL-bearing paint surfaces in current Chromium. A property outside the list is not inspected.
- The URL checks deliberately fail closed for surfaces that may not paint: hidden or ungenerated pseudos, a `::backdrop` rule with no open modal, `clip-path: url(#local)` and inherited `list-style-image`. This can mark some safe pages unsupported.
- Integration, UI and the full e2e suite were not rerun in this unit.

## Independent parent verification of the combined round-2 correction

The parent inspected the complete changes from `2cacfc0` through `ca787b9`, including the shared
visibility logic and additional URL-bearing paint surfaces. Under the exact heavy lock, workspace
`pnpm typecheck` and `pnpm build` passed; privacy/capture/replay focused checks passed **143 tests**
with **5 existing opt-in replay skips**. Actual headed Chromium privacy checks passed **32/32**.
The parent independently reran its original actual-Chromium surface probe against the built module
and asserted all eight outcomes, public/hidden positive controls, the three previously reproduced
first-letter/first-line/backdrop pixel controls, and zero retained unsafe pixels. No provider calls
or universal hostile-page privacy claim is made. Closed-shadow/explicit enumeration limits above
remain disclosed within the admitted synthetic/local-app boundary.

Logs: ignored `.flowproof/task-logs/006-project-live-verification/pr28-parent-r3/`. The probe's server
and browser close in `finally`; no raw screenshot is retained. Updated-HEAD hosted CI and third
Codex review remain independent pending gates. The earlier CI success covers `2cacfc0` only.
