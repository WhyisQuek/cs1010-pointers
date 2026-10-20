/** Object designation (lvalues), reads, writes and assignment conversions. */
import { INVALID, LIMIT, UNDEFINED, UNSUPPORTED } from '../../language/diagnostics.js';
import { MAX_HEAP_ELEMENTS } from '../../language/limits.js';
import { convertNumber, isBoolType, isFloatingType } from '../../language/numeric.js';
import {
  isArray,
  isBlock,
  isPointer,
  isPrimitive,
  isStruct,
  isVoidPointer,
  pointer,
  resolveStructType,
  sizeOf,
  typeEquals,
  typeToString,
} from '../../language/types.js';
import {
  getAllocation,
  outermostRefAtAddress,
  pointerValue,
  ref,
  refAtSameAddress,
  refType,
  resolveRef,
  setRefValue,
  typeHeapBlock,
} from '../memory.js';
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
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`, INVALID);
    return { ref: r, type: refType(ctx.state, r) };
  }
  if (expr.kind === 'Dereference') {
    const rv = evalExpression(expr.expression, ctx, env, frame, null);
    if (!isPointer(rv.type))
      throw semanticError(expr, `cannot dereference ${typeToString(rv.type)}`, INVALID);
    if (rv.value.kind !== 'pointer')
      throw semanticError(expr, `cannot dereference ${rv.value.kind} pointer`, UNDEFINED);
    const resolved = resolveRef(ctx.state, rv.value.target, { allowDead: true });
    if (!resolved.allocation.alive)
      throw semanticError(expr, 'dereference of dangling pointer', UNDEFINED);
    if (resolved.onePast || resolved.invalid)
      throw semanticError(expr, 'dereference outside object bounds', UNDEFINED);
    requireAccessType(resolved, rv.type.to, expr);
    return { ref: rv.value.target, type: resolved.type };
  }
  if (expr.kind === 'Subscript') {
    const advanced = evalSubscriptPointer(expr, ctx, env, frame);
    const resolved = resolveRef(ctx.state, advanced.value.target);
    if (!resolved.allocation.alive || resolved.onePast || resolved.invalid)
      throw semanticError(expr, 'subscript outside live object bounds', UNDEFINED);
    requireAccessType(resolved, advanced.type.to, expr);
    return { ref: advanced.value.target, type: advanced.type.to };
  }
  if (expr.kind === 'Member') {
    let baseRef, baseType;
    if (expr.viaPointer) {
      const rv = evalExpression(expr.object, ctx, env, frame, null);
      if (!isPointer(rv.type) || !isStruct(rv.type.to))
        throw semanticError(expr, "'->' requires a pointer to struct", INVALID);
      if (rv.value.kind !== 'pointer')
        throw semanticError(expr, "'->' requires a concrete pointer", UNDEFINED);
      const resolved = resolveRef(ctx.state, rv.value.target);
      if (!resolved.allocation.alive)
        throw semanticError(expr, "'->' through dangling pointer", UNDEFINED);
      if (resolved.onePast || resolved.invalid)
        throw semanticError(expr, "'->' outside object bounds", UNDEFINED);
      requireAccessType(resolved, rv.type.to, expr);
      baseRef = rv.value.target;
      baseType = rv.type.to;
    } else {
      const lv = evalLValue(expr.object, ctx, env, frame);
      if (!isStruct(lv.type)) throw semanticError(expr, "'.' requires a struct object", INVALID);
      baseRef = lv.ref;
      baseType = lv.type;
    }
    const def = resolveStructType(baseType, ctx.state.structTypes);
    const field = def.fields?.find(f => f.name === expr.field);
    if (!field)
      throw semanticError(expr, `struct ${baseType.name} has no field '${expr.field}'`, INVALID);
    return { ref: ref(baseRef.allocationId, [...baseRef.path, expr.field]), type: field.type };
  }
  throw semanticError(expr, 'expression is not assignable', INVALID);
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
    throw semanticError(expr, 'subscript requires an array or concrete pointer', UNDEFINED);
  return {
    type: base.type,
    value: addToPointer(ctx.state, base.value, index.value.value, expr, base.type.to),
  };
}

export function loadLValue(lvalue, ctx, node) {
  const resolved = resolveRef(ctx.state, lvalue.ref, { allowDead: true });
  if (!resolved.allocation.alive)
    throw semanticError(node, `read from object whose lifetime has ended`, UNDEFINED);
  if (resolved.onePast || resolved.invalid)
    throw semanticError(node, 'read outside object bounds', UNDEFINED);
  if (isArray(lvalue.type))
    return {
      type: pointer(lvalue.type.of),
      value: pointerValue(ref(lvalue.ref.allocationId, [...lvalue.ref.path, 0])),
    };
  if (resolved.value.kind === 'uninit')
    throw semanticError(node, `read of uninitialized ${resolved.label}`, UNDEFINED);
  requireUsablePointerValue(resolved.value, ctx, node);
  ctx.accesses.push({ ref: lvalue.ref, write: false, depth: ctx.callDepth });
  return { type: lvalue.type, value: structuredClone(resolved.value) };
}

/**
 * A pointer becomes indeterminate when its target's lifetime ends (C23 6.2.4p2), so using
 * its value is undefined. Every read of a pointer value, stored or temporary, checks this,
 * except free's own argument (ctx.danglingReadExempt), so a second free reports a double free.
 */
export function requireUsablePointerValue(value, ctx, node) {
  if (
    value.kind === 'pointer' &&
    node !== ctx.danglingReadExempt &&
    !getAllocation(ctx.state, value.target.allocationId).alive
  ) {
    throw semanticError(node, 'use of dangling pointer whose target lifetime has ended', UNDEFINED);
  }
}

export function assignToRef(targetRef, targetType, rv, ctx, node) {
  if (getAllocation(ctx.state, targetRef.allocationId).storage.kind === 'static')
    throw semanticError(node, 'cannot modify a string literal (undefined behavior)', UNDEFINED);
  const value = coerceRValue(targetType, rv, node, ctx).value;
  setRefValue(ctx.state, targetRef, value);
  delete getAllocation(ctx.state, targetRef.allocationId).typedByConversion;
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

/**
 * Where a void * becomes a T *. An untyped malloc block takes T as its type, holding as many
 * whole T objects as fit. This is a PointerViz simplification: in C (6.5p6) a malloc block's
 * effective type comes from the first store, not a conversion. Otherwise the result designates the
 * T object at the same address, if one exists; if none does, it keeps pointing at the
 * original object and any access through it is diagnosed (see requireAccessType).
 */
function convertedTarget(target, type, ctx, node) {
  const allocation = getAllocation(ctx.state, target.allocationId);
  if (isBlock(allocation.type) && allocation.alive) {
    const count = Math.floor(allocation.type.bytes / sizeOf(type, ctx.state.structTypes));
    if (count > MAX_HEAP_ELEMENTS)
      throw semanticError(
        node,
        `malloc would create ${count} elements; PointerViz limits one allocation to ${MAX_HEAP_ELEMENTS}`,
        LIMIT,
      );
    const typed = typeHeapBlock(ctx.state, allocation, type);
    if (typed) {
      // Until something is stored, C would let another type use the block (see requireAccessType).
      allocation.typedByConversion = true;
      pushTrace(ctx, {
        kind: 'TypeBlock',
        allocationId: allocation.id,
        type: structuredClone(allocation.type),
        line: node.loc?.startLine ?? null,
      });
      return typed;
    }
    return target;
  }
  return refAtSameAddress(ctx.state, target, type) ?? target;
}

/**
 * An object may only be accessed through an lvalue of its own type (C23 6.5p7). Pointers
 * converted through void * can designate an object of another type, or a malloc block too
 * small to hold one whole object.
 */
function requireAccessType(resolved, type, node) {
  if (typeEquals(resolved.type, type)) return;
  if (isBlock(resolved.type))
    throw semanticError(
      node,
      `the ${resolved.type.bytes}-byte heap block is too small to hold a ${typeToString(type)}`,
      UNDEFINED,
    );
  // C types a malloc block at its first store, so before one any type may use it; PointerViz
  // typed it when it was first converted (convertedTarget) and cannot change it.
  if (resolved.allocation.typedByConversion)
    throw semanticError(
      node,
      `${resolved.label} was given the type ${typeToString(resolved.allocation.type)} when a pointer to it was first converted; using it as ${typeToString(type)} is not modeled`,
      UNSUPPORTED,
    );
  // Character access to any object, and signed/unsigned twins, are defined but byte-level
  // views are not modeled; every other mismatch is undefined.
  const representable =
    (isPrimitive(type) && type.name === 'char') ||
    (isPrimitive(type) &&
      isPrimitive(resolved.type) &&
      type.name.replace('unsigned ', '') === resolved.type.name.replace('unsigned ', ''));
  throw semanticError(
    node,
    `accessing ${typeToString(resolved.type)} ${resolved.label} through a ${typeToString(type)} lvalue`,
    representable ? UNSUPPORTED : UNDEFINED,
  );
}

/** `ctx` is needed for conversions from void *, which can give a malloc block its type. */
export function coerceRValue(targetType, rv, node, ctx = null) {
  if (isBoolType(targetType) && (isPointer(rv.type) || rv.value.kind === 'null'))
    return { type: targetType, value: { kind: 'scalar', value: truthy(rv, node) ? 1 : 0 } };
  if (isPrimitive(targetType)) {
    if (!isPrimitive(rv.type) || rv.value.kind !== 'scalar')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
        INVALID,
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
    // Object pointers convert to and from void * implicitly (C23 6.3.2.3p1, 6.5.16.1).
    const viaVoid = isVoidPointer(targetType) || isVoidPointer(rv.type);
    if (isPointer(rv.type) && !typeEquals(targetType, rv.type) && !viaVoid)
      throw semanticError(
        node,
        `incompatible pointer types: ${typeToString(targetType)} and ${typeToString(rv.type)}`,
        INVALID,
      );
    if (isNullLike(rv)) return { type: targetType, value: { kind: 'null' } };
    if (!isPointer(rv.type) || rv.value.kind !== 'pointer')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
        INVALID,
      );
    if (!viaVoid) return { type: targetType, value: structuredClone(rv.value) };
    if (isVoidPointer(targetType))
      return {
        type: targetType,
        value: pointerValue(outermostRefAtAddress(ctx.state, rv.value.target)),
      };
    return {
      type: targetType,
      value: pointerValue(convertedTarget(rv.value.target, targetType.to, ctx, node)),
    };
  }
  if (isStruct(targetType)) {
    if (!isStruct(rv.type) || !typeEquals(targetType, rv.type) || rv.value.kind !== 'aggregate')
      throw semanticError(
        node,
        `cannot assign ${typeToString(rv.type)} to ${typeToString(targetType)}`,
        INVALID,
      );
    return { type: targetType, value: structuredClone(rv.value) };
  }
  throw semanticError(
    node,
    `assignment to ${typeToString(targetType)} is not supported`,
    UNSUPPORTED,
  );
}
