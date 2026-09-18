/** Real C execution snapshots must obey the same presentation invariants. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { pathFromHandle, stateToFlow } from '../src/flow/layout.js';
import { pointerCanTarget, ref } from '../src/machine/memory.js';

await initParser({ runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm', grammarWasm: './public/tree-sitter-c.wasm' });

test('element, whole-array and pointer-variable targets keep distinct C types and anchors', () => {
  const { state } = interpret('int main(void) { int a[3] = {1, 2, 3}; int *element = a; int (*whole)[3] = &a; int **indirect = &element; return 0; }');
  const named = name => state.allocations.find(a => a.name === name);
  const a = named('a'), element = named('element'), whole = named('whole'), indirect = named('indirect');
  assert.equal(pointerCanTarget(state, element.type, ref(a.id)), false);
  assert.equal(pointerCanTarget(state, element.type, ref(a.id, [0])), true);
  assert.equal(pointerCanTarget(state, whole.type, ref(a.id)), true);
  assert.equal(pointerCanTarget(state, whole.type, ref(a.id, [0])), false);
  assert.equal(pointerCanTarget(state, indirect.type, ref(element.id)), true);
  assert.equal(pointerCanTarget(state, element.type, ref(element.id)), false);
  const { nodes, edges } = stateToFlow(state, { editable: true });
  assert.deepEqual(pathFromHandle(edges.find(e => e.source === element.id).targetHandle), [0]);
  assert.deepEqual(pathFromHandle(edges.find(e => e.source === whole.id).targetHandle), []);
  for (const edge of edges) {
    const source = nodes.find(n => n.id === edge.source);
    assert.equal(source.data.sourceSides[JSON.stringify(pathFromHandle(edge.sourceHandle))], edge.sourceHandle.split(':')[2]);
  }
});

test('successive function calls never share a visible frame slot', () => {
  const result = interpret('void change_number(int *p) { *p = 5; } void change_element(int *p) { *p = 9; } int main(void) { int n = 1; int a[2] = {2,3}; change_number(&n); change_element(&a[1]); change_number(&n); return 0; }');
  for (const snapshot of result.snapshots) for (const showExpired of [false, true]) {
    const { nodes, edges } = stateToFlow(snapshot.state, { showExpired });
    const frames = nodes.filter(n => n.type === 'frameGroup');
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i].position.x >= frames[i - 1].position.x + frames[i - 1].width);
    for (const edge of edges) assert.ok(nodes.some(n => n.id === edge.source) && nodes.some(n => n.id === edge.target));
    if (!showExpired) assert.ok(nodes.every(n => !n.data.frame || n.data.frame.active));
  }
  assert.equal(result.state.frames.filter(f => f.name === 'change_number').length, 2);
});

test('recursive invocations retain distinct parents and return without live-view clutter', () => {
  const result = interpret('void descend(int n) { int value = n; if (n > 0) descend(n - 1); } int main(void) { descend(3); return 0; }');
  const deepest = result.snapshots.find(s => s.state.frames.filter(f => f.active).length === 5);
  assert.ok(deepest);
  const nodes = stateToFlow(deepest.state).nodes;
  assert.equal(nodes.filter(n => n.type === 'frameGroup').length, 5);
  for (const node of nodes.filter(n => n.parentId)) assert.equal(node.parentId, 'frame:' + node.data.allocation.storage.frameId);
  assert.equal(stateToFlow(result.state).nodes.filter(n => n.type === 'frameGroup').length, 1);
});

test('loop locals disappear at lifetime end while an escaped pointer stays dangling', () => {
  const result = interpret('int main(void) { int *p = NULL; for (int i = 0; i < 2; i++) { int value = i; p = &value; } return 0; }');
  const live = stateToFlow(result.state);
  assert.deepEqual(live.nodes.filter(n => n.data.allocation).map(n => n.data.allocation.name), ['p']);
  assert.equal(live.edges.length, 0);
  const history = stateToFlow(result.state, { showExpired: true });
  assert.equal(history.edges[0].className, 'dangling-edge');
});
