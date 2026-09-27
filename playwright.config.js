/**
 * Browser smoke tests. They run against the production build served under the
 * GitHub Pages project path, so base-path and WASM-loading regressions show up
 * here before deployment.
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_PATH = '/cs1010-pointers/';
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build -- --base ${BASE_PATH} && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort --base ${BASE_PATH}`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
