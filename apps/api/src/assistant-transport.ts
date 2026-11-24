import { createBenchmarkTransport } from './benchmark-transport.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { AssistantModel, CompletionInput } from './assistant-workflow.ts';

/** Explicit credentials/fetch only. No environment key lookup or runtime
 * enablement. Reuses the existing strict HTTP/usage/unknown-delivery parser. */
export function createCloudAssistantModel(credentials: unknown, fetcher: typeof fetch, purpose: 'assistant'|'classification' = 'assistant'): AssistantModel {
  let expected: CompletionInput | undefined;
  const transport = createBenchmarkTransport('cloud-oss', credentials, fetcher, 'empty-tools', (_candidate, bound, prompt, input, schema) => {
    if (!expected || prompt !== expected.prompt || input !== expected.input || schema !== expected.schema) throw Error('ASSISTANT_TRANSPORT_CHANGED');
    return JSON.stringify({ model: bound.modelVersion, messages: [
      { role: 'system', content: 'Protocol ' + (expected.protocol??assistantVersion) + '\n' + prompt + '\n' + (purpose==='assistant'?assistantSchemaGuide(schema):'JSON Schema:\n'+JSON.stringify(compactAssistantSchema(schema))) },
      { role: 'user', content: JSON.stringify(input) },
    ], temperature: 0, stream: false, n: 1, max_completion_tokens: bound.outputTokens, response_format: { type: 'json_object' } });
  }, 90000, purpose === 'assistant' ? 98304 : 65536);
  // Reserve exactly the same output ceiling sent to HTTP. Classification
  // batches need more space than the bounded multi-step assistant plan.
  transport.bound.outputTokens=purpose==='classification'?4096:2400;
  Object.freeze(transport.bound);
  let running = false;
  return { bound: transport.bound, async complete(input, beforeDispatch) {
    if((input.protocol==='cashneuro-category-classification/4')!==(purpose==='classification'))throw Error('ASSISTANT_TRANSPORT_CHANGED');
    if(input.protocol!==undefined&&input.protocol!=='cashneuro-category-classification/4')throw Error('ASSISTANT_TRANSPORT_CHANGED');
    if (running) throw Error('ASSISTANT_CONCURRENT_DISPATCH'); running = true; expected = input;
    try { const r = await transport.complete(input.prompt, input.input, input.schema, beforeDispatch); return { value: r.value, usage: r.usage }; }
    finally { expected = undefined; running = false; }
  } };
}

/** Deduplicate identical schema nodes, including calculator continuations.
 * The server keeps the original closed schema; no constraint is removed. */
export function compactAssistantSchema(schema: unknown): unknown {
  const counts=new Map<string,number>(),nodes=new Map<string,any>();
  const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}if(typeof v.type==='string'||Array.isArray(v.anyOf)){const key=JSON.stringify(v);if(key.length>=96){counts.set(key,(counts.get(key)??0)+1);nodes.set(key,v);}}Object.values(v).forEach(walk);};
  walk(schema);
  const names=new Map([...counts].filter(([,count])=>count>1).map(([key],i)=>[key,'d'+(i+1)]));
  const convert=(v:any,definition?:string):any=>{if(!v||typeof v!=='object')return v;if(Array.isArray(v))return v.map(x=>convert(x));const key=JSON.stringify(v),name=names.get(key);if(name&&key!==definition)return {$ref:'#/$defs/'+name};return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,convert(x)]));};
  const root=convert(schema);
  if(names.size)root.$defs=Object.fromEntries([...names].map(([key,name])=>[name,convert(nodes.get(key),key)]));
  // A repeated parent can leave its children referenced only once. Inline
  // those definitions instead of paying for a definition and a reference.
  if(root.$defs)for(;;){
    const uses=new Map<string,number>();
    const count=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.$ref==='string')uses.set(v.$ref,(uses.get(v.$ref)??0)+1);Object.values(v).forEach(count);};count(root);
    const single=Object.entries(root.$defs).filter(([name])=>(uses.get('#/$defs/'+name)??0)<=1);if(!single.length)break;
    for(const [name,node]of single){delete root.$defs[name];const ref='#/$defs/'+name;const inline=(v:any):any=>{if(!v||typeof v!=='object')return v;if(v.$ref===ref)return node;for(const [key,x]of Object.entries(v))v[key]=inline(x);return v;};inline(root);}
  }
  return root;
}

/** This endpoint already receives its schema as plain system text, not native
 * JSON-Schema constrained decoding. Use familiar type notation to avoid
 * repeating JSON Schema's structural keywords. The original server validator
 * remains authoritative; every constraint is included and unknown vocabulary
 * falls back to the complete JSON Schema. Classification is unchanged. */
export function assistantSchemaGuide(schema:unknown):string{
  const compact=compactAssistantSchema(schema) as any;
  try{
    const render=(s:any):string=>{
      if(!s||typeof s!=='object'||Array.isArray(s))throw Error('UNSUPPORTED_SCHEMA');
      const {$defs:_defs,$ref,anyOf,type,properties,required,additionalProperties,items,enum:values,...constraints}=s;
      if(Object.keys(constraints).some(k=>!['minLength','maxLength','pattern','minimum','maximum','minItems','maxItems','uniqueItems'].includes(k)))throw Error('UNSUPPORTED_SCHEMA');
      let result:string;
      if($ref){if(Object.keys(s).length!==1||!/^#\/\$defs\/d\d+$/u.test($ref))throw Error('UNSUPPORTED_SCHEMA');return $ref.slice(8);}
      if(anyOf){if(Object.keys(s).some(k=>k!=='anyOf'&&k!=='$defs'))throw Error('UNSUPPORTED_SCHEMA');return '('+anyOf.map(render).join('|')+')';}
      if(values){if(type!=='string'||values.some((v:unknown)=>typeof v!=='string'))throw Error('UNSUPPORTED_SCHEMA');result='('+values.map((v:string)=>JSON.stringify(v)).join('|')+')';}
      else if(type==='object'){
        if(additionalProperties!==false||!properties||!Array.isArray(required)||required.some((k:string)=>!(k in properties)))throw Error('UNSUPPORTED_SCHEMA');
        result='{'+Object.entries(properties).map(([k,v])=>JSON.stringify(k)+(required.includes(k)?'':'?')+':'+render(v)).join(';')+'}';
      }else if(type==='array')result='Array<'+render(items)+'>';
      else if(['string','integer','number','boolean','null'].includes(type))result=type;
      else throw Error('UNSUPPORTED_SCHEMA');
      return Object.keys(constraints).length?'With<'+result+','+JSON.stringify(constraints)+'>':result;
    };
    const body='type Output='+render(compact)+';\n'+Object.entries(compact.$defs??{}).map(([k,v])=>'type '+k+'='+render(v)+';').join('\n');
    return 'Output contract in TypeScript notation. Return a JSON instance of Output, never code or types. Every object is CLOSED (no extra keys); ? marks an optional key, | alternatives, Array<T> arrays, integer an integer. With<T,C> means T with ALL JSON Schema constraints C, including length/range/pattern/uniqueness. Aliases only abbreviate types; do not output alias names.\n'+body;
  }catch{return 'JSON Schema:\n'+JSON.stringify(compact);}
}
