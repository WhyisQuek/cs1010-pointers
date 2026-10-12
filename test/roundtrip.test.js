/**
 * Full integration suite using real Tree-sitter parsing.
 * Verifies C → MemoryState → generated C → MemoryState round-trip equivalence,
 * plus execution-only function, control-flow, safety-limit and grading cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate, validate } from '../src/pipeline/codegen.js';
import { drawingIssues, equivalent } from '../src/pipeline/equivalence.js';
import {
  addAllocation,
  addFrame,
  makeState,
  ref,
  resolveRef,
  setRefValue,
} from '../src/machine/memory.js';
import { changeAllocationType } from '../src/machine/editing.js';
import { primitive } from '../src/language/types.js';
import { seedLevels } from '../src/data/levels.js';

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
  'int main(void) { bool b = true; bool c = false; bool *p = &b; size_t n = sizeof(int); size_t *q = &n; }',
  // Freed in child-first order; generated frees must not read a freed parent.
  'struct N { int v; struct N *next; }; int main(void) { struct N *head = malloc(sizeof(struct N)); head->v = 1; head->next = malloc(sizeof(struct N)); head->next->v = 2; head->next->next = NULL; free(head->next); free(head); return 0; }',
  // An interior pointer declared before the base pointer that allocates its block.
  'struct S { int x; int y; }; int main(void) { int *q; struct S *s = malloc(sizeof(struct S)); s->x = 1; s->y = 2; q = &s->y; return 0; }',
  // The same inside a heap block: the interior field comes before the base field.
  'struct P { int v; }; struct H { int *in; struct P *base; }; int main(void) { struct H *h = malloc(sizeof(struct H)); h->base = malloc(sizeof(struct P)); h->base->v = 3; h->in = &h->base->v; return 0; }',
  'struct S { bool flag; size_t count; }; int main(void) { struct S s = {true, 3}; size_t *p = malloc(sizeof(size_t)); *p = 9; }',
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

test('names reused by block and loop scopes are valid and gradable', () => {
  const programs = [
    // A variable declared in a loop body leaves one expired object per iteration.
    'int main(void) { int a[3] = {1, 2, 3}; for (int i = 0; i < 3; i++) { int t = a[i]; a[i] = t * 2; } return 0; }',
    // Two loops with the same loop variable.
    'int main(void) { int s = 0; for (int i = 0; i < 2; i++) s += i; for (int i = 0; i < 2; i++) s += i; return 0; }',
    // A live variable declared after an expired one of the same name.
    'int main(void) { { int t = 1; } int t = 2; return 0; }',
  ];
  for (const source of programs) {
    const state = interpret(source).state;
    assert.doesNotThrow(() => validate(state), source);
    // A student answer with the same code matches the reference.
    const result = equivalent(state, interpret(source).state);
    assert.ok(result.equal, `${source}\n${result.diffs.join('; ')}`);
  }
});

test('grading still tells same-named expired objects apart', () => {
  // Each iteration's t stays part of the answer because a pointer still refers to it.
  const loop = n =>
    `int main(void) { int *keep[2]; for (int i = 0; i < ${n}; i++) { int t = i; keep[i] = &t; } return 0; }`;
  const target = interpret(loop(2)).state;
  // One fewer iteration leaves one fewer referenced expired t.
  const fewer = interpret(loop(1)).state;
  const result = equivalent(target, fewer);
  assert.equal(result.equal, false);
  assert.ok(
    result.diffs.some(d => /Missing variable 't' \(out of scope, #2\)/.test(d)),
    result.diffs,
  );
});

test('out-of-scope objects nothing points to are not graded', () => {
  // Different loop temporaries and helper calls; the same memory the program can still reach.
  const target = interpret(`void set(int *p) { *p = 25; }
int main(void) { int value = 10; set(&value); int sum = 0; for (int i = 0; i < 3; i++) { int t = i; sum += t; } return 0; }`).state;
  const answer = interpret(
    'int main(void) { int value = 25; int sum = 0; for (int k = 0; k < 3; k++) sum += k; return 0; }',
  ).state;
  const result = equivalent(target, answer);
  assert.ok(result.equal, result.diffs.join('; '));
  // A live variable still has to match.
  const wrong = interpret('int main(void) { int value = 25; int sum = 2; return 0; }').state;
  assert.equal(equivalent(target, wrong).equal, false);
});

test('a dangling pointer keeps its out-of-scope target in the answer', () => {
  const target = interpret('int main(void) { int *p; { int x = 5; p = &x; } return 0; }').state;
  const nowhere = interpret('int main(void) { int *p; { int x = 5; } p = NULL; return 0; }').state;
  const result = equivalent(target, nowhere);
  assert.equal(result.equal, false);
  assert.ok(
    result.diffs.some(d => /Missing variable 'x' \(out of scope\)/.test(d)),
    result.diffs,
  );
});

test('every code-to-diagram seed level can be drawn in the diagram editor', () => {
  for (const level of seedLevels.filter(l => l.kind === 'code-to-diagram'))
    assert.deepEqual(drawingIssues(interpret(level.code).state), [], level.title);
});

test('answers the diagram editor cannot draw are reported', () => {
  const issues = source => drawingIssues(interpret(source).state).join('; ');
  assert.match(
    issues('int main(void) { int *p; { int x = 5; p = &x; } return 0; }'),
    /out-of-scope variable 'x'/,
  );
  assert.match(issues('int main(void) { char *s = "hi"; return 0; }'), /string literal/);
  // A two-dimensional array: the editor makes arrays of scalars, pointers and structs only.
  assert.match(issues('int main(void) { int m[2][3]; return 0; }'), /'m' of type /);
  // A literal nothing points to any more is not part of the answer.
  assert.equal(issues('int main(void) { char *s = "hi"; s = NULL; return 0; }'), '');
  // The editor's target picker cannot choose a one-past boundary.
  assert.match(
    issues('int main(void) { int a[2] = {1, 2}; int *end = a + 2; return 0; }'),
    /one-past-the-end pointer in 'end'/,
  );
  assert.match(issues('int main(void) { int x = 1; int *p = &x + 1; return 0; }'), /one-past/);
  assert.equal(issues('int main(void) { int a[2] = {1, 2}; int *p = a + 1; return 0; }'), '');
});

test('every seed level is accepted when answered with its own code', () => {
  for (const level of seedLevels) {
    const result = equivalent(interpret(level.code).state, interpret(level.code).state);
    assert.ok(result.equal, `${level.title}: ${result.diffs.join('; ')}`);
  }
});

test('seed levels reject the misconception each one targets', () => {
  const rejects = (id, wrong) => {
    const level = seedLevels.find(l => l.id === id);
    const result = equivalent(interpret(level.code).state, interpret(wrong).state);
    assert.equal(result.equal, false, `${level.title} accepted: ${wrong}`);
  };
  // Writing through a copy of the pointer changes main()'s variables.
  rejects('seed-swap', 'int main(void) { int a = 2; int b = 3; int c = 1; return 0; }');
  // alloc_wrong() "works", or its block is forgotten.
  rejects(
    'seed-out-param',
    'int main(void) { int *a = NULL; int *b = malloc(sizeof(int)); *b = 2; }',
  );
  // A leaked block left out.
  rejects('seed-leak', 'int main(void) { int *p = malloc(sizeof(int)); *p = 43; int *q = p; }');
  // A struct copy treated as a deep copy.
  rejects(
    'seed-shallow',
    `struct Box { int size; int *data; };
     int main(void) {
       struct Box a; a.size = 2; a.data = malloc(2 * sizeof(int)); a.data[0] = 7; a.data[1] = 8;
       struct Box b; b.size = 1; b.data = malloc(2 * sizeof(int)); b.data[0] = 70; b.data[1] = 8;
     }`,
  );
  // A block scope also leaves p dangling, but not into make_local()'s frame.
  rejects('seed-return-local', 'int main(void) { int *p; { int n = 5; p = &n; } return 0; }');
  // Unlinked but never freed.
  rejects(
    'seed-unlink',
    `typedef struct Node { int value; struct Node *next; } Node;
     int main(void) {
       Node *head = malloc(sizeof(Node)); head->value = 1;
       head->next = malloc(sizeof(Node)); head->next->value = 2;
       head->next->next = malloc(sizeof(Node)); head->next->next->value = 3;
       head->next->next->next = NULL;
       Node *doomed = head->next; head->next = doomed->next;
     }`,
  );
});

test('a struct answer built with the diagram editing operations matches seed 10', () => {
  const target = interpret(seedLevels.find(l => l.id === 'seed-10').code).state;
  // What the student canvas does: start from the level's struct types, add int boxes,
  // then change their type to the struct and fill in the fields.
  const answer = makeState(target.structTypes);
  addFrame(answer, { id: 'main', name: 'main' });
  const node = { kind: 'struct', name: 'Node' };
  const box = name => {
    const a = addAllocation(answer, { name, type: primitive('int') });
    changeAllocationType(answer, a.id, node);
    return a;
  };
  const a = box('a'),
    b = box('b');
  setRefValue(answer, ref(a.id, ['value']), { kind: 'scalar', value: 1 });
  setRefValue(answer, ref(a.id, ['next']), { kind: 'null' });
  setRefValue(answer, ref(b.id, ['value']), { kind: 'scalar', value: 2 });
  setRefValue(answer, ref(b.id, ['next']), { kind: 'pointer', target: ref(a.id) });
  const result = equivalent(target, answer);
  assert.ok(result.equal, result.diffs.join('; '));
});

test('two live variables with one name in a frame are still rejected', () => {
  const state = interpret('int main(void) { int t = 1; { int u = 2; } return 0; }').state;
  state.allocations.find(a => a.name === 'u').alive = true;
  state.allocations.find(a => a.name === 'u').name = 't';
  assert.throws(() => validate(state), /duplicate variable name 't'/);
});

test('a heap block reachable only through an interior pointer cannot be generated', () => {
  const state = interpret(`struct S { int x; int y; };
int main(void) { struct S *s = malloc(sizeof(struct S)); int *q = &s->y; s = NULL; return 0; }`).state;
  assert.throws(
    () => generate(state),
    /q has type int \* but heap 1 needs a struct S \* pointer to allocate it/,
  );
});

test('generated C keeps bool and size_t spellings and their headers', () => {
  const state = interpret(
    'int main(void) { bool b = 7; size_t n = sizeof(long); return 0; }',
  ).state;
  assert.equal(named(state, 'b').value.value, 1);
  const generated = generate(state);
  assert.match(generated, /^#include <stdbool.h>\n#include <stddef.h>\n/);
  assert.match(generated, /bool b;/);
  assert.match(generated, /size_t n;/);
  assert.match(generated, /b = true;/);
  assert.match(generated, /n = 8UL;/);
});

test('size_t and unsigned long are the same type for pointers', () => {
  const state = interpret(
    'int main(void) { unsigned long x = 4; size_t *p = &x; *p = 5; return 0; }',
  ).state;
  assert.equal(named(state, 'x').value.value, 5);
  assert.throws(() => interpret('int main(void) { int x; size_t *p = &x; return 0; }'));
});

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
