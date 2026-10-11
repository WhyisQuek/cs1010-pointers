import test from 'node:test';
import assert from 'node:assert/strict';
import {
  array,
  pointer,
  primitive,
  structRef,
  structType,
  layoutOf,
  sizeOf,
} from '../src/language/types.js';
import {
  addAllocation,
  addFrame,
  addressableSubobjects,
  cloneState,
  endFrame,
  makeState,
  pointerValue,
  ref,
} from '../src/machine/memory.js';
import {
  ADDRESS_REGIONS,
  RESERVATION_BYTES,
  referenceLocation,
  upgradeMemoryState,
  validateAddressSpace,
} from '../src/machine/addresses.js';
import { changeAllocationType, removeAllocation } from '../src/machine/editing.js';
import { describePointer, formatAddress } from '../src/flow/addressPresentation.js';
import { allocationMetrics, GEOMETRY, stateToFlow } from '../src/flow/layout.js';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate, validate } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';

const int = primitive('int'),
  char = primitive('char');
const object = (state, name, type = int, options = {}) =>
  addAllocation(state, { name, type, ...options });
const address = (state, a, path = []) => referenceLocation(state, ref(a.id, path)).address;
await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

test('every supported primitive and pointer retains the LP64 layout', () => {
  for (const [name, size] of [
    ['char', 1],
    ['short', 2],
    ['int', 4],
    ['unsigned int', 4],
    ['float', 4],
    ['long', 8],
    ['unsigned long', 8],
    ['double', 8],
  ])
    assert.deepEqual(layoutOf(primitive(name)), { size, alignment: size });
  assert.deepEqual(layoutOf(pointer(structRef('Incomplete'))), { size: 8, alignment: 8 });
});
test('stack and heap use independent deterministic reservations and actual type sizes', () => {
  const s = makeState(),
    a = object(s, 'a'),
    heap = object(s, null, int, { storage: { kind: 'heap' } }),
    p = object(s, 'p', pointer(int));
  assert.deepEqual(
    [a.baseAddress, heap.baseAddress, p.baseAddress],
    [0x10000000, 0x80000000, 0x10010000],
  );
  assert.equal(sizeOf(a.type), 4);
  assert.equal(sizeOf(p.type), 8);
  assert.equal(validateAddressSpace(s), s);
});
test('own pointer address, stored address, aliases and pointer-to-pointer are distinct', () => {
  const s = makeState(),
    a = object(s, 'a', array(int, 3));
  const p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id, [1])) });
  const pp = object(s, 'pp', pointer(pointer(int)), { value: pointerValue(ref(p.id)) });
  const q = object(s, 'q', pointer(int), { value: structuredClone(p.value) });
  assert.equal(address(s, p), 0x10010000);
  assert.equal(describePointer(s, p.value).address, 0x10000004);
  assert.equal(describePointer(s, q.value).address, 0x10000004);
  assert.equal(describePointer(s, pp.value).address, 0x10010000);
  assert.deepEqual(p.value, { kind: 'pointer', target: { allocationId: a.id, path: [1] } });
});
test('nested structs, tail padding, arrays of structs and pointer arrays use byte strides', () => {
  const S = structType('S', [
    { name: 'tag', type: char },
    { name: 'count', type: int },
    { name: 'end', type: char },
  ]);
  const Outer = structType('Outer', [
    { name: 'head', type: char },
    { name: 's', type: structRef('S') },
    { name: 'p', type: pointer(int) },
  ]);
  const s = makeState({ S, Outer });
  assert.equal(layoutOf(S).size, 12);
  assert.deepEqual(
    layoutOf(S).fields.map(f => f.offset),
    [0, 4, 8],
  );
  assert.deepEqual(
    layoutOf(Outer, s.structTypes).fields.map(f => f.offset),
    [0, 4, 16],
  );
  const a = object(s, 'a', array(structRef('Outer'), 2)),
    p = object(s, 'p', array(pointer(int), 2));
  assert.equal(address(s, a, [1, 's', 'count']), a.baseAddress + 24 + 4 + 4);
  assert.equal(address(s, p, [1]), p.baseAddress + 8);
  assert.equal(address(s, a, [0, 'head']), a.baseAddress);
});
test('shared boundary addresses retain their distinct subobject bounds', () => {
  const s = makeState(),
    m = object(s, 'm', array(array(int, 3), 2));
  const end = describePointer(s, pointerValue(ref(m.id, [0, 3]))),
    next = describePointer(s, pointerValue(ref(m.id, [1, 0])));
  assert.equal(end.address, 0x1000000c);
  assert.equal(next.address, end.address);
  assert.equal(end.status, 'one-past');
  assert.equal(next.status, 'valid');
  assert.equal(address(s, m, ['$onePast']), m.baseAddress + 24);
  assert.equal(address(s, m, [0, '$onePast']), m.baseAddress + 12);
  for (const path of [[-1], [3], [0, 3, '$onePast'], ['$onePast', 0], ['not-an-index']])
    assert.throws(() => address(s, m, path));
});
test('null, uninitialized, malformed, dangling and one-past addresses remain distinguishable', () => {
  const s = makeState(),
    a = object(s, 'a');
  assert.equal(describePointer(s, { kind: 'null' }).address, 0);
  assert.equal(describePointer(s, { kind: 'uninit' }).address, undefined);
  for (const target of [
    null,
    { allocationId: 'missing', path: [] },
    { allocationId: a.id, path: ['missing'] },
  ]) {
    const p = object(s, `p${s.allocations.length}`, pointer(int), {
      value: { kind: 'pointer', target },
    });
    assert.equal(describePointer(s, p.value).status, 'invalid');
    assert.doesNotThrow(() => stateToFlow(s));
  }
  const end = pointerValue(ref(a.id, ['$onePast']));
  assert.equal(describePointer(s, end).address, a.baseAddress + 4);
  a.alive = false;
  assert.equal(describePointer(s, end).status, 'dangling');
  assert.equal(describePointer(s, end).value, null);
});
test('a freed heap block can be deleted; an expired local cannot', () => {
  const s = makeState();
  addFrame(s, { id: 'main', name: 'main' });
  const h = object(s, null, int, { storage: { kind: 'heap' }, alive: false }),
    p = object(s, 'p', pointer(int), { value: pointerValue(ref(h.id)) });
  removeAllocation(s, h.id);
  assert.equal(p.value.kind, 'uninit');
  assert.ok(!s.allocations.some(a => a.id === h.id));
  const local = object(s, 'gone', int, { alive: false });
  assert.throws(() => removeAllocation(s, local.id), /read-only/);
});
test('addresses and identities never reuse deleted or expired allocations', () => {
  const s = makeState();
  addFrame(s, { id: 'main', name: 'main' });
  const a = object(s, 'a'),
    p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id)) });
  removeAllocation(s, a.id);
  assert.equal(p.value.kind, 'uninit');
  const b = object(s, 'b');
  assert.equal(b.baseAddress, 0x10020000);
  assert.notEqual(b.id, a.id);
  endFrame(s, 'main');
  const oldAddress = b.baseAddress;
  assert.equal(address(s, b), oldAddress);
  const h = object(s, null, int, { storage: { kind: 'heap' } });
  h.alive = false;
  assert.equal(object(s, null, int, { storage: { kind: 'heap' } }).baseAddress, 0x80010000);
});
test('new states and snapshot copies allocate independently of other executions', () => {
  const s = makeState(),
    a = object(s, 'a'),
    copy = cloneState(s);
  interpret('int main(void){ int unrelated[10]; }');
  const b = object(s, 'b'),
    other = object(copy, 'other');
  assert.equal(b.baseAddress, 0x10010000);
  assert.equal(other.baseAddress, b.baseAddress);
  assert.notEqual(b.id, a.id);
  assert.equal(s.allocations.length, 2);
  assert.equal(copy.allocations.length, 2);
  assert.equal(object(makeState(), 'fresh').baseAddress, 0x10000000);
  const frameA = addFrame(s, { name: 'f' }),
    frameB = addFrame(s, { name: 'f' });
  assert.notEqual(frameA.id, frameB.id);
});
test('failed allocation is atomic and region exhaustion never wraps', () => {
  for (const kind of ['stack', 'heap']) {
    const s = makeState(),
      region = ADDRESS_REGIONS[kind];
    s.addressSpace[region.cursor] = (region.end - region.start) / RESERVATION_BYTES - 1;
    const last = object(s, kind === 'stack' ? 'last' : null, int, {
      storage: { kind, frameId: 'main' },
    });
    assert.equal(last.baseAddress, region.end - RESERVATION_BYTES);
    const before = structuredClone(s);
    assert.throws(() => object(s, 'overflow', int, { storage: { kind } }), /exhausted/);
    assert.deepEqual(s, before);
  }
  const s = makeState();
  object(s, 'a');
  const before = structuredClone(s);
  assert.throws(() => object(s, 'duplicate', int, { id: 'a0' }), /duplicate/);
  assert.throws(() => object(s, 'unknown', structRef('Missing')));
  assert.deepEqual(s, before);
  const huge = object(s, 'huge', array(array(primitive('double'), 64), 64));
  assert.equal(sizeOf(huge.type), 32768);
  assert.equal(address(s, huge, ['$onePast']), huge.baseAddress + 32768);
});
test('legacy normalization is pure and inconsistent address metadata is rejected', () => {
  const s = makeState();
  object(s, 'a');
  object(s, 'b');
  const legacy = structuredClone(s);
  delete legacy.addressSpace;
  legacy.allocations.forEach(a => delete a.baseAddress);
  const before = structuredClone(legacy),
    normalized = upgradeMemoryState(legacy);
  assert.deepEqual(legacy, before);
  assert.deepEqual(normalized, s);
  assert.deepEqual(upgradeMemoryState(normalized), normalized);
  for (const corrupt of [
    x => x.addressSpace.version++,
    x => (x.addressSpace.nextStackSlot = 0),
    x => (x.allocations[1].baseAddress = x.allocations[0].baseAddress),
    x => x.allocations[0].baseAddress++,
  ]) {
    const x = structuredClone(s);
    corrupt(x);
    assert.throws(() => upgradeMemoryState(x));
    assert.throws(() => validate(x));
  }
  legacy.allocations[0].baseAddress = 0x10000000;
  assert.throws(() => upgradeMemoryState(legacy), /mixed/);
});
test('type edits retain the base and reject incompatible or truncated targets atomically', () => {
  const s = makeState(),
    a = object(s, 'a', array(int, 3));
  const p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id, [2])) });
  changeAllocationType(s, a.id, array(int, 8));
  assert.equal(a.baseAddress, 0x10000000);
  assert.equal(describePointer(s, p.value).address, a.baseAddress + 8);
  const before = structuredClone(s);
  assert.throws(() => changeAllocationType(s, a.id, array(int, 1)), /Retarget/);
  assert.throws(() => changeAllocationType(s, a.id, array(char, 8)), /Retarget/);
  assert.deepEqual(s, before);
});
test('valid structural edits report moved addresses and preserve historical pointer facts', () => {
  const s = makeState(),
    a = object(s, 'a', array(array(int, 2), 2));
  const p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id, [1, 0])) });
  const before = cloneState(s);
  assert.equal(changeAllocationType(s, a.id, array(array(int, 3), 2)), 1);
  assert.equal(describePointer(s, p.value).address, a.baseAddress + 12);
  assert.ok(
    stateToFlow(s, { previousState: before })
      .nodes.find(n => n.id === p.id)
      .data.changedPaths.has('[]'),
  );
  p.alive = false;
  const historical = structuredClone(s);
  assert.throws(() => changeAllocationType(s, a.id, array(array(int, 4), 2)), /historical/);
  assert.throws(() => removeAllocation(s, a.id), /historical/);
  assert.deepEqual(s, historical);
});
test('growing an array revalidates incoming one-past status', () => {
  const s = makeState(),
    a = object(s, 'a', array(int, 2));
  const p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id, [2])) });
  assert.equal(describePointer(s, p.value).status, 'one-past');
  changeAllocationType(s, a.id, array(int, 3));
  assert.equal(describePointer(s, p.value).status, 'valid');
});
test('the memory view preserves state, geometry, routing and exact typed targets', () => {
  const s = makeState(),
    a = object(s, 'a', array(int, 3));
  const p = object(s, 'p', pointer(int), { value: pointerValue(ref(a.id, [1])) });
  const before = structuredClone(s),
    first = stateToFlow(s),
    again = stateToFlow(s);
  const geometry = flow => flow.nodes.map(n => [n.id, n.position, n.width, n.height]);
  assert.deepEqual(geometry(first), geometry(again));
  assert.ok(!first.edges[0].hidden);
  assert.equal(first.edges[0].data.path, again.edges[0].data.path);
  assert.deepEqual(s, before);
  const metrics = allocationMetrics(p, s);
  assert.equal(metrics.rows[0].height, GEOMETRY.row + GEOMETRY.pointerStatus);
  assert.equal(metrics.rows[0].top, GEOMETRY.header + GEOMETRY.metadata);
  const targets = addressableSubobjects(a, s);
  assert.deepEqual(
    targets.map(t => t.ref.path),
    [[], [0], [1], [2]],
  );
});
test('challenge equivalence and generated C ignore absolute allocation order', () => {
  const build = reverse => {
    const s = makeState();
    addFrame(s, { id: 'main', name: 'main' });
    for (const name of reverse ? ['y', 'x'] : ['x', 'y'])
      object(s, name, int, { value: { kind: 'scalar', value: name === 'x' ? 1 : 2 } });
    object(s, 'p', pointer(int), {
      value: pointerValue(ref(s.allocations.find(a => a.name === 'x').id)),
    });
    return s;
  };
  const a = build(false),
    b = build(true);
  assert.equal(equivalent(a, b).equal, true);
  const code = generate(b);
  assert.doesNotMatch(code, /0x100/);
  assert.equal(equivalent(b, interpret(code).state).equal, true);
});
test('playback addresses survive repeated calls, visibility changes and reruns', () => {
  const code = 'int *f(void){int x=7;return &x;} int main(void){int *p=f(); int *q=f();}';
  const result = interpret(code),
    again = interpret(code),
    seen = new Map();
  for (const snapshot of result.snapshots)
    for (const a of snapshot.state.allocations) {
      if (seen.has(a.id)) assert.equal(a.baseAddress, seen.get(a.id));
      else seen.set(a.id, a.baseAddress);
    }
  assert.deepEqual(result.state, again.state);
  const before = structuredClone(result.state);
  stateToFlow(result.state, { showExpired: false });
  stateToFlow(result.state, { showExpired: true });
  assert.deepEqual(result.state, before);
  assert.equal(
    new Set(result.state.allocations.map(a => a.baseAddress)).size,
    result.state.allocations.length,
  );
  assert.equal(
    describePointer(result.state, result.state.allocations.find(a => a.name === 'p').value).status,
    'dangling',
  );
});
test('hex formatting keeps heap addresses unsigned and supports full pointer-width display', () => {
  assert.equal(formatAddress(0x80000000), '0x80000000');
  assert.equal(formatAddress(0x10000004, true), '0x0000000010000004');
  assert.equal(formatAddress(0), '0x00000000');
  assert.equal(formatAddress(undefined), 'unavailable');
});

test('invalid explicit identities cannot consume a reservation or change state', () => {
  const state = makeState(),
    before = structuredClone(state);
  assert.throws(() => addAllocation(state, { id: 12, type: int }), /allocation id/);
  assert.throws(() => addFrame(state, { id: 12, name: 'f' }), /frame id/);
  assert.deepEqual(state, before);
});
