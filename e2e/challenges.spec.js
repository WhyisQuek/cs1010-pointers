import { test, expect, openApp, openTab } from './fixtures.js';

async function openLevel(page, title) {
  await openApp(page);
  await openTab(page, 'Challenges');
  await page.getByRole('button', { name: title }).click();
}

test('a diagram-to-code challenge rejects a wrong answer and accepts a correct one', async ({
  page,
}) => {
  await openLevel(page, /Write the arrow/);
  const code = page.getByRole('textbox', { name: 'C source code' });
  const check = page.getByRole('button', { name: 'Check answer' });

  await code.fill('int main() { int x = 7; int y = 1; int *p = &y; }');
  await check.click();
  await expect(page.getByRole('status').filter({ hasText: 'Not yet' })).toContainText(
    'unexpected variable',
  );

  await code.fill('int main() { int x = 7; int *p = &x; }');
  await check.click();
  await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toContainText(
    'memory states match',
  );
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
  });

  test('a level whose code no longer runs shows an error instead of crashing', async ({ page }) => {
    await openLevel(page, /Broken level/);
    await expect(
      page.getByText(/reference code no longer runs: .*missing identifier/),
    ).toBeVisible();
    await page.getByRole('button', { name: '← levels' }).click();
    await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  });

  test('levels stored with duplicate IDs both load and open independently', async ({ page }) => {
    await openLevel(page, /Duplicate id/);
    await expect(page.getByText('given code (read-only)')).toBeVisible();
    await expect(page.locator('.challenge-head strong')).toHaveText('Duplicate id');
  });
});
