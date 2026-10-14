/** Function invocation with explicit call frames, and the malloc/calloc/free/printf built-ins. */
import { INVALID, LIMIT, UNDEFINED, diagnostic } from '../../language/diagnostics.js';
import { MAX_CALL_DEPTH, MAX_HEAP_BYTES } from '../../language/limits.js';
import { SIZE_T, convertNumber, isFloatingType } from '../../language/numeric.js';
import { VOID, block, isPointer, pointer } from '../../language/types.js';
import { referenceOffset } from '../addresses.js';
import {
  addAllocation,
  addFrame,
  endFrame,
  freshFrameId,
  getAllocation,
  pointerValue,
  ref,
} from '../memory.js';
import { evalExpression } from './expressions.js';
import { assignToRef, coerceRValue } from './lvalues.js';
import { checkUnsequenced, isNullLike } from './operators.js';
import { evalPrintf } from './output.js';
import {
  declareBinding,
  makeScope,
  markNext,
  pushTrace,
  requireNumber,
  semanticError,
  snapshot,
} from './runtime.js';
import { execEmbeddedStatement } from './statements.js';

export function callFunction(ctx, fn, args, callerFrame, entry = false) {
  if (ctx.callDepth >= MAX_CALL_DEPTH)
    throw diagnostic(LIMIT, `maximum call depth (${MAX_CALL_DEPTH}) exceeded`);
  if (args.length !== fn.params.length)
    throw diagnostic(
      INVALID,
      `${fn.name} expects ${fn.params.length} argument(s), got ${args.length}`,
    );
  ctx.callDepth++;
  const frameId = entry ? 'main' : freshFrameId(ctx.state, fn.name);
  const frame = addFrame(ctx.state, {
    id: frameId,
    name: fn.name,
    callerId: callerFrame?.id ?? null,
    depth: callerFrame ? callerFrame.depth + 1 : 0,
    active: true,
  });
  const env = makeScope();
  pushTrace(ctx, { kind: 'EnterFrame', frameId, function: fn.name, callerId: frame.callerId });

  for (let i = 0; i < fn.params.length; i++) {
    const param = fn.params[i];
    const allocation = addAllocation(ctx.state, {
      name: param.name,
      type: param.type,
      storage: { kind: 'stack', frameId },
    });
    declareBinding(env, param.name, ref(allocation.id), param);
    env.ownedAllocations.push(allocation.id);
    assignToRef(ref(allocation.id), param.type, args[i], ctx, param);
    pushTrace(ctx, {
      kind: 'Parameter',
      frameId,
      name: param.name,
      allocationId: allocation.id,
      line: param.loc?.startLine ?? null,
    });
  }
  snapshot(ctx, { kind: 'EnterFrame', loc: { startLine: fn.loc?.startLine } }, frame);

  let returnValue = null;
  for (const stmt of fn.statements) {
    const result = execEmbeddedStatement(stmt, ctx, env, frame, fn, 0);
    if (result?.control === 'return') {
      returnValue = result.value;
      break;
    }
    if (result?.control === 'break' || result?.control === 'continue') {
      throw semanticError(stmt, `${result.control} used outside a loop`, INVALID);
    }
  }

  if (!entry) {
    markNext(ctx, { loc: { startLine: fn.loc?.endLine } }, frame);
    endFrame(ctx.state, frameId);
    pushTrace(ctx, { kind: 'LeaveFrame', frameId, function: fn.name });
    snapshot(ctx, { kind: 'LeaveFrame', loc: { startLine: fn.loc?.endLine } }, frame);
  }
  ctx.callDepth--;

  if (fn.returnType?.kind === 'void') return { type: { kind: 'void' }, value: { kind: 'void' } };
  if (!returnValue) {
    if (entry) return { type: fn.returnType, value: { kind: 'scalar', value: 0 } };
    // Only using the missing value is undefined (C23 6.9.1p12); evalExpression decides.
    return { type: fn.returnType, value: { kind: 'uninit' }, missingReturn: fn.name };
  }
  return coerceRValue(fn.returnType, returnValue, fn, ctx);
}

/** A size argument converts to size_t like any prototyped parameter (C23 6.5.2.2p7). */
function sizeArgument(arg, ctx, env, frame) {
  const rv = evalExpression(arg, ctx, env, frame, SIZE_T);
  requireNumber(rv, arg);
  return BigInt(convertNumber(rv.value.value, SIZE_T, { fromFloat: isFloatingType(rv.type) }));
}

/** An untyped heap block; it has no type until a pointer to it is converted to T * (lvalues.js). */
function allocateBlock(expr, bytes, ctx, { zeroFilled = false } = {}) {
  // Implementation-defined for a zero size (C23 7.24.3p1): PointerViz returns NULL.
  if (bytes === 0n) return { type: pointer(VOID), value: { kind: 'null' } };
  if (bytes > BigInt(MAX_HEAP_BYTES))
    throw semanticError(
      expr,
      `${expr.name} of ${bytes} bytes exceeds PointerViz's limit of ${MAX_HEAP_BYTES} bytes per block`,
      LIMIT,
    );
  const allocation = addAllocation(ctx.state, {
    type: block(Number(bytes)),
    storage: { kind: 'heap' },
    alive: true,
  });
  if (zeroFilled) allocation.zeroFilled = true;
  pushTrace(ctx, {
    kind: 'Allocate',
    allocationId: allocation.id,
    bytes: Number(bytes),
    zeroFilled,
    line: expr.loc?.startLine ?? null,
  });
  return { type: pointer(VOID), value: pointerValue(ref(allocation.id, [])) };
}

export function evalCall(expr, ctx, env, frame) {
  if (expr.name === 'malloc') {
    if (expr.arguments.length !== 1)
      throw semanticError(expr, 'malloc expects exactly one argument', INVALID);
    return allocateBlock(expr, sizeArgument(expr.arguments[0], ctx, env, frame), ctx);
  }

  if (expr.name === 'calloc') {
    if (expr.arguments.length !== 2)
      throw semanticError(expr, 'calloc expects exactly two arguments', INVALID);
    const counts = [];
    const argumentAccesses = [];
    for (const arg of expr.arguments) {
      const start = ctx.accesses.length;
      counts.push(sizeArgument(arg, ctx, env, frame));
      const accesses = ctx.accesses.slice(start);
      for (const previous of argumentAccesses) checkUnsequenced(previous, accesses, ctx, expr);
      argumentAccesses.push(accesses);
    }
    for (const accesses of argumentAccesses) for (const access of accesses) access.update = false;
    const bytes = counts[0] * counts[1];
    // A product size_t cannot represent fails, returning NULL (C23 7.24.3.2p3).
    if (bytes > (1n << 64n) - 1n) return { type: pointer(VOID), value: { kind: 'null' } };
    // calloc's storage is all bits zero (C23 7.24.3.2p2).
    return allocateBlock(expr, bytes, ctx, { zeroFilled: true });
  }

  if (expr.name === 'printf') return evalPrintf(expr, ctx, env, frame);

  if (expr.name === 'free') {
    if (expr.arguments.length !== 1)
      throw semanticError(expr, 'free expects exactly one argument', INVALID);
    let rv;
    ctx.allowDanglingRead = true;
    try {
      rv = evalExpression(expr.arguments[0], ctx, env, frame, null);
    } finally {
      ctx.allowDanglingRead = false;
    }
    if (isNullLike(rv)) return { type: { kind: 'void' }, value: { kind: 'void' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer')
      throw semanticError(expr, 'free expects a pointer or NULL', INVALID);
    const target = rv.value.target,
      allocation = getAllocation(ctx.state, target.allocationId);
    if (allocation.storage.kind !== 'heap')
      throw semanticError(expr, 'free() requires heap memory', UNDEFINED);
    if (!allocation.alive) throw semanticError(expr, 'double free', UNDEFINED);
    // Any pointer to the block's first byte compares equal to the one malloc returned
    // (C23 6.7.2.1p17, 7.24.3.3), such as a pointer to a struct's first member.
    const { offset, onePast } = referenceOffset(ctx.state, target);
    if (offset !== 0 || onePast)
      throw semanticError(
        expr,
        'free() requires the original allocation pointer, not an interior pointer',
        UNDEFINED,
      );
    allocation.alive = false;
    pushTrace(ctx, {
      kind: 'Free',
      allocationId: allocation.id,
      line: expr.loc?.startLine ?? null,
    });
    return { type: { kind: 'void' }, value: { kind: 'void' } };
  }

  const fn = ctx.functions.get(expr.name);
  if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`, INVALID);
  // The checker rejects a wrong argument count; callFunction re-asserts it for every call.
  const argumentAccesses = [];
  const args = expr.arguments.map((arg, i) => {
    const start = ctx.accesses.length;
    const rv = evalExpression(arg, ctx, env, frame, fn.params[i].type);
    const accesses = ctx.accesses.slice(start);
    for (const previous of argumentAccesses) checkUnsequenced(previous, accesses, ctx, expr);
    argumentAccesses.push(accesses);
    return rv;
  });
  for (const accesses of argumentAccesses) for (const access of accesses) access.update = false;
  const result = callFunction(ctx, fn, args, frame, false);
  markNext(ctx, expr, frame);
  return result;
}
