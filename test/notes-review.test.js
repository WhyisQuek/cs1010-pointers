/** Regression cases for findings fixed from the October 2026 review (docs/NOTES_REVIEW_2026-10.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { equivalent } from '../src/pipeline/equivalence.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});
const main = body => `int main(void) { ${body} }`;
const compare = (expected, actual) => {
  const start = performance.now();
  const result = equivalent(interpret(expected).state, interpret(actual).state);
  return { ...result, ms: performance.now() - start };
};
// Before the fix, 9 such blocks took about 3 s and each extra block multiplied that by ten.
const FAST_MS = 2000;

// #10: every snapshot copies all of memory, including expired loop locals.
test('execution history has a total size limit, with playback up to it', () => {
  assert.throws(
    () => interpret(main('for (int i = 0; i < 120; i++) { int a[64][64]; }')),
    e => /execution history exceeded/.test(e.message) && e.playback.snapshots.length > 1,
  );
});

test('one largest object can stay in memory over a long trace', () => {
  const { snapshots } = interpret(main('int a[64][64]; for (int i = 0; i < 64; i++) a[i][0] = i;'));
  assert.ok(snapshots.length > 100);
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
