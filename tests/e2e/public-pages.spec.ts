import { expect, test } from '@playwright/test';

test.describe('public production pages', () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Set PLAYWRIGHT_BASE_URL to run browser smoke tests');

  test('homepage renders without horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/EventHub/i);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });

  for (const path of ['/admin', '/organizer', '/checkin']) {
    test(`${path} preserves the authentication boundary`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
    });
  }
});
