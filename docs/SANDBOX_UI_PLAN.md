# Sandbox UI plan: give the canvas the room

Written 11 October 2026. **Implemented 11 October 2026**, including the Generate fix. Differences from the plan: Challenges keeps its message bar for hints (canvas messages there now use the toast); 8-digit addresses are shown in the inspector to match the cards (Copy still copies 16 digits); aggregate cards have a 260 px minimum width so the address column fits. This replaces the layout and toolbar parts of [UI_UX_REVIEW.md](UI_UX_REVIEW.md). Its correctness findings (Generate uses the wrong state, Undo only covers layout, drafts are lost when switching tabs) are still valid, and they are tracked separately under "Out of scope" below.

## Goal

Two panes, one divider, one header row per pane. Every pixel not needed to read code or memory goes to the canvas. We remove controls instead of moving them into menus. Anything that stays is either visible directly or shown only in the situation where it applies.

### Rules for every change

1. **No new rows.** Each pane has a header and the playback bar is the only footer. Any other control floats over the canvas or shows up only when it applies.
2. **No new settings.** We don't add display modes, menus or preferences. If a choice isn't clear enough to be a single button, remove it.
3. **Nothing resizes the canvas while you work.** Selecting an object, showing a message or opening the inspector must never shrink the React Flow viewport.
4. **Reuse what exists.** That means React Flow `<Controls>`, the existing `plain-btn` / `panel-head` styles and the current `layoutHistory` keyboard shortcuts.

## Where the space goes today

At 1280 × 800, Sandbox, editable, with an object selected (sizes estimated from `styles.css`):

| Element | Cost | Source |
| --- | --- | --- |
| Top bar | 48 px tall | `.topbar` |
| Central Run/Generate strip | **104 px wide**, full height, mostly empty | `.spine`, [Sandbox.jsx:107](../src/components/Sandbox.jsx) |
| Memory panel head | 38 px | `.panel-head` |
| Canvas toolbar (11 controls, wraps to 2 rows) | ~84 px | [MemoryCanvas.jsx:376](../src/components/MemoryCanvas.jsx) |
| Edit toolbar | ~42 px | `.canvas-edit-toolbar` |
| Canvas status line | 24 px (always reserved) | `.canvas-status` |
| Stepper | 42 px | `.stepper` |
| Sandbox message log (repeats canvas status) | up to 110 px | `.msgbar` |
| Inspector | **340 px wide**, taken from the canvas | `.inspector` flex sibling |

The canvas ends up around **690 × 460 px**. With the inspector open it drops to about **350 px wide**. Fixed card sizes make this worse: every object is at least 320 px wide ([layout.js:67](../src/flow/layout.js)) and every frame starts at 600 px ([layout.js:156](../src/flow/layout.js)).

## Target layout

```text
┌ PointerViz   Sandbox  Challenges  Level editor ─────────────────────────────── 40px ┐
├ C CODE              [▶ Run] ┃ MEMORY  step 3/6 · main() line 4  [Edit] [Generate C] ┤ 34px
│  1 int main(void) {         ┃ ┌[+ Variable][+ Heap]──────────────┐ ┌ Inspector ──┐ │
│  2     int a = 10;          ┃ │                                   │ │ p · int *   │ │
│▸ 3     int *p = &a;         ┃ │        memory canvas              │ │ Stores  …   │ │
│  4     return 0;            ┃ │                                   │ │ Points to a │ │
│                             ┃ │ [+][-][⤢][↺]       ⓘ message toast│ └─────────────┘ │
│ ⚠ line 3: parse error …     ┃ └───────────────────────────────────┘                 │
├─────────────────────────────┨ [◀ Prev] ━━━━━━●━━━━━━━  3/6  [Next ▶]          40px ┤
└─────────────────────────────┸───────────────────────────────────────────────────────┘
        drag ┃ to resize, double-click to reset
```

Estimated canvas at 1280 × 800: about **790 × 690 px**. Opening the inspector covers part of the canvas but doesn't shrink it.

## Changes

### 1. Remove the central strip and add a draggable divider

- Delete `.spine`. Put **Run** in the C code header, styled as `primary-btn`, since it's the main action. Put **Generate C** in the Memory header.
- Replace the fixed `grid-template-columns` with a 6 px **divider** between the panes:
  - Drag it to resize. The code pane is at least 220 px and the memory pane at least 360 px.
  - **Double-click** it to go back to the default (code at 38%, down from today's ~42% + 104 px).
  - Give it `role="separator"`, `aria-orientation="vertical"` and `aria-valuenow`. Left and right arrow keys move it 24 px.
  - Save the ratio in `localStorage` inside try/catch, using the same pattern as `saveViewMode`.
  - Drag the divider all the way left to collapse the code pane to a 28 px rail that shows the vertical label "C code". Click the rail to restore the pane. That gives a canvas-only mode without adding a button.
- Build this as a small shared `Workbench` component (`left`, `right` and the divider). Challenges uses the same `workbench` / `spine` markup ([Challenges.jsx:133](../src/components/Challenges.jsx)), including an **empty** spine, so it gets the fix for free.
- Below 900 px the panes stack vertically and the divider becomes horizontal (`aria-orientation="horizontal"`, `row-resize`).

### 2. Replace the canvas toolbar

Remove the whole `.canvas-toolbar` row. Here is where each control goes:

| Current control | Decision | Reason |
| --- | --- | --- |
| View: Arrows / Both / Addresses (+ narrow `<select>`) | **Remove.** Always render today's "Both" content. | The old review showed that the modes change several meanings at once. One fixed view is the simplest fix and also deletes code. |
| Simulated addresses `<details>` | **Remove** from the toolbar. Put a single muted line in the inspector under the addresses: "Simulated addresses — real programs may differ." | It's reference text, not a control. |
| Fit view | **Remove.** `<Controls>` already has a fit button. | It was a duplicate. |
| Reset layout | Becomes a `ControlButton` (↺, labelled "Reset layout") inside `<Controls>`. | It's a canvas-view action, so it belongs with zoom and fit. |
| Undo / Redo | **Remove the buttons.** Keep Ctrl+Z / Ctrl+Shift+Z and give `Reset layout` the tooltip "Undo layout: Ctrl+Z". | They only undo layout, so the buttons promised more than they do. Semantic undo is out of scope. |
| Snap | **Remove.** Leave snapping off. | It's rarely used and you can line things up by eye. |
| Show expired | **Show only when relevant.** If some frames have returned, a small chip appears in the canvas bottom-right: "2 ended calls hidden · Show". When they're visible it reads "Hide ended calls". | You only need it after a function has returned. |

### 3. Replace the edit toolbar

- Remove the `.canvas-edit-toolbar` row.
- While editing, float two `plain-btn` buttons at the canvas top-left (`position: absolute`, like `.edge-tools`): **+ Variable** and **+ Heap block**. Same handlers as today: `addBox('stack', addFrameId)` and `addBox('heap')`.
- **Clear** moves into the existing right-click menu as "Clear diagram". Right-clicking the empty canvas opens it too, along with "Add variable here". It's destructive and rarely used, so it shouldn't sit next to the add buttons.
- Keep the existing frame right-click "Add variable here".

### 4. One message channel, no reserved rows

- Right now `notify` writes both to `.canvas-status` and, through `onMessage`, to the Sandbox `.msgbar`, so the same message shows up twice.
- **Errors from Run** (parse and runtime errors): show them as a footer at the bottom of the **code pane**, only while an error exists, and clear them on the next edit or run. They're about the code, so they go next to the code.
- **Canvas messages** (retargeting, edit validation, "Showing a"): show a single toast at the canvas bottom-centre. `ok` messages fade after 4 s. `err` messages stay until the next canvas action. Keep `role="status" aria-live="polite"` so screen readers still hear them.
- Delete `.msgbar` from Sandbox and drop the 5-message history. Delete the reserved `.canvas-status` row.
- Stop announcing routine actions such as "Arrows view", which goes away anyway with item 2.

### 5. Turn the inspector into an overlay

- Make `.inspector` `position: absolute` in the top-right of `.canvas-content`. It's currently a flex sibling. Width 300 px, `max-height: calc(100% - 24px)`, scrolls internally, with a drop shadow. **The React Flow viewport keeps its size.**
- When the selected node would be hidden under the inspector, pan just enough to show it, using `setCenter` with the current zoom. Replace the current `fitView({ nodes: [target], padding: 0.6, maxZoom: 1 })` in `showTarget`, which changes the zoom.
- Flatten the content into one column with no nested sections:
  1. Heading `p · int *` with a close button ✕ (instead of a "Close" text button).
  2. Member picker, only for aggregates (unchanged).
  3. Facts, with labels shortened to a fixed set: **Located at (&p)**, **Stores (p)**, **Points to**, **Value (*p)** / **Value**. Size and offset go on one muted line under the heading, for example `8 bytes · +0`.
  4. **Show target** button.
  5. When editable: Value or Target field, then Name and Type on one row (`type-row`), then Shape/Length, then a row of actions: `Mark freed` and `Delete`. Remove the "Edit object" `<h4>` heading and the extra border.
  6. A one-line muted note about simulated addresses (from item 2). The current two-sentence pointer explanation is replaced by this.
- Narrow canvas (`@container memory (max-width: 760px)`): becomes a bottom sheet, 100% wide and at most 45% tall, still overlaid. The canvas doesn't reflow.

### 6. Make the headers more compact

- `.topbar` goes from 48 to 40 px and `.panel-head` from 38 to 34 px. Keep the uppercase muted titles.
- Memory header, left to right: `MEMORY`, then context (`step 3/6 · main() line 4`, or `Editing copy of step 3`, or nothing), then on the right `[Edit]` / `[Back to playback]` and `[Generate C]`. "Edit this snapshot" is shortened to **Edit**, and "Return to playback" to **Back to playback**.
- When playback reaches the end, the code header shows "Execution complete" as it does today. When the next line is known, the line highlight already shows it, so drop the "Next: line N" text.

### 7. Make cards and frames take less space

- In [layout.js:67](../src/flow/layout.js), lower the minimum card width from 320 to **200** and keep 440 as the maximum. The text-width estimate already sets the actual size.
- Frame width at [layout.js:156](../src/flow/layout.js) should come from its content (`max(FRAME_MIN.width, contents + padding)`) instead of starting at 600. Use `FRAME_MIN.width` 240 instead of 288.
- Gap between frames ([layout.js:206](../src/flow/layout.js)) goes from 96 to 64 px, and `GEOMETRY.gap` from 32 to 24.
- Don't change the row heights. Handles and edge routing depend on `GEOMETRY.row` / `header`.
- Check `.aggregate-line` grid columns (`minmax(36px,1fr) 10ch minmax(10ch,auto)`) still fit at 200 px with an 8-digit address. Widen the card minimum for aggregates only if they don't.

### 8. Playback bar

Keep `.stepper` as the only footer, rendered during playback only. Shrink it to 40 px. No other change.

## Removed code (expected)

- `VIEW_MODES`, `readViewMode`, `saveViewMode` and the `viewMode` prop on `stateToFlow` / `memoryFlow.jsx`. Remove the arrows and addresses branches and the `.view-*`, `.view-mode*` and `.address-model-info` styles. Edges are always shown, so remove the `revealedPointer` hiding in [layout.js:322](../src/flow/layout.js), but keep the `revealedPointer` highlight if it's used for emphasis.
- `.spine`, `.convert-btn`, `.canvas-toolbar`, `.canvas-edit-toolbar`, `.history-toggle`, `.msgbar`, `.canvas-status`.
- `snap` state and the `snapToGrid` wiring.

Update [MEMORY_ADDRESSES_DESIGN.md](MEMORY_ADDRESSES_DESIGN.md) and [VISUALIZATION.md](VISUALIZATION.md) so they describe a single view, and add a line to the CHANGELOG.

## Implementation order

Each step leaves the app working and can be reviewed on its own.

1. **Workbench and divider** (items 1, 6): new `Workbench` component, Run and Generate moved into the headers, spine removed, Challenges switched over. This is the biggest gain for the least risk.
2. **Toolbar removal** (items 2, 3): delete the view modes, move Reset into `<Controls>`, float the add buttons, Clear into the right-click menu, ended-calls chip.
3. **Messages** (item 4): code-pane error footer, canvas toast, delete `.msgbar` / `.canvas-status`.
4. **Inspector overlay** (item 5): absolute positioning, minimal pan, flattened content.
5. **Card density** (item 7): geometry constants. Visually re-check edges, handles and frame resizing.

## Acceptance checks

Test at 1280 × 800 and 1440 × 900 in the browser pane, then at 375 px wide.

- With nothing selected in the editable Sandbox, the memory pane has exactly **one** header row above the canvas and no rows below it. During playback the stepper is the only row below.
- Selecting, inspecting or dismissing an object **doesn't change** the React Flow container's `getBoundingClientRect()`.
- Dragging the divider resizes both panes smoothly. Double-click resets it, arrow keys move it, and the ratio survives a reload. Dragging fully left collapses the code pane to a rail, and clicking the rail restores it.
- Run works from the code header and Generate from the memory header. In Challenges there's no gap between the panes.
- A Run error appears once, in the code pane footer, and clears on the next edit. A canvas edit message appears once, as a toast.
- "Show ended calls" appears only after a function has returned.
- `int a = 10; int *p = &a;`: inspecting `p` shows Located at, Stores, Points to and Value (*p) without scrolling, and `p` stays visible next to the inspector.
- Ctrl+Z still undoes a node drag. Right-click → Clear diagram empties the canvas.
- Run the existing tests (see [TESTING.md](TESTING.md)) and confirm they pass. Update any snapshot or DOM assertions that refer to removed controls.

## Out of scope (still valid, separate work)

These come from UI_UX_REVIEW.md and aren't about layout:

- **Generate uses the final `state`, not the displayed `shownState`** ([Sandbox.jsx:45](../src/components/Sandbox.jsx)). Since Generate is moving into the memory header in step 1, make it use the displayed state in the same change. It's a one-line fix and matches what the button says.
- Undo for memory edits, not just layout.
- Keeping the Sandbox draft when switching tabs (`App.jsx` unmounts pages).
- Level editor preview starting empty and `key={code}` remounts.
- Searchable target picker, aggregate collapse, call-instance labels, accessibility pass.

## Deliberately not adopted from the old review

- Display, Arrange and overflow menus, and the Connections All / Selected / Hidden setting. Each adds a layer and a choice. Removing the modes entirely is simpler.
- A three-level inspector with collapsible "Memory layout" and "Edit structure" sections. One flat, shorter list is easier to scan.
- Separate "Show target" and "Inspect target" actions with a back trail. Keep one action until learners show they need more.
- New status vocabulary and labels on the canvas cards. That's a content change; do it after the layout is stable.
