# Review of external findings — October 2026

This report checks the ten findings in `pointerviz-notes.pdf` against the code at
`main`: whether each one reproduces, whether its suggested cause is right, what it
missed, and what to change.

**Status: all ten findings are fixed.** For #2, only the "now" part is done:
an honest diagnostic and corrected docs; store-time typing stays with the
planned allocation redesign. The table below says how each was resolved and
where it is tested. Unit tests are in
[`test/notes-review.test.js`](../test/notes-review.test.js), and browser tests
for #7 and #8 are in [`e2e/sandbox.spec.js`](../e2e/sandbox.spec.js).

| # | Resolution |
| --- | --- |
| 1 | `addToPointer` takes the pointee type; `requireElementStride` (`pointerArithmetic.js`) reports `UNSUPPORTED` when the element and pointee sizes differ. Subtraction and ordering check it too, unless both pointers are at the same position. |
| 2 | Conversion-typed blocks are marked `typedByConversion` until their first store. A different-type access before that store is `UNSUPPORTED` with an accurate message. `SUPPORTED_C.md` no longer attributes this to 6.5p6. |
| 3 | `outermostRefAtAddress` and `refAtSameAddress` (`memory.js`) keep one-past references. |
| 4 | `ctx.danglingReadExempt` holds the argument node of `free`, so only that node's own load is exempt. |
| 5 | `malloc` and `free` clear the `update` flags of their argument accesses. |
| 6 | `numberToC` emits `-0.0` / `-0.0f`. Grading still treats both zeros as equal, deliberately. |
| 7 | Escape arms a one-shot; the next Tab or Shift+Tab moves focus. This is disclosed through `aria-describedby`. |
| 8 | The first code edit during playback copies the displayed state and posts a notice. Later edits clear only error notices. |
| 9 | Branch and bound with lower bounds, best-first ordering, symmetry breaking and a node cap (see below). |
| 10 | Copy-on-write snapshots plus a total copy budget (see below). |

## Method

- Findings 1–6, 9 and 10 were run through the real pipeline (`interpret`,
  `generate`, `equivalent` from `src/pipeline/`), set up the same way the test
  suites do. Timings are from one Windows machine running Node 22 and are only
  useful for comparing against each other.
- Findings 7 and 8 are UI behaviour. They were checked by reading
  `CodePanel.jsx` and `Sandbox.jsx`, not in a browser. In both cases the code
  makes the behaviour certain.
- Extra cases (marked *new*) were added wherever a finding seemed to understate
  or misplace the problem.

## Summary

| # | Finding | Reproduces | Cause correct | Severity | Proposed fix | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | Snapshot memory is unbounded | Yes, and much worse than stated | Yes | **High** | History budget now; copy-on-write snapshots | S + M |
| 9 | Grading search is factorial | Yes | Partly: early exit alone is not enough | **High** | Early exit, strict pruning, symmetry breaking | S + M |
| 1 | `char *` arithmetic uses the target's shape | Yes, silently wrong | Yes | Medium–High | Diagnose mismatched-stride arithmetic | S |
| 3 | `void *` round trip changes row | Yes, silently wrong | Yes | Medium | Keep one-past references through `void *` | S |
| 4 | `free` exempts nested reads from dangling checks | Yes, wider than stated | Yes | Medium | Exempt only the top-level load | S |
| 2 | Conversion alone sets the effective type | Yes | Yes (doc misquotes C23) | Medium | Honest diagnostic and docs now; store-time typing later | S / L |
| 8 | Editing code jumps the diagram to the final state | Yes (code) | Yes | Medium (UX) | Keep the displayed step and explain | S |
| 7 | No keyboard route out of the editor | Yes (code); already known | Yes | Medium (a11y) | Esc-then-Tab escape, disclosed | S |
| 5 | `malloc` argument `++` breaks assignment | Yes | Yes | Low–Medium | Clear `update` flags, as `calloc` does | XS |
| 6 | Generated C loses `-0.0` | Yes | Yes | Low | Emit `-0.0` | XS |

Severity is based on what a student sees. **High**: a short, valid program can
freeze or crash the tab. **Medium**: a wrong answer with no warning, missed
undefined behaviour, valid C rejected, or a UX/accessibility defect.

---

## 1. `char *` arithmetic follows the target array's shape

**Verdict: confirmed. The cause is right.**

```c
int a[2] = {0}; void *v = a; char *p = v; char *q = p + 1;
```

| Pointer | Address | Reference path |
| --- | --- | --- |
| `v`, `p` | `0x10000000` | `[]` (all of `a`) |
| `q` | `0x10000008` | `["$onePast"]` |

There are two causes:

1. `convertedTarget` (`src/machine/execution/lvalues.js:196`) finds no `char`
   at that address, so `p` keeps pointing at the whole `int [2]`.
2. `addToPointer` (`src/machine/execution/pointerArithmetic.js:19`) never sees
   the pointer's type. `arrayPosition` treats the whole array as a one-element
   object, so `+1` moves `sizeof(int[2])` = 8 bytes.

*New:* a scalar does the same thing. With `int x; void *v = &x; char *p = v;`,
`p + 1` lands at `+4` (one past the `int`), not `+1`.

This is the most serious kind of error: the diagram shows a wrong address and
gives no warning. Byte-level views are already "not modeled": reading `*p` is
diagnosed as unsupported. Arithmetic should get the same treatment.

**Proposed change.** Pass the pointer's pointee type to `addToPointer` (all six
callers have it). When the size of the designated element differs from the size
of the pointee, raise `UNSUPPORTED`:

```js
// pointerArithmetic.js
export function addToPointer(state, value, delta, node, pointeeType) {
  …
  const pos = arrayPosition(state, value.target);
  const element = elementTypeAt(state, pos); // new helper: the type the position steps over
  if (delta !== 0 && pointeeType &&
      sizeOf(element, state.structTypes) !== sizeOf(pointeeType, state.structTypes))
    throw semanticError(node,
      `byte-level arithmetic on a ${typeToString(pointer(pointeeType))} into a ` +
      `${typeToString(element)} is not modeled`, UNSUPPORTED);
```

Comparing sizes rather than types still allows signed/unsigned twins, where the
addresses would be correct. Pointer subtraction and relational comparison
(`operators.js`) need the same check, or `q - p` gives an element count that
disagrees with the addresses shown.

**Tests:** both repros above expect `/not modeled/`. `int a[2]; int *p = a; p + 1`
must still work.

## 2. Converting a pointer permanently types a `malloc` block

**Verdict: confirmed. The cause is right. The documentation is also wrong.**

| Program | Result |
| --- | --- |
| `void *v = malloc(sizeof(double)); int *p = v; double *q = v; *q = 3.0;` | "accessing int [2] heap 1 through a double lvalue" |
| *new:* the same without the store | Accepted, but the block is already `int [2]` |
| *new:* `double *q = v; *q = 3.0; int *p = v;` | Accepted (order dependent) |
| *new:* `void *v = malloc(16); char *c = v; double *d = v; *d = 1.0;` | "accessing char [16] … through a double lvalue" |

`docs/SUPPORTED_C.md:147` describes typing at the first conversion as "C23's
effective-type rule, 6.5p6". That is not what 6.5p6 says: for memory with no
declared type, the effective type comes from a *store* (or a copy), not from a
conversion. So PointerViz rejects valid C and labels it **undefined behaviour**
(`requireAccessType` → `UNDEFINED`). Teaching students that valid C is undefined
is worse than saying "not supported". The common pattern
(`int *p = malloc(n * sizeof *p)`) is unaffected, so few students will hit this.

**Proposed change.**

- *Now (S):* mark blocks typed by conversion (`allocation.typedBy =
  'conversion'` in `typeHeapBlock`). When `requireAccessType` fails on such a
  block that has never been stored to, report `UNSUPPORTED` with an accurate
  message ("PointerViz gives a malloc block the type of the first pointer it is
  converted to (`int *`); using it as `double` is not modeled"). Rewrite
  `SUPPORTED_C.md:147` to say this is a PointerViz simplification, not the
  6.5p6 rule.
- *Later (L):* type the block at its first store. Pointers to an untyped block
  would carry a view type and a byte offset. This belongs with the allocation
  redesign already planned in `C_SPEC_AUDIT_N3088.md` (A1, "Phase 2", lines 81
  and 221), not as a standalone patch.

## 3. A `void *` round trip changes which row a pointer is in

**Verdict: confirmed. The cause is right.**

```c
int a[2][2] = {{1, 2}, {3, 4}};
int *p = a[0] + 2; void *v = p; int *q = v; int result = *q;
```

`p` is `[0,2]` (one past row 0) and `q` is `[1,0]`; both are at `0x10000008`.
`result` is `3`, but `*p` directly gives "dereference outside object bounds".

*New:* it breaks the other way too. `q - 1` fails ("index -1"), while `p - 1`
would be `&a[0][1]`.

The cause is `outermostRefAtAddress` (`memory.js:356`). It returns the *first*
addressable subobject at the same offset, which is row `a[1]`, so the one-past
status is lost. `refAtSameAddress` (`memory.js:370`) then picks `a[1][0]`. Other
interior pointers are not affected, because no other subobject shares their
offset in a way that changes their array.

**Proposed change.** In both functions, return `target` unchanged when
`referenceOffset(state, target).onePast` is true. For `refAtSameAddress`, also
require the destination type to match the element type it is one past. A
`void *` that holds a one-past pointer then shows that boundary rather than the
next row, which is the more honest picture anyway.

**Tests:** the repro expects `/bounds/`; `q - 1` expects `&a[0][1]`.

## 4. `free` turns off dangling-pointer checks for its whole argument

**Verdict: confirmed, and wider than stated.**

| Program | Result |
| --- | --- |
| `free(p); free(ignore(p));` | Accepted |
| `free(p); ignore(p);` | "use of dangling pointer" (correct) |
| *new:* `int *f(int *p) { int *q = p; return NULL; }` … `free(p); free(f(p));` | Accepted |

`evalCall` sets `ctx.allowDanglingRead = true` (`calls.js:166`) on the shared
context while the argument is evaluated. So every read during that time is
exempt, including reads inside the body of a called function. The `finally`
also resets the flag to `false` instead of restoring the previous value.

The exemption exists for a good reason: `free(p); free(p);` should report
"double free", which is a clearer message than "use of dangling pointer". It
only needs to cover the final load of the argument.

**Proposed change.**

```js
// calls.js, free
const arg = expr.arguments[0];
let rv;
if (isLValueExpression(arg)) {
  const lv = evalLValue(arg, ctx, env, frame); // sub-expressions checked normally
  const saved = ctx.allowDanglingRead;
  ctx.allowDanglingRead = true;
  try { rv = loadLValue(lv, ctx, arg); } finally { ctx.allowDanglingRead = saved; }
} else rv = evalExpression(arg, ctx, env, frame, null);
```

**Tests:** both "accepted" repros expect `/dangling/`. `free(p); free(p);` still
expects `/double free/`.

## 5. `i = malloc(i++) != NULL` is reported as unsequenced

**Verdict: confirmed. The cause is right.**

| Program | Result |
| --- | --- |
| `i = malloc(i++) != NULL;` | "unsequenced modifications of the assignment target" |
| `i = calloc(i++, 1) != NULL;` | Accepted |
| `i = f(i++);` (user function) | Accepted |

The argument's side effect is sequenced before the call (C23 6.5.2.2), so this
is valid C. User calls (`calls.js:210`), `calloc` (`calls.js:152`) and `printf`
(`output.js:32`) clear `access.update` after their arguments are evaluated.
`malloc` (`calls.js:137`) does not, so the assignment check at
`expressions.js:138` still sees the `i++`. `free` has the same gap, but it
returns `void`, so no assignment can expose it today.

**Proposed change.** Clear the flags in `malloc` (and in `free` for
consistency):

```js
const start = ctx.accesses.length;
const bytes = sizeArgument(expr.arguments[0], ctx, env, frame);
for (const access of ctx.accesses.slice(start)) access.update = false;
return allocateBlock(expr, bytes, ctx);
```

## 6. Generated C loses the sign of `-0.0`

**Verdict: confirmed. The cause is right.**

`double x = -0.0;` generates `x = 0.0;`, and `equivalent` reports the two states
as equal. The interpreter does keep the sign: `printf("%f", x)` prints
`-0.000000` (`format.js:200`), so the generated program really does behave
differently. Infinity and NaN cannot occur (floating division by zero is
rejected), so `-0` is the only value `String()` gets wrong.

**Proposed change.** In `numberToC` (`codegen.js:414`):
`let text = Object.is(value, -0) ? '-0' : String(value);`, which gives `-0.0`.
Leave grading lenient: marking a student wrong for `0.0` vs `-0.0` would be a
distraction. Add a round-trip test that compares with `Object.is`.

## 7. No keyboard route out of the code editor

**Verdict: confirmed by reading the code. Already listed as open in
`docs/UI_UX_REVIEW.md:218`.**

In editable mode, `CodePanel` calls `preventDefault()` on every Tab
(`CodePanel.jsx:71–72`) and has no handling for Escape. Read-only editors
return early at line 50, so Tab already leaves those. Keyboard-only users are
trapped in the Sandbox, Challenge and Level-editor editors, which fails WCAG
2.1.2 (No Keyboard Trap).

**Proposed change.** Follow the CodeMirror convention:

- Escape sets a one-shot ref. If the next key is Tab, let the browser move
  focus. Any other key clears the ref.
- Disclose this with `aria-describedby` on the textarea ("Tab indents. Press
  Esc, then Tab, to leave the editor.") and in the shortcuts help.
- Add a Playwright test: focus the editor, press Escape then Tab, and assert
  that focus is on the next control.

## 8. Editing code during playback jumps the diagram to the final state

**Verdict: confirmed by reading the code. The cause is right.**

`onCode` (`Sandbox.jsx:136`) sets `snapshots` to null. `shownState` then falls
back to `state`, and `loadPlayback` had set that to the run's *final* state. The
user was looking at step N and now sees the end of the program, now editable,
with no message.

*New:* because `snapshots` is null, the draft effect at `Sandbox.jsx:45` also
saves that final state as the user's diagram.

**Proposed change.** Do what `editSnapshot` already does. On the first edit
while playback is active, keep the memory on screen and say why playback ended:

```js
const onCode = value => {
  setBreakpoints(b => shiftBreakpoints(code, value, b));
  setCode(value);
  if (snapshots) {
    setState(structuredClone(shownState));
    setNotice({ kind: 'ok', text: `Code changed: the diagram still shows step ${step}. Run to replay.` });
  } else setNotice(null);
  setSnapshots(null);
  setSavedPlayback(null);
};
```

The alternative is to keep playback but mark it stale. That needs more state for
little extra benefit.

## 9. Heap matching in `equivalent()` is factorial

**Verdict: confirmed. The suggested cause only covers correct answers.**

The program allocates N identical leaked blocks; each case was timed after a
warm-up run:

| N | Correct answer | Wrong answer (every block differs) |
| --- | --- | --- |
| 6 | 8.6 ms | — |
| 7 | 29 ms | — |
| 8 | 276 ms | 268 ms |
| 9 | 3.2 s | — |

The PDF's 453 ms for N = 7 is from a slower machine, but the growth is the same:
about ×10 per extra block. At N = 10 a submission would freeze the tab for about
half a minute, and loops make that easy to reach (`MAX_LOOP_ITERATIONS` is 256).

Two problems compound (`equivalence.js:200–222`):

1. There is no early exit once a mapping scores 0. This is the PDF's point.
2. Pruning uses `<=`, so mappings that score the same as the best are explored
   fully. For a **wrong** answer every permutation scores the same, so an early
   exit alone changes nothing: see the 268 ms above.

**Proposed change.**

- `if (best?.score === 0) return;` at the top of `search`, and prune with `<`.
  This is safe because the partial score is a lower bound and the best result
  is only replaced on a strict improvement.
- Symmetry breaking: two actual blocks are interchangeable when they have the
  same type, the same lifetime and deeply equal values, and no pointer targets
  either of them. In `candidates`, try only the first unused block of each such
  class. This makes the example linear.
- A safety net: a node budget (say 200 000). When it runs out, return the best
  mapping so far with the generic mismatch message.

**Test:** 12 identical leaked blocks, compared correct and wrong, each in under
100 ms.

**Resolution.** Fixed in `bestHeapMapping` (`src/pipeline/equivalence.js`),
which is now a full branch and bound:

- It stops at a score of 0 and prunes with `<`.
- Before the search it computes a lower bound for every pairing: the cost that
  does not depend on pointer targets. A branch is cut when the score so far plus
  the cheapest remaining cost for every unpaired block cannot beat the best
  mapping.
- Candidates are tried cheapest first.
- Only one block from each set of interchangeable blocks is tried. A block
  counts as interchangeable when no *graded* object points to it. An
  implementation detail matters here: the expired loop `p` in the repro does
  point at its block, but it is not graded, so it must not stop the block from
  counting as interchangeable.
- The search gives up after 100 000 nodes with "PointerViz could not finish
  comparing your memory: it has too many similar heap blocks". It never guesses
  a mismatch.

Comparison time after the fix (interpretation included):

| Case | Before | After |
| --- | --- | --- |
| 8 identical blocks, correct / wrong | 276 / 268 ms | 22 / 7 ms |
| 20 identical blocks, correct / wrong | hours (projected) | 15 / 15 ms |
| 20 distinct values, all wrong | hours (projected) | 22 ms |
| 12 pointers filled in reverse order | — | 11 ms |
| 12-node ring vs two rings | — | 16 ms, specific diffs |

The cap is still reachable by adversarial structure: 12 identical leaked nodes
in two rings against four rings gives up after about 0.6 s. Before the fix, the
same case would also have run for hours.

## 10. Execution history memory has no bound

**Verdict: confirmed. The impact is much larger than the PDF says.**

The 16×16 repro matches the PDF: 24 snapshots and about 17 000 value nodes
(370 KB of JSON). With the largest array allowed (`int a[64][64]`, 4 096
scalars, the `MAX_OBJECT_SCALARS` limit):

| Loop iterations | Snapshots | Heap retained | Time |
| --- | --- | --- | --- |
| 10 | 44 | 87 MB | 0.4 s |
| 20 | 84 | 323 MB | 1.5 s |
| 40 | 164 | 1.24 GB | 6.0 s |

Growth is quadratic. Every snapshot deep-clones every allocation, and expired
loop locals are kept (`runtime.js:71`). The 500-step limit allows about 124
iterations, which projects to about 12 GB. In practice the tab runs out of
memory long before reaching the step limit, from a valid three-line program.
The per-object, step and loop limits do not bound the product of the three.

**Proposed change.**

- *Now (S):* a history budget. Count the scalars cloned in `snapshot()` and
  throw a `LIMIT` diagnostic past a fixed total, for example 2 million: "the
  execution history is too large to visualize". This bounds the worst case no
  matter how the rest is fixed.
- *Next (M):* copy-on-write snapshots. Record which allocations change
  (`setRefValue`, `addAllocation`, `typeHeapBlock`, and lifetime changes in
  `closeScope`, `endFrame` and `free`). In `snapshot()`, reuse the previous
  snapshot's clone of every allocation that has not changed. Expired arrays are
  then stored once. This depends on the UI treating snapshot states as
  read-only; `editSnapshot` and `diagramToCode` already clone. Audit every
  other consumer before relying on it.
- *Not recommended:* dropping expired locals that nothing references. It would
  also bound memory, but it changes what playback shows and how allocations are
  numbered, and `MEMORY_ADDRESSES_DESIGN.md:39` deliberately keeps expired
  allocations.

**Test:** `for (int i = 0; i < 120; i++) { int a[64][64]; }` either finishes
under a set memory and time budget or raises the history-limit diagnostic.

**Resolution.** `snapshot()` in `runtime.js` is now copy-on-write. An
allocation that is deep-equal to its copy in the previous snapshot, or was dead
in both, reuses that copy. The deep-equality check uses `Object.is`, so `-0` and
`0` stay distinct. Skipping dead objects is safe because every store requires a
live object; without that shortcut the deep comparisons took 10 s for the repro.

The audit of snapshot consumers found that all UI edits go through
`MemoryCanvas`'s `mutate`, which clones first and only runs on editable
diagrams, and that Sandbox clones before editing. So the shared objects are
never mutated.

`MAX_HISTORY_SCALARS` (`MAX_OBJECT_SCALARS × MAX_TRACE_STEPS` = 2 048 000) now
counts only the scalars actually copied. When it is exceeded, `snapshot()`
throws a `LIMIT` diagnostic and keeps playback up to that point.

| Repro (`int a[64][64]` per iteration) | Before | After |
| --- | --- | --- |
| 40 iterations | 1.24 GB, 6.0 s | 37 MB, 0.16 s |
| 120 iterations | about 12 GB (projected) | 111 MB, 0.46 s, runs to completion |

---

## Recommended order

1. **#10 history budget** and **#9 early exit, strict pruning and symmetry
   breaking**: these are the only findings that can hang or crash a student's
   tab.
2. **#1, #3, #4**: wrong answers or missed undefined behaviour with no warning.
   Each is a small, local change with a direct regression test.
3. **#5, #6, #8, #7**: small fixes. #7 also closes an item already in
   `UI_UX_REVIEW.md`.
4. **#2**: change the diagnostic category and fix the docs now. Leave
   store-time typing to the planned allocation redesign.
5. **#10 copy-on-write snapshots**, after auditing which code mutates snapshot
   states.

Put each regression test in `test/c-semantics.test.js` (semantics),
`test/notes-review.test.js` (equivalence and history limits) or
`e2e/sandbox.spec.js` (#7, #8). Record each fix in `CHANGELOG.md` and update
`SUPPORTED_C.md` wherever the documented behaviour changes (#1, #2).
