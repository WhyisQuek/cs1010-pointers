/** Regression tests for frame layout, lifetimes, target handles and edge geometry. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAllocation,
  addFrame,
  endFrame,
  makeState,
  pointerStatus,
  ref,
} from '../src/machine/memory.js';
import {
  array,
  pointer,
  primitive,
  structRef,
  structType,
  typeToString,
} from '../src/language/types.js';
import { DENSITY, GEOMETRY, handleId, pathFromHandle, stateToFlow } from '../src/flow/layout.js';
import { crossesBox, routePointer } from '../src/flow/routing.js';

const int = primitive('int');
test('step zero has no frame before main is entered', () => {
  assert.equal(stateToFlow(makeState()).nodes.length, 0);
});
function fixture() {
  const state = makeState();
  addFrame(state, { id: 'main', name: 'main' });
  addFrame(state, { id: 'first', name: 'change_number', depth: 1 });
  addFrame(state, { id: 'second', name: 'change_element', depth: 1 });
  const value = addAllocation(state, {
    id: 'value',
    name: 'value',
    type: int,
    value: { kind: 'scalar', value: 3 },
  });
  addAllocation(state, {
    id: 'p',
    name: 'p',
    type: pointer(int),
    storage: { kind: 'stack', frameId: 'first' },
    value: { kind: 'pointer', target: ref(value.id) },
  });
  addAllocation(state, {
    id: 'q',
    name: 'q',
    type: pointer(int),
    storage: { kind: 'stack', frameId: 'second' },
    value: { kind: 'pointer', target: ref(value.id) },
  });
  return state;
}
function overlaps(a, b) {
  return (
    a.position.x < b.position.x + b.width &&
    a.position.x + a.width > b.position.x &&
    a.position.y < b.position.y + b.height &&
    a.position.y + a.height > b.position.y
  );
}

test('each invocation has a separate non-overlapping frame, independent of depth', () => {
  const state = fixture();
  endFrame(state, 'first');
  const frames = stateToFlow(state, { showExpired: true }).nodes.filter(
    n => n.type === 'frameGroup',
  );
  assert.equal(frames.length, 3);
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) assert.ok(!overlaps(frames[i], frames[j]));
  assert.ok(frames.every(n => !n.deletable && n.dragHandle === '.frame-group-label'));
  // Live calls can be dragged; returned ones sit on the shelf, placed afresh each step.
  assert.deepEqual(
    frames.filter(n => n.draggable).map(n => n.id),
    ['frame:main', 'frame:second'],
  );
});

test('frames are not remembered until dragged, so the column reflows', () => {
  const state = fixture();
  const nodes = stateToFlow(state).nodes;
  const layout = captureLayout(emptyLayout(), nodes);
  assert.ok(!Object.keys(layout.positions).some(id => id.startsWith('frame:')));
  const dragged = moveNode(layout, nodes, 'frame:first', { x: 700, y: 400 });
  assert.deepEqual(
    Object.keys(dragged.positions).filter(id => id.startsWith('frame:')),
    ['frame:first'],
  );
});

test('expired locals and returned frames are hidden without deleting semantic provenance', () => {
  const state = fixture();
  endFrame(state, 'first');
  state.allocations.find(a => a.id === 'q').alive = false;
  const before = JSON.stringify(state);
  const { nodes, edges } = stateToFlow(state);
  assert.ok(!nodes.some(n => ['frame:first', 'p', 'q'].includes(n.id)));
  assert.equal(edges.length, 0);
  assert.equal(JSON.stringify(state), before);
  const history = stateToFlow(state, { showExpired: true });
  // Expired objects can be moved, but their contents are read-only.
  assert.equal(history.nodes.find(n => n.id === 'p').draggable, true);
  assert.equal(history.nodes.find(n => n.id === 'p').data.editable, false);
  const editable = stateToFlow(state, { showExpired: true, editable: true });
  assert.equal(editable.nodes.find(n => n.id === 'p').deletable, false);
});

test('an active frame with no locals is still visible', () => {
  const state = makeState();
  addFrame(state, { id: 'empty', name: 'empty' });
  assert.equal(stateToFlow(state).nodes[0].id, 'frame:empty');
});

test('locals retain their owning frame, which grows to contain free positions', () => {
  for (const editable of [false, true]) {
    const { nodes } = stateToFlow(fixture(), {
      editable,
      positions: { p: { x: -900, y: -500 }, q: { x: 9000, y: 9000 } },
    });
    for (const child of nodes.filter(n => n.parentId)) {
      const parent = nodes.find(n => n.id === child.parentId);
      assert.equal(child.extent, undefined);
      assert.ok(nodes.indexOf(parent) < nodes.indexOf(child));
      assert.ok(child.position.x >= GEOMETRY.padding && child.position.y >= GEOMETRY.top);
      assert.ok(child.position.x + child.width <= parent.width - GEOMETRY.padding);
      assert.ok(child.position.y + child.height <= parent.height - GEOMETRY.padding);
    }
  }
});

test('64-row arrays and long declarations fit their frame without overlapping its neighbor', () => {
  const state = fixture();
  addAllocation(state, { name: 'long_array_name_for_a_large_object', type: array(int, 64) });
  const { nodes } = stateToFlow(state);
  const large = nodes.find(n => n.data.allocation?.type.kind === 'array');
  const parent = nodes.find(n => n.id === large.parentId);
  assert.ok(large.position.y + large.height <= parent.height - GEOMETRY.padding);
  assert.ok(large.position.x + large.width <= parent.width - GEOMETRY.padding);
  assert.equal(large.height, GEOMETRY.header + 64 * GEOMETRY.row + GEOMETRY.footer);
  assert.ok(
    !overlaps(
      parent,
      nodes.find(n => n.id === 'frame:first'),
    ),
  );
});

test('layout reset is deterministic and frame drag preserves local coordinates', () => {
  const state = fixture(),
    original = stateToFlow(state);
  const moved = stateToFlow(state, {
    positions: { 'frame:first': { x: 200, y: 600 }, p: { x: 24, y: 72 } },
  });
  assert.deepEqual(moved.nodes.find(n => n.id === 'frame:first').position, { x: 200, y: 600 });
  assert.equal(moved.nodes.find(n => n.id === 'p').position.y, 72);
  assert.deepEqual(stateToFlow(state), original);
  assert.notEqual(moved.edges[0].data.path, original.edges[0].data.path);
});

test('dangling pointers keep their target in state when the expired target is hidden', () => {
  const state = fixture();
  const escaped = addAllocation(state, {
    id: 'escaped',
    name: 'escaped',
    type: pointer(pointer(int)),
    value: { kind: 'pointer', target: ref('p') },
  });
  endFrame(state, 'first');
  assert.equal(pointerStatus(state, escaped.value), 'dangling');
  assert.ok(!stateToFlow(state).edges.some(e => e.source === 'escaped'));
  const edge = stateToFlow(state, { showExpired: true }).edges.find(e => e.source === 'escaped');
  assert.equal(edge.className, 'dangling-edge');
});

test('freed heap objects remain available as dangling targets', () => {
  const state = makeState();
  addAllocation(state, { id: 'heap', type: int, storage: { kind: 'heap' }, alive: false });
  addAllocation(state, {
    id: 'p',
    name: 'p',
    type: pointer(int),
    value: { kind: 'pointer', target: ref('heap') },
  });
  assert.equal(stateToFlow(state).edges[0].className, 'dangling-edge');
  const heap = stateToFlow(state).nodes.find(n => n.id === 'heap');
  assert.equal(heap.draggable, true);
  assert.equal(heap.deletable, false);
  assert.equal(heap.data.editable, false);
  const editable = stateToFlow(state, { editable: true }).nodes.find(n => n.id === 'heap');
  assert.equal(editable.deletable, true);
  assert.equal(editable.data.editable, false);
});

test('struct root references have a real header target and one-past references have no fake row', () => {
  const state = makeState({ Node: structType('Node', [{ name: 'value', type: int }]) });
  addAllocation(state, { id: 'node', name: 'node', type: structRef('Node') });
  addAllocation(state, {
    id: 'p',
    name: 'p',
    type: pointer(structRef('Node')),
    value: { kind: 'pointer', target: ref('node') },
  });
  const edge = stateToFlow(state).edges[0];
  assert.match(edge.targetHandle, /^tgt:root:/);
  addAllocation(state, { id: 'nodes', name: 'nodes', type: array(structRef('Node'), 2) });
  addAllocation(state, {
    id: 'np',
    name: 'np',
    type: pointer(structRef('Node')),
    value: { kind: 'pointer', target: ref('nodes', [1]) },
  });
  assert.match(stateToFlow(state).edges.find(e => e.source === 'np').targetHandle, /^tgt:1:/);
  addAllocation(state, { id: 'arr', name: 'arr', type: array(int, 3) });
  addAllocation(state, {
    id: 'end',
    name: 'end',
    type: pointer(int),
    value: { kind: 'pointer', target: ref('arr', [3]) },
  });
  assert.ok(!stateToFlow(state).edges.some(e => e.source === 'end'));
});

test('subobject handle IDs round-trip paths independently of attachment side', () => {
  for (const path of [[], [2], ['next'], [2, 'next']])
    for (const side of ['left', 'right'])
      assert.deepEqual(pathFromHandle(handleId('tgt', path, side)), path);
});

test('default arrows do not cross allocation interiors or frame labels', () => {
  const { nodes, edges } = stateToFlow(fixture());
  const obstacles = nodes.map(n => {
    const p = nodes.find(x => x.id === n.parentId);
    return {
      x: n.position.x + (p?.position.x ?? 0),
      y: n.position.y + (p?.position.y ?? 0),
      width: n.width,
      height: n.type === 'frameGroup' ? 34 : n.height,
    };
  });
  for (const edge of edges)
    for (let i = 1; i < edge.data.points.length; i++) {
      const a = edge.data.points[i - 1],
        b = edge.data.points[i];
      for (const box of obstacles) assert.ok(!crossesBox(a, b, box), 'arrow crosses a box');
    }
});

test('routing detours around a middle box instead of passing through it', () => {
  const obstacles = [
    { x: 0, y: 0, width: 100, height: 80 },
    { x: 200, y: 0, width: 100, height: 80 },
    { x: 400, y: 0, width: 100, height: 80 },
  ];
  const path = routePointer({ x: 100, y: 40 }, { x: 400, y: 40 }, 'left', obstacles);
  assert.ok(path.some(p => p.y < 0 || p.y > 80));
  for (let i = 1; i < path.length; i++)
    for (const box of obstacles) assert.ok(!crossesBox(path[i - 1], path[i], box));
});
import {
  captureLayout,
  contentSize,
  densityLayout,
  editTimeline,
  emptyLayout,
  emptyTimeline,
  initialHistory,
  layoutHistory,
  moveNode,
  resizeFrame,
  withDensityLayout,
} from '../src/flow/workspace.js';
import { curvePointer } from '../src/flow/routing.js';

function workspaceFixture() {
  const state = fixture();
  addAllocation(state, { id: 'sibling', name: 'sibling', type: int });
  const nodes = stateToFlow(state).nodes;
  return { state, nodes, layout: captureLayout(emptyLayout(), nodes) };
}

test('free movement grows all frame boundaries and preserves sibling world coordinates', () => {
  for (const position of [
    { x: 450, y: 100 },
    { x: 1100, y: 1200 },
    { x: -200, y: -300 },
  ]) {
    const { state, nodes, layout } = workspaceFixture(),
      before = JSON.stringify(state);
    const oldParent = nodes.find(n => n.id === 'frame:main');
    const moved = moveNode(layout, nodes, 'value', position);
    const updated = stateToFlow(state, moved).nodes;
    const child = updated.find(n => n.id === 'value'),
      parent = updated.find(n => n.id === child.parentId);
    const sibling = updated.find(n => n.id === 'sibling'),
      oldSibling = nodes.find(n => n.id === 'sibling');
    assert.equal(
      sibling.position.x + parent.position.x,
      oldSibling.position.x + oldParent.position.x,
    );
    assert.equal(
      sibling.position.y + parent.position.y,
      oldSibling.position.y + oldParent.position.y,
    );
    assert.equal(child.position.x + parent.position.x, position.x + oldParent.position.x);
    assert.equal(child.position.y + parent.position.y, position.y + oldParent.position.y);
    assert.ok(child.position.x >= GEOMETRY.padding && child.position.y >= GEOMETRY.top);
    assert.ok(child.position.x + child.width + GEOMETRY.padding <= parent.width);
    assert.ok(child.position.y + child.height + GEOMETRY.padding <= parent.height);
    assert.equal(JSON.stringify(state), before);
  }
});

test('resizing every edge preserves children in world coordinates and refuses clipping', () => {
  for (const direction of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const { state, nodes, layout } = workspaceFixture();
    const frame = nodes.find(n => n.id === 'frame:main'),
      child = nodes.find(n => n.id === 'value');
    for (const delta of [-1000, 120]) {
      const changed = resizeFrame(
        layout,
        nodes,
        frame.id,
        {
          x: frame.position.x - delta,
          y: frame.position.y - delta,
          width: frame.width + 2 * delta,
          height: frame.height + 2 * delta,
        },
        direction,
      );
      const updated = stateToFlow(state, changed).nodes;
      const f = updated.find(n => n.id === frame.id),
        c = updated.find(n => n.id === child.id);
      assert.equal(f.position.x + c.position.x, frame.position.x + child.position.x);
      assert.equal(f.position.y + c.position.y, frame.position.y + child.position.y);
      assert.ok(c.position.x >= GEOMETRY.padding && c.position.y >= GEOMETRY.top);
      assert.ok(c.position.x + c.width + GEOMETRY.padding <= f.width);
      assert.ok(c.position.y + c.height + GEOMETRY.padding <= f.height);
    }
  }
});

test('edits, additions, and history visibility preserve placements and frame sizes', () => {
  const { state, nodes, layout } = workspaceFixture();
  let saved = moveNode(layout, nodes, 'value', { x: 320, y: 210 });
  const edited = structuredClone(state);
  edited.allocations.find(a => a.id === 'value').value.value = 42;
  addAllocation(edited, { id: 'new', name: 'new', type: int });
  const next = stateToFlow(edited, saved).nodes;
  assert.deepEqual(next.find(n => n.id === 'value').position, { x: 320, y: 210 });
  saved = captureLayout(saved, next);
  endFrame(edited, 'first');
  const hidden = captureLayout(saved, stateToFlow(edited, saved).nodes);
  assert.deepEqual(
    stateToFlow(edited, { ...hidden, showExpired: true }).nodes.find(n => n.id === 'p').position,
    nodes.find(n => n.id === 'p').position,
  );
  assert.ok(contentSize(next, 'frame:main').width <= next.find(n => n.id === 'frame:main').width);
});

test('one drag is one undo step; redo restores sizes and bends; clear isolates reused IDs', () => {
  const { nodes, layout } = workspaceFixture();
  let history = layoutHistory(initialHistory(), { type: 'sync', layout });
  history = layoutHistory(history, { type: 'begin' });
  for (const x of [100, 200, 800])
    history = layoutHistory(history, {
      type: 'set',
      layout: moveNode(history.present, nodes, 'value', { x, y: 150 }),
    });
  history = layoutHistory(history, { type: 'end' });
  assert.equal(history.past.length, 1);
  const moved = history.present;
  history = layoutHistory(history, { type: 'undo' });
  assert.deepEqual(history.present, layout);
  history = layoutHistory(history, { type: 'redo' });
  assert.deepEqual(history.present, moved);
  const bent = { ...moved, routes: { pointer: { x: 60, y: -90 } } };
  history = layoutHistory(history, { type: 'set', layout: bent });
  history = layoutHistory(history, { type: 'undo' });
  assert.deepEqual(history.present, moved);
  history = layoutHistory(history, { type: 'redo' });
  assert.deepEqual(history.present, bent);
  history = layoutHistory(history, { type: 'clear' });
  assert.deepEqual(history, initialHistory());
});

test('one undo timeline orders layout steps and diagram edits', () => {
  const [s0, s1, s2, s3] = [{}, {}, {}, {}];
  const record = (t, entry) => editTimeline(t, { type: 'record', entry });
  let t = record(emptyTimeline(), { before: s0, after: s1 });
  t = record(t, 'layout');
  t = record(t, { before: s1, after: s2 });
  t = editTimeline(t, { type: 'undo' });
  assert.equal(t.future[0].before, s1);
  t = editTimeline(t, { type: 'undo' });
  assert.equal(t.future[0], 'layout');
  t = editTimeline(t, { type: 'redo' });
  assert.equal(t.past.at(-1), 'layout');
  // A new step drops the redo branch.
  t = record(t, { before: s1, after: s3 });
  assert.deepEqual(t.future, []);
  // Two edits computed from the same state in one event are one step.
  t = record(t, { before: s1, after: s2 });
  assert.equal(t.past.length, 3);
  assert.equal(t.past.at(-1).after, s2);
  // Back-to-back edits of one field are one step back to the state before the first.
  const [k0, k1, k2, k3] = [{}, {}, {}, {}];
  let typed = record(emptyTimeline(), { before: k0, after: k1, merge: 'value:a' });
  typed = record(typed, { before: k1, after: k2, merge: 'value:a' });
  assert.equal(typed.past.length, 1);
  assert.equal(typed.past[0].before, k0);
  assert.equal(typed.past[0].after, k2);
  // Another field, or an unrelated step in between, starts a new step.
  typed = record(typed, { before: k2, after: k3, merge: 'value:b' });
  assert.equal(typed.past.length, 2);
  typed = record(typed, 'layout');
  typed = record(typed, { before: k3, after: {}, merge: 'value:b' });
  assert.equal(typed.past.length, 4);

  // A diagram replaced from outside keeps layout steps only.
  t = editTimeline(t, { type: 'forgetEdits' });
  assert.deepEqual(t.past, ['layout']);
  // Undo past the start is a no-op.
  const start = emptyTimeline();
  assert.equal(editTimeline(start, { type: 'undo' }), start);
});

test('curves choose both attachment sides and manual bends follow moving endpoints', () => {
  const { state, layout } = workspaceFixture();
  const forward = stateToFlow(state, {
    ...layout,
    positions: { ...layout.positions, 'frame:first': { x: -800, y: 72 } },
  }).edges.find(e => e.source === 'p');
  const backward = stateToFlow(state, {
    ...layout,
    positions: { ...layout.positions, 'frame:first': { x: 800, y: 72 } },
  }).edges.find(e => e.source === 'p');
  // A call under its caller links along the right sides.
  const stacked = stateToFlow(state, layout).edges.find(e => e.source === 'p');
  assert.equal(stacked.sourceHandle.endsWith(':right'), true);
  assert.equal(stacked.targetHandle.endsWith(':right'), true);
  assert.equal(forward.sourceHandle.endsWith(':right'), true);
  assert.equal(forward.targetHandle.endsWith(':left'), true);
  assert.equal(backward.sourceHandle.endsWith(':left'), true);
  assert.equal(backward.targetHandle.endsWith(':right'), true);
  const a = curvePointer({ x: 0, y: 0 }, { x: 500, y: 50 }, 'right', 'left', [], { x: 20, y: -90 });
  const b = curvePointer({ x: 100, y: 100 }, { x: 600, y: 150 }, 'right', 'left', [], {
    x: 20,
    y: -90,
  });
  assert.match(a.path, / C /);
  assert.deepEqual(b.bend, { x: a.bend.x + 100, y: a.bend.y + 100 });
  assert.deepEqual(a.points[0], { x: 0, y: 0 });
  assert.deepEqual(a.points.at(-1), { x: 500, y: 50 });
  const loop = curvePointer(
    { x: 300, y: 100 },
    { x: 300, y: 100 },
    'right',
    'right',
    [],
    undefined,
    true,
  );
  assert.ok(loop.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(loop.points.some(p => p.x > 350));
});

test('active non-main frames are editable only in an editable diagram', () => {
  for (const editable of [true, false]) {
    const node = stateToFlow(fixture(), { editable }).nodes.find(n => n.id === 'p');
    assert.equal(node.data.editable, editable);
    assert.equal(node.deletable, editable);
  }
});

test('compact boxes are one line per value, and frames shrink to fit them', () => {
  const g = DENSITY.compact.geometry;
  const state = fixture();
  addAllocation(state, { id: 'arr', name: 'arr', type: array(pointer(int), 3) });
  const full = stateToFlow(state).nodes;
  const compact = stateToFlow(state, { density: 'compact' }).nodes;
  const box = (nodes, id) => nodes.find(n => n.id === id);
  // A scalar or pointer has no header and no caption line: its one row is the whole box.
  assert.equal(box(compact, 'value').height, g.row + g.footer);
  assert.equal(box(compact, 'p').height, g.row + g.footer);
  // An aggregate keeps a one-line header over its rows.
  assert.equal(box(compact, 'arr').height, g.header + 3 * g.row + g.footer);
  for (const id of ['value', 'p', 'arr', 'frame:main', 'frame:first'])
    assert.ok(box(compact, id).height < box(full, id).height, id);
  // Boxes in one frame share a width and name/type columns, like a table.
  const main = compact.filter(n => n.parentId === 'frame:main');
  assert.deepEqual(main.map(n => n.id).sort(), ['arr', 'value']);
  assert.equal(new Set(main.map(n => n.width)).size, 1);
  assert.deepEqual(main[0].data.columns, {
    name: 'value'.length,
    type: typeToString(array(pointer(int), 3)).length,
  });
  assert.deepEqual(main[1].data.columns, main[0].data.columns);
  // Long names and types are capped (and cut with an ellipsis) instead of widening the rest.
  addAllocation(state, {
    id: 'long',
    name: 'a_really_long_variable_name',
    type: array(pointer(structRef('Node')), 2),
  });
  const capped = stateToFlow(state, { density: 'compact' }).nodes.find(n => n.id === 'long');
  assert.deepEqual(capped.data.columns, { name: 12, type: 14 });
  // Out of scope still says so above the line.
  endFrame(state, 'first');
  const dead = stateToFlow(state, { density: 'compact', showExpired: true }).nodes;
  assert.equal(box(dead, 'p').height, g.lifetime + g.row + g.footer);
  // Arrows still meet the middle of the line they point from and to.
  const { nodes, edges } = stateToFlow(fixture(), { density: 'compact' });
  const edge = edges.find(e => e.source === 'p');
  const world = id => {
    const n = box(nodes, id),
      parent = box(nodes, n.parentId);
    return { y: n.position.y + parent.position.y };
  };
  assert.equal(edge.data.points[0].y, world('p').y + 1 + g.row / 2);
  assert.equal(edge.data.points.at(-1).y, world('value').y + 1 + g.row / 2);
});

test('each density keeps its own arrangement in one layout', () => {
  const state = fixture();
  let layout = emptyLayout();
  for (const density of ['full', 'compact']) {
    const nodes = stateToFlow(state, { ...densityLayout(layout, density), density }).nodes;
    const part = moveNode(
      captureLayout(densityLayout(layout, density), nodes),
      nodes,
      'value',
      { x: density === 'full' ? 300 : 150, y: 200 },
      density,
    );
    layout = withDensityLayout(layout, density, part);
  }
  assert.deepEqual(densityLayout(layout, 'full').positions.value, { x: 300, y: 200 });
  assert.deepEqual(densityLayout(layout, 'compact').positions.value, { x: 150, y: 200 });
  // Resetting one density leaves the other alone.
  const reset = withDensityLayout(layout, 'compact', emptyLayout());
  assert.deepEqual(densityLayout(reset, 'full').positions.value, { x: 300, y: 200 });
  assert.equal(densityLayout(reset, 'compact').positions.value, undefined);
  // A compact frame grows by compact padding around a moved box.
  const nodes = stateToFlow(state, { density: 'compact' }).nodes;
  const moved = moveNode(emptyLayout(), nodes, 'value', { x: 400, y: 300 }, 'compact');
  const valueBox = nodes.find(n => n.id === 'value');
  assert.equal(
    moved.sizes['frame:main'].width,
    400 + valueBox.width + DENSITY.compact.geometry.padding,
  );
});
