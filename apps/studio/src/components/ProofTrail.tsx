import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'

import { evidenceUrl, studioError, toStudioError } from '../api.js'
import type { EvidencePhase, EvidenceType, GateOutcome, PhaseDurations, StudioClient, StudioError } from '../api.js'
import { selectProofTrail } from '../state.js'
import type { ProofTrailCapture, ProofTrailEvidence, ProofTrailView, RunView } from '../state.js'
import { GATE_LABELS, GATE_STATUS_LABELS } from './AgentPanel.js'

// The in-workspace Proof Trail of a finalized run: its final status, who produced the diagnosis
// (an injected fixture is labeled as such), the failure capture with its screenshot, the candidate
// diff, the replay capture with its screenshot, all nine gate outcomes, and the phase timing. The
// trail comes only from the authoritative result and the Evidence IDs the session holds; artifact
// contents are read through the closed evidence and candidate-diff routes and rendered as text or
// same-origin images, never as markup. A phase the run never reached is reported absent.

export interface ProofTrailProps {
  /** The current run from `studioReducer`; the trail appears once its result is final. */
  readonly run: RunView | null
  /** The same-origin Studio client used for the closed artifact reads. */
  readonly client: StudioClient
}

type Loaded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StudioError }

/** Settled artifact reads of one run; an entry is absent while its read is in flight. */
interface RunArtifacts {
  readonly runId: string
  readonly diff: Loaded<string | null> | null
  readonly evidence: Readonly<Record<string, Loaded<unknown>>>
}

const PHASE_TITLES: Readonly<Record<EvidencePhase, string>> = {
  failure: 'Failure evidence',
  replay: 'Replay evidence',
}

const PHASE_ABSENT: Readonly<Record<EvidencePhase, string>> = {
  failure: 'Failure capture did not complete, so no failure evidence or screenshot exists for this run.',
  replay: 'Replay did not run, so no replay evidence or screenshot exists for this run.',
}

const EVIDENCE_LABELS: Readonly<Record<EvidenceType, string>> = {
  actions: 'Reproduction actions',
  dataset: 'Expected and observed dataset',
  chart: 'Rendered chart series',
  screenshot: 'Canvas screenshot',
  console: 'Console entries',
  network: 'Network metadata',
  source: 'Permitted source',
}

const DURATION_LABELS: Readonly<Record<keyof PhaseDurations, string>> = {
  capture: 'Failure capture',
  model: 'Diagnosis',
  apply: 'Apply and rebuild',
  replay: 'Replay',
  finalize: 'Finalization',
}

/** Dataset and chart evidence decide the oracle gates, so they open by default. */
const OPEN_BY_DEFAULT: ReadonlySet<EvidenceType> = new Set(['dataset', 'chart'])

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** The client-authored message for an error's stable code. */
const safeMessage = (error: StudioError): string => studioError(error.code).message

/** The JSON evidence of both captures, as a stable key; screenshots are images, never JSON reads. */
function jsonEvidenceKey(trail: ProofTrailView | null): string {
  if (trail === null) return ''
  return [...trail.failure.evidence, ...trail.replay.evidence]
    .filter((item) => item.type !== 'screenshot')
    .map((item) => item.evidenceId)
    .join(' ')
}

function settle<T>(request: Promise<T>, deliver: (loaded: Loaded<T>) => void): void {
  request.then(
    (value) => deliver({ ok: true, value }),
    (error: unknown) => deliver({ ok: false, error: toStudioError(error) }),
  )
}

/** Reads the candidate diff and JSON evidence of the trail's run; reads abort on change or unmount. */
function useRunArtifacts(client: StudioClient, trail: ProofTrailView | null): RunArtifacts | null {
  const [artifacts, setArtifacts] = useState<RunArtifacts | null>(null)
  const runId = trail?.runId ?? null
  const wantsDiff = trail?.candidateDiff === true
  const evidenceKey = jsonEvidenceKey(trail)

  useEffect(() => {
    if (runId === null) return
    const controller = new AbortController()
    const { signal } = controller
    const update = (change: (current: RunArtifacts) => RunArtifacts): void => {
      if (signal.aborted) return
      setArtifacts((previous) => change(previous?.runId === runId ? previous : { runId, diff: null, evidence: {} }))
    }
    if (wantsDiff) settle(client.readCandidateDiff(runId, signal), (diff) => update((current) => ({ ...current, diff })))
    for (const evidenceId of evidenceKey === '' ? [] : evidenceKey.split(' ')) {
      settle(client.readEvidence(runId, evidenceId, signal), (loaded) =>
        update((current) => ({ ...current, evidence: { ...current.evidence, [evidenceId]: loaded } })),
      )
    }
    return () => controller.abort()
  }, [client, runId, wantsDiff, evidenceKey])

  return artifacts !== null && artifacts.runId === runId ? artifacts : null
}

function placeholder(run: RunView | null): string {
  if (run === null) return 'The Proof Trail appears here after a run finalizes.'
  if (run.status === 'failed') return 'No Proof Trail: the run result could not be read, so no final status is shown.'
  return 'The Proof Trail appears when the authoritative run result is available.'
}

function FinalStatus({ trail }: { readonly trail: ProofTrailView }) {
  return (
    <section className="proof-trail__section proof-trail__status" aria-label="Proof Trail final status" data-status={trail.status === 'Verified Fix' ? 'verified' : 'unverified'}>
      <p className="proof-trail__verdict">{trail.status}</p>
      {trail.failedGateIds.length === 0 ? (
        <p className="proof-trail__note">All nine required gates passed.</p>
      ) : (
        <p className="proof-trail__note">Failed or unevaluable gates: {trail.failedGateIds.map((gateId) => GATE_LABELS[gateId]).join(', ')}</p>
      )}
    </section>
  )
}

function Provenance({ trail }: { readonly trail: ProofTrailView }) {
  const { provenance } = trail
  return (
    <section className="proof-trail__section" aria-label="Diagnosis provenance">
      <h3 className="proof-trail__heading">Diagnosis provenance</h3>
      {provenance.kind === 'fixture' ? (
        <div className="proof-trail__fixture" data-provenance="fixture">
          <p className="proof-trail__fixture-kind">
            <strong>Injected evaluation fixture.</strong> The diagnosis came from a labeled evaluation fixture, not from Meta Model API.
          </p>
          <p className="proof-trail__fixture-label">Label: {provenance.label}</p>
        </div>
      ) : (
        <p className="proof-trail__provider" data-provenance="meta">
          Meta Model API, model <code>{provenance.model}</code>.
        </p>
      )}
    </section>
  )
}

function Screenshot({ runId, capture }: { readonly runId: string; readonly capture: ProofTrailCapture }) {
  const label = `${capture.phase === 'failure' ? 'Failure' : 'Replay'} Canvas screenshot`
  if (capture.screenshotEvidenceId !== null) {
    return (
      <figure className="proof-trail__figure">
        <img className="proof-trail__screenshot" src={evidenceUrl(runId, capture.screenshotEvidenceId)} alt={label} data-evidence-id={capture.screenshotEvidenceId} />
        <figcaption className="proof-trail__caption">
          {label} <code>{capture.screenshotEvidenceId}</code>
        </figcaption>
      </figure>
    )
  }
  return (
    <p className="proof-trail__note">
      {capture.screenshotPath === null
        ? 'No screenshot was recorded for this phase.'
        : 'The screenshot was recorded, but its Evidence ID was not received in this session.'}
    </p>
  )
}

function EvidenceContent({ loaded }: { readonly loaded: Loaded<unknown> | undefined }) {
  if (loaded === undefined) return <p className="proof-trail__note">Loading the evidence.</p>
  if (!loaded.ok) {
    return (
      <p className="proof-trail__error" role="alert" data-code={studioError(loaded.error.code).code}>
        {safeMessage(loaded.error)}
      </p>
    )
  }
  return <pre className="proof-trail__json">{JSON.stringify(loaded.value, null, 2)}</pre>
}

function EvidenceEntry({ item, artifacts }: { readonly item: ProofTrailEvidence; readonly artifacts: RunArtifacts | null }) {
  const label = EVIDENCE_LABELS[item.type]
  if (item.type === 'screenshot') {
    return (
      <li className="proof-trail__item" data-evidence-id={item.evidenceId} data-type={item.type}>
        <code>{item.evidenceId}</code> {label}
      </li>
    )
  }
  return (
    <li className="proof-trail__item" data-evidence-id={item.evidenceId} data-type={item.type}>
      <details className="proof-trail__details" open={OPEN_BY_DEFAULT.has(item.type)}>
        <summary>
          <code>{item.evidenceId}</code> {label}
        </summary>
        <EvidenceContent loaded={artifacts?.evidence[item.evidenceId]} />
      </details>
    </li>
  )
}

function Capture({ trail, capture, artifacts }: { readonly trail: ProofTrailView; readonly capture: ProofTrailCapture; readonly artifacts: RunArtifacts | null }) {
  const title = PHASE_TITLES[capture.phase]
  const reached = capture.evidence.length > 0 || capture.screenshotPath !== null
  return (
    <section className="proof-trail__section" aria-label={title} data-phase={capture.phase} data-reached={reached}>
      <h3 className="proof-trail__heading">{title}</h3>
      {reached ? (
        <>
          <Screenshot runId={trail.runId} capture={capture} />
          {capture.evidence.length === 0 ? (
            <p className="proof-trail__note">No Evidence ID of this phase was received in this session.</p>
          ) : (
            <ul className="proof-trail__list" aria-label={`${title} items`}>
              {capture.evidence.map((item) => (
                <EvidenceEntry key={item.evidenceId} item={item} artifacts={artifacts} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="proof-trail__absent">{PHASE_ABSENT[capture.phase]}</p>
      )}
    </section>
  )
}

function CandidateDiff({ trail, artifacts }: { readonly trail: ProofTrailView; readonly artifacts: RunArtifacts | null }) {
  const verified = trail.status === 'Verified Fix'
  const title = verified ? 'Verified diff' : 'Candidate diff'
  const diff = artifacts?.diff ?? null
  let body: ReactNode
  if (!trail.candidateDiff) body = <p className="proof-trail__absent">No candidate passed validation in this run, so there is no diff.</p>
  else if (diff === null) body = <p className="proof-trail__note">Loading the diff.</p>
  else if (!diff.ok) {
    body = (
      <p className="proof-trail__error" role="alert" data-code={studioError(diff.error.code).code}>
        {safeMessage(diff.error)}
      </p>
    )
  } else if (diff.value === null) body = <p className="proof-trail__absent">The candidate diff is not available for this run.</p>
  else body = <pre className="proof-trail__diff">{diff.value}</pre>
  return (
    <section className="proof-trail__section" aria-label={title} data-verified={verified && trail.candidateDiff}>
      <h3 className="proof-trail__heading">{title}</h3>
      {trail.candidateDiff && !verified && <p className="proof-trail__note">This candidate is not verified: the run is Unverified.</p>}
      {body}
    </section>
  )
}

function GateEntry({ gate }: { readonly gate: GateOutcome }) {
  const metrics = Object.entries(gate.metrics)
  return (
    <li className="proof-gate" data-gate={gate.gate_id} data-status={gate.status}>
      <p className="proof-gate__head">
        <span className="proof-gate__name">{GATE_LABELS[gate.gate_id]}</span> <span className="proof-gate__status">{GATE_STATUS_LABELS[gate.status]}</span>{' '}
        <code>{gate.reason_code}</code>
      </p>
      <p className="proof-gate__message">{gate.message}</p>
      {gate.evidence_ids.length > 0 && (
        <ul className="proof-gate__evidence" aria-label="Cited Evidence IDs">
          {gate.evidence_ids.map((evidenceId) => (
            <li key={evidenceId}>
              <code>{evidenceId}</code>
            </li>
          ))}
        </ul>
      )}
      {metrics.length > 0 && (
        <p className="proof-gate__metrics">
          {metrics.map(([name, value]) => (
            <span key={name} className="proof-gate__metric">
              {name}: {String(value)}
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

function Gates({ trail }: { readonly trail: ProofTrailView }) {
  return (
    <section className="proof-trail__section" aria-label="Gate outcomes">
      <h3 className="proof-trail__heading">Gate outcomes</h3>
      <ol className="proof-trail__gates">
        {trail.gates.map((gate) => (
          <GateEntry key={gate.gate_id} gate={gate} />
        ))}
      </ol>
    </section>
  )
}

function Timing({ trail }: { readonly trail: ProofTrailView }) {
  const phases = Object.keys(DURATION_LABELS) as Array<keyof PhaseDurations>
  return (
    <section className="proof-trail__section" aria-label="Run timing">
      <h3 className="proof-trail__heading">Timing</h3>
      <dl className="proof-trail__timing">
        {phases.map((phase) => (
          <div key={phase} className="proof-trail__row" data-phase={phase} data-ms={trail.durations[phase]}>
            <dt>{DURATION_LABELS[phase]}</dt>
            <dd>{seconds(trail.durations[phase])}</dd>
          </div>
        ))}
        <div className="proof-trail__row proof-trail__total" data-phase="total" data-ms={trail.totalDurationMs}>
          <dt>Total</dt>
          <dd>{seconds(trail.totalDurationMs)}</dd>
        </div>
      </dl>
    </section>
  )
}

export function ProofTrail({ run, client }: ProofTrailProps) {
  const titleId = useId()
  const trail = selectProofTrail(run)
  const artifacts = useRunArtifacts(client, trail)
  return (
    <section className="proof-trail" aria-labelledby={titleId} data-run-id={trail?.runId ?? 'none'}>
      <h2 id={titleId} className="proof-trail__title">
        Proof Trail
      </h2>
      {trail === null ? (
        <p className="proof-trail__empty" role="status">
          {placeholder(run)}
        </p>
      ) : (
        <>
          <FinalStatus trail={trail} />
          <Provenance trail={trail} />
          <Capture trail={trail} capture={trail.failure} artifacts={artifacts} />
          <CandidateDiff trail={trail} artifacts={artifacts} />
          <Capture trail={trail} capture={trail.replay} artifacts={artifacts} />
          <Gates trail={trail} />
          <Timing trail={trail} />
        </>
      )}
    </section>
  )
}
