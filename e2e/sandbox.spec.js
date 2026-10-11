import { test, expect, openApp } from './fixtures.js';

test('parser loads under the Pages subpath and playback steps through a program', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Ready: 3 execution steps')).toBeVisible();
  await expect(page.locator('.next-line-number')).toHaveText('1');

  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.click();
  await next.click();
  await expect(page.getByText('2/3', { exact: true })).toBeVisible();
  await expect(page.locator('.next-line-number')).toHaveText('3');

  const cell = page.locator('.mem-cell').filter({ hasText: 'int' });
  await expect(cell).toHaveCount(1);
  await expect(cell.locator('.val')).toHaveText('10');
  await expect(cell.locator('.memory-address-strip')).toContainText('0x10000000');
});

test('diagram edits are range-checked and generate matching C', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '+ Variable' }).click();

  const value = page.getByRole('spinbutton', { name: 'Value of a' });
  await value.fill('1.5');
  await expect(page.getByRole('status').filter({ hasText: 'whole numbers' })).toHaveText(
    'int values must be whole numbers',
  );

  await value.fill('42');
  await expect(page.locator('.mem-cell .val')).toHaveText('42');

  await page.getByRole('button', { name: 'Generate C' }).click();
  await expect(page.getByText('Generated C from the memory shown.')).toBeVisible();
  const code = page.getByRole('textbox', { name: 'C source code' });
  await expect(code).toHaveValue(/int a;\n\s+a = 42;/);
});

test('generate during playback uses the step on screen', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // Step 1 enters main() before `int a = 10;` runs, so no object exists yet.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Generate C' }).click();
  const code = page.getByRole('textbox', { name: 'C source code' });
  await expect(code).not.toHaveValue(/int a/);
});

test('the inspector overlays the canvas without resizing it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const canvas = page.locator('.react-flow');
  const before = await canvas.boundingBox();
  await page.locator('.mem-cell .name').filter({ hasText: 'a' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspect a' })).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
});
