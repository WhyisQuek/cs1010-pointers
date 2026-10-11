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

/** Start offsets of the lines a selection touches; a selection ending at column 0 excludes that line. */
function selectedLineStarts(text, start, end) {
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const starts = [lineStartOf(text, start)];
  for (let i = text.indexOf('\n', starts[0]); i !== -1 && i < last; i = text.indexOf('\n', i + 1))
    starts.push(i + 1);
  return starts;
}

/**
 * Tab with a selection that spans lines indents each of those lines (blank lines stay
 * blank) and keeps them selected. Returns null for a single-line selection, which Tab replaces.
 */
export function indentLines(text, start, end) {
  if (!text.slice(start, end).includes('\n')) return null;
  const starts = selectedLineStarts(text, start, end).filter(
    s => !/^\r?(\n|$)/.test(text.slice(s)),
  );
  let out = text;
  for (const s of [...starts].reverse()) out = out.slice(0, s) + INDENT + out.slice(s);
  const firstShift = starts[0] !== undefined && starts[0] < start ? INDENT.length : 0;
  return {
    text: out,
    selectionStart: start + firstShift,
    selectionEnd: end + INDENT.length * starts.filter(s => s < end).length,
  };
}

/** Shift+Tab removes up to one indent of leading spaces from every line the selection touches. */
export function outdentLines(text, start, end) {
  const removals = selectedLineStarts(text, start, end).map(s => ({
    at: s,
    count: text.slice(s, s + INDENT.length).match(/^ */)[0].length,
  }));
  if (!removals.some(r => r.count)) return null;
  let out = text;
  for (const { at, count } of [...removals].reverse())
    out = out.slice(0, at) + out.slice(at + count);
  // Each position moves left by what was removed before it, but never into the previous line.
  const shift = pos =>
    removals.reduce((n, { at, count }) => n + (at < pos ? Math.min(count, pos - at) : 0), 0);
  return { text: out, selectionStart: start - shift(start), selectionEnd: end - shift(end) };
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
