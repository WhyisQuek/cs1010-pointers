/**
 * Canonical PointerViz memory model.
 *
 * Allocations own lifetime. Arrays and struct fields are subobjects addressed
 * by a path. Stack allocations record their call-frame ID; heap allocations
 * remain anonymous source-level objects. Dead stack frames and freed heap
 * allocations remain in snapshots so dangling-pointer provenance is visible.
 */
import {
  isArray,
  isPointer,
  isPrimitive,
  isStruct,
  resolveStructType,
  typeEquals,
  typeToString,
  validateObjectType,
} from '../language/types.js';
import { makeAddressSpace, nextAddress, referenceOffset, upgradeMemoryState } from './addresses.js';

// Kept for older callers. New states own their counters; interpreting a second
// program can never reset identities in an editable diagram or snapshot copy.
export function resetAllocationIds() {}
function candidateId(state, kind) {
  const prefix = kind === 'allocation' ? 'a' : 'frame';
  const records = kind === 'allocation' ? state.allocations : state.frames;
  let index = state.identity?.[kind] ?? 0;
  while (records.some(r => r.id === `${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}
export const freshAllocationId = state => candidateId(state, 'allocation');
export const freshFrameId = (state, name = 'frame') =>
  name === 'main' && !state.frames.some(f => f.id === 'main')
    ? 'main'
    : candidateId(state, 'frame');
function commitIdentity(state, kind, id) {
  const suffix = id.match(kind === 'allocation' ? /^a(\d+)$/ : /^frame(\d+)$/);
  state.identity = {
    allocation: 0,
    frame: 0,
    ...state.identity,
    [kind]: Math.max(
      state.identity?.[kind] ?? 0,
      suffix ? Number(suffix[1]) + 1 : id === 'main' ? 1 : 0,
    ),
  };
}

export function makeState(structTypes = {}) {
  return {
    allocations: [],
    frames: [],
    structTypes: structuredClone(structTypes),
    identity: { allocation: 0, frame: 0 },
    addressSpace: makeAddressSpace(),
  };
}

export function addFrame(
  state,
  { id = freshFrameId(state), name, callerId = null, depth = 0, active = true } = {},
) {
  if (typeof id !== 'string' || !id || state.frames.some(f => f.id === id))
    throw new Error(`duplicate or missing frame id '${id}'`);
  const frame = { id, name, callerId, depth, active };
  commitIdentity(state, 'frame', id);
  state.frames.push(frame);
  return frame;
}

export function getFrame(state, id) {
  return state.frames.find(f => f.id === id) ?? null;
}

export function endFrame(state, frameId) {
  const frame = getFrame(state, frameId);
  if (frame) frame.active = false;
  for (const a of state.allocations) {
    if (a.storage.kind === 'stack' && a.storage.frameId === frameId) a.alive = false;
  }
}

export function makeDefaultValue(type, structTypes = {}) {
  if (isPrimitive(type) || isPointer(type)) return { kind: 'uninit' };
  if (isArray(type))
    return {
      kind: 'aggregate',
      elements: Array.from({ length: type.length }, () => makeDefaultValue(type.of, structTypes)),
    };
  if (isStruct(type)) {
    const def = resolveStructType(type, structTypes);
    if (!def.fields) throw new Error(`unknown struct '${type.name}'`);
    return {
      kind: 'aggregate',
      fields: Object.fromEntries(
        def.fields.map(f => [f.name, makeDefaultValue(f.type, structTypes)]),
      ),
    };
  }
  throw new Error(`cannot initialize value for ${typeToString(type)}`);
}

export function addAllocation(
  state,
  {
    id = freshAllocationId(state),
    name = null,
    type,
    storage = { kind: 'stack', frameId: 'main' },
    alive = true,
    value = null,
  } = {},
) {
  if (!type) throw new Error('allocation requires a type');
  if (typeof id !== 'string' || !id || state.allocations.some(a => a.id === id))
    throw new Error(`duplicate or missing allocation id '${id}'`);
  validateObjectType(type, state.structTypes);
  const allocation = {
    id,
    name,
    type: structuredClone(type),
    storage: structuredClone(storage),
    alive,
    value: value ? structuredClone(value) : makeDefaultValue(type, state.structTypes),
  };
  const prepared = state.addressSpace == null ? upgradeMemoryState(state) : state;
  const reserved = nextAddress(prepared.addressSpace, storage, type, state.structTypes);
  if (prepared.allocations.some(a => a.baseAddress === reserved.baseAddress))
    throw new Error('simulated address cursor collides with an allocation');
  allocation.baseAddress = reserved.baseAddress;
  if (prepared !== state) state.allocations = prepared.allocations;
  state.addressSpace = reserved.addressSpace;
  commitIdentity(state, 'allocation', id);
  state.allocations.push(allocation);
  return allocation;
}

export function getAllocation(state, id) {
  const a = state.allocations.find(x => x.id === id);
  if (!a) throw new Error(`invalid reference to missing allocation ${id}`);
  return a;
}

export const ref = (allocationId, path = []) => ({ allocationId, path: [...path] });
export const pointerValue = target => ({
  kind: 'pointer',
  target: ref(target.allocationId, target.path ?? []),
});
export const refKey = r => `${r.allocationId}:${(r.path ?? []).map(String).join('.')}`;
export function sameRef(a, b) {
  if (!a || !b || a.allocationId !== b.allocationId) return false;
  const ap = a.path ?? [],
    bp = b.path ?? [];
  return ap.length === bp.length && ap.every((x, i) => x === bp[i]);
}

export function resolveRef(state, targetRef, { allowDead = true } = {}) {
  if (!targetRef || !Array.isArray(targetRef.path ?? [])) throw new Error('invalid reference path');
  const allocation = getAllocation(state, targetRef.allocationId);
  if (!allowDead && !allocation.alive)
    throw new Error('reference points to an object whose lifetime has ended');
  let type = allocation.type;
  let value = allocation.value;
  let label = allocationDisplayName(state, allocation);

  const path = targetRef.path ?? [];
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (part === '$onePast')
      return {
        allocation,
        type,
        value: null,
        ref: targetRef,
        onePast: i === path.length - 1,
        invalid: i !== path.length - 1,
        label: `${label} + 1 (one-past)`,
      };
    if (isArray(type)) {
      if (!Number.isInteger(part) || part < 0 || part >= type.length) {
        const onePast = part === type.length && i === path.length - 1;
        return {
          allocation,
          type: type.of,
          value: null,
          ref: targetRef,
          onePast,
          invalid: !onePast,
          label: `${label}[${part}]`,
        };
      }
      value = value.elements[part];
      type = type.of;
      label += `[${part}]`;
      continue;
    }
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes);
      const field = def.fields?.find(f => f.name === part);
      if (!field) throw new Error(`struct ${type.name} has no field '${part}'`);
      value = value.fields[part];
      type = field.type;
      label += `.${part}`;
      continue;
    }
    throw new Error(`cannot select subobject '${part}' from ${typeToString(type)}`);
  }
  return { allocation, type, value, ref: targetRef, onePast: false, invalid: false, label };
}

export function setRefValue(state, targetRef, nextValue) {
  const resolved = resolveRef(state, targetRef, { allowDead: false });
  if (resolved.invalid || resolved.onePast) throw new Error('write outside object bounds');
  const allocation = getAllocation(state, targetRef.allocationId);
  if (!allocation.alive)
    throw new Error(`write through pointer to an object whose lifetime has ended`);
  const path = targetRef.path ?? [];
  if (!path.length) {
    allocation.value = structuredClone(nextValue);
    return;
  }

  let type = allocation.type,
    value = allocation.value;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (isArray(type)) {
      value = value.elements[part];
      type = type.of;
    } else if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes);
      const field = def.fields.find(f => f.name === part);
      value = value.fields[part];
      type = field.type;
    } else throw new Error(`invalid subobject path ${path.join('.')}`);
  }
  const last = path.at(-1);
  if (isArray(type)) value.elements[last] = structuredClone(nextValue);
  else if (isStruct(type)) value.fields[last] = structuredClone(nextValue);
  else throw new Error(`invalid subobject path ${path.join('.')}`);
}

export const rootRef = allocation => ref(allocation.id, []);
export const decayRef = allocation =>
  isArray(allocation.type) ? ref(allocation.id, [0]) : ref(allocation.id, []);

export function pointerStatus(state, value) {
  if (value.kind === 'null') return 'null';
  if (value.kind === 'uninit') return 'uninitialized';
  if (value.kind !== 'pointer') return 'not-pointer';
  try {
    const target = referenceOffset(state, value.target);
    if (!target.allocation.alive) return 'dangling';
    return target.onePast ? 'one-past' : 'valid';
  } catch {
    return 'invalid';
  }
}

export function scalarSubobjects(allocation, stateOrStructTypes = {}) {
  const structTypes = stateOrStructTypes.structTypes ?? stateOrStructTypes;
  const out = [];
  walk(allocation.type, allocation.value, [], out, structTypes);
  return out.map(x => ({ ...x, allocation, ref: ref(allocation.id, x.path) }));
}

function walk(type, value, path, out, structTypes) {
  if (isPrimitive(type) || isPointer(type)) {
    out.push({ type, value, path: [...path] });
    return;
  }
  if (isArray(type)) {
    for (let i = 0; i < type.length; i++)
      walk(type.of, value.elements[i], [...path, i], out, structTypes);
    return;
  }
  if (isStruct(type)) {
    const def = resolveStructType(type, structTypes);
    for (const f of def.fields ?? [])
      walk(f.type, value.fields[f.name], [...path, f.name], out, structTypes);
  }
}

export function pointerEdges(state) {
  const out = [];
  for (const allocation of state.allocations) {
    for (const scalar of scalarSubobjects(allocation, state)) {
      if (scalar.value.kind === 'pointer')
        out.push({
          source: scalar.ref,
          target: scalar.value.target,
          status: pointerStatus(state, scalar.value),
        });
    }
  }
  return out;
}

export const stackAllocations = state => state.allocations.filter(a => a.storage.kind === 'stack');
export const heapAllocations = state => state.allocations.filter(a => a.storage.kind === 'heap');
export const frameAllocations = (state, frameId) =>
  stackAllocations(state).filter(a => a.storage.frameId === frameId);
export function stackAllocationByName(state, name, frameId = null) {
  return (
    stackAllocations(state).find(
      a => a.name === name && (frameId == null || a.storage.frameId === frameId),
    ) ?? null
  );
}

export function allocationDisplayName(state, allocation) {
  if (allocation.name) return allocation.name;
  const heaps = heapAllocations(state);
  const i = heaps.findIndex(h => h.id === allocation.id);
  return i >= 0 ? `heap ${i + 1}` : 'heap';
}

export const heapAllocationType = (elementType, count) =>
  count === 1
    ? structuredClone(elementType)
    : { kind: 'array', of: structuredClone(elementType), length: count };
export const cloneState = state => structuredClone(state);
export const refType = (state, r) => resolveRef(state, r).type;

export function pointerCanTarget(state, pointerType, targetRef) {
  if (!isPointer(pointerType)) return false;
  try {
    const resolved = resolveRef(state, targetRef);
    return (
      resolved.allocation.alive &&
      !resolved.invalid &&
      !resolved.onePast &&
      typeEquals(pointerType.to, resolved.type)
    );
  } catch {
    return false;
  }
}

/** Includes aggregate roots/subarrays, unlike scalarSubobjects(). */
export function addressableSubobjects(allocation, state) {
  const out = [];
  const visit = (type, path) => {
    out.push({ type, ref: ref(allocation.id, path) });
    if (isArray(type)) for (let i = 0; i < type.length; i++) visit(type.of, [...path, i]);
    if (isStruct(type))
      for (const field of resolveStructType(type, state.structTypes).fields)
        visit(field.type, [...path, field.name]);
  };
  visit(allocation.type, []);
  return out;
}
