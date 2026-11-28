/** Compatibility entry point: original pilot fingerprints and receipt slots
 * are unchanged. Runtime integration uses the same adapter with review slot 1. */
import {nextModelCall} from './analyzer-next-model-call.ts';
import type {AssistantJournal,AssistantModel,CompletionInput} from './assistant-workflow.ts';
export function pilotModelCall(model:AssistantModel,journal:AssistantJournal,input:CompletionInput,dispatch:'allow'|'replay_only'='allow'){
 return nextModelCall(model,journal,input,0,dispatch,true);
}
