/** Inactive, in-memory orchestration prototype. No network implementation,
 * API route, durable journal, mutations or billing. Dependencies are mandatory.
 */
import {emptyState,prepareTask,executeTask,finishTask,taskProjection,PreparationError} from './tasks.ts';
import type {State,Environment,Prepared,Outcome,Preparation} from './tasks.ts';
import {parseIntent} from './intent.ts';
import type {Intent} from './intent.ts';
import {safeText} from '../../../privacy/src/text.ts';
import {object,choice,uuid} from '../../../finance-core/src/model.ts';
import {emptyTaskBook,globalSnapshot} from '../task-context.ts';
import type {TaskScope} from '../task-context.ts';

export const workflowPrototypeVersion='cashneuro-workflow-prototype/1';
export type ProviderInput={version:typeof workflowPrototypeVersion;question:string;date:string;context:ReturnType<typeof taskProjection>};
export type Understanding={relevance:'financial'|'adjacent';intent:Intent}|{relevance:'ambiguous'|'unrelated';intent:null};
export type Provider={understand:(input:ProviderInput)=>Promise<unknown>};
export type AccessContext=Pick<Environment,'scope'|'accessRevision'|'dataRevision'>;
export type Services={
 current:()=>AccessContext;
 authorize:(context:AccessContext)=>Promise<void>;
 review:(input:ProviderInput,reply:Understanding)=>Promise<boolean>;
 tools:Parameters<typeof executeTask>[1];
};
type WithoutState<T>=T extends unknown?Omit<T,'state'>:never;
type Terminal=WithoutState<Extract<Preparation,{status:'waiting'|'explanation'|'unsupported'}>>;
type TurnBody=
 {status:'completed';outcome:Outcome}|
 {status:'waiting'|'explanation'|'unsupported';preparation:Terminal}|
 {status:'unrelated'|'ambiguous'|'discarded'|'failed';code:string};
export type TurnResult={replayed:boolean;understandingCalls:number;asOfRevision:string;historical:boolean}&TurnBody;
class WorkflowError extends TypeError {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new WorkflowError(code);}
const clone=<T>(value:T):T=>structuredClone(value);
function sameScope(a:TaskScope,b:TaskScope){return ['ownerId','chatId','chatEpoch','generation'].every(k=>a[k as keyof TaskScope]===b[k as keyof TaskScope]);}
function parseUnderstanding(raw:unknown):Understanding{
 const r=object(raw,['relevance','intent']);
 if(Object.keys(r).length!==2||!Object.hasOwn(r,'intent'))fail('PROVIDER_REPLY_INVALID');
 const relevance=choice(r.relevance,['financial','adjacent','ambiguous','unrelated']);
 if(relevance==='ambiguous'||relevance==='unrelated'){
  if(r.intent!==null)fail('PROVIDER_REPLY_INVALID');return {relevance,intent:null};
 }
 const intent=parseIntent(r.intent);if(intent.action==='unrelated')fail('PROVIDER_REPLY_INVALID');return {relevance,intent};
}
function safeCode(error:unknown,fallback:string):string{
 if(error instanceof WorkflowError||error instanceof PreparationError)return /^[A-Z][A-Z_]{0,79}$/.test(error.code)?error.code:fallback;
 if(error instanceof TypeError&&['UNSANITIZED_TEXT','INTENT_PROTOTYPE_INVALID','TASK_EVIDENCE_MISSING'].includes(error.message))return error.message;
 return fallback; // Never return provider/DB exception text, prompts or identifiers.
}
function fingerprint(env:Environment):string{
 // Private, transient comparison only; never a log, persisted fingerprint or
 // replacement for the existing journal's keyed request fingerprint.
 return JSON.stringify({scope:env.scope,question:env.question,date:env.date,global:env.global});
}
export class PrototypeSession {
 private state:State;
 private sequence=0;
 private requests=new Map<string,{fingerprint:string;promise:Promise<TurnResult>}>();
 constructor(scope:TaskScope){this.state=emptyState(scope);}
 snapshot():State{return clone(this.state);}
 private current(env:Environment,services:Services):Environment{
  const current=clone(services.current());
  if(!sameScope(this.state.scope,env.scope)||!sameScope(env.scope,current.scope))fail('TASK_SCOPE_MISMATCH');
  if(!current.accessRevision||!current.dataRevision)fail('TASK_ENV_INVALID');
  return {...env,...current};
 }
 async run(rawEnv:Environment,provider:Provider,services:Services):Promise<TurnResult>{
  const env=clone(rawEnv);let key:string;
  const base={replayed:false,understandingCalls:0,asOfRevision:env.dataRevision,historical:false};
  try{
   if(!sameScope(this.state.scope,emptyTaskBook(env.scope).scope))fail('TASK_SCOPE_MISMATCH');
   uuid(env.requestId);env.question=safeText(env.question,2000);if(!env.question)fail('EMPTY_QUERY');globalSnapshot(env.global);
   key=fingerprint(env);
  }catch(error){return {...base,status:'failed',code:safeCode(error,'REQUEST_INVALID')};}
  const existing=this.requests.get(env.requestId);
  if(existing){
   if(existing.fingerprint!==key)return {...base,status:'failed',code:'REQUEST_ID_CONFLICT'};
   try{
    await services.authorize(this.current(env,services));
    const result=clone(await existing.promise);
    await services.authorize(this.current(env,services));
    const now=this.current(env,services);
    return {...result,replayed:true,understandingCalls:0,historical:result.asOfRevision!==now.dataRevision};
   }catch{return {...base,status:'failed',code:'ACCESS_DENIED'};}
  }
  if(this.requests.size>=100)return {...base,status:'failed',code:'SESSION_REQUEST_LIMIT'};
  const ticket=++this.sequence;
  // Defer execution until the single-flight slot exists, even for synchronous
  // adapters or reentrant test providers. All results, including errors, settle.
  const promise=Promise.resolve().then(()=>this.process(env,provider,services,ticket));
  this.requests.set(env.requestId,{fingerprint:key,promise});
  return clone(await promise);
 }
 private async process(env:Environment,provider:Provider,services:Services,ticket:number):Promise<TurnResult>{
  let calls=0,phase='ACCESS_DENIED',task:Prepared|null=null,asOf=env.dataRevision;
  const result=(body:TurnBody):TurnResult=>
   ({...body,replayed:false,understandingCalls:calls,asOfRevision:asOf,historical:false});
  try{
   await services.authorize(this.current(env,services));
   if(ticket!==this.sequence)return result({status:'discarded',code:'NEWER_QUESTION'});
   const input:ProviderInput={version:workflowPrototypeVersion,question:env.question,date:env.date,context:taskProjection(this.state)};
   phase='PROVIDER_FAILED';calls++;
   const raw=await provider.understand(clone(input));
   if(ticket!==this.sequence)return result({status:'discarded',code:'NEWER_QUESTION'});
   phase='PROVIDER_REPLY_INVALID';const reply=parseUnderstanding(raw);
   phase='SEMANTIC_REVIEW_FAILED';
   if(!await services.review(clone(input),clone(reply)))return result({status:'failed',code:'SEMANTIC_REVIEW_REJECTED'});
   if(ticket!==this.sequence)return result({status:'discarded',code:'NEWER_QUESTION'});
   phase='ACCESS_DENIED';await services.authorize(this.current(env,services));
   if(ticket!==this.sequence)return result({status:'discarded',code:'NEWER_QUESTION'});
   if(reply.relevance==='unrelated'||reply.relevance==='ambiguous')return result({status:reply.relevance,code:reply.relevance==='unrelated'?'FINANCE_ONLY':'MEANING_UNCLEAR'});
   const current=this.current(env,services);asOf=current.dataRevision;
   phase='PREPARATION_FAILED';const preparation=prepareTask(this.state,current,reply.intent);
   this.state=preparation.state;
   if(preparation.status!=='ready'){
    // The mutable server state is never part of a client/provider result.
    const {state:_state,...terminal}=clone(preparation);return result({status:terminal.status,preparation:terminal});
   }
   task=preparation.task;
   const ensureCurrent=(prepared:Prepared)=>{
    const now=this.current(env,services);
    if(this.state.running?.requestId!==prepared.requestId||this.state.revision!==prepared.revision)fail('TASK_SUPERSEDED');
    if(now.accessRevision!==prepared.accessRevision||now.dataRevision!==prepared.dataRevision)fail('TASK_RESULT_STALE');
   };
   phase='TOOL_FAILED';
   const outcome=await executeTask(task,{
    guard:async prepared=>{ensureCurrent(prepared);await services.tools.guard(prepared);ensureCurrent(prepared);},
    read:async (query,prepared)=>{ensureCurrent(prepared);return services.tools.read(query,prepared);},
   });
   const completed=finishTask(this.state,this.current(env,services),task,outcome);this.state=completed.state;
   if(!completed.applied)return result({status:'discarded',code:'TASK_SUPERSEDED'});
   if(this.state.failure)return result({status:'failed',code:this.state.failure});
   return result({status:'completed',outcome:clone(outcome)});
  }catch(error){
   const code=safeCode(error,phase);
   if(task){
    try{const finished=finishTask(this.state,env,task,{kind:'failed',code});this.state=finished.state;}catch{/* Original safe error is sufficient. */}
   }
   return result({status:code==='TASK_SUPERSEDED'?'discarded':'failed',code});
  }
 }
}
