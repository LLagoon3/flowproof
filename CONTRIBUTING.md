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

For a feature or behavior change, update the relevant Spec Kit artifacts before
implementation. A Plan must document Constitution compliance, justified complexity,
verification, and known risks.

## Git workflow

Do not work directly on, commit to, or push directly to `main`. Every change reaches
`main` through a pull request.

1. Update local `main` and create a short-lived branch.
2. Make focused commits that serve one coherent purpose.
3. Run risk-appropriate validation and review the complete diff.
4. Push the branch and open a pull request targeting `main`.
5. Address review feedback and ensure required checks pass.
6. Squash merge the pull request, then delete the source branch.

Use a Draft pull request when work is incomplete or early feedback is needed. Do not
maintain a long-lived `develop` branch unless the repository workflow is explicitly
changed.

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

Use this format:

```text
type/kebab-case-summary
```

When a branch is tied to an issue, include the issue number:

```text
type/123-kebab-case-summary
```

Examples:

```text
feat/42-capture-browser-session
fix/57-redact-auth-headers
docs/contribution-guide
```

Use lowercase English words and digits separated by hyphens. Do not use spaces,
underscores, uppercase letters, or vague names such as `fix/bug`, `feat/update`, or
`chore/misc`.

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

Use the same Conventional Commit format for the pull request title. Because squash
merge is the default, the pull request title becomes the commit subject on `main`.
Update the title if the scope changes during review.

Each pull request should contain one user value, defect fix, or maintenance purpose.
Its description must include:

- **Summary:** what changed and why;
- **Scope:** important implementation details and explicit non-goals;
- **Spec Kit:** affected specification, Plan, or task artifacts, or `N/A`;
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
commits during review so changes remain visible; the final squash removes review-only
commit noise from `main`.

Use squash merge by default. The final squash message must follow the commit message
rules and retain any issue-closing or `BREAKING CHANGE:` footer. Delete the source
branch after merge.

Emergency exceptions require explicit repository-owner approval. Document what was
bypassed, why it was necessary, and the follow-up work required.
