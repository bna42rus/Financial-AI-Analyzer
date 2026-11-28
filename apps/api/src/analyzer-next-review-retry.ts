/** One explicit operator retry of the first rejected source-only read.
 * Never rewrites a receipt or grants another monetary budget. */
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readAssistantPrivateFile,checkedAssistantReceipt} from './assistant-journal.ts';
import {assistantRequestFingerprint} from './assistant-workflow.ts';
import type {AssistantRequest} from './assistant-workflow.ts';
import {understandingPrompt} from '../../../packages/analyzer/src/next/understanding.ts';
import {prepareTask,emptyState} from '../../../packages/analyzer/src/next/tasks.ts';
import type {Environment} from '../../../packages/analyzer/src/next/tasks.ts';
import {parseIntent} from '../../../packages/analyzer/src/next/intent.ts';
import {assistantAmountLiteral} from '../../../packages/analyzer/src/assistant-money.ts';
import {reviewPilotCases,reviewPilotVersion,reviewPilotSignature} from './analyzer-next-review-pilot.ts';

type Manifest={version:string;accountBinding:string;caseSignature:string;ids:string[]};
function deny():never{throw Error('PILOT_RETRY_DENIED');}
export function validateFirstReviewRetry(raw:unknown,request:AssistantRequest,env:Environment,otherReceipts:boolean){
 const receipt=checkedAssistantReceipt(raw,assistantRequestFingerprint(request));
 const call=receipt.calls[0];if(otherReceipts||receipt.result||receipt.calls.length!==1||!call||call.state!=='received'||!call.usage)return deny();
 const intent=parseIntent((call.value as {intent:unknown})?.intent);
 if(intent.action!=='read')return deny();if(intent.binding.mode!=='new')return deny();
 const amount=intent.parameters.conditions.filter(e=>e.field==='amount'),edit=amount[0];if(amount.length!==1||!edit||edit.op!=='set')return deny();
 const bounds=assistantAmountLiteral(edit.expression,'absolute_operation'),expected=reviewPilotCases[0]!.expected;
 if(expected.kind!=='read'||bounds.amountFrom===expected.filter.amountFrom&&bounds.amountThrough===expected.filter.amountThrough)deny();
 let rejected=false;try{prepareTask(emptyState(env.scope),env,intent);}catch(e){rejected=e instanceof Error&&e.message==='TASK_AMOUNT_LITERAL_REQUIRED';}
 if(!rejected)deny();
}
export async function firstReviewRetry(directory:string,manifest:Manifest,request:AssistantRequest,env:Environment){
 if(manifest.version!==reviewPilotVersion||manifest.caseSignature!==reviewPilotSignature||manifest.ids.length!==5||request.requestId!==manifest.ids[0])deny();
 const path=join(directory,'review-first-retry.json'),promptSha256=createHash('sha256').update(understandingPrompt).digest('hex');let saved:any;
 try{saved=await readAssistantPrivateFile(path);}catch(e){
  if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  let other=false;for(const id of manifest.ids.slice(1))try{await readAssistantPrivateFile(join(directory,'journal',id+'.json'));other=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  validateFirstReviewRetry(await readAssistantPrivateFile(join(directory,'journal',manifest.ids[0]+'.json')),request,env,other);
  saved={version:'analyzer-next-review-first-retry/1',accountBinding:manifest.accountBinding,caseSignature:manifest.caseSignature,baseIds:manifest.ids,promptSha256,id:randomUUID()};
  const fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(JSON.stringify(saved)+'\n');await fd.sync();}finally{await fd.close();}
  const parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 }
 if(saved.version!=='analyzer-next-review-first-retry/1'||saved.accountBinding!==manifest.accountBinding||saved.caseSignature!==manifest.caseSignature||!isDeepStrictEqual(saved.baseIds,manifest.ids)||saved.promptSha256!==promptSha256||typeof saved.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.id)||manifest.ids.includes(saved.id))deny();
 return {ids:[saved.id,...manifest.ids.slice(1)],budgetIds:[...manifest.ids,saved.id]};
}
