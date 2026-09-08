/** Bidirectional code/memory sandbox. */
import React, { useState } from 'react';
import MemoryCanvas from './MemoryCanvas.jsx';
import { interpret } from '../pipeline/interpreter.js';
import { generate, ValidationError, validate } from '../pipeline/codegen.js';
import { makeState } from '../pipeline/ir.js';

const STARTER = `struct Node {
    int value;
    struct Node *next;
};

void set_value(struct Node *node, int value) {
    node->value = value;
}

int main(void) {
    struct Node a = {10, NULL};
    set_value(&a, 20);
    return 0;
}
`;

/** Reusable textarea. Tab inserts four spaces instead of moving browser focus. */
export function CodePanel({ code, onCode, readOnly }) {
  const lines = code.split('\n').length;
  const onKeyDown = e => {
    if (readOnly || e.key !== 'Tab' || !onCode) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart, end = el.selectionEnd;
    if (e.shiftKey) {
      const lineStart = code.lastIndexOf('\n', start - 1) + 1;
      const remove = code.slice(lineStart, lineStart + 4).match(/^ {1,4}/)?.[0].length ?? 0;
      if (!remove) return;
      onCode(code.slice(0, lineStart) + code.slice(lineStart + remove));
      requestAnimationFrame(() => { el.selectionStart = Math.max(lineStart, start - remove); el.selectionEnd = Math.max(lineStart, end - remove); });
      return;
    }
    const indent = '    ';
    onCode(code.slice(0, start) + indent + code.slice(end));
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + indent.length; });
  };
  return <div className="code-wrap">
    <div className="gutter">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
    <textarea className="code-input" spellCheck={false} value={code} readOnly={readOnly}
      placeholder="int main(void) { ... }" onChange={e => onCode?.(e.target.value)} onKeyDown={onKeyDown} />
  </div>;
}

export default function Sandbox() {
  const [code, setCode] = useState(STARTER);
  const [state, setState] = useState(makeState());
  const [snapshots, setSnapshots] = useState(null);
  const [step, setStep] = useState(0);
  const [messages, setMessages] = useState([]);
  const say = m => setMessages(prev => [...prev.slice(-4), m]);

  const codeToDiagram = () => {
    try {
      const result = interpret(code);
      setState(result.state); setSnapshots(result.snapshots); setStep(result.snapshots.length);
      say({ kind: 'ok', text: `Run complete: ${result.snapshots.length} execution step${result.snapshots.length === 1 ? '' : 's'}.` });
    } catch (e) { say({ kind: 'err', text: e.message }); }
  };
  const diagramToCode = () => {
    try { setCode(generate(state)); say({ kind: 'ok', text: 'Generated C from the current memory state.' }); }
    catch (e) { if (e instanceof ValidationError) e.errors.forEach(text => say({ kind: 'err', text })); else say({ kind: 'err', text: e.message }); }
  };
  const onDiagramEdit = next => {
    setState(next); setSnapshots(null);
    try { validate(next); } catch (e) { if (e instanceof ValidationError) say({ kind: 'err', text: e.errors[0] }); }
  };
  const shownState = snapshots && step > 0 && step <= snapshots.length ? snapshots[step - 1].state : snapshots && step === 0 ? makeState(state.structTypes) : state;
  const shownSnapshot = snapshots && step > 0 ? snapshots[step - 1] : null;

  return <>
    <div className="workbench">
      <section className="panel" aria-label="C code"><div className="panel-head">C code</div><CodePanel code={code} onCode={setCode} /></section>
      <div className="spine" role="group" aria-label="convert">
        <button className="convert-btn" title="Run C and show memory" onClick={codeToDiagram}>Run →</button>
        <button className="convert-btn" title="Generate C from memory" onClick={diagramToCode}>← Generate</button>
      </div>
      <section className="panel" aria-label="memory diagram">
        <div className="panel-head">Memory{shownSnapshot && <span className="panel-context">{shownSnapshot.function}(), line {shownSnapshot.line}</span>}</div>
        <MemoryCanvas state={shownState} onChange={onDiagramEdit} editable={!snapshots || step === snapshots.length} onMessage={say} />
        {snapshots?.length > 0 && <div className="stepper">
          <button className="step-btn" disabled={step <= 0} onClick={() => setStep(s => s - 1)}>Previous</button>
          <input type="range" min={0} max={snapshots.length} value={step} onChange={e => setStep(Number(e.target.value))} aria-label="execution step" />
          <span>{step}/{snapshots.length}</span>
          <button className="step-btn" disabled={step >= snapshots.length} onClick={() => setStep(s => s + 1)}>Next</button>
        </div>}
      </section>
    </div>
    {messages.length > 0 && <div className="msgbar" role="log">{messages.map((m, i) => <div key={i} className={m.kind}>{m.text}</div>)}</div>}
  </>;
}
