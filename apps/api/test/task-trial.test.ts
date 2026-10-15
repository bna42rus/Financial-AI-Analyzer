import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTrialCorpus, validateTrialCorpus, evaluateTrialScenario, taskTrialManifest, trialRequestId, trialWire, inspectCloudTaskModel, assertTrialBaseline } from '../src/task-trial.ts';
import { BenchmarkLedger } from '../src/benchmark-ledger.ts';
import { candidates } from '../src/benchmark-transport.ts';
import { smokeScenarios } from '../src/benchmark-fixtures.ts';
import { transferScenarios } from '../src/benchmark-transfer-fixtures.ts';

const credentials = { apiKey: 'synthetic-trial-only-no-real-secret' };
const keep = { op: 'keep' }, nearest = { kind: 'nearest', metric: null, comparison: null };
const proposal = (patch: Record<string, unknown> = {}) => ({ status: 'query', binding: nearest, metric: keep, grouping: keep, comparison: keep, edits: [], ...patch });
const answers = [
  proposal({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потратил' }, edits: [
    { field: 'period', op: 'set', value: 'сентябре 2026 года', quote: 'сентябре 2026 года' },
    { field: 'categories', op: 'set', value: { names: ['продукты'] }, quote: 'продукты' },
  ] }),
  proposal({ grouping: { op: 'set', value: 'category', quote: 'по категориям' } }),
  proposal({ edits: [{ field: 'categories', op: 'set', value: { names: ['такси'] }, quote: 'такси' }] }),
  proposal({ edits: [{ field: 'period', op: 'set', value: 'октябрь 2026 года', quote: 'октябрь 2026 года' }] }),
];

test('frozen corpus contains 96 independent goldens, 68/28 split and 24 repeat slots; every query agrees with manually written exact totals', async () => {
  const { corpus, hash } = await loadTrialCorpus();
  assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(corpus.singles.length, 48); assert.equal(corpus.dialogs.length, 8);
  const all = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)]; assert.equal(all.length, 96);
  assert.equal(all.filter(t => t.split === 'development').length, 68); assert.equal(all.filter(t => t.split === 'holdout').length, 28);
  assert.equal(corpus.repetitions.reduce((sum, r) => sum + r.additionalIndependentCopies, 0), 24);
  assert.equal(all.find(t => t.id === 'single-16')!.expected.totalMinor, '100000');
  assert.equal(all.find(t => t.id === 'single-17')!.expected.query!.filter.amountThrough, '9950');
  assert.equal(all.find(t => t.id === 'single-30')!.expected.relevance, 'adjacent');
});

test('corpus rejects wrong money units, foreign IDs, duplicate IDs, future parents, holdout repeats and unknown contract fields', async () => {
  const { corpus } = await loadTrialCorpus();
  for (const mutate of [
    (x: typeof corpus) => { x.singles[15]!.expected.totalMinor = '1000'; },
    (x: typeof corpus) => { x.singles[3]!.expected.query!.filter.categoryIds = ['90000000-0000-4000-8000-000000000001']; },
    (x: typeof corpus) => { x.singles[1]!.id = x.singles[0]!.id; },
    (x: typeof corpus) => { x.dialogs[0]!.turns[0]!.expected.parentTurnId = 'scope-6'; },
    (x: typeof corpus) => { x.repetitions[0]!.caseId = 'single-48'; },
    (x: typeof corpus) => { (x.singles[0]!.expected as unknown as Record<string, unknown>).sql = 'SELECT 1'; },
    (x: typeof corpus) => { x.singles[0]!.expected.relevance = 'unrelated'; },
  ]) { const changed = structuredClone(corpus); mutate(changed); assert.throws(() => validateTrialCorpus(changed)); }
});

test('holdout questions do not exactly repeat any of the 96 historical smoke/transfer turns and never supply repeated development slots', async () => {
  const { corpus } = await loadTrialCorpus();
  const folded = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[?!.,]+$/gu, '').replace(/\s+/gu, ' ').trim();
  const seen = new Set([...smokeScenarios, ...transferScenarios].flatMap(s => s.turns.map(t => folded(t.question))));
  const holdout = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].filter(t => t.split === 'holdout');
  assert.equal(holdout.length, 28); for (const turn of holdout) assert.equal(seen.has(folded(turn.question)), false, turn.id);
  for (const repeat of corpus.repetitions) assert.equal(holdout.some(t => t.id === repeat.caseId), false);
});

test('evaluator runs the actual task workflow, server name resolution and shared finance core, without sending goldens or catalog to the model', async () => {
  const { corpus } = await loadTrialCorpus(); const sent: unknown[] = [];
  const result = await evaluateTrialScenario(corpus.dialogs[0]!.turns.slice(0, 3), turn => {
    const index = Number(turn.id.split('-').at(-1)) - 1;
    return { async relevance(input) { sent.push(input); return { relevance: 'financial' }; }, async proposal(input) { sent.push(input); return answers[index]; } };
  });
  assert.equal(result.length, 3); assert.ok(result.every(t => t.passed));
  assert.equal(result[2]!.actualTotalMinor, '35000'); assert.equal(result[2]!.bindingCorrect, true);
  const wire = JSON.stringify(sent);
  for (const forbidden of ['expected', 'totalMinor', '50000000-', '160000', '35000', 'Синтетический счёт']) assert.equal(wire.includes(forbidden), false, forbidden);
});

test('one wrong grouping is reported separately from correct total and binding, then retained as cascade risk on the next turn', async () => {
  const { corpus } = await loadTrialCorpus(); const wrong = structuredClone(answers);
  wrong[2] = proposal({ grouping: { op: 'set', value: 'none', quote: 'такси' }, edits: [{ field: 'categories', op: 'set', value: { names: ['такси'] }, quote: 'такси' }] });
  const result = await evaluateTrialScenario(corpus.dialogs[0]!.turns.slice(0, 4), turn => ({ async relevance() { return { relevance: 'financial' }; }, async proposal() { return wrong[Number(turn.id.split('-').at(-1)) - 1]; } }));
  assert.equal(result[2]!.passed, false); assert.equal(result[2]!.planFields.grouping, false); assert.equal(result[2]!.totalCorrect, true); assert.equal(result[2]!.bindingCorrect, true);
  assert.equal(result[3]!.earlierFailure, true); assert.equal(result[3]!.passed, false); assert.equal(result[3]!.actualQuery!.grouping, 'none');
});

test('wrong relevance is not corrected by a golden task; following clarification remains a measured failure', async () => {
  const { corpus } = await loadTrialCorpus(); let proposals = 0;
  const result = await evaluateTrialScenario(corpus.dialogs[0]!.turns.slice(0, 2), turn => ({
    async relevance() { return { relevance: turn.id === 'scope-1' ? 'unrelated' : 'financial' }; },
    async proposal() { proposals++; return answers[1]; },
  }));
  assert.equal(proposals, 1); assert.equal(result[0]!.relevanceCorrect, false); assert.equal(result[0]!.privacyCorrect, true);
  assert.equal(result[1]!.actualStatus, 'clarification'); assert.equal(result[1]!.earlierFailure, true); assert.equal(result[1]!.passed, false);
});

test('unrelated and ambiguous evaluation never invokes a proposal or financial calculation', async () => {
  const { corpus } = await loadTrialCorpus();
  for (const id of ['single-23', 'single-24', 'single-27', 'single-28']) {
    const turn = corpus.singles.find(t => t.id === id)!; let proposals = 0;
    const rows = await evaluateTrialScenario([turn], () => ({ async relevance() { return { relevance: turn.expected.relevance }; }, async proposal() { proposals++; throw new Error('DENIED'); } }));
    assert.equal(rows[0]!.passed, true); assert.equal(rows[0]!.privacyCorrect, true); assert.equal(proposals, 0);
  }
});

test('a wrong financial gate followed by a calculation on a known unrelated question is a privacy failure, even when the total itself is arithmetically correct', async () => {
  const { corpus } = await loadTrialCorpus(); const turn = corpus.singles.find(t => t.id === 'single-23')!;
  const rows = await evaluateTrialScenario([turn], () => ({ async relevance() { return { relevance: 'financial' }; }, async proposal() {
    return proposal({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'погода' } });
  } }));
  assert.equal(rows[0]!.actualStatus, 'query'); assert.equal(rows[0]!.actualTotalMinor, '17000');
  assert.equal(rows[0]!.relevanceCorrect, false); assert.equal(rows[0]!.privacyCorrect, false); assert.equal(rows[0]!.passed, false);
});

test('catalog preflight makes exactly one fixed GET with timeout and no redirects, sends no question and never reflects a key', async () => {
  let count = 0;
  const result = await inspectCloudTaskModel(credentials, (async (url, options) => {
    count++; assert.equal(url, 'https://foundation-models.api.cloud.ru/v1/models'); assert.equal(options!.method, 'GET'); assert.equal(options!.body, undefined); assert.equal(options!.redirect, 'error'); assert.ok(options!.signal);
    assert.equal(new Headers(options!.headers).get('authorization'), 'Bearer ' + credentials.apiKey);
    return new Response(JSON.stringify({ data: [{ id: candidates['cloud-oss'].model, created: 1791979200, context_length: 131072, revision: credentials.apiKey, description: credentials.apiKey }] }));
  }) as typeof fetch);
  assert.equal(count, 1); assert.equal(result.paidCalls, 0); assert.equal(result.catalogHttpCalls, 1);
  assert.equal(result.immutableModelVersionVerified, false); assert.equal(result.priceVerified, false);
  assert.equal(result.numericMetadata.context_length, 131072); assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('catalog errors, missing/duplicate models, huge bodies and malformed credentials fail without retry or reflected provider errors', async () => {
  for (const response of [new Response(credentials.apiKey, { status: 403 }), new Response(JSON.stringify({ data: [] })),
    new Response(JSON.stringify({ data: [{ id: candidates['cloud-oss'].model }, { id: candidates['cloud-oss'].model }] })), new Response('x'.repeat(524289))]) {
    let count = 0;
    await assert.rejects(inspectCloudTaskModel(credentials, (async () => { count++; return response; }) as typeof fetch), error => {
      assert.equal(String(error).includes(credentials.apiKey), false); return /TASK_TRIAL_CATALOG_/.test(String(error));
    }); assert.equal(count, 1);
  }
  let count = 0; await assert.rejects(inspectCloudTaskModel({ apiKey: 'short' }, (async () => { count++; throw new Error(); }) as typeof fetch)); assert.equal(count, 0);
  await assert.rejects(inspectCloudTaskModel(credentials, (async () => { throw new Error(credentials.apiKey); }) as typeof fetch), /TASK_TRIAL_CATALOG_UNAVAILABLE/);
});

test('request IDs distinguish 240 phase/occurrence slots while repeated identical model bodies stay identical', async () => {
  const { corpus, hash } = await loadTrialCorpus(); const all = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)]; const ids = new Set<string>();
  for (const t of all) for (const phase of ['gate', 'plan'] as const) ids.add(trialRequestId(hash, t.id, phase, 0));
  for (const r of corpus.repetitions) for (const copy of [1, 2]) for (const phase of ['gate', 'plan'] as const) ids.add(trialRequestId(hash, r.caseId, phase, copy));
  assert.equal(ids.size, 240); assert.equal(trialRequestId(hash, 'single-01', 'gate', 1), trialRequestId(hash, 'single-01', 'gate', 1));
  assert.notEqual(trialRequestId(hash, 'single-01', 'gate', 1), trialRequestId(hash, 'single-01', 'gate', 2));
  assert.throws(() => trialRequestId(hash, 'single-01', 'gate', 3));
  const input = { question: corpus.singles[0]!.question, hasFinancialTasks: false };
  assert.equal(trialWire('gate', input), trialWire('gate', input));
});

test('a changed or empty ledger blocks preflight admission; it never receives a write or an inferred zero-cost receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-trial-')), ledger = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  try { const before = ledger.previous; assert.throws(() => assertTrialBaseline(ledger), /TASK_TRIAL_BASELINE_CHANGED/); assert.equal(ledger.previous, before); assert.equal(ledger.records.size, 0); }
  finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('manifest stays explicitly unpaid and unpinned, budgets retain old holds, and CLI has no paid flag or environment bypass', async () => {
  const manifest = await taskTrialManifest(); assert.equal(manifest.counts.maximumTurns, 120); assert.equal(manifest.counts.maximumNewModelCalls, 240);
  assert.equal(manifest.gates.paidRunnerImplemented, false); assert.equal(manifest.gates.paidDispatchEnabled, false); assert.equal(manifest.gates.immutableModelVersionVerified, false);
  assert.equal(manifest.budget.incrementalCapAtoms, '20000000000'); assert.ok(20888941260n + BigInt(manifest.budget.incrementalCapAtoms) < BigInt(manifest.budget.existingGlobalCapAtoms));
  assert.equal(manifest.budget.maximumReservationAtoms, '2152001920'); assert.equal(manifest.fullProductAcceptanceExecuted, false);
  const run = promisify(execFile), cwd = new URL('..', import.meta.url);
  for (const args of [['--live'], ['--preflight', '--live']]) await assert.rejects(run(process.execPath, ['--import', 'tsx', 'src/task-trial-main.ts', ...args], { cwd, env: { ...process.env, TASK_TRIAL_LIVE: 'true' } }), error => String((error as { stderr?: string }).stderr).includes('TASK_TRIAL_PAID_DISPATCH_DISABLED'));
  const dry = await run(process.execPath, ['--import', 'tsx', 'src/task-trial-main.ts', '--dry-run'], { cwd });
  const result = JSON.parse(dry.stdout); assert.equal(result.paidCalls, 0); assert.equal(result.catalogHttpCalls, 0); assert.equal(result.gates.paidDispatchEnabled, false);
});
