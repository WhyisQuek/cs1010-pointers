/**
 * Tells students that their code is recorded for research (data/telemetry.js). Shown once per
 * browser, until dismissed. Renders nothing when the build has no collector.
 */
import { useState } from 'react';
import { telemetry } from '../data/telemetry.js';

export default function TelemetryNotice() {
  const [shown, setShown] = useState(telemetry.noticeDue);
  if (!shown) return null;
  const dismiss = () => {
    telemetry.dismissNotice();
    setShown(false);
  };
  return (
    <div className="telemetry-notice" role="region" aria-label="Research notice">
      <p>
        <strong>For research:</strong> PointerViz records the code you run, the C you generate and
        your challenge answers. No personal information, such as your name or student ID, is
        collected, so please keep it out of your code.
      </p>
      <button className="plain-btn" onClick={dismiss}>
        OK
      </button>
    </div>
  );
}
