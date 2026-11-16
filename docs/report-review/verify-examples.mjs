/** Report-audit examples; run from the repository root with node docs/report-review/verify-examples.mjs. */
import console from 'node:console';
import process from 'node:process';
import { initParser, interpret } from '../../src/pipeline/interpreter.js';
import { generate } from '../../src/pipeline/codegen.js';
import { equivalent } from '../../src/pipeline/equivalence.js';
import { diagnosticKind } from '../../src/language/diagnostics.js';
import { seedLevels } from '../../src/data/levels.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});
const examples = [
  ['reported array example', 'int main(void){int a[3];a[4]=5;}', 'undefined'],
  ['one-past formation', 'int main(void){int a[3];int *p=a+3;}', 'accept'],
  ['one-past access', 'int main(void){int a[3];int *p=a+3;*p=5;}', 'undefined'],
  ['equality of separate objects', 'int main(void){int x=1;int y=2;int result=&x==&y;}', 'accept'],
  [
    'ordering of separate objects',
    'int main(void){int x=1;int y=2;int result=&x<&y;}',
    'undefined',
  ],
  [
    'subtraction of separate objects',
    'int main(void){int x=1;int y=2;long result=&x-&y;}',
    'undefined',
  ],
  [
    'ordering struct members',
    'struct S{int a;int b;};int main(void){struct S s={1,2};int result=&s.a<&s.b;}',
    'accept',
  ],
  ['uninitialised scalar read', 'int main(void){int x;int y=x;}', 'undefined'],
  ['signed arithmetic overflow', 'int main(void){int x=2147483647;x=x+1;}', 'undefined'],
  ['unsigned arithmetic wraps', 'int main(void){unsigned int x=4294967295U;x=x+1;}', 'accept'],
  ['C23 bool keyword', 'int main(void){bool b=true;}', 'accept'],
  ['cast outside subset', 'int main(void){int x=(int)1.0;}', 'unsupported'],
];
let failures = 0;
for (const [name, code, expected] of examples) {
  let actual = 'accept';
  let message = null;
  try {
    interpret(code);
  } catch (error) {
    actual = diagnosticKind(error);
    message = error.message;
  }
  const matches = actual === expected;
  if (!matches) failures++;
  console.log(JSON.stringify({ name, code, expected, actual, matches, message }));
}
const original = interpret('int main(void){int x=5;int *p=&x;int *q=&x;}').state;
const generated = generate(original);
const roundTrip = equivalent(original, interpret(generated).state).equal;
if (!roundTrip) failures++;
console.log(
  JSON.stringify({ name: 'generated aliasing example round trip', generated, matches: roundTrip }),
);
console.log(
  JSON.stringify({
    summary: { examples: examples.length + 1, failures, builtInChallenges: seedLevels.length },
  }),
);
process.exitCode = failures ? 1 : 0;
