/**
 * Structure view: heap objects of a self-referential struct drawn in the shape their links
 * make, a chain for a list and a tree for a tree. Nothing here knows a struct by name: node
 * types, links and shapes all come from the program's own declarations and the pointers in
 * MemoryState at this step. Presentation only, like the rest of src/flow.
 */
import { isArray, isPointer, isStruct, resolveStructType } from '../language/types.js';
import {
  frameAllocations,
  heapAllocations,
  samePath,
  scalarSubobjects,
} from '../machine/memory.js';
import { describePointer, valueSummary } from './addressPresentation.js';

/** Compact card metrics; StructureNode in memoryFlow.jsx draws from the same numbers. */
export const NODE = {
  minWidth: 96,
  maxWidth: 320,
  // Tree nodes: slots in a row along the bottom.
  slotWidth: 60,
  slotRow: 30,
  // List nodes: slots in a column on the right, like a textbook [ 10 | â— ]â†’ box.
  sideSlot: 44,
  padX: 12,
  labelTop: 8,
  line: 22,
  // Band at the top of a card naming the stack variables that point at it.
  band: 20,
};
const GAP = { x: 28, chain: 48, y: 64, structure: 72 };
/** The call stack column: frames one under another, one line per scalar or pointer local. */
export const STACK = { width: 240, header: 34, row: 28, rowGap: 4, pad: 10, frameGap: 14 };
// Calls kept open at the top of the stack when recursion is folded.
const OPEN_CALLS = 2;

/**
 * The column's entries, oldest call first. The first call and the newest OPEN_CALLS stay
 * open; between them, two or more consecutive live calls of one function fold into a single
 * `{ folded: [frames] }` entry. Calls in `keepOpen` never fold. `unfold` shows every call.
 */
export function foldFrames(frames, unfold = false, keepOpen = new Set()) {
  if (unfold) return frames.map(frame => ({ frame }));
  return foldRuns(
    frames,
    (frame, i) =>
      i > 0 && i < frames.length - OPEN_CALLS && frame.active && !keepOpen.has(frame.id),
  );
}

/** Returned calls, oldest first: two or more consecutive ones of one function fold together. */
export function foldReturned(frames, unfold = false, keepOpen = new Set()) {
  if (unfold) return frames.map(frame => ({ frame }));
  return foldRuns(frames, frame => !keepOpen.has(frame.id));
}

function foldRuns(frames, foldable) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) out.push({ folded: run });
    else out.push(...run.map(frame => ({ frame })));
    run = [];
  };
  frames.forEach((frame, i) => {
    const can = foldable(frame, i);
    if (run.length && (!can || run[0].name !== frame.name)) flush();
    if (can) run.push(frame);
    else out.push({ frame });
  });
  flush();
  return out;
}

/**
 * Names for calls: `insert() #2` when a function has several frames, else `insert()`. `tag`
 * is the short form cursor labels use: `#2`, or the function's name when it has one frame.
 */
export function callLabels(frames) {
  const counts = new Map(),
    seen = new Map();
  for (const f of frames) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  return new Map(
    frames.map(f => {
      const n = (seen.get(f.name) ?? 0) + 1;
      seen.set(f.name, n);
      const many = counts.get(f.name) > 1;
      return [f.id, { label: `${f.name}()${many ? ` #${n}` : ''}`, tag: many ? `#${n}` : f.name }];
    }),
  );
}
// Fields shown on a card; the rest are counted and left to the inspector.
const MAX_FIELDS = 3;
// Links that lead back through a structure rather than on to a child or the next node.
const BACK_LINK = /parent|prev|pred|back/i;

const pointsToSelf = (type, name) => isPointer(type) && isStruct(type.to) && type.to.name === name;
const holdsSelfPointer = (type, name) =>
  pointsToSelf(type, name) || (isArray(type) && holdsSelfPointer(type.of, name));

/** Names of the structs with a member (or array of members) pointing to their own type. */
export function nodeTypeNames(structTypes = {}) {
  return Object.entries(structTypes)
    .filter(([name, def]) => def.fields?.some(f => holdsSelfPointer(f.type, name)))
    .map(([name]) => name);
}

const slotLabel = path => {
  const last = path.at(-1);
  return typeof last === 'number' ? `[${last}]` : String(last);
};

/** Pointer fields show where their arrow starts; other fields show their value. */
function fieldText(state, type, value, chars) {
  if (!isPointer(type)) return valueSummary(state, type, value, chars);
  const d = describePointer(state, value ?? { kind: 'uninit' });
  return d.status === 'null' ? 'NULL' : d.status === 'uninitialized' ? '?' : 'â—';
}

/** What a node card shows: its non-link fields as a label, and one slot per link. */
export function nodeCard(allocation, state, chars = 'number') {
  const name = allocation.type.name;
  const def = resolveStructType(allocation.type, state.structTypes);
  const slots = scalarSubobjects(allocation, state)
    .filter(s => pointsToSelf(s.type, name))
    .map(s => ({ path: s.ref.path, label: slotLabel(s.ref.path), type: s.type, value: s.value }));
  const others = (def.fields ?? []).filter(f => !holdsSelfPointer(f.type, name));
  const shown = others.length > MAX_FIELDS ? others.slice(0, MAX_FIELDS - 1) : others;
  const fields = shown.map(f => ({
    name: f.name,
    path: [f.name],
    pointer: isPointer(f.type),
    text: fieldText(state, f.type, allocation.value?.fields?.[f.name], chars),
  }));
  const more = others.length - shown.length;
  const lines = Math.max(1, fields.length + (more ? 1 : 0));
  const textWidth =
    fields.length === 1
      ? fields[0].text.length * 11
      : Math.max(0, ...fields.map(f => (f.name.length + f.text.length + 1) * 8));
  return shapeCard(
    { slots, fields, more, textWidth, labelHeight: NODE.labelTop * 2 + lines * NODE.line },
    { side: false, band: false },
  );
}

/**
 * A card's geometry. `side` puts the slots in a column on the right (lists) instead of a row
 * along the bottom (trees); `band` reserves the cursor band at the top.
 */
export function shapeCard(card, { side, band }) {
  const top = band ? NODE.band : 0;
  const label = Math.max(card.textWidth + NODE.padX * 2, side ? 56 : 0);
  const width = Math.min(
    NODE.maxWidth,
    side
      ? Math.max(NODE.minWidth, label + card.slots.length * NODE.sideSlot)
      : Math.max(NODE.minWidth, card.slots.length * NODE.slotWidth, label),
  );
  return {
    ...card,
    side,
    top,
    width,
    labelWidth: side ? width - card.slots.length * NODE.sideSlot : width,
    height: top + card.labelHeight + (!side && card.slots.length ? NODE.slotRow : 0),
  };
}

/** Where a slot's dot sits, in canvas coordinates. */
export function slotAnchor(box, card, index) {
  if (card.side)
    return {
      x: box.x + card.labelWidth + NODE.sideSlot * (index + 0.5),
      y: box.y + card.top + card.labelHeight / 2,
    };
  const width = box.width / card.slots.length;
  return {
    x: box.x + width * (index + 0.5),
    y: box.y + card.top + card.labelHeight + NODE.slotRow / 2,
  };
}

/**
 * Edge endpoint on a card. Targets of the whole node attach beside its label; sources are a
 * slot's dot or a shown pointer field. A pointer field the card does not show has no anchor.
 */
export function structureAnchor(box, card, path, side, role) {
  const x = side === 'right' ? box.x + box.width : box.x;
  const labelMiddle = { x, y: box.y + card.top + card.labelHeight / 2 };
  if (!path.length) return labelMiddle;
  const slot = card.slots.findIndex(s => samePath(s.path, path));
  if (slot >= 0) return slotAnchor(box, card, slot);
  const field = card.fields.findIndex(f => f.name === path[0]);
  if (field >= 0)
    return {
      x,
      y:
        box.y +
        card.top +
        (card.fields.length === 1
          ? card.labelHeight / 2
          : NODE.labelTop + field * NODE.line + NODE.line / 2),
    };
  return role === 'target' ? labelMiddle : null;
}

/**
 * The path of a link between two cards: down to a child's top, right to the next node's
 * side (straight when level), otherwise underneath and back up into the target. `from` is
 * the slot's dot; `targetY` is the middle of the target's label.
 */
export function linkRoute(from, source, target, targetY = target.y + target.height / 2) {
  const sourceBottom = source.y + source.height;
  const result = (path, bend) => ({
    path,
    bend,
    midpoint: bend,
  });
  if (source === target || (source.x === target.x && source.y === target.y)) {
    const end = { x: source.x + 14, y: sourceBottom },
      low = sourceBottom + 44;
    return result(
      `M ${from.x} ${sourceBottom} C ${from.x} ${low} ${end.x} ${low} ${end.x} ${end.y}`,
      { x: (from.x + end.x) / 2, y: low - 10 },
    );
  }
  if (target.y >= sourceBottom) {
    const end = { x: target.x + target.width / 2, y: target.y },
      reach = (end.y - sourceBottom) / 2;
    return result(
      `M ${from.x} ${sourceBottom} C ${from.x} ${sourceBottom + reach} ${end.x} ${end.y - reach} ${end.x} ${end.y}`,
      { x: (from.x + end.x) / 2, y: (sourceBottom + end.y) / 2 },
    );
  }
  if (target.x >= source.x + source.width) {
    // Leave from the card's edge level with the dot, so the arrow is all visible.
    const start = { x: source.x + source.width, y: from.y },
      end = { x: target.x, y: targetY },
      reach = Math.max(16, (end.x - start.x) / 3);
    const bend = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return result(
      start.y === end.y
        ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
        : `M ${start.x} ${start.y} C ${start.x + reach} ${start.y} ${end.x - reach} ${end.y} ${end.x} ${end.y}`,
      bend,
    );
  }
  const end = { x: target.x + target.width / 2, y: target.y + target.height },
    low = Math.max(sourceBottom, end.y) + 48;
  return result(
    `M ${from.x} ${sourceBottom} C ${from.x} ${low} ${end.x} ${low} ${end.x} ${end.y}`,
    { x: (from.x + end.x) / 2, y: low - 12 },
  );
}

/**
 * How a node type's links are followed. One forward link gives a chain. Two give a binary
 * tree, unless one only ever mirrors the other (a doubly linked list with unusual names).
 * More give a tree with that many children. Back links (parent, prev) are drawn, not followed.
 */
function shapeOf(nodes, links) {
  const paths = links.get(nodes[0].id).map(l => l.path);
  let forward = paths.filter(p => !BACK_LINK.test(String(p[0])));
  if (!forward.length) forward = paths;
  if (forward.length === 1) return { kind: 'chain', follow: forward };
  if (forward.length === 2) {
    const named = side => forward.findIndex(p => new RegExp(side, 'i').test(String(p[0])));
    const left = named('left'),
      right = named('right');
    if (left >= 0 && right >= 0 && left !== right)
      return { kind: 'binary', follow: [forward[left], forward[right]] };
    for (const [ahead, behind] of [forward, [...forward].reverse()]) {
      const steps = nodes.flatMap(a => {
        const to = links.get(a.id).find(l => samePath(l.path, ahead))?.to;
        return to ? [{ from: a.id, to }] : [];
      });
      const mirrored = steps.every(
        s => links.get(s.to).find(l => samePath(l.path, behind))?.to === s.from,
      );
      if (steps.length && mirrored) return { kind: 'chain', follow: [ahead] };
    }
    return { kind: 'binary', follow: forward };
  }
  return { kind: 'tree', follow: forward };
}

/**
 * Live heap objects that no pointer reaches any more: none from a live stack variable or
 * string literal, directly or through other live heap objects. They can never be freed.
 */
export function unreachableHeap(state) {
  // Once main has returned nothing is reachable, and that is not a leak worth pointing at.
  if (state.frames?.length && !state.frames.some(f => f.active)) return new Set();
  const reached = new Set();
  const byId = new Map(state.allocations.map(a => [a.id, a]));
  const queue = state.allocations.filter(a => a.alive && a.storage.kind !== 'heap');
  while (queue.length) {
    for (const s of scalarSubobjects(queue.pop(), state)) {
      if (s.value.kind !== 'pointer') continue;
      const id = s.value.target?.allocationId;
      const target = byId.get(id);
      if (target?.alive && target.storage.kind === 'heap' && !reached.has(id)) {
        reached.add(id);
        queue.push(target);
      }
    }
  }
  return new Set(
    heapAllocations(state).flatMap(a => (a.alive && !reached.has(a.id) ? [a.id] : [])),
  );
}

/**
 * For each step of a recorded run, the heap objects unreachable then and at every later step.
 * A single snapshot cannot tell a leak from a pointer still being handed back by a returning
 * function (return values are not in MemoryState), but the leak never becomes reachable again.
 */
export function leaksByStep(snapshots) {
  const out = new Array(snapshots.length);
  // Unreachable at every later step while the program runs. A block freed later drops out,
  // since freeing it needed a pointer; null until a running step has been seen.
  let later = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const { state } = snapshots[i];
    if (state.frames?.length && !state.frames.some(f => f.active)) {
      out[i] = new Set();
      continue;
    }
    const now = unreachableHeap(state);
    out[i] = later ? new Set([...now].filter(id => later.has(id))) : now;
    later = out[i];
  }
  return out;
}

/**
 * Cards and positions for every node-type heap object, one structure per row band from
 * `origin`. Structures start from nodes nothing else links to, earliest-referenced from the
 * stack first, so main's `head` or `root` leads; `unreachable` nodes come last, set apart.
 * `bottom` is where other heap objects go.
 */
export function layoutStructures(
  state,
  origin,
  chars = 'number',
  unreachable = new Set(),
  // Nodes a stack variable points at: every node of their type gets a cursor band, so the
  // cards keep one size while cursors move along a list.
  cursorTargets = new Set(),
) {
  const names = new Set(nodeTypeNames(state.structTypes));
  const nodes = heapAllocations(state).filter(a => isStruct(a.type) && names.has(a.type.name));
  const placed = new Map();
  if (!nodes.length) return { cards: placed, bottom: origin.y };
  const byId = new Map(nodes.map(a => [a.id, a]));
  const cards = new Map(nodes.map(a => [a.id, nodeCard(a, state, chars)]));
  const links = new Map(
    nodes.map(a => [
      a.id,
      cards.get(a.id).slots.map(s => ({
        path: s.path,
        to:
          s.value?.kind === 'pointer' &&
          s.value.target &&
          !s.value.target.path?.length &&
          byId.has(s.value.target.allocationId)
            ? s.value.target.allocationId
            : null,
      })),
    ]),
  );
  // The first stack variable (oldest frame first) that points at each node.
  const stackRank = new Map();
  const locals = (state.frames ?? []).flatMap(f => frameAllocations(state, f.id));
  for (const a of locals.filter(a => a.alive))
    for (const s of scalarSubobjects(a, state))
      if (s.value.kind === 'pointer' && byId.has(s.value.target?.allocationId))
        if (!stackRank.has(s.value.target.allocationId))
          stackRank.set(s.value.target.allocationId, stackRank.size);
  const linkedTo = new Set([...links.values()].flat().flatMap(l => (l.to ? [l.to] : [])));
  const order = (a, b) =>
    unreachable.has(a.id) - unreachable.has(b.id) ||
    (stackRank.get(a.id) ?? Infinity) - (stackRank.get(b.id) ?? Infinity) ||
    nodes.indexOf(a) - nodes.indexOf(b);
  const roots = [
    ...nodes.filter(a => !linkedTo.has(a.id)).sort(order),
    ...nodes.filter(a => linkedTo.has(a.id)).sort(order),
  ].sort((a, b) => unreachable.has(a.id) - unreachable.has(b.id));
  const shapes = new Map(
    [...names].flatMap(name => {
      const ofType = nodes.filter(a => a.type.name === name);
      return ofType.length ? [[name, shapeOf(ofType, links)]] : [];
    }),
  );
  const banded = new Set(nodes.filter(a => cursorTargets.has(a.id)).map(a => a.type.name));
  for (const a of nodes)
    cards.set(
      a.id,
      shapeCard(cards.get(a.id), {
        side: shapes.get(a.type.name).kind === 'chain',
        band: banded.has(a.type.name),
      }),
    );
  const next = (id, path) => {
    const to = links.get(id).find(l => samePath(l.path, path))?.to;
    return to && !placed.has(to) ? to : null;
  };
  const put = (id, x, y) => placed.set(id, { card: cards.get(id), x, y });
  let y = origin.y;
  for (const root of roots) {
    if (placed.has(root.id)) continue;
    const shape = shapes.get(root.type.name);
    let bottom = y;
    if (shape.kind === 'chain') {
      let x = origin.x;
      for (let id = root.id; id; id = next(id, shape.follow[0])) {
        put(id, x, y);
        x += cards.get(id).width + GAP.chain;
        bottom = Math.max(bottom, y + cards.get(id).height);
      }
    } else {
      // Claim the tree first so a node reachable twice is drawn once, under its first parent.
      const children = new Map(),
        depth = new Map([[root.id, 0]]),
        claimed = new Set([root.id]);
      const claim = id => {
        const kids = shape.follow.map(path => {
          const to = links.get(id).find(l => samePath(l.path, path))?.to;
          if (!to || claimed.has(to) || placed.has(to)) return null;
          claimed.add(to);
          depth.set(to, depth.get(id) + 1);
          return to;
        });
        children.set(id, kids);
        kids.forEach(kid => kid && claim(kid));
      };
      claim(root.id);
      const rowHeight = Math.max(...[...claimed].map(id => cards.get(id).height)) + GAP.y;
      const row = id => y + depth.get(id) * rowHeight;
      if (shape.kind === 'binary') {
        // In-order columns: a left child is always left of its parent, and a BST reads sorted.
        let x = origin.x;
        const visit = id => {
          if (!id) return;
          const [left, right] = children.get(id);
          visit(left);
          put(id, x, row(id));
          x += cards.get(id).width + GAP.x;
          visit(right);
        };
        visit(root.id);
      } else {
        const span = new Map();
        const measure = id => {
          const kids = children.get(id).filter(Boolean);
          const total =
            kids.reduce((sum, kid) => sum + measure(kid), 0) + GAP.x * (kids.length - 1);
          span.set(id, Math.max(cards.get(id).width, kids.length ? total : 0));
          return span.get(id);
        };
        const place = (id, left) => {
          const kids = children.get(id).filter(Boolean);
          const total =
            kids.reduce((sum, kid) => sum + span.get(kid), 0) + GAP.x * (kids.length - 1);
          let x = left + (span.get(id) - (kids.length ? total : 0)) / 2;
          for (const kid of kids) {
            place(kid, x);
            x += span.get(kid) + GAP.x;
          }
          put(id, left + span.get(id) / 2 - cards.get(id).width / 2, row(id));
        };
        measure(root.id);
        place(root.id, origin.x);
      }
      for (const id of claimed) bottom = Math.max(bottom, row(id) + cards.get(id).height);
    }
    y = bottom + GAP.structure;
  }
  return { cards: placed, bottom: y };
}
