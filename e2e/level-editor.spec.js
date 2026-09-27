import { test, expect, openApp, openTab } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openTab(page, 'Level editor');
});

test('reference code is visible and the preview renders on first open', async ({ page }) => {
  const editor = page.locator('.editor-code');
  await expect(editor.locator('.code-highlight')).toContainText('int *b = &a;');
  // The overlay textarea must stay transparent or it hides the highlighted code.
  const background = await editor
    .getByRole('textbox', { name: 'C source code' })
    .evaluate(el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor);
  expect(background).toBe('rgba(0, 0, 0, 0)');

  const preview = page.locator('.editor-preview');
  await expect(preview.getByText('main()')).toBeVisible();
  await expect(preview.locator('.mem-cell')).toHaveCount(2);
});

test('a saved level appears in Challenges and can be deleted', async ({ page }) => {
  await page.getByLabel('title').fill('Smoke test level');
  await page.getByRole('button', { name: 'Save level' }).click();
  await expect(page.locator('.saved-row')).toContainText('Smoke test level');

  await openTab(page, 'Challenges');
  await expect(page.getByRole('button', { name: /Smoke test level/ })).toBeVisible();

  await openTab(page, 'Level editor');
  await page.getByRole('button', { name: 'delete' }).click();
  await expect(page.locator('.saved-row')).toHaveCount(0);
});
