/**
 * printf format strings (C 7.21.6.1): parsing, argument type rules and formatting.
 * Output follows glibc: exact decimal expansion of doubles, round-half-even, `(nil)` for %p NULL.
 */
import { UNDEFINED, UNSUPPORTED, diagnostic } from './diagnostics.js';
import { isPointer, typeToString } from './types.js';
import { promote } from './numeric.js';

/** The type of a string literal passed straight to printf. */
export const STRING_LITERAL = Object.freeze({ kind: 'string-literal' });

const INTEGER = 'diouxX';
const FLOATING = 'fFeEgG';
const SPEC = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|j|z|t|L)?([\s\S]?)/y;

/** Split a format into literal text and conversion specifications. */
export function parseFormat(codes) {
  const format = String.fromCharCode(...codes.map(c => c & 0xff));
  const items = [];
  let text = '',
    i = 0;
  while (i < format.length) {
    if (format[i] !== '%') {
      text += format[i++];
      continue;
    }
    SPEC.lastIndex = i;
    const [whole, flags, width, precision, length = '', conversion] = SPEC.exec(format);
    i += whole.length;
    if (conversion === '%') {
      if (whole !== '%%')
        throw diagnostic(UNDEFINED, `invalid conversion '${whole}'; write %% for a percent sign`);
      text += '%';
      continue;
    }
    if (!conversion)
      throw diagnostic(UNDEFINED, `incomplete conversion '${whole}' at the end of the format`);
    if (conversion === 'n') throw diagnostic(UNSUPPORTED, '%n is not supported');
    if (!`${INTEGER}${FLOATING}csp`.includes(conversion))
      // C23 7.23.6.1 defines %a, %A and %b; any other conversion is undefined.
      throw diagnostic(
        'aAbB'.includes(conversion) ? UNSUPPORTED : UNDEFINED,
        `unsupported conversion '%${conversion}'`,
      );
    const lengthOk =
      !length ||
      (['hh', 'h', 'z'].includes(length) && INTEGER.includes(conversion)) ||
      (length === 'l' && (INTEGER.includes(conversion) || FLOATING.includes(conversion)));
    if (!lengthOk)
      throw diagnostic(
        ['ll', 'j', 't', 'L'].includes(length) ? UNSUPPORTED : UNDEFINED,
        ['ll', 'j', 't', 'L'].includes(length)
          ? `length modifier '${length}' is not supported (no long long, intmax_t, ptrdiff_t or long double)`
          : `length modifier '${length}' cannot be used with %${conversion}`,
      );
    if (text) items.push(text);
    text = '';
    items.push({
      flags,
      width: width === '*' ? '*' : width ? Number(width) : null,
      precision: precision === undefined ? null : precision === '*' ? '*' : Number(precision || 0),
      length,
      conversion,
      text: whole,
    });
  }
  if (text) items.push(text);
  return items;
}

/** The arguments a format consumes, in order: '*' widths/precisions, then the value. */
export function formatArguments(items) {
  return items
    .filter(item => typeof item !== 'string')
    .flatMap(spec => [
      ...(spec.width === '*' ? [{ spec, role: 'width' }] : []),
      ...(spec.precision === '*' ? [{ spec, role: 'precision' }] : []),
      { spec, role: 'value' },
    ]);
}

/** Like -Wformat: the message for an argument type that does not match, or null. */
export function argumentTypeError({ spec, role }, type) {
  const promoted = type?.kind === 'primitive' ? argumentPromotion(type) : type;
  const name = promoted?.kind === 'primitive' ? promoted.name : null;
  const expect = expected =>
    `${spec.text} expects ${expected}, but the argument has type ${describe(type)}`;
  if (role !== 'value')
    return name === 'int'
      ? null
      : `'*' in ${spec.text} expects an int ${role}, but the argument has type ${describe(type)}`;
  const { conversion, length } = spec;
  if (INTEGER.includes(conversion) || conversion === 'c') {
    // A signed type and its unsigned counterpart are interchangeable when the value fits both.
    const wide = length === 'l' || length === 'z';
    const allowed = wide ? ['long', 'unsigned long'] : ['int', 'unsigned int'];
    if (allowed.includes(name)) return null;
    const signed = 'dic'.includes(conversion);
    return expect(
      length === 'z' ? 'size_t' : `${signed ? '' : 'unsigned '}${length === 'l' ? 'long' : 'int'}`,
    );
  }
  if (FLOATING.includes(conversion)) return name === 'double' ? null : expect('double');
  // C23 7.16.1.1p2 lets a nullptr_t argument be read as a pointer.
  if (conversion === 'p')
    return isPointer(promoted) || promoted?.kind === 'nullptr_t' ? null : expect('a pointer');
  if (conversion === 's')
    return type === STRING_LITERAL ||
      (isPointer(promoted) && promoted.to.kind === 'primitive' && promoted.to.name === 'char')
      ? null
      : expect('char *');
  return `unsupported conversion ${spec.text}`;
}

/** Default argument promotions (C 6.5.2.2p6): integer promotions and float to double. */
function argumentPromotion(type) {
  return type.name === 'float' ? { kind: 'primitive', name: 'double' } : promote(type);
}

function describe(type) {
  return type === STRING_LITERAL ? 'string literal' : typeToString(type);
}

/**
 * The integer a d/i/o/u/x/X/c conversion prints. Mixing signedness is only defined
 * when the value is representable in both types, so other values are diagnosed.
 */
export function integerArgument(spec, type, value) {
  let n = BigInt(value);
  const wide = spec.length === 'l' || spec.length === 'z';
  const bits = wide ? 64 : 32;
  const signedConversion = 'di'.includes(spec.conversion);
  const unsignedType = type.name.startsWith('unsigned');
  if (signedConversion && unsignedType && n >= 1n << BigInt(bits - 1))
    throw diagnostic(UNDEFINED, `${n} does not fit the signed type that ${spec.text} prints`);
  const narrowed = spec.conversion === 'c' || spec.length === 'hh' || spec.length === 'h';
  if (!signedConversion && !narrowed && !unsignedType && n < 0n)
    throw diagnostic(
      UNDEFINED,
      `negative value ${n} does not fit the unsigned type that ${spec.text} prints`,
    );
  if (spec.conversion === 'c') return BigInt.asUintN(8, n);
  if (spec.length === 'hh' || spec.length === 'h') {
    const width = spec.length === 'hh' ? 8 : 16;
    n = signedConversion ? BigInt.asIntN(width, n) : BigInt.asUintN(width, n);
  }
  return n;
}

/**
 * Format one conversion. `arg` is pre-resolved by the interpreter:
 * a BigInt for integer and %c conversions, a number for floating conversions,
 * an array of char values for %s, and a numeric address or null for %p.
 */
export function formatConversion(spec, arg) {
  const { conversion } = spec;
  if (conversion === 'c') return pad(spec, '', String.fromCharCode(Number(arg)), false);
  if (conversion === 's') {
    const codes = spec.precision === null ? arg : arg.slice(0, spec.precision);
    return pad(spec, '', String.fromCharCode(...codes.map(c => c & 0xff)), false);
  }
  if (conversion === 'p')
    return pad(spec, '', arg === null ? '(nil)' : `0x${arg.toString(16)}`, false);
  if (INTEGER.includes(conversion)) return formatInteger(spec, arg);
  return formatFloating(spec, arg);
}

function signPrefix(spec, negative) {
  return negative ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
}

function pad(spec, prefix, body, zeroAllowed = true) {
  const width = spec.width ?? 0,
    length = prefix.length + body.length;
  if (length >= width) return prefix + body;
  if (spec.flags.includes('-')) return prefix + body + ' '.repeat(width - length);
  if (spec.flags.includes('0') && zeroAllowed) return prefix + '0'.repeat(width - length) + body;
  return ' '.repeat(width - length) + prefix + body;
}

function formatInteger(spec, n) {
  const { conversion, flags } = spec;
  const negative = n < 0n,
    magnitude = negative ? -n : n;
  let digits = magnitude.toString({ o: 8, x: 16, X: 16 }[conversion] ?? 10);
  if (conversion === 'X') digits = digits.toUpperCase();
  if (spec.precision !== null) {
    if (spec.precision === 0 && magnitude === 0n) digits = '';
    digits = digits.padStart(spec.precision, '0');
  }
  if (flags.includes('#') && conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
  let prefix = 'di'.includes(conversion) ? signPrefix(spec, negative) : '';
  if (flags.includes('#') && 'xX'.includes(conversion) && magnitude !== 0n)
    prefix += conversion === 'x' ? '0x' : '0X';
  return pad(spec, prefix, digits, spec.precision === null);
}

function formatFloating(spec, x) {
  const upper = conversion => conversion === conversion.toUpperCase();
  const negative = x < 0 || Object.is(x, -0);
  const prefix = signPrefix(spec, negative);
  if (!Number.isFinite(x)) {
    const text = Number.isNaN(x) ? 'nan' : 'inf';
    return pad(spec, prefix, upper(spec.conversion) ? text.toUpperCase() : text, false);
  }
  const value = exactRational(Math.abs(x));
  const alternate = spec.flags.includes('#');
  const conversion = spec.conversion.toLowerCase();
  let body;
  if (conversion === 'f') body = fixed(value, spec.precision ?? 6, alternate);
  else if (conversion === 'e') body = exponential(value, spec.precision ?? 6, alternate);
  else {
    const p = spec.precision === null ? 6 : Math.max(spec.precision, 1);
    const exponent = scientific(value, p - 1).exponent;
    body =
      p > exponent && exponent >= -4
        ? fixed(value, p - 1 - exponent, alternate)
        : exponential(value, p - 1, alternate);
    // Trailing zeros come off the fraction only, never the exponent (1.5e+10, not 1.5e+1).
    if (!alternate) body = body.replace(/(\.\d*?)0+(?=e|$)/, '$1').replace(/\.(?=e|$)/, '');
  }
  if (upper(spec.conversion)) body = body.toUpperCase();
  return pad(spec, prefix, body);
}

/** The exact value of a finite, non-negative double as num / den. */
function exactRational(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased) mantissa |= 1n << 52n;
  const exponent = (biased || 1) - 1075;
  return exponent >= 0
    ? { num: mantissa << BigInt(exponent), den: 1n }
    : { num: mantissa, den: 1n << BigInt(-exponent) };
}

/** num / den rounded to the nearest integer, ties to even (the default rounding mode). */
function roundHalfEven(num, den) {
  const quotient = num / den,
    twice = 2n * (num % den);
  return twice > den || (twice === den && quotient % 2n === 1n) ? quotient + 1n : quotient;
}

function withPoint(digits, decimals, alternate) {
  if (!decimals) return alternate ? `${digits}.` : digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function fixed({ num, den }, decimals, alternate) {
  const scaled = roundHalfEven(num * 10n ** BigInt(decimals), den);
  return withPoint(scaled.toString().padStart(decimals + 1, '0'), decimals, alternate);
}

/** Digits d.ddd (decimals after the point) and the decimal exponent, after rounding. */
function scientific({ num, den }, decimals) {
  if (num === 0n) return { digits: '0'.repeat(decimals + 1), exponent: 0 };
  let exponent = num.toString().length - den.toString().length;
  const at = k =>
    k >= 0 ? { num, den: den * 10n ** BigInt(k) } : { num: num * 10n ** BigInt(-k), den };
  for (;;) {
    const v = at(exponent);
    if (v.num < v.den) exponent--;
    else if (v.num >= 10n * v.den) exponent++;
    else break;
  }
  let v = at(exponent),
    mantissa = roundHalfEven(v.num * 10n ** BigInt(decimals), v.den);
  if (mantissa >= 10n ** BigInt(decimals + 1)) {
    exponent++;
    v = at(exponent);
    mantissa = roundHalfEven(v.num * 10n ** BigInt(decimals), v.den);
  }
  return { digits: mantissa.toString(), exponent };
}

function exponential(value, decimals, alternate) {
  const { digits, exponent } = scientific(value, decimals);
  const sign = exponent < 0 ? '-' : '+';
  return `${withPoint(digits, decimals, alternate)}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}
