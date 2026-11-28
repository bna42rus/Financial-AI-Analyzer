/** Opt-in persistence adapter; no HTTP route or runtime enablement. One request
 * lock spans execution; all DB stages are short transactions on that connection. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import type {TurnResult} from '../../../packages/analyzer/src/next/workflow.ts';
import type {Environment} from '../../../packages/analyzer/src/next/tasks.ts';
import type {Answer,Quota} from '../../../packages/analyzer/src/types.ts';
import {registryVersion} from '../../../packages/analyzer/src/registry.ts';
import {AssistantError,cleanAssistantQuestion,profileCalendar} from '../../../packages/analyzer/src/assistant-plan.ts';
import {sealNextSession,restoreNextSessionForStore,nextCheckpointVersion} from './analyzer-next-checkpoint.ts';
import {assistantWorkflowVersion} from './assistant-workflow.ts';
import type {AssistantJournal,RunReceipt} from './assistant-workflow.ts';
import {checkedAssistantReceipt} from './assistant-journal.ts';
import {reserveAssistantCall,settleAssistantCall} from './assistant-db-accounting.ts';
import {isAssistantProvider} from './analyzer-assistant-provider.ts';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
import {prepareFinance} from './finance.ts';
import {analyzerTaskContext} from './analyzer-task-store.ts';
import {analyzerCycle,analyzerQuota} from './analyzer.ts';
import {yandexCatalog} from './yandex-runtime.ts';
import {stableJSON} from './finance-history.ts';
import {HttpError} from './types.ts';

export const nextStoreVersion='cashneuro-next-store/1';
export type NextReply={id:string;answer:Answer;result:TurnResult;quota:Quota};
export type NextExecution={answer:Answer;result:TurnResult;dependencyIds?:string[]};
export type NextStoreContext={session:PrototypeSession;environment:Environment;calendar:{now:Date;timezone:string};journal:AssistantJournal;
 within<T>(action:(db:PoolClient)=>Promise<T>):Promise<T>};
type Expected={checkpointMac:string|null;globalRevision:number;dataRevision:string;accessRevision:string;timezone:string};
const fail=(code:string):never=>{throw new HttpError(409,code);};
const integer=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('TASK_REVISION_INVALID');return value as number;};

export async function runNextRequest(pool:Pool,userId:string,value:unknown,provider:AssistantProvider,key:Uint8Array,authorize:(db:PoolClient)=>Promise<void>,execute:(context:NextStoreContext)=>Promise<NextExecution>):Promise<NextReply>{
 if(!isAssistantProvider(provider)||provider.pool!==pool)throw new HttpError(503,'AI_UNAVAILABLE');
 const b=object(value,['id','chatId','chatEpoch','generation','globalRevision','text']);
 const body={id:uuid(b.id),chatId:uuid(b.chatId),chatEpoch:uuid(b.chatEpoch),generation:uuid(b.generation),globalRevision:integer(b.globalRevision),text:cleanAssistantQuestion(b.text)};
 if(!body.text)fail('EMPTY_QUERY');
 const scope={ownerId:userId,chatId:body.chatId,chatEpoch:body.chatEpoch,generation:body.generation};
 const request={version:nextStoreVersion,body,binding:provider.binding};
 const fingerprint=createHash('sha256').update(nextStoreVersion+'\0'+stableJSON(request)).digest('hex');
 const db=await pool.connect(),lockKey='assistant-run:'+userId+':'+body.id;let held=false,destroyed=false;
 const within=async<T>(action:(connection:PoolClient)=>Promise<T>):Promise<T>=>{
  await db.query('BEGIN');try{await db.query("SELECT set_config('app.user_id',$1,true)",[userId]);const result=await action(db);await db.query('COMMIT');return result;}
  catch(error){try{await db.query('ROLLBACK');}catch{/* Retain the original error. */}throw error;}
 };
 const own=()=>db.query('SELECT *,anchor_at::text AS "anchorExact",period_start::text AS "periodExact" FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 FOR UPDATE',[userId,body.id]);
 const savedContext=async()=>{
  const row=(await db.query('SELECT conversation,chat_epoch,generation FROM finance.assistant_conversation WHERE user_id=$1 AND chat_id=$2',[userId,body.chatId])).rows[0];
  if(row&&(row.chat_epoch!==scope.chatEpoch||row.generation!==scope.generation))fail('AI_STATE_CHANGED');
  if(row&&row.conversation?.version!==nextCheckpointVersion)fail('AI_CHAT_PROTOCOL_CHANGED');
  return row?.conversation??null;
 };
 const current=async()=>{
  await authorize(db);const workspace=await prepareFinance(db,userId);
  const chat=(await db.query('SELECT epoch FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2',[userId,body.chatId])).rows[0];
  if(!chat||chat.epoch!==body.chatEpoch||workspace.generation!==body.generation)fail('AI_STATE_CHANGED');
  const profile=(await db.query('SELECT timezone FROM finance.assistant_profile WHERE user_id=$1',[userId])).rows[0];
  if(!profile?.timezone)fail('ASSISTANT_TIMEZONE_REQUIRED');
  const access=(await db.query('SELECT epoch FROM identity.security_state WHERE user_id=$1',[userId])).rows[0];
  return {workspace,timezone:String(profile.timezone),accessRevision:String(access.epoch)};
 };
 try{
  held=!!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockKey])).rows[0].locked;
  if(!held)fail('AI_REQUEST_IN_PROGRESS');
  const claim=await within(async()=>{
   const now=await current(),old=(await own()).rows[0];
   if((await db.query('SELECT 1 FROM finance.analyzer_task_cancel WHERE user_id=$1 AND request_id=$2',[userId,body.id])).rowCount)fail('AI_REQUEST_CANCELLED');
   if(old){
    if(stableJSON(old.request)!==stableJSON(request))fail('AI_REQUEST_CHANGED');
    if(old.state==='cancelled')fail('AI_REQUEST_CANCELLED');
    if(old.input.timezone!==now.timezone)fail('AI_CONTEXT_CHANGED');
    return {row:old,now};
   }
   if((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 UNION ALL SELECT 1 FROM commerce.analyzer_usage WHERE user_id=$1 AND request_id=$2',[userId,body.id])).rowCount)fail('ACTION_REUSED');
   if((await db.query("SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND chat_id=$2 AND state='pending'",[userId,body.chatId])).rowCount)fail('AI_REQUEST_IN_PROGRESS');
   const global=await analyzerTaskContext(db,userId,{generation:body.generation});
   if(global.revision!==body.globalRevision||(await db.query('SELECT invalidated FROM finance.analyzer_globals WHERE user_id=$1',[userId])).rows[0].invalidated)fail('AI_CONTEXT_CHANGED');
   const checkpoint=await savedContext(),count=Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2',[userId,body.chatId])).rows[0].n);
   if(count>=100)fail('MESSAGE_LIMIT');if(!checkpoint&&count)fail('AI_CHAT_PROTOCOL_CHANGED');
   if(checkpoint)restoreNextSessionForStore(scope,checkpoint,key,body.generation);
   const at=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
   const calendar=profileCalendar(at,now.timezone),cycle=await analyzerCycle(db,userId);if(!cycle)fail('AI_BUDGET_PERIOD_REQUIRED');
   const input={now:at.toISOString(),date:calendar.currentDate,timezone:now.timezone,global};
   const expected:Expected={checkpointMac:checkpoint?.mac??null,globalRevision:global.revision,dataRevision:now.workspace.revision,accessRevision:now.accessRevision,timezone:now.timezone};
   const row=(await db.query(`INSERT INTO finance.analyzer_task_request(user_id,id,chat_id,chat_epoch,generation,request,input,expected,anchor_at,period_start)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *,anchor_at::text AS "anchorExact",period_start::text AS "periodExact"`,[userId,body.id,body.chatId,body.chatEpoch,body.generation,JSON.stringify(request),JSON.stringify(input),JSON.stringify(expected),cycle.anchorExact,cycle.startExact])).rows[0];
   return {row,now};
  });
  if(claim.row.state==='completed'){
   const reply=structuredClone(claim.row.reply) as NextReply;
   return {...reply,result:{...reply.result,replayed:true,understandingCalls:0,historical:reply.result.asOfRevision!==claim.now.workspace.revision}};
  }
  const expected=claim.row.expected as Expected;
  const guard=async()=>{
   const now=await current(),active=(await own()).rows[0];
   if(!active||active.state!=='pending')fail(active?.state==='cancelled'?'AI_REQUEST_CANCELLED':'AI_STATE_CHANGED');
   if(now.workspace.revision!==expected.dataRevision||now.accessRevision!==expected.accessRevision||now.timezone!==expected.timezone)fail('AI_STATE_CHANGED');
   const global=(await db.query('SELECT revision,invalidated FROM finance.analyzer_globals WHERE user_id=$1',[userId])).rows[0];
   if(!global||global.invalidated||Number(global.revision)!==expected.globalRevision)fail('AI_CONTEXT_CHANGED');
   if(((await savedContext())?.mac??null)!==expected.checkpointMac)fail('AI_STATE_CHANGED');
   const cycle=await analyzerCycle(db,userId);if(cycle?.anchorExact!==claim.row.anchorExact||cycle?.startExact!==claim.row.periodExact)fail('AI_QUOTA_PERIOD_CHANGED');
  };
  const initial=await within(async()=>{await guard();return {checkpoint:await savedContext(),catalog:await yandexCatalog(db,userId),run:(await db.query('SELECT workflow,receipt FROM finance.assistant_run WHERE user_id=$1 AND request_id=$2',[userId,body.id])).rows[0]};});
  if(initial.run&&initial.run.workflow!==nextStoreVersion)fail('AI_CHAT_PROTOCOL_CHANGED');
  const receipt:RunReceipt=initial.run?checkedAssistantReceipt({version:assistantWorkflowVersion,receipt:initial.run.receipt},fingerprint):{fingerprint,calls:[]};
  if(receipt.calls.length>2||receipt.calls.some((c,i)=>c.phase!==(i===0?'understand':'check_changes'))||receipt.result||receipt.conversation)fail('ASSISTANT_JOURNAL_INVALID');
  const persist=async()=>{
   if(receipt.calls.length>2||receipt.calls.some((c,i)=>c.phase!==(i===0?'understand':'check_changes'))||receipt.result||receipt.conversation)fail('ASSISTANT_JOURNAL_INVALID');
   if(Buffer.byteLength(JSON.stringify(receipt))>2097152)fail('ASSISTANT_JOURNAL_TOO_LARGE');
   checkedAssistantReceipt({version:assistantWorkflowVersion,receipt},fingerprint);
   await within(async()=>{await guard();await db.query(`INSERT INTO finance.assistant_run(user_id,request_id,workflow,receipt) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,request_id) DO UPDATE SET receipt=EXCLUDED.receipt`,[userId,body.id,nextStoreVersion,JSON.stringify(receipt)]);});
  };
  const journal:AssistantJournal={receipt,persist,
   reserve:(index,bound)=>within(async()=>{await guard();if(index>1)fail('ASSISTANT_CALL_LIMIT');await reserveAssistantCall(db,userId,body.id,index,fingerprint,bound,claim.row,provider,'cashneuro-analyzer-next/1');}),
   async settle(index,usage){const changed=await within(()=>settleAssistantCall(db,userId,body.id,index,usage));if(changed)throw new AssistantError('ASSISTANT_PROVIDER_CHANGED');},
  };
  await persist();
  const session=initial.checkpoint?restoreNextSessionForStore(scope,initial.checkpoint,key,body.generation):new PrototypeSession(scope);
  const environment:Environment={scope,requestId:body.id,question:body.text,date:claim.row.input.date,global:claim.row.input.global,dataRevision:expected.dataRevision,accessRevision:expected.accessRevision,catalog:initial.catalog};
  const execution=structuredClone(await execute({session,environment:structuredClone(environment),calendar:{now:new Date(claim.row.input.now),timezone:expected.timezone},journal,within:action=>within(async()=>{await guard();return action(db);})}));
  const checkpoint=sealNextSession(session,key),result=execution.result;
  if(result.asOfRevision!==expected.dataRevision||result.status==='discarded'||result.status==='completed'&&session.snapshot().history.at(-1)?.requestId!==body.id)fail('AI_STATE_CHANGED');
  if(execution.answer.registryVersion!==registryVersion||typeof execution.answer.text!=='string'||execution.answer.text.length>100000||execution.answer.proposal)fail('NEXT_RESULT_INVALID');
  return await within(async()=>{
   await guard();
   const persisted=(await db.query('SELECT receipt FROM finance.assistant_run WHERE user_id=$1 AND request_id=$2',[userId,body.id])).rows[0]?.receipt;
   if(!isDeepStrictEqual(persisted,receipt))fail('AI_STATE_CHANGED');
   const answer={...execution.answer,generation:body.generation,revision:expected.dataRevision,computedAt:claim.row.input.now};
   await db.query('INSERT INTO finance.analyzer_message(user_id,id,chat_id,question,answer,context,request) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,body.id,body.chatId,body.text,JSON.stringify(answer),answer.query?JSON.stringify(answer.query):null,JSON.stringify(body)]);
   const dependencies=[...new Set((execution.dependencyIds??[]).map(uuid))];
   if(dependencies.length){
    const owned=await db.query('SELECT id FROM finance.transaction WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,dependencies]);if(owned.rowCount!==dependencies.length)fail('DEPENDENCY_UNAVAILABLE');
    await db.query('INSERT INTO finance.analyzer_dependency(user_id,message_id,transaction_id) SELECT $1,$2,unnest($3::uuid[])',[userId,body.id,dependencies]);
   }
   await db.query(`INSERT INTO finance.assistant_conversation(user_id,chat_id,chat_epoch,generation,conversation) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,chat_id) DO UPDATE SET conversation=EXCLUDED.conversation,generation=EXCLUDED.generation`,[userId,body.chatId,body.chatEpoch,body.generation,JSON.stringify(checkpoint)]);
   if(receipt.calls.length&&(result.status==='completed'||result.status==='explanation')){
    const billed=await db.query(`INSERT INTO commerce.analyzer_usage(user_id,request_id,anchor_at,period_start,units,input_tokens,output_tokens,provider,model,provider_version)
     SELECT user_id,request_id,anchor_at,period_start,1,(SELECT sum(input_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),(SELECT sum(output_tokens)::int FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2),provider,model,$3
     FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step='assistant_0' AND state='received' AND usage_state='reported'`,[userId,body.id,nextStoreVersion]);if(billed.rowCount!==1)fail('AI_STATE_CHANGED');
   }
   await db.query("UPDATE commerce.analyzer_request SET state='completed',updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND state='received'",[userId,body.id]);
   const reply:NextReply={id:body.id,answer,result,quota:await analyzerQuota(db,userId,true)};
   const completeReceipt={...receipt,result:reply,conversation:{version:nextCheckpointVersion,mac:checkpoint.mac}};
   if(Buffer.byteLength(JSON.stringify(completeReceipt))>2097152)fail('ASSISTANT_JOURNAL_TOO_LARGE');
   await db.query('UPDATE finance.assistant_run SET receipt=$3 WHERE user_id=$1 AND request_id=$2',[userId,body.id,JSON.stringify(completeReceipt)]);
   await db.query("UPDATE finance.analyzer_task_request SET state='completed',reply=$3 WHERE user_id=$1 AND id=$2 AND state='pending'",[userId,body.id,JSON.stringify(reply)]);
   await db.query('UPDATE finance.analyzer_chat SET modified_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,body.chatId]);
   return reply;
  });
 }finally{
  if(held)try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);}catch{db.release(true);destroyed=true;}
  if(!destroyed)db.release();
 }
}
