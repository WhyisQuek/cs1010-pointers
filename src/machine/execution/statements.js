/**
 * Statement execution. Statements return null for normal completion or a
 * control signal ({ control: 'return' | 'break' | 'continue' }) that loops and
 * function calls consume.
 */
import { INVALID, UNSUPPORTED } from '../../language/diagnostics.js';
import { stringInitializerLiteral } from '../../language/literals.js';
import {
  CHAR,
  isArray,
  isPointer,
  isPrimitive,
  isStruct,
  resolveStructType,
  typeEquals,
  typeToString,
} from '../../language/types.js';
import { addAllocation, getAllocation, ref, resolveRef, setRefValue } from '../memory.js';
import { evalCondition, evalExpression } from './expressions.js';
import { assignToRef, coerceRValue } from './lvalues.js';
import {
  closeScope,
  declareBinding,
  guardLoopIteration,
  makeScope,
  markNext,
  pushTrace,
  semanticError,
  snapshot,
} from './runtime.js';
import { inferExpressionType } from './typeInference.js';

function execStatement(stmt, ctx, env, frame, fn, loopDepth = 0) {
  switch (stmt.kind) {
    case 'Empty':
      return null;
    case 'Declaration':
      for (const decl of stmt.declarations) execDeclaration(decl, ctx, env, frame);
      return null;
    case 'ExpressionStatement':
      evalExpression(stmt.expression, ctx, env, frame, null, { discard: true });
      return null;
    case 'Return': {
      if (fn.returnType?.kind === 'void') {
        if (stmt.expression)
          throw semanticError(stmt, `void function '${fn.name}' cannot return a value`, INVALID);
        pushTrace(ctx, { kind: 'Return', frameId: frame.id, line: stmt.loc?.startLine ?? null });
        return { control: 'return', value: null };
      }
      if (!stmt.expression)
        throw semanticError(
          stmt,
          `function '${fn.name}' must return ${typeToString(fn.returnType)}`,
          INVALID,
        );
      const rv = evalExpression(stmt.expression, ctx, env, frame, fn.returnType);
      pushTrace(ctx, { kind: 'Return', frameId: frame.id, line: stmt.loc?.startLine ?? null });
      return { control: 'return', value: coerceRValue(fn.returnType, rv, stmt, ctx) };
    }
    case 'Break':
      if (loopDepth <= 0) throw semanticError(stmt, 'break used outside a loop', INVALID);
      pushTrace(ctx, { kind: 'Break', frameId: frame.id, line: stmt.loc?.startLine ?? null });
      return { control: 'break' };
    case 'Continue':
      if (loopDepth <= 0) throw semanticError(stmt, 'continue used outside a loop', INVALID);
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
    if (local.ownedAllocations.some(id => getAllocation(ctx.state, id).alive))
      markNext(ctx, { loc: { startLine: stmt.loc?.endLine } }, frame);
    closeScope(ctx, local, frame);
  }
}

function execIf(stmt, ctx, env, frame, fn, loopDepth) {
  markNext(ctx, stmt.condition, frame);
  const condition = evalCondition(stmt.condition, ctx, env, frame);
  pushTrace(ctx, {
    kind: 'Condition',
    statement: 'if',
    result: condition,
    frameId: frame.id,
    line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
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
      kind: 'Condition',
      statement: 'while',
      result: condition,
      iteration: iterations,
      frameId: frame.id,
      line: stmt.condition.loc?.startLine ?? stmt.loc?.startLine ?? null,
    });
    snapshot(ctx, { kind: 'WhileCondition', loc: stmt.condition.loc ?? stmt.loc }, frame);
    if (!condition) return null;
    guardLoopIteration(++iterations, stmt);
    pushTrace(ctx, {
      kind: 'LoopIteration',
      statement: 'while',
      iteration: iterations,
      frameId: frame.id,
      line: stmt.loc?.startLine ?? null,
    });
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
      const initResult = execEmbeddedStatement(
        stmt.initializer,
        ctx,
        loopEnv,
        frame,
        fn,
        loopDepth,
      );
      if (initResult?.control) return initResult;
    }

    let iterations = 0;
    while (true) {
      markNext(ctx, stmt.condition ?? stmt, frame);
      const condition = stmt.condition ? evalCondition(stmt.condition, ctx, loopEnv, frame) : true;
      pushTrace(ctx, {
        kind: 'Condition',
        statement: 'for',
        result: condition,
        iteration: iterations,
        frameId: frame.id,
        line: stmt.condition?.loc?.startLine ?? stmt.loc?.startLine ?? null,
      });
      snapshot(ctx, { kind: 'ForCondition', loc: stmt.condition?.loc ?? stmt.loc }, frame);
      if (!condition) return null;
      guardLoopIteration(++iterations, stmt);
      pushTrace(ctx, {
        kind: 'LoopIteration',
        statement: 'for',
        iteration: iterations,
        frameId: frame.id,
        line: stmt.loc?.startLine ?? null,
      });

      const result = execEmbeddedStatement(stmt.body, ctx, loopEnv, frame, fn, loopDepth + 1);
      if (result?.control === 'return') return result;
      if (result?.control === 'break') return null;

      // In C, continue in a for loop still executes the update expression.
      if (stmt.update) {
        markNext(ctx, stmt.update, frame);
        evalExpression(stmt.update, ctx, loopEnv, frame, null, { discard: true });
        snapshot(ctx, { kind: 'ForUpdate', loc: stmt.update.loc ?? stmt.loc }, frame);
      }
    }
  } finally {
    if (loopEnv.ownedAllocations.some(id => getAllocation(ctx.state, id).alive))
      markNext(ctx, { loc: { startLine: stmt.loc?.endLine } }, frame);
    closeScope(ctx, loopEnv, frame);
  }
}

export function execEmbeddedStatement(stmt, ctx, env, frame, fn, loopDepth) {
  if (stmt.kind === 'Empty') return null;
  const compound = ['Block', 'If', 'While', 'For'].includes(stmt.kind);
  if (!compound) markNext(ctx, stmt, frame);
  const count = ctx.snapshots.length;
  const result = execStatement(stmt, ctx, env, frame, fn, loopDepth);
  // Conditions and children emit their own snapshots. Only unrecorded actions
  // (including scope cleanup) need another one; never repeat a call's events.
  const pending = ctx.trace.slice(ctx.snapshotTraceIndex);
  if (
    (!compound && (count === ctx.snapshots.length || pending.length)) ||
    (compound && pending.some(e => e.kind === 'EndLifetime'))
  ) {
    snapshot(
      ctx,
      compound ? { kind: 'EndScope', loc: { startLine: stmt.loc?.endLine } } : stmt,
      frame,
    );
  } else if (!compound && count < ctx.snapshots.length) {
    // A statement such as `f(x);` ends with its last call's LeaveFrame step, recorded in the
    // callee. Mark that step as completing a statement here, for step over and breakpoints.
    const last = ctx.snapshots.at(-1);
    last.completesDepth = Math.min(last.completesDepth ?? Infinity, frame.depth);
  }
  return result;
}

function execDeclaration(decl, ctx, env, frame) {
  const allocation = addAllocation(ctx.state, {
    name: decl.name,
    type: decl.type,
    storage: { kind: 'stack', frameId: frame.id },
  });
  declareBinding(env, decl.name, ref(allocation.id), decl);
  env.ownedAllocations.push(allocation.id);
  pushTrace(ctx, {
    kind: 'Declare',
    frameId: frame.id,
    name: decl.name,
    allocationId: allocation.id,
    type: decl.type,
    line: decl.loc?.startLine ?? null,
  });
  if (!decl.initializer) return;
  if (isArray(decl.type) || isStruct(decl.type)) {
    initializeAggregate(ref(allocation.id), decl.type, decl.initializer, ctx, env, frame, decl);
    return;
  }
  initializeScalar(ref(allocation.id), decl.type, decl.initializer, ctx, env, frame, decl);
}

/** `= {}` gives a scalar the value a static object would have: 0 or a null pointer. */
function initializeScalar(targetRef, type, initializer, ctx, env, frame, node) {
  if (initializer.kind === 'InitializerList' && !initializer.elements.length) {
    const zero = isPointer(type)
      ? { type, value: { kind: 'null' } }
      : { type, value: { kind: 'scalar', value: 0 } };
    assignToRef(targetRef, type, zero, ctx, node);
    return;
  }
  assignToRef(targetRef, type, evalExpression(initializer, ctx, env, frame, type), ctx, node);
}

function initializeAggregate(targetRef, type, initializer, ctx, env, frame, node) {
  if (initializeFromString(targetRef, type, initializer, ctx, node)) return;
  if (initializer.kind !== 'InitializerList') {
    // Struct copy initialization is useful for function/local code.
    if (isStruct(type)) {
      const rv = evalExpression(initializer, ctx, env, frame, type);
      assignToRef(targetRef, type, rv, ctx, node);
      return;
    }
    throw semanticError(
      node,
      `${typeToString(type)} initialization currently requires { ... }`,
      UNSUPPORTED,
    );
  }
  const cursor = { index: 0 };
  initializeMembers(targetRef, type, initializer.elements, cursor, ctx, env, frame, node);
  if (cursor.index < initializer.elements.length)
    throw semanticError(node, `too many initializers for ${typeToString(type)}`, INVALID);
}

function initializeMembers(targetRef, type, elements, cursor, ctx, env, frame, node) {
  const members = isArray(type)
    ? Array.from({ length: type.length }, (_, i) => ({ name: i, type: type.of }))
    : resolveStructType(type, ctx.state.structTypes).fields;
  for (const member of members) {
    const childRef = ref(targetRef.allocationId, [...targetRef.path, member.name]);
    if (cursor.index >= elements.length) {
      zeroInitialize(childRef, member.type, ctx);
      continue;
    }
    const child = elements[cursor.index];
    if (isArray(member.type) || isStruct(member.type)) {
      if (initializeFromString(childRef, member.type, child, ctx, node)) cursor.index++;
      else if (child.kind === 'InitializerList') {
        cursor.index++;
        initializeAggregate(childRef, member.type, child, ctx, env, frame, node);
      } else if (
        isStruct(member.type) &&
        typeEquals(member.type, inferExpressionType(child, ctx, env, frame))
      ) {
        cursor.index++;
        assignToRef(
          childRef,
          member.type,
          evalExpression(child, ctx, env, frame, member.type),
          ctx,
          node,
        );
      } else initializeMembers(childRef, member.type, elements, cursor, ctx, env, frame, node);
    } else {
      cursor.index++;
      initializeScalar(childRef, member.type, child, ctx, env, frame, node);
    }
  }
}

/** char a[N] = "..." copies the characters, then pads with '\0' (C 6.7.9p14, p21). */
function initializeFromString(targetRef, type, initializer, ctx, node) {
  const literal = stringInitializerLiteral(initializer);
  if (!literal || !isArray(type) || !typeEquals(type.of, CHAR)) return false;
  if (literal.value.length > type.length)
    throw semanticError(node, `initializer-string is too long for ${typeToString(type)}`, INVALID);
  for (let i = 0; i < type.length; i++) {
    const rv = { type: CHAR, value: { kind: 'scalar', value: literal.value[i] ?? 0 } };
    assignToRef(ref(targetRef.allocationId, [...targetRef.path, i]), CHAR, rv, ctx, node);
  }
  return true;
}

function zeroInitialize(targetRef, type, ctx) {
  if (isPrimitive(type)) setRefValue(ctx.state, targetRef, { kind: 'scalar', value: 0 });
  else if (isPointer(type)) setRefValue(ctx.state, targetRef, { kind: 'null' });
  else if (isArray(type)) {
    for (let i = 0; i < type.length; i++)
      zeroInitialize(ref(targetRef.allocationId, [...targetRef.path, i]), type.of, ctx);
  } else if (isStruct(type)) {
    const def = resolveStructType(type, ctx.state.structTypes);
    for (const f of def.fields)
      zeroInitialize(ref(targetRef.allocationId, [...targetRef.path, f.name]), f.type, ctx);
  } else throw new Error(`cannot zero initialize ${resolveRef(ctx.state, targetRef).label}`);
}
