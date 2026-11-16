/**
 * Diagram edits as lines added to the code that is already there.
 *
 * generate() writes a whole program from a memory state and so discards the source it
 * replaces. appendToCode() keeps the source: it runs it, compares the memory it ends with
 * against the diagram, and writes only the difference before main()'s final return. The
 * functions, loops and history of the original program stay, because that program still
 * produces them.
 *
 * Not every edit can be a new line (C cannot undeclare a variable), and some orders of
 * pointer changes would need a temporary. Those are refused with a reason, and the caller
 * falls back to generate(). Whatever is returned has been run and compared with the diagram.
 */
import {
  VOID,
  declarationToC,
  isArray,
  isBlock,
  isPointer,
  pointer,
  typeEquals,
} from '../language/types.js';
import { parseMiniC } from '../language/parser.js';
import {
  allocationDisplayName,
  gradedIds,
  makeDefaultValue,
  samePath,
  scalarSubobjects,
} from '../machine/memory.js';
import {
  allocationExpr,
  canAllocateThrough,
  initializerFor,
  lvalueForHeapSubobject,
  lvalueForStackSubobject,
  numberToC,
  pointerExpr,
} from './codegen.js';
import { equivalent } from './equivalence.js';
import { interpret } from './interpreter.js';

const refuse = reason => ({ reason });
const inMain = a => (a.storage.frameId ?? 'main') === 'main';
const sameValue = (a, b) =>
  a.kind === b.kind &&
  (a.kind === 'scalar'
    ? Object.is(a.value, b.value)
    : a.kind !== 'pointer' ||
      (a.target.allocationId === b.target.allocationId && samePath(a.target.path, b.target.path)));

/**
 * `code` with lines added so that it ends with the memory in `diagram`: returns
 * { code, added } (the 1-based numbers of the new lines), or { reason } when the edit
 * cannot be written that way.
 *
 * `synced` is a state with the diagram's allocation IDs that the code is known to end
 * with, such as the diagram as it was when it was last generated. It lets blocks be paired
 * when the IDs of a fresh run differ from the diagram's. Without it the IDs must agree, as
 * they do for a diagram edited from a run of this same code.
 */
export function appendToCode(code, diagram, synced = null) {
  let base, at;
  try {
    base = interpret(code).state;
    at = insertionPoint(code);
  } catch {
    return refuse('the code in the editor does not run to the end');
  }
  if (!at) return refuse("main()'s last statement shares its line with other code");

  const work = workingState(base, synced);
  if (!work) return refuse('the diagram did not come from this code');
  const wanted = gradedIds(diagram);
  const goal = { ...diagram, allocations: diagram.allocations.filter(a => wanted.has(a.id)) };
  const problem = unwritable(work, goal);
  if (problem) return refuse(problem);

  const lines = writeDifference(work, goal);
  if (!lines) return refuse('these pointer changes need a temporary variable to write in order');
  const result = splice(code, at, lines);
  try {
    if (!equivalent(diagram, interpret(result.code).state).equal)
      return refuse('the added lines would not rebuild this memory');
  } catch {
    return refuse('the added lines would not rebuild this memory');
  }
  return result;
}

/**
 * The memory the code ends with, limited to what a program can observe and renamed to the
 * diagram's allocation IDs. Null when the two cannot be paired.
 */
function workingState(base, synced) {
  let pairs = null;
  if (synced) {
    try {
      pairs = equivalent(base, synced).map ?? null;
    } catch {
      pairs = null;
    }
  }
  const rename = id => (pairs ? pairs.get(id) : id);
  const keep = gradedIds(base);
  const renamed = value => {
    if (value.kind === 'pointer')
      return {
        kind: 'pointer',
        target: { ...value.target, allocationId: rename(value.target.allocationId) },
      };
    if (value.elements) return { ...value, elements: value.elements.map(renamed) };
    if (value.fields)
      return {
        ...value,
        fields: Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, renamed(v)])),
      };
    return { ...value };
  };
  const allocations = base.allocations
    .filter(a => keep.has(a.id))
    .map(a => ({ ...structuredClone(a), id: rename(a.id), value: renamed(a.value) }));
  if (allocations.some(a => a.id === undefined)) return null;
  return { ...base, allocations };
}

/** Why `goal` cannot be reached from `work` by adding statements, or null when it may be. */
function unwritable(work, goal) {
  const wanted = new Map(goal.allocations.map(a => [a.id, a]));
  for (const a of work.allocations) {
    const g = wanted.get(a.id);
    const label = `'${allocationDisplayName(work, a)}'`;
    if (!g) return `removing ${label} cannot be written as a new line`;
    if (g.storage.kind !== a.storage.kind || !typeEquals(g.type, a.type))
      return `changing the type of ${label} cannot be written as a new line`;
    if (
      a.storage.kind === 'stack' &&
      (g.name !== a.name || g.storage.frameId !== a.storage.frameId)
    )
      return `renaming ${label} cannot be written as a new line`;
    if (a.storage.kind === 'heap' && !a.alive && g.alive)
      return `${label} is already freed, and a new line cannot take that back`;
    // Out-of-scope variables, literals and freed blocks can no longer be written to.
    const fixed = a.storage.kind !== 'heap' ? !a.alive || a.storage.kind === 'static' : !a.alive;
    if (a.storage.kind === 'stack' && a.alive !== g.alive)
      return `${label} cannot be put in or out of scope by a new line`;
    const before = scalarSubobjects(a, work),
      after = scalarSubobjects(g, goal);
    for (let i = 0; i < before.length; i++) {
      const same = sameValue(before[i].value, after[i].value);
      if (fixed && !same) return `${label} is out of scope or freed, so it cannot be changed`;
      if (!same && after[i].value.kind === 'uninit')
        return `${label} has a value, and a new line cannot make it uninitialized again`;
    }
  }
  const known = new Set(work.allocations.map(a => a.id));
  for (const g of goal.allocations) {
    if (known.has(g.id)) continue;
    if (g.storage.kind === 'static') return 'a new string literal cannot be added';
    if (g.storage.kind === 'stack' && !(g.alive && inMain(g)))
      return `'${g.name}' is not a variable of main()`;
  }
  return null;
}

/**
 * Where each live heap block of `work` can be reached from, as the expression for a
 * pointer to its start: p, head->next, or y - 1 for a pointer one element in. Found
 * breadth-first from main()'s variables, so the shortest expression wins.
 */
function anchors(work) {
  const byId = new Map(work.allocations.map(a => [a.id, a]));
  const found = new Map();
  const queue = work.allocations.filter(a => a.storage.kind === 'stack' && a.alive && inMain(a));
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    for (const s of scalarSubobjects(a, work)) {
      if (s.value.kind !== 'pointer') continue;
      const target = byId.get(s.value.target.allocationId);
      if (target?.storage.kind !== 'heap' || !target.alive || found.has(target.id)) continue;
      if (!canAllocateThrough(target, s.type)) continue;
      const offset = startOffset(target, s.value.target.path);
      if (offset === null) continue;
      const lhs = lvalue(a, s.ref.path, found, work);
      found.set(target.id, offset ? `${lhs} - ${offset}` : lhs);
      queue.push(target);
    }
  }
  return found;
}

/** How many elements past the block's start `path` is; null for a pointer into its inside. */
function startOffset(heap, path) {
  if (path.length === 0) return 0;
  if (path.length > 1) return null;
  if (path[0] === '$onePast') return 1;
  return isArray(heap.type) ? path[0] : null;
}

function lvalue(a, path, reach, state) {
  if (a.storage.kind === 'stack') return lvalueForStackSubobject(a, path);
  return reach.has(a.id) ? lvalueForHeapSubobject(a, path, reach.get(a.id), state) : null;
}

/**
 * The statements that take `work` to `goal`, or null when no order of them works. `work`
 * is updated as each statement is chosen, so every expression is checked against the
 * memory as it will be when that statement runs. One statement is chosen per round:
 *
 *  1. a declaration that can carry its whole value, or allocate what it points to;
 *  2. a value written into something that exists;
 *  3. a pointer assigned, unless that would cut off a block still to be written or freed;
 *  4. a declaration without a value (its parts follow in later rounds);
 *  5. a free.
 */
function writeDifference(work, goal) {
  const lines = [];
  const wanted = new Map(goal.allocations.map(a => [a.id, a]));
  const current = id => work.allocations.find(a => a.id === id);
  const valueAt = (a, path) => scalarSubobjects(a, work).find(s => samePath(s.ref.path, path));
  const set = (a, path, value) => {
    if (!path.length) a.value = structuredClone(value);
    else {
      let node = a.value;
      for (const part of path.slice(0, -1)) node = node.elements?.[part] ?? node.fields[part];
      (node.elements ?? node.fields)[path.at(-1)] = structuredClone(value);
    }
  };
  /** Every part of an existing object whose value is not yet the one wanted. */
  const pending = () =>
    goal.allocations.flatMap(g => {
      const a = current(g.id);
      if (!a || !a.alive || a.storage.kind === 'static') return [];
      return scalarSubobjects(g, goal)
        .filter(s => s.value.kind !== 'uninit' && !sameValue(valueAt(a, s.ref.path).value, s.value))
        .map(s => ({ a, path: s.ref.path, type: s.type, value: s.value }));
    });
  const toFree = () =>
    work.allocations.filter(a => a.storage.kind === 'heap' && a.alive && !wanted.get(a.id).alive);
  /** Blocks the remaining statements must still be able to reach. */
  const needed = (rest, frees) =>
    new Set([
      // What blocks and variables that do not exist yet will point to.
      ...goal.allocations
        .filter(g => !current(g.id))
        .flatMap(g => scalarSubobjects(g, goal))
        .filter(s => s.value.kind === 'pointer')
        .map(s => s.value.target.allocationId),
      ...rest.filter(p => p.a.storage.kind === 'heap').map(p => p.a.id),
      ...rest.filter(p => p.value.kind === 'pointer').map(p => p.value.target.allocationId),
      ...frees.map(a => a.id),
    ]);
  const context = reach => ({
    state: goal,
    heapAnchor: reach,
    declared: new Set(
      work.allocations
        .filter(a => a.storage.kind === 'stack' && a.alive && inMain(a))
        .map(a => a.id),
    ),
  });
  /** `malloc(...)` for a block that does not exist yet, if `type` can point at its start. */
  const allocation = (type, value) => {
    if (value.kind !== 'pointer') return null;
    const block = wanted.get(value.target.allocationId);
    if (block?.storage.kind !== 'heap' || current(block.id)) return null;
    if (!canAllocateThrough(block, type) || startOffset(block, value.target.path) !== 0)
      return null;
    const { text, zeroed } = allocationExpr(block, goal);
    return {
      text,
      create: () =>
        work.allocations.push({
          ...structuredClone(block),
          alive: true,
          value: zeroed
            ? structuredClone(block.value)
            : makeDefaultValue(block.type, goal.structTypes),
        }),
    };
  };
  const declare = (g, value, text) => {
    work.allocations.push({ ...structuredClone(g), value });
    lines.push(`${declarationToC(g.type, g.name)}${text === null ? '' : ` = ${text}`};`);
  };

  // The blocks the first assignment refused in a round would have cut off (see step).
  let cut = null;
  // Where the lines that use a temporary start; they are wrapped in a block at the end.
  let blockStart = null;
  /**
   * Keep `block` reachable through a pointer of its own. It is declared in an inner block,
   * so it is out of scope, and so not part of the memory, when main() ends.
   */
  const hold = (block, text) => {
    const taken = new Set([...work.allocations, ...goal.allocations].map(a => a.name));
    let name = 'tmp';
    for (let n = 2; taken.has(name); n++) name = `tmp${n}`;
    const type = pointer(
      isBlock(block.type) ? VOID : isArray(block.type) ? block.type.of : block.type,
    );
    blockStart ??= lines.length;
    lines.push(`${declarationToC(type, name)} = ${text};`);
    work.allocations.push({
      id: `$${name}`,
      name,
      type,
      storage: { kind: 'stack', frameId: 'main' },
      alive: true,
      value: {
        kind: 'pointer',
        target: { allocationId: block.id, path: isArray(block.type) ? [0] : [] },
      },
    });
  };
  /** Called when no statement can be written: a temporary may get things moving again. */
  const unstick = () => {
    if (cut?.length) {
      const reach = anchors(work);
      for (const id of cut) hold(current(id), reach.get(id));
      return true;
    }
    // A new block that no pointer of the right type points to the start of.
    const missing = goal.allocations.find(g => g.storage.kind === 'heap' && !current(g.id));
    if (!missing) return false;
    const { text, zeroed } = allocationExpr(missing, goal);
    work.allocations.push({
      ...structuredClone(missing),
      alive: true,
      value: zeroed
        ? structuredClone(missing.value)
        : makeDefaultValue(missing.type, goal.structTypes),
    });
    hold(current(missing.id), text);
    return true;
  };

  const step = () => {
    cut = null;
    const reach = anchors(work);
    const ctx = context(reach);
    const fresh = goal.allocations.filter(g => g.storage.kind === 'stack' && !current(g.id));
    for (const g of fresh) {
      const text = initializerFor(g.type, g.value, ctx);
      const made = text === null && isPointer(g.type) ? allocation(g.type, g.value) : null;
      if (text === null && !made) continue;
      made?.create();
      declare(g, structuredClone(g.value), text ?? made.text);
      return true;
    }
    const rest = pending(),
      frees = toFree();
    for (const p of rest.filter(p => !isPointer(p.type))) {
      const lhs = lvalue(p.a, p.path, reach, work);
      if (lhs === null) continue;
      set(p.a, p.path, p.value);
      lines.push(`${lhs} = ${numberToC(p.value.value, p.type)};`);
      return true;
    }
    for (const p of rest.filter(p => isPointer(p.type))) {
      const lhs = lvalue(p.a, p.path, reach, work);
      if (lhs === null) continue;
      const ready = pointerExpr(p.value, ctx);
      const made = ready === null ? allocation(p.type, p.value) : null;
      if (ready === null && !made) continue;
      const previous = valueAt(p.a, p.path).value;
      const count = work.allocations.length;
      // Overwriting a pointer may leave a block the later statements need with no way to
      // name it. If so, take the assignment back and try another first.
      const must = needed(
        rest.filter(q => q !== p),
        frees,
      );
      made?.create();
      set(p.a, p.path, p.value);
      const after = anchors(work);
      if ([...must].every(id => !reach.has(id) || after.has(id))) {
        lines.push(`${lhs} = ${ready ?? made.text};`);
        return true;
      }
      cut ??= [...must].filter(id => reach.has(id) && !after.has(id));
      set(p.a, p.path, previous);
      work.allocations.length = count;
    }
    if (fresh.length) {
      declare(fresh[0], makeDefaultValue(fresh[0].type, goal.structTypes), null);
      return true;
    }
    // Everything else is written; free a block whose going leaves the others reachable.
    if (rest.length) return false;
    for (const a of frees.filter(a => reach.has(a.id))) {
      a.alive = false;
      const after = anchors(work);
      if (frees.every(b => b === a || after.has(b.id))) {
        lines.push(`free(${reach.get(a.id)});`);
        return true;
      }
      a.alive = true;
    }
    return false;
  };

  // Each round writes one statement; the bound only guards against a logic error.
  for (let round = 0; round < 5000 && (step() || unstick()); round++);
  const done =
    goal.allocations.every(g => current(g.id) && current(g.id).alive === g.alive) &&
    !pending().length;
  if (!done) return null;
  if (blockStart === null) return lines;
  return [...lines.slice(0, blockStart), '{', ...lines.slice(blockStart).map(l => `    ${l}`), '}'];
}

/** Where new statements go: before main()'s final return, or its closing brace. */
function insertionPoint(code) {
  const main = parseMiniC(code).functions.find(f => f.name === 'main');
  const source = code.split('\n');
  const last = main.statements.at(-1);
  const returns = last?.kind === 'Return';
  const line = returns ? last.loc.startLine : main.loc.endLine;
  const before = source[line - 1].slice(
    0,
    (returns ? last.loc.startColumn : main.loc.endColumn - 1) - 1,
  );
  if (before.trim()) return null;
  // New lines are indented like the statement they follow.
  const indent = returns
    ? before
    : last
      ? source[last.loc.startLine - 1].match(/^\s*/)[0]
      : `${before}    `;
  return { index: line - 1, indent };
}

function splice(code, at, lines) {
  const source = code.split('\n');
  const headers = [
    [/\b(malloc|calloc|free|NULL)\b/, 'stdlib.h'],
    [/\b(true|false)\b/, 'stdbool.h'],
  ]
    .filter(
      ([uses, header]) =>
        lines.some(l => uses.test(l)) && !new RegExp(`#\\s*include\\s*<${header}>`).test(code),
    )
    .map(([, header]) => `#include <${header}>`);
  const lastInclude = source.findLastIndex(l => /^\s*#\s*include\b/.test(l));
  // With no include to follow, the new ones go first, with a blank line after them.
  const includeAt = lastInclude + 1;
  const includes = headers.length && lastInclude < 0 ? [...headers, ''] : headers;
  const body = lines.map(l => at.indent + l);
  source.splice(at.index, 0, ...body);
  source.splice(includeAt, 0, ...includes);
  return {
    code: source.join('\n'),
    added: [
      ...headers.map((_, i) => includeAt + i + 1),
      ...body.map((_, i) => at.index + includes.length + i + 1),
    ],
  };
}
