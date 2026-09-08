/** React components for the pure layout adapter in layout.js. */
import React, { useLayoutEffect } from 'react';
import { BaseEdge, Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { isArray, isPointer, isStruct, typeToString } from '../language/types.js';
import { allocationDisplayName, pointerStatus, resolveRef, scalarSubobjects } from '../machine/memory.js';
import { handleId } from './layout.js';

export function FrameGroupNode({ data }) {
  return <div className="frame-group-label" title="Drag to move this call frame">
    <strong>{data.frame.name}()</strong><span>{data.frame.active ? 'active' : 'returned'}</span>
  </div>;
}

function TargetHandles({ path = [], editable }) {
  return <>{['left', 'right'].map(side => <Handle key={side} type="target" id={handleId('tgt', path, side)}
    position={side === 'left' ? Position.Left : Position.Right} className={`mem-handle tgt ${side}`}
    isConnectable={editable && side === 'left'} />)}</>;
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
  const { allocation: a, state, bad, editable } = data;
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
  return <div className={`mem-cell ${a.storage.kind}${!a.alive ? ' dead' : ''}${selected ? ' selected' : ''}${bad ? ' bad' : ''}`}>
    <div className="head">
      {(isArray(a.type) || isStruct(a.type)) && <TargetHandles editable={editable} />}
      <span className="name" title={allocationDisplayName(state, a)}>{allocationDisplayName(state, a)}</span>
      <span className="type" title={typeToString(a.type)}>{typeToString(a.type)}</span>
    </div>
    {!a.alive && <div className="lifetime-banner">{a.storage.kind === 'heap' ? 'freed' : 'out of scope'}</div>}
    <div className="subobject-list">{scalars.map((s, i) => <div className="subobject-row" key={s.ref.path.join('.') || 'root'}>
      {rowTargets[i].map((path, index) => <TargetHandles key={path.join('.')} path={path} editable={editable && index === 0} />)}
      {s.ref.path.length > 0 && <span className="sub-label" title={formatPath(s.ref.path)}>{formatPath(s.ref.path)}</span>}
      <Value state={state} value={s.value} />
      {isPointer(s.type) && <Handle type="source" id={handleId('src', s.ref.path, 'right')} position={Position.Right} className="mem-handle src" isConnectable={editable} />}
    </div>)}</div>
  </div>;
}

function formatPath(path) { return path.map(x => typeof x === 'number' ? `[${x}]` : `.${x}`).join(''); }
function MemoryPointerEdge({ id, data, markerEnd, style }) {
  return <BaseEdge id={id} path={data.path} markerEnd={markerEnd} style={style} interactionWidth={16} />;
}
export const nodeTypes = { memoryAllocation: MemoryAllocationNode, frameGroup: FrameGroupNode };
export const edgeTypes = { memoryPointer: MemoryPointerEdge };
