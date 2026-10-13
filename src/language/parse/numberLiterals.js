/** Integer and floating literals, typed by C's suffix and value-range rules (LP64). */
import { INVALID, UNSUPPORTED, diagnostic } from '../diagnostics.js';
import { convertNumber } from '../numeric.js';
import { primitive } from '../types.js';

export function parseIntegerLiteral(raw) {
  const literal = parseNumberLiteral(raw);
  // Array sizes must have integer type (C23 6.7.6.2p1).
  if (literal.kind !== 'IntLiteral') throw diagnostic(INVALID, `expected integer literal '${raw}'`);
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
  // Binary literals, digit separators and other C23 forms are outside the subset.
  if (!match) throw diagnostic(UNSUPPORTED, `unsupported numeric literal '${raw}'`);
  const [, digits, suffix] = match;
  const n = BigInt(/^0[0-7]+$/.test(digits) ? `0o${digits.slice(1)}` : digits);
  const unsigned = /u/i.test(suffix),
    long = /l/i.test(suffix);
  const nonDecimal = digits.startsWith('0') && digits.length > 1;
  // C23 6.4.4.1p6: the first type in the suffix's list that can represent the value. Octal
  // and hexadecimal constants may also take the unsigned types. long long is not modeled;
  // under LP64 it has the same range as long, so it adds no candidate value.
  const candidates = [
    ...(long ? [] : unsigned ? ['unsigned int'] : nonDecimal ? ['int', 'unsigned int'] : ['int']),
    ...(unsigned ? ['unsigned long'] : nonDecimal ? ['long', 'unsigned long'] : ['long']),
  ];
  const name = candidates.find(c => n <= MAX[c]);
  // C23 6.4.4p2: a constant must have a type that can represent its value.
  if (!name) throw diagnostic(INVALID, `integer constant '${raw}' is too large for any type`);
  const type = primitive(name);
  return { kind: 'IntLiteral', type, value: convertNumber(n, type, { arithmetic: true }), raw };
}

const MAX = {
  int: 2147483647n,
  'unsigned int': 4294967295n,
  long: 9223372036854775807n,
  'unsigned long': 18446744073709551615n,
};
