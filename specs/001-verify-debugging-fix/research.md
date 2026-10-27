# Research: Evidence-Grounded Fix Verification

**Date**: 2026-10-27

## Decision 1: Use Node.js 24 and TypeScript in one pnpm workspace

**Decision**: Build the Studio, local orchestration engine, launcher, and trusted demo fixture with
Node.js 24 LTS, TypeScript 7.0, and pnpm 10.

Compile the engine with `tsc` into `packages/flowproof/dist/` and execute the emitted CLI with
`node --env-file-if-exists=.env packages/flowproof/dist/cli.js`. Do not depend on Node type
stripping or a runtime TypeScript loader in the MVP.

**Rationale**: The prepared host already has Node.js 24 and pnpm 10. Playwright, Vite, Chart.js,
Meta's documented OpenAI-compatible SDK path, JSON Schema validation, patch processing, and Studio
UI all fit one runtime. A single language reduces build and packaging work during the hackathon.

**Alternatives considered**:

- Python: strong automation ecosystem, but would add a second application language for the browser
  fixture and duplicate contracts.
- Separately deployed frontend and backend services: rejected because the MVP needs one local
  process, not hosted multi-user infrastructure.
- Multiple reusable packages: rejected until a second consumer exists.

## Decision 2: Make a local split-view Studio the primary UX

**Decision**: Open one local browser window with the prepared application on the left and Chat,
Agent Activity, Evidence, Gates, and the final Proof Trail on the right. Keep the CLI only as the
Studio launcher for the MVP.

**Rationale**: The approved product experience requires the developer to see the target behavior and
the agent's evidence-grounded work together. A local Studio supplies that experience without a
database, login, cloud deployment, or browser-extension permission flow. A second headless surface
and portable report can be added after the visible Hero and Failure paths are stable.

**Alternatives considered**:

- CLI plus static report as the primary UX: safe but does not show the target and agent working
  together; both surfaces are deferred rather than implemented beside the Studio.
- Chrome Side Panel extension: best aligned with future use on arbitrary sites, but extension
  permissions and local Git access require a companion service and broaden the hackathon surface.
- Electron with `WebContentsView`: can own both panes and arbitrary navigation, but packaging,
  security hardening, and update distribution are unnecessary for the controlled fixture.

## Decision 3: Let headed Playwright control the visible target iframe

**Decision**: The local engine builds and serves the known-bad app from an isolated worktree,
launches headed Chromium to the built Studio, embeds the app in the left iframe, and drives that
exact frame with Playwright. A Node.js built-in HTTP server serves the Studio and local API from
`127.0.0.1`; the demo app uses `localhost` on a fixed port. The right panel receives sanitized
ordered events over Server-Sent Events (SSE).

The initial Studio and prepared preview are built into operating-system temporary output and served
as static assets without writing generated files into the original repository. Run execution,
dependency linking, known-bad capture, patching, and replay use the detached worktree. The MVP does
not use Vite development servers or HMR, which would add unrelated network activity and mutable
runtime state to the captured evidence.

`app.start_command` is the committed build command run inside the detached worktree. A
FlowProof-owned fixed-port static server binds once, swaps its document root across preview,
known-bad, and patched builds, and reconnects the iframe only after the trusted probe is ready.

**Rationale**: The user sees the same application instance that provides failure and replay
evidence. The controlled fixture permits framing, and Playwright can address its frame without the
Studio frontend bypassing browser-origin boundaries. One-way SSE fits connected-run progress
updates; ordinary local HTTP requests handle chat start and result retrieval. The MVP does not
persist or replay missed activity events.

The host split prevents the Studio launch cookie from being sent to model-patched iframe code.
Playwright injects the `HttpOnly; SameSite=Strict; Path=/` cookie before Studio navigation. The
server validates the exact `Host`, requires the exact Studio `Origin` on POST requests, and requires
the launch cookie plus `Sec-Fetch-Site: same-origin` on GET and SSE requests. Same-origin GET and
EventSource requests may omit `Origin`, so it is not required there.

**Alternatives considered**:

- Mirror a separate hidden browser with screenshots: easier, but the displayed target would not be
  the authoritative run.
- Let the Studio inspect and drive the iframe directly: ties evidence collection to custom demo
  instrumentation and does not preserve the Playwright path.
- WebSocket: bidirectional transport is unnecessary because chat and run commands use HTTP.
- Arbitrary external pages in the iframe: deferred because framing policy and authentication differ
  by site; a Chrome extension or owned browser is the later integration boundary.

## Decision 4: Use Meta Model API `muse-spark-1.3` Standard mode

**Decision**: Use `muse-spark-1.3` through `https://api.meta.ai/v1/responses` with a key supplied as
`MODEL_API_KEY`.

**Rationale**: Meta documents Muse Spark 1.3 as the recommended version for new agentic work. It is
available in South Korea, supports the Responses API and strict structured output, and has a
1,048,576-token context window. Standard mode does not use submitted content to train Meta models.
Muse Wonder is unavailable in South Korea and unnecessary for one-file diagnosis.

**Alternatives considered**:

- `muse-wonder-1.0`: unavailable in South Korea and too costly/capable for this bounded task.
- Contributor mode: rejected because prompts, source context, and responses may be used for model
  training.
- Muse Code: useful as a development agent, but the product requires a direct, observable runtime
  API integration.
- Non-Meta model: allowed only as a local test double, not as the Hero runtime.

## Decision 5: Use one stateless strict-schema Responses API call

**Decision**: Send the sanitized evidence manifest and one allowlisted source file in a single
request with `store: false` and a strict JSON Schema response. The response must contain diagnosis,
evidence-linked claims, target paths, and a unified diff.

The MVP makes one HTTP attempt for this diagnosis operation. A timeout, 429, or 5xx response ends
the run as `Unverified`; automatic retries are deferred so the one-call budget remains literal and
the five-minute demonstration stays predictable.

Automated Hero tests use a recorded response only through an in-process `ModelTransport` override
passed to `startStudio`. CLI flags, environment variables, scenario data, chat/API bodies, and
production transport selection cannot activate the test seam. When Hero is fixed by `--scenario`,
credential readiness is a startup precondition; when the Studio opens with no fixed scenario, the
same check occurs when Hero is selected and rejects the start request without creating a run.

**Rationale**: One call minimizes latency and cost. Strict decoding guarantees the response shape,
while FlowProof separately validates that every cited Evidence ID exists and every target path is
allowed. Stateless mode avoids server-managed conversation history.

**Alternatives considered**:

- Chat Completions: simpler, but Responses is Meta's recommended surface for agentic workflows and
  keeps the design ready for later multimodal inputs.
- Multi-turn diagnosis then patch generation: extra latency and more failure states without value
  for one file.
- Model tool calls: rejected because the model must not select commands or mutate the workspace.

## Decision 6: Keep SAM 3.1 out of the default MVP path

**Decision**: Do not require SAM 3.1 for Hero verification. Record it as a later experiment gated on
measured improvement over the trusted chart oracle and captured screenshots.

**Rationale**: The specification requires deterministic bar count, label, and value verification,
not segmentation. Meta documents SAM as returning geometry for concrete objects from short noun
phrases. Chart bars are possible segmentation targets, but the trusted chart probe is simpler,
deterministic, cheaper, and sufficient in the prepared demo environment. A forced SAM dependency
would add parsing, masks, and another paid request without proving better verification.

**Alternatives considered**:

- Make SAM mandatory: rejected as scope inflation.
- Use Muse Spark vision as the final verifier: rejected because the patch-producing model must not
  approve its own visual result.
- Add SAM as a non-blocking overlay: deferred until the Hero path is complete and measured.

## Decision 7: Pair data and rendered-chart oracles, with screenshots as evidence

**Decision**: Verify exact filtered rows and read the rendered Chart.js labels and values through a
trusted test probe outside the patch boundary. Capture fixed-size failure and replay screenshots for
review, but do not use pixel comparison as a required MVP gate.

**Rationale**: The data gate detects semantic filtering errors. The chart probe proves the bar
count, labels, and values actually passed to the renderer. Screenshots still make the before/after
change visible to the reviewer, while removing pixel-threshold tuning and cross-environment image
instability from the critical path. The fixed viewport, Canvas dimensions, Chromium build, locale,
timezone, device scale, font set, and disabled animations keep the recorded evidence comparable.

**Alternatives considered**:

- DOM assertions only: cannot observe Canvas pixels.
- Chart.js probe plus screenshots: selected because it proves the required chart values while
  preserving visual evidence without a flaky hard gate.
- OCR or general computer vision: higher nondeterminism and dependency cost for a fixed fixture.
- Pixel-level screenshot verification: useful later, but not required to prove this bounded filter
  defect during the hackathon.

## Decision 8: Apply patches in a detached temporary Git worktree

**Decision**: Resolve the Git common directory, snapshot the complete output of
`git worktree list --porcelain`, create a detached worktree at the captured original `HEAD`, reject
unsafe diffs, run `git apply --check`, apply only the permitted file, replay there, then run
`git worktree remove --force` followed by `git worktree prune` for the FlowProof-owned entry.

**Rationale**: Git supplies an exact tracked baseline and a verifiable diff while leaving the
developer's tracked files, index, checked-out branch, HEAD, and history untouched. A detached
worktree avoids creating a candidate branch or commit. The original `HEAD`, status, index,
protected hashes, and full registered-worktree snapshot are compared before and after the run, so
pre-existing unrelated worktrees are preserved rather than treated as errors.

**Alternatives considered**:

- Edit and restore the original working copy: violates fail-safe isolation and risks user changes.
- Plain recursive copy: slower and easier to copy ignored secrets or large generated directories.
- Container per run: stronger isolation but unnecessary complexity for the controlled fixture.
- Automatic candidate commit/PR: explicitly out of scope.

## Decision 9: Persist only local, run-scoped sanitized artifacts

**Decision**: Write artifacts under ignored `.flowproof/runs/<run-id>/` and delete the temporary
worktree after retaining the verified diff, screenshots, evidence manifests, and gate outcomes.

This ignored artifact root is the only permitted persistent addition beneath the original working
tree. Generated Studio assets live in operating-system temporary output, and demo build,
dependency-linking, patch, and replay writes remain inside the detached worktree. Git's transient
administrative metadata for that worktree lives under the resolved common directory and is removed
and pruned before finalization.

**Rationale**: The active Studio renders the reviewable Proof Trail from contract-valid local
artifacts. Local files avoid a database, account model, cloud retention policy, portable report
generator, and network transmission beyond the explicit Meta request. Content hashes make evidence
references stable. The tracked working tree and Git state remain unchanged even though the ignored
run-artifact directory is intentionally added.

**Alternatives considered**:

- In-memory only: loses the result as soon as the process exits.
- SQLite: no query or concurrency requirement justifies it.
- Cloud object storage: expands security, cost, and deployment scope.

## Decision 10: Make the Failure case deterministic and explicitly injected

**Decision**: Use a committed provider fixture with one nonexistent Evidence ID. Label the run as an
evaluation fixture and reject it before patch application.

**Rationale**: The P2 story must reliably demonstrate that FlowProof refuses unsupported changes.
Depending on a live model to make a mistake is nondeterministic. Explicit fault injection proves the
guard without misrepresenting the source of the bad citation.

**Alternatives considered**:

- Prompt the live model to return a bad citation: misleading and nondeterministic.
- Break the expected oracle: undermines trust in the oracle.
- Inject an apply failure: valid but less directly demonstrates evidence grounding.

## Decision 11: Dependency versions and licenses

**Decision**: Start implementation from the following verified package lines; pin exact versions in
the lockfile.

| Package | Version checked | License | Purpose |
| --- | ---: | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 | typed implementation |
| React | 19.3.1 | MIT | Studio interface |
| Vite | 8.3.5 | MIT | Studio and trusted demo fixture |
| `@vitejs/plugin-react` | 6.1.2 | MIT | Studio build integration |
| Chart.js | 4.6.1 | MIT | Canvas chart |
| Playwright | 1.64.1 | Apache-2.0 | reproduction and replay |
| OpenAI SDK | 7.45.0 | Apache-2.0 | Meta Responses API client |
| Zod | 4.6.7 | MIT | runtime contract validation |
| Commander | 15.0.0 | MIT | CLI surface |
| Vitest | 5.0.5 | MIT | unit and contract tests |

**Rationale**: All licenses are permitted by the Clean-Room principle. The checked engine ranges
support Node.js 24.

**Alternatives considered**: No framework substitutions are needed unless implementation reveals a
specific incompatibility.

## Live Meta API Go/No-Go evidence

On 2026-10-27, a sanitized synthetic smoke test used the configured FlowProof key without printing
or storing it:

- `GET /v1/models`: HTTP 200; both `muse-spark-1.3` and `sam-3.1` were available.
- `POST /v1/responses`: HTTP 200 and `completed` from `muse-spark-1.3`.
- Strict JSON Schema output parsed successfully.
- The response cited both supplied Evidence IDs and returned a unified diff scoped to the supplied
  synthetic file.
- Usage was 179 input tokens and 318 output tokens (497 total).
- The response used `store: false`; neither the API key nor raw model output was written to the
  repository.

**Decision**: Meta Model API access is a GO for implementation. SAM quality remains unevaluated and
does not block the MVP.

## Official sources

- [Meta Model API overview](https://dev.meta.ai/docs/overview)
- [Models and regional availability](https://dev.meta.ai/docs/models)
- [Responses API](https://dev.meta.ai/docs/protocols/responses)
- [Structured output](https://dev.meta.ai/docs/structured-output)
- [SDKs and libraries](https://dev.meta.ai/docs/sdks)
- [Media segmentation](https://dev.meta.ai/docs/media-segmentation)
- [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits)
- [Meta Model API quickstart](https://dev.meta.ai/docs/quickstart)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
