import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import {
  callStack,
  canReverseStepOut,
  canStepOut,
  continueBackward,
  continueForward,
  pausedAt,
  reverseStepOut,
  reverseStepOver,
  runToFrame,
  stepBack,
  stepInto,
  stepOut,
  stepOver,
} from '../src/machine/navigation.js';
import { shiftBreakpoints } from '../src/components/breakpoints.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const { snapshots } = interpret(`int add(int a, int b) {
    int s = a + b;
    return s;
}
int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
int main(void) {
    int x = add(1, 2) + add(3, 4);
    int y = fact(3);
    return 0;
}`);

// The line highlighted at step k: where execution is paused.
const lineAt = k => (k === 0 ? snapshots[0].line : snapshots[k - 1].nextLine);

test('snapshots record the depth of the frame they ran in and the frame paused in next', () => {
  assert.deepEqual(pausedAt(snapshots, 0), { frameId: 'main', function: 'main', depth: 0 });
  const enterAdd = snapshots.findIndex(s => s.statement === 'EnterFrame' && s.function === 'add');
  assert.equal(snapshots[enterAdd].depth, 1);
  assert.equal(pausedAt(snapshots, enterAdd + 1).function, 'add');
  assert.equal(pausedAt(snapshots, enterAdd + 1).depth, 1);
});

test('step into and step back move one step and stay in range', () => {
  assert.equal(stepInto(snapshots, 0), 1);
  assert.equal(stepInto(snapshots, snapshots.length), snapshots.length);
  assert.equal(stepBack(3), 2);
  assert.equal(stepBack(0), 0);
});

test('step over runs every call on a line, then stops at the next statement', () => {
  assert.equal(lineAt(1), 10);
  // int x = add(1, 2) + add(3, 4); runs both calls.
  const afterX = stepOver(snapshots, 1);
  assert.equal(lineAt(afterX), 11);
  assert.equal(pausedAt(snapshots, afterX).frameId, 'main');
  // int y = fact(3); runs the whole recursion.
  const afterY = stepOver(snapshots, afterX);
  assert.equal(lineAt(afterY), 12);
  assert.equal(stepOver(snapshots, afterY), snapshots.length);
});

test('step over inside a recursive call stays in that call', () => {
  const inFact = stepInto(snapshots, stepOver(snapshots, 1));
  assert.equal(pausedAt(snapshots, inFact).function, 'fact');
  const atReturn = stepOver(snapshots, inFact);
  assert.equal(lineAt(atReturn), 7);
  // return n * fact(n - 1); skips the deeper calls and stays in this frame.
  const atEnd = stepOver(snapshots, atReturn);
  assert.equal(pausedAt(snapshots, atEnd).frameId, pausedAt(snapshots, inFact).frameId);
  assert.equal(lineAt(atEnd), 8);
  // The closing brace returns to main at the call site.
  const back = stepOver(snapshots, atEnd);
  assert.deepEqual([lineAt(back), pausedAt(snapshots, back).frameId], [11, 'main']);
});

test('step out returns from the current call, not an outer call of the same function', () => {
  // Step into fact(3), then into fact(2).
  let k = stepInto(snapshots, stepOver(snapshots, 1));
  k = stepInto(snapshots, stepOver(snapshots, k));
  const inner = pausedAt(snapshots, k);
  assert.equal(inner.depth, 2);
  assert.ok(canStepOut(snapshots, k));

  const out = stepOut(snapshots, k);
  assert.equal(snapshots[out - 1].statement, 'LeaveFrame');
  assert.equal(snapshots[out - 1].frameId, inner.frameId);
  assert.equal(pausedAt(snapshots, out).depth, 1);
  assert.equal(lineAt(out), 7);
  assert.equal(pausedAt(snapshots, stepOut(snapshots, out)).frameId, 'main');
});

test('step out is unavailable in main() and at the end', () => {
  assert.equal(canStepOut(snapshots, 0), false);
  assert.equal(canStepOut(snapshots, 1), false);
  assert.equal(canStepOut(snapshots, snapshots.length), false);
});

test('reverse step over goes back a statement in this frame, undoing its calls', () => {
  const afterY = stepOver(snapshots, stepOver(snapshots, 1));
  assert.equal(lineAt(afterY), 12);
  const beforeY = reverseStepOver(snapshots, afterY);
  assert.deepEqual([lineAt(beforeY), pausedAt(snapshots, beforeY).frameId], [11, 'main']);
  assert.equal(lineAt(reverseStepOver(snapshots, beforeY)), 10);
  assert.equal(reverseStepOver(snapshots, 1), 0);

  // Inside fact(3): back over the recursive call, then to the call site in main.
  const inFact = stepInto(snapshots, stepOver(snapshots, 1));
  const atEnd = stepOver(snapshots, stepOver(snapshots, inFact));
  assert.equal(lineAt(reverseStepOver(snapshots, atEnd)), 7);
  assert.equal(pausedAt(snapshots, reverseStepOver(snapshots, inFact)).frameId, 'main');
});

test('reverse step out goes back to the call site just before the call', () => {
  let k = stepInto(snapshots, stepOver(snapshots, 1));
  const outer = pausedAt(snapshots, k);
  k = stepInto(snapshots, stepOver(snapshots, k));
  assert.ok(canReverseStepOut(snapshots, k));
  const back = reverseStepOut(snapshots, k);
  assert.deepEqual([lineAt(back), pausedAt(snapshots, back).frameId], [7, outer.frameId]);
  assert.equal(snapshots[back].statement, 'EnterFrame');
  assert.equal(canReverseStepOut(snapshots, 1), false);
  assert.equal(canReverseStepOut(snapshots, 0), false);
});

test('continue stops on breakpoint lines in both directions', () => {
  const none = new Set();
  assert.equal(continueForward(snapshots, 0, none), snapshots.length);
  assert.equal(continueBackward(snapshots, 10, none), 0);

  // Every call of add() reaches line 3; returning to line 10 between the calls does not stop.
  const onAdd = new Set([3, 10]);
  const first = continueForward(snapshots, 0, onAdd);
  assert.equal(lineAt(first), 10);
  const second = continueForward(snapshots, first, onAdd);
  const third = continueForward(snapshots, second, onAdd);
  assert.deepEqual([lineAt(second), lineAt(third)], [3, 3]);
  assert.notEqual(pausedAt(snapshots, second).frameId, pausedAt(snapshots, third).frameId);
  assert.equal(continueForward(snapshots, third, onAdd), snapshots.length);
  assert.equal(continueBackward(snapshots, third, onAdd), second);
  assert.equal(continueBackward(snapshots, first, onAdd), 0);
});

test('the call stack lists active calls, outermost first', () => {
  assert.deepEqual(
    callStack(snapshots, 0).map(f => f.function),
    ['main'],
  );
  let k = stepInto(snapshots, stepOver(snapshots, 1));
  k = stepInto(snapshots, stepOver(snapshots, k));
  const stack = callStack(snapshots, k);
  assert.deepEqual(
    stack.map(f => f.function),
    ['main', 'fact', 'fact'],
  );
  // After returning from fact(2), it is gone from the stack.
  assert.equal(callStack(snapshots, stepOut(snapshots, k)).length, 2);

  // Running to an outer frame steps out of every call above it, forwards or backwards.
  const toMain = runToFrame(snapshots, k, 'main');
  assert.deepEqual([lineAt(toMain), callStack(snapshots, toMain).length], [11, 1]);
  const backToMain = runToFrame(snapshots, k, 'main', { backward: true });
  assert.deepEqual([lineAt(backToMain), pausedAt(snapshots, backToMain).frameId], [11, 'main']);
  assert.ok(backToMain < k && toMain > k);
  assert.equal(runToFrame(snapshots, k, stack[2].frameId), k);
});

test('breakpoints move with edits and are dropped with deleted lines', () => {
  const code = 'a\nb\nc\nd';
  const at = (...lines) => new Set(lines);
  // A new line above moves breakpoints below it down.
  assert.deepEqual(shiftBreakpoints(code, 'a\nnew\nb\nc\nd', at(1, 2, 4)), at(1, 3, 5));
  // Enter at the start of a line pushes that line down; at the end of a line it does not.
  assert.deepEqual(shiftBreakpoints(code, 'a\n\nb\nc\nd', at(2)), at(3));
  assert.deepEqual(shiftBreakpoints(code, 'a\nb\n\nc\nd', at(2)), at(2));
  // Typing within a line keeps everything.
  assert.deepEqual(shiftBreakpoints(code, 'a\nbb\nc\nd', at(2, 3)), at(2, 3));
  // Deleting lines b and c removes their breakpoints and moves d up.
  assert.deepEqual(shiftBreakpoints(code, 'a\nd', at(1, 2, 3, 4)), at(1, 2));
  assert.deepEqual(shiftBreakpoints(code, 'a\nd', at(4)), at(2));
  // Joining c onto b keeps b's breakpoint and drops c's.
  assert.deepEqual(shiftBreakpoints(code, 'a\nbc\nd', at(2, 3, 4)), at(2, 3));
});

test('a call used as a statement is one step over, and its next line can break', () => {
  const calls = interpret(`void bump(int *p) {
    (*p)++;
}
void show(int *p, int n) {
    for (int i = 0; i < n; i++) {
        bump(p);
    }
}
int main(void) {
    int a = 1;
    bump(&a);
    show(&a, 2);
    bump(&a);
    a = 0;
    return 0;
}`).snapshots;
  const line = k => (k === 0 ? calls[0].line : calls[k - 1].nextLine);
  const visited = [];
  for (let k = 1; k < calls.length; k = stepOver(calls, k)) visited.push(line(k));
  assert.deepEqual(visited, [10, 11, 12, 13, 14, 15]);

  // Inside show(), stepping over bump(p); stays in the loop: line 5 is the initializer, then
  // each condition and update, and line 7 ends the loop's scope.
  const inShow = stepInto(calls, stepOver(calls, stepOver(calls, 1)));
  assert.equal(pausedAt(calls, inShow).function, 'show');
  const inLoop = [];
  for (let k = inShow; pausedAt(calls, k).function === 'show'; k = stepOver(calls, k))
    inLoop.push(line(k));
  assert.deepEqual(inLoop, [5, 5, 6, 5, 5, 6, 5, 5, 7, 8]);

  // Reverse step over retraces the same statements in main.
  const end = calls.length - 1;
  const back = [];
  for (let k = end; k > 0; k = reverseStepOver(calls, k)) back.push(line(k));
  assert.deepEqual(back, [15, 14, 13, 12, 11, 10]);

  // A breakpoint on the line after a call statement stops there.
  assert.equal(line(continueForward(calls, 1, new Set([12]))), 12);
  assert.equal(line(continueForward(calls, 1, new Set([14]))), 14);
});

test('stepping over or out of a call that fails stops at the error', () => {
  let error;
  try {
    interpret(`void boom(int *p) {
    int a = 1;
    *p = a;
    a = 2;
}
int main(void) {
    boom(NULL);
    return 0;
}`);
  } catch (e) {
    error = e;
  }
  const failed = error.playback.snapshots;
  const last = failed.length;
  assert.ok(failed.at(-1).error);
  assert.equal(stepOver(failed, 1), last);
  const inBoom = stepInto(failed, 1);
  assert.equal(stepOut(failed, inBoom), last);
  assert.equal(pausedAt(failed, last).function, 'boom');
});
