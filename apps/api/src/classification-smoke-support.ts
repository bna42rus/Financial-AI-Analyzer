/** Operator-only synthetic diagnostics. Never used to archive customer calls. */
import {constants} from 'node:fs';
import {mkdtemp,open,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {checkAssistantStagingSettings} from './analyzer-assistant-settings.ts';
import {digest} from './classification-plan.ts';
import type {Pool,PoolClient} from 'pg';
import {classificationTariffDocumentSha256} from './classification-tariff.ts';
import type {ClassificationTariffVerification} from './classification-tariff.ts';

export type PilotTotals={calls:number;spentAtoms:string;reservedAtoms:string;blocked:boolean};
export async function classificationPilotTotals(db:Pool|PoolClient,projectId:string,since?:string):Promise<PilotTotals>{
 const r=(await db.query(`SELECT count(*) AS epochs,COALESCE(sum(dispatch_count),0)::text AS calls,
  COALESCE(sum(spent_atoms),0)::text AS spent,COALESCE(sum(reserved_atoms),0)::text AS reserved,
  COALESCE(bool_or(blocked),false) AS blocked FROM commerce.ai_project_budget WHERE project_id=$1 AND ($2::timestamptz IS NULL OR period_start>=$2::timestamptz)`,[projectId,since??null])).rows[0];
 if(Number(r.epochs)<1)throw Error('CLASSIFICATION_PREVIOUS_BUDGET_REQUIRED');
 return {calls:Number(r.calls),spentAtoms:r.spent as string,reservedAtoms:r.reserved as string,blocked:r.blocked as boolean};
}
const money=(n:bigint)=>(n/1_000_000_000n)+'.'+(n%1_000_000_000n).toString().padStart(9,'0');
export function continuedClassificationSettings(raw:unknown,totals:PilotTotals,sourceSha256:string,tariff:ClassificationTariffVerification,now=new Date()){
 const r=raw as Record<string,any>;
 const historical=new Date(Math.max(Date.parse(r?.tariffCheckedAt),Date.parse(r?.cost?.projectPeriodStart))+1);
 const old=checkAssistantStagingSettings(raw,historical),at=now.getTime(),checked=Date.parse(tariff?.checkedAt);
 if(!Number.isFinite(checked)||tariff.documentSha256!==classificationTariffDocumentSha256||at<checked||at-checked>=86400000)throw Error('CLASSIFICATION_TARIFF_VERIFICATION_REQUIRED');
 if(at<Date.parse(old.expiresAt))throw Error('CLASSIFICATION_CONTINUATION_NOT_AVAILABLE');
 if(!Number.isSafeInteger(totals.calls)||totals.calls<0||![totals.spentAtoms,totals.reservedAtoms].every(n=>/^(0|[1-9]\d{0,29})$/.test(n)))throw Error('CLASSIFICATION_ACCOUNTING_INVALID');
 if(totals.blocked||BigInt(totals.reservedAtoms)!==0n)throw Error('CLASSIFICATION_RECONCILIATION_REQUIRED');
 const spent=BigInt(old.admission.spentAtoms)+BigInt(totals.spentAtoms),calls=old.admission.calls+totals.calls;
 const remaining=BigInt(old.admission.stageCapAtoms)-spent,maximumCalls=old.admission.stageMaximumCalls-calls;
 if(remaining<=0n||maximumCalls<1)throw Error('CLASSIFICATION_ORIGINAL_LIMIT_EXHAUSTED');
 const expiresAt=new Date(Math.min(at+7200000,checked+86400000)).toISOString();
 return checkAssistantStagingSettings({...old,sourceSha256,maximumCalls,expiresAt,tariffCheckedAt:tariff.checkedAt,
  admission:{...old.admission,spentAtoms:spent.toString(),calls,budgetSha256:digest({previous:old.admission.budgetSha256,totals})},
  cost:{...old.cost,projectPeriodStart:now.toISOString(),projectPeriodEnd:expiresAt,projectLimitRub:money(remaining)}},now);
}

export function classificationFailure(error:unknown){
 const e=error as {code?:unknown;message?:unknown;responsePhase?:unknown};
 const candidates=[e?.code,e?.message];
 const code=candidates.find(v=>typeof v==='string'&&/^(?:(?:CLASSIFICATION|BENCH|ASSISTANT|AI|FINANCE|PRIVATE|STAGING|TEST_ACCOUNT|EXPLICIT_OPERATOR|INVALID)_[A-Z0-9_]{1,75}|PROVIDER_CHANGED|RECONCILIATION_REQUIRED|[0-9A-Z]{5}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(v))??'CLASSIFICATION_CHECK_FAILED';
 const responsePhase=typeof e?.responsePhase==='string'&&['BODY','USAGE','DETAILS','MODEL','CHOICES','FINISH','ROLE','REFUSAL','TOOL_CALLS','FUNCTION_CALL','CONTENT','JSON'].includes(e.responsePhase)?e.responsePhase:undefined;
 return {code,responsePhase};
}

export async function syntheticClassificationArchive(parent:string,apiKey:string){
 const info=await lstat(parent);
 if(!info.isDirectory()||info.uid!==process.getuid?.()||info.mode&0o022||await realpath(parent)!==parent)throw Error('CLASSIFICATION_ARCHIVE_DIRECTORY_INVALID');
 const directory=await mkdtemp(join(parent,'classification-check-'));
 async function save(name:string,value:unknown){
  if(!/^[a-z0-9-]+\.json$/.test(name))throw Error('CLASSIFICATION_ARCHIVE_NAME_INVALID');
  const text=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(text)>262144||!apiKey||text.includes(apiKey))throw Error('CLASSIFICATION_ARCHIVE_REDACTION_REQUIRED');
  const fd=await open(join(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(text);await fd.sync();}finally{await fd.close();}
  const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
 }
 return {directory,save};
}

/** The only accepted outbound body is this case's fixed synthetic input.
 * Capture answer content before transport/closed-schema validation; never copy
 * credentials, headers, source documents, hidden reasoning or provider bodies. */
export function syntheticClassificationFetch(fetcher:typeof fetch,save:(name:string,value:unknown)=>Promise<void>,expected:()=>{name:string;input:unknown}|undefined):typeof fetch{
 return async(url,options)=>{
  if(String(url)==='https://foundation-models.api.cloud.ru/v1/models'&&options?.method==='GET')return fetcher(url,options);
  const current=expected();
  if(!current||String(url)!=='https://foundation-models.api.cloud.ru/v1/chat/completions'||options?.method!=='POST'||typeof options.body!=='string')throw Error('CLASSIFICATION_SYNTHETIC_ONLY');
  const body=JSON.parse(options.body);
  if(body.messages?.length!==2||body.messages[1]?.content!==JSON.stringify(current.input))throw Error('CLASSIFICATION_SYNTHETIC_ONLY');
  const response=await fetcher(url,options);
  // A clone leaves the original bounded transport and usage checks intact.
  const reader=response.clone().body?.getReader();let size=0;const parts:Uint8Array[]=[];
  try{
   if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>131072)throw Error('CLASSIFICATION_RESPONSE_TOO_LARGE');parts.push(part.value);}
   let wire:unknown;
   try{
    const raw=JSON.parse(Buffer.concat(parts).toString('utf8')),choice=raw?.choices?.[0],message=choice?.message;
    const tokens=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=1000000?v:'invalid';
    wire={httpStatus:response.status,modelMatches:raw?.model==='openai/gpt-oss-120b',
     usage:{input:tokens(raw?.usage?.prompt_tokens),output:tokens(raw?.usage?.completion_tokens),total:tokens(raw?.usage?.total_tokens)},
     finishReason:['stop','length','tool_calls','content_filter','function_call'].includes(choice?.finish_reason)?choice.finish_reason:'other',
     role:message?.role==='assistant'?'assistant':'other',content:typeof message?.content==='string'&&message.content.length<=32768?message.content:null};
   }catch{wire={httpStatus:response.status,bodyIsJson:false};}
   await save(current.name+'-answer.json',wire);
  }finally{void reader?.cancel().catch(()=>{});reader?.releaseLock();}
  return response;
 };
}
