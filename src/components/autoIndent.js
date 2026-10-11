/** Pure text edits behind the C editor's vim-style auto-indent. Each returns { text, cursor } or null. */
export const INDENT = '    ';

const lineStartOf = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;

/**
 * Enter keeps the current line's indentation, adds a level after `{`, and when the
 * cursor sits between `{` and `}` pushes the brace onto its own line at the outer level.
 */
export function newlineWithIndent(text, start, end = start) {
  const lineStart = lineStartOf(text, start);
  const base = text.slice(lineStart, start).match(/^[ \t]*/)[0];
  const before = text.slice(lineStart, start).trimEnd();
  const after = text.slice(end).match(/^[ \t]*/)[0];
  const rest = text.slice(end + after.length);
  const opens = before.endsWith('{');
  const indent = opens ? base + INDENT : base;
  let insert = '\n' + indent;
  const cursor = start + insert.length;
  if (opens && rest.startsWith('}')) insert += '\n' + base;
  return { text: text.slice(0, start) + insert + rest, cursor };
}

/** Typing `}` on a whitespace-only line drops one indent level so the brace lines up with its block. */
export function closeBraceOutdent(text, start, end = start) {
  const lineStart = lineStartOf(text, start);
  const prefix = text.slice(lineStart, start);
  if (start !== end || !prefix || /[^ ]/.test(prefix)) return null;
  const keep = prefix.slice(0, Math.max(0, prefix.length - INDENT.length));
  return {
    text: text.slice(0, lineStart) + keep + '}' + text.slice(end),
    cursor: lineStart + keep.length + 1,
  };
}
