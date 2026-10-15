import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, stat } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import { candidates, benchmarkRequestBody, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { PilotJournal, ensurePilotCache, readPilotJson } from '../src/task-pilot-journal.ts';
import { pilotRequestIds, pilotModel, runPilot } from '../src/task-pilot-runner.ts';
import { loadTrialCorpus, trialRequestId, evaluateTrialScenario } from '../src/task-trial.ts';
import type { TaskModel } from '../src/analyzer-task-workflow.ts';
import type { TrialCorpus } from '../src/task-trial.ts';
import { schemaProbeCheckpoint, schemaProbeId, schemaProbeRequest } from '../src/task-schema-probe.ts';
import { jsonTrialBinding, jsonTrialAdmission, priorSchemaProbe, reusedFinancialGate, assertJsonTrialStart } from '../src/task-json-trial.ts';
import { taskJsonRequestBody, jsonSystemPrompt, createTaskJsonTransport, replayOnlyTaskJsonTransport, redactProviderError, persistProviderError, readSafeProviderError, rejectedTaskPayloadCapture } from '../src/task-json-transport.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema } from '../../../packages/analyzer/src/task-protocol.ts';

const spec = candidates['cloud-oss'], bound = { inputTokens: 131072, outputTokens: 1200, modelVersion: spec.model };
const key = 'synthetic-json-trial-secret-123456', binding = 'a'.repeat(64), keep = { op: 'keep' };
const valid = { status: 'query', binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потрачено' }, grouping: keep, comparison: keep, edits: [] };
const reply = (value: unknown = valid, patch: Record<string, unknown> = {}) => new Response(JSON.stringify({ model: spec.model, system_fingerprint: 'fixture', usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value), tool_calls: [] } }], ...patch }));
const diagnostics = () => ({ paidCalls: 0, replayCalls: 0, errors: [] as { id: string; code: string }[] });

// Only scheduling/settlement mechanics use repeated synthetic questions. Actual
// provider language accuracy is measured against the unchanged real corpus.
const schedulerCorpus = (original: TrialCorpus): TrialCorpus => ({ ...original, dialogs: [],
  singles: Array.from({ length: 96 }, (_, i) => ({ ...structuredClone(original.singles[0]!), id: i === 0 ? 'single-01' : 'scheduler-' + i, split: i < 68 ? 'development' : 'holdout' })),
  repetitions: Array.from({ length: 12 }, (_, i) => ({ caseId: i === 0 ? 'single-01' : 'scheduler-' + i, additionalIndependentCopies: 2 })),
});
async function fixture(action: (f: { dir: string; ledgerPath: string; path: string; cache: string; ledger: BenchmarkLedger; journal: PilotJournal; corpus: TrialCorpus; input: Parameters<TaskModel['proposal']>[0] }) => Promise<void>, options: { scheduler?: boolean; prefix?: number; budgetBaseline?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-json-trial-')), ledgerPath = join(dir, 'ledger.jsonl'), path = join(dir, 'frozen.json'), cache = join(dir, 'cache');
  const ledger = await BenchmarkLedger.load(ledgerPath);
  try {
    for (let i = 0; i < (options.prefix ?? 0); i++) { const id = benchmarkDigest('prefill-' + i); await ledger.reserve(id, spec.price, bound);
      await ledger.receipt({ id, usage: { inputTokens: 131072, outputTokens: 1200, modelVersion: spec.model }, value: {}, code: null, fingerprint: 'fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null }); }
    const c = schemaProbeCheckpoint; await ledger.reserve(c.gateId, spec.price, bound);
    await ledger.receipt({ id: c.gateId, usage: { inputTokens: 570, outputTokens: 132, modelVersion: spec.model }, value: { wireSha256: c.gateWireSha256 }, code: null, fingerprint: 'fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.reserve(c.rejectionId, spec.price, bound);
    await ledger.receipt({ id: c.rejectionId, usage: null, value: { wireSha256: c.rejectedWireSha256 }, code: 'BENCH_PROVIDER_FAILURE_HTTP_400', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    const total = ledger.totals(); assert.equal(schemaProbeId(priorSchemaProbe.bindingSha256), priorSchemaProbe.id);
    await ledger.reserveHeldSchemaProbe(priorSchemaProbe.id, spec.price, bound, { ...c, bindingSha256: priorSchemaProbe.bindingSha256, ledgerHeadSha256: ledger.previous,
      expectedCalls: ledger.records.size, expectedUpperAtoms: (total.spent + total.held).toString(), incrementalBaselineUpperAtoms: (BigInt(options.prefix ?? 0) * 2152001920n).toString() });
    await ledger.receipt({ id: priorSchemaProbe.id, usage: null, value: { wireSha256: priorSchemaProbe.wireSha256, bindingSha256: priorSchemaProbe.bindingSha256 }, code: 'BENCH_PROVIDER_FAILURE_HTTP_400', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    const loaded = await loadTrialCorpus(), corpus = options.scheduler ? schedulerCorpus(loaded.corpus) : loaded.corpus;
    await ensurePilotCache(cache);
    const journal = await PilotJournal.load({ path, cacheDirectory: cache, ledger, bindingSha256: binding, requestIds: pilotRequestIds(corpus, binding), maximumCalls: 240,
      ...jsonTrialAdmission, budgetBaselineUpperAtoms: options.budgetBaseline ?? '0', readOnly: false, assertInitial(l) { assert.equal(l.records.size, (options.prefix ?? 0) + 3); } });
    const input = (await schemaProbeRequest()).input as Parameters<TaskModel['proposal']>[0];
    await action({ dir, ledgerPath, path, cache, ledger, journal, corpus, input });
  } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('JSON mode uses the documented decoder format while carrying the complete unchanged authoritative schemas', () => {
  for (const [prompt, schema] of [[taskRelevancePrompt, taskRelevanceSchema], [taskProposalPrompt, taskProposalSchema]] as const) {
    const wire = JSON.parse(taskJsonRequestBody('cloud-oss', bound, prompt, { question: 'fixture' }, schema));
    assert.deepEqual(wire.response_format, { type: 'json_object' }); assert.equal(wire.messages[0].content, jsonSystemPrompt(prompt, schema));
    assert.equal(wire.messages[1].content, '{"question":"fixture"}'); assert.equal(wire.max_completion_tokens, 1200);
    assert.equal(wire.temperature, 0); assert.equal(wire.n, 1); assert.equal(wire.stream, false);
    assert.notEqual(benchmarkDigest(wire), benchmarkDigest(JSON.parse(benchmarkRequestBody('cloud-oss', bound, prompt, { question: 'fixture' }, schema))));
  }
  assert.ok(JSON.stringify(taskProposalSchema).includes('uniqueItems'));
  assert.throws(() => taskJsonRequestBody('cloud-giga', bound, taskProposalPrompt, {}, taskProposalSchema), /CONTRACT_INVALID/);
  assert.throws(() => taskJsonRequestBody('cloud-oss', bound, taskProposalPrompt, {}, {}), /CONTRACT_INVALID/);
});

test('the first corrected JSON proposal alone is paid, its wire identity is durable before POST, and both old holds stay intact', async () => fixture(async f => {
  const before = await readFile(f.ledgerPath, 'utf8'), originals = JSON.stringify([...f.ledger.records]); let calls = 0;
  const d = diagnostics(), turn = f.corpus.singles[0]!;
  const bundle = createTaskJsonTransport({ apiKey: key }, (async (_, options) => {
    calls++; const body = String(options!.body), id = trialRequestId(binding, turn.id, 'plan', 0), durable = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true });
    try { assert.ok(durable.records.has(id)); assert.equal(durable.totals().held, 6456005760n); } finally { await durable.close(); }
    assert.deepEqual(JSON.parse(body).response_format, { type: 'json_object' }); return reply();
  }) as typeof fetch);
  const [row] = await evaluateTrialScenario([turn], t => pilotModel(bundle.transport, f.journal, binding, t, 0, d, [key], undefined, reusedFinancialGate));
  assert.equal(row!.passed, true); assert.equal(calls, 1); assert.equal(d.paidCalls, 1); assert.equal(d.replayCalls, 1);
  assert.equal(f.ledger.totals().held, 4304003840n); assert.equal(f.ledger.totals().blocked, true); assert.equal(f.journal.verify().cost.blocked, false);
  assert.equal(JSON.stringify([...f.ledger.records].slice(0, 3)), originals); assert.ok((await readFile(f.ledgerPath, 'utf8')).startsWith(before));
  const receipt = f.ledger.records.get(trialRequestId(binding, turn.id, 'plan', 0))!.receipt!;
  const cached = await readPilotJson(join(f.cache, receipt.id + '.json')) as any;
  assert.equal(cached.payload.wireSha256, (receipt.value as any).wireSha256); assert.equal(bundle.captures.length, 0);
}));

test('automatic 68+24+28 scheduling makes 239 distinct paid calls; a full saved report makes none and does not rewrite state', async () => fixture(async f => {
  let calls = 0;
  const bundle = createTaskJsonTransport({ apiKey: key }, (async (_, options) => {
    calls++; const wire = JSON.parse(String(options!.body)); return reply(wire.messages[0].content.startsWith(taskRelevancePrompt) ? { relevance: 'financial' } : valid);
  }) as typeof fetch);
  const result = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(result.status, 'provisional_pilot_passed'); assert.equal(result.completedTurns, 120); assert.equal(result.passedTurns, 120);
  assert.equal(result.holdoutOpened, true); assert.equal(calls, 239); assert.equal(result.totalPilotCalls, 239); assert.equal(result.replayCalls, 1);
  for (const occurrence of [1, 2]) assert.ok(f.ledger.records.get(trialRequestId(binding, 'single-01', 'gate', occurrence))?.receipt?.usage);
  assert.equal(f.ledger.records.has(trialRequestId(binding, 'single-01', 'gate', 0)), false);
  const before = [await readFile(f.ledgerPath, 'utf8'), await readFile(f.path, 'utf8')];
  const ledger = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true });
  try {
    const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger, bindingSha256: binding, requestIds: pilotRequestIds(f.corpus, binding), maximumCalls: 240,
      ...jsonTrialAdmission, budgetBaselineUpperAtoms: '0', readOnly: true, assertInitial() { throw new Error('must not initialize'); } });
    const report = await runPilot(f.corpus, replayOnlyTaskJsonTransport(), journal, binding, { reusedInitialGate: reusedFinancialGate });
    assert.equal(report.passedTurns, 120); assert.equal(report.paidCallsThisRun, 0); assert.equal(report.replayCalls, 240);
    assert.equal(report.incrementalUpperAtoms, result.incrementalUpperAtoms); assert.equal(report.modelAccepted, false); assert.equal(report.runtimeAiEnabled, false);
  } finally { await ledger.close(); }
  assert.deepEqual([await readFile(f.ledgerPath, 'utf8'), await readFile(f.path, 'utf8')], before);
}, { scheduler: true }));

test('a new 400 stops immediately, adds a full unknown hold and cannot be paid again even with the live transport', async () => fixture(async f => {
  let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Неверный параметр response_format ' + key } }), { status: 400 }); }) as typeof fetch);
  const first = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(first.stop, 'BENCH_RECONCILIATION_REQUIRED'); assert.equal(first.paidCallsThisRun, 1); assert.equal(first.completedTurns, 0); assert.equal(first.holdoutOpened, false);
  assert.equal(f.ledger.totals().held, 6456005760n); assert.equal(f.journal.verify().cost.blocked, true);
  const second = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(second.paidCallsThisRun, 0); assert.equal(calls, 1); assert.equal(bundle.captures.length, 1);
  assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false); assert.equal(JSON.stringify(first).includes(key), false);
}));

test('provider diagnostics preserve bounded exact encrypted bytes, redact credentials, and replay without the encryption key', async () => fixture(async f => {
  const raw = Buffer.from(JSON.stringify({ error: { message: 'Неизвестный параметр json_schema. Bearer ' + key, code: 'bad_format' }, echoed: key }));
  const bundle = createTaskJsonTransport({ apiKey: key }, (async () => new Response(raw, { status: 400 })) as typeof fetch);
  await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  const id = trialRequestId(binding, 'single-01', 'plan', 0), capture = bundle.captures[0]!;
  assert.ok(f.ledger.records.get(id)!.receipt); const saved = await persistProviderError(f.dir, id, capture);
  assert.ok(saved.safeMessage.includes('Неизвестный параметр json_schema')); assert.equal(JSON.stringify(saved).includes(key), false);
  const capsulePath = join(f.dir, 'task-json-error-' + id + '.json'), encryptedText = await readFile(capsulePath, 'utf8'), capsule = JSON.parse(encryptedText).payload;
  const keyPath = join(f.dir, 'task-json-error-key.json'), encryptionKey = (await readPilotJson(keyPath) as any).key;
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'base64'), Buffer.from(capsule.nonce, 'base64')); cipher.setAuthTag(Buffer.from(capsule.tag, 'base64'));
  assert.deepEqual(Buffer.concat([cipher.update(Buffer.from(capsule.encrypted, 'base64')), cipher.final()]), raw);
  assert.equal(capsule.bodySha256, createHash('sha256').update(raw).digest('hex')); assert.equal(encryptedText.includes(key), false);
  assert.equal((await stat(capsulePath)).mode & 0o777, 0o600); assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  await unlink(keyPath); assert.deepEqual(await readSafeProviderError(f.dir, id), saved);
}));

test('large, escaped-Unicode and non-JSON gateway errors stay useful and bounded without credential exposure', async () => {
  const escaped = '{"detail":"\\u041d\\u0435\\u0432\\u0435\\u0440\\u043d\\u044b\\u0439 response_format ' + key + '"}';
  assert.ok(redactProviderError(escaped, [key]).startsWith('Неверный response_format'));
  assert.equal(redactProviderError(key + ' ' + encodeURIComponent(key) + ' ' + Buffer.from(key).toString('base64'), [key]).includes(key), false);
  const bundle = createTaskJsonTransport({ apiKey: key }, (async () => new Response((key + ' gateway ').repeat(5000), { status: 502 })) as typeof fetch);
  await assert.rejects(bundle.transport.complete(taskProposalPrompt, {}, taskProposalSchema, async () => undefined), /HTTP_502/);
  assert.equal(bundle.captures[0]!.bodyBytesCaptured, 16384); assert.equal(bundle.captures[0]!.truncated, true);
  assert.ok(bundle.captures[0]!.safeMessage.length <= 1600); assert.equal(bundle.captures[0]!.safeMessage.includes(key), false);
});

test('JSON syntax alone cannot pass the authoritative duplicate, quote, closed-property or reflected-secret validation', async () => {
  for (const value of [ { ...valid, edits: [{ field: 'categories', op: 'set', quote: 'потрачено', value: { names: ['потрачено', 'потрачено'] } }] },
    { ...valid, metric: { op: 'set', value: 'expenses', quote: 'missing quote' } }, { ...valid, unexpected: true }, { ...valid, edits: [{ field: 'search', op: 'set', quote: key, value: key }] } ]) await fixture(async f => {
    let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(value); }) as typeof fetch), d = diagnostics();
    const turn = f.corpus.singles[0]!, model = pilotModel(bundle.transport, f.journal, binding, turn, 0, d, [key], undefined, reusedFinancialGate);
    assert.deepEqual(await model.proposal(f.input), {}); assert.equal(d.errors[0]?.code, 'TASK_PILOT_PAYLOAD_INVALID');
    assert.equal(f.ledger.totals().held, 4304003840n); assert.ok(f.ledger.records.get(trialRequestId(binding, turn.id, 'plan', 0))?.receipt?.usage);
    assert.deepEqual(await model.proposal(f.input), {}); assert.equal(calls, 1);
    assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false);
  });
});

test('a rejected HTTP-200 payload is encrypted immediately after durable usage/cache, with only safe diagnostics and no repeat sink on replay', async () => fixture(async f => {
  const invalid = { ...valid, unexpected: key }, bundle = createTaskJsonTransport({ apiKey: key }, (async () => reply(invalid)) as typeof fetch);
  const d = diagnostics(); let sinks = 0, safe: Awaited<ReturnType<typeof persistProviderError>> | undefined;
  const model = pilotModel(bundle.transport, f.journal, binding, f.corpus.singles[0]!, 0, d, [key], undefined, reusedFinancialGate, async payload => {
    sinks++; const durable = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true });
    try { assert.ok(durable.records.get(payload.id)?.receipt?.usage); } finally { await durable.close(); }
    const cache = await readPilotJson(join(f.cache, payload.id + '.json')) as any; assert.equal(cache.payload.value, null); assert.equal(cache.payload.code, 'TASK_PILOT_PAYLOAD_INVALID');
    safe = await persistProviderError(f.dir, payload.id, rejectedTaskPayloadCapture(payload));
  });
  assert.deepEqual(await model.proposal(f.input), {}); assert.deepEqual(await model.proposal(f.input), {}); assert.equal(sinks, 1); assert.equal(d.paidCalls, 1);
  assert.equal(safe!.kind, 'payload_rejection'); assert.equal(safe!.httpStatus, 200); assert.equal(safe!.safeMessage.includes(key), false);
  const id = trialRequestId(binding, 'single-01', 'plan', 0), wrapper = await readPilotJson(join(f.dir, 'task-json-error-' + id + '.json')) as any;
  const encryptionKey = (await readPilotJson(join(f.dir, 'task-json-error-key.json')) as any).key, cap = wrapper.payload;
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'base64'), Buffer.from(cap.nonce, 'base64')); decipher.setAuthTag(Buffer.from(cap.tag, 'base64'));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(cap.encrypted, 'base64')), decipher.final()]).toString()), invalid);
  assert.equal(JSON.stringify(wrapper).includes(key), false); assert.deepEqual(await readSafeProviderError(f.dir, id), safe);
}));

test('private evidence persistence failure preserves the settled invalid cache and stops without another dispatch or sink', async () => fixture(async f => {
  let calls = 0, sinks = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply({ ...valid, unexpected: true }); }) as typeof fetch);
  const model = pilotModel(bundle.transport, f.journal, binding, f.corpus.singles[0]!, 0, diagnostics(), [], undefined, reusedFinancialGate, async () => { sinks++; throw new BenchmarkFailure('TASK_JSON_CAPTURE_INVALID'); });
  await assert.rejects(model.proposal(f.input), /TASK_JSON_CAPTURE_INVALID/); assert.deepEqual(await model.proposal(f.input), {});
  assert.equal(calls, 1); assert.equal(sinks, 1); assert.equal(f.ledger.totals().held, 4304003840n);
}));

test('changed model, fingerprint, bound or reflected fingerprint settles once and blocks further dispatch', async () => {
  for (const patch of [{ model: 'other' }, { system_fingerprint: 'changed' }, { system_fingerprint: key }, { usage: { prompt_tokens: 100, completion_tokens: 1201, total_tokens: 1301 } }]) await fixture(async f => {
    let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(valid, patch); }) as typeof fetch);
    const first = await runPilot(f.corpus, bundle.transport, f.journal, binding, { secrets: [key], reusedInitialGate: reusedFinancialGate });
    assert.ok(first.stop); assert.equal(first.holdoutOpened, false); assert.equal(first.completedTurns, 0);
    await runPilot(f.corpus, bundle.transport, f.journal, binding, { secrets: [key], reusedInitialGate: reusedFinancialGate }); assert.equal(calls, 1);
    assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false);
  });
});

test('delivery loss stops with all three holds and cached replay cannot turn uncertainty into another POST', async () => fixture(async f => {
  let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; throw new Error(key); }) as typeof fetch);
  const first = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(first.stop, 'BENCH_RECONCILIATION_REQUIRED'); assert.equal(f.ledger.totals().held, 6456005760n);
  await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate }); assert.equal(calls, 1);
}));

test('a missing settled cache stops a saved prefix without repayment or invented success', async () => fixture(async f => {
  let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch), d = diagnostics();
  const turn = f.corpus.singles[0]!; const model = pilotModel(bundle.transport, f.journal, binding, turn, 0, d, [], undefined, reusedFinancialGate);
  await model.proposal(f.input); await unlink(join(f.cache, trialRequestId(binding, turn.id, 'plan', 0) + '.json'));
  await assert.rejects(model.proposal(f.input), /RESPONSE_UNAVAILABLE/); assert.equal(calls, 1); assert.equal(f.ledger.totals().held, 4304003840n);
}));

test('receipt and cache persistence faults never produce a second settlement or paid retry in the continued batch', async () => {
  for (const failure of ['receipt', 'cache']) await fixture(async f => {
    let calls = 0, receipts = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
    if (failure === 'receipt') f.ledger.receipt = async () => { receipts++; throw new BenchmarkFailure('BENCH_LEDGER_WRITE_FAILED'); };
    else await rm(f.cache, { recursive: true });
    const model = pilotModel(bundle.transport, f.journal, binding, f.corpus.singles[0]!, 0, diagnostics(), [], undefined, reusedFinancialGate);
    await assert.rejects(model.proposal(f.input)); await assert.rejects(model.proposal(f.input)); assert.equal(calls, 1);
    assert.equal(f.ledger.totals().held, failure === 'receipt' ? 6456005760n : 4304003840n); assert.equal(receipts, failure === 'receipt' ? 1 : 0);
  });
});

test('the old cost and both retained holds consume the original cumulative 20 RUB allowance before a new reserve', async () => fixture(async f => {
  assert.equal(f.journal.verify().incrementalUpperAtoms, '19385109480'); let calls = 0;
  const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  const result = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(result.stop, 'TASK_PILOT_INCREMENTAL_BUDGET_EXHAUSTED'); assert.equal(calls, 0); assert.equal(f.ledger.records.size, 10);
}, { prefix: 7 }));

test('the original 45 RUB global cap also precedes dispatch when incremental room remains', async () => fixture(async f => {
  let calls = 0; const bundle = createTaskJsonTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  const result = await runPilot(f.corpus, bundle.transport, f.journal, binding, { reusedInitialGate: reusedFinancialGate });
  assert.equal(result.stop, 'BENCH_BUDGET_EXHAUSTED'); assert.equal(calls, 0); assert.equal(f.ledger.records.size, 21);
}, { prefix: 18, budgetBaseline: '30000000000' }));

test('a second retained ID, lost delivery, budget reset or changed frozen binding cannot broaden admission', async () => fixture(async f => {
  for (const ids of [[priorSchemaProbe.id], [...jsonTrialAdmission.retainedHttp400s, 'e'.repeat(64)], [priorSchemaProbe.id, priorSchemaProbe.id]]) assert.throws(() => f.ledger.totalsWithHeldHttp400s(ids), /ADMISSION_INVALID/);
  const receipt = f.ledger.records.get(priorSchemaProbe.id)!.receipt!; receipt.code = 'BENCH_DELIVERY_UNKNOWN';
  assert.throws(() => f.journal.verify(), /BASELINE_CHANGED/); receipt.code = 'BENCH_PROVIDER_FAILURE_HTTP_400';
  for (const patch of [{ budgetBaselineUpperAtoms: f.journal.frozen.baselineUpperAtoms }, { bindingSha256: 'c'.repeat(64) }, { retainedHttp400s: [priorSchemaProbe.id] }]) await assert.rejects(PilotJournal.load({
    path: f.path, cacheDirectory: f.cache, ledger: f.ledger, bindingSha256: binding, requestIds: f.journal.frozen.requestIds, maximumCalls: 240, ...jsonTrialAdmission,
    budgetBaselineUpperAtoms: '0', readOnly: false, assertInitial() { throw new Error(); }, ...patch }), /FROZEN_ARTIFACT_CHANGED/);
  assert.equal(f.ledger.records.size, 3);
}));

test('serialized concurrent reserves cannot both spend the last remaining headroom', async () => fixture(async f => {
  // One request may reserve; its unknown receipt blocks any second request.
  const ids = f.journal.frozen.requestIds.slice(0, 2);
  const results = await Promise.allSettled(ids.map(id => f.journal.reserve(id, spec.price, bound)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.ledger.records.size, 4);
  assert.equal(f.journal.verify().cost.blocked, true); assert.equal(f.ledger.totals().held, 6456005760n);
}));

test('the continued batch rejects foreign IDs, changed price and model or token bounds before reservation', async () => fixture(async f => {
  const id = f.journal.frozen.requestIds[0]!;
  for (const changed of [{ ...bound, modelVersion: 'other' }, { ...bound, inputTokens: 10000 }, { ...bound, outputTokens: 100 }]) await assert.rejects(f.journal.reserve(id, spec.price, changed), /ADMISSION_INVALID/);
  await assert.rejects(f.journal.reserve(id, { ...spec.price, inputRubPerMillion: '1' }, bound), /ADMISSION_INVALID/);
  await assert.rejects(f.journal.reserve('b'.repeat(64), spec.price, bound), /ID_INVALID/);
  assert.equal(f.ledger.records.size, 3);
}));

test('frozen JSON identity carries the exact two operator failures, original allowance and unchanged corpus without claiming acceptance', async () => {
  const artifact = await jsonTrialBinding();
  assert.equal(artifact.binding.manifest.corpusSha256, '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f');
  assert.equal(artifact.binding.manifest.promptsSha256, 'e2465ece6e41faf4cb7277c4b667ef6b1ce544e705412a23dabc1c11f3c347e8');
  assert.notEqual(artifact.binding.wirePromptsSha256, artifact.binding.manifest.promptsSha256);
  assert.equal(artifact.binding.maximumNewModelCalls, 239); assert.equal(artifact.binding.maximumTurns, 120);
  assert.deepEqual(artifact.binding.admission, jsonTrialAdmission); assert.equal(artifact.binding.admission.budgetBaselineUpperAtoms, '20888941260');
  assert.equal(artifact.binding.reusedGate.independentRepeat, false); assert.equal(artifact.binding.reusedGate.sourceReceiptId, schemaProbeCheckpoint.gateId);
  assert.equal(artifact.binding.modelAccepted, false); assert.equal(artifact.binding.runtimeAiEnabled, false); assert.equal(artifact.binding.immutableModelVersionVerified, false);
  assert.ok(Object.keys(artifact.binding.extraSource).length >= 6);
});

test('a synthetic or replaced checkpoint cannot qualify for the real operator JSON trial', async () => fixture(async f => {
  await assert.rejects(assertJsonTrialStart(f.ledger, f.dir)); assert.equal(f.ledger.records.size, 3);
}));
