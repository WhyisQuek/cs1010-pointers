/**
 * Challenge content and browser-only persistence.
 * Seed levels are versioned in source. Course levels are a level pack published with the
 * site (public/levels/course.json), so every student gets them. Custom levels (instructor
 * build only) and progress are JSON in localStorage so UI components stay independent of
 * the storage mechanism.
 */

const LEVELS_KEY = 'pointerviz.levels';
const PROGRESS_KEY = 'pointerviz.progress';
const LEGACY_LEVELS_KEY = 'pointerlab.levels';
const LEGACY_PROGRESS_KEY = 'pointerlab.progress';
export const LEVEL_KINDS = Object.freeze(['code-to-diagram', 'diagram-to-code']);
/** The instruction shown in a challenge's header when a level gives none. */
export const DEFAULT_PROMPTS = Object.freeze({
  'code-to-diagram': 'Draw the memory this code leaves behind.',
  'diagram-to-code': 'Write C code that produces this memory.',
});

/** Storage can be unavailable (private mode, blocked site data) or full. */
function readJson(key, legacyKey, fallback) {
  try {
    const current = localStorage.getItem(key);
    if (current) return JSON.parse(current) ?? fallback;
    const legacy = localStorage.getItem(legacyKey);
    if (!legacy) return fallback;
    const parsed = JSON.parse(legacy) ?? fallback;
    writeJson(key, parsed);
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerce stored or imported data to the level shape the UI relies on.
 * Returns null for anything without usable code and a known challenge kind.
 */
export function normalizeLevel(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.code !== 'string' ||
    !LEVEL_KINDS.includes(raw.kind)
  )
    return null;
  const text = (value, fallback) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const grading = raw.grading && typeof raw.grading === 'object' ? raw.grading : {};
  return {
    id: text(raw.id, `custom-${Date.now()}`),
    kind: raw.kind,
    title: text(raw.title, 'Untitled level'),
    // The Challenges heading the level is listed under; '' leaves it unsectioned.
    section: text(raw.section, ''),
    // What the level teaches, shown on its card; '' shows no subtitle.
    topic: text(raw.topic, ''),
    // The instruction, shown in the challenge header.
    prompt: text(raw.prompt, DEFAULT_PROMPTS[raw.kind]),
    code: raw.code,
    hints: Array.isArray(raw.hints) ? raw.hints.map(h => text(h, '')).filter(Boolean) : [],
    // Only the options the Level editor offers; anything else in stored data is dropped.
    grading: Object.fromEntries(
      ['compareNames', 'compareLifetime']
        .filter(k => typeof grading[k] === 'boolean')
        .map(k => [k, grading[k]]),
    ),
  };
}

/** Append levels, renaming IDs that would collide with existing or seed levels. */
export function mergeLevels(existing, incoming) {
  const used = new Set([...seedLevels, ...existing].map(l => l.id));
  const merged = [...existing];
  for (const level of incoming) {
    let id = level.id;
    for (let n = 2; used.has(id); n++) id = `${level.id}-${n}`;
    used.add(id);
    merged.push({ ...level, id });
  }
  return merged;
}

export function loadCustomLevels() {
  const stored = readJson(LEVELS_KEY, LEGACY_LEVELS_KEY, []);
  // Older versions could store duplicate IDs; merging also repairs those.
  return Array.isArray(stored) ? mergeLevels([], stored.map(normalizeLevel).filter(Boolean)) : [];
}

let courseLevels = [];

/**
 * Fetch the published course pack once at startup. A missing or malformed pack, or
 * entries that fail normalization, leave the seed levels usable; it never throws.
 */
export async function loadCourseLevels(url, fetchFn = globalThis.fetch) {
  try {
    // Revalidate so a redeployed pack reaches students without waiting out the cache.
    const response = await fetchFn(url, { cache: 'no-cache' });
    const data = response.ok ? await response.json() : [];
    courseLevels = Array.isArray(data)
      ? mergeLevels([], data.map(normalizeLevel).filter(Boolean))
      : [];
  } catch {
    courseLevels = [];
  }
  return courseLevels;
}

/**
 * Every level to list: seed, then course, then (instructor build) custom levels. A custom
 * level with a course level's ID is the instructor's draft of it and takes its place, so
 * importing course.json into the editor lets them edit and republish existing levels.
 */
export function availableLevels({ includeCustom }) {
  const custom = includeCustom ? loadCustomLevels() : [];
  const draft = new Map(custom.map(l => [l.id, l]));
  const course = courseLevels.map(l => draft.get(l.id) ?? l);
  const courseIds = new Set(courseLevels.map(l => l.id));
  return [...seedLevels, ...course, ...custom.filter(l => !courseIds.has(l.id))];
}

/**
 * Levels grouped for listing, as [{ section, levels }]. Sections appear in the order they
 * are first used and keep their levels' order, so a course level can join a built-in
 * section. Unsectioned levels come last, in a group whose section is ''. Flattening the
 * groups gives the order the list is numbered and played in.
 */
export function groupLevels(levels) {
  const groups = new Map();
  for (const level of levels) {
    if (!groups.has(level.section)) groups.set(level.section, []);
    groups.get(level.section).push(level);
  }
  // A stable sort, so only the unsectioned group moves.
  return [...groups]
    .sort(([a], [b]) => (a === '') - (b === ''))
    .map(([section, members]) => ({ section, levels: members }));
}

/** Returns false when the browser refused to persist the levels. */
export function saveCustomLevels(levels) {
  return writeJson(LEVELS_KEY, levels);
}

export function loadProgress() {
  const stored = readJson(PROGRESS_KEY, LEGACY_PROGRESS_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/**
 * Progress is completion only. Attempt-based scores were dropped: progress lives in the
 * student's own browser, so any score kept there can be reset or edited at will.
 */
export function isSolved(progress, levelId) {
  return progress[levelId]?.solved === true;
}

export function markSolved(levelId) {
  const p = loadProgress();
  p[levelId] = { solved: true };
  writeJson(PROGRESS_KEY, p);
}

/** Forget completion, e.g. after an instructor changes the level's answer. */
export function clearProgress(levelId) {
  const p = loadProgress();
  if (!(levelId in p)) return;
  delete p[levelId];
  writeJson(PROGRESS_KEY, p);
}

/* ── Seed levels ─────────────────────────────────────────────────────
   Target IRs are stored as plain code; the app interprets them at load
   time so the level format stays human-writable and versionable. They go
   through normalizeLevel like any other level, so a level that leaves out
   its prompt gets the default instruction for its kind.

   Progress is keyed by ID: a level whose answer changes gets a new ID, so
   an old completion mark never claims the new answer. Difficulty comes from
   what the final memory is (grading sees nothing else), so diagram → code
   levels target states that need a particular mechanism to produce. A
   code → diagram answer must be drawable: see drawingIssues(). The design
   rationale is in docs/CHALLENGE_REVIEW.md.                           */
export const seedLevels = [
  {
    id: 'seed-read-arrow',
    section: 'Basics',
    kind: 'code-to-diagram',
    title: 'Read the arrow',
    topic: 'Pointers, & and writing through *',
    code: `int main(void) {
    int a = 10;
    int *b = &a;
    *b = 20;
}`,
    hints: [
      'Two boxes: one plain int, one pointer.',
      "*b = 20 writes into the box b points at — b's own arrow doesn't change.",
    ],
  },
  {
    id: 'seed-2',
    section: 'Basics',
    kind: 'diagram-to-code',
    title: 'Write the arrow',
    topic: 'Pointers and the address-of operator',
    code: `int main() {\n    int x = 7;\n    int *p = &x;\n}`,
    hints: ['Declare the int before the pointer.', 'Use & to take the address of x.'],
  },
  {
    id: 'seed-3',
    section: 'Basics',
    kind: 'code-to-diagram',
    title: 'Pointers move',
    topic: 'Reassigning a pointer and writing through it',
    code: `int main() {\n    int x = 1;\n    int y = 2;\n    int *p = &x;\n    p = &y;\n    *p = 99;\n}`,
    hints: [
      'After p = &y, the old arrow to x is gone.',
      '*p = 99 writes through the arrow — into y, not x.',
    ],
  },
  {
    id: 'seed-copy',
    section: 'Basics',
    kind: 'code-to-diagram',
    title: 'Copy the arrow or the value?',
    topic: 'Copying through pointers versus copying pointers',
    code: `int main(void) {
    int a = 1;
    int b = 2;
    int *p = &a;
    int *q = &b;
    *p = *q;
    q = p;
    *q = 3;
}`,
    hints: [
      '*p = *q copies a number; q = p copies an arrow.',
      'After q = p, writing through q changes a.',
    ],
  },
  {
    id: 'seed-two-hops',
    section: 'Basics',
    kind: 'code-to-diagram',
    title: 'Two hops',
    topic: 'Pointers to pointers',
    code: `int main(void) {
    int a = 5;
    int b = 6;
    int *p = &a;
    int **pp = &p;
    *pp = &b;
    **pp = 60;
}`,
    hints: ["*pp is p itself — assigning to it moves p's arrow.", '**pp follows both arrows.'],
  },
  {
    id: 'seed-reverse-array',
    section: 'Arrays',
    kind: 'code-to-diagram',
    title: 'Meet in the middle',
    topic: 'Two pointers walking an array',
    code: `int main(void) {
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
}`,
    hints: [
      'Each pass swaps the two ends, then moves lo right and hi left.',
      'The loop stops when lo is no longer below hi — where do they meet?',
    ],
  },
  {
    id: 'seed-one-past',
    section: 'Arrays',
    kind: 'diagram-to-code',
    title: 'Bounds of an array',
    topic: 'Interior and one-past-the-end pointers',
    code: `int main(void) {
    int arr[5] = {5, 4, 3, 2, 1};
    int *mid = &arr[2];
    int *end = arr + 5;
    long left = end - mid;
}`,
    hints: [
      'end points just past the last element: arr + 5 is allowed, *end is not.',
      'Subtracting two pointers into one array counts elements, not bytes.',
    ],
  },
  {
    id: 'seed-swap',
    section: 'Functions',
    kind: 'code-to-diagram',
    title: 'Swap, or not',
    topic: 'Passing values versus passing pointers',
    prompt: "Draw main()'s memory after both calls have returned.",
    code: `void swap_values(int x, int y) {
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
}`,
    hints: [
      'swap_values() gets copies of a and b — its swap never reaches main().',
      'swap() gets addresses, so it really exchanges the values it points at.',
    ],
  },
  {
    id: 'seed-out-param',
    section: 'Functions',
    kind: 'code-to-diagram',
    title: 'Hand back an allocation',
    topic: 'Pointer-to-pointer parameters',
    prompt: 'Draw the memory left once both calls have returned, heap included.',
    code: `void alloc_wrong(int *p) {
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
}`,
    hints: [
      "alloc_wrong()'s p is a copy of a: pointing the copy elsewhere leaves a unchanged.",
      'Every heap block still exists once its function returns, even one nothing points to.',
    ],
  },
  {
    id: 'seed-return-local',
    section: 'Functions',
    kind: 'diagram-to-code',
    title: 'Returned too soon',
    topic: 'Returning the address of a local variable',
    prompt:
      'Write C code that leaves p dangling like this. Show out-of-scope reveals where n lived.',
    code: `int *make_local(void) {
    int n = 5;
    return &n;
}

int main(void) {
    int *p = make_local();
    return 0;
}`,
    hints: [
      "n belonged to make_local()'s frame, which has ended.",
      'A function can return the address of its own local — and should not.',
    ],
  },
  {
    id: 'seed-leak',
    section: 'Heap',
    kind: 'code-to-diagram',
    title: 'Lost and leaked',
    topic: 'Heap blocks nothing points to',
    code: `int main(void) {
    int *p = malloc(sizeof(int));
    *p = 42;
    int *q = p;
    p = malloc(sizeof(int));
    *p = *q + 1;
    q = p;
}`,
    hints: [
      "The second malloc makes a new box; the first one doesn't go away.",
      'Draw every heap block, even one nothing points to any more.',
    ],
  },
  {
    id: 'seed-heap-arith',
    section: 'Heap',
    kind: 'code-to-diagram',
    title: 'Heap arithmetic',
    topic: 'Pointer arithmetic in a heap array',
    code: `int main(void) {
    int *p = malloc(4 * sizeof(int));
    for (int i = 0; i < 4; i++) {
        *(p + i) = i * i;
    }
    int *last = p + 3;
    p[1] = *last - p[2];
}`,
    hints: [
      '*(p + i) and p[i] name the same element.',
      'The loop fills in the squares before p[1] is overwritten.',
    ],
  },
  {
    id: 'seed-dangling',
    section: 'Heap',
    kind: 'diagram-to-code',
    title: 'Dangling aliases',
    topic: 'Freeing memory and dangling pointers',
    code: `int main(void) {
    int *a = malloc(2 * sizeof(int));
    int *b = malloc(sizeof(int));
    a[0] = 1;
    a[1] = 2;
    *b = 3;
    int *mid = a + 1;
    free(a);
    a = b;
}`,
    hints: [
      'Freeing a block dangles every pointer into it — including one into its middle.',
      'After the free, a itself can be pointed somewhere new.',
    ],
  },
  {
    id: 'seed-10',
    section: 'Structs',
    kind: 'code-to-diagram',
    title: 'Linked structure',
    topic: 'Structs that point to structs',
    code: `struct Node {
    int value;
    struct Node *next;
};

int main(void) {
    struct Node a = {1, NULL};
    struct Node b = {2, &a};
    return 0;
}`,
    hints: ['Each struct is one object with two fields.', 'b.next points to the whole struct a.'],
  },
  {
    id: 'seed-shallow',
    section: 'Structs',
    kind: 'code-to-diagram',
    title: 'Shallow copy',
    topic: 'Copying a struct that holds a pointer',
    code: `struct Box {
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
}`,
    hints: [
      'b = a copies the pointer inside a, not the array it points to.',
      'How many heap arrays does this program allocate?',
    ],
  },
  {
    id: 'seed-build-list',
    section: 'Linked lists',
    kind: 'diagram-to-code',
    title: 'Build a list',
    topic: 'Linked lists on the heap',
    code: `typedef struct Node {
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
}`,
    hints: [
      "Every node is a malloc'd struct with no name of its own.",
      'Building from the back is easiest: each new node points at the old head.',
    ],
  },
  {
    id: 'seed-reverse-list',
    section: 'Linked lists',
    kind: 'code-to-diagram',
    title: 'Reverse the links',
    topic: 'Tracing pointers through a loop',
    code: `struct Node {
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
}`,
    hints: [
      'Each pass turns one link around to point backwards.',
      'next is local to the loop body, so it is gone at the end.',
    ],
  },
  {
    id: 'seed-unlink',
    section: 'Linked lists',
    kind: 'code-to-diagram',
    title: 'Unlink and free',
    topic: 'Removing a node from a list',
    code: `typedef struct Node {
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
}`,
    hints: [
      'Unlinking only redirects head->next; the freed node keeps its old contents.',
      "Freed blocks are read-only: fill in that node and draw doomed's arrow before marking it freed.",
    ],
  },
].map(normalizeLevel);
