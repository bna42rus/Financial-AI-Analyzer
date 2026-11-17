import {reviewRuleConditions} from '../../../packages/finance-core/src/rules.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {loadFinance} from './finance.ts';
import {createHash} from 'node:crypto';
import {assertReferences} from './operations.ts';
import type {Query} from '../../../packages/analyzer/src/registry.ts';
import {compileAssistantBatch} from '../../../packages/analyzer/src/assistant-changes.ts';
import {financialTimezone} from './finance-profile.ts';
import type {PoolClient} from 'pg';
import {compileAssistantChange,ChangeError} from '../../../packages/analyzer/src/assistant-changes.ts';
import type {AssistantChange,ChangeCatalog} from '../../../packages/analyzer/src/assistant-changes.ts';
import {calculatorRublesMinor} from '../../../packages/analyzer/src/calculators.ts';
import {queryOperations} from '../../../packages/finance-core/src/operations.ts';
import type {Answer} from '../../../packages/analyzer/src/types.ts';
import {operationsDataset} from './operations.ts';
import {parseIntent,prepareFinance} from './finance.ts';

/** Read-only preparation after the positive financial gate. The result is
 * journalled with the answer; actual preview/commit use the ordinary authority. */
export async function prepareAssistantChange(db:PoolClient,userId:string,requestId:string,change:AssistantChange,sourceAnswerId:string|null){
 const state=await prepareFinance(db,userId),catalog:ChangeCatalog={
  accounts:(await db.query('SELECT id,display_name AS name FROM finance.account WHERE user_id=$1 AND merged_into_id IS NULL LIMIT 1001',[userId])).rows,
  categories:(await db.query('SELECT id,name,parent_id AS "parentId",role,hidden FROM finance.category WHERE user_id=$1 LIMIT 1001',[userId])).rows,
  counterparties:(await db.query('SELECT id,name FROM finance.counterparty WHERE user_id=$1 AND merged_into_id IS NULL LIMIT 1001',[userId])).rows,
  rules:(await db.query('SELECT id,name,enabled,priority,conditions,assignments FROM finance.rule WHERE user_id=$1 LIMIT 1001',[userId])).rows,
  budgets:(await db.query('SELECT id,name FROM finance.budget WHERE user_id=$1 LIMIT 1001',[userId])).rows,
 };
 if(Object.values(catalog).some(rows=>rows.length>1000))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 let operationIds:string[]|undefined;
 if(change.kind==='answer_operations'||change.kind==='apply_rule'||change.kind==='remember_answer'){
  if(!sourceAnswerId)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
  const row=(await db.query('SELECT answer FROM finance.analyzer_message WHERE user_id=$1 AND id=$2',[userId,sourceAnswerId])).rows[0],answer=row?.answer as Answer|undefined;
  if(!answer?.query||answer.generation!==state.generation||answer.revision!==state.revision)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
  const data=await operationsDataset(db,userId),query=answer.query;
  operationIds=queryOperations(data.operations,data.state,{filter:{...query.filter,metric:query.metric},sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id);
 }
 const rememberConditions=change.kind==='remember_answer'?await rememberedConditions(db,userId,operationIds,change):undefined;
 const proposal=compileAssistantChange(change,catalog,{newId:requestId,sourceAnswerId,operationIds,parseRubles:calculatorRublesMinor,timezone:await financialTimezone(db,userId)??undefined,rememberConditions});
 parseIntent(proposal.intent);return proposal;
}

export async function prepareAssistantBatch(db:PoolClient,userId:string,requestId:string,steps:{change:AssistantChange;query?:Query}[]){
 await prepareFinance(db,userId);const data=await operationsDataset(db,userId),catalog:ChangeCatalog={accounts:data.state.accounts,categories:data.state.categories,counterparties:data.state.counterparties,rules:(await db.query('SELECT id,name,enabled,priority,conditions,assignments FROM finance.rule WHERE user_id=$1 LIMIT 1001',[userId])).rows,budgets:(await db.query('SELECT id,name FROM finance.budget WHERE user_id=$1 LIMIT 1001',[userId])).rows};
 if(Object.values(catalog).some(rows=>rows.length>1000))throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 const changes=[];for(const s of steps){if(s.query)await assertReferences(db,userId,s.query.filter);const operationIds=s.query?queryOperations(data.operations,data.state,{filter:{...s.query.filter,metric:s.query.metric},sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id):undefined;const rememberConditions=s.change.kind==='remember_answer'?await rememberedConditions(db,userId,operationIds,s.change):undefined;changes.push({change:s.change,operationIds,rememberConditions});}
 const ids=steps.map((_,i)=>{const h=createHash('sha256').update(requestId+':change:'+i).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);});
 const proposal=compileAssistantBatch(changes,catalog,{requestId,ids,sourceAnswerId:requestId,parseRubles:calculatorRublesMinor,timezone:await financialTimezone(db,userId)??undefined});parseIntent(proposal.intent);return proposal;
}

async function rememberedConditions(db:PoolClient,userId:string,ids:string[]|undefined,change:Extract<AssistantChange,{kind:'remember_answer'}>):Promise<Rule['conditions']>{
 if(!ids?.length||ids.length>1000)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
 if(change.assignments.kind==='own_transfer'&&change.assignments.role!=='neutral')throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 const {graph}=await loadFinance(db,userId),selected=graph.operations.filter(o=>ids.includes(o.id));if(selected.length!==ids.length)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
 const found=selected.map(o=>reviewRuleConditions(o,{...(change.assignments.kind?{kind:change.assignments.kind}:{})}));
 if(found.some(c=>!c)||new Set(found.map(c=>JSON.stringify(c))).size!==1)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');return found[0]!;
}
