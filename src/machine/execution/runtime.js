/** Execution-context helpers: lexical scopes, trace/snapshot recording, safety guards and runtime checks. */
import { INVALID, LIMIT, diagnostic } from '../../language/diagnostics.js';
import {
  MAX_HISTORY_SCALARS,
  MAX_LOOP_ITERATIONS,
  MAX_TRACE_STEPS,
} from '../../language/limits.js';
import { isFloatingType, isIntegerType } from '../../language/numeric.js';
import { INT, typeToString, validateObjectType } from '../../language/types.js';
import { cloneState, getAllocation } from '../memory.js';

export function makeScope(parent = null) {
  return { parent, bindings: new Map(), ownedAllocations: [] };
}

export function declareBinding(scope, name, targetRef, node) {
  if (scope.bindings.has(name)) throw semanticError(node, `redeclaration of '${name}'`, INVALID);
  scope.bindings.set(name, targetRef);
}

export function lookupBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const target = current.bindings.get(name);
    if (target) return target;
  }
  return null;
}

/** A scope owns only stack objects declared in it, which all belong to `frame`. */
export function closeScope(ctx, scope, frame) {
  for (const id of scope.ownedAllocations) {
    const allocation = getAllocation(ctx.state, id);
    if (allocation.alive) {
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
      LIMIT,
    );
  }
}

export function markNext(ctx, node, frame) {
  // Where execution is about to go; a runtime error is reported at this position.
  ctx.position = { line: node.loc?.startLine ?? null, frame };
  const previous = ctx.snapshots.at(-1);
  if (previous) {
    previous.nextLine = node.loc?.startLine ?? null;
    previous.nextFunction = frame.name;
    previous.nextFrameId = frame.id;
    previous.nextDepth = frame.depth;
  }
}

export function snapshot(ctx, stmt, frame) {
  ctx.steps++;
  if (ctx.steps > MAX_TRACE_STEPS)
    throw diagnostic(LIMIT, `execution exceeded ${MAX_TRACE_STEPS} visualized statements`);
  // Copy-on-write: an allocation unchanged since the previous snapshot shares that snapshot's
  // copy, so expired locals are stored once rather than at every later step. Snapshot states
  // are read-only; the UI clones one before editing it (MemoryCanvas's mutate, Sandbox).
  const previous = new Map(ctx.snapshots.at(-1)?.state.allocations.map(a => [a.id, a]));
  let copied = 0;
  const allocations = ctx.state.allocations.map(a => {
    const before = previous.get(a.id);
    // Nothing writes to an object whose lifetime has ended (every store requires a live one),
    // so one that was already dead needs no comparison.
    if (before && ((!before.alive && !a.alive) || sameData(before, a))) return before;
    copied += validateObjectType(a.type, ctx.state.structTypes);
    return structuredClone(a);
  });
  ctx.historyScalars += copied;
  if (ctx.historyScalars > MAX_HISTORY_SCALARS)
    throw diagnostic(
      LIMIT,
      `execution history exceeded ${MAX_HISTORY_SCALARS} stored values (every step keeps a copy of what changed in memory)`,
    );
  const state = cloneState({ ...ctx.state, allocations: [] });
  state.allocations = allocations;
  ctx.snapshots.push({
    line: stmt.loc?.startLine ?? null,
    nextLine: null,
    function: frame.name,
    frameId: frame.id,
    depth: frame.depth,
    statement: stmt.kind,
    events: ctx.trace.slice(ctx.snapshotTraceIndex),
    output: ctx.output,
    state,
  });
  ctx.snapshotTraceIndex = ctx.trace.length;
}

/** Deep equality of plain cloned data; Object.is keeps -0 and 0 apart. */
function sameData(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => Object.hasOwn(b, k) && sameData(a[k], b[k]));
}

export function pushTrace(ctx, event) {
  ctx.trace.push(event);
  if (ctx.trace.length > MAX_TRACE_STEPS * 8)
    throw diagnostic(LIMIT, 'execution trace is too large');
}

export function intResult(value) {
  return { type: INT, value: { kind: 'scalar', value } };
}

export function requireInteger(rv, node) {
  if (!isIntegerRuntime(rv))
    throw semanticError(node, `expected integer, got ${typeToString(rv.type)}`, INVALID);
}

export function isIntegerRuntime(rv) {
  return isIntegerType(rv.type) && rv.value.kind === 'scalar';
}

export function isNumberRuntime(rv) {
  return (isIntegerType(rv.type) || isFloatingType(rv.type)) && rv.value.kind === 'scalar';
}

export function requireNumber(rv, node) {
  if (!isNumberRuntime(rv))
    throw semanticError(node, `expected number, got ${typeToString(rv.type)}`, INVALID);
}

/** `kind` is a category from language/diagnostics.js. */
export function semanticError(node, message, kind) {
  const line = node?.loc?.startLine;
  return diagnostic(kind, line ? `${message} (line ${line})` : message);
}
