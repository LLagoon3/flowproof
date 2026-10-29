import { memo, useId } from 'react'

// The prepared-application pane of the Studio workspace: one frame that always loads the one
// committed target URL. The engine drives that frame through Playwright and repoints it to each
// rebuilt target, so the Studio only hosts it. The pane never reads the frame's document, listens
// for its messages, or navigates it, and it has no props, so a re-render never reloads the frame.

/** The committed `app.url` of the prepared application; the Studio CSP frames only its origin. */
export const TARGET_APP_URL = 'http://localhost:43119/'
const TARGET_APP_HOST = new URL(TARGET_APP_URL).host

export const TargetPane = memo(function TargetPane() {
  const titleId = useId()
  const hostId = useId()
  return (
    <section className="target-pane" aria-labelledby={titleId}>
      <header className="target-pane__header">
        <h2 id={titleId} className="target-pane__title">
          Prepared application
        </h2>
        <p id={hostId} className="target-pane__host">
          <code>{TARGET_APP_HOST}</code>
        </p>
      </header>
      <div className="target-pane__viewport">
        <iframe
          className="target-pane__frame"
          src={TARGET_APP_URL}
          title="Prepared application"
          aria-describedby={hostId}
          referrerPolicy="no-referrer"
        />
      </div>
    </section>
  )
})
