/** Application shell: initializes the parser and switches between main pages. */
import { useEffect, useState } from 'react';
// Imported from the package so the runtime WASM always matches the installed
// web-tree-sitter JavaScript; Vite fingerprints it and applies the base path.
import runtimeWasm from 'web-tree-sitter/tree-sitter.wasm?url';
import { initParser } from './pipeline/interpreter.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Sandbox from './components/Sandbox.jsx';
import Challenges from './components/Challenges.jsx';
import LevelEditor from './components/LevelEditor.jsx';

const PAGES = [
  ['sandbox', 'Sandbox', Sandbox],
  ['challenges', 'Challenges', Challenges],
  ['editor', 'Level editor', LevelEditor],
];

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('sandbox');

  useEffect(() => {
    // Pages project sites live under /<repository>/; the grammar in public/ is
    // resolved against Vite's deployment base (also works at a custom-domain root).
    initParser({
      runtimeWasm,
      grammarWasm: `${import.meta.env.BASE_URL}tree-sitter-c.wasm`,
    })
      .then(() => setReady(true))
      .catch(e => setError(e.message));
  }, []);
  if (error) return <div className="loading-screen">Could not load the C parser: {error}</div>;
  if (!ready) return <div className="loading-screen">Loading parser…</div>;

  const Page = PAGES.find(([id]) => id === tab)[2];
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
      <ErrorBoundary resetKey={tab}>
        <Page />
      </ErrorBoundary>
    </div>
  );
}
