# Maintainer guide

This guide explains what each main file owns and where changes should be made.

## 1. Maintainability rules

1. **`MemoryState` is semantic truth.** React Flow is a view/editor, not the execution model.
2. **Tree-sitter is syntax-only.** Convert its nodes to PointerViz AST in `language/parser.js`.
3. **Keep type rules shared.** Do not create separate pointer/type semantics in the UI.
4. **Preserve lifetime provenance.** Freed/expired allocations stay in semantic state.
5. **Bound browser execution below the UI.** Parser/interpreter limits must protect direct source input.
6. **Control flow belongs in the interpreter.** Do not simulate branches/loops by rewriting source.
7. **Add core and parser integration tests for semantic changes.**

## 2. Source tree

```text
src/
├── App.jsx
├── main.jsx
├── styles.css
├── components/
│   ├── Sandbox.jsx
│   ├── MemoryCanvas.jsx
│   ├── Challenges.jsx
│   └── LevelEditor.jsx
├── data/
│   └── levels.js
├── flow/
│   ├── layout.js
│   ├── routing.js
│   └── memoryFlow.jsx
├── language/
│   ├── limits.js
│   ├── parser.js
│   └── types.js
├── machine/
│   ├── memory.js
│   └── interpreter.js
└── pipeline/
    ├── interpreter.js
    ├── ir.js
    ├── codegen.js
    └── equivalence.js
```

## 3. Main files

### `src/main.jsx`

React entry point. Mounts `<App />` and imports global styles. It contains no C semantics.

### `src/App.jsx`

Application shell. Initializes Tree-sitter once, owns top-level navigation and renders Sandbox, Challenges or Level editor.

### `src/styles.css`

Shared UI styling. Keep the interface restrained; colors should primarily communicate memory semantics rather than decoration.

### `src/language/limits.js`

Single source for browser-safety limits:

- array length;
- heap elements;
- struct fields;
- call depth;
- loop iterations;
- trace/statement size.

If a limit changes, update `SUPPORTED_C.md` and boundary tests.

### `src/language/types.js`

Canonical type representation and type helpers. Owns primitive/pointer/array/struct constructors, type equality, teaching-machine `sizeof`, declaration printing and identifier validation.

Add a new type category here before teaching the parser/interpreter/UI about it.

### `src/language/parser.js`

Tree-sitter C → PointerViz Mini-C AST adapter.

It:

1. parses source;
2. collects struct tags in two passes;
3. parses function definitions;
4. normalizes declarations, expressions and statements;
5. emits line-aware unsupported-syntax errors.

Control-flow nodes currently normalized here include `If`, `While`, `For`, `Break` and `Continue`. `for` initializers are normalized to either a declaration or expression statement.

**Rule:** no other module should depend on Tree-sitter node names.

### `src/machine/memory.js`

Canonical memory model and memory operations. Owns:

- `MemoryState`;
- call-frame records;
- stack/heap allocations;
- aggregate values;
- references/subobject paths;
- reads/writes;
- pointer status and edge derivation.

A reference is always semantic:

```js
{ allocationId: 'a2', path: [1, 'next'] }
```

Never replace this with raw addresses or React Flow IDs.

### `src/machine/interpreter.js`

Executes Mini-C AST.

Main responsibilities:

- function calls and call frames;
- lexical scopes and variable lookup;
- stack-object lifetime;
- lvalue/rvalue evaluation;
- pointers, arrays, structs and heap operations;
- `if`, `while`, `for`, `break`, `continue`, `return`;
- expression truthiness and short-circuit logic;
- trace events and execution snapshots;
- execution safety guards.

#### Control-flow execution

`execStatement()` returns normal completion or an internal control signal. Loops consume `break`/`continue`; functions consume `return`.

Use `execEmbeddedStatement()` for a branch/loop body that is not already handled by block traversal. It ensures executed non-block statements receive snapshots.

Every loop must call `guardLoopIteration()`. Do not add an unbounded execution path.

For `for`, preserve this order:

```text
initializer
condition
body
update
condition
...
```

`continue` jumps to the update; `break` skips it.

Logical `&&` and `||` must stay short-circuiting. Evaluating both operands eagerly can turn safe code such as `p && *p` into an invalid dereference.

### `src/pipeline/interpreter.js`

Public C-to-memory facade:

```text
parseMiniC(source) → executeProgram(ast)
```

UI code should normally call this rather than parser/machine internals directly.

### `src/pipeline/ir.js`

Compatibility re-export for memory-model helpers. Canonical implementation remains in `machine/memory.js`.

### `src/pipeline/codegen.js`

Validates an editable memory state and emits one equivalent canonical C program.

It handles declarations, aggregate/scalar initialization, aliases, heap allocation and free. It deliberately does **not** reconstruct arbitrary function bodies or control-flow history from runtime snapshots, because that information is absent from the memory graph.

### `src/pipeline/equivalence.js`

Challenge grader. Compares semantic memory graphs rather than source text. Heap object IDs are matched up to graph relabelling; stack identity, values, types, pointers and configured lifetime rules are compared semantically.

Update this whenever a new semantic property should affect correctness.

### `src/flow/memoryFlow.jsx`

React node/edge components. Renders frame headers, fixed-size allocation rows, target/source handles and SVG pointer indicators. Refreshes handle geometry after type/shape changes. Internal heap IDs use display labels such as `heap 1`.

It must not own semantic mutations.

### `src/flow/layout.js` and `src/flow/routing.js`

The pure adapter filters visible lifetimes, sizes frames and cells, assigns separate slots per invocation, clamps parent-relative locals, and derives handle/edge data. The router scores orthogonal lanes against boxes and frame headers and rounds the chosen path. Keep `GEOMETRY` in sync with CSS.

These files have no React dependency and are tested directly. See [VISUALIZATION.md](VISUALIZATION.md) for routing and visibility boundaries.

### `src/components/MemoryCanvas.jsx`

Interactive memory editor. Clones semantic state before edits and uses shared type/pointer rules. Owns the current state's drag positions, selection, Show expired toggle, and viewport fitting. Resets positions on semantic state changes; accepts frame drags and clamps local drags. Dead locals cannot be edited or dragged. GUI coordinates remain outside `MemoryState`.

### `src/components/Sandbox.jsx`

Bidirectional workbench. Owns source text, current state, snapshots and current step. Its reusable `CodePanel` provides four-space Tab indentation and is shared by challenge/editor code inputs.

### `src/components/Challenges.jsx`

Student challenge runner. Both target and student answers are reduced to `MemoryState` and graded with `equivalent()`.

### `src/components/LevelEditor.jsx`

Instructor challenge authoring. Reference C is interpreted live before a level can be saved.

### `src/data/levels.js`

Built-in levels plus browser persistence. Target states are kept as readable C and interpreted at runtime. Custom content/progress use `pointerviz.*` localStorage keys.

## 4. Common changes

### Add an expression

1. normalize it in `language/parser.js`;
2. evaluate/type-check it in `machine/interpreter.js`;
3. add parser-independent semantic tests;
4. add at least one Tree-sitter integration source case;
5. update `SUPPORTED_C.md`.

### Add a statement/control construct

1. define its PointerViz AST shape in the parser;
2. execute it in `execStatement()` or a focused helper;
3. define how `return`/`break`/`continue` propagate;
4. define snapshot behavior;
5. bound repeated execution;
6. test nesting, functions and edge cases;
7. document it.

### Add a type

1. extend `language/types.js`;
2. extend default/aggregate values in `memory.js`;
3. extend parsing;
4. extend lvalue/rvalue semantics;
5. extend code generation/validation;
6. extend visualization and grading;
7. add tests.

### Change the memory diagram

First decide whether the change is semantic or visual:

- semantic → `MemoryState` / machine logic;
- visual → `flow/layout.js`, `flow/routing.js`, `memoryFlow.jsx` or `MemoryCanvas.jsx`.

Never fix a wrong arrow only in React Flow if the stored pointer is wrong.

## 5. Testing checklist

Before a merge:

```bash
npm test
npm run build
```

The layout suite checks frame separation, containment, visibility and routing. The flow integration suite feeds parsed C snapshots into the adapter. [TESTING.md](TESTING.md) lists browser checks for dragging, stepping and handle geometry. GitHub CI runs tests/build on Windows and Linux with Node 22 and 24.

Also manually check:

1. basic pointer conversion;
2. an array at 64 elements and one above it;
3. function call frames and an escaped local pointer;
4. a self-referential struct and `.`/`->` access;
5. `if` with both true/false branches;
6. `while` with zero and several iterations;
7. `for` with declaration and expression initializers;
8. `break` and `continue` in nested loops;
9. short-circuit `p && *p` when `p == NULL`;
10. an intentional infinite loop reaching the iteration guard.

## 6. Known boundaries

- `do ... while`, `switch`, `goto` and ternary expressions are not implemented.
- Struct ABI padding is not modelled.
- Diagram-to-code does not synthesize arbitrary function/control-flow source from runtime frames.
- Manual diagram editing can use struct definitions present in state, but does not define new struct tags from scratch.
- Advanced source using same-name shadowing/reuse can leave multiple historical stack allocations with the same source name. Execution can represent those lifetimes, but such states are not intended as diagram-to-code challenge targets yet.
