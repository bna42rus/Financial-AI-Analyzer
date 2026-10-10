import type {Semantics} from './model.ts';
export type ReviewGroupOperation={id:string;accountId:string;amountMinor:string;classification:Semantics;decompositionActive:boolean;reviewReasons:string[];parts:{included:boolean}[]};
const allowedReasons=new Set(['low_kind_confidence','low_role_confidence','low_category_confidence','category_not_defined','user_requested_review','unresolved_role']);
function signature(o:ReviewGroupOperation):string|null{
 const s=o.classification,merchant=s.merchant.value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
 if(!merchant||s.kind.value!=='purchase'||BigInt(o.amountMinor)>=0n||o.decompositionActive||!o.reviewReasons.length||o.reviewReasons.some(r=>!allowedReasons.has(r)))return null;
 return JSON.stringify([o.accountId,merchant,...(['kind','role','category','subcategory','counterparty'] as const).map(k=>[s[k].value,s[k].userVerified]),o.parts.map(p=>p.included),[...o.reviewReasons].sort()]);
}
/** A suggestion only, restricted to the persisted session. No new import, resolved
 * item, transfer/refund, duplicate or structural conflict can widen this scope. */
export function reviewGroupIds(operations:ReviewGroupOperation[],fixedIds:string[],anchorId:string):string[]{
 if(fixedIds.length>1000||!fixedIds.includes(anchorId))return [];
 const byId=new Map(operations.map(o=>[o.id,o])),anchor=byId.get(anchorId),key=anchor?signature(anchor):null;
 if(key===null)return [];
 const ids=fixedIds.filter(id=>{const o=byId.get(id);return o&&signature(o)===key;});
 return ids.length>1?ids:[];
}
