import type { Pool } from 'pg';
import type { AssistantModel } from './assistant-workflow.ts';
import { assistantWorkflowVersion } from './assistant-workflow.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { createCloudAssistantModel } from './assistant-transport.ts';
import { candidates } from './benchmark-transport.ts';
import { costPolicy } from './analyzer-cost.ts';
import type { CostPolicy } from './analyzer-cost.ts';

export type AssistantProvider = { readonly pool: Pool; readonly environment: 'test'; readonly model: AssistantModel; forRequest(): AssistantModel; readonly policy: CostPolicy; readonly binding: unknown };
const providers = new WeakSet<object>();
export const isAssistantProvider = (value: unknown): value is AssistantProvider => !!value && typeof value === 'object' && providers.has(value);
/** Isolated HTTP/DB acceptance only. No key loader, default fetch or live switch.
 * The explicit fetcher receives a synthetic key; it must be a test transport. */
export function createTestAssistantProvider(pool: Pool, fetcher: typeof fetch, policy: Omit<CostPolicy, 'price'>): AssistantProvider {
  if (typeof fetcher !== 'function') throw new Error('ASSISTANT_PROVIDER_CONFIGURATION_DENIED');
  const model = createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher);
  const cost = costPolicy({ ...policy, price: candidates['cloud-oss'].price });
  const provider = Object.freeze({ pool, environment: 'test' as const, model, policy: cost,
    forRequest: () => createCloudAssistantModel({ apiKey: 'synthetic-assistant-key-for-tests-only' }, fetcher),
    binding: { workflow: assistantWorkflowVersion, plan: assistantVersion, bound: model.bound, cost } });
  providers.add(provider); return provider;
}
