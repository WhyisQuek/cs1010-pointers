/**
 * Student challenge browser and runner.
 * Reference C and student answers are both converted to MemoryState, then graded
 * with semantic graph equivalence rather than source-text comparison.
 */
import { useMemo, useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './CodePanel.jsx';
import Workbench from './Workbench.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { equivalent } from '../pipeline/equivalence.js';
import { makeState } from '../machine/memory.js';
import { seedLevels, loadCustomLevels, loadProgress, recordResult } from '../data/levels.js';

const kindLabel = kind => (kind === 'code-to-diagram' ? 'code → diagram' : 'diagram → code');

export default function Challenges() {
  const [active, setActive] = useState(null);
  const [levels, setLevels] = useState(() => [...seedLevels, ...loadCustomLevels()]);
  const [progress, setProgress] = useState(loadProgress);

  const exit = () => {
    setActive(null);
    setLevels([...seedLevels, ...loadCustomLevels()]);
    setProgress(loadProgress());
  };

  if (active) return <ChallengeRunner level={active} onExit={exit} />;
  return (
    <div className="page">
      <h2>Challenges</h2>
      <p className="lede">Select a challenge.</p>
      <div className="level-grid">
        {levels.map(lv => {
          const stars = progress[lv.id]?.stars ?? 0;
          return (
            <button key={lv.id} className="level-card" onClick={() => setActive(lv)}>
              <span className="kind">{kindLabel(lv.kind)}</span>
              <h3>{lv.title}</h3>
              <p>{lv.prompt}</p>
              <div className="stars" aria-label={`${stars} of 3 stars`}>
                {'★'.repeat(stars)}
                <span className="empty">{'★'.repeat(3 - stars)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChallengeRunner({ level, onExit }) {
  // Custom levels can outlive grammar changes; a broken one must not crash the page.
  const target = useMemo(() => {
    try {
      return { state: interpret(level.code).state, error: null };
    } catch (e) {
      return { state: null, error: e.message };
    }
  }, [level]);
  const [studentState, setStudentState] = useState(makeState);
  const [studentCode, setStudentCode] = useState('int main() {\n    \n}');
  const [verdict, setVerdict] = useState(null);
  const [badIds, setBadIds] = useState(() => new Set());
  const [attempts, setAttempts] = useState(0);
  const [hintIdx, setHintIdx] = useState(0);
  const [messages, setMessages] = useState([]);
  const isC2D = level.kind === 'code-to-diagram';
  const say = m => setMessages(prev => [...prev.slice(-4), m]);

  if (target.error) {
    return (
      <div className="page">
        <button className="back-btn" onClick={onExit}>
          ← levels
        </button>
        <h2>{level.title}</h2>
        <p className="msgbar-inline err">
          This level&apos;s reference code no longer runs: {target.error}. Edit or delete it in the
          Level editor.
        </p>
      </div>
    );
  }

  const check = () => {
    const n = attempts + 1;
    setAttempts(n);
    let result;
    try {
      const student = isC2D ? studentState : interpret(studentCode).state;
      result = equivalent(target.state, student, level.grading ?? {});
    } catch (e) {
      setVerdict({ pass: false, diffs: [e.message] });
      return;
    }
    setBadIds(result.badIds ?? new Set());
    const rec = recordResult(level.id, {
      solved: result.equal,
      attempts: n,
      usedHints: hintIdx > 0,
    });
    setVerdict({ pass: result.equal, diffs: result.diffs, stars: rec.stars });
  };

  const showHint = () => {
    if (hintIdx >= (level.hints?.length ?? 0)) return;
    say({ kind: 'hint', text: `hint: ${level.hints[hintIdx]}` });
    setHintIdx(hintIdx + 1);
  };

  const attemptText = `${attempts} attempt${attempts > 1 ? 's' : ''}`;
  return (
    <>
      <div className="challenge-head">
        <button className="back-btn" onClick={onExit}>
          ← levels
        </button>
        <div>
          <strong>{level.title}</strong>
          <div className="prompt">{level.prompt}</div>
        </div>
        {level.hints?.length > 0 && hintIdx < level.hints.length && (
          <button className="hint-btn" onClick={showHint}>
            hint ({level.hints.length - hintIdx})
          </button>
        )}
        <button className="check-btn" onClick={check}>
          Check answer
        </button>
      </div>

      <Workbench
        left={
          <section className="panel">
            <div className="panel-head">{isC2D ? 'given code (read-only)' : 'your code'}</div>
            <CodePanel
              code={isC2D ? level.code : studentCode}
              onCode={isC2D ? undefined : setStudentCode}
              readOnly={isC2D}
            />
          </section>
        }
        right={
          <section className="panel">
            <div className="panel-head">
              {isC2D ? 'your memory diagram' : 'target memory (read-only)'}
            </div>
            <MemoryCanvas
              state={isC2D ? studentState : target.state}
              onChange={isC2D ? setStudentState : undefined}
              editable={isC2D}
              badIds={badIds}
            />
          </section>
        }
      />

      {messages.length > 0 && (
        <div className="msgbar">
          {messages.map((m, i) => (
            <div key={i} className={m.kind}>
              {m.text}
            </div>
          ))}
        </div>
      )}
      {verdict && (
        <div className={`verdict ${verdict.pass ? 'pass' : 'fail'}`} role="status">
          {verdict.pass ? (
            <>
              Correct — memory states match. {'★'.repeat(verdict.stars ?? 1)} earned ({attemptText})
            </>
          ) : (
            <>
              Not yet — {attemptText} so far:
              <ul>
                {verdict.diffs.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
