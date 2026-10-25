/** Usage telemetry: the app's event sender and the Cloudflare Worker that stores events. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry, MAX_EVENT_BYTES, telemetry } from '../src/data/telemetry.js';
import worker from '../telemetry/src/worker.js';
import { MAX_BODY_BYTES, parseEvent } from '../telemetry/src/events.js';

const COLLECTOR = 'https://collector.example/';
const ORIGIN = 'https://whyisquek.github.io';

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { items, get: key => items.get(key) ?? null, set: (key, v) => items.set(key, v) };
}

function sender(options = {}) {
  const sent = [];
  const t = createTelemetry({
    url: COLLECTOR,
    edition: 'student',
    version: '2.2.1',
    storage: memoryStorage(),
    send: (url, body) => sent.push({ url, event: JSON.parse(body), bytes: body.length }),
    ...options,
  });
  return { t, sent };
}

test('telemetry is off when the build has no collector URL', () => {
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetry.getChoice(), 'off');
  assert.equal(telemetry.track('run', { code: 'int main(void) {}' }), false);
});

test('events carry a stable browser ID and a per-load session ID', () => {
  const storage = memoryStorage();
  const { t, sent } = sender({ storage });
  t.track('run', { code: 'a', steps: 1, error: null });
  t.track('generate', { state: {}, step: null, code: 'b', error: null });
  assert.equal(sent.length, 2);
  const [first, second] = sent.map(s => s.event);
  assert.equal(sent[0].url, COLLECTOR);
  assert.match(first.client, /^[0-9a-f]{32}$/);
  assert.match(first.session, /^[0-9a-f]{32}$/);
  assert.equal(first.client, second.client);
  assert.equal(first.session, second.session);
  assert.equal(storage.items.get('pointerviz.client.v1'), first.client);
  assert.deepEqual(
    { v: first.v, type: first.type, edition: first.edition, version: first.version },
    { v: 1, type: 'run', edition: 'student', version: '2.2.1' },
  );

  // A later page load keeps the browser ID but starts a new session.
  const again = sender({ storage });
  again.t.track('run', { code: 'c', steps: 1, error: null });
  assert.equal(again.sent[0].event.client, first.client);
  assert.notEqual(again.sent[0].event.session, first.session);
});

test('nothing is sent once the student turns telemetry off', () => {
  const { t, sent } = sender();
  assert.equal(t.getChoice(), null);
  t.setChoice('off');
  assert.equal(t.track('run', { code: 'a' }), false);
  t.setChoice('on');
  assert.equal(t.track('run', { code: 'a' }), true);
  assert.equal(sent.length, 1);
});

test('oversized events drop the state, then the code, to fit', () => {
  const { t, sent } = sender();
  const big = 'x'.repeat(MAX_EVENT_BYTES);
  t.track('check', { level: 'l1', state: { big }, code: 'int main(void) {}', pass: false });
  t.track('run', { code: big, steps: null, error: 'too long' });
  assert.equal(sent[0].event.data.state, undefined);
  assert.equal(sent[0].event.data.code, 'int main(void) {}');
  assert.equal(sent[0].event.data.truncated, true);
  assert.equal(sent[1].event.data.code, undefined);
  assert.equal(sent[1].event.data.error, 'too long');
  assert.ok(sent.every(s => s.bytes <= MAX_EVENT_BYTES));
});

test('BigInt values in memory states are sent as tagged JSON', () => {
  const { t, sent } = sender();
  t.track('generate', { state: { value: 2n ** 60n }, step: 3, code: 'x', error: null });
  assert.deepEqual(sent[0].event.data.state.value, { $bigint: String(2n ** 60n) });
});

test('a failing transport never reaches the app', () => {
  const { t } = sender({
    send: () => {
      throw new Error('offline');
    },
  });
  assert.equal(t.track('run', { code: 'a' }), false);
});

// ---- Worker ----

function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare: sql => ({ bind: (...values) => ({ run: async () => rows.push({ sql, values }) }) }),
  };
}

const env = (overrides = {}) => ({
  ALLOWED_ORIGINS: `${ORIGIN}, http://127.0.0.1:3000`,
  DB: fakeDb(),
  ...overrides,
});

const validEvent = () => ({
  v: 1,
  type: 'run',
  client: 'a'.repeat(32),
  session: 'b'.repeat(32),
  edition: 'student',
  version: '2.2.1',
  at: '2026-10-25T08:00:00.000Z',
  data: { code: 'int main(void) {}', steps: 2, error: null },
});

const post = (body, origin = ORIGIN) =>
  new Request(COLLECTOR, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(origin && { Origin: origin }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('the worker stores a valid event and allows its origin', async () => {
  const e = env();
  const res = await worker.fetch(post(validEvent()), e);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(e.DB.rows.length, 1);
  const [clientAt, type, client, session, edition, version, data] = e.DB.rows[0].values;
  assert.deepEqual(
    [clientAt, type, client, session, edition, version],
    ['2026-10-25T08:00:00.000Z', 'run', 'a'.repeat(32), 'b'.repeat(32), 'student', '2.2.1'],
  );
  assert.deepEqual(JSON.parse(data), validEvent().data);
});

test('the worker rejects other origins, methods, sizes and shapes', async () => {
  const e = env();
  assert.equal((await worker.fetch(post(validEvent(), 'https://evil.example'), e)).status, 403);
  assert.equal((await worker.fetch(post(validEvent(), null), e)).status, 403);
  assert.equal(
    (await worker.fetch(new Request(COLLECTOR, { headers: { Origin: ORIGIN } }), e)).status,
    405,
  );
  const huge = { ...validEvent(), data: { code: 'x'.repeat(MAX_BODY_BYTES) } };
  assert.equal((await worker.fetch(post(huge), e)).status, 413);
  assert.equal((await worker.fetch(post('not json'), e)).status, 400);
  assert.equal((await worker.fetch(post({ ...validEvent(), type: 'other' }), e)).status, 400);
  assert.equal(e.DB.rows.length, 0);
});

test('the worker answers preflight only for allowed origins', async () => {
  const preflight = origin =>
    new Request(COLLECTOR, { method: 'OPTIONS', headers: { Origin: origin } });
  const ok = await worker.fetch(preflight('http://127.0.0.1:3000'), env());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal((await worker.fetch(preflight('https://evil.example'), env())).status, 403);
});

test('the worker rate-limits by browser ID', async () => {
  const keys = [];
  const e = env({ LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } });
  assert.equal((await worker.fetch(post(validEvent()), e)).status, 429);
  assert.deepEqual(keys, ['a'.repeat(32)]);
  assert.equal(e.DB.rows.length, 0);
});

test('parseEvent validates IDs and caps label fields', () => {
  assert.equal(parseEvent(JSON.stringify({ ...validEvent(), client: 'not-an-id' })), null);
  assert.equal(parseEvent(JSON.stringify({ ...validEvent(), data: [] })), null);
  const row = parseEvent(JSON.stringify({ ...validEvent(), version: 'v'.repeat(40), at: 'soon' }));
  assert.equal(row.version, null);
  assert.equal(row.clientAt, null);
});
