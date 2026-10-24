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
import {classificationPlan,classificationVersion,classificationPrompt,classificationRequestSchema,parseClassification,digest} from './classification-plan.ts';
import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
import {tokenCost} from '../../../packages/analyzer/src/cost.ts';
import {continuedClassificationSettings,classificationFailure,syntheticClassificationArchive,syntheticClassificationFetch,classificationPilotTotals} from './classification-smoke-support.ts';
import type {AssistantStagingSettings} from './analyzer-assistant-settings.ts';
import {verifyClassificationTariff} from './classification-tariff.ts';
let phase='arguments';
let archive:Awaited<ReturnType<typeof syntheticClassificationArchive>>|undefined;
async function main(){
 const args=process.argv.slice(2).join(' '),continuation=args==='--live --continue-expired-pilot';
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
  const totals=(db:import('pg').Pool|import('pg').PoolClient)=>classificationPilotTotals(db,original.cost.projectId);
  let settings=original;
  if(continuation){
   phase='continuation';
   const identity=(await pool.query('SELECT current_user AS role,current_database() AS name')).rows[0];
   if(identity?.role!=='finance_api'||identity.name!=='finance_staging')throw Error('ASSISTANT_DATABASE_DENIED');
   lock=await pool.connect();lockName='classification-continuation:'+original.cost.projectId;
   if(!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])).rows[0].locked)throw Error('CLASSIFICATION_CHECK_IN_PROGRESS');
   phase='tariff_preflight';console.log(JSON.stringify({phase,status:'START',paidCalls:0}));
   const tariff=await verifyClassificationTariff(fetch);
   settings=continuedClassificationSettings(original,await totals(lock),sourceSha256,tariff);
   console.log(JSON.stringify({phase,status:'OK',tariffCheckedAt:tariff.checkedAt,tariffDocumentSha256:tariff.documentSha256,maximumCallsRemaining:settings.maximumCalls,activeConfigurationChanged:false}));
  }
  archive=await syntheticClassificationArchive('/var/lib/cashneuro',settings.apiKey);
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
  const categories=[{id:'food',name:'Продукты'},{id:'electronics',name:'Электроника'},{id:'taxi',name:'Такси'},{id:'public',name:'Общественный транспорт'}].map(c=>({...c,role:'expense' as const,parentId:null,hidden:false}));
  const graph:Graph={accounts:[{id:'synthetic',bankId:'tbank',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories,components:[],links:[],loanMode:'cashflow',operations:['Пятёрочка','DNS','Яндекс Go','Ozon'].map((merchant,i)=>({id:'synthetic-'+i,source:{accountId:'synthetic',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',merchantText:merchant,description:'',bankCategory:'',bankRefHmac:null,versions:{}},semantics:initialSemantics('purchase',merchant),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]}))};
  for(const name of ['known-merchants','taxi-without-category']){
   phase=name+':prepare';console.log(JSON.stringify({case:name,status:'START'}));
   const sample=structuredClone(graph);if(name==='taxi-without-category'){sample.categories=sample.categories.filter(c=>c.id!=='taxi');sample.operations=sample.operations.filter(o=>o.source.merchantText==='Яндекс Go');}
   else sample.operations=sample.operations.filter(o=>o.source.merchantText!=='Яндекс Go'); // service is not identified by this broad merchant label
   const plan=classificationPlan(sample),id=randomUUID(),input={catalog:plan.catalog,operations:plan.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))},model=provider.forRequest();let sent=false,usage:Usage|undefined;
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
    const checks=plan.groups.map((g,i)=>({merchant:g.signal.merchant,category:decisions[i]!.categoryId,confidence:decisions[i]!.confidence}));
    const passed=checks.every(c=>{const expected=name==='taxi-without-category'?null:({'Пятёрочка':'food',DNS:'electronics','Яндекс Go':'taxi',Ozon:null} as Record<string,string|null>)[c.merchant!];return c.category===expected&&(expected===null||c.confidence>=90);});
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
