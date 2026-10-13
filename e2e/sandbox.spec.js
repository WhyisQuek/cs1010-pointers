import { test, expect, openApp, openTab } from './fixtures.js';

const code = page => page.getByRole('textbox', { name: 'C source code' });

test('a runtime error opens playback at the step where execution stopped', async ({ page }) => {
  await openApp(page);
  await code(page).fill('int main(void) {\n    int a = 1;\n    int *p = NULL;\n    *p = 2;\n}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(
    page.getByText(/^Stopped at step 4\. Undefined behavior: cannot dereference null pointer/),
  ).toBeVisible();
  await expect(page.getByText('4/4', { exact: true })).toBeVisible();
  await expect(page.getByText('Stopped by an error')).toBeVisible();
  await expect(page.locator('.next-line-number.error-line')).toHaveText('4');
  await expect(page.locator('.mem-cell')).toHaveCount(2);

  // Earlier steps are still there.
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('3/4', { exact: true })).toBeVisible();
  await expect(page.getByText('Stopped by an error')).toBeHidden();
});

test('a freed block can be moved, marked not freed, deleted, and undone with buttons', async ({
  page,
}) => {
  await openApp(page);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const banner = page.locator('.lifetime-banner');
  const cell = page.locator('.mem-cell');
  await expect(undo).toBeDisabled();

  await page.getByRole('button', { name: '+ Heap block' }).click();
  await page.getByRole('button', { name: 'Mark as freed' }).click();
  await expect(banner).toHaveText('freed');

  // Freed blocks are still draggable.
  const before = await cell.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + 90, { steps: 8 });
  await page.mouse.up();
  const after = await cell.boundingBox();
  expect(Math.round(after.x - before.x)).toBeGreaterThan(60);

  await cell.locator('.name').click();
  await page.getByRole('button', { name: 'Mark as not freed' }).click();
  await expect(page.getByText(/^Diagram edit: this block is allocated again/)).toBeVisible();
  await expect(banner).toHaveCount(0);

  await undo.click();
  await expect(banner).toHaveText('freed');
  await redo.click();
  await expect(banner).toHaveCount(0);
  await undo.click();

  await cell.locator('.name').click();
  await page.getByRole('button', { name: 'Delete object' }).click();
  await expect(cell).toHaveCount(0);
  await undo.click();
  await expect(banner).toHaveText('freed');
});

test('Tab and Shift+Tab indent and outdent every selected line', async ({ page }) => {
  await openApp(page);
  await code(page).fill('a;\nb;\nc;');
  await code(page).evaluate(el => el.setSelectionRange(0, 4));
  await code(page).press('Tab');
  await expect(code(page)).toHaveValue('    a;\n    b;\nc;');
  await code(page).press('Shift+Tab');
  await expect(code(page)).toHaveValue('a;\nb;\nc;');
});

test('typing a value is one undo step', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '+ Variable' }).click();
  await page.getByRole('spinbutton', { name: 'Value of a' }).pressSequentially('123');
  await expect(page.locator('.mem-cell .val')).toHaveText('123');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.mem-cell .val')).toHaveText('?');
  await expect(page.locator('.mem-cell')).toHaveCount(1);
});

test('the sandbox draft survives a reload', async ({ page }) => {
  await openApp(page);
  await code(page).fill('int main(void) {\n    int saved = 1;\n}');
  await page.getByRole('button', { name: '+ Variable' }).click();
  await page.getByRole('spinbutton', { name: 'Value of a' }).fill('42');
  await expect(page.locator('.mem-cell .val')).toHaveText('42');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(code(page)).toHaveValue(/int saved = 1;/);
  await expect(page.locator('.mem-cell .val')).toHaveText('42');
  await expect(
    page.getByText('Restored your code and diagram from your last visit.'),
  ).toBeVisible();
});

test('a corrupt stored draft is ignored', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'pointerviz.sandbox.v1',
      JSON.stringify({ code: 'int main(void) {}', diagram: { allocations: [{}], frames: [] } }),
    ),
  );
  await page.reload();
  await expect(code(page)).toHaveValue('int main(void) {}');
  await expect(page.locator('.mem-cell')).toHaveCount(0);
});

test('the sandbox keeps its work across tab switches', async ({ page }) => {
  await openApp(page);
  await code(page).fill('int main(void) {\n    int kept = 5;\n}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const counter = page.locator('.stepper span');
  const position = await counter.textContent();
  expect(position).toMatch(/^2\/\d+$/);

  await openTab(page, 'Challenges');
  await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  await openTab(page, 'Sandbox');

  await expect(code(page)).toHaveValue(/int kept = 5;/);
  await expect(counter).toHaveText(position);
  await expect(page.locator('.mem-cell .name')).toHaveText('kept');
});

test('diagram edits, freeing and clearing can be undone and redone', async ({ page }) => {
  await openApp(page);
  const cells = page.locator('.mem-cell');

  await page.getByRole('button', { name: '+ Variable' }).click();
  await page.getByRole('button', { name: 'Delete object' }).click();
  await expect(page.getByText('Deleted a. Ctrl+Z undoes it.')).toBeVisible();
  await expect(cells).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(cells).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(cells).toHaveCount(0);
  await page.keyboard.press('Control+z');

  await page.getByRole('button', { name: '+ Heap block' }).click();
  await page.getByRole('button', { name: 'Mark as freed' }).click();
  await expect(page.locator('.lifetime-banner')).toHaveText('freed');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.lifetime-banner')).toHaveCount(0);

  // The top-right corner of the canvas is empty once the inspector is closed.
  await page.keyboard.press('Escape');
  const pane = page.locator('.react-flow__pane');
  const { width } = await pane.boundingBox();
  await pane.click({ button: 'right', position: { x: width - 30, y: 30 } });
  await page.getByRole('menuitem', { name: 'Clear diagram' }).click();
  await expect(cells).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(cells).toHaveCount(2);
});

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
  await expect(cell.locator('.mem-meta')).toContainText('0x10000000');
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

test('reserved variable names are refused in the inspector', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '+ Variable' }).click();
  const name = page.getByRole('textbox', { name: 'Object name' });
  await name.fill('NULL');
  await name.press('Enter');
  await expect(page.getByText("Name not changed: 'NULL' is reserved")).toBeVisible();
  await expect(name).toHaveValue('a');
  await expect(page.locator('.mem-cell .name')).toHaveText('a');
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

test('View switches between addresses, arrows and both, and is remembered', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '+ Variable' }).click();
  await page.getByRole('button', { name: '+ Variable' }).click();
  await page.getByRole('combobox', { name: 'Pointer depth' }).selectOption('1');
  // Options: Uninitialized, NULL, then a's targets.
  await page.getByRole('combobox', { name: 'Target of b' }).selectOption({ index: 2 });
  const edges = page.locator('.react-flow__edge');
  const cardB = page.locator('.mem-cell').filter({ hasText: 'int *' });
  const chooseView = async label => {
    await page.getByRole('button', { name: /^View:/ }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  };
  await expect(edges).toHaveCount(1);
  await expect(cardB.locator('.pointer-value')).toHaveText('0x10000000');
  const box = await cardB.boundingBox();

  await chooseView('Arrows');
  await expect(cardB.locator('.pointer-value')).toHaveText('●');
  await expect(cardB.locator('.pointer-caption')).toHaveText('→ a');
  await expect(page.locator('.mem-meta code')).toHaveCount(0);
  await expect(edges).toHaveCount(1);
  expect(await cardB.boundingBox()).toEqual(box);

  await chooseView('Addresses');
  await expect(cardB.locator('.pointer-value')).toHaveText('0x10000000');
  // The selected pointer keeps its arrow; deselecting hides it.
  await expect(edges).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(edges).toHaveCount(0);
  await cardB.locator('.name').click();
  await expect(edges).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole('button', { name: 'View: Addresses ▾' })).toBeVisible();
  await chooseView('Both');
  await expect(edges).toHaveCount(1);
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
