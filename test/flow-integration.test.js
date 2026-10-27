/** Real C execution snapshots must obey the same presentation invariants. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { pathFromHandle, stateToFlow } from '../src/flow/layout.js';
import { pointerCanTarget, ref } from '../src/machine/memory.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

test('element, whole-array and pointer-variable targets keep distinct C types and anchors', () => {
  const { state } = interpret(
    'int main(void) { int a[3] = {1, 2, 3}; int *element = a; int (*whole)[3] = &a; int **indirect = &element; return 0; }',
  );
  const named = name => state.allocations.find(a => a.name === name);
  const a = named('a'),
    element = named('element'),
    whole = named('whole'),
    indirect = named('indirect');
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
    assert.equal(
      source.data.sourceSides[JSON.stringify(pathFromHandle(edge.sourceHandle))],
      edge.sourceHandle.split(':')[2],
    );
  }
});

test('successive function calls never share a visible frame slot', () => {
  const result = interpret(
    'void change_number(int *p) { *p = 5; } void change_element(int *p) { *p = 9; } int main(void) { int n = 1; int a[2] = {2,3}; change_number(&n); change_element(&a[1]); change_number(&n); return 0; }',
  );
  for (const snapshot of result.snapshots)
    for (const showExpired of [false, true]) {
      const { nodes, edges } = stateToFlow(snapshot.state, { showExpired });
      const frames = nodes.filter(n => ['frameGroup', 'frameFold'].includes(n.type));
      for (let i = 0; i < frames.length; i++)
        for (let j = i + 1; j < frames.length; j++)
          assert.ok(
            frames[j].position.y >= frames[i].position.y + frames[i].height ||
              frames[i].position.y >= frames[j].position.y + frames[j].height ||
              frames[j].position.x >= frames[i].position.x + frames[i].width ||
              frames[i].position.x >= frames[j].position.x + frames[j].width,
          );
      for (const edge of edges)
        assert.ok(nodes.some(n => n.id === edge.source) && nodes.some(n => n.id === edge.target));
      if (!showExpired) assert.ok(nodes.every(n => !n.data.frame || n.data.frame.active));
    }
  assert.equal(result.state.frames.filter(f => f.name === 'change_number').length, 2);
});

test('recursive invocations retain distinct parents and return without live-view clutter', () => {
  const result = interpret(
    'void descend(int n) { int value = n; if (n > 0) descend(n - 1); } int main(void) { descend(3); return 0; }',
  );
  const deepest = result.snapshots.find(s => s.state.frames.filter(f => f.active).length === 5);
  assert.ok(deepest);
  const all = stateToFlow(deepest.state, { unfold: true }).nodes;
  assert.equal(all.filter(n => n.type === 'frameGroup').length, 5);
  for (const node of all.filter(n => n.parentId))
    assert.equal(node.parentId, 'frame:' + node.data.allocation.storage.frameId);
  // Folded by default: main, one row for the middle calls, and the newest two calls open.
  const folded = stateToFlow(deepest.state).nodes;
  assert.equal(folded.filter(n => n.type === 'frameGroup').length, 3);
  assert.deepEqual(folded.find(n => n.type === 'frameFold').data.calls, [
    'descend() #1',
    'descend() #2',
  ]);
  assert.equal(stateToFlow(result.state).nodes.filter(n => n.type === 'frameGroup').length, 1);
});

test('each call opens under its caller, and the next call reuses a returned one’s space', () => {
  const result = interpret(
    'int *grab(void) { int *p = malloc(sizeof(int)); return p; } void touch(int *p) { *p = 1; } int main(void) { int n = 0; int *a = NULL; int *b = NULL; a = grab(); b = grab(); touch(&n); free(a); free(b); return 0; }',
  );
  const frameAt = (state, name) =>
    stateToFlow(state).nodes.find(n => n.type === 'frameGroup' && n.data.frame.name === name);
  const calls = result.snapshots.filter(s => s.state.frames.filter(f => f.active).length === 2);
  const main = frameAt(calls[0].state, 'main');
  const spots = new Set(
    calls.map(s => {
      const callee = stateToFlow(s.state).nodes.find(
        n => n.type === 'frameGroup' && n.data.frame.name !== 'main',
      );
      assert.equal(callee.position.x, main.position.x);
      assert.ok(callee.position.y >= main.position.y + main.height);
      return JSON.stringify(callee.position);
    }),
  );
  // grab(), grab() and touch() all open in the same spot; heap blocks never push them aside.
  assert.equal(spots.size, 1);
  const heap = stateToFlow(result.snapshots.at(-2).state).nodes.filter(
    n => n.data.allocation?.storage.kind === 'heap',
  );
  assert.equal(heap.length, 2);
  for (const box of heap) assert.ok(box.position.x >= main.position.x + main.width);
});

test('returned calls go on a shelf under the live stack, folded by function', () => {
  const result = interpret(
    'int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); } int main(void) { int r = fib(4); return r; }',
  );
  const state = result.snapshots.findLast(s =>
    s.state.frames.some(f => f.active && f.name === 'fib'),
  ).state;
  const live = stateToFlow(state).nodes;
  const shown = stateToFlow(state, { showExpired: true }).nodes;
  // Showing returned calls never moves the live ones.
  for (const n of live.filter(n => n.type === 'frameGroup'))
    assert.deepEqual(shown.find(m => m.id === n.id).position, n.position);
  const liveBottom = Math.max(...live.filter(n => !n.parentId).map(n => n.position.y + n.height));
  const shelf = shown.filter(
    n => (n.type === 'frameGroup' && !n.data.frame.active) || n.data.returned,
  );
  assert.ok(shelf.length > 0);
  for (const n of shelf) {
    assert.ok(n.position.y > liveBottom);
    assert.equal(n.draggable, false);
  }
  assert.ok(shelf.some(n => n.type === 'frameFold' && n.data.calls.length > 1));
  const unfolded = stateToFlow(state, { showExpired: true, unfold: true }).nodes;
  assert.equal(
    unfolded.filter(n => n.type === 'frameGroup' && !n.data.frame.active).length,
    state.frames.filter(f => !f.active).length,
  );
});

test('a folded call that a pointer targets stays open', () => {
  const result = interpret(
    'void down(int *up, int n) { int here = n; if (n > 0) down(&here, n - 1); } int main(void) { down(0, 4); return 0; }',
  );
  const deepest = result.snapshots.reduce((a, s) =>
    s.state.frames.filter(f => f.active).length > a.state.frames.filter(f => f.active).length
      ? s
      : a,
  );
  const { nodes } = stateToFlow(deepest.state);
  // Every call but the newest holds a `here` the next call points at.
  assert.ok(!nodes.some(n => n.type === 'frameFold'));
  assert.equal(
    nodes.filter(n => n.type === 'frameGroup').length,
    deepest.state.frames.filter(f => f.active).length,
  );
});

test('loop locals disappear at lifetime end while an escaped pointer stays dangling', () => {
  const result = interpret(
    'int main(void) { int *p = NULL; for (int i = 0; i < 2; i++) { int value = i; p = &value; } return 0; }',
  );
  const live = stateToFlow(result.state);
  assert.deepEqual(
    live.nodes.filter(n => n.data.allocation).map(n => n.data.allocation.name),
    ['p'],
  );
  assert.equal(live.edges.length, 0);
  const history = stateToFlow(result.state, { showExpired: true });
  assert.equal(history.edges[0].className, 'dangling-edge');
});
