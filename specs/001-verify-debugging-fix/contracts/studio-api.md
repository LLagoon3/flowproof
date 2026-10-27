# Local Studio API Contract

The Studio API is an internal loopback surface shared by the React workspace and the local
FlowProof engine. It is not a hosted service or a general repository automation API.

## Transport and session boundary

- Bind the Studio only to `127.0.0.1` on an ephemeral port. Do not bind to all interfaces.
- Build the prepared demo app and serve it from `localhost` on its committed fixed port. The Studio
  and model-patched iframe therefore do not share a cookie host.
- Open the Studio in the pinned headed Chromium build used for scenario capture.
- Establish one launch session with an `HttpOnly; SameSite=Strict; Path=/` cookie injected through
  Playwright `context.addCookies()` before navigation. The value is held in memory, never logged,
  and never written to run artifacts.
- Reject requests whose `Host` does not exactly match the launched Studio authority.
- Require the launch cookie and exact Studio `Origin` on state-changing POST requests.
- Require the launch cookie and `Sec-Fetch-Site: same-origin` on GET and SSE requests. Same-origin
  GET and EventSource requests may omit `Origin`, so its absence is not an error on those methods.
- Apply a restrictive Content Security Policy that permits only the Studio bundle, its loopback
  API, and the selected prepared target frame.
- Return `Cache-Control: no-store` on every API response.
- Accept and return JSON unless the endpoint explicitly uses SSE.

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

## Stream live activity

`GET /api/runs/:runId/events`

The response uses `text/event-stream`. Each record has the following form:

```text
id: 3d2642cc-e3d1-4c15-ae44-56fa719cd48e:7
event: evidence_added
data: {"schema_version":"1.0.0","event_id":"...:7","run_id":"..."}
```

The full `data` object validates against `studio-event.schema.json`. Events are sanitized and
assigned a contiguous sequence before delivery. An SSE disconnect never cancels or restarts the
run, but the MVP does not persist or replay missed events through `Last-Event-ID`. Comment-only
heartbeat records are allowed and are not Studio Events.

## Read the authoritative result

`GET /api/runs/:runId/result`

- While the run is active: `202 Accepted` with `{"state":"running"}`.
- After finalization: `200 OK` with the object from `run-result.schema.json`.

The final result comes from deterministic gate reduction, not the Studio event stream. The Studio
uses the result and Evidence IDs already received to render the in-workspace Proof Trail.

## Read Proof Trail evidence

- `GET /api/runs/:runId/evidence/:evidenceId` returns one sanitized evidence artifact already
  registered in that run.
- `GET /api/runs/:runId/artifacts/candidate-diff` returns the validated candidate diff when one
  exists.

There is no generic path-based file endpoint, directory listing, portable report route, or bulk
download. Route parameters are validated against the selected run and contract identifiers; the
browser cannot submit filesystem paths.

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

An SSE disconnect alone does not change an active run. Closing the Studio page or browser removes
the authoritative visible target, so the engine stops the run, marks the affected gate failed or
unevaluable, finalizes it as `Unverified`, flushes contract-valid artifacts when possible, and
removes the temporary worktree. An interrupt follows the same safe finalization sequence. A target
frame load failure occurs before model use and finalizes safely with its failed or unevaluable
gates.
