import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { BenchmarkFailure, benchmarkRequestBody, createBenchmarkTransport, replayOnlyBenchmarkTransport } from './benchmark-transport.ts';
import type { BenchmarkTransport } from './benchmark-transport.ts';
import { benchmarkDigest } from './benchmark-ledger.ts';
import { readPilotJson, writePilotJson } from './task-pilot-journal.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema } from '../../../packages/analyzer/src/task-protocol.ts';
import type { RejectedTaskPayload } from './task-pilot-runner.ts';

export const jsonWireVersion = 'cashneuro-task-json-object/1';
export const cloudApiSpecification = 'https://cloud.ru/docs/api/specs/foundation-models/ug/_downloads/f2949c1237d79b17b2df8e523e02a89a/openapi__foundation-models.yaml';
export const jsonSystemPrompt = (prompt: string, schema: unknown) => prompt + '\nПолная JSON-схема ответа (все ограничения проверяются сервером):\n' + JSON.stringify(schema);
export const taskJsonRequestBody: typeof benchmarkRequestBody = (candidate, bound, prompt, input, schema) => {
  if (candidate !== 'cloud-oss' || !((prompt === taskRelevancePrompt && benchmarkDigest(schema) === benchmarkDigest(taskRelevanceSchema)) ||
      (prompt === taskProposalPrompt && benchmarkDigest(schema) === benchmarkDigest(taskProposalSchema)))) throw new BenchmarkFailure('TASK_JSON_CONTRACT_INVALID');
  return JSON.stringify({ model: bound.modelVersion, messages: [{ role: 'system', content: jsonSystemPrompt(prompt, schema) }, { role: 'user', content: JSON.stringify(input) }],
    temperature: 0, stream: false, n: 1, max_completion_tokens: bound.outputTokens, response_format: { type: 'json_object' } });
};
export function replayOnlyTaskJsonTransport(): BenchmarkTransport {
  const base = replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools');
  return { ...base, requestBody: (prompt: string, input: unknown, schema: unknown) => taskJsonRequestBody('cloud-oss', base.bound, prompt, input, schema) };
}
export function redactProviderError(text: string, secrets: readonly string[]) {
  let source = text;
  try {
    const body = JSON.parse(text), candidates = [body?.message, body?.error?.message, typeof body?.error === 'string' ? body.error : null,
      typeof body?.detail === 'string' ? body.detail : null, ...(Array.isArray(body?.detail) ? body.detail.map((v: any) => v?.msg) : []), body?.error_description];
    const messages = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (messages.length) source = messages.join('; ');
  } catch { /* A bounded non-JSON gateway error is still useful. */ }
  for (const secret of secrets.filter(Boolean)) {
    for (const variant of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), JSON.stringify(secret).slice(1, -1)])) source = source.split(variant).join('[REDACTED]');
  }
  source = source.replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]').replace(/https?:\/\/\S+/giu, '[URL]')
    .replace(/[A-Za-z0-9_+/=-]{20,}/gu, '[TOKEN]').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
  return source.slice(0, 1600);
}
export type ProviderErrorCapture = { kind?: 'payload_rejection'; httpStatus: number; wireSha256: string; bodySha256: string; bodyBytesCaptured: number; truncated: boolean; safeMessage: string; raw: Buffer };
export function rejectedTaskPayloadCapture(payload: RejectedTaskPayload): ProviderErrorCapture {
  if (!/^[a-f0-9]{64}$/.test(payload.id) || !/^[a-f0-9]{64}$/.test(payload.wireSha256)) throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  const bytes = Buffer.from(JSON.stringify(payload.value)), raw = bytes.subarray(0, 16384);
  const code = ['TASK_WIRE_INVALID', 'TASK_NAMES_INVALID', 'TASK_EVIDENCE_MISSING', 'TASK_DUPLICATE_EDIT', 'TASK_EMPTY_SET', 'REFLECTED_CREDENTIAL_DENIED'].includes(payload.validationCode) ? payload.validationCode : 'closed_contract';
  return { kind: 'payload_rejection', httpStatus: 200, wireSha256: payload.wireSha256, bodySha256: createHash('sha256').update(raw).digest('hex'),
    bodyBytesCaptured: raw.length, truncated: bytes.length > raw.length, safeMessage: 'TASK_PILOT_PAYLOAD_INVALID/' + payload.phase + '/' + code, raw };
}
export function createTaskJsonTransport(credentials: unknown, fetcher: typeof fetch = fetch, bodyBuilder: typeof benchmarkRequestBody = taskJsonRequestBody) {
  const apiKey = String(object(credentials, ['apiKey']).apiKey), captures: ProviderErrorCapture[] = [];
  const wrapped: typeof fetch = async (url, options) => {
    const response = await fetcher(url, options);
    if (response.ok) return response;
    const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0, truncated = false;
    try {
      while (reader) { const part = await reader.read(); if (part.done) break;
        const remaining = 16384 - size; parts.push(part.value.subarray(0, remaining)); size += Math.min(remaining, part.value.byteLength);
        if (part.value.byteLength > remaining) { truncated = true; break; }
      }
    } catch { truncated = true; }
    finally { try { await reader?.cancel(); } catch { /* No retry. */ } }
    const raw = Buffer.concat(parts), capture: ProviderErrorCapture = { httpStatus: response.status, wireSha256: benchmarkDigest(String(options?.body)),
      bodySha256: createHash('sha256').update(raw).digest('hex'), bodyBytesCaptured: raw.length, truncated, safeMessage: redactProviderError(raw.toString('utf8'), [apiKey]), raw };
    captures.push(capture);
    // The audited transport receives only a safe synthetic error body. Raw
    // bytes stay in memory until encrypted persistence AFTER receipt fsync.
    return new Response(JSON.stringify({ message: capture.safeMessage }), { status: response.status });
  };
  return { transport: createBenchmarkTransport('cloud-oss', credentials, wrapped, 'empty-tools', bodyBuilder), captures };
}
export async function persistProviderError(directory: string, id: string, capture: ProviderErrorCapture) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  const keyPath = join(directory, 'task-json-error-key.json'); let key: Buffer;
  try { const saved = object(await readPilotJson(keyPath), ['key']); key = Buffer.from(String(saved.key), 'base64'); if (key.length !== 32) throw new Error(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
    key = randomBytes(32); await writePilotJson(keyPath, { key: key.toString('base64') });
  }
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce), encrypted = Buffer.concat([cipher.update(capture.raw), cipher.final()]);
  const { raw, ...safe } = capture;
  const payload = { version: 'cashneuro-private-provider-error/1', id, ...safe, cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') };
  await writePilotJson(join(directory, 'task-json-error-' + id + '.json'), { hash: benchmarkDigest(payload), payload });
  return { id, ...safe, encryptedEvidenceSaved: true };
}
export async function readSafeProviderError(directory: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  const wrapper = object(await readPilotJson(join(directory, 'task-json-error-' + id + '.json')), ['hash', 'payload']);
  if (wrapper.hash !== benchmarkDigest(wrapper.payload)) throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  const v = wrapper.payload as Record<string, unknown>;
  if (v.version !== 'cashneuro-private-provider-error/1' || v.id !== id || typeof v.safeMessage !== 'string' || v.safeMessage.length > 1600 ||
      !Number.isSafeInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599 || !/^[a-f0-9]{64}$/.test(String(v.bodySha256)) || !/^[a-f0-9]{64}$/.test(String(v.wireSha256))) throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  if (v.kind !== undefined && v.kind !== 'payload_rejection') throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID');
  return { id, ...(v.kind === 'payload_rejection' ? { kind: 'payload_rejection' as const } : {}), httpStatus: v.httpStatus, wireSha256: v.wireSha256, bodySha256: v.bodySha256, bodyBytesCaptured: v.bodyBytesCaptured, truncated: v.truncated, safeMessage: v.safeMessage, encryptedEvidenceSaved: true };
}
