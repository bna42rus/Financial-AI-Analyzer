import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid,effective} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {applyRules,ruleMatches} from '../../../packages/finance-core/src/rules.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {HttpError} from './types.ts';
import type {BatchUndo} from './finance-exclusions.ts';
export type RuleIntent={kind:'delete_rule';id:string}|{kind:'apply_rules';id:string;ruleId:string;operationIds:string[]};
export function parseRuleIntent(value:unknown):RuleIntent {
 const r=object(value,['kind','id','ruleId','operationIds']);
 if(r.kind==='delete_rule'){object(value,['kind','id']);return {kind:r.kind,id:uuid(r.id)};}
 object(value,['kind','ruleId','operationIds']);
 if(r.kind!=='apply_rules'||!Array.isArray(r.operationIds)||!r.operationIds.length||r.operationIds.length>1000)throw new TypeError('INVALID_SELECTION');
 const operationIds=r.operationIds.map(uuid);if(new Set(operationIds).size!==operationIds.length)throw new TypeError('DUPLICATE_SELECTION');
 return {kind:r.kind,id:randomUUID(),ruleId:uuid(r.ruleId),operationIds};
}
export async function applyRuleIntent(db:PoolClient,userId:string,intent:RuleIntent,graph:Graph,rules:(Rule&{dependencyStatus:string})[],compatible:(role:string,category:string|null,sub:string|null)=>void):Promise<BatchUndo> {
 const rule=rules.find(r=>r.id===(intent.kind==='delete_rule'?intent.id:intent.ruleId));if(!rule)throw new HttpError(404,'NOT_FOUND');
 if(intent.kind==='delete_rule'){
  const operationDependencies=graph.operations.filter(o=>Object.values(o.semantics).some(f=>f.ruleId===rule.id)).map(o=>o.id);
  await db.query('DELETE FROM finance.rule WHERE user_id=$1 AND id=$2',[userId,rule.id]);
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,ruleName:rule.name,operationDependencies,historicalOperationsUnchanged:true,financialOperationsDeleted:0}};
 }
 if(!rule.enabled||rule.dependencyStatus!=='ready')throw new HttpError(409,'RULE_NEEDS_SETUP');
 const active=rules.filter(r=>r.enabled&&r.dependencyStatus==='ready'),changes:Record<string,unknown>[]=[],changedOperationIds:string[]=[],protectedOperationIds:string[]=[],conflictingOperationIds:string[]=[];
 for(const id of intent.operationIds){
  const op=graph.operations.find(o=>o.id===id);if(!op)throw new HttpError(404,'NOT_FOUND');
  const account=graph.accounts.find(a=>a.id===effective(op).accountId)!;
  if(!ruleMatches(op,account,rule))throw new HttpError(409,'RULE_SCOPE_CHANGED');
  const next=applyRules(op,account,active);compatible(next.semantics.role.value,next.semantics.category.value,next.semantics.subcategory.value);
  if(Object.values(op.semantics).some(f=>f.userVerified)||op.analyticsOverride!=='default')protectedOperationIds.push(id);
  if(next.reviewReasons.includes('conflicting_rules'))conflictingOperationIds.push(id);
  if(JSON.stringify([op.semantics,op.analyticsOverride,op.reviewReasons])!==JSON.stringify([next.semantics,next.analyticsOverride,next.reviewReasons])){
   changes.push({id,semantics:next.semantics,analyticsOverride:next.analyticsOverride,reviewReasons:next.reviewReasons});changedOperationIds.push(id);
  }
 }
 // Validation of the entire fixed set finishes before the first write.
 for(const c of changes)await db.query('UPDATE finance.transaction SET semantics=$3,analytics_override=$4,review_reasons=$5,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,c.id,JSON.stringify(c.semantics),c.analyticsOverride,JSON.stringify(c.reviewReasons)]);
 return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,ruleName:rule.name,ruleIds:active.map(r=>r.id),operationIds:intent.operationIds,selectedCount:intent.operationIds.length,changedOperationIds,protectedOperationIds,conflictingOperationIds,atomic:true,financialOperationsDeleted:0}};
}
