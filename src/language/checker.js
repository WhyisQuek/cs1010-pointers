/** Constraint checks run before execution, including branches that will be skipped. */
import { INT, isArray, isPointer, isPrimitive, isStruct, pointer, resolveStructType, sizeOf, typeEquals, typeToString } from './types.js';
import { SIZE_T, arithmeticType, convertNumber, isIntegerType, numericOperation, promote } from './numeric.js';
import { decodeCharLiteral } from './literals.js';
import { MAX_ARRAY_LENGTH } from './limits.js';

export function checkProgram(program) {
  const structs = Object.fromEntries((program.structs ?? []).map(t => [t.name, t]));
  const functions = new Map(program.functions.map(f => [f.name, f]));
  const visibleFunctions = new Set();
  if (functions.size !== program.functions.length) throw new Error('duplicate function definition');
  const decay = t => isArray(t) ? pointer(t.of) : t;
  const scalar = t => isPrimitive(t) || isPointer(t) || t.kind === 'null-pointer-constant';
  const fail = (e, message) => { throw new Error(`${message}${e.loc?.startLine ? ` (line ${e.loc.startLine})` : ''}`); };
  function lookup(env, name, e) {
    if (name === 'NULL') return INT;
    for (let scope = env; scope; scope = scope.parent) if (scope.names.has(name)) return scope.names.get(name);
    fail(e, `use of undeclared variable '${name}'`);
  }
  const scope = parent => ({ parent, names: new Map() });
  function declare(env, name, type, e) {
    if (name === 'NULL') fail(e, 'NULL is a predefined macro in PointerViz');
    if (env.names.has(name)) fail(e, `redeclaration of '${name}'`);
    env.names.set(name, type);
  }
  function constant(e, env) {
    if (e.kind === 'IntLiteral') return e.value;
    if (e.kind === 'CharLiteral') return decodeCharLiteral(e.raw);
    if (e.kind === 'Identifier' && e.name === 'NULL' || e.kind === 'NullLiteral') return 0;
    if (e.kind === 'SizeofType') return sizeOf(e.type, structs);
    if (e.kind === 'SizeofExpression') return sizeOf(expression(e.expression, env), structs);
    if (e.kind === 'Unary') {
      const n = constant(e.expression, env);
      return n === undefined ? undefined : e.operator === '!' ? Number(!n) : convertNumber(e.operator === '-' ? -n : n, expression(e, env), { arithmetic: true });
    }
    if (e.kind === 'Binary') {
      const a = constant(e.left, env), b = constant(e.right, env);
      if (a === undefined || b === undefined) return undefined;
      const at=expression(e.left,env), bt=expression(e.right,env);
      if(['+','-','*','/','%'].includes(e.operator)) return numericOperation(e.operator,{type:at,value:{kind:'scalar',value:a}},{type:bt,value:{kind:'scalar',value:b}}).value.value;
      const type=arithmeticType(at,bt), x=convertNumber(a,type), y=convertNumber(b,type);
      const operations = { '==': () => Number(x===y), '!=': () => Number(x!==y), '<': () => Number(x<y), '<=': () => Number(x<=y), '>': () => Number(x>y), '>=': () => Number(x>=y), '&&': () => Number(Boolean(x)&&Boolean(y)), '||': () => Number(Boolean(x)||Boolean(y)) };
      return operations[e.operator]?.();
    }
    return undefined;
  }
  function compatible(to, from, e, env) {
    from = decay(from);
    if (isPrimitive(to) && isPrimitive(from)) return;
    if (isStruct(to) && typeEquals(to, from)) return;
    if (isPointer(to)) {
      if (typeEquals(to, from) || from.kind === 'null-pointer-constant') return;
      if (isIntegerType(from) && constant(e, env) === 0) return;
      if (e.kind === 'Call' && e.name === 'malloc') return;
      if (isPointer(from)) fail(e, 'incompatible pointer types');
    }
    fail(e, `cannot assign ${typeToString(from)} to ${typeToString(to)}`);
  }
  function lvalue(e, env, assign = true) {
    if (!['Identifier', 'Dereference', 'Subscript', 'Member'].includes(e.kind)) fail(e, 'expression is not assignable');
    if (e.kind === 'Identifier' && e.name === 'NULL') fail(e, 'NULL is not an lvalue');
    const type = expression(e, env);
    if (assign && isArray(type)) fail(e, 'arrays are not assignable');
    if (e.kind === 'Member' && !e.viaPointer) lvalue(e.object, env, false);
    return type;
  }
  function binary(op, a, b, e, env) {
    a=decay(a); b=decay(b);
    if (['&&','||'].includes(op)) {
      if (!scalar(a) || !scalar(b)) fail(e, 'logical operator requires scalar operands');
      return INT;
    }
    if (['==','!=','<','<=','>','>='].includes(op)) {
      if (isPrimitive(a) && isPrimitive(b)) return INT;
      if (isPointer(a) && isPointer(b) && typeEquals(a,b)) return INT;
      if (['==','!='].includes(op)) {
        if (isPointer(a) && (b.kind === 'null-pointer-constant' || isIntegerType(b) && constant(e.right,env)===0)) return INT;
        if (isPointer(b) && (a.kind === 'null-pointer-constant' || isIntegerType(a) && constant(e.left,env)===0)) return INT;
        if (a.kind === 'null-pointer-constant' && b.kind === 'null-pointer-constant') return INT;
      }
      fail(e, 'cannot compare incompatible operand types');
    }
    if (['+','-'].includes(op)) {
      if (isPointer(a) && isIntegerType(b)) return a;
      if (op==='+' && isIntegerType(a) && isPointer(b)) return b;
      if (op==='-' && isPointer(a) && typeEquals(a,b)) return { kind:'primitive', name:'long' };
    }
    if (!['+','-','*','/','%'].includes(op)) fail(e, `binary operator '${op}' is not supported`);
    if (!isPrimitive(a) || !isPrimitive(b)) fail(e, 'arithmetic requires numbers or a pointer and integer offset');
    if (op==='%' && (!isIntegerType(a) || !isIntegerType(b))) fail(e, 'remainder requires integer operands');
    return arithmeticType(a,b);
  }
  function expression(e, env) {
    switch(e.kind) {
      case 'Identifier': return lookup(env,e.name,e);
      case 'IntLiteral': case 'FloatLiteral': return e.type ?? INT;
      case 'CharLiteral': decodeCharLiteral(e.raw); return INT;
      case 'NullLiteral': return INT;
      case 'AddressOf': return pointer(lvalue(e.expression,env,false));
      case 'Dereference': {
        const t=decay(expression(e.expression,env));
        if(!isPointer(t)) fail(e,'cannot dereference non-pointer');
        return t.to;
      }
      case 'Subscript': {
        const a=decay(expression(e.array,env)), b=decay(expression(e.index,env));
        if(isPointer(a)&&isIntegerType(b)) return a.to;
        if(isPointer(b)&&isIntegerType(a)) return b.to;
        fail(e,'subscript requires pointer and integer'); break;
      }
      case 'Member': {
        let t=expression(e.object,env);
        if(e.viaPointer) {t=decay(t);if(!isPointer(t)) fail(e,"'->' requires pointer to struct");t=t.to;}
        if(!isStruct(t)) fail(e,'member access requires struct');
        const field=resolveStructType(t,structs).fields?.find(f=>f.name===e.field);
        if(!field) fail(e,`struct ${t.name} has no field '${e.field}'`);
        return field.type;
      }
      case 'Assignment': {
        const lhs=lvalue(e.left,env), rhs=expression(e.right,env);
        if(e.operator==='=') compatible(lhs,rhs,e.right,env);
        else { const result=binary(e.operator.slice(0,-1),lhs,rhs,e,env); compatible(lhs,result,e,env); }
        return lhs;
      }
      case 'Update': {
        const type=lvalue(e.expression,env);
        if(!scalar(type)) fail(e,'update requires scalar lvalue');
        return type;
      }
      case 'Unary': {
        const type=decay(expression(e.expression,env));
        if(e.operator==='!') {if(!scalar(type)) fail(e,'logical operator requires scalar');return INT;}
        if(!isPrimitive(type)) fail(e,'unary arithmetic requires number');
        return promote(type);
      }
      case 'Binary': return binary(e.operator,expression(e.left,env),expression(e.right,env),e,env);
      case 'SizeofType': sizeOf(e.type,structs); return SIZE_T;
      case 'SizeofExpression': {
        const type = expression(e.expression,env);
        if (isArray(type) && type.length === null) fail(e, 'sizeof requires a complete array type');
        sizeOf(type,structs); return SIZE_T;
      }
      case 'Call': {
        for(let s=env;s;s=s.parent) if(s.names.has(e.name)) fail(e,`called object '${e.name}' is not a function`);
        const args=e.arguments.map(a=>expression(a,env));
        if(e.name==='malloc'||e.name==='free') {
          if(args.length!==1) fail(e,`${e.name} expects exactly one argument`);
          if(e.name==='malloc') {if(!isIntegerType(args[0])) fail(e,'malloc size must be integer');return pointer({kind:'void'});}
          if(!isPointer(decay(args[0]))&&args[0].kind!=='null-pointer-constant'&&!(isIntegerType(args[0])&&constant(e.arguments[0],env)===0)) fail(e,'free expects a pointer or NULL');
          return {kind:'void'};
        }
        const fn=functions.get(e.name);
        if(!fn) fail(e,`call to unknown function '${e.name}'`);
        if(!visibleFunctions.has(e.name)) fail(e,`function '${e.name}' must be defined before use; prototypes are not supported`);
        if(args.length!==fn.params.length) fail(e,`${e.name} expects ${fn.params.length} argument(s), got ${args.length}`);
        args.forEach((arg,i)=>compatible(fn.params[i].type,arg,e.arguments[i],env));
        return fn.returnType;
      }
      default: fail(e,`unsupported expression ${e.kind}`);
    }
  }
  function initializer(type,e,env) {
    if(e.kind!=='InitializerList') {compatible(type,expression(e,env),e,env);return;}
    if(!e.elements.length) fail(e,'empty initializer lists are not supported in the C11 subset');
    function consume(t, elements, cursor) {
      const inferLength = isArray(t) && t.length === null;
      const members=isArray(t)?Array(inferLength ? MAX_ARRAY_LENGTH : t.length).fill(t.of):isStruct(t)?resolveStructType(t,structs).fields.map(f=>f.type):[t];
      let count = 0;
      for(const member of members) {
        if(cursor.i>=elements.length) break;
        count++;
        const child=elements[cursor.i];
        if(child.kind==='InitializerList') {cursor.i++;initializer(member,child,env);}
        else if(isArray(member)||isStruct(member)&&!typeEquals(member,expression(child,env))) consume(member,elements,cursor);
        else {cursor.i++;compatible(member,expression(child,env),child,env);}
      }
      if (inferLength) {
        if (cursor.i < elements.length) fail(e, `array size must be between 1 and ${MAX_ARRAY_LENGTH}`);
        t.length = count;
      }
    }
    const cursor={i:0};consume(type,e.elements,cursor);
    if(cursor.i<e.elements.length) fail(e,'too many initializers');
  }
  function statement(s,env,fn,depth=0) {
    switch(s.kind) {
      case 'Empty': return;
      case 'Declaration': for(const d of s.declarations){declare(env,d.name,d.type,d);if(d.initializer)initializer(d.type,d.initializer,env);} return;
      case 'ExpressionStatement': expression(s.expression,env);return;
      case 'Block': {const local=scope(env);s.statements.forEach(s=>statement(s,local,fn,depth));return;}
      case 'Return': if(fn.returnType.kind==='void'){if(s.expression)fail(s,'void function cannot return a value');} else {if(!s.expression)fail(s,'non-void function must return a value');compatible(fn.returnType,expression(s.expression,env),s.expression,env);}return;
      case 'Break': case 'Continue': if(!depth)fail(s,`${s.kind.toLowerCase()} used outside a loop`);return;
      case 'If': if(!scalar(decay(expression(s.condition,env))))fail(s,'condition requires scalar');statement(s.consequence,env,fn,depth);if(s.alternative)statement(s.alternative,env,fn,depth);return;
      case 'While': if(!scalar(decay(expression(s.condition,env))))fail(s,'condition requires scalar');statement(s.body,env,fn,depth+1);return;
      case 'For': {const local=scope(env);if(s.initializer)statement(s.initializer,local,fn,depth);if(s.condition&&!scalar(decay(expression(s.condition,local))))fail(s,'condition requires scalar');if(s.update)expression(s.update,local);statement(s.body,local,fn,depth+1);return;}
      default: fail(s,`unsupported statement ${s.kind}`);
    }
  }
  for(const fn of program.functions) {
    visibleFunctions.add(fn.name);
    const env=scope(null);
    if(fn.name==='main'&&(!typeEquals(fn.returnType,INT)||fn.params.length)) fail(fn,'PointerViz requires int main(void)');
    fn.params.forEach(p=>declare(env,p.name,p.type,p));
    fn.statements.forEach(s=>statement(s,env,fn));
  }
}
