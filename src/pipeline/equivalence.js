/**
 * Semantic grading over MemoryState graphs.
 *
 * Stack variables match by name by default; heap allocations are anonymous and
 * matched up to graph isomorphism. Freed allocations remain in the graph, so
 * alias provenance is part of the answer rather than being erased. Out-of-scope
 * locals and string literals count only while a pointer still refers to them
 * (see gradedIds).
 */
import {
  isArray,
  isPointer,
  isPrimitive,
  isStruct,
  typeEquals,
  typeToString,
} from '../language/types.js';
import {
  allocationDisplayName,
  getAllocation,
  heapAllocations,
  pointerStatus,
  samePath,
  scalarSubobjects,
  stackAllocations,
  staticAllocations,
} from '../machine/memory.js';
import { validate, ValidationError } from './codegen.js';

/**
 * Feedback says where an answer is wrong, never what it should be: no expected values,
 * types, pointer targets or counts, which would hand students the answer. Names that the
 * level already shows (in its code or target diagram) may appear. Hints are for help.
 */
const MEMORY_MISMATCH = "Your memory doesn't match the expected layout";
const SEARCH_EXHAUSTED =
  'PointerViz could not finish comparing your memory: it has too many similar heap blocks';

/**
 * The allocations grading compares: every live stack object and every heap block (freed or
 * not), plus any out-of-scope local or string literal that a graded pointer refers to.
 * An out-of-scope local nothing points to (a returned call's parameter, a loop temporary)
 * is history the program can no longer observe; one a pointer still refers to is a
 * dangling target, which is part of the answer.
 */
export function gradedIds(state) {
  const optional = a => (a.storage.kind === 'stack' && !a.alive) || a.storage.kind === 'static';
  const ids = new Set(state.allocations.filter(a => !optional(a)).map(a => a.id));
  for (let added = true; added;) {
    added = false;
    for (const a of state.allocations.filter(a => ids.has(a.id)))
      for (const s of scalarSubobjects(a, state))
        if (s.value.kind === 'pointer' && !ids.has(s.value.target.allocationId)) {
          ids.add(s.value.target.allocationId);
          added = true;
        }
  }
  return ids;
}

/**
 * Why a student could not draw the graded part of `state` in the diagram editor, or [] when
 * they can. Code→diagram answers are built there: live variables in main(), heap blocks
 * (freed or not), and objects of type [array of] pointer… to a primitive or a struct, whose
 * pointers target real objects rather than one-past boundaries.
 */
export function drawingIssues(state) {
  const issues = new Set();
  const drawable = type => {
    let t = isArray(type) ? type.of : type;
    while (isPointer(t)) t = t.to;
    return isPrimitive(t) || isStruct(t);
  };
  const graded = gradedIds(state);
  for (const a of state.allocations.filter(a => graded.has(a.id))) {
    if (a.storage.kind === 'static') issues.add('a string literal that a pointer refers to');
    else if (a.storage.kind === 'stack' && !a.alive)
      issues.add(`the out-of-scope variable '${a.name}', which a pointer still refers to`);
    else if (a.storage.kind === 'stack' && (a.storage.frameId ?? 'main') !== 'main')
      issues.add(`'${a.name}' in a function call that has not returned`);
    if (!drawable(a.type))
      issues.add(`'${allocationDisplayName(state, a)}' of type ${typeToString(a.type)}`);
    // The editor's target picker offers only real objects, never a one-past boundary.
    if (scalarSubobjects(a, state).some(s => pointerStatus(state, s.value) === 'one-past'))
      issues.add(`a one-past-the-end pointer in '${allocationDisplayName(state, a)}'`);
  }
  return [...issues];
}

/**
 * Values, types and pointer targets are always compared. Storage needs no option: stack,
 * literal and heap objects are only ever paired with their own kind. The two options are
 * the ones the Level editor offers.
 */
export function equivalent(expected, actual, options = {}) {
  const config = {
    compareNames: options.compareNames ?? true,
    compareLifetime: options.compareLifetime ?? true,
  };

  // Invalid diagrams should never sneak through comparison (duplicate names was
  // a concrete bug in the prototype).
  try {
    validate(expected);
  } catch (e) {
    if (e instanceof ValidationError)
      throw new Error(`invalid target state: ${e.errors.join('; ')}`);
    throw e;
  }
  try {
    validate(actual);
  } catch (e) {
    if (e instanceof ValidationError)
      return {
        equal: false,
        diffs: e.errors,
        badIds: new Set(actual.allocations?.map(a => a.id) ?? []),
      };
    throw e;
  }

  const initial = new Map();
  const diffs = [];
  const badIds = new Set();
  const gradedA = gradedIds(expected),
    gradedB = gradedIds(actual);
  const aStack = stackAllocations(expected).filter(a => gradedA.has(a.id)),
    bStack = stackAllocations(actual).filter(b => gradedB.has(b.id));

  if (config.compareNames) {
    const actualByName = new Map(bStack.map(b => [stackKey(actual, b, bStack), b]));
    for (const a of aStack) {
      const key = stackKey(expected, a, aStack);
      const b = actualByName.get(key);
      if (!b) {
        diffs.push(`Missing ${stackLabel(expected, a, aStack)}`);
        continue;
      }
      actualByName.delete(key);
      initial.set(a.id, b.id);
      if (!typeEquals(a.type, b.type)) {
        diffs.push(`${capitalize(stackLabel(expected, a, aStack))} has the wrong type`);
        badIds.add(b.id);
      }
    }
    for (const extra of actualByName.values()) {
      diffs.push(`Unexpected ${stackLabel(actual, extra, bStack)}`);
      badIds.add(extra.id);
    }
    if (diffs.length) return { equal: false, diffs, badIds };
  } else {
    if (aStack.length !== bStack.length) {
      return {
        equal: false,
        diffs: ['The number of variables is wrong'],
        badIds: new Set(bStack.map(a => a.id)),
      };
    }
    // Name-insensitive grading can be generalized later. For now pair by type/order.
    for (let i = 0; i < aStack.length; i++) initial.set(aStack[i].id, bStack[i].id);
  }

  // A string literal is identified by its contents. One no graded pointer reaches is not
  // part of the answer: its pointer may have moved on, and diagrams cannot draw literals.
  for (const a of staticAllocations(expected).filter(a => gradedA.has(a.id))) {
    const b = staticAllocations(actual).find(b => b.name === a.name);
    if (!b)
      return {
        equal: false,
        diffs: ['A string literal is missing'],
        badIds: new Set(),
      };
    initial.set(a.id, b.id);
  }

  const aHeap = heapAllocations(expected),
    bHeap = heapAllocations(actual);
  if (aHeap.length !== bHeap.length) {
    return {
      equal: false,
      diffs: ['The number of heap blocks is wrong'],
      badIds: new Set(bHeap.map(a => a.id)),
    };
  }

  const result = bestHeapMapping(expected, actual, initial, aHeap, bHeap, config, gradedA, gradedB);
  // A search cut short may have missed a perfect mapping, so its mismatches are not reported.
  if (result.exhausted && result.best?.score !== 0)
    return { equal: false, diffs: [SEARCH_EXHAUSTED], badIds: new Set() };
  const best = result.best;
  if (!best)
    return {
      equal: false,
      diffs: [MEMORY_MISMATCH],
      badIds: new Set(actual.allocations.map(a => a.id)),
    };
  if (best.score === 0) return { equal: true, diffs: [], badIds: new Set() };
  return collectDiffs(expected, actual, best.map, config);
}

/** Mappings tried before grading gives up; pruning keeps real answers far below it. */
export const MAX_SEARCH_NODES = 100000;

/**
 * Branch and bound over heap pairings. Scores only grow as blocks are paired, so a branch is
 * cut once the score so far, plus the least each unpaired block must still cost, cannot beat
 * the best complete mapping. Cheapest pairings are tried first, and the search stops at a
 * perfect match.
 */
function bestHeapMapping(A, B, initial, aHeap, bHeap, config, gradedA, gradedB) {
  let best = null,
    nodes = 0,
    exhausted = false;
  const used = new Set();
  const map = new Map(initial);
  const twins = interchangeableBlocks(B, bHeap, gradedB);
  const compatible = (a, b) =>
    typeEquals(a.type, b.type) && (!config.compareLifetime || a.alive === b.alive);
  // What pairing a with b costs whatever else is paired: pointer targets are not yet known.
  const floor = new Map(
    aHeap.map(a => [
      a.id,
      bHeap
        .filter(b => compatible(a, b))
        .map(b => [b.id, pairScore(A, B, a, b, new Map(), config, true)]),
    ]),
  );
  const remainingFloor = i => {
    let total = 0;
    for (let j = i; j < aHeap.length; j++) {
      let least = Number.POSITIVE_INFINITY;
      for (const [bId, cost] of floor.get(aHeap[j].id))
        if (!used.has(bId) && cost < least) least = cost;
      total += least;
    }
    return total;
  };

  function search(i) {
    if (i === aHeap.length) {
      const score = scoreMapping(A, B, map, config, gradedA.size);
      if (!best || score < best.score) best = { score, map: new Map(map) };
      return;
    }
    const a = aHeap[i];
    const options = [];
    const triedTwins = new Set();
    for (const b of bHeap) {
      if (used.has(b.id) || !compatible(a, b)) continue;
      // Pairing `a` with either of two interchangeable blocks scores the same; try one.
      const twin = twins.get(b.id);
      if (twin !== undefined) {
        if (triedTwins.has(twin)) continue;
        triedTwins.add(twin);
      }
      map.set(a.id, b.id);
      options.push({ b, score: scoreMappedAllocations(A, B, map, config, true) });
      map.delete(a.id);
    }
    options.sort((x, y) => x.score - y.score);
    for (const { b, score } of options) {
      if (best?.score === 0) return;
      if (++nodes > MAX_SEARCH_NODES) {
        exhausted = true;
        return;
      }
      map.set(a.id, b.id);
      used.add(b.id);
      // Only a strictly better mapping replaces the best, so equal bounds are cut too.
      if (!best || score + remainingFloor(i + 1) < best.score) search(i + 1);
      map.delete(a.id);
      used.delete(b.id);
    }
  }

  search(0);
  return { best, exhausted };
}

/**
 * Heap blocks of `state` that no graded object points to, keyed so that blocks with equal keys
 * have the same type, lifetime and contents. Swapping two such blocks in any mapping leaves
 * every score unchanged: their own comparison is identical, and no compared pointer can tell
 * them apart. (Expired locals that are not graded, such as a loop's `p`, are never compared.)
 */
function interchangeableBlocks(state, heap, graded) {
  const targeted = new Set();
  for (const a of state.allocations.filter(a => graded.has(a.id)))
    for (const s of scalarSubobjects(a, state))
      if (s.value.kind === 'pointer') targeted.add(s.value.target.allocationId);
  return new Map(
    heap
      .filter(b => !targeted.has(b.id))
      .map(b => [b.id, JSON.stringify([b.type, b.alive, b.value])]),
  );
}

function scoreMapping(A, B, map, config, mappedCount) {
  if (map.size !== mappedCount) return Number.POSITIVE_INFINITY;
  return scoreMappedAllocations(A, B, map, config, false);
}

function scoreMappedAllocations(A, B, map, config, partial) {
  let score = 0;
  for (const [aId, bId] of map.entries())
    score += pairScore(A, B, getAllocation(A, aId), getAllocation(B, bId), map, config, partial);
  return score;
}

function pairScore(A, B, a, b, map, config, partial) {
  if (!typeEquals(a.type, b.type)) return 10;
  let score = config.compareLifetime && a.alive !== b.alive ? 5 : 0;
  const as = scalarSubobjects(a, A),
    bs = scalarSubobjects(b, B);
  if (as.length !== bs.length) return score + 10;
  for (let i = 0; i < as.length; i++) {
    if (!samePath(as[i].ref.path, bs[i].ref.path)) {
      score += 3;
      continue;
    }
    score += scalarMismatchScore(A, B, as[i], bs[i], map, config, partial);
  }
  return score;
}

function scalarMismatchScore(A, B, a, b, map, config, partial) {
  const av = a.value,
    bv = b.value;
  if (av.kind !== bv.kind) return 2;
  if (av.kind === 'scalar') return av.value !== bv.value ? 1 : 0;
  if (av.kind !== 'pointer') return 0; // null/uninit

  const mappedTarget = map.get(av.target.allocationId);
  if (!mappedTarget) return partial ? 0 : 2;
  if (mappedTarget !== bv.target.allocationId) return 2;
  if (!samePath(av.target.path, bv.target.path)) return 1;
  // Lifetime is compared on allocations, but status comparison yields clearer semantics.
  if (config.compareLifetime && pointerStatus(A, av) !== pointerStatus(B, bv)) return 1;
  return 0;
}

function collectDiffs(A, B, map, config) {
  const diffs = [];
  const badIds = new Set();

  for (const [aId, bId] of map.entries()) {
    const a = getAllocation(A, aId),
      b = getAllocation(B, bId);
    const label = objectLabel(A, a);
    if (!typeEquals(a.type, b.type)) {
      diffs.push(`${label} has the wrong type`);
      badIds.add(b.id);
      continue;
    }
    if (config.compareLifetime && a.alive !== b.alive) {
      diffs.push(`${label}: check whether it should be freed`);
      badIds.add(b.id);
    }

    const as = scalarSubobjects(a, A),
      bs = scalarSubobjects(b, B);
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      const av = as[i].value,
        bv = bs[i].value;
      const sublabel = subobjectLabel(A, a, as[i].ref.path);
      // Any difference involving a pointer (wrong target, NULL, unset) is about where it points.
      const pointerWrong =
        (av.kind === 'pointer' || bv.kind === 'pointer') &&
        (av.kind !== bv.kind ||
          map.get(av.target.allocationId) !== bv.target.allocationId ||
          !samePath(av.target.path, bv.target.path));
      const valueWrong =
        !pointerWrong &&
        av.kind !== 'pointer' &&
        (av.kind !== bv.kind || (av.kind === 'scalar' && av.value !== bv.value));
      if (pointerWrong) diffs.push(`${sublabel} points to the wrong place`);
      else if (valueWrong) diffs.push(`${sublabel} has the wrong value`);
      else continue;
      badIds.add(b.id);
    }
  }

  return {
    equal: diffs.length === 0,
    diffs: diffs.length ? diffs : [MEMORY_MISMATCH],
    badIds,
  };
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
/** Student-facing labels use display names ("heap 2"), never internal IDs ("a7"). */
function objectLabel(state, allocation) {
  return `'${allocationDisplayName(state, allocation)}'`;
}
function subobjectLabel(state, allocation, path) {
  let out = allocationDisplayName(state, allocation);
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : `.${p}`;
  return `'${out}'`;
}
function frameKey(state, frameId) {
  if (!frameId || frameId === 'main') return 'main';
  const frame = state.frames?.find(f => f.id === frameId);
  if (!frame) return frameId;
  let occurrence = 0;
  for (const f of state.frames ?? []) {
    if (f.name === frame.name && f.depth === frame.depth) occurrence++;
    if (f.id === frame.id) break;
  }
  return `${frame.name}@${frame.depth}#${occurrence}`;
}
/**
 * Which graded out-of-scope object of this name in this frame `allocation` is (1 for the
 * first). Counting only graded objects keeps ignored temporaries from shifting the numbers.
 */
function expiredOccurrence(allocation, graded) {
  const same = graded.filter(
    a => !a.alive && a.name === allocation.name && a.storage.frameId === allocation.storage.frameId,
  );
  return same.indexOf(allocation) + 1;
}
/**
 * Live names are unique in a frame (validate), so a live variable is keyed by its name alone
 * and matches whatever expired objects of that name came before it. Expired objects from
 * block and loop scopes may share a name and are keyed by their order of declaration.
 */
function stackKey(state, allocation, graded) {
  const frame = frameKey(state, allocation.storage.frameId);
  return allocation.alive
    ? `${frame}:${allocation.name}`
    : `${frame}:${allocation.name}~expired#${expiredOccurrence(allocation, graded)}`;
}
function stackLabel(state, allocation, graded) {
  const frame = state.frames?.find(f => f.id === allocation.storage.frameId);
  let label =
    frame && frame.id !== 'main'
      ? `'${allocation.name}' in ${frame.name}()`
      : `variable '${allocation.name}'`;
  if (!allocation.alive) {
    const n = expiredOccurrence(allocation, graded);
    label += ` (out of scope${n > 1 ? `, #${n}` : ''})`;
  }
  return label;
}
