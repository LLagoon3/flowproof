# Agent Instructions

These instructions apply to Claude Code and Codex working in this repository.

## 1. Sources of Truth

- Project principles: `.specify/memory/constitution.md`
- Feature requirements, design, and tasks: the active feature's `spec.md`, `plan.md`, and
  `tasks.md`
- Git and contribution conventions: `CONTRIBUTING.md`
- Follow each document within its scope. Report material conflicts rather than resolving them
  arbitrarily.

## 2. Development Workflow

- Inspect relevant files and Git status before making changes.
- For Spec Kit feature work, follow the phase ownership, completion gates, and commit boundaries in
  `CONTRIBUTING.md`. The user is the repository owner; stop and ask them at the approval points
  defined there.
- Organize implementation work into small, verifiable commit units. Do not update `tasks.md` for
  unrelated work or mark work complete without supporting verification.
- Preserve unrelated code and existing user changes.
- Run required verification before completion. Local commits are permitted within the authorized
  task scope.

## 3. Git and Review Workflow

- Push and PR creation require explicit user authorization. Follow-up pushes require authorization
  unless covered by an approved review loop.
- A phase commit does not require an immediate push or pull request. Use a Draft pull request only
  when early feedback is requested.
- After PR creation, request a GitHub Codex review covering the current PR HEAD, unless already
  reviewed.
- Address actionable findings, verify fixes, commit, push, and request a review of the updated PR
  HEAD.
- Allow up to **3 remediation rounds** after the initial review. Each round consists of fixes and a
  subsequent review.
- Stop and report if findings remain after round 3 or a required review cannot be completed. Do not
  resume without new authorization.
- Never merge without explicit user authorization.

## 4. Communication

- Use clear, established terminology without unnecessary repetition.
- Distinguish verified facts from assumptions.
- Report completed changes, actual verification results, and unresolved issues. Never claim
  unexecuted checks passed.
