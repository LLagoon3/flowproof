# Quickstart: Validate the Isolated Agent Editing Runtime

This guide defines the runnable acceptance path for the completed feature. It uses only synthetic
fixtures and a deterministic agent image. It does not require a model-provider credential and does
not exercise candidate generation, replay, or `Verified Fix`.

## Prerequisites

- Linux development host
- Node.js 24+ and pnpm 10+
- Git CLI
- Local Docker Engine/CLI supporting the security and resource flags in [plan.md](./plan.md)
- Current branch `feat/002-agentic-sandbox-editing`
- No provider API key or host agent configuration is needed

Confirm the local tools:

```bash
node --version
pnpm --version
git --version
docker version
docker info --format '{{json .SecurityOptions}}'
```

The Docker security output must include seccomp. The implementation records whether rootless and an
LSM profile are available; it must not falsely report rootless mode on a rootful daemon. This v1
slice rejects a rootless daemon during preflight because its user-namespace mapping would make the
controller-owned bind mount unwritable by the required non-root container user.

## Build the deterministic fixture image

```bash
docker build \
  --file tests/fixtures/editing-agent/Dockerfile \
  --tag flowproof-editing-agent:test \
  tests/fixtures/editing-agent
```

The test harness resolves the local image to an immutable digest or image ID before registering the
fixture profile. A session request never chooses the image tag directly.

## Run focused contract and unit verification

```bash
pnpm exec vitest run \
  tests/contract/editing-session-contract.test.ts \
  tests/unit/editing-session-state.test.ts \
  tests/unit/editing-docker-cli.test.ts
```

Expected outcomes:

- invalid requests fail before any clone or container side effect;
- omitted limits resolve to 120-second wall clock, 5-second stop grace, 1-GiB memory, 1 CPU,
  256 PIDs, and 64-KiB diagnostics;
- exact v1 minima and maxima pass while below-minimum, above-maximum, non-finite,
  fractional-integer, non-whole-second stop-grace, and string-coerced values fail before side
  effects;
- legal lifecycle transitions and first-terminal-cause races are deterministic;
- Docker argv contains every required restriction and rejects image, mount, network, shell, and
  resource-limit injection;
- result diagnostics are bounded and sanitized and contain no candidate or verification field.

## Run the successful editing-session scenario

```bash
pnpm exec vitest run tests/integration/editing-session.test.ts
```

The deterministic fixture must:

1. receive the exact selected commit in `/workspace`;
2. inspect the synthetic project and change at least three files;
3. read the task document and run the declared synthetic project command;
4. fetch one public technical resource through ordinary bridge networking;
5. exit successfully within 120 seconds;
6. verify its own three expected edits before exit; and
7. return `executionOutcome=completed` and `cleanup.status=complete` without exposing workspace
   contents or metadata.

After the result resolves, assert that:

- the original repository's tracked state, index, branch, `HEAD`, history, local Git configuration,
  and complete registered-worktree list equal the pre-session snapshot;
- no session container, workspace, task document, or session-created temporary path remains;
- the result contains no diff, candidate, replay, gate, or verification verdict.

## Run termination and cleanup scenarios

```bash
pnpm exec vitest run tests/integration/editing-session-cleanup.test.ts
```

Prepared Docker cases cover non-zero exit, startup failure, timeout, explicit cancellation,
cancellation racing with completion, descendant processes, repeated cleanup, seeded secret and
host-path diagnostics, and a transient cleanup interruption recovered by bounded retry. Every
prepared integration case must preserve the execution cause, report cleanup
independently, leave no owned residue, and leave unrelated containers and workspaces untouched.

Contract/unit tests separately inject a persistent final cleanup failure. That result must retain the
execution outcome, report `cleanup.status=failed`, and identify the remaining owned resource category;
it is not treated as an acceptance success and does not claim the no-residue invariant.

Inspect for residue after the suite:

```bash
docker ps -a --filter label=dev.flowproof.editing-session
```

The command must print no test-session container. The test harness also checks its private temporary
root directly and compares the original repository snapshot.

## Run repository regression gates

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm exec playwright test --pass-with-no-tests
git diff --check
```

Existing Hero and Failure behavior must remain unchanged. No credential-gated live Meta run is
required because this feature does not connect the editing runtime to the production verification
flow.

## Known boundary

Passing this guide proves containment against the approved accidental-error and failed-process threat
model on the prepared Linux/Docker environment. It does not claim resistance to a malicious kernel,
Docker daemon, container-runtime escape, target repository, or model, and it does not prove that agent
edits are a valid candidate. Default bridge networking may reach host/LAN/private, link-local, and
cloud-metadata services; private-network egress isolation is future hardening, not a property proved
by this feature. Host-side content enumeration and analysis, symlink and special-file handling, and
authoritative change capture are likewise deferred to the next specification.
