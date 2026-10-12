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
    prompt: text(raw.prompt, 'Recreate this memory state.'),
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
   time so the level format stays human-writable and versionable.      */
export const seedLevels = [
  {
    id: 'seed-1',
    kind: 'code-to-diagram',
    title: 'Read the arrow',
    prompt: 'Build the memory diagram this code produces.',
    code: `int main() {\n    int a = 10;\n    int *b = &a;\n}`,
    hints: [
      'Two boxes: one plain int, one pointer.',
      "b's box holds an arrow, not a number — draw it from b to a.",
    ],
  },
  {
    id: 'seed-2',
    kind: 'diagram-to-code',
    title: 'Write the arrow',
    prompt: 'Write C code that produces exactly this memory state.',
    code: `int main() {\n    int x = 7;\n    int *p = &x;\n}`,
    hints: ['Declare the int before the pointer.', 'Use & to take the address of x.'],
  },
  {
    id: 'seed-3',
    kind: 'code-to-diagram',
    title: 'Pointers move',
    prompt: 'Careful: p is reassigned, then written through. Where does 99 end up?',
    code: `int main() {\n    int x = 1;\n    int y = 2;\n    int *p = &x;\n    p = &y;\n    *p = 99;\n}`,
    hints: [
      'After p = &y, the old arrow to x is gone.',
      '*p = 99 writes through the arrow — into y, not x.',
    ],
  },
  {
    id: 'seed-4',
    kind: 'diagram-to-code',
    title: 'Two hops',
    prompt: 'Produce this double-pointer chain: pp → p → a, where a holds 5.',
    code: `int main() {\n    int a = 5;\n    int *p = &a;\n    int **pp = &p;\n}`,
    hints: ['pp has type int ** — two stars.', 'Each & gives you exactly one arrow.'],
  },
  {
    id: 'seed-5',
    kind: 'code-to-diagram',
    title: 'The nameless box',
    prompt: 'malloc creates memory with no name. Build what this code leaves behind.',
    code: `int main() {\n    int *p = malloc(sizeof(int));\n    *p = 42;\n    int *q = p;\n}`,
    hints: [
      "The malloc'd box lives in the heap region and has no name.",
      'q = p copies the arrow — both point at the same heap box.',
    ],
  },
  {
    id: 'seed-6',
    kind: 'diagram-to-code',
    title: 'Use after free',
    prompt:
      'Recreate this crime scene: two pointers left dangling after their heap cell was freed.',
    code: `int main() {\n    int *p = malloc(sizeof(int));\n    int *q = p;\n    free(p);\n}`,
    hints: ['You need malloc AND free.', 'Freeing through one pointer dangles every alias.'],
  },
  {
    id: 'seed-7',
    kind: 'code-to-diagram',
    title: 'Inside the array',
    prompt: 'Show where p points after it is advanced by one element.',
    code: `int main() {
    int arr[3] = {10, 20, 30};
    int *p = arr;
    p++;
}`,
    hints: [
      'An array name decays to a pointer to arr[0].',
      'p++ moves by one int element, so the final arrow ends at arr[1].',
    ],
  },
  {
    id: 'seed-8',
    kind: 'diagram-to-code',
    title: 'Heap array',
    prompt:
      'Write code that allocates three ints, fills them, and leaves p pointing at the first element.',
    code: `int main() {
    int *p = malloc(3 * sizeof(int));
    p[0] = 4;
    p[1] = 5;
    p[2] = 6;
}`,
    hints: [
      'Allocate 3 * sizeof(int), not just sizeof(int).',
      'Use p[index] to initialize each element.',
    ],
  },
  {
    id: 'seed-9',
    kind: 'code-to-diagram',
    title: 'A function call',
    prompt: 'Build the memory left after set_value() returns.',
    code: `void set_value(int *p) {
    *p = 25;
}

int main(void) {
    int value = 10;
    set_value(&value);
    return 0;
}`,
    hints: [
      "p is set_value()'s parameter: it points back into main()'s frame, and is gone once set_value() returns.",
      "Writing through p changed main's value, so only value remains, holding 25.",
    ],
  },
  {
    id: 'seed-10',
    kind: 'code-to-diagram',
    title: 'Linked structure',
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
    id: 'seed-11',
    kind: 'code-to-diagram',
    title: 'Choose a target',
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
    hints: [
      'Evaluate b > a before moving the pointer.',
      'Only the branch whose condition is non-zero executes.',
    ],
  },
  {
    id: 'seed-12',
    kind: 'code-to-diagram',
    title: 'Fill an array',
    prompt: 'Work through the loop and build the final array contents.',
    code: `int main(void) {
    int values[4] = {0, 0, 0, 0};
    int i = 0;
    for (i = 0; i < 4; i++) {
        values[i] = i * 10;
    }
    return 0;
}`,
    hints: [
      'The loop runs for i = 0, 1, 2, 3.',
      'Each iteration writes to values[i] before i is incremented.',
    ],
  },
];
