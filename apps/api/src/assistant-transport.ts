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
      { role: 'system', content: 'Protocol ' + (expected.protocol??assistantVersion) + '\n' + prompt + '\nJSON Schema:\n' + JSON.stringify(compactAssistantSchema(schema)) },
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
  return root;
}
