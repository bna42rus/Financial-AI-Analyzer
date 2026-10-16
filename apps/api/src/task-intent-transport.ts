import { taskIntentPrompt, taskIntentSchema } from '../../../packages/analyzer/src/task-intent.ts';
import { safeQuestion } from '../../../packages/analyzer/src/yandex-contract.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { benchmarkDigest } from './benchmark-ledger.ts';
import { benchmarkRequestBody, BenchmarkFailure, createBenchmarkTransport, replayOnlyBenchmarkTransport } from './benchmark-transport.ts';
import type { BenchmarkTransport } from './benchmark-transport.ts';
import { factorPromptSchema } from './task-prepared-contract.ts';
import { createTaskJsonTransport } from './task-json-transport.ts';

export const intentWireVersion = 'cashneuro-task-intent-json/1';
export const intentRequestBody: typeof benchmarkRequestBody = (candidate, bound, prompt, raw, schema) => {
  if (candidate !== 'cloud-oss' || bound.modelVersion !== 'openai/gpt-oss-120b' || bound.inputTokens !== 131072 || bound.outputTokens !== 1200 ||
      prompt !== taskIntentPrompt || benchmarkDigest(schema) !== benchmarkDigest(taskIntentSchema)) throw new BenchmarkFailure('TASK_INTENT_CONTRACT_INVALID');
  const input = object(raw, ['question', 'hasFinancialTasks']);
  if (safeQuestion(input.question) !== input.question || typeof input.hasFinancialTasks !== 'boolean') throw new BenchmarkFailure('TASK_INTENT_INPUT_INVALID');
  return JSON.stringify({ model: bound.modelVersion, messages: [
    { role: 'system', content: taskIntentPrompt + '\nJSON Schema:\n' + JSON.stringify(factorPromptSchema(taskIntentSchema)) },
    { role: 'user', content: JSON.stringify(input) },
  ], temperature: 0, stream: false, n: 1, max_completion_tokens: bound.outputTokens, response_format: { type: 'json_object' } });
};
export const createIntentTransport = (credentials: unknown, fetcher: typeof fetch = fetch) => createBenchmarkTransport('cloud-oss', credentials, fetcher, 'empty-tools', intentRequestBody);
export const createCapturedIntentTransport = (credentials: unknown, fetcher: typeof fetch = fetch) => createTaskJsonTransport(credentials, fetcher, intentRequestBody);
export function replayIntentTransport(): BenchmarkTransport {
  const base = replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools');
  return { ...base, requestBody: (prompt: string, input: unknown, schema: unknown) => intentRequestBody('cloud-oss', base.bound, prompt, input, schema) };
}
