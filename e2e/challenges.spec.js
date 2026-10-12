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

  const result = page.locator('.verdict');

  await code.fill('int main() { int x = 7 }');
  await check.click();
  await expect(result).toContainText('Your code doesn’t run');
  await expect(result).toContainText('missing ;');

  await code.fill('int main() { int x = 7; int y = 1; int *p = &y; }');
  await check.click();
  await expect(result).toContainText('Incorrect code');
  await expect(result).toContainText('Attempt 2');
  await expect(result).toContainText('Unexpected variable');
  await code.fill('int main() { int x = 7; int y = 1; }');
  await expect(result).toContainText('Changed since this check');

  await code.fill('int main() { int x = 7; int *p = &x; }');
  await check.click();
  await expect(result).toContainText('Challenge complete!');
  await expect(result).not.toContainText('Attempt');

  await result.getByRole('button', { name: 'Next challenge →' }).click();
  await expect(page.locator('.challenge-head strong')).toHaveText('Pointers move');
  await page.getByRole('button', { name: '← Challenges' }).click();
  await expect(page.locator('.lede')).toHaveText(/^1 of \d+ completed$/);
  await expect(page.getByRole('region', { name: 'Basics' })).toContainText('1 of 5 completed');
  await expect(page.getByRole('button', { name: /Write the arrow/ })).toContainText('Completed');
});

test('arrowheads render while the sandbox, also drawing arrows, stays loaded', async ({ page }) => {
  // The hidden sandbox's canvas comes first in the page. With a shared React Flow ID, every
  // arrow referenced the sandbox's arrowhead <marker>, which does not render while hidden.
  await openApp(page);
  await page
    .getByRole('textbox', { name: 'C source code' })
    // The last statement leaves p's arrow unchanged, so it is drawn in the normal pointer
    // colour (a just-changed arrow is highlighted, and its marker has a different ID).
    .fill('int main(void) {\n    int a = 1;\n    int *p = &a;\n    a = 2;\n}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // Playback opens at step 0; step to the end so the sandbox draws p's arrow.
  const slider = page.getByRole('slider', { name: 'execution step' });
  await slider.fill(await slider.getAttribute('max'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await openTab(page, 'Challenges');
  await page.getByRole('button', { name: /Write the arrow/ }).click();
  await expect(page.locator('.page-host:not([hidden]) .react-flow__edge')).toHaveCount(1);

  const markers = await page
    .locator('.page-host:not([hidden]) .react-flow__edge [marker-end]')
    .evaluateAll(paths =>
      paths.map(path => {
        const id = path.getAttribute('marker-end').match(/url\(['"]?#(.+?)['"]?\)/)[1];
        const marker = path.ownerDocument.getElementById(id);
        return { found: !!marker, visible: !marker?.closest('[hidden]') };
      }),
    );
  expect(markers).toEqual([{ found: true, visible: true }]);
});

test('hints are revealed one at a time, labelled in order', async ({ page }) => {
  await openLevel(page, /Read the arrow/);
  await page.getByRole('button', { name: 'Show hint (2 left)' }).click();
  await expect(page.getByRole('list', { name: 'Hints' })).toContainText('Hint 1 of 2');
  await page.getByRole('button', { name: 'Show hint (1 left)' }).click();
  await expect(page.getByRole('list', { name: 'Hints' })).toContainText('Hint 2 of 2');
  await expect(page.getByRole('button', { name: /Show hint/ })).toHaveCount(0);
});

test('a wrong diagram is reported as an incorrect diagram', async ({ page }) => {
  await openLevel(page, /Read the arrow/);
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.locator('.verdict')).toContainText('Incorrect diagram');
});

test('level cards lay out from the top, whatever their height', async ({ page }) => {
  await openApp(page);
  await openTab(page, 'Challenges');
  await expect(page.getByRole('region', { name: 'Basics' })).toContainText('0 of 5 completed');
  const tops = await page
    .locator('.level-card')
    .evaluateAll(cards =>
      cards.map(
        c => c.querySelector('h3').getBoundingClientRect().top - c.getBoundingClientRect().top,
      ),
    );
  expect(new Set(tops).size).toBe(1);
});

test('the function-call level is solved by drawing what main() is left with', async ({ page }) => {
  await openLevel(page, /Swap, or not/);
  const variable = async (varName, value) => {
    await page.getByRole('button', { name: '+ Variable' }).click();
    const name = page.getByRole('textbox', { name: 'Object name' });
    await name.fill(varName);
    await name.press('Enter');
    await page.getByRole('spinbutton', { name: `Value of ${varName}` }).fill(String(value));
  };
  // swap_values() worked on copies; only swap() changed main()'s variables.
  await variable('a', 1);
  await variable('b', 3);
  await variable('c', 2);
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.locator('.verdict')).toContainText('Challenge complete!');
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
  await expect(page.locator('.verdict')).toContainText('Challenge complete!');
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
    await openApp(page);
    await openTab(page, 'Challenges');
    // Course levels without a section come last, under a generic heading.
    const more = page.getByRole('region', { name: 'More challenges' });
    await expect(more.getByRole('button', { name: /Published level/ })).toBeVisible();
    await expect(page.locator('.level-section').last()).toHaveAttribute(
      'aria-label',
      'More challenges',
    );
    await more.getByRole('button', { name: /Published level/ }).click();
    await expect(page.locator('.challenge-head strong')).toHaveText('Published level');
    await page.getByRole('button', { name: '← Challenges' }).click();
    await expect(page.getByRole('button', { name: /Draft/ })).toHaveCount(0);
  });

  test('a broken course level tells the student to contact the instructor', async ({ page }) => {
    await openLevel(page, /Broken course level/);
    await expect(page.getByText(/no longer runs: .*let your instructor know/)).toBeVisible();
  });
});
