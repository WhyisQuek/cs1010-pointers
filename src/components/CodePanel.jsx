/** Syntax-highlighted C editor shared by the sandbox, challenges and level editor. */
import { useEffect, useMemo, useRef } from 'react';
import { highlightC } from '../language/highlight.js';
import {
  INDENT,
  closeBraceOutdent,
  indentLines,
  newlineWithIndent,
  outdentLines,
} from './autoIndent.js';

// Keep in sync with .code-highlight padding and line-height (13px × 1.6) in styles.css.
const PADDING_TOP = 12;
const LINE_HEIGHT = 20.8;

/**
 * Tab inserts four spaces and Shift+Tab outdents instead of moving browser focus; with a
 * selection across lines, both act on every selected line and keep the lines selected.
 * Enter carries indentation forward (one level deeper after `{`), and `}` on a blank line outdents.
 * With onToggleBreakpoint, clicking a line number or pressing F9 in the editor toggles a breakpoint.
 */
export function CodePanel({
  code,
  onCode,
  readOnly,
  activeLine = null,
  activeError = false,
  breakpoints = null,
  onToggleBreakpoint = null,
}) {
  const activeClass = activeError ? ' error-line' : '';
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
    if (e.key === 'F9' && onToggleBreakpoint && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      onToggleBreakpoint(code.slice(0, el.selectionStart).split('\n').length);
      return;
    }
    if (readOnly || !onCode || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const start = el.selectionStart,
      end = el.selectionEnd;
    const apply = edit => {
      if (!edit) return;
      e.preventDefault();
      onCode(edit.text);
      requestAnimationFrame(() => {
        el.selectionStart = edit.selectionStart ?? edit.cursor;
        el.selectionEnd = edit.selectionEnd ?? edit.cursor;
      });
    };
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      apply(newlineWithIndent(code, start, end));
      return;
    }
    if (e.key === '}') {
      apply(closeBraceOutdent(code, start, end));
      return;
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    if (e.shiftKey) {
      apply(outdentLines(code, start, end));
      return;
    }
    const block = indentLines(code, start, end);
    if (block) {
      apply(block);
      return;
    }
    onCode(code.slice(0, start) + INDENT + code.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + INDENT.length;
    });
  };

  return (
    <div className="code-wrap" ref={wrap}>
      {onToggleBreakpoint ? (
        // Line buttons stay out of the tab order; F9 in the editor is the keyboard route.
        <div className="gutter with-breakpoints" role="group" aria-label="Breakpoints">
          {lines.map((_, i) => {
            const line = i + 1,
              set = breakpoints?.has(line);
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                className={`gutter-line${set ? ' breakpoint' : ''}${line === activeLine ? ` next-line-number${activeClass}` : ''}`}
                aria-pressed={!!set}
                aria-label={`Breakpoint on line ${line}`}
                title={set ? 'Remove breakpoint (F9)' : 'Add breakpoint (F9)'}
                onClick={() => onToggleBreakpoint(line)}
              >
                {line}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={i + 1 === activeLine ? `next-line-number${activeClass}` : ''}>
              {i + 1}
            </div>
          ))}
        </div>
      )}
      <div className="code-body">
        <pre className="code-highlight" aria-hidden="true">
          {lines.map((tokens, i) => (
            <div
              key={i}
              className={`code-line${i + 1 === activeLine ? ` next-line${activeClass}` : ''}`}
            >
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
