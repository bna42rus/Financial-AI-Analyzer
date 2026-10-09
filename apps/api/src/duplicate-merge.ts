import type {PoolClient} from 'pg';
import {object,uuid,choice,effective} from '../../../packages/finance-core/src/model.ts';
import {mergeFields,mergeOperationValues} from '../../../packages/finance-core/src/duplicate-merge.ts';
import type {MergeChoices,MergeSide,MergeConflict} from '../../../packages/finance-core/src/duplicate-merge.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
import {dependentLinks} from '../../../packages/finance-core/src/allocation-graph.ts';
import {loadFinance} from './finance.ts';
import {HttpError} from './types.ts';
export type MergeDuplicateIntent={kind:'merge_duplicate';id:string;canonicalId:string;sourceSide:MergeSide;choices:MergeChoices;components?:MergeSide|'none';dropLinkIds:string[]};
export function parseMergeDuplicate(value:unknown):MergeDuplicateIntent{
 const r=object(value,['kind','id','canonicalId','sourceSide','choices','components','dropLinkIds']),raw=object(r.choices??{},[...mergeFields]),choices:MergeChoices={};
 for(const field of mergeFields)if(field in raw)choices[field]=choice(raw[field],['left','right']);
 const links=r.dropLinkIds??[];if(!Array.isArray(links)||links.length>1000)throw new TypeError('INVALID_SELECTION');const dropLinkIds=links.map(uuid);if(new Set(dropLinkIds).size!==dropLinkIds.length)throw new TypeError('DUPLICATE_SELECTION');
 return {kind:'merge_duplicate',id:uuid(r.id),canonicalId:uuid(r.canonicalId),sourceSide:choice(r.sourceSide,['left','right']),choices,...(r.components===undefined?{}:{components:choice(r.components,['left','right','none'])}),dropLinkIds};
}
/** Caller holds authorized access-cycle/workspace locks, in preview or commit. */
export async function mergeDuplicate(db:PoolClient,userId:string,intent:MergeDuplicateIntent){
 const pair=(await db.query('SELECT * FROM finance.duplicate_candidate WHERE user_id=$1 AND id=$2',[userId,intent.id])).rows[0];if(!pair)throw new HttpError(404,'NOT_FOUND');if(pair.status!=='candidate')throw new HttpError(409,'DUPLICATE_ALREADY_RESOLVED');
 const loaded=await loadFinance(db,userId),graph=loaded.graph,left=graph.operations.find(o=>o.id===pair.left_id),right=graph.operations.find(o=>o.id===pair.right_id);
 if(!left||!right)throw new HttpError(409,'OPERATION_MERGED');if(![left.id,right.id].includes(intent.canonicalId))throw new HttpError(404,'NOT_FOUND');
 const ids=[left.id,right.id],family=(await db.query('SELECT id FROM finance.transaction WHERE user_id=$1 AND (id=ANY($2::uuid[]) OR merged_into_id=ANY($2::uuid[])) ORDER BY id',[userId,ids])).rows.map(r=>r.id as string);
 const values=mergeOperationValues(left,right,intent.canonicalId,intent.sourceSide,intent.choices),conflicts:MergeConflict[]=[...values.conflicts],merged=values.merged;
 const lparts=graph.components.filter(c=>c.transactionId===left.id),rparts=graph.components.filter(c=>c.transactionId===right.id);
 if(!intent.components&&lparts.length&&rparts.length)conflicts.push({field:'components',left:lparts,right:rparts});
 const componentSide=intent.components??(lparts.length?'left':rparts.length?'right':'none'),parts=(componentSide==='left'?lparts:componentSide==='right'?rparts:[]).map(c=>({...c,transactionId:merged.id}));merged.decomposition=componentSide!=='none'&&(componentSide==='left'?left.decomposition:right.decomposition);
 if(merged.decomposition&&(!parts.length||parts.reduce((n,p)=>n+BigInt(p.amountMinor),0n)!==BigInt(effective(merged).amountMinor)))conflicts.push({field:'components',reason:'COMPONENT_SUM_CONFLICT'});
 const root=graph.categories.find(c=>c.id===merged.semantics.category.value),sub=graph.categories.find(c=>c.id===merged.semantics.subcategory.value),role=merged.semantics.role.value,allows=(r:string)=>!['expense','income'].includes(role)||r==='both'||r===role;
 if(root&&(root.parentId!==null||!allows(root.role))||sub&&(sub.parentId!==root?.id||!allows(sub.role)))conflicts.push({field:'category',reason:'CATEGORY_ROLE_CONFLICT'});
 const related=graph.links.filter(l=>ids.includes(l.sourceId)||ids.includes(l.targetId)),available=new Set(dependentLinks(graph.links,related.map(l=>l.id)));
 for(const id of intent.dropLinkIds)if(!available.has(id))throw new HttpError(404,'NOT_FOUND');
 const drop=dependentLinks(graph.links,intent.dropLinkIds),dropped=new Set(drop),remap=(id:string)=>ids.includes(id)?merged.id:id;
 const links=graph.links.filter(l=>!dropped.has(l.id)).map(l=>({...l,sourceId:remap(l.sourceId),targetId:remap(l.targetId)}));
 for(const l of links)if(l.sourceId===l.targetId)conflicts.push({field:'links',id:l.id,reason:'SELF_LINK'});
 const next={...graph,operations:[...graph.operations.filter(o=>!ids.includes(o.id)),merged],components:[...graph.components.filter(c=>!ids.includes(c.transactionId)),...parts],links};
 const previous=new Map(reconcile(graph).links.map(l=>[l.id,l]));
 if(!conflicts.some(c=>c.reason==='SELF_LINK'))for(const l of reconcile(next).links)if(l.reason!==null&&(previous.get(l.id)?.reason!==l.reason||previous.get(l.id)?.active))conflicts.push({field:'links',id:l.id,reason:l.reason});
 const sourceOperation=intent.sourceSide==='left'?left:right,sourceId=(await db.query('SELECT source_observation_id FROM finance.transaction WHERE user_id=$1 AND id=$2',[userId,sourceOperation.id])).rows[0].source_observation_id;
 const sources=(await db.query('SELECT count(*)::int AS n FROM finance.source_observation WHERE user_id=$1 AND transaction_id=ANY($2::uuid[])',[userId,family])).rows[0].n;
 const details={kind:'merge_duplicate',canonicalId:merged.id,mapping:family.filter(id=>id!==merged.id).map(id=>({oldId:id,canonicalId:merged.id})),sourceOperationId:sourceOperation.id,sourcesPreserved:sources,conflicts,componentsKept:parts.length,componentsRetired:lparts.length+rparts.length-parts.length,linksMoved:related.filter(l=>!dropped.has(l.id)).map(l=>l.id),linksDropped:drop,undoable:true};
 if(conflicts.length)return {table:'batch' as const,id:intent.id,before:null,details};
 await db.query('DELETE FROM finance.link WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,drop]);
 await db.query('UPDATE finance.component SET active=false,revision=revision+1 WHERE user_id=$1 AND transaction_id=ANY($2::uuid[])',[userId,ids]);
 for(const p of parts)await db.query('UPDATE finance.component SET transaction_id=$3,active=true,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,p.id,merged.id]);
 for(const l of related.filter(l=>!dropped.has(l.id)))await db.query('UPDATE finance.link SET source_id=$3,target_id=$4,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,l.id,remap(l.sourceId),remap(l.targetId)]);
 await db.query('UPDATE finance.transaction SET merged_into_id=$3,revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[]) AND id<>$3',[userId,family,merged.id]);
 await db.query('UPDATE finance.transaction SET source_observation_id=$3,corrections=$4,semantics=$5,comment=$6,analytics_override=$7,decomposition=$8,review_reasons=$9,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,merged.id,sourceId,JSON.stringify(merged.corrections),JSON.stringify(merged.semantics),merged.comment,merged.analyticsOverride,merged.decomposition,JSON.stringify(merged.reviewReasons)]);
 // Rebuild only affected pairs. Keep a prior rejection when aliases collapse pairs.
 const pairs=(await db.query('SELECT * FROM finance.duplicate_candidate WHERE user_id=$1 AND (left_id=ANY($2::uuid[]) OR right_id=ANY($2::uuid[])) ORDER BY id',[userId,ids])).rows;
 const all=(await db.query('SELECT * FROM finance.duplicate_candidate WHERE user_id=$1 ORDER BY id',[userId])).rows,affected=new Set(pairs.map(p=>p.id));
 await db.query('DELETE FROM finance.duplicate_candidate WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,[...affected]]);
 const grouped=new Map<string,typeof pairs>();for(const p of pairs){const [a,b]=[remap(p.left_id),remap(p.right_id)].sort();if(a===b)continue;const k=a+':'+b,list=grouped.get(k)??[];list.push({...p,left_id:a,right_id:b});grouped.set(k,list);}
 for(const list of grouped.values()){const p=list[0]!,existing=all.find(q=>!affected.has(q.id)&&q.left_id===p.left_id&&q.right_id===p.right_id),different=list.some(q=>q.status==='different')||existing?.status==='different';if(existing){if(different&&existing.status!=='different')await db.query("UPDATE finance.duplicate_candidate SET status='different',revision=revision+1 WHERE user_id=$1 AND id=$2",[userId,existing.id]);}else await db.query('INSERT INTO finance.duplicate_candidate(user_id,id,left_id,right_id,status,revision) VALUES($1,$2,$3,$4,$5,$6)',[userId,p.id,p.left_id,p.right_id,different?'different':'candidate',BigInt(p.revision)+1n]);}
 await db.query(`UPDATE finance.transaction t SET review_reasons=CASE WHEN EXISTS(SELECT 1 FROM finance.duplicate_candidate d WHERE d.user_id=t.user_id AND d.status='candidate' AND (d.left_id=t.id OR d.right_id=t.id)) THEN review_reasons||'["possible_duplicate"]'::jsonb ELSE review_reasons-'possible_duplicate' END,revision=revision+1 WHERE t.user_id=$1 AND t.merged_into_id IS NULL AND (review_reasons @> '["possible_duplicate"]'::jsonb) IS DISTINCT FROM EXISTS(SELECT 1 FROM finance.duplicate_candidate d WHERE d.user_id=t.user_id AND d.status='candidate' AND (d.left_id=t.id OR d.right_id=t.id))`,[userId]);
 return {table:'batch' as const,id:intent.id,before:null,details};
}
