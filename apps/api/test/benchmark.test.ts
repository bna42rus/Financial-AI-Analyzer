import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBenchmarkTransport, replayOnlyBenchmarkTransport, candidates, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import { benchmarkPromptVersion, runSmoke, runComparison, runExplicitTrial, runLiteralRegression, runTransfer, smokeCostReport, inspectBenchmark } from '../src/benchmark-engine.ts';
import { fixtureVersion, smokeScenarios, syntheticCatalog, october } from '../src/benchmark-fixtures.ts';
import { gatePrompt, gateSchema } from '../../../packages/analyzer/src/yandex-contract.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { isYandexTransport } from '../src/yandex-transport.ts';
import { assertInactiveOperator, archiveRejectedGigaLock, probeRequestId, runProbe, runFormatProbe } from '../src/benchmark-probe.ts';
import { revisedGatePrompt, revisedPlanPrompt, resolvedPlanPrompt, resolvedBenchmarkPromptVersion } from '../src/benchmark-prompts.ts';
import { parseReferencePlan } from '../src/benchmark-reference-plan.ts';
import { parseDeltaPlan, deltaPlanPrompt, deltaPlanSchema } from '../src/benchmark-delta-plan.ts';
import { transferScenarios, transferFixtureVersion } from '../src/benchmark-transfer-fixtures.ts';
import { parseExplicitPlan, explicitPlanPrompt, explicitPlanSchema } from '../src/benchmark-explicit-plan.ts';
import { parseMoneyLiteral, parseQuotedMoney } from '../src/benchmark-money.ts';
import { parseLiteralPlan, literalGatePrompt, literalPlanPrompt, literalPlanSchema } from '../src/benchmark-literal-plan.ts';
import { queryOperations } from '../../../packages/finance-core/src/operations.ts';
import type { OperationRow } from '../../../packages/finance-core/src/operations.ts';
import { facet } from '../../../packages/finance-core/src/model.ts';
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

test('offline audit reproduces saved mistakes and errors without credentials or journal changes', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    let planned = scriptedPlans[turn.id];
    if (input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask?.metric ?? 'expenses', 'category', input.previousTask?.comparison ?? 'none');
    if (turn.id === 'income' && input.selectedPeriod?.from === '2026-10-01') planned = rawPlan();
    if (turn.id === 'date') planned = { invalid: true };
    return response(isGate ? { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false } : planned);
  }) as typeof fetch);
  await seedFundedSmoke(ledger, client); await ledger.allowFundedSmoke();
  const live = await runSmoke(client, ledger, 'task', 'after-funding');
  assert.equal(live.passed, 22);
  const path = join(dir, 'ledger.jsonl'), source = await readFile(path);
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const report = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), saved, 'task', 'after-funding', true);
    assert.equal(report.passed, live.passed); assert.equal(calls, 46);
    assert.ok(report.checks.every(c => c.replayCalls === c.calls));
    assert.equal(report.checks.find(c => c.id === 'income')!.diagnostics!.actualPlan!.query!.metric, 'expenses');
    assert.deepEqual(report.checks.find(c => c.id === 'date')!.diagnostics!.errors, [{ step: 'plan', code: 'BENCH_PLAN_INVALID' }]);
    assert.deepEqual(smokeCostReport(saved), smokeCostReport(ledger));
    await assert.rejects(saved.reserve('f'.repeat(64), client.price, client.bound), /BENCH_REPLAY_ONLY/);
    assert.equal(saved.totals().blocked, false);
    await assert.rejects(runSmoke(replayOnlyBenchmarkTransport('cloud-giga'), saved, 'task', 'after-funding', true), /BENCH_REPLAY_ONLY/);
    assert.deepEqual(await readFile(path), source);
    assert.ok(!JSON.stringify(report).includes(key));
  } finally { await saved.close(); }
}));
test('offline transport never reserves and readonly loading never creates a missing ledger', async () => {
  let reserved = false;
  await assert.rejects(replayOnlyBenchmarkTransport('cloud-oss').complete('', {}, {}, async () => { reserved = true; }), /BENCH_REPLAY_ONLY/);
  assert.equal(reserved, false);
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-readonly-')), path = join(dir, 'missing.jsonl');
  try {
    await assert.rejects(BenchmarkLedger.load(path, { readOnly: true }));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('revised trial keeps original receipts, propagates bounded gate state and replays both versions for free', async () => sandbox(async (dir, ledger) => {
  let calls = 0, revisedGates = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
    const prompt = body.messages[0].content;
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    if (prompt === revisedGatePrompt) {
      revisedGates++;
      assert.deepEqual(Object.keys(input).sort(), ['hasFinancialContext', 'previousTask', 'question']);
      assert.equal(Boolean(input.previousTask), input.hasFinancialContext);
      if (input.previousTask) assert.deepEqual(Object.keys(input.previousTask).sort(), ['comparison', 'grouping', 'metric']);
      if (turn.id === 'scope-3') assert.deepEqual(input.previousTask, { metric: 'expenses', grouping: 'category', comparison: 'none' });
    }
    assert.ok(!String(options?.body).includes('11111111-'));
    let planned = scriptedPlans[turn.id];
    if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
    if (!isGate && turn.id === 'income' && prompt !== revisedPlanPrompt) planned = rawPlan({}, 'income', 'category');
    return response(isGate ? { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false } : planned);
  }) as typeof fetch);
  await seedFundedSmoke(ledger, client); await ledger.allowFundedSmoke();
  const original = await runSmoke(client, ledger, 'task', 'after-funding');
  assert.equal(original.passed, 22); assert.equal(calls, 46);
  const before = await readFile(join(dir, 'ledger.jsonl')), held = ledger.totals().held, size = ledger.records.size;
  const revised = await runSmoke(client, ledger, 'task', 'after-funding', false, 'revised');
  assert.equal(revised.benchmarkPromptVersion, 'cashneuro-smoke-prompt/2');
  assert.equal(revised.passed, 24); assert.equal(calls, 92); assert.equal(revisedGates, 24);
  assert.equal(ledger.records.size, size + 46); assert.equal(ledger.totals().held, held);
  assert.ok((await readFile(join(dir, 'ledger.jsonl'))).subarray(0, before.length).equals(before));
  const saved = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const source = await readFile(join(dir, 'ledger.jsonl'));
    const oldReport = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), saved, 'task', 'after-funding', true);
    const newReport = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), saved, 'task', 'after-funding', true, 'revised');
    assert.equal(oldReport.passed, 22); assert.equal(newReport.passed, 24);
    assert.ok(newReport.checks.every(c => c.replayCalls === c.calls));
    assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
    assert.deepEqual(smokeCostReport(saved), smokeCostReport(ledger));
  } finally { await saved.close(); }
}));
test('revised parser failures retain usage and expose only a fixed local phase', async () => sandbox(async (dir, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options?.body)), isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    return response(isGate ? { relevance: 'financial', followUp: false } : rawPlan({ from: key }));
  }) as typeof fetch);
  const result = await runSmoke(client, ledger, 'task', 'after-funding', true, 'revised');
  assert.equal(result.passed, 0);
  assert.ok(result.checks.every(c => c.diagnostics!.errors.some(e => e.step === 'plan' && e.code === 'BENCH_PLAN_INVALID_TOOL')));
  assert.equal(smokeCostReport(ledger).reportedCalls, 48); assert.equal(smokeCostReport(ledger).failedCalls, 24);
  assert.equal(ledger.totals().held, 0n);
  assert.ok(!(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).includes(key));
}));

test('depth-neutral names resolve unique owned roots/leaves and preserve date and category replacement', () => {
  const food = syntheticCatalog.categories[0]!, travel = syntheticCatalog.categories[1]!, taxi = syntheticCatalog.categories[2]!;
  const oldScope = { from: '2026-09-01', through: '2026-09-30', categoryIds: [food.id] };
  const leaf = parseReferencePlan(rawPlan({ categoryNames: ['такси'] }), oldScope, syntheticCatalog);
  assert.equal(leaf.resolution, null);
  assert.deepEqual(leaf.plan.query!.filter, { from: oldScope.from, through: oldScope.through, categoryIds: [travel.id], subcategoryIds: [taxi.id] });
  const root = parseReferencePlan(rawPlan({ categoryNames: ['Продукты'] }), leaf.plan.query!.filter, syntheticCatalog);
  assert.deepEqual(root.plan.query!.filter, oldScope);
  const both = parseReferencePlan(rawPlan({ categoryNames: ['Поездки', 'Такси'] }), october, syntheticCatalog);
  assert.deepEqual(both.plan.query!.filter, { ...october, categoryIds: [travel.id], subcategoryIds: [taxi.id] });
  assert.equal(parseReferencePlan(rawPlan({ subcategoryNames: ['Такси'] }), october, syntheticCatalog).resolution, null);
  const longParent = { ...travel, name: 'П'.repeat(159) }, longLeaf = { ...taxi, name: 'Т'.repeat(60) };
  assert.equal(parseReferencePlan(rawPlan({ categoryNames: [longLeaf.name] }), october, { ...syntheticCatalog, categories: [longParent, longLeaf] }).plan.status, 'query');
});
test('unknown, ambiguous and mixed classifications clarify; qualified paths cannot widen to another parent', () => {
  const food = syntheticCatalog.categories[0]!, travel = syntheticCatalog.categories[1]!, taxi = syntheticCatalog.categories[2]!;
  const duplicate = { ...taxi, id: '44444444-4444-4444-8444-444444444444', parentId: food.id };
  const catalog = { ...syntheticCatalog, categories: [...syntheticCatalog.categories, duplicate] };
  assert.equal(parseReferencePlan(rawPlan({ categoryNames: ['Такси'] }), october, catalog).resolution, 'reference_ambiguous');
  assert.equal(parseReferencePlan(rawPlan({ categoryNames: ['Неизвестное'] }), october, catalog).resolution, 'reference_missing');
  assert.equal(parseReferencePlan(rawPlan({ categoryNames: ['Продукты', 'Поездки / Такси'] }), october, catalog).resolution, 'mixed_classification_scope');
  const selected = parseReferencePlan(rawPlan({ categoryNames: ['Поездки / Такси'] }), october, catalog);
  assert.deepEqual(selected.plan.query!.filter, { ...october, categoryIds: [travel.id], subcategoryIds: [taxi.id] });
  const rootCollision = { ...catalog, categories: [...catalog.categories, { ...travel, id: '55555555-5555-4555-8555-555555555555', name: 'Такси' }] };
  assert.equal(parseReferencePlan(rawPlan({ categoryNames: ['Такси'] }), october, rootCollision).resolution, 'reference_ambiguous');
  assert.equal(parseReferencePlan({ status: 'clarification', query: null }, october, catalog).resolution, 'model_clarification');
  assert.equal(parseReferencePlan({ status: 'unsupported', query: null }, october, catalog).resolution, null);
});
test('depth-neutral parser remains closed and rejects invalid reference labels before persistence', () => {
  for (const filter of [{ categoryNames: [] }, { categoryNames: ['Такси', 'такси'] }, { categoryNames: [key, key] }, { categoryNames: ['Такси'], categoryIds: ['11111111-1111-4111-8111-111111111111'] }]) {
    assert.throws(() => parseReferencePlan(rawPlan(filter), october, syntheticCatalog));
  }
  assert.throws(() => parseReferencePlan(rawPlan({ categoryNames: ['Нет'], arbitrarySql: 'SELECT 1' }), october, syntheticCatalog));
  assert.throws(() => parseReferencePlan(rawPlan({ categoryNames: ['Нет'] }, 'invalid'), october, syntheticCatalog));
});
test('resolved version stores safe resolution reasons and restores the taxi continuation without changing prior trials', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content), prompt = body.messages[0].content;
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    assert.ok(!String(options?.body).includes(taxiId));
    let gate = { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false };
    if (turn.id === 'scope-4' && !input.hasFinancialContext) gate = { relevance: 'ambiguous', followUp: false };
    let planned = scriptedPlans[turn.id];
    if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
    if (!isGate && ['leaf', 'scope-3'].includes(turn.id)) planned = prompt === resolvedPlanPrompt ? rawPlan({ categoryNames: ['Такси'] }, 'expenses', turn.id === 'scope-3' ? 'category' : 'none') : { status: 'clarification', query: null };
    return response(isGate ? gate : planned);
  }) as typeof fetch);
  const taxiId = syntheticCatalog.categories[2]!.id;
  await seedFundedSmoke(ledger, client); await ledger.allowFundedSmoke();
  const before = await runSmoke(client, ledger, 'task', 'after-funding', true, 'revised');
  assert.equal(before.passed, 21);
  const path = join(dir, 'ledger.jsonl'), source = await readFile(path), held = ledger.totals().held;
  const resolved = await runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved');
  assert.equal(resolved.passed, 24); assert.equal(resolved.benchmarkPromptVersion, 'cashneuro-smoke-prompt/3');
  assert.equal(calls, 91); assert.equal(ledger.totals().held, held);
  assert.ok((await readFile(path)).subarray(0, source.length).equals(source));
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const latest = await readFile(path);
    const oldReport = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), saved, 'task', 'after-funding', true, 'revised');
    const report = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), saved, 'task', 'after-funding', true, 'resolved');
    assert.equal(oldReport.passed, 21); assert.equal(report.passed, 24); assert.equal(calls, 91);
    assert.deepEqual(await readFile(path), latest);
    assert.ok(!latest.toString().includes(key));
  } finally { await saved.close(); }
}));

test('resolved journal distinguishes model clarification from local missing names without retaining reflected text', async () => sandbox(async (dir, ledger) => {
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
    const isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
    return response(isGate ? { relevance: 'financial', followUp: false } : input.question === 'Покажи расходы на такси.' ?
      { status: 'clarification', query: null } : rawPlan({ categoryNames: [key] }));
  }) as typeof fetch);
  const result = await runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved');
  assert.equal(result.checks.find(c => c.id === 'leaf')!.diagnostics!.resolution, 'model_clarification');
  assert.equal(result.checks.find(c => c.id === 'scope-3')!.diagnostics!.resolution, 'reference_missing');
  assert.equal(smokeCostReport(ledger).reportedCalls, 48); assert.equal(smokeCostReport(ledger).failedCalls, 0);
  const source = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  assert.ok(source.includes('model_clarification')); assert.ok(source.includes('reference_missing'));
  assert.ok(!source.includes(key));
}));

test('Giga comparison uses the same frozen request contents, distinct receipts and the shared journal/budget', async () => sandbox(async (dir, ledger) => {
  const payloads: Record<string, unknown[]> = { 'cloud-oss': [], 'cloud-giga': [] };
  function client(candidate: 'cloud-oss' | 'cloud-giga') {
    return createBenchmarkTransport(candidate, { apiKey: key }, (async (_, options) => {
      const body = JSON.parse(String(options?.body)), { model: requestedModel, ...payload } = body;
      payloads[candidate]!.push(payload);
      const input = JSON.parse(body.messages[1].content), isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
      const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
      let planned = scriptedPlans[turn.id];
      if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
      return response(isGate ? { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false } : planned, { model: requestedModel });
    }) as typeof fetch);
  }
  const oss = client('cloud-oss'), giga = client('cloud-giga');
  await seedFundedSmoke(ledger, oss); await ledger.allowFundedSmoke();
  await runSmoke(oss, ledger, 'task', 'after-funding', false, 'resolved');
  const path = join(dir, 'ledger.jsonl'), source = await readFile(path), held = ledger.totals().held, spent = ledger.totals().spent;
  const compared = await runComparison(giga, ledger, 'task');
  assert.equal(compared.candidate, 'cloud-giga'); assert.equal(compared.passed, 24); assert.equal(compared.baseline.passed, 24);
  assert.equal(compared.benchmarkPromptVersion, compared.baseline.benchmarkPromptVersion);
  assert.deepEqual(payloads['cloud-giga'], payloads['cloud-oss']);
  assert.equal(payloads['cloud-giga']!.length, 46); assert.equal(ledger.records.size, 95);
  assert.equal(ledger.totals().held, held); assert.equal(ledger.totals().spent - spent, 46n * 1342000n);
  assert.ok((await readFile(path)).subarray(0, source.length).equals(source));
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const latest = await readFile(path);
    const replay = await runComparison(replayOnlyBenchmarkTransport('cloud-giga'), saved, 'task');
    assert.equal(replay.passed, 24); assert.ok(replay.checks.every(c => c.replayCalls === c.calls));
    assert.equal(payloads['cloud-giga']!.length, 46); assert.equal(payloads['cloud-oss']!.length, 46);
    assert.deepEqual(await readFile(path), latest);
  } finally { await saved.close(); }
}));
test('comparison rejects an absent baseline, changed mode or unsupported candidate before paid dispatch', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const giga = createBenchmarkTransport('cloud-giga', { apiKey: key }, (async () => { calls++; return response({}); }) as typeof fetch);
  const source = await readFile(join(dir, 'ledger.jsonl'));
  await assert.rejects(runComparison(giga, ledger, 'task'), /BENCH_REPLAY_ONLY/);
  await assert.rejects(runComparison(giga, ledger, 'window'), /BENCH_REPLAY_ONLY/);
  await assert.rejects(runComparison(replayOnlyBenchmarkTransport('cloud-oss'), ledger, 'task'), /BENCH_CONFIGURATION_INVALID/);
  assert.equal(calls, 0); assert.equal(ledger.records.size, 0);
  assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
}));

test('response diagnostics expose fixed validation phases and shapes without reflected provider text', async () => {
  const good = JSON.stringify({ relevance: 'financial', followUp: false });
  for (const [phase, choice] of [
    ['FINISH', { finish_reason: key, message: { role: 'assistant', content: good } }],
    ['ROLE', { finish_reason: 'stop', message: { role: key, content: good } }],
    ['REFUSAL', { finish_reason: 'stop', message: { role: 'assistant', content: good, refusal: key } }],
    ['TOOL_CALLS', { finish_reason: 'stop', message: { role: 'assistant', content: good, tool_calls: [] } }],
    ['TOOL_CALLS', { finish_reason: 'stop', message: { role: 'assistant', content: good, tool_calls: [{ name: key }] } }],
    ['FUNCTION_CALL', { finish_reason: 'stop', message: { role: 'assistant', content: good, function_call: { name: key } } }],
    ['JSON', { finish_reason: 'stop', message: { role: 'assistant', content: '```json\n' + key + '\n```' } }],
  ] as const) {
    const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({}, { choices: [choice] })) as typeof fetch);
    await assert.rejects(client.complete('test', {}, {}, async () => {}), (error: unknown) => {
      assert.ok(error instanceof BenchmarkFailure); assert.equal(error.responsePhase, phase); assert.ok(error.usage);
      assert.ok(!JSON.stringify(error).includes(key));
      if (phase === 'JSON') { assert.equal(error.responseShape!.contentIsJson, false); assert.equal(error.responseShape!.contentHasFence, true); }
      return true;
    });
  }
});
test('batch stops on the first invalid response, retains paid usage and refuses paid continuation on replay', async () => sandbox(async (_, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => {
    calls++; return response({}, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] });
  }) as typeof fetch);
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved'), /BENCH_CAPABILITY_FAILURE/);
  assert.equal(calls, 1); assert.equal(ledger.records.size, 1); assert.equal(smokeCostReport(ledger).reportedCalls, 1);
  assert.equal(ledger.totals().spent, 2196000n); assert.equal(ledger.totals().held, 0n);
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved'), /BENCH_CAPABILITY_FAILURE/);
  assert.equal(calls, 1); assert.equal(ledger.records.size, 1);
  await assert.rejects(runSmoke(replayOnlyBenchmarkTransport('cloud-oss'), ledger, 'task', 'after-funding', true, 'resolved'), /BENCH_REPLAY_ONLY/);
  assert.equal(calls, 1);
}));
// Historical Giga receipts from the pre-stop runner. No raw provider content.
async function seedFormatFailures(ledger: BenchmarkLedger) {
  const client = createBenchmarkTransport('cloud-giga', { apiKey: key });
  for (const turn of smokeScenarios.flatMap(s => s.turns)) {
    const id = benchmarkDigest({ fixtureVersion, benchmarkPromptVersion: resolvedBenchmarkPromptVersion, mode: 'task', caseId: turn.id,
      candidate: client.candidate, price: client.price, step: 'gate', prompt: revisedGatePrompt,
      input: { question: turn.question, hasFinancialContext: false, previousTask: null }, schema: gateSchema, attempt: 'after-funding/1' });
    await ledger.reserve(id, client.price, client.bound);
    await ledger.receipt({ id, usage: { inputTokens: 100, outputTokens: 10, modelVersion: client.bound.modelVersion }, value: null, code: 'BENCH_RESPONSE_INVALID',
      fingerprint: 'fixture-v1', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  }
}
test('one format probe identifies the envelope failure, preserves old receipts and repeats without payment', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-giga', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options?.body));
    return response({}, { model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ relevance: 'financial', followUp: false }), tool_calls: [] } }] });
  }) as typeof fetch);
  await assert.rejects(runFormatProbe(client, ledger), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0);
  await seedFormatFailures(ledger); const path = join(dir, 'ledger.jsonl'), source = await readFile(path), spent = ledger.totals().spent;
  const first = await runFormatProbe(client, ledger);
  assert.equal(calls, 1); assert.equal(first.callsThisRun, 1); assert.equal(first.error, 'BENCH_RESPONSE_INVALID');
  assert.deepEqual(first.diagnostics, { gate: null, responsePhase: 'TOOL_CALLS', responseShape: { finishReason: 'stop', role: 'assistant', toolCalls: 'empty_array',
    functionCall: 'missing', refusal: 'missing', content: 'string', contentIsJson: true, contentHasFence: false } });
  assert.equal(ledger.totals().spent - spent, 1342000n); assert.equal(ledger.records.size, 25);
  assert.ok((await readFile(path)).subarray(0, source.length).equals(source));
  assert.ok(!(await readFile(path, 'utf8')).includes(key));
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const replay = await runFormatProbe(replayOnlyBenchmarkTransport('cloud-giga'), saved);
    assert.equal(replay.callsThisRun, 0); assert.equal(replay.replay, true); assert.deepEqual(replay.diagnostics, first.diagnostics);
    const report = await runSmoke(replayOnlyBenchmarkTransport('cloud-giga'), saved, 'task', 'after-funding', true, 'resolved');
    assert.equal(report.turns, 24); assert.equal(report.passed, 0); assert.equal(calls, 1);
  } finally { await saved.close(); }
}));
test('unknown format-probe delivery retains the whole new reserve and cannot dispatch again', async () => sandbox(async (_, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-giga', { apiKey: key }, (async () => { calls++; throw new Error(key); }) as typeof fetch);
  await seedFormatFailures(ledger);
  const first = await runFormatProbe(client, ledger);
  assert.equal(first.error, 'BENCH_DELIVERY_UNKNOWN'); assert.equal(first.usage, null);
  const held = tokenCost(client.price, client.bound.inputTokens, client.bound.outputTokens);
  assert.equal(ledger.totals().held, held); assert.equal(ledger.totals().blocked, true);
  const replay = await runFormatProbe(client, ledger); assert.equal(replay.callsThisRun, 0); assert.equal(calls, 1);
  assert.equal(ledger.totals().held, held); assert.ok(!JSON.stringify(first).includes(key));
}));

test('corrected response contract accepts missing/null/empty tools but rejects every real or malformed action', async () => {
  const good = JSON.stringify({ relevance: 'financial', followUp: false });
  async function complete(extra: Record<string, unknown>) {
    const client = createBenchmarkTransport('cloud-giga', { apiKey: key }, (async () => response({}, { model: candidates['cloud-giga'].model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: good, function_call: null, refusal: null, ...extra } }] })) as typeof fetch, 'empty-tools');
    assert.equal(client.responseContract, 'cashneuro-response/2');
    return client.complete('test', {}, {}, async () => {});
  }
  for (const extra of [{}, { tool_calls: null }, { tool_calls: [] }]) assert.deepEqual((await complete(extra)).value, JSON.parse(good));
  for (const tool_calls of [[{ type: 'function', function: { name: key } }], {}, '', false, 0]) await assert.rejects(complete({ tool_calls }), (e: unknown) =>
    e instanceof BenchmarkFailure && e.responsePhase === 'TOOL_CALLS' && Boolean(e.usage) && !JSON.stringify(e).includes(key));
  await assert.rejects(complete({ tool_calls: [], function_call: { name: key } }), (e: unknown) => e instanceof BenchmarkFailure && e.responsePhase === 'FUNCTION_CALL');
  await assert.rejects(complete({ tool_calls: [], content: '```json\n' + good + '\n```' }), (e: unknown) => e instanceof BenchmarkFailure && e.responsePhase === 'JSON');
});
test('corrected adapter uses a new receipt namespace and keeps old Giga failures and held costs replayable', async () => sandbox(async (dir, ledger) => {
  const payloads: Record<string, unknown[]> = { 'cloud-oss': [], 'cloud-giga': [] };
  function client(candidate: 'cloud-oss' | 'cloud-giga') {
    return createBenchmarkTransport(candidate, { apiKey: key }, (async (_, options) => {
      const body = JSON.parse(String(options?.body)), { model: requestedModel, ...payload } = body;
      payloads[candidate]!.push(payload);
      const input = JSON.parse(body.messages[1].content), isGate = Boolean(body.response_format.json_schema.schema.properties.relevance);
      const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
      let planned = scriptedPlans[turn.id];
      if (!isGate && input.question === 'А по категориям?') planned = rawPlan({}, input.previousTask.metric, 'category', input.previousTask.comparison);
      const value = isGate ? { ...turn.expectedGate, followUp: input.hasFinancialContext ? turn.expectedGate.followUp : false } : planned;
      return response({}, { model: requestedModel, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value),
        ...(candidate === 'cloud-giga' ? { tool_calls: [], function_call: null, refusal: null } : {}) } }] });
    }) as typeof fetch, candidate === 'cloud-giga' ? 'empty-tools' : 'legacy');
  }
  const oss = client('cloud-oss'), giga = client('cloud-giga');
  await seedFundedSmoke(ledger, oss); await ledger.allowFundedSmoke(); await seedFormatFailures(ledger);
  await runSmoke(oss, ledger, 'task', 'after-funding', false, 'resolved');
  const path = join(dir, 'ledger.jsonl'), source = await readFile(path), held = ledger.totals().held, spent = ledger.totals().spent;
  const compared = await runComparison(giga, ledger, 'task');
  assert.equal(compared.responseContract, 'cashneuro-response/2'); assert.equal(compared.passed, 24);
  assert.equal(ledger.records.size, 119); assert.equal(ledger.totals().held, held);
  assert.equal(ledger.totals().spent - spent, 46n * 1342000n);
  assert.deepEqual(payloads['cloud-giga'], payloads['cloud-oss']);
  assert.ok((await readFile(path)).subarray(0, source.length).equals(source));
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const latest = await readFile(path);
    const old = await runSmoke(replayOnlyBenchmarkTransport('cloud-giga'), saved, 'task', 'after-funding', true, 'resolved');
    assert.equal(old.passed, 0); assert.equal(old.turns, 24);
    const replay = await runComparison(replayOnlyBenchmarkTransport('cloud-giga', 'empty-tools'), saved, 'task');
    assert.equal(replay.passed, 24); assert.ok(replay.checks.every(c => c.replayCalls === c.calls));
    assert.deepEqual(await readFile(path), latest); assert.equal(payloads['cloud-giga']!.length, 46);
  } finally { await saved.close(); }
}));
test('corrected comparison also stops on a gate that fails the closed schema and never retries it', async () => sandbox(async (_, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-giga', { apiKey: key }, (async () => {
    calls++; return response({ wrong: true }, { model: candidates['cloud-giga'].model });
  }) as typeof fetch, 'empty-tools');
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved'), /BENCH_CAPABILITY_FAILURE/);
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'resolved'), /BENCH_CAPABILITY_FAILURE/);
  assert.equal(calls, 1); assert.equal(smokeCostReport(ledger).reportedCalls, 1);
  assert.equal(ledger.totals().spent, 1342000n); assert.equal(ledger.totals().held, 0n);
}));

test('offline inspection exposes a known rejection and full reserve while dispatch remains blocked', async () => sandbox(async (dir, ledger) => {
  const giga = createBenchmarkTransport('cloud-giga', { apiKey: key });
  await ledger.reserve('a'.repeat(64), giga.price, giga.bound);
  await ledger.receipt({ id: 'a'.repeat(64), usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE_HTTP_400', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  const path = join(dir, 'ledger.jsonl'), source = await readFile(path), totals = ledger.totals();
  const saved = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const report = inspectBenchmark(saved, 'cloud-giga');
    assert.equal(report.paidCalls, 0); assert.equal(report.recent[0]!.error, 'BENCH_PROVIDER_FAILURE_HTTP_400');
    assert.equal(report.recent[0]!.usage, null); assert.equal(report.unresolved[0]!.heldAtoms, tokenCost(giga.price, giga.bound.inputTokens, giga.bound.outputTokens).toString());
    assert.equal(report.cost.requiresReconciliation, true); assert.deepEqual(saved.totals(), totals);
    assert.deepEqual(await readFile(path), source); assert.equal(inspectBenchmark(saved, 'cloud-oss').recordedCalls, 0);
    await assert.rejects(saved.reserve('b'.repeat(64), giga.price, giga.bound), /BENCH_RECONCILIATION_REQUIRED/);
  } finally { await saved.close(); }
}));
test('inspection distinguishes a missing receipt without changing or releasing its reservation', async () => sandbox(async (_, ledger) => {
  const oss = createBenchmarkTransport('cloud-oss', { apiKey: key });
  await ledger.reserve('a'.repeat(64), oss.price, oss.bound);
  const before = ledger.totals(), report = inspectBenchmark(ledger, 'cloud-oss');
  assert.equal(report.unresolved[0]!.error, 'BENCH_RECEIPT_MISSING'); assert.equal(report.cost.spentAtoms, '0');
  assert.equal(report.cost.heldAtoms, before.held.toString()); assert.deepEqual(ledger.totals(), before);
  assert.throws(() => inspectBenchmark(ledger, 'other' as 'cloud-oss'), /BENCH_CONFIGURATION_INVALID/);
}));

async function seedGigaRejection(ledger: BenchmarkLedger, receiptChange: Record<string, unknown> = {}, proofChange: Record<string, unknown> = {}) {
  const oss = createBenchmarkTransport('cloud-oss', { apiKey: key }), giga = createBenchmarkTransport('cloud-giga', { apiKey: key });
  await seedFundedSmoke(ledger, oss); await ledger.allowFundedSmoke();
  const proofId = benchmarkDigest('giga-known-financial-gate'), rejectionId = benchmarkDigest('giga-rejected-plan');
  await ledger.reserve(proofId, giga.price, giga.bound);
  await ledger.receipt({ id: proofId, usage: { inputTokens: 1206, outputTokens: 13, modelVersion: giga.bound.modelVersion },
    value: { relevance: 'financial', followUp: false }, code: null, fingerprint: 'fixture-v1', latencyMs: 1, cachedTokens: null, reasoningTokens: null, ...proofChange });
  await ledger.reserve(rejectionId, giga.price, giga.bound);
  await ledger.receipt({ id: rejectionId, usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE_HTTP_400', fingerprint: null,
    latencyMs: 1, cachedTokens: null, reasoningTokens: null, ...receiptChange });
  return { oss, giga, proofId, rejectionId };
}
test('retiring the verified Giga rejection retains every atom, restricts new calls to OSS and survives reload', async () => sandbox(async (dir, ledger) => {
  const { oss, giga } = await seedGigaRejection(ledger), before = ledger.totals();
  assert.equal(before.blocked, true); assert.equal(before.held, 7516800640n);
  await ledger.allowOssContinuation();
  assert.deepEqual(ledger.totals(), { ...before, blocked: false });
  assert.equal(smokeCostReport(ledger).requiresReconciliation, true);
  const source = await readFile(join(dir, 'ledger.jsonl'));
  await ledger.allowOssContinuation(); assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
  await assert.rejects(ledger.reserve('c'.repeat(64), giga.price, giga.bound), /BENCH_CANDIDATE_RETIRED/);
  const loaded = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try {
    assert.deepEqual(loaded.totals(), ledger.totals());
    await loaded.reserve('d'.repeat(64), oss.price, oss.bound);
    assert.equal(loaded.totals().held, before.held + tokenCost(oss.price, oss.bound.inputTokens, oss.bound.outputTokens));
    await assert.rejects(loaded.allowOssContinuation(), /BENCH_RECONCILIATION_REQUIRED/);
    await assert.rejects(loaded.reserve('e'.repeat(64), oss.price, oss.bound), /BENCH_RECONCILIATION_REQUIRED/);
  } finally { await loaded.close(); }
}));
test('OSS continuation cannot excuse delivery loss, another HTTP error or an unproven gate', async () => {
  for (const change of [{ code: 'BENCH_PROVIDER_FAILURE' }, { code: 'BENCH_PROVIDER_FAILURE_HTTP_402' }, { code: null }]) await sandbox(async (dir, ledger) => {
    await seedGigaRejection(ledger, change); const source = await readFile(join(dir, 'ledger.jsonl')), before = ledger.totals();
    await assert.rejects(ledger.allowOssContinuation(), /BENCH_OSS_CONTINUATION_NOT_ALLOWED/);
    assert.deepEqual(ledger.totals(), before); assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
  });
  await sandbox(async (_, ledger) => {
    await seedGigaRejection(ledger, {}, { value: { relevance: 'unrelated', followUp: false } });
    await assert.rejects(ledger.allowOssContinuation(), /BENCH_OSS_CONTINUATION_NOT_ALLOWED/);
  });
});
test('retiring Giga never bypasses the original shared smoke ceiling', async () => sandbox(async (_, ledger) => {
  const { oss } = await seedGigaRejection(ledger); await ledger.allowOssContinuation();
  let stopped = false;
  for (let i = 0; i < 30; i++) {
    const id = benchmarkDigest({ costlyOss: i });
    try { await ledger.reserve(id, oss.price, oss.bound); }
    catch (error) { assert.match(String(error), /BENCH_BUDGET_EXHAUSTED/); stopped = true; break; }
    await ledger.receipt({ id, usage: { inputTokens: oss.bound.inputTokens, outputTokens: oss.bound.outputTokens, modelVersion: oss.bound.modelVersion },
      value: null, code: null, fingerprint: 'fixture-v1', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  }
  assert.equal(stopped, true); assert.ok(ledger.totals().spent + ledger.totals().held <= 45_000_000_000n);
  assert.equal(ledger.totals().held, 7516800640n);
}));
test('a completed Giga rejection archives only its inactive diagnostic lock without modifying money or the journal', async () => sandbox(async (dir, ledger) => {
  const { rejectionId } = await seedGigaRejection(ledger), path = join(dir, 'diagnostic.lock');
  const source = await readFile(join(dir, 'ledger.jsonl')), before = ledger.totals();
  await writeFile(path, '2147483647', { mode: 0o600 });
  const archive = await archiveRejectedGigaLock(path, join(dir, 'ledger.jsonl'));
  assert.equal(archive, join(dir, `diagnostic-giga-${rejectionId}.lock`)); assert.equal(await readFile(archive, 'utf8'), '2147483647');
  await assert.rejects(readFile(path), { code: 'ENOENT' }); assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
  assert.deepEqual(ledger.totals(), before);
}));
test('lock recovery refuses active processes, delivery loss, symlinks and existing archives', async () => {
  await sandbox(async (dir, ledger) => {
    const { rejectionId } = await seedGigaRejection(ledger), path = join(dir, 'diagnostic.lock');
    await writeFile(path, String(process.pid), { mode: 0o600 });
    await assert.rejects(archiveRejectedGigaLock(path, join(dir, 'ledger.jsonl')), /BENCH_OPERATOR_ACTIVE/);
    await writeFile(path, '2147483647'); await symlink(path, join(dir, 'linked.lock'));
    await assert.rejects(archiveRejectedGigaLock(join(dir, 'linked.lock'), join(dir, 'ledger.jsonl')));
    const archive = join(dir, `diagnostic-giga-${rejectionId}.lock`); await writeFile(archive, 'preserved', { mode: 0o600 });
    await assert.rejects(archiveRejectedGigaLock(path, join(dir, 'ledger.jsonl')), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), '2147483647'); assert.equal(await readFile(archive, 'utf8'), 'preserved');
  });
  await sandbox(async (dir, ledger) => {
    await seedGigaRejection(ledger, { code: 'BENCH_PROVIDER_FAILURE' }); const path = join(dir, 'diagnostic.lock');
    await writeFile(path, '2147483647', { mode: 0o600 });
    await assert.rejects(archiveRejectedGigaLock(path, join(dir, 'ledger.jsonl')), /BENCH_OSS_CONTINUATION_NOT_ALLOWED/);
    assert.equal(await readFile(path, 'utf8'), '2147483647');
  });
});
test('delta contract inherits semantic state on the server, resolves category replacement and rejects invalid explicit values', () => {
  const prior = { metric: 'income', grouping: 'category', comparison: 'previous_same' } as const;
  const base = { ...october, categoryIds: ['22222222-2222-4222-8222-222222222222'], subcategoryIds: ['33333333-3333-4333-8333-333333333333'] };
  assert.deepEqual(parseDeltaPlan({ status: 'query', changes: {} }, base, syntheticCatalog, prior).plan,
    { status: 'query', query: { name: 'query_finances', ...prior, filter: base } });
  const changed = parseDeltaPlan({ status: 'query', changes: { grouping: 'none', comparison: 'none', filter: { categoryNames: ['Продукты'] } } }, base, syntheticCatalog, prior);
  assert.deepEqual(changed.plan.query?.filter, { ...october, categoryIds: ['11111111-1111-4111-8111-111111111111'] });
  assert.equal(changed.plan.query?.metric, 'income'); assert.equal(changed.plan.query?.grouping, 'none'); assert.equal(changed.plan.query?.comparison, 'none');
  assert.equal(parseDeltaPlan({ status: 'query', changes: { metric: 'attention' } }, october, syntheticCatalog).plan.query?.grouping, 'operation');
  assert.equal(parseDeltaPlan({ status: 'query', changes: { filter: { categoryNames: ['Нет'] } } }, october, syntheticCatalog).resolution, 'reference_missing');
  for (const changes of [{ metric: null }, { metric: 'budget' }, { grouping: null }, { comparison: false }, { filter: null }, { filter: { categoryIds: ['forged'] } }, { sql: 'SELECT 1' }]) {
    assert.throws(() => parseDeltaPlan({ status: 'query', changes }, october, syntheticCatalog));
  }
  assert.throws(() => parseDeltaPlan({ status: 'unsupported', changes: { metric: 'expenses' } }, october, syntheticCatalog));
  assert.throws(() => parseDeltaPlan({ status: 'query', changes: {}, query: null }, october, syntheticCatalog));
});
const scriptedDeltas: Record<string, unknown> = {
  total: {}, income: { metric: 'income' }, groups: { grouping: 'category' }, attention: { metric: 'attention' }, compare: { comparison: 'previous_same' },
  date: { filter: { from: '2026-09-01', through: '2026-09-30' } }, category: { filter: { categoryNames: ['Продукты'] } }, selected: {}, leaf: { filter: { categoryNames: ['Такси'] } },
  'scope-1': { filter: { from: '2026-09-01', through: '2026-09-30', categoryNames: ['Продукты'] } },
  'scope-2': { grouping: 'category' }, 'scope-3': { filter: { categoryNames: ['Такси'] } }, 'scope-4': { filter: { from: '2026-10-01', through: '2026-10-31' } },
  'scope-5': { metric: 'income', filter: { from: '2026-10-01', through: '2026-10-31' } }, 'scope-6': { grouping: 'category' },
  'global-1': { grouping: 'category' }, 'global-2': { comparison: 'previous_same' }, 'global-3': { comparison: 'none' },
  'global-4': { grouping: 'operation' }, 'global-5': { grouping: 'none' }, 'global-6': { metric: 'income' },
};
function deltaFixtureClient(onRequest: (body: any) => void = () => {}, forceBadFirstGate = false) {
  return createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options!.body)), input = JSON.parse(body.messages[1].content); onRequest(body);
    const isGate = body.messages[0].content === revisedGatePrompt;
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    if (isGate) return response(forceBadFirstGate && turn.id === 'total' ? { relevance: 'unrelated', followUp: false } : turn.expectedGate);
    assert.equal(body.messages[0].content, deltaPlanPrompt); assert.deepEqual(body.response_format.json_schema.schema, deltaPlanSchema);
    return response({ status: turn.id === 'write' ? 'unsupported' : 'query', changes: scriptedDeltas[turn.id] ?? {} });
  }) as typeof fetch, 'empty-tools');
}
test('delta smoke verifies original goldens with sparse changes in every context mode, and replays without a new payment', async () => sandbox(async (dir, ledger) => {
  let calls = 0;
  const client = deltaFixtureClient(body => {
    calls++; const input = JSON.parse(body.messages[1].content);
    assert.equal('catalog' in input, false); assert.equal('expectedPlan' in input, false);
    assert.doesNotMatch(JSON.stringify(body), /11111111|22222222|33333333|categoryIds|subcategoryIds/);
  });
  for (const mode of ['task', 'window', 'transcript'] as const) {
    const result = await runSmoke(client, ledger, mode, 'after-funding', true, 'delta');
    assert.equal(result.passed, 24); assert.equal(result.benchmarkPromptVersion, 'cashneuro-smoke-prompt/4');
    assert.equal(result.fixtureVersion, fixtureVersion); assert.equal(result.responseContract, 'cashneuro-response/2');
  }
  const source = await readFile(join(dir, 'ledger.jsonl')), before = calls;
  const readonly = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const report = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), readonly, 'task', 'after-funding', true, 'delta');
    assert.equal(report.passed, 24); assert.equal(report.checks.reduce((n, c) => n + c.replayCalls, 0), 46); assert.equal(calls, before);
  } finally { await readonly.close(); }
  assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
}));
test('independent transfer corpus is frozen, disjoint and gated before any paid call', async () => sandbox(async (_, ledger) => {
  const turns = transferScenarios.flatMap(s => s.turns), questions = new Set(smokeScenarios.flatMap(s => s.turns).map(t => t.question));
  assert.equal(turns.length, 72); assert.equal(transferScenarios.filter(s => s.turns.length === 6).length, 6);
  assert.equal(new Set(turns.map(t => t.id)).size, 72); assert.ok(turns.every(t => !questions.has(t.question)));
  assert.equal(transferFixtureVersion, 'cashneuro-transfer/1');
  let calls = 0; const client = deltaFixtureClient(() => { calls++; });
  await assert.rejects(runTransfer(client, ledger), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0);
  const imperfect = deltaFixtureClient(() => { calls++; }, true);
  const baseline = await runSmoke(imperfect, ledger, 'task', 'after-funding', false, 'delta'); assert.equal(baseline.passed, 23);
  const before = calls; await assert.rejects(runTransfer(client, ledger), /BENCH_TRANSFER_BASELINE_REQUIRED/); assert.equal(calls, before);
}));
test('delta retains the last successful task across clarification and unrelated turns; actual mistakes cannot be hidden by goldens', async () => sandbox(async (_, ledger) => {
  const scenarios = [transferScenarios.find(s => s.id === 'transfer-interruption')!, transferScenarios.find(s => s.id === 'transfer-globals')!];
  // Exercise all 72 turns but give all other turns deliberately unrelated gates.
  // The selected dialogs use independent, hand-authored sparse model responses.
  const changes: Record<string, unknown> = {
    'tx-1': { filter: { from: '2026-08-01', through: '2026-08-31', categoryNames: ['Продукты'] } },
    'tx-2': { filter: { categoryNames: ['Орбитальные станции'] } }, 'tx-3': { grouping: 'category' },
    'tx-5': { grouping: 'operation' }, 'tx-6': { metric: 'income', filter: { from: '2026-07-01', through: '2026-07-31' } },
    'tg-1': { filter: { from: '2026-05-01', through: '2026-05-31' } }, 'tg-2': { grouping: 'category' },
    'tg-3': {}, 'tg-4': {}, 'tg-5': {}, 'tg-6': { filter: { from: '2026-09-01', through: '2026-09-30', categoryNames: ['Продукты'] } },
  };
  const seen: Record<string, any> = {};
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options!.body)), input = JSON.parse(body.messages[1].content);
    const turn = scenarios.flatMap(s => s.turns).find(t => t.question === input.question);
    if (body.messages[0].content === revisedGatePrompt) return response(turn?.expectedGate ?? { relevance: 'unrelated', followUp: false });
    seen[turn!.id] = input;
    return response({ status: 'query', changes: changes[turn!.id] });
  }) as typeof fetch, 'empty-tools');
  const result = await runSmoke(client, ledger, 'task', 'after-funding', true, 'delta', 'transfer');
  for (const turn of scenarios.flatMap(s => s.turns)) {
    const check = result.checks.find(c => c.id === turn.id)!; assert.equal(check.gate, true, turn.id); assert.notEqual(check.plan, false, turn.id);
  }
  assert.deepEqual(seen['tx-3'].previousTask, { metric: 'expenses', grouping: 'none', comparison: 'none' });
  assert.deepEqual(seen['tx-5'].previousTask, { metric: 'expenses', grouping: 'category', comparison: 'none' });
  assert.equal(seen['tx-6'].previousTask, null); assert.ok(result.passed < 72);
}));

const explicitDecision = (changes: Record<string, any> = {}, status = 'query') => {
  const { from = 'inherit', through = 'inherit', categoryNames = [], ...filter } = changes.filter ?? {};
  return { status, metric: changes.metric ?? 'inherit', grouping: changes.grouping ?? 'inherit', comparison: changes.comparison ?? 'inherit', from, through, categoryNames, filter };
};
test('mandatory decisions distinguish inheritance from an explicit reset and missing fields cannot silently become defaults', () => {
  const prior = { metric: 'income', grouping: 'category', comparison: 'previous_same' } as const;
  const inherited = parseExplicitPlan(explicitDecision(), october, syntheticCatalog, prior);
  assert.deepEqual(inherited.plan.query, { name: 'query_finances', ...prior, filter: october });
  assert.deepEqual(inherited.decisions, { metric: 'inherit', grouping: 'inherit', comparison: 'inherit', from: 'inherit', through: 'inherit', categoryCount: 0, filterFields: [] });
  const reset = parseExplicitPlan(explicitDecision({ grouping: 'none', comparison: 'none' }), october, syntheticCatalog, prior);
  assert.equal(reset.plan.query?.grouping, 'none'); assert.equal(reset.plan.query?.comparison, 'none'); assert.equal(reset.plan.query?.metric, 'income');
  for (const field of explicitPlanSchema.required) {
    const incomplete: Record<string, unknown> = explicitDecision(); delete incomplete[field];
    assert.throws(() => parseExplicitPlan(incomplete, october, syntheticCatalog), error => error instanceof Error && 'phase' in error && error.phase === 'ROOT');
  }
  for (const bad of [{ grouping: null }, { grouping: 'subtotal' }, { metric: false }, { comparison: 'previous_year' }, { from: '' }, { categoryNames: null }, { filter: { categoryIds: ['forged'] } }, { query: null }]) {
    assert.throws(() => parseExplicitPlan({ ...explicitDecision(), ...bad }, october, syntheticCatalog));
  }
  assert.throws(() => parseExplicitPlan({ ...explicitDecision(), from: '2026-02-30', through: '2026-03-01' }, october, syntheticCatalog), error => error instanceof Error && 'phase' in error && error.phase === 'FILTER');
  assert.throws(() => parseExplicitPlan(explicitDecision({ grouping: 'category' }, 'unsupported'), october, syntheticCatalog));
  assert.deepEqual(parseExplicitPlan(explicitDecision({}, 'unsupported'), october, syntheticCatalog).plan, { status: 'unsupported', query: null });
});
test('explicit fields cover the observed date/category/grouping/comparison errors without widening or leaking reference labels', () => {
  const grouped = parseExplicitPlan(explicitDecision({ metric: 'expenses', grouping: 'category' }), october, syntheticCatalog);
  assert.equal(grouped.plan.query?.grouping, 'category'); assert.equal(grouped.decisions.grouping, 'category');
  const compare = parseExplicitPlan(explicitDecision({ metric: 'expenses', comparison: 'previous_same' }), october, syntheticCatalog);
  assert.equal(compare.plan.query?.comparison, 'previous_same');
  const scoped = parseExplicitPlan(explicitDecision({ metric: 'expenses', filter: { from: '2026-09-01', through: '2026-09-30', categoryNames: ['Продукты'] } }), october, syntheticCatalog);
  assert.deepEqual(scoped.plan.query?.filter, { from: '2026-09-01', through: '2026-09-30', categoryIds: ['11111111-1111-4111-8111-111111111111'] });
  const taxi = parseExplicitPlan(explicitDecision({ filter: { categoryNames: ['Такси'] } }), scoped.plan.query!.filter, syntheticCatalog, { metric: 'expenses', grouping: 'category', comparison: 'none' });
  assert.equal(taxi.plan.query?.grouping, 'category'); assert.equal(taxi.decisions.grouping, 'inherit');
  assert.deepEqual(taxi.plan.query?.filter, { from: '2026-09-01', through: '2026-09-30', categoryIds: ['22222222-2222-4222-8222-222222222222'], subcategoryIds: ['33333333-3333-4333-8333-333333333333'] });
  const invalidName = parseExplicitPlan({ ...explicitDecision(), categoryNames: [key] }, october, syntheticCatalog);
  assert.equal(invalidName.resolution, 'reference_missing'); assert.doesNotMatch(JSON.stringify(invalidName), new RegExp(key));
  assert.equal(invalidName.decisions.categoryCount, 1); assert.equal(parseExplicitPlan(explicitDecision({ metric: 'attention' }), october, syntheticCatalog).plan.query?.grouping, 'operation');
  assert.ok(explicitPlanPrompt.endsWith(JSON.stringify(explicitPlanSchema)));
  for (const turn of transferScenarios.flatMap(s => s.turns)) assert.equal(explicitPlanPrompt.includes(turn.question), false);
});
function explicitFixtureClient(onRequest: (body: any) => void = () => {}, badGrouping = false) {
  return createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options!.body)), input = JSON.parse(body.messages[1].content); onRequest(body);
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question)!;
    if (body.messages[0].content === revisedGatePrompt) return response(turn.expectedGate);
    assert.equal(body.messages[0].content, explicitPlanPrompt); assert.deepEqual(body.response_format.json_schema.schema, explicitPlanSchema);
    return response(explicitDecision(badGrouping && turn.id === 'groups' ? { metric: 'expenses', grouping: 'none' } : scriptedDeltas[turn.id] as Record<string, unknown> ?? {}, turn.id === 'write' ? 'unsupported' : 'query'));
  }) as typeof fetch, 'empty-tools');
}
test('mandatory-decision trial propagates actual state, preserves the original goldens and replays decisions without payment', async () => sandbox(async (dir, ledger) => {
  const client = explicitFixtureClient(body => assert.doesNotMatch(JSON.stringify(body), /11111111|22222222|33333333|categoryIds|subcategoryIds|expectedPlan/));
  const result = await runSmoke(client, ledger, 'task', 'after-funding', true, 'explicit');
  assert.equal(result.passed, 24); assert.equal(result.benchmarkPromptVersion, 'cashneuro-smoke-prompt/5');
  assert.equal(result.checks.find(c => c.id === 'scope-3')?.diagnostics?.decisions?.grouping, 'inherit');
  const source = await readFile(join(dir, 'ledger.jsonl')), total = ledger.totals();
  const readonly = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const replay = await runSmoke(replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), readonly, 'task', 'after-funding', true, 'explicit');
    assert.deepEqual(replay.checks.map(c => c.diagnostics), result.checks.map(c => c.diagnostics));
    assert.equal(replay.checks.reduce((n, c) => n + c.replayCalls, 0), 46); assert.deepEqual(readonly.totals(), total);
  } finally { await readonly.close(); }
  assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
}));
test('wrong explicit choices remain scored failures, propagate to follow-ups and are visible in the report', async () => sandbox(async (_, ledger) => {
  const result = await runSmoke(explicitFixtureClient(() => {}, true), ledger, 'task', 'after-funding', true, 'explicit');
  assert.equal(result.passed, 20);
  assert.deepEqual(result.checks.filter(c => c.plan === false).map(c => c.id), ['groups', 'global-1', 'global-2', 'global-3']);
  const failure = result.checks.find(c => c.id === 'groups')!;
  assert.equal(failure.gate, true); assert.equal(failure.plan, false); assert.equal(failure.diagnostics?.decisions?.grouping, 'none');
  assert.equal(failure.diagnostics?.actualPlan?.query?.grouping, 'none');
}));
test('missing mandatory decisions stop on the first planner response and repeats cannot dispatch again', async () => sandbox(async (_, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options!.body));
    return response(body.messages[0].content === revisedGatePrompt ? { relevance: 'financial', followUp: false } : { status: 'query' });
  }) as typeof fetch, 'empty-tools');
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'explicit'), /BENCH_CAPABILITY_FAILURE/);
  assert.equal(calls, 2); assert.equal(ledger.records.size, 2); assert.equal(ledger.totals().held, 0n); assert.ok(ledger.totals().spent > 0n);
  assert.equal([...ledger.records.values()].at(-1)?.receipt?.code, 'BENCH_PLAN_INVALID_ROOT');
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'explicit'), /BENCH_CAPABILITY_FAILURE/); assert.equal(calls, 2);
}));
test('transfer admission is tied to the exact prompt version; prompt/4 cannot authorize prompt/5', async () => sandbox(async (_, ledger) => {
  await runSmoke(deltaFixtureClient(), ledger, 'task', 'after-funding', false, 'delta');
  let calls = 0; const client = explicitFixtureClient(() => { calls++; }, true);
  await assert.rejects(runTransfer(client, ledger, 'explicit'), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0);
  const trial = await runSmoke(client, ledger, 'task', 'after-funding', false, 'explicit'); assert.equal(trial.passed, 20);
  const before = calls; await assert.rejects(runTransfer(client, ledger, 'explicit'), /BENCH_TRANSFER_BASELINE_REQUIRED/); assert.equal(calls, before);
}));
test('paid explicit trial requires the saved previous trial, appends distinct receipts and retains every old reservation', async () => sandbox(async (dir, ledger) => {
  await seedGigaRejection(ledger); await ledger.allowOssContinuation(); const held = ledger.totals().held;
  let calls = 0; const client = explicitFixtureClient(() => { calls++; });
  const path = join(dir, 'ledger.jsonl'), beforeMissing = await readFile(path);
  await assert.rejects(runExplicitTrial(client, ledger), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0); assert.deepEqual(await readFile(path), beforeMissing);
  const imperfectBaseline = await runSmoke(deltaFixtureClient(() => {}, true), ledger, 'task', 'after-funding', false, 'delta');
  assert.equal(imperfectBaseline.passed, 23); const before = await readFile(path, 'utf8'), oldCount = ledger.records.size;
  const result = await runExplicitTrial(client, ledger); assert.equal(result.passed, 24); assert.equal(calls, 46);
  assert.equal(ledger.records.size, oldCount + 46); assert.equal(ledger.totals().held, held); assert.equal(smokeCostReport(ledger).requiresReconciliation, true);
  assert.ok((await readFile(path, 'utf8')).startsWith(before));
  const source = await readFile(path); await runExplicitTrial(client, ledger); assert.equal(calls, 46); assert.deepEqual(await readFile(path), source);
}));

const literalDecision = (changes: Record<string, any> = {}, fromText = 'inherit', throughText = 'inherit', status = 'query') =>
  ({ ...explicitDecision(changes, status), amountFromText: fromText, amountThroughText: throughText });
test('currency literals use exact BigInt conversion for decimal/grouped rubles, compound kopecks, signs and scaled units', () => {
  const cases: [string, string][] = [['1000', '100000'], ['2500 рублей', '250000'], ['99 рублей 50 копеек', '9950'],
    ['99,50 руб', '9950'], ['1 234.5 ₽', '123450'], ['50 копеек', '50'], ['-7 рублей 8 копеек', '-708'], ['-0,08 руб', '-8'],
    ['+0 рублей', '0'], ['1,5 тыс рублей', '150000'], ['2 млн руб', '200000000'], ['999999999999 тыс руб', '99999999999900000']];
  for (const [input, expected] of cases) assert.equal(parseMoneyLiteral(input), expected, input);
  for (const bad of ['1.999 рублей', '1e3', 'NaN', 'Infinity', '12 34 руб', '100 долларов', '0,5 копейки', '1,50 руб 50 коп', '1000000000000 млн руб', '50 процентов']) assert.throws(() => parseMoneyLiteral(bad), bad);
});
test('monetary grounding rejects invented thresholds, partial quantities and substring matches instead of guessing', () => {
  const question = 'Доходы по суммам от 1000 до 2500 рублей включительно.';
  assert.equal(parseQuotedMoney('1000', question), '100000'); assert.equal(parseQuotedMoney('2500 рублей', question), '250000');
  assert.throws(() => parseQuotedMoney('100000', question)); assert.throws(() => parseQuotedMoney('100', question));
  assert.equal(parseQuotedMoney('99 рублей 50 копеек', 'Общий доход не выше 99 рублей 50 копеек.'), '9950');
  assert.throws(() => parseQuotedMoney('99', 'Общий доход не выше 99 рублей 50 копеек.'));
  assert.throws(() => parseQuotedMoney('50', 'Доход с суммой до 50 копеек.'));
  assert.throws(() => parseQuotedMoney('50', 'Рост доходов на 50%.'));
  assert.throws(() => parseQuotedMoney('2026', 'Доходы за 2026-10-01.'));
});
test('literal planner fixes the observed unit issue without teaching the answer or retaining raw quoted text', () => {
  const question = 'Общий доход по операциям с суммой от 1000 до 2500 рублей включительно.';
  const result = parseLiteralPlan(literalDecision({ metric: 'income', grouping: 'none' }, '1000', '2500 рублей'), question, october, syntheticCatalog);
  assert.deepEqual(result.plan.query?.filter, { ...october, amountFrom: '100000', amountThrough: '250000' });
  assert.deepEqual(result.money, { fromMinor: '100000', throughMinor: '250000' });
  assert.equal(JSON.stringify(result).includes('2500 рублей'), false);
  const ungrounded = parseLiteralPlan(literalDecision({ metric: 'income' }, '100000'), question, october, syntheticCatalog);
  assert.equal(ungrounded.plan.status, 'clarification'); assert.equal(ungrounded.resolution, 'money_literal_invalid');
  assert.throws(() => parseLiteralPlan(literalDecision({ filter: { amountFrom: '1000' } }), question, october, syntheticCatalog));
  assert.throws(() => parseLiteralPlan(literalDecision({}, '2500', '1000'), question, october, syntheticCatalog));
  assert.throws(() => parseLiteralPlan(literalDecision({}, '1000', 'inherit', 'unsupported'), question, october, syntheticCatalog));
  const missing = literalDecision() as Record<string, unknown>; delete missing.amountThroughText;
  assert.throws(() => parseLiteralPlan(missing, question, october, syntheticCatalog));
  assert.equal(literalPlanPrompt.includes('Суммы условий — целые строки копеек.'), false);
});
test('only a redundant model attention addition is canonicalized; manual and contradictory filters remain explicit', () => {
  const value = literalDecision({ metric: 'attention', grouping: 'operation', filter: { attention: true } });
  const result = parseLiteralPlan(value, 'Операции на проверку.', october, syntheticCatalog);
  assert.deepEqual(result.plan.query?.filter, october); assert.deepEqual(result.normalizations, ['redundant_attention_filter']);
  assert.deepEqual(result.decisions.filterFields, ['attention']);
  assert.equal(parseLiteralPlan(value, 'Операции на проверку.', { ...october, attention: false }, syntheticCatalog).plan.query?.filter.attention, true);
  assert.equal(parseLiteralPlan(value, 'Операции на проверку.', { ...october, attention: true }, syntheticCatalog).plan.query?.filter.attention, true);
  assert.equal(parseLiteralPlan(literalDecision({ metric: 'expenses', filter: { attention: true } }), 'Расходы на проверку.', october, syntheticCatalog).plan.query?.filter.attention, true);
  const row = (id: string, reviewReasons: string[]): OperationRow => ({ id, accountId: '11111111-1111-4111-8111-111111111111', date: { precision: 'day', date: '2026-10-12' },
    amountMinor: '-10000', analyticsRole: 'expense', decompositionActive: false, reviewReasons, unresolvedMinor: '0', neutralMinor: '0', excludedMinor: '0',
    parts: [{ id: 'part-' + id, componentId: null, allocationId: null, amountMinor: '-10000', role: 'expense', categoryId: null, subcategoryId: null, basis: [], included: true }],
    classification: { kind: facet('purchase'), role: facet('expense'), category: facet<string | null>(null), subcategory: facet<string | null>(null), counterparty: facet<string | null>(null), merchant: facet('Синтетическая покупка') }, comment: '' });
  const rows = [row('review', ['possible_duplicate']), row('clean', [])], catalog = { accounts: [], categories: [], counterparties: [] };
  const simple = queryOperations(rows, catalog, { filter: { ...october, metric: 'attention' }, sort: 'date', direction: 'asc', group: 'none' });
  const redundant = queryOperations(rows, catalog, { filter: { ...october, metric: 'attention', attention: true }, sort: 'date', direction: 'asc', group: 'none' });
  assert.deepEqual(simple, redundant); assert.deepEqual(simple.operations.map(o => o.id), ['review']);
});
test('literal trial verifies all four observed transfer cases while preserving original fixtures and actual diagnostics', async () => sandbox(async (_, ledger) => {
  const selected = transferScenarios.flatMap(s => s.turns).filter(t => ['transfer-05', 'transfer-24', 'transfer-25', 'transfer-35'].includes(t.id));
  const responses: Record<string, unknown> = {
    'transfer-05': literalDecision({ metric: 'attention', grouping: 'operation', filter: { attention: true } }),
    'transfer-24': literalDecision({ metric: 'income', grouping: 'none' }, '1000', '2500 рублей'),
    'transfer-25': literalDecision({ metric: 'income', grouping: 'none' }, 'inherit', '99 рублей 50 копеек'),
  };
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    const body = JSON.parse(String(options!.body)), input = JSON.parse(body.messages[1].content), turn = selected.find(t => t.question === input.question);
    if (body.messages[0].content === literalGatePrompt) return response(turn?.expectedGate ?? { relevance: 'unrelated', followUp: false });
    assert.equal(body.messages[0].content, literalPlanPrompt); assert.deepEqual(body.response_format.json_schema.schema, literalPlanSchema);
    return response(responses[turn!.id]);
  }) as typeof fetch, 'empty-tools');
  const result = await runSmoke(client, ledger, 'task', 'after-funding', true, 'literal', 'transfer');
  assert.equal(result.benchmarkPromptVersion, 'cashneuro-smoke-prompt/6'); assert.equal(result.fixtureVersion, 'cashneuro-transfer/1');
  for (const turn of selected) { const check = result.checks.find(c => c.id === turn.id)!; assert.equal(check.gate, true, turn.id); assert.notEqual(check.plan, false, turn.id); }
  assert.deepEqual(result.checks.find(c => c.id === 'transfer-24')?.diagnostics?.money, { fromMinor: '100000', throughMinor: '250000' });
  assert.deepEqual(result.checks.find(c => c.id === 'transfer-05')?.diagnostics?.normalizations, ['redundant_attention_filter']);
}));
test('regression requires both saved batches before dispatch and does not spend on transfer when the simple batch fails', async () => sandbox(async (dir, ledger) => {
  await seedGigaRejection(ledger); await ledger.allowOssContinuation();
  const held = ledger.totals().held; let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'unrelated', followUp: false }); }) as typeof fetch, 'empty-tools');
  await assert.rejects(runLiteralRegression(client, ledger), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0);
  await runSmoke(explicitFixtureClient(), ledger, 'task', 'after-funding', false, 'explicit');
  await assert.rejects(runLiteralRegression(client, ledger), /BENCH_REPLAY_ONLY/); assert.equal(calls, 0);
  await runSmoke(client, ledger, 'task', 'after-funding', false, 'explicit', 'transfer'); calls = 0;
  const result = await runLiteralRegression(client, ledger); assert.equal(result.regression, 'smoke-only/1'); assert.equal(result.turns, 24); assert.equal(calls, 24);
  assert.ok(result.passed < 24); assert.equal(ledger.totals().held, held);
  const source = await readFile(join(dir, 'ledger.jsonl'));
  const replay = await runLiteralRegression(replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), ledger);
  assert.equal(replay.passed, result.passed); assert.equal(calls, 24); assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
}));
test('completed regression reports both subsets and their combined cost and repeats without a new dispatch', async () => sandbox(async (dir, ledger) => {
  await seedGigaRejection(ledger); await ledger.allowOssContinuation();
  await runSmoke(explicitFixtureClient(), ledger, 'task', 'after-funding', false, 'explicit');
  const unrelated = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => response({ relevance: 'unrelated', followUp: false })) as typeof fetch, 'empty-tools');
  await runSmoke(unrelated, ledger, 'task', 'after-funding', false, 'explicit', 'transfer');
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options!.body)), input = JSON.parse(body.messages[1].content);
    const turn = smokeScenarios.flatMap(s => s.turns).find(t => t.question === input.question);
    if (body.messages[0].content === literalGatePrompt) return response(turn?.expectedGate ?? { relevance: 'unrelated', followUp: false });
    return response(literalDecision(scriptedDeltas[turn!.id] as Record<string, unknown> ?? {}, 'inherit', 'inherit', turn!.id === 'write' ? 'unsupported' : 'query'));
  }) as typeof fetch, 'empty-tools');
  const result = await runLiteralRegression(client, ledger);
  assert.equal(result.regression, 'seen-corpora/1'); assert.equal(result.turns, 96); assert.equal(result.passed, 26); assert.equal(calls, 118);
  assert.equal(result.costPerTurnAtoms.meanCeil, '2699250');
  assert.ok('subsets' in result); assert.deepEqual(result.subsets.map(s => s.turns), [24, 72]);
  const source = await readFile(join(dir, 'ledger.jsonl'));
  const replay = await runLiteralRegression(replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), ledger);
  assert.equal(replay.passed, result.passed); assert.equal(calls, 118); assert.deepEqual(await readFile(join(dir, 'ledger.jsonl')), source);
}));
