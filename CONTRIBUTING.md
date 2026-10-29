# Contributing to FlowProof

Keep contributions focused, reviewable, and consistent with the project
Constitution. This repository uses GitHub Spec Kit with Codex CLI and Claude Code,
but the same standards apply whether a change is written by a person or assisted by
an agent.

## Language

Use English for branch names, commit messages, issue titles and bodies, pull request
titles and bodies, source identifiers, code comments, test names, and repository
documentation. Preserve external names, commands, paths, logs, and quoted text in
their original form when accuracy requires it.

## Project principles

Before contributing, read
[the project Constitution](./.specify/memory/constitution.md). In particular:

- Do not use proprietary company code, data, internal systems, or confidential
  information.
- Use only permitted public resources and synthetic data for development and
  evaluation.
- Avoid speculative abstractions and unjustified complexity.
- Match verification effort to the acceptance criteria and risk.
- Treat untrusted input and model output as untrusted, apply least privilege, and do
  not expose secrets, credentials, or personal data.

## Spec Kit workflow

Use Spec Kit for every feature or behavior change, and update the relevant artifacts
before implementation. Run the commands in this order:

1. `speckit-specify` creates the feature branch and `specs/NNN-short-name/spec.md`.
2. `speckit-clarify` (recommended) resolves open questions in the specification.
3. `speckit-plan` records the technical approach, project structure, and
   Constitution check.
4. `speckit-tasks` breaks the Plan into small, verifiable tasks.
5. `speckit-analyze` (recommended) checks consistency across the specification,
   Plan, and tasks.
6. `speckit-implement` executes the tasks of one delivery slice per run.

Invoke commands as `/speckit-<name>` in Claude Code and `$speckit-<name>` in Codex
CLI. Start from an up-to-date `main`: the Spec Kit Git extension creates the feature
branch from the current `HEAD` before `speckit-specify` writes the specification.

A Plan must document Constitution compliance, justified complexity, verification,
and known risks.

### Phase ownership and completion gates

- **Specify and Clarify** are collaborative product-definition phases. The
  contributor may prepare drafts, but the repository owner must agree to user
  scenarios, scope, and measurable success criteria before the specification is
  used for planning. Complete `checklists/requirements.md` and resolve every
  `[NEEDS CLARIFICATION]` marker before planning begins.
- **Plan** is a technical-design phase. The contributor researches and proposes the
  architecture, dependencies, data model, contracts, verification approach, and
  operational risks. Return to the repository owner when a decision changes product
  scope, user experience, verification effort, storage, network access, or an
  external service commitment.
- **Tasks** derives small, independently verifiable work items from the approved
  specification and Plan and records their [delivery slices](#delivery-slices). It
  must not introduce new product behavior or completion criteria.
- **Analyze**, when run, is a read-only consistency check across requirements,
  success criteria, the Plan, and tasks. Resolve any reported critical or
  high-severity gaps and any Constitution violation before implementation.
- **Implement** follows the approved task order within the current delivery slice,
  verifies each completed unit, and marks only work with supporting evidence as
  complete. Keep automated checks and any remaining human-only verification clearly
  separated.

### Delivery slices

Deliver a Spec Kit feature as a sequence of delivery slices, with one implementation
pull request per slice by default. A delivery slice is one `tasks.md` phase or named
checkpoint. The Delivery slices ledger in `tasks.md` records each slice's order,
exact task range, and validation commands.

- The repository owner may approve batching small adjacent slices into one pull
  request. There is no fixed commit or line limit; size each pull request for
  review.
- Run `speckit-implement` for the current slice only, for example with
  `only execute tasks T010-T017, then stop`. At the slice boundary, run the slice's
  validation, report the results, and stop. Start the next slice only with owner
  authorization.
- The branch created by `speckit-specify` carries the Spec Kit artifacts and the
  first slice. After a slice pull request merges, update local `main` to the current
  `origin/main` and create the next slice branch from it as
  `type/NNN-kebab-case-summary-part` (see [Branch names](#branch-names)).
- If a single phase is still too large and cannot be split at a named checkpoint,
  decompose the feature with the official
  [Spec of Specs](https://github.github.com/spec-kit/concepts/spec-of-specs.html)
  approach. Use it only when this lighter phase and task scoping is insufficient.

### Commit boundaries

Keep the Git extension's auto-commit hooks disabled. Prefer one manual Conventional
Commit per reviewable artifact set:

1. `spec.md` and `checklists/requirements.md` after Specify and Clarify, if Clarify
   is run;
2. the complete Plan artifact set, such as `plan.md`, `research.md`,
   `data-model.md`, `contracts/`, and `quickstart.md`;
3. `tasks.md` after task validation;
4. corrections resulting from Analyze; and
5. each small implementation unit together with its tests or other verification.

Do not commit only because a Spec Kit command finished; review the diff first. The
extension configuration lives in `.specify/extensions/git/git-config.yml`; change
it only together with this guide.

`specify extension add` registers extension commands only for the default
integration (`codex`). After adding or updating an extension, run
`specify integration use claude` and then `specify integration use codex` to register
the commands for Claude Code. Review `git status` afterward; if the switch dropped
the executable bit on `.specify/scripts/bash/*.sh`, restore it with
`git checkout -- .specify/scripts/bash/`.

## Git workflow

Do not work directly on, commit to, or push directly to `main`. Every change reaches
`main` through a pull request.

1. Update local `main`.
2. Create a short-lived branch: run `speckit-specify` for a new Spec Kit feature, or
   create the branch manually for a later delivery slice or another change. See
   [Branch names](#branch-names).
3. Make focused commits that serve one coherent purpose.
4. Run risk-appropriate validation and review the complete diff.
5. Push the branch and open a pull request targeting `main` when the work is ready
   for review, or use a Draft pull request when early feedback is useful.
6. Address review feedback and ensure required checks pass.
7. Merge the pull request with a merge commit, then delete the source branch.

Publishing a branch and opening a pull request are not required after every Spec Kit
phase or commit. By default, each [delivery slice](#delivery-slices) of a Spec Kit
feature gets its own branch and pull request, and an unrelated concern gets its own
branch.

Open a Draft pull request after a validated phase when early review of the
specification, Plan, or another incomplete artifact is useful. Keep subsequent
commits for the same slice on that branch and keep the pull request description
current. A Draft pull request is not mergeable work.

For a Spec Kit feature pull request, mark it ready for review once its delivery
slice, or owner-approved batch of slices, is complete and verified, any Analyze
findings rated critical or high are resolved, and required checks pass. Later slices
of the same feature do not hold it back. Document any remaining human-only
verification in the pull request. Do not maintain a long-lived `develop` branch
unless the repository workflow is explicitly changed.

## Change types

Branch names, commit messages, and pull request titles use these types:

| Type | Use for |
| --- | --- |
| `feat` | A new user-visible capability. |
| `fix` | A correction of incorrect behavior. |
| `docs` | Documentation-only changes. |
| `refactor` | Internal restructuring without an intended behavior change. |
| `test` | Test-only additions or corrections. |
| `chore` | Repository maintenance with no product behavior change. |
| `build` | Build tooling, dependencies, or packaging. |
| `ci` | Continuous integration configuration or scripts. |
| `perf` | A performance improvement without an intended behavior change. |
| `revert` | A revert of an earlier change. |

Choose the type by the primary effect of the change. Product behavior changes are
never `chore`, even when they also update tests, documentation, or configuration.

## Issues

Search existing issues before opening a new one. Use this title format:

```text
type(scope): concise problem or outcome
```

The scope is optional and should name a stable subsystem or concern. Examples:

```text
feat(capture): record a reproducible browser session
fix(redaction): remove authorization headers from traces
docs(repo): define the contribution workflow
```

An issue should include:

- the problem, user need, or intended outcome;
- evidence or reproduction steps when reporting a defect;
- acceptance criteria that can be verified;
- known constraints, dependencies, and non-goals;
- security, privacy, or data-handling implications; and
- links to related issues or external references.

Do not place secrets, credentials, personal data, proprietary company information,
or unredacted private logs in an issue. Report suspected security vulnerabilities to
the repository owner privately rather than publishing exploitable details.

Use `Closes #123` in the implementing pull request when it should close the issue, or
`Refs #123` when it is related but should remain open.

## Branch names

Every branch name starts with a change type and uses lowercase English words and
digits separated by hyphens.

Spec Kit branches carry the feature number of the matching `specs/` directory.
`speckit-specify` creates the first branch of a feature:

```text
type/NNN-kebab-case-summary
```

Later [delivery slices](#delivery-slices) of the same feature reuse its number, so
several branches may share one feature number. Create each manually from an updated
`main`, not with `speckit-specify`, which would allocate a new feature number, and
append a short name for the slice:

```text
type/NNN-kebab-case-summary-part
```

The Git extension uses `feat` by default. When the primary effect of the change is
another type, include an explicit `GIT_BRANCH_NAME` with the next feature number in
the `speckit-specify` request, for example
`GIT_BRANCH_NAME=fix/004-redact-auth-headers`. Run `speckit-git-validate` to confirm
that the branch matches its `specs/` directory; it matches on the feature number, so
it also accepts slice branches.

Other branches, such as documentation or repository maintenance, are created manually
without a number:

```text
type/kebab-case-summary
```

Examples:

```text
feat/001-capture-browser-session
feat/001-capture-browser-session-us2
fix/004-redact-auth-headers
docs/contribution-guide
```

Reserve numbers in branch names for Spec Kit feature numbers, and link issues from
the pull request description instead. Do not use spaces, underscores, uppercase
letters, or vague names such as `fix/bug`, `feat/update`, or `chore/misc`.

## Commit messages

Use English [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
type(scope): imperative summary
```

The scope is optional. Keep the summary specific, imperative, and free of a trailing
period. Add a body after a blank line when the motivation, trade-offs, or constraints
are not obvious from the diff. Explain why the change is necessary rather than
restating the changed files.

Examples:

```text
feat(capture): record Playwright trace artifacts
fix(redaction): remove credentials from network events
docs(repo): add contribution conventions
test(replay): cover failed navigation recovery
```

Mark a breaking change with `!` after the type or scope and include a
`BREAKING CHANGE:` footer:

```text
feat(api)!: replace the capture session schema

BREAKING CHANGE: capture clients must send schema version 2.
```

Keep each commit coherent. Do not mix unrelated cleanup, formatting, or refactoring
with a behavior change.

## Pull requests

Use the same Conventional Commit format for the pull request title. Because merge
commits are the default, the pull request title is recorded in the merge commit on
`main`. Update the title if the scope changes during review.

Each pull request should serve one coherent, independently verifiable purpose, such
as a delivery slice, a defect fix, or a maintenance change. Its description must
include:

- **Summary:** what changed and why;
- **Scope:** important implementation details and explicit non-goals;
- **Spec Kit:** affected specification, Plan, or task artifacts and, for a delivery
  slice, its task range and position in the ledger, for example
  `T010-T017, slice 2 of 5`; or `N/A`;
- **Constitution:** confirmation of compliance and any justified complexity;
- **Verification:** commands, scenarios, and observed results;
- **Risk:** security, privacy, migration, compatibility, and rollback considerations;
- **Evidence:** screenshots, traces, logs, or recordings when relevant;
- **Gaps:** validation not performed and remaining risks; and
- **Issues:** `Closes`, `Fixes`, or `Refs` links.

Write `N/A` instead of deleting a required section. Never claim a requirement is
complete when its verification is missing or unsuccessful.

Before requesting review:

- review every changed file and the full diff;
- run `git diff --check`;
- run all tests and checks relevant to the changed behavior;
- confirm documentation and Spec Kit artifacts remain consistent;
- confirm no secret, credential, personal data, proprietary data, or generated local
  artifact is included; and
- state why any expected validation was not run.

AI-assisted changes require the same human review and verification as manually
written changes. Do not merge generated output that has not been inspected.

## Review and merge

Resolve blocking review comments and required checks before merge. Prefer follow-up
commits during review so changes remain visible. Because merge commits keep every
branch commit on `main`, follow-up commits must also follow the commit message rules.

Use a merge commit by default. Keep the pull request number and title in the merge
commit message, and keep each `BREAKING CHANGE:` footer on the commit that introduces
it. Delete the source branch after merge.

Emergency exceptions require explicit repository-owner approval. Document what was
bypassed, why it was necessary, and the follow-up work required.
