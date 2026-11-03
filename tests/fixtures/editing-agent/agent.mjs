// The deterministic, credential-free coding agent used by the editing-runtime tests. It needs
// no model or provider account: whitespace-separated `key=value` tokens in the task text select
// one prepared scenario, which the agent performs inside its disposable `/workspace` copy. Every
// observation it prints is a fixed `FIXTURE` line so tests can assert on the sanitized diagnostic.
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'

const TASK_DOCUMENT = process.argv[2] ?? '/run/flowproof/task.json'
const WORKSPACE = '/workspace'

const document = JSON.parse(readFileSync(TASK_DOCUMENT, 'utf8'))
const options = Object.fromEntries(
  String(document.task)
    .split(/\s+/)
    .filter((token) => token.includes('='))
    .map((token) => [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]),
)
const marker = options.marker ?? 'unmarked'

const report = (line) => console.log(`FIXTURE ${line}`)
const idle = () => setInterval(() => undefined, 1_000)

/** A descendant that idles until the container boundary removes it; its argv carries the marker. */
function spawnDescendant(detached) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)', `flowproof-fixture-child-${marker}`], {
    detached,
    stdio: 'ignore',
  })
  child.unref()
}

function observeIsolation() {
  const status = readFileSync('/proc/self/status', 'utf8')
  const field = (name) => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1] ?? 'unknown'
  report(`isolation uid=${process.getuid()} seccomp=${field('Seccomp')} nonewprivs=${field('NoNewPrivs')} capeff=${field('CapEff')}`)
  let rootfs = 'writable'
  try {
    writeFileSync('/flowproof-rootfs-probe', 'x')
  } catch (error) {
    rootfs = error.code === 'EROFS' ? 'readonly' : `error-${error.code}`
  }
  let taskDocument = 'writable'
  try {
    writeFileSync(TASK_DOCUMENT, '{}')
  } catch (error) {
    taskDocument = error.code === 'EROFS' ? 'readonly' : `error-${error.code}`
  }
  const dockerSocket = existsSync('/var/run/docker.sock') || existsSync('/run/docker.sock') ? 'present' : 'absent'
  writeFileSync(`${process.env.HOME}/.flowproof-home-probe`, 'x')
  report(`filesystem rootfs=${rootfs} task_document=${taskDocument} docker_socket=${dockerSocket} home=writable`)
}

function edit(relative, from, to) {
  const file = `${WORKSPACE}/${relative}`
  const before = readFileSync(file, 'utf8')
  if (!before.includes(from)) throw new Error(`unexpected baseline in ${relative}`)
  writeFileSync(file, before.replace(from, to))
}

const EDITS = [
  ['src/math.mjs', 'return left - right', 'return left + right'],
  ['src/greeting.mjs', 'return `Hi ${name}`', 'return `Hello, ${name}!`'],
  ['README.md', 'Status: pending', 'Status: edited'],
]

async function succeed() {
  // Inspect: the exact selected commit, checked out detached in the standalone clone.
  const head = readFileSync(`${WORKSPACE}/.git/HEAD`, 'utf8').trim()
  report(`head=${head === options.expect_head ? 'expected' : 'unexpected'} remotes=${readFileSync(`${WORKSPACE}/.git/config`, 'utf8').includes('[remote') ? 'present' : 'absent'}`)
  if (head !== options.expect_head) process.exit(20)
  observeIsolation()

  for (const [relative, from, to] of EDITS) edit(relative, from, to)
  report(`edited files=${EDITS.length}`)

  // The first declared project command is context the agent chooses to run, without a shell.
  const [command, ...args] = String(document.declaredProjectCommands[0] ?? '').split(/\s+/).filter(Boolean)
  const run = spawnSync(command, args, { cwd: WORKSPACE, encoding: 'utf8' })
  report(`command status=${run.status} output=${(run.stdout || run.stderr).trim().replace(/\s+/g, '_')}`)
  if (run.status !== 0) process.exit(21)

  if (options.fetch) {
    const response = await fetch(options.fetch, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
    report(`fetch status=${response.status}`)
    if (!response.ok) process.exit(22)
  }

  // Self-verification: the agent confirms its own edits before exiting successfully.
  const verified = EDITS.every(([relative, , to]) => readFileSync(`${WORKSPACE}/${relative}`, 'utf8').includes(to))
  report(`self_verified=${verified}`)
  process.exit(verified ? 0 : 23)
}

// Change-capture scenarios (specs/003-capture-editing-candidate). They change the workspace with
// ordinary file operations only; the image has no Git, and the capture tests compare the result
// with independently expected bytes. Every byte is synthetic.

/** Bytes of a small synthetic binary asset: NUL, high bytes, and no valid UTF-8 text. */
const CAPTURE_BINARY = Buffer.from([0x89, 0x46, 0x50, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0x0a, 0x00])

/** A successful multi-file edit: text, binary, empty, non-ASCII, rename, mode, link, deletion. */
function captureEdits() {
  edit('src/math.mjs', 'return left - right', 'return left + right')
  mkdirSync(`${WORKSPACE}/assets`, { recursive: true })
  writeFileSync(`${WORKSPACE}/assets/pixel.bin`, CAPTURE_BINARY)
  writeFileSync(`${WORKSPACE}/empty.txt`, '')
  writeFileSync(`${WORKSPACE}/src/héllo.txt`, 'café 안녕 no final newline')
  mkdirSync(`${WORKSPACE}/lib`, { recursive: true })
  renameSync(`${WORKSPACE}/src/greeting.mjs`, `${WORKSPACE}/lib/greeting.mjs`)
  chmodSync(`${WORKSPACE}/scripts/check.mjs`, 0o755)
  symlinkSync('../src/math.mjs', `${WORKSPACE}/lib/math-link.mjs`)
  unlinkSync(`${WORKSPACE}/README.md`)
  report('capture edits applied')
}

/** Edits that are undone before exit, so no versioned change remains. */
function revertEdits() {
  const file = `${WORKSPACE}/src/math.mjs`
  const original = readFileSync(file)
  edit('src/math.mjs', 'return left - right', 'return left + right')
  writeFileSync(`${WORKSPACE}/scratch.txt`, 'temporary\n')
  writeFileSync(file, original)
  unlinkSync(`${WORKSPACE}/scratch.txt`)
  report('capture edits reverted')
}

/** A change carrying a synthetic credential shape or seeded marker, assembled from fragments. */
function sensitiveEdit() {
  mkdirSync(`${WORKSPACE}/config`, { recursive: true })
  if (options.kind === 'marker') {
    const seeded = ['FPCAPTURE', 'SEEDED', 'MARKER', '000001'].join('')
    writeFileSync(`${WORKSPACE}/config/blob.bin`, Buffer.concat([CAPTURE_BINARY, Buffer.from(seeded, 'latin1'), CAPTURE_BINARY]))
  } else {
    const token = ['gh', 'p_', 'FPCAPTURE', 'SEEDED', 'TOKEN', '00000000001'].join('')
    writeFileSync(`${WORKSPACE}/config/fixture.env`, `FIXTURE_SETTING=${token}\n`)
  }
  report('sensitive edit applied')
}

/** After capture edits: exit with `code` (default 0), or idle until stopped when `after=hang`. */
function finishCapture() {
  if (options.after === 'hang') {
    report('ready')
    idle()
    return
  }
  process.exit(Number(options.code ?? 0))
}

// Captured-verification Canvas candidates (specs/004-verify-captured-changes). They run against a
// clone of the FlowProof repository and change the prepared demo app with ordinary file operations
// only. Verification tests compare the outcome with independently expected bytes; nothing here
// claims that a candidate is correct.

const DEMO = 'apps/demo-chart'
const FILTER_MODULE = `${DEMO}/src/filterData.ts`
const BUGGY_FILTER = 'return rows.filter((row) => row.region.includes(region))'
const FILTER_IMPORT = "import type { SalesRow } from './data.js'\n"

/** The versioned helper of the multi-file fix: exact region matching. */
const REGION_MATCH_SOURCE = [
  '// Exact region matching, so overlapping names such as North and Northeast stay separate.',
  'export function matchesRegion(rowRegion: string, selectedRegion: string): boolean {',
  '  return rowRegion === selectedRegion',
  '}',
  '',
].join('\n')
const REGION_NOTES = 'Region filtering compares names exactly; overlapping names such as North and Northeast stay separate.\n'
/** A small synthetic binary asset: NUL, high bytes, and no valid UTF-8 text. */
const REGION_SWATCH = Buffer.from([0x89, 0x52, 0x47, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x10, 0x80, 0x0a, 0x00])

/** Replaces the buggy filter with a call to `matchesRegion` imported from `specifier`. */
function useRegionHelper(specifier) {
  edit(FILTER_MODULE, FILTER_IMPORT, `${FILTER_IMPORT}import { matchesRegion } from '${specifier}'\n`)
  edit(FILTER_MODULE, BUGGY_FILTER, 'return rows.filter((row) => matchesRegion(row.region, region))')
}

/** Multi-file fix: a new versioned helper module, a binary asset, a text note, and a mode change. */
function canvasFix() {
  writeFileSync(`${WORKSPACE}/${DEMO}/src/regionMatch.ts`, REGION_MATCH_SOURCE)
  useRegionHelper('./regionMatch.ts')
  mkdirSync(`${WORKSPACE}/${DEMO}/assets`, { recursive: true })
  writeFileSync(`${WORKSPACE}/${DEMO}/assets/region-swatch.bin`, REGION_SWATCH)
  writeFileSync(`${WORKSPACE}/${DEMO}/src/REGION-MATCHING.md`, REGION_NOTES)
  chmodSync(`${WORKSPACE}/README.md`, 0o755)
  report('canvas fix applied')
}

/** The same fix, but its helper lives under an ignored `dist/` directory, so capture omits it. */
function canvasHiddenDependency() {
  mkdirSync(`${WORKSPACE}/${DEMO}/src/dist`, { recursive: true })
  writeFileSync(`${WORKSPACE}/${DEMO}/src/dist/regionMatch.ts`, REGION_MATCH_SOURCE)
  useRegionHelper('./dist/regionMatch.ts')
  report('canvas hidden dependency applied')
}

/** A change that leaves the registered build unable to parse the filter module. */
function canvasBuildFail() {
  edit(FILTER_MODULE, BUGGY_FILTER, 'return rows.filter((row) => row.region === region')
  report('canvas build failure applied')
}

/** Fixes the filter but changes the rendered data, so the chart looks normal yet is wrong. */
function canvasPlausibleWrong() {
  edit(FILTER_MODULE, BUGGY_FILTER, 'return rows.filter((row) => row.region === region)')
  edit(`${DEMO}/src/data.ts`, "row('North', 'Q4', 150)", "row('North', 'Q4', 105)")
  report('canvas plausible wrong applied')
}

/** Leaves the defect, rewrites the candidate's copies of the prepared check, and adds a test script. */
function canvasSelfCertify() {
  const fixtures = `${WORKSPACE}/tests/fixtures/captured-verification`
  const passing = JSON.stringify({ check: 'prepared-region-filter', discovered: 6, executed: 6, passed: 6, failed: 0 })
  writeFileSync(`${fixtures}/check-filter.mjs`, `process.stdout.write(${JSON.stringify(`${passing}\n`)})\n`)
  writeFileSync(`${fixtures}/filter-cases.json`, `${JSON.stringify({ rows: [], cases: [] })}\n`)
  const manifest = `${WORKSPACE}/${DEMO}/package.json`
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  pkg.scripts = { ...pkg.scripts, test: 'node -e "process.exit(0)"' }
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
  report('canvas self certification applied')
}

const SEEDED_MARKERS = [
  'MODEL_API_KEY=sk-fpseededmarkerapikey000001',
  'Authorization: Bearer FPSEEDEDBEARERTOKEN000001',
  'https://fpuser:FPSEEDEDURLPASSWORD01@example.com/docs?token=FPSEEDEDQUERYTOKEN01',
  'ghp_FPSEEDEDGITHUBTOKEN000000000001',
  'password: "FPSEEDEDPASSWORD000001"',
  '-----BEGIN PRIVATE KEY-----\nFPSEEDEDPRIVATEKEYBODY000001\n-----END PRIVATE KEY-----',
]

const scenario = options.scenario ?? 'success'
switch (scenario) {
  case 'success':
    await succeed()
    break
  case 'capture':
    captureEdits()
    finishCapture()
    break
  case 'revert':
    revertEdits()
    finishCapture()
    break
  case 'sensitive':
    sensitiveEdit()
    finishCapture()
    break
  case 'canvas-fix':
    canvasFix()
    finishCapture()
    break
  case 'canvas-hidden-dependency':
    canvasHiddenDependency()
    finishCapture()
    break
  case 'canvas-build-fail':
    canvasBuildFail()
    finishCapture()
    break
  case 'canvas-plausible-wrong':
    canvasPlausibleWrong()
    finishCapture()
    break
  case 'canvas-self-certify':
    canvasSelfCertify()
    finishCapture()
    break
  case 'fail':
    console.error('FIXTURE failing on purpose')
    process.exit(Number(options.code ?? 3))
    break
  case 'exit':
    process.exit(Number(options.code ?? 0))
    break
  case 'hang':
    // Optionally ignores SIGTERM so only the forced removal after the stop grace ends it.
    if (options.ignore_term === '1') process.on('SIGTERM', () => report('ignored SIGTERM'))
    for (let index = 0; index < Number(options.children ?? 0); index += 1) spawnDescendant(false)
    report('ready')
    idle()
    break
  case 'orphans':
    // Detached descendants outlive this process; the container boundary must still remove them.
    for (let index = 0; index < Number(options.children ?? 2); index += 1) spawnDescendant(true)
    report('orphans spawned')
    setTimeout(() => process.exit(0), 300)
    break
  case 'secrets':
    for (const seeded of SEEDED_MARKERS) console.log(seeded)
    for (const seeded of SEEDED_MARKERS) console.error(seeded)
    console.log(`environment ${JSON.stringify(process.env)}`)
    console.log(`mounts ${readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter((line) => line.includes(' /workspace ') || line.includes('/run/flowproof')).join(' | ')}`)
    process.exit(Number(options.code ?? 0))
    break
  case 'flood': {
    // More output than the diagnostic bound, with a secret straddling the retained tail's start.
    const line = `${'x'.repeat(60)} api_key=fpseededfloodsecret000001\n`
    for (let index = 0; index < Number(options.lines ?? 4_000); index += 1) {
      if (!process.stdout.write(line)) await once(process.stdout, 'drain')
    }
    // Wait until the final marker is accepted by the pipe. `process.exit()` can otherwise discard
    // the tail under full-suite load and make the bounded-tail assertion nondeterministic.
    await new Promise((resolve) => process.stdout.write('FIXTURE flood done\n', resolve))
    process.exitCode = 0
    break
  }
  default:
    console.error(`FIXTURE unknown scenario`)
    process.exit(64)
}
