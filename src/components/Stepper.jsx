/**
 * Debugger controls for recorded playback: step, step over/out, continue to a breakpoint,
 * the reverse of each (Shift), the call stack, and a scrubber over every step.
 */
import { useEffect, useRef, useState } from 'react';
import {
  callStack,
  canReverseStepOut,
  canStepOut,
  continueBackward,
  continueForward,
  reverseStepOut,
  reverseStepOver,
  runToFrame,
  stepBack,
  stepInto,
  stepOut,
  stepOver,
} from '../machine/navigation.js';

// Chrome DevTools' bindings, which avoid the browser's own F5 (reload).
const COMMANDS = {
  into: {
    label: 'Step into',
    title: 'Step into: run one step, entering any function called (F11)',
    run: stepInto,
  },
  over: {
    label: 'Step over',
    title:
      'Step over: run this statement, including any function calls (F10). Shift+click goes back one statement.',
    run: stepOver,
    reverse: {
      label: 'Reverse over',
      title: 'Reverse over: go back one statement, undoing any function calls (Shift+F10)',
      run: reverseStepOver,
    },
  },
  out: {
    label: 'Step out',
    title:
      'Step out: finish this function and return to its caller (Shift+F11). Shift+click goes back to the call.',
    run: stepOut,
    can: canStepOut,
    reverse: {
      label: 'Reverse out',
      title: 'Reverse out: go back to just before this function was called',
      run: reverseStepOut,
      can: canReverseStepOut,
    },
  },
  continue: {
    label: 'Continue',
    title:
      'Continue: run to the next breakpoint, or to the end (F8). Click a line number to set a breakpoint. Shift+click runs backwards.',
    run: continueForward,
    reverse: {
      label: 'Reverse continue',
      title:
        'Reverse continue: run backwards to the previous breakpoint, or to the start (Shift+F8)',
      run: continueBackward,
    },
  },
};

const KEYS = {
  F11: ['into', false],
  'Shift+F11': ['out', false],
  F10: ['over', false],
  'Shift+F10': ['over', true],
  F8: ['continue', false],
  'Shift+F8': ['continue', true],
};

/** Where `name` (backward or not) moves from step k, or null when it is unavailable. */
function target(name, backward, snapshots, k, breakpoints) {
  const forward = COMMANDS[name];
  const command = backward ? forward.reverse : forward;
  if (!command) return null;
  if (backward ? k <= 0 : k >= snapshots.length) return null;
  if (command.can && !command.can(snapshots, k)) return null;
  return command.run(snapshots, k, breakpoints);
}

export default function Stepper({ snapshots, step, onStep, breakpoints }) {
  const ref = useRef(null);
  const [shift, setShift] = useState(false);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Shift') setShift(e.type === 'keydown');
      if (e.type !== 'keydown' || e.ctrlKey || e.metaKey || e.altKey) return;
      const binding = KEYS[e.shiftKey ? `Shift+${e.key}` : e.key];
      // A kept-alive page stays mounted while another tab is shown.
      if (!binding || !ref.current || ref.current.closest('[hidden]')) return;
      e.preventDefault();
      const next = target(...binding, snapshots, step, breakpoints);
      if (next !== null) onStep(next);
    };
    const release = () => setShift(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', release);
    };
  }, [snapshots, step, breakpoints, onStep]);

  const button = name => {
    const backward = shift && !!COMMANDS[name].reverse;
    const shown = backward ? COMMANDS[name].reverse : COMMANDS[name];
    const inMain =
      name === 'out' && !backward && step < snapshots.length && !canStepOut(snapshots, step);
    return (
      <button
        key={name}
        className="step-btn"
        disabled={target(name, backward, snapshots, step, breakpoints) === null}
        title={inMain ? 'Step out: already in main(), which has no caller' : shown.title}
        onClick={e => {
          const next = target(
            name,
            e.shiftKey && !!COMMANDS[name].reverse,
            snapshots,
            step,
            breakpoints,
          );
          if (next !== null) onStep(next);
        }}
      >
        {shown.label}
      </button>
    );
  };

  const stack = callStack(snapshots, step);
  return (
    <div className="stepper" ref={ref}>
      <div className="call-stack" role="group" aria-label="Call stack">
        <span className="call-stack-label">Call stack</span>
        <ol>
          {stack.map((frame, i) =>
            i === stack.length - 1 ? (
              <li key={frame.frameId} aria-current="step">
                <strong>{frame.function}()</strong>
              </li>
            ) : (
              <li key={frame.frameId}>
                <button
                  className="call-stack-frame"
                  title={`Run until execution returns to ${frame.function}(). Shift+click goes back to where it made this call.`}
                  onClick={e =>
                    onStep(runToFrame(snapshots, step, frame.frameId, { backward: e.shiftKey }))
                  }
                >
                  {frame.function}()
                </button>
              </li>
            ),
          )}
        </ol>
      </div>
      <div className="step-controls" role="toolbar" aria-label="Step through execution">
        <button
          className="step-btn"
          disabled={step <= 0}
          onClick={() => onStep(stepBack(step))}
          title="Step back: undo the last step"
        >
          Step back
        </button>
        {['into', 'over', 'out', 'continue'].map(button)}
      </div>
      <div className="step-scrub">
        <input
          type="range"
          min={0}
          max={snapshots.length}
          value={step}
          onChange={e => onStep(Number(e.target.value))}
          aria-label="execution step"
        />
        <span className="step-count">
          {step}/{snapshots.length}
        </span>
      </div>
    </div>
  );
}
