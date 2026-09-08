/**
 * PointerViz Mini-C semantic interpreter.
 *
 * Functions use explicit call frames; blocks and for-loops use lexical scopes.
 * if/while/for execute directly from the Mini-C AST and loops are bounded for
 * browser safety. Structs remain regular aggregate allocations with subobjects.
 * Executed statements emit trace events and snapshots for step-through playback.
 */
import {
  CHAR, INT, isArray, isPointer, isPrimitive, isStruct, pointer, resolveStructType,
  sizeOf, typeEquals, typeToString,
} from '../language/types.js';
import { MAX_CALL_DEPTH, MAX_HEAP_ELEMENTS, MAX_LOOP_ITERATIONS, MAX_TRACE_STEPS } from '../language/limits.js';
import {
  addAllocation, addFrame, cloneState, decayRef, endFrame, freshFrameId, getAllocation,
  heapAllocationType, makeState, pointerValue, ref, refType, resetAllocationIds,
  resolveRef, setRefValue,
} from './memory.js';

export function executeProgram(program) {
  resetAllocationIds();
  const normalized = normalizeProgram(program);
  const structTypes = Object.fromEntries((normalized.structs ?? []).map(s => [s.name, structuredClone(s)]));
  const state = makeState(structTypes);
  const ctx = {
    state,
    functions: new Map(normalized.functions.map(fn => [fn.name, fn])),
    snapshots: [],
    trace: [],
    callDepth: 0,
    steps: 0,
  };
  if (!ctx.functions.has('main')) throw new Error('no main() function found');
  callFunction(ctx, ctx.functions.get('main'), [], null, true);
  return { state, snapshots: ctx.snapshots, trace: ctx.trace, ast: normalized };
}

function normalizeProgram(program) {
  if (program.functions) return program;
  // Backward-compatible shape used by parser-independent tests.
  return {
    kind: 'Program', structs: program.structs ?? [],
    functions: [{ kind: 'FunctionDefinition', name: program.function ?? 'main', returnType: INT, params: [], statements: program.statements ?? [] }],
  };
}

function callFunction(ctx, fn, args, callerFrame, entry = false) {
  if (ctx.callDepth >= MAX_CALL_DEPTH) throw new Error(`maximum call depth (${MAX_CALL_DEPTH}) exceeded`);
  if (args.length !== fn.params.length) throw new Error(`${fn.name} expects ${fn.params.length} argument(s), got ${args.length}`);
  ctx.callDepth++;
  const frameId = entry ? 'main' : freshFrameId(fn.name);
  const frame = addFrame(ctx.state, {
    id: frameId, name: fn.name, callerId: callerFrame?.id ?? null,
    depth: callerFrame ? callerFrame.depth + 1 : 0, active: true,
  });
  const env = makeScope();
  pushTrace(ctx, { kind: 'EnterFrame', frameId, function: fn.name, callerId: frame.callerId });

  for (let i = 0; i < fn.params.length; i++) {
    const param = fn.params[i];
    const allocation = addAllocation(ctx.state, { name: param.name, type: param.type, storage: { kind: 'stack', frameId } });
    declareBinding(env, param.name, ref(allocation.id), param);
    env.ownedAllocations.push(allocation.id);
    assignToRef(ref(allocation.id), param.type, args[i], ctx, param);
    pushTrace(ctx, { kind: 'Parameter', frameId, name: param.name, allocationId: allocation.id, line: param.loc?.startLine ?? null });
  }

  let returnValue = null;
  for (const stmt of fn.statements) {
    const eventStart = ctx.trace.length;
    const result = execStatement(stmt, ctx, env, frame, fn, 0);
    snapshot(ctx, stmt, frame, eventStart);
    if (result?.control === 'return') { returnValue = result.value; break; }
    if (result?.control === 'break' || result?.control === 'continue') {
      throw semanticError(stmt, `${result.control} used outside a loop`);
    }
  }

  if (!entry) {
    endFrame(ctx.state, frameId);
    pushTrace(ctx, { kind: 'LeaveFrame', frameId, function: fn.name });
  }
  ctx.callDepth--;

  if (fn.returnType?.kind === 'void') return { type: { kind: 'void' }, value: { kind: 'void' } };
  if (!returnValue) {
    if (entry && fn.name === 'main') return { type: fn.returnType, value: { kind: 'scalar', value: 0 } };
    throw new Error(`function '${fn.name}' reached the end without returning ${typeToString(fn.returnType)}`);
  }
  return coerceRValue(fn.returnType, returnValue, fn);
}

function execStatement(stmt, ctx, env, frame, fn, loopDepth = 0) {
  switch (stmt.kind) {
    case 'Empty':
      return null;
    case 'Declaration':
      for (const decl of stmt.declarations) execDeclaration(decl, ctx, env, frame);
      return null;
    case 'ExpressionStatement':
      evalExpression(stmt.expression, ctx, env, frame, null);
      return null;
    case 'Return': {
      if (fn.returnType?.kind === 'void') {
        if (stmt.expression) throw semanticError(stmt, `void function '${fn.name}' cannot return a value`);
        pushTrace(ctx, { kind: 'Return', frameId: frame.id, line: stmt.loc?.startLine ?? null });
        return { control: 'return', value: null };
      }
      if (!stmt.expression) throw semanticError(stmt, `function '${fn.name}' must return ${typeToString(fn.returnType)}`);
      const rv = evalExpression(stmt.expression, ctx, env, frame, fn.returnType);
      pushTrace(ctx, { kind: 'Return', frameId: frame.id, line: stmt.loc?.startLine ?? null });
      return { control: 'return', value: coerceRValue(fn.returnType, rv, stmt) };
    }
    case 'Break':
      if (loopDepth <= 0) throw semanticError(stmt, 'break used outside a loop');
      pushTrace(ctx, { kind: 'Break', frameId: frame.id, line: stmt.loc?.startLine ?? null });
      return { control: 'break' };
    case 'Continue':
      if (loopDepth <= 0) throw semanticError(stmt, 'continue used outside a loop');
      pushTrace(ctx, { kind: 'Continue', frameId: frame.id, line: stmt.loc?.startLine ?? null });
      return { control: 'continue' };
    case 'Block':
      return execBlock(stmt, ctx, env, frame, fn, loopDepth);
    case 'If':
      return execIf(stmt, ctx, env, frame, fn, loopDepth);
    case 'While':
      return execWhile(stmt, ctx, env, frame, fn, loopDepth);
    case 'For':
      return execFor(stmt, ctx, env, frame, fn, loopDepth);
    default:
      throw new Error(`interpreter does not support statement ${stmt.kind}`);
  }
}

function execBlock(stmt, ctx, parentEnv, frame, fn, loopDepth) {
  const local = makeScope(parentEnv);
  try {
    for (const child of stmt.statements) {
      const result = execEmbeddedStatement(child, ctx, local, frame, fn, loopDepth);
      if (result?.control) return result;
    }
    return null;
  } finally {
    closeScope(ctx, local, frame);
  }
}

function execIf(stmt, ctx, env, frame, fn, loopDepth) {
  const condition = evalCondition(stmt.condition, ctx, env, frame);
  pushTrace(ctx, {
    kind: 'Condition', statement: 'if', result: condition,
    frameId: frame.id, line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
  });
  const branch = condition ? stmt.consequence : stmt.alternative;
  if (!branch) return null;
  return execEmbeddedStatement(branch, ctx, env, frame, fn, loopDepth);
}

function execWhile(stmt, ctx, env, frame, fn, loopDepth) {
  let iterations = 0;
  while (true) {
    const condition = evalCondition(stmt.condition, ctx, env, frame);
    pushTrace(ctx, {
      kind: 'Condition', statement: 'while', result: condition, iteration: iterations,
      frameId: frame.id, line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
    });
    if (!condition) return null;
    guardLoopIteration(++iterations, stmt);
    pushTrace(ctx, { kind: 'LoopIteration', statement: 'while', iteration: iterations, frameId: frame.id, line: stmt.loc?.startLine ?? null });
    const result = execEmbeddedStatement(stmt.body, ctx, env, frame, fn, loopDepth + 1);
    if (result?.control === 'return') return result;
    if (result?.control === 'break') return null;
    // continue, or normal completion, returns to the condition.
  }
}

function execFor(stmt, ctx, parentEnv, frame, fn, loopDepth) {
  // A declaration in a for initializer has loop scope in C and must not leak
  // after the loop. A dedicated scope also allows it to shadow an outer name.
  const loopEnv = makeScope(parentEnv);
  try {
    if (stmt.initializer) {
      const initResult = execEmbeddedStatement(stmt.initializer, ctx, loopEnv, frame, fn, loopDepth);
      if (initResult?.control) return initResult;
    }

    let iterations = 0;
    while (true) {
      const condition = stmt.condition ? evalCondition(stmt.condition, ctx, loopEnv, frame) : true;
      pushTrace(ctx, {
        kind: 'Condition', statement: 'for', result: condition, iteration: iterations,
        frameId: frame.id, line: stmt.condition?.loc?.startLine ?? stmt.loc?.startLine ?? null,
      });
      if (!condition) return null;
      guardLoopIteration(++iterations, stmt);
      pushTrace(ctx, { kind: 'LoopIteration', statement: 'for', iteration: iterations, frameId: frame.id, line: stmt.loc?.startLine ?? null });

      const result = execEmbeddedStatement(stmt.body, ctx, loopEnv, frame, fn, loopDepth + 1);
      if (result?.control === 'return') return result;
      if (result?.control === 'break') return null;

      // In C, continue in a for loop still executes the update expression.
      if (stmt.update) {
        const start = ctx.trace.length;
        evalExpression(stmt.update, ctx, loopEnv, frame, null);
        snapshot(ctx, { kind: 'ForUpdate', loc: stmt.update.loc ?? stmt.loc }, frame, start);
      }
    }
  } finally {
    closeScope(ctx, loopEnv, frame);
  }
}

function execEmbeddedStatement(stmt, ctx, env, frame, fn, loopDepth) {
  const start = ctx.trace.length;
  const result = execStatement(stmt, ctx, env, frame, fn, loopDepth);
  // Blocks snapshot their executed children. Other embedded statements need an
  // explicit snapshot because they are not visited by callFunction()/execBlock().
  if (stmt.kind !== 'Block') snapshot(ctx, stmt, frame, start);
  return result;
}

function execDeclaration(decl, ctx, env, frame) {
  if (env.bindings.has(decl.name)) throw semanticError(decl, `redeclaration of '${decl.name}'`);
  const allocation = addAllocation(ctx.state, { name: decl.name, type: decl.type, storage: { kind: 'stack', frameId: frame.id } });
  declareBinding(env, decl.name, ref(allocation.id), decl);
  env.ownedAllocations.push(allocation.id);
  pushTrace(ctx, { kind: 'Declare', frameId: frame.id, name: decl.name, allocationId: allocation.id, type: decl.type, line: decl.loc?.startLine ?? null });
  if (!decl.initializer) return;
  if (isArray(decl.type) || isStruct(decl.type)) {
    initializeAggregate(ref(allocation.id), decl.type, decl.initializer, ctx, env, frame, decl);
    return;
  }
  const rv = evalExpression(decl.initializer, ctx, env, frame, decl.type);
  assignToRef(ref(allocation.id), decl.type, rv, ctx, decl);
}

function initializeAggregate(targetRef, type, initializer, ctx, env, frame, node) {
  if (initializer.kind !== 'InitializerList') {
    // Struct copy initialization is useful for function/local code.
    if (isStruct(type)) {
      const rv = evalExpression(initializer, ctx, env, frame, type);
      assignToRef(targetRef, type, rv, ctx, node);
      return;
    }
    throw semanticError(node, `${typeToString(type)} initialization currently requires { ... }`);
  }
  if (isArray(type)) {
    if (initializer.elements.length > type.length) throw semanticError(node, `too many initializers for ${typeToString(type)}`);
    for (let i = 0; i < type.length; i++) {
      const elemRef = ref(targetRef.allocationId, [...targetRef.path, i]);
      if (i >= initializer.elements.length) { zeroInitialize(elemRef, type.of, ctx); continue; }
      if (isArray(type.of) || isStruct(type.of)) initializeAggregate(elemRef, type.of, initializer.elements[i], ctx, env, frame, node);
      else assignToRef(elemRef, type.of, evalExpression(initializer.elements[i], ctx, env, frame, type.of), ctx, node);
    }
    return;
  }
  if (isStruct(type)) {
    const def = resolveStructType(type, ctx.state.structTypes);
    if (initializer.elements.length > def.fields.length) throw semanticError(node, `too many initializers for struct ${type.name}`);
    for (let i = 0; i < def.fields.length; i++) {
      const field = def.fields[i], fieldRef = ref(targetRef.allocationId, [...targetRef.path, field.name]);
      if (i >= initializer.elements.length) { zeroInitialize(fieldRef, field.type, ctx); continue; }
      if (isArray(field.type) || isStruct(field.type)) initializeAggregate(fieldRef, field.type, initializer.elements[i], ctx, env, frame, node);
      else assignToRef(fieldRef, field.type, evalExpression(initializer.elements[i], ctx, env, frame, field.type), ctx, node);
    }
  }
}

function zeroInitialize(targetRef, type, ctx) {
  if (isPrimitive(type)) setRefValue(ctx.state, targetRef, { kind: 'scalar', value: 0 });
  else if (isPointer(type)) setRefValue(ctx.state, targetRef, { kind: 'null' });
  else {
    const resolved = resolveRef(ctx.state, targetRef);
    if (isArray(type)) for (let i = 0; i < type.length; i++) zeroInitialize(ref(targetRef.allocationId, [...targetRef.path, i]), type.of, ctx);
    else if (isStruct(type)) {
      const def = resolveStructType(type, ctx.state.structTypes);
      for (const f of def.fields) zeroInitialize(ref(targetRef.allocationId, [...targetRef.path, f.name]), f.type, ctx);
    } else throw new Error(`cannot zero initialize ${resolved.label}`);
  }
}

function evalExpression(expr, ctx, env, frame, expectedType = null) {
  switch (expr.kind) {
    case 'IntLiteral': return { type: INT, value: { kind: 'scalar', value: expr.value } };
    case 'CharLiteral': return { type: CHAR, value: { kind: 'scalar', value: decodeCharLiteral(expr.raw) } };
    case 'NullLiteral': return { type: { kind: 'null-pointer-constant' }, value: { kind: 'null' } };
    case 'Identifier': {
      if (expr.name === 'NULL') return { type: { kind: 'null-pointer-constant' }, value: { kind: 'null' } };
      const lv = evalLValue(expr, ctx, env, frame);
      if (isArray(lv.type)) {
        const allocation = getAllocation(ctx.state, lv.ref.allocationId);
        // Array subobjects decay to their first element rather than always the allocation root.
        const target = lv.ref.path.length ? ref(lv.ref.allocationId, [...lv.ref.path, 0]) : decayRef(allocation);
        return { type: pointer(lv.type.of), value: pointerValue(target) };
      }
      return loadLValue(lv, ctx, expr);
    }
    case 'AddressOf': {
      const lv = evalLValue(expr.expression, ctx, env, frame);
      return { type: pointer(lv.type), value: pointerValue(lv.ref) };
    }
    case 'Dereference':
    case 'Subscript':
    case 'Member': return loadLValue(evalLValue(expr, ctx, env, frame), ctx, expr);
    case 'Assignment': {
      const lhs = evalLValue(expr.left, ctx, env, frame);
      if (isArray(lhs.type)) throw semanticError(expr, 'arrays are not assignable');
      if (expr.operator === '=') {
        const rhs = evalExpression(expr.right, ctx, env, frame, lhs.type);
        const value = assignToRef(lhs.ref, lhs.type, rhs, ctx, expr);
        return { type: lhs.type, value };
      }
      if (['+=', '-=', '*=', '/=', '%='].includes(expr.operator)) {
        const current = loadLValue(lhs, ctx, expr);
        const rhs = evalExpression(expr.right, ctx, env, frame, null);
        const result = evalCompoundAssignment(expr.operator, current, rhs, ctx, expr);
        const value = assignToRef(lhs.ref, lhs.type, result, ctx, expr);
        return { type: lhs.type, value };
      }
      throw semanticError(expr, `assignment operator '${expr.operator}' is not supported yet`);
    }
    case 'Call': return evalCall(expr, ctx, env, frame, expectedType);
    case 'Unary': {
      if (expr.operator === '!') {
        const rv = evalExpression(expr.expression, ctx, env, frame, null);
        return { type: INT, value: { kind: 'scalar', value: truthy(rv, expr) ? 0 : 1 } };
      }
      const rv = evalExpression(expr.expression, ctx, env, frame, INT); requireInteger(rv, expr);
      return { type: INT, value: { kind: 'scalar', value: expr.operator === '-' ? -rv.value.value : rv.value.value } };
    }
    case 'Update': {
      const lv = evalLValue(expr.expression, ctx, env, frame);
      const current = loadLValue(lv, ctx, expr);
      let next;
      if (isPointer(current.type)) {
        if (current.value.kind !== 'pointer') throw semanticError(expr, 'pointer update requires a concrete pointer');
        next = { type: current.type, value: addToPointer(ctx.state, current.value, expr.operator === '++' ? 1 : -1, expr) };
      } else {
        requireInteger(current, expr);
        next = { type: current.type, value: { kind: 'scalar', value: current.value.value + (expr.operator === '++' ? 1 : -1) } };
      }
      assignToRef(lv.ref, lv.type, next, ctx, expr);
      return expr.prefix ? next : current;
    }
    case 'Binary': return evalBinary(expr, ctx, env, frame);
    case 'SizeofType': return { type: INT, value: { kind: 'scalar', value: sizeOf(expr.type, ctx.state.structTypes) } };
    case 'SizeofExpression': return { type: INT, value: { kind: 'scalar', value: sizeOf(inferExpressionType(expr.expression, ctx, env, frame), ctx.state.structTypes) } };
    case 'InitializerList': throw semanticError(expr, 'initializer list is only valid in an aggregate declaration');
    default: throw semanticError(expr, `unsupported expression ${expr.kind}`);
  }
}

function evalLValue(expr, ctx, env, frame) {
  if (expr.kind === 'Identifier') {
    const r = lookupBinding(env, expr.name);
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`);
    return { ref: r, type: refType(ctx.state, r) };
  }
  if (expr.kind === 'Dereference') {
    const rv = evalExpression(expr.expression, ctx, env, frame, null);
    if (!isPointer(rv.type)) throw semanticError(expr, `cannot dereference ${typeToString(rv.type)}`);
    if (rv.value.kind !== 'pointer') throw semanticError(expr, `cannot dereference ${rv.value.kind} pointer`);
    const resolved = resolveRef(ctx.state, rv.value.target, { allowDead: true });
    if (!resolved.allocation.alive) throw semanticError(expr, 'dereference of dangling pointer');
    if (resolved.onePast || resolved.invalid) throw semanticError(expr, 'dereference outside object bounds');
    return { ref: rv.value.target, type: resolved.type };
  }
  if (expr.kind === 'Subscript') {
    const base = evalExpression(expr.array, ctx, env, frame, null);
    const index = evalExpression(expr.index, ctx, env, frame, INT); requireInteger(index, expr.index);
    if (!isPointer(base.type) || base.value.kind !== 'pointer') throw semanticError(expr, 'subscript requires an array or concrete pointer');
    const advanced = addToPointer(ctx.state, base.value, index.value.value, expr);
    const resolved = resolveRef(ctx.state, advanced.target);
    if (!resolved.allocation.alive || resolved.onePast || resolved.invalid) throw semanticError(expr, 'subscript outside live object bounds');
    return { ref: advanced.target, type: base.type.to };
  }
  if (expr.kind === 'Member') {
    let baseRef, baseType;
    if (expr.viaPointer) {
      const rv = evalExpression(expr.object, ctx, env, frame, null);
      if (!isPointer(rv.type) || !isStruct(rv.type.to)) throw semanticError(expr, "'->' requires a pointer to struct");
      if (rv.value.kind !== 'pointer') throw semanticError(expr, "'->' requires a concrete pointer");
      const resolved = resolveRef(ctx.state, rv.value.target);
      if (!resolved.allocation.alive) throw semanticError(expr, "'->' through dangling pointer");
      baseRef = rv.value.target; baseType = rv.type.to;
    } else {
      const lv = evalLValue(expr.object, ctx, env, frame);
      if (!isStruct(lv.type)) throw semanticError(expr, "'.' requires a struct object");
      baseRef = lv.ref; baseType = lv.type;
    }
    const def = resolveStructType(baseType, ctx.state.structTypes);
    const field = def.fields?.find(f => f.name === expr.field);
    if (!field) throw semanticError(expr, `struct ${baseType.name} has no field '${expr.field}'`);
    return { ref: ref(baseRef.allocationId, [...baseRef.path, expr.field]), type: field.type };
  }
  throw semanticError(expr, 'expression is not assignable');
}

function loadLValue(lvalue, ctx, node) {
  const resolved = resolveRef(ctx.state, lvalue.ref, { allowDead: true });
  if (!resolved.allocation.alive) throw semanticError(node, `read from object whose lifetime has ended`);
  if (resolved.onePast || resolved.invalid) throw semanticError(node, 'read outside object bounds');
  if (resolved.value.kind === 'uninit') throw semanticError(node, `read of uninitialized ${resolved.label}`);
  return { type: lvalue.type, value: structuredClone(resolved.value) };
}

function assignToRef(targetRef, targetType, rv, ctx, node) {
  const value = coerceRValue(targetType, rv, node).value;
  setRefValue(ctx.state, targetRef, value);
  pushTrace(ctx, { kind: 'Write', target: structuredClone(targetRef), type: targetType, value: structuredClone(value), line: node.loc?.startLine ?? null });
  return structuredClone(value);
}

function coerceRValue(targetType, rv, node) {
  if (isPrimitive(targetType)) {
    if (!isPrimitive(rv.type) || rv.value.kind !== 'scalar') throw semanticError(node, `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`);
    return { type: targetType, value: { kind: 'scalar', value: rv.value.value } };
  }
  if (isPointer(targetType)) {
    if (rv.value.kind === 'null' || (isIntegerRuntime(rv) && rv.value.value === 0)) return { type: targetType, value: { kind: 'null' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer') throw semanticError(node, `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`);
    if (!typeEquals(targetType, rv.type)) throw semanticError(node, `incompatible pointer types: ${typeToString(targetType)} and ${typeToString(rv.type)}`);
    return { type: targetType, value: structuredClone(rv.value) };
  }
  if (isStruct(targetType)) {
    if (!isStruct(rv.type) || !typeEquals(targetType, rv.type) || rv.value.kind !== 'aggregate') throw semanticError(node, `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`);
    return { type: targetType, value: structuredClone(rv.value) };
  }
  throw semanticError(node, `assignment to ${typeToString(targetType)} is not supported`);
}

function evalCall(expr, ctx, env, frame, expectedType) {
  if (expr.name === 'malloc') {
    if (!expectedType || !isPointer(expectedType)) throw semanticError(expr, 'malloc result must be assigned where a pointer type is known');
    if (expr.arguments.length !== 1) throw semanticError(expr, 'malloc expects exactly one argument');
    const sizeRv = evalExpression(expr.arguments[0], ctx, env, frame, INT); requireInteger(sizeRv, expr.arguments[0]);
    const bytes = sizeRv.value.value;
    const elemBytes = sizeOf(expectedType.to, ctx.state.structTypes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % elemBytes !== 0) throw semanticError(expr, `malloc size ${bytes} is not a positive multiple of sizeof(${typeToString(expectedType.to)}) (${elemBytes})`);
    const count = bytes / elemBytes;
    if (count > MAX_HEAP_ELEMENTS) throw semanticError(expr, `malloc would create ${count} elements; PointerViz limits one allocation to ${MAX_HEAP_ELEMENTS}`);
    const allocation = addAllocation(ctx.state, { type: heapAllocationType(expectedType.to, count), storage: { kind: 'heap' }, alive: true });
    const target = isArray(allocation.type) ? ref(allocation.id, [0]) : ref(allocation.id, []);
    pushTrace(ctx, { kind: 'Allocate', allocationId: allocation.id, bytes, count, line: expr.loc?.startLine ?? null });
    return { type: expectedType, value: pointerValue(target) };
  }

  if (expr.name === 'free') {
    if (expr.arguments.length !== 1) throw semanticError(expr, 'free expects exactly one argument');
    const rv = evalExpression(expr.arguments[0], ctx, env, frame, null);
    if (rv.value.kind === 'null' || (isIntegerRuntime(rv) && rv.value.value === 0)) return { type: INT, value: { kind: 'scalar', value: 0 } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer') throw semanticError(expr, 'free expects a pointer or NULL');
    const target = rv.value.target, allocation = getAllocation(ctx.state, target.allocationId);
    if (allocation.storage.kind !== 'heap') throw semanticError(expr, 'free() requires heap memory');
    if (!allocation.alive) throw semanticError(expr, 'double free');
    const basePath = isArray(allocation.type) ? [0] : [];
    if (!samePath(target.path, basePath)) throw semanticError(expr, 'free() requires the original allocation pointer, not an interior pointer');
    allocation.alive = false;
    pushTrace(ctx, { kind: 'Free', allocationId: allocation.id, line: expr.loc?.startLine ?? null });
    return { type: INT, value: { kind: 'scalar', value: 0 } };
  }

  const fn = ctx.functions.get(expr.name);
  if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`);
  if (expr.arguments.length !== fn.params.length) throw semanticError(expr, `${expr.name} expects ${fn.params.length} argument(s), got ${expr.arguments.length}`);
  const args = expr.arguments.map((arg, i) => evalExpression(arg, ctx, env, frame, fn.params[i].type));
  return callFunction(ctx, fn, args, frame, false);
}

function evalBinary(expr, ctx, env, frame) {
  // Logical operators must short-circuit because the skipped operand may have
  // side effects or be unsafe to evaluate (for example p && *p).
  const left = evalExpression(expr.left, ctx, env, frame, null);
  if (expr.operator === '&&') {
    if (!truthy(left, expr.left)) return intResult(0);
    const right = evalExpression(expr.right, ctx, env, frame, null);
    return intResult(truthy(right, expr.right) ? 1 : 0);
  }
  if (expr.operator === '||') {
    if (truthy(left, expr.left)) return intResult(1);
    const right = evalExpression(expr.right, ctx, env, frame, null);
    return intResult(truthy(right, expr.right) ? 1 : 0);
  }

  const right = evalExpression(expr.right, ctx, env, frame, null);

  if (['==', '!='].includes(expr.operator)) {
    const equal = scalarEquals(left, right, ctx, expr);
    return intResult(expr.operator === '==' ? Number(equal) : Number(!equal));
  }

  if (['<', '<=', '>', '>='].includes(expr.operator)) {
    const cmp = compareScalars(left, right, ctx, expr);
    const result = expr.operator === '<' ? cmp < 0
      : expr.operator === '<=' ? cmp <= 0
      : expr.operator === '>' ? cmp > 0
      : cmp >= 0;
    return intResult(Number(result));
  }

  if (['+', '-'].includes(expr.operator)) {
    if (isPointer(left.type) && isIntegerRuntime(right)) {
      if (left.value.kind !== 'pointer') throw semanticError(expr, 'pointer arithmetic requires a concrete pointer');
      return { type: left.type, value: addToPointer(ctx.state, left.value, expr.operator === '+' ? right.value.value : -right.value.value, expr) };
    }
    if (expr.operator === '+' && isIntegerRuntime(left) && isPointer(right.type)) {
      if (right.value.kind !== 'pointer') throw semanticError(expr, 'pointer arithmetic requires a concrete pointer');
      return { type: right.type, value: addToPointer(ctx.state, right.value, left.value.value, expr) };
    }
    if (isIntegerRuntime(left) && isIntegerRuntime(right)) {
      return intResult(expr.operator === '+' ? left.value.value + right.value.value : left.value.value - right.value.value);
    }
    if (expr.operator === '-' && isPointer(left.type) && isPointer(right.type) && typeEquals(left.type, right.type)) {
      if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(expr, 'pointer subtraction requires concrete pointers');
      const a = arrayPosition(ctx.state, left.value.target), b = arrayPosition(ctx.state, right.value.target);
      if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix)) throw semanticError(expr, 'pointer subtraction requires pointers into the same array');
      return intResult(a.index - b.index);
    }
  }

  if (['*', '/', '%'].includes(expr.operator)) {
    requireInteger(left, expr.left); requireInteger(right, expr.right);
    if ((expr.operator === '/' || expr.operator === '%') && right.value.value === 0) throw semanticError(expr, 'division by zero');
    const n = expr.operator === '*' ? left.value.value * right.value.value
      : expr.operator === '/' ? Math.trunc(left.value.value / right.value.value)
      : left.value.value % right.value.value;
    return intResult(n);
  }
  throw semanticError(expr, `binary operator '${expr.operator}' is not supported yet`);
}

function evalCompoundAssignment(operator, left, right, ctx, node) {
  const op = operator.slice(0, -1);
  if ((op === '+' || op === '-') && isPointer(left.type)) {
    requireInteger(right, node);
    if (left.value.kind !== 'pointer') throw semanticError(node, 'pointer compound assignment requires a concrete pointer');
    return { type: left.type, value: addToPointer(ctx.state, left.value, op === '+' ? right.value.value : -right.value.value, node) };
  }
  requireInteger(left, node); requireInteger(right, node);
  if ((op === '/' || op === '%') && right.value.value === 0) throw semanticError(node, 'division by zero');
  const value = op === '+' ? left.value.value + right.value.value
    : op === '-' ? left.value.value - right.value.value
    : op === '*' ? left.value.value * right.value.value
    : op === '/' ? Math.trunc(left.value.value / right.value.value)
    : left.value.value % right.value.value;
  return { type: left.type, value: { kind: 'scalar', value } };
}

function evalCondition(expr, ctx, env, frame) {
  return truthy(evalExpression(expr, ctx, env, frame, null), expr);
}

function truthy(rv, node) {
  if (isPrimitive(rv.type) && rv.value.kind === 'scalar') return rv.value.value !== 0;
  if (rv.value.kind === 'null') return false;
  if (isPointer(rv.type) && rv.value.kind === 'pointer') return true;
  throw semanticError(node, `condition requires a scalar value, got ${typeToString(rv.type)}`);
}

function scalarEquals(left, right, ctx, node) {
  if (isIntegerRuntime(left) && isIntegerRuntime(right)) return left.value.value === right.value.value;

  const leftNull = isNullLike(left), rightNull = isNullLike(right);
  if (leftNull && rightNull) return true;
  if (isPointer(left.type) && left.value.kind === 'pointer' && rightNull) return false;
  if (isPointer(right.type) && right.value.kind === 'pointer' && leftNull) return false;

  if (isPointer(left.type) && isPointer(right.type)) {
    if (!typeEquals(left.type, right.type)) throw semanticError(node, `comparison of incompatible pointer types ${typeToString(left.type)} and ${typeToString(right.type)}`);
    if (left.value.kind === 'null' || right.value.kind === 'null') return left.value.kind === right.value.kind;
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(node, 'pointer comparison requires initialized pointer values');
    return sameRefValue(left.value.target, right.value.target);
  }
  throw semanticError(node, `cannot compare ${typeToString(left.type)} and ${typeToString(right.type)}`);
}

function compareScalars(left, right, ctx, node) {
  if (isIntegerRuntime(left) && isIntegerRuntime(right)) return Math.sign(left.value.value - right.value.value);
  if (isPointer(left.type) && isPointer(right.type) && typeEquals(left.type, right.type)) {
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(node, 'relational pointer comparison requires concrete pointers');
    const a = arrayPosition(ctx.state, left.value.target), b = arrayPosition(ctx.state, right.value.target);
    if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix)) {
      throw semanticError(node, 'relational pointer comparison requires pointers into the same array');
    }
    return Math.sign(a.index - b.index);
  }
  throw semanticError(node, `relational comparison requires numbers or pointers into the same array`);
}

function isNullLike(rv) {
  return rv.value.kind === 'null' || (isIntegerRuntime(rv) && rv.value.value === 0);
}

function sameRefValue(a, b) {
  return a.allocationId === b.allocationId && samePath(a.path ?? [], b.path ?? []);
}

function intResult(value) { return { type: INT, value: { kind: 'scalar', value } }; }

function addToPointer(state, value, delta, node) {
  const pos = arrayPosition(state, value.target);
  if (!pos) { if (delta === 0) return structuredClone(value); throw semanticError(node, 'pointer arithmetic is only supported within arrays/malloc blocks'); }
  const next = pos.index + delta;
  if (next < 0 || next > pos.length) throw semanticError(node, `pointer arithmetic moves outside allocation bounds (index ${next})`);
  return pointerValue(ref(pos.allocationId, [...pos.prefix, next]));
}

/** Find the nearest array component in a reference path, including arrays inside structs. */
function arrayPosition(state, targetRef) {
  const allocation = getAllocation(state, targetRef.allocationId);
  let type = allocation.type;
  const path = targetRef.path ?? [], prefix = [];
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type) && Number.isInteger(part)) return { allocationId: allocation.id, prefix: [...prefix], index: part, length: type.length };
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes), field = def.fields.find(f => f.name === part);
      if (!field) return null; type = field.type; prefix.push(part); continue;
    }
    return null;
  }
  return null;
}

function makeScope(parent = null) {
  return { parent, bindings: new Map(), ownedAllocations: [] };
}

function declareBinding(scope, name, targetRef, node) {
  if (scope.bindings.has(name)) throw semanticError(node, `redeclaration of '${name}'`);
  scope.bindings.set(name, targetRef);
}

function lookupBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const target = current.bindings.get(name);
    if (target) return target;
  }
  return null;
}

function closeScope(ctx, scope, frame) {
  for (const id of scope.ownedAllocations) {
    const allocation = getAllocation(ctx.state, id);
    if (allocation.storage.kind === 'stack' && allocation.storage.frameId === frame.id && allocation.alive) {
      allocation.alive = false;
      pushTrace(ctx, { kind: 'EndLifetime', allocationId: id, frameId: frame.id });
    }
  }
}

function guardLoopIteration(iterations, stmt) {
  if (iterations > MAX_LOOP_ITERATIONS) {
    throw semanticError(stmt, `loop exceeded ${MAX_LOOP_ITERATIONS} iterations; possible infinite loop`);
  }
}

function inferExpressionType(expr, ctx, env, frame) {
  if (expr.kind === 'Identifier') {
    const r = lookupBinding(env, expr.name);
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`);
    return refType(ctx.state, r);
  }
  if (expr.kind === 'Dereference') { const t = inferExpressionType(expr.expression, ctx, env, frame); if (!isPointer(t)) throw semanticError(expr, 'cannot dereference non-pointer'); return t.to; }
  if (expr.kind === 'AddressOf') return pointer(inferExpressionType(expr.expression, ctx, env, frame));
  if (expr.kind === 'Subscript') { const t = inferExpressionType(expr.array, ctx, env, frame); return isArray(t) ? t.of : isPointer(t) ? t.to : (() => { throw semanticError(expr, 'subscripted expression has no element type'); })(); }
  if (expr.kind === 'Member') return evalLValue(expr, ctx, env, frame).type;
  if (expr.kind === 'IntLiteral') return INT;
  if (expr.kind === 'CharLiteral') return CHAR;
  if (expr.kind === 'Call') { const fn = ctx.functions.get(expr.name); return fn?.returnType ?? INT; }
  return evalExpression(expr, ctx, env, frame, null).type;
}

function snapshot(ctx, stmt, frame, eventStart) {
  ctx.steps++;
  if (ctx.steps > MAX_TRACE_STEPS) throw new Error(`execution exceeded ${MAX_TRACE_STEPS} visualized statements`);
  ctx.snapshots.push({
    line: stmt.loc?.endLine ?? stmt.loc?.startLine ?? null,
    function: frame.name, frameId: frame.id, statement: stmt.kind,
    events: ctx.trace.slice(eventStart), state: cloneState(ctx.state),
  });
}

function pushTrace(ctx, event) { ctx.trace.push(event); if (ctx.trace.length > MAX_TRACE_STEPS * 8) throw new Error('execution trace is too large'); }
function requireInteger(rv, node) { if (!isIntegerRuntime(rv)) throw semanticError(node, `expected integer, got ${typeToString(rv.type)}`); }
function isIntegerRuntime(rv) { return isPrimitive(rv.type) && rv.value.kind === 'scalar'; }
function samePath(a = [], b = []) { return a.length === b.length && a.every((x, i) => x === b[i]); }

function decodeCharLiteral(raw) {
  const body = raw.slice(1, -1);
  if (!body.startsWith('\\')) return body.codePointAt(0) ?? 0;
  const escapes = { '\\0': 0, '\\n': 10, '\\r': 13, '\\t': 9, '\\b': 8, '\\f': 12, '\\v': 11, "\\'": 39, '\\"': 34, '\\\\': 92, '\\a': 7 };
  if (Object.hasOwn(escapes, body)) return escapes[body];
  if (/^\\x[0-9a-fA-F]+$/.test(body)) return Number.parseInt(body.slice(2), 16);
  if (/^\\[0-7]{1,3}$/.test(body)) return Number.parseInt(body.slice(1), 8);
  throw new Error(`unsupported character escape '${raw}'`);
}
function semanticError(node, message) { const line = node?.loc?.startLine; return new Error(line ? `${message} (line ${line})` : message); }
