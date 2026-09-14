# Memory visualization

## Frames and lifetimes

Each function invocation has its own frame ID and default horizontal slot. Slots use the visible frame order, rather than call depth, so repeated calls and recursion do not overlap. Frames start with horizontal room for multiple boxes and grow to fit their visible allocations, including long declarations and 64-element arrays.

Drag a frame's header to move it with its locals. Select a frame to reveal resize controls on all edges and corners and **Fit frame to contents**. Resizing keeps child world positions fixed and cannot clip contents. Live locals move freely in both axes; dragging beyond any boundary expands the owning frame, retaining header space and padding. Optional **Snap** aligns node movement to the grid. Returned locals cannot be dragged or edited. Frames cannot be deleted as diagram objects.

The default view shows live stack allocations and active frames. **Show expired** also shows returned frames and expired block/loop locals with dashed frame borders and lifetime labels. Freed heap allocations remain visible because free/alias relationships are part of heap lessons.

Hiding an object never deletes it from `MemoryState`. A live pointer to a hidden expired object still says **dangling**; hover it to see its target. Turn on **Show expired** to see the target and dashed red edge. One-past pointers have a status label but no arrow to a fabricated array element.

## Position lifetime

Positions, manually chosen frame sizes, and arrow bends survive memory edits and playback steps within a run. Show expired preserves the layout of hidden objects. New Run, Clear, or a fresh instructor preview starts a new workspace so reused IDs cannot inherit stale positions.

**Fit view** adjusts the viewport without changing layout. The first nonempty view fits automatically; subsequent edits and steps leave the viewport alone. **Reset layout** restores default positions, dimensions, and arrow routes without moving the viewport. **Undo** and **Redo** restore layout changes, with a complete drag counted as one action (up to 50 actions). Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl/Cmd+Y work when canvas controls have focus; text inputs keep their own editing shortcuts. Layout undo does not change memory values or pointer targets.

## Editing a snapshot

Playback is read-only for memory values and pointer targets, while layout remains adjustable. **Edit this snapshot** clones the displayed state and enables creation and editing in active frames. Select a frame and use **+ Variable**, or right-click its background and choose **Add variable here**. The toolbar's Add stack object uses the selected active frame, defaulting to main. The owning frame is highlighted. **Return to playback** restores the recorded state and step, discarding semantic edits to the copy.

Returned frames and expired locals remain read-only. Generating C still requires a single main frame; multiple function-frame diagrams can be explored but cannot yet be converted back into function-call code. Editing source or successfully generating C exits the saved-playback workflow.

## Boxes and arrows

Pointer values use a fixed 30 × 20 SVG indicator independent of text font metrics. Names and types use bounded columns, with full text available on hover.

Pointers choose left or right attachment sides based on relative box positions. Grey target dots and blue pointer source dots are vertically separated; both sides are available. Aggregate roots attach to the header. Field target dots stay hidden unless a pointer targets that field; hovering an editable object reveals them for connections. Whole structs and their fields retain distinct typed references. Type and array-size edits refresh handle geometry.

Edges use cubic curves where there is a clear route, with rounded obstacle-aware detours in dense diagrams and stable loops for self-references. Select an arrow to show a draggable diamond. Drag it to set a manual bend; **Reset route**, double-clicking the diamond, or Home while it has focus restores automatic routing. Arrow keys move a focused diamond or resize control; Shift makes larger adjustments. Manual bends follow the endpoint midpoint as boxes move.

In an editable diagram, drag an arrowhead to reconnect to a compatible target. An invalid target leaves the original pointer unchanged and shows the existing type error. Presentation-only arrow bending is also available during playback. Layers keep frames behind edges and boxes above edges.

## Playback and code

**Run** prepares the execution trace at step zero. **Next**, **Previous**, and the slider navigate it. Function entry (with parameters), statements, condition checks, loop updates, and function exit have separate snapshots.

The code editor colours C keywords, types, function names, literals, comments, and preprocessing lines. Yellow marks the line about to run; the highlight clears at completion or when source code changes. New frames/objects get yellow outlines, changed value rows get yellow backgrounds, and new or redirected pointer edges turn yellow for that step. Highlights compare adjacent execution snapshots, including when stepping backward.

Automatic routing is a lightweight heuristic, not a general obstacle solver. Manual bends follow the student's placement and may cross other boxes. Deliberately overlapping frames/boxes can leave no clear route, and dense graphs can share edge segments. Use **Reset layout** or move the frames apart. Frame borders are grouping boundaries, so arrows may cross them to reach variables.

## Implementation

- `src/flow/layout.js`: visibility, initial placement, minimum dimensions, typed handles, edge data.
- `src/flow/workspace.js`: positions, resizing, growth, content fitting, and layout undo/redo.
- `src/flow/routing.js`: cubic curves, manual bends, obstacle-aware fallback, self-loops.
- `src/flow/memoryFlow.jsx`: node/edge React components and pointer indicator.
- `src/components/MemoryCanvas.jsx`: session layout, drag gestures, selection, creation, semantic editor, history toggle, viewport.
- `src/styles.css`: fixed header/row dimensions and visual layers. Keep these dimensions in sync with `GEOMETRY`.

The parent/child layout follows React Flow's [sub-flow model](https://reactflow.dev/learn/layouting/sub-flows). Parent nodes precede children and children use relative positions. Children have no fixed parent extent; workspace operations grow the parent to preserve ownership, header space, and padding. Custom edges render through [BaseEdge](https://reactflow.dev/api-reference/components/base-edge).

The controlled canvas preserves dimension measurements reported by React Flow. Dropping them when regenerating nodes invalidates handle bounds, which can break dragging and prevent automatic fitting from settling. Measurements are reused only while the expected dimensions still match.
