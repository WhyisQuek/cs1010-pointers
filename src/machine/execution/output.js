/** printf: argument evaluation, conversion and the program's standard output. */
import {
  STRING_LITERAL,
  formatConversion,
  integerArgument,
  parseFormat,
} from '../../language/format.js';
import { MAX_OUTPUT_CHARS } from '../../language/limits.js';
import { referenceLocation } from '../addresses.js';
import { resolveRef } from '../memory.js';
import { evalExpression } from './expressions.js';
import { checkUnsequenced } from './operators.js';
import { addToPointer } from './pointerArithmetic.js';
import { intResult, pushTrace, semanticError } from './runtime.js';

export function evalPrintf(expr, ctx, env, frame) {
  const [format, ...rest] = expr.arguments;
  const items = parseFormat(format.value);
  // Arguments are unsequenced with each other, as for any call.
  const argumentAccesses = [];
  const args = rest.map(arg => {
    if (arg.kind === 'StringLiteral')
      return { type: STRING_LITERAL, value: { kind: 'string', codes: arg.value } };
    const start = ctx.accesses.length;
    const rv = evalExpression(arg, ctx, env, frame, null);
    const accesses = ctx.accesses.slice(start);
    for (const previous of argumentAccesses) checkUnsequenced(previous, accesses, ctx, expr);
    argumentAccesses.push(accesses);
    return rv;
  });
  for (const accesses of argumentAccesses) for (const access of accesses) access.update = false;

  let next = 0,
    text = '';
  const take = () => ({ rv: args[next], node: rest[next++] });
  for (const item of items) {
    if (typeof item === 'string') {
      text += item;
      continue;
    }
    const spec = { ...item };
    if (spec.width === '*') {
      const width = take().rv.value.value;
      // A negative '*' width is a '-' flag plus a positive width.
      if (width < 0) spec.flags += '-';
      spec.width = Math.abs(width);
    }
    if (spec.precision === '*') {
      const precision = take().rv.value.value;
      spec.precision = precision < 0 ? null : precision;
    }
    const { rv, node } = take();
    try {
      text += formatConversion(spec, conversionArgument(spec, rv, ctx, node));
    } catch (error) {
      throw semanticError(node, `printf: ${error.message}`);
    }
  }

  ctx.output += text;
  if (ctx.output.length > MAX_OUTPUT_CHARS)
    throw semanticError(expr, `program output exceeded ${MAX_OUTPUT_CHARS} characters`);
  pushTrace(ctx, { kind: 'Output', text, line: expr.loc?.startLine ?? null });
  return intResult(text.length);
}

function conversionArgument(spec, rv, ctx, node) {
  const { conversion } = spec;
  if ('diouxXc'.includes(conversion)) return integerArgument(spec, rv.type, rv.value.value);
  if ('fFeEgG'.includes(conversion)) return Number(rv.value.value);
  if (conversion === 'p')
    return rv.value.kind === 'null' ? null : referenceLocation(ctx.state, rv.value.target).address;
  if (rv.type === STRING_LITERAL) return rv.value.codes;
  if (rv.value.kind === 'null') throw new Error(`${spec.text} received a null pointer`);
  return readString(ctx, rv.value, spec.precision, node);
}

/** Read chars up to the terminating '\0' (or `limit` chars) without leaving the array. */
function readString(ctx, pointer, limit, node) {
  const codes = [];
  let current = pointer;
  while (limit === null || codes.length < limit) {
    const resolved = resolveRef(ctx.state, current.target, { allowDead: true });
    if (!resolved.allocation.alive) throw new Error('%s reads an object whose lifetime has ended');
    if (resolved.onePast || resolved.invalid)
      throw new Error("%s argument has no terminating '\\0' within its array");
    if (resolved.value.kind === 'uninit')
      throw new Error(`%s reads uninitialized ${resolved.label}`);
    if (resolved.value.value === 0) break;
    codes.push(resolved.value.value);
    current = addToPointer(ctx.state, current, 1, node);
  }
  return codes;
}
