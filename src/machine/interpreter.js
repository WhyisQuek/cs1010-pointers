/**
 * PointerViz Mini-C semantic interpreter.
 *
 * Functions use explicit call frames; blocks and for-loops use lexical scopes.
 * if/while/for execute directly from the Mini-C AST and loops are bounded for
 * browser safety. Structs remain regular aggregate allocations with subobjects.
 * Executed statements emit trace events and snapshots for step-through playback.
 */
import {
  INT, alignmentOf, isArray, isPointer, isPrimitive, isStruct, pointer, resolveStructType,
  sizeOf, typeEquals, typeToString,
} from '../language/types.js';
import { MAX_CALL_DEPTH, MAX_HEAP_ELEMENTS, MAX_LOOP_ITERATIONS, MAX_TRACE_STEPS } from '../language/limits.js';
import { SIZE_T, arithmeticType, convertNumber, isFloatingType, isIntegerType, numericOperation, promote } from '../language/numeric.js';
import { checkProgram } from '../language/checker.js';
import { decodeCharLiteral } from '../language/literals.js';
import {
  addAllocation, addFrame, cloneState, decayRef, endFrame, freshFrameId, getAllocation,
  heapAllocationType, makeState, pointerValue, ref, refType, resetAllocationIds,
  resolveRef, setRefValue,
} from './memory.js';

export function executeProgram(program) {
  resetAllocationIds();
  const normalized = normalizeProgram(program);
  checkProgram(normalized);
  const structTypes = Object.fromEntries((normalized.structs ?? []).map(s => [s.name, structuredClone(s)]));
  const state = makeState(structTypes);
  const ctx = {
    state,
    functions: new Map(normalized.functions.map(fn => [fn.name, fn])),
    snapshots: [],
    trace: [],
    callDepth: 0,
    steps: 0,
    snapshotTraceIndex: 0,
    accesses: [],
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
  snapshot(ctx, { kind: 'EnterFrame', loc: { startLine: fn.loc?.startLine } }, frame);

  let returnValue = null;
  for (const stmt of fn.statements) {
    const result = execEmbeddedStatement(stmt, ctx, env, frame, fn, 0);
    if (result?.control === 'return') { returnValue = result.value; break; }
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
    if (local.ownedAllocations.some(id => getAllocation(ctx.state, id).alive)) markNext(ctx, { loc: { startLine: stmt.loc?.endLine } }, frame);
    closeScope(ctx, local, frame);
  }
}

function execIf(stmt, ctx, env, frame, fn, loopDepth) {
  markNext(ctx, stmt.condition, frame);
  const condition = evalCondition(stmt.condition, ctx, env, frame);
  pushTrace(ctx, {
    kind: 'Condition', statement: 'if', result: condition,
    frameId: frame.id, line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
  });
  snapshot(ctx, { kind: 'IfCondition', loc: stmt.condition.loc ?? stmt.loc }, frame);
  const branch = condition ? stmt.consequence : stmt.alternative;
  if (!branch) return null;
  return execEmbeddedStatement(branch, ctx, env, frame, fn, loopDepth);
}

function execWhile(stmt, ctx, env, frame, fn, loopDepth) {
  let iterations = 0;
  while (true) {
    markNext(ctx, stmt.condition, frame);
    const condition = evalCondition(stmt.condition, ctx, env, frame);
    pushTrace(ctx, {
      kind: 'Condition', statement: 'while', result: condition, iteration: iterations,
      frameId: frame.id, line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
    });
    snapshot(ctx, { kind: 'WhileCondition', loc: stmt.condition.loc ?? stmt.loc }, frame);
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
      markNext(ctx, stmt.condition ?? stmt, frame);
      const condition = stmt.condition ? evalCondition(stmt.condition, ctx, loopEnv, frame) : true;
      pushTrace(ctx, {
        kind: 'Condition', statement: 'for', result: condition, iteration: iterations,
        frameId: frame.id, line: stmt.condition?.loc?.startLine ?? stmt.loc?.startLine ?? null,
      });
      snapshot(ctx, { kind: 'ForCondition', loc: stmt.condition?.loc ?? stmt.loc }, frame);
      if (!condition) return null;
      guardLoopIteration(++iterations, stmt);
      pushTrace(ctx, { kind: 'LoopIteration', statement: 'for', iteration: iterations, frameId: frame.id, line: stmt.loc?.startLine ?? null });

      const result = execEmbeddedStatement(stmt.body, ctx, loopEnv, frame, fn, loopDepth + 1);
      if (result?.control === 'return') return result;
      if (result?.control === 'break') return null;

      // In C, continue in a for loop still executes the update expression.
      if (stmt.update) {
        markNext(ctx, stmt.update, frame);
        evalExpression(stmt.update, ctx, loopEnv, frame, null);
        snapshot(ctx, { kind: 'ForUpdate', loc: stmt.update.loc ?? stmt.loc }, frame);
      }
    }
  } finally {
    if (loopEnv.ownedAllocations.some(id => getAllocation(ctx.state, id).alive)) markNext(ctx, { loc: { startLine: stmt.loc?.endLine } }, frame);
    closeScope(ctx, loopEnv, frame);
  }
}

function execEmbeddedStatement(stmt, ctx, env, frame, fn, loopDepth) {
  if (stmt.kind === 'Empty') return null;
  const compound = ['Block', 'If', 'While', 'For'].includes(stmt.kind);
  if (!compound) markNext(ctx, stmt, frame);
  const count = ctx.snapshots.length;
  const result = execStatement(stmt, ctx, env, frame, fn, loopDepth);
  // Conditions and children emit their own snapshots. Only unrecorded actions
  // (including scope cleanup) need another one; never repeat a call's events.
  const pending = ctx.trace.slice(ctx.snapshotTraceIndex);
  if ((!compound && (count === ctx.snapshots.length || pending.length)) || (compound && pending.some(e => e.kind === 'EndLifetime'))) {
    snapshot(ctx, compound ? { kind: 'EndScope', loc: { startLine: stmt.loc?.endLine } } : stmt, frame);
  }
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
  const cursor = { index: 0 };
  initializeMembers(targetRef, type, initializer.elements, cursor, ctx, env, frame, node);
  if (cursor.index < initializer.elements.length) throw semanticError(node, `too many initializers for ${typeToString(type)}`);
}

function initializeMembers(targetRef, type, elements, cursor, ctx, env, frame, node) {
  const members = isArray(type)
    ? Array.from({ length: type.length }, (_, i) => ({ name: i, type: type.of }))
    : resolveStructType(type, ctx.state.structTypes).fields;
  for (const member of members) {
    const childRef = ref(targetRef.allocationId, [...targetRef.path, member.name]);
    if (cursor.index >= elements.length) { zeroInitialize(childRef, member.type, ctx); continue; }
    const child = elements[cursor.index];
    if (isArray(member.type) || isStruct(member.type)) {
      if (child.kind === 'InitializerList') {
        cursor.index++;
        initializeAggregate(childRef, member.type, child, ctx, env, frame, node);
      } else if (isStruct(member.type) && typeEquals(member.type, inferExpressionType(child, ctx, env, frame))) {
        cursor.index++;
        assignToRef(childRef, member.type, evalExpression(child, ctx, env, frame, member.type), ctx, node);
      } else initializeMembers(childRef, member.type, elements, cursor, ctx, env, frame, node);
    } else {
      cursor.index++;
      assignToRef(childRef, member.type, evalExpression(child, ctx, env, frame, member.type), ctx, node);
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
  const result = evaluateExpression(expr, ctx, env, frame, expectedType);
  result.integerConstant = isIntegerType(result.type) && isConstantExpression(expr);
  return result;
}

function isConstantExpression(expr) {
  if (['IntLiteral', 'CharLiteral', 'SizeofType', 'SizeofExpression', 'NullLiteral'].includes(expr.kind)) return true;
  if (expr.kind === 'Identifier') return expr.name === 'NULL';
  if (expr.kind === 'Unary') return isConstantExpression(expr.expression);
  if (expr.kind === 'Binary') return isConstantExpression(expr.left) && isConstantExpression(expr.right);
  return false;
}

function evaluateExpression(expr, ctx, env, frame, expectedType = null) {
  switch (expr.kind) {
    case 'IntLiteral':
    case 'FloatLiteral': return { type: expr.type ?? INT, value: { kind: 'scalar', value: expr.value } };
    case 'CharLiteral': return { type: INT, value: { kind: 'scalar', value: decodeCharLiteral(expr.raw) } };
    case 'NullLiteral': return intResult(0);
    case 'Identifier': {
      if (expr.name === 'NULL') return intResult(0);
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
      // C 6.5.3.2: &*E cancels the dereference; &a[n] permits a one-past address.
      if (expr.expression.kind === 'Dereference') {
        const rv = evalExpression(expr.expression.expression, ctx, env, frame);
        if (!isPointer(rv.type)) throw semanticError(expr, 'address/dereference requires a pointer');
        return rv;
      }
      if (expr.expression.kind === 'Subscript') return evalSubscriptPointer(expr.expression, ctx, env, frame);
      const lv = evalLValue(expr.expression, ctx, env, frame);
      return { type: pointer(lv.type), value: pointerValue(lv.ref) };
    }
    case 'Dereference':
    case 'Subscript':
      return loadLValue(evalLValue(expr, ctx, env, frame), ctx, expr);
    case 'Member': {
      if (!expr.viaPointer && !isLValueExpression(expr.object)) {
        const object = evalExpression(expr.object, ctx, env, frame);
        const type = inferExpressionType(expr, ctx, env, frame);
        if (isArray(type)) throw semanticError(expr, 'array members of temporary structs are not supported');
        const value = object.value.fields?.[expr.field];
        if (!value || value.kind === 'uninit') throw semanticError(expr, 'read of uninitialized struct member');
        return { type, value: structuredClone(value) };
      }
      return loadLValue(evalLValue(expr, ctx, env, frame), ctx, expr);
    }
    case 'Assignment': {
      const lhsStart = ctx.accesses.length;
      const lhs = evalLValue(expr.left, ctx, env, frame);
      const lhsAccesses = ctx.accesses.slice(lhsStart);
      if (isArray(lhs.type)) throw semanticError(expr, 'arrays are not assignable');
      if (expr.operator === '=') {
        const rhsStart = ctx.accesses.length;
        const rhs = evalExpression(expr.right, ctx, env, frame, lhs.type);
        const rhsAccesses = ctx.accesses.slice(rhsStart);
        checkUnsequenced(lhsAccesses, rhsAccesses, ctx, expr);
        if (rhsAccesses.some(a => a.depth === ctx.callDepth && a.update && sameRefValue(a.ref, lhs.ref))) throw semanticError(expr, 'unsequenced modifications of the assignment target');
        const value = assignToRef(lhs.ref, lhs.type, rhs, ctx, expr);
        return { type: lhs.type, value };
      }
      if (['+=', '-=', '*=', '/=', '%='].includes(expr.operator)) {
        const currentStart = ctx.accesses.length;
        const current = loadLValue(lhs, ctx, expr);
        const currentAccesses = [...lhsAccesses, ...ctx.accesses.slice(currentStart)];
        const rhsStart = ctx.accesses.length;
        const rhs = evalExpression(expr.right, ctx, env, frame, null);
        checkUnsequenced(currentAccesses, ctx.accesses.slice(rhsStart), ctx, expr);
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
      const rv = evalExpression(expr.expression, ctx, env, frame, null); requireNumber(rv, expr);
      const type = promote(rv.type);
      const value = expr.operator === '-' ? -rv.value.value : rv.value.value;
      return { type, value: { kind: 'scalar', value: convertNumber(value, type, { arithmetic: true }) } };
    }
    case 'Update': {
      const lv = evalLValue(expr.expression, ctx, env, frame);
      const current = loadLValue(lv, ctx, expr);
      let next;
      if (isPointer(current.type)) {
        if (current.value.kind !== 'pointer') throw semanticError(expr, 'pointer update requires a concrete pointer');
        next = { type: current.type, value: addToPointer(ctx.state, current.value, expr.operator === '++' ? 1 : -1, expr) };
      } else {
        requireNumber(current, expr);
        next = numericOperation(expr.operator === '++' ? '+' : '-', current, intResult(1));
      }
      const value = assignToRef(lv.ref, lv.type, next, ctx, expr);
      ctx.accesses.at(-1).update = true;
      return expr.prefix ? { type: lv.type, value } : current;
    }
    case 'Binary': return evalBinary(expr, ctx, env, frame);
    case 'SizeofType': return { type: SIZE_T, value: { kind: 'scalar', value: sizeOf(expr.type, ctx.state.structTypes) } };
    case 'SizeofExpression': return { type: SIZE_T, value: { kind: 'scalar', value: sizeOf(inferExpressionType(expr.expression, ctx, env, frame), ctx.state.structTypes) } };
    case 'InitializerList': {
      if (!expectedType || expr.elements.length !== 1) throw semanticError(expr, 'scalar initializer requires exactly one element');
      return evalExpression(expr.elements[0], ctx, env, frame, expectedType);
    }
    default: throw semanticError(expr, `unsupported expression ${expr.kind}`);
  }
}

function isLValueExpression(expr) {
  return ['Identifier', 'Dereference', 'Subscript'].includes(expr.kind) || expr.kind === 'Member' && (expr.viaPointer || isLValueExpression(expr.object));
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
    const advanced = evalSubscriptPointer(expr, ctx, env, frame);
    const resolved = resolveRef(ctx.state, advanced.value.target);
    if (!resolved.allocation.alive || resolved.onePast || resolved.invalid) throw semanticError(expr, 'subscript outside live object bounds');
    return { ref: advanced.value.target, type: advanced.type.to };
  }
  if (expr.kind === 'Member') {
    let baseRef, baseType;
    if (expr.viaPointer) {
      const rv = evalExpression(expr.object, ctx, env, frame, null);
      if (!isPointer(rv.type) || !isStruct(rv.type.to)) throw semanticError(expr, "'->' requires a pointer to struct");
      if (rv.value.kind !== 'pointer') throw semanticError(expr, "'->' requires a concrete pointer");
      const resolved = resolveRef(ctx.state, rv.value.target);
      if (!resolved.allocation.alive) throw semanticError(expr, "'->' through dangling pointer");
      if (resolved.onePast || resolved.invalid) throw semanticError(expr, "'->' outside object bounds");
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

function evalSubscriptPointer(expr, ctx, env, frame) {
  const start = ctx.accesses.length;
  let base = evalExpression(expr.array, ctx, env, frame);
  const baseAccesses = ctx.accesses.slice(start), indexStart = ctx.accesses.length;
  let index = evalExpression(expr.index, ctx, env, frame);
  checkUnsequenced(baseAccesses, ctx.accesses.slice(indexStart), ctx, expr);
  if (isIntegerRuntime(base) && isPointer(index.type)) [base, index] = [index, base];
  requireInteger(index, expr);
  if (!isPointer(base.type) || base.value.kind !== 'pointer') throw semanticError(expr, 'subscript requires an array or concrete pointer');
  return { type: base.type, value: addToPointer(ctx.state, base.value, index.value.value, expr) };
}

function loadLValue(lvalue, ctx, node) {
  const resolved = resolveRef(ctx.state, lvalue.ref, { allowDead: true });
  if (!resolved.allocation.alive) throw semanticError(node, `read from object whose lifetime has ended`);
  if (resolved.onePast || resolved.invalid) throw semanticError(node, 'read outside object bounds');
  if (isArray(lvalue.type)) return { type: pointer(lvalue.type.of), value: pointerValue(ref(lvalue.ref.allocationId, [...lvalue.ref.path, 0])) };
  if (resolved.value.kind === 'uninit') throw semanticError(node, `read of uninitialized ${resolved.label}`);
  if (resolved.value.kind === 'pointer' && !ctx.allowDanglingRead && !getAllocation(ctx.state, resolved.value.target.allocationId).alive) {
    throw semanticError(node, 'use of dangling pointer whose target lifetime has ended');
  }
  ctx.accesses.push({ ref: lvalue.ref, write: false, depth: ctx.callDepth });
  return { type: lvalue.type, value: structuredClone(resolved.value) };
}

function assignToRef(targetRef, targetType, rv, ctx, node) {
  const value = coerceRValue(targetType, rv, node).value;
  setRefValue(ctx.state, targetRef, value);
  ctx.accesses.push({ ref: targetRef, write: true, depth: ctx.callDepth });
  pushTrace(ctx, { kind: 'Write', target: structuredClone(targetRef), type: targetType, value: structuredClone(value), line: node.loc?.startLine ?? null });
  return structuredClone(value);
}

function coerceRValue(targetType, rv, node) {
  if (isPrimitive(targetType)) {
    if (!isPrimitive(rv.type) || rv.value.kind !== 'scalar') throw semanticError(node, `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`);
    return { type: targetType, value: { kind: 'scalar', value: convertNumber(rv.value.value, targetType, { fromFloat: isFloatingType(rv.type) }) } };
  }
  if (isPointer(targetType)) {
    if (isPointer(rv.type) && !typeEquals(targetType, rv.type)) throw semanticError(node, `incompatible pointer types: ${typeToString(targetType)} and ${typeToString(rv.type)}`);
    if (isNullLike(rv)) return { type: targetType, value: { kind: 'null' } };
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
    if (isArray(expectedType.to)) throw semanticError(expr, 'malloc of array types is not supported; use a pointer to the element type');
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
    let rv;
    ctx.allowDanglingRead = true;
    try { rv = evalExpression(expr.arguments[0], ctx, env, frame, null); }
    finally { ctx.allowDanglingRead = false; }
    if (isNullLike(rv)) return { type: { kind: 'void' }, value: { kind: 'void' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer') throw semanticError(expr, 'free expects a pointer or NULL');
    const target = rv.value.target, allocation = getAllocation(ctx.state, target.allocationId);
    if (allocation.storage.kind !== 'heap') throw semanticError(expr, 'free() requires heap memory');
    if (!allocation.alive) throw semanticError(expr, 'double free');
    const basePath = isArray(allocation.type) ? [0] : [];
    if (!samePath(target.path, basePath)) throw semanticError(expr, 'free() requires the original allocation pointer, not an interior pointer');
    allocation.alive = false;
    pushTrace(ctx, { kind: 'Free', allocationId: allocation.id, line: expr.loc?.startLine ?? null });
    return { type: { kind: 'void' }, value: { kind: 'void' } };
  }

  const fn = ctx.functions.get(expr.name);
  if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`);
  if (expr.arguments.length !== fn.params.length) throw semanticError(expr, `${expr.name} expects ${fn.params.length} argument(s), got ${expr.arguments.length}`);
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

function evalBinary(expr, ctx, env, frame) {
  // Logical operators must short-circuit because the skipped operand may have
  // side effects or be unsafe to evaluate (for example p && *p).
  const leftStart = ctx.accesses.length;
  const left = evalExpression(expr.left, ctx, env, frame, null);
  const leftAccesses = ctx.accesses.slice(leftStart);
  if (expr.operator === '&&') {
    for (const access of leftAccesses) access.update = false;
    if (!truthy(left, expr.left)) return intResult(0);
    const right = evalExpression(expr.right, ctx, env, frame, null);
    return intResult(truthy(right, expr.right) ? 1 : 0);
  }
  if (expr.operator === '||') {
    for (const access of leftAccesses) access.update = false;
    if (truthy(left, expr.left)) return intResult(1);
    const right = evalExpression(expr.right, ctx, env, frame, null);
    return intResult(truthy(right, expr.right) ? 1 : 0);
  }

  const rightStart = ctx.accesses.length;
  const right = evalExpression(expr.right, ctx, env, frame, null);
  checkUnsequenced(leftAccesses, ctx.accesses.slice(rightStart), ctx, expr);

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
    if (isNumberRuntime(left) && isNumberRuntime(right)) {
      return numericOperation(expr.operator, left, right);
    }
    if (expr.operator === '-' && isPointer(left.type) && isPointer(right.type) && typeEquals(left.type, right.type)) {
      if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(expr, 'pointer subtraction requires concrete pointers');
      const a = arrayPosition(ctx.state, left.value.target), b = arrayPosition(ctx.state, right.value.target);
      if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix)) throw semanticError(expr, 'pointer subtraction requires pointers into the same array');
      return { type: { kind: 'primitive', name: 'long' }, value: { kind: 'scalar', value: a.index - b.index } };
    }
  }

  if (['*', '/', '%'].includes(expr.operator)) {
    requireNumber(left, expr.left); requireNumber(right, expr.right);
    return numericOperation(expr.operator, left, right);
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
  requireNumber(left, node); requireNumber(right, node);
  return numericOperation(op, left, right);
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
  if (isNumberRuntime(left) && isNumberRuntime(right)) {
    const type = arithmeticType(left.type, right.type);
    return convertNumber(left.value.value, type) === convertNumber(right.value.value, type);
  }
  if (isPointer(left.type) && isPointer(right.type) && !typeEquals(left.type, right.type)) throw semanticError(node, 'comparison of incompatible pointer types');

  const leftNull = isNullLike(left), rightNull = isNullLike(right);
  if (leftNull && rightNull) return true;
  if (isPointer(left.type) && left.value.kind === 'pointer' && rightNull) return false;
  if (isPointer(right.type) && right.value.kind === 'pointer' && leftNull) return false;

  if (isPointer(left.type) && isPointer(right.type)) {
    if (!typeEquals(left.type, right.type)) throw semanticError(node, `comparison of incompatible pointer types ${typeToString(left.type)} and ${typeToString(right.type)}`);
    if (left.value.kind === 'null' || right.value.kind === 'null') return left.value.kind === right.value.kind;
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(node, 'pointer comparison requires initialized pointer values');
    return left.value.target.allocationId === right.value.target.allocationId &&
      addressOffset(ctx.state, left.value.target) === addressOffset(ctx.state, right.value.target);
  }
  throw semanticError(node, `cannot compare ${typeToString(left.type)} and ${typeToString(right.type)}`);
}

function compareScalars(left, right, ctx, node) {
  if (isNumberRuntime(left) && isNumberRuntime(right)) {
    const type = arithmeticType(left.type, right.type);
    return Math.sign(convertNumber(left.value.value, type) - convertNumber(right.value.value, type));
  }
  if (isPointer(left.type) && isPointer(right.type) && typeEquals(left.type, right.type)) {
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer') throw semanticError(node, 'relational pointer comparison requires concrete pointers');
    const a = arrayPosition(ctx.state, left.value.target), b = arrayPosition(ctx.state, right.value.target);
    if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix)) {
      const l = left.value.target, r = right.value.target;
      if (l.allocationId === r.allocationId && samePath(l.path.slice(0, -1), r.path.slice(0, -1))) {
        const parent = resolveRef(ctx.state, ref(l.allocationId, l.path.slice(0, -1)));
        if (isStruct(parent.type) && l.path.at(-1) !== '$onePast' && r.path.at(-1) !== '$onePast') {
          return Math.sign(addressOffset(ctx.state, l) - addressOffset(ctx.state, r));
        }
      }
      throw semanticError(node, 'relational pointer comparison requires pointers into the same array');
    }
    return Math.sign(a.index - b.index);
  }
  throw semanticError(node, `relational comparison requires numbers or pointers into the same array`);
}

function addressOffset(state, target) {
  let type = getAllocation(state, target.allocationId).type, offset = 0;
  for (const part of target.path) {
    if (part === '$onePast') return offset + sizeOf(type, state.structTypes);
    if (isArray(type)) { offset += part * sizeOf(type.of, state.structTypes); type = type.of; }
    else if (isStruct(type)) {
      for (const field of resolveStructType(type, state.structTypes).fields) {
        const alignment = alignmentOf(field.type, state.structTypes);
        offset = Math.ceil(offset / alignment) * alignment;
        if (field.name === part) { type = field.type; break; }
        offset += sizeOf(field.type, state.structTypes);
      }
    }
  }
  return offset;
}

function isNullLike(rv) {
  return rv.value.kind === 'null' || (isIntegerRuntime(rv) && rv.integerConstant && rv.value.value === 0);
}

function sameRefValue(a, b) {
  return a.allocationId === b.allocationId && samePath(a.path ?? [], b.path ?? []);
}

function checkUnsequenced(left, right, ctx, node) {
  // Function bodies are indeterminately sequenced relative to caller evaluations
  // (C11 6.5.2.2p10); argument expressions themselves are unsequenced.
  for (const a of left) for (const b of right) {
    const overlap = a.ref.allocationId === b.ref.allocationId && (a.ref.path.every((part, i) => b.ref.path[i] === part) || b.ref.path.every((part, i) => a.ref.path[i] === part));
    if (a.depth === ctx.callDepth && b.depth === ctx.callDepth && (a.write || b.write) && overlap) {
      throw semanticError(node, 'unsequenced read/modification of the same object');
    }
  }
}

function intResult(value) { return { type: INT, value: { kind: 'scalar', value } }; }

function addToPointer(state, value, delta, node) {
  if (!Number.isSafeInteger(delta)) throw semanticError(node, 'pointer offset must be an integer');
  if (!getAllocation(state, value.target.allocationId).alive) throw semanticError(node, 'pointer arithmetic on an object whose lifetime has ended');
  const pos = arrayPosition(state, value.target);
  if (!pos) { if (delta === 0) return structuredClone(value); throw semanticError(node, 'pointer arithmetic is only supported within arrays/malloc blocks'); }
  const next = pos.index + delta;
  if (next < 0 || next > pos.length) throw semanticError(node, `pointer arithmetic moves outside allocation bounds (index ${next})`);
  return pointerValue(ref(pos.allocationId, pos.singleton ? (next === 0 ? pos.prefix : [...pos.prefix, '$onePast']) : [...pos.prefix, next]));
}

/** Find the nearest array component in a reference path, including arrays inside structs. */
function arrayPosition(state, targetRef) {
  const allocation = getAllocation(state, targetRef.allocationId);
  let type = allocation.type;
  const path = targetRef.path ?? [], prefix = [];
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type) && Number.isInteger(part)) {
      if (i === path.length - 1) return { allocationId: allocation.id, prefix: [...prefix], index: part, length: type.length };
      if (part < 0 || part >= type.length) return null;
      type = type.of; prefix.push(part); continue;
    }
    if (part === '$onePast' && i === path.length - 1) return { allocationId: allocation.id, prefix, index: 1, length: 1, singleton: true };
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes), field = def.fields.find(f => f.name === part);
      if (!field) return null; type = field.type; prefix.push(part); continue;
    }
    return null;
  }
  return { allocationId: allocation.id, prefix, index: 0, length: 1, singleton: true };
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
  const infer = e => inferExpressionType(e, ctx, env, frame);
  const decay = t => isArray(t) ? pointer(t.of) : t;
  if (expr.kind === 'Identifier') {
    if (expr.name === 'NULL') return INT;
    const r = lookupBinding(env, expr.name);
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`);
    return refType(ctx.state, r);
  }
  if (expr.kind === 'Dereference') { const t = decay(infer(expr.expression)); if (!isPointer(t)) throw semanticError(expr, 'cannot dereference non-pointer'); return t.to; }
  if (expr.kind === 'AddressOf') return pointer(infer(expr.expression));
  if (expr.kind === 'Subscript') {
    const a = decay(infer(expr.array)), b = decay(infer(expr.index));
    if (isPointer(a) && isIntegerType(b)) return a.to;
    if (isPointer(b) && isIntegerType(a)) return b.to;
    throw semanticError(expr, 'subscripted expression has no element type');
  }
  if (expr.kind === 'Member') {
    let type = infer(expr.object);
    if (expr.viaPointer) {
      type = decay(type);
      if (!isPointer(type)) throw semanticError(expr, "'->' requires a pointer to struct");
      type = type.to;
    }
    if (!isStruct(type)) throw semanticError(expr, 'member access requires a struct');
    const field = resolveStructType(type, ctx.state.structTypes).fields?.find(f => f.name === expr.field);
    if (!field) throw semanticError(expr, `struct ${type.name} has no field '${expr.field}'`);
    return field.type;
  }
  if (expr.kind === 'IntLiteral' || expr.kind === 'FloatLiteral') return expr.type ?? INT;
  if (expr.kind === 'CharLiteral' || expr.kind === 'NullLiteral') return INT;
  if (expr.kind === 'SizeofType' || expr.kind === 'SizeofExpression') return SIZE_T;
  if (expr.kind === 'Call') {
    if (expr.name === 'free') return { kind: 'void' };
    if (expr.name === 'malloc') return pointer({ kind: 'void' });
    const fn = ctx.functions.get(expr.name);
    if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`);
    return fn.returnType;
  }
  if (expr.kind === 'Assignment') return infer(expr.left);
  if (expr.kind === 'Update') return decay(infer(expr.expression));
  if (expr.kind === 'Unary') {
    const type = decay(infer(expr.expression));
    if (expr.operator === '!') {
      if (!isPrimitive(type) && !isPointer(type)) throw semanticError(expr, 'logical operator requires scalar');
      return INT;
    }
    if (!isPrimitive(type)) throw semanticError(expr, 'unary arithmetic requires number');
    return promote(type);
  }
  if (expr.kind === 'Binary') {
    const a = decay(infer(expr.left)), b = decay(infer(expr.right));
    if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expr.operator)) return INT;
    if (['+', '-'].includes(expr.operator)) {
      if (isPointer(a) && isIntegerType(b)) return a;
      if (expr.operator === '+' && isIntegerType(a) && isPointer(b)) return b;
      if (expr.operator === '-' && isPointer(a) && typeEquals(a, b)) return { kind: 'primitive', name: 'long' };
    }
    if (isPrimitive(a) && isPrimitive(b)) {
      if (expr.operator === '%' && (!isIntegerType(a) || !isIntegerType(b))) throw semanticError(expr, 'remainder requires integers');
      return arithmeticType(a, b);
    }
    throw semanticError(expr, 'invalid binary operand types');
  }
  throw semanticError(expr, `cannot determine type of ${expr.kind} without evaluation`);
}

function markNext(ctx, node, frame) {
  const previous = ctx.snapshots.at(-1);
  if (previous) { previous.nextLine = node.loc?.startLine ?? null; previous.nextFunction = frame.name; }
}

function snapshot(ctx, stmt, frame) {
  ctx.steps++;
  if (ctx.steps > MAX_TRACE_STEPS) throw new Error(`execution exceeded ${MAX_TRACE_STEPS} visualized statements`);
  ctx.snapshots.push({
    line: stmt.loc?.startLine ?? null,
    nextLine: null,
    function: frame.name, frameId: frame.id, statement: stmt.kind,
    events: ctx.trace.slice(ctx.snapshotTraceIndex), state: cloneState(ctx.state),
  });
  ctx.snapshotTraceIndex = ctx.trace.length;
}

function pushTrace(ctx, event) { ctx.trace.push(event); if (ctx.trace.length > MAX_TRACE_STEPS * 8) throw new Error('execution trace is too large'); }
function requireInteger(rv, node) { if (!isIntegerRuntime(rv)) throw semanticError(node, `expected integer, got ${typeToString(rv.type)}`); }
function isIntegerRuntime(rv) { return isIntegerType(rv.type) && rv.value.kind === 'scalar'; }
function isNumberRuntime(rv) { return (isIntegerType(rv.type) || isFloatingType(rv.type)) && rv.value.kind === 'scalar'; }
function requireNumber(rv, node) { if (!isNumberRuntime(rv)) throw semanticError(node, `expected number, got ${typeToString(rv.type)}`); }
function samePath(a = [], b = []) { return a.length === b.length && a.every((x, i) => x === b[i]); }

function semanticError(node, message) { const line = node?.loc?.startLine; return new Error(line ? `${message} (line ${line})` : message); }
