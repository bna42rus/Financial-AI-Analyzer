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
import {classificationPlan,classificationPrompt,classificationSchema,parseClassification,digest} from './classification-plan.ts';
import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import type {Usage} from '../../../packages/analyzer/src/cost.ts';
async function main(){
 if(process.argv.slice(2).join(' ')!=='--live'||process.getuid?.()!==0)throw Error('EXPLICIT_OPERATOR_REQUIRED');
 const env=await readFile('/etc/cashneuro/staging/finance-api.env','utf8');
 const raw=env.split('\n').find(line=>line.startsWith('DATABASE_URL='))?.slice(13).trim().replace(/^["']|["']$/g,'');
 stagingDatabase('staging',raw);const pool=new Pool({connectionString:raw,max:3});
 try{
  const settings=await privateJson('/etc/cashneuro/ai/assistant-staging.json');
  const provider=await createStagingAssistantProvider(pool,settings,fetch,(await assistantRuntimeManifest()).sourceSha256);
  const user=(await pool.query('SELECT id FROM identity.auth_user WHERE email=ANY($1::text[]) AND email_verified ORDER BY id LIMIT 1',[(settings as {allowedEmails:string[]}).allowedEmails])).rows[0];if(!user)throw Error('TEST_ACCOUNT_REQUIRED');
  async function within<T>(action:(db:import('pg').PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[user.id]);const result=await action(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
  const categories=[{id:'food',name:'Продукты'},{id:'electronics',name:'Электроника'},{id:'taxi',name:'Такси'},{id:'public',name:'Общественный транспорт'}].map(c=>({...c,role:'expense' as const,parentId:null,hidden:false}));
  const graph:Graph={accounts:[{id:'synthetic',bankId:'tbank',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories,components:[],links:[],loanMode:'cashflow',operations:['Пятёрочка','DNS','Яндекс Go','Ozon'].map((merchant,i)=>({id:'synthetic-'+i,source:{accountId:'synthetic',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',merchantText:merchant,description:'',bankCategory:'',bankRefHmac:null,versions:{}},semantics:initialSemantics('purchase',merchant),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]}))};
  for(const name of ['known-merchants','taxi-without-category']){
   const sample=structuredClone(graph);if(name==='taxi-without-category'){sample.categories=sample.categories.filter(c=>c.id!=='taxi');sample.operations=sample.operations.filter(o=>o.source.merchantText==='Яндекс Go');}
   const plan=classificationPlan(sample),id=randomUUID(),input={catalog:plan.catalog,operations:plan.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))},model=provider.forRequest();let sent=false,usage:Usage|undefined;
   const settle=async(value?:Usage)=>within(db=>settleCost(db,user.id,id,'classification',value));
   try{
    const result=await model.complete({phase:'understand',prompt:classificationPrompt,input,schema:classificationSchema},async()=>{
     await within(async db=>{await prepareFinance(db,user.id);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+user.id]);
      if((await db.query("SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND (state='sent' OR usage_state='unknown') LIMIT 1",[user.id])).rowCount)throw Error('RECONCILIATION_REQUIRED');
      await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state) VALUES($1,$2,'classification',$3,'sent','cashneuro-category-smoke/1',$4,$5,$5,'not_sent')`,[user.id,id,digest(input),model.bound.modelVersion,provider.policy.projectPeriodStart]);
      await reserveCost(db,{userId:user.id,requestId:id,step:'classification',anchorAt:provider.policy.projectPeriodStart,periodStart:provider.policy.projectPeriodStart},provider.policy,model.bound);await provider.authorizeDispatch(db);
     });sent=true;
    });usage=result.usage;if(!sent||await settle(usage))throw Error('PROVIDER_CHANGED');
    const decisions=parseClassification(result.value,plan,plan.groups);
    await within(db=>db.query("UPDATE commerce.analyzer_request SET state='completed',usage_state='reported' WHERE user_id=$1 AND request_id=$2 AND step='classification'",[user.id,id]));
    const checks=plan.groups.map((g,i)=>({merchant:g.signal.merchant,category:decisions[i]!.categoryId,confidence:decisions[i]!.confidence}));
    const passed=checks.every(c=>{const expected=name==='taxi-without-category'?null:({'Пятёрочка':'food',DNS:'electronics','Яндекс Go':'taxi',Ozon:null} as Record<string,string|null>)[c.merchant!];return c.category===expected&&(expected===null||c.confidence>=90);});
    console.log(JSON.stringify({case:name,status:passed?'PASS':'FAIL',decisions:checks,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,customerQuotaUsed:0}));
    if(!passed)throw Error('CLASSIFICATION_SMOKE_FAILED');
   }catch(error){
    if(sent){const known=usage??(error&&typeof error==='object'&&'usage'in error?(error as {usage?:Usage}).usage:undefined);await settle(known);await within(db=>db.query("UPDATE commerce.analyzer_request SET state=$3,usage_state=$4 WHERE user_id=$1 AND request_id=$2 AND step='classification' AND state='sent'",[user.id,id,known?'failed':'unknown',known?'reported':'unknown']));}throw error;
   }
  }
 }finally{await pool.end();}
}
main().catch(()=>{console.error('CLASSIFICATION_SMOKE_STOPPED: результаты и расходы сохранены; автоматического повторного вызова нет.');process.exitCode=1;});
