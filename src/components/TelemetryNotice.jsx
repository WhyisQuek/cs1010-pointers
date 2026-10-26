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
        For research purposes, the code you run and the C you generate is recorded to better understand how users use PointerViz. 
        No personal information is recorded, but do avoid adding any into your code.
      </p>
      <button className="plain-btn" onClick={dismiss}>
        OK
      </button>
    </div>
  );
}
