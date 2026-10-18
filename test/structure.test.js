/** Structure view: node-type detection, list and tree layout, and the heap/frame overlap fix. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { stateToFlow } from '../src/flow/layout.js';
import { captureLayout, emptyLayout } from '../src/flow/workspace.js';
import {
  callLabels,
  foldFrames,
  layoutStructures,
  leaksByStep,
  nodeTypeNames,
  unreachableHeap,
} from '../src/flow/structureLayout.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const BST = `#include <stdio.h>
#include <stdlib.h>
struct Node {
    int data;
    struct Node* left;
    struct Node* right;
};
struct Node* createNode(int data) {
    struct Node* newNode = malloc(sizeof(struct Node));
    newNode->data = data;
    newNode->left = NULL;
    newNode->right = NULL;
    return newNode;
}
struct Node* insert(struct Node* root, int data) {
    if (root == NULL) {
        return createNode(data);
    }
    if (data < root->data) {
        root->left = insert(root->left, data);
    } else if (data > root->data) {
        root->right = insert(root->right, data);
    }
    return root;
}
int main() {
    struct Node* root = NULL;
    root = insert(root, 50);
    insert(root, 30);
    insert(root, 20);
    insert(root, 40);
    insert(root, 70);
    insert(root, 60);
    insert(root, 80);
    return 0;
}`;

const LIST = `#include <stdlib.h>
typedef struct Item {
    int value;
    struct Item *link;
} Item;
Item *make(int value, Item *link) {
    Item *n = malloc(sizeof(Item));
    n->value = value;
    n->link = link;
    return n;
}
int main(void) {
    Item *head = make(10, make(20, make(30, NULL)));
    Item *prev = NULL, *curr = head;
    while (curr != NULL && curr->value < 25) {
        prev = curr;
        curr = curr->link;
    }
    Item *n = make(25, curr);
    prev->link = n;
    return 0;
}`;

const finalState = source => interpret(source).state;
const valueOf = (state, id) => state.allocations.find(a => a.id === id).value.fields;
const keyOf = (card, state, id) => valueOf(state, id)[card.fields[0].name].value;
const overlaps = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const rect = n => ({ ...n.position, width: n.width, height: n.height });

test('node types come from the program: any self-pointer member, by any name', () => {
  const int = { kind: 'primitive', name: 'int' };
  const self = name => ({ kind: 'pointer', to: { kind: 'struct', name } });
  assert.deepEqual(
    nodeTypeNames({
      Foo: { name: 'Foo', fields: [{ name: 'a', type: self('Foo') }] },
      Kids: {
        name: 'Kids',
        fields: [{ name: 'children', type: { kind: 'array', of: self('Kids'), length: 3 } }],
      },
      Point: { name: 'Point', fields: [{ name: 'x', type: int }] },
      Holder: { name: 'Holder', fields: [{ name: 'p', type: self('Foo') }] },
    }),
    ['Foo', 'Kids'],
  );
});

test('a BST is drawn as a tree: in-order columns, one row per depth', () => {
  const state = finalState(BST);
  const { cards } = layoutStructures(state, { x: 0, y: 0 });
  assert.equal(cards.size, 7);
  const placed = [...cards].map(([id, c]) => ({ key: keyOf(c.card, state, id), ...c }));
  // Left to right is sorted order, the BST invariant.
  const byX = [...placed].sort((a, b) => a.x - b.x).map(p => p.key);
  assert.deepEqual(byX, [20, 30, 40, 50, 60, 70, 80]);
  const depth = Object.fromEntries(placed.map(p => [p.key, p.y]));
  assert.equal(depth[50], 0);
  assert.equal(depth[30], depth[70]);
  assert.ok(depth[30] > depth[50]);
  for (const k of [20, 40, 60, 80]) assert.ok(depth[k] > depth[30]);
  // Labels show the key alone; sizes and types are left to the inspector.
  assert.ok(placed.every(p => p.card.fields.length === 1 && p.card.slots.length === 2));
  assert.deepEqual(
    placed[0].card.slots.map(s => s.label),
    ['left', 'right'],
  );
});

test('structure view stacks frames in a column with the heap beside it, at every step', () => {
  for (const { state } of interpret(BST).snapshots) {
    const { nodes, edges } = stateToFlow(state, { structure: true });
    const column = nodes.filter(n => ['frameGroup', 'frameFold'].includes(n.type));
    const heap = nodes.filter(n => !n.parentId && !column.includes(n));
    assert.equal(new Set(column.map(f => f.position.x)).size <= 1, true);
    const columnRight = Math.max(0, ...column.map(f => f.position.x + f.width));
    for (const h of heap) assert.ok(h.position.x > columnRight);
    const boxes = [...column, ...heap].map(rect);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]));
    assert.ok(nodes.every(n => !n.draggable));
    assert.ok(edges.every(e => !e.selectable));
  }
});

test('tree links are edges; stack pointers to nodes are cursor labels instead', () => {
  const state = finalState(BST);
  const { nodes, edges } = stateToFlow(state, { structure: true });
  const cards = nodes.filter(n => n.type === 'structureNode');
  const ids = new Set(cards.map(n => n.id));
  const links = edges.filter(e => ids.has(e.source) && ids.has(e.target));
  assert.equal(links.length, 6);
  assert.ok(links.every(e => /^src:(left|right):/.test(e.sourceHandle)));
  assert.equal(edges.length, 6);
  const root = cards.find(n => n.data.card.fields[0].text === '50');
  // Only main is on screen, so the label needs no frame tag.
  assert.deepEqual(
    root.data.cursors.map(c => [c.tag, c.name, c.running]),
    [[null, 'root', true]],
  );
  // main's root reads the node the way its card does.
  assert.equal(
    nodes.find(n => n.type === 'stackLocal' && n.data.allocation.name === 'root').data.cursorText,
    '50',
  );
});

test('a list traversal keeps its cursors inside their own cards', () => {
  const { snapshots } = interpret(`#include <stdlib.h>
typedef struct Node {
    int value;
    struct Node* next;
} Node;
int main() {
    Node* head = malloc(sizeof(Node));
    Node* second = malloc(sizeof(Node));
    Node* third = malloc(sizeof(Node));
    head->value = 10;
    head->next = second;
    second->value = 20;
    second->next = third;
    third->value = 30;
    third->next = NULL;
    Node* current = head;
    while (current != NULL) {
        current = current->next;
    }
    return 0;
}`);
  const step = snapshots.find(({ state }) => {
    const current = state.allocations.find(a => a.name === 'current');
    return (
      current?.value.kind === 'pointer' &&
      current.value.target.allocationId ===
        state.allocations.find(a => a.name === 'head').value.target.allocationId
    );
  });
  const { nodes, edges } = stateToFlow(step.state, { structure: true });
  const cards = nodes.filter(n => n.type === 'structureNode');
  const byKey = Object.fromEntries(cards.map(n => [n.data.card.fields[0].text, n]));
  // head and current both name 10, and only 10; second and third name their own nodes.
  assert.deepEqual(byKey['10'].data.cursors.map(c => c.name).sort(), ['current', 'head']);
  assert.deepEqual(
    byKey['20'].data.cursors.map(c => c.name),
    ['second'],
  );
  assert.deepEqual(
    byKey['30'].data.cursors.map(c => c.name),
    ['third'],
  );
  assert.ok(cards.every(n => n.data.cursors.every(c => c.tag === null)));
  // Every card has the same band and a side slot, so they line up and keep their size.
  assert.equal(
    new Set(cards.map(n => `${n.height}:${n.data.card.top}:${n.data.card.side}`)).size,
    1,
  );
  assert.ok(cards.every(n => n.data.card.top > 0 && n.data.card.side));
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) assert.ok(!overlaps(rect(cards[i]), rect(cards[j])));
  // next arrows run straight from one card's edge to the next card's side.
  const links = edges.filter(e => cards.some(n => n.id === e.source));
  assert.equal(links.length, 2);
  assert.ok(links.every(e => / L /.test(e.data.path)));
});

test('recursion folds between main and the two newest calls', () => {
  const frames = ['main', 'insert', 'insert', 'insert', 'insert', 'createNode'].map((name, i) => ({
    id: `f${i}`,
    name,
    active: true,
  }));
  assert.deepEqual(
    foldFrames(frames).map(e => (e.folded ? `fold:${e.folded.length}` : e.frame.name)),
    ['main', 'fold:3', 'insert', 'createNode'],
  );
  // One call between them is not worth folding; unfold shows everything.
  assert.equal(
    foldFrames(frames.slice(0, 4)).some(e => e.folded),
    false,
  );
  assert.equal(foldFrames(frames, true).length, 6);
  const labels = callLabels(frames);
  assert.deepEqual(labels.get('f2'), { label: 'insert() #2', tag: '#2' });
  assert.deepEqual(labels.get('f0'), { label: 'main()', tag: 'main' });
});

test('the deepest BST step folds its recursion and keeps the newest call running', () => {
  const deepest = interpret(BST).snapshots.reduce((best, s) =>
    s.state.frames.filter(f => f.active).length > best.state.frames.filter(f => f.active).length
      ? s
      : best,
  );
  const { nodes } = stateToFlow(deepest.state, { structure: true });
  const fold = nodes.find(n => n.type === 'frameFold');
  assert.ok(fold, 'expected folded insert() calls');
  assert.equal(fold.data.name, 'insert');
  const running = nodes.filter(n => n.type === 'frameGroup' && n.data.running);
  assert.equal(running.length, 1);
  assert.equal(running[0].data.frame, deepest.state.frames.filter(f => f.active).at(-1));
  const unfolded = stateToFlow(deepest.state, { structure: true, unfold: true }).nodes;
  assert.equal(
    unfolded.some(n => n.type === 'frameFold'),
    false,
  );
});

test('a node being returned to its caller is not mistaken for a leak', () => {
  for (const source of [BST, LIST]) {
    const { snapshots } = interpret(source);
    // Return values are not in MemoryState, so one snapshot alone would flag them...
    assert.ok(snapshots.some(({ state }) => unreachableHeap(state).size > 0));
    // ...but they are reached again on a later step, so playback never shows them.
    assert.ok(leaksByStep(snapshots).every(leaks => leaks.size === 0));
  }
});

test('a node no pointer reaches is flagged and set apart after the reachable ones', () => {
  const { snapshots } = interpret(`#include <stdlib.h>
struct N { int v; struct N *next; };
int main(void) {
    struct N *head = malloc(sizeof(struct N));
    struct N *b = malloc(sizeof(struct N));
    struct N *c = malloc(sizeof(struct N));
    head->v = 10; b->v = 20; c->v = 30;
    head->next = b; b->next = c; c->next = NULL;
    struct N *n = malloc(sizeof(struct N));
    n->v = 25;
    b->next = n;
    n->next = b->next;
    c = NULL;
    return 0;
}`);
  const leaks = leaksByStep(snapshots);
  // The step with `c = NULL` done and main still running.
  const last = snapshots.findLastIndex(({ state }) => state.frames.some(f => f.active));
  const { state } = snapshots[last];
  assert.equal(leaks[last].size, 1);
  const { nodes } = stateToFlow(state, { structure: true, unreachable: leaks[last] });
  const cards = nodes.filter(n => n.type === 'structureNode');
  const leaked = cards.find(n => n.data.unreachable);
  assert.equal(leaked.data.card.fields[0].text, '30');
  assert.ok(cards.every(n => n === leaked || n.position.y < leaked.position.y));
});

test('a node not yet linked into the tree is drawn on its own, below the tree', () => {
  const { snapshots } = interpret(BST);
  // The step after createNode(60) returns its block, before root->left stores it.
  const step = snapshots.find(({ state }) => {
    const nodes = state.allocations.filter(a => a.storage.kind === 'heap');
    return nodes.length === 6 && state.frames.some(f => f.active && f.name === 'createNode');
  });
  assert.ok(step, 'expected a createNode step for the sixth node');
  const { cards } = layoutStructures(step.state, { x: 0, y: 0 });
  const rows = [...cards.values()];
  const loose = rows.find(
    c => c === cards.get(step.state.allocations.findLast(a => a.storage.kind === 'heap').id),
  );
  assert.ok(rows.every(c => c === loose || c.y < loose.y));
});

test('a list is a chain in link order from the variable that heads it', () => {
  const state = finalState(LIST);
  const { cards } = layoutStructures(state, { x: 0, y: 0 });
  const placed = [...cards].map(([id, c]) => ({ key: keyOf(c.card, state, id), ...c }));
  assert.deepEqual(
    [...placed].sort((a, b) => a.x - b.x).map(p => p.key),
    [10, 20, 25, 30],
  );
  assert.equal(new Set(placed.map(p => p.y)).size, 1);
});

test('two links that mirror each other are a doubly linked chain, whatever their names', () => {
  const state = finalState(`#include <stdlib.h>
struct D { int v; struct D *a; struct D *b; };
int main(void) {
    struct D *x = malloc(sizeof(struct D));
    struct D *y = malloc(sizeof(struct D));
    struct D *z = malloc(sizeof(struct D));
    x->v = 1; y->v = 2; z->v = 3;
    x->a = y; y->a = z; z->a = NULL;
    x->b = NULL; y->b = x; z->b = y;
    return 0;
}`);
  const { cards } = layoutStructures(state, { x: 0, y: 0 });
  const placed = [...cards].map(([id, c]) => ({ key: keyOf(c.card, state, id), ...c }));
  assert.equal(new Set(placed.map(p => p.y)).size, 1);
  assert.deepEqual(
    [...placed].sort((a, b) => a.x - b.x).map(p => p.key),
    [1, 2, 3],
  );
});

test('unnamed binary links use declaration order for left and right', () => {
  const state = finalState(`#include <stdlib.h>
struct T { int k; struct T *lo; struct T *hi; };
int main(void) {
    struct T *r = malloc(sizeof(struct T));
    struct T *a = malloc(sizeof(struct T));
    struct T *b = malloc(sizeof(struct T));
    r->k = 2; a->k = 1; b->k = 3;
    r->lo = a; r->hi = b;
    a->lo = NULL; a->hi = NULL; b->lo = NULL; b->hi = NULL;
    return 0;
}`);
  const { cards } = layoutStructures(state, { x: 0, y: 0 });
  const placed = [...cards].map(([id, c]) => ({ key: keyOf(c.card, state, id), ...c }));
  const at = Object.fromEntries(placed.map(p => [p.key, p]));
  assert.ok(at[1].x < at[2].x && at[2].x < at[3].x);
  assert.ok(at[1].y > at[2].y && at[1].y === at[3].y);
});

test('remembered heap blocks no longer end up under later recursive frames', () => {
  // Replays playback the way MemoryCanvas does: each step's positions are remembered.
  let layout = emptyLayout();
  for (const { state } of interpret(BST).snapshots) {
    const { nodes } = stateToFlow(state, layout);
    layout = captureLayout(layout, nodes);
    const frames = nodes.filter(n => n.type === 'frameGroup').map(rect);
    const heap = nodes.filter(n => !n.parentId && n.type === 'memoryAllocation').map(rect);
    for (const f of frames) for (const h of heap) assert.ok(!overlaps(f, h));
  }
});
