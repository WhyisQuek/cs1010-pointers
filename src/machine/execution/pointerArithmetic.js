/** Pointer offsets are only defined within one array (or one object as a one-element array). */
import { INVALID, UNDEFINED, UNSUPPORTED } from '../../language/diagnostics.js';
import {
  isArray,
  isStruct,
  pointer,
  resolveStructType,
  sizeOf,
  typeToString,
} from '../../language/types.js';
import { referenceOffset } from '../addresses.js';
import { getAllocation, pointerValue, ref } from '../memory.js';
import { semanticError } from './runtime.js';

/** `pointeeType` is the type the pointer is declared to point to; one step moves its size. */
export function addToPointer(state, value, delta, node, pointeeType) {
  // A 64-bit offset beyond 2^53 is stored as a BigInt; it lies far outside any object.
  if (typeof delta === 'bigint')
    throw semanticError(node, `pointer arithmetic moves outside allocation bounds`, UNDEFINED);
  if (!Number.isSafeInteger(delta))
    throw semanticError(node, 'pointer offset must be an integer', INVALID);
  if (!getAllocation(state, value.target.allocationId).alive)
    throw semanticError(
      node,
      'pointer arithmetic on an object whose lifetime has ended',
      UNDEFINED,
    );
  const pos = arrayPosition(state, value.target);
  if (!pos) {
    if (delta === 0) return structuredClone(value);
    throw semanticError(
      node,
      'pointer arithmetic is only supported within arrays/malloc blocks',
      UNDEFINED,
    );
  }
  if (delta !== 0) requireElementStride(state, pos, pointeeType, node);
  const next = pos.index + delta;
  if (next < 0 || next > pos.length)
    throw semanticError(
      node,
      `pointer arithmetic moves outside allocation bounds (index ${next})`,
      UNDEFINED,
    );
  return pointerValue(
    ref(
      pos.allocationId,
      pos.singleton
        ? next === 0
          ? pos.prefix
          : [...pos.prefix, '$onePast']
        : [...pos.prefix, next],
    ),
  );
}

/**
 * Positions count whole elements of the array (or the whole object) a pointer is in. A pointer
 * converted through void * can have a different pointee type, such as a char * to an int; its
 * steps would be bytes, and byte-level views are not modeled (see requireAccessType).
 */
export function requireElementStride(state, pos, pointeeType, node) {
  const at = referenceOffset(state, ref(pos.allocationId, pos.prefix)).type;
  const element = pos.singleton ? at : at.of;
  if (sizeOf(element, state.structTypes) !== sizeOf(pointeeType, state.structTypes))
    throw semanticError(
      node,
      `${typeToString(pointer(pointeeType))} arithmetic on ${typeToString(element)} is not modeled (the pointer type does not match the object it points into)`,
      UNSUPPORTED,
    );
}

/** Find the nearest array component in a reference path, including arrays inside structs. */
export function arrayPosition(state, targetRef) {
  const allocation = getAllocation(state, targetRef.allocationId);
  let type = allocation.type;
  const path = targetRef.path ?? [],
    prefix = [];
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    if (isArray(type) && Number.isInteger(part)) {
      if (i === path.length - 1)
        return {
          allocationId: allocation.id,
          prefix: [...prefix],
          index: part,
          length: type.length,
        };
      if (part < 0 || part >= type.length) return null;
      type = type.of;
      prefix.push(part);
      continue;
    }
    if (part === '$onePast' && i === path.length - 1)
      return { allocationId: allocation.id, prefix, index: 1, length: 1, singleton: true };
    if (isStruct(type)) {
      const def = resolveStructType(type, state.structTypes),
        field = def.fields.find(f => f.name === part);
      if (!field) return null;
      type = field.type;
      prefix.push(part);
      continue;
    }
    return null;
  }
  return { allocationId: allocation.id, prefix, index: 0, length: 1, singleton: true };
}
