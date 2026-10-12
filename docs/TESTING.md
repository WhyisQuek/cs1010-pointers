# Testing

## Automated checks

```bash
npm ci
npm run check   # ESLint + Prettier check + all tests
npm run build
npm run build:instructor
npm run check:editions   # the student build must not contain the Level editor
```

`npm test` runs every `test/*.test.js` file with Node's built-in test runner. Each suite can also be run alone:

| Command | Coverage |
| --- | --- |
| `npm run test:core` | Parser-independent interpreter, memory, grading and generation cases |
| `npm run test:integration` | Real-C parsing, execution and C → memory → C round trips |
| `npm run test:layout` | Frame growth/resizing, lifetime, handle, routing, and layout history cases |
| `npm run test:flow-integration` | Real C execution snapshots fed through the layout adapter, including typed pointer targets |
| `npm run test:playback` | Step snapshots, next-line tracking, typedefs and syntax-error locations |
| `npm run test:semantics` | C semantic, constraint, lifetime, bounds and round-trip tests |
| `npm run test:addresses` | Simulated placement, LP64 offsets, provenance/status, history, atomic edits, view geometry, and address-independent grading/generation |
| `npm run test:native` | Defined programs compared with a native LP64 C11 compiler |
| `node --test test/maintenance.test.js` | Regressions from the [code audit](CODE_AUDIT.md): storage failures, level import, input range checks, labels, WASM paths; completion-only progress; course-pack loading and draft precedence |

`npm run audit:n3088` runs the separate C-standard audit probes; it reports discrepancies and is not a pass/fail suite.

The native suite first compiles and runs a small probe to check LP64 sizes, signed char, and the undefined-behavior sanitizer runtime. It skips with a reason when the compiler is missing or incompatible, including Windows compilers with 4-byte `long`. Linux CI sets `POINTERVIZ_REQUIRE_NATIVE=1`, which makes these conditions fail instead of skip. After the probe succeeds, fixture compilation, execution, and result mismatches always fail the test. Set `POINTERVIZ_CC` to a compatible compiler command or `POINTERVIZ_WSL_DISTRO` to an installed Linux distribution on Windows. See [the C semantics audit](C_SEMANTICS_AUDIT.md).

Layout tests use the same adapter as the canvas and verify its output without a browser. They cannot replace interaction checks.

## Browser smoke tests (Playwright)

```bash
npx playwright install chromium   # once per machine
npm run test:e2e
```

`playwright.config.js` builds the student and instructor apps with the GitHub Pages base path (`/cs1010-pointers/`), serves each with `vite preview` (ports 4173 and 4174), and runs the specs in Chromium: `*.instructor.spec.js` against the instructor build, the rest against the student build. Every test also fails on any console error, uncaught page error, or HTTP response of 400 or above, which catches base-path and WASM-loading regressions. On failure, traces are kept in `test-results/` (open with `npx playwright show-trace`).

| Spec | Covers |
| --- | --- |
| `sandbox.spec.js` | Parser loading under the subpath; Run and step-through playback with addresses; adding an object, rejecting a fractional `int`, and generating matching C |
| `challenges.spec.js` (student) | Result messages (code that doesn't run, incorrect code and diagram, attempt number, changed-since-check tag, challenge complete), Next challenge and the completed count and badge; hints revealed in order; cards top-aligned; solving code-to-diagram levels; no Level editor tab; course-pack levels listed and browser-saved drafts not; a broken course level asks the student to tell the instructor |
| `level-editor.instructor.spec.js` (instructor) | Reference code visible (editor overlay stays transparent); preview on first open; saving, editing and deleting a level, seen in Challenges; refusing an undrawable level; a stored level with broken code shows an error; stored duplicate IDs are repaired |

These automate the core of the release checks. The drag, resize, routing and keyboard checks below still need a person.

## Memory-address regression checks

The initial implementation passed the complete non-native suites, the required native LP64/UBSan comparison suite using WSL, the production build, and all four address examples. Browser checks verified playback and snapshot restoration, alias/pointer-to-pointer values, one-past and expired-target inspection, mode persistence, typed-picker and drag retargeting in Addresses mode, atomic rejection, both challenge directions, instructor previews, and wide/narrow panes. The production preview reported no console errors. The broader checks below remain a release checklist, not a claim of completed user testing.

Use [the address examples](../examples/memory-addresses.md). Verify all three modes preserve object geometry and state. In the inspector compare &p, p, and *p, copy full addresses, navigate to exact members and one-past boundaries, and reveal expired targets. Edit a snapshot, retarget through the typed picker in Addresses mode, reject an incompatible type/shrink, then return to playback. Verify source-dot dragging still offers compatible targets while edges are hidden.

Check wide and narrow panes, keyboard focus, toolbar wrapping, long names, mixed pointer/scalar rows, and 64-element arrays. Browser accessible labels must identify own and stored addresses separately. Check Sandbox, both challenge directions, and instructor previews. The full design also calls for 200% zoom, touch/screen-reader testing, performance comparisons, and novice learning checks; automated DOM checks alone do not establish those results.

GitHub Actions runs lint, the format check, the full test commands, both builds and the edition check on Windows and Linux with Node 22 and 24, and the Playwright suite on Linux (the HTML report and traces are uploaded when it fails).

## Browser regression checks

1. In the Sandbox, run a program that passes a struct pointer to a function (for example `void set(struct Node *n) { n->value = 5; }` called from `main`) and step into the call. Use the canvas fit-view control to see both frames; pointer targets remain the struct header and typed fields.
2. Drag a function header. Its locals and arrows move with it. Resize every edge/corner; child world positions remain fixed and shrinking cannot clip contents.
3. Drag a local horizontally and vertically, including past each frame boundary. The frame grows, retains its ownership, and does not displace siblings.
4. Select Edit in the memory header, then right-click inside the active function frame and Add variable here. Edit values and types. Existing positions, frame sizes, and manual arrow bends remain intact.
5. Select an arrow, drag its diamond, then press Ctrl+Z and Ctrl+Shift+Z. One drag is one action. Reset route restores automatic routing. Drag its arrowhead to another compatible target; an invalid target leaves the existing pointer intact.
6. Select Back to playback. The new variable and value edits disappear; the recorded execution is unchanged. Step backward and forward: layout survives, including for frames hidden after returning.
7. After a function returns, toggle Show out-of-scope (it is absent before any frame returns). Returned frames and dead locals retain provenance and read-only memory semantics. Dangling and one-past pointers keep their status.
8. Use arrays, self-referential structures, nested fields, repeated calls, and recursion. Verify typed endpoints, stable loops, frame ownership, and readable routes.
9. In an editable main diagram, draw pointers, edit scalar values, delete an edge, and Generate C. During playback, Generate C at an intermediate step produces C for that step only. Layout changes do not affect generated C or grading. Increasing an array to 64 grows its frame without moving other objects.
10. Fit frame to contents, the fit-view control, and the reset-layout control (↺) have separate effects. Ctrl+Z restores layout after resetting it. Keyboard resizing/bending and layout undo should work without capturing typing shortcuts in inputs.
11. A new Run or right-click → Clear diagram discards old layout/history. Adding the first object after clearing fits it into view. A fresh level-editor preview must not reuse layout from another program.
12. Drag the code/memory divider, double-click it to reset, move it with the arrow keys, and drag it fully left to collapse the code pane; click the rail to restore it. Reload: the split is kept. Selecting objects must not change the canvas size (the inspector overlays it). At 375 px wide the panes stack, the inspector is a bottom sheet, and there is no horizontal page scroll. Browser console should have no runtime errors.
13. Rename a stack object: repeatedly clear and replace its name while the Name field is focused; no validation messages should appear until leaving the field or pressing Enter. A valid replacement updates the diagram and generated C. Committing an empty or invalid name still reports validation errors. Switching objects shows each object's own name, and refocusing an unchanged name does not repeat the warning.
14. At rest, non-pointers and aggregate headers have no target dots, and each editable pointer has one blue source dot. Drag it: only compatible targets appear as outlined squares. An `int *` can target an `int` array element but not its header; an `int (*)[3]` can target the header of an `int[3]` array. An `int **` can target an `int *` object. Verify nested aggregate targets, cancellation, arrowhead reconnection, left/right routing, and playback with no editing dots.

## Release validation

PointerViz 2.2.1 was validated on Windows with Node 24.19.0, npm 11.6.2 and the supplied npm lockfile. All 58 automated cases passed and the production build succeeded.

The browser checks verified production WASM loading, the starter struct-pointer example, frame dragging with locals, local containment, resetting on step revisits, automatic fitting, returned-frame history, hidden dangling targets, pointer-edge deletion, drawing a pointer, and canonical C generation. Other items in the checklist remain useful for future changes; the added CI matrix has not yet run on GitHub.

Vite reports upstream Tree-sitter warnings about Node-only imports and dynamic evaluation, plus a JavaScript chunk-size warning. These do not fail the build. Changes to parser packaging should also be checked in a production preview to verify WASM loading.

## Sandbox interaction update

The flexible-workspace update passed 72 automated cases (22 core, 21 C round trips, and 29 layout/playback/integration cases). Desktop browser checks covered resizing, two-axis dragging, frame growth past the top-left boundary without moving siblings, value edits and creation without rearranging boxes, manual arrow bends with one-step undo/redo, valid and invalid reconnections, and editing/restoring a function-call snapshot. The existing single-main-frame C generation limit remains in place.
