# Memory addresses: design specification and implementation plan

**Status:** Proposed; application behavior is not changed by this document.  
**Date:** 18 September 2026  
**Baseline:** PointerViz 2.2.1  
**Scope:** Sandbox, playback, editable snapshots, both challenge directions, and instructor previews.

## 1. Recommendation

Introduce **deterministic, simulated, byte-addressed memory**. Every allocation receives a stable base address, and every addressable array element or struct field derives its address from its byte offset. Retain allocation IDs and typed reference paths as the semantic identity of objects and pointers.

Offer one canvas control: **View: Arrows | Both | Addresses**, defaulting to **Both**. Both shows object addresses, the address stored in each pointer, and existing relationship arrows. Arrows reduces numeric detail; Addresses removes persistent edges. All modes provide the same inspection and editing capabilities.

Make the distinction between **where a pointer lives** and **what address it stores** explicit. For `int x = 10; int *p = &x;`, a pointer card must distinguish `Address (&p)` from `Value (p)`. Giving both numbers the label “address” would undermine the main teaching objective.

The first release does not execute native C, introduce arbitrary integer pointers, render raw bytes, or simulate address reuse. It does teach addresses, aliases, indirection, array stride, struct offsets, and lifetime using the existing interpreter.

## 2. Findings from the current implementation

| Existing behavior | Design consequence |
| --- | --- |
| `src/machine/memory.js` owns allocations, lifetimes, typed paths, cloning, and pointer status. | Assign base addresses here, when objects are created. Never derive them from canvas order or node positions. |
| Pointer values are `{ kind: 'pointer', target: { allocationId, path } }`. | Retain this representation. Compute displayed pointer addresses from the target instead of maintaining a second mutable pointer value. |
| `src/language/types.js` already implements LP64 sizes and aligned struct layout. | Reuse this profile. Pointer size is 8 bytes, including on a Windows host. |
| `src/machine/interpreter.js` has a private `addressOffset()` used by pointer comparisons. | Extract shared, validated offset computation; do not implement a different version in the UI. |
| Expired allocations remain in snapshots; one-past paths already exist. | Display historical addresses and boundaries without inventing live target objects. |
| `src/flow/layout.js` and CSS assume a 34 px header and 28 px scalar rows. | Additional metadata affects node sizes, handle coordinates, frame bounds, and routing together. This is not only a text substitution. |
| The existing inspector appears only for editable allocations. | Add read-only inspection during playback and for expired objects. Keep mutation controls separately gated. |
| Type edits directly replace an allocation's type/value; layout undo does not undo memory edits. | Structural edits need reference validation. Address display must not imply new semantic undo support. |
| Allocation/frame ID counters are module globals, reset by interpretation. | Make identity allocation state-owned or collision-safe before allowing independently interpreted states and edited copies to coexist. Address counters must be state-owned from the start. |
| Grading matches semantic graphs; generated C uses symbolic references. | Absolute address numbers must not become answer requirements or generated C literals. |
| Level packs store C source and metadata, not memory snapshots. | Existing packs regenerate their target states; no level-pack address migration is needed. |

## 3. Address model decision

### 3.1 Options considered

| Option | Strength | Problem in this product | Decision |
| --- | --- | --- | --- |
| Actual native process addresses | Useful in a native debugger | Requires a different execution backend; addresses depend on an external process and execution environment; complicates deterministic playback and diagram editing. JavaScript object locations would not describe the simulated C objects. | Reject for this feature. |
| WebAssembly linear-memory offsets | Could support a future byte-level execution engine | Adds a compiler/runtime and memory backend without solving current teaching needs better than the existing interpreter. | Defer to a separate execution-engine proposal. |
| Decorative numbers or ID hashes | Easy to add | Cannot reliably explain contiguity, `p + 1`, padding, alignment, or equal-address subobjects. | Reject. |
| Deterministic simulated addresses | Reproducible, inspectable, compatible with editing and snapshots | Needs an explicit allocation policy and clear explanation of its limits. | Adopt. |

Use the user-facing term **Simulated addresses**. “Virtual” alone could suggest addresses obtained from a real operating system.

### 3.2 Byte layout

Keep the existing PointerViz LP64 profile: `char` 1 byte, `short` 2, `int`/`unsigned int`/`float` 4, `long`/`unsigned long`/`double`/pointers 8. Alignment follows the existing type rules. Array elements use the complete element size as stride; struct fields use aligned offsets, including tail padding in the enclosing struct size.

Define a single layout operation returning `{ size, alignment, fields }`, with `fields` containing member offsets where applicable. Existing `sizeOf()` and `alignmentOf()` delegate to or share this calculation. Named recursive pointers remain finite; recursive by-value structures remain invalid.

For an addressable reference:

```text
address(reference) = allocation.baseAddress + byteOffset(reference.path)
```

Arrays, nested aggregates, and pointer objects all follow this rule. Frames are grouping/lifetime records, not C objects, and do not receive fabricated `&frame` addresses. Padding has an offset but is not an editable field or pointer target in this release.

### 3.3 Allocation placement: stable sparse ranges

Use separate monotonically assigned regions with a **64 KiB reservation per root allocation**:

| Storage | Region (end exclusive) | First bases |
| --- | --- | --- |
| Stack objects | `0x10000000`–`0x70000000` | `0x10000000`, `0x10010000`, `0x10020000` |
| Heap objects | `0x80000000`–`0xe0000000` | `0x80000000`, `0x80010000`, `0x80020000` |

Each region supports 24,576 reservations. Allocate by creation order within its storage region. Do not derive a slot from an allocation ID, frame depth, variable name, sort order, or visible-object count. Stack reservations are global to the simulated execution; each recursive invocation gets new objects even if its locals have the same names.

**Why sparse reservations:** current diagrams permit changing an object's type and array length. Packing unrelated allocations immediately together would require moving addresses or replacing objects when a user grows an array. A fixed reservation keeps base addresses stable and also prevents the one-past address of one allocation from accidentally becoming the base address of another. A packed allocator with relocation would add a substantial new editing contract for little first-release learning benefit.

This is intentional address-space spacing, not a claim that an `int` occupies 64 KiB. Display the actual size from the type. Do not allocate a 64 KiB JavaScript buffer. Under the current maximum of 4,096 scalar subobjects and supported alignments/sizes of at most 8 bytes, valid objects fit within 32,768 bytes; nevertheless enforce `size + 1 <= reservationBytes` explicitly. The extra room accommodates a root one-past address. An increase in type/resource limits requires reviewing this invariant and versioning the address profile.

Reject reservation exhaustion before mutating the state; report a simulator resource limit. Never wrap a cursor or silently overlap regions. Reservations are not reused after free, scope exit, or object deletion. A failed creation must not consume one. Clear/new execution resets the address space; cloned snapshots copy their counters.

The model does not promise physical stack growth direction, neighboring locals, allocator reuse, operating-system regions, or actual compiler placement. State this in model information, without putting allocator mechanics into the normal learning flow.

### 3.4 Representation and formatting

Use nonnegative JavaScript safe integers for the selected address range. Arithmetic must use numeric addition/multiplication, not signed 32-bit bitwise operations. No BigInt is necessary for this bounded range; existing JSON and cloning workflows remain simple.

Canvas format is lowercase hexadecimal, `0x` plus 8 digits. Inspector full format is `0x` plus 16 digits, accompanied by pointer size. These are equivalent formats with omitted leading zeros on the canvas; eight displayed digits do not mean a four-byte pointer. No decimal/hex toggle in v1.

Reserve zero as the simulator's null display value. Show **NULL** prominently, with `0x00000000` as secondary text in address modes. This is a display convention, not a claim about every native null-pointer byte representation.

## 4. UI and interaction specification

### 4.1 View modes

| Mode | Object/subobject addresses on canvas | Pointer value on canvas | Persistent relationship arrows |
| --- | --- | --- | --- |
| Arrows | Hidden; available in inspector | Arrow indicator and symbolic target label | Shown |
| Both — default | Shown | Pointee address | Shown |
| Addresses | Shown | Pointee address | Hidden |

Both makes the address-to-target relationship immediately visible and supports a gradual move from diagrams to C expressions. Addresses helps with crowded graphs and exercises in reading stored values. Arrows preserves a lower-detail introduction. An exclusive arrows-versus-addresses toggle would remove the bridge between the two representations. Independent checkboxes would allow confusing combinations and require more explanation than three named presets.

Place a labeled three-option segmented control in the canvas toolbar; use a native select when space is insufficient. This is a canvas-wide preference, not a per-pointer toggle. Remember the last selection in a versioned local preference across runs and tabs. Default to Both on a fresh install or invalid/missing preference. Storage failure falls back to session memory. Do not serialize the preference into `MemoryState`, grade it, or put view changes in layout undo history.

Changing mode preserves selection, positions, frame sizes, routes, zoom, playback step, and memory. Render nodes with the same geometry in all three modes so toggling cannot create overlaps. In Arrows, use the metadata strip for storage/size and give the value column the freed space; do not leave empty address columns.

### 4.2 Object cards

Retain the current dark product style, monospace values, storage colors, lifetime labels, and selected/changed outlines.

- Header: object name and C type, unchanged in meaning.
- Metadata strip: **Address `0x10010000` · 8 bytes**; in the inspector spell this out as **Address of p (&p)**. For arrays/structs this is the root base address.
- Scalar row: **Value** and the scalar or pointer value. Pointer addresses retain pointer color; an address location uses secondary text. Labels, not color alone, distinguish them.
- Aggregate rows: **Member | Address | Value**. Address is the location of that row's subobject; a pointer field's Value is the address it stores. Show `[i]` and field paths using the current flattened model.
- Nested aggregate targets that lack a separate row remain selectable through inspection of the path; whole-array and whole-struct handles keep their existing typed targeting behavior.
- Full address strings never ellipsize. Ellipsize long names/paths first, with full text in inspection. Do not wrap a hexadecimal token mid-address.

Initial geometry budget for implementation: 34 px title header, 24 px metadata strip, 24 px aggregate column header where needed, 32 px scalar rows, and a 20 px status line on every pointer row. Valid pointers use that line for the symbolic target. Existing 24 px lifetime banners remain. Start with a 320 px minimum card width and a 440 px normal maximum; validate long paths and null/status content before locking constants. Address and value columns each reserve at least `10ch`. All row heights, anchors, and dimensions must come from shared metrics; CSS may not independently determine them.

The extra width/height is a real cost of Both. Prefer readable numbers over squeezing three columns into today's 240 px minimum. At low zoom preserve the selected mode rather than silently hiding address data. Fit view remains explicit after mode changes. Initial fit should remain capped at the existing maximum zoom.

### 4.3 Concrete example

Given declarations in this order:

```c
int x = 10;
int *p = &x;
int **pp = &p;
```

| Object | Address of object | Value |
| --- | --- | --- |
| x | `0x10000000` | `10` |
| p | `0x10010000` | `0x10000000` |
| pp | `0x10020000` | `0x10010000` |

Both draws `pp → p → x`. Selecting p shows `&p`, `p`, its target x, and the target's value 10 as separate fields. A pointer does not store 10; it stores the displayed address of x. Do not present a target value as a safe dereference when its status forbids access.

### 4.4 Inspection and finding targets

Separate selection from editability. Objects and rows can be inspected during playback and after lifetime expiry. Expired objects remain immovable and uneditable. Keep one inspector with read-only facts plus editing controls when permitted, rather than overlapping inspectors.

Inspector content for a pointer row:

1. Name/path, C type, storage, and lifetime.
2. **Address of p (&p)**: full address of the pointer's storage, with Copy.
3. **Stored address (p)**: full target address, or null/uninitialized/historical status, with Copy only when a numeric value is available.
4. **Target**: frame-qualified object/path and type; **Show target** action.
5. **Target value (*p)** only when valid; aggregate targets show a type/size summary instead of a fictitious scalar.
6. Pointer size, containing allocation, and byte offset where they explain the selected subobject.

Show target selects and brings the semantic target into view. In Addresses mode it may show that one temporary connection while the target is being inspected; dismissing the inspection removes it. It must not change the selected mode. Use the reference path to choose the target, never a search for the first object with an equal number.

For a hidden expired target, offer **Show expired target**, enable Show expired, and locate its historical card. For one-past, **Show boundary** selects the containing object and identifies its end without creating a selectable element. For malformed/missing targets, disable navigation and explain why.

Hover/focus may emphasize a pointer and its exact target, but essential facts and target navigation must also work by click, keyboard, and touch. Do not highlight every object sharing an address as though each were the same target.

### 4.5 Editing

Arrows and Both retain existing drawing/reconnection. Addresses still permits drawing a connection: source handles remain available on editable pointer rows, compatible targets appear during the gesture, and the preview line is visible until release. The persistent edge is then hidden again.

Add a keyboard-accessible **Target** picker to the pointer inspector in every mode. List compatible live references with frame-qualified labels, C type, and address. Include NULL and Uninitialized as explicit states. Group nested paths by allocation; filter by typed compatibility before display. Use the same connection validation as dragging. A target switch changes one semantic reference and updates its displayed address and arrow together.

Numeric addresses are read-only. Do not add a textbox that accepts arbitrary hexadecimal values. The same number can describe an aggregate, its initial field/element, or a boundary; a number alone cannot resolve those choices safely.

Type/shape edits keep the root ID, reservation, and base address. They remain explicit diagram redesigns, not executed C operations. Before committing, resolve every incoming reference against the proposed type and validate its pointee type and bounds, including one-past paths. Reject the entire edit if it would invalidate a reference; name the affected pointers so the user can retarget them first. Never silently clear references or leave a partially modified diagram. If a still-valid subobject moves within the allocation, its incoming pointers follow the same typed path; show a message and highlight the changed subobject/stored addresses. Historical source objects must not be implicitly changed: reject a structural edit that would change the address/status/type of a reference stored in an expired source allocation. The original recorded playback remains untouched in all cases.

Scalar value edits, renaming, lifetime toggles, and pointer target edits do not change base addresses. Deleting a root leaves its reservation consumed; preserve the existing documented pointer-clearing behavior, but validate dead-source cases before mutation so deletion cannot throw after a partial edit. This cleanup is a dependency of a reliable address editor, not a promise of semantic undo.

### 4.6 Status matrix

| State | Canvas in Both/Addresses | Inspection/navigation |
| --- | --- | --- |
| Valid | Address plus symbolic target | Exact typed target and readable pointee value |
| NULL | NULL; secondary zero address | No target; no dereference |
| Uninitialized | `uninitialized`; no invented number | Pointer's own address exists, stored address is unknown |
| One-past | Boundary address and `one-past` | Containing object, offset, `Cannot dereference`; no fabricated target row |
| Dangling | Last target address and `dangling · former target` | Historical address/lifetime only; no current pointee value |
| Missing allocation/invalid path | `invalid reference`; no guessed number | Diagnostic without crashing the canvas |

Status text appears in every mode. Existing dashed red dangling edges remain in Arrows/Both when the historical target is visible. Freed objects retain their own address. A dangling address is diagnostic history, not a currently usable C pointer value.

### 4.7 Accessibility and explanatory copy

Provide a programmatic name such as: “p, int pointer, stored at 0x10010000, stores 0x10000000, points to x, valid.” Aggregate row labels include the member path. Segmented modes expose selected state; target picking and navigation use standard keyboard controls. Copy buttons identify whether they copy the object's location or the stored address. Announce explicit mode/target changes with a polite status region, not every hover or playback frame.

Persistent small label: **Simulated addresses**. Its accessible information control explains:

> Addresses follow PointerViz's 64-bit teaching model. Arrays and fields use byte offsets. Separate objects use spaced addresses that stay stable while you edit. Native addresses and object placement can differ.

Inspector helper copy: **A pointer has its own address and stores the address of its target.** Model details clarify eight-byte pointers, abbreviated leading zeros, and non-reuse. Do not show a recurring modal or onboarding gate.

## 5. Semantic invariants and edge cases

- Base addresses never depend on presentation. Dragging, fitting, changing view, hiding expired objects, rerouting edges, or undoing layout does not change them.
- Within a run, addresses are unchanged by stepping backward/forward, free, or scope exit. The same source and allocation sequence under the same versioned profile reproduce addresses. Different source, creation order, or a future profile can change them.
- Editing a snapshot copies the address metadata and counters. Adding an object in the copy uses that copy's next reservation. Returning to playback restores the original numbers. Equal numbers in different executions/copies are not shared storage.
- `int a[3]` at `0x10000000` has elements at `00`, `04`, and `08` relative to that base and a one-past address of `0x1000000c`. `a + 1` moves 4 bytes; `&a + 1` moves 12 bytes.
- For `int m[2][3]`, `&m[0][3]` and `&m[1][0]` display the same address but retain their distinct paths and boundary status. Numeric coincidence does not grant access through a one-past reference.
- `&a` and `&a[0]` have the same base number and different pointee types. A struct and its first member can also share a number. Keep typed anchors and target identity.
- A `struct S { char tag; int count; char end; }` has offsets 0, 4, and 8 and size 12 under the existing profile. Do not display padding as another field. An array of S has a 12-byte stride.
- Pointer arithmetic, comparison, subtraction, dereference, and free continue using existing type, provenance, bounds, and lifetime rules. Displaying numbers must not make unrelated-pointer arithmetic valid. Extracting the offset helper must preserve existing semantic tests.
- Struct copies copy field values, not the source allocation's base address. A copied pointer field retains its target reference; the destination field has its own address.
- Absolute numbers and address allocation order are excluded from graph equivalence. Canonical C continues to use `&x`, array expressions, and field expressions, with no integer-pointer casts or fixed addresses.

The relevant language boundaries are C11 draft clauses 6.2.4 (lifetime), 6.3.2.3 (pointers), 6.5.6 (pointer arithmetic), and 6.7.2.1 (struct layout). The simulated profile and allocation placement above are product decisions, not additional guarantees of C. [WG14 N1570](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf)

## 6. Proposed data model and interfaces

Persist the base once; derive sizes, field addresses, and stored pointer addresses. A proposed additive schema is:

```js
{
  allocations: [{
    id: 'a0', name: 'x', type: { kind: 'primitive', name: 'int' },
    storage: { kind: 'stack', frameId: 'main' }, alive: true,
    value: { kind: 'scalar', value: 10 },
    baseAddress: 268435456 // 0x10000000
  }],
  frames: [],
  structTypes: {},
  addressSpace: {
    version: 1,
    profile: 'pointerviz-lp64-sparse-v1',
    nextStackSlot: 1,
    nextHeapSlot: 0
  }
}
```

Keep reservation size and region definitions in the versioned profile, not repeated on every object. Identity counters can live in separate state metadata; never overload address counters as object identity.

Suggested responsibilities:

| Interface/module | Contract |
| --- | --- |
| Shared type layout in `src/language/types.js` or `typeLayout.js` | Size, alignment, field offsets; one calculation used by `sizeof` and address traversal. |
| `src/machine/addresses.js` | Profile constants, validated reservation assignment, reference byte offsets, numeric address derivation, and address metadata validation. No React or rendering dependencies. |
| `makeState`, `addAllocation`, `cloneState` | Initialize/copy counters; assign base only after type/value checks; reject duplicate IDs; commit atomically. |
| `referenceLocation(state, ref)` | Returns base, byte offset, absolute address, type, and boundary information for a valid live or historical reference; rejects malformed paths. Does not dereference storage. |
| `describePointer(state, value)` | Safe presentation result: status, optional address, target label/type, optional diagnostic. Handles invalid references without allowing them into execution. |
| `src/flow/addressPresentation.js` | Short/full formatting and accessible labels. Never parses text into pointers. |
| `stateToFlow(..., { viewMode })` | Uses semantic references and shared geometry; visibility of persistent edges is presentation only. |
| `validateAddressSpace(state)` | Checks version, safe integer range, region/slot alignment, uniqueness of root reservations, capacity, and cursors beyond assigned slots. Subobject address duplication is legal. |
| `upgradeMemoryState(state)` | Returns a normalized copy for legacy internal states; does not mutate caller-owned state or run on every render. |

Missing address metadata on a legacy internal state is upgraded in allocation-array order, separately per storage region and including dead objects. Existing versioned metadata is validated, never silently regenerated. Reject unsupported versions and mixed/inconsistent metadata with a clear error. If an old trace is normalized, process the trace as one history with a shared allocation-to-reservation map; do not independently renumber snapshots that contain different subsets of allocations.

There is currently no public saved-memory/trace format to migrate. This adapter supports old fixtures and internal API callers; custom levels still store source. Do not invent a new snapshot import/export UI as part of this change.

Cache layouts per immutable state/struct registry and distinct type where worthwhile. Avoid repeated graph-wide scans per value row. Adding addresses should remain linear in allocations plus displayed subobjects; target picker candidates can be built on demand. Avoid storing redundant computed addresses in every trace event or scalar value.

## 7. Implementation plan and gates

Ship as a sequence of reviewable changes. A later phase depends on the preceding phase's gate; estimates below are relative scope, not delivery promises.

| Phase | Scope and affected files | Completion gate |
| --- | --- | --- |
| 1. Shared layout and identity foundation — medium | Extract validated offsets from `machine/interpreter.js`; unify field layout in `language/types.js`; make allocation/frame ID creation safe across independent states and copies in `machine/memory.js`. Update callers/fixtures as needed. | Existing semantic, round-trip, and native differential tests pass; independent states cannot allocate duplicate IDs internally. No UI behavior change. |
| 2. Address state — medium | Add `machine/addresses.js`; extend creation/cloning/validation; handle old internal states at boundaries; implement state-owned sparse counters, overflow and invalid-path diagnostics. | Hand-computed layouts, deterministic reruns, non-reuse, limits, and snapshot-copy tests pass. Generated C and grading ignore absolute placement. |
| 3. Read-only display and modes — medium/large | Add formatting; update `flow/memoryFlow.jsx`, `flow/layout.js`, `flow/workspace.js`, `components/MemoryCanvas.jsx`, and `styles.css`; add shared metrics, mode preference, readable status, and read-only inspector. | All three modes work in playback, challenges, and previews; mode changes preserve geometry and state; browser checks show correct anchors and no clipped numbers. |
| 4. Editing and target navigation — medium/large | Add typed Target picker and address-only drag previews; validate structural edits/deletion atomically; implement exact-path and expired-target navigation; preserve original snapshots. | Every mode can create/retarget pointers by keyboard and pointer input; invalid structural changes leave the old state intact; edited copies do not mutate recorded playback. |
| 5. Teaching content and release verification — medium | Add examples for aliases, pointer-to-pointer, array stride, struct padding, one-past, and lifetime. Update data/model/visualization/supported-C/testing docs, README, and changelog. | Full existing test suite and production build pass; browser/accessibility matrix and formative learning checks below are complete. |

Do not expose a half-working Addresses mode before its editing and inspection paths exist. A development-only switch may keep the feature hidden while phases 2–4 land; remove or consolidate it before release. Native execution, address reuse, raw bytes, and numeric address editing require separate proposals.

## 8. Verification and acceptance criteria

### Automated checks to add

| Area | Required evidence |
| --- | --- |
| Layout arithmetic | Scalars of every supported type; arrays of pointers/structs; nested structs; 2D arrays; internal/tail padding; whole-object and nested one-past paths. Assert explicit expected byte offsets, not values generated by the helper under test. |
| Allocation | Independent stack/heap cursors; per-frame uniqueness; alignment; largest legal object; full-region last slot/exhaustion; no reuse after free/delete; failed operations leave counters unchanged. |
| Address states | NULL versus uninitialized; pointer-to-pointer own/stored addresses; alias equality; overlapping aggregate/subobject bases; dangling former addresses; malformed/missing target fallback. |
| History | Forward/backward stepping; hiding/restoring expired frames; cloned snapshot divergence; fresh run/Clear; old-state normalization; invalid metadata rejection; no counter dependence on UI mount order. |
| Editing | Growing/shrinking arrays with incoming pointers; incompatible type changes; nested paths and one-past paths; changes to offsets; historical sources; atomic rejection; delete with incoming pointers in expired allocations. |
| Equivalence/codegen | Semantically equivalent states built in different allocation orders still pass; generated source contains no synthetic addresses; replayed generated code is graph-equivalent even when its base numbers differ. |
| Flow/layout | Accurate root/row anchors for mixed-height rows; frame containment; mode-invariant node dimensions; no semantic change highlights from a view toggle; stored-address changes highlighted after a valid structural edit. |

Run `npm test` and `npm run build` after implementation. Run the existing native differential suite on a compatible LP64 compiler/CI runner to guard layout and arithmetic regressions; compare sizes/offsets or expression results, never exact process addresses.

### Browser and accessibility checks

Test the normal desktop workbench and a narrow memory pane, plus 200% browser zoom. Use scalar, 64-element array, mixed struct, self-reference, repeated-call, dense alias, long-name/path, one-past, and freed/expired scenarios. Verify the selected mode in Sandbox, both challenge directions, instructor previews, and edited snapshots.

Confirm numbers remain readable, toolbar controls wrap without covering content, selection works in read-only views, keyboard focus is visible, target picking works without drag, and touch interaction does not depend on hover. Screen-reader output must distinguish `&p`, `p`, and `*p`. Inspect console errors and the first-fit/measurement cycle after node-size changes. Use existing maximum-size fixtures to compare interaction/step latency with the baseline; investigate regressions rather than inventing an unsupported performance guarantee.

### Formative learning check before finalizing the default

Ask a small sample of novice learners, using the proposed Both view, to identify: (1) where p lives, (2) what p stores, (3) what `*p` yields, (4) why two pointers show the same stored number, and (5) how far an `int *` advances. Then ask them to find a target in Addresses mode and explain one-past/dangling labels. These checks have not yet been conducted. If learners confuse the two address roles, revise labels/placement first; do not hide one role as the initial remedy. Both is the proposed default pending this validation.

Release acceptance requires that address visibility never changes the program, target type, lifetime status, challenge verdict, or generated source. It also requires that the illustrated pointer's stored address always matches its semantic target location, with boundary/history explicitly labeled where applicable.

## 9. Deliberate limits and later work

No raw memory grid, byte editing, endianness controls, ASLR/random seeds, selectable ABIs, function/global addresses, pointer casts, arbitrary address entry, native `%p` output, allocation reuse, or numeric-address challenge grading in v1. These features expand the language or execution model and need their own semantics and teaching design.

The largest remaining product risks are numeric clutter and learners mistaking a historical/boundary number for a usable pointer. The proposed modes, stable layout, explicit role labels, and status matrix address these risks; browser and learner validation still need to prove the presentation works. Sparse placement is an explicit stability tradeoff and should be reconsidered only alongside a separately designed memory-layout or address-reuse lesson.
