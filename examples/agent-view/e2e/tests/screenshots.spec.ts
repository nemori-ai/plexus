import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Screenshot harness — captures the new features (light mode + the two graphs)
 * against the demo/mock session, into web/public/screenshots/features/. Not a
 * pass/fail spec; run explicitly: `npx playwright test screenshots`.
 */

const OUT = path.resolve(__dirname, '../../web/public/screenshots/features');
const shot = (name: string) => path.join(OUT, name);

test.use({ viewport: { width: 1480, height: 920 } });

async function runDemo(page: import('@playwright/test').Page) {
  await page.getByTestId('composer-input').fill('Build the 番茄喵 pomodoro app');
  await page.getByTestId('composer-send').click();
}

test('capture light-mode (list view)', async ({ page }) => {
  await page.goto('/');
  await runDemo(page);
  await page.locator('[data-testid="agent-phase"][data-phase="done"]').waitFor();
  await page.getByTestId('theme-toggle').click(); // → light
  await page.waitForTimeout(600); // let the dimming transition settle
  await page.screenshot({ path: shot('light-mode.png') });
});

test('capture graph-capabilities (dark)', async ({ page }) => {
  await page.goto('/');
  await runDemo(page);
  await page.locator('[data-testid="agent-phase"][data-phase="done"]').waitFor();
  await page.getByTestId('view-graph').click();
  await page.getByTestId('capability-graph').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('graph-capabilities.png') });
});

test('capture graph-capabilities (light)', async ({ page }) => {
  await page.goto('/');
  await runDemo(page);
  await page.locator('[data-testid="agent-phase"][data-phase="done"]').waitFor();
  await page.getByTestId('theme-toggle').click(); // → light
  await page.getByTestId('view-graph').click();
  await page.getByTestId('capability-graph').waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot('graph-capabilities-light.png') });
});

test('capture graph-activity (mid-flight, parallel branch)', async ({ page }) => {
  await page.goto('/');
  await runDemo(page);
  // jump into the activity graph early and watch it populate live
  await page.getByTestId('view-graph').click();
  await page.getByTestId('graph-tab-activity').click();
  // wait until the parallel pair (c3 + c4) has both entered the flow so the
  // fork/rejoin branch is visible; grab it while a node is still in-progress
  await page.locator('[data-testid="activity-graph-node"]').nth(3).waitFor();
  await page.waitForTimeout(120); // let fitView reframe; stop before they all complete
  await page.screenshot({ path: shot('graph-activity.png') });
});

test('capture graph-activity (completed)', async ({ page }) => {
  await page.goto('/');
  await runDemo(page);
  await page.locator('[data-testid="agent-phase"][data-phase="done"]').waitFor();
  await page.getByTestId('view-graph').click();
  await page.getByTestId('graph-tab-activity').click();
  await page.getByTestId('activity-graph').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('graph-activity-done.png') });
});
