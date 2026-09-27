/** Execution-context helpers: lexical scopes, trace/snapshot recording, safety guards and runtime checks. */
import { MAX_LOOP_ITERATIONS, MAX_TRACE_STEPS } from '../../language/limits.js';
import { isFloatingType, isIntegerType } from '../../language/numeric.js';
import { INT, typeToString } from '../../language/types.js';
import { cloneState, getAllocation } from '../memory.js';

export function makeScope(parent = null) {
  return { parent, bindings: new Map(), ownedAllocations: [] };
}

export function declareBinding(scope, name, targetRef, node) {
  if (scope.bindings.has(name)) throw semanticError(node, `redeclaration of '${name}'`);
  scope.bindings.set(name, targetRef);
}

export function lookupBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const target = current.bindings.get(name);
    if (target) return target;
  }
  return null;
}

export function closeScope(ctx, scope, frame) {
  for (const id of scope.ownedAllocations) {
    const allocation = getAllocation(ctx.state, id);
    if (
      allocation.storage.kind === 'stack' &&
      allocation.storage.frameId === frame.id &&
      allocation.alive
    ) {
      allocation.alive = false;
      pushTrace(ctx, { kind: 'EndLifetime', allocationId: id, frameId: frame.id });
    }
  }
}

export function guardLoopIteration(iterations, stmt) {
  if (iterations > MAX_LOOP_ITERATIONS) {
    throw semanticError(
      stmt,
      `loop exceeded ${MAX_LOOP_ITERATIONS} iterations; possible infinite loop`,
    );
  }
}

export function markNext(ctx, node, frame) {
  const previous = ctx.snapshots.at(-1);
  if (previous) {
    previous.nextLine = node.loc?.startLine ?? null;
    previous.nextFunction = frame.name;
  }
}

export function snapshot(ctx, stmt, frame) {
  ctx.steps++;
  if (ctx.steps > MAX_TRACE_STEPS)
    throw new Error(`execution exceeded ${MAX_TRACE_STEPS} visualized statements`);
  ctx.snapshots.push({
    line: stmt.loc?.startLine ?? null,
    nextLine: null,
    function: frame.name,
    frameId: frame.id,
    statement: stmt.kind,
    events: ctx.trace.slice(ctx.snapshotTraceIndex),
    state: cloneState(ctx.state),
  });
  ctx.snapshotTraceIndex = ctx.trace.length;
}

export function pushTrace(ctx, event) {
  ctx.trace.push(event);
  if (ctx.trace.length > MAX_TRACE_STEPS * 8) throw new Error('execution trace is too large');
}

export function intResult(value) {
  return { type: INT, value: { kind: 'scalar', value } };
}

export function requireInteger(rv, node) {
  if (!isIntegerRuntime(rv))
    throw semanticError(node, `expected integer, got ${typeToString(rv.type)}`);
}

export function isIntegerRuntime(rv) {
  return isIntegerType(rv.type) && rv.value.kind === 'scalar';
}

export function isNumberRuntime(rv) {
  return (isIntegerType(rv.type) || isFloatingType(rv.type)) && rv.value.kind === 'scalar';
}

export function requireNumber(rv, node) {
  if (!isNumberRuntime(rv))
    throw semanticError(node, `expected number, got ${typeToString(rv.type)}`);
}

export function semanticError(node, message) {
  const line = node?.loc?.startLine;
  return new Error(line ? `${message} (line ${line})` : message);
}
