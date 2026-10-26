/** The Start here tutorial's claims about the supported C stay true as the interpreter changes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initParser, interpret } from '../src/pipeline/interpreter.js';
import {
  diagnosticKind,
  INTERNAL,
  UNSUPPORTED as NOT_SUPPORTED,
} from '../src/language/diagnostics.js';
import {
  ALSO_UNSUPPORTED,
  EXAMPLES,
  SUPPORTED,
  UNSUPPORTED,
} from '../src/data/tutorialExamples.js';

await initParser({
  runtimeWasm: './node_modules/web-tree-sitter/tree-sitter.wasm',
  grammarWasm: './public/tree-sitter-c.wasm',
});

const rejection = code => {
  try {
    interpret(code);
  } catch (e) {
    return e;
  }
  return null;
};

test('every Try it example runs, except the bug, which stops partway with playback', () => {
  for (const example of EXAMPLES) {
    const error = rejection(example.code);
    if (!example.fails) {
      assert.equal(error, null, `${example.id}: ${error?.message}`);
      assert.ok(interpret(example.code).snapshots.length > 1, example.id);
      continue;
    }
    // A program that does not compile would open no playback for the student to step back in.
    assert.ok(error?.playback?.snapshots.length > 1, `${example.id} should fail at run time`);
    assert.notEqual(diagnosticKind(error), INTERNAL, error.message);
  }
});

test('every feature listed as working runs', () => {
  for (const { label, code } of SUPPORTED) {
    const error = rejection(code);
    assert.equal(error, null, `${label}: ${error?.message}`);
  }
});

// Each is valid C, so the reason must be the subset, not a mistake in the sample.
test('every feature listed as not working is reported as not supported', () => {
  for (const { label, code } of [...UNSUPPORTED, ...ALSO_UNSUPPORTED]) {
    const error = rejection(code);
    assert.ok(error, `${label} now runs: remove it from the tutorial's not-supported list`);
    assert.equal(diagnosticKind(error), NOT_SUPPORTED, `${label}: ${error.message}`);
  }
});
