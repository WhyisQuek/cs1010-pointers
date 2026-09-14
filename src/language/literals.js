/** Character constants for the documented ASCII, signed-char implementation. */
export function decodeCharLiteral(raw) {
  if (!raw.startsWith("'") || !raw.endsWith("'")) throw new Error('wide character constants are not supported');
  const body = raw.slice(1, -1);
  if (!body.startsWith('\\')) {
    if (body.length !== 1 || body.charCodeAt(0) > 127) throw new Error('only single ASCII character literals are supported');
    return body.charCodeAt(0);
  }
  const escapes = { '\\0': 0, '\\n': 10, '\\r': 13, '\\t': 9, '\\b': 8, '\\f': 12, '\\v': 11, "\\'": 39, '\\"': 34, '\\\\': 92, '\\a': 7, '\\?': 63 };
  if (Object.hasOwn(escapes, body)) return escapes[body];
  const n = /^\\x[0-9a-fA-F]+$/.test(body) ? Number.parseInt(body.slice(2), 16)
    : /^\\[0-7]{1,3}$/.test(body) ? Number.parseInt(body.slice(1), 8) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`unsupported character escape '${raw}'`);
  return n >= 128 ? n - 256 : n;
}
