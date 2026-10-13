/** Base types, (abstract) declarators and declarations -> PointerViz types and Declaration nodes. */
import { INVALID, LIMIT, diagnostic } from '../diagnostics.js';
import { MAX_ARRAY_LENGTH } from '../limits.js';
import { array, isSupportedPrimitiveName, pointer, primitive, structRef } from '../types.js';
import { parseExpression } from './expressions.js';
import { parseIntegerLiteral } from './numberLiterals.js';
import {
  hidesTypedef,
  invalidAt,
  isDeclaratorLike,
  locOf,
  semanticChildren,
  structName,
  unsupported,
  withLoc,
} from './syntaxTree.js';

export function parseDeclaration(node, structTypes) {
  const typeNode = node.childForFieldName('type') ?? semanticChildren(node)[0];
  const base = parseBaseType(typeNode, structTypes);
  const declarations = [];
  for (const child of node.namedChildren) {
    if (
      child === typeNode ||
      child.type === 'storage_class_specifier' ||
      child.type === 'type_qualifier'
    )
      continue;
    if (!isDeclaratorLike(child)) continue;
    let declarator = child,
      initializer = null;
    if (child.type === 'init_declarator') {
      declarator = child.childForFieldName('declarator');
      initializer = child.childForFieldName('value');
    }
    const info = parseDeclarator(declarator, base, structTypes, {
      inferArrayLength: ['initializer_list', 'string_literal', 'concatenated_string'].includes(
        initializer?.type,
      ),
    });
    requireCompleteAt(info.type, declarator, structTypes);
    declarations.push({
      name: info.name,
      type: info.type,
      initializer: initializer ? parseExpression(initializer, structTypes) : null,
      loc: locOf(child),
    });
  }
  if (!declarations.length) throw unsupported(node, 'declaration without a supported declarator');
  return withLoc({ kind: 'Declaration', declarations }, node);
}

/** `void` is accepted here; requireCompleteAt rejects objects of type void. */
export function parseBaseType(node, structTypes) {
  if (!node) throw new Error('missing type');
  const text = node.text.trim();
  if (text === 'void') return { kind: 'void' };
  if (isSupportedPrimitiveName(text)) return primitive(text);
  if (node.type === 'type_identifier' && structTypes.aliases?.has(text)) {
    if (node.startIndex < structTypes.aliasPositions.get(text))
      throw invalidAt(node, `typedef '${text}' is not declared yet`);
    if (hidesTypedef(node, text))
      throw invalidAt(node, `'${text}' names a variable here, which hides the typedef`);
    const tag = structTypes.aliases.get(text);
    // A typedef of a struct that is never defined names an incomplete type.
    return { ...(structTypes[tag] ?? structRef(tag)), alias: text };
  }
  if (node.type === 'struct_specifier' || /^struct\s+/.test(text)) {
    const name = structName(node) ?? text.match(/^struct\s+([A-Za-z_]\w*)/)?.[1];
    if (!name) throw unsupported(node, 'anonymous struct types are not supported');
    // `struct T` without a definition is an incomplete type (C23 6.7.2.3): pointers to it
    // are fine, while objects, sizeof and member access are rejected where it is used.
    return structTypes[name] ?? structRef(name);
  }
  throw unsupported(node, `type '${text}' is not in the current Mini-C subset`);
}

export function parseDeclarator(
  node,
  baseType,
  structTypes,
  { field = false, inferArrayLength = false, parameter = false } = {},
) {
  if (!node) throw new Error('missing declarator');
  if (node.type === 'identifier' || node.type === 'field_identifier')
    return { name: node.text, type: structuredClone(baseType) };
  if (node.type === 'pointer_declarator' || node.type === 'abstract_pointer_declarator') {
    const inner = node.childForFieldName('declarator') ?? node.namedChildren.at(-1);
    return parseDeclarator(inner, pointer(referenceSafeType(baseType)), structTypes, {
      field,
      inferArrayLength,
      parameter,
    });
  }
  if (node.type === 'array_declarator') {
    const inner = node.childForFieldName('declarator') ?? semanticChildren(node)[0];
    const sizeNode = node.childForFieldName('size');
    if (!sizeNode) {
      let name = inner;
      while (name.type === 'parenthesized_declarator') name = semanticChildren(name)[0];
      if (!(inferArrayLength || parameter) || name.type !== 'identifier') {
        throw unsupported(
          node,
          parameter
            ? 'only the outermost array size may be omitted in a parameter'
            : 'only the outermost array size may be omitted, and it requires an initializer list',
        );
      }
      // Parameters adjust this to a pointer; otherwise the checker completes it
      // while consuming the initializer, so nested braces, brace elision and
      // struct-valued expressions count correctly.
      return parseDeclarator(
        inner,
        { kind: 'array', of: structuredClone(baseType), length: null },
        structTypes,
        { field, inferArrayLength, parameter },
      );
    }
    if (sizeNode.type !== 'number_literal')
      throw unsupported(node, 'array size must be a positive integer literal');
    const length = parseIntegerLiteral(sizeNode.text);
    assertArrayLength(length, sizeNode);
    return parseDeclarator(inner, array(baseType, length), structTypes, {
      field,
      inferArrayLength,
      parameter,
    });
  }
  if (node.type === 'parenthesized_declarator') {
    return parseDeclarator(semanticChildren(node)[0], baseType, structTypes, {
      field,
      inferArrayLength,
      parameter,
    });
  }
  throw unsupported(node, `unsupported declarator '${node.type}'`);
}

/** Self-referential pointer fields only need the named tag, not an embedded body. */
export function requireCompleteAt(type, node, structs) {
  if (type.kind === 'array') return requireCompleteAt(type.of, node, structs);
  if (type.kind === 'void') throw invalidAt(node, 'an object cannot have type void');
  const definedAt = structs.definitionPositions.get(type.name);
  if (type.kind === 'struct' && !(definedAt <= node.startIndex)) {
    throw invalidAt(node, `struct '${type.name}' is incomplete at this declaration`);
  }
}

export function referenceSafeType(type) {
  return type.kind === 'struct'
    ? { ...structRef(type.name), ...(type.alias ? { alias: type.alias } : {}) }
    : type;
}

export function parseAbstractDeclarator(node, base, structTypes) {
  if (node.type === 'abstract_parenthesized_declarator')
    return parseAbstractDeclarator(semanticChildren(node)[0], base, structTypes);
  if (node.type === 'abstract_pointer_declarator' || node.type === 'pointer_declarator') {
    const inner = node.childForFieldName('declarator') ?? node.namedChildren.at(-1);
    const next = pointer(referenceSafeType(base));
    return inner ? parseAbstractDeclarator(inner, next, structTypes) : next;
  }
  if (node.type === 'abstract_array_declarator' || node.type === 'array_declarator') {
    const sizeNode = node.childForFieldName('size');
    if (!sizeNode || sizeNode.type !== 'number_literal')
      throw unsupported(node, 'sizeof array type needs literal size');
    const length = parseIntegerLiteral(sizeNode.text);
    assertArrayLength(length, sizeNode);
    const inner = node.childForFieldName('declarator');
    const arr = array(base, length);
    return inner ? parseAbstractDeclarator(inner, arr, structTypes) : arr;
  }
  throw unsupported(node, 'unsupported abstract declarator');
}

function assertArrayLength(length, node) {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARRAY_LENGTH) {
    // C requires a positive size; the upper bound is a simulator limit.
    throw diagnostic(
      Number.isSafeInteger(length) && length <= 0 ? INVALID : LIMIT,
      `array size must be between 1 and ${MAX_ARRAY_LENGTH} (line ${node.startPosition.row + 1})`,
    );
  }
}
