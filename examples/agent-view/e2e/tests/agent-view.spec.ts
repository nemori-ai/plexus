import { test, expect } from '@playwright/test';

/**
 * Agent View e2e — drives the app in DEMO/replay mode (the local mock session).
 * No backend, no gateway, no LLM. Asserts the Plexus lifecycle is made visible:
 *
 *   1. an assistant message renders (streaming chat works)
 *   2. a ToolCallCard shows the grant-pending HUMAN-APPROVAL gate, which then
 *      resolves to a result carrying an auditId
 *   3. the Capabilities panel lists discovered capabilities
 *   4. the Orchestration DAG renders nodes
 */

test('demo replay renders the full Plexus invoke lifecycle', async ({ page }) => {
  await page.goto('/');

  // demo mode is the default; confirm the toggle is present and send a prompt
  await expect(page.getByTestId('mode-demo')).toBeVisible();
  await page.getByTestId('composer-input').fill('Build the 番茄喵 pomodoro app');
  await page.getByTestId('composer-send').click();

  // (1) an assistant message renders
  await expect(page.getByTestId('assistant-message').first()).toBeVisible();

  // (3) capabilities discovered + listed
  await expect(page.getByTestId('capability-row').first()).toBeVisible();
  expect(await page.getByTestId('capability-row').count()).toBeGreaterThanOrEqual(3);

  // (2a) the human-approval gate becomes visible and WAITS
  const gate = page.getByTestId('grant-gate').first();
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Waiting for you to approve in Plexus');

  // a tool-call card is in the grant_pending state while the gate is shown
  await expect(page.locator('[data-testid="tool-call-card"][data-status="grant_pending"]').first()).toBeVisible();

  // (2b) it resolves to a completed result carrying an auditId
  const auditId = page.getByTestId('audit-id').first();
  await expect(auditId).toBeVisible();
  await expect(auditId).toContainText('audit ·');

  // (4) the orchestration DAG renders nodes
  await expect(page.getByTestId('orchestration-board')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(3);

  // a final ok result with a green audit chip is present (audited result story)
  await expect(page.locator('[data-testid="tool-call-card"][data-status="ok"]').first()).toBeVisible();
});

test('light-mode toggle flips the theme on the document root', async ({ page }) => {
  await page.goto('/');

  // default is dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // toggle → light; the ground surface should lighten
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // toggle back → dark
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('GRAPH view renders nodes for both the capability map and the activity flow', async ({ page }) => {
  await page.goto('/');

  // run the demo so capabilities + invokes exist
  await page.getByTestId('composer-input').fill('Build the 番茄喵 pomodoro app');
  await page.getByTestId('composer-send').click();

  // let the whole replay finish so all invokes are in the store (the agent-state
  // rail is mounted in both views, so this phase marker survives the view switch)
  await expect(page.locator('[data-testid="agent-phase"][data-phase="done"]')).toBeVisible();

  // switch to GRAPH view
  await page.getByTestId('view-graph').click();
  await expect(page.getByTestId('graph-view')).toBeVisible();

  // (1) capability map (default tab) renders source + capability nodes
  await expect(page.getByTestId('capability-graph')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('cap-graph-node').first()).toBeVisible();

  // (2) activity flow renders one node per invoke (+ the session/discover root)
  await page.getByTestId('graph-tab-activity').click();
  await expect(page.getByTestId('activity-graph')).toBeVisible();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByTestId('activity-graph-node').first()).toBeVisible();
  expect(await page.getByTestId('activity-graph-node').count()).toBeGreaterThanOrEqual(2);
});
