# Internal Contract: Capturing Editing Session

This is an internal TypeScript engine interface, not a new CLI, network route, or external service.
Design names are planned; no implementation is present at this stage.

## Entry points

- Existing `startEditingSession(request, dependencies)` is unchanged, including its strict request
  shape, lifecycle-only result, cancel behavior, and absence of candidate fields.
- Add `startCapturingEditingSession(request, dependencies)` using the same request validation and
  registered runtime profile. Capture dependencies add the existing required `SecretScanner` instance
  created by trusted code; no model-supplied path, scanner, or raw Docker/Git flag is accepted.
- Its handle exposes `id`, `result`, and `cancel(reason?)` in the existing style.
- `result` resolves once to `{ session, capture }` as defined in [data-model.md](../data-model.md).

Invalid input still fails before session side effects. Capture preparation/execution errors become
safe capture results and must not skip cleanup. The shared implementation is private and concrete;
no general before-cleanup callback API is introduced.

## Execution and finalization order

1. Validate the existing editing request and trusted capture dependency.
2. Create the usual workspace and private capture metadata; pin the original baseline/object source.
3. Execute the existing registered editor normally, with existing network/resource/isolation behavior.
4. Inspect the exact session container. Capture requires started, stopped, no startup error, exit zero.
5. Confirm the expected root workspace bind and absence of obscuring descendant mounts. An image
   declaring `/workspace/generated` as a separate volume cannot yield a complete host-view candidate.
6. Capture the main-repository Git change set within the single deadline/byte budget and apply the
   existing secret checks. Preserve no-change/rejection/failure distinctions.
7. Kill/join outstanding capture children before disposing of workspace/scratch. Run existing
   container-with-volumes removal, workspace cleanup, and original integrity checks on all paths.
8. Return execution, capture, and cleanup facts together, without a correctness verdict.

## Git change semantics

- The original starting commit is authoritative even if the editor commits, changes HEAD, or stages
  only a subset. Final filesystem contents determine ordinary file bytes.
- Include baseline-tracked changes and final tracked paths, even force-tracked ignored additions.
  Include non-ignored untracked files according to ordinary final repository ignore semantics.
- Preserve binary bytes, executable modes, symlink target strings, and gitlink references. No custom
  rename algorithm is needed; equivalent delete/add is valid.
- Exclude Git control metadata, ordinary ignored untracked build/dependency output, and nested
  working-tree contents. If gitlinks exist, report the fixed reference-only coverage note, including
  `no_changes` results. Do not claim to have tested nested dirtiness.
- Never follow an external symlink or nested Git-directory pointer. Never run editor-configured
  hooks, clean/process filters, external diff commands, or text conversion on the host.
- Do not route capture through the legacy one-file production patch validator.

## Rejection and failure

No partial/sanitized-substitute candidate. Reason codes are stable, messages safe and bounded;
raw Git stderr and sensitive path/content fragments never enter the result. A sensitive match in
removed content or a raw binary payload is still a rejection even when the encoded patch hides it.
The existing binary scanner proves seeded-marker absence only, not general credential detection.

A later cleanup/integrity failure is reported by the unchanged session result independently of a
completed capture. Consumers must not treat `capture.status === captured` as overall execution,
cleanup, or verification success. This PR has no production consumer that bypasses those checks.

## Cancellation

Before/during editor execution, preserve the existing terminal-cause behavior and skip capture on
non-success. During capture, cancellation interrupts capture and releases no partial candidate;
execution history remains the already observed editor result. Join the Git child, then clean up.
A cancellation after finalization does not start another capture or cleanup cycle.

## Compatibility and non-goals

No production Hero/Failure migration, fresh-baseline apply, build/test/replay, live provider login,
network endpoint, storage/retention product, automatic retry, or final `Verified Fix` is added.
