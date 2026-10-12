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

test('the function-call level is solved by drawing what main() is left with', async ({ page }) => {
  await openLevel(page, /A function call/);
  await page.getByRole('button', { name: '+ Variable' }).click();
  const name = page.getByRole('textbox', { name: 'Object name' });
  await name.fill('value');
  await name.press('Enter');
  await page.getByRole('spinbutton', { name: 'Value of value' }).fill('25');
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toBeVisible();
});

test('the struct level is solved by drawing struct objects', async ({ page }) => {
  await openLevel(page, /Linked structure/);
  const select = label => page.getByRole('combobox', { name: label });
  const makeNode = async (name, value) => {
    await page.getByRole('button', { name: '+ Variable' }).click();
    const box = page.getByRole('textbox', { name: 'Object name' });
    await box.fill(name);
    await box.press('Enter');
    await select('Object base type').selectOption({ label: 'struct Node' });
    await select('Inspect object or member').selectOption({ label: '.value' });
    await page.getByRole('spinbutton', { name: `Value of ${name}.value` }).fill(String(value));
    await select('Inspect object or member').selectOption({ label: '.next' });
  };
  await makeNode('a', 1);
  await select('Target of a.next').selectOption('null');
  await makeNode('b', 2);
  // The option for the whole struct a reads "a · <address>".
  const toA = await select('Target of b.next')
    .locator('option', { hasText: /^a · / })
    .getAttribute('value');
  await select('Target of b.next').selectOption(toA);
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toBeVisible();
});

test('the level editor refuses a code-to-diagram level students cannot draw', async ({ page }) => {
  await openApp(page);
  await openTab(page, 'Level editor');
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
