# Studio Workspace Design Preview

An isolated, clickable design preview for
[Spec 005](../../../specs/005-studio-workspace-ux/spec.md). It shows the proposed canvas-first
Studio workspace with **simulated data only** so the visual direction can be reviewed before any
production UI changes. It is design material, not a product route, a test suite, or evidence that
a real run behaves this way.

The proposed visual values and control inventory are recorded in
[design-system.md](../../../specs/005-studio-workspace-ux/design-system.md).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Static page shell, preview controls, and the labelled `Design preview — simulated data` notice. |
| `preview.css` | Proposed tokens, layout, and control states. Self-hosted; no remote fonts or assets. |
| `preview.js` | Synthetic mode/state data and presentation-only interactions. No network calls. |
| `README.md` | These instructions and the preview verification record. |

Nothing here is imported by the Studio bundle, served by the Studio backend, or discovered by the
repository's typecheck, Vitest, or Playwright configuration. There is no build step, no dependency,
and nothing to install.

## Run the preview

Serve the directory over loopback HTTP with any static file server. With Python 3:

```bash
# From the repository root. Check that the port is free first; pick another loopback
# port if it is taken, and do not stop a listener you did not start.
python3 -m http.server 43120 --bind 127.0.0.1 --directory tests/manual/studio-design
```

Open `http://127.0.0.1:43120/` in a desktop browser and stop the server with `Ctrl+C` when the
review ends. Loopback HTTP is the reviewed and verified path; opening `index.html` from the file
system may render in some browsers, but it was not part of the verification.

If a reviewer needs remote access, use an existing authorized connection to the loopback server.
Do not expose the server publicly. How the files are hosted is the operator's choice and is not
a project service.

## What the preview covers

- **Two modes.** *Legacy prepared case*: case picker, bounded request (1 to 500 characters), and
  `Start run`. *Captured candidate*: a host-fixed candidate and `Start candidate verification`,
  with no chat, model or provider selection, or candidate generation.
- **Six SC-002 states** for each mode: ready, active, finalizing, activity disconnected without a
  result, unsuccessful final result, and successful final result.
- **Exact success claims.** `Verified Fix` appears only for a successful legacy result and
  `Candidate verification passed` only for a successful captured result. The nine legacy gates and
  ten captured checks are available on demand in final states.
- **Canvas surfaces.** A synthetic scene of the demo chart, labelled as a prepared preview, a live
  candidate build, not live, or stored evidence. Finalized legacy results add `Target` and
  `Evidence` tabs; finalized captured results show stored evidence because the target was released.
- **Evidence examples.** Available before/after screenshots, a phase that was not produced, an
  Evidence ID that was not received, a loading screenshot, and an unreadable screenshot.
- **Work panel interactions.** Drag or keyboard resizing across seven widths (20 to 32rem, default
  24rem), collapse and restore with an updating external status and result entry, work-card
  disclosures, and a latest-work affordance when the reader is away from the newest activity.

The controls in the amber preview bar exist only in this preview. `Append simulated activity`
adds one clearly labelled synthetic card per click so reading-position behavior can be inspected.
Nothing advances on a timer, and no control sends a request.

## Allowed data and constraints

- Use only synthetic data. Chart values come from the committed synthetic demo dataset
  (`apps/demo-chart/src/data.ts`); labels, check names, and fixed messages mirror existing Studio
  copy. Run IDs, Evidence IDs, digests, and commits are synthetic placeholders.
- Do not add real run artifacts, screenshots, tokens, credentials, personal data, host paths, or
  output from a model.
- No product network access: the page's content security policy permits no connections, frames,
  remote fonts, or remote images. There is no live iframe and no product endpoint.
- No inline styles: panel widths are stylesheet-backed steps selected by a data attribute,
  matching the production policy `style-src 'self'`.

## Review evidence and ignore rules

Store review screenshots and measurement logs under the ignored
`.flowproof/review/005-studio-workspace-ux/<tested-sha>/slice1/<case>/` directory, outside
Playwright's `test-results/` output. Both paths are already covered by `.gitignore`
(`.flowproof/`, `test-results/`); no ignore rule changes are needed. Do not commit screenshots or
generated logs; record only concise results and repository-relative locations here.

## Owner review questions

The owner reviews comprehension and visual direction only; mechanical checks are recorded below.

1. Do the primary action and the canvas/work division make sense without explanation?
2. Can you tell current work, a pending result versus a final verdict, and available evidence apart?
3. Is the hierarchy, density, and balance comfortable enough to use?

The owner's decision is recorded in `design-system.md`, not inferred from these checks.

## Verification record

Not yet run. Results for the tested revision are recorded here after T005.
