/** MemoryState -> one canonical PointerViz Mini-C program. */
import {
  declarationToC, isArray, isPointer, isPrimitive, isStruct, pointer, resolveStructType,
  typeEquals, typeToString, validIdentifier,
} from '../language/types.js';
import {
  allocationDisplayName, getAllocation, heapAllocations, pointerEdges, resolveRef,
  scalarSubobjects, stackAllocations,
} from '../machine/memory.js';

export class ValidationError extends Error {
  constructor(errors) { super('invalid memory diagram:\n  - ' + errors.join('\n  - ')); this.errors = errors; }
}

export function validate(state) {
  const errors = [];
  if (!state || !Array.isArray(state.allocations)) throw new ValidationError(['state is missing allocations[]']);
  const ids = new Set(), namesByFrame = new Map();
  for (const a of state.allocations) {
    if (!a.id || ids.has(a.id)) errors.push(`duplicate or missing allocation id '${a.id ?? ''}'`);
    ids.add(a.id);
    if (a.storage?.kind === 'stack') {
      const frameId = a.storage.frameId ?? 'main';
      const names = namesByFrame.get(frameId) ?? new Set();
      if (!validIdentifier(a.name)) errors.push(`stack object needs a valid, non-keyword C identifier`);
      else if (names.has(a.name)) errors.push(`duplicate variable name '${a.name}' in one stack frame`);
      names.add(a.name); namesByFrame.set(frameId, names);
    } else if (a.storage?.kind === 'heap') {
      if (a.name) errors.push(`heap allocations must not have source-level variable names`);
    } else errors.push(`allocation ${a.id} has invalid storage kind`);
    validateValueShape(a.type, a.value, allocationDisplayName(state, a), errors, state.structTypes ?? {});
  }
  for (const edge of pointerEdges(state)) {
    try {
      const src = resolveRef(state, edge.source), tgt = resolveRef(state, edge.target);
      if (!isPointer(src.type)) errors.push(`${src.label} contains a pointer edge but has type ${typeToString(src.type)}`);
      else if (!typeEquals(src.type.to, tgt.type)) errors.push(`type error: ${typeToString(src.type)} ${src.label} cannot point to ${typeToString(tgt.type)} ${tgt.label}`);
    } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new ValidationError(errors);
  return state;
}

function validateValueShape(type, value, label, errors, structs) {
  if (!value) { errors.push(`${label} has no value representation`); return; }
  if (isPrimitive(type)) { if (!['scalar', 'uninit'].includes(value.kind)) errors.push(`${label} is ${typeToString(type)} but stores ${value.kind}`); return; }
  if (isPointer(type)) { if (!['pointer', 'null', 'uninit'].includes(value.kind)) errors.push(`${label} is ${typeToString(type)} but stores ${value.kind}`); return; }
  if (isArray(type)) {
    if (value.kind !== 'aggregate' || !Array.isArray(value.elements) || value.elements.length !== type.length) { errors.push(`${label} has malformed array storage`); return; }
    value.elements.forEach((v, i) => validateValueShape(type.of, v, `${label}[${i}]`, errors, structs)); return;
  }
  if (isStruct(type)) {
    const def = resolveStructType(type, structs);
    if (!def.fields) { errors.push(`${label} uses unknown struct ${type.name}`); return; }
    if (value.kind !== 'aggregate' || !value.fields) { errors.push(`${label} has malformed struct storage`); return; }
    for (const f of def.fields) validateValueShape(f.type, value.fields[f.name], `${label}.${f.name}`, errors, structs);
    return;
  }
  errors.push(`${label} uses unsupported type ${typeToString(type)}`);
}

export function generate(state) {
  validate(state);
  const nonMain = stackAllocations(state).filter(a => (a.storage.frameId ?? 'main') !== 'main');
  if (nonMain.length) throw new ValidationError(['diagram-to-code generation currently requires a single main() stack frame; function-call snapshots can still be viewed and graded']);
  const deadStack = stackAllocations(state).filter(a => !a.alive);
  if (deadStack.length) throw new ValidationError(['cannot generate final C from expired stack objects']);

  const ctx = { state, lines: [], heapAnchor: new Map(), heapInitialized: new Set(), initializing: new Set() };
  const stack = stackAllocations(state);
  for (const a of stack) ctx.lines.push(`${declarationToC(a.type, a.name)};`);
  if (stack.length) ctx.lines.push('');
  for (const a of stack) emitNonPointerStorage(a, ctx);
  for (const a of stack) emitPointerStorage(a, ctx);

  for (const heap of heapAllocations(state)) {
    if (ctx.heapAnchor.has(heap.id)) continue;
    const incoming = pointerEdges(state).some(e => e.target.allocationId === heap.id);
    if (!incoming) {
      const label = allocationDisplayName(state, heap);
      if (!heap.alive) throw new ValidationError([`${label} is freed but has no surviving pointer; its provenance cannot be reproduced`]);
      if (hasMeaningfulValue(heap.type, heap.value, state)) throw new ValidationError([`initialized heap allocation (${label}) is unreachable; add a pointer to it or clear its contents`]);
      ctx.lines.push(`${mallocExpr(heap)}; /* intentionally leaked */`);
    }
  }
  for (const heap of heapAllocations(state)) if (!heap.alive && ctx.heapAnchor.has(heap.id)) ctx.lines.push(`free(${ctx.heapAnchor.get(heap.id)});`);

  const definitions = emitStructDefinitions(state);
  const cleaned = trimBlankLines(ctx.lines);
  const needsStdlib = heapAllocations(state).length > 0 || scalarValues(state).some(v => v.kind === 'null');
  const header = needsStdlib ? '#include <stdlib.h>\n\n' : '';
  const structs = definitions ? `${definitions}\n\n` : '';
  const body = cleaned.map(line => line ? `    ${line}` : '').join('\n');
  return `${header}${structs}int main(void) {\n${body}${body ? '\n' : ''}    return 0;\n}\n`;
}

function emitStructDefinitions(state) {
  const defs = Object.values(state.structTypes ?? {});
  return defs.map(def => {
    const fields = def.fields.map(f => `    ${declarationToC(f.type, f.name)};`).join('\n');
    return `struct ${def.name} {\n${fields}\n};`;
  }).join('\n\n');
}

function emitNonPointerStorage(a, ctx) {
  for (const s of scalarSubobjects(a, ctx.state)) {
    if (isPointer(s.type) || s.value.kind !== 'scalar') continue;
    ctx.lines.push(`${lvalueForStackSubobject(a, s.ref.path)} = ${s.value.value};`);
  }
}
function emitPointerStorage(a, ctx) {
  for (const s of scalarSubobjects(a, ctx.state)) {
    if (isPointer(s.type)) emitPointerAssignment(lvalueForStackSubobject(a, s.ref.path), s.type, s.value, ctx);
  }
}

function emitPointerAssignment(lhs, pointerType, value, ctx) {
  if (value.kind === 'uninit') return;
  if (value.kind === 'null') { ctx.lines.push(`${lhs} = NULL;`); return; }
  const target = getAllocation(ctx.state, value.target.allocationId);
  if (target.storage.kind === 'stack') { ctx.lines.push(`${lhs} = &${lvalueForStackSubobject(target, value.target.path)};`); return; }
  ensureHeapAllocated(target, lhs, pointerType, value.target.path, ctx);
  const rhs = pointerExprForHeapTarget(target, value.target.path, ctx.heapAnchor.get(target.id), ctx.state);
  if (rhs !== lhs) ctx.lines.push(`${lhs} = ${rhs};`);
  initializeHeap(target, ctx);
}

function ensureHeapAllocated(heap, lhs, pointerType, targetPath, ctx) {
  if (ctx.heapAnchor.has(heap.id)) return;
  const expected = heapBasePointerType(heap);
  if (!typeEquals(pointerType, expected)) throw new ValidationError([`${lhs} has type ${typeToString(pointerType)} but ${allocationDisplayName(ctx.state, heap)} needs ${typeToString(expected)}`]);
  ctx.lines.push(`${lhs} = ${mallocExpr(heap)};`);
  if (heap.type.kind === 'array' && targetPath.length === 1 && targetPath[0] !== 0) {
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
    if (isPrimitive(s.type) && s.value.kind === 'scalar') ctx.lines.push(`${lhs} = ${s.value.value};`);
    else if (isPointer(s.type)) emitPointerAssignment(lhs, s.type, s.value, ctx);
  }
  ctx.initializing.delete(heap.id); ctx.heapInitialized.add(heap.id);
}

function lvalueForStackSubobject(a, path) {
  let out = a.name;
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : `.${part}`;
  return out;
}
function lvalueForHeapSubobject(heap, path, anchor, state) {
  let out = anchor, type = heap.type;
  if (!path.length) return `*${parenIfNeeded(anchor)}`;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type)) { out = `${parenIfNeeded(out)}[${part}]`; type = type.of; }
    else if (isStruct(type)) {
      const def = resolveStructType(type, state?.structTypes ?? {});
      out = i === 0 && heap.type.kind === 'struct' ? `${parenIfNeeded(out)}->${part}` : `${out}.${part}`;
      type = def.fields?.find(f => f.name === part)?.type ?? type;
    }
  }
  return out;
}
function pointerExprForHeapTarget(heap, path, anchor, state) {
  if (!path.length) return anchor;
  if (isArray(heap.type) && path.length === 1 && typeof path[0] === 'number') return path[0] === 0 ? anchor : `${parenIfNeeded(anchor)} + ${path[0]}`;
  return `&${lvalueForHeapSubobject(heap, path, anchor, state)}`;
}
function heapBasePointerType(heap) { return pointer(isArray(heap.type) ? heap.type.of : heap.type); }
function mallocExpr(heap) { return isArray(heap.type) ? `malloc(${heap.type.length} * sizeof(${typeToString(heap.type.of)}))` : `malloc(sizeof(${typeToString(heap.type)}))`; }
function parenIfNeeded(expr) { return /^[A-Za-z_]\w*$/.test(expr) ? expr : `(${expr})`; }
function hasMeaningfulValue(type, value, state) {
  if (isPrimitive(type) || isPointer(type)) return value.kind !== 'uninit';
  if (isArray(type)) return value.elements.some(v => hasMeaningfulValue(type.of, v, state));
  if (isStruct(type)) { const def = resolveStructType(type, state.structTypes); return def.fields.some(f => hasMeaningfulValue(f.type, value.fields[f.name], state)); }
  return false;
}
function scalarValues(state) { return state.allocations.flatMap(a => scalarSubobjects(a, state).map(s => s.value)); }
function trimBlankLines(lines) { const out = [...lines]; while (out[0] === '') out.shift(); while (out.at(-1) === '') out.pop(); return out.filter((line, i) => line !== '' || out[i - 1] !== ''); }
