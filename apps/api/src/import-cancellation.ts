import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid,initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {BankFact,Semantics} from '../../../packages/finance-core/src/model.ts';
import {applyRules} from '../../../packages/finance-core/src/rules.ts';
import {dependentLinks} from '../../../packages/finance-core/src/allocation-graph.ts';
import {loadFinance} from './finance.ts';
import {canonicalAccount} from './finance-structure.ts';
import type {StructuralUndo} from './finance-structure.ts';
import {HttpError} from './types.ts';

export type CancelImportIntent={kind:'cancel_import';id:string;batchId:string;fileId?:string};
export function parseCancelImport(value:unknown):CancelImportIntent{
 const r=object(value,['kind','batchId','fileId']);return {kind:'cancel_import',id:randomUUID(),batchId:uuid(r.batchId),...(r.fileId===undefined?{}:{fileId:uuid(r.fileId)})};
}
const bankValues=({bankRefHmac,versions,...fact}:BankFact)=>fact;
/** Called only inside the ordinary authorized preview/commit transaction and locks. */
export async function cancelImport(db:PoolClient,userId:string,intent:CancelImportIntent,actionId:string):Promise<StructuralUndo>{
 const batch=(await db.query('SELECT * FROM finance.ingestion_batch WHERE user_id=$1 AND id=$2',[userId,intent.batchId])).rows[0];
 if(!batch)throw new HttpError(404,'NOT_FOUND');
 const all=(await db.query('SELECT id,cancelled_at FROM finance.ingestion_file WHERE user_id=$1 AND batch_id=$2 ORDER BY position',[userId,intent.batchId])).rows;
 if(intent.fileId&&!all.some(f=>f.id===intent.fileId))throw new HttpError(404,'NOT_FOUND');
 const fileIds=all.filter(f=>!f.cancelled_at&&(!intent.fileId||f.id===intent.fileId)).map(f=>f.id as string);
 if(!fileIds.length)throw new HttpError(409,'IMPORT_ALREADY_CANCELLED');
 const before=await loadFinance(db,userId),sources=(await db.query(`SELECT o.id,finance.canonical_operation(o.user_id,o.transaction_id) AS transaction_id FROM finance.source_observation o JOIN finance.ingestion_row r ON (r.user_id,r.id)=(o.user_id,o.import_row_id) WHERE r.user_id=$1 AND r.file_id=ANY($2::uuid[]) ORDER BY o.id`,[userId,fileIds])).rows;
 const affectedParties=(await db.query('SELECT DISTINCT counterparty_id FROM finance.observation_counterparty WHERE user_id=$1 AND observation_id=ANY($2::uuid[])',[userId,sources.map(o=>o.id)])).rows.map(p=>p.counterparty_id);
 const observationIds=sources.map(o=>o.id),affected=[...new Set<string>(sources.map(o=>o.transaction_id))].sort();
 const remaining=(await db.query(`SELECT DISTINCT ON (finance.canonical_operation(user_id,transaction_id)) finance.canonical_operation(user_id,transaction_id) AS transaction_id,id FROM finance.source_observation WHERE user_id=$1 AND finance.canonical_operation(user_id,transaction_id)=ANY($2::uuid[]) AND NOT(id=ANY($3::uuid[])) ORDER BY finance.canonical_operation(user_id,transaction_id),observed_at DESC,id DESC`,[userId,affected,observationIds])).rows;
 // Older materialized observations did not record which text was inherited.
 // Never claim that removing a source can safely restore such shared evidence.
 if((await db.query(`SELECT 1 FROM finance.ingestion_row r JOIN finance.source_observation o ON (o.user_id,o.id)=(r.user_id,r.observation_id) WHERE o.user_id=$1 AND finance.canonical_operation(o.user_id,o.transaction_id)=ANY($2::uuid[]) AND NOT(o.id=ANY($3::uuid[])) AND NOT r.evidence_recorded LIMIT 1`,[userId,affected,observationIds])).rowCount)throw new HttpError(409,'IMPORT_SOURCE_UPGRADE_REQUIRED');
 const shared=new Set<string>(remaining.map(o=>o.transaction_id)),unique=affected.filter(id=>!shared.has(id)),removed=new Set(unique);
 const manualEdits=before.graph.operations.filter(o=>removed.has(o.id)&&(Object.keys(o.corrections).length>0||o.comment!==''||o.analyticsOverride!=='default'||o.decomposition||Object.values(o.semantics).some(f=>f.userVerified||f.source==='user'))).map(o=>o.id);
 const linked=before.graph.links.filter(l=>affected.includes(l.sourceId)||affected.includes(l.targetId)).map(l=>l.id),deletedLinks=dependentLinks(before.graph.links,before.graph.links.filter(l=>removed.has(l.sourceId)||removed.has(l.targetId)).map(l=>l.id));
 const components=(await db.query('SELECT count(*)::int AS n FROM finance.component WHERE user_id=$1 AND finance.canonical_operation(user_id,transaction_id)=ANY($2::uuid[])',[userId,unique])).rows[0].n;
 const pending=(await db.query("SELECT count(*)::int AS n FROM finance.ingestion_row WHERE user_id=$1 AND file_id=ANY($2::uuid[]) AND status='pending'",[userId,fileIds])).rows[0].n;
 const analyzerChats=Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_chat WHERE user_id=$1',[userId])).rows[0].n);
 const history=(await db.query("SELECT count(*)::int AS n FROM finance.action WHERE user_id=$1 AND id<>$2 AND NOT(status='committed' AND COALESCE(intent->'canonical'->>'receipt','false')='true')",[userId,actionId])).rows[0].n;
 await db.query('DELETE FROM finance.link WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,deletedLinks]);
 await db.query('DELETE FROM finance.transaction WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,unique]);
 for(const o of remaining)await db.query('UPDATE finance.transaction SET source_observation_id=$3,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,o.transaction_id,o.id]);
 // Archived IDs remain usable references, but cannot retain the cancelled source.
 await db.query(`UPDATE finance.transaction t SET source_observation_id=(SELECT o.id FROM finance.source_observation o WHERE (o.user_id,o.transaction_id)=(t.user_id,t.id) AND NOT(o.id=ANY($2::uuid[])) ORDER BY o.observed_at DESC,o.id DESC LIMIT 1),revision=revision+1 WHERE t.user_id=$1 AND t.merged_into_id IS NOT NULL AND t.source_observation_id=ANY($2::uuid[])`,[userId,observationIds]);
 const emptyAliases=(await db.query('SELECT id FROM finance.transaction WHERE user_id=$1 AND merged_into_id IS NOT NULL AND source_observation_id IS NULL',[userId])).rows.map(r=>r.id);
 if(emptyAliases.length){await db.query('DELETE FROM finance.component WHERE user_id=$1 AND finance.canonical_operation(user_id,transaction_id)=ANY($2::uuid[])',[userId,emptyAliases]);await db.query("UPDATE finance.transaction SET corrections='{}',semantics=$3,comment='',analytics_override='default',decomposition=false,review_reasons='[]',revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[])",[userId,emptyAliases,JSON.stringify(initialSemantics('other'))]);}
 // FK cascade removes observations, source bindings, fingerprints and staged fragments.
 await db.query('DELETE FROM finance.ingestion_row WHERE user_id=$1 AND file_id=ANY($2::uuid[])',[userId,fileIds]);
 await db.query('UPDATE finance.ingestion_file SET file_hmac=NULL,cancelled_at=clock_timestamp() WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,fileIds]);
 // Inactive IDs also must not retain bank classification copied by an earlier
 // merge from a now-cancelled source. Keep explicit manual decisions only.
 const archived=(await db.query(`SELECT t.id,t.semantics,o.source_kind,o.merchant_text,b.counterparty_id FROM finance.transaction t JOIN finance.source_observation o ON (o.user_id,o.id)=(t.user_id,t.source_observation_id) LEFT JOIN finance.observation_counterparty b ON (b.user_id,b.observation_id)=(o.user_id,o.id) WHERE t.user_id=$1 AND t.merged_into_id=ANY($2::uuid[])`,[userId,[...shared]])).rows;
 for(const row of archived){const fresh=initialSemantics(row.source_kind,row.merchant_text);if(row.source_kind==='other')fresh.kind=facet('other','bank',false,0);if(row.counterparty_id)fresh.counterparty=facet(row.counterparty_id,'bank');for(const key of Object.keys(fresh) as (keyof Semantics)[])if(row.semantics[key].userVerified||row.semantics[key].source==='user')(fresh as unknown as Record<string,unknown>)[key]=row.semantics[key];await db.query('UPDATE finance.transaction SET semantics=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,row.id,JSON.stringify(fresh)]);}
 const restored=await loadFinance(db,userId),restorations=[];
 for(const op of restored.graph.operations.filter(o=>shared.has(o.id))){
  const old=before.graph.operations.find(o=>o.id===op.id)!,fresh=initialSemantics(op.source.sourceKind!,op.source.merchantText);if(op.source.sourceKind==='other')fresh.kind=facet('other','bank',false,0);
  const party=(await db.query('SELECT counterparty_id FROM finance.observation_counterparty WHERE user_id=$1 AND observation_id=$2',[userId,remaining.find(o=>o.transaction_id===op.id)!.id])).rows[0];
  if(party)fresh.counterparty=facet(party.counterparty_id,'bank');
  for(const key of Object.keys(fresh) as (keyof Semantics)[])if(op.semantics[key].userVerified||op.semantics[key].source==='user')(fresh as unknown as Record<string,unknown>)[key]=op.semantics[key];
  const classified=applyRules({...op,semantics:fresh},canonicalAccount(restored.graph,op.accountAssignmentId??op.source.accountId),restored.rules);
  await db.query('UPDATE finance.transaction SET semantics=$3,analytics_override=$4,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,op.id,JSON.stringify(classified.semantics),classified.analyticsOverride]);
  restorations.push({operationId:op.id,before:bankValues(old.source),after:bankValues(op.source)});
 }
 await db.query(`UPDATE finance.transaction t SET review_reasons=review_reasons-'possible_duplicate',revision=revision+1 WHERE t.user_id=$1 AND review_reasons @> '["possible_duplicate"]'::jsonb AND NOT EXISTS(SELECT 1 FROM finance.duplicate_candidate d WHERE d.user_id=t.user_id AND d.status='candidate' AND (d.left_id=t.id OR d.right_id=t.id))`,[userId]);
 // Preserve empty accounts and all user-created/renamed/registered/rule-bound parties.
 const orphanParties=(await db.query(`SELECT p.id FROM finance.counterparty p WHERE p.user_id=$1 AND p.id=ANY($2::uuid[]) AND p.state='discovered' AND p.revision=0 AND p.merged_into_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM finance.transaction t WHERE t.user_id=p.user_id AND t.counterparty_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM finance.observation_counterparty o WHERE o.user_id=p.user_id AND o.counterparty_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM finance.rule r WHERE r.user_id=p.user_id AND (r.conditions->>'counterpartyId'=p.id::text OR r.assignments->>'counterpartyId'=p.id::text))
 AND NOT EXISTS(SELECT 1 FROM finance.counterparty child WHERE child.user_id=p.user_id AND child.merged_into_id=p.id)`,[userId,affectedParties])).rows.map(p=>p.id);
 const cpAliases=(await db.query('SELECT count(*)::int AS n FROM finance.counterparty_alias WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,orphanParties])).rows[0].n;
 await db.query('DELETE FROM finance.counterparty WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,orphanParties]);
 await db.query("DELETE FROM finance.action WHERE user_id=$1 AND id<>$2 AND NOT(status='committed' AND COALESCE(intent->'canonical'->>'receipt','false')='true')",[userId,actionId]);
 const next=(await db.query('UPDATE finance.workspace SET generation=gen_random_uuid() WHERE user_id=$1 RETURNING generation',[userId])).rows[0];
 // Remaining files keep their already accepted work, while stale browser contexts are fenced.
 await db.query("UPDATE finance.ingestion_batch SET generation=$2 WHERE user_id=$1 AND status IN ('accepted','processing')",[userId,next.generation]);
 const uncancelled=all.length-fileIds.length-all.filter(f=>f.cancelled_at).length;
 if(!uncancelled){await db.query("UPDATE finance.ingestion_batch SET status='cancelled',cancelled_at=clock_timestamp(),finished_at=clock_timestamp(),request_digest=$3 WHERE user_id=$1 AND id=$2",[userId,intent.batchId,'0'.repeat(64)]);await db.query('DELETE FROM finance.ingestion_dispatch WHERE user_id=$1 AND batch_id=$2',[userId,intent.batchId]);}
 const details={kind:'cancel_import',destructive:true,undoable:false,reimportWarning:true,scope:{batchId:intent.batchId,...(intent.fileId?{fileId:intent.fileId}:{})},sourceRestorations:restorations,manualEditOperationIds:manualEdits,accountsDeleted:[],counterpartiesDeleted:orphanParties,aliasesDeleted:0,counterpartyAliasesDeleted:cpAliases,counts:{analyzerChats:analyzerChats-Number((await db.query('SELECT count(*) AS n FROM finance.analyzer_chat WHERE user_id=$1',[userId])).rows[0].n),files:fileIds.length,operations:unique.length,sharedOperations:shared.size,observations:observationIds.length,components,manualEdits:manualEdits.length,linksRecalculated:dependentLinks(before.graph.links,linked).length,linksDeleted:deletedLinks.length,pendingRows:pending,history},historyPolicy:'clear_financial_history_and_previews'};
 return {table:'delete',id:intent.id,before:null,details};
}
