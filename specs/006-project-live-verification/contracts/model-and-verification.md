# Contract: Real Model, Candidate and Verification Authority

**Feature**: [spec](../spec.md) | **Plan**: [design](../plan.md)

## Provider and Authentication

Use the existing Meta `https://api.meta.ai/v1/responses` endpoint and `muse-spark-1.3` as the one
configured provider/model. Reuse explicit host-only `MODEL_API_KEY`, redirect refusal, explicit SDK
headers/options, `store:false`, no provider history, `maxRetries:0`, cancellation and sanitized error
patterns. Do not read credentials from the selected project, Studio requests, patch, runtime profile,
container environment or target page. Do not expose a credential entry form or an arbitrary endpoint.

Nonblank key configuration is only local readiness. Actual availability/authorization/quota/image
and strict-output compatibility require a later opt-in synthetic protocol check. No such call was
made during Plan. Failure must remain explicit; do not use a fixture, another model/provider or a
text-only image surrogate. Do not fetch project-provided URLs or upload source/images to public hosts.

## Phase A — Capture Analysis

One stateless request contains:

- System-owned phase/schema and untrusted-content boundaries.
- Sanitized demonstrated problem/optional description, ordered target actions and observation IDs.
- Admitted source text, safe relevant errors and actual sanitized image `input_image` data blocks,
  each tied to its observation ID; source/image selection and size limits follow the capture contract.
- Requested output format and no execution/tool capabilities. Project/DOM/model text is data, never
  authority to change provider, access files, run commands, add network or replace verification policy.

Closed response variants:

| Variant | Required product data | Prohibited shortcuts |
| --- | --- | --- |
| `ready` | observed-problem summary, existing evidence citations, replay DSL, expected condition, readable intent | no candidate yet; no invented observation or executable test/code |
| `clarify` | observed facts/citations, one missing-intent question and bounded proposed alternatives | no patch or silent assumption of the answer |
| `unsupported` | safe reason, missing observation or unsupported operation | no fabricated replay or success |

Check every citation against included current-capture evidence, and strictly validate action/locator/
expectation fields before any replay. Show readable interpretation; the user confirms meaning by
Verify-and-fix, not by writing executable test code. An explicit clarification answer can permit one
further bounded analysis with the same safe context and answer. Repeated ambiguity stops as unsupported;
it does not create an autonomous conversation/tool loop. A new report requires a new capture identity.

## Phase B — Correction

Only after successful execution of the baseline replay with the intended expected-condition failure,
send one stateless correction request through the same model. Supply the frozen interpretation/checks,
admitted source and safe actual baseline observations. No model tools or shell are exposed. The model
returns `summary`, cited observation IDs, `target_paths` and one UTF-8 unified diff; it cannot return
replacement commands, a new baseline, a new verification condition or its own authoritative pass.

Validate before applying any bytes:

1. Strict closed schema and valid current-run evidence references.
2. Up to eight existing permitted regular UTF-8 text files under admitted `src/`; 64 KiB patch.
3. Canonical relative paths; no absolute/dot-segment/encoded path confusion, symlink, gitlink,
   binary, rename/copy, create/delete, mode or configuration/package/lock/test/check changes.
4. Reject leaked excluded material; verify expected baseline/source/protected-input digests.
5. Apply once in a new owned clean baseline copy, with private trusted Git metadata/index outside
   runtime mounts, no original object writes, hooks/filters, 3-way repair or partial continuation.
6. Verify exact resulting tree/diff identity and expose the actual changed path list and patch digest.

This is real model-generated code correction without an authenticated autonomous coding-agent CLI.
An invalid/empty patch is generation/rejection failure, not an invitation to loop until something passes.
The legacy one-file patch validator and capture-only binary handling retain their original contracts.

## Invocation Provenance and Limits

Record host invocation/run/phase identity, requested model, validated observed response model/response
ID, input digest, included safe evidence/source IDs, outcome, and safe optional usage/status/latency.
Reject mismatched/missing response identity or invalid phase content. No raw provider body/prompt/key/
reasoning enters logs or retained evidence. Two normal calls: analysis and correction. A third is allowed
only for explicit user clarification; no hidden automatic retry or model switch. Default tests may use
an in-process fake only when explicitly labelled; that result cannot satisfy real live acceptance.

Automatic budgets: 90 seconds per exchange and 600 seconds aggregate automatic run work, excluding
human demonstration, clarification, interpretation review and result review. Cancellation aborts the
request and remains sticky if a response arrives afterward. A timeout is a timeout, not a model verdict.

## Offline Execution Boundary

New project execution uses preprepared digest-pinned image and dependency manifest, non-root UID/GID,
read-only rootfs, dropped capabilities, no-new-privileges, private tmp/HOME, explicit environment,
CPU/memory/PID limits and `--network=none`. No original tree/Git history/host home/profile/Docker socket/
provider credential mount. Do not reuse the existing bridge-network editor or host worktree builder as
fallbacks. Project/config-supplied commands are confirmed direct argv confined to this runtime, not
trusted host commands or enforced merely by a string in `declaredProjectCommands`.

Build/check owned copies, then verify their admitted source/config/check hashes remain unchanged.
Stop/join the producing runtime before accepting its output, copy bounded regular output through
no-follow paths into a separate immutable serving root, and bind its digest to the phase/result.
Never serve mutable output still writable by a candidate process, execute built code in the host,
follow output symlinks, or allow the candidate to name arbitrary artifacts. Prepared dependency cache
is read-only and hash-bound; project runtime cache/output are separate owned paths.

## Verification and Terminal Reduction

Mandatory checks in the new family:

- Admission/configuration/dependency/baseline consistency.
- Complete usable capture, safe image/error observations and valid real interpretation.
- Frozen definition integrity and fully executed baseline replay with the intended task-condition fail.
- Actual correction invocation and valid exact candidate application.
- Candidate isolated build, every confirmed required project check, and unchanged source/check inputs.
- Identical frozen replay with every required expected condition passing on exact candidate output.
- Run/baseline/report/definition/candidate/build/evidence identity and safe artifact availability.
- Original checkout content/index/branch/revision integrity and complete verified owned-resource cleanup.

Each mandatory check is passed, failed or not evaluated, with its reason and actual evidence. Do not
convert absent collectors, wrong-run screenshots, a local animation ending, disconnected SSE, model
prose or a fixture patch into a pass. Keep baseline action-execution failure distinct from the intended
expected-condition failure. Baseline already satisfying the condition ends not reproduced before patching.

Terminal `passed` is permitted only after all obligations, integrity and cleanup. Display **Project
verification passed** with declared-check limitations. Cancellation, original-integrity failure and
cleanup failure override any earlier provisional pass. Preserve fixed safe primary error plus additional
check blockers rather than collapsing every problem into an unexplained generic failure.

After finalization retain safe evidence and exact patch/diff outside the selected repo and target
serving root. Results never imply original application, a commit, PR, merge or deployment. No universal
hostile-code correctness or general visual-pixel privacy claim is added; see Plan risks and research.
