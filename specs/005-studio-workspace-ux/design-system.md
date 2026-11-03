# Studio Core Design System

**Status**: Proposed. These values come from the slice 1 design preview
([tests/manual/studio-design/](../../tests/manual/studio-design/README.md)) and are not accepted.
The owner's actual hierarchy, density, and balance decision is recorded in
[Owner review record](#owner-review-record); until that decision is positive, no production UI
change may rely on this document.

This record keeps three kinds of information apart:

1. **Proposed values**: design choices the contributor made in the preview.
2. **Measured checks**: mechanical results (contrast, keyboard, layout, zoom) observed by running
   the preview at an exact revision. They show the values are usable, not that they are liked.
3. **Owner acceptance**: the owner's own decision about hierarchy, density, and balance (SC-007).
   It is never inferred from measured checks or from the request to build the preview.

## 1. Scope

One light appearance, English copy, desktop first with compact reflow. The vocabulary covers the
seven control families required by FR-010: workspace shell, buttons, request field, tabs, status
indicators, activity cards, and disclosures. It is a local rule set for Studio, not a component
package, theme system, or published design library.

## 2. Foundations (proposed)

### Color roles

Status meaning is always carried by text or an accessible name as well as color (FR-011).

| Role | Token | Value | Used for |
| --- | --- | --- | --- |
| App background | `--color-bg` | `#f7f6f3` | Page and work-panel backdrop |
| Surface | `--color-surface` | `#ffffff` | Cards, canvas frame, composer |
| Sunken surface | `--color-surface-sunken` | `#efede8` | Canvas stage behind the target scene |
| Muted surface | `--color-surface-muted` | `#f3f1ec` | Card details, read-only blocks |
| Subtle border | `--color-border-subtle` | `#e3e0d9` | Decorative separation only, never a control boundary |
| Control border | `--color-border-control` | `#857f75` | Meaningful input, select, and secondary-button boundaries |
| Text | `--color-text` | `#1c1b19` | Primary copy and headings |
| Secondary text | `--color-text-secondary` | `#5f5b54` | Supporting copy and labels |
| Tertiary text | `--color-text-tertiary` | `#6b665e` | Metadata and counters |
| Accent | `--color-accent` | `#4338ca` | Focus, selected tabs, links, current-work marker |
| Accent soft | `--color-accent-soft` | `#eef0ff` | Working/finalizing indicator background |
| Primary action | `--color-action` | `#1c1b19` | Primary button fill (white text) |
| Success | `--color-success` / `-soft` | `#166534` / `#ecfdf3` | Passed check, successful final verdict |
| Danger | `--color-danger` / `-soft` | `#b42318` / `#fef3f2` | Failed check, unsuccessful final verdict |
| Warning | `--color-warning` / `-soft` | `#8a4b08` / `#fffaeb` | Activity disconnected, attention notices |
| Neutral status | `--color-neutral` / `-soft` | `#5f5b54` / `#f1efea` | Unevaluable, pending, not live |
| Preview notice | `--color-preview` / `-soft` | `#5c4300` / `#fff3cf` | Preview-only bar; never used by product surfaces |

### Type

System font stacks only; no remote or bundled font files.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Verdict | 1.25rem / 1.3 | 600 |
| Section title | 1rem / 1.4 | 600 |
| Body (panel) | 0.875rem / 1.5 | 400 |
| Small / details | 0.8125rem / 1.45 | 400 |
| Caption / metadata | 0.75rem / 1.4 | 500 |
| Code / identifiers | 0.75rem / 1.45, monospace | 400 |

### Space, shape, elevation, focus, motion

- Space: 4px grid (`0.25rem` to `2rem`). Panel gutters 1rem; card padding 0.75rem to 1rem.
- Radius: 6px for badges and inputs, 10px for cards and buttons, 14px for canvas and composer.
- Elevation: one hairline shadow for cards and one soft shadow for the canvas frame and composer.
- Focus: 2px solid accent outline with a 2px offset on every interactive element.
- Motion: none is required. Color transitions are at most 120ms and disabled under
  `prefers-reduced-motion`. No timer, spinner, or animation implies progress.

## 3. Layout rules (proposed)

- Work panel left, canvas right. Panel widths are seven class-backed choices from 20rem to 32rem in
  2rem steps, default 24rem; dragging and separator arrow keys select the same choice.
- Below 64rem of available width the panes stack, the width separator is hidden and leaves the
  focus order, and the width choice is retained for the side-by-side layout.
- Collapsing hides and inerts the panel without removing it. A compact status outside the panel
  keeps updating and offers restore and, when a result exists, a result entry.
- Dense details scroll locally; the page has no page-wide horizontal scrollbar at supported sizes.

## 4. Control family inventory

Applicable states follow SC-007: default, focus, disabled, active, and error, where they apply.

| Family | Preview element | Applicable states | Notes |
| --- | --- | --- | --- |
| Workspace shell | Header, work panel, width separator, canvas, collapsed status and restore entry | Default; separator hover, focus, and dragging; collapsed; stacked compact | The separator exposes its width as a value with limits. |
| Buttons | Primary, secondary, quiet, and icon buttons | Default, hover, focus, active (pressed), disabled with a visible reason | One primary action per mode. |
| Request field | Legacy bounded request in the composer | Default, focus, error (empty or too long), read-only after start | Character counter; captured mode has no request field. |
| Tabs | Finalized legacy canvas `Target` / `Evidence` | Default, selected, focus | Arrow, Home, and End keys; absent during active measurement. |
| Status indicators | Run-state pill, check outcome badges, canvas surface label | Ready, working, finalizing, disconnected, pending, each final verdict; pass, fail, unevaluable | Icon plus text; never color alone. |
| Activity cards | Observed work groups, current card, disconnected notice | Default, current, expanded, focus | Built from observed events only; no invented reasoning or progress. |
| Disclosures | Card details, all gates/checks, diff and provenance, identity and cleanup | Collapsed, expanded, focus | State survives new activity, resizing, and collapse. |

## 5. Measured checks

Not yet run. T005 records the tested revision, commands, and outcomes here and in the
[preview README](../../tests/manual/studio-design/README.md#verification-record).

## Owner review record

**Decision**: Pending. No preview has been reviewed or accepted.

| Field | Value |
| --- | --- |
| Reviewed revision | Pending |
| Review date | Pending |
| Hierarchy | Pending |
| Density | Pending |
| Work-to-canvas balance | Pending |
| Requested revisions | Pending |

Pending or negative feedback is not visual acceptance (SC-007).
