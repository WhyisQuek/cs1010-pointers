/** MemoryState -> one canonical PointerViz Mini-C program. */
import { encodeCharLiteral, encodeStringLiteral } from '../language/literals.js';
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
  gradedIds,
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

/**
 * Generation reproduces what grading compares (gradedIds), so a returned call's locals and
 * out-of-scope loop or block variables that nothing points to are left out.
 */
export function observableState(state) {
  const keep = gradedIds(state);
  const allocations = state.allocations.filter(a => keep.has(a.id));
  // A returned call stays only while something still points into it.
  const frames = (state.frames ?? []).filter(
    f => f.active || allocations.some(a => a.storage.frameId === f.id),
  );
  return { ...state, allocations, frames };
}

/** Why the stack objects left after observableState() cannot all be written into main(). */
function stackIssue(state, stack) {
  const call = a =>
    `${state.frames?.find(f => f.id === a.storage.frameId)?.name ?? 'a function'}()`;
  const outside = stack.filter(a => (a.storage.frameId ?? 'main') !== 'main');
  const running = outside.find(a => a.alive);
  if (running)
    return `${call(running)} has not returned, and C can only be generated once main() is the only call running. Step until ${call(running)} returns`;
  const pointerTo = a =>
    resolveRef(state, pointerEdges(state).find(e => e.target.allocationId === a.id).source).label;
  if (outside.length)
    return `${pointerTo(outside[0])} still points to '${outside[0].name}' in the returned call ${call(outside[0])}. Point it somewhere else, or show out-of-scope memory and remove that call`;
  // Out-of-scope variables of main() are declared in an inner block, which a shared name breaks.
  const names = new Set(stack.filter(a => a.alive).map(a => a.name));
  for (const a of stack.filter(a => !a.alive)) {
    if (names.has(a.name))
      return `${pointerTo(a)} still points to an out-of-scope '${a.name}', and main() has another variable of that name. Point it somewhere else`;
    names.add(a.name);
  }
  return null;
}

export function generate(source) {
  validate(source);
  const state = observableState(source);
  const stack = stackAllocations(state);
  const issue = stackIssue(state, stack);
  if (issue) throw new ValidationError([issue]);
  // What is left out of scope is the target of a dangling pointer, so it is rebuilt in an
  // inner block that ends before main() does.
  const live = stack.filter(a => a.alive),
    ended = stack.filter(a => !a.alive);

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
    // Names of the block-scope pointers that allocate what no pointer in the diagram can.
    temporaries: [],
    // Stack variables declared so far; a pointer to a later one waits (see deferred).
    declared: new Set(),
    // Index in `lines` where main()'s inner block starts, once something needs it.
    blockStart: null,
    // Let a pointer to the start of a block allocate it, rather than one into its middle.
    preferStart: true,
  };
  for (const a of live) declare(a, ctx);
  if (ended.length) openBlock(ctx);
  for (const a of ended) declare(a, ctx);
  emitDeferredPointers(ctx);

  // Blocks nothing reaches (leaks, and freed blocks every pointer has left). Those with no
  // pointer to them at all go first, so that each one also allocates what it points to.
  const targeted = new Set(pointerEdges(state).map(e => e.target.allocationId));
  const unreached = heapAllocations(state).filter(heap => !ctx.heapAnchor.has(heap.id));
  for (const heap of [
    ...unreached.filter(h => !targeted.has(h.id)),
    ...unreached.filter(h => targeted.has(h.id)),
  ]) {
    if (ctx.heapAnchor.has(heap.id)) continue;
    allocateThroughTemporary(heap, ctx);
    emitDeferredPointers(ctx);
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
  // Temporaries and out-of-scope variables must be gone when main() ends, so the lines from
  // the first of them onward form one inner block.
  const start = ctx.blockStart ?? ctx.lines.length;
  const cleaned = ctx.lines.slice(0, start);
  if (ctx.blockStart !== null)
    cleaned.push(...(start ? [''] : []), '{', ...ctx.lines.slice(start).map(l => `    ${l}`), '}');
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

function openBlock(ctx) {
  ctx.blockStart ??= ctx.lines.length;
}

/**
 * Declare one stack variable, with its value where C can write that as an initializer
 * (`int n = 3;`, `char s[6] = "Hello";`, `int *p = malloc(sizeof(int));`). Otherwise the
 * declaration is followed by one assignment for each part that has a value.
 */
function declare(a, ctx) {
  const declaration = declarationToC(a.type, a.name);
  const initializer = initializerFor(a.type, a.value, ctx);
  ctx.declared.add(a.id);
  if (initializer !== null) ctx.lines.push(`${declaration} = ${initializer};`);
  else if (isPointer(a.type))
    emitPointerAssignment(a.name, a.type, a.value, ctx, null, declaration);
  else {
    ctx.lines.push(`${declaration};`);
    for (const s of scalarSubobjects(a, ctx.state)) {
      const lhs = lvalueForStackSubobject(a, s.ref.path);
      if (isPointer(s.type)) emitPointerAssignment(lhs, s.type, s.value, ctx);
      else if (s.value.kind === 'scalar')
        ctx.lines.push(`${lhs} = ${numberToC(s.value.value, s.type)};`);
    }
  }
}

/**
 * The initializer that gives an object of `type` exactly `value`, or null when there is
 * none: a part is uninitialized (an initializer would zero it), or a pointer's target is
 * not there to name yet.
 */
export function initializerFor(type, value, ctx) {
  if (isPrimitive(type)) return value.kind === 'scalar' ? numberToC(value.value, type) : null;
  if (isPointer(type)) return pointerExpr(value, ctx);
  const text = stringInitializer(type, value);
  if (text !== null) return text;
  const parts = isArray(type)
    ? value.elements.map(v => initializerFor(type.of, v, ctx))
    : resolveStructType(type, ctx.state.structTypes).fields.map(f =>
        initializerFor(f.type, value.fields[f.name], ctx),
      );
  if (parts.includes(null)) return null;
  return isZero(type, value, ctx.state) ? '{0}' : `{${parts.join(', ')}}`;
}

/** "Hello" for a char array holding a string and nothing but '\0' after it; otherwise null. */
function stringInitializer(type, value) {
  if (!isArray(type) || !typeEquals(type.of, CHAR)) return null;
  const codes = value.elements.map(e => (e.kind === 'scalar' ? e.value : null));
  const end = codes.indexOf(0);
  if (end < 0 || codes.slice(end).some(c => c !== 0)) return null;
  const text = codes.slice(0, end);
  return text.every(readableChar) ? encodeStringLiteral(text) : null;
}
/** Printable ASCII, or a character with a short escape such as '\n'. */
const readableChar = code => (code >= 32 && code < 127) || (code >= 7 && code <= 13);

/** Whether every part of `value` is what `{0}` and calloc give: 0, 0.0, false or NULL. */
function isZero(type, value, state) {
  if (isPrimitive(type))
    return value.kind === 'scalar' && Number(value.value) === 0 && !Object.is(value.value, -0);
  if (isPointer(type)) return value.kind === 'null';
  if (isArray(type)) return value.elements.every(v => isZero(type.of, v, state));
  if (!isStruct(type)) return false;
  return resolveStructType(type, state.structTypes).fields.every(f =>
    isZero(f.type, value.fields[f.name], state),
  );
}

/** The expression for a pointer value whose target can be named now; otherwise null. */
export function pointerExpr(value, ctx) {
  if (value.kind === 'null') return 'NULL';
  if (value.kind !== 'pointer') return null;
  const target = getAllocation(ctx.state, value.target.allocationId),
    path = value.target.path;
  if (target.storage.kind === 'static')
    // A literal decays to &literal[0]; any other element is an offset from it.
    return `${target.name}${path[0] ? ` + ${path[0]}` : ''}`;
  if (target.storage.kind === 'stack') {
    if (!ctx.declared.has(target.id)) return null;
    if (path.at(-1) === '$onePast')
      return `&${lvalueForStackSubobject(target, path.slice(0, -1))} + 1`;
    // An array decays to a pointer to its first element, so &a[0] is written a.
    if (path.at(-1) === 0) return lvalueForStackSubobject(target, path.slice(0, -1));
    return `&${lvalueForStackSubobject(target, path)}`;
  }
  return ctx.heapAnchor.has(target.id)
    ? pointerExprForHeapTarget(target, path, ctx.heapAnchor.get(target.id), ctx.state)
    : null;
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
    if (emitted.some(Boolean)) continue;
    // A pointer waiting for a better one to allocate its block (preferStart) may be what
    // that better one is waiting for; let it allocate after all.
    if (ctx.preferStart) {
      ctx.preferStart = false;
      continue;
    }
    // No pointer in the diagram can allocate this block, so a temporary one does.
    const { lhs, type, value } = pending[0];
    const heap = getAllocation(ctx.state, value.target.allocationId);
    // A pointer to a whole array cannot be assigned from the temporary's element pointer.
    if (isArray(type.to))
      throw new ValidationError([
        `${lhs} has type ${typeToString(type)} but ${allocationDisplayName(ctx.state, heap)} needs a ${typeToString(heapBasePointerType(heap))} pointer to allocate it`,
      ]);
    allocateThroughTemporary(heap, ctx);
  }
}

/**
 * Allocate `heap` through a pointer declared in main()'s inner block (see generate). The
 * pointer is out of scope when main() ends, so it is not part of the memory reproduced.
 */
function allocateThroughTemporary(heap, ctx) {
  const taken = new Set([...stackAllocations(ctx.state).map(a => a.name), ...ctx.temporaries]);
  let name = 'tmp';
  for (let n = 2; taken.has(name) || variableNameError(name, ctx.state.structTypes); n++)
    name = `tmp${n}`;
  ctx.temporaries.push(name);
  openBlock(ctx);
  allocate(heap, name, declarationToC(heapBasePointerType(heap), name), null, ctx);
  initializeHeap(heap, ctx);
}

/**
 * Write `lhs = malloc(...)` (through `head`, which may be lhs's declaration), and make lhs
 * the expression that later statements reach `heap` through.
 */
function allocate(heap, lhs, head, owner, ctx) {
  const { text, zeroed } = allocationExpr(heap, ctx.state);
  ctx.lines.push(`${head} = ${text};`);
  if (zeroed) ctx.heapInitialized.add(heap.id);
  ctx.anchorOwner.set(heap.id, owner);
  ctx.heapAnchor.set(heap.id, lhs);
}

/**
 * The call that allocates `heap`, and whether it also gives the block its values: calloc
 * says in one call what an assignment per element would, that every one is zero.
 */
export function allocationExpr(heap, state) {
  const zeroed =
    isArray(heap.type) &&
    (heap.requestedBytes ?? sizeOf(heap.type, state.structTypes)) ===
      sizeOf(heap.type, state.structTypes) &&
    isZero(heap.type, heap.value, state);
  return {
    text: zeroed
      ? `calloc(${heap.type.length}, sizeof(${typeToString(heap.type.of)}))`
      : mallocExpr(heap, state),
    zeroed,
  };
}

/**
 * Assign one pointer, through `declaration` when lhs is a variable being declared. Returns
 * false when the assignment had to be deferred (see emitDeferredPointers).
 */
function emitPointerAssignment(lhs, pointerType, value, ctx, owner = null, declaration = null) {
  const head = declaration ?? lhs;
  if (value.kind === 'uninit') {
    if (declaration) ctx.lines.push(`${declaration};`);
    return true;
  }
  const target =
    value.kind === 'pointer' ? getAllocation(ctx.state, value.target.allocationId) : null;
  const ready = pointerExpr(value, ctx);
  if (ready !== null) {
    ctx.lines.push(`${head} = ${ready};`);
    if (target?.storage.kind === 'heap') initializeHeap(target, ctx);
    return true;
  }
  // How far into the block this pointer points: it allocates at the start, then moves.
  const [first] = value.target.path;
  const offset = first === '$onePast' ? 1 : isArray(target.type) ? first : 0;
  if (
    target.storage.kind !== 'heap' ||
    !canAllocateThrough(target, pointerType) ||
    (offset && ctx.preferStart && hasStartPointer(target, ctx))
  ) {
    if (declaration) ctx.lines.push(`${declaration};`);
    ctx.deferred.push({ lhs, type: pointerType, value, owner });
    return false;
  }
  allocate(target, lhs, head, owner, ctx);
  // Values go in through the pointer before it moves (y[0] = 5; y = y + 1;). A block that
  // holds pointers is filled afterwards: blocks allocated through them are reached through
  // this pointer too, so it must already be where it will stay.
  const fillFirst = !scalarSubobjects(target, ctx.state).some(s => isPointer(s.type));
  if (offset && fillFirst) initializeHeap(target, ctx);
  if (offset) {
    ctx.lines.push(`${lhs} = ${lhs} + ${offset};`);
    ctx.heapAnchor.set(target.id, `${lhs} - ${offset}`);
  }
  initializeHeap(target, ctx);
  return true;
}

/** Whether a pointer outside `heap` points at its start and could allocate it. */
function hasStartPointer(heap, ctx) {
  return pointerEdges(ctx.state).some(
    e =>
      e.target.allocationId === heap.id &&
      e.source.allocationId !== heap.id &&
      (e.target.path.length === 0 || (e.target.path.length === 1 && e.target.path[0] === 0)) &&
      canAllocateThrough(heap, resolveRef(ctx.state, e.source).type),
  );
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

export function lvalueForStackSubobject(a, path) {
  let out = a.name;
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : `.${part}`;
  return out;
}
export function lvalueForHeapSubobject(heap, path, anchor, state) {
  let out = anchor,
    type = heap.type;
  if (!path.length) return `*${operand(anchor)}`;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type)) {
      out = `${operand(out)}[${part}]`;
      type = type.of;
    } else if (isStruct(type)) {
      const def = resolveStructType(type, state?.structTypes ?? {});
      out = i === 0 && heap.type.kind === 'struct' ? `${operand(out)}->${part}` : `${out}.${part}`;
      type = def.fields?.find(f => f.name === part)?.type ?? type;
    }
  }
  return out;
}
function pointerExprForHeapTarget(heap, path, anchor, state) {
  if (!path.length) return anchor;
  if (path.at(-1) === '$onePast')
    return path.length === 1
      ? `${operand(anchor)} + 1`
      : `&${lvalueForHeapSubobject(heap, path.slice(0, -1), anchor, state)} + 1`;
  if (isArray(heap.type) && path.length === 1 && typeof path[0] === 'number')
    return path[0] === 0 ? anchor : `${operand(anchor)} + ${path[0]}`;
  return `&${lvalueForHeapSubobject(heap, path, anchor, state)}`;
}
export function numberToC(value, type) {
  if (type.name === 'bool') return value ? 'true' : 'false';
  // The diagram shows a char as a character, so the code does too where one is readable.
  if (type.name === 'char' && (value === 0 || readableChar(value))) return encodeCharLiteral(value);
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
export function canAllocateThrough(heap, pointerType) {
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
/**
 * `expr` as the operand of [], -> or unary *. A name followed by member and element
 * accesses binds tighter than any of them (head->next->v); anything else gets brackets.
 */
function operand(expr) {
  return /^(?:[A-Za-z_]\w*|\([^()]*\))(?:->\w+|\.\w+|\[\d+\])*$/.test(expr) ? expr : `(${expr})`;
}
/** A static char array's characters before its one, final '\0', or null if it is not one. */
function literalCodes(a) {
  if (!isArray(a.type) || !typeEquals(a.type.of, CHAR) || a.value?.kind !== 'aggregate')
    return null;
  const codes = a.value.elements.map(e => (e?.kind === 'scalar' ? e.value : null));
  if (codes.at(-1) !== 0 || codes.includes(null)) return null;
  return codes.slice(0, -1);
}
function scalarValues(state) {
  return state.allocations.flatMap(a => scalarSubobjects(a, state).map(s => s.value));
}
