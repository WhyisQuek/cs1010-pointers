/** Pure MemoryState → canvas layout. Coordinates never enter MemoryState. */
import { allocationDisplayName, frameAllocations, heapAllocations, pointerEdges, resolveRef, scalarSubobjects } from '../machine/memory.js';
import { typeToString } from '../language/types.js';
import { curvePointer } from './routing.js';

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

export function stateToFlow(state, { positions = {}, sizes: frameSizes = {}, routes = {}, editable = false, badIds = new Set(), showExpired = false, previousState = null } = {}) {
  const nodes = [];
  const oldAllocations = new Map(previousState?.allocations.map(a => [a.id, a]) ?? []);
  const semanticEdges = pointerEdges(state);
  const changes = a => {
    const old = oldAllocations.get(a.id);
    const changedPaths = new Set();
    if (previousState) {
      const oldRows = new Map(old ? scalarSubobjects(old, previousState).map(s => [JSON.stringify(s.ref.path), s.value]) : []);
      for (const s of scalarSubobjects(a, state)) {
        const key = JSON.stringify(s.ref.path);
        if (JSON.stringify(oldRows.get(key)) !== JSON.stringify(s.value)) changedPaths.add(key);
      }
    }
    return { changed: !!previousState && (!old || old.alive !== a.alive || changedPaths.size > 0), changedPaths, sourceSides: {},
      targetPaths: new Set(semanticEdges.filter(e => e.target.allocationId === a.id).map(e => JSON.stringify(e.target.path))) };
  };
  const frames = state.frames?.length ? state.frames : state.allocations.some(a => a.storage.kind === 'stack')
    ? [{ id: 'main', name: 'main', depth: 0, active: true }] : [];
  let frameX = 30, rightEdge = 30;
  for (const frame of frames) {
    if (!frame.active && !showExpired) continue;
    const allocations = frameAllocations(state, frame.id).filter(a => a.alive || showExpired);
    const sizes = allocations.map(a => allocationSize(a, state));
    const id = `frame:${frame.id}`, position = positions[id] ?? { x: frameX, y: 72 };
    let y = GEOMETRY.top;
    // New objects occupy unused space; remembered positions are never reflowed.
    const occupied = allocations.flatMap((a, i) => positions[a.id] ? [{ ...positions[a.id], ...sizes[i] }] : []);
    const locals = allocations.map((a, i) => {
      let p = positions[a.id];
      if (!p) {
        p = { x: GEOMETRY.padding, y };
        while (occupied.some(r => p.x < r.x + r.width + GEOMETRY.gap && p.x + sizes[i].width + GEOMETRY.gap > r.x && p.y < r.y + r.height + GEOMETRY.gap && p.y + sizes[i].height + GEOMETRY.gap > r.y)) p = { ...p, y: p.y + GEOMETRY.gap };
      }
      p = { x: Math.max(GEOMETRY.padding, p.x), y: Math.max(GEOMETRY.top, p.y) };
      occupied.push({ ...p, ...sizes[i] }); y = p.y + sizes[i].height + GEOMETRY.gap;
      return p;
    });
    const width = Math.max(frameSizes[id]?.width ?? 600, 288, ...sizes.map((s, i) => locals[i].x + s.width + GEOMETRY.padding));
    const height = Math.max(frameSizes[id]?.height ?? 240, 160, ...sizes.map((s, i) => locals[i].y + s.height + GEOMETRY.padding));
    nodes.push({ id, type: 'frameGroup', position, data: { frame, editable: editable && frame.active },
      draggable: true, dragHandle: '.frame-group-label', selectable: true, deletable: false,
      zIndex: 0, width, height, style: { width, height }, className: `frame-group${frame.active ? '' : ' returned'}${previousState && !previousState.frames?.some(f => f.id === frame.id && f.active === frame.active) ? ' memory-changed' : ''}`,
      ariaLabel: `${frame.name}() ${frame.active ? 'active' : 'returned'} call frame`,
    });
    allocations.forEach((a, i) => {
      const size = sizes[i];
      nodes.push({ id: a.id, type: 'memoryAllocation', parentId: id, expandParent: false,
        position: locals[i],
        draggable: a.alive, selectable: a.alive, deletable: editable && frame.active && a.alive,
        zIndex: 2, ...size, style: size,
        data: { allocation: a, state, ...changes(a), editable: editable && frame.active && a.alive, bad: badIds.has(a.id) },
      });
    });
    // Every invocation gets a distinct slot, even with the same depth/name.
    frameX += width + 96;
    rightEdge = Math.max(rightEdge, position.x + width);
  }
  let heapY = 124;
  const heap = heapAllocations(state);
  const occupiedHeap = heap.flatMap(a => positions[a.id] ? [{ ...positions[a.id], ...allocationSize(a, state) }] : []);
  for (const a of heap) {
    const size = allocationSize(a, state);
    let position = positions[a.id];
    if (!position) {
      position = { x: rightEdge + 96, y: heapY };
      while (occupiedHeap.some(r => position.x < r.x + r.width + GEOMETRY.gap && position.x + size.width + GEOMETRY.gap > r.x && position.y < r.y + r.height + GEOMETRY.gap && position.y + size.height + GEOMETRY.gap > r.y)) position = { ...position, y: position.y + GEOMETRY.gap };
    }
    occupiedHeap.push({ ...position, ...size });
    nodes.push({ id: a.id, type: 'memoryAllocation', position,
      ...size, style: size, zIndex: 2, draggable: a.alive, selectable: a.alive, deletable: editable && a.alive,
      data: { allocation: a, state, ...changes(a), editable: editable && a.alive, bad: badIds.has(a.id) },
    });
    heapY += size.height + GEOMETRY.gap;
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const boxes = new Map(nodes.filter(n => n.type === 'memoryAllocation').map(n => {
    const parent = byId.get(n.parentId)?.position ?? { x: 0, y: 0 };
    return [n.id, { x: n.position.x + parent.x, y: n.position.y + parent.y, ...n.style }];
  }));
  const obstacles = [...boxes.values(), ...nodes.filter(n => n.type === 'frameGroup').map(n => ({ ...n.position, width: n.style.width, height: 34 }))];
  function anchor(r, side, kind = 'target') {
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
      y: box.y + 1 + (row < 0 ? GEOMETRY.header / 2 : GEOMETRY.header + (node.data.allocation.alive ? 0 : GEOMETRY.lifetime) + (row + (kind === 'source' ? .7 : .35)) * GEOMETRY.row) };
  }
  const edges = [];
  for (const e of semanticEdges) {
    if (!boxes.has(e.source.allocationId) || !boxes.has(e.target.allocationId)) continue;
    const sourceBox = boxes.get(e.source.allocationId), targetBox = boxes.get(e.target.allocationId);
    const self = e.source.allocationId === e.target.allocationId;
    const sourceSide = self || targetBox.x + targetBox.width / 2 >= sourceBox.x + sourceBox.width / 2 ? 'right' : 'left';
    const side = self ? 'right' : sourceSide === 'right' ? 'left' : 'right';
    const source = anchor(e.source, sourceSide, 'source');
    if (!source) continue;
    const target = anchor(e.target, side);
    if (!target) continue;
    byId.get(e.source.allocationId).data.sourceSides[JSON.stringify(e.source.path)] = sourceSide;
    const id = `${e.source.allocationId}:${e.source.path.join('.')}->${e.target.allocationId}:${e.target.path.join('.')}`;
    const route = curvePointer(source, target, sourceSide, side, obstacles, routes[id], self);
    const changed = byId.get(e.source.allocationId).data.changedPaths.has(JSON.stringify(e.source.path));
    const color = e.status === 'dangling' ? '#f85149' : changed ? '#e3b341' : '#58a6ff';
    edges.push({ id,
      source: e.source.allocationId, sourceHandle: handleId('src', e.source.path, sourceSide),
      target: e.target.allocationId, targetHandle: handleId('tgt', e.target.path, side),
      type: 'memoryPointer', data: { ...route, manual: !!routes[id] }, zIndex: 1,
      selectable: true,
      reconnectable: editable && byId.get(e.source.allocationId).data.editable ? 'target' : false,
      deletable: editable && byId.get(e.source.allocationId).data.editable,
      className: e.status === 'dangling' ? 'dangling-edge' : '',
      style: { stroke: color, strokeWidth: changed ? 3 : 2 },
      markerEnd: { type: 'arrowclosed', color, width: 18, height: 18 },
    });
  }
  return { nodes, edges };
}
