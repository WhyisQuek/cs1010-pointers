import { encodeCharLiteral } from '../language/literals.js';
import { isArray, isStruct, resolveStructType, typeToString } from '../language/types.js';
import { referenceLocation } from '../machine/addresses.js';
import { pointerStatus, resolveRef } from '../machine/memory.js';

export function formatAddress(address, full = false) {
  return Number.isSafeInteger(address) && address >= 0
    ? `0x${address.toString(16).padStart(full ? 16 : 8, '0')}`
    : 'unavailable';
}
/** `f()`, plus the frame id only when another frame has the same function name (recursion). */
export function frameLabel(state, frameId) {
  const frame = state.frames?.find(f => f.id === frameId),
    name = frame?.name ?? 'main';
  const shared = (state.frames ?? []).filter(f => (f.name ?? 'main') === name).length > 1;
  return shared ? `${name}() [${frameId}]` : `${name}()`;
}
export function qualifiedLabel(state, target) {
  const resolved = resolveRef(state, target),
    a = resolved.allocation;
  if (a.storage.kind !== 'stack') return resolved.label;
  return `${frameLabel(state, a.storage.frameId)} · ${resolved.label}`;
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
/** Why a dangling pointer's target is gone: `freed` for heap blocks, `out of scope` for locals. */
export function lifetimeNote(description) {
  return description.allocation?.storage.kind === 'heap' ? 'freed' : 'out of scope';
}
/** The short line under a pointer: `→ x`, `→ heap 1 (freed)`, `→ no target`. */
export function pointerCaption(description) {
  const { status, label } = description;
  if (status === 'valid' || status === 'one-past') return `→ ${label}`;
  if (status === 'dangling') return `→ ${label} (${lifetimeNote(description)})`;
  if (status === 'null') return '→ no target';
  if (status === 'uninitialized') return '→ none yet';
  return label;
}
/**
 * Bool objects store 0/1 but read as the <stdbool.h> constants. Chars show their number, or
 * with chars = 'character' the character constant it encodes ('a', '\0').
 */
export function scalarText(type, value, chars = 'number') {
  if (type?.kind !== 'primitive') return String(value);
  if (type.name === 'bool') return value ? 'true' : 'false';
  if (type.name === 'char' && chars === 'character') return encodeCharLiteral(value);
  return String(value);
}
// Elements shown before an array literal is cut off with "…".
const MAX_LISTED_ELEMENTS = 8;
/** C initializer-style text such as `{ 1, 2, ? }` or `{ .x = 1, .next = NULL }`; `?` is uninitialized. */
function aggregateText(state, type, value, depth, chars) {
  if (isArray(type) || isStruct(type)) {
    if (value?.kind !== 'aggregate') return '?';
    if (depth > 1) return '{ … }';
    const parts = isArray(type)
      ? value.elements
          .slice(0, MAX_LISTED_ELEMENTS)
          .map(v => aggregateText(state, type.of, v, depth + 1, chars))
          .concat(value.elements.length > MAX_LISTED_ELEMENTS ? ['…'] : [])
      : resolveStructType(type, state.structTypes).fields.map(
          f =>
            `.${f.name} = ${aggregateText(state, f.type, value.fields[f.name], depth + 1, chars)}`,
        );
    return `{ ${parts.join(', ')} }`;
  }
  if (value?.kind === 'pointer') return formatAddress(describePointer(state, value).address);
  if (value?.kind === 'scalar') return scalarText(type, value.value, chars);
  return value?.kind === 'null' ? 'NULL' : '?';
}
export function valueSummary(state, type, value, chars = 'number') {
  if (isArray(type) || isStruct(type)) return aggregateText(state, type, value, 0, chars);
  if (value?.kind === 'pointer') {
    const d = describePointer(state, value);
    return `${formatAddress(d.address)} · ${pointerCaption(d)}`;
  }
  return value?.kind === 'scalar'
    ? scalarText(type, value.value, chars)
    : value?.kind === 'null'
      ? 'NULL'
      : 'uninitialized';
}
export function pointerAccessibleLabel(state, scalar) {
  const own = referenceLocation(state, scalar.ref),
    d = describePointer(state, scalar.value);
  return `${resolveRef(state, scalar.ref).label}, ${typeToString(scalar.type)}, stored at ${formatAddress(own.address)}, ${d.status}, stores ${d.address === undefined ? 'unknown address' : formatAddress(d.address)}, ${d.qualifiedLabel ?? d.label}`;
}
