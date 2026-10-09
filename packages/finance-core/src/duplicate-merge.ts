import type {Operation,Semantics} from './model.ts';
export const mergeFields=['kind','role','category','subcategory','merchant','counterparty','amountMinor','operationDate','postedDate','accountId','comment','analyticsOverride'] as const;
export type MergeField=typeof mergeFields[number];
export type MergeSide='left'|'right';
export type MergeChoices=Partial<Record<MergeField,MergeSide>>;
export type MergeConflict={field:string;left?:unknown;right?:unknown;reason?:string;id?:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const manual=(f:Semantics[keyof Semantics])=>f.userVerified||f.source==='user';
/** Choices select existing owned values. No arbitrary value or inferred conflict resolution. */
export function mergeOperationValues(left:Operation,right:Operation,canonicalId:string,sourceSide:MergeSide,choices:MergeChoices){
 const source=sourceSide==='left'?left:right,merged:Operation=structuredClone(source),conflicts:MergeConflict[]=[],differences:{field:MergeField;left:unknown;right:unknown;requiresChoice:boolean}[]=[];merged.id=canonicalId;
 const select=(field:MergeField,a:unknown,b:unknown,am:boolean,bm:boolean):MergeSide=>{
  if((am||bm)&&!same(a,b))differences.push({field,left:a,right:b,requiresChoice:am&&bm});
  if(choices[field])return choices[field]!;
  if(am&&bm&&!same(a,b))conflicts.push({field,left:a,right:b});
  return am&&!bm?'left':bm&&!am?'right':sourceSide;
 };
 for(const field of ['kind','role','category','subcategory','merchant','counterparty'] as const){const a=left.semantics[field],b=right.semantics[field],side=select(field,a.value,b.value,manual(a),manual(b));(merged.semantics as unknown as Record<string,unknown>)[field]=structuredClone(side==='left'?a:b);}
 merged.corrections={};
 for(const field of ['amountMinor','operationDate','postedDate','accountId'] as const){const a=left.corrections[field],b=right.corrections[field],side=select(field,a,b,field in left.corrections,field in right.corrections),value=side==='left'?a:b;if(value!==undefined)(merged.corrections as Record<string,unknown>)[field]=structuredClone(value);}
 merged.comment=select('comment',left.comment,right.comment,!!left.comment,!!right.comment)==='left'?left.comment:right.comment;
 merged.analyticsOverride=select('analyticsOverride',left.analyticsOverride,right.analyticsOverride,left.analyticsOverride!=='default',right.analyticsOverride!=='default')==='left'?left.analyticsOverride:right.analyticsOverride;
 merged.reviewReasons=[...new Set([...left.reviewReasons,...right.reviewReasons])].filter(r=>r!=='possible_duplicate');
 return {merged,conflicts,differences};
}
