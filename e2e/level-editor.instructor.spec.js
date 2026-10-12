import { test, expect, openApp, openTab } from './fixtures.js';

async function openEditor(page) {
  await openApp(page);
  await openTab(page, 'Level editor');
}

test('reference code is visible and the preview renders on first open', async ({ page }) => {
  await openEditor(page);
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

test('a saved level appears in Challenges, can be edited, and can be deleted', async ({ page }) => {
  await openEditor(page);
  await page.getByLabel('title').fill('Smoke test level');
  await page.getByRole('button', { name: 'Save level' }).click();
  await expect(page.locator('.saved-row')).toContainText('Smoke test level');

  await openTab(page, 'Challenges');
  await expect(page.getByRole('button', { name: /Smoke test level/ })).toBeVisible();

  await openTab(page, 'Level editor');
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByLabel('title').fill('Renamed level');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.saved-row')).toHaveCount(1);
  await expect(page.locator('.saved-row')).toContainText('Renamed level');

  await page.getByRole('button', { name: 'delete' }).click();
  await expect(page.locator('.saved-row')).toHaveCount(0);
});

test('the level editor refuses a code-to-diagram level students cannot draw', async ({ page }) => {
  await openEditor(page);
  await page.getByLabel('title').fill('Dangling local');
  await page
    .locator('.editor-code')
    .getByRole('textbox', { name: 'C source code' })
    .fill('int main(void) { int *p; { int x = 5; p = &x; } return 0; }');
  await page.getByRole('button', { name: 'Save level' }).click();
  await expect(page.getByRole('alert')).toContainText(
    "students cannot draw this answer in the diagram editor: it needs the out-of-scope variable 'x'",
  );
  await expect(page.locator('.saved-row')).toHaveCount(0);
});

test.describe('stored custom levels', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'pointerviz.levels',
        JSON.stringify([
          {
            id: 'custom-1',
            kind: 'code-to-diagram',
            title: 'Broken level',
            code: 'int main() { int x = ; }',
          },
          {
            id: 'custom-1',
            kind: 'code-to-diagram',
            title: 'Duplicate id',
            code: 'int main() { int y = 2; }',
          },
        ]),
      );
    });
    await openApp(page);
    await openTab(page, 'Challenges');
  });

  test('a level whose code no longer runs shows an error instead of crashing', async ({ page }) => {
    await page.getByRole('button', { name: /Broken level/ }).click();
    await expect(
      page.getByText(/reference code no longer runs: .*missing identifier.*Level editor/),
    ).toBeVisible();
    await page.getByRole('button', { name: '← levels' }).click();
    await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  });

  test('levels stored with duplicate IDs both load and open independently', async ({ page }) => {
    await page.getByRole('button', { name: /Duplicate id/ }).click();
    await expect(page.getByText('given code (read-only)')).toBeVisible();
    await expect(page.locator('.challenge-head strong')).toHaveText('Duplicate id');
  });
});
