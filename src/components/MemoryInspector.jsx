/** Side panel for inspecting one object or member and editing it in editable diagrams. */
import { useEffect, useMemo, useState } from 'react';
import {
  PRIMITIVE_NAMES,
  array,
  basePrimitive,
  isArray,
  isPointer,
  isPrimitive,
  pointer,
  pointerDepth,
  primitive,
  sizeOf,
  typeEquals,
  typeToString,
} from '../language/types.js';
import { MAX_ARRAY_LENGTH, clampArrayLength } from '../language/limits.js';
import { scalarFromInput } from '../language/numeric.js';
import {
  addressableSubobjects,
  allocationDisplayName,
  pointerCanTarget,
  ref,
  resolveRef,
  setRefValue,
} from '../machine/memory.js';
import { referenceLocation } from '../machine/addresses.js';
import { changeAllocationType } from '../machine/editing.js';
import {
  describePointer,
  formatAddress,
  qualifiedLabel,
  valueSummary,
} from '../flow/addressPresentation.js';

export default function MemoryInspector({
  allocation: a,
  state,
  path = [],
  editable,
  onEdit,
  onDelete,
  onSelectPath,
  onShowTarget,
  onClose,
}) {
  const [name, setName] = useState(a.name ?? '');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setName(a.name ?? '');
    setNotice('');
  }, [a.name, a.id]);
  const subobjects = useMemo(() => addressableSubobjects(a, state), [a, state]);
  let selected;
  try {
    selected = resolveRef(state, ref(a.id, path));
    if (selected.invalid) throw new Error();
  } catch {
    selected = resolveRef(state, ref(a.id));
  }
  const location = referenceLocation(state, selected.ref),
    label = selected.label;
  const writable = editable && a.alive && !selected.onePast;
  const d =
    isPointer(selected.type) && !selected.onePast ? describePointer(state, selected.value) : null;
  const candidates = useMemo(() => {
    if (!isPointer(selected.type) || !writable) return [];
    return state.allocations
      .filter(
        obj =>
          obj.alive &&
          (obj.storage.kind !== 'stack' ||
            !state.frames.find(f => f.id === obj.storage.frameId && !f.active)),
      )
      .map(obj => ({
        allocation: obj,
        targets: addressableSubobjects(obj, state).filter(item =>
          pointerCanTarget(state, selected.type, item.ref),
        ),
      }))
      .filter(group => group.targets.length);
  }, [state, selected.type, writable]);
  const copy = async (value, name) => {
    try {
      await navigator.clipboard.writeText(formatAddress(value, true));
      setNotice(`Copied ${name}.`);
    } catch {
      setNotice('Copy unavailable. Select the address text to copy it.');
    }
  };
  const addressFact = (title, address) => (
    <div className="address-fact">
      <dt>{title}</dt>
      <dd>
        <code title={formatAddress(address, true)}>{formatAddress(address)}</code>
        {Number.isSafeInteger(address) && (
          <button
            className="mini-btn"
            aria-label={`Copy ${title}`}
            onClick={() => copy(address, title)}
          >
            Copy
          </button>
        )}
      </dd>
    </div>
  );
  const scalarType = isArray(a.type) ? a.type.of : a.type;
  let leaf = scalarType;
  while (isPointer(leaf)) leaf = leaf.to;
  const canEditType = isPrimitive(leaf) && (isPrimitive(scalarType) || isPointer(scalarType));
  const editor = {
    shape: isArray(a.type) ? 'array' : 'scalar',
    base: basePrimitive(scalarType),
    stars: pointerDepth(scalarType),
    length: isArray(a.type) ? a.type.length : 3,
  };
  const setType = patch => {
    const next = { ...editor, ...patch };
    let type = primitive(next.base);
    for (let i = 0; i < next.stars; i++) type = pointer(type);
    if (next.shape === 'array') type = array(type, clampArrayLength(next.length));
    // size_t and unsigned long are one type; only the displayed spelling changes.
    if (typeEquals(a.type, type) && typeToString(a.type) === typeToString(type)) return;
    onEdit((obj, s) => {
      const moved = changeAllocationType(s, obj.id, type);
      return moved ? `${moved} pointer target location(s) changed with the object layout.` : null;
    });
  };
  const targetValue =
    selected.value?.kind === 'pointer'
      ? `ref:${JSON.stringify(selected.value.target)}`
      : (selected.value?.kind ?? 'uninit');
  const targetListed = candidates.some(group =>
    group.targets.some(item => `ref:${JSON.stringify(item.ref)}` === targetValue),
  );
  const lifetime = a.alive ? null : a.storage.kind === 'heap' ? 'freed' : 'out of scope';
  const pointsTo = !d
    ? null
    : d.status === 'null'
      ? 'NULL · no target'
      : d.status === 'uninitialized'
        ? 'Uninitialized · no stored address'
        : d.status === 'valid'
          ? (d.qualifiedLabel ?? d.label)
          : `${d.status === 'dangling' ? 'Dangling · former target' : d.status} ${d.qualifiedLabel ?? d.label}`;
  return (
    <aside className="inspector" aria-label={`Inspect ${allocationDisplayName(state, a)}`}>
      <div className="inspector-heading">
        <h4>
          {label} <span className="inspector-type">· {typeToString(selected.type)}</span>
        </h4>
        <button className="mini-btn" onClick={onClose} aria-label="Close inspector" title="Close">
          ✕
        </button>
      </div>
      {subobjects.length > 1 && (
        <label>
          Object or member
          <select
            aria-label="Inspect object or member"
            value={JSON.stringify(selected.ref.path)}
            onChange={e => onSelectPath(JSON.parse(e.target.value))}
          >
            {selected.onePast && (
              <option value={JSON.stringify(selected.ref.path)}>{selected.label} · one-past</option>
            )}
            {subobjects.map(item => (
              <option key={JSON.stringify(item.ref.path)} value={JSON.stringify(item.ref.path)}>
                {resolveRef(state, item.ref).label} · {typeToString(item.type)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="inspector-summary">
        {qualifiedLabel(state, selected.ref)} ·{' '}
        {selected.onePast
          ? 'one-past · no storage'
          : `${sizeOf(selected.type, state.structTypes)} bytes`}{' '}
        · +{location.offset}
        {lifetime && <span className="warning"> · {lifetime}</span>}
      </div>
      <dl className="address-facts">
        {addressFact(selected.onePast ? 'Boundary at' : `Located at (&${label})`, location.address)}
        {d ? (
          <>
            {addressFact(`Stores (${label})`, d.address)}
            <div className="address-fact">
              <dt>Points to</dt>
              <dd
                className={['dangling', 'invalid', 'one-past'].includes(d.status) ? 'warning' : ''}
              >
                <span>{pointsTo}</span>
                {d.target && (
                  <button className="mini-btn" onClick={() => onShowTarget(d.target)}>
                    Show
                  </button>
                )}
              </dd>
            </div>
            <div>
              <dt>Value (*{label})</dt>
              <dd>
                {d.status === 'valid' ? valueSummary(state, d.type, d.value) : 'Cannot dereference'}
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Value</dt>
            <dd>
              {selected.onePast
                ? 'Cannot dereference'
                : valueSummary(state, selected.type, selected.value)}
            </dd>
          </div>
        )}
      </dl>
      {writable && (
        <>
          {isPointer(selected.type) ? (
            <label>
              Target
              <select
                aria-label={`Target of ${label}`}
                value={targetValue}
                onChange={e => {
                  const v = e.target.value;
                  onEdit((obj, s) =>
                    setRefValue(
                      s,
                      selected.ref,
                      v.startsWith('ref:')
                        ? { kind: 'pointer', target: JSON.parse(v.slice(4)) }
                        : { kind: v },
                    ),
                  );
                }}
              >
                <option value="uninit">Uninitialized</option>
                <option value="null">NULL</option>
                {selected.value.kind === 'pointer' && !targetListed && (
                  <option value={targetValue} disabled>
                    {d?.qualifiedLabel ?? 'Invalid reference'} · {d?.status}
                  </option>
                )}
                {candidates.map(group => (
                  <optgroup
                    key={group.allocation.id}
                    label={qualifiedLabel(state, ref(group.allocation.id))}
                  >
                    {group.targets.map(item => (
                      <option
                        key={JSON.stringify(item.ref)}
                        value={`ref:${JSON.stringify(item.ref)}`}
                      >
                        {resolveRef(state, item.ref).label} · {typeToString(item.type)} ·{' '}
                        {formatAddress(referenceLocation(state, item.ref).address)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ) : selected.type.name === 'bool' ? (
            <label>
              Value of {label}
              <select
                aria-label={`Value of ${label}`}
                value={selected.value.kind === 'scalar' ? String(selected.value.value) : ''}
                onChange={e =>
                  onEdit((obj, s) =>
                    setRefValue(
                      s,
                      selected.ref,
                      e.target.value === ''
                        ? { kind: 'uninit' }
                        : { kind: 'scalar', value: Number(e.target.value) },
                    ),
                  )
                }
              >
                <option value="">Uninitialized</option>
                <option value="1">true</option>
                <option value="0">false</option>
              </select>
            </label>
          ) : (
            isPrimitive(selected.type) && (
              <label>
                Value of {label}
                <input
                  type="number"
                  aria-label={`Value of ${label}`}
                  value={selected.value.kind === 'scalar' ? selected.value.value : ''}
                  placeholder="uninitialized"
                  onChange={e =>
                    onEdit((obj, s) =>
                      setRefValue(
                        s,
                        selected.ref,
                        e.target.value === ''
                          ? { kind: 'uninit' }
                          : {
                              kind: 'scalar',
                              value: scalarFromInput(e.target.value, selected.type),
                            },
                      ),
                    )
                  }
                />
              </label>
            )
          )}
        </>
      )}
      {editable && a.alive && (
        <div className="object-editor">
          {(a.storage.kind === 'stack' || canEditType) && (
            <div className="type-row">
              {a.storage.kind === 'stack' && (
                <label>
                  Name
                  <input
                    aria-label="Object name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onBlur={() => {
                      if (name !== a.name)
                        onEdit(obj => {
                          obj.name = name;
                        });
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </label>
              )}
              {canEditType && (
                <label>
                  Shape
                  <select
                    aria-label="Object shape"
                    value={editor.shape}
                    onChange={e => setType({ shape: e.target.value })}
                  >
                    <option value="scalar">scalar</option>
                    <option value="array">array</option>
                  </select>
                </label>
              )}
            </div>
          )}
          {canEditType && (
            <>
              <div className="type-row">
                <label>
                  Type
                  <select
                    aria-label="Object base type"
                    value={editor.base}
                    onChange={e => setType({ base: e.target.value })}
                  >
                    {PRIMITIVE_NAMES.map(t => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Pointer depth
                  <select
                    aria-label="Pointer depth"
                    value={editor.stars}
                    onChange={e => setType({ stars: Number(e.target.value) })}
                  >
                    {Array.from({ length: Math.max(3, editor.stars) + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {'*'.repeat(n) || '(value)'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {editor.shape === 'array' && (
                <label>
                  Array length (max {MAX_ARRAY_LENGTH})
                  <input
                    type="number"
                    aria-label="Array length"
                    min="1"
                    max={MAX_ARRAY_LENGTH}
                    value={editor.length}
                    onChange={e => setType({ length: clampArrayLength(e.target.value) })}
                  />
                </label>
              )}
            </>
          )}
          <div className="inspector-actions">
            {a.storage.kind === 'heap' && (
              <button
                className="plain-btn"
                onClick={() =>
                  onEdit(obj => {
                    obj.alive = false;
                  })
                }
              >
                Mark as freed
              </button>
            )}
            <button className="plain-btn danger" onClick={onDelete}>
              Delete object
            </button>
          </div>
        </div>
      )}
      <p className="inspector-help">
        Simulated addresses; real programs may place objects differently.
      </p>
      <div className="inspector-notice" role="status" aria-live="polite">
        {notice}
      </div>
    </aside>
  );
}
