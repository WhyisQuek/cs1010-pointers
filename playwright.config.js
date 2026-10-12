/**
 * Browser smoke tests. They run against the production builds served under the
 * GitHub Pages project path, so base-path and WASM-loading regressions show up
 * here before deployment. `*.instructor.spec.js` files run against the instructor
 * build (with the Level editor); every other spec runs against the student build.
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_PATH = '/cs1010-pointers/';
const STUDENT_PORT = 4173;
const INSTRUCTOR_PORT = 4174;
const url = port => `http://127.0.0.1:${port}${BASE_PATH}`;
const server = (build, outDir, port) => ({
  command: `npm run ${build} -- --base ${BASE_PATH} && npx vite preview --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort --base ${BASE_PATH}`,
  url: url(port),
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
});

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'student',
      testIgnore: /\.instructor\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], baseURL: url(STUDENT_PORT) },
    },
    {
      name: 'instructor',
      testMatch: /\.instructor\.spec\.js$/,
      use: { ...devices['Desktop Chrome'], baseURL: url(INSTRUCTOR_PORT) },
    },
  ],
  webServer: [
    server('build', 'dist', STUDENT_PORT),
    server('build:instructor', 'dist-instructor', INSTRUCTOR_PORT),
  ],
});
