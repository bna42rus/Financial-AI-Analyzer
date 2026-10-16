import type { Pool, PoolClient } from 'pg';
import { object, uuid, choice } from '../../../packages/finance-core/src/model.ts';
import { safeQuestion } from '../../../packages/analyzer/src/yandex-contract.ts';
import { emptyTaskBook, parseTaskBook, globalSnapshot, conditionFields } from '../../../packages/analyzer/src/task-context.ts';
import type { TaskBook, TaskScope, GlobalSnapshot, Condition } from '../../../packages/analyzer/src/task-context.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import { registryVersion } from '../../../packages/analyzer/src/registry.ts';
import type { Answer } from '../../../packages/analyzer/src/types.ts';
import { prepareFinance } from './finance.ts';
import { assertReferences } from './operations.ts';
import { stableJSON } from './finance-history.ts';
import { analyzerCycle, analyzerQuota, calculateAnalyzerQuery } from './analyzer.ts';
import { yandexCatalog } from './yandex-runtime.ts';
import { runAnalyzerTask } from './analyzer-task-workflow.ts';
import type { TaskInput, ExpectedTaskState } from './analyzer-task-workflow.ts';
import { taskTransaction, isCloudTaskProvider } from './analyzer-task-provider.ts';
import type { CloudTaskProvider } from './analyzer-task-provider.ts';
import { HttpError } from './types.ts';

type Authorize = (db: PoolClient) => Promise<void>;
const conditions = Object.keys(conditionFields) as Condition[];
const integer = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TypeError('TASK_REVISION_INVALID'); return v; };
async function globals(db: PoolClient, userId: string, generation: string): Promise<GlobalSnapshot> {
  const initial = { revision: 0, filter: {}, touched: {} };
  await db.query('INSERT INTO finance.analyzer_globals(user_id,generation,snapshot,revision) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING', [userId, generation, JSON.stringify(initial)]);
  const row = (await db.query('SELECT * FROM finance.analyzer_globals WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
  if (row.generation !== generation) throw new HttpError(409, 'AI_STATE_CHANGED');
  return globalSnapshot(row.snapshot);
}
/** The caller holds the short prepareFinance workspace lock. Clients submit
 * touched group names, never revisions/stamps of their own choosing. */
export async function analyzerTaskContext(db: PoolClient, userId: string, value: unknown) {
  const r = object(value, ['generation', 'change']), generation = uuid(r.generation), workspace = await prepareFinance(db, userId);
  if (workspace.generation !== generation) throw new HttpError(409, 'FINANCE_CHANGED');
  const current = await globals(db, userId, generation);
  if (r.change === undefined) return current;
  const c = object(r.change, ['id', 'revision', 'filter', 'touched']), id = uuid(c.id), expected = integer(c.revision);
  if (!Array.isArray(c.touched) || c.touched.length > conditions.length || new Set(c.touched).size !== c.touched.length) throw new TypeError('TASK_TOUCH_INVALID');
  const touched = c.touched.map(v => choice(v, conditions));
  const filter = globalSnapshot({ revision: 0, filter: c.filter, touched: {} }).filter;
  const request = { revision: expected, filter, touched };
  const prior = (await db.query('SELECT request,snapshot FROM finance.analyzer_global_change WHERE user_id=$1 AND id=$2', [userId, id])).rows[0];
  if (prior) {
    if (stableJSON(prior.request) !== stableJSON(request)) throw new HttpError(409, 'ACTION_REUSED');
    if (current.revision !== prior.snapshot.revision) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
    return globalSnapshot(prior.snapshot);
  }
  if (current.revision !== expected || current.revision >= Number.MAX_SAFE_INTEGER) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
  await assertReferences(db, userId, filter);
  const revision = current.revision + 1, stamps = { ...current.touched };
  // Server also derives actual differences: omitted touch hints cannot hide a
  // changed condition; a touch with the same final value remains observable.
  const normalized = (v: unknown) => stableJSON(Array.isArray(v) ? [...v].sort() : v ?? null);
  for (const field of conditions) if (touched.includes(field) || conditionFields[field].some(k => normalized(filter[k]) !== normalized(current.filter[k]))) stamps[field] = revision;
  const snapshot = globalSnapshot({ revision, filter, touched: stamps });
  await db.query('UPDATE finance.analyzer_globals SET snapshot=$2,revision=$3,invalidated=false WHERE user_id=$1', [userId, JSON.stringify(snapshot), revision]);
  await db.query('INSERT INTO finance.analyzer_global_change(user_id,id,request,snapshot) VALUES($1,$2,$3,$4)', [userId, id, JSON.stringify(request), JSON.stringify(snapshot)]);
  return snapshot;
}
export async function cancelAnalyzerTask(db: PoolClient, userId: string, value: unknown) {
  const r = object(value, ['id', 'chatId', 'chatEpoch']), id = uuid(r.id), chatId = uuid(r.chatId), epoch = uuid(r.chatEpoch);
  // Cancellation is idempotent. It does not erase/refund commercial receipts.
  // Insert even if cancellation overtook the HTTP request before its claim.
  await db.query('INSERT INTO finance.analyzer_task_cancel(user_id,request_id,chat_id,chat_epoch) SELECT user_id,$2,id,epoch FROM finance.analyzer_chat WHERE user_id=$1 AND id=$3 AND epoch=$4 ON CONFLICT DO NOTHING', [userId, id, chatId, epoch]);
  await db.query("UPDATE finance.analyzer_task_request SET state='cancelled' WHERE user_id=$1 AND id=$2 AND chat_id=$3 AND chat_epoch=$4 AND state='pending'", [userId, id, chatId, epoch]);
  await db.query("UPDATE commerce.analyzer_request SET state='completed',error_code='AI_REQUEST_CANCELLED',updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND state='received' AND EXISTS(SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 AND chat_id=$3 AND chat_epoch=$4 AND state='cancelled')", [userId, id, chatId, epoch]);
  return { id };
}
export async function pendingAnalyzerTasks(db: PoolClient, userId: string) {
  return (await db.query("SELECT request->'body' AS body FROM finance.analyzer_task_request WHERE user_id=$1 AND state='pending' ORDER BY created_at LIMIT 100", [userId])).rows.map(r => r.body);
}
type Claim = { input: TaskInput; expected: ExpectedTaskState; anchorExact: string; periodExact: string; request: unknown; reply: unknown; state: string };
export async function executeAnalyzerTask(pool: Pool, userId: string, value: unknown, provider: CloudTaskProvider, authorize: Authorize) {
  if (!isCloudTaskProvider(provider) || provider.pool !== pool) throw new HttpError(503, 'AI_UNAVAILABLE');
  const r = object(value, ['id', 'chatId', 'chatEpoch', 'generation', 'globalRevision', 'text']);
  const id = uuid(r.id), chatId = uuid(r.chatId), chatEpoch = uuid(r.chatEpoch), generation = uuid(r.generation), globalRevision = integer(r.globalRevision), text = safeQuestion(r.text);
  const request = { body: { id, chatId, chatEpoch, generation, globalRevision, text }, provider: provider.binding };
  const within = <T>(fn: (db: PoolClient) => Promise<T>) => taskTransaction(pool, userId, fn);
  const row = (db: PoolClient) => db.query('SELECT *,anchor_at::text AS "anchorExact",period_start::text AS "periodExact" FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id]);
  const claim = await within(async db => {
    await authorize(db); const workspace = await prepareFinance(db, userId);
    if ((await db.query('SELECT 1 FROM finance.analyzer_task_cancel WHERE user_id=$1 AND request_id=$2', [userId, id])).rowCount) throw new HttpError(409, 'AI_REQUEST_CANCELLED');
    const existing = (await row(db)).rows[0];
    if (existing) {
      if (stableJSON(existing.request) !== stableJSON(request)) throw new HttpError(409, 'AI_REQUEST_CHANGED');
      if (existing.state === 'cancelled') throw new HttpError(409, 'AI_REQUEST_CANCELLED');
      return existing as Claim;
    }
    // Commercial tombstones prevent request-ID reuse after financial deletion.
    if ((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 UNION ALL SELECT 1 FROM commerce.analyzer_usage WHERE user_id=$1 AND request_id=$2', [userId, id])).rowCount) throw new HttpError(409, 'ACTION_REUSED');
    const chat = (await db.query('SELECT epoch FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2', [userId, chatId])).rows[0];
    if (!chat || chat.epoch !== chatEpoch || workspace.generation !== generation) throw new HttpError(409, 'AI_STATE_CHANGED');
    if ((await db.query("SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND chat_id=$2 AND state='pending' LIMIT 1", [userId, chatId])).rowCount) throw new HttpError(409, 'AI_REQUEST_IN_PROGRESS');
    const global = await globals(db, userId, generation);
    if ((await db.query('SELECT invalidated FROM finance.analyzer_globals WHERE user_id=$1', [userId])).rows[0].invalidated) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
    if (global.revision !== globalRevision) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
    if (Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0].n) >= 100) throw new HttpError(409, 'MESSAGE_LIMIT');
    const scope: TaskScope = { ownerId: userId, chatId, chatEpoch, generation };
    const stored = (await db.query('SELECT book FROM finance.analyzer_task_book WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0];
    const book = stored ? parseTaskBook(stored.book, scope) : emptyTaskBook(scope);
    const now = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    const input: TaskInput = { scope, book, global, dataRevision: workspace.revision, messageId: id, question: text, currentDate: now };
    const expected: ExpectedTaskState = { scope, globalRevision, dataRevision: workspace.revision, head: book.nodes.at(-1)?.messageId ?? null, count: book.nodes.length };
    const cycle = await analyzerCycle(db, userId), quota = await analyzerQuota(db, userId, true);
    if (!cycle || !quota.available) throw new HttpError(409, 'AI_QUOTA_UNAVAILABLE');
    if (!quota.remaining) throw new HttpError(429, 'AI_QUOTA_EXHAUSTED');
    await db.query(`INSERT INTO finance.analyzer_task_request(user_id,id,chat_id,chat_epoch,generation,request,input,expected,anchor_at,period_start)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [userId, id, chatId, chatEpoch, generation, JSON.stringify(request), JSON.stringify(input), JSON.stringify(expected), cycle.anchorExact, cycle.startExact]);
    return { input, expected, anchorExact: cycle.anchorExact, periodExact: cycle.startExact, request, state: 'pending', reply: null } as Claim;
  });
  if (claim.state === 'completed') return claim.reply;
  const guard = async (db: PoolClient, expected = claim.expected) => {
    await authorize(db); const workspace = await prepareFinance(db, userId);
    const own = (await row(db)).rows[0];
    if (!own || own.chat_epoch !== chatEpoch || own.generation !== generation) throw new HttpError(409, 'AI_STATE_CHANGED');
    if (own.state === 'cancelled') throw new HttpError(409, 'AI_REQUEST_CANCELLED');
    if (own.state !== 'pending') throw new HttpError(409, 'AI_REQUEST_IN_PROGRESS');
    if (stableJSON(expected) !== stableJSON(claim.expected) || workspace.generation !== generation || workspace.revision !== expected.dataRevision) throw new HttpError(409, 'AI_STATE_CHANGED');
    const global = await globals(db, userId, generation);
    if ((await db.query('SELECT invalidated FROM finance.analyzer_globals WHERE user_id=$1', [userId])).rows[0].invalidated) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
    if (global.revision !== expected.globalRevision) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
    const book = (await db.query('SELECT head,node_count FROM finance.analyzer_task_book WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0];
    if ((book?.head ?? null) !== expected.head || (book?.node_count ?? 0) !== expected.count) throw new HttpError(409, 'AI_STATE_CHANGED');
    if (Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0].n) >= 100) throw new HttpError(409, 'MESSAGE_LIMIT');
    const cycle = await analyzerCycle(db, userId);
    if (cycle?.anchorExact !== claim.anchorExact || cycle?.startExact !== claim.periodExact) throw new HttpError(409, 'AI_QUOTA_PERIOD_CHANGED');
  };
  const model = provider.forTask({ userId, id, binding: { request, input: claim.input }, anchorAt: claim.anchorExact, periodStart: claim.periodExact, question: text }, db => guard(db));
  type Calculation = Awaited<ReturnType<typeof calculateAnalyzerQuery>>;
  let savedReply: unknown;
  async function save(db: PoolClient, answer: Answer, query?: Query, book?: TaskBook, dependencies: string[] = []) {
    await guard(db);
    await db.query('INSERT INTO finance.analyzer_message(user_id,id,chat_id,question,answer,context,request) VALUES($1,$2,$3,$4,$5,$6,$7)', [userId, id, chatId, text, JSON.stringify(answer), query ? JSON.stringify(query) : null, JSON.stringify(request.body)]);
    if (dependencies.length) await db.query('INSERT INTO finance.analyzer_dependency(user_id,message_id,transaction_id) SELECT $1,$2,unnest($3::uuid[])', [userId, id, dependencies]);
    if (book) await db.query(`INSERT INTO finance.analyzer_task_book(user_id,chat_id,chat_epoch,generation,book,head,node_count) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(user_id,chat_id) DO UPDATE SET book=EXCLUDED.book,head=EXCLUDED.head,node_count=EXCLUDED.node_count`, [userId, chatId, chatEpoch, generation, JSON.stringify(parseTaskBook(book, claim.input.scope)), id, book.nodes.length]);
    if (query) {
      // Only a committed, successful financial answer consumes a customer unit.
      const billed = await db.query(`INSERT INTO commerce.analyzer_usage(user_id,request_id,anchor_at,period_start,units,input_tokens,output_tokens,provider,model,provider_version)
        SELECT user_id,request_id,anchor_at,period_start,1,(SELECT sum(input_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),
        (SELECT sum(output_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),provider,model,model_version
        FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state='received' AND usage_state='reported'`, [userId, id, provider.billingPhase]);
      if (billed.rowCount !== 1) throw new HttpError(409, 'AI_STATE_CHANGED');
    }
    await db.query("UPDATE commerce.analyzer_request SET state='completed',updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND state='received'", [userId, id]);
    await db.query("UPDATE finance.analyzer_chat SET title=CASE WHEN title='Новый диалог' AND $3 THEN $4 ELSE title END,modified_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND epoch=$5", [userId, chatId, !!query, text.slice(0,100), chatEpoch]);
    savedReply = { id, answer, quota: await analyzerQuota(db, userId, true) };
    await db.query("UPDATE finance.analyzer_task_request SET state='completed',reply=$3 WHERE user_id=$1 AND id=$2 AND state='pending'", [userId, id, JSON.stringify(savedReply)]);
  }
  try {
  const outcome = await runAnalyzerTask<Calculation>(claim.input, model, {
    guard: expected => within(db => guard(db, expected)),
    catalog: () => within(async db => { await guard(db); return yandexCatalog(db, userId); }),
    authorizeQuery: query => within(async db => { await guard(db); await assertReferences(db, userId, query.filter); }),
    calculate: query => within(async db => {
      await guard(db);
      return calculateAnalyzerQuery(db, userId, query, new Date(), { mode: 'test_adapter', periodFromQuestion: query.filter.from !== claim.input.global.filter.from || query.filter.through !== claim.input.global.filter.through,
        followUp: false, provider: { id: 'cloud-task/1', model: provider.model, version: provider.model } });
    }),
    commit: ({ expected, book, query, result }) => within(async db => {
      await guard(db, expected); result.answer.followUp = book.nodes.at(-1)!.parent !== null;
      await save(db, result.answer, query, book, result.dependencyIds);
    }),
  });
  if (outcome.status === 'failed') throw new HttpError(502, 'AI_PLAN_INVALID');
  if (outcome.status !== 'query') {
    const answer: Answer = { registryVersion, mode: outcome.status === 'redirect' ? 'redirect' : outcome.status === 'clarification' ? 'clarification' : 'unavailable',
      text: outcome.status === 'redirect' ? 'Я помогаю разбираться в финансах. Спросите о расходах, доходах или операциях.' : outcome.status === 'clarification' ? 'Уточните показатель, условия или результат, к которому относится вопрос.' : 'Для этого запроса пока нет подходящего финансового инструмента.' };
    await within(db => save(db, answer));
  }
  return savedReply;
  } catch (error) {
    // A concurrent retry must not cancel the original dispatch. All other
    // terminal failures free the private pending slot, never its cost hold.
    if (error instanceof HttpError && !['AI_REQUEST_IN_PROGRESS', 'AI_DELIVERY_UNKNOWN', 'AI_COST_RECONCILIATION_REQUIRED'].includes(error.code)) {
      await within(db => cancelAnalyzerTask(db, userId, { id, chatId, chatEpoch }));
    }
    throw error;
  }
}
