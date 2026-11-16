/** Bidirectional code/memory sandbox with step-through playback. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CodePanel } from './CodePanel.jsx';
import MemoryCanvas from './MemoryCanvas.jsx';
import Stepper from './Stepper.jsx';
import Workbench from './Workbench.jsx';
import { shiftBreakpoints } from './breakpoints.js';
import { interpret } from '../pipeline/interpreter.js';
import { describeError } from '../language/diagnostics.js';
import { generate, observableState, ValidationError } from '../pipeline/codegen.js';
import { appendToCode } from '../pipeline/patch.js';
import { makeState } from '../machine/memory.js';
import { loadDraft, saveDraft } from '../data/drafts.js';
import { pausedLine } from '../machine/navigation.js';
import { leaksByStep } from '../flow/structureLayout.js';
import { useViewPreference } from '../data/viewPreference.js';
import { telemetry } from '../data/telemetry.js';
import { EXAMPLES } from '../data/tutorialExamples.js';

const STARTER = `int main(void) {
    int a = 10;
    return 0;
}
`;
const NOTICE_MS = 5000;
// Code a student can get back with one click, so replacing it needs no confirmation.
const REPLACEABLE = new Set(['', STARTER, ...EXAMPLES.map(e => e.code)]);

/**
 * `example` ({ code, seq }) comes from Try it on Start here: each new `seq` loads that code and
 * runs it. If that would replace the student's own code or edited diagram, they are asked
 * first; declining calls `onExampleDeclined` and leaves everything as it was.
 */
export default function Sandbox({ example, onExampleDeclined }) {
  const [draft] = useState(loadDraft);
  const [code, setCode] = useState(draft?.code ?? STARTER);
  const [state, setState] = useState(() => draft?.diagram ?? makeState());
  const [snapshots, setSnapshots] = useState(null);
  const [step, setStep] = useState(0);
  // Line numbers; kept across runs and moved with the code as it is edited.
  const [breakpoints, setBreakpoints] = useState(() => new Set());
  const toggleBreakpoint = line =>
    setBreakpoints(b => {
      const next = new Set(b);
      if (!next.delete(line)) next.add(line);
      return next;
    });
  // One current message about the code: errors stay until the next edit or run.
  const [notice, setNotice] = useState(() =>
    draft && (draft.code !== STARTER || draft.diagram?.allocations.length)
      ? { kind: 'ok', text: 'Restored your code and diagram from your last visit.' }
      : null,
  );
  // Playback is not saved (Run reproduces it), so only an editable diagram goes in the draft.
  useEffect(() => saveDraft(code, snapshots ? null : state), [code, state, snapshots]);
  const [canvasSession, setCanvasSession] = useState(0);
  const [savedPlayback, setSavedPlayback] = useState(null);
  // Lines Generate C just added to the code, highlighted until the code changes again.
  const [addedLines, setAddedLines] = useState(null);
  // A state the code is known to end with, carrying the diagram's allocation IDs: the step
  // Edit copied, or the diagram as last generated. appendToCode pairs blocks through it.
  const synced = useRef(null);
  // The code as Generate C last wrote it whole; while unchanged, nobody else has written any.
  const written = useRef(null);
  const errorText = e => (e instanceof ValidationError ? e.errors.join('\n') : describeError(e));
  const reportError = e => setNotice({ kind: 'err', text: errorText(e) });
  useEffect(() => {
    // A notice with a button stays until the code or diagram changes again.
    if (notice?.kind !== 'ok' || notice.undo || notice.rewrite) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadPlayback = (result, startStep) => {
    setAddedLines(null);
    setCanvasSession(s => s + 1);
    setSavedPlayback(null);
    setState(result.state);
    setSnapshots(result.snapshots);
    setStep(startStep);
  };
  const codeToDiagram = (source = code) => {
    try {
      const result = interpret(source);
      loadPlayback(result, 0);
      telemetry.track('run', { code: source, steps: result.snapshots.length, error: null });
      setNotice({
        kind: 'ok',
        text: `Ready: ${result.snapshots.length} execution steps. Select Step into to begin.`,
      });
    } catch (e) {
      // steps is null when the code did not compile, so no step ran.
      const steps = e.playback ? e.playback.snapshots.length : null;
      telemetry.track('run', { code: source, steps, error: errorText(e) });
      if (!e.playback) return reportError(e);
      // A runtime error opens playback at the step where execution stopped.
      loadPlayback(e.playback, steps);
      setNotice({
        kind: 'err',
        text: `Stopped at step ${steps}. ${describeError(e)}. Select Step back to see how it got there.`,
      });
    }
  };

  // Step 0 shows the empty machine before main() is entered; step n shows snapshot n - 1.
  const emptyState = useMemo(() => makeState(state.structTypes), [state.structTypes]);
  const shownSnapshot = snapshots && step > 0 ? snapshots[step - 1] : null;
  const shownState = snapshots ? (shownSnapshot?.state ?? emptyState) : state;
  const previousState = shownSnapshot ? (step > 1 ? snapshots[step - 2].state : emptyState) : null;
  // Leaks need the whole run (see leaksByStep), so they are found once per run, and only
  // while Structure view, which shows them, is chosen.
  const [view] = useViewPreference();
  const leaks = useMemo(
    () => (snapshots && view === 'structure' ? leaksByStep(snapshots) : null),
    [snapshots, view],
  );
  const nextLine = snapshots?.length ? pausedLine(snapshots, step) : null;

  // Step 0 shows no memory, so generating there would only empty the program.
  const nothingToGenerate = !!snapshots && step === 0;
  /**
   * Generate C adds lines to the code when the diagram can be reached that way, and
   * otherwise writes the program again from the memory on screen (see patch.js).
   */
  const everything = () => ({
    code,
    breakpoints,
    state,
    snapshots,
    step,
    savedPlayback,
    synced: synced.current,
  });
  const alreadyBuilt = () =>
    setNotice({ kind: 'ok', text: 'The code already builds the memory shown.', rewrite: true });
  const diagramToCode = () => {
    // The last step of a finished run is the memory this code ends with.
    const finished = snapshots && step === snapshots.length && !shownSnapshot?.error;
    if (finished) return alreadyBuilt();
    // An earlier step is not: adding to the end cannot go back to it.
    if (snapshots) return rewrite();
    // Adding lines is for keeping code someone wrote. Code that Generate C wrote whole is
    // written whole again, which stays tidier; so is starter or example code beside a
    // diagram that was drawn rather than edited from a run of it.
    if (code === written.current || (!synced.current && REPLACEABLE.has(code))) return rewrite();
    const result = appendToCode(code, state, synced.current);
    if (!result.code) return rewrite(result.reason);
    if (!result.added.length) return alreadyBuilt();
    telemetry.track('generate', {
      state,
      step: null,
      code: result.code,
      error: null,
      mode: 'append',
    });
    const undo = everything();
    setBreakpoints(b => shiftBreakpoints(code, result.code, b));
    setCode(result.code);
    setAddedLines(new Set(result.added));
    synced.current = state;
    const count = result.added.length;
    setNotice({
      kind: 'ok',
      text: `Added ${count} line${count === 1 ? '' : 's'} to your code.`,
      undo,
      rewrite: true,
    });
  };
  /**
   * Replaces the code with a program written from the memory shown. `reason` says why
   * lines could not be added instead; `undo` is what Restore goes back to, when that is
   * older than what is on screen now.
   */
  const rewrite = (reason = null, undo = everything()) => {
    // step is null for an edited diagram, which is not part of a playback.
    const shown = { state: shownState, step: snapshots ? step : null, mode: 'rewrite' };
    try {
      const generated = generate(shownState);
      telemetry.track('generate', { ...shown, code: generated, error: null });
      setCode(generated);
      written.current = generated;
      setBreakpoints(new Set());
      setAddedLines(null);
      // The diagram becomes what the new code builds: history it leaves out goes too. A
      // diagram being edited is replaced only if that removes something, so that its own
      // undo history survives otherwise.
      const built = observableState(shownState);
      const tidied =
        built.allocations.length !== shownState.allocations.length ||
        built.frames.length !== (shownState.frames ?? []).length;
      const next = snapshots || tidied ? structuredClone(built) : state;
      setState(next);
      synced.current = next;
      setSnapshots(null);
      setSavedPlayback(null);
      const same = generated === undo.code;
      setNotice({
        kind: 'ok',
        text: same
          ? 'The code already builds the memory shown.'
          : // Code that one click brings back needs no explanation for replacing it.
            reason && !REPLACEABLE.has(undo.code)
            ? `Rewrote the code from the memory shown: ${reason}.`
            : 'Generated C from the memory shown.',
        undo: same ? null : undo,
      });
    } catch (e) {
      telemetry.track('generate', { ...shown, code: null, error: errorText(e) });
      setNotice({ kind: 'err', text: cannotGenerate(e) });
    }
  };
  const undoGenerate = () => {
    const { undo } = notice;
    setCode(undo.code);
    setBreakpoints(undo.breakpoints);
    setState(undo.state);
    setSnapshots(undo.snapshots);
    setStep(undo.step);
    setSavedPlayback(undo.savedPlayback);
    setAddedLines(null);
    synced.current = undo.synced;
    setNotice({ kind: 'ok', text: 'Restored your code and the memory it was generated from.' });
  };
  const cannotGenerate = e => `Cannot generate C: ${errorText(e)}`;
  /** A notice with a button stays until the code or diagram changes again. */
  const hasAction = n => !!(n?.undo || n?.rewrite);
  /**
   * Says straight away when the diagram cannot become code, so that nobody finds out only
   * after editing it. A diagram that can clears the earlier error and any offered action.
   */
  const checkGeneratable = (diagram, known = synced.current) => {
    try {
      generate(diagram);
      setNotice(n => (n?.kind === 'err' || hasAction(n) ? null : n));
    } catch (e) {
      // It may still be reachable by adding lines to code that builds the rest.
      if (appendToCode(code, diagram, known).code)
        setNotice(n => (n?.kind === 'err' || hasAction(n) ? null : n));
      else setNotice({ kind: 'err', text: cannotGenerate(e) });
    }
  };
  const onDiagramEdit = next => {
    setState(next);
    setSnapshots(null);
    checkGeneratable(next);
  };

  const editSnapshot = () => {
    setSavedPlayback({ state, snapshots, step, synced: synced.current });
    setState(structuredClone(shownState));
    setSnapshots(null);
    // The copy keeps the run's allocation IDs, which is how its edits are told apart.
    synced.current = shownState;
    checkGeneratable(shownState, shownState);
  };
  const returnToPlayback = () => {
    setState(savedPlayback.state);
    setSnapshots(savedPlayback.snapshots);
    setStep(savedPlayback.step);
    synced.current = savedPlayback.synced;
    setSavedPlayback(null);
  };
  const onCode = value => {
    setBreakpoints(b => shiftBreakpoints(code, value, b));
    setCode(value);
    setAddedLines(null);
    if (snapshots) {
      // Playback no longer matches the code. Keep the memory on screen (as Edit does) rather
      // than falling back to the run's final state, and say why the steps went away.
      setState(structuredClone(shownState));
      synced.current = shownState;
      setNotice({
        kind: 'ok',
        text: `Code changed, so playback ended. The diagram still shows step ${step}; Run to replay.`,
      });
      // Errors are about the old code; other notices (this one) expire by themselves. An
      // offer to undo Generate C goes too: it would discard what is being typed.
    } else setNotice(n => (n?.kind === 'err' || hasAction(n) ? null : n));
    setSnapshots(null);
    setSavedPlayback(null);
  };

  // The effect below runs only when a new example arrives, so it reads the rest from here.
  const current = useRef(null);
  current.current = { code, state, snapshots, run: codeToDiagram, onExampleDeclined };
  useEffect(() => {
    if (!example) return;
    const { code, state, snapshots, run, onExampleDeclined } = current.current;
    if (code === example.code) return run();
    const ownCode = !REPLACEABLE.has(code);
    const ownDiagram = !snapshots && state.allocations.length > 0;
    const replacing = ownCode ? 'your code' : ownDiagram ? 'the diagram you are editing' : null;
    if (replacing && !window.confirm(`Replace ${replacing} with this example?`))
      return onExampleDeclined?.();
    setCode(example.code);
    setBreakpoints(new Set());
    run(example.code);
  }, [example]);

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
            {shownSnapshot?.error ? (
              <span className="panel-context error-context">Stopped by an error</span>
            ) : (
              snapshots && !nextLine && <span className="panel-context">Execution complete</span>
            )}
            <div className="panel-actions">
              <button className="primary-btn head-btn" onClick={() => codeToDiagram()}>
                Run
              </button>
            </div>
          </div>
          <CodePanel
            code={code}
            onCode={onCode}
            activeLine={nextLine}
            activeError={!!shownSnapshot?.error}
            addedLines={addedLines}
            breakpoints={breakpoints}
            onToggleBreakpoint={toggleBreakpoint}
          />
          {snapshots?.at(-1)?.output && (
            <section className="program-output" aria-label="Program output">
              <div className="program-output-head">Output</div>
              <pre>{shownSnapshot?.output ?? ''}</pre>
            </section>
          )}
          <div
            className={`pane-message${notice ? ` ${notice.kind}` : ''}`}
            role="status"
            aria-live="polite"
          >
            {notice?.text}
            {notice?.undo && (
              <button className="plain-btn notice-action" onClick={undoGenerate}>
                Restore previous code
              </button>
            )}
            {notice?.rewrite && (
              <button
                className="plain-btn notice-action"
                title="Replace the code with a program written only from the memory shown"
                onClick={() => rewrite(null, notice.undo ?? undefined)}
              >
                Rewrite from scratch
              </button>
            )}
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
              <button
                className="plain-btn head-btn"
                onClick={diagramToCode}
                disabled={nothingToGenerate}
                title={
                  nothingToGenerate
                    ? 'No memory is shown yet. Step into the program first.'
                    : 'Write C that builds the memory shown'
                }
              >
                Generate C
              </button>
            </div>
          </div>
          <MemoryCanvas
            key={canvasSession}
            state={shownState}
            previousState={previousState}
            unreachable={leaks && shownSnapshot ? leaks[step - 1] : null}
            onChange={onDiagramEdit}
            editable={!snapshots}
            structHint="To use a struct, define it in the code and Run, then Edit a step."
          />
          {snapshots?.length > 0 && (
            <Stepper snapshots={snapshots} step={step} onStep={setStep} breakpoints={breakpoints} />
          )}
        </section>
      }
    />
  );
}
