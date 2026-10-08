import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,choice,uuid,dateFact,operationDay} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
import {HttpError} from './types.ts';
import {activeAccount} from './finance-structure.ts';
import {activeParty,partyRows} from './finance-entities.ts';

type ExclusionFilter={from?:string;through?:string;accountIds?:string[];categoryIds?:string[];counterpartyIds?:string[]};
export type ExclusionIntent={kind:'set_exclusion';id:string;scope:{kind:'operations';operationIds:string[]}|{kind:'filter';filter:ExclusionFilter};value:'default'|'include'|'exclude';includeRelated:boolean};
export type BatchUndo={table:'batch';id:string;before:null;details:Record<string,unknown>};
function ids(v:unknown,max=100){if(!Array.isArray(v)||!v.length||v.length>max)throw new TypeError('INVALID_SELECTION');const r=v.map(uuid);if(new Set(r).size!==r.length)throw new TypeError('DUPLICATE_SELECTION');return r;}
export function parseExclusionIntent(value:unknown):ExclusionIntent {
 const r=object(value,['kind','scope','value','includeRelated']),s=object(r.scope,['kind','operationIds','filter']);let scope:ExclusionIntent['scope'];
 if(s.kind==='operations'){object(r.scope,['kind','operationIds']);scope={kind:'operations',operationIds:ids(s.operationIds,1000)};}
 else if(s.kind==='filter'){
  object(r.scope,['kind','filter']);const f=object(s.filter,['from','through','accountIds','categoryIds','counterpartyIds']),filter:ExclusionFilter={};if(!Object.keys(f).length)throw new TypeError('EMPTY_FILTER');
  for(const k of ['from','through']as const)if(k in f){const d=dateFact({precision:'day',date:f[k]});filter[k]=(d as {date:string}).date;}if(filter.from&&filter.through&&filter.from>filter.through)throw new TypeError('INVALID_RANGE');
  for(const k of ['accountIds','categoryIds','counterpartyIds']as const)if(k in f)filter[k]=ids(f[k]);scope={kind:'filter',filter};
 }else throw new TypeError('INVALID_SCOPE');
 if(typeof r.includeRelated!=='boolean')throw new TypeError('EXPLICIT_CHAIN_CHOICE_REQUIRED');return {kind:'set_exclusion',id:randomUUID(),scope,value:choice(r.value,['default','include','exclude']),includeRelated:r.includeRelated};
}
export async function applyExclusion(db:PoolClient,userId:string,intent:ExclusionIntent,graph:Graph):Promise<BatchUndo>{
 const projection=reconcile(graph),byId=new Map(graph.operations.map(o=>[o.id,o])),initial=new Set<string>();
 if(intent.scope.kind==='operations'){for(const id of intent.scope.operationIds){if(!byId.has(id))throw new HttpError(404,'NOT_FOUND');initial.add(id);}}
 else {const f=intent.scope.filter;for(const id of f.accountIds??[])activeAccount(graph,id);for(const id of f.categoryIds??[])if(!graph.categories.some(c=>c.id===id))throw new HttpError(404,'NOT_FOUND');const parties=await partyRows(db,userId);for(const id of f.counterpartyIds??[])activeParty(parties,id);
  for(const o of projection.operations){const day=operationDay(o.date);if((!f.from||day>=f.from)&&(!f.through||day<=f.through)&&(!f.accountIds||f.accountIds.includes(o.accountId))&&(!f.categoryIds||o.parts.some(p=>p.categoryId!==null&&f.categoryIds!.includes(p.categoryId)||p.subcategoryId!==null&&f.categoryIds!.includes(p.subcategoryId)))&&(!f.counterpartyIds||f.counterpartyIds.includes(byId.get(o.id)!.semantics.counterparty.value??'')))initial.add(o.id);}
 }
 if(!initial.size)throw new HttpError(409,'EMPTY_SCOPE');
 const selected=new Set(initial),confirmed=graph.links.filter(l=>l.status==='confirmed');
 if(intent.includeRelated){let added=true;while(added){added=false;for(const l of confirmed)if(selected.has(l.sourceId)||selected.has(l.targetId))for(const id of [l.sourceId,l.targetId])if(!selected.has(id)){selected.add(id);added=true;}}}
 if(selected.size>1000)throw new HttpError(409,'EXCLUSION_SCOPE_LIMIT');
 const operationIds=[...selected].sort(),changed=operationIds.filter(id=>byId.get(id)!.analyticsOverride!==intent.value);if(changed.length)await db.query('UPDATE finance.transaction SET analytics_override=$3,revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,changed,intent.value]);
 const next=structuredClone(graph);for(const o of next.operations)if(selected.has(o.id))o.analyticsOverride=intent.value;const after=reconcile(next),warnings:Record<string,unknown>[]=[];
 for(const l of confirmed.filter(l=>['refund','expense_reimbursement','reversal'].includes(l.kind))){const target=after.operations.find(o=>o.id===l.targetId),source=after.operations.find(o=>o.id===l.sourceId);if(selected.has(l.targetId)&&target?.parts.every(p=>!p.included)&&source?.parts.some(p=>p.included))warnings.push({code:'RELATED_RETURN_STILL_INCLUDED',linkId:l.id,excludedOperationId:l.targetId,includedOperationId:l.sourceId});}
 return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,value:intent.value,operationIds,initialOperationIds:[...initial].sort(),relatedOperationIds:operationIds.filter(id=>!initial.has(id)),changedOperationIds:changed,includeRelated:intent.includeRelated,warnings,financialOperationsDeleted:0}};
}
