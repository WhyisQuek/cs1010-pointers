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
  await page.getByRole('button', { name: 'Step back', exact: true }).click();
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
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  const counter = page.locator('.step-count');
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

  const next = page.getByRole('button', { name: 'Step into', exact: true });
  await next.click();
  await next.click();
  await expect(page.getByText('2/3', { exact: true })).toBeVisible();
  await expect(page.locator('.next-line-number')).toHaveText('3');

  const cell = page.locator('.mem-cell').filter({ hasText: 'int' });
  await expect(cell).toHaveCount(1);
  await expect(cell.locator('.val')).toHaveText('10');
  await expect(cell.locator('.mem-meta')).toContainText('0x10000000');
});

test('step over skips a call, and step out returns from one', async ({ page }) => {
  await openApp(page);
  await code(page).fill(
    'int twice(int n) {\n    int t = n * 2;\n    return t;\n}\nint main(void) {\n    int a = twice(4);\n    int b = a;\n    return 0;\n}',
  );
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const button = name => page.getByRole('button', { name, exact: true });
  const line = page.locator('.next-line-number');

  await button('Step into').click();
  await expect(line).toHaveText('6');
  await expect(button('Step out')).toBeDisabled();
  await button('Step over').click();
  await expect(line).toHaveText('7');

  // Stepping back lands on the call site, just after twice() returned.
  await button('Step back').click();
  await expect(line).toHaveText('6');

  await page.getByRole('slider', { name: 'execution step' }).fill('1');
  await page.keyboard.press('F11');
  await expect(line).toHaveText('2');
  await expect(button('Step out')).toBeEnabled();
  await button('Step out').click();
  await expect(line).toHaveText('6');
  await expect(button('Step out')).toBeDisabled();

  await page.keyboard.press('F10');
  await expect(line).toHaveText('7');
});

test('breakpoints, continue, reverse stepping and the call stack', async ({ page }) => {
  await openApp(page);
  await code(page).fill(
    'int twice(int n) {\n    int t = n * 2;\n    return t;\n}\nint main(void) {\n    int a = twice(4);\n    int b = twice(a);\n    return 0;\n}',
  );
  const button = name => page.getByRole('button', { name, exact: true });
  const line = page.locator('.next-line-number');
  const stack = page.getByRole('group', { name: 'Call stack' });

  // Breakpoints are set in the gutter, or with F9 on the editor's cursor line.
  await button('Breakpoint on line 2').click();
  await expect(button('Breakpoint on line 2')).toHaveAttribute('aria-pressed', 'true');
  await code(page).evaluate(el =>
    el.setSelectionRange(el.value.indexOf('int b'), el.value.indexOf('int b')),
  );
  await code(page).press('F9');
  await expect(button('Breakpoint on line 7')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await button('Continue').click();
  await expect(line).toHaveText('2');
  await expect(stack).toHaveText(/main\(\).*twice\(\)/);
  await button('Continue').click();
  await expect(line).toHaveText('7');
  await expect(stack).toHaveText('Call stackmain()');
  await page.keyboard.press('F8');
  await expect(line).toHaveText('2');

  // Clicking main() in the call stack runs until twice() returns to it.
  await stack.getByRole('button', { name: 'main()' }).click();
  await expect(line).toHaveText('7');

  // Holding Shift turns the commands around.
  await page.keyboard.down('Shift');
  await expect(button('Reverse continue')).toBeVisible();
  await button('Reverse continue').click();
  await page.keyboard.up('Shift');
  await expect(line).toHaveText('2');
  // Back out of twice(a) to just before it is called, then back over twice(4).
  await button('Step out').click({ modifiers: ['Shift'] });
  await expect(line).toHaveText('7');
  await expect(stack).toHaveText('Call stackmain()');
  await page.keyboard.press('Shift+F10');
  await expect(line).toHaveText('6');
  await expect(page.locator('.step-count')).toHaveText(/^1\//);

  // Editing above a breakpoint moves it with its line.
  await code(page).evaluate(el => el.setSelectionRange(0, 0));
  await code(page).press('Enter');
  await expect(button('Breakpoint on line 3')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('Breakpoint on line 8')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('Breakpoint on line 2')).toHaveAttribute('aria-pressed', 'false');
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
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
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
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  const canvas = page.locator('.react-flow');
  const before = await canvas.boundingBox();
  await page.locator('.mem-cell .name').filter({ hasText: 'a' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspect a' })).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
});

test('Escape then Tab leaves the code editor; Tab alone indents', async ({ page }) => {
  await openApp(page);
  const editor = code(page);
  await editor.fill('int main(void) {}');
  await editor.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(editor).toHaveValue('    int main(void) {}');
  await page.keyboard.press('Shift+Tab');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAccessibleDescription(/Press Escape, then Tab, to leave the editor/);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue('int main(void) {}');

  await editor.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Tab');
  await expect(editor).not.toBeFocused();
});

test('editing code during playback keeps the step on screen and says why playback ended', async ({
  page,
}) => {
  await openApp(page);
  await code(page).fill('int main(void) {\n    int a = 1;\n    a = 2;\n    return 0;\n}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  await page.getByRole('button', { name: 'Step into', exact: true }).click();
  await expect(page.locator('.mem-cell .val')).toHaveText('1');

  await code(page).press('End');
  await code(page).pressSequentially(' // edited');
  await expect(
    page.getByText(/^Code changed, so playback ended\. The diagram still shows step 2/),
  ).toBeVisible();
  await expect(page.locator('.mem-cell .val')).toHaveText('1');
  await expect(page.locator('.step-count')).toHaveCount(0);
});
