/** Code/memory split with a draggable, keyboard-operable divider shared by Sandbox and Challenges. */
import { useEffect, useRef, useState } from 'react';

const KEY = 'pointerviz.split.v1';
const DEFAULT_SPLIT = 0.38;
const DIVIDER = 6;
// Keep in sync with the minmax() minimums of .workbench in styles.css.
const CODE_MIN = 220;
const MEMORY_MIN = 360;
const COLLAPSE_BELOW = 120;
const KEY_STEP = 24;

function readSplit() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved.split === 'number' && saved.split > 0 && saved.split < 1)
      return { split: saved.split, collapsed: !!saved.collapsed };
  } catch {
    /* private browsing or malformed value */
  }
  return { split: DEFAULT_SPLIT, collapsed: false };
}
function saveSplit(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* the split still works for this session */
  }
}

const stackedQuery = '(max-width: 900px)';
function useStacked() {
  const [stacked, setStacked] = useState(() => window.matchMedia(stackedQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(stackedQuery);
    const update = () => setStacked(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return stacked;
}

export default function Workbench({ left, right, leftLabel = 'C code' }) {
  const [layout, setLayout] = useState(readSplit);
  const stacked = useStacked();
  const root = useRef(null);
  const drag = useRef(false);
  const update = next => {
    setLayout(next);
    saveSplit(next);
  };

  // Length of the axis the divider moves along, excluding the divider itself.
  const extent = () => {
    const rect = root.current.getBoundingClientRect();
    return {
      start: stacked ? rect.top : rect.left,
      size: (stacked ? rect.height : rect.width) - DIVIDER,
    };
  };
  const clampSplit = (px, size) => {
    const codeMin = stacked ? 160 : CODE_MIN;
    if (px < COLLAPSE_BELOW && !stacked) return { split: layout.split, collapsed: true };
    const max = Math.max(codeMin, size - MEMORY_MIN);
    return { split: Math.min(max, Math.max(codeMin, px)) / size, collapsed: false };
  };
  const onPointerMove = event => {
    if (!drag.current) return;
    const { start, size } = extent();
    setLayout(clampSplit((stacked ? event.clientY : event.clientX) - start, size));
  };
  const finish = () => {
    if (!drag.current) return;
    drag.current = false;
    setLayout(current => {
      saveSplit(current);
      return current;
    });
  };
  const onKeyDown = event => {
    const back = stacked ? 'ArrowUp' : 'ArrowLeft',
      forward = stacked ? 'ArrowDown' : 'ArrowRight';
    if (event.key === 'Home' || event.key === 'Enter') {
      event.preventDefault();
      update({ split: DEFAULT_SPLIT, collapsed: false });
      return;
    }
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const { size } = extent();
    if (layout.collapsed) {
      if (event.key === forward) update({ ...layout, collapsed: false });
      return;
    }
    const delta = event.key === forward ? KEY_STEP : -KEY_STEP;
    update(clampSplit(layout.split * size + delta, size));
  };

  const collapsed = layout.collapsed && !stacked;
  const percent = Math.round(layout.split * 100);
  return (
    <div
      ref={root}
      className={`workbench${collapsed ? ' code-collapsed' : ''}`}
      style={{ '--code-fr': `${percent}fr`, '--memory-fr': `${100 - percent}fr` }}
    >
      {collapsed && (
        <button
          className="code-rail"
          onClick={() => update({ ...layout, collapsed: false })}
          title={`Show ${leftLabel}`}
        >
          {leftLabel}
        </button>
      )}
      <div className="workbench-pane" hidden={collapsed}>
        {left}
      </div>
      <div
        className="workbench-divider"
        role="separator"
        tabIndex={0}
        aria-orientation={stacked ? 'horizontal' : 'vertical'}
        aria-label={`Resize ${leftLabel} and memory panes`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={collapsed ? 0 : percent}
        title="Drag to resize · Double-click to reset"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = true;
        }}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => update({ split: DEFAULT_SPLIT, collapsed: false })}
        onKeyDown={onKeyDown}
      />
      <div className="workbench-pane">{right}</div>
    </div>
  );
}
