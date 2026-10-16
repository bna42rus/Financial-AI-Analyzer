import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditObservedIntentCache, inspectIntent, observedIntentRun, renderIntentAudit, rubles } from '../src/task-intent-cache-audit.ts';
import { benchmarkDigest } from '../src/benchmark-ledger.ts';
import { intentTaskModel } from '../src/analyzer-intent-model.ts';
import { intentRequestBody, replayIntentTransport } from '../src/task-intent-transport.ts';
import { evaluateTrialScenario, loadTrialCorpus, trialRequestId } from '../src/task-trial.ts';
import type { TrialTurn } from '../src/task-trial.ts';
import { taskIntentPrompt, taskIntentSchema } from '../../../packages/analyzer/src/task-intent.ts';
import { intentTrialBinding } from '../src/task-intent-trial.ts';

// Generated synthetic responses exercise diagnostic plumbing. They are NOT the
// private 88 observed answers and provide no evidence of model language quality.
async function syntheticExport() {
  const { corpus } = await loadTrialCorpus(), records: any[] = [], bound = replayIntentTransport().bound;
  const scopeValues: Record<string, unknown> = {
    'scope-1': { relevance: 'financial', action: 'read', metric: { value: 'expenses', quote: 'потратил' }, edits: [
      { field: 'period', op: 'set', quote: 'сентябре 2026 года', value: 'сентябре 2026 года' },
      { field: 'categories', op: 'set', quote: 'продукты', value: { names: ['продукты'] } },
    ] },
    'scope-2': { relevance: 'financial', action: 'read', grouping: { value: 'category', quote: 'по категориям' } },
  };
  const evaluate = async (turns: TrialTurn[], occurrence = 0) => evaluateTrialScenario(turns, turn => intentTaskModel(async input => {
    const index = records.length;
    const value = index < 12 ? { relevance: 'financial', action: 'read', metric: { value: 'expenses', quote: 'ЭТОЙ ЦИТАТЫ НЕТ' } } :
      index < 23 ? { relevance: 'financial', action: 'read', unexpected: true } : scopeValues[turn.id] ?? { relevance: 'financial', action: 'read' };
    const inspection = inspectIntent(value, turn.question);
    const safeCode = inspection.code && ['TASK_WIRE_INVALID', 'TASK_NAMES_INVALID', 'TASK_EVIDENCE_MISSING', 'TASK_DUPLICATE_EDIT', 'TASK_EMPTY_SET'].includes(inspection.code) ? inspection.code : 'closed_contract';
    records.push({ id: trialRequestId(observedIntentRun.bindingSha256, turn.id, 'gate', occurrence), caseId: turn.id, occurrence, question: turn.question,
      wireSha256: benchmarkDigest(intentRequestBody('cloud-oss', bound, taskIntentPrompt, input, taskIntentSchema)),
      usage: { inputTokens: 100, outputTokens: 20, modelVersion: 'openai/gpt-oss-120b' }, validationCode: inspection.accepted ? null : 'TASK_PILOT_PAYLOAD_INVALID/gate/' + safeCode, value });
    return inspection.accepted ? value : {};
  }), occurrence);
  for (const t of corpus.singles.filter(t => t.split === 'development')) await evaluate([t]);
  for (const d of corpus.dialogs.filter(d => d.split === 'development')) await evaluate(d.turns);
  for (const r of corpus.repetitions) for (let occurrence = 1; occurrence <= 2; occurrence++) if (records.length < 88) await evaluate([corpus.singles.find(t => t.id === r.caseId)!], occurrence);
  return { audit: 'cashneuro-intent-cached-decisions/1', bindingSha256: observedIntentRun.bindingSha256, frozenSha256: observedIntentRun.frozenSha256,
    ledgerHeadSha256: observedIntentRun.ledgerHeadSha256, paidCalls: 0, records };
}

test('diagnostic files leave the frozen executable binding exactly unchanged', async () => {
  assert.equal((await intentTrialBinding()).sha256, observedIntentRun.bindingSha256);
});

test('evidence, lexical validator, closed schema and field-specific errors retain different paths and codes', () => {
  const read = { relevance: 'financial', action: 'read' };
  const missing = inspectIntent({ ...read, metric: { value: 'expenses', quote: 'потрачено' } }, 'Сколько потратил?');
  assert.equal(missing.code, 'TASK_EVIDENCE_MISSING'); assert.equal(missing.issues[0]!.path, '$.metric');
  const lexical = inspectIntent({ ...read, metric: { value: 'income', quote: 'по категориям' } }, 'А по категориям?');
  assert.equal(lexical.code, 'TASK_INTENT_EVIDENCE_INVALID'); assert.match(lexical.issues[0]!.detail, /Цитата дословна/);
  const shape = inspectIntent({ ...read, metric: { value: 'income', quote: null } }, 'Доходы?');
  assert.equal(shape.code, 'TASK_WIRE_INVALID'); assert.equal(shape.issues[0]!.path, '$.metric.quote');
  const field = inspectIntent({ ...read, edits: [{ field: 'amount', op: 'set', quote: 'от 100 рублей', value: true }] }, 'Отбор от 100 рублей');
  assert.equal(field.code, 'TASK_WIRE_INVALID'); assert.equal(field.issues[0]!.path, '$.edits[0]');
  const period = inspectIntent({ ...read, edits: [{ field: 'period', op: 'set', quote: 'в сентябре', value: '2026-09-01' }] }, 'Расходы в сентябре');
  assert.equal(period.code, 'TASK_EVIDENCE_MISSING'); assert.match(period.issues[0]!.detail, /периода/);
});

test('all 88 synthetic records replay without HTTP, retain rejected raw answers, and preserve actual rather than golden parents', async () => {
  const data = await syntheticExport(), saved = globalThis.fetch;
  let httpCalls = 0;
  globalThis.fetch = async () => { httpCalls++; throw Error('NETWORK_FORBIDDEN'); };
  try {
    const r = await auditObservedIntentCache(data);
    assert.equal(r.turns, 88); assert.equal(r.rejected, 23); assert.equal(r.paidCalls, 0); assert.equal(r.httpCalls, 0); assert.equal(httpCalls, 0);
    assert.equal(r.ledgerModified, false); assert.equal(r.holdoutOpened, false);
    assert.equal(r.tokens.input, 8800); assert.equal(r.tokens.output, 1760);
    assert.equal(r.rows.filter(t => t.occurrence > 0).length, 20);
    assert.deepEqual(r.rows[0]!.raw, data.records[0]!.value); assert.equal(r.rows[0]!.score!.actualStatus, 'failed');
    assert.equal(r.rows[0]!.errorClass, 'VALIDATION_REJECTION');
    const followup = r.rows.find(t => t.id === 'scope-2')!;
    assert.equal(followup.hasFinancialTasks, true); assert.equal(followup.score!.passed, true);
    assert.equal(followup.score!.actualQuery!.filter.from, '2026-09-01');
    assert.equal(r.rows.find(t => t.id === 'manual-2')!.hasFinancialTasks, false);
    const summary = renderIntentAudit(r), full = renderIntentAudit(r, true);
    assert.ok(full.length > summary.length); assert.match(summary, /Новые вызовы модели: 0/);
    assert.match(summary, /НЕ доказывает причинную связь/); assert.match(full, /CASE scope-2@0/);
    assert.equal((full.match(/^CASE /gm) ?? []).length, 88);
  } finally { globalThis.fetch = saved; }
});

test('changed identities, missing/duplicate/foreign slots, wire drift and rewritten rejection decisions fail closed', async () => {
  const source = await syntheticExport();
  const mutations = [
    (v: any) => { v.bindingSha256 = 'a'.repeat(64); },
    (v: any) => { v.ledgerHeadSha256 = 'a'.repeat(64); },
    (v: any) => { v.records.pop(); },
    (v: any) => { v.records[1] = v.records[0]; },
    (v: any) => { v.records[0].caseId = 'foreign'; },
    (v: any) => { v.records[0].question = 'Подменено'; },
    (v: any) => { v.records[0].wireSha256 = 'a'.repeat(64); },
    (v: any) => { v.records[0].validationCode = null; },
    (v: any) => { v.records[0].value = { relevance: 'financial', action: 'read' }; },
    (v: any) => { v.records[0].validationCode = 'TASK_PILOT_PAYLOAD_INVALID/gate/TASK_WIRE_INVALID'; },
  ];
  for (const mutate of mutations) { const v = structuredClone(source); mutate(v); await assert.rejects(auditObservedIntentCache(v), /INTENT_DIAGNOSTICS_/); }
});

test('cost text uses integer atoms, including sub-kopeck values', () => {
  assert.equal(rubles(4333490020n), '4.333490020'); assert.equal(rubles('1'), '0.000000001');
});
