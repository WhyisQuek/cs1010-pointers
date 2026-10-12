/** Regression cases for defects fixed in the September 2026 code audit (docs/CODE_AUDIT.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { primitive } from '../src/language/types.js';
import { scalarFromInput } from '../src/language/numeric.js';
import { addAllocation, makeState, pointerValue, ref } from '../src/machine/memory.js';
import {
  DEFAULT_PROMPTS,
  availableLevels,
  loadCourseLevels,
  loadCustomLevels,
  mergeLevels,
  normalizeLevel,
  clearProgress,
  isSolved,
  loadProgress,
  markSolved,
  saveCustomLevels,
  seedLevels,
} from '../src/data/levels.js';

const INT = primitive('int');

test('parser initialization requires explicit WASM paths instead of root-relative defaults', async () => {
  await assert.rejects(initParser(), /requires runtimeWasm and grammarWasm/);
  await assert.rejects(
    initParser({ runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm' }),
    /requires/,
  );
});

test('edited scalar values are range-checked instead of truncated or wrapped', () => {
  assert.equal(scalarFromInput('42', INT), 42);
  assert.equal(scalarFromInput('-2147483648', INT), -2147483648);
  assert.throws(() => scalarFromInput('1.5', INT), /whole numbers/);
  assert.throws(() => scalarFromInput('2147483648', INT), /outside the range of int/);
  assert.throws(() => scalarFromInput('300', primitive('char')), /outside the range of char/);
  assert.throws(() => scalarFromInput('-1', primitive('unsigned int')), /outside the range/);
  assert.throws(() => scalarFromInput('abc', INT), /not a number/);
  assert.equal(scalarFromInput('0.1', primitive('float')), Math.fround(0.1));
  assert.equal(scalarFromInput('2.5', primitive('double')), 2.5);
});

test('grading feedback names heap objects by display label, never internal IDs', () => {
  const build = value => {
    const s = makeState();
    const h = addAllocation(s, {
      type: INT,
      storage: { kind: 'heap' },
      value: { kind: 'scalar', value },
    });
    addAllocation(s, {
      name: 'p',
      type: { kind: 'pointer', to: INT },
      value: pointerValue(ref(h.id)),
    });
    return s;
  };
  const result = equivalent(build(1), build(2));
  assert.equal(result.equal, false);
  assert.ok(
    result.diffs.some(d => d.includes("'heap 1'")),
    result.diffs.join('; '),
  );
  assert.ok(
    result.diffs.every(d => !/\ba\d+\b/.test(d)),
    result.diffs.join('; '),
  );
});

test('imported levels are normalized and malformed entries rejected', () => {
  assert.equal(normalizeLevel(null), null);
  assert.equal(normalizeLevel({ kind: 'code-to-diagram' }), null);
  assert.equal(normalizeLevel({ kind: 'bogus', code: 'int main(){}' }), null);
  const level = normalizeLevel({
    id: 'x',
    kind: 'diagram-to-code',
    code: 'int main(){}',
    title: '  T  ',
    topic: ' Pointers ',
    hints: [' a ', 3, ''],
    grading: { compareNames: false, evil: true },
  });
  assert.deepEqual(level, {
    id: 'x',
    kind: 'diagram-to-code',
    title: 'T',
    topic: 'Pointers',
    prompt: DEFAULT_PROMPTS['diagram-to-code'],
    code: 'int main(){}',
    hints: ['a'],
    grading: { compareNames: false },
  });
  // A missing topic shows no subtitle; the default prompt follows the challenge direction.
  const bare = normalizeLevel({ kind: 'code-to-diagram', code: 'int main(){}' });
  assert.equal(bare.topic, '');
  assert.equal(bare.prompt, DEFAULT_PROMPTS['code-to-diagram']);
});

test('every seed level has a topic and an instruction', () => {
  for (const level of seedLevels) {
    assert.ok(level.topic, `${level.id} has no topic`);
    assert.ok(level.prompt, `${level.id} has no prompt`);
  }
});

test('merging levels never produces duplicate IDs, including against seed levels', () => {
  const a = normalizeLevel({ id: 'custom-1', kind: 'code-to-diagram', code: 'int main(){}' });
  const seedClash = { ...a, id: seedLevels[0].id };
  const merged = mergeLevels([a], [a, a, seedClash]);
  const ids = merged.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['custom-1', 'custom-1-2', 'custom-1-3', `${seedLevels[0].id}-2`]);
});

test('stored levels with duplicate IDs are repaired when loaded', t => {
  const store = new Map([
    [
      'pointerviz.levels',
      JSON.stringify([
        { id: 'custom-1', kind: 'code-to-diagram', code: 'int main(){}' },
        { id: 'custom-1', kind: 'code-to-diagram', code: 'int main(){}' },
      ]),
    ],
  ]);
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  t.after(() => delete globalThis.localStorage);
  assert.deepEqual(
    loadCustomLevels().map(l => l.id),
    ['custom-1', 'custom-1-2'],
  );
});

test('syntax errors name a missing token instead of quoting empty text', async () => {
  await initParser({
    runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
    grammarWasm: './public/tree-sitter-c.wasm',
  });
  assert.throws(() => interpret('int main() { int x = 1 }'), /line 1: missing ;/);
});

test('level persistence degrades gracefully when browser storage is unavailable', () => {
  // Node has no localStorage, which behaves like blocked site data in a browser.
  assert.deepEqual(loadCustomLevels(), []);
  assert.equal(saveCustomLevels([]), false);
  assert.doesNotThrow(() => markSolved('seed-1'));
  assert.doesNotThrow(() => clearProgress('seed-1'));
});

test('progress is completion only', t => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  t.after(() => delete globalThis.localStorage);
  assert.equal(isSolved(loadProgress(), 'seed-1'), false);
  markSolved('seed-1');
  assert.deepEqual(loadProgress()['seed-1'], { solved: true });
  clearProgress('seed-1');
  assert.equal(isSolved(loadProgress(), 'seed-1'), false);
});

const respond = body => async () => ({ ok: true, json: async () => body });

test('the course pack is normalized, deduplicated and never throws', async () => {
  const levels = await loadCourseLevels(
    'course.json',
    respond([
      { id: 'week-1', kind: 'code-to-diagram', title: 'One', code: 'int main(){}' },
      { id: 'week-1', kind: 'code-to-diagram', title: 'Two', code: 'int main(){}' },
      { id: seedLevels[0].id, kind: 'diagram-to-code', code: 'int main(){}' },
      { kind: 'bogus', code: 'int main(){}' },
    ]),
  );
  assert.deepEqual(
    levels.map(l => l.id),
    ['week-1', 'week-1-2', `${seedLevels[0].id}-2`],
  );
  assert.deepEqual(await loadCourseLevels('x', respond({ not: 'an array' })), []);
  assert.deepEqual(await loadCourseLevels('x', async () => ({ ok: false })), []);
  assert.deepEqual(
    await loadCourseLevels('x', async () => {
      throw new Error('offline');
    }),
    [],
  );
  const malformed = async () => ({ ok: true, json: async () => JSON.parse('{') });
  assert.deepEqual(await loadCourseLevels('x', malformed), []);
});

test('students see seed and course levels; an instructor draft replaces its course level', async t => {
  await loadCourseLevels(
    'course.json',
    respond([{ id: 'week-1', kind: 'code-to-diagram', title: 'Published', code: 'int main(){}' }]),
  );
  t.after(() => loadCourseLevels('x', async () => ({ ok: false })));
  const store = new Map([
    [
      'pointerviz.levels',
      JSON.stringify([
        { id: 'week-1', kind: 'code-to-diagram', title: 'Draft', code: 'int main(){}' },
        { id: 'custom-9', kind: 'code-to-diagram', title: 'New', code: 'int main(){}' },
      ]),
    ],
  ]);
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  t.after(() => delete globalThis.localStorage);

  const titles = opts =>
    availableLevels(opts)
      .slice(seedLevels.length)
      .map(l => l.title);
  assert.deepEqual(titles({ includeCustom: false }), ['Published']);
  assert.deepEqual(titles({ includeCustom: true }), ['Draft', 'New']);
});

test('grading ignores options the level format does not support', () => {
  const level = normalizeLevel({
    kind: 'code-to-diagram',
    code: 'int main(){}',
    grading: { compareNames: true, compareValues: false, compareStorage: false },
  });
  assert.deepEqual(level.grading, { compareNames: true });
});
