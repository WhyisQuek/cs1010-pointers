/** C23 behavior fixed after the N3088 audit (docs/C_SPEC_AUDIT_N3088.md, Phase 1). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate } from '../src/pipeline/codegen.js';
import { fromJSON, toJSON } from '../src/data/json.js';
import { INVALID, UNDEFINED, UNSUPPORTED, diagnosticKind } from '../src/language/diagnostics.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const inMain = (body, before = '', after = '') => `${before}\nint main(void) { ${body} }\n${after}`;
const result = source =>
  interpret(source).state.allocations.find(a => a.name === 'result' && a.storage.frameId === 'main')
    .value.value;
const kindOf = source => {
  try {
    interpret(source);
  } catch (error) {
    return diagnosticKind(error);
  }
  assert.fail('expected the program to be rejected');
};

const values = [
  // B10: true and false are constants of type bool (6.4.4.5p3).
  ['sizeof(true) is sizeof(bool)', inMain('int result=sizeof(true);'), 1],
  ['bool constants promote in arithmetic', inMain('int result=sizeof(false+0)+true+true;'), 6],
  // B5: an integer constant takes the first type that can represent it (6.4.4.1p6).
  ['decimal beyond int is long', inMain('int result=sizeof(2147483648);'), 8],
  ['hexadecimal beyond int is unsigned int', inMain('int result=sizeof(0x80000000);'), 4],
  ['hexadecimal unsigned int compares unsigned', inMain('int result=-1<0xFFFFFFFF;'), 0],
  ['u suffix widens to unsigned long', inMain('int result=sizeof(4294967296U);'), 8],
  ['largest long literal', inMain('int result=9007199254740991L>0;'), 1],
  // B7: nullptr has its own pointer-sized type (6.4.4.5p4, 7.21.2).
  ['sizeof(nullptr)', inMain('int result=sizeof(nullptr);'), 8],
  ['nullptr initializes a pointer', inMain('int *p=nullptr;int result=p==NULL;'), 1],
  ['nullptr compares equal to itself', inMain('int result=nullptr==nullptr;'), 1],
  ['nullptr compares equal to 0', inMain('int result=nullptr==0;'), 1],
  ['nullptr compares with pointers', inMain('int x;int *p=&x;int result=p!=nullptr;'), 1],
  ['nullptr converts to false', inMain('bool b=nullptr;int result=b;'), 0],
  ['nullptr is a false condition', inMain('int result=1;if(nullptr){result=2;}'), 1],
  ['logical not of nullptr', inMain('int result=!nullptr;'), 1],
  ['free(nullptr) does nothing', inMain('free(nullptr);int result=1;'), 1],
  [
    'nullptr as a pointer argument and return value',
    inMain('int result=f(nullptr)==nullptr;', 'int *f(int *p){return nullptr;}'),
    1,
  ],
  // B3: a block-scope object hides a file-scope typedef of the same name (6.2.1p4).
  [
    'local variable hides a typedef in sizeof',
    inMain('int S=1;int result=sizeof(S);', 'typedef struct {long x;} S;'),
    4,
  ],
  [
    'parameter hides a typedef in sizeof',
    inMain('int result=f(1);', 'typedef struct {long x;} S;\nint f(int S){return sizeof(S);}'),
    4,
  ],
  [
    'the hidden typedef returns after the block',
    inMain('{int S=1;}int result=sizeof(S);', 'typedef struct {long x;} S;'),
    8,
  ],
  [
    'an object is in scope in its own initializer',
    inMain('int S=sizeof(S);int result=S;', 'typedef struct {long x;} S;'),
    4,
  ],
  [
    'for-loop declaration hides a typedef',
    inMain('int result=0;for(int S=0;S<1;S++){result=sizeof(S);}', 'typedef struct {long x;} S;'),
    4,
  ],
  // B9: 64-bit values are exact; beyond 2^53 they are stored as BigInt (6.2.5p11, 6.3.1.3p2).
  ['size_t decrement wraps', inMain('size_t n=0;n--;int result=n==18446744073709551615UL;'), 1],
  ['unsigned long from -1', inMain('unsigned long u=-1;unsigned long result=u;'), 2n ** 64n - 1n],
  ['long literal beyond 2^53', inMain('long result=9007199254740993L;'), 9007199254740993n],
  [
    'exact addition beyond 2^53',
    inMain('long a=9007199254740992L;long result=a+1;'),
    2n ** 53n + 1n,
  ],
  ['LONG_MIN', inMain('long result=-9223372036854775807L-1;'), -(2n ** 63n)],
  ['unsigned remainder', inMain('unsigned long u=18446744073709551615UL;int result=u%10;'), 5],
  [
    'unsigned division',
    inMain('unsigned long u=18446744073709551615UL;unsigned long result=u/3;'),
    6148914691236517205n,
  ],
  [
    'exact and ordinary values compare',
    inMain('long big=9007199254740993L;int result=big>5&&5<big;'),
    1,
  ],
  ['double to long beyond 2^53', inMain('double d=1e18;long result=d;'), 10n ** 18n],
  [
    'size_t countdown loop',
    inMain('int a[3];size_t n=3;int result=0;for(size_t i=n-1;i<n;i--){a[i]=1;result++;}'),
    3,
  ],
  // Phase 2. B1: a scalar initializer may be braced (6.7.10p12).
  ['braced null pointer', inMain('int *p={0};int result=p==NULL;'), 1],
  ['nested braced null pointer', inMain('int *a[1]={{NULL}};int result=a[0]==NULL;'), 1],
  // B2: the skipped operand of && is not evaluated in a constant expression (6.6p3).
  ['short-circuit null pointer constant', inMain('int *p=0&&(1/0);int result=p==NULL;'), 1],
  // L5: {} initializes like a static object (6.7.10p11).
  ['empty initializer for a scalar', inMain('int x={};int result=x+1;'), 1],
  ['empty initializer for a pointer', inMain('int *p={};int result=p==NULL;'), 1],
  ['empty initializer for an array', inMain('int a[3]={};int result=a[0]+a[2];'), 0],
  [
    'empty initializer for a struct',
    inMain('struct S s={};int result=s.y;', 'struct S{int x;int y;};'),
    0,
  ],
  // L4: only using the value of a function that fell off its end is undefined (6.9.1p12).
  ['unused missing return value', inMain('f();int result=1;', 'int f(void){}'), 1],
  // A2: the malloc argument converts to size_t.
  ['floating malloc size', inMain('char *p=malloc(1.0);*p=97;int result=*p;free(p);'), 97],
  // A1: malloc returns void * to an untyped block that takes its type from the conversion.
  ['malloc with a trailing byte', inMain('int *p=malloc(5);*p=7;int result=*p;free(p);'), 7],
  ['malloc(0) returns NULL here', inMain('int *p=malloc(0);int result=p==NULL;free(p);'), 1],
  ['discarded malloc result', inMain('malloc(4);int result=1;'), 1],
  ['malloc passed to free', inMain('free(malloc(4));int result=1;'), 1],
  ['malloc in a comparison', inMain('int result=malloc(4)!=NULL;'), 1],
  [
    'pointer to array from malloc',
    inMain('int (*p)[2]=malloc(sizeof(int[2]));(*p)[1]=9;int result=(*p)[1];free(p);'),
    9,
  ],
  [
    'void * keeps the block for later conversions',
    inMain('void *v=malloc(8);int *p=v;p[1]=5;int *q=v;int result=q[1];free(v);'),
    5,
  ],
  ['void * to a local and back', inMain('int x=6;void *v=&x;int *p=v;int result=*p;'), 6],
  ['void * equals the original pointer', inMain('int x;void *v=&x;int result=v==&x;'), 1],
  [
    'struct pointer through void *',
    inMain('struct S s={1,2};void *v=&s;struct S *p=v;int result=p->y;', 'struct S{int x;int y;};'),
    2,
  ],
  // A3: free accepts any pointer to the block's start, such as its first member.
  [
    'free through the first member',
    inMain(
      'struct S *p=malloc(sizeof(struct S));free(&p->x);int result=1;',
      'struct S{int x;int y;};',
    ),
    1,
  ],
  // L3: a struct that is never defined can still be pointed to.
  ['pointer to an undefined struct', inMain('struct Missing *p=0;int result=p==NULL;'), 1],
  ['size of a pointer to an undefined struct', inMain('int result=sizeof(struct Missing *);'), 8],
  // B4: a struct declared later may still be pointed to before its definition.
  [
    'pointer to a struct defined later',
    inMain('struct S *p=NULL;int result=p==NULL;', '', 'struct S{int x;};'),
    1,
  ],
];
for (const [name, source, expected] of values)
  test(name, () => assert.equal(result(source), expected));

const errors = [
  // Phase 2.
  ['object of type void', inMain('void x;'), INVALID],
  ['reading through void *', inMain('void *v=malloc(4);int n=*v;'), INVALID],
  ['incrementing a void *', inMain('void *v=malloc(4);v++;'), INVALID],
  ['ordering void * against int *', inMain('int x;void *v=&x;int n=v<&x;'), INVALID],
  ['object of an undefined struct', inMain('struct Missing m;'), INVALID],
  ['member of an undefined struct', inMain('struct Missing *p=0;int n=p->x;'), INVALID],
  ['empty initializer cannot size an array', inMain('int a[]={};'), INVALID],
  ['pointer argument to malloc', inMain('int x;void *v=malloc(&x);'), INVALID],
  ['block too small for its type', inMain('int *p=malloc(1);int n=*p;'), UNDEFINED],
  ['negative floating malloc size', inMain('void *v=malloc(-1.0);'), UNDEFINED],
  ['freeing an interior pointer', inMain('int *p=malloc(8);free(p+1);'), UNDEFINED],
  ['double free through void *', inMain('void *v=malloc(8);free(v);free(v);'), UNDEFINED],
  ['using a missing return value', inMain('int n=f();', 'int f(void){}'), UNDEFINED],
  [
    'reading an int through a char *',
    inMain('int x=1;void *v=&x;char *c=v;char y=*c;'),
    UNSUPPORTED,
  ],
  ['64-bit signed overflow', inMain('long x=9223372036854775807L;x++;'), UNDEFINED],
  ['subscript by a wrapped size_t', inMain('int a[2]={0};size_t i=0;i--;int n=a[i];'), UNDEFINED],
  // Predefined constants are not integer constants, so false is no null pointer constant.
  ['false is not a null pointer constant', inMain('int *p=false;'), INVALID],
  ['oversized decimal literal', inMain('long n=9223372036854775808;'), INVALID],
  ['oversized unsigned literal', inMain('unsigned long n=18446744073709551616UL;'), INVALID],
  ['oversized literal in malloc', inMain('char *p=malloc(18446744073709551617UL);'), INVALID],
  ['l suffix forbids unsigned int', inMain('long n=9223372036854775808L;'), INVALID],
  ['nullptr does not convert to int', inMain('int n=nullptr;'), INVALID],
  ['no arithmetic on nullptr', inMain('int n=nullptr+1;'), INVALID],
  ['no negation of nullptr', inMain('int n=-nullptr;'), INVALID],
  ['no ordering of nullptr', inMain('int x;int n=&x<nullptr;'), INVALID],
  ['nullptr_t objects are outside the subset', inMain('nullptr_t z=nullptr;'), UNSUPPORTED],
  [
    'sizeof a struct defined later',
    inMain('int n=sizeof(struct S);', '', 'struct S{int x;};'),
    INVALID,
  ],
  [
    'member access before the struct is defined',
    inMain('struct S *p=NULL;int n=sizeof(p->x);', '', 'struct S{int x;};'),
    INVALID,
  ],
  [
    'pointer arithmetic before the struct is defined',
    inMain('struct S *p=NULL;p=p+1;', '', 'struct S{int x;};'),
    INVALID,
  ],
  ['void pointer addition', inMain('int n=sizeof(malloc(4)+1);'), INVALID],
  ['void pointer subscript', inMain('int n=sizeof(malloc(4)[0]);'), INVALID],
  [
    'dangling pointer read from a returned struct',
    inMain(
      'int n=f().p==NULL;',
      'struct S{int *p;};\nstruct S f(void){int x;struct S s={&x};return s;}',
    ),
    UNDEFINED,
  ],
  [
    'typedef and function share a name',
    inMain('int n=S();', 'typedef struct {int x;} S;\nint S(void){return 1;}'),
    INVALID,
  ],
  [
    'a hidden typedef cannot name a type',
    inMain('int S=1;S t;', 'typedef struct {int x;} S;'),
    INVALID,
  ],
];
for (const [name, source, kind] of errors) test(name, () => assert.equal(kindOf(source), kind));

test('printf prints exact 64-bit values', () => {
  const source = inMain(
    'size_t n=0;n--;long m=-9223372036854775807L-1;printf("%zu %ld %lx", n, m, n);',
  );
  assert.equal(
    interpret(source).output,
    '18446744073709551615 -9223372036854775808 ffffffffffffffff',
  );
});

test('exact 64-bit values survive generated C and JSON', () => {
  const { state } = interpret(
    inMain('unsigned long u=0;u--;long m=-9223372036854775807L-1;long b=9007199254740993L;'),
  );
  const code = generate(state);
  assert.match(code, /18446744073709551615UL/);
  assert.match(code, /\(-9223372036854775807L - 1\)/);
  const values = s => s.allocations.filter(a => a.alive).map(a => a.value.value);
  assert.deepEqual(values(interpret(code).state), values(state));
  assert.deepEqual(values(fromJSON(toJSON(state))), values(state));
});

test('printf %p accepts nullptr (C23 7.16.1.1p2)', () => {
  assert.equal(interpret(inMain('printf("%p", nullptr);')).output, '(nil)');
});
