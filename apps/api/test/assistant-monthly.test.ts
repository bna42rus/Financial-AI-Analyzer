import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { monthlyPeriod, monthlyPolicy, monthlyTariffGuard, prepareMonthlyDispatch } from '../src/assistant-monthly.ts';
import { checkAssistantStagingSettings, assistantTariffSource } from '../src/analyzer-assistant-settings.ts';
import { monthlyClassificationAdmission } from '../src/classification-admission.ts';
import { createStagingAssistantProvider,AssistantModelAdmissionError } from '../src/analyzer-assistant-provider.ts';
import {tokenCost} from '../../../packages/analyzer/src/cost.ts';

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

test('an existing monthly authorization can update code with an outstanding receipt or freeze while paid dispatch still refuses', async () => {
  const original = monthlyClassificationAdmission(legacy(), totals, 'd'.repeat(64), at), before = structuredClone(original);
  for (const blocked of [false, true]) {
    const held = { ...totals, reservedAtoms: '2328657920', blocked };
    const next = monthlyClassificationAdmission(original, held, 'e'.repeat(64), at);
    assert.deepEqual(next, { ...original, sourceSha256: 'e'.repeat(64) });
    assert.deepEqual(original, before);
    const queries: string[] = [];
    const db = { async query(sql: string) { queries.push(sql); return { rowCount: sql.includes('ai_project_budget') ? Number(blocked) : sql.includes('ai_cost_reservation') ? 1 : 0 }; } } as unknown as PoolClient;
    await assert.rejects(prepareMonthlyDispatch(db, monthlyPolicy(next.cost, next.monthly!, at)), /RECONCILIATION_REQUIRED/);
    assert.ok(queries.every(sql => sql.startsWith('SELECT ')));
  }
  assert.throws(() => monthlyClassificationAdmission(original, { ...totals, calls: -1 }, 'e'.repeat(64), at), /ACCOUNTING_INVALID/);
  assert.throws(() => monthlyClassificationAdmission(original, { ...totals, reservedAtoms: '-1' }, 'e'.repeat(64), at), /ACCOUNTING_INVALID/);
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

test('monthly provider rolls periods without expiry or tariff network dependencies', async () => {
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
  assert.equal(provider.costPeriod, 'project');
  assert.equal(provider.policy.projectLimitRub, '100');
  now = new Date('2026-12-01T00:00:00Z');
  assert.equal(provider.policy.projectPeriodStart, '2026-11-30T21:00:00.000Z');
  let reserved = false;
  await assert.rejects(provider.forRequest().complete({ phase: 'understand', prompt: 'Synthetic', input: {}, schema: {} }, async () => { reserved = true; }), /BENCH_DELIVERY_UNKNOWN/);
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(reserved, true);
});

test('monthly assistant and classification use configured prices and never fetch the tariff',async()=>{
 const metadata={id:'openai/gpt-oss-120b',context_length:131072,max_model_len:131072};
 const old=legacy();old.modelMetadataSha256=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
 const settings=monthlyClassificationAdmission(old,totals,'d'.repeat(64),at),before=structuredClone(settings);
 const pool={async query(sql:string){return {rows:sql.includes('current_user')?[{role:'finance_api',name:'finance_staging'}]:[]};}} as unknown as Pool;
 let posts=0,tariffGets=0;
 const fetcher:typeof fetch=async(url)=>{
  if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[metadata]}));
  if(String(url)===assistantTariffSource){tariffGets++;throw Error('PDF_MUST_NOT_BE_FETCHED');}
  posts++;return new Response(JSON.stringify({model:metadata.id,choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}',tool_calls:[]}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));
 };
 let clock=at;const provider=await createStagingAssistantProvider(pool,settings,fetcher,'d'.repeat(64),()=>clock);
 const send=(purpose:'assistant'|'classification')=>provider.forRequest(purpose).complete({phase:'understand',prompt:'Synthetic',input:{},schema:{},...(purpose==='classification'?{protocol:'cashneuro-category-classification/4' as const}:{})},async()=>{assert.deepEqual(provider.policy.price,old.cost.price);assert.equal(provider.policy.projectLimitRub,'100');});
 await send('assistant');clock=new Date('2026-12-15T12:00:00Z');await send('assistant');await send('classification');
 assert.equal(posts,3);assert.equal(tariffGets,0);assert.deepEqual(settings,before);
 assert.equal(tokenCost(provider.policy.price,1_000_000,0),15_860_000_000n);
});
test('monthly model admission uses the fixed model and operational limits instead of an unversioned card fingerprint',async()=>{
 const original={id:'openai/gpt-oss-120b',owned_by:'old',context_length:131072,max_model_len:131072};
 const old=legacy();old.modelMetadataSha256=createHash('sha256').update(JSON.stringify(original)).digest('hex');
 const settings=monthlyClassificationAdmission(old,totals,'d'.repeat(64),at),before=structuredClone(settings);let gets=0,posts=0;
 const pool={async query(sql:string){assert.ok(sql.startsWith('SELECT '));return {rows:sql.includes('current_user')?[{role:'finance_api',name:'finance_staging'}]:[]};}} as unknown as Pool;
 const fetcher:typeof fetch=async(_url,options)=>{if(options?.method!=='GET'){posts++;throw Error('NO_PAID_CALL');}gets++;return new Response(JSON.stringify({data:[{max_model_len:131072,context_length:131072,id:original.id,owned_by:'new',created:1795840000,description:settings.apiKey}]}));};
 const p=await createStagingAssistantProvider(pool,settings,fetcher,'d'.repeat(64),()=>at),diagnostic=(p.binding as any).modelAdmission;
 assert.equal(diagnostic.hashMatches,false);assert.equal(diagnostic.limitsMatch,true);assert.equal(diagnostic.immutableModelVersionVerified,false);assert.equal(p.policy.projectLimitRub,'100');assert.equal(gets,1);assert.equal(posts,0);assert.deepEqual(settings,before);assert.ok(!JSON.stringify(diagnostic).includes(settings.apiKey));
 await assert.rejects(createStagingAssistantProvider(pool,old,fetcher,old.sourceSha256,()=>at),/ASSISTANT_MODEL_CHANGED/);assert.equal(posts,0);
});
test('model admission still refuses changed identity, context, versioned pins and invalid input/output bounds without a paid call',async()=>{
 const original={id:'openai/gpt-oss-120b',context_length:131072,max_model_len:131072},old=legacy();old.modelMetadataSha256=createHash('sha256').update(JSON.stringify(original)).digest('hex');
 const settings=monthlyClassificationAdmission(old,totals,'d'.repeat(64),at),pool={async query(sql:string){assert.ok(sql.startsWith('SELECT '));return {rows:sql.includes('current_user')?[{role:'finance_api',name:'finance_staging'}]:[]};}} as unknown as Pool;
 for(const change of [{id:'other-model'},{context_length:65536},{max_model_len:65536},{version:'new'},{revision:'new'},{snapshot:'new'},{max_input_tokens:4096},{max_output_tokens:1200},{max_output_tokens:'4096'}]){
  let posts=0;const fetcher:typeof fetch=async(_url,options)=>{if(options?.method!=='GET'){posts++;throw Error('NO_PAID_CALL');}return new Response(JSON.stringify({data:[{...original,...change,description:settings.apiKey}]}));};
  await assert.rejects(createStagingAssistantProvider(pool,settings,fetcher,'d'.repeat(64),()=>at),error=>{assert.ok(!String(error).includes(settings.apiKey));if(error instanceof AssistantModelAdmissionError)assert.ok(!JSON.stringify(error.diagnostic).includes(settings.apiKey));return true;});assert.equal(posts,0);
 }
});


test('Staging-wide admission sees another account reserve through shared project totals without reading private receipts',async()=>{
 const policy=monthlyPolicy(legacy().cost,{version:'cashneuro-staging-monthly/1',limitRub:'100',activatedAt:at.toISOString()},at),queries:string[]=[];
 const db={async query(sql:string){queries.push(sql);return {rows:[],rowCount:sql.includes('ai_project_budget')&&sql.includes('reserved_atoms>0')?1:0};}} as unknown as PoolClient;
 await assert.rejects(prepareMonthlyDispatch(db,policy),/RECONCILIATION_REQUIRED/);assert.ok(queries.some(sql=>sql.includes('reserved_atoms>0')));assert.ok(!queries.some(sql=>sql.includes('UPDATE')||sql.includes('DELETE')));
});
