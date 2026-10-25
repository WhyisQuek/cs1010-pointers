/**
 * Says what usage data is collected and lets the student turn it off (data/telemetry.js).
 * Shown until a choice is made; afterwards a topbar button changes it. Renders nothing when
 * the build has no collector.
 */
import { useState } from 'react';
import { telemetry } from '../data/telemetry.js';

export default function TelemetryNotice() {
  const [choice, setChoice] = useState(telemetry.getChoice);
  if (!telemetry.enabled) return null;
  const choose = value => {
    telemetry.setChoice(value);
    setChoice(value);
  };
  if (choice === null)
    return (
      <div className="telemetry-notice" role="region" aria-label="Usage data">
        <p>
          To improve PointerViz, the code you run, the diagrams you turn into C and your challenge
          answers are recorded with a random ID, not your name.
        </p>
        <button className="plain-btn" onClick={() => choose('on')}>
          OK
        </button>
        <button className="plain-btn" onClick={() => choose('off')}>
          Don’t share
        </button>
      </div>
    );
  const on = choice === 'on';
  return (
    <button
      className="telemetry-toggle"
      aria-pressed={on}
      onClick={() => choose(on ? 'off' : 'on')}
      title={on ? 'Stop sharing usage data' : 'Share usage data to help improve PointerViz'}
    >
      Usage data: {on ? 'shared' : 'off'}
    </button>
  );
}
