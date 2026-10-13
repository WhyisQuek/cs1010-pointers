/** Tree-sitter node helpers, source locations and parse errors. */
import { INVALID, UNSUPPORTED, diagnostic } from '../diagnostics.js';

export function structName(node) {
  if (!node) return null;
  const named = node.childForFieldName?.('name');
  if (named) return named.text;
  const tag = node.namedChildren?.find(c => c.type === 'type_identifier');
  return tag?.text ?? node.text.match(/^struct\s+([A-Za-z_]\w*)/)?.[1] ?? null;
}

export function structBody(node) {
  return (
    node.childForFieldName?.('body') ??
    node.namedChildren?.find(c => c.type === 'field_declaration_list') ??
    null
  );
}

export function* walkNodes(node) {
  yield node;
  for (const c of node.namedChildren ?? []) yield* walkNodes(c);
}

export function semanticChildren(node) {
  return (node?.namedChildren ?? []).filter(c => c.type !== 'comment');
}

/** The identifier a (possibly nested) declarator declares, or null. */
function declaredIdentifier(node) {
  while (node && node.type !== 'identifier') {
    if (!isDeclaratorLike(node)) return null;
    node = node.childForFieldName('declarator') ?? semanticChildren(node)[0];
  }
  return node;
}

/** Whether a declaration or parameter list among `nodes` declares `name` before `offset`. */
function declaresBefore(nodes, name, offset) {
  return nodes.some(
    n =>
      ['declaration', 'parameter_declaration'].includes(n.type) &&
      n.namedChildren.some(child => {
        const id = declaredIdentifier(child);
        return id?.text === name && id.endIndex <= offset;
      }),
  );
}

/**
 * Whether an ordinary identifier `name` declared in an enclosing block, for-loop or parameter
 * list is in scope at `node`. Such a declaration hides a file-scope typedef of the same name
 * (C23 6.2.1p4), so `sizeof(name)` then means the object, not the type.
 */
export function hidesTypedef(node, name) {
  const offset = node.startIndex;
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type === 'compound_statement' || scope.type === 'for_statement') {
      if (declaresBefore(scope.namedChildren, name, offset)) return true;
    } else if (scope.type === 'function_definition') {
      let declarator = scope.childForFieldName('declarator');
      while (declarator && declarator.type !== 'function_declarator')
        declarator = declarator.childForFieldName('declarator');
      const parameters = declarator?.childForFieldName('parameters')?.namedChildren ?? [];
      return declaresBefore(parameters, name, offset);
    }
  }
  return false;
}

export function isDeclaratorLike(node) {
  return (
    node &&
    (node.type === 'identifier' ||
      node.type === 'field_identifier' ||
      node.type === 'init_declarator' ||
      node.type.endsWith('declarator'))
  );
}

export function firstError(node) {
  if (node.type === 'ERROR' || node.isMissing) return node;
  for (const c of node.children) {
    const e = firstError(c);
    if (e) return e;
  }
  return null;
}

/** C23 syntax the bundled Tree-sitter grammar cannot parse; its errors are not invalid C. */
const UNPARSED_C23 = /\b(typeof|typeof_unqual|_BitInt|auto|_Decimal(?:32|64|128))\b|#\s*embed\b/;

export function syntaxError(node, source = '') {
  const line = node.startPosition.row + 1;
  const c23 = source.split('\n')[line - 1]?.match(UNPARSED_C23);
  if (c23) return diagnostic(UNSUPPORTED, `C23 syntax '${c23[1] ?? '#embed'}' near line ${line}`);
  // A MISSING node has no source text; name the token the grammar expected instead.
  if (node.isMissing)
    return diagnostic(INVALID, `C syntax error near line ${line}: missing ${node.type}`);
  return diagnostic(INVALID, `C syntax error near line ${line}: "${node.text.slice(0, 50)}"`);
}

export function operatorOf(node) {
  return (
    node.childForFieldName?.('operator')?.text ??
    [...Array(node.childCount).keys()].map(i => node.child(i)).find(c => c && !c.isNamed)?.text ??
    ''
  );
}

export function operatorToken(node) {
  let out = '';
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c.isNamed) out += c.text;
  }
  return out;
}

export function withLoc(obj, node) {
  return { ...obj, loc: locOf(node) };
}

export function locOf(node) {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
    // Source offset, for rules that depend on what is declared before this point.
    offset: node.startIndex,
  };
}

export function unsupported(node, detail = null) {
  return diagnostic(
    UNSUPPORTED,
    `unsupported C construct '${node.type}' at line ${node.startPosition.row + 1}${detail ? `: ${detail}` : ''}`,
  );
}

/** A constraint violation found while parsing, such as a duplicate definition. */
export function invalidAt(node, message) {
  return diagnostic(INVALID, `${message} (line ${node.startPosition.row + 1})`);
}
