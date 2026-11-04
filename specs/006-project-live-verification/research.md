# Research: User Project Onboarding and Live AI Fix Verification

**Date**: 2026-11-04 | **Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## Research Method and Boundaries

Read repository code/contracts and existing feature designs; perform two bounded read-only research
investigations for capture/runtime and model/verification; fetch the official public Meta documentation
listed below. No application command, Docker image build/pull, credential file, model call, product
benchmark or feature test was run. Decisions are a proposed design; capability gates remain later
execution obligations, not undocumented assumptions that something already works.

## Decision 1 — Add a distinct project-live mode

**Decision**: Introduce an additive CLI/Studio/engine mode for an admitted user project. Do not make
the legacy prepared `Scenario` contract universal or fake a Spec 003 capture result for this mode.

**Rationale / evidence**: `packages/flowproof/src/cli.ts` exposes only `studio [--scenario]` and
loads a committed scenario before launch. `studio/server.ts` has separate legacy and captured modes;
`apps/studio/src/api.ts` and `state.ts` have disjoint result families. Existing captured mode purposely
blocks editing/chat and is not a user-project recording session. `contracts/schemas.ts` restricts the
prepared action and chart/dataset observations. `TargetPane.tsx` assumes a prepared target URL.

**Alternatives**: Broadening the legacy schema would silently alter old claims and attack surfaces.
A separate product/service would duplicate Studio, storage and lifecycle without present value.

## Decision 2 — One offline static client category, no host project execution

**Decision**: `vite-static-v1`: a single-package React/Vite static client with prepared matching
dependencies, fixed build-output policy and confirmed direct-argv build/project checks. Node 24+
and the current dependency family are retained. Resolve actual immutable image/dependency hashes
as implementation prerequisites; reject missing/mismatched resources without install or pull.

**Rationale / evidence**: Current packages pin React 19.3.1, Vite 8.3.5, Node >=24 and Playwright 1.64.1.
`worktree/session.ts` links installed dependencies and runs host builds with host HOME/cache access;
`verify/capturedRun.ts` executes a prepared functional check on the host. These are not acceptable
unchanged for arbitrary selected source. `editing/dockerCli.ts` offers useful non-root/read-only-root/
resource safeguards but uses bridge networking. A static artifact lets the build/check runtime use
`--network=none` while the controller serves copied static bytes.

**Alternatives**: A universal dev-server runner needs process, network, service, authentication and
dependency semantics beyond this feature. A plain static-HTML-only profile is smaller but unnecessarily
fails the current client-app use case. Running `npm install` or host `npm run dev` after a directory
selection grants permissions the user has not confirmed and undermines original/credential isolation.

## Decision 3 — Export a scrubbed committed tree, not the original checkout or Git history

**Decision**: Read and admit HEAD content, export approved regular files to a new owned snapshot,
and retain private Git/application/frozen-check metadata outside the runtime mount. Never mount the
original checkout, its ignored dependencies, `.git`, source history or host credential/config paths.

**Rationale / evidence**: `editing/workspace.ts` creates a standalone clone that still contains Git
objects/history. Merely removing remotes does not remove historical excluded secrets. Existing
`git/repositoryState.ts`, no-optional-lock Git helpers and private-index application in
`worktree/capturedCandidate.ts` provide integrity/ownership patterns, not complete new admission.

**Alternatives**: A linked worktree shares original Git metadata. A complete clone can expose excluded
history. Both are avoidable for a source snapshot with private host-only patch bookkeeping.

## Decision 4 — Record the developer's actual target interaction

**Decision**: Launcher-owned Playwright instrumentation records only the actual admitted target
frame: clicks, safe fills/native selections, scrolls, same-origin navigation, and safe visual/error
observations. Start/Finish/Discard are explicit; staged data is sanitized before memory retention,
Finish seals it, and Analyze explicitly permits model submission. No manual test or step list is needed.

**Rationale / evidence**: `capture/browserCapture.ts` currently executes the committed prepared select;
it is not a user recorder. `studio/launch.ts` already owns the headed context and actual mounted
frame. Target-bound Playwright binding callbacks can validate frame/origin identity; arbitrary
`window.postMessage` or browser API upload bodies cannot establish recorder authority. Sequence epochs,
input/scroll coalescing and Finish draining must handle navigation and queued events explicitly.

**Alternatives**: Text-only report entry contradicts the owner's clarification. Raw Playwright
trace/video/HAR captures overly broad data before filtering. General desktop capture is unnecessary.

## Decision 5 — Extend the existing real Meta path with actual image inputs

**Decision**: Keep `muse-spark-1.3` on the established Meta Responses endpoint and host-only
`MODEL_API_KEY` boundary. Add project-specific multimodal analysis and text patch schemas using
existing SDK mechanics. Ordinary flow has one analysis and one correction call, no automatic retry;
one extra analysis is allowed only after the user explicitly answers a clarification.

**Rationale / evidence**: `model/metaClient.ts` already uses `https://api.meta.ai/v1`, a pinned model,
`store:false`, strict output, `maxRetries:0`, no tools, explicit headers, redirect refusal and sanitized
metrics/errors. Current `model/prompt.ts` and JSON-string wire input are text-only, one-source-file
contracts; screenshot manifests are not image inputs. Official image documentation explicitly shows
`muse-spark-1.3` with typed `input_image` blocks and base64 data URLs; no public image hosting/upload
is necessary. New inputs must actually include the safe bytes, not simply an Evidence ID.

**Alternatives**: An authenticated sandbox CLI agent needs a new credential/tool/egress boundary.
Changing providers introduces an unnecessary account/service commitment. Always-on tool loops and
server-managed history are not required for one derived obligation and one candidate.

**Implementation gate**: The current account's image + strict-output exchange is untested here.
Existing `checkMetaReadiness` only detects a nonblank environment value, not quota/authorization or
image capability. The opt-in protocol check and full live project run must pass later; do not fall
back to text-only evidence or fixtures when they fail.

## Decision 6 — Let AI derive a small replay/check language, not executable tests

**Decision**: Analyze actions/images/errors and admitted code into a closed `ready|clarify|unsupported`
interpretation. Compile allowlisted actions/locators and DOM/URL/error expectations in the host.
Show the human-readable interpretation and resolve unclear intent. Freeze its digest before editing.

**Rationale**: The user demonstrates the error; forcing hand-authored replay code loses the product
value. Executing generated JavaScript, Playwright code or shell also lets the model redefine its own
success criteria and expands authority. An interpreter can reject unknown operations, cross-origin
URLs, ambiguous selectors, weak/missing checks and out-of-capture evidence references synchronously.

**Alternatives**: General natural-language-to-arbitrary-test generation or a full browser tool agent
would add unsupported operations and a much larger execution surface. A fixed canned scenario would
not be a real selected-project workflow. Fully automatic intent inference cannot distinguish every
intended vs accidental behavior, so targeted clarification remains necessary when uncertainty exists.

## Decision 7 — Independently reproduce first, then request a bounded multi-file patch

**Decision**: Fresh baseline replay must complete its actions and fail the declared expected condition
for the intended reason. Only then request one candidate. Accept at most eight existing UTF-8 `src/`
files and 64 KiB patch, protecting config/dependency/test/check definitions and all modes/paths.
Apply to a new snapshot with private Git metadata and independently replay the same frozen obligation.

**Rationale / evidence**: `patch/validateDiff.ts` is deliberately one existing file/20,000 bytes;
`contracts/schemas.ts` and prompt restrict legacy source cardinality. Do not silently broaden them.
Spec 003 binary/symlink/gitlink capture permission is not a suitable model-edit grant. New bounded
text changes meet real project needs without installing an unrestricted agent. Existing captured
verification freezes trusted checker digests, but its oracle and chart probe are prepared-case-only.

**Alternatives**: Reusing the one-file limit blocks common small multi-file corrections. Accepting
arbitrary capture bytes or generated check scripts permits editing the evaluator. Baseline locator
failure, model diagnosis or screenshot difference is not proof of the reported defect.

## Decision 8 — Bind model invocation identity to actual responses

**Decision**: Record requested model, observed response model/response ID, phase, outcome and safe
usage metrics separately. Reject absent/unexpected identity in the new live protocol. Never use a
constant, configured key or a pass badge as evidence a call occurred.

**Rationale / evidence**: Existing `metaClient.ts` output parsing ignores response `model`/`id`;
metrics and legacy results use the configured constant. Preserve legacy semantics, but strengthen the
new project's actual-invocation provenance with strict parsing. No raw provider body/prompt/reasoning
needs to be retained to prove phase identity.

**Alternatives**: A mocked transport reporting the model string can satisfy default tests only, not
live acceptance. Broad provider payload logs leak data without improving the bounded identity check.

## Decision 9 — Redact before capture/persistence, and limit privacy claims honestly

**Decision**: Mask all form/contenteditable fields in screenshots by default; retain only admitted
safe synthetic fill values. Exclude known sensitive fields/private regions and sanitize extracted
text, locators, URLs, errors and code before retention/submission. Unknown sensitive visual content
or a needed redacted replay value is unsupported rather than silently sent. The report review shows
which sanitized observations and safe images would leave the host.

**Rationale / evidence**: `evidence/sanitize.ts` handles structured/text patterns. Existing
`browserCapture.ts` stores prepared canvas PNGs with no pixel redactions. `evidence/secretScan.ts`
looks for marker bytes, not pixels/OCR, so it cannot prove a rendered secret was removed. Neither a
raw trace nor a post-hoc binary scan meets FR-018's before-retention boundary.

**Alternatives**: Regex/OCR as a universal guarantee is unsound. No images at all contradicts actual
visual analysis. The initial permitted-data policy, explicit sensitive-region exclusion and fail-closed
admission are necessary; an arbitrary hostile/private app cannot be certified safe by this design.

## Decision 10 — Target egress and Studio access require separate browser controls

**Decision**: Keep Studio `127.0.0.1` host-only cookie/Origin/Host/fetch-metadata guards and target
`localhost` origin. Add target sandbox/CSP, target-frame exact-origin navigation/resource routing,
service-worker denial and WebSocket/pop-up/download blocks. Do not route target requests to Studio APIs.

**Rationale / evidence**: `studio/auth.ts` already separates origins and guards controller requests.
`TargetPane.tsx` has no iframe sandbox; parent CSP does not stop target JavaScript's outbound network.
Offline Node builds do not constrain the separate Chromium process. `studio/targetApp.ts` supplies
path/no-store/Host patterns but its prepared probe is not a universal readiness or truth oracle.

**Alternatives**: Same-origin embedding shares too much authority. Full network admission/reverse
proxying and authenticated service stacks require a different project category. A full hostile-browser
security proof is not claimed; engine vulnerabilities remain a residual platform risk.

## Decision 11 — Artifacts live outside the user's repository

**Decision**: Use a separate owner-only local state root, closed run-owned artifact IDs and hashes,
no-follow reads, no arbitrary path route. Preserve review files after execution cleanup.

**Rationale / evidence**: Current `evidence/store.ts` creates `.flowproof/runs` inside its `repoRoot`
and requires the project to ignore it. New FR-008/SC-003 require zero original-content changes,
including untracked files, so this behavior cannot be reused unchanged for the selected repository.
The current writer/registry integrity patterns remain useful with an explicitly separate base root.

**Alternatives**: Creating `.flowproof`/editing `.gitignore` in the selected project violates its
zero-write promise. Temporary-only results disappear before inspection. A database/cloud store adds
an unnecessary service and privacy boundary.

## Decision 12 — Test risky boundaries first, require real end-to-end evidence later

**Decision**: TDD on schemas, source/path/freeze guards, capture races/privacy, DSL interpretation,
model envelopes and cleanup reducer. Use synthetic independent repositories and labelled fakes for
repeatable negative cases. Add a new opt-in Meta project excluded from every default Vitest project;
then prove one actual user demonstration -> real image analysis -> generated patch -> independent pass.

**Rationale**: Existing default `integration` includes `tests/integration/**/*.test.ts` and excludes
only the historical Meta smoke. A new live-test filename alone is not opt-in: update the exclusion
and add a dedicated explicit project/script. Default CI must never accidentally spend credentials.
Current fixture and historical text smoke results are not new-feature or current-model evidence.

**Alternatives**: Running all real calls in default CI is costly/non-deterministic and risks secret
exposure. Counting fake model success as product acceptance evades the confirmed feature requirement.

## Public Documentation Read on 2026-11-04

- [Meta models](https://dev.meta.ai/docs/models): Muse Spark text/image input capability; public
  documentation retrieved with HTTP 200, not an authenticated account/model-availability check.
- [Responses API](https://dev.meta.ai/docs/protocols/responses): typed input blocks, strict response
  structures and stateless `store:false` options.
- [Image understanding](https://dev.meta.ai/docs/image-understanding): explicit `muse-spark-1.3`
  `input_image` example, base64 local images and multiple-image input. Our eight-image cap is an
  application constraint, not a claim that Meta's documented maximum is eight.

All Phase 0 design questions have concrete choices. Image/dependency/recorder/privacy/network/live
acceptance gates are explicitly unexecuted implementation prerequisites; there is no hidden fallback,
claim of current credentials, or unresolved product decision disguised as a successful test.
