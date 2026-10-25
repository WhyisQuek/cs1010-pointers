/**
 * Checks the usage events the app sends (src/data/telemetry.js). Kept apart from worker.js,
 * whose module may export only its handler: the Workers runtime treats every export of the
 * main module as an entry point.
 */
export const MAX_BODY_BYTES = 64 * 1024;
const TYPES = new Set(['run', 'generate', 'check']);
const ID = /^[0-9a-f]{32}$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = v => (typeof v === 'string' && v.length <= 32 ? v : null);

/** The row to store for one event body, or null if it is not a PointerViz event. */
export function parseEvent(text) {
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(event) || event.v !== 1 || !TYPES.has(event.type)) return null;
  if (!ID.test(event.client) || !ID.test(event.session) || !isObject(event.data)) return null;
  return {
    type: event.type,
    client: event.client,
    session: event.session,
    edition: label(event.edition),
    version: label(event.version),
    // The browser's clock, kept for ordering events within a session; received_at is the server's.
    clientAt: typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)) ? event.at : null,
    data: JSON.stringify(event.data),
  };
}

/** ALLOWED_ORIGINS is a comma-separated list such as "https://whyisquek.github.io". */
export function allowedOrigin(origin, allowed = '') {
  return Boolean(origin) && allowed.split(',').some(o => o.trim() === origin);
}
