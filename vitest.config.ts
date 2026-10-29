import { defineConfig } from 'vitest/config'

// The credential-gated live Meta protocol smoke is opt-in. It is excluded from every
// default project and reachable only through the explicit `meta-smoke` project.
const metaSmoke = 'tests/integration/meta-smoke.test.ts'

const defaults = {
  environment: 'node',
  passWithNoTests: true,
  globals: false,
} as const

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          ...defaults,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...defaults,
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
        },
      },
      {
        test: {
          ...defaults,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: [metaSmoke],
        },
      },
      {
        test: {
          ...defaults,
          name: 'ui',
          include: ['tests/ui/**/*.test.ts'],
        },
      },
      {
        test: {
          ...defaults,
          name: 'meta-smoke',
          include: [metaSmoke],
        },
      },
    ],
  },
})
