# Research: Capture Editing Changes

Research date: 2026-11-02. Source design baseline: approved Spec commits `83da181` and `3bc8717`.
All decisions stay inside the approved local, single-user capture-only scope.

## 1. Reuse Git's private index rather than implement a patch engine

**Decision:** Use a host-owned temporary Git directory outside the editing bind mount, with a private
index/object-output directory and the trusted original object store as a read-only alternate.
Pin the starting commit before launch. Match the source repository object format when initializing.

**Rationale:** Ordinary Git handles text, binary payloads, modes, links and gitlinks. An alternate
index alone is insufficient: it still inherits the editor repository's clean filters and config.
Private metadata avoids those commands and avoids touching original staging/refs/objects. Reading
trusted baseline objects does not expose the original repository to the editing container.

**Alternatives:** Custom raw blob hashing invents changes in clean CRLF/encoding-normalized checkouts;
a second clone or baseline bundle adds copying/packing machinery; using editor HEAD misses committed
edits. Do not use any of them as the default.

Core Git operations, supplied as argv with trusted environment paths:

```text
git init --bare --template= --object-format=<source-format> <private-git-dir>
git read-tree <pinned-baseline>
git ls-files --cached -z                         # final editor index PATH metadata only
git --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul
git add -A -- .
git write-tree
git diff-tree -r --raw -z --no-commit-id --no-abbrev --no-renames --ignore-submodules=none BASE TREE
git diff --binary --full-index --no-ext-diff --no-textconv --no-renames --ignore-submodules=none BASE TREE --
git cat-file --batch
```

For capture commands, `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` select only trusted session paths;
`GIT_ALTERNATE_OBJECT_DIRECTORIES` names the trusted original object directory, never editor objects.
Reuse the existing sanitized environment and `core.hooksPath=/dev/null`, `core.fsmonitor=false` flags.
The metadata-only `ls-files` temporarily selects the contained final editor index; it must not follow
an editor-replaced `.git` or index pointer outside the workspace. Skip force-add when its input is empty.

Seed from the baseline, then force-refresh existing final-index tracked paths before ordinary add.
This includes newly force-tracked ignored additions without trusting staged blob contents. Baseline
tracked paths absent from disk remain deletions. Non-ignored untracked files follow final repository
ignore rules. Names are NUL-delimited bytes, not shell arguments split on whitespace/newlines.

## 2. Preserve normal built-in attributes without executing project commands

**Decision:** Let Git implement built-in text/EOL/encoding normalization. Do not copy edited local
config, global config, hooks, filter commands, external diff drivers, or textconv settings into capture.

**Rationale:** Attribute declarations with no configured custom filter have documented no-op behavior.
Private capture still preserves ordinary Git semantics without giving project scripts host execution.

**Limit:** This is not a promise of custom-filter/LFS hydration fidelity. External clean/smudge/process
filters are not run by the host capture path. Git records the result under the private capture config;
future verification must not assume that a project-specific filter was applied. This is the already
approved no-host-project-command boundary, not an extension/type blacklist.

## 3. Keep completeness checks narrow

**Decision:** A small no-follow entry walk excludes control metadata, prunes ignored untracked
folders, and stops at nested repositories. Do not prune a folder containing baseline/final-index
tracked entries. Check eligible special files explicitly because Git can silently skip FIFOs.
Validate a nested Git-directory pointer before allowing Git to obtain a gitlink reference; ordinary
contained `.git/modules/...` pointers are supported, external pointers are not followed.

Do not enumerate/validate source permissions, extensions or semantic source scopes. Git's own index,
ignore and file representation provide the product boundary. No new configurable policy engine.

**Submodules:** Always report reference-only coverage when baseline or final tree has gitlinks.
The note says nested working-tree changes were not inspected/captured, not that they are clean.
`no_changes` means no main-repository versioned changes. Do not invoke nested `git status` to prove
recursive cleanliness: it can run nested clean filters, and recursive scanning is outside scope.

## 4. Add only a concrete capture branch to the existing lifecycle

**Decision:** Keep the strict Spec 002 entry point and result unchanged. A new sibling entry point
returns `{ session, capture }` through the existing handle/cancel style and a shared private runner.
Retain the prepared workspace, call capture after final container inspection and before disposal.

The successful-stop predicate is: ordinary exit cause, inspected started state, not running, no
startup error, exit code zero. Existing code already distinguishes attach exit from container exit.
Failure/timeout/cancellation never triggers extraction. Capture exceptions become result facts so
cleanup still happens. No callback framework or new lifecycle phase is required.

A capture interrupted after editor success cannot rewrite that observed execution history. It returns
no partial candidate, joins child processes, then runs normal cleanup. Completed candidate data and
subsequent cleanup failure remain separately visible; neither implies verified or clean success.

## 5. Verify the actual mounted workspace view, not hidden volume contents

**Observation:** A parent-owned scratch Docker probe declared `VOLUME /workspace/generated`, created
but did not start a container, and inspected mounts. Docker reported both root `/workspace` bind and
nested anonymous `/workspace/generated` volume. Container, volume, image and temp root were removed.

**Decision:** Add one narrow `verifyWorkspaceView(containerId, expectedWorkspacePath)`-style adapter
operation for capture mode. Require the expected root bind and no obscuring descendant mounts.
An unproved view yields `WORKSPACE_VIEW_UNAVAILABLE`; do not claim an incomplete host clone is the
actual full main-repository filesystem. Do not change lifecycle-only support or implement volume export.

## 6. Reuse existing secret checks, including the existing binary limitation

**Decision:** Inject an existing trusted `SecretScanner`. Scan bounded raw old/new changed blobs and
names, plus exposed diff/summary surfaces. Gitlink OIDs are references, not blobs to read recursively.
Text uses the existing credential patterns plus seeded markers; binary `Uint8Array` uses the existing
seeded-marker-only check. Dispatch UTF-8-valid, NUL-free bytes as text and remaining bytes as binary;
passing every Buffer directly would skip credential-pattern checks even for source text. A secret in
removed bytes is still checked because it can be in the patch.

**Rationale:** Encoded/compressed binary patches hide raw markers. Reusing `secretScan.ts` preserves
the established contract rather than adding a binary DLP scanner. Do not reuse one-file
`patch/validateDiff.ts`, invent another detector registry, or redact a candidate into a different patch.

## 7. Reuse current Git-helper scale for two fixed bounds

**Decision:** 60 seconds for the entire capture phase, 32 MiB cumulative materialized metadata,
patch and raw-payload bytes, aligned with existing `GIT_TIMEOUT_MS` and `MAX_GIT_OUTPUT_BYTES`.
These are safety ceilings, not a repository-size promise or configurable policy family.
Count data as consumed; do not collect unlimited output before checking. Preserve raw byte buffers.
On Linux, launch Git in a capture-owned process group and terminate/join that group on deadline,
cancellation, or budget overflow before cleanup. Never kill unrelated process groups.

**Alternatives:** Promise.race alone can leave a process using deleted workspace data; per-file,
file-count, per-profile and min/default/max registries recreate the rejected overengineering.
A small local binary-safe Git runner can reuse the existing environment, but the current helper's
UTF-8-only output and collapsed errors cannot preserve binary/NUL data or failure categories.

## Observed research probes (not feature acceptance tests)

Prepared Git 2.53.0 probes established:

- Alternate index alone invoked an editor-configured clean filter; private Git metadata did not,
  including an editor-local required-filter configuration.
- Built-in CRLF normalization avoided a false change in an unchanged checkout.
- A partially staged file captured its final unstaged contents.
- A newly committed force-added ignored file was missed by baseline-only indexing, then captured
  when final tracked-path metadata was included; ignored untracked output stayed excluded.
- External symlinks produced link text, not target-file bytes; gitlink changes recorded nested HEAD.
- Cached main-repository diff did not include dirty nested content; nested status could invoke filters.
- A deleted binary's marker was absent from patch plaintext but present in the old blob.
- Git add and ls-files silently omitted a FIFO, justifying the narrow special-entry check.
- The independent Docker mount probe confirmed the obscured-view issue described above.

These are bounded feasibility observations. They do not prove the unimplemented feature or final
resource-bound/cancellation gates. No application code was changed during research.

## Primary evidence and dependency boundary

Installed Git manpages were consulted; matching public references:

- [Git environment/config/object alternates](https://git-scm.com/docs/git)
- [git-add and pathspec/ignore behavior](https://git-scm.com/docs/git-add)
- [gitattributes, built-in conversion and absent filter behavior](https://git-scm.com/docs/gitattributes)
- [gitignore semantics](https://git-scm.com/docs/gitignore)
- [git-diff binary/full-index and external-driver options](https://git-scm.com/docs/git-diff)
- [git-cat-file batch object bytes](https://git-scm.com/docs/git-cat-file)
- [git-read-tree](https://git-scm.com/docs/git-read-tree), [git-write-tree](https://git-scm.com/docs/git-write-tree)
- Existing `editing/session.ts`, `workspace.ts`, `dockerCli.ts`, `git/repositoryState.ts`,
  `evidence/secretScan.ts`, and `patch/validateDiff.ts` were read directly.

No new third-party library, SDK, remote service, credential, or redistributed component is introduced;
existing repository/Git/Docker licensing and runtime prerequisites remain unchanged. No unresolved
research or product decision remains within this approved Plan scope.
