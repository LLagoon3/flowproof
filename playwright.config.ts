import { defineConfig } from '@playwright/test'

// FlowProof owns the browser and both local servers: the launcher starts the pinned
// headed Chromium build and the Studio itself. Tests therefore must not request the
// built-in `page`/`browser` fixtures, and no `webServer` is configured here.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // The scenario contract caps a run at `timeouts.total_ms` of 300000.
  timeout: 300_000,
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        headless: false,
      },
    },
  ],
})
