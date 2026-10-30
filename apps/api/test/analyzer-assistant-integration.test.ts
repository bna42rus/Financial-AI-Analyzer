import {reserveCost} from '../src/analyzer-cost.ts';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { syntheticOperations } from './operations-fixture.ts';
import { createServer } from '../src/server.ts';
import type { Config } from '../src/types.ts';
import { token, hashPassword } from '../src/crypto.ts';
import { prepareFinance, financeView, acceptAccount, importEpoch } from '../src/finance.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlockKmsKey, kmsRealms } from '../src/kms.ts';
import { assistantTariffSource } from '../src/analyzer-assistant-settings.ts';
import { createTestAssistantProvider, createStagingAssistantProvider } from '../src/analyzer-assistant-provider.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { parseConversation } from '../../../packages/analyzer/src/assistant-conversation.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>, server: Awaited<ReturnType<typeof createServer>>, config: Config;
let cookie: string, generation: string, account: string, operationIds: string[], calls = 0, outputs: unknown[], outgoing: any[], behavior = 'normal';
let activePlan: any;
let onDispatch: (() => Promise<void>) | undefined;
const password = 'Synthetic Assistant password 123!';
const set = (field: string, value: unknown) => ({ field, op: 'set', value });
const plan = (changes: unknown[], mode = 'new') => ({ version: assistantVersion, topic: 'personal_finance', action: 'read', context: { mode }, changes });
const fetcher: typeof fetch = async (_url, options) => {
  const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
  outgoing.push(input); calls++;
  // Observe a committed reservation from an independent DB connection BEFORE
  // simulating the HTTP response. No workspace transaction can be held here.
  const reserved = (await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n;
  assert.equal(Number(reserved), 1);
  await onDispatch?.();
  if (behavior === 'timeout') throw Error('synthetic-timeout');
  let value: any;
  if (input.candidate) {
    const next: any = outputs[0];
    if (next?.plan) value = outputs.shift();
    else value = { plan: activePlan, conditions: [] };
  } else {
    value = outputs.shift();
    if (value?.version) activePlan = value;
  }
  return new Response(JSON.stringify({ model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', tool_calls: [], content: behavior === 'invalid-json' ? '{broken' : JSON.stringify(value) } }] }));
};
function provider() { return createTestAssistantProvider(pg.finance, fetcher, { projectId: 'test/assistant-integration', projectPeriodStart: '2020-01-01T00:00:00Z', projectPeriodEnd: '2100-01-01T00:00:00Z', projectLimitRub: '45' }); }
before(async () => {
  pg = await postgresFixture({ name: 'finance_staging' });
  config = { profile: 'finance', pool: pg.finance, baseURL: 'https://api.example.test', origin: 'https://app.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test', assistantProvider: provider() };
  server = await createServer(config);
});
after(async () => { await server?.close(); await pg?.close(); });
async function within<T>(action: (db: PoolClient) => Promise<T>, user = 'first') {
  const db = await pg.finance.connect();
  try { await db.query('BEGIN'); await prepareFinance(db, user); const result = await action(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
const request = (path: string, payload: unknown = {}, target = server) => target.fastify.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: { origin: config.origin, cookie, 'content-type': 'application/json' } });
beforeEach(async () => {
  calls = 0; outputs = []; outgoing = []; behavior = 'normal'; onDispatch = undefined; activePlan = undefined;
  await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,finance.workspace,commerce.access_cycle,commerce.ai_project_budget CASCADE');
  for (const user of ['first', 'second']) {
    await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())", [user, user + '@example.test']);
    await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)', [user]);
    await within(async () => {}, user);
  }
  await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES('first-account','first','first','credential',$1,now(),now())", [await hashPassword(password)]);
  const login = await server.fastify.inject({ method: 'POST', url: '/auth/sign-in/email', payload: { email: 'first@example.test', password }, headers: { origin: config.origin, 'content-type': 'application/json' } });
  assert.equal(login.statusCode, 200, login.body); cookie = login.cookies.map(c => c.name + '=' + c.value).join('; ');
  account = randomUUID();
  await within(async db => {
    const state = await financeView(db, 'first'); generation = state.generation;
    await acceptAccount(db, 'first', importEpoch(state), { id: account, bankId: 'tbank', systemName: 'Synthetic assistant account', type: 'bank_account' });
    operationIds = await syntheticOperations(db, 'first', 2, account, state.categories.find(c => c.name === 'Продукты' && c.parentId === null)!.id);
  });
  await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES('first',date_trunc('milliseconds',clock_timestamp()-interval '1 day')+interval '456 microseconds','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":20}')");
  assert.equal((await request('/finance/assistant-profile', { timezone: 'Asia/Vladivostok' })).statusCode, 200);
});
async function body() {
  const created = await request('/finance/analyzer-chat', { id: randomUUID(), create: true }); assert.equal(created.statusCode, 200, created.body);
  const context = await request('/finance/analyzer-context', { generation }); assert.equal(context.statusCode, 200, context.body);
  return { id: randomUUID(), chatId: created.json().id as string, chatEpoch: created.json().chatEpoch as string, generation, globalRevision: context.json().revision as number, text: 'Сумма расходов' };
}
const run = (b: Awaited<ReturnType<typeof body>>, target = server) => request('/finance/analyzer-task', b, target);

test('HTTP route uses the current DB, persists context/usage and replays after server restart without a new POST', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses'), set('amount', { basis: 'absolute_operation', expression: 'от 100 до 200 рублей' })])];
  const first = await run(b); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().answer.result.totals.expenses, '24690'); assert.equal(calls, 2);
  const next = { ...b, id: randomUUID(), text: 'А по категориям?' }; outputs = [plan([set('grouping', 'category_totals')], 'continue')];
  const follow = await run(next); assert.equal(follow.statusCode, 200, follow.body); assert.equal(follow.json().answer.query.filter.amountFrom, '10000'); assert.equal(follow.json().answer.query.grouping, 'category'); assert.equal(calls, 4);
  const stored = (await pg.owner.query('SELECT conversation FROM finance.assistant_conversation')).rows[0].conversation;
  parseConversation(stored, stored.book.scope); assert.equal(stored.book.nodes[1].parent, b.id);
  assert.equal(Number((await pg.owner.query('SELECT sum(units) AS n FROM commerce.analyzer_usage')).rows[0].n), 2);
  const restarted = await createServer({ ...config, assistantProvider: provider() });
  try { const replay = await run(next, restarted); assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), follow.json()); assert.equal(calls, 4); } finally { await restarted.close(); }
  for (const input of outgoing) { const text = JSON.stringify(input); assert.equal(text.includes(account), false); assert.equal(text.includes('first@example.test'), false); }
  const cost = (await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows[0]; assert.ok(BigInt(cost.spent_atoms) > 0n); assert.equal(cost.reserved_atoms, '0');
});

test('profile timezone has no Moscow fallback and an invalid or missing profile cannot dispatch', async () => {
  assert.equal((await request('/finance/assistant-profile', { timezone: 'Invalid/Zone' })).statusCode >= 400, true);
  const profile = await request('/finance/assistant-profile'); assert.equal(profile.json().timezone, 'Asia/Vladivostok');
  const b = await body(); await pg.owner.query("DELETE FROM finance.assistant_profile WHERE user_id='first'");
  const missing = await run(b); assert.equal(missing.statusCode, 409, missing.body); assert.equal(calls, 0);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_task_request')).rows[0].n, '0');
});

test('off-topic is free, ordinary AI explanation consumes one unit and neither reads the financial catalog', async () => {
  const b = await body(); outputs = [{ version: assistantVersion, topic: 'unrelated', action: 'redirect' }];
  const off = await run({ ...b, text: 'Почему белка рыжая?' }); assert.equal(off.statusCode, 200, off.body); assert.equal(off.json().answer.mode, 'redirect');assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n,'0');
  outputs = [{ version: assistantVersion, topic: 'general_finance', action: 'explain' }, { text: 'Инфляция уменьшает покупательную способность денег.' }];
  const explained = await run({ ...b, id: randomUUID(), text: 'Объясни инфляцию.' }); assert.equal(explained.statusCode, 200, explained.body); assert.equal(explained.json().answer.mode, 'ai'); assert.equal(calls, 3);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '1');
  assert.equal((await pg.owner.query('SELECT conversation FROM finance.assistant_conversation')).rows[0].conversation.turns.length, 2);
  for (const input of outgoing) assert.equal('catalog' in input, false);
});

test('unknown delivery retains cost hold, produces no task unit and blocks another paid request', async () => {
  const b = await body(); behavior = 'timeout';
  const failed = await run(b); assert.equal(failed.statusCode, 200, failed.body); assert.equal(failed.json().code, 'ASSISTANT_DELIVERY_UNKNOWN'); assert.equal(calls, 1);
  behavior = 'normal'; outputs = [plan([set('metric', 'expenses')])];
  const again = await run(b); assert.equal(again.statusCode, 200, again.body); assert.equal(calls, 1);
  const next = await run({ ...b, id: randomUUID() }); assert.equal(next.statusCode, 200, next.body); assert.equal(calls, 1);
  const hold = (await pg.owner.query('SELECT state,reserved_atoms FROM commerce.ai_cost_reservation')).rows[0]; assert.equal(hold.state, 'unknown'); assert.ok(BigInt(hold.reserved_atoms) > 0n);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '0');
});

test('a changed body, foreign chat and stale UI revision fail before any new model dispatch', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])];
  assert.equal((await run(b)).statusCode, 200); assert.equal(calls, 2);
  const changed = await run({ ...b, text: 'Доходы' }); assert.equal(changed.statusCode, 409, changed.body);
  const foreign = await run({ ...b, id: randomUUID(), chatId: randomUUID() }); assert.equal(foreign.statusCode, 409, foreign.body);
  const stale = await run({ ...b, id: randomUUID(), globalRevision: 999 }); assert.equal(stale.statusCode, 409, stale.body); assert.equal(calls, 2);
});

test('chat deletion during HTTP settles actual cost, removes private state and never resurrects a reply', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])];
  onDispatch = async () => { onDispatch = undefined; const removed = await request('/finance/analyzer-chat', { id: b.chatId, delete: true }); assert.equal(removed.statusCode, 200, removed.body); };
  const reply = await run(b); assert.equal(reply.statusCode, 409, reply.body); assert.equal(calls, 1);
  for (const table of ['assistant_run', 'assistant_conversation', 'analyzer_task_request', 'analyzer_message']) assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.' + table)).rows[0].n, '0');
  assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state, 'settled');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_request')).rows[0].n, '1');
  assert.equal((await pg.owner.query('SELECT state FROM commerce.analyzer_request')).rows[0].state, 'completed');
});

test('an access revocation during HTTP prevents another call and any financial result while preserving actual cost', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])];
  onDispatch = async () => { onDispatch = undefined; await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'"); };
  const reply = await run(b); assert.equal(reply.statusCode, 403, reply.body); assert.equal(calls, 1);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n, '0');
  assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state, 'settled');
});

test('RLS hides assistant history and receipts from another owner and denies the control role', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])]; assert.equal((await run(b)).statusCode, 200);
  await within(async db => { for (const table of ['assistant_profile', 'assistant_conversation', 'assistant_run']) assert.equal((await db.query('SELECT count(*) AS n FROM finance.' + table)).rows[0].n, '0'); }, 'second');
  await assert.rejects(pg.control.query('SELECT * FROM finance.assistant_run'), /permission denied/);
});

test('a profile or UI change during HTTP invalidates the calculation without discarding the last successful task', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])]; assert.equal((await run(b)).statusCode, 200);
  const before = (await pg.owner.query('SELECT conversation FROM finance.assistant_conversation')).rows[0].conversation;
  outputs = [plan([set('grouping', 'category_totals')], 'continue')];
  onDispatch = async () => { onDispatch = undefined; assert.equal((await request('/finance/assistant-profile', { timezone: 'America/Los_Angeles' })).statusCode, 200); };
  const failed = await run({ ...b, id: randomUUID(), text: 'А по категориям?' }); assert.equal(failed.statusCode, 409, failed.body);
  assert.deepEqual((await pg.owner.query('SELECT conversation FROM finance.assistant_conversation')).rows[0].conversation, before);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '1');
});

test('simultaneous duplicate and same-chat requests cannot dispatch twice or overwrite the first reply', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])];
  let unblock!: () => void, signal!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  const dispatched = new Promise<void>(resolve => { signal = resolve; });
  onDispatch = async () => { onDispatch = undefined; signal(); await barrier; };
  const first = run(b).then(r => r);
  try {
    await dispatched;
    const duplicate = await run(b); assert.equal(duplicate.statusCode, 409, duplicate.body);
    const sameChat = await run({ ...b, id: randomUUID() }); assert.equal(sameChat.statusCode, 409, sameChat.body);
    assert.equal(calls, 1);
  } finally { unblock(); }
  const reply = await first; assert.equal(reply.statusCode, 200, reply.body); assert.equal(calls, 2);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n, '1');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '1');
});

test('today is resolved in each saved profile timezone, without converting date-only bank facts', async () => {
  const b = await body();
  for (const timezone of ['Asia/Vladivostok', 'America/Los_Angeles']) {
    assert.equal((await request('/finance/assistant-profile', { timezone })).statusCode, 200);
    outputs = [plan([set('metric', 'expenses'), set('period', 'сегодня')])];
    const reply = await run({ ...b, id: randomUUID(), text: 'Расходы сегодня' }); assert.equal(reply.statusCode, 200, reply.body);
    const input = outgoing.at(-2), day = input.calendar.currentDate;
    assert.equal(input.calendar.timezone, timezone);
    assert.equal(reply.json().answer.query.filter.from, day); assert.equal(reply.json().answer.query.filter.through, day);
  }
  const dates = (await pg.owner.query('SELECT DISTINCT operation_date FROM finance.source_observation')).rows;
  assert.deepEqual(dates, [{ operation_date: { precision: 'day', date: '2026-09-02' } }]);
});

test('a follow-up recalculates current user corrections while the old answer remains a historical snapshot', async () => {
  const b = await body(); outputs = [plan([set('metric', 'expenses')])];
  const original = await run(b); assert.equal(original.statusCode, 200, original.body); assert.equal(original.json().answer.result.totals.expenses, '24690');
  await within(async db => {
    await db.query(`UPDATE finance.transaction SET semantics=jsonb_set(semantics,'{role}','{"value":"neutral","source":"user","confidence":100,"userVerified":true}'::jsonb) WHERE user_id='first' AND id=ANY($1::uuid[])`, [operationIds]);
    await db.query("UPDATE finance.workspace SET revision=revision+1 WHERE user_id='first'");
  });
  outputs = [plan([set('grouping', 'category_totals')], 'continue')];
  const updated = await run({ ...b, id: randomUUID(), text: 'А по категориям?' }); assert.equal(updated.statusCode, 200, updated.body); assert.equal(updated.json().answer.result.totals.expenses, '0');
  const old = (await pg.owner.query('SELECT answer FROM finance.analyzer_message WHERE id=$1', [b.id])).rows[0].answer;
  assert.equal(old.result.totals.expenses, '24690');
});

test('one structural repair is accounted and cannot execute model-generated SQL or exceed three calls', async () => {
  const b = await body(), valid = plan([set('metric', 'expenses')]);
  outputs = [{ ...valid, sql: 'DROP TABLE finance.transaction' }, valid];
  const reply = await run(b); assert.equal(reply.statusCode, 200, reply.body); assert.equal(reply.json().code, 'FINANCIAL_QUERY'); assert.equal(calls, 3);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.transaction')).rows[0].n, '2');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n, '3');
});

test('two different chats racing for the last task unit cannot overbook the quota', async () => {
  await pg.owner.query(`UPDATE commerce.access_cycle SET quota_policy='{"source":"override","limit":1}' WHERE user_id='first'`);
  const first = await body(), second = await body(); outputs = [plan([set('metric', 'expenses')])];
  const replies = await Promise.all([run(first), run(second)]);
  assert.equal(replies.filter(r => r.statusCode === 200 && r.json().code === 'FINANCIAL_QUERY').length, 1);
  assert.equal(calls, 2);
  assert.equal((await pg.owner.query('SELECT sum(units) AS n FROM commerce.analyzer_usage')).rows[0].n, '1');
});

test('browser initialization cannot overwrite a timezone chosen on another device', async () => {
  const initial = await request('/finance/assistant-profile', { timezone: 'America/Los_Angeles', initialize: true });
  assert.equal(initial.statusCode, 200, initial.body); assert.equal(initial.json().timezone, 'Asia/Vladivostok');
  const changed = await request('/finance/assistant-profile', { timezone: 'America/Los_Angeles' });
  assert.equal(changed.json().timezone, 'America/Los_Angeles');
  assert.equal(calls, 0);
});

test('a one-connection pool can complete a request without waiting for a second connection', { timeout: 15000 }, async () => {
  const b = await body(), pool = new Pool({ ...pg.finance.options, max: 1 });
  const smallProvider = createTestAssistantProvider(pool, fetcher, { projectId: 'test/assistant-small-pool', projectPeriodStart: '2020-01-01T00:00:00Z', projectPeriodEnd: '2100-01-01T00:00:00Z', projectLimitRub: '45' });
  const target = await createServer({ ...config, pool, assistantProvider: smallProvider });
  try {
    outputs = [plan([set('metric', 'expenses')])];
    const reply = await run(b, target); assert.equal(reply.statusCode, 200, reply.body); assert.equal(reply.json().code, 'FINANCIAL_QUERY'); assert.equal(calls, 2);
    assert.equal(pool.totalCount, 1);
  } finally { await target.close(); await pool.end(); }
});


async function stagingConfig(t: any, maximumCalls = 2, allowedEmails = ['first@example.test'], clock = () => new Date()) {
  const at = clock(), metadata = { id: 'openai/gpt-oss-120b', context_length: 131072, max_model_len: 131072 };
  const raw = { realm:'staging/finance',apiKey:'synthetic-staging-key-for-tests-only',allowedEmails,
    sourceSha256:'a'.repeat(64),modelMetadataSha256:createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),maximumCalls,
    admission:{budgetSha256:'b'.repeat(64),spentAtoms:'0',calls:60-maximumCalls,stageCapAtoms:'10000000000',stageMaximumCalls:60},
    tariffCheckedAt:new Date(at.getTime()-1000).toISOString(),tariffSource:assistantTariffSource,expiresAt:new Date(at.getTime()+3600000).toISOString(),
    cost:{projectId:'test/assistant-staging',projectPeriodStart:new Date(at.getTime()-1000).toISOString(),projectPeriodEnd:new Date(at.getTime()+3600000).toISOString(),projectLimitRub:'10',
      price:{version:'test-staging',currency:'RUB',inputRubPerMillion:'15.86',outputRubPerMillion:'61'}},
  };
  const provider = await createStagingAssistantProvider(pg.finance,raw,async (url,options) => String(url).endsWith('/models') ? new Response(JSON.stringify({data:[metadata]})) : fetcher(url,options),raw.sourceSha256,clock);
  assert.equal(JSON.stringify(provider.binding).includes(raw.apiKey),false); assert.equal(JSON.stringify(provider.binding).includes(allowedEmails[0]!),false);
  const dir=await mkdtemp(join(tmpdir(),'assistant-staging-kms-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const realm='staging/finance',rsa=generateKeyPairSync('rsa',{modulusLength:2048}),auth=join(dir,'auth.json'),wrapped=join(dir,'wrapped.json');
  await writeFile(auth,JSON.stringify({id:'synthetic',service_account_id:kmsRealms[realm].accountId,private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'})}),{mode:0o600});
  await writeFile(wrapped,JSON.stringify({v:1,realm,keyId:kmsRealms[realm].keyId,versionId:'synthetic-version',ciphertext:'YQ=='}),{mode:0o600});
  t.mock.method(globalThis,'fetch',async(url: string)=>new Response(JSON.stringify(url.includes('/iam/')?{iamToken:'synthetic-token',expiresAt:new Date(Date.now()+3600000).toISOString()}:{keyId:kmsRealms[realm].keyId,versionId:'synthetic-version',plaintext:config.wrappingKey.toString('base64')})));
  const key=await unlockKmsKey(realm,auth,wrapped);t.after(()=>key.destroy());
  return { config:{...config,environment:'staging' as const,baseURL:'https://test.cashneuro.ru',origin:'https://test.cashneuro.ru',assistantProvider:provider,wrappingKey:key.bytes,kmsKey:key},raw };
}
const stageRun = (target: Awaited<ReturnType<typeof createServer>>, b: Awaited<ReturnType<typeof body>>) => target.fastify.inject({method:'POST',url:'/finance/analyzer-task',payload:b,headers:{origin:'https://test.cashneuro.ru',cookie,'content-type':'application/json'}});

test('the real Staging configuration uses KMS, preserves prior call admission and enforces the shared pilot ceiling', async t => {
  const b=await body(),staging=await stagingConfig(t),target=await createServer(staging.config);
  try {
    outputs=[plan([set('metric','expenses')])];
    const first=await stageRun(target,b);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().code,'FINANCIAL_QUERY');assert.equal(calls,2);
    const next=await stageRun(target,{...b,id:randomUUID()});assert.equal(next.statusCode,200,next.body);assert.equal(next.json().code,'ASSISTANT_PILOT_CALL_LIMIT');assert.equal(calls,2);
    assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n,'2');
    const replay=await stageRun(target,b);assert.equal(replay.statusCode,200,replay.body);assert.equal(calls,2);
  } finally {await target.close();}
});

test('a Staging account outside the explicit allowlist cannot dispatch', async t => {
  const b=await body(),staging=await stagingConfig(t,2,['different@example.test']),target=await createServer(staging.config);
  try {const reply=await stageRun(target,b);assert.equal(reply.statusCode,403,reply.body);assert.equal(calls,0);}finally{await target.close();}
});

test('expired Staging authorization blocks a fresh POST without resetting known cost', async t => {
  let at=new Date();const b=await body(),staging=await stagingConfig(t,4,['first@example.test'],()=>at),target=await createServer(staging.config);
  try {
    outputs=[plan([set('metric','expenses')])];assert.equal((await stageRun(target,b)).statusCode,200);assert.equal(calls,2);
    const before=(await pg.owner.query('SELECT spent_atoms FROM commerce.ai_project_budget')).rows[0].spent_atoms;
    at=new Date(at.getTime()+3600001);
    const reply=await stageRun(target,{...b,id:randomUUID()});assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().code,'ASSISTANT_STAGING_CONFIGURATION_DENIED');assert.equal(calls,2);
    assert.equal((await pg.owner.query('SELECT spent_atoms FROM commerce.ai_project_budget')).rows[0].spent_atoms,before);
  }finally{await target.close();}
});

test('the pilot call ceiling includes another tenant without exposing their private cost receipts',async t=>{
 const b=await body(),staging=await stagingConfig(t,2,['first@example.test','second@example.test']),target=await createServer(staging.config),provider=staging.config.assistantProvider!;
 try{
  outputs=[plan([set('metric','expenses')])];assert.equal((await stageRun(target,b)).statusCode,200);assert.equal(calls,2);
  await assert.rejects(within(async db=>{
   const id=randomUUID(),at=provider.policy.projectPeriodStart;
   await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state) VALUES('second',$1,'classification',$2,'sent','synthetic',$3,$4,$4,'not_sent')`,[id,'c'.repeat(64),provider.model.bound.modelVersion,at]);
   await reserveCost(db,{userId:'second',requestId:id,step:'classification',anchorAt:at,periodStart:at},provider.policy,provider.model.bound);
   await provider.authorizeDispatch(db);
  },'second'),/ASSISTANT_PILOT_CALL_LIMIT/);
  assert.equal((await pg.owner.query('SELECT dispatch_count FROM commerce.ai_project_budget')).rows[0].dispatch_count,2);
  assert.equal((await pg.owner.query("SELECT count(*)::int AS n FROM commerce.ai_cost_reservation WHERE user_id='second'")).rows[0].n,0);
 }finally{await target.close();}
});

test('deterministic calculator returns exact code results, charges once and preserves every financial source',async()=>{
 const b={...await body(),text:'Аннуитет 100 рублей, 12% годовых, один месяц'},before=(await pg.owner.query('SELECT id,source_observation_id,corrections,semantics FROM finance.transaction ORDER BY id')).rows;
 outputs=[{version:assistantVersion,topic:'general_finance',action:'calculate',calculation:{kind:'loan',principalRubles:'100',annualRatePercent:'12',months:1,payment:'annuity'}}];
 const result=await run(b);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().code,'FINANCIAL_CALCULATION');assert.equal(result.json().answer.calculation.totalPaidMinor,'10100');assert.equal(result.json().answer.calculation.interestMinor,'100');assert.equal(calls,1);
 assert.deepEqual((await pg.owner.query('SELECT id,source_observation_id,corrections,semantics FROM finance.transaction ORDER BY id')).rows,before);assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.action')).rows[0].n,'0');assert.equal((await pg.owner.query('SELECT sum(units) AS n FROM commerce.analyzer_usage')).rows[0].n,'1');
 const replay=await run(b);assert.deepEqual(replay.json(),result.json());assert.equal(calls,1);assert.equal((await pg.owner.query('SELECT sum(units) AS n FROM commerce.analyzer_usage')).rows[0].n,'1');
 for(const v of outgoing){const text=JSON.stringify(v);assert.ok(!text.includes(account));assert.ok(!operationIds.some(id=>text.includes(id)));}
});

test('natural account proposal without a query cannot write until exact preview and explicit commit, then supports Undo',async()=>{
 const b={...await body(),text:'Переименуй счёт Synthetic account в Мой основной счёт'},old=(await pg.owner.query('SELECT display_name FROM finance.account WHERE id=$1',[account])).rows[0].display_name;
 outputs=[{version:assistantVersion,topic:'personal_finance',action:'propose_change',change:{kind:'account',name:old,patch:{name:'Мой основной счёт'}}}];
 const result=await run(b);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().code,'CHANGE_PROPOSED');assert.equal(result.json().answer.query,undefined);assert.equal(calls,2);
 const tool={name:'finance_action',answerId:b.id,intent:result.json().answer.proposal.intent};
 assert.equal((await pg.owner.query('SELECT display_name FROM finance.account WHERE id=$1',[account])).rows[0].display_name,old);assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.action')).rows[0].n,'0');
 const forged=await request('/finance/analyzer-propose',{actionId:randomUUID(),tool:{...tool,intent:{...tool.intent,patch:{name:'Подменено клиентом'}}}});assert.equal(forged.statusCode,409,forged.body);assert.equal(forged.json().code,'ANALYZER_PROPOSAL_CHANGED');
 const actionId=randomUUID(),preview=await request('/finance/analyzer-propose',{actionId,tool});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().requiresConfirmation,true);assert.equal((await pg.owner.query('SELECT display_name FROM finance.account WHERE id=$1',[account])).rows[0].display_name,old);
 const committed=await request('/finance/commit',{actionId});assert.equal(committed.statusCode,200,committed.body);assert.equal((await pg.owner.query('SELECT display_name FROM finance.account WHERE id=$1',[account])).rows[0].display_name,'Мой основной счёт');
 assert.deepEqual((await request('/finance/commit',{actionId})).json(),committed.json());
 const w=await within(db=>financeView(db,'first')),undoId=randomUUID();const undo=await request('/finance/preview',{actionId:undoId,generation:w.generation,revision:w.revision,intent:{kind:'undo',id:randomUUID(),value:actionId}});assert.equal(undo.statusCode,200,undo.body);assert.equal((await request('/finance/commit',{actionId:undoId})).statusCode,200);assert.equal((await pg.owner.query('SELECT display_name FROM finance.account WHERE id=$1',[account])).rows[0].display_name,old);
});

test('natural operation changes require a current last-answer scope and freeze exact IDs before preview',async()=>{
 const b=await body(),change={version:assistantVersion,topic:'personal_finance',action:'propose_change',change:{kind:'answer_operations',patch:{comment:'Из проверенного ответа'}}};
 outputs=[change];const missing=await run({...b,text:'Добавь комментарий операциям этого ответа'});assert.equal(missing.json().code,'ASSISTANT_CHANGE_SCOPE_REQUIRED');assert.equal(missing.json().answer.proposal,undefined);
 outputs=[plan([set('metric','expenses')])];const read=await run({...b,id:randomUUID(),text:'Покажи мои расходы'});assert.equal(read.json().code,'FINANCIAL_QUERY');
 const proposalId=randomUUID();outputs=[change];const proposed=await run({...b,id:proposalId,text:'Добавь комментарий операциям этого ответа'});assert.equal(proposed.json().code,'CHANGE_PROPOSED');const p=proposed.json().answer.proposal;assert.deepEqual(new Set(p.intent.operationIds),new Set(operationIds));
 const tool={name:'finance_action',answerId:proposalId,intent:p.intent},actionId=randomUUID();const preview=await request('/finance/analyzer-propose',{actionId,tool});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().requiresConfirmation,true);
 const commit=await request('/finance/commit',{actionId});assert.equal(commit.statusCode,200,commit.body);assert.deepEqual(new Set((await pg.owner.query("SELECT id FROM finance.transaction WHERE comment='Из проверенного ответа'")).rows.map(r=>r.id)),new Set(operationIds));
});
