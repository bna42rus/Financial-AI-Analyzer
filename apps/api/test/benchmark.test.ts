import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkTransport, candidates, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import { benchmarkPromptVersion, runSmoke, smokeCostReport } from '../src/benchmark-engine.ts';
import { fixtureVersion, smokeScenarios } from '../src/benchmark-fixtures.ts';
import { gatePrompt, gateSchema } from '../../../packages/analyzer/src/yandex-contract.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { isYandexTransport } from '../src/yandex-transport.ts';
import { assertInactiveOperator, probeRequestId, runProbe } from '../src/benchmark-probe.ts';
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

test('explicit probe preserves the rejected call reserve and replays without payment after reload', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => {
    calls++; return response({ relevance: 'financial', followUp: false });
  }) as typeof fetch);
  const oldId = 'a'.repeat(64);
  await ledger.reserve(oldId, client.price, client.bound);
  await ledger.receipt({ id: oldId, usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1569, cachedTokens: null, reasoningTokens: null });
  const held = ledger.totals().held;
  const first = await runProbe(client, ledger);
  assert.equal(calls, 1); assert.equal(first.callsThisRun, 1); assert.equal(first.error, null);
  assert.equal(ledger.totals().held, held); assert.equal(ledger.totals().blocked, true);
  assert.equal(ledger.records.get(oldId)!.receipt!.usage, null);
  const restarted = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try {
    const replay = await runProbe(client, restarted);
    assert.equal(calls, 1); assert.equal(replay.callsThisRun, 0); assert.equal(replay.replay, true);
    await assert.rejects(restarted.reserveProbe('b'.repeat(64), client.price, client.bound), /BENCH_PROBE_NOT_ALLOWED/);
    await assert.rejects(restarted.reserve('c'.repeat(64), client.price, client.bound), /BENCH_RECONCILIATION_REQUIRED/);
  } finally { await restarted.close(); }
}));
test('probe cannot bypass delivery loss, crash, changed bounds/prices or the shared budget', async () => {
  for (const code of ['BENCH_DELIVERY_UNKNOWN', 'BENCH_RESPONSE_INVALID', null]) await sandbox(async (_, ledger) => {
    let calls = 0;
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({}); }) as typeof fetch);
    await ledger.reserve('a'.repeat(64), client.price, client.bound);
    if (code) await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code, fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await assert.rejects(runProbe(client, ledger), /BENCH_PROBE_NOT_ALLOWED/); assert.equal(calls, 0);
  });
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    const costly = { ...client.price, inputRubPerMillion: '200', outputRubPerMillion: '300' };
    await ledger.reserve('a'.repeat(64), costly, client.bound);
    await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await assert.rejects(ledger.reserveProbe('b'.repeat(64), costly, client.bound), /BENCH_BUDGET_EXHAUSTED/);
    await assert.rejects(ledger.reserveProbe('b'.repeat(64), client.price, client.bound), /BENCH_PROBE_NOT_ALLOWED/);
    await assert.rejects(ledger.reserveProbe('b'.repeat(64), costly, { ...client.bound, outputTokens: 10 }), /BENCH_PROBE_NOT_ALLOWED/);
  });
});
test('probe keeps both reserves on rejection; diagnostics never persist reflected credentials', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => {
    calls++; return new Response(JSON.stringify({ error: { message: `Unsupported max_completion_tokens ${key}` } }), { status: 422 });
  }) as typeof fetch);
  await ledger.reserve('a'.repeat(64), client.price, client.bound);
  await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  const oldHeld = ledger.totals().held;
  const result = await runProbe(client, ledger);
  assert.equal(result.error, 'BENCH_PROVIDER_FAILURE_HTTP_422');
  assert.deepEqual(result.referencedParameters, ['max_completion_tokens']);
  assert.equal(ledger.totals().held, oldHeld * 2n); assert.equal(calls, 1);
  const replay = await runProbe(client, ledger); assert.equal(calls, 1); assert.equal(replay.callsThisRun, 0);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).includes(key));
}));
test('operator probe refuses active, unsafe or malformed original locks without deleting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-probe-lock-')), path = join(dir, 'operator.lock');
  try {
    await writeFile(path, String(process.pid), { mode: 0o600 });
    await assert.rejects(assertInactiveOperator(path), /BENCH_OPERATOR_ACTIVE/);
    assert.equal(await readFile(path, 'utf8'), String(process.pid));
    await chmod(path, 0o644); await assert.rejects(assertInactiveOperator(path), /BENCH_OPERATOR_LOCK_INVALID/);
    await chmod(path, 0o600); await writeFile(path, '0'); await assert.rejects(assertInactiveOperator(path), /BENCH_OPERATOR_LOCK_INVALID/);
    await writeFile(path, '2147483647'); await assertInactiveOperator(path);
    await symlink(path, join(dir, 'link')); await assert.rejects(assertInactiveOperator(join(dir, 'link')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('post-funding probe has a separate id, preserves both old reserves and replays without dispatch', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => {
    calls++;
    return calls === 1 ? new Response('Payment Required', { status: 402 }) : response({ relevance: 'financial', followUp: false });
  }) as typeof fetch);
  await ledger.reserve('a'.repeat(64), client.price, client.bound);
  await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  await assert.rejects(runProbe(client, ledger, 'after-funding'), /BENCH_PROBE_NOT_ALLOWED/); assert.equal(calls, 0);
  const rejected = await runProbe(client, ledger); assert.equal(rejected.error, 'BENCH_PROVIDER_FAILURE_HTTP_402');
  const held = ledger.totals().held;
  assert.notEqual(probeRequestId(client), probeRequestId(client, 'after-funding'));
  const funded = await runProbe(client, ledger, 'after-funding');
  assert.equal(calls, 2); assert.equal(funded.callsThisRun, 1); assert.equal(funded.error, null);
  assert.equal(ledger.totals().held, held); assert.equal(ledger.records.size, 3);
  const restarted = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try {
    const replay = await runProbe(client, restarted, 'after-funding');
    assert.equal(replay.callsThisRun, 0); assert.equal(calls, 2); assert.equal(restarted.totals().held, held);
    await assert.rejects(restarted.reserveProbe('b'.repeat(64), client.price, client.bound, 'operator_probe_after_funding'), /BENCH_PROBE_NOT_ALLOWED/);
    await assert.rejects(runProbe(client, restarted, 'third-attempt' as 'initial'), /BENCH_PROBE_NOT_ALLOWED/);
  } finally { await restarted.close(); }
}));
test('post-funding probe cannot bypass non-payment failures, missing receipts or the cumulative cap', async () => {
  for (const code of ['BENCH_PROVIDER_FAILURE_HTTP_400', 'BENCH_DELIVERY_UNKNOWN', null]) await sandbox(async (_, ledger) => {
    let calls = 0;
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({}); }) as typeof fetch);
    await ledger.reserve('a'.repeat(64), client.price, client.bound);
    await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    const id = probeRequestId(client);
    await ledger.reserveProbe(id, client.price, client.bound);
    if (code) await ledger.receipt({ id, usage: null, value: null, code, fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await assert.rejects(runProbe(client, ledger, 'after-funding'), /BENCH_PROBE_NOT_ALLOWED/); assert.equal(calls, 0);
  });
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    const price = { ...client.price, inputRubPerMillion: '120', outputRubPerMillion: '300' };
    await ledger.reserve('a'.repeat(64), price, client.bound);
    await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.reserveProbe('b'.repeat(64), price, client.bound);
    await ledger.receipt({ id: 'b'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE_HTTP_402', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await assert.rejects(ledger.reserveProbe('c'.repeat(64), price, client.bound, 'operator_probe_after_funding'), /BENCH_BUDGET_EXHAUSTED/);
  });
});

async function seedFundedSmoke(ledger: BenchmarkLedger, client: ReturnType<typeof createBenchmarkTransport>, proofChange: Record<string, unknown> = {}) {
  // Reproduce the exact failed first smoke ID, not a convenient unrelated fixture.
  const question = smokeScenarios[0]!.turns[0]!.question;
  const oldId = benchmarkDigest({ fixtureVersion, benchmarkPromptVersion, mode: 'task', caseId: 'total', candidate: client.candidate, price: client.price,
    step: 'gate', prompt: gatePrompt, input: { question, hasFinancialContext: false }, schema: gateSchema });
  await ledger.reserve(oldId, client.price, client.bound);
  await ledger.receipt({ id: oldId, usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE', fingerprint: null, latencyMs: 1569, cachedTokens: null, reasoningTokens: null });
  const probeId = probeRequestId(client);
  await ledger.reserveProbe(probeId, client.price, client.bound);
  await ledger.receipt({ id: probeId, usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE_HTTP_402', fingerprint: null, latencyMs: 100, cachedTokens: null, reasoningTokens: null });
  const proofId = probeRequestId(client, 'after-funding');
  await ledger.reserveProbe(proofId, client.price, client.bound, 'operator_probe_after_funding');
  await ledger.receipt({ id: proofId, usage: { inputTokens: 212, outputTokens: 192, modelVersion: model }, value: { relevance: 'financial', followUp: false }, code: null,
    fingerprint: 'fixture-v1', latencyMs: 100, cachedTokens: null, reasoningTokens: null, ...proofChange });
  return { oldId, probeId, proofId };
}
test('funded smoke preserves both old reserves, avoids the failed cached id and resumes without payment', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    const gate = { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false };
    let planned = scriptedPlans[turn.id];
    if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
    return response(isGate ? gate : planned);
  }) as typeof fetch);
  const { oldId } = await seedFundedSmoke(ledger, client);
  const held = ledger.totals().held, before = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  await ledger.allowFundedSmoke();
  assert.equal(ledger.totals().held, held); assert.equal(ledger.totals().blocked, false);
  const first = await runSmoke(client, ledger, 'task', 'after-funding');
  assert.equal(first.turns, 24); assert.equal(first.passed, 24); assert.equal(calls, 46);
  assert.equal(ledger.records.get(oldId)!.receipt!.usage, null); assert.equal(ledger.totals().held, held);
  assert.equal(smokeCostReport(ledger).requiresReconciliation, true);
  assert.equal(smokeCostReport(ledger).budgetUsedUpperBoundAtoms, (ledger.totals().spent + held).toString());
  const source = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); assert.ok(source.startsWith(before));
  const restarted = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try {
    await restarted.allowFundedSmoke();
    const replay = await runSmoke(client, restarted, 'task', 'after-funding');
    assert.equal(replay.passed, 24); assert.equal(calls, 46); assert.equal(replay.checks[0]!.replayCalls, 2);
    assert.equal(restarted.totals().held, held);
  } finally { await restarted.close(); }
}));
test('funded continuation refuses failed, absent, wrong-model or oversized proof without releasing funds', async () => {
  for (const proofChange of [
    { usage: null, code: 'BENCH_DELIVERY_UNKNOWN' }, { code: 'BENCH_PLAN_INVALID' },
    { value: { relevance: 'unrelated', followUp: false } },
    { usage: { inputTokens: 212, outputTokens: 192, modelVersion: 'other' } },
    { usage: { inputTokens: 212, outputTokens: 1201, modelVersion: model } },
  ]) await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    await seedFundedSmoke(ledger, client, proofChange); const held = ledger.totals().held;
    await assert.rejects(ledger.allowFundedSmoke(), /BENCH_FUNDED_CONTINUATION_NOT_ALLOWED/);
    assert.equal(ledger.totals().held, held); assert.equal(ledger.totals().blocked, true);
  });
});
test('funded continuation keeps the shared ceiling and freezes any new ambiguous call', async () => {
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    await seedFundedSmoke(ledger, client); await ledger.allowFundedSmoke(); const held = ledger.totals().held;
    for (let n = 0; n < 18; n++) {
      const id = benchmarkDigest({ fundedBudget: n }); await ledger.reserve(id, client.price, client.bound);
      await ledger.receipt({ id, usage: { ...client.bound }, value: {}, code: null, fingerprint: 'fixture-v1', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    }
    await assert.rejects(ledger.reserve('f'.repeat(64), client.price, client.bound), /BENCH_BUDGET_EXHAUSTED/);
    assert.equal(ledger.totals().held, held);
  });
  await sandbox(async (_, ledger) => {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key });
    await seedFundedSmoke(ledger, client); await ledger.allowFundedSmoke(); const held = ledger.totals().held;
    await ledger.reserve('f'.repeat(64), client.price, client.bound);
    await ledger.receipt({ id: 'f'.repeat(64), usage: null, value: null, code: 'BENCH_DELIVERY_UNKNOWN', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.allowFundedSmoke();
    assert.equal(ledger.totals().blocked, true); assert.ok(ledger.totals().held > held);
    await assert.rejects(ledger.reserve('e'.repeat(64), client.price, client.bound), /BENCH_RECONCILIATION_REQUIRED/);
  });
});
