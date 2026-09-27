/** Bidirectional code/memory sandbox with step-through playback. */
import { useMemo, useState } from 'react';
import { CodePanel } from './CodePanel.jsx';
import MemoryCanvas from './MemoryCanvas.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { generate, ValidationError, validate } from '../pipeline/codegen.js';
import { makeState } from '../machine/memory.js';

const STARTER = `int main(void) {
    int a = 10;
    return 0;
}
`;

export default function Sandbox() {
  const [code, setCode] = useState(STARTER);
  const [state, setState] = useState(makeState);
  const [snapshots, setSnapshots] = useState(null);
  const [step, setStep] = useState(0);
  const [messages, setMessages] = useState([]);
  const [canvasSession, setCanvasSession] = useState(0);
  const [savedPlayback, setSavedPlayback] = useState(null);
  const say = m => setMessages(prev => [...prev.slice(-4), m]);
  const reportError = e => {
    if (e instanceof ValidationError) e.errors.forEach(text => say({ kind: 'err', text }));
    else say({ kind: 'err', text: e.message });
  };

  const codeToDiagram = () => {
    try {
      const result = interpret(code);
      setCanvasSession(s => s + 1);
      setSavedPlayback(null);
      setState(result.state);
      setSnapshots(result.snapshots);
      setStep(0);
      say({
        kind: 'ok',
        text: `Ready: ${result.snapshots.length} execution steps. Select Next to begin. Yellow marks the next line and new or changed memory.`,
      });
    } catch (e) {
      reportError(e);
    }
  };
  const diagramToCode = () => {
    try {
      setCode(generate(state));
      setSnapshots(null);
      setSavedPlayback(null);
      say({ kind: 'ok', text: 'Generated C from the current memory state.' });
    } catch (e) {
      reportError(e);
    }
  };
  const onDiagramEdit = next => {
    setState(next);
    setSnapshots(null);
    try {
      validate(next);
    } catch (e) {
      if (e instanceof ValidationError) say({ kind: 'err', text: e.errors[0] });
    }
  };

  // Step 0 shows the empty machine before main() is entered; step n shows snapshot n - 1.
  const emptyState = useMemo(() => makeState(state.structTypes), [state.structTypes]);
  const shownSnapshot = snapshots && step > 0 ? snapshots[step - 1] : null;
  const shownState = snapshots ? (shownSnapshot?.state ?? emptyState) : state;
  const previousState = shownSnapshot ? (step > 1 ? snapshots[step - 2].state : emptyState) : null;
  const nextLine = snapshots ? (step === 0 ? snapshots[0]?.line : shownSnapshot?.nextLine) : null;

  const editSnapshot = () => {
    setSavedPlayback({ state, snapshots, step });
    setState(structuredClone(shownState));
    setSnapshots(null);
    say({
      kind: 'ok',
      text: 'Editing a copy of this snapshot. Return to playback restores the recorded execution. C generation currently supports only a single main() frame.',
    });
  };
  const returnToPlayback = () => {
    setState(savedPlayback.state);
    setSnapshots(savedPlayback.snapshots);
    setStep(savedPlayback.step);
    setSavedPlayback(null);
  };
  const onCode = value => {
    setCode(value);
    setSnapshots(null);
    setSavedPlayback(null);
  };

  return (
    <>
      <div className="workbench">
        <section className="panel" aria-label="C code">
          <div className="panel-head">
            C code
            {snapshots && (
              <span className="panel-context">
                {nextLine ? `Next: line ${nextLine}` : 'Execution complete'}
              </span>
            )}
          </div>
          <CodePanel code={code} onCode={onCode} activeLine={nextLine} />
        </section>
        <div className="spine" role="group" aria-label="convert">
          <button className="convert-btn" title="Run C and show memory" onClick={codeToDiagram}>
            Run →
          </button>
          <button className="convert-btn" title="Generate C from memory" onClick={diagramToCode}>
            ← Generate
          </button>
        </div>
        <section className="panel" aria-label="memory diagram">
          <div className="panel-head">
            Memory
            {shownSnapshot && (
              <span className="panel-context">
                {shownSnapshot.function}(), line {shownSnapshot.line}
              </span>
            )}
            <div className="snapshot-actions">
              {shownSnapshot && (
                <button className="plain-btn" onClick={editSnapshot}>
                  Edit this snapshot
                </button>
              )}
              {savedPlayback && (
                <button className="plain-btn" onClick={returnToPlayback}>
                  Return to playback
                </button>
              )}
            </div>
          </div>
          <MemoryCanvas
            key={canvasSession}
            state={shownState}
            previousState={previousState}
            onChange={onDiagramEdit}
            editable={!snapshots}
            onMessage={say}
          />
          {snapshots?.length > 0 && (
            <div className="stepper">
              <button className="step-btn" disabled={step <= 0} onClick={() => setStep(s => s - 1)}>
                Previous
              </button>
              <input
                type="range"
                min={0}
                max={snapshots.length}
                value={step}
                onChange={e => setStep(Number(e.target.value))}
                aria-label="execution step"
              />
              <span>
                {step}/{snapshots.length}
              </span>
              <button
                className="step-btn"
                disabled={step >= snapshots.length}
                onClick={() => setStep(s => s + 1)}
              >
                Next
              </button>
            </div>
          )}
        </section>
      </div>
      {messages.length > 0 && (
        <div className="msgbar" role="log">
          {messages.map((m, i) => (
            <div key={i} className={m.kind}>
              {m.text}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
