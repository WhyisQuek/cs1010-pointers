/**
 * Fast parser-independent semantic regression suite.
 * Builds MemoryState/Mini-C AST objects directly to test the memory machine,
 * generator, and equivalence grader without needing Tree-sitter WASM.
 */
import assert from 'node:assert/strict';
import { array, pointer, primitive } from '../src/language/types.js';
import {
  addAllocation, makeState, pointerValue, ref, resetAllocationIds, setRefValue,
} from '../src/machine/memory.js';
import { generate, validate, ValidationError } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { executeProgram } from '../src/machine/interpreter.js';

const INT = primitive('int');

function fresh() { resetAllocationIds(); return makeState(); }
function stack(s, name, type, value) { return addAllocation(s, { name, type, value, storage: { kind: 'stack', frameId: 'main' } }); }
function heap(s, type, value, alive = true) { return addAllocation(s, { type, value, alive, storage: { kind: 'heap' } }); }

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.stack ?? e}`); process.exitCode = 1; }
}

test('dangling aliases preserve one freed allocation and codegen provenance', () => {
  const s = fresh();
  const h = heap(s, INT, { kind: 'uninit' }, false);
  stack(s, 'p', pointer(INT), pointerValue(ref(h.id)));
  stack(s, 'q', pointer(INT), pointerValue(ref(h.id)));
  const c = generate(s);
  assert.match(c, /p = malloc\(sizeof\(int\)\);/);
  assert.match(c, /q = p;/);
  assert.equal((c.match(/malloc/g) ?? []).length, 1);
  assert.equal((c.match(/free\(/g) ?? []).length, 1);
});

test('equivalence distinguishes one freed allocation from two unrelated freed allocations', () => {
  const target = fresh();
  const h = heap(target, INT, { kind: 'uninit' }, false);
  stack(target, 'p', pointer(INT), pointerValue(ref(h.id)));
  stack(target, 'q', pointer(INT), pointerValue(ref(h.id)));

  const actual = fresh();
  const h1 = heap(actual, INT, { kind: 'uninit' }, false);
  const h2 = heap(actual, INT, { kind: 'uninit' }, false);
  stack(actual, 'p', pointer(INT), pointerValue(ref(h1.id)));
  stack(actual, 'q', pointer(INT), pointerValue(ref(h2.id)));
  assert.equal(equivalent(target, actual).equal, false);
});

test('duplicate variable names are rejected before grading', () => {
  const s = fresh();
  stack(s, 'a', INT, { kind: 'scalar', value: 1 });
  stack(s, 'a', INT, { kind: 'scalar', value: 2 });
  assert.throws(() => validate(s), ValidationError);
});

test('C keywords are rejected as diagram variable names', () => {
  const s = fresh();
  stack(s, 'int', INT, { kind: 'scalar', value: 1 });
  assert.throws(() => validate(s), /valid, non-keyword C identifier/);
});

test('stack array subobject pointers generate address-of element', () => {
  const s = fresh();
  const arr = stack(s, 'arr', array(INT, 3), {
    kind: 'aggregate', elements: [
      { kind: 'scalar', value: 1 }, { kind: 'scalar', value: 2 }, { kind: 'scalar', value: 3 },
    ],
  });
  stack(s, 'p', pointer(INT), pointerValue(ref(arr.id, [1])));
  const c = generate(s);
  assert.match(c, /int arr\[3\];/);
  assert.match(c, /arr\[1\] = 2;/);
  assert.match(c, /p = &arr\[1\];/);
});

test('heap arrays retain one allocation with element values', () => {
  const s = fresh();
  const h = heap(s, array(INT, 3), {
    kind: 'aggregate', elements: [
      { kind: 'scalar', value: 10 }, { kind: 'scalar', value: 20 }, { kind: 'scalar', value: 30 },
    ],
  });
  stack(s, 'p', pointer(INT), pointerValue(ref(h.id, [0])));
  const c = generate(s);
  assert.match(c, /p = malloc\(3 \* sizeof\(int\)\);/);
  assert.match(c, /p\[2\] = 30;/);
});

test('heap value mismatch is reported on heap content, not the source pointer', () => {
  const a = fresh();
  const ah = heap(a, INT, { kind: 'scalar', value: 42 });
  stack(a, 'p', pointer(INT), pointerValue(ref(ah.id)));
  const b = fresh();
  const bh = heap(b, INT, { kind: 'scalar', value: 43 });
  stack(b, 'p', pointer(INT), pointerValue(ref(bh.id)));
  const r = equivalent(a, b);
  assert.equal(r.equal, false);
  assert.ok(r.diffs.some(d => /expected 42/.test(d)), r.diffs.join('; '));
  assert.ok(!r.diffs.some(d => /p.*wrong place/.test(d)), r.diffs.join('; '));
});

test('free(NULL) is a no-op in the semantic machine', () => {
  const program = {
    kind: 'Program', function: 'main', statements: [
      { kind: 'Declaration', declarations: [{ name: 'p', type: pointer(INT), initializer: { kind: 'NullLiteral' } }] },
      { kind: 'ExpressionStatement', expression: { kind: 'Call', name: 'free', arguments: [{ kind: 'Identifier', name: 'p' }] } },
    ],
  };
  const { state } = executeProgram(program);
  assert.equal(state.allocations.length, 1);
  assert.equal(state.allocations[0].value.kind, 'null');
});

test('malloc aliases and free keep target identity alive in the IR', () => {
  const program = {
    kind: 'Program', function: 'main', statements: [
      { kind: 'Declaration', declarations: [{
        name: 'p', type: pointer(INT), initializer: {
          kind: 'Call', name: 'malloc', arguments: [{ kind: 'SizeofType', type: INT }],
        },
      }] },
      { kind: 'Declaration', declarations: [{ name: 'q', type: pointer(INT), initializer: { kind: 'Identifier', name: 'p' } }] },
      { kind: 'ExpressionStatement', expression: { kind: 'Call', name: 'free', arguments: [{ kind: 'Identifier', name: 'p' }] } },
    ],
  };
  const { state } = executeProgram(program);
  const [p, h, q] = state.allocations;
  assert.equal(h.storage.kind, 'heap');
  assert.equal(h.alive, false);
  assert.equal(p.value.target.allocationId, h.id);
  assert.equal(q.value.target.allocationId, h.id);
});

test('array pointer arithmetic advances through subobjects', () => {
  const program = {
    kind: 'Program', function: 'main', statements: [
      { kind: 'Declaration', declarations: [{
        name: 'arr', type: array(INT, 3), initializer: {
          kind: 'InitializerList', elements: [
            { kind: 'IntLiteral', value: 1 }, { kind: 'IntLiteral', value: 2 }, { kind: 'IntLiteral', value: 3 },
          ],
        },
      }] },
      { kind: 'Declaration', declarations: [{ name: 'p', type: pointer(INT), initializer: { kind: 'Identifier', name: 'arr' } }] },
      { kind: 'ExpressionStatement', expression: { kind: 'Update', operator: '++', expression: { kind: 'Identifier', name: 'p' } } },
    ],
  };
  const { state } = executeProgram(program);
  const p = state.allocations.find(a => a.name === 'p');
  assert.deepEqual(p.value.target.path, [1]);
});


test('equivalence matches anonymous freed heap IDs up to relabeling', () => {
  const a = fresh();
  const ah = heap(a, INT, { kind: 'uninit' }, false);
  stack(a, 'p', pointer(INT), pointerValue(ref(ah.id)));
  stack(a, 'q', pointer(INT), pointerValue(ref(ah.id)));

  const b = fresh();
  // Add unrelated stack storage first so allocation IDs differ.
  stack(b, 'x', INT, { kind: 'scalar', value: 0 });
  const bh = heap(b, INT, { kind: 'uninit' }, false);
  stack(b, 'p', pointer(INT), pointerValue(ref(bh.id)));
  stack(b, 'q', pointer(INT), pointerValue(ref(bh.id)));
  // Remove x: ID numbering remains different while final state is equivalent.
  b.allocations = b.allocations.filter(x => x.name !== 'x');
  assert.equal(equivalent(a, b).equal, true);
});

test('initialized unreachable heap allocations are rejected by canonical generator', () => {
  const s = fresh();
  heap(s, INT, { kind: 'scalar', value: 7 }, true);
  assert.throws(() => generate(s), /initialized heap allocation .* is unreachable/);
});

test('pointer target subobject path is part of grading', () => {
  const a = fresh();
  const aa = stack(a, 'arr', array(INT, 2), { kind: 'aggregate', elements: [{ kind: 'scalar', value: 1 }, { kind: 'scalar', value: 2 }] });
  stack(a, 'p', pointer(INT), pointerValue(ref(aa.id, [0])));
  const b = fresh();
  const ba = stack(b, 'arr', array(INT, 2), { kind: 'aggregate', elements: [{ kind: 'scalar', value: 1 }, { kind: 'scalar', value: 2 }] });
  stack(b, 'p', pointer(INT), pointerValue(ref(ba.id, [1])));
  assert.equal(equivalent(a, b).equal, false);
});

// Control-flow regression tests added for PointerViz 2.2.
test('if/else executes exactly one branch and comparison expressions return int truth values', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'Declaration', declarations: [{ name: 'x', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'If', condition: { kind: 'Binary', operator: '<', left: { kind: 'IntLiteral', value: 2 }, right: { kind: 'IntLiteral', value: 3 } },
      consequence: { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '=', left: { kind: 'Identifier', name: 'x' }, right: { kind: 'IntLiteral', value: 10 } } },
      alternative: { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '=', left: { kind: 'Identifier', name: 'x' }, right: { kind: 'IntLiteral', value: 20 } } } },
  ] };
  const { state } = executeProgram(program);
  assert.equal(state.allocations.find(a => a.name === 'x').value.value, 10);
});

test('while repeats its body until the condition becomes false', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'Declaration', declarations: [{ name: 'i', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'Declaration', declarations: [{ name: 'sum', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'While', condition: { kind: 'Binary', operator: '<', left: { kind: 'Identifier', name: 'i' }, right: { kind: 'IntLiteral', value: 4 } }, body: {
      kind: 'Block', statements: [
        { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '+=', left: { kind: 'Identifier', name: 'sum' }, right: { kind: 'Identifier', name: 'i' } } },
        { kind: 'ExpressionStatement', expression: { kind: 'Update', operator: '++', prefix: false, expression: { kind: 'Identifier', name: 'i' } } },
      ],
    } },
  ] };
  const { state } = executeProgram(program);
  assert.equal(state.allocations.find(a => a.name === 'i').value.value, 4);
  assert.equal(state.allocations.find(a => a.name === 'sum').value.value, 6);
});

test('for supports declaration initializer, condition, update, and block lifetime', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'Declaration', declarations: [{ name: 'sum', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'For',
      initializer: { kind: 'Declaration', declarations: [{ name: 'i', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
      condition: { kind: 'Binary', operator: '<', left: { kind: 'Identifier', name: 'i' }, right: { kind: 'IntLiteral', value: 3 } },
      update: { kind: 'Update', operator: '++', prefix: false, expression: { kind: 'Identifier', name: 'i' } },
      body: { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '+=', left: { kind: 'Identifier', name: 'sum' }, right: { kind: 'Identifier', name: 'i' } } } },
  ] };
  const { state, snapshots } = executeProgram(program);
  assert.equal(state.allocations.find(a => a.name === 'sum').value.value, 3);
  assert.equal(state.allocations.find(a => a.name === 'i').alive, false);
  assert.ok(snapshots.some(s => s.statement === 'ForUpdate'));
});

test('break and continue use C loop behavior, including for-update after continue', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'Declaration', declarations: [{ name: 'i', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'Declaration', declarations: [{ name: 'sum', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'For', initializer: null,
      condition: { kind: 'Binary', operator: '<', left: { kind: 'Identifier', name: 'i' }, right: { kind: 'IntLiteral', value: 10 } },
      update: { kind: 'Update', operator: '++', prefix: false, expression: { kind: 'Identifier', name: 'i' } },
      body: { kind: 'Block', statements: [
        { kind: 'If', condition: { kind: 'Binary', operator: '==', left: { kind: 'Identifier', name: 'i' }, right: { kind: 'IntLiteral', value: 2 } }, consequence: { kind: 'Continue' }, alternative: null },
        { kind: 'If', condition: { kind: 'Binary', operator: '==', left: { kind: 'Identifier', name: 'i' }, right: { kind: 'IntLiteral', value: 5 } }, consequence: { kind: 'Break' }, alternative: null },
        { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '+=', left: { kind: 'Identifier', name: 'sum' }, right: { kind: 'Identifier', name: 'i' } } },
      ] } },
  ] };
  const { state } = executeProgram(program);
  assert.equal(state.allocations.find(a => a.name === 'i').value.value, 5);
  assert.equal(state.allocations.find(a => a.name === 'sum').value.value, 8);
});

test('logical && and || short-circuit unsafe operands', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'Declaration', declarations: [{ name: 'p', type: pointer(INT), initializer: { kind: 'NullLiteral' } }] },
    { kind: 'Declaration', declarations: [{ name: 'x', type: INT, initializer: { kind: 'IntLiteral', value: 0 } }] },
    { kind: 'If', condition: { kind: 'Binary', operator: '&&', left: { kind: 'Identifier', name: 'p' }, right: { kind: 'Dereference', expression: { kind: 'Identifier', name: 'p' } } }, consequence: { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '=', left: { kind: 'Identifier', name: 'x' }, right: { kind: 'IntLiteral', value: 1 } } }, alternative: null },
    { kind: 'If', condition: { kind: 'Binary', operator: '||', left: { kind: 'IntLiteral', value: 1 }, right: { kind: 'Dereference', expression: { kind: 'Identifier', name: 'p' } } }, consequence: { kind: 'ExpressionStatement', expression: { kind: 'Assignment', operator: '=', left: { kind: 'Identifier', name: 'x' }, right: { kind: 'IntLiteral', value: 2 } } }, alternative: null },
  ] };
  const { state } = executeProgram(program);
  assert.equal(state.allocations.find(a => a.name === 'x').value.value, 2);
});

test('loop iteration guard stops an empty infinite loop', () => {
  const program = { kind: 'Program', function: 'main', statements: [
    { kind: 'While', condition: { kind: 'IntLiteral', value: 1 }, body: { kind: 'Empty' } },
  ] };
  assert.throws(() => executeProgram(program), /loop exceeded 256 iterations/);
});

// Function/struct regression tests added for PointerViz 2.1.
test('user function creates a separate frame and updates caller memory through a pointer', () => {
  const Node = { kind: 'struct', name: 'Node', fields: [
    { name: 'value', type: INT },
    { name: 'next', type: pointer({ kind: 'struct', name: 'Node' }) },
  ] };
  const program = {
    kind: 'Program', structs: [Node], functions: [
      {
        kind: 'FunctionDefinition', name: 'set_value', returnType: { kind: 'void' },
        params: [{ name: 'p', type: pointer({ kind: 'struct', name: 'Node' }) }, { name: 'v', type: INT }],
        statements: [{ kind: 'ExpressionStatement', expression: {
          kind: 'Assignment', operator: '=',
          left: { kind: 'Member', viaPointer: true, object: { kind: 'Identifier', name: 'p' }, field: 'value' },
          right: { kind: 'Identifier', name: 'v' },
        } }, { kind: 'Return', expression: null }],
      },
      {
        kind: 'FunctionDefinition', name: 'main', returnType: INT, params: [], statements: [
          { kind: 'Declaration', declarations: [{ name: 'a', type: Node, initializer: { kind: 'InitializerList', elements: [{ kind: 'IntLiteral', value: 10 }, { kind: 'NullLiteral' }] } }] },
          { kind: 'ExpressionStatement', expression: { kind: 'Call', name: 'set_value', arguments: [{ kind: 'AddressOf', expression: { kind: 'Identifier', name: 'a' } }, { kind: 'IntLiteral', value: 20 }] } },
          { kind: 'Return', expression: { kind: 'IntLiteral', value: 0 } },
        ],
      },
    ],
  };
  const result = executeProgram(program);
  const a = result.state.allocations.find(x => x.name === 'a');
  assert.equal(a.value.fields.value.value, 20);
  const callee = result.state.frames.find(f => f.name === 'set_value');
  assert.ok(callee && !callee.active);
  assert.ok(result.snapshots.some(s => s.function === 'set_value'));
});

test('returning address of a local leaves a dangling pointer with frame provenance', () => {
  const program = {
    kind: 'Program', structs: [], functions: [
      { kind: 'FunctionDefinition', name: 'bad', returnType: pointer(INT), params: [], statements: [
        { kind: 'Declaration', declarations: [{ name: 'x', type: INT, initializer: { kind: 'IntLiteral', value: 3 } }] },
        { kind: 'Return', expression: { kind: 'AddressOf', expression: { kind: 'Identifier', name: 'x' } } },
      ] },
      { kind: 'FunctionDefinition', name: 'main', returnType: INT, params: [], statements: [
        { kind: 'Declaration', declarations: [{ name: 'p', type: pointer(INT), initializer: { kind: 'Call', name: 'bad', arguments: [] } }] },
        { kind: 'Return', expression: { kind: 'IntLiteral', value: 0 } },
      ] },
    ],
  };
  const result = executeProgram(program);
  const p = result.state.allocations.find(x => x.name === 'p');
  const target = result.state.allocations.find(x => x.id === p.value.target.allocationId);
  assert.equal(target.name, 'x');
  assert.equal(target.alive, false);
  assert.notEqual(target.storage.frameId, 'main');
});


test('canonical generator emits named struct definitions and field assignments', () => {
  resetAllocationIds();
  const Node = { kind: 'struct', name: 'Node', fields: [
    { name: 'value', type: INT },
    { name: 'next', type: pointer({ kind: 'struct', name: 'Node' }) },
  ] };
  const s = makeState({ Node });
  const a = addAllocation(s, {
    name: 'a', type: Node, storage: { kind: 'stack', frameId: 'main' },
    value: { kind: 'aggregate', fields: { value: { kind: 'scalar', value: 5 }, next: { kind: 'null' } } },
  });
  const c = generate(s);
  assert.match(c, /struct Node \{/);
  assert.match(c, /struct Node \*next;/);
  assert.match(c, /struct Node a;/);
  assert.match(c, /a\.value = 5;/);
  assert.match(c, /a\.next = NULL;/);
});

if (!process.exitCode) console.log(`\n${passed} core tests passed.`);
