// Human QA launcher only: no production command, test helper imports, or live provider.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--case' || args[1] !== 'pass') {
  console.error('Usage: node tests/manual/captured-verification.mjs --case pass')
  process.exit(2)
}
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const built = new URL('../../packages/flowproof/dist/', import.meta.url)
const modules = ['editing/runtimeProfile.js', 'editing/session.js', 'editing/workspace.js', 'evidence/secretScan.js', 'git/repositoryState.js', 'studio/launch.js']
if (modules.some((module) => !existsSync(new URL(module, built)))) {
  console.error('Run pnpm build before starting this QA launcher.')
  process.exit(2)
}
const [{ createRuntimeProfileRegistry }, { startCapturingEditingSession }, { createWorkspaceManager }, { createSecretScanner }, gitState, { startCapturedVerificationStudio }] =
  await Promise.all(modules.map((module) => import(new URL(module, built).href)))
const run = promisify(execFile)
const command = async (file, argv, timeout = 60_000) => (await run(file, argv, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })).stdout
const port = 43119
const listening = () => new Promise((resolve) => {
  const probe = request({ host: 'localhost', port, path: '/', timeout: 1_000 }, (response) => { response.resume(); resolve(true) })
  probe.on('error', () => resolve(false))
  probe.on('timeout', () => { probe.destroy(); resolve(false) })
  probe.end()
})
const entries = async (root) => {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    found.push(entry.name)
    if (entry.isDirectory()) for (const child of await entries(path.join(root, entry.name))) found.push(`${entry.name}/${child}`)
  }
  return found.sort()
}
const processesMentioning = async (needle) => {
  const pids = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8')
      if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) continue
      if ((await readFile(`/proc/${name}/cmdline`, 'utf8')).includes(needle)) pids.push(Number(name))
    } catch { /* A process may exit between the two reads. */ }
  }
  return pids.sort((a, b) => a - b)
}

let ownerRoot, clone, runtimeRoot, studio, captureHandle, imageStarted = false, snapshot
let cleanupFailed = false
let stopRequested = false
const tag = `flowproof-editing-agent:manual-${process.pid}-${randomBytes(6).toString('hex')}`
const savedTmp = process.env.TMPDIR
const savedKey = process.env.MODEL_API_KEY
const onSignal = () => {
  stopRequested = true
  void captureHandle?.cancel().catch(() => { cleanupFailed = true })
  void studio?.close().catch(() => { cleanupFailed = true })
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
try {
  if (await listening()) throw new Error('The prepared target port is already occupied; close the other Studio first.')
  delete process.env.MODEL_API_KEY
  ownerRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'flowproof-manual-captured-')))
  clone = path.join(ownerRoot, 'repo')
  runtimeRoot = path.join(ownerRoot, 'runtime')
  await mkdir(runtimeRoot)
  // Clone committed bytes, not uncommitted source; dependency links model the prepared environment.
  await command('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, clone])
  await appendFile(path.join(clone, '.git/info/exclude'), '\nnode_modules\n')
  for (const pkg of ['.', 'apps/demo-chart', 'apps/studio', 'packages/flowproof']) {
    const installed = path.join(repoRoot, pkg, 'node_modules')
    if (!existsSync(installed)) throw new Error('Prepared dependencies are missing; run the repository setup first.')
    await symlink(installed, path.join(clone, pkg, 'node_modules'), 'dir')
  }
  snapshot = await gitState.snapshotRepository(clone, path.join(clone, '.git'))
  const fixture = path.join(repoRoot, 'tests/fixtures/editing-agent')
  imageStarted = true
  // Same fixed build arguments as tests/support/editingRuntime.ts; no package install or fetch.
  await command('docker', ['build', '--quiet', '--file', path.join(fixture, 'Dockerfile'), '--tag', tag, fixture], 300_000)
  const imageReference = (await command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])).trim()
  if (!/^sha256:[a-f0-9]{64}$/.test(imageReference)) throw new Error('The fixture image ID is not immutable.')
  if (stopRequested) throw new Error('QA launch interrupted.')
  captureHandle = startCapturingEditingSession({
    repositoryRoot: clone,
    revision: snapshot.head,
    task: `scenario=canvas-fix marker=${randomBytes(8).toString('hex')}`,
    runtimeProfileId: 'fixture-editing-agent',
    declaredProjectCommands: [],
  }, {
    profiles: createRuntimeProfileRegistry([{
      id: 'fixture-editing-agent', imageReference,
      argv: ['node', '/opt/flowproof-agent/agent.mjs', '/run/flowproof/task.json'],
      environment: { FLOWPROOF_FIXTURE: '1' }, workingDirectory: '/workspace',
    }]),
    workspaces: createWorkspaceManager({ tmpRoot: runtimeRoot }),
    scanner: createSecretScanner({ markers: ['FPMANUALCAPTURENEVERPRESENT01'] }),
  })
  const captureResult = await captureHandle.result
  captureHandle = null
  if (stopRequested) throw new Error('QA launch interrupted.')
  process.env.TMPDIR = runtimeRoot
  studio = await startCapturedVerificationStudio({ repoRoot: clone, captureResult, scenarioId: 'canvas-filter-hero' })
  if (stopRequested) await studio.close()
  console.log('Studio ready. Click Start candidate verification; observe baseline, replay and captured evidence, then close Studio.')
  // No automatic start or visual verdict: this launcher waits for the human to finish.
  if (!studio.page.isClosed()) await studio.page.waitForEvent('close', { timeout: 0 })
  await studio.close()
} catch (error) {
  process.exitCode = 1
  console.error(error instanceof Error && error.message.startsWith('The prepared target port') ? error.message : 'Captured verification QA could not finish. No human visual acceptance is recorded.')
} finally {
  let summary = null
  if (captureHandle) {
    await captureHandle.cancel().catch(() => { cleanupFailed = true })
    await captureHandle.result.catch(() => { cleanupFailed = true })
  }
  if (studio) await studio.close().catch(() => { cleanupFailed = true })
  if (runtimeRoot) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const leftovers = await entries(runtimeRoot)
      const processes = await processesMentioning(ownerRoot)
      const targetPortListening = await listening()
      const mismatches = snapshot ? gitState.compareSnapshots(snapshot, await gitState.snapshotRepository(clone, path.join(clone, '.git'))) : ['snapshot_unavailable']
      summary = { temporaryLeftovers: leftovers, processes, targetPortListening, originalSnapshotUnchanged: mismatches.length === 0, mismatches }
      if (leftovers.length || processes.length || targetPortListening || mismatches.length) cleanupFailed = true
    } catch { cleanupFailed = true }
  }
  if (imageStarted) await command('docker', ['image', 'rm', tag]).catch(() => { cleanupFailed = true })
  if (ownerRoot) await rm(ownerRoot, { recursive: true, force: true }).catch(() => { cleanupFailed = true })
  if (savedTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedTmp
  if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  // Include tag/clone removal failures in the one final cleanup verdict, not an earlier success.
  if (ownerRoot) console.log(JSON.stringify({ ...summary, cleanupComplete: !cleanupFailed && summary !== null }))
  if (cleanupFailed) {
    console.error('QA cleanup was incomplete; do not record a successful cleanup.')
    process.exitCode = 1
  }
}
