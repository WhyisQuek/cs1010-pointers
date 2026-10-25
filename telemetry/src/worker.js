/**
 * PointerViz telemetry collector: a Cloudflare Worker that checks usage events from the app
 * (src/data/telemetry.js) and appends them to D1 (telemetry/schema.sql). It only accepts
 * writes; read the data with `wrangler d1 execute` or the Cloudflare dashboard.
 * See docs/TELEMETRY.md.
 *
 * Export only the handler from this file; helpers go in events.js (see there).
 */
import { allowedOrigin, MAX_BODY_BYTES, parseEvent } from './events.js';

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
