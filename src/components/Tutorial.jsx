/**
 * Start here: a short tour for students. What the app does and something to click come
 * first; the reference on the supported C sits last, under a rule. The C lists come from
 * data/tutorialExamples.js, which the tests run, so they always match the interpreter.
 */
import { useRef } from 'react';
import { ALSO_UNSUPPORTED, EXAMPLES, SUPPORTED, UNSUPPORTED } from '../data/tutorialExamples.js';
import {
  MAX_ARRAY_LENGTH,
  MAX_CALL_DEPTH,
  MAX_LOOP_ITERATIONS,
  MAX_TRACE_STEPS,
} from '../language/limits.js';
import {
  DIAGNOSTIC_LABELS,
  INVALID,
  LIMIT,
  UNDEFINED,
  UNSUPPORTED as NOT_SUPPORTED,
} from '../language/diagnostics.js';

const shot = name => `${import.meta.env.BASE_URL}tutorial/${name}.png`;

/** A screenshot of the real app; width and height reserve its space before it loads. */
function Shot({ name, alt, width, height }) {
  return (
    <img
      className="tutorial-shot"
      src={shot(name)}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
    />
  );
}

// Laid out as one picture: the first two stack on the left, the third stands on the right.
const STEPS = [
  {
    title: 'Write',
    text: 'C in the code pane, then press Run.',
    shot: {
      name: 'write',
      alt: 'The code pane with a short C program and the Run button',
      width: 446,
      height: 174,
    },
  },
  {
    title: 'Step',
    text: 'forward or back, one line at a time.',
    shot: {
      name: 'controls',
      alt: 'The step controls: Step back, Step into, Step over, Step out, Continue and a slider',
      width: 728,
      height: 91,
    },
  },
  {
    title: 'Watch',
    text: 'memory change after every line.',
    shot: {
      name: 'memory',
      alt: 'Memory partway through a run: main’s frame, with p pointing at x',
      width: 288,
      height: 328,
    },
  },
];

const LEGEND = [
  ['stack', 'Stack frame', 'one per function call'],
  ['heap', 'Heap block', 'made by malloc or calloc'],
  ['ptr', 'Pointer', 'the arrow goes to what it points at'],
  ['changed', 'Just changed', 'by the step you are on'],
  ['err', 'Dangling', 'points at freed or out-of-scope memory'],
];

const ERROR_LABELS = [
  [INVALID, 'A real compiler would reject it too. Fix the code.'],
  [UNDEFINED, 'Valid C that breaks a rule while running, like using freed memory.'],
  [NOT_SUPPORTED, 'Fine C, but PointerViz can’t run it yet. See the list above.'],
  [LIMIT, 'Too big to visualize. See the limits above.'],
];

export default function Tutorial({ onOpen, onTry }) {
  const reference = useRef(null);
  return (
    <div className="page tutorial">
      <div className="tutorial-inner">
        <header className="tutorial-hero">
          <h2>See what your C code does to memory</h2>
          <p>Write a program, run it, and watch memory change one line at a time.</p>
          <div className="tutorial-actions">
            <button className="primary-btn" onClick={() => onOpen('sandbox')}>
              Open the Sandbox
            </button>
            <button
              className="tutorial-link"
              onClick={() => reference.current.scrollIntoView({ behavior: 'smooth' })}
            >
              What C works here?
            </button>
          </div>
        </header>

        <ol className="tutorial-tour" aria-label="How it works">
          {STEPS.map(s => (
            <li key={s.title}>
              <p>
                <strong>{s.title}</strong> {s.text}
              </p>
              <Shot {...s.shot} />
            </li>
          ))}
        </ol>
        <p className="tutorial-note">
          <kbd>F11</kbd> steps into a call, <kbd>F10</kbd> steps over it, <kbd>Shift+F10</kbd> goes
          back a line. Click a line number to set a breakpoint.
        </p>

        <section className="tutorial-section" aria-labelledby="t-try">
          <h3 id="t-try">Start with an example</h3>
          <p>Each one opens in the Sandbox, ready to step through.</p>
          <div className="tutorial-examples">
            {EXAMPLES.map(ex => (
              <button key={ex.id} className="tutorial-example" onClick={() => onTry(ex)}>
                <strong>{ex.title}</strong>
                <span>{ex.blurb}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="tutorial-section" aria-labelledby="t-read">
          <h3 id="t-read">Reading the diagram</h3>
          <div className="tutorial-split natural">
            <Shot
              name="diagram"
              alt="A linked list: head in main’s frame points to three heap blocks linked by next"
              width={420}
              height={378}
            />
            <div>
              <ul className="tutorial-legend">
                {LEGEND.map(([kind, name, meaning]) => (
                  <li key={kind}>
                    <span className={`tutorial-swatch ${kind}`} aria-hidden="true" />
                    <strong>{name}</strong> {meaning}
                  </li>
                ))}
              </ul>
              <p className="tutorial-note">
                Click a name to inspect it. <strong>View</strong> switches between arrows,
                addresses, or <strong>Structure</strong>, which draws linked lists and trees in
                their own shape.
              </p>
            </div>
          </div>
        </section>

        <section className="tutorial-section" aria-labelledby="t-draw">
          <h3 id="t-draw">Draw memory yourself</h3>
          <p>Work the other way round: build the diagram, and get the C that makes it.</p>
          <div className="tutorial-split">
            <Shot
              name="draw"
              alt="Editing a diagram: + Variable, + Heap block, and the inspector for pointer p"
              width={927}
              height={560}
            />
            <ol className="tutorial-flow">
              <li>
                Press <strong>Edit</strong> on any step, or start on an empty canvas.
              </li>
              <li>
                Add boxes with <strong>+ Variable</strong> and <strong>+ Heap block</strong>.
              </li>
              <li>Click a pointer and pick its target.</li>
              <li>
                Press <strong>Generate C</strong>.
              </li>
            </ol>
          </div>
        </section>

        <section className="tutorial-section" aria-labelledby="t-challenges">
          <h3 id="t-challenges">Test yourself</h3>
          <p>
            Challenges come in two kinds: read some code and draw the memory it makes, or look at
            some memory and write the code that makes it.
          </p>
          <button className="ghost-btn" onClick={() => onOpen('challenges')}>
            Go to Challenges
          </button>
        </section>

        <section
          className="tutorial-section tutorial-reference"
          aria-labelledby="t-c"
          ref={reference}
        >
          <h3 id="t-c">What C works here</h3>
          <p>
            PointerViz runs a teaching subset of C. Start from <code>int main(void)</code>, and
            define each function above the code that calls it. <code>#include</code> lines are
            optional.
          </p>
          <div className="tutorial-columns">
            <div>
              <h4>Works</h4>
              <ul>
                {SUPPORTED.map(f => (
                  <li key={f.label}>
                    {f.label}
                    <code>{f.sample}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Not yet</h4>
              <ul>
                {UNSUPPORTED.map(f => (
                  <li key={f.label}>{f.label}</li>
                ))}
              </ul>
              <p className="tutorial-note">Nor {ALSO_UNSUPPORTED.map(f => f.label).join(', ')}.</p>
            </div>
          </div>
          <p className="tutorial-note">
            Limits: arrays and heap blocks up to {MAX_ARRAY_LENGTH} elements, loops up to{' '}
            {MAX_LOOP_ITERATIONS} iterations, calls up to {MAX_CALL_DEPTH} deep, and{' '}
            {MAX_TRACE_STEPS} steps per program.
          </p>
          <h4>When a run stops</h4>
          <dl>
            {ERROR_LABELS.map(([kind, meaning]) => (
              <div key={kind}>
                <dt>{DIAGNOSTIC_LABELS[kind]}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
