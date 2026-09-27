/** Simulated address placement. References retain allocation/subobject provenance. */
import { isArray, isStruct, layoutOf, sizeOf, validateObjectType } from '../language/types.js';

export const ADDRESS_PROFILE = 'pointerviz-lp64-sparse-v1';
export const RESERVATION_BYTES = 0x10000;
export const ADDRESS_REGIONS = Object.freeze({
  stack: Object.freeze({ start: 0x10000000, end: 0x70000000, cursor: 'nextStackSlot' }),
  heap: Object.freeze({ start: 0x80000000, end: 0xe0000000, cursor: 'nextHeapSlot' }),
});
export const makeAddressSpace = () => ({ version: 1, profile: ADDRESS_PROFILE, nextStackSlot: 0, nextHeapSlot: 0 });

function checkProfile(space) {
  if (space?.version !== 1 || space.profile !== ADDRESS_PROFILE) throw new Error('unsupported or missing simulated address profile');
  for (const region of Object.values(ADDRESS_REGIONS)) {
    const slot = space[region.cursor];
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > (region.end - region.start) / RESERVATION_BYTES) throw new Error('invalid simulated address cursor');
  }
}

export function checkAddressCapacity(type, structs = {}) {
  validateObjectType(type, structs);
  const size = sizeOf(type, structs);
  if (!Number.isSafeInteger(size) || size < 1 || size + 1 > RESERVATION_BYTES) throw new Error('object exceeds simulated address reservation');
  return size;
}

/** Pure proposal: callers commit the cursor only after all creation checks pass. */
export function nextAddress(space, storage, type, structs = {}) {
  checkProfile(space);
  checkAddressCapacity(type, structs);
  const region = ADDRESS_REGIONS[storage?.kind];
  if (!region) throw new Error('invalid allocation storage');
  const baseAddress = region.start + space[region.cursor] * RESERVATION_BYTES;
  if (baseAddress >= region.end) throw new Error(`simulated ${storage.kind} address space exhausted`);
  return { baseAddress, addressSpace: { ...space, [region.cursor]: space[region.cursor] + 1 } };
}

export function validateAddressSpace(state) {
  checkProfile(state.addressSpace);
  const bases = new Set();
  for (const a of state.allocations) {
    checkAddressCapacity(a.type, state.structTypes);
    const region = ADDRESS_REGIONS[a.storage?.kind], base = a.baseAddress;
    if (!region || !Number.isSafeInteger(base) || base < region.start || base >= region.end || (base - region.start) % RESERVATION_BYTES !== 0) throw new Error(`invalid base address for allocation ${a.id}`);
    if (bases.has(base)) throw new Error('duplicate simulated address reservation');
    bases.add(base);
    if ((base - region.start) / RESERVATION_BYTES >= state.addressSpace[region.cursor]) throw new Error('simulated address cursor precedes an allocation');
  }
  return state;
}

/** Normalize legacy internal states once, without mutating the supplied state. */
export function upgradeMemoryState(state) {
  const next = structuredClone(state);
  if (next.addressSpace != null) { validateAddressSpace(next); return next; }
  if (next.allocations.some(a => a.baseAddress !== undefined)) throw new Error('mixed legacy and versioned address metadata');
  next.addressSpace = makeAddressSpace();
  for (const a of next.allocations) {
    const reserved = nextAddress(next.addressSpace, a.storage, a.type, next.structTypes);
    a.baseAddress = reserved.baseAddress;
    next.addressSpace = reserved.addressSpace;
  }
  return next;
}

/** Validate paths independently of object values, including terminal one-past. */
export function referenceOffset(state, target) {
  if (!target || !Array.isArray(target.path ?? [])) throw new Error('invalid reference path');
  const allocation = state.allocations.find(a => a.id === target.allocationId);
  if (!allocation) throw new Error(`invalid reference to missing allocation ${target.allocationId}`);
  const path = target.path ?? [];
  let type = allocation.type, offset = 0, onePast = false;
  for (let i = 0; i < path.length; i++) {
    const part = path[i], terminal = i === path.length - 1;
    if (part === '$onePast') {
      if (!terminal) throw new Error('cannot continue through a one-past reference');
      offset += sizeOf(type, state.structTypes); onePast = true;
    } else if (isArray(type)) {
      if (!Number.isInteger(part) || part < 0 || part > type.length || (part === type.length && !terminal)) throw new Error('reference outside array bounds');
      onePast = part === type.length;
      offset += part * sizeOf(type.of, state.structTypes); type = type.of;
    } else if (isStruct(type)) {
      const member = layoutOf(type, state.structTypes).fields.find(f => f.name === part);
      if (!member) throw new Error(`struct ${type.name} has no field '${part}'`);
      offset += member.offset; type = member.type;
    } else throw new Error('invalid subobject path');
  }
  return { allocation, type, offset, onePast };
}
export const addressOffset = (state, target) => referenceOffset(state, target).offset;

export function referenceLocation(state, target) {
  const result = referenceOffset(state, target);
  const baseAddress = result.allocation.baseAddress;
  if (!Number.isSafeInteger(baseAddress)) throw new Error('allocation has no simulated address');
  return { ...result, baseAddress, address: baseAddress + result.offset };
}
