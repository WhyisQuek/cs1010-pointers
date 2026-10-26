# Changelog

## Unreleased — fixes

### Fixed

- A code → diagram level whose answer has a one-past-the-end pointer is reported as undrawable instead of being impossible to solve: the diagram editor's target picker cannot choose a one-past boundary.
- A loop that declares a large array no longer exhausts the browser's memory. Every step copied all of memory, including expired loop locals, so `for (int i = 0; i < 40; i++) { int a[64][64]; }` held about 1.2 GB. Steps now share every object that did not change since the step before (copy-on-write), so the same loop holds about 40 MB, and 120 iterations run to completion in about 0.5 s. As a safety net, execution stops with a limit error once the steps have copied more than 2,048,000 scalars in total (the largest object changing at every one of the 500 steps); playback up to that point is kept.
- Pointer arithmetic through a pointer whose type does not match the object it points into is reported as not supported. A `char *` obtained through `void *` from an `int a[2]` used to step over the whole array, so `p + 1` showed an address 8 bytes on, with no warning. Subtraction and ordering of such pointers are reported the same way, unless both are at the same position.
- A one-past-the-end pointer keeps its array through `void *`. `int *q = (void *)(a[0] + 2)` used to become `&a[1][0]`, so `*q` read the next row instead of being reported as out of bounds.
- Only the pointer passed to `free` may be dangling. Reads while computing it used to skip the check, including inside a called function, so `free(ignore(p))` on a freed `p` was accepted. `free(p); free(p);` still reports a double free.
- `i = malloc(i++) != NULL;` is accepted: the argument's side effects finish before the call, as they already did for `calloc` and user functions. It used to report unsequenced modifications.
- Generated C keeps the sign of a negative zero (`x = -0.0;`), which `printf` shows. It used to emit `0.0`.
- Using a malloc block as a second type before anything is stored in it (for example converting it to both `int *` and `double *`, then storing a `double`) is reported as not supported rather than undefined behavior. C sets a malloc block's type at its first store; PointerViz sets it at the first conversion, and [SUPPORTED_C.md](docs/SUPPORTED_C.md) now says so instead of attributing that to C23 6.5p6.
- Editing code during playback keeps the selected step's memory on screen and says that playback ended. The diagram used to jump to the program's final state, with no message, and that state was saved as the draft diagram.
- The code editor is no longer a keyboard trap: Escape then Tab (or Shift+Tab) moves focus out, and the editor's accessible description says so. Tab alone still indents.
- Grading no longer freezes on answers with many similar heap blocks. Heap matching tried every pairing of blocks, so nine identical leaked blocks took about 3 seconds and each extra block multiplied that by ten. It now stops at a perfect match, tries the cheapest pairings first, cuts branches that cannot beat the best so far, and tries only one of any set of blocks that cannot be told apart. Twenty such blocks compare in milliseconds, right or wrong. A search that still runs past 100,000 steps reports that it could not finish rather than guessing a mismatch.
- A new call frame no longer opens on top of a heap block. Heap blocks keep the place they got when allocated, so in deep recursion (a recursive BST insert) later frames used to land on them; a new frame now skips past any heap block's column.

### Internal

- `setRefValue` writes through the location `resolveRef` already found instead of walking the path a second time.
- Duplicate-function and missing-`main()` checks moved from the parser to the checker (the parser now only handles syntax), and duplicated runtime checks and unreachable branches were removed from the interpreter. No behaviour change.

### Added

- Optional usage telemetry. With `VITE_TELEMETRY_URL` set at build time, **Run**, **Generate C** and **Check answer** send anonymous events (the code, memory state or answer, and the outcome) to a Cloudflare Worker that stores them in D1 (`telemetry/`). A notice tells students their code is recorded for research and that no personal information is collected. Off by default; see [TELEMETRY.md](docs/TELEMETRY.md).
- **Structure** in the View menu draws linked lists and trees in their own shape. Any struct with a member pointing to its own type counts as a node type, whatever the names: one forward link gives a chain, two give a binary tree in in-order columns (so a BST reads sorted left to right), more give a wider tree; `parent`/`prev` links and links that only mirror another (a doubly linked list) are drawn but not followed. Nodes are compact cards (their fields, then one slot per link), the heap sits below the frames, and the layout is recomputed at every step, so nothing can be dragged. Structure is for playback: an editable diagram shows Arrows.
- Structure view shows the call stack as a column beside the heap, one line per scalar or pointer local, with numbered recursive calls (`insert() #2`) and the newest call marked running. Runs of recursive calls between `main` and the two newest calls fold into one row (`insert() × 3`) that expands on request. A stack variable pointing at a list or tree node becomes a label in a band inside the node's card instead of an arrow (named with its frame only when several frames are shown), and hovering it highlights the variable. List nodes are drawn as `[ 10 | next ● ]` boxes joined by straight arrows. Live nodes that no pointer reaches for the rest of the run are marked unreachable and set apart.
- `calloc(n, size)`: a zero-filled heap block whose objects start as `0`, `0.0`, `false` or `NULL` once it takes a type. A zero argument returns `NULL` like `malloc(0)`, and a product too large for `size_t` returns `NULL`. `calloc` is now a reserved name.
- Challenge sections. Levels have an optional `section`, set in the Level editor (which suggests the existing names), and the Challenges list groups cards under section headings. Each heading shows its completed count and a small progress bar beside it, both turning green when the section is finished; sections are separated by space rather than rules. Cards show their number, a small direction tag and a ✓ when completed (replacing the "✓ Completed" badge), and the list is at most 1300px wide so a section's cards stay together on wide screens. Sections keep the order they are first used in, so a course level can join a built-in section by its exact name; levels without one are listed last under **More challenges**. Numbering and **Next challenge** follow the grouped order. The built-in levels are in six sections: Basics, Arrays, Functions, Heap, Structs and Linked lists.
- Separate student and instructor builds. The student app (`npm run build`) has Sandbox and Challenges and contains no Level editor code; the instructor app (`npm run build:instructor`, `npm run dev:instructor`) adds the Level editor. CI checks the student build with `npm run check:editions`. The instructor site must be hosted behind access control.
- Course levels: `public/levels/course.json` (a pack exported from the Level editor) is loaded at startup and listed for every student after the built-in levels. Students no longer see levels saved in their own browser.
- Saved levels can be edited in the Level editor instead of only deleted. Editing a level's code, direction or grading clears its completion.
- A **View** menu on the canvas brings back the Both / Arrows / Addresses views. Arrows hides numeric addresses, names each pointer's target (`→ x`) and drops the aggregate Address column. Addresses hides arrows except those leaving the selected box. Boxes keep their size and position in every view. The choice applies to every canvas and is remembered in the browser; it is not part of the diagram or undo history.

### Changed

- The built-in challenges were overhauled: 18 levels (was 12) in six tiers — basics, arrays, functions, heap, structs and linked lists — reaching list reversal, unlinking and freeing, `int **` out-parameters, pass-by-value, leaks, shallow struct copies and dangling pointers into returned frames. The two levels with little pointer content ("Choose a target", "Fill an array") were removed, and diagram → code levels now target memory that needs a particular mechanism (`free`, a returned frame, a one-past pointer, nameless heap nodes) rather than one that can be copied out as declarations. Reworked levels have new IDs, so completion of the old versions is not carried over; "Write the arrow", "Pointers move" and "Linked structure" are unchanged. See [docs/CHALLENGE_REVIEW.md](docs/CHALLENGE_REVIEW.md).
- Challenge progress is completion only. Stars are gone: they could be farmed by leaving and re-entering a level, which reset the attempt count. Earlier star records are not carried over.
- The Challenges list is tidier. Card content starts at the top (cards are buttons, which centred their content, so shorter cards sat lower). Each card shows its number and direction, the title, and a **topic** (what the level teaches) instead of the instructions; completed levels get a green **✓ Completed** badge, and the heading says how many are completed. Levels have a new optional `topic` field, set in the Level editor; the instruction moved to the challenge header, and a level without one gets a default for its direction. The built-in levels have topics, and their instructions no longer give hints away.
- Grading feedback says where an answer is wrong without giving the answer away: `'x' has the wrong value`, `'p' points to the wrong place`, `Variable 'x' has the wrong type`, `The number of heap blocks is wrong`, instead of the expected value, target, type or count. Missing and unexpected variables are still named, since the level already shows those names.
- The challenge header reads **← Challenges**, **Show hint (2 left)** and **Check answer**. Hints appear as "Hint 1 of 2" in normal text instead of a monospace log line.
- Check results: **Incorrect code** / **Incorrect diagram** (with the differences and the attempt number), **Your code doesn’t run** (with the error) when the code fails before it can be compared, and **Challenge complete!** with a **Next challenge** button.
- Challenges stays loaded while another tab is open, so an answer in progress survives a tab switch. Returning to the tab refreshes the level list, and closes an open level that was deleted or edited meanwhile.
- The Level editor preview updates once typing pauses instead of on every keystroke, and keeps its view while the result is unchanged.
- After a Check, editing the answer clears the red markers and marks the verdict as out of date.
- The unused grading options `compareStorage`, `compareValues` and `comparePointerRelationships` were removed; values and pointer targets are always graded.
- The inspector matches the cards. The object's own address moved into the heading line (`0x10010000 · 8 bytes · main()`, with a copy button). The Memory block shows the stored address in a blue slot with `→ target` beneath it; the target name is the link that shows it in the diagram (the Show button is gone), dangling targets read `→ heap 1 (freed)` in red, and `*p` shows its value in a slot or "cannot dereference". The "Simulated addresses" sentence became an ⓘ next to the Memory heading. Edit fields use a label-and-control grid (Value/Target, Name, Type, Shape), and Target options drop the repeated type. The whole panel shares one label column and one 30px control height, so every value and control starts on the same edge and labels are centred on their slots; slots are roomier and their text is optically centred (CSS `text-box` trimming corrects the monospace font's uneven ascent and descent, which left values about 2px high), the array length is a single `[ 3 ]` field, and the ‹ › member buttons are outlined. The Memory block labels a non-pointer's value **Value** (the heading already names it) and keeps `p` / `*p` for pointers.
- Pointer captions on cards are shorter: `→ heap 1 (freed)` / `(out of scope)` instead of "dangling · former target …", `→ no target` for NULL and `→ none yet` for uninitialized.
- Memory cards are easier to scan. The separate address strip is now a quiet `0x10000000 · 24 bytes` line under the name, and the array column header and the "Value" label are gone. Each value sits in its own slot in one consistent size; uninitialized values show a dashed `?` slot (the tooltip and screen-reader text still say "uninitialized"). Addresses are muted so values stand out. A row whose address some pointer stores has that address in the pointer colour with a ◂ marker (in Arrows view its slot is outlined instead), and in Arrows view a pointer's slot shows a dot where its arrow starts, with `→ target` beneath. NULL is no longer drawn in the pointer colour. The stack colour moved from every card to the frame's top edge and name; heap cards keep their amber edge. Cards are about 16–40px shorter.
- The inspector is reorganised. The heading is the C declaration (`int a[3]`) with frame and size beneath it. Members are picked from one fixed-height line (`Inspect [[2] ▾] ‹ ›`, with short `[i]` / `.field` labels), so resizing an array never moves the controls below it. Read-only facts sit in a tinted **Memory** block labelled with C expressions (`&p`, `p`, `→`, `*p`); long names end in "…" instead of squeezing addresses, a target in the pointer's own frame is shown without the frame, and arrays and structs show their contents (`{ 1, 2, ? }`) instead of repeating the type. The **Edit** section has Name, Type (base type and pointer depth) and a **Single | Array** switch; the length field appears only for arrays and remembers the last length. Delete sits apart in the footer. Focus rings no longer touch nearby labels or get clipped at the panel edge. Frame ids such as `[main]` appear only when two frames share a function name.
- A runtime error (NULL dereference, use after free, out-of-bounds access, step or loop limit) no longer discards the run. Playback opens at the step where execution stopped, with the failing line in red and "Stopped by an error" in the code header; earlier steps remain available.
- The sandbox stays loaded while another tab is open, so its code, diagram, playback, layout and undo history survive switching to Challenges or the Level editor.
- The sandbox's code, and the diagram when you are editing one, are saved in the browser and restored after a reload. Playback is not saved (Run reproduces it), nor are box positions.
- Tab and Shift+Tab with a selection across lines indent or outdent every selected line and keep them selected. Previously Tab replaced the selection with four spaces, and Shift+Tab only outdented the first line.
- Typing a number into the inspector is one undo step instead of one per keystroke.
- Ctrl+Z / Ctrl+Shift+Z now undo and redo diagram edits as well as layout changes, in one timeline: values, pointer targets, names, types, adding and deleting objects, Mark as freed, and Clear diagram. Deleting, freeing and clearing confirm with "Ctrl+Z undoes it". **Undo** and **Redo** buttons are back in the canvas controls, so this also works without a keyboard.
- Freed heap blocks and out-of-scope variables can be dragged like any other box; only their contents are read-only.
- In an editable diagram, a freed heap block's inspector has **Mark as not freed** and **Delete object** (previously a freed block could be neither restored nor deleted).

### Fixed

- Pointer arrows lost their arrowheads in Challenges (and the Level editor preview) when the sandbox also showed a pointer. Every canvas shared React Flow's default ID, so arrowhead markers had the same element ID on every page, and arrows used the hidden sandbox's markers, which don't render. Each canvas now has its own ID.
- In a diagram → code challenge, a failed check outlined boxes in the read-only target diagram. Those IDs belonged to the student's memory, so the wrong boxes were marked; markers now appear only on a student's own diagram.
- Two code → diagram seed levels could not be solved. **A function call** needed an out-of-scope parameter in a returned frame, and **Linked structure** needed struct objects the diagram editor could not create. Grading now ignores out-of-scope locals that no pointer refers to (a returned call's parameter, a loop temporary), so the answer is the memory the program can still reach; an out-of-scope object a pointer still refers to is still graded. The inspector's Type picker offers struct types (the level's in a challenge; in the sandbox, those from the code that produced the diagram), as single objects, arrays or pointer targets. The Level editor refuses to save a code → diagram level whose answer still can't be drawn (an out-of-scope variable a pointer refers to, a string literal, a two-dimensional array), and Challenges explains such a stored level instead of letting it be attempted.
- After a reload in the Addresses view, switching to Both sometimes drew no arrows; handle positions are now re-measured when the view changes.
- Grading rejected any program that reused a variable name in a block or loop scope (`for (int i…)` twice, or a variable declared inside a loop body) as "duplicate variable name": the challenge crashed on Check, or a correct answer was marked wrong. Only live names must be unique now, and grading tells same-named out-of-scope objects apart by their order.
- Generate C failed when the first pointer it reached into a heap block pointed inside the block (`int *q; struct S *s; q = &s->y;`). Interior pointers now wait until a base pointer has allocated the block, whatever the declaration order.
- Generate C freed heap blocks in allocation order, so a freed linked list produced `free(head); free(head->next);` (a use after free). Blocks reached through another block are now freed first.
- `%g` / `%G` dropped the final zero of a two-digit exponent (`1.23457e+1` instead of `1.23457e+10`).
- Defining a function named `malloc` or `free` was accepted but never called; it is now rejected like `printf`.
- `NULL`, `malloc`, `free` and `printf` can no longer name variables or parameters, in code or in the diagram, so Generate C cannot emit code like `free(free);`. The inspector refuses invalid, reserved, typedef and duplicate names instead of storing them, and a nameless stack object is labelled "(unnamed)" rather than "heap".

## Unreleased — `printf`

### Added

- `printf` with a string-literal format: `%d %i %u %x %X %o %c %s %f %F %e %E %g %G %p %%`, the `hh`/`h`/`l`/`z` length modifiers, flags, widths, precisions and `*`. Output matches glibc, and `%p` prints the diagram's simulated addresses.
- Argument types are checked against the format before running, as with `-Wformat`. `%s` reads are bounds- and initialization-checked.
- An **Output** pane under the code shows what the program has printed up to the current playback step.

## Unreleased — `bool` and `size_t`

### Added

- `bool` / `_Bool` (1 byte) with `true` and `false`. Conversions to `bool`, including from pointers, follow C's "compares unequal to zero" rule. The diagram shows `true`/`false`, and the inspector edits a `bool` with a true/false menu.
- `size_t`, the LP64 typedef of `unsigned long`. It is interchangeable with `unsigned long` but keeps its spelling in the diagram, inspector and generated C.
- Generate C adds `#include <stdbool.h>` / `<stddef.h>` when the diagram uses these types.

## Unreleased — sandbox layout

### Changed

- The central Run/Generate strip is gone: **Run** is in the code header and **Generate C** in the memory header. A draggable divider resizes the code and memory panes (double-click resets; drag fully left to collapse the code pane). Challenges uses the same layout.
- The memory toolbar and edit toolbar were removed. Arrows / Both / Addresses modes were retired (addresses and arrows are always shown); Fit view and Reset layout live in the canvas controls; layout Undo/Redo is keyboard-only; Snap was removed; Show expired became a **Show out-of-scope** button that appears only when something is hidden. **+ Variable** and **+ Heap block** float over the canvas; **Clear diagram** moved to the right-click menu.
- The inspector floats over the canvas instead of shrinking it, pans just enough to keep the selected object visible, and uses shorter labels (Located at, Stores, Points to, Value).
- Messages appear once: Run and generation messages in the code pane, canvas messages as a toast. The persistent status row and duplicate message log were removed.
- Cards and frames are more compact (cards from 200 px, frames sized to their contents).
- The C editor auto-indents: Enter keeps the current line's indentation (one level deeper after `{`, and pressing Enter between `{}` moves the `}` to its own line), and typing `}` on a blank line outdents it.

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
