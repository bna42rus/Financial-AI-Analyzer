import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {parseWidget,calculateWidget} from '../../../packages/finance-core/src/overview.ts';
import {parseOperationsFilter,queryOperations} from '../../../packages/finance-core/src/operations.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {interpret,parseTool,registryVersion,tokenUsage} from '../../../packages/analyzer/src/registry.ts';
import type {AnalyzerAdapter,Query} from '../../../packages/analyzer/src/registry.ts';
import type {Answer,Quota} from '../../../packages/analyzer/src/types.ts';
import {operationsDataset,assertReferences} from './operations.ts';
import {prepareFinance,previewFinance} from './finance.ts';
import {stableJSON} from './finance-history.ts';
import {HttpError} from './types.ts';

export async function analyzerQuota(db:PoolClient,userId:string):Promise<Quota>{
 const c=(await db.query(`WITH cycle AS (SELECT *,clock_timestamp() AS now FROM commerce.access_cycle WHERE user_id=$1),
 grid AS (SELECT *, greatest(0,(extract(year FROM now AT TIME ZONE timezone)::int-extract(year FROM anchor_at AT TIME ZONE timezone)::int)*12+extract(month FROM now AT TIME ZONE timezone)::int-extract(month FROM anchor_at AT TIME ZONE timezone)::int) AS n FROM cycle),
 slot AS (SELECT *,n-CASE WHEN ((anchor_at AT TIME ZONE timezone)+make_interval(months=>n)) AT TIME ZONE timezone>now THEN 1 ELSE 0 END AS k FROM grid)
 SELECT anchor_at,quota_policy,((anchor_at AT TIME ZONE timezone)+make_interval(months=>k)) AT TIME ZONE timezone AS start,
 ((anchor_at AT TIME ZONE timezone)+make_interval(months=>k+1)) AT TIME ZONE timezone AS finish FROM slot`,[userId])).rows[0];
 if(!c||!Number.isSafeInteger(c.quota_policy?.limit)||c.quota_policy.limit<0)return {available:false,limit:null,used:0,remaining:null,periodStart:null,resetAt:null,warning:null};
 // Preserve the canonical database timestamp: pg Date serialization truncates microseconds.
 const used=Number((await db.query('SELECT COALESCE(sum(units),0) AS n FROM commerce.analyzer_usage WHERE user_id=$1 AND anchor_at=(SELECT anchor_at FROM commerce.access_cycle WHERE user_id=$1) AND period_start=$2',[userId,c.start])).rows[0].n),limit=c.quota_policy.limit;
 const warning=used>=limit?100:used*100>=limit*95?95:used*100>=limit*80?80:null;
 return {available:true,limit,used,remaining:Math.max(0,limit-used),periodStart:c.start.toISOString(),resetAt:c.finish.toISOString(),warning};
}
export async function analyzerState(db:PoolClient,userId:string,value:unknown,providerAvailable=false){
 const r=object(value??{},['chatId','search']);const search=r.search===undefined?'':safeText(r.search,200);const selectedId=r.chatId===undefined?null:uuid(r.chatId);
 const chats=(await db.query(`SELECT c.id,c.title,c.pinned,c.created_at AS "createdAt",c.modified_at AS "modifiedAt",($2='' OR strpos(lower(c.title),lower($2))>0 OR EXISTS(SELECT 1 FROM finance.analyzer_message m WHERE (m.user_id,m.chat_id)=(c.user_id,c.id) AND strpos(lower(m.question),lower($2))>0)) AS matches FROM finance.analyzer_chat c WHERE c.user_id=$1 ORDER BY c.pinned DESC,c.modified_at DESC,c.id`,[userId,search])).rows;
 const messages=(await db.query(`SELECT m.id,m.chat_id,m.question,m.answer,m.created_at AS "createdAt",m.action_id AS "actionId",CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('status',a.status,'undone',a.undone,'result',CASE WHEN a.status='committed' THEN jsonb_build_object('status',a.result->>'status','actionId',a.id) ELSE NULL END) END AS outcome
 FROM finance.analyzer_message m LEFT JOIN finance.action a ON (a.user_id,a.id)=(m.user_id,m.action_id) WHERE m.user_id=$1 AND m.chat_id=$2 ORDER BY m.created_at,m.id`,[userId,selectedId??chats[0]?.id??null])).rows;
 if(selectedId&&!chats.some(c=>c.id===selectedId))throw new HttpError(404,'NOT_FOUND');
 return {chats:chats.map(c=>({...c,messages:messages.filter(m=>m.chat_id===c.id).map(({chat_id,...m})=>m)})),quota:await analyzerQuota(db,userId),providerAvailable,registryVersion};
}
export async function analyzerChat(db:PoolClient,userId:string,value:unknown){
 const r=object(value,['id','create','title','pinned','delete']),id=uuid(r.id);
 if(r.delete===true){object(value,['id','delete']);await db.query('DELETE FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2',[userId,id]);return {id,deleted:true};}
 if(r.create===true){object(value,['id','create']);if(Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_chat WHERE user_id=$1',[userId])).rows[0].n)>=100)throw new HttpError(409,'CHAT_LIMIT');await db.query('INSERT INTO finance.analyzer_chat(user_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING',[userId,id]);return {id};}
 object(value,['id','title','pinned']);if(r.title===undefined&&r.pinned===undefined||r.pinned!==undefined&&typeof r.pinned!=='boolean')throw new TypeError('INVALID_CHAT');
 const title=r.title===undefined?null:safeText(r.title,100);if(title==='')throw new TypeError('EMPTY_TITLE');
 if(!(await db.query('UPDATE finance.analyzer_chat SET title=COALESCE($3,title),pinned=COALESCE($4,pinned),modified_at=clock_timestamp() WHERE user_id=$1 AND id=$2 RETURNING id',[userId,id,title,r.pinned??null])).rowCount)throw new HttpError(404,'NOT_FOUND');return {id};
}
export async function analyzerQuery(db:PoolClient,userId:string,value:unknown,adapter?:AnalyzerAdapter){
 const r=object(value,['id','chatId','text','filter','contextId']),id=uuid(r.id),chatId=uuid(r.chatId),text=safeText(r.text,2000),filter=parseOperationsFilter(r.filter??{}),contextId=r.contextId===undefined?null:uuid(r.contextId);
 if(!text)throw new TypeError('EMPTY_QUERY');const request={chatId,text,filter,contextId};
 const previous=(await db.query('SELECT request,answer FROM finance.analyzer_message WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(previous){if(stableJSON(previous.request)!==stableJSON(request))throw new HttpError(409,'ACTION_REUSED');return {id,answer:previous.answer,quota:await analyzerQuota(db,userId)};}
 if(!(await db.query('SELECT id FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2',[userId,chatId])).rowCount)throw new HttpError(404,'NOT_FOUND');
 if(Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2',[userId,chatId])).rows[0].n)>=100)throw new HttpError(409,'MESSAGE_LIMIT');
 const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 let context:Query|undefined;
 if(contextId){const c=(await db.query('SELECT context FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2 AND id=$3',[userId,chatId,contextId])).rows[0];if(!c?.context)throw new HttpError(409,'CONTEXT_UNAVAILABLE');const tool=parseTool(c.context);if(tool.name!=='query_finances')throw new TypeError('INVALID_CONTEXT');context=tool;}
 const intent=interpret(text,filter,context,now);let query=intent.query;
 if(query?.filter.operationIds){const resolved=(await db.query('SELECT finance.canonical_operation($1,id) AS id FROM unnest($2::uuid[]) AS id',[userId,query.filter.operationIds])).rows.map(r=>r.id);query={...query,filter:{...query.filter,operationIds:[...new Set<string>(resolved)]}};}
 let answer:Answer={text:intent.relevance==='unrelated'?'Я помогаю разбираться в финансах. Спросите о своих расходах, доходах или операциях.':intent.relevance==='ambiguous'?'Уточните показатель и период: например, «Расходы по категориям за сентябрь 2026».':'Для такого вопроса нужна подключённая AI-модель. Сейчас доступны точные расчёты расходов, доходов, категорий, крупных операций и сравнение с предыдущим периодом.',mode:intent.relevance==='unrelated'?'redirect':intent.relevance==='ambiguous'?'clarification':'unavailable',registryVersion};
 let usage:{inputTokens:number;outputTokens:number}|undefined;
 // The gate sees sanitized text only. Unknown/ambiguous/unrelated requests cannot call a provider or financial tools.
 if(query)await assertReferences(db,userId,query.filter);
 if(query&&adapter){if((await db.query('SELECT request_id FROM commerce.analyzer_usage WHERE user_id=$1 AND request_id=$2',[userId,id])).rowCount)throw new HttpError(409,'ACTION_REUSED');const quota=await analyzerQuota(db,userId);if(!quota.available)throw new HttpError(409,'AI_QUOTA_UNAVAILABLE');if(!quota.remaining)throw new HttpError(429,'AI_QUOTA_EXHAUSTED');
  const plan=await adapter.plan({text,context,query,registryVersion}),tool=parseTool(plan.tool);if(tool.name!=='query_finances')throw new HttpError(400,'AI_ACTION_REQUIRES_CONFIRMATION');
  // Providers may choose a presentation, never silently widen the user-established scope.
  if(stableJSON(tool)!==stableJSON(query))throw new HttpError(400,'AI_SCOPE_CHANGED');query=tool;usage={inputTokens:tokenUsage(plan.inputTokens),outputTokens:tokenUsage(plan.outputTokens)};
 }
 let dependencyIds:string[]=[];
 if(query){await assertReferences(db,userId,query.filter);const {state,operations}=await operationsDataset(db,userId);
  const widget=parseWidget({id:randomUUID(),name:query.metric==='income'?'Доходы':query.metric==='attention'?'Требуют внимания':'Расходы',metrics:[query.metric],grouping:query.grouping,filter:query.filter,period:'global',comparison:{kind:query.comparison},chart:'table',topN:query.grouping==='operation'?3:10});
  const result=calculateWidget(widget,operations,state,{},now,'Europe/Moscow');
  const selected=queryOperations(operations,state,{filter:query.filter,sort:'date',direction:'asc',group:'none'}).operations;
  dependencyIds=selected.map(o=>o.id);if(result.comparisonFilter)dependencyIds=[...new Set([...dependencyIds,...queryOperations(operations,state,{filter:result.comparisonFilter,sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id)])];
  // Linked source facts outside the visible period contribute to terminal allocations.
  const links=(await db.query('SELECT source_id,target_id FROM finance.link WHERE user_id=$1',[userId])).rows;
  const connected=new Set(dependencyIds);let grew=true;while(grew){grew=false;for(const link of links)if(connected.has(link.source_id)||connected.has(link.target_id))for(const linked of [link.source_id,link.target_id])if(!connected.has(linked)){connected.add(linked);grew=true;}}dependencyIds=[...connected];
  answer={text:result.operationCount?'Расчёт по вашим сохранённым операциям.':'По этим условиям операций нет.',mode:adapter?'test_adapter':'deterministic',registryVersion,query,result,widget,generation:state.generation,revision:state.revision,accountCount:new Set(selected.map(o=>o.accountId)).size,actionOperationCount:queryOperations(operations,state,{filter:{...query.filter,metric:query.metric},sort:'date',direction:'asc',group:'none'}).total,computedAt:now.toISOString(),periodFromQuestion:intent.periodFromQuestion,followUp:intent.followUp,...(adapter?{provider:{id:adapter.id,model:adapter.model,version:adapter.version}}:{})};
 }
 await db.query('INSERT INTO finance.analyzer_message(user_id,id,chat_id,question,answer,context,request) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,id,chatId,text,JSON.stringify(answer),query?JSON.stringify(query):null,JSON.stringify(request)]);
 if(dependencyIds.length)await db.query('INSERT INTO finance.analyzer_dependency(user_id,message_id,transaction_id) SELECT $1,$2,unnest($3::uuid[])',[userId,id,dependencyIds]);
 await db.query("UPDATE finance.analyzer_chat SET title=CASE WHEN title='Новый диалог' AND $3 THEN $4 ELSE title END,modified_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[userId,chatId,!!query,text.slice(0,100)]);
 if(usage&&adapter){const quota=await analyzerQuota(db,userId);await db.query('INSERT INTO commerce.analyzer_usage(user_id,request_id,anchor_at,period_start,units,input_tokens,output_tokens,provider,model,provider_version) SELECT user_id,$2,anchor_at,$3,1,$4,$5,$6,$7,$8 FROM commerce.access_cycle WHERE user_id=$1',[userId,id,quota.periodStart,usage.inputTokens,usage.outputTokens,adapter.id,adapter.model,adapter.version]);}
 return {id,answer,quota:await analyzerQuota(db,userId)};
}
export async function analyzerPropose(db:PoolClient,userId:string,value:unknown){
 const r=object(value,['actionId','tool']),actionId=uuid(r.actionId),tool=parseTool(r.tool);if(tool.name!=='set_inclusion')throw new TypeError('INVALID_ACTION');
 const message=(await db.query('SELECT answer,action_id FROM finance.analyzer_message WHERE user_id=$1 AND id=$2',[userId,tool.answerId])).rows[0];if(!message?.answer.query)throw new HttpError(404,'NOT_FOUND');
 if(message.action_id&&message.action_id!==actionId)throw new HttpError(409,'ACTION_REUSED');
 const answer=message.answer as Answer,query=answer.query!,{state,operations}=await operationsDataset(db,userId);
 if(state.generation!==answer.generation||state.revision!==answer.revision)throw new HttpError(409,'FINANCE_CHANGED');
 const ids=queryOperations(operations,state,{filter:{...query.filter,metric:query.metric},sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id);
 if(!ids.length||ids.length>1000)throw new HttpError(409,'ANALYZER_SCOPE_LIMIT');
 const preview=await previewFinance(db,userId,{actionId,generation:answer.generation,revision:answer.revision,intent:{kind:'bulk_operations',operationIds:ids,patch:{analyticsOverride:tool.value}}});
 await db.query('UPDATE finance.analyzer_message SET action_id=$3 WHERE user_id=$1 AND id=$2',[userId,tool.answerId,actionId]);
 return {...preview,generation:state.generation};
}
