# Changelog

## Unreleased — sandbox layout

See [docs/SANDBOX_UI_PLAN.md](docs/SANDBOX_UI_PLAN.md).

### Changed

- The central Run/Generate strip is gone: **Run** is in the code header and **Generate C** in the memory header. A draggable divider resizes the code and memory panes (double-click resets; drag fully left to collapse the code pane). Challenges uses the same layout.
- The memory toolbar and edit toolbar were removed. Arrows / Both / Addresses modes were retired (addresses and arrows are always shown); Fit view and Reset layout live in the canvas controls; layout Undo/Redo is keyboard-only; Snap was removed; Show expired became a **Show out-of-scope** button that appears only when something is hidden. **+ Variable** and **+ Heap block** float over the canvas; **Clear diagram** moved to the right-click menu.
- The inspector floats over the canvas instead of shrinking it, pans just enough to keep the selected object visible, and uses shorter labels (Located at, Stores, Points to, Value).
- Messages appear once: Run and generation messages in the code pane, canvas messages as a toast. The persistent status row and duplicate message log were removed.
- Cards and frames are more compact (cards from 200 px, frames sized to their contents).

### Fixed

- Generate C used the final run state instead of the playback step on screen; it now uses the displayed memory and keeps it displayed.

## Unreleased — code audit and maintenance

See [docs/CODE_AUDIT.md](docs/CODE_AUDIT.md) for the full report.

### Fixed

- The level editor's C code was invisible: a form style also matched the editor's transparent overlay textarea.
- The level editor preview was blank until the code was first edited.
- A custom level whose code no longer parses crashed the Challenges page; it now shows an explanation.
- Blocked or full browser storage made Check answer and Save level throw; storage failures are now handled and reported.
- Imported level packs could introduce duplicate IDs and unvalidated fields; levels are normalized and IDs kept unique (existing duplicates are repaired on load).
- Editing a value to a fraction or out-of-range number stored an invalid value; inputs are now checked against the C type.
- Grading feedback exposed internal heap IDs such as `a3`; it now uses display names such as `heap 1`.
- Adding more than 26 variables could reuse an existing name.
- Syntax errors for a missing token now name it ("missing ;") instead of quoting empty text.
- Exported level packs no longer leak an object URL.
- A render error in any page no longer blanks the whole app.

### Maintenance

- Adopted Prettier and ESLint (`npm run lint`, `npm run format`, `npm run check`); CI enforces both.
- Moved every suite onto Node's test runner; `npm test` runs `test/*.test.js`.
- Removed dead code: the `pipeline/ir.js` shim, the no-op `resetAllocationIds`, and nine unused exports; de-duplicated path helpers, primitive type lists, frame minimum sizes and view-mode handling.
- Extracted `CodePanel` from the sandbox; replaced level-editor inline styles with CSS classes; removed unused CSS rules.
- Parser initialization now requires explicit WASM paths (root-relative defaults break subpath deployments).
- Split React, React Flow and Tree-sitter into separate cacheable build chunks (removes the >500 kB warning).
- Applied non-breaking `npm audit` fixes to dev dependencies.
- Upgraded to Vite 8 (Rolldown) and `@vitejs/plugin-react` 6, clearing the last `npm audit` advisory; Node.js 22.12 or later is now required.
- The Tree-sitter runtime WASM is imported from the `web-tree-sitter` package instead of a vendored copy in `public/`, removing a duplicate 205 kB asset and version drift.
- Added Playwright browser smoke tests (`npm run test:e2e`) against the production build under the Pages path, with a CI job.
- Split the interpreter into `machine/execution/` and the parser into `language/parse/` by concern; `machine/interpreter.js` and `language/parser.js` remain the entry points with unchanged APIs. Function bodies were moved verbatim.
- Updated maintainer, architecture, testing, deployment and README documentation.

## Unreleased — simulated memory addresses

- Added deterministic stack/heap addresses with LP64 array strides and struct padding, state-owned identities, and no address reuse within a run.
- Added Both (default), Arrows, and Addresses modes with stable geometry and a persisted preference.
- Added object/member inspection in playback and editing, own/stored address labels, full-address copying, typed target selection, and target/boundary/history navigation.
- Preserved allocation/path provenance, lifetime and bounds checks, canonical C generation, and address-independent challenge grading. Hardcoded pointer addresses remain unsupported.
- Made structural edits/deletion atomic around incoming and historical pointers, with focused address regression tests and teaching examples.

## 2.2.1 — frame visualization and repository maintenance

- Replaced the small pointer text glyph with a fixed SVG indicator.
- Added rounded orthogonal routing around boxes and frame headers, target-side selection, and real handles for aggregate targets.
- Made frame headers draggable; live locals stay inside their owning frame, below its header.
- Assigned distinct default slots per invocation instead of overlapping calls at the same depth.
- Hid expired stack objects by default; added Show expired without deleting lifetime provenance.
- Reset drag positions on snapshot/state changes and added Reset layout and automatic viewport fitting.
- Defined stable frame/edge/node layers and prevented editing or dragging dead locals.
- Separated pure layout/routing from React rendering and added 15 focused regression cases.
- Added GitHub CI, contribution/testing/visualization guides, an example program, and repository text/ignore settings.
- Preserved the existing dependency versions in package-lock.json; documented npm ci and Node 22/24.
- Let the integration test process exit naturally to avoid a forced-exit failure seen on Windows.

## 2.2.0 — control flow

### Language

- Added `if`/`else`, including `else if`.
- Added `while` loops.
- Added `for` loops with declaration/expression initializers and optional clauses.
- Added `break` and `continue`.
- Added lexical block/loop scopes and scope-end stack lifetime tracking.
- Added comparison operators `== != < <= > >=`.
- Added short-circuit `&&` / `||` and unary `!`.
- Added compound assignment `+= -= *= /= %=`.
- Added correct prefix/postfix `++` and `--` expression results.

### Execution and safety

- Added condition/loop trace events and branch/loop statement snapshots.
- Added a synthetic `ForUpdate` snapshot for `for` update expressions.
- Limited each loop to 256 iterations to stop accidental infinite loops.
- Preserved C `for` semantics: `continue` executes the update expression; `break` does not.

### Learning content and maintenance

- Added built-in `if` and `for` challenge examples.
- Expanded core regression coverage for branches, loops, loop control, short-circuit evaluation and infinite-loop protection.
- Reworked architecture, data-model, supported-language and maintainer documentation around the new control-flow/scoping model.

## 2.1.0 — PointerViz rename, functions and structures

### Product/UI

- Renamed the project from PointerLab/pointer&lab to **PointerViz**.
- Simplified the top bar and removed nonessential slogan/capability text.
- Reworked the visual style toward a flatter, conventional application UI.
- Added Tab/Shift+Tab indentation support to all reusable C code editors.
- Replaced visible internal heap IDs such as `a3` with `heap 1`, `heap 2`, etc.
- Reworked the type inspector so pointer depth and array length no longer compete for horizontal space.
- Added hard array-size controls; array length is limited to 64.

### Functions

- Added parsing and execution of multiple user-defined functions.
- Added named parameters and return values.
- Added explicit call frames and per-frame stack storage.
- Added statement snapshots inside called functions.
- Added stack-lifetime tracking after a function returns.
- Dangling pointers to expired locals retain their original target/frame provenance.
- Added call-depth and trace-size limits.

### Structures

- Added named `struct` declarations.
- Added two-pass struct parsing for self-referential pointers.
- Added aggregate struct storage and initialization.
- Added `.` and `->` member access.
- Added struct pointer parameters and returns.
- Added `sizeof(struct T)` and heap struct allocation support.
- Added struct rendering as field subobjects in memory nodes.
- Extended canonical main-frame code generation to emit struct definitions and field values.

### Safety/maintenance

- Added `src/language/limits.js` as the shared source of browser-safety limits.
- Heap allocations are limited to 64 logical elements.
- Struct definitions are limited to 32 fields.
- Updated grading/validation for frame-scoped variable names.
- Migrated localStorage data from legacy `pointerlab.*` keys to `pointerviz.*` keys.
- Rewrote architecture, data-model, supported-language and maintainer documentation.
- Added function/lifetime regression tests and new function/struct challenge examples.

## 2.0.1 — maintainability documentation

- Added detailed maintainer and data-model documentation.
- Documented module responsibilities, extension paths and debugging workflow.

## 2.0.0 — memory-model rebuild

- Replaced flat cells with allocation/subobject memory references.
- Preserved freed heap allocations and dangling alias provenance.
- Added arrays, heap blocks and pointer arithmetic.
- Separated Tree-sitter parsing from the semantic interpreter.
