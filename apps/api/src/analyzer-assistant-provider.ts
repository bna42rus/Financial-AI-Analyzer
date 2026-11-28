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
import { monthlyPolicy, prepareMonthlyDispatch, authorizeMonthlyDispatch, monthlyBudgetState } from './assistant-monthly.ts';
import type { MonthlyBudgetState } from './assistant-monthly.ts';

export type AssistantProvider = { readonly pool: Pool; readonly environment: 'test' | 'staging'; readonly costPeriod?: 'project'; allowed(email: string): boolean; budgetState?(db: PoolClient): Promise<MonthlyBudgetState | undefined>; prepareDispatch?(db: PoolClient, policy: CostPolicy): Promise<void>; authorizeDispatch(db: PoolClient, policy?: CostPolicy): Promise<void>; readonly model: AssistantModel; forRequest(purpose?: 'assistant'|'classification'): AssistantModel; readonly policy: CostPolicy; readonly binding: unknown };
const providers = new WeakSet<object>();
export class AssistantModelAdmissionError extends AssistantError {
  readonly diagnostic: unknown;
  constructor(diagnostic: unknown) { super('ASSISTANT_MODEL_CHANGED'); this.diagnostic=diagnostic; }
}
export const isAssistantProvider = (value: unknown): value is AssistantProvider => !!value && typeof value === 'object' && providers.has(value);
/** Isolated HTTP/DB acceptance only. No key loader, default fetch or live switch.
 * The explicit fetcher receives a synthetic key; it must be a test transport. */
export function createTestAssistantProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>, allowedEmails?:readonly string[]): AssistantProvider {
  if (typeof fetcher !== 'function') throw new Error('ASSISTANT_PROVIDER_CONFIGURATION_DENIED');
  const model = createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher);
  const cost = costPolicy({ ...policy, price: candidates['cloud-oss'].price });
  const provider = Object.freeze({ pool, environment: 'test' as const, model, policy: cost, allowed: (email: string) => !allowedEmails||allowedEmails.includes(email.toLowerCase()), async authorizeDispatch(_db: PoolClient) {},
    forRequest: (purpose: 'assistant'|'classification' = 'assistant') => createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher,purpose),
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
  const model = createCloudAssistantModel(credentials,fetcher), snapshot = structuredClone(settings);
  const classification = createCloudAssistantModel(credentials,fetcher,'classification');
  const hashMatches=metadata.modelMetadataSha256===settings.modelMetadataSha256;
  const versioned=metadata.metadataFieldsPresent.some(k=>['version','revision','snapshot'].includes(k));
  const n=metadata.numericMetadata,has=(key:string)=>metadata.metadataFieldsPresent.includes(key);
  const limitsMatch=n.context_length===candidates['cloud-oss'].contextTokens&&n.max_model_len===candidates['cloud-oss'].contextTokens&&
    (!has('max_input_tokens')||n.max_input_tokens!==undefined&&n.max_input_tokens>=model.bound.inputTokens)&&
    (!has('max_output_tokens')||n.max_output_tokens!==undefined&&n.max_output_tokens>=Math.max(model.bound.outputTokens,classification.bound.outputTokens));
  // An unversioned /models card is an operational contract, not a weights
  // attestation. Monthly mode tolerates non-contract metadata drift; explicit
  // version/revision/snapshot changes and incompatible limits still stop it.
  const monthlyContract=!!settings.monthly&&!versioned;
  const modelAdmission={model:metadata.model,hashMatches,versioned,limitsMatch,monthlyContract,
    expectedHash:settings.modelMetadataSha256,actualHash:metadata.modelMetadataSha256,numericMetadata:n,immutableModelVersionVerified:false};
  if(!limitsMatch||!hashMatches&&!monthlyContract)throw new AssistantModelAdmissionError(modelAdmission);
  // Owner-managed price schedule. Monthly verification is manual; no tariff
  // PDF, parser, quote refresh or freshness dependency is on the request path.
  const requestModel = (purpose: 'assistant'|'classification' = 'assistant') =>
    createCloudAssistantModel(credentials,fetcher,purpose);
  const provider: AssistantProvider = Object.freeze({ pool,environment:'staging' as const, model,
    costPeriod: settings.monthly ? 'project' as const : undefined,
    get policy() { return settings.monthly ? monthlyPolicy(settings.cost, settings.monthly, now()) : settings.cost; },
    allowed: (email: string) => settings.allowedEmails.includes(email.toLowerCase()),
    async budgetState(db: PoolClient) { return settings.monthly ? monthlyBudgetState(db, provider.policy) : undefined; },
    forRequest: requestModel,
    async prepareDispatch(db: PoolClient, policy: CostPolicy) { if (settings.monthly) await prepareMonthlyDispatch(db, policy); },
    async authorizeDispatch(db: PoolClient, policy = provider.policy) {
      checkAssistantStagingSettings(settings,now());
      if (!isDeepStrictEqual(settings,snapshot)) throw new AssistantError('ASSISTANT_STAGING_CONFIGURATION_DENIED');
      if (settings.monthly) { await authorizeMonthlyDispatch(db, policy, now()); return; }
      // reserveCost holds the project row lock through this check; concurrent
      // users cannot race the total-call ceiling. A trigger counts all tenants
      // without exposing their RLS-protected receipts, including the new reserve.
      const count = Number((await db.query('SELECT dispatch_count AS n FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2', [settings.cost.projectId,settings.cost.projectPeriodStart])).rows[0].n);
      if (count > settings.maximumCalls) throw new AssistantError('ASSISTANT_PILOT_CALL_LIMIT');
    },
    binding:{workflow:assistantWorkflowVersion,plan:assistantVersion,sourceSha256,modelMetadataSha256:metadata.modelMetadataSha256,modelAdmission,
      bound:model.bound,cost:settings.cost,admission:settings.admission,...(settings.monthly ? { monthly: settings.monthly } : { maximumCalls:settings.maximumCalls,expiresAt:settings.expiresAt,tariffCheckedAt:settings.tariffCheckedAt })},
  });
  providers.add(provider);return provider;
}
