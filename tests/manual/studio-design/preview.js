'use strict'

// Studio workspace design preview (Spec 005, slice 1).
//
// Every value below is synthetic presentation data. Chart values mirror the committed demo
// dataset and the copy mirrors existing Studio labels and fixed producer messages; run IDs,
// Evidence IDs, digests and commits are placeholders. No control sends a request, starts a run
// or loads a target: the page policy forbids connections and frames. Nothing advances on a timer.
// All text is set with textContent; there is no HTML injection and no inline style.
;(function preview() {
  // ----------------------------------------------------------------------------------------
  // Synthetic data
  // ----------------------------------------------------------------------------------------

  const DEFAULT_REQUEST = 'Find the incorrect Canvas filtering behavior and verify the fix.'
  const MAX_REQUEST_LENGTH = 500
  const PANEL_WIDTHS = [20, 22, 24, 26, 28, 30, 32]
  const DEFAULT_STEP = 2
  const VIEWS = ['ready', 'active', 'finalizing', 'disconnected', 'unsuccessful', 'successful']
  const VIEW_NAMES = {
    ready: 'Ready',
    active: 'Active',
    finalizing: 'Finalizing',
    disconnected: 'Activity disconnected',
    unsuccessful: 'Unsuccessful result',
    successful: 'Successful result',
  }
  const MODE_NAMES = { legacy: 'Legacy prepared case', captured: 'Captured candidate' }

  const SCENES = {
    defect: {
      labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'],
      values: [120, 135, 128, 150, 95, 102, 110, 99],
    },
    fixed: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [120, 135, 128, 150] },
    plausibleWrong: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [120, 135, 128, 105] },
  }

  const EVIDENCE_TYPES = ['actions', 'dataset', 'chart', 'screenshot', 'console', 'network', 'source']
  const evidenceIds = (phase) => EVIDENCE_TYPES.map((type, index) => `ev_${phase}_${type}_${String(index + 1).padStart(3, '0')}`)
  const FAILURE_IDS = evidenceIds('failure')
  const REPLAY_IDS = evidenceIds('replay')

  const LEGACY_CASES = {
    hero: { label: 'Canvas filter — Hero' },
    citation: { label: 'Canvas filter — Failure: invalid citation' },
  }

  const GATES = [
    ['failure_reproduced', 'Failure reproduced'],
    ['evidence_complete', 'Evidence complete'],
    ['citations_valid', 'Citations valid'],
    ['patch_scope_valid', 'Patch scope valid'],
    ['patch_applied', 'Patch applied'],
    ['dataset_matches', 'Dataset matches'],
    ['canvas_matches', 'Canvas matches'],
    ['secret_scan_clean', 'Secret scan clean'],
    ['original_worktree_unchanged', 'Original worktree unchanged'],
  ]
  const GATE_LABELS = Object.fromEntries(GATES)

  const CHECKS = [
    ['input_valid', 'Input valid', 'INPUT_ADMITTED', 'The completed captured candidate, its editing-session identity, and complete upstream cleanup were admitted.'],
    ['baseline_reproduced', 'Baseline defect reproduced', 'BASELINE_REPRODUCED', 'The baseline observation shows the prepared defect, and the failure evidence is complete.'],
    ['application_complete', 'Candidate applied completely', 'APPLICATION_COMPLETE', 'The candidate applied once at its recorded baseline, and every versioned effect matched its captured summary.'],
    ['build_passed', 'Registered build passed', 'BUILD_PASSED', 'The registered application build completed and produced servable output.'],
    ['tests_passed', 'Trusted functional check passed', 'TESTS_PASSED', 'The trusted prepared functional check executed every case and matched every expected outcome.'],
    ['dataset_matches', 'Replay dataset matches', 'DATASET_MATCHED', 'The observed filtered rows exactly match the committed dataset oracle.'],
    ['canvas_matches', 'Replay canvas matches', 'CANVAS_MATCHED', 'The rendered bar count, labels, and values exactly match the committed chart oracle.'],
    ['secret_scan_clean', 'Secret scan clean', 'SECRET_SCAN_CLEAN', 'The whole-run secret scan found no seeded marker or credential.'],
    ['cleanup_complete', 'Cleanup complete', 'CLEANUP_COMPLETE', 'Every owned target, operation, worktree, and private Git state was released.'],
    ['original_unchanged', 'Original repository unchanged', 'ORIGINAL_UNCHANGED', 'After cleanup the original repository equals its pre-run snapshot.'],
  ]
  const CHECK_FAILURES = {
    dataset_matches: ['DATASET_MISMATCH', 'The observed filtered rows differ from the committed dataset oracle.'],
    canvas_matches: ['CANVAS_VALUE_MISMATCH', 'A rendered bar value differs from the committed chart oracle.'],
  }

  const OUTCOME_LABELS = { pass: 'Pass', fail: 'Fail', unevaluable: 'Unevaluable', pending: 'Pending' }
  const OUTCOME_ICONS = { pass: 'check', fail: 'x', unevaluable: 'minus', pending: 'clock' }
  const NO_MODEL_STATEMENT = 'No model diagnosis or citations were evaluated in this verification.'

  // Fixed producer copy: legacy phase messages and captured activity markers.
  const LEGACY_PHASE = {
    reproducing: 'Reproducing the known-bad scenario in the target app.',
    failure_captured: 'Captured the failure evidence.',
    diagnosing: 'Requesting one evidence-cited diagnosis and checking its candidate.',
    candidate_validated: 'The candidate passed the citation and patch-scope guards.',
    applying: 'Applying the candidate in the isolated worktree and rebuilding the app.',
    replaying: 'Replaying the same scenario against the patched app.',
  }
  const CAPTURED_ACTIVITY = {
    admitted: 'Admitted the captured candidate; verification starts at its recorded baseline.',
    loadBaseline: 'Building the recorded baseline and loading it into the Studio frame (not live yet).',
    apply: 'Applying the captured candidate once at its recorded baseline.',
    build: 'Running the registered application build for the applied candidate.',
    test: 'Running the trusted prepared functional check against the candidate module.',
    loadCandidate: 'Loading the candidate build into the same Studio frame (not live yet).',
    scan: 'Scanning the candidate, the evidence, and the run activity for secrets.',
    cleanup: 'Releasing the target, operations, and owned worktree, then comparing the original repository.',
  }
  const CAPTURED_PHASE = {
    reproducing: 'The recorded baseline is live in the Studio frame; reproducing the prepared defect.',
    failure_captured: 'Captured the baseline failure evidence.',
    applying: 'Preparing the candidate: application, build, and functional check (not live).',
    replaying: 'The candidate build is live in the same Studio frame; replaying the prepared scenario.',
  }
  const CAPTURED_FINALIZING_MARKERS = [CAPTURED_ACTIVITY.scan, CAPTURED_ACTIVITY.cleanup]

  let sequence = 0
  const event = (type, phase, message, extra = {}) => {
    sequence += 1
    return { seq: sequence, type, phase, message, evidenceIds: extra.evidenceIds ?? [], gate: extra.gate ?? null }
  }
  const gateEvent = (phase, gateId, status, code) =>
    event('gate_updated', phase, `${GATE_LABELS[gateId]}: ${OUTCOME_LABELS[status]}`, { gate: { id: gateId, status, code } })
  const evidenceEvent = (phase, bundle, ids) => event('evidence_added', phase, `Captured ${ids.length} sanitized ${bundle} evidence items.`, { evidenceIds: ids })

  sequence = 0
  const LEGACY_HERO_EVENTS = [
    event('chat_received', 'initialized', 'Received the request for the prepared case.'),
    event('phase_started', 'reproducing', LEGACY_PHASE.reproducing),
    evidenceEvent('reproducing', 'failure', FAILURE_IDS),
    event('phase_started', 'failure_captured', LEGACY_PHASE.failure_captured),
    gateEvent('failure_captured', 'failure_reproduced', 'pass', 'GATE_PASSED'),
    gateEvent('failure_captured', 'evidence_complete', 'pass', 'GATE_PASSED'),
    event('phase_started', 'diagnosing', LEGACY_PHASE.diagnosing),
    event('diagnosis_ready', 'diagnosing', 'Received a strict-schema diagnosis.'),
    gateEvent('diagnosing', 'citations_valid', 'pass', 'GATE_PASSED'),
    event('candidate_ready', 'diagnosing', 'The validated candidate diff is ready for isolated application.'),
    event('phase_started', 'candidate_validated', LEGACY_PHASE.candidate_validated),
    gateEvent('candidate_validated', 'patch_scope_valid', 'pass', 'GATE_PASSED'),
    event('phase_started', 'applying', LEGACY_PHASE.applying),
    gateEvent('applying', 'patch_applied', 'pass', 'GATE_PASSED'),
    event('phase_started', 'replaying', LEGACY_PHASE.replaying),
    evidenceEvent('replaying', 'replay', REPLAY_IDS),
    gateEvent('replaying', 'dataset_matches', 'pass', 'GATE_PASSED'),
    gateEvent('replaying', 'canvas_matches', 'pass', 'GATE_PASSED'),
    gateEvent('replaying', 'secret_scan_clean', 'pass', 'GATE_PASSED'),
    gateEvent('replaying', 'original_worktree_unchanged', 'pass', 'GATE_PASSED'),
    event('run_finalized', 'finalized', 'Run finalized as Verified Fix.'),
  ]

  sequence = 0
  const LEGACY_CITATION_EVENTS = [
    event('chat_received', 'initialized', 'Received the request for the prepared case.'),
    event('phase_started', 'reproducing', LEGACY_PHASE.reproducing),
    evidenceEvent('reproducing', 'failure', FAILURE_IDS),
    event('phase_started', 'failure_captured', LEGACY_PHASE.failure_captured),
    gateEvent('failure_captured', 'failure_reproduced', 'pass', 'GATE_PASSED'),
    gateEvent('failure_captured', 'evidence_complete', 'pass', 'GATE_PASSED'),
    event('phase_started', 'diagnosing', 'Reading the labeled injected evaluation fixture in place of a model diagnosis and checking its candidate.'),
    event('diagnosis_ready', 'diagnosing', 'Received a strict-schema diagnosis from the injected evaluation fixture.'),
    gateEvent('diagnosing', 'citations_valid', 'fail', 'CITATION_UNKNOWN_EVIDENCE_ID'),
    gateEvent('diagnosing', 'patch_scope_valid', 'pass', 'GATE_PASSED'),
    event('agent_message', 'diagnosing', 'The candidate was rejected before patch application, so nothing was applied or replayed.'),
    gateEvent('diagnosing', 'secret_scan_clean', 'pass', 'GATE_PASSED'),
    gateEvent('diagnosing', 'original_worktree_unchanged', 'pass', 'GATE_PASSED'),
    event('run_finalized', 'finalized', 'Run finalized as Unverified.'),
  ]

  const capturedEvents = (finalStatus) => {
    sequence = 0
    return [
      event('agent_message', 'initialized', CAPTURED_ACTIVITY.admitted),
      event('agent_message', 'initialized', CAPTURED_ACTIVITY.loadBaseline),
      event('phase_started', 'reproducing', CAPTURED_PHASE.reproducing),
      evidenceEvent('reproducing', 'failure', FAILURE_IDS),
      event('phase_started', 'failure_captured', CAPTURED_PHASE.failure_captured),
      event('phase_started', 'applying', CAPTURED_PHASE.applying),
      event('agent_message', 'applying', CAPTURED_ACTIVITY.apply),
      event('agent_message', 'applying', CAPTURED_ACTIVITY.build),
      event('agent_message', 'applying', CAPTURED_ACTIVITY.test),
      event('agent_message', 'applying', CAPTURED_ACTIVITY.loadCandidate),
      event('phase_started', 'replaying', CAPTURED_PHASE.replaying),
      evidenceEvent('replaying', 'replay', REPLAY_IDS),
      event('agent_message', 'replaying', CAPTURED_ACTIVITY.scan),
      event('agent_message', 'replaying', CAPTURED_ACTIVITY.cleanup),
      event('run_finalized', 'finalized', `Run finalized as ${finalStatus}.`),
    ]
  }
  const CAPTURED_PASS_EVENTS = capturedEvents('passed')
  const CAPTURED_FAIL_EVENTS = capturedEvents('failed')

  const LEGACY_VERIFIED = {
    family: 'legacy',
    tone: 'success',
    verdict: 'Verified Fix',
    explanation: 'All nine gates passed in the final result.',
    gates: GATES.map(([id]) => ({ id, status: 'pass', code: 'GATE_PASSED' })),
    diff: true,
    evidence: { before: 'available', after: 'available', afterScene: 'fixed' },
  }
  const LEGACY_UNVERIFIED_FAILED = ['citations_valid', 'patch_applied', 'dataset_matches', 'canvas_matches']
  const LEGACY_UNVERIFIED = {
    family: 'legacy',
    tone: 'danger',
    verdict: 'Unverified',
    explanation: 'One gate failed and three gates were not evaluated, so the result is Unverified.',
    gates: GATES.map(([id]) => {
      if (id === 'citations_valid') return { id, status: 'fail', code: 'CITATION_UNKNOWN_EVIDENCE_ID' }
      if (LEGACY_UNVERIFIED_FAILED.includes(id)) return { id, status: 'unevaluable', code: 'GATE_NOT_EVALUATED' }
      return { id, status: 'pass', code: 'GATE_PASSED' }
    }),
    diff: false,
    evidence: { before: 'available', after: 'not-produced', afterScene: null },
  }
  const capturedChecks = (failing) =>
    CHECKS.map(([id, label, code, message]) => {
      const failure = failing ? CHECK_FAILURES[id] : undefined
      return failure === undefined ? { id, label, status: 'pass', code, message } : { id, label, status: 'fail', code: failure[0], message: failure[1] }
    })
  const CAPTURED_PASSED = {
    family: 'captured',
    tone: 'success',
    verdict: 'Candidate verification passed',
    explanation: 'All ten checks passed in the final result.',
    reasonCode: null,
    checks: capturedChecks(false),
    evidence: { before: 'available', after: 'available', afterScene: 'fixed' },
  }
  const CAPTURED_FAILED = {
    family: 'captured',
    tone: 'danger',
    verdict: 'Candidate verification failed',
    explanation: 'A mandatory candidate check failed, so the candidate was not verified.',
    reasonCode: 'CANDIDATE_FAILED',
    checks: capturedChecks(true),
    evidence: { before: 'available', after: 'available', afterScene: 'plausibleWrong' },
  }
  const CAPTURED_IDENTITY = { digest: 'a41c9e07b2d5', baseline: '5d0b7e3f91a2' }

  /** One presented state: the run, its accepted events, stream availability and any bound result. */
  function snapshot(mode, view, legacyCase) {
    if (mode === 'legacy') {
      const citation = legacyCase === 'citation'
      const final = isFinal(view)
      const events = citation ? LEGACY_CITATION_EVENTS : LEGACY_HERO_EVENTS
      const cut = { ready: 0, active: 8, finalizing: citation ? 13 : 20, disconnected: citation ? 9 : 15 }[view]
      return {
        mode,
        view,
        runId: view === 'ready' ? null : `run-sim-legacy-${legacyCase}`,
        caseId: legacyCase,
        events: final ? events : events.slice(0, cut),
        stream: view === 'disconnected' ? 'disconnected' : final ? 'ended' : 'open',
        result: final ? (citation ? LEGACY_UNVERIFIED : LEGACY_VERIFIED) : null,
      }
    }
    if (view === 'unsuccessful') return { mode, view, runId: 'run-sim-captured-wrong', caseId: null, events: CAPTURED_FAIL_EVENTS, stream: 'ended', result: CAPTURED_FAILED }
    const cut = { ready: 0, active: 11, finalizing: 14, disconnected: 12, successful: 15 }[view]
    return {
      mode,
      view,
      runId: view === 'ready' ? null : 'run-sim-captured-pass',
      caseId: null,
      events: CAPTURED_PASS_EVENTS.slice(0, cut),
      stream: view === 'disconnected' ? 'disconnected' : view === 'successful' ? 'ended' : 'open',
      result: view === 'successful' ? CAPTURED_PASSED : null,
    }
  }

  const isRunning = (view) => view === 'active' || view === 'finalizing' || view === 'disconnected'
  const isFinal = (view) => view === 'unsuccessful' || view === 'successful'

  // ----------------------------------------------------------------------------------------
  // Work cards: contiguous groups of observed events. Grouping never invents a phase, a
  // completion or a check outcome; Finalizing is a label for exact observed markers only.
  // ----------------------------------------------------------------------------------------

  const LEGACY_STAGE = { initialized: 'request', reproducing: 'reproduce', failure_captured: 'reproduce', diagnosing: 'diagnose', candidate_validated: 'validate', applying: 'apply', replaying: 'replay', finalized: 'finalize' }
  const CAPTURED_STAGE = { initialized: 'prepare', reproducing: 'reproduce', failure_captured: 'reproduce', applying: 'candidate', replaying: 'replay', finalized: 'finalize' }
  const STAGE_TITLES = {
    legacy: { reproduce: 'Reproducing the failure', diagnose: 'Diagnosing', validate: 'Validating the candidate', apply: 'Applying the candidate', replay: 'Replaying the scenario', finalize: 'Finalizing' },
    captured: { prepare: 'Preparing the recorded baseline', reproduce: 'Reproducing the prepared defect', candidate: 'Preparing the candidate', replay: 'Replaying on the candidate build', finalize: 'Finalizing' },
  }
  const PHASE_LABELS = { initialized: 'Initialized', reproducing: 'Reproducing', failure_captured: 'Failure captured', diagnosing: 'Diagnosing', candidate_validated: 'Candidate validated', applying: 'Applying', replaying: 'Replaying', finalized: 'Finalized' }

  function stageOf(mode, item) {
    if (mode === 'captured') {
      if (item.type === 'agent_message' && CAPTURED_FINALIZING_MARKERS.includes(item.message)) return 'finalize'
      return CAPTURED_STAGE[item.phase] ?? 'other'
    }
    if (item.type === 'gate_updated' && item.gate?.id === 'original_worktree_unchanged') return 'finalize'
    return LEGACY_STAGE[item.phase] ?? 'other'
  }

  function buildCards(snap) {
    const groups = []
    let finalizing = false
    for (const item of snap.events) {
      let stage = stageOf(snap.mode, item)
      if (stage === 'finalize') finalizing = true
      else if (finalizing) stage = 'finalize'
      const last = groups[groups.length - 1]
      if (last !== undefined && last.stage === stage) last.events.push(item)
      else groups.push({ stage, events: [item] })
    }
    const visible = groups.filter((group) => group.stage !== 'request')
    return visible.map((group, index) => {
      const first = group.events[0]
      const lastEvent = group.events[group.events.length - 1]
      const isLast = index === visible.length - 1
      const phaseMessage = group.events.find((item) => item.type === 'phase_started')?.message ?? first.message
      const facts = []
      const evidence = group.events.filter((item) => item.type === 'evidence_added')
      for (const item of evidence) facts.push(`${item.evidenceIds.length} ${item.phase === 'reproducing' ? 'failure' : 'replay'} evidence items recorded`)
      const gates = group.events.filter((item) => item.type === 'gate_updated')
      if (gates.length > 0) facts.push(`Gate updates: ${gates.map((item) => `${GATE_LABELS[item.gate.id]} ${OUTCOME_LABELS[item.gate.status].toLowerCase()}`).join(', ')}`)
      let note = null
      if (snap.mode === 'captured' && group.stage === 'candidate') note = 'Application, build, and functional-check outcomes are reported only in the final result.'
      if (snap.mode === 'captured' && group.stage === 'finalize') note = 'Shown as Finalizing from the observed secret-scan and cleanup activity; the events keep their raw phase. Checks are reported only in the final result.'
      if (snap.mode === 'legacy' && gates.length > 0) note = 'Gate updates are provisional; only the final result decides each gate.'
      let status
      if (isLast && (snap.view === 'active' || snap.view === 'finalizing')) status = group.stage === 'finalize' ? 'current-pending' : 'current'
      else if (isLast && snap.view === 'disconnected') status = 'last-observed'
      else status = 'observed'
      return {
        id: `${snap.runId}:${first.seq}`,
        stage: group.stage,
        title: STAGE_TITLES[snap.mode][group.stage] ?? 'Activity',
        summary: group.stage === 'finalize' && snap.mode === 'legacy' ? 'The original-worktree check was observed; the run is finishing.' : phaseMessage,
        facts,
        note,
        status,
        events: group.events,
        range: first.seq === lastEvent.seq ? `#${first.seq}` : `#${first.seq}–#${lastEvent.seq}`,
      }
    })
  }

  // ----------------------------------------------------------------------------------------
  // Presentation models
  // ----------------------------------------------------------------------------------------

  function statusModel(snap) {
    const legacy = snap.mode === 'legacy'
    const lastPhase = PHASE_LABELS[[...snap.events].reverse().find((item) => item.type === 'phase_started')?.phase] ?? null
    switch (snap.view) {
      case 'ready':
        return {
          tone: 'neutral',
          icon: 'ring',
          label: 'Ready',
          detail: legacy ? 'The prepared case is loaded. Nothing runs until you start.' : 'The fixed captured candidate is loaded. Nothing runs until you start.',
          next: legacy ? 'Review the request, then select Start run.' : 'Select Start candidate verification.',
        }
      case 'active':
        return {
          tone: 'working',
          icon: 'progress',
          label: `Working · ${lastPhase}`,
          detail: legacy
            ? `Observed phase: ${lastPhase}. Gate updates stay provisional until the run result arrives.`
            : 'The candidate build is live in the same Studio frame. Input to the frame is guarded during measurement.',
          next: legacy ? 'Wait for the result. Closing the Studio interrupts the run.' : 'Wait for the result. Closing the Studio interrupts the verification.',
        }
      case 'finalizing':
        return {
          tone: 'working',
          icon: 'progress',
          label: 'Finalizing · verdict pending',
          detail: legacy ? 'The original-worktree check was observed. The final result has not arrived yet.' : 'Secret scanning and cleanup activity were observed. Checks are reported only in the final result.',
          next: 'Wait for the authoritative result.',
        }
      case 'disconnected':
        return {
          tone: 'neutral',
          icon: 'clock',
          label: 'Result pending',
          warning: `Live activity disconnected. The last observed phase was ${lastPhase}.`,
          detail: legacy
            ? 'Activity stopped updating. That is not a run failure, and no result has arrived yet.'
            : 'Activity stopped updating. That is not a verification failure, and no result has arrived yet.',
          next: 'Wait for the result here. If none arrives, close the Studio and launch it again.',
        }
      default: {
        const { result } = snap
        return {
          tone: result.tone,
          icon: result.tone === 'success' ? 'check' : 'x',
          label: result.verdict,
          detail: result.explanation,
          next: legacy
            ? snap.view === 'successful'
              ? 'Review the evidence. Close the Studio when you are done.'
              : 'Review the failed gates and evidence. Launch a new Studio to run again.'
            : snap.view === 'successful'
              ? 'Review the stored evidence. Close the Studio to finish.'
              : 'Review the failed checks and stored evidence. Close the Studio to finish.',
          final: true,
        }
      }
    }
  }

  function surfaceModel(snap, tab) {
    if (snap.mode === 'legacy') {
      if (isFinal(snap.view) && tab === 'evidence') return { tone: 'stored', icon: 'image', text: 'Stored evidence · not live' }
      return { tone: 'neutral', icon: 'monitor', text: 'Prepared preview · not under verification' }
    }
    switch (snap.view) {
      case 'ready':
        return { tone: 'neutral', icon: 'monitor', text: 'Prepared preview · not under verification' }
      case 'active':
        return { tone: 'live', icon: 'dot', text: 'Live · candidate build' }
      case 'finalizing':
        return { tone: 'neutral', icon: 'minus', text: 'Not live · finalizing' }
      case 'disconnected':
        return { tone: 'warning', icon: 'alert', text: 'Not live · activity disconnected' }
      default:
        return { tone: 'stored', icon: 'image', text: 'Stored evidence · target released' }
    }
  }

  const EVIDENCE_TITLES = {
    legacy: { before: 'Before: failure reproduction', after: 'After: replay on the candidate' },
    captured: { before: 'Before: recorded baseline', after: 'After: candidate build' },
  }
  const EVIDENCE_STATE = {
    available: { tone: 'neutral', icon: 'image', label: 'Available' },
    loading: { tone: 'neutral', icon: 'clock', label: 'Loading' },
    'not-produced': { tone: 'neutral', icon: 'minus', label: 'Phase not produced' },
    'not-received': { tone: 'warning', icon: 'alert', label: 'Evidence ID not received' },
    unreadable: { tone: 'warning', icon: 'alert', label: 'Unreadable' },
  }

  function evidenceModel(snap, example) {
    const base = snap.result.evidence
    const sides = {
      before: { side: 'before', phase: 'failure', state: base.before, id: 'ev_failure_screenshot_004', scene: 'defect' },
      after: { side: 'after', phase: 'replay', state: base.after, id: 'ev_replay_screenshot_004', scene: base.afterScene },
    }
    const [sideName, state] = example === 'as-produced' ? [null, null] : example.split(/-(.+)/)
    if (sideName !== null && sides[sideName] !== undefined && (sides[sideName].state === 'available' || state === 'not-produced')) sides[sideName].state = state
    return sides
  }

  function evidenceMessage(mode, side) {
    switch (side.state) {
      case 'not-produced':
        return side.side === 'before'
          ? 'No baseline evidence was produced in this run, so there is no before screenshot.'
          : mode === 'legacy'
            ? 'No replay evidence was produced in this run, so there is no after screenshot.'
            : 'No candidate replay evidence was produced in this run, so there is no after screenshot.'
      case 'not-received':
        return 'The screenshot was recorded, but its Evidence ID was not received in this session, so it is not shown.'
      case 'loading':
        return 'Loading the stored screenshot through the closed evidence route.'
      case 'unreadable':
        return 'The stored screenshot could not be read through the closed evidence route.'
      default:
        return ''
    }
  }

  // ----------------------------------------------------------------------------------------
  // DOM helpers
  // ----------------------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const ICONS = {
    check: ['M3.5 8.5 6.5 11.5 12.5 4.5'],
    x: ['M4.75 4.75 11.25 11.25', 'M11.25 4.75 4.75 11.25'],
    alert: ['M8 2.5 14 13.25H2z', 'M8 6.5v3', 'M8 11.3v.2'],
    ring: ['M8 3.25a4.75 4.75 0 1 1 0 9.5a4.75 4.75 0 1 1 0-9.5z'],
    progress: ['M8 3.25a4.75 4.75 0 1 1 0 9.5a4.75 4.75 0 1 1 0-9.5z', 'M8 5.75a2.25 2.25 0 0 1 0 4.5z'],
    clock: ['M8 3.25a4.75 4.75 0 1 1 0 9.5a4.75 4.75 0 1 1 0-9.5z', 'M8 5.5V8l1.75 1.25'],
    minus: ['M4.5 8h7'],
    chevron: ['M4.5 6.25 8 9.75l3.5-3.5'],
    image: ['M2.25 3.25h11.5v9.5H2.25z', 'M2.25 10.75 5.5 7.75l2.75 2.5 2-1.75 3.5 3', 'M10.5 5.75v.1'],
    monitor: ['M2 3.25h12v8H2z', 'M6 13.75h4', 'M8 11.25v2.5'],
    lock: ['M4.25 7.25h7.5v6h-7.5z', 'M5.75 7.25V5.5a2.25 2.25 0 0 1 4.5 0v1.75'],
    shield: ['M8 2 13 4v3.75c0 3-2.2 5.1-5 6.25-2.8-1.15-5-3.25-5-6.25V4z'],
    dot: ['M8 5a3 3 0 1 1 0 6a3 3 0 1 1 0-6z'],
    sparkle: ['M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3'],
  }
  const FILLED_ICONS = new Set(['dot'])

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', FILLED_ICONS.has(name) ? 'icon icon--filled' : 'icon')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    for (const d of ICONS[name] ?? []) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    return svg
  }

  /** Creates an element. Children are nodes or text; text is never parsed as HTML. */
  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue
      if (name === 'class') node.className = value
      else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value)
      else node.setAttribute(name, value === true ? '' : String(value))
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  /** Replaces a node's children, skipping absent ones (replaceChildren would print "null"). */
  function fill(node, ...children) {
    node.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false))
  }

  let idCounter = 0
  const uid = (prefix) => `${prefix}-${(idCounter += 1)}`

  /** An identifier as code text, with line-break opportunities after underscores and dots. */
  function codeText(value) {
    const code = el('code', {})
    value.split(/(?<=[_.])/).forEach((part, index) => {
      if (index > 0) code.append(document.createElement('wbr'))
      code.append(document.createTextNode(part))
    })
    return code
  }

  function statusPill(tone, iconName, text, extraClass = '') {
    return el('span', { class: `status-pill ${extraClass}`.trim(), 'data-tone': tone }, icon(iconName), el('span', {}, text))
  }

  function outcome(status) {
    return el('span', { class: 'outcome', 'data-outcome': status }, icon(OUTCOME_ICONS[status]), OUTCOME_LABELS[status])
  }

  function chart(sceneKey) {
    const data = SCENES[sceneKey]
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'chart')
    svg.setAttribute('viewBox', '0 0 640 360')
    svg.setAttribute('width', '640')
    svg.setAttribute('height', '360')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const add = (tag, attributes, text) => {
      const node = document.createElementNS(SVG_NS, tag)
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
      if (text !== undefined) node.textContent = text
      svg.append(node)
      return node
    }
    const left = 44
    const right = 16
    const top = 34
    const bottom = 30
    const width = 640 - left - right
    const height = 360 - top - bottom
    const max = 160
    for (let tick = 0; tick <= max; tick += 20) {
      const y = top + height - (tick / max) * height
      add('line', { class: tick === 0 ? 'chart__axis' : 'chart__grid', x1: left, x2: left + width, y1: y, y2: y })
      add('text', { class: 'chart__tick', x: left - 8, y: y + 4, 'text-anchor': 'end' }, String(tick))
    }
    add('line', { class: 'chart__axis', x1: left, x2: left, y1: top, y2: top + height })
    const band = width / data.values.length
    const barWidth = band * 0.72
    data.values.forEach((value, index) => {
      const barHeight = (value / max) * height
      const x = left + index * band + (band - barWidth) / 2
      add('rect', { class: 'chart__bar', x: x.toFixed(1), y: (top + height - barHeight).toFixed(1), width: barWidth.toFixed(1), height: barHeight.toFixed(1) })
      add('text', { class: 'chart__tick', x: (left + index * band + band / 2).toFixed(1), y: top + height + 18, 'text-anchor': 'middle' }, data.labels[index])
    })
    add('rect', { class: 'chart__legend-swatch', x: 284, y: 10, width: 36, height: 12 })
    add('text', { class: 'chart__tick', x: 326, y: 20 }, 'Revenue')
    return svg
  }

  const describeScene = (sceneKey) => {
    const { labels, values } = SCENES[sceneKey]
    return `${values.length} bars: ${labels.map((label, index) => `${label} ${values[index]}`).join(', ')}`
  }

  function scene(sceneKey) {
    return el(
      'div',
      { class: 'scene', role: 'img', 'aria-label': `Synthetic target scene. Quarterly revenue by region, region North. ${describeScene(sceneKey)}.` },
      el('p', { class: 'scene__heading' }, 'Quarterly revenue by region'),
      el('p', { class: 'scene__filter' }, 'North region'),
      chart(sceneKey),
    )
  }

  // ----------------------------------------------------------------------------------------
  // Presentation state (local only; never persisted, never sent)
  // ----------------------------------------------------------------------------------------

  const ui = {
    mode: 'legacy',
    view: 'ready',
    legacyCase: 'hero',
    draft: DEFAULT_REQUEST,
    panelStep: DEFAULT_STEP,
    collapsed: false,
    canvas: { runId: null, tab: 'target' },
    evidenceExample: 'as-produced',
    expanded: new Set(),
    simulated: 0,
    unseen: 0,
    following: true,
    savedScroll: 0,
    followingAtCollapse: true,
    latestOnRestore: false,
    panelFocusKey: null,
  }

  const $ = (selector) => document.querySelector(selector)
  const dom = {
    workspace: $('#workspace'),
    panel: $('#work-panel'),
    context: $('#session-context'),
    status: $('#run-status'),
    history: $('#history'),
    jump: $('#jump-latest'),
    jumpLabel: $('#jump-latest-label'),
    composer: $('#composer'),
    separator: $('#panel-separator'),
    collapse: $('#collapse-panel'),
    collapsedEntry: $('#collapsed-entry'),
    restore: $('#restore-panel'),
    collapsedStatus: $('#collapsed-status'),
    viewResult: $('#view-result'),
    surface: $('#surface-label'),
    tabs: $('#canvas-tabs'),
    tabTarget: $('#tab-target'),
    tabEvidence: $('#tab-evidence'),
    viewTarget: $('#view-target'),
    frame: $('#target-frame'),
    viewEvidence: $('#view-evidence'),
    note: $('#preview-note'),
    evidenceExample: $('#evidence-example'),
    append: $('#append-activity'),
    appendHint: $('#append-hint'),
    skipToPanel: $('.skip-link[href="#work-panel"]'),
  }

  let current = snapshot(ui.mode, ui.view, ui.legacyCase)

  const note = (text) => {
    dom.note.textContent = text
  }

  const focusKeyOf = (node) => (node instanceof Element ? (node.closest('[data-focus-key]')?.getAttribute('data-focus-key') ?? null) : null)

  function focusByKey(key, options = {}) {
    if (key === null) return false
    const target = [...document.querySelectorAll('[data-focus-key]')].find((node) => node.getAttribute('data-focus-key') === key)
    if (target === undefined || target.closest('[inert]') !== null || target.disabled || target.getClientRects().length === 0) return false
    target.focus(options)
    return true
  }

  // ----------------------------------------------------------------------------------------
  // Rendering: work panel
  // ----------------------------------------------------------------------------------------

  function renderContext() {
    const snap = current
    if (snap.mode === 'legacy') {
      const caseId = snap.caseId
      const locked = snap.view !== 'ready'
      const select = el(
        'select',
        { id: 'case-picker', class: 'select', disabled: locked, 'aria-describedby': locked ? 'case-locked' : undefined, 'data-focus-key': 'case-picker', onchange: (changeEvent) => {
          ui.legacyCase = changeEvent.target.value
          setState('legacy', 'ready', `Selected ${LEGACY_CASES[ui.legacyCase].label} (simulated).`)
        } },
        Object.entries(LEGACY_CASES).map(([value, { label }]) => el('option', { value, selected: value === caseId }, label)),
      )
      fill(
        dom.context,
        el(
          'div',
          { class: 'session-context__field' },
          el(
            'div',
            { class: 'session-context__label-row' },
            el('label', { class: 'eyebrow', for: 'case-picker' }, 'Prepared case'),
            locked ? el('span', { id: 'case-locked', class: 'session-context__lock' }, icon('lock'), 'Locked to this run') : null,
          ),
          select,
        ),
        el('dl', { class: 'facts' }, el('dt', {}, 'Scope'), el('dd', {}, el('code', {}, 'apps/demo-chart/src/filterData.ts'))),
      )
      return
    }
    fill(
      dom.context,
      el('p', { class: 'eyebrow' }, 'Captured candidate'),
      el('h3', { class: 'session-context__title' }, 'Canvas filter — captured candidate'),
      el('dl', { class: 'facts' }, el('dt', {}, 'Source'), el('dd', {}, 'Fixed by the host for this launch')),
    )
  }

  function renderStatus() {
    const model = statusModel(current)
    fill(dom.status, model.label)
    fill(dom.collapsedStatus, icon(model.icon), el('span', {}, model.label))
    dom.collapsedStatus.setAttribute('data-tone', model.tone)
    dom.viewResult.hidden = !model.final
  }

  function eventDetails(card) {
    return el(
      'ol',
      { class: 'event-list', 'aria-label': `Observed events ${card.range}` },
      card.events.map((item) =>
        el(
          'li',
          {},
          el('span', { class: 'event-list__head' }, el('code', {}, `#${item.seq}`), el('code', {}, item.type), el('code', {}, item.phase)),
          el('span', { class: 'event-list__message' }, item.message, item.gate ? el('span', {}, ' ', codeText(item.gate.code)) : null),
          item.evidenceIds.length > 0 ? el('span', { class: 'event-list__ids' }, item.evidenceIds.map((id) => codeText(id))) : null,
        ),
      ),
    )
  }

  function workCard(card, { simulated = false } = {}) {
    return el('section', { class: 'work-row', 'data-card-id': card.id },
      el('h4', {}, card.title, simulated ? ' · Simulated' : ''),
      el('p', {}, card.summary),
      disclosure(card.id, 'Events', null, () => eventDetails(card)))
  }

  function disclosure(key, title, count, buildContent) {
    const panelId = uid('disclosure')
    const expanded = ui.expanded.has(key)
    const panel = el('div', { id: panelId, class: 'disclosure__panel', hidden: !expanded }, buildContent())
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'disclosure__toggle',
        'aria-expanded': String(expanded),
        'aria-controls': panelId,
        'data-focus-key': `disclosure:${key}`,
        onclick: () => {
          const open = !ui.expanded.has(key)
          if (open) ui.expanded.add(key)
          else ui.expanded.delete(key)
          toggle.setAttribute('aria-expanded', String(open))
          panel.hidden = !open
        },
      },
      el('span', {}, title),
      count ? el('span', { class: 'disclosure__count' }, count) : null,
      el('span', { class: 'chevron' }, icon('chevron')),
    )
    return el('div', { class: 'disclosure' }, el('h4', { class: 'card__heading' }, toggle), panel)
  }

  function checkRow(item) {
    return el(
      'li',
      { 'data-outcome': item.status },
      outcome(item.status),
      el('span', { class: 'check-list__label' }, item.label),
      el('span', { class: 'check-list__reason' }, item.message ? `${item.message} ` : '', codeText(item.code)),
    )
  }

  function technicalDetails(snap) {
    const nodes = [el('p', { class: 'detail-note' }, 'Scope: apps/demo-chart/src/filterData.ts')]
    for (const card of buildCards(snap)) nodes.push(workCard(card))
    if (snap.result !== null) {
      const result = snap.result
      if (result.reasonCode) nodes.push(el('p', { class: 'detail-note' }, 'Reason: ', codeText(result.reasonCode)))
      const rows = result.family === 'legacy'
        ? result.gates.map((gate) => ({ label: GATE_LABELS[gate.id], ...gate }))
        : result.checks
      nodes.push(el('h4', {}, result.family === 'legacy' ? 'All gates' : 'All checks'),
        el('ul', { class: 'check-list', 'aria-label': result.family === 'legacy' ? 'All nine gates' : 'All ten checks' }, rows.map(checkRow)))
      if (result.family === 'legacy') {
        nodes.push(el('h4', {}, 'Candidate diff and provenance'), result.diff
          ? el('pre', { class: 'diff' }, el('span', { class: 'diff__file' }, 'apps/demo-chart/src/filterData.ts'), el('span', { class: 'diff__del' }, '- row.region.includes(region)'), el('span', { class: 'diff__add' }, '+ row.region === region'))
          : el('p', {}, 'No candidate passed validation.'))
        nodes.push(el('p', {}, 'The real result supplies model or fixture provenance; this preview does not simulate it.'))
      } else {
        nodes.push(el('h4', {}, 'Candidate identity and cleanup'), el('dl', { class: 'facts' },
          el('dt', {}, 'Candidate digest'), el('dd', {}, CAPTURED_IDENTITY.digest),
          el('dt', {}, 'Baseline'), el('dd', {}, CAPTURED_IDENTITY.baseline),
          el('dt', {}, 'Cleanup'), el('dd', {}, 'Complete; no owned resources remain; original unchanged.')),
          el('p', {}, NO_MODEL_STATEMENT), el('p', {}, 'Identifiers are synthetic placeholders.'))
      }
    }
    return nodes
  }

  function renderHistory() {
    const snap = current
    ui.simulated = 0
    ui.unseen = 0
    const nodes = []
    if (snap.view === 'ready') {
      nodes.push(el('div', { class: 'empty-state' },
        el('p', { class: 'empty-state__title' }, snap.mode === 'legacy' ? 'Ready to investigate.' : 'Candidate ready.'),
        el('p', {}, snap.mode === 'legacy' ? 'Canvas filter · prepared case' : 'Canvas filter · host-fixed candidate')))
    } else {
      if (snap.mode === 'legacy') nodes.push(el('div', { class: 'request-bubble' },
        el('p', { class: 'request-bubble__text' }, requestValid(ui.draft) ? ui.draft : DEFAULT_REQUEST)))
      const model = statusModel(snap)
      if (snap.result !== null) {
        const result = snap.result
        const rows = result.family === 'legacy' ? result.gates.map((gate) => ({ label: GATE_LABELS[gate.id], ...gate })) : result.checks
        nodes.push(el('section', { id: 'result-summary', class: 'result', 'data-tone': result.tone },
          el('h3', { class: 'result__heading', tabindex: '-1' }, icon(model.icon), result.verdict),
          el('p', { class: 'result__explanation' }, result.explanation),
          rows.some((row) => row.status !== 'pass') ? el('p', { class: 'failed-checks' }, rows.filter((row) => row.status !== 'pass').map((row) => `${row.label}: ${OUTCOME_LABELS[row.status]}`).join(' · ')) : null,
          el('button', { type: 'button', class: 'btn btn--quiet', 'data-focus-key': 'compare', onclick: () => compareEvidence() }, 'Compare before and after', icon('chevron'))))
      } else {
        const cards = buildCards(snap)
        nodes.push(el('div', { class: 'work-summary' },
          el('h3', {}, icon(model.icon), model.label),
          el('p', {}, cards[cards.length - 1]?.summary ?? model.detail),
          snap.stream === 'disconnected' ? el('p', { class: 'connection-warning' }, 'Live activity disconnected. No final result received.') : null))
      }
      nodes.push(disclosure(`${snap.runId}:technical`, 'Details', null, () => technicalDetails(snap)))
    }
    fill(dom.history, nodes)
  }

  const requestValid = (text) => text.trim().length >= 1 && text.length <= MAX_REQUEST_LENGTH

  function renderComposer() {
    const snap = current
    if (snap.view !== 'ready') {
      const text = isRunning(snap.view) ? 'Wait for the result. Closing Studio interrupts this run.' : 'This run is complete. Close Studio when finished.'
      fill(dom.composer, el('p', { class: 'session-note' }, text))
      return
    }
    if (snap.mode === 'captured') {
      fill(dom.composer, el('button', { type: 'button', class: 'btn btn--primary candidate-start', 'data-focus-key': 'start', onclick: () => simulateStart() }, 'Start candidate verification'))
      return
    }
    const field = el('textarea', { id: 'request-field', class: 'composer__field', rows: '3', placeholder: 'Describe the issue…', 'aria-label': 'Request', 'data-focus-key': 'request' })
    field.value = ui.draft
    const problem = el('p', { id: 'request-problem', class: 'field-error', hidden: true })
    const start = el('button', { type: 'submit', class: 'btn btn--primary send-button', 'aria-label': 'Start run', 'data-focus-key': 'start' }, '↑')
    const form = el('form', { class: 'composer', novalidate: true, 'aria-label': 'Request', onsubmit: (e) => { e.preventDefault(); if (requestValid(ui.draft)) simulateStart() } }, field, problem,
      el('div', { class: 'composer__foot' }, el('span', { class: 'composer__context' }, 'Canvas filter'), start))
    const sync = () => {
      const valid = requestValid(ui.draft)
      problem.textContent = ui.draft.length > MAX_REQUEST_LENGTH ? 'The request is limited to 500 characters.' : 'Enter a request to start.'
      problem.hidden = valid
      field.setAttribute('aria-invalid', String(!valid))
      if (valid) field.removeAttribute('aria-describedby')
      else field.setAttribute('aria-describedby', 'request-problem')
      start.disabled = !valid
    }
    field.addEventListener('input', () => { ui.draft = field.value; sync() })
    sync()
    fill(dom.composer, form)
  }

  // ----------------------------------------------------------------------------------------
  // Rendering: canvas
  // ----------------------------------------------------------------------------------------

  function canvasTab() {
    if (current.mode !== 'legacy' || !isFinal(current.view)) return current.mode === 'captured' && isFinal(current.view) ? 'evidence' : 'target'
    if (ui.canvas.runId !== current.runId) ui.canvas = { runId: current.runId, tab: 'target' }
    return ui.canvas.tab
  }

  function renderFrame() {
    const snap = current
    const sceneKey = snap.mode === 'captured' && snap.view !== 'ready' ? 'fixed' : 'defect'
    const children = [scene(sceneKey)]
    if (snap.mode === 'captured' && snap.view === 'active') {
      children.push(el('div', { class: 'frame-guard', 'aria-hidden': 'true' }, el('span', { class: 'frame-guard__label' }, icon('shield'), 'Input guarded during measurement')))
    }
    if (snap.mode === 'captured' && (snap.view === 'finalizing' || snap.view === 'disconnected')) {
      children.push(el('div', { class: 'frame-veil', 'aria-hidden': 'true' }, el('span', { class: 'frame-veil__label' }, icon('minus'), 'Not live')))
    }
    // The frame wrapper element itself is kept for the whole page lifetime; only its synthetic
    // contents change, mirroring the rule that presentation never remounts the real target.
    fill(dom.frame, children)
  }

  function evidenceSide(snap, side) {
    const state = EVIDENCE_STATE[side.state]
    const title = EVIDENCE_TITLES[snap.mode][side.side]
    const media =
      side.state === 'available'
        ? el('div', { class: 'evidence-side__media', 'data-state': side.state, role: 'img', 'aria-label': `${title}. Stored screenshot (synthetic), not live. ${describeScene(side.scene)}.` }, chart(side.scene))
        : el(
            'div',
            { class: 'evidence-side__media', 'data-state': side.state },
            el('p', { class: 'evidence-side__message', role: side.state === 'loading' ? 'status' : undefined }, icon(state.icon), el('span', {}, evidenceMessage(snap.mode, side))),
          )
    return el(
      'figure',
      { class: 'evidence-side', 'data-side': side.side, 'data-evidence-state': side.state },
      el(
        'div',
        { class: 'evidence-side__head' },
        el('div', {},  el('h4', { class: 'evidence-side__title' }, title)),
        statusPill(state.tone, state.icon, state.label),
      ),
      media,
      el(
        'figcaption',
        { class: 'evidence-side__meta visually-hidden' },
        side.state === 'available' || side.state === 'loading' || side.state === 'unreadable'
          ? [el('span', {}, side.state === 'available' ? 'Stored screenshot, not live' : 'Evidence ID'), codeText(side.id)]
          : el('span', {}, 'No stored screenshot is shown'),
      ),
    )
  }

  function renderEvidence() {
    const snap = current
    if (!isFinal(snap.view)) {
      fill(dom.viewEvidence)
      return
    }
    const sides = evidenceModel(snap, ui.evidenceExample)
    fill(
      dom.viewEvidence,
      el(
        'div',
        { class: 'evidence-view__head' },
        el('h3', { id: 'evidence-title', class: 'evidence-view__title', tabindex: '-1' }, 'Before and after evidence'),
        el(
          'p',
          { class: 'evidence-view__intro' },
          snap.mode === 'legacy'
            ? 'Stored screenshots from this run. They are not live; the prepared preview stays available in the Target tab.'
            : 'The verification finalized and its target was released. These stored screenshots are not live.',
        ),
      ),
      el('div', { class: 'evidence-grid' }, evidenceSide(snap, sides.before), evidenceSide(snap, sides.after)),
    )
  }

  function renderCanvas() {
    const snap = current
    const tab = canvasTab()
    const tabbed = snap.mode === 'legacy' && isFinal(snap.view)
    const surface = surfaceModel(snap, tab)
    fill(dom.surface, icon(surface.icon), el('span', {}, surface.text))
    dom.surface.setAttribute('data-surface', surface.tone)
    dom.tabs.hidden = !tabbed
    for (const [button, name] of [
      [dom.tabTarget, 'target'],
      [dom.tabEvidence, 'evidence'],
    ]) {
      button.setAttribute('aria-selected', String(tab === name))
      button.tabIndex = tab === name ? 0 : -1
    }
    for (const [view, name, tabButton] of [
      [dom.viewTarget, 'target', 'tab-target'],
      [dom.viewEvidence, 'evidence', 'tab-evidence'],
    ]) {
      if (tabbed) {
        view.setAttribute('role', 'tabpanel')
        view.setAttribute('aria-labelledby', tabButton)
        view.tabIndex = 0
      } else {
        view.removeAttribute('role')
        view.removeAttribute('aria-labelledby')
        view.removeAttribute('tabindex')
      }
      const shown = name === tab
      view.hidden = !shown
      view.inert = !shown
    }
    renderFrame()
    renderEvidence()
  }

  // ----------------------------------------------------------------------------------------
  // Preview controls and whole-state rendering
  // ----------------------------------------------------------------------------------------

  function renderControls() {
    const final = isFinal(current.view)
    dom.evidenceExample.disabled = !final
    if (final) {
      const natural = current.result.evidence
      for (const option of dom.evidenceExample.options) {
        const [side, state] = option.value === 'as-produced' ? [null, null] : option.value.split(/-(.+)/)
        option.disabled = side !== null && state !== 'not-produced' && natural[side] !== 'available'
      }
      if (dom.evidenceExample.selectedOptions[0]?.disabled) ui.evidenceExample = 'as-produced'
    } else {
      ui.evidenceExample = 'as-produced'
    }
    dom.evidenceExample.value = ui.evidenceExample
    const live = current.view === 'active' || current.view === 'finalizing'
    dom.append.setAttribute('aria-disabled', String(!live))
    dom.appendHint.textContent = live
      ? 'Adds one labelled synthetic work card to check reading position.'
      : 'Unavailable: simulated activity applies to the Active and Finalizing states, while live activity is connected.'
    document.querySelector(`input[name="mode"][value="${ui.mode}"]`).checked = true
    document.querySelector(`input[name="view"][value="${ui.view}"]`).checked = true
  }

  function renderAll({ resetHistory = false } = {}) {
    const focusKey = focusKeyOf(document.activeElement)
    current = snapshot(ui.mode, ui.view, ui.legacyCase)
    renderControls()
    renderContext()
    renderStatus()
    if (resetHistory) renderHistory()
    renderComposer()
    renderCanvas()
    if (resetHistory) {
      if (ui.collapsed) ui.latestOnRestore = true
      else scrollHistoryToLatest()
    }
    // A re-rendered control keeps focus through its stable key; untouched controls keep it anyway.
    if (focusKey !== null && (document.activeElement === null || document.activeElement === document.body)) focusByKey(focusKey, { preventScroll: true })
  }

  function setState(mode, view, message) {
    ui.mode = mode
    // Returning from the other mode retains this case's outcome, not its final-state example.
    ui.view = mode === 'legacy' && isFinal(view) ? (ui.legacyCase === 'citation' ? 'unsuccessful' : 'successful') : view
    renderAll({ resetHistory: true })
    note(message ?? `Showing ${MODE_NAMES[mode]} · ${VIEW_NAMES[ui.view]} (simulated).`)
  }

  function simulateStart() {
    setState(ui.mode, 'active', 'Simulated start: switched to the Active state. No request was sent and no run started.')
    dom.history.focus()
  }

  // ----------------------------------------------------------------------------------------
  // Reading position and latest-work affordance
  // ----------------------------------------------------------------------------------------

  const atLatest = () => dom.history.scrollHeight - dom.history.scrollTop - dom.history.clientHeight <= 8

  function updateJump() {
    ui.following = atLatest()
    if (ui.following) ui.unseen = 0
    // Final states end with the result, reached through Go to result; no live work follows it.
    dom.jump.hidden = ui.following || isFinal(current.view)
    dom.jumpLabel.textContent = ui.unseen > 0 ? `${ui.unseen} new ${ui.unseen === 1 ? 'update' : 'updates'} · Jump to latest` : 'Jump to latest'
  }

  function scrollHistoryToLatest() {
    const result = dom.history.querySelector('#result-summary')
    if (result !== null && result.offsetHeight > dom.history.clientHeight) {
      dom.history.scrollTop = result.offsetTop - 4
    } else {
      dom.history.scrollTop = dom.history.scrollHeight
    }
    updateJump()
  }

  function appendSimulated() {
    if (dom.append.getAttribute('aria-disabled') === 'true') {
      note('Simulated activity is available in the Active and Finalizing states, while live activity is connected.')
      return
    }
    const wasFollowing = ui.collapsed ? ui.followingAtCollapse : atLatest()
    ui.simulated += 1
    const n = ui.simulated
    const lastEvent = current.events[current.events.length - 1]
    const card = {
      id: `sim:${current.runId}:${n}`,
      title: `Simulated activity ${n}`,
      summary: 'Added by the preview control to check reading position. Not a real event.',
      facts: [],
      note: null,
      status: 'simulated',
      events: [{ seq: lastEvent.seq + n, type: 'agent_message', phase: lastEvent.phase, message: 'Simulated event (preview only).', evidenceIds: [], gate: null }],
      range: `#${lastEvent.seq + n}`,
    }
    dom.history.append(workCard(card, { simulated: true }))
    if (wasFollowing && ui.collapsed) ui.latestOnRestore = true
    else if (wasFollowing) dom.history.scrollTop = dom.history.scrollHeight
    else ui.unseen += 1
    if (!ui.collapsed) updateJump()
    note(
      wasFollowing
        ? `Appended simulated activity ${n}. You were at the latest work, so the list followed it.`
        : `Appended simulated activity ${n}. Your reading position and focus were kept.`,
    )
  }

  function jumpToLatest() {
    dom.history.scrollTop = dom.history.scrollHeight
    updateJump()
    const toggles = dom.history.querySelectorAll('.disclosure__toggle, .result__heading')
    const last = toggles[toggles.length - 1]
    if (last !== undefined) last.focus({ preventScroll: true })
  }

  // ----------------------------------------------------------------------------------------
  // Panel width, collapse and restore
  // ----------------------------------------------------------------------------------------

  function setStep(step) {
    const next = Math.max(0, Math.min(PANEL_WIDTHS.length - 1, step))
    if (next === ui.panelStep) return
    ui.panelStep = next
    dom.workspace.setAttribute('data-panel-step', String(next))
    const width = PANEL_WIDTHS[next]
    dom.separator.setAttribute('aria-valuenow', String(width))
    dom.separator.setAttribute('aria-valuetext', `${width}rem${next === DEFAULT_STEP ? ' (default)' : ''}`)
  }

  function collapsePanel() {
    if (ui.collapsed) return
    const active = document.activeElement
    const focusWasInside = dom.panel.contains(active) || active === dom.separator
    ui.panelFocusKey = dom.panel.contains(active) ? focusKeyOf(active) : null
    ui.savedScroll = dom.history.scrollTop
    ui.followingAtCollapse = atLatest()
    ui.latestOnRestore = false
    ui.collapsed = true
    dom.workspace.setAttribute('data-collapsed', 'true')
    dom.panel.inert = true
    dom.skipToPanel.hidden = true
    dom.collapsedEntry.hidden = false
    if (focusWasInside) dom.restore.focus()
  }

  function restorePanel({ focus = 'retained' } = {}) {
    if (!ui.collapsed) return
    ui.collapsed = false
    dom.workspace.setAttribute('data-collapsed', 'false')
    dom.panel.inert = false
    dom.skipToPanel.hidden = false
    dom.collapsedEntry.hidden = true
    if (ui.latestOnRestore) scrollHistoryToLatest()
    else dom.history.scrollTop = ui.savedScroll
    ui.latestOnRestore = false
    updateJump()
    if (focus === 'result') focusResult()
    else if (!focusByKey(ui.panelFocusKey, { preventScroll: true })) dom.collapse.focus()
  }

  function focusResult() {
    const heading = dom.history.querySelector('.result__heading')
    if (heading === null) return
    heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
    updateJump()
  }

  function showResult() {
    if (ui.collapsed) restorePanel({ focus: 'result' })
    else focusResult()
  }

  function compareEvidence() {
    if (current.mode === 'legacy') {
      ui.canvas = { runId: current.runId, tab: 'evidence' }
      renderCanvas()
      dom.tabEvidence.focus()
      return
    }
    const title = document.getElementById('evidence-title')
    if (title !== null) {
      title.scrollIntoView({ block: 'nearest' })
      title.focus({ preventScroll: true })
    }
  }

  function selectTab(name, { focus = false } = {}) {
    ui.canvas = { runId: current.runId, tab: name }
    renderCanvas()
    if (focus) (name === 'target' ? dom.tabTarget : dom.tabEvidence).focus()
  }

  // ----------------------------------------------------------------------------------------
  // Event wiring
  // ----------------------------------------------------------------------------------------

  document.querySelectorAll('input[name="mode"]').forEach((input) =>
    input.addEventListener('change', () => {
      if (input.checked) setState(input.value, ui.view)
    }),
  )
  document.querySelectorAll('input[name="view"]').forEach((input) =>
    input.addEventListener('change', () => {
      if (!input.checked) return
      let message
      if (ui.mode === 'legacy' && isFinal(input.value)) {
        const caseId = input.value === 'successful' ? 'hero' : 'citation'
        if (ui.legacyCase !== caseId) message = `Showing the ${VIEW_NAMES[input.value].toLowerCase()} example: prepared case changed to ${LEGACY_CASES[caseId].label} (simulated).`
        ui.legacyCase = caseId
      }
      setState(ui.mode, input.value, message)
    }),
  )

  dom.evidenceExample.addEventListener('change', () => {
    ui.evidenceExample = dom.evidenceExample.value
    if (current.mode === 'legacy' && isFinal(current.view)) ui.canvas = { runId: current.runId, tab: 'evidence' }
    renderCanvas()
    note(`Evidence example: ${dom.evidenceExample.selectedOptions[0].textContent} (simulated).`)
  })

  dom.append.addEventListener('click', appendSimulated)
  dom.history.addEventListener('scroll', updateJump, { passive: true })
  dom.jump.addEventListener('click', jumpToLatest)
  dom.collapse.addEventListener('click', collapsePanel)
  dom.restore.addEventListener('click', () => restorePanel())
  dom.viewResult.addEventListener('click', showResult)

  dom.tabs.addEventListener('click', (clickEvent) => {
    const tab = clickEvent.target.closest('[role="tab"]')
    if (tab !== null) selectTab(tab.getAttribute('data-tab'))
  })
  dom.tabs.addEventListener('keydown', (keyEvent) => {
    const order = ['target', 'evidence']
    const index = order.indexOf(ui.canvas.tab)
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: order.length - 1 }[keyEvent.key]
    if (next === undefined) return
    keyEvent.preventDefault()
    selectTab(order[(next + order.length) % order.length], { focus: true })
  })

  dom.separator.addEventListener('keydown', (keyEvent) => {
    const step = {
      ArrowLeft: ui.panelStep - 1,
      ArrowDown: ui.panelStep - 1,
      ArrowRight: ui.panelStep + 1,
      ArrowUp: ui.panelStep + 1,
      Home: 0,
      End: PANEL_WIDTHS.length - 1,
    }[keyEvent.key]
    if (step === undefined) return
    keyEvent.preventDefault()
    setStep(step)
  })

  let dragging = null
  dom.separator.addEventListener('pointerdown', (pointerEvent) => {
    if (pointerEvent.button !== 0) return
    pointerEvent.preventDefault()
    dragging = pointerEvent.pointerId
    dom.separator.setPointerCapture(pointerEvent.pointerId)
    dom.separator.classList.add('is-dragging')
    document.body.classList.add('is-resizing')
    dom.separator.focus({ preventScroll: true })
  })
  dom.separator.addEventListener('pointermove', (pointerEvent) => {
    if (dragging !== pointerEvent.pointerId) return
    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const widthRem = (pointerEvent.clientX - dom.panel.getBoundingClientRect().left) / rootSize
    setStep(Math.round((widthRem - PANEL_WIDTHS[0]) / 2))
  })
  const endDrag = (pointerEvent) => {
    if (dragging !== pointerEvent.pointerId) return
    dragging = null
    dom.separator.classList.remove('is-dragging')
    document.body.classList.remove('is-resizing')
  }
  dom.separator.addEventListener('pointerup', endDrag)
  dom.separator.addEventListener('pointercancel', endDrag)

  // Keep following the latest work through width and layout changes, never forcing it otherwise.
  new ResizeObserver(() => {
    if (ui.collapsed) return
    if (ui.following) dom.history.scrollTop = dom.history.scrollHeight
    updateJump()
  }).observe(dom.history)

  renderAll({ resetHistory: true })
  note('Presentation only. Controls do not send requests or start real runs.')
})()
