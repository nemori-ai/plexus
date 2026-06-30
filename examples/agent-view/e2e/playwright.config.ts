import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Agent View e2e.
 *
 * Boots the web dev server (in DEMO/replay mode — no backend, no gateway, no LLM)
 * and drives it. The whole spec passes against the local mock session, so it is
 * fully self-contained for CI and the demo.
 */
const PORT = Number(process.env.AGENT_VIEW_PORT ?? 5180);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm --prefix ../web run dev -- --port ' + PORT,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
