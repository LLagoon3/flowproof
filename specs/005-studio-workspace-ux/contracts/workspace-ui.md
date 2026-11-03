# Studio Workspace UI Contract

**Consumer interface**: the existing Studio user interface. No new HTTP endpoint, event family,
CLI option, persistence format, or provider protocol is introduced. Existing service contracts
remain defined by Specs 001-004 and their current parsers.

## 1. Mode Boundary

| Surface | Legacy prepared case | Captured candidate |
| --- | --- | --- |
| Context | Existing case picker and scope | Host-fixed case/candidate and scope |
| Request | Existing bounded goal; no multi-turn conversation | No chat or provider/model input |
| Primary action | Existing start request | Existing candidate-verification start |
| Work | Accepted legacy events | Accepted captured events only |
| Success | `Verified Fix`, only from strict result | `Candidate verification passed`, only from strict result |
| Unsuccessful result | Existing `Unverified` semantics | Existing failed/interrupted/error semantics |
| Details | Nine gates, candidate diff, provenance, evidence | Ten checks, candidate identity, cleanup, available evidence |

Prepared dependencies and existing single-run admission rules still apply. A terminal session
may explain that a new launch is needed; it must not present a new backend retry/resume operation.

## 2. Visible States

| State / observation | Required presentation | Forbidden inference |
| --- | --- | --- |
| Catalog loading / unavailable | Clear reason; no enabled start before admission is possible | A ready candidate or request that was never loaded |
| Ready | Context, valid inputs if supported, one primary start action | A running verification |
| Start pending | Starting; duplicate start prevented | Accepted run identity before acknowledgement |
| Observed active phase | Current observed work card and appropriate target label | Percentages, hidden thoughts, or successful checks not supplied |
| Observed scan / cleanup | Finalizing work; verdict still pending | All checks passed or cleanup complete |
| Disconnected/rejected activity | Separate activity warning; polling remains independent | Execution failure, success, or a live target without readiness support |
| Stream finalized, result pending | Awaiting authoritative result | A verified status derived from an event alone |
| Invalid/unavailable result | No final verdict; safe error and supported next action | A failed verification result if no valid result exists |
| Bound final result | Exact family verdict, explanation, unsuccessful checks, detail access | UI-computed upgrade, omitted failure or cross-family success label |

The finalizing-marker decision and conservative fallback are defined in
[data-model.md](../data-model.md#runpresentation-derived). No timer synthesizes finalization.

## 3. Panels and Focus

- Left work panel/right canvas at normal desktop width; larger canvas by default. Compact layout
  may stack panes without alternate component trees or reparenting the target.
- Resizing uses bounded CSS-class widths. Dragging and separator arrow keys change the same choice;
  expose the current size and limits accessibly. Collapse/restore has an accessible name and focus.
  Below 64rem, hide the width separator and exclude it from focus; retain its width choice for the
  side-by-side layout. Stacked mode still supports collapse/restore.
- Outside a collapsed panel, show a compact current state derived from the same accepted events
  and authoritative result; it keeps updating through result arrival. Provide a visible keyboard
  restore/result entry that restores the panel and focuses the retained result if available.
- Panel collapse moves focus to the restore control if focus was within the panel. Hidden controls
  cannot receive keyboard input; restoration returns to a meaningful retained panel control.
- Keep the panel and artifact loader mounted while collapsed. Do not cancel a fetch, subscription,
  or run solely because a visual panel closes.
- New work does not remove focused earlier cards, steal focus, or force scrolling. Show a reachable
  latest-work affordance when the reader is away from the end. Avoid live-announcing whole logs.
- Tabs/disclosures use standard keyboard behavior and retain selection across unrelated updates.
- Layout/disclosure/evidence-selection state never sends a start, cancel, target navigation, model
  request or raw artifact-path request. The existing primary start action retains its actual request.

## 4. Actual Target and Evidence

- During baseline/candidate measurement, preserve exactly one target iframe, its element identity,
  its Playwright frame and existing pointer/keyboard guard. Resize/collapse never reloads it.
- Preserve the live wrapper's sole-child ownership so launcher removal does not conflict with
  React. Only existing finalization removes the target; do not keep a substitute alive.
- Before/after comparison is final-result presentation. While captured verification is active,
  do not switch away from the actual measured target to a synthetic or copied view.
- On finalized captured runs, no iframe remains; show labelled stored evidence or explicit absence.
  Legacy mode preserves its existing target lifetime and labels the prepared preview separately
  from stored run evidence; do not silently apply the captured disposal policy to legacy.
  Finalized legacy canvas tabs show target or stored evidence in the same stable canvas parent.
  Evidence selection hides/inerts the original iframe wrapper without unmounting/reparenting it;
  selecting target restores that exact element/frame. Do not use the old target/evidence replacement
  branch for legacy. The active measured target cannot be hidden by an evidence tab.
- Both sides identify phase and accessible evidence identity. Missing, not-received, loading and
  unreadable images are distinct from a successful screenshot. A failed side does not alter the verdict.
- Preserve legacy provider/fixture provenance and diff, and captured candidate identity/cleanup.
  These details may be disclosed on demand but must not be lost in a generic shared result card.

## 5. Design and Trust

- One local light design vocabulary: semantic color/type/space/surface roles and applicable states
  for buttons, request field, tabs, status indicators, work cards and disclosures plus the shell.
- Normal text contrast >=4.5:1; large text and meaningful control boundaries >=3:1. Status meaning
  is conveyed in words/accessible names as well as color. All journey controls have visible focus.
- No remote fonts/assets or inline-style dependency; no change to existing production CSP.
- Provider text, artifact contents, identifiers and errors stay escaped text or validated same-origin
  images. Do not turn a styled message into trusted HTML or surface rejected raw error payloads.

## 6. Preview Contract

An isolated preview must exercise both modes and the six SC-002 states, plus missing evidence and
collapsed/compact views. It always carries a visible `Design preview — simulated data` notice.
No model/API request, Docker run, executable candidate, real production token, or live target iframe
is needed. Buttons change only synthetic presentation state. It cannot prove runtime correctness.

Record owner comments and the version/commit shown before production UI implementation. The
owner decides hierarchy/density/balance; automated/agent checks establish keyboard/contrast/layout
mechanics. Pending or rejected feedback is not acceptance. This preview is not a production route.
