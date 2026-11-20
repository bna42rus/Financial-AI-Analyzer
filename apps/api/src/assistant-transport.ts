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

/** Lossless local references share the exact same closed schemas between a
 * direct action and report steps. Server validation uses the original schema. */
export function compactAssistantSchema(schema: unknown): unknown {
  const root = structuredClone(schema) as any;
  const share = (plan: any, path: string) => {
    const p = plan?.properties, variants = p?.report?.properties?.steps?.items?.anyOf;
    if (!Array.isArray(variants)) return;
    for (const variant of variants) for (const field of ['context','changes','options','calculation','external','change']) {
      if (variant.properties?.[field] === p[field]) variant.properties[field] = { $ref: path + '/properties/' + field };
    }
  };
  share(root, '#');
  share(root?.properties?.plan, '#/properties/plan');
  return root;
}
