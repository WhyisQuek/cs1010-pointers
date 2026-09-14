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
import { convertNumber } from './numeric.js';

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
  try {
  if (tree.rootNode.hasError) throw syntaxError(firstError(tree.rootNode));

  // Never erase syntax whose semantics the machine does not implement.
  for (const node of walkNodes(tree.rootNode)) {
    if (['type_qualifier', 'bitfield_clause', 'variadic_parameter', 'storage_class_specifier'].includes(node.type) && node.text !== 'typedef') {
      throw unsupported(node, 'qualifiers, storage classes, bitfields and variadic functions are not supported');
    }
    if (node.type.startsWith('preproc_') && !['preproc_include', 'preproc_arg', 'preproc_directive'].includes(node.type)) {
      throw unsupported(node, 'preprocessing is not supported');
    }
  }

  const structTypes = collectStructs(tree.rootNode);
  const functions = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'function_definition') functions.push(parseFunction(node, structTypes));
    else if (!['comment', 'preproc_include', 'type_definition', 'struct_specifier'].includes(node.type)) {
      const type = node.childForFieldName('type');
      const declarators = node.namedChildren.filter(isDeclaratorLike);
      // Prototypes are checked against definitions below, not executed.
      if (node.type !== 'declaration' || declarators.length || type?.type !== 'struct_specifier') {
        throw unsupported(node, 'global variables and function prototypes are not supported');
      }
    }
  }
  if (new Set(functions.map(f => f.name)).size !== functions.length) throw new Error('duplicate function definition');
  if (!functions.some(f => f.name === 'main')) {
    throw new Error('no main() function found — wrap your entry code in int main() { ... }');
  }
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

function collectStructs(root) {
  const structs = {};
  const aliases = new Map();
  const aliasPositions = new Map();
  const definitionPositions = new Map();
  Object.defineProperty(structs, 'aliases', { value: aliases });
  Object.defineProperty(structs, 'aliasPositions', { value: aliasPositions });
  Object.defineProperty(structs, 'definitionPositions', { value: definitionPositions });
  for (const node of walkNodes(root)) {
    if (node.type !== 'type_definition') continue;
    if (node.parent?.type !== 'translation_unit') throw unsupported(node, 'block-scoped typedefs are not supported');
    const base = node.childForFieldName('type');
    const alias = node.childForFieldName('declarator');
    if (base?.type !== 'struct_specifier' || alias?.type !== 'type_identifier') {
      throw unsupported(node, 'only direct struct typedefs are supported');
    }
    if (aliases.has(alias.text)) throw unsupported(node, 'duplicate typedef name');
    aliases.set(alias.text, structName(base) ?? alias.text);
    aliasPositions.set(alias.text, alias.endIndex);
  }
  const definitionName = node => structName(node) ?? (node.parent?.type === 'type_definition' ? node.parent.childForFieldName('declarator')?.text : null);
  // Pass 1 reserves every named definition so fields may refer to themselves or
  // to a struct whose body appears later in the translation unit.
  for (const node of walkNodes(root)) {
    if (node.type !== 'struct_specifier' || !structBody(node)) continue;
    const owner = ['declaration', 'type_definition'].includes(node.parent?.type) ? node.parent.parent : node.parent;
    if (owner?.type !== 'translation_unit') throw unsupported(node, 'struct definitions must be at file scope');
    const name = definitionName(node);
    if (!name) throw unsupported(node, 'anonymous struct definitions are not supported');
    if (structs[name]) throw unsupported(node, `duplicate or shadowed struct tag '${name}'`);
    structs[name] = structType(name, []);
    definitionPositions.set(name, node.startIndex);
  }
  // Pass 2 parses field declarations with all tags now known.
  for (const node of walkNodes(root)) {
    if (node.type !== 'struct_specifier' || !structBody(node)) continue;
    const name = definitionName(node);
    const body = structBody(node);
    const fields = [];
    for (const fieldNode of body.namedChildren) {
      if (fieldNode.type !== 'field_declaration') continue;
      const baseNode = fieldNode.childForFieldName('type') ?? semanticChildren(fieldNode)[0];
      const base = parseBaseType(baseNode, structs);
      for (const child of fieldNode.namedChildren) {
        if (child === baseNode || child.type === 'type_qualifier') continue;
        if (!isDeclaratorLike(child)) continue;
        const info = parseDeclarator(child, base, structs, { field: true });
        requireCompleteAt(info.type, child, structs);
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
    const alias = [...aliases].find(([, tag]) => tag === name)?.[0];
    if (alias) {
      structs[name].alias = alias;
      structs[name].typedefNames = [...aliases].filter(([, tag]) => tag === name).map(([id]) => id);
    }
  }
  // By-value cycles are invalid C and would otherwise recurse forever in storage creation.
  function checkComplete(type, visiting = new Set()) {
    if (type.kind === 'array') return checkComplete(type.of, visiting);
    if (type.kind !== 'struct') return;
    if (visiting.has(type.name)) throw new Error(`recursive by-value struct '${type.name}'`);
    const def = structs[type.name];
    if (!def?.fields?.length) throw new Error(`incomplete or empty struct '${type.name}'`);
    for (const field of def.fields) checkComplete(field.type, new Set([...visiting, type.name]));
  }
  for (const def of Object.values(structs)) checkComplete(def);
  return structs;
}

function parseFunction(node, structTypes) {
  const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
  let returnType = parseBaseType(typeNode, structTypes, { allowVoid: true });
  let declarator = node.childForFieldName('declarator');
  // Return-type stars wrap the function declarator in Tree-sitter's C tree.
  while (declarator?.type === 'pointer_declarator' || declarator?.type === 'parenthesized_declarator') {
    if (declarator.type === 'pointer_declarator') {
      returnType = pointer(referenceSafeType(returnType));
      declarator = declarator.childForFieldName('declarator');
    } else {
      declarator = semanticChildren(declarator)[0];
    }
  }
  if (declarator?.type !== 'function_declarator') throw unsupported(node, 'unsupported function declarator');
  let nameNode = declarator.childForFieldName('declarator');
  while (nameNode?.type === 'parenthesized_declarator') nameNode = semanticChildren(nameNode)[0];
  if (nameNode?.type !== 'identifier') throw unsupported(node, 'function pointer declarators are not supported');
  const name = nameNode.text;
  const paramsNode = declarator.childForFieldName('parameters');
  const params = [];
  for (const p of paramsNode?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration') continue;
    const pTypeNode = p.childForFieldName('type') ?? semanticChildren(p)[0];
    const pDecl = p.childForFieldName('declarator') ?? p.namedChildren.find(c => c !== pTypeNode && isDeclaratorLike(c));
    // Treat a sole "void" parameter list as no parameters.
      if (!pDecl && pTypeNode.text.trim() === 'void') {
        if (paramsNode.namedChildren.filter(c => c.type !== 'comment').length !== 1) throw unsupported(p, 'void must be the only parameter');
        continue;
      }
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
    case 'type_definition': return null;
    case 'declaration': {
      const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
      // A standalone struct definition is a type declaration, not runtime code.
      if (typeNode?.type === 'struct_specifier' && structBody(typeNode) && !node.namedChildren.some(c => c !== typeNode && isDeclaratorLike(c))) return null;
      return parseDeclaration(node, structTypes);
    }
    case 'expression_statement': {
      const expr = semanticChildren(node)[0];
      return expr
        ? withLoc({ kind: 'ExpressionStatement', expression: parseExpression(expr, structTypes) }, node)
        : withLoc({ kind: 'Empty' }, node);
    }
    case 'return_statement': {
      const expr = semanticChildren(node)[0];
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
  const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
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
    requireCompleteAt(info.type, declarator, structTypes);
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
  if (node.type === 'type_identifier' && structTypes.aliases?.has(text)) {
    if (node.startIndex < structTypes.aliasPositions.get(text)) throw unsupported(node, `typedef '${text}' is not declared yet`);
    const def = structTypes[structTypes.aliases.get(text)];
    if (!def) throw unsupported(node, `unknown struct typedef '${text}'`);
    return { ...def, alias: text };
  }
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
    const inner = node.childForFieldName('declarator') ?? semanticChildren(node)[0];
    const sizeNode = node.childForFieldName('size');
    if (!sizeNode || sizeNode.type !== 'number_literal') throw unsupported(node, 'array size must be a positive integer literal');
    const length = parseIntegerLiteral(sizeNode.text);
    assertArrayLength(length, sizeNode);
    return parseDeclarator(inner, array(baseType, length), structTypes, { field });
  }
  if (node.type === 'parenthesized_declarator' || node.type === 'parenthesized_declarator') {
    return parseDeclarator(semanticChildren(node)[0], baseType, structTypes, { field });
  }
  throw unsupported(node, `unsupported declarator '${node.type}'`);
}

/** Self-referential pointer fields only need the named tag, not an embedded body. */
function requireCompleteAt(type, node, structs) {
  if (type.kind === 'array') return requireCompleteAt(type.of, node, structs);
  if (type.kind === 'struct' && structs.definitionPositions.get(type.name) > node.startIndex) {
    throw unsupported(node, `struct '${type.name}' is incomplete at this declaration`);
  }
}

function referenceSafeType(type) {
  return type.kind === 'struct' ? { ...structRef(type.name), ...(type.alias ? { alias: type.alias } : {}) } : type;
}

function parseExpression(node, structTypes) {
  switch (node.type) {
    case 'number_literal': return withLoc(/^[+-]/.test(node.text)
      ? { kind: 'Unary', operator: node.text[0], expression: withLoc(parseNumberLiteral(node.text.slice(1)), node) }
      : parseNumberLiteral(node.text), node);
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
    case 'parenthesized_expression': return parseExpression(semanticChildren(node)[0], structTypes);
    case 'assignment_expression': return withLoc({
      kind: 'Assignment', operator: node.childForFieldName('operator')?.text ?? '=',
      left: parseExpression(node.childForFieldName('left'), structTypes),
      right: parseExpression(node.childForFieldName('right'), structTypes),
    }, node);
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier') throw unsupported(node, 'only direct function calls are supported');
      const args = semanticChildren(node.childForFieldName('arguments')).map(n => parseExpression(n, structTypes));
      return withLoc({ kind: 'Call', name: fn.text, arguments: args }, node);
    }
    case 'subscript_expression': return withLoc({
      kind: 'Subscript',
      array: parseExpression(node.childForFieldName('argument') ?? semanticChildren(node)[0], structTypes),
      index: parseExpression(node.childForFieldName('index') ?? node.namedChildren[1], structTypes),
    }, node);
    case 'field_expression': {
      const argument = node.childForFieldName('argument') ?? semanticChildren(node)[0];
      const field = node.childForFieldName('field') ?? node.namedChildren.at(-1);
      const op = operatorToken(node);
      return withLoc({
        kind: 'Member', object: parseExpression(argument, structTypes), field: field.text,
        viaPointer: op.includes('->'),
      }, node);
    }
    case 'binary_expression': return withLoc({
      kind: 'Binary', operator: node.childForFieldName('operator')?.text ?? operatorToken(node),
      left: parseExpression(node.childForFieldName('left') ?? semanticChildren(node)[0], structTypes),
      right: parseExpression(node.childForFieldName('right') ?? node.namedChildren[1], structTypes),
    }, node);
    case 'update_expression': {
      const arg = node.childForFieldName('argument') ?? semanticChildren(node)[0];
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
        const baseNode = typeDesc.childForFieldName('type') ?? semanticChildren(typeDesc)[0];
        const ambiguousCall = typeDesc.childForFieldName('declarator');
        if (baseNode.type === 'type_identifier' && !structTypes.aliases?.has(baseNode.text) &&
            ambiguousCall?.type === 'abstract_function_declarator' && !ambiguousCall.childForFieldName('parameters')?.namedChildren.length) {
          return withLoc({ kind: 'SizeofExpression', expression: withLoc({ kind: 'Call', name: baseNode.text, arguments: [] }, typeDesc) }, node);
        }
        let t = parseBaseType(baseNode, structTypes);
        const declarator = typeDesc.childForFieldName('declarator') ?? typeDesc.namedChildren.find(c => isDeclaratorLike(c));
        if (declarator) t = parseAbstractDeclarator(declarator, t, structTypes);
        return withLoc({ kind: 'SizeofType', type: t }, node);
      }
      const expr = semanticChildren(node).find(c => c.type !== 'type_descriptor');
      if (!expr) throw unsupported(node);
      let name = expr;
      while (name.type === 'parenthesized_expression') name = semanticChildren(name)[0];
      if (name.type === 'identifier' && structTypes.aliases?.has(name.text)) {
        if (name.startIndex < structTypes.aliasPositions.get(name.text)) throw unsupported(name, `typedef '${name.text}' is not declared yet`);
        const def = structTypes[structTypes.aliases.get(name.text)];
        return withLoc({ kind: 'SizeofType', type: { ...def, alias: name.text } }, node);
      }
      return withLoc({ kind: 'SizeofExpression', expression: parseExpression(expr, structTypes) }, node);
    }
    case 'initializer_list': return withLoc({ kind: 'InitializerList', elements: semanticChildren(node).map(n => parseExpression(n, structTypes)) }, node);
    default: throw unsupported(node);
  }
}

function parseAbstractDeclarator(node, base, structTypes) {
  if (node.type === 'abstract_parenthesized_declarator') return parseAbstractDeclarator(semanticChildren(node)[0], base, structTypes);
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
  throw unsupported(node, 'unsupported abstract declarator');
}

function assertArrayLength(length, node) {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARRAY_LENGTH) {
    throw new Error(`array size must be between 1 and ${MAX_ARRAY_LENGTH} (line ${node.startPosition.row + 1})`);
  }
}

function parseIntegerLiteral(raw) {
  const literal = parseNumberLiteral(raw);
  if (literal.kind !== 'IntLiteral') throw new Error(`expected integer literal '${raw}'`);
  return literal.value;
}

function parseNumberLiteral(raw) {
  if (/^(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)[fF]?$/.test(raw)) {
    const type = primitive(/[fF]$/.test(raw) ? 'float' : 'double');
    return { kind: 'FloatLiteral', type, value: convertNumber(Number(raw.replace(/[fF]$/, '')), type), raw };
  }
  const match = raw.match(/^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uU]?[lL]?|[lL][uU]?)$/);
  if (!match) throw new Error(`unsupported numeric literal '${raw}'`);
  const [, digits, suffix] = match;
  const n = BigInt(/^0[0-7]+$/.test(digits) ? `0o${digits.slice(1)}` : digits);
  const unsigned = /u/i.test(suffix), long = /l/i.test(suffix);
  const nonDecimal = digits.startsWith('0') && digits.length > 1;
  const name = long ? (unsigned ? 'unsigned long' : 'long')
    : unsigned ? (n <= 4294967295n ? 'unsigned int' : 'unsigned long')
    : n <= 2147483647n ? 'int' : nonDecimal && n <= 4294967295n ? 'unsigned int' : 'long';
  const type = primitive(name);
  return { kind: 'IntLiteral', type, value: convertNumber(n, type, { arithmetic: true }), raw };
}

function structName(node) {
  if (!node) return null;
  const named = node.childForFieldName?.('name');
  if (named) return named.text;
  const tag = node.namedChildren?.find(c => c.type === 'type_identifier');
  return tag?.text ?? node.text.match(/^struct\s+([A-Za-z_]\w*)/)?.[1] ?? null;
}
function structBody(node) { return node.childForFieldName?.('body') ?? node.namedChildren?.find(c => c.type === 'field_declaration_list') ?? null; }

function* walkNodes(node) { yield node; for (const c of node.namedChildren ?? []) yield* walkNodes(c); }
function semanticChildren(node) { return (node?.namedChildren ?? []).filter(c => c.type !== 'comment'); }
function isDeclaratorLike(node) {
  return node && (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'init_declarator' || node.type.endsWith('declarator'));
}
function firstError(node) { if (node.type === 'ERROR' || node.isMissing) return node; for (const c of node.children) { const e = firstError(c); if (e) return e; } return null; }
function syntaxError(node) { return new Error(`C syntax error near line ${node.startPosition.row + 1}: "${node.text.slice(0, 50)}"`); }
function operatorOf(node) { return node.childForFieldName?.('operator')?.text ?? [...Array(node.childCount).keys()].map(i => node.child(i)).find(c => c && !c.isNamed)?.text ?? ''; }
function operatorToken(node) { let out = ''; for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (!c.isNamed) out += c.text; } return out; }
function withLoc(obj, node) { return { ...obj, loc: locOf(node) }; }
function locOf(node) { return { startLine: node.startPosition.row + 1, startColumn: node.startPosition.column + 1, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1 }; }
function unsupported(node, detail = null) { return new Error(`unsupported C construct '${node.type}' at line ${node.startPosition.row + 1}${detail ? `: ${detail}` : ''}`); }
