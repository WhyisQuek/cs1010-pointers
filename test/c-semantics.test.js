import { values, programs } from './c-semantics-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate, validate, ValidationError } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';
import { pointerStatus, resolveRef, setRefValue } from '../src/machine/memory.js';
import { decodeCharLiteral, encodeCharLiteral } from '../src/language/literals.js';
import { primitive } from '../src/language/types.js';
import { scalarText } from '../src/flow/addressPresentation.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});
const run = body => interpret(`int main(void) { ${body} }`);
const scalar = (state, name) =>
  state.allocations.find(a => a.name === name && a.storage.frameId === 'main').value.value;

// Expected values follow C11 N1570 clauses cited in docs/C_SEMANTICS_AUDIT.md.

for (const [name, body, expected] of values)
  test(name, () => assert.equal(scalar(run(body).state, 'result'), expected));

for (const [name, source, expected] of programs)
  test(name, () => assert.equal(scalar(interpret(source).state, 'result'), expected));

const errors = [
  ['omitted array size requires initializer', 'int a[];', /requires an initializer list/],
  ['omitted array size requires list', 'int a[]=1;', /requires an initializer list/],
  ['inferred empty array is rejected', 'int a[]={};', /empty initializer/],
  ['only outer array dimension may be inferred', 'int a[2][]={{1},{2}};', /outermost array size/],
  ['multiple omitted dimensions are rejected', 'int a[][]={{1}};', /outermost array size/],
  ['pointer to incomplete array stays unsupported', 'int (*a)[]={0};', /outermost array size/],
  ['inferred array length bound', `int a[]={${Array(65).fill(1).join(',')}};`, /between 1 and 64/],
  [
    'inferred array still checks element types',
    'int a[]={1,NULL};int *p[]={a,3};',
    /cannot assign/,
  ],
  ['inferred array still checks row capacity', 'int a[][2]={{1,2,3}};', /too many/],
  ['sizeof own incomplete array is rejected', 'int a[]={sizeof(a)};', /complete array type/],
  ['inferred array bounds are enforced', 'int a[]={1,2};int x=a[2];', /bounds/],
  ['signed addition overflow', 'int x=2147483647; x++;', /overflow/],
  ['signed multiplication overflow', 'int x=50000*50000;', /overflow/],
  ['signed division overflow', 'int x=-2147483647-1; int y=x/-1;', /overflow/],
  ['signed remainder overflow', 'int x=-2147483647-1; int y=x%-1;', /overflow/],
  ['unary overflow', 'int x=-2147483647-1; int y=-x;', /overflow/],
  ['division by zero', 'int x=1/0;', /division by zero/],
  ['remainder on floating operands', 'double x=3.5%2;', /remainder/],
  ['floating pointer offset', 'int a[3]; int *p=a+1.5;', /not supported|integer/],
  ['floating subscript', 'int a[3];int x=a[1.5];', /integer/],
  ['nonconstant zero pointer initialization', 'int zero=0;int *p=zero;', /cannot assign/],
  [
    'nonconstant zero pointer comparison',
    'int zero=0;int *p=NULL;int x=p==zero;',
    /cannot compare/,
  ],
  ['incompatible null pointer assignment', 'char *p=NULL;int *q=p;', /incompatible/],
  ['incompatible null pointer comparison', 'char *p=NULL;int *q=NULL;int x=p==q;', /incompatible/],
  ['free returns void', 'int x=free(NULL);', /cannot assign/],
  ['free stack', 'int x;free(&x);', /heap memory/],
  ['free interior', 'int *p=malloc(3*sizeof(int));free(p+1);', /original allocation pointer/],
  ['double free', 'int *p=malloc(sizeof(int));free(p);free(p);', /double free/],
  ['use after free', 'int *p=malloc(sizeof(int));free(p);int x=*p;', /dangling/],
  ['arithmetic after free', 'int *p=malloc(2*sizeof(int));free(p);p++;', /lifetime/],
  ['read uninitialized local', 'int x;int y=x;', /uninitialized/],
  ['read uninitialized heap', 'int *p=malloc(sizeof(int));int x=*p;', /uninitialized/],
  ['one-past dereference', 'int a[2];int x=*(a+2);', /bounds/],
  ['one-past write', 'int a[2];a[2]=1;', /bounds/],
  ['singleton one-past dereference', 'int x;int y=*(&x+1);', /bounds/],
  ['pointer before array', 'int a[2];int *p=a-1;', /bounds/],
  ['pointer beyond one-past', 'int a[2];int *p=a+3;', /bounds/],
  ['nested row boundary is preserved', 'int a[2][3];int *p=a[0]+4;', /bounds/],
  ['pointer subtraction between rows', 'int a[2][3];int x=a[1]-a[0];', /same array/],
  ['pointer order across allocations', 'int x,y;int n=&x<&y;', /same array/],
  ['null arithmetic', 'int *p=NULL;p+=0;', /concrete pointer/],
  ['array assignment', 'int a[2],b[2];a=b;', /arrays are not assignable/],
  ['too many initializers', 'int a[2]={1,2,3};', /too many/],
  ['array length bound', 'int a[65];', /between 1 and 64/],
  ['heap allocation bound', 'int *p=malloc(65*sizeof(int));', /limits one allocation/],
  ['static storage is explicitly unsupported', 'static int x;', /not supported/],
  ['const qualification is explicitly unsupported', 'const int x=1;', /not supported/],
  ['floating array size is rejected', 'int a[2.5];', /integer literal/],
  ['multi-character constant is rejected', "int x='AB';", /single ASCII/],
  ['unsequenced increment and read', 'int i=0;int x=i++ + i;', /unsequenced/],
  ['unsequenced increments', 'int i=0;int x=i++ + i++;', /unsequenced/],
  ['unsequenced assignment and increment', 'int i=0;i=i++;', /unsequenced/],
  ['unsequenced compound assignment', 'int i=0;i+=i++;', /unsequenced/],
  ['unsequenced subscript address and rhs', 'int a[3]={0};int i=0;a[i]=i++;', /unsequenced/],
  ['unsequenced aliased read', 'int i=0;int *p=&i;int x=(*p)++ + i;', /unsequenced/],
  ['dead branch is still type checked', 'if(0){int *p=3;}', /cannot assign/],
  ['skipped logical operand is still checked', 'int x=1 || undeclared;', /undeclared/],
  ['sizeof validates lvalue constraint', 'int x=sizeof(3=4);', /not assignable|syntax error/],
  ['sizeof validates call arguments', 'int x=sizeof(free());', /exactly one/],
  ['sizeof void expression rejected', 'int x=sizeof(free(NULL));', /sizeof unsupported/],
  ['unreachable break outside loop rejected', 'return 0;break;', /outside a loop/],
  ['library function names cannot be declared', 'int free=0;', /reserved for the standard/],
  ['malloc cannot name a pointer', 'int *malloc=NULL;', /reserved for the standard/],
  ['printf cannot name a variable', 'int printf=1;', /reserved for the standard/],
  [
    'dangling pointer comparison rejected',
    'int *p=malloc(sizeof(int));free(p);int n=p==NULL;',
    /dangling/,
  ],
  ['dangling pointer copy rejected', 'int *p=malloc(sizeof(int));free(p);int *q=p;', /dangling/],
  ['nested object storage bound', 'int a[64][64][64];', /4096 scalar/],
  ['character escape must fit byte', "int x='\\x100';", /character escape/],
  ['nonconstant zero to free is invalid', 'int x=0;free(x);', /pointer or NULL/],
  ['NULL macro cannot be declared', 'int NULL=1;', /predefined macro/],
  ['string literal write', 'char *p="abc";p[0]=\'x\';', /cannot modify a string literal/],
  ['string literal write via deref', 'char *p="abc";*(p+1)=0;', /cannot modify a string literal/],
  ['string initializer too long', 'char s[2]="abc";', /too long/],
  ['string initializer for int array', 'int a[3]="ab";', /cannot assign/],
  ['string literal bounds', 'char *p="ab";char c=p[3];', /bounds/],
  ['string literal to int pointer', 'int *p="ab";', /incompatible/],
  [
    'brace list for a char pointer suggests an array or literal',
    "char *p={'a','b','c','\\0'};",
    /'p' is a pointer \(char \*\): it holds one address, not a list of 4 values.*char p\[\] = \{ \.\.\. \}.*char \*p = "\.\.\."/,
  ],
  [
    'brace list for a pointer suggests an array',
    'int *q={1,2};',
    /int q\[\] = \{ \.\.\. \}; \(line/,
  ],
  [
    'brace list for a scalar',
    'int x={1,2};',
    /'x' is a single int, but the \{ \.\.\. \} list has 2/,
  ],
];
for (const [name, body, pattern] of errors)
  test(name, () => assert.throws(() => run(body), pattern));

test('program-level rules are reported by the checker, with or without the parser', () => {
  assert.throws(() => interpret('int f(void){return 1;}'), /no main\(\) function found — wrap/);
  assert.throws(
    () => interpret('int f(void){return 1;} int f(void){return 2;} int main(void){}'),
    /duplicate function definition/,
  );
  assert.throws(
    () => interpret('int f(int a){return a;} int main(void){int x=f(1,2);}'),
    /f expects 1 argument\(s\), got 2/,
  );
  assert.throws(() => run('int a=1;int a=2;'), /redeclaration of 'a'/);
});

for (const [name, source] of [
  ['malloc', 'int *malloc(int n){return NULL;}int main(void){int *p=malloc(4);}'],
  ['free', 'void free(int *p){}int main(void){return 0;}'],
  ['library parameter', 'void f(int *free){}int main(void){return 0;}'],
])
  test(`standard library names cannot be redefined: ${name}`, () =>
    assert.throws(() => interpret(source), /standard library/));

for (const source of [
  '#define X 1\nint main(void){int x=X;}',
  'int global=1;int main(void){}',
  'int main(void){} int main(void){}',
  'struct S {struct S value;};int main(void){}',
  'struct S {int x:2;};int main(void){}',
  'struct S {int x;};struct S {int y;};int main(void){}',
  'int f(int a,int b){return a+b;}int main(void){int i=0;int n=f(i++,i);}',
  'int main(void){int x=f();}int f(void){return 1;}',
  'int main(void){struct Local {int x;};}',
])
  test(`reject unsupported or invalid translation unit: ${source.slice(0, 45)}`, () =>
    assert.throws(() => interpret(source)));

for (const body of [
  'int a[]={1,2,3};int *p=a+2;',
  'int a[][3]={{1},{2,3}};int (*p)[3]=a;',
  'int a[3]={1,2,3};int *p=&a[3];',
  'int x=7;int *p=&x+1;',
  'int a[2][3]={{1,2,3},{4,5,6}};int (*p)[3]=a;int *q=a[1]+2;',
  'int a[3];int (*p)[3]=&a+1;',
  'double d=3.5;float f=0.1f;unsigned int u=4294967295U;long l=2147483648L;',
  'int *p=malloc(sizeof(int));*p=7;p++;',
  'char *t="abc";char *u=t+2;char s[]="hi";',
  'char *t="a\\"b\\\\c\\n\\0001";',
  'char *t="abc";t=NULL;',
])
  test(`canonical C round-trip: ${body}`, () => {
    const before = run(body).state;
    const source = generate(before);
    const after = interpret(source).state;
    assert.equal(equivalent(before, after).equal, true, source);
  });

test('memory setters and grading reject out-of-bounds reference paths', () => {
  const state = run('int a[2];int *p=a;').state;
  const a = state.allocations.find(a => a.name === 'a');
  assert.throws(
    () => setRefValue(state, { allocationId: a.id, path: [2] }, { kind: 'scalar', value: 9 }),
    /bounds/,
  );
  const p = state.allocations.find(a => a.name === 'p');
  p.value.target.path = [3];
  assert.throws(() => validate(state), ValidationError);
  p.value.target = { allocationId: 'missing', path: [] };
  assert.throws(() => validate(state), ValidationError);
});

test('singleton and nested one-past pointer statuses remain visible', () => {
  const state = run('int x;int *p=&x+1;int a[2][3];int *q=&a[1][3];').state;
  for (const name of ['p', 'q'])
    assert.equal(
      pointerStatus(state, state.allocations.find(a => a.name === name).value),
      'one-past',
    );
  const a = state.allocations.find(a => a.name === 'a');
  assert.equal(resolveRef(state, { allocationId: a.id, path: [2, 0] }).invalid, true);
});

test('NULL uses the documented integer-zero macro definition', () => {
  const state = run('int n=NULL;int result=sizeof(NULL);int *p=NULL;').state;
  assert.equal(scalar(state, 'n'), 0);
  assert.equal(scalar(state, 'result'), 4);
  assert.equal(state.allocations.find(a => a.name === 'p').value.kind, 'null');
});

test('string literals are shared read-only static char arrays', () => {
  const { state } = run(
    'char *t="abc";char *u="abc";char s[]="abc";char r[3]="abc";char pad[5]="ab";',
  );
  const literals = state.allocations.filter(a => a.storage.kind === 'static');
  assert.deepEqual(
    literals.map(a => [a.name, a.type.length]),
    [['"abc"', 4]],
  );
  const chars = name =>
    state.allocations.find(a => a.name === name).value.elements.map(e => e.value);
  assert.deepEqual(chars('s'), [97, 98, 99, 0]);
  assert.deepEqual(chars('r'), [97, 98, 99]);
  assert.deepEqual(chars('pad'), [97, 98, 0, 0, 0]);
  const t = state.allocations.find(a => a.name === 't').value.target;
  assert.deepEqual(t, { allocationId: literals[0].id, path: [0] });
  assert.ok(literals[0].baseAddress < state.allocations.find(a => a.name === 't').baseAddress);
});

test('char values can be shown as character constants', () => {
  const char = primitive('char');
  assert.equal(scalarText(char, 97), '97');
  assert.equal(scalarText(char, 97, 'character'), "'a'");
  assert.equal(scalarText(primitive('int'), 97, 'character'), '97');
  for (const code of [0, 10, 39, 92, 32, 126, 127, -1, -128]) {
    const text = encodeCharLiteral(code);
    assert.equal(decodeCharLiteral(text), code, text);
  }
  assert.deepEqual([0, 10, 39, -1].map(encodeCharLiteral), ["'\\0'", "'\\n'", "'\\''", "'\\xff'"]);
});

test('comments act as whitespace in expressions, calls, return and initializers', () => {
  const source =
    'int f(int n){return /* return */ n;}int main(void){int a[2]={/*first*/3,/*second*/4};int result=f(/*arg*/a[0])+ (/*paren*/a[1]);int n=sizeof /*size*/ result;}';
  assert.equal(scalar(interpret(source).state, 'result'), 7);
});
