/**
 * Challenge content and browser-only persistence.
 * Seed levels are versioned in source; custom levels and progress are JSON in
 * localStorage so UI components stay independent of the storage mechanism.
 */

const LEVELS_KEY = 'pointerviz.levels';
const PROGRESS_KEY = 'pointerviz.progress';
const LEGACY_LEVELS_KEY = 'pointerlab.levels';
const LEGACY_PROGRESS_KEY = 'pointerlab.progress';

export function loadCustomLevels() {
  try {
    const current = localStorage.getItem(LEVELS_KEY);
    if (current) return JSON.parse(current) ?? [];
    const legacy = localStorage.getItem(LEGACY_LEVELS_KEY);
    if (!legacy) return [];
    const parsed = JSON.parse(legacy) ?? [];
    localStorage.setItem(LEVELS_KEY, JSON.stringify(parsed));
    return parsed;
  } catch { return []; }
}

export function saveCustomLevels(levels) {
  localStorage.setItem(LEVELS_KEY, JSON.stringify(levels));
}
export function loadProgress() {
  try {
    const current = localStorage.getItem(PROGRESS_KEY);
    if (current) return JSON.parse(current) ?? {};
    const legacy = localStorage.getItem(LEGACY_PROGRESS_KEY);
    if (!legacy) return {};
    const parsed = JSON.parse(legacy) ?? {};
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(parsed));
    return parsed;
  } catch { return {}; }
}

export function recordResult(levelId, { solved, attempts, usedHints }) {
  const p = loadProgress();
  const prev = p[levelId] ?? { stars: 0, attempts: 0 };
  // 3★ first try no hints · 2★ solved with ≤3 attempts or hints · 1★ solved
  const stars = !solved ? prev.stars
    : attempts === 1 && !usedHints ? 3
    : attempts <= 3 ? Math.max(prev.stars, 2)
    : Math.max(prev.stars, 1);
  p[levelId] = { stars, attempts: prev.attempts + 1 };
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  return p[levelId];
}

/* ── Seed levels ─────────────────────────────────────────────────────
   Target IRs are stored as plain code; the app interprets them at load
   time so the level format stays human-writable and versionable.      */
export const seedLevels = [
  {
    id: 'seed-1', kind: 'code-to-diagram', title: 'Read the arrow',
    prompt: 'Build the memory diagram this code produces.',
    code: `int main() {\n    int a = 10;\n    int *b = &a;\n}`,
    hints: ['Two boxes: one plain int, one pointer.', "b's box holds an arrow, not a number — draw it from b to a."],
  },
  {
    id: 'seed-2', kind: 'diagram-to-code', title: 'Write the arrow',
    prompt: 'Write C code that produces exactly this memory state.',
    code: `int main() {\n    int x = 7;\n    int *p = &x;\n}`,
    hints: ['Declare the int before the pointer.', 'Use & to take the address of x.'],
  },
  {
    id: 'seed-3', kind: 'code-to-diagram', title: 'Pointers move',
    prompt: 'Careful: p is reassigned, then written through. Where does 99 end up?',
    code: `int main() {\n    int x = 1;\n    int y = 2;\n    int *p = &x;\n    p = &y;\n    *p = 99;\n}`,
    hints: ['After p = &y, the old arrow to x is gone.', '*p = 99 writes through the arrow — into y, not x.'],
  },
  {
    id: 'seed-4', kind: 'diagram-to-code', title: 'Two hops',
    prompt: 'Produce this double-pointer chain: pp → p → a, where a holds 5.',
    code: `int main() {\n    int a = 5;\n    int *p = &a;\n    int **pp = &p;\n}`,
    hints: ['pp has type int ** — two stars.', 'Each & gives you exactly one arrow.'],
  },
  {
    id: 'seed-5', kind: 'code-to-diagram', title: 'The nameless box',
    prompt: 'malloc creates memory with no name. Build what this code leaves behind.',
    code: `int main() {\n    int *p = malloc(sizeof(int));\n    *p = 42;\n    int *q = p;\n}`,
    hints: ['The malloc\'d box lives in the heap region and has no name.', 'q = p copies the arrow — both point at the same heap box.'],
  },
  {
    id: 'seed-6', kind: 'diagram-to-code', title: 'Use after free',
    prompt: 'Recreate this crime scene: two pointers left dangling after their heap cell was freed.',
    code: `int main() {\n    int *p = malloc(sizeof(int));\n    int *q = p;\n    free(p);\n}`,
    hints: ['You need malloc AND free.', 'Freeing through one pointer dangles every alias.'],
  },
  {
    id: 'seed-7', kind: 'code-to-diagram', title: 'Inside the array',
    prompt: 'Show where p points after it is advanced by one element.',
    code: `int main() {
    int arr[3] = {10, 20, 30};
    int *p = arr;
    p++;
}`,
    hints: ['An array name decays to a pointer to arr[0].', 'p++ moves by one int element, so the final arrow ends at arr[1].'],
  },
  {
    id: 'seed-8', kind: 'diagram-to-code', title: 'Heap array',
    prompt: 'Write code that allocates three ints, fills them, and leaves p pointing at the first element.',
    code: `int main() {
    int *p = malloc(3 * sizeof(int));
    p[0] = 4;
    p[1] = 5;
    p[2] = 6;
}`,
    hints: ['Allocate 3 * sizeof(int), not just sizeof(int).', 'Use p[index] to initialize each element.'],
  },
  {
    id: 'seed-9', kind: 'code-to-diagram', title: 'A function call',
    prompt: 'Step through the call and inspect both stack frames.',
    code: `void set_value(int *p) {
    *p = 25;
}

int main(void) {
    int value = 10;
    set_value(&value);
    return 0;
}`,
    hints: ['The parameter p belongs to set_value(), not main().', "p points back into main()'s stack frame."],
  },
  {
    id: 'seed-10', kind: 'code-to-diagram', title: 'Linked structure',
    prompt: 'Inspect the fields and pointer relationship between two Node structures.',
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
    id: 'seed-11', kind: 'code-to-diagram', title: 'Choose a target',
    prompt: 'Follow the condition and build the final pointer relationship.',
    code: `int main(void) {
    int a = 1;
    int b = 2;
    int *p = &a;
    if (b > a) {
        p = &b;
    }
    return 0;
}`,
    hints: ['Evaluate b > a before moving the pointer.', 'Only the branch whose condition is non-zero executes.'],
  },
  {
    id: 'seed-12', kind: 'code-to-diagram', title: 'Fill an array',
    prompt: 'Work through the loop and build the final array contents.',
    code: `int main(void) {
    int values[4] = {0, 0, 0, 0};
    int i = 0;
    for (i = 0; i < 4; i++) {
        values[i] = i * 10;
    }
    return 0;
}`,
    hints: ['The loop runs for i = 0, 1, 2, 3.', 'Each iteration writes to values[i] before i is incremented.'],
  }
];
