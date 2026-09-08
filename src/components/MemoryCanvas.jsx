/** Interactive MemoryState editor. React Flow layout never becomes semantic state. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, useNodesInitialized, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { edgeTypes, nodeTypes } from '../flow/memoryFlow.jsx';
import { clampLocal, pathFromHandle, stateToFlow } from '../flow/layout.js';
import {
  array, basePrimitive, isArray, isPointer, isStruct, pointer, pointerDepth, primitive,
  typeToString,
} from '../language/types.js';
import { MAX_ARRAY_LENGTH, clampArrayLength } from '../language/limits.js';
import {
  addAllocation, getAllocation, makeDefaultValue, makeState, pointerCanTarget, ref,
  resolveRef, scalarSubobjects, setRefValue,
} from '../machine/memory.js';

export default function MemoryCanvas({ state, onChange, editable = false, badIds, onMessage }) {
  const [layout, setLayout] = useState({ state, positions: {} });
  const [showExpired, setShowExpired] = useState(false);
  const [flow, setFlow] = useState(null);
  const [measurements, setMeasurements] = useState({});
  // Discard drags on every semantic state/snapshot transition, including revisits.
  // Keeping only the current state prevents a previous run's reused IDs leaking in.
  if (layout.state !== state) setLayout({ state, positions: {} });
  const positions = layout.state === state ? layout.positions : {};
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const { nodes, edges } = useMemo(() => {
    const result = stateToFlow(state, { positions, editable, badIds: badIds ?? new Set(), showExpired });
    result.nodes = result.nodes.map(n => ({
      ...n,
      // Preserve React Flow's reported measurements across controlled-node updates.
      // Without these, handle bounds are discarded and auto-fit never settles.
      measured: measurements[n.id]?.width === n.width && measurements[n.id]?.height === n.height ? measurements[n.id] : undefined,
      selected: n.selectable !== false && n.id === selectedId,
    }));
    result.edges = result.edges.map(e => ({ ...e, selected: e.selectable && e.id === selectedEdgeId }));
    return result;
  }, [state, positions, measurements, editable, badIds, showExpired, selectedId, selectedEdgeId]);

  const mutate = useCallback(fn => { const next = structuredClone(state); fn(next); onChange?.(next); }, [state, onChange]);
  const onNodesChange = useCallback(changes => {
    for (const ch of changes) {
      const node = nodes.find(n => n.id === ch.id);
      if (ch.type === 'dimensions' && ch.dimensions) setMeasurements(p =>
        p[ch.id]?.width === ch.dimensions.width && p[ch.id]?.height === ch.dimensions.height
          ? p : { ...p, [ch.id]: ch.dimensions });
      if (ch.type === 'position' && ch.position && node?.draggable) {
        const parent = nodes.find(n => n.id === node.parentId);
        const position = parent ? clampLocal(ch.position, node.style, parent.style) : ch.position;
        setLayout(p => ({ state, positions: { ...(p.state === state ? p.positions : {}), [ch.id]: position } }));
      }
      if (ch.type === 'select' && !ch.id.startsWith('frame:')) setSelectedId(ch.selected ? ch.id : null);
      if (ch.type === 'remove' && node?.deletable) mutate(s => removeAllocation(s, ch.id));
    }
  }, [state, nodes, mutate]);

  const onConnect = useCallback(({ source, target, sourceHandle, targetHandle }) => {
    if (!editable || !source || !target || !nodes.find(n => n.id === source)?.data.editable || !nodes.find(n => n.id === target)?.data.editable) return;
    const sourceRef = ref(source, pathFromHandle(sourceHandle)), targetRef = ref(target, pathFromHandle(targetHandle));
    const src = resolveRef(state, sourceRef);
    if (!isPointer(src.type) || !pointerCanTarget(state, src.type, targetRef)) {
      const targetType = resolveRef(state, targetRef).type;
      onMessage?.({ kind: 'err', text: `${typeToString(src.type)} cannot point to ${typeToString(targetType)}` }); return;
    }
    mutate(s => setRefValue(s, sourceRef, { kind: 'pointer', target: targetRef }));
  }, [editable, state, nodes, mutate, onMessage]);

  const onEdgesChange = useCallback(changes => {
    if (!editable) return;
    for (const ch of changes) if (ch.type === 'select') setSelectedEdgeId(ch.selected ? ch.id : null);
    const removed = new Set(changes.filter(c => c.type === 'remove' && edges.find(e => e.id === c.id)?.deletable).map(c => c.id));
    if (!removed.size) return;
    mutate(s => { for (const e of edges) if (removed.has(e.id)) setRefValue(s, ref(e.source, pathFromHandle(e.sourceHandle)), { kind: 'uninit' }); });
  }, [editable, edges, mutate]);

  const addBox = storageKind => mutate(s => {
    const a = addAllocation(s, {
      name: storageKind === 'stack' ? nextName(s) : null,
      type: primitive('int'), storage: storageKind === 'stack' ? { kind: 'stack', frameId: 'main' } : { kind: 'heap' },
    });
    setSelectedId(a.id);
  });
  const selected = nodes.find(n => n.id === selectedId && n.data.editable)?.data.allocation ?? null;

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <button className="plain-btn" onClick={() => { setLayout({ state, positions: {} }); requestAnimationFrame(() => flow?.fitView({ padding: .15, maxZoom: 1 })); }}>Reset layout</button>
        <label className="history-toggle"><input type="checkbox" checked={showExpired} onChange={e => { setShowExpired(e.target.checked); setLayout({ state, positions: {} }); }} />Show expired</label>
      </div>
      {editable && <div className="canvas-edit-toolbar">
        <button className="plain-btn" onClick={() => addBox('stack')}>Add stack object</button>
        <button className="plain-btn" onClick={() => addBox('heap')}>Add heap allocation</button>
        {state.allocations.length > 0 && <button className="plain-btn danger" onClick={() => onChange?.(makeState(state.structTypes))}>Clear</button>}
      </div>}
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="dark"
        onInit={setFlow} elevateNodesOnSelect={false} elevateEdgesOnSelect={false}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        nodesConnectable={editable} deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.1} proOptions={{ hideAttribution: true }}
      >
        <CanvasViewport state={state} showExpired={showExpired} />
        <Background color="#30363d" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {editable && selected && <Inspector
        allocation={selected} state={state}
        onEdit={fn => mutate(s => fn(getAllocation(s, selected.id), s))}
        onDelete={() => { mutate(s => removeAllocation(s, selected.id)); setSelectedId(null); }}
      />}
    </div>
  );
}

function CanvasViewport({ state, showExpired }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized) return;
    const frame = requestAnimationFrame(() => fitView({ padding: .15, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [state, showExpired, initialized, fitView]);
  return null;
}

function Inspector({ allocation: a, state, onEdit, onDelete }) {
  const editor = typeEditor(a.type), scalars = scalarEntries(a, state);
  const setType = patch => onEdit((obj, currentState) => {
    const next = { ...editor, ...patch };
    let t = primitive(next.base);
    for (let i = 0; i < next.stars; i++) t = pointer(t);
    if (next.shape === 'array') t = array(t, clampArrayLength(next.length));
    obj.type = t; obj.value = makeDefaultValue(t, currentState.structTypes);
  });

  return (
    <div className="inspector">
      <h4>{a.storage.kind === 'stack' ? 'Stack object' : 'Heap allocation'}</h4>
      {a.storage.kind === 'stack' && <><label>Name</label><input value={a.name ?? ''} onChange={e => onEdit(obj => { obj.name = e.target.value; })} /></>}
      {isStruct(a.type) ? <>
        <label>Type</label><div className="readonly-field">{typeToString(a.type)}</div>
      </> : <>
        <label>Shape</label>
        <select value={editor.shape} onChange={e => setType({ shape: e.target.value })}><option value="scalar">scalar</option><option value="array">array</option></select>
        <label>Type</label>
        <div className="type-row">
          <select value={editor.base} onChange={e => setType({ base: e.target.value })}>{['int', 'char'].map(t => <option key={t}>{t}</option>)}</select>
          <select className="pointer-depth" value={editor.stars} onChange={e => setType({ stars: Number(e.target.value) })}>{[0, 1, 2, 3].map(n => <option key={n} value={n}>{'*'.repeat(n) || '(value)'}</option>)}</select>
        </div>
        {editor.shape === 'array' && <>
          <label>Array length (max {MAX_ARRAY_LENGTH})</label>
          <input type="number" min="1" max={MAX_ARRAY_LENGTH} value={editor.length}
            onChange={e => setType({ length: clampArrayLength(e.target.value) })} />
        </>}
      </>}
      {a.storage.kind === 'heap' && <><label>Lifetime</label><select value={a.alive ? 'alive' : 'freed'} onChange={e => onEdit(obj => { obj.alive = e.target.value === 'alive'; })}><option value="alive">alive</option><option value="freed">freed</option></select></>}
      <label>Values</label>
      <div className="inspector-values">{scalars.map(s => <ScalarEditor key={s.path.join('.') || 'root'} entry={s} onEdit={v => onEdit((obj, currentState) => setRefValue(currentState, ref(obj.id, s.path), v))} />)}</div>
      <div className="actions"><button className="plain-btn danger" onClick={onDelete}>Delete object</button></div>
    </div>
  );
}

function ScalarEditor({ entry, onEdit }) {
  const label = entry.path.length ? entry.path.map(x => typeof x === 'number' ? `[${x}]` : `.${x}`).join('') : 'value';
  if (isPointer(entry.type)) return <div className="scalar-editor"><span>{label}</span><select value={entry.value.kind === 'pointer' ? 'pointer' : entry.value.kind} onChange={e => {
    if (e.target.value === 'null') onEdit({ kind: 'null' }); else if (e.target.value === 'uninit') onEdit({ kind: 'uninit' });
  }}><option value="uninit">uninitialized</option><option value="null">NULL</option>{entry.value.kind === 'pointer' && <option value="pointer">drawn arrow</option>}</select></div>;
  return <div className="scalar-editor"><span>{label}</span><input type="number" value={entry.value.kind === 'scalar' ? entry.value.value : ''} placeholder="uninitialized" onChange={e => onEdit(e.target.value === '' ? { kind: 'uninit' } : { kind: 'scalar', value: Number(e.target.value) })} /></div>;
}

function typeEditor(type) {
  const shape = isArray(type) ? 'array' : 'scalar', scalar = isArray(type) ? type.of : type;
  return { shape, base: basePrimitive(scalar) ?? 'int', stars: pointerDepth(scalar), length: isArray(type) ? type.length : 3 };
}
function scalarEntries(a, state) { return scalarSubobjects(a, state).map(s => ({ path: s.ref.path, type: s.type, value: s.value })); }
function removeAllocation(state, id) {
  state.allocations = state.allocations.filter(a => a.id !== id);
  for (const a of state.allocations) for (const s of scalarEntries(a, state)) if (s.value.kind === 'pointer' && s.value.target.allocationId === id) setRefValue(state, ref(a.id, s.path), { kind: 'uninit' });
}
function nextName(state) { const used = new Set(state.allocations.map(a => a.name)); for (const ch of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(ch)) return ch; return `v${state.allocations.length}`; }
