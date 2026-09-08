# Memory visualization

## Frames and lifetimes

Each function invocation has its own frame ID and default horizontal slot. Slots use the visible frame order, rather than call depth, so repeated calls and recursion do not overlap. Frame dimensions come from their visible allocations; long declarations and 64-element arrays fit inside their parent.

Drag a frame's header to move it with its locals. Live locals can move inside their frame, below the header and within its padding. Returned locals cannot be dragged or edited. Frames cannot be deleted as diagram objects.

The default view shows live stack allocations and active frames. **Show expired** also shows returned frames and expired block/loop locals with dashed frame borders and lifetime labels. Freed heap allocations remain visible because free/alias relationships are part of heap lessons.

Hiding an object never deletes it from `MemoryState`. A live pointer to a hidden expired object still says **dangling**; hover it to see its target. Turn on **Show expired** to see the target and dashed red edge. One-past pointers have a status label but no arrow to a fabricated array element.

## Position lifetime

Coordinates belong only to the current canvas state. Changing the execution step, running code again, clearing the diagram, or editing semantic memory discards previous drags. Returning to an earlier step recomputes its default layout instead of recovering old drag positions.

**Reset layout** restores default positions and fits the view. Toggling **Show expired** also resets the layout. The view fits visible frames when memory changes; ordinary dragging does not trigger auto-fit.

## Boxes and arrows

Pointer values use a fixed 30 × 20 SVG indicator independent of text font metrics. Names and types use bounded columns, with full text available on hover.

Scalar rows have semantic target handles on both sides; interactive connections use left target handles and right source handles. Aggregate roots attach at the header. Nested aggregate references attach at their first scalar row. A type/array-length edit refreshes React Flow's handle geometry.

Pointer edges use rounded orthogonal paths. The adapter chooses the target side facing the source and scores routing lanes around allocation boxes and frame headers. Explicit layers keep frames behind edges and allocation boxes above edges; selecting nodes does not raise a whole frame above another one.

This is a lightweight routing heuristic, not a general obstacle solver. Deliberately overlapping frames/boxes can leave no clear route, and dense graphs can share edge segments. Use **Reset layout** or move the frames apart. Frame borders are grouping boundaries, so arrows may cross them to reach variables.

## Implementation

- `src/flow/layout.js`: visibility, dimensions, parent-relative coordinates, clamping, handles, edge data.
- `src/flow/routing.js`: route candidates, collision/length scoring, rounded SVG paths.
- `src/flow/memoryFlow.jsx`: node/edge React components and pointer indicator.
- `src/components/MemoryCanvas.jsx`: per-state layout, dragging, selection, semantic editor, history toggle, viewport.
- `src/styles.css`: fixed header/row dimensions and visual layers. Keep these dimensions in sync with `GEOMETRY`.

The parent/child layout follows React Flow's [sub-flow model](https://reactflow.dev/learn/layouting/sub-flows). Parent nodes precede children, children use relative positions and `extent: 'parent'`, and a separate clamp reserves the frame header and padding. Custom edges render through [BaseEdge](https://reactflow.dev/api-reference/components/base-edge).

The controlled canvas preserves dimension measurements reported by React Flow. Dropping them when regenerating nodes invalidates handle bounds, which can break dragging and prevent automatic fitting from settling. Measurements are reused only while the expected dimensions still match.
