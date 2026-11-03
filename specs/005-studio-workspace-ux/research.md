# Research: Studio Workspace UX and Core Design System

**Date**: 2026-11-03
**Scope**: Read-only inspection and decisions for [plan.md](./plan.md); no prototype or product
implementation was executed as research. External product references were inspected during the
preceding reference task; they are interaction references, not dependencies or imported source.

## 1. Build on the Existing Studio

**Decision**: Keep React 19.3.1, Vite 8.3.5, strict client contracts and the existing launcher.
**Rationale**: `apps/studio/package.json`, `App.tsx` and `state.ts` already provide both modes,
request ownership, event subscriptions and authoritative polling. The problem is presentation.
**Alternatives considered**: A new UI framework/package or an Electron/browser extension shell
adds scope without solving a current requirement. Direct DOM rewriting around the run frame risks
breaking launcher ownership. Add focused React components and local styles instead.

## 2. Isolated Preview Before Production

**Decision**: A small static preview under `tests/manual/studio-design/`, with synthetic labelled
mode/state examples and no product API calls; document visual values and decisions alongside it.
**Rationale**: The owner asked to see a clickable design before replacing the real interface.
A standalone preview can be served on loopback, reviewed and removed without modifying execution.
**Alternatives considered**: Starting with real production UI changes defeats preview-first review.
A component explorer dependency or separate design app is excessive for one small workspace.
A screenshot-only presentation cannot verify panel interaction or detail navigation.

## 3. Reference Patterns, Not Feature Imports

**Decision**: Combine Claude's prominent artifact with Lovable's work panel and activity disclosures;
use v0 as a reference for a small preview toolbar and understandable comparison controls.
**Rationale**: The current task is to inspect work and proof next to a target, not to author slides.
**Alternatives considered**: Copying every reference control would introduce unavailable chat,
model selection, rollback or visual editing. Replit checkpoints and Manus slides are supplementary
references, not requirements. Links and boundaries are recorded in [spec.md](./spec.md#reference-boundaries).

## 4. Preserve the Actual Frame

**Decision**: Stable component/parent identity, CSS-only spatial changes, no frame key based on
presentation choices, and no active-run evidence tab that replaces the measured target.
**Rationale**: `packages/flowproof/src/studio/launch.ts` binds exactly one iframe; captured
finalization removes that exact element and waits for frame detachment. `TargetPane.tsx` uses a
keyed wrapper specifically to tolerate launcher-owned removal. The existing captured E2E checks
follow the same element/frame from baseline to candidate, then assert disposal.
**Alternatives considered**: Conditional left/right trees, fullscreen clone frames, or keeping a
live target after completion break identity, security or cleanup. Reuse the one surface.

## 5. Resize Under Strict CSP

**Decision**: Class-backed bounded width steps shared by a drag separator and keyboard controls;
compact layout reflows with media rules. No new resize package or inline styles.
**Rationale**: `apps/studio/vite.config.ts` forbids inline assets; `studio/auth.ts` emits
`style-src 'self'`. The small finite width range can be represented in the existing stylesheet.
**Alternatives considered**: Most third-party split-pane controls inject style attributes; widening
CSP for them is not justified. CSS-only native resizing lacks the explicit keyboard contract and
presentation-state control needed here. Arbitrary runtime stylesheet generation adds unnecessary machinery.
The initial 20-32rem range, 2rem steps and 24rem default are visual-review proposals; tune within
the same behavior contract if the preview shows unsuitable density or canvas space.

## 6. Separate Observed Work from Authoritative Results

**Decision**: Pure, mode-aware projection of accepted events; keep stream availability, current
phase and final result independent. Group raw events into expandable cards without discarding details.
**Rationale**: `state.ts` already treats events as advisory and strict results as authoritative.
Captured mode rejects legacy chat/model/gate events; its checks exist only in the final result.
**Alternatives considered**: A second orchestration reducer or a UI-computed pass/finalizing state
would duplicate semantics. Fake thinking text and inferred progress percentages make unsupported claims.
When no finalizing event was received, display a generic pending-result message, not a guessed phase.
Neither mode has a finalizing enum: captured scan/cleanup markers are fixed producer copy, and
legacy's observed integrity-gate update indicates finalization work. Keep this small allowlist in
one presentation selector with drift/fallback tests, not a new execution contract.

## 7. Reuse Evidence Boundaries

**Decision**: Presentation adapters expose available evidence through existing selectors and closed
reads; preserve phase/run binding, missing states, fixture provenance and escaped text.
**Rationale**: Captured evidence is selected from strict results plus accepted IDs. Legacy
`selectProofTrail` and `ProofTrail.tsx` already load sanitized artifacts and cancellation-safe reads.
**Alternatives considered**: New raw-path artifact APIs, cross-run caches, diagnosing from screenshot
appearance, or broad arbitrary asset URLs would widen the trust boundary. No such expansion is needed.

## 8. Validation Without New Services

**Decision**: Existing Vitest pure-state tests and headed Playwright browser harnesses, plus a
short owner comprehension/visual review. Keep normal tests credential-free.
**Rationale**: `vitest.config.ts` uses a Node environment even for `tests/ui`; browser interaction
belongs in the headed suite. Existing recorded Hero exercises legacy success without a live API call.
**Alternatives considered**: Adding a DOM emulator, design SaaS requirement, live model acceptance
suite, or screenshot pixel equality duplicates facilities or confuses visual taste with correctness.
Contrast and zoom/layout are mechanical checks, not work delegated to the owner.

## Bounded Research Cross-Check

A read-only research agent inspected the existing seams and tests; this is research, not an
independent Plan approval or an implementation test. Findings incorporated above:

- `App.tsx:111`, `:131`, `:145`: stable client/reducer/draft, accepted start and independent
  stream/poll ownership. Keep presentation controls outside these execution effects.
- `TargetPane.tsx:148` and `studio/launch.ts:624`: the keyed wrapper and exact iframe disposal
  require stable DOM ancestry, not merely a visually identical frame.
- `state.ts:178`, `:251`, `:268`: accepted-event ordering, captured-family restrictions, strict
  result finalization. Preserve these instead of a second orchestration reducer.
- `CapturedVerification.tsx:211`: last-40-events rendering can discard focused history; retain
  session cards. Collapsing the panel must not unmount its existing artifact-loader owner.
- `state.ts:427`, `:444`, `:587`: family-specific evidence authorization and missing-ID behavior.
  Shared comparison presentation must not flatten these different trust rules.
- `tests/ui/{state,captured-verification,proof-trail}.test.ts` and the existing real
  `tests/e2e/captured-verification.spec.ts` already exercise the semantic baseline; extend browser
  behavior and selector cases without weakening negative or same-frame assertions.

## Resolution

No unresolved technical choice blocks the proposed Plan. Palette/typeface fine tuning and visual
acceptance are deliberately deferred to the preview; they are not claims of implementation readiness.
A genuine need to alter runtime contracts, CSP or target lifetime must return to owner review.
