/** Binary, compound-assignment, comparison and logical operators, plus unsequenced-access checks. */
import { INVALID, UNDEFINED, UNSUPPORTED } from '../../language/diagnostics.js';
import {
  arithmeticType,
  compareValues,
  convertNumber,
  numericOperation,
} from '../../language/numeric.js';
import {
  isPointer,
  isPrimitive,
  isStruct,
  isVoidPointer,
  typeEquals,
  typeToString,
} from '../../language/types.js';
import { addressOffset } from '../addresses.js';
import { ref, resolveRef, samePath } from '../memory.js';
import { evalExpression } from './expressions.js';
import { addToPointer, arrayPosition, requireElementStride } from './pointerArithmetic.js';
import {
  intResult,
  isIntegerRuntime,
  isNumberRuntime,
  requireInteger,
  requireNumber,
  semanticError,
} from './runtime.js';

export function evalBinary(expr, ctx, env, frame) {
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
    const result =
      expr.operator === '<'
        ? cmp < 0
        : expr.operator === '<='
          ? cmp <= 0
          : expr.operator === '>'
            ? cmp > 0
            : cmp >= 0;
    return intResult(Number(result));
  }

  if (['+', '-'].includes(expr.operator)) {
    if (isPointer(left.type) && isIntegerRuntime(right)) {
      if (left.value.kind !== 'pointer')
        throw semanticError(expr, 'pointer arithmetic requires a concrete pointer', UNDEFINED);
      return {
        type: left.type,
        value: addToPointer(
          ctx.state,
          left.value,
          expr.operator === '+' ? right.value.value : -right.value.value,
          expr,
          left.type.to,
        ),
      };
    }
    if (expr.operator === '+' && isIntegerRuntime(left) && isPointer(right.type)) {
      if (right.value.kind !== 'pointer')
        throw semanticError(expr, 'pointer arithmetic requires a concrete pointer', UNDEFINED);
      return {
        type: right.type,
        value: addToPointer(ctx.state, right.value, left.value.value, expr, right.type.to),
      };
    }
    if (isNumberRuntime(left) && isNumberRuntime(right)) {
      return numericOperation(expr.operator, left, right);
    }
    if (
      expr.operator === '-' &&
      isPointer(left.type) &&
      isPointer(right.type) &&
      typeEquals(left.type, right.type)
    ) {
      if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer')
        throw semanticError(expr, 'pointer subtraction requires concrete pointers', UNDEFINED);
      const a = arrayPosition(ctx.state, left.value.target),
        b = arrayPosition(ctx.state, right.value.target);
      if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix))
        throw semanticError(
          expr,
          'pointer subtraction requires pointers into the same array',
          UNDEFINED,
        );
      // Equal positions differ by 0 whatever the step; otherwise the units must be elements.
      if (a.index !== b.index) requireElementStride(ctx.state, a, left.type.to, expr);
      return {
        type: { kind: 'primitive', name: 'long' },
        value: { kind: 'scalar', value: a.index - b.index },
      };
    }
  }

  if (['*', '/', '%'].includes(expr.operator)) {
    requireNumber(left, expr.left);
    requireNumber(right, expr.right);
    return numericOperation(expr.operator, left, right);
  }
  throw semanticError(expr, `binary operator '${expr.operator}' is not supported yet`, UNSUPPORTED);
}

export function evalCompoundAssignment(operator, left, right, ctx, node) {
  const op = operator.slice(0, -1);
  if ((op === '+' || op === '-') && isPointer(left.type)) {
    requireInteger(right, node);
    if (left.value.kind !== 'pointer')
      throw semanticError(
        node,
        'pointer compound assignment requires a concrete pointer',
        UNDEFINED,
      );
    return {
      type: left.type,
      value: addToPointer(
        ctx.state,
        left.value,
        op === '+' ? right.value.value : -right.value.value,
        node,
        left.type.to,
      ),
    };
  }
  requireNumber(left, node);
  requireNumber(right, node);
  return numericOperation(op, left, right);
}

export function truthy(rv, node) {
  if (isPrimitive(rv.type) && rv.value.kind === 'scalar') return rv.value.value !== 0;
  if (rv.value.kind === 'null') return false;
  if (isPointer(rv.type) && rv.value.kind === 'pointer') return true;
  throw semanticError(
    node,
    `condition requires a scalar value, got ${typeToString(rv.type)}`,
    INVALID,
  );
}

function scalarEquals(left, right, ctx, node) {
  if (isNumberRuntime(left) && isNumberRuntime(right)) {
    const type = arithmeticType(left.type, right.type);
    return convertNumber(left.value.value, type) === convertNumber(right.value.value, type);
  }
  if (
    isPointer(left.type) &&
    isPointer(right.type) &&
    !typeEquals(left.type, right.type) &&
    !isVoidPointer(left.type) &&
    !isVoidPointer(right.type)
  ) {
    throw semanticError(
      node,
      `comparison of incompatible pointer types ${typeToString(left.type)} and ${typeToString(right.type)}`,
      INVALID,
    );
  }

  const leftNull = isNullLike(left),
    rightNull = isNullLike(right);
  if (leftNull && rightNull) return true;
  if (isPointer(left.type) && left.value.kind === 'pointer' && rightNull) return false;
  if (isPointer(right.type) && right.value.kind === 'pointer' && leftNull) return false;

  if (isPointer(left.type) && isPointer(right.type)) {
    if (left.value.kind === 'null' || right.value.kind === 'null')
      return left.value.kind === right.value.kind;
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer')
      throw semanticError(
        node,
        'pointer comparison requires initialized pointer values',
        UNDEFINED,
      );
    return (
      left.value.target.allocationId === right.value.target.allocationId &&
      addressOffset(ctx.state, left.value.target) === addressOffset(ctx.state, right.value.target)
    );
  }
  throw semanticError(
    node,
    `cannot compare ${typeToString(left.type)} and ${typeToString(right.type)}`,
    INVALID,
  );
}

function compareScalars(left, right, ctx, node) {
  if (isNumberRuntime(left) && isNumberRuntime(right)) {
    const type = arithmeticType(left.type, right.type);
    return compareValues(
      convertNumber(left.value.value, type),
      convertNumber(right.value.value, type),
    );
  }
  if (isPointer(left.type) && isPointer(right.type) && typeEquals(left.type, right.type)) {
    if (left.value.kind !== 'pointer' || right.value.kind !== 'pointer')
      throw semanticError(
        node,
        'relational pointer comparison requires concrete pointers',
        UNDEFINED,
      );
    const a = arrayPosition(ctx.state, left.value.target),
      b = arrayPosition(ctx.state, right.value.target);
    if (!a || !b || a.allocationId !== b.allocationId || !samePath(a.prefix, b.prefix)) {
      const l = left.value.target,
        r = right.value.target;
      if (l.allocationId === r.allocationId && samePath(l.path.slice(0, -1), r.path.slice(0, -1))) {
        const parent = resolveRef(ctx.state, ref(l.allocationId, l.path.slice(0, -1)));
        if (isStruct(parent.type) && l.path.at(-1) !== '$onePast' && r.path.at(-1) !== '$onePast') {
          return Math.sign(addressOffset(ctx.state, l) - addressOffset(ctx.state, r));
        }
      }
      throw semanticError(
        node,
        'relational pointer comparison requires pointers into the same array',
        UNDEFINED,
      );
    }
    if (a.index !== b.index) requireElementStride(ctx.state, a, left.type.to, node);
    return Math.sign(a.index - b.index);
  }
  throw semanticError(
    node,
    `relational comparison requires numbers or pointers into the same array`,
    INVALID,
  );
}

export function isNullLike(rv) {
  return (
    rv.value.kind === 'null' || (isIntegerRuntime(rv) && rv.integerConstant && rv.value.value === 0)
  );
}

export function checkUnsequenced(left, right, ctx, node) {
  // Function bodies are indeterminately sequenced relative to caller evaluations
  // (C11 6.5.2.2p10); argument expressions themselves are unsequenced.
  for (const a of left)
    for (const b of right) {
      const overlap =
        a.ref.allocationId === b.ref.allocationId &&
        (a.ref.path.every((part, i) => b.ref.path[i] === part) ||
          b.ref.path.every((part, i) => a.ref.path[i] === part));
      if (
        a.depth === ctx.callDepth &&
        b.depth === ctx.callDepth &&
        (a.write || b.write) &&
        overlap
      ) {
        throw semanticError(node, 'unsequenced read/modification of the same object', UNDEFINED);
      }
    }
}
