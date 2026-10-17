import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { inspectCloudTaskModel } from './task-trial.ts';
import { checkAssistantStagingSettings } from './analyzer-assistant-settings.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { AssistantModel } from './assistant-workflow.ts';
import { assistantWorkflowVersion } from './assistant-workflow.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { createCloudAssistantModel } from './assistant-transport.ts';
import { candidates } from './benchmark-transport.ts';
import { costPolicy } from './analyzer-cost.ts';
import type { CostPolicy } from './analyzer-cost.ts';

export type AssistantProvider = { readonly pool: Pool; readonly environment: 'test' | 'staging'; allowed(email: string): boolean; authorizeDispatch(db: PoolClient): Promise<void>; readonly model: AssistantModel; forRequest(): AssistantModel; readonly policy: CostPolicy; readonly binding: unknown };
const providers = new WeakSet<object>();
export const isAssistantProvider = (value: unknown): value is AssistantProvider => !!value && typeof value === 'object' && providers.has(value);
/** Isolated HTTP/DB acceptance only. No key loader, default fetch or live switch.
 * The explicit fetcher receives a synthetic key; it must be a test transport. */
export function createTestAssistantProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>): AssistantProvider {
  if (typeof fetcher !== 'function') throw new Error('ASSISTANT_PROVIDER_CONFIGURATION_DENIED');
  const model = createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher);
  const cost = costPolicy({ ...policy, price: candidates['cloud-oss'].price });
  const provider = Object.freeze({ pool, environment: 'test' as const, model, policy: cost, allowed: (_email: string) => true, async authorizeDispatch(_db: PoolClient) {},
    forRequest: () => createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher),
    binding: { workflow: assistantWorkflowVersion, plan: assistantVersion, bound: model.bound, cost } });
  providers.add(provider); return provider;
}

/** Explicit, short-lived Staging pilot. It cannot be constructed from a test
 * provider, activate Production, select arbitrary endpoints or retry a POST. */
export async function createStagingAssistantProvider(pool: Pool, raw: unknown, fetcher: typeof fetch, sourceSha256: string, now = () => new Date()): Promise<AssistantProvider> {
  const settings = checkAssistantStagingSettings(raw,now());
  if (sourceSha256 !== settings.sourceSha256) throw new AssistantError('ASSISTANT_RELEASE_CHANGED');
  const identity = (await pool.query('SELECT current_user AS role,current_database() AS name')).rows[0];
  if (identity?.role !== 'finance_api' || identity.name !== 'finance_staging') throw new AssistantError('ASSISTANT_DATABASE_DENIED');
  await pool.query('SELECT 1 FROM finance.assistant_run LIMIT 0');
  await pool.query('SELECT 1 FROM commerce.ai_cost_reservation LIMIT 0');
  const credentials = { apiKey: settings.apiKey };
  const metadata = await inspectCloudTaskModel(credentials,fetcher);
  if (metadata.modelMetadataSha256 !== settings.modelMetadataSha256 || metadata.numericMetadata.context_length !== 131072 || metadata.numericMetadata.max_model_len !== 131072) throw new AssistantError('ASSISTANT_MODEL_CHANGED');
  const model = createCloudAssistantModel(credentials,fetcher), snapshot = structuredClone(settings);
  const provider: AssistantProvider = Object.freeze({ pool,environment:'staging' as const, model,policy:settings.cost,
    allowed: (email: string) => settings.allowedEmails.includes(email.toLowerCase()),
    forRequest: () => createCloudAssistantModel(credentials,fetcher),
    async authorizeDispatch(db: PoolClient) {
      checkAssistantStagingSettings(settings,now());
      if (!isDeepStrictEqual(settings,snapshot)) throw new AssistantError('ASSISTANT_STAGING_CONFIGURATION_DENIED');
      // reserveCost holds the project row lock through this check; concurrent
      // users cannot race the total-call ceiling. A trigger counts all tenants
      // without exposing their RLS-protected receipts, including the new reserve.
      const count = Number((await db.query('SELECT dispatch_count AS n FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2', [settings.cost.projectId,settings.cost.projectPeriodStart])).rows[0].n);
      if (count > settings.maximumCalls) throw new AssistantError('ASSISTANT_PILOT_CALL_LIMIT');
    },
    binding:{workflow:assistantWorkflowVersion,plan:assistantVersion,sourceSha256,modelMetadataSha256:metadata.modelMetadataSha256,
      bound:model.bound,cost:settings.cost,admission:settings.admission,maximumCalls:settings.maximumCalls,expiresAt:settings.expiresAt,tariffCheckedAt:settings.tariffCheckedAt},
  });
  providers.add(provider);return provider;
}
