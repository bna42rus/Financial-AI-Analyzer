/** Explicit re-review of changed server interpretation. The old rejection and
 * spend remain immutable. A new physical ID shares the received understanding;
 * only slot 1 may dispatch. One refresh per original request, never a loop. */
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,access} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {checkedAssistantReceipt,readAssistantPrivateFile} from './assistant-journal.ts';
import {assistantRequestFingerprint} from './assistant-workflow.ts';
import type {AssistantRequest,AssistantJournal} from './assistant-workflow.ts';
import {nextCallFingerprint} from './analyzer-next-model-call.ts';
import {nextReviewInput,nextReviewPrompt,nextReviewSchema,nextReviewVersion} from './analyzer-next-review.ts';
import {assertClosedSchema} from '../../../packages/analyzer/src/closed-schema.ts';
import type {ProviderInput} from '../../../packages/analyzer/src/next/workflow.ts';
import {parseUnderstanding,workflowPrototypeVersion} from '../../../packages/analyzer/src/next/workflow.ts';
import {taskProjection} from '../../../packages/analyzer/src/next/tasks.ts';
import type {State,Environment} from '../../../packages/analyzer/src/next/tasks.ts';
import {understandingPrompt,understandingSchema} from '../../../packages/analyzer/src/next/understanding.ts';

type Manifest={accountBinding:string;caseSignature:string;ids:string[]};
const deny=():never=>{throw Error('PILOT_REVIEW_REFRESH_DENIED');};
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const path=(directory:string,id:string)=>join(directory,'review-refresh-'+id+'.json');
function checkMarker(m:any,manifest:Manifest,sourceId:string){
 if(m?.version!=='analyzer-next-review-refresh/1'||m.accountBinding!==manifest.accountBinding||m.caseSignature!==manifest.caseSignature||!isDeepStrictEqual(m.baseIds,manifest.ids)||m.sourceId!==sourceId||typeof m.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(m.id)||manifest.ids.includes(m.id))deny();
 return m as {id:string;sourceSha:string;reviewFingerprint:string};
}
export async function reviewRefreshBudgetIds(directory:string,manifest:Manifest,enabled:boolean){
 const ids:string[]=[];
 for(const id of manifest.ids)try{const m=checkMarker(await readAssistantPrivateFile(path(directory,id)),manifest,id);if(!enabled)throw Error('PILOT_REVIEW_REFRESH_FLAG_REQUIRED');ids.push(m.id);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(new Set(ids).size!==ids.length)deny();return ids;
}
export function refreshedReviewEvidence(raw:unknown,request:AssistantRequest,state:State,env:Environment){
 const receipt=checkedAssistantReceipt(raw,assistantRequestFingerprint(request)),first=receipt.calls[0],old=receipt.calls[1];
 if(receipt.result||receipt.calls.length!==2||first?.state!=='received'||!first.usage||first.phase!=='understand'||old?.state!=='received'||!old.usage||old.phase!=='check_changes')return null;
 assertClosedSchema(old.value,nextReviewSchema);if((old.value as {decision:string}).decision!=='reject')return null;
 const input:ProviderInput={version:workflowPrototypeVersion,question:env.question,date:env.date,context:taskProjection(state)};
 if(first.fingerprint!==nextCallFingerprint({phase:'understand',prompt:understandingPrompt,input,schema:understandingSchema}))deny();
 const reply=parseUnderstanding(first.value,state,env.question);
 const reviewFingerprint=nextCallFingerprint({phase:'check_changes',protocol:nextReviewVersion,prompt:nextReviewPrompt,input:nextReviewInput(input,reply,state,env),schema:nextReviewSchema});
 if(old.fingerprint===reviewFingerprint)return null;
 return {seed:structuredClone(first),sourceSha:sha(receipt),reviewFingerprint};
}
export async function prepareReviewRefresh(directory:string,manifest:Manifest,request:AssistantRequest,state:State,env:Environment){
 if(!manifest.ids.includes(request.requestId))deny();
 try{await access(join(directory,'journal',request.requestId+'.lock'));deny();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 let marker:any;try{marker=await readAssistantPrivateFile(path(directory,request.requestId));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 let raw;try{raw=await readAssistantPrivateFile(join(directory,'journal',request.requestId+'.json'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){if(marker)deny();return null;}throw e;}
 const evidence=refreshedReviewEvidence(raw,request,state,env);if(!evidence){if(marker)deny();return null;}
 const file=path(directory,request.requestId);
 if(!marker){
  marker={version:'analyzer-next-review-refresh/1',accountBinding:manifest.accountBinding,caseSignature:manifest.caseSignature,baseIds:manifest.ids,sourceId:request.requestId,id:randomUUID(),sourceSha:evidence.sourceSha,reviewFingerprint:evidence.reviewFingerprint};
  const fd=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(JSON.stringify(marker)+'\n');await fd.sync();}finally{await fd.close();}
  const parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 }
 const saved=checkMarker(marker,manifest,request.requestId);if(saved.sourceSha!==evidence.sourceSha||saved.reviewFingerprint!==evidence.reviewFingerprint)deny();
 return {request:{...request,requestId:saved.id},seed:evidence.seed};
}
export async function seedRefreshedUnderstanding(journal:AssistantJournal,seed:NonNullable<ReturnType<typeof refreshedReviewEvidence>>['seed']){
 if(!journal.receipt.calls.length){journal.receipt.calls.push(structuredClone(seed));await journal.persist();}
 else if(!isDeepStrictEqual(journal.receipt.calls[0],seed))deny();
}
