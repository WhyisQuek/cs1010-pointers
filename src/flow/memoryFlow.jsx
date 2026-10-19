/** React components for the pure layout adapter in layout.js. */
import { useLayoutEffect, useRef } from 'react';
import {
  BaseEdge,
  Handle,
  Position,
  useConnection,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { isArray, isPointer, isStruct, sizeOf, typeToString } from '../language/types.js';
import { referenceLocation } from '../machine/addresses.js';
import {
  allocationDisplayName,
  pointerCanTarget,
  ref,
  resolveRef,
  scalarSubobjects,
} from '../machine/memory.js';
import {
  describePointer,
  formatAddress,
  pointerAccessibleLabel,
  pointerCaption,
  scalarText,
} from './addressPresentation.js';
import { allocationMetrics, handleId, memoryMetricsStyle, pathFromHandle } from './layout.js';
import { NODE } from './structureLayout.js';

function FrameGroupNode({ id, data, selected }) {
  return (
    <>
      <div
        className="frame-group-label"
        title={data.callLabel ? undefined : 'Drag to move this call frame · Select to resize'}
      >
        <strong>{data.callLabel ?? `${data.frame.name}()`}</strong>
        <span>{data.running ? 'running' : data.frame.active ? 'active' : 'returned'}</span>
      </div>
      {selected && (
        <>
          <div className="frame-actions nodrag nopan">
            <button onClick={data.onFit}>Fit frame to contents</button>
            {data.editable && <button onClick={data.onAdd}>+ Variable</button>}
          </div>
          {['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(direction => (
            <FrameResize key={direction} id={id} direction={direction} data={data} />
          ))}
        </>
      )}
    </>
  );
}

function FrameResize({ id, direction, data }) {
  const { screenToFlowPosition, getNode } = useReactFlow();
  const drag = useRef(null);
  const point = event => screenToFlowPosition({ x: event.clientX, y: event.clientY });
  const rectAt = (rect, dx, dy) => ({
    x: rect.x + (direction.includes('w') ? dx : 0),
    y: rect.y + (direction.includes('n') ? dy : 0),
    width: rect.width + (direction.includes('e') ? dx : direction.includes('w') ? -dx : 0),
    height: rect.height + (direction.includes('s') ? dy : direction.includes('n') ? -dy : 0),
  });
  const rect = () => {
    const n = getNode(id);
    return { ...n.position, width: n.width, height: n.height };
  };
  const finish = () => {
    if (drag.current) {
      drag.current = null;
      data.onGestureEnd();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Resize frame ${direction}`}
      title="Drag to resize · Arrow keys for precise adjustment"
      className={`frame-resize frame-resize-${direction} nodrag nopan`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { point: point(event), rect: rect() };
        event.currentTarget.setPointerCapture(event.pointerId);
        data.onGestureStart();
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        const p = point(event),
          start = drag.current;
        data.onResize(rectAt(start.rect, p.x - start.point.x, p.y - start.point.y), direction);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 24 : 8;
        data.onGestureStart();
        data.onResize(
          rectAt(
            rect(),
            event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
            event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
          ),
          direction,
        );
        data.onGestureEnd();
      }}
    />
  );
}

function TargetHandles({ path = [], state, allocation, sourceType, editable }) {
  const target = ref(allocation.id, path);
  const available = editable && sourceType && pointerCanTarget(state, sourceType, target);
  const label = `${allocationDisplayName(state, allocation)}${formatPath(path)}`;
  return ['left', 'right'].map(side => (
    <Handle
      key={side}
      type="target"
      id={handleId('tgt', path, side)}
      position={side === 'left' ? Position.Left : Position.Right}
      className={`mem-handle tgt ${side}${available ? ' available-target' : ' hidden-handle'}`}
      title={`Point to &${label} (${typeToString(resolveRef(state, target).type)})`}
      isConnectable={!!available}
      isConnectableStart={false}
    />
  ));
}

/** Spoken/tooltip text for a value slot, which itself may show only "?" or "●". */
function valueText(state, value, type, chars) {
  if (isPointer(type)) {
    const d = describePointer(state, value);
    if (d.status === 'null') return 'NULL';
    if (d.status === 'uninitialized') return 'uninitialized';
    if (d.status === 'invalid') return 'invalid reference';
    return formatAddress(d.address);
  }
  return value.kind === 'scalar' ? scalarText(type, value.value, chars) : 'uninitialized';
}

/** The value drawn inside its own slot, like a memory cell in a textbook diagram. */
function Value({ state, value, type, showAddresses, chars }) {
  const full = valueText(state, value, type, chars);
  if (isPointer(type)) {
    const d = describePointer(state, value);
    const shown =
      d.status === 'null'
        ? 'NULL'
        : d.status === 'uninitialized'
          ? '?'
          : d.status === 'invalid'
            ? 'invalid'
            : showAddresses
              ? full
              : // Without numbers a pointer is the dot its arrow starts from.
                '●';
    const kind =
      d.status === 'uninitialized'
        ? 'uninit'
        : d.status === 'null'
          ? 'null'
          : ['dangling', 'invalid'].includes(d.status)
            ? 'dangling'
            : 'ptr';
    return (
      <span className={`val pointer-value ${kind}${shown === '●' ? ' dot' : ''}`} title={full}>
        {shown}
      </span>
    );
  }
  return (
    <span className={`val ${value.kind}`} title={full}>
      {value.kind === 'scalar' ? full : '?'}
    </span>
  );
}

function MemoryAllocationNode({ id, data, selected }) {
  const {
    allocation: a,
    state,
    bad,
    editable,
    changed,
    changedPaths,
    sourceSides,
    inspectedPath,
    targetPaths,
    view = 'both',
    chars = 'number',
  } = data;
  // Rows (or the whole object, "[]") that some pointer stores the address of.
  const targeted = path => targetPaths?.has(JSON.stringify(path));
  // Arrows hides numeric addresses; the boxes keep their size so changing view never overlaps them.
  // Structure view draws its other boxes the way Arrows does.
  const showAddresses = view !== 'arrows' && view !== 'structure';
  const fromHandle = useConnection(connection => connection.fromHandle);
  const sourceType =
    fromHandle?.type === 'source'
      ? resolveRef(state, ref(fromHandle.nodeId, pathFromHandle(fromHandle.id))).type
      : null;
  const targetProps = { state, allocation: a, sourceType, editable };
  const updateNodeInternals = useUpdateNodeInternals();
  const { rows: scalars, aggregate } = allocationMetrics(a, state);
  const aggregateHandles = new Set();
  const rowTargets = scalars.map(s => {
    const paths = [s.ref.path];
    for (let length = 1; length < s.ref.path.length; length++) {
      const path = s.ref.path.slice(0, length),
        key = path.join('.');
      if (!aggregateHandles.has(key)) {
        aggregateHandles.add(key);
        paths.push(path);
      }
    }
    return paths;
  });
  const signature = `${view}:${a.alive}:${JSON.stringify(a.type)}:${scalars.map(s => s.ref.path.join('.')).join('|')}`;
  // Type/array-size edits change handle geometry even when the node ID survives. The view is
  // included too: a box first measured while its arrow was hidden (Addresses view after a
  // reload) otherwise sometimes kept no usable handle bounds, and switching to Both drew no arrow.
  useLayoutEffect(() => {
    updateNodeInternals(id);
  }, [id, signature, updateNodeInternals]);
  return (
    <div
      style={memoryMetricsStyle}
      className={`mem-cell ${a.storage.kind}${!a.alive ? ' dead' : ''}${selected ? ' selected' : ''}${bad ? ' bad' : ''}${changed ? ' memory-changed' : ''}${showAddresses ? '' : ' no-addresses'}`}
    >
      <div className="head">
        {(isArray(a.type) || isStruct(a.type)) && <TargetHandles {...targetProps} />}
        <div className="head-line">
          <button
            className="name inspect-label nodrag"
            title={allocationDisplayName(state, a)}
            onClick={e => {
              e.stopPropagation();
              data.onInspect?.([]);
            }}
          >
            {allocationDisplayName(state, a)}
          </button>
          <span className="type" title={typeToString(a.type)}>
            {typeToString(a.type)}
          </span>
        </div>
        <div className="mem-meta">
          {showAddresses && (
            <>
              <code className={targeted([]) ? 'targeted' : ''} title="Address of this object">
                {formatAddress(a.baseAddress)}
              </code>
              {' · '}
            </>
          )}
          {sizeOf(a.type, state.structTypes)} bytes
        </div>
      </div>
      {!a.alive && (
        <div className="lifetime-banner">
          {a.storage.kind === 'heap' ? 'freed' : 'out of scope'}
        </div>
      )}
      <div className="subobject-list">
        {scalars.map((s, i) => {
          const pointerInfo = isPointer(s.type) ? describePointer(state, s.value) : null;
          const address = formatAddress(referenceLocation(state, s.ref).address);
          return (
            <div
              style={{ height: s.height }}
              className={`subobject-row${changedPaths?.has(JSON.stringify(s.ref.path)) ? ' value-changed' : ''}${JSON.stringify(inspectedPath) === JSON.stringify(s.ref.path) ? ' inspected-row' : ''}${targeted(s.ref.path) ? ' targeted' : ''}`}
              key={s.ref.path.join('.') || 'root'}
              aria-label={
                pointerInfo
                  ? pointerAccessibleLabel(state, s)
                  : `${allocationDisplayName(state, a)}${formatPath(s.ref.path)}, address ${address}, value ${valueText(state, s.value, s.type, chars)}`
              }
            >
              {rowTargets[i].map(path => (
                <TargetHandles key={path.join('.')} path={path} {...targetProps} />
              ))}
              <div className="memory-value-line">
                {/* A single value needs no label: the card's name already says what it is. */}
                {s.ref.path.length > 0 && (
                  <button
                    className="sub-label inspect-label nodrag"
                    title={`Inspect ${allocationDisplayName(state, a)}${formatPath(s.ref.path)}`}
                    onClick={e => {
                      e.stopPropagation();
                      data.onInspect?.(s.ref.path);
                    }}
                  >
                    {formatPath(s.ref.path)}
                  </button>
                )}
                {aggregate && showAddresses && (
                  <code
                    className="sub-address"
                    title={targeted(s.ref.path) ? 'A pointer stores this address' : undefined}
                  >
                    {address}
                  </code>
                )}
                <Value
                  state={state}
                  type={s.type}
                  value={s.value}
                  showAddresses={showAddresses}
                  chars={chars}
                />
              </div>
              {pointerInfo && (
                <div
                  className={`pointer-caption ${['dangling', 'invalid', 'one-past'].includes(pointerInfo.status) ? 'warning' : ''}`}
                  title={pointerCaption(pointerInfo)}
                >
                  {pointerCaption(pointerInfo)}
                </div>
              )}
              {pointerInfo &&
                ['left', 'right'].map(side => {
                  const available =
                    editable && side === (sourceSides?.[JSON.stringify(s.ref.path)] ?? 'right');
                  return (
                    <Handle
                      key={side}
                      type="source"
                      id={handleId('src', s.ref.path, side)}
                      position={side === 'left' ? Position.Left : Position.Right}
                      className={`mem-handle src${available ? '' : ' hidden-handle'}`}
                      title={`Drag to set ${allocationDisplayName(state, a)}${formatPath(s.ref.path)} — compatible targets appear as squares`}
                      isConnectable={available}
                      isConnectableEnd={false}
                    />
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatPath(path) {
  return path.map(x => (typeof x === 'number' ? `[${x}]` : `.${x}`)).join('');
}

/** Every path a pointer could target in an object: the whole, each member and each element. */
function targetPaths(scalars) {
  const seen = new Set(),
    out = [];
  for (const s of scalars)
    for (let length = 0; length <= s.ref.path.length; length++) {
      const path = s.ref.path.slice(0, length),
        key = path.join('.');
      if (!seen.has(key)) {
        seen.add(key);
        out.push(path);
      }
    }
  return out;
}

const slotKind = (state, value) => {
  const d = describePointer(state, value);
  return d.status === 'null'
    ? 'null'
    : d.status === 'uninitialized'
      ? 'uninit'
      : ['dangling', 'invalid'].includes(d.status)
        ? 'dangling'
        : 'ptr';
};

/** Hidden source and target handles on both sides of a one-line box, for edge geometry. */
function SideHandles({ path = [] }) {
  return ['left', 'right'].flatMap(side =>
    ['src', 'tgt'].map(kind => (
      <Handle
        key={`${kind}-${side}`}
        type={kind === 'src' ? 'source' : 'target'}
        id={handleId(kind, path, side)}
        position={side === 'left' ? Position.Left : Position.Right}
        className={`mem-handle ${kind} hidden-handle`}
        isConnectable={false}
      />
    )),
  );
}

/**
 * Structure view: a scalar or pointer local as one line in its frame. A pointer to a list or
 * tree node reads `→ 50` and shows as a cursor label on that node instead of an arrow.
 */
function StackLocalNode({ data, selected }) {
  const { allocation: a, state, chars, changed, cursorText, linkedLocal } = data;
  const name = allocationDisplayName(state, a);
  const pointer = isPointer(a.type);
  const d = pointer ? describePointer(state, a.value) : null;
  const text = !pointer
    ? valueText(state, a.value, a.type, chars)
    : cursorText
      ? `→ ${cursorText}`
      : d.status === 'null'
        ? 'NULL'
        : d.status === 'uninitialized'
          ? '?'
          : `● ${pointerCaption(d)}`;
  return (
    <div
      className={`stack-local${!a.alive ? ' dead' : ''}${selected ? ' selected' : ''}${changed ? ' value-changed' : ''}${linkedLocal === a.id ? ' linked' : ''}`}
      onMouseEnter={() => pointer && data.onLink?.(a.id)}
      onMouseLeave={() => pointer && data.onLink?.(null)}
    >
      <SideHandles />
      <button
        className="stack-local-name inspect-label nodrag"
        title={`Inspect ${name} (${typeToString(a.type)})`}
        onClick={e => {
          e.stopPropagation();
          data.onInspect?.([]);
        }}
      >
        {name}
      </button>
      <span
        className={`stack-local-value${pointer ? ` ${d.status === 'dangling' ? 'dangling' : d.status === 'valid' ? 'ptr' : 'null'}` : ''}`}
        title={
          cursorText
            ? `Pointer to node ${cursorText} (hover to show the arrow)`
            : valueText(state, a.value, a.type, chars)
        }
      >
        {text}
      </span>
    </div>
  );
}

/** Structure view: consecutive recursive calls folded into one row of the stack column. */
function FrameFoldNode({ data }) {
  return (
    <div className="frame-fold" title={data.calls.join(', ')}>
      <strong>
        {data.name}() × {data.calls.length}
      </strong>
      <button className="plain-btn nodrag" onClick={() => data.onUnfold?.()}>
        Show all calls
      </button>
    </div>
  );
}

/**
 * Structure view card for a node of a list or tree: its fields as a label, and one slot per
 * link along the bottom. Stack variables pointing at it are labels above it. Sizes, types and
 * addresses stay in the inspector. Read-only.
 */
function StructureNode({ id, data, selected }) {
  const { allocation: a, state, card, bad, changed, changedPaths, cursors = [] } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const scalars = scalarSubobjects(a, state);
  const signature = `${a.alive}:${card.width}:${card.slots.length}:${scalars.length}`;
  useLayoutEffect(() => {
    updateNodeInternals(id);
  }, [id, signature, updateNodeInternals]);
  const name = allocationDisplayName(state, a);
  const sourceHandles = path =>
    ['left', 'right'].map(side => (
      <Handle
        key={side}
        type="source"
        id={handleId('src', path, side)}
        position={side === 'left' ? Position.Left : Position.Right}
        className="mem-handle src hidden-handle"
        isConnectable={false}
      />
    ));
  const single = card.fields.length === 1 && !card.more;
  return (
    <div
      className={`structure-node${!a.alive ? ' dead' : ''}${data.unreachable ? ' unreachable' : ''}${selected ? ' selected' : ''}${bad ? ' bad' : ''}${changed ? ' memory-changed' : ''}`}
      style={{ '--structure-line': `${NODE.line}px`, '--structure-pad': `${NODE.labelTop}px` }}
    >
      {card.top > 0 && (
        // Inside the card, so labels never spill onto a neighbour or cover an arriving arrow.
        <div
          className="structure-band"
          style={{ height: card.top }}
          title={cursors.length ? `Pointed at by ${cursors.map(cursorText).join(', ')}` : undefined}
        >
          {cursors.map(c => (
            <span
              key={c.id}
              className={`structure-cursor${c.running ? ' running' : ''}${c.dangling ? ' dangling' : ''}${c.changed ? ' changed' : ''}${data.linkedLocal === c.sourceId ? ' linked' : ''}`}
              onMouseEnter={() => data.onLink?.(c.sourceId)}
              onMouseLeave={() => data.onLink?.(null)}
            >
              {c.tag && <span className="structure-cursor-tag">{c.tag}</span>}
              {c.name}
            </span>
          ))}
        </div>
      )}
      {data.unreachable && (
        <span
          className="structure-unreachable"
          title="No pointer reaches this node any more, so it can never be freed (a memory leak)"
        >
          unreachable
        </span>
      )}
      {targetPaths(scalars).map(path => (
        <TargetHandles
          key={path.join('.') || 'root'}
          path={path}
          state={state}
          allocation={a}
          editable={false}
        />
      ))}
      <div className={`structure-body${card.side ? ' side' : ''}`}>
        <button
          className={`structure-label inspect-label nodrag${single ? ' single' : ''}`}
          style={{ height: card.labelHeight, width: card.labelWidth }}
          title={`Inspect ${name} (${typeToString(a.type)})`}
          onClick={e => {
            e.stopPropagation();
            data.onInspect?.([]);
          }}
        >
          {!card.fields.length && <span className="structure-name">{name}</span>}
          {card.fields.map(f => (
            <span
              key={f.name}
              className={`structure-field${changedPaths?.has(JSON.stringify(f.path)) ? ' value-changed' : ''}`}
              title={`${name}.${f.name} = ${f.text}`}
            >
              {!single && <span className="structure-field-name">{f.name}</span>}
              <span className={`structure-field-value${f.pointer ? ' pointer' : ''}`}>
                {f.text}
              </span>
              {f.pointer && sourceHandles(f.path)}
            </span>
          ))}
          {card.more > 0 && <span className="structure-more">+{card.more} more</span>}
        </button>
        {!a.alive && <span className="structure-freed">freed</span>}
        {card.slots.length > 0 && (
          <div
            className="structure-slots"
            style={
              card.side
                ? { width: card.slots.length * NODE.sideSlot, height: card.labelHeight }
                : { height: NODE.slotRow }
            }
          >
            {card.slots.map(s => {
              const kind = slotKind(state, s.value);
              return (
                <div
                  key={s.path.join('.')}
                  className={`structure-slot${changedPaths?.has(JSON.stringify(s.path)) ? ' value-changed' : ''}`}
                  title={`${name}${formatPath(s.path)}: ${pointerCaption(describePointer(state, s.value))}`}
                  aria-label={pointerAccessibleLabel(state, { ...s, ref: ref(a.id, s.path) })}
                >
                  <span className="structure-slot-name">{s.label}</span>
                  <span className={`structure-slot-value ${kind}`}>
                    {kind === 'null' ? '∅' : kind === 'uninit' ? '?' : '●'}
                  </span>
                  {sourceHandles(s.path)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const cursorText = c => (c.tag ? `${c.name} (${c.tag})` : c.name);
function MemoryPointerEdge({ id, data, markerEnd, style, selected }) {
  const { screenToFlowPosition } = useReactFlow();
  const dragging = useRef(false);
  const finish = () => {
    if (dragging.current) {
      dragging.current = false;
      data.onGestureEnd();
    }
  };
  return (
    <>
      <BaseEdge
        id={id}
        path={data.path}
        markerEnd={markerEnd}
        style={{ ...style, strokeWidth: selected ? 3 : style.strokeWidth }}
        interactionWidth={20}
      />
      {selected && (
        <path
          className="edge-bend nodrag nopan"
          tabIndex={0}
          role="button"
          aria-label="Bend pointer arrow"
          d={`M ${data.bend.x} ${data.bend.y - 9} l 9 9 l -9 9 l -9 -9 Z`}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragging.current = true;
            data.onGestureStart();
          }}
          onPointerMove={event => {
            if (!dragging.current) return;
            const p = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            data.onBend({ x: p.x - data.midpoint.x, y: p.y - data.midpoint.y });
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={event => {
            event.stopPropagation();
            data.onReset();
          }}
          onKeyDown={event => {
            if (event.key === 'Home') {
              event.preventDefault();
              data.onReset();
              return;
            }
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 24 : 8;
            data.onBend({
              x:
                data.bend.x -
                data.midpoint.x +
                (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
              y:
                data.bend.y -
                data.midpoint.y +
                (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
            });
          }}
        />
      )}
    </>
  );
}
export const nodeTypes = {
  memoryAllocation: MemoryAllocationNode,
  frameGroup: FrameGroupNode,
  structureNode: StructureNode,
  stackLocal: StackLocalNode,
  frameFold: FrameFoldNode,
};
export const edgeTypes = { memoryPointer: MemoryPointerEdge };
