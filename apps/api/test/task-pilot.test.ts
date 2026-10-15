import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, chmod, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkLedger, benchmarkDigest } from '../src/benchmark-ledger.ts';
import { createBenchmarkTransport, replayOnlyBenchmarkTransport, candidates, BenchmarkFailure } from '../src/benchmark-transport.ts';
import { PilotJournal, ensurePilotCache } from '../src/task-pilot-journal.ts';
import { pilotBinding, pilotRequestIds, pilotModel, pilotStagePassed, assertPilotFreshness, runPilot } from '../src/task-pilot-runner.ts';
import { loadTrialCorpus, trialRequestId, evaluateTrialScenario } from '../src/task-trial.ts';
import type { TrialCorpus, TrialScore } from '../src/task-trial.ts';
import { auditTaskWireSchema, projectTaskWireSchema, classifyTaskProviderError } from '../src/task-provider-schema.ts';
import { inspectTaskPilot } from '../src/task-pilot-inspection.ts';
import { taskRelevanceSchema, taskProposalSchema, parseTaskProposalWire } from '../../../packages/analyzer/src/task-protocol.ts';

const key = 'synthetic-pilot-secret-for-fault-tests', manifestHash = 'a'.repeat(64), spec = candidates['cloud-oss'];
const bound = { inputTokens: spec.contextTokens, outputTokens: 1200, modelVersion: spec.model };
const keep = { op: 'keep' }, nearest = { kind: 'nearest', metric: null, comparison: null };
const p = (patch: Record<string, unknown> = {}) => ({ status: 'query', binding: nearest, metric: keep, grouping: keep, comparison: keep, edits: [], ...patch });
const validExpense = p({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потрачено' } });
const response = (value: unknown, tokens = { input: 100, output: 10 }) => new Response(JSON.stringify({ model: spec.model, system_fingerprint: 'pilot-fixture', usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output },
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] }));
const diagnostics = () => ({ paidCalls: 0, replayCalls: 0, errors: [] as { id: string; code: string }[] });

async function sandbox(action: (fixture: { dir: string; path: string; cache: string; ledger: BenchmarkLedger; journal: PilotJournal; corpus: TrialCorpus }) => Promise<void>, cap = '20000000000', transform?: (corpus: TrialCorpus) => TrialCorpus) {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-pilot-')), path = join(dir, 'frozen.json'), cache = join(dir, 'cache'), ledger = await BenchmarkLedger.load(join(dir, 'ledger.jsonl'));
  const loaded = await loadTrialCorpus(), corpus = transform ? transform(loaded.corpus) : loaded.corpus; await ensurePilotCache(cache);
  const journal = await PilotJournal.load({ path, cacheDirectory: cache, ledger, bindingSha256: manifestHash, requestIds: pilotRequestIds(corpus, manifestHash), incrementalCapAtoms: cap, maximumCalls: 240, readOnly: false,
    assertInitial(ledger) { assert.equal(ledger.records.size, 0); } });
  try { await action({ dir, path, cache, ledger, journal, corpus }); } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}
// Positive scheduler integration uses one unambiguous synthetic question in all
// slots. It tests billing/replay/phase mechanics, not the real corpus's language quality.
const schedulerCorpus = (original: TrialCorpus): TrialCorpus => ({ ...original, dialogs: [],
  singles: Array.from({ length: 96 }, (_, i) => ({ ...structuredClone(original.singles[0]!), id: 'scheduler-' + (i + 1), split: i < 68 ? 'development' : 'holdout' })),
  repetitions: Array.from({ length: 12 }, (_, i) => ({ caseId: 'scheduler-' + (i + 1), additionalIndependentCopies: 2 })),
});

test('real audited HTTP adapter persists reserves before POST and usage before cache; exact replay makes no new HTTP calls or ledger writes', async () => sandbox(async f => {
  let calls = 0; const d = diagnostics(), turn = f.corpus.singles[0]!;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const body = JSON.parse(String(options!.body)); const step = calls === 1 ? 'gate' : 'plan';
    const id = trialRequestId(manifestHash, turn.id, step, 0); assert.ok(f.ledger.records.get(id));
    const durable = await BenchmarkLedger.load(join(f.dir, 'ledger.jsonl'), { readOnly: true }); try { assert.ok(durable.records.has(id)); } finally { await durable.close(); }
    assert.equal(body.temperature, 0); return response(step === 'gate' ? { relevance: 'financial' } : validExpense);
  }) as typeof fetch, 'empty-tools');
  const originalCache = f.journal.cache.bind(f.journal);
  f.journal.cache = async (...args) => { assert.ok(f.ledger.records.get(args[0])?.receipt?.usage); await originalCache(...args); };
  const first = await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key]));
  assert.equal(first[0]!.passed, true); assert.equal(calls, 2); assert.equal(d.paidCalls, 2);
  const before = await readFile(join(f.dir, 'ledger.jsonl'), 'utf8');
  const replay = await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key]));
  assert.deepEqual(replay, first); assert.equal(calls, 2); assert.equal(d.replayCalls, 2); assert.equal(await readFile(join(f.dir, 'ledger.jsonl'), 'utf8'), before);
  assert.equal(before.includes(key), false);
}));

test('independent repeat IDs pay independently for identical bodies, whereas the same occurrence remains cached', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, bodies: string[] = [], d = diagnostics();
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => { bodies.push(String(options!.body)); return response({ relevance: 'financial' }); }) as typeof fetch, 'empty-tools');
  for (const occurrence of [1, 2, 1]) await pilotModel(transport, f.journal, manifestHash, turn, occurrence, d).relevance({ question: turn.question, hasFinancialTasks: false, capabilities: {} as never });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(f.ledger.records.size, 2); assert.equal(d.replayCalls, 1);
}));

test('unknown delivery retains its entire reserve, blocks every new call and replays without any retry', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; throw new Error(key); }) as typeof fetch, 'empty-tools');
  const input = { question: turn.question, hasFinancialTasks: false, capabilities: {} as never };
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/);
  assert.equal(f.ledger.totals().held, 2152001920n); assert.equal(f.ledger.totals().blocked, true);
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/);
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 1, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/);
  assert.equal(calls, 1); assert.equal((await readFile(join(f.dir, 'ledger.jsonl'), 'utf8')).includes(key), false);
}));

test('missing usage and HTTP errors remain unknown; malformed completed JSON with valid usage is charged once and cached as a measured failure', async () => {
  for (const reply of [() => new Response(key, { status: 402 }), () => new Response(JSON.stringify({ choices: [] }))]) await sandbox(async f => {
    const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
    const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch, 'empty-tools');
    await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance({ question: turn.question, hasFinancialTasks: false, capabilities: {} as never }), /BENCH_RECONCILIATION_REQUIRED/);
    assert.equal(calls, 1); assert.equal(f.ledger.totals().held, 2152001920n);
  });
  await sandbox(async f => {
    const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
    const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'incorrect', secret: key }); }) as typeof fetch, 'empty-tools');
    const before = f.ledger.totals().spent;
    const first = await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key]));
    assert.equal(first[0]!.actualStatus, 'failed'); assert.ok(f.ledger.totals().spent > before); assert.equal(f.ledger.totals().held, 0n);
    const again = await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key]));
    assert.deepEqual(again, first); assert.equal(calls, 1); assert.equal((await readFile(join(f.dir, 'ledger.jsonl'), 'utf8')).includes(key), false);
  });
});

test('usage remains settled on cache write failure and cache loss; neither condition can repay the model', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'financial' }); }) as typeof fetch, 'empty-tools');
  const input = { question: turn.question, hasFinancialTasks: false, capabilities: {} as never };
  f.journal.cache = async () => { throw new Error('SYNTHETIC_DISK_FAILURE'); };
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /SYNTHETIC_DISK_FAILURE/);
  assert.ok(f.ledger.totals().spent > 0n); assert.equal(f.ledger.totals().held, 0n);
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /TASK_PILOT_RESPONSE_UNAVAILABLE/); assert.equal(calls, 1);
}));

test('incremental reserve cap is checked before HTTP and remains cumulative after process restart', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'financial' }, { input: 1000, output: 100 }); }) as typeof fetch, 'empty-tools');
  const input = { question: turn.question, hasFinancialTasks: false, capabilities: {} as never };
  await pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input);
  const reopened = await BenchmarkLedger.load(join(f.dir, 'ledger.jsonl'));
  try {
    let initialChecks = 0; const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: reopened, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash), incrementalCapAtoms: '2160000000', maximumCalls: 240, readOnly: false, assertInitial() { initialChecks++; } });
    await assert.rejects(pilotModel(transport, journal, manifestHash, turn, 1, d).relevance(input), /TASK_PILOT_INCREMENTAL_BUDGET_EXHAUSTED/);
    assert.equal(initialChecks, 0); assert.equal(calls, 1); assert.equal(reopened.records.size, 1);
  } finally { await reopened.close(); }
}, '2160000000'));

test('parallel reservations cannot race the incremental cap', async () => sandbox(async f => {
  const ids = f.journal.frozen.requestIds.slice(0, 2);
  const settled = await Promise.allSettled(ids.map(id => f.journal.reserve(id, spec.price, bound)));
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.ledger.records.size, 1);
}, '3000000000'));

test('a frozen manifest, missing state after payment, foreign request, insecure file and symlink cannot reset a budget', async () => sandbox(async f => {
  const options = { path: f.path, cacheDirectory: f.cache, ledger: f.ledger, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash), incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: false, assertInitial() { throw new Error('BASELINE_CHECKED'); } };
  await assert.rejects(PilotJournal.load({ ...options, bindingSha256: 'b'.repeat(64) }), /TASK_PILOT_FROZEN_ARTIFACT_CHANGED/);
  await chmod(f.path, 0o644); await assert.rejects(PilotJournal.load(options), /TASK_PILOT_JOURNAL_INVALID/); await chmod(f.path, 0o600);
  const id = f.journal.frozen.requestIds[0]!; await f.journal.reserve(id, spec.price, bound);
  await unlink(f.path); await assert.rejects(PilotJournal.load(options), /BASELINE_CHECKED/); assert.equal(f.ledger.records.size, 1);
  await symlink(join(f.dir, 'ledger.jsonl'), f.path); await assert.rejects(PilotJournal.load(options)); await unlink(f.path);
  await f.ledger.receipt({ id, usage: { inputTokens: 100, outputTokens: 10, modelVersion: spec.model }, value: {}, code: null, fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
  await f.ledger.reserve('f'.repeat(64), spec.price, bound); assert.throws(() => f.journal.verify(), /TASK_PILOT_FOREIGN_REQUEST/);
}));

test('read-only report reconstructs the completed prefix with no dispatch, keys, cache write or ledger write; holdout remains unopened after development failure', async () => sandbox(async f => {
  let calls = 0; const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'unrelated' }); }) as typeof fetch, 'empty-tools');
  const first = await runPilot(f.corpus, transport, f.journal, manifestHash);
  assert.equal(first.completedTurns, 92); assert.equal(first.stop, 'TASK_PILOT_DEVELOPMENT_FAILED'); assert.equal(first.holdoutOpened, false); assert.equal(first.modelAccepted, false);
  const before = await readFile(join(f.dir, 'ledger.jsonl'), 'utf8'); const count = calls;
  const readonly = await BenchmarkLedger.load(join(f.dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: readonly, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash), incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: true, assertInitial() { throw new Error('NO_WRITE'); } });
    const report = await runPilot(f.corpus, replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), journal, manifestHash);
    assert.equal(report.completedTurns, 92); assert.equal(report.paidCallsThisRun, 0); assert.equal(report.holdoutOpened, false); assert.equal(report.replayCalls, first.totalPilotCalls);
  } finally { await readonly.close(); }
  assert.equal(calls, count); assert.equal(await readFile(join(f.dir, 'ledger.jsonl'), 'utf8'), before);
}));

test('an unfinished saved prefix is reported honestly, without opening holdout or dispatching a missing next receipt', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'unrelated' }); }) as typeof fetch, 'empty-tools');
  await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d));
  const readonly = await BenchmarkLedger.load(join(f.dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: readonly, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash), incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: true, assertInitial() { throw new Error(); } });
    const report = await runPilot(f.corpus, replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), journal, manifestHash);
    assert.equal(report.stop, 'BENCH_REPLAY_ONLY'); assert.equal(report.completedTurns, 1); assert.equal(report.holdoutOpened, false); assert.equal(report.paidCallsThisRun, 0);
  } finally { await readonly.close(); }
  assert.equal(calls, 1);
}));

test('holdout gates require all 92 exact development/repeat slots and final success requires all 120, with no duplicated or replay-counted slot', async () => {
  const { corpus } = await loadTrialCorpus();
  const score = (id: string, occurrence: number): TrialScore => ({ id, occurrence, split: 'development', family: 'synthetic', passed: true, earlierFailure: false,
    relevanceCorrect: true, statusCorrect: true, queryCorrect: true, bindingCorrect: true, totalCorrect: true, privacyCorrect: true, planFields: {}, actualStatus: 'query' });
  const base = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)], development = base.filter(t => t.split === 'development').map(t => score(t.id, 0));
  for (const r of corpus.repetitions) for (let copy = 1; copy <= 2; copy++) development.push(score(r.caseId, copy));
  assert.equal(development.length, 92); assert.equal(pilotStagePassed(corpus, development, false), true); assert.equal(pilotStagePassed(corpus, development, true), false);
  assert.equal(pilotStagePassed(corpus, development.slice(1), false), false);
  const duplicate = structuredClone(development); duplicate[1] = duplicate[0]!; assert.equal(pilotStagePassed(corpus, duplicate, false), false);
  const failed = structuredClone(development); failed[30]!.passed = false; assert.equal(pilotStagePassed(corpus, failed, false), false);
  const full = [...development, ...base.filter(t => t.split === 'holdout').map(t => score(t.id, 0))]; assert.equal(full.length, 120); assert.equal(pilotStagePassed(corpus, full, true), true);
});

test('cache deletion after success stops exact replay before a new HTTP call', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'unrelated' }); }) as typeof fetch, 'empty-tools');
  await evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d));
  await unlink(join(f.cache, trialRequestId(manifestHash, turn.id, 'gate', 0) + '.json'));
  await assert.rejects(evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d)), /TASK_PILOT_RESPONSE_UNAVAILABLE/);
  assert.equal(calls, 1); assert.ok(f.ledger.totals().spent > 0n);
}));

test('provider model drift settles actual usage and blocks later dispatches', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return new Response(JSON.stringify({ model: 'changed-provider-model', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })); }) as typeof fetch, 'empty-tools');
  const input = { question: turn.question, hasFinancialTasks: false, capabilities: {} as never };
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/);
  assert.ok(f.ledger.totals().spent > 0n); assert.equal(f.ledger.totals().held, 0n); assert.equal(f.ledger.totals().blocked, true);
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 1, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/); assert.equal(calls, 1);
}));

test('a reflected credential in otherwise valid fields or a fingerprint never enters cache, ledger or report text', async () => {
  for (const fingerprint of [false, true]) await sandbox(async f => {
    const turn = f.corpus.singles[0]!, d = diagnostics();
    const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => fingerprint ? new Response(JSON.stringify({ model: spec.model, system_fingerprint: key,
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ relevance: 'financial' }) } }] })) : response(p({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потрачено' }, edits: [{ field: 'comment', op: 'set', value: key, quote: 'потрачено' }] }))) as typeof fetch, 'empty-tools');
    const model = pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key]);
    if (fingerprint) await assert.rejects(model.relevance({ question: turn.question, hasFinancialTasks: false, capabilities: {} as never }), /TASK_PILOT_PROVIDER_DRIFT/);
    else assert.deepEqual(await model.proposal({ question: turn.question, currentDate: '2026-10-15', timezone: 'Europe/Moscow', tasks: [], capabilities: {} as never, hasFixedOperationScope: false }), {});
    assert.equal((await readFile(join(f.dir, 'ledger.jsonl'), 'utf8')).includes(key), false); assert.equal(JSON.stringify(d).includes(key), false);
  });
});

test('receipt fsync failure cannot lead to a retry or a cleared reserve', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0; const originalSync = f.ledger.file.sync.bind(f.ledger.file);
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; f.ledger.file.sync = async () => { throw new Error('SYNTHETIC_FSYNC_FAILURE'); }; return response({ relevance: 'financial' }); }) as typeof fetch, 'empty-tools');
  const input = { question: turn.question, hasFinancialTasks: false, capabilities: {} as never };
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /BENCH_LEDGER_WRITE_FAILED/);
  f.ledger.file.sync = originalSync;
  assert.equal(f.ledger.totals().blocked, true); assert.equal(f.ledger.totals().held, 2152001920n);
  await assert.rejects(pilotModel(transport, f.journal, manifestHash, turn, 0, d).relevance(input), /BENCH_RECONCILIATION_REQUIRED/); assert.equal(calls, 1);
}));

test('service-pilot binding preserves the previously frozen corpus/prompts and labels immutable-model acceptance false', async () => {
  const { binding, sha256 } = await pilotBinding(); assert.match(sha256, /^[a-f0-9]{64}$/); assert.equal(binding.immutableModelVersionVerified, false);
  assert.equal(binding.currentTariffConfirmed, true); assert.equal(binding.tariff.version, '261015'); assert.equal(binding.incrementalCapAtoms, '20000000000'); assert.equal(binding.maximumCalls, 240);
  assert.equal(binding.manifest.corpusSha256, '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f');
  assert.equal(binding.manifest.promptsSha256, 'e2465ece6e41faf4cb7277c4b667ef6b1ce544e705412a23dabc1c11f3c347e8');
});

test('the frozen source identity includes transitive cost-ledger, lock, credential and privacy dependencies plus pinned package resolution', async () => {
  const { binding } = await pilotBinding(), sources = binding.manifest.source;
  for (const path of ['dependency:apps/api/src/benchmark-ledger.ts', 'dependency:apps/api/src/benchmark-probe.ts', 'dependency:apps/api/src/kms.ts', 'dependency:packages/privacy/src/text.ts', '../../../pnpm-lock.yaml', 'package.json']) assert.ok(sources[path], path);
  const bytes = await readFile(new URL('../src/benchmark-ledger.ts', import.meta.url));
  assert.equal(sources['dependency:apps/api/src/benchmark-ledger.ts'], createHash('sha256').update(bytes).digest('hex'));
});

test('Moscow midnight and a stale tariff stop before reserve/HTTP, while saved replay remains available without a clock guard', async () => sandbox(async f => {
  assertPilotFreshness(new Date('2026-10-15T20:59:59Z'));
  assert.throws(() => assertPilotFreshness(new Date('2026-10-15T21:00:00Z')), /TASK_PILOT_FRESHNESS_RECHECK_REQUIRED/);
  let calls = 0; const turn = f.corpus.singles[0]!, d = diagnostics();
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => { calls++; return response({ relevance: 'financial' }); }) as typeof fetch, 'empty-tools');
  const model = pilotModel(transport, f.journal, manifestHash, turn, 0, d, [], () => assertPilotFreshness(new Date('2026-10-16T00:00:00Z')));
  await assert.rejects(model.relevance({ question: turn.question, hasFinancialTasks: false, capabilities: {} as never }), /TASK_PILOT_FRESHNESS_RECHECK_REQUIRED/);
  assert.equal(calls, 0); assert.equal(f.ledger.records.size, 0); assert.equal(d.paidCalls, 0);
}));

test('all 120 scheduler slots can complete through the real workflow/transport/core, then replay with zero HTTP calls while model acceptance remains false', async () => sandbox(async f => {
  let calls = 0; const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const input = JSON.parse(String(options!.body)); return response(input.response_format.json_schema.schema.properties.relevance ? { relevance: 'financial' } : validExpense);
  }) as typeof fetch, 'empty-tools');
  const first = await runPilot(f.corpus, transport, f.journal, manifestHash);
  assert.equal(first.status, 'provisional_pilot_passed'); assert.equal(first.completedTurns, 120); assert.equal(first.passedTurns, 120); assert.equal(first.holdoutOpened, true); assert.equal(calls, 240); assert.equal(first.modelAccepted, false);
  const before = await readFile(join(f.dir, 'ledger.jsonl'), 'utf8'); const readOnly = await BenchmarkLedger.load(join(f.dir, 'ledger.jsonl'), { readOnly: true });
  try {
    const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: readOnly, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash), incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: true, assertInitial() { throw new Error(); } });
    const report = await runPilot(f.corpus, replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), journal, manifestHash);
    assert.equal(report.status, 'provisional_pilot_passed'); assert.equal(report.passedTurns, 120); assert.equal(report.paidCallsThisRun, 0); assert.equal(report.replayCalls, 240); assert.equal(report.modelAccepted, false);
  } finally { await readOnly.close(); }
  assert.equal(calls, 240); assert.equal(await readFile(join(f.dir, 'ledger.jsonl'), 'utf8'), before);
}, '20000000000', schedulerCorpus));

test('a full correct development/repeat phase can stop on the next reserve budget before touching the first holdout question', async () => sandbox(async f => {
  let calls = 0; const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async (_, options) => {
    calls++; const input = JSON.parse(String(options!.body)); return response(input.response_format.json_schema.schema.properties.relevance ? { relevance: 'financial' } : validExpense);
  }) as typeof fetch, 'empty-tools');
  const result = await runPilot(f.corpus, transport, f.journal, manifestHash);
  assert.equal(result.completedTurns, 92); assert.equal(result.passedTurns, 92); assert.equal(result.stop, 'TASK_PILOT_INCREMENTAL_BUDGET_EXHAUSTED'); assert.equal(result.holdoutOpened, false);
  assert.equal(calls, 184); assert.equal(f.ledger.totals().held, 0n); assert.ok(f.ledger.totals().spent < 2555000000n); assert.equal(result.modelAccepted, false);
}, '2555000000', schedulerCorpus));

test('the original 45 RUB cumulative cap still rejects a new reserve even when the incremental pilot cap has room', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-pilot-global-')), ledger = await BenchmarkLedger.load(join(dir, 'ledger.jsonl')), cache = join(dir, 'cache');
  try {
    for (let i = 0; i < 20; i++) { const id = benchmarkDigest(['global-baseline', i]); await ledger.reserve(id, spec.price, bound); await ledger.receipt({ id, usage: { inputTokens: bound.inputTokens, outputTokens: bound.outputTokens, modelVersion: spec.model }, value: {}, code: null, fingerprint: 'pilot-fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null }); }
    await ensurePilotCache(cache); const id = benchmarkDigest('global-new');
    const journal = await PilotJournal.load({ path: join(dir, 'state.json'), cacheDirectory: cache, ledger, bindingSha256: manifestHash, requestIds: [id], incrementalCapAtoms: '20000000000', maximumCalls: 1, readOnly: false, assertInitial(l) { assert.equal(l.records.size, 20); } });
    const before = ledger.totals().spent; await assert.rejects(journal.reserve(id, spec.price, bound), /BENCH_BUDGET_EXHAUSTED/);
    assert.equal(ledger.totals().spent, before); assert.equal(ledger.records.size, 20); assert.equal(ledger.totals().held, 0n);
  } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('historical unknown holds and failed receipts remain byte-identical and count toward the cumulative cap throughout a new pilot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-pilot-holds-')), ledger = await BenchmarkLedger.load(join(dir, 'ledger.jsonl')), cache = join(dir, 'cache');
  try {
    const first = benchmarkDigest('old-first'), probe = benchmarkDigest('old-probe'), proof = benchmarkDigest('old-proof');
    const reject = async (id: string) => ledger.receipt({ id, usage: null, value: null, code: 'BENCH_PROVIDER_FAILURE_HTTP_402', fingerprint: null, latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.reserve(first, spec.price, bound); await reject(first); await ledger.reserveProbe(probe, spec.price, bound); await reject(probe);
    await ledger.reserveProbe(proof, spec.price, bound, 'operator_probe_after_funding'); await ledger.receipt({ id: proof, usage: { inputTokens: 100, outputTokens: 10, modelVersion: spec.model }, value: { relevance: 'financial', followUp: false }, code: null, fingerprint: 'pilot-fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    await ledger.allowFundedSmoke(); const before = JSON.stringify([ledger.records.get(first), ledger.records.get(probe)]), held = ledger.totals().held;
    await ensurePilotCache(cache); const id = benchmarkDigest('new-with-holds');
    const journal = await PilotJournal.load({ path: join(dir, 'state.json'), cacheDirectory: cache, ledger, bindingSha256: manifestHash, requestIds: [id], incrementalCapAtoms: '20000000000', maximumCalls: 1, readOnly: false, assertInitial(l) { assert.equal(l.records.size, 3); assert.equal(l.totals().blocked, false); } });
    await journal.reserve(id, spec.price, bound); await ledger.receipt({ id, usage: { inputTokens: 100, outputTokens: 10, modelVersion: spec.model }, value: {}, code: null, fingerprint: 'pilot-fixture', latencyMs: 1, cachedTokens: null, reasoningTokens: null });
    assert.equal(ledger.totals().held, held); assert.equal(held, 4304003840n); assert.equal(JSON.stringify([ledger.records.get(first), ledger.records.get(probe)]), before);
    assert.equal(journal.verify().incrementalUpperAtoms, '2196000');
  } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('both actual provider schemas are audited offline: simple gate passes and all proposal risks are uniqueItems', () => {
  assert.deepEqual(auditTaskWireSchema(taskRelevanceSchema), []);
  const issues = auditTaskWireSchema(taskProposalSchema);
  assert.ok(issues.length > 0); assert.ok(issues.every(i => i.keyword === 'uniqueItems'));
  assert.ok(issues.some(i => i.path.includes('/edits/')));
  assert.deepEqual(auditTaskWireSchema(projectTaskWireSchema(taskProposalSchema)), []);
});

test('decoder projection changes only uniqueItems while the unchanged local parser still rejects duplicate names', () => {
  const before = JSON.stringify(taskProposalSchema), projected = projectTaskWireSchema(taskProposalSchema);
  const independent = JSON.parse(before, (key, value) => key === 'uniqueItems' ? undefined : value);
  assert.deepEqual(projected, independent); assert.equal(JSON.stringify(taskProposalSchema), before);
  assert.equal(JSON.stringify(projected).includes('"additionalProperties":false'), true);
  assert.equal(JSON.stringify(projected).includes('"maxLength":2000'), true);
  const question = 'Сколько потрачено на продукты?', value = p({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'потрачено' },
    edits: [{ field: 'categories', op: 'set', quote: 'продукты', value: { names: ['продукты'] } }] });
  assert.doesNotThrow(() => parseTaskProposalWire(value, question));
  const duplicate = { ...value, edits: [{ field: 'categories', op: 'set', quote: 'продукты', value: { names: ['продукты', 'продукты'] } }] };
  assert.throws(() => parseTaskProposalWire(duplicate, question));
});

test('schema profile fails closed on other unsupported or new constraints and treats property names as data', () => {
  for (const schema of [{ type: 'string', format: 'date' }, { type: 'integer', multipleOf: 5 }, { type: 'array', contains: { type: 'string' } },
    { type: 'object', patternProperties: {} }, { type: 'object', allOf: [] }, null]) {
    assert.ok(auditTaskWireSchema(schema).length); assert.throws(() => projectTaskWireSchema(schema), /TASK_WIRE_SCHEMA_UNSUPPORTED/);
  }
  assert.deepEqual(auditTaskWireSchema({ type: 'object', properties: { uniqueItems: { type: 'string' } }, required: ['uniqueItems'], additionalProperties: false }), []);
});

test('safe provider error vocabulary exposes no raw provider text or reflected credential and bounds oversized input', () => {
  const classified = classifyTaskProviderError(JSON.stringify({ error: { message: key + ' xgrammar response_format json_schema uniqueItems not supported', code: key, param: key } }));
  assert.equal(classified.reason, 'schema_unsupported'); assert.equal(classified.decoder, 'xgrammar');
  assert.deepEqual(classified.referencedSchemaKeywords, ['uniqueItems']); assert.equal(JSON.stringify(classified).includes(key), false);
  assert.equal(classifyTaskProviderError(key).reason, 'unclassified');
  assert.deepEqual(classifyTaskProviderError('xgrammar uniqueItems'.repeat(2000)), classifyTaskProviderError(''));
});

test('stopped HTTP 400 checkpoint reads the original two receipts/cache without HTTP, writes, retries or released holds', async () => sandbox(async f => {
  const turn = f.corpus.singles[0]!, d = diagnostics(); let calls = 0;
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: key }, (async () => ++calls === 1 ? response({ relevance: 'financial' }) : new Response('uniqueItems ' + key, { status: 400 })) as typeof fetch, 'empty-tools');
  await assert.rejects(evaluateTrialScenario([turn], () => pilotModel(transport, f.journal, manifestHash, turn, 0, d, [key])), /BENCH_RECONCILIATION_REQUIRED/);
  const gateId = trialRequestId(manifestHash, turn.id, 'gate', 0), files = [f.path, join(f.dir, 'ledger.jsonl'), join(f.cache, gateId + '.json')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8'))), totals = f.ledger.totals();
  const journal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: f.ledger, bindingSha256: manifestHash, requestIds: pilotRequestIds(f.corpus, manifestHash),
    incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: true, assertInitial() { assert.fail(); } });
  const a = await inspectTaskPilot(journal, f.corpus, manifestHash), b = await inspectTaskPilot(journal, f.corpus, manifestHash);
  assert.deepEqual(a, b); assert.equal(a.records.length, 2); assert.equal(a.records[0]!.relevance, 'financial'); assert.equal(a.records[0]!.cacheStatus, 'verified');
  assert.equal(a.records[1]!.phase, 'plan'); assert.equal(a.records[1]!.error, 'BENCH_PROVIDER_FAILURE_HTTP_400'); assert.equal(a.records[1]!.usage, null);
  assert.equal(a.records[1]!.heldAtoms, '2152001920'); assert.equal(a.blocked, true); assert.equal(a.httpCalls, 0); assert.equal(calls, 2);
  assert.equal(a.holdsReleased, false); assert.equal(a.schemaAudit.provider400CauseConfirmed, false); assert.equal(a.schemaAudit.originalProviderErrorRecoverable, false);
  assert.equal(BigInt(a.remainingIncrementalHeadroomAtoms) + BigInt(a.incrementalUpperAtoms), 20_000_000_000n);
  assert.deepEqual(f.ledger.totals(), totals); assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before); assert.equal(JSON.stringify(a).includes(key), false);
  await assert.rejects(inspectTaskPilot(f.journal, f.corpus, manifestHash), /READ_ONLY_REQUIRED/);
  await assert.rejects(inspectTaskPilot(journal, f.corpus, 'b'.repeat(64)), /READ_ONLY_REQUIRED/);
}));

test('new read-only inspector and prepared wire profile leave the already-paid v1 source/binding identity unchanged', async () => {
  const artifact = await pilotBinding();
  assert.equal(artifact.sha256, '0afd24fe2c7394be7ee74e5000fb1996e21f4f885c0db38adf977bb14797f691');
  assert.equal(artifact.binding.manifest.sourceSha256, '30fca54575fc31a25556e08c4a73129f52c7e96870d23849d70272e818858787');
});
