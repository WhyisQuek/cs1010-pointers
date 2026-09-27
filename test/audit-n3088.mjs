/** Manual audit probes, deliberately separate from the passing regression suite.
 * Run from the repository root: node test/audit-n3088.mjs
 * Add --native to cross-check C11-compatible probes with a native LP64 compiler.
 * Set POINTERVIZ_WSL_DISTRO on Windows, as for test/native-c.test.js.
 * This prints discrepancies; successful execution is NOT a conformance pass.
 */
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const cases = [];
function probe(id, body, expected, { before = '', after = '', standard = 'c11', native = true } = {}) {
  cases.push({ id, body, before, after, expected, standard, native });
}
const accept = { accepts: true };
const reject = { accepts: false };
const value = result => ({ accepts: true, result });

probe('A1-malloc-one-byte', 'int *p=malloc(1);free(p);', accept);
probe('A1-malloc-trailing-byte', 'int *p=malloc(5);if(p){*p=7;}free(p);', accept);
probe('A1-malloc-zero', 'int *p=malloc(0);free(p);', accept);
probe('A1-malloc-discarded', 'malloc(4);', accept);
probe('A1-malloc-nested-free', 'free(malloc(4));', accept);
probe('A1-malloc-array-pointer', 'int (*p)[2]=malloc(sizeof(int[2]));free(p);', accept);
probe('A1-malloc-comparison', 'int result=malloc(4)!=NULL;', accept);
probe('A2-malloc-floating-argument', 'char *p=malloc(1.0);free(p);', accept);
probe('A3-free-first-member', 'struct S *p=malloc(sizeof(struct S));if(p){free(&p->x);}', accept, { before:'struct S{int x;};' });
probe('B1-braced-null', 'int *p={0};int result=p==NULL;', value(1));
probe('B1-braced-NULL', 'int *p={NULL};int result=p==NULL;', value(1));
probe('B1-braced-array-null', 'int *a[1]={{0}};int result=a[0]==NULL;', value(1));
probe('B2-short-circuit-constant', 'int *p=0 && (1/0);int result=p==NULL;', value(1));
probe('B2-short-circuit-overflow', 'int *p=0 && (2147483647+1);int result=p==NULL;', value(1));
probe('B3-shadowed-typedef-sizeof', 'int S=1;int result=sizeof(S);', value(4), { before:'typedef struct {long x;} S;' });
probe('B3-typedef-function-collision', 'int result=S();', reject, { before:'typedef struct {int x;} S;int S(void){return 1;}' });
probe('B3-independent-tag-namespace', 'S s={1};struct S t={2};int result=sizeof(s)+sizeof(t);', value(12), { before:'typedef struct {int x;} S;struct S{long y;};' });
probe('B4-incomplete-sizeof', 'int result=sizeof(struct S);', reject, { after:'struct S{int x;};' });
probe('B4-incomplete-member-sizeof', 'struct S *p=NULL;int result=sizeof(p->x);', reject, { after:'struct S{int x;};' });
probe('B5-oversized-unsigned-literal', 'unsigned long result=18446744073709551616UL;', reject);
probe('B5-wrapped-allocation-literal', 'char *p=malloc(18446744073709551617UL);free(p);', reject);
probe('B6-void-pointer-addition', 'int result=sizeof(malloc(4)+1);', reject);
probe('B7-nullptr-integer', 'int result=nullptr;', reject, { standard:'c23' });
probe('B7-nullptr-sizeof', 'int result=sizeof(nullptr);', value(8), { standard:'c23' });
probe('B7-nullptr-arithmetic', 'int result=nullptr+1;', reject, { standard:'c23' });
probe('B8-dangling-temporary-member', 'int result=f().p==NULL;', reject, { before:'struct S{int *p;};struct S f(void){int x;struct S s={&x};return s;}', native:false });
probe('L1-array-constant-expression', 'int a[1+2];int result=sizeof(a);', value(12));
probe('L1-unsized-array-parameter', 'int a[2]={1,2};int result=f(a);', value(2), { before:'int f(int a[]){return a[1];}' });
probe('L2-long-int-spelling', 'long int result=1;', value(1));
probe('L2-short-int-spelling', 'short int result=1;', value(1));
probe('L2-signed-int-spelling', 'signed int result=1;', value(1));
probe('L2-unsigned-spelling', 'unsigned result=1;', value(1));
probe('L3-opaque-struct-pointer', 'struct Missing *p=0;int result=p==NULL;', value(1));
probe('L3-void-pointer', 'void *p=malloc(4);free(p);', accept);
probe('L4-unused-missing-return', 'f();int result=1;', value(1), { before:'int f(void){}' });
probe('L5-C23-empty-initializer', 'int a[2]={};int result=a[0];', value(0), { standard:'c23' });
probe('L5-C23-bool', 'bool b=true;int result=b;', value(1), { standard:'c23' });
probe('L5-C23-binary', 'int result=0b101;', value(5), { standard:'c23' });
probe('L5-C23-digit-separator', "int result=1'000;", value(1000), { standard:'c23' });
probe('L6-exact-long-range', 'long result=9007199254740993L;', accept, { native:false });
probe('L6-array-limit', 'int a[65];int result=sizeof(a);', value(260));

// Controls distinguish actual regressions from omissions and working diagnostics.
probe('control-normal-allocation', 'int *p=malloc(sizeof(int));if(p){*p=7;}free(p);', accept);
probe('control-null-initialization', 'int *p=0;int result=p==NULL;', value(1));
probe('control-one-past', 'int a[2];int *p=&a[2];int result=p-a;', value(2));
probe('control-address-cancellation', 'int *p=0;int *q=&*p;int result=q==NULL;', value(1));
probe('control-unsigned-wrap', 'unsigned int result=0U-1U;', value(4294967295));
probe('control-runtime-short-circuit', 'int result=0 && (1/0);', value(0));
probe('control-free-null', 'free(NULL);', accept);
probe('control-unsequenced-UB', 'int i=0;int result=i++ + i;', reject, { native:false });
probe('control-out-of-bounds-UB', 'int a[2]={0};int result=a[2];', reject, { native:false });
probe('control-dead-branch-constraint', 'if(0){int *p=3;}', reject);

function source(c, native = false) {
  const check = native && Object.hasOwn(c.expected, 'result') ? `assert(result==${c.expected.result});` : '';
  return `#include <stdlib.h>\n${native ? '#include <assert.h>\n#include <limits.h>\n_Static_assert(sizeof(long)==8 && sizeof(void*)==8 && CHAR_MIN==-128,"LP64 signed char required");\n' : ''}${c.before}\nint main(void){${c.body}${check}return 0;}\n${c.after}\n`;
}

await initParser({ runtimeWasm:'./node_modules/web-tree-sitter/tree-sitter.wasm', grammarWasm:'./public/tree-sitter-c.wasm' });
let discrepancies = 0;
for (const c of cases) {
  let actual;
  try {
    const {state} = interpret(source(c));
    const result = state.allocations.find(a => a.name==='result' && a.storage.frameId==='main')?.value;
    actual = { accepts:true, ...(result?.kind==='scalar' ? {result:result.value} : {}) };
  } catch (error) { actual = { accepts:false, diagnostic:error.message }; }
  const matches = actual.accepts===c.expected.accepts && (!Object.hasOwn(c.expected,'result') || actual.result===c.expected.result);
  if (!matches) discrepancies++;
  console.log(JSON.stringify({id:c.id, expected:c.expected, actual, matches}));
}
console.log(JSON.stringify({summary:{probes:cases.length, discrepancies, matches:cases.length-discrepancies}}));

if (process.argv.includes('--native')) {
  // Native compilers check only C11-compatible probes; C23 expectations come from N3088.
  const distro = process.env.POINTERVIZ_WSL_DISTRO;
  const compiler = process.env.POINTERVIZ_CC ?? 'cc';
  const command = (exe,args) => distro
    ? spawnSync('wsl',['-d',distro,'--',exe,...args],{encoding:'utf8',timeout:30000})
    : spawnSync(exe,args,{encoding:'utf8',timeout:30000});
  assert.equal(command(compiler,['--version']).status,0,'native compiler unavailable');
  const scratch=mkdtempSync(path.join(process.cwd(),'.n3088-native-'));
  const relative = name => path.relative(process.cwd(),path.join(scratch,name)).split(path.sep).join('/');
  let checked=0;
  try {
    for (const c of cases.filter(c=>c.standard==='c11' && c.native)) {
      writeFileSync(path.join(scratch,'probe.c'),source(c,true));
      const output=relative(process.platform==='win32'&&!distro?'probe.exe':'probe');
      // Separate strict constraints from instrumentation: GCC 9's UBSan changes
      // null-constant classification for unevaluated division/overflow operands.
      const syntax=command(compiler,['-std=c11','-pedantic-errors','-fsyntax-only',relative('probe.c')]);
      if (c.expected.accepts) {
        assert.equal(syntax.status,0,`${c.id}: ${syntax.stderr || syntax.error}`);
        const flags=['-std=c11','-O0','-fsanitize=undefined','-fno-sanitize-recover=undefined'];
        const built=command(compiler,[...flags,relative('probe.c'),'-o',output]);
        assert.equal(built.status,0,`${c.id}: ${built.stderr || built.error}`);
        const run=command(`./${output}`,[]);
        assert.equal(run.status,0,`${c.id}: ${run.stderr || run.error}`);
      } else assert.notEqual(syntax.status,0,`${c.id}: expected a strict compiler diagnostic`);
      checked++;
    }
    console.log(JSON.stringify({native:{checked,standard:'c11',c23Checked:false}}));
  } finally {
    assert.equal(path.dirname(scratch),process.cwd());
    rmSync(scratch,{recursive:true,force:true});
  }
}
