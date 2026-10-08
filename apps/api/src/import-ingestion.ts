import {sourceFields} from '../../../packages/imports/src/safe-source.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ImportContractError,parseContext,validatePreparedBatch} from '../../../packages/imports/src/contract.ts';
import type {PreparedRow,Bank} from '../../../packages/imports/src/contract.ts';
import {bankPdfAdapter,pdfParserVersions} from '../../../packages/imports/src/bank-pdf.ts';
import {matchSource,sameSource} from '../../../packages/imports/src/matching.ts';
import type {SourceCandidate} from '../../../packages/imports/src/matching.ts';
import {object,uuid,initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {Operation,BankFact} from '../../../packages/finance-core/src/model.ts';
import {applyRules} from '../../../packages/finance-core/src/rules.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
import {prepareFinance,loadFinance,withPreparedImport} from './finance.ts';
import {canonicalAccount} from './finance-structure.ts';
import {stableJSON} from './finance-history.ts';
import {HttpError} from './types.ts';

export const IMPORT_CHUNK=50;
const bankNames:Record<Bank,string>={tbank:'Т-Банк',ozon:'Ozon Банк',sber:'Сбербанк',other:'Другой банк'};

/** After acceptance, prepared context TTL is no longer a worker credential.
 * Retries still require current access, epoch, key and the identical canonical request. */
export async function acceptImport(db:PoolClient,userId:string,input:unknown){
 try{
  const context=parseContext(input&&typeof input==='object'?(input as Record<string,unknown>).context:undefined);
  const state=await prepareFinance(db,userId);
  if(context.generation!==state.generation||context.keyVersion!==state.key_version)throw new HttpError(409,'IMPORT_CONTEXT_CHANGED');
  const {batch}=validatePreparedBatch(input);
  const digest=createHash('sha256').update(stableJSON({...batch,context:{generation:context.generation,keyVersion:context.keyVersion}})).digest('hex');
  const previous=(await db.query('SELECT request_digest FROM finance.ingestion_batch WHERE user_id=$1 AND id=$2',[userId,batch.batchId])).rows[0];
  if(previous){if(previous.request_digest!==digest)throw new HttpError(409,'IMPORT_BATCH_REUSED');return importReport(db,userId,batch.batchId);}
  return await withPreparedImport(db,userId,context,async()=>{
   if((await db.query("SELECT 1 FROM finance.ingestion_batch WHERE user_id=$1 AND status IN ('accepted','processing')",[userId])).rowCount)throw new HttpError(409,'IMPORT_ALREADY_ACTIVE');
   if((await db.query('SELECT 1 FROM finance.ingestion_file WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,batch.files.map(f=>f.fileId)])).rowCount)throw new HttpError(409,'IMPORT_FILE_REUSED');
   await db.query("INSERT INTO finance.ingestion_batch(user_id,id,generation,key_version,request_digest,versions,status) VALUES($1,$2,$3,$4,$5,$6,'accepted')",[userId,batch.batchId,context.generation,context.keyVersion,digest,JSON.stringify(batch.versions)]);
   for(const [position,file] of batch.files.entries()){
    await db.query('INSERT INTO finance.ingestion_file(user_id,id,batch_id,position,bank,file_hmac,rows_found,blocked,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[userId,file.fileId,batch.batchId,position+1,file.bank,file.fileHmac,file.rowsFound,file.status==='blocked',file.error]);
    for(const row of file.rows)await db.query("INSERT INTO finance.ingestion_row(user_id,id,file_id,ordinal,status,payload) VALUES($1,$2,$3,$4,'pending',$5)",[userId,randomUUID(),file.fileId,row.ordinal,JSON.stringify(row)]);
    for(const issue of file.issues)await db.query("INSERT INTO finance.ingestion_row(user_id,id,file_id,ordinal,status,issue) VALUES($1,$2,$3,$4,'issue',$5)",[userId,randomUUID(),file.fileId,issue.ordinal,issue.code]);
   }
   await db.query('INSERT INTO finance.ingestion_dispatch(user_id,batch_id) VALUES($1,$2)',[userId,batch.batchId]);
   // Acceptance invalidates previews whose dependency snapshots omit the new durable import.
   await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);
   return importReport(db,userId,batch.batchId);
  });
 }catch(error){if(error instanceof ImportContractError)throw new HttpError(400,'INVALID_IMPORT_PAYLOAD');throw error;}
}

export async function importStatus(db:PoolClient,userId:string,input:unknown){
 await prepareFinance(db,userId);const r=object(input,['batchId']);return importReport(db,userId,uuid(r.batchId));
}
async function importReport(db:PoolClient,userId:string,batchId:string){
 const batch=(await db.query('SELECT status,created_at,finished_at FROM finance.ingestion_batch WHERE user_id=$1 AND id=$2',[userId,batchId])).rows[0];
 if(!batch)throw new HttpError(404,'NOT_FOUND');
 const files=(await db.query('SELECT id,bank,rows_found,blocked,error FROM finance.ingestion_file WHERE user_id=$1 AND batch_id=$2 ORDER BY position',[userId,batchId])).rows;
 const rows=(await db.query(`SELECT r.file_id,r.ordinal,r.status,r.issue,r.outcome,o.transaction_id FROM finance.ingestion_row r JOIN finance.ingestion_file f ON (f.user_id,f.id)=(r.user_id,r.file_id)
 LEFT JOIN finance.source_observation o ON (o.user_id,o.id)=(r.user_id,r.observation_id) WHERE f.user_id=$1 AND f.batch_id=$2 ORDER BY f.position,r.ordinal`,[userId,batchId])).rows;
 const involved=new Set(rows.map(r=>r.transaction_id).filter(Boolean)),projection=reconcile((await loadFinance(db,userId)).graph);
 const review=new Set(projection.operations.filter(o=>involved.has(o.id)&&o.reviewReasons.length).map(o=>o.id));
 const transactionCounts=(items:typeof rows)=>{
  const outcomes=new Map<string,string>();
  const rank:Record<string,number>={existing:0,updated:1,created:2};
  for(const row of items)if(row.transaction_id&&row.outcome&&(!outcomes.has(row.transaction_id)||rank[row.outcome]!>rank[outcomes.get(row.transaction_id)!]!))outcomes.set(row.transaction_id,row.outcome);
  return {total:outcomes.size,created:[...outcomes.values()].filter(v=>v==='created').length,existing:[...outcomes.values()].filter(v=>v==='existing').length,updated:[...outcomes.values()].filter(v=>v==='updated').length,review:[...outcomes.keys()].filter(id=>review.has(id)).length};
 };
 const reports=files.map(f=>{
  const own=rows.filter(r=>r.file_id===f.id),imported=own.filter(r=>r.status==='imported'),removed=f.blocked?0:f.rows_found-own.length;
  return {fileId:f.id,bank:f.bank,blocked:f.blocked,error:f.error,counts:{rowsFound:f.rows_found,pending:own.filter(r=>r.status==='pending').length,created:imported.filter(r=>r.outcome==='created').length,existing:imported.filter(r=>r.outcome==='existing').length,updated:imported.filter(r=>r.outcome==='updated').length,notImported:f.blocked?f.rows_found:own.filter(r=>r.status==='issue').length,removed,review:new Set(imported.filter(r=>review.has(r.transaction_id)).map(r=>r.transaction_id)).size},transactionCounts:transactionCounts(own),issues:own.filter(r=>r.status==='issue').map(r=>({ordinal:r.ordinal,code:r.issue,nextStep:r.issue==='IMPORT_INVALIDATED'?'reupload':'verify_local_source'}))};
 });
 const sum=(key:'rowsFound'|'pending'|'created'|'existing'|'updated'|'notImported'|'removed')=>reports.reduce((n,f)=>n+f.counts[key],0);
 return {schemaVersion:1,batchId,stage:'server_accepted',status:batch.status,createdAt:batch.created_at,finishedAt:batch.finished_at,files:reports,counts:{files:files.length,blockedFiles:files.filter(f=>f.blocked).length,rowsFound:sum('rowsFound'),pending:sum('pending'),created:sum('created'),existing:sum('existing'),updated:sum('updated'),notImported:sum('notImported'),removed:sum('removed'),review:review.size},transactionCounts:transactionCounts(rows),newAccountIds:(await db.query('SELECT account_id FROM finance.ingestion_account WHERE user_id=$1 AND batch_id=$2 ORDER BY account_id',[userId,batchId])).rows.map(r=>r.account_id)};
}

/** One atomic checkpoint under access-cycle -> workspace locks. Caller owns the transaction. */
export async function processImport(db:PoolClient,userId:string,batchId:string){
 const state=await prepareFinance(db,userId),batch=(await db.query('SELECT * FROM finance.ingestion_batch WHERE user_id=$1 AND id=$2',[userId,batchId])).rows[0];
 if(!batch)throw new HttpError(404,'NOT_FOUND');
 if(!['accepted','processing'].includes(batch.status))return;
 if(batch.generation!==state.generation||batch.key_version!==state.key_version){await invalidatePendingImports(db,userId);return;}
 const pending=(await db.query(`SELECT r.id,r.file_id,r.payload,f.bank,f.file_hmac FROM finance.ingestion_row r JOIN finance.ingestion_file f ON (f.user_id,f.id)=(r.user_id,r.file_id)
 WHERE f.user_id=$1 AND f.batch_id=$2 AND r.status='pending' ORDER BY f.position,r.ordinal LIMIT $3`,[userId,batchId,IMPORT_CHUNK])).rows;
 await db.query("UPDATE finance.ingestion_batch SET status='processing' WHERE user_id=$1 AND id=$2",[userId,batchId]);
 const loaded=await loadFinance(db,userId),graph=loaded.graph;
 for(const entry of pending){
  const row=entry.payload as PreparedRow,bank=entry.bank as Bank;
  let accountId:string;
  const alias=(await db.query('SELECT a.account_id,b.bank_id FROM finance.account_alias a JOIN finance.account b ON (b.user_id,b.id)=(a.user_id,a.account_id) WHERE a.user_id=$1 AND a.alias_type=$2 AND a.alias_hmac=$3',[userId,row.account.kind,row.account.hmac])).rows[0];
  if(alias&&alias.bank_id!==bank){await db.query("UPDATE finance.ingestion_row SET status='issue',issue='ACCOUNT_MATCH_CONFLICT',payload=NULL WHERE user_id=$1 AND id=$2",[userId,entry.id]);continue;}
  if(alias)accountId=canonicalAccount(graph,alias.account_id).id;
  else{
   accountId=randomUUID();const name=bankNames[bank]+' · Счёт '+(graph.accounts.filter(a=>a.bankId===bank).length+1),type=row.account.kind==='loan_contract'?'loan':'other';
   await db.query('INSERT INTO finance.account(user_id,id,bank_id,system_name,display_name,account_type) VALUES($1,$2,$3,$4,$4,$5)',[userId,accountId,bank,name,type]);
   await db.query('INSERT INTO finance.account_alias(user_id,id,account_id,alias_type,alias_hmac) VALUES($1,$2,$3,$4,$5)',[userId,randomUUID(),accountId,row.account.kind,row.account.hmac]);
   await db.query('INSERT INTO finance.ingestion_account(user_id,id,batch_id,account_id) VALUES($1,$2,$3,$4)',[userId,randomUUID(),batchId,accountId]);
   graph.accounts.push({id:accountId,bankId:bank,name,type,analyticsEnabled:true,defaultVisible:true,loanMode:null});
  }
  // Immutable observations + original source aliases survive effective edits and explicit account splits.
  const candidates=(await db.query<SourceCandidate>(`SELECT o.transaction_id AS "transactionId",f.file_hmac AS "fileHmac",r.ordinal,o.bank_ref_hmac AS "bankRefHmac",o.operation_date AS "operationDate",o.posted_date AS "postedDate",o.amount_minor::text AS "amountMinor",o.currency,r.direction
  FROM finance.ingestion_row r JOIN finance.ingestion_file f ON (f.user_id,f.id)=(r.user_id,r.file_id) JOIN finance.source_observation o ON (o.user_id,o.id)=(r.user_id,r.observation_id)
  WHERE r.user_id=$1 AND r.alias_kind=$2 AND r.alias_hmac=$3 AND f.bank=$4 AND r.status='imported'`,[userId,row.account.kind,row.account.hmac,bank])).rows;
  const used=new Set<string>((await db.query('SELECT o.transaction_id FROM finance.ingestion_row r JOIN finance.source_observation o ON (o.user_id,o.id)=(r.user_id,r.observation_id) WHERE r.user_id=$1 AND r.file_id=$2',[userId,entry.file_id])).rows.map(r=>r.transaction_id));
  const match=matchSource(row,entry.file_hmac,candidates,used),transactionId=match.transactionId??randomUUID(),observationId=randomUUID();
  const prior=match.transactionId?(await db.query(`SELECT t.semantics,t.source_observation_id,o.*,r.direction FROM finance.transaction t JOIN finance.source_observation o ON (o.user_id,o.id)=(t.user_id,t.source_observation_id) LEFT JOIN finance.ingestion_row r ON (r.user_id,r.observation_id)=(o.user_id,o.id) WHERE t.user_id=$1 AND t.id=$2`,[userId,transactionId])).rows[0]:null;
  const signals=sourceFields(row.safeSource);
  // Missing evidence from either profile cannot erase an earlier sanitized source.
  if(prior&&row.safeSource&&!signals.merchantText&&prior.source_kind===signals.sourceKind)signals.merchantText=prior.merchant_text;
  const source=prior&&!row.safeSource?{sourceKind:prior.source_kind,merchantText:prior.merchant_text,description:prior.description}:signals;
  const unchanged=prior&&prior.source_kind===source.sourceKind&&prior.merchant_text===source.merchantText&&prior.description===source.description&&sameSource(row,{transactionId,fileHmac:'',ordinal:0,bankRefHmac:prior.bank_ref_hmac,operationDate:prior.operation_date,postedDate:prior.posted_date,amountMinor:prior.amount_minor,currency:prior.currency,direction:prior.direction??row.direction});
  const parser=batch.versions.adapter===bankPdfAdapter&&bank!=='other'?pdfParserVersions[bank]:batch.versions.adapter;
  const fact:BankFact={accountId,operationDate:row.operationDate,postedDate:row.postedDate,amountMinor:row.amountMinor,currency:row.currency,...source,bankCategory:prior?.bank_category??'',bankRefHmac:row.bankRefHmac,versions:{parser,normalizer:batch.versions.normalizer,sanitizer:batch.versions.sanitizer,pipeline:batch.versions.pipeline,hmac:batch.versions.hmac,classification:row.safeSource?'bank-signals/1':prior?.versions.classification??'unclassified/1',sourceSanitizer:row.safeSource?batch.versions.sanitizer:prior?.versions.sourceSanitizer??prior?.versions.sanitizer??batch.versions.sanitizer,merchantSanitizer:row.safeSource?.merchant?batch.versions.sanitizer:prior?.versions.merchantSanitizer??prior?.versions.sanitizer??batch.versions.sanitizer}};
  if(!prior){
   if(graph.operations.length>=10000)throw new HttpError(409,'FINANCE_SIZE_LIMIT');
   const semantics=initialSemantics(fact.sourceKind!,fact.merchantText);if(fact.sourceKind==='other')semantics.kind=facet('other','bank',false,0);
   const op=applyRules({id:transactionId,source:fact,accountAssignmentId:accountId,corrections:{},semantics,comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:row.amountMinor==='0'?['zero_amount']:[]},canonicalAccount(graph,accountId),loaded.rules);
   graph.operations.push(op);
   await db.query('INSERT INTO finance.transaction(user_id,id,source_observation_id,semantics,analytics_override,review_reasons) VALUES($1,$2,$3,$4,$5,$6)',[userId,transactionId,observationId,JSON.stringify(op.semantics),op.analyticsOverride,JSON.stringify(op.reviewReasons)]);
  }
  await db.query('INSERT INTO finance.source_observation(user_id,id,transaction_id,account_id,operation_date,posted_date,amount_minor,currency,source_kind,merchant_text,description,bank_category,bank_ref_hmac,versions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[userId,observationId,transactionId,accountId,JSON.stringify(row.operationDate),row.postedDate===null?null:JSON.stringify(row.postedDate),row.amountMinor,row.currency,fact.sourceKind,fact.merchantText,fact.description,fact.bankCategory,row.bankRefHmac,JSON.stringify(fact.versions)]);
  await db.query('INSERT INTO finance.observation_account(user_id,observation_id,account_id) VALUES($1,$2,$3)',[userId,observationId,accountId]);
  // Empty fields in this profile are absent evidence, never instructions to erase classification/text.
  if(prior&&!unchanged){
   const current=graph.operations.find(o=>o.id===transactionId)!,op=structuredClone(current);op.source=fact;
   if(row.safeSource){
    const fresh=initialSemantics(fact.sourceKind!,fact.merchantText);
    if(op.semantics.kind.source==='bank'&&!op.semantics.kind.userVerified){
     const changed=op.semantics.kind.value!==fresh.kind.value;op.semantics.kind=fresh.kind;
     if(changed&&op.semantics.role.source==='deterministic_system_rule'&&!op.semantics.role.userVerified)op.semantics.role=fresh.role;
    }
    if(op.semantics.merchant.source==='bank'&&!op.semantics.merchant.userVerified&&(fact.merchantText||prior.source_kind!==fact.sourceKind))op.semantics.merchant=fresh.merchant;
   }
   const classified=applyRules(op,canonicalAccount(graph,op.accountAssignmentId??accountId),loaded.rules);
   graph.operations[graph.operations.indexOf(current)]=classified;
   await db.query('UPDATE finance.transaction SET source_observation_id=$3,semantics=$4,analytics_override=$5,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,transactionId,observationId,JSON.stringify(classified.semantics),classified.analyticsOverride]);
  }
  await db.query("UPDATE finance.ingestion_row SET status='imported',payload=NULL,outcome=$3,observation_id=$4,alias_kind=$5,alias_hmac=$6,direction=$7 WHERE user_id=$1 AND id=$2",[userId,entry.id,prior?(unchanged?'existing':'updated'):'created',observationId,row.account.kind,row.account.hmac,row.direction]);
  for(const candidateId of match.possibleIds){
   if(candidateId===transactionId)continue;const pair=[transactionId,candidateId].sort();
   await db.query('INSERT INTO finance.duplicate_candidate(user_id,id,left_id,right_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,left_id,right_id) DO NOTHING',[userId,randomUUID(),pair[0],pair[1]]);
   await db.query(`UPDATE finance.transaction SET review_reasons=CASE WHEN review_reasons @> '["possible_duplicate"]'::jsonb THEN review_reasons ELSE review_reasons || '["possible_duplicate"]'::jsonb END,revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[])`,[userId,pair]);
  }
 }
 await prepareFinance(db,userId);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);
 const remaining=(await db.query("SELECT 1 FROM finance.ingestion_row r JOIN finance.ingestion_file f ON (f.user_id,f.id)=(r.user_id,r.file_id) WHERE f.user_id=$1 AND f.batch_id=$2 AND r.status='pending' LIMIT 1",[userId,batchId])).rowCount;
 if(!remaining){
  const issues=(await db.query("SELECT 1 FROM finance.ingestion_file f LEFT JOIN finance.ingestion_row r ON (r.user_id,r.file_id)=(f.user_id,f.id) WHERE f.user_id=$1 AND f.batch_id=$2 AND (f.blocked OR r.status='issue') LIMIT 1",[userId,batchId])).rowCount;
  await db.query('UPDATE finance.ingestion_batch SET status=$3,finished_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,batchId,issues?'partial':'completed']);
  await db.query('DELETE FROM finance.ingestion_dispatch WHERE user_id=$1 AND batch_id=$2',[userId,batchId]);
 }else await db.query("UPDATE finance.ingestion_dispatch SET next_attempt_at=clock_timestamp()+interval '10 milliseconds',attempts=0 WHERE user_id=$1 AND batch_id=$2",[userId,batchId]);
}

/** Deletion invalidates every pending checkpoint, so no queued copy can recreate deleted facts. */
export async function invalidatePendingImports(db:PoolClient,userId:string){
 await db.query("UPDATE finance.ingestion_row SET status='issue',issue='IMPORT_INVALIDATED',payload=NULL WHERE user_id=$1 AND status='pending'",[userId]);
 await db.query("UPDATE finance.ingestion_batch SET status='invalidated',finished_at=clock_timestamp() WHERE user_id=$1 AND status IN ('accepted','processing')",[userId]);
 await db.query('DELETE FROM finance.ingestion_dispatch WHERE user_id=$1',[userId]);
}

/** Durable scheduler stores tenant IDs only. Every financial read/write re-enters server authorization. */
export async function runImportStage(pool:Pool){
 const job=(await pool.query('SELECT user_id,batch_id FROM finance.ingestion_dispatch WHERE next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,user_id LIMIT 1')).rows[0];
 if(!job)return false;
 const db=await pool.connect();
 try{await db.query('BEGIN');await processImport(db,job.user_id,job.batch_id);await db.query('COMMIT');}
 catch{
  await db.query('ROLLBACK');await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[job.user_id]);
  // Static retry metadata only; no exception, SQL, financial payload or identifiers in logs.
  await db.query("UPDATE finance.ingestion_dispatch SET attempts=LEAST(attempts+1,1000),next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND batch_id=$2",[job.user_id,job.batch_id]);await db.query('COMMIT');
 }finally{db.release();}
 return true;
}
