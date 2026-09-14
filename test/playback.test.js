import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { stateToFlow } from '../src/flow/layout.js';
import { highlightC } from '../src/language/highlight.js';

await initParser({ runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm', grammarWasm: './public/tree-sitter-c.wasm' });
const source = `typedef struct Node {
  int value;
  struct Node *next;
} Node;
void set_value(Node *node, int value) {
  node->value = value;
}
int main(void) {
  Node a = {10, NULL};
  Node *b = &a;
  set_value(b, 20);
  return 0;
}`;

test('struct pointer declarations work with anonymous, tagged and forward typedefs', () => {
  for (const definition of [
    'typedef struct { int value; } Node;',
    'typedef struct Node { int value; } Node;',
    'typedef struct Node Node; struct Node { int value; };',
    'struct Node { int value; }; typedef struct Node First; typedef struct Node Node;',
  ]) {
    const { state } = interpret(`${definition} int main(void) {
      Node a = {10}; Node *uninitialized; Node *b = &a, *c = b;
      Node **pp = &b; (*pp)->value = 20;
      Node *heap = malloc(sizeof(Node)); heap->value = 30;
    }`);
    assert.equal(state.allocations.find(a => a.name === 'a').value.fields.value.value, 20);
    assert.equal(state.allocations.find(a => a.name === 'uninitialized').value.kind, 'uninit');
    const generated = generate(state);
    assert.match(generated, /Node \*b;/);
    assert.equal(equivalent(state, interpret(generated).state).equal, true);
  }
});

test('self references use the struct tag until the typedef alias is declared', () => {
  assert.throws(() => interpret('typedef struct Node { Node *next; } Node; int main() {}'), /not declared yet/);
  const { state } = interpret('typedef struct Node { int value; struct Node *next; } Node; int main() { Node a = {1, NULL}; Node b = {2, &a}; Node *p = &b; }');
  assert.equal(equivalent(state, interpret(generate(state)).state).equal, true);
});

test('entry, assignment and return are distinct steps with the next line identified', () => {
  const { snapshots, trace } = interpret(source);
  const entryIndex = snapshots.findIndex(s => s.function === 'set_value' && s.statement === 'EnterFrame');
  const entry = snapshots[entryIndex], write = snapshots[entryIndex + 1], leave = snapshots[entryIndex + 2];
  assert.equal(snapshots[0].state.allocations.length, 0);
  assert.equal(entry.state.allocations.find(a => a.name === 'a').value.fields.value.value, 10);
  assert.equal(entry.nextLine, 6);
  assert.equal(write.state.allocations.find(a => a.name === 'a').value.fields.value.value, 20);
  assert.equal(write.nextLine, 7);
  assert.equal(leave.statement, 'LeaveFrame');
  assert.equal(leave.nextLine, 12);
  assert.equal(snapshots.at(-1).nextLine, null);
  assert.deepEqual(snapshots.flatMap(s => s.events), trace);
  const before = snapshots[entryIndex - 1];
  const entryFlow = stateToFlow(entry.state, { previousState: before.state });
  assert.equal(entryFlow.nodes.find(n => n.data.allocation?.name === 'a').data.changed, false);
  assert.equal(entryFlow.nodes.find(n => n.data.allocation?.name === 'node').data.changed, true);
  assert.ok(entryFlow.nodes.find(n => n.id === `frame:${entry.frameId}`).className.includes('memory-changed'));
  const writeFlow = stateToFlow(write.state, { previousState: entry.state });
  assert.deepEqual([...writeFlow.nodes.find(n => n.data.allocation?.name === 'a').data.changedPaths], ['["value"]']);
  assert.equal(writeFlow.nodes.find(n => n.data.allocation?.name === 'b').data.changed, false);
});

test('arrows attach to typed addresses and struct and first-field addresses stay distinct', () => {
  const { state } = interpret(`typedef struct { int value; } Node;
    int main() { Node a = {10}; Node *p = &a; int *field = &a.value; Node **pp = &p; }`);
  const { nodes, edges } = stateToFlow(state);
  assert.equal(edges.length, 3);
  for (const edge of edges) {
    assert.match(edge.targetHandle, /:(left|right)$/);
    const [before, end] = edge.data.points.slice(-2);
    assert.ok(edge.targetHandle.endsWith(':left') ? before.x < end.x : before.x > end.x);
  }
  const a = nodes.find(n => n.data.allocation?.name === 'a');
  assert.deepEqual([...a.data.targetPaths].sort(), ['["value"]', '[]'].sort());
});

test('loop conditions and updates do not merge with their bodies', () => {
  const { snapshots } = interpret(`int main() {
    int i = 0;
    while (i < 2) {
      i++;
    }
    return 0;
  }`);
  const conditions = snapshots.filter(s => s.statement === 'WhileCondition');
  assert.equal(conditions.length, 3);
  assert.deepEqual(conditions.map(s => s.nextLine), [4, 4, 6]);
  assert.deepEqual(conditions.map(s => s.state.allocations[0].value.value), [0, 1, 2]);
});

test('syntax errors identify the missing semicolon instead of the first struct tag', () => {
  assert.throws(() => interpret(source.replace('Node *b = &a;', 'Node *b = &a')), /line 10/);
});

test('C highlighting preserves text, multiline comments, strings and trailing lines', () => {
  const code = '#include <stdlib.h>\n/* first\nsecond */\nint main() { char c = \'x\'; return 42; }\n';
  const lines = highlightC(code);
  assert.equal(lines.map(line => line.map(t => t.text).join('')).join('\n'), code);
  assert.ok(lines[2].some(t => t.kind === 'comment'));
  assert.ok(lines[3].some(t => t.kind === 'keyword' && t.text === 'int'));
  assert.ok(lines[3].some(t => t.kind === 'function' && t.text === 'main'));
});
