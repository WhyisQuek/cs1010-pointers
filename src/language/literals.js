/** Character constants for the documented ASCII, signed-char implementation. */
export function decodeCharLiteral(raw) {
  if (!raw.startsWith("'") || !raw.endsWith("'"))
    throw new Error('wide character constants are not supported');
  const body = raw.slice(1, -1);
  if (!body.startsWith('\\')) {
    if (body.length !== 1 || body.charCodeAt(0) > 127)
      throw new Error('only single ASCII character literals are supported');
    return body.charCodeAt(0);
  }
  const escapes = {
    '\\0': 0,
    '\\n': 10,
    '\\r': 13,
    '\\t': 9,
    '\\b': 8,
    '\\f': 12,
    '\\v': 11,
    "\\'": 39,
    '\\"': 34,
    '\\\\': 92,
    '\\a': 7,
    '\\?': 63,
  };
  if (Object.hasOwn(escapes, body)) return escapes[body];
  const n = /^\\x[0-9a-fA-F]+$/.test(body)
    ? Number.parseInt(body.slice(2), 16)
    : /^\\[0-7]{1,3}$/.test(body)
      ? Number.parseInt(body.slice(1), 8)
      : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 255)
    throw new Error(`unsupported character escape '${raw}'`);
  return n >= 128 ? n - 256 : n;
}

/** A narrow string literal's characters as char values, without the terminating '\0'. */
export function decodeStringLiteral(raw) {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2)
    throw new Error('only narrow "..." string literals are supported');
  const body = raw.slice(1, -1);
  const codes = [];
  for (const [part] of body.matchAll(/\\(?:x[0-9a-fA-F]+|[0-7]{1,3}|.)|[^\\]/gs)) {
    if (part === '\n') throw new Error('string literal contains a newline');
    codes.push(decodeCharLiteral(`'${part}'`));
  }
  return codes;
}

/** The literal in a char array's string initializer: "abc" or { "abc" }; otherwise null. */
export function stringInitializerLiteral(e) {
  if (e.kind === 'StringLiteral') return e;
  if (
    e.kind === 'InitializerList' &&
    e.elements.length === 1 &&
    e.elements[0].kind === 'StringLiteral'
  )
    return e.elements[0];
  return null;
}

const ESCAPES = {
  0: '\\0',
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  11: '\\v',
  12: '\\f',
  13: '\\r',
};

/** The C spelling of char values as one "..." literal; decodeStringLiteral reverses it. */
export function encodeStringLiteral(codes) {
  let out = '"';
  codes.forEach((code, i) => {
    const c = code & 0xff;
    if (Object.hasOwn(ESCAPES, c) && !(c === 0 && /^[0-7]$/.test(nextChar(codes, i))))
      out += ESCAPES[c];
    else if (c === 34 || c === 92) out += `\\${String.fromCharCode(c)}`;
    else if (c >= 32 && c < 127) out += String.fromCharCode(c);
    // Three octal digits always end the escape, unlike \x, which absorbs following hex digits.
    else out += `\\${c.toString(8).padStart(3, '0')}`;
  });
  return `${out}"`;
}

/** The C spelling of one char value, such as 'a', '\0' or '\xff'; decodeCharLiteral reverses it. */
export function encodeCharLiteral(code) {
  const c = code & 0xff;
  if (Object.hasOwn(ESCAPES, c)) return `'${ESCAPES[c]}'`;
  if (c === 39 || c === 92) return `'\\${String.fromCharCode(c)}'`;
  if (c >= 32 && c < 127) return `'${String.fromCharCode(c)}'`;
  return `'\\x${c.toString(16).padStart(2, '0')}'`;
}

const nextChar = (codes, i) =>
  i + 1 < codes.length ? String.fromCharCode(codes[i + 1] & 0xff) : '';
