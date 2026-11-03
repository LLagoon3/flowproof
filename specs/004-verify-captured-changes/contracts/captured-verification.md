# Contract: Captured Verification in the Existing Studio

Owner-approved design-only contract. The result label/family in [Plan](../plan.md) was approved on
2026-11-02. No implementation, browser-visible raw-patch endpoint, new production CLI or service exists.

## 1. Trusted in-process launch

A sibling `startCapturedVerificationStudio()` accepts the original repository root, the completed
Spec 003 capture/session result, and the exact prepared scenario ID. It snapshots candidate ownership
before asynchronous work, validates the capture/session composition and upstream cleanup, and selects
the fixed build/functional-check code. It opens the same kind of headed Studio result shell used by
`startStudio()`, returning the existing origin/session/page/close handle shape.

- Original HEAD and candidate baseline are independent facts; the baseline must resolve to the
  recorded full commit in the original object store, not a branch inferred from editor state.
- No model/provider field, arbitrary callback, command list, external URL or browser-selected
  baseline/candidate is accepted. The initial registered prepared scenario is the only target family.
- Invalid launch input fails with a fixed bounded error before a passing run or partial artifact
  is created. A capture with upstream cleanup/integrity failure is not silently promoted.
- Legacy `startStudio()` has the same accepted options and credential requirements as before.

The future manual QA launcher builds a deterministic captured candidate and calls this host API.
It is an acceptance harness, not a new provider integration or a production fixture command.

## 2. Worktree application

The captured entry point creates its fresh worktree at the recorded baseline and owns a separate
private Git/index/object store. All metadata writes for candidate application use that private state;
linked-worktree registration remains tracked and removed through the existing owner lifecycle.

Application receives the exact candidate Buffer, not a text reserialization. Seed/refresh the private
index, run Git's full precheck, apply once, and compare the resulting raw entry metadata with the
captured summary. Preserve text, binary, raw paths, add/delete, modes, link text and gitlink OIDs.
Keep Git's safe default path/link rules. No partial reject files, repair/merge, `--unsafe-paths`,
recursive submodule checkout or editing-workspace copying is allowed.

Any application/fidelity mismatch discards the owned candidate target and reports failure. Changes
to dependency manifests are preserved but do not authorize package installation or network access.
A missing prepared dependency is a real failure, not a reason to alter or shrink the candidate.

## 3. Guarded Studio routes and mode discrimination

Reuse the existing authenticated loopback host/origin/cookie/CSP guards and route paths.

- The host-fixed captured mode exposes only its prepared scenario. Its catalog/start context has an
  explicit execution-kind discriminator so the client can render a candidate-verification action,
  not Meta provider readiness, diagnosis or nine pending legacy provenance gates.
- `POST /api/runs` continues to carry only the registered scenario ID and bounded goal. Any raw
  patch, filesystem root, command, provider override or mode override in that body is rejected.
  The host chooses the starter; a browser request cannot use this mode to bypass legacy readiness.
- The accepted start response retains server-generated request/run IDs and the existing event URL.
  Bind every event/result/evidence lookup to that actual run; one run per launched target remains.
- Existing SSE envelope, ordering, sanitization and live-only semantics remain. Captured flow uses
  supported phases plus bounded real activity messages. No invented model events or new check IDs
  are placed in legacy `gate_updated` payloads.
- Result polling returns either the unchanged strict legacy `RunResult`, or the explicit strict
  `kind: captured-verification` family from [data-model.md](../data-model.md). Old result parsers
  reject the new family; new parsers dispatch by shape/discriminator and enforce identity.
- Existing evidence/manifests/image lookups and guarded result access remain closed-ID operations.
  Do not add a raw path route, binary patch upload/download, arbitrary artifact lookup or export.

Mode discrimination is an additive contract change only on the opt-in captured path. Legacy payloads
and their acceptance/rejection tests remain unchanged. Client state, pending UI, final renderer and
server parsing must be updated together; a server-only union is not a complete integration.

## 4. Verification and verdict

The concrete steps are baseline reproduction/evidence, exact candidate application, registered build,
prepared functional check, real replay dataset/chart observations, required scans and cleanup/integrity.
The functional checker and expected values are trusted original inputs, not replaced test files from
the candidate. It loads only the explicit candidate module of the prepared use case. No generic
language/test runner or dependency installation contract is added.

Captured-path `passed` requires every mandatory check in the data model, including actual
execution and evidence for required stages and complete cleanup. Other outcomes distinguish candidate
failure, execution error, timeout and user interruption with safe reasons. No later unexecuted check
is a pass. The result says no model diagnosis/citation was evaluated and is not `Verified Fix`.
Changing that product label requires owner scope/provenance agreement, not an automatic gate shim.

Use existing fixed scenario time windows with monotonic elapsed checks, abort timers, bounded output
and exact process-group ownership. Join stopped operations before disposing their workspace. Raw
exception/command output, unsafe paths, scanner finding values or private host locators never reach
Studio activity/result messages.

## 5. Visible page, input and finalization

- The same attached Studio iframe displays and supplies observations for baseline and candidate.
  `TargetApp.serveBuild/reconnect` proves the active served candidate and trusted-probe readiness;
  no separate hidden replay page can supply a passing result when this target failed to load.
- Before candidate readiness, phase labels identify baseline/preparation rather than suggest an
  old image is the candidate. Build/test summaries report actual execution, not decorative timers.
- A transparent parent cover and outer focus guard accidental user pointer/keyboard control during
  prepared measurement. The prepared programmatic select action still runs in the real frame.
  This is not a general automation broker or a defense against arbitrary malicious page behavior.
- The existing close/process-interrupt path cancels the active run. No cancel endpoint/button,
  manual exploration mode, reconnect protocol or playback controls are added.
- Capture evidence first; then stop live target serving/capture, join commands, dispose worktree and
  private state, compare original integrity and finalize scans/result. Cleanup failure prevents pass.
- After finalization, render explicitly labelled captured evidence/result in the existing shell.
  The application runtime is gone. Only the guarded result shell/evidence server and its browser
  remain until the user closes Studio. If closed mid-run, finalize locally and release everything.

## 6. Acceptance boundaries

Prove binary/raw-path/link/gitlink fidelity independently of screenshots. Prove frame/run/candidate
identity independently of result text. Prove that plausible visuals with wrong dataset/chart fail.
Inject missing evidence, baseline/input mismatch, failed build/check/load, timeout/interruption,
resource release and original-integrity failures. Run unchanged legacy/capture contracts and visible
Hero/Failure regressions. Record actual test discovery; zero-test success is not acceptance.
