/** Presentation-only workspace operations. Never stored in MemoryState. */
import { densityMetrics } from './layout.js';
export const emptyLayout = () => ({ positions: {}, sizes: {}, routes: {} });
// Frame padding, the top of a frame's contents, and the smallest frame, for a box density.
const frameMetrics = density => {
  const { geometry, frameMin } = densityMetrics(density);
  return { PAD: geometry.padding, TOP: geometry.top, MIN: frameMin };
};

/**
 * Boxes are different sizes in each density, so each keeps its own arrangement: Full's at the
 * top level of the layout, Compact's under `compact`. One undo history covers both.
 */
export const densityLayout = (layout, density) =>
  density === 'compact' ? (layout.compact ?? emptyLayout()) : layout;
export const withDensityLayout = (layout, density, part) =>
  density === 'compact' ? { ...layout, compact: part } : { ...part, compact: layout.compact };

export function captureLayout(layout, nodes) {
  const next = { ...layout, positions: { ...layout.positions }, sizes: { ...layout.sizes } };
  for (const n of nodes) {
    // The stack column places frames afresh every step; dragging or resizing one (moveNode,
    // resizeFrame) is what pins it. Fold rows are never remembered.
    if (n.type === 'frameFold') continue;
    if (n.type === 'frameGroup') next.sizes[n.id] = { width: n.width, height: n.height };
    else next.positions[n.id] = { ...n.position };
  }
  return next;
}

export function contentSize(nodes, frameId, density = 'full') {
  const { PAD, MIN } = frameMetrics(density);
  const children = nodes.filter(n => n.parentId === frameId);
  return {
    width: Math.max(MIN.width, ...children.map(n => n.position.x + n.width + PAD)),
    height: Math.max(MIN.height, ...children.map(n => n.position.y + n.height + PAD)),
  };
}

export function moveNode(layout, nodes, id, position, density = 'full') {
  const { PAD, TOP } = frameMetrics(density);
  const next = captureLayout(layout, nodes),
    node = nodes.find(n => n.id === id);
  if (!node) return layout;
  next.positions[id] = position;
  if (!node.parentId) return next;
  const parent = nodes.find(n => n.id === node.parentId);
  const dx = Math.min(0, position.x - PAD),
    dy = Math.min(0, position.y - TOP);
  if (dx || dy) {
    next.positions[parent.id] = { x: parent.position.x + dx, y: parent.position.y + dy };
    for (const child of nodes.filter(n => n.parentId === parent.id)) {
      const p = next.positions[child.id];
      next.positions[child.id] = { x: p.x - dx, y: p.y - dy };
    }
  }
  const p = next.positions[id];
  next.sizes[parent.id] = {
    width: Math.max(parent.width - dx, p.x + node.width + PAD),
    height: Math.max(parent.height - dy, p.y + node.height + PAD),
  };
  return next;
}

/** Resize any edge while keeping children fixed in world coordinates. */
export function resizeFrame(layout, nodes, id, rect, direction, density = 'full') {
  const { PAD, TOP, MIN } = frameMetrics(density);
  const next = captureLayout(layout, nodes),
    frame = nodes.find(n => n.id === id);
  if (!frame) return layout;
  const children = nodes.filter(n => n.parentId === id);
  const world = children.map(n => ({
    x: frame.position.x + n.position.x,
    y: frame.position.y + n.position.y,
    width: n.width,
    height: n.height,
  }));
  const oldRight = frame.position.x + frame.width,
    oldBottom = frame.position.y + frame.height;
  const left = direction.includes('w')
    ? Math.min(rect.x, oldRight - MIN.width, ...world.map(n => n.x - PAD))
    : frame.position.x;
  const top = direction.includes('n')
    ? Math.min(rect.y, oldBottom - MIN.height, ...world.map(n => n.y - TOP))
    : frame.position.y;
  const right = direction.includes('e')
    ? Math.max(rect.x + rect.width, left + MIN.width, ...world.map(n => n.x + n.width + PAD))
    : oldRight;
  const bottom = direction.includes('s')
    ? Math.max(rect.y + rect.height, top + MIN.height, ...world.map(n => n.y + n.height + PAD))
    : oldBottom;
  next.positions[id] = { x: left, y: top };
  next.sizes[id] = { width: right - left, height: bottom - top };
  for (const n of children)
    next.positions[n.id] = {
      x: n.position.x + frame.position.x - left,
      y: n.position.y + frame.position.y - top,
    };
  return next;
}

export function initialHistory() {
  return { present: emptyLayout(), past: [], future: [], gesture: null };
}
/** Undo steps kept by both histories. */
const HISTORY_LIMIT = 50;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function layoutHistory(history, action) {
  const { present, past, future, gesture } = history;
  if (action.type === 'sync')
    return equal(present, action.layout) ? history : { ...history, present: action.layout };
  if (action.type === 'begin') return { ...history, gesture: present };
  if (action.type === 'end')
    return !gesture
      ? history
      : {
          ...history,
          gesture: null,
          past: equal(gesture, present) ? past : [...past.slice(1 - HISTORY_LIMIT), gesture],
          future: equal(gesture, present) ? future : [],
        };
  if (action.type === 'set') {
    if (equal(present, action.layout)) return history;
    return {
      ...history,
      present: action.layout,
      past: gesture ? past : [...past.slice(1 - HISTORY_LIMIT), present],
      future: [],
    };
  }
  if (action.type === 'undo' && past.length)
    return {
      present: past.at(-1),
      past: past.slice(0, -1),
      future: [present, ...future],
      gesture: null,
    };
  if (action.type === 'redo' && future.length)
    return { present: future[0], past: [...past, present], future: future.slice(1), gesture: null };
  if (action.type === 'clear') return initialHistory();
  return history;
}

/**
 * The order of Ctrl+Z steps across both kinds of change. Each entry is either 'layout'
 * (replayed by layoutHistory, which holds the layouts) or a diagram edit
 * { before, after, merge? } holding the MemoryState on each side of the edit; edits
 * sharing a `merge` key back to back combine into one step.
 */
export const emptyTimeline = () => ({ past: [], future: [] });
export function editTimeline(timeline, action) {
  const { past, future } = timeline;
  if (action.type === 'record') {
    // Edits computed from the same state in one event (deleting a node also deletes its
    // edges) are one step; the last one is the state that was applied.
    const top = past.at(-1),
      entry = action.entry;
    const edits = entry !== 'layout' && top && top !== 'layout';
    const sameEvent = edits && top.before === entry.before;
    // Consecutive edits of one field (typing 1, 2, 3 into a value) are one step back to before them.
    const sameField =
      edits && entry.merge && top.merge === entry.merge && top.after === entry.before;
    if (sameField)
      return { past: [...past.slice(0, -1), { ...entry, before: top.before }], future: [] };
    const kept = sameEvent ? past.slice(0, -1) : past;
    return { past: [...kept.slice(1 - HISTORY_LIMIT), entry], future: [] };
  }
  if (action.type === 'undo' && past.length)
    return { past: past.slice(0, -1), future: [past.at(-1), ...future] };
  if (action.type === 'redo' && future.length)
    return { past: [...past, future[0]], future: future.slice(1) };
  // The diagram was replaced from outside (a new run, a playback step): its edits no longer apply.
  if (action.type === 'forgetEdits') {
    const layoutOnly = entries => entries.filter(entry => entry === 'layout');
    return { past: layoutOnly(past), future: layoutOnly(future) };
  }
  return timeline;
}
