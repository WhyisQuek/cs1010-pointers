/** Browser-facing forward pipeline. Syntax and semantics are deliberately separate. */
import { initCParser, parseMiniC } from '../language/parser.js';
import { executeProgram } from '../machine/interpreter.js';

export const initParser = initCParser;
export { executeProgram };

export function interpret(source) {
  return executeProgram(parseMiniC(source));
}
