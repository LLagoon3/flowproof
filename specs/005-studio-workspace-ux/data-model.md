# Presentation Data Model

This feature adds no persisted entity, wire schema, execution phase, or backend state machine.
The names below describe proposed local presentation types, not changes to existing contracts.

## Existing Sources of Truth

| Existing source | Remains responsible for |
| --- | --- |
| `StudioState` / `RunView` / `CapturedRunView` in `apps/studio/src/state.ts` | Mode, accepted start, run binding, ordered activity, stream status and authoritative result availability. |
| `selectGateRows` / `selectProofTrail` | Legacy gate outcomes, available evidence and diagnosis provenance. |
| `selectCapturedOutcome` / `selectCapturedIdentity` / `selectCapturedChecks` / `selectCapturedCleanup` | Strict captured result, candidate identity, ten checks and cleanup facts. |
| `selectCapturedTarget` / `selectCapturedEvidence` | Readiness-backed live labels and run-bound stored evidence; absent/not-received distinctions. |
| `createStudioClient` and existing artifact loading | Same-origin bounded reads, validation, abort handling and safe client-authored errors. |

## WorkspacePresentation (local)

- `panelWidthStep`: one of seven integer width choices, default the 24rem choice.
- `panelCollapsed`: boolean; never means run cancellation or event unsubscription.
- `selectedEvidence`: null or `{ runId, phase }`, where phase is `failure` or `replay`.
- `expandedWorkIds`: set of stable work-card identities; disclosures survive new activity and collapse.
- `detailsExpanded`: local result/check/provenance disclosure choices, bound to the current run.
- `followingLatest`: whether the reader is at the latest work; new events do not force this to true.

Reset run-bound choices only when run identity changes or the selected item genuinely ceases to
be valid. Responsive reflow and terminal result arrival do not reset unrelated view preferences.
No choice persists across launches or changes the execution reducer. Keep hidden panel content
mounted (but unavailable to focus while collapsed) so its disclosure and read state are retained.

## WorkCardView (derived)

- `id`: stable composition of run identity and first accepted event sequence of a contiguous group.
- `runId`, `firstSequence`, `lastSequence`: traceability to accepted events.
- `phase`: existing phase when present; an unknown phase is not invented.
- `title`, `statusText`: local readable labels derived from observed activity.
- `eventDetails`: accepted events and their existing references, in original order.
- `isCurrent`: indicates the observed group most relevant to the current pending run, not a verdict.

Group contiguous related events, not every occurrence of a phase across the whole history. Preserve
all accepted cards during the session rather than rendering only the latest 40 events and removing
an earlier focused card. Do not reconstruct missed events after a disconnected stream.
A group is complete only when its existing completion signal is observed or an authoritative
result supplies the relevant outcome; merely starting another group cannot turn an unknown check into a pass.

## RunPresentation (derived)

Maintain three independent dimensions:

1. **Execution view**: loading/unavailable case, ready, starting, observed active phase, observed
   finalizing work, result pending, or result unavailable.
2. **Activity connection**: existing stream state, displayed as a separate availability notice.
3. **Verdict**: absent until a valid bound final result, then the unchanged family-specific verdict.

Precedence: valid final result > result-read failure with no verdict > observed finalization/phase >
starting/ready. Stream failure adds a notice and may make the target non-live; it does not replace
execution/result facts. A final result wins over late activity and never downgrades to pending.

There is no existing `finalizing` execution enum. For captured mode, recognize only the exact
fixed scan/cleanup `agent_message` markers emitted by `capturedRun.ts`; for legacy, the observed
`original_worktree_unchanged` gate signals finalization work has occurred. A `run_finalized` event
without a result means result pending, not verified. Test these source-marker couplings explicitly;
if no marker was delivered, use truthful pending/current-phase copy rather than a fabricated phase.

## ResultSummaryView (derived, mode-discriminated)

- `runId`, `mode`, `verdict`, `explanation` from the authoritative family and safe local labels.
- `unsuccessfulChecks`: required checks/gates with fail or unevaluable outcomes; no omitted failures.
- `details`: original family-specific gate/check rows and reason data.
- `provenance`: legacy only; retain fixture/live distinction. Captured mode has no diagnosis claim.
- `cleanup`: captured facts where supplied; never a UI timer or optimistic animation.

No common view adapter converts `Candidate verification passed` into `Verified Fix` or fills in
legacy citation/provider data for captured runs. Keep nine legacy rows and ten captured rows.

## EvidenceComparisonView (derived, family-bound)

Each side contains run identity, phase, authorized evidence ID when available, safe same-origin
image URL, and one of: available, phase not produced, evidence ID not received, loading, or unreadable.
Legacy and captured selectors retain separate authorization rules. Never derive an Evidence ID
from a path, mix runs, reuse an unrelated screenshot, or call arbitrary raw-path routes.

Live target presentation is a separate source: measured frame readiness determines the live label.
Final evidence is static. Switching evidence views never reopens a target or changes its lifecycle.
