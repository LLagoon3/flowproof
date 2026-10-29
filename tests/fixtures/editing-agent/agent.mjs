// The deterministic, credential-free coding agent used by the editing-runtime tests. It needs
// no model or provider account: whitespace-separated `key=value` tokens in the task text select
// one prepared scenario, which the agent performs inside its disposable `/workspace` copy. Every
// observation it prints is a fixed `FIXTURE` line so tests can assert on the sanitized diagnostic.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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
    for (let index = 0; index < Number(options.lines ?? 4_000); index += 1) process.stdout.write(line)
    report('flood done')
    process.exit(0)
    break
  }
  default:
    console.error(`FIXTURE unknown scenario`)
    process.exit(64)
}
