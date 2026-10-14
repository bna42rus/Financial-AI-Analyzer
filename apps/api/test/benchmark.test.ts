import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkTransport, candidates, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import { runSmoke, smokeCostReport } from '../src/benchmark-engine.ts';
import { smokeScenarios } from '../src/benchmark-fixtures.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { isYandexTransport } from '../src/yandex-transport.ts';
const key = 'synthetic-benchmark-api-key-not-a-secret';
const model = candidates['cloud-oss'].model;
const response = (value: unknown, change: Record<string, unknown> = {}) => new Response(JSON.stringify({ model,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, system_fingerprint: 'fixture-v1', ...change }));
async function sandbox(action: (directory: string, ledger: BenchmarkLedger) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-bench-')); const ledger = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try { await action(dir, ledger); } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}
test('experimental providers use fixed HTTPS hosts, pinned models, bounded JSON and cannot become runtime transports', async () => {
  for (const candidate of Object.keys(candidates) as (keyof typeof candidates)[]) {
    let calls = 0, reserved = false;
    const config = candidate === 'yandex-qwen' ? { apiKey: key, folderId: 'b1g00000000000000000' } : { apiKey: key };
    const transport = createBenchmarkTransport(candidate, config, (async (url, options) => {
      assert.ok(reserved); calls++;
      assert.equal(url, candidate === 'yandex-qwen' ? 'https://ai.api.cloud.yandex.net/v1/chat/completions' : 'https://foundation-models.api.cloud.ru/v1/chat/completions');
      assert.equal(options?.redirect, 'error'); const body = JSON.parse(String(options?.body));
      assert.equal(body.stream, false); assert.equal(body.n, 1); assert.ok(!body.tools);
      assert.ok(!String(options?.body).includes(key)); assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.max_completion_tokens ?? body.max_tokens, 1200);
      return response({}, { model: body.model });
    }) as typeof fetch);
    assert.equal(isYandexTransport(transport), false);
    const completed = await transport.complete('Return JSON', { question: 'Тест' }, {}, async () => { reserved = true; });
    assert.equal(calls, 1); assert.equal(completed.usage.inputTokens, 100);
  }
});
test('bad credentials, unknown model or oversized context never dispatch', async () => {
  for (const config of [{ apiKey: 'short' }, { apiKey: key, url: 'https://private' }, { apiKey: key + '\r\nHeader' }, { apiKey: key, folderId: 'not-for-cloud' }]) assert.throws(() => createBenchmarkTransport('cloud-oss', config));
  assert.throws(() => createBenchmarkTransport('other' as 'cloud-oss', { apiKey: key }));
  let calls = 0; const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({}); }) as typeof fetch);
  await assert.rejects(client.complete('x'.repeat(65536), {}, {}, async () => {}), /BENCH_CONTEXT_LIMIT/); assert.equal(calls, 0);
  await assert.rejects(client.complete('test', {}, {}, async () => { throw new Error('no budget'); }), /no budget/); assert.equal(calls, 0);
});
test('every refusal, redirect, lost response and read failure is one attempt without reflected secrets', async () => {
  for (const status of [302, 400, 401, 402, 403, 404, 422, 429, 500, 503]) {
    let calls = 0; const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return new Response(key, { status }); }) as typeof fetch);
    await assert.rejects(client.complete('test', {}, {}, async () => {}), (e: unknown) => e instanceof BenchmarkFailure && e.code.endsWith(`_HTTP_${status}`) && e.usage === undefined && !JSON.stringify(e).includes(key));
    assert.equal(calls, 1);
  }
  let calls = 0; const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; throw new Error(key); }) as typeof fetch);
  await assert.rejects(client.complete('test', {}, {}, async () => {}), /BENCH_DELIVERY_UNKNOWN/); assert.equal(calls, 1);
});
test('invalid JSON, truncation, refusal, tool calls and changed aliases preserve billable usage', async () => {
  for (const change of [
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{secret broken' } }] },
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', refusal: 'No' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{}] } }] },
    { model: 'another-model' }, { model: key },
  ]) {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({}, change)) as typeof fetch);
    await assert.rejects(client.complete('test', {}, {}, async () => {}), (e: unknown) => e instanceof BenchmarkFailure && e.usage?.inputTokens === 100 && e.usage?.outputTokens === 10 && !JSON.stringify(e).includes('secret broken'));
  }
});
test('usage cannot silently become zero; cache and reasoning are counted as subsets once', async () => {
  for (const usage of [null, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 111 }, { prompt_tokens: '100', completion_tokens: 10, total_tokens: 110 }]) {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({}, { usage })) as typeof fetch);
    await assert.rejects(client.complete('test', {}, {}, async () => {}), (e: unknown) => e instanceof BenchmarkFailure && e.usage === undefined);
  }
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({}, { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 7 } } })) as typeof fetch);
  const result = await client.complete('test', {}, {}, async () => {});
  assert.equal(result.cachedTokens, 80); assert.equal(result.reasoningTokens, 7);
  assert.equal(tokenCost(client.price, result.usage.inputTokens, result.usage.outputTokens), 2196000n);
});
test('documented full context window is reserved and Qwen is blocked by the smoke budget before dispatch', async () => sandbox(async (_, ledger) => {
  let calls = 0; const client = createBenchmarkTransport('yandex-qwen', { apiKey: key, folderId: 'b1g00000000000000000' }, (async () => { calls++; return response({}); }) as typeof fetch);
  assert.equal(client.bound.inputTokens, 262144);
  await assert.rejects(client.complete('test', {}, {}, () => ledger.reserve('a'.repeat(64), client.price, client.bound)), /BENCH_BUDGET_EXHAUSTED/);
  assert.equal(calls, 0); assert.equal(ledger.records.size, 0);
}));
test('crash after durable reservation holds funds and blocks retry after reload', async () => sandbox(async (dir, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
  await ledger.reserve('a'.repeat(64), client.price, client.bound);
  const restarted = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try { assert.equal(restarted.totals().held, tokenCost(client.price, client.bound.inputTokens, client.bound.outputTokens)); await assert.rejects(restarted.reserve('b'.repeat(64), client.price, client.bound), /BENCH_RECONCILIATION_REQUIRED/); }
  finally { await restarted.close(); }
}));
test('parallel reservation cannot spend twice and duplicate receipt is rejected', async () => sandbox(async (_, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
  const results = await Promise.allSettled(['a', 'b'].map(c => ledger.reserve(c.repeat(64), client.price, client.bound)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const receipt = { id: 'a'.repeat(64), usage: { inputTokens: 100, outputTokens: 10, modelVersion: model }, value: {}, code: 'BENCH_RESPONSE_INVALID', fingerprint: 'fixture-v1', latencyMs: 10, cachedTokens: null, reasoningTokens: null };
  await ledger.receipt(receipt); assert.equal(ledger.totals().spent, 2196000n); assert.equal(ledger.totals().held, 0n);
  await assert.rejects(ledger.receipt(receipt));
}));
test('unknown usage, overshoot, model drift and fingerprint drift require reconciliation', async () => {
  for (const change of [{ usage: null }, { usage: { inputTokens: 131073, outputTokens: 10, modelVersion: model } }, { usage: { inputTokens: 100, outputTokens: 1201, modelVersion: model } }, { usage: { inputTokens: 100, outputTokens: 10, modelVersion: 'other' } }]) await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }); await ledger.reserve('a'.repeat(64), client.price, client.bound);
    await ledger.receipt({ id: 'a'.repeat(64), value: null, code: 'BENCH_RESPONSE_INVALID', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null, ...change });
    assert.equal(ledger.totals().blocked, true);
  });
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    for (const [id, fingerprint] of [['a', 'v1'], ['b', 'v2']]) {
      await ledger.reserve(id!.repeat(64), client.price, client.bound);
      await ledger.receipt({ id: id!.repeat(64), usage: { inputTokens: 100, outputTokens: 10, modelVersion: model }, value: {}, code: null, fingerprint: fingerprint!, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    }
    assert.equal(ledger.totals().blocked, true);
  });
});
test('ledger rejects partial writes, tampering, public permissions and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-journal-')); const path = join(dir, 'test.jsonl');
  try {
    for (const text of ['{partial', JSON.stringify({ previous: '0'.repeat(64), event: {}, hash: benchmarkDigest({}) }) + '\n']) {
      await writeFile(path, text, { mode: 0o600 }); await assert.rejects(BenchmarkLedger.load(path), /BENCH_LEDGER_INVALID/);
    }
    await writeFile(path, ''); await chmod(path, 0o644); await assert.rejects(BenchmarkLedger.load(path), /BENCH_LEDGER_INVALID/);
    await symlink(path, join(dir, 'link')); await assert.rejects(BenchmarkLedger.load(join(dir, 'link')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cumulative smoke limit and frozen tariff survive separate calls and restart', async () => sandbox(async (dir, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
  for (let n = 0; n < 20; n++) {
    const id = benchmarkDigest(n); await ledger.reserve(id, client.price, client.bound);
    await ledger.receipt({ id, usage: { ...client.bound }, value: {}, code: null, fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  }
  const restarted = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try {
    assert.equal(restarted.totals().spent, 43040038400n);
    await assert.rejects(restarted.reserve('f'.repeat(64), client.price, client.bound), /BENCH_BUDGET_EXHAUSTED/);
    await assert.rejects(restarted.reserve('f'.repeat(64), { ...client.price, inputRubPerMillion: '1' }, client.bound), /BENCH_PRICE_CHANGED/);
  } finally { await restarted.close(); }
}));

// Scripted model validates the runner and fixtures only; it proves no live LLM quality.
const rawPlan = (filter: unknown = {}, metric = 'expenses', grouping = 'none', comparison = 'none') => ({ status: 'query', query: { name: 'query_finances', metric, grouping, comparison, filter } });
const scriptedPlans: Record<string, unknown> = {
  total: rawPlan(), income: rawPlan({}, 'income'), groups: rawPlan({}, 'expenses', 'category'), attention: rawPlan({}, 'attention', 'operation'),
  compare: rawPlan({}, 'expenses', 'none', 'previous_same'), date: rawPlan({ from: '2026-09-01', through: '2026-09-30' }),
  category: rawPlan({ categoryNames: ['Продукты'] }), selected: rawPlan(), leaf: rawPlan({ subcategoryNames: ['Такси'] }), write: { status: 'unsupported', query: null },
  'scope-1': rawPlan({ from: '2026-09-01', through: '2026-09-30', categoryNames: ['Продукты'] }),
  'scope-2': rawPlan({}, 'expenses', 'category'), 'scope-3': rawPlan({ subcategoryNames: ['Такси'] }, 'expenses', 'category'),
  'scope-4': rawPlan({ from: '2026-10-01', through: '2026-10-31' }, 'expenses', 'category'),
  'scope-5': rawPlan({ from: '2026-10-01', through: '2026-10-31' }, 'income'), 'scope-6': rawPlan({}, 'income', 'category'),
  'global-1': rawPlan({}, 'expenses', 'category'), 'global-2': rawPlan({}, 'expenses', 'category', 'previous_same'),
  'global-3': rawPlan({}, 'expenses', 'category'), 'global-4': rawPlan({}, 'expenses', 'operation'), 'global-5': rawPlan(), 'global-6': rawPlan({}, 'income'),
};
test('24 smoke turns and all context modes resolve real state; resume makes zero extra calls and never sends reference IDs', async () => sandbox(async (dir, ledger) => {
  let calls = 0; const turns = smokeScenarios.flatMap(s => s.turns);
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body)); const input = JSON.parse(body.messages[1].content);
    assert.ok(!String(options?.body).includes('11111111-')); assert.ok(!String(options?.body).includes('33333333-')); assert.ok(!input.catalog);
    const turn = turns.find(t => t.question === input.question)!;
    // Repeated phrases have equal raw plans/gates except follow-up state.
    const gate = { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false };
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    let planned = scriptedPlans[turn.id];
    if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
    return response(isGate ? gate : planned);
  }) as typeof fetch);
  for (const mode of ['task', 'window', 'transcript'] as const) {
    const result = await runSmoke(client, ledger, mode); assert.equal(result.turns, 24); assert.deepEqual(result.checks.filter(c => !c.gate || c.plan === false), []);
    assert.equal(result.checks[0]!.calls, 2); assert.equal(result.checks[0]!.inputTokens, 200); assert.equal(result.checks[0]!.costAtoms, '4392000');
    const count = calls; const replay = await runSmoke(client, ledger, mode); assert.equal(calls, count); assert.equal(replay.checks[0]!.replayCalls, 2);
  }
  assert.equal(calls, 138); assert.equal(smokeCostReport(ledger).inputTokens, 13800);
  assert.equal(smokeCostReport(ledger).requiresReconciliation, false);
  const source = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); assert.ok(!source.includes(key));
}));
test('schema-invalid paid response is accounted as failure; ambiguous delivery stops the entire run', async () => {
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({ wrong: true })) as typeof fetch);
    const result = await runSmoke(client, ledger, 'task'); assert.equal(result.passed, 0); assert.equal(smokeCostReport(ledger).calls, 24); assert.equal(smokeCostReport(ledger).failedCalls, 24); assert.ok(ledger.totals().spent > 0n);
  });
  await sandbox(async (_, ledger) => {
    let calls = 0; const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; throw new Error('network'); }) as typeof fetch);
    await assert.rejects(runSmoke(client, ledger, 'task'), /BENCH_RECONCILIATION_REQUIRED/); assert.equal(calls, 1); assert.ok(ledger.totals().held > 0n);
    await assert.rejects(runSmoke(client, ledger, 'task'), /BENCH_RECONCILIATION_REQUIRED/); assert.equal(calls, 1);
  });
});
test('receipt stores only validated local results, not reflected arbitrary provider names', async () => sandbox(async (dir, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options?.body));
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    return response(isGate ? { relevance: 'financial', followUp: false } : rawPlan({ categoryNames: [key] }));
  }) as typeof fetch);
  await runSmoke(client, ledger, 'task');
  const source = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); assert.ok(!source.includes(key));
  assert.ok(source.includes('clarification'));
}));
