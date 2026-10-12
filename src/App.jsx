/** Application shell: initializes the parser and switches between main pages. */
import { lazy, Suspense, useEffect, useState } from 'react';
// Imported from the package so the runtime WASM always matches the installed
// web-tree-sitter JavaScript; Vite fingerprints it and applies the base path.
import runtimeWasm from 'web-tree-sitter/tree-sitter.wasm?url';
import { initParser } from './pipeline/interpreter.js';
import { loadCourseLevels } from './data/levels.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Sandbox from './components/Sandbox.jsx';
import Challenges from './components/Challenges.jsx';

// [id, label, component, keepAlive]. A kept-alive page stays mounted while hidden, so the
// sandbox keeps its code, diagram, playback, layout and undo history across tab switches,
// and a challenge keeps the answer in progress. Pages get `shown` so they can refresh
// stored data on return. The Level editor remounts on every visit, and exists only in the
// instructor build. The condition repeats edition.js's INSTRUCTOR inline on purpose: the
// bundler folds `import.meta.env.MODE` here but not an imported constant, and only a
// folded condition drops the editor chunk from the student build (npm run check:editions).
const PAGES = [
  ['sandbox', 'Sandbox', Sandbox, true],
  ['challenges', 'Challenges', Challenges, true],
  ...(import.meta.env.MODE === 'instructor'
    ? [['editor', 'Level editor', lazy(() => import('./components/LevelEditor.jsx')), false]]
    : []),
];

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('sandbox');

  useEffect(() => {
    // Pages project sites live under /<repository>/; the grammar in public/ is
    // resolved against Vite's deployment base (also works at a custom-domain root).
    // The course pack loads alongside the parser; it never rejects.
    Promise.all([
      initParser({
        runtimeWasm,
        grammarWasm: `${import.meta.env.BASE_URL}tree-sitter-c.wasm`,
      }),
      loadCourseLevels(`${import.meta.env.BASE_URL}levels/course.json`),
    ])
      .then(() => setReady(true))
      .catch(e => setError(e.message));
  }, []);
  if (error) return <div className="loading-screen">Could not load the C parser: {error}</div>;
  if (!ready) return <div className="loading-screen">Loading parser…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">PointerViz</div>
        <nav className="tabs" aria-label="sections">
          {PAGES.map(([id, label]) => (
            <button
              key={id}
              className={`tab${tab === id ? ' active' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {PAGES.map(
        ([id, , Page, keepAlive]) =>
          (keepAlive || tab === id) && (
            <div key={id} className="page-host" hidden={tab !== id}>
              <ErrorBoundary resetKey={tab}>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <Page shown={tab === id} />
                </Suspense>
              </ErrorBoundary>
            </div>
          ),
      )}
    </div>
  );
}
