/**
 * Full integration suite using real Tree-sitter parsing.
 * Verifies C → MemoryState → generated C → MemoryState round-trip equivalence.
 */
// Integration tests: real Tree-sitter parse → Mini-C AST → semantic machine → codegen → parse again.
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import { generate } from '../src/pipeline/codegen.js';
import { equivalent } from '../src/pipeline/equivalence.js';

const programs = [
  'int main() { int a = 10; int *b = &a; }',
  'int main() { int x = 1; int y = 2; int *p = &x; p = &y; *p = 99; }',
  'int main() { int a = 5; int *p = &a; int **pp = &p; **pp = 6; }',
  'int main() { int *p = malloc(sizeof(int)); *p = 42; int *q = p; }',
  'int main() { int *p = NULL; int *q; int v = 3; q = &v; }',
  'int main() { int **h = malloc(sizeof(int *)); *h = malloc(sizeof(int)); **h = 7; }',
  'int main() { int *p = malloc(sizeof(int)); int *q = p; free(p); }',
  'int main() { int arr[3] = {1, 2, 3}; int *p = &arr[1]; }',
  'int main() { int arr[3] = {1, 2, 3}; int *p = arr; p++; }',
  'int main() { int *p = malloc(3 * sizeof(int)); p[0] = 4; p[1] = 5; p[2] = 6; }',
  'int main() { int *p = NULL; free(p); }',
  'struct Node { int value; struct Node *next; }; int main(void) { struct Node a = {1, NULL}; struct Node b = {2, &a}; return 0; }',
  'int main(void) { int x = 0; if (2 < 3) { x = 7; } else { x = 9; } return 0; }',
  'int main(void) { int i = 0; int sum = 0; while (i < 4) { sum += i; i++; } return 0; }',
  'int main(void) { int i = 0; int sum = 0; for (i = 0; i < 4; i++) { sum += i; } return 0; }',
];

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

let fail = 0;
for (const source of programs) {
  try {
    const before = interpret(source).state;
    const generated = generate(before);
    const after = interpret(generated).state;
    const result = equivalent(before, after);
    console.log(`${result.equal ? 'PASS' : 'FAIL'}  ${source.slice(0, 76)}`);
    if (!result.equal) {
      console.log('      ' + result.diffs.join('; '));
      console.log(generated);
      fail++;
    }
  } catch (e) {
    console.log(`ERROR ${e.message}  ${source.slice(0, 70)}`);
    fail++;
  }
}


// Function integration is execution-only because a final call-stack trace does not
// contain enough source information to synthesize the original function bodies.
try {
  const result = interpret('void set_value(int *p) { *p = 25; } int main(void) { int value = 10; set_value(&value); return 0; }');
  const value = result.state.allocations.find(a => a.name === 'value');
  const fnFrame = result.state.frames.find(f => f.name === 'set_value');
  const ok = value?.value?.value === 25 && fnFrame && !fnFrame.active && result.snapshots.some(s => s.function === 'set_value');
  console.log(`${ok ? 'PASS' : 'FAIL'}  user function parsing, call frame, and pointer side effect`);
  if (!ok) fail++;
} catch (e) { console.log(`ERROR function integration: ${e.message}`); fail++; }

try {
  const result = interpret(`int main(void) {
    int sum = 0;
    for (int i = 0; i < 8; i++) {
      if (i == 2) continue;
      if (i == 5) break;
      sum += i;
    }
    return 0;
  }`);
  const sum = result.state.allocations.find(a => a.name === 'sum');
  const loopI = result.state.allocations.find(a => a.name === 'i');
  const ok = sum?.value?.value === 8 && loopI && !loopI.alive && result.snapshots.some(s => s.statement === 'ForUpdate');
  console.log(`${ok ? 'PASS' : 'FAIL'}  parsed for/if/break/continue semantics`);
  if (!ok) fail++;
} catch (e) { console.log(`ERROR control-flow integration: ${e.message}`); fail++; }

try {
  const result = interpret(`int main(void) {
    int *p = NULL;
    int x = 0;
    if (p && *p) x = 1;
    if (!p || *p) x = 2;
    return 0;
  }`);
  const x = result.state.allocations.find(a => a.name === 'x');
  const ok = x?.value?.value === 2;
  console.log(`${ok ? 'PASS' : 'FAIL'}  logical conditions short-circuit during parsed execution`);
  if (!ok) fail++;
} catch (e) { console.log(`ERROR logical integration: ${e.message}`); fail++; }

try {
  interpret(`int main(void) { while (1) { } return 0; }`);
  console.log('FAIL  loop iteration safety limit'); fail++;
} catch (e) {
  const ok = /loop exceeded 256 iterations/.test(e.message);
  console.log(`${ok ? 'PASS' : 'FAIL'}  loop iteration safety limit`);
  if (!ok) fail++;
}

try {
  interpret(`int main(void) { int a[65]; return 0; }`);
  console.log('FAIL  array safety limit'); fail++;
} catch (e) {
  const ok = /between 1 and 64/.test(e.message);
  console.log(`${ok ? 'PASS' : 'FAIL'}  array safety limit`);
  if (!ok) fail++;
}

// Grading must reject wrong target relationships, not merely wrong source text.
try {
  const target = interpret('int main(){ int a = 10; int *b = &a; }').state;
  const wrong = interpret('int main(){ int a = 10; int c = 4; int *b = &c; }').state;
  const result = equivalent(target, wrong);
  console.log(`${!result.equal && result.diffs.length ? 'PASS' : 'FAIL'}  grading rejects wrong pointer graph`);
  if (result.equal) fail++;
} catch (e) { console.log(`ERROR grading sanity: ${e.message}`); fail++; }

process.exitCode = fail ? 1 : 0;
