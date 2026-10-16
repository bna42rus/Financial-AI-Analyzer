import { object } from '../../../packages/finance-core/src/model.ts';
import { rubAmount } from '../../../packages/analyzer/src/cost.ts';
import { costPolicy } from './analyzer-cost.ts';
import type { CostPolicy } from './analyzer-cost.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';

export type AssistantStagingSettings = { realm: 'staging/finance'; apiKey: string; allowedEmails: string[]; sourceSha256: string; modelMetadataSha256: string;
  admission: { budgetSha256: string; spentAtoms: string; calls: number; stageCapAtoms: string; stageMaximumCalls: number }; maximumCalls: number; expiresAt: string; tariffCheckedAt: string; tariffSource: string; cost: CostPolicy };
export const assistantTariffSource = 'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf';
export function checkAssistantStagingSettings(value: unknown, now = new Date()): AssistantStagingSettings {
  const r = object(value, ['realm','apiKey','allowedEmails','sourceSha256','modelMetadataSha256','admission','maximumCalls','expiresAt','tariffCheckedAt','tariffSource','cost']);
  const denied = () => { throw new AssistantError('ASSISTANT_STAGING_CONFIGURATION_DENIED'); };
  if (r.realm !== 'staging/finance' || typeof r.apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(r.apiKey) ||
      ![r.sourceSha256,r.modelMetadataSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
      !Array.isArray(r.allowedEmails) || r.allowedEmails.length < 1 || r.allowedEmails.length > 5 || new Set(r.allowedEmails).size !== r.allowedEmails.length ||
      r.allowedEmails.some(v => typeof v !== 'string' || v !== v.toLowerCase() || !/^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{1,50}$/.test(v)) ||
      !Number.isSafeInteger(r.maximumCalls) || Number(r.maximumCalls) < 1 || Number(r.maximumCalls) > 70 ||
      typeof r.expiresAt !== 'string' || typeof r.tariffCheckedAt !== 'string' || r.tariffSource !== assistantTariffSource) return denied();
  const checked = Date.parse(r.tariffCheckedAt), expires = Date.parse(r.expiresAt), at = now.getTime();
  if (![checked,expires,at].every(Number.isFinite) || checked > at || at - checked > 86400000 || expires <= at || expires - checked > 86400000) return denied();
  const admission = object(r.admission, ['budgetSha256','spentAtoms','calls','stageCapAtoms','stageMaximumCalls']);
  if (typeof admission.budgetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(admission.budgetSha256) ||
      typeof admission.spentAtoms !== 'string' || !/^(0|[1-9]\d{0,10})$/.test(admission.spentAtoms) ||
      typeof admission.stageCapAtoms !== 'string' || !/^[1-9]\d{0,10}$/.test(admission.stageCapAtoms) || BigInt(admission.stageCapAtoms)>10_000_000_000n ||
      !Number.isSafeInteger(admission.calls) || Number(admission.calls)<0 || !Number.isSafeInteger(admission.stageMaximumCalls) || Number(admission.stageMaximumCalls)>70 ||
      Number(admission.stageMaximumCalls)-Number(admission.calls)!==r.maximumCalls) return denied();
  const cost = costPolicy(r.cost);
  if (rubAmount(cost.projectLimitRub)!==BigInt(admission.stageCapAtoms)-BigInt(admission.spentAtoms)) return denied();
  if (cost.price.inputRubPerMillion !== '15.86' || cost.price.outputRubPerMillion !== '61' || rubAmount(cost.projectLimitRub) > 10_000_000_000n ||
      Date.parse(cost.projectPeriodStart) > at || Date.parse(cost.projectPeriodEnd) !== expires) return denied();
  return { ...r, admission, cost } as AssistantStagingSettings;
}
