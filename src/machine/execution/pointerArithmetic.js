/** Pointer offsets are only defined within one array (or one object as a one-element array). */
import { isArray, isStruct, resolveStructType } from '../../language/types.js';
import { getAllocation, pointerValue, ref } from '../memory.js';
import { semanticError } from './runtime.js';

export function addToPointer(state, value, delta, node) {
  if (!Number.isSafeInteger(delta)) throw semanticError(node, 'pointer offset must be an integer');
  if (!getAllocation(state, value.target.allocationId).alive)
    throw semanticError(node, 'pointer arithmetic on an object whose lifetime has ended');
  const pos = arrayPosition(state, value.target);
  if (!pos) {
    if (delta === 0) return structuredClone(value);
    throw semanticError(node, 'pointer arithmetic is only supported within arrays/malloc blocks');
  }
  const next = pos.index + delta;
  if (next < 0 || next > pos.length)
    throw semanticError(node, `pointer arithmetic moves outside allocation bounds (index ${next})`);
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
