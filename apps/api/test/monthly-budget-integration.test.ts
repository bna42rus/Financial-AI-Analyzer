import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { reserveCost, settleCost } from '../src/analyzer-cost.ts';
import type { CostPolicy } from '../src/analyzer-cost.ts';
import { monthlyPeriod, prepareMonthlyDispatch, authorizeMonthlyDispatch, monthlyBudgetState } from '../src/assistant-monthly.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>;
const projectId = 'staging/monthly-integration', now = () => new Date();
const policy = (): CostPolicy => ({ projectId, ...monthlyPeriod(now()), projectLimitRub: '100', price: { version: 'synthetic', currency: 'RUB', inputRubPerMillion: '15.86', outputRubPerMillion: '61' } });
const bound = { inputTokens: 131072, outputTokens: 4096, modelVersion: 'openai/gpt-oss-120b' };
async function within<T>(action: (db: PoolClient) => Promise<T>) {
  const db = await pg.finance.connect();
  try { await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id','first',true)"); const result = await action(db); await db.query('COMMIT'); return result; }
  catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
async function reserve(db: PoolClient, p: CostPolicy, quote = bound) {
  const requestId = randomUUID();
  await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,usage_state)
    VALUES('first',$1,'classification',$2,'sent','synthetic-monthly', $3,'not_sent')`, [requestId, 'a'.repeat(64), quote.modelVersion]);
  await reserveCost(db, { userId: 'first', requestId, step: 'classification', anchorAt: p.projectPeriodStart, periodStart: p.projectPeriodStart }, p, quote);
  return requestId;
}
before(async () => { pg = await postgresFixture(); });
after(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.owner.query('TRUNCATE identity.auth_user,commerce.ai_project_budget CASCADE');
  await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES('first','Synthetic','first@example.test',true,now(),now())");
});

test('prior trial spending counts toward the same monthly cap; concurrent reservations cannot overspend and classification consumes zero customer budget', async () => {
  const p = policy();
  const prior = { ...p, projectPeriodStart: new Date(Date.parse(p.projectPeriodStart) + 1000).toISOString(), price: { ...p.price, inputRubPerMillion: '1000', outputRubPerMillion: '1000' } };
  await within(async db => {
    const id = await reserve(db, prior, { ...bound, inputTokens: 97000, outputTokens: 0 });
    await settleCost(db, 'first', id, 'classification', { inputTokens: 97000, outputTokens: 0, modelVersion: bound.modelVersion });
  });
  const attempts = await Promise.allSettled([1, 2].map(() => within(async db => {
    await prepareMonthlyDispatch(db, p); const id = await reserve(db, p); await authorizeMonthlyDispatch(db, p, now()); return id;
  })));
  assert.equal(attempts.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(v => v.status === 'rejected').length, 1);
  const budget = await within(db => monthlyBudgetState(db, p));
  assert.equal(budget.spentAtoms, '97000000000'); assert.equal(budget.warning, 95); assert.ok(BigInt(budget.heldAtoms) > 0n);
  assert.ok(BigInt(budget.spentAtoms) + BigInt(budget.heldAtoms) <= 100000000000n);
  assert.ok((await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows.every(row => row.spent_atoms === '0' && row.reserved_atoms === '0'));
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n, '2');
  const success = attempts.find(v => v.status === 'fulfilled');
  assert.ok(success?.status === 'fulfilled');
  await within(db => settleCost(db, 'first', success.value, 'classification', { inputTokens: 100000, outputTokens: 0, modelVersion: bound.modelVersion }));
  await assert.rejects(within(async db => { await prepareMonthlyDispatch(db, p); await reserve(db, p); await authorizeMonthlyDispatch(db, p, now()); }), /BUDGET_EXHAUSTED/);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n, '2');
});

test('the monthly money authorization permits more than 70 small technical calls without resetting any dispatch count', async () => {
  const p = policy(), small = { ...bound, inputTokens: 1, outputTokens: 0 };
  for (let i = 0; i < 71; i++) await within(async db => {
    await prepareMonthlyDispatch(db, p); const id = await reserve(db, p, small); await authorizeMonthlyDispatch(db, p, now());
    await settleCost(db, 'first', id, 'classification', { ...small });
  });
  assert.equal((await pg.owner.query('SELECT dispatch_count FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2', [p.projectId, p.projectPeriodStart])).rows[0].dispatch_count, 71);
  assert.equal((await within(db => monthlyBudgetState(db, p))).spentAtoms, (71n * 15860n).toString());
});

test('unknown reservations still block after a month boundary; resolving the old receipt leaves history intact and enables a fresh month', async () => {
  const p = policy(), id = await within(async db => { await prepareMonthlyDispatch(db, p); return reserve(db, p); });
  await within(db => settleCost(db, 'first', id, 'classification'));
  const nextDate = new Date(Date.parse(p.projectPeriodEnd) + 1000), next = { ...p, ...monthlyPeriod(nextDate) };
  await assert.rejects(within(db => prepareMonthlyDispatch(db, next)), /RECONCILIATION_REQUIRED/);
  const before = (await pg.owner.query('SELECT request_id,reserved_atoms,price FROM commerce.ai_cost_reservation')).rows;
  await within(db => settleCost(db, 'first', id, 'classification', { inputTokens: 100, outputTokens: 10, modelVersion: bound.modelVersion }));
  await within(db => prepareMonthlyDispatch(db, next));
  assert.equal((await within(db => monthlyBudgetState(db, next))).spentAtoms, '0');
  assert.deepEqual((await pg.owner.query('SELECT request_id,reserved_atoms,price FROM commerce.ai_cost_reservation')).rows, before);
  await assert.rejects(within(db => authorizeMonthlyDispatch(db, p, nextDate)), /PERIOD_CHANGED/);
});

test('a provider contract freeze cannot be bypassed by the next monthly bucket', async () => {
  const p = policy(), id = await within(db => reserve(db, p));
  await within(db => settleCost(db, 'first', id, 'classification', { inputTokens: bound.inputTokens + 1, outputTokens: 1, modelVersion: bound.modelVersion }));
  await assert.rejects(within(db => prepareMonthlyDispatch(db, { ...p, ...monthlyPeriod(new Date(Date.parse(p.projectPeriodEnd) + 1)) })), /RECONCILIATION_REQUIRED/);
});
