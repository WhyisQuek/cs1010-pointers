/**
 * Instructor challenge editor. The target state is authored as C, previewed
 * once typing pauses, and saved as { title, kind, section, topic, prompt, code, hints, grading }: the target
 * MemoryState is always derived from the code, never stored. Levels export and
 * import as JSON; an exported pack committed as public/levels/course.json is what
 * students see. Only the instructor build includes this page (see edition.js).
 */
import { useEffect, useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './CodePanel.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { drawingIssues } from '../pipeline/equivalence.js';
import {
  DEFAULT_PROMPTS,
  availableLevels,
  clearProgress,
  loadCustomLevels,
  mergeLevels,
  normalizeLevel,
  saveCustomLevels,
} from '../data/levels.js';

const DEFAULT_CODE = 'int main() {\n    int a = 10;\n    int *b = &a;\n}';
// The preview re-runs once typing pauses, not on every keystroke.
const PREVIEW_DELAY_MS = 300;
const kindLabel = kind => (kind === 'code-to-diagram' ? 'code → diagram' : 'diagram → code');

function tryInterpret(code) {
  try {
    return { state: interpret(code).state, error: null };
  } catch (e) {
    return { state: null, error: e.message };
  }
}

/** A preview result; `version` changes only when the interpreted state does. */
function previewOf(code, previous = null) {
  const result = tryInterpret(code);
  const json = result.state && JSON.stringify(result.state);
  if (json && json === previous?.json) return previous;
  return { ...result, json, version: (previous?.version ?? 0) + 1 };
}

/** Whether an edit changed what students must produce, so earlier completions are void. */
const answerChanged = (before, after) =>
  before.code !== after.code ||
  before.kind !== after.kind ||
  JSON.stringify(before.grading) !== JSON.stringify(after.grading);

export default function LevelEditor() {
  const [levels, setLevels] = useState(loadCustomLevels);
  // The ID of the saved level loaded into the form, or null when creating a new one.
  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('code-to-diagram');
  const [section, setSection] = useState('');
  const [topic, setTopic] = useState('');
  const [prompt, setPrompt] = useState('');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [hints, setHints] = useState('');
  const [compareNames, setCompareNames] = useState(true);
  const [compareLifetime, setCompareLifetime] = useState(true);
  const [preview, setPreview] = useState(() => previewOf(DEFAULT_CODE));
  const [error, setError] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPreview(previous => previewOf(code, previous));
      // Editing the code replaces any earlier message with the code's own error, if any.
      setError(null);
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code]);

  const persist = next => {
    setLevels(next);
    if (!saveCustomLevels(next)) {
      setError('this browser blocked local storage; levels will be lost on reload — export them');
      return false;
    }
    return true;
  };

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setSection('');
    setTopic('');
    setPrompt('');
    setHints('');
  };

  const startEdit = level => {
    setEditingId(level.id);
    setTitle(level.title);
    setKind(level.kind);
    setSection(level.section);
    setTopic(level.topic);
    // A default prompt stays blank, so changing the direction picks the new default.
    setPrompt(level.prompt === DEFAULT_PROMPTS[level.kind] ? '' : level.prompt);
    setCode(level.code);
    setHints(level.hints.join('\n'));
    setCompareNames(level.grading.compareNames ?? true);
    setCompareLifetime(level.grading.compareLifetime ?? true);
    setError(null);
  };

  const save = () => {
    if (!title.trim()) return setError('give the level a title');
    const { state, error: codeError } = tryInterpret(code);
    if (codeError) return setError(`target code invalid: ${codeError}`);
    // Students draw code → diagram answers, so the answer must be drawable.
    const issues = kind === 'code-to-diagram' ? drawingIssues(state) : [];
    if (issues.length)
      return setError(
        `students cannot draw this answer in the diagram editor: it needs ${issues.join('; ')}. Save it as diagram → code instead.`,
      );
    const level = normalizeLevel({
      id: editingId ?? `custom-${Date.now()}`,
      title,
      kind,
      section,
      topic,
      prompt,
      code,
      hints: hints.split('\n'),
      grading: { compareNames, compareLifetime },
    });
    const original = levels.find(l => l.id === editingId);
    const next = original
      ? levels.map(l => (l.id === editingId ? level : l))
      : mergeLevels(levels, [level]);
    if (persist(next)) setError(null);
    if (original && answerChanged(original, level)) clearProgress(level.id);
    resetForm();
  };

  const remove = id => {
    if (id === editingId) resetForm();
    persist(levels.filter(l => l.id !== id));
  };

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

  // Existing sections are suggested so a new level can join one by its exact name.
  const sectionNames = [
    ...new Set(
      [...availableLevels({ includeCustom: false }), ...levels].map(l => l.section).filter(Boolean),
    ),
  ];

  return (
    <div className="page level-editor">
      <div className="editor-form">
        <h2>Level editor</h2>
        <p className="lede">
          {editingId
            ? `Editing “${levels.find(l => l.id === editingId)?.title}”.`
            : 'Create and preview a challenge.'}
        </p>

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

        <label htmlFor="lv-section">section — the Challenges heading it is listed under</label>
        <input
          id="lv-section"
          type="text"
          list="lv-section-names"
          value={section}
          onChange={e => setSection(e.target.value)}
          placeholder="e.g. Heap (blank lists it under More challenges)"
        />
        <datalist id="lv-section-names">
          {sectionNames.map(name => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <label htmlFor="lv-topic">topic — shown on the challenge card</label>
        <input
          id="lv-topic"
          type="text"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="Pointers to pointers"
        />

        <label htmlFor="lv-prompt">instruction — shown above the challenge (optional)</label>
        <input
          id="lv-prompt"
          type="text"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={DEFAULT_PROMPTS[kind]}
        />

        <label>target state (C code)</label>
        <div className="editor-code">
          <CodePanel code={code} onCode={setCode} />
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

        {(error ?? preview.error) && (
          <p className="msgbar-inline err" role="alert">
            {error ?? preview.error}
          </p>
        )}

        <div className="editor-actions">
          <button className="primary-btn" onClick={save}>
            {editingId ? 'Save changes' : 'Save level'}
          </button>
          {editingId && (
            <button className="ghost-btn" onClick={resetForm}>
              Cancel edit
            </button>
          )}
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
          <p className="lede">
            {levels.length === 0 && 'No custom levels yet. '}
            Saved levels appear in this browser&apos;s Challenges tab only. To publish them to
            students, export the pack and commit it as <code>public/levels/course.json</code>;
            import that file first to edit levels already published.
          </p>
          {levels.map(l => (
            <div className={`saved-row${l.id === editingId ? ' editing' : ''}`} key={l.id}>
              <div className="saved-title">
                <div>{l.title}</div>
                <div className="saved-kind">{kindLabel(l.kind)}</div>
              </div>
              <button
                className="mini-btn"
                onClick={() => startEdit(l)}
                disabled={l.id === editingId}
              >
                edit
              </button>
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
          {preview.state ? (
            <MemoryCanvas key={preview.version} state={preview.state} editable={false} />
          ) : (
            <div className="loading-screen">fix the code to see the preview</div>
          )}
        </div>
      </div>
    </div>
  );
}
