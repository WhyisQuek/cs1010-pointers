/** Bidirectional code/memory sandbox with step-through playback. */
import { useEffect, useMemo, useState } from 'react';
import { CodePanel } from './CodePanel.jsx';
import MemoryCanvas from './MemoryCanvas.jsx';
import Workbench from './Workbench.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { generate, ValidationError, validate } from '../pipeline/codegen.js';
import { makeState } from '../machine/memory.js';

const STARTER = `int main(void) {
    int a = 10;
    return 0;
}
`;
const NOTICE_MS = 5000;

export default function Sandbox() {
  const [code, setCode] = useState(STARTER);
  const [state, setState] = useState(makeState);
  const [snapshots, setSnapshots] = useState(null);
  const [step, setStep] = useState(0);
  // One current message about the code: errors stay until the next edit or run.
  const [notice, setNotice] = useState(null);
  const [canvasSession, setCanvasSession] = useState(0);
  const [savedPlayback, setSavedPlayback] = useState(null);
  const reportError = e =>
    setNotice({
      kind: 'err',
      text: e instanceof ValidationError ? e.errors.join('\n') : e.message,
    });
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const codeToDiagram = () => {
    try {
      const result = interpret(code);
      setCanvasSession(s => s + 1);
      setSavedPlayback(null);
      setState(result.state);
      setSnapshots(result.snapshots);
      setStep(0);
      setNotice({
        kind: 'ok',
        text: `Ready: ${result.snapshots.length} execution steps. Select Next to begin.`,
      });
    } catch (e) {
      reportError(e);
    }
  };

  // Step 0 shows the empty machine before main() is entered; step n shows snapshot n - 1.
  const emptyState = useMemo(() => makeState(state.structTypes), [state.structTypes]);
  const shownSnapshot = snapshots && step > 0 ? snapshots[step - 1] : null;
  const shownState = snapshots ? (shownSnapshot?.state ?? emptyState) : state;
  const previousState = shownSnapshot ? (step > 1 ? snapshots[step - 2].state : emptyState) : null;
  const nextLine = snapshots ? (step === 0 ? snapshots[0]?.line : shownSnapshot?.nextLine) : null;

  // Generates from the memory on screen, which during playback is the selected step.
  const diagramToCode = () => {
    try {
      setCode(generate(shownState));
      if (snapshots) setState(structuredClone(shownState));
      setSnapshots(null);
      setSavedPlayback(null);
      setNotice({ kind: 'ok', text: 'Generated C from the memory shown.' });
    } catch (e) {
      reportError(e);
    }
  };
  const onDiagramEdit = next => {
    setState(next);
    setSnapshots(null);
    try {
      validate(next);
      setNotice(n => (n?.kind === 'err' ? null : n));
    } catch (e) {
      if (e instanceof ValidationError)
        setNotice({ kind: 'err', text: `Cannot generate C: ${e.errors[0]}` });
    }
  };

  const editSnapshot = () => {
    setSavedPlayback({ state, snapshots, step });
    setState(structuredClone(shownState));
    setSnapshots(null);
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
    setNotice(null);
  };

  const memoryContext = shownSnapshot
    ? `step ${step}/${snapshots.length} · ${shownSnapshot.function}() line ${shownSnapshot.line}`
    : snapshots
      ? `step 0/${snapshots.length}`
      : savedPlayback
        ? `editing a copy of step ${savedPlayback.step}`
        : null;

  return (
    <Workbench
      left={
        <section className="panel" aria-label="C code">
          <div className="panel-head">
            C code
            {snapshots && !nextLine && <span className="panel-context">Execution complete</span>}
            <div className="panel-actions">
              <button className="primary-btn head-btn" onClick={codeToDiagram}>
                Run
              </button>
            </div>
          </div>
          <CodePanel code={code} onCode={onCode} activeLine={nextLine} />
          <div
            className={`pane-message${notice ? ` ${notice.kind}` : ''}`}
            role="status"
            aria-live="polite"
          >
            {notice?.text}
          </div>
        </section>
      }
      right={
        <section className="panel" aria-label="memory diagram">
          <div className="panel-head">
            Memory
            {memoryContext && <span className="panel-context">{memoryContext}</span>}
            <div className="panel-actions">
              {shownSnapshot && (
                <button className="plain-btn head-btn" onClick={editSnapshot}>
                  Edit
                </button>
              )}
              {savedPlayback && (
                <button className="plain-btn head-btn" onClick={returnToPlayback}>
                  Back to playback
                </button>
              )}
              <button className="plain-btn head-btn" onClick={diagramToCode}>
                Generate C
              </button>
            </div>
          </div>
          <MemoryCanvas
            key={canvasSession}
            state={shownState}
            previousState={previousState}
            onChange={onDiagramEdit}
            editable={!snapshots}
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
      }
    />
  );
}
