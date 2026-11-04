# Implementation Plan: Studio Workspace UX and Core Design System

**Branch**: `feat/005-studio-workspace-ux` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Status**: Plan direction approved on 2026-11-03. Slice 1's isolated minimalist preview is
implemented and its visual direction was accepted on 2026-11-04. The owner authorized a slice 1
PR and review/correction loop on 2026-11-04, then explicitly authorized its merge. Slice 1 merged
in PR #23. Slice 2 implementation (T009-T016), publication and the repository review/correction
loop were authorized on 2026-11-04. Slice 2 merged in PR #24; local slice 3 (T017-T023)
was subsequently authorized. Publication of slice 3, merge, deployment and slice 4 remain unauthorized.

**Input**: [Approved product direction and acceptance specification](./spec.md#clarifications).
Baseline: merged Specs 001-004 at `8c40140`; specification clarification recorded separately.

## Summary

Refine the existing Studio rather than build a new editor or agent runtime. Retain its React
client, strict result parsers, run reducer, closed artifact routes, measured target, and security
headers. Introduce a small, local design vocabulary and a presentation-only workspace shell:
left work panel, larger right canvas, observed work cards, and concise results with inspectable proof.

First deliver an isolated, clickable design preview with labelled simulated states. Obtain the
owner's visual-direction feedback before applying that design to production. Subsequent slices
change the workspace, work-state presentation, and result/evidence presentation separately.

## Technical Context

**Language/Version**: Existing TypeScript 7.0.2, Node.js 24; minimal HTML/CSS/JavaScript for the
isolated review preview.

**Primary Dependencies**: Existing React/React DOM 19.3.1, Vite 8.3.5; no planned dependency or
lockfile change, UI framework, remote font, icon CDN, or published component package.

**Storage**: In-memory per-session presentation state only. Existing run artifacts remain under
`.flowproof/runs/`; no new persistence, backend tables, stored layout preferences, or history service.

**Testing**: Existing Vitest 5.0.5 and headed Playwright 1.64.1. Pure presentation selection tests
plus browser interaction tests; no new DOM test framework. Human review covers comprehension and
visual acceptance, not repetitions of automated correctness checks.
Use test-first (RED then GREEN) development for high-risk result/stream precedence, finalizing-marker
selection, evidence binding, iframe identity, and focus/scroll preservation. TDD is not required for
markup, CSS or the isolated preview; verify those through rendered behavior and visual review.

**Target Platform**: Existing prepared Linux/headed Chromium environment. Layout matrix:
1280 x 720 and 1920 x 1080 content areas at 100%, plus the same 1280 x 720 content-area window
at actual 200% browser zoom. The launcher fixes the page to the scenario viewport (currently
1280 x 800); resizing its OS window alone is insufficient. Use test-only page viewport overrides
for the 100% cases and retain the same page/window at 1280 x 720 for OS-delivered native 200%
zoom per quickstart. Keep fixed metrics; the generic feasibility probe demonstrated 640 x 360 CSS
viewport at native 200%, not a Studio acceptance pass.
No launcher/scenario viewport change is planned; any such need returns to owner design review.

**Project Type**: Local CLI-launched web workspace, not a browser extension, cloud service, or PPT editor.

**Performance Goals**: No new network round trips or model requests for layout changes; no target
reload, new run, or duplicate artifact read solely from resizing/collapse or reselecting evidence.
First access to an authorized artifact may still use its existing closed read. Incoming work must not
steal focus or scroll position. This feature does not add an arbitrary frame-rate or load-scale SLA.

**Constraints**: Existing strict CSP, session/request binding, canonical verdicts, nine legacy gates,
ten captured-path checks, trusted replay, automatic disposal, and original-file integrity remain intact.

**Scale/Scope**: One run per Studio launch, two current modes, seven local control families, three
usability journeys. No generalized editor SDK, plugin system, virtualized log platform, or multi-turn chat.

## Constitution Check

| Principle | Before research | After design | Evidence / control |
| --- | --- | --- | --- |
| Clean room | Pass | Pass | Public interaction references and synthetic/committed examples only; no copied proprietary assets. |
| Scope / complexity | Pass | Pass | Presentation adapters and local state; no backend contract, dependency, or agent-runtime expansion. |
| Risk-based verification | Pass | Pass | Explicit test-first decision above for high-risk logic; rendered checks for CSS/markup; visual preference remains owner-reviewed. |
| Security by design | Pass | Pass | Unchanged strict parsers, closed reads, text rendering and CSP; preview is isolated and explicitly simulated. |

These are design-compliance assessments, not implementation or functional test results. No
Constitution exception is proposed. If implementation needs a new endpoint, wider CSP, external
service, or different target lifecycle, return to scope/design review rather than silently expand.

## Project Structure

### Documentation (this feature)

```text
specs/005-studio-workspace-ux/
  spec.md
  checklists/requirements.md
  plan.md
  research.md
  data-model.md
  contracts/workspace-ui.md
  quickstart.md
```

The exact task-range ledger belongs in [tasks.md](./tasks.md), not in this Plan. A later
`design-system.md` records approved visual values and the applicable control-state inventory.

### Source Code (repository root; new paths below are proposals)

```text
apps/studio/src/
  App.tsx                        # stable workspace composition; existing client/effects remain owned here
  state.ts                       # authoritative existing state; presentation selectors stay pure
  presentation.ts                # proposed mode-aware work/result view selectors
  styles.css                     # existing self-hosted CSS, responsive layout and semantic tokens
  components/
    WorkspaceShell.tsx           # proposed stable two-pane shell and accessible width controls
    WorkTimeline.tsx             # proposed observed activity groups and reading-position behavior
    ResultSummary.tsx            # proposed mode-aware summary and detail entry points
    EvidenceComparison.tsx       # proposed shared evidence-view presentation
    AgentPanel.tsx               # adapt existing legacy request and work surface
    CapturedVerification.tsx     # retain captured-only inputs/claims/check details
    TargetPane.tsx               # retain actual frame wrapper, guard and lifecycle
    ProofTrail.tsx               # retain legacy provenance/diff and artifact-loading semantics

tests/manual/studio-design/       # proposed isolated preview; never imported by the product bundle
  index.html
  preview.css
  preview.js
  README.md

tests/ui/                        # existing pure-state/client suites; proposed presentation selection cases
  workspace-presentation.test.ts

tests/e2e/
  workspace-ux.spec.ts            # proposed browser behavior/layout cases; existing E2E suites remain
```

**Structure Decision**: Keep the existing application and server boundary. Add only components
with a concrete responsibility. Do not make a generic design-system package or duplicate the run
state machine. The separate static preview is disposable design material, not a second product.

## Design and Integration

- **Visual direction**: Light neutral surfaces, existing system fonts, one primary accent, consistent
  spacing/type hierarchy, explicit text-backed statuses, and restrained card density. Exact values
  are selected in the preview and recorded in the visual inventory, not claimed approved today.
- **Layout**: Default 24rem work panel, canvas receives remaining space. Resize snaps to class-backed
  20-32rem widths in 2rem steps, with a keyboard-operable separator and collapse/restore control.
  Seven discrete widths avoid CSP-sensitive inline styling and a new drag/layout dependency.
  Below 64rem available width, use a compact stacked arrangement; preserve the measured frame and
  target contents. Hide the width separator in stacked mode and remove it from keyboard focus;
  retain the width choice for returning to side-by-side mode. Collapse/restore remains available.
  A compact current-state indicator outside the hidden panel keeps updating, including final result
  arrival, and offers a keyboard-accessible restore-and-result entry point without resetting details.
  In slice 2 it uses existing authoritative selectors without inferred phases/verdicts. Slice 3
  migrates it to `RunPresentation` and tests both visible/collapsed result/stream precedence.
  These dimensions are the initial preview proposal, not an unchangeable visual decision.
- **DOM lifetime**: Render one stable `TargetPane` in one stable parent position. CSS changes spatial
  arrangement; collapse affects only the work panel. Never key/remount the canvas by width, tab,
  mode-derived phase, or selected evidence. Preserve the captured live wrapper until the existing
  launcher removes the exact iframe; final static evidence replaces that wrapper as before.
  Keep work-panel and artifact-loading owners mounted while collapsed; make hidden controls inert
  and transfer focus to the restore control without tearing down reads or subscriptions.
- **State ownership**: Keep client requests, event subscription, result polling, parser validation and
  run transitions where they are. Add local width, collapse, selected evidence tab and disclosure state.
  Do not route these choices through network effects or the execution reducer.
- **Work cards**: Derive groups from already accepted, run-bound events, retaining event identity and
  chronological order in details. No synthetic model output, inferred percentage, or fabricated
  completion. Announce concise current-state changes, not a live region containing every log entry.
  Replace the captured panel's current last-40-events rendering with retained session cards so a
  focused earlier item does not disappear as new activity arrives.
- **Results**: The final authoritative family determines the claim, check rows and cleanup facts.
  Stream loss is an activity warning, not a failure verdict. Existing finalizing activity is shown
  only when observed; absent activity says the result is pending rather than inventing a phase.
  There is no `finalizing` phase enum. Use the exact existing captured scan/cleanup message markers
  or the observed legacy integrity gate, with explicit coupling tests and a conservative fallback;
  `run_finalized` without a bound result means awaiting the result, not success.
  Keep engine strings private: assert the finalizing card against actual producer events in the
  real captured E2E at scan/cleanup barriers, not just copied UI fixture text. The human-readable
  card may say `Finalizing` while expanded details retain the raw `replaying` phase. No engine export.
- **Evidence**: During captured measurement the actual target remains primary and guarded. Enable
  final comparison only with available run-bound evidence; do not hide/unmount the measured frame
  to show a speculative screenshot. Legacy evidence/diff/provenance keep their existing safe reads.
  A compact before/after tab presentation uses the same available evidence, with explicit missing states.
  Keep family-specific authorization: legacy known IDs/result citations and captured exact-manifest
  announcements are not interchangeable. Preserve legacy target lifetime as-is, distinct from
  captured-path disposal. Extract/reuse the existing legacy artifact-loader responsibility only as
  needed for a shared view, with one stable owner; do not create a new fetch/cache framework.
  In finalized legacy mode, canvas tabs select prepared target versus stored evidence. Keep the
  original iframe mounted in its stable wrapper but hidden/inert while evidence is selected;
  returning to it preserves the same element/frame. Evidence tabs never hide an active measurement.
- **Security**: All production styles stay in emitted self-hosted CSS; no inline styles, remote
  assets, dangerous HTML rendering, or CSP exception. The preview has no production API/session token
  or embedded live target and is not served by the Studio backend.

## Proposed Delivery Slices

These are Plan boundaries for review. Tasks must supply exact IDs and runnable validation ranges
before any `speckit-implement` run; a small commit does not justify combining all slices into one PR.

| Order | Review question / scope | Boundary validation |
| --- | --- | --- |
| 1. Design preview | Is the proposed interaction/visual direction acceptable? Isolated clickable preview and design inventory only; production untouched. | Preview walkthrough in both modes and six states, keyboard/layout/contrast checks, explicit owner visual review. |
| 2. Workspace / core controls | Does the approved shell improve usable canvas space without changing execution? Tokens, consistent controls, stable left panel/right target. | Build/typecheck, UI regression, new panel/layout browser cases, strict CSP, same-iframe/no-reload and existing real E2E. |
| 3. Work-state presentation | Are observed work, pending/finalizing, stream loss and next actions understandable and faithful? | Pure selectors plus browser focus/scroll/disclosure cases; existing ordering and authoritative-result regressions retained. |
| 4. Results / evidence | Can users understand the bounded outcome and inspect proof without reviving the target? | Both-mode verdict/evidence/provenance checks, all gates/checks, missing evidence, same-frame release and full final regression. |

Keep this feature branch for artifacts and slice 1. After its PR merges, create each later slice
from updated main, preserving the feature number. Every slice requires owner authorization under
CONTRIBUTING.md. Approval of the Plan alone is not approval to execute all four slices. Production
slices additionally depend on the preview's visual direction being accepted; document rework first
if the owner rejects it. No new standing independent-review gate is invented by this Plan.

## Verification and Risks

See [quickstart.md](./quickstart.md) for reproducible commands and
[the UI contract](./contracts/workspace-ui.md) for the state/interaction matrix.

| Requirement | Design / validation coverage |
| --- | --- |
| FR-001-FR-003; SC-001, SC-004 | Workspace shell, local presentation state, mode boundary; slice 2 plus owner start walkthrough. |
| FR-004-FR-006; SC-002 | Pure activity projection, result/stream precedence, focus/scroll behavior; slice 3 plus owner state comprehension. |
| FR-007-FR-009; SC-003 | Mode-specific verdict/evidence sources and stable frame lifecycle; slice 4 plus owner result walkthrough. |
| FR-010-FR-012; SC-005, SC-007 | Preview/design inventory, core controls, contrast/keyboard/zoom checks across affected slices; owner visual decision. |
| FR-013; SC-006 | Unchanged execution/security contracts and existing regression suites, particularly same-frame release, cleanup and provenance. |

- Use the test-first decision above for iframe identity, result precedence, evidence binding, focus and
  reading-position preservation. Do not create tests that only mirror CSS declarations or JSX structure.
- In captured real E2E, resize/collapse during guarded baseline and candidate measurement and compare
  the verdict, check outcomes, evidence phase/ID binding and 640 x 360 screenshot dimensions to a
  matched unresized control. IDs may differ across runs: require unchanged IDs within each run and
  equivalent bindings across runs, not literal cross-run ID equality. No reload or extra start is allowed.
- Existing E2E assertions tied to CSS classes may change selectors when presentation changes, but
  retain their semantic assertions, negative cases and test count intent; do not delete safety checks.
- Real browser zoom must be exercised; shrinking the viewport or CSS transforms alone is not proof
  of 200% zoom. Fixed-size target content may scroll locally; no outer-page horizontal overflow.
- Changes to main require dependency/build setup before product checks. New test filenames are
  prospective; never report a command with no discovered tests as feature validation.
- Human QA is short and specific: comprehension of start/work/result plus visual hierarchy/density,
  not process cleanup, data validity or security inspection. No population-level UX claim is made.
  T023 produces real-UI six-state captures for SC-002; T025/T033 provide interactive successful and
  unsuccessful/unevaluable results in both modes using existing test harnesses. Quickstart defines
  how opt-in bounded Node-side review waits retain the shell without Inspector, browser pauses,
  engine delays or product flags.
- Biggest risks: reparenting/remounting the measured target; an activity card implying final success;
  out-of-order/stale evidence; focus/scroll disruption; CSP-blocked resizing; compact layout hiding
  controls; preview and production diverging. Each has a validation responsibility above.

## Complexity Tracking

No Constitution violation or additional infrastructure is required. The isolated preview and
single presentation adapter are justified by visual review before production change and shared
semantics across the existing modes; neither is a general-purpose framework.
