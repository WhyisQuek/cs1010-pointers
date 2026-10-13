/**
 * JSON for memory states. Integers beyond 2^53 are stored as BigInt (language/numeric.js),
 * which plain JSON cannot represent, so they are written as { "$bigint": "digits" }.
 */
const TAG = '$bigint';

export function toJSON(value, space) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { [TAG]: String(v) } : v), space);
}

export function fromJSON(text) {
  return JSON.parse(text, (_, v) =>
    v && typeof v === 'object' && typeof v[TAG] === 'string' && Object.keys(v).length === 1
      ? BigInt(v[TAG])
      : v,
  );
}
