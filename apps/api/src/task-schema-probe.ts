import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { benchmarkDigest, BenchmarkLedger } from './benchmark-ledger.ts';
import type { HeldSchemaProbePermit } from './benchmark-ledger.ts';
import { BenchmarkFailure, benchmarkRequestBody, candidates } from './benchmark-transport.ts';
import type { BenchmarkResult, BenchmarkTransport } from './benchmark-transport.ts';
import { readPilotJson, writePilotJson } from './task-pilot-journal.ts';
import { taskTrialManifest, loadTrialCorpus, evaluateTrialScenario } from './task-trial.ts';
import { pilotTariff } from './task-pilot-runner.ts';
import { projectTaskWireSchema, taskWireProfile } from './task-provider-schema.ts';
import { emptySchemaDiagnostics } from './task-schema-probe-transport.ts';
import type { SchemaHttpDiagnostics } from './task-schema-probe-transport.ts';
import { taskProposalPrompt, taskProposalSchema, parseTaskProposalWire, parseTaskRelevance } from '../../../packages/analyzer/src/task-protocol.ts';
import { object } from '../../../packages/finance-core/src/model.ts';

export const schemaProbeCheckpoint = {
  bindingSha256: '0afd24fe2c7394be7ee74e5000fb1996e21f4f885c0db38adf977bb14797f691',
  ledgerHeadSha256: '8ad850c2aa9ab4953bdef29ea612db90bdf2752fdff8d833c317787b79f856ec',
  frozenSha256: '11f6fafcd90671ce9d1283e6bc18f4c79d105131f71d25cff176d49fb6cdd991',
  baselineRecordsSha256: 'cd3dbecfbd712a9959c692fdbd32aeb9f88a9cfbb480d6b828ba3b0e98a0fab2',
  checkpointSha256: '2f3012fc7cca47ee5abc6a3eea0276aea975a0681fb236c35193f95272734671',
  gateId: 'e45fc0f622016dcb6d5cc1bcd6369123d8e79d9faad989155fcff1972173ba03',
  rejectionId: 'fa60ae8109ffd7c8a49c9f51d3f3206e4dc1ab41aacc247a1ebc44f532721ab4',
  gateWireSha256: 'ae0f614b2dcad962636c7c4db60f8216ab273551bf898407494b43ef63c84721',
  rejectedWireSha256: '7f4875c839e807bf839f71de8dcf7367f3864d25b9a75a63fb60ca8ecd55e06f',
  expectedCalls: 494, expectedSpentAtoms: '13389232820', expectedHeldAtoms: '9668802560', expectedUpperAtoms: '23058035380',
  incrementalBaselineUpperAtoms: '20888941260', incrementalCapAtoms: '20000000000',
} as const;
const spec = candidates['cloud-oss'];
const bound = { inputTokens: spec.contextTokens, outputTokens: 1200, modelVersion: spec.model };
export const schemaProbeId = (bindingSha256: string) => benchmarkDigest({ purpose: 'held-task-schema-probe/1', bindingSha256 });
const fail = (code = 'TASK_SCHEMA_PROBE_CHECKPOINT_CHANGED'): never => { throw new BenchmarkFailure(code); };

export async function schemaProbeRequest() {
  const { corpus } = await loadTrialCorpus(), turn = corpus.singles[0]!; let input: unknown;
  if (turn.id !== 'single-01' || turn.question !== 'Сколько потрачено за выбранный период?') return fail();
  await evaluateTrialScenario([turn], () => ({ relevance: async () => ({ relevance: 'financial' }), proposal: async value => { input = value; return {}; } }));
  if (!input) return fail();
  const oldWireSha256 = benchmarkDigest(benchmarkRequestBody('cloud-oss', bound, taskProposalPrompt, input, taskProposalSchema));
  if (oldWireSha256 !== schemaProbeCheckpoint.rejectedWireSha256) return fail('TASK_SCHEMA_PROBE_REQUEST_CHANGED');
  const schema = projectTaskWireSchema(taskProposalSchema), wireSha256 = benchmarkDigest(benchmarkRequestBody('cloud-oss', bound, taskProposalPrompt, input, schema));
  return { input, schema, wireSha256, turn };
}
export async function schemaProbeArtifact() {
  const manifest = await taskTrialManifest(), request = await schemaProbeRequest();
  if (manifest.corpusSha256 !== '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f' || manifest.promptsSha256 !== 'e2465ece6e41faf4cb7277c4b667ef6b1ce544e705412a23dabc1c11f3c347e8') return fail();
  const source: Record<string, string> = {};
  for (const name of ['task-schema-probe.ts', 'task-schema-probe-main.ts', 'task-schema-probe-transport.ts', 'task-provider-schema.ts']) source[name] = benchmarkDigest(await readFile(new URL('./' + name, import.meta.url), 'utf8'));
  const binding = { version: 'cashneuro-task-schema-probe/1', originalCheckpoint: schemaProbeCheckpoint, manifest, extraSource: source, profile: taskWireProfile,
    wireSha256: request.wireSha256, inputSha256: benchmarkDigest(request.input), tariff: pilotTariff, maximumNewCalls: 1,
    originalIncrementalCapAtoms: '20000000000', globalCapAtoms: '45000000000', oldHoldsReleased: false, modelAccepted: false, runtimeAiEnabled: false };
  const bindingSha256 = benchmarkDigest(binding), id = schemaProbeId(bindingSha256);
  return { binding, bindingSha256, id, request, permit: { ...schemaProbeCheckpoint, bindingSha256 } satisfies HeldSchemaProbePermit };
}
export type SchemaProbeArtifact = Awaited<ReturnType<typeof schemaProbeArtifact>>;

/** Validate the original hash-chain prefix even after the one new plain
 * reserve/receipt. Nothing is removed from a Map, file, cache or old lock. */
export async function verifySchemaProbeCheckpoint(ledger: BenchmarkLedger, directory: string, artifact: Pick<SchemaProbeArtifact, 'id'>) {
  const c = schemaProbeCheckpoint, old = object(await readPilotJson(join(directory, 'task-pilot-v1.json')), ['hash', 'payload']);
  if (old.hash !== c.frozenSha256 || benchmarkDigest(old.payload) !== c.frozenSha256) return fail();
  const frozen = old.payload as Record<string, unknown>;
  if (frozen.bindingSha256 !== c.bindingSha256 || frozen.baselineRecordsSha256 !== c.baselineRecordsSha256) return fail();
  const probe = ledger.records.get(artifact.id);
  if (ledger.records.size !== c.expectedCalls + (probe ? 1 : 0)) return fail();
  if (!probe) { if (ledger.previous !== c.ledgerHeadSha256) return fail(); }
  else {
    const stat = await ledger.file.stat(), buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) { const part = await ledger.file.read(buffer, offset, buffer.length - offset, offset); if (!part.bytesRead) return fail(); offset += part.bytesRead; }
    const lines = buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const index = lines.findIndex(line => line.event.type === 'reserve' && line.event.id === artifact.id), tail = lines.slice(index);
    if (index < 0 || tail[0].previous !== c.ledgerHeadSha256 || tail.length !== (probe.receipt ? 2 : 1) || tail.some(line => line.event.id !== artifact.id) || probe.reserve.purpose !== undefined ||
        benchmarkDigest(probe.reserve.price) !== benchmarkDigest(spec.price) || benchmarkDigest(probe.reserve.bound) !== benchmarkDigest(bound)) return fail();
  }
  const total = ledger.totals(), newSpent = BigInt(probe?.receipt?.usage ? probe.receipt.atoms! : '0'), newHeld = BigInt(probe && !probe.receipt?.usage ? probe.reserve.atoms : '0');
  if (total.spent - newSpent !== BigInt(c.expectedSpentAtoms) || total.held - newHeld !== BigInt(c.expectedHeldAtoms)) return fail();
  const gate = ledger.records.get(c.gateId), rejected = ledger.records.get(c.rejectionId);
  if (gate?.receipt?.code !== null || gate.receipt.usage?.inputTokens !== 570 || gate.receipt.usage.outputTokens !== 132 || gate.receipt.usage.modelVersion !== spec.model ||
      (gate.receipt.value as { wireSha256?: unknown })?.wireSha256 !== c.gateWireSha256 || rejected?.receipt?.code !== 'BENCH_PROVIDER_FAILURE_HTTP_400' || rejected.receipt.usage !== null ||
      (rejected.receipt.value as { wireSha256?: unknown })?.wireSha256 !== c.rejectedWireSha256) return fail();
  const wrapper = object(await readPilotJson(join(directory, 'task-pilot-v1-cache', c.gateId + '.json')), ['hash', 'payload']);
  if (wrapper.hash !== benchmarkDigest(wrapper.payload)) return fail();
  const cache = object(wrapper.payload, ['id', 'wireSha256', 'value', 'code']);
  if (cache.id !== c.gateId || cache.wireSha256 !== c.gateWireSha256 || cache.code !== null || parseTaskRelevance(cache.value).relevance !== 'financial') return fail();
  return { relevance: 'financial' as const };
}

function safeDiagnostics(value: unknown): SchemaHttpDiagnostics {
  const v = object(value, ['referencedParameters', 'referencedSchemaKeywords', 'decoder', 'reason', 'httpStatus', 'errorBody']), empty = emptySchemaDiagnostics();
  const strings = (raw: unknown, allow: string[]) => Array.isArray(raw) && raw.length <= allow.length && new Set(raw).size === raw.length && raw.every(s => typeof s === 'string' && allow.includes(s));
  if (!strings(v.referencedParameters, ['max_completion_tokens', 'max_tokens', 'response_format', 'json_schema', 'messages', 'model', 'temperature']) ||
      !strings(v.referencedSchemaKeywords, ['multipleOf', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'format', 'minProperties', 'maxProperties', 'propertyNames', 'patternProperties']) ||
      !['xgrammar', 'outlines', 'unknown'].includes(String(v.decoder)) || !['schema_unsupported', 'schema_invalid', 'unclassified'].includes(String(v.reason)) ||
      !['not_read', 'bounded', 'too_large', 'read_failed'].includes(String(v.errorBody)) || v.httpStatus !== null && (!Number.isSafeInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599)) return fail('TASK_SCHEMA_PROBE_DIAGNOSTICS_INVALID');
  return { ...empty, ...v } as SchemaHttpDiagnostics;
}

export async function runSingleSchemaProbe(options: { ledger: BenchmarkLedger; permit: HeldSchemaProbePermit; request: Awaited<ReturnType<typeof schemaProbeRequest>>;
  resultPath: string; transport?: BenchmarkTransport; diagnostics?: SchemaHttpDiagnostics; secrets?: string[]; beforeDispatch?: () => void }) {
  const { ledger, permit, request, resultPath } = options, id = schemaProbeId(permit.bindingSha256), replay = ledger.records.has(id), secrets = options.secrets ?? [];
  if (!replay) {
    if (!options.transport || !options.diagnostics) return fail('BENCH_REPLAY_ONLY');
    const transport = options.transport, started = performance.now(); let completed: BenchmarkResult | undefined, failure: BenchmarkFailure | undefined, reserved = false;
    if (benchmarkDigest(benchmarkRequestBody('cloud-oss', transport.bound, taskProposalPrompt, request.input, request.schema)) !== request.wireSha256) return fail('TASK_SCHEMA_PROBE_REQUEST_CHANGED');
    try {
      completed = await transport.complete(taskProposalPrompt, request.input, request.schema, async () => { options.beforeDispatch?.(); await ledger.reserveHeldSchemaProbe(id, transport.price, transport.bound, permit); reserved = true; });
    } catch (error) {
      if (!reserved) throw error;
      failure = error instanceof BenchmarkFailure ? error : new BenchmarkFailure('BENCH_DELIVERY_UNKNOWN');
    }
    const fingerprint = completed?.fingerprint ?? failure?.fingerprint ?? null, reflected = fingerprint !== null && secrets.some(s => s.length && fingerprint.includes(s));
    const usage = completed?.usage ?? failure?.usage ?? null, priorFingerprint = ledger.records.get(permit.gateId)?.receipt?.fingerprint;
    const drift = !!usage && (usage.modelVersion !== transport.bound.modelVersion || usage.inputTokens > transport.bound.inputTokens || usage.outputTokens > transport.bound.outputTokens || fingerprint !== priorFingerprint);
    const code = reflected ? 'TASK_SCHEMA_PROBE_PROVIDER_INVALID' : drift ? 'TASK_SCHEMA_PROBE_PROVIDER_DRIFT' : failure?.code ?? null;
    // Do not include parsing/cache work in this try/catch: one receipt only,
    // and its fsync failure can never trigger a second settlement or request.
    await ledger.receipt({ id, usage, code, fingerprint: reflected ? null : fingerprint,
      value: { bindingSha256: permit.bindingSha256, wireSha256: request.wireSha256, diagnostics: safeDiagnostics(options.diagnostics) },
      latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed?.cachedTokens ?? null, reasoningTokens: completed?.reasoningTokens ?? null });
    if (completed && !code) {
      let payload: unknown = null, payloadCode: string | null = null;
      try { payload = parseTaskProposalWire(completed.value, request.turn.question); if (secrets.some(s => s.length && JSON.stringify(payload).includes(s))) throw new Error(); }
      catch { payload = null; payloadCode = 'TASK_SCHEMA_PROBE_PAYLOAD_INVALID'; }
      const saved = { id, bindingSha256: permit.bindingSha256, wireSha256: request.wireSha256, value: payload, code: payloadCode };
      await writePilotJson(resultPath, { hash: benchmarkDigest(saved), payload: saved });
    }
  }
  const record = ledger.records.get(id)!; const receipt = record.receipt;
  if (!receipt) return { probe: 'cashneuro-task-schema-probe/1', id, callsThisRun: 0, replay: true, error: 'BENCH_RECONCILIATION_REQUIRED', usage: null, result: null, originalHoldsPreserved: true, modelAccepted: false, runtimeAiEnabled: false };
  const value = object(receipt.value, ['bindingSha256', 'wireSha256', 'diagnostics']);
  if (value.bindingSha256 !== permit.bindingSha256 || value.wireSha256 !== request.wireSha256) return fail('TASK_SCHEMA_PROBE_REQUEST_CHANGED');
  const diagnostics = safeDiagnostics(value.diagnostics); let error = receipt.code, result = null;
  if (!error && receipt.usage) {
    let saved;
    try { saved = object(await readPilotJson(resultPath), ['hash', 'payload']); } catch { return fail('TASK_SCHEMA_PROBE_RESULT_UNAVAILABLE'); }
    if (saved.hash !== benchmarkDigest(saved.payload)) return fail('TASK_SCHEMA_PROBE_RESULT_UNAVAILABLE');
    const cache = object(saved.payload, ['id', 'bindingSha256', 'wireSha256', 'value', 'code']);
    if (cache.id !== id || cache.bindingSha256 !== permit.bindingSha256 || cache.wireSha256 !== request.wireSha256 || cache.code !== null && cache.code !== 'TASK_SCHEMA_PROBE_PAYLOAD_INVALID') return fail('TASK_SCHEMA_PROBE_RESULT_UNAVAILABLE');
    error = cache.code as string | null;
    if (!error) {
      const proposal = parseTaskProposalWire(cache.value, request.turn.question);
      result = (await evaluateTrialScenario([request.turn], () => ({ relevance: async () => ({ relevance: 'financial' }), proposal: async () => proposal })))[0]!;
    }
  }
  return { probe: 'cashneuro-task-schema-probe/1', id, bindingSha256: permit.bindingSha256, callsThisRun: replay ? 0 : 1, replay,
    error, diagnostics, providerAcceptedRequest: diagnostics.httpStatus !== null && diagnostics.httpStatus >= 200 && diagnostics.httpStatus < 300,
    usage: receipt.usage, result, originalHoldsPreserved: true, gateReusedWithoutPayment: true, modelAccepted: false, runtimeAiEnabled: false };
}
