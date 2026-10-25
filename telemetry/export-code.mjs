/**
 * Writes the C students wrote, from a telemetry database export, as one .c file per event:
 * sandbox runs, and answers to diagram → code challenges. See docs/TELEMETRY.md.
 *
 *   npx wrangler d1 export pointerviz-telemetry --remote --output telemetry-export.sql
 *   node telemetry/export-code.mjs telemetry-export.sql [telemetry-code]
 *
 * Files go in <out>/<browser ID>/, numbered by event ID so they sort in the order they were
 * sent, with <out>/index.csv listing them all. Needs Node.js 22.13 or later (node:sqlite).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [dump, out = 'telemetry-code'] = process.argv.slice(2);
if (!dump) {
  console.error('Usage: node telemetry/export-code.mjs <export.sql> [output folder]');
  process.exit(1);
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(dump, 'utf8'));

// Every generate event too, so a run of code straight from Generate C can be told apart.
const events = db
  .prepare(
    `SELECT id, received_at, client, session, type,
            json_extract(data, '$.code') AS code,
            json_extract(data, '$.steps') AS steps,
            json_extract(data, '$.error') AS error,
            json_extract(data, '$.level') AS level,
            json_extract(data, '$.attempt') AS attempt,
            json_extract(data, '$.pass') AS pass
     FROM events
     WHERE json_extract(data, '$.code') IS NOT NULL
       AND (type IN ('run', 'generate')
            OR (type = 'check' AND json_extract(data, '$.kind') = 'diagram-to-code'))
     ORDER BY id`,
  )
  .all();

const outcome = e => {
  if (e.type === 'check') return `attempt ${e.attempt}: ${e.pass ? 'passed' : 'failed'}`;
  if (e.error) return e.steps === null ? 'did not compile' : `stopped at step ${e.steps}`;
  return `${e.steps} steps`;
};
// Comments and CSV cells must not end early.
const comment = text => String(text).replaceAll('*/', '* /');
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;

const lastGenerated = new Map();
const index = [
  ['id', 'received_at', 'client', 'session', 'type', 'level', 'outcome', 'source', 'file'],
];
for (const e of events) {
  if (e.type === 'generate') {
    lastGenerated.set(e.session, e.code);
    continue;
  }
  // Code identical to the last Generate C output in the same page load was not typed.
  const source = lastGenerated.get(e.session) === e.code ? 'generate-c' : 'typed';
  const name = `${String(e.id).padStart(6, '0')}-${e.type}${e.level ? `-${e.level}` : ''}.c`;
  const file = `${e.client}/${name.replace(/[^\w.-]/g, '_')}`;
  const header = [
    `PointerViz telemetry event ${e.id} (${e.type}${e.level ? `, level ${e.level}` : ''})`,
    `received ${e.received_at}, session ${e.session}`,
    `${outcome(e)}${source === 'generate-c' ? ', unchanged from Generate C' : ''}`,
    ...(e.error ? [`error: ${e.error}`] : []),
  ];
  mkdirSync(join(out, e.client), { recursive: true });
  writeFileSync(join(out, file), `/* ${header.map(comment).join('\n * ')}\n */\n${e.code}`);
  index.push([e.id, e.received_at, e.client, e.session, e.type, e.level, outcome(e), source, file]);
}
writeFileSync(join(out, 'index.csv'), index.map(row => row.map(csv).join(',')).join('\n') + '\n');
const browsers = new Set(index.slice(1).map(row => row[2])).size;
console.log(`Wrote ${index.length - 1} files from ${browsers} browsers to ${out}/`);
