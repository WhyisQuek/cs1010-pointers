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
| `npm run test:layout` | 12 frame, lifetime, handle and routing cases |
| `npm run test:flow-integration` | 3 cases that feed real C execution snapshots through the layout adapter |

No native C is executed. Layout tests use the same adapter as the canvas and verify its output without a browser. They cannot replace interaction checks.

GitHub Actions runs the full test/build commands on Windows and Linux with Node 22 and 24.

## Browser regression checks

1. Run the starter struct example. Step into `set_value`: both frames fit in view and its pointer targets the struct header. The value indicator is clearly visible.
2. Drag the function header. Its locals and pointer arrow move with it.
3. Drag a live local far outside its frame, including above the header. It stays within the padded content area.
4. Step out of the function. Its frame disappears. Step back: frame and local positions return to defaults.
5. Enable **Show expired**. Returned frames have a dashed border and returned label; dead locals show out-of-scope and cannot be dragged or edited.
6. Paste [function-frames.c](../examples/function-frames.c). Step through the successive and nested calls. Visible frames do not share a default slot.
7. Run `int main(void) { int *p = NULL; { int x = 1; p = &x; } return 0; }`. The pointer remains dangling after `x` disappears. Enable **Show expired** to inspect its target.
8. Use a self-referential struct, an array-element pointer, and a one-past pointer. Edges attach to actual objects/subobjects; one-past has no fabricated target.
9. In an editable final diagram, add objects, draw a type-correct pointer, delete its edge, edit a scalar and generate C. Resizing arrays refreshes handles. A large length is clamped to 64.
10. Use **Reset layout** after dragging. It restores positions and fits the view.

## Release validation

PointerViz 2.2.1 was validated on Windows with Node 24.19.0, npm 11.6.2 and the supplied npm lockfile. All 58 automated cases passed and the production build succeeded.

The browser checks verified production WASM loading, the starter struct-pointer example, frame dragging with locals, local containment, resetting on step revisits, automatic fitting, returned-frame history, hidden dangling targets, pointer-edge deletion, drawing a pointer, and canonical C generation. Other items in the checklist remain useful for future changes; the added CI matrix has not yet run on GitHub.

Vite reports upstream Tree-sitter warnings about Node-only imports and dynamic evaluation, plus a JavaScript chunk-size warning. These do not fail the build. Changes to parser packaging should also be checked in a production preview to verify WASM loading.
