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
  structTypes: {}
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

This is semantic history, independent of visibility. The canvas hides returned frames by default and can reveal them with Show expired.

### Allocation

```js
{
  id: 'a2',
  name: 'node',
  type: { kind: 'struct', name: 'Node' },
  storage: { kind: 'stack', frameId: 'main' },
  alive: true,
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
```

A pointer stores this semantic reference rather than a React Flow handle or real address.

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
  function: 'main',
  frameId: 'main',
  statement: 'ExpressionStatement',
  events: [...],
  state: {...}
}
```

For-loop update expressions use `statement: 'ForUpdate'`.

Typical control-flow trace events include:

```js
{ kind: 'Condition', statement: 'while', result: true, iteration: 2 }
{ kind: 'LoopIteration', statement: 'for', iteration: 3 }
{ kind: 'Break', ... }
{ kind: 'Continue', ... }
```

Snapshots clone the full state so the UI can replay execution without re-running the program.

## 8. Presentation state

The canvas stores positions separately, keyed by React Flow node ID for the current MemoryState object only. A frame position is absolute; a stack allocation position is relative to its parent frame. Semantic state transitions discard these positions, including when revisiting a snapshot.

Frame width/height and local clamping come from the pure layout adapter. Edges store a derived SVG path and semantic source/target handle IDs; they are never serialized into MemoryState or used for grading. See [VISUALIZATION.md](VISUALIZATION.md).
