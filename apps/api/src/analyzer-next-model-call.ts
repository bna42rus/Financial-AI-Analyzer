/** Two explicit slots: understanding and semantic review. Reuses the existing
 * durable journal/reserve/settle adapter; never retries unknown delivery.
 * The caller must hold the existing per-request journal lock throughout. */
import {createHash} from 'node:crypto';
import {AssistantError} from '../../../packages/analyzer/src/assistant-plan.ts';
import type {AssistantJournal,AssistantModel,CompletionInput} from './assistant-workflow.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
export function nextCallFingerprint(input:CompletionInput){
 // PostgreSQL jsonb may reorder object keys. Array order and explicit nulls
 // retain their meaning; equivalent object key order never means a new call.
 const stable=JSON.stringify(input,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
 return createHash('sha256').update('cashneuro-next-call/1\0'+stable).digest('hex');
}
export async function nextModelCall(model:AssistantModel,journal:AssistantJournal,input:CompletionInput,index:0|1=0,dispatch:'allow'|'replay_only'='allow',legacyPilot=false){
 if(![0,1].includes(index)||!['allow','replay_only'].includes(dispatch)||typeof legacyPilot!=='boolean'||legacyPilot&&index!==0||input.phase!==(index===0?'understand':'check_changes')||journal.receipt.calls.length>2||journal.receipt.calls.length<index)throw new AssistantError('ASSISTANT_CALL_LIMIT');
 if(index===1&&(journal.receipt.calls[0]?.state!=='received'||journal.receipt.calls[0].phase!=='understand'||!journal.receipt.calls[0].usage))throw new AssistantError('ASSISTANT_REVIEW_PREREQUISITE');
 const fingerprint=legacyPilot?createHash('sha256').update(JSON.stringify(input)).digest('hex'):nextCallFingerprint(input),old=journal.receipt.calls[index];
 if(old){
  if(old.fingerprint!==fingerprint||old.phase!==input.phase)throw new AssistantError('ASSISTANT_REQUEST_CHANGED');
  if(old.state==='sent'||old.state==='unknown')throw new AssistantError('ASSISTANT_DELIVERY_UNKNOWN');
  if(old.state!=='received')throw new AssistantError(old.code??'ASSISTANT_MODEL_ERROR');
  if(!old.usage)throw new AssistantError('ASSISTANT_JOURNAL_INVALID');
  return {value:structuredClone(old.value),usage:structuredClone(old.usage),replayed:true};
 }
 if(dispatch==='replay_only')throw new AssistantError('PILOT_REPLAY_MISSING');
 let attempted=false,sent=false,usage:Usage|undefined;
 try{
  const result=await model.complete(input,async()=>{
   if(attempted)throw new AssistantError('ASSISTANT_DUPLICATE_DISPATCH');attempted=true;
   await journal.reserve(index,model.bound);journal.receipt.calls.push({fingerprint,phase:input.phase,state:'sent'});await journal.persist();sent=true;
  });
  if(!sent)throw new AssistantError('ASSISTANT_DISPATCH_NOT_RECORDED');
  usage=structuredClone(result.usage);const value=structuredClone(result.value);await journal.settle(index,structuredClone(usage));
  const changed=usage.modelVersion!==model.bound.modelVersion||usage.inputTokens>model.bound.inputTokens||usage.outputTokens>model.bound.outputTokens;
  Object.assign(journal.receipt.calls[index]!,{state:changed?'failed':'received',value,usage:structuredClone(usage),...(changed?{code:'ASSISTANT_PROVIDER_CHANGED'}:{})});await journal.persist();
  if(changed)throw new AssistantError('ASSISTANT_PROVIDER_CHANGED');
  return {value:structuredClone(value),usage:structuredClone(usage),replayed:false};
 }catch(error){
  if(sent&&journal.receipt.calls[index]!.state==='sent'){
   usage??=(error as {usage?:Usage})?.usage;await journal.settle(index,usage);
   Object.assign(journal.receipt.calls[index]!,{state:usage?'failed':'unknown',...(usage?{usage:structuredClone(usage)}:{}),code:usage?'ASSISTANT_RESPONSE_INVALID':'ASSISTANT_DELIVERY_UNKNOWN'});await journal.persist();
  }
  throw new AssistantError(sent&&journal.receipt.calls[index]?.state==='unknown'?'ASSISTANT_DELIVERY_UNKNOWN':error instanceof AssistantError?error.code:error instanceof Error&&/^(?:AI_|ASSISTANT_|PILOT_)[A-Z0-9_]{1,70}$/.test(error.message)?error.message:'ASSISTANT_MODEL_ERROR');
 }
}
