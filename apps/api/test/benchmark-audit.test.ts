import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BenchmarkLedger } from '../src/benchmark-ledger.ts';
import { createBenchmarkTransport, candidates } from '../src/benchmark-transport.ts';
import { runSmoke } from '../src/benchmark-engine.ts';
import { auditSavedBenchmark, analyzeSavedChecks, assertBenchmarkActionAllowed } from '../src/benchmark-audit.ts';
import { contextGatePrompt, contextDecisionTemplate } from '../src/benchmark-context-prompts.ts';
import { parseLiteralPlan } from '../src/benchmark-literal-plan.ts';
import { october, syntheticCatalog } from '../src/benchmark-fixtures.ts';

const key = 'synthetic-audit-reflection-not-a-secret';
const response = (value: unknown) => new Response(JSON.stringify({ model: candidates['cloud-oss'].model,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, system_fingerprint: 'fixture-audit' }));
async function sandbox(action: (path: string, ledger: BenchmarkLedger) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-audit-')), path = join(dir, 'ledger.jsonl');
  const ledger = await BenchmarkLedger.load(path);
  try { await action(path, ledger); } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('audit exports successful and failed parsed responses with exact ledger coverage and no dispatch or writes even while blocked', async () => sandbox(async (path, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options!.body));
    return response(body.messages[0].content === contextGatePrompt ? { relevance: 'financial', followUp: false } :
      { ...contextDecisionTemplate, filter: { merchant: key } });
  }) as typeof fetch, 'empty-tools');
  const original = await runSmoke(client, ledger, 'task', 'after-funding', true, 'context');
  assert.equal(calls, 48);
  await ledger.reserve('f'.repeat(64), client.price, client.bound);
  const before = await readFile(path), totals = ledger.totals(); assert.equal(totals.blocked, true);
  const readonly = await BenchmarkLedger.load(path, { readOnly: true });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('AUDIT_MUST_NOT_USE_NETWORK'); }) as typeof fetch;
  try {
    const result = await auditSavedBenchmark(readonly);
    const batch = result.batches.find(b => b.revision === 'context' && b.corpus === 'smoke')!;
    assert.equal(result.paidCalls, 0); assert.equal(batch.status, 'complete'); assert.equal(batch.turns.length, 24);
    assert.equal(batch.metrics.strictPassed, original.passed);
    assert.equal(result.coverage.matchedRecords, 48); assert.equal(result.coverage.ledgerRecords, 49);
    assert.equal(result.coverage.unmatchedRecords[0]!.heldAtoms, '2152001920');
    assert.equal(result.coverage.unmatchedRecords[0]!.code, 'BENCH_RECEIPT_MISSING');
    assert.equal(JSON.stringify(result).includes(key), false); assert.equal(JSON.stringify(result).includes('[TEXT_REDACTED]'), true);
    assert.ok(batch.requests.every(r => r.fingerprintHash?.length === 64));
    assert.equal(JSON.stringify(result).includes('fixture-audit'), false);
    assert.equal(result.batches.find(b => b.revision === 'literal' && b.corpus === 'transfer')?.status, 'not_started');
    assert.deepEqual(readonly.totals(), totals);
  } finally { globalThis.fetch = savedFetch; await readonly.close(); }
  assert.deepEqual(await readFile(path), before); assert.equal(calls, 48); assert.deepEqual(ledger.totals(), totals);
}));

test('partial audit retains complete prefix and the unknown final reservation without inventing a batch score', async () => sandbox(async (path, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; if (calls === 3) throw new Error('lost');
    const body = JSON.parse(String(options!.body));
    return response(body.messages[0].content === contextGatePrompt ? { relevance: 'financial', followUp: false } : contextDecisionTemplate);
  }) as typeof fetch, 'empty-tools');
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'context'), /BENCH_RECONCILIATION_REQUIRED/);
  const before = await readFile(path), readonly = await BenchmarkLedger.load(path, { readOnly: true });
  try {
    const result = await auditSavedBenchmark(readonly), batch = result.batches.find(b => b.revision === 'context' && b.corpus === 'smoke')!;
    assert.equal(batch.status, 'incomplete'); assert.equal(batch.turns.length, 1); assert.equal(batch.requests.length, 3);
    assert.equal(batch.costPerTurnAtoms, null); assert.equal(batch.stoppedBy, 'BENCH_RECONCILIATION_REQUIRED');
    assert.equal(batch.requests.at(-1)!.usage, null); assert.equal(batch.requests.at(-1)!.code, 'BENCH_DELIVERY_UNKNOWN');
    assert.equal(result.coverage.matchedRecords, 3); assert.equal(result.cost.requiresReconciliation, true);
  } finally { await readonly.close(); }
  assert.deepEqual(await readFile(path), before); assert.equal(calls, 3);
}));

test('audit hooks cannot attach to a dispatch-capable run or release a reserve', async () => sandbox(async (_, ledger) => {
  let calls = 0;
  const client = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response(null); }) as typeof fetch, 'empty-tools');
  await assert.rejects(runSmoke(client, ledger, 'task', 'after-funding', true, 'context', 'smoke', { receipt() {}, turn() {} }), /BENCH_AUDIT_REPLAY_REQUIRED/);
  assert.equal(calls, 0); assert.equal(ledger.records.size, 0);
  const output = await auditSavedBenchmark(ledger); assert.equal(output.coverage.ledgerRecords, 0);
  assert.ok(output.batches.every(b => b.status === 'not_started' && b.metrics.evaluatedTurns === 0));
}));

test('audit distinguishes relevance, task binding and plan differences without changing strict historical scores', () => {
  const gate = { relevance: 'financial' as const, followUp: false };
  const expected = { status: 'query' as const, query: { name: 'query_finances' as const, metric: 'expenses' as const, grouping: 'category' as const, comparison: 'none' as const, filter: october } };
  const actual = { ...expected, query: { ...expected.query, grouping: 'none' as const, filter: { ...october, attention: true } } };
  const check = { id: 'first', gate: false, plan: false, calls: 2, inputTokens: 200, outputTokens: 20, costAtoms: '1', latencyMs: 1, replayCalls: 2,
    diagnostics: { question: 'Синтетическая задача', expectedGate: gate, actualGate: { ...gate, followUp: true }, expectedPlan: expected, actualPlan: actual, errors: [] } };
  const result = analyzeSavedChecks([{ check, scenarioId: 'one' }, { check: { ...check, id: 'next' }, scenarioId: 'one' }, { check, scenarioId: 'other' }]);
  assert.equal(result.metrics.strictPassed, 0); assert.equal(result.metrics.relevanceCorrect, 3); assert.equal(result.metrics.followUpCorrect, 0);
  assert.deepEqual(result.turns[0]!.analysis.planDifferences, ['grouping', 'filter.attention']);
  assert.equal(result.turns[0]!.analysis.earlierFailureInScenario, false);
  assert.equal(result.turns[1]!.analysis.earlierFailureInScenario, true);
  assert.equal(result.turns[2]!.analysis.earlierFailureInScenario, false);
});

test('all historical paid operator actions are paused before keys, state or locks; free actions remain available', async () => {
  for (const action of ['--live', '--probe', '--probe-after-funding', '--live-after-funding', '--live-revised', '--live-resolved', '--compare', '--probe-format', '--compare-fixed', '--live-delta', '--live-transfer', '--live-explicit', '--live-transfer-explicit', '--live-regression', '--live-context'])
    assert.throws(() => assertBenchmarkActionAllowed(action), /BENCH_PAID_TRIALS_PAUSED_FOR_AUDIT/, action);
  for (const action of ['--dry-run', '--inspect', '--audit-saved', '--report', '--report-context', '--report-regression']) assert.doesNotThrow(() => assertBenchmarkActionAllowed(action));
  assert.throws(() => assertBenchmarkActionAllowed('--report-live'), /BENCH_PAID_TRIALS_PAUSED_FOR_AUDIT/);
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/benchmark-main.ts', '--live-context', 'cloud-oss', 'task']),
    (error: any) => error.code === 1 && error.stderr.includes('BENCH_PAID_TRIALS_PAUSED_FOR_AUDIT') && !error.stderr.includes('PRIVATE_FILE'));
});

test('explicit parent category resolution removes an inherited same-parent leaf without changing dates, accounts or money', () => {
  const parent = syntheticCatalog.categories.find(c => c.name === 'Поездки')!.id;
  const leaf = syntheticCatalog.categories.find(c => c.name === 'Такси')!.id;
  const base = { ...october, categoryIds: [parent], subcategoryIds: [leaf], amountFrom: '12000', operationIds: [leaf] };
  const result = parseLiteralPlan({ ...contextDecisionTemplate, categoryNames: ['Поездки'] }, 'Вместо подкатегории вся родительская категория.', base, syntheticCatalog,
    { metric: 'expenses', grouping: 'category', comparison: 'previous_same' });
  assert.deepEqual(result.plan.query?.filter, { ...october, categoryIds: [parent], amountFrom: '12000', operationIds: [leaf] });
  assert.equal(result.plan.query?.grouping, 'category'); assert.equal(result.plan.query?.comparison, 'previous_same');
  assert.deepEqual(base.subcategoryIds, [leaf]);
});
