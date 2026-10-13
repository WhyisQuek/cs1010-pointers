/** Expressions -> Mini-C AST. */
import { INVALID, diagnosticKind } from '../diagnostics.js';
import { decodeStringLiteral } from '../literals.js';
import { primitive } from '../types.js';
import { parseAbstractDeclarator, parseBaseType } from './declarations.js';
import { parseNumberLiteral } from './numberLiterals.js';
import {
  hidesTypedef,
  invalidAt,
  isDeclaratorLike,
  operatorOf,
  operatorToken,
  semanticChildren,
  unsupported,
  withLoc,
} from './syntaxTree.js';

export function parseExpression(node, structTypes) {
  switch (node.type) {
    case 'number_literal':
      return withLoc(
        /^[+-]/.test(node.text)
          ? {
              kind: 'Unary',
              operator: node.text[0],
              expression: withLoc(parseNumberLiteral(node.text.slice(1)), node),
            }
          : parseNumberLiteral(node.text),
        node,
      );
    case 'char_literal':
      return withLoc({ kind: 'CharLiteral', raw: node.text }, node);
    case 'string_literal':
    case 'concatenated_string': {
      // Adjacent literals concatenate (C 5.1.1.2 phase 6); macros such as PRId64 are not expanded.
      const parts = node.type === 'string_literal' ? [node] : semanticChildren(node);
      if (parts.some(p => p.type !== 'string_literal'))
        throw unsupported(node, 'only adjacent string literals can be concatenated');
      try {
        return withLoc(
          { kind: 'StringLiteral', value: parts.flatMap(p => decodeStringLiteral(p.text)) },
          node,
        );
      } catch (e) {
        throw diagnosticKind(e) === INVALID
          ? invalidAt(node, e.message)
          : unsupported(node, e.message);
      }
    }
    case 'identifier':
      return withLoc({ kind: 'Identifier', name: node.text }, node);
    case 'null':
      // Tree-sitter's `null` covers both NULL (the integer constant 0 here) and C23 nullptr.
      return withLoc({ kind: 'NullLiteral', nullptr: node.text === 'nullptr' }, node);
    case 'true':
    case 'false':
      // C23 6.4.4.5p3: constants of type bool; they promote to int in arithmetic.
      if (node.text !== node.type) throw unsupported(node);
      return withLoc(
        {
          kind: 'IntLiteral',
          type: primitive('bool'),
          value: node.type === 'true' ? 1 : 0,
          raw: node.text,
        },
        node,
      );
    case 'pointer_expression':
    case 'unary_expression': {
      const op = operatorOf(node);
      const arg = node.childForFieldName('argument') ?? node.namedChildren.at(-1);
      if (op === '&')
        return withLoc({ kind: 'AddressOf', expression: parseExpression(arg, structTypes) }, node);
      if (op === '*')
        return withLoc(
          { kind: 'Dereference', expression: parseExpression(arg, structTypes) },
          node,
        );
      if (op === '+' || op === '-' || op === '!')
        return withLoc(
          { kind: 'Unary', operator: op, expression: parseExpression(arg, structTypes) },
          node,
        );
      throw unsupported(node);
    }
    case 'parenthesized_expression':
      return parseExpression(semanticChildren(node)[0], structTypes);
    case 'assignment_expression':
      return withLoc(
        {
          kind: 'Assignment',
          operator: node.childForFieldName('operator')?.text ?? '=',
          left: parseExpression(node.childForFieldName('left'), structTypes),
          right: parseExpression(node.childForFieldName('right'), structTypes),
        },
        node,
      );
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier')
        throw unsupported(node, 'only direct function calls are supported');
      const args = semanticChildren(node.childForFieldName('arguments')).map(n =>
        parseExpression(n, structTypes),
      );
      return withLoc({ kind: 'Call', name: fn.text, arguments: args }, node);
    }
    case 'subscript_expression':
      return withLoc(
        {
          kind: 'Subscript',
          array: parseExpression(
            node.childForFieldName('argument') ?? semanticChildren(node)[0],
            structTypes,
          ),
          index: parseExpression(
            node.childForFieldName('index') ?? node.namedChildren[1],
            structTypes,
          ),
        },
        node,
      );
    case 'field_expression': {
      const argument = node.childForFieldName('argument') ?? semanticChildren(node)[0];
      const field = node.childForFieldName('field') ?? node.namedChildren.at(-1);
      const op = operatorToken(node);
      return withLoc(
        {
          kind: 'Member',
          object: parseExpression(argument, structTypes),
          field: field.text,
          viaPointer: op.includes('->'),
        },
        node,
      );
    }
    case 'binary_expression':
      return withLoc(
        {
          kind: 'Binary',
          operator: node.childForFieldName('operator')?.text ?? operatorToken(node),
          left: parseExpression(
            node.childForFieldName('left') ?? semanticChildren(node)[0],
            structTypes,
          ),
          right: parseExpression(
            node.childForFieldName('right') ?? node.namedChildren[1],
            structTypes,
          ),
        },
        node,
      );
    case 'update_expression': {
      const arg = node.childForFieldName('argument') ?? semanticChildren(node)[0];
      const op = operatorOf(node) || (node.text.includes('++') ? '++' : '--');
      const trimmed = node.text.trimStart();
      return withLoc(
        {
          kind: 'Update',
          operator: op,
          expression: parseExpression(arg, structTypes),
          prefix: trimmed.startsWith('++') || trimmed.startsWith('--'),
        },
        node,
      );
    }
    case 'sizeof_expression': {
      const typeDesc = node.namedChildren.find(c => c.type === 'type_descriptor');
      if (typeDesc) {
        const baseNode = typeDesc.childForFieldName('type') ?? semanticChildren(typeDesc)[0];
        const ambiguousCall = typeDesc.childForFieldName('declarator');
        if (
          baseNode.type === 'type_identifier' &&
          !structTypes.aliases?.has(baseNode.text) &&
          ambiguousCall?.type === 'abstract_function_declarator' &&
          !ambiguousCall.childForFieldName('parameters')?.namedChildren.length
        ) {
          return withLoc(
            {
              kind: 'SizeofExpression',
              expression: withLoc({ kind: 'Call', name: baseNode.text, arguments: [] }, typeDesc),
            },
            node,
          );
        }
        // sizeof(S) names a local object when one hides the typedef S.
        if (
          baseNode.type === 'type_identifier' &&
          !typeDesc.childForFieldName('declarator') &&
          hidesTypedef(baseNode, baseNode.text)
        )
          return withLoc(
            {
              kind: 'SizeofExpression',
              expression: withLoc({ kind: 'Identifier', name: baseNode.text }, baseNode),
            },
            node,
          );
        let t = parseBaseType(baseNode, structTypes);
        const declarator =
          typeDesc.childForFieldName('declarator') ??
          typeDesc.namedChildren.find(c => isDeclaratorLike(c));
        if (declarator) t = parseAbstractDeclarator(declarator, t, structTypes);
        return withLoc({ kind: 'SizeofType', type: t }, node);
      }
      const expr = semanticChildren(node).find(c => c.type !== 'type_descriptor');
      if (!expr) throw unsupported(node);
      let name = expr;
      while (name.type === 'parenthesized_expression') name = semanticChildren(name)[0];
      // Tree-sitter reads the `_Bool` keyword as an identifier inside sizeof(...).
      if (name.type === 'identifier' && name.text === '_Bool')
        return withLoc({ kind: 'SizeofType', type: primitive('bool') }, node);
      if (
        name.type === 'identifier' &&
        structTypes.aliases?.has(name.text) &&
        !hidesTypedef(name, name.text)
      ) {
        if (name.startIndex < structTypes.aliasPositions.get(name.text))
          throw invalidAt(name, `typedef '${name.text}' is not declared yet`);
        const def = structTypes[structTypes.aliases.get(name.text)];
        return withLoc({ kind: 'SizeofType', type: { ...def, alias: name.text } }, node);
      }
      return withLoc(
        { kind: 'SizeofExpression', expression: parseExpression(expr, structTypes) },
        node,
      );
    }
    case 'initializer_list':
      return withLoc(
        {
          kind: 'InitializerList',
          elements: semanticChildren(node).map(n => parseExpression(n, structTypes)),
        },
        node,
      );
    default:
      throw unsupported(node);
  }
}
