/** Shared test fixture: every test fails on console errors, page errors or failed requests. */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', msg => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('response', response => {
      if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await use(page);
    expect(problems, 'browser reported problems').toEqual([]);
  },
});

export { expect };

/** Open the app and wait until the C parser (both WASM files) has loaded. */
export async function openApp(page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Run →' })).toBeVisible();
}

export async function openTab(page, name) {
  await page.getByRole('navigation', { name: 'sections' }).getByRole('button', { name }).click();
}
