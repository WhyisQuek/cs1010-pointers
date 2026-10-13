/** Struct definitions and typedef aliases, collected before functions are parsed. */
import { INVALID, LIMIT, diagnostic } from '../diagnostics.js';
import { MAX_STRUCT_FIELDS } from '../limits.js';
import { structType } from '../types.js';
import { parseBaseType, parseDeclarator, requireCompleteAt } from './declarations.js';
import {
  isDeclaratorLike,
  semanticChildren,
  structBody,
  structName,
  invalidAt,
  unsupported,
  walkNodes,
} from './syntaxTree.js';

export function collectStructs(root) {
  const structs = {};
  const aliases = new Map();
  const aliasPositions = new Map();
  const definitionPositions = new Map();
  Object.defineProperty(structs, 'aliases', { value: aliases });
  Object.defineProperty(structs, 'aliasPositions', { value: aliasPositions });
  Object.defineProperty(structs, 'definitionPositions', { value: definitionPositions });
  for (const node of walkNodes(root)) {
    if (node.type !== 'type_definition') continue;
    if (node.parent?.type !== 'translation_unit')
      throw unsupported(node, 'block-scoped typedefs are not supported');
    const base = node.childForFieldName('type');
    const alias = node.childForFieldName('declarator');
    if (base?.type !== 'struct_specifier' || alias?.type !== 'type_identifier') {
      throw unsupported(node, 'only direct struct typedefs are supported');
    }
    if (aliases.has(alias.text)) throw unsupported(node, 'duplicate typedef name');
    aliases.set(alias.text, structName(base) ?? alias.text);
    aliasPositions.set(alias.text, alias.endIndex);
  }
  const definitionName = node =>
    structName(node) ??
    (node.parent?.type === 'type_definition'
      ? node.parent.childForFieldName('declarator')?.text
      : null);
  // Pass 1 reserves every named definition so fields may refer to themselves or
  // to a struct whose body appears later in the translation unit.
  const anonymous = new Set();
  for (const node of walkNodes(root)) {
    if (node.type !== 'struct_specifier' || !structBody(node)) continue;
    const owner = ['declaration', 'type_definition'].includes(node.parent?.type)
      ? node.parent.parent
      : node.parent;
    if (owner?.type !== 'translation_unit')
      throw unsupported(node, 'struct definitions must be at file scope');
    const name = definitionName(node);
    if (!name) throw unsupported(node, 'anonymous struct definitions are not supported');
    if (structs[name]) {
      // An anonymous typedef'd struct is stored under its alias, which C keeps apart from
      // tags; that collision is a subset limitation (audit B3), not a C redefinition.
      if (!structName(node) || anonymous.has(name))
        throw unsupported(node, `struct tag '${name}' collides with a typedef name`);
      throw invalidAt(node, `redefinition of struct tag '${name}'`);
    }
    if (!structName(node)) anonymous.add(name);
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
    if (fields.length > MAX_STRUCT_FIELDS)
      throw diagnostic(
        LIMIT,
        `struct ${name} has ${fields.length} fields; PointerViz limits structs to ${MAX_STRUCT_FIELDS}`,
      );
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f.name))
        throw diagnostic(INVALID, `duplicate field '${f.name}' in struct ${name}`);
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
    if (visiting.has(type.name))
      throw diagnostic(INVALID, `recursive by-value struct '${type.name}'`);
    const def = structs[type.name];
    if (!def?.fields?.length)
      throw diagnostic(INVALID, `incomplete or empty struct '${type.name}'`);
    for (const field of def.fields) checkComplete(field.type, new Set([...visiting, type.name]));
  }
  for (const def of Object.values(structs)) checkComplete(def);
  return structs;
}
