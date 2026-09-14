/**
 * PointerViz Mini-C type system.
 *
 * Named structs use a finite description: a struct field may point to a named
 * struct without embedding the whole definition recursively. Program/state
 * registries retain the complete struct definitions.
 */
import { MAX_ARRAY_LENGTH, MAX_OBJECT_SCALARS } from './limits.js';

export const primitive = (name) => ({ kind: 'primitive', name });
export const pointer = (to) => ({ kind: 'pointer', to: structuredClone(to) });
export const array = (of, length) => {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ARRAY_LENGTH) {
    throw new Error(`array length must be between 1 and ${MAX_ARRAY_LENGTH}`);
  }
  return { kind: 'array', of: structuredClone(of), length };
};
export const structRef = (name) => ({ kind: 'struct', name });
export const structType = (name, fields) => ({ kind: 'struct', name, fields: structuredClone(fields) });

export const INT = primitive('int');
export const CHAR = primitive('char');

/** Bound the total storage of nested aggregates, not just each array dimension. */
export function validateObjectType(type, structs = {}, visiting = new Set()) {
  if (isPointer(type) || isPrimitive(type)) return 1;
  let count;
  if (isArray(type)) {
    if (!Number.isInteger(type.length) || type.length < 1 || type.length > MAX_ARRAY_LENGTH) throw new Error('invalid array length');
    count = type.length * validateObjectType(type.of, structs, visiting);
  } else if (isStruct(type)) {
    if (visiting.has(type.name)) throw new Error(`recursive by-value struct '${type.name}'`);
    const fields = resolveStructType(type, structs).fields;
    if (!fields?.length) throw new Error(`incomplete or empty struct '${type.name}'`);
    count = fields.reduce((n, f) => n + validateObjectType(f.type, structs, new Set([...visiting, type.name])), 0);
  } else throw new Error('unsupported object type');
  if (count > MAX_OBJECT_SCALARS) throw new Error(`object exceeds ${MAX_OBJECT_SCALARS} scalar subobjects`);
  return count;
}

export function cloneType(type) { return structuredClone(type); }

export function typeEquals(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'primitive') return a.name === b.name;
  if (a.kind === 'pointer') return typeEquals(a.to, b.to);
  if (a.kind === 'array') return a.length === b.length && typeEquals(a.of, b.of);
  // C named-struct compatibility is based on the tag, not a deep recursive comparison.
  if (a.kind === 'struct') return a.name === b.name;
  return false;
}

export function isPrimitive(type) { return type?.kind === 'primitive'; }
export function isPointer(type) { return type?.kind === 'pointer'; }
export function isArray(type) { return type?.kind === 'array'; }
export function isStruct(type) { return type?.kind === 'struct'; }
export function isScalar(type) { return isPrimitive(type) || isPointer(type); }

export function pointeeType(type) {
  if (!isPointer(type)) throw new Error(`expected pointer type, got ${typeToString(type)}`);
  return type.to;
}

/** Resolve a named struct to its full definition from a state/program registry. */
export function resolveStructType(type, structTypes = {}) {
  if (!isStruct(type)) return type;
  return structTypes[type.name] ?? type;
}

export function sizeOf(type, structTypes = {}) {
  if (type.kind === 'primitive') {
    switch (type.name) {
      case 'char': return 1;
      case 'short': return 2;
      case 'int': return 4;
      case 'unsigned int': return 4;
      case 'long': return 8;
      case 'unsigned long': return 8;
      case 'float': return 4;
      case 'double': return 8;
      default: throw new Error(`sizeof(${type.name}) is not defined in PointerViz Mini-C`);
    }
  }
  if (type.kind === 'pointer') return 8;
  if (type.kind === 'array') return type.length * sizeOf(type.of, structTypes);
  if (type.kind === 'struct') {
    const def = resolveStructType(type, structTypes);
    if (!def.fields) throw new Error(`unknown struct '${type.name}'`);
    let offset = 0;
    for (const f of def.fields) {
      offset = alignUp(offset, alignmentOf(f.type, structTypes));
      offset += sizeOf(f.type, structTypes);
    }
    return alignUp(offset, alignmentOf(type, structTypes));
  }
  throw new Error(`sizeof unsupported type ${JSON.stringify(type)}`);
}

const alignUp = (n, alignment) => Math.ceil(n / alignment) * alignment;
export function alignmentOf(type, structTypes = {}) {
  if (isArray(type)) return alignmentOf(type.of, structTypes);
  if (isStruct(type)) {
    const def = resolveStructType(type, structTypes);
    if (!def.fields?.length) throw new Error(`incomplete or empty struct '${type.name}'`);
    return Math.max(...def.fields.map(f => alignmentOf(f.type, structTypes)));
  }
  return sizeOf(type, structTypes);
}

export function typeToString(type) {
  if (!type) return '<unknown>';
  if (type.kind === 'primitive') return type.name;
  if (type.kind === 'pointer') return `${typeToString(type.to)} *`;
  if (type.kind === 'array') return `${typeToString(type.of)} [${type.length}]`;
  if (type.kind === 'struct') return type.alias ?? `struct ${type.name ?? '<anonymous>'}`;
  if (type.kind === 'void') return 'void';
  return '<unknown>';
}

/** Print a supported C declaration, including arrays and named structs. */
export function declarationToC(type, name) {
  if (type.kind === 'primitive') return `${type.name} ${name}`;
  if (type.kind === 'void') return `void ${name}`;
  if (type.kind === 'pointer') {
    return declarationToC(type.to, type.to.kind === 'array' ? `(*${name})` : `*${name}`);
  }
  if (type.kind === 'array') return declarationToC(type.of, `${name}[${type.length}]`);
  if (type.kind === 'struct') return `${type.alias ?? `struct ${type.name}`} ${name}`;
  throw new Error(`cannot print declaration for ${JSON.stringify(type)}`);
}

function typeBase(type) {
  if (type.kind === 'primitive') return type.name;
  if (type.kind === 'struct') return type.alias ?? `struct ${type.name}`;
  return typeToString(type);
}

export function pointerDepth(type) {
  let n = 0;
  while (type?.kind === 'pointer') { n++; type = type.to; }
  return n;
}

export function basePrimitive(type) {
  while (type?.kind === 'pointer' || type?.kind === 'array') type = type.kind === 'pointer' ? type.to : type.of;
  return type?.kind === 'primitive' ? type.name : null;
}

export function isSupportedPrimitiveName(name) {
  return ['int', 'char', 'short', 'long', 'unsigned int', 'unsigned long', 'float', 'double'].includes(name);
}

export const C_KEYWORDS = new Set([
  'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'char', 'const', 'constexpr',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'false', 'float',
  'for', 'goto', 'if', 'inline', 'int', 'long', 'nullptr', 'register', 'restrict',
  'return', 'short', 'signed', 'sizeof', 'static', 'static_assert', 'struct', 'switch',
  'thread_local', 'true', 'typedef', 'typeof', 'typeof_unqual', 'union', 'unsigned',
  'void', 'volatile', 'while', '_Alignas', '_Alignof', '_Atomic', '_BitInt', '_Bool',
  '_Complex', '_Decimal128', '_Decimal32', '_Decimal64', '_Generic', '_Imaginary',
  '_Noreturn', '_Static_assert', '_Thread_local',
]);

export function validIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name) && !C_KEYWORDS.has(name);
}
