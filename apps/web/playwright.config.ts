import { defineConfig } from '@playwright/test';

// El servidor E2E usa la base `finanzas_test` (no la de desarrollo) en el puerto 3100.
const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:12345@localhost:5432/finanzas_test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3100',
    channel: 'chrome', // usa el Chrome instalado; no descarga navegadores
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    locale: 'es-PY',
  },
  webServer: {
    command: 'pnpm -F server start',
    cwd: '../..',
    url: 'http://localhost:3100/api/me',
    reuseExistingServer: false,
    timeout: 60_000,
    // /api/me devuelve 401 sin sesión: eso ya prueba que el servidor está vivo.
    ignoreHTTPSErrors: true,
    env: { PORT: '3100', DATABASE_URL: E2E_DB, PUBLIC_URL: 'http://localhost:3100', ALLOW_SIGNUP: 'false', LOGIN_RATE_LIMIT: '500' },
  },
});
