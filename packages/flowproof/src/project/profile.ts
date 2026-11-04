import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import { REASON_CODE_PATTERN, repositoryPathsOverlap } from '../contracts/index.js'
import { canonicalJson, sha256Hex } from '../evidence/store.js'
import type { AdmissionProfile, AdmittedProject } from './admission.js'
import {
  EXECUTION_LIMITS,
  ExecutionConfigurationSchema,
  MANDATORY_CHECK_IDS,
  PROJECT_CATEGORY,
  PROJECT_PROFILE_ID,
  PROJECT_SCHEMA_VERSION,
  ProjectConfigFileSchema,
  newProjectUuid,
  projectDigest,
  withConfigurationDigest,
} from './contracts.js'
import type { ExecutionConfiguration, ProjectConfigFile } from './contracts.js'

// The fixed `vite-static-v1` runtime profile (Spec 006 T016). The operator-prepared manifest
// (tools/runtime/prepare-project-vite.mjs) names one immutable image ID and its locked dependency
// set; this module parses it strictly, re-verifies its own digest, and confirms through
// `docker image inspect` that exactly that image is present locally. It never pulls, builds or
// tags an image, and a tag or other mutable reference is refused.
//
// Project settings are data only: a relative same-origin entry, a direct-argv build with its output
// directory, and direct-argv required project checks. Every program is the image's Node, every
// absolute path is the fixed toolchain, and every relative input must be an admitted committed
// file. Image, network, mounts, environment, credentials, model or evaluator policy cannot be
// expressed by settings: the host pins them in the execution configuration, together with the
// exact Plan limits. A changed setting is a new configuration with a new digest and confirmation.

export const PROFILE_NODE_PATH = '/usr/local/bin/node'
export const PROFILE_TOOLCHAIN_ROOT = '/opt/flowproof/toolchain'
export const PROFILE_DEPENDENCY_ROOT = `${PROFILE_TOOLCHAIN_ROOT}/node_modules`
export const PROFILE_VITE_PATH = `${PROFILE_DEPENDENCY_ROOT}/vite/bin/vite.js`
export const PROFILE_IMAGE_USER = '65532:65532'

/** Host-owned byte bounds of a phase: accepted output and retained diagnostics. */
export const PROFILE_BYTE_LIMITS = Object.freeze({
  max_output_bytes: 32 * 1_024 * 1_024,
  max_output_files: 2_000,
  max_diagnostic_bytes: 64 * 1_024,
})

export interface RuntimeProfile {
  readonly profileId: typeof PROJECT_PROFILE_ID
  readonly imageId: string
  readonly dependencyTreeSha256: string
  readonly manifestSha256: string
  readonly lockSha256: string
  readonly packageSha256: string
  readonly dependencies: Readonly<Record<string, string>>
}

export type ProfileErrorCode =
  | 'PROFILE_MANIFEST_MISSING'
  | 'PROFILE_MANIFEST_INVALID'
  | 'PROFILE_MANIFEST_DIGEST_MISMATCH'
  | 'PROFILE_IMAGE_REFERENCE_MUTABLE'
  | 'PROFILE_IMAGE_MISSING'
  | 'PROFILE_IMAGE_MISMATCH'
  | 'PROFILE_DOCKER_UNAVAILABLE'

const PROFILE_MESSAGES: Readonly<Record<ProfileErrorCode, string>> = {
  PROFILE_MANIFEST_MISSING: 'The vite-static-v1 runtime profile manifest is not available.',
  PROFILE_MANIFEST_INVALID: 'The vite-static-v1 runtime profile manifest is not valid.',
  PROFILE_MANIFEST_DIGEST_MISMATCH: 'The vite-static-v1 runtime profile manifest does not match its digest.',
  PROFILE_IMAGE_REFERENCE_MUTABLE: 'The runtime profile must name an immutable image ID.',
  PROFILE_IMAGE_MISSING: 'The prepared vite-static-v1 image is not present locally; it is never pulled.',
  PROFILE_IMAGE_MISMATCH: 'The local image differs from the prepared vite-static-v1 profile.',
  PROFILE_DOCKER_UNAVAILABLE: 'Docker is not available to inspect the prepared image.',
}

/** A fixed profile refusal; the message never carries paths, references or Docker output. */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode

  constructor(code: ProfileErrorCode) {
    super(PROFILE_MESSAGES[code])
    this.name = 'ProfileError'
    this.code = code
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const MANIFEST_KEYS = ['schema_version', 'profile_id', 'image', 'fixture', 'dependencies', 'tools', 'absent_tools', 'build', 'prepared_at', 'manifest_sha256']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')

/** Strictly parses an operator manifest and re-verifies its digest; it never resolves a tag. */
export function parseRuntimeManifest(value: unknown): RuntimeProfile {
  if (!exactKeys(value, MANIFEST_KEYS)) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  if (value.schema_version !== 1 || value.profile_id !== PROJECT_PROFILE_ID) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  const { image, fixture, dependencies, tools } = value
  if (!isRecord(image) || !isRecord(fixture) || !isRecord(dependencies) || !isRecord(tools)) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  if (typeof image.id !== 'string' || !IMAGE_ID.test(image.id)) throw new ProfileError('PROFILE_IMAGE_REFERENCE_MUTABLE')
  if (image.user !== PROFILE_IMAGE_USER) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  if (!exactKeys(fixture, ['fixture_id', 'lock_path', 'lock_sha256', 'package_sha256'])) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  if (fixture.lock_path !== 'package-lock.json' || !SHA256.test(String(fixture.lock_sha256)) || !SHA256.test(String(fixture.package_sha256))) {
    throw new ProfileError('PROFILE_MANIFEST_INVALID')
  }
  if (!SHA256.test(String(dependencies.tree_sha256)) || dependencies.root !== PROFILE_DEPENDENCY_ROOT || !isRecord(dependencies.packages)) {
    throw new ProfileError('PROFILE_MANIFEST_INVALID')
  }
  const node = tools.node
  const vite = tools.vite
  if (!isRecord(node) || node.path !== PROFILE_NODE_PATH || !isRecord(vite) || vite.path !== PROFILE_VITE_PATH) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  const packages = Object.entries(dependencies.packages)
  if (packages.some(([, version]) => typeof version !== 'string')) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  const { manifest_sha256: recorded, ...body } = value
  if (typeof recorded !== 'string' || !SHA256.test(recorded)) throw new ProfileError('PROFILE_MANIFEST_INVALID')
  let digest: string
  try {
    digest = sha256Hex(canonicalJson(body))
  } catch {
    throw new ProfileError('PROFILE_MANIFEST_INVALID')
  }
  if (digest !== recorded) throw new ProfileError('PROFILE_MANIFEST_DIGEST_MISMATCH')
  return Object.freeze({
    profileId: PROJECT_PROFILE_ID,
    imageId: image.id,
    dependencyTreeSha256: dependencies.tree_sha256 as string,
    manifestSha256: recorded,
    lockSha256: fixture.lock_sha256 as string,
    packageSha256: fixture.package_sha256 as string,
    dependencies: Object.freeze(Object.fromEntries(packages) as Record<string, string>),
  })
}

/** The prepare script's default manifest location. */
export function defaultRuntimeManifestPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir(), '.local/state')
  return path.join(state, 'flowproof/runtime-profiles', `${PROJECT_PROFILE_ID}.json`)
}

const MAX_MANIFEST_BYTES = 256 * 1_024

async function readBoundedNoFollow(file: string, maxBytes: number): Promise<Buffer | null> {
  if (!path.isAbsolute(file) || file.includes('\0')) return null
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Reads and parses the manifest only; no image is inspected. */
export async function readRuntimeManifest(manifestPath: string): Promise<RuntimeProfile> {
  const bytes = await readBoundedNoFollow(manifestPath, MAX_MANIFEST_BYTES)
  if (bytes === null) throw new ProfileError('PROFILE_MANIFEST_MISSING')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProfileError('PROFILE_MANIFEST_INVALID')
  }
  return parseRuntimeManifest(value)
}

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i

/** The only environment the Docker CLI receives: connection settings, never provider credentials. */
export function dockerCliEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin', HOME: source.HOME ?? homedir(), LC_ALL: 'C', DOCKER_CLI_HINTS: 'false' }
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR']) {
    const value = source[name]
    if (typeof value === 'string' && value !== '' && !SECRETISH.test(name)) environment[name] = value
  }
  return environment
}

/** Confirms that exactly the manifest's immutable image is present locally; never pulls. */
export async function verifyRuntimeImage(profile: RuntimeProfile): Promise<void> {
  const inspected = await new Promise<{ readonly stdout: string; readonly missing: boolean } | null>((resolve) => {
    execFile(
      'docker',
      ['image', 'inspect', '--', profile.imageId],
      { encoding: 'utf8', env: dockerCliEnvironment(), timeout: 60_000, maxBuffer: 8 * 1_024 * 1_024, shell: false },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ stdout, missing: false })
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null)
        resolve({ stdout: '', missing: /no such (?:image|object)/i.test(String(stderr)) })
      },
    )
  })
  if (inspected === null) throw new ProfileError('PROFILE_DOCKER_UNAVAILABLE')
  if (inspected.missing) throw new ProfileError('PROFILE_IMAGE_MISSING')
  if (inspected.stdout === '') throw new ProfileError('PROFILE_DOCKER_UNAVAILABLE')
  let document: Record<string, any> | undefined
  try {
    document = (JSON.parse(inspected.stdout) as Array<Record<string, any>>)[0]
  } catch {
    throw new ProfileError('PROFILE_IMAGE_MISMATCH')
  }
  const config = (document?.Config ?? {}) as Record<string, any>
  const labels = (config.Labels ?? {}) as Record<string, unknown>
  const environment = Array.isArray(config.Env) ? (config.Env as unknown[]).map((entry) => String(entry).split('=')[0] ?? '') : []
  const matches =
    document?.Id === profile.imageId &&
    labels['dev.flowproof.profile'] === PROJECT_PROFILE_ID &&
    labels['dev.flowproof.lock-sha256'] === profile.lockSha256 &&
    labels['dev.flowproof.package-sha256'] === profile.packageSha256 &&
    labels['dev.flowproof.toolchain-root'] === PROFILE_TOOLCHAIN_ROOT &&
    config.User === PROFILE_IMAGE_USER &&
    !(Array.isArray(config.Entrypoint) && config.Entrypoint.length > 0) &&
    !environment.some((name) => SECRETISH.test(name))
  if (!matches) throw new ProfileError('PROFILE_IMAGE_MISMATCH')
}

/** Reads the manifest and verifies the image: the full profile admission. */
export async function loadRuntimeProfile(options: { readonly manifestPath: string }): Promise<RuntimeProfile> {
  const profile = await readRuntimeManifest(options.manifestPath)
  await verifyRuntimeImage(profile)
  return profile
}

/** The identity a project is admitted against. */
export function admissionProfileOf(profile: RuntimeProfile): AdmissionProfile {
  return Object.freeze({
    profile_id: profile.profileId,
    image_id: profile.imageId,
    dependency_tree_sha256: profile.dependencyTreeSha256,
    manifest_sha256: profile.manifestSha256,
    lock_sha256: profile.lockSha256,
  })
}

// ---------------------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------------------

/** Reviewable project settings: exactly the config file's data fields. */
export const ProjectSettingsSchema = z.strictObject({
  entry_path: ProjectConfigFileSchema.shape.entry_path,
  build: ProjectConfigFileSchema.shape.build,
  required_project_checks: ProjectConfigFileSchema.shape.required_project_checks,
})
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

/** The trusted profile suggestion; it executes nothing to discover settings. */
export function suggestProjectSettings(_project: AdmittedProject): ProjectSettings {
  return {
    entry_path: '/',
    build: { argv: ['node', PROFILE_VITE_PATH, 'build', '--configLoader', 'native'], output_directory: 'dist' },
    required_project_checks: [],
  }
}

export type ConfigurationFileErrorCode = 'PROJECT_CONFIG_UNREADABLE' | 'PROJECT_CONFIG_INVALID'

export class ConfigurationFileError extends Error {
  readonly code: ConfigurationFileErrorCode

  constructor(code: ConfigurationFileErrorCode) {
    super(code === 'PROJECT_CONFIG_UNREADABLE' ? 'The project configuration file cannot be read.' : 'The project configuration file is not a valid vite-static-v1 configuration.')
    this.name = 'ConfigurationFileError'
    this.code = code
  }
}

const MAX_CONFIG_BYTES = 64 * 1_024

/** Reads an external `--project-config` file strictly (no-follow, bounded, closed schema). */
export async function readProjectConfigFile(file: string): Promise<ProjectSettings> {
  const bytes = await readBoundedNoFollow(file, MAX_CONFIG_BYTES)
  if (bytes === null) throw new ConfigurationFileError('PROJECT_CONFIG_UNREADABLE')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ConfigurationFileError('PROJECT_CONFIG_INVALID')
  }
  const parsed = ProjectConfigFileSchema.safeParse(value)
  if (!parsed.success) throw new ConfigurationFileError('PROJECT_CONFIG_INVALID')
  const { entry_path, build, required_project_checks }: ProjectConfigFile = parsed.data
  return { entry_path, build, required_project_checks }
}

export type ConfigurationResult = { readonly ok: true; readonly configuration: ExecutionConfiguration } | { readonly ok: false; readonly reasons: readonly string[] }

const PATH_LIKE = /\/|\.(?:[cm]?[jt]sx?|json)$/

/** Profile argv rules on top of the shared direct-argv schema. */
function argvReasons(argv: readonly string[], admitted: ReadonlySet<string>, inputs: Set<string>): string[] {
  const reasons: string[] = []
  const [program, ...rest] = argv
  if (program !== 'node' && program !== PROFILE_NODE_PATH) reasons.push('ARGV_PROGRAM_UNSUPPORTED')
  for (const argument of rest) {
    const value = argument.startsWith('-') && argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument
    if (argument.startsWith('-') && value === argument) continue
    if (value.startsWith('/')) {
      if (value.startsWith('/workspace/')) {
        const relative = value.slice('/workspace/'.length)
        if (admitted.has(relative)) inputs.add(relative)
        else reasons.push('ARGV_INPUT_MISSING')
      } else if (!value.startsWith(`${PROFILE_DEPENDENCY_ROOT}/`)) reasons.push('ARGV_TOOL_PATH_UNSUPPORTED')
      continue
    }
    if (PATH_LIKE.test(value)) {
      if (admitted.has(value)) inputs.add(value)
      else reasons.push('ARGV_INPUT_MISSING')
    }
  }
  return reasons
}

const reasonCode = (code: unknown): string => {
  const text = typeof code === 'string' ? code.toUpperCase() : 'CONFIGURATION_INVALID'
  return REASON_CODE_PATTERN.test(text) ? text.slice(0, 64) : 'CONFIGURATION_INVALID'
}

/**
 * Validates reviewed settings for an admitted project and pins the host policy. It executes
 * nothing. `confirmedAt` null yields a pending configuration; a timestamp confirms it.
 */
export function createExecutionConfiguration(options: {
  readonly project: AdmittedProject
  readonly profile: RuntimeProfile
  readonly settings: unknown
  readonly targetOrigin: string
  readonly confirmedAt: string | null
}): ConfigurationResult {
  const { project, profile } = options
  const parsed = ProjectSettingsSchema.safeParse(options.settings)
  if (!parsed.success) {
    const codes = parsed.error.issues.map((issue) => reasonCode(issue.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : issue.code))
    return { ok: false, reasons: [...new Set(codes)].slice(0, 16) }
  }
  const settings = parsed.data
  const reasons: string[] = []
  const context = project.context
  if (context.profile.image_id !== profile.imageId || context.profile.lock_sha256 !== profile.lockSha256 || context.profile.manifest_sha256 !== profile.manifestSha256) {
    reasons.push('PROFILE_MISMATCH')
  }
  const admitted = new Set(project.files.map((file) => file.path))
  const buildInputs = new Set<string>()
  const checkInputs = new Set<string>()
  reasons.push(...argvReasons(settings.build.argv, admitted, buildInputs))
  for (const check of settings.required_project_checks) reasons.push(...argvReasons(check.argv, admitted, checkInputs))
  if (project.files.some((file) => repositoryPathsOverlap(file.path, settings.build.output_directory))) reasons.push('OUTPUT_OVERLAPS_INPUT')
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)].slice(0, 16) }

  const byPath = new Map(project.files.map((file) => [file.path, file.sha256]))
  const digestOf = (paths: Iterable<string>): Array<[string, string]> => [...new Set(paths)].sort().map((file) => [file, byPath.get(file) ?? ''])
  const configurationInputs = context.protected_inputs.filter((input) => input.kind === 'configuration' || input.kind === 'package' || input.kind === 'entry').map((input) => input.path)
  const testInputs = context.protected_inputs.filter((input) => input.kind === 'test').map((input) => input.path)
  const body = {
    schema_version: PROJECT_SCHEMA_VERSION,
    configuration_id: newProjectUuid(),
    project_id: context.project_id,
    baseline_commit: context.baseline_commit,
    category: PROJECT_CATEGORY,
    entry_path: settings.entry_path,
    target_origin: options.targetOrigin,
    build: settings.build,
    required_project_checks: settings.required_project_checks,
    mandatory_checks: [...MANDATORY_CHECK_IDS],
    inputs: {
      source_tree_sha256: context.admitted_tree_sha256,
      configuration_sha256: projectDigest({ entry_path: settings.entry_path, build: settings.build, inputs: digestOf([...configurationInputs, ...buildInputs]) }),
      checks_sha256: projectDigest({ checks: settings.required_project_checks, inputs: digestOf([...testInputs, ...checkInputs]) }),
      lock_sha256: context.profile.lock_sha256,
    },
    profile: {
      profile_id: PROJECT_PROFILE_ID,
      image_id: profile.imageId,
      dependency_tree_sha256: profile.dependencyTreeSha256,
      manifest_sha256: profile.manifestSha256,
      network: 'none' as const,
      environment_allowlist: [],
      limits: { ...EXECUTION_LIMITS },
      byte_limits: { ...PROFILE_BYTE_LIMITS },
    },
    confirmation: options.confirmedAt === null ? { state: 'pending' as const } : { state: 'confirmed' as const, confirmed_at: options.confirmedAt },
  }
  const configuration = ExecutionConfigurationSchema.safeParse(withConfigurationDigest(body as Parameters<typeof withConfigurationDigest>[0]))
  if (!configuration.success) {
    return { ok: false, reasons: [...new Set(configuration.error.issues.map((issue) => reasonCode(issue.code === 'custom' ? (issue.params as { code?: unknown } | undefined)?.code : issue.code)))].slice(0, 16) }
  }
  return { ok: true, configuration: Object.freeze(configuration.data) }
}
