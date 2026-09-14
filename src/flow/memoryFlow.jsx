/** React components for the pure layout adapter in layout.js. */
import React, { useLayoutEffect, useRef } from 'react';
import { BaseEdge, Handle, Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { isArray, isPointer, isStruct, typeToString } from '../language/types.js';
import { allocationDisplayName, pointerStatus, resolveRef, scalarSubobjects } from '../machine/memory.js';
import { handleId } from './layout.js';

export function FrameGroupNode({ id, data, selected }) {
  return <>
    <div className="frame-group-label" title="Drag to move this call frame · Select to resize">
      <strong>{data.frame.name}()</strong><span>{data.frame.active ? 'active' : 'returned'}</span>
    </div>
    {selected && <>
      <div className="frame-actions nodrag nopan">
        <button onClick={data.onFit}>Fit frame to contents</button>
        {data.editable && <button onClick={data.onAdd}>+ Variable</button>}
      </div>
      {['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(direction => <FrameResize key={direction} id={id} direction={direction} data={data} />)}
    </>}
  </>;
}

function FrameResize({ id, direction, data }) {
  const { screenToFlowPosition, getNode } = useReactFlow();
  const drag = useRef(null);
  const point = event => screenToFlowPosition({ x: event.clientX, y: event.clientY });
  const rectAt = (rect, dx, dy) => ({
    x: rect.x + (direction.includes('w') ? dx : 0), y: rect.y + (direction.includes('n') ? dy : 0),
    width: rect.width + (direction.includes('e') ? dx : direction.includes('w') ? -dx : 0),
    height: rect.height + (direction.includes('s') ? dy : direction.includes('n') ? -dy : 0),
  });
  const rect = () => { const n = getNode(id); return { ...n.position, width: n.width, height: n.height }; };
  const finish = () => { if (drag.current) { drag.current = null; data.onGestureEnd(); } };
  return <div role="button" tabIndex={0} aria-label={`Resize frame ${direction}`} title="Drag to resize · Arrow keys for precise adjustment"
    className={`frame-resize frame-resize-${direction} nodrag nopan`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      drag.current = { point: point(event), rect: rect() };
      event.currentTarget.setPointerCapture(event.pointerId); data.onGestureStart();
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      const p = point(event), start = drag.current;
      data.onResize(rectAt(start.rect, p.x - start.point.x, p.y - start.point.y), direction);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 24 : 8;
      data.onGestureStart();
      data.onResize(rectAt(rect(), event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), direction);
      data.onGestureEnd();
    }} />;
}

function TargetHandles({ path = [], editable, visible = true }) {
  return ['left', 'right'].map(side => <Handle key={side} type="target" id={handleId('tgt', path, side)}
    position={side === 'left' ? Position.Left : Position.Right} className={`mem-handle tgt ${side}${visible ? '' : ' unused-target'}`}
    title={path.length ? `Address of ${formatPath(path)}` : 'Address of whole object'}
    isConnectable={editable} />);
}

function Value({ state, value }) {
  if (value.kind === 'pointer') {
    const status = pointerStatus(state, value);
    const target = resolveRef(state, value.target).label;
    return <span className={`val pointer-value ${status === 'dangling' ? 'dangling' : 'ptr'}`}
      title={`${status} pointer to ${target}`} aria-label={`${status} pointer to ${target}`}>
      {status !== 'valid' && <span className="pointer-status">{status}</span>}
      <svg className="pointer-indicator" width="30" height="20" viewBox="0 0 30 20" aria-hidden="true">
        <path d="M2 10H26M18 3L26 10L18 17" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>;
  }
  return <span className={`val ${value.kind}`}>{value.kind === 'scalar' ? String(value.value) : value.kind === 'null' ? 'NULL' : 'uninitialized'}</span>;
}

export function MemoryAllocationNode({ id, data, selected }) {
  const { allocation: a, state, bad, editable, changed, changedPaths, targetPaths } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const scalars = scalarSubobjects(a, state);
  const aggregateHandles = new Set();
  const rowTargets = scalars.map(s => {
    const paths = [s.ref.path];
    for (let length = 1; length < s.ref.path.length; length++) {
      const path = s.ref.path.slice(0, length), key = path.join('.');
      if (!aggregateHandles.has(key)) { aggregateHandles.add(key); paths.push(path); }
    }
    return paths;
  });
  const signature = `${a.alive}:${JSON.stringify(a.type)}:${scalars.map(s => s.ref.path.join('.')).join('|')}`;
  // Type/array-size edits change handle geometry even when the node ID survives.
  useLayoutEffect(() => { updateNodeInternals(id); }, [id, signature, updateNodeInternals]);
  return <div className={`mem-cell ${a.storage.kind}${!a.alive ? ' dead' : ''}${selected ? ' selected' : ''}${bad ? ' bad' : ''}${changed ? ' memory-changed' : ''}`}>
    <div className="head">
      {(isArray(a.type) || isStruct(a.type)) && <TargetHandles editable={editable} />}
      <span className="name" title={allocationDisplayName(state, a)}>{allocationDisplayName(state, a)}</span>
      <span className="type" title={typeToString(a.type)}>{typeToString(a.type)}</span>
    </div>
    {!a.alive && <div className="lifetime-banner">{a.storage.kind === 'heap' ? 'freed' : 'out of scope'}</div>}
    <div className="subobject-list">{scalars.map((s, i) => <div className={`subobject-row${changedPaths?.has(JSON.stringify(s.ref.path)) ? ' value-changed' : ''}`} key={s.ref.path.join('.') || 'root'}>
      {rowTargets[i].map((path, index) => <TargetHandles key={path.join('.')} path={path} editable={editable && index === 0} visible={!path.length || targetPaths?.has(JSON.stringify(path))} />)}
      {s.ref.path.length > 0 && <span className="sub-label" title={formatPath(s.ref.path)}>{formatPath(s.ref.path)}</span>}
      <Value state={state} value={s.value} />
      {isPointer(s.type) && ['left', 'right'].map(side => <Handle key={side} type="source" id={handleId('src', s.ref.path, side)} position={side === 'left' ? Position.Left : Position.Right} className="mem-handle src" isConnectable={editable} />)}
    </div>)}</div>
  </div>;
}

function formatPath(path) { return path.map(x => typeof x === 'number' ? `[${x}]` : `.${x}`).join(''); }
function MemoryPointerEdge({ id, data, markerEnd, style, selected }) {
  const { screenToFlowPosition } = useReactFlow();
  const dragging = useRef(false);
  const finish = () => { if (dragging.current) { dragging.current = false; data.onGestureEnd(); } };
  return <>
    <BaseEdge id={id} path={data.path} markerEnd={markerEnd} style={{ ...style, strokeWidth: selected ? 3 : style.strokeWidth }} interactionWidth={20} />
    {selected && <path className="edge-bend nodrag nopan" tabIndex={0} role="button" aria-label="Bend pointer arrow"
      d={`M ${data.bend.x} ${data.bend.y - 9} l 9 9 l -9 9 l -9 -9 Z`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true; data.onGestureStart();
      }}
      onPointerMove={event => {
        if (!dragging.current) return;
        const p = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        data.onBend({ x: p.x - data.midpoint.x, y: p.y - data.midpoint.y });
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={event => { event.stopPropagation(); data.onReset(); }}
      onKeyDown={event => {
        if (event.key === 'Home') { event.preventDefault(); data.onReset(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 24 : 8;
        data.onBend({ x: data.bend.x - data.midpoint.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          y: data.bend.y - data.midpoint.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) });
      }} />}
  </>;
}
export const nodeTypes = { memoryAllocation: MemoryAllocationNode, frameGroup: FrameGroupNode };
export const edgeTypes = { memoryPointer: MemoryPointerEdge };
