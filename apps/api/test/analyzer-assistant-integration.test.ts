import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { syntheticOperations } from './operations-fixture.ts';
import { createServer } from '../src/server.ts';
import type { Config } from '../src/types.ts';
import { token, hashPassword } from '../src/crypto.ts';
import { prepareFinance, financeView, acceptAccount, importEpoch } from '../src/finance.ts';
import { createTestAssistantProvider } from '../src/analyzer-assistant-provider.ts';
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
  pg = await postgresFixture();
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

test('off-topic and general explanations store history without reading the financial catalog or consuming a task unit', async () => {
  const b = await body(); outputs = [{ version: assistantVersion, topic: 'unrelated', action: 'redirect' }];
  const off = await run({ ...b, text: 'Почему белка рыжая?' }); assert.equal(off.statusCode, 200, off.body); assert.equal(off.json().answer.mode, 'redirect');
  outputs = [{ version: assistantVersion, topic: 'general_finance', action: 'explain' }, { text: 'Инфляция уменьшает покупательную способность денег.' }];
  const explained = await run({ ...b, id: randomUUID(), text: 'Объясни инфляцию.' }); assert.equal(explained.statusCode, 200, explained.body); assert.equal(explained.json().answer.mode, 'ai'); assert.equal(calls, 3);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '0');
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
