/**
 * Instructor challenge editor. The target state is authored as C, previewed
 * live, and saved as { title, kind, prompt, code, hints, grading }: the target
 * MemoryState is always derived from the code, never stored. Levels export and
 * import as JSON so a course pack can be shared.
 */
import { useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './CodePanel.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { loadCustomLevels, mergeLevels, normalizeLevel, saveCustomLevels } from '../data/levels.js';

const DEFAULT_CODE = 'int main() {\n    int a = 10;\n    int *b = &a;\n}';
const kindLabel = kind => (kind === 'code-to-diagram' ? 'code → diagram' : 'diagram → code');

function tryInterpret(code) {
  try {
    return { state: interpret(code).state, error: null };
  } catch (e) {
    return { state: null, error: e.message };
  }
}

export default function LevelEditor() {
  const [levels, setLevels] = useState(loadCustomLevels);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('code-to-diagram');
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [hints, setHints] = useState('');
  const [compareNames, setCompareNames] = useState(true);
  const [compareLifetime, setCompareLifetime] = useState(true);
  const [preview, setPreview] = useState(() => tryInterpret(DEFAULT_CODE).state);
  const [error, setError] = useState(null);

  const persist = next => {
    setLevels(next);
    if (!saveCustomLevels(next)) {
      setError('this browser blocked local storage; levels will be lost on reload — export them');
      return false;
    }
    return true;
  };

  const onCode = src => {
    setCode(src);
    const result = tryInterpret(src);
    setPreview(result.state);
    setError(result.error);
  };

  const save = () => {
    if (!title.trim()) return setError('give the level a title');
    const { error: codeError } = tryInterpret(code);
    if (codeError) return setError(`target code invalid: ${codeError}`);
    const level = normalizeLevel({
      id: `custom-${Date.now()}`,
      title,
      kind,
      prompt,
      code,
      hints: hints.split('\n'),
      grading: { compareNames, compareLifetime },
    });
    if (persist(mergeLevels(levels, [level]))) setError(null);
    setTitle('');
    setPrompt('');
    setHints('');
  };

  const remove = id => persist(levels.filter(l => l.id !== id));

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(levels, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pointerviz-levels.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const importJson = file => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('level pack must be an array');
        const valid = imported
          .map(normalizeLevel)
          .filter(level => level && !tryInterpret(level.code).error);
        if (!valid.length && imported.length) throw new Error('no valid levels found');
        const skipped = imported.length - valid.length;
        if (persist(mergeLevels(levels, valid))) {
          setError(
            skipped ? `imported ${valid.length} level(s); skipped ${skipped} invalid` : null,
          );
        }
      } catch (e) {
        setError(`could not import level pack: ${e.message}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="page level-editor">
      <div className="editor-form">
        <h2>Level editor</h2>
        <p className="lede">Create and preview a challenge.</p>

        <label htmlFor="lv-title">title</label>
        <input
          id="lv-title"
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Swap via pointers"
        />

        <label htmlFor="lv-kind">challenge direction</label>
        <select id="lv-kind" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="code-to-diagram">show code → student builds diagram</option>
          <option value="diagram-to-code">show diagram → student writes code</option>
        </select>

        <label htmlFor="lv-prompt">prompt shown to students</label>
        <input
          id="lv-prompt"
          type="text"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Recreate this memory state."
        />

        <label>target state (C code)</label>
        <div className="editor-code">
          <CodePanel code={code} onCode={onCode} />
        </div>

        <label htmlFor="lv-hints">hints — one per line, revealed in order</label>
        <textarea
          id="lv-hints"
          rows={3}
          value={hints}
          onChange={e => setHints(e.target.value)}
          placeholder={'Declare the int first.\nUse & to take an address.'}
        />

        <label>grading policy</label>
        <div className="grading-options">
          <label>
            <input
              type="checkbox"
              checked={compareNames}
              onChange={e => setCompareNames(e.target.checked)}
            />{' '}
            variable names must match
          </label>
          <label>
            <input
              type="checkbox"
              checked={compareLifetime}
              onChange={e => setCompareLifetime(e.target.checked)}
            />{' '}
            alive/freed lifetime must match
          </label>
        </div>

        {error && (
          <p className="msgbar-inline err" role="alert">
            {error}
          </p>
        )}

        <div className="editor-actions">
          <button className="primary-btn" onClick={save}>
            Save level
          </button>
          <button className="ghost-btn" onClick={exportJson} disabled={!levels.length}>
            Export pack
          </button>
          <label className="ghost-btn file-btn">
            Import pack
            <input
              type="file"
              accept=".json"
              hidden
              onChange={e => {
                if (e.target.files[0]) importJson(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="saved-list">
          <h4>your levels ({levels.length})</h4>
          {levels.length === 0 && (
            <p className="lede">
              No custom levels yet — saved levels appear in the Challenges tab immediately.
            </p>
          )}
          {levels.map(l => (
            <div className="saved-row" key={l.id}>
              <div className="saved-title">
                <div>{l.title}</div>
                <div className="saved-kind">{kindLabel(l.kind)}</div>
              </div>
              <button className="mini-btn danger" onClick={() => remove(l.id)}>
                delete
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="editor-preview">
        <div className="panel-head">target preview</div>
        <div className="editor-preview-body">
          {preview ? (
            <MemoryCanvas key={code} state={preview} editable={false} />
          ) : (
            <div className="loading-screen">fix the code to see the preview</div>
          )}
        </div>
      </div>
    </div>
  );
}
