/** Regression cases for findings fixed from the October 2026 review (docs/NOTES_REVIEW_2026-10.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { generate } from '../src/pipeline/codegen.js';
import { UNDEFINED, UNSUPPORTED } from '../src/language/diagnostics.js';
import { snapshot } from '../src/machine/execution/runtime.js';
import { array, primitive } from '../src/language/types.js';
import { addAllocation, makeState, ref, setRefValue } from '../src/machine/memory.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});
const main = body => `int main(void) { ${body} }`;
const fails = (source, pattern) => assert.throws(() => interpret(source), pattern);
const result = (source, name = 'result') =>
  interpret(source).state.allocations.find(a => a.name === name).value.value;
const compare = (expected, actual) => {
  const start = performance.now();
  const result = equivalent(interpret(expected).state, interpret(actual).state);
  return { ...result, ms: performance.now() - start };
};
// Before the fix, 9 such blocks took about 3 s and each extra block multiplied that by ten.
const FAST_MS = 2000;

// #10: every snapshot copied all of memory, including expired loop locals.
test('snapshots share objects that did not change, so expired loop locals are kept once', () => {
  const start = performance.now();
  const { snapshots } = interpret(main('for (int i = 0; i < 120; i++) { int a[64][64]; }'));
  assert.ok(performance.now() - start < 5000);
  const last = snapshots.at(-1).state.allocations,
    earlier = snapshots.at(-20).state.allocations;
  const expired = last.find(a => a.name === 'a' && !a.alive);
  assert.equal(
    earlier.find(a => a.id === expired.id),
    expired,
  );
});

test('shared snapshots still show each step as it was', () => {
  const { snapshots } = interpret(main('int x = 1; int y = 5; x = 2; x = 3;'));
  const values = snapshots.map(s => s.state.allocations.find(a => a.name === 'x')?.value);
  assert.deepEqual(
    values.filter(v => v?.kind === 'scalar').map(v => v.value),
    [1, 1, 2, 3],
  );
  const ys = snapshots.map(s => s.state.allocations.find(a => a.name === 'y')).filter(Boolean);
  assert.ok(ys.length > 1 && ys.every(y => y === ys[0]));
});

test('execution history has a total size limit on the memory it copies', () => {
  const state = makeState();
  const big = array(array(primitive('int'), 64), 64);
  const ids = [0, 1].map(() => addAllocation(state, { name: 'a', type: big }).id);
  const ctx = {
    state,
    snapshots: [],
    trace: [],
    steps: 0,
    historyScalars: 0,
    snapshotTraceIndex: 0,
  };
  const frame = { id: 'main', name: 'main', depth: 0 };
  // Two whole 4096-scalar arrays change at every step, so the limit comes before 500 steps.
  assert.throws(() => {
    for (let i = 0; ; i++) {
      for (const id of ids) setRefValue(state, ref(id, [0, 0]), { kind: 'scalar', value: i });
      snapshot(ctx, { kind: 'Test' }, frame);
    }
  }, /execution history exceeded/);
  assert.ok(ctx.snapshots.length > 200 && ctx.snapshots.length < 500);
});

// #9: heap matching searched every permutation of similar blocks.
const leaked = (n, value) =>
  main(`for (int i = 0; i < ${n}; i++) { int *p = malloc(sizeof(int)); *p = ${value}; }`);

test('identical leaked heap blocks compare quickly', () => {
  const result = compare(leaked(12, 1), leaked(12, 1));
  assert.equal(result.equal, true);
  assert.ok(result.ms < FAST_MS, `${result.ms} ms`);
});

test('a wrong answer with many similar blocks still gets specific feedback', () => {
  for (const [expected, actual] of [
    [leaked(12, 1), leaked(12, 2)],
    [leaked(12, 'i'), leaked(12, 'i + 100')],
  ]) {
    const result = compare(expected, actual);
    assert.equal(result.equal, false);
    assert.match(result.diffs[0], /has the wrong value/);
    assert.ok(result.ms < FAST_MS, `${result.ms} ms`);
  }
});

test('blocks a graded pointer refers to are never treated as interchangeable', () => {
  const build = order =>
    main(
      `int *p = malloc(sizeof(int)); *p = ${order[0]}; int *q = malloc(sizeof(int)); *q = ${order[1]};`,
    );
  assert.equal(compare(build([1, 1]), build([1, 1])).equal, true);
  assert.deepEqual(compare(build([1, 2]), build([2, 1])).diffs, [
    "'heap 1' has the wrong value",
    "'heap 2' has the wrong value",
  ]);
});

test('pointers filled in a different order still match', () => {
  const fill = reversed => {
    const slot = reversed ? '11 - i' : 'i';
    return main(
      `int *ps[12]; for (int i = 0; i < 12; i++) { ps[${slot}] = malloc(sizeof(int)); *ps[${slot}] = 1; }`,
    );
  };
  const result = compare(fill(false), fill(true));
  assert.equal(result.equal, true);
  assert.ok(result.ms < FAST_MS, `${result.ms} ms`);
});

// Leaked nodes in `rings` cycles: every node looks alike, so only the structure differs.
const rings = (n, count) => `struct N { int v; struct N *next; };
int main(void) {
  struct N *first = NULL; struct N *prev = NULL;
  for (int i = 0; i < ${n}; i++) {
    struct N *x = malloc(sizeof(struct N)); x->v = 1; x->next = NULL;
    if (i % ${n / count} == 0) { if (prev != NULL) prev->next = first; first = x; } else prev->next = x;
    prev = x;
  }
  prev->next = first;
}`;

test('heap structure differences are found among identical nodes', () => {
  assert.equal(compare(rings(12, 1), rings(12, 1)).equal, true);
  assert.match(compare(rings(12, 1), rings(12, 2)).diffs[0], /points to the wrong place/);
});

test('a search that cannot finish says so instead of reporting a guessed mismatch', () => {
  const result = compare(rings(12, 2), rings(12, 4));
  assert.equal(result.equal, false);
  assert.deepEqual(result.diffs, [
    'PointerViz could not finish comparing your memory: it has too many similar heap blocks',
  ]);
  assert.ok(result.ms < FAST_MS, `${result.ms} ms`);
});

// #1: a char * from void * stepped over the whole int object it pointed at.
test('arithmetic through a pointer that does not match its object is not modeled', () => {
  const view = 'int a[2] = {0}; void *v = a; char *p = v;';
  fails(main(`${view} char *q = p + 1;`), /not modeled/);
  fails(main('int x = 0; void *v = &x; char *p = v; p++;'), /not modeled/);
  fails(main(`${view} char c = p[1];`), /not modeled/);
  assert.equal(result(main(`${view} char *q = v; long result = p - q;`)), 0);
  assert.equal(result(main('int a[2] = {0}; int *p = a; long result = (p + 1) - p;')), 1);
});

// #3: void * normalised a one-past pointer to the start of the next row.
test('a one-past pointer stays one past its row through void *', () => {
  const view = 'int a[2][2] = {{1, 2}, {3, 4}}; int *p = a[0] + 2; void *v = p; int *q = v;';
  fails(main(`${view} int result = *q;`), /bounds/);
  assert.equal(result(main(`${view} int result = *(q - 1);`)), 2);
  assert.equal(
    result(main('int a[2][2] = {{1, 2}, {3, 4}}; void *v = a[1]; int *q = v; int result = *q;')),
    3,
  );
});

// #4: free exempted every read while computing its argument from dangling-pointer checks.
test('only the pointer passed to free may be dangling', () => {
  const freed = 'int *p = malloc(sizeof(int)); free(p);';
  fails(
    `int *ignore(int *p) { return NULL; }\nint main(void) { ${freed} free(ignore(p)); }`,
    /dangling/,
  );
  fails(
    `int *f(int *p) { int *q = p; return NULL; }\nint main(void) { ${freed} free(f(p)); }`,
    /dangling/,
  );
  fails(main(`${freed} free(p);`), /double free/);
  fails(
    main('int **pp = malloc(sizeof(int *)); *pp = malloc(sizeof(int)); free(*pp); free(*pp);'),
    /double free/,
  );
  interpret(main('free(NULL); free(0);'));
});

// #5: malloc left its argument's side effects pending after the call.
test("malloc's argument side effects finish before the call", () => {
  assert.equal(result(main('int i = 0; i = malloc(i++) != NULL;'), 'i'), 0);
  interpret(
    main(
      'int *a[2]; a[0] = malloc(sizeof(int)); a[1] = malloc(sizeof(int)); int i = 0; free(a[i++]); free(a[i]);',
    ),
  );
});

// #6: generated C printed -0.0 as 0.0.
test('generated C keeps the sign of a negative zero', () => {
  const code = generate(interpret(main('double x = -0.0; float f = -0.0f; int z = -0;')).state);
  assert.match(code, /x = -0\.0;/);
  assert.match(code, /f = -0\.0f;/);
  assert.match(code, /z = 0;/);
  const { output } = interpret(code.replace('return 0;', 'printf("%f", x); return 0;'));
  assert.equal(output, '-0.000000');
});

// #2: typing a block at its first conversion rejected valid C as undefined behavior.
test('another type using a block typed only by conversion is not supported, not undefined', () => {
  const block = 'void *v = malloc(sizeof(double)); int *p = v; double *q = v;';
  assert.throws(
    () => interpret(main(`${block} *q = 3.0;`)),
    e => /was given the type int \[2\].*not modeled/.test(e.message) && e.kind === UNSUPPORTED,
  );
  // After a store the block really does hold an int, so reading it as double is undefined.
  assert.throws(
    () => interpret(main(`${block} *p = 1; double d = *q;`)),
    e => /through a double lvalue/.test(e.message) && e.kind === UNDEFINED,
  );
});
