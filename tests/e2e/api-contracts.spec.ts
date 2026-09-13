import { expect, test } from '@playwright/test';

test.describe('API contracts', () => {
test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Set PLAYWRIGHT_BASE_URL to run API smoke tests against a running app');

test('public unknown ticket types return a standard JSON error', async ({ request }) => {
  const response = await request.get('/api/events/__missing__/ticket-types');
  expect(response.status()).toBe(404);
  await expect(response.json()).resolves.toMatchObject({ success: false, code: 'NOT_FOUND' });
});

test('admin jobs reject anonymous access with a standard JSON error', async ({ request }) => {
  const response = await request.get('/api/admin/jobs');
  expect([401, 404]).toContain(response.status());
  if (response.headers()['content-type']?.includes('application/json')) {
    await expect(response.json()).resolves.toMatchObject({ success: false });
  }
});

test('background worker rejects requests without the cron secret', async ({ request }) => {
  const response = await request.get('/api/cron/jobs');
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ success: false, code: 'AUTHENTICATION_REQUIRED' });
});
});
