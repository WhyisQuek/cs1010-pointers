/** Interactive MemoryState editor. React Flow layout never becomes semantic state. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, useNodesInitialized, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { edgeTypes, nodeTypes } from '../flow/memoryFlow.jsx';
import { GEOMETRY, pathFromHandle, stateToFlow } from '../flow/layout.js';
import { captureLayout, contentSize, emptyLayout, initialHistory, layoutHistory, moveNode, resizeFrame } from '../flow/workspace.js';
import { isPointer, primitive, typeToString } from '../language/types.js';
import { addAllocation, addFrame, getAllocation, makeState, pointerCanTarget, ref, resolveRef, setRefValue } from '../machine/memory.js';
import { upgradeMemoryState } from '../machine/addresses.js';
import { removeAllocation } from '../machine/editing.js';
import { describePointer, formatAddress, readViewMode, saveViewMode, VIEW_MODES } from '../flow/addressPresentation.js';
import MemoryInspector from './MemoryInspector.jsx';

export default function MemoryCanvas({ state: rawState, previousState = null, onChange, editable = false, badIds, onMessage }) {
  const state = useMemo(() => rawState.addressSpace ? rawState : upgradeMemoryState(rawState), [rawState]);
  const [viewMode, setViewMode] = useState(readViewMode);
  const [inspection, setInspection] = useState(null);
  const [revealedPointer, setRevealedPointer] = useState(null);
  const [editedPreviousState, setEditedPreviousState] = useState(null);
  const [status, setStatus] = useState(null);
  const pendingFocus = useRef(null);
  const notify = useCallback(message => { setStatus(message); onMessage?.(message); }, [onMessage]);
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
    const result = stateToFlow(state, { ...history.present, editable, badIds: badIds ?? new Set(), showExpired, previousState: previousState ?? (editable ? editedPreviousState : null), viewMode, revealedPointer });
    result.nodes = result.nodes.map(n => ({
      ...n,
      // Preserve React Flow's reported measurements across controlled-node updates.
      // Without these, handle bounds are discarded and auto-fit never settles.
      measured: measurements[n.id]?.width === n.width && measurements[n.id]?.height === n.height ? measurements[n.id] : undefined,
      selected: n.selectable !== false && n.id === selectedId,
    }));
    result.edges = result.edges.map(e => ({ ...e, selected: e.selectable && e.id === selectedEdgeId }));
    return result;
  }, [state, previousState, history.present, measurements, editable, badIds, showExpired, selectedId, selectedEdgeId, editedPreviousState, viewMode, revealedPointer]);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  useEffect(() => {
    dispatch({ type: 'sync', layout: captureLayout(historyRef.current.present, nodes) });
  }, [nodes, dispatch]);

  const mutate = useCallback(fn => {
    if (!editable) return false;
    try {
      const next = structuredClone(state), message = fn(next);
      setEditedPreviousState(state); onChange?.(next);
      if (typeof message === 'string') notify({ kind: 'ok', text: message }); else setStatus(null);
      return true;
    } catch (error) { notify({ kind: 'err', text: error.message }); return false; }
  }, [state, onChange, editable, notify]);
  const closeInspector = () => { setSelectedId(null); setInspection(null); setRevealedPointer(null); };
  const inspect = (allocationId, path = []) => { setSelectedId(allocationId); setSelectedEdgeId(null); setInspection(ref(allocationId, path)); setRevealedPointer(null); };
  const showTarget = (target, source) => {
    const description = describePointer(state, { kind: 'pointer', target });
    if (!description.target) return;
    if (!description.allocation.alive) setShowExpired(true);
    inspect(target.allocationId, target.path);
    setRevealedPointer(source); pendingFocus.current = target.allocationId;
    setStatus({ kind: 'ok', text: description.status === 'one-past' ? `One-past boundary at ${formatAddress(description.address)}. Cannot dereference.` : `Showing ${description.qualifiedLabel}${description.status === 'dangling' ? ' (former target)' : ''}.` });
  };
  useEffect(() => {
    const target = nodes.find(n => n.id === pendingFocus.current);
    if (!flow || !target) return;
    const request = requestAnimationFrame(() => { flow.fitView({ nodes: [target], padding: .6, maxZoom: 1, duration: 180 }); pendingFocus.current = null; });
    return () => cancelAnimationFrame(request);
  }, [nodes, flow]);
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
  const selected = nodes.find(n => n.id === selectedId)?.data.allocation ?? null;
  const selectedNode = nodes.find(n => n.id === selectedId);
  const selectedFrame = selectedNode?.type === 'frameGroup' ? selectedNode : nodes.find(n => n.id === selectedNode?.parentId);
  const addFrameId = selectedFrame?.data.editable ? selectedFrame.data.frame.id : 'main';
  const resetRoute = id => {
    const layout = { ...historyRef.current.present, routes: { ...historyRef.current.present.routes } };
    delete layout.routes[id]; setLayout(layout);
  };
  const interactiveNodes = nodes.map(n => ({ ...n, className: `${n.className ?? ''}${n.id === selectedFrame?.id ? ' frame-owner-active' : ''}`, data: { ...n.data, onInspect: path => inspect(n.id, path), inspectedPath: inspection?.allocationId === n.id && selectedId === n.id ? inspection.path : undefined, onGestureStart: begin, onGestureEnd: end,
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
    const bounds = event.currentTarget.closest('.canvas-content').getBoundingClientRect();
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
      if (event.key === 'Escape') { setMenu(null); closeInspector(); }
    }}>
      <div className="canvas-toolbar">
        <div className="view-mode" role="group" aria-label="Memory view"><span>View</span>{VIEW_MODES.map(mode => <button key={mode} className="plain-btn" aria-pressed={viewMode === mode} onClick={() => { setViewMode(mode); saveViewMode(mode); setSelectedEdgeId(null); setStatus({ kind: 'ok', text: `${mode[0].toUpperCase() + mode.slice(1)} view` }); }}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>
        <label className="view-mode-select">View<select value={viewMode} onChange={e => { setViewMode(e.target.value); saveViewMode(e.target.value); setSelectedEdgeId(null); setStatus({ kind: 'ok', text: `${e.target.value} view` }); }}>{VIEW_MODES.map(mode => <option key={mode} value={mode}>{mode[0].toUpperCase() + mode.slice(1)}</option>)}</select></label>
        <details className="address-model-info"><summary>Simulated addresses</summary><p>Addresses follow PointerViz’s 64-bit teaching model. Arrays and fields use byte offsets. Separate objects use spaced addresses that stay stable while you edit. Native addresses and placement can differ. Addresses are not reused during a run.</p></details>
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
        {state.allocations.length > 0 && <button className="plain-btn danger" onClick={() => { dispatch({ type: 'clear' }); setViewportSession(s => s + 1); setSelectedId(null); setSelectedEdgeId(null); setMenu(null); setInspection(null); setRevealedPointer(null); setEditedPreviousState(null); onChange?.(makeState(state.structTypes)); }}>Clear</button>}
      </div>}
      <div className="canvas-content">
      <ReactFlow
        nodes={interactiveNodes} edges={interactiveEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode="dark"
        onInit={setFlow} elevateNodesOnSelect={false} elevateEdgesOnSelect={false}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onReconnect={(_, connection) => onConnect(connection)} edgesReconnectable={editable}
        onNodeDragStart={begin} onNodeDragStop={end} onSelectionDragStart={begin} onSelectionDragStop={end}
        onNodeContextMenu={contextMenu} onPaneClick={() => { setMenu(null); closeInspector(); setSelectedEdgeId(null); }}
        onMoveStart={() => setMenu(null)} snapToGrid={snap} snapGrid={[24, 24]}
        nodesConnectable={editable} connectOnClick={false} deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.1} proOptions={{ hideAttribution: true }}
      >
        <CanvasViewport key={viewportSession} />
        <Background color="#30363d" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menu && <div className="canvas-context-menu" style={{ left: menu.x, top: menu.y }}>
        <button className="plain-btn" onClick={() => addBox('stack', menu.frameId, menu.position)}>Add variable here</button>
      </div>}
      {selectedEdgeId && edges.some(e => e.id === selectedEdgeId && !e.hidden) && <div className="edge-tools">
        <span>Drag the diamond to bend{editable ? ' · Drag the arrowhead to reconnect' : ''}</span>
        <button className="plain-btn" onClick={() => resetRoute(selectedEdgeId)}>Reset route</button>
      </div>}
      {selected && <MemoryInspector
        key={selected.id} allocation={selected} state={state}
        path={inspection?.allocationId === selected.id ? inspection.path : []}
        editable={!!selectedNode?.data.editable}
        onEdit={fn => mutate(s => fn(getAllocation(s, selected.id), s))}
        onDelete={() => { if (mutate(s => removeAllocation(s, selected.id))) closeInspector(); }}
        onSelectPath={path => inspect(selected.id, path)} onShowTarget={showTarget} onClose={closeInspector}
      />}
      </div>
      <div className={`canvas-status ${status?.kind ?? ''}`} role="status" aria-live="polite">{status?.text}</div>
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

function nextName(state) { const used = new Set(state.allocations.map(a => a.name)); for (const ch of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(ch)) return ch; return `v${state.allocations.length}`; }
