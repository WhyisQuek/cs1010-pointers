# Challenge review and proposed overhaul

Status: **implemented**, including the section grouping in section 4. The review covers the former 12 seed levels in `src/data/levels.js`; the course pack (`public/levels/course.json`) was empty. `src/data/levels.js` is the source of truth for the levels' final code and hints.

Every proposed level below was run through the real interpreter. Each one grades as equal to itself. Every code → diagram level passes `drawingIssues()` and ends with no one-past pointer. For levels 8, 9, 10, 11 and 15, a wrong answer built on the listed misconception was checked against `equivalent()` and rejected.

## 1. Findings

### 1.1 The difficulty ceiling is low

The hardest current level has seven statements and one pointer reassignment. No level asks the student to trace:

- a pointer moving inside a loop;
- more than one level of aliasing;
- a function changing its caller's memory through `**`;
- any heap structure with more than one block.

A student who can do level 3 can do every level after it.

### 1.2 Levels repeat each other

| Levels | Overlap |
|---|---|
| 1 and 2 | The same program (`int` plus a pointer to it), run in both directions. |
| 4 | Level 1 with one more star. `pp` is declared but never used. |
| 5, 6, 8 | "Call `malloc`, store values" three times. Only level 6 adds anything (a free). |
| 7 and 12 | Both are "an array with a trivial operation". |

### 1.3 Some levels test little or nothing about pointers

- **Level 12, "Fill an array"** contains no pointers at all.
- **Level 11, "Choose a target"** tests whether `2 > 1`.
- **Level 9, "A function call"**: once the function returns, the answer is a single `int` holding 25. The student never has to draw or reason about a frame or a parameter. The e2e test shows this: it solves the level by adding one variable.
- **Level 7** uses `p++` once.

### 1.4 Diagram → code levels can be solved by copying

The target diagram shows every name, type and value, and grading looks only at the final state. A student can type the boxes back out as declarations. Levels 2, 4 and 8 can all be solved this way without understanding anything.

A diagram → code level is only worth setting when its target state needs a particular mechanism to produce:

- a nameless heap node (needs `malloc` and `->`);
- a freed block (needs `free`);
- a dangling pointer into a returned frame (needs a function returning `&local`);
- a one-past pointer.

### 1.5 Coverage gaps

These topics are missing entirely:

- `->` on the heap and linked lists;
- pass-by-value versus pass-by-pointer;
- `int **` out-parameters;
- memory leaks (orphaned blocks);
- returning a pointer to a local variable;
- struct copies that share a heap block (shallow copy);
- pointer comparison and subtraction;
- one-past pointers;
- pointers to struct members;
- `*p = *q` versus `p = q`.

### 1.6 Smaller problems

- **Level 6's title "Use after free" is wrong.** Nothing is used after the free; doing so would be a runtime error. The level is about dangling aliases.
- **Ordering:** the control-flow levels (11 and 12) come after structs.
- **Balance of kinds:** there are 8 code → diagram levels and 4 diagram → code levels. The last 5 levels are all code → diagram.

## 2. Constraints that limit level design

Level authors need to know these.

1. **A code → diagram answer must not end with a one-past pointer.** The editor's target picker (`pointerCanTarget`, `src/machine/memory.js`) refuses one-past targets. `drawingIssues()` now reports this, so such a level shows an explanation instead of being silently unsolvable. One-past pointers belong in diagram → code levels.
2. **Freed heap blocks are drawable only in one order.** `pointerCanTarget` requires a live target, and a freed block's contents are read-only. The student has to fill in the block and draw the arrows into it first, then use **Mark as freed**. Hints say so.
3. **Some things can only appear in diagram → code levels:** 2-D arrays, dangling pointers to out-of-scope locals, and frames other than `main` that are still live. `drawingIssues()` already blocks these in code → diagram levels.
4. **Grading checks only the final state.** A level cannot require a loop or a particular construct. Difficulty has to come from what the state is, not from how it was produced.
5. **The Sandbox can bypass code → diagram levels.** A student can paste the code into the Sandbox and run it. That is acceptable for formative practice, but difficulty cannot depend on the student being unable to run the code.

## 3. Proposed set (18 levels, 13 code → diagram and 5 diagram → code)

Status key: **keep** (unchanged, same ID), **rework** (new answer, new ID), **new**.

| # | Tier | Title | Kind | Status | Concept tested | Misconception it catches |
|---|---|---|---|---|---|---|
| 1 | Basics | Read the arrow | C→D | rework (`seed-read-arrow`) | `&`, writing through `*` | `*b = 20` changes `b` |
| 2 | Basics | Write the arrow | D→C | keep `seed-2` | Declaring a pointer | — (on-ramp) |
| 3 | Basics | Pointers move | C→D | keep `seed-3` | Reassigning a pointer | The write lands in the old target |
| 4 | Basics | Copy the arrow or the value? | C→D | new `seed-copy` | `*p = *q` versus `q = p` | Treating the two as the same |
| 5 | Basics | Two hops | C→D | rework (`seed-two-hops`) | Using `*pp` and `**pp` | One star too few or too many |
| 6 | Arrays | Meet in the middle | C→D | rework (`seed-reverse-array`) | Two pointers, `<`, `++`/`--`, swapping | Off-by-one at the end of the loop |
| 7 | Arrays | Bounds of an array | D→C | new `seed-one-past` | Interior and one-past pointers, `ptrdiff` | — |
| 8 | Functions | Swap, or not | C→D | rework (`seed-swap`) | Pass by value versus pass by pointer | `swap_values` changes `a` and `b` |
| 9 | Functions | Hand back an allocation | C→D | new `seed-out-param` | `int **` out-parameter | Expecting `alloc_wrong` to set `a`; forgetting the leak |
| 10 | Functions | Returned too soon | D→C | new `seed-return-local` | Returning `&local` | — (needs a function: a block scope is rejected) |
| 11 | Heap | Lost and leaked | C→D | rework (`seed-leak`) | Orphaned blocks | Leaving out the leaked block |
| 12 | Heap | Heap arithmetic | C→D | rework (`seed-heap-arith`) | `*(p+i)`, `p[i]`, interior pointer | — |
| 13 | Heap | Dangling aliases | D→C | rework (`seed-dangling`) | `free`, an interior alias, reassigning after the free | — |
| 14 | Structs | Linked structure | C→D | keep `seed-10` | Drawing structs | — (on-ramp) |
| 15 | Structs | Shallow copy | C→D | new `seed-shallow` | A struct copy shares heap memory | Drawing two heap arrays |
| 16 | Lists | Build a list | D→C | new `seed-build-list` | `malloc` and `->`, prepending | — |
| 17 | Lists | Reverse the links | C→D | new `seed-reverse-list` | Tracing the classic reversal loop | Wrong final `prev`/`cur`, half-reversed links |
| 18 | Lists | Unlink and free | C→D | new `seed-unlink` | Deleting a node; dangling `doomed` | Unlinking without freeing, or freeing the wrong node |

**Removed:**

- **Level 11, "Choose a target"**, and **level 12, "Fill an array"**: their control flow now appears inside levels 6, 12, 16 and 17.
- **Level 4, the diagram → code "Two hops"**: it is now a code → diagram level.
- **Level 8, the diagram → code "Heap array"**: replaced by levels 12 and 13.

**IDs:** a reworked level gets a new ID. Keeping the old ID with a new answer would leave stale ✓ Completed marks in students' browsers, because progress is stored by ID. Old `seed-N` progress entries become orphaned, which does no harm.

### 3.1 Level code and hints

Unchanged levels (2, 3, 14) are not repeated here.

**1 · Read the arrow**: hints: "Two boxes: one plain int, one pointer." / "`*b = 20` writes into the box b points at — b's arrow doesn't change."
```c
int main(void) {
    int a = 10;
    int *b = &a;
    *b = 20;
}
```

**4 · Copy the arrow or the value?**: answer `a=3, b=2, p→a, q→a`. Hints: "`*p = *q` copies a number; `q = p` copies an arrow." / "After `q = p`, writing through q changes a."
```c
int main(void) {
    int a = 1;
    int b = 2;
    int *p = &a;
    int *q = &b;
    *p = *q;
    q = p;
    *q = 3;
}
```

**5 · Two hops**: answer `a=5, b=60, p→b, pp→p`. Hints: "`*pp` *is* p — assigning to it moves p's arrow." / "`**pp` follows both arrows."
```c
int main(void) {
    int a = 5;
    int b = 6;
    int *p = &a;
    int **pp = &p;
    *pp = &b;
    **pp = 60;
}
```

**6 · Meet in the middle**: answer `arr={5,4,3,2,1}`, with lo and hi both pointing at `arr[2]`. Hints: "Each pass swaps the two ends, then moves lo right and hi left." / "The loop stops when lo is no longer below hi — they meet at the middle."
```c
int main(void) {
    int arr[5] = {1, 2, 3, 4, 5};
    int *lo = arr;
    int *hi = arr + 4;
    while (lo < hi) {
        int t = *lo;
        *lo = *hi;
        *hi = t;
        lo++;
        hi--;
    }
}
```

**7 · Bounds of an array**: diagram → code. Hints: "end points just past the last element — `arr + 5` is legal, `*end` is not." / "Subtracting two pointers counts elements, not bytes."
```c
int main(void) {
    int arr[5] = {5, 4, 3, 2, 1};
    int *mid = &arr[2];
    int *end = arr + 5;
    long left = end - mid;
}
```

**8 · Swap, or not**: prompt "Draw main()'s memory after both calls return." Answer `a=1, b=3, c=2`. Hints: "swap_values gets copies of a and b — its swap never reaches main." / "swap gets addresses, so it really exchanges b and c."
```c
void swap_values(int x, int y) {
    int t = x;
    x = y;
    y = t;
}

void swap(int *x, int *y) {
    int t = *x;
    *x = *y;
    *y = t;
}

int main(void) {
    int a = 1;
    int b = 2;
    int c = 3;
    swap_values(a, b);
    swap(&b, &c);
    return 0;
}
```

**9 · Hand back an allocation**: answer: `a` is NULL, `b` points at a heap block holding 2, and an orphaned heap block holds 1. Hints: "alloc_wrong's p is a copy of a — pointing it elsewhere leaves a NULL." / "Its block still exists: nobody freed it, nobody can reach it."
```c
void alloc_wrong(int *p) {
    p = malloc(sizeof(int));
    *p = 1;
}

void alloc_right(int **pp) {
    *pp = malloc(sizeof(int));
    **pp = 2;
}

int main(void) {
    int *a = NULL;
    int *b = NULL;
    alloc_wrong(a);
    alloc_right(&b);
    return 0;
}
```

**10 · Returned too soon**: diagram → code. Prompt "Write C code that leaves p dangling like this." Hints: "n lives in make_local()'s frame, which is gone." / "A function can return the address of its own local — and shouldn't."
```c
int *make_local(void) {
    int n = 5;
    return &n;
}

int main(void) {
    int *p = make_local();
    return 0;
}
```

**11 · Lost and leaked**: answer: one orphaned block holds 42, and p and q both point at a second block holding 43. Hints: "The second malloc makes a new box; the first one doesn't go away." / "Draw every heap block, even one nothing points to."
```c
int main(void) {
    int *p = malloc(sizeof(int));
    *p = 42;
    int *q = p;
    p = malloc(sizeof(int));
    *p = *q + 1;
    q = p;
}
```

**12 · Heap arithmetic**: answer: the heap block holds `[0,5,4,9]`, p points at `[0]`, last points at `[3]`. Hints: "`*(p + i)` and `p[i]` are the same element." / "The loop writes 0, 1, 4, 9 before p[1] is overwritten."
```c
int main(void) {
    int *p = malloc(4 * sizeof(int));
    for (int i = 0; i < 4; i++) {
        *(p + i) = i * i;
    }
    int *last = p + 3;
    p[1] = *last - p[2];
}
```

**13 · Dangling aliases**: diagram → code. Hints: "Freeing through a dangles every pointer into that block — including mid." / "After the free, a can be pointed somewhere new."
```c
int main(void) {
    int *a = malloc(2 * sizeof(int));
    int *b = malloc(sizeof(int));
    a[0] = 1;
    a[1] = 2;
    *b = 3;
    int *mid = a + 1;
    free(a);
    a = b;
}
```

**15 · Shallow copy**: answer: `a={2,→heap[0]}`, `b={1,→heap[0]}`, and one heap block holding `[70,8]`. Hints: "`b = a` copies the pointer inside a, not the array it points to." / "So `b.data[0] = 70` changes the one shared array."
```c
struct Box {
    int size;
    int *data;
};

int main(void) {
    struct Box a;
    a.size = 2;
    a.data = malloc(2 * sizeof(int));
    a.data[0] = 7;
    a.data[1] = 8;
    struct Box b = a;
    b.size = 1;
    b.data[0] = 70;
    return 0;
}
```

**16 · Build a list**: diagram → code. Hints: "Every node is a malloc'd struct with no name." / "Building from the back is easiest: each new node points at the old head."
```c
typedef struct Node {
    int value;
    struct Node *next;
} Node;

int main(void) {
    Node *head = NULL;
    for (int i = 3; i >= 1; i--) {
        Node *n = malloc(sizeof(Node));
        n->value = i;
        n->next = head;
        head = n;
    }
    return 0;
}
```

**17 · Reverse the links**: answer: `a.next=NULL`, `b.next→a`, `c.next→b`, `prev→c`, `cur=NULL`. Hints: "Each pass flips one link to point backwards." / "next is a loop-local and is gone at the end; prev ends on the old tail."
```c
struct Node {
    int value;
    struct Node *next;
};

int main(void) {
    struct Node c = {3, NULL};
    struct Node b = {2, &c};
    struct Node a = {1, &b};
    struct Node *prev = NULL;
    struct Node *cur = &a;
    while (cur != NULL) {
        struct Node *next = cur->next;
        cur->next = prev;
        prev = cur;
        cur = next;
    }
    return 0;
}
```

**18 · Unlink and free**: answer: three heap nodes. Node 1 → node 3. Node 2 is freed and still → node 3. head → node 1, and doomed dangles at node 2. Hints: "Unlinking just redirects head->next; the freed node keeps its old contents." / "Freed blocks are read-only: fill in that node and draw doomed's arrow before marking it freed."
```c
typedef struct Node {
    int value;
    struct Node *next;
} Node;

int main(void) {
    Node *head = malloc(sizeof(Node));
    head->value = 1;
    head->next = malloc(sizeof(Node));
    head->next->value = 2;
    head->next->next = malloc(sizeof(Node));
    head->next->next->value = 3;
    head->next->next->next = NULL;
    Node *doomed = head->next;
    head->next = doomed->next;
    free(doomed);
    return 0;
}
```

## 4. Related changes

1. **`drawingIssues()`:** flag graded one-past pointer values (section 2, item 1). Add a unit test.
2. **e2e `challenges.spec.js`:** rewrite "the function-call level…" for *Swap, or not* (draw `a=1, b=3, c=2`). The other e2e tests still hold: *Read the arrow* keeps 2 hints, and *Write the arrow* is still followed by *Pointers move*. *Linked structure* is unchanged.
3. **`test/roundtrip.test.js`:** the "every code-to-diagram seed level can be drawn" test now covers the new levels. Optionally, add a test that every seed level grades equal to itself.
4. **CHANGELOG:** add an entry.
5. **Sections (done):** levels have a `section` field, set in the Level editor, and the Challenges list groups cards under the tiers above.
