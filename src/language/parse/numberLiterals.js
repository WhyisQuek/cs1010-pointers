/** Integer and floating literals, typed by C's suffix and value-range rules (LP64). */
import { convertNumber } from '../numeric.js';
import { primitive } from '../types.js';

export function parseIntegerLiteral(raw) {
  const literal = parseNumberLiteral(raw);
  if (literal.kind !== 'IntLiteral') throw new Error(`expected integer literal '${raw}'`);
  return literal.value;
}

export function parseNumberLiteral(raw) {
  if (
    /^(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)[fF]?$/.test(raw)
  ) {
    const type = primitive(/[fF]$/.test(raw) ? 'float' : 'double');
    return {
      kind: 'FloatLiteral',
      type,
      value: convertNumber(Number(raw.replace(/[fF]$/, '')), type),
      raw,
    };
  }
  const match = raw.match(/^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uU]?[lL]?|[lL][uU]?)$/);
  if (!match) throw new Error(`unsupported numeric literal '${raw}'`);
  const [, digits, suffix] = match;
  const n = BigInt(/^0[0-7]+$/.test(digits) ? `0o${digits.slice(1)}` : digits);
  const unsigned = /u/i.test(suffix),
    long = /l/i.test(suffix);
  const nonDecimal = digits.startsWith('0') && digits.length > 1;
  const name = long
    ? unsigned
      ? 'unsigned long'
      : 'long'
    : unsigned
      ? n <= 4294967295n
        ? 'unsigned int'
        : 'unsigned long'
      : n <= 2147483647n
        ? 'int'
        : nonDecimal && n <= 4294967295n
          ? 'unsigned int'
          : 'long';
  const type = primitive(name);
  return { kind: 'IntLiteral', type, value: convertNumber(n, type, { arithmetic: true }), raw };
}
