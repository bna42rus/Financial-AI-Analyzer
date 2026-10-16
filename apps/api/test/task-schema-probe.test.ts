import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import type { HeldSchemaProbePermit } from '../src/benchmark-ledger.ts';
import { candidates, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { schemaProbeRequest, schemaProbeArtifact, schemaProbeId, schemaProbeCheckpoint, runSingleSchemaProbe, verifySchemaProbeCheckpoint } from '../src/task-schema-probe.ts';
import { createSchemaProbeTransport } from '../src/task-schema-probe-transport.ts';
import { readPilotJson, writePilotJson } from '../src/task-pilot-journal.ts';

const spec = candidates['cloud-oss'], bound = { inputTokens: 131072, outputTokens: 1200, modelVersion: spec.model }, key = 'synthetic-schema-probe-secret-1234';
const keep = { op: 'keep' }, valid = { status: 'query', binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потрачено' }, grouping: keep, comparison: keep, edits: [] };
const reply = (value: unknown = valid, patch: Record<string, unknown> = {}) => new Response(JSON.stringify({ model: spec.model, system_fingerprint: 'fixture', usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300 },
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value), tool_calls: [] } }], ...patch }));

async function fixture(action: (f: { dir: string; ledgerPath: string; resultPath: string; ledger: BenchmarkLedger; permit: HeldSchemaProbePermit; request: Awaited<ReturnType<typeof schemaProbeRequest>> }) => Promise<void>, prefix = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-schema-probe-')), ledgerPath = join(dir, 'ledger.jsonl'), ledger = await BenchmarkLedger.load(ledgerPath);
  try {
    for (let i = 0; i < prefix; i++) {
      const id = benchmarkDigest('prefill-' + i); await ledger.reserve(id, spec.price, bound);
      await ledger.receipt({ id, usage: { inputTokens: 131072, outputTokens: 1200, modelVersion: spec.model }, value: {}, code: null, fingerprint: 'fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    }
    const c = schemaProbeCheckpoint; await ledger.reserve(c.gateId, spec.price, bound);
    await ledger.receipt({ id: c.gateId, usage: { inputTokens: 570, outputTokens: 132, modelVersion: spec.model }, value: { wireSha256: c.gateWireSha256 }, code: null, fingerprint: 'fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.reserve(c.rejectionId, spec.price, bound);
    await ledger.receipt({ id: c.rejectionId, usage: null, value: { wireSha256: c.rejectedWireSha256 }, code: 'BENCH_PROVIDER_FAILURE_HTTP_400', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    const t = ledger.totals(), permit: HeldSchemaProbePermit = { ...c, bindingSha256: 'd'.repeat(64), ledgerHeadSha256: ledger.previous, expectedCalls: ledger.records.size,
      expectedUpperAtoms: (t.spent + t.held).toString(), incrementalBaselineUpperAtoms: '0' };
    await action({ dir, ledgerPath, resultPath: join(dir, 'result.json'), ledger, permit, request: await schemaProbeRequest() });
  } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('exactly one corrected proposal POST reserves in the original ledger, reuses the gate and leaves the original rejection fully held', async () => fixture(async f => {
  let calls = 0; const originals = JSON.stringify([...f.ledger.records]), bundle = createSchemaProbeTransport({ apiKey: key }, (async (_, options) => {
    calls++; const wire = JSON.parse(String(options!.body)); assert.equal(JSON.stringify(wire.response_format).includes('uniqueItems'), false);
    assert.equal(wire.max_completion_tokens, 1200); assert.equal(wire.temperature, 0); assert.ok(f.ledger.records.has(schemaProbeId(f.permit.bindingSha256)));
    const durable = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true }); try { assert.equal(durable.totals().held, 4304003840n); } finally { await durable.close(); }
    return reply();
  }) as typeof fetch);
  const result = await runSingleSchemaProbe({ ...f, ...bundle, secrets: [key] });
  assert.equal(calls, 1); assert.equal(result.callsThisRun, 1); assert.equal(result.replay, false); assert.equal(result.result?.passed, true);
  assert.equal(result.modelAccepted, false); assert.equal(result.runtimeAiEnabled, false);
  assert.equal(f.ledger.totals().held, 2152001920n); assert.equal(f.ledger.totals().blocked, true);
  assert.equal(JSON.stringify([...f.ledger.records].slice(0, 2)), originals); assert.ok(await readPilotJson(f.resultPath));
  assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false);
}));

test('replay after durable reload needs no key, transport, fresh allowance or write and never pays again', async () => fixture(async f => {
  let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  const first = await runSingleSchemaProbe({ ...f, ...bundle });
  const before = [await readFile(f.ledgerPath, 'utf8'), await readFile(f.resultPath, 'utf8')];
  const ledger = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true });
  try {
    const replay = await runSingleSchemaProbe({ ...f, ledger });
    assert.equal(replay.callsThisRun, 0); assert.equal(replay.replay, true); assert.deepEqual(replay.result, first.result); assert.equal(calls, 1);
  } finally { await ledger.close(); }
  assert.deepEqual([await readFile(f.ledgerPath, 'utf8'), await readFile(f.resultPath, 'utf8')], before);
}));

test('a new HTTP 400 records useful fixed diagnostics, retains both full holds and makes every repeat free', async () => fixture(async f => {
  let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return new Response(JSON.stringify({ error: { message: key + ' xgrammar json_schema response_format uniqueItems not supported', code: key, param: key } }), { status: 400 }); }) as typeof fetch);
  const result = await runSingleSchemaProbe({ ...f, ...bundle, secrets: [key] });
  assert.equal(result.error, 'BENCH_PROVIDER_FAILURE_HTTP_400'); assert.equal(result.diagnostics?.reason, 'schema_unsupported'); assert.equal(result.diagnostics?.decoder, 'xgrammar');
  assert.deepEqual(result.diagnostics?.referencedSchemaKeywords, ['uniqueItems']); assert.equal(result.usage, null); assert.equal(f.ledger.totals().held, 4304003840n);
  assert.equal(f.ledger.totals().blocked, true); assert.equal((await runSingleSchemaProbe(f)).callsThisRun, 0); assert.equal(calls, 1);
  const source = await readFile(f.ledgerPath, 'utf8'); assert.equal(source.includes(key), false); assert.equal(JSON.stringify(result).includes(key), false);
  const reloaded = await BenchmarkLedger.load(f.ledgerPath, { readOnly: true }); try { assert.equal(reloaded.records.size, 3); assert.equal(reloaded.totals().held, 4304003840n); } finally { await reloaded.close(); }
}));

test('delivery loss, malformed usage and an oversized provider error never release a hold or expose provider text', async () => {
  for (const answer of [async () => { throw new Error(key); }, async () => new Response(JSON.stringify({ choices: [] })), async () => new Response((key + ' uniqueItems ').repeat(2000), { status: 400 })]) await fixture(async f => {
    let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return answer(); }) as typeof fetch);
    const result = await runSingleSchemaProbe({ ...f, ...bundle, secrets: [key] });
    assert.equal(result.usage, null); assert.equal(f.ledger.totals().held, 4304003840n); assert.equal((await runSingleSchemaProbe(f)).callsThisRun, 0);
    assert.equal(calls, 1); assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false); assert.equal(JSON.stringify(result).includes(key), false);
  });
});

test('known-usage parse and authoritative duplicate failures are charged once and remain measured failures on replay', async () => {
  for (const answer of [() => reply({ ...valid, edits: [{ field: 'categories', op: 'set', quote: 'потрачено', value: { names: ['потрачено', 'потрачено'] } }] }),
    () => reply(null, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: key } }] })]) await fixture(async f => {
    let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return answer(); }) as typeof fetch);
    const first = await runSingleSchemaProbe({ ...f, ...bundle, secrets: [key] }), replay = await runSingleSchemaProbe(f);
    assert.ok(first.error); assert.ok(first.usage); assert.equal(first.result, null); assert.equal(replay.error, first.error); assert.equal(calls, 1);
    assert.equal(f.ledger.totals().held, 2152001920n); assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false);
  });
});

test('cache write failure and deletion preserve settled cost and stop replay without repayment', async () => fixture(async f => {
  let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  await assert.rejects(runSingleSchemaProbe({ ...f, ...bundle, resultPath: join(f.dir, 'missing', 'result.json') }));
  assert.ok(f.ledger.records.get(schemaProbeId(f.permit.bindingSha256))?.receipt?.usage);
  await assert.rejects(runSingleSchemaProbe(f), /RESULT_UNAVAILABLE/); assert.equal(calls, 1);
}));

test('a missing successful cache cannot become a new request or a fabricated success', async () => fixture(async f => {
  let calls = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  await runSingleSchemaProbe({ ...f, ...bundle }); await unlink(f.resultPath);
  await assert.rejects(runSingleSchemaProbe({ ...f, ...bundle }), /RESULT_UNAVAILABLE/); assert.equal(calls, 1);
}));

test('receipt persistence failure leaves a full unknown reservation with no second write or dispatch', async () => fixture(async f => {
  let calls = 0, receipts = 0; const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  f.ledger.receipt = async () => { receipts++; throw new BenchmarkFailure('BENCH_LEDGER_WRITE_FAILED'); };
  await assert.rejects(runSingleSchemaProbe({ ...f, ...bundle }), /BENCH_LEDGER_WRITE_FAILED/);
  const replay = await runSingleSchemaProbe(f); assert.equal(replay.callsThisRun, 0); assert.equal(replay.error, 'BENCH_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1); assert.equal(receipts, 1); assert.equal(f.ledger.totals().held, 4304003840n);
}));

test('model/fingerprint/bound drift and a reflected fingerprint retain usage but cannot yield accepted payloads', async () => {
  for (const patch of [{ model: 'other' }, { system_fingerprint: 'changed' }, { system_fingerprint: key }, { usage: { prompt_tokens: 1000, completion_tokens: 1201, total_tokens: 2201 } }]) await fixture(async f => {
    const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => reply(valid, patch)) as typeof fetch);
    const result = await runSingleSchemaProbe({ ...f, ...bundle, secrets: [key] }); assert.ok(result.error); assert.ok(result.usage); assert.equal(result.result, null);
    assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false); assert.equal((await runSingleSchemaProbe(f)).callsThisRun, 0);
  });
});

test('a changed checkpoint, failed proof, delivery ambiguity, price or bound cannot enter the one-shot exception', async () => fixture(async f => {
  const id = schemaProbeId(f.permit.bindingSha256), original = f.ledger.records.get(f.permit.rejectionId)!.receipt!.code;
  for (const change of [{ ledgerHeadSha256: '1'.repeat(64) }, { expectedCalls: 3 }, { expectedUpperAtoms: '1' }, { gateWireSha256: '2'.repeat(64) }, { incrementalCapAtoms: '21000000000' }]) {
    await assert.rejects(f.ledger.reserveHeldSchemaProbe(id, spec.price, bound, { ...f.permit, ...change }), /NOT_ALLOWED/);
  }
  f.ledger.records.get(f.permit.rejectionId)!.receipt!.code = 'BENCH_DELIVERY_UNKNOWN';
  await assert.rejects(f.ledger.reserveHeldSchemaProbe(id, spec.price, bound, f.permit), /NOT_ALLOWED/);
  f.ledger.records.get(f.permit.rejectionId)!.receipt!.code = original;
  await assert.rejects(f.ledger.reserveHeldSchemaProbe(id, { ...spec.price, inputRubPerMillion: '1' }, bound, f.permit), /NOT_ALLOWED/);
  await assert.rejects(f.ledger.reserveHeldSchemaProbe(id, spec.price, { ...bound, outputTokens: 100 }, f.permit), /NOT_ALLOWED/);
  assert.equal(f.ledger.records.size, 2);
}));

test('the original cumulative 20 RUB incremental cap and 45 RUB global cap both precede dispatch', async () => {
  for (const prefix of [8, 19]) await fixture(async f => {
    const permit = prefix === 19 ? { ...f.permit, incrementalBaselineUpperAtoms: '30000000000' } : f.permit; let calls = 0;
    const bundle = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
    await assert.rejects(runSingleSchemaProbe({ ...f, ...bundle, permit }), /BENCH_BUDGET_EXHAUSTED/); assert.equal(calls, 0);
  }, prefix);
});

test('parallel callers and even a different new binding cannot turn the one-shot permit into two HTTP calls', async () => fixture(async f => {
  let calls = 0; const first = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch), second = createSchemaProbeTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  const outcomes = await Promise.allSettled([runSingleSchemaProbe({ ...f, ...first }), runSingleSchemaProbe({ ...f, ...second, permit: { ...f.permit, bindingSha256: 'e'.repeat(64) } })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(calls, 1); assert.equal(f.ledger.records.size, 3);
}));

test('the frozen probe binds the supplied real checkpoint, exact old request, full new source and only a decoder-schema change', async () => {
  const artifact = await schemaProbeArtifact(); assert.equal(artifact.binding.originalCheckpoint.checkpointSha256, '2f3012fc7cca47ee5abc6a3eea0276aea975a0681fb236c35193f95272734671');
  assert.equal(artifact.id, schemaProbeId(artifact.bindingSha256)); assert.equal(artifact.binding.maximumNewCalls, 1);
  assert.equal(artifact.binding.originalIncrementalCapAtoms, '20000000000'); assert.equal(artifact.binding.oldHoldsReleased, false);
  assert.equal(artifact.binding.manifest.corpusSha256, '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f');
  assert.equal(Object.keys(artifact.binding.extraSource).length, 4);
  assert.equal(artifact.binding.modelAccepted, false); assert.equal(artifact.binding.runtimeAiEnabled, false);
});

test('an arbitrary local ledger or replacement frozen file cannot qualify as the operator checkpoint', async () => fixture(async f => {
  const artifact = await schemaProbeArtifact(), payload = { bindingSha256: schemaProbeCheckpoint.bindingSha256, baselineRecordsSha256: schemaProbeCheckpoint.baselineRecordsSha256 };
  await writePilotJson(join(f.dir, 'task-pilot-v1.json'), { hash: benchmarkDigest(payload), payload });
  await assert.rejects(verifySchemaProbeCheckpoint(f.ledger, f.dir, artifact), /CHECKPOINT_CHANGED/);
  assert.equal(f.ledger.records.size, 2);
}));
