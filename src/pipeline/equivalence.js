/**
 * Semantic grading over MemoryState graphs.
 *
 * Stack variables match by name by default; heap allocations are anonymous and
 * matched up to graph isomorphism. Freed allocations remain in the graph, so
 * alias provenance is part of the answer rather than being erased.
 */
import { typeEquals, typeToString } from '../language/types.js';
import {
  getAllocation, heapAllocations, pointerStatus, resolveRef, scalarSubobjects, stackAllocations,
} from '../machine/memory.js';
import { validate, ValidationError } from './codegen.js';

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
  try { validate(expected); }
  catch (e) { if (e instanceof ValidationError) throw new Error(`invalid target state: ${e.errors.join('; ')}`); throw e; }
  try { validate(actual); }
  catch (e) { if (e instanceof ValidationError) return { equal: false, diffs: e.errors, badIds: new Set(actual.allocations?.map(a => a.id) ?? []) }; throw e; }

  const initial = new Map();
  const diffs = [];
  const badIds = new Set();

  if (config.compareNames) {
    const actualByName = new Map(stackAllocations(actual).map(a => [stackKey(actual, a), a]));
    for (const a of stackAllocations(expected)) {
      const key = stackKey(expected, a);
      const b = actualByName.get(key);
      if (!b) { diffs.push(`missing ${stackLabel(expected, a)}`); continue; }
      actualByName.delete(key);
      initial.set(a.id, b.id);
      if (!typeEquals(a.type, b.type)) {
        diffs.push(`${stackLabel(expected, a)} should have type ${typeToString(a.type)}, found ${typeToString(b.type)}`);
        badIds.add(b.id);
      }
    }
    for (const extra of actualByName.values()) {
      diffs.push(`unexpected ${stackLabel(actual, extra)}`);
      badIds.add(extra.id);
    }
    if (diffs.length) return { equal: false, diffs, badIds };
  } else {
    const aStack = stackAllocations(expected), bStack = stackAllocations(actual);
    if (aStack.length !== bStack.length) {
      return { equal: false, diffs: [`expected ${aStack.length} stack variable(s), found ${bStack.length}`], badIds: new Set(bStack.map(a => a.id)) };
    }
    // Name-insensitive grading can be generalized later. For now pair by type/order.
    for (let i = 0; i < aStack.length; i++) initial.set(aStack[i].id, bStack[i].id);
  }

  const aHeap = heapAllocations(expected), bHeap = heapAllocations(actual);
  if (aHeap.length !== bHeap.length) {
    return {
      equal: false,
      diffs: [`expected ${aHeap.length} heap allocation(s), found ${bHeap.length}`],
      badIds: new Set(bHeap.map(a => a.id)),
    };
  }

  const result = bestHeapMapping(expected, actual, initial, aHeap, bHeap, config);
  if (!result) return { equal: false, diffs: ['memory graphs cannot be matched'], badIds: new Set(actual.allocations.map(a => a.id)) };
  if (result.score === 0) return { equal: true, diffs: [], badIds: new Set() };
  return collectDiffs(expected, actual, result.map, config);
}

function bestHeapMapping(A, B, initial, aHeap, bHeap, config) {
  let best = null;
  const used = new Set();
  const map = new Map(initial);

  function search(i) {
    if (i === aHeap.length) {
      const score = scoreMapping(A, B, map, config);
      if (!best || score < best.score) best = { score, map: new Map(map) };
      return;
    }
    const a = aHeap[i];
    const candidates = bHeap.filter(b => !used.has(b.id) && typeEquals(a.type, b.type) && (!config.compareLifetime || a.alive === b.alive));
    for (const b of candidates) {
      map.set(a.id, b.id); used.add(b.id);
      // Partial pruning: already mapped pointers/values must not exceed current best.
      const partialScore = scoreMappedAllocations(A, B, map, config, true);
      if (!best || partialScore <= best.score) search(i + 1);
      map.delete(a.id); used.delete(b.id);
    }
  }

  search(0);
  return best;
}

function scoreMapping(A, B, map, config) {
  if (map.size !== A.allocations.length) return Number.POSITIVE_INFINITY;
  return scoreMappedAllocations(A, B, map, config, false);
}

function scoreMappedAllocations(A, B, map, config, partial) {
  let score = 0;
  for (const [aId, bId] of map.entries()) {
    const a = getAllocation(A, aId), b = getAllocation(B, bId);
    if (!typeEquals(a.type, b.type)) { score += 10; continue; }
    if (config.compareLifetime && a.alive !== b.alive) score += 5;
    if (config.compareStorage && a.storage.kind !== b.storage.kind) score += 5;

    const as = scalarSubobjects(a, A), bs = scalarSubobjects(b, B);
    if (as.length !== bs.length) { score += 10; continue; }
    for (let i = 0; i < as.length; i++) {
      if (!samePath(as[i].ref.path, bs[i].ref.path)) { score += 3; continue; }
      score += scalarMismatchScore(A, B, as[i], bs[i], map, config, partial);
    }
  }
  return score;
}

function scalarMismatchScore(A, B, a, b, map, config, partial) {
  if (!config.compareValues && !config.comparePointerRelationships) return 0;
  const av = a.value, bv = b.value;
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
    const a = getAllocation(A, aId), b = getAllocation(B, bId);
    const label = a.name ? `'${a.name}'` : `heap allocation ${a.id}`;
    if (!typeEquals(a.type, b.type)) {
      diffs.push(`${label} should have type ${typeToString(a.type)}`);
      badIds.add(b.id); continue;
    }
    if (config.compareLifetime && a.alive !== b.alive) {
      diffs.push(`${label} should be ${a.alive ? 'alive' : 'freed'}`);
      badIds.add(b.id);
    }

    const as = scalarSubobjects(a, A), bs = scalarSubobjects(b, B);
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      const av = as[i].value, bv = bs[i].value;
      const sublabel = subobjectLabel(a, as[i].ref.path);
      if (av.kind !== bv.kind) {
        diffs.push(`${sublabel} should hold ${describeValue(A, av)}`);
        badIds.add(b.id); continue;
      }
      if (av.kind === 'scalar' && config.compareValues && av.value !== bv.value) {
        diffs.push(`${sublabel} has value ${bv.value}; expected ${av.value}`);
        badIds.add(b.id); continue;
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

  return { equal: diffs.length === 0, diffs: diffs.length ? diffs : ['memory structure does not match'], badIds };
}

function targetLabel(state, r) {
  try { return resolveRef(state, r).label; } catch { return `${r.allocationId}:${r.path.join('.')}`; }
}
function subobjectLabel(allocation, path) {
  let out = allocation.name ? `'${allocation.name}'` : `heap ${allocation.id}`;
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : `.${p}`;
  return out;
}
function describeValue(state, v) {
  if (v.kind === 'scalar') return String(v.value);
  if (v.kind === 'null') return 'NULL';
  if (v.kind === 'uninit') return 'an uninitialized value';
  if (v.kind === 'pointer') return `a ${pointerStatus(state, v)} pointer to ${targetLabel(state, v.target)}`;
  return v.kind;
}
function samePath(a = [], b = []) { return a.length === b.length && a.every((x, i) => x === b[i]); }


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
function stackKey(state, allocation) { return `${frameKey(state, allocation.storage.frameId)}:${allocation.name}`; }
function stackLabel(state, allocation) {
  const frame = state.frames?.find(f => f.id === allocation.storage.frameId);
  return frame && frame.id !== 'main' ? `'${allocation.name}' in ${frame.name}()` : `variable '${allocation.name}'`;
}
