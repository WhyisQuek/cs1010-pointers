/** Safety limits for the browser teaching machine. Keep these small and explicit. */
export const MAX_ARRAY_LENGTH = 64;
export const MAX_HEAP_ELEMENTS = 64;
/** Bytes one malloc call may request; the block is typed later (at most MAX_HEAP_ELEMENTS). */
export const MAX_HEAP_BYTES = 16384;
export const MAX_STRUCT_FIELDS = 32;
export const MAX_CALL_DEPTH = 32;
export const MAX_LOOP_ITERATIONS = 256;
export const MAX_TRACE_STEPS = 500;
export const MAX_OBJECT_SCALARS = 4096;
/**
 * Scalars held across all execution snapshots, since each step keeps a copy of memory. Room for
 * one largest object over the longest trace; without it, a loop declaring a large array retains
 * every expired copy and the history grows quadratically.
 */
export const MAX_HISTORY_SCALARS = MAX_OBJECT_SCALARS * MAX_TRACE_STEPS;
export const MAX_OUTPUT_CHARS = 10000;

export function clampArrayLength(value) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 1;
  return Math.min(MAX_ARRAY_LENGTH, Math.max(1, n));
}
