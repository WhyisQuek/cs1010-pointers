import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBraceOutdent, newlineWithIndent } from '../src/components/autoIndent.js';

const enterAt = (text, marker = '|') => {
  const pos = text.indexOf(marker);
  const edit = newlineWithIndent(text.replace(marker, ''), pos);
  return edit.text.slice(0, edit.cursor) + '|' + edit.text.slice(edit.cursor);
};

test('Enter keeps the current indentation', () => {
  assert.equal(enterAt('    int x = 1;|'), '    int x = 1;\n    |');
  assert.equal(enterAt('int x;|'), 'int x;\n|');
});

test('Enter after { indents one level', () => {
  assert.equal(enterAt('int main(void) {|'), 'int main(void) {\n    |');
  assert.equal(enterAt('    if (p) {  |'), '    if (p) {  \n        |');
});

test('Enter between braces puts } on its own line', () => {
  assert.equal(enterAt('int main(void) {|}'), 'int main(void) {\n    |\n}');
  assert.equal(enterAt('    while (1) {|}'), '    while (1) {\n        |\n    }');
});

test('Enter mid-line drops leading spaces of the carried text', () => {
  assert.equal(enterAt('    int a; |int b;'), '    int a; \n    |int b;');
});

test('Enter replaces a selection', () => {
  const edit = newlineWithIndent('    abcdef', 6, 8);
  assert.deepEqual(edit, { text: '    ab\n    ef', cursor: 11 });
});

test('} on a blank indented line outdents one level', () => {
  assert.deepEqual(closeBraceOutdent('{\n        ', 10), { text: '{\n    }', cursor: 7 });
  assert.deepEqual(closeBraceOutdent('{\n  ', 4), { text: '{\n}', cursor: 3 });
});

test('} after code or at column 0 is left to the browser', () => {
  assert.equal(closeBraceOutdent('    x = 1;', 10), null);
  assert.equal(closeBraceOutdent('\n', 1), null);
  assert.equal(closeBraceOutdent('    ', 2, 4), null);
});
