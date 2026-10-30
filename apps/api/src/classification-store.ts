import {tokenCost,rubAmount} from '../../../packages/analyzer/src/cost.ts';
import {classificationWork,ensureClassificationPass,finishClassificationPass,knownMerchantChanges,latestPass} from './classification-pass.ts';
import {activityEngineVersion} from '../../../packages/finance-core/src/activity-recognition.ts';
import {merchantCatalogVersion} from '../../../packages/finance-core/src/merchant-recognition.ts';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
import {prepareFinance,loadFinance} from './finance.ts';
import {isAssistantProvider} from './analyzer-assistant-provider.ts';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
import {reserveCost,settleCost} from './analyzer-cost.ts';
import {HttpError} from './types.ts';
import {classificationPlan,classificationVersion,classificationBatchSize,classificationPrompt,classificationRequestSchema,parseClassification,applyClassification,digest} from './classification-plan.ts';
import type {Decision,ClassificationPlan} from './classification-plan.ts';

export async function enqueueClassification(db:PoolClient,userId:string){
 const workspace=await prepareFinance(db,userId);
 await db.query(`INSERT INTO finance.classification_dispatch(user_id,generation) VALUES($1,$2)
 ON CONFLICT(user_id) DO UPDATE SET generation=EXCLUDED.generation,state='queued',updated_at=clock_timestamp()`,[userId,workspace.generation]);
}
export async function classificationStatus(db:PoolClient,userId:string,input:unknown,provider?:AssistantProvider){
 const r=object(input,['start']);if(r.start!==undefined&&r.start!==true)throw new TypeError('INVALID_INPUT');
 const workspace=await prepareFinance(db,userId);
 const email=(await db.query('SELECT email FROM identity.auth_user WHERE id=$1',[userId])).rows[0]?.email;
 const enabled=!!provider&&isAssistantProvider(provider)&&provider.allowed(email??'');
 if(!enabled){if(r.start)throw new HttpError(503,'CLASSIFICATION_UNAVAILABLE');return {enabled:false,state:'idle',calls:0,applied:0,uncertain:0,canStart:false,sourceKey:'',passId:null,last:null};}
 const loaded=await loadFinance(db,userId);
 const dispatch=(await db.query('SELECT state FROM finance.classification_dispatch WHERE user_id=$1',[userId])).rows[0];
 const stats=(await db.query(`SELECT count(*) FILTER(WHERE engine LIKE 'cashneuro-category-classification/%')::int AS calls,COALESCE(sum(applied),0)::int AS applied,
 count(*) FILTER(WHERE state IN ('sent','unknown'))::int AS uncertain FROM finance.classification_run WHERE user_id=$1`,[userId])).rows[0];
 const work=await classificationWork(db,userId,loaded.graph,loaded.rules,workspace.generation);
 const binding=provider?.binding as {expiresAt?:string;tariffCheckedAt?:string;maximumCalls?:number}|undefined;
 const budget=enabled?(await db.query('SELECT dispatch_count,spent_atoms,reserved_atoms,limit_atoms,blocked FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2',[provider!.policy.projectId,provider!.policy.projectPeriodStart])).rows[0]:null;
 const now=Date.now(),bound=enabled?provider!.forRequest('classification').bound:null,required=bound?tokenCost(provider!.policy.price,bound.inputTokens,bound.outputTokens):0n;
 const dispatchAllowed=enabled&&(!binding?.expiresAt||new Date(binding.expiresAt).getTime()>now)&&(!binding?.tariffCheckedAt||now-new Date(binding.tariffCheckedAt).getTime()<86400000)&&new Date(provider!.policy.projectPeriodEnd).getTime()>now&&new Date(provider!.policy.projectPeriodStart).getTime()<=now&&(!budget?required<=rubAmount(provider!.policy.projectLimitRub):!budget.blocked&&(binding?.maximumCalls===undefined||Number(budget.dispatch_count)<binding.maximumCalls)&&BigInt(budget.spent_atoms)+BigInt(budget.reserved_atoms)+required<=BigInt(budget.limit_atoms));
 const unresolvedReceipt=!!(await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1",[userId])).rowCount;
 const available=enabled&&(!work.requiresModel||dispatchAllowed)&&!unresolvedReceipt;
 const importing=!!(await db.query("SELECT 1 FROM finance.ingestion_batch WHERE user_id=$1 AND status IN ('accepted','processing') LIMIT 1",[userId])).rowCount;
 const canStart=available&&!importing&&dispatch?.state!=='queued'&&Number(stats.uncertain)===0&&work.needed;
 if(r.start){if(!available)throw new HttpError(503,'CLASSIFICATION_UNAVAILABLE');if(canStart)await enqueueClassification(db,userId);else if(dispatch?.state!=='queued')throw new HttpError(409,'CLASSIFICATION_NOT_NEEDED');}
 const last=work.last&&['completed','failed'].includes(work.last.state)&&work.last.catalog_hash===work.inputHash&&work.last.decisions.summary?{id:work.last.id,...work.last.decisions.summary,...(work.last.decisions.summary.unresolved<=1000?{unresolvedIds:work.last.decisions.baseline.map(b=>b.id).filter(id=>loaded.graph.operations.some(op=>op.id===id&&op.semantics.category.value===null))}:{})}:null;
 return {enabled,state:r.start?'queued':dispatch?.state??'idle',...stats,canStart:r.start?false:canStart,sourceKey:work.inputHash,passId:work.last?.id??null,last};
}
async function transaction<T>(pool:Pool,userId:string,action:(db:PoolClient)=>Promise<T>){
 const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[userId]);const result=await action(db);await db.query('COMMIT');return result;}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function scope(db:PoolClient,userId:string,provider:AssistantProvider){
 const workspace=await prepareFinance(db,userId);
 const user=(await db.query('SELECT email FROM identity.auth_user WHERE id=$1',[userId])).rows[0];
 if(!user||!provider.allowed(user.email))throw new HttpError(403,'ASSISTANT_PILOT_ACCESS_DENIED');
 return workspace;
}
async function applyKnownMerchants(db:PoolClient,userId:string,graph:Awaited<ReturnType<typeof loadFinance>>['graph'],rules:Awaited<ReturnType<typeof loadFinance>>['rules'],generation:string){
 const changes=knownMerchantChanges(graph,rules);
 if(!changes.length)return false;
 const batch=changes.slice(0,250);
 const id=randomUUID();await db.query("INSERT INTO finance.classification_run(user_id,id,generation,engine,catalog_hash,state,applied) VALUES($1,$2,$3,$4,$5,'completed',$6)",[userId,id,generation,batch.some(({op})=>op.source.versions.sourceSanitizer==='bank-source/5')?activityEngineVersion:merchantCatalogVersion,digest({categories:graph.categories,bindings:graph.categoryBindings}),batch.length]);
 for(const {op,next} of batch){
  await db.query('INSERT INTO finance.classification_assignment(user_id,id,transaction_id,run_id,before_facets,after_facets) VALUES($1,$2,$3,$4,$5,$6)',[userId,randomUUID(),op.id,id,JSON.stringify(op.semantics),JSON.stringify(next.semantics)]);
  await db.query('UPDATE finance.transaction SET semantics=$3,review_reasons=$4,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,op.id,JSON.stringify(next.semantics),JSON.stringify(next.reviewReasons)]);
 }
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);
 return changes.length>batch.length;
}
async function applyCached(db:PoolClient,userId:string,plan:ClassificationPlan){
 const cached=(await db.query<{signature:string;decision:Decision;run_id:string}>(`SELECT signature,decision,run_id FROM finance.classification_cache WHERE user_id=$1 AND decision IS NOT NULL`,[userId])).rows;
 const bySignature=new Map(cached.map(c=>[c.signature,c])),operations=new Map(plan.operations.map(o=>[o.id,o]));let applied=0;
 for(const group of plan.groups){const cached=bySignature.get(group.signature);if(!cached)continue;
  const d=object(cached.decision,['categoryId','subcategoryId','confidence']);
  const category=plan.categories.find(c=>c.id===d.categoryId),sub=plan.categories.find(c=>c.id===d.subcategoryId);
  if(!Number.isInteger(d.confidence)||Number(d.confidence)<0||Number(d.confidence)>100||
    d.categoryId!==null&&(!category||category.parentId!==null)||
    d.subcategoryId!==null&&(!sub||!category||sub.parentId!==category.id)||
    [category,sub].some(c=>c&&c.role!=='both'&&c.role!==group.signal.role))throw Error('CLASSIFICATION_CACHE_CHANGED');
  for(const id of group.operationIds){
   const op=operations.get(id);if(!op)continue;
   const next=applyClassification(op,cached.decision);
   // Reapplying an identical low-confidence decision is not another edit.
   if(isDeepStrictEqual(op.semantics,next.semantics)&&isDeepStrictEqual(op.reviewReasons,next.reviewReasons))continue;
   await db.query('INSERT INTO finance.classification_assignment(user_id,id,transaction_id,run_id,before_facets,after_facets) VALUES($1,$2,$3,$4,$5,$6)',[userId,randomUUID(),id,cached.run_id,JSON.stringify({category:op.semantics.category,subcategory:op.semantics.subcategory}),JSON.stringify({category:next.semantics.category,subcategory:next.semantics.subcategory})]);
   await db.query('UPDATE finance.transaction SET semantics=$3,review_reasons=$4,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,id,JSON.stringify(next.semantics),JSON.stringify(next.reviewReasons)]);
   await db.query('UPDATE finance.classification_run SET applied=applied+1 WHERE user_id=$1 AND id=$2',[userId,cached.run_id]);applied++;
  }
 }
 if(applied){await prepareFinance(db,userId);await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);}
 return applied;
}

/** One bounded model call, no transaction across HTTP and no automatic POST retry.
 * A session lock excludes another worker/API process for this tenant. */
export async function runClassificationStage(pool:Pool,provider:AssistantProvider){
 if(!isAssistantProvider(provider)||provider.pool!==pool)throw Error('CLASSIFICATION_PROVIDER_DENIED');
 const pending=(await pool.query("SELECT user_id FROM finance.classification_dispatch WHERE state='queued' ORDER BY updated_at,user_id LIMIT 1")).rows[0];
 if(!pending)return false;const userId=String(pending.user_id),lock=await pool.connect(),lockName='classification:'+userId;
 const locked=(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])).rows[0].locked;
 if(!locked){lock.release();return false;}
 try{
  const planned=await transaction(pool,userId,async db=>{
   const workspace=await scope(db,userId,provider),loaded=await loadFinance(db,userId);
   if((await db.query("SELECT 1 FROM finance.classification_run WHERE user_id=$1 AND state IN ('sent','unknown') LIMIT 1",[userId])).rowCount){await db.query("UPDATE finance.classification_dispatch SET state='blocked' WHERE user_id=$1",[userId]);return null;}
   const pass=await ensureClassificationPass(db,userId,loaded.graph,loaded.rules,workspace.generation);if(!pass){const last=await latestPass(db,userId,workspace.generation);await db.query('UPDATE finance.classification_dispatch SET state=$2 WHERE user_id=$1',[userId,last?.state==='failed'?'blocked':'completed']);return null;}
   if(await applyKnownMerchants(db,userId,loaded.graph,loaded.rules,workspace.generation))return null;
   const known=await loadFinance(db,userId);let plan=classificationPlan(known.graph,known.rules,pass.decisions.reconsider);await applyCached(db,userId,plan);
   const fresh=await loadFinance(db,userId);plan=classificationPlan(fresh.graph,fresh.rules,pass.decisions.reconsider);
   const attempts=(await db.query('SELECT signature,decision FROM finance.classification_cache WHERE user_id=$1',[userId])).rows;
   const seen=new Set(attempts.map(r=>r.signature));const groups=plan.groups.filter(g=>!seen.has(g.signature)).slice(0,classificationBatchSize);
   if(!groups.length){await finishClassificationPass(db,userId,pass,fresh.graph);const blocked=plan.groups.some(g=>attempts.some(a=>a.signature===g.signature&&a.decision===null));await db.query('UPDATE finance.classification_dispatch SET state=$2,updated_at=clock_timestamp() WHERE user_id=$1',[userId,blocked?'blocked':'completed']);return null;}
   return {plan,groups,generation:workspace.generation,keyVersion:workspace.key_version,revision:fresh.state.revision,pass};
  });
  if(!planned)return true;
  const id=randomUUID(),model=provider.forRequest('classification'),input={catalog:planned.plan.catalog,operations:planned.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))};
  let sent=false,knownUsage:Usage|undefined;
  const settle=async(usage?:Usage)=>transaction(pool,userId,async db=>{
   const violation=await settleCost(db,userId,id,'classification',usage);
   await db.query("UPDATE commerce.analyzer_request SET state=$3,usage_state=$4,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND step='classification'",[userId,id,usage?'received':'unknown',usage?'reported':'unknown']);
   return violation;
  });
  try{
   const completed=await model.complete({phase:'understand',protocol:classificationVersion,prompt:classificationPrompt,input,schema:classificationRequestSchema(planned.plan,planned.groups)},async()=>{
    if(sent)throw Error('CLASSIFICATION_DUPLICATE_DISPATCH');
    await transaction(pool,userId,async db=>{
     const workspace=await scope(db,userId,provider);
     if(workspace.generation!==planned.generation||workspace.key_version!==planned.keyVersion||workspace.revision!==planned.revision)throw Error('CLASSIFICATION_CONTEXT_CHANGED');
     await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+userId]);
     if((await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1",[userId])).rowCount)throw Error('AI_COST_RECONCILIATION_REQUIRED');
     await db.query(`INSERT INTO finance.classification_run(user_id,id,generation,engine,catalog_hash,state) VALUES($1,$2,$3,$4,$5,'sent')`,[userId,id,planned.generation,classificationVersion,planned.plan.catalogHash]);
     for(const group of planned.groups)await db.query('INSERT INTO finance.classification_cache(user_id,signature,run_id) VALUES($1,$2,$3)',[userId,group.signature,id]);
     await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state)
     VALUES($1,$2,'classification',$3,'sent','cashneuro-categories/1',$4,$5,$5,'not_sent')`,[userId,id,digest(input),model.bound.modelVersion,provider.policy.projectPeriodStart]);
     await reserveCost(db,{userId,requestId:id,step:'classification',anchorAt:provider.policy.projectPeriodStart,periodStart:provider.policy.projectPeriodStart},provider.policy,model.bound);
     await provider.authorizeDispatch(db);
    });sent=true;
   });
   if(!sent)throw Error('CLASSIFICATION_DISPATCH_NOT_RECORDED');knownUsage=completed.usage;
   if(await settle(knownUsage))throw Error('CLASSIFICATION_PROVIDER_CHANGED');
   const decisions=parseClassification(completed.value,planned.plan,planned.groups);
   // Persist only validated finite decisions; never persist arbitrary model text.
   await transaction(pool,userId,async db=>{
    for(const [i,group]of planned.groups.entries())await db.query('UPDATE finance.classification_cache SET decision=$3 WHERE user_id=$1 AND signature=$2',[userId,group.signature,JSON.stringify(decisions[i])]);
    await db.query("UPDATE finance.classification_run SET state='received',decisions=$3 WHERE user_id=$1 AND id=$2",[userId,id,JSON.stringify(decisions)]);
   });
   await transaction(pool,userId,async db=>{
    const workspace=await scope(db,userId,provider),loaded=await loadFinance(db,userId),plan=classificationPlan(loaded.graph,loaded.rules,planned.pass.decisions.reconsider);
    if(workspace.generation!==planned.generation||workspace.key_version!==planned.keyVersion||plan.catalogHash!==planned.plan.catalogHash){await db.query("UPDATE finance.classification_run SET state='discarded' WHERE user_id=$1 AND id=$2",[userId,id]);return;}
    await applyCached(db,userId,plan);
    await db.query("UPDATE finance.classification_run SET state='completed' WHERE user_id=$1 AND id=$2",[userId,id]);
   });
  }catch(error){
   const usage=knownUsage??(error&&typeof error==='object'&&'usage'in error?(error as {usage?:Usage}).usage:undefined);
   if(sent){await settle(usage);await transaction(pool,userId,async db=>{await db.query('UPDATE finance.classification_run SET state=$3 WHERE user_id=$1 AND id=$2',[userId,id,usage?'failed':'unknown']);});}
   await transaction(pool,userId,async db=>{await scope(db,userId,provider);const loaded=await loadFinance(db,userId);await finishClassificationPass(db,userId,planned.pass,loaded.graph,'failed');}).catch(()=>{});
   await transaction(pool,userId,async db=>{await db.query("UPDATE finance.classification_dispatch SET state='blocked',updated_at=clock_timestamp() WHERE user_id=$1",[userId]);});
  }
  return true;
 }catch{
  await transaction(pool,userId,async db=>{await db.query("UPDATE finance.classification_dispatch SET state='blocked',updated_at=clock_timestamp() WHERE user_id=$1",[userId]);});return true;
 }finally{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockName]);lock.release();}
}
