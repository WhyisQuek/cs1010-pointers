/**
 * Tree-sitter C -> PointerViz Mini-C AST adapter: the public entry point.
 *
 * Tree-sitter remains syntax-only. This module normalizes supported C into the
 * small AST consumed by the semantic interpreter. Struct tags are resolved in
 * a two-pass parse so self-referential declarations are supported.
 *
 * The implementation lives in ./parse/, one module per concern:
 *   structs.js        two-pass struct tag and typedef collection
 *   statements.js     function definitions and statements
 *   declarations.js   base types, declarators and declarations
 *   expressions.js    expressions
 *   numberLiterals.js integer and floating literals with C typing rules
 *   syntaxTree.js     Tree-sitter node helpers, source locations and errors
 *
 * No module outside ./parse/ and this file may depend on Tree-sitter node names.
 */
import { Language, Parser } from 'web-tree-sitter';
import { parseFunction } from './parse/statements.js';
import { collectStructs } from './parse/structs.js';
import {
  firstError,
  isDeclaratorLike,
  syntaxError,
  unsupported,
  walkNodes,
} from './parse/syntaxTree.js';

let C = null;

/**
 * Load both WASM files once. Paths are required: root-relative defaults break
 * when the app is deployed below a subpath such as a GitHub Pages project site.
 */
export async function initCParser({ runtimeWasm, grammarWasm } = {}) {
  if (C) return;
  if (!runtimeWasm || !grammarWasm)
    throw new Error('initCParser requires runtimeWasm and grammarWasm paths');
  await Parser.init({ locateFile: () => runtimeWasm });
  C = await Language.load(grammarWasm);
}

export function parseMiniC(source) {
  if (!C) throw new Error('parser not initialized');
  const parser = new Parser();
  parser.setLanguage(C);
  const tree = parser.parse(source);
  try {
    if (tree.rootNode.hasError) throw syntaxError(firstError(tree.rootNode));

    // Never erase syntax whose semantics the machine does not implement.
    for (const node of walkNodes(tree.rootNode)) {
      if (
        [
          'type_qualifier',
          'bitfield_clause',
          'variadic_parameter',
          'storage_class_specifier',
        ].includes(node.type) &&
        node.text !== 'typedef'
      ) {
        throw unsupported(
          node,
          'qualifiers, storage classes, bitfields and variadic functions are not supported',
        );
      }
      if (
        node.type.startsWith('preproc_') &&
        !['preproc_include', 'preproc_arg', 'preproc_directive'].includes(node.type)
      ) {
        throw unsupported(node, 'preprocessing is not supported');
      }
    }

    const structTypes = collectStructs(tree.rootNode);
    const functions = [];
    for (const node of tree.rootNode.namedChildren) {
      if (node.type === 'function_definition') functions.push(parseFunction(node, structTypes));
      else if (
        !['comment', 'preproc_include', 'type_definition', 'struct_specifier'].includes(node.type)
      ) {
        const type = node.childForFieldName('type');
        const declarators = node.namedChildren.filter(isDeclaratorLike);
        // Only a standalone struct declaration may sit beside function definitions.
        if (
          node.type !== 'declaration' ||
          declarators.length ||
          type?.type !== 'struct_specifier'
        ) {
          throw unsupported(node, 'global variables and function prototypes are not supported');
        }
      }
    }
    // Duplicate functions and a missing main() are semantic rules, checked by the checker.
    return {
      kind: 'Program',
      structs: Object.values(structTypes),
      functions,
      source,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}
