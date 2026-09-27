import { test, expect, openApp } from './fixtures.js';

test('parser loads under the Pages subpath and playback steps through a program', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Run →' }).click();
  await expect(page.getByText('Ready: 3 execution steps')).toBeVisible();
  await expect(page.getByText('Next: line 1')).toBeVisible();

  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.click();
  await next.click();
  await expect(page.getByText('2/3')).toBeVisible();
  await expect(page.getByText('Next: line 3')).toBeVisible();

  const cell = page.locator('.mem-cell').filter({ hasText: 'int' });
  await expect(cell).toHaveCount(1);
  await expect(cell.locator('.val')).toHaveText('10');
  await expect(cell.locator('.memory-address-strip')).toContainText('0x10000000');
});

test('diagram edits are range-checked and generate matching C', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Add stack object' }).click();

  const value = page.getByRole('spinbutton', { name: 'Value of a' });
  await value.fill('1.5');
  await expect(page.getByRole('status').filter({ hasText: 'whole numbers' })).toHaveText(
    'int values must be whole numbers',
  );

  await value.fill('42');
  await expect(page.locator('.mem-cell .val')).toHaveText('42');

  await page.getByRole('button', { name: '← Generate' }).click();
  await expect(page.getByText('Generated C from the current memory state.')).toBeVisible();
  const code = page.getByRole('textbox', { name: 'C source code' });
  await expect(code).toHaveValue(/int a;\n\s+a = 42;/);
});
