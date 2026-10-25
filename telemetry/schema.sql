-- PointerViz telemetry (D1). One row per event; `data` is the event's JSON payload.
-- Apply with: npx wrangler d1 execute pointerviz-telemetry --remote --file schema.sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client_at TEXT,
  type TEXT NOT NULL,
  client TEXT NOT NULL,
  session TEXT NOT NULL,
  edition TEXT,
  version TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type_time ON events (type, received_at);
CREATE INDEX IF NOT EXISTS events_client_time ON events (client, received_at);
