/**
 * Student challenge browser and runner.
 * Reference C and student answers are both converted to MemoryState, then graded
 * with semantic graph equivalence rather than source-text comparison.
 */
import React, { useMemo, useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { CodePanel } from './Sandbox.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { equivalent } from '../pipeline/equivalence.js';
import { makeState } from '../pipeline/ir.js';
import { seedLevels, loadCustomLevels, loadProgress, recordResult } from '../data/levels.js';

export default function Challenges() {
  const [active, setActive] = useState(null);
  const [, bump] = useState(0);
  const levels = useMemo(() => [...seedLevels, ...loadCustomLevels()], [active]);
  const progress = loadProgress();

  if (active) {
    return <ChallengeRunner level={active} onExit={() => { setActive(null); bump((n) => n + 1); }} />;
  }
  return (
    <div className="page">
      <h2>Challenges</h2>
      <p className="lede">Select a challenge.</p>
      <div className="level-grid">
        {levels.map((lv) => {
          const stars = progress[lv.id]?.stars ?? 0;
          return (
            <button key={lv.id} className="level-card" onClick={() => setActive(lv)}>
              <span className={`kind ${lv.kind === 'code-to-diagram' ? 'c2d' : 'd2c'}`}>
                {lv.kind === 'code-to-diagram' ? 'code → diagram' : 'diagram → code'}
              </span>
              <h3>{lv.title}</h3>
              <p>{lv.prompt}</p>
              <div className="stars" aria-label={`${stars} of 3 stars`}>
                {'★'.repeat(stars)}<span className="empty">{'★'.repeat(3 - stars)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChallengeRunner({ level, onExit }) {
  const target = useMemo(() => interpret(level.code).state, [level]);
  const [studentState, setStudentState] = useState(makeState());
  const [studentCode, setStudentCode] = useState('int main() {\n    \n}');
  const [verdict, setVerdict] = useState(null);
  const [badIds, setBadIds] = useState(new Set());
  const [attempts, setAttempts] = useState(0);
  const [hintIdx, setHintIdx] = useState(0);
  const [messages, setMessages] = useState([]);
  const isC2D = level.kind === 'code-to-diagram';

  const check = () => {
    const n = attempts + 1;
    setAttempts(n);
    let result;
    try {
      const student = isC2D ? studentState : interpret(studentCode).state;
      result = equivalent(target, student, level.grading ?? {});
    } catch (e) {
      setVerdict({ pass: false, diffs: [e.message] });
      return;
    }
    setBadIds(result.badIds ?? new Set());
    setVerdict({ pass: result.equal, diffs: result.diffs });
    const rec = recordResult(level.id, { solved: result.equal, attempts: n, usedHints: hintIdx > 0 });
    if (result.equal) setVerdict({ pass: true, diffs: [], stars: rec.stars });
  };

  const showHint = () => {
    if (hintIdx < (level.hints?.length ?? 0)) {
      setMessages((m) => [...m, { kind: 'hint', text: `hint: ${level.hints[hintIdx]}` }]);
      setHintIdx(hintIdx + 1);
    }
  };

  return (
    <>
      <div className="challenge-head">
        <button className="back-btn" onClick={onExit}>← levels</button>
        <div>
          <strong>{level.title}</strong>
          <div className="prompt">{level.prompt}</div>
        </div>
        {level.hints?.length > 0 && hintIdx < level.hints.length && (
          <button className="hint-btn" onClick={showHint}>hint ({level.hints.length - hintIdx})</button>
        )}
        <button className="check-btn" onClick={check}>Check answer</button>
      </div>

      <div className="workbench">
        <section className="panel">
          <div className="panel-head">{isC2D ? 'given code (read-only)' : 'your code'}</div>
          <CodePanel
            code={isC2D ? level.code : studentCode}
            onCode={isC2D ? undefined : setStudentCode}
            readOnly={isC2D}
          />
        </section>
        <div className="spine" />
        <section className="panel">
          <div className="panel-head">{isC2D ? 'your memory diagram' : 'target memory (read-only)'}</div>
          <MemoryCanvas
            state={isC2D ? studentState : target}
            onChange={isC2D ? setStudentState : undefined}
            editable={isC2D}
            badIds={badIds}
            onMessage={(m) => setMessages((prev) => [...prev.slice(-4), m])}
          />
        </section>
      </div>

      {messages.length > 0 && (
        <div className="msgbar">{messages.map((m, i) => <div key={i} className={m.kind}>{m.text}</div>)}</div>
      )}
      {verdict && (
        <div className={`verdict ${verdict.pass ? 'pass' : 'fail'}`} role="status">
          {verdict.pass ? (
            <>Correct — memory states match. {'★'.repeat(verdict.stars ?? 1)} earned ({attempts} attempt{attempts > 1 ? 's' : ''})</>
          ) : (
            <>Not yet — {attempts} attempt{attempts > 1 ? 's' : ''} so far:
              <ul>{verdict.diffs.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
