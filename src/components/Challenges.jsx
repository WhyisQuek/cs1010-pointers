/**
 * Student challenge browser and runner.
 * Reference C and student answers are both converted to MemoryState, then graded
 * with semantic graph equivalence rather than source-text comparison.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './CodePanel.jsx';
import Workbench from './Workbench.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { describeError } from '../language/diagnostics.js';
import { drawingIssues, equivalent } from '../pipeline/equivalence.js';
import { makeState } from '../machine/memory.js';
import {
  availableLevels,
  groupLevels,
  loadProgress,
  isSolved,
  markSolved,
} from '../data/levels.js';
import { INSTRUCTOR } from '../edition.js';

const UNSECTIONED = 'More challenges';
const kindLabel = kind => (kind === 'code-to-diagram' ? 'Code → diagram' : 'Diagram → code');
// Only the instructor build has the Level editor, so only it lists browser-saved levels.
// Listed by section; numbering and "Next challenge" follow that order.
const allLevels = () =>
  groupLevels(availableLevels({ includeCustom: INSTRUCTOR })).flatMap(g => g.levels);
const sameLevel = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What to do about a level that can't be attempted depends on who is looking.
const brokenLevelAdvice = editorAdvice =>
  INSTRUCTOR ? editorAdvice : 'Please let your instructor know.';

/**
 * Stays mounted while another tab is shown, so an answer in progress survives a tab switch.
 * `shown` re-reads levels and progress whenever the tab comes back, since the Level editor
 * (instructor build) may have changed them meanwhile.
 */
export default function Challenges({ shown = true }) {
  const [active, setActive] = useState(null);
  const [levels, setLevels] = useState(allLevels);
  const [progress, setProgress] = useState(loadProgress);

  const refresh = useCallback(() => {
    const fresh = allLevels();
    setLevels(fresh);
    setProgress(loadProgress());
    // A level deleted or edited meanwhile closes: the answer being built may no longer apply.
    setActive(current =>
      current && fresh.some(l => l.id === current.id && sameLevel(l, current)) ? current : null,
    );
  }, []);

  useEffect(() => {
    if (shown) refresh();
  }, [shown, refresh]);

  const exit = () => {
    setActive(null);
    refresh();
  };

  if (active) {
    const next = levels[levels.findIndex(l => l.id === active.id) + 1] ?? null;
    return (
      <ChallengeRunner
        key={active.id}
        level={active}
        onExit={exit}
        onNext={next && (() => setActive(next))}
      />
    );
  }
  const solvedCount = list => list.filter(lv => isSolved(progress, lv.id)).length;
  const card = lv => {
    const solved = isSolved(progress, lv.id);
    return (
      <button
        key={lv.id}
        className={`level-card${solved ? ' solved' : ''}`}
        onClick={() => setActive(lv)}
      >
        <div className="level-card-meta">
          <span className="level-number">{String(levels.indexOf(lv) + 1).padStart(2, '0')}</span>
          <span className="level-kind">{kindLabel(lv.kind)}</span>
          {solved && (
            <span className="level-done" title="Completed">
              ✓<span className="sr-only"> Completed</span>
            </span>
          )}
        </div>
        <h3>{lv.title}</h3>
        {lv.topic && <p>{lv.topic}</p>}
      </button>
    );
  };
  return (
    <div className="page">
      <div className="challenge-list">
        <h2>Challenges</h2>
        <p className="lede">
          {solvedCount(levels)} of {levels.length} completed
        </p>
        {groupLevels(levels).map(({ section, levels: members }) => {
          const solved = solvedCount(members);
          const done = solved === members.length;
          return (
            // Unsectioned levels (course or custom) are listed last, under a generic heading.
            <section
              className={`level-section${done ? ' done' : ''}`}
              key={section}
              aria-label={section || UNSECTIONED}
            >
              <div className="level-section-head">
                <h3>{section || UNSECTIONED}</h3>
                <span className="section-bar" aria-hidden="true">
                  <span style={{ width: `${(100 * solved) / members.length}%` }} />
                </span>
                <span className="section-count">
                  {solved} of {members.length}
                  <span className="sr-only"> completed</span>
                </span>
              </div>
              <div className="level-grid">{members.map(card)}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The heading of a Check result. `failure` says why an answer was not accepted:
 * 'mismatch' (wrong or invalid memory), 'crash' (the student's code did not run), or
 * 'level' (the level's own target could not be graded; not the student's fault).
 */
function verdictHeading(verdict, isC2D) {
  if (verdict.pass) return 'Challenge complete!';
  if (verdict.failure === 'crash') return 'Your code doesn’t run';
  if (verdict.failure === 'level') return 'This level can’t be checked';
  return isC2D ? 'Incorrect diagram' : 'Incorrect code';
}

function ChallengeRunner({ level, onExit, onNext }) {
  // Course and custom levels can outlive grammar changes; a broken one must not crash the page.
  const target = useMemo(() => {
    try {
      return { state: interpret(level.code).state, error: null };
    } catch (e) {
      return { state: null, error: describeError(e) };
    }
  }, [level]);
  // The student's diagram knows the level's struct types, so struct objects can be drawn.
  const [studentState, setStudentState] = useState(() =>
    makeState(target.state?.structTypes ?? {}),
  );
  // A code→diagram answer must be drawable; say so instead of letting a student fail forever.
  const undrawable = useMemo(
    () => (level.kind === 'code-to-diagram' && target.state ? drawingIssues(target.state) : []),
    [level, target],
  );
  const [studentCode, setStudentCode] = useState('int main() {\n    \n}');
  const [verdict, setVerdict] = useState(null);
  const [badIds, setBadIds] = useState(() => new Set());
  const [attempts, setAttempts] = useState(0);
  // How many hints have been revealed, in order.
  const [hintsShown, setHintsShown] = useState(0);
  const isC2D = level.kind === 'code-to-diagram';
  const hints = level.hints ?? [];
  // Feedback from a Check describes the answer as it was then: drop the red markers, which
  // could point at things already fixed, and flag the verdict as out of date.
  const answerChanged = () => {
    setBadIds(prev => (prev.size ? new Set() : prev));
    setVerdict(v => (v && !v.stale ? { ...v, stale: true } : v));
  };
  const editDiagram = next => {
    setStudentState(next);
    answerChanged();
  };
  const editCode = next => {
    setStudentCode(next);
    answerChanged();
  };

  const backButton = (
    <button className="back-btn" onClick={onExit}>
      ← Challenges
    </button>
  );

  if (undrawable.length) {
    return (
      <div className="page">
        {backButton}
        <h2>{level.title}</h2>
        <p className="msgbar-inline err">
          This level&apos;s answer can&apos;t be drawn in the diagram editor: it needs{' '}
          {undrawable.join('; ')}.{' '}
          {brokenLevelAdvice('Make it a diagram → code level in the Level editor.')}
        </p>
      </div>
    );
  }

  if (target.error) {
    return (
      <div className="page">
        {backButton}
        <h2>{level.title}</h2>
        <p className="msgbar-inline err">
          This level&apos;s reference code no longer runs: {target.error}.{' '}
          {brokenLevelAdvice('Edit or delete it in the Level editor.')}
        </p>
      </div>
    );
  }

  const check = () => {
    const attempt = attempts + 1;
    setAttempts(attempt);
    let student;
    try {
      student = isC2D ? studentState : interpret(studentCode).state;
    } catch (e) {
      setBadIds(new Set());
      setVerdict({ pass: false, failure: 'crash', diffs: [describeError(e)], attempt });
      return;
    }
    // equivalent() throws only when the level's own target is invalid, not the answer.
    let result;
    try {
      result = equivalent(target.state, student, level.grading ?? {});
    } catch (e) {
      setVerdict({ pass: false, failure: 'level', diffs: [e.message], attempt });
      return;
    }
    setBadIds(result.badIds ?? new Set());
    if (result.equal) markSolved(level.id);
    setVerdict({ pass: result.equal, failure: 'mismatch', diffs: result.diffs, attempt });
  };

  const hintsLeft = hints.length - hintsShown;
  return (
    <>
      <div className="challenge-head">
        {backButton}
        <div className="challenge-title">
          <strong>{level.title}</strong>
          <div className="prompt">{level.prompt}</div>
        </div>
        {hintsLeft > 0 && (
          <button className="hint-btn" onClick={() => setHintsShown(hintsShown + 1)}>
            Show hint ({hintsLeft} left)
          </button>
        )}
        <button className="check-btn" onClick={check}>
          Check answer
        </button>
      </div>

      <Workbench
        left={
          <section className="panel">
            <div className="panel-head">
              {isC2D ? 'Given code' : 'Your code'}
              {isC2D && <span className="panel-context">Read-only</span>}
            </div>
            <CodePanel
              code={isC2D ? level.code : studentCode}
              onCode={isC2D ? undefined : editCode}
              readOnly={isC2D}
            />
          </section>
        }
        right={
          <section className="panel">
            <div className="panel-head">
              {isC2D ? 'Your memory diagram' : 'Target memory'}
              {!isC2D && <span className="panel-context">Read-only</span>}
            </div>
            <MemoryCanvas
              state={isC2D ? studentState : target.state}
              onChange={isC2D ? editDiagram : undefined}
              editable={isC2D}
              // Marked IDs belong to the student's memory, so they can only be shown on the
              // student's own diagram, never on a diagram → code level's target.
              badIds={isC2D ? badIds : undefined}
            />
          </section>
        }
      />

      {hintsShown > 0 && (
        <ol className="hint-list" aria-label="Hints">
          {hints.slice(0, hintsShown).map((hint, i) => (
            <li key={i}>
              <span className="hint-label">
                Hint {i + 1} of {hints.length}
              </span>
              {hint}
            </li>
          ))}
        </ol>
      )}
      {verdict && (
        <div className={`verdict ${verdict.pass ? 'pass' : 'fail'}`} role="status">
          <div className="verdict-head">
            <strong>
              {verdict.pass ? '✓' : '✕'} {verdictHeading(verdict, isC2D)}
            </strong>
            {verdict.stale && <span className="verdict-tag">Changed since this check</span>}
            {!verdict.pass && <span className="verdict-meta">Attempt {verdict.attempt}</span>}
            {verdict.pass && (
              <button className="plain-btn verdict-action" onClick={onNext ?? onExit}>
                {onNext ? 'Next challenge →' : 'Back to challenges'}
              </button>
            )}
          </div>
          {!verdict.pass && (
            <ul>
              {verdict.diffs.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
