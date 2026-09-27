/** Syntax-highlighted C editor shared by the sandbox, challenges and level editor. */
import { useEffect, useMemo, useRef } from 'react';
import { highlightC } from '../language/highlight.js';

const INDENT = '    ';
// Keep in sync with .code-highlight padding and line-height (13px × 1.6) in styles.css.
const PADDING_TOP = 12;
const LINE_HEIGHT = 20.8;

/** Tab inserts four spaces and Shift+Tab outdents instead of moving browser focus. */
export function CodePanel({ code, onCode, readOnly, activeLine = null }) {
  const lines = useMemo(() => highlightC(code), [code]);
  const wrap = useRef(null);
  useEffect(() => {
    if (!activeLine || !wrap.current) return;
    const el = wrap.current;
    const top = PADDING_TOP + (activeLine - 1) * LINE_HEIGHT;
    if (top < el.scrollTop || top + LINE_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [activeLine]);

  const onKeyDown = e => {
    if (readOnly || e.key !== 'Tab' || !onCode) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart,
      end = el.selectionEnd;
    if (e.shiftKey) {
      const lineStart = code.lastIndexOf('\n', start - 1) + 1;
      const remove = code.slice(lineStart, lineStart + INDENT.length).match(/^ +/)?.[0].length ?? 0;
      if (!remove) return;
      onCode(code.slice(0, lineStart) + code.slice(lineStart + remove));
      requestAnimationFrame(() => {
        el.selectionStart = Math.max(lineStart, start - remove);
        el.selectionEnd = Math.max(lineStart, end - remove);
      });
      return;
    }
    onCode(code.slice(0, start) + INDENT + code.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + INDENT.length;
    });
  };

  return (
    <div className="code-wrap" ref={wrap}>
      <div className="gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <div key={i} className={i + 1 === activeLine ? 'next-line-number' : ''}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="code-body">
        <pre className="code-highlight" aria-hidden="true">
          {lines.map((tokens, i) => (
            <div key={i} className={`code-line${i + 1 === activeLine ? ' next-line' : ''}`}>
              {tokens.length
                ? tokens.map((t, j) => (
                    <span key={j} className={`syntax-${t.kind}`}>
                      {t.text}
                    </span>
                  ))
                : '​'}
            </div>
          ))}
        </pre>
        <textarea
          className="code-input"
          aria-label="C source code"
          wrap="off"
          spellCheck={false}
          value={code}
          readOnly={readOnly}
          placeholder="int main(void) { ... }"
          onChange={e => onCode?.(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
