import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { object, uuid } from '../../../packages/finance-core/src/model.ts';
import { registryVersion } from '../../../packages/analyzer/src/registry.ts';
import type { Answer } from '../../../packages/analyzer/src/types.ts';
import { emptyConversation, parseConversation } from '../../../packages/analyzer/src/assistant-conversation.ts';
import { AssistantError, cleanAssistantQuestion, profileCalendar } from '../../../packages/analyzer/src/assistant-plan.ts';
import { globalSnapshot } from '../../../packages/analyzer/src/task-context.ts';
import { runAssistant, assistantRequestFingerprint, assistantWorkflowVersion } from './assistant-workflow.ts';
import type { AssistantRequest, AssistantJournal, AssistantReply, ExpectedAssistantState, RunReceipt } from './assistant-workflow.ts';
import { checkedAssistantReceipt } from './assistant-journal.ts';
import { taskTransaction } from './analyzer-task-provider.ts';
import { isAssistantProvider } from './analyzer-assistant-provider.ts';
import type { AssistantProvider } from './analyzer-assistant-provider.ts';
import { analyzerTaskContext, cancelAnalyzerTask } from './analyzer-task-store.ts';
import { prepareFinance } from './finance.ts';
import { analyzerCycle, analyzerQuota, calculateAnalyzerQuery } from './analyzer.ts';
import { assertReferences } from './operations.ts';
import { yandexCatalog } from './yandex-runtime.ts';
import { reserveCost, settleCost } from './analyzer-cost.ts';
import { stableJSON } from './finance-history.ts';
import { HttpError } from './types.ts';

type Authorize = (db: PoolClient) => Promise<void>;
type Claim = { input: AssistantRequest; expected: ExpectedAssistantState; state: 'pending' | 'completed' | 'cancelled'; reply: unknown; anchorExact: string; periodExact: string };
const step = (i: number): 'assistant_0' | 'assistant_1' | 'assistant_2' => {
  if (!Number.isInteger(i) || i < 0 || i > 2) throw new AssistantError('ASSISTANT_CALL_LIMIT');
  return `assistant_${i}` as ReturnType<typeof step>;
};
const integer = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new TypeError('TASK_REVISION_INVALID'); return v; };

/** No Moscow/billing-cycle fallback and no client-controlled calendar per call. */
export async function assistantProfile(db: PoolClient, userId: string, value: unknown) {
  const r = object(value, ['timezone', 'initialize']);
  if (r.initialize !== undefined && (typeof r.initialize !== 'boolean' || r.timezone === undefined)) throw new TypeError('ASSISTANT_PROFILE_INVALID');
  await prepareFinance(db, userId);
  if (r.timezone !== undefined) {
    const calendar = profileCalendar(new Date(), r.timezone as string);
    if (!(await db.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [calendar.timezone])).rowCount) throw new AssistantError('ASSISTANT_TIMEZONE_INVALID');
    await db.query(`INSERT INTO finance.assistant_profile(user_id,timezone) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET timezone=CASE WHEN $3 THEN finance.assistant_profile.timezone ELSE EXCLUDED.timezone END`, [userId, calendar.timezone, r.initialize === true]);
  }
  return { timezone: (await db.query('SELECT timezone FROM finance.assistant_profile WHERE user_id=$1', [userId])).rows[0]?.timezone ?? null };
}

/** One connection-level lock per request, no transaction/workspace lock across
 * HTTP. Process death releases it. A durable sent receipt never triggers retry. */
export async function executeAssistant(pool: Pool, userId: string, value: unknown, provider: AssistantProvider, authorize: Authorize) {
  if (!isAssistantProvider(provider) || provider.pool !== pool) throw new HttpError(503, 'AI_UNAVAILABLE');
  const b = object(value, ['id', 'chatId', 'chatEpoch', 'generation', 'globalRevision', 'text']);
  const body = { id: uuid(b.id), chatId: uuid(b.chatId), chatEpoch: uuid(b.chatEpoch), generation: uuid(b.generation), globalRevision: integer(b.globalRevision), text: cleanAssistantQuestion(b.text) };
  const { id, chatId, chatEpoch, generation, globalRevision, text } = body;
  const lock = await pool.connect(), lockKey = 'assistant-run:' + userId + ':' + id;
  let locked = false, destroyed = false;
  try {
    locked = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey])).rows[0].locked;
    if (!locked) throw new HttpError(409, 'AI_REQUEST_IN_PROGRESS');
    return await executeLocked();
  } finally {
    if (locked) {
      try { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); }
      catch { lock.release(true); destroyed = true; }
    }
    if (!destroyed) lock.release();
  }
  async function executeLocked() {
    const within = <T>(action: (db: PoolClient) => Promise<T>) => taskTransaction(pool, userId, action);
    const own = (db: PoolClient) => db.query('SELECT *,anchor_at::text AS "anchorExact",period_start::text AS "periodExact" FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, id]);
    async function currentScope(db: PoolClient) {
      await authorize(db);
      const workspace = await prepareFinance(db, userId);
      const chat = (await db.query('SELECT epoch FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2', [userId, chatId])).rows[0];
      if (!chat || chat.epoch !== chatEpoch || workspace.generation !== generation) throw new HttpError(409, 'AI_STATE_CHANGED');
      const timezone = (await db.query('SELECT timezone FROM finance.assistant_profile WHERE user_id=$1', [userId])).rows[0]?.timezone;
      if (!timezone) throw new HttpError(409, 'ASSISTANT_TIMEZONE_REQUIRED');
      return { workspace, timezone: String(timezone) };
    }
    const request = { body, provider: provider.binding };
    const claim = await within(async db => {
      const { workspace, timezone } = await currentScope(db);
      if ((await db.query('SELECT 1 FROM finance.analyzer_task_cancel WHERE user_id=$1 AND request_id=$2', [userId, id])).rowCount) throw new HttpError(409, 'AI_REQUEST_CANCELLED');
      const old = (await own(db)).rows[0];
      if (old) {
        if (stableJSON(old.request) !== stableJSON(request)) throw new HttpError(409, 'AI_REQUEST_CHANGED');
        if (old.state === 'cancelled') throw new HttpError(409, 'AI_REQUEST_CANCELLED');
        if (old.input.timezone !== timezone) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
        return { ...old, input: { ...old.input, now: new Date(old.input.now) } } as Claim;
      }
      if ((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 UNION ALL SELECT 1 FROM commerce.analyzer_usage WHERE user_id=$1 AND request_id=$2', [userId, id])).rowCount) throw new HttpError(409, 'ACTION_REUSED');
      if ((await db.query("SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND chat_id=$2 AND state='pending'", [userId, chatId])).rowCount) throw new HttpError(409, 'AI_REQUEST_IN_PROGRESS');
      const global = await analyzerTaskContext(db, userId, { generation });
      if ((await db.query('SELECT invalidated FROM finance.analyzer_globals WHERE user_id=$1', [userId])).rows[0].invalidated || global.revision !== globalRevision) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
      const scope = { ownerId: userId, chatId, chatEpoch, generation };
      const saved = (await db.query('SELECT conversation FROM finance.assistant_conversation WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0];
      const count = Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0].n);
      if (count >= 100) throw new HttpError(409, 'MESSAGE_LIMIT');
      if (!saved && count) throw new HttpError(409, 'AI_CHAT_PROTOCOL_CHANGED');
      const conversation = saved ? parseConversation(saved.conversation, scope) : emptyConversation(scope);
      const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      profileCalendar(now, timezone);
      const input: AssistantRequest = { requestId: id, scope, conversation, global, dataRevision: workspace.revision, question: text, now, timezone };
      const expected: ExpectedAssistantState = { scope, head: conversation.book.nodes.at(-1)?.messageId ?? null, turns: conversation.turns.length, globalRevision, dataRevision: workspace.revision, timezone };
      const cycle = await analyzerCycle(db, userId), quota = await analyzerQuota(db, userId, true);
      if (!cycle || !quota.available) throw new HttpError(409, 'AI_QUOTA_UNAVAILABLE');
      if (!quota.remaining) throw new HttpError(429, 'AI_QUOTA_EXHAUSTED');
      await db.query(`INSERT INTO finance.analyzer_task_request(user_id,id,chat_id,chat_epoch,generation,request,input,expected,anchor_at,period_start)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [userId, id, chatId, chatEpoch, generation, JSON.stringify(request), JSON.stringify(input), JSON.stringify(expected), cycle.anchorExact, cycle.startExact]);
      return { input, expected, state: 'pending', reply: null, anchorExact: cycle.anchorExact, periodExact: cycle.startExact } as Claim;
    });
    if (claim.state === 'completed') return claim.reply;
    const r = claim.input, model = provider.forRequest();
    async function guard(db: PoolClient, expected = claim.expected) {
      const { workspace, timezone } = await currentScope(db);
      const active = (await own(db)).rows[0];
      if (!active || active.state !== 'pending') throw new HttpError(409, active?.state === 'cancelled' ? 'AI_REQUEST_CANCELLED' : 'AI_STATE_CHANGED');
      if (!isDeepStrictEqual(expected, claim.expected) || workspace.revision !== expected.dataRevision || timezone !== expected.timezone) throw new HttpError(409, 'AI_STATE_CHANGED');
      const g = (await db.query('SELECT snapshot,invalidated FROM finance.analyzer_globals WHERE user_id=$1', [userId])).rows[0];
      if (!g || g.invalidated || globalSnapshot(g.snapshot).revision !== expected.globalRevision) throw new HttpError(409, 'AI_CONTEXT_CHANGED');
      const stored = (await db.query('SELECT conversation FROM finance.assistant_conversation WHERE user_id=$1 AND chat_id=$2', [userId, chatId])).rows[0];
      const current = stored ? parseConversation(stored.conversation, r.scope) : emptyConversation(r.scope);
      if (current.turns.length !== expected.turns || (current.book.nodes.at(-1)?.messageId ?? null) !== expected.head) throw new HttpError(409, 'AI_STATE_CHANGED');
      const cycle = await analyzerCycle(db, userId);
      if (cycle?.anchorExact !== claim.anchorExact || cycle?.startExact !== claim.periodExact) throw new HttpError(409, 'AI_QUOTA_PERIOD_CHANGED');
    }
    const fingerprint = assistantRequestFingerprint(r);
    const saved = await within(async db => { await guard(db); return (await db.query('SELECT workflow,receipt FROM finance.assistant_run WHERE user_id=$1 AND request_id=$2', [userId, id])).rows[0]; });
    const receipt: RunReceipt = saved ? checkedAssistantReceipt({ version: saved.workflow, receipt: saved.receipt }, fingerprint) : { fingerprint, calls: [] };
    const journal: AssistantJournal = { receipt,
      async persist() {
        const serialized = JSON.stringify({ version: assistantWorkflowVersion, receipt });
        if (Buffer.byteLength(serialized) > 2097152) throw new AssistantError('ASSISTANT_JOURNAL_TOO_LARGE');
        checkedAssistantReceipt(JSON.parse(serialized), fingerprint);
        await within(async db => {
          await guard(db);
          await db.query(`INSERT INTO finance.assistant_run(user_id,request_id,workflow,receipt) VALUES($1,$2,$3,$4)
            ON CONFLICT(user_id,request_id) DO UPDATE SET receipt=EXCLUDED.receipt`, [userId, id, assistantWorkflowVersion, JSON.stringify(receipt)]);
        });
      },
      async reserve(index, bound) {
        await within(async db => {
          await guard(db);
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cloud-task-dispatch:' + userId]);
          if ((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3', [userId, id, step(index)])).rowCount) throw new HttpError(409, 'AI_DELIVERY_UNKNOWN');
          if ((await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1", [userId])).rowCount) throw new HttpError(409, 'AI_COST_RECONCILIATION_REQUIRED');
          await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state)
            VALUES($1,$2,$3,$4,'sent','cashneuro-assistant/1',$5,$6,$7,'not_sent')`, [userId, id, step(index), fingerprint, bound.modelVersion, claim.periodExact, claim.anchorExact]);
          await reserveCost(db, { userId, requestId: id, step: step(index), anchorAt: claim.anchorExact, periodStart: claim.periodExact }, provider.policy, bound);
        });
      },
      async settle(index, usage) {
        // Actual cost is settled even after cancellation, deletion or expiry.
        const violation = await within(async db => {
          const changed = await settleCost(db, userId, id, step(index), usage);
          await db.query(`UPDATE commerce.analyzer_request SET state=CASE WHEN $4='received' AND NOT EXISTS(SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 AND state='pending') THEN 'completed' ELSE $4 END,usage_state=$5,input_tokens=$6,output_tokens=$7,model_version=$8,updated_at=clock_timestamp()
            WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state IN ('sent','received','unknown')`,
          [userId, id, step(index), usage ? 'received' : 'unknown', usage ? 'reported' : 'unknown', usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.modelVersion ?? null]);
          return changed;
        });
        if (violation) throw new AssistantError('ASSISTANT_PROVIDER_CHANGED');
      },
    };
    await journal.persist();
    let savedReply: unknown;
    type Calculation = Awaited<ReturnType<typeof calculateAnalyzerQuery>>;
    try {
    await runAssistant(r, model, journal, {
      guard: expected => within(db => guard(db, expected)),
      catalog: () => within(async db => { await guard(db); return yandexCatalog(db, userId); }),
      authorizeQuery: query => within(async db => { await guard(db); await assertReferences(db, userId, query.filter); }),
      calculate: (query, calendar) => within(async db => {
        await guard(db); await assertReferences(db, userId, query.filter);
        return calculateAnalyzerQuery(db, userId, query, r.now, { mode: 'test_adapter', timezone: calendar.timezone,
          periodFromQuestion: query.filter.from !== r.global.filter.from || query.filter.through !== r.global.filter.through,
          followUp: false, provider: { id: 'cashneuro-assistant/1', model: provider.model.bound.modelVersion, version: assistantWorkflowVersion } });
      }),
      render: (_query, result) => (result as Calculation).answer.text,
      commit: payload => within(async db => {
        await currentScope(db);
        const existing = (await own(db)).rows[0];
        if (existing?.state === 'completed') { savedReply = existing.reply; return; }
        await guard(db, payload.expected);
        const prepared = (await db.query('SELECT receipt FROM finance.assistant_run WHERE user_id=$1 AND request_id=$2', [userId, id])).rows[0]?.receipt;
        if (!prepared || !isDeepStrictEqual(prepared.result, payload.reply) || !isDeepStrictEqual(prepared.conversation, payload.conversation)) throw new HttpError(409, 'AI_STATE_CHANGED');
        const conversation = parseConversation(payload.conversation, r.scope);
        const reply: AssistantReply = payload.reply, calculation = reply.result as Calculation | undefined;
        let answer: Answer;
        if (reply.status === 'query') {
          if (!calculation || !isDeepStrictEqual(reply.query, calculation.answer.query)) throw new HttpError(409, 'AI_STATE_CHANGED');
          await assertReferences(db, userId, reply.query!.filter);
          answer = { ...calculation.answer, followUp: conversation.book.nodes.at(-1)!.parent !== null };
        } else answer = { registryVersion, mode: reply.status === 'answer' ? 'ai' : reply.status === 'redirect' ? 'redirect' : reply.status === 'clarification' ? 'clarification' : 'unavailable', text: reply.text };
        await db.query('INSERT INTO finance.analyzer_message(user_id,id,chat_id,question,answer,context,request) VALUES($1,$2,$3,$4,$5,$6,$7)', [userId, id, chatId, text, JSON.stringify(answer), reply.query ? JSON.stringify(reply.query) : null, JSON.stringify(body)]);
        if (reply.status === 'query' && calculation!.dependencyIds.length) await db.query('INSERT INTO finance.analyzer_dependency(user_id,message_id,transaction_id) SELECT $1,$2,unnest($3::uuid[])', [userId, id, calculation!.dependencyIds]);
        await db.query(`INSERT INTO finance.assistant_conversation(user_id,chat_id,chat_epoch,generation,conversation) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(user_id,chat_id) DO UPDATE SET conversation=EXCLUDED.conversation,generation=EXCLUDED.generation`, [userId, chatId, chatEpoch, generation, JSON.stringify(conversation)]);
        const book = conversation.book;
        await db.query(`INSERT INTO finance.analyzer_task_book(user_id,chat_id,chat_epoch,generation,book,head,node_count) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(user_id,chat_id) DO UPDATE SET book=EXCLUDED.book,head=EXCLUDED.head,node_count=EXCLUDED.node_count,generation=EXCLUDED.generation`, [userId, chatId, chatEpoch, generation, JSON.stringify(book), book.nodes.at(-1)?.messageId ?? null, book.nodes.length]);
        if (reply.status === 'query') {
          const billed = await db.query(`INSERT INTO commerce.analyzer_usage(user_id,request_id,anchor_at,period_start,units,input_tokens,output_tokens,provider,model,provider_version)
            SELECT user_id,request_id,anchor_at,period_start,1,(SELECT sum(input_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),
            (SELECT sum(output_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),provider,model,$3
            FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step='assistant_0' AND state='received' AND usage_state='reported'`, [userId, id, assistantWorkflowVersion]);
          if (billed.rowCount !== 1) throw new HttpError(409, 'AI_STATE_CHANGED');
        }
        await db.query("UPDATE commerce.analyzer_request SET state='completed',updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND state='received'", [userId, id]);
        await db.query("UPDATE finance.analyzer_chat SET title=CASE WHEN title='Новый диалог' AND $3 THEN $4 ELSE title END,modified_at=clock_timestamp() WHERE user_id=$1 AND id=$2", [userId, chatId, reply.status === 'query', text.slice(0,100)]);
        savedReply = { id, answer, code: reply.code, quota: await analyzerQuota(db, userId, true) };
        await db.query("UPDATE finance.analyzer_task_request SET state='completed',reply=$3 WHERE user_id=$1 AND id=$2 AND state='pending'", [userId, id, JSON.stringify(savedReply)]);
      }),
    });
    return savedReply;
    } catch (error) {
      if (error instanceof HttpError && !['AI_REQUEST_IN_PROGRESS', 'AI_DELIVERY_UNKNOWN', 'AI_COST_RECONCILIATION_REQUIRED'].includes(error.code)) {
        await within(db => cancelAnalyzerTask(db, userId, { id, chatId, chatEpoch }));
      }
      throw error;
    }
  }
}
