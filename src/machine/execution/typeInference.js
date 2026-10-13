/** Static expression types, used where C needs a type without evaluating (sizeof, initializers). */
import { INVALID, UNSUPPORTED } from '../../language/diagnostics.js';
import { arithmeticType, isIntegerType, promote, SIZE_T } from '../../language/numeric.js';
import {
  CHAR,
  INT,
  NULLPTR_T,
  array,
  isArray,
  isNullptrType,
  isPointer,
  isPrimitive,
  isStruct,
  pointer,
  resolveStructType,
  typeEquals,
} from '../../language/types.js';
import { refType } from '../memory.js';
import { lookupBinding, semanticError } from './runtime.js';

export function inferExpressionType(expr, ctx, env, frame) {
  const infer = e => inferExpressionType(e, ctx, env, frame);
  const decay = t => (isArray(t) ? pointer(t.of) : t);
  if (expr.kind === 'Identifier') {
    if (expr.name === 'NULL') return INT;
    const r = lookupBinding(env, expr.name);
    if (!r) throw semanticError(expr, `use of undeclared variable '${expr.name}'`, INVALID);
    return refType(ctx.state, r);
  }
  if (expr.kind === 'Dereference') {
    const t = decay(infer(expr.expression));
    if (!isPointer(t)) throw semanticError(expr, 'cannot dereference non-pointer', INVALID);
    return t.to;
  }
  if (expr.kind === 'AddressOf') return pointer(infer(expr.expression));
  if (expr.kind === 'Subscript') {
    const a = decay(infer(expr.array)),
      b = decay(infer(expr.index));
    if (isPointer(a) && isIntegerType(b)) return a.to;
    if (isPointer(b) && isIntegerType(a)) return b.to;
    throw semanticError(expr, 'subscripted expression has no element type', INVALID);
  }
  if (expr.kind === 'Member') {
    let type = infer(expr.object);
    if (expr.viaPointer) {
      type = decay(type);
      if (!isPointer(type)) throw semanticError(expr, "'->' requires a pointer to struct", INVALID);
      type = type.to;
    }
    if (!isStruct(type)) throw semanticError(expr, 'member access requires a struct', INVALID);
    const field = resolveStructType(type, ctx.state.structTypes).fields?.find(
      f => f.name === expr.field,
    );
    if (!field)
      throw semanticError(expr, `struct ${type.name} has no field '${expr.field}'`, INVALID);
    return field.type;
  }
  if (expr.kind === 'IntLiteral' || expr.kind === 'FloatLiteral') return expr.type ?? INT;
  if (expr.kind === 'NullLiteral') return expr.nullptr ? NULLPTR_T : INT;
  if (expr.kind === 'CharLiteral') return INT;
  if (expr.kind === 'StringLiteral') return array(CHAR, expr.value.length + 1);
  if (expr.kind === 'SizeofType' || expr.kind === 'SizeofExpression') return SIZE_T;
  if (expr.kind === 'Call') {
    if (expr.name === 'free') return { kind: 'void' };
    if (expr.name === 'malloc') return pointer({ kind: 'void' });
    if (expr.name === 'printf') return INT;
    const fn = ctx.functions.get(expr.name);
    if (!fn) throw semanticError(expr, `call to unknown function '${expr.name}'`, INVALID);
    return fn.returnType;
  }
  if (expr.kind === 'Assignment') return infer(expr.left);
  if (expr.kind === 'Update') return decay(infer(expr.expression));
  if (expr.kind === 'Unary') {
    const type = decay(infer(expr.expression));
    if (expr.operator === '!') {
      if (!isPrimitive(type) && !isPointer(type) && !isNullptrType(type))
        throw semanticError(expr, 'logical operator requires scalar', INVALID);
      return INT;
    }
    if (!isPrimitive(type)) throw semanticError(expr, 'unary arithmetic requires number', INVALID);
    return promote(type);
  }
  if (expr.kind === 'Binary') {
    const a = decay(infer(expr.left)),
      b = decay(infer(expr.right));
    if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expr.operator)) return INT;
    if (['+', '-'].includes(expr.operator)) {
      if (isPointer(a) && isIntegerType(b)) return a;
      if (expr.operator === '+' && isIntegerType(a) && isPointer(b)) return b;
      if (expr.operator === '-' && isPointer(a) && typeEquals(a, b))
        return { kind: 'primitive', name: 'long' };
    }
    if (isPrimitive(a) && isPrimitive(b)) {
      if (expr.operator === '%' && (!isIntegerType(a) || !isIntegerType(b)))
        throw semanticError(expr, 'remainder requires integers', INVALID);
      return arithmeticType(a, b);
    }
    throw semanticError(expr, 'invalid binary operand types', INVALID);
  }
  throw semanticError(
    expr,
    `cannot determine type of ${expr.kind} without evaluation`,
    UNSUPPORTED,
  );
}
