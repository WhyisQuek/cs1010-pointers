/**
 * Full integration suite using real Tree-sitter parsing.
 * Verifies C → MemoryState → generated C → MemoryState round-trip equivalence,
 * plus execution-only function, control-flow, safety-limit and grading cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { resolveRef } from '../src/machine/memory.js';

const programs = [
  'int main() { int a = 10; int *b = &a; }',
  'int main() { int x = 1; int y = 2; int *p = &x; p = &y; *p = 99; }',
  'int main() { int a = 5; int *p = &a; int **pp = &p; **pp = 6; }',
  'int main() { int *p = malloc(sizeof(int)); *p = 42; int *q = p; }',
  'int main() { int *p = NULL; int *q; int v = 3; q = &v; }',
  'int main() { int **h = malloc(sizeof(int *)); *h = malloc(sizeof(int)); **h = 7; }',
  'int main() { int *p = malloc(sizeof(int)); int *q = p; free(p); }',
  'int main() { int arr[3] = {1, 2, 3}; int *p = &arr[1]; }',
  'int main() { int arr[3] = {1, 2, 3}; int *p = arr; p++; }',
  'int main() { int *p = malloc(3 * sizeof(int)); p[0] = 4; p[1] = 5; p[2] = 6; }',
  'int main() { int *p = NULL; free(p); }',
  'struct Node { int value; struct Node *next; }; int main(void) { struct Node a = {1, NULL}; struct Node b = {2, &a}; return 0; }',
  'int main(void) { int x = 0; if (2 < 3) { x = 7; } else { x = 9; } return 0; }',
  'int main(void) { int i = 0; int sum = 0; while (i < 4) { sum += i; i++; } return 0; }',
  'int main(void) { int i = 0; int sum = 0; for (i = 0; i < 4; i++) { sum += i; } return 0; }',
];

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const named = (state, name) => state.allocations.find(a => a.name === name);

for (const source of programs) {
  test(`round trip: ${source.slice(0, 76)}`, () => {
    const before = interpret(source).state;
    const generated = generate(before);
    const result = equivalent(before, interpret(generated).state);
    assert.ok(result.equal, `${result.diffs.join('; ')}\n${generated}`);
  });
}

// Function integration is execution-only because a final call-stack trace does not
// contain enough source information to synthesize the original function bodies.
test('user function parsing, call frame, and pointer side effect', () => {
  const result = interpret(
    'void set_value(int *p) { *p = 25; } int main(void) { int value = 10; set_value(&value); return 0; }',
  );
  const frame = result.state.frames.find(f => f.name === 'set_value');
  assert.equal(named(result.state, 'value').value.value, 25);
  assert.ok(frame && !frame.active);
  assert.ok(result.snapshots.some(s => s.function === 'set_value'));
});

test('parsed for/if/break/continue semantics', () => {
  const result = interpret(`int main(void) {
    int sum = 0;
    for (int i = 0; i < 8; i++) {
      if (i == 2) continue;
      if (i == 5) break;
      sum += i;
    }
    return 0;
  }`);
  assert.equal(named(result.state, 'sum').value.value, 8);
  assert.equal(named(result.state, 'i').alive, false);
  assert.ok(result.snapshots.some(s => s.statement === 'ForUpdate'));
});

test('logical conditions short-circuit during parsed execution', () => {
  const result = interpret(`int main(void) {
    int *p = NULL;
    int x = 0;
    if (p && *p) x = 1;
    if (!p || *p) x = 2;
    return 0;
  }`);
  assert.equal(named(result.state, 'x').value.value, 2);
});

test('loop iteration safety limit', () => {
  assert.throws(
    () => interpret('int main(void) { while (1) { } return 0; }'),
    /loop exceeded 256 iterations/,
  );
});

test('array safety limit', () => {
  assert.throws(() => interpret('int main(void) { int a[65]; return 0; }'), /between 1 and 64/);
});

// Grading must reject wrong target relationships, not merely wrong source text.
test('grading rejects wrong pointer graph', () => {
  const target = interpret('int main(){ int a = 10; int *b = &a; }').state;
  const wrong = interpret('int main(){ int a = 10; int c = 4; int *b = &c; }').state;
  const result = equivalent(target, wrong);
  assert.equal(result.equal, false);
  assert.ok(result.diffs.length);
});

test('pointer return types preserve depth, identity, null, and type checking', () => {
  const result = interpret(`
    int *(identity)(int *p) { return p; }
    int **identity2(int **p) { return p; }
    int *empty(void) { return NULL; }
    int main(void) {
      int x = 1;
      int *p = identity(&x);
      int **pp = identity2(&p);
      **pp = 42;
      int *nothing = empty();
    }
  `);
  const allocation = name => named(result.state, name);
  assert.equal(allocation('x').value.value, 42);
  assert.equal(allocation('p').value.target.allocationId, allocation('x').id);
  assert.equal(allocation('pp').value.target.allocationId, allocation('p').id);
  assert.equal(allocation('nothing').value.kind, 'null');
  assert.throws(
    () => interpret('int *bad(void) { return 7; } int main(void) { int *p = bad(); }'),
    /cannot assign int to int \*/,
  );
  assert.throws(
    () => interpret('int (*bad(void))(int) { return NULL; } int main(void) {}'),
    /function pointer declarators are not supported/,
  );
});

test('recursive struct pointer return reverses all four links and handles an empty list', () => {
  const result = interpret(`
    typedef struct Node { int value; struct Node *next; } Node;
    Node *reverse(Node *head) {
      if (!head || !head->next) return head;
      Node *next = head->next;
      Node *new_head = reverse(next);
      next->next = head;
      head->next = NULL;
      return new_head;
    }
    int main(void) {
      Node *a = malloc(sizeof(Node));
      Node *b = malloc(sizeof(Node));
      Node *c = malloc(sizeof(Node));
      Node *d = malloc(sizeof(Node));
      a->value = 10; a->next = b;
      b->value = 20; b->next = c;
      c->value = 30; c->next = d;
      d->value = 40; d->next = NULL;
      Node *newHead = reverse(a);
      Node *empty = reverse(NULL);
    }
  `);
  const allocation = name => named(result.state, name);
  let link = allocation('newHead').value;
  for (const [name, value] of [
    ['d', 40],
    ['c', 30],
    ['b', 20],
    ['a', 10],
  ]) {
    assert.deepEqual(link.target, allocation(name).value.target);
    const node = resolveRef(result.state, link.target).value;
    assert.equal(node.fields.value.value, value);
    link = node.fields.next;
  }
  assert.equal(link.kind, 'null');
  assert.equal(allocation('empty').value.kind, 'null');
  const frames = result.state.frames.filter(f => f.name === 'reverse');
  assert.equal(frames.length, 5);
  assert.ok(frames.every(f => !f.active));
});
