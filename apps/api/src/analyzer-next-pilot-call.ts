/** Reuses the existing private AssistantJournal and its reserve/settle contract.
 * No automatic repair/retry; unknown delivery is never dispatched again. */
import {createHash} from 'node:crypto';
import {AssistantError} from '../../../packages/analyzer/src/assistant-plan.ts';
import type {AssistantJournal,AssistantModel,CompletionInput} from './assistant-workflow.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
export async function pilotModelCall(model:AssistantModel,journal:AssistantJournal,input:CompletionInput,dispatch:'allow'|'replay_only'='allow'){
 const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex'),old=journal.receipt.calls[0];
 if(old){
  if(old.fingerprint!==fingerprint||old.phase!==input.phase)throw new AssistantError('ASSISTANT_REQUEST_CHANGED');
  if(old.state==='sent'||old.state==='unknown')throw new AssistantError('ASSISTANT_DELIVERY_UNKNOWN');
  if(old.state!=='received')throw new AssistantError(old.code??'ASSISTANT_MODEL_ERROR');
  return {value:structuredClone(old.value),usage:old.usage!,replayed:true};
 }
 if(dispatch==='replay_only')throw new AssistantError('PILOT_REPLAY_MISSING');
 let sent=false,usage:Usage|undefined;
 try{
  const result=await model.complete(input,async()=>{
   if(sent)throw new AssistantError('ASSISTANT_DUPLICATE_DISPATCH');
   await journal.reserve(0,model.bound);journal.receipt.calls.push({fingerprint,phase:input.phase,state:'sent'});await journal.persist();sent=true;
  });
  if(!sent)throw new AssistantError('ASSISTANT_DISPATCH_NOT_RECORDED');
  usage=result.usage;await journal.settle(0,usage);
  const changed=usage.modelVersion!==model.bound.modelVersion||usage.inputTokens>model.bound.inputTokens||usage.outputTokens>model.bound.outputTokens;
  Object.assign(journal.receipt.calls[0]!,{state:changed?'failed':'received',value:result.value,usage,...(changed?{code:'ASSISTANT_PROVIDER_CHANGED'}:{})});await journal.persist();
  if(changed)throw new AssistantError('ASSISTANT_PROVIDER_CHANGED');
  return {value:structuredClone(result.value),usage,replayed:false};
 }catch(error){
  if(sent&&journal.receipt.calls[0]!.state==='sent'){
   usage??=(error as {usage?:Usage})?.usage;await journal.settle(0,usage);
   Object.assign(journal.receipt.calls[0]!,{state:usage?'failed':'unknown',...(usage?{usage}:{}),code:usage?'ASSISTANT_RESPONSE_INVALID':'ASSISTANT_DELIVERY_UNKNOWN'});await journal.persist();
  }
  throw new AssistantError(sent&&journal.receipt.calls[0]?.state==='unknown'?'ASSISTANT_DELIVERY_UNKNOWN':error instanceof AssistantError?error.code:error instanceof Error&&/^(?:AI_|ASSISTANT_|PILOT_)[A-Z0-9_]{1,70}$/.test(error.message)?error.message:'ASSISTANT_MODEL_ERROR');
 }
}
