/**
 * Compatibility/re-export facade. The canonical IR now lives in machine/memory.
 * Keeping this module avoids needless churn in UI imports while the internals
 * use allocations + subobjects instead of one-cell-per-variable.
 */
export * from '../machine/memory.js';
export { typeToString as typeToC } from '../language/types.js';
