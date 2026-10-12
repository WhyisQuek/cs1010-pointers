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

test('the student build has no Level editor', async ({ page }) => {
  await openApp(page);
  const sections = page.getByRole('navigation', { name: 'sections' });
  await expect(sections.getByRole('button')).toHaveText(['Sandbox', 'Challenges']);
});

test.describe('course levels', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/levels/course.json', route =>
      route.fulfill({
        json: [
          {
            id: 'week-1',
            kind: 'diagram-to-code',
            title: 'Published level',
            code: 'int main() { int z = 3; }',
          },
          {
            id: 'week-2',
            kind: 'code-to-diagram',
            title: 'Broken course level',
            code: 'int x = ;',
          },
        ],
      }),
    );
    // Levels saved in this browser are an instructor's drafts; students never see them.
    await page.addInitScript(() => {
      localStorage.setItem(
        'pointerviz.levels',
        JSON.stringify([
          { id: 'custom-1', kind: 'code-to-diagram', title: 'Draft', code: 'int main(){}' },
        ]),
      );
    });
  });

  test('published levels are listed and stored drafts are not', async ({ page }) => {
    await openLevel(page, /Published level/);
    await expect(page.locator('.challenge-head strong')).toHaveText('Published level');
    await page.getByRole('button', { name: '← levels' }).click();
    await expect(page.getByRole('button', { name: /Draft/ })).toHaveCount(0);
  });

  test('a broken course level tells the student to contact the instructor', async ({ page }) => {
    await openLevel(page, /Broken course level/);
    await expect(page.getByText(/no longer runs: .*let your instructor know/)).toBeVisible();
  });
});
