import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { object } from '../../../packages/finance-core/src/model.ts';
import { rubAtoms } from '../../../packages/analyzer/src/cost.ts';
import { privateJson } from './kms.ts';
import { readAssistantPrivateFile } from './assistant-journal.ts';
import { remainingAssistantTrialBudget } from './assistant-budget.ts';
import { inspectCloudTaskModel } from './task-trial.ts';
import { assistantRuntimeManifest } from './analyzer-assistant-manifest.ts';
import { checkAssistantStagingSettings, assistantTariffSource } from './analyzer-assistant-settings.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';

// Verified against the current official tariff, rows 271/272. No future tariff.
export const assistantTariffCheckedAt = '2026-10-16T16:35:30Z';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: string) => { const n=BigInt(value);return (n/rubAtoms).toString()+'.'+(n%rubAtoms).toString().padStart(9,'0'); };
export type StagingSetupInput = { keyFile: string; budgetFiles: string[]; allowedEmails: string[]; outputFile: string };
/** Root-only preparation, exactly one catalog GET, no model POST. Previous
 * journals remain read-only and an existing pilot cannot acquire a new cap. */
export async function configureAssistantStaging(raw: unknown, fetcher: typeof fetch, now = new Date()) {
  if (process.getuid?.()!==0) throw new AssistantError('ASSISTANT_SETUP_ROOT_REQUIRED');
  const quoteAge=now.getTime()-Date.parse(assistantTariffCheckedAt);
  if(!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>=86400000)throw new AssistantError('ASSISTANT_TARIFF_STALE');
  const r=object(raw,['keyFile','budgetFiles','allowedEmails','outputFile']);
  if (![r.keyFile,r.outputFile].every(v=>typeof v==='string'&&isAbsolute(v)) || !Array.isArray(r.budgetFiles) || r.budgetFiles.length<1 || r.budgetFiles.length>20 ||
      r.budgetFiles.some(v=>typeof v!=='string'||!isAbsolute(v)) || new Set(r.budgetFiles).size!==r.budgetFiles.length || !Array.isArray(r.allowedEmails)) throw new AssistantError('ASSISTANT_SETUP_INPUT_INVALID');
  const input=r as StagingSetupInput, parent=dirname(input.outputFile), stat=await lstat(parent);
  if (!stat.isDirectory() || stat.uid!==0 || stat.mode&0o022 || await realpath(parent)!==parent) throw new AssistantError('ASSISTANT_SETUP_DIRECTORY_INVALID');
  const previousRaw=await Promise.all(input.budgetFiles.map(path=>readAssistantPrivateFile(path)));
  let previous: ReturnType<typeof remainingAssistantTrialBudget>|undefined;
  for(const value of previousRaw) previous=remainingAssistantTrialBudget(value,previous);
  const remaining=previous!;
  const manifest=await assistantRuntimeManifest();
  let existing;
  try {existing=checkAssistantStagingSettings(await privateJson(input.outputFile),now);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(existing){
    if(existing.sourceSha256!==manifest.sourceSha256 || existing.admission.budgetSha256!==remaining.previousBudgetSha256 || JSON.stringify(existing.allowedEmails)!==JSON.stringify(input.allowedEmails)) throw new AssistantError('ASSISTANT_SETUP_EXISTING_PILOT_CHANGED');
    return {sourceSha256:manifest.sourceSha256,configured:true,existing:true,maximumCalls:existing.maximumCalls,capRub:existing.cost.projectLimitRub,paidCalls:0};
  }
  const keys=await privateJson(input.keyFile),credentials=object(keys.cloud??keys,['apiKey']);
  const metadata=await inspectCloudTaskModel(credentials,fetcher);
  if(metadata.numericMetadata.context_length!==131072||metadata.numericMetadata.max_model_len!==131072)throw new AssistantError('ASSISTANT_MODEL_CHANGED');
  for(let i=0;i<input.budgetFiles.length;i++)if(hash(await readAssistantPrivateFile(input.budgetFiles[i]!))!==hash(previousRaw[i]))throw new AssistantError('ASSISTANT_PREVIOUS_BUDGET_CHANGED');
  const expiresAt=new Date(Date.parse(assistantTariffCheckedAt)+86400000).toISOString();
  const config=checkAssistantStagingSettings({realm:'staging/finance',apiKey:credentials.apiKey,allowedEmails:input.allowedEmails,sourceSha256:manifest.sourceSha256,
    modelMetadataSha256:metadata.modelMetadataSha256,maximumCalls:remaining.maximumCalls,expiresAt,tariffCheckedAt:assistantTariffCheckedAt,tariffSource:assistantTariffSource,
    admission:{budgetSha256:remaining.previousBudgetSha256,spentAtoms:remaining.spentAtoms,calls:remaining.calls,stageCapAtoms:remaining.authorization.capAtoms,stageMaximumCalls:remaining.authorization.maximumCalls},
    cost:{projectId:'staging/assistant-'+remaining.previousBudgetSha256.slice(0,24),projectPeriodStart:now.toISOString(),projectPeriodEnd:expiresAt,projectLimitRub:money(remaining.capAtoms),
      price:{version:'cloud-261015-oss120',currency:'RUB',inputRubPerMillion:'15.86',outputRubPerMillion:'61'}}},now);
  const file=await open(input.outputFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await file.writeFile(JSON.stringify(config)+'\n');await file.sync();}finally{await file.close();}
  const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  return {sourceSha256:manifest.sourceSha256,configured:true,existing:false,maximumCalls:remaining.maximumCalls,capRub:money(remaining.capAtoms),paidCalls:0};
}
