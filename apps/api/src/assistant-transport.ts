import { createBenchmarkTransport } from './benchmark-transport.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { AssistantModel, CompletionInput } from './assistant-workflow.ts';

/** Explicit credentials/fetch only. No environment key lookup or runtime
 * enablement. Reuses the existing strict HTTP/usage/unknown-delivery parser. */
export function createCloudAssistantModel(credentials: unknown, fetcher: typeof fetch): AssistantModel {
  let expected: CompletionInput | undefined;
  const transport = createBenchmarkTransport('cloud-oss', credentials, fetcher, 'empty-tools', (_candidate, bound, prompt, input, schema) => {
    if (!expected || prompt !== expected.prompt || input !== expected.input || schema !== expected.schema) throw Error('ASSISTANT_TRANSPORT_CHANGED');
    return JSON.stringify({ model: bound.modelVersion, messages: [
      { role: 'system', content: 'Protocol ' + (expected.protocol??assistantVersion) + '\n' + prompt + '\nJSON Schema:\n' + JSON.stringify(schema) },
      { role: 'user', content: JSON.stringify(input) },
    ], temperature: 0, stream: false, n: 1, max_completion_tokens: bound.outputTokens, response_format: { type: 'json_object' } });
  });
  let running = false;
  return { bound: transport.bound, async complete(input, beforeDispatch) {
    if(input.protocol!==undefined&&input.protocol!=='cashneuro-category-classification/3')throw Error('ASSISTANT_TRANSPORT_CHANGED');
    if (running) throw Error('ASSISTANT_CONCURRENT_DISPATCH'); running = true; expected = input;
    try { const r = await transport.complete(input.prompt, input.input, input.schema, beforeDispatch); return { value: r.value, usage: r.usage }; }
    finally { expected = undefined; running = false; }
  } };
}
