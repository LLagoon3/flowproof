import { defineConfig } from 'vitest/config'

// The credential-gated live Meta protocol smoke is opt-in. It is excluded from every
// default project and reachable only through the explicit `meta-smoke` project.
const metaSmoke = 'tests/integration/meta-smoke.test.ts'

// The project-live image/schema protocol smoke (Spec 006) is opt-in as well. Every default
// project excludes it, and its `project-meta-smoke` project is registered only when that exact
// name is selected on the command line. A bare `vitest run`, a wildcard, or a negated project
// filter therefore cannot reach it. The manual full-live runner under `tests/manual/` matches no
// project include and stays outside default discovery.
const projectMetaSmoke = 'tests/integration/project-live-meta-smoke.test.ts'
const PROJECT_META_SMOKE = 'project-meta-smoke'

/** True only when `name` is selected verbatim through `--project`/`-p`, not by a pattern. */
function explicitlySelected(name: string, argv: readonly string[] = process.argv): boolean {
  return argv.some((argument, index) => {
    if (argument === `--project=${name}` || argument === `-p=${name}`) return true
    return (argument === '--project' || argument === '-p') && argv[index + 1] === name
  })
}

const liveExcludes = [metaSmoke, projectMetaSmoke]

const defaults = {
  environment: 'node',
  passWithNoTests: true,
  globals: false,
} as const

const liveGateSelected = explicitlySelected(PROJECT_META_SMOKE)

export default defineConfig({
  test: {
    // An explicitly selected live gate whose test file is absent fails instead of passing vacuously.
    passWithNoTests: !liveGateSelected,
    projects: [
      {
        test: {
          ...defaults,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          exclude: liveExcludes,
        },
      },
      {
        test: {
          ...defaults,
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          exclude: liveExcludes,
        },
      },
      {
        test: {
          ...defaults,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: liveExcludes,
        },
      },
      {
        test: {
          ...defaults,
          name: 'ui',
          include: ['tests/ui/**/*.test.ts'],
          exclude: liveExcludes,
        },
      },
      {
        test: {
          ...defaults,
          name: 'meta-smoke',
          include: [metaSmoke],
        },
      },
      ...(liveGateSelected
        ? [
            {
              test: {
                ...defaults,
                name: PROJECT_META_SMOKE,
                include: [projectMetaSmoke],
              },
            },
          ]
        : []),
    ],
  },
})
