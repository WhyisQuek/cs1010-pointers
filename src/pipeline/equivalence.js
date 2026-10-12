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
  resolveRef,
  samePath,
  scalarSubobjects,
  stackAllocations,
  staticAllocations,
} from '../machine/memory.js';
import { validate, ValidationError } from './codegen.js';

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
 * (freed or not), and objects of type [array of] pointer… to a primitive or a struct.
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
  }
  return [...issues];
}

export function equivalent(expected, actual, options = {}) {
  const config = {
    compareNames: options.compareNames ?? true,
    compareStorage: options.compareStorage ?? true,
    compareLifetime: options.compareLifetime ?? true,
    compareValues: options.compareValues ?? true,
    comparePointerRelationships: options.comparePointerRelationships ?? true,
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
        diffs.push(`missing ${stackLabel(expected, a, aStack)}`);
        continue;
      }
      actualByName.delete(key);
      initial.set(a.id, b.id);
      if (!typeEquals(a.type, b.type)) {
        diffs.push(
          `${stackLabel(expected, a, aStack)} should have type ${typeToString(a.type)}, found ${typeToString(b.type)}`,
        );
        badIds.add(b.id);
      }
    }
    for (const extra of actualByName.values()) {
      diffs.push(`unexpected ${stackLabel(actual, extra, bStack)}`);
      badIds.add(extra.id);
    }
    if (diffs.length) return { equal: false, diffs, badIds };
  } else {
    if (aStack.length !== bStack.length) {
      return {
        equal: false,
        diffs: [`expected ${aStack.length} stack variable(s), found ${bStack.length}`],
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
        diffs: [`missing string literal ${a.name}`],
        badIds: new Set(),
      };
    initial.set(a.id, b.id);
  }

  const aHeap = heapAllocations(expected),
    bHeap = heapAllocations(actual);
  if (aHeap.length !== bHeap.length) {
    return {
      equal: false,
      diffs: [`expected ${aHeap.length} heap allocation(s), found ${bHeap.length}`],
      badIds: new Set(bHeap.map(a => a.id)),
    };
  }

  const result = bestHeapMapping(expected, actual, initial, aHeap, bHeap, config, gradedA.size);
  if (!result)
    return {
      equal: false,
      diffs: ['memory graphs cannot be matched'],
      badIds: new Set(actual.allocations.map(a => a.id)),
    };
  if (result.score === 0) return { equal: true, diffs: [], badIds: new Set() };
  return collectDiffs(expected, actual, result.map, config);
}

function bestHeapMapping(A, B, initial, aHeap, bHeap, config, mappedCount) {
  let best = null;
  const used = new Set();
  const map = new Map(initial);

  function search(i) {
    if (i === aHeap.length) {
      const score = scoreMapping(A, B, map, config, mappedCount);
      if (!best || score < best.score) best = { score, map: new Map(map) };
      return;
    }
    const a = aHeap[i];
    const candidates = bHeap.filter(
      b =>
        !used.has(b.id) &&
        typeEquals(a.type, b.type) &&
        (!config.compareLifetime || a.alive === b.alive),
    );
    for (const b of candidates) {
      map.set(a.id, b.id);
      used.add(b.id);
      // Partial pruning: already mapped pointers/values must not exceed current best.
      const partialScore = scoreMappedAllocations(A, B, map, config, true);
      if (!best || partialScore <= best.score) search(i + 1);
      map.delete(a.id);
      used.delete(b.id);
    }
  }

  search(0);
  return best;
}

function scoreMapping(A, B, map, config, mappedCount) {
  if (map.size !== mappedCount) return Number.POSITIVE_INFINITY;
  return scoreMappedAllocations(A, B, map, config, false);
}

function scoreMappedAllocations(A, B, map, config, partial) {
  let score = 0;
  for (const [aId, bId] of map.entries()) {
    const a = getAllocation(A, aId),
      b = getAllocation(B, bId);
    if (!typeEquals(a.type, b.type)) {
      score += 10;
      continue;
    }
    if (config.compareLifetime && a.alive !== b.alive) score += 5;
    if (config.compareStorage && a.storage.kind !== b.storage.kind) score += 5;

    const as = scalarSubobjects(a, A),
      bs = scalarSubobjects(b, B);
    if (as.length !== bs.length) {
      score += 10;
      continue;
    }
    for (let i = 0; i < as.length; i++) {
      if (!samePath(as[i].ref.path, bs[i].ref.path)) {
        score += 3;
        continue;
      }
      score += scalarMismatchScore(A, B, as[i], bs[i], map, config, partial);
    }
  }
  return score;
}

function scalarMismatchScore(A, B, a, b, map, config, partial) {
  if (!config.compareValues && !config.comparePointerRelationships) return 0;
  const av = a.value,
    bv = b.value;
  if (av.kind !== bv.kind) return 2;
  if (av.kind === 'scalar') return config.compareValues && av.value !== bv.value ? 1 : 0;
  if (av.kind !== 'pointer') return 0; // null/uninit
  if (!config.comparePointerRelationships) return 0;

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
      diffs.push(`${label} should have type ${typeToString(a.type)}`);
      badIds.add(b.id);
      continue;
    }
    if (config.compareLifetime && a.alive !== b.alive) {
      diffs.push(`${label} should be ${a.alive ? 'alive' : 'freed'}`);
      badIds.add(b.id);
    }

    const as = scalarSubobjects(a, A),
      bs = scalarSubobjects(b, B);
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      const av = as[i].value,
        bv = bs[i].value;
      const sublabel = subobjectLabel(A, a, as[i].ref.path);
      if (av.kind !== bv.kind) {
        diffs.push(`${sublabel} should hold ${describeValue(A, av)}`);
        badIds.add(b.id);
        continue;
      }
      if (av.kind === 'scalar' && config.compareValues && av.value !== bv.value) {
        diffs.push(`${sublabel} has value ${bv.value}; expected ${av.value}`);
        badIds.add(b.id);
        continue;
      }
      if (av.kind === 'pointer' && config.comparePointerRelationships) {
        const mappedTarget = map.get(av.target.allocationId);
        if (mappedTarget !== bv.target.allocationId || !samePath(av.target.path, bv.target.path)) {
          diffs.push(`${sublabel} should point to ${targetLabel(A, av.target)}`);
          badIds.add(b.id);
        }
      }
    }
  }

  return {
    equal: diffs.length === 0,
    diffs: diffs.length ? diffs : ['memory structure does not match'],
    badIds,
  };
}

function targetLabel(state, r) {
  try {
    return resolveRef(state, r).label;
  } catch {
    return `${r.allocationId}:${r.path.join('.')}`;
  }
}
/** Student-facing labels use display names ("heap 2"), never internal IDs ("a7"). */
function objectLabel(state, allocation) {
  return `'${allocationDisplayName(state, allocation)}'`;
}
function subobjectLabel(state, allocation, path) {
  let out = allocationDisplayName(state, allocation);
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : `.${p}`;
  return `'${out}'`;
}
function describeValue(state, v) {
  if (v.kind === 'scalar') return String(v.value);
  if (v.kind === 'null') return 'NULL';
  if (v.kind === 'uninit') return 'an uninitialized value';
  if (v.kind === 'pointer')
    return `a ${pointerStatus(state, v)} pointer to ${targetLabel(state, v.target)}`;
  return v.kind;
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
