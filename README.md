# PointerViz 2.2.1

PointerViz is a browser-based teaching tool for visualizing C memory. It uses a deterministic Mini-C interpreter rather than running native C.

It supports:

- step-by-step C-to-memory visualization;
- editable memory diagrams and canonical C generation;
- pointers, arrays, heap allocations and pointer arithmetic;
- functions and separate call-stack frames;
- named and self-referential structures;
- struct typedefs such as `typedef struct { int value; } Node;` and `Node *p;`;
- `if`/`else`, `while` and `for` control flow;
- `break`, `continue` and common condition operators;
- code-to-diagram and diagram-to-code challenges;
- instructor-created challenge levels.

## Run locally

Requires Node.js 22 or 24 and npm. Extract the ZIP and open the `pointerviz` folder as the repository root.

```bash
npm ci
npm run dev
```

Open the **HTTP** URL printed by Vite, normally `http://127.0.0.1:3000/` with the supplied configuration.

## Test

```bash
npm test
npm run build
```

The integration suite uses `web-tree-sitter` and therefore requires the npm dependencies to be installed.

## Memory canvas

Drag a function header to move its frame and locals together. Select a frame to resize it from any edge or corner. Variables move freely in both directions; their frame grows to accommodate them. Layout survives memory edits and playback steps. **Fit view** adjusts the viewport; **Reset layout** restores default placement. Layout changes support Undo/Redo.

Returned frames and expired stack locals are hidden by default. **Show expired** reveals their history; dangling pointers keep their status even when their target is hidden. Freed heap objects remain visible.

Arrows choose attachment sides automatically and use smooth curves with obstacle-aware detours. Select an arrow and drag its diamond to bend it, or drag its arrowhead to reconnect it. **Edit this snapshot** makes an editable copy of a playback step; right-click inside an active frame to add a variable at that position. **Run** starts playback at step zero; yellow highlights the next source line and memory changed by the current step. The editor includes C syntax colouring. See [visualization behavior and limits](docs/VISUALIZATION.md).

## Start a GitHub repository

The extracted `pointerviz` folder contains the source, tests, examples, documentation, lockfile and GitHub Actions workflow. Initialize Git in that folder:

```bash
git init
git add .
git commit -m "Initial PointerViz project"
```

Create your GitHub repository and follow its instructions to add a remote and push. Generated files are excluded by `.gitignore`; no repository or remote is bundled in the ZIP. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system layers and execution flow.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — AST, memory, frames, pointers and snapshots.
- [`docs/SUPPORTED_C.md`](docs/SUPPORTED_C.md) — supported Mini-C syntax and safety limits.
- [`docs/MAINTAINER_GUIDE.md`](docs/MAINTAINER_GUIDE.md) — main files, extension points and testing.
- [`docs/VISUALIZATION.md`](docs/VISUALIZATION.md) — frame interaction, visibility, layout and edge routing.
- [`docs/TESTING.md`](docs/TESTING.md) — automated checks and browser regression steps.
- [`docs/C_SEMANTICS_AUDIT.md`](docs/C_SEMANTICS_AUDIT.md) — C11 audit, native compiler comparisons and explicit implementation limits.
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes.

## Core design rule

`MemoryState` is the semantic source of truth.

```text
C source
   ↓
Tree-sitter
   ↓
PointerViz Mini-C AST
   ↓
Interpreter
   ↓
MemoryState
   ├──→ React Flow visualization
   ├──→ challenge grading
   └──→ canonical C generation
```

React Flow positions are presentation data only. Native addresses are never used as object identity.
