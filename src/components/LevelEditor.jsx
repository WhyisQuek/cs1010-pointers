/**
 * Instructor challenge editor.
 * Edits human-readable level metadata/reference C, previews the interpreted
 * target state, and persists custom levels through `data/levels.js`.
 */
import React, { useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './Sandbox.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { loadCustomLevels, saveCustomLevels } from '../data/levels.js';

/**
 * LevelEditor — the professor authors the target state as C code (the
 * sandbox pipeline validates it and previews the resulting diagram live),
 * chooses the challenge direction, and saves. Levels export as JSON so a
 * course pack can be shared; the level format is just { title, kind,
 * prompt, code, hints } — the target IR is derived, never stored.
 */
export default function LevelEditor() {
  const [levels, setLevels] = useState(loadCustomLevels());
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('code-to-diagram');
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState('int main() {\n    int a = 10;\n    int *b = &a;\n}');
  const [hints, setHints] = useState('');
  const [compareNames, setCompareNames] = useState(true);
  const [compareLifetime, setCompareLifetime] = useState(true);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  const tryPreview = (src) => {
    setCode(src);
    try { setPreview(interpret(src).state); setError(null); }
    catch (e) { setPreview(null); setError(e.message); }
  };

  const save = () => {
    if (!title.trim()) { setError('give the level a title'); return; }
    try { interpret(code); } catch (e) { setError(`target code invalid: ${e.message}`); return; }
    const level = {
      id: `custom-${Date.now()}`,
      title: title.trim(), kind, prompt: prompt.trim() || 'Recreate this memory state.',
      code, hints: hints.split('\n').map((h) => h.trim()).filter(Boolean),
      grading: { compareNames, compareLifetime },
    };
    const next = [...levels, level];
    setLevels(next); saveCustomLevels(next);
    setTitle(''); setPrompt(''); setHints(''); setError(null);
  };

  const remove = (id) => {
    const next = levels.filter((l) => l.id !== id);
    setLevels(next); saveCustomLevels(next);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(levels, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pointerviz-levels.json';
    a.click();
  };

  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('level pack must be an array');
        const valid = imported.filter((l) => {
          if (!l || typeof l.id !== 'string' || typeof l.code !== 'string' || !['code-to-diagram', 'diagram-to-code'].includes(l.kind)) return false;
          try { interpret(l.code); return true; } catch { return false; }
        });
        if (!valid.length && imported.length) throw new Error('no valid levels found');
        const next = [...levels, ...valid];
        setLevels(next); saveCustomLevels(next); setError(null);
      } catch (e) { setError(`could not import level pack: ${e.message}`); }
    };
    reader.readAsText(file);
  };

  return (
    <div className="page" style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1fr)', gap: 32 }}>
      <div className="editor-form">
        <h2>Level editor</h2>
        <p className="lede">Create and preview a challenge.</p>

        <label htmlFor="lv-title">title</label>
        <input id="lv-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Swap via pointers" />

        <div className="row">
          <div>
            <label htmlFor="lv-kind">challenge direction</label>
            <select id="lv-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="code-to-diagram">show code → student builds diagram</option>
              <option value="diagram-to-code">show diagram → student writes code</option>
            </select>
          </div>
        </div>

        <label htmlFor="lv-prompt">prompt shown to students</label>
        <input id="lv-prompt" type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Recreate this memory state." />

        <label>target state (C code)</label>
        <div style={{ height: 260, border: '1px solid var(--line)' }}><CodePanel code={code} onCode={tryPreview} /></div>

        <label htmlFor="lv-hints">hints — one per line, revealed in order</label>
        <textarea id="lv-hints" rows={3} value={hints} onChange={(e) => setHints(e.target.value)} placeholder={'Declare the int first.\nUse & to take an address.'} />

        <label>grading policy</label>
        <div className="grading-options">
          <label><input type="checkbox" checked={compareNames} onChange={(e) => setCompareNames(e.target.checked)} /> variable names must match</label>
          <label><input type="checkbox" checked={compareLifetime} onChange={(e) => setCompareLifetime(e.target.checked)} /> alive/freed lifetime must match</label>
        </div>

        {error && <div className="msgbar" style={{ border: 'none', paddingLeft: 0 }}><div className="err">{error}</div></div>}

        <button className="primary-btn" onClick={save}>Save level</button>
        <button className="ghost-btn" onClick={exportJson} disabled={!levels.length}>Export pack</button>
        <label className="ghost-btn" style={{ display: 'inline-block', cursor: 'pointer' }}>
          Import pack<input type="file" accept=".json" hidden onChange={(e) => e.target.files[0] && importJson(e.target.files[0])} />
        </label>

        <div className="saved-list">
          <h4 style={{ color: 'var(--muted)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.08em' }}>
            your levels ({levels.length})
          </h4>
          {levels.length === 0 && <p className="lede">No custom levels yet — saved levels appear in the Challenges tab immediately.</p>}
          {levels.map((l) => (
            <div className="saved-row" key={l.id}>
              <div className="t">
                <div>{l.title}</div>
                <div className="k">{l.kind === 'code-to-diagram' ? 'code → diagram' : 'diagram → code'}</div>
              </div>
              <button className="mini-btn danger" onClick={() => remove(l.id)}>delete</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
        <div className="panel-head" style={{ border: '1px solid var(--line)', borderRadius: '4px 4px 0 0' }}>target preview</div>
        <div style={{ flex: 1, border: '1px solid var(--line)', borderTop: 'none', borderRadius: '0 0 4px 4px', overflow: 'hidden', position: 'relative' }}>
          {preview
            ? <MemoryCanvas key={code} state={preview} editable={false} />
            : <div className="loading-screen">fix the code to see the preview</div>}
        </div>
      </div>
    </div>
  );
}
