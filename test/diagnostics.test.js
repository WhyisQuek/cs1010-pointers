import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import {
  INTERNAL,
  INVALID,
  LIMIT,
  UNDEFINED,
  UNSUPPORTED,
  describeError,
  diagnostic,
  diagnosticKind,
} from '../src/language/diagnostics.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

/** Every rejection names why: invalid C, undefined behavior, outside the subset, or a limit. */
const kindOf = source => {
  try {
    interpret(source);
  } catch (error) {
    return diagnosticKind(error);
  }
  assert.fail('expected the program to be rejected');
};
const inMain = body => `int main(void) { ${body} }`;

const cases = [
  // Syntax and constraint violations (C23 5.1.1.3 requires a diagnostic).
  ['syntax error', inMain('int x = 1'), INVALID],
  ['undeclared identifier', inMain('int x = y;'), INVALID],
  ['redeclaration', inMain('int a=1;int a=2;'), INVALID],
  ['incompatible pointer assignment', inMain('char *p=NULL;int *q=p;'), INVALID],
  ['integer to pointer', inMain('int *p=3;'), INVALID],
  ['array assignment', inMain('int a[2],b[2];a=b;'), INVALID],
  ['too many initializers', inMain('int a[2]={1,2,3};'), INVALID],
  ['zero-length array', inMain('int a[0];'), INVALID],
  ['empty initializer for unknown size', inMain('int a[]={};'), INVALID],
  ['floating remainder', inMain('double x=3.5%2;'), INVALID],
  ['sizeof void', inMain('int x=sizeof(free(NULL));'), INVALID],
  ['out-of-range character escape', inMain("int x='\\x100';"), INVALID],
  ['string initializer too long', inMain('char s[2]="abc";'), INVALID],
  ['break outside loop', inMain('return 0;break;'), INVALID],
  ['wrong argument count', 'int f(int a){return a;}\nint main(void){ return f(); }', INVALID],
  ['call before definition', 'int main(void){ return f(); }\nint f(void){return 1;}', INVALID],
  ['NULL as an identifier', inMain('int NULL=1;'), INVALID],
  ['missing main', 'int f(void){return 1;}', INVALID],
  ['duplicate struct tag', 'struct S{int x;};struct S{int y;};\nint main(void){}', INVALID],
  ['floating array size', inMain('int a[2.5];'), INVALID],
  // Undefined behavior during execution.
  ['signed overflow', inMain('int x=2147483647; x++;'), UNDEFINED],
  ['division by zero', inMain('int z=0;int x=1/z;'), UNDEFINED],
  ['null dereference', inMain('int *p=NULL;int x=*p;'), UNDEFINED],
  ['use after free', inMain('int *p=malloc(sizeof(int));free(p);int x=*p;'), UNDEFINED],
  ['double free', inMain('int *p=malloc(sizeof(int));free(p);free(p);'), UNDEFINED],
  ['free of stack memory', inMain('int x;free(&x);'), UNDEFINED],
  ['out of bounds read', inMain('int a[2]={0};int x=a[2];'), UNDEFINED],
  ['pointer outside its array', inMain('int a[2];int *p=a+3;'), UNDEFINED],
  ['unrelated pointer ordering', inMain('int x,y;int n=&x<&y;'), UNDEFINED],
  ['uninitialized read', inMain('int x;int y=x;'), UNDEFINED],
  ['unsequenced modification', inMain('int i=0;int x=i++ + i;'), UNDEFINED],
  ['string literal write', inMain('char *p="abc";p[0]=1;'), UNDEFINED],
  ['printf argument mismatch', inMain('printf("%d", 1.0);'), UNDEFINED],
  ['invalid printf conversion', inMain('printf("%q");'), UNDEFINED],
  ['missing return value used', 'int f(void){}\nint main(void){ int x=f(); }', UNDEFINED],
  ['defining a library function', 'int malloc(void){return 0;}\nint main(void){}', UNDEFINED],
  ['dereferencing a block too small for its type', inMain('int *p=malloc(1);*p=1;'), UNDEFINED],
  [
    'reading an int as a long through void *',
    inMain('int x=1;void *v=&x;long *l=v;long y=*l;'),
    UNDEFINED,
  ],
  // Valid C outside the Mini-C subset.
  ['static storage', inMain('static int x;'), UNSUPPORTED],
  ['const qualifier', inMain('const int x=1;'), UNSUPPORTED],
  ['bitwise operator', inMain('int x=5&3;'), UNSUPPORTED],
  ['C23 binary literal', inMain('int x=0b101;'), UNSUPPORTED],
  ['C23 typeof', inMain('typeof(1) x=2;'), UNSUPPORTED],
  ['C23 static_assert', inMain('static_assert(1);'), UNSUPPORTED],
  ['unprovided library function', inMain('int *p=calloc(1, sizeof(int));'), UNSUPPORTED],
  [
    'reading an int as unsigned through void *',
    inMain('int x=1;void *v=&x;unsigned int *u=v;unsigned int y=*u;'),
    UNSUPPORTED,
  ],
  ['printf %n', inMain('int n;printf("%n", &n);'), UNSUPPORTED],
  ['wide character constant', inMain("int c=L'a';"), UNSUPPORTED],
  ['main with parameters', 'int main(int argc, char **argv){}', UNSUPPORTED],
  ['library name as a local', inMain('int free=0;'), UNSUPPORTED],
  ['long int spelling', inMain('long int x=1;'), UNSUPPORTED],
  [
    'typedef name reused as a struct tag (audit B3)',
    'typedef struct {int x;} S;struct S{long y;};\nint main(void){}',
    UNSUPPORTED,
  ],
  // Simulator limits.
  ['array length limit', inMain('int a[65];'), LIMIT],
  ['object size limit', inMain('int a[64][64][64];'), LIMIT],
  ['heap element limit', inMain('int *p=malloc(65*sizeof(int));'), LIMIT],
  ['heap byte limit', inMain('void *p=malloc(100000);'), LIMIT],
  ['loop iteration limit', inMain('for(;;){}'), LIMIT],
  ['output limit', inMain('for(int i=0;i<200;i++){printf("%099d", i);}'), LIMIT],
  ['call depth limit', 'int f(int n){return f(n+1);}\nint main(void){ f(0); }', LIMIT],
];

for (const [name, source, kind] of cases)
  test(`diagnostic category: ${name}`, () => assert.equal(kindOf(source), kind));

test('every category has a student-facing label', () => {
  for (const kind of [INVALID, UNDEFINED, UNSUPPORTED, LIMIT, INTERNAL]) {
    assert.match(describeError(diagnostic(kind, 'x')), /^[A-Z][^:]+: x$/);
  }
});

test('an error not created as a diagnostic is internal', () => {
  assert.equal(diagnosticKind(new Error('bug')), INTERNAL);
  assert.equal(describeError(new Error('bug')), 'PointerViz error: bug');
});
