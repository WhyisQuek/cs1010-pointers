/** Interactive MemoryState editor. React Flow layout never becomes semantic state. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background,
  ControlButton,
  Controls,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { edgeTypes, nodeTypes } from '../flow/memoryFlow.jsx';
import { GEOMETRY, pathFromHandle, stateToFlow } from '../flow/layout.js';
import {
  captureLayout,
  contentSize,
  editTimeline,
  emptyLayout,
  emptyTimeline,
  initialHistory,
  layoutHistory,
  moveNode,
  resizeFrame,
} from '../flow/workspace.js';
import { isPointer, primitive, typeToString } from '../language/types.js';
import {
  addAllocation,
  addFrame,
  allocationDisplayName,
  getAllocation,
  makeState,
  pointerCanTarget,
  ref,
  resolveRef,
  setRefValue,
} from '../machine/memory.js';
import { upgradeMemoryState } from '../machine/addresses.js';
import { removeAllocation } from '../machine/editing.js';
import { describePointer, formatAddress } from '../flow/addressPresentation.js';
import MemoryInspector from './MemoryInspector.jsx';
import {
  CHAR_MODES,
  VIEW_MODES,
  useCharPreference,
  useViewPreference,
} from '../data/viewPreference.js';

const FIT = { padding: 0.15, maxZoom: 1 };
const TOAST_MS = 4000;
// Space kept between a revealed node and the canvas edge or the inspector.
const REVEAL_MARGIN = 24;

export default function MemoryCanvas({
  state: rawState,
  previousState = null,
  onChange,
  editable = false,
  badIds,
  onMessage,
  // Passed to the inspector: how to get struct types into a diagram that has none.
  structHint = null,
  // Structure view: heap objects to mark unreachable, when the caller knows the whole run.
  unreachable = null,
}) {
  const state = useMemo(
    () => (rawState.addressSpace ? rawState : upgradeMemoryState(rawState)),
    [rawState],
  );
  // React Flow names its arrowhead <marker> elements after this ID, '1' by default. Several
  // canvases stay mounted at once (hidden pages), so with a shared ID every arrow resolved
  // to the first canvas's markers; inside a hidden page those don't render, and arrows lost
  // their heads. A per-canvas ID keeps the markers apart.
  const flowId = `canvas-${useId().replace(/:/g, '')}`;
  const [inspection, setInspection] = useState(null);
  const [editedPreviousState, setEditedPreviousState] = useState(null);
  const [status, setStatus] = useState(null);
  const pendingReveal = useRef(null);
  const content = useRef(null);
  const notify = useCallback(
    message => {
      setStatus(message);
      onMessage?.(message);
    },
    [onMessage],
  );
  // Confirmations fade; errors stay until the next canvas action replaces them.
  useEffect(() => {
    if (status?.kind !== 'ok') return;
    const timer = setTimeout(() => setStatus(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const [history, setHistory] = useState(initialHistory);
  const historyRef = useRef(history);
  // Ctrl+Z order across layout steps and diagram edits; see editTimeline.
  const timeline = useRef(emptyTimeline());
  // Bumped on every timeline change so the Undo/Redo buttons re-render.
  const [, setTimelineVersion] = useState(0);
  const updateTimeline = useCallback((action, from = timeline.current) => {
    const next = editTimeline(from, action);
    if (next === timeline.current) return;
    timeline.current = next;
    setTimelineVersion(v => v + 1);
  }, []);
  const record = useCallback(entry => updateTimeline({ type: 'record', entry }), [updateTimeline]);
  const dispatch = useCallback(
    action => {
      const previous = historyRef.current;
      const next = layoutHistory(previous, action);
      if (next === previous) return;
      historyRef.current = next;
      setHistory(next);
      // A finished drag, resize or bend added one layout undo step.
      if ((action.type === 'set' || action.type === 'end') && next.past !== previous.past)
        record('layout');
    },
    [record],
  );
  // The last state this canvas emitted. Any other incoming state replaced the diagram.
  const emitted = useRef(rawState);
  useEffect(() => {
    if (rawState === emitted.current) return;
    emitted.current = rawState;
    updateTimeline({ type: 'forgetEdits' });
  }, [rawState, updateTimeline]);
  const wrap = useRef(null);
  const setLayout = useCallback(layout => dispatch({ type: 'set', layout }), [dispatch]);
  const begin = useCallback(() => dispatch({ type: 'begin' }), [dispatch]);
  const end = useCallback(() => dispatch({ type: 'end' }), [dispatch]);
  const [showExpired, setShowExpired] = useState(false);
  const [menu, setMenu] = useState(null);
  const [viewportSession, setViewportSession] = useState(0);
  const [flow, setFlow] = useState(null);
  const [measurements, setMeasurements] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [preferredView, setView] = useViewPreference();
  // Structure view is read-only; an editable diagram keeps its editing tools in Arrows.
  const view =
    editable && VIEW_MODES.find(m => m.id === preferredView)?.readOnly ? 'arrows' : preferredView;
  const structure = view === 'structure';
  const [chars, setChars] = useCharPreference();
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // Structure view: every recursive call shown instead of folded, and the stack variable
  // whose line and cursor label are highlighted together while hovered.
  const [unfold, setUnfold] = useState(false);
  const [linkedLocal, setLinkedLocal] = useState(null);
  const { nodes, edges } = useMemo(() => {
    const result = stateToFlow(state, {
      ...history.present,
      editable,
      badIds: badIds ?? new Set(),
      showExpired,
      previousState: previousState ?? (editable ? editedPreviousState : null),
      structure,
      chars,
      unfold,
      unreachable,
    });
    result.nodes = result.nodes.map(n => ({
      ...n,
      // Preserve React Flow's reported measurements across controlled-node updates.
      // Without these, handle bounds are discarded and auto-fit never settles.
      measured:
        measurements[n.id]?.width === n.width && measurements[n.id]?.height === n.height
          ? measurements[n.id]
          : undefined,
      selected: n.selectable !== false && n.id === selectedId,
    }));
    result.edges = result.edges.map(e => ({
      ...e,
      // The Addresses view keeps only the selected box's arrows, so a pointer can still be traced.
      hidden: view === 'addresses' && e.source !== selectedId,
      selected: e.selectable && e.id === selectedEdgeId,
    }));
    return result;
  }, [
    state,
    previousState,
    history.present,
    measurements,
    editable,
    badIds,
    showExpired,
    selectedId,
    selectedEdgeId,
    editedPreviousState,
    view,
    structure,
    chars,
    unfold,
    unreachable,
  ]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    // Structure view's positions are computed, never remembered: the other views keep theirs.
    if (structure) return;
    dispatch({ type: 'sync', layout: captureLayout(historyRef.current.present, nodes) });
  }, [nodes, dispatch, structure]);

  const emit = useCallback(
    next => {
      setEditedPreviousState(state);
      emitted.current = next;
      onChange?.(next);
      // Deleting from the inspector removes the focused button; keep Ctrl+Z reachable.
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body)
          wrap.current?.focus({ preventScroll: true });
      });
    },
    [state, onChange],
  );
  const nextStep = direction => {
    const entry = direction === 'undo' ? timeline.current.past.at(-1) : timeline.current.future[0];
    // Diagram edits only replay into a diagram that can still be edited.
    return entry && (entry === 'layout' || editable) ? entry : null;
  };
  const undoOrRedo = direction => {
    const entry = nextStep(direction);
    if (!entry) return;
    updateTimeline({ type: direction });
    if (entry === 'layout') dispatch({ type: direction });
    else {
      emit(direction === 'undo' ? entry.before : entry.after);
      setStatus(null);
    }
  };
  // `merge` names the field being edited; back-to-back edits of it are one undo step.
  const mutate = useCallback(
    (fn, merge = null) => {
      if (!editable) return false;
      try {
        const next = structuredClone(state),
          message = fn(next);
        record({ before: state, after: next, merge });
        emit(next);
        if (typeof message === 'string') notify({ kind: 'ok', text: message });
        else setStatus(null);
        return true;
      } catch (error) {
        notify({ kind: 'err', text: error.message });
        return false;
      }
    },
    [state, editable, notify, record, emit],
  );
  const closeInspector = () => {
    setSelectedId(null);
    setInspection(null);
  };
  const inspect = (allocationId, path = []) => {
    setSelectedId(allocationId);
    setSelectedEdgeId(null);
    setInspection(ref(allocationId, path));
    setMenu(null);
    pendingReveal.current = allocationId;
  };
  const showTarget = target => {
    const description = describePointer(state, { kind: 'pointer', target });
    if (!description.target) return;
    if (!description.allocation.alive) setShowExpired(true);
    inspect(target.allocationId, target.path);
    setStatus({
      kind: 'ok',
      text:
        description.status === 'one-past'
          ? `One-past boundary at ${formatAddress(description.address)}. Cannot dereference.`
          : `Showing ${description.qualifiedLabel}${description.status === 'dangling' ? ' (former target)' : ''}.`,
    });
  };
  // Pans just enough to keep a newly inspected node clear of the canvas edges and the
  // inspector overlay. Zoom never changes, and nodes already in view stay where they are.
  useEffect(() => {
    const id = pendingReveal.current;
    if (!flow || !id || !content.current || !nodes.some(n => n.id === id)) return;
    const request = requestAnimationFrame(() => {
      pendingReveal.current = null;
      const node = flow.getInternalNode(id);
      if (!node) return;
      const box = content.current.getBoundingClientRect();
      const panel = content.current.querySelector('.inspector')?.getBoundingClientRect();
      let right = box.width,
        bottom = box.height;
      // Side panel when it starts right of the left edge, bottom sheet otherwise.
      if (panel && panel.left - box.left > REVEAL_MARGIN) right = panel.left - box.left;
      else if (panel) bottom = panel.top - box.top;
      const { x, y, zoom } = flow.getViewport();
      const { x: nx, y: ny } = node.internals.positionAbsolute;
      const left = nx * zoom + x,
        top = ny * zoom + y,
        width = (node.measured.width ?? node.width) * zoom,
        height = (node.measured.height ?? node.height) * zoom;
      const shift = (start, size, limit) =>
        start < REVEAL_MARGIN
          ? REVEAL_MARGIN - start
          : start + size > limit - REVEAL_MARGIN
            ? Math.max(REVEAL_MARGIN - start, limit - REVEAL_MARGIN - start - size)
            : 0;
      const dx = shift(left, width, right),
        dy = shift(top, height, bottom);
      if (dx || dy) flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 180 });
    });
    return () => cancelAnimationFrame(request);
  }, [nodes, flow, selectedId]);
  const onNodesChange = useCallback(
    changes => {
      let currentNodes = nodesRef.current;
      for (const ch of changes) {
        const node = currentNodes.find(n => n.id === ch.id);
        if (ch.type === 'dimensions' && ch.dimensions)
          setMeasurements(p =>
            p[ch.id]?.width === ch.dimensions.width && p[ch.id]?.height === ch.dimensions.height
              ? p
              : { ...p, [ch.id]: ch.dimensions },
          );
        if (ch.type === 'position' && ch.position && node?.draggable) {
          const next = moveNode(historyRef.current.present, currentNodes, ch.id, ch.position);
          setLayout(next);
          currentNodes = currentNodes.map(n => ({
            ...n,
            position: next.positions[n.id] ?? n.position,
            ...(next.sizes[n.id] ?? {}),
          }));
          nodesRef.current = currentNodes;
        }
        if (ch.type === 'select') {
          setSelectedId(p => (ch.selected ? ch.id : p === ch.id ? null : p));
          if (ch.selected) setSelectedEdgeId(null);
        }
      }
      const removed = changes.filter(
        ch => ch.type === 'remove' && currentNodes.find(n => n.id === ch.id)?.deletable,
      );
      if (removed.length)
        mutate(s => {
          for (const ch of removed) removeAllocation(s, ch.id);
          return 'Deleted. Ctrl+Z undoes it.';
        });
    },
    [mutate, setLayout],
  );

  const onConnect = useCallback(
    ({ source, target, sourceHandle, targetHandle }) => {
      if (
        !editable ||
        !source ||
        !target ||
        !nodes.find(n => n.id === source)?.data.editable ||
        !nodes.find(n => n.id === target)?.data.editable
      )
        return;
      const sourceRef = ref(source, pathFromHandle(sourceHandle)),
        targetRef = ref(target, pathFromHandle(targetHandle));
      const src = resolveRef(state, sourceRef);
      if (!isPointer(src.type) || !pointerCanTarget(state, src.type, targetRef)) {
        const targetType = resolveRef(state, targetRef).type;
        onMessage?.({
          kind: 'err',
          text: `${typeToString(src.type)} cannot point to ${typeToString(targetType)}`,
        });
        return;
      }
      mutate(s => setRefValue(s, sourceRef, { kind: 'pointer', target: targetRef }));
    },
    [editable, state, nodes, mutate, onMessage],
  );

  const onEdgesChange = useCallback(
    changes => {
      for (const ch of changes)
        if (ch.type === 'select') {
          setSelectedEdgeId(p => (ch.selected ? ch.id : p === ch.id ? null : p));
          if (ch.selected) setSelectedId(null);
        }
      if (!editable) return;
      const removed = new Set(
        changes
          .filter(c => c.type === 'remove' && edges.find(e => e.id === c.id)?.deletable)
          .map(c => c.id),
      );
      if (!removed.size) return;
      mutate(s => {
        for (const e of edges)
          if (removed.has(e.id))
            setRefValue(s, ref(e.source, pathFromHandle(e.sourceHandle)), { kind: 'uninit' });
      });
    },
    [editable, edges, mutate],
  );

  const addBox = (storageKind, frameId = 'main', position) =>
    mutate(s => {
      if (storageKind === 'stack') {
        const frame = s.frames.find(f => f.id === frameId);
        if (frame && !frame.active) return;
        if (!frame) addFrame(s, { id: frameId, name: 'main' });
      }
      const a = addAllocation(s, {
        name: storageKind === 'stack' ? nextName(s) : null,
        type: primitive('int'),
        storage: storageKind === 'stack' ? { kind: 'stack', frameId } : { kind: 'heap' },
      });
      if (position) {
        const layout = captureLayout(historyRef.current.present, nodes);
        layout.positions[a.id] = {
          x: Math.max(GEOMETRY.padding, position.x),
          y: Math.max(GEOMETRY.top, position.y),
        };
        dispatch({ type: 'sync', layout });
      }
      setSelectedId(a.id);
      setMenu(null);
    });
  const clearDiagram = () => {
    const empty = makeState(state.structTypes);
    dispatch({ type: 'clear' });
    // Clear starts a fresh layout, so only the cleared diagram itself can be restored.
    updateTimeline({ type: 'record', entry: { before: state, after: empty } }, emptyTimeline());
    setViewportSession(s => s + 1);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setMenu(null);
    setInspection(null);
    // The focused menu item is about to unmount; move focus now so an immediate Ctrl+Z lands.
    wrap.current?.focus({ preventScroll: true });
    emit(empty);
    setEditedPreviousState(null);
    notify({ kind: 'ok', text: 'Cleared the diagram. Ctrl+Z restores it.' });
  };
  const selectedNode = nodes.find(n => n.id === selectedId);
  const selected = selectedNode?.data.allocation ?? null;
  // Returned calls and out-of-scope objects are hidden unless asked for.
  const hiddenCount =
    (state.frames ?? []).filter(f => !f.active).length +
    state.allocations.filter(
      a =>
        !a.alive &&
        a.storage.kind === 'stack' &&
        state.frames?.find(f => f.id === a.storage.frameId)?.active !== false,
    ).length;
  const selectedFrame =
    selectedNode?.type === 'frameGroup'
      ? selectedNode
      : nodes.find(n => n.id === selectedNode?.parentId);
  const addFrameId = selectedFrame?.data.editable ? selectedFrame.data.frame.id : 'main';
  const resetRoute = id => {
    const layout = {
      ...historyRef.current.present,
      routes: { ...historyRef.current.present.routes },
    };
    delete layout.routes[id];
    setLayout(layout);
  };
  const interactiveNodes = nodes.map(n => ({
    ...n,
    className: `${n.className ?? ''}${n.id === selectedFrame?.id ? ' frame-owner-active' : ''}`,
    data: {
      ...n.data,
      view,
      chars,
      linkedLocal,
      onLink: setLinkedLocal,
      onUnfold: () => setUnfold(true),
      onInspect: path => inspect(n.id, path),
      inspectedPath:
        inspection?.allocationId === n.id && selectedId === n.id ? inspection.path : undefined,
      onGestureStart: begin,
      onGestureEnd: end,
      onResize: (rect, direction) =>
        setLayout(resizeFrame(historyRef.current.present, nodesRef.current, n.id, rect, direction)),
      onFit: () =>
        setLayout({
          ...historyRef.current.present,
          sizes: { ...historyRef.current.present.sizes, [n.id]: contentSize(nodes, n.id) },
        }),
      onAdd: () => addBox('stack', n.data.frame?.id),
    },
  }));
  const interactiveEdges = edges.map(e => ({
    ...e,
    // Structure view's cursor arrows appear only while their variable is hovered.
    hidden: e.data?.cursorFor ? e.data.cursorFor !== linkedLocal : e.hidden,
    data: {
      ...e.data,
      onGestureStart: begin,
      onGestureEnd: end,
      onBend: offset =>
        setLayout({
          ...historyRef.current.present,
          routes: { ...historyRef.current.present.routes, [e.id]: offset },
        }),
      onReset: () => resetRoute(e.id),
    },
  }));
  // Frame menus place a variable at the click; the pane menu places a heap block there.
  const openMenu = (event, node = null) => {
    if (!editable || (node && (!node.data.frame || !node.data.editable))) return;
    event.preventDefault();
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const bounds = content.current.getBoundingClientRect();
    if (node) {
      setSelectedId(node.id);
      setSelectedEdgeId(null);
    }
    setMenu({
      frameId: node?.data.frame.id ?? null,
      x: Math.min(event.clientX - bounds.left, bounds.width - 180),
      y: Math.min(event.clientY - bounds.top, bounds.height - 120),
      position: node ? { x: point.x - node.position.x, y: point.y - node.position.y } : point,
    });
  };

  return (
    <div
      ref={wrap}
      tabIndex={-1}
      className="canvas-wrap"
      onKeyDown={event => {
        if (event.target.closest('input, textarea, select, [contenteditable=true]')) return;
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
          undoOrRedo(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
        }
        if (event.key === 'Escape') {
          // Escape closes the innermost thing first: the View menu, then menus and the inspector.
          if (viewMenuOpen) {
            setViewMenuOpen(false);
            return;
          }
          setMenu(null);
          closeInspector();
        }
      }}
    >
      <div className="canvas-content" ref={content}>
        <ReactFlow
          id={flowId}
          nodes={interactiveNodes}
          edges={interactiveEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          onInit={setFlow}
          elevateNodesOnSelect={false}
          elevateEdgesOnSelect={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={(_, connection) => onConnect(connection)}
          edgesReconnectable={editable}
          onNodeDragStart={begin}
          onNodeDragStop={end}
          onSelectionDragStart={begin}
          onSelectionDragStop={end}
          onNodeContextMenu={openMenu}
          onPaneContextMenu={event => openMenu(event)}
          onNodeClick={(_, node) => {
            if (['memoryAllocation', 'structureNode', 'stackLocal'].includes(node.type))
              pendingReveal.current = node.id;
          }}
          onPaneClick={() => {
            setMenu(null);
            setViewMenuOpen(false);
            closeInspector();
            setSelectedEdgeId(null);
          }}
          onMoveStart={() => setMenu(null)}
          nodesConnectable={editable}
          connectOnClick={false}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          fitView
          fitViewOptions={FIT}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <CanvasViewport key={viewportSession} />
          <Background color="#30363d" gap={24} size={1} />
          <Controls showInteractive={false} fitViewOptions={FIT}>
            <ControlButton
              onClick={() => undoOrRedo('undo')}
              disabled={!nextStep('undo')}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              ↶
            </ControlButton>
            <ControlButton
              onClick={() => undoOrRedo('redo')}
              disabled={!nextStep('redo')}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              ↷
            </ControlButton>
            <ControlButton
              onClick={() => setLayout(emptyLayout())}
              title="Reset layout (Ctrl+Z undoes it)"
              aria-label="Reset layout"
            >
              ↺
            </ControlButton>
          </Controls>
        </ReactFlow>
        <div className="canvas-overlay">
          <ViewMenu
            view={view}
            editable={editable}
            chars={chars}
            open={viewMenuOpen}
            onOpenChange={setViewMenuOpen}
            onChange={next => {
              setView(next);
              setViewMenuOpen(false);
            }}
            onCharsChange={next => {
              setChars(next);
              setViewMenuOpen(false);
            }}
          />
          {editable && (
            <>
              <button className="plain-btn" onClick={() => addBox('stack', addFrameId)}>
                + Variable
              </button>
              <button className="plain-btn" onClick={() => addBox('heap')}>
                + Heap block
              </button>
            </>
          )}
          {hiddenCount > 0 && (
            <button
              className="plain-btn canvas-chip"
              aria-pressed={showExpired}
              onClick={() => setShowExpired(v => !v)}
            >
              {showExpired ? 'Hide out-of-scope memory' : `Show out-of-scope (${hiddenCount})`}
            </button>
          )}
          {structure && unfold && (
            <button className="plain-btn canvas-chip" onClick={() => setUnfold(false)}>
              Fold recursive calls
            </button>
          )}
        </div>
        {menu && (
          <div className="canvas-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            {menu.frameId ? (
              <button
                className="plain-btn"
                role="menuitem"
                onClick={() => addBox('stack', menu.frameId, menu.position)}
              >
                Add variable here
              </button>
            ) : (
              <button
                className="plain-btn"
                role="menuitem"
                onClick={() => addBox('heap', undefined, menu.position)}
              >
                Add heap block here
              </button>
            )}
            {state.allocations.length > 0 && (
              <button className="plain-btn danger" role="menuitem" onClick={clearDiagram}>
                Clear diagram
              </button>
            )}
          </div>
        )}
        {selectedEdgeId && edges.some(e => e.id === selectedEdgeId && !e.hidden) && (
          <div className="edge-tools">
            <span>
              Drag the diamond to bend{editable ? ' · Drag the arrowhead to reconnect' : ''}
            </span>
            <button className="plain-btn" onClick={() => resetRoute(selectedEdgeId)}>
              Reset route
            </button>
          </div>
        )}
        {selected && (
          <MemoryInspector
            key={selected.id}
            allocation={selected}
            state={state}
            path={inspection?.allocationId === selected.id ? inspection.path : []}
            chars={chars}
            editable={!!selectedNode?.data.editable}
            onEdit={(fn, merge) => mutate(s => fn(getAllocation(s, selected.id), s), merge)}
            onDelete={() => {
              const label = allocationDisplayName(state, selected);
              const deleted = mutate(s => {
                removeAllocation(s, selected.id);
                return `Deleted ${label}. Ctrl+Z undoes it.`;
              });
              if (deleted) closeInspector();
            }}
            onRestore={
              editable && !selected.alive && selected.storage.kind === 'heap'
                ? () =>
                    mutate(s => {
                      getAllocation(s, selected.id).alive = true;
                      return 'Diagram edit: this block is allocated again. Ctrl+Z undoes it.';
                    })
                : undefined
            }
            onSelectPath={path => inspect(selected.id, path)}
            onShowTarget={showTarget}
            onClose={closeInspector}
            structHint={structHint}
          />
        )}
        <div
          className={`canvas-toast${status ? ` visible ${status.kind}` : ''}`}
          role="status"
          aria-live="polite"
        >
          {status?.text}
        </div>
      </div>
    </div>
  );
}

/**
 * "View: Both ▾" with a menu of the three presets, plus how char values read.
 * The menu closes on outside clicks.
 */
function ViewMenu({ view, editable, chars, open, onOpenChange, onChange, onCharsChange }) {
  const root = useRef(null);
  const toggle = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = event => {
      if (!root.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open, onOpenChange]);
  const current = VIEW_MODES.find(m => m.id === view) ?? VIEW_MODES[0];
  return (
    <div className="view-menu" ref={root}>
      <button
        ref={toggle}
        className="plain-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose whether the diagram shows addresses, arrows, both, or lists and trees in their own shape, and how char values read"
        onClick={() => onOpenChange(!open)}
      >
        View: {current.label} ▾
      </button>
      {open && (
        <div className="view-menu-list" role="menu" aria-label="View">
          <div className="view-menu-heading" role="presentation">
            Show
          </div>
          {VIEW_MODES.map(mode => (
            <button
              key={mode.id}
              role="menuitemradio"
              aria-checked={mode.id === view}
              disabled={editable && mode.readOnly}
              title={
                editable && mode.readOnly
                  ? 'Structure view is for playback. Editing uses Arrows.'
                  : undefined
              }
              onClick={() => {
                onChange(mode.id);
                // The chosen item disappears with the menu; keep focus (and Escape, Ctrl+Z) in the canvas.
                toggle.current?.focus();
              }}
            >
              <span className="view-menu-check" aria-hidden="true">
                {mode.id === view ? '✓' : ''}
              </span>
              {mode.label}
            </button>
          ))}
          <div className="view-menu-heading" role="presentation">
            char values
          </div>
          {CHAR_MODES.map(mode => (
            <button
              key={mode.id}
              role="menuitemradio"
              aria-checked={mode.id === chars}
              aria-label={`Show char values as ${mode.label.toLowerCase()}s, like ${mode.example}`}
              onClick={() => {
                onCharsChange(mode.id);
                toggle.current?.focus();
              }}
            >
              <span className="view-menu-check" aria-hidden="true">
                {mode.id === chars ? '✓' : ''}
              </span>
              {mode.label}
              <code className="view-menu-example" aria-hidden="true">
                {mode.example}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CanvasViewport() {
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized || fitted.current) return;
    const frame = requestAnimationFrame(() => {
      fitView(FIT);
      fitted.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, fitView]);
  return null;
}

/** First unused single-letter name, then v1, v2, ... (never a name already in use). */
function nextName(state) {
  const used = new Set(state.allocations.map(a => a.name));
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(ch)) return ch;
  let n = 1;
  while (used.has(`v${n}`)) n++;
  return `v${n}`;
}
