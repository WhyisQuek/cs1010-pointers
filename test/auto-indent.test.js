import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeBraceOutdent,
  indentLines,
  newlineWithIndent,
  outdentLines,
} from '../src/components/autoIndent.js';

/** Apply an edit to text whose selection is marked with [ and ]; show the result the same way. */
const onSelection = (edit, marked) => {
  const start = marked.indexOf('['),
    end = marked.indexOf(']') - 1;
  const result = edit(marked.replace('[', '').replace(']', ''), start, end);
  if (!result) return null;
  const { text, selectionStart: s, selectionEnd: e } = result;
  return `${text.slice(0, s)}[${text.slice(s, e)}]${text.slice(e)}`;
};

test('Tab indents every selected line and keeps them selected', () => {
  assert.equal(onSelection(indentLines, 'a;\nb[c;\nd]e;\nf;'), 'a;\n    b[c;\n    d]e;\nf;');
  // From column 0, the new indentation is inside the selection.
  assert.equal(onSelection(indentLines, '[x;\ny;]'), '[    x;\n    y;]');
  // A selection ending at column 0 leaves that line alone; blank lines stay blank.
  assert.equal(onSelection(indentLines, '[x;\n\ny;\n]z;'), '[    x;\n\n    y;\n]z;');
});

test('Tab within one line is left to the single-line insert', () => {
  assert.equal(onSelection(indentLines, 'int [abc] = 1;'), null);
});

test('Shift+Tab outdents every selected line by up to one level', () => {
  assert.equal(onSelection(outdentLines, '        a[;\n  b;\nc]d;'), '    a[;\nb;\nc]d;');
  // A selection start inside removed spaces moves to the line start, not the previous line.
  assert.equal(onSelection(outdentLines, '  [  x;\n    y;]'), '[x;\ny;]');
  assert.equal(onSelection(outdentLines, '[x;\ny;]'), null);
});

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
