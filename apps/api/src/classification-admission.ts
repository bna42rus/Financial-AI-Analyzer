import {isDeepStrictEqual} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readAssistantPrivateFile} from './assistant-journal.ts';
import {classificationSmokeCase,classificationSmokeNames} from './classification-smoke-cases.ts';
import {digest,parseClassification} from './classification-plan.ts';
import {usageTokens} from '../../../packages/analyzer/src/cost.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
import {checkAssistantStagingSettings} from './analyzer-assistant-settings.ts';
import type {AssistantStagingSettings} from './analyzer-assistant-settings.ts';
import {continuedClassificationSettings} from './classification-smoke-support.ts';
import type {PilotTotals} from './classification-smoke-support.ts';
import type {ClassificationTariffVerification} from './classification-tariff.ts';
import type {PoolClient} from 'pg';

export async function confirmClassificationPaidReceipt(db:PoolClient,userId:string,projectId:string,fingerprint:string,usage:Usage,from:Date,through:Date){
 return (await db.query(`SELECT 1 FROM commerce.analyzer_request r JOIN commerce.ai_cost_reservation c USING(user_id,request_id,step)
  WHERE r.user_id=$1 AND r.provider='cashneuro-category-smoke/1' AND r.step='classification' AND r.fingerprint=$2 AND r.state='completed' AND r.usage_state='reported' AND c.state='settled'
  AND r.input_tokens=$3 AND r.output_tokens=$4 AND c.reported_input_tokens=$3 AND c.reported_output_tokens=$4 AND c.reported_model_version=$5
  AND r.model_version=$5 AND c.project_id=$8 AND c.settled_atoms IS NOT NULL
  AND r.created_at BETWEEN $6 AND $7`,[userId,fingerprint,usage.inputTokens,usage.outputTokens,usage.modelVersion,from,through,projectId])).rowCount===1;
}

export function classificationRuntimeAdmission(original:AssistantStagingSettings,totals:PilotTotals,sourceSha256:string,tariff:ClassificationTariffVerification,now=new Date()){
 if(!Number.isSafeInteger(totals.calls)||totals.calls<0||![totals.spentAtoms,totals.reservedAtoms].every(n=>typeof n==='string'&&/^(0|[1-9]\d{0,29})$/.test(n)))throw Error('CLASSIFICATION_ACCOUNTING_INVALID');
 if(totals.blocked)throw Error('CLASSIFICATION_RECONCILIATION_REQUIRED');
 // A still-valid source-only rebind does not renew authority, roll budgets
 // over or settle reservations. Saved, paid evidence may deploy UI fixes while
 // the existing runtime/dispatch guards continue to block unknown receipts.
 if(Date.parse(original.expiresAt)>now.getTime())return checkAssistantStagingSettings({...original,sourceSha256},now);
 if(BigInt(totals.reservedAtoms)!==0n)throw Error('CLASSIFICATION_RECONCILIATION_REQUIRED');
 const next=continuedClassificationSettings(original,totals,sourceSha256,tariff,now),expiresAt=new Date(Date.parse(tariff.checkedAt)+86400000).toISOString();
 return checkAssistantStagingSettings({...next,expiresAt,cost:{...next.cost,projectPeriodEnd:expiresAt}},now);
}

export async function validateClassificationEvidence(directory:string,confirm:(fingerprint:string,usage:Usage,from:Date,through:Date)=>Promise<boolean>,names:readonly typeof classificationSmokeNames[number][]=classificationSmokeNames){
 if(resolve(directory)!==directory||await realpath(directory)!==directory)throw Error('CLASSIFICATION_EVIDENCE_DIRECTORY_INVALID');
 const info=await lstat(directory);
 if(!info.isDirectory()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700)throw Error('CLASSIFICATION_EVIDENCE_DIRECTORY_INVALID');
 if(!names.length||new Set(names).size!==names.length||names.some(n=>!classificationSmokeNames.includes(n)))throw Error('CLASSIFICATION_EVIDENCE_CASES_INVALID');
 const hashes=[];
 for(const name of names){
  const path=(kind:string)=>join(directory,name+'-'+kind+'.json');
  const input=await readAssistantPrivateFile(path('input')),wire=await readAssistantPrivateFile(path('answer')),usage=await readAssistantPrivateFile(path('usage'));
  const sample=classificationSmokeCase(name);
  if(!isDeepStrictEqual(input,sample.input)||wire.httpStatus!==200||wire.modelMatches!==true||wire.finishReason!=='stop'||wire.role!=='assistant'||typeof wire.content!=='string'||wire.content.length>32768)throw Error('CLASSIFICATION_EVIDENCE_CHANGED');
  usageTokens(usage.inputTokens);usageTokens(usage.outputTokens);
  if(usage.modelVersion!=='openai/gpt-oss-120b'||wire.usage?.input!==usage.inputTokens||wire.usage?.output!==usage.outputTokens||wire.usage?.total!==usage.inputTokens+usage.outputTokens)throw Error('CLASSIFICATION_EVIDENCE_USAGE_INVALID');
  if(!sample.passed(parseClassification(JSON.parse(wire.content),sample.plan,sample.plan.groups)))throw Error('CLASSIFICATION_EVIDENCE_FAILED');
  const from=new Date((await lstat(path('input'))).mtimeMs-1000),through=new Date((await lstat(path('usage'))).mtimeMs+1000);
  if(!await confirm(digest(input),usage,from,through))throw Error('CLASSIFICATION_EVIDENCE_LEDGER_REQUIRED');
  hashes.push({name,input:digest(input),answer:digest(wire),usage:digest(usage)});
 }
 return {cases:names.length,evidenceSha256:digest(hashes),paidCalls:0};
}
