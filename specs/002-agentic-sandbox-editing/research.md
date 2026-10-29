# Research: Isolated Agent Editing Runtime

## Decision 1: Use a local Docker container as the execution boundary

**Decision**: Run the agent in a Docker container created by the trusted FlowProof host process.
Require the standard Docker isolation controls used in the Plan and fail before execution when the
daemon cannot support them.

**Rationale**: Docker provides a separate filesystem, network namespace, process tree, resource
controls, immutable image reference, and a single container ID that the lifecycle owner can stop and
remove. The prepared Linux host already has Docker Engine 29.1.3 with built-in seccomp, AppArmor,
and cgroup namespaces. A planning probe successfully wrote three files through the sole workspace
mount and fetched `https://example.com` under the proposed capability, privilege, resource, rootfs,
tmpfs, user, and bridge-network restrictions; `--rm` left no matching container.

**Alternatives considered**:

- A host child process or detached Git worktree does not protect host paths, credentials, or process
  resources from agent mistakes.
- `node:vm` isolates JavaScript language state, not arbitrary coding-agent commands or filesystem
  access.
- A microVM provides a stronger hostile-workload boundary but exceeds the approved accidental-error
  threat model and one-PR scope.
- Kubernetes adds deployment and orchestration surface without improving the local single-session
  product outcome.

**Evidence**:

- [Docker: Running containers](https://docs.docker.com/engine/containers/run/)
- [Docker: Seccomp security profiles](https://docs.docker.com/engine/security/seccomp/)
- [Docker: Rootless mode](https://docs.docker.com/engine/security/rootless/)

## Decision 2: Prepare a standalone clone, not another linked worktree

**Decision**: Create an OS-temp `git clone --no-hardlinks --no-checkout`, detach at the trusted
resolved commit, remove `origin`, and reject residual alternates or source paths before mounting the
clone.

**Rationale**: A standalone clone preserves Git-native multi-file editing and future diff capability
without registering a worktree or leaving `.git` pointers into the original repository's common Git
directory. `--no-hardlinks` prevents the disposable clone from sharing mutable object files with the
source. Removing `origin` avoids leaking an absolute host path to the container.

**Alternatives considered**:

- The existing detached-worktree helper is appropriate for trusted patch replay but writes temporary
  administrative state beneath the original Git common directory and exposes a `.git` indirection.
- `git archive` gives an exact tree without source metadata, but reconstructing a Git baseline loses
  useful commit identity and mode/history behavior needed by a realistic coding agent.
- A plain recursive copy includes unrelated local changes and cannot prove the exact selected commit.

## Decision 3: Use the Docker CLI through shell-free argv

**Decision**: Wrap `docker create`, `start --attach`, `stop`, `inspect`, and `rm -f` with Node
`child_process.spawn`/`execFile`, explicit argv, bounded output, and exact returned container IDs.
Add no Docker SDK dependency.

**Rationale**: The repository already uses shell-free child-process wrappers. The CLI exposes the
required security and resource flags, and exact argv is easy to contract-test. Avoiding a new SDK
reduces dependency and daemon-API compatibility surface.

**Alternatives considered**:

- `dockerode` or another Engine SDK adds a transitive dependency and API lifecycle without a current
  requirement that the CLI cannot meet.
- Shell command strings make image, path, task, and flag injection harder to rule out.

## Decision 4: Resolve only registered runtime profiles

**Decision**: A trusted in-process registry maps a fixed profile ID to an immutable OCI digest or
local image ID, entrypoint argv, non-secret environment allowlist, and resource bounds. Session
input can select a registered ID but cannot supply an image, Docker option, mount, network,
entrypoint, or shell text. The controller writes bounded task text and declared project-command
context to a session-owned JSON document mounted read-only at `/run/flowproof/task.json`; the fixed
runtime argv reads that path. Command declarations are context, not an enforced command allowlist.

**Rationale**: The feature needs an agent execution seam without exposing a general container runner.
Content-addressed image references make the executed runtime observable and repeatable. A
deterministic registered fixture profile proves the seam without adding a provider-specific CLI or
live-account dependency.

**Alternatives considered**:

- Arbitrary caller images or commands turn the internal service into a privileged container API.
- Bundling Codex, Claude Code, or another provider CLI in this PR creates an unnecessary provider,
  license, update, and reusable-credential commitment.
- A FlowProof file-tool broker conflicts with the approved model of an ordinary coding agent working
  inside its container and is not needed for accidental-error containment.

## Decision 5: Keep general outbound internet through bridge networking

**Decision**: Use Docker's default bridge networking with no host networking, caller-selected
network, or published ports. Permit outbound access to public technical resources, while explicitly
documenting that default bridge egress can also reach host/LAN/private, link-local, and cloud-metadata
addresses unless the deployment adds a separate egress policy.

**Rationale**: The specification explicitly requires general technical research and rejects a
provider-only egress boundary. The container has no privileged host-control mount or socket, but
bridge networking alone is not private-network isolation. This feature's protected-host claim is
limited to mounts, sockets, devices, and privileged controls; it does not claim to block network
access to services reachable from the Docker bridge.

**Alternatives considered**:

- `--network=none` fails the public-resource scenario.
- A provider-only proxy prevents ordinary web research and contradicts the approved scope.
- A general egress filtering proxy could block private address ranges while preserving the web, but
  it adds a second service and policy surface not required by the current accidental-error threat
  model. It remains optional future hardening.

## Decision 6: Add no credential channel in this feature

**Decision**: The runtime profile, session request, container mounts, and environment contain no
provider credential or credential-provider seam. The deterministic fixture needs no authentication.
A future production agent/authentication feature must define and review its own credential boundary.

**Rationale**: No production provider runtime is selected in this PR, so a generic secret
materializer would add unused security surface and imply a guarantee the current sanitizer cannot
make for arbitrary opaque credentials. Omitting the channel keeps this runtime slice independently
testable and prevents accidental inheritance of host authentication state.

**Alternatives considered**:

- Mounting the host agent configuration or personal home exposes reusable credentials and unrelated
  state.
- Environment variables are visible to every project command and may appear in process inspection
  or diagnostics.
- A generic short-lived secret materializer still creates a security contract with no consumer in
  this feature.
- A provider proxy or production-agent credential exchange can be considered by a later numbered
  specification without limiting the general bridge-network research path here.

## Decision 7: Model execution and cleanup outcomes separately

**Decision**: Record one execution outcome (`completed`, `failed`, `timed_out`, `cancelled`, or
`startup_failed`) and one cleanup outcome (`complete`, `recovered`, or `failed`). `recovered` means
a transient cleanup interruption was resolved by bounded retry and no owned residue remains.
`failed` means final restoration is incomplete and identifies the remaining owned resource. Preserve
the execution outcome instead of replacing it.

**Rationale**: The caller needs both why the agent stopped and whether containment was restored.
Separating the dimensions avoids hiding a successful or failed execution behind a cleanup error and
makes every terminal path testable.

**Alternatives considered**:

- One flat `cleanup_failed` terminal value loses the preceding execution cause.
- Throwing on cleanup failure prevents a stable sanitized result and complicates idempotent callers.

## Decision 8: Reuse sanitization and keep diagnostics bounded

**Decision**: Capture stdout/stderr into fixed-size ring buffers, sanitize through the existing
FlowProof sanitizer before returning or persisting anything, and return fixed coded startup/cleanup
messages for host-tool failures. Absolute session paths are replaced with stable placeholders.

**Rationale**: Agent and project output is untrusted and can contain secrets, host paths, provider
payloads, or unbounded logs. Reusing the existing tested sanitizer avoids a competing redaction
system.

**Alternatives considered**:

- Returning raw Docker/Git stderr violates the diagnostic requirement.
- Persisting full logs and redacting on read leaves secret-bearing data at rest.

## Decision 9: Defer host-side workspace inspection to change capture

**Decision**: Do not enumerate, open, or analyze agent-authored workspace contents in this feature.
Cleanup treats the validated session root as opaque disposable state. The deterministic fixture
verifies its own expected edits before exiting, while the trusted controller records only execution,
diagnostic, runtime, cleanup, and original-repository integrity outcomes. A later numbered
specification will define safe host-side content traversal, symlink and special-file handling, the
authoritative changed-file manifest, and diff construction against the exact baseline.

**Rationale**: Inspecting untrusted workspace contents safely is part of authoritative change
capture, not the sandbox lifecycle or agent-execution boundary. Deferring it keeps this one-PR slice
focused and avoids implementing a second, non-authoritative traversal path that the next feature
would replace.

**Alternatives considered**:

- A metadata-only production inspector still needs the same symlink, special-file, Git-control-file,
  deadline, and path-containment defenses as later authoritative change capture.
- Returning the live workspace path after the session result weakens cleanup ownership and permits
  indefinite residue.
- Computing a Git diff now would pull candidate admission and verification concerns into this PR.

## Decision 10: Treat rootless Docker as recommended hardening, not a claim

**Decision**: Support a local Docker Engine and record whether rootless mode is active during
preflight. Require all container-level restrictions regardless. Document rootful operation as a
residual risk and do not claim hostile-code isolation.

**Rationale**: Docker's rootless mode reduces daemon and runtime privilege, but the prepared host is
currently rootful. The agent never receives the Docker socket, and deliberate runtime escape is
outside the approved threat model. Requiring a host migration would expand this feature into system
administration rather than product implementation.

**Alternatives considered**:

- Pretending the current daemon is rootless would make the security claim false.
- Blocking implementation until a rootless migration would add operational scope without changing
  the accepted accidental-error product boundary.
