# Implementation Plan: User Project Onboarding and Live AI Fix Verification

**Branch**: `feat/006-project-live-verification` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification at `specs/006-project-live-verification/spec.md`, including the
owner's correction that direct manipulation of the running target is the primary problem report.

**Status**: Phase 0 research and Phase 1 design completed as documentation. The owner authorized
Plan after the capture clarification. This is a proposed implementation design, not implementation,
a live-provider result, or authorization to generate Tasks, run a model, publish, or deploy.

## Summary

Add a separate `project-live` Studio mode. Launch with a local Git project, confirm its execution
settings, build a clean isolated snapshot, and expose the running target beside the work panel.
The developer starts capture, directly reproduces the error, and finishes capture without a human
time limit. A real Meta request analyzes sanitized actions, actual screenshot inputs, relevant errors,
and admitted code. It returns a readable interpretation and a constrained replay/check definition;
ask a focused question only when intent is unclear. The host independently reproduces the intended
baseline failure before a second Meta operation generates one bounded candidate. Apply it to a new
snapshot, repeat identical checks, and retain the verdict, evidence and exact patch for manual use.

The first usable delivery must include this entire real-model path on a separate permitted sample
repository. Internal foundation work is not a substitute for that first acceptance slice. Existing
prepared modes and their claims remain unchanged. [Research](research.md) records reuse, gaps and
alternatives; [quickstart](quickstart.md) defines later validation, not checks already performed.

**Execution scheduling**: The owner corrected the one-PR interpretation after the initial parallel
plan. [Delivery slices](tasks.md#delivery-slices) now define seven separate implementation PRs:
S1 foundations; S2 runtime/project; S3 capture/privacy; S4 replay; S5 real-model adapter; S6 workflow
integration; S7 retained review/full acceptance. After merged S1, S2/S3/S4 use independent branches and
worktrees concurrently; S5 follows merged S3 and can overlap S2/S4. S6 joins the merged modules, then
S7 completes the full usable feature. [Parallel dispatch](parallel-execution.md) records task sets,
predecessors, ownership and validation. Complete-feature acceptance still requires the actual model
path and owner review; it is not the boundary of every individual PR. No implementation is started.

## Technical Context

**Language/Version**: Existing TypeScript 7.0.2, Node.js 24+, pnpm 10.34.5; Git; Linux headed Chromium.

**Primary Dependencies**: Existing Playwright 1.64.1, React 19.3.1, Vite 8.3.5, Zod 4.6.7,
OpenAI-compatible SDK 7.45.0 and Docker CLI. No new package/service/provider marketplace is planned.
One new operator-prepared, digest-pinned offline toolchain image is required; no image pull or
package installation occurs in the project flow. Its actual digest is a later implementation artifact.

**Storage**: Sanitized files in an owner-only state directory outside the selected checkout,
default `${XDG_STATE_HOME:-$HOME/.local/state}/flowproof/project-runs/<run-id>/`. Active captures
are sanitized in memory until Finish; discard retains no report. Temporary snapshots/builds are
owned OS-temporary directories, not original worktree mounts. No database or provider-side history.

**Testing**: Existing Vitest unit/contract/integration/UI projects and headed Playwright. Test-first
for admission, recorder lifecycle, privacy, DSL/patch validation, result reduction and cleanup.
An opt-in synthetic image/structured-output provider smoke and actual selected-project live run
are required later; neither default fixtures nor the historical text smoke can satisfy these gates.

**Target Platform**: Existing Linux/Docker/headed-Chromium local environment. One fresh managed
browser context, one target origin and one active run. No remote execution, production hosting,
backend/database/login service, cross-origin embedded app, or general desktop recording.

**Project Type**: Local CLI/controller plus current React Studio, adding a disjoint project-run
contract family, not replacing the prepared engine or introducing a generic agent framework.

**Performance Goals**: Bounded capture and request sizes; coalesce typing/scroll bursts and collect
ordered evidence without blocking human input. No user-task timing SLA. Bound automatic work only:
120 seconds per build/check or replay phase, 90 seconds per provider request, 600 seconds aggregate
automatic work, 5 seconds graceful container stop. Human demonstration, clarification, and result
review are excluded from wall-clock execution budgets and do not auto-close the window.

**Constraints**: No execution on the original host checkout, no original writes including artifacts,
no credentials in target/build/candidate environments, no raw trace/HAR/video, no model-generated
JavaScript/check commands, and no hidden fixture/provider fallback. Bounded text patches only.

**Scale/Scope**: One `vite-static-v1` single-package React/Vite browser client with an admitted lock
and matching preprepared dependency set. One completed demonstration, up to two analysis calls
(the second only after an explicit clarification answer), and one correction call; no autonomous
retry or candidate repair loop. One candidate changes at most eight existing regular UTF-8 files
under admitted `src/` paths, with a 64-KiB diff. No file creation/deletion, binaries or package changes.

## Constitution Check

**Pre-research: PASS for the proposed bounded scope. Post-design: PASS with explicit implementation
gates and residual risks below; these are design checks, not executed security/feature acceptance.**

- **I — Clean room:** only permitted public/synthetic projects and data for evaluation. No company
  source, personal browser profile, private account flow or arbitrary private screenshot corpus.
- **II — Scope:** one static client category, one existing provider, two normal stateless model
  operations and a small declarative replay/check language. Distinct mode/runner are necessary because
  existing prepared contracts and network-enabled editor cannot safely express this workflow.
- **III — Verification:** a host-owned frozen check must fail for the intended reason on a clean
  baseline and pass on the exact candidate build; original integrity and cleanup are mandatory.
  TDD targets authority/race/path/privacy logic. Live acceptance remains unexecuted until authorized
  implementation and cannot be waived by deterministic test success.
- **IV — Security:** scrub committed snapshots; no Git history, host HOME/dependencies, or model key
  in execution containers; offline container execution and exact-origin target browser policy;
  sanitize/mask before retention and transmission. Arbitrary unmarked sensitive pixels and hostile
  app truthfulness are not comprehensively solved; reject unsupported sensitive content, preserve
  bounded claims, and do not promote those cases to verified success.

No Constitution exception is requested. The image/permission/network/visual-redaction validation
listed in [quickstart](quickstart.md) must pass before accepting the live feature.

## Project Structure

### Documentation (this feature)

```text
specs/006-project-live-verification/
├── spec.md
├── checklists/requirements.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   ├── cli-and-studio.md
│   ├── capture-and-replay.md
│   └── model-and-verification.md
└── quickstart.md
```

[tasks.md](tasks.md) is generated in the separate owner-requested Tasks phase, not by this Plan.

### Planned Source Surfaces (not implemented)

```text
packages/flowproof/src/
├── cli.ts                              # additive --project mode; legacy flags unchanged
├── project/
│   ├── admission.ts                    # root/revision/tree/secret/category admission
│   ├── profile.ts                      # one pinned offline build/check profile
│   ├── snapshot.ts                     # scrubbed tree export, no .git/history/host links
│   ├── runtime.ts                      # network=none bounded builds/checks
│   ├── contracts.ts                    # strict project data, state and result family
│   └── run.ts                          # explicit capture-to-verification coordinator
├── capture/
│   ├── projectRecorder.ts              # target-only ordered interaction capture
│   └── projectPrivacy.ts               # safe fields, DOM extracts, masking, memory staging
├── model/
│   ├── projectClient.ts                # analysis/correction Meta wire schemas
│   └── projectPrompt.ts                # admitted sources + real safe image input blocks
├── verify/projectReplay.ts             # host compiler/interpreter of frozen DSL
├── patch/projectDiff.ts                # bounded multi-file text admission/application
├── evidence/projectStore.ts            # closed outside-checkout artifact root
└── studio/{launch,server,targetApp}.ts  # additive project launcher/routes/target ownership
apps/studio/src/
├── {api,state,presentation}.ts         # disjoint project-live schemas/reducer/presentation
├── components/ProjectSetup.tsx         # identity/settings and readiness
├── components/DemonstrationPanel.tsx   # capture/finish/discard/clarification controls
└── components/{TargetPane,ResultSummary,EvidenceComparison,WorkTimeline}.tsx
vitest.config.ts                       # exclude new live smoke; explicit opt-in project
package.json                           # optional dedicated live-smoke script
tests/
├── {unit,contract,integration}/project-*.test.ts
├── e2e/project-live.spec.ts
├── integration/project-live-meta-smoke.test.ts  # explicitly excluded from default projects
└── fixtures/project-live/              # public/synthetic inputs and near misses
```

**Structure Decision**: Keep the existing `ModelTransport.diagnose`, legacy nine-gate reducer,
captured ten-check verdict and original public contracts unchanged in meaning. Reuse lower-level
sanitization, authentication, artifact hashing, static serving and cancellation patterns where safe.
Do not reuse host build/functional-check execution or network-enabled editor unchanged. No abstract
provider registry, workflow engine, authenticated CLI agent, or arbitrary plugin/tool loop is needed.

## Phase 0 — Research Decisions

See [research.md](research.md) for evidence, alternatives and exact source references. Two bounded
read-only research agents investigated recorder/runtime and provider/verification surfaces as
requested by the installed `speckit-plan` procedure; neither modified files or called a model.
Public Meta documentation was fetched read-only on 2026-11-04 and confirms `muse-spark-1.3` image
input syntax, but current-account success with images and strict output has not been exercised.
All technical decisions below are concrete; remaining unexecuted gates are not unresolved product
questions or fabricated results.

## Phase 1 — Design

### 1. Admit the selected project without executing it

`flowproof studio --project <path> [--project-config <path>]` selects the new mode, mutually exclusive
with `--scenario`. Canonicalize the Git root and pin HEAD; inspect tracked content and original
state with hooks/filters/fsmonitor/global Git configuration disabled. Permit ignored installed
packages in the original but never copy them. Reject tracked modifications, untracked source needed
by the app, symlinks/gitlinks, sensitive committed files, missing required inputs, unsupported layouts,
or dependency/config mismatch. Display identity and settings before any project command or model call.
The config contains data only; host-owned runtime image/network/policy cannot be selected from it.

The initial category is a single-root React/Vite application that builds to static `dist/`, uses
only prepared dependencies and has no service/backend/authentication requirement. The concrete
profile image bundles exact locked dependencies (initial React 19.3.1/Vite 8.3.5-compatible set);
its dependency manifest and admitted project lock must match. No generic `npm install`, automatic
lock rewriting, shell command, image download or original `node_modules` symlink is allowed.

### 2. Run the admitted application in isolation

Export only admitted committed files into owned snapshots; keep trusted Git/capture metadata and
frozen commands/checks outside every project mount. New containers use digest-pinned existing image,
non-root identity, read-only rootfs, no-new-privileges, dropped capabilities, CPU/memory/PID limits (one CPU, 1 GiB memory, 256 PIDs initially),
`--network=none`, run-owned writable workspace/output and private temporary HOME. No host socket,
original directory, Git object database or credential/environment inheritance is mounted.

Execute confirmed direct argv for the fixed profile build and required project checks inside that
container. Build uses the preprepared read-only dependency set and owned temporary cache; validate
source/config hashes before and after the build/check. Copy only bounded regular static build output
through no-follow paths for host-owned read-only serving; never execute project JavaScript in the
controller. Required build, expectation replay, evidence binding, original integrity and cleanup
cannot be disabled; confirmed preexisting project checks are additional mandatory checks.

The controller serves only the selected validated output at a run-owned `http://localhost:<port>`;
Studio stays `http://127.0.0.1:<port>`. Confirmed entry path is same-origin and relative. The application
is the isolated built project, not the original dev server and not a placeholder demo. Startup/readiness
uses document/load plus host-known output identity, not the old chart-specific page-global probe.

### 3. Capture the human demonstration

Use the actual attached target frame in the launcher-owned headed context. Start resets the target
to its declared entry state and installs target-only recorder instrumentation; Finish drains ordered
interaction/navigation and screenshot/error queues, sanitizes and seals a report; Discard deletes
staged material and never submits it. The host validates binding callback source frame, exact target
origin, capture/session identity, schemas and sequence; the Studio API cannot upload authoritative
raw interaction events. The target remains interactive only during the demonstration stage, not
while baseline/candidate replay is collecting independent evidence.

Collect clicks, safe input/change events, coalesced scrolls and same-origin navigation with locator
candidates; capture safe start/end and meaningful-action image observations and relevant console,
page-error/failed-request metadata. Do not retain request bodies/headers, cookies or broad browser
traces. Expose observation gaps and unsupported actions. Capture limits bound resources, not human
time: at most 200 actions, 16 image observations (1 MiB each), 64 KiB console/network summaries and
20 MiB combined staged report. Crossing a cap makes the report visibly incomplete, never silently
truncated into a usable success path. A user can discard/re-record without a countdown or auto-close.

Mask all input/contenteditable fields in image capture by default and exclude secret/private
regions before pixels are retained. Retain synthetic safe input values only when admitted by policy;
redacted values needed for replay are an unsupported/clarification condition. Sanitize extracted
text/locators/URLs/errors/source; reject unsafe visual surfaces rather than using byte scanning as
OCR. Show sanitized report/observation scope before its explicit Analyze action sends data externally.

Add a target iframe sandbox without top navigation/popups/downloads/extra frames, target CSP and
Playwright routing that admit only the exact target's static resources and normal Studio-owned
requests. Block target access to Studio APIs, other loopback/private/remote origins, WebSockets,
service workers and cross-origin navigation. Do not mistake parent Studio CSP for target egress control.

### 4. Analyze the capture, clarify intent only when needed, then freeze checks

Extend the existing Meta HTTP mechanics through a new project-specific adapter. Send sanitized
ordered observations and admitted text source plus actual PNG `input_image` data blocks, not image
IDs alone. Cap outbound context to 32 source files/256 KiB text and eight selected sanitized images
with a combined serialized request of at most 8 MiB. Select observations deterministically, retain
mandatory start/failure/end coverage where available, expose included/omitted IDs and reject a report
whose essential visual evidence cannot fit. Do not silently truncate source or required evidence.

Analysis returns closed `ready`, `clarify` or `unsupported` data: observed problem/evidence citations,
a replay definition and expected check, or a focused question with missing intent identified. One
explicit user answer may trigger one bounded re-analysis; this is not an autonomous retry. Show the
readable interpretation and expected behavior, with a Verify-and-fix action confirming it. The user
never writes the action list, test, assertion code or recorder selectors. Discard/re-record changes
the report identity; it cannot mutate an already frozen verification definition.

Compile only the allowlisted DSL in [capture-and-replay](contracts/capture-and-replay.md). Freeze the
baseline, profile/dependency/build/check/source digests, capture/report digest, interpretation,
replay/check definition and evidence obligations outside candidate-editable storage. No generated
shell, JavaScript, `evaluate`, arbitrary module import or tool execution is accepted from the model.

### 5. Prove the baseline failure, generate one patch, repeat verification

Replay in a fresh isolated baseline target/context state. Every action must resolve and complete,
required evidence must be available, and the agreed expected condition must fail in the intended
way. Locator errors, unrelated console errors, inability to start, incomplete capture or a timeout
are not proof. If baseline already satisfies the condition, end as not reproduced without correction.

Only then call the same Meta model for one correction, supplying the frozen task/check description,
safe admitted source and observed failure evidence. Return a strict diff candidate with citations;
no automatic tools or iterative edits. Validate up to eight existing regular UTF-8 `src/` files and
64 KiB patch, canonical paths and exact old/new tree relationship. Reject config/lock/test/check,
symlink, binary, mode, rename, creation/deletion and outside-root changes before applying anything.
Apply once with private trusted Git metadata to a new baseline snapshot, not the demonstration tree.

Build and run required project checks offline, then execute the identical frozen replay/expectation
against the exact candidate output in fresh browser state. Verify output/source/check hashes across
boundaries. The host owns the assertion results; model/candidate pass strings are not authorities.
Original integrity and mandatory cleanup finalize before success. One claim, **Project verification
passed**, means this declared demonstration-derived obligation and required checks passed; it does
not mean all bugs fixed, original applied, merged or deployed. Preserve both existing mode labels.

### 6. Retain review artifacts and release execution resources

Store sanitized reports, derived definitions, provider invocation metadata, evidence manifests,
check results, exact safe diff/patch and a terminal result outside the selected checkout. A closed
ID/digest lookup serves only artifacts registered to that run. No arbitrary path/file endpoint or raw
prompt/provider-response dump is added. Keep requested and observed model identity distinct; a
configured constant is not proof of an actual invocation. No credentials, raw reasoning or auth URLs
are retained. Finishing/error/cancel paths share an idempotent cleanup owner; canceled cannot later pass.
After the target is disposed, stored evidence/diff remain reviewable until the user closes Studio.
No human review timeout and no automatic application to the original are introduced.

## Verification Strategy and Coverage

| Requirement group | Design surface | Later acceptance evidence |
| --- | --- | --- |
| FR-001–FR-003 | admission/profile/CLI/setup | SC-002: invalid/stale/config cases before commands/model |
| FR-004, FR-018 | interactive target/recorder/privacy | SC-007/SC-009: human demonstration and safe ordered observations |
| FR-019 | multimodal analysis/DSL/clarification | SC-010: derivation, ambiguity and unsupported cases |
| FR-005, FR-009–FR-011 | frozen DSL, baseline and candidate replay | SC-001/SC-004: intended fail then same obligation passes; near misses reject |
| FR-006, FR-007 | real Meta analysis/correction and identity | SC-001/SC-005: actual calls/images/new patch; no fixture fallback |
| FR-008, FR-016 | export/offline runtime/outside-root store | SC-003/SC-006: original zero-write and credential/privacy boundaries |
| FR-012–FR-015 | mode state, evidence/diff routes, cleanup | SC-004/SC-005/SC-007: honest status, retained review and interruption |
| FR-017 | disjoint mode/contracts, legacy regression | SC-008: existing behavior and claims preserved |

Use focused TDD for contract parsers, locator/action interpretation, mutation/freeze protection,
no-follow path handling, secret/pixel exclusion policy, Finish/Discard races, cancellation reduction
and ownership cleanup. Use an independent synthetic Git repository for the actual live acceptance;
ordinary automated tests may use labelled in-process model fakes but cannot satisfy SC-001.
Existing full-suite commands remain in [quickstart](quickstart.md); do not rerun product suites for
this docs-only Plan. Tasks must define exact per-slice test ranges without inventing acceptance passes.

## Risks and Implementation Gates

- Actual current-account image plus strict-output support must pass the opt-in protocol gate. Official
  documentation is evidence for design, not evidence a credential, quota or model call works now.
- Build and validate the real immutable image and dependency manifest before project execution.
  The existing bridge editor and host worktree builder are not acceptable fallback runtimes.
- Recorder injection/page data can be spoofed by hostile app code. Host source validation, a small
  interpreter and fresh state constrain supported behavior but do not solve arbitrary hostile UI truth.
- Masking and source rules cannot discover every unknown secret/PII encoded in arbitrary pixels.
  Initial permitted-data policy, safe field admission and fail-closed visual exclusions are necessary;
  do not claim a regex scan proves general screenshot privacy.
- Replay/check derivation may be wrong or unsupported. Clarify intent, show interpretation, require
  the independent baseline check, and stop rather than fabricate steps or weaken a failing obligation.
- Fixed dependencies, source-only existing-file edits and DOM-based checks deliberately limit usable
  projects. Changes to category, account/provider, private data, storage or network scope return to
  owner review under `CONTRIBUTING.md`; no scope extension is hidden in Tasks.

## Complexity Tracking

No Constitution violations require an exception. Separate project contracts, offline execution,
recorder/privacy boundary and host-owned DSL are the minimum separation needed to satisfy the
confirmed live-demonstration workflow without weakening existing prepared modes.
