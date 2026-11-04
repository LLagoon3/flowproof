# Contract: Project CLI and Studio Interaction

**Feature**: [spec](../spec.md) | **Data model**: [entities](../data-model.md)

All interfaces below are proposed additions, not commands/routes available at Plan time. Existing
prepared CLI and API remain compatible. The actual Git branch includes its `feat/` namespace even
though the installed setup helper reports the active feature slug without that namespace.

## CLI

```text
flowproof studio --project <local-path> [--project-config <local-json-path>]
flowproof studio [--scenario <registered-scenario-id>]  # existing behavior
```

- `--project` and `--scenario` are mutually exclusive. No project argument means existing prepared
  mode, not implicit selection of an arbitrary current directory as a new user project.
- Canonicalize the selected root, verify committed clean supported inputs, and validate config
  read-only before commands/model calls. Confirm dependency/profile availability without pulling it.
- Optional JSON config uses `schema_version: 1`, `category`, `entry_path`, `build`
  (`argv`, `output_directory`) and `required_project_checks` (`id`, `argv` entries). These are
  strict bounded data keys describing category, relative entry, build/output and
  required project-check settings. It cannot choose model endpoint/credential, image, mounts, network,
  artifacts root, secret environment, browser profile, evaluator code or model transport implementation.
- Missing config opens configuration review with trusted profile suggestions. No project script is
  executed merely to discover settings. The user confirms before isolated build/start.
- Preserve existing exit categories: normal close `0`, close/interruption during active execution
  finalized as canceled/unverified `2`, usage/readiness failure `3`, internal/finalization failure `4`.
  A retained ordinary unsuccessful verification is not reclassified as a successful fix by exit `0`.
- Launch JSON identifies project-live mode, session and safe local origins. No key, auth-cookie value,
  arbitrary config contents or source is printed. Credentials come only from established host-managed
  environment, never the selected project's `.env` or an argument/browser field.

## Mode and User Journey

1. **Project/setup**: show selected root label, branch/revision, supported category, confirmed
   command/check scope and blockers. Explain that the target is an isolated build, not the original.
2. **Demonstration**: show the actual interactive target with Start capture, Finish and Discard,
   clear active/incomplete state and an optional description. No required written steps/test/assertion.
3. **Report/Analyze**: show sanitized observation availability and that Analyze sends admitted code,
   captured safe text and masked images to the configured Meta model. This action submits the report.
4. **Interpretation**: show observed problem, supporting images/errors, readable derived actions and
   expected behavior. If ambiguous, ask the focused missing-intent question rather than forcing a
   technical form. Verify-and-fix confirms meaning and freezes the obligation.
5. **Automatic work**: baseline reproduction -> real AI correction -> candidate build/check/replay
   -> finalization. Human target input is disabled here; Cancel remains available without changing
   captured/frozen definitions. Work timeline reports only observed events, never private reasoning.
6. **Result**: display bounded verdict, checks/reasons, before/after evidence, actual model metadata,
   exact diff and safe patch handoff. Keep original unapplied. Stored evidence is not a live app.

No human countdown/auto-close or repeated readiness handshake is introduced. Existing layout,
read-position/focus preservation, keyboard controls and result-disclosure design rules carry over.
No in-app folder browser, remote Git login, model selector, autonomous repair loop or Apply button.

## Loopback API

New routes use a dedicated project namespace and a strict `kind: project-live` family. Every route
uses existing exact Host/launch-cookie/fetch-metadata guards; mutations require exact Studio Origin.
Target-origin requests cannot read or mutate controller data. Request bodies reject extra keys and
have explicit byte/count limits. Run/capture IDs must be owned by this session, not merely valid UUIDs.

| Interface | Accepted data / result | Authority and conflicts |
| --- | --- | --- |
| `GET /api/project/context` | safe project identity, category, model-configured state, configuration suggestions/blockers | no provider request; no cookie/key/source exposure |
| `POST /api/project/configuration` | reviewed settings + confirmation for this project/baseline | host validates profile/direct argv/output; no arbitrary policy/root changes; invalid before execution |
| `POST /api/project/prepare` | confirmed configuration ID | revalidate baseline, isolated build/start only; no model call |
| `POST /api/project/captures` | current prepared target/configuration IDs | starts fresh target capture; one active attempt |
| `POST /api/project/captures/:id/finish` | empty closed object | ordered drain/seal; idempotent duplicate returns same report, not a new capture |
| `POST /api/project/captures/:id/discard` | empty closed object | pre-analysis only; delete staged/sealed report, no model submission; reused ID rejected |
| `POST /api/project/captures/:id/analyze` | optional sanitized description + explicit submission action | ready sealed capture only; locks report; invokes real analysis once |
| `POST /api/project/runs/:id/clarify` | current question ID + sanitized answer | explicit answer; at most one further analysis; stale question rejected |
| `POST /api/project/runs/:id/verify-and-fix` | interpretation ID/digest + confirmation | freezes checks, independently replays baseline; correction only after intended failure |
| `POST /api/project/runs/:id/cancel` | empty closed object | idempotent sticky cancel, aborts model/build/replay, finalizes resources |
| `GET /api/project/runs/:id/events` | ordered sanitized SSE | advisory activity, no unregistered artifact bytes or reasoning |
| `GET /api/project/runs/:id/result` | strict project result or explicit pending | authoritative terminal only after cleanup/integrity |
| `GET /api/project/runs/:id/artifacts/:artifactId` | registered safe image/text/diff/patch | closed ID+digest lookup; no path/URL/command parameters |

Recorder traffic is not a public POST endpoint: launcher-owned Playwright binding events validate
actual source frame/origin/epoch, then become host-owned observations. Requests from project code
cannot upload a fake complete report. This is an origin/schema boundary, not a proof of hostile-page
truthfulness; the residual limitation is documented in the Plan.

Use `400` for invalid closed schema, `403` for origin/session/authorization failures, `404` for unknown
owned-resource lookup, `409` for stage/identity/stale/duplicate-start conflicts, and fixed sanitized
operational reason codes for readiness/execution failure. Error messages do not echo supplied bodies,
credentials, provider output or arbitrary filesystem text. A refused request creates no model call.

## Retention and Cancellation

Discard is possible before model submission. After Analyze, Cancel stops remaining work but does
not claim already submitted content was never sent. A canceled run can retain safe partial evidence
and actual patch when available; absent artifacts are explicit. Closed target resources do not close
the user's result window or expire its stored-evidence view. Session-owned artifacts are outside
both selected source and executable target roots, with private directory/file permissions.
