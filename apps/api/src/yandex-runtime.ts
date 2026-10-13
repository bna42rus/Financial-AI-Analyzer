import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { stableJSON } from './finance-history.ts';
import { HttpError } from './types.ts';
import { YandexFailure, isYandexTransport } from './yandex-transport.ts';
import type { YandexTransport } from './yandex-transport.ts';
import type { Catalog } from '../../../packages/analyzer/src/yandex-contract.ts';
import { safeText } from '../../../packages/privacy/src/text.ts';

type Step = 'gate' | 'plan';
type Call = { userId: string; chatId: string; requestId: string; step: Step; binding: unknown; prompt: string; input: unknown; schema: unknown; periodStart?: string; anchorAt?: string };
type Result<T> = { value: T; inputTokens: number; outputTokens: number; modelVersion: string };
const services = new WeakSet<object>();
export function isYandexAnalyzer(value: unknown): value is YandexAnalyzer { return !!value && typeof value === 'object' && services.has(value); }
export type YandexAnalyzer = {
  transport: YandexTransport; pool: Pool;
  call<T>(request: Call, parse: (value: unknown, cached: boolean) => T): Promise<Result<T>>;
  discard(userId: string, requestId: string, code: string): Promise<void>;
};
async function within<T>(pool: Pool, userId: string, action: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)", [userId]); const result = await action(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
/** Separate connections persist dispatch/receipt even if the financial transaction
 * rolls back. They never acquire access/workspace locks or reference their rows. */
export function createYandexAnalyzer(pool: Pool, transport: YandexTransport): YandexAnalyzer {
  if (!isYandexTransport(transport)) throw new YandexFailure('AI_CONFIGURATION_DENIED');
  const service: YandexAnalyzer = {
    pool, transport,
    async call<T>(request: Call, parse: (value: unknown, cached: boolean) => T): Promise<Result<T>> {
      const fingerprint = createHash('sha256').update(stableJSON({ userId: request.userId, chatId: request.chatId, step: request.step, binding: request.binding })).digest('hex');
      const previous = await within(pool, request.userId, async db => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['yandex-dispatch:' + request.userId]);
        const old = (await db.query('SELECT * FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3 FOR UPDATE', [request.userId, request.requestId, request.step])).rows[0];
        if (old) {
          if (old.fingerprint !== fingerprint || old.model !== transport.model) throw new HttpError(409, 'AI_REQUEST_CHANGED');
          if (['sent', 'unknown'].includes(old.state)) throw new HttpError(409, 'AI_DELIVERY_UNKNOWN');
          if (old.state === 'failed') throw new HttpError(502, old.error_code ?? 'AI_RESPONSE_INVALID');
          const cache = (await db.query('SELECT payload FROM finance.analyzer_provider_plan WHERE user_id=$1 AND request_id=$2 AND step=$3 AND chat_id=$4', [request.userId, request.requestId, request.step, request.chatId])).rows[0];
          if (!cache) throw new HttpError(409, 'AI_RESPONSE_UNAVAILABLE');
          return { value: parse(cache.payload, true), inputTokens: old.input_tokens, outputTokens: old.output_tokens, modelVersion: old.model_version } as Result<T>;
        }
        const count = Number((await db.query("SELECT count(*) AS n FROM commerce.analyzer_request WHERE user_id=$1 AND created_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')", [request.userId])).rows[0].n);
        if (count >= transport.dailyLimit) throw new HttpError(429, 'AI_DAILY_LIMIT');
        await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,model,period_start,anchor_at)
          VALUES($1,$2,$3,$4,'sent',$5,$6,$7)`, [request.userId, request.requestId, request.step, fingerprint, transport.model, request.periodStart ?? null, request.anchorAt ?? null]);
        return null;
      });
      if (previous) return previous;
      let completion: Awaited<ReturnType<YandexTransport['complete']>> | undefined;
      try {
        completion = await transport.complete(request.prompt, request.input, request.schema);
        let parsed: T;
        try { parsed = parse(completion.value, false); } catch { throw new YandexFailure('AI_PLAN_INVALID'); }
        await within(pool, request.userId, async db => {
          await db.query('INSERT INTO finance.analyzer_provider_plan(user_id,request_id,step,chat_id,payload) VALUES($1,$2,$3,$4,$5)', [request.userId, request.requestId, request.step, request.chatId, JSON.stringify(parsed)]);
          await db.query(`UPDATE commerce.analyzer_request SET state='received',input_tokens=$4,output_tokens=$5,model_version=$6,updated_at=clock_timestamp()
            WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state='sent'`, [request.userId, request.requestId, request.step, completion!.inputTokens, completion!.outputTokens, completion!.modelVersion]);
        });
        return { ...completion, value: parsed };
      } catch (error) {
        const known = error instanceof YandexFailure, code = known ? error.code : 'AI_DELIVERY_UNKNOWN';
        const unknown = !known || error.unknownOutcome;
        await within(pool, request.userId, db => db.query(`UPDATE commerce.analyzer_request SET state=$4,error_code=$5,input_tokens=$6,output_tokens=$7,model_version=$8,updated_at=clock_timestamp()
          WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state='sent'`, [request.userId, request.requestId, request.step, unknown ? 'unknown' : 'failed', code, completion?.inputTokens ?? 0, completion?.outputTokens ?? 0, completion?.modelVersion ?? null]));
        throw new HttpError(unknown ? 409 : 502, code);
      }
    },
    async discard(userId, requestId, code) {
      await within(pool, userId, async db => {
        await db.query("UPDATE commerce.analyzer_request SET state='failed',error_code=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND step='plan' AND state='received'", [userId, requestId, code]);
        await db.query("DELETE FROM finance.analyzer_provider_plan WHERE user_id=$1 AND request_id=$2 AND step='plan'", [userId, requestId]);
      });
    },
  };
  services.add(service); return service;
}
/** Metadata only, after the relevance gate. Never load transaction rows here. */
export async function yandexCatalog(db: PoolClient, userId: string): Promise<Catalog> {
  const accounts = (await db.query('SELECT id,display_name AS name FROM finance.account WHERE user_id=$1 AND merged_into_id IS NULL ORDER BY id LIMIT 101', [userId])).rows;
  const categories = (await db.query('SELECT id,name,parent_id AS "parentId",role FROM finance.category WHERE user_id=$1 AND hidden=false ORDER BY id LIMIT 101', [userId])).rows;
  const counterparties = (await db.query('SELECT id,name FROM finance.counterparty WHERE user_id=$1 AND merged_into_id IS NULL ORDER BY id LIMIT 101', [userId])).rows;
  for (const rows of [accounts, categories, counterparties]) {
    if (rows.length > 100) throw new HttpError(409, 'AI_CATALOG_LIMIT');
    for (const row of rows) row.name = safeText(row.name, 160);
  }
  return { accounts, categories, counterparties };
}
