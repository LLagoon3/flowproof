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
