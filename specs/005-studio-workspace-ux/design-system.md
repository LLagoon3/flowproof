# Studio Core Design System

**Status**: Proposed. These values are implemented in the slice 1 design preview
([tests/manual/studio-design/](../../tests/manual/studio-design/README.md)) and are not accepted.
The owner's actual hierarchy, density, and balance decision is recorded in
[Owner review record](#owner-review-record); until that decision is positive, no production UI
change may rely on this document.

This record keeps three kinds of information apart:

1. **Proposed values**: design choices the contributor made in the preview (sections 2 to 5).
2. **Measured checks**: mechanical results (contrast, keyboard, layout, zoom) observed by running
   the preview at an exact revision (section 6). They show the values are usable, not that they
   are liked.
3. **Owner acceptance**: the owner's own decision about hierarchy, density, and balance (SC-007).
   It is never inferred from measured checks or from the request to build the preview.

## 1. Scope

One light appearance, English copy, desktop first with compact reflow. The vocabulary covers the
seven control families required by FR-010: workspace shell, buttons, request field, tabs, status
indicators, activity cards, and disclosures. It is a local rule set for Studio, not a component
package, theme system, or published design library. The values live as CSS custom properties in
`tests/manual/studio-design/preview.css`; a later production slice may copy them into
`apps/studio/src/styles.css` only after accepted direction.

## Owner-directed revision (2026-11-04)

The owner rejected the initial preview's density: too many always-visible buttons, status blocks,
IDs and explanatory text obscured the conversation/canvas structure. The revision uses Claude
Artifacts' spatial simplicity as a reference, not its product features or proprietary assets.

- Default view: one quiet header, a left request/work column and a larger right canvas.
- A compact `Preview · simulated` label and one overflow button replace the amber test toolbar.
  Mode, six states, case selection, evidence examples and synthetic-activity controls live inside
  that closed-by-default menu; they are not product actions.
- Legacy ready view has a compact prepared-case title and bottom request composer. No fake sent
  request or AI reasoning is invented. Captured mode has only its fixed-candidate start action,
  never a request field or conversational message.
- Active/final states show a concise observed summary or exact verdict. One `Details` disclosure
  holds chronological observed work, raw events, scope, all gates/checks and provenance/identity.
  Failed/unevaluable check names remain visible beside the unsuccessful verdict.
- Use warm offwhite surfaces, restrained type, flat activity rows and generous empty space.
  Remove decorative badges, repeated status copy, localhost chrome and always-visible counters.
- Keep panel resizing/collapse, stable target wrapper, final evidence tabs, missing-evidence
  distinctions and all single-run/no-network semantics. This changes presentation, not scope.

The values and inventory below describe the first rejected revision historically; the implemented
revision's token values and inventory are summarized in the next verification record after checks.
T008 remains unchecked: rejection of the first preview is not acceptance of the revision.

## 2. Foundations (initial revision, historical)

### Color roles

Status meaning is always carried by text or an accessible name as well as color (FR-011).
Borders marked *decorative* separate surfaces and are never the only cue that identifies a control.

| Role | Token | Value | Used for |
| --- | --- | --- | --- |
| App background | `--color-bg` | `#f7f6f3` | Page and work-panel backdrop |
| Surface | `--color-surface` | `#ffffff` | Cards, canvas frame, composer |
| Sunken surface | `--color-surface-sunken` | `#efede8` | Canvas stage behind the target scene |
| Muted surface | `--color-surface-muted` | `#f3f1ec` | Card details, read-only blocks, hover fill |
| Subtle border | `--color-border-subtle` | `#e3e0d9` | Decorative separation |
| Control border | `--color-border-control` | `#857f75` | Input, select, segmented, secondary-button, tab-group boundaries |
| Text | `--color-text` | `#1c1b19` | Primary copy and headings |
| Secondary text | `--color-text-secondary` | `#5f5b54` | Supporting copy, labels, icons |
| Tertiary text | `--color-text-tertiary` | `#6b665e` | Metadata and counters |
| Accent | `--color-accent` / `-strong` | `#4338ca` / `#3730a3` | Focus ring, links, current-work marker, stored-evidence label |
| Accent soft | `--color-accent-soft` | `#eef0ff` | Working and finalizing indicator background |
| Primary action | `--color-action` / hover / active | `#1c1b19` / `#34322e` / `#000000` | Primary button fill and selected segment (white text) |
| Disabled | `--color-disabled-bg` / `-text` | `#ebe8e2` / `#6b665e` | Disabled buttons and selects |
| Success | `--color-success` / `-soft` / `-border` | `#166534` / `#ecfdf3` / `#9fd8b4` | Passed check, successful verdict, live target label |
| Danger | `--color-danger` / `-soft` / `-border` | `#b42318` / `#fef3f2` / `#f4b8b2` | Failed check, unsuccessful verdict, request error |
| Warning | `--color-warning` / `-soft` / `-border` | `#8a4b08` / `#fffaeb` / `#f2cf8d` | Activity disconnected, unreadable or unreceived evidence |
| Neutral status | `--color-neutral` / `-soft` | `#5f5b54` / `#f1efea` | Ready, pending, unevaluable, not live |
| Preview only | `--color-preview` / `-soft` / `-border` | `#5c4300` / `#fff3cf` / `#e6c35c` | Preview bar and simulated cards; never a product surface |

Danger is reserved for verification outcomes and input errors. Evidence that is unreadable or
whose ID was not received uses warning, because a missing side never changes the verdict.

### Type

System font stacks only (`ui-sans-serif, system-ui, …` and `ui-monospace, …`); no remote or
bundled font files.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Verdict (result card) | 1rem pill text, 0.75rem uppercase "Final result" label | 600 |
| Section title | 1rem / 1.35 | 600 |
| Body (panel) | 0.875rem / 1.5 | 400 |
| Small / details / status detail | 0.8125rem / 1.45 | 400 to 500 |
| Caption / metadata / eyebrow | 0.75rem / 1.4, eyebrows uppercase with 0.04em tracking | 500 to 600 |
| Code / identifiers | 0.75rem monospace, line breaks after `_` and `.` | 400 |

### Space, shape, elevation, focus, motion

- Space: 4px grid (`0.25rem` to `2rem`). Panel gutter 1rem; card padding 0.75rem; canvas stage
  padding 1.5rem (1rem compact, 0.75rem below 30rem).
- Radius: 6px badges, inputs, small buttons; 10px cards and buttons; 14px canvas and composer.
- Elevation: hairline card shadow `0 1px 2px rgb(28 27 25 / 5%)`; raised canvas, composer and
  target frame add `0 10px 28px -12px rgb(28 27 25 / 18%)`.
- Focus: `2px solid #4338ca` outline, 2px offset, on every interactive element. The request field
  shows focus on its composer boundary (accent border plus 1px ring). The separator uses an
  inset outline and an accent grip line.
- Motion: none is required. Color transitions are at most 120ms and only under
  `prefers-reduced-motion: no-preference`. No timer, spinner, or animation implies progress.

## 3. Layout rules (proposed)

- Work panel left, canvas right, 0.75rem outer gutter. Panel widths are seven attribute-backed
  choices (20, 22, 24, 26, 28, 30, 32rem), default 24rem. Dragging snaps to the nearest choice;
  the separator is a focusable `separator` with arrow keys, Home, and End, and exposes its value
  and limits. No inline styles are used.
- Panel order, top to bottom: brand and collapse control; session context (case or candidate and
  scope); current-state card; scrollable work history ending in the result; the composer with the
  one primary action. On desktop the page does not scroll; the history and canvas stage do.
- Below 64rem of available width the panes stack (panel first, canvas second), the separator is
  hidden and leaves the focus order, the history scrolls locally up to 26rem, and the width
  choice is retained for the side-by-side layout. This includes 1280 x 720 at 200% zoom.
- Collapsing hides and inerts the panel without removing it. The canvas bar then shows
  `Show work panel`, a compact status that keeps updating, and `View result` once a result exists.
- The fixed-size target scene keeps its 640 x 360 chart and scrolls locally in narrow stages;
  dense identifiers wrap. The page has no page-wide horizontal scrollbar at supported sizes.

## 4. Control family inventory

Applicable states follow SC-007: default, focus, disabled, active, and error, where they apply.

| Family | Preview element | State treatments |
| --- | --- | --- |
| Workspace shell | Panel, separator, canvas card, collapsed status and restore entry | Separator: invisible at rest, control-border grip on hover and while dragging, accent grip with inset outline on focus. Collapsed: panel hidden and inert, focus moves to `Show work panel`. Stacked: separator removed. |
| Buttons | Primary (ink), secondary (white, control border), quiet (accent text), icon, preview | Hover darkens or tints; active (pressed) deepens; focus ring. Disabled: `#ebe8e2` fill, `#6b665e` text, with a visible reason nearby. Unavailable preview controls stay focusable with `aria-disabled` and a dashed border. |
| Request field | Legacy composer: label, textarea, hint, counter, Start | Default control border; focus accent border and ring; error: danger border, `aria-invalid`, message (`Enter a request of 1 to 500 characters.` or `The request is limited to 500 characters.`) and Start disabled. After start the composer is replaced by a locked note; captured mode has no field. |
| Tabs | Finalized legacy canvas `Target` / `Evidence` | Group with control border; selected tab white with control border; focus ring; arrows, Home, End; selection resets only when the run changes. Absent during active measurement and in captured mode. |
| Status indicators | Run-state pill, verdict pill, outcome badges, canvas surface label, evidence-side label | Icon plus text in every tone: ready (ring), working and finalizing (half ring), result pending (clock), disconnected (warning notice), verdicts (check or cross), Pass / Fail / Unevaluable, Live / Not live / Prepared preview / Stored evidence, Available / Loading / Phase not produced / Evidence ID not received / Unreadable. |
| Activity cards | Observed work groups, current card, disconnected notice, simulated card | Default observed; current: accent inset bar plus `Current` tag; last observed before disconnection: warning tag; expanded details list each event's sequence, type, raw phase, message, and IDs; simulated (preview only): dashed preview border plus `Simulated` tag. |
| Disclosures | Card details, all gates/checks, diff and provenance, identity and cleanup | Collapsed and expanded chevron with `aria-expanded`; hover fill; focus ring. State survives new activity, resizing, collapse, and state changes on the same run. |

## 5. Content and semantics rules (proposed)

- Exact claims: `Verified Fix` only for a successful legacy result; `Candidate verification passed`
  only for a successful captured result. The status pill, collapsed status, and result card all
  show the same authoritative verdict; none appears before a bound result.
- Three separate dimensions: execution view (ready, working, finalizing, result pending), activity
  connection (a separate warning), and verdict. A disconnected stream reads `Result pending` plus
  `Live activity disconnected`, never a failure or success.
- `Finalizing` labels only exact observed markers: captured secret-scan and cleanup activity, or the
  legacy original-worktree gate update. Expanded details keep the raw phase (for example
  `replaying`).
- Work cards show only observed events: no agent reasoning, percentages, elapsed-time estimates,
  or completed checks that the result did not report. Captured candidate-preparation cards state
  that build and check outcomes come only from the final result.
- Every state names one supported next action. Closing the Studio keeps its existing meaning; no
  cancel, retry, or resume control is offered.
- Legacy provenance is shown only from the result; the preview states that it does not simulate one.
  Captured results state that no model diagnosis or citations were evaluated.

## 6. Measured checks

Tested revision `e80e291cc4425cf49089be46e4deb8819007ff03` (the preview and the values above),
rendered in Playwright 1.64.1 Chromium 156.0.8078.4 on an isolated display: 346 desktop/compact
and 56 native-zoom checks, 0 failures. The full record, commands, and evidence location are in the
[preview README](../../tests/manual/studio-design/README.md#verification-record).

| Check | Observed |
| --- | --- |
| Enabled text contrast | Minimum 4.96:1 across 2,744 rendered samples in all states (requirement 4.5:1) |
| Disabled text | Minimum 4.66:1 (exempt, still readable) |
| Control boundaries, fills, and meaningful icons | Minimum 3.52:1 across 323 samples (requirement 3:1) |
| Focus indicator | 2px, at least 6.75:1 against its background at every Tab stop recorded |
| Layout | No page-wide horizontal overflow at 1280 x 720, 1920 x 1080, 390 x 844, 320 x 640, and native 200% (640 x 360 CSS viewport) |
| Keyboard | Seven panel widths, collapse/restore, tabs, and disclosures operable by keyboard; skip links lead the Tab order; the hidden panel and stacked separator leave the focus order |

These results show the proposed values are mechanically usable. They are not owner acceptance.

## Owner review record

**Decision**: Initial revision rejected on 2026-11-04 for excessive density. A minimalist revision
is requested; its visual acceptance remains pending.

| Field | Value |
| --- | --- |
| Source offered for review | `e80e291cc4425cf49089be46e4deb8819007ff03` (unchanged preview files); handoff and delivery gaps in the preview README |
| Reviewed revision | Pending |
| Review date | Pending |
| Hierarchy | Pending |
| Density | Rejected: too many buttons and unnecessary text |
| Work-to-canvas balance | Pending |
| Requested revisions | Conversation/input beside a large canvas; remove dashboard clutter |

Pending or negative feedback is not visual acceptance (SC-007).
