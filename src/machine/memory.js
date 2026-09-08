/**
 * Canonical PointerViz memory model.
 *
 * Allocations own lifetime. Arrays and struct fields are subobjects addressed
 * by a path. Stack allocations record their call-frame ID; heap allocations
 * remain anonymous source-level objects. Dead stack frames and freed heap
 * allocations remain in snapshots so dangling-pointer provenance is visible.
 */
import {
  isArray, isPointer, isPrimitive, isStruct, resolveStructType, typeEquals, typeToString,
} from '../language/types.js';

let nextAllocationId = 0;
let nextFrameId = 0;
export function resetAllocationIds() { nextAllocationId = 0; nextFrameId = 0; }
export function freshAllocationId() { return `a${nextAllocationId++}`; }
export function freshFrameId(name = 'frame') { return name === 'main' && nextFrameId === 0 ? (nextFrameId++, 'main') : `frame${nextFrameId++}`; }

export function makeState(structTypes = {}) {
  return { allocations: [], frames: [], structTypes: structuredClone(structTypes) };
}

export function addFrame(state, { id = freshFrameId(), name, callerId = null, depth = 0, active = true } = {}) {
  const frame = { id, name, callerId, depth, active };
  state.frames.push(frame);
  return frame;
}

export function getFrame(state, id) { return state.frames.find(f => f.id === id) ?? null; }

export function endFrame(state, frameId) {
  const frame = getFrame(state, frameId);
  if (frame) frame.active = false;
  for (const a of state.allocations) {
    if (a.storage.kind === 'stack' && a.storage.frameId === frameId) a.alive = false;
  }
}

export function makeDefaultValue(type, structTypes = {}) {
  if (isPrimitive(type) || isPointer(type)) return { kind: 'uninit' };
  if (isArray(type)) return { kind: 'aggregate', elements: Array.from({ length: type.length }, () => makeDefaultValue(type.of, structTypes)) };
  if (isStruct(type)) {
    const def = resolveStructType(type, structTypes);
    if (!def.fields) throw new Error(`unknown struct '${type.name}'`);
    return { kind: 'aggregate', fields: Object.fromEntries(def.fields.map(f => [f.name, makeDefaultValue(f.type, structTypes)])) };
  }
  throw new Error(`cannot initialize value for ${typeToString(type)}`);
}

export function addAllocation(state, {
  id = freshAllocationId(), name = null, type,
  storage = { kind: 'stack', frameId: 'main' }, alive = true, value = null,
} = {}) {
  if (!type) throw new Error('allocation requires a type');
  const allocation = {
    id, name, type: structuredClone(type), storage: structuredClone(storage), alive,
    value: value ? structuredClone(value) : makeDefaultValue(type, state.structTypes),
  };
  state.allocations.push(allocation);
  return allocation;
}

export function getAllocation(state, id) {
  const a = state.allocations.find(x => x.id === id);
  if (!a) throw new Error(`invalid reference to missing allocation ${id}`);
  return a;
}

export const ref = (allocationId, path = []) => ({ allocationId, path: [...path] });
export const pointerValue = target => ({ kind: 'pointer', target: ref(target.allocationId, target.path ?? []) });
export const refKey = r => `${r.allocationId}:${(r.path ?? []).map(String).join('.')}`;
export function sameRef(a, b) {
  if (!a || !b || a.allocationId !== b.allocationId) return false;
  const ap = a.path ?? [], bp = b.path ?? [];
  return ap.length === bp.length && ap.every((x, i) => x === bp[i]);
}

export function resolveRef(state, targetRef, { allowDead = true } = {}) {
  const allocation = getAllocation(state, targetRef.allocationId);
  if (!allowDead && !allocation.alive) throw new Error('reference points to an object whose lifetime has ended');
  let type = allocation.type;
  let value = allocation.value;
  let label = allocationDisplayName(state, allocation);

  for (const part of targetRef.path ?? []) {
    if (isArray(type)) {
      if (!Number.isInteger(part) || part < 0 || part >= type.length) {
        return { allocation, type: type.of, value: null, ref: targetRef, onePast: part === type.length, invalid: part !== type.length, label: `${label}[${part}]` };
      }
      value = value.elements[part]; type = type.of; label += `[${part}]`; continue;
    }
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes);
      const field = def.fields?.find(f => f.name === part);
      if (!field) throw new Error(`struct ${type.name} has no field '${part}'`);
      value = value.fields[part]; type = field.type; label += `.${part}`; continue;
    }
    throw new Error(`cannot select subobject '${part}' from ${typeToString(type)}`);
  }
  return { allocation, type, value, ref: targetRef, onePast: false, invalid: false, label };
}

export function setRefValue(state, targetRef, nextValue) {
  const allocation = getAllocation(state, targetRef.allocationId);
  if (!allocation.alive) throw new Error(`write through pointer to an object whose lifetime has ended`);
  const path = targetRef.path ?? [];
  if (!path.length) { allocation.value = structuredClone(nextValue); return; }

  let type = allocation.type, value = allocation.value;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (isArray(type)) { value = value.elements[part]; type = type.of; }
    else if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes);
      const field = def.fields.find(f => f.name === part);
      value = value.fields[part]; type = field.type;
    } else throw new Error(`invalid subobject path ${path.join('.')}`);
  }
  const last = path.at(-1);
  if (isArray(type)) value.elements[last] = structuredClone(nextValue);
  else if (isStruct(type)) value.fields[last] = structuredClone(nextValue);
  else throw new Error(`invalid subobject path ${path.join('.')}`);
}

export const rootRef = allocation => ref(allocation.id, []);
export const decayRef = allocation => isArray(allocation.type) ? ref(allocation.id, [0]) : ref(allocation.id, []);

export function pointerStatus(state, value) {
  if (value.kind === 'null') return 'null';
  if (value.kind === 'uninit') return 'uninitialized';
  if (value.kind !== 'pointer') return 'not-pointer';
  const target = resolveRef(state, value.target);
  if (!target.allocation.alive) return 'dangling';
  if (target.invalid) return 'invalid';
  if (target.onePast) return 'one-past';
  return 'valid';
}

export function scalarSubobjects(allocation, stateOrStructTypes = {}) {
  const structTypes = stateOrStructTypes.structTypes ?? stateOrStructTypes;
  const out = [];
  walk(allocation.type, allocation.value, [], out, structTypes);
  return out.map(x => ({ ...x, allocation, ref: ref(allocation.id, x.path) }));
}

function walk(type, value, path, out, structTypes) {
  if (isPrimitive(type) || isPointer(type)) { out.push({ type, value, path: [...path] }); return; }
  if (isArray(type)) {
    for (let i = 0; i < type.length; i++) walk(type.of, value.elements[i], [...path, i], out, structTypes);
    return;
  }
  if (isStruct(type)) {
    const def = resolveStructType(type, structTypes);
    for (const f of def.fields ?? []) walk(f.type, value.fields[f.name], [...path, f.name], out, structTypes);
  }
}

export function pointerEdges(state) {
  const out = [];
  for (const allocation of state.allocations) {
    for (const scalar of scalarSubobjects(allocation, state)) {
      if (scalar.value.kind === 'pointer') out.push({ source: scalar.ref, target: scalar.value.target, status: pointerStatus(state, scalar.value) });
    }
  }
  return out;
}

export const stackAllocations = state => state.allocations.filter(a => a.storage.kind === 'stack');
export const heapAllocations = state => state.allocations.filter(a => a.storage.kind === 'heap');
export const frameAllocations = (state, frameId) => stackAllocations(state).filter(a => a.storage.frameId === frameId);
export function stackAllocationByName(state, name, frameId = null) {
  return stackAllocations(state).find(a => a.name === name && (frameId == null || a.storage.frameId === frameId)) ?? null;
}

export function allocationDisplayName(state, allocation) {
  if (allocation.name) return allocation.name;
  const heaps = heapAllocations(state);
  const i = heaps.findIndex(h => h.id === allocation.id);
  return i >= 0 ? `heap ${i + 1}` : 'heap';
}

export const heapAllocationType = (elementType, count) => count === 1 ? structuredClone(elementType) : { kind: 'array', of: structuredClone(elementType), length: count };
export const cloneState = state => structuredClone(state);
export const refType = (state, r) => resolveRef(state, r).type;

export function pointerCanTarget(state, pointerType, targetRef) {
  if (!isPointer(pointerType)) return false;
  const resolved = resolveRef(state, targetRef);
  return !resolved.invalid && !resolved.onePast && typeEquals(pointerType.to, resolved.type);
}
