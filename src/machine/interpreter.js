/**
 * PointerViz Mini-C semantic interpreter: the public entry point.
 *
 * Functions use explicit call frames; blocks and for-loops use lexical scopes.
 * if/while/for execute directly from the Mini-C AST and loops are bounded for
 * browser safety. Structs remain regular aggregate allocations with subobjects.
 * Executed statements emit trace events and snapshots for step-through playback.
 *
 * The implementation lives in ./execution/, one module per concern:
 *   calls.js             function calls, call frames, malloc/free
 *   statements.js        statements, declarations and initializers
 *   expressions.js       expression evaluation
 *   lvalues.js           object designation, loads, stores and conversions
 *   operators.js         arithmetic, comparison, logical operators, sequencing
 *   pointerArithmetic.js pointer offsets within arrays
 *   typeInference.js     static expression types without evaluation
 *   runtime.js           scopes, trace/snapshot recording, runtime checks
 */
import { checkProgram } from '../language/checker.js';
import { INT } from '../language/types.js';
import { callFunction } from './execution/calls.js';
import { makeState } from './memory.js';

export function executeProgram(program) {
  const normalized = normalizeProgram(program);
  checkProgram(normalized);
  const structTypes = Object.fromEntries(
    (normalized.structs ?? []).map(s => [s.name, structuredClone(s)]),
  );
  const state = makeState(structTypes);
  const ctx = {
    state,
    functions: new Map(normalized.functions.map(fn => [fn.name, fn])),
    snapshots: [],
    trace: [],
    callDepth: 0,
    steps: 0,
    snapshotTraceIndex: 0,
    accesses: [],
  };
  if (!ctx.functions.has('main')) throw new Error('no main() function found');
  callFunction(ctx, ctx.functions.get('main'), [], null, true);
  return { state, snapshots: ctx.snapshots, trace: ctx.trace, ast: normalized };
}

function normalizeProgram(program) {
  if (program.functions) return program;
  // Backward-compatible shape used by parser-independent tests.
  return {
    kind: 'Program',
    structs: program.structs ?? [],
    functions: [
      {
        kind: 'FunctionDefinition',
        name: program.function ?? 'main',
        returnType: INT,
        params: [],
        statements: program.statements ?? [],
      },
    ],
  };
}
