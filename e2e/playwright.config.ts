import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests for the widget against the plain-html example, served by the
 * real CLI with a scripted offline model (fixtures/scripted-model.mjs). No
 * provider is called and no key is needed. Requires `pnpm build` first — the
 * server runs from `packages/cli/dist` and serves `packages/widget/dist`.
 */
const PORT = 4317

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
    : 'list',
  outputDir: '../test-results',
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // From the example dir, so the widget resolves from its node_modules.
    cwd: '../examples/plain-html',
    command: `node ../../packages/cli/dist/cli.js serve --config ../../e2e/chatbot.config.mjs --static public --port ${PORT} --host 127.0.0.1`,
    url: `http://localhost:${PORT}/api/chat/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
