# Testing

## Automated checks

```bash
npm ci
npm test
npm run build
```

The suites are:

| Command | Coverage |
| --- | --- |
| `npm run test:core` | 22 parser-independent interpreter, memory, grading and generation cases |
| `npm run test:integration` | 21 real-C parsing, execution and round-trip cases |
| `npm run test:layout` | Frame growth/resizing, lifetime, handle, routing, and layout history cases |
| `npm run test:flow-integration` | 4 cases that feed real C execution snapshots through the layout adapter, including typed pointer targets |
| `npm run test:semantics` | 153 C semantic, constraint, lifetime, bounds and round-trip tests |
| `npm run test:native` | 76 defined programs compared with a native LP64 C11 compiler |

The native suite first compiles and runs a small probe to check LP64 sizes, signed char, and the undefined-behavior sanitizer runtime. It skips with a reason when the compiler is missing or incompatible, including Windows compilers with 4-byte `long`. Linux CI sets `POINTERVIZ_REQUIRE_NATIVE=1`, which makes these conditions fail instead of skip. After the probe succeeds, fixture compilation, execution, and result mismatches always fail the test. Set `POINTERVIZ_CC` to a compatible compiler command or `POINTERVIZ_WSL_DISTRO` to an installed Linux distribution on Windows. See [the C semantics audit](C_SEMANTICS_AUDIT.md).

Layout tests use the same adapter as the canvas and verify its output without a browser. They cannot replace interaction checks.

GitHub Actions runs the full test/build commands on Windows and Linux with Node 22 and 24.

## Browser regression checks

1. Run the starter struct example and step into `set_value`. Use Fit view to see both frames; pointer targets remain the struct header and typed fields.
2. Drag a function header. Its locals and arrows move with it. Resize every edge/corner; child world positions remain fixed and shrinking cannot clip contents.
3. Drag a local horizontally and vertically, including past each frame boundary. The frame grows, retains its ownership, and does not displace siblings.
4. Edit this snapshot, then right-click inside the active function frame and Add variable here. Edit values and types. Existing positions, frame sizes, and manual arrow bends remain intact.
5. Select an arrow, drag its diamond, then Undo and Redo. One drag is one action. Reset route restores automatic routing. Drag its arrowhead to another compatible target; an invalid target leaves the existing pointer intact.
6. Return to playback. The new variable and value edits disappear; the recorded execution is unchanged. Step backward and forward: layout survives, including for frames hidden after returning.
7. Toggle Show expired. Returned frames and dead locals retain provenance and read-only memory semantics. Dangling and one-past pointers keep their status.
8. Use arrays, self-referential structures, nested fields, repeated calls, and recursion. Verify typed endpoints, stable loops, frame ownership, and readable routes.
9. In an editable main diagram, draw pointers, edit scalar values, delete an edge, and Generate C. Layout changes do not affect generated C or grading. Increasing an array to 64 grows its frame without moving other objects.
10. Fit frame to contents, Fit view, and Reset layout have separate effects. Undo restores layout after Reset layout. Toggle Snap and test node dragging. Keyboard resizing/bending and layout undo should work without capturing typing shortcuts in inputs.
11. A new Run or Clear discards old layout/history. Adding the first object after Clear fits it into view. A fresh level-editor preview must not reuse layout from another program.
12. Check toolbar wrapping and scrolling in a narrow view and the normal desktop workbench. Browser console should have no runtime errors.
13. Rename a stack object: repeatedly clear and replace its name while the Name field is focused; no validation messages should appear until leaving the field or pressing Enter. A valid replacement updates the diagram and generated C. Committing an empty or invalid name still reports validation errors. Switching objects shows each object's own name, and refocusing an unchanged name does not repeat the warning.
14. At rest, non-pointers and aggregate headers have no target dots, and each editable pointer has one blue source dot. Drag it: only compatible targets appear as outlined squares. An `int *` can target an `int` array element but not its header; an `int (*)[3]` can target the header of an `int[3]` array. An `int **` can target an `int *` object. Verify nested aggregate targets, cancellation, arrowhead reconnection, left/right routing, and playback with no editing dots.

## Release validation

PointerViz 2.2.1 was validated on Windows with Node 24.19.0, npm 11.6.2 and the supplied npm lockfile. All 58 automated cases passed and the production build succeeded.

The browser checks verified production WASM loading, the starter struct-pointer example, frame dragging with locals, local containment, resetting on step revisits, automatic fitting, returned-frame history, hidden dangling targets, pointer-edge deletion, drawing a pointer, and canonical C generation. Other items in the checklist remain useful for future changes; the added CI matrix has not yet run on GitHub.

Vite reports upstream Tree-sitter warnings about Node-only imports and dynamic evaluation, plus a JavaScript chunk-size warning. These do not fail the build. Changes to parser packaging should also be checked in a production preview to verify WASM loading.

## Sandbox interaction update

The flexible-workspace update passed 72 automated cases (22 core, 21 C round trips, and 29 layout/playback/integration cases). Desktop browser checks covered resizing, two-axis dragging, frame growth past the top-left boundary without moving siblings, value edits and creation without rearranging boxes, manual arrow bends with one-step undo/redo, valid and invalid reconnections, and editing/restoring a function-call snapshot. The existing single-main-frame C generation limit remains in place.
