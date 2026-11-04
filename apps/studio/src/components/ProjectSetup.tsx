import { useCallback, useEffect, useState } from 'react'

import { parseProjectContextView } from '../api.js'
import type { ProjectContextView } from '../api.js'

const SANDBOX = 'allow-scripts allow-same-origin allow-forms'

function messageFor(code: string | null): string {
  switch (code) {
    case 'PROJECT_BASELINE_STALE':
      return 'The project changed after it was admitted. Close this session and select the project again.'
    case 'CONFIGURATION_INVALID':
      return 'These settings are not supported by the fixed project profile.'
    case 'PROJECT_PREPARATION_ACTIVE':
      return 'Project preparation is already running.'
    case 'CONFIGURATION_REQUIRED':
    case 'CONFIGURATION_STALE':
      return 'Review and confirm the current settings before preparing the project.'
    default:
      return 'FlowProof could not complete project setup. Review the project state and try again.'
  }
}

async function responseCode(response: Response): Promise<string | null> {
  try {
    const value: unknown = await response.json()
    if (typeof value === 'object' && value !== null && 'error' in value) {
      const error = (value as { error?: { code?: unknown } }).error
      return typeof error?.code === 'string' ? error.code : null
    }
  } catch {
    // The response body is untrusted and is never displayed.
  }
  return null
}

async function readContext(): Promise<ProjectContextView> {
  const response = await fetch('/api/project/context', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(messageFor(await responseCode(response)))
  const parsed = parseProjectContextView(await response.json())
  if (parsed === null) throw new Error('The project setup response was invalid.')
  return parsed
}

export function ProjectSetup() {
  const [context, setContext] = useState<ProjectContextView | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await readContext()
    setContext(next)
    return next
  }, [])

  useEffect(() => {
    let active = true
    void readContext().then(
      (value) => {
        if (active) setContext(value)
      },
      () => {
        if (active) setError('The project setup information is unavailable.')
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (context?.preparation.state !== 'preparing') return
    let active = true
    const poll = async () => {
      try {
        const next = await readContext()
        if (active) setContext(next)
      } catch {
        if (active) setError('The project setup information is unavailable.')
      }
    }
    const timer = window.setInterval(() => void poll(), 750)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [context?.preparation.state])

  const confirmAndPrepare = async () => {
    if (context === null || !confirmed || busy || context.project.admission.state !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      const configuration = await fetch('/api/project/configuration', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: context.project.project_id,
          baseline_commit: context.project.baseline_commit,
          settings: context.configuration.settings,
          confirm: true,
        }),
      })
      if (!configuration.ok) throw new Error(messageFor(await responseCode(configuration)))
      const configured: unknown = await configuration.json()
      if (typeof configured !== 'object' || configured === null || !('configuration_id' in configured)) throw new Error('The project configuration response was invalid.')
      const configurationId = (configured as { configuration_id?: unknown }).configuration_id
      if (typeof configurationId !== 'string') throw new Error('The project configuration response was invalid.')
      const started = await fetch('/api/project/prepare', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ configuration_id: configurationId }),
      })
      if (!started.ok) throw new Error(messageFor(await responseCode(started)))
      await refresh()
      setConfirmed(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FlowProof could not complete project setup.')
      try {
        await refresh()
      } catch {
        // Keep the original user-safe error.
      }
    } finally {
      setBusy(false)
    }
  }

  if (context === null) {
    return (
      <main className="project-setup" aria-labelledby="project-setup-title">
        <h1 id="project-setup-title">Open a local project</h1>
        <p role={error ? 'alert' : 'status'}>{error ?? 'Loading project details…'}</p>
      </main>
    )
  }

  const { project, configuration, preparation } = context
  const isReady = preparation.state === 'ready' && preparation.target_url !== null
  const blocked = project.admission.state !== 'ready' || configuration.state === 'rejected'

  return (
    <main className="project-setup" data-testid="project-setup" aria-labelledby="project-setup-title">
      <header className="project-setup__header">
        <p className="project-setup__eyebrow">FlowProof · local project</p>
        <h1 id="project-setup-title">Review your project</h1>
        <p>FlowProof will build the committed project in its fixed offline runtime. No model request is made during setup.</p>
      </header>

      <section className="project-setup__identity" aria-label="Project identity">
        <dl>
          <div><dt>Project</dt><dd>{project.label}</dd></div>
          <div><dt>Path</dt><dd data-testid="project-root">{project.display_root}</dd></div>
          <div><dt>Branch</dt><dd>{project.branch ?? 'Detached HEAD'}</dd></div>
          <div><dt>Revision</dt><dd><code>{project.baseline_commit.slice(0, 12)}</code></dd></div>
          <div><dt>Profile</dt><dd>{project.category}</dd></div>
          <div><dt>Model configured</dt><dd>{context.model_configured ? 'Yes' : 'No'}</dd></div>
        </dl>
      </section>

      <section className="project-setup__settings" aria-labelledby="project-settings-title">
        <h2 id="project-settings-title">Build settings</h2>
        <p>{configuration.source === 'file' ? 'Settings loaded from the supplied configuration file; review before confirming.' : 'Suggested settings for the supported project profile.'}</p>
        <dl>
          <div><dt>Entry</dt><dd><code>{configuration.settings.entry_path}</code></dd></div>
          <div><dt>Build command</dt><dd><code>{configuration.settings.build.argv.join(' ')}</code></dd></div>
          <div><dt>Output</dt><dd><code>{configuration.settings.build.output_directory}</code></dd></div>
          <div><dt>Required checks</dt><dd>{configuration.settings.required_project_checks.length === 0 ? 'None supplied' : configuration.settings.required_project_checks.map((check) => check.id).join(', ')}</dd></div>
        </dl>
        {configuration.reasons.length > 0 && <p role="alert">Settings need review: {configuration.reasons.join(', ')}</p>}
      </section>

      {preparation.state === 'ready' && preparation.checks.length > 0 && (
        <section className="project-setup__checks" aria-label="Project checks">
          <h2>Project checks</h2>
          <ul>{preparation.checks.map((check) => <li key={check.id}>{check.id}: {check.status.replace('_', ' ')}</li>)}</ul>
        </section>
      )}
      {preparation.state === 'failed' && <p role="alert">{messageFor(preparation.reason)}</p>}
      {project.admission.state === 'stale' && <p role="alert">The project changed after admission. Start a new session to review its current committed state.</p>}
      {error && <p role="alert">{error}</p>}

      {!isReady && (
        <section className="project-setup__confirm" aria-label="Confirm project setup">
          <label>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={busy || blocked || preparation.state === 'preparing'} />
            I reviewed the committed project identity and fixed build settings.
          </label>
          <button type="button" onClick={() => void confirmAndPrepare()} disabled={!confirmed || busy || blocked || preparation.state === 'preparing'} data-testid="confirm-project-settings">
            {preparation.state === 'preparing' || busy ? 'Preparing project…' : 'Confirm settings and prepare'}
          </button>
          {preparation.state === 'preparing' && <p role="status">Building the selected committed project in the offline runtime…</p>}
          {preparation.state === 'idle' && configuration.state === 'required' && <p>Confirming starts the fixed build and required checks; selecting the project alone runs nothing.</p>}
        </section>
      )}

      {isReady && (
        <section className="project-setup__target" aria-label="Prepared project">
          <h2>Prepared project</h2>
          <p>The target is served from immutable output at its isolated local origin.</p>
          <iframe title="Prepared project application" src={preparation.target_url!} sandbox={SANDBOX} data-testid="project-target" />
        </section>
      )}
    </main>
  )
}
