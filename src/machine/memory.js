/**
 * Canonical PointerViz memory model.
 *
 * Allocations own lifetime. Arrays and struct fields are subobjects addressed
 * by a path. Stack allocations record their call-frame ID; heap allocations
 * remain anonymous source-level objects. Dead stack frames and freed heap
 * allocations remain in snapshots so dangling-pointer provenance is visible.
 */
import { UNDEFINED, diagnostic } from '../language/diagnostics.js';
import {
  isArray,
  isBlock,
  isPointer,
  isPrimitive,
  isStruct,
  resolveStructType,
  sizeOf,
  typeEquals,
  typeToString,
  validateObjectType,
} from '../language/types.js';
import { makeAddressSpace, nextAddress, referenceOffset, upgradeMemoryState } from './addresses.js';

// Each state owns its identity counters, so interpreting a second program can
// never reset identities in an editable diagram or snapshot copy.
function candidateId(state, kind) {
  const prefix = kind === 'allocation' ? 'a' : 'frame';
  const records = kind === 'allocation' ? state.allocations : state.frames;
  let index = state.identity?.[kind] ?? 0;
  while (records.some(r => r.id === `${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}
const freshAllocationId = state => candidateId(state, 'allocation');
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

export function endFrame(state, frameId) {
  const frame = state.frames.find(f => f.id === frameId);
  if (frame) frame.active = false;
  for (const a of state.allocations) {
    if (a.storage.kind === 'stack' && a.storage.frameId === frameId) a.alive = false;
  }
}

export function makeDefaultValue(type, structTypes = {}) {
  if (isPrimitive(type) || isPointer(type) || isBlock(type)) return { kind: 'uninit' };
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
export function samePath(a = [], b = []) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
export function sameRef(a, b) {
  return !!a && !!b && a.allocationId === b.allocationId && samePath(a.path ?? [], b.path ?? []);
}

export function resolveRef(state, targetRef, { allowDead = true } = {}) {
  if (!targetRef || !Array.isArray(targetRef.path ?? [])) throw new Error('invalid reference path');
  const allocation = getAllocation(state, targetRef.allocationId);
  if (!allowDead && !allocation.alive)
    throw diagnostic(UNDEFINED, 'reference points to an object whose lifetime has ended');
  let type = allocation.type;
  let value = allocation.value;
  let label = allocationDisplayName(state, allocation);
  // Where `value` is stored (container[key]), so setRefValue can write without another walk.
  let container = null,
    key = null;

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
      [container, key] = [value.elements, part];
      value = container[key];
      type = type.of;
      label += `[${part}]`;
      continue;
    }
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes);
      const field = def.fields?.find(f => f.name === part);
      if (!field) throw new Error(`struct ${type.name} has no field '${part}'`);
      [container, key] = [value.fields, part];
      value = container[key];
      type = field.type;
      label += `.${part}`;
      continue;
    }
    throw new Error(`cannot select subobject '${part}' from ${typeToString(type)}`);
  }
  return {
    allocation,
    type,
    value,
    ref: targetRef,
    onePast: false,
    invalid: false,
    label,
    container,
    key,
  };
}

export function setRefValue(state, targetRef, nextValue) {
  const { allocation, invalid, onePast, container, key } = resolveRef(state, targetRef, {
    allowDead: false,
  });
  if (invalid || onePast) throw diagnostic(UNDEFINED, 'write outside object bounds');
  if (allocation.storage.kind === 'static')
    throw diagnostic(UNDEFINED, 'cannot modify a string literal (undefined behavior)');
  if (container) container[key] = structuredClone(nextValue);
  else allocation.value = structuredClone(nextValue);
}

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
/** String literal objects: named by their C spelling, never written, alive for the whole run. */
export const staticAllocations = state =>
  state.allocations.filter(a => a.storage.kind === 'static');
export const frameAllocations = (state, frameId) =>
  stackAllocations(state).filter(a => a.storage.frameId === frameId);

export function allocationDisplayName(state, allocation) {
  if (allocation.name) return allocation.name;
  if (allocation.storage.kind === 'stack') return '(unnamed)';
  const heaps = heapAllocations(state);
  const i = heaps.findIndex(h => h.id === allocation.id);
  return i >= 0 ? `heap ${i + 1}` : 'heap';
}

export const heapAllocationType = (elementType, count) =>
  count === 1
    ? structuredClone(elementType)
    : { kind: 'array', of: structuredClone(elementType), length: count };

/**
 * Give an untyped malloc block its effective type (C23 6.5p6): as many whole `elementType`
 * objects as fit. Returns a reference to the first, or null when not even one fits.
 */
export function typeHeapBlock(state, allocation, elementType) {
  const count = Math.floor(allocation.type.bytes / sizeOf(elementType, state.structTypes));
  if (count < 1) return null;
  const type = heapAllocationType(elementType, count);
  validateObjectType(type, state.structTypes);
  allocation.requestedBytes = allocation.type.bytes;
  allocation.type = type;
  allocation.value = makeDefaultValue(type, state.structTypes);
  return ref(allocation.id, count === 1 ? [] : [0]);
}

/**
 * A void * records only an address, so it designates the outermost object there (the whole
 * array or struct rather than its first element). Equal addresses then get equal targets.
 */
export function outermostRefAtAddress(state, target) {
  const allocation = getAllocation(state, target.allocationId);
  const offset = referenceOffset(state, target).offset;
  return (
    addressableSubobjects(allocation, state).find(
      s => referenceOffset(state, s.ref).offset === offset,
    )?.ref ?? target
  );
}

/**
 * The subobject of `allocation` at the same address as `target` whose type is `type`, if
 * any. A pointer converted through void * designates that object (C23 6.3.2.3p1, p7).
 */
export function refAtSameAddress(state, target, type) {
  const allocation = getAllocation(state, target.allocationId);
  const offset = referenceOffset(state, target).offset;
  return (
    addressableSubobjects(allocation, state).find(
      s => typeEquals(s.type, type) && referenceOffset(state, s.ref).offset === offset,
    )?.ref ?? null
  );
}
export const cloneState = state => structuredClone(state);
export const refType = (state, r) => resolveRef(state, r).type;

export function pointerCanTarget(state, pointerType, targetRef) {
  if (!isPointer(pointerType)) return false;
  try {
    const resolved = resolveRef(state, targetRef);
    // A void * may point at any object (C23 6.3.2.3p1).
    return (
      resolved.allocation.alive &&
      !resolved.invalid &&
      !resolved.onePast &&
      (pointerType.to.kind === 'void' || typeEquals(pointerType.to, resolved.type))
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
