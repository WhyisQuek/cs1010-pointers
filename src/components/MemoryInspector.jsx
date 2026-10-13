/** Side panel for inspecting one object or member and editing it in editable diagrams. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PRIMITIVE_NAMES,
  array,
  basePrimitive,
  declarationToC,
  isArray,
  isPointer,
  isPrimitive,
  isStruct,
  pointer,
  pointerDepth,
  primitive,
  sizeOf,
  typeEquals,
  typeToString,
  variableNameError,
} from '../language/types.js';
import { MAX_ARRAY_LENGTH, clampArrayLength } from '../language/limits.js';
import { encodeCharLiteral } from '../language/literals.js';
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
  frameLabel,
  lifetimeNote,
  qualifiedLabel,
  valueSummary,
} from '../flow/addressPresentation.js';

/** Short picker text for a member path: `[2].x`, or "whole array" for the object itself. */
function memberSuffix(path, type) {
  if (!path.length)
    return isArray(type) ? 'whole array' : isStruct(type) ? 'whole struct' : 'whole';
  return path.map(part => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('');
}

/** An "i" icon that shows `tip` in a styled bubble on hover or keyboard focus. */
function InfoDot({ tip }) {
  return (
    <span className="info-dot" tabIndex={0} role="img" aria-label={tip} data-tip={tip}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7.25v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
      </svg>
    </span>
  );
}

export default function MemoryInspector({
  allocation: a,
  state,
  path = [],
  chars = 'number',
  editable: editableDiagram,
  onEdit,
  onDelete,
  onRestore,
  onSelectPath,
  onShowTarget,
  onClose,
  // When the diagram knows no struct types: a tooltip on Type explaining how to add one.
  structHint = null,
}) {
  // String literals are read-only in C, so their objects stay read-only in diagrams too.
  const editable = editableDiagram && a.storage.kind !== 'static';
  const [name, setName] = useState(a.name ?? '');
  const [notice, setNotice] = useState('');
  const typeKey = typeToString(a.type);
  const [lengthText, setLengthText] = useState(isArray(a.type) ? String(a.type.length) : '');
  useEffect(() => {
    setName(a.name ?? '');
    setNotice('');
  }, [a.name, a.id]);
  // Switching Single → Array restores the length the object last had.
  const lastLength = useRef(isArray(a.type) ? a.type.length : 3);
  const lengthOwner = useRef(a.id);
  useEffect(() => {
    if (isArray(a.type)) lastLength.current = a.type.length;
    else if (lengthOwner.current !== a.id) lastLength.current = 3;
    lengthOwner.current = a.id;
    setLengthText(isArray(a.type) ? String(a.type.length) : '');
    // typeKey stands in for a.type, which is a new object after every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeKey, a.id]);
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
  const isRoot = !selected.ref.path?.length;
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
  const copy = async (value, what) => {
    try {
      await navigator.clipboard.writeText(formatAddress(value, true));
      setNotice(`Copied ${what}.`);
    } catch {
      setNotice('Copy unavailable. Select the address text to copy it.');
    }
  };
  // `term` is the C expression (&p, p, *p); `meaning` spells it out for tooltips and screen readers.
  const fact = (term, meaning, content, { action = null } = {}) => (
    <div className="fact">
      <dt title={meaning}>
        <span aria-hidden="true">{term}</span>
        <span className="sr-only">{meaning}</span>
      </dt>
      <dd>
        {content}
        {action}
      </dd>
    </div>
  );
  // Base types: the primitives, then the struct types this diagram knows (from the code that
  // produced it, or the challenge's definitions). Struct choices are keyed `struct:<tag>`.
  const structDefs = Object.values(state.structTypes ?? {});
  const showStructHint = Boolean(structHint) && !structDefs.length;
  const structBase = def => ({
    kind: 'struct',
    name: def.name,
    ...(def.alias && { alias: def.alias }),
  });
  const scalarType = isArray(a.type) ? a.type.of : a.type;
  let leaf = scalarType;
  while (isPointer(leaf)) leaf = leaf.to;
  const knownStruct = isStruct(leaf) && !!state.structTypes?.[leaf.name];
  // Editable shapes: [array of] pointer^k to a primitive or known struct.
  const canEditType = (isPrimitive(leaf) || knownStruct) && !isArray(scalarType);
  const editor = {
    shape: isArray(a.type) ? 'array' : 'scalar',
    base: knownStruct ? `struct:${leaf.name}` : basePrimitive(scalarType),
    stars: pointerDepth(scalarType),
    length: isArray(a.type) ? a.type.length : lastLength.current,
  };
  const setType = patch => {
    const next = { ...editor, ...patch };
    const def = next.base.startsWith('struct:') && state.structTypes[next.base.slice(7)];
    let type = def ? structBase(def) : primitive(next.base);
    for (let i = 0; i < next.stars; i++) type = pointer(type);
    if (next.shape === 'array') type = array(type, clampArrayLength(next.length));
    // size_t and unsigned long are one type; only the displayed spelling changes.
    if (typeEquals(a.type, type) && typeToString(a.type) === typeToString(type)) return;
    onEdit((obj, s) => {
      const moved = changeAllocationType(s, obj.id, type);
      return moved ? `${moved} pointer target location(s) changed with the object layout.` : null;
    });
  };
  const setLength = text => {
    setLengthText(text);
    // An empty or partly typed length waits for a valid value; blur restores the current one.
    if (Number(text) >= 1) setType({ length: text });
  };
  const commitName = () => {
    if (name === a.name) return;
    // Reject before storing so a bad name never reaches the diagram.
    const error =
      variableNameError(name, state.structTypes) ??
      (state.allocations.some(
        o =>
          o.id !== a.id &&
          o.alive &&
          o.storage.kind === 'stack' &&
          o.storage.frameId === a.storage.frameId &&
          o.name === name,
      )
        ? `'${name}' is already used in this frame`
        : null);
    if (error) {
      setNotice(`Name not changed: ${error}.`);
      setName(a.name ?? '');
      return;
    }
    onEdit(obj => {
      obj.name = name;
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
  // A target in the pointer's own frame needs no frame prefix.
  const targetAllocation = d?.target
    ? state.allocations.find(o => o.id === d.target.allocationId)
    : null;
  const sameFrame =
    targetAllocation?.storage.kind === 'stack' &&
    a.storage.kind === 'stack' &&
    targetAllocation.storage.frameId === a.storage.frameId;
  const targetName = sameFrame ? d.label : (d?.qualifiedLabel ?? d?.label);
  // Heading: the C declaration for a named variable, otherwise the label and its type.
  const declared = isRoot && a.storage.kind === 'stack' && a.name;
  // A named variable is renamed in place: only the name token of its declaration is an input.
  const renamable = declared && editable && a.alive;
  const [declBefore, declAfter] = declared ? declarationToC(a.type, '\0').split('\0') : [];
  // After the address: size, member offset, then where the object lives.
  const context = [
    selected.onePast
      ? 'one-past · no storage'
      : `${sizeOf(selected.type, state.structTypes)} bytes`,
    !isRoot && !selected.onePast && `+${location.offset}`,
    a.storage.kind === 'stack'
      ? frameLabel(state, a.storage.frameId)
      : a.storage.kind === 'static'
        ? 'string literal · read-only'
        : a.storage.kind,
  ].filter(Boolean);

  // The stored address (or NULL / ?) in a slot, coloured like the pointer on the canvas.
  const pointerSlot = d && (
    <span
      className={`slot ${
        d.status === 'uninitialized'
          ? 'uninit'
          : d.status === 'null'
            ? 'null'
            : ['dangling', 'invalid'].includes(d.status)
              ? 'dangling'
              : 'ptr'
      }`}
      title={d.status === 'uninitialized' ? 'uninitialized' : formatAddress(d.address, true)}
    >
      {d.status === 'null'
        ? 'NULL'
        : d.status === 'uninitialized'
          ? '?'
          : d.status === 'invalid'
            ? 'invalid'
            : formatAddress(d.address)}
    </span>
  );
  // "→ target" under the slot; the target name itself is the link that shows it in the diagram.
  const warnTarget = d && ['dangling', 'invalid'].includes(d.status);
  const targetLine =
    d &&
    (d.target && d.status !== 'invalid' ? (
      <span className={`target-line${warnTarget ? ' warning' : ''}`}>
        <span className="target-arrow" aria-hidden="true">
          →
        </span>
        <button
          className="target-link"
          title={d.status === 'dangling' ? 'Show former target in diagram' : 'Show in diagram'}
          aria-label={`Show ${targetName} in diagram`}
          onClick={() => onShowTarget(d.target)}
        >
          {targetName}
        </button>
        {d.status === 'dangling' && <span> ({lifetimeNote(d)})</span>}
      </span>
    ) : (
      <span className={`target-line${warnTarget ? ' warning' : ''}`}>
        <span className="target-arrow" aria-hidden="true">
          →
        </span>{' '}
        {d.status === 'null'
          ? 'no target'
          : d.status === 'uninitialized'
            ? 'none yet'
            : 'invalid reference'}
      </span>
    ));
  // A value in a slot; uninitialized scalars show a dashed "?".
  const valueSlot = (type, value) =>
    isPrimitive(type) && value?.kind !== 'scalar' ? (
      <span className="slot uninit" title="uninitialized">
        ?
      </span>
    ) : (
      <span className="slot value">{valueSummary(state, type, value, chars)}</span>
    );

  // One line whatever the member count, so resizing an array never moves the controls below.
  const selectedKey = JSON.stringify(selected.ref.path);
  const position = subobjects.findIndex(item => JSON.stringify(item.ref.path) === selectedKey);
  const step = delta => {
    const next = subobjects[position + delta];
    if (next) onSelectPath(next.ref.path);
  };
  const memberPicker =
    subobjects.length <= 1 ? null : (
      <div className="member-picker">
        <span className="member-picker-label" aria-hidden="true">
          Inspect
        </span>
        <span className="member-picker-controls">
          <select
            aria-label="Inspect object or member"
            value={selectedKey}
            onChange={e => onSelectPath(JSON.parse(e.target.value))}
          >
            {selected.onePast && <option value={selectedKey}>one-past boundary</option>}
            {subobjects.map(item => (
              <option key={JSON.stringify(item.ref.path)} value={JSON.stringify(item.ref.path)}>
                {memberSuffix(item.ref.path, a.type)}
              </option>
            ))}
          </select>
          <button
            className="nav-btn"
            aria-label="Previous member"
            title="Previous member"
            disabled={position <= 0}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            className="nav-btn"
            aria-label="Next member"
            title="Next member"
            disabled={position < 0 || position >= subobjects.length - 1}
            onClick={() => step(1)}
          >
            ›
          </button>
        </span>
      </div>
    );

  let valueEditor = null;
  if (writable && isPointer(selected.type)) {
    valueEditor = (
      <label className="field">
        <span>Target</span>
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
                <option key={JSON.stringify(item.ref)} value={`ref:${JSON.stringify(item.ref)}`}>
                  {/* The pointer's type already fixes the target type, so only name and address. */}
                  {resolveRef(state, item.ref).label} ·{' '}
                  {formatAddress(referenceLocation(state, item.ref).address)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    );
  } else if (writable && selected.type.name === 'bool') {
    valueEditor = (
      <label className="field">
        <span>Value</span>
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
    );
  } else if (writable && isPrimitive(selected.type)) {
    // Chars are edited as numbers; in Character mode the label names the character too.
    const asCharacter =
      chars === 'character' && selected.type.name === 'char' && selected.value.kind === 'scalar';
    valueEditor = (
      <label className="field">
        <span>Value</span>
        <span className="value-control">
          <input
            type="number"
            aria-label={`Value of ${label}`}
            // String() keeps 64-bit values exact; they may be stored as BigInt.
            value={selected.value.kind === 'scalar' ? String(selected.value.value) : ''}
            placeholder="uninitialized"
            onChange={e =>
              onEdit(
                (obj, s) =>
                  setRefValue(
                    s,
                    selected.ref,
                    e.target.value === ''
                      ? { kind: 'uninit' }
                      : { kind: 'scalar', value: scalarFromInput(e.target.value, selected.type) },
                  ),
                // Typing a number is one undo step, not one per keystroke.
                `value:${a.id}:${JSON.stringify(selected.ref.path)}`,
              )
            }
          />
          {asCharacter && <code>= {encodeCharLiteral(selected.value.value)}</code>}
        </span>
      </label>
    );
  }

  const declaration =
    editable && a.alive ? (
      <>
        {canEditType ? (
          <>
            <div className="field">
              <span>
                Type
                {showStructHint && <InfoDot tip={structHint} />}
              </span>
              <div className="type-controls">
                <select
                  aria-label="Object base type"
                  value={editor.base}
                  onChange={e => setType({ base: e.target.value })}
                >
                  {PRIMITIVE_NAMES.map(t => (
                    <option key={t}>{t}</option>
                  ))}
                  {structDefs.length > 0 ? (
                    <optgroup label="Structs">
                      {structDefs.map(def => (
                        <option key={def.name} value={`struct:${def.name}`}>
                          {typeToString(structBase(def))}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    showStructHint && (
                      <option disabled value="">
                        struct (none yet)
                      </option>
                    )
                  )}
                </select>
                <select
                  aria-label="Pointer depth"
                  title="Pointer depth"
                  value={editor.stars}
                  onChange={e => setType({ stars: Number(e.target.value) })}
                >
                  {Array.from({ length: Math.max(3, editor.stars) + 1 }, (_, n) => (
                    <option key={n} value={n}>
                      {'*'.repeat(n) || '–'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <span>Shape</span>
              <div className="shape-controls">
                <div className="segmented" role="group" aria-label="Object shape">
                  <button
                    aria-pressed={editor.shape === 'scalar'}
                    onClick={() => setType({ shape: 'scalar' })}
                  >
                    Single
                  </button>
                  <button
                    aria-pressed={editor.shape === 'array'}
                    onClick={() => setType({ shape: 'array' })}
                  >
                    Array
                  </button>
                </div>
                {editor.shape === 'array' && (
                  <span className="length-group">
                    <span aria-hidden="true">[</span>
                    <input
                      type="number"
                      aria-label="Array length"
                      title={`1 to ${MAX_ARRAY_LENGTH}`}
                      min="1"
                      max={MAX_ARRAY_LENGTH}
                      value={lengthText}
                      onChange={e => setLength(e.target.value)}
                      onBlur={() => setLengthText(String(a.type.length))}
                    />
                    <span aria-hidden="true">]</span>
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="field">
            <span>Type</span>
            <code>{typeToString(a.type)}</code>
          </div>
        )}
      </>
    ) : null;

  const actions = [];
  if (editable && a.alive && a.storage.kind === 'heap')
    actions.push(
      <button
        key="free"
        className="plain-btn"
        onClick={() =>
          onEdit(obj => {
            obj.alive = false;
            return 'Marked as freed. Ctrl+Z undoes it.';
          })
        }
      >
        Mark as freed
      </button>,
    );
  // Only for freed heap blocks in an editable diagram: C has no "unfree"; this is a drawing edit.
  if (onRestore)
    actions.push(
      <button key="restore" className="plain-btn" onClick={onRestore}>
        Mark as not freed
      </button>,
    );

  const hasFooter = (editable && a.alive) || Boolean(onRestore);
  const hasEditBand = Boolean(valueEditor || declaration) || hasFooter;
  // Sits in the edit band when there is one, else at the bottom of the panel.
  const noticeLine = (
    <div className="inspector-notice" role="status" aria-live="polite">
      {notice}
    </div>
  );

  return (
    <aside className="inspector" aria-label={`Inspect ${allocationDisplayName(state, a)}`}>
      <div className="inspector-heading">
        <div>
          <h4 className={renamable ? 'renamable' : undefined}>
            {renamable ? (
              <>
                {/* The type is changed below, so it recedes and the name box leads the heading. */}
                <span className="inspector-type">{declBefore}</span>
                {/* A label, so a click anywhere in the box (pencil included) focuses the input. */}
                <label className="name-box" title="Rename">
                  <input
                    className="name-edit"
                    aria-label="Object name"
                    spellCheck={false}
                    autoComplete="off"
                    value={name}
                    // Monospace, so the input grows one character cell per typed character.
                    style={{ width: `${Math.max(4, name.length)}ch` }}
                    onChange={e => setName(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      else if (e.key === 'Escape') {
                        // Revert first so the blur that follows has nothing to commit.
                        e.stopPropagation();
                        setName(a.name ?? '');
                        setNotice('');
                        const input = e.currentTarget;
                        setTimeout(() => input.blur());
                      }
                    }}
                  />
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                    <path
                      d="M10.5 2.5l3 3L6 13H3v-3z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                  </svg>
                </label>
                <span className="inspector-type">{declAfter}</span>
              </>
            ) : declared ? (
              declarationToC(a.type, a.name)
            ) : (
              <>
                {label} <span className="inspector-type">{typeToString(selected.type)}</span>
              </>
            )}
          </h4>
          <div className="inspector-context">
            <span>
              <code title={formatAddress(location.address, true)}>
                {selected.onePast && 'boundary '}
                {formatAddress(location.address)}
              </code>
              {Number.isSafeInteger(location.address) && (
                <button
                  className="icon-btn inline"
                  aria-label={`Copy address of ${label}`}
                  title="Copy full address"
                  onClick={() => copy(location.address, `address of ${label}`)}
                >
                  ⧉
                </button>
              )}
            </span>
            {[...context, lifetime].filter(Boolean).map(item => (
              <span key={item} className={item === lifetime ? 'warning' : undefined}>
                <span className="context-dot" aria-hidden="true">
                  ·
                </span>
                {item}
              </span>
            ))}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close inspector" title="Close">
          ✕
        </button>
      </div>
      {memberPicker}

      <section aria-label="Memory">
        <h5 className="inspector-section">
          Memory
          <InfoDot tip="Simulated addresses; real programs may differ." />
        </h5>
        <dl className="facts">
          {d ? (
            <>
              {fact(
                label,
                `Address stored in ${label}`,
                <span className="slot-stack">
                  {pointerSlot}
                  {targetLine}
                </span>,
                {
                  action: Number.isSafeInteger(d.address) && (
                    <button
                      className="icon-btn"
                      aria-label={`Copy address stored in ${label}`}
                      title="Copy full address"
                      onClick={() => copy(d.address, `address stored in ${label}`)}
                    >
                      ⧉
                    </button>
                  ),
                },
              )}
              {fact(
                `*${label}`,
                `Value of *${label}`,
                d.status === 'valid' ? (
                  valueSlot(d.type, d.value)
                ) : (
                  <span className="muted-note">cannot dereference</span>
                ),
              )}
            </>
          ) : selected.onePast ? (
            fact('Value', 'Value', <span className="muted-note">cannot dereference</span>)
          ) : (
            // The heading already names the object; only pointers need t vs *t to teach dereferencing.
            fact('Value', `Value of ${label}`, valueSlot(selected.type, selected.value))
          )}
        </dl>
      </section>

      {hasEditBand ? (
        // Everything that changes the object sits in its own darker band below what it is.
        <div className="inspector-edit">
          {(valueEditor || declaration) && (
            <section aria-label="Edit">
              <h5 className="inspector-section">
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M10.5 2.5l3 3L6 13H3v-3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
                Edit
              </h5>
              <div className="edit-grid">
                {valueEditor}
                {declaration}
              </div>
            </section>
          )}
          {hasFooter && (
            <div className="inspector-footer">
              {actions}
              <button className="text-btn danger" onClick={onDelete} aria-label="Delete object">
                Delete
              </button>
            </div>
          )}
          {noticeLine}
        </div>
      ) : (
        noticeLine
      )}
    </aside>
  );
}
