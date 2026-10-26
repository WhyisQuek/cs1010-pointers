/**
 * Start here: a short tour for students. Each section is a heading, a sentence or two and
 * something to click; detail stays in collapsed sections. The C lists come from
 * data/tutorialExamples.js, which the tests run, so they always match the interpreter.
 */
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

const STEPS = [
  {
    title: 'Write',
    text: 'Type C in the code pane, or start from an example below.',
    shot: {
      name: 'write',
      alt: 'The code pane with a short C program and the Run button',
      width: 446,
      height: 174,
    },
  },
  {
    title: 'Run',
    text: 'Press Run to execute your C code.',
    shot: {
      name: 'controls',
      alt: 'The step controls: Step back, Step into, Step over, Step out, Continue and a slider',
      width: 728,
      height: 91,
    },
  },
  {
    title: 'Step',
    text: 'Step through the run line by line and watch memory change.',
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
  return (
    <div className="page tutorial">
      <div className="tutorial-inner">
        <header className="tutorial-hero">
          <h2>See what your C code does to memory</h2>
          <p>Write a program, run it, and watch memory change one line at a time.</p>
          <button className="primary-btn" onClick={() => onOpen('sandbox')}>
            Open the Sandbox
          </button>
        </header>

        <section className="tutorial-section" aria-labelledby="t-how">
          <h3 id="t-how">How it works</h3>
          <ol className="tutorial-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <div>
                  <span className="tutorial-step-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <strong>{s.title}</strong>
                  <p>{s.text}</p>
                </div>
                <Shot {...s.shot} />
              </li>
            ))}
          </ol>
          <p className="tutorial-note">
            Shortcuts: <kbd>F11</kbd> step into, <kbd>F10</kbd> step over, <kbd>Shift+F10</kbd> back
            one line. Click a line number to set a breakpoint.
          </p>
        </section>

        <section className="tutorial-section" aria-labelledby="t-try">
          <h3 id="t-try">Try it</h3>
          <p>Each one opens in the Sandbox, ready to step through.</p>
          <div className="tutorial-examples">
            {EXAMPLES.map(ex => (
              <button
                key={ex.id}
                className={`tutorial-example${ex.fails ? ' fails' : ''}`}
                onClick={() => onTry(ex)}
              >
                <strong>{ex.title}</strong>
                <span>{ex.blurb}</span>
                <span className="tutorial-example-go" aria-hidden="true">
                  Try it →
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="tutorial-section" aria-labelledby="t-c">
          <h3 id="t-c">What C works here</h3>
          <p>
            PointerViz runs a teaching subset of C. Start from <code>int main(void)</code>, and
            define each function above the code that calls it. <code>#include</code> lines are
            optional.
          </p>
          <div className="tutorial-columns">
            <div className="tutorial-column works" aria-labelledby="t-works">
              <h4 id="t-works">
                <span aria-hidden="true">✓</span> Works
              </h4>
              <ul>
                {SUPPORTED.map(f => (
                  <li key={f.label}>
                    {f.label}
                    <code>{f.sample}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div className="tutorial-column missing" aria-labelledby="t-missing">
              <h4 id="t-missing">
                <span aria-hidden="true">✕</span> Currently unsupported
              </h4>
              <ul>
                {UNSUPPORTED.map(f => (
                  <li key={f.label}>{f.label}</li>
                ))}
              </ul>
              <p className="tutorial-note">
                Also not supported: {ALSO_UNSUPPORTED.map(f => f.label).join(', ')}.
              </p>
            </div>
          </div>
          <details className="tutorial-more">
            <summary>Limits</summary>
            <ul>
              <li>Arrays and heap blocks: up to {MAX_ARRAY_LENGTH} elements</li>
              <li>Loops: up to {MAX_LOOP_ITERATIONS} iterations each</li>
              <li>Programs: up to {MAX_TRACE_STEPS} steps</li>
              <li>Function calls: up to {MAX_CALL_DEPTH} deep</li>
            </ul>
          </details>
          <details className="tutorial-more">
            <summary>What the error messages mean</summary>
            <dl>
              {ERROR_LABELS.map(([kind, meaning]) => (
                <div key={kind}>
                  <dt>{DIAGNOSTIC_LABELS[kind]}</dt>
                  <dd>{meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>

        <section className="tutorial-section" aria-labelledby="t-read">
          <h3 id="t-read">Reading the diagram</h3>
          <div className="tutorial-split">
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
                Press <strong>Generate C</strong> to get code that builds this memory.
              </li>
            </ol>
          </div>
        </section>

        <section className="tutorial-section" aria-labelledby="t-challenges">
          <h3 id="t-challenges">Test yourself</h3>
          <div className="tutorial-columns">
            <div className="tutorial-challenge">
              <strong>Code → diagram</strong>
              <p>Read the code, then draw the memory it makes.</p>
            </div>
            <div className="tutorial-challenge">
              <strong>Diagram → code</strong>
              <p>Look at the memory, then write code that makes it.</p>
            </div>
          </div>
          <button className="primary-btn" onClick={() => onOpen('challenges')}>
            Go to Challenges
          </button>
        </section>
      </div>
    </div>
  );
}
