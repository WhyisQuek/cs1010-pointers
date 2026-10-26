import { test, expect, openApp, openTab } from './fixtures.js';

const code = page => page.getByRole('textbox', { name: 'C source code' });
const tab = page => page.getByRole('navigation', { name: 'sections' });

test('a first visit opens Start here, and later visits open the Sandbox', async ({ page }) => {
  await page.goto('./');
  await expect(
    page.getByRole('heading', { name: 'See what your C code does to memory' }),
  ).toBeVisible();
  await expect(tab(page).getByRole('button', { name: 'Start here' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const img of await page.locator('.tutorial-shot').all()) {
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveJSProperty('complete', true);
    expect(await img.evaluate(i => i.naturalWidth)).toBeGreaterThan(0);
  }

  await page.reload();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
});

test('Try it loads an example into the Sandbox and runs it', async ({ page }) => {
  await openApp(page);
  await openTab(page, 'Start here');
  await page.getByRole('button', { name: /Swap with pointers/ }).click();
  await expect(code(page)).toHaveValue(/void swap\(int \*a, int \*b\)/);
  await expect(page.getByText(/^Ready: \d+ execution steps/)).toBeVisible();
  // Into main, then over int x = 1;
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  await page.getByRole('button', { name: 'Step over', exact: true }).click();
  await expect(page.locator('.mem-cell')).toHaveCount(1);

  // The bug example stops with an error, partway through.
  await openTab(page, 'Start here');
  await page.getByRole('button', { name: /Spot the bug/ }).click();
  await expect(page.getByText(/^Stopped at step \d+\. Undefined behavior/)).toBeVisible();
});

test('Try it asks before replacing the student’s own code', async ({ page }) => {
  await openApp(page);
  await code(page).fill('int main(void) {\n    int mine = 1;\n}');
  await openTab(page, 'Start here');

  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: /Walk an array/ }).click();
  await expect(page.getByRole('heading', { name: 'Try it' })).toBeVisible();
  await openTab(page, 'Sandbox');
  await expect(code(page)).toHaveValue(/int mine = 1;/);

  await openTab(page, 'Start here');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Walk an array/ }).click();
  await expect(code(page)).toHaveValue(/int arr\[4\]/);
});
