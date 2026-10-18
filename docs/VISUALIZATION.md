# Memory visualization

## Simulated addresses

By default each object shows its own address and size, pointer values show the target's address, and arrows show the relationship. The **View** menu at the top left of the canvas switches between three presets:

| View | Addresses on cards | Pointer value | Arrows |
| --- | --- | --- | --- |
| Both (default) | Shown | Target's address | All |
| Arrows | Hidden (still in the inspector) | A dot where the arrow starts; `→ x` beneath | All |
| Addresses | Shown | Target's address | Only the selected box's |
| Structure | Hidden; list and tree nodes are compact cards | As in Arrows; a node's links are slots (`●` or `∅`) | All |

Boxes keep the same size and position in Both, Arrows and Addresses, so switching between them never overlaps or moves them. In Arrows, a hidden slot is left empty rather than given another meaning, and the aggregate Address column is dropped. The choice applies to every canvas (sandbox, challenges, level editor), is remembered in the browser (`pointerviz.view.v1`), and is never part of the diagram, grading or undo history. These modes were retired in October 2026 because the old Arrows view replaced addresses with unrelated text; they returned in this form on 12 October 2026.

### Structure view

Structure is meant for algorithm lessons on lists and trees. It works from the program's own structs: a struct with a member (or array of members) pointing to its own type is a node type, and its heap objects are drawn as compact cards showing up to three fields, then one slot per link. How links are followed depends on the struct, never on a preset:

- One forward link draws a chain, left to right in link order. List nodes put their link slots on the right (`[ 10 | next ● ]`), so `next` arrows run straight from one card's edge to the next.
- Two forward links draw a binary tree with in-order columns, so a left child is always left of its parent and a BST reads sorted. Fields named `left`/`right` set the sides; otherwise declaration order does.
- Two links where every step along one is mirrored by the other draw a doubly linked chain, whatever the names.
- More links draw a tree with that many children, each parent centred over its subtree.
- Links whose names contain `parent`, `prev`, `pred` or `back` are drawn but not followed.

Each structure starts from a node nothing links to, the one a variable in the oldest frame points at first, so `main`'s `head` or `root` leads. A node reachable twice is drawn once, under its first parent, and a node not yet linked in (just returned by `malloc`) gets a row of its own. Other heap objects follow in rows.

The call stack is a column on the left, oldest call at the top, with the heap region beside it. Scalar and pointer locals are one line each (`data 60`, `root → 50`); arrays and structs on the stack keep their full card. When a function has several frames they are numbered (`insert() #2`), and the newest call is marked **running**. Between `main` and the two newest calls, two or more consecutive calls of one function fold into one row (`insert() × 3`); **Show all calls** expands them and **Fold recursive calls** (top of the canvas) folds them again. Variables in folded calls are hidden along with their arrows.

A stack variable that points at a whole list or tree node is drawn as a label on that node, not as an arrow. Labels sit in a band inside the top of the card, so they never spill onto a neighbouring node or cover an arriving arrow; every node of that type gets the band, so cards keep one size as cursors move. A label names its frame only when more than one frame is on screen (`#2 root`, not `main head`). The running call's labels are filled, a dangling one is red, and labels that do not fit are cut off, with the band's tooltip listing them all. Hovering a label highlights its variable's line, and the other way round. Pointers to anything else, including into a node's field or slot, stay arrows.

A live heap node that no pointer reaches is marked **unreachable** (a leak) and placed after the reachable structures. Return values are not part of MemoryState, so a node a function is still handing back to its caller looks unreachable for a step or two; playback therefore only flags a node that stays unreachable for the rest of the run (`leaksByStep`). A diagram without a recorded run is judged on its own.

Every position is recomputed at each step, so boxes and arrows cannot be dragged or bent, and Structure never changes the positions remembered for the other views. Editable diagrams show Arrows instead, and the menu item is disabled there. Code: `src/flow/structureLayout.js`.

Select an object name or member label to inspect it, including during playback. The inspector floats over the top-right of the canvas, so opening it never resizes the diagram; if it would cover the selected object, the canvas pans just enough to keep the object visible, without changing zoom. The heading line gives the object's own address (`&p`), size and frame. The **Memory** block shows `p` (the address it stores, in a blue slot) with `→ target` beneath it, and `*p` (the target's value), using the same 8-digit addresses and slot colours as the cards; the copy buttons copy the full 64-bit address. The target name is a link that selects it in the diagram. The ⓘ next to Memory notes that addresses are simulated. Clicking the target name selects the exact member, revealing out-of-scope storage when needed; for a one-past pointer it identifies the boundary without reading it. Narrow memory panes show the inspector as a bottom sheet over the canvas.

Editable pointers have a typed **Target** picker, including NULL and uninitialized choices. Addresses are read-only. The **Type** picker offers the primitive types and every struct type the diagram knows: in the sandbox, the structs defined by the code that produced the diagram (Run, then Edit a step); in a challenge, the level's structs. Any of these can be a single object, an array, or the target of one or more `*`. Type/array edits preserve a root's base address and reset its value, and are rejected atomically if an incoming pointer would become invalid or historical pointer facts would change. Valid changes to subobject addresses/status are highlighted. Deletion clears live incoming pointers but is rejected when an expired source still records the target.

The teaching model uses LP64 sizes and padding, deterministic spaced root addresses, and no address reuse within a run. NULL displays a zero address, uninitialized pointers have no known address, and dangling pointers retain a labeled former address. These are simulated addresses, not native process addresses. See [the runnable teaching examples](../examples/memory-addresses.md).

## Frames and lifetimes

Each function invocation has its own frame ID and default horizontal slot. Slots use the visible frame order, rather than call depth, so repeated calls and recursion do not overlap. Frames size themselves to their visible allocations (at least 240 × 160 px), including long declarations and 64-element arrays, unless the user has resized them. Cards are at least 200 px wide (260 px for arrays and structs, which have an address column).

Drag a frame's header to move it with its locals. Select a frame to reveal resize controls on all edges and corners and **Fit frame to contents**. Resizing keeps child world positions fixed and cannot clip contents. Live locals move freely in both axes; dragging beyond any boundary expands the owning frame, retaining header space and padding. Returned locals cannot be dragged or edited. Frames cannot be deleted as diagram objects.

The default view shows live stack allocations and active frames. When returned frames or expired block/loop locals exist, a **Show out-of-scope (n)** button appears at the top-left of the canvas; it reveals them with dashed frame borders and lifetime labels, and becomes **Hide out-of-scope memory**. Freed heap allocations remain visible because free/alias relationships are part of heap lessons.

Hiding an object never deletes it from `MemoryState`. A live pointer to a hidden expired object still says **dangling**; hover it to see its target. Use **Show out-of-scope** to see the target and dashed red edge. One-past pointers have a status label but no arrow to a fabricated array element.

## Position lifetime

Positions, manually chosen frame sizes, and arrow bends survive memory edits and playback steps within a run. Hiding out-of-scope memory preserves the layout of hidden objects. New Run, Clear diagram, or a fresh instructor preview starts a new workspace so reused IDs cannot inherit stale positions.

The canvas controls at the bottom left zoom, **fit the view** without changing layout, and **reset layout** (↺), which restores default positions, dimensions, and arrow routes without moving the viewport. The first nonempty view fits automatically; subsequent edits and steps leave the viewport alone. Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl/Cmd+Y undo and redo layout changes when the canvas has focus, with a complete drag counted as one action (up to 50 actions); text inputs keep their own editing shortcuts. Layout undo does not change memory values or pointer targets.

Messages about canvas actions appear as a short toast at the bottom of the canvas: confirmations fade after a few seconds, errors stay until the next canvas action. Run and generation messages appear at the bottom of the code pane instead.

## Editing a snapshot

Playback is read-only for memory values and pointer targets, while layout remains adjustable. **Edit** (memory header) clones the displayed state and enables creation and editing in active frames. **+ Variable** and **+ Heap block** float at the top-left of the canvas; + Variable uses the selected active frame, defaulting to main. Select a frame and use its own **+ Variable**, or right-click its background and choose **Add variable here**. Right-clicking empty canvas offers **Add heap block here** and **Clear diagram**. The owning frame is highlighted. **Back to playback** restores the recorded state and step, discarding semantic edits to the copy.

Returned frames and expired locals remain read-only, though they can be moved. Freed heap blocks can be moved too; in an editable diagram they can also be marked not freed or deleted. **Generate C** converts the memory currently on screen, including a selected playback step, and leaves that memory displayed as an editable diagram. It still requires a single main frame; multiple function-frame diagrams can be explored but cannot yet be converted back into function-call code. Editing source or successfully generating C exits the saved-playback workflow.

## Boxes and arrows

Pointer values use hexadecimal text. Names and types use bounded columns, with full text available on hover. Pointer rows reserve a second line for target/status information; row metrics and CSS variables come from the same geometry definition.

Pointers choose left or right attachment sides based on relative box positions. Each editable pointer has one blue source dot on its outgoing side (the right side before it has an arrow). Drag this dot to set the pointer. Target anchors are hidden at rest, including during playback; while drawing or reconnecting an arrow, compatible editable targets appear as outlined squares on both sides. Hidden handles remain mounted so existing arrows retain their geometry. Type and array-size edits refresh handle geometry.

Targets preserve C types: for `int a[3]`, an `int *` can target `a[0]` or another element, while `int (*p)[3] = &a` targets the whole array at its header. The array header is therefore offered only to a matching pointer-to-array. Whole structs, nested aggregates, pointer variables (for pointers-to-pointers), and scalar fields likewise appear only when their types match the pointer being drawn.

Edges use cubic curves where there is a clear route, with rounded obstacle-aware detours in dense diagrams and stable loops for self-references. Select an arrow to show a draggable diamond. Drag it to set a manual bend; **Reset route**, double-clicking the diamond, or Home while it has focus restores automatic routing. Arrow keys move a focused diamond or resize control; Shift makes larger adjustments. Manual bends follow the endpoint midpoint as boxes move.

In an editable diagram, drag an arrowhead to reconnect to a compatible target. Dropping on an incompatible target or empty space leaves the original pointer unchanged. Presentation-only arrow bending is also available during playback. Layers keep frames behind edges and boxes above edges.

## Playback and code

The code and memory panes share a divider (`src/components/Workbench.jsx`). Drag it to resize, double-click (or press Enter/Home while it has focus) to reset to 38% code, use the arrow keys to move it 24 px, or drag it fully left to collapse the code pane into a rail that restores it on click. The split is remembered in `localStorage` (`pointerviz.split.v1`). Below 900 px the panes stack and the divider becomes horizontal.

**Run** (code header) prepares the execution trace at step zero. **Next**, **Previous**, and the slider navigate it. Function entry (with parameters), statements, condition checks, loop updates, and function exit have separate snapshots.

The code editor colours C keywords, types, function names, literals, comments, and preprocessing lines. Yellow marks the line about to run; the highlight clears at completion or when source code changes. New frames/objects get yellow outlines, changed value rows get yellow backgrounds, and new or redirected pointer edges turn yellow for that step. Highlights compare adjacent execution snapshots, including when stepping backward.

Automatic routing is a lightweight heuristic, not a general obstacle solver. Manual bends follow the student's placement and may cross other boxes. Deliberately overlapping frames/boxes can leave no clear route, and dense graphs can share edge segments. Use **Reset layout** or move the frames apart. Frame borders are grouping boundaries, so arrows may cross them to reach variables.

## Implementation

- `src/flow/layout.js`: visibility, initial placement, minimum dimensions, typed handles, edge data.
- `src/flow/workspace.js`: positions, resizing, growth, content fitting, and layout undo/redo.
- `src/flow/routing.js`: cubic curves, manual bends, obstacle-aware fallback, self-loops.
- `src/flow/memoryFlow.jsx`: node/edge React components.
- `src/components/Workbench.jsx`: resizable, collapsible code/memory split shared by Sandbox and Challenges.
- `src/components/MemoryCanvas.jsx`: session layout, drag gestures, selection, floating creation controls, context menu, semantic editor, out-of-scope toggle, toast, viewport and reveal-on-inspect panning.
- `src/components/MemoryInspector.jsx`: overlay with read-only address facts, typed target editing, and exact subobject navigation.
- `src/machine/addresses.js`, `src/machine/editing.js`: simulated address placement and atomic structural edits.
- `src/flow/addressPresentation.js`: safe pointer descriptions and formatting.
- `src/styles.css`: fixed header/row dimensions and visual layers. Keep these dimensions in sync with `GEOMETRY`.

The parent/child layout follows React Flow's [sub-flow model](https://reactflow.dev/learn/layouting/sub-flows). Parent nodes precede children and children use relative positions. Children have no fixed parent extent; workspace operations grow the parent to preserve ownership, header space, and padding. Custom edges render through [BaseEdge](https://reactflow.dev/api-reference/components/base-edge).

The controlled canvas preserves dimension measurements reported by React Flow. Dropping them when regenerating nodes invalidates handle bounds, which can break dragging and prevent automatic fitting from settling. Measurements are reused only while the expected dimensions still match.
