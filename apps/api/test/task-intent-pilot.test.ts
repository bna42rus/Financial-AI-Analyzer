import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchmarkLedger } from '../src/benchmark-ledger.ts';
import { PilotJournal, ensurePilotCache } from '../src/task-pilot-journal.ts';
import { pilotModel, runPilot, pilotRequestIds } from '../src/task-pilot-runner.ts';
import { createCapturedIntentTransport, replayIntentTransport } from '../src/task-intent-transport.ts';
import { loadTrialCorpus, trialRequestId, evaluateTrialScenario } from '../src/task-trial.ts';
import { persistProviderError, rejectedTaskPayloadCapture, readSafeProviderError } from '../src/task-json-transport.ts';
import { assertIntentTrialStart, intentTrialBaseline, intentTrialBinding } from '../src/task-intent-trial.ts';
import type { TrialCorpus } from '../src/task-trial.ts';

const key = 'synthetic-intent-trial-secret-12345', binding = 'b'.repeat(64);
const valid = { relevance: 'financial', action: 'read', metric: { value: 'expenses', quote: 'потрачено' } };
const diagnostics = () => ({ paidCalls: 0, replayCalls: 0, errors: [] as { id: string; code: string }[] });
const reply = (value: unknown = valid, usage = true) => new Response(JSON.stringify({ model: 'openai/gpt-oss-120b',
  ...(usage ? { usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 } } : {}),
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value), tool_calls: [] } }] }));
function schedulerCorpus(c: TrialCorpus): TrialCorpus {
  return { ...c, dialogs: [], singles: Array.from({ length: 96 }, (_, i) => ({ ...structuredClone(c.singles[0]!), id: 'intent-scheduler-' + i, split: i < 68 ? 'development' : 'holdout' })),
    repetitions: Array.from({ length: 12 }, (_, i) => ({ caseId: 'intent-scheduler-' + i, additionalIndependentCopies: 2 })) };
}
function ids(corpus: TrialCorpus) {
  const gates = new Set(corpus.singles.map(t => trialRequestId(binding, t.id, 'gate', 0)));
  for (const r of corpus.repetitions) for (let occurrence = 1; occurrence <= 2; occurrence++) gates.add(trialRequestId(binding, r.caseId, 'gate', occurrence));
  return pilotRequestIds(corpus, binding).filter(id => gates.has(id));
}
async function fixture(action: (f: { dir: string; ledgerPath: string; path: string; cache: string; ledger: BenchmarkLedger; journal: PilotJournal; corpus: TrialCorpus }) => Promise<void>, cap = '20000000000') {
  const dir = await mkdtemp(join(tmpdir(), 'cashneuro-intent-')), ledgerPath = join(dir, 'ledger.jsonl'), path = join(dir, 'frozen.json'), cache = join(dir, 'cache');
  const ledger = await BenchmarkLedger.load(ledgerPath), corpus = schedulerCorpus((await loadTrialCorpus()).corpus);
  try {
    await ensurePilotCache(cache);
    const journal = await PilotJournal.load({ path, cacheDirectory: cache, ledger, bindingSha256: binding, requestIds: ids(corpus), incrementalCapAtoms: cap, maximumCalls: 120,
      readOnly: false, assertInitial(l) { assert.equal(l.records.size, 0); } });
    await action({ dir, ledgerPath, path, cache, ledger, journal, corpus });
  } finally { await ledger.close(); await rm(dir, { recursive: true, force: true }); }
}

test('one frozen batch performs 120 distinct paid intent calls, 24 independent repeats, guarded holdout and a free exact replay', async () => fixture(async f => {
  let calls = 0;
  const live = createCapturedIntentTransport({ apiKey: key }, (async (_url, options) => {
    calls++; const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
    assert.deepEqual(Object.keys(input).sort(), ['hasFinancialTasks', 'question']);
    assert.equal(f.ledger.records.size, calls); assert.ok([...f.ledger.records.values()].at(-1)?.reserve);
    return reply();
  }) as typeof fetch);
  const result = await runPilot(f.corpus, live.transport, f.journal, binding, { intent: true });
  assert.equal(result.completedTurns, 120); assert.equal(result.passedTurns, 120); assert.equal(result.holdoutOpened, true); assert.equal(result.paidCallsThisRun, 120); assert.equal(calls, 120);
  assert.equal(result.modelAccepted, false); assert.equal(result.runtimeAiEnabled, false);
  const bytes = await readFile(f.ledgerPath, 'utf8'), frozen = await readFile(f.path, 'utf8');
  const reportJournal = await PilotJournal.load({ path: f.path, cacheDirectory: f.cache, ledger: f.ledger, bindingSha256: binding, requestIds: ids(f.corpus), incrementalCapAtoms: '20000000000', maximumCalls: 120,
    readOnly: true, assertInitial() { throw new Error('report must not create state'); } });
  const replay = await runPilot(f.corpus, replayIntentTransport(), reportJournal, binding, { intent: true });
  assert.equal(replay.passedTurns, 120); assert.equal(replay.paidCallsThisRun, 0); assert.equal(replay.replayCalls, 120); assert.equal(calls, 120);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), bytes); assert.equal(await readFile(f.path, 'utf8'), frozen);
}));

test('an invalid intent is durably charged once, caches rejection, and captures private evidence after receipt; replay does not retry', async () => fixture(async f => {
  let calls = 0, captured = 0;
  const turn = f.corpus.singles[0]!, id = trialRequestId(binding, turn.id, 'gate', 0), value = { ...valid, binding: { kind: 'new' }, secret: key };
  const live = createCapturedIntentTransport({ apiKey: key }, (async () => { calls++; return reply(value); }) as typeof fetch), d = diagnostics();
  const sink = async (payload: Parameters<typeof rejectedTaskPayloadCapture>[0]) => {
    captured++; assert.ok(f.ledger.records.get(id)?.receipt?.usage); assert.equal(f.ledger.totals().held, 0n);
    assert.match(await readFile(join(f.cache, id + '.json'), 'utf8'), /TASK_PILOT_PAYLOAD_INVALID/);
    await persistProviderError(f.dir, id, rejectedTaskPayloadCapture(payload));
  };
  const [first] = await evaluateTrialScenario([turn], t => pilotModel(live.transport, f.journal, binding, t, 0, d, [key], undefined, undefined, sink, true));
  assert.equal(first!.actualStatus, 'failed'); assert.equal(calls, 1); assert.equal(captured, 1); assert.equal(d.paidCalls, 1);
  const safe = await readSafeProviderError(f.dir, id); assert.equal(JSON.stringify(safe).includes(key), false); assert.equal(safe.kind, 'payload_rejection');
  assert.equal((await readFile(f.ledgerPath, 'utf8')).includes(key), false);
  const [again] = await evaluateTrialScenario([turn], t => pilotModel(live.transport, f.journal, binding, t, 0, d, [key], undefined, undefined, sink, true));
  assert.equal(again!.actualStatus, 'failed'); assert.equal(calls, 1); assert.equal(captured, 1);
}));

test('one unknown-usage intent stops the batch, retains full reserve and never opens holdout or dispatches a plan', async () => fixture(async f => {
  let calls = 0;
  const live = createCapturedIntentTransport({ apiKey: key }, (async () => { calls++; return reply(valid, false); }) as typeof fetch);
  const result = await runPilot(f.corpus, live.transport, f.journal, binding, { intent: true });
  assert.equal(calls, 1); assert.equal(result.stop, 'BENCH_RECONCILIATION_REQUIRED'); assert.equal(result.completedTurns, 0); assert.equal(result.holdoutOpened, false);
  assert.equal(f.ledger.totals().held, 2152001920n); assert.equal(f.ledger.totals().blocked, true);
}));

test('the batch respects cumulative reservation headroom instead of replacing the cap or reducing the full-context reserve', async () => fixture(async f => {
  let calls = 0;
  const live = createCapturedIntentTransport({ apiKey: key }, (async () => { calls++; return reply(); }) as typeof fetch);
  const result = await runPilot(f.corpus, live.transport, f.journal, binding, { intent: true });
  assert.equal(result.stop, 'TASK_PILOT_INCREMENTAL_BUDGET_EXHAUSTED'); assert.ok(calls > 0 && calls < 10); assert.equal(result.holdoutOpened, false);
  assert.ok(BigInt(result.incrementalUpperAtoms) <= 2160000000n); assert.ok([...f.ledger.records.values()].every(r => r.reserve.bound.inputTokens === 131072));
}, '2160000000'));

test('new paid admission binds exact observed ledger and retains original caps; a different baseline is rejected before artifact reads', async () => fixture(async f => {
  await assert.rejects(assertIntentTrialStart(f.ledger, f.dir), /TASK_INTENT_BASELINE_CHANGED/);
  assert.equal(intentTrialBaseline.remainingAtoms, '6441024920');
  const artifact = await intentTrialBinding(); assert.equal(artifact.binding.maximumNewModelCalls, 120); assert.equal(artifact.binding.admission.incrementalCapAtoms, '20000000000');
  assert.equal(artifact.binding.admission.budgetBaselineUpperAtoms, '20888941260'); assert.equal(artifact.binding.modelAccepted, false);
  assert.equal(artifact.binding.runtimeAiEnabled, false); assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
}));
