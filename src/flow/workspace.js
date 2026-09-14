/** Presentation-only workspace operations. Never stored in MemoryState. */
import { GEOMETRY } from './layout.js';
export const emptyLayout = () => ({ positions: {}, sizes: {}, routes: {} });
const { padding: PAD, top: TOP } = GEOMETRY;

export function captureLayout(layout, nodes) {
  const next = { ...layout, positions: { ...layout.positions }, sizes: { ...layout.sizes } };
  for (const n of nodes) {
    next.positions[n.id] = { ...n.position };
    if (n.type === 'frameGroup') next.sizes[n.id] = { width: n.width, height: n.height };
  }
  return next;
}

export function contentSize(nodes, frameId) {
  const children = nodes.filter(n => n.parentId === frameId);
  return {
    width: Math.max(288, ...children.map(n => n.position.x + n.width + PAD)),
    height: Math.max(160, ...children.map(n => n.position.y + n.height + PAD)),
  };
}

export function moveNode(layout, nodes, id, position) {
  const next = captureLayout(layout, nodes), node = nodes.find(n => n.id === id);
  if (!node) return layout;
  next.positions[id] = position;
  if (!node.parentId) return next;
  const parent = nodes.find(n => n.id === node.parentId);
  const dx = Math.min(0, position.x - PAD), dy = Math.min(0, position.y - TOP);
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
export function resizeFrame(layout, nodes, id, rect, direction) {
  const next = captureLayout(layout, nodes), frame = nodes.find(n => n.id === id);
  if (!frame) return layout;
  const children = nodes.filter(n => n.parentId === id);
  const world = children.map(n => ({ x: frame.position.x + n.position.x, y: frame.position.y + n.position.y, width: n.width, height: n.height }));
  const oldRight = frame.position.x + frame.width, oldBottom = frame.position.y + frame.height;
  const left = direction.includes('w') ? Math.min(rect.x, oldRight - 288, ...world.map(n => n.x - PAD)) : frame.position.x;
  const top = direction.includes('n') ? Math.min(rect.y, oldBottom - 160, ...world.map(n => n.y - TOP)) : frame.position.y;
  const right = direction.includes('e') ? Math.max(rect.x + rect.width, left + 288, ...world.map(n => n.x + n.width + PAD)) : oldRight;
  const bottom = direction.includes('s') ? Math.max(rect.y + rect.height, top + 160, ...world.map(n => n.y + n.height + PAD)) : oldBottom;
  next.positions[id] = { x: left, y: top };
  next.sizes[id] = { width: right - left, height: bottom - top };
  for (const n of children) next.positions[n.id] = { x: n.position.x + frame.position.x - left, y: n.position.y + frame.position.y - top };
  return next;
}

export function initialHistory() { return { present: emptyLayout(), past: [], future: [], gesture: null }; }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function layoutHistory(history, action) {
  const { present, past, future, gesture } = history;
  if (action.type === 'sync') return equal(present, action.layout) ? history : { ...history, present: action.layout };
  if (action.type === 'begin') return { ...history, gesture: present };
  if (action.type === 'end') return !gesture ? history : { ...history, gesture: null,
    past: equal(gesture, present) ? past : [...past.slice(-49), gesture], future: equal(gesture, present) ? future : [] };
  if (action.type === 'set') {
    if (equal(present, action.layout)) return history;
    return { ...history, present: action.layout, past: gesture ? past : [...past.slice(-49), present], future: [] };
  }
  if (action.type === 'undo' && past.length) return { present: past.at(-1), past: past.slice(0, -1), future: [present, ...future], gesture: null };
  if (action.type === 'redo' && future.length) return { present: future[0], past: [...past, present], future: future.slice(1), gesture: null };
  if (action.type === 'clear') return initialHistory();
  return history;
}
