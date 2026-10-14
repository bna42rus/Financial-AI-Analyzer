import { object } from '../../../packages/finance-core/src/model.ts';
import { usageTokens } from '../../../packages/analyzer/src/cost.ts';
import type { TokenPrice, Usage, DispatchBound } from '../../../packages/analyzer/src/cost.ts';

// Experimental adapters only. They are deliberately not registered as runtime
// Yandex transports and cannot enable paid calls in Finance/Control services.
export const candidates = {
  'cloud-oss': { provider: 'cloud', model: 'openai/gpt-oss-120b', contextTokens: 131072,
    price: { version: 'cloud-internal-261002-oss120', currency: 'RUB', inputRubPerMillion: '15.86', outputRubPerMillion: '61' } },
  'cloud-giga': { provider: 'cloud', model: 'ai-sage/GigaChat3-10B-A1.8B', contextTokens: 262144,
    price: { version: 'cloud-internal-261002-giga3', currency: 'RUB', inputRubPerMillion: '12.2', outputRubPerMillion: '12.2' } },
  'yandex-qwen': { provider: 'yandex', model: 'qwen3.6-35b-a3b', contextTokens: 262144,
    price: { version: 'yandex-20261014-qwen36', currency: 'RUB', inputRubPerMillion: '200', outputRubPerMillion: '300' } },
} as const satisfies Record<string, { provider: string; model: string; contextTokens: number; price: TokenPrice }>;
export type Candidate = keyof typeof candidates;
export class BenchmarkFailure extends Error {
  code: string; usage?: Usage; fingerprint?: string; referencedParameters?: string[];
  constructor(code: string, usage?: Usage, fingerprint?: string) { super(code); this.code = code; this.usage = usage; this.fingerprint = fingerprint; }
}
export type BenchmarkResult = { value: unknown; usage: Usage; fingerprint: string | null; cachedTokens: number | null; reasoningTokens: number | null };
export type BenchmarkTransport = { candidate: Candidate; price: TokenPrice; bound: DispatchBound;
  complete(prompt: string, input: unknown, schema: unknown, reserve: () => Promise<void>): Promise<BenchmarkResult> };

// No credentials, fetch or reservation callback: a missing cached request fails.
export function replayOnlyBenchmarkTransport(candidate: Candidate): BenchmarkTransport {
  if (!Object.hasOwn(candidates, candidate)) throw new BenchmarkFailure('BENCH_CONFIGURATION_INVALID');
  const spec = candidates[candidate];
  return { candidate, price: spec.price, bound: { inputTokens: spec.contextTokens, outputTokens: 1200, modelVersion: spec.model },
    async complete() { throw new BenchmarkFailure('BENCH_REPLAY_ONLY'); } };
}

export function createBenchmarkTransport(candidate: Candidate, credentials: unknown, fetcher: typeof fetch = fetch): BenchmarkTransport {
  if (!Object.hasOwn(candidates, candidate)) throw new BenchmarkFailure('BENCH_CONFIGURATION_INVALID');
  const spec = candidates[candidate];
  const r = object(credentials, ['apiKey', 'folderId']);
  if (typeof r.apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(r.apiKey) ||
      (spec.provider === 'yandex' ? typeof r.folderId !== 'string' || !/^[a-z0-9]{20}$/.test(r.folderId) : r.folderId !== undefined)) throw new BenchmarkFailure('BENCH_CONFIGURATION_INVALID');
  const model = spec.provider === 'yandex' ? `gpt://${r.folderId}/${spec.model}` : spec.model;
  const endpoint = spec.provider === 'cloud' ? 'https://foundation-models.api.cloud.ru/v1/chat/completions' : 'https://ai.api.cloud.yandex.net/v1/chat/completions';
  const headers: Record<string, string> = spec.provider === 'cloud' ? { authorization: 'Bearer ' + r.apiKey } : {
    authorization: 'Api-Key ' + r.apiKey, 'OpenAI-Project': String(r.folderId), 'x-data-logging-enabled': 'false' };
  // No unverified bytes/4 estimate: reserve the complete documented context
  // window. In particular Qwen cannot fit the 45 RUB smoke-phase reservation.
  const bound = { inputTokens: spec.contextTokens, outputTokens: 1200, modelVersion: model };
  return { candidate, price: spec.price, bound,
    async complete(prompt, input, schema, reserve) {
      const body = JSON.stringify({ model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }],
        temperature: 0, stream: false, n: 1,
        ...(spec.provider === 'cloud' ? { max_completion_tokens: bound.outputTokens } : { max_tokens: bound.outputTokens }),
        response_format: { type: 'json_schema', json_schema: { name: 'cashneuro_benchmark', schema } } });
      if (Buffer.byteLength(body) > 65536) throw new BenchmarkFailure('BENCH_CONTEXT_LIMIT');
      await reserve(); // durable reservation must precede every possible dispatch
      let response: Response;
      try { response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
      catch { throw new BenchmarkFailure('BENCH_DELIVERY_UNKNOWN'); }
      if (!response.ok) {
        // Preserve only the numeric HTTP status, never an untrusted error body.
        const code = [401, 403].includes(response.status) ? 'BENCH_IDENTITY_DENIED' : 'BENCH_PROVIDER_FAILURE';
        const failure = new BenchmarkFailure(`${code}_HTTP_${response.status}`);
        const reader = response.body?.getReader();
        try {
          if (reader) {
            const parts: Uint8Array[] = []; let bytes = 0;
            while (true) {
              const part = await reader.read(); if (part.done) break;
              bytes += part.value.byteLength; if (bytes > 16384) break;
              parts.push(part.value);
            }
            const text = Buffer.concat(parts).toString('utf8');
            // Only fixed public parameter names survive; reflected keys/text do not.
            failure.referencedParameters = ['max_completion_tokens', 'max_tokens', 'response_format', 'json_schema', 'messages', 'model', 'temperature'].filter(name => text.includes(name));
          }
        } catch { /* A body read error does not erase the known HTTP status. */ }
        finally { try { await reader?.cancel(); } catch { /* No retry. */ } }
        throw failure;
      }
      let usage: Usage | undefined; let fingerprint: string | undefined;
      try {
        const reader = response.body?.getReader(); if (!reader) throw new Error();
        const parts: Uint8Array[] = []; let bytes = 0;
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
          if (bytes > 131072) { await reader.cancel(); throw new Error(); } parts.push(part.value); }
        const decoded = JSON.parse(Buffer.concat(parts).toString('utf8'));
        // Extract billable usage before interpreting choices, JSON or refusals.
        const u = decoded?.usage; if (!u || typeof u !== 'object') throw new Error();
        const inputTokens = usageTokens(u.prompt_tokens), outputTokens = usageTokens(u.completion_tokens);
        if (usageTokens(u.total_tokens) !== inputTokens + outputTokens) throw new Error();
        // Never persist arbitrary provider text as a model identifier.
        usage = { inputTokens, outputTokens, modelVersion: decoded.model === model ? model : null };
        if (typeof decoded.system_fingerprint === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(decoded.system_fingerprint)) fingerprint = decoded.system_fingerprint;
        const detail = (value: unknown, maximum: number): number | null => value === undefined ? null : (() => { const n = usageTokens(value); if (n > maximum) throw new Error(); return n; })();
        const cachedTokens = detail(u.prompt_tokens_details?.cached_tokens, inputTokens);
        const reasoningTokens = detail(u.completion_tokens_details?.reasoning_tokens, outputTokens);
        // Reasoning and cached counts are subsets, not additional billable tokens.
        if (decoded.model !== model || !Array.isArray(decoded.choices) || decoded.choices.length !== 1) throw new Error();
        const c = decoded.choices[0];
        if (c.finish_reason !== 'stop' || c.message?.role !== 'assistant' || c.message.refusal || c.message.tool_calls || typeof c.message.content !== 'string' || c.message.content.length > 32768) throw new Error();
        return { value: JSON.parse(c.message.content), usage, fingerprint: fingerprint ?? null, cachedTokens, reasoningTokens };
      } catch { throw new BenchmarkFailure('BENCH_RESPONSE_INVALID', usage, fingerprint); }
    },
  };
}
