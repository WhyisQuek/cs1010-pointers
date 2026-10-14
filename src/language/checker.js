/** Constraint checks run before execution, including branches that will be skipped. */
import {
  CHAR,
  INT,
  LIBRARY_NAMES,
  NULLPTR_T,
  array,
  declarationToC,
  isArray,
  isNullptrType,
  isPointer,
  isVoidPointer,
  isPrimitive,
  isStruct,
  pointer,
  resolveStructType,
  sizeOf,
  typeEquals,
  typeToString,
} from './types.js';
import {
  SIZE_T,
  arithmeticType,
  convertNumber,
  isBoolType,
  isIntegerType,
  numericOperation,
  promote,
} from './numeric.js';
import { decodeCharLiteral, stringInitializerLiteral } from './literals.js';
import { STRING_LITERAL, argumentTypeError, formatArguments, parseFormat } from './format.js';
import {
  INVALID,
  LIMIT,
  UNDEFINED,
  UNSUPPORTED,
  diagnostic,
  diagnosticKind,
} from './diagnostics.js';
import { MAX_ARRAY_LENGTH } from './limits.js';

/** Standard names a valid C23 program may use that PointerViz does not provide. */
const UNPROVIDED_STANDARD_NAMES = new Set([
  'abort',
  'abs',
  'aligned_alloc',
  'assert',
  'exit',
  'free_sized',
  'memcpy',
  'memset',
  'putchar',
  'puts',
  'realloc',
  'scanf',
  'static_assert',
  'strcmp',
  'strcpy',
  'strlen',
  'unreachable',
]);

export function checkProgram(program) {
  const structs = Object.fromEntries((program.structs ?? []).map(t => [t.name, t]));
  const functions = new Map(program.functions.map(f => [f.name, f]));
  const visibleFunctions = new Set();
  if (functions.size !== program.functions.length)
    throw diagnostic(INVALID, 'duplicate function definition');
  if (!functions.has('main'))
    throw diagnostic(
      INVALID,
      'no main() function found — wrap your entry code in int main() { ... }',
    );
  // C23 7.1.3 reserves these: defining one is undefined, and the built-ins would bypass it.
  for (const name of LIBRARY_NAMES)
    if (name !== 'NULL' && functions.has(name))
      throw diagnostic(UNDEFINED, `cannot define '${name}': it is a standard library function`);
  const decay = t => (isArray(t) ? pointer(t.of) : t);
  const scalar = t => isPrimitive(t) || isPointer(t) || isNullptrType(t);
  /** C23 6.3.2.3p3: an integer constant expression with the value 0, or nullptr. */
  const nullPointerConstant = (t, e, env) =>
    isNullptrType(t) || (isIntegerType(t) && constant(e, env) === 0);
  // Parsed programs record where each struct is defined; hand-built test programs do not.
  const structPositions = program.structPositions;
  /** The incomplete type that `type` is or contains at `e`'s position in the source, or null. */
  function incompleteAt(type, e) {
    if (type.kind === 'void') return 'void';
    if (isArray(type)) return incompleteAt(type.of, e);
    if (!isStruct(type)) return null;
    if (structPositions && !(type.name in structPositions)) return typeToString(type);
    if (structPositions?.[type.name] > (e.loc?.offset ?? Infinity)) return typeToString(type);
    return null;
  }
  /** Pointer arithmetic needs a complete object type to scale by (C23 6.5.6p2). */
  function requireCompletePointee(type, e) {
    const incomplete = incompleteAt(type.to, e);
    if (incomplete) fail(e, `arithmetic on a pointer to incomplete type ${incomplete}`);
  }
  // Most checker errors are constraint violations; callers name the other categories.
  const fail = (e, message, kind = INVALID) => {
    throw diagnostic(kind, `${message}${e.loc?.startLine ? ` (line ${e.loc.startLine})` : ''}`);
  };
  function lookup(env, name, e) {
    if (name === 'NULL') return INT;
    for (let scope = env; scope; scope = scope.parent)
      if (scope.names.has(name)) return scope.names.get(name);
    fail(e, `use of undeclared variable '${name}'`);
  }
  const scope = parent => ({ parent, names: new Map() });
  function declare(env, name, type, e) {
    if (name === 'NULL') fail(e, 'NULL is a predefined macro in PointerViz');
    // Valid for a block-scope name in C; PointerViz reserves them so states regenerate as C.
    if (LIBRARY_NAMES.has(name))
      fail(e, `'${name}' is reserved for the standard library`, UNSUPPORTED);
    if (env.names.has(name)) fail(e, `redeclaration of '${name}'`);
    env.names.set(name, type);
  }
  function constant(e, env) {
    // true and false are predefined constants, not integer constants (C23 6.6p8), so an
    // expression using them is not an integer constant expression or a null pointer constant.
    if (e.kind === 'IntLiteral') return isBoolType(e.type) ? undefined : e.value;
    if (e.kind === 'CharLiteral') return decodeCharLiteral(e.raw);
    // nullptr is a null pointer constant but not an integer constant expression.
    if (e.kind === 'NullLiteral') return e.nullptr ? undefined : 0;
    if (e.kind === 'Identifier' && e.name === 'NULL') return 0;
    if (e.kind === 'SizeofType') return sizeOf(e.type, structs);
    if (e.kind === 'SizeofExpression') return sizeOf(expression(e.expression, env), structs);
    if (e.kind === 'Unary') {
      const n = constant(e.expression, env);
      return n === undefined
        ? undefined
        : e.operator === '!'
          ? Number(!n)
          : convertNumber(e.operator === '-' ? -n : n, expression(e, env), { arithmetic: true });
    }
    if (e.kind === 'Binary') {
      // C23 6.6p3, 6.5.13: the unevaluated operand of && or || must still have constant
      // form, but its value (which might divide by zero or overflow) is never computed.
      if (['&&', '||'].includes(e.operator)) {
        const a = constant(e.left, env);
        if (a === undefined || !constantForm(e.right)) return undefined;
        if (e.operator === '&&' ? !a : a) return Number(e.operator === '||');
        const b = constant(e.right, env);
        return b === undefined ? undefined : Number(Boolean(b));
      }
      const a = constant(e.left, env),
        b = constant(e.right, env);
      if (a === undefined || b === undefined) return undefined;
      const at = expression(e.left, env),
        bt = expression(e.right, env);
      if (['+', '-', '*', '/', '%'].includes(e.operator))
        return numericOperation(
          e.operator,
          { type: at, value: { kind: 'scalar', value: a } },
          { type: bt, value: { kind: 'scalar', value: b } },
        ).value.value;
      const type = arithmeticType(at, bt),
        x = convertNumber(a, type),
        y = convertNumber(b, type);
      const operations = {
        '==': () => Number(x === y),
        '!=': () => Number(x !== y),
        '<': () => Number(x < y),
        '<=': () => Number(x <= y),
        '>': () => Number(x > y),
        '>=': () => Number(x >= y),
      };
      return operations[e.operator]?.();
    }
    return undefined;
  }
  /** Whether `e` has the shape of an integer constant expression, without evaluating it. */
  function constantForm(e) {
    if (e.kind === 'IntLiteral') return !isBoolType(e.type);
    if (e.kind === 'NullLiteral') return !e.nullptr;
    if (['CharLiteral', 'SizeofType', 'SizeofExpression'].includes(e.kind)) return true;
    if (e.kind === 'Identifier') return e.name === 'NULL';
    if (e.kind === 'Unary') return constantForm(e.expression);
    if (e.kind === 'Binary') return constantForm(e.left) && constantForm(e.right);
    return false;
  }
  function compatible(to, from, e, env) {
    from = decay(from);
    if (isPrimitive(to) && isPrimitive(from)) return;
    if (isBoolType(to) && (isPointer(from) || isNullptrType(from))) return;
    if (isStruct(to) && typeEquals(to, from)) return;
    if (isPointer(to)) {
      if (typeEquals(to, from) || nullPointerConstant(from, e, env)) return;
      // Any object pointer converts to and from void * (C23 6.5.16.1p1).
      if (isPointer(from) && (isVoidPointer(to) || isVoidPointer(from))) return;
      if (isPointer(from)) fail(e, 'incompatible pointer types');
    }
    fail(e, `cannot assign ${typeToString(from)} to ${typeToString(to)}`);
  }
  function lvalue(e, env, assign = true) {
    if (!['Identifier', 'Dereference', 'Subscript', 'Member'].includes(e.kind))
      fail(e, 'expression is not assignable');
    if (e.kind === 'Identifier' && e.name === 'NULL') fail(e, 'NULL is not an lvalue');
    const type = expression(e, env);
    if (assign && isArray(type)) fail(e, 'arrays are not assignable');
    if (e.kind === 'Member' && !e.viaPointer) lvalue(e.object, env, false);
    return type;
  }
  function binary(op, a, b, e, env) {
    a = decay(a);
    b = decay(b);
    if (['&&', '||'].includes(op)) {
      if (!scalar(a) || !scalar(b)) fail(e, 'logical operator requires scalar operands');
      return INT;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      if (isPrimitive(a) && isPrimitive(b)) return INT;
      if (isPointer(a) && isPointer(b) && typeEquals(a, b)) return INT;
      // Equality also accepts a pointer and a void * (C23 6.5.9p2); ordering does not.
      if (['==', '!='].includes(op) && isPointer(a) && isPointer(b))
        if (isVoidPointer(a) || isVoidPointer(b)) return INT;
      // C23 6.5.9p2: a pointer or nullptr_t may be compared with a null pointer constant.
      if (['==', '!='].includes(op)) {
        const aNull = nullPointerConstant(a, e.left, env),
          bNull = nullPointerConstant(b, e.right, env);
        if (
          ((isPointer(a) || isNullptrType(a)) && bNull) ||
          ((isPointer(b) || isNullptrType(b)) && aNull)
        )
          return INT;
      }
      fail(e, 'cannot compare incompatible operand types');
    }
    if (['+', '-'].includes(op)) {
      if (isPointer(a) && isIntegerType(b)) {
        requireCompletePointee(a, e);
        return a;
      }
      if (op === '+' && isIntegerType(a) && isPointer(b)) {
        requireCompletePointee(b, e);
        return b;
      }
      if (op === '-' && isPointer(a) && typeEquals(a, b)) {
        requireCompletePointee(a, e);
        return { kind: 'primitive', name: 'long' };
      }
    }
    if (!['+', '-', '*', '/', '%'].includes(op))
      fail(e, `binary operator '${op}' is not supported`, UNSUPPORTED);
    if (!isPrimitive(a) || !isPrimitive(b))
      fail(e, 'arithmetic requires numbers or a pointer and integer offset');
    if (op === '%' && (!isIntegerType(a) || !isIntegerType(b)))
      fail(e, 'remainder requires integer operands');
    return arithmeticType(a, b);
  }
  function expression(e, env) {
    switch (e.kind) {
      case 'Identifier':
        return lookup(env, e.name, e);
      case 'IntLiteral':
      case 'FloatLiteral':
        return e.type ?? INT;
      case 'CharLiteral':
        decodeCharLiteral(e.raw);
        return INT;
      case 'NullLiteral':
        return e.nullptr ? NULLPTR_T : INT;
      case 'AddressOf':
        return pointer(lvalue(e.expression, env, false));
      case 'Dereference': {
        const t = decay(expression(e.expression, env));
        if (!isPointer(t)) fail(e, 'cannot dereference non-pointer');
        return t.to;
      }
      case 'Subscript': {
        const a = decay(expression(e.array, env)),
          b = decay(expression(e.index, env));
        const base =
          isPointer(a) && isIntegerType(b) ? a : isPointer(b) && isIntegerType(a) ? b : null;
        if (!base) fail(e, 'subscript requires pointer and integer');
        requireCompletePointee(base, e);
        return base.to;
      }
      case 'Member': {
        let t = expression(e.object, env);
        if (e.viaPointer) {
          t = decay(t);
          if (!isPointer(t)) fail(e, "'->' requires pointer to struct");
          t = t.to;
        }
        if (!isStruct(t)) fail(e, 'member access requires struct');
        // Members are only known once the struct is complete (C23 6.5.2.3p1).
        if (incompleteAt(t, e)) fail(e, `${typeToString(t)} is incomplete at this point`);
        const field = resolveStructType(t, structs).fields?.find(f => f.name === e.field);
        if (!field) fail(e, `struct ${t.name} has no field '${e.field}'`);
        return field.type;
      }
      case 'Assignment': {
        const lhs = lvalue(e.left, env),
          rhs = expression(e.right, env);
        if (e.operator === '=') compatible(lhs, rhs, e.right, env);
        else {
          const result = binary(e.operator.slice(0, -1), lhs, rhs, e, env);
          compatible(lhs, result, e, env);
        }
        return lhs;
      }
      case 'Update': {
        const type = lvalue(e.expression, env);
        if (!scalar(type)) fail(e, 'update requires scalar lvalue');
        if (isPointer(type)) requireCompletePointee(type, e);
        return type;
      }
      case 'Unary': {
        const type = decay(expression(e.expression, env));
        if (e.operator === '!') {
          if (!scalar(type)) fail(e, 'logical operator requires scalar');
          return INT;
        }
        if (!isPrimitive(type)) fail(e, 'unary arithmetic requires number');
        return promote(type);
      }
      case 'Binary':
        return binary(e.operator, expression(e.left, env), expression(e.right, env), e, env);
      case 'SizeofType':
      case 'SizeofExpression': {
        const type = e.kind === 'SizeofType' ? e.type : expression(e.expression, env);
        if (isArray(type) && type.length === null) fail(e, 'sizeof requires a complete array type');
        // C23 6.5.3.4p1: sizeof needs a type that is complete where sizeof appears.
        const incomplete = incompleteAt(type, e);
        if (incomplete && incomplete !== 'void')
          fail(e, `sizeof requires a complete type; ${incomplete} is incomplete at this point`);
        sizeOf(type, structs);
        return SIZE_T;
      }
      case 'StringLiteral':
        return stringLiteralType(e);
      case 'Call': {
        for (let s = env; s; s = s.parent)
          if (s.names.has(e.name)) fail(e, `called object '${e.name}' is not a function`);
        if (e.name === 'printf') return printf(e, env);
        const args = e.arguments.map(a => expression(a, env));
        if (e.name === 'calloc') {
          if (args.length !== 2) fail(e, 'calloc expects exactly two arguments');
          // Both sizes convert to size_t like any prototyped argument (C23 6.5.2.2p7).
          if (!args.every(isPrimitive)) fail(e, 'calloc sizes must be numbers');
          return pointer({ kind: 'void' });
        }
        if (e.name === 'malloc' || e.name === 'free') {
          if (args.length !== 1) fail(e, `${e.name} expects exactly one argument`);
          if (e.name === 'malloc') {
            // The size converts to size_t like any prototyped argument (C23 6.5.2.2p7).
            if (!isPrimitive(args[0])) fail(e, 'malloc size must be a number');
            return pointer({ kind: 'void' });
          }
          if (!isPointer(decay(args[0])) && !nullPointerConstant(args[0], e.arguments[0], env))
            fail(e, 'free expects a pointer or NULL');
          return { kind: 'void' };
        }
        const fn = functions.get(e.name);
        if (!fn)
          fail(
            e,
            `call to unknown function '${e.name}'`,
            UNPROVIDED_STANDARD_NAMES.has(e.name) ? UNSUPPORTED : INVALID,
          );
        if (!visibleFunctions.has(e.name))
          fail(e, `function '${e.name}' must be defined before use; prototypes are not supported`);
        if (args.length !== fn.params.length)
          fail(e, `${e.name} expects ${fn.params.length} argument(s), got ${args.length}`);
        args.forEach((arg, i) => compatible(fn.params[i].type, arg, e.arguments[i], env));
        return fn.returnType;
      }
      default:
        fail(e, `unsupported expression ${e.kind}`, UNSUPPORTED);
    }
  }
  function printf(e, env) {
    const [format, ...rest] = e.arguments;
    if (format?.kind !== 'StringLiteral')
      fail(e, 'printf requires a string literal as its format argument', UNSUPPORTED);
    let needed;
    try {
      needed = formatArguments(parseFormat(format.value));
    } catch (error) {
      fail(format, `printf format: ${error.message}`, diagnosticKind(error));
    }
    const types = rest.map(a => (a.kind === 'StringLiteral' ? STRING_LITERAL : expression(a, env)));
    if (types.length < needed.length)
      fail(e, `printf format needs ${needed.length} argument(s), got ${types.length}`, UNDEFINED);
    needed.forEach((n, i) => {
      const message = argumentTypeError(n, decay(types[i]));
      // A missing or mismatched printf argument is undefined behavior (C23 7.23.6.1p2, p9).
      if (message) fail(rest[i], message, UNDEFINED);
    });
    return INT;
  }
  function stringLiteralType(e) {
    if (e.value.length + 1 > MAX_ARRAY_LENGTH)
      fail(e, `string literal must be shorter than ${MAX_ARRAY_LENGTH} characters`, LIMIT);
    return array(CHAR, e.value.length + 1);
  }
  /** C 6.7.9p14: a char array may be initialized by a string literal, optionally in braces. */
  function stringInitializer(type, e) {
    if (!isArray(type) || !typeEquals(type.of, CHAR)) return null;
    const literal = stringInitializerLiteral(e);
    if (!literal) return null;
    stringLiteralType(literal);
    // The terminating '\0' is dropped when the array has room for exactly the characters.
    if (type.length === null) type.length = literal.value.length + 1;
    else if (literal.value.length > type.length)
      fail(e, `initializer-string is too long for ${typeToString(type)}`);
    return literal;
  }
  function initializer(type, e, env, name) {
    if (stringInitializer(type, e)) return;
    if (e.kind !== 'InitializerList') {
      compatible(type, expression(e, env), e, env);
      return;
    }
    // C23 6.7.10p4: {} initializes any complete object as if it were static (to zero), but
    // an array of unknown size cannot take its length from an empty list.
    if (!e.elements.length) {
      if (isArray(type) && type.length === null)
        fail(e, 'an empty initializer cannot size an array of unknown size');
      return;
    }
    if (!isArray(type) && !isStruct(type) && e.elements.length > 1) {
      // A scalar takes one value; a list of several usually means an array was intended.
      const count = e.elements.length;
      // Nested members have no declared name of their own.
      const who = name ? `'${name}'` : 'This member';
      if (!isPointer(type))
        fail(
          e,
          `${who} is a single ${typeToString(type)}, but the { ... } list has ${count} values`,
        );
      const declared = name ?? 'name';
      fail(
        e,
        `${who} is a pointer (${typeToString(type)}): it holds one address, not a list of ${count} values. ` +
          `To store the values, declare an array: ${declarationToC(type.to, `${declared}[]`)} = { ... };` +
          (typeEquals(type.to, CHAR)
            ? ` or point at a string literal: ${declarationToC(type, declared)} = "...";`
            : ''),
      );
    }
    function consume(t, elements, cursor) {
      const inferLength = isArray(t) && t.length === null;
      const members = isArray(t)
        ? Array(inferLength ? MAX_ARRAY_LENGTH : t.length).fill(t.of)
        : isStruct(t)
          ? resolveStructType(t, structs).fields.map(f => f.type)
          : [t];
      let count = 0;
      for (const member of members) {
        if (cursor.i >= elements.length) break;
        count++;
        const child = elements[cursor.i];
        if (child.kind === 'InitializerList' || stringInitializer(member, child)) {
          cursor.i++;
          initializer(member, child, env);
        } else if (
          isArray(member) ||
          (isStruct(member) && !typeEquals(member, expression(child, env)))
        )
          consume(member, elements, cursor);
        else {
          cursor.i++;
          compatible(member, expression(child, env), child, env);
        }
      }
      if (inferLength) {
        if (cursor.i < elements.length)
          fail(e, `array size must be between 1 and ${MAX_ARRAY_LENGTH}`, LIMIT);
        t.length = count;
      }
    }
    const cursor = { i: 0 };
    consume(type, e.elements, cursor);
    if (cursor.i < e.elements.length) fail(e, 'too many initializers');
  }
  function statement(s, env, fn, depth = 0) {
    switch (s.kind) {
      case 'Empty':
        return;
      case 'Declaration':
        for (const d of s.declarations) {
          declare(env, d.name, d.type, d);
          if (d.initializer) initializer(d.type, d.initializer, env, d.name);
        }
        return;
      case 'ExpressionStatement':
        expression(s.expression, env);
        return;
      case 'Block': {
        const local = scope(env);
        s.statements.forEach(s => statement(s, local, fn, depth));
        return;
      }
      case 'Return':
        if (fn.returnType.kind === 'void') {
          if (s.expression) fail(s, 'void function cannot return a value');
        } else {
          if (!s.expression) fail(s, 'non-void function must return a value');
          compatible(fn.returnType, expression(s.expression, env), s.expression, env);
        }
        return;
      case 'Break':
      case 'Continue':
        if (!depth) fail(s, `${s.kind.toLowerCase()} used outside a loop`);
        return;
      case 'If':
        if (!scalar(decay(expression(s.condition, env)))) fail(s, 'condition requires scalar');
        statement(s.consequence, env, fn, depth);
        if (s.alternative) statement(s.alternative, env, fn, depth);
        return;
      case 'While':
        if (!scalar(decay(expression(s.condition, env)))) fail(s, 'condition requires scalar');
        statement(s.body, env, fn, depth + 1);
        return;
      case 'For': {
        const local = scope(env);
        if (s.initializer) statement(s.initializer, local, fn, depth);
        if (s.condition && !scalar(decay(expression(s.condition, local))))
          fail(s, 'condition requires scalar');
        if (s.update) expression(s.update, local);
        statement(s.body, local, fn, depth + 1);
        return;
      }
      default:
        fail(s, `unsupported statement ${s.kind}`, UNSUPPORTED);
    }
  }
  for (const fn of program.functions) {
    visibleFunctions.add(fn.name);
    const env = scope(null);
    if (fn.name === 'main' && (!typeEquals(fn.returnType, INT) || fn.params.length))
      fail(fn, 'PointerViz requires int main(void)', UNSUPPORTED);
    fn.params.forEach(p => declare(env, p.name, p.type, p));
    fn.statements.forEach(s => statement(s, env, fn));
  }
}
