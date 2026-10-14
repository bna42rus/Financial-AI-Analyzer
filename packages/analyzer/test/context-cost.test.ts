import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScope } from '../src/context.ts';
import { interpret } from '../src/registry.ts';
import { rubAmount, tokenCost, tokenPrice, remainingCost, baseMonthlyCost } from '../src/cost.ts';
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const globals = { from: '2026-10-01', through: '2026-10-31', categoryIds: [id], bankId: 'tbank' };
const task = { ...globals, from: '2026-09-01', through: '2026-09-30', categoryIds: [other] };

test('new task uses globals; unchanged globals preserve task overrides without mutating inputs', () => {
  assert.deepEqual(resolveScope(globals).filter, globals);
  assert.deepEqual(resolveScope(globals, task, globals).filter, task);
  assert.equal(resolveScope(globals, task, globals).sources.from, 'task');
  assert.equal(resolveScope(globals, task, globals).sources.bankId, 'global');
  assert.deepEqual(task.categoryIds, [other]);
});
test('changed global dates replace the period as a unit; latest message takes priority', () => {
  const current = { ...globals, through: '2026-10-14' };
  assert.deepEqual(resolveScope(current, task, globals).filter, { ...task, from: globals.from, through: current.through });
  const r = resolveScope(current, task, globals, { from: '2026-08-01', through: '2026-08-31' });
  assert.equal(r.filter.from, '2026-08-01'); assert.equal(r.sources.from, 'message');
});
test('removing/changing global categories clears stale subcategory conditions; account sets compare independent of order', () => {
  assert.deepEqual(resolveScope({ bankId: 'tbank' }, { ...task, subcategoryIds: [id] }, globals).filter, { bankId: 'tbank' });
  const before = { accountIds: [id, other] };
  assert.deepEqual(resolveScope({ accountIds: [other, id] }, { accountIds: [other] }, before).filter, { accountIds: [other] });
});
test('deterministic follow-up uses changed global scope and explicit question dates still win', () => {
  const query = interpret('Мои расходы за сентябрь 2026', globals).query!;
  assert.equal(interpret('А по категориям?', { ...globals, from: '2026-08-01', through: '2026-08-31' }, query, new Date(), globals).query?.filter.from, '2026-08-01');
  assert.equal(interpret('А за июль 2026?', { ...globals, from: '2026-08-01' }, query, new Date(), globals).query?.filter.from, '2026-07-01');
});
test('an independent flag never resets the task category, while a new explicit category drops a stale subcategory',()=>{
  const r=resolveScope({...globals,noSubcategory:true},task,globals);assert.deepEqual(r.filter.categoryIds,[other]);assert.equal(r.filter.from,task.from);
  assert.deepEqual(resolveScope({...task,subcategoryIds:[id]},undefined,undefined,{categoryIds:[id]}).filter.categoryIds,[id]);
  assert.equal(resolveScope({...task,subcategoryIds:[id]},undefined,undefined,{categoryIds:[id]}).filter.subcategoryIds,undefined);
});
test('latest explicit category removes a newly selected global leaf even when it equals the old task category',()=>{
  const leaf='10000000-0000-4000-8000-000000000003';
  const r=resolveScope({...globals,subcategoryIds:[leaf]},task,globals,{categoryIds:[other]});
  assert.deepEqual(r.filter.categoryIds,[other]);assert.equal(r.filter.subcategoryIds,undefined);assert.equal(r.sources.categoryIds,'message');
});
const price = { version: 'cloud-261002', currency: 'RUB' as const, inputRubPerMillion: '15.86', outputRubPerMillion: '61' };
test('million-token rates and sub-copeck costs are exact integer accounting values', () => {
  assert.equal(tokenCost(price, 3000, 500), rubAmount('0.07808'));
  assert.equal(tokenCost(price, 6000, 1200), rubAmount('0.16836'));
  assert.equal(tokenCost(price, 1_000_000, 0), rubAmount('15.86'));
  assert.equal(tokenCost(price, 1, 0) * 10_000n, rubAmount('0.1586'));
  assert.equal(baseMonthlyCost, rubAmount('100'));
});
test('billing rejects floats, wrong units/currency, negatives and unsafe quantities', () => {
  for (const amount of [0.1, '-1', '01', '1e3', 'NaN', '0.0000000001', ' 100']) assert.throws(() => rubAmount(amount));
  for (const n of [-1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER]) assert.throws(() => tokenCost(price, n, 0));
  assert.throws(() => tokenPrice({ ...price, currency: 'USD' }));
  assert.throws(() => tokenPrice({ ...price, inputRubPerMillion: '0' }));
  assert.throws(() => tokenPrice({ ...price, perThousand: true }));
});
test('reserved money occupies balance; conservative rounding is finer than a copeck', () => {
  assert.equal(remainingCost(100n, 70n, 30n), 0n);
  assert.equal(remainingCost(100n, 70n, 20n), 10n);
  assert.equal(tokenCost({ ...price, inputRubPerMillion: '0.000000001' }, 1, 0), 1n);
  assert.throws(() => remainingCost(1n, -1n, 0n));
});
