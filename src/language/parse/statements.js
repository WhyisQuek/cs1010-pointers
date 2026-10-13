/** Function definitions and statements -> Mini-C AST. */
import { pointer } from '../types.js';
import {
  parseBaseType,
  parseDeclaration,
  parseDeclarator,
  referenceSafeType,
  requireCompleteAt,
} from './declarations.js';
import { parseExpression } from './expressions.js';
import {
  isDeclaratorLike,
  locOf,
  semanticChildren,
  structBody,
  unsupported,
  withLoc,
} from './syntaxTree.js';

export function parseFunction(node, structTypes) {
  const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
  let returnType = parseBaseType(typeNode, structTypes);
  let declarator = node.childForFieldName('declarator');
  // Return-type stars wrap the function declarator in Tree-sitter's C tree.
  while (
    declarator?.type === 'pointer_declarator' ||
    declarator?.type === 'parenthesized_declarator'
  ) {
    if (declarator.type === 'pointer_declarator') {
      returnType = pointer(referenceSafeType(returnType));
      declarator = declarator.childForFieldName('declarator');
    } else {
      declarator = semanticChildren(declarator)[0];
    }
  }
  if (declarator?.type !== 'function_declarator')
    throw unsupported(node, 'unsupported function declarator');
  let nameNode = declarator.childForFieldName('declarator');
  while (nameNode?.type === 'parenthesized_declarator') nameNode = semanticChildren(nameNode)[0];
  if (nameNode?.type !== 'identifier')
    throw unsupported(node, 'function pointer declarators are not supported');
  const name = nameNode.text;
  const paramsNode = declarator.childForFieldName('parameters');
  const params = [];
  for (const p of paramsNode?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration') continue;
    const pTypeNode = p.childForFieldName('type') ?? semanticChildren(p)[0];
    const pDecl =
      p.childForFieldName('declarator') ??
      p.namedChildren.find(c => c !== pTypeNode && isDeclaratorLike(c));
    // Treat a sole "void" parameter list as no parameters.
    if (!pDecl && pTypeNode.text.trim() === 'void') {
      if (paramsNode.namedChildren.filter(c => c.type !== 'comment').length !== 1)
        throw unsupported(p, 'void must be the only parameter');
      continue;
    }
    const base = parseBaseType(pTypeNode, structTypes);
    if (!pDecl) throw unsupported(p, 'function parameters need names in PointerViz');
    const info = parseDeclarator(pDecl, base, structTypes, { parameter: true });
    // C adjusts array parameters to pointers.
    const type = info.type.kind === 'array' ? pointer(info.type.of) : info.type;
    // Parameters and the return type of a definition must be complete (C23 6.9.1p3, p7).
    requireCompleteAt(type, pDecl, structTypes);
    params.push({ name: info.name, type, loc: locOf(p) });
  }
  if (returnType.kind !== 'void') requireCompleteAt(returnType, nameNode, structTypes);
  const body = node.childForFieldName('body');
  return withLoc(
    {
      kind: 'FunctionDefinition',
      name,
      returnType,
      params,
      statements: parseCompound(body, structTypes),
    },
    node,
  );
}

function parseCompound(node, structTypes) {
  const statements = [];
  for (const child of node?.namedChildren ?? []) {
    if (child.type === 'comment') continue;
    const stmt = parseStatement(child, structTypes);
    if (stmt) statements.push(stmt);
  }
  return statements;
}

function parseStatement(node, structTypes) {
  switch (node.type) {
    case 'type_definition':
      return null;
    case 'declaration': {
      const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
      // A standalone struct definition is a type declaration, not runtime code.
      if (
        typeNode?.type === 'struct_specifier' &&
        structBody(typeNode) &&
        !node.namedChildren.some(c => c !== typeNode && isDeclaratorLike(c))
      )
        return null;
      return parseDeclaration(node, structTypes);
    }
    case 'expression_statement': {
      const expr = semanticChildren(node)[0];
      return expr
        ? withLoc(
            { kind: 'ExpressionStatement', expression: parseExpression(expr, structTypes) },
            node,
          )
        : withLoc({ kind: 'Empty' }, node);
    }
    case 'return_statement': {
      const expr = semanticChildren(node)[0];
      return withLoc(
        { kind: 'Return', expression: expr ? parseExpression(expr, structTypes) : null },
        node,
      );
    }
    case 'compound_statement':
      return withLoc({ kind: 'Block', statements: parseCompound(node, structTypes) }, node);
    case 'if_statement': {
      const condition = node.childForFieldName('condition');
      const consequence = node.childForFieldName('consequence');
      const alternative = node.childForFieldName('alternative');
      if (!condition || !consequence) throw unsupported(node, 'malformed if statement');
      return withLoc(
        {
          kind: 'If',
          condition: parseExpression(condition, structTypes),
          consequence:
            parseStatement(consequence, structTypes) ?? withLoc({ kind: 'Empty' }, consequence),
          alternative: alternative ? parseElseClause(alternative, structTypes) : null,
        },
        node,
      );
    }
    case 'while_statement': {
      const condition = node.childForFieldName('condition');
      const body = node.childForFieldName('body');
      if (!condition || !body) throw unsupported(node, 'malformed while statement');
      return withLoc(
        {
          kind: 'While',
          condition: parseExpression(condition, structTypes),
          body: parseStatement(body, structTypes) ?? withLoc({ kind: 'Empty' }, body),
        },
        node,
      );
    }
    case 'for_statement': {
      const initializer = node.childForFieldName('initializer');
      const condition = node.childForFieldName('condition');
      const update = node.childForFieldName('update');
      const body = node.childForFieldName('body');
      if (!body) throw unsupported(node, 'malformed for statement');
      let init = null;
      if (initializer) {
        init =
          initializer.type === 'declaration'
            ? parseDeclaration(initializer, structTypes)
            : withLoc(
                {
                  kind: 'ExpressionStatement',
                  expression: parseExpression(initializer, structTypes),
                },
                initializer,
              );
      }
      return withLoc(
        {
          kind: 'For',
          initializer: init,
          condition: condition ? parseExpression(condition, structTypes) : null,
          update: update ? parseExpression(update, structTypes) : null,
          body: parseStatement(body, structTypes) ?? withLoc({ kind: 'Empty' }, body),
        },
        node,
      );
    }
    case 'break_statement':
      return withLoc({ kind: 'Break' }, node);
    case 'continue_statement':
      return withLoc({ kind: 'Continue' }, node);
    default:
      throw unsupported(node);
  }
}

function parseElseClause(node, structTypes) {
  // tree-sitter-c wraps the statement after `else` in an else_clause node.
  if (node.type !== 'else_clause') return parseStatement(node, structTypes);
  const body = node.namedChildren.at(-1);
  if (!body) throw unsupported(node, 'empty else clause');
  return parseStatement(body, structTypes) ?? withLoc({ kind: 'Empty' }, body);
}
