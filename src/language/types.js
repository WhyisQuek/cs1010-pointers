/**
 * PointerViz Mini-C type system.
 *
 * Named structs use a finite description: a struct field may point to a named
 * struct without embedding the whole definition recursively. Program/state
 * registries retain the complete struct definitions.
 */
import { INVALID, LIMIT, diagnostic } from './diagnostics.js';
import { MAX_ARRAY_LENGTH, MAX_OBJECT_SCALARS } from './limits.js';

/**
 * `size_t` is a typedef of `unsigned long` under LP64: the same type for every rule,
 * but it keeps its spelling for display. `_Bool` is the C11 spelling of `bool`.
 */
export const primitive = name =>
  name === 'size_t'
    ? { kind: 'primitive', name: 'unsigned long', alias: 'size_t' }
    : { kind: 'primitive', name: name === '_Bool' ? 'bool' : name };
export const pointer = to => ({ kind: 'pointer', to: structuredClone(to) });
export const array = (of, length) => {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ARRAY_LENGTH) {
    throw diagnostic(
      Number.isSafeInteger(length) && length < 1 ? INVALID : LIMIT,
      `array length must be between 1 and ${MAX_ARRAY_LENGTH}`,
    );
  }
  return { kind: 'array', of: structuredClone(of), length };
};
export const structRef = name => ({ kind: 'struct', name });
export const structType = (name, fields) => ({
  kind: 'struct',
  name,
  fields: structuredClone(fields),
});

export const INT = primitive('int');
export const CHAR = primitive('char');
export const VOID = Object.freeze({ kind: 'void' });
export const isVoidPointer = type => type?.kind === 'pointer' && type.to?.kind === 'void';
/**
 * Heap storage from malloc that has no effective type yet (C23 6.5p6): only its size is
 * known. Converting a pointer to it into a T * gives it type T (see execution/lvalues.js).
 */
export const block = bytes => ({ kind: 'block', bytes });
export const isBlock = type => type?.kind === 'block';
/** The alignment of every malloc block: the largest fundamental alignment under LP64. */
export const MALLOC_ALIGNMENT = 16;
/** The type of nullptr (C23 7.21.2): a scalar that is neither arithmetic nor a pointer. */
export const NULLPTR_T = Object.freeze({ kind: 'nullptr_t' });
export const isNullptrType = type => type?.kind === 'nullptr_t';

/** Arithmetic types supported by the Mini-C subset, in editor display order. */
export const PRIMITIVE_NAMES = Object.freeze([
  'int',
  'char',
  'bool',
  'short',
  'long',
  'unsigned int',
  'unsigned long',
  'size_t',
  'float',
  'double',
]);

/** Bound the total storage of nested aggregates, not just each array dimension. */
export function validateObjectType(type, structs = {}, visiting = new Set()) {
  if (isPointer(type) || isPrimitive(type)) return 1;
  if (isBlock(type)) {
    if (!Number.isInteger(type.bytes) || type.bytes < 1) throw new Error('invalid block size');
    return 1;
  }
  let count;
  if (isArray(type)) {
    if (!Number.isInteger(type.length) || type.length < 1 || type.length > MAX_ARRAY_LENGTH)
      throw new Error('invalid array length');
    count = type.length * validateObjectType(type.of, structs, visiting);
  } else if (isStruct(type)) {
    if (visiting.has(type.name))
      throw diagnostic(INVALID, `recursive by-value struct '${type.name}'`);
    const fields = resolveStructType(type, structs).fields;
    if (!fields?.length) throw diagnostic(INVALID, `incomplete or empty struct '${type.name}'`);
    count = fields.reduce(
      (n, f) => n + validateObjectType(f.type, structs, new Set([...visiting, type.name])),
      0,
    );
  } else throw new Error('unsupported object type');
  if (count > MAX_OBJECT_SCALARS)
    throw diagnostic(LIMIT, `object exceeds ${MAX_OBJECT_SCALARS} scalar subobjects`);
  return count;
}

export function typeEquals(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'primitive') return a.name === b.name;
  if (a.kind === 'pointer') return typeEquals(a.to, b.to);
  if (a.kind === 'array') return a.length === b.length && typeEquals(a.of, b.of);
  // C named-struct compatibility is based on the tag, not a deep recursive comparison.
  if (a.kind === 'struct') return a.name === b.name;
  if (a.kind === 'void' || a.kind === 'nullptr_t') return true;
  if (a.kind === 'block') return a.bytes === b.bytes;
  return false;
}

export function isPrimitive(type) {
  return type?.kind === 'primitive';
}
export function isPointer(type) {
  return type?.kind === 'pointer';
}
export function isArray(type) {
  return type?.kind === 'array';
}
export function isStruct(type) {
  return type?.kind === 'struct';
}

/** Resolve a named struct to its full definition from a state/program registry. */
export function resolveStructType(type, structTypes = {}) {
  if (!isStruct(type)) return type;
  return structTypes[type.name] ?? type;
}

/** One layout calculation for sizeof, member offsets, and simulated addresses. */
export function layoutOf(type, structTypes = {}, visiting = new Set()) {
  if (type.kind === 'primitive') {
    switch (type.name) {
      case 'bool':
      case 'char':
        return { size: 1, alignment: 1 };
      case 'short':
        return { size: 2, alignment: 2 };
      case 'int':
      case 'unsigned int':
      case 'float':
        return { size: 4, alignment: 4 };
      case 'long':
      case 'unsigned long':
      case 'double':
        return { size: 8, alignment: 8 };
      default:
        throw new Error(`sizeof(${type.name}) is not defined in PointerViz Mini-C`);
    }
  }
  // nullptr_t has the size and alignment of a pointer to char (C23 7.21.2p2).
  if (type.kind === 'pointer' || type.kind === 'nullptr_t') return { size: 8, alignment: 8 };
  if (type.kind === 'block') return { size: type.bytes, alignment: MALLOC_ALIGNMENT };
  if (type.kind === 'array') {
    const element = layoutOf(type.of, structTypes, visiting);
    return { size: type.length * element.size, alignment: element.alignment };
  }
  if (type.kind === 'struct') {
    const def = resolveStructType(type, structTypes);
    if (!def.fields?.length) throw diagnostic(INVALID, `incomplete or empty struct '${type.name}'`);
    if (visiting.has(type.name))
      throw diagnostic(INVALID, `recursive by-value struct '${type.name}'`);
    let offset = 0,
      alignment = 1;
    const fields = [];
    for (const f of def.fields) {
      const layout = layoutOf(f.type, structTypes, new Set([...visiting, type.name]));
      offset = alignUp(offset, layout.alignment);
      fields.push({ name: f.name, type: f.type, offset, ...layout });
      offset += layout.size;
      alignment = Math.max(alignment, layout.alignment);
    }
    return { size: alignUp(offset, alignment), alignment, fields };
  }
  // Reached for sizeof(void) and other incomplete types (C23 6.5.3.4p1).
  throw diagnostic(INVALID, `sizeof unsupported type ${JSON.stringify(type)}`);
}

const alignUp = (n, alignment) => Math.ceil(n / alignment) * alignment;
export function sizeOf(type, structTypes = {}) {
  return layoutOf(type, structTypes).size;
}

export function typeToString(type) {
  if (!type) return '<unknown>';
  if (type.kind === 'primitive') return type.alias ?? type.name;
  if (type.kind === 'pointer') return `${typeToString(type.to)} *`;
  if (type.kind === 'array') return `${typeToString(type.of)} [${type.length}]`;
  if (type.kind === 'struct') return type.alias ?? `struct ${type.name ?? '<anonymous>'}`;
  if (type.kind === 'void') return 'void';
  if (type.kind === 'nullptr_t') return 'nullptr_t';
  if (type.kind === 'block') return `${type.bytes}-byte block`;
  return '<unknown>';
}

/** Print a supported C declaration, including arrays and named structs. */
export function declarationToC(type, name) {
  if (type.kind === 'primitive') return `${type.alias ?? type.name} ${name}`;
  if (type.kind === 'void') return `void ${name}`;
  if (type.kind === 'pointer') {
    return declarationToC(type.to, type.to.kind === 'array' ? `(*${name})` : `*${name}`);
  }
  if (type.kind === 'array') return declarationToC(type.of, `${name}[${type.length}]`);
  if (type.kind === 'struct') return `${type.alias ?? `struct ${type.name}`} ${name}`;
  throw new Error(`cannot print declaration for ${JSON.stringify(type)}`);
}

export function pointerDepth(type) {
  let n = 0;
  while (type?.kind === 'pointer') {
    n++;
    type = type.to;
  }
  return n;
}

export function basePrimitive(type) {
  while (type?.kind === 'pointer' || type?.kind === 'array')
    type = type.kind === 'pointer' ? type.to : type.of;
  return type?.kind === 'primitive' ? (type.alias ?? type.name) : null;
}

export function isSupportedPrimitiveName(name) {
  return PRIMITIVE_NAMES.includes(name) || name === '_Bool';
}

/** Whether a type mentions a primitive, directly or through pointers, arrays and structs. */
export function containsPrimitive(type, test, structTypes = {}, visiting = new Set()) {
  if (type?.kind === 'primitive') return test(type);
  if (type?.kind === 'pointer') return containsPrimitive(type.to, test, structTypes, visiting);
  if (type?.kind === 'array') return containsPrimitive(type.of, test, structTypes, visiting);
  if (type?.kind === 'struct' && !visiting.has(type.name)) {
    const next = new Set([...visiting, type.name]);
    return (resolveStructType(type, structTypes).fields ?? []).some(f =>
      containsPrimitive(f.type, test, structTypes, next),
    );
  }
  return false;
}

export const C_KEYWORDS = new Set([
  'alignas',
  'alignof',
  'auto',
  'bool',
  'break',
  'case',
  'char',
  'const',
  'constexpr',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'false',
  'float',
  'for',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'nullptr',
  'register',
  'restrict',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'struct',
  'switch',
  'thread_local',
  'true',
  'typedef',
  'typeof',
  'typeof_unqual',
  'union',
  'unsigned',
  'void',
  'volatile',
  'while',
  '_Alignas',
  '_Alignof',
  '_Atomic',
  '_BitInt',
  '_Bool',
  '_Complex',
  '_Decimal128',
  '_Decimal32',
  '_Decimal64',
  '_Generic',
  '_Imaginary',
  '_Noreturn',
  '_Static_assert',
  '_Thread_local',
]);

export function validIdentifier(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z_]\w*$/.test(name) &&
    !C_KEYWORDS.has(name) &&
    name !== 'size_t'
  );
}

/** Names PointerViz implements itself; programs and diagrams may not redefine them. */
export const LIBRARY_NAMES = Object.freeze(new Set(['NULL', 'malloc', 'calloc', 'free', 'printf']));

/** Why `name` cannot name a variable, or null. Struct typedef names are taken too. */
export function variableNameError(name, structTypes = {}) {
  if (!name) return 'a variable needs a name';
  if (!validIdentifier(name)) return `'${name}' is not a valid, non-keyword C identifier`;
  if (LIBRARY_NAMES.has(name)) return `'${name}' is reserved for the standard library`;
  const typedefs = Object.values(structTypes).flatMap(
    def => def.typedefNames ?? (def.alias ? [def.alias] : []),
  );
  if (typedefs.includes(name)) return `'${name}' is already a type name`;
  return null;
}
