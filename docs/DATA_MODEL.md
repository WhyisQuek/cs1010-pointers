# Data model

## 1. CType

Primitive:

```js
{ kind: 'primitive', name: 'int' }
```

Pointer:

```js
{ kind: 'pointer', to: { kind: 'primitive', name: 'int' } }
```

Array:

```js
{ kind: 'array', of: { kind: 'primitive', name: 'int' }, length: 3 }
```

Named struct reference:

```js
{ kind: 'struct', name: 'Node' }
```

Complete named struct definitions are stored in a struct registry instead of recursively embedding self-referential definitions.

## 2. Mini-C AST

The parser owns Tree-sitter conversion. The interpreter only sees PointerViz AST objects.

Examples:

```js
{
  kind: 'If',
  condition: expression,
  consequence: statement,
  alternative: statementOrNull
}
```

```js
{
  kind: 'While',
  condition: expression,
  body: statement
}
```

```js
{
  kind: 'For',
  initializer: declarationOrExpressionStatementOrNull,
  condition: expressionOrNull,
  update: expressionOrNull,
  body: statement
}
```

`Break` and `Continue` are statement nodes. Prefix/postfix updates share an `Update` node with a `prefix` flag.

## 3. MemoryState

```js
{
  allocations: [],
  frames: [],
  structTypes: {},
  identity: { allocation: 0, frame: 0 },
  addressSpace: {
    version: 1,
    profile: 'pointerviz-lp64-sparse-v1',
    nextStackSlot: 0,
    nextHeapSlot: 0
  }
}
```

### Frame

```js
{
  id: 'frame1',
  name: 'update',
  callerId: 'main',
  depth: 1,
  active: true
}
```

Frames remain after return with `active: false`.

This is semantic history, independent of visibility. The canvas hides returned frames by default and can reveal them with Show out-of-scope.

### Allocation

```js
{
  id: 'a2',
  name: 'node',
  type: { kind: 'struct', name: 'Node' },
  storage: { kind: 'stack', frameId: 'main' },
  alive: true,
  baseAddress: 268435456, // simulated 0x10000000
  value: ...
}
```

Heap allocations use:

```js
storage: { kind: 'heap' }
```

Heap allocations have no source-level variable name.

### Values

Scalar:

```js
{ kind: 'scalar', value: 10 }
```

Pointer:

```js
{
  kind: 'pointer',
  target: { allocationId: 'a2', path: ['next'] }
}
```

Null/uninitialized:

```js
{ kind: 'null' }
{ kind: 'uninit' }
```

Arrays and structs use aggregate values containing element/field values.

## 4. References and subobjects

A memory reference is:

```js
{ allocationId, path }
```

Examples:

```js
{ allocationId: 'a0', path: [] }             // whole object
{ allocationId: 'a0', path: [2] }            // arr[2]
{ allocationId: 'a0', path: ['next'] }       // node.next
{ allocationId: 'a0', path: [2, 'next'] }    // arr[2].next
{ allocationId: 'a0', path: ['$onePast'] }   // one past a whole singleton object
```

An array-element one-past pointer uses its array length as the last numeric path component. The reserved `$onePast` component denotes one past a scalar, struct, or whole array treated as an object of length one. It is terminal and never selects storage. Nested paths cannot continue through any one-past address. No C field identifier can collide with this marker.

A pointer stores this semantic reference rather than a React Flow handle or real address.

`referenceLocation(state, ref)` derives its numeric address from the root's `baseAddress` plus array strides and struct field offsets. `layoutOf` supplies the shared LP64 size/alignment/field layout used by `sizeof` and pointer operations. Pointer values themselves are unchanged: provenance and bounds come from the allocation ID and path, never from a numeric address lookup. Different subobjects or a one-past boundary can share a number without becoming interchangeable targets.

Each root gets a separate 64 KiB reservation in the simulated stack or heap region. This is a numeric interval, not a byte buffer or an OS page. Actual size is derived from the type. Cursors and identity counters belong to the state and are cloned with snapshots; deletion, return, and free do not rewind them. Runs start fresh. `upgradeMemoryState` normalizes legacy internal states without mutating the original; versioned metadata is validated. There is no saved-trace import format to migrate.

## 5. Scopes and lifetime

Lexical scope bindings are interpreter-only state; they are not stored in `MemoryState`.

A scope owns the stack allocations declared directly in it. When the scope ends, those allocations become `alive: false`. They remain present so a pointer can still identify an expired target.

`alive` therefore means:

- heap allocation: not yet freed;
- stack allocation: owning scope/frame still active.

A pointer whose target allocation is dead is dangling.

## 6. Control signals

Statement execution may return an internal signal:

```js
{ control: 'return', value }
{ control: 'break' }
{ control: 'continue' }
```

These are interpreter control messages only. They are not part of `MemoryState`.

## 7. Trace and snapshots

A snapshot is approximately:

```js
{
  line: 8,
  nextLine: 9,
  nextFunction: 'main',
  function: 'main',
  frameId: 'main',
  statement: 'ExpressionStatement',
  events: [...],
  state: {...}
}
```

`line` identifies the completed action; `nextLine` and `nextFunction` identify the next action, with `nextLine: null` at completion. Function entry and exit use `EnterFrame` and `LeaveFrame`. Conditions use `IfCondition`, `WhileCondition`, or `ForCondition`; for-loop update expressions use `ForUpdate`. Events belong to exactly one snapshot rather than being repeated in enclosing statements.

Typical control-flow trace events include:

```js
{ kind: 'Condition', statement: 'while', result: true, iteration: 2 }
{ kind: 'LoopIteration', statement: 'for', iteration: 3 }
{ kind: 'Break', ... }
{ kind: 'Continue', ... }
```

Snapshots hold the full state so the UI can replay execution without re-running the program. They are copy-on-write: an allocation unchanged since the previous snapshot is the same object in both, so an expired loop local is stored once rather than at every later step. Snapshot states are therefore read-only; clone one before editing it, as the diagram editor and Sandbox already do. The total number of scalars copied into snapshots is limited (see [SUPPORTED_C.md](SUPPORTED_C.md#safety-limits)).

## 8. Presentation state

The canvas keeps a presentation workspace separate from MemoryState: `positions` by node ID, `sizes` by frame ID, and manual `routes` by semantic edge ID. Frame coordinates are absolute and local coordinates are parent-relative. Arrow bends are offsets from the endpoint midpoint. These values never affect grading or canonical C generation.

The workspace survives semantic edits, stepping backward and forward, and hiding expired allocations within one execution session. New objects receive unoccupied default positions; known objects keep their positions. A new Run remounts the canvas, and Clear resets the workspace and its history. Level-editor previews use the source as their session key so IDs from separate executions cannot inherit prior layout.

Pure workspace operations expand frames around dragged locals, resize edges while preserving child world coordinates, and keep up to 50 undo steps across layout changes and diagram edits. Pointer edits still change MemoryState through typed references. Edit clones the displayed state; Back to playback restores the original recorded execution. See [VISUALIZATION.md](VISUALIZATION.md).
