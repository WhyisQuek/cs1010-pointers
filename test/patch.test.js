/**
 * appendToCode: diagram edits as lines added to existing code. Each case edits a copy of
 * the memory a program ends with, as the diagram editor would, and checks the lines added.
 * appendToCode itself runs the result and compares it with the diagram before returning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { appendToCode } from '../src/pipeline/patch.js';
import { generate } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { pausedLine } from '../src/machine/navigation.js';
import { addAllocation, addFrame, makeState } from '../src/machine/memory.js';
import { CHAR, pointer, primitive } from '../src/language/types.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const INT = primitive('int');
const NODE = { kind: 'struct', name: 'N' };
const named = (s, name) => s.allocations.find(a => a.name === name);
const byId = (s, id) => s.allocations.find(a => a.id === id);
/** The heap block `name` points to, then along each `next`-style field in `hops`. */
const block = (s, name, ...hops) => {
  let a = byId(s, named(s, name).value.target.allocationId);
  for (const hop of hops) a = byId(s, a.value.fields[hop].target.allocationId);
  return a;
};
const to = (a, path = []) => ({ kind: 'pointer', target: { allocationId: a.id, path } });
const num = value => ({ kind: 'scalar', value });
const heap = (s, type, value) => addAllocation(s, { type, storage: { kind: 'heap' }, value });

const LIST = `#include <stdlib.h>

struct N { int v; struct N *next; };

struct N *push(struct N *h, int v) {
    struct N *n = malloc(sizeof(struct N));
    n->v = v;
    n->next = h;
    return n;
}

int main(void) {
    struct N *head = NULL;
    for (int i = 1; i <= 3; i++) {
        head = push(head, i);
    }
    return 0;
}
`;
const SIMPLE = `int main(void) {
    int a = 1;
    int b = 2;
    int *p = &a;
    return 0;
}
`;
const WITH_HEADER = `#include <stdlib.h>\n\n${SIMPLE}`;
const HEAP = `#include <stdlib.h>

int main(void) {
    int *p = malloc(sizeof(int));
    *p = 1;
    int *q = malloc(2 * sizeof(int));
    q[0] = 7;
    return 0;
}
`;

/** Edits a copy of what `code` ends with, and returns what appendToCode makes of it. */
function edited(code, edit, synced = null) {
  const diagram = structuredClone(interpret(code).state);
  edit(diagram);
  return { diagram, ...appendToCode(code, diagram, synced) };
}
/** The added lines, without their indentation. */
const added = result =>
  result.added.map(line => result.code.split('\n')[line - 1].replace(/^ {4}/, ''));

const appended = [
  [
    'a changed value, a new variable and a pointer to it',
    LIST,
    s => {
      block(s, 'head', 'next').value.fields.v = num(99);
      const extra = addAllocation(s, { name: 'extra', type: INT, value: num(7) });
      addAllocation(s, { name: 'q', type: pointer(INT), value: to(extra) });
    },
    ['int extra = 7;', 'int *q = &extra;', 'head->next->v = 99;'],
  ],
  ['nothing changed', LIST, () => {}, []],
  [
    'a pointer moved along a list, leaking its first node',
    LIST,
    s => (named(s, 'head').value = structuredClone(block(s, 'head').value.fields.next)),
    ['head = head->next;'],
  ],
  [
    'a whole list freed, last node first',
    LIST,
    s => s.allocations.filter(a => a.storage.kind === 'heap').forEach(a => (a.alive = false)),
    ['free(head->next->next);', 'free(head->next);', 'free(head);'],
  ],
  [
    'a node added at the head, which needs a temporary',
    LIST,
    s => {
      const fields = { v: num(0), next: structuredClone(named(s, 'head').value) };
      named(s, 'head').value = to(heap(s, NODE, { kind: 'aggregate', fields }));
    },
    [
      '{',
      '    struct N *tmp = head;',
      '    head = malloc(sizeof(struct N));',
      '    head->v = 0;',
      '    head->next = tmp;',
      '}',
    ],
  ],
  [
    'two links reversed, which needs a temporary',
    LIST,
    s => {
      const [a, b, c] = [
        block(s, 'head'),
        block(s, 'head', 'next'),
        block(s, 'head', 'next', 'next'),
      ];
      named(s, 'head').value = to(b);
      b.value.fields.next = to(a);
      a.value.fields.next = to(c);
    },
    [
      '{',
      '    struct N *tmp = head;',
      '    head = head->next;',
      '    tmp->next = head->next;',
      '    head->next = tmp;',
      '}',
    ],
  ],
  [
    'a pointer retargeted and a value changed',
    SIMPLE,
    s => {
      named(s, 'p').value = to(named(s, 'b'));
      named(s, 'a').value = num(10);
    },
    ['a = 10;', 'p = &b;'],
  ],
  [
    'a string and a partly set array',
    SIMPLE,
    s => {
      const chars = { kind: 'aggregate', elements: [num(72), num(105), num(0)] };
      addAllocation(s, { name: 'x', type: { kind: 'array', of: CHAR, length: 3 }, value: chars });
      const ints = {
        kind: 'aggregate',
        elements: [num(1), { kind: 'uninit' }, { kind: 'uninit' }],
      };
      addAllocation(s, { name: 'arr', type: { kind: 'array', of: INT, length: 3 }, value: ints });
    },
    ['char x[3] = "Hi";', 'int arr[3];', 'arr[0] = 1;'],
  ],
  [
    'a new block, with the old one kept by a new pointer and then freed',
    HEAP,
    s => {
      const old = block(s, 'p');
      addAllocation(s, { name: 'r', type: pointer(INT), value: to(old) });
      named(s, 'p').value = to(heap(s, INT, num(5)));
      old.alive = false;
    },
    ['int *r = p;', 'p = malloc(sizeof(int));', '*p = 5;', 'free(r);'],
  ],
  [
    'a pointer into the middle of a heap array',
    HEAP,
    s => {
      block(s, 'q').value.elements[1] = num(8);
      named(s, 'p').value = to(block(s, 'q'), [1]);
    },
    ['q[1] = 8;', 'p = q + 1;'],
  ],
  [
    'a new block that its only pointer points into: allocate, fill, then move',
    WITH_HEADER,
    s => {
      const elements = [num(1), num(4)];
      const h = heap(s, { kind: 'array', of: INT, length: 2 }, { kind: 'aggregate', elements });
      named(s, 'p').value = to(h, [1]);
    },
    ['p = malloc(2 * sizeof(int));', 'p[0] = 1;', 'p[1] = 4;', 'p = p + 1;'],
  ],
  [
    'a new block for a new pointer that points into it',
    WITH_HEADER,
    s => {
      const elements = [num(1), { kind: 'uninit' }, num(3)];
      const h = heap(s, { kind: 'array', of: INT, length: 3 }, { kind: 'aggregate', elements });
      addAllocation(s, { name: 'q', type: pointer(INT), value: to(h, [2]) });
    },
    ['int *q = malloc(3 * sizeof(int));', 'q[0] = 1;', 'q[2] = 3;', 'q = q + 2;'],
  ],
  [
    'a new block with a pointer to its start and one into it: the start allocates',
    WITH_HEADER,
    s => {
      const elements = [num(1), num(4)];
      const h = heap(s, { kind: 'array', of: INT, length: 2 }, { kind: 'aggregate', elements });
      named(s, 'p').value = to(h, [1]);
      addAllocation(s, { name: 'q', type: pointer(INT), value: to(h, [0]) });
    },
    ['int *q = malloc(2 * sizeof(int));', 'q[0] = 1;', 'q[1] = 4;', 'p = q + 1;'],
  ],
  [
    'a block nothing points to, through a temporary',
    HEAP,
    s => heap(s, INT, num(5)),
    ['{', '    int *tmp = malloc(sizeof(int));', '    *tmp = 5;', '}'],
  ],
];
for (const [name, code, edit, lines] of appended) {
  test(`append: ${name}`, () => {
    const result = edited(code, edit);
    assert.equal(result.reason, undefined);
    assert.deepEqual(added(result), lines);
    // Every line of the original is still there, in order.
    const kept = result.code.split('\n').filter((_, i) => !result.added.includes(i + 1));
    assert.equal(kept.join('\n'), code);
    assert.ok(equivalent(result.diagram, interpret(result.code).state).equal);
  });
}

test('append: swapped names and values need no code changes when the state is equivalent', () => {
  const code = 'int main(void) {\n    int x = 1;\n    int y = 2;\n    return 0;\n}\n';
  const synced = interpret(code).state;
  const diagram = structuredClone(synced);
  const x = named(diagram, 'x');
  const y = named(diagram, 'y');
  Object.assign(x, { name: 'y', value: num(2) });
  Object.assign(y, { name: 'x', value: num(1) });
  assert.ok(equivalent(synced, diagram).equal);
  for (const known of [null, synced]) {
    assert.deepEqual(appendToCode(code, diagram, known), { code, added: [] });
  }
  // Once the equivalent diagram is synchronised, subsequent changes use its IDs.
  const edited = structuredClone(diagram);
  named(edited, 'x').value = num(7);
  const result = appendToCode(code, edited, diagram);
  assert.deepEqual(added(result), ['x = 7;']);
  assert.ok(equivalent(edited, interpret(result.code).state).equal);
});

test('append: equivalent renamed allocations must preserve pointer relationships', () => {
  const synced = interpret(SIMPLE).state;
  const diagram = structuredClone(synced);
  const a = named(diagram, 'a');
  const b = named(diagram, 'b');
  Object.assign(a, { name: 'b', value: num(2) });
  Object.assign(b, { name: 'a', value: num(1) });
  // p must follow the corresponding named object, not the original allocation ID.
  named(diagram, 'p').value = to(b);
  assert.deepEqual(appendToCode(SIMPLE, diagram, synced), { code: SIMPLE, added: [] });
  named(diagram, 'p').value = to(a);
  assert.equal(equivalent(synced, diagram).equal, false);
  assert.equal(appendToCode(SIMPLE, diagram, synced).code, undefined);
});

const refused = [
  [
    'a variable removed',
    SIMPLE,
    s => (s.allocations = s.allocations.filter(a => a.name !== 'b')),
    /removing 'b'/,
  ],
  [
    'a value made uninitialized',
    SIMPLE,
    s => (named(s, 'a').value = { kind: 'uninit' }),
    /uninitialized again/,
  ],
  ['a variable renamed', SIMPLE, s => (named(s, 'a').name = 'z'), /renaming 'a'/],
  [
    'a type changed',
    SIMPLE,
    s => Object.assign(named(s, 'b'), { type: primitive('long') }),
    /type of 'b'/,
  ],
  [
    'a freed block allocated again',
    'int main(void) {\n    int *p = malloc(sizeof(int));\n    free(p);\n    return 0;\n}\n',
    s => (block(s, 'p').alive = true),
    /already freed/,
  ],
  [
    'code on one line',
    'int main(void) { int a = 1; return 0; }',
    s => (named(s, 'a').value = num(2)),
    /shares its line/,
  ],
  ['code that does not run', 'int main(void) {\n    int a = ;\n}\n', null, /does not run/],
];
for (const [name, code, edit, reason] of refused) {
  test(`append refused: ${name}`, () => {
    const result = edit ? edited(code, edit) : appendToCode(code, makeState());
    assert.equal(result.code, undefined);
    assert.match(result.reason, reason);
  });
}

test('append: lines go before the closing brace of a main() with no return', () => {
  const code = 'void set(int *p) { *p = 5; }\nint main(void) {\n    int a = 0;\n    set(&a);\n}\n';
  const result = edited(code, s => {
    named(s, 'a').value = num(9);
    addAllocation(s, { name: 'b', type: pointer(INT), value: { kind: 'null' } });
  });
  // NULL needs a header the code did not have.
  assert.equal(
    result.code,
    '#include <stdlib.h>\n\nvoid set(int *p) { *p = 5; }\nint main(void) {\n    int a = 0;\n    set(&a);\n    int *b = NULL;\n    a = 9;\n}\n',
  );
  assert.deepEqual(result.added, [1, 7, 8]);
});

test('append: a diagram drawn by hand is paired with its generated code through `synced`', () => {
  const s = makeState();
  addFrame(s, { id: 'main', name: 'main' });
  // Created first but declared last, so a fresh run numbers the allocations differently.
  const first = heap(s, INT, num(0));
  const x = addAllocation(s, { name: 'x', type: INT, value: num(1) });
  const h = heap(s, INT, num(4));
  addAllocation(s, { name: 'p', type: pointer(INT), value: to(h) });
  addAllocation(s, { name: 'z', type: pointer(INT), value: to(first) });
  const code = generate(s);
  const synced = structuredClone(s);
  h.value = num(40);
  x.value = num(2);
  const result = appendToCode(code, s, synced);
  assert.deepEqual(added(result), ['x = 2;', '*p = 40;']);
  // Without it the allocation IDs do not line up, and the edit is refused, not mis-written.
  assert.ok(appendToCode(code, s).reason);
});

/** The first step of a run of `code` that is paused at `line`, as { state, line }. */
function pausedBefore(code, line) {
  const { snapshots } = interpret(code);
  const k = snapshots.findIndex((_, i) => pausedLine(snapshots, i + 1) === line) + 1;
  assert.ok(k > 0, `no step is paused at line ${line}`);
  return structuredClone(snapshots[k - 1].state);
}

test('cut: a diagram edited from an earlier step keeps the code above that step', () => {
  // Paused before `int *p = &a;` on line 4, with b changed in the diagram.
  const step = pausedBefore(SIMPLE, 4);
  const diagram = structuredClone(step);
  named(diagram, 'b').value = num(5);
  const result = appendToCode(SIMPLE, diagram, step, { before: 4 });
  assert.equal(
    result.code,
    'int main(void) {\n    int a = 1;\n    int b = 2;\n    b = 5;\n    return 0;\n}\n',
  );
  assert.deepEqual([result.removed, result.from, result.added], [1, 4, [4]]);
});

test('cut: with nothing edited, the statements after the step are removed', () => {
  // Paused before the loop, after `struct N *head = NULL;`.
  const step = pausedBefore(LIST, 14);
  const result = appendToCode(LIST, step, step, { before: 14 });
  assert.deepEqual([result.removed, result.from, result.added], [3, 14, []]);
  assert.match(result.code, /struct N \*head = NULL;\n {4}return 0;\n}\n$/);
  // push() is no longer called, but it is not main()'s to remove.
  assert.match(result.code, /struct N \*push\(/);
});

test('cut: a step inside a call or partway through a loop is refused', () => {
  const { snapshots } = interpret(LIST);
  const reasons = new Set();
  let kept = 0;
  snapshots.forEach(({ state }, i) => {
    const before = pausedLine(snapshots, i + 1);
    if (before === null) return;
    const result = appendToCode(LIST, state, state, { before });
    if (result.reason) return reasons.add(result.reason);
    // Whatever is not refused must rebuild exactly that step.
    assert.ok(equivalent(state, interpret(result.code).state).equal, `step ${i + 1}`);
    kept++;
  });
  assert.ok(kept >= 2);
  assert.ok(reasons.has('the step shown is not at the start of a statement of main()'));
  // The loop line is reached again after each iteration, with the list partly built.
  assert.ok(reasons.has('the step shown is partway through a statement or a loop'));
});

test('append: history the code still produces does not get in the way', () => {
  // A pointer into a returned call cannot be generated from scratch, but can be kept.
  const code =
    'int *bad(void) {\n    int t = 4;\n    return &t;\n}\n\nint main(void) {\n    int *d = bad();\n    int n = 1;\n    return 0;\n}\n';
  const state = interpret(code).state;
  assert.throws(() => generate(state), /returned call bad\(\)/);
  const result = edited(code, s => (named(s, 'n').value = num(2)));
  assert.deepEqual(added(result), ['n = 2;']);
});
