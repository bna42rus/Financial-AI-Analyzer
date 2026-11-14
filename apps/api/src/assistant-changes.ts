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
 if(change.kind==='answer_operations'||change.kind==='apply_rule'){
  if(!sourceAnswerId)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
  const row=(await db.query('SELECT answer FROM finance.analyzer_message WHERE user_id=$1 AND id=$2',[userId,sourceAnswerId])).rows[0],answer=row?.answer as Answer|undefined;
  if(!answer?.query||answer.generation!==state.generation||answer.revision!==state.revision)throw new ChangeError('ASSISTANT_CHANGE_SCOPE_REQUIRED');
  const data=await operationsDataset(db,userId),query=answer.query;
  operationIds=queryOperations(data.operations,data.state,{filter:{...query.filter,metric:query.metric},sort:'date',direction:'asc',group:'none'}).operations.map(o=>o.id);
 }
 const proposal=compileAssistantChange(change,catalog,{newId:requestId,sourceAnswerId,operationIds,parseRubles:calculatorRublesMinor});
 parseIntent(proposal.intent);return proposal;
}
