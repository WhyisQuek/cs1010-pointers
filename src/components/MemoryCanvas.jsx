/** Interactive MemoryState editor. React Flow layout never becomes semantic state. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, useNodesInitialized, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { edgeTypes, nodeTypes } from '../flow/memoryFlow.jsx';
import { GEOMETRY, pathFromHandle, stateToFlow } from '../flow/layout.js';
import { captureLayout, contentSize, emptyLayout, initialHistory, layoutHistory, moveNode, resizeFrame } from '../flow/workspace.js';
import {
  array, basePrimitive, isArray, isPointer, isStruct, pointer, pointerDepth, primitive,
  typeToString,
} from '../language/types.js';
import { MAX_ARRAY_LENGTH, clampArrayLength } from '../language/limits.js';
import {
  addAllocation, addFrame, getAllocation, makeDefaultValue, makeState, pointerCanTarget, ref,
  resolveRef, scalarSubobjects, setRefValue,
} from '../machine/memory.js';

export default function MemoryCanvas({ state, previousState = null, onChange, editable = false, badIds, onMessage }) {
  const [history, setHistory] = useState(initialHistory);
  const historyRef = useRef(history);
  const dispatch = useCallback(action => {
    const next = layoutHistory(historyRef.current, action);
    if (next !== historyRef.current) { historyRef.current = next; setHistory(next); }
  }, []);
  const setLayout = useCallback(layout => dispatch({ type: 'set', layout }), [dispatch]);
  const begin = useCallback(() => dispatch({ type: 'begin' }), [dispatch]);
  const end = useCallback(() => dispatch({ type: 'end' }), [dispatch]);
  const [showExpired, setShowExpired] = useState(false);
  const [snap, setSnap] = useState(false);
  const [menu, setMenu] = useState(null);
  const [viewportSession, setViewportSession] = useState(0);
  const [flow, setFlow] = useState(null);
  const [measurements, setMeasurements] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const { nodes, edges } = useMemo(() => {
    const result = stateToFlow(state, { ...history.present, editable, badIds: badIds ?? new Set(), showExpired, previousState });
    result.nodes = result.nodes.map(n => ({
      ...n,
      // Preserve React Flow's reported measurements across controlled-node updates.
      // Without these, handle bounds are discarded and auto-fit never settles.
      measured: measurements[n.id]?.width === n.width && measurements[n.id]?.height === n.height ? measurements[n.id] : undefined,
      selected: n.selectable !== false && n.id === selectedId,
    }));
    result.edges = result.edges.map(e => ({ ...e, selected: e.selectable && e.id === selectedEdgeId }));
    return result;
  }, [state, previousState, history.present, measurements, editable, badIds, showExpired, selectedId, selectedEdgeId]);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  useEffect(() => {
    dispatch({ type: 'sync', layout: captureLayout(historyRef.current.present, nodes) });
  }, [nodes, dispatch]);

  const mutate = useCallback(fn => { if (!editable) return; const next = structuredClone(state); fn(next); onChange?.(next); }, [state, onChange, editable]);
  const onNodesChange = useCallback(changes => {
    let currentNodes = nodesRef.current;
    for (const ch of changes) {
      const node = currentNodes.find(n => n.id === ch.id);
      if (ch.type === 'dimensions' && ch.dimensions) setMeasurements(p =>
        p[ch.id]?.width === ch.dimensions.width && p[ch.id]?.height === ch.dimensions.height
          ? p : { ...p, [ch.id]: ch.dimensions });
      if (ch.type === 'position' && ch.position && node?.draggable) {
        const next = moveNode(historyRef.current.present, currentNodes, ch.id, ch.position);
        setLayout(next);
        currentNodes = currentNodes.map(n => ({ ...n, position: next.positions[n.id] ?? n.position, ...(next.sizes[n.id] ?? {}) }));
        nodesRef.current = currentNodes;
      }
      if (ch.type === 'select') { setSelectedId(p => ch.selected ? ch.id : p === ch.id ? null : p); if (ch.selected) setSelectedEdgeId(null); }
    }
    const removed = changes.filter(ch => ch.type === 'remove' && currentNodes.find(n => n.id === ch.id)?.deletable);
    if (removed.length) mutate(s => { for (const ch of removed) removeAllocation(s, ch.id); });
  }, [mutate, setLayout]);

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
    for (const ch of changes) if (ch.type === 'select') { setSelectedEdgeId(p => ch.selected ? ch.id : p === ch.id ? null : p); if (ch.selected) setSelectedId(null); }
    if (!editable) return;
    const removed = new Set(changes.filter(c => c.type === 'remove' && edges.find(e => e.id === c.id)?.deletable).map(c => c.id));
    if (!removed.size) return;
    mutate(s => { for (const e of edges) if (removed.has(e.id)) setRefValue(s, ref(e.source, pathFromHandle(e.sourceHandle)), { kind: 'uninit' }); });
  }, [editable, edges, mutate]);

  const addBox = (storageKind, frameId = 'main', position) => mutate(s => {
    if (storageKind === 'stack') {
      const frame = s.frames.find(f => f.id === frameId);
      if (frame && !frame.active) return;
      if (!frame) addFrame(s, { id: frameId, name: 'main' });
    }
    const a = addAllocation(s, {
      name: storageKind === 'stack' ? nextName(s) : null,
      type: primitive('int'), storage: storageKind === 'stack' ? { kind: 'stack', frameId } : { kind: 'heap' },
    });
    if (position) {
      const layout = captureLayout(historyRef.current.present, nodes);
      layout.positions[a.id] = { x: Math.max(GEOMETRY.padding, position.x), y: Math.max(GEOMETRY.top, position.y) };
      dispatch({ type: 'sync', layout });
    }
    setSelectedId(a.id); setMenu(null);
  });
  const selected = nodes.find(n => n.id === selectedId && n.data.editable)?.data.allocation ?? null;
  const selectedNode = nodes.find(n => n.id === selectedId);
  const selectedFrame = selectedNode?.type === 'frameGroup' ? selectedNode : nodes.find(n => n.id === selectedNode?.parentId);
  const addFrameId = selectedFrame?.data.editable ? selectedFrame.data.frame.id : 'main';
  const resetRoute = id => {
    const layout = { ...historyRef.current.present, routes: { ...historyRef.current.present.routes } };
    delete layout.routes[id]; setLayout(layout);
  };
  const interactiveNodes = nodes.map(n => ({ ...n, className: `${n.className ?? ''}${n.id === selectedFrame?.id ? ' frame-owner-active' : ''}`, data: { ...n.data, onGestureStart: begin, onGestureEnd: end,
    onResize: (rect, direction) => setLayout(resizeFrame(historyRef.current.present, nodesRef.current, n.id, rect, direction)),
    onFit: () => setLayout({ ...historyRef.current.present, sizes: { ...historyRef.current.present.sizes, [n.id]: contentSize(nodes, n.id) } }),
    onAdd: () => addBox('stack', n.data.frame?.id),
  } }));
  const interactiveEdges = edges.map(e => ({ ...e, data: { ...e.data, onGestureStart: begin, onGestureEnd: end,
    onBend: offset => setLayout({ ...historyRef.current.present, routes: { ...historyRef.current.present.routes, [e.id]: offset } }),
    onReset: () => resetRoute(e.id),
  } }));
  const contextMenu = (event, node) => {
    if (!node.data.frame || !node.data.editable) return;
    event.preventDefault();
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const bounds = event.currentTarget.closest('.canvas-wrap').getBoundingClientRect();
    setSelectedId(node.id); setSelectedEdgeId(null);
    setMenu({ frameId: node.data.frame.id, x: Math.min(event.clientX - bounds.left, bounds.width - 180), y: Math.min(event.clientY - bounds.top, bounds.height - 45),
      position: { x: point.x - node.position.x, y: point.y - node.position.y } });
  };

  return (
    <div className="canvas-wrap" onKeyDown={event => {
      if (event.target.closest('input, textarea, select, [contenteditable=true]')) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation();
        dispatch({ type: event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo' });
      }
      if (event.key === 'Escape') setMenu(null);
    }}>
      <div className="canvas-toolbar">
        <button className="plain-btn" onClick={() => flow?.fitView({ padding: .15, maxZoom: 1 })}>Fit view</button>
        <button className="plain-btn" onClick={() => setLayout(emptyLayout())}>Reset layout</button>
        <button className="plain-btn" disabled={!history.past.length} onClick={() => dispatch({ type: 'undo' })} title="Undo layout (Ctrl+Z)">Undo</button>
        <button className="plain-btn" disabled={!history.future.length} onClick={() => dispatch({ type: 'redo' })} title="Redo layout (Ctrl+Shift+Z)">Redo</button>
        <label className="history-toggle"><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} />Snap</label>
        <label className="history-toggle"><input type="checkbox" checked={showExpired} onChange={e => setShowExpired(e.target.checked)} />Show expired</label>
      </div>
      {editable && <div className="canvas-edit-toolbar">
        <button className="plain-btn" onClick={() => addBox('stack', addFrameId)}>Add stack object</button>
        <button className="plain-btn" onClick={() => addBox('heap')}>Add heap allocation</button>
        {state.allocations.length > 0 && <button className="plain-btn danger" onClick={() => { dispatch({ type: 'clear' }); setViewportSession(s => s + 1); setSelectedId(null); setSelectedEdgeId(null); setMenu(null); onChange?.(makeState(state.structTypes)); }}>Clear</button>}
      </div>}
      <ReactFlow
        nodes={interactiveNodes} edges={interactiveEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="dark"
        onInit={setFlow} elevateNodesOnSelect={false} elevateEdgesOnSelect={false}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onReconnect={(_, connection) => onConnect(connection)} edgesReconnectable={editable}
        onNodeDragStart={begin} onNodeDragStop={end} onSelectionDragStart={begin} onSelectionDragStop={end}
        onNodeContextMenu={contextMenu} onPaneClick={() => { setMenu(null); setSelectedId(null); setSelectedEdgeId(null); }}
        onMoveStart={() => setMenu(null)} snapToGrid={snap} snapGrid={[24, 24]}
        nodesConnectable={editable} deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.1} proOptions={{ hideAttribution: true }}
      >
        <CanvasViewport key={viewportSession} />
        <Background color="#30363d" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menu && <div className="canvas-context-menu" style={{ left: menu.x, top: menu.y }}>
        <button className="plain-btn" onClick={() => addBox('stack', menu.frameId, menu.position)}>Add variable here</button>
      </div>}
      {selectedEdgeId && edges.some(e => e.id === selectedEdgeId) && <div className="edge-tools">
        <span>Drag the diamond to bend{editable ? ' · Drag the arrowhead to reconnect' : ''}</span>
        <button className="plain-btn" onClick={() => resetRoute(selectedEdgeId)}>Reset route</button>
      </div>}
      {editable && selected && <Inspector
        allocation={selected} state={state}
        onEdit={fn => mutate(s => fn(getAllocation(s, selected.id), s))}
        onDelete={() => { mutate(s => removeAllocation(s, selected.id)); setSelectedId(null); }}
      />}
    </div>
  );
}

function CanvasViewport() {
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized || fitted.current) return;
    const frame = requestAnimationFrame(() => { fitView({ padding: .15, maxZoom: 1 }); fitted.current = true; });
    return () => cancelAnimationFrame(frame);
  }, [initialized, fitView]);
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
