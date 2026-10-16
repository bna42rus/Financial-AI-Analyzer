import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditObservedJsonCache, observedJsonRun } from '../src/task-json-cache-audit.ts';

const load = async () => JSON.parse(await readFile(new URL('./fixtures/task-json-observed-20261015.json', import.meta.url), 'utf8'));
const review = auditObservedJsonCache(await load());

test('all 170 real saved responses reproduce the original 52/92 score with exact original wire bodies and no HTTP or ledger adapter', async () => {
  const r = await review;
  assert.equal(r.suppliedExportSha256, observedJsonRun.exportSha256); assert.equal(r.recordsConsumed, 170); assert.equal(r.turns, 92); assert.equal(r.passed, 52);
  assert.deepEqual(r.development, { turns: 68, passed: 36 }); assert.deepEqual(r.independentRepetitions, { turns: 24, passed: 16 });
  assert.equal(r.paidCalls, 0); assert.equal(r.httpCalls, 0); assert.equal(r.ledgerModified, false); assert.equal(r.holdoutOpened, false);
  assert.equal(r.primaryFailures, 26); assert.equal(r.failuresWithEarlierFailure, 14); assert.equal(r.lostRejectedPayloads, 14);
  assert.equal(r.rows.filter(t => t.gateReused).length, 1);
});

test('identical observed repeat wires exhibit semantic variation in six families rather than being counted as stable replay', async () => {
  const r = await review, varying = r.repeatGroups.filter(g => g.semanticOutcomeVaries);
  assert.equal(r.repeatGroups.length, 12); assert.equal(varying.length, 6);
  assert.ok(r.repeatGroups.every(g => g.planWireIdentical || g.id === 'single-24' || g.id === 'single-28'));
  assert.deepEqual(r.repeatGroups.find(g => g.id === 'single-05')!.passed, [false, false, true]);
  assert.deepEqual(r.repeatGroups.find(g => g.id === 'single-01')!.passed, [false, false, false]);
});

test('a lost threshold is identified as wrong scope, while the financial core still computes the supplied scope exactly', async () => {
  const r = await review, row = r.rows.find(t => t.id === 'money-2')!;
  assert.equal(row.score!.actualTotalMinor, '2100000'); assert.equal(row.expected.totalMinor, '100000'); assert.equal(row.score!.bindingCorrect, false);
  assert.equal(row.score!.actualQuery?.filter.amountFrom, undefined); assert.equal(row.expected.query?.filter.amountFrom, '100000');
  assert.equal(row.tasks?.length, 1); assert.equal((row.plan as any).binding.kind, 'new');
});

test('current attention values can agree while scope differs; strict results are not silently reclassified as passes', async () => {
  const r = await review; assert.equal(r.representationOnly.length, 2);
  for (const example of r.representationOnly) { assert.equal(example.currentTotalsEqual, true); assert.equal(example.currentPointsEqual, true);
    assert.equal(example.currentOperationCountsEqual, false); assert.equal(example.countedAsPassed, false); assert.equal(example.futureTaskScopeEquivalent, 'not_proven'); }
  assert.equal(r.oldResultsRescoredAsSuccess, false); assert.equal(r.passed, 52);
});

test('the observed export rejects changed identity, duplicate IDs, missing responses and forged successful responses', async () => {
  const cases = [async () => ({ ...await load(), bindingSha256: 'a'.repeat(64) }), async () => { const v = await load(); v.records.pop(); return v; },
    async () => { const v = await load(); v.records[1] = structuredClone(v.records[0]); return v; },
    async () => { const v = await load(); v.records.find((r: any) => r.code).value = { status: 'query' }; return v; },
    async () => { const v = await load(); v.records[0].wireSha256 = 'a'.repeat(64); return v; },
    async () => { const v = await load(); v.records.find((r: any) => r.value?.relevance).value.relevance = 'unrelated'; return v; }];
  for (const mutate of cases) await assert.rejects(auditObservedJsonCache(await mutate()), /TASK_JSON_AUDIT_EXPORT_/);
});

test('all observed rejected proposals remain null and no unrecorded answer or counterfactual parent is substituted', async () => {
  const r = await review, lost = r.rows.filter(t => t.planCode === 'TASK_PILOT_PAYLOAD_INVALID'); assert.equal(lost.length, 14);
  assert.ok(lost.every(t => t.plan === null && t.score!.actualStatus === 'failed'));
  assert.deepEqual(r.rows.find(t => t.id === 'scope-2')!.tasks, []);
  assert.equal(r.rows.find(t => t.id === 'scope-4')!.score!.actualQuery?.grouping, 'none');
});
