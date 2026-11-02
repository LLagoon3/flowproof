# Implementation Plan: Capture Editing Changes

**Branch**: `feat/003-capture-editing-candidate` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Approved capture-only scope, including ordinary Git changes and automatic cleanup.
**Stage**: Design only. No production implementation or acceptance-suite execution is claimed.

## Summary

Add one opt-in sibling of the current editing-session entry point. After successful editor
termination, use Git's existing index/tree/diff machinery to capture main-repository changes before
workspace disposal. Return either a complete unverified candidate, no changes, or a safe reason.
Keep existing lifecycle-only callers and production Hero/Failure behavior unchanged.

Reuse Git, the existing Docker session, secret scanner, and cleanup. Do not introduce a file/extension
allowlist, policy registry, retry framework, new service, or dedicated verification container.

## Technical Context

**Language/Version**: TypeScript 7.0.2, Node.js 24+; prepared host Node 24.22.1.
**Primary Dependencies**: Existing Git CLI (probed 2.53.0), Docker CLI/Engine, Node standard library,
Zod 4.6.7, and FlowProof Git/sanitization helpers. No new npm package or network service.
**Storage**: Existing private session root; one host-owned temporary Git directory/index/object store
outside the agent bind mount. Bounded candidate bytes returned in process; no new persistent store.
**Testing**: Vitest 5.0.5 contract/unit/Git integration and existing Docker fixture; existing regression
and Playwright 1.64.1 suites. No live model or user-operated gate is required.
**Target Platform**: Existing prepared Linux/Docker environment; no new platform/rootless claim.
**Project Type**: Internal engine capability in the existing pnpm monorepo.
**Performance Goals**: Capture terminates within one 60-second deadline and a 32-MiB aggregate
materialization budget. These reuse existing Git-helper scale, not a new performance SLA or five-axis
policy. The implementation must terminate and join capture subprocesses before disposal.
**Constraints**: Successful stopped editor only; no writes to original checkout/metadata; no external
link traversal, project hooks/filter commands, silent partial candidates, or verified-fix claims.
**Scale/Scope**: One session and one main repository. Submodule references only; nested working-tree
contents are explicitly not inspected or captured. This is not a recursive filesystem backup.

## Constitution Check

*GATE: PASS before research and re-checked after design.*

- **I. Clean-Room Development — PASS:** synthetic repositories, seeded fake markers, prepared local
  fixture images, and public Git documentation only. No proprietary data or provider credential.
- **II. Scope and Justified Complexity — PASS:** one concrete capture path reuses existing Git and
  session infrastructure. A private capture index/store prevents touching editor staging or original
  metadata; it is not another execution environment. No new UI, service, permission broker, scanner
  suite, policy plug-in, repair scheduler, or separate verifier.
- **III. Risk-Based Verification — PASS:** test-first for byte-preserving extraction, successful-stop
  gating, sensitive-data rejection, bounded subprocess termination, and cleanup. Documentation-only
  Plan work needs document/probe validation, not claims about unimplemented acceptance tests.
- **IV. Security by Design — PASS within inherited threat model:** keep original host isolation and
  existing sensitive-data checks. Host-owned Git config avoids running agent-configured hooks/filters.
  Ordinary link/gitlink records are supported without following external targets. This does not add
  protection against hostile tenants, a compromised daemon/kernel, or unknown credential formats.

## Project Structure

### Documentation (this feature)

```text
specs/003-capture-editing-candidate/
├── spec.md
├── checklists/requirements.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/capture-session.md
└── quickstart.md
```

`tasks.md` is the next phase's output, not part of this Plan invocation.

### Source Code (planned, not yet implemented)

```text
packages/flowproof/src/editing/
├── capture.ts          # concrete capture result/types and extraction orchestration
├── captureGit.ts       # small binary-safe Git runner and private-index operations
├── session.ts          # opt-in sibling entry point, shared private runner
├── workspace.ts        # private capture metadata and owned cleanup integration
└── dockerCli.ts        # narrow workspace-view check for opt-in capture

tests/
├── contract/editing-capture-contract.test.ts
├── unit/editing-capture.test.ts
├── integration/editing-capture-git.test.ts
├── integration/editing-capture-session.test.ts
├── support/editingFakes.ts
└── fixtures/editing-agent/agent.mjs
```

**Structure Decision**: Keep capture local to editing. Reuse `gitEnvironment`, `GIT_SAFETY`, the
existing scanner and fixture support. Do not route through `patch/validateDiff.ts`: its one-file,
text-only, apply-check rules belong to the current production demo, not this capture boundary.

## Design

### 1. Preserve the existing entry point

`startEditingSession()` keeps its strict request, handle, result fields, and lifecycle-only behavior.
Add `startCapturingEditingSession()` with the same request/handle pattern and an injected existing
`SecretScanner`. Its result wraps the old session result with a separate capture result. A private
shared runner has a concrete capture branch, not a public callback or extensible finalization API.
See [the internal contract](./contracts/capture-session.md).

### 2. Prepare trusted capture state before editor launch

Only capture mode creates a private Git directory beneath the session root, outside `/workspace`.
Pin baseline commit and original object-directory location from trusted preparation, not editor HEAD.
Use the trusted original object store as a read-only alternate; all new index/object writes go to the
private capture directory. No alternate or original path is placed inside the agent's clone or result.
Record the capture directory in workspace ownership cleanup; no lease or separate resource service.

### 3. Capture only the stopped successful filesystem

After existing terminal selection and Docker state inspection, require started, not running, no
startup error, and exit code zero. Attach-client exit alone is insufficient. Check that the root
`/workspace` bind is the expected workspace and that no nested container mount obscures it. If that
view cannot be established, reject capture; do not export or merge anonymous volumes.

Seed a private index from the pinned baseline. Read final editor index path/type metadata only to
retain force-added ignored files; staged contents/HEAD are not the authoritative final result.
Refresh existing tracked paths from actual filesystem contents and add ordinary non-ignored new
files with Git. Preserve text/binary bytes, executable modes, symlink records, and gitlink references.
Use built-in normalization/attributes semantics, but no edited local/global config or external filters.
A narrow no-follow walk detects non-versionable special entries that Git otherwise silently skips;
prune ignored untracked directories and do not recursively inspect nested repositories.

Write a final tree and use Git's binary-capable, full-object-ID diff against the pinned baseline,
with external diff/text conversion disabled. NUL-delimited metadata drives a matching file summary.
Rename inference is unnecessary; delete/add is equivalent. No semantic code review occurs here.

### 4. Reuse the existing sensitive-data boundary

Scan relevant raw before/after changed blobs and path bytes before returning anything, not only
encoded binary-patch text. Existing text detection covers credential patterns and seeded markers;
existing binary detection covers seeded markers only. Dispatch valid UTF-8, NUL-free payloads/names
as text and other bytes as binary, so text credential checks are not lost by passing every blob as a
Buffer. Also check exposed diff/summary surfaces.
Reject rather than redact a patch. No general binary DLP, dependency scanning, or full-workspace
secret-free claim is added. Ignored untracked files and nested working trees are not output artifacts.

### 5. Finish with existing cleanup and explicit outcomes

Catch capture rejection/failure into result data, then run existing exact-container removal
(`--force --volumes`), workspace disposal, and original-repository integrity comparison. Include capture
scratch in existing workspace cleanup accounting. A valid captured candidate is not erased solely
because a later cleanup step failed; return the distinct cleanup failure and never call the overall
run clean or verified. No automatic repair follows a rejection.

Cancellation during capture aborts the bounded capture subprocess and yields no partial candidate;
it does not rewrite a completed editor execution into a different historical outcome. Existing
lifecycle-only cancellation semantics remain unchanged.

### 6. Keep only two fixed capture bounds

Reuse the existing Git helper constants as initial fixed capture ceilings: 60 seconds total and
32 MiB cumulative materialized bytes across metadata, patch, and changed payload checks. Count both
stdout/stderr and raw payload reads against this budget as they are consumed; exceeding it rejects
without publishing a truncated patch. Avoid a separate size/count/type policy API. A timeout or
cancellation terminates and joins the capture-owned Git process group before workspace deletion,
including Git helpers, without signaling unrelated processes. Concrete details
and limitations are in [research.md](./research.md).

## Verification and Delivery

- SC-001: synthetic text/binary/add/delete/move/mode/link/gitlink fixtures; force-added ignored files,
  untracked files, staged-only partial changes, and editor local commits use the same baseline.
- SC-002: unchanged/reverted results; non-versionable entries, obscured mounts, read errors, byte/time
  limits, fixed safe reasons, no partial candidate, and zero retry calls.
- SC-003: raw before/after binary/text/path markers; no sensitive excerpt in reason or summary.
- SC-004: real stopped success versus attach-only exit, failure/timeout/cancel skip capture, capture
  interruption, normal cleanup and injected cleanup failure, original unchanged and scratch residue.
- SC-005: existing strict lifecycle contract and Hero/Failure regression suites remain unchanged.

Follow [quickstart.md](./quickstart.md) during implementation. One Spec/one PR remains the approved
scope; Tasks may use small sequential implementation checkpoints within that PR. No push, PR,
implementation, or future verification integration is authorized by this design.

## Complexity Tracking

No Constitution deviation. No independent architecture-review gate is triggered: this remains one
internal capability with no new user surface/service/browser lifecycle. Research was independently
checked in two bounded read-only investigations, as required by the installed planning workflow.
