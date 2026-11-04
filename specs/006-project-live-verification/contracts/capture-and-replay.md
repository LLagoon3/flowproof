# Contract: Demonstration Capture and Independent Replay

**Feature**: [spec](../spec.md) | **Data model**: [entities](../data-model.md)

## Observation Authority and Capture Boundaries

Only the actual target frame/context admitted by the launcher may supply recorder callbacks.
The host checks source origin/frame, capture/project/baseline/configuration identity and document
epoch, normalizes payloads and assigns its own ordered sequence. New-document instrumentation is
reinstalled for admitted same-origin navigation; pending input is flushed before epoch changes.
Inaccessible/unsupported actions, dropped events and observation errors make completeness explicit.
Finish drains pending work and seals the report; duplicate Finish cannot produce a different digest.
Discard before submission clears staging and any sealed files and permanently invalidates that ID.

Supported initial actions are DOM click, safe fill/change, native select, container/page scroll and
same-origin navigation. Unsupported drag/drop, uploads/downloads, canvas-drawing gestures, popups,
new tabs, other frames/origins, browser chrome and arbitrary keyboard shortcuts do not become fake
supported actions. Uncapturable actions inside the admitted target must be reported as unsupported
or incomplete, not silently omitted; activity outside that target is never collected.

Collect start/finish and meaningful-action image observations, safe text/locator summaries and
available target-attributed console/page-error/failed-request/HTTP-error metadata. Record an explicit
unavailable status when collection is absent; an empty list is not an independent error-free verdict.
No broad DOM dump, request/response body, cookie/header, raw video, trace or HAR is retained.

## Privacy Before Retention and Submission

- Text normalization/filtering precedes staging/persistence/hashing/model submission. Strip URL
  credentials/query secrets and restrict navigation to admitted relative paths.
- Mask all input/contenteditable regions in screenshot capture by default, plus configured private
  selectors and sensitive rendered regions discovered by supported rules. Keep safe synthetic fill
  values separately only if explicitly admitted; never record passwords/identity/payment/secret values.
- Sanitize locator names/labels and DOM extracts too; a secret selector must not leak a value through
  an apparently safe action event. If it cannot be represented safely, mark the action unsupported.
- Image masks are applied as part of producing the retained PNG, not by scanning raw PNG bytes later.
  Do not log/save raw images, full browser state or screenshots of the surrounding desktop.
- Unknown sensitive canvas/image/text content is not guaranteed safe by regex. Reject unsupported
  private visual surfaces or exclude them; if essential visual evidence is excluded, analysis/verification
  cannot pretend that evidence exists. Initial evaluation uses permitted public/synthetic content.
- User review shows the sanitized observations to be submitted. Analyze is explicit consent for that
  bounded host-to-Meta transfer; completing capture alone does not contact a model.

## Resource Limits (Not a Human Deadline)

- At most 200 normalized actions, 16 images <=1 MiB each, 64 KiB combined console/network summaries
  and 20 MiB staged sanitized report. Typing/scroll bursts coalesce without reordering their final effect.
- If a limit is exceeded, stop accepting a complete report and show the precise incompleteness reason;
  do not truncate silently or announce that the defect was reproduced. The window does not auto-close.
- Model selection is deterministic and disclosed: at most eight safe images and 32 source files,
  256 KiB source text and 8 MiB total serialized request. Included/omitted IDs are recorded. Essential
  start/error/end observations must fit or the report is unsupported for analysis. Sampling is not
  claimed to be continuous video understanding or complete every-frame retention.

## Replay Definition

A strict versioned JSON description contains entry state, viewport, a finite ordered action list,
required expected conditions and observation citations. Data only; no functions, code strings,
regular-expression source, shell, arbitrary HTTP client, module path or page evaluation is accepted.
Host-generated safe identifiers bind it to the frozen definition and actual target build.

| Operation | Accepted fields | Host behavior |
| --- | --- | --- |
| `click` | locator | unique, visible, interactable target; reject ambiguity |
| `fill` | locator, admitted safe value | fill a supported text field; reject a redacted/missing necessary value |
| `select` | locator, safe option value | native DOM select only |
| `scroll` | page or locator, bounded absolute x/y | scroll actual admitted target/container |
| `navigate` | admitted relative path | exact same target origin, no URL credentials/external redirect |
| `wait` | visible/text/path condition and bounded duration | deterministic state condition, not arbitrary sleep/JavaScript |

Locator preference: unique test ID, role plus safe accessible name, then a bounded unique simple CSS
selector. No coordinate-only inference, arbitrary script expression, XPath injection or dynamic selector
program is accepted. Selector ambiguity or disappearance fails replay execution; it does not establish
the intended application defect. User descriptions are not substituted for missing recorder evidence.

Start each automatic replay in fresh browser storage/state and a baseline/candidate build tied to
that phase. The interpreter can execute only the frozen definition; candidates cannot replace it,
its compiler, source admission, configuration or required evidence list. Preserve actual viewport,
entry path and action ordering. Human pointer/keyboard input cannot enter an automatic replay.

## Expected-Behavior Conditions

Allow 1–8 finite conjunctive DOM/URL/error conditions, with one designated task condition tied to
observed failure and the clarified intended result:

- Element visible/hidden or exact bounded count.
- Exact or whitespace-normalized safe text content.
- Safe form value, or exact same-origin path.
- Absence of a specified observed target error class/message fingerprint or failed-request pattern,
  only if the relevant collector was available in both phases.

No arbitrary code, always-true placeholder, model's pass statement or screenshot-difference threshold
is a supported condition. A condition's meaning must be shown to the user; if intended semantics
cannot be inferred confidently, ask the focused clarification before freezing it. Visual images
support the explanation but are not a general pixel/canvas correctness oracle.

## Freeze and Baseline/Candidate Evaluation

Freeze canonical hashes of the admitted project/baseline/source/configuration, completed report,
model interpretation, replay/expectations, required commands/evidence and host compiler version.
Definitions and evaluator stay outside candidate mounts. Editing config/tests/checks is rejected
at patch admission; runtime modifications to source/check inputs also invalidate the run.

Baseline replay must execute every action successfully, obtain required run-bound observations,
and fail the designated task condition in the demonstrated intended way. A startup/build failure,
missing selector, timeout, unavailable collector, or unrelated assertion failure is not reproduction.
If the task condition passes already, finish `not_reproduced` and do not request a patch.

Candidate replay repeats exactly the same definition after fresh build/checks and browser-state reset.
All required expectations/checks/evidence, original integrity and cleanup must pass for success.
Wrong-run/build/report/definition observations are rejected. The candidate cannot make missing checks
optional, reset the frozen baseline, edit the compiler, or use screenshot difference as a substitute.

## Failure Semantics and Required Negative Cases

Exercise empty/partial/discarded capture, limit overflow, unsupported user action, duplicate/out-of-order
callback, forged origin/frame/epoch, navigation losing queued input, ambiguous locator/intent, redacted
required value, secret in a locator/image/error, stale configuration/baseline, replay state carryover,
missing visual/error collector, fake diagnosis, altered definition and late completion after cancellation.
Every case must have an explicit non-success or clarification outcome. No candidate is requested before
baseline reproduction and no implementation test may claim actual live acceptance via a prepared patch.
