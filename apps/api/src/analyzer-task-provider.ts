import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TaskModel } from './analyzer-task-workflow.ts';
import { taskWorkflowBinding } from './analyzer-task-workflow.ts';
import { taskRelevancePrompt, taskRelevanceSchema, parseTaskRelevance, taskProposalPrompt, taskProposalSchema, parseTaskProposalWire } from '../../../packages/analyzer/src/task-protocol.ts';
import { candidates, createBenchmarkTransport, benchmarkRequestBody, BenchmarkFailure, correctedResponseContractVersion } from './benchmark-transport.ts';
import { costPolicy, reserveCost, settleCost } from './analyzer-cost.ts';
import type { CostPolicy } from './analyzer-cost.ts';
import type { Usage } from '../../../packages/analyzer/src/cost.ts';
import { CostError } from '../../../packages/analyzer/src/cost.ts';
import { stableJSON } from './finance-history.ts';
import { HttpError } from './types.ts';
import { intentTaskModel } from './analyzer-intent-model.ts';
import { intentRequestBody, intentWireVersion } from './task-intent-transport.ts';
import { taskIntentPrompt, taskIntentSchema, parseTaskIntent, taskIntentVersion } from '../../../packages/analyzer/src/task-intent.ts';

export async function taskTransaction<T>(pool: Pool, userId: string, action: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const result = await action(db); await db.query('COMMIT'); return result;
  } catch (error) { try { await db.query('ROLLBACK'); } catch { /* Preserve the original error. */ } throw error; }
  finally { db.release(); }
}
export type ProviderTask = { userId: string; id: string; binding: unknown; anchorAt: string; periodStart: string; question: string };
export type CloudTaskProvider = {
  pool: Pool; environment: 'test'; model: string; binding: unknown; billingPhase: 'gate' | 'plan';
  forTask(task: ProviderTask, guard: (db: PoolClient) => Promise<void>): TaskModel;
};
const providers = new WeakSet<object>();
export const isCloudTaskProvider = (value: unknown): value is CloudTaskProvider => !!value && typeof value === 'object' && providers.has(value);

/** Intentionally TEST ONLY until PostgreSQL + frozen real-model acceptance.
 * No default fetch, environment key loader or runtime enable switch exists.
 * Reuses the exact audited closed Cloud HTTP/usage parser; no automatic retry. */
export function createTestCloudTaskProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>): CloudTaskProvider {
  return testCloudProvider(pool, fetcher, policy, false);
}
export function createTestCloudIntentProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>): CloudTaskProvider {
  return testCloudProvider(pool, fetcher, policy, true);
}
function testCloudProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>, intent: boolean): CloudTaskProvider {
  if (typeof fetcher !== 'function') throw new Error('TASK_PROVIDER_CONFIGURATION_DENIED');
  const transport = createBenchmarkTransport('cloud-oss', { apiKey: 'synthetic-task-provider-key-for-tests-only' }, fetcher, 'empty-tools', intent ? intentRequestBody : benchmarkRequestBody);
  const cost = costPolicy({ ...policy, price: candidates['cloud-oss'].price });
  const binding = { ...taskWorkflowBinding, transport: 'cloud-task-http/1', responseContract: correctedResponseContractVersion,
    ...(intent ? { intent: taskIntentVersion, intentWire: intentWireVersion, billingPhase: 'gate' } : {}), model: transport.bound.modelVersion, bound: transport.bound, price: cost.price,
    project: { id: cost.projectId, start: cost.projectPeriodStart, end: cost.projectPeriodEnd, limit: cost.projectLimitRub } };
  const service: CloudTaskProvider = {
    pool, environment: 'test', model: transport.bound.modelVersion, binding, billingPhase: intent ? 'gate' : 'plan',
    forTask(task, guard) {
      async function call(step: 'gate' | 'plan', prompt: string, input: unknown, schema: unknown, parse: (value: unknown) => unknown) {
        // Exact bytes include all prompt/input/schema/transport and price versions.
        // No credential, catalog, raw finance row or provider free text is bound.
        const body = transport.requestBody!(prompt, input, schema);
        const fingerprint = createHash('sha256').update(stableJSON({ binding, claim: task.binding, userId: task.userId, step, body })).digest('hex');
        const read = async (db: PoolClient) => {
          await guard(db);
          const old = (await db.query('SELECT * FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3', [task.userId, task.id, step])).rows[0];
          if (!old) return null;
          if (old.fingerprint !== fingerprint || old.provider !== 'cloud-task/1' || old.model !== service.model) throw new HttpError(409, 'AI_REQUEST_CHANGED');
          if (old.state === 'sent' || old.usage_state === 'unknown') throw new HttpError(409, 'AI_DELIVERY_UNKNOWN');
          if (old.state === 'failed') throw new HttpError(502, old.error_code ?? 'AI_RESPONSE_INVALID');
          const cached = (await db.query('SELECT payload FROM finance.analyzer_task_cache WHERE user_id=$1 AND request_id=$2 AND step=$3', [task.userId, task.id, step])).rows[0];
          if (!cached) throw new HttpError(409, 'AI_RESPONSE_UNAVAILABLE');
          return { value: parse(cached.payload) };
        };
        const previous = await taskTransaction(pool, task.userId, read);
        if (previous) return previous.value;
        let reserved = false, receipt: Usage | undefined;
        try {
          const completed = await transport.complete(prompt, input, schema, async () => {
            await taskTransaction(pool, task.userId, async db => {
              await guard(db);
              await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cloud-task-dispatch:' + task.userId]);
              if ((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3', [task.userId, task.id, step])).rowCount) throw new HttpError(409, 'AI_REQUEST_IN_PROGRESS');
              // Unknown usage is a reconciliation gate, never zero cost. Pending
              // dispatch also prevents two independent requests racing the book.
              if ((await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1", [task.userId])).rowCount) throw new HttpError(409, 'AI_COST_RECONCILIATION_REQUIRED');
              await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state)
                VALUES($1,$2,$3,$4,'sent','cloud-task/1',$5,$6,$7,'not_sent')`, [task.userId, task.id, step, fingerprint, service.model, task.periodStart, task.anchorAt]);
              await reserveCost(db, { userId: task.userId, requestId: task.id, step, anchorAt: task.anchorAt, periodStart: task.periodStart }, cost, transport.bound);
            });
            reserved = true;
          });
          receipt = completed.usage;
          // Cost/usage persists before parsing or a private cache write. Chat
          // deletion/cancellation can never roll an actual provider cost back.
          const violation = await taskTransaction(pool, task.userId, db => settleCost(db, task.userId, task.id, step, receipt));
          if (violation) throw new HttpError(409, 'AI_PROVIDER_CONTRACT_CHANGED');
          let value: unknown;
          try { value = parse(completed.value); } catch { throw new HttpError(502, 'AI_PLAN_INVALID'); }
          await taskTransaction(pool, task.userId, async db => {
            await guard(db);
            await db.query('INSERT INTO finance.analyzer_task_cache(user_id,request_id,step,payload) VALUES($1,$2,$3,$4)', [task.userId, task.id, step, JSON.stringify(value)]);
            await db.query("UPDATE commerce.analyzer_request SET state='received',updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state='sent'", [task.userId, task.id, step]);
          });
          return value;
        } catch (error) {
          if (!reserved) {
            // The reserve callback did not return: no HTTP dispatch.
            if (error instanceof CostError) throw new HttpError(error.code.endsWith('EXHAUSTED') ? 429 : 409, error.code);
            throw error;
          }
          receipt ??= error instanceof BenchmarkFailure ? error.usage : undefined;
          const code = error instanceof HttpError ? error.code : error instanceof BenchmarkFailure && error.code === 'BENCH_RESPONSE_INVALID' ? 'AI_RESPONSE_INVALID' : 'AI_DELIVERY_UNKNOWN';
          await taskTransaction(pool, task.userId, async db => {
            await settleCost(db, task.userId, task.id, step, receipt);
            await db.query(`UPDATE commerce.analyzer_request SET state=$4,error_code=$5,usage_state=$6,updated_at=clock_timestamp()
              WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state='sent'`, [task.userId, task.id, step, receipt ? 'failed' : 'unknown', code, receipt ? 'reported' : 'unknown']);
          });
          throw new HttpError(error instanceof HttpError ? error.status : receipt ? 502 : 409, code);
        }
      }
      if (intent) return intentTaskModel(input => call('gate', taskIntentPrompt, input, taskIntentSchema, value => parseTaskIntent(value, task.question)));
      return {
        relevance: input => call('gate', taskRelevancePrompt, input, taskRelevanceSchema, parseTaskRelevance),
        proposal: input => call('plan', taskProposalPrompt, input, taskProposalSchema, value => parseTaskProposalWire(value, task.question)),
      };
    },
  };
  providers.add(service); return service;
}
