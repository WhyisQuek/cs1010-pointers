/** printf: format parsing, glibc-compatible formatting, argument checks and step output. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const output = body => interpret(`#include <stdio.h>\nint main(void) {${body} return 0; }`).output;

// Expected strings are what glibc prints for the same LP64 program.
const cases = [
  ['plain text and escapes', 'printf("hi\\tthere\\n");', 'hi\tthere\n'],
  ['percent sign', 'printf("100%%");', '100%'],
  ['adjacent literals concatenate', 'printf("a" "b" "%d", 1);', 'ab1'],
  ['signed decimal', 'int x = -42; printf("%d %i", x, x);', '-42 -42'],
  [
    'flags and widths',
    'int x = 42; printf("[%5d][%-5d][%05d][%+d][% d]", x, x, x, x, x);',
    '[   42][42   ][00042][+42][ 42]',
  ],
  ['integer precision', 'printf("[%.3d][%.0d][%8.3d]", 7, 0, -7);', '[007][][    -007]'],
  [
    'bases and alternate form',
    'printf("%x %X %o %#x %#o %#x", 255, 255, 8, 255, 8, 0);',
    'ff FF 10 0xff 010 0',
  ],
  [
    'unsigned and long',
    'unsigned int u = 4000000000U; long l = -5; printf("%u %ld", u, l);',
    '4000000000 -5',
  ],
  ['size_t', 'printf("%zu %lu", sizeof(long), sizeof(int));', '8 4'],
  ['char and string', 'char c = \'A\'; printf("%c%c|%s|", c, 66, "str");', 'AB|str|'],
  [
    'string from a char array',
    "char s[4] = {'a', 'b', 'c', '\\0'}; printf(\"[%s][%5s][%-5s][%.2s]\", s, s, s, s);",
    '[abc][  abc][abc  ][ab]',
  ],
  [
    'string from a pointer into an array',
    "char s[3] = {'x', 'y', 0}; char *p = s + 1; printf(\"%s\", p);",
    'y',
  ],
  ['precision reads only the needed chars', "char s[2] = {'o', 'k'}; printf(\"%.2s\", s);", 'ok'],
  ['default double precision', 'printf("%f %f", 3.14159, 1.0 / 3);', '3.141590 0.333333'],
  [
    'round half to even on exact ties',
    'printf("%.0f %.0f %.0f %.1f", 0.5, 1.5, 2.5, 0.25);',
    '0 2 2 0.2',
  ],
  ['exact binary value decides rounding', 'printf("%.2f", 2.675);', '2.67'],
  ['negative zero', 'printf("%f", -0.0);', '-0.000000'],
  ['float promotes to double', 'float f = 0.1f; printf("%.10f", f);', '0.1000000015'],
  [
    'exponent form',
    'printf("%e %.2E %.0e", 12345.678, 0.000123, 5.0);',
    '1.234568e+04 1.23E-04 5e+00',
  ],
  [
    'general form',
    'printf("%g %g %g %g %g %G", 100000.0, 1000000.0, 0.0001, 0.00001, 123456789.0, 1e-10);',
    '100000 1e+06 0.0001 1e-05 1.23457e+08 1E-10',
  ],
  [
    'general form keeps exponent zeros',
    'printf("%g %g %.2g %g", 12345678901.0, 0.000000000123456, 1.2e10, 1e20);',
    '1.23457e+10 1.23456e-10 1.2e+10 1e+20',
  ],
  ['general form alternate keeps zeros', 'printf("%#g %g", 1.5, 1.5);', '1.50000 1.5'],
  ['large doubles print exactly', 'printf("%.0f", 1e22);', '10000000000000000000000'],
  ['floating width', 'printf("[%10.4f][%-10.1e]", -3.14159, 12345.0);', '[   -3.1416][1.2e+04   ]'],
  [
    'star width and precision',
    'printf("%*d|%-*d|%.*f", 4, 1, -4, 2, 2, 3.14159);',
    '   1|2   |3.14',
  ],
  [
    'bool and narrowing length modifiers',
    'bool b = true; printf("%d %hhd %hu %hhx", b, 300, -1, -1);',
    '1 44 65535 ff',
  ],
  [
    'pointers use simulated addresses',
    'int a[2]; printf("%p %p", a, &a[1]);',
    '0x10000000 0x10000004',
  ],
  ['null pointer', 'int *p = NULL; printf("%p", p);', '(nil)'],
  ['return value counts characters', 'int n = printf("abc"); printf("%d", n);', 'abc3'],
  ['output accumulates across calls', 'for (int i = 0; i < 3; i++) printf("%d,", i);', '0,1,2,'],
];

for (const [name, body, expected] of cases) {
  test(`printf ${name}`, () => assert.equal(output(body), expected));
}

const rejected = [
  ['non-literal format', 'int x = 1; printf(x);', /string literal as its format/],
  ['missing argument', 'printf("%d %d", 1);', /needs 2 argument/],
  ['double for %d', 'printf("%d", 1.5);', /%d expects int, but the argument has type double/],
  ['long for %d', 'long l = 1; printf("%d", l);', /%d expects int, but the argument has type long/],
  ['int for %f', 'printf("%f", 1);', /%f expects double/],
  ['int for %s', 'printf("%s", 1);', /%s expects char \*/],
  ['int pointer for %s', 'int x; printf("%s", &x);', /%s expects char \*/],
  ['int for %p', 'printf("%p", 1);', /%p expects a pointer/],
  ['long long', 'printf("%lld", 1);', /'ll' is not supported/],
  ['%n', 'int n; printf("%n", &n);', /%n is not supported/],
  ['unknown conversion', 'printf("%q", 1);', /unsupported conversion '%q'/],
  ['dangling percent', 'printf("50%");', /incomplete conversion/],
  ['flagged percent', 'printf("%5%");', /write %% for a percent sign/],
  ['negative value for %u', 'printf("%u", -1);', /does not fit the unsigned type/],
  ['large unsigned value for %d', 'printf("%d", 4000000000U);', /does not fit the signed type/],
  ['unterminated string', "char s[2] = {'a', 'b'}; printf(\"%s\", s);", /no terminating/],
  ['uninitialized string', 'char s[3]; s[0] = \'a\'; printf("%s", s);', /uninitialized/],
  ['null string', 'char *s = NULL; printf("%s", s);', /null pointer/],
  ['unsequenced arguments', 'int i = 0; printf("%d %d", i++, i);', /unsequenced/],
  ['unterminated char array', 'char s[3] = "abc"; printf("%s", s);', /terminating/],
];

for (const [name, body, pattern] of rejected) {
  test(`printf rejects ${name}`, () => assert.throws(() => output(body), pattern));
}

test('printf cannot be redefined', () => {
  assert.throws(
    () => interpret('int printf(int x) { return x; } int main(void) { return 0; }'),
    /cannot define 'printf'/,
  );
});

test('each snapshot records the output printed so far', () => {
  const { snapshots } = interpret(`int main(void) {
    printf("a");
    int x = 1;
    printf("b%d\\n", x);
    return 0;
}`);
  const byLine = Object.fromEntries(snapshots.map(s => [s.line, s.output]));
  assert.equal(byLine[2], 'a');
  assert.equal(byLine[3], 'a');
  assert.equal(byLine[4], 'ab1\n');
  assert.ok(snapshots.some(s => s.events.some(e => e.kind === 'Output' && e.text === 'b1\n')));
});

test('printf inside sizeof is not evaluated', () => {
  assert.equal(output('int n = sizeof(printf("x")); printf("%d", n);'), '4');
});
