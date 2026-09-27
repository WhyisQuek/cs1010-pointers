/** Tree-sitter node helpers, source locations and parse errors. */

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

export function syntaxError(node) {
  const line = node.startPosition.row + 1;
  // A MISSING node has no source text; name the token the grammar expected instead.
  if (node.isMissing) return new Error(`C syntax error near line ${line}: missing ${node.type}`);
  return new Error(`C syntax error near line ${line}: "${node.text.slice(0, 50)}"`);
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
  };
}

export function unsupported(node, detail = null) {
  return new Error(
    `unsupported C construct '${node.type}' at line ${node.startPosition.row + 1}${detail ? `: ${detail}` : ''}`,
  );
}
