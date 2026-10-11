/** Function invocation with explicit call frames, and the malloc/free/printf built-ins. */
import { MAX_CALL_DEPTH, MAX_HEAP_ELEMENTS } from '../../language/limits.js';
import { INT, isArray, isPointer, sizeOf, typeToString } from '../../language/types.js';
import {
  addAllocation,
  addFrame,
  endFrame,
  freshFrameId,
  getAllocation,
  heapAllocationType,
  pointerValue,
  ref,
  samePath,
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
  requireInteger,
  semanticError,
  snapshot,
} from './runtime.js';
import { execEmbeddedStatement } from './statements.js';

export function callFunction(ctx, fn, args, callerFrame, entry = false) {
  if (ctx.callDepth >= MAX_CALL_DEPTH)
    throw new Error(`maximum call depth (${MAX_CALL_DEPTH}) exceeded`);
  if (args.length !== fn.params.length)
    throw new Error(`${fn.name} expects ${fn.params.length} argument(s), got ${args.length}`);
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
      throw semanticError(stmt, `${result.control} used outside a loop`);
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
    if (entry && fn.name === 'main')
      return { type: fn.returnType, value: { kind: 'scalar', value: 0 } };
    throw new Error(
      `function '${fn.name}' reached the end without returning ${typeToString(fn.returnType)}`,
    );
  }
  return coerceRValue(fn.returnType, returnValue, fn);
}

export function evalCall(expr, ctx, env, frame, expectedType) {
  if (expr.name === 'malloc') {
    if (!expectedType || !isPointer(expectedType))
      throw semanticError(expr, 'malloc result must be assigned where a pointer type is known');
    if (isArray(expectedType.to))
      throw semanticError(
        expr,
        'malloc of array types is not supported; use a pointer to the element type',
      );
    if (expr.arguments.length !== 1)
      throw semanticError(expr, 'malloc expects exactly one argument');
    const sizeRv = evalExpression(expr.arguments[0], ctx, env, frame, INT);
    requireInteger(sizeRv, expr.arguments[0]);
    const bytes = sizeRv.value.value;
    const elemBytes = sizeOf(expectedType.to, ctx.state.structTypes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % elemBytes !== 0)
      throw semanticError(
        expr,
        `malloc size ${bytes} is not a positive multiple of sizeof(${typeToString(expectedType.to)}) (${elemBytes})`,
      );
    const count = bytes / elemBytes;
    if (count > MAX_HEAP_ELEMENTS)
      throw semanticError(
        expr,
        `malloc would create ${count} elements; PointerViz limits one allocation to ${MAX_HEAP_ELEMENTS}`,
      );
    const allocation = addAllocation(ctx.state, {
      type: heapAllocationType(expectedType.to, count),
      storage: { kind: 'heap' },
      alive: true,
    });
    const target = isArray(allocation.type) ? ref(allocation.id, [0]) : ref(allocation.id, []);
    pushTrace(ctx, {
      kind: 'Allocate',
      allocationId: allocation.id,
      bytes,
      count,
      line: expr.loc?.startLine ?? null,
    });
    return { type: expectedType, value: pointerValue(target) };
  }

  if (expr.name === 'printf') return evalPrintf(expr, ctx, env, frame);

  if (expr.name === 'free') {
    if (expr.arguments.length !== 1) throw semanticError(expr, 'free expects exactly one argument');
    let rv;
    ctx.allowDanglingRead = true;
    try {
      rv = evalExpression(expr.arguments[0], ctx, env, frame, null);
    } finally {
      ctx.allowDanglingRead = false;
    }
    if (isNullLike(rv)) return { type: { kind: 'void' }, value: { kind: 'void' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer')
      throw semanticError(expr, 'free expects a pointer or NULL');
    const target = rv.value.target,
      allocation = getAllocation(ctx.state, target.allocationId);
    if (allocation.storage.kind !== 'heap')
      throw semanticError(expr, 'free() requires heap memory');
    if (!allocation.alive) throw semanticError(expr, 'double free');
    const basePath = isArray(allocation.type) ? [0] : [];
    if (!samePath(target.path, basePath))
      throw semanticError(
        expr,
        'free() requires the original allocation pointer, not an interior pointer',
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
  if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`);
  if (expr.arguments.length !== fn.params.length)
    throw semanticError(
      expr,
      `${expr.name} expects ${fn.params.length} argument(s), got ${expr.arguments.length}`,
    );
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
