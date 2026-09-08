/** Application shell: initializes the parser and switches between main pages. */
import React, { useEffect, useState } from 'react';
import { initParser } from './pipeline/interpreter.js';
import Sandbox from './components/Sandbox.jsx';
import Challenges from './components/Challenges.jsx';
import LevelEditor from './components/LevelEditor.jsx';

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('sandbox');

  useEffect(() => { initParser().then(() => setReady(true)).catch(e => setError(e.message)); }, []);
  if (error) return <div className="loading-screen">Could not load the C parser: {error}</div>;
  if (!ready) return <div className="loading-screen">Loading parser…</div>;

  return <div className="app">
    <header className="topbar">
      <div className="brand">PointerViz</div>
      <nav className="tabs" aria-label="sections">
        {[['sandbox', 'Sandbox'], ['challenges', 'Challenges'], ['editor', 'Level editor']].map(([id, label]) =>
          <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
    </header>
    {tab === 'sandbox' && <Sandbox />}
    {tab === 'challenges' && <Challenges />}
    {tab === 'editor' && <LevelEditor />}
  </div>;
}
