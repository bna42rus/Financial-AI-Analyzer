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
import { createTestCloudTaskProvider } from '../src/analyzer-task-provider.ts';
import { taskWorkflowBinding } from '../src/analyzer-task-workflow.ts';
import { parseTaskProposalWire, taskCapabilities } from '../../../packages/analyzer/src/task-protocol.ts';
import { emptyTaskBook, parseTaskBook } from '../../../packages/analyzer/src/task-context.ts';
import { analyzerCycle, analyzerQuota } from '../src/analyzer.ts';
import { rubAmount } from '../../../packages/analyzer/src/cost.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>, server: Awaited<ReturnType<typeof createServer>>, config: Config, cookie: string, account: string, generation: string;
let behavior = 'normal', calls = 0, gate = 'financial', outgoing: unknown[] = [];
let operationIds: string[] = [];
const password = 'Synthetic Task password 123!';
const keep = { op: 'keep' };
let proposal: Record<string, unknown>;
const baseProposal = () => ({ status: 'query', binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses', quote: 'расходов' }, grouping: keep, comparison: keep, edits: [] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
let barrier: ReturnType<typeof deferred> | undefined, dispatched: ReturnType<typeof deferred> | undefined;
const fetcher = (async (_url, options) => {
  const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
  outgoing.push(input); calls++;
  if (behavior === 'block') { dispatched!.resolve(); await barrier!.promise; }
  if (behavior === 'timeout') throw new Error('synthetic-network-private-error');
  const value = input.hasFinancialTasks === undefined ? proposal : { relevance: gate };
  return new Response(JSON.stringify({ model: 'openai/gpt-oss-120b',
    ...(behavior === 'missing-usage' ? {} : { usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } }),
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', tool_calls: [], content: JSON.stringify(value) } }] }));
}) as typeof fetch;
const makeProvider = () => createTestCloudTaskProvider(pg.finance, fetcher, { projectId: 'test/task-integration', projectPeriodStart: '2020-01-01T00:00:00Z', projectPeriodEnd: '2100-01-01T00:00:00Z', projectLimitRub: '45' });
before(async () => {
  pg = await postgresFixture();
  config = { profile: 'finance', pool: pg.finance, baseURL: 'https://api.example.test', origin: 'https://app.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test', taskProvider: makeProvider() };
  server = await createServer(config);
});
after(async () => { barrier?.resolve(); await server?.close(); await pg?.close(); });
async function within<T>(fn: (db: PoolClient) => Promise<T>, user = 'first') {
  const db = await pg.finance.connect();
  try { await db.query('BEGIN'); await prepareFinance(db, user); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
async function request(path: string, payload: unknown = {}, target = server) {
  return target.fastify.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: { origin: config.origin, cookie, 'content-type': 'application/json' } });
}
beforeEach(async () => {
  behavior = 'normal'; calls = 0; gate = 'financial'; outgoing = []; proposal = baseProposal(); barrier = undefined; dispatched = undefined;
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
  await within(async db => { const state = await financeView(db, 'first'); generation = state.generation; await acceptAccount(db, 'first', importEpoch(state), { id: account, bankId: 'tbank', systemName: 'Synthetic task account', type: 'bank_account' }); operationIds = await syntheticOperations(db, 'first', 2, account, state.categories.find(c => c.name === 'Продукты' && c.parentId === null)!.id); });
  await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES('first',date_trunc('milliseconds',clock_timestamp()-interval '1 day')+interval '456 microseconds','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":20}')");
});
async function body() {
  const created = await request('/finance/analyzer-chat', { id: randomUUID(), create: true }); assert.equal(created.statusCode, 200, created.body);
  const context = await request('/finance/analyzer-context', { generation }); assert.equal(context.statusCode, 200, context.body);
  return { id: randomUUID(), chatId: created.json().id as string, chatEpoch: created.json().chatEpoch as string, generation, globalRevision: context.json().revision as number, text: 'Сумма расходов' };
}
test('HTTP persists exact core result, opaque owner, task book and exact-microsecond quota across restart; retry is free', async () => {
  const b = await body(), first = await request('/finance/analyzer-task', b); assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().answer.result.totals.expenses, '24690'); assert.equal(first.json().quota.used, 1); assert.equal(calls, 2);
  const saved = (await pg.owner.query('SELECT book FROM finance.analyzer_task_book')).rows[0].book;
  assert.equal(saved.scope.ownerId, 'first'); assert.equal(saved.nodes.length, 1);
  assert.ok(!JSON.stringify(outgoing).includes(account)); assert.ok(!JSON.stringify(outgoing).includes('24690'));
  const restarted = await createServer({ ...config, taskProvider: makeProvider() });
  try { const retry = await request('/finance/analyzer-task', b, restarted); assert.equal(retry.statusCode, 200, retry.body); assert.deepEqual(retry.json(), first.json()); assert.equal(calls, 2); } finally { await restarted.close(); }
  const usage = (await pg.owner.query('SELECT anchor_at::text AS anchor,period_start::text AS period FROM commerce.analyzer_usage')).rows[0];
  const budget = (await pg.owner.query('SELECT anchor_at::text AS anchor,period_start::text AS period,reserved_atoms FROM commerce.ai_user_budget')).rows[0];
  assert.equal(usage.anchor, budget.anchor); assert.equal(usage.period, budget.period); assert.equal(budget.reserved_atoms, '0');
});
test('manual same-value touch, lost update ACK and stale cross-tab revision have distinct outcomes', async () => {
  const b = await body(), change = { id: randomUUID(), revision: 0, filter: { accountIds: [account] }, touched: ['period'] };
  const first = await request('/finance/analyzer-context', { generation, change }); assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().touched.period, 1); assert.equal(first.json().touched.accounts, 1);
  assert.deepEqual((await request('/finance/analyzer-context', { generation, change })).json(), first.json());
  const next = await request('/finance/analyzer-context', { generation, change: { ...change, id: randomUUID(), revision: 1 } }); assert.equal(next.json().touched.period, 2);
  const stale = await request('/finance/analyzer-context', { generation, change }); assert.equal(stale.json().code, 'AI_CONTEXT_CHANGED');
  const query = await request('/finance/analyzer-task', b); assert.equal(query.json().code, 'AI_CONTEXT_CHANGED'); assert.equal(calls, 0);
});
test('unrelated gate touches no catalog/financial graph and stores no task or customer unit', async () => {
  const b = await body(); gate = 'unrelated';
  await pg.owner.query('ALTER TABLE finance.transaction RENAME TO transaction_gate_canary');
  try { const result = await request('/finance/analyzer-task', b); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().answer.mode, 'redirect'); } finally { await pg.owner.query('ALTER TABLE finance.transaction_gate_canary RENAME TO transaction'); }
  assert.equal(calls, 1); assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_task_book')).rows[0].n, '0');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '0');
});
test('cancellation overtaking claim prevents every external call', async () => {
  const b = await body(); await request('/finance/analyzer-task-cancel', { id: b.id, chatId: b.chatId, chatEpoch: b.chatEpoch });
  assert.equal((await request('/finance/analyzer-task', b)).json().code, 'AI_REQUEST_CANCELLED'); assert.equal(calls, 0);
});
test('in-flight cancellation and concurrent retry finish without a DB/network lock, late answer or second call', async () => {
  const b = await body(); behavior = 'block'; barrier = deferred(); dispatched = deferred();
  const running = request('/finance/analyzer-task', b); await dispatched.promise;
  const retry = await request('/finance/analyzer-task', b); assert.equal(retry.statusCode, 409, retry.body); assert.equal(calls, 1);
  const cancel = await request('/finance/analyzer-task-cancel', { id: b.id, chatId: b.chatId, chatEpoch: b.chatEpoch }); assert.equal(cancel.statusCode, 200, cancel.body);
  barrier.resolve(); await running;
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n, '0');
  const receipt = (await pg.owner.query('SELECT usage_state,input_tokens FROM commerce.analyzer_request')).rows[0]; assert.equal(receipt.usage_state, 'reported'); assert.equal(receipt.input_tokens, 500);
  assert.equal((await pg.owner.query('SELECT reserved_atoms FROM commerce.ai_user_budget')).rows[0].reserved_atoms, '0');
});
test('delete and recreate the same chat ID rejects the old epoch and late cache while keeping actual costs', async () => {
  const b = await body(); behavior = 'block'; barrier = deferred(); dispatched = deferred();
  const running = request('/finance/analyzer-task', b); await dispatched.promise;
  assert.equal((await request('/finance/analyzer-chat', { id: b.chatId, delete: true })).statusCode, 200);
  const recreated = await request('/finance/analyzer-chat', { id: b.chatId, create: true }); assert.notEqual(recreated.json().chatEpoch, b.chatEpoch);
  barrier.resolve(); await running;
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_task_cache')).rows[0].n, '0');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n, '0');
  assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state, 'settled');
  assert.equal((await request('/finance/analyzer-task', b)).json().code, 'ACTION_REUSED'); assert.equal(calls, 1);
});
test('missing usage holds the complete quote, blocks retries and new IDs without any zero-cost fiction', async () => {
  const b = await body(); behavior = 'missing-usage';
  const result = await request('/finance/analyzer-task', b); assert.equal(result.statusCode, 409, result.body);
  await request('/finance/analyzer-task', b);
  const other = await body(); const next = await request('/finance/analyzer-task', other); assert.equal(next.json().code, 'AI_COST_RECONCILIATION_REQUIRED'); assert.equal(calls, 1);
  const receipt = (await pg.owner.query('SELECT usage_state,input_tokens,output_tokens FROM commerce.analyzer_request')).rows[0];
  assert.equal(receipt.usage_state, 'unknown'); assert.equal(receipt.input_tokens, null); assert.equal(receipt.output_tokens, null);
  const cost = (await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows[0]; assert.equal(cost.spent_atoms, '0'); assert.ok(BigInt(cost.reserved_atoms) > 0n);
});
test('whole wire validation rejects invalid trailing edits after a missing name; reported usage still settles', async () => {
  const b = await body(); b.text = 'Сумма расходов на неизвестное';
  proposal = { ...baseProposal(), edits: [{ field: 'categories', op: 'set', value: { names: ['неизвестное'] }, quote: 'неизвестное' }, { field: 'arbitrary_sql', op: 'set', value: 'SELECT 1', quote: 'расходов' }] };
  assert.throws(() => parseTaskProposalWire(proposal, b.text));
  const result = await request('/finance/analyzer-task', b); assert.equal(result.json().code, 'AI_PLAN_INVALID'); assert.equal(calls, 2);
  assert.ok((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows.every(r => r.state === 'settled'));
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '0');
});
test('all new private tables enforce RLS and deny Control/mail roles; no configured provider leaves routes closed', async () => {
  await body(); const tables = ['analyzer_globals', 'analyzer_global_change', 'analyzer_task_book', 'analyzer_task_request', 'analyzer_task_cache', 'analyzer_task_cancel'];
  for (const table of tables) {
    for (const pool of [pg.control, pg.mailFinance, pg.mailControl]) await assert.rejects(pool.query(`SELECT * FROM finance.${table}`));
    assert.equal((await within(db => db.query(`SELECT * FROM finance.${table}`), 'second')).rowCount, 0);
  }
  const closed = await createServer({ ...config, taskProvider: undefined });
  try { const result = await request('/finance/analyzer-task', await body(), closed); assert.equal(result.json().code, 'AI_UNAVAILABLE'); } finally { await closed.close(); }
  assert.equal(calls, 0);
});
test('scope can accept opaque auth IDs but rejects a foreign owner or a new chat lifetime', () => {
  const scope = { ownerId: 'auth_user-42', chatId: randomUUID(), chatEpoch: randomUUID(), generation: randomUUID() };
  assert.equal(emptyTaskBook(scope).scope.ownerId, scope.ownerId);
  assert.throws(() => parseTaskBook(emptyTaskBook(scope), { ...scope, ownerId: 'second' }), /TASK_SCOPE_MISMATCH/);
  assert.throws(() => parseTaskBook(emptyTaskBook(scope), { ...scope, chatEpoch: randomUUID() }), /TASK_SCOPE_MISMATCH/);
  assert.equal(taskWorkflowBinding.protocol, 'analyzer-task-protocol/2');
});
// Seed a valid committed pre-dispatch claim to model a process dying between
// the durable gate cache and planner. No product code contains a crash hook.
async function savedGate(b: Awaited<ReturnType<typeof body>>) {
  const request = { body: b, provider: config.taskProvider!.binding };
  const input = await within(async db => {
    const workspace = await prepareFinance(db, 'first'), scope = { ownerId: 'first', chatId: b.chatId, chatEpoch: b.chatEpoch, generation };
    const date = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    const global = (await db.query("SELECT snapshot FROM finance.analyzer_globals WHERE user_id='first'")).rows[0].snapshot;
    const input = { scope, book: emptyTaskBook(scope), global, dataRevision: workspace.revision, messageId: b.id, question: b.text, currentDate: date };
    const expected = { scope, globalRevision: global.revision, dataRevision: workspace.revision, head: null, count: 0 }, cycle = await analyzerCycle(db, 'first');
    await db.query(`INSERT INTO finance.analyzer_task_request(user_id,id,chat_id,chat_epoch,generation,request,input,expected,anchor_at,period_start)
      VALUES('first',$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [b.id,b.chatId,b.chatEpoch,generation,JSON.stringify(request),JSON.stringify(input),JSON.stringify(expected),cycle.anchorExact,cycle.startExact]);
    return { input, cycle };
  });
  const model = config.taskProvider!.forTask({ userId: 'first', id: b.id, binding: { request, input: input.input }, anchorAt: input.cycle.anchorExact, periodStart: input.cycle.startExact, question: b.text }, async db => { await prepareFinance(db, 'first'); });
  await model.relevance({ question: b.text, hasFinancialTasks: false, capabilities: taskCapabilities });
}
test('restart resumes a durable gate cache and sends only the missing planner; changed binding never reinterprets it', async () => {
  const b = await body(); await savedGate(b); assert.equal(calls, 1);
  const changed = await request('/finance/analyzer-task', { ...b, text: 'Другой вопрос' }); assert.equal(changed.json().code, 'AI_REQUEST_CHANGED'); assert.equal(calls, 1);
  const restarted = await createServer({ ...config, taskProvider: makeProvider() });
  try { const result = await request('/finance/analyzer-task', b, restarted); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().answer.result.totals.expenses, '24690'); } finally { await restarted.close(); }
  assert.equal(calls, 2); assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n, '1');
});
test('receipt without its private cache fails closed after restart and never repeats the paid gate', async () => {
  const b = await body(); await savedGate(b); await pg.owner.query('DELETE FROM finance.analyzer_task_cache');
  const result = await request('/finance/analyzer-task', b); assert.equal(result.json().code, 'AI_RESPONSE_UNAVAILABLE'); assert.equal(calls, 1);
  assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state, 'settled');
});
test('data revision or entitlement changing during network wait blocks calculation and keeps the known provider cost', async () => {
  for (const change of ['revision', 'access']) {
    const b = await body(); behavior = 'block'; barrier = deferred(); dispatched = deferred();
    const running = request('/finance/analyzer-task', b); await dispatched.promise;
    if (change === 'revision') await within(db => db.query("UPDATE finance.workspace SET revision=revision+1 WHERE user_id='first'"));
    else await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");
    barrier.resolve(); const result = await running;
    assert.ok([409, 502, 403].includes(result.statusCode), result.body);
    assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n, '0');
    assert.ok((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows.every(r => r.state === 'settled'));
    behavior = 'normal';
  }
  assert.equal(calls, 2);
});
test('legacy millisecond usage and cost budget remain occupied when new requests use exact period timestamps', async () => {
  const b = await body();
  await within(async db => {
    const c = await analyzerCycle(db, 'first');
    await db.query(`INSERT INTO commerce.analyzer_usage(user_id,request_id,anchor_at,period_start,units,input_tokens,output_tokens,provider,model,provider_version)
      VALUES('first',$1,$2,date_trunc('milliseconds',$3::timestamptz),1,10,5,'legacy','synthetic','legacy/1')`, [randomUUID(),c.anchorExact,c.startExact]);
    await db.query(`INSERT INTO commerce.ai_user_budget(user_id,anchor_at,period_start,limit_atoms,spent_atoms)
      VALUES('first',$1,date_trunc('milliseconds',$2::timestamptz),$3,$4)`, [c.anchorExact,c.startExact,rubAmount('100').toString(),rubAmount('99.9').toString()]);
    assert.equal((await analyzerQuota(db, 'first', true)).used, 1);
  });
  const result = await request('/finance/analyzer-task', b); assert.equal(result.json().code, 'AI_USER_COST_EXHAUSTED'); assert.equal(calls, 0);
  const budgets = (await pg.owner.query('SELECT spent_atoms FROM commerce.ai_user_budget')).rows; assert.equal(budgets.length, 1); assert.equal(budgets[0].spent_atoms,rubAmount('99.9').toString());
});
test('partial deletion preserves and rebinds an unrelated completed task; full reset semantics are not applied to it', async () => {
  const affected = await body(); assert.equal((await request('/finance/analyzer-task', affected)).statusCode, 200);
  const safe = await body(); const context = await request('/finance/analyzer-context', { generation, change: { id: randomUUID(), revision: 0, filter: { from: '2099-01-01' }, touched: ['period'] } }); safe.globalRevision = context.json().revision;
  assert.equal((await request('/finance/analyzer-task', safe)).json().answer.result.totals.expenses, '0');
  const workspace = await within(db => prepareFinance(db, 'first')), actionId = randomUUID();
  const preview = await request('/finance/preview', { actionId, generation, revision: workspace.revision, intent: { kind: 'delete_financial', scope: { kind: 'operations', operationIds: [operationIds[0]] } } }); assert.equal(preview.statusCode, 200, preview.body);
  const committed = await request('/finance/commit', { actionId }); assert.equal(committed.statusCode, 200, committed.body);
  const nextGeneration = committed.json().generation; assert.notEqual(nextGeneration, generation);
  const book = (await pg.owner.query('SELECT generation,book FROM finance.analyzer_task_book')).rows;
  assert.equal(book.length, 1); assert.equal(book[0].generation, nextGeneration); assert.equal(book[0].book.scope.generation, nextGeneration); assert.equal(book[0].book.nodes[0].messageId, safe.id);
  proposal = { status: 'query', binding: { kind: 'nearest', metric: null, comparison: null }, metric: keep, grouping: { op: 'set', value: 'category', quote: 'по категориям' }, comparison: keep, edits: [] };
  const follow = await request('/finance/analyzer-task', { ...safe, id: randomUUID(), generation: nextGeneration, text: 'А по категориям?' }); assert.equal(follow.statusCode, 200, follow.body); assert.equal(follow.json().answer.result.totals.expenses, '0'); assert.equal(follow.json().answer.followUp, true);
});
test('deleting a UI reference blocks dispatch without erasing other filters or resetting manual stamps', async () => {
  const b = await body(), temporary = randomUUID();
  await within(db => db.query("INSERT INTO finance.account(user_id,id,bank_id,system_name,display_name,account_type) VALUES('first',$1,'tbank','Synthetic empty','Synthetic empty','bank_account')", [temporary]));
  const snapshot = await request('/finance/analyzer-context', { generation, change: { id: randomUUID(), revision: 0, filter: { from: '2099-01-01', accountIds: [temporary] }, touched: [] } });
  assert.equal(snapshot.statusCode, 200, snapshot.body); b.globalRevision = snapshot.json().revision;
  await within(db => db.query("DELETE FROM finance.account WHERE user_id='first' AND id=$1", [temporary]));
  assert.equal((await request('/finance/analyzer-task', b)).json().code, 'AI_CONTEXT_CHANGED'); assert.equal(calls, 0);
  const current = await request('/finance/analyzer-context', { generation }); assert.equal(current.json().revision, 1); assert.equal(current.json().filter.from, '2099-01-01');
  const replacement = await request('/finance/analyzer-context', { generation, change: { id: randomUUID(), revision: 1, filter: { from: '2099-01-01' }, touched: ['accounts'] } });
  assert.equal(replacement.json().touched.period, 1); assert.equal(replacement.json().touched.accounts, 2);
  const result = await request('/finance/analyzer-task', { ...b, id: randomUUID(), globalRevision: 2 }); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().answer.result.totals.expenses, '0');
});
