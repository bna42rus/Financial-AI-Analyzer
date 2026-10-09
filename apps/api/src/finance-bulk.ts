import {randomUUID} from 'node:crypto';
import {object,choice,uuid,correction} from '../../../packages/finance-core/src/model.ts';
import {kinds} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {HttpError} from './types.ts';
export const verificationFacets=['kind','role','category','subcategory'] as const;
export type VerificationFacet=typeof verificationFacets[number];
export type BulkIntent={kind:'bulk_operations';id:string;operationIds:string[];patch:Record<string,unknown>;verify:VerificationFacet[]};
export function parseOperationPatch(value:unknown){
 const p=object(value,['corrections','kind','role','categoryId','subcategoryId','merchant','counterpartyId','comment','analyticsOverride','reviewRequested']),out:Record<string,unknown>={};
 if('corrections'in p)out.corrections=p.corrections===null?{}:correction(p.corrections);
 if('kind'in p)out.kind=choice(p.kind,kinds);if('role'in p)out.role=choice(p.role,['expense','income','neutral','unresolved']);
 for(const k of ['categoryId','subcategoryId','counterpartyId']as const)if(k in p)out[k]=p[k]===null?null:uuid(p[k]);
 for(const k of ['merchant','comment']as const)if(k in p)out[k]=safeText(p[k],k==='comment'?1000:160);
 if('analyticsOverride'in p)out.analyticsOverride=choice(p.analyticsOverride,['default','include','exclude']);
 if('reviewRequested'in p){if(typeof p.reviewRequested!=='boolean')throw new TypeError('INVALID_BOOLEAN');out.reviewRequested=p.reviewRequested;}
 if(!Object.keys(out).length)throw new TypeError('EMPTY_PATCH');return out;
}
export function selectionIds(value:unknown){if(!Array.isArray(value)||!value.length||value.length>1000)throw new TypeError('INVALID_SELECTION');const ids=value.map(uuid);if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_SELECTION');return ids;}
export function parseBulkIntent(value:unknown):BulkIntent {
 const r=object(value,['kind','operationIds','patch','verify']),patch=r.patch===undefined?{}:parseOperationPatch(object(r.patch,['kind','role','categoryId','subcategoryId','counterpartyId','comment','analyticsOverride','reviewRequested']));
 const verify=r.verify===undefined?[]:Array.isArray(r.verify)&&r.verify.length<=4?r.verify.map(v=>choice(v,verificationFacets)):(()=>{throw new TypeError('INVALID_VERIFICATION');})();
 if(new Set(verify).size!==verify.length||!verify.length&&!Object.keys(patch).length||verify.length&&Object.keys(patch).length)throw new TypeError('INVALID_BULK_ACTION');
 if('subcategoryId'in patch&&!('categoryId'in patch))throw new TypeError('CATEGORY_REQUIRED');
 if('categoryId'in patch&&!('subcategoryId'in patch))patch.subcategoryId=null;
 return {kind:'bulk_operations',id:randomUUID(),operationIds:selectionIds(r.operationIds),patch,verify};
}
export function bulkPatches(intent:BulkIntent,graph:Graph){
 const byId=new Map(graph.operations.map(o=>[o.id,o])),projection=new Map(reconcile(graph).operations.map(o=>[o.id,o]));
 return intent.operationIds.map(id=>{
  const op=byId.get(id);if(!op)throw new HttpError(404,'NOT_FOUND');
  const patch=structuredClone(intent.patch),facets={kind:'kind',role:'role',category:'categoryId',subcategory:'subcategoryId'}as const;
  for(const f of intent.verify)patch[facets[f]]=op.semantics[f].value;
  if(projection.get(id)!.decompositionActive&&['role','categoryId','subcategoryId'].some(k=>k in patch))throw new HttpError(409,'BULK_COMPONENT_REVIEW_REQUIRED');
  return {id,patch};
 });
}
