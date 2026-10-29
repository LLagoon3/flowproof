# Implementation Plan: Isolated Agent Editing Runtime

**Branch**: `feat/002-agentic-sandbox-editing` | **Date**: 2026-10-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-agentic-sandbox-editing/spec.md`

## Summary

Add an internal editing-session service that prepares a standalone clone at an exact commit, mounts
only that disposable clone into a constrained Docker container, starts one registered coding-agent
runtime, and owns cancellation, timeout, final-state inspection, and idempotent cleanup. The host
controller remains trusted; the agent receives no original-repository, home-directory, Docker-socket,
device, or privileged host mount. General outbound internet remains available through Docker bridge
networking. This feature returns only a sanitized lifecycle result and deliberately does not compute
an authoritative diff, admit a candidate, replay a change, or alter the existing Hero/Failure flow.

## Technical Context

**Language/Version**: TypeScript 7.0.2 on Node.js 24+
**Primary Dependencies**: Existing Node.js standard library (`child_process`, `fs`, `path`,
`timers`), Git CLI, Docker Engine/CLI; existing Zod 4.6.7 and FlowProof sanitization utilities; no
new runtime npm dependency
**Storage**: Session-scoped operating-system temporary directories, a standalone local Git clone,
an ephemeral Docker container layer, and tmpfs mounts; no database or new persistent product store
**Testing**: Vitest contract, unit, and Docker-backed integration tests with a deterministic fixture
agent and synthetic repository; existing FlowProof suites remain regression gates
**Target Platform**: Prepared Linux development host with a local Docker Engine; validated during
planning on Docker Engine 29.1.3 with built-in seccomp, AppArmor, and cgroup namespaces
**Project Type**: Node.js CLI/library in the existing pnpm monorepo
**Performance Goals**: The deterministic three-file fixture, one declared project command, and one public
HTTP fetch complete within 120 seconds excluding image preparation; cancellation or timeout begins
forced cleanup within the configured stop grace period
**Constraints**: Exact committed baseline; no original checkout or Docker socket visible in the
container; read-only container root; writable workspace and bounded tmpfs only; non-root process;
finite CPU, memory, PID, and wall-clock limits; bounded sanitized diagnostics; no shell interpolation
in host-side Docker or Git calls
**Scale/Scope**: One project revision and one agent process tree per session. The service owns no
queue or scheduler, exposes no new Studio/CLI route, and does not migrate existing verification runs.

## Constitution Check

*GATE: Passed before research and re-checked after design.*

### I. Clean-Room Development — PASS

- Tests use a synthetic repository, deterministic fixture agent, seeded fake credentials, and public
  documentation endpoints only.
- The runtime image and third-party tools must have documented public licenses before a production
  runtime profile is registered. This PR needs no live provider account.

### II. Scope and Justified Complexity — PASS

- The feature stops at the editing-session boundary. Diff extraction, candidate admission, replay,
  UI/API exposure, provider-specific agent installation, and a verifier container remain excluded.
- Docker, a standalone clone, a lifecycle state machine, and explicit cleanup are necessary to meet
  the isolation, exact-baseline, cancellation, and residue requirements. No generalized sandbox
  framework or pluggable orchestration platform is introduced.

### III. Risk-Based Verification — PASS

- Lifecycle transitions, Docker argv generation, request/result contracts, sanitization, cancellation
  races, and idempotent cleanup are test-first because mistakes can mutate host state or leave
  processes behind.
- Docker-backed integration cases cover success, non-zero exit, startup failure, timeout,
  cancellation, transient cleanup interruption with bounded recovery, external fetch, seeded secret
  exclusion, and original-repository integrity. Contract/unit tests cover persistent cleanup failure
  without claiming acceptance success. Existing unit, contract, integration, build, and typecheck
  suites remain regression gates.

### IV. Security by Design — PASS WITH DOCUMENTED RESIDUAL RISK

- The agent gets only the disposable clone, a read-only session task document, bounded tmpfs,
  and ordinary bridge networking. It gets no original repository, personal home, host credential
  store, device, host network, privileged mode, or container-engine socket.
- The runtime drops all Linux capabilities, enables `no-new-privileges`, requires Docker's default
  seccomp profile, uses an AppArmor/LSM profile when available, runs as a non-root UID/GID, publishes
  no ports, and applies CPU, memory, PID, and time bounds.
- The prepared host currently uses a rootful Docker daemon. The trusted FlowProof controller can
  therefore ask Docker to create containers, but the untrusted container cannot reach the daemon.
  Rootless Docker is recommended deployment hardening, not claimed by this feature. Deliberate kernel,
  daemon, or container-runtime escape is outside the approved threat model.

## Architecture and Lifecycle

### Trust boundary

1. The trusted host controller validates the request, resolves the exact commit, and captures the
   existing original-repository integrity snapshot.
2. It creates a session root in operating-system temporary storage and makes a standalone
   `git clone --no-hardlinks --no-checkout` from the local repository. It checks out the selected
   commit detached, removes the local `origin`, and verifies that no alternates or source path remain
   in clone configuration.
3. It resolves an in-process registered runtime profile to an immutable OCI digest or local image
   ID and argv. A user request cannot inject Docker flags, image names, mounts, entrypoints, or shell
   fragments. The controller writes the bounded task and declared project-command context to a
   session-owned `task.json`; these declarations guide the agent but are not an operating-system
   command allowlist.
4. It creates a named, labeled Docker container with only the disposable clone mounted read-write at
   `/workspace`, `task.json` mounted read-only at `/run/flowproof/task.json`, a read-only root
   filesystem, bounded tmpfs for `/tmp` and the agent home, and no published ports or host-control
   mounts. The registered fixed argv reads the task document from that fixed path.
5. `docker start --attach` owns stdout/stderr collection. A bounded ring buffer feeds the existing
   sanitizer; raw output and inherited host environment never enter the result or persistent
   artifacts.
6. Completion, failure, timeout, or cancellation selects the first execution terminal cause. The
   controller then stops or kills the exact container ID, invokes the trusted bounded final-state
   inspector, removes that container, deletes the task document and workspace state, and verifies
   the original repository snapshot.
7. Cleanup is idempotent and exact-ID scoped. Cleanup reports `complete`, `recovered`, or `failed`
   independently of the prior execution outcome. `recovered` means a bounded retry removed all
   residue; `failed` identifies the remaining owned resource and is not an acceptance success.
   Unrelated containers, workspaces, and Git registrations are untouched.

### Container policy

The Docker CLI adapter must generate argv equivalent to the following policy without invoking a
shell:

- `--init`, `--read-only`, `--cap-drop=ALL`, and
  `--security-opt=no-new-privileges`
- non-root `--user` and a fixed `/workspace` working directory
- explicit `--memory`, `--memory-swap`, `--cpus`, and `--pids-limit`
- bounded tmpfs mounts for `/tmp` and the agent home with `nosuid,nodev`; `/tmp` is also `noexec`
- one `--mount type=bind` for the FlowProof-created workspace with private propagation
- one read-only bind mount for the FlowProof-created task document at
  `/run/flowproof/task.json`; callers cannot supply its source path
- default bridge networking for outbound resources, never `host`, `container:*`, or a
  caller-selected network; no published or exposed host ports. Docker bridge egress can still reach
  host/LAN/private, link-local, or cloud-metadata addresses, so this feature makes no private-network
  isolation claim
- an immutable OCI digest or local image ID from the registered runtime profile and an argv array,
  never a mutable tag or shell command string

The implementation performs capability preflight against the local Docker daemon and returns
`startup_failed` before agent execution if required isolation flags, including seccomp, are
unsupported. AppArmor/LSM availability is observed and recorded but is not a preflight blocker.

### Cancellation and race handling

- `startEditingSession` returns a handle with an immutable session ID, a result promise, and an
  idempotent `cancel()` method.
- An `AbortSignal`, explicit cancellation, timeout, and process exit converge on one atomic terminal
  selection. The first terminal cause wins; all callers await the same finalization promise.
- Graceful stop is bounded. When the grace period expires, the controller force-removes the exact
  container ID. Docker `--init` reaps descendants while the container boundary ensures remaining
  session processes disappear with the container.
- Final-state inspection runs after the agent process has stopped and before workspace deletion. It
  is a fixed metadata-only implementation that uses `lstat`, never follows symlinks or reads special
  files, verifies resolved parents remain under the session root, and never executes repository
  commands or trusts repository-controlled Git configuration, hooks, or attributes. It is
  time-bounded and cannot produce a diff or promote the result to candidate or verification success.

## Project Structure

### Documentation (this feature)

```text
specs/002-agentic-sandbox-editing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── editing-session.md
└── tasks.md                 # Created by the Tasks phase, not this Plan
```

### Source Code (repository root)

```text
packages/flowproof/src/
├── git/
│   └── repositoryState.ts # Shared shell-free Git runner and repository snapshot primitives
├── editing/
│   ├── contracts.ts        # Internal request, handle, result, limits, and runtime profile types
│   ├── dockerCli.ts        # Shell-free Docker argv, capability preflight, exact-ID operations
│   ├── runtimeProfile.ts   # Trusted profile registry and immutable image/argv resolution
│   ├── session.ts          # Lifecycle, cancellation, timeout, inspection, and finalization owner
│   └── workspace.ts        # Standalone clone preparation, scrubbing, snapshot, and disposal
└── evidence/
    └── sanitize.ts         # Existing sanitizer reused for bounded diagnostics

tests/
├── contract/
│   └── editing-session-contract.test.ts
├── unit/
│   ├── editing-session-state.test.ts
│   └── editing-docker-cli.test.ts
├── integration/
│   ├── editing-session.test.ts
│   └── editing-session-cleanup.test.ts
└── fixtures/
    └── editing-agent/
        ├── Dockerfile
        ├── agent.mjs
        └── project/
```

**Structure Decision**: Keep the feature inside the existing `flowproof` package because it is an
internal engine service, not a new application or deployable service. The Docker fixture belongs
under tests and proves the boundary without committing to a provider-specific production agent.
No existing `run.ts`, Studio route, UI component, or scenario contract changes in this feature.
The implementation extracts only the existing shell-free Git runner/environment and repository
snapshot logic from `worktree/session.ts` into `git/repositoryState.ts`, then reuses it from both the
existing worktree path and the new standalone-clone path.

## Requirement-to-Design Mapping

- **FR-001, FR-011**: standalone no-hardlink clone at the resolved commit, scrubbed source metadata,
  pre/post integrity snapshot, and exact session-root disposal
- **FR-002, FR-003, FR-004**: one workspace mount, registered argv, non-root container policy,
  read-only task document, ordinary bridge egress, and explicit absence of home, credentials,
  devices, host network, and Docker socket; private-network reachability remains documented rather
  than claimed as blocked
- **FR-005, FR-006**: validated bounded limits, result promise, `cancel()`, `AbortSignal`, graceful
  stop deadline, and forced exact-container removal
- **FR-007, FR-008**: execution outcome plus cleanup outcome, bounded timing and sanitized diagnostic,
  no raw stdout/stderr persistence
- **FR-009**: trusted time-bounded metadata inspector after process stop and before workspace
  disposal, with symlink/special-file/repository-command escape protections
- **FR-010**: exact container ID ownership, idempotent finalizer, session-created path manifest, and
  post-cleanup residue scan
- **FR-012**: result contract contains no diff, candidate, replay, gate, or verification verdict

## Post-Design Constitution Re-check

All four Constitution gates still pass. Phase 1 adds no new product surface, persistent storage, or
provider commitment. The small shared Git helper extraction prevents duplicate security-sensitive
process/snapshot logic. Rootful-daemon privilege and bridge-network reachability to private,
link-local, metadata, LAN, and host-bound services remain explicit residual risks and are not
represented as hostile-code or private-network isolation.

## Complexity Tracking

No Constitution violation requires an exception.
