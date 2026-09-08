/** Pure MemoryState → canvas layout. Coordinates never enter MemoryState. */
import { allocationDisplayName, frameAllocations, heapAllocations, pointerEdges, resolveRef, scalarSubobjects } from '../machine/memory.js';
import { typeToString } from '../language/types.js';
import { roundedPath, routePointer } from './routing.js';

export const GEOMETRY = { header: 34, row: 28, lifetime: 24, padding: 24, top: 52, gap: 32 };
export const handleId = (kind, path = [], side = 'left') => `${kind}:${path.length ? path.join('.') : 'root'}:${side}`;
export function pathFromHandle(id) {
  const raw = id?.split(':')[1];
  return !raw || raw === 'root' ? [] : raw.split('.').map(x => /^\d+$/.test(x) ? Number(x) : x);
}

export function allocationSize(a, state) {
  const rows = scalarSubobjects(a, state);
  const textWidth = (allocationDisplayName(state, a).length + typeToString(a.type).length) * 8 + 40;
  return { width: Math.min(440, Math.max(240, textWidth)), height: 2 + GEOMETRY.header + rows.length * GEOMETRY.row + (a.alive ? 0 : GEOMETRY.lifetime) };
}

export function clampLocal(position, size, frameSize) {
  return {
    x: Math.max(GEOMETRY.padding, Math.min(position.x, frameSize.width - size.width - GEOMETRY.padding)),
    y: Math.max(GEOMETRY.top, Math.min(position.y, frameSize.height - size.height - GEOMETRY.padding)),
  };
}

export function stateToFlow(state, { positions = {}, editable = false, badIds = new Set(), showExpired = false } = {}) {
  const nodes = [];
  const frames = state.frames?.length ? state.frames : [{ id: 'main', name: 'main', depth: 0, active: true }];
  let frameX = 30, rightEdge = 30;
  for (const frame of frames) {
    if (!frame.active && !showExpired) continue;
    const allocations = frameAllocations(state, frame.id).filter(a => a.alive || showExpired);
    const sizes = allocations.map(a => allocationSize(a, state));
    const width = Math.max(288, ...sizes.map(s => s.width + GEOMETRY.padding * 2));
    const height = Math.max(160, GEOMETRY.top + GEOMETRY.padding + sizes.reduce((sum, s) => sum + s.height + GEOMETRY.gap, 0));
    const id = `frame:${frame.id}`, position = positions[id] ?? { x: frameX, y: 72 };
    nodes.push({ id, type: 'frameGroup', position, data: { frame },
      draggable: true, dragHandle: '.frame-group-label', selectable: false, deletable: false,
      zIndex: 0, width, height, style: { width, height }, className: `frame-group${frame.active ? '' : ' returned'}`,
      ariaLabel: `${frame.name}() ${frame.active ? 'active' : 'returned'} call frame`,
    });
    let y = GEOMETRY.top;
    allocations.forEach((a, i) => {
      const size = sizes[i];
      nodes.push({ id: a.id, type: 'memoryAllocation', parentId: id, extent: 'parent', expandParent: false,
        position: clampLocal(positions[a.id] ?? { x: GEOMETRY.padding, y }, size, { width, height }),
        draggable: a.alive, selectable: a.alive, deletable: editable && frame.id === 'main' && a.alive,
        zIndex: 2, ...size, style: size,
        data: { allocation: a, state, editable: editable && frame.id === 'main' && a.alive, bad: badIds.has(a.id) },
      });
      y += size.height + GEOMETRY.gap;
    });
    // Every invocation gets a distinct slot, even with the same depth/name.
    frameX += width + 96;
    rightEdge = Math.max(rightEdge, position.x + width);
  }
  let heapY = 124;
  for (const a of heapAllocations(state)) {
    const size = allocationSize(a, state);
    nodes.push({ id: a.id, type: 'memoryAllocation', position: positions[a.id] ?? { x: rightEdge + 96, y: heapY },
      ...size, style: size, zIndex: 2, draggable: a.alive, selectable: a.alive, deletable: editable && a.alive,
      data: { allocation: a, state, editable: editable && a.alive, bad: badIds.has(a.id) },
    });
    heapY += size.height + GEOMETRY.gap;
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const boxes = new Map(nodes.filter(n => n.type === 'memoryAllocation').map(n => {
    const parent = byId.get(n.parentId)?.position ?? { x: 0, y: 0 };
    return [n.id, { x: n.position.x + parent.x, y: n.position.y + parent.y, ...n.style }];
  }));
  const obstacles = [...boxes.values(), ...nodes.filter(n => n.type === 'frameGroup').map(n => ({ ...n.position, width: n.style.width, height: 34 }))];
  function anchor(r, side) {
    const box = boxes.get(r.allocationId), node = byId.get(r.allocationId);
    if (!box) return null;
    const rows = scalarSubobjects(node.data.allocation, state);
    let row = rows.findIndex(s => JSON.stringify(s.ref.path) === JSON.stringify(r.path));
    if (row < 0 && r.path.length) {
      const resolved = resolveRef(state, r);
      if (!resolved.invalid && !resolved.onePast) row = rows.findIndex(s => r.path.every((part, i) => s.ref.path[i] === part));
    }
    // Aggregate roots attach to the header; one-past references have no target row.
    if (row < 0 && r.path.length) return null;
    return { x: box.x + (side === 'right' ? box.width : 0),
      y: box.y + 1 + (row < 0 ? GEOMETRY.header / 2 : GEOMETRY.header + (node.data.allocation.alive ? 0 : GEOMETRY.lifetime) + (row + .5) * GEOMETRY.row) };
  }
  const edges = [];
  for (const e of pointerEdges(state)) {
    if (!boxes.has(e.source.allocationId) || !boxes.has(e.target.allocationId)) continue;
    const source = anchor(e.source, 'right'), targetBox = boxes.get(e.target.allocationId);
    if (!source) continue;
    const side = source.x >= targetBox.x + targetBox.width ? 'right' : 'left';
    const target = anchor(e.target, side);
    if (!target) continue;
    const points = routePointer(source, target, side, obstacles, edges.length);
    edges.push({ id: `${e.source.allocationId}:${e.source.path.join('.')}->${e.target.allocationId}:${e.target.path.join('.')}`,
      source: e.source.allocationId, sourceHandle: handleId('src', e.source.path, 'right'),
      target: e.target.allocationId, targetHandle: handleId('tgt', e.target.path, side),
      type: 'memoryPointer', data: { path: roundedPath(points), points }, zIndex: 1,
      selectable: editable && byId.get(e.source.allocationId).data.editable,
      deletable: editable && byId.get(e.source.allocationId).data.editable,
      className: e.status === 'dangling' ? 'dangling-edge' : '',
      style: { stroke: e.status === 'dangling' ? '#f85149' : '#58a6ff', strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed', color: e.status === 'dangling' ? '#f85149' : '#58a6ff', width: 18, height: 18 },
    });
  }
  return { nodes, edges };
}
