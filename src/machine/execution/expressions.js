/** Expression evaluation to runtime values: { type, value }. */
import { decodeCharLiteral, encodeStringLiteral } from '../../language/literals.js';
import {
  convertNumber,
  isIntegerType,
  numericOperation,
  promote,
  SIZE_T,
} from '../../language/numeric.js';
import { CHAR, INT, array, isArray, isPointer, pointer, sizeOf } from '../../language/types.js';
import { addAllocation, pointerValue, ref, sameRef, staticAllocations } from '../memory.js';
import { evalCall } from './calls.js';
import {
  assignToRef,
  evalLValue,
  evalSubscriptPointer,
  isLValueExpression,
  loadLValue,
} from './lvalues.js';
import { checkUnsequenced, evalBinary, evalCompoundAssignment, truthy } from './operators.js';
import { addToPointer } from './pointerArithmetic.js';
import { intResult, requireNumber, semanticError } from './runtime.js';
import { inferExpressionType } from './typeInference.js';

export function evalExpression(expr, ctx, env, frame, expectedType = null) {
  const result = evaluateExpression(expr, ctx, env, frame, expectedType);
  result.integerConstant = isIntegerType(result.type) && isConstantExpression(expr);
  return result;
}

function isConstantExpression(expr) {
  if (
    ['IntLiteral', 'CharLiteral', 'SizeofType', 'SizeofExpression', 'NullLiteral'].includes(
      expr.kind,
    )
  )
    return true;
  if (expr.kind === 'Identifier') return expr.name === 'NULL';
  if (expr.kind === 'Unary') return isConstantExpression(expr.expression);
  if (expr.kind === 'Binary')
    return isConstantExpression(expr.left) && isConstantExpression(expr.right);
  return false;
}

function evaluateExpression(expr, ctx, env, frame, expectedType = null) {
  switch (expr.kind) {
    case 'IntLiteral':
    case 'FloatLiteral':
      return { type: expr.type ?? INT, value: { kind: 'scalar', value: expr.value } };
    case 'CharLiteral':
      return { type: INT, value: { kind: 'scalar', value: decodeCharLiteral(expr.raw) } };
    case 'NullLiteral':
      return intResult(0);
    case 'StringLiteral':
      // Like any array, the literal decays to a pointer to its first char.
      return {
        type: pointer(CHAR),
        value: pointerValue(ref(stringLiteralObject(expr.value, ctx).id, [0])),
      };
    case 'Identifier':
      if (expr.name === 'NULL') return intResult(0);
      // loadLValue decays an array to a pointer to its first element.
      return loadLValue(evalLValue(expr, ctx, env, frame), ctx, expr);
    case 'AddressOf': {
      // C 6.5.3.2: &*E cancels the dereference; &a[n] permits a one-past address.
      if (expr.expression.kind === 'Dereference') {
        const rv = evalExpression(expr.expression.expression, ctx, env, frame);
        if (!isPointer(rv.type))
          throw semanticError(expr, 'address/dereference requires a pointer');
        return rv;
      }
      if (expr.expression.kind === 'Subscript')
        return evalSubscriptPointer(expr.expression, ctx, env, frame);
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
        if (isArray(type))
          throw semanticError(expr, 'array members of temporary structs are not supported');
        const value = object.value.fields?.[expr.field];
        if (!value || value.kind === 'uninit')
          throw semanticError(expr, 'read of uninitialized struct member');
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
        if (rhsAccesses.some(a => a.depth === ctx.callDepth && a.update && sameRef(a.ref, lhs.ref)))
          throw semanticError(expr, 'unsequenced modifications of the assignment target');
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
    case 'Call':
      return evalCall(expr, ctx, env, frame, expectedType);
    case 'Unary': {
      if (expr.operator === '!') {
        const rv = evalExpression(expr.expression, ctx, env, frame, null);
        return { type: INT, value: { kind: 'scalar', value: truthy(rv, expr) ? 0 : 1 } };
      }
      const rv = evalExpression(expr.expression, ctx, env, frame, null);
      requireNumber(rv, expr);
      const type = promote(rv.type);
      const value = expr.operator === '-' ? -rv.value.value : rv.value.value;
      return {
        type,
        value: { kind: 'scalar', value: convertNumber(value, type, { arithmetic: true }) },
      };
    }
    case 'Update': {
      const lv = evalLValue(expr.expression, ctx, env, frame);
      const current = loadLValue(lv, ctx, expr);
      let next;
      if (isPointer(current.type)) {
        if (current.value.kind !== 'pointer')
          throw semanticError(expr, 'pointer update requires a concrete pointer');
        next = {
          type: current.type,
          value: addToPointer(ctx.state, current.value, expr.operator === '++' ? 1 : -1, expr),
        };
      } else {
        requireNumber(current, expr);
        next = numericOperation(expr.operator === '++' ? '+' : '-', current, intResult(1));
      }
      const value = assignToRef(lv.ref, lv.type, next, ctx, expr);
      ctx.accesses.at(-1).update = true;
      return expr.prefix ? { type: lv.type, value } : current;
    }
    case 'Binary':
      return evalBinary(expr, ctx, env, frame);
    case 'SizeofType':
      return {
        type: SIZE_T,
        value: { kind: 'scalar', value: sizeOf(expr.type, ctx.state.structTypes) },
      };
    case 'SizeofExpression':
      return {
        type: SIZE_T,
        value: {
          kind: 'scalar',
          value: sizeOf(
            inferExpressionType(expr.expression, ctx, env, frame),
            ctx.state.structTypes,
          ),
        },
      };
    case 'InitializerList': {
      if (!expectedType || expr.elements.length !== 1)
        throw semanticError(expr, 'scalar initializer requires exactly one element');
      return evalExpression(expr.elements[0], ctx, env, frame, expectedType);
    }
    default:
      throw semanticError(expr, `unsupported expression ${expr.kind}`);
  }
}

/**
 * The static char array holding a literal, created on first evaluation. Equal literals
 * share one object, which C permits (6.4.5p7) and every common compiler does.
 */
export function stringLiteralObject(codes, ctx) {
  const name = encodeStringLiteral(codes);
  return (
    staticAllocations(ctx.state).find(a => a.name === name) ??
    addAllocation(ctx.state, {
      name,
      type: array(CHAR, codes.length + 1),
      storage: { kind: 'static' },
      value: {
        kind: 'aggregate',
        elements: [...codes, 0].map(value => ({ kind: 'scalar', value })),
      },
    })
  );
}

export function evalCondition(expr, ctx, env, frame) {
  return truthy(evalExpression(expr, ctx, env, frame, null), expr);
}
