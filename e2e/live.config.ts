import { defineConfig, devices } from '@playwright/test'

/**
 * `pnpm e2e:live` — the plain-html example in a real browser against a real
 * model. Opt-in, like `pnpm test:live` (docs/04 §10): nothing here runs in
 * `pnpm e2e` or CI. Requires `pnpm build` first.
 *
 * The provider comes from the environment, first match wins:
 *
 *   ANTHROPIC_API_KEY          anthropic, SITEBOT_LIVE_ANTHROPIC_MODEL (default claude-haiku-4-5-20251001)
 *   SITEBOT_LIVE_OLLAMA_MODEL  ollama, e.g. qwen2.5:14b (any model with tool calling)
 *
 * Without either, every test skips and no server starts.
 */
const PORT = 4327

const provider =
  process.env['ANTHROPIC_API_KEY'] !== undefined
    ? {
        SITEBOT_PROVIDER: 'anthropic',
        SITEBOT_MODEL: process.env['SITEBOT_LIVE_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
      }
    : process.env['SITEBOT_LIVE_OLLAMA_MODEL'] !== undefined
      ? { SITEBOT_PROVIDER: 'ollama', SITEBOT_MODEL: process.env['SITEBOT_LIVE_OLLAMA_MODEL'] }
      : undefined

if (provider === undefined) process.env['SITEBOT_LIVE_BROWSER_SKIP'] = '1'

export default defineConfig({
  testDir: './live',
  testMatch: '**/*.live.ts',
  // One model, one conversation at a time: a local model serialises anyway,
  // and a hosted one should not be hammered by a smoke test.
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 120_000 },
  reporter: 'list',
  outputDir: '../test-results/live',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env['SITEBOT_LIVE_CHROME'] === '1' ? { channel: 'chrome' } : {}),
  },
  ...(provider === undefined
    ? {}
    : {
        webServer: {
          cwd: '../examples/plain-html',
          command: `node ../../packages/cli/dist/cli.js serve --config ../../e2e/live/chatbot.live.config.mjs --static public --port ${PORT} --host 127.0.0.1`,
          env: provider,
          url: `http://localhost:${PORT}/api/chat/health`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }),
})
