/** Differential check against a real LP64 C compiler; runs in Linux CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { values, programs } from './c-semantics-fixtures.js';
import { initParser, interpret } from '../src/pipeline/interpreter.js';

const distro = process.env.POINTERVIZ_WSL_DISTRO;
const compiler = process.env.POINTERVIZ_CC ?? 'cc';
const command = (exe, args) => distro
  ? spawnSync('wsl', ['-d', distro, '--', exe, ...args], { encoding: 'utf8', timeout: 60000 })
  : spawnSync(exe, args, { encoding: 'utf8', timeout: 60000 });
const available = command(compiler, ['--version']).status === 0;
test('defined programs match a native LP64 C11 compiler with undefined-behavior sanitizer', {
  skip: !available && !process.env.POINTERVIZ_REQUIRE_NATIVE ? 'LP64 C compiler unavailable; set POINTERVIZ_CC or POINTERVIZ_WSL_DISTRO' : false,
}, async () => {
  assert.ok(available, 'native C compiler is required but unavailable');
  await initParser({ runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm', grammarWasm: './public/tree-sitter-c.wasm' });
  const cases = [
    ...values.map(([name, body, expected]) => [name, `int main(void) { ${body} }`, expected]),
    ...programs,
  ];
  const scratch = mkdtempSync(path.join(process.cwd(), '.native-c-'));
  const relative = name => path.relative(process.cwd(), path.join(scratch, name)).split(path.sep).join('/');
  try {
    const files = cases.map(([, source], i) => {
      const end = source.lastIndexOf('}');
      const observed = source.slice(0, end) + `printf("${i} %.17g\\n", (double)result); return 0;` + source.slice(end);
      writeFileSync(path.join(scratch, `case${i}.c`), `#include <stdio.h>\n#include <stdlib.h>\n#include <limits.h>\n_Static_assert(sizeof(long)==8 && sizeof(void*)==8 && CHAR_MIN==-128, "requires LP64 signed-char model");\n#define main case${i}\n#define f helper${i}\n${observed}\n`);
      return relative(`case${i}.c`);
    });
    writeFileSync(path.join(scratch, 'runner.c'), cases.map((_, i) => `int case${i}(void);`).join('\n') + `\nint main(void){${cases.map((_, i) => `case${i}();`).join('')}return 0;}\n`);
    const output = relative(process.platform === 'win32' && !distro ? 'reference.exe' : 'reference');
    const built = command(compiler, ['-std=c11', '-O0', '-fsanitize=undefined', '-fno-sanitize-recover=undefined', ...files, relative('runner.c'), '-o', output]);
    assert.equal(built.status, 0, built.stderr || String(built.error));
    const executed = command(`./${output}`, []);
    assert.equal(executed.status, 0, executed.stderr || String(executed.error));
    const lines = executed.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, cases.length);
    cases.forEach(([name, source, expected], i) => {
      const [index, actual] = lines[i].split(' ').map(Number);
      assert.equal(index, i);
      assert.equal(actual, expected, `native expectation: ${name}`);
      const state = interpret(source).state;
      const value = state.allocations.find(a => a.name === 'result' && a.storage.frameId === 'main').value.value;
      assert.equal(value, actual, `interpreter/native difference: ${name}`);
    });
  } finally {
    // mkdtemp creates a checked, dedicated child of this workspace.
    assert.equal(path.dirname(scratch), process.cwd());
    rmSync(scratch, { recursive: true, force: true });
  }
});
