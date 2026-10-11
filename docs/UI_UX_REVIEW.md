# PointerViz UI/UX review

> **Superseded in part (11 October 2026):** layout, toolbar and inspector recommendations were reworked and implemented in [SANDBOX_UI_PLAN.md](SANDBOX_UI_PLAN.md). The Generate-from-snapshot fix (section 6) is done. Draft persistence, semantic undo and the other non-layout findings remain open.

Reviewed 25 September 2026 against the current working tree, including the new memory-address interface.

## Assessment

The new memory information is useful, but its presentation has made the interface harder to read. The main problem is an unstable information hierarchy: changing the relationship view also changes object metadata, pointer values, and table columns. Meanwhile, low-frequency layout controls compete with the learning task.

**Recommendation: use one consistent memory presentation, make arrow visibility a separate setting, and move detailed explanations and structural editing out of the main reading path.** Fix draft loss and misleading conversion behavior alongside the visual cleanup.

“Stack” and “heap” are meaningful concepts, but repeating either word in the space previously occupied by an address contributes little. Likewise, the simulated-address explanation is worth retaining, but does not warrant permanent toolbar prominence.

This is an expert review, not a learner usability study. Findings marked **observed** were reproduced in the local browser; **source review** findings follow directly from the implementation. Proposed improvements are design judgments that should be checked with learners.

## Review coverage

- Browser: initial empty Sandbox; scalar, pointer, and array playback; all three memory views; pointer inspection and target navigation; edited snapshots; scalar editing; section navigation; freed-memory challenge; initial Level editor.
- Layout: narrow embedded browser, 1280 × 800, and 1440 × 900. The inspector's bottom and side arrangements were both inspected.
- Source: memory cards, inspector, layout sizing, toolbar, playback/conversion, challenges, instructor preview, and responsive styling.
- Not validated: a full screen-reader session, touch hardware, 200% zoom, large-array performance, or learner comprehension. Accessibility and scale concerns below identify further checks rather than claiming those tests passed.

## Priority overview

P1 means address in the next usability pass; P2 means follow after the basic interaction model is stable. Effort is relative scope, not a delivery estimate.

| Priority | Problem | Recommended change | Effort |
| --- | --- | --- | --- |
| P1 | View selection changes several meanings at once | Stable memory cards; independent arrow visibility | Medium |
| P1 | Pointer address roles are clearer in the inspector than on the canvas | Consistent “Located at”, “Stores”, and “Points to” labels | Small–medium |
| P1 | Inspection takes too much space and puts editing below reference material | Concise inspector summary; contextual editing; expandable layout details | Medium |
| P1 | Toolbar overemphasizes secondary actions | One display control, one fit action, contextual history, overflow menu | Small–medium |
| P1 | Undo does not restore memory edits; drafts disappear across sections | Recoverable editing and persistent session drafts | Medium–large |
| P1 | Generate can use a different state from the one displayed | Generate from the selected snapshot; preserve original source | Medium |
| P2 | Canvas sizing and viewport behavior impede reading | Resizable workbench, tighter cards, selected-object visibility | Medium |
| P2 | Playback and status feedback are hard to interpret | Explicit playback state and a concise change summary | Medium |
| P2 | Large aggregates and repeated names will be hard to navigate | Grouped members, search, readable call identifiers | Medium |
| P2 | Challenges and Level editor inherit unnecessary controls and confusing states | Task-specific defaults and accurate preview feedback | Small–medium |

## 1. Replace representation modes with a stable information contract

**Observed:** for the same pointer and selection, switching Both → Arrows removes the object's address, replaces it with “stack”, replaces the stored address with an arrow glyph, and removes aggregate address columns. The target caption remains, as do full addresses in the inspector. Switching to Addresses hides persistent connecting arrows. Show target can then reveal an individual arrow in that mode.

The issue is not simply that information is hidden. One control changes several independent things, and an existing visual slot acquires a different meaning. “Both” also requires users to learn what two things are being combined. Object geometry remains stable across these modes, which is good, but stable geometry does not compensate for unstable content.

### Recommended behavior

Retire Arrows / Both / Addresses as the primary mode selector. Provide a **Connections: All / Selected / Hidden** setting inside a compact Display menu. Default to All for introductory diagrams. These settings affect connecting lines only.

Keep the object content consistent:

| Information | Default presentation | When connections change |
| --- | --- | --- |
| Object/member identity and C type | Always visible | Unchanged |
| Scalar value | Always visible | Unchanged |
| Pointer's stored address and symbolic target | Always visible, with distinct labels | Unchanged |
| Object's own/base address | Quiet secondary metadata | Unchanged |
| NULL, uninitialized, dangling, one-past, freed, out-of-scope status | Always explicit when applicable | Unchanged |
| Individual array/member addresses, offsets, detailed size/layout | Selection inspector; optional expanded aggregate details | Unchanged |
| Storage category | Frame/group context or small consistent badge | Unchanged |

This preserves the address-to-pointer connection while reducing repeated numeric columns in aggregates. It deliberately keeps two address roles on pointer cards; hiding either would weaken the new feature. Reduce their visual weight and surrounding repetition instead.

If a later introductory lesson needs to hide numbers, make that an explicit **Show numeric addresses** preference. It must not be a side effect of changing arrows, and hidden address rows must not become unrelated “stack/heap” rows. Do not add this extra preference until there is a demonstrated teaching need.

**Acceptance:** change Connections through all options while inspecting `p`. Its name, type, own address, stored address, target, status, selection, playback step, and viewport remain unchanged. Only connection visibility changes. Keyboard and narrow-screen controls expose the same choices.

## 2. Make the pointer relationship readable without opening the inspector

**Observed:** canvas labels are currently “Address” and “Value”. The inspector provides the much better distinction “Address of p (&p)”, “Stored address (p)”, and “Target value (*p)”. Canvas addresses have eight hex digits; inspector addresses have sixteen, adding a formatting difference to the conceptual difference.

Use the same vocabulary and number format throughout. Keep expanded formatting, if needed, under details. Copying should copy the displayed value unless a separate action explicitly says otherwise.

Suggested compact cards, using illustrative addresses from the reviewed example:

```text
p                                  int *
Located at 0x10010000
Stores     0x10000000       Points to a

a                                    int
Located at 0x10000000
Value      10
```

Use hierarchy rather than equally prominent rows: name and value first, location metadata quieter. Keep the symbolic target usable as a navigation action. Remove the large standalone arrow glyph inside a pointer's value cell; the target text and actual connection already convey that relationship.

Keep `*p` in the inspector by default. Repeating target values on every pointer card would add clutter and become confusing for pointer chains and aggregates.

Move per-object byte counts out of the mandatory metadata strip. They are especially useful for array stride and layout lessons, so expose them in aggregate detail and the inspector. Keep lifetime warnings prominent even when other details are collapsed.

Use plain status text such as:

- `NULL — no target`
- `Uninitialized — no stored value`
- `Dangling — target was freed`
- `One-past — cannot dereference`

Do not turn a historical address into an apparently valid target. For one-past pointers, navigate to a labeled boundary without inventing a value cell.

## 3. Rebuild the inspector around the selected object and immediate task

**Observed:** inspecting a simple pointer produces a heading, qualified identity, storage/lifetime summary, own address and Copy, size/offset, stored address and Copy, status, target, dereferenced value, Show target, and explanatory text. Editing then adds a second Target control plus name, shape, type, pointer depth, and deletion.

The information is mostly correct, but too much has equal priority. “+0 bytes from p”, “valid”, repeated target labels, and `main() [main]` all consume attention before the learner reaches the action they need.

Use three levels:

1. **Selection summary:** `p · int * · main()` and an exceptional status when relevant. For a selected member, put `values[1]` in the heading rather than identifying only the containing object.
2. **Current meaning:** what it stores, its target, target value, and its own location. Put Change target beside the existing target in editable states; use the same area for an editable scalar value.
3. **Details / Edit structure:** collapsible byte size, offset, storage/lifetime detail, model explanation, name/type/shape changes, and destructive actions.

The important relationship should fit without scrolling:

```text
p · int * · main()

Stores (p)           0x10000000
Points to            a                    Show
Target value (*p)    10
Located at (&p)      0x10010000

▸ Memory layout      ▸ Edit structure
```

Retain the useful teaching sentence about a pointer having its own address and storing another address, but place it behind an accessible “About pointers” help action or show it once in an introductory lesson.

Show target should highlight the source–target pair without immediately replacing the source inspector. Offer **Inspect target** separately, or keep a simple Back to p trail. The current action changes selection to the target, so the information the user was comparing disappears.

For long candidate lists, replace the native Target dropdown with a searchable, keyboard-accessible picker grouped by call and allocation. Prefer names and types in the list; numeric addresses can be secondary. Retain compatible-target filtering and explicit NULL/uninitialized choices.

**Acceptance:** inspecting `p` reveals all four core facts and its target action without scrolling at 1280 × 800. Showing `a` preserves an obvious way to compare with and return to `p`.

## 4. Reduce the toolbar to controls needed during reading

**Observed:** the toolbar mixes representation, help, Fit view, Reset layout, Undo, Redo, Snap, and Show expired. An editing row adds creation and Clear. The canvas also supplies a second Fit View control. Even at 1440 pixels, the memory toolbar wraps in the reviewed workbench.

Recommended arrangement:

| Location | Controls |
| --- | --- |
| Memory header | Playback/editing state; Edit snapshot or Return to playback |
| Main canvas toolbar | Display; Fit; contextual Add object when editing |
| Display menu | Connections; aggregate memory details; expired stack objects when relevant |
| Arrange menu | Snap to grid; reset layout; frame arrangement actions |
| Contextual editing/history | Undo/Redo with explicit scope; selected-object actions |
| Help | Pointer explanation and simulation model |

“Simulated addresses” is technically an expandable explanation, not a selector. Its placement makes it look like a frequent display operation. Remove it from the primary toolbar. Retain a short contextual note near address help: **“Addresses are simulated; real programs may place objects differently.”** Put pointer size, spacing, and non-reuse in a fuller model explanation.

Keep one discoverable Fit action. Avoid permanently reserving a message strip for routine announcements such as “Arrows view”. The selected control already conveys that state; accessibility announcements can remain without a persistent visual row.

Use `Show out-of-scope stack objects (3)` when relevant instead of an unexplained, always-visible Show expired checkbox. Freed heap objects currently remain visible independently of this checkbox; make that distinction explicit in help. Keep storage identifiable through a textual group label or badge, not color alone.

## 5. Make editing recoverable and preserve work

### Undo currently promises more than it does

**Observed:** changing scalar `a` from 10 to 11 leaves Undo disabled. **Source review:** the history controls restore layout only; memory changes, deletions, and Clear are not part of that history. The qualifier appears in a tooltip, not the button label.

Immediately rename these controls **Undo layout / Redo layout**, or put them inside Arrange. Then implement memory edit history covering value/target changes, structural edits, object creation/deletion, and Clear. Prefer one chronological history within the diagram workspace once both kinds of changes are supported, while leaving normal text-editor undo scoped to the editor.

Move Clear into a secondary menu and make it recoverable. Routine editing should not need repeated confirmation dialogs when a reliable Undo is available.

### Section navigation discards the Sandbox

**Observed:** after creating the pointer/array example, visiting other sections and returning to Sandbox restored the starter program and empty canvas. **Source review:** the application unmounts each section and stores its draft in component-local state.

Preserve each section's draft, playback position, and relevant layout across navigation. Preserve unsaved Level editor drafts and in-progress challenge answers as well. An explicit New/Reset action should define when work is discarded. Do not add an “Are you sure?” prompt to every tab switch as a substitute for preserving state.

**Acceptance:** edit source and memory, navigate through all sections, and return with the draft intact. Undo restores a changed value, a retargeted pointer, a deleted object, and a cleared diagram.

## 6. Align playback, editing, and generation with the visible state

**Observed:** immediately after Run, the canvas is empty at step 0. Pressing Generate produces code containing `a = 10`, displays the final memory, and ends playback. **Source review:** generation uses the stored final `state`, whereas the canvas renders `shownState` for the selected step.

This is a trust problem: “Generate C from memory” appears to refer to the memory currently visible.

Make the action **Generate from this snapshot**, and use the selected snapshot. If it cannot be generated, explain the specific limitation before replacing source. Preserve original source and open generated code as a preview with an explicit Replace source action. A final-state generation command, if retained, must say **Generate from final state**.

Clarify execution state in the interface:

- Before execution: Run or Start stepping is the primary action; show a useful empty-state instruction.
- During playback: `Step 5 of 6 · read-only`, Previous/Next, and a short description such as `q now points to values[1]`.
- While editing a copy: `Editing a copy of step 5`; keep Return to playback beside that label and make it clear that returning restores the recorded execution.
- After source changes: mark the diagram as belonging to the previous run, or keep it visibly separate until rerun. The current source handler exits playback immediately and can expose the final stored state as editable.

Yellow currently marks both the next code line and memory changed by the last step. Those are different moments. Use explicit text such as **Next statement** and **Changed this step**; do not require color alone to explain execution order.

Show one current result/message, with expandable history for older messages. The reviewed interface retained “Select Next to begin” after leaving playback, alongside unrelated later messages.

## 7. Give the diagram enough usable space

**Observed:** opening the inspector reduces the canvas substantially. At 1440 × 900 it takes a 340-pixel side column from the memory pane. At 1280 × 800 it becomes a bottom panel; in the inspected state the selected content was no longer comfortably visible. During incremental playback, later objects extended below the viewport until Fit was used.

**Source review:** every object is at least 320 pixels wide, frames begin at 600 pixels, and the central conversion strip consumes 104 pixels even when the challenge view has no conversion buttons. These costs accumulate before adding the inspector.

Recommended changes:

- Move Run into the code header and Generate into the memory actions. Remove the full-height central strip, including the empty strip in Challenges.
- Add a resizable code/memory divider and a Memory focus action. Let users reclaim unused editor space without changing display semantics.
- Make the inspector resizable or use a compact bottom drawer with an intentionally small summary. Avoid showing the entire editing form by default.
- On inspector open, pan only enough to keep the selected object visible. Do not automatically fit the whole graph or change zoom on every selection.
- When a step creates off-screen memory, offer a small **Show changed object** action or minimal pan when the user has not manually navigated away. Preserve deliberate panning.
- Reduce scalar card width and frame whitespace using content-aware minimums. Keep positions stable across connection settings and recompute bounds only when actual content/detail changes require it.
- Keep header text, status, and labels readable before prioritizing “everything fits”. At low zoom, simplify peripheral labels and offer focus-on-selection rather than shrinking every detail indefinitely.

For arrays and structs, add collapsible groups and an explicit path breadcrumb. A selected element, changed element, or pointer target must be revealed when needed. Whole-array identity, member identity, and one-past boundaries must remain distinct even when some numeric addresses coincide.

## 8. Improve interaction discoverability and accessibility

The existing typed target picker, explicit lifetime text, keyboard-operable frame resizing, and focus styles are useful foundations.

Remaining concerns from source and browser inspection:

- Names and “Value” labels look like static text until hover. Provide a clear selected-row treatment and a visible Details action on selection; make focus equivalent to hover.
- The code editor intercepts Tab and Shift+Tab for indentation without an implemented keyboard escape convention. Add and disclose a way to leave the editor using the keyboard, then test it end to end.
- Edge accessibility labels expose internal IDs such as `a1` and `a0`. Announce `p points to a` or the qualified member names instead.
- Add understandable call-instance labels when repeated functions contain the same variable names. Avoid showing raw frame IDs as routine teaching copy.
- Ensure Copy and target actions are usable on focus and touch, not only on hover. Keep keyboard target selection as a first-class alternative to dragging small handles.
- Verify selection, changed memory, lifetime errors, and grading errors remain distinguishable when several apply simultaneously. Text/status icons should supplement outlines and color.

Do not claim accessibility conformance based on these changes alone; test keyboard traversal, zoom, and a screen reader with real learning tasks.

## 9. Adjust Challenges and Level editor to their specific tasks

**Observed:** a read-only target challenge inherits the full layout toolbar and the persisted Addresses preference. Both symbolic target captions and address numbers remain visible. Challenge prompts ask users to reproduce the memory state, which may suggest reproducing the numbers too.

State near the task instructions: **“Match values, types, and pointer relationships; simulated address numbers do not need to match.”** Keep grading requirements visible without burying them in model help. Use sensible lesson defaults, allow display changes, and avoid silently carrying an unsuitable mode into an introductory lesson.

Keep read-only inspection and target navigation. Put layout customization behind Arrange. Retain editable object creation only in build-the-diagram exercises. Use names and member paths in feedback, and highlight the relevant object or relationship alongside the explanation.

**Observed:** the Level editor initially shows “fix the code to see the preview” beside its valid starter code. **Source review:** preview starts as null and is evaluated only after an edit. Each source change also remounts the canvas through `key={code}`, resetting the preview workspace.

Evaluate the initial example, distinguish “not yet previewed” from a real syntax error, and preserve the preview layout across valid edits. Debounce expensive preview work if necessary. Preserve drafts when switching sections and distinguish unsaved changes from a saved level.

## Delivery sequence

1. **Restore trust and remove obvious clutter:** preserve drafts; correct generation scope; label layout-only Undo; remove the primary simulated-address disclosure; consolidate Fit; fix initial preview feedback and stale status messages.
2. **Stabilize memory presentation:** consistent labels and formatting; independent connection visibility; compact cards; concise inspector; source-preserving target navigation. Update the existing memory-address design document to reflect the revised contract.
3. **Improve editing and available space:** semantic Undo, consolidated editing controls, resizable workbench/inspector, selected-object visibility, aggregate navigation, and task-specific challenge controls.
4. **Validate with learners before adding more options:** compare the current interface and the proposed one using the same short tasks.

## Validation tasks and success criteria

Use a small formative group of novice C learners. Record incorrect answers, unnecessary mode changes, inspection/navigation steps, and points where participants lose their place. Treat improvements as hypotheses until observed; do not invent percentage targets without a baseline.

| Task | What success looks like |
| --- | --- |
| Given `int a = 10; int *p = &a;`, identify `&p`, `p`, and `*p` | Learner distinguishes location, stored address, and target value without changing connection settings |
| Compare two pointers to the same element | Learner recognizes shared target/stored address despite different pointer locations |
| Follow `p + 1` through an array | Learner locates the exact element and explains the type-sized stride using available detail |
| Change Connections while inspecting a pointer | No lost facts, selection, scroll position, or playback context |
| Inspect a freed or one-past target | Learner recognizes why it cannot be dereferenced, without mistaking a displayed address for validity |
| Change a target, then undo | Original relationship is restored predictably |
| Switch sections and return | Source, draft memory, and playback position remain intact |
| Generate at an intermediate step | Output corresponds to that step, and original source remains recoverable |
| Complete the same inspection with keyboard only | Editor can be exited; selected member, target action, and return path are accessible |
| Repeat at desktop size, narrow width, and 200% zoom | Controls remain reachable and the selected object can be read alongside its essential details |

## Implementation evidence map

These are starting points for the implementation, not a request to change interpreter semantics.

| Area | Current source |
| --- | --- |
| Mode-dependent card content and labels | [memoryFlow.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/flow/memoryFlow.jsx:69) |
| Toolbar, layout-only history, target navigation | [MemoryCanvas.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/MemoryCanvas.jsx:174) |
| Inspector facts and editing order | [MemoryInspector.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/MemoryInspector.jsx:54) |
| Address formatting and persisted mode | [addressPresentation.js](C:/Users/Timothy/Documents/NUS/pointer-viz/src/flow/addressPresentation.js:5) |
| Card/frame sizing and connection visibility | [layout.js](C:/Users/Timothy/Documents/NUS/pointer-viz/src/flow/layout.js:29) |
| Generation versus displayed snapshot | [Sandbox.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/Sandbox.jsx:69) |
| Section unmounting and draft lifetime | [App.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/App.jsx:32) |
| Inspector sizing and responsive behavior | [styles.css](C:/Users/Timothy/Documents/NUS/pointer-viz/src/styles.css:109) |
| Challenge-specific interface | [Challenges.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/Challenges.jsx:48) |
| Initial and remounted instructor preview | [LevelEditor.jsx](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/LevelEditor.jsx:28) |

The strongest existing features to preserve are the separation of pointer location from stored address, symbolic target identity, typed targeting, explicit invalid/lifetime states, and stable diagram positions. The next iteration should make these easier to read and act on before expanding the set of display modes.
