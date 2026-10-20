import { C_KEYWORDS } from './types.js';

/**
 * Lossless C tokenization for display, including incomplete code while typing.
 * Numbers follow the C pp-number rule (C23 6.4.8), so `1e+5`, `0x1p3`, `1'000` and typos
 * like `6int` stay one token; the final `[\s\S]` keeps any other character from being dropped.
 */
export function highlightC(code) {
  const tokens =
    code.match(
      /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|\/\/[^\n]*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|^[\t ]*#[^\n]*|\.?\d(?:[eEpP][+-]|'\w|[\w.])*|[A-Za-z_]\w*|\s+|[^\w\s]|[\s\S]/gm,
    ) ?? [];
  let offset = 0;
  const lines = [[]];
  for (const text of tokens) {
    const kind =
      text.startsWith('/*') || text.startsWith('//')
        ? 'comment'
        : /^\s*#/.test(text)
          ? 'preprocessor'
          : /^["']/.test(text)
            ? 'string'
            : /^\.?\d/.test(text) || text === 'NULL'
              ? 'number'
              : C_KEYWORDS.has(text)
                ? 'keyword'
                : /^[A-Za-z_]\w*$/.test(text) && /^\s*\(/.test(code.slice(offset + text.length))
                  ? 'function'
                  : /^[A-Z][A-Za-z_0-9]*$/.test(text) || text === 'size_t'
                    ? 'type'
                    : 'plain';
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1).push({ text: part, kind });
    });
    offset += text.length;
  }
  return lines;
}
