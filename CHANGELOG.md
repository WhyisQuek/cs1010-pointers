# Changelog

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
