#!/usr/bin/env node
// Operator-only preparation and verification of the Spec 006 `vite-static-v1` offline toolchain.
//
//   node tools/runtime/prepare-project-vite.mjs prepare [--output <manifest.json>] [--self-check]
//   node tools/runtime/prepare-project-vite.mjs verify --manifest <manifest.json> [--self-check]
//
// `prepare` verifies the permitted sample's committed lock (tests/fixtures/project-live), builds
// tools/runtime/project-vite.Dockerfile from a private build context that holds only the locked
// package.json and package-lock.json, then inspects the actual built image offline and writes a
// manifest that binds its immutable image ID to that lock, the installed dependency tree digest
// and the required tool paths. `verify` re-inspects an existing image by its recorded ID and
// rejects any missing image, mutable reference or mismatch. Neither command fabricates an
// identity: every digest comes from Docker or from hashing actual bytes.
//
// Package installation happens only inside `docker build`. Docker receives a scrubbed
// environment (no provider credential or token variable), no build argument, secret or SSH
// forwarding, and no repository context. Inspection and the optional self-check run with
// `--network=none`, a read-only root, all capabilities dropped and no new privileges. The
// self-check builds and tests a private temporary copy of the sample; it is operator evidence
// that the image can serve the locked sample offline, not the selected-project runtime.

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const PROFILE_ID = 'vite-static-v1'
export const MANIFEST_SCHEMA_VERSION = 1
export const TOOLCHAIN_ROOT = '/opt/flowproof/toolchain'
export const DEPENDENCY_ROOT = `${TOOLCHAIN_ROOT}/node_modules`
export const NODE_PATH = '/usr/local/bin/node'
export const VITE_PATH = `${DEPENDENCY_ROOT}/vite/bin/vite.js`
export const IMAGE_USER = '65532:65532'
export const ABSENT_TOOLS = Object.freeze([
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/bin/corepack',
  '/usr/local/bin/yarn',
  '/usr/local/bin/yarnpkg',
  '/usr/local/lib/node_modules/npm',
  '/usr/local/lib/node_modules/corepack',
])
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PINNED_BASE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/
const REGISTRY_PREFIX = 'https://registry.npmjs.org/'
const LABEL_PREFIX = 'dev.flowproof'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..')
const DEFAULT_DOCKERFILE = path.join(REPO_ROOT, 'tools/runtime/project-vite.Dockerfile')
const DEFAULT_FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/project-live')

export class PreparationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'PreparationError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new PreparationError(code, message)
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

/** Deterministic JSON: sorted object keys, no insignificant whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('MANIFEST_INVALID', 'Manifest numbers are finite.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  fail('MANIFEST_INVALID', 'Only JSON values are canonicalized.')
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function exactKeys(value, keys, field) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail('MANIFEST_INVALID', `The field ${field} has missing or unexpected keys.`)
  }
  return value
}

async function readRegularFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('INPUT_UNREADABLE', 'An input file is missing or a symlink.'))
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('INPUT_UNREADABLE', 'An input is not a regular file.')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------------------
// Fixture lock binding
// ---------------------------------------------------------------------------------------

/**
 * Loads the fixture manifest and verifies the sample's package.json and lockfile bytes against
 * it, plus the lock's own shape: lockfile v3, exact root dependencies, and every package resolved
 * from the public npm registry with an integrity hash.
 */
export async function loadFixtureLock(fixtureDir = DEFAULT_FIXTURE_DIR) {
  const manifest = JSON.parse((await readRegularFile(path.join(fixtureDir, 'fixture.json'))).toString('utf8'))
  if (!isRecord(manifest) || manifest.schema_version !== 1 || manifest.category !== PROFILE_ID) fail('FIXTURE_MANIFEST_INVALID', 'The fixture manifest is invalid.')
  const sampleDir = path.join(fixtureDir, String(manifest.sample_directory))
  const lockEntry = manifest.lock
  const packageEntry = manifest.files?.['package.json']
  if (!isRecord(lockEntry) || lockEntry.path !== 'package-lock.json' || !SHA256_PATTERN.test(String(lockEntry.sha256))) {
    fail('FIXTURE_MANIFEST_INVALID', 'The fixture lock entry is invalid.')
  }
  if (!isRecord(packageEntry) || !SHA256_PATTERN.test(String(packageEntry.sha256))) fail('FIXTURE_MANIFEST_INVALID', 'The fixture package entry is invalid.')
  const lockBytes = await readRegularFile(path.join(sampleDir, 'package-lock.json'))
  const packageBytes = await readRegularFile(path.join(sampleDir, 'package.json'))
  const lockSha256 = sha256Hex(lockBytes)
  const packageSha256 = sha256Hex(packageBytes)
  if (lockSha256 !== lockEntry.sha256) fail('FIXTURE_LOCK_MISMATCH', 'The sample lockfile differs from the fixture manifest.')
  if (packageSha256 !== packageEntry.sha256) fail('FIXTURE_LOCK_MISMATCH', 'The sample package.json differs from the fixture manifest.')

  const lock = JSON.parse(lockBytes.toString('utf8'))
  const pkg = JSON.parse(packageBytes.toString('utf8'))
  if (lock.lockfileVersion !== 3 || !isRecord(lock.packages)) fail('FIXTURE_LOCK_INVALID', 'The sample lock is not an npm lockfile v3.')
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const expected = manifest.dependencies
  if (!isRecord(expected) || canonicalJson(declared) !== canonicalJson(expected)) fail('FIXTURE_LOCK_INVALID', 'The sample declares other dependencies than the fixture.')
  for (const [name, version] of Object.entries(expected)) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(version))) fail('FIXTURE_LOCK_INVALID', 'Fixture dependencies use exact versions.')
    if (lock.packages[`node_modules/${name}`]?.version !== version) fail('FIXTURE_LOCK_INVALID', 'The lock resolves a different dependency version.')
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue
    if (!isRecord(entry) || typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY_PREFIX)) {
      fail('FIXTURE_LOCK_INVALID', 'Every locked package resolves from the public npm registry.')
    }
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) fail('FIXTURE_LOCK_INVALID', 'Every locked package has an integrity hash.')
  }
  return Object.freeze({
    fixtureId: String(manifest.fixture_id),
    sampleDir,
    files: manifest.files,
    lockSha256,
    packageSha256,
    dependencies: Object.freeze({ ...expected }),
    lockedPackages: lock.packages,
    projectCheck: Object.freeze({ id: String(manifest.project_check?.id), argv: Object.freeze([...(manifest.project_check?.argv ?? [])].map(String)) }),
  })
}

// ---------------------------------------------------------------------------------------
// Dockerfile and Docker
// ---------------------------------------------------------------------------------------

/** Every FROM line must name a tagged image pinned by digest, or a previous build stage. */
export function pinnedBaseReferences(dockerfileText) {
  const stages = new Set()
  const references = []
  for (const raw of dockerfileText.split('\n')) {
    const line = raw.trim()
    if (!/^FROM\s/i.test(line)) continue
    const parts = line.split(/\s+/).slice(1).filter((part) => !part.startsWith('--'))
    const reference = parts[0] ?? ''
    if (!stages.has(reference)) {
      if (!PINNED_BASE_PATTERN.test(reference)) fail('BASE_IMAGE_NOT_PINNED', 'Every base image is pinned by a sha256 digest.')
      references.push(reference)
    }
    if (parts[1]?.toUpperCase() === 'AS' && parts[2]) stages.add(parts[2])
  }
  if (references.length === 0) fail('BASE_IMAGE_NOT_PINNED', 'The Dockerfile names no base image.')
  return [...new Set(references)]
}

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i

/** The only environment Docker receives: connection settings, never provider credentials. */
export function dockerEnvironment(source = process.env) {
  const environment = { PATH: source.PATH ?? '/usr/bin:/bin', HOME: source.HOME ?? homedir(), LC_ALL: 'C', DOCKER_CLI_HINTS: 'false' }
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR']) {
    if (typeof source[name] === 'string' && source[name] !== '') environment[name] = source[name]
  }
  for (const name of Object.keys(environment)) if (SECRETISH.test(name)) delete environment[name]
  return environment
}

async function docker(args, { timeout = 120_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await run('docker', args, { encoding: 'utf8', env: dockerEnvironment(), timeout, maxBuffer })
    return stdout
  } catch (error) {
    if (error?.code === 'ENOENT') fail('DOCKER_UNAVAILABLE', 'The docker CLI is not available.')
    const detail = typeof error?.stderr === 'string' ? error.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400) : ''
    const wrapped = new PreparationError('DOCKER_COMMAND_FAILED', `docker ${args[0]} failed.`)
    wrapped.detail = detail
    throw wrapped
  }
}

const OFFLINE_RUN = Object.freeze([
  'run',
  '--rm',
  '--network=none',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--pids-limit=256',
  '--memory=1g',
  '--cpus=1',
  '--tmpfs=/tmp:rw,nosuid,nodev,size=64m',
  '--env=HOME=/tmp/home',
])

// Runs inside the image as its non-root user. It hashes the actual installed dependency tree and
// reads tool versions from the image filesystem; nothing comes from the host.
const INSPECTOR = String.raw`
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
const sha = (data) => createHash('sha256').update(data).digest('hex')
const root = '${DEPENDENCY_ROOT}'
const lines = []
let files = 0
const walk = (relative) => {
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const child = relative ? relative + '/' + name : name
    const info = lstatSync(path.join(root, child))
    const mode = (info.mode & 0o7777).toString(8)
    if (info.isSymbolicLink()) lines.push('l ' + mode + ' ' + child + ' ' + readlinkSync(path.join(root, child)))
    else if (info.isDirectory()) { lines.push('d ' + mode + ' ' + child); walk(child) }
    else if (info.isFile()) { files += 1; lines.push('f ' + mode + ' ' + info.size + ' ' + child + ' ' + sha(readFileSync(path.join(root, child)))) }
    else lines.push('s ' + mode + ' ' + child)
  }
}
walk('')
const hidden = JSON.parse(readFileSync(root + '/.package-lock.json', 'utf8'))
const installed = Object.entries(hidden.packages).filter(([key]) => key !== '').map(([key, value]) => key + '@' + value.version).sort()
const version = (name) => JSON.parse(readFileSync(root + '/' + name + '/package.json', 'utf8')).version
const fileType = (target) => { try { const info = lstatSync(target); return info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other' } catch { return 'absent' } }
process.stdout.write(JSON.stringify({
  node: { exec_path: realpathSync(process.execPath), version: process.version, path_type: fileType('${NODE_PATH}') },
  vite: { version: version('vite'), path_type: fileType('${VITE_PATH}') },
  packages: { react: version('react'), 'react-dom': version('react-dom'), vite: version('vite') },
  tree_sha256: sha(lines.join('\n')),
  tree_entries: lines.length,
  file_count: files,
  installed_packages: installed,
  toolchain_package_sha256: sha(readFileSync('${TOOLCHAIN_ROOT}/package.json')),
  toolchain_lock_sha256: sha(readFileSync('${TOOLCHAIN_ROOT}/package-lock.json')),
  absent_tools: ${JSON.stringify(ABSENT_TOOLS)}.filter((tool) => !existsSync(tool)),
  uid: process.getuid(),
}))
`

/** Inspects the built image by immutable ID, both through Docker and from inside it, offline. */
export async function inspectImage(imageId, fixture) {
  if (!IMAGE_ID_PATTERN.test(String(imageId))) fail('IMAGE_REFERENCE_MUTABLE', 'Only an immutable sha256 image ID is accepted.')
  let documents
  try {
    documents = JSON.parse(await docker(['image', 'inspect', '--', imageId]))
  } catch (error) {
    if (error?.code === 'DOCKER_UNAVAILABLE') throw error
    fail('IMAGE_MISSING', 'The recorded image is not present locally.')
  }
  const [document] = documents
  if (!document || document.Id !== imageId) fail('IMAGE_MISMATCH', 'Docker reports a different image identity.')
  const config = document.Config ?? {}
  const labels = config.Labels ?? {}
  if (labels[`${LABEL_PREFIX}.profile`] !== PROFILE_ID) fail('IMAGE_MISMATCH', 'The image is not the vite-static-v1 toolchain.')
  if (labels[`${LABEL_PREFIX}.lock-sha256`] !== fixture.lockSha256) fail('IMAGE_LOCK_MISMATCH', 'The image was built from another lock.')
  if (labels[`${LABEL_PREFIX}.package-sha256`] !== fixture.packageSha256) fail('IMAGE_LOCK_MISMATCH', 'The image was built from another package manifest.')
  if (config.User !== IMAGE_USER) fail('IMAGE_POLICY_MISMATCH', 'The image default user is not the fixed non-root user.')
  if (Array.isArray(config.Entrypoint) && config.Entrypoint.length > 0) fail('IMAGE_POLICY_MISMATCH', 'The image must not wrap commands in an entrypoint.')
  const envNames = (config.Env ?? []).map((entry) => String(entry).split('=')[0])
  if (envNames.some((name) => SECRETISH.test(name))) fail('IMAGE_POLICY_MISMATCH', 'The image environment names a credential-like variable.')

  const report = JSON.parse(await docker([...OFFLINE_RUN, `--user=${IMAGE_USER}`, '--entrypoint=', '--', imageId, NODE_PATH, '--input-type=module', '-e', INSPECTOR], { timeout: 180_000 }))
  if (report.uid !== 65532) fail('IMAGE_POLICY_MISMATCH', 'The inspection did not run as the fixed non-root user.')
  if (report.node.path_type !== 'file' || report.node.exec_path !== NODE_PATH) fail('IMAGE_TOOL_MISSING', 'The image lacks the fixed Node executable.')
  if (report.vite.path_type !== 'file') fail('IMAGE_TOOL_MISSING', 'The image lacks the Vite entry point.')
  if (canonicalJson(report.packages) !== canonicalJson(fixture.dependencies)) fail('IMAGE_DEPENDENCY_MISMATCH', 'The installed dependency versions differ from the lock.')
  if (report.toolchain_lock_sha256 !== fixture.lockSha256 || report.toolchain_package_sha256 !== fixture.packageSha256) {
    fail('IMAGE_LOCK_MISMATCH', 'The image toolchain lock differs from the fixture lock.')
  }
  for (const entry of report.installed_packages) {
    const separator = entry.lastIndexOf('@')
    const key = entry.slice(0, separator)
    if (fixture.lockedPackages[key]?.version !== entry.slice(separator + 1)) fail('IMAGE_DEPENDENCY_MISMATCH', 'An installed package is not in the lock.')
  }
  if (report.absent_tools.length !== ABSENT_TOOLS.length) fail('IMAGE_POLICY_MISMATCH', 'A package manager remains in the image.')

  return Object.freeze({
    image: {
      id: document.Id,
      repo_digests: [...(document.RepoDigests ?? [])].sort(),
      architecture: String(document.Architecture),
      os: String(document.Os),
      user: config.User,
      created: String(document.Created),
      size_bytes: Number(document.Size),
      layers: [...(document.RootFS?.Layers ?? [])],
      labels: Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith(`${LABEL_PREFIX}.`)).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    dependencies: {
      root: DEPENDENCY_ROOT,
      tree_sha256: report.tree_sha256,
      tree_entries: report.tree_entries,
      file_count: report.file_count,
      installed_package_count: report.installed_packages.length,
      installed_packages_sha256: sha256Hex(report.installed_packages.join('\n')),
      packages: report.packages,
    },
    tools: {
      node: { path: NODE_PATH, version: report.node.version },
      vite: { path: VITE_PATH, version: report.vite.version },
      dependency_root: DEPENDENCY_ROOT,
    },
    absent_tools: [...ABSENT_TOOLS],
  })
}

/**
 * Operator smoke: builds and tests a private temporary copy of the locked sample offline in the
 * image. The copy links the prepared read-only dependency root; nothing is installed or fetched.
 */
export async function selfCheck(imageId, fixture) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'flowproof-vite-self-check-')))
  try {
    await chmod(parent, 0o700)
    const workspace = path.join(parent, 'workspace')
    await mkdir(workspace, { mode: 0o700 })
    for (const file of Object.keys(fixture.files).sort()) {
      const bytes = await readRegularFile(path.join(fixture.sampleDir, file))
      if (sha256Hex(bytes) !== fixture.files[file].sha256) fail('FIXTURE_LOCK_MISMATCH', 'A sample file differs from the fixture manifest.')
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true, mode: 0o700 })
      await copyFile(path.join(fixture.sampleDir, file), path.join(workspace, file), constants.COPYFILE_EXCL)
    }
    await symlink(DEPENDENCY_ROOT, path.join(workspace, 'node_modules'))
    const uid = typeof process.getuid === 'function' ? process.getuid() : 65532
    const gid = typeof process.getgid === 'function' ? process.getgid() : 65532
    const inWorkspace = [...OFFLINE_RUN, `--user=${uid}:${gid}`, '--entrypoint=', `--volume=${workspace}:/workspace:rw`, '--workdir=/workspace', '--', imageId]
    // The native config loader imports vite.config.js directly instead of bundling it into
    // node_modules/.vite-temp, which is the read-only prepared dependency root here.
    await docker([...inWorkspace, NODE_PATH, VITE_PATH, 'build', '--configLoader', 'native', '--logLevel', 'error'], { timeout: 180_000 })
    const outputs = []
    const walk = async (relative) => {
      for (const entry of await readdir(path.join(workspace, 'dist', relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile()) outputs.push(child)
        else fail('SELF_CHECK_FAILED', 'The build produced a non-regular output entry.')
      }
    }
    await walk('').catch((error) => {
      if (error instanceof PreparationError) throw error
      fail('SELF_CHECK_FAILED', 'The build produced no dist/ output.')
    })
    if (!outputs.includes('index.html')) fail('SELF_CHECK_FAILED', 'The build produced no dist/index.html.')
    // The fixture's own confirmed check argv; a non-zero exit already rejects through docker().
    const [program, ...checkArguments] = fixture.projectCheck.argv
    if (program !== 'node') fail('FIXTURE_MANIFEST_INVALID', 'The fixture project check runs the image Node.')
    const check = await docker([...inWorkspace, NODE_PATH, ...checkArguments], { timeout: 180_000 })
    const passCount = Number(/^(?:#|\u2139) pass ([0-9]+)$/m.exec(check)?.[1] ?? 0)
    if (!/^(?:#|\u2139) fail 0$/m.test(check) || passCount < 1) fail('SELF_CHECK_FAILED', 'The sample project check did not pass.')
    return Object.freeze({
      kind: 'operator-preparation-smoke',
      network: 'none',
      build: 'passed',
      output_files: outputs.sort(),
      project_check: 'passed',
      project_check_argv: [...fixture.projectCheck.argv],
      project_check_pass_count: passCount,
    })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------

const MANIFEST_KEYS = ['schema_version', 'profile_id', 'image', 'fixture', 'dependencies', 'tools', 'absent_tools', 'build', 'prepared_at', 'manifest_sha256']

export function withManifestDigest(body) {
  return { ...body, manifest_sha256: sha256Hex(canonicalJson(body)) }
}

/** Strictly parses a manifest; it never resolves a tag or trusts its own digest unchecked. */
export function parseManifest(value) {
  const manifest = exactKeys(value, MANIFEST_KEYS, 'manifest')
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION || manifest.profile_id !== PROFILE_ID) fail('MANIFEST_INVALID', 'The manifest version or profile is invalid.')
  const image = isRecord(manifest.image) ? manifest.image : fail('MANIFEST_INVALID', 'The manifest image is invalid.')
  if (!IMAGE_ID_PATTERN.test(String(image.id))) fail('IMAGE_REFERENCE_MUTABLE', 'Only an immutable sha256 image ID is accepted.')
  const fixture = exactKeys(manifest.fixture, ['fixture_id', 'lock_path', 'lock_sha256', 'package_sha256'], 'fixture')
  if (!SHA256_PATTERN.test(String(fixture.lock_sha256)) || !SHA256_PATTERN.test(String(fixture.package_sha256))) fail('MANIFEST_INVALID', 'The fixture digests are invalid.')
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : fail('MANIFEST_INVALID', 'The manifest dependencies are invalid.')
  if (!SHA256_PATTERN.test(String(dependencies.tree_sha256))) fail('MANIFEST_INVALID', 'The dependency tree digest is invalid.')
  const { manifest_sha256: recorded, ...body } = manifest
  if (sha256Hex(canonicalJson(body)) !== recorded) fail('MANIFEST_DIGEST_MISMATCH', 'The manifest content differs from its digest.')
  return manifest
}

/**
 * Returns the missing directories of the manifest path, outermost first, without creating any.
 * An existing manifest directory must be a real directory; a deeper existing ancestor only has to
 * resolve to a directory (a symlinked home stays usable).
 */
async function missingManifestDirectories(directory) {
  const missing = []
  for (let current = directory; ; current = path.dirname(current)) {
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code !== 'ENOENT' || path.dirname(current) === current) fail('OUTPUT_INVALID', 'The manifest directory path is not usable.')
      missing.unshift(current)
      continue
    }
    if (missing.length === 0 && (info.isSymbolicLink() || !info.isDirectory())) fail('OUTPUT_INVALID', 'The manifest directory is not a real directory.')
    if (missing.length > 0 && !(await stat(current).catch(() => null))?.isDirectory()) fail('OUTPUT_INVALID', 'A manifest directory ancestor is not a directory.')
    return missing
  }
}

/**
 * Writes the manifest as a new 0600 file renamed over `target`. Existing directories keep their
 * exact mode (a shared or sticky directory is used, never repaired); only missing directories are
 * created, each 0700. A symlinked or non-directory manifest directory and a target that is not a
 * regular file are refused unchanged. On failure the call removes only its own temporary file and
 * the empty directories it created.
 */
export async function writePrivateJson(target, value) {
  const directory = path.dirname(target)
  const missing = await missingManifestDirectories(directory)
  const created = []
  let staged = null
  try {
    for (const next of missing) {
      // mode 0o700 is reduced, never widened, by the umask; nothing pre-existing is chmod-ed.
      await mkdir(next, { mode: 0o700 })
      created.push(next)
    }
    const existing = await lstat(target).catch((error) => (error?.code === 'ENOENT' ? null : fail('OUTPUT_INVALID', 'The manifest path is not usable.')))
    if (existing !== null && !existing.isFile()) fail('OUTPUT_INVALID', 'The manifest path exists and is not a regular file.')
    const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    staged = temporary
    try {
      await handle.chmod(0o600)
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    staged = null
  } catch (error) {
    if (staged !== null) await unlink(staged).catch(() => undefined)
    for (const owned of created.reverse()) await rmdir(owned).catch(() => undefined)
    if (error instanceof PreparationError) throw error
    fail('OUTPUT_WRITE_FAILED', 'The manifest could not be written.')
  }
}

export function defaultManifestPath(environment = process.env) {
  const state = environment.XDG_STATE_HOME && path.isAbsolute(environment.XDG_STATE_HOME) ? environment.XDG_STATE_HOME : path.join(homedir(), '.local/state')
  return path.join(state, 'flowproof/runtime-profiles', `${PROFILE_ID}.json`)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export async function prepare({ dockerfile = DEFAULT_DOCKERFILE, fixtureDir = DEFAULT_FIXTURE_DIR, output = defaultManifestPath(), runSelfCheck = false } = {}) {
  const fixture = await loadFixtureLock(fixtureDir)
  const dockerfileBytes = await readRegularFile(dockerfile)
  const baseReferences = pinnedBaseReferences(dockerfileBytes.toString('utf8'))

  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'flowproof-vite-context-')))
  try {
    await chmod(parent, 0o700)
    const context = path.join(parent, 'context')
    await mkdir(context, { mode: 0o700 })
    // The context holds exactly the two locked files; nothing from the repository or host.
    await copyFile(path.join(fixture.sampleDir, 'package.json'), path.join(context, 'package.json'), constants.COPYFILE_EXCL)
    await copyFile(path.join(fixture.sampleDir, 'package-lock.json'), path.join(context, 'package-lock.json'), constants.COPYFILE_EXCL)
    if (sha256Hex(await readRegularFile(path.join(context, 'package-lock.json'))) !== fixture.lockSha256) fail('FIXTURE_LOCK_MISMATCH', 'The copied lock changed.')
    const iidfile = path.join(parent, 'image.iid')
    const tag = `flowproof-project-vite:lock-${fixture.lockSha256.slice(0, 12)}`
    try {
      await docker(
        [
          'build',
          '--file',
          dockerfile,
          '--tag',
          tag,
          '--label',
          `${LABEL_PREFIX}.lock-sha256=${fixture.lockSha256}`,
          '--label',
          `${LABEL_PREFIX}.package-sha256=${fixture.packageSha256}`,
          '--label',
          `${LABEL_PREFIX}.fixture-id=${fixture.fixtureId}`,
          '--label',
          `${LABEL_PREFIX}.dockerfile-sha256=${sha256Hex(dockerfileBytes)}`,
          '--iidfile',
          iidfile,
          '--quiet',
          context,
        ],
        { timeout: 900_000 },
      )
    } catch (error) {
      if (error instanceof PreparationError && error.code === 'DOCKER_COMMAND_FAILED') {
        const wrapped = new PreparationError('IMAGE_BUILD_FAILED', 'The toolchain image build failed.')
        wrapped.detail = error.detail
        throw wrapped
      }
      throw error
    }
    // The iidfile names the exact image this build produced. Build attestations make that ID
    // differ between otherwise identical cached rebuilds, so each preparation records its own.
    const imageId = (await readFile(iidfile, 'utf8').catch(() => fail('IMAGE_BUILD_FAILED', 'Docker reported no image ID.'))).trim()
    if (!IMAGE_ID_PATTERN.test(imageId)) fail('IMAGE_REFERENCE_MUTABLE', 'Docker reported no immutable image ID.')

    const inspected = await inspectImage(imageId, fixture)
    const build = {
      dockerfile: 'tools/runtime/project-vite.Dockerfile',
      dockerfile_sha256: sha256Hex(dockerfileBytes),
      base_references: baseReferences,
      context_files: ['package-lock.json', 'package.json'],
      convenience_tag: tag,
      docker_server_version: (await docker(['version', '--format', '{{.Server.Version}}'])).trim(),
      self_check: runSelfCheck ? await selfCheck(imageId, fixture) : null,
    }
    const manifest = withManifestDigest({
      schema_version: MANIFEST_SCHEMA_VERSION,
      profile_id: PROFILE_ID,
      image: inspected.image,
      fixture: { fixture_id: fixture.fixtureId, lock_path: 'package-lock.json', lock_sha256: fixture.lockSha256, package_sha256: fixture.packageSha256 },
      dependencies: inspected.dependencies,
      tools: inspected.tools,
      absent_tools: inspected.absent_tools,
      build,
      prepared_at: new Date().toISOString(),
    })
    parseManifest(manifest)
    await writePrivateJson(output, manifest)
    return { manifest, output }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

export async function verify({ manifestPath, fixtureDir = DEFAULT_FIXTURE_DIR, runSelfCheck = false }) {
  const manifest = parseManifest(JSON.parse((await readRegularFile(manifestPath)).toString('utf8')))
  const fixture = await loadFixtureLock(fixtureDir)
  if (manifest.fixture.lock_sha256 !== fixture.lockSha256 || manifest.fixture.package_sha256 !== fixture.packageSha256) {
    fail('FIXTURE_LOCK_MISMATCH', 'The manifest is bound to another fixture lock.')
  }
  const inspected = await inspectImage(manifest.image.id, fixture)
  for (const field of ['dependencies', 'tools', 'absent_tools']) {
    if (canonicalJson(inspected[field]) !== canonicalJson(manifest[field])) fail('IMAGE_DEPENDENCY_MISMATCH', `The image ${field} differ from the manifest.`)
  }
  for (const field of ['id', 'architecture', 'os', 'user', 'layers', 'labels']) {
    if (canonicalJson(inspected.image[field]) !== canonicalJson(manifest.image[field])) fail('IMAGE_MISMATCH', `The image ${field} differs from the manifest.`)
  }
  const self_check = runSelfCheck ? await selfCheck(manifest.image.id, fixture) : null
  return { status: 'verified', image_id: manifest.image.id, manifest_sha256: manifest.manifest_sha256, tree_sha256: manifest.dependencies.tree_sha256, self_check }
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = { command, selfCheck: false }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    const value = () => {
      const next = rest[index + 1]
      if (next === undefined) fail('USAGE', `${argument} needs a value.`)
      index += 1
      return path.resolve(next)
    }
    if (argument === '--output') options.output = value()
    else if (argument === '--manifest') options.manifest = value()
    else if (argument === '--dockerfile') options.dockerfile = value()
    else if (argument === '--fixture-dir') options.fixtureDir = value()
    else if (argument === '--self-check') options.selfCheck = true
    else fail('USAGE', 'Unknown argument.')
  }
  if (command !== 'prepare' && command !== 'verify') fail('USAGE', 'Use prepare or verify.')
  if (command === 'verify' && !options.manifest) fail('USAGE', 'verify needs --manifest.')
  return options
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.command === 'prepare') {
      const { manifest, output } = await prepare({
        ...(options.dockerfile ? { dockerfile: options.dockerfile } : {}),
        ...(options.fixtureDir ? { fixtureDir: options.fixtureDir } : {}),
        ...(options.output ? { output: options.output } : {}),
        runSelfCheck: options.selfCheck,
      })
      process.stdout.write(`${JSON.stringify({ status: 'prepared', output, manifest }, null, 2)}\n`)
    } else {
      const result = await verify({
        manifestPath: options.manifest,
        ...(options.fixtureDir ? { fixtureDir: options.fixtureDir } : {}),
        runSelfCheck: options.selfCheck,
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    }
  } catch (error) {
    const code = error instanceof PreparationError ? error.code : 'PREPARATION_INTERNAL_ERROR'
    const message = error instanceof PreparationError ? error.message : 'Preparation failed unexpectedly.'
    process.stderr.write(`${JSON.stringify({ status: 'rejected', code, message, ...(error?.detail ? { detail: error.detail } : {}) })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) await main()
