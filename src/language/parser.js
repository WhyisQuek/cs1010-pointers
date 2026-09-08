/**
 * Tree-sitter C -> PointerViz Mini-C AST adapter.
 *
 * Tree-sitter remains syntax-only. This module normalizes supported C into the
 * small AST consumed by the semantic interpreter. Struct tags are resolved in
 * a two-pass parse so self-referential declarations are supported.
 */
import { Parser, Language } from 'web-tree-sitter';
import {
  array, isSupportedPrimitiveName, pointer, primitive, structRef, structType,
} from './types.js';
import { MAX_ARRAY_LENGTH, MAX_STRUCT_FIELDS } from './limits.js';

let C = null;

export async function initCParser({ runtimeWasm, grammarWasm = '/tree-sitter-c.wasm' } = {}) {
  if (C) return;
  await Parser.init(runtimeWasm ? { locateFile: () => runtimeWasm } : { locateFile: n => '/' + n });
  C = await Language.load(grammarWasm);
}

export function parseMiniC(source) {
  if (!C) throw new Error('parser not initialized');
  const parser = new Parser();
  parser.setLanguage(C);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) throw syntaxError(firstError(tree.rootNode));

  const structTypes = collectStructs(tree.rootNode);
  const functions = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'function_definition') functions.push(parseFunction(node, structTypes));
  }
  if (!functions.some(f => f.name === 'main')) {
    throw new Error('no main() function found — wrap your entry code in int main() { ... }');
  }
  return {
    kind: 'Program',
    structs: Object.values(structTypes),
    functions,
    source,
  };
}

function collectStructs(root) {
  const structs = {};
  // Pass 1 reserves every named definition so fields may refer to themselves or
  // to a struct whose body appears later in the translation unit.
  for (const node of walkNodes(root)) {
    if (node.type !== 'struct_specifier' || !structBody(node)) continue;
    const name = structName(node);
    if (!name) throw unsupported(node, 'anonymous struct definitions are not supported');
    structs[name] ??= structType(name, []);
  }
  // Pass 2 parses field declarations with all tags now known.
  for (const node of walkNodes(root)) {
    if (node.type !== 'struct_specifier' || !structBody(node)) continue;
    const name = structName(node);
    const body = structBody(node);
    const fields = [];
    for (const fieldNode of body.namedChildren) {
      if (fieldNode.type !== 'field_declaration') continue;
      const baseNode = fieldNode.childForFieldName('type') ?? fieldNode.namedChildren[0];
      const base = parseBaseType(baseNode, structs);
      for (const child of fieldNode.namedChildren) {
        if (child === baseNode || child.type === 'type_qualifier') continue;
        if (!isDeclaratorLike(child)) continue;
        const info = parseDeclarator(child, base, structs, { field: true });
        fields.push({ name: info.name, type: info.type });
      }
    }
    if (fields.length > MAX_STRUCT_FIELDS) throw new Error(`struct ${name} has ${fields.length} fields; PointerViz limits structs to ${MAX_STRUCT_FIELDS}`);
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f.name)) throw new Error(`duplicate field '${f.name}' in struct ${name}`);
      seen.add(f.name);
    }
    structs[name] = structType(name, fields);
  }
  return structs;
}

function parseFunction(node, structTypes) {
  const typeNode = node.childForFieldName('type') ?? node.namedChildren[0];
  const returnType = parseBaseType(typeNode, structTypes, { allowVoid: true });
  const declarator = node.childForFieldName('declarator');
  const name = declaratorName(declarator);
  if (!name) throw unsupported(node, 'function name could not be resolved');
  const paramsNode = findDescendant(declarator, 'parameter_list');
  const params = [];
  for (const p of paramsNode?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration') continue;
    const pTypeNode = p.childForFieldName('type') ?? p.namedChildren[0];
    const pDecl = p.childForFieldName('declarator') ?? p.namedChildren.find(c => c !== pTypeNode && isDeclaratorLike(c));
    // Treat a sole "void" parameter list as no parameters.
    if (!pDecl && pTypeNode.text.trim() === 'void') continue;
    const base = parseBaseType(pTypeNode, structTypes);
    if (!pDecl) throw unsupported(p, 'function parameters need names in PointerViz');
    const info = parseDeclarator(pDecl, base, structTypes);
    // C adjusts array parameters to pointers.
    const type = info.type.kind === 'array' ? pointer(info.type.of) : info.type;
    params.push({ name: info.name, type, loc: locOf(p) });
  }
  const body = node.childForFieldName('body');
  return withLoc({
    kind: 'FunctionDefinition', name, returnType, params,
    statements: parseCompound(body, structTypes),
  }, node);
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
    case 'declaration': {
      const typeNode = node.childForFieldName('type') ?? node.namedChildren[0];
      // A standalone struct definition is a type declaration, not runtime code.
      if (typeNode?.type === 'struct_specifier' && structBody(typeNode) && !node.namedChildren.some(c => c !== typeNode && isDeclaratorLike(c))) return null;
      return parseDeclaration(node, structTypes);
    }
    case 'expression_statement': {
      const expr = node.namedChildren[0];
      return expr
        ? withLoc({ kind: 'ExpressionStatement', expression: parseExpression(expr, structTypes) }, node)
        : withLoc({ kind: 'Empty' }, node);
    }
    case 'return_statement': {
      const expr = node.namedChildren[0];
      return withLoc({ kind: 'Return', expression: expr ? parseExpression(expr, structTypes) : null }, node);
    }
    case 'compound_statement':
      return withLoc({ kind: 'Block', statements: parseCompound(node, structTypes) }, node);
    case 'if_statement': {
      const condition = node.childForFieldName('condition');
      const consequence = node.childForFieldName('consequence');
      const alternative = node.childForFieldName('alternative');
      if (!condition || !consequence) throw unsupported(node, 'malformed if statement');
      return withLoc({
        kind: 'If',
        condition: parseExpression(condition, structTypes),
        consequence: parseStatement(consequence, structTypes) ?? withLoc({ kind: 'Empty' }, consequence),
        alternative: alternative ? parseElseClause(alternative, structTypes) : null,
      }, node);
    }
    case 'while_statement': {
      const condition = node.childForFieldName('condition');
      const body = node.childForFieldName('body');
      if (!condition || !body) throw unsupported(node, 'malformed while statement');
      return withLoc({
        kind: 'While',
        condition: parseExpression(condition, structTypes),
        body: parseStatement(body, structTypes) ?? withLoc({ kind: 'Empty' }, body),
      }, node);
    }
    case 'for_statement': {
      const initializer = node.childForFieldName('initializer');
      const condition = node.childForFieldName('condition');
      const update = node.childForFieldName('update');
      const body = node.childForFieldName('body');
      if (!body) throw unsupported(node, 'malformed for statement');
      let init = null;
      if (initializer) {
        init = initializer.type === 'declaration'
          ? parseDeclaration(initializer, structTypes)
          : withLoc({ kind: 'ExpressionStatement', expression: parseExpression(initializer, structTypes) }, initializer);
      }
      return withLoc({
        kind: 'For',
        initializer: init,
        condition: condition ? parseExpression(condition, structTypes) : null,
        update: update ? parseExpression(update, structTypes) : null,
        body: parseStatement(body, structTypes) ?? withLoc({ kind: 'Empty' }, body),
      }, node);
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

function parseDeclaration(node, structTypes) {
  const typeNode = node.childForFieldName('type') ?? node.namedChildren[0];
  const base = parseBaseType(typeNode, structTypes);
  const declarations = [];
  for (const child of node.namedChildren) {
    if (child === typeNode || child.type === 'storage_class_specifier' || child.type === 'type_qualifier') continue;
    if (!isDeclaratorLike(child)) continue;
    let declarator = child, initializer = null;
    if (child.type === 'init_declarator') {
      declarator = child.childForFieldName('declarator');
      initializer = child.childForFieldName('value');
    }
    const info = parseDeclarator(declarator, base, structTypes);
    declarations.push({
      name: info.name, type: info.type,
      initializer: initializer ? parseExpression(initializer, structTypes) : null,
      loc: locOf(child),
    });
  }
  if (!declarations.length) throw unsupported(node, 'declaration without a supported declarator');
  return withLoc({ kind: 'Declaration', declarations }, node);
}

function parseBaseType(node, structTypes, { allowVoid = false } = {}) {
  if (!node) throw new Error('missing type');
  const text = node.text.trim();
  if (allowVoid && text === 'void') return { kind: 'void' };
  if (isSupportedPrimitiveName(text)) return primitive(text);
  if (node.type === 'struct_specifier' || /^struct\s+/.test(text)) {
    const name = structName(node) ?? text.match(/^struct\s+([A-Za-z_]\w*)/)?.[1];
    if (!name) throw unsupported(node, 'anonymous struct types are not supported');
    const def = structTypes[name];
    if (!def) throw unsupported(node, `unknown struct '${name}'`);
    return def;
  }
  throw unsupported(node, `type '${text}' is not in the current Mini-C subset`);
}

function parseDeclarator(node, baseType, structTypes, { field = false } = {}) {
  if (!node) throw new Error('missing declarator');
  if (node.type === 'identifier' || node.type === 'field_identifier') return { name: node.text, type: structuredClone(baseType) };
  if (node.type === 'pointer_declarator' || node.type === 'abstract_pointer_declarator') {
    const inner = node.childForFieldName('declarator') ?? node.namedChildren.at(-1);
    return parseDeclarator(inner, pointer(referenceSafeType(baseType)), structTypes, { field });
  }
  if (node.type === 'array_declarator') {
    const inner = node.childForFieldName('declarator') ?? node.namedChildren[0];
    const sizeNode = node.childForFieldName('size');
    if (!sizeNode || sizeNode.type !== 'number_literal') throw unsupported(node, 'array size must be a positive integer literal');
    const length = parseIntegerLiteral(sizeNode.text);
    assertArrayLength(length, sizeNode);
    const parsed = parseDeclarator(inner, baseType, structTypes, { field });
    return { name: parsed.name, type: array(parsed.type, length) };
  }
  if (node.type === 'parenthesized_declarator' || node.type === 'parenthesized_declarator') {
    return parseDeclarator(node.namedChildren[0], baseType, structTypes, { field });
  }
  throw unsupported(node, `unsupported declarator '${node.type}'`);
}

/** Self-referential pointer fields only need the named tag, not an embedded body. */
function referenceSafeType(type) {
  return type.kind === 'struct' ? structRef(type.name) : type;
}

function parseExpression(node, structTypes) {
  switch (node.type) {
    case 'number_literal': return withLoc({ kind: 'IntLiteral', value: parseIntegerLiteral(node.text), raw: node.text }, node);
    case 'char_literal': return withLoc({ kind: 'CharLiteral', raw: node.text }, node);
    case 'identifier': return withLoc({ kind: 'Identifier', name: node.text }, node);
    case 'null': return withLoc({ kind: 'NullLiteral' }, node);
    case 'pointer_expression':
    case 'unary_expression': {
      const op = operatorOf(node);
      const arg = node.childForFieldName('argument') ?? node.namedChildren.at(-1);
      if (op === '&') return withLoc({ kind: 'AddressOf', expression: parseExpression(arg, structTypes) }, node);
      if (op === '*') return withLoc({ kind: 'Dereference', expression: parseExpression(arg, structTypes) }, node);
      if (op === '+' || op === '-' || op === '!') return withLoc({ kind: 'Unary', operator: op, expression: parseExpression(arg, structTypes) }, node);
      throw unsupported(node);
    }
    case 'parenthesized_expression': return parseExpression(node.namedChildren[0], structTypes);
    case 'assignment_expression': return withLoc({
      kind: 'Assignment', operator: node.childForFieldName('operator')?.text ?? '=',
      left: parseExpression(node.childForFieldName('left'), structTypes),
      right: parseExpression(node.childForFieldName('right'), structTypes),
    }, node);
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier') throw unsupported(node, 'only direct function calls are supported');
      const args = node.childForFieldName('arguments')?.namedChildren.map(n => parseExpression(n, structTypes)) ?? [];
      return withLoc({ kind: 'Call', name: fn.text, arguments: args }, node);
    }
    case 'subscript_expression': return withLoc({
      kind: 'Subscript',
      array: parseExpression(node.childForFieldName('argument') ?? node.namedChildren[0], structTypes),
      index: parseExpression(node.childForFieldName('index') ?? node.namedChildren[1], structTypes),
    }, node);
    case 'field_expression': {
      const argument = node.childForFieldName('argument') ?? node.namedChildren[0];
      const field = node.childForFieldName('field') ?? node.namedChildren.at(-1);
      const op = operatorToken(node);
      return withLoc({
        kind: 'Member', object: parseExpression(argument, structTypes), field: field.text,
        viaPointer: op.includes('->') || node.text.includes('->'),
      }, node);
    }
    case 'binary_expression': return withLoc({
      kind: 'Binary', operator: node.childForFieldName('operator')?.text ?? operatorToken(node),
      left: parseExpression(node.childForFieldName('left') ?? node.namedChildren[0], structTypes),
      right: parseExpression(node.childForFieldName('right') ?? node.namedChildren[1], structTypes),
    }, node);
    case 'update_expression': {
      const arg = node.childForFieldName('argument') ?? node.namedChildren[0];
      const op = operatorOf(node) || (node.text.includes('++') ? '++' : '--');
      const trimmed = node.text.trimStart();
      return withLoc({
        kind: 'Update', operator: op, expression: parseExpression(arg, structTypes),
        prefix: trimmed.startsWith('++') || trimmed.startsWith('--'),
      }, node);
    }
    case 'sizeof_expression': {
      const typeDesc = node.namedChildren.find(c => c.type === 'type_descriptor');
      if (typeDesc) {
        const baseNode = typeDesc.childForFieldName('type') ?? typeDesc.namedChildren[0];
        let t = parseBaseType(baseNode, structTypes);
        const declarator = typeDesc.childForFieldName('declarator') ?? typeDesc.namedChildren.find(c => isDeclaratorLike(c));
        if (declarator) t = parseAbstractDeclarator(declarator, t, structTypes);
        return withLoc({ kind: 'SizeofType', type: t }, node);
      }
      const expr = node.namedChildren.find(c => c.type !== 'type_descriptor');
      if (!expr) throw unsupported(node);
      return withLoc({ kind: 'SizeofExpression', expression: parseExpression(expr, structTypes) }, node);
    }
    case 'initializer_list': return withLoc({ kind: 'InitializerList', elements: node.namedChildren.map(n => parseExpression(n, structTypes)) }, node);
    default: throw unsupported(node);
  }
}

function parseAbstractDeclarator(node, base, structTypes) {
  if (node.type === 'abstract_pointer_declarator' || node.type === 'pointer_declarator') {
    const inner = node.childForFieldName('declarator') ?? node.namedChildren.at(-1);
    const next = pointer(referenceSafeType(base));
    return inner ? parseAbstractDeclarator(inner, next, structTypes) : next;
  }
  if (node.type === 'abstract_array_declarator' || node.type === 'array_declarator') {
    const sizeNode = node.childForFieldName('size');
    if (!sizeNode || sizeNode.type !== 'number_literal') throw unsupported(node, 'sizeof array type needs literal size');
    const length = parseIntegerLiteral(sizeNode.text); assertArrayLength(length, sizeNode);
    const inner = node.childForFieldName('declarator');
    const arr = array(base, length);
    return inner ? parseAbstractDeclarator(inner, arr, structTypes) : arr;
  }
  return base;
}

function assertArrayLength(length, node) {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARRAY_LENGTH) {
    throw new Error(`array size must be between 1 and ${MAX_ARRAY_LENGTH} (line ${node.startPosition.row + 1})`);
  }
}

function parseIntegerLiteral(raw) {
  const cleaned = raw.replace(/[uUlL]+$/g, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 16);
  if (/^0[bB][01]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 2);
  if (/^0[0-7]+$/.test(cleaned) && cleaned.length > 1) return Number.parseInt(cleaned.slice(1), 8);
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`unsupported integer literal '${raw}'`);
  return n;
}

function structName(node) {
  if (!node) return null;
  const named = node.childForFieldName?.('name');
  if (named) return named.text;
  const tag = node.namedChildren?.find(c => c.type === 'type_identifier');
  return tag?.text ?? node.text.match(/^struct\s+([A-Za-z_]\w*)/)?.[1] ?? null;
}
function structBody(node) { return node.childForFieldName?.('body') ?? node.namedChildren?.find(c => c.type === 'field_declaration_list') ?? null; }

function declaratorName(node) {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'field_identifier') return node.text;
  const field = node.childForFieldName?.('declarator');
  if (field) return declaratorName(field);
  for (const child of node.namedChildren ?? []) { const name = declaratorName(child); if (name) return name; }
  return null;
}

function findDescendant(node, type) {
  if (!node) return null;
  if (node.type === type) return node;
  for (const c of node.namedChildren ?? []) { const hit = findDescendant(c, type); if (hit) return hit; }
  return null;
}
function* walkNodes(node) { yield node; for (const c of node.namedChildren ?? []) yield* walkNodes(c); }
function isDeclaratorLike(node) {
  return node && (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'init_declarator' || node.type.endsWith('declarator'));
}
function firstError(node) { if (node.type === 'ERROR' || node.isMissing) return node; for (const c of node.namedChildren) { const e = firstError(c); if (e) return e; } return node; }
function syntaxError(node) { return new Error(`C syntax error near line ${node.startPosition.row + 1}: "${node.text.slice(0, 50)}"`); }
function operatorOf(node) { return node.childForFieldName?.('operator')?.text ?? [...Array(node.childCount).keys()].map(i => node.child(i)).find(c => c && !c.isNamed)?.text ?? ''; }
function operatorToken(node) { let out = ''; for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (!c.isNamed) out += c.text; } return out; }
function withLoc(obj, node) { return { ...obj, loc: locOf(node) }; }
function locOf(node) { return { startLine: node.startPosition.row + 1, startColumn: node.startPosition.column + 1, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1 }; }
function unsupported(node, detail = null) { return new Error(`unsupported C construct '${node.type}' at line ${node.startPosition.row + 1}${detail ? `: ${detail}` : ''}`); }
