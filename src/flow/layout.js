/** Pure MemoryState → canvas layout. Coordinates never enter MemoryState. */
import { isArray, isPointer, isStruct, typeToString } from '../language/types.js';
import { referenceLocation } from '../machine/addresses.js';
import {
  allocationDisplayName,
  frameAllocations,
  heapAllocations,
  pointerEdges,
  resolveRef,
  scalarSubobjects,
  staticAllocations,
} from '../machine/memory.js';
import { toJSON } from '../data/json.js';
import { describePointer } from './addressPresentation.js';
import { curvePointer } from './routing.js';
import {
  STACK,
  callLabels,
  foldFrames,
  foldReturned,
  layoutStructures,
  linkRoute,
  structureAnchor,
  unreachableHeap,
} from './structureLayout.js';

/** Row/box metrics; memoryMetricsStyle mirrors them into CSS custom properties. */
export const GEOMETRY = {
  // Name and type, then a quiet "address · size" line.
  header: 44,
  row: 32,
  pointerStatus: 20,
  // Bottom padding under the last row, including the 1px borders.
  footer: 8,
  lifetime: 24,
  padding: 24,
  top: 52,
  gap: 24,
};
/** Smallest frame a user can resize to, shared with workspace operations. */
export const FRAME_MIN = { width: 240, height: 160 };
/**
 * Metrics for each box density (DENSITY_MODES in viewPreference.js). Compact drops the
 * "address · size" line and pointer captions, and a scalar is a single name-type-value line.
 */
export const DENSITY = {
  full: { geometry: GEOMETRY, frameMin: FRAME_MIN, reserve: 340 },
  compact: {
    geometry: {
      header: 26,
      row: 26,
      pointerStatus: 0,
      footer: 2,
      lifetime: 18,
      padding: 12,
      top: 42,
      gap: 8,
    },
    frameMin: { width: 180, height: 80 },
    reserve: 240,
  },
};
export const densityMetrics = density => DENSITY[density] ?? DENSITY.full;
// Space between the stack column and the heap column.
const FRAME_SPACING = 64;
// The free layout's call stack: where it starts and the space between calls. Each density
// also keeps the column a width (`reserve`), so heap boxes start at the same x however wide
// the frames there are now.
const STACK_COLUMN = { x: 30, y: 72, gap: 32 };
// Space between the live stack and the shelf of returned calls under it.
const SHELF_GAP = 72;
// Structure view: space between the call stack column and the heap region beside it, and
// how wide a row of other heap objects grows before wrapping.
const HEAP_REGION_GAP = 96;
const HEAP_ROW_WIDTH = 1100;
// SVG markers need literal colours; keep these in sync with --err, --heap and --ptr in styles.css.
const EDGE_COLORS = { dangling: '#f85149', changed: '#e3b341', normal: '#58a6ff' };
export const memoryMetricsStyle = Object.fromEntries(
  Object.entries(DENSITY).map(([density, { geometry }]) => [
    density,
    Object.fromEntries(
      Object.entries(geometry).map(([key, value]) => [`--memory-${key}`, `${value}px`]),
    ),
  ]),
);
export function allocationMetrics(a, state, density = 'full') {
  const g = densityMetrics(density).geometry;
  const aggregate = isArray(a.type) || isStruct(a.type);
  // A compact scalar has no header: its one row carries the name and type.
  const oneLine = density === 'compact' && !aggregate;
  let top = (oneLine ? 0 : g.header) + (a.alive ? 0 : g.lifetime);
  const rows = scalarSubobjects(a, state).map(s => {
    const height = g.row + (isPointer(s.type) ? g.pointerStatus : 0);
    const row = { ...s, top, height };
    top += height;
    return row;
  });
  return { aggregate, oneLine, rows, height: top + g.footer };
}
const locationKey = (state, scalar) => {
  try {
    return `${referenceLocation(state, scalar.ref).address}:${isPointer(scalar.type) ? describePointer(state, scalar.value).address : ''}`;
  } catch {
    return 'invalid';
  }
};
export const handleId = (kind, path = [], side = 'left') =>
  `${kind}:${path.length ? path.join('.') : 'root'}:${side}`;
export function pathFromHandle(id) {
  const raw = id?.split(':')[1];
  return !raw || raw === 'root' ? [] : raw.split('.').map(x => (/^\d+$/.test(x) ? Number(x) : x));
}

/**
 * Compact boxes in one frame, or in the heap column, share their columns like a table: the
 * name and type columns are as wide (in characters) as the longest there, capped so one long
 * declaration cannot stretch the rest; longer text ends in an ellipsis.
 */
const COMPACT_COLUMNS = { name: [3, 12], type: [3, 14] };
export function compactColumns(allocations, state) {
  const longest = (length, [min, cap]) => Math.min(cap, Math.max(min, ...allocations.map(length)));
  return {
    name: longest(a => allocationDisplayName(state, a).length, COMPACT_COLUMNS.name),
    type: longest(a => typeToString(a.type).length, COMPACT_COLUMNS.type),
  };
}
// The columns are drawn in `ch`, so they line up in any monospace font; the box is sized for
// the widest common one (0.6em) at the name (12px), type (11px) and value (12px) sizes, with
// side padding and the gaps between columns. The value slot is 11ch, enough for INT_MIN.
const compactWidth = ({ name, type }) =>
  Math.ceil(8 + name * 7.2 + 8 + type * 6.6 + 8 + (11 * 7.2 + 14) + 8);

function allocationSize(a, state, density = 'full', columns = null) {
  const height = allocationMetrics(a, state, density).height;
  if (density === 'compact')
    return { width: compactWidth(columns ?? compactColumns([a], state)), height };
  const text = allocationDisplayName(state, a).length + typeToString(a.type).length;
  // Aggregate rows also show a per-element address column.
  const aggregate = isArray(a.type) || isStruct(a.type);
  return { width: Math.min(440, Math.max(aggregate ? 260 : 200, text * 8 + 40)), height };
}

/**
 * With `structure`, heap nodes of self-referential structs are drawn as lists and trees
 * (structureLayout.js) and every position is computed afresh: remembered positions, sizes
 * and bends are ignored, and nothing can be dragged.
 */
export function stateToFlow(state, options = {}) {
  return options.structure
    ? layoutFlow(state, { ...options, positions: {}, sizes: {}, routes: {} })
    : layoutFlow(state, options);
}

function layoutFlow(
  state,
  {
    positions = {},
    sizes: frameSizes = {},
    routes = {},
    editable = false,
    badIds = new Set(),
    showExpired = false,
    previousState = null,
    structure = false,
    chars = 'number',
    unfold = false,
    // Heap objects to mark unreachable; playback passes leaksByStep's, which looks ahead.
    unreachable: knownUnreachable = null,
    density = 'full',
  } = {},
) {
  const { geometry: g, frameMin, reserve } = densityMetrics(density);
  const nodes = [];
  const oldAllocations = new Map(previousState?.allocations.map(a => [a.id, a]) ?? []);
  const semanticEdges = pointerEdges(state);
  const changes = a => {
    const old = oldAllocations.get(a.id);
    const changedPaths = new Set();
    if (previousState) {
      const oldRows = new Map(
        old ? scalarSubobjects(old, previousState).map(s => [JSON.stringify(s.ref.path), s]) : [],
      );
      for (const s of scalarSubobjects(a, state)) {
        const key = JSON.stringify(s.ref.path);
        const prior = oldRows.get(key);
        if (
          toJSON(prior?.value) !== toJSON(s.value) ||
          (prior && locationKey(previousState, prior) !== locationKey(state, s))
        )
          changedPaths.add(key);
      }
    }
    return {
      changed: !!previousState && (!old || old.alive !== a.alive || changedPaths.size > 0),
      changedPaths,
      sourceSides: {},
      targetPaths: new Set(
        semanticEdges
          .filter(e => e.target?.allocationId === a.id)
          .map(e => JSON.stringify(e.target.path)),
      ),
    };
  };
  const frames = state.frames?.length
    ? state.frames
    : state.allocations.some(a => a.storage.kind === 'stack')
      ? [{ id: 'main', name: 'main', depth: 0, active: true }]
      : [];
  const labels = callLabels(frames);
  const foldNode = (folded, position, names, returned = false) => ({
    id: `fold:${folded[0].id}`,
    type: 'frameFold',
    position,
    width: STACK.width,
    height: STACK.header,
    style: { width: STACK.width, height: STACK.header },
    draggable: false,
    selectable: false,
    deletable: false,
    zIndex: 0,
    data: { name: folded[0].name, calls: folded.map(f => names.get(f.id).label), returned },
  });
  // Free layout: live calls form a column, each opening under the one above it, so the next
  // call at a depth takes the space a returned one left. Frames are placed afresh each step
  // (captureLayout does not remember them); one the user dragged or resized stays put. Heap
  // boxes have their own column to the right and never push frames aside.
  const allocationById = new Map(state.allocations.map(a => [a.id, a]));
  const frameOf = id => {
    const a = allocationById.get(id);
    return a?.storage.kind === 'stack' ? a.storage.frameId : null;
  };
  // Calls holding something a pointer elsewhere targets stay unfolded, so no arrow loses its end.
  const keepOpen = new Set(
    semanticEdges.flatMap(e => {
      const target = frameOf(e.target?.allocationId);
      return target && target !== frameOf(e.source.allocationId) ? [target] : [];
    }),
  );
  // Frames, fold rows and (for the shelf) heap boxes already on the canvas this step.
  const placedFrames = [];
  const placeAt = (start, size) => {
    let position = start;
    for (let b; (b = placedFrames.find(r => overlapping(position, size.width, size.height, r)));)
      position = { ...position, y: b.y + b.height + STACK_COLUMN.gap };
    placedFrames.push({ ...position, ...size });
    return position;
  };
  const below = above =>
    above
      ? { x: above.x, y: above.y + above.height + STACK_COLUMN.gap }
      : { x: STACK_COLUMN.x, y: STACK_COLUMN.y };
  // Structure view stacks the frames in its own column instead (stackColumn below).
  const column = structure
    ? []
    : foldFrames(
        frames.filter(f => f.active),
        unfold,
        keepOpen,
      );
  const columnBoxes = new Map(
    column.flatMap(e => (e.frame ? [[e.frame.id, frameBox(e.frame)]] : [])),
  );
  for (const box of columnBoxes.values())
    if (positions[box.id]) placedFrames.push({ ...positions[box.id], ...box.size });
  let above = null,
    columnWidth = 0;
  for (const entry of column) {
    if (entry.folded) {
      const position = placeAt(below(above), { width: STACK.width, height: STACK.header });
      nodes.push(foldNode(entry.folded, position, labels));
      above = { ...position, height: STACK.header };
      continue;
    }
    const box = columnBoxes.get(entry.frame.id);
    const position = positions[box.id] ?? placeAt(below(above), box.size);
    pushFrame(entry.frame, box, position);
    above = { ...position, height: box.size.height };
    columnWidth = Math.max(columnWidth, box.size.width);
  }
  const heapX = STACK_COLUMN.x + Math.max(reserve, columnWidth) + FRAME_SPACING;

  function frameBox(frame) {
    const allocations = frameAllocations(state, frame.id).filter(a => a.alive || showExpired);
    const columns = density === 'compact' ? compactColumns(allocations, state) : null;
    const sizes = allocations.map(a => allocationSize(a, state, density, columns));
    const id = `frame:${frame.id}`;
    let y = g.top;
    // New objects occupy unused space; remembered positions are never reflowed.
    const occupied = allocations.flatMap((a, i) =>
      positions[a.id] ? [{ ...positions[a.id], ...sizes[i] }] : [],
    );
    const locals = allocations.map((a, i) => {
      let p = positions[a.id];
      if (!p) {
        p = { x: g.padding, y };
        while (
          occupied.some(
            r =>
              p.x < r.x + r.width + g.gap &&
              p.x + sizes[i].width + g.gap > r.x &&
              p.y < r.y + r.height + g.gap &&
              p.y + sizes[i].height + g.gap > r.y,
          )
        )
          p = { ...p, y: p.y + g.gap };
      }
      p = { x: Math.max(g.padding, p.x), y: Math.max(g.top, p.y) };
      occupied.push({ ...p, ...sizes[i] });
      y = p.y + sizes[i].height + g.gap;
      return p;
    });
    // Frames hug their contents unless the user has resized them.
    const width = Math.max(
      frameSizes[id]?.width ?? 0,
      frameMin.width,
      ...sizes.map((s, i) => locals[i].x + s.width + g.padding),
    );
    const height = Math.max(
      frameSizes[id]?.height ?? 0,
      frameMin.height,
      ...sizes.map((s, i) => locals[i].y + s.height + g.padding),
    );
    return { id, allocations, columns, sizes, locals, size: { width, height } };
  }
  function pushFrame(frame, { id, allocations, columns, sizes, locals, size }, position) {
    const { width, height } = size;
    nodes.push({
      id,
      type: 'frameGroup',
      position,
      data: { frame, editable: editable && frame.active },
      // Returned calls sit on the shelf, which is laid out afresh every step.
      draggable: frame.active,
      dragHandle: '.frame-group-label',
      selectable: true,
      deletable: false,
      zIndex: 0,
      width,
      height,
      style: { width, height },
      className: `frame-group${frame.active ? '' : ' returned'}${previousState && !previousState.frames?.some(f => f.id === frame.id && f.active === frame.active) ? ' memory-changed' : ''}`,
      ariaLabel: `${frame.name}() ${frame.active ? 'active' : 'returned'} call frame`,
    });
    allocations.forEach((a, i) => {
      const size = sizes[i];
      nodes.push({
        id: a.id,
        type: 'memoryAllocation',
        parentId: id,
        expandParent: false,
        position: locals[i],
        // Position is presentation only, so expired objects move too; their contents stay read-only.
        draggable: true,
        selectable: true,
        deletable: editable && frame.active && a.alive,
        zIndex: 2,
        ...size,
        style: size,
        data: {
          allocation: a,
          state,
          ...changes(a),
          editable: editable && frame.active && a.alive,
          bad: badIds.has(a.id),
          columns,
        },
      });
    });
  }
  let heapY = 124;
  // String literals share the free-standing column below the heap and are never editable.
  const heap = [...heapAllocations(state), ...staticAllocations(state)];
  // The free layout's heap column shares one set of compact columns; Structure view's other
  // heap boxes sit in rows, each sized to itself (no `columns`: MemoryAllocationNode then
  // measures the box alone, as allocationSize does).
  const heapColumns = density === 'compact' && !structure ? compactColumns(heap, state) : null;
  const occupiedHeap = heap.flatMap(a =>
    positions[a.id]
      ? [{ ...positions[a.id], ...allocationSize(a, state, density, heapColumns) }]
      : [],
  );
  // Structure view: the call stack as a column, then one heap region beside it, lists and
  // trees first, with nodes no pointer reaches set apart at the end.
  const columnRight = structure ? stackColumn() : 0;
  const region = { x: columnRight ? columnRight + HEAP_REGION_GAP : 30, y: 72 };
  const unreachable = structure ? (knownUnreachable ?? unreachableHeap(state)) : new Set();
  // Objects a shown stack variable holds the address of: list and tree nodes among them get
  // a cursor band on their card.
  const cursorTargets = new Set(
    nodes
      .filter(n => structure && n.parentId && n.data.allocation?.storage.kind === 'stack')
      .flatMap(n =>
        scalarSubobjects(n.data.allocation, state).flatMap(s =>
          s.value.kind === 'pointer' && s.value.target && !s.value.target.path?.length
            ? [s.value.target.allocationId]
            : [],
        ),
      ),
  );
  const structures = structure
    ? layoutStructures(state, region, chars, unreachable, cursorTargets)
    : { cards: new Map(), bottom: region.y };
  function stackColumn() {
    const visible = frames.filter(f => f.active || showExpired);
    const labels = callLabels(visible);
    const top = visible.filter(f => f.active).at(-1);
    // With one frame on screen, a cursor's frame goes without saying.
    const tagged = visible.length > 1;
    let y = 72,
      right = 0;
    for (const entry of foldFrames(visible, unfold)) {
      if (entry.folded) {
        nodes.push(foldNode(entry.folded, { x: 30, y }, labels));
        y += STACK.header + STACK.frameGap;
        right = Math.max(right, 30 + STACK.width);
        continue;
      }
      const { frame } = entry;
      const id = `frame:${frame.id}`;
      const allocations = frameAllocations(state, frame.id).filter(a => a.alive || showExpired);
      let localY = STACK.header + STACK.pad / 2;
      const placed = allocations.map(a => {
        const compact = isPointer(a.type) || !(isArray(a.type) || isStruct(a.type));
        const size = compact
          ? { width: STACK.width - STACK.pad * 2, height: STACK.row }
          : allocationSize(a, state, density);
        const position = { x: STACK.pad, y: localY };
        localY += size.height + STACK.rowGap;
        return { a, compact, size, position };
      });
      const width = Math.max(STACK.width, ...placed.map(p => p.size.width + STACK.pad * 2));
      const height = Math.max(STACK.header + STACK.pad, localY - STACK.rowGap + STACK.pad);
      nodes.push({
        id,
        type: 'frameGroup',
        position: { x: 30, y },
        data: {
          frame,
          editable: false,
          callLabel: labels.get(frame.id).label,
          running: frame === top,
        },
        draggable: false,
        selectable: false,
        deletable: false,
        zIndex: 0,
        width,
        height,
        style: { width, height },
        className: `frame-group compact${frame.active ? '' : ' returned'}${frame === top ? ' running' : ''}${previousState && !previousState.frames?.some(f => f.id === frame.id && f.active === frame.active) ? ' memory-changed' : ''}`,
        ariaLabel: `${labels.get(frame.id).label} ${frame.active ? 'active' : 'returned'} call frame`,
      });
      for (const { a, compact, size, position } of placed)
        nodes.push({
          id: a.id,
          type: compact ? 'stackLocal' : 'memoryAllocation',
          parentId: id,
          expandParent: false,
          position,
          draggable: false,
          selectable: true,
          deletable: false,
          zIndex: 2,
          ...size,
          style: size,
          data: {
            allocation: a,
            state,
            ...changes(a),
            editable: false,
            bad: badIds.has(a.id),
            cursorTag: tagged ? labels.get(frame.id).tag : null,
          },
        });
      y += height + STACK.frameGap;
      right = Math.max(right, 30 + width);
    }
    return right;
  }
  for (const [id, { card, x, y }] of structures.cards) {
    const a = state.allocations.find(x => x.id === id);
    nodes.push({
      id,
      type: 'structureNode',
      position: { x, y },
      width: card.width,
      height: card.height,
      style: { width: card.width, height: card.height },
      zIndex: 2,
      draggable: false,
      selectable: true,
      deletable: false,
      data: {
        allocation: a,
        state,
        card,
        ...changes(a),
        editable: false,
        bad: badIds.has(id),
        unreachable: unreachable.has(id),
        cursors: [],
      },
    });
  }
  let row = { x: region.x, y: structures.bottom, height: 0 };
  for (const a of heap) {
    if (structures.cards.has(a.id)) continue;
    const readOnly = a.storage.kind === 'static';
    const columns = heapColumns;
    const size = allocationSize(a, state, density, columns);
    let position = positions[a.id];
    if (structure) {
      if (row.x > region.x && row.x + size.width > region.x + HEAP_ROW_WIDTH)
        row = { x: region.x, y: row.y + row.height + g.gap, height: 0 };
      position = { x: row.x, y: row.y };
      row = {
        ...row,
        x: row.x + size.width + g.gap,
        height: Math.max(row.height, size.height),
      };
    } else if (!position) {
      position = { x: heapX, y: heapY };
      while (
        occupiedHeap.some(
          r =>
            position.x < r.x + r.width + g.gap &&
            position.x + size.width + g.gap > r.x &&
            position.y < r.y + r.height + g.gap &&
            position.y + size.height + g.gap > r.y,
        )
      )
        position = { ...position, y: position.y + g.gap };
    }
    occupiedHeap.push({ ...position, ...size });
    nodes.push({
      id: a.id,
      type: 'memoryAllocation',
      position,
      ...size,
      style: size,
      zIndex: 2,
      draggable: !structure,
      selectable: true,
      // A freed block can still be deleted from an editable diagram.
      deletable: editable && !readOnly,
      data: {
        allocation: a,
        state,
        ...changes(a),
        editable: editable && a.alive && !readOnly,
        bad: badIds.has(a.id),
        columns,
      },
    });
    heapY += size.height + g.gap;
  }
  // Returned calls, when shown, sit on a shelf under the live stack. It is placed afresh every
  // step, so showing or hiding it never moves the live layout, and keeps clear of heap boxes.
  if (!structure && showExpired) {
    const shelf = foldReturned(
      frames.filter(f => !f.active),
      unfold,
      keepOpen,
    );
    let start = {
      x: STACK_COLUMN.x,
      y: Math.max(STACK_COLUMN.y, ...placedFrames.map(r => r.y + r.height)) + SHELF_GAP,
    };
    placedFrames.push(...occupiedHeap);
    for (const entry of shelf) {
      if (entry.folded) {
        const position = placeAt(start, { width: STACK.width, height: STACK.header });
        nodes.push(foldNode(entry.folded, position, labels, true));
        start = below({ ...position, height: STACK.header });
        continue;
      }
      const box = frameBox(entry.frame);
      const position = placeAt(start, box.size);
      pushFrame(entry.frame, box, position);
      start = below({ ...position, height: box.size.height });
    }
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const boxes = new Map(
    nodes
      .filter(n => ['memoryAllocation', 'structureNode', 'stackLocal'].includes(n.type))
      .map(n => {
        const parent = byId.get(n.parentId)?.position ?? { x: 0, y: 0 };
        return [n.id, { x: n.position.x + parent.x, y: n.position.y + parent.y, ...n.style }];
      }),
  );
  const obstacles = [
    ...boxes.values(),
    ...nodes
      .filter(n => n.type === 'frameGroup')
      .map(n => ({ ...n.position, width: n.style.width, height: 34 })),
  ];
  function anchor(r, side, role) {
    const box = boxes.get(r.allocationId),
      node = byId.get(r.allocationId);
    if (!box) return null;
    if (node.type === 'structureNode')
      return structureAnchor(box, node.data.card, r.path, side, role);
    // A one-line stack variable: arrows leave and arrive at the middle of its side.
    if (node.type === 'stackLocal')
      return { x: box.x + (side === 'right' ? box.width : 0), y: box.y + box.height / 2 };
    const rows = allocationMetrics(node.data.allocation, state, density).rows;
    let row = rows.findIndex(s => JSON.stringify(s.ref.path) === JSON.stringify(r.path));
    if (row < 0 && r.path.length) {
      const resolved = resolveRef(state, r);
      if (!resolved.invalid && !resolved.onePast)
        row = rows.findIndex(s => r.path.every((part, i) => s.ref.path[i] === part));
    }
    // Aggregate roots attach to the header; one-past references have no target row.
    if (row < 0 && r.path.length) return null;
    return {
      x: box.x + (side === 'right' ? box.width : 0),
      y: box.y + 1 + (row < 0 ? g.header / 2 : rows[row].top + g.row / 2),
    };
  }
  const edges = [];
  for (const e of semanticEdges) {
    if (e.status === 'invalid' || e.status === 'one-past') continue;
    if (!boxes.has(e.source.allocationId) || !boxes.has(e.target.allocationId)) continue;
    const sourceBox = boxes.get(e.source.allocationId),
      targetBox = boxes.get(e.target.allocationId);
    const self = e.source.allocationId === e.target.allocationId;
    // Boxes one above the other (a call under its caller, or a column of heap boxes) link
    // along their right sides, toward the heap, instead of looping around to a far side.
    const stacked =
      self ||
      (targetBox.x < sourceBox.x + sourceBox.width && sourceBox.x < targetBox.x + targetBox.width);
    const sourceSide =
      stacked || targetBox.x + targetBox.width / 2 >= sourceBox.x + sourceBox.width / 2
        ? 'right'
        : 'left';
    const side = stacked ? 'right' : sourceSide === 'right' ? 'left' : 'right';
    const source = anchor(e.source, sourceSide, 'source');
    if (!source) continue;
    const target = anchor(e.target, side, 'target');
    if (!target) continue;
    byId.get(e.source.allocationId).data.sourceSides[JSON.stringify(e.source.path)] = sourceSide;
    const id = `${e.source.allocationId}:${e.source.path.join('.')}->${e.target.allocationId}:${e.target.path.join('.')}`;
    // A stack variable holding a whole node is a cursor: a label on that node, not an arrow.
    const sourceNode = byId.get(e.source.allocationId),
      targetNode = byId.get(e.target.allocationId);
    if (
      structure &&
      sourceNode.data.allocation.storage.kind === 'stack' &&
      targetNode.type === 'structureNode' &&
      !e.target.path.length
    ) {
      targetNode.data.cursors.push({
        id,
        sourceId: e.source.allocationId,
        name: `${allocationDisplayName(state, sourceNode.data.allocation)}${e.source.path.map(p => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')}`,
        tag: sourceNode.data.cursorTag,
        running: byId.get(sourceNode.parentId)?.data.running ?? false,
        dangling: e.status === 'dangling',
        changed: sourceNode.data.changedPaths.has(JSON.stringify(e.source.path)),
      });
      // The variable's own line names the node the way the node's card reads.
      const { card } = targetNode.data;
      if (!e.source.path.length)
        sourceNode.data.cursorText =
          card.fields.length === 1
            ? card.fields[0].text
            : allocationDisplayName(state, targetNode.data.allocation);
      // The arrow it stands for, shown only while the variable or its label is hovered.
      const color = e.status === 'dangling' ? EDGE_COLORS.dangling : EDGE_COLORS.normal;
      edges.push({
        id: `cursor:${id}`,
        source: e.source.allocationId,
        sourceHandle: handleId('src', e.source.path, sourceSide),
        target: e.target.allocationId,
        targetHandle: handleId('tgt', e.target.path, side),
        type: 'memoryPointer',
        data: {
          ...curvePointer(source, target, sourceSide, side, obstacles, undefined, false),
          cursorFor: e.source.allocationId,
        },
        hidden: true,
        zIndex: 2,
        selectable: false,
        focusable: false,
        reconnectable: false,
        deletable: false,
        className: `cursor-edge${e.status === 'dangling' ? ' dangling-edge' : ''}`,
        style: { stroke: color, strokeWidth: 2.5 },
        markerEnd: { type: 'arrowclosed', color, width: 18, height: 18 },
      });
      continue;
    }
    // A link between two cards: a slot to a whole node, drawn in the structure's own direction.
    const link =
      byId.get(e.source.allocationId).type === 'structureNode' &&
      byId.get(e.target.allocationId).type === 'structureNode' &&
      !e.target.path.length &&
      byId
        .get(e.source.allocationId)
        .data.card.slots.some(s => JSON.stringify(s.path) === JSON.stringify(e.source.path));
    const route = link
      ? linkRoute(
          source,
          sourceBox,
          targetBox,
          structureAnchor(targetBox, targetNode.data.card, [], 'left', 'target').y,
        )
      : curvePointer(source, target, sourceSide, side, obstacles, routes[id], self);
    const changed = byId
      .get(e.source.allocationId)
      .data.changedPaths.has(JSON.stringify(e.source.path));
    const color =
      e.status === 'dangling'
        ? EDGE_COLORS.dangling
        : changed
          ? EDGE_COLORS.changed
          : EDGE_COLORS.normal;
    edges.push({
      id,
      source: e.source.allocationId,
      sourceHandle: handleId('src', e.source.path, sourceSide),
      target: e.target.allocationId,
      targetHandle: handleId('tgt', e.target.path, side),
      type: 'memoryPointer',
      data: { ...route, manual: !!routes[id] },
      zIndex: 1,
      // Structure view computes every route afresh, so there is nothing to bend.
      selectable: !structure,
      reconnectable: editable && byId.get(e.source.allocationId).data.editable ? 'target' : false,
      deletable: editable && byId.get(e.source.allocationId).data.editable,
      className: e.status === 'dangling' ? 'dangling-edge' : '',
      style: { stroke: color, strokeWidth: changed ? 3 : 2 },
      markerEnd: { type: 'arrowclosed', color, width: 18, height: 18 },
    });
  }
  return { nodes, edges };
}

function overlapping(position, width, height, r) {
  return (
    position.x < r.x + r.width + GEOMETRY.gap &&
    position.x + width + GEOMETRY.gap > r.x &&
    position.y < r.y + r.height + GEOMETRY.gap &&
    position.y + height + GEOMETRY.gap > r.y
  );
}
