# Local Studio API Contract

The Studio API is an internal loopback surface shared by the React workspace and the local
FlowProof engine. It is not a hosted service or a general repository automation API.

## Transport and session boundary

- Bind only to `127.0.0.1` on an ephemeral port. Do not bind to all interfaces.
- Open the Studio in the pinned headed Chromium build used for scenario capture.
- Establish one launch session with an `HttpOnly`, `SameSite=Strict` cookie. The cookie value is
  held in memory, never logged, and never written to run artifacts.
- Require the expected loopback `Origin` on state-changing requests and SSE connections.
- Apply a restrictive Content Security Policy that permits only the Studio bundle, its loopback
  API, and the selected prepared target frame.
- Return `Cache-Control: no-store` on every API and report response.
- Accept and return JSON unless the endpoint explicitly uses SSE or HTML.

## List prepared cases

`GET /api/scenarios`

The response lists only safe presentation metadata: `scenario_id`, `case`, `title`, and
`default_request`. It never exposes filesystem paths, commands, oracle locations, provider fixture
paths, or the source allowlist. The Studio uses this endpoint for its prepared-case selector.

## Start a run

`POST /api/runs`

```json
{
  "scenario_id": "canvas-filter-hero",
  "request_text": "Find the incorrect Canvas filtering behavior and verify the fix."
}
```

The body contains only a committed scenario identifier and bounded natural-language goal. It does
not accept paths, commands, expected values, oracle locations, gate definitions, model options, or
patch instructions. The server resolves every execution boundary from the committed scenario.

Successful response: `202 Accepted`

```json
{
  "request_id": "69f414d8-aa1e-4b2d-8c60-a5ce21b415cf",
  "run_id": "3d2642cc-e3d1-4c15-ae44-56fa719cd48e",
  "events_url": "/api/runs/3d2642cc-e3d1-4c15-ae44-56fa719cd48e/events"
}
```

The MVP rejects a second start request while the session already has an active run.

## Stream ordered activity

`GET /api/runs/:runId/events`

The response uses `text/event-stream`. Each record has the following form:

```text
id: 3d2642cc-e3d1-4c15-ae44-56fa719cd48e:7
event: evidence_added
data: {"schema_version":"1.0.0","event_id":"...:7","run_id":"..."}
```

The full `data` object validates against `studio-event.schema.json`. The server appends an event to
`events.jsonl` before delivery. On reconnect, the client supplies `Last-Event-ID`; the server sends
only later records in ascending sequence. An SSE disconnect never cancels or restarts the run.
Comment-only heartbeat records are allowed and are not Studio Events.

## Read the authoritative result

`GET /api/runs/:runId/result`

- While the run is active: `202 Accepted` with `{"state":"running"}`.
- After finalization: `200 OK` with the object from `run-result.schema.json`.

The final result comes from deterministic gate reduction, not the Studio event stream.

## Review and export the Proof Trail

- `GET /api/runs/:runId/report` returns the self-contained sanitized HTML Proof Trail.
- `GET /api/runs/:runId/evidence/:evidenceId` returns one allowlisted sanitized artifact.
- `GET /api/runs/:runId/artifacts/candidate-diff` returns the validated candidate diff when one
  exists.

There is no generic file endpoint. Route parameters are validated against the selected run and
contract identifiers; clients cannot submit filesystem paths.

## Error response

Every error uses the following shape:

```json
{
  "error": {
    "code": "ACTIVE_RUN_EXISTS",
    "message": "This Studio session already has an active run."
  }
}
```

The `code` is stable uppercase snake case. The message may identify a rejected scenario field,
run, gate, or allowlisted identifier, but never echoes credentials, cookies, raw chat, prompts,
provider payloads, request bodies, query strings, or rejected secret-bearing values.

## Shutdown and failure behavior

Closing the browser disconnects the UI but does not change an active run's deterministic outcome.
An interrupt stops accepting new requests, finalizes a started run as `Unverified` when required,
flushes contract-valid artifacts, and then removes the temporary worktree. A target-frame load
failure occurs before model use and finalizes safely with its failed or unevaluable gates.
