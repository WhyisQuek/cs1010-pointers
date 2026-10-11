/** Object designation (lvalues), reads, writes and assignment conversions. */
import { convertNumber, isBoolType, isFloatingType } from '../../language/numeric.js';
import {
  isArray,
  isPointer,
  isPrimitive,
  isStruct,
  pointer,
  resolveStructType,
  typeEquals,
  typeToString,
} from '../../language/types.js';
import { getAllocation, pointerValue, ref, refType, resolveRef, setRefValue } from '../memory.js';
import { evalExpression } from './expressions.js';
import { checkUnsequenced, isNullLike, truthy } from './operators.js';
import { addToPointer } from './pointerArithmetic.js';
import {
  isIntegerRuntime,
  lookupBinding,
  pushTrace,
  requireInteger,
  semanticError,
} from './runtime.js';

export function isLValueExpression(expr) {
  return (
    ['Identifier', 'Dereference', 'Subscript'].includes(expr.kind) ||
    (expr.kind === 'Member' && (expr.viaPointer || isLValueExpression(expr.object)))
  );
}

export function evalLValue(expr, ctx, env, frame) {
  if (expr.kind === 'Identifier') {
    const r = lookupBinding(env, expr.name);
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`);
    return { ref: r, type: refType(ctx.state, r) };
  }
  if (expr.kind === 'Dereference') {
    const rv = evalExpression(expr.expression, ctx, env, frame, null);
    if (!isPointer(rv.type))
      throw semanticError(expr, `cannot dereference ${typeToString(rv.type)}`);
    if (rv.value.kind !== 'pointer')
      throw semanticError(expr, `cannot dereference ${rv.value.kind} pointer`);
    const resolved = resolveRef(ctx.state, rv.value.target, { allowDead: true });
    if (!resolved.allocation.alive) throw semanticError(expr, 'dereference of dangling pointer');
    if (resolved.onePast || resolved.invalid)
      throw semanticError(expr, 'dereference outside object bounds');
    return { ref: rv.value.target, type: resolved.type };
  }
  if (expr.kind === 'Subscript') {
    const advanced = evalSubscriptPointer(expr, ctx, env, frame);
    const resolved = resolveRef(ctx.state, advanced.value.target);
    if (!resolved.allocation.alive || resolved.onePast || resolved.invalid)
      throw semanticError(expr, 'subscript outside live object bounds');
    return { ref: advanced.value.target, type: advanced.type.to };
  }
  if (expr.kind === 'Member') {
    let baseRef, baseType;
    if (expr.viaPointer) {
      const rv = evalExpression(expr.object, ctx, env, frame, null);
      if (!isPointer(rv.type) || !isStruct(rv.type.to))
        throw semanticError(expr, "'->' requires a pointer to struct");
      if (rv.value.kind !== 'pointer')
        throw semanticError(expr, "'->' requires a concrete pointer");
      const resolved = resolveRef(ctx.state, rv.value.target);
      if (!resolved.allocation.alive) throw semanticError(expr, "'->' through dangling pointer");
      if (resolved.onePast || resolved.invalid)
        throw semanticError(expr, "'->' outside object bounds");
      baseRef = rv.value.target;
      baseType = rv.type.to;
    } else {
      const lv = evalLValue(expr.object, ctx, env, frame);
      if (!isStruct(lv.type)) throw semanticError(expr, "'.' requires a struct object");
      baseRef = lv.ref;
      baseType = lv.type;
    }
    const def = resolveStructType(baseType, ctx.state.structTypes);
    const field = def.fields?.find(f => f.name === expr.field);
    if (!field) throw semanticError(expr, `struct ${baseType.name} has no field '${expr.field}'`);
    return { ref: ref(baseRef.allocationId, [...baseRef.path, expr.field]), type: field.type };
  }
  throw semanticError(expr, 'expression is not assignable');
}

export function evalSubscriptPointer(expr, ctx, env, frame) {
  const start = ctx.accesses.length;
  let base = evalExpression(expr.array, ctx, env, frame);
  const baseAccesses = ctx.accesses.slice(start),
    indexStart = ctx.accesses.length;
  let index = evalExpression(expr.index, ctx, env, frame);
  checkUnsequenced(baseAccesses, ctx.accesses.slice(indexStart), ctx, expr);
  if (isIntegerRuntime(base) && isPointer(index.type)) [base, index] = [index, base];
  requireInteger(index, expr);
  if (!isPointer(base.type) || base.value.kind !== 'pointer')
    throw semanticError(expr, 'subscript requires an array or concrete pointer');
  return { type: base.type, value: addToPointer(ctx.state, base.value, index.value.value, expr) };
}

export function loadLValue(lvalue, ctx, node) {
  const resolved = resolveRef(ctx.state, lvalue.ref, { allowDead: true });
  if (!resolved.allocation.alive)
    throw semanticError(node, `read from object whose lifetime has ended`);
  if (resolved.onePast || resolved.invalid) throw semanticError(node, 'read outside object bounds');
  if (isArray(lvalue.type))
    return {
      type: pointer(lvalue.type.of),
      value: pointerValue(ref(lvalue.ref.allocationId, [...lvalue.ref.path, 0])),
    };
  if (resolved.value.kind === 'uninit')
    throw semanticError(node, `read of uninitialized ${resolved.label}`);
  if (
    resolved.value.kind === 'pointer' &&
    !ctx.allowDanglingRead &&
    !getAllocation(ctx.state, resolved.value.target.allocationId).alive
  ) {
    throw semanticError(node, 'use of dangling pointer whose target lifetime has ended');
  }
  ctx.accesses.push({ ref: lvalue.ref, write: false, depth: ctx.callDepth });
  return { type: lvalue.type, value: structuredClone(resolved.value) };
}

export function assignToRef(targetRef, targetType, rv, ctx, node) {
  const value = coerceRValue(targetType, rv, node).value;
  setRefValue(ctx.state, targetRef, value);
  ctx.accesses.push({ ref: targetRef, write: true, depth: ctx.callDepth });
  pushTrace(ctx, {
    kind: 'Write',
    target: structuredClone(targetRef),
    type: targetType,
    value: structuredClone(value),
    line: node.loc?.startLine ?? null,
  });
  return structuredClone(value);
}

export function coerceRValue(targetType, rv, node) {
  if (isBoolType(targetType) && (isPointer(rv.type) || rv.value.kind === 'null'))
    return { type: targetType, value: { kind: 'scalar', value: truthy(rv, node) ? 1 : 0 } };
  if (isPrimitive(targetType)) {
    if (!isPrimitive(rv.type) || rv.value.kind !== 'scalar')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
      );
    return {
      type: targetType,
      value: {
        kind: 'scalar',
        value: convertNumber(rv.value.value, targetType, { fromFloat: isFloatingType(rv.type) }),
      },
    };
  }
  if (isPointer(targetType)) {
    if (isPointer(rv.type) && !typeEquals(targetType, rv.type))
      throw semanticError(
        node,
        `incompatible pointer types: ${typeToString(targetType)} and ${typeToString(rv.type)}`,
      );
    if (isNullLike(rv)) return { type: targetType, value: { kind: 'null' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
      );
    if (!typeEquals(targetType, rv.type))
      throw semanticError(
        node,
        `incompatible pointer types: ${typeToString(targetType)} and ${typeToString(rv.type)}`,
      );
    return { type: targetType, value: structuredClone(rv.value) };
  }
  if (isStruct(targetType)) {
    if (!isStruct(rv.type) || !typeEquals(targetType, rv.type) || rv.value.kind !== 'aggregate')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
      );
    return { type: targetType, value: structuredClone(rv.value) };
  }
  throw semanticError(node, `assignment to ${typeToString(targetType)} is not supported`);
}
