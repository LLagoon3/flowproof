# Research: Evidence-Grounded Fix Verification

**Date**: 2026-10-27

## Decision 1: Use Node.js 24 and TypeScript in one pnpm workspace

**Decision**: Build the orchestration CLI and trusted demo fixture with Node.js 24 LTS,
TypeScript 7.0, and pnpm 10.

**Rationale**: The prepared host already has Node.js 24 and pnpm 10. Playwright, Vite, Chart.js,
Meta's documented OpenAI-compatible SDK path, JSON Schema validation, patch processing, and static
report generation all fit one runtime. A single language reduces build and packaging work during the
hackathon.

**Alternatives considered**:

- Python: strong automation ecosystem, but would add a second application language for the browser
  fixture and duplicate contracts.
- Separate frontend and backend services: rejected because the MVP needs a local developer tool and
  static report, not a hosted multi-user service.
- Multiple reusable packages: rejected until a second consumer exists.

## Decision 2: Use a CLI with a static HTML Proof Trail

**Decision**: Expose the MVP as `flowproof run` and write machine-readable artifacts plus a static
HTML report per run.

**Rationale**: The primary user is a solo developer running a local project. A CLI can coordinate
Git, Playwright, Meta Model API, and verification without a daemon, database, login flow, or hosted
backend. A static HTML report provides the single review flow required by the specification and is
easy to demonstrate in a browser.

**Alternatives considered**:

- Full web dashboard and API server: more operational surface with no MVP requirement.
- Terminal-only output: insufficient for connecting screenshots, diff, gates, and evidence in one
  visible review flow.
- Electron desktop application: unjustified packaging complexity.

## Decision 3: Use Meta Model API `muse-spark-1.3` Standard mode

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

## Decision 4: Use one stateless strict-schema Responses API call

**Decision**: Send the sanitized evidence manifest and one allowlisted source file in a single
request with `store: false` and a strict JSON Schema response. The response must contain diagnosis,
evidence-linked claims, target paths, and a unified diff.

**Rationale**: One call minimizes latency and cost. Strict decoding guarantees the response shape,
while FlowProof separately validates that every cited Evidence ID exists and every target path is
allowed. Stateless mode avoids server-managed conversation history.

**Alternatives considered**:

- Chat Completions: simpler, but Responses is Meta's recommended surface for agentic workflows and
  keeps the design ready for later multimodal inputs.
- Multi-turn diagnosis then patch generation: extra latency and more failure states without value
  for one file.
- Model tool calls: rejected because the model must not select commands or mutate the workspace.

## Decision 5: Keep SAM 3.1 out of the default MVP path

**Decision**: Do not require SAM 3.1 for Hero verification. Record it as a later experiment gated on
measured improvement over the fixed screenshot oracle.

**Rationale**: The specification requires deterministic bar count, label, and value verification,
not segmentation. Meta documents SAM as returning geometry for concrete objects from short noun
phrases. Chart bars are possible segmentation targets, but a pinned screenshot comparison is
simpler, deterministic, cheaper, and sufficient in the prepared demo environment. A forced SAM
dependency would add parsing, masks, and another paid request without proving better verification.

**Alternatives considered**:

- Make SAM mandatory: rejected as scope inflation.
- Use Muse Spark vision as the final verifier: rejected because the patch-producing model must not
  approve its own visual result.
- Add SAM as a non-blocking overlay: deferred until the Hero path is complete and measured.

## Decision 6: Pair data, rendered-chart, and pinned Canvas screenshot oracles

**Decision**: Verify exact filtered rows, read the rendered Chart.js labels and values through a
trusted test probe outside the patch boundary, and compare Canvas pixels against a committed
known-good screenshot.

**Rationale**: The data gate detects semantic filtering errors. The chart probe proves the bar
count, labels, and values actually passed to the renderer. The screenshot observes final Canvas
pixels that are absent from the DOM. Pinning Chromium, viewport, fonts, locale, timezone, device
scale, and disabled animations makes the visual oracle stable for the prepared demo. None of these
oracles is generated by the failing run or the model.

**Alternatives considered**:

- DOM assertions only: cannot observe Canvas pixels.
- Chart.js probe only: verifies rendered data but not final pixels.
- OCR or general computer vision: higher nondeterminism and dependency cost for a fixed fixture.
- Screenshot-only verification: does not clearly isolate incorrect filtered data.

## Decision 7: Apply patches in a detached temporary Git worktree

**Decision**: Create a detached worktree at the captured original HEAD, reject unsafe diffs, run
`git apply --check`, apply only the permitted file, replay there, then remove the worktree.

**Rationale**: Git supplies an exact tracked baseline and a verifiable diff while leaving the
developer's checked-out files and branch history untouched. A detached worktree avoids creating a
candidate branch or commit. The original HEAD, status, and protected hashes are compared before and
after the run.

**Alternatives considered**:

- Edit and restore the original working copy: violates fail-safe isolation and risks user changes.
- Plain recursive copy: slower and easier to copy ignored secrets or large generated directories.
- Container per run: stronger isolation but unnecessary complexity for the controlled fixture.
- Automatic candidate commit/PR: explicitly out of scope.

## Decision 8: Persist only local, run-scoped sanitized artifacts

**Decision**: Write artifacts under ignored `.flowproof/runs/<run-id>/` and delete the temporary
worktree after retaining the verified diff, screenshots, gate outcomes, and reports.

**Rationale**: The user needs a reviewable Proof Trail. Local files avoid a database, account model,
cloud retention policy, and network transmission beyond the explicit Meta request. Content hashes
make artifact references stable.

**Alternatives considered**:

- In-memory only: loses the result as soon as the process exits.
- SQLite: no query or concurrency requirement justifies it.
- Cloud object storage: expands security, cost, and deployment scope.

## Decision 9: Make the Failure case deterministic and explicitly injected

**Decision**: Use a committed provider fixture with one nonexistent Evidence ID. Label the run as an
evaluation fixture and reject it before patch application.

**Rationale**: The P2 story must reliably demonstrate that FlowProof refuses unsupported changes.
Depending on a live model to make a mistake is nondeterministic. Explicit fault injection proves the
guard without misrepresenting the source of the bad citation.

**Alternatives considered**:

- Prompt the live model to return a bad citation: misleading and nondeterministic.
- Break the expected oracle: undermines trust in the oracle.
- Inject an apply failure: valid but less directly demonstrates evidence grounding.

## Decision 10: Dependency versions and licenses

**Decision**: Start implementation from the following verified package lines; pin exact versions in
the lockfile.

| Package | Version checked | License | Purpose |
| --- | ---: | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 | typed implementation |
| Vite | 8.3.5 | MIT | trusted demo fixture |
| Chart.js | 4.6.1 | MIT | Canvas chart |
| Playwright | 1.64.1 | Apache-2.0 | reproduction and replay |
| OpenAI SDK | 7.45.0 | Apache-2.0 | Meta Responses API client |
| Zod | 4.6.7 | MIT | runtime contract validation |
| pixelmatch | 8.0.0 | ISC | Canvas screenshot comparison |
| pngjs | 7.0.0 | MIT | PNG decoding and diff output |
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
