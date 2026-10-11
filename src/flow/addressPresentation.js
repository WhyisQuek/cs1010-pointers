import { isArray, isStruct, sizeOf, typeToString } from '../language/types.js';
import { referenceLocation } from '../machine/addresses.js';
import { pointerStatus, resolveRef } from '../machine/memory.js';

export function formatAddress(address, full = false) {
  return Number.isSafeInteger(address) && address >= 0
    ? `0x${address.toString(16).padStart(full ? 16 : 8, '0')}`
    : 'unavailable';
}
export function qualifiedLabel(state, target) {
  const resolved = resolveRef(state, target),
    a = resolved.allocation;
  if (a.storage.kind !== 'stack') return resolved.label;
  const frame = state.frames?.find(f => f.id === a.storage.frameId);
  return `${frame?.name ?? 'main'}() [${a.storage.frameId}] · ${resolved.label}`;
}
export function describePointer(state, value) {
  const status = pointerStatus(state, value);
  if (status === 'null') return { status, address: 0, label: 'No target' };
  if (status === 'uninitialized') return { status, label: 'No stored address yet' };
  if (status === 'not-pointer') return { status, label: '' };
  try {
    if (status === 'invalid') throw new Error('invalid reference');
    const location = referenceLocation(state, value.target),
      resolved = resolveRef(state, value.target);
    return {
      ...location,
      status,
      label: resolved.label,
      qualifiedLabel: qualifiedLabel(state, value.target),
      value: status === 'valid' ? resolved.value : null,
      target: value.target,
    };
  } catch (error) {
    return { status: 'invalid', label: 'Invalid reference', diagnostic: error.message };
  }
}
export function pointerCaption(description) {
  const { status, label } = description;
  if (status === 'valid') return `→ ${label}`;
  if (status === 'dangling') return `dangling · former target ${label}`;
  if (status === 'one-past') return `one-past · ${label}`;
  return label;
}
export function valueSummary(state, type, value) {
  if (isArray(type) || isStruct(type))
    return `${typeToString(type)} · ${sizeOf(type, state.structTypes)} bytes`;
  if (value?.kind === 'pointer') {
    const d = describePointer(state, value);
    return `${formatAddress(d.address)} · ${pointerCaption(d)}`;
  }
  return value?.kind === 'scalar'
    ? String(value.value)
    : value?.kind === 'null'
      ? 'NULL'
      : 'uninitialized';
}
export function pointerAccessibleLabel(state, scalar) {
  const own = referenceLocation(state, scalar.ref),
    d = describePointer(state, scalar.value);
  return `${resolveRef(state, scalar.ref).label}, ${typeToString(scalar.type)}, stored at ${formatAddress(own.address)}, ${d.status}, stores ${d.address === undefined ? 'unknown address' : formatAddress(d.address)}, ${d.qualifiedLabel ?? d.label}`;
}
