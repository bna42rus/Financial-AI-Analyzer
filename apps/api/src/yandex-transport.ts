import { object } from '../../../packages/finance-core/src/model.ts';
import { email } from './types.ts';
import { tokenUsage } from '../../../packages/analyzer/src/registry.ts';

export const yandexEndpoint = 'https://ai.api.cloud.yandex.net/foundationModels/v1/completion';
export class YandexFailure extends Error { constructor(public code: string, public unknownOutcome = false) { super(code); } }
export type YandexSettings = { realm: 'staging/finance'; apiKey: string; modelUri: string; allowedEmails: string[]; maxDailyCalls: number; maxTokens: number; timeoutMs: number };
export type Completion = { value: unknown; inputTokens: number; outputTokens: number; modelVersion: string };
export type YandexTransport = { model: string; dailyLimit: number; allowed(email: string): boolean; complete(prompt: string, input: unknown, schema: unknown): Promise<Completion> };
const transports = new WeakSet<object>();
export function isYandexTransport(value: unknown): value is YandexTransport { return !!value && typeof value === 'object' && transports.has(value); }
export function yandexSettings(value: unknown): YandexSettings {
  try {
    const r = object(value, ['realm', 'apiKey', 'modelUri', 'allowedEmails', 'maxDailyCalls', 'maxTokens', 'timeoutMs']);
    if (r.realm !== 'staging/finance' || typeof r.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(r.apiKey) ||
      typeof r.modelUri !== 'string' || !/^gpt:\/\/[a-z0-9]{20}\/(?:aliceai-llm|yandexgpt-5\.1|yandexgpt-5-pro|yandexgpt-5-lite)$/.test(r.modelUri) ||
      !Array.isArray(r.allowedEmails) || r.allowedEmails.length < 1 || r.allowedEmails.length > 5) throw new Error();
    const allowedEmails = r.allowedEmails.map(email); if (new Set(allowedEmails).size !== allowedEmails.length) throw new Error();
    for (const [key, min, max] of [['maxDailyCalls', 1, 30], ['maxTokens', 128, 2048], ['timeoutMs', 1000, 10000]] as const)
      if (!Number.isInteger(r[key]) || Number(r[key]) < min || Number(r[key]) > max) throw new Error();
    return { realm: r.realm, apiKey: r.apiKey, modelUri: r.modelUri, allowedEmails, maxDailyCalls: Number(r.maxDailyCalls), maxTokens: Number(r.maxTokens), timeoutMs: Number(r.timeoutMs) };
  } catch { throw new YandexFailure('AI_CONFIGURATION_DENIED'); }
}
export function createYandexTransport(settings: YandexSettings, fetcher: typeof fetch = fetch): YandexTransport {
  const config = yandexSettings(settings);
  const transport: YandexTransport = {
    model: config.modelUri, dailyLimit: config.maxDailyCalls, allowed: address => config.allowedEmails.includes(email(address)),
    async complete(prompt, input, schema) {
      const body = JSON.stringify({ modelUri: config.modelUri, completionOptions: { stream: false, temperature: 0, maxTokens: String(config.maxTokens), reasoningOptions: { mode: 'DISABLED' } },
        messages: [{ role: 'system', text: prompt }, { role: 'user', text: JSON.stringify(input) }], jsonSchema: { schema } });
      if (Buffer.byteLength(body) > 65536) throw new YandexFailure('AI_CONTEXT_LIMIT');
      let response: Response;
      try { response = await fetcher(yandexEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: 'Api-Key ' + config.apiKey, 'x-folder-id': config.modelUri.split('/')[2]!, 'x-data-logging-enabled': 'false' }, body }); }
      catch { throw new YandexFailure('AI_DELIVERY_UNKNOWN', true); }
      if (!response.ok) { await response.body?.cancel(); throw new YandexFailure([401, 403].includes(response.status) ? 'AI_IDENTITY_DENIED' : response.status === 429 ? 'AI_PROVIDER_LIMIT' : 'AI_PROVIDER_UNAVAILABLE'); }
      const reader = response.body?.getReader(); if (!reader) throw new YandexFailure('AI_RESPONSE_INVALID');
      let size = 0; const parts: Uint8Array[] = [];
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); throw new Error(); } parts.push(value); } }
      catch { throw new YandexFailure('AI_DELIVERY_UNKNOWN', true); }
      try {
        const decoded = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const result = decoded?.result === undefined ? decoded : object(decoded, ['result']).result;
        const r = object(result, ['alternatives', 'usage', 'modelVersion']);
        if (!Array.isArray(r.alternatives) || r.alternatives.length !== 1 || typeof r.modelVersion !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(r.modelVersion)) throw new Error();
        const alternative = object(r.alternatives[0], ['message', 'status']), message = object(alternative.message, ['role', 'text']);
        if (alternative.status !== 'ALTERNATIVE_STATUS_FINAL' || message.role !== 'assistant' || typeof message.text !== 'string' || message.text.length > 16384) throw new Error();
        const usage = object(r.usage, ['inputTextTokens', 'completionTokens', 'totalTokens', 'completionTokensDetails']);
        const tokens = (v: unknown) => { if (typeof v !== 'string' || !/^\d{1,7}$/.test(v)) throw new Error(); return tokenUsage(Number(v)); };
        const inputTokens = tokens(usage.inputTextTokens), outputTokens = tokens(usage.completionTokens);
        if (tokens(usage.totalTokens) !== inputTokens + outputTokens) throw new Error();
        return { value: JSON.parse(message.text), inputTokens, outputTokens, modelVersion: r.modelVersion };
      } catch { throw new YandexFailure('AI_RESPONSE_INVALID'); }
    },
  };
  transports.add(transport); return transport;
}
