/** Safety limits for the browser teaching machine. Keep these small and explicit. */
export const MAX_ARRAY_LENGTH = 64;
export const MAX_HEAP_ELEMENTS = 64;
export const MAX_STRUCT_FIELDS = 32;
export const MAX_CALL_DEPTH = 32;
export const MAX_LOOP_ITERATIONS = 256;
export const MAX_TRACE_STEPS = 500;

export function clampArrayLength(value) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 1;
  return Math.min(MAX_ARRAY_LENGTH, Math.max(1, n));
}
