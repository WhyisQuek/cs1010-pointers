# PointerViz 2.2.1

PointerViz is a browser-based teaching tool for visualizing C memory. It uses a deterministic Mini-C interpreter rather than running native C.

It supports:

- step-by-step C-to-memory visualization;
- editable memory diagrams and canonical C generation;
- pointers, arrays, heap allocations and pointer arithmetic;
- simulated object/pointer addresses shown alongside pointer arrows;
- array sizes inferred from initializer lists, such as `int arr[] = {1, 2, 3};` and `int rows[][2] = {{1, 2}, {3, 4}};` (up to 64 elements per dimension);
- functions and separate call-stack frames;
- named and self-referential structures;
- struct typedefs such as `typedef struct { int value; } Node;` and `Node *p;`;
- `if`/`else`, `while` and `for` control flow;
- `break`, `continue` and common condition operators;
- code-to-diagram and diagram-to-code challenges;
- instructor-created challenge levels.

## Run locally

Requires Node.js 22 (22.12 or later) or 24 and npm. From the repository root:

```bash
npm ci
npm run dev
```

Open the **HTTP** URL printed by Vite, normally `http://127.0.0.1:3000/` with the supplied configuration.

## Test and check

```bash
npm run check
npm run build
```

`npm run check` runs ESLint, the Prettier format check and every test suite. Use `npm test` for tests only and `npm run format` to apply formatting. The integration suites use `web-tree-sitter` and therefore require the npm dependencies to be installed.

Browser smoke tests use Playwright against the production build served at the GitHub Pages path:

```bash
npx playwright install chromium
npm run test:e2e
```

See [TESTING.md](docs/TESTING.md).

## Publish for testing

PointerViz can run on GitHub Pages with no backend. The deployment workflow
tests and builds the app before publishing on pushes to `main`. Enable
**Settings → Pages → GitHub Actions** in an eligible repository first.
See [the deployment guide](docs/DEPLOYMENT.md) for the free-tier requirements,
production preview, tester checklist, and moving to another host later.

## Memory canvas

The code and memory panes are separated by a divider: drag it to resize, double-click it to reset, or drag it fully left to collapse the code pane into a rail. **Run** (code header) starts playback at step zero; **Generate C** (memory header) writes C for the memory currently on screen, including the selected playback step.

Cards show addresses alongside arrows. Select a name/member to open the inspector, which floats over the canvas and shows the object's own address, a pointer's stored address, its target and the target value. The inspector's typed Target picker sets pointers in editable diagrams; numeric addresses are read-only. Try [the memory-address examples](examples/memory-addresses.md).

Drag a function header to move its frame and locals together. Select a frame to resize it from any edge or corner. Variables move freely in both directions; their frame grows to accommodate them. Layout survives memory edits and playback steps. The canvas controls (bottom left) zoom, fit the view, undo, redo and reset layout. Undo and redo (also Ctrl+Z / Ctrl+Shift+Z) follow one timeline covering both layout changes and diagram edits (values, pointer targets, names and types, adding, deleting, Mark as freed, and Clear diagram). The sandbox keeps its code, diagram and playback when you switch to another tab, and restores your code and edited diagram after a reload.

If a program fails at runtime (for example a NULL dereference or a use after free), **Run** still opens playback, at the step where execution stopped; the failing line is highlighted in red, and Previous steps back through what led to it.

Returned frames and expired stack locals are hidden by default. When there are any, a **Show out-of-scope** button appears at the top of the canvas; dangling pointers keep their status even when their target is hidden. Freed heap objects remain visible. Freed and out-of-scope boxes can be moved like any other, but their contents are read-only. In an editable diagram, the inspector for a freed heap block offers **Mark as not freed** (a diagram edit; C has no way to un-free memory) and **Delete object**.

Arrows choose attachment sides automatically and use smooth curves with obstacle-aware detours. Select an arrow and drag its diamond to bend it, or drag its arrowhead to reconnect it. **Edit** makes an editable copy of a playback step. While editing, **+ Variable** and **+ Heap block** float at the top of the canvas; right-click inside an active frame to add a variable at that position, or on empty canvas to add a heap block or clear the diagram. Yellow highlights the next source line and memory changed by the current step. The editor includes C syntax colouring. See [visualization behavior and limits](docs/VISUALIZATION.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Generated files are excluded by `.gitignore`.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system layers and execution flow.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — AST, memory, frames, pointers and snapshots.
- [`docs/SUPPORTED_C.md`](docs/SUPPORTED_C.md) — supported Mini-C syntax and safety limits.
- [`docs/MAINTAINER_GUIDE.md`](docs/MAINTAINER_GUIDE.md) — main files, extension points and testing.
- [`docs/VISUALIZATION.md`](docs/VISUALIZATION.md) — frame interaction, visibility, layout and edge routing.
- [`docs/TESTING.md`](docs/TESTING.md) — automated checks and browser regression steps.
- [`docs/C_SEMANTICS_AUDIT.md`](docs/C_SEMANTICS_AUDIT.md) — C11 audit, native compiler comparisons and explicit implementation limits.
- [`docs/MEMORY_ADDRESSES_DESIGN.md`](docs/MEMORY_ADDRESSES_DESIGN.md) — simulated-address design, implementation scope, and remaining validation gates.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — GitHub Pages publishing, production preview and troubleshooting.
- [`docs/CODE_AUDIT.md`](docs/CODE_AUDIT.md) — September 2026 code audit: issues found, fixes and follow-ups.
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
