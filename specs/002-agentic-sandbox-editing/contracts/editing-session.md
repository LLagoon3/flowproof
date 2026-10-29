# Internal Contract: Editing Session Service

This is an in-process engine contract. This feature adds no public HTTP route, Studio request field,
CLI option, or scenario-schema field.

## Service boundary

```text
startEditingSession(request, dependencies) -> EditingSessionHandle

EditingSessionHandle:
  id: string
  result: Promise<EditingSessionResult>
  cancel(reason?): Promise<void>
```

`request` is immutable after validation. `dependencies` contains only trusted runtime profiles, the
Docker/Git process adapters, and a monotonic clock. The service never reads the host process
environment implicitly and defines no credential-provider dependency.

## Request contract

Required values:

- absolute `repositoryRoot` known to the trusted caller
- exact `revision` resolving to a commit
- bounded non-empty `task`
- registered `runtimeProfileId`
- bounded `declaredProjectCommands` used as task context, not an enforced OS command allowlist
- optional wall-clock, stop-grace, memory, CPU, PID, and diagnostic overrides that resolve against
  the v1 bounds below

| Limit | Minimum | Default | Maximum |
| --- | ---: | ---: | ---: |
| `wallClockMs` | 1,000 | 120,000 | 900,000 |
| `stopGraceMs` | 1,000 | 5,000 | 30,000 |
| `memoryBytes` | 268,435,456 (256 MiB) | 1,073,741,824 (1 GiB) | 4,294,967,296 (4 GiB) |
| `cpuCount` | 0.25 | 1 | 4 |
| `pids` | 32 | 256 | 1,024 |
| `diagnosticBytes` | 4,096 (4 KiB) | 65,536 (64 KiB) | 1,048,576 (1 MiB) |

Validation fills omitted fields with the defaults before creating any session resource. Explicit
values below the minimum, above the maximum, non-finite, or of the wrong numeric kind are rejected.
`wallClockMs`, `stopGraceMs`, `memoryBytes`, `pids`, and `diagnosticBytes` must be integers;
`stopGraceMs` must also be a multiple of 1,000, and `cpuCount` may be fractional. Numeric strings are
never coerced. Runtime-profile minimum, default, and maximum values must remain ordered, may narrow
these ranges, and cannot widen them.

Rejected values and behavior:

- unknown runtime profile
- image tags, arbitrary image names, raw Docker flags, arbitrary mount sources, host-network choice,
  published ports, entrypoint overrides, or shell command strings
- unresolved revision, non-repository root, or session root inside the original repository
- unbounded or out-of-range limits
- credentials or host paths embedded in task metadata

Validation completes before the first clone, task document, container, or persistent artifact is
created. The service writes the bounded task and declared project-command context to a session-owned
`task.json`; the caller cannot choose its host path or container target.

## Runtime profile contract

The profile registry is supplied by trusted code. Each profile fixes:

- immutable OCI digest or local image ID; mutable tags are rejected
- direct argv and `/workspace` working directory
- non-secret environment allowlist with no inherited host environment or credential
- optional profile-specific resource limits that stay within and may only narrow the v1 bounds

The fixed argv reads `/run/flowproof/task.json`. The declarations inside that document guide the
agent; they do not create a command broker or operating-system allowlist.

The first implementation registers only the deterministic fixture profile in tests. The runtime
boundary supports a production profile, but bundling or selecting a provider-specific coding agent
is not part of this feature.

## Container contract

The Docker adapter must prove the created container has:

- the registered immutable image and exact FlowProof-generated labels
- no privileged mode, added capability, device, Docker socket, host home, or original-repository mount
- read-only root filesystem, all capabilities dropped, `no-new-privileges`, required default
  seccomp, non-root user, and init process; an AppArmor/LSM profile is used and recorded when available
- only the session workspace as a writable bind mount
- only the FlowProof-created task document as an additional read-only bind mount at the fixed
  `/run/flowproof/task.json` target
- bounded tmpfs, memory, swap, CPU, PID count, stop grace, and wall-clock time
- bridge networking with no host network, caller-selected network, or published port. Bridge egress
  may still reach host/LAN/private, link-local, or cloud-metadata services; this contract does not
  claim private-network isolation

The adapter uses direct argv. No request value is evaluated by a host shell.

## Completion contract

`result` resolves exactly once after finalization. It returns:

- one execution outcome: `completed`, `failed`, `timed_out`, `cancelled`, or `startup_failed`
- exit code/signal only when safely observable
- bounded duration and sanitized diagnostic
- runtime profile ID and immutable image reference
- cleanup status reporting exact-container removal, workspace removal, original-repository integrity,
  and any bounded remaining-owned-resource category

Raw stdout/stderr, Docker/Git error bodies, source absolute paths, environment values, and host
authentication state never appear in the result.

## Cancellation contract

- `cancel()` is safe before start, during execution, after process exit, during finalization, and
  after completion.
- The first selected terminal cause wins. A late cancellation cannot replace normal completion or a
  prior timeout.
- Stop waits only for the validated grace period, then force-removes the exact container ID.
- All callers observe the same finalization and result.

## Workspace-content boundary

After the container stops, this service does not enumerate, open, or analyze agent-authored
workspace contents and exposes no pre-cleanup workspace callback or path. Cleanup treats the
validated session root as opaque disposable state. The deterministic test fixture may verify its own
edits before exit, but production results contain no file metadata. Safe host-side content traversal,
symlink and special-file handling, changed-file discovery, and diff construction belong to the later
change-capture contract.

## Cleanup contract

Cleanup is idempotent and uses exact owned IDs and the session-created path manifest. It may:

1. stop or force-remove the exact session container;
2. delete only the session-created task document;
3. delete only the standalone clone and session root created for this session; and
4. compare the original repository and unrelated registered workspaces with the pre-session snapshot.

It must not prune broad Docker resources, remove by user-controlled label alone, run `git worktree
prune` against the source, or delete a path outside the validated session root. Cleanup reports:

- `complete` when finalization succeeds without retry;
- `recovered` when a bounded retry removes all owned residue; or
- `failed` when final restoration remains incomplete, with bounded exact resource categories still
  present.

Persistent `failed` cleanup is not an acceptance success. Every cleanup status is reported separately
and preserves the prior execution outcome.
