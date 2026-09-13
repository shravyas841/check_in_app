import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  // The application requires Clerk middleware and PostgreSQL locally. Set
  // PLAYWRIGHT_BASE_URL in CI or against a running deployment to enable this suite.
  webServer: undefined,
});
