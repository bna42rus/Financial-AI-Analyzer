/** Explicit operator-only synthetic acceptance. No customer operations are read
 * or written. Both calls use the existing pilot admission and durable ledger. */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {privateJson} from './kms.ts';
import {stagingDatabase} from './runtime-key.ts';
import {assistantRuntimeManifest} from './analyzer-assistant-manifest.ts';
import {createStagingAssistantProvider} from './analyzer-assistant-provider.ts';
import {prepareFinance} from './finance.ts';
import {reserveCost,settleCost} from './analyzer-cost.ts';
import {classificationVersion,classificationPrompt,classificationRequestSchema,parseClassification,digest} from './classification-plan.ts';
import {classificationSmokeCase,classificationSmokeNames} from './classification-smoke-cases.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
import {tokenCost} from '../../../packages/analyzer/src/cost.ts';
import {validateClassificationEvidence,confirmClassificationPaidReceipt,classificationRuntimeAdmission} from './classification-admission.ts';
import {classificationFailure,syntheticClassificationArchive,syntheticClassificationFetch,classificationPilotTotals} from './classification-smoke-support.ts';
import type {AssistantStagingSettings} from './analyzer-assistant-settings.ts';
import {verifyClassificationTariff} from './classification-tariff.ts';
let phase='arguments';
let archive:Awaited<ReturnType<typeof syntheticClassificationArchive>>|undefined;
async function main(){
 const argv=process.argv.slice(2),resume=argv.length===4&&['--resume-archive','--replay-archive'].includes(argv[2]!)?argv[3]:undefined;
 const replayAll=argv[2]==='--replay-archive';
 if(resume)argv.splice(2);
 const args=argv.join(' '),continuation=args==='--live --continue-expired-pilot';
 if(args==='--prepare'){console.log(JSON.stringify({cases:2,...await assistantRuntimeManifest()}));return;}
 if(args!=='--live'&&!continuation||process.getuid?.()!==0)throw Error('EXPLICIT_OPERATOR_REQUIRED');
 phase='environment';console.log(JSON.stringify({phase,status:'START',paidCalls:0}));
 const env=await readFile('/etc/cashneuro/staging/finance-api.env','utf8');
 const raw=env.split('\n').find(line=>line.startsWith('DATABASE_URL='))?.slice(13).trim().replace(/^["']|["']$/g,'');
 stagingDatabase('staging',raw);const pool=new Pool({connectionString:raw,max:3,connectionTimeoutMillis:5000,query_timeout:10000});
 let lock:import('pg').PoolClient|undefined,lockName:string|undefined;
 try{
  phase='configuration';
  const original=await privateJson('/etc/cashneuro/ai/assistant-staging.json') as AssistantStagingSettings;
  const originalHash=digest(original),sourceSha256=(await assistantRuntimeManifest()).sourceSha256;
  const totals=(db:import('pg').Pool|import('pg').PoolClient)=>classificationPilotTotals(db,original.cost.projectId,original.cost.projectPeriodStart);
  let settings=original;
  if(continuation){
   phase='continuation';
   const identity=(await pool.query('SELECT current_user AS role,current_database() AS name')).rows[0];
   if(identity?.role!=='finance_api'||identity.name!=='finance_staging')throw Error('ASSISTANT_DATABASE_DENIED');
   lock=await pool.connect();lockName='classification-continuation:'+original.cost.projectId;
   if(!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])).rows[0].locked)throw Error('CLASSIFICATION_CHECK_IN_PROGRESS');
   phase='tariff_preflight';console.log(JSON.stringify({phase,status:'START',paidCalls:0}));
   const tariff=await verifyClassificationTariff(fetch);
   phase='admission';
   const priorTotals=await totals(lock);
   settings=classificationRuntimeAdmission(original,priorTotals,sourceSha256,tariff);
   console.log(JSON.stringify({phase,status:'OK',tariffCheckedAt:tariff.checkedAt,tariffDocumentSha256:tariff.documentSha256,maximumCallsRemaining:Math.min(settings.maximumCalls,original.admission.stageMaximumCalls-original.admission.calls-priorTotals.calls),activeConfigurationChanged:false}));
  }
  archive=await syntheticClassificationArchive('/var/lib/cashneuro',settings.apiKey,resume);
  console.log(JSON.stringify({phase:'archive',directory:archive.directory}));
  let expected:{name:string;input:unknown}|undefined;
  const fetcher=syntheticClassificationFetch(fetch,async(name,value)=>{
   await archive!.save(name,value);
   console.log(JSON.stringify({phase:'synthetic_answer',case:expected?.name,answer:value}));
  },()=>expected);
  phase='provider_preflight';
  const provider=await createStagingAssistantProvider(pool,settings,fetcher,sourceSha256);
  phase='test_account';
  const user=(await pool.query('SELECT id FROM identity.auth_user WHERE email=ANY($1::text[]) AND email_verified ORDER BY id LIMIT 1',[(settings as {allowedEmails:string[]}).allowedEmails])).rows[0];if(!user)throw Error('TEST_ACCOUNT_REQUIRED');
  async function within<T>(action:(db:import('pg').PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[user.id]);const result=await action(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
  if(resume){
   phase='replay';
   await within(db=>validateClassificationEvidence(resume,(fingerprint,usage,from,through)=>confirmClassificationPaidReceipt(db,user.id,settings.cost.projectId,fingerprint,usage,from,through),replayAll?classificationSmokeNames:['known-merchants']));
   console.log(JSON.stringify({case:replayAll?'both-cases':'known-merchants',status:'PASS',replayed:true,newCalls:0,archiveChanged:false,note:replayAll?'Application evidence guard rejects unsupported service assignment. Original model error is preserved.':'Categories correct; medium confidence stays in Review.'}));
  }
  for(const name of classificationSmokeNames){
   if(resume&&(replayAll||name==='known-merchants'))continue;
   phase=name+':prepare';console.log(JSON.stringify({case:name,status:'START'}));
   const sample=classificationSmokeCase(name),{plan,input}=sample,id=randomUUID(),model=provider.forRequest('classification');let sent=false,usage:Usage|undefined;
   expected={name,input};await archive.save(name+'-input.json',input);
   const settle=async(value?:Usage)=>within(db=>settleCost(db,user.id,id,'classification',value));
   try{
    phase=name+':transport';
    const result=await model.complete({phase:'understand',protocol:classificationVersion,prompt:classificationPrompt,input,schema:classificationRequestSchema(plan,plan.groups)},async()=>{
     phase=name+':reservation';
     await within(async db=>{await db.query("SET LOCAL lock_timeout='3s'");await prepareFinance(db,user.id);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+user.id]);
      if(continuation){
       if(digest(await privateJson('/etc/cashneuro/ai/assistant-staging.json'))!==originalHash)throw Error('CLASSIFICATION_ACTIVE_CONFIGURATION_CHANGED');
       const used=await totals(db),quote=tokenCost(provider.policy.price,model.bound.inputTokens,model.bound.outputTokens);
       if(used.blocked||BigInt(used.reservedAtoms)!==0n)throw Error('CLASSIFICATION_RECONCILIATION_REQUIRED');
       if(original.admission.calls+used.calls+1>original.admission.stageMaximumCalls||original.admission.calls+used.calls+1>70||
        BigInt(original.admission.spentAtoms)+BigInt(used.spentAtoms)+quote>BigInt(original.admission.stageCapAtoms))throw Error('CLASSIFICATION_ORIGINAL_LIMIT_EXHAUSTED');
      }
      if((await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1",[user.id])).rowCount)throw Error('RECONCILIATION_REQUIRED');
      await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state) VALUES($1,$2,'classification',$3,'sent','cashneuro-category-smoke/1',$4,$5,$5,'not_sent')`,[user.id,id,digest(input),model.bound.modelVersion,provider.policy.projectPeriodStart]);
      await reserveCost(db,{userId:user.id,requestId:id,step:'classification',anchorAt:provider.policy.projectPeriodStart,periodStart:provider.policy.projectPeriodStart},provider.policy,model.bound);await provider.authorizeDispatch(db);
     });sent=true;phase=name+':response';console.log(JSON.stringify({case:name,status:'SENT'}));
    });usage=result.usage;phase=name+':settlement';if(!sent||await settle(usage))throw Error('PROVIDER_CHANGED');
    await archive.save(name+'-usage.json',usage);phase=name+':schema';
    const decisions=parseClassification(result.value,plan,plan.groups);
    phase=name+':receipt';await within(db=>db.query("UPDATE commerce.analyzer_request SET state='completed',usage_state='reported' WHERE user_id=$1 AND request_id=$2 AND step='classification'",[user.id,id]));
    const checks=sample.checks(decisions),passed=sample.passed(decisions);
    phase=name+':meaning';console.log(JSON.stringify({case:name,status:passed?'PASS':'FAIL',decisions:checks,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,customerQuotaUsed:0}));
    if(!passed)throw Error('CLASSIFICATION_SMOKE_FAILED');
   }catch(error){
    if(sent){const known=usage??(error&&typeof error==='object'&&'usage'in error?(error as {usage?:Usage}).usage:undefined);await settle(known);await within(db=>db.query("UPDATE commerce.analyzer_request SET state=$3,usage_state=$4 WHERE user_id=$1 AND request_id=$2 AND step='classification' AND state='sent'",[user.id,id,known?'failed':'unknown',known?'reported':'unknown']));}
    const failure={phase,...classificationFailure(error)};console.log(JSON.stringify({status:'FAIL',...failure}));await archive.save(name+'-failure.json',failure);throw error;
   }
  }
 }finally{if(lock){try{if(lockName)await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockName]);}finally{lock.release();}}await pool.end();}
}
main().catch(error=>{console.log(JSON.stringify({status:'STOP',phase,...classificationFailure(error),archive:archive?.directory,automaticRetry:false}));process.exitCode=1;});
