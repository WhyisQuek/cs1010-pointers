/**
 * Anonymous usage events, sent to the collector in telemetry/ (a Cloudflare Worker that writes
 * to D1). Off unless the build sets VITE_TELEMETRY_URL; then on until the student turns it off
 * (TelemetryNotice.jsx). Events carry a random per-browser ID, never a name or login.
 *
 * Bulky inputs go in `code` and `state`. The interpreter is deterministic, so a run's code is
 * enough to replay its whole trace; its snapshots are not sent.
 */
import { toJSON } from './json.js';

const CHOICE_KEY = 'pointerviz.telemetry.v1';
const CLIENT_KEY = 'pointerviz.client.v1';
export const EVENT_TYPES = Object.freeze(['run', 'generate', 'check']);
/** Below the 64 KiB a page may have in flight through sendBeacon/keepalive. */
export const MAX_EVENT_BYTES = 60000;

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(
    '',
  );

const browserStorage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the value lasts for this page load only */
    }
  },
};

// text/plain keeps it a CORS "simple" request: no preflight, and the page never reads a reply.
function beacon(url, body) {
  if (navigator.sendBeacon?.(url, body)) return;
  fetch(url, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => {});
}

const byteLength = text => new TextEncoder().encode(text).length;

/** The event as JSON, dropping `state` and then `code` until it fits. */
function encode(event) {
  let body = toJSON(event);
  for (const field of ['state', 'code']) {
    if (byteLength(body) <= MAX_EVENT_BYTES) return body;
    if (event.data[field] === undefined) continue;
    event = { ...event, data: { ...event.data, [field]: undefined, truncated: true } };
    body = toJSON(event);
  }
  return byteLength(body) <= MAX_EVENT_BYTES ? body : null;
}

export function createTelemetry({
  url,
  edition,
  version,
  storage = browserStorage,
  send = beacon,
}) {
  const enabled = Boolean(url);
  const session = randomId();
  // Kept in memory too, so blocked storage still gives one ID per page load.
  let client = null;
  let choice = null;
  const clientId = () => {
    if (!client) {
      client = storage.get(CLIENT_KEY) ?? randomId();
      storage.set(CLIENT_KEY, client);
    }
    return client;
  };
  /** 'on', 'off', or null before the student has chosen (which counts as on). */
  const getChoice = () => (enabled ? (choice ?? storage.get(CHOICE_KEY)) : 'off');
  return {
    enabled,
    getChoice,
    setChoice(value) {
      choice = value;
      storage.set(CHOICE_KEY, value);
    },
    /** Sends one event; never throws, since telemetry must not break the app. */
    track(type, data) {
      if (getChoice() === 'off' || !EVENT_TYPES.includes(type)) return false;
      try {
        const body = encode({
          v: 1,
          type,
          client: clientId(),
          session,
          edition,
          version,
          at: new Date().toISOString(),
          data,
        });
        if (!body) return false;
        send(url, body);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// import.meta.env is Vite's; it is absent when tests load this module under Node.
const env = import.meta.env ?? {};
export const telemetry = createTelemetry({
  url: env.VITE_TELEMETRY_URL,
  edition: env.MODE === 'instructor' ? 'instructor' : 'student',
  version: env.VITE_APP_VERSION,
});
