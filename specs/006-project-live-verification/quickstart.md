# Quickstart and Acceptance Guide: Project-Live Mode

**Plan-time status**: This describes validation after authorized implementation. The new CLI flags,
project API, fixture repository, offline runtime and opt-in test project do not exist yet. No command
below was executed to establish feature acceptance during Plan. Existing product tests were not rerun
for documentation-only changes; no model request, key check, Docker build/pull or deployment occurred.

See [Plan](plan.md), [capture/replay contract](contracts/capture-and-replay.md),
[CLI/Studio contract](contracts/cli-and-studio.md) and [model/verification contract](contracts/model-and-verification.md).

## 1. Preconditions for Later Implementation Validation

- Linux with Docker, Node >=24, pnpm and the pinned headed Chromium/Playwright environment available.
  Use the existing XRDP desktop for a human walkthrough; no separate timed observer harness.
- FlowProof dependencies are prepared separately by the developer. This is not permission for
  selected user projects to install packages or run host commands automatically.
- Operator has prepared an immutable `vite-static-v1` image with matching offline dependency/lock
  manifest. Inspect its actual digest and policy; no fake example digest or mutable tag is admitted.
- A separate permitted synthetic/public single-root React/Vite Git repository has a committed
  deterministic DOM bug and safe data, fixed local build output and existing project checks.
  It is outside FlowProof and is not admitted by a hardcoded built-in scenario identifier.
- The sample's source, dependency lock and required check inputs match the prepared profile.
  All required source is committed; ignored original dependencies may exist but are never copied.
- Meta credentials/model access are provided through the established controller environment only.
  Never put the key in the selected project, config, command arguments, screenshots or copied fixtures.
- State/artifacts and temporary roots are outside the selected repository, with owner-only permissions.

## 2. Capture the Original State Without Modifying It

Set task-specific variables to the prepared sample/config/image paths supplied by the implementation
fixture setup. Do not repurpose HOME or use a private/company project for evaluation.

```sh
: "${FLOWPROOF_TEST_PROJECT:?Set the prepared permitted sample repository path}"
: "${FLOWPROOF_PROJECT_CONFIG:?Set the external confirmed JSON config path}"
: "${FLOWPROOF_PROJECT_IMAGE_DIGEST:?Set the real inspected immutable image digest}"

git --no-optional-locks -C "$FLOWPROOF_TEST_PROJECT" -c core.hooksPath=/dev/null -c core.fsmonitor=false rev-parse HEAD
git --no-optional-locks -C "$FLOWPROOF_TEST_PROJECT" -c core.hooksPath=/dev/null -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all
docker image inspect "$FLOWPROOF_PROJECT_IMAGE_DIGEST" --format '{{.Id}}'
```

The variables must be supplied from the actual prepared fixture/operator setup. No example image
hash is fabricated or treated as evidence an image has already been built.
Implementation admission tests additionally snapshot index/refs and seeded tracked/untracked/ignored
files, check no optional-index writes, and compare them after success/failure/cancellation.

## 3. Confirm the Project Configuration

Proposed external JSON shape (strict keys; safe sample only):

```json
{
  "schema_version": 1,
  "category": "vite-static-v1",
  "entry_path": "/",
  "build": {
    "argv": ["node", "/opt/flowproof/toolchain/node_modules/vite/bin/vite.js", "build"],
    "output_directory": "dist"
  },
  "required_project_checks": [
    {"id": "sample-unit", "argv": ["node", "--test", "tests/task.test.mjs"]}
  ]
}
```

The image contains the declared toolchain path and prepared dependency set. Confirmed commands run
only inside the new offline runtime. Config supplies no image/network/mount/model/auth/environment
policy; the host pins those. The profile's mandatory build, replay, evidence, integrity and cleanup
checks cannot be omitted. If a declared check or dependency is unavailable, stop before a model call.

## 4. Run Existing and New Deterministic Checks

After implementation, from the FlowProof checkout with dependencies already prepared:

```sh
pnpm typecheck
pnpm build
pnpm exec vitest run --project unit --project contract --project integration --project ui --fileParallelism=false
pnpm test:e2e
```

Add the project-specific deterministic checks to the appropriate existing projects and retain legacy
regression coverage. The new live protocol test must be excluded explicitly from every default Vitest
project: the current config excludes only the historical Meta smoke. A filename or absent credential
alone is not a safe opt-in boundary. Do not count fake-transport tests as SC-001 live acceptance.

## 5. Opt-In Real Image/Schema Protocol Gate

Only when model execution is explicitly authorized and the synthetic test input/credential environment
is ready, run the planned opt-in test project:

```sh
pnpm exec vitest run --project project-meta-smoke --reporter=verbose
```

This project must be added during implementation; it is not present at Plan time. Send only a tiny
synthetic safe image/text payload to the existing Meta model with strict project analysis output,
`store:false`, no tools and no automatic retries. Require actual image content to reach the provider,
valid structured output, actual response model/response ID and no key/raw response in logs. Check
safe image content is actually interpreted, not merely accepted by the endpoint.

A historical text-only smoke, documentation saying images are supported, nonblank key, or a mocked
response is not this gate. Provider authorization/rate-limit/schema/image failure stays explicit and
blocks live acceptance; do not switch provider or omit the image as an unreported fallback.

## 6. Actual User-Project Flow

The following proposed CLI is runnable only after implementation, using the prepared external repo:

```sh
pnpm flowproof studio --project "$FLOWPROOF_TEST_PROJECT" --project-config "$FLOWPROOF_PROJECT_CONFIG"
```

Expected walkthrough, untimed:

1. Confirm the displayed project root/branch/revision, supported category and startup/check settings.
   Verify no original project code ran before confirmation and no model request occurred.
2. Prepare the isolated target. Confirm it is the actual interactive application, not a screenshot
   or a canned prepared-case animation; original source/index/branch stay unchanged.
3. Start capture and directly reproduce the sample error through normal click/input/scroll/navigation.
   Finish capture. No written action list, executable test, formal assertion or time-limit acknowledgement.
4. Inspect the sanitized captured observations and model transfer scope. Analyze explicitly submits
   safe code/images/actions/errors to the real configured model. Capture alone must not send them.
5. Read AI's observed-problem/derived-replay/expected-behavior interpretation. Answer only a genuinely
   missing-intent question. Do not coach the model with a prepared patch or manually author its test.
6. Verify-and-fix freezes the definition. Observe fresh automatic baseline replay completing actions
   and failing the intended expected condition before any candidate request.
7. Observe the actual second-phase model-generated candidate, isolated application/build/checks and
   replay of the identical definition on the candidate. Require real patch bytes not a fixture lookup.
8. After finalization inspect **Project verification passed** only if every mandatory obligation,
   evidence binding, original integrity and cleanup passes. Inspect before/after images, actual model
   identity, exact diff and available patch. Target disposal does not close the stored result view.
9. Recompare original snapshot and run-owned resources. No auto-apply, commit, PR, merge or deployment.

The sample's intended error and expected behavior may be documented for evaluators, but production
recognition/diagnosis/patch selection cannot key off that fixture's name or embed its expected fix.
Record the actual final commit, permitted sample baseline, profile/image/dependency digests, capture,
model invocation IDs/outcomes, definition/candidate/build hashes and check/evidence outcomes.

## 7. Mandatory Negative Coverage

| Case | Required observation |
| --- | --- |
| Missing/non-Git/dirty/stale/unsupported project or wrong lock/image | actionable blocker before commands/model; no install or original writes |
| Startup/build failure or target unavailable | operational failure, not a reproduced defect |
| Empty/discarded/incomplete/overflow/unsupported-action capture | no complete-report claim; no invented actions or automatic patch request |
| Navigation/input flush, wrong frame/origin/epoch, duplicate Finish | ordered host-bound data; mismatches rejected; sealed digest stable |
| Secret in input/selector/error/screen and unrelated desktop content | excluded/masked before retention/submission; no raw trace/image leakage |
| Ambiguous intended result / insufficient evidence | focused clarification or unsupported outcome, not a handwritten-test requirement |
| Baseline already satisfies check / locator or replay timeout | not reproduced or replay failure; correction not requested |
| Missing key, real provider rejection/timeout/image/schema/identity mismatch | truthful model failure; no fixture/provider fallback or hidden retry |
| Empty/invalid/out-of-scope/secret-bearing patch | reject before apply; no silent guard weakening |
| Candidate changes config/test/check/source during execution | frozen/input-integrity failure; no pass |
| Candidate build/project check/replay fails | failed required check with reason and actual partial evidence |
| Wrong-run/build/capture evidence or unavailable required collector | unverified evidence; not a pass |
| Close/cancel during capture finish/model/build/replay; late completion | sticky cancellation, bounded cleanup, no late success |
| Target external/Studio/private-network request, websocket/worker/popup | denied by target/browser policy; UI remains available |
| Cleanup/original integrity cannot be confirmed | non-success regardless of earlier functional pass |
| Legacy/captured prepared examples | original actions/verdicts unchanged; never relabelled user-project live work |

Use test-first focused cases for parser/path/authority/race logic; use containers and headed browser
checks for actual process/network/frame/privacy behavior. Default fakes are allowed only as labelled
negative/contract infrastructure. Every success criterion SC-001 through SC-010 needs its own actual
record at acceptance, with unexecuted items explicitly open rather than marked passed.

## 8. Review and Handoff

Owner walkthrough records understanding/confusion freely, without a stopwatch, scripted test-entry
form, automatic window closure or fabricated usability measurement. Results are limited to declared
reproduction/checks. Manual patch use is outside the app for this feature. Tasks must convert these
obligations into bounded implementation/test units without authorizing live calls, extra services,
new network scope, arbitrary project support, publication or deployment implicitly.
