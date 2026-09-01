import { expect, test, type Page } from '@playwright/test';

function observeFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    failures.push(`request: ${request.method()} ${request.url()} · ${request.failure()?.errorText ?? 'failed'}`);
  });
  return failures;
}

test('keeps the synthetic sandbox separate from native machine evidence', async ({ page, request }) => {
  const healthResponse = await request.get('/api/health');
  expect(healthResponse.ok()).toBe(true);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  expect(health).toMatchObject({ evidenceScope: 'sandbox', nativeIngestEnabled: false });
  expect(JSON.stringify(health)).not.toMatch(/\/(?:Users|home)\//);

  const overviewResponse = await request.get('/api/overview');
  expect(overviewResponse.ok()).toBe(true);
  await expect(overviewResponse.json()).resolves.toMatchObject({ dataPath: '.flight-recorder-demo/recorder.db' });

  expect((await request.post('/api/scan')).status()).toBe(403);
  expect((await request.post('/api/hooks/compatible/session.start', { data: { sessionId: 'private' } })).status()).toBe(403);

  await page.goto('/');
  await expect(page.locator('[data-app-ready="true"]')).toBeVisible();
  await expect(page.getByText('ISOLATED SANDBOX / SYNTHETIC DATA')).toBeVisible();
  await expect(page.getByRole('button', { name: 'SANDBOX LOCKED' })).toBeDisabled();
});

test('replays the deterministic repair with diff, retry, and comparison evidence', async ({ page }) => {
  const failures = observeFailures(page);
  await page.goto('/');
  await expect(page.locator('[data-app-ready="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AGENT FLIGHT RECORDER' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checkout race repaired and verified' })).toBeVisible();
  await expect(page.locator('.session-card')).toHaveCount(2);

  await page.getByRole('button', { name: /Files/ }).click();
  await page.getByRole('button', { name: /Timeout settlement patched/ }).click();
  await expect(page.getByRole('heading', { name: 'CODE EVOLUTION' })).toBeVisible();
  await expect(page.locator('.snapshot-card')).toHaveCount(2);
  await expect(page.locator('.diff-view')).toContainText('const deadline = Date.now() + timeoutMs');

  await page.getByLabel('COMPARE TARGET').selectOption('demo:checkout-regression');
  await expect(page.getByText('TARGET Δ')).toBeVisible();
  await expect(page.locator('.comparison-strip')).toContainText('Checkout timeout reproduced');

  await page.getByRole('button', { name: /All signals/ }).click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.event-row[aria-current="true"]')).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  expect(failures).toEqual([]);
});

test('keeps the primary replay usable on a phone-sized viewport', async ({ page }) => {
  const failures = observeFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-app-ready="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checkout race repaired and verified' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Timeline/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Flights/ }).click();
  await expect(page.getByRole('heading', { name: 'RECORDED FLIGHTS' })).toBeVisible();
  await page.getByRole('button', { name: /Checkout race repaired and verified/ }).click();
  await expect(page.getByRole('button', { name: /Timeline/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Tests/ }).click();
  await expect(page.getByRole('button', { name: /Checkout regression suite passed/ })).toBeVisible();
  await page.getByRole('button', { name: /Checkout regression suite passed/ }).click();
  await expect(page.getByRole('button', { name: /Evidence/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'ATTEMPT LINEAGE' })).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
  expect(failures).toEqual([]);
});
