/** Atomic diagram redesign operations; these are not executed C operations. */
import { typeEquals } from '../language/types.js';
import { checkAddressCapacity, referenceLocation } from './addresses.js';
import {
  frameAllocations,
  getAllocation,
  makeDefaultValue,
  pointerStatus,
  resolveRef,
  scalarSubobjects,
  setRefValue,
} from './memory.js';

export function changeAllocationType(state, id, type) {
  const allocation = getAllocation(state, id);
  if (!allocation.alive) throw new Error('expired objects are read-only');
  checkAddressCapacity(type, state.structTypes);
  const replacement = {
    ...allocation,
    type: structuredClone(type),
    value: makeDefaultValue(type, state.structTypes),
  };
  const candidate = {
    ...state,
    allocations: state.allocations.map(a => (a.id === id ? replacement : a)),
  };
  let moved = 0;
  for (const a of state.allocations) {
    if (a.id === id) continue;
    for (const scalar of scalarSubobjects(a, state)) {
      if (scalar.value.kind !== 'pointer' || scalar.value.target?.allocationId !== id) continue;
      const label = resolveRef(state, scalar.ref).label;
      let next;
      try {
        next = referenceLocation(candidate, scalar.value.target);
        if (!typeEquals(scalar.type.to, next.type)) throw new Error('incompatible pointee type');
      } catch (e) {
        throw new Error(
          `Cannot change type: ${label} would have an invalid target (${e.message}). Retarget it first.`,
        );
      }
      const before = referenceLocation(state, scalar.value.target);
      const changed =
        before.address !== next.address ||
        pointerStatus(state, scalar.value) !== pointerStatus(candidate, scalar.value) ||
        !typeEquals(before.type, next.type);
      if (!a.alive && changed)
        throw new Error(`Cannot change type: the historical pointer ${label} would change.`);
      if (changed) moved++;
    }
  }
  Object.assign(allocation, replacement);
  return moved;
}

/**
 * Remove a returned call and its locals from the diagram. A pointer into it had no usable
 * value left (C23 6.2.4p2), so each becomes uninitialized, wherever it is stored. Returns
 * how many pointers changed.
 */
export function removeReturnedFrame(state, frameId) {
  const frame = state.frames.find(f => f.id === frameId);
  if (!frame) throw new Error(`there is no call frame '${frameId}'`);
  if (frame.active) throw new Error('only a call that has returned can be removed');
  const gone = new Set(frameAllocations(state, frameId).map(a => a.id));
  let cleared = 0;
  for (const a of state.allocations) {
    if (gone.has(a.id)) continue;
    for (const scalar of scalarSubobjects(a, state)) {
      if (scalar.value.kind !== 'pointer' || !gone.has(scalar.value.target.allocationId)) continue;
      // Written directly: the pointer may itself be out of scope, which setRefValue refuses.
      const { container, key } = resolveRef(state, scalar.ref);
      if (container) container[key] = { kind: 'uninit' };
      else a.value = { kind: 'uninit' };
      cleared++;
    }
  }
  state.allocations = state.allocations.filter(a => !gone.has(a.id));
  state.frames = state.frames.filter(f => f.id !== frameId);
  // Calls it made have returned too; they now hang from its caller.
  for (const f of state.frames) if (f.callerId === frameId) f.callerId = frame.callerId;
  return cleared;
}

export function removeAllocation(state, id) {
  const removed = getAllocation(state, id);
  // A freed heap block is a diagram choice that can be undone; an expired local belongs to its frame.
  if (!removed.alive && removed.storage.kind !== 'heap')
    throw new Error('expired objects are read-only');
  const incoming = [];
  for (const a of state.allocations) {
    if (a.id === id) continue;
    for (const scalar of scalarSubobjects(a, state))
      if (scalar.value.kind === 'pointer' && scalar.value.target?.allocationId === id) {
        if (!a.alive)
          throw new Error(
            `Cannot delete this object: historical pointer ${resolveRef(state, scalar.ref).label} still references it.`,
          );
        incoming.push(scalar.ref);
      }
  }
  for (const source of incoming) setRefValue(state, source, { kind: 'uninit' });
  state.allocations = state.allocations.filter(a => a.id !== id);
  // Address and identity cursors intentionally do not rewind.
}
