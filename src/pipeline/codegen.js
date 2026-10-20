/** MemoryState -> one canonical PointerViz Mini-C program. */
import { encodeStringLiteral } from '../language/literals.js';
import {
  CHAR,
  VOID,
  containsPrimitive,
  declarationToC,
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
  validateObjectType,
  variableNameError,
} from '../language/types.js';
import {
  allocationDisplayName,
  getAllocation,
  heapAllocations,
  pointerEdges,
  resolveRef,
  scalarSubobjects,
  stackAllocations,
} from '../machine/memory.js';
import { convertNumber } from '../language/numeric.js';
import { upgradeMemoryState, validateAddressSpace } from '../machine/addresses.js';

export class ValidationError extends Error {
  constructor(errors) {
    super('invalid memory diagram:\n  - ' + errors.join('\n  - '));
    this.errors = errors;
  }
}

export function validate(state) {
  const errors = [];
  if (!state || !Array.isArray(state.allocations))
    throw new ValidationError(['state is missing allocations[]']);
  const ids = new Set(),
    namesByFrame = new Map();
  for (const a of state.allocations) {
    if (!a.id || ids.has(a.id)) errors.push(`duplicate or missing allocation id '${a.id ?? ''}'`);
    ids.add(a.id);
    if (a.storage?.kind === 'stack') {
      const frameId = a.storage.frameId ?? 'main';
      const names = namesByFrame.get(frameId) ?? new Set();
      const nameError = variableNameError(a.name, state.structTypes);
      if (nameError) errors.push(`stack object name: ${nameError}`);
      // Only live names must be unique: block and loop scopes reuse a name, and the
      // expired objects they leave behind stay in the state (C 6.2.1).
      else if (a.alive && names.has(a.name))
        errors.push(`duplicate variable name '${a.name}' in one stack frame`);
      if (a.alive) names.add(a.name);
      namesByFrame.set(frameId, names);
    } else if (a.storage?.kind === 'heap') {
      if (a.name) errors.push(`heap allocations must not have source-level variable names`);
    } else if (a.storage?.kind === 'static') {
      const literal = literalCodes(a);
      if (!literal || encodeStringLiteral(literal) !== a.name)
        errors.push(`string literal ${a.name} does not hold its characters and a final '\\0'`);
    } else errors.push(`allocation ${a.id} has invalid storage kind`);
    try {
      validateObjectType(a.type, state.structTypes ?? {});
      validateValueShape(
        a.type,
        a.value,
        allocationDisplayName(state, a),
        errors,
        state.structTypes ?? {},
      );
    } catch (e) {
      errors.push(e.message);
    }
  }
  try {
    if (state.addressSpace != null) validateAddressSpace(state);
    else upgradeMemoryState(state);
  } catch (e) {
    errors.push(e.message);
  }
  if (errors.length) throw new ValidationError(errors);
  // Resolve inside the diagnostic boundary; malformed targets must not crash grading.
  const edges = state.allocations.flatMap(a =>
    scalarSubobjects(a, state)
      .filter(s => s.value.kind === 'pointer')
      .map(s => ({ source: s.ref, target: s.value.target })),
  );
  for (const edge of edges) {
    try {
      const src = resolveRef(state, edge.source),
        tgt = resolveRef(state, edge.target);
      if (tgt.invalid) errors.push(`${src.label} points outside object bounds`);
      if (!isPointer(src.type))
        errors.push(`${src.label} contains a pointer edge but has type ${typeToString(src.type)}`);
      // A void * may point at any object, and any pointer at an untyped malloc block.
      else if (!typeEquals(src.type.to, tgt.type) && !isVoidPointer(src.type) && !isBlock(tgt.type))
        errors.push(
          `type error: ${typeToString(src.type)} ${src.label} cannot point to ${typeToString(tgt.type)} ${tgt.label}`,
        );
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return state;
}

function validateValueShape(type, value, label, errors, structs) {
  if (!value) {
    errors.push(`${label} has no value representation`);
    return;
  }
  if (isPrimitive(type)) {
    if (!['scalar', 'uninit'].includes(value.kind))
      errors.push(`${label} is ${typeToString(type)} but stores ${value.kind}`);
    if (value.kind === 'scalar') {
      try {
        if (
          !['number', 'bigint'].includes(typeof value.value) ||
          convertNumber(value.value, type) !== value.value
        )
          errors.push(`${label} stores a value not representable as ${typeToString(type)}`);
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    }
    return;
  }
  if (isPointer(type)) {
    if (!['pointer', 'null', 'uninit'].includes(value.kind))
      errors.push(`${label} is ${typeToString(type)} but stores ${value.kind}`);
    return;
  }
  // An untyped malloc block holds no values until it is given a type.
  if (isBlock(type)) {
    if (value.kind !== 'uninit') errors.push(`${label} is an untyped block but stores a value`);
    return;
  }
  if (isArray(type)) {
    if (
      value.kind !== 'aggregate' ||
      !Array.isArray(value.elements) ||
      value.elements.length !== type.length
    ) {
      errors.push(`${label} has malformed array storage`);
      return;
    }
    value.elements.forEach((v, i) =>
      validateValueShape(type.of, v, `${label}[${i}]`, errors, structs),
    );
    return;
  }
  if (isStruct(type)) {
    const def = resolveStructType(type, structs);
    if (!def.fields) {
      errors.push(`${label} uses unknown struct ${type.name}`);
      return;
    }
    if (value.kind !== 'aggregate' || !value.fields) {
      errors.push(`${label} has malformed struct storage`);
      return;
    }
    for (const f of def.fields)
      validateValueShape(f.type, value.fields[f.name], `${label}.${f.name}`, errors, structs);
    return;
  }
  errors.push(`${label} uses unsupported type ${typeToString(type)}`);
}

export function generate(state) {
  validate(state);
  const nonMain = stackAllocations(state).filter(a => (a.storage.frameId ?? 'main') !== 'main');
  if (nonMain.length)
    throw new ValidationError([
      'diagram-to-code generation currently requires a single main() stack frame; function-call snapshots can still be viewed and graded',
    ]);
  const deadStack = stackAllocations(state).filter(a => !a.alive);
  if (deadStack.length)
    throw new ValidationError(['cannot generate final C from expired stack objects']);

  const ctx = {
    state,
    lines: [],
    heapAnchor: new Map(),
    // Heap block whose storage holds each anchor expression (null for a stack variable).
    anchorOwner: new Map(),
    heapInitialized: new Set(),
    initializing: new Set(),
    // Interior pointers into heap blocks that no base pointer has allocated yet.
    deferred: [],
  };
  const stack = stackAllocations(state);
  for (const a of stack) ctx.lines.push(`${declarationToC(a.type, a.name)};`);
  if (stack.length) ctx.lines.push('');
  for (const a of stack) emitNonPointerStorage(a, ctx);
  for (const a of stack) emitPointerStorage(a, ctx);
  emitDeferredPointers(ctx);

  for (const heap of heapAllocations(state)) {
    if (ctx.heapAnchor.has(heap.id)) continue;
    const incoming = pointerEdges(state).some(e => e.target.allocationId === heap.id);
    if (!incoming) {
      const label = allocationDisplayName(state, heap);
      if (!heap.alive)
        throw new ValidationError([
          `${label} is freed but has no surviving pointer; its provenance cannot be reproduced`,
        ]);
      if (hasMeaningfulValue(heap.type, heap.value, state))
        throw new ValidationError([
          `initialized heap allocation (${label}) is unreachable; add a pointer to it or clear its contents`,
        ]);
      throw new ValidationError([
        `unreachable heap allocation (${label}) cannot be generated without an extra source pointer`,
      ]);
    }
  }
  // An anchor such as head->next reads its owner block, so free the deepest blocks first.
  const anchorDepth = id => {
    let depth = 0;
    for (let owner = ctx.anchorOwner.get(id); owner; owner = ctx.anchorOwner.get(owner)) depth++;
    return depth;
  };
  heapAllocations(state)
    .filter(heap => !heap.alive && ctx.heapAnchor.has(heap.id))
    .sort((a, b) => anchorDepth(b.id) - anchorDepth(a.id))
    .forEach(heap => ctx.lines.push(`free(${ctx.heapAnchor.get(heap.id)});`));

  const definitions = emitStructDefinitions(state);
  const cleaned = trimBlankLines(ctx.lines);
  const needsStdlib =
    heapAllocations(state).length > 0 || scalarValues(state).some(v => v.kind === 'null');
  const uses = test =>
    state.allocations.some(a => containsPrimitive(a.type, test, state.structTypes)) ||
    Object.values(state.structTypes ?? {}).some(def =>
      containsPrimitive(def, test, state.structTypes),
    );
  const includes = [
    uses(t => t.name === 'bool') && 'stdbool.h',
    !needsStdlib && uses(t => t.alias === 'size_t') && 'stddef.h',
    needsStdlib && 'stdlib.h',
  ].filter(Boolean);
  const header = includes.length
    ? `${includes.map(name => `#include <${name}>`).join('\n')}\n\n`
    : '';
  const structs = definitions ? `${definitions}\n\n` : '';
  const body = cleaned.map(line => (line ? `    ${line}` : '')).join('\n');
  return `${header}${structs}int main(void) {\n${body}${body ? '\n' : ''}    return 0;\n}\n`;
}

function emitStructDefinitions(state) {
  const defs = Object.values(state.structTypes ?? {});
  const aliases = defs
    .flatMap(def =>
      (def.typedefNames ?? (def.alias ? [def.alias] : [])).map(
        alias => `typedef struct ${def.name} ${alias};`,
      ),
    )
    .join('\n');
  const bodies = defs
    .map(def => {
      const fields = def.fields.map(f => `    ${declarationToC(f.type, f.name)};`).join('\n');
      return `struct ${def.name} {\n${fields}\n};`;
    })
    .join('\n\n');
  return [aliases, bodies].filter(Boolean).join('\n\n');
}

function emitNonPointerStorage(a, ctx) {
  for (const s of scalarSubobjects(a, ctx.state)) {
    if (isPointer(s.type) || s.value.kind !== 'scalar') continue;
    ctx.lines.push(
      `${lvalueForStackSubobject(a, s.ref.path)} = ${numberToC(s.value.value, s.type)};`,
    );
  }
}
function emitPointerStorage(a, ctx) {
  for (const s of scalarSubobjects(a, ctx.state)) {
    if (isPointer(s.type))
      emitPointerAssignment(lvalueForStackSubobject(a, s.ref.path), s.type, s.value, ctx);
  }
}

/**
 * Only a pointer of the block's base type can receive malloc's result, so an interior
 * pointer (int *q = &s->y) waits until a base pointer anywhere in the diagram has
 * allocated its block, whatever order the variables were declared in.
 */
function emitDeferredPointers(ctx) {
  while (ctx.deferred.length) {
    const pending = ctx.deferred;
    ctx.deferred = [];
    const emitted = pending.map(p => emitPointerAssignment(p.lhs, p.type, p.value, ctx, p.owner));
    if (!emitted.some(Boolean)) {
      const { lhs, type, value } = pending[0];
      const heap = getAllocation(ctx.state, value.target.allocationId);
      throw new ValidationError([
        `${lhs} has type ${typeToString(type)} but ${allocationDisplayName(ctx.state, heap)} needs a ${typeToString(heapBasePointerType(heap))} pointer to allocate it`,
      ]);
    }
  }
}

/** Returns false when the assignment was deferred (see emitDeferredPointers). */
function emitPointerAssignment(lhs, pointerType, value, ctx, owner = null) {
  if (value.kind === 'uninit') return true;
  if (value.kind === 'null') {
    ctx.lines.push(`${lhs} = NULL;`);
    return true;
  }
  const target = getAllocation(ctx.state, value.target.allocationId);
  if (target.storage.kind === 'static') {
    // A literal decays to &literal[0]; any other element is an offset from it.
    const [index] = value.target.path;
    ctx.lines.push(`${lhs} = ${target.name}${index ? ` + ${index}` : ''};`);
    return true;
  }
  if (target.storage.kind === 'stack') {
    const path = value.target.path,
      singletonPast = path.at(-1) === '$onePast';
    ctx.lines.push(
      `${lhs} = &${lvalueForStackSubobject(target, singletonPast ? path.slice(0, -1) : path)}${singletonPast ? ' + 1' : ''};`,
    );
    return true;
  }
  if (!ctx.heapAnchor.has(target.id) && !canAllocateThrough(target, pointerType)) {
    ctx.deferred.push({ lhs, type: pointerType, value, owner });
    return false;
  }
  ensureHeapAllocated(target, lhs, value.target.path, ctx, owner);
  const rhs = pointerExprForHeapTarget(
    target,
    value.target.path,
    ctx.heapAnchor.get(target.id),
    ctx.state,
  );
  if (rhs !== lhs) ctx.lines.push(`${lhs} = ${rhs};`);
  initializeHeap(target, ctx);
  return true;
}

/** Allocate through `lhs`, which emitPointerAssignment has checked has the base pointer type. */
function ensureHeapAllocated(heap, lhs, targetPath, ctx, owner) {
  if (ctx.heapAnchor.has(heap.id)) return;
  ctx.anchorOwner.set(heap.id, owner);
  ctx.lines.push(`${lhs} = ${mallocExpr(heap, ctx.state)};`);
  if (targetPath.length === 1 && targetPath[0] === '$onePast') {
    ctx.lines.push(`${lhs} = ${lhs} + 1;`);
    ctx.heapAnchor.set(heap.id, `(${lhs} - 1)`);
  } else if (heap.type.kind === 'array' && targetPath.length === 1 && targetPath[0] !== 0) {
    ctx.lines.push(`${lhs} = ${lhs} + ${targetPath[0]};`);
    ctx.heapAnchor.set(heap.id, `(${lhs} - ${targetPath[0]})`);
  } else ctx.heapAnchor.set(heap.id, lhs);
}

function initializeHeap(heap, ctx) {
  if (ctx.heapInitialized.has(heap.id) || ctx.initializing.has(heap.id)) return;
  ctx.initializing.add(heap.id);
  const anchor = ctx.heapAnchor.get(heap.id);
  for (const s of scalarSubobjects(heap, ctx.state)) {
    const lhs = lvalueForHeapSubobject(heap, s.ref.path, anchor, ctx.state);
    if (isPrimitive(s.type) && s.value.kind === 'scalar')
      ctx.lines.push(`${lhs} = ${numberToC(s.value.value, s.type)};`);
    else if (isPointer(s.type)) emitPointerAssignment(lhs, s.type, s.value, ctx, heap.id);
  }
  ctx.initializing.delete(heap.id);
  ctx.heapInitialized.add(heap.id);
}

function lvalueForStackSubobject(a, path) {
  let out = a.name;
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : `.${part}`;
  return out;
}
function lvalueForHeapSubobject(heap, path, anchor, state) {
  let out = anchor,
    type = heap.type;
  if (!path.length) return `*${parenIfNeeded(anchor)}`;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type)) {
      out = `${parenIfNeeded(out)}[${part}]`;
      type = type.of;
    } else if (isStruct(type)) {
      const def = resolveStructType(type, state?.structTypes ?? {});
      out =
        i === 0 && heap.type.kind === 'struct'
          ? `${parenIfNeeded(out)}->${part}`
          : `${out}.${part}`;
      type = def.fields?.find(f => f.name === part)?.type ?? type;
    }
  }
  return out;
}
function pointerExprForHeapTarget(heap, path, anchor, state) {
  if (!path.length) return anchor;
  if (path.at(-1) === '$onePast')
    return path.length === 1
      ? `${parenIfNeeded(anchor)} + 1`
      : `&${lvalueForHeapSubobject(heap, path.slice(0, -1), anchor, state)} + 1`;
  if (isArray(heap.type) && path.length === 1 && typeof path[0] === 'number')
    return path[0] === 0 ? anchor : `${parenIfNeeded(anchor)} + ${path[0]}`;
  return `&${lvalueForHeapSubobject(heap, path, anchor, state)}`;
}
function numberToC(value, type) {
  if (type.name === 'bool') return value ? 'true' : 'false';
  // 9223372036854775808 has no type (C23 6.4.4.1), so LONG_MIN needs an expression.
  if (type.name === 'long' && BigInt(value) === -(1n << 63n)) return '(-9223372036854775807L - 1)';
  let text = String(value);
  if (type.name === 'float' || type.name === 'double') {
    // String(-0) is '0', but a negative zero is observable (printf prints -0.000000).
    if (Object.is(value, -0)) text = '-0';
    if (!/[.eE]/.test(text)) text += '.0';
    return text + (type.name === 'float' ? 'f' : '');
  }
  return (
    text +
    (type.name === 'unsigned long'
      ? 'UL'
      : type.name === 'unsigned int'
        ? 'U'
        : type.name === 'long'
          ? 'L'
          : '')
  );
}
function heapBasePointerType(heap) {
  if (isBlock(heap.type)) return pointer(VOID);
  return pointer(isArray(heap.type) ? heap.type.of : heap.type);
}
/** Any pointer can receive an untyped block; a typed block needs its element type. */
function canAllocateThrough(heap, pointerType) {
  return isBlock(heap.type) || typeEquals(pointerType, heapBasePointerType(heap));
}
function mallocExpr(heap, state) {
  // Untyped blocks, and typed blocks with trailing bytes, keep their exact request. An untyped
  // calloc block stays zero-filled; a typed one's values are assigned like any other block's.
  if (isBlock(heap.type))
    return heap.zeroFilled ? `calloc(${heap.type.bytes}, 1)` : `malloc(${heap.type.bytes})`;
  if (heap.requestedBytes && heap.requestedBytes !== sizeOf(heap.type, state.structTypes))
    return `malloc(${heap.requestedBytes})`;
  return isArray(heap.type)
    ? `malloc(${heap.type.length} * sizeof(${typeToString(heap.type.of)}))`
    : `malloc(sizeof(${typeToString(heap.type)}))`;
}
function parenIfNeeded(expr) {
  return /^[A-Za-z_]\w*$/.test(expr) ? expr : `(${expr})`;
}
/** A static char array's characters before its one, final '\0', or null if it is not one. */
function literalCodes(a) {
  if (!isArray(a.type) || !typeEquals(a.type.of, CHAR) || a.value?.kind !== 'aggregate')
    return null;
  const codes = a.value.elements.map(e => (e?.kind === 'scalar' ? e.value : null));
  if (codes.at(-1) !== 0 || codes.includes(null)) return null;
  return codes.slice(0, -1);
}
function hasMeaningfulValue(type, value, state) {
  if (isPrimitive(type) || isPointer(type)) return value.kind !== 'uninit';
  if (isArray(type)) return value.elements.some(v => hasMeaningfulValue(type.of, v, state));
  if (isStruct(type)) {
    const def = resolveStructType(type, state.structTypes);
    return def.fields.some(f => hasMeaningfulValue(f.type, value.fields[f.name], state));
  }
  return false;
}
function scalarValues(state) {
  return state.allocations.flatMap(a => scalarSubobjects(a, state).map(s => s.value));
}
function trimBlankLines(lines) {
  const out = [...lines];
  while (out[0] === '') out.shift();
  while (out.at(-1) === '') out.pop();
  return out.filter((line, i) => line !== '' || out[i - 1] !== '');
}
