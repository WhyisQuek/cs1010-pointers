import React, { useEffect, useMemo, useState } from 'react';
import { array, basePrimitive, isArray, isPointer, isPrimitive, pointer, pointerDepth, primitive, sizeOf, typeEquals, typeToString } from '../language/types.js';
import { MAX_ARRAY_LENGTH, clampArrayLength } from '../language/limits.js';
import { addressableSubobjects, allocationDisplayName, pointerCanTarget, ref, resolveRef, setRefValue } from '../machine/memory.js';
import { referenceLocation } from '../machine/addresses.js';
import { changeAllocationType } from '../machine/editing.js';
import { describePointer, formatAddress, qualifiedLabel, valueSummary } from '../flow/addressPresentation.js';

export default function MemoryInspector({ allocation: a, state, path = [], editable, onEdit, onDelete, onSelectPath, onShowTarget, onClose }) {
  const [name, setName] = useState(a.name ?? '');
  const [notice, setNotice] = useState('');
  useEffect(() => { setName(a.name ?? ''); setNotice(''); }, [a.name, a.id]);
  const subobjects = useMemo(() => addressableSubobjects(a, state), [a, state.structTypes]);
  let selected;
  try { selected = resolveRef(state, ref(a.id, path)); if (selected.invalid) throw new Error(); }
  catch { selected = resolveRef(state, ref(a.id)); }
  const location = referenceLocation(state, selected.ref), label = selected.label;
  const writable = editable && a.alive && !selected.onePast;
  const d = isPointer(selected.type) && !selected.onePast ? describePointer(state, selected.value) : null;
  const candidates = useMemo(() => {
    if (!isPointer(selected.type) || !writable) return [];
    return state.allocations.filter(obj => obj.alive && (obj.storage.kind !== 'stack' || !state.frames.find(f => f.id === obj.storage.frameId && !f.active)))
      .map(obj => ({ allocation: obj, targets: addressableSubobjects(obj, state).filter(item => pointerCanTarget(state, selected.type, item.ref)) }))
      .filter(group => group.targets.length);
  }, [state, selected.type, writable]);
  const copy = async (value, name) => {
    try { await navigator.clipboard.writeText(formatAddress(value, true)); setNotice(`Copied ${name}.`); }
    catch { setNotice('Copy unavailable. Select the address text to copy it.'); }
  };
  const addressFact = (title, address) => <div className="address-fact"><dt>{title}</dt><dd><code>{formatAddress(address, true)}</code>{Number.isSafeInteger(address) && <button className="mini-btn" aria-label={`Copy ${title}`} onClick={() => copy(address, title)}>Copy</button>}</dd></div>;
  const scalarType = isArray(a.type) ? a.type.of : a.type;
  let leaf = scalarType; while (isPointer(leaf)) leaf = leaf.to;
  const canEditType = isPrimitive(leaf) && (isPrimitive(scalarType) || isPointer(scalarType));
  const editor = { shape: isArray(a.type) ? 'array' : 'scalar', base: basePrimitive(scalarType), stars: pointerDepth(scalarType), length: isArray(a.type) ? a.type.length : 3 };
  const setType = patch => {
    const next = { ...editor, ...patch };
    let type = primitive(next.base);
    for (let i = 0; i < next.stars; i++) type = pointer(type);
    if (next.shape === 'array') type = array(type, clampArrayLength(next.length));
    if (typeEquals(a.type, type)) return;
    onEdit((obj, s) => {
      const moved = changeAllocationType(s, obj.id, type);
      return moved ? `${moved} pointer target location(s) changed with the object layout.` : null;
    });
  };
  const targetValue = selected.value?.kind === 'pointer' ? `ref:${JSON.stringify(selected.value.target)}` : selected.value?.kind ?? 'uninit';
  const targetListed = candidates.some(group => group.targets.some(item => `ref:${JSON.stringify(item.ref)}` === targetValue));
  return <aside className="inspector" aria-label={`Inspect ${allocationDisplayName(state, a)}`}>
    <div className="inspector-heading"><h4>Inspect {allocationDisplayName(state, a)}</h4><button className="plain-btn" onClick={onClose} aria-label="Close inspector">Close</button></div>
    {subobjects.length > 1 && <label>Object or member<select aria-label="Inspect object or member" value={JSON.stringify(selected.ref.path)} onChange={e => onSelectPath(JSON.parse(e.target.value))}>
      {selected.onePast && <option value={JSON.stringify(selected.ref.path)}>{selected.label} · one-past</option>}
      {subobjects.map(item => <option key={JSON.stringify(item.ref.path)} value={JSON.stringify(item.ref.path)}>{resolveRef(state, item.ref).label} · {typeToString(item.type)}</option>)}
    </select></label>}
    <div className="inspector-summary">{qualifiedLabel(state, selected.ref)} · {typeToString(selected.type)}<br />{a.storage.kind} · {a.alive ? 'alive' : a.storage.kind === 'heap' ? 'freed' : 'out of scope'}</div>
    <dl className="address-facts">
      {addressFact(selected.onePast ? 'Boundary address' : `Address of ${label} (&${label})`, location.address)}
      <div><dt>{selected.onePast ? 'Boundary' : 'Size and offset'}</dt><dd>{selected.onePast ? 'One-past · no storage here' : `${sizeOf(selected.type, state.structTypes)} bytes`} · +{location.offset} bytes from {allocationDisplayName(state, a)}</dd></div>
      {d && <>
        {addressFact(`Stored address (${label})`, d.address)}
        <div><dt>Pointer status</dt><dd className={['dangling', 'invalid', 'one-past'].includes(d.status) ? 'warning' : ''}>{d.status === 'null' ? 'NULL · no target' : d.status}{d.status === 'uninitialized' && ' · stored address unknown'}</dd></div>
        <div><dt>{d.status === 'dangling' ? 'Former target' : 'Target'}</dt><dd>{d.qualifiedLabel ?? d.label}</dd></div>
        <div><dt>Target value (*{label})</dt><dd>{d.status === 'valid' ? valueSummary(state, d.type, d.value) : 'Cannot dereference'}</dd></div>
      </>}
      {!d && <div><dt>Value</dt><dd>{selected.onePast ? 'Cannot dereference' : valueSummary(state, selected.type, selected.value)}</dd></div>}
    </dl>
    {d?.target && <button className="plain-btn" onClick={() => onShowTarget(d.target, selected.ref)}>{d.status === 'one-past' ? 'Show boundary' : d.status === 'dangling' ? 'Show expired target' : 'Show target'}</button>}
    {d && <p className="inspector-help">A pointer has its own address and stores the address of its target. Pointers occupy 8 bytes; canvas addresses omit leading zeros.</p>}
    {writable && <>
      {isPointer(selected.type) ? <label>Target<select aria-label={`Target of ${label}`} value={targetValue} onChange={e => {
        const v = e.target.value;
        onEdit((obj, s) => setRefValue(s, selected.ref, v.startsWith('ref:') ? { kind: 'pointer', target: JSON.parse(v.slice(4)) } : { kind: v }));
      }}>
        <option value="uninit">Uninitialized</option><option value="null">NULL</option>
        {selected.value.kind === 'pointer' && !targetListed && <option value={targetValue} disabled>{d?.qualifiedLabel ?? 'Invalid reference'} · {d?.status}</option>}
        {candidates.map(group => <optgroup key={group.allocation.id} label={qualifiedLabel(state, ref(group.allocation.id))}>
          {group.targets.map(item => <option key={JSON.stringify(item.ref)} value={`ref:${JSON.stringify(item.ref)}`}>{resolveRef(state, item.ref).label} · {typeToString(item.type)} · {formatAddress(referenceLocation(state, item.ref).address)}</option>)}
        </optgroup>)}
      </select></label> : isPrimitive(selected.type) && <label>Value of {label}<input type="number" aria-label={`Value of ${label}`} value={selected.value.kind === 'scalar' ? selected.value.value : ''} placeholder="uninitialized" onChange={e => onEdit((obj, s) => setRefValue(s, selected.ref, e.target.value === '' ? { kind: 'uninit' } : { kind: 'scalar', value: Number(e.target.value) }))} /></label>}
    </>}
    {editable && a.alive && <div className="object-editor">
      <h4>Edit object</h4>
      {a.storage.kind === 'stack' && <label>Name<input aria-label="Object name" value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (name !== a.name) onEdit(obj => { obj.name = name; }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>}
      {canEditType && <>
        <label>Shape<select aria-label="Object shape" value={editor.shape} onChange={e => setType({ shape: e.target.value })}><option value="scalar">scalar</option><option value="array">array</option></select></label>
        <div className="type-row"><label>Type<select aria-label="Object base type" value={editor.base} onChange={e => setType({ base: e.target.value })}>{['int', 'char', 'short', 'long', 'unsigned int', 'unsigned long', 'float', 'double'].map(t => <option key={t}>{t}</option>)}</select></label>
          <label>Pointer depth<select aria-label="Pointer depth" value={editor.stars} onChange={e => setType({ stars: Number(e.target.value) })}>{Array.from({ length: Math.max(3, editor.stars) + 1 }, (_, n) => <option key={n} value={n}>{'*'.repeat(n) || '(value)'}</option>)}</select></label></div>
        {editor.shape === 'array' && <label>Array length (max {MAX_ARRAY_LENGTH})<input type="number" aria-label="Array length" min="1" max={MAX_ARRAY_LENGTH} value={editor.length} onChange={e => setType({ length: clampArrayLength(e.target.value) })} /></label>}
      </>}
      {a.storage.kind === 'heap' && <button className="plain-btn" onClick={() => onEdit(obj => { obj.alive = false; })}>Mark as freed</button>}
      <button className="plain-btn danger" onClick={onDelete}>Delete object</button>
    </div>}
    <div className="inspector-notice" role="status" aria-live="polite">{notice}</div>
  </aside>;
}
