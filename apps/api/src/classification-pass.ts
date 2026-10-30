import {reconcile} from '../../../packages/finance-core/src/graph.ts';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {Graph,Operation} from '../../../packages/finance-core/src/model.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {applyRules,ruleMatches} from '../../../packages/finance-core/src/rules.ts';
import {applyMerchantRecognition} from '../../../packages/finance-core/src/merchant-recognition.ts';
import {classificationPlan,digest,applyClassification} from './classification-plan.ts';
export const classificationPassVersion='cashneuro-category-pass/1';
const protectedSources=new Set(['user','personal_rule']);
export function classificationTargets(graph:Graph,rules:Rule[]){return graph.operations.filter(op=>{
 const c=op.semantics.category,s=op.semantics.subcategory,a=graph.accounts.find(a=>a.id===(op.corrections.accountId??op.accountAssignmentId??op.source.accountId));
 return !!a&&!op.decomposition&&!graph.components.some(p=>p.transactionId===op.id)&&['expense','income'].includes(op.semantics.role.value)&&!c.userVerified&&!s.userVerified&&!protectedSources.has(c.source)&&!protectedSources.has(s.source)&&!rules.some(r=>r.enabled&&('categoryId'in r.assignments||'subcategoryId'in r.assignments)&&ruleMatches(op,a,r));
});}
export function knownMerchantChanges(graph:Graph,rules:Rule[]){return graph.operations.filter(op=>['bank-source/4','bank-source/5'].includes(op.source.versions.sourceSanitizer??'')&&!graph.components.some(c=>c.transactionId===op.id)).map(op=>{
 const account=graph.accounts.find(a=>a.id===(op.corrections.accountId??op.accountAssignmentId??op.source.accountId)),ruled=account?applyRules(op,account,rules):op;
 for(const key of ['kind','role','merchant','category','subcategory','counterparty'] as const)if(['kind','role','counterparty'].includes(key)||op.semantics[key].source==='user'||op.semantics[key].userVerified)(ruled.semantics as Record<string,unknown>)[key]=op.semantics[key];
 return {op,next:applyMerchantRecognition(ruled,graph.categories,graph.categoryBindings)};
}).filter(({op,next})=>!isDeepStrictEqual(op.semantics,next.semantics)||!isDeepStrictEqual(op.reviewReasons,next.reviewReasons));}
export function classificationPassBaseline(targets:Operation[],localChanges:{op:Operation}[]){
 const operations=new Map([...targets,...localChanges.map(({op})=>op)].map(op=>[op.id,op]));
 return [...operations.values()].map(op=>({id:op.id,categoryId:op.semantics.category.value,subcategoryId:op.semantics.subcategory.value}));
}
export type PassSummary={scanned:number;defined:number;newlyAssigned:number;changed:number;refined:number;unchanged:number;unresolved:number;needsReview:number};
type Baseline={id:string;categoryId:string|null;subcategoryId:string|null};
export type PassData={version:typeof classificationPassVersion;inputHash:string;catalogHash:string;reconsider:boolean;baseline:Baseline[];summary?:PassSummary};
export type PassRow={id:string;state:string;catalog_hash:string;decisions:PassData;created_at:Date};
export function classificationInput(graph:Graph,rules:Rule[]){
 const targets=classificationTargets(graph,rules),catalogHash=classificationPlan(graph,rules).catalogHash;
 // Automatic output/revisions are excluded: completing a pass cannot enable itself.
 const inputHash=digest({version:classificationPassVersion,catalogHash,rules:[...rules].sort((a,b)=>a.id.localeCompare(b.id)),operations:targets.map(op=>({id:op.id,source:op.source,accountId:op.corrections.accountId??op.accountAssignmentId??op.source.accountId,kind:op.semantics.kind.value,role:op.semantics.role.value})).sort((a,b)=>a.id.localeCompare(b.id))});
 return {targets,catalogHash,inputHash};
}
export async function latestPass(db:PoolClient,userId:string,generation:string){return (await db.query<PassRow>('SELECT id,state,catalog_hash,decisions,created_at FROM finance.classification_run WHERE user_id=$1 AND generation=$2 AND engine=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[userId,generation,classificationPassVersion])).rows[0]??null;}
export async function classificationWork(db:PoolClient,userId:string,graph:Graph,rules:Rule[],generation:string){
 const input=classificationInput(graph,rules),last=await latestPass(db,userId,generation);
 const previousCatalog=last?.decisions.catalogHash??(await db.query('SELECT catalog_hash FROM finance.classification_run WHERE user_id=$1 AND generation=$2 AND engine LIKE $3 ORDER BY created_at DESC,id DESC LIMIT 1',[userId,generation,'cashneuro-category-classification/%'])).rows[0]?.catalog_hash;
 const reconsider=!!previousCatalog&&previousCatalog!==input.catalogHash,plan=classificationPlan(graph,rules,reconsider),cached=(await db.query('SELECT signature,decision FROM finance.classification_cache WHERE user_id=$1',[userId])).rows,bySignature=new Map(cached.map(r=>[r.signature,r.decision]));
 const modelWork=plan.groups.some(g=>!bySignature.has(g.signature)||bySignature.get(g.signature)&&g.operationIds.some(id=>{const op=graph.operations.find(o=>o.id===id)!;try{const next=applyClassification(op,bySignature.get(g.signature));return !isDeepStrictEqual(op.semantics,next.semantics)||!isDeepStrictEqual(op.reviewReasons,next.reviewReasons);}catch{return false;}}));
 const changed=last?.catalog_hash!==input.inputHash||last?.state==='failed'&&modelWork,localChanges=changed?knownMerchantChanges(graph,rules):[];
 return {...input,last,reconsider,localChanges,requiresModel:plan.groups.some(g=>!bySignature.has(g.signature)),needed:changed&&(localChanges.length>0||modelWork)};
}
export async function ensureClassificationPass(db:PoolClient,userId:string,graph:Graph,rules:Rule[],generation:string){
 const work=await classificationWork(db,userId,graph,rules,generation),last=work.last;
 if(last?.state==='received'&&last.catalog_hash===work.inputHash)return last;
 if(last?.catalog_hash===work.inputHash&&(last.state==='completed'||last.state==='failed'&&!work.needed))return null;
 if(last?.state==='received')await db.query("UPDATE finance.classification_run SET state='discarded' WHERE user_id=$1 AND id=$2",[userId,last.id]);
 const data:PassData={version:classificationPassVersion,inputHash:work.inputHash,catalogHash:work.catalogHash,reconsider:work.reconsider,baseline:classificationPassBaseline(work.targets,work.localChanges)};
 return (await db.query<PassRow>("INSERT INTO finance.classification_run(user_id,id,generation,engine,catalog_hash,state,decisions) VALUES($1,$2,$3,$4,$5,'received',$6) RETURNING id,state,catalog_hash,decisions,created_at",[userId,randomUUID(),generation,classificationPassVersion,work.inputHash,JSON.stringify(data)])).rows[0]!;
}
export function summarizeClassification(data:PassData,operations:Operation[],reviewIds?:ReadonlySet<string>):PassSummary{
 const byId=new Map(operations.map(op=>[op.id,op]));let scanned=0,defined=0,newlyAssigned=0,changed=0,refined=0,needsReview=0;
 for(const before of data.baseline){const op=byId.get(before.id);if(!op)continue;scanned++;const c=op.semantics.category.value,s=op.semantics.subcategory.value;if(c!==null)defined++;if(reviewIds?reviewIds.has(op.id):op.reviewReasons.length>0)needsReview++;
  if(c!==before.categoryId||s!==before.subcategoryId){changed++;if(before.categoryId===null&&c!==null)newlyAssigned++;else if(c!==null)refined++;}
 }
 return {scanned,defined,newlyAssigned,changed,refined,unchanged:scanned-changed,unresolved:scanned-defined,needsReview};
}
export async function finishClassificationPass(db:PoolClient,userId:string,pass:PassRow,graph:Graph,state:'completed'|'failed'='completed'){
 const reviewIds=new Set(reconcile(graph).operations.filter(op=>op.reviewReasons.length>0).map(op=>op.id)),data={...pass.decisions,summary:summarizeClassification(pass.decisions,graph.operations,reviewIds)};
 await db.query('UPDATE finance.classification_run SET state=$3,decisions=$4 WHERE user_id=$1 AND id=$2 AND state=$5',[userId,pass.id,state,JSON.stringify(data),'received']);
}
