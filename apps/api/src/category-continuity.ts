import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {categoryTargets} from '../../../packages/finance-core/src/catalog/generated/activity-v1.ts';
import {resolveOwnCategory} from '../../../packages/finance-core/src/category-resolution.ts';
import {activityDecision} from '../../../packages/finance-core/src/activity-recognition.ts';
/** Capture an existing, unambiguous meaning before a label changes. Never create
 * a category or infer a binding from a single manual operation. */
export function categoryContinuity(graph:Graph,id:string){
 const result=new Map<string,{categoryId:string;subcategoryId:string|null}>();
 for(const target of categoryTargets){if(graph.categoryBindings?.[target.key])continue;const r=resolveOwnCategory(target.key,graph.categories);if(r.status==='resolved'&&(r.categoryId===id||r.subcategoryId===id))result.set(target.key,{categoryId:r.categoryId,subcategoryId:r.subcategoryId});}
 const seen=new Map<string,Set<string>>();
 for(const op of graph.operations){const c=op.semantics.category,s=op.semantics.subcategory;if(!c.value||c.userVerified||s.userVerified||!['ai','global_rule'].includes(c.source)||c.confidence<90||c.ruleId)continue;const evidence=activityDecision(op,graph.categories)?.evidence;if(evidence?.status!=='recognized'||!evidence.targetKey||!categoryTargets.some(t=>t.key===evidence.targetKey))continue;const values=seen.get(evidence.targetKey)??new Set<string>();values.add(JSON.stringify({categoryId:c.value,subcategoryId:s.value}));seen.set(evidence.targetKey,values);}
 for(const [key,values]of seen)if(values.size===1&&!graph.categoryBindings?.[key]){const pair=JSON.parse([...values][0]!) as {categoryId:string;subcategoryId:string|null};if(pair.categoryId===id||pair.subcategoryId===id)result.set(key,pair);}
 return [...result].map(([key,pair])=>({key,...pair}));
}
export async function preserveCategoryContinuity(db:PoolClient,userId:string,graph:Graph,id:string){for(const b of categoryContinuity(graph,id))await db.query('INSERT INTO finance.category_binding(user_id,id,target_key,category_id,subcategory_id,automatic) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(user_id,target_key) DO NOTHING',[userId,randomUUID(),b.key,b.categoryId,b.subcategoryId]);}

/** Only a user-requested pass may remember inferred mappings; private mappings win. */
export async function rememberClassificationBindings(db:PoolClient,userId:string,graph:Graph){
 const seen=new Map<string,Set<string>>();
 for(const op of graph.operations){const c=op.semantics.category,s=op.semantics.subcategory;if(c.source!=='ai'||c.userVerified||s.userVerified||!c.value||c.confidence<90)continue;const e=activityDecision(op,graph.categories)?.evidence;if(e?.status!=='recognized'||!e.targetKey||!categoryTargets.some(t=>t.key===e.targetKey)||graph.categoryBindings?.[e.targetKey]&&!graph.categoryBindings[e.targetKey]!.automatic)continue;const values=seen.get(e.targetKey)??new Set<string>();values.add(JSON.stringify({categoryId:c.value,subcategoryId:s.value,automatic:true}));seen.set(e.targetKey,values);}
 const added:Record<string,{categoryId:string;subcategoryId:string|null;automatic:boolean}>={};
 for(const [key,values] of seen){if(values.size!==1)continue;const pair=JSON.parse([...values][0]!) as {categoryId:string;subcategoryId:string|null;automatic:boolean};await db.query(`INSERT INTO finance.category_binding(user_id,id,target_key,category_id,subcategory_id,automatic) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(user_id,target_key) DO UPDATE SET category_id=EXCLUDED.category_id,subcategory_id=EXCLUDED.subcategory_id,revision=finance.category_binding.revision+1 WHERE finance.category_binding.automatic`,[userId,randomUUID(),key,pair.categoryId,pair.subcategoryId]);added[key]=pair;}
 return added;
}
