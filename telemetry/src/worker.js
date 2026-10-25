/**
 * PointerViz telemetry collector: a Cloudflare Worker that checks usage events from the app
 * (src/data/telemetry.js) and appends them to D1 (telemetry/schema.sql). It only accepts
 * writes; read the data with `wrangler d1 execute` or the Cloudflare dashboard.
 * See docs/TELEMETRY.md.
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
function allowedOrigin(origin, allowed = '') {
  return Boolean(origin) && allowed.split(',').some(o => o.trim() === origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = allowedOrigin(origin, env.ALLOWED_ORIGINS);
    const headers = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const reply = status => new Response(null, { status, headers });

    if (request.method === 'OPTIONS') {
      if (!allowed) return reply(403);
      headers['Access-Control-Allow-Methods'] = 'POST';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '86400';
      return reply(204);
    }
    if (request.method !== 'POST') return reply(405);
    // Origin only filters browsers; anything else can send one, hence the limits below.
    if (!allowed) return reply(403);
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return reply(413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply(413);
    const event = parseEvent(text);
    if (!event) return reply(400);
    // Keyed by browser ID, not IP: a whole lab shares one campus address.
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: event.client });
      if (!success) return reply(429);
    }
    await env.DB.prepare(
      `INSERT INTO events (client_at, type, client, session, edition, version, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        event.clientAt,
        event.type,
        event.client,
        event.session,
        event.edition,
        event.version,
        event.data,
      )
      .run();
    return reply(204);
  },
};
