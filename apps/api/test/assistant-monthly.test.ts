import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { monthlyPeriod, monthlyPolicy, monthlyTariffGuard } from '../src/assistant-monthly.ts';
import { checkAssistantStagingSettings, assistantTariffSource } from '../src/analyzer-assistant-settings.ts';
import { monthlyClassificationAdmission } from '../src/classification-admission.ts';
import { createStagingAssistantProvider } from '../src/analyzer-assistant-provider.ts';

const at = new Date('2026-11-01T13:34:00Z');
const legacy = () => ({ realm: 'staging/finance' as const, apiKey: 'synthetic-private-key-1234567890', allowedEmails: ['owner@example.test'], sourceSha256: 'a'.repeat(64), modelMetadataSha256: 'b'.repeat(64), maximumCalls: 12,
  admission: { budgetSha256: 'c'.repeat(64), spentAtoms: '1000000000', calls: 58, stageCapAtoms: '10000000000', stageMaximumCalls: 70 },
  expiresAt: '2026-11-02T13:34:00Z', tariffCheckedAt: at.toISOString(), tariffSource: assistantTariffSource,
  cost: { projectId: 'staging/monthly-test', projectPeriodStart: at.toISOString(), projectPeriodEnd: '2026-11-02T13:34:00Z', projectLimitRub: '9', price: { version: 'test', currency: 'RUB' as const, inputRubPerMillion: '15.86', outputRubPerMillion: '61' } } });
const totals = { calls: 3, spentAtoms: '12000000', reservedAtoms: '0', blocked: false };

test('monthly approval preserves every historical permit field and requires a single authorized Staging account', () => {
  const old = legacy(), before = structuredClone(old), next = monthlyClassificationAdmission(old, totals, 'd'.repeat(64), at);
  assert.deepEqual(old, before);
  const { monthly, ...rest } = next;
  assert.deepEqual(rest, { ...old, sourceSha256: 'd'.repeat(64) });
  assert.deepEqual(monthly, { version: 'cashneuro-staging-monthly/1', limitRub: '100', activatedAt: at.toISOString() });
  assert.equal(checkAssistantStagingSettings(next, new Date('2027-02-01T00:00:00Z')).monthly?.limitRub, '100');
  assert.throws(() => checkAssistantStagingSettings(old, new Date('2027-02-01T00:00:00Z')));
  for (const change of [{ realm: 'production/finance' }, { allowedEmails: ['owner@example.test', 'other@example.test'] }, { monthly: { ...monthly, limitRub: '101' } }, { monthly: { ...monthly, activatedAt: '2030-01-01T00:00:00Z' } }, { endpoint: 'https://untrusted.test' }]) {
    assert.throws(() => checkAssistantStagingSettings({ ...next, ...change }, at));
  }
  assert.throws(() => monthlyClassificationAdmission(old, { ...totals, reservedAtoms: '1' }, 'd'.repeat(64), at), /RECONCILIATION/);
  assert.throws(() => monthlyClassificationAdmission(old, { ...totals, blocked: true }, 'd'.repeat(64), at), /RECONCILIATION/);
  assert.deepEqual(monthlyClassificationAdmission(next, totals, 'e'.repeat(64), new Date('2026-12-01T00:00:00Z')).monthly, monthly);
});

test('operating periods change exactly at Moscow midnight including December and leap February', () => {
  assert.deepEqual(monthlyPeriod(new Date('2026-11-30T20:59:59.999Z')), { projectPeriodStart: '2026-10-31T21:00:00.000Z', projectPeriodEnd: '2026-11-30T21:00:00.000Z' });
  assert.deepEqual(monthlyPeriod(new Date('2026-11-30T21:00:00Z')), { projectPeriodStart: '2026-11-30T21:00:00.000Z', projectPeriodEnd: '2026-12-31T21:00:00.000Z' });
  assert.deepEqual(monthlyPeriod(new Date('2026-12-31T21:00:00Z')), { projectPeriodStart: '2026-12-31T21:00:00.000Z', projectPeriodEnd: '2027-01-31T21:00:00.000Z' });
  assert.equal(monthlyPeriod(new Date('2028-02-29T20:59:59Z')).projectPeriodEnd, '2028-02-29T21:00:00.000Z');
  const settings = monthlyClassificationAdmission(legacy(), totals, 'd'.repeat(64), at);
  assert.equal(monthlyPolicy(settings.cost, settings.monthly!, at).projectLimitRub, '100');
  assert.equal(settings.cost.projectLimitRub, '9');
});

test('tariff freshness refreshes automatically once for concurrent calls, retains failures and retries a GET only', async () => {
  let now = at, checks = 0, fail = false;
  const guard = monthlyTariffGuard(at.toISOString(), async () => { checks++; if (fail) throw Error('TARIFF_CHANGED'); return { checkedAt: now.toISOString() }; }, () => now);
  await guard(); assert.equal(checks, 0);
  now = new Date(at.getTime() + 86400000);
  await Promise.all([guard(), guard(), guard()]); assert.equal(checks, 1);
  await guard(); assert.equal(checks, 1);
  now = new Date(now.getTime() + 86400000); fail = true;
  await assert.rejects(guard(), /TARIFF_CHANGED/); assert.equal(checks, 2);
  fail = false; await guard(); assert.equal(checks, 3);
});

test('monthly provider drops trial call/expiry guards, rolls periods without restart and rejects an unverifiable tariff before a model POST', async () => {
  const metadata = { id: 'openai/gpt-oss-120b', context_length: 131072, max_model_len: 131072 };
  const old = legacy(); old.modelMetadataSha256 = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  const settings = monthlyClassificationAdmission(old, totals, 'd'.repeat(64), at);
  let now = at, posts = 0, gets = 0;
  const pool = { async query(sql: string) { return { rows: sql.includes('current_user') ? [{ role: 'finance_api', name: 'finance_staging' }] : [] }; } } as unknown as Pool;
  const fetcher: typeof fetch = async (url, options) => {
    if (options?.method !== 'GET') { posts++; throw Error('NO_PAID_CALLS'); }
    gets++;
    return String(url).endsWith('/models') ? new Response(JSON.stringify({ data: [metadata] })) : new Response('invalid tariff');
  };
  const provider = await createStagingAssistantProvider(pool, settings, fetcher, 'd'.repeat(64), () => now);
  assert.equal((provider.binding as any).maximumCalls, undefined);
  assert.equal((provider.binding as any).expiresAt, undefined);
  assert.equal(provider.policy.projectLimitRub, '100');
  now = new Date('2026-12-01T00:00:00Z');
  assert.equal(provider.policy.projectPeriodStart, '2026-11-30T21:00:00.000Z');
  let reserved = false;
  await assert.rejects(provider.forRequest().complete({ phase: 'understand', prompt: 'Synthetic', input: {}, schema: {} }, async () => { reserved = true; }), /TARIFF_DOCUMENT_CHANGED/);
  assert.equal(posts, 0); assert.equal(gets, 2); assert.equal(reserved, false);
});
