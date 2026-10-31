import path from 'node:path'

import { z } from 'zod'

import { containsSecretPattern, isSecretKeyName } from '../evidence/sanitize.js'
import {
  EditingSessionError,
  IMMUTABLE_IMAGE_PATTERN,
  PROFILE_ID_PATTERN,
  WORKSPACE_MOUNT,
  parseEditingSessionRequest,
  resolveSessionLimits,
  validateLimitBounds,
} from './contracts.js'
import type { AgentRuntimeProfile, ResolvedEditingSessionRequest, ResolvedRuntimeProfile } from './contracts.js'

// The trusted runtime-profile registry. Code registers each profile; a session request can only
// name one by ID. Registration copies and freezes the profile, so neither the request nor later
// mutation of the registration input can change the image, argv, environment, or limits that run.

const MAX_ARGV_ENTRIES = 64
const MAX_ARGV_BYTES = 4_096
const MAX_ENVIRONMENT_ENTRIES = 32
const MAX_ENVIRONMENT_VALUE_BYTES = 1_024
const ENVIRONMENT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/
// FlowProof sets the agent home itself; a profile cannot point it at another location.
const RESERVED_ENVIRONMENT_KEYS = new Set(['HOME'])
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'fish'])

const ProfileSchema = z.strictObject({
  id: z.string().max(64).regex(PROFILE_ID_PATTERN),
  imageReference: z.string().regex(IMMUTABLE_IMAGE_PATTERN),
  argv: z
    .array(z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_ARGV_BYTES && !value.includes('\0')))
    .min(1)
    .max(MAX_ARGV_ENTRIES)
    .refine((argv) => (argv[0] ?? '') !== '')
    // Direct argv only: a shell `-c` wrapper would turn the profile into a command string.
    .refine((argv) => !(SHELLS.has(path.posix.basename(argv[0] ?? '')) && argv.slice(1).some((arg) => /^-[a-z]*c[a-z]*$/.test(arg)))),
  environment: z
    .record(
      z.string().regex(ENVIRONMENT_KEY_PATTERN),
      z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_ENVIRONMENT_VALUE_BYTES && !/[\0\r\n]/.test(value)),
    )
    .refine((environment) => Object.keys(environment).length <= MAX_ENVIRONMENT_ENTRIES)
    .refine((environment) =>
      Object.entries(environment).every(
        ([key, value]) => !RESERVED_ENVIRONMENT_KEYS.has(key) && !isSecretKeyName(key) && !containsSecretPattern(`${key}=${value}`),
      ),
    ),
  workingDirectory: z.literal(WORKSPACE_MOUNT),
  limits: z.unknown().optional(),
})

const invalidProfile = (field: string): EditingSessionError =>
  new EditingSessionError('EDITING_PROFILE_INVALID', `The runtime profile is invalid at ${field}.`)

function resolveProfile(input: unknown): ResolvedRuntimeProfile {
  const parsed = ProfileSchema.safeParse(input)
  if (!parsed.success) throw invalidProfile(String(parsed.error.issues[0]?.path[0] ?? 'profile'))
  const value = parsed.data
  return Object.freeze({
    id: value.id,
    imageReference: value.imageReference,
    argv: Object.freeze([...value.argv]),
    environment: Object.freeze({ ...value.environment }),
    workingDirectory: WORKSPACE_MOUNT,
    limits: validateLimitBounds(value.limits),
  })
}

export interface RuntimeProfileRegistry {
  /** Registered profile IDs in registration order. */
  readonly ids: readonly string[]
  /** The frozen registered profile; throws `EDITING_PROFILE_UNKNOWN` for any other ID. */
  resolve(id: string): ResolvedRuntimeProfile
  /**
   * Validates a request structurally, resolves its profile, and fills every omitted limit from
   * the profile's narrowed defaults. Throws before any side effect.
   */
  resolveRequest(request: unknown): ResolvedEditingSessionRequest
}

/** Registers trusted profiles; every profile is validated and frozen at registration. */
export function createRuntimeProfileRegistry(profiles: readonly AgentRuntimeProfile[]): RuntimeProfileRegistry {
  if (!Array.isArray(profiles)) throw invalidProfile('profiles')
  const registered = new Map<string, ResolvedRuntimeProfile>()
  for (const candidate of profiles) {
    const profile = resolveProfile(candidate)
    if (registered.has(profile.id)) throw invalidProfile('id')
    registered.set(profile.id, profile)
  }
  const ids = Object.freeze([...registered.keys()])

  const resolve = (id: string): ResolvedRuntimeProfile => {
    const profile = typeof id === 'string' ? registered.get(id) : undefined
    if (profile === undefined) throw new EditingSessionError('EDITING_PROFILE_UNKNOWN', 'The runtime profile is not registered.')
    return profile
  }

  return Object.freeze({
    ids,
    resolve,
    resolveRequest(input: unknown): ResolvedEditingSessionRequest {
      const request = parseEditingSessionRequest(input)
      const profile = resolve(request.runtimeProfileId)
      const limits = resolveSessionLimits(request.limits, profile.limits)
      return Object.freeze({ request, profile, limits })
    },
  })
}
