/**
 * Debugger-style navigation over recorded playback.
 *
 * Step k shows snapshots[k - 1] (step 0 is before main() is entered) and is paused where
 * that snapshot's next* fields point. Every command returns the step to move to; all of
 * them stop early at a runtime error, which is always the last snapshot.
 */

/** The frame execution is paused in at step k. */
export function pausedAt(snapshots, k) {
  if (k === 0) return { frameId: 'main', function: 'main', depth: 0 };
  const s = snapshots[k - 1];
  return {
    frameId: s.nextFrameId ?? s.frameId,
    function: s.nextFunction ?? s.function,
    depth: s.nextDepth ?? s.depth ?? 0,
  };
}

function firstAfter(snapshots, k, stops) {
  for (let j = k + 1; j <= snapshots.length; j++) {
    const done = snapshots[j - 1];
    if (done.error || stops(done)) return j;
  }
  return snapshots.length;
}

export function stepInto(snapshots, k) {
  return Math.min(k + 1, snapshots.length);
}

export function stepBack(k) {
  return Math.max(k - 1, 0);
}

/**
 * Whether snapshot `s` finishes a step of a frame at `depth` or shallower: it ran there, or it is
 * the LeaveFrame that completes a statement there, as in `f(x);`, which records no step of its own.
 */
function endsStepAt(s, depth) {
  return s.depth <= depth || s.completesDepth <= depth;
}

/** Runs the paused statement, including every call it makes, back to this frame or a caller. */
export function stepOver(snapshots, k) {
  const { depth } = pausedAt(snapshots, k);
  return firstAfter(snapshots, k, done => endsStepAt(done, depth));
}

/** Runs the current function to completion, stopping in the caller just after it returns. */
export function stepOut(snapshots, k) {
  const { frameId } = pausedAt(snapshots, k);
  return firstAfter(
    snapshots,
    k,
    done => done.statement === 'LeaveFrame' && done.frameId === frameId,
  );
}

/** main() has no caller to return to. */
export function canStepOut(snapshots, k) {
  return k < snapshots.length && pausedAt(snapshots, k).depth > 0;
}

/** The line highlighted at step k: the one about to run, or where a runtime error stopped. */
export function pausedLine(snapshots, k) {
  if (k === 0) return snapshots[0]?.line ?? null;
  const done = snapshots[k - 1];
  // main() can end on a call's LeaveFrame, which still points back at the call.
  if (k === snapshots.length && !done.error) return null;
  return done.nextLine;
}

/** Undoes the previous statement of this frame or a caller, with every call it made. */
export function reverseStepOver(snapshots, k) {
  const { depth } = pausedAt(snapshots, k);
  for (let j = k - 1; j > 0; j--) if (endsStepAt(snapshots[j - 1], depth)) return j;
  return 0;
}

/** Goes back to the call site in the caller, just before the current function was called. */
export function reverseStepOut(snapshots, k) {
  const { frameId } = pausedAt(snapshots, k);
  const entered = snapshots.findIndex(s => s.statement === 'EnterFrame' && s.frameId === frameId);
  return Math.max(Math.min(entered, k - 1), 0);
}

export function canReverseStepOut(snapshots, k) {
  return k > 0 && pausedAt(snapshots, k).depth > 0;
}

/**
 * Arriving at a breakpoint line stops; returning to the call site of a line that is already
 * running (after a LeaveFrame) does not, so one line with several calls stops once. A LeaveFrame
 * that completes its statement arrives at the next line, so it can stop.
 */
function onBreakpoint(snapshots, j, breakpoints) {
  const done = snapshots[j - 1];
  return (
    breakpoints.has(pausedLine(snapshots, j)) &&
    (done?.statement !== 'LeaveFrame' || done.completesDepth !== undefined)
  );
}

/** Runs to the next breakpoint, or to the end. */
export function continueForward(snapshots, k, breakpoints) {
  for (let j = k + 1; j <= snapshots.length; j++)
    if (snapshots[j - 1].error || onBreakpoint(snapshots, j, breakpoints)) return j;
  return snapshots.length;
}

/** Runs backwards to the previous breakpoint, or to the start. */
export function continueBackward(snapshots, k, breakpoints) {
  for (let j = k - 1; j > 0; j--) if (onBreakpoint(snapshots, j, breakpoints)) return j;
  return 0;
}

/** The active calls at step k, outermost (main) first. */
export function callStack(snapshots, k) {
  const paused = pausedAt(snapshots, k);
  const frames = k > 0 ? snapshots[k - 1].state.frames : [];
  const stack = [];
  for (let id = paused.frameId; id;) {
    const frame = frames.find(f => f.id === id);
    stack.unshift({ frameId: id, function: frame?.name ?? paused.function });
    id = frame?.callerId;
  }
  return stack;
}

/** Steps out (or back out) until execution is paused in `frameId`, which must be on the stack. */
export function runToFrame(snapshots, k, frameId, { backward = false } = {}) {
  let j = k;
  while (pausedAt(snapshots, j).frameId !== frameId) {
    const next = backward ? reverseStepOut(snapshots, j) : stepOut(snapshots, j);
    if (next === j) break;
    j = next;
    if (j >= snapshots.length) break;
  }
  return j;
}
