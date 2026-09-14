/** Explicit LP64 arithmetic; never silently round a 64-bit integer in JavaScript. */
import { INT, primitive } from './types.js';

const bits = { char: 8, short: 16, int: 32, long: 64, 'unsigned int': 32, 'unsigned long': 64 };
export const SIZE_T = primitive('unsigned long');
export const isIntegerType = type => type?.kind === 'primitive' && Object.hasOwn(bits, type.name);
export const isFloatingType = type => type?.kind === 'primitive' && ['float', 'double'].includes(type.name);
export const promote = type => ['char', 'short'].includes(type.name) ? INT : type;

export function arithmeticType(a, b) {
  if (a.name === 'double' || b.name === 'double') return primitive('double');
  if (a.name === 'float' || b.name === 'float') return primitive('float');
  a = promote(a); b = promote(b);
  if (a.name === 'unsigned long' || b.name === 'unsigned long') return SIZE_T;
  if (a.name === 'long' || b.name === 'long') return primitive('long');
  if (a.name === 'unsigned int' || b.name === 'unsigned int') return primitive('unsigned int');
  return INT;
}

export function convertNumber(value, type, { arithmetic = false, fromFloat = false } = {}) {
  if (isFloatingType(type)) {
    const n = type.name === 'float' ? Math.fround(Number(value)) : Number(value);
    if (!Number.isFinite(n)) throw new Error('floating-point result outside the supported finite range');
    return n;
  }
  if (!isIntegerType(type)) throw new Error(`unsupported numeric type ${type.name}`);
  if (typeof value !== 'bigint' && (!Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value)))) {
    throw new Error('integer exceeds the exact JavaScript safe-integer range supported by PointerViz');
  }
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const width = BigInt(bits[type.name]), unsigned = type.name.startsWith('unsigned');
  const min = unsigned ? 0n : -(1n << (width - 1n));
  const max = unsigned ? (1n << width) - 1n : (1n << (width - 1n)) - 1n;
  if ((fromFloat || (arithmetic && !unsigned)) && (n < min || n > max)) {
    throw new Error(fromFloat ? 'floating-to-integer conversion outside destination range' : `signed integer overflow in ${type.name}`);
  }
  // Choose the common two's-complement result for implementation-defined signed narrowing.
  n = unsigned ? BigInt.asUintN(Number(width), n) : BigInt.asIntN(Number(width), n);
  if (n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('integer exceeds the exact JavaScript safe-integer range supported by PointerViz');
  }
  return Number(n);
}

export function numericOperation(op, left, right) {
  const type = arithmeticType(left.type, right.type);
  const floating = isFloatingType(type);
  if (op === '%' && floating) throw new Error('remainder requires integer operands');
  let a = convertNumber(left.value.value, type), b = convertNumber(right.value.value, type);
  if ((op === '/' || op === '%') && b === 0) throw new Error('division by zero');
  if (!floating) { a = BigInt(a); b = BigInt(b); }
  if (!floating && !type.name.startsWith('unsigned') && (op === '/' || op === '%') &&
      a === -(1n << BigInt(bits[type.name] - 1)) && b === -1n) throw new Error('signed integer overflow in division');
  const n = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
  return { type, value: { kind: 'scalar', value: convertNumber(n, type, { arithmetic: true }) } };
}
