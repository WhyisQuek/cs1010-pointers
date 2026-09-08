# Architecture

## 1. Layers

PointerViz keeps parsing, semantics, memory and presentation separate.

```text
C source
  │
  ▼
language/parser.js        Tree-sitter → Mini-C AST
  │
  ▼
machine/interpreter.js    semantic execution
  │
  ▼
machine/memory.js         MemoryState
  ├────────► flow/memoryFlow.jsx       React Flow view
  ├────────► pipeline/equivalence.js   challenge grading
  └────────► pipeline/codegen.js       canonical C
```

The browser never executes a native C binary.

## 2. Parser boundary

`language/parser.js` is the only module that knows Tree-sitter node shapes.

It:

1. collects named structs in two passes so self-referential pointer fields work;
2. parses functions;
3. normalizes supported statements/expressions into PointerViz-owned AST objects;
4. rejects unsupported syntax with source locations.

The interpreter must not inspect Tree-sitter nodes.

## 3. Execution model

### Call frames

Every function invocation creates a frame. Stack allocations store the owning `frameId`.

```text
main()
  └─ stack objects

update()
  └─ parameters and locals
```

When a non-main function returns, its frame becomes inactive and its stack allocations become dead. They stay in `MemoryState` so pointers to them can remain visibly dangling.

### Lexical scopes

Each block has a semantic scope containing bindings declared in that block. A `for` loop has a dedicated outer loop scope so this behaves correctly:

```c
for (int i = 0; i < 4; i++) {
    ...
}
```

When the block/loop scope ends, its owned stack allocations are marked dead rather than deleted.

### Control flow

The AST contains explicit `If`, `While`, `For`, `Break` and `Continue` statements.

The interpreter evaluates them directly:

```text
If
 ├─ evaluate condition
 └─ execute one branch

While / For
 ├─ evaluate condition
 ├─ execute body
 ├─ process break/continue/return
 └─ repeat within safety limit
```

Statement execution can return an internal control signal:

- `return` — propagated to the current function call;
- `break` — consumed by the nearest loop;
- `continue` — consumed by the nearest loop.

For a `for` loop, `continue` still runs the update expression, matching C behavior.

`&&` and `||` short-circuit inside expression evaluation so skipped operands do not execute.

## 4. Trace and snapshots

Semantic operations emit trace events such as:

- `Condition`;
- `LoopIteration`;
- `Declare`;
- `Write`;
- `EnterFrame` / `LeaveFrame`;
- `EndLifetime`;
- `Break` / `Continue` / `Return`.

Snapshots contain a cloned `MemoryState` for deterministic step-through playback. Statements inside branches/loops are snapshotted as they actually execute. A `for` update is represented by the synthetic snapshot kind `ForUpdate`.

## 5. Structures and subobjects

Named struct definitions live in `MemoryState.structTypes`. Arrays and structs are aggregate allocations rather than separate fake variables.

References use a root allocation plus a path:

```js
{ allocationId: 'a0', path: [2] }        // array element
{ allocationId: 'a0', path: ['next'] }   // struct field
{ allocationId: 'a0', path: [2, 'next'] }
```

Pointers store these references. This preserves array contiguity, fields and pointer provenance without real machine addresses.

## 6. Presentation

`MemoryState` contains no GUI coordinates. `flow/layout.js` derives visible frames, allocation nodes, subobject handles and pointer edges. `flow/routing.js` chooses rounded orthogonal routes; `flow/memoryFlow.jsx` renders the React components.

The live view filters expired stack objects without removing their semantic records. An optional history view exposes them. Every visible call has a separate layout slot. Locals use parent-relative coordinates and are clamped inside the frame. Drag positions reset on state/snapshot changes.

See [visualization behavior](VISUALIZATION.md) for lifetime visibility, routing limits and presentation invariants.

Internal allocation IDs such as `a3` are hidden. Heap allocations are labelled `heap 1`, `heap 2`, etc. for display only.

## 7. Safety

Shared limits live in `language/limits.js`:

- array length: 64;
- heap elements: 64;
- struct fields: 32;
- call depth: 32;
- iterations per loop: 256;
- visualized statements: 500.

Limits belong in parser/interpreter code, not only the UI, because source input can bypass form controls.

## 8. Reverse-generation boundary

A memory state does not contain arbitrary original function bodies or control-flow structure. Therefore canonical diagram-to-code generation is intentionally limited:

- ordinary final `main` memory diagrams can generate equivalent C;
- execution snapshots from functions/control flow can be visualized and graded;
- runtime frames are not reverse-engineered into invented function/loop source.

This keeps generation based only on information actually present in the memory graph.
