import { C_KEYWORDS } from './types.js';

/** Lossless C tokenization for display, including incomplete code while typing. */
export function highlightC(code) {
  const tokens = code.match(/\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|\/\/[^\n]*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|^[\t ]*#[^\n]*|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)[uUlLfF]*\b|[A-Za-z_]\w*|\s+|[^\w\s]/gm) ?? [];
  let offset = 0;
  const lines = [[]];
  for (const text of tokens) {
    const kind = text.startsWith('/*') || text.startsWith('//') ? 'comment'
      : /^\s*#/.test(text) ? 'preprocessor'
      : /^["']/.test(text) ? 'string'
      : /^\d/.test(text) || text === 'NULL' ? 'number'
      : C_KEYWORDS.has(text) ? 'keyword'
      : /^[A-Za-z_]\w*$/.test(text) && /^\s*\(/.test(code.slice(offset + text.length)) ? 'function'
      : /^[A-Z][A-Za-z_0-9]*$/.test(text) ? 'type' : 'plain';
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1).push({ text: part, kind });
    });
    offset += text.length;
  }
  return lines;
}
